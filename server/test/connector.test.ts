/**
 * The connector's hub side (docs/connector.md, "Hub route contract"): every value reads Unknown until a connector reports it;
 * check-in, versions and their approval; PC actions as stored orders fetched once; Disconnect revokes access at once and
 * hands its receipt credential only to the PC's own refused key; messages shown on the PC; usage only after opt-in and
 * priced only from a configured list price; the setup timeline names one next action and who takes it.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { testConfig, adminLogin } from './hub.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const sys = { kind: 'system' as const, id: null };
let app: App, base: string, cookie = '', csrf = '';

const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const cn = async (method: string, path: string, key: string | null, body?: unknown) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  const r = await fetch(`${base}/connector/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const newPc = async (name: string) => {
  const id = (await api('POST', '/pcs', { name })).body.pc.id as string;
  return { id, key: app.keys.createAppKey({ machineId: id, appName: 'claude-code', maxLiveSessions: 10 }, sys).secret };
};
const pcOf = async (id: string) => (await api('GET', '/pcs')).body.pcs.find((p: any) => p.id === id);
const report = { version: '1.4.0', platform: 'win32-x64', node: '22.11.0', git: '2.47.1', clients: [{ client: 'claude_code', version: '2.0.31' }], auto_update: true, remote_cleanup: true };

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahconn-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  const config: Config = testConfig(dir, { maintenanceSeconds: undefined, connectorPrices: { 'model-a': { input: 3, output: 15 } } });
  app = await buildApp(config);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base));
});
afterAll(async () => { await app.close(); });

describe('check-in and PC status', () => {
  it('reads Unknown until a connector reports, then Online with its versions', async () => {
    const pc = await newPc('conn-status');
    const before = (await pcOf(pc.id)).connector;
    expect(before).toMatchObject({ online: false, status: 'never', version: null, node: null, git: null, clients: [], remote_cleanup: null, version_status: null });
    expect((await pcOf(pc.id)).disconnect).toBeNull();
    const r = await cn('POST', '/check-in', pc.key, report);
    expect(r).toEqual({ status: 200, body: { ok: true, orders: 0, handovers: 0, ignored_agents: 0 } });
    const after = (await pcOf(pc.id)).connector;
    expect(after).toMatchObject({ online: true, status: 'online', version: '1.4.0', node: '22.11.0', git: '2.47.1', auto_update: true, remote_cleanup: true, usage_opt_in: null, version_status: 'pending' });
    expect(after.clients).toEqual([{ client: 'claude_code', version: '2.0.31' }]);
  });
  it('shows Offline since the latest check-in once 90 seconds pass', async () => {
    const pc = await newPc('conn-offline');
    await cn('POST', '/check-in', pc.key, report);
    app.db.prepare('UPDATE connector_reports SET last_check_in_at=? WHERE machine_id=?').run(Date.now() - 91_000, pc.id);
    expect((await pcOf(pc.id)).connector).toMatchObject({ online: false, status: 'offline' });
  });
  it('refuses a missing or wrong key, an unknown field and a malformed version', async () => {
    const pc = await newPc('conn-refuse');
    expect((await cn('POST', '/check-in', null, report)).status).toBe(401);
    expect((await cn('POST', '/check-in', 'ah_app_aaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', report)).status).toBe(401);
    expect((await cn('POST', '/check-in', pc.key, { ...report, shell: 'rm -rf /' })).status).toBe(400);
    expect((await cn('POST', '/check-in', pc.key, { ...report, version: '1.4; echo' })).status).toBe(400);
    expect((await cn('POST', '/check-in', pc.key, { ...report, clients: [{ client: 'vim', version: '9' }] })).status).toBe(400);
  });
  it('a suspended PC is refused and reads Access suspended, not Offline since', async () => {
    const pc = await newPc('conn-susp');
    await cn('POST', '/check-in', pc.key, report);
    await api('POST', `/pcs/${pc.id}/suspend`);
    const r = await cn('POST', '/check-in', pc.key, report);
    expect(r.status).toBe(401);
    expect(r.body.receipt).toBeUndefined();
    expect((await pcOf(pc.id)).connector).toMatchObject({ online: false, status: 'suspended' });
  });
  it("reports only the PC's own agents, and only the PC's own facts", async () => {
    const pc = await newPc('conn-agents'), other = await newPc('conn-agents-x');
    const mine = app.keys.createAgent('own worker', null, sys), theirs = app.keys.createAgent('their worker', null, sys);
    app.keys.createSessionKey({ agentId: mine.id, label: 'k', machineId: pc.id }, sys);
    app.keys.createSessionKey({ agentId: theirs.id, label: 'k', machineId: other.id }, sys);
    const r = await cn('POST', '/check-in', pc.key, { ...report, agents: [{ agent_id: mine.id, state: 'chat_in_use' }, { agent_id: theirs.id, state: 'open' }] });
    expect(r.body).toMatchObject({ ok: true, ignored_agents: 1 });
    expect(JSON.parse((app.db.prepare('SELECT agents FROM connector_reports WHERE machine_id=?').get(pc.id) as any).agents)).toEqual([{ agent_id: mine.id, state: 'chat_in_use' }]);
    for (const state of ['waiting_for_approval', 'ready_to_open']) {
      expect((await cn('POST', '/check-in', pc.key, { ...report, agents: [{ agent_id: mine.id, state }] })).status).toBe(400); // the hub's states
    }
  });
  it("keeps the account profile a PC reports for a run, or only that it is hidden, and the agent page gets it", async () => {
    const pc = await newPc('conn-profile');
    const ag = app.keys.createAgent('profiled worker', null, sys);
    app.keys.createSessionKey({ agentId: ag.id, label: 'k', machineId: pc.id }, sys);
    const prof = async () => (await api('GET', `/sessions/${ag.id}`)).body.pc_profile;
    expect(await prof()).toBeNull(); // never reported
    expect((await cn('POST', '/check-in', pc.key, { ...report, agents: [{ agent_id: ag.id, state: 'open', profile: 'work' }] })).status).toBe(200);
    expect(await prof()).toEqual({ name: 'work' });
    expect((await cn('POST', '/check-in', pc.key, { ...report, agents: [{ agent_id: ag.id, state: 'open', profile_hidden: true }] })).status).toBe(200);
    expect(await prof()).toEqual({ hidden: true });
    expect((await cn('POST', '/check-in', pc.key, { ...report, agents: [{ agent_id: ag.id, state: 'open' }] })).status).toBe(200);
    expect(await prof()).toBeNull(); // a chat opened by hand
    // Never an address or anything but the flag.
    expect((await cn('POST', '/check-in', pc.key, { ...report, agents: [{ agent_id: ag.id, state: 'open', profile: 'me@example.com' }] })).status).toBe(400);
    expect((await cn('POST', '/check-in', pc.key, { ...report, agents: [{ agent_id: ag.id, state: 'open', profile_hidden: false }] })).status).toBe(400);
  });
  it('the bridge key may check in during the transition, and nothing else', async () => {
    const pc = await newPc('conn-bridge');
    const sk = app.setup.createSetupKey(pc.id, sys);
    const code = app.setup.setupPc(app.setup.verifySetupKey(sk.secret, pc.id), { os: 'windows', proposedFolders: [], part: 0 }).pairing_code!;
    const brg = app.setup.pair(code, 'win32', '0.2.0').bridgeKey;
    expect((await cn('POST', '/check-in', brg, report)).status).toBe(200);
    for (const [m, p] of [['GET', '/orders'], ['GET', '/versions/approved'], ['GET', '/disconnect']] as const) expect((await cn(m, p, brg)).status).toBe(401);
    await api('POST', `/pcs/${pc.id}/disconnect`, {});
    const after = await cn('POST', '/check-in', brg, report);
    expect(after.status).toBe(401);
    expect(after.body.receipt).toBeUndefined(); // never handed a receipt
    expect((app.db.prepare('SELECT status FROM bridge_keys WHERE machine_id=?').get(pc.id) as any).status).toBe('revoked');
  });
});

describe('connector versions', () => {
  it('a version first seen is pending with one alert; approving it offers the update and allows the order', async () => {
    const pc = await newPc('conn-ver');
    await cn('POST', '/check-in', pc.key, { ...report, version: '2.0.0' });
    await cn('POST', '/check-in', pc.key, { ...report, version: '2.0.0' });
    expect(app.db.prepare("SELECT COUNT(*) n FROM security_alerts WHERE type='connector_version_pending' AND subject='2.0.0' AND status='open'").get()).toEqual({ n: 1 });
    expect((await api('POST', `/pcs/${pc.id}/actions`, { kind: 'update', version: '2.1.0' })).status).toBe(409); // unknown: not approved
    expect((await api('POST', '/connector/versions', { version: '2.1.0' })).body.version).toMatchObject({ version: '2.1.0', status: 'pending' });
    expect((await api('POST', '/connector/versions', { version: 'latest' })).status).toBe(400);
    expect((await api('POST', '/connector/versions/2.1.0/approve')).body.version).toMatchObject({ status: 'approved', decided_by: expect.stringMatching(/^operator:/) });
    expect((await pcOf(pc.id)).connector.update_available).toBe('2.1.0');
    expect((await cn('GET', '/versions/approved', pc.key)).body.versions).toContain('2.1.0');
    expect((await api('POST', `/pcs/${pc.id}/actions`, { kind: 'update', version: '2.1.0' })).body.action).toMatchObject({ kind: 'update', state: 'queued', payload: { version: '2.1.0' } });
    await api('POST', '/connector/versions/2.0.0/refuse');
    expect(app.db.prepare("SELECT COUNT(*) n FROM security_alerts WHERE type='connector_version_pending' AND subject='2.0.0' AND status='open'").get()).toEqual({ n: 0 });
    const list = (await api('GET', '/connector/versions')).body.versions;
    expect(list.find((v: any) => v.version === '2.0.0')).toMatchObject({ status: 'refused', pcs: 1 });
    expect(app.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='connector.version_approve'").get()).toEqual({ n: 1 });
  });
  it('refuses a downgrade, and a report creates a pending version only above the newest approved, at most 5 waiting', async () => {
    const pc = await newPc('conn-ver-down');
    await api('POST', '/connector/versions', { version: '1.9.0' });
    await api('POST', '/connector/versions/1.9.0/approve');
    await cn('POST', '/check-in', pc.key, { ...report, version: '2.0.0' });
    const down = await api('POST', `/pcs/${pc.id}/actions`, { kind: 'update', version: '1.9.0' });
    expect(down.status).toBe(400);
    expect(down.body.message).toMatch(/no downgrades/);
    await cn('POST', '/check-in', pc.key, { ...report, version: '0.9.0' });
    expect(app.db.prepare("SELECT 1 FROM connector_versions WHERE version='0.9.0'").get()).toBeUndefined();
    for (let i = 0; i < 8; i++) await cn('POST', '/check-in', pc.key, { ...report, version: `9.0.${i}` });
    expect((app.db.prepare("SELECT COUNT(*) n FROM connector_versions WHERE status='pending'").get() as any).n).toBe(5);
    for (const v of (await api('GET', '/connector/versions')).body.versions.filter((x: any) => x.status === 'pending')) await api('POST', `/connector/versions/${v.version}/refuse`);
  });
});

describe('PC actions', () => {
  it('Check this PC is stored, fetched once on the poll, and its bounded result is kept', async () => {
    const pc = await newPc('conn-check');
    const a = (await api('POST', `/pcs/${pc.id}/actions`, { kind: 'check' })).body.action;
    expect(a).toMatchObject({ kind: 'check', state: 'queued', created_by: expect.stringMatching(/^operator:/) });
    expect((await api('POST', `/pcs/${pc.id}/actions`, { kind: 'check' })).status).toBe(409); // one open order per kind
    expect((await cn('POST', '/check-in', pc.key, report)).body.orders).toBe(1);
    const got = (await cn('GET', '/orders', pc.key)).body.orders;
    expect(got).toEqual([{ id: a.id, kind: 'check', payload: {} }]);
    expect((await cn('GET', '/orders', pc.key)).body.orders).toEqual([]); // one-time
    const tooMany = { checks: Array.from({ length: 41 }, (_, i) => ({ name: `c${i}`, ok: true })) };
    expect((await cn('POST', `/orders/${a.id}/result`, pc.key, { state: 'done', result: tooMany })).status).toBe(400);
    expect((await cn('POST', `/orders/${a.id}/result`, pc.key, { state: 'done', result: { checks: [{ name: 'node', ok: true, detail: '22.11.0' }] } })).status).toBe(200);
    expect((await cn('POST', `/orders/${a.id}/result`, pc.key, { state: 'done', result: { checks: [] } })).status).toBe(404); // one result per order
    expect((await api('GET', `/pcs/${pc.id}/actions`)).body.actions[0]).toMatchObject({ state: 'done', result: { checks: [{ name: 'node', ok: true }] } });
    expect(app.db.prepare("SELECT action FROM audit_events WHERE action LIKE 'pc.action_%' ORDER BY rowid").all().map((r: any) => r.action)).toEqual(expect.arrayContaining(['pc.action_create', 'pc.action_report']));
  });
  it("another PC's key cannot fetch or report the order", async () => {
    const pc = await newPc('conn-own'), other = await newPc('conn-other');
    const a = (await api('POST', `/pcs/${pc.id}/actions`, { kind: 'check' })).body.action;
    expect((await cn('GET', '/orders', other.key)).body.orders).toEqual([]);
    await cn('GET', '/orders', pc.key);
    expect((await cn('POST', `/orders/${a.id}/result`, other.key, { state: 'failed' })).status).toBe(404);
  });
  it('an order fetched but never reported expires after 24 hours, and a new one of that kind can be made', async () => {
    const pc = await newPc('conn-lost');
    const a = (await api('POST', `/pcs/${pc.id}/actions`, { kind: 'check' })).body.action;
    await cn('GET', '/orders', pc.key);
    expect((await api('POST', `/pcs/${pc.id}/actions`, { kind: 'check' })).status).toBe(409);
    app.db.prepare('UPDATE pc_actions SET fetched_at=? WHERE id=?').run(Date.now() - 24 * 60 * 60_000 - 1, a.id);
    app.connector.tick(); // expiry runs on the timer, not on each request
    const lost = (await api('GET', `/pcs/${pc.id}/actions`)).body.actions.find((x: any) => x.id === a.id);
    expect(lost).toMatchObject({ state: 'expired', finished_at: expect.any(Number), result: { reason: expect.stringMatching(/did not report a result within 24 hours/) } });
    expect((await api('POST', `/pcs/${pc.id}/actions`, { kind: 'check' })).status).toBe(200);
    expect((await cn('POST', `/orders/${a.id}/result`, pc.key, { state: 'done', result: { checks: [] } })).status).toBe(404); // too late
  });
  it('usage rows and check-in text pass the leak guard too', async () => {
    const pc = await newPc('conn-leak-usage');
    const shaped = ['ah', 'ses', 'c'.repeat(12), 'd'.repeat(32)].join('_');
    expect(await cn('POST', '/check-in', pc.key, { ...report, usage_opt_in: true, agents: [{ agent_id: shaped, state: 'open' }] })).toMatchObject({ status: 400, body: { error: 'contains_key' } });
    expect(await cn('POST', '/check-in', pc.key, { ...report, usage_opt_in: true })).toMatchObject({ status: 200 });
    const ag = app.keys.createAgent('leak worker', null, sys);
    app.keys.createSessionKey({ agentId: ag.id, label: 'k', machineId: pc.id }, sys);
    const row = { agent_id: ag.id, client: 'claude_code', model: shaped, input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, sessions: 1 };
    expect(await cn('POST', '/usage', pc.key, { day: new Date().toISOString().slice(0, 10), rows: [row] })).toMatchObject({ status: 400, body: { error: 'contains_key' } });
    expect(app.db.prepare('SELECT COUNT(*) n FROM connector_usage WHERE machine_id=?').get(pc.id)).toEqual({ n: 0 });
    expect(app.db.prepare("SELECT COUNT(*) n FROM security_alerts WHERE type='connector_key_in_report' AND subject=?").get(pc.id)).toEqual({ n: 1 }); // one open alert per PC, not one per report
  });
  it('text from the PC passes the leak guard: a key shape is refused with an alert, other secrets are redacted', async () => {
    const pc = await newPc('conn-leak');
    const a = (await api('POST', `/pcs/${pc.id}/actions`, { kind: 'check' })).body.action;
    await cn('GET', '/orders', pc.key);
    const shaped = ['ah', 'app', 'a'.repeat(12), 'b'.repeat(32)].join('_');
    const bad = await cn('POST', `/orders/${a.id}/result`, pc.key, { state: 'done', result: { checks: [{ name: 'env', ok: false, detail: `found ${shaped}` }] } });
    expect(bad).toMatchObject({ status: 400, body: { error: 'contains_key' } });
    expect(app.db.prepare("SELECT COUNT(*) n FROM security_alerts WHERE type='connector_key_in_report' AND subject=?").get(pc.id)).toEqual({ n: 1 });
    const gh = 'ghp_' + 'x'.repeat(30);
    expect((await cn('POST', `/orders/${a.id}/result`, pc.key, { state: 'done', result: { checks: [{ name: 'git', ok: false, detail: `token ${gh} in .gitconfig` }] } })).status).toBe(200);
    expect((await api('GET', `/pcs/${pc.id}/actions`)).body.actions[0].result.checks[0].detail).toBe('token [redacted] in .gitconfig');
  });
  it('Restore needs a checkout whose prompt is ready and that targets this PC; an unknown kind is refused', async () => {
    const pc = await newPc('conn-restore');
    expect((await api('POST', `/pcs/${pc.id}/actions`, { kind: 'restore', checkout_id: 'chk_nope' })).status).toBe(404);
    expect((await api('POST', `/pcs/${pc.id}/actions`, { kind: 'run', command: 'whoami' })).status).toBe(400);
    expect((await api('POST', `/pcs/${pc.id}/actions`, { kind: 'disconnect' })).status).toBe(400); // only through its own route
  });
  it('Restore goes only to a destination the PC user approved there, named by its id, never a path', async () => {
    const pc = await newPc('conn-restore-dest'), other = await newPc('conn-restore-other');
    const lead = app.keys.createAgent('restore lead', null, sys);
    app.keys.createSessionKey({ agentId: lead.id, label: 'lead' }, sys);
    const team = app.teams.create({ name: 'Restore dest team', goal: 'Move house', members: [{ agent_id: lead.id, role: 'coordinator' }] }, sys);
    const now = Date.now(), cko = 'cko_restoredest1';
    app.db.prepare("INSERT INTO checkouts(id,team_id,status,target_machine_id,created_at,updated_at,expires_at) VALUES (?,?,'rendered',?,?,?,?)").run(cko, team.id, pc.id, now, now, now + 86400_000);
    const restore = (destination_id?: string) => api('POST', `/pcs/${pc.id}/actions`, { kind: 'restore', checkout_id: cko, ...(destination_id ? { destination_id } : {}) });
    // Nothing reported yet: Unknown, and Restore is refused.
    expect((await pcOf(pc.id)).connector.destinations).toBeNull();
    expect(await restore('dst_home01')).toMatchObject({ status: 409, body: { error: 'invalid_state', message: expect.stringMatching(/approved on that PC/) } });
    // A path or a malformed id is refused before anything is stored, on both sides.
    expect((await restore('C:\\Users\\x\\repo')).status).toBe(400);
    expect((await cn('POST', '/check-in', pc.key, { ...report, destinations: [{ id: 'C:/Users/x', label: 'x' }] })).status).toBe(400);
    expect((await cn('POST', '/check-in', pc.key, { ...report, destinations: [{ id: 'dst_home01', label: 'a' }, { id: 'dst_home01', label: 'b' }] })).status).toBe(400);
    expect((await cn('POST', '/check-in', pc.key, { ...report, destinations: [{ id: 'dst_home01', label: 'Projects on D:', path: 'D:/p' }] })).status).toBe(400);
    // The PC's user approved one destination: the console sees its id and label. (Not rendered at this check-in: a rendered checkout gets its Restore from it, see team-start.test.ts.)
    app.db.prepare("UPDATE checkouts SET status='ready' WHERE id=?").run(cko);
    expect((await cn('POST', '/check-in', pc.key, { ...report, destinations: [{ id: 'dst_home01', label: 'Projects on D:' }] })).status).toBe(200);
    expect((await pcOf(pc.id)).connector.destinations).toEqual([{ id: 'dst_home01', label: 'Projects on D:' }]);
    expect((await restore()).status).toBe(409); // no destination named
    expect((await restore('dst_other1')).status).toBe(409); // one the user did not approve
    // Another PC's approved destination does not count for this PC.
    await cn('POST', '/check-in', other.key, { ...report, destinations: [{ id: 'dst_away001', label: 'Elsewhere' }] });
    expect((await restore('dst_away001')).status).toBe(409);
    app.db.prepare("UPDATE checkouts SET status='rendered' WHERE id=?").run(cko);
    const ok = await restore('dst_home01');
    expect(ok.status).toBe(200);
    expect(ok.body.action).toMatchObject({ kind: 'restore', state: 'queued', payload: { checkout_id: cko, destination_id: 'dst_home01' } });
    expect((await cn('GET', '/orders', pc.key)).body.orders).toEqual([{ id: ok.body.action.id, kind: 'restore', payload: { checkout_id: cko, destination_id: 'dst_home01' } }]);
    // A check-in that no longer reports destinations reads Unknown again.
    await cn('POST', '/check-in', pc.key, report);
    expect((await pcOf(pc.id)).connector.destinations).toBeNull();
  });
  it('a restore order stays open while its checkout is rendered or restoring, takes progress notes and start lines, and ends when the checkout is cancelled', async () => {
    const pc = await newPc('conn-restore-life');
    const lead = app.keys.createAgent('life lead', null, sys);
    app.keys.createSessionKey({ agentId: lead.id, label: 'lead' }, sys);
    const team = app.teams.create({ name: 'Restore life team', goal: 'Move house', members: [{ agent_id: lead.id, role: 'coordinator' }] }, sys);
    const now = Date.now(), cko = 'cko_restorelife1';
    app.db.prepare("INSERT INTO checkouts(id,team_id,status,target_machine_id,created_at,updated_at,expires_at) VALUES (?,?,'ready',?,?,?,?)").run(cko, team.id, pc.id, now, now, now + 86400_000);
    await cn('POST', '/check-in', pc.key, { ...report, destinations: [{ id: 'dst_life0001', label: 'Life' }] });
    app.db.prepare("UPDATE checkouts SET status='rendered' WHERE id=?").run(cko);
    const o = (await api('POST', `/pcs/${pc.id}/actions`, { kind: 'restore', checkout_id: cko, destination_id: 'dst_life0001' })).body.action;
    expect((await cn('GET', '/orders', pc.key)).body.orders.map((x: { id: string }) => x.id)).toEqual([o.id]);
    expect((await cn('POST', `/orders/${o.id}/progress`, pc.key, { note: 'Waiting for the PC user to approve the folder.' })).status).toBe(200);
    const clock = (t: number) => app.db.prepare('UPDATE pc_actions SET expires_at=? WHERE id=?').run(t, o.id);
    clock(Date.now() - 1); // the clock alone never ends a restore
    expect((await api('GET', `/pcs/${pc.id}/actions`)).body.actions[0]).toMatchObject({ state: 'fetched', result: { progress: 'Waiting for the PC user to approve the folder.' } });
    app.db.prepare("UPDATE checkouts SET status='restoring' WHERE id=?").run(cko);
    expect((await api('GET', `/pcs/${pc.id}/actions`)).body.actions[0].state).toBe('fetched');
    expect((await cn('POST', `/orders/${o.id}/result`, pc.key, { state: 'done', result: { start_lines: ["cd '/x/y' && claude 'hi'"] } })).status).toBe(200);
    expect((await api('GET', `/pcs/${pc.id}/actions`)).body.actions[0]).toMatchObject({ state: 'done', result: { start_lines: ["cd '/x/y' && claude 'hi'"] } });
    // A second restore, then the checkout is cancelled: the order ends with the reason.
    app.db.prepare("UPDATE checkouts SET status='rendered' WHERE id=?").run(cko);
    const o2 = (await api('POST', `/pcs/${pc.id}/actions`, { kind: 'restore', checkout_id: cko, destination_id: 'dst_life0001' })).body.action;
    await cn('GET', '/orders', pc.key);
    app.db.prepare("UPDATE checkouts SET status='cancelled' WHERE id=?").run(cko);
    app.connector.tick();
    const ended = (await api('GET', `/pcs/${pc.id}/actions`)).body.actions.find((x: { id: string }) => x.id === o2.id);
    expect(ended.state).toBe('expired');
    expect(JSON.stringify(ended)).toMatch(/The checkout ended/);
    expect((await cn('POST', `/orders/${o2.id}/progress`, pc.key, { note: 'late' })).status).toBeGreaterThanOrEqual(404); // gone: the worker finishes its state on 404 or 409
  });
  it('a destination label passes the leak guard like every other text from the PC', async () => {
    const pc = await newPc('conn-dest-leak');
    const shaped = ['ah', 'app', 'e'.repeat(12), 'f'.repeat(32)].join('_');
    expect(await cn('POST', '/check-in', pc.key, { ...report, destinations: [{ id: 'dst_leak001', label: shaped }] })).toMatchObject({ status: 400, body: { error: 'contains_key' } });
  });
  it('an order not fetched within a day expires', async () => {
    const pc = await newPc('conn-expire');
    const a = (await api('POST', `/pcs/${pc.id}/actions`, { kind: 'check' })).body.action;
    app.db.prepare('UPDATE pc_actions SET expires_at=? WHERE id=?').run(Date.now() - 1, a.id);
    app.connector.tick();
    expect((await api('GET', `/pcs/${pc.id}/actions`)).body.actions[0].state).toBe('expired');
    expect((await cn('GET', '/orders', pc.key)).body.orders).toEqual([]);
  });
});

describe('Disconnect this hub from this PC', () => {
  it('revokes access at once, lists what is removed and kept, and never shows the receipt to the console', async () => {
    const pc = await newPc('conn-dsc');
    await cn('POST', '/check-in', pc.key, report);
    const chk = (await api('POST', `/pcs/${pc.id}/actions`, { kind: 'check' })).body.action;
    const r = await api('POST', `/pcs/${pc.id}/disconnect`, {});
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain('ah_dsc_');
    expect(r.body.disconnect).toMatchObject({ state: 'access_revoked', remote_cleanup: true });
    expect(r.body.disconnect.keeps).toContain('Repositories and worktrees');
    expect(r.body.disconnect.removes).toContain("This hub's keys on the PC");
    expect(r.body.disconnect.removes[0]).toBe("This hub's worker and transfers, stopped first");
    const p = await pcOf(pc.id);
    expect(p.status).toBe('suspended');
    expect(p.connector.status).toBe('disconnected');
    expect((await api('POST', `/pcs/${pc.id}/reactivate`)).status).toBe(409); // only Re-enrol PC brings it back
    expect(p.disconnect.state).toBe('access_revoked');
    expect((await api('GET', `/pcs/${pc.id}/actions`)).body.actions.find((a: any) => a.id === chk.id).state).toBe('expired');
    expect((await api('POST', `/pcs/${pc.id}/disconnect`, {})).status).toBe(409);

    // The PC's own key: refused for everything, answered with the receipt only.
    const refused = await cn('POST', '/check-in', pc.key, report);
    expect(refused.status).toBe(401);
    expect(refused.body.error).toBe('disconnected');
    expect(refused.body.receipt).toMatch(/^ah_dsc_[a-z2-7]{12}_[a-z2-7]{32}$/);
    // A lost answer: calling again issues a fresh receipt and the old one stops working.
    const again = (await cn('GET', '/orders', pc.key)).body.receipt;
    expect(again).not.toBe(refused.body.receipt);
    expect((await cn('GET', '/disconnect', refused.body.receipt)).status).toBe(401);
    // The receipt fetches the order only; it is not an app key.
    expect((await cn('POST', '/check-in', again, report)).status).toBe(401);
    const order = (await cn('GET', '/disconnect', again)).body.order;
    expect(order).toMatchObject({ kind: 'disconnect', remote_cleanup: true });
    expect((await pcOf(pc.id)).disconnect.state).toBe('cleanup_pending');
    expect((await cn('POST', '/disconnect/result', again, { state: 'removed', left: ['C:/x', 'y'.repeat(201)] })).status).toBe(400);
    expect((await cn('POST', '/disconnect/result', again, { state: 'removed' })).status).toBe(200);
    expect((await pcOf(pc.id)).disconnect.state).toBe('removed');
    // After the receipt the credential is retired, and the PC's key gets no new one.
    expect((await cn('GET', '/disconnect', again)).status).toBe(401);
    expect((await cn('POST', '/check-in', pc.key, report)).body.receipt).toBeUndefined();
    expect(app.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='pc.disconnect' AND target_id=?").get(pc.id)).toEqual({ n: 1 });
    // The receipt never reaches the audit; a retired one keeps no verifier.
    expect(JSON.stringify(app.db.prepare("SELECT * FROM audit_events WHERE target_id=?").all(pc.id))).not.toContain('ah_dsc_');
    expect((app.db.prepare("SELECT receipt_verifier v FROM pc_actions WHERE machine_id=? AND kind='disconnect'").get(pc.id) as any).v).toBeNull();
  });
  it('Re-enrol PC ends a disconnect: the receipt is retired and the PC is active again', async () => {
    const pc = await newPc('conn-dsc-reenrol');
    await api('POST', `/pcs/${pc.id}/disconnect`, {});
    const receipt = (await cn('POST', '/check-in', pc.key, report)).body.receipt;
    expect((await api('POST', `/pcs/${pc.id}/re-enrol`)).status).toBe(200);
    expect((await cn('GET', '/disconnect', receipt)).status).toBe(401);
    const p = await pcOf(pc.id);
    expect(p.status).toBe('active');
    expect(p.connector.status).not.toBe('disconnected');
    expect(p.disconnect.ended_at).toEqual(expect.any(Number));
    expect(app.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='pc.disconnect_end' AND target_id=?").get(pc.id)).toEqual({ n: 1 });
  });
  it('Needs attention when the connector reports a failure, with what is left', async () => {
    const pc = await newPc('conn-dsc-fail');
    await api('POST', `/pcs/${pc.id}/disconnect`, {});
    const receipt = (await cn('POST', '/check-in', pc.key, report)).body.receipt;
    await cn('GET', '/disconnect', receipt);
    await cn('POST', '/disconnect/result', receipt, { state: 'needs_attention', left: ['A worktree had local changes, so it was kept.'] });
    expect((await pcOf(pc.id)).disconnect).toMatchObject({ state: 'needs_attention', left: ['A worktree had local changes, so it was kept.'] });
  });
  it('Needs attention when nothing fetched the order in 7 days, and no receipt is handed out after that', async () => {
    const pc = await newPc('conn-dsc-late');
    await api('POST', `/pcs/${pc.id}/disconnect`, {});
    const receipt = (await cn('POST', '/check-in', pc.key, report)).body.receipt;
    app.db.prepare("UPDATE pc_actions SET expires_at=? WHERE kind='disconnect' AND machine_id=?").run(Date.now() - 1, pc.id);
    expect((await pcOf(pc.id)).disconnect.state).toBe('needs_attention');
    expect((await cn('GET', '/disconnect', receipt)).status).toBe(401);
    const late = await cn('POST', '/check-in', pc.key, report);
    expect(late.status).toBe(401);
    expect(late.body.receipt).toBeUndefined();
  });
  it('cleanup turned off on the PC ends the order at Access revoked, said as such', async () => {
    const off = await newPc('conn-dsc-off');
    await cn('POST', '/check-in', off.key, { ...report, remote_cleanup: false });
    await api('POST', `/pcs/${off.id}/disconnect`, {});
    const receipt = (await cn('POST', '/check-in', off.key, report)).body.receipt;
    expect((await cn('GET', '/disconnect', receipt)).body.order).toMatchObject({ remote_cleanup: false });
    expect((await cn('POST', '/disconnect/result', receipt, { state: 'cleanup_off' })).status).toBe(200);
    expect((await pcOf(off.id)).disconnect).toMatchObject({ state: 'access_revoked', remote_cleanup: false, cleanup_off: true, finished_at: expect.any(Number) });
    app.db.prepare("UPDATE pc_actions SET expires_at=? WHERE kind='disconnect' AND machine_id=?").run(Date.now() - 1, off.id);
    expect((await pcOf(off.id)).disconnect.state).toBe('access_revoked'); // finished: it does not turn into Needs attention
  });
});

describe('messages shown on the PC', () => {
  it('only for an agent whose key is bound to this PC; the console reads delivered, shown and read apart', async () => {
    const pc = await newPc('conn-msg'), other = await newPc('conn-msg-x');
    const a = app.keys.createAgent('msg worker', null, sys), b = app.keys.createAgent('msg lead', null, sys);
    app.keys.createSessionKey({ agentId: a.id, label: 'k', machineId: pc.id }, sys);
    const room = app.messaging.ensureDirect(a.id, b.id);
    expect((await cn('POST', '/messages/shown', other.key, { agent_id: a.id, room_id: room.id, seq: 1 })).status).toBe(404);
    expect((await cn('POST', '/messages/shown', pc.key, { agent_id: a.id, room_id: room.id, seq: 5 })).status).toBe(200);
    const st = (await api('GET', `/agents/${a.id}/message-states?room_id=${room.id}`)).body.states;
    expect(st).toEqual([{ room_id: room.id, last_seq: 0, delivered_seq: 0, shown_seq: 0, shown_reported_at: expect.any(Number), acked_seq: 0 }]); // capped at the room's last message
  });
});

describe('delivery states in a conversation', () => {
  it('gives each agent the delivered, shown and read positions, so the room can mark every message; admin only', async () => {
    const pc = await newPc('conn-room');
    const a = app.keys.createAgent('room worker', null, sys), b = app.keys.createAgent('room lead', null, sys);
    const ka = app.keys.createSessionKey({ agentId: a.id, label: 'k', machineId: pc.id }, sys), kb = app.keys.createSessionKey({ agentId: b.id, label: 'k' }, sys);
    const room = app.messaging.ensureDirect(a.id, b.id);
    for (const body of ['one', 'two', 'three', 'four']) app.messaging.insert({ roomId: room.id, agentId: b.id, credId: kb.credential.id, kind: 'text', body, replyTo: null, clientMsgId: body });
    // Nothing fetched yet, and no PC has reported: not delivered yet, shown Unknown.
    const first = (await api('GET', `/conversations/${room.id}/delivery`)).body;
    expect(first.last_seq).toBe(4);
    expect(first.members.find((m: any) => m.agent_id === a.id)).toMatchObject({ label: 'room worker', delivered_seq: 0, shown_seq: null, acked_seq: 0 });
    // A login of a fetched two messages, its PC showed three, and it read one.
    app.db.prepare('INSERT INTO session_tokens(token_hash,app_credential_id,session_credential_id,created_at,last_used_at,expires_at) VALUES (?,?,?,?,?,?)').run('h-room', ka.credential.id, ka.credential.id, 1, 1, Date.now() + 1e6);
    app.messaging.advance('h-room', a.id, { [room.id]: 2 });
    app.messaging.ack('h-room', a.id, { [room.id]: 1 });
    expect((await cn('POST', '/messages/shown', pc.key, { agent_id: a.id, room_id: room.id, seq: 3 })).status).toBe(200);
    const m = (await api('GET', `/conversations/${room.id}/delivery`)).body.members.find((x: any) => x.agent_id === a.id);
    expect(m).toMatchObject({ delivered_seq: 2, shown_seq: 3, acked_seq: 1 });
    expect(m.shown_reported_at).toEqual(expect.any(Number));
    expect((await api('GET', '/conversations/room_nope/delivery')).status).toBe(404);
  });
});

describe('the reminder line counts', () => {
  it('counts unread messages by sender and directives for an agent of this PC, with no text, and changes no position', async () => {
    const pc = await newPc('conn-unread'), other = await newPc('conn-unread-x');
    const a = app.keys.createAgent('unread worker', null, sys), b = app.keys.createAgent('unread lead', null, sys);
    const ka = app.keys.createSessionKey({ agentId: a.id, label: 'k', machineId: pc.id }, sys), kb = app.keys.createSessionKey({ agentId: b.id, label: 'k' }, sys);
    const room = app.messaging.ensureDirect(a.id, b.id);
    for (const body of ['secret one', 'secret two']) app.messaging.insert({ roomId: room.id, agentId: b.id, credId: kb.credential.id, kind: 'text', body, replyTo: null, clientMsgId: body });
    app.messaging.insert({ roomId: room.id, agentId: a.id, credId: ka.credential.id, kind: 'text', body: 'mine', replyTo: null, clientMsgId: 'mine' });
    const ask = () => cn('POST', '/messages/unread', pc.key, { agent_id: a.id });
    const r = await ask();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ total: 2, senders: [{ from: 'agent', label: 'unread lead', count: 2 }], rooms: [{ room_id: room.id, top_seq: 2 }], directives: expect.any(Number) });
    expect(JSON.stringify(r.body)).not.toContain('secret');
    expect((await cn('POST', '/messages/unread', other.key, { agent_id: a.id })).status).toBe(404); // another PC's key
    app.db.prepare('INSERT INTO session_tokens(token_hash,app_credential_id,session_credential_id,created_at,last_used_at,expires_at) VALUES (?,?,?,?,?,?)').run('h-unread', ka.credential.id, ka.credential.id, 1, 1, Date.now() + 1e6);
    app.messaging.ack('h-unread', a.id, { [room.id]: 1 });
    const at = app.messaging.deliveredSeq('h-unread', room.id);
    expect((await ask()).body).toMatchObject({ total: 1 }); // only past what it read
    expect(app.messaging.deliveredSeq('h-unread', room.id)).toBe(at); // asking moved no delivery position
  });
});

describe('usage', () => {
  it('is refused until the PC user opts in; priced only where a list price is set', async () => {
    const pc = await newPc('conn-usage');
    const ag = app.keys.createAgent('usage worker', null, sys);
    app.keys.createSessionKey({ agentId: ag.id, label: 'k', machineId: pc.id }, sys);
    const rows = [
      { agent_id: ag.id, client: 'claude_code', model: 'model-a', input_tokens: 1_000_000, output_tokens: 100_000, cache_read_tokens: 0, cache_write_tokens: 0, sessions: 2 },
    ];
    expect((await api('GET', `/pcs/${pc.id}/usage`)).body).toMatchObject({ opted_in: null, days: [], total: { cost_usd: null }, priced_at: 'API list prices' });
    await cn('POST', '/check-in', pc.key, report);
    const day = new Date().toISOString().slice(0, 10);
    expect((await cn('POST', '/usage', pc.key, { day, rows })).status).toBe(409);
    await cn('POST', '/check-in', pc.key, { ...report, usage_opt_in: true });
    expect((await cn('POST', '/usage', pc.key, { day, rows: [{ ...rows[0], agent_id: 'agent-not-here' }] })).status).toBe(400); // only its own agents
    expect((await cn('POST', '/usage', pc.key, { day, rows })).status).toBe(200);
    expect((await cn('POST', '/usage', pc.key, { day, rows })).status).toBe(200); // a repeated day replaces it
    const u = (await api('GET', `/pcs/${pc.id}/usage`)).body;
    expect(u.total).toEqual({ input_tokens: 1_000_000, output_tokens: 100_000, cache_read_tokens: 0, cache_write_tokens: 0, turns: null, cost_usd: 4.5 }); // no turns reported: Unknown
    await cn('POST', '/usage', pc.key, { day, rows: [...rows, { ...rows[0], model: 'model-unpriced' }] });
    expect((await api('GET', `/pcs/${pc.id}/usage`)).body.total.cost_usd).toBeNull();
  });
  it('counts turns, and shows an agent across its PCs and a team across its current members', async () => {
    const pc1 = await newPc('conn-usage-v1'), pc2 = await newPc('conn-usage-v2');
    const a1 = app.keys.createAgent('usage view one', null, sys), a2 = app.keys.createAgent('usage view two', null, sys), out = app.keys.createAgent('usage view out', null, sys);
    app.keys.createSessionKey({ agentId: a1.id, label: 'k', machineId: pc1.id }, sys);
    app.keys.createSessionKey({ agentId: a1.id, label: 'k2', machineId: pc2.id }, sys);
    app.keys.createSessionKey({ agentId: a2.id, label: 'k', machineId: pc2.id }, sys);
    app.keys.createSessionKey({ agentId: out.id, label: 'k', machineId: pc2.id }, sys);
    const team = app.teams.create({ name: 'Usage view team', goal: 'Count', members: [{ agent_id: a1.id, role: 'coordinator' }, { agent_id: a2.id, role: 'worker' }] }, sys);
    expect((await api('GET', `/agents/${a1.id}/usage`)).body).toEqual({ reported: false, total: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, turns: null, cost_usd: null }, priced_at: 'API list prices', by: [] });
    for (const pc of [pc1, pc2]) await cn('POST', '/check-in', pc.key, { ...report, usage_opt_in: true });
    const day = new Date().toISOString().slice(0, 10);
    const row = (agent_id: string, input_tokens: number, turns?: number) => ({ agent_id, client: 'claude_code', model: 'model-a', input_tokens, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, sessions: 1, ...(turns === undefined ? {} : { turns }) });
    // Two rows for one agent and model in one report are summed, turns too; a negative or fractional count is refused.
    expect((await cn('POST', '/usage', pc1.key, { day, rows: [row(a1.id, 1_000_000, 3), row(a1.id, 1_000_000, 2)] })).status).toBe(200);
    expect((await cn('POST', '/usage', pc1.key, { day, rows: [row(a1.id, 1, -1)] })).status).toBe(400);
    expect((await cn('POST', '/usage', pc2.key, { day, rows: [row(a1.id, 1_000_000, 4), row(a2.id, 2_000_000, 1), row(out.id, 9_000_000, 9)] })).status).toBe(200);
    expect((await api('GET', `/pcs/${pc1.id}/usage`)).body.total).toMatchObject({ input_tokens: 2_000_000, turns: 5 });
    const ag = (await api('GET', `/agents/${a1.id}/usage`)).body;
    expect(ag.reported).toBe(true);
    expect(ag.total).toEqual({ input_tokens: 3_000_000, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, turns: 9, cost_usd: 9 });
    expect(ag.by).toEqual([
      expect.objectContaining({ pc_id: pc1.id, pc_name: 'conn-usage-v1', input_tokens: 2_000_000, turns: 5, cost_usd: 6 }),
      expect.objectContaining({ pc_id: pc2.id, pc_name: 'conn-usage-v2', input_tokens: 1_000_000, turns: 4, cost_usd: 3 }),
    ]);
    const tm = (await api('GET', `/teams/${team.id}/usage`)).body; // the agent outside the team is not in it
    expect(tm.total).toMatchObject({ input_tokens: 5_000_000, turns: 10, cost_usd: 15 });
    expect(tm.by.map((x: any) => [x.agent_id, x.input_tokens])).toEqual([[a1.id, 3_000_000], [a2.id, 2_000_000]]);
    // A row from a connector that does not report turns makes the total's turns Unknown, not a smaller number.
    await cn('POST', '/usage', pc2.key, { day, rows: [row(a1.id, 1_000_000, 4), row(a2.id, 2_000_000)] });
    expect((await api('GET', `/teams/${team.id}/usage`)).body.total.turns).toBeNull();
    expect((await api('GET', `/agents/${a1.id}/usage`)).body.total.turns).toBe(9);
    expect((await api('GET', '/agents/agent-nobody/usage')).status).toBe(404);
    expect((await api('GET', '/teams/team-nobody/usage')).status).toBe(404);
    expect((await api('GET', `/teams/${team.id}/usage?days=91`)).status).toBe(400);
  });
  it('is kept 400 days by the day it describes, whether or not the PC user later turns reports off', async () => {
    const pc = await newPc('conn-usage-ret');
    const ag = app.keys.createAgent('usage keeper', null, sys);
    app.keys.createSessionKey({ agentId: ag.id, label: 'k', machineId: pc.id }, sys);
    await cn('POST', '/check-in', pc.key, { ...report, usage_opt_in: true });
    const row = { agent_id: ag.id, client: 'claude_code', model: 'model-a', input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, sessions: 1 };
    const dayAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
    for (const d of [dayAgo(1), dayAgo(399), dayAgo(401)]) expect((await cn('POST', '/usage', pc.key, { day: d, rows: [row] })).status).toBe(200);
    await cn('POST', '/check-in', pc.key, { ...report, usage_opt_in: false }); // turning reports off deletes nothing
    const days = () => (app.db.prepare('SELECT day FROM connector_usage WHERE machine_id=? ORDER BY day DESC').all(pc.id) as { day: string }[]).map((r) => r.day);
    expect(days()).toEqual([dayAgo(1), dayAgo(399), dayAgo(401)]);
    expect((await app.maintenance.run()).usage).toBe(1);
    expect(days()).toEqual([dayAgo(1), dayAgo(399)]);
    app.db.prepare("INSERT INTO system_settings(key,value,updated_at) VALUES ('retention.usage_days','30',?)").run(Date.now());
    await app.maintenance.run();
    expect(days()).toEqual([dayAgo(1), dayAgo(399)]); // a lower setting is read as the floor (docs/operations.md)
    app.db.prepare("DELETE FROM system_settings WHERE key='retention.usage_days'").run();
  });
});

describe('setup timeline and Add PC', () => {
  it('a new PC waits for its pairing, the next action named and taken by the PC user', async () => {
    const pc = await newPc('conn-tl');
    const t = (await api('GET', `/pcs/${pc.id}/setup-timeline`)).body;
    expect(t.steps.map((s: any) => s.step)).toEqual(['added', 'paired', 'request_filed', 'approved', 'keys_collected', 'agents_connected']);
    expect(t.steps[1]).toMatchObject({ state: 'waiting', next: { action: 'Enter the pairing code on the PC', who: 'pc_user' } });
    expect(t.agents).toEqual([]);
    await cn('POST', '/check-in', pc.key, report);
    const t2 = (await api('GET', `/pcs/${pc.id}/setup-timeline`)).body;
    expect(t2.steps[1].state).toBe('done');
    expect(t2.steps[2]).toMatchObject({ state: 'waiting', next: { who: 'pc_user' } });
    expect((await api('GET', '/pcs/pc-nope/setup-timeline')).status).toBe(404);
  });
  it('a PC whose agents work through its app key, without the connector, reads as set up (operator walk-through finding 2)', async () => {
    const pc = await newPc('conn-tl-appkey');
    const before = (await api('GET', `/pcs/${pc.id}/setup-timeline`)).body;
    expect(before.steps[1]).toMatchObject({ step: 'paired', state: 'waiting' }); // nothing ran through it yet
    // An agent logs in through the PC's app key and calls a tool, as the older helper does.
    const a = app.keys.createAgent('tl-worker', null, sys);
    const sk = app.keys.createSessionKey({ agentId: a.id, label: 'tl-worker key' }, sys);
    app.keys.setRules(sk.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }], 'test', sys);
    const c = new Client({ name: 't', version: '1' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${pc.key}` } } }));
    const token = (await c.callTool({ name: 'session_login', arguments: { session_key: sk.secret } })).structuredContent!.session_token;
    await c.callTool({ name: 'task_list', arguments: { session_token: token } });
    await c.close();
    const t = (await api('GET', `/pcs/${pc.id}/setup-timeline`)).body;
    expect(t.steps.map((s: any) => s.step)).toEqual(['added', 'app_key', 'agents_connected']);
    expect(t.steps[1]).toMatchObject({ state: 'done', next: null });
    expect(t.steps[1].reason).toContain('the connector is not paired');
    expect(t.steps[2]).toMatchObject({ state: 'done', reason: '1 agent has worked through this PC.' });
    expect(t.steps.some((s: any) => s.state === 'waiting')).toBe(false);
    // Once the connector checks in, the PC follows the connector's own steps again.
    await cn('POST', '/check-in', pc.key, report);
    expect((await api('GET', `/pcs/${pc.id}/setup-timeline`)).body.steps[1]).toMatchObject({ step: 'paired', state: 'done' });
  });
  it('Add PC answers the download link (unset here) and no pairing block when the hub serves no CA', async () => {
    const r = (await api('POST', '/pcs/add', { name: 'conn-add' })).body;
    expect(r.download_url).toBeNull();
    expect(r.pairing).toBeNull();
    expect(r.connector_prompt).toBeNull();
    expect(r.connector_unavailable).toBe('no_ca');
  });
});
