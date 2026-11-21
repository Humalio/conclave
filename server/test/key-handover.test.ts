/**
 * Key handover (docs/onboarding.md#key-handover-a-rotated-key-or-a-recruit-reaches-a-connector-pc): a rotation of a key whose
 * PC runs the connector is an approved request bound to that PC's app key. The connector lists it, picks the new secret up
 * and confirms; only then is the old key revoked. Another PC's app key or a turn token cannot reach it, it expires after
 * 24 hours, and no secret reaches the audit or the operator's answers.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import { HANDOVER_TTL_MS } from '../src/keys/handover.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
/** A whole key or token; the masked public form (ah_ses_<id>_…) is not one. */
const KEY_RE = /ah_(ses|app)_[a-z2-7]+_[A-Za-z0-9]{8}|ah_tok_[A-Za-z0-9]{8}/;
let app: App, base = '', admin = { cookie: '', csrf: '' }, n = 0;
const pc = { id: '', key: '' }, other = { id: '', key: '' };

const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie: admin.cookie, 'x-csrf-token': admin.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
/** A call with a bearer: the PC's app key, another PC's, or a turn token. */
const call = async (method: string, path: string, bearer: string, body?: unknown) => {
  const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const checkIn = (key: string) => call('POST', '/connector/v1/check-in', key, { version: '0.9.6' });
/** An MCP session: login with a session key, or a token already issued (a turn token). */
async function mcp(appKey: string, o: { secret?: string; token?: string }) {
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  let token = o.token ?? '';
  if (o.secret) {
    const r = (await c.callTool({ name: 'session_login', arguments: { session_key: o.secret } })) as any;
    if (r.isError || !r.structuredContent?.session_token) return null;
    token = r.structuredContent.session_token;
  }
  return async (name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name, arguments: { session_token: token, ...args } })) as any;
}
const canLogin = async (secret: string) => !!(await mcp(pc.key, { secret }));
/** An enrolled PC (Add PC): its app key carries the onboarding capability. */
async function enrol(name: string) {
  const add = await api('POST', '/pcs/add', { name });
  expect(add.status, JSON.stringify(add.body)).toBe(200);
  const nonce = `${name}-nonce-0123456789`, h = { 'content-type': 'application/json', 'x-forwarded-for': '10.9.0.3', 'x-forwarded-proto': 'https' };
  const key = ((await fetch(`${base}/onboard/enrol`, { method: 'POST', headers: h, body: JSON.stringify({ code: add.body.code, nonce }) }).then((x) => x.json())) as any).app_key as string;
  await fetch(`${base}/onboard/enrol/confirm`, { method: 'POST', headers: h, body: JSON.stringify({ nonce }) });
  return { id: add.body.pc.id as string, key };
}
/** An agent whose key is bound to the connector PC and has logged in there once. */
async function agentOnPc() {
  const a = app.keys.createAgent(`Agent ${++n}`, null, sys);
  const k = app.keys.createSessionKey({ agentId: a.id, label: `a${n}`, machineId: pc.id }, sys);
  expect(await canLogin(k.secret)).toBe(true);
  return { agent: a, id: k.credential.id, keyId: k.credential.key_id, secret: k.secret };
}
const records = () => JSON.stringify(['audit_events', 'security_alerts', 'agent_notices', 'onboarding_events'].map((t) => { try { return app.db.prepare(`SELECT * FROM ${t}`).all(); } catch { return []; } }));
const actions = (prefix: string) => (app.db.prepare('SELECT action, details FROM audit_events WHERE action LIKE ? ORDER BY rowid').all(`${prefix}%`) as { action: string; details: string }[]);

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahhand-'));
  mkdirSync(join(dir, 'vault', 'Notes'), { recursive: true });
  writeFileSync(join(dir, 'vault', 'Notes', 'a.md'), '# A\n');
  const client = join(dir, 'client');
  mkdirSync(client);
  for (const f of ['agent-hub-headers.mjs', 'setup.mjs']) writeFileSync(join(client, f), 'export const x = 1;\n');
  writeFileSync(join(client, 'onboarding-prompt.md'), 'Hub {{HUB_URL}} code {{ENROL_CODE}} pc {{PC_NAME}}\n');
  app = await buildApp(testConfig(dir, { publicUrl: 'https://hub.test', clientDir: client, maintenanceSeconds: undefined }));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  admin = await adminLogin(base);
  Object.assign(pc, await enrol('connector-pc'));
  Object.assign(other, await enrol('other-pc'));
  expect((await checkIn(pc.key)).status).toBe(200);
  expect((await checkIn(other.key)).status).toBe(200);
});
afterAll(async () => { await app.close(); });
// Pickups are limited per app key and hour; each test starts with a fresh count.
beforeEach(() => { app.db.prepare("DELETE FROM usage_counters WHERE metric='onboard_pickup'").run(); });

describe('a rotation reaches the connector PC by key handover', () => {
  it('rotate files a handover the PC lists without a secret; the old key works until confirm, and a re-pickup replaces the staged secret', async () => {
    const A = await agentOnPc();
    // The key's page: the PC a rotation would go to (the sheet's "Rotate and send to <PC>"), nothing open yet.
    expect((await api('GET', `/keys/${A.id}/handover`)).body).toEqual({ handover: null, target: { id: pc.id, name: 'connector-pc' }, confirmed: null, not_on_pc: null, leak_unfinished: false });
    const rot = await api('POST', `/keys/${A.id}/rotate`, { reason: 'routine' });
    expect(rot.status, JSON.stringify(rot.body)).toBe(200);
    expect(rot.body.handover).toMatchObject({ pc: { id: pc.id, name: 'connector-pc' }, picked_up: false });
    expect((await api('GET', `/keys/${A.id}/handover`)).body.handover.id).toBe(rot.body.handover.id);
    expect(rot.body.secret).toBeUndefined();
    expect(JSON.stringify(rot.body)).not.toMatch(KEY_RE);
    expect((await api('GET', `/keys/${A.id}`)).body.handover.id).toBe(rot.body.handover.id);
    // The check-in says one waits; the list names the key being replaced by its public id only.
    expect((await checkIn(pc.key)).body.handovers).toBe(1);
    const list = (await call('GET', '/connector/v1/handovers', pc.key)).body.handovers;
    expect(list).toEqual([expect.objectContaining({ id: rot.body.handover.id, kind: 'rotate', agents: [{ agent_id: A.agent.id, label: A.agent.label, key_id: A.keyId }] })]);
    expect(list[0].description).toContain('(rotation)');
    expect(JSON.stringify(list)).not.toMatch(KEY_RE);
    // Picked up, not confirmed: the old key works, the new one does not yet.
    const p1 = await call('POST', '/onboard/pickup', pc.key, { request_id: rot.body.handover.id });
    expect(p1.status, JSON.stringify(p1.body)).toBe(200);
    const s1 = p1.body.agents[0].secret as string;
    expect(p1.body.agents[0].key_id).toBe(A.keyId);
    expect(s1).toMatch(/^ah_ses_/);
    expect(await canLogin(A.secret)).toBe(true);
    expect(await canLogin(s1)).toBe(false);
    expect(app.keys.credential(A.id)!.status).toBe('active');
    // A second pickup before confirm replaces the staged secret: the first one never works.
    const p2 = await call('POST', '/onboard/pickup', pc.key, { request_id: rot.body.handover.id });
    const s2 = p2.body.agents[0].secret as string;
    expect(s2).not.toBe(s1);
    expect(await canLogin(A.secret)).toBe(true);
    const c = await call('POST', '/onboard/pickup/confirm', pc.key, { pickup_id: p2.body.pickup_id, written: [p2.body.agents[0].session_var] });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(await canLogin(s2)).toBe(true);
    expect(await canLogin(s1)).toBe(false);
    // The old key's page links to the new key; the new key's page shows the rotation confirmed (green).
    const nid = app.keys.verifyKey(s2, 'session_key').id;
    const old = (await api('GET', `/keys/${A.id}/handover`)).body;
    expect(old).toMatchObject({ handover: null, target: null, confirmed: { id: rot.body.handover.id, key: nid, pc: { id: pc.id } } });
    expect((await api('GET', `/keys/${nid}/handover`)).body.confirmed.key).toBe(nid);
    // A confirm repeated after a crash is answered as done.
    expect((await call('POST', '/onboard/pickup/confirm', pc.key, { pickup_id: p2.body.pickup_id, written: [p2.body.agents[0].session_var] })).body.already).toBe(true);
    expect((await checkIn(pc.key)).body.handovers).toBe(0);
    expect(records()).not.toContain(s1);
    expect(records()).not.toContain(s2);
  });

  it('after confirm the old key is rotated: its logins and turn tokens are refused, and the new key keeps its rules and teams', async () => {
    const A = await agentOnPc();
    app.keys.setRules(app.keys.credential(A.id)!.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:file_*' }], 'test', sys);
    const live = (await mcp(pc.key, { secret: A.secret }))!;
    const turn = app.connector.issueTurn(pc.id, A.secret, 'run-1');
    const T = await mcp(pc.key, { token: turn.token });
    expect((await T('session_whoami')).isError).toBeFalsy();
    const rot = (await api('POST', `/keys/${A.id}/rotate`, { reason: 'routine' })).body.handover;
    const p = await call('POST', '/onboard/pickup', pc.key, { request_id: rot.id });
    // Before confirm, the live login and the turn token go on.
    expect((await live('session_whoami')).isError).toBeFalsy();
    expect((await T('session_whoami')).isError).toBeFalsy();
    expect((await call('POST', '/onboard/pickup/confirm', pc.key, { pickup_id: p.body.pickup_id, written: [p.body.agents[0].session_var] })).status).toBe(200);
    expect(app.keys.credential(A.id)!.status).toBe('revoked');
    expect((await live('session_whoami')).isError).toBe(true);
    expect((await T('session_whoami')).isError).toBe(true);
    expect(await canLogin(A.secret)).toBe(false);
    const nk = app.keys.credentials({ kind: 'session_key', agentId: A.agent.id }).find((k) => k.status === 'active')!;
    expect(nk.replaces_credential_id).toBe(A.id);
    expect(nk.bound_machine_id).toBe(pc.id);
    expect(app.keys.rules(nk.policy_id).some((r) => r.resource === 'tool:file_*')).toBe(true);
    const rotate = actions('key.rotate').at(-1)!;
    expect(JSON.parse(rotate.details)).toMatchObject({ replaces: A.id, reason: 'routine', delivery: 'handover' });
    const notice = app.db.prepare("SELECT body FROM agent_notices WHERE agent_id=? AND kind='key_rotated'").get(A.agent.id) as { body: string };
    expect(notice.body).toContain('connector on your PC');
    expect(actions('key.handover.').map((a) => a.action).slice(-3)).toEqual(['key.handover.created', 'key.handover.picked_up', 'key.handover.confirmed']);
  });

  it('another PC\'s app key, or a turn token, cannot list, pick up or confirm the handover', async () => {
    const A = await agentOnPc();
    const rot = (await api('POST', `/keys/${A.id}/rotate`, { reason: 'routine' })).body.handover;
    expect((await call('GET', '/connector/v1/handovers', other.key)).body.handovers).toEqual([]);
    expect((await checkIn(other.key)).body.handovers).toBe(0);
    expect((await call('POST', '/onboard/pickup', other.key, { request_id: rot.id })).status).toBe(404);
    const turn = app.connector.issueTurn(pc.id, A.secret, 'run-2').token;
    expect((await call('GET', '/connector/v1/handovers', turn)).status).toBe(401);
    expect((await call('POST', '/onboard/pickup', turn, { request_id: rot.id })).status).toBe(401);
    const p = await call('POST', '/onboard/pickup', pc.key, { request_id: rot.id });
    expect((await call('POST', '/onboard/pickup/confirm', other.key, { pickup_id: p.body.pickup_id, written: [p.body.agents[0].session_var] })).status).toBe(409);
    expect((await call('POST', '/onboard/pickup/confirm', turn, { pickup_id: p.body.pickup_id, written: [p.body.agents[0].session_var] })).status).toBe(401);
    expect(app.keys.credential(A.id)!.status).toBe('active');
  });

  it('under a lockdown of all writes or of this PC, picking up a handover answers 423 (the lockdown cover of gap 1)', async () => {
    const A = await agentOnPc();
    const rot = (await api('POST', `/keys/${A.id}/rotate`, { reason: 'routine' })).body.handover;
    for (const [scope, id] of [['writes', undefined], ['pc', pc.id]] as const) {
      expect((await api('POST', '/lockdown', { scope, id, on: true })).status).toBe(200);
      try {
        const picked = await call('POST', '/onboard/pickup', pc.key, { request_id: rot.id });
        expect(picked.status, JSON.stringify(picked.body)).toBe(423);
        expect(picked.body.error).toBe('lockdown');
        expect(JSON.stringify(picked.body)).not.toMatch(KEY_RE);
        // The list is refused the same way: nothing about the open handover (id, description, labels, key ids) comes back.
        const listed = await call('GET', '/connector/v1/handovers', pc.key);
        expect(listed.status, JSON.stringify(listed.body)).toBe(423);
        expect(listed.body.error).toBe('lockdown');
        expect(JSON.stringify(listed.body)).not.toContain(rot.id);
        expect(JSON.stringify(listed.body)).not.toContain(A.keyId);
      } finally { expect((await api('POST', '/lockdown', { scope, id, on: false })).status).toBe(200); }
    }
    // Lifted: listed again.
    expect((await call('GET', '/connector/v1/handovers', pc.key)).body.handovers.map((x: any) => x.id)).toContain(rot.id);
    expect(app.keys.credential(A.id)!.status).toBe('active');
  });

  it('a handover expires after 24 hours; Cancel, a revoke or a re-binding cancel it, and the old key goes on', async () => {
    const A = await agentOnPc();
    const rot = (await api('POST', `/keys/${A.id}/rotate`, {})).body.handover;
    app.db.prepare('UPDATE onboarding_requests SET expires_at=? WHERE id=?').run(Date.now() - 1, rot.id);
    expect((await call('POST', '/onboard/pickup', pc.key, { request_id: rot.id })).status).toBe(409);
    expect(app.handovers.sweep()).toBeGreaterThanOrEqual(1);
    expect(app.onboarding.request(rot.id)!.state).toBe('cancelled');
    expect(JSON.parse(actions('key.handover.cancelled').at(-1)!.details)).toMatchObject({ reason: 'expired', kind: 'rotate' });
    expect(JSON.parse(actions('key.handover.cancelled').at(-1)!.details).rotation_reason).toBeUndefined();
    expect(await canLogin(A.secret)).toBe(true);
    // The operator's Cancel.
    const r2 = (await api('POST', `/keys/${A.id}/rotate`, {})).body.handover;
    // While it waits, Needs you has one row that opens the key; it leaves when the handover ends.
    const rowsOf = async () => Object.values((await api('GET', '/needs-you?limit=200')).body as Record<string, any>).flatMap((s) => s?.items ?? []).filter((r: any) => r.kind === 'key_handover' && r.open?.id === A.id);
    expect(await rowsOf()).toEqual([expect.objectContaining({ title: expect.stringContaining('waiting for the PC user'), reason: 'Not allowed on the PC yet · connector-pc', open: { kind: 'key', id: A.id } })]);
    expect((await api('POST', `/keys/${A.id}/handover/cancel`)).status).toBe(200);
    expect(await rowsOf()).toEqual([]);
    expect(app.onboarding.request(r2.id)!.state).toBe('cancelled');
    expect(JSON.parse(actions('key.handover.cancelled').at(-1)!.details).reason).toBe('operator');
    // Rotating again replaces the open one.
    const r3 = (await api('POST', `/keys/${A.id}/rotate`, {})).body.handover;
    const r4 = (await api('POST', `/keys/${A.id}/rotate`, {})).body.handover;
    expect(app.onboarding.request(r3.id)!.state).toBe('cancelled');
    expect(JSON.parse(actions('key.handover.cancelled').at(-1)!.details).reason).toBe('replaced');
    // Moving the key to another PC cancels it.
    expect((await api('PUT', `/keys/${A.id}/binding`, { machine_id: other.id })).status).toBe(200);
    expect(app.onboarding.request(r4.id)!.state).toBe('cancelled');
    expect(JSON.parse(actions('key.handover.cancelled').at(-1)!.details).reason).toBe('binding_changed');
    expect((await api('PUT', `/keys/${A.id}/binding`, { machine_id: pc.id })).status).toBe(200);
    // Revoking the key cancels it.
    const r5 = (await api('POST', `/keys/${A.id}/rotate`, {})).body.handover;
    expect((await api('POST', `/keys/${A.id}/revoke`)).status).toBe(200);
    expect(app.onboarding.request(r5.id)!.state).toBe('cancelled');
    expect(JSON.parse(actions('key.handover.cancelled').at(-1)!.details).reason).toBe('revoked');
    expect(HANDOVER_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('a key whose PC runs no connector is rotated at once and shown once', async () => {
    const a = app.keys.createAgent(`Agent ${++n}`, null, sys);
    const k = app.keys.createSessionKey({ agentId: a.id, label: 'free' }, sys);
    const rot = await api('POST', `/keys/${k.credential.id}/rotate`, { reason: 'routine' });
    expect(rot.status, JSON.stringify(rot.body)).toBe(200);
    expect(rot.body.handover).toBeUndefined();
    expect(rot.body.secret).toMatch(/^ah_ses_/);
    expect((await api('GET', `/keys/${rot.body.key.id}/handover`)).body).toEqual({ handover: null, target: null, confirmed: null, not_on_pc: null, leak_unfinished: false });
    expect(rot.body.prompt.mode).toBe('secret');
    expect(app.keys.credential(k.credential.id)!.status).toBe('revoked');
  });

  it('a new key for the connector PC reaches it by handover and works only from confirm', async () => {
    const a = app.keys.createAgent(`Agent ${++n}`, null, sys);
    const r = await api('POST', '/keys', { kind: 'session_key', agent_id: a.id, label: 'fresh', machine_id: pc.id });
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    expect(r.body.handover.pc.id).toBe(pc.id);
    expect(JSON.stringify(r.body)).not.toMatch(KEY_RE);
    const list = (await call('GET', '/connector/v1/handovers', pc.key)).body.handovers.find((h: any) => h.id === r.body.handover.id);
    expect(list.agents[0].key_id).toBeNull();
    const p = await call('POST', '/onboard/pickup', pc.key, { request_id: r.body.handover.id });
    expect(await canLogin(p.body.agents[0].secret)).toBe(false);
    expect((await call('POST', '/onboard/pickup/confirm', pc.key, { pickup_id: p.body.pickup_id, written: [p.body.agents[0].session_var] })).status).toBe(200);
    expect(await canLogin(p.body.agents[0].secret)).toBe(true);
    expect(app.keys.credential(r.body.key.id)!.status).toBe('active');
  });

  it('the old key pickup and collection routes refuse', async () => {
    for (const p of ['/onboard/key-pickup', '/onboard/key-collect/poll', '/onboard/key-collect/confirm']) {
      const r = await call('POST', p, pc.key, { code: 'cnv_key_aaaaaaaaaaaaaaaaaaaaaaaaaa' });
      expect(r.status, p).toBe(409);
      expect(r.body.reason).toBe('key_handover');
    }
  });
});

describe('the design review\'s cases', () => {
  /** A session key on a PC (no login needed: the binding is what a handover follows). */
  const keyOn = (machineId: string) => {
    const a = app.keys.createAgent(`Agent ${++n}`, null, sys);
    const k = app.keys.createSessionKey({ agentId: a.id, label: `a${n}`, machineId }, sys);
    return { agent: a, id: k.credential.id, keyId: k.credential.key_id, secret: k.secret };
  };

  it('a handover is never an onboarding request: not in the queue, and no route acts on it', async () => {
    const A = await agentOnPc();
    const id = (await api('POST', `/keys/${A.id}/rotate`, { reason: 'routine' })).body.handover.id;
    for (const q of ['', '?status=approved']) expect((await api('GET', `/onboarding${q}`)).body.requests.map((r: any) => r.id)).not.toContain(id);
    for (const [p, b] of [['deny', {}], ['needs-changes', { note: 'x' }], ['cancel', {}], ['reissue-pickup', {}], ['approve', { version: 1 }]] as const) {
      expect((await api('POST', `/onboarding/${id}/${p}`, b)).status, p).toBe(404);
    }
    expect((await call('GET', `/onboard/requests/${id}`, pc.key)).status).toBe(404);
    expect((await call('PUT', `/onboard/requests/${id}`, pc.key, { version: 1 })).status).toBe(404);
    expect((await call('POST', `/onboard/requests/${id}/withdraw`, pc.key)).status).toBe(404);
    expect(app.onboarding.request(id)!.state).toBe('approved');
    expect(app.handovers.cancel(id, 'operator', sys)).toBe(true);
  });

  it('a PC with no connector report gets show-once, audited as shown', async () => {
    const bare = await enrol('no-connector-pc');
    const K = keyOn(bare.id);
    expect((await api('GET', `/keys/${K.id}/handover`)).body.target).toBeNull();
    const r = await api('POST', `/keys/${K.id}/rotate`, { reason: 'routine' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.handover ?? null).toBeNull();
    expect(r.body.secret).toMatch(KEY_RE);
    expect(JSON.parse(actions('key.rotate').at(-1)!.details)).toMatchObject({ replaces: K.id, delivery: 'shown' });
  });

  it('a skip for a key the PC does not hold cancels at once as not_on_pc; only the bound app key may skip', async () => {
    const A = await agentOnPc();
    const id = (await api('POST', `/keys/${A.id}/rotate`, { reason: 'routine' })).body.handover.id;
    expect((await call('POST', `/connector/v1/handovers/${id}/skip`, other.key, { reason: 'key_not_held' })).status).toBe(404);
    expect((await call('POST', `/connector/v1/handovers/${id}/skip`, pc.key, { reason: 'lost' })).status).toBe(400);
    expect((await call('POST', `/connector/v1/handovers/${id}/skip`, pc.key, { reason: 'key_not_held' })).status).toBe(200);
    expect(app.onboarding.request(id)!.state).toBe('cancelled');
    expect(JSON.parse(actions('key.handover.cancelled').at(-1)!.details)).toMatchObject({ reason: 'not_on_pc' });
    // The key's page says the PC does not hold the key; nothing is open.
    expect((await api('GET', `/keys/${A.id}/handover`)).body).toMatchObject({ handover: null, not_on_pc: { id, pc: { id: pc.id, name: 'connector-pc' } } });
    expect(app.keys.credential(A.id)!.status).toBe('active');
    expect((await call('POST', `/connector/v1/handovers/${id}/skip`, pc.key, { reason: 'key_not_held' })).status).toBe(404);
  });

  it('an app key\'s rotation carries the PC\'s open handover to the new app key; the old one cannot pick it up', async () => {
    const carry = await enrol('carry-pc');
    expect((await checkIn(carry.key)).status).toBe(200);
    const K = keyOn(carry.id);
    const id = (await api('POST', `/keys/${K.id}/rotate`, { reason: 'routine' })).body.handover.id;
    const appId = (app.db.prepare('SELECT app_credential_id a FROM connector_reports WHERE machine_id=?').get(carry.id) as { a: string }).a;
    const r = await api('POST', `/keys/${appId}/rotate`, {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await call('POST', '/onboard/pickup', carry.key, { request_id: id })).status).toBe(401);
    expect((await call('GET', '/connector/v1/handovers', r.body.secret)).body.handovers.map((h: any) => h.id)).toContain(id);
    const p = await call('POST', '/onboard/pickup', r.body.secret, { request_id: id });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect((await call('POST', '/onboard/pickup/confirm', r.body.secret, { pickup_id: p.body.pickup_id, written: [p.body.agents[0].session_var] })).status).toBe(200);
    expect(app.keys.credential(K.id)!.status).toBe('revoked');
  });
});

describe('a rotation after a possible leak replaces the connector\'s app key', () => {
  it('revokes only that app key, answers its pairing code once, and binds the handover to the new key; the old key is refused', async () => {
    const L = await enrol('leak-pc');
    expect((await checkIn(L.key)).status).toBe(200);
    const oldApp = (app.db.prepare('SELECT app_credential_id a FROM connector_reports WHERE machine_id=?').get(L.id) as { a: string }).a;
    const mk = () => { const a = app.keys.createAgent(`Agent ${++n}`, null, sys); const k = app.keys.createSessionKey({ agentId: a.id, label: `a${n}`, machineId: L.id }, sys); return { agent: a, id: k.credential.id, secret: k.secret }; };
    const K1 = mk(), K2 = mk();
    // A live session and a turn token through the PC's app key, for an agent whose own key is not the one rotated.
    const live = (await mcp(L.key, { secret: K2.secret }))!;
    const turn = app.connector.issueTurn(L.id, K2.secret, 'run-leak');
    const T = await mcp(L.key, { token: turn.token });
    expect((await live('session_whoami')).isError).toBeFalsy();
    expect((await T('session_whoami')).isError).toBeFalsy();
    const ended = async (f: (n: string) => Promise<any>) => { try { return (await f('session_whoami')).isError === true; } catch { return true; } };
    const r = await api('POST', `/keys/${K1.id}/rotate`, { reason: 'suspected_leak' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.pairing).toMatchObject({ code: expect.any(String), pc: { id: L.id, name: 'leak-pc' }, hub_origin: 'https://hub.test' });
    expect(r.body.pairing.code_expires_at).toBeGreaterThan(Date.now());
    expect(r.body.handover).toMatchObject({ pc: { id: L.id }, picked_up: false });
    expect(r.body.handover.pairing).toBeUndefined();
    expect(r.body.handover.expires_at - r.body.handover.created_at).toBe(HANDOVER_TTL_MS);
    expect(JSON.stringify(r.body)).not.toMatch(KEY_RE);
    // The old app key is refused, also for the handover; the agents' keys stay.
    expect(app.keys.credential(oldApp)!.status).toBe('revoked');
    // Every session and turn token through the old app key has ended (acceptance gap 12).
    expect(await ended(live)).toBe(true);
    expect(await ended(T)).toBe(true);
    expect((await call('GET', '/connector/v1/handovers', L.key)).status).toBe(401);
    expect((await call('POST', '/onboard/pickup', L.key, { request_id: r.body.handover.id })).status).toBe(401);
    // The suspected key is held at once (suspended as leak_hold); the other agent's key stays.
    expect(app.keys.credential(K1.id)).toMatchObject({ status: 'suspended', status_reason: 'leak_hold' });
    expect(app.keys.credential(K2.id)!.status).toBe('active');
    expect(app.keys.credential(pc.key ? (app.db.prepare('SELECT app_credential_id a FROM connector_reports WHERE machine_id=?').get(pc.id) as { a: string }).a : '')!.status).toBe('active');
    const audit = JSON.parse(actions('pc.app_key_replaced').at(-1)!.details);
    expect(audit).toMatchObject({ replaced: oldApp, reason: 'suspected_leak' });
    expect(audit.replacement).not.toBe(oldApp);
    // The PC user pairs again: the new key lists the handover, picks it up and confirms; only K1 changes.
    const nonce = 'leak-pc-nonce-0123456789', h = { 'content-type': 'application/json', 'x-forwarded-for': '10.9.0.4', 'x-forwarded-proto': 'https' };
    const fresh = ((await fetch(`${base}/onboard/enrol`, { method: 'POST', headers: h, body: JSON.stringify({ code: r.body.pairing.code, nonce }) }).then((x) => x.json())) as any).app_key as string;
    await fetch(`${base}/onboard/enrol/confirm`, { method: 'POST', headers: h, body: JSON.stringify({ nonce }) });
    expect(app.keys.verifyKey(fresh, 'app_key').id).toBe(audit.replacement);
    // The old turn token does not come back through the new app key; the agent's own key logs in again.
    expect(await ended(await mcp(fresh, { token: turn.token }))).toBe(true);
    expect(await mcp(fresh, { secret: K2.secret })).not.toBeNull();
    expect((await call('GET', '/connector/v1/handovers', fresh)).body.handovers.map((x: any) => x.id)).toEqual([r.body.handover.id]);
    const p = await call('POST', '/onboard/pickup', fresh, { request_id: r.body.handover.id });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect((await call('POST', '/onboard/pickup/confirm', fresh, { pickup_id: p.body.pickup_id, written: [p.body.agents[0].session_var] })).status).toBe(200);
    expect(app.keys.credential(K1.id)!.status).toBe('revoked');
    expect(app.keys.credential(K2.id)!.status).toBe('active');
    expect(JSON.parse(actions('key.rotate').at(-1)!.details)).toMatchObject({ replaces: K1.id, reason: 'suspected_leak', delivery: 'handover' });
    expect(records()).not.toContain(r.body.pairing.code);
  });
  it('holds the suspected key at once: a free key is refused from another PC, its turn token ends, and the handover stays open', async () => {
    const F = await enrol('leak-free-pc');
    expect((await checkIn(F.key)).status).toBe(200);
    const a = app.keys.createAgent(`Agent ${++n}`, null, sys);
    const k = app.keys.createSessionKey({ agentId: a.id, label: `a${n}`, machineId: F.id }, sys);
    expect((await api('PUT', `/keys/${k.credential.id}/binding`, { machine_id: null })).status).toBe(200);
    expect(await mcp(F.key, { secret: k.secret })).not.toBeNull();
    // A free key works through any PC's app key until the leak rotation.
    expect(await mcp(other.key, { secret: k.secret })).not.toBeNull();
    const turn = app.connector.issueTurn(F.id, k.secret, 'run-hold');
    const T = (await mcp(F.key, { token: turn.token }))!;
    expect((await T('session_whoami')).isError).toBeFalsy();
    const r = await api('POST', `/keys/${k.credential.id}/rotate`, { reason: 'suspected_leak' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(app.keys.credential(k.credential.id)).toMatchObject({ status: 'suspended', status_reason: 'leak_hold' });
    expect(r.body.key).toMatchObject({ status_reason: 'leak_hold', effective_status: 'suspended' });
    expect(await mcp(other.key, { secret: k.secret })).toBeNull();
    let ended = false;
    try { ended = (await T('session_whoami')).isError === true; } catch { ended = true; }
    expect(ended).toBe(true);
    expect(JSON.parse(actions('key.hold').at(-1)!.details)).toMatchObject({ reason: 'suspected_leak' });
    // Holding the key does not cancel its handover; the key's page says it waits, not that the rotation is unfinished.
    expect(app.handovers.open(k.credential.id)!.id).toBe(r.body.handover.id);
    expect((await api('GET', `/keys/${k.credential.id}/handover`)).body).toMatchObject({ handover: { id: r.body.handover.id }, leak_unfinished: false });
    const leakRows = async () => Object.values((await api('GET', '/needs-you?limit=200')).body as Record<string, any>).flatMap((x) => x?.items ?? []).filter((x: any) => x.kind === 'key_leak_unfinished' && x.open?.id === k.credential.id);
    expect(await leakRows()).toEqual([]);
    // Not confirmed in 24 hours: the handover expires, the key stays held, and the key's page and Needs you say so.
    app.db.prepare('UPDATE onboarding_requests SET expires_at=? WHERE id=?').run(Date.now() - 1, r.body.handover.id);
    expect(app.handovers.sweep()).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(actions('key.handover.cancelled').at(-1)!.details)).toMatchObject({ reason: 'expired', rotation_reason: 'suspected_leak' });
    expect(app.keys.credential(k.credential.id)).toMatchObject({ status: 'suspended', status_reason: 'leak_hold' });
    expect(await mcp(other.key, { secret: k.secret })).toBeNull();
    expect((await api('GET', `/keys/${k.credential.id}/handover`)).body).toMatchObject({ handover: null, leak_unfinished: true });
    expect(await leakRows()).toEqual([expect.objectContaining({ title: 'Leak rotation not finished: rotate again or revoke', open: { kind: 'key', id: k.credential.id } })]);
    // Resume is refused for a held key: it may have leaked, so it comes back only as a new key or not at all.
    const re = await api('POST', `/keys/${k.credential.id}/reactivate`);
    expect(re.status).toBe(409);
    expect(re.body.message).toMatch(/may have leaked.*Rotate it again.*revoke it/);
    expect(app.keys.credential(k.credential.id)).toMatchObject({ status: 'suspended', status_reason: 'leak_hold' });
    // Revoking it ends the row.
    expect((await api('POST', `/keys/${k.credential.id}/revoke`)).status).toBe(200);
    expect(await leakRows()).toEqual([]);
  });
  it('a routine rotation leaves the app key alone', async () => {
    const A = await agentOnPc();
    const r = await api('POST', `/keys/${A.id}/rotate`, { reason: 'routine' });
    expect(r.body.pairing).toBeUndefined();
    expect((await checkIn(pc.key)).status).toBe(200);
    expect(app.handovers.cancel(r.body.handover.id, 'operator', sys)).toBe(true);
  });
});

describe('a recruit reaches the connector PC by key handover', () => {
  it('is listed for the connector\'s app key, and a pickup repeated before confirm creates no second agent', async () => {
    const coord = app.keys.createAgent(`Coord ${++n}`, null, sys);
    const ck = app.keys.createSessionKey({ agentId: coord.id, label: 'c', machineId: pc.id }, sys);
    app.keys.setRules(ck.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:file_*' }, { effect: 'allow', actions: ['fs.list', 'fs.read', 'fs.update'], resource: 'path:/vault/Notes/**' }], 'test', sys);
    const t = await api('POST', '/teams', { name: `Recruiters ${n}`, goal: 'g', members: [{ agent_id: coord.id, role: 'coordinator' }] });
    const tid = t.body.team.id as string;
    expect((await api('POST', `/teams/${tid}/start`)).status).toBe(200);
    expect((await api('PATCH', `/teams/${tid}`, { recruiting: 'auto', recruit_max: 2, recruit_days: 5 })).status).toBe(200);
    const C = (await mcp(pc.key, { secret: ck.secret }))!;
    const res = await C('team_recruit', { team_id: tid, label: 'Second reader', role: 'reviewer', purpose: 'Check the notes' });
    const r = res.structuredContent;
    expect(r.status, JSON.stringify(r)).toBe('created');
    expect(r.pickup.command).toBeUndefined();
    expect(res.content.map((c: any) => c.text).join('\n')).not.toContain('setup.mjs');
    expect(res.content.map((c: any) => c.text).join('\n')).toContain("connector's screen");
    expect(app.onboarding.request(r.pickup.request_id)).toMatchObject({ handover: 'recruit', kind: 'add_agents', state: 'approved' });
    const h = (await call('GET', '/connector/v1/handovers', pc.key)).body.handovers.find((x: any) => x.id === r.pickup.request_id);
    expect(h).toMatchObject({ kind: 'recruit', agents: [{ agent_id: r.agent_id, label: 'Second reader', key_id: null }] });
    expect(h.no_click).toBe(true); // the team is set to Automatic: the connector needs no click on the PC
    expect(h.description).toContain(`1 new agent for team Recruiters ${n}`);
    // A crash after the keys were written but before confirm: the connector picks up again; still one agent, one live key.
    const agentsBefore = (app.db.prepare('SELECT COUNT(*) n FROM agents').get() as { n: number }).n;
    const p1 = await call('POST', '/onboard/pickup', pc.key, { request_id: r.pickup.request_id });
    const p2 = await call('POST', '/onboard/pickup', pc.key, { request_id: r.pickup.request_id });
    expect(p2.status, JSON.stringify(p2.body)).toBe(200);
    expect(p2.body.agents[0].agent_id).toBe(p1.body.agents[0].agent_id);
    expect(p2.body.agents[0].folder).toBe(r.pickup.folder);
    const c = await call('POST', '/onboard/pickup/confirm', pc.key, { pickup_id: p2.body.pickup_id, written: [p2.body.agents[0].session_var] });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect((app.db.prepare('SELECT COUNT(*) n FROM agents').get() as { n: number }).n).toBe(agentsBefore);
    expect(app.keys.credentials({ kind: 'session_key', agentId: r.agent_id }).filter((k) => k.status === 'active')).toHaveLength(1);
    expect(await canLogin(p1.body.agents[0].secret)).toBe(false);
    expect(await canLogin(p2.body.agents[0].secret)).toBe(true);
    expect(actions('key.handover.').filter((a) => JSON.parse(a.details).kind === 'recruit').map((a) => a.action)).toEqual(['key.handover.created', 'key.handover.picked_up', 'key.handover.picked_up', 'key.handover.confirmed']);
    expect(records()).not.toContain(p2.body.agents[0].secret);
  });

  it('a recruit of an ask-first team never carries no_click: the PC user still clicks', async () => {
    const coord = app.keys.createAgent(`Coord ${++n}`, null, sys);
    const ck = app.keys.createSessionKey({ agentId: coord.id, label: 'c', machineId: pc.id }, sys);
    app.keys.setRules(ck.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:file_*' }, { effect: 'allow', actions: ['fs.list', 'fs.read', 'fs.update'], resource: 'path:/vault/Notes/**' }], 'test', sys);
    const t = await api('POST', '/teams', { name: `Askers ${n}`, goal: 'g', members: [{ agent_id: coord.id, role: 'coordinator' }] });
    const tid = t.body.team.id as string;
    await api('POST', `/teams/${tid}/start`);
    expect((await api('PATCH', `/teams/${tid}`, { recruiting: 'propose', recruit_max: 2, recruit_days: 5 })).status).toBe(200);
    const C = (await mcp(pc.key, { secret: ck.secret }))!;
    const q = (await C('team_recruit', { team_id: tid, label: 'Asked reader', role: 'reviewer', purpose: 'Check the notes' })).structuredContent;
    expect(q.status).toBe('pending');
    const ap = await api('POST', `/recruits/${q.request_id}/approve`);
    expect(ap.status, JSON.stringify(ap.body)).toBe(200);
    const h = (await call('GET', '/connector/v1/handovers', pc.key)).body.handovers.find((x: any) => x.id === ap.body.pickup.request_id);
    expect(h, JSON.stringify(ap.body)).toMatchObject({ kind: 'recruit' });
    expect(h.no_click).toBeUndefined();
  });

  it('a recruit not picked up within 24 hours is cancelled and its waiting agent archived', async () => {
    const coord = app.keys.createAgent(`Coord ${++n}`, null, sys);
    const ck = app.keys.createSessionKey({ agentId: coord.id, label: 'c', machineId: pc.id }, sys);
    app.keys.setRules(ck.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:file_*' }, { effect: 'allow', actions: ['fs.list', 'fs.read', 'fs.update'], resource: 'path:/vault/Notes/**' }], 'test', sys);
    const t = await api('POST', '/teams', { name: `Recruiters ${n}`, goal: 'g', members: [{ agent_id: coord.id, role: 'coordinator' }] });
    const tid = t.body.team.id as string;
    await api('POST', `/teams/${tid}/start`);
    await api('PATCH', `/teams/${tid}`, { recruiting: 'auto', recruit_max: 2, recruit_days: 5 });
    const C = (await mcp(pc.key, { secret: ck.secret }))!;
    const r = (await C('team_recruit', { team_id: tid, label: 'Late one', role: 'worker', purpose: 'p' })).structuredContent;
    app.db.prepare('UPDATE onboarding_requests SET expires_at=? WHERE id=?').run(Date.now() - 1, r.pickup.request_id);
    expect((await call('POST', '/onboard/pickup', pc.key, { request_id: r.pickup.request_id })).status).toBe(409);
    app.handovers.sweep();
    expect(app.onboarding.request(r.pickup.request_id)!.state).toBe('cancelled');
    expect(app.keys.agent(r.agent_id)!.status).toBe('archived');
    expect(JSON.parse(actions('key.handover.cancelled').at(-1)!.details)).toMatchObject({ kind: 'recruit', reason: 'expired' });
  });
});
