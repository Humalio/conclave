/**
 * Onboarding, key handover and checkout: the remaining acceptance gaps (docs/onboarding.md, docs/checkout.md §9.1).
 *
 * Covers:
 * - a recruit whose folder the connector refuses: the handover is cancelled (folder_refused) and the waiting agent archived;
 * - a delegate's prompt: opened (checkout.prompt_opened), opened again, then prompt_in_use once the restore picked up the key;
 *   a handout body never copied is cleared after the cap (checkout.handout_purged_uncopied);
 * - the onboarding capability: off refuses filing with 403 capability_off; turning it off and on is audited;
 * - confirm with another PC's app key is refused for an ordinary request, which stays unconfirmed;
 * - a vault agent whose owner is lowered to Read cannot edit;
 * - the enrolment code in the X-Conclave-Enrol-Code header works and that header is redacted from the hub's logs;
 * - switching recruiting off revokes only the recruits' keys, not the keys of agents the operator added;
 * - a recruit handover waiting on a PC counts as its pending request: filing is refused (invalid_state) and audited;
 * - suspending a key cancels its open rotation handover;
 * - the push stream's `event: handovers` carries no secret and no id;
 * - `bound: false` at approval: that agent's key is free, the others are bound;
 * - approval checks again: a limit lowered or a request amended since filing fails the approval and creates nothing;
 * - a project name clash at approval;
 * - pickup and status rate limits per app key (429 past the limit);
 * - the audit events onboarding.pickup_refused, onboarding.request_refused and onboarding.request_refused_pending.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import { PICKUP_PER_HOUR, STATUS_PER_HOUR } from '../src/onboarding/onboarding.js';
import { PURGE_CAP_MS } from '../src/mirror/mirror.js';
import { RESTORE_TEMPLATE, scanClean } from './restoreTemplate.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
/** A whole key or token; the masked public form (ah_ses_<id>_…) is not one. */
const KEY_RE = /ah_(ses|app)_[a-z2-7]+_[A-Za-z0-9]{8}|ah_tok_[A-Za-z0-9]{8}/;
type Sess = { cookie: string; csrf: string };
let app: App, base = '', admin: Sess = { cookie: '', csrf: '' }, n = 0;

const as = async (who: Sess, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie: who.cookie, 'x-csrf-token': who.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const api = (method: string, path: string, body?: unknown) => as(admin, method, path, body);
/** A call with a bearer (a PC's app key), through the trusted loopback proxy as HTTPS. */
const call = async (method: string, path: string, bearer: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}`, 'x-forwarded-proto': 'https', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const checkIn = (key: string) => call('POST', '/connector/v1/check-in', key, { version: '0.9.6' });
/** An MCP session through an app key, logged in with a session key; null when the login is refused. */
async function mcp(appKey: string, secret: string) {
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  const r = (await c.callTool({ name: 'session_login', arguments: { session_key: secret } })) as any;
  if (r.isError || !r.structuredContent?.session_token) return null;
  const token = r.structuredContent.session_token as string;
  return async (name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name, arguments: { session_token: token, ...args } })) as any;
}
let ip = 10;
/** An enrolled PC (Add PC): its app key carries the onboarding capability. `connector` also checks in, so handovers reach it. */
async function enrol(name: string, o: { connector?: boolean; header?: boolean } = {}) {
  const add = await api('POST', '/pcs/add', { name });
  expect(add.status, JSON.stringify(add.body)).toBe(200);
  const nonce = `${name}-nonce-0123456789`, h: Record<string, string> = { 'content-type': 'application/json', 'x-forwarded-for': `10.9.7.${++ip}`, 'x-forwarded-proto': 'https' };
  // The enrolment code may come in the X-Conclave-Enrol-Code header instead of the body.
  const body = o.header ? { nonce } : { code: add.body.code, nonce };
  const e = await fetch(`${base}/onboard/enrol`, { method: 'POST', headers: o.header ? { ...h, 'x-conclave-enrol-code': add.body.code } : h, body: JSON.stringify(body) });
  const eb = (await e.json()) as any;
  expect(e.status, JSON.stringify(eb)).toBe(200);
  expect((await fetch(`${base}/onboard/enrol/confirm`, { method: 'POST', headers: h, body: JSON.stringify({ nonce }) })).status).toBe(200);
  const pc = { id: add.body.pc.id as string, key: eb.app_key as string, keyId: add.body.key.id as string, code: add.body.code as string };
  if (o.connector) expect((await checkIn(pc.key)).status).toBe(200);
  return pc;
}
let proj = 0;
const request = (over: Record<string, unknown> = {}) => ({
  kind: 'new_team', project: { name: `Rest ${++proj}`, existing: false }, team: { name: `Rest team ${proj}`, goal: 'Keep the notes.' },
  roles: [
    { name: 'lead', team_role: 'coordinator', count: 1, job: 'Plans.' },
    { name: 'dev', team_role: 'worker', count: 1, job: 'Builds.' },
    { name: 'checker', team_role: 'reviewer', count: 1, job: 'Reviews.', reviews: ['dev'] },
  ],
  prompt: 'a small team', client: { app: 'claude-code', os: 'linux' }, ...over,
});
const file = (key: string, over: Record<string, unknown> = {}) => call('POST', '/onboard/requests', key, request(over));
const vars = (p: { body: { agents: { session_var: string }[] } }) => p.body.agents.map((a) => a.session_var);
const actions = (prefix: string) => (app.db.prepare('SELECT action, target_id, details FROM audit_events WHERE action LIKE ? ORDER BY rowid').all(`${prefix}%`) as { action: string; target_id: string | null; details: string }[]);
const count = (t: string) => (app.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n;

/** A running team on the PC: a coordinator (recruiting on) and a worker the operator added; neither is a recruit. */
async function recruitingTeam(pc: { id: string; key: string }) {
  const mk = (label: string) => {
    const a = app.keys.createAgent(`${label} ${++n}`, null, sys);
    const k = app.keys.createSessionKey({ agentId: a.id, label, machineId: pc.id }, sys);
    return { agent: a, cred: k.credential.id, secret: k.secret };
  };
  const coord = mk('Coord'), worker = mk('Worker');
  app.keys.setRules(app.keys.credential(coord.cred)!.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:file_*' }, { effect: 'allow', actions: ['fs.list', 'fs.read', 'fs.update'], resource: 'path:/vault/Notes/**' }], 'test', sys);
  const t = await api('POST', '/teams', { name: `Recruiters ${n}`, goal: 'g', members: [{ agent_id: coord.agent.id, role: 'coordinator' }, { agent_id: worker.agent.id, role: 'worker' }] });
  expect(t.status, JSON.stringify(t.body)).toBe(201);
  const tid = t.body.team.id as string;
  expect((await api('POST', `/teams/${tid}/start`)).status).toBe(200);
  expect((await api('PATCH', `/teams/${tid}`, { recruiting: 'auto', recruit_max: 3, recruit_days: 5 })).status).toBe(200);
  const C = (await mcp(pc.key, coord.secret))!;
  const recruit = async (label: string) => {
    const r = (await C('team_recruit', { team_id: tid, label, role: 'worker', purpose: 'p' })).structuredContent;
    expect(r?.status, JSON.stringify(r)).toBe('created');
    return { agentId: r.agent_id as string, requestId: r.pickup.request_id as string };
  };
  return { tid, coord, worker, recruit };
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahobrest-'));
  const v = (...p: string[]) => join(dir, 'vault', ...p);
  mkdirSync(v('Notes'), { recursive: true });
  mkdirSync(v('Shared', 'Team'), { recursive: true });
  writeFileSync(v('Notes', 'a.md'), '# A\n');
  writeFileSync(v('Shared', 'Team', 'plan.md'), '# Plan\n');
  const client = join(dir, 'client');
  mkdirSync(client);
  writeFileSync(join(client, 'restore-prompt.md'), RESTORE_TEMPLATE);
  app = await buildApp(testConfig(dir, { publicUrl: 'https://hub.test', clientDir: client, repoHosts: ['git.example.org'], maintenanceSeconds: undefined }));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  admin = await adminLogin(base);
});
afterAll(async () => { await app.close(); });
// Pickups and status calls are limited per app key and hour; each test starts with fresh counts.
beforeEach(() => { app.db.prepare("DELETE FROM usage_counters WHERE metric IN ('onboard_pickup','onboard_status')").run(); });

describe('recruit handovers', () => {
  it('a recruit whose folder the connector refuses: the handover is cancelled as folder_refused and the waiting agent archived', async () => {
    const pc = await enrol('folder-pc', { connector: true });
    const T = await recruitingTeam(pc);
    const r = await T.recruit('Bad folder');
    // Only the bound app key may skip; a key_not_held skip does not apply to a recruit.
    const other = await enrol('folder-other', { connector: true });
    expect((await call('POST', `/connector/v1/handovers/${r.requestId}/skip`, other.key, { reason: 'folder_refused' })).status).toBe(404);
    expect((await call('POST', `/connector/v1/handovers/${r.requestId}/skip`, pc.key, { reason: 'key_not_held' })).status).toBe(404);
    const s = await call('POST', `/connector/v1/handovers/${r.requestId}/skip`, pc.key, { reason: 'folder_refused' });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(app.onboarding.request(r.requestId)!.state).toBe('cancelled');
    expect(app.keys.agent(r.agentId)!.status).toBe('archived');
    expect((await call('GET', '/connector/v1/handovers', pc.key)).body.handovers).toEqual([]);
    expect((await call('POST', '/onboard/pickup', pc.key, { request_id: r.requestId })).status).toBeGreaterThanOrEqual(400);
    const cancelled = actions('key.handover.cancelled').filter((a) => a.target_id === r.requestId).map((a) => JSON.parse(a.details));
    expect(cancelled).toEqual([expect.objectContaining({ kind: 'recruit', pc: pc.id, reason: 'folder_refused', agents: [r.agentId] })]);
  });

  it('while a recruit handover waits on a PC, the PC files nothing else: invalid_state, audited as request_refused_pending', async () => {
    const pc = await enrol('waiting-pc', { connector: true });
    const T = await recruitingTeam(pc);
    const r = await T.recruit('Waiting one');
    const before = count('onboarding_requests');
    const f = await file(pc.key);
    expect(f.status, JSON.stringify(f.body)).toBe(409);
    expect(f.body.error).toBe('invalid_state');
    expect(f.body.pending).toMatchObject({ request_id: r.requestId, state: 'approved', handover: 'recruit' });
    // The refusal names the handover in plain words: what it is and where it waits.
    expect(f.body.message).toContain('key handover');
    expect(f.body.message).toContain(`Recruiters`);
    expect(f.body.message).toContain("connector's screen");
    expect(count('onboarding_requests')).toBe(before);
    expect(actions('onboarding.request_refused_pending').filter((a) => a.target_id === r.requestId).map((a) => JSON.parse(a.details))).toEqual([{ app_key: expect.any(String), handover: 'recruit' }]);
    // The PC's own list of pending requests leaves the handover out (a handover is never a request the PC acts on).
    expect((await call('GET', '/onboard/requests?pending=1', pc.key)).body.requests).toEqual([]);
    expect((await call('GET', `/onboard/requests/${r.requestId}`, pc.key)).status).toBe(404);
    // Once it ends (here: cancelled by the operator's recruiting off), the PC files again.
    expect((await api('PATCH', `/teams/${T.tid}`, { recruiting: 'off' })).status).toBe(200);
    expect(app.onboarding.request(r.requestId)!.state).toBe('cancelled');
    const again = await file(pc.key);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
  });

  it('switching recruiting off revokes the recruits\' keys only; the agents the operator added keep theirs', async () => {
    const pc = await enrol('off-pc', { connector: true });
    const T = await recruitingTeam(pc);
    const joined = await T.recruit('Joined');
    const p = await call('POST', '/onboard/pickup', pc.key, { request_id: joined.requestId });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect((await call('POST', '/onboard/pickup/confirm', pc.key, { pickup_id: p.body.pickup_id, written: vars(p) })).status).toBe(200);
    const recruitSecret = p.body.agents[0].secret as string;
    expect(await mcp(pc.key, recruitSecret)).not.toBeNull();
    expect((await api('PATCH', `/teams/${T.tid}`, { recruiting: 'off' })).status).toBe(200);
    expect(app.keys.credentials({ kind: 'session_key', agentId: joined.agentId }).filter((k) => k.status !== 'revoked')).toEqual([]);
    expect(await mcp(pc.key, recruitSecret)).toBeNull();
    expect(app.keys.credential(T.coord.cred)!.status).toBe('active');
    expect(app.keys.credential(T.worker.cred)!.status).toBe('active');
    expect(await mcp(pc.key, T.worker.secret)).not.toBeNull();
  });
});

describe('rotation handovers', () => {
  it('suspending a key cancels its open rotation handover; the old key is suspended, not rotated', async () => {
    const pc = await enrol('suspend-pc', { connector: true });
    const a = app.keys.createAgent(`Agent ${++n}`, null, sys);
    const k = app.keys.createSessionKey({ agentId: a.id, label: 's', machineId: pc.id }, sys);
    const rot = await api('POST', `/keys/${k.credential.id}/rotate`, { reason: 'routine' });
    expect(rot.body.handover?.id, JSON.stringify(rot.body)).toBeTruthy();
    expect((await api('POST', `/keys/${k.credential.id}/suspend`)).status).toBe(200);
    expect(app.onboarding.request(rot.body.handover.id)!.state).toBe('cancelled');
    expect((await call('GET', '/connector/v1/handovers', pc.key)).body.handovers).toEqual([]);
    expect((await call('POST', '/onboard/pickup', pc.key, { request_id: rot.body.handover.id })).status).toBeGreaterThanOrEqual(400);
    // A suspend is cancelled with the reason `revoked` (the docs' list has no separate `suspended`).
    expect(JSON.parse(actions('key.handover.cancelled').filter((x) => x.target_id === rot.body.handover.id)[0]!.details)).toMatchObject({ kind: 'rotate', reason: 'revoked' });
    expect(app.keys.credential(k.credential.id)!.status).toBe('suspended');
  });

  it('the push stream says `event: handovers` with no secret, no id and no count', async () => {
    const pc = await enrol('stream-pc', { connector: true });
    const ac = new AbortController();
    const r = await fetch(`${base}/connector/v1/stream?installation=inst-rest01`, { headers: { authorization: `Bearer ${pc.key}`, accept: 'text/event-stream' }, signal: ac.signal });
    expect(r.status).toBe(200);
    let text = '';
    const reader = r.body!.getReader(), dec = new TextDecoder();
    const reading = (async () => { try { for (;;) { const { done, value } = await reader.read(); if (done) return; text += dec.decode(value); } } catch { /* aborted */ } })();
    try {
      const a = app.keys.createAgent(`Agent ${++n}`, null, sys);
      const k = app.keys.createSessionKey({ agentId: a.id, label: 'st', machineId: pc.id }, sys);
      const rot = await api('POST', `/keys/${k.credential.id}/rotate`, { reason: 'routine' });
      const t0 = Date.now();
      while (!text.includes('event: handovers') && Date.now() - t0 < 3000) await new Promise((x) => setTimeout(x, 20));
      const ev = /event: handovers\ndata: (.*)\n/.exec(text);
      expect(ev, text).not.toBeNull();
      expect(ev![1]).toBe('{}');
      expect(text).not.toMatch(KEY_RE);
      expect(text).not.toContain(rot.body.handover.id);
      expect(text).not.toContain(k.credential.key_id);
    } finally { ac.abort(); await reading; }
  });
});

describe('the onboarding capability and the PC key', () => {
  it('capability off: filing gets 403 capability_off; turning it off and on is audited', async () => {
    const pc = await enrol('cap-pc');
    // Add PC made the key with the capability on: one grant already.
    const grants = () => actions('onboarding.capability_grant').filter((a) => a.target_id === pc.keyId).length;
    expect(grants()).toBe(1);
    const off = await api('DELETE', `/keys/${pc.keyId}/onboarding`);
    expect(off.body.key.onboarding_enabled_at).toBeNull();
    const f = await file(pc.key);
    expect(f.status).toBe(403);
    expect(f.body.error).toBe('capability_off');
    expect(actions('onboarding.capability_remove').filter((a) => a.target_id === pc.keyId)).toHaveLength(1);
    expect((await api('PUT', `/keys/${pc.keyId}/onboarding`)).body.key.onboarding_enabled_at).toBeTypeOf('number');
    expect(grants()).toBe(2);
    expect((await file(pc.key)).status).toBe(200);
  });

  it('the enrolment code in the X-Conclave-Enrol-Code header works, and the hub\'s logger redacts that header', async () => {
    const pc = await enrol('header-pc', { header: true });
    expect(app.keys.verifyKey(pc.key, 'app_key').id).toBe(pc.keyId);
    expect(actions('onboarding.enrol').some((a) => a.target_id === pc.id)).toBe(true);
    expect(JSON.stringify(app.db.prepare('SELECT * FROM audit_events').all())).not.toContain(pc.code);
    // The logger's redact list (server/src/app.ts) names the header, so no request log carries the code.
    const src = readFileSync(join(process.cwd(), 'src', 'app.ts'), 'utf8');
    const redact = src.split('\n').find((l) => l.includes('redact: ['))?.replace(/^.*redact: \[/, '').split('] }')[0] ?? '';
    expect(redact).toContain('req.headers["x-conclave-enrol-code"]');
    expect(redact).toContain('req.headers.authorization');
  });

  it('pickup is limited to 10 an hour per app key, status calls to 120; past the limit 429 with retry_after_s', async () => {
    const pc = await enrol('limit-pc');
    expect(PICKUP_PER_HOUR).toBe(10);
    expect(STATUS_PER_HOUR).toBe(120);
    for (let i = 0; i < PICKUP_PER_HOUR; i++) expect((await call('POST', '/onboard/pickup', pc.key, { request_id: 'obr_nosuchrequest' })).status).toBe(404);
    const p = await call('POST', '/onboard/pickup', pc.key, { request_id: 'obr_nosuchrequest' });
    expect(p.status).toBe(429);
    expect(p.body.error).toBe('rate_limited');
    expect(p.body.retry_after_s).toBeGreaterThan(0);
    // Confirm shares the pickup budget.
    expect((await call('POST', '/onboard/pickup/confirm', pc.key, { pickup_id: 'pku_nosuchpickup', written: [] })).status).toBe(429);
    for (let i = 0; i < STATUS_PER_HOUR; i++) expect((await call('GET', '/onboard/requests', pc.key)).status).toBe(200);
    const s = await call('GET', '/onboard/requests', pc.key);
    expect(s.status).toBe(429);
    expect(s.body.retry_after_s).toBeGreaterThan(0);
  });
});

describe('pickup and confirm', () => {
  it('confirm with another PC\'s app key is refused for an ordinary request, which stays unconfirmed; refusals are audited', async () => {
    const pc = await enrol('confirm-pc'), other = await enrol('confirm-other');
    const f = await file(pc.key);
    expect((await api('POST', `/onboarding/${f.body.request_id}/approve`, { version: f.body.version })).status).toBe(200);
    // Another PC's pickup: not found, audited as wrong_key.
    expect((await call('POST', '/onboard/pickup', other.key, { request_id: f.body.request_id })).status).toBe(404);
    expect(JSON.parse(actions('onboarding.pickup_refused').filter((a) => a.target_id === f.body.request_id).at(-1)!.details)).toMatchObject({ reason: 'wrong_key' });
    const p = await call('POST', '/onboard/pickup', pc.key, { request_id: f.body.request_id });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    const c = await call('POST', '/onboard/pickup/confirm', other.key, { pickup_id: p.body.pickup_id, written: vars(p) });
    expect(c.status).toBe(409);
    expect(c.body.error).toBe('invalid_state');
    expect(JSON.stringify(c.body)).not.toMatch(KEY_RE);
    expect(app.onboarding.request(f.body.request_id)!.state).toBe('approved');
    expect(app.teams.members(app.onboarding.request(f.body.request_id)!.team_id!)).toHaveLength(0);
    expect(JSON.parse(actions('onboarding.pickup_refused').filter((a) => a.target_id === f.body.request_id).at(-1)!.details)).toMatchObject({ reason: 'wrong_key', step: 'confirm' });
    // The PC's own confirm still works; a pickup after it is refused and audited as after_collect.
    expect((await call('POST', '/onboard/pickup/confirm', pc.key, { pickup_id: p.body.pickup_id, written: vars(p) })).status).toBe(200);
    expect((await call('POST', '/onboard/pickup', pc.key, { request_id: f.body.request_id })).status).toBe(409);
    expect(JSON.parse(actions('onboarding.pickup_refused').filter((a) => a.target_id === f.body.request_id).at(-1)!.details)).toMatchObject({ reason: 'after_collect' });
  });

  it('a slot approved with bound: false gets a free key; the others are bound to the PC', async () => {
    const pc = await enrol('free-pc'), other = await enrol('free-other');
    const f = await file(pc.key);
    const a = await api('POST', `/onboarding/${f.body.request_id}/approve`, { version: f.body.version, agents: [{ slot: 'checker', bound: false }] });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(JSON.parse(actions('onboarding.approve').filter((x) => x.target_id === f.body.request_id)[0]!.details).bindings).toEqual([true, true, false]);
    const p = await call('POST', '/onboard/pickup', pc.key, { request_id: f.body.request_id });
    expect((await call('POST', '/onboard/pickup/confirm', pc.key, { pickup_id: p.body.pickup_id, written: vars(p) })).status).toBe(200);
    const byRole = (r: string) => p.body.agents.find((x: { role: string }) => x.role === r).secret as string;
    expect(app.keys.verifyKey(byRole('checker'), 'session_key').bound_machine_id).toBeNull();
    expect(app.keys.verifyKey(byRole('dev'), 'session_key').bound_machine_id).toBe(pc.id);
    // The free key logs in through another PC's app key; a bound one does not.
    expect(await mcp(other.key, byRole('checker'))).not.toBeNull();
    expect(await mcp(other.key, byRole('dev'))).toBeNull();
  });
});

describe('approval checks again', () => {
  const nothingNew = () => ({ projects: count('projects'), teams: count('teams'), agents: count('agents') });
  it('a limit lowered or a request amended since the screen loaded fails the approval and creates nothing', async () => {
    const pc = await enrol('recheck-pc');
    const f = await file(pc.key);
    const before = nothingNew();
    expect((await api('PUT', '/settings/onboarding', { max_agents: 2 })).status).toBe(200);
    try {
      const a = await api('POST', `/onboarding/${f.body.request_id}/approve`, { version: f.body.version });
      expect(a.status).toBe(400);
      expect(a.body.message).toMatch(/3 agents, at most 2/);
    } finally { expect((await api('PUT', '/settings/onboarding', { max_agents: 12 })).status).toBe(200); }
    expect(nothingNew()).toEqual(before);
    // The PC amends it: the version the operator's screen holds is stale.
    const am = await call('PUT', `/onboard/requests/${f.body.request_id}`, pc.key, { ...request(), version: f.body.version });
    expect(am.status, JSON.stringify(am.body)).toBe(200);
    expect((await api('POST', `/onboarding/${f.body.request_id}/approve`, { version: f.body.version })).status).toBe(409);
    expect(nothingNew()).toEqual(before);
    expect(app.onboarding.request(f.body.request_id)!.state).toBe('submitted');
    expect((await api('POST', `/onboarding/${f.body.request_id}/approve`, { version: am.body.version })).status).toBe(200);
  });

  it('a project name taken since filing: the approval is refused as invalid_argument and creates nothing', async () => {
    const a = await enrol('clash-a'), b = await enrol('clash-b');
    const project = { name: `Clash ${++proj}`, existing: false };
    const fa = await file(a.key, { project, team: { name: 'Clash A', goal: 'g' } });
    const fb = await file(b.key, { project, team: { name: 'Clash B', goal: 'g' } });
    expect(fa.status).toBe(200);
    expect(fb.status).toBe(200);
    expect((await api('POST', `/onboarding/${fa.body.request_id}/approve`, { version: fa.body.version })).status).toBe(200);
    const before = nothingNew();
    const r = await api('POST', `/onboarding/${fb.body.request_id}/approve`, { version: fb.body.version });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_argument');
    expect(r.body.message).toContain(`A project "${project.name}" already exists`);
    expect(nothingNew()).toEqual(before);
    expect(app.onboarding.request(fb.body.request_id)!.state).toBe('submitted');
  });
});

describe('refusals at filing', () => {
  it('a request carrying a key is refused and audited as request_refused; a second request as request_refused_pending', async () => {
    const pc = await enrol('refuse-pc');
    const leak = await file(pc.key, { prompt: `use ${pc.key} please` });
    expect(leak.status).toBe(400);
    expect(leak.body.error).toBe('contains_key');
    expect(actions('onboarding.request_refused').filter((a) => a.target_id === pc.keyId)).toHaveLength(1);
    expect(JSON.stringify(app.db.prepare('SELECT * FROM audit_events').all())).not.toContain(pc.key);
    const f = await file(pc.key);
    expect(f.status).toBe(200);
    const second = await file(pc.key);
    expect(second.status).toBe(409);
    expect(second.body.message).toContain(f.body.request_id);
    expect(actions('onboarding.request_refused_pending').filter((a) => a.target_id === f.body.request_id).map((a) => JSON.parse(a.details))).toEqual([{ app_key: expect.any(String) }]);
  });
});

describe('a delegate\'s prompt', () => {
  it('opens (audited), opens again until the restore picks up the key, then answers prompt_in_use; an uncopied handout is cleared after the cap', async () => {
    // A team onboarded the real way from its own PC.
    const src = await enrol('dsrc-pc');
    const f = await file(src.key, { project: { name: `Lend ${++proj}`, existing: false }, team: { name: `Lenders ${proj}`, goal: 'Lend the work.' } });
    expect((await api('POST', `/onboarding/${f.body.request_id}/approve`, { version: f.body.version })).status).toBe(200);
    const p = await call('POST', '/onboard/pickup', src.key, { request_id: f.body.request_id });
    const c = await call('POST', '/onboard/pickup/confirm', src.key, { pickup_id: p.body.pickup_id, written: vars(p) });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const teamId = c.body.team_id as string;
    const dev = app.teams.members(teamId).find((m) => m.role === 'worker')!.agent_id;
    // A member with a grant that delegates the team, signed in with their own password.
    const u = await api('POST', '/users', { username: 'lena', display_name: 'Lena', role: 'member' });
    expect(u.status, JSON.stringify(u.body)).toBe(200);
    const lr = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'lena', password: u.body.password }) });
    const lena: Sess = { cookie: lr.headers.get('set-cookie')!.split(';')[0]!, csrf: ((await lr.json()) as any).csrf };
    const prj = (app.db.prepare('SELECT project_id p FROM teams WHERE id=?').get(teamId) as { p: string }).p;
    expect((await api('PUT', `/users/${u.body.user.id}/grants`, { grants: [{ project_id: prj, components: ['tasks', 'messages', 'blueprint'], delegation: { teams: [teamId] } }] })).status).toBe(200);
    const target = await enrol('lena-pc');
    const d = await api('POST', `/agents/${dev}/delegate`, { user_id: u.body.user.id, machine_id: target.id });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    const id = d.body.delegation.id as string;
    // The agent checkpoints and writes its handout.
    const head = (x: string) => x.repeat(40);
    app.checkouts.checkpointing(dev);
    app.checkouts.merged(dev, { integration_branch: 'integration/core', integration_head: head('a'), merge_commits: [head('e')], worktrees_left: 0, clean: true,
      leftover_check: { worktrees: [], unmerged_branches: [], uncommitted_files: [], build_output: [], scratch: [], processes: [] } });
    app.checkouts.write(dev, { folder: 'core-dev', notes: 'Next: the parser.', repo: { remote_name: 'origin', url: 'git@git.example.org:team/core.git', clone_folder: 'core' },
      provider_was: { provider: 'claude_code', model: 'opus', permissions: 'acceptEdits' } });
    const open = () => as(lena, 'POST', `/me/delegations/${id}/prompt`);
    const o1 = await open();
    expect(o1.status, JSON.stringify(o1.body)).toBe(200);
    expect(JSON.stringify(o1.body)).not.toMatch(KEY_RE);
    expect(actions('checkout.prompt_opened').filter((a) => a.target_id === id).map((a) => JSON.parse(a.details))).toEqual([{ agent: dev }]);
    // Opened again before the restore started: rendered again.
    expect((await open()).status).toBe(200);
    expect(actions('checkout.prompt_opened').filter((a) => a.target_id === id)).toHaveLength(2);
    // The restore on Lena's PC picks the key up (not yet confirmed): the prompt is in use.
    const req = app.checkouts.checkout(id)!.request_id!;
    scanClean(app.db, req);
    const rp = await call('POST', '/onboard/pickup', target.key, { request_id: req });
    expect(rp.status, JSON.stringify(rp.body)).toBe(200);
    const o3 = await open();
    expect(o3.status).toBe(409);
    expect(o3.body.error).toBe('prompt_in_use');
    expect(actions('checkout.prompt_opened').filter((a) => a.target_id === id)).toHaveLength(2);
    expect((await as(lena, 'GET', '/me/delegations')).body.delegations.find((x: { id: string }) => x.id === id).prompt_available).toBe(false);

    // The deferred purge: a handout body never copied to the vault is cleared 7 days after it was due, and audited.
    const h = app.db.prepare('SELECT id, version FROM handouts WHERE checkout_id=? AND body IS NOT NULL').get(id) as { id: string; version: number } | undefined;
    expect(h, 'a handout with its body').toBeTruthy();
    app.db.prepare('DELETE FROM mirror_files WHERE kind=\'handout\' AND ref_id=?').run(h!.id);
    app.db.prepare('UPDATE handouts SET purge_due=? WHERE id=?').run(Date.now() - PURGE_CAP_MS - 1000, h!.id);
    const out = app.mirror.purge();
    expect(out.capped).toContain(h!.id);
    expect((app.db.prepare('SELECT body FROM handouts WHERE id=?').get(h!.id) as { body: string | null }).body).toBeNull();
    expect(actions('checkout.handout_purged_uncopied').filter((a) => a.target_id === h!.id).map((a) => JSON.parse(a.details))).toEqual([{ checkout: id, agent: dev }]);
  });
});

describe('a vault agent and its owner', () => {
  it('the owner\'s grant lowered to Read refuses the agent\'s next edit', async () => {
    const u = await api('POST', '/users', { username: 'dana', role: 'member' });
    const dana = u.body.user.id as string;
    expect((await api('PUT', `/users/${dana}/folder-grants`, { grants: [{ path: '/Shared/Team/', mode: 'contribute' }] })).status).toBe(200);
    const pc = await enrol('dana-pc');
    const f = await call('POST', '/onboard/requests', pc.key, { kind: 'vault_agent', agent: { name: 'Dana notes', job: 'Keeps the plan.' }, folders: [{ path: '/vault/Shared/Team', access: 'write' }], prompt: 'an agent for my notes' });
    expect(f.status, JSON.stringify(f.body)).toBe(200);
    expect((await api('POST', `/onboarding/${f.body.request_id}/approve`, { version: f.body.version, owner_id: dana })).status).toBe(200);
    const p = await call('POST', '/onboard/pickup', pc.key, { request_id: f.body.request_id });
    expect((await call('POST', '/onboard/pickup/confirm', pc.key, { pickup_id: p.body.pickup_id, written: vars(p) })).status).toBe(200);
    expect((await api('POST', '/agent-owners/claim')).status).toBe(200);
    expect((await api('PUT', '/agent-owners/enforcement', { on: true })).body.enforcement).toBe(true);
    const A = (await mcp(pc.key, p.body.agents[0].secret))!;
    const r = await A('file_read', { path: '/vault/Shared/Team/plan.md' });
    expect(r.isError, JSON.stringify(r)).toBeFalsy();
    const ok = await A('file_update', { path: '/vault/Shared/Team/plan.md', content: '# Plan v2\n', base_revision: r.structuredContent.revision });
    expect(ok.isError, JSON.stringify(ok)).toBeFalsy();
    // Lowered to Read (not removed): the next edit is refused; reading goes on.
    const low = await api('PUT', `/users/${dana}/folder-grants`, { grants: [{ path: '/Shared/Team/', mode: 'read' }] });
    expect(low.status, JSON.stringify(low.body)).toBe(200);
    const denied = await A('file_update', { path: '/vault/Shared/Team/plan.md', content: '# Plan v3\n', base_revision: ok.structuredContent.revision });
    expect(denied.isError).toBe(true);
    expect((await A('file_read', { path: '/vault/Shared/Team/plan.md' })).isError).toBeFalsy();
  });
});
