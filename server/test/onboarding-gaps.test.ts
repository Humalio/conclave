/**
 * Acceptance gaps (acceptance-gaps.md, "Onboarding, key handover and checkout"): Re-enrol voids the PC's old pairing code;
 * a confirmed handover cannot be picked up again; ending a team revokes its recruits' keys and cancels the recruits still
 * waiting for the PC (docs/onboarding.md: Re-enrol PC, Key handover, Recruiting).
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
  const dir = mkdtempSync(join(tmpdir(), 'ahobgap-'));
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


/** The pairing step of enrol with a code, from a fresh address: the app key, or the refusal. */
let ip = 10;
async function enrolWith(code: string) {
  const nonce = `gap-nonce-${++ip}-0123456789`, h = { 'content-type': 'application/json', 'x-forwarded-for': `10.9.1.${ip}`, 'x-forwarded-proto': 'https' };
  const r = await fetch(`${base}/onboard/enrol`, { method: 'POST', headers: h, body: JSON.stringify({ code, nonce }) });
  const body = (await r.json().catch(() => ({}))) as any;
  if (r.status === 200) await fetch(`${base}/onboard/enrol/confirm`, { method: 'POST', headers: h, body: JSON.stringify({ nonce }) });
  return { status: r.status, body };
}

describe('Re-enrol voids the old code', () => {
  it('an unused pairing code stops working once Re-enrol makes a new one; the new code works once', async () => {
    const add = await api('POST', '/pcs/add', { name: 'reenrol-unused' });
    expect(add.status, JSON.stringify(add.body)).toBe(200);
    const re = await api('POST', `/pcs/${add.body.pc.id}/re-enrol`, {});
    expect(re.status, JSON.stringify(re.body)).toBe(200);
    expect(re.body.code).not.toBe(add.body.code);
    const old = await enrolWith(add.body.code);
    expect(old.status).not.toBe(200);
    expect(JSON.stringify(old.body)).not.toMatch(KEY_RE);
    const fresh = await enrolWith(re.body.code);
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(200);
    expect(app.keys.verifyKey(fresh.body.app_key, 'app_key').id).toBe(re.body.key.id);
    // Single use: the same code a second time is refused.
    expect((await enrolWith(re.body.code)).status).not.toBe(200);
    expect(JSON.parse(actions('pc.re_enrol').at(-1)!.details).codes_revoked).toBeGreaterThanOrEqual(1);
  });
  it('a code paired but not confirmed is voided too, and the app key it gave stops working', async () => {
    const add = await api('POST', '/pcs/add', { name: 'reenrol-issued' });
    // The pairing step ran (an app key was handed out) but the PC never confirmed it.
    const h = { 'content-type': 'application/json', 'x-forwarded-for': '10.9.2.1', 'x-forwarded-proto': 'https' };
    const e = (await (await fetch(`${base}/onboard/enrol`, { method: 'POST', headers: h, body: JSON.stringify({ code: add.body.code, nonce: 'gap-issued-nonce-0123456789' }) })).json()) as any;
    expect(e.app_key).toMatch(/^ah_app_/);
    expect((await api('POST', `/pcs/${add.body.pc.id}/re-enrol`, {})).status).toBe(200);
    const confirm = await fetch(`${base}/onboard/enrol/confirm`, { method: 'POST', headers: h, body: JSON.stringify({ nonce: 'gap-issued-nonce-0123456789' }) });
    expect(confirm.status).not.toBe(200);
    expect((await checkIn(e.app_key)).status).toBe(401);
    expect((await enrolWith(add.body.code)).status).not.toBe(200);
  });
});

describe('a confirmed handover', () => {
  it('cannot be picked up again: the pickup is refused, it is no longer listed, and a repeated confirm only answers already', async () => {
    const A = await agentOnPc();
    const rot = (await api('POST', `/keys/${A.id}/rotate`, {})).body.handover;
    expect(rot?.id).toBeTruthy();
    const p = await call('POST', '/onboard/pickup', pc.key, { request_id: rot.id });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    const written = [p.body.agents[0].session_var];
    expect((await call('POST', '/onboard/pickup/confirm', pc.key, { pickup_id: p.body.pickup_id, written })).status).toBe(200);
    const newSecret = p.body.agents[0].secret as string;
    expect(await canLogin(newSecret)).toBe(true);
    // Picked up again after confirm: refused, and nothing new is staged or issued.
    const again = await call('POST', '/onboard/pickup', pc.key, { request_id: rot.id });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('invalid_state');
    expect(JSON.stringify(again.body)).not.toMatch(KEY_RE);
    expect((await call('GET', '/connector/v1/handovers', pc.key)).body.handovers.map((x: any) => x.id)).not.toContain(rot.id);
    // Another PC's app key gets nothing either.
    const stranger = await call('POST', '/onboard/pickup', other.key, { request_id: rot.id });
    expect(stranger.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(stranger.body)).not.toMatch(KEY_RE);
    // A confirm repeated after a lost answer: 200 with already, and the new key stays the live one.
    const c2 = await call('POST', '/onboard/pickup/confirm', pc.key, { pickup_id: p.body.pickup_id, written });
    expect(c2.status, JSON.stringify(c2.body)).toBe(200);
    expect(c2.body.already).toBe(true);
    expect(await canLogin(newSecret)).toBe(true);
    expect(await canLogin(A.secret)).toBe(false);
    expect(actions('key.handover.confirmed').filter((a) => a.details.includes(A.agent.id))).toHaveLength(1);
    expect(app.keys.credentials({ kind: 'session_key', agentId: A.agent.id }).filter((k) => k.status === 'active')).toHaveLength(1);
  });
});

describe('ending a team', () => {
  it('revokes the keys of the agents it recruited and cancels the recruits still waiting for the PC', async () => {
    const coord = app.keys.createAgent(`Coord ${++n}`, null, sys);
    const ck = app.keys.createSessionKey({ agentId: coord.id, label: 'c', machineId: pc.id }, sys);
    app.keys.setRules(ck.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:file_*' }, { effect: 'allow', actions: ['fs.list', 'fs.read', 'fs.update'], resource: 'path:/vault/Notes/**' }], 'test', sys);
    const t = await api('POST', '/teams', { name: `Ending ${n}`, goal: 'g', members: [{ agent_id: coord.id, role: 'coordinator' }] });
    expect(t.status).toBe(201);
    const tid = t.body.team.id as string;
    expect((await api('POST', `/teams/${tid}/start`)).status).toBe(200);
    expect((await api('PATCH', `/teams/${tid}`, { recruiting: 'auto', recruit_max: 3, recruit_days: 5 })).status).toBe(200);
    const C = (await mcp(pc.key, { secret: ck.secret }))!;
    // One recruit picked up and confirmed (it runs), one still waiting for the PC user.
    const joined = (await C('team_recruit', { team_id: tid, label: 'Joined one', role: 'worker', purpose: 'p' })).structuredContent;
    const waiting = (await C('team_recruit', { team_id: tid, label: 'Waiting one', role: 'reviewer', purpose: 'p' })).structuredContent;
    expect(joined?.status, JSON.stringify(joined)).toBe('created');
    expect(waiting?.status, JSON.stringify(waiting)).toBe('created');
    const p = await call('POST', '/onboard/pickup', pc.key, { request_id: joined.pickup.request_id });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect((await call('POST', '/onboard/pickup/confirm', pc.key, { pickup_id: p.body.pickup_id, written: [p.body.agents[0].session_var] })).status).toBe(200);
    const recruitKey = p.body.agents[0].secret as string;
    expect(await canLogin(recruitKey)).toBe(true);
    expect((await call('GET', '/connector/v1/handovers', pc.key)).body.handovers.map((x: any) => x.id)).toContain(waiting.pickup.request_id);
    // The operator ends the team.
    const stop = await api('POST', `/teams/${tid}/stop`, {});
    expect(stop.status, JSON.stringify(stop.body)).toBe(200);
    // The recruit that joined: its key is revoked, its logins refused.
    expect(app.keys.credentials({ kind: 'session_key', agentId: joined.agent_id }).filter((k) => k.status !== 'revoked')).toEqual([]);
    expect(await canLogin(recruitKey)).toBe(false);
    // The recruit still waiting: cancelled, no longer listed for the PC, its pickup refused, its agent archived.
    expect(app.onboarding.request(waiting.pickup.request_id)!.state).toBe('cancelled');
    expect((await call('GET', '/connector/v1/handovers', pc.key)).body.handovers.map((x: any) => x.id)).not.toContain(waiting.pickup.request_id);
    expect((await call('POST', '/onboard/pickup', pc.key, { request_id: waiting.pickup.request_id })).status).toBeGreaterThanOrEqual(400);
    expect(app.keys.agent(waiting.agent_id)!.status).toBe('archived');
    expect(app.keys.credentials({ kind: 'session_key', agentId: waiting.agent_id }).filter((k) => k.status !== 'revoked')).toEqual([]);
    // Cancelled like any handover: one audit, with the reason.
    const cancelled = actions('key.handover.cancelled').map((a) => JSON.parse(a.details)).filter((d) => d.agents?.includes(waiting.agent_id));
    expect(cancelled).toEqual([expect.objectContaining({ kind: 'recruit', pc: pc.id, reason: 'team_ended' })]);
    expect(app.onboarding.request(waiting.pickup.request_id)!.operator_note).toBe('Recruiting ended for the team.');
    expect(records()).not.toContain(recruitKey);
    // The coordinator, not a recruit, keeps its key.
    expect(app.keys.credential(ck.credential.id)!.status).toBe('active');
  });
});
