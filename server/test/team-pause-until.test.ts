/**
 * A team pause with an end time (docs/specification.md, Task turns and deadlines: Pause; docs/mcp.md, Pausing the team).
 * A coordinator pauses its team for at most 24 hours and ends only its own pause; the hub resumes the team by itself at
 * the end time, so leases restart and nothing lapses; the operator ends any pause early; a pause past its end alerts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import { intakeOpen } from './intake.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
const HOUR = 60 * 60_000;
let app: App, base: string, cookie = '', csrf = '', appKey = '';

const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
type Call = (name: string, args?: Record<string, unknown>) => Promise<{ isError?: boolean; structuredContent?: any; content: { text: string }[] }>;
async function loginWith(secret: string): Promise<Call> {
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  const token = ((await c.callTool({ name: 'session_login', arguments: { session_key: secret } })) as any).structuredContent.session_token as string;
  return async (name, args = {}) => (await c.callTool({ name, arguments: { session_token: token, ...args } })) as never;
}
const mk = (label: string) => {
  const agent = app.keys.createAgent(label, null, sys);
  const k = app.keys.createSessionKey({ agentId: agent.id, label: `${label} key` }, sys);
  return { id: agent.id, secret: k.secret };
};
let n = 0;
/** As if the member had made no call for `ms`. */
const silence = (teamId: string, agentId: string, ms: number) => {
  const at = Date.now() - ms;
  app.db.prepare('UPDATE agents SET last_seen_at=? WHERE id=?').run(at, agentId);
  app.db.prepare('UPDATE team_members SET joined_at=MIN(joined_at, ?), last_work_next_at=MIN(COALESCE(last_work_next_at, ?), ?), busy_until=busy_until-? WHERE team_id=? AND agent_id=? AND removed_at IS NULL')
    .run(at, at, at, ms, teamId, agentId);
};
async function team() {
  const [c, w] = ['coord', 'work'].map((l) => mk(`${l}${++n}`)) as ReturnType<typeof mk>[];
  const res = await api('POST', '/teams', { name: `pause${n}`, goal: 'ship it', members: [{ agent_id: c!.id, role: 'coordinator' }, { agent_id: w!.id, role: 'worker' }] });
  expect(res.status).toBe(201);
  const tid = res.body.team.id as string;
  expect((await api('POST', `/teams/${tid}/start`)).status).toBe(200);
  return { tid, c: c!, w: w!, C: await loginWith(c!.secret), W: await loginWith(w!.secret) };
}
const notices = (agentId: string, kind: string) => app.db.prepare('SELECT body FROM agent_notices WHERE agent_id=? AND kind=?').all(agentId, kind) as { body: string }[];
const err = (r: { structuredContent?: any }) => r.structuredContent?.error as string | undefined;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahpause-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  app = await buildApp(testConfig(dir, { vaultDir: join(dir, 'vault'), vaultScanSeconds: undefined, vaultWatch: undefined, maintenanceSeconds: undefined }));
  intakeOpen(app);
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base));
  const pc = (await api('POST', '/pcs', { name: 'pc' })).body.pc.id;
  appKey = app.keys.createAppKey({ machineId: pc, appName: 'claude-code', maxLiveSessions: 100 }, sys).secret;
});
afterAll(async () => { await app.close(); });

describe('a pause with an end time', () => {
  it('resumes by itself when the time passes: the lease restarts and no task lapsed', async () => {
    const X = await team();
    const t = (await X.C('task_create', { team_id: X.tid, title: 'hold me' })).structuredContent.task;
    await X.C('task_assign', { task_id: t.id, agent_id: X.w.id });
    expect((await X.W('task_start', { task_id: t.id })).structuredContent.task.status).toBe('in_progress');

    const until = Date.now() + 4 * HOUR;
    const p = await X.C('team_pause', { team_id: X.tid, reason: 'usage limit', until });
    expect(p.structuredContent).toMatchObject({ status: 'paused', paused_until: until, paused_note: 'usage limit' });
    // A member sees the end time and the reason in team_info and in the paused work_next answer.
    const info = (await X.W('team_info', { team_id: X.tid })).structuredContent.teams[0];
    expect(info).toMatchObject({ status: 'paused', paused_reason: 'coordinator', paused_until: until, paused_note: 'usage limit' });
    let wn = (await X.W('work_next', { wait_seconds: 0 })).structuredContent;
    // Pending notices (team started, team paused) come first; past them, the paused answer.
    for (let i = 0; wn.status === 'item' && i < 10; i++) { await X.W('work_ack', { item_id: wn.item.item_id }); wn = (await X.W('work_next', { wait_seconds: 0 })).structuredContent; }
    expect(wn).toMatchObject({ status: 'paused', paused_until: until, paused_note: 'usage limit' });
    expect(wn.note).toMatch(/until .* UTC .*usage limit.*resumes by itself/);

    // Everyone is silent for far longer than a lease while the team waits; then the end time passes.
    silence(X.tid, X.w.id, 3 * HOUR);
    app.teams.tick();
    expect(app.teams.task(t.id)).toMatchObject({ status: 'in_progress', assignee_agent_id: X.w.id });
    app.db.prepare('UPDATE teams SET paused_until=? WHERE id=?').run(Date.now() - 1000, X.tid);
    const before = Date.now();
    app.teams.tick();

    const tm = app.teams.team(X.tid)!;
    expect(tm).toMatchObject({ status: 'running', paused_reason: null, paused_until: null, paused_note: null });
    const k = app.teams.task(t.id)!;
    expect(k).toMatchObject({ status: 'in_progress', assignee_agent_id: X.w.id });
    expect(k.lease_expires_at!).toBeGreaterThanOrEqual(before + tm.lease_minutes * 60_000 - 1000);
    expect(notices(X.w.id, 'lease_expired')).toHaveLength(0);
    expect(notices(X.w.id, 'team_resumed')).toHaveLength(1); // it has a task in progress: woken
    expect(notices(X.w.id, 'team_resumed_note')).toHaveLength(0);
    expect(notices(X.c.id, 'team_resumed')).toHaveLength(1); // the coordinator has no task of its own: woken all the same
    expect(notices(X.c.id, 'team_resumed_note')).toHaveLength(0);
    // Audited with the system as the actor.
    const ev = app.db.prepare("SELECT actor_kind FROM audit_events WHERE action='team.resume' AND target_id=?").all(X.tid) as { actor_kind: string }[];
    expect(ev).toEqual([{ actor_kind: 'system' }]);
  });

  it('a coordinator is always woken on resume, whatever the tasks; another member without a task is only told', async () => {
    const X = await team();
    const t = (await X.C('task_create', { team_id: X.tid, title: 'unassigned' })).structuredContent.task; // open, nobody holds it
    app.teams.pause(X.tid, 'coordinator', sys);
    app.teams.resume(X.tid, sys);
    expect(notices(X.c.id, 'team_resumed')).toHaveLength(1);
    expect(notices(X.w.id, 'team_resumed_note')).toHaveLength(1); // another member without a task is still only told
    expect(notices(X.w.id, 'team_resumed')).toHaveLength(0);
    // Every task closed: the coordinator is woken all the same, the worker still only told.
    app.db.prepare("UPDATE tasks SET status='cancelled' WHERE id=?").run(t.id);
    app.teams.pause(X.tid, 'coordinator', sys);
    app.teams.resume(X.tid, sys);
    expect(notices(X.c.id, 'team_resumed')).toHaveLength(2);
    expect(notices(X.c.id, 'team_resumed_note')).toHaveLength(0);
    expect(notices(X.w.id, 'team_resumed_note')).toHaveLength(2);
  });

  it('a coordinator sets at most 24 hours ahead, in the future, and only a coordinator may', async () => {
    const X = await team();
    const r = await X.C('team_pause', { team_id: X.tid, reason: 'usage limit', until: Date.now() + 25 * HOUR });
    expect(err(r)).toBe('invalid_argument');
    expect(r.content[0]!.text).toMatch(/more than 24 hours/);
    expect(err(await X.C('team_pause', { team_id: X.tid, reason: 'x', until: Date.now() - 1000 }))).toBe('invalid_argument');
    expect(err(await X.W('team_pause', { team_id: X.tid, reason: 'x', until: Date.now() + HOUR }))).toBe('denied');
    expect(app.teams.team(X.tid)!.status).toBe('running');
    // Already paused: lengthening is the operator's.
    expect(err(await X.C('team_pause', { team_id: X.tid, reason: 'x', until: Date.now() + HOUR }))).toBeUndefined();
    expect(err(await X.C('team_pause', { team_id: X.tid, reason: 'longer', until: Date.now() + 2 * HOUR }))).toBe('invalid_state');
  });

  it('team_resume ends a coordinator\'s pause at once, and refuses the operator\'s, a limit\'s and a checkout\'s with the reason', async () => {
    const X = await team();
    await X.C('team_pause', { team_id: X.tid, reason: 'usage limit', until: Date.now() + HOUR });
    expect((await X.W('team_resume', { team_id: X.tid })).structuredContent.error).toBe('denied');
    expect((await X.C('team_resume', { team_id: X.tid })).structuredContent).toMatchObject({ status: 'running' });
    // No member has a task: nobody is woken, everyone is told.
    expect(notices(X.w.id, 'team_resumed')).toHaveLength(0);
    expect(notices(X.w.id, 'team_resumed_note')).toHaveLength(1);

    expect((await api('POST', `/teams/${X.tid}/pause`)).status).toBe(200);
    let r = await X.C('team_resume', { team_id: X.tid });
    expect(err(r)).toBe('invalid_state');
    expect(r.content[0]!.text).toMatch(/operator paused the team/);
    expect((await api('POST', `/teams/${X.tid}/resume`)).status).toBe(200);

    for (const [reason, says] of [['limit:tasks', /tasks limit/], ['checkout:co_x', /checkout holds the team/]] as const) {
      app.teams.pause(X.tid, reason, sys);
      r = await X.C('team_resume', { team_id: X.tid });
      expect(err(r)).toBe('invalid_state');
      expect(r.content[0]!.text).toMatch(says);
      app.db.prepare("UPDATE teams SET status='running', paused_reason=NULL, paused_at=NULL WHERE id=?").run(X.tid);
    }
  });

  it('the operator ends a coordinator\'s pause early, or changes it, after which the coordinator cannot end it', async () => {
    const X = await team();
    await X.C('team_pause', { team_id: X.tid, reason: 'usage limit', until: Date.now() + HOUR });
    expect((await api('POST', `/teams/${X.tid}/resume`)).body.team.status).toBe('running');

    await X.C('team_pause', { team_id: X.tid, reason: 'usage limit', until: Date.now() + HOUR });
    const later = Date.now() + 30 * HOUR;
    const ch = await api('POST', `/teams/${X.tid}/pause`, { until: later, reason: 'maintenance' });
    expect(ch.status).toBe(200);
    expect(ch.body.team).toMatchObject({ status: 'paused', paused_reason: 'admin', paused_until: later, paused_note: 'maintenance' });
    expect(err(await X.C('team_resume', { team_id: X.tid }))).toBe('invalid_state');
    expect((await api('POST', `/teams/${X.tid}/pause`, { until: Date.now() - 5 })).status).toBe(400);
  });

  it('a coordinator\'s pause is For awareness; an operator\'s or a limit\'s is Needs you with Resume', async () => {
    const X = await team();
    const until = Date.now() + HOUR;
    await X.C('team_pause', { team_id: X.tid, reason: 'usage limit', until });
    let ny = (await api('GET', `/needs-you?team=${X.tid}`)).body;
    expect(ny.items.filter((r: any) => r.kind === 'team_pause')).toHaveLength(0);
    expect(ny.awareness.items.find((r: any) => r.kind === 'team_paused')).toMatchObject({ until, reason: 'usage limit, by the coordinator', open: { kind: 'team', id: X.tid } });

    await api('POST', `/teams/${X.tid}/pause`, { until, reason: 'maintenance' });
    ny = (await api('GET', `/needs-you?team=${X.tid}`)).body;
    expect(ny.awareness.items.filter((r: any) => r.kind === 'team_paused')).toHaveLength(0);
    const row = ny.items.find((r: any) => r.kind === 'team_pause');
    expect(row).toMatchObject({ until, reason: 'maintenance, by the operator', actions: [{ id: 'resume' }] });
    const act = await api('POST', '/needs-you/act', { id: row.id, version: row.source.version, action: 'resume', filter: { team: X.tid } });
    expect(act.status).toBe(200);
    expect(app.teams.team(X.tid)!.status).toBe('running');

    app.teams.pause(X.tid, 'limit:tasks', sys);
    expect((await api('GET', `/needs-you?team=${X.tid}`)).body.items.find((r: any) => r.kind === 'team_pause')).toMatchObject({ reason: 'team limit: tasks' });
    app.db.prepare("UPDATE teams SET status='running', paused_reason=NULL, paused_at=NULL WHERE id=?").run(X.tid);
    app.teams.pause(X.tid, 'checkout:co_x', sys);
    expect((await api('GET', `/needs-you?team=${X.tid}`)).body.items.filter((r: any) => r.kind === 'team_pause')).toHaveLength(0);
  });

  it('a pause past its end time that did not resume raises one alert', async () => {
    const X = await team();
    await X.C('team_pause', { team_id: X.tid, reason: 'usage limit', until: Date.now() + HOUR });
    const keep = app.teams.beforeResume;
    app.teams.beforeResume = () => { throw new Error('held'); };
    try {
      app.db.prepare('UPDATE teams SET paused_until=? WHERE id=?').run(Date.now() - 3 * 60_000, X.tid);
      app.teams.tick(); app.teams.tick();
    } finally { app.teams.beforeResume = keep; }
    expect(app.teams.team(X.tid)!.status).toBe('paused');
    expect(app.db.prepare("SELECT COUNT(*) n FROM security_alerts WHERE type='pause_overrun' AND subject=?").get(X.tid)).toMatchObject({ n: 1 });
    // The next tick resumes it.
    app.teams.tick();
    expect(app.teams.team(X.tid)!.status).toBe('running');
  });
});
