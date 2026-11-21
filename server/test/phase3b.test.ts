import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import { intakeOpen } from './intake.js';
import type { Config } from '../src/config.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base: string, cookie = '', csrf = '', appKey = '', pcId = '';

const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
type Call = (name: string, args?: Record<string, unknown>) => Promise<{ isError?: boolean; structuredContent?: any; content: { text: string }[] }>;
async function loginWith(key: string, secret: string): Promise<Call> {
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  const token = ((await c.callTool({ name: 'session_login', arguments: { session_key: secret } })) as any).structuredContent.session_token as string;
  return async (name, args = {}) => (await c.callTool({ name, arguments: { session_token: token, ...args } })) as never;
}
const mk = (label: string) => {
  const agent = app.keys.createAgent(label, null, sys);
  const k = app.keys.createSessionKey({ agentId: agent.id, label: `${label} key` }, sys);
  return { id: agent.id, secret: k.secret, cred: k.credential, login: () => loginWith(appKey, k.secret) };
};
let n = 0;
const cid = () => `c${++n}`;
/** As if the member had made no call for `ms`: its activity and declared busy-until time move back by `ms`. */
const silence = (teamId: string, agentId: string, ms: number) => {
  const at = Date.now() - ms;
  app.db.prepare('UPDATE agents SET last_seen_at=? WHERE id=?').run(at, agentId);
  app.db.prepare('UPDATE team_members SET joined_at=MIN(joined_at, ?), last_work_next_at=MIN(COALESCE(last_work_next_at, ?), ?), busy_until=busy_until-? WHERE team_id=? AND agent_id=? AND removed_at IS NULL')
    .run(at, at, at, ms, teamId, agentId);
};

/** coordinator + 2 workers + reviewer + stakeholder; created, started and logged in. */
async function team(extra: Record<string, unknown> = {}, start = true) {
  const [c, w1, w2, r, s] = ['coord', 'w1', 'w2', 'rev', 'stake'].map(mk) as ReturnType<typeof mk>[];
  const res = await api('POST', '/teams', {
    name: `t${++n}`, goal: 'ship it', grant_messaging: true, ...extra,
    members: [{ agent_id: c!.id, role: 'coordinator' }, { agent_id: w1!.id, role: 'worker' }, { agent_id: w2!.id, role: 'worker' }, { agent_id: r!.id, role: 'reviewer' }, { agent_id: s!.id, role: 'stakeholder' }],
  });
  expect(res.status).toBe(201);
  const tid = res.body.team.id as string;
  if (start) expect((await api('POST', `/teams/${tid}/start`)).status).toBe(200);
  const [C, W1, W2, R, S] = await Promise.all([c!, w1!, w2!, r!, s!].map((x) => x.login()));
  return { tid, c: c!, w1: w1!, w2: w2!, r: r!, s: s!, C: C!, W1: W1!, W2: W2!, R: R!, S: S!, room: res.body.team.room_id as string };
}
type T = Awaited<ReturnType<typeof team>>;
/** Puts the agent in a second team of its own and returns that team's project: an agent is in the projects of its live teams. */
async function projectWith(agentId: string, name: string) {
  const res = await api('POST', '/teams', { name: `${name}${++n}`, goal: 'project reach', members: [{ agent_id: agentId, role: 'coordinator' }] });
  expect(res.status).toBe(201);
  return app.blueprint.projectOfTeam(res.body.team.id as string)!;
}
/** Ack everything pending so later assertions see a clean queue. */
async function drain(call: Call) {
  for (let i = 0; i < 30; i++) {
    const r = (await call('work_next', { wait_seconds: 0 })).structuredContent;
    if (r.status !== 'item') return;
    await call('work_ack', { item_id: r.item.item_id });
  }
}
/** The next work item that is not a notice; notices (task_assigned, review_requested…) are acked on the way. */
async function nextWork(call: Call): Promise<any> {
  for (let i = 0; i < 30; i++) {
    const r = (await call('work_next', { wait_seconds: 0 })).structuredContent;
    if (r.status === 'item' && r.item.kind === 'notice') { await call('work_ack', { item_id: r.item.item_id }); continue; }
    return r.item ?? r;
  }
  throw new Error('too many notices');
}
const mkTask = async (X: T, over: Record<string, unknown> = {}) =>
  (await X.C('task_create', { team_id: X.tid, title: 'do it', reviewer: X.r.id, ...over })).structuredContent.task;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah3b-'));
  const vaultDir = join(dir, 'vault');
  mkdirSync(vaultDir, { recursive: true });
  const config: Config = testConfig(dir, { vaultDir, vaultScanSeconds: undefined, vaultWatch: undefined, maintenanceSeconds: undefined });
  app = await buildApp(config);
  intakeOpen(app);
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base));
  pcId = (await api('POST', '/pcs', { name: 'pc' })).body.pc.id;
  const ak = app.keys.createAppKey({ machineId: pcId, appName: 'claude-code', maxLiveSessions: 500 }, sys);
  appKey = ak.secret;
  // Recruits' keys are picked up on the coordinator's PC (docs/onboarding.md#recruits-from-a-coordinator): this PC can.
  app.keys.setOnboarding(ak.credential.id, true, sys);
});
/** The PC's setup client: picks up a recruit's key and confirms; returns the key the client would write to keys.env. */
async function pickup(p: { request_id: string; session_var: string }): Promise<string> {
  const post = (path: string, body: unknown) => fetch(`${base}/onboard${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${appKey}` }, body: JSON.stringify(body) }).then((r) => r.json()) as Promise<any>;
  const k = await post('/pickup', { request_id: p.request_id });
  await post('/pickup/confirm', { pickup_id: k.pickup_id, written: [p.session_var] });
  return k.agents[0].secret as string;
}
afterAll(async () => { await app.close(); });

describe('task workflow', () => {
  it('runs coordinator -> worker -> reviewer -> done', async () => {
    const X = await team();
    await Promise.all([X.C, X.W1, X.R, X.S].map(drain));
    const t = await mkTask(X);
    expect(t.status).toBe('open');
    expect((await X.C('task_assign', { task_id: t.id, agent_id: X.w1.id })).structuredContent.task.status).toBe('assigned');
    const item = await nextWork(X.W1);
    expect(item).toMatchObject({ kind: 'task_assigned', trust: 'L1' });
    expect(item.task.id).toBe(t.id);
    expect((await X.W1('work_ack', { item_id: item.item_id })).isError).toBeFalsy();
    expect((await X.W1('task_start', { task_id: t.id })).structuredContent.task.status).toBe('in_progress');
    expect((await X.W1('task_submit', { task_id: t.id, summary: 'finished' })).structuredContent.task.status).toBe('in_review');
    const rev = await nextWork(X.R);
    expect(rev).toMatchObject({ kind: 'review_requested', trust: 'L1' });
    await X.R('work_ack', { item_id: rev.item_id });
    expect((await X.R('task_review', { task_id: t.id, decision: 'approve', comments: 'lgtm', version: 1000 })).structuredContent.task.status).toBe('approved');
    expect((await X.W1('task_complete', { task_id: t.id })).structuredContent.error).toBe('denied');
    expect((await X.C('task_complete', { task_id: t.id })).structuredContent.task.status).toBe('done');
    const d = await api('GET', `/teams/${X.tid}`);
    expect(d.body.team.counts.done).toBe(1);
    expect(d.body.team.progress).toMatchObject({ done: 1, total: 1, pct: 100 });
    expect(d.body.team.board[0].status).toBe('done');
    const m = await api('GET', '/metrics');
    expect(m.body.counts.tasks_done_24h).toBeGreaterThanOrEqual(1);
    expect(m.body.series.tasks_done).toHaveLength(24);
  });

  it('refuses self-review and role violations', async () => {
    const X = await team();
    const t = await mkTask(X);
    expect((await X.C('task_assign', { task_id: t.id, agent_id: X.w1.id, reviewer: X.w1.id })).structuredContent.error).toBe('invalid_argument');
    expect((await X.C('task_assign', { task_id: t.id, agent_id: X.r.id })).structuredContent.error).toBe('invalid_argument');
    await X.C('task_assign', { task_id: t.id, agent_id: X.w1.id });
    await X.W1('task_start', { task_id: t.id });
    await X.W1('task_submit', { task_id: t.id, summary: 'x' });
    for (const c of [X.W1, X.W2, X.C]) expect((await c('task_review', { task_id: t.id, decision: 'approve', comments: 'self', version: 1000 })).structuredContent.error).toBe('denied');
    expect((await X.W1('task_create', { team_id: X.tid, title: 'x' })).structuredContent.error).toBe('denied');
    expect((await X.W2('task_submit', { task_id: t.id, summary: 'x' })).structuredContent.error).toBe('denied');
    expect((await X.R('task_review', { task_id: t.id, decision: 'approve', comments: 'ok', version: 1000 })).isError).toBeFalsy();
  });

  it('a blocked task closes its alert once it is unblocked', async () => {
    const X = await team();
    const t = await mkTask(X);
    await X.C('task_assign', { task_id: t.id, agent_id: X.w1.id });
    await X.W1('task_start', { task_id: t.id });
    const alert = () => (app.db.prepare("SELECT status FROM security_alerts WHERE type='task_blocked' AND subject=?").get(t.id) as { status: string } | undefined)?.status;
    await X.C('task_block', { task_id: t.id, reason: 'waits for the cluster' });
    expect(alert()).toBe('open');
    await X.C('task_progress', { task_id: t.id, note: 'still blocked' }); // a note on a blocked task leaves it open
    expect(alert()).toBe('open');
    expect((await X.C('task_unblock', { task_id: t.id })).structuredContent.task.status).toBe('in_progress');
    expect(alert()).toBe('closed');
  });

  it('a member whose role lacks the action is told who may and what to use; others still get the generic denial', async () => {
    const X = await team();
    const t = await mkTask(X);
    await X.C('task_assign', { task_id: t.id, agent_id: X.w1.id });
    await X.W1('task_start', { task_id: t.id });
    const NF = 'Not allowed, or does not exist.';
    const sc = async (c: Call, tool: string, args: Record<string, unknown>) => (await c(tool, args)).structuredContent;
    for (const [tool, args, phrase] of [
      ['task_block', { task_id: t.id, reason: 'nothing to add' }, 'block a task'],
      ['task_cancel', { task_id: t.id, reason: 'x' }, 'cancel a task'],
      ['task_complete', { task_id: t.id }, 'complete a task'],
    ] as const) {
      const r = await sc(X.W1, tool, args);
      expect(r.error).toBe('denied');
      expect(r.message).toContain(`Only the team coordinator can ${phrase}. As worker, report on your task with task_progress or task_submit`);
    }
    // Same shape for other roles and actions.
    expect((await sc(X.R, 'task_create', { team_id: X.tid, title: 'x' })).message).toMatch(/^Only the team coordinator can create a task\. As reviewer, review the tasks that name you with task_review/);
    expect((await sc(X.C, 'task_claim', { task_id: t.id, version: 1 })).message).toMatch(/^Only the team worker can claim a task\. As coordinator, /);
    // A non-member learns nothing about the team or the task.
    const out = mk('outsider'), O = await out.login();
    const o = await sc(O, 'task_block', { task_id: t.id, reason: 'x' });
    expect(o).toMatchObject({ error: 'denied' });
    expect(o.message.startsWith('Not allowed')).toBe(true);
    expect(o.message).not.toContain(t.id);
    // A member whose role allows the action but whose rules deny it keeps the generic denial too.
    app.keys.setRules(X.c.cred.policy_id, [{ effect: 'deny', actions: ['task.block'], resource: `team:${X.tid}` }], 'test', sys);
    const d = await sc(X.C, 'task_block', { task_id: t.id, reason: 'x' });
    expect(d.error).toBe('denied');
    expect(d.message.startsWith(NF)).toBe(true);
    expect((await sc(X.C, 'task_cancel', { task_id: t.id, reason: 'x' })).message.startsWith(NF)).toBe(true);
    // It was the rule (the tool itself stays allowed): without it the coordinator can cancel.
    app.keys.setRules(X.c.cred.policy_id, [], 'test', sys);
    expect((await sc(X.C, 'task_cancel', { task_id: t.id, reason: 'x' })).task.status).toBe('cancelled');
  });

  it('first claim wins, the others get conflict', async () => {
    const X = await team();
    const t = await mkTask(X, { claimable: true });
    const [a, b] = await Promise.all([X.W1('task_claim', { task_id: t.id, version: t.version }), X.W2('task_claim', { task_id: t.id, version: t.version })]);
    const codes = [a, b].map((x) => (x.isError ? x.structuredContent.error : 'ok')).sort();
    expect(codes).toEqual(['conflict', 'ok']);
    const winner = a.isError ? X.w2.id : X.w1.id;
    expect((await X.C('task_list', { team_id: X.tid })).structuredContent.tasks[0]).toMatchObject({ status: 'assigned', assignee: winner });
    const nc = await mkTask(X);
    expect((await X.W1('task_claim', { task_id: nc.id, version: nc.version })).structuredContent.error).toBe('invalid_state');
  });

  it('given any team, an assigned member who stays asleep keeps its work: nothing returns to open, no lease_expired notice', async () => {
    const X = await team();
    await drain(X.C);
    const t = await mkTask(X);
    await X.C('task_assign', { task_id: t.id, agent_id: X.w1.id });
    // A queued task has no deadline: silence alone never moves it.
    expect(app.teams.task(t.id)!.lease_expires_at).toBeNull();
    for (const ms of [31 * 60_000, 26 * 3600_000, 9 * 86_400_000]) {
      silence(X.tid, X.w1.id, ms);
      app.teams.tick(true);
      expect((await X.C('task_list', { team_id: X.tid })).structuredContent.tasks[0]).toMatchObject({ status: 'assigned', assignee: X.w1.id });
    }
    expect(app.teams.task(t.id)).toMatchObject({ lapsed_from: null, overdue_at: null });
    expect(app.db.prepare("SELECT COUNT(*) n FROM agent_notices WHERE kind='lease_expired' AND agent_id IN (?, ?)").get(X.c.id, X.w1.id)).toMatchObject({ n: 0 });
    // The worker wakes days later and starts it.
    expect((await X.W1('task_start', { task_id: t.id })).structuredContent.task.status).toBe('in_progress');
  });

  it('8.A1-8.A3: the clock starts at task_start, and task_progress until keeps everything the member holds', async () => {
    const X = await team({ lease_minutes: 30 });
    const [a, b, c] = [await mkTask(X), await mkTask(X), await mkTask(X)];
    for (const k of [a, b, c]) await X.C('task_assign', { task_id: k.id, agent_id: X.w1.id });
    // 8.A3: assigned "at 10:00", started "at 11:30": the lease counts from the start, not the assignment.
    app.db.prepare('UPDATE tasks SET updated_at=updated_at-5400000 WHERE id=?').run(a.id);
    app.db.prepare('UPDATE task_turns SET opened_at=opened_at-5400000 WHERE task_id=? AND closed_at IS NULL').run(a.id);
    app.db.prepare("UPDATE task_events SET created_at=created_at-5400000 WHERE task_id=? AND to_status='assigned'").run(a.id);
    expect(app.teams.task(a.id)).toMatchObject({ lease_expires_at: null, started_at: null });
    const before = Date.now();
    await X.W1('task_start', { task_id: a.id });
    const started = app.teams.task(a.id)!;
    expect(started.started_at).toBeGreaterThanOrEqual(before);
    expect(started.lease_expires_at! - started.started_at!).toBeGreaterThanOrEqual(30 * 60_000);
    expect(started.lease_expires_at! - started.started_at!).toBeLessThan(31 * 60_000);
    expect(app.db.prepare("SELECT due_at FROM task_turns WHERE task_id=? AND closed_at IS NULL AND phase='work'").get(a.id)).toMatchObject({ due_at: started.lease_expires_at });
    expect(app.teams.task(b.id)!.lease_expires_at).toBeNull();
    // 8.A1: busy for 3 h, then silent for 2 h: A, B and C stay with W.
    const until = Date.now() + 3 * 3600_000;
    await X.W1('task_progress', { task_id: a.id, note: 'long run', until });
    expect((app.db.prepare('SELECT busy_until FROM team_members WHERE team_id=? AND agent_id=? AND removed_at IS NULL').get(X.tid, X.w1.id) as { busy_until: number }).busy_until).toBe(until);
    silence(X.tid, X.w1.id, 2 * 3600_000);
    app.teams.tick();
    for (const k of [a, b, c]) expect(app.teams.task(k.id)!.assignee_agent_id).toBe(X.w1.id);
    expect(app.teams.task(a.id)!.status).toBe('in_progress');
    // One delivery model: silent long past the check-in time, nothing is released. The started task is flagged overdue
    // once its own check-in time passes and stays with W; the queued ones have no deadline and are never flagged.
    silence(X.tid, X.w1.id, 3600_000 + 31 * 60_000);
    app.teams.tick();
    expect(app.teams.task(a.id)!.overdue_at ?? null).toBeNull();
    app.db.prepare('UPDATE tasks SET lease_expires_at=? WHERE id=?').run(Date.now() - 1000, a.id);
    app.db.prepare("UPDATE task_turns SET due_at=? WHERE task_id=? AND closed_at IS NULL AND phase='work'").run(Date.now() - 1000, a.id);
    app.teams.tick(true);
    expect(app.teams.task(a.id)).toMatchObject({ status: 'in_progress', assignee_agent_id: X.w1.id });
    expect(app.teams.task(a.id)!.overdue_at).toBeGreaterThan(0);
    for (const k of [b, c]) expect(app.teams.task(k.id)).toMatchObject({ status: 'assigned', assignee_agent_id: X.w1.id, overdue_at: null });
    for (const k of [a, b, c]) {
      expect(app.db.prepare("SELECT COUNT(*) n FROM task_events WHERE task_id=? AND to_status='open' AND from_status IS NOT NULL AND from_status<>'open'").get(k.id)).toMatchObject({ n: 0 });
      expect(app.db.prepare('SELECT COUNT(*) n FROM task_turns WHERE task_id=? AND closed_at IS NULL').get(k.id)).toMatchObject({ n: 1 });
    }
    expect(app.db.prepare("SELECT COUNT(*) n FROM agent_notices WHERE kind='lease_expired' AND agent_id IN (?, ?)").get(X.c.id, X.w1.id)).toMatchObject({ n: 0 });
  });

  it('8.A2 boundary: a member overrunning its busy_until keeps its tasks, however long past it', async () => {
    const X = await team({ lease_minutes: 30 });
    const [a, b] = [await mkTask(X), await mkTask(X)];
    for (const k of [a, b]) await X.C('task_assign', { task_id: k.id, agent_id: X.w1.id });
    await X.W1('task_start', { task_id: a.id });
    await X.W1('task_progress', { task_id: a.id, note: 'long run', until: Date.now() + 3 * 3600_000 });
    // Declared until 18:00, last call at 15:00, now 18:01: still inside the lease (until 18:30).
    const setClock = (busyAgo: number) => {
      const now = Date.now(), last = now - busyAgo - 3 * 3600_000;
      app.db.prepare('UPDATE agents SET last_seen_at=? WHERE id=?').run(last, X.w1.id);
      app.db.prepare('UPDATE team_members SET joined_at=MIN(joined_at, ?), last_work_next_at=?, busy_until=? WHERE team_id=? AND agent_id=? AND removed_at IS NULL').run(last, last, now - busyAgo, X.tid, X.w1.id);
    };
    setClock(60_000);
    app.teams.tick();
    for (const k of [a, b]) expect(app.teams.task(k.id)!.assignee_agent_id).toBe(X.w1.id);
    // 18:31, and a day later: still held (the previous release returned both to open at 18:31).
    for (const ago of [31 * 60_000, 24 * 3600_000]) {
      setClock(ago);
      app.teams.tick();
      expect(app.teams.task(a.id)).toMatchObject({ status: 'in_progress', assignee_agent_id: X.w1.id });
      expect(app.teams.task(b.id)).toMatchObject({ status: 'assigned', assignee_agent_id: X.w1.id });
    }
  });

  it('a task assigned to a member already silent for hours stays assigned at every sweep', async () => {
    const X = await team({ lease_minutes: 30 });
    const t = await mkTask(X);
    silence(X.tid, X.w1.id, 2 * 3600_000);
    await X.C('task_assign', { task_id: t.id, agent_id: X.w1.id });
    app.teams.tick(true);
    app.teams.tick(true);
    expect(app.teams.task(t.id)).toMatchObject({ status: 'assigned', assignee_agent_id: X.w1.id });
    expect(app.db.prepare("SELECT COUNT(*) n FROM agent_notices WHERE agent_id=? AND kind='lease_expired'").get(X.c.id)).toMatchObject({ n: 0 });
  });

  it('8.A4: an on-demand task assigned for 3 days and never started is not overdue and does not stall its assignee', async () => {
    const X = await team();
    const t = await mkTask(X);
    await X.C('task_assign', { task_id: t.id, agent_id: X.w1.id });
    const back = 3 * 86_400_000;
    app.db.prepare('UPDATE tasks SET updated_at=updated_at-?, created_at=created_at-? WHERE id=?').run(back, back, t.id);
    app.db.prepare('UPDATE task_turns SET opened_at=opened_at-? WHERE task_id=?').run(back, t.id);
    silence(X.tid, X.w1.id, back);
    app.teams.tick(true);
    expect(app.teams.task(t.id)).toMatchObject({ status: 'assigned', assignee_agent_id: X.w1.id, lease_expires_at: null, overdue_at: null });
    expect(app.db.prepare("SELECT COUNT(*) n FROM security_alerts WHERE type='task_overdue' AND subject=?").get(t.id)).toMatchObject({ n: 0 });
    expect(app.db.prepare("SELECT COUNT(*) n FROM agent_notices WHERE kind='task_overdue' AND ref_task_id=?").get(t.id)).toMatchObject({ n: 0 });
    const tm = app.teams.team(X.tid)!, m = app.teams.members(X.tid).find((x) => x.agent_id === X.w1.id)!;
    expect(app.teams.stalled(tm, m)).toBe(false);
  });

  it('blocks a task at the review round limit and raises an alert', async () => {
    const X = await team({ max_review_rounds: 2 });
    const t = await mkTask(X);
    await X.C('task_assign', { task_id: t.id, agent_id: X.w1.id });
    await X.W1('task_start', { task_id: t.id });
    await X.W1('task_submit', { task_id: t.id, summary: 'v1' });
    expect((await X.R('task_review', { task_id: t.id, decision: 'request_changes', comments: 'fix a', version: 1000 })).structuredContent.task.status).toBe('changes_requested');
    expect((await X.W1('task_start', { task_id: t.id })).structuredContent.task.status).toBe('in_progress');
    await X.W1('task_submit', { task_id: t.id, summary: 'v2' });
    const last = (await X.R('task_review', { task_id: t.id, decision: 'request_changes', comments: 'fix b', version: 1000 })).structuredContent.task;
    expect(last).toMatchObject({ status: 'blocked', review_rounds: 2 });
    const alerts = app.db.prepare("SELECT COUNT(*) n FROM security_alerts WHERE type='task_blocked' AND subject=?").get(t.id) as { n: number };
    expect(alerts.n).toBe(1);
    expect((await mkTask(X)).status).toBe('open');
    expect(app.teams.team(X.tid)!.status).toBe('running');
  });

  it('checkpoint: coordinator completion waits for the administrator', async () => {
    const X = await team({ checkpoints: ['done'] });
    const t = await mkTask(X);
    await X.C('task_assign', { task_id: t.id, agent_id: X.w1.id });
    await X.W1('task_start', { task_id: t.id });
    await X.W1('task_submit', { task_id: t.id, summary: 'x' });
    await X.R('task_review', { task_id: t.id, decision: 'approve', comments: 'ok', version: 1000 });
    const r = (await X.C('task_complete', { task_id: t.id })).structuredContent;
    expect(r).toMatchObject({ awaiting_approval: true, task: { status: 'approved' } });
    // The teams list shows the lead, the approval waiting on the operator, and when the team last moved.
    const row = () => api('GET', '/teams').then((x) => x.body.teams.find((tm: any) => tm.id === X.tid));
    const before = await row();
    expect(before).toMatchObject({ lead_id: X.c.id, approvals: 1 });
    expect(before.last_activity_at).toBeGreaterThanOrEqual(r.task.updated_at);
    const ap = await api('POST', `/teams/${X.tid}/tasks/${t.id}/approve`);
    expect(ap.body.task.status).toBe('done');
    expect((await row()).approvals).toBe(0);
  });

  it('team status: the administrator asks, the coordinator is told, bp_report becomes the status and closes the request', async () => {
    const X = await team();
    expect((await api('GET', `/teams/${X.tid}`)).body.team.status_report).toBeNull();
    const rq = await api('POST', `/teams/${X.tid}/status-request`, { note: 'Before Friday' });
    expect(rq.body.team.status_requested_at).toBeGreaterThan(0);
    const n = (await X.C('session_whoami', {})).structuredContent.notices as { kind: string; body: string }[];
    expect(n.some((x) => x.kind === 'status_request' && x.body.includes('bp_report') && x.body.includes('Before Friday'))).toBe(true);
    expect((await X.C('bp_report', { team_id: X.tid, health: 'on_track', done: ['2 done, 1 doing'] })).isError).toBeFalsy();
    const t = (await api('GET', `/teams/${X.tid}`)).body.team;
    expect(t.status_report.body).toContain('2 done');
    expect(t.status_requested_at).toBeNull();
    // One report a day unless the operator asks again (docs/blueprint.md §7).
    expect((await X.C('bp_report', { team_id: X.tid, health: 'on_track', done: ['second'] })).structuredContent.error).toBe('rate_limited');
    await api('POST', `/teams/${X.tid}/status-request`, { note: 'Again' });
    expect((await X.C('bp_report', { team_id: X.tid, health: 'at_risk', done: ['second'] })).isError).toBeFalsy();
    const st = (await api('GET', `/teams/${X.tid}/status`)).body;
    expect(st.reports).toHaveLength(2);
    expect(st.reports[0].body).toContain('second');
    expect(st.reports[1].body).toContain('2 done');
    expect((await X.W1('bp_report', { team_id: X.tid, health: 'on_track', done: ['not mine'] })).structuredContent.error).toBe('denied');
  });

  it('the administrator can hide a finished task from the board; agents still see it and it can be shown again', async () => {
    const X = await team();
    const open = await mkTask(X);
    expect((await api('POST', `/teams/${X.tid}/tasks/${open.id}/dismiss`, { dismissed: true })).body.error).toBe('invalid_state');
    const t = await mkTask(X);
    await X.C('task_assign', { task_id: t.id, agent_id: X.w1.id });
    await X.W1('task_start', { task_id: t.id });
    await X.W1('task_submit', { task_id: t.id, summary: 'result' });
    await X.R('task_review', { task_id: t.id, decision: 'approve', comments: 'ok', version: 1000 });
    await X.C('task_complete', { task_id: t.id });
    const hid = await api('POST', `/teams/${X.tid}/tasks/${t.id}/dismiss`, { dismissed: true });
    expect(hid.body.task.dismissed_at).toBeGreaterThan(0);
    expect((await api('GET', `/teams/${X.tid}`)).body.team.board.find((k: any) => k.id === t.id).dismissed_at).toBeGreaterThan(0);
    const listed = (await X.C('task_list', { team_id: X.tid, status: 'done', detail: 'full' })).structuredContent.tasks;
    expect(listed.some((k: any) => k.id === t.id && k.summary === 'result')).toBe(true);
    expect((await api('POST', `/teams/${X.tid}/tasks/${t.id}/dismiss`, { dismissed: false })).body.task.dismissed_at).toBeNull();
    expect(app.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action IN ('task.dismiss','task.restore') AND target_id=?").get(t.id)).toMatchObject({ n: 2 });
  });
  it('hides many done tasks in one call, all or nothing, and shows them again', async () => {
    const X = await team();
    const done = async () => {
      const t = await mkTask(X);
      await X.C('task_assign', { task_id: t.id, agent_id: X.w1.id });
      await X.W1('task_start', { task_id: t.id });
      await X.W1('task_submit', { task_id: t.id, summary: 'result' });
      await X.R('task_review', { task_id: t.id, decision: 'approve', comments: 'ok', version: 1000 });
      await X.C('task_complete', { task_id: t.id });
      return t.id as string;
    };
    const ids = [await done(), await done()], open = await mkTask(X);
    const board = async () => (await api('GET', `/teams/${X.tid}`)).body.team.board as any[];
    const mine = async () => (await board()).filter((k) => ids.includes(k.id));
    // One task that cannot be hidden refuses the whole call.
    expect((await api('POST', `/teams/${X.tid}/tasks/dismiss`, { task_ids: [...ids, open.id], dismissed: true })).body.error).toBe('invalid_state');
    expect((await mine()).every((k) => k.dismissed_at === null)).toBe(true);
    expect((await api('POST', `/teams/${X.tid}/tasks/dismiss`, { task_ids: ids, dismissed: true })).body.tasks).toHaveLength(2);
    expect((await mine()).every((k) => k.dismissed_at > 0)).toBe(true);
    expect((await api('POST', `/teams/${X.tid}/tasks/dismiss`, { task_ids: [], dismissed: true })).status).toBe(400);
    await api('POST', `/teams/${X.tid}/tasks/dismiss`, { task_ids: ids, dismissed: false });
    expect((await mine()).every((k) => k.dismissed_at === null)).toBe(true);
    expect(app.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='task.dismiss' AND target_id IN (?, ?)").get(...ids)).toMatchObject({ n: 2 });
  });
});

describe('pause and guardrails', () => {
  it('a paused team refuses submits and team messages with "paused", and resumes', async () => {
    const X = await team();
    const t = await mkTask(X);
    await X.C('task_assign', { task_id: t.id, agent_id: X.w1.id });
    await X.W1('task_start', { task_id: t.id });
    expect((await X.C('message_send', { room_id: X.room, body: 'hello', client_msg_id: cid() })).isError).toBeFalsy();
    await api('POST', `/teams/${X.tid}/pause`);
    expect((await X.W1('task_submit', { task_id: t.id, summary: 'x' })).structuredContent.error).toBe('paused');
    expect((await X.C('message_send', { room_id: X.room, body: 'hello', client_msg_id: cid() })).structuredContent.error).toBe('paused');
    expect((await X.C('message_send', { to: X.w1.id, body: 'hi', client_msg_id: cid() })).structuredContent.error).toBe('paused');
    expect((await X.C('task_create', { team_id: X.tid, title: 'n' })).structuredContent.error).toBe('paused');
    expect((await X.W1('task_list')).isError).toBeFalsy();
    expect((await X.W1('work_next', { wait_seconds: 0 })).structuredContent.item.kind).toBe('notice');
    await drain(X.W1);
    expect((await X.W1('work_next', { wait_seconds: 0 })).structuredContent.status).toBe('paused');
    await api('POST', `/teams/${X.tid}/resume`);
    expect((await X.W1('task_submit', { task_id: t.id, summary: 'x' })).isError).toBeFalsy();
    expect((await X.C('message_send', { room_id: X.room, body: 'again', client_msg_id: cid() })).isError).toBeFalsy();
  });

  it('pauses the team and alerts when an hourly limit is hit', async () => {
    const X = await team({ limits: { tasks_per_hour: 2 } });
    await mkTask(X); await mkTask(X);
    const third = await X.C('task_create', { team_id: X.tid, title: 'three' });
    expect(third.structuredContent.error).toBe('paused');
    const d = (await api('GET', `/teams/${X.tid}`)).body.team;
    expect(d).toMatchObject({ status: 'paused', paused_reason: 'limit:tasks' });
    expect(d.usage.tasks).toBe(3);
    expect((app.db.prepare("SELECT COUNT(*) n FROM security_alerts WHERE type='quota_trip' AND subject=?").get(X.tid) as { n: number }).n).toBe(1);
    expect(d.board).toHaveLength(2);
  });

  it('counts team messages against the messages limit', async () => {
    const X = await team({ limits: { messages_per_hour: 1 } });
    expect((await X.C('message_send', { room_id: X.room, body: 'one', client_msg_id: cid() })).isError).toBeFalsy();
    expect((await X.C('message_send', { room_id: X.room, body: 'two', client_msg_id: cid() })).structuredContent.error).toBe('paused');
    expect(app.teams.team(X.tid)!.status).toBe('paused');
  });
});

describe('work_next', () => {
  it('orders by priority, redelivers the same item until it is acked, and still waits for new work', async () => {
    const [c, w, r] = ['pc', 'pw', 'pr'].map(mk) as ReturnType<typeof mk>[];
    const W = await w!.login();
    const res = await api('POST', '/teams', { name: 'prio', goal: 'g', grant_messaging: true, members: [{ agent_id: c!.id, role: 'coordinator' }, { agent_id: w!.id, role: 'worker' }, { agent_id: r!.id, role: 'reviewer' }] });
    const tid = res.body.team.id as string;
    await api('POST', `/teams/${tid}/start`);
    const [C] = await Promise.all([c!.login(), r!.login()]);
    await C('message_send', { to: w!.id, body: 'ping', client_msg_id: cid() });
    const t = (await C('task_create', { team_id: tid, title: 'x', reviewer: r!.id })).structuredContent.task;
    await C('task_assign', { task_id: t.id, agent_id: w!.id });
    const first = (await W('work_next', { wait_seconds: 0 })).structuredContent.item;
    const again = (await W('work_next', { wait_seconds: 0 })).structuredContent.item;
    expect(again.item_id).toBe(first.item_id);
    expect(again.delivery_count).toBe(2);
    expect(first.kind).toBe('notice');
    const kinds: string[] = [];
    for (let i = 0; i < 20; i++) {
      const it = (await W('work_next', { wait_seconds: 0 })).structuredContent;
      if (it.status !== 'item') break;
      kinds.push(it.item.kind);
      await W('work_ack', { item_id: it.item.item_id });
    }
    expect(kinds).toContain('task_assigned');
    expect(kinds).not.toContain('message'); // one delivery model: messages are read with message_read
    expect(kinds.lastIndexOf('notice')).toBeLessThan(kinds.indexOf('task_assigned'));
    expect((await W('work_next', { wait_seconds: 0 })).structuredContent.status).toBe('idle');
    const read = (await W('message_read')).structuredContent;
    expect(read.read_only).toBeUndefined();
    expect(read.messages.map((m: any) => m.content)).toContain('ping');

    // work_next keeps its wait: an assignment made while it waits comes back from the same call.
    await drain(W);
    const t2 = (await C('task_create', { team_id: tid, title: 'late', reviewer: r!.id })).structuredContent.task;
    const waiting = W('work_next', { wait_seconds: 5 });
    const began = Date.now();
    setTimeout(() => void C('task_assign', { task_id: t2.id, agent_id: w!.id }), 150);
    const got = (await waiting).structuredContent;
    expect(Date.now() - began).toBeGreaterThanOrEqual(100);
    expect(got.status).toBe('item');
    expect(JSON.stringify(got.item)).toContain(t2.id);
  });
});

describe('wiring', () => {
  it('creates room, links and tagged grants; removes them when a member leaves or the team stops', async () => {
    const X = await team();
    const rulesOf = (id: string) => (app.db.prepare('SELECT COUNT(*) n FROM permission_rules WHERE team_id=? AND policy_id=?').get(X.tid, app.keys.credential(id)!.policy_id) as { n: number }).n;
    expect(rulesOf(X.w1.cred.id)).toBeGreaterThan(0);
    const teamLinks = async () => (await api('GET', '/links')).body.links.filter((l: any) => l.kind === `team:${X.tid}`);
    expect(await teamLinks()).toHaveLength(6); // coord->w1,w2,stake,rev; w1,w2->rev
    expect((await X.W1('message_send', { to: X.c.id, body: 'hi', client_msg_id: cid() })).isError).toBeFalsy();
    expect((await X.W1('message_send', { to: X.w2.id, body: 'no link', client_msg_id: cid() })).structuredContent.error).toBe('denied');
    const before = rulesOf(X.w1.cred.id);
    app.keys.setRules(X.w1.cred.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:file_read' }], 'edit', sys);
    expect(rulesOf(X.w1.cred.id)).toBe(before);
    expect((await api('DELETE', `/teams/${X.tid}/members/${X.w1.id}`)).status).toBe(200);
    expect(rulesOf(X.w1.cred.id)).toBe(0);
    expect((await teamLinks()).filter((l: any) => l.from_agent_id === X.w1.id || l.to_agent_id === X.w1.id)).toHaveLength(0);
    expect((await X.W1('team_info')).structuredContent.teams).toHaveLength(0);
    expect((await X.W1('task_list')).isError).toBe(true); // team tool grants are gone
    expect((await X.C('message_send', { to: X.w1.id, body: 'gone', client_msg_id: cid() })).structuredContent.error).toBe('denied');
    await api('POST', `/teams/${X.tid}/stop`);
    expect((app.db.prepare('SELECT COUNT(*) n FROM permission_rules WHERE team_id=?').get(X.tid) as { n: number }).n).toBe(0);
    expect(await teamLinks()).toHaveLength(0);
    expect((await X.W2('work_next', { wait_seconds: 0 })).structuredContent.status).toBe('item');
    await drain(X.W2);
    expect((await X.W2('work_next', { wait_seconds: 0 })).structuredContent.status).toBe('team_done');
  });

  it('without grant_messaging there is no messaging; team_complete ends the team', async () => {
    const X = await team({ grant_messaging: false });
    expect((await X.C('message_send', { room_id: X.room, body: 'x', client_msg_id: cid() })).isError).toBe(true);
    expect((await X.C('bp_report', { team_id: X.tid, health: 'on_track', done: ['progress'] })).isError).toBeFalsy();
    expect((await X.W1('team_complete', { team_id: X.tid, summary: 'x' })).structuredContent.error).toBe('denied');
    expect((await X.C('team_complete', { team_id: X.tid, summary: 'all done' })).structuredContent.status).toBe('done');
    expect((await X.C('task_create', { team_id: X.tid, title: 'late' })).isError).toBe(true);
  });

  it('team_info gives the role playbook (act when woken, no loop) and the admin can edit it', async () => {
    const X = await team();
    const info = (await X.W1('team_info')).structuredContent.teams[0];
    expect(info).toMatchObject({ trust: 'L0', my_role: 'worker', status: 'running' });
    expect(info.playbook).toContain('When woken, check task_list');
    expect(info.playbook).toContain('you do not poll');
    await api('PUT', `/teams/${X.tid}/roles/worker`, { playbook: 'custom worker text with work_next' });
    expect((await X.W1('team_info')).structuredContent.teams[0].playbook).toContain('custom worker text');
  });
});

describe('admin API', () => {
  it('lists teams with progress counts, builds the handoff and warns about Chat keys', async () => {
    const chatApp = app.keys.createAppKey({ machineId: pcId, appName: 'Claude Desktop Chat', maxLiveSessions: 50 }, sys).secret;
    const [c, w] = ['hc', 'hw'].map(mk) as ReturnType<typeof mk>[];
    await loginWith(chatApp, w!.secret);
    const res = await api('POST', '/teams', { name: 'ho', goal: 'g', members: [{ agent_id: c!.id, role: 'coordinator' }, { agent_id: w!.id, role: 'worker' }] });
    expect(res.body.warnings).toHaveLength(1);
    expect(res.body.warnings[0]).toMatchObject({ agent_id: w!.id, role: 'worker', app_name: 'Claude Desktop Chat' });
    const tid = res.body.team.id as string;
    const list = (await api('GET', '/teams')).body.teams.find((t: any) => t.id === tid);
    expect(list).toMatchObject({ status: 'draft', members: 2, counts: { open: 0, done: 0 }, progress: { total: 0, pct: 0 } });
    const h = (await api('GET', `/teams/${tid}/handoff`)).body;
    expect(h.messages).toHaveLength(2);
    expect(h.messages[0]).toMatchObject({ agent_id: c!.id, role: 'coordinator', key_label: 'hc key' });
    for (const m of h.messages) {
      expect(m.text).toContain('work_next', { wait_seconds: 0 });
      expect(m.text).toContain('work_ack');
      expect(m.text).toContain(m.key_label);
      expect(m.text).not.toContain('ah_ses_');
    }
    expect((await api('POST', '/teams', { name: 'x', goal: 'g', members: [{ agent_id: w!.id, role: 'worker' }] })).status).toBe(400);
    const bare = app.keys.createAgent('bare', null, sys);
    expect((await api('POST', '/teams', { name: 'x', goal: 'g', members: [{ agent_id: bare.id, role: 'coordinator' }] })).status).toBe(400);
    const p = await api('PATCH', `/teams/${tid}`, { goal: 'new goal', limits: { tasks_per_hour: 5 } });
    expect(p.body.team).toMatchObject({ goal: 'new goal', limits: { tasks_per_hour: 5 } });
    expect((await api('POST', `/teams/${tid}/pause`)).status).toBe(409);
    expect((await api('POST', `/teams/${tid}/start`)).status).toBe(200);
    expect((await api('POST', `/teams/${tid}/stop`)).body.team.status).toBe('stopped');
  });
});

describe('workflow options from the ECHO trial', () => {
  const kinds = async (call: Call) => ((await call('session_whoami')).structuredContent.notices as { kind: string }[]).map((x) => x.kind);
  const runToReview = async (X: T, reviewer: string) => {
    const t = await mkTask(X, { reviewer });
    await X.C('task_assign', { task_id: t.id, agent_id: X.w1.id });
    await X.W1('task_start', { task_id: t.id });
    await X.W1('task_submit', { task_id: t.id, summary: 'result' });
    return t;
  };

  it('a task notice stops once its task moves on; unrelated notices stay', async () => {
    const X = await team();
    const t = await runToReview(X, X.r.id);
    await X.R('task_review', { task_id: t.id, decision: 'approve', comments: 'ok', version: 1000 });
    expect(await kinds(X.C)).toContain('task_approved');
    await api('POST', `/agents/${X.c.id}/notices`, { kind: 'directive', body: 'unrelated' });
    await X.C('task_complete', { task_id: t.id });
    const after = await kinds(X.C);
    expect(after).not.toContain('task_approved');
    expect(after).toContain('directive');
    // work_next does not deliver it either
    for (let i = 0; i < 20; i++) {
      const r = (await X.C('work_next', { wait_seconds: 0 })).structuredContent;
      if (r.status !== 'item') break;
      expect(r.item.notice_kind).not.toBe('task_approved');
      await X.C('work_ack', { item_id: r.item.item_id });
    }
  });

  it('coordinator review and close on approval: one call closes the task; self-review and an ineligible reviewer are refused', async () => {
    const X = await team();
    expect((await X.C('task_create', { team_id: X.tid, title: 'x', reviewer: X.c.id })).structuredContent.error).toBe('invalid_argument');
    const on = await api('PATCH', `/teams/${X.tid}`, { coordinator_reviews: true, close_on_approve: true });
    expect(on.body.team).toMatchObject({ coordinator_reviews: true, close_on_approve: true });
    const t = await runToReview(X, X.c.id);
    const r1 = (await X.C('task_review', { task_id: t.id, decision: 'approve', comments: 'good', version: 1000 })).structuredContent;
    expect(r1.task.status).toBe('done');
    const r2 = (await X.C('task_review', { task_id: t.id, decision: 'approve', comments: 'good', version: 1000 })).structuredContent;
    expect(r2.task.status).toBe('done');
    expect(app.db.prepare("SELECT COUNT(*) n FROM task_events WHERE task_id=? AND to_status='approved'").get(t.id)).toMatchObject({ n: 1 });
    expect(await kinds(X.C)).not.toContain('task_approved');
    // the coordinator cannot review a task assigned to itself
    const own = (await X.C('task_create', { team_id: X.tid, title: 'mine', reviewer: X.c.id })).structuredContent.task;
    expect((await X.C('task_assign', { task_id: own.id, agent_id: X.c.id })).structuredContent.error).toBe('invalid_argument');
    // an independent reviewer still works, and also closes on approval
    const t2 = await runToReview(X, X.r.id);
    expect((await X.R('task_review', { task_id: t2.id, decision: 'approve', comments: 'ok', version: 1000 })).structuredContent.task.status).toBe('done');
    // a worker cannot review
    const t3 = await runToReview(X, X.r.id);
    expect((await X.W2('task_review', { task_id: t3.id, decision: 'approve', comments: 'x', version: 1000 })).structuredContent.error).toBe('denied');
  });

  it('a started task without a reviewer: submit falls back to a reviewing coordinator, and the coordinator can name a reviewer after start', async () => {
    const X = await team();
    // no reviewer-role member left, coordinator review off: submit is refused and says how to fix it
    expect((await api('DELETE', `/teams/${X.tid}/members/${X.r.id}`)).status).toBe(200);
    const t = await mkTask(X, { reviewer: undefined });
    await X.C('task_assign', { task_id: t.id, agent_id: X.w1.id });
    await X.W1('task_start', { task_id: t.id });
    const no = (await X.W1('task_submit', { task_id: t.id, summary: 'done' })).structuredContent;
    expect(no.error).toBe('invalid_state');
    expect(JSON.stringify(no)).toContain('task_update');
    // the coordinator names a reviewer on the started task; an ineligible one and the assignee are refused
    const v = () => app.teams.task(t.id)!.version;
    expect((await X.C('task_update', { task_id: t.id, version: v(), reviewer: X.w2.id })).structuredContent.error).toBe('invalid_argument');
    expect((await X.C('task_update', { task_id: t.id, version: v(), reviewer: X.w1.id })).structuredContent.error).toBe('invalid_argument');
    await api('PATCH', `/teams/${X.tid}`, { coordinator_reviews: true });
    const named = (await X.C('task_update', { task_id: t.id, version: v(), reviewer: X.c.id })).structuredContent.task;
    expect(named).toMatchObject({ status: 'in_progress', reviewer: X.c.id });
    expect((await X.W1('task_submit', { task_id: t.id, summary: 'done' })).structuredContent.task).toMatchObject({ status: 'in_review', reviewer: X.c.id });
    // with coordinator review on and no reviewer named, submit falls back to the coordinator
    const t2 = await mkTask(X, { reviewer: undefined });
    await X.C('task_assign', { task_id: t2.id, agent_id: X.w2.id });
    await X.W2('task_start', { task_id: t2.id });
    expect((await X.W2('task_submit', { task_id: t2.id, summary: 'done' })).structuredContent.task).toMatchObject({ status: 'in_review', reviewer: X.c.id });
  });

  it('changing the reviewer of a task in review hands the review to the new reviewer', async () => {
    const X = await team();
    const r2 = mk('rev2');
    expect((await api('POST', `/teams/${X.tid}/members`, { agent_id: r2.id, role: 'reviewer' })).status).toBeLessThan(300);
    const R2 = await r2.login();
    const t = await runToReview(X, X.r.id);
    const moved = (await X.C('task_update', { task_id: t.id, version: app.teams.task(t.id)!.version, reviewer: r2.id })).structuredContent.task;
    expect(moved).toMatchObject({ status: 'in_review', reviewer: r2.id });
    expect((await X.R('task_review', { task_id: t.id, decision: 'approve', comments: 'ok', version: 1000 })).structuredContent.error).toBe('denied');
    expect((await R2('task_review', { task_id: t.id, decision: 'approve', comments: 'ok', version: 1000 })).structuredContent.task.status).toBe('approved');
    // an approved task cannot change reviewer
    expect((await X.C('task_update', { task_id: t.id, version: app.teams.task(t.id)!.version, reviewer: X.r.id })).structuredContent.error).toBe('invalid_state');
  });

  it('close on approval keeps the operator checkpoint', async () => {
    const X = await team({ checkpoints: ['done'] });
    await api('PATCH', `/teams/${X.tid}`, { close_on_approve: true });
    const t = await runToReview(X, X.r.id);
    const r = (await X.R('task_review', { task_id: t.id, decision: 'approve', comments: 'ok', version: 1000 })).structuredContent.task;
    expect(r).toMatchObject({ status: 'approved', awaiting_approval: true });
    expect((await api('POST', `/teams/${X.tid}/tasks/${t.id}/approve`)).body.task.status).toBe('done');
  });

  it('started work past its check-in time is flagged, keeps its assignee and alerts once; unrelated calls do not hide it; progress clears it', async () => {
    const X = await team({ lease_minutes: 30 });
    await X.C('message_send', { room_id: X.room, body: 'a room message', client_msg_id: cid() });
    expect(app.db.prepare("SELECT COUNT(*) n FROM work_items WHERE team_id=? AND kind='message' AND acked_at IS NULL").get(X.tid)).toMatchObject({ n: 0 });
    const info = await X.W1('team_info');
    expect(info.content[0]!.text).toContain('act when woken');
    expect(info.structuredContent.teams[0].playbook).toContain('do not poll');
    const t = await mkTask(X);
    await X.C('task_assign', { task_id: t.id, agent_id: X.w1.id });
    await X.W1('task_start', { task_id: t.id });
    app.db.prepare('UPDATE tasks SET lease_expires_at=? WHERE id=?').run(Date.now() - 1000, t.id);
    app.teams.tick(true);
    app.teams.tick(true);
    const k = app.teams.task(t.id)!;
    expect(k).toMatchObject({ status: 'in_progress', assignee_agent_id: X.w1.id });
    expect(k.overdue_at).toBeGreaterThan(0);
    expect(app.db.prepare("SELECT COUNT(*) n FROM security_alerts WHERE type='task_overdue' AND subject=?").get(t.id)).toMatchObject({ n: 1 });
    // The Stalled flag follows the team's stall-warnings switch (off by default).
    expect((await api('GET', `/teams/${X.tid}`)).body.team.members.find((m: any) => m.agent_id === X.w1.id).stalled).toBe(false);
    expect((await api('PUT', `/teams/${X.tid}/attention`, { stall_warnings: true })).status).toBe(200);
    const v = (await api('GET', `/teams/${X.tid}`)).body.team;
    expect(v.members.find((m: any) => m.agent_id === X.w1.id).stalled).toBe(true);
    expect(v.members.find((m: any) => m.agent_id === X.w2.id).stalled).toBe(false);
    await X.W1('session_whoami');
    expect(app.teams.task(t.id)!.overdue_at).toBeGreaterThan(0);
    await X.W1('task_progress', { task_id: t.id, note: 'running', until: Date.now() + 3 * 3600_000 });
    expect(app.teams.task(t.id)!.overdue_at).toBeNull();
    expect(app.teams.task(t.id)!.lease_expires_at!).toBeGreaterThan(Date.now() + 2 * 3600_000);
    // The news closes the alert; a second lapse raises a fresh one, and submitting closes that too.
    const overdue = (status: string) => (app.db.prepare('SELECT COUNT(*) n FROM security_alerts WHERE type=? AND subject=? AND status=?').get('task_overdue', t.id, status) as { n: number }).n;
    expect([overdue('open'), overdue('closed')]).toEqual([0, 1]);
    app.db.prepare('UPDATE tasks SET lease_expires_at=? WHERE id=?').run(Date.now() - 1000, t.id);
    app.teams.tick(true);
    expect([overdue('open'), overdue('closed')]).toEqual([1, 1]);
    await X.W1('task_submit', { task_id: t.id, summary: 'Done.' });
    expect([overdue('open'), overdue('closed')]).toEqual([0, 2]);
  });

  it('the check-in time is the assignee\'s own until, also when the team\'s default changes', async () => {
    const X = await team({ lease_minutes: 1440 });
    const t = await mkTask(X);
    await X.C('task_assign', { task_id: t.id, agent_id: X.w1.id });
    await X.W1('task_start', { task_id: t.id });
    const soon = Date.now() + 3600_000;
    await X.W1('task_progress', { task_id: t.id, note: 'run', until: soon });
    await api('PATCH', `/teams/${X.tid}`, { lease_minutes: 180 });
    expect(app.teams.task(t.id)!.lease_expires_at).toBe(soon);
    const sooner = Date.now() + 1800_000;
    await X.W1('task_progress', { task_id: t.id, note: 'still running', until: sooner });
    expect(app.teams.task(t.id)!.lease_expires_at).toBe(sooner);
    await X.W1('task_progress', { task_id: t.id, note: 'no estimate' });
    expect(Math.abs(app.teams.task(t.id)!.lease_expires_at! - (Date.now() + 180 * 60_000))).toBeLessThan(5000);
  });

  it('pause and resume move the check-in deadline by the paused time', async () => {
    const X = await team();
    const t = await mkTask(X);
    await X.C('task_assign', { task_id: t.id, agent_id: X.w1.id });
    await X.W1('task_start', { task_id: t.id });
    const before = app.teams.task(t.id)!.lease_expires_at!;
    await api('POST', `/teams/${X.tid}/pause`);
    app.db.prepare('UPDATE teams SET paused_at=paused_at-600000 WHERE id=?').run(X.tid);
    await api('POST', `/teams/${X.tid}/resume`);
    expect(app.teams.task(t.id)!.lease_expires_at!).toBeGreaterThanOrEqual(before + 600_000);
  });

  it('8.A15: resuming a paused team shifts work and review deadlines by the pause; queued turns keep none', async () => {
    const X = await team();
    const [q, wk, rv] = [await mkTask(X, { reviewer: X.r.id }), await mkTask(X, { reviewer: X.r.id }), await mkTask(X, { reviewer: X.r.id })];
    for (const k of [q, wk, rv]) await X.C('task_assign', { task_id: k.id, agent_id: X.w1.id });
    await X.W1('task_start', { task_id: wk.id });
    await X.W1('task_start', { task_id: rv.id });
    await X.W1('task_submit', { task_id: rv.id, summary: 'done' });
    const due = (id: string) => (app.db.prepare('SELECT phase, due_at FROM task_turns WHERE task_id=? AND closed_at IS NULL').get(id) as { phase: string; due_at: number | null });
    const [d0, r0] = [due(wk.id), due(rv.id)];
    expect([due(q.id), d0.phase, r0.phase]).toEqual([{ phase: 'queued', due_at: null }, 'work', 'review']);
    await api('POST', `/teams/${X.tid}/pause`);
    app.db.prepare('UPDATE teams SET paused_at=paused_at-? WHERE id=?').run(2 * 3600_000, X.tid);
    await api('POST', `/teams/${X.tid}/resume`);
    const [d1, r1] = [due(wk.id), due(rv.id)];
    expect(d1.due_at! - d0.due_at!).toBeGreaterThanOrEqual(2 * 3600_000);
    expect(d1.due_at! - d0.due_at!).toBeLessThan(2 * 3600_000 + 5000);
    expect(r1.due_at! - r0.due_at!).toBeGreaterThanOrEqual(2 * 3600_000);
    expect(r1.due_at! - r0.due_at!).toBeLessThan(2 * 3600_000 + 5000);
    expect(d1.due_at).toBe(app.teams.task(wk.id)!.lease_expires_at);
    expect(due(q.id)).toEqual({ phase: 'queued', due_at: null });
    expect(app.teams.task(q.id)!.lease_expires_at).toBeNull();
  });

  it('room messages are read once with message_read and never queued, in every team of the same agent', async () => {
    const X = await team();
    await drain(X.W2);
    await X.C('message_send', { room_id: X.room, body: 'hello', client_msg_id: cid() });
    expect(app.db.prepare("SELECT COUNT(*) n FROM work_items WHERE agent_id=? AND kind='message' AND acked_at IS NULL").get(X.w2.id)).toMatchObject({ n: 0 });
    const first = (await X.W2('message_read', { room_id: X.room })).structuredContent;
    expect(first.messages.map((m: any) => m.content)).toContain('hello');
    expect(first.read_only).toBeUndefined();
    expect((await X.W2('message_read', { room_id: X.room })).structuredContent.messages).toHaveLength(0);
    // The same worker in a second team: that room is read the same way.
    const pc = mk('pcoord');
    const p = await api('POST', '/teams', { name: `second${++n}`, goal: 'g', grant_messaging: true, members: [{ agent_id: pc.id, role: 'coordinator' }, { agent_id: X.w2.id, role: 'worker' }] });
    await api('POST', `/teams/${p.body.team.id}/start`);
    const PC = await pc.login();
    await PC('message_send', { room_id: p.body.team.room_id, body: 'second hello', client_msg_id: cid() });
    expect(app.db.prepare("SELECT COUNT(*) n FROM work_items WHERE agent_id=? AND kind='message' AND acked_at IS NULL").get(X.w2.id)).toMatchObject({ n: 0 });
    const other = (await X.W2('message_read', { room_id: p.body.team.room_id })).structuredContent;
    expect(other.read_only_rooms ?? []).toEqual([]);
    expect(other.messages.map((m: any) => m.content)).toContain('second hello');
  });
});

describe('recruiting: a coordinator adds agents within the envelope', () => {
  const vaultRules = (X: T, path = '/vault/Proj/**') => app.keys.setRules(X.c.cred.policy_id, [
    { effect: 'allow', actions: ['tool.invoke'], resource: 'tool:file_*' },
    { effect: 'allow', actions: ['fs.list', 'fs.read', 'fs.search', 'fs.update', 'fs.create'], resource: `path:${path}` },
    { effect: 'deny', actions: ['fs.read'], resource: 'path:/vault/Proj/Secret/**' },
  ], 'test', sys);

  it('is refused while recruiting is off', async () => {
    const X = await team();
    expect((await X.C('team_recruit', { team_id: X.tid, label: 'R2', role: 'reviewer', purpose: 'p' })).structuredContent.error).toBe('denied');
  });

  it('auto: creates the agent with a read-only copy of the coordinator\'s access, its key waits for pickup on the PC, respects the limits', async () => {
    const X = await team();
    vaultRules(X);
    await api('PATCH', `/teams/${X.tid}`, { recruiting: 'auto', recruit_max: 1 });
    expect((await X.C('team_recruit', { team_id: X.tid, label: 'Boss', role: 'coordinator', purpose: 'p' })).structuredContent.error).toBe('invalid_argument');
    const r = await X.C('team_recruit', { team_id: X.tid, label: 'Second reviewer', role: 'reviewer', purpose: 'Check the statistics' });
    expect(r.structuredContent.status).toBe('created');
    expect(JSON.stringify(r)).not.toMatch(/ah_ses_/);
    const secret = await pickup(r.structuredContent.pickup);
    const aid = r.structuredContent.agent_id as string;
    const agent = app.keys.agent(aid)!;
    expect(agent).toMatchObject({ recruited_team_id: X.tid, recruited_by: X.c.id, role: 'reviewer', role_detail: 'Check the statistics' });
    const cred = app.keys.credentials({ kind: 'session_key', agentId: aid })[0]!;
    expect(cred.expires_at!).toBeLessThan(Date.now() + 8 * 86_400_000);
    const rules = app.keys.rules(cred.policy_id, false);
    expect(rules.some((x) => x.actions.includes('fs.update'))).toBe(false);
    expect(rules.some((x) => x.effect === 'deny' && x.resource === 'path:/vault/Proj/Secret/**')).toBe(true);
    // the recruit can log in with the picked-up key and is a reviewer of the team
    const R2 = await loginWith(appKey, secret);
    expect((await R2('team_info')).structuredContent.teams[0].my_role).toBe('reviewer');
    expect((await X.C('team_recruit', { team_id: X.tid, label: 'Third', role: 'worker', purpose: 'p' })).structuredContent.error).toBe('invalid_state');
    const v = (await api('GET', `/teams/${X.tid}`)).body.team;
    expect(v.members.find((m: any) => m.agent_id === aid).recruited_by).toBe(X.c.id);
    // switching recruiting off revokes the recruit's key
    await api('PATCH', `/teams/${X.tid}`, { recruiting: 'off' });
    expect(app.keys.credential(cred.id)!.status).toBe('revoked');
  });

  it('a template that exceeds the coordinator\'s own access is refused', async () => {
    const X = await team();
    vaultRules(X);
    const tpl = await api('POST', '/templates', { name: `wide${++n}`, rules: [{ effect: 'allow', actions: ['fs.read'], resource: 'path:/vault/**' }] });
    await api('PATCH', `/teams/${X.tid}`, { recruiting: 'auto', recruit_template_id: tpl.body.id });
    const r = (await X.C('team_recruit', { team_id: X.tid, label: 'Wide', role: 'worker', purpose: 'p' })).structuredContent;
    expect(r.error).toBe('denied');
  });

  it('propose: the administrator approves, the key waits for pickup, and the coordinator is told where', async () => {
    const X = await team();
    vaultRules(X);
    await api('PATCH', `/teams/${X.tid}`, { recruiting: 'propose' });
    const r = (await X.C('team_recruit', { team_id: X.tid, label: 'Stake', role: 'stakeholder', purpose: 'Funder view' })).structuredContent;
    expect(r).toMatchObject({ status: 'pending' });
    const list = (await api('GET', '/recruits?status=pending')).body.requests;
    expect(list.some((q: any) => q.id === r.request_id)).toBe(true);
    const ok = await api('POST', `/recruits/${r.request_id}/approve`);
    expect(JSON.stringify(ok.body)).not.toMatch(/ah_ses_/);
    await pickup(ok.body.pickup);
    expect((await api('GET', `/teams/${X.tid}`)).body.team.members.some((m: any) => m.agent_id === ok.body.agent.id && m.role === 'stakeholder')).toBe(true);
    const notices = (await X.C('session_whoami')).structuredContent.notices as { kind: string; body: string }[];
    expect(notices.some((x) => x.kind === 'recruit_decision' && x.body.includes('approved') && x.body.includes("connector's screen"))).toBe(true);
    const r2 = (await X.C('team_recruit', { team_id: X.tid, label: 'Other', role: 'worker', purpose: 'p' })).structuredContent;
    expect((await api('POST', `/recruits/${r2.request_id}/deny`, { note: 'not now' })).body.denied).toBe(true);
    expect((await api('POST', `/recruits/${r2.request_id}/approve`)).status).toBe(409);
  });
});

describe('telemetry', () => {
  it('reports cycles, per-agent volume and estimated context from what the hub already records', async () => {
    const X = await team();
    const t = await mkTask(X);
    await X.C('task_assign', { task_id: t.id, agent_id: X.w1.id });
    await X.W1('task_start', { task_id: t.id });
    await X.W1('task_submit', { task_id: t.id, summary: 'result' });
    await X.R('task_review', { task_id: t.id, decision: 'approve', comments: 'ok', version: 1000 });
    await X.C('task_complete', { task_id: t.id });
    const r = (await api('GET', `/telemetry?team=${X.tid}&days=1`)).body;
    const c = r.cycles.find((x: any) => x.task_id === t.id);
    expect(c).toMatchObject({ status: 'done' });
    expect(c.calls).toBeGreaterThan(0);
    expect(c.bookkeeping_calls).toBeGreaterThan(0);
    expect(c.est_tokens).toBeGreaterThan(0);
    expect(r.agents.some((a: any) => a.agent_id === X.w1.id && a.calls > 0)).toBe(true);
    expect(r.totals.measured_calls).toBeGreaterThan(0);
    expect((await api('PUT', '/telemetry/baseline', { label: 'Before the hub', calls_per_cycle: 4, tokens_per_cycle: 700000 })).status).toBe(200);
    expect((await api('GET', `/telemetry?team=${X.tid}&days=1`)).body.baseline).toMatchObject({ calls_per_cycle: 4 });
  });
});

describe('team plan: requirements and milestones', () => {
  it('the plan is the team\'s blueprint part: members read it, tasks link to it, the operator sees and asks for it', async () => {
    const X = await team();
    const p = app.blueprint.projectOfTeam(X.tid)!;
    app.blueprint.write(p.id, { version: p.version, ops: [{ op: 'upsert', kind: 'module', key: 'PRF', title: 'Proofs', team_id: X.tid },
      { op: 'upsert', kind: 'milestone', key: 'M1', title: 'Draft proof', team_id: X.tid, fields: { target_at: Date.now() + 86_400_000 } }] }, { kind: 'operator', id: null });
    const v = () => app.blueprint.project(p.id)!.version;
    // members propose requirements; the coordinator writes drafts in its own module
    expect((await X.W1('bp_write', { team_id: X.tid, version: v(), ops: [{ op: 'upsert', kind: 'fr', key: 'FR-PRF-01', parent_key: 'PRF', title: 'x' }] })).structuredContent.status).toBe('proposed');
    const drafts = [
      { op: 'upsert', kind: 'fr', key: 'FR-PRF-01', parent_key: 'PRF', title: 'Certified bound', fields: { priority: 'must' } },
      { op: 'upsert', kind: 'fr', key: 'FR-PRF-02', parent_key: 'PRF', title: 'Open question' }];
    // what a milestone delivers is scope, the operator's, even for a requirement written in the same write (§4)
    const scoped = (await X.C('bp_write', { team_id: X.tid, version: v(), ops: [...drafts, { op: 'link', from: 'M1', to: 'FR-PRF-01', rel: 'delivers' }] })).structuredContent;
    expect(scoped.status).toBe('proposed');
    expect(scoped.why.join()).toContain('M1 delivers FR-PRF-01: scope needs the operator');
    expect((await X.C('bp_write', { team_id: X.tid, version: v(), ops: drafts })).structuredContent.status).toBe('applied');
    const ask = (await X.C('team_ask', { team_id: X.tid, question: 'What is open in FR-PRF-02?', refs: ['FR-PRF-02'] })).structuredContent.decision_id;
    expect((await X.C('bp_write', { team_id: X.tid, version: v(), ops: [{ op: 'upsert', kind: 'fr', key: 'FR-PRF-02', fields: { unclear: true, unclear_ask: ask } }] })).structuredContent.status).toBe('applied');
    app.blueprint.write(p.id, { version: v(), ops: [{ op: 'link', from: 'M1', to: 'FR-PRF-01', rel: 'delivers' }] }, { kind: 'operator', id: null });
    // a stale version on an item that changed is refused
    expect((await X.C('bp_write', { team_id: X.tid, version: 0, ops: [{ op: 'upsert', kind: 'fr', key: 'FR-PRF-01', title: 'y' }] })).structuredContent.error).toBe('conflict');
    expect((await X.W1('bp_read', { team_id: X.tid, kinds: ['fr'] })).structuredContent.items.map((i: any) => i.key)).toEqual(['FR-PRF-01', 'FR-PRF-02']);
    // a task links to a requirement; its progress shows on the requirement
    const t = (await X.C('task_create', { team_id: X.tid, title: 'prove it', reviewer: X.r.id, refs: ['FR-PRF-01'] })).structuredContent.task;
    expect(t.refs).toEqual(['FR-PRF-01']);
    expect((await X.C('task_create', { team_id: X.tid, title: 'bad', refs: ['FR-PRF-09'] })).structuredContent.error).toBe('invalid_argument');
    await X.C('task_assign', { task_id: t.id, agent_id: X.w1.id });
    await X.W1('task_start', { task_id: t.id });
    await X.W1('task_submit', { task_id: t.id, summary: 'ok' });
    await X.R('task_review', { task_id: t.id, decision: 'approve', comments: 'ok', version: 1000 });
    await X.C('task_complete', { task_id: t.id });
    // the operator sees the plan in plan words and can ask for a review
    const plan = (await api('GET', `/teams/${X.tid}`)).body.team.plan;
    expect(plan.requirements.map((r: any) => [r.key, r.status, r.links])).toEqual([['FR-PRF-01', 'open', ['M1']], ['FR-PRF-02', 'unclear', []]]);
    expect(plan.requirements[0].tasks).toEqual({ done: 1, total: 1 });
    expect((await api('POST', `/teams/${X.tid}/plan-request`, { note: 'add milestones for FR-PRF-02' })).body.team.plan.requested_at).toBeGreaterThan(0);
    const n = (await X.C('session_whoami')).structuredContent.notices as { kind: string; body: string }[];
    expect(n.some((x) => x.kind === 'plan_request' && x.body.includes('add milestones for FR-PRF-02') && x.body.includes('bp_write'))).toBe(true);
    await X.C('bp_write', { team_id: X.tid, version: v(), ops: [{ op: 'upsert', kind: 'fr', key: 'FR-PRF-02', title: 'Open question, narrowed' }] });
    expect((await api('GET', `/teams/${X.tid}`)).body.team.plan).toMatchObject({ requested_at: null });
  });
});

describe('a new login continues where the agent left off', () => {
  it('delivers a directive sent before the first login, keeps unconfirmed notices across logins, and replays read messages only until they are confirmed', async () => {
    const X = await team({}, true);
    // directive to an agent that has never logged in
    const fresh = mk('fresh');
    await api('POST', `/agents/${fresh.id}/notices`, { kind: 'directive', body: 'cite every claim' });
    const F1 = await fresh.login();
    expect(((await F1('session_whoami')).structuredContent.notices as { body: string }[]).map((n) => n.body)).toContain('cite every claim');
    // an unconfirmed notice is still there after logging in again
    const F2 = await fresh.login();
    expect(((await F2('session_whoami')).structuredContent.notices as { body: string }[]).map((n) => n.body)).toContain('cite every claim');
    const seq = ((await F2('session_whoami')).structuredContent.notices as { seq: number; body: string }[]).find((n) => n.body === 'cite every claim')!.seq;
    await F2('session_ack', { notice_seq: seq });
    const F3 = await fresh.login();
    expect((((await F3('session_whoami')).structuredContent.notices ?? []) as { body: string }[]).map((n) => n.body)).not.toContain('cite every claim');
    // room messages read in one login but never confirmed (acked) are delivered again by the next login; once confirmed they are not
    await X.C('message_send', { room_id: X.room, body: 'read me once', client_msg_id: cid() });
    expect((await X.W1('message_read', { room_id: X.room })).structuredContent.messages.map((m: any) => m.content)).toContain('read me once');
    const W1b = await X.w1.login();
    const rd = (await W1b('message_read', { room_id: X.room })).structuredContent;
    expect(rd.messages.map((m: any) => m.content)).toContain('read me once');
    await W1b('message_ack', { cursor: rd.next_cursor });
    const W1c = await X.w1.login();
    expect((await W1c('message_read', { room_id: X.room })).structuredContent.messages).toHaveLength(0);
  });
});

describe('session token in a header (credential helper login)', () => {
  const rpc = async (headers: Record<string, string>, name: string, args: Record<string, unknown> = {}) => {
    const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
  };
  it('works without session_login or session_token, refuses expired or conflicting tokens with the right status, and stops when the key is suspended', async () => {
    const a = mk('helperagent');
    const login = await rpc({ authorization: `Bearer ${appKey}` }, 'session_login', { session_key: a.secret });
    const token = login.body.result.structuredContent.session_token as string;
    const h = { authorization: `Bearer ${appKey}`, 'x-agent-hub-session': token };
    const who = await rpc(h, 'session_whoami');
    expect(who.status).toBe(200);
    expect(who.body.result.structuredContent.agent_id).toBe(a.id);
    // the server tells a header client not to log in
    const c = new Client({ name: 't', version: '1' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: h } }));
    expect(c.getInstructions()).toContain('already logged in');
    // a different token in the arguments is refused
    expect((await rpc(h, 'session_whoami', { session_token: 'ah_tok_' + 'x'.repeat(40) })).body.result.structuredContent.error).toBe('invalid_argument');
    // an expired token is refused at HTTP level, so the client's helper logs in again
    app.db.prepare('UPDATE session_tokens SET expires_at=? WHERE app_credential_id IS NOT NULL AND token_hash IN (SELECT token_hash FROM session_tokens ORDER BY created_at DESC LIMIT 1)').run(Date.now() - 1000);
    const exp = await rpc(h, 'session_whoami');
    expect(exp.status).toBe(401);
    expect(exp.body.error).toBe('login_required');
    // a suspended key cannot log in again, and its token is refused
    const login2 = await rpc({ authorization: `Bearer ${appKey}` }, 'session_login', { session_key: a.secret });
    const h2 = { authorization: `Bearer ${appKey}`, 'x-agent-hub-session': login2.body.result.structuredContent.session_token as string };
    expect((await rpc(h2, 'session_whoami')).status).toBe(200);
    app.keys.setStatus(a.cred.id, 'suspended', 'test', sys);
    const sus = await rpc(h2, 'session_whoami');
    expect(sus.status).toBe(401);
    expect(['key_inactive', 'login_required']).toContain(sus.body.error);
  });
});

describe('code review fixes (10 Nov)', () => {
  const coordVault = (X: T, extra: { effect: 'allow' | 'deny'; actions: string[]; resource: string }[] = []) => app.keys.setRules(X.c.cred.policy_id, [
    { effect: 'allow', actions: ['tool.invoke'], resource: 'tool:file_*' },
    { effect: 'allow', actions: ['fs.list', 'fs.read', 'fs.search'], resource: 'path:/vault/**' },
    { effect: 'deny', actions: ['fs.read'], resource: 'path:/vault/HR/**' },
    ...extra,
  ], 'test', sys);
  const recruitArgs = (X: T, label: string) => ({ team_id: X.tid, label, role: 'worker', purpose: 'p' });

  it('a lockdown stops recruiting and plan writes; reads stay open', async () => {
    const X = await team();
    coordVault(X);
    await api('PATCH', `/teams/${X.tid}`, { recruiting: 'auto', recruit_max: 3 });
    app.lockdown.set('writes', undefined, true, null);
    try {
      expect((await X.C('team_recruit', recruitArgs(X, 'Locked'))).structuredContent.error).toBe('lockdown');
      const read = await X.C('bp_read', { team_id: X.tid });
      expect(read.isError).toBeFalsy();
      expect((await X.C('bp_write', { team_id: X.tid, version: read.structuredContent.project.version, ops: [{ op: 'upsert', kind: 'risk', key: 'RK-*', title: 'x', team_id: X.tid }] })).structuredContent.error).toBe('lockdown');
    } finally { app.lockdown.set('writes', undefined, false, null); }
    app.lockdown.set('team', X.tid, true, null);
    try { expect((await X.C('team_recruit', recruitArgs(X, 'Team-locked'))).structuredContent.status).toBeUndefined(); }
    finally { app.lockdown.set('team', X.tid, false, null); }
    expect((await X.C('team_recruit', recruitArgs(X, 'Open again'))).structuredContent.status).toBe('created');
  });

  it('a recruit never inherits a temporary grant, and a template carries the coordinator\'s deny rules', async () => {
    const X = await team();
    coordVault(X);
    const admin = (app.db.prepare('SELECT id FROM admin_users LIMIT 1').get() as { id: string }).id, now = Date.now();
    app.db.prepare("INSERT INTO temporary_grants(id,credential_id,actions,resource,resource_kind,not_before,not_after,granted_by,created_at) VALUES ('tgr_rv1',?,?,?,'path',?,?,?,?)")
      .run(X.c.cred.id, JSON.stringify(['fs.read']), 'path:/vault/HR/Pay/**', now, now + 3600_000, admin, now);
    await api('PATCH', `/teams/${X.tid}`, { recruiting: 'auto', recruit_max: 3 });
    const r1 = (await X.C('team_recruit', recruitArgs(X, 'Copy'))).structuredContent;
    await pickup(r1.pickup);
    const rules1 = app.keys.rules(app.keys.credentials({ kind: 'session_key', agentId: r1.agent_id })[0]!.policy_id, false);
    expect(rules1.some((x) => x.resource === 'path:/vault/HR/Pay/**')).toBe(false);
    expect(rules1.some((x) => x.effect === 'deny' && x.resource === 'path:/vault/HR/**')).toBe(true);
    // A template over a part the coordinator is denied is refused (a member's deny counts against the template).
    const over = await api('POST', '/templates', { name: `over${++n}`, rules: [{ effect: 'allow', actions: ['fs.read'], resource: 'path:/vault/**' }] });
    await api('PATCH', `/teams/${X.tid}`, { recruit_template_id: over.body.id });
    expect((await X.C('team_recruit', recruitArgs(X, 'Over the deny'))).structuredContent.error).toBe('denied');
    // A template inside the coordinator's allow and outside its deny passes, and its deny still comes along; one beyond it is refused.
    const ok = await api('POST', '/templates', { name: `inside${++n}`, rules: [{ effect: 'allow', actions: ['fs.read'], resource: 'path:/vault/Proj/**' }] });
    await api('PATCH', `/teams/${X.tid}`, { recruit_template_id: ok.body.id });
    const r2 = (await X.C('team_recruit', recruitArgs(X, 'Templated'))).structuredContent;
    await pickup(r2.pickup);
    const rules2 = app.keys.rules(app.keys.credentials({ kind: 'session_key', agentId: r2.agent_id })[0]!.policy_id, false);
    expect(rules2.some((x) => x.effect === 'deny' && x.resource === 'path:/vault/HR/**')).toBe(true);
    const wide = await api('POST', '/templates', { name: `beyond${++n}`, rules: [{ effect: 'allow', actions: ['fs.update'], resource: 'path:/vault/**' }] });
    await api('PATCH', `/teams/${X.tid}`, { recruit_template_id: wide.body.id });
    expect((await X.C('team_recruit', recruitArgs(X, 'Too wide'))).structuredContent.error).toBe('denied');
  });

  it('a room member without read rights does not get the message', async () => {
    const X = await team();
    await Promise.all([X.W1, X.W2].map(drain));
    const own = app.keys.rules(X.w2.cred.policy_id, false).map(({ id: _i, ...r }) => r);
    app.keys.setRules(X.w2.cred.policy_id, [...own, { effect: 'deny', actions: ['room.read_history'], resource: `room:${X.room}` }], 'test', sys);
    expect((await X.C('message_send', { room_id: X.room, body: 'for readers only', client_msg_id: cid() })).isError).toBeFalsy();
    expect(JSON.stringify((await X.W1('message_read', { room_id: X.room })).structuredContent)).toContain('for readers only');
    expect(JSON.stringify((await X.W2('message_read', { room_id: X.room })).structuredContent)).not.toContain('for readers only');
    expect(JSON.stringify((await X.W2('work_next', { wait_seconds: 0 })).structuredContent)).not.toContain('for readers only');
  });

  it('rotating a member\'s key keeps its team grants after the next membership change', async () => {
    const X = await team();
    const rot = await api('POST', `/keys/${X.w1.cred.id}/rotate`);
    expect(rot.status).toBe(200);
    const extra = mk('late');
    expect((await api('POST', `/teams/${X.tid}/members`, { agent_id: extra.id, role: 'worker' })).status).toBeLessThan(300);
    // The key's PC runs no connector here, so the rotated key is shown once (docs/onboarding.md#key-handover-a-rotated-key-or-a-recruit-reaches-a-connector-pc).
    expect(rot.body.prompt.mode).toBe('secret');
    const secret = rot.body.secret as string;
    const W1 = await loginWith(appKey, secret);
    expect((await W1('task_list', { team_id: X.tid })).isError).toBeFalsy();
  });

  it('session_ack cannot hide future notices', async () => {
    const X = await team();
    await X.W1('session_ack', { notice_seq: 1e12 });
    app.keys.notify(X.w1.id, 'directive', 'Please check the plan.');
    const notices = (await X.W1('session_whoami')).structuredContent.notices as { kind: string }[];
    expect(notices.some((x) => x.kind === 'directive')).toBe(true);
  });

  it('blob clean-up keeps a blob that was just reused and removes an unreferenced one', async () => {
    const reused = Buffer.from(`reused ${Date.now()}`), orphan = Buffer.from(`orphan ${Date.now()}`);
    const a = await app.store.putBlob(reused), b = await app.store.putBlob(orphan);
    app.db.prepare('UPDATE blobs SET created_at=1 WHERE hash IN (?,?)').run(a.hash, b.hash);
    await app.store.putBlob(reused); // reuse restarts the grace period
    await app.maintenance.gcBlobs(Date.now() - 60_000);
    expect(app.db.prepare('SELECT 1 FROM blobs WHERE hash=?').get(a.hash)).toBeTruthy();
    expect(app.db.prepare('SELECT 1 FROM blobs WHERE hash=?').get(b.hash)).toBeUndefined();
    expect(app.store.getBlobSync(a.hash)?.toString()).toBe(reused.toString());
  });
});

describe('code review fixes, second batch (11 Nov)', () => {
  it('pausing and resuming a polling team keeps a declared busy-until time', async () => {
    const X = await team();
    await drain(X.W1);
    const t = await mkTask(X);
    await X.C('task_assign', { task_id: t.id, agent_id: X.w1.id });
    await X.W1('task_start', { task_id: t.id });
    const until = Date.now() + 5 * 3600_000;
    await X.W1('task_progress', { task_id: t.id, note: 'long run', until });
    await api('POST', `/teams/${X.tid}/pause`);
    await api('POST', `/teams/${X.tid}/resume`);
    expect(app.teams.task(t.id)!.lease_expires_at!).toBeGreaterThanOrEqual(until);
  });

  it('resuming a polling team restarts a silent member\'s lease without writing its busy_until', async () => {
    const X = await team({ lease_minutes: 30 });
    const t = await mkTask(X);
    await X.C('task_assign', { task_id: t.id, agent_id: X.w2.id });
    await api('POST', `/teams/${X.tid}/pause`);
    silence(X.tid, X.w2.id, 2 * 3600_000);
    const busy = () => (app.db.prepare('SELECT busy_until b FROM team_members WHERE team_id=? AND agent_id=? AND removed_at IS NULL').get(X.tid, X.w2.id) as { b: number | null }).b;
    expect(busy()).toBeNull();
    await api('POST', `/teams/${X.tid}/resume`);
    expect(busy()).toBeNull();
    app.teams.tick();
    expect(app.teams.task(t.id)).toMatchObject({ status: 'assigned', assignee_agent_id: X.w2.id });
  });

  it('caps notices per response at 20 and says how many wait', async () => {
    const a = mk('busy-notices');
    const A = await a.login();
    for (let i = 0; i < 25; i++) app.keys.notify(a.id, 'directive', `note ${i}`);
    const r = (await A('session_whoami')).structuredContent;
    expect(r.notices).toHaveLength(20);
    expect(r.notices_more).toBe(5);
  });

  it('a list-only grant sees no content hash and no backlinks', async () => {
    const a = mk('lister');
    app.keys.setRules(a.cred.policy_id, [
      { effect: 'allow', actions: ['tool.invoke'], resource: 'tool:file_*' },
      { effect: 'allow', actions: ['fs.list'], resource: 'path:/vault/**' },
    ], 'test', sys);
    writeFileSync(join(app.config.vaultDir, 'listed.md'), 'secret words');
    const A = await a.login();
    const st = (await A('file_stat', { path: '/vault/listed.md' })).structuredContent;
    expect(st.revision).toBeNull();
    expect(st.linked_from).toEqual([]);
    const ls = (await A('file_list', { path: '/vault' })).structuredContent.entries.find((e: any) => e.path === '/vault/listed.md');
    expect(ls.revision).toBeUndefined();
  });

  it('pruning keeps each agent\'s newest login and drops old dead ones', async () => {
    const a = mk('pruned');
    await a.login(); await a.login(); await a.login();
    const rows = () => app.db.prepare('SELECT token_hash FROM session_tokens WHERE session_credential_id=? ORDER BY created_at').all(a.cred.id) as { token_hash: string }[];
    const all = rows();
    app.db.prepare('UPDATE session_tokens SET expires_at=1, revoked_at=1 WHERE session_credential_id=?').run(a.cred.id);
    app.maintenance.prune(Date.now());
    expect(rows().map((r) => r.token_hash)).toEqual([all.at(-1)!.token_hash]);
  });
});

describe('decisions: agents ask the operator', () => {
  const notices = async (call: Call) => ((await call('session_whoami')).structuredContent.notices ?? []) as { seq: number; kind: string; body: string }[];
  const opts = [{ key: 'a', label: 'Run 23e', effect: 'about 6 h on h200' }, { key: 'b', label: 'Drop g0 from the equality rule', effect: 'no rerun' }];

  it('a worker asks with a task: the task waits, the operator answers, the task goes back and the log keeps it', async () => {
    const X = await team({}, true);
    await Promise.all([X.C, X.W1].map(drain));
    const t = await mkTask(X);
    await X.C('task_assign', { task_id: t.id, agent_id: X.w1.id });
    await X.W1('task_start', { task_id: t.id });
    await api('PUT', `/teams/${X.tid}/decision-log`, { path: '/vault/Decisions log.md' });
    const asked = (await X.W1('team_ask', { team_id: X.tid, question: 'Run 23e or drop g0?', context: 'ET-B11 stopped at 23d.', options: opts, recommended: 'a', task_id: t.id })).structuredContent;
    expect(asked).toMatchObject({ status: 'open', task_id: t.id, recommended: 'a' });
    expect(app.teams.task(t.id)).toMatchObject({ status: 'blocked' });
    expect(app.teams.task(t.id)!.blocked_reason).toContain('Run 23e or drop g0?');
    const askedNotice = (await notices(X.C)).find((n) => n.kind === 'decision_asked' && n.body.includes(asked.decision_id));
    expect(askedNotice?.body).toContain(`Read it with team_decisions {decision_id: "${asked.decision_id}"}`);
    expect(askedNotice?.body).not.toContain('Run 23e'); // the question is the agent's words, not a hub notice
    // the console: open questions, counts, and the answer
    expect((await api('GET', '/decisions/counts')).body.by_team[X.tid]).toBe(1);
    const open = (await api('GET', `/decisions?team=${X.tid}&status=open`)).body.decisions;
    expect(open.map((d: any) => d.id)).toEqual([asked.decision_id]);
    const ans = await api('POST', `/decisions/${asked.decision_id}/answer`, { option: 'a', text: 'Keep g0; the claim needs it.' });
    expect(ans.status).toBe(200);
    expect(ans.body.decision).toMatchObject({ status: 'answered', answer_option: 'a', answer_label: 'Run 23e' });
    // Back to the status it was blocked from (F-34): it was in progress.
    expect(app.teams.task(t.id)).toMatchObject({ status: 'in_progress', assignee_agent_id: X.w1.id, blocked_reason: null, blocked_from: null });
    const n = await notices(X.W1);
    expect(n.some((x) => x.kind === 'decision' && x.body.includes('Run 23e') && x.body.includes('back in progress with you'))).toBe(true);
    const log = (await X.W1('team_decisions', { team_id: X.tid, status: 'all' })).structuredContent.decisions;
    expect(log[0]).toMatchObject({ decision_id: asked.decision_id, status: 'answered', answer: 'Run 23e', answer_text: 'Keep g0; the claim needs it.' });
    // By default only what still waits; decision_id gives that one question, answered or not.
    const waiting = await X.W1('team_decisions', { team_id: X.tid });
    expect(waiting.structuredContent.decisions).toEqual([]);
    expect(waiting.content[0]!.text).toContain('No open decisions');
    const one = (await X.W1('team_decisions', { team_id: X.tid, decision_id: asked.decision_id })).structuredContent.decisions;
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ decision_id: asked.decision_id, status: 'answered' });
    expect((await X.W1('team_decisions', { team_id: X.tid, decision_id: 'dec_nope' })).isError).toBeTruthy();
    // the vault note got the entry
    const note = readFileSync(join(app.config.vaultDir, 'Decisions log.md'), 'utf8');
    expect(note).toContain('Run 23e or drop g0?');
    expect(note).toContain('**Decision:** Run 23e — Keep g0; the claim needs it.');
    expect((await api('POST', `/decisions/${asked.decision_id}/answer`, { option: 'b' })).status).toBe(409);
  });

  it('more information, decline and withdraw; the limits hold', async () => {
    const X = await team({}, true);
    const t = await mkTask(X);
    await X.C('task_assign', { task_id: t.id, agent_id: X.w1.id });
    // only the assignee (or a coordinator) may block a task with a question
    expect((await X.W2('team_ask', { team_id: X.tid, question: 'Not mine?', task_id: t.id })).structuredContent.error).toBe('denied');
    expect((await X.W1('team_ask', { team_id: X.tid, question: 'One option?', options: [opts[0]] })).structuredContent.error).toBe('invalid_argument');
    expect((await X.W1('team_ask', { team_id: X.tid, question: 'Bad pick?', options: opts, recommended: 'z' })).structuredContent.error).toBe('invalid_argument');
    const q = (await X.W1('team_ask', { team_id: X.tid, question: 'Which dataset?', task_id: t.id })).structuredContent;
    expect((await X.W1('team_ask', { team_id: X.tid, question: 'Again?', task_id: t.id })).structuredContent.error).toBe('invalid_state');
    await api('POST', `/decisions/${q.decision_id}/more-info`, { note: 'Which sizes are in each?' });
    expect((await notices(X.W1)).some((x) => x.kind === 'decision_needs_info' && x.body.includes('Which sizes'))).toBe(true);
    const upd = (await X.W1('team_ask_update', { decision_id: q.decision_id, context: 'A: 10 GB, B: 2 GB.' })).structuredContent;
    expect(upd.status).toBe('open');
    expect((await api('GET', `/decisions/${q.decision_id}`)).body.decision.context).toContain('A: 10 GB');
    await api('POST', `/decisions/${q.decision_id}/decline`, { note: 'Your call.' });
    expect(app.teams.task(t.id)!.status).toBe('assigned');
    // withdraw gives the task back too
    const w = (await X.W1('team_ask', { team_id: X.tid, question: 'Start over?', task_id: t.id })).structuredContent;
    expect((await X.W2('team_ask_update', { decision_id: w.decision_id, withdraw: true })).structuredContent.error).toBe('denied');
    expect((await X.W1('team_ask_update', { decision_id: w.decision_id, withdraw: true })).structuredContent.status).toBe('withdrawn');
    expect(app.teams.task(t.id)!.status).toBe('assigned');
    // at most five open questions per agent
    for (let i = 0; i < 5; i++) expect((await X.S('team_ask', { team_id: X.tid, question: `Q${i}?` })).structuredContent.status).toBe('open');
    expect((await X.S('team_ask', { team_id: X.tid, question: 'Sixth?' })).structuredContent.error).toBe('rate_limited');
    // a lockdown stops asking but not reading the log
    app.lockdown.set('writes', undefined, true, null);
    try {
      expect((await X.R('team_ask', { team_id: X.tid, question: 'Locked?' })).structuredContent.error).toBe('lockdown');
      expect((await X.R('team_decisions', { team_id: X.tid, status: 'open' })).structuredContent.decisions.length).toBe(5);
    } finally { app.lockdown.set('writes', undefined, false, null); }
    // agents outside the team cannot read its log
    const out = mk('outsider-dec'); const O = await out.login();
    expect((await O('team_decisions', { team_id: X.tid })).isError).toBeTruthy();
  });
});

describe('permission changes are explained', () => {
  it('a notice says what changed (none when nothing did), and a denied call is marked allowed once access is granted', async () => {
    const a = mk('perm-diff');
    const base = [{ effect: 'allow' as const, actions: ['tool.invoke'], resource: 'tool:file_*' }, { effect: 'allow' as const, actions: ['fs.list', 'fs.read'], resource: 'path:/vault/A/**' }];
    app.keys.setRules(a.cred.policy_id, base, 'start', sys);
    const A = await a.login();
    await A('session_ack', { notice_seq: 1e6 });
    expect((await A('file_read', { path: '/vault/B/x.md' })).structuredContent.error).toBe('denied');
    const denied = () => api('GET', `/invocations?credential=${a.cred.id}`).then((r) => r.body.invocations.find((i: any) => i.tool === 'file_read'));
    expect(await denied()).toMatchObject({ result: 'denied', now_allowed: false, denied_action: 'fs.read', denied_path: '/vault/B/x.md' });
    app.keys.setRules(a.cred.policy_id, [...base, { effect: 'allow', actions: ['fs.read'], resource: 'path:/vault/B/**' }], 'let it read B', sys);
    const n = ((await A('session_whoami')).structuredContent.notices ?? []) as { kind: string; body: string }[];
    const msg = n.find((x) => x.kind === 'permissions_changed')!.body;
    expect(msg).toContain('added fs.read on path:/vault/B/**');
    expect(msg).toContain('let it read B');
    expect(await denied()).toMatchObject({ result: 'denied', now_allowed: true });
    // the same rules again: no notice
    const count = () => (app.db.prepare("SELECT COUNT(*) n FROM agent_notices WHERE agent_id=? AND kind='permissions_changed'").get(a.id) as { n: number }).n;
    const before = count();
    app.keys.setRules(a.cred.policy_id, [...base, { effect: 'allow', actions: ['fs.read'], resource: 'path:/vault/B/**' }], 'same again', sys);
    expect(count()).toBe(before);
  });
});

describe('decisions asked by the coordinator for a worker\'s task', () => {
  it('the worker also gets the answer, and the coordinator is told whose task it is', async () => {
    const X = await team({}, true);
    const t = await mkTask(X);
    await X.C('task_assign', { task_id: t.id, agent_id: X.w1.id });
    await Promise.all([X.C, X.W1].map((c) => c('session_ack', { notice_seq: 1e6 })));
    const q = (await X.C('team_ask', { team_id: X.tid, question: 'Rerun or park?', options: [{ key: 'a', label: 'Rerun' }, { key: 'b', label: 'Park' }], recommended: 'a', task_id: t.id })).structuredContent;
    await api('POST', `/decisions/${q.decision_id}/answer`, { option: 'a' });
    const w = ((await X.W1('session_whoami')).structuredContent.notices ?? []) as { kind: string; body: string }[];
    expect(w.some((n) => n.kind === 'decision' && n.body.includes('about your task') && n.body.includes('task_start'))).toBe(true);
    const c = ((await X.C('session_whoami')).structuredContent.notices ?? []) as { kind: string; body: string }[];
    expect(c.find((n) => n.kind === 'decision')!.body).toContain('assigned to w1 again');
  });
});

describe('directives: standing rules with scope, versions and read tracking', () => {
  it('agents see the directives in force, confirm the version they read, and the console sees who is behind', async () => {
    const X = await team();
    const dirPrj = await projectWith(X.w1.id, 'Dir');
    await Promise.all([X.C, X.W1, X.W2].map((c) => c('session_ack', { notice_seq: 1e6 })));
    const mk_ = (b: Record<string, unknown>) => api('POST', '/directives', b).then((r) => { expect(r.status).toBe(200); return r.body.directive; });
    const project = await mk_({ title: 'Token rules', body: 'Save as many tokens as possible.', scope: { kind: 'project', ref: dirPrj.id } });
    const teamD = await mk_({ title: 'Report daily', body: 'Post a status every day.', scope: { kind: 'team', ref: X.tid } });
    const role = await mk_({ title: 'Workers cite sources', body: 'Cite the vault note for each claim.', scope: { kind: 'role', ref: `${X.tid}|worker` } });
    // w1 is in project Dir and a worker: three directives, most specific first; w2 only the team and role ones; the coordinator only the team one
    const l1 = (await X.W1('directives_list')).structuredContent.directives;
    expect(l1.map((d: any) => d.id)).toEqual([role.id, teamD.id, project.id]);
    expect(l1.every((d: any) => d.read === 'unread')).toBe(true);
    expect((await X.W2('directives_list')).structuredContent.directives.map((d: any) => d.id)).toEqual([role.id, teamD.id]);
    expect((await X.C('directives_list')).structuredContent.directives.map((d: any) => d.id)).toEqual([teamD.id]);
    // a new directive arrives once as a notice; whoami lists titles only
    const n = ((await X.W1('session_whoami')).structuredContent.notices ?? []) as { kind: string; body: string }[];
    expect(n.filter((x) => x.kind === 'directive_changed').length).toBe(3);
    expect((await X.W1('session_whoami')).content[0]!.text).toContain('Directives in force');
    // read, then read and confirm
    expect((await X.W1('directives_read', { id: project.id })).structuredContent.directives[0].text).toBe('Save as many tokens as possible.');
    expect((await X.W1('directives_read', { id: project.id, ack: true })).structuredContent.acked).toEqual([{ id: project.id, version: 1 }]);
    let cov = (await api('GET', `/directives/${project.id}`)).body.coverage;
    expect(cov).toEqual([expect.objectContaining({ agent_id: X.w1.id, read: 'current' })]);
    // an edit bumps the version: w1 is now out of date and is told
    await api('PATCH', `/directives/${project.id}`, { body: 'Save tokens; slow down near the limit.', note: 'rule 10' });
    cov = (await api('GET', `/directives/${project.id}`)).body.coverage;
    expect(cov[0]).toMatchObject({ read: 'outdated', version: 1 });
    expect((await X.W1('directives_list')).structuredContent.directives.find((d: any) => d.id === project.id)).toMatchObject({ version: 2, read: 'outdated' });
    const list = (await api('GET', '/directives')).body.directives.find((d: any) => d.id === project.id);
    expect(list).toMatchObject({ agents: 1, outdated: 1, current: 0 });
    // retire: agents are told to stop, and it is no longer in force
    await api('POST', `/directives/${role.id}/retire`, { note: 'merged into the team rule' });
    expect((await X.W2('directives_list')).structuredContent.directives.map((d: any) => d.id)).toEqual([teamD.id]);
    const n2 = ((await X.W2('session_whoami')).structuredContent.notices ?? []) as { kind: string; body: string }[];
    expect(n2.some((x) => x.body.includes('retired') && x.body.includes('Stop following'))).toBe(true);
  });

  it('confirming a directive clears its notice without session_ack; reading clears a stop notice; unrelated notices and the cursor stay (6.A9-6.A11)', async () => {
    const a = mk('settle'), A = await a.login();
    await A('session_ack', { notice_seq: 1e6 });
    const ackedSeq = () => (app.db.prepare('SELECT MAX(t.notice_acked_seq) s FROM session_tokens t JOIN credentials c ON c.id=t.session_credential_id WHERE c.agent_id=?').get(a.id) as { s: number }).s;
    const seq0 = ackedSeq();
    const mk_ = (b: Record<string, unknown>) => api('POST', '/directives', b).then((r) => { expect(r.status).toBe(200); return r.body.directive; });
    const d = await mk_({ title: 'Settle on confirm', body: 'v1 text.', scope: { kind: 'agent', ref: a.id } });
    await api('PATCH', `/directives/${d.id}`, { body: 'v2 text.' });
    app.keys.notify(a.id, 'test_info', 'An unrelated notice.'); // N2: later seq, no ref
    const about = (r: { structuredContent?: any }) => ((r.structuredContent?.notices ?? []) as { kind: string; body: string }[]);
    let r = await A('directives_list');
    expect(about(r).filter((x) => x.body.includes(d.id)).map((x) => x.body)).toEqual([expect.stringContaining('New directive'), expect.stringContaining('Changed directive')]);
    expect(r.content.at(-1)!.text).toContain('Directive notices clear when you confirm the directive; stop notices clear on your next directives_read.');
    // 6.A9: confirm v2 in one call; the next answer carries no notice for D, and session_ack was never called.
    await A('directives_read', { id: d.id, ack: true });
    r = await A('directives_list');
    expect(about(r).filter((x) => x.body.includes(d.id))).toEqual([]);
    // 6.A11: the unrelated later notice is still pending (delivered once, on the first answer above) and the cursor did not move.
    expect(about(r)).toEqual([]);
    expect(r.structuredContent.notices_pending).toBe(1);
    expect(about(await A('session_whoami')).map((x) => x.body)).toEqual(['An unrelated notice.']);
    expect(r.content.at(-1)!.text).not.toContain('Directive notices clear');
    expect(ackedSeq()).toBe(seq0);
    // A new version brings a new notice.
    await api('PATCH', `/directives/${d.id}`, { body: 'v3 text.' });
    expect(about(await A('directives_list')).filter((x) => x.body.includes(d.id)).map((x) => x.body)).toEqual([expect.stringMatching(/^Changed directive: "Settle on confirm" \(dir_\w+, v3/)]);
    // 6.A10: retired, the stop notice rides along until the next directives_read in any form.
    await A('directives_read', { ack: true });
    await api('POST', `/directives/${d.id}/retire`, {});
    expect(about(await A('directives_list')).filter((x) => x.body.includes(d.id)).map((x) => x.body)).toEqual([expect.stringContaining('is retired')]);
    await new Promise((res) => setTimeout(res, 5));
    expect((await A('directives_read', { id: d.id })).isError).toBe(true); // not_found still counts as a read
    expect(about(await A('directives_list')).filter((x) => x.body.includes(d.id))).toEqual([]);
    expect(ackedSeq()).toBe(seq0);
    // The read that settles a stop notice still carries it: retired, then directives_read as the very next call.
    const e = await mk_({ title: 'Stop on the next read', body: 'Read me.', scope: { kind: 'agent', ref: a.id } });
    await A('directives_read', { id: e.id, ack: true });
    await api('POST', `/directives/${e.id}/retire`, {});
    await new Promise((res) => setTimeout(res, 5));
    const rd = await A('directives_read', { unread: true, ack: true });
    expect(rd.structuredContent.directives.map((x: { id: string }) => x.id)).not.toContain(e.id);
    expect(about(rd).filter((x) => x.body.includes(e.id)).map((x) => x.body)).toEqual([expect.stringContaining('is retired')]);
    expect(rd.content.at(-1)!.text).toContain('Stop following it.');
    expect(rd.content.at(-1)!.text).toContain('stop notices clear on your next directives_read.');
    // Delivered once, it is settled: the next answer does not repeat it.
    expect(about(await A('directives_list')).filter((x) => x.body.includes(e.id))).toEqual([]);
    expect(ackedSeq()).toBe(seq0);
  });

  it('the operator keeps a hub rule off a team and applies it again through the API; audited (6.A1, 6.A3, 6.A6)', async () => {
    const X = await team();
    await Promise.all([X.C, X.W1].map((c) => c('session_ack', { notice_seq: 1e6 })));
    const hub = (await api('POST', '/directives', { title: 'Kept off by API', body: 'For everyone.', scope: { kind: 'hub' } })).body.directive;
    const ex = await api('POST', `/directives/${hub.id}/exemptions`, { target_kind: 'team', target_ref: X.tid, note: 'Not for this team' });
    expect(ex.status).toBe(200);
    expect(ex.body).toMatchObject({ gained: 0, lost: 5, exemption: { target_kind: 'team', target_ref: X.tid, note: 'Not for this team' }, directive: { id: hub.id, version: 1 } });
    // The member sees only the stop notice, and the rule is gone from its list.
    const n = ((await X.W1('directives_list')).structuredContent.notices ?? []) as { body: string }[];
    expect(n.filter((x) => x.body.includes(hub.id)).map((x) => x.body)).toEqual([expect.stringContaining('no longer applies to you. Stop following it.')]);
    expect((await X.W1('directives_list')).structuredContent.directives.map((d: any) => d.id)).not.toContain(hub.id);
    expect((await X.W1('directives_read', { id: hub.id })).isError).toBe(true);
    const det = (await api('GET', `/directives/${hub.id}`)).body;
    expect(det).toMatchObject({ exempt_count: 1, directive: { reach_label: expect.stringMatching(/^All agents except team /) } });
    expect(det.coverage.map((c: any) => c.agent_id)).not.toContain(X.w1.id);
    expect((await api('GET', `/agents/${X.w1.id}/directives`)).body.exempted).toEqual([expect.objectContaining({ id: hub.id, exemption: expect.objectContaining({ kind: 'team', ref: X.tid }) })]);
    // Refusals answer with the hub's error codes.
    expect(await api('POST', `/directives/${hub.id}/exemptions`, { target_kind: 'team', target_ref: X.tid }).then((x) => [x.status, x.body.error])).toEqual([409, 'conflict']);
    expect(await api('POST', `/directives/${hub.id}/exemptions`, { target_kind: 'team', target_ref: 'tm_none' }).then((x) => [x.status, x.body.error])).toEqual([400, 'invalid_argument']);
    expect((await api('POST', `/directives/${hub.id}/exemptions`, { target_kind: 'role', target_ref: 'x' })).status).toBe(400);
    // Apply again: the team's members are told once.
    const del = await api('DELETE', `/directives/${hub.id}/exemptions/${ex.body.exemption.id}`);
    expect(del.status).toBe(200);
    expect(del.body).toMatchObject({ gained: 5, directive: { id: hub.id } });
    expect((await X.W1('directives_list')).structuredContent.directives.map((d: any) => d.id)).toContain(hub.id);
    expect((await api('DELETE', `/directives/${hub.id}/exemptions/${ex.body.exemption.id}`)).status).toBe(404);
    expect((await api('GET', `/directives/${hub.id}`)).body).toMatchObject({ exempt_count: 0, exemptions_removed: [expect.objectContaining({ id: ex.body.exemption.id })] });
    const acts = (app.db.prepare("SELECT action FROM audit_events WHERE target_id=? AND action LIKE 'directive.%exempt' ORDER BY rowid").all(hub.id) as { action: string }[]).map((x) => x.action);
    expect(acts).toEqual(['directive.exempt', 'directive.unexempt']);
    await api('POST', `/directives/${hub.id}/retire`, {});
    expect(await api('POST', `/directives/${hub.id}/exemptions`, { target_kind: 'team', target_ref: X.tid }).then((x) => [x.status, x.body.error])).toEqual([409, 'invalid_state']);
  });

  it('the team screen lists only what applies to the team, by scope, with hub-wide rules counted apart', async () => {
    const X = await team(), Y = await team();
    const teamDirPrj = await projectWith(X.w1.id, 'TeamDir');
    const mk_ = (b: Record<string, unknown>) => api('POST', '/directives', b).then((r) => { expect(r.status).toBe(200); return r.body.directive; });
    const hub = await mk_({ title: 'Hub rule', body: 'For everyone.', scope: { kind: 'hub' } });
    const own = await mk_({ title: 'Team rule', body: 'For X.', scope: { kind: 'team', ref: X.tid } });
    const role = await mk_({ title: 'Worker rule', body: 'For X workers.', scope: { kind: 'role', ref: `${X.tid}|worker` } });
    const mem = await mk_({ title: 'Member rule', body: 'For w1.', scope: { kind: 'agent', ref: X.w1.id } });
    const proj = await mk_({ title: 'Project rule', body: 'For TeamDir.', scope: { kind: 'project', ref: teamDirPrj.id } });
    const other = await mk_({ title: 'Other team rule', body: 'For Y.', scope: { kind: 'team', ref: Y.tid } });
    const v = (await api('GET', `/teams/${X.tid}/directives`)).body;
    const g = Object.fromEntries(v.directives.map((d: any) => [d.id, d.group]));
    expect(g).toMatchObject({ [own.id]: 'team', [role.id]: 'role', [mem.id]: 'member', [proj.id]: 'project', [hub.id]: 'hub' });
    expect(g[other.id]).toBeUndefined();
    // One tab each: this team's, role and project rules on "team", member rules on "members", hub-wide on "hub".
    const tab = Object.fromEntries(v.directives.map((d: any) => [d.id, d.tab]));
    expect(tab).toMatchObject({ [own.id]: 'team', [role.id]: 'team', [proj.id]: 'team', [mem.id]: 'members', [hub.id]: 'hub' });
    expect(v.directives.find((d: any) => d.id === hub.id)).toMatchObject({ exempt_here: null, copy_of: null, reach_label: 'All agents' });
    // Counts leave hub-wide rules out; each row says how many members read it.
    expect(v.hub).toBeGreaterThanOrEqual(1);
    expect(v).toMatchObject({ hub_exempt: 0, copies: 0 });
    expect(v.count).toBe(v.directives.filter((d: any) => d.tab !== 'hub').length);
    expect(v.hub).toBe(v.directives.filter((d: any) => d.tab === 'hub').length);
    expect(v.directives.find((d: any) => d.id === role.id)).toMatchObject({ agents: 2, current: 0 });
    // The tests share one hub: retire these so a hub-wide rule does not reach the next test's agents.
    for (const d of [hub, own, role, mem, proj, other]) await api('POST', `/directives/${d.id}/retire`, {});
  });

  it('the team screen flags member copies of a wider rule, returns kept-off rules marked and counts only what is in force', async () => {
    const X = await team();
    const made: { id: string }[] = [];
    const mk_ = (b: Record<string, unknown>) => api('POST', '/directives', b).then((r) => { expect(r.status).toBe(200); made.push(r.body.directive); return r.body.directive; });
    const tv = async () => (await api('GET', `/teams/${X.tid}/directives`)).body;
    const row = (v: any, id: string) => v.directives.find((d: any) => d.id === id);
    const base = await tv();
    // The tests share one hub: retire what this test makes even when an assertion fails.
    try {
      // A copy: w1's own rule says what the team rule says (same normalised title); w2's differs.
      const own = await mk_({ title: 'Run the linter', body: 'Lint before review.', scope: { kind: 'team', ref: X.tid } });
      const copy = await mk_({ title: 'run the LINTER.', body: 'Lint first.', scope: { kind: 'agent', ref: X.w1.id } });
      const solo = await mk_({ title: 'Keep notes', body: 'Notes in the vault.', scope: { kind: 'agent', ref: X.w2.id } });
      let v = await tv();
      expect(row(v, copy.id)).toMatchObject({ tab: 'members', copy_of: { id: own.id, title: 'Run the linter', scope_kind: 'team', scope_label: expect.stringMatching(/^team /) } });
      expect(row(v, solo.id)).toMatchObject({ tab: 'members', copy_of: null });
      expect(row(v, own.id)).toMatchObject({ tab: 'team', copy_of: null });
      expect(v.copies).toBe(base.copies + 1);
      // A hub rule kept off this team: returned on the hub tab, marked, and left out of hub and hub_behind.
      const hub = await mk_({ title: 'Hub rule kept off', body: 'For everyone else.', scope: { kind: 'hub' } });
      const ex = (await api('POST', `/directives/${hub.id}/exemptions`, { target_kind: 'team', target_ref: X.tid })).body.exemption;
      v = await tv();
      expect(row(v, hub.id)).toMatchObject({ tab: 'hub', exempt_here: { id: ex.id, kind: 'team', label: expect.stringMatching(/^team /), own: true }, agents: 0, current: 0, reach_label: expect.stringMatching(/^All agents except team /) });
      expect(v).toMatchObject({ hub: base.hub, hub_behind: base.hub_behind, hub_exempt: base.hub_exempt + 1 });
      // Kept off one member only, a team rule stays in force here: no mark, the row counts the others.
      const part = await mk_({ title: 'Team rule minus w2', body: 'Not for w2.', scope: { kind: 'team', ref: X.tid } });
      await api('POST', `/directives/${part.id}/exemptions`, { target_kind: 'agent', target_ref: X.w2.id });
      v = await tv();
      expect(row(v, part.id)).toMatchObject({ tab: 'team', exempt_here: null, agents: 4 });
      // A project exemption that covers every member keeps a team rule off the whole team: marked, out of count and behind.
      // The team's own project: its five members are in it through the team.
      const prj = app.blueprint.projectOfTeam(X.tid)!;
      const before = await tv();
      const all = await mk_({ title: 'Team rule kept off the project', body: 'Not for the project.', scope: { kind: 'team', ref: X.tid } });
      expect((await tv()).count).toBe(before.count + 1);
      const px = (await api('POST', `/directives/${all.id}/exemptions`, { target_kind: 'project', target_ref: prj.id })).body;
      expect(px.lost).toBe(5);
      v = await tv();
      expect(row(v, all.id)).toMatchObject({ tab: 'team', exempt_here: { id: px.exemption.id, kind: 'project', label: `project ${prj.name}`, own: false }, agents: 0 });
      expect(v).toMatchObject({ count: before.count, behind: before.behind, hub_exempt: base.hub_exempt + 1 });
      expect(v.count).toBe(v.directives.filter((d: any) => d.tab !== 'hub' && !d.exempt_here).length);
    } finally {
      for (const d of made) await api('POST', `/directives/${d.id}/retire`, {});
    }
  });

  /** A rule an agent registered before suggestions (docs/directives.md#suggestions-from-agents): in force for it, not reviewed. */
  const legacy = (agentId: string, title: string, body: string, proposed: string | null = null): string => {
    const id = `dir_legacy${Math.random().toString(36).slice(2, 10)}`, now = Date.now();
    app.db.prepare("INSERT INTO directives(id,title,body,scope_kind,scope_ref,version,status,source,created_by,created_at,updated_at,reported_by,reviewed_at,proposed_category) VALUES (?,?,?,'agent',?,1,'active',NULL,?,?,?,?,NULL,?)")
      .run(id, title, body, agentId, agentId, now, now, agentId, proposed);
    app.db.prepare("INSERT INTO directive_versions(directive_id,version,title,body,scope_kind,scope_ref,change_note,changed_by,created_at,category,tags) VALUES (?,1,?,?,'agent',?,'reported',?,?,NULL,'[]')")
      .run(id, title, body, agentId, agentId, now);
    return id;
  };

  it('rules agents registered before suggestions stay in force; the operator keeps, merges or edits them', async () => {
    const X = await team();
    await Promise.all([X.W1, X.W2].map((c) => c('session_ack', { notice_seq: 1e6 })));
    const r1 = { directive_id: legacy(X.w1.id, 'TOKEN-RULES.md', '1. Save tokens.\n10. Slow down near the limit.') };
    expect((await X.W1('directives_list')).structuredContent.directives).toEqual([expect.objectContaining({ id: r1.directive_id, title: 'TOKEN-RULES.md' })]);
    // the same rule from another agent: a second unreviewed directive, shown together
    const r2 = { directive_id: legacy(X.w2.id, 'Token rules', 'Save tokens.') };
    const list = (await api('GET', '/directives')).body;
    const mine = list.unreviewed.filter((d: any) => [r1.directive_id, r2.directive_id].includes(d.id));
    expect(mine.map((d: any) => d.key)).toEqual(['token rules', 'token rules']);
    expect((await api('GET', '/directives/unreviewed-count')).body.count).toBeGreaterThanOrEqual(2);
    // merge into one team directive: both reporters follow it, the two retire
    const merged = (await api('POST', '/directives/merge', { ids: [r1.directive_id, r2.directive_id], title: 'Token rules', body: 'Save tokens; slow down near the limit.', scope: { kind: 'team', ref: X.tid } })).body.directive;
    expect(merged).toMatchObject({ scope_kind: 'team', status: 'active' });
    expect((await api('GET', `/directives/${merged.id}`)).body.directive.reviewed_at).toBeTruthy();
    expect((await X.W1('directives_list')).structuredContent.directives.map((d: any) => d.id)).toEqual([merged.id]);
    const n = ((await X.W2('session_whoami')).structuredContent.notices ?? []) as { body: string }[];
    expect(n.some((x) => x.body.includes('is merged into'))).toBe(true);
    // keep as is: a single report marked reviewed; review all
    const r3 = { directive_id: legacy(X.w1.id, 'Cite sources', 'Cite the vault note.') };
    expect((await api('GET', `/directives/${r3.directive_id}`)).body.directive).toMatchObject({ reviewed_at: null, reported_by: X.w1.id, body: 'Cite the vault note.' });
    await api('POST', `/directives/${r3.directive_id}/review`);
    expect((await api('GET', `/directives/${r3.directive_id}`)).body.directive.reviewed_at).toBeTruthy();
    legacy(X.w2.id, 'Old habit', 'Re-read every file.');
    expect((await api('POST', '/directives/review-all', {})).body.reviewed).toBeGreaterThanOrEqual(1);
    expect((await api('GET', '/directives/unreviewed-count')).body.count).toBe(0);
    // an edit by the operator counts as a review and reaches the agent as a change
    await api('PATCH', `/directives/${r3.directive_id}`, { scope: { kind: 'team', ref: X.tid }, note: 'for the whole team' });
    expect((await X.W2('directives_list')).structuredContent.directives.some((d: any) => d.id === r3.directive_id)).toBe(true);
  });

  it('categories and tags: the operator files directives, agents filter by them and only propose a category', async () => {
    const X = await team();
    await Promise.all([X.W1, X.W2].map((c) => c('session_ack', { notice_seq: 1e6 })));
    const mk_ = (b: Record<string, unknown>) => api('POST', '/directives', b).then((r) => { expect(r.status).toBe(200); return r.body.directive; });
    const tok = await mk_({ title: 'Save tokens', body: 'Read only what the task touches.', scope: { kind: 'team', ref: X.tid }, category: 'tokens', tags: ['Budget', 'budget', 'context window'] });
    expect(tok).toMatchObject({ category: 'tokens', tags: ['budget', 'context-window'] });
    const cite = await mk_({ title: 'Cite notes', body: 'Cite the vault note.', scope: { kind: 'team', ref: X.tid } });
    expect((await api('POST', '/directives', { title: 'x', body: 'y', scope: { kind: 'hub' }, category: 'nope' })).status).toBe(400);
    expect((await api('GET', '/directives/categories')).body.categories.map((c: any) => c.label)).toEqual(['Access & security', 'Communication', 'Token economy', 'Reporting', 'Sources & quality', 'Process & workflow', 'Tooling']);
    // admin list and MCP list filter by category and tag; a category id or "none"
    const ids = (q: string) => api('GET', '/directives' + q).then((r) => r.body.directives.map((d: any) => d.id).filter((i: string) => [tok.id, cite.id].includes(i)));
    expect(await ids('?category=tokens')).toEqual([tok.id]);
    expect(await ids('?category=none')).toEqual([cite.id]);
    expect(await ids('?tag=budget')).toEqual([tok.id]);
    const byCat = (await X.W1('directives_list', { category: 'tokens' })).structuredContent;
    expect(byCat.directives).toEqual([expect.objectContaining({ id: tok.id, category: 'tokens', tags: ['budget', 'context-window'] })]);
    expect((await X.W1('directives_list', { tag: 'context-window' })).content[0]!.text).toContain('Token economy');
    expect((await X.W1('directives_read', { id: tok.id })).structuredContent.directives[0]).toMatchObject({ category: 'tokens' });
    // login and whoami stay one short line per directive: no category or tags
    expect((await X.W1('session_whoami')).structuredContent.directives[0]).not.toHaveProperty('category');
    // filing is not a new version and sends no notice
    await X.W1('session_ack', { notice_seq: 1e6 });
    const changed = (await api('POST', '/directives/categorize', { ids: [tok.id, cite.id], category: 'sources', add_tags: ['vault'] })).body.changed;
    expect(changed).toBe(2);
    const c2 = (await api('GET', `/directives/${cite.id}`)).body;
    expect(c2.directive).toMatchObject({ version: 1, category: 'sources', tags: ['vault'] });
    expect(((await X.W1('session_whoami')).structuredContent.notices ?? []).filter((n: any) => n.kind === 'directive_changed')).toEqual([]);
    // a text edit makes a version that records the category and tags it was saved with
    await api('PATCH', `/directives/${cite.id}`, { body: 'Cite the vault note and line.', tags: ['vault', 'citations'] });
    expect((await api('GET', `/directives/${cite.id}`)).body.versions[0]).toMatchObject({ version: 2, category: 'sources', tags: ['vault', 'citations'] });
    // agents only propose: the category is set when the operator reviews (kept as proposed, or changed)
    const r = { directive_id: legacy(X.w1.id, 'Ask before pushing', 'Never push without asking.', 'access') };
    let d = (await api('GET', `/directives/${r.directive_id}`)).body.directive;
    expect(d).toMatchObject({ category: null, proposed_category: 'access' });
    expect((await X.W1('directives_report', { title: 'x', summary: 'y', category: 'bogus' })).isError).toBe(true);
    await api('POST', `/directives/${r.directive_id}/review`, {});
    d = (await api('GET', `/directives/${r.directive_id}`)).body.directive;
    expect(d).toMatchObject({ category: 'access', proposed_category: null });
    const r2 = { directive_id: legacy(X.w2.id, 'Daily status', 'Post a status daily.', 'communication') };
    await api('POST', `/directives/${r2.directive_id}/review`, { category: 'reporting' });
    expect((await api('GET', `/directives/${r2.directive_id}`)).body.directive).toMatchObject({ category: 'reporting', proposed_category: null });
    // review-all confirms proposals too; merge keeps a shared category
    const a1 = { directive_id: legacy(X.w1.id, 'Short replies', 'Keep replies short.', 'tokens') };
    const a2 = { directive_id: legacy(X.w2.id, 'Short replies', 'Be brief.', 'tokens') };
    const m = (await api('POST', '/directives/merge', { ids: [a1.directive_id, a2.directive_id], title: 'Short replies', body: 'Keep replies short.', scope: { kind: 'team', ref: X.tid } })).body.directive;
    expect(m.category).toBe('tokens');
    const a3 = { directive_id: legacy(X.w1.id, 'Use the CLI', 'Prefer the CLI.', 'tooling') };
    await api('POST', '/directives/review-all', {});
    expect((await api('GET', `/directives/${a3.directive_id}`)).body.directive.category).toBe('tooling');
    // a suggestion keeps the category the agent proposed, and adopting it files the directive under it
    const s = (await X.W1('directives_report', { title: 'Ask in the team room', summary: 'Ask questions in the team room.', category: 'communication' })).structuredContent;
    expect(s).toMatchObject({ status: 'open', proposed_category: 'communication' });
    const ad = (await api('POST', `/directive-reports/${s.report_id}/adopt`, { body: 'Ask questions in the team room.' })).body;
    expect(ad.directive).toMatchObject({ category: 'communication', scope_kind: 'team', scope_ref: X.tid });
  });
});
