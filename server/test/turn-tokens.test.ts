/**
 * Turn tokens (docs/connector.md, "Isolation levels"): a session talks to the hub with a short-lived token the connector
 * obtained for it and nothing else. The token covers one agent's tools, minus keys and access; it is renewed only by the
 * connector, revoked at the end of the turn, and refused after that, for another agent's call, for a key pickup and for a
 * new token. Two live bindings for one agent alert the operator. The check-in carries the isolation level.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { TURN_TOKEN_MS } from '../src/keys/keys.js';
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
/** One /mcp tool call carrying exactly the headers given (a session sends the token alone). */
const rpc = async (headers: Record<string, string>, name: string, args: Record<string, unknown> = {}) => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const asToken = (token: string) => ({ 'x-agent-hub-session': token });

/** A PC with its app key, and an agent of that PC with a session key. */
const world = async (name: string) => {
  const id = (await api('POST', '/pcs', { name })).body.pc.id as string;
  const appKey = app.keys.createAppKey({ machineId: id, appName: 'conclave-connector', maxLiveSessions: 10 }, sys).secret;
  const agent = (label: string) => { const a = app.keys.createAgent(label, null, sys); const k = app.keys.createSessionKey({ agentId: a.id, label: 'k', machineId: id }, sys); return { id: a.id, key: k.secret, cred: k.credential }; };
  return { pc: id, appKey, agent };
};
const issue = (w: { appKey: string }, sessionKey: string, run = 'r-1') => cn('POST', '/turn-tokens', w.appKey, { session_key: sessionKey, run });

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahturn-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  const config: Config = testConfig(dir, { maintenanceSeconds: undefined });
  app = await buildApp(config);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base));
});
afterAll(async () => { await app.close(); });

describe('a hand-opened chat or a woken run works with a turn token alone', () => {
  it('issues a token for the agent, and /mcp takes it with no app key and no session key', async () => {
    const w = await world('turn-basic'), a = w.agent('turn worker');
    const r = await issue(w, a.key);
    expect(r.status).toBe(200);
    expect(r.body.token).toMatch(/^ah_tok_/);
    expect(r.body.agent_id).toBe(a.id);
    expect(r.body.label, 'the agent\'s own label (a Codex commit\'s author), not its key\'s').toBe('turn worker');
    const who = await rpc(asToken(r.body.token), 'session_whoami');
    expect(who.status).toBe(200);
    expect(who.body.result.structuredContent.agent_id).toBe(a.id);
    expect(JSON.stringify(r.body)).not.toContain(a.key);
  });
  it('only a PC\'s own app key asks for a token, and only for an agent key bound to that PC', async () => {
    const w = await world('turn-own'), other = await world('turn-other'), a = w.agent('own agent');
    expect((await cn('POST', '/turn-tokens', null, { session_key: a.key, run: 'r' })).status).toBe(401);
    expect((await cn('POST', '/turn-tokens', other.appKey, { session_key: a.key, run: 'r' })).status).toBeGreaterThanOrEqual(400);
    expect((await issue(w, 'ah_ses_aaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')).status).toBeGreaterThanOrEqual(400);
  });
});

const SETUP_KEY = 'ah_set_aaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ARGS: Record<string, Record<string, unknown>> = { session_login: { session_key: 'ah_ses_aaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }, setup_pc: { setup_key: SETUP_KEY, os: 'windows' }, setup_status: { setup_key: SETUP_KEY }, access_request: { actions: ['fs.update'], resource: '/vault/x', reason: 'x' } };

describe('what a turn token may not do', () => {
  it('cannot sign in, set a PC up, or ask for access: a new token is never one call away', async () => {
    const w = await world('turn-denied'), a = w.agent('denied agent');
    const t = (await issue(w, a.key)).body.token as string;
    for (const tool of ['session_login', 'setup_pc', 'setup_status', 'access_request']) {
      const r = await rpc(asToken(t), tool, ARGS[tool]!);
      expect(JSON.stringify(r.body), tool).toMatch(/turn token cannot use this tool|denied/);
      expect(r.body.result?.structuredContent?.error ?? r.body.error, tool).toBeTruthy();
    }
    // Even with the app key beside it, a turn token cannot log in again.
    const both = await rpc({ authorization: `Bearer ${w.appKey}`, ...asToken(t) }, 'session_login', { session_key: a.key });
    expect(JSON.stringify(both.body)).toMatch(/turn token cannot use this tool|denied/);
  });
  it('cannot pick up keys: the pickup routes take the app key, which a session never has', async () => {
    const w = await world('turn-pickup'), a = w.agent('pickup agent');
    const t = (await issue(w, a.key)).body.token as string;
    for (const path of ['/onboard/pickup', '/onboard/pickup/confirm']) {
      const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...asToken(t), authorization: `Bearer ${t}` }, body: JSON.stringify({ request_id: 'obr_x' }) });
      expect([400, 401, 403, 404], path).toContain(r.status);
    }
    const c = await cn('POST', '/turn-tokens', t, { session_key: a.key, run: 'r' });
    expect(c.status).toBe(401); // a token is not an app key
    const rn = await cn('POST', '/turn-tokens/renew', t, { token: t });
    expect(rn.status).toBe(401);
  });
  it('is the agent that asked: another agent\'s tools, rooms and tasks are not reached with it', async () => {
    const w = await world('turn-agent'), a = w.agent('agent a'), b = w.agent('agent b');
    const ta = (await issue(w, a.key)).body.token as string, tb = (await issue(w, b.key, 'r-2')).body.token as string;
    expect((await rpc(asToken(ta), 'session_whoami')).body.result.structuredContent.agent_id).toBe(a.id);
    expect((await rpc(asToken(tb), 'session_whoami')).body.result.structuredContent.agent_id).toBe(b.id);
  });
});

describe('the life of a turn token', () => {
  it('is revoked at the end of the turn and refused after: the call gets login_required', async () => {
    const w = await world('turn-revoke'), a = w.agent('revoke agent');
    const t = (await issue(w, a.key)).body.token as string;
    expect((await rpc(asToken(t), 'session_whoami')).status).toBe(200);
    expect((await cn('POST', '/turn-tokens/revoke', w.appKey, { token: t })).body).toEqual({ ended: true });
    const after = await rpc(asToken(t), 'session_whoami');
    expect(after.status).toBe(401);
    expect(after.body.error).toBe('login_required');
    expect((await cn('POST', '/turn-tokens/revoke', w.appKey, { token: t })).body).toEqual({ ended: false });
    expect((await cn('POST', '/turn-tokens/renew', w.appKey, { token: t })).status).toBeGreaterThanOrEqual(400);
  });
  it('another PC cannot revoke or renew it', async () => {
    const w = await world('turn-mine'), other = await world('turn-theirs'), a = w.agent('mine');
    const t = (await issue(w, a.key)).body.token as string;
    expect((await cn('POST', '/turn-tokens/revoke', other.appKey, { token: t })).body).toEqual({ ended: false });
    expect((await cn('POST', '/turn-tokens/renew', other.appKey, { token: t })).status).toBeGreaterThanOrEqual(400);
    expect((await rpc(asToken(t), 'session_whoami')).status).toBe(200);
  });
  it('a use does not extend it; only the connector\'s renewal does, so a turn of any length keeps its token', async () => {
    const w = await world('turn-renew'), a = w.agent('renew agent');
    const t = (await issue(w, a.key)).body.token as string;
    const hash = (await import('node:crypto')).createHash('sha256').update(t).digest('hex');
    const exp = () => (app.db.prepare('SELECT expires_at FROM session_tokens WHERE token_hash=?').get(hash) as { expires_at: number }).expires_at;
    const first = exp();
    expect(first - Date.now()).toBeLessThanOrEqual(TURN_TOKEN_MS);
    await rpc(asToken(t), 'session_whoami');
    expect(exp()).toBe(first); // a call does not slide it
    // 20 minutes of wall time with a renewal every 5: the token outlives the 15-minute lifetime. Time is moved by editing the stored expiry.
    const real = Date.now;
    let offset = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => real() + offset);
    try {
      for (let i = 0; i < 4; i++) {
        offset += 5 * 60_000;
        expect((await cn('POST', '/turn-tokens/renew', w.appKey, { token: t })).status).toBe(200);
        expect((await rpc(asToken(t), 'session_whoami')).status).toBe(200);
      }
      expect(offset).toBe(20 * 60_000);
      // Without a renewal it ends after the lifetime.
      offset += TURN_TOKEN_MS + 1000;
      const gone = await rpc(asToken(t), 'session_whoami');
      expect(gone.status).toBe(401);
      expect((await cn('POST', '/turn-tokens/renew', w.appKey, { token: t })).status).toBeGreaterThanOrEqual(400);
    } finally { vi.restoreAllMocks(); }
  });
  it('ends when the agent key or the PC is suspended, and a renewal is refused', async () => {
    const w = await world('turn-suspend'), a = w.agent('suspend agent');
    const t = (await issue(w, a.key)).body.token as string;
    app.keys.setStatus(a.cred.id, 'suspended', 'test', sys);
    expect((await cn('POST', '/turn-tokens/renew', w.appKey, { token: t })).status).toBeGreaterThanOrEqual(400);
    expect((await rpc(asToken(t), 'session_whoami')).status).toBe(401);
    const w2 = await world('turn-suspend-pc'), b = w2.agent('pc agent');
    const t2 = (await issue(w2, b.key)).body.token as string;
    expect((await api('POST', `/pcs/${w2.pc}/suspend`, {})).status).toBe(200);
    expect((await rpc(asToken(t2), 'session_whoami')).status).toBe(401);
  });
  it('a key found in the transcript is revoked with that reason and audited', async () => {
    const w = await world('turn-leak'), a = w.agent('leak agent');
    const t = (await issue(w, a.key)).body.token as string;
    expect((await cn('POST', '/turn-tokens/revoke', w.appKey, { token: t, reason: 'leak_found' })).body).toEqual({ ended: true });
    const row = app.db.prepare('SELECT revoked_reason FROM session_tokens WHERE revoked_at IS NOT NULL ORDER BY revoked_at DESC LIMIT 1').get() as { revoked_reason: string };
    expect(row.revoked_reason).toBe('leak_found');
    expect((app.db.prepare("SELECT severity FROM security_alerts WHERE type='key_in_transcript' AND subject=?").get(w.pc) as { severity: string }).severity).toBe('critical');
    expect((await cn('POST', '/turn-tokens/revoke', w.appKey, { token: 'x', reason: 'because' })).status).toBe(400);
  });
  it('a key found after the token expired or was already ended still raises the alert, naming the agent', async () => {
    const leak = (w: { pc: string }) => app.db.prepare("SELECT severity, details FROM security_alerts WHERE type='key_in_transcript' AND subject=?").get(w.pc) as { severity: string; details: string } | undefined;
    // Expired.
    const w = await world('turn-leak-late'), a = w.agent('late leak agent');
    const t = (await issue(w, a.key)).body.token as string;
    app.db.prepare("UPDATE session_tokens SET expires_at=? WHERE scope='turn' AND session_credential_id=?").run(Date.now() - 1000, a.cred.id);
    await cn('POST', '/turn-tokens/revoke', w.appKey, { token: t, reason: 'leak_found' });
    expect(leak(w)!.severity).toBe('critical');
    expect(JSON.parse(leak(w)!.details)).toMatchObject({ pc: w.pc, agent: a.id, turn: 'ended_before' });
    // Ended first (the turn ended, or the hub refused a renewal), and the scan found the key afterwards.
    const w2 = await world('turn-leak-ended'), b = w2.agent('ended leak agent');
    const t2 = (await issue(w2, b.key)).body.token as string;
    expect((await cn('POST', '/turn-tokens/revoke', w2.appKey, { token: t2 })).body).toEqual({ ended: true });
    expect(leak(w2)).toBeUndefined(); // an ordinary end raises nothing
    expect((await cn('POST', '/turn-tokens/revoke', w2.appKey, { token: t2, reason: 'leak_found' })).body).toEqual({ ended: false });
    expect(JSON.parse(leak(w2)!.details)).toMatchObject({ pc: w2.pc, agent: b.id, turn: 'ended_before' });
    // A token this PC never had still alerts, without an agent.
    const w3 = await world('turn-leak-unknown');
    await cn('POST', '/turn-tokens/revoke', w3.appKey, { token: 'ah_tok_never_issued', reason: 'leak_found' });
    expect(JSON.parse(leak(w3)!.details)).toMatchObject({ pc: w3.pc, turn: 'unknown' });
    expect(JSON.parse(leak(w3)!.details).agent).toBeUndefined();
  });
});

describe('folders the connector grandfathered at the upgrade', () => {
  it('get one audit entry each, only for the agents of this PC, and the route needs the app key', async () => {
    const w = await world('turn-grand'), a = w.agent('grand agent'), other = await world('turn-grand-other'), b = other.agent('foreign agent');
    const n = () => (app.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='connector.folder_grandfathered'").get() as { n: number }).n;
    const before = n();
    expect((await cn('POST', '/folders-grandfathered', w.appKey, { agents: [a.id, a.id, b.id] })).body).toEqual({ audited: 1 });
    expect(n()).toBe(before + 1);
    // The connector names an agent by its label on this PC: that is audited too, once, and never for another PC's agent.
    const lab = w.agent('label agent');
    expect((await cn('POST', '/folders-grandfathered', w.appKey, { agents: ['label agent', 'foreign agent'] })).body).toEqual({ audited: 1 });
    expect(app.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='connector.folder_grandfathered' AND target_id=?").get(lab.id)).toEqual({ n: 1 });
    expect((await cn('POST', '/folders-grandfathered', null, { agents: [a.id] })).status).toBe(401);
    expect((await cn('POST', '/folders-grandfathered', w.appKey, { agents: [a.id], extra: 1 })).status).toBe(400);
  });
});

describe('folders allowed with a pickup', () => {
  it('get one audit entry each under their own name, only for the agents of this PC, and the route needs the app key and a strict body', async () => {
    const w = await world('turn-pickup-allow'), a = w.agent('pickup agent'), other = await world('turn-pickup-allow-other'), b = other.agent('foreign pickup agent');
    const n = () => (app.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='connector.folder_allowed_with_pickup'").get() as { n: number }).n;
    const before = n();
    expect((await cn('POST', '/folders-allowed-with-pickup', w.appKey, { allowed: [{ agent_id: a.id, ref: 'opk_1' }, { agent_id: b.id, ref: 'opk_1' }] })).body).toEqual({ audited: 1 });
    expect(n()).toBe(before + 1);
    const row = app.db.prepare("SELECT target_id, details FROM audit_events WHERE action='connector.folder_allowed_with_pickup' ORDER BY rowid DESC LIMIT 1").get() as { target_id: string; details: string };
    expect(row.target_id).toBe(a.id);
    expect(JSON.parse(row.details)).toMatchObject({ pc: w.pc, pickup: 'opk_1' });
    expect((await cn('POST', '/folders-allowed-with-pickup', null, { allowed: [{ agent_id: a.id, ref: 'opk_1' }] })).status).toBe(401);
    expect((await cn('POST', '/folders-allowed-with-pickup', w.appKey, { allowed: [{ agent_id: a.id, ref: 'opk_1', extra: 1 }] })).status).toBe(400);
  });
});

describe('chats the PC user denied on the connector screen', () => {
  it('are audited, a declined pickup too, only for the agents of this PC, and the route needs the app key and a strict body', async () => {
    const w = await world('turn-deny'), a = w.agent('deny agent'), other = await world('turn-deny-other'), b = other.agent('foreign agent');
    const count = (action: string) => (app.db.prepare('SELECT COUNT(*) n FROM audit_events WHERE action=?').get(action) as { n: number }).n;
    const d0 = count('connector.folder_denied'), p0 = count('connector.pickup_declined');
    const r = await cn('POST', '/folders-denied', w.appKey, { denied: [{ what: 'folder', agent: a.id }, { what: 'pickup', request: 'obr_1' }, { what: 'folder', agent: b.id }] });
    expect(r.body).toEqual({ audited: 3 });
    expect(count('connector.folder_denied')).toBe(d0 + 2);
    expect(count('connector.pickup_declined')).toBe(p0 + 1);
    const foreign = app.db.prepare("SELECT target_kind, target_id FROM audit_events WHERE action='connector.folder_denied' ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as { target_kind: string; target_id: string };
    expect(foreign.target_id).not.toBe(b.id); // an agent of another PC is not named
    expect((await cn('POST', '/folders-denied', null, { denied: [{ what: 'folder', agent: a.id }] })).status).toBe(401);
    expect((await cn('POST', '/folders-denied', w.appKey, { denied: [{ what: 'folder', agent: a.id, extra: 1 }] })).status).toBe(400);
    expect((await cn('POST', '/folders-denied', w.appKey, { denied: [{ what: 'other' }] })).status).toBe(400);
  });
  it('raise one warning when the same agent is denied three times in an hour', async () => {
    const w = await world('turn-deny-rep'), a = w.agent('repeat agent');
    const alerts = () => app.db.prepare("SELECT details FROM security_alerts WHERE type='connector_folder_denied_repeat' AND subject=?").all(a.id) as { details: string }[];
    await cn('POST', '/folders-denied', w.appKey, { denied: [{ what: 'folder', agent: a.id }, { what: 'folder', agent: a.id }] });
    expect(alerts()).toHaveLength(0);
    await cn('POST', '/folders-denied', w.appKey, { denied: [{ what: 'folder', agent: 'repeat agent' }] }); // a local label names it too
    expect(alerts()).toHaveLength(1);
    expect(JSON.parse(alerts()[0]!.details)).toMatchObject({ agent: a.id, pc: w.pc, denied_last_hour: 3 });
    await cn('POST', '/folders-denied', w.appKey, { denied: [{ what: 'folder', agent: a.id }] });
    expect(alerts()).toHaveLength(1); // not repeated within the hour
  });
});

describe('two live bindings for one agent', () => {
  const alert = (agent: string) => app.db.prepare("SELECT details FROM security_alerts WHERE type='agent_two_live_bindings' AND subject=?").all(agent) as { details: string }[];
  const age = (cred: string, run: string) => app.db.prepare("UPDATE session_tokens SET created_at=created_at-120000 WHERE scope='turn' AND run_ref=? AND session_credential_id=?").run(run, cred);
  const renew = (w: { appKey: string }, token: string) => cn('POST', '/turn-tokens/renew', w.appKey, { token });
  it('alert the operator once per pair when two runs of the agent stay live, found at the renewal', async () => {
    const w = await world('turn-two'), a = w.agent('two agent');
    const t1 = (await issue(w, a.key, 'r-1')).body.token as string;
    const t2 = (await issue(w, a.key, 'r-2')).body.token as string;
    expect(alert(a.id)).toHaveLength(0); // nothing at the issue
    age(a.cred.id, 'r-1'); age(a.cred.id, 'r-2');
    expect((await renew(w, t2)).status).toBe(200);
    expect(alert(a.id)).toHaveLength(1);
    expect(JSON.parse(alert(a.id)[0]!.details)).toMatchObject({ agent: a.id, pc: w.pc, count: 1 });
    // The renewals every 5 minutes, from either run, do not repeat it.
    await renew(w, t1); await renew(w, t2);
    expect(alert(a.id)).toHaveLength(1);
    expect(JSON.parse(alert(a.id)[0]!.details)).toMatchObject({ count: 1 });
    // A third run makes new pairs: they join the same alert, once each.
    await issue(w, a.key, 'r-3'); age(a.cred.id, 'r-3');
    await renew(w, t1); await renew(w, t1);
    expect(alert(a.id)).toHaveLength(1);
    expect(JSON.parse(alert(a.id)[0]!.details)).toMatchObject({ count: 2 });
  });
  it('do not count conclave check --probe beside a normal session', async () => {
    const w = await world('turn-probe'), a = w.agent('probe agent');
    const t = (await issue(w, a.key, 'r-run')).body.token as string;
    age(a.cred.id, 'r-run');
    // The probe: a token issued and revoked at once, while the session lives.
    const p = (await issue(w, a.key, 'r-probe')).body.token as string;
    expect(alert(a.id)).toHaveLength(0);
    expect((await renew(w, t)).status).toBe(200); // renewed while the probe is still live: too new to count
    expect((await cn('POST', '/turn-tokens/revoke', w.appKey, { token: p })).body).toEqual({ ended: true });
    expect((await renew(w, t)).status).toBe(200);
    expect(alert(a.id)).toHaveLength(0);
  });
});

describe('the isolation level shows on the PC', () => {
  it('the check-in carries it, and the console reads Standard isolation with the key store', async () => {
    const w = await world('turn-level');
    expect((await api('GET', '/pcs')).body.pcs.find((p: any) => p.id === w.pc).connector.isolation).toBeNull();
    const r = await cn('POST', '/check-in', w.appKey, { version: '1.4.0', platform: 'win32-x64', node: '22.11.0', clients: [], auto_update: true, remote_cleanup: true, isolation: 'standard', key_store: 'dpapi' });
    expect(r.status).toBe(200);
    expect((await api('GET', '/pcs')).body.pcs.find((p: any) => p.id === w.pc).connector).toMatchObject({ isolation: 'standard', key_store: 'dpapi' });
    expect((await cn('POST', '/check-in', w.appKey, { version: '1.4.0', isolation: 'sort-of' })).status).toBe(400);
  });
});

describe('a paused team or a lockdown ends the run\'s token at its next renewal', () => {
  it('renews while the team runs, refuses and ends the token once it is paused, and renews again for a new token after resume', async () => {
    const w = await world('turn-pause'), a = w.agent('pause worker'), c = w.agent('pause coord');
    const tid = app.teams.create({ name: 'TP', goal: 'g', members: [{ agent_id: c.id, role: 'coordinator', credential_id: c.cred.id }, { agent_id: a.id, role: 'worker', credential_id: a.cred.id }] }, sys).id;
    app.teams.start(tid, sys);
    const t = (await issue(w, a.key)).body.token as string;
    const r1 = await cn('POST', '/turn-tokens/renew', w.appKey, { token: t });
    expect(r1.status).toBe(200);
    expect(r1.body.expires_at - Date.now()).toBeGreaterThan(TURN_TOKEN_MS - 5_000);
    expect((await api('POST', `/teams/${tid}/pause`, {})).status).toBeLessThan(300);
    const r2 = await cn('POST', '/turn-tokens/renew', w.appKey, { token: t });
    expect(r2.status).toBe(409);
    expect(r2.body.error).toBe('paused');
    // The token is gone at once, not at its expiry: the run's next call is refused.
    expect((await rpc(asToken(t), 'session_whoami')).body.result?.structuredContent?.agent_id).toBeUndefined();
    expect(app.db.prepare("SELECT revoked_reason r FROM session_tokens WHERE scope='turn' AND revoked_at IS NOT NULL ORDER BY revoked_at DESC LIMIT 1").get()).toEqual({ r: 'paused' });
    expect((await api('POST', `/teams/${tid}/resume`, {})).status).toBeLessThan(300);
    const t2 = (await issue(w, a.key, 'r-2')).body.token as string;
    expect((await cn('POST', '/turn-tokens/renew', w.appKey, { token: t2 })).status).toBe(200);
  });
  it('a checkout\'s own pause holds the team but keeps the token: the resume run it starts goes on past 5 minutes', async () => {
    const w = await world('turn-checkout'), a = w.agent('checkout worker'), c = w.agent('checkout coord');
    const tid = app.teams.create({ name: 'TC', goal: 'g', members: [{ agent_id: c.id, role: 'coordinator', credential_id: c.cred.id }, { agent_id: a.id, role: 'worker', credential_id: a.cred.id }] }, sys).id;
    app.teams.start(tid, sys);
    const t = (await issue(w, a.key)).body.token as string;
    app.teams.pause(tid, 'checkout:co_test', sys);
    expect((await cn('POST', '/turn-tokens/renew', w.appKey, { token: t })).status).toBe(200);
    expect((await rpc(asToken(t), 'session_whoami')).body.result?.structuredContent?.agent_id).toBe(a.id);
  });
});
