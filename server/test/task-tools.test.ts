/**
 * Task tools (task_sesyl47ywvjc5ioh): the compact task_list, inline notices capped at 5, task_progress until up to
 * 14 days, relayed operator answers (team_ask_update relayed_answer; docs/decisions.md#relayed-answers), and a
 * regression test for fb_ue42pdolrkbw6 (task_update must not reset a started task), and the task-turn results
 * (docs/proposals/console-systems.md §8.4, TASKFLOW-5): data.handoff and the wake line, turn and queue_position in
 * task_list, my_turns in session_whoami, and the shipped hand-off playbook line.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HANDOFF_LINE, ON_DEMAND_PLAYBOOKS } from '../src/teams/teams.js';
import { BLOCK_ASK_HINT } from '../src/mcp/teamTools.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import { intakeOpen } from './intake.js';
import type { Config } from '../src/config.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
const DAY = 24 * 3600_000;
let app: App, base: string, cookie = '', csrf = '', appKey = '';

const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
type Res = { isError?: boolean; structuredContent?: any; content: { text: string }[] };
type Call = (name: string, args?: Record<string, unknown>) => Promise<Res>;
async function loginWith(secret: string): Promise<Call> {
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  const token = ((await c.callTool({ name: 'session_login', arguments: { session_key: secret } })) as any).structuredContent.session_token as string;
  return async (name, args = {}) => (await c.callTool({ name, arguments: { session_token: token, ...args } })) as never;
}
let n = 0;
const mk = (label: string) => {
  const agent = app.keys.createAgent(`${label}-${++n}`, null, sys);
  const k = app.keys.createSessionKey({ agentId: agent.id, label: `${label} key` }, sys);
  return { id: agent.id, login: () => loginWith(k.secret) };
};
/** A running team: coordinator, two workers and a reviewer, logged in (one delivery model: every team is woken). */
async function team() {
  const [c, w1, w2, r, r2] = ['coord', 'w1', 'w2', 'rev', 'rev2'].map(mk) as ReturnType<typeof mk>[];
  const res = await api('POST', '/teams', { name: `tt${++n}`, goal: 'ship it',
    members: [{ agent_id: c!.id, role: 'coordinator' }, { agent_id: w1!.id, role: 'worker' }, { agent_id: w2!.id, role: 'worker' }, { agent_id: r!.id, role: 'reviewer' }, { agent_id: r2!.id, role: 'reviewer' }] });
  expect(res.status).toBe(201);
  const tid = res.body.team.id as string;
  expect((await api('POST', `/teams/${tid}/start`)).status).toBe(200);
  const [C, W1, W2, R] = await Promise.all([c!, w1!, w2!, r!].map((x) => x.login()));
  return { tid, c: c!, w1: w1!, w2: w2!, r: r!, r2: r2!, C: C!, W1: W1!, W2: W2!, R: R! };
}
type T = Awaited<ReturnType<typeof team>>;
const mkTask = async (X: T, over: Record<string, unknown> = {}) =>
  (await X.C('task_create', { team_id: X.tid, title: 'do it', description: 'LONG-DESCRIPTION', reviewer: X.r.id, ...over })).structuredContent.task;
const started = async (X: T, over: Record<string, unknown> = {}) => {
  const t = await mkTask(X, over);
  expect((await X.C('task_assign', { task_id: t.id, agent_id: X.w1.id })).isError).toBeFalsy();
  expect((await X.W1('task_start', { task_id: t.id })).isError).toBeFalsy();
  return app.teams.task(t.id)!;
};
const code = (r: Res) => (r.isError ? r.structuredContent?.error : 'ok');

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahtt-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  const config: Config = testConfig(dir);
  app = await buildApp(config);
  intakeOpen(app);
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base));
  const pc = (await api('POST', '/pcs', { name: 'pc' })).body.pc.id;
  appKey = app.keys.createAppKey({ machineId: pc, appName: 'claude-code', maxLiveSessions: 500 }, sys).secret;
});
afterAll(async () => { await app?.close(); });

describe('task_list gives an overview', () => {
  it('one line per task by default, without done and cancelled, most recently changed first', async () => {
    const X = await team();
    const a = await mkTask(X, { title: 'first' });
    const b = await mkTask(X, { title: 'second' });
    const c = await mkTask(X, { title: 'dropped' });
    expect((await X.C('task_cancel', { task_id: c.id, reason: 'not needed' })).isError).toBeFalsy();
    app.db.prepare('UPDATE tasks SET updated_at=updated_at+1000 WHERE id=?').run(a.id);
    const r = await X.C('task_list', { team_id: X.tid });
    const tasks = r.structuredContent.tasks as Record<string, unknown>[];
    expect(tasks.map((t) => t.id)).toEqual([a.id, b.id]);
    expect(Object.keys(tasks[0]!).sort()).toEqual(['assignee', 'id', 'queue_position', 'refs', 'reviewer', 'status', 'tags', 'team_id', 'title', 'turn', 'updated_at', 'version']);
    expect(tasks[0]).toMatchObject({ turn: null, queue_position: null }); // an open task waits on nobody
    expect(r.content[0]!.text).not.toContain('LONG-DESCRIPTION');
    expect(r.structuredContent).toMatchObject({ total: 2, next_cursor: null });
    // status names them, or "all".
    expect((await X.C('task_list', { team_id: X.tid, status: 'cancelled' })).structuredContent.tasks.map((t: any) => t.id)).toEqual([c.id]);
    expect((await X.C('task_list', { team_id: X.tid, status: 'all' })).structuredContent.total).toBe(3);
  });

  it('detail "full" or task_id adds the description, summary and review comments', async () => {
    const X = await team();
    const t = await mkTask(X);
    const full = await X.C('task_list', { team_id: X.tid, detail: 'full' });
    expect(full.structuredContent.tasks[0]).toMatchObject({ id: t.id, description: 'LONG-DESCRIPTION', summary: null, review_comments: null });
    expect(full.content[0]!.text).toContain('LONG-DESCRIPTION');
    const one = await X.W1('task_list', { task_id: t.id });
    expect(one.structuredContent.tasks).toHaveLength(1);
    expect(one.structuredContent.tasks[0]).toMatchObject({ id: t.id, description: 'LONG-DESCRIPTION' });
    // Another team's task is not found.
    const Y = await team();
    expect(code(await Y.C('task_list', { task_id: t.id }))).toBe('denied');
  });

  it('pages with limit and cursor', async () => {
    const X = await team();
    for (let i = 0; i < 5; i++) await mkTask(X, { title: `t${i}` });
    const p1 = (await X.C('task_list', { team_id: X.tid, limit: 2 })).structuredContent;
    expect(p1.tasks).toHaveLength(2);
    expect(p1.total).toBe(5);
    const p2 = (await X.C('task_list', { team_id: X.tid, limit: 2, cursor: p1.next_cursor })).structuredContent;
    const p3 = (await X.C('task_list', { team_id: X.tid, limit: 2, cursor: p2.next_cursor })).structuredContent;
    expect(p3.next_cursor).toBeNull();
    expect(new Set([...p1.tasks, ...p2.tasks, ...p3.tasks].map((t: any) => t.id)).size).toBe(5);
    expect(code(await X.C('task_list', { team_id: X.tid, cursor: 'nope!' }))).toBe('invalid_argument');
    const text = (await X.C('task_list', { team_id: X.tid, limit: 2 })).content[0]!.text;
    expect(text).toContain(`pass cursor ${p1.next_cursor}`);
  });
});

describe('notices on answers', () => {
  it('ride along at most 5 at a time, with a count; session_whoami lists up to 20', async () => {
    const a = mk('noisy');
    const A = await a.login();
    for (let i = 0; i < 8; i++) app.keys.notify(a.id, 'directive', `note ${i}`);
    const r = await A('task_list');
    expect(r.structuredContent.notices).toHaveLength(5);
    expect(r.structuredContent.notices_more).toBe(3);
    expect(r.content.at(-1)!.text).toContain('3 more after these');
    expect((await A('session_whoami')).structuredContent.notices).toHaveLength(8);
  });
});

describe('task_progress until', () => {
  it('may lie up to 14 days ahead; later is cut to 14 days, the past is refused', async () => {
    const X = await team();
    const t = await started(X);
    const ten = Date.now() + 10 * DAY;
    expect((await X.W1('task_progress', { task_id: t.id, note: 'long run', until: ten })).structuredContent.task).toMatchObject({ progress_until: ten, lease_expires_at: ten });
    const before = Date.now();
    const far = (await X.W1('task_progress', { task_id: t.id, until: Date.now() + 30 * DAY })).structuredContent.task;
    expect(far.progress_until).toBeGreaterThanOrEqual(before + 14 * DAY);
    expect(far.progress_until).toBeLessThanOrEqual(Date.now() + 14 * DAY);
    expect(code(await X.W1('task_progress', { task_id: t.id, until: Date.now() - 1000 }))).toBe('invalid_argument');
    // A seconds-instead-of-ms mistake is in the past too.
    expect(code(await X.W1('task_progress', { task_id: t.id, until: Math.floor(Date.now() / 1000) + 3600 }))).toBe('invalid_argument');
  });

  it('flags a task overdue only once its check-in time has really passed, and never a queued one', async () => {
    const X = await team();
    const t = await started(X);
    // A second task assigned to the same worker waits queued: task_progress until on it sets no deadline (§8.2).
    const q = await mkTask(X);
    await X.C('task_assign', { task_id: q.id, agent_id: X.w1.id });
    await X.W1('task_progress', { task_id: q.id, until: Date.now() + DAY });
    expect(app.teams.task(q.id)).toMatchObject({ status: 'assigned', lease_expires_at: null, overdue_at: null });
    await X.W1('task_progress', { task_id: t.id, until: Date.now() + 3 * DAY });
    app.teams.tick();
    expect(app.teams.task(t.id)!.overdue_at).toBeNull();
    app.db.prepare('UPDATE tasks SET lease_expires_at=?, progress_until=? WHERE id=?').run(Date.now() - 1000, Date.now() - 1000, t.id);
    app.db.prepare('UPDATE tasks SET progress_until=? WHERE id=?').run(Date.now() - 1000, q.id);
    app.teams.tick();
    expect(app.teams.task(t.id)!.overdue_at).toBeGreaterThan(0);
    expect(app.db.prepare("SELECT overdue_at FROM task_turns WHERE task_id=? AND closed_at IS NULL AND phase='work'").get(t.id)).toMatchObject({ overdue_at: app.teams.task(t.id)!.overdue_at });
    expect(app.teams.task(q.id)!.overdue_at).toBeNull();
    expect(app.db.prepare("SELECT COUNT(*) n FROM security_alerts WHERE type='task_overdue' AND subject=?").get(q.id)).toMatchObject({ n: 0 });
  });
});

describe('relayed operator answers (docs/decisions.md#relayed-answers)', () => {
  const ask = async (X: T, taskId: string, extra: Record<string, unknown> = {}) => {
    const r = await X.W1('team_ask', { team_id: X.tid, question: 'Which alloy?', task_id: taskId, options: [{ key: 'a', label: 'HC-7' }, { key: 'b', label: 'HC-9' }], recommended: 'b', ...extra });
    expect(r.isError).toBeFalsy();
    expect(app.teams.task(taskId)!.status).toBe('blocked');
    return r.structuredContent.decision_id as string;
  };

  it('task_block leaves out the team_ask hint while a question about the task is open', async () => {
    const X = await team();
    const t = await started(X);
    await ask(X, t.id);
    // The assignee lifts the question's block (the question stays open); the coordinator blocks the task again.
    expect(code(await X.W1('task_unblock', { task_id: t.id }))).toBe('ok');
    const r = await X.C('task_block', { task_id: t.id, reason: 'hold for the alloy' });
    expect(code(r)).toBe('ok');
    expect(r.content![0]!.text).not.toContain('team_ask');
  });

  it('only the asking team\'s coordinator relays, with an answer and a source; it unblocks the task and stays L1', async () => {
    const X = await team();
    const t = await started(X);
    const id = await ask(X, t.id);
    expect(code(await X.W1('team_ask_update', { decision_id: id, relayed_answer: 'HC-9', source: 'chat' }))).toBe('denied');
    const Y = await team();
    expect(code(await Y.C('team_ask_update', { decision_id: id, relayed_answer: 'HC-9', source: 'chat' }))).toBe('denied');
    expect(code(await X.C('team_ask_update', { decision_id: id, relayed_answer: 'HC-9' }))).toBe('invalid_argument');
    expect(code(await X.C('team_ask_update', { decision_id: id, source: 'chat' }))).toBe('invalid_argument');
    expect(code(await X.C('team_ask_update', { decision_id: id, relayed_answer: 'HC-9', chosen: 'z', source: 'chat' }))).toBe('invalid_argument');
    const r = await X.C('team_ask_update', { decision_id: id, relayed_answer: 'Go with HC-9, damping matters more.', chosen: 'b', source: 'chat with operator' });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ trust: 'L1', status: 'answered', answer_option: 'b', relay: { state: 'pending', by: X.c.id, source: 'chat with operator' } });
    expect(r.content[0]!.text).toMatch(/relayed by .* from chat with operator; L1 until the operator confirms it/);
    expect(app.teams.task(t.id)!.status).toBe('in_progress');
    const note = app.db.prepare("SELECT body FROM agent_notices WHERE agent_id=? AND kind='decision' ORDER BY seq DESC LIMIT 1").get(X.w1.id) as { body: string };
    expect(note.body).toMatch(/relayed an answer from the operator to question .* relayed \(L1\) until the operator confirms it\. Read it with team_decisions/);
    // The decision log shows it as relayed; the operator's own answer route refuses it (it is no longer open).
    const log = await X.R('team_decisions', { team_id: X.tid, status: 'all' });
    expect(log.structuredContent.decisions[0]).toMatchObject({ decision_id: id, trust: 'L1' });
    expect(log.content[0]!.text).toContain('relayed by');
    expect((await api('POST', `/decisions/${id}/answer`, { option: 'a' })).status).toBe(409);
    // A second relay is refused.
    expect(code(await X.C('team_ask_update', { decision_id: id, relayed_answer: 'again', source: 'chat' }))).toBe('invalid_state');
  });

  it('the operator confirms it: it becomes L0', async () => {
    const X = await team();
    const t = await started(X);
    const id = await ask(X, t.id);
    await X.C('team_ask_update', { decision_id: id, relayed_answer: 'HC-9', chosen: 'b', source: 'chat with operator' });
    const c = await api('POST', `/decisions/${id}/confirm`, {});
    expect(c.status).toBe(200);
    expect(c.body.decision).toMatchObject({ trust: 'L0', relay_state: 'confirmed', answer_option: 'b' });
    expect(c.body.decision.answered_by_name).toBe('admin');
    expect((await api('POST', `/decisions/${id}/confirm`, {})).status).toBe(409);
    expect((await api('POST', `/decisions/${id}/overturn`, { option: 'a' })).status).toBe(409);
    const n = app.db.prepare("SELECT body FROM agent_notices WHERE agent_id=? AND kind='decision' ORDER BY seq DESC LIMIT 1").get(X.w1.id) as { body: string };
    expect(n.body).toContain('The operator confirmed the relayed answer');
    expect((await X.R('team_decisions', { team_id: X.tid, decision_id: id })).structuredContent.decisions[0]).toMatchObject({ trust: 'L0', relay: { state: 'confirmed' } });
  });

  it('the operator overturns it: the operator\'s answer replaces it, the relayed one stays on record, the task is not blocked again', async () => {
    const X = await team();
    const t = await started(X);
    const id = await ask(X, t.id);
    await X.C('team_ask_update', { decision_id: id, relayed_answer: 'HC-9', chosen: 'b', source: 'chat with operator' });
    expect((await api('POST', `/decisions/${id}/overturn`, {})).status).toBe(400);
    const o = await api('POST', `/decisions/${id}/overturn`, { option: 'a', text: 'No: requalify HC-7.' });
    expect(o.status).toBe(200);
    expect(o.body.decision).toMatchObject({ trust: 'L0', relay_state: 'overturned', answer_option: 'a', answer_text: 'No: requalify HC-7.', relayed_option: 'b', relayed_text: 'HC-9' });
    expect(app.teams.task(t.id)!.status).toBe('in_progress');
    const n = app.db.prepare("SELECT body FROM agent_notices WHERE agent_id=? AND kind='decision' ORDER BY seq DESC LIMIT 1").get(X.w1.id) as { body: string };
    expect(n.body).toContain('The operator overturned the relayed answer');
  });

  it('a confirm or overturn only applies to a relayed answer', async () => {
    const X = await team();
    const t = await started(X);
    const id = await ask(X, t.id);
    expect((await api('POST', `/decisions/${id}/confirm`, {})).status).toBe(409);
    await api('POST', `/decisions/${id}/answer`, { option: 'b' });
    expect((await api('POST', `/decisions/${id}/confirm`, {})).status).toBe(409);
    expect((await api('GET', `/decisions/${id}`)).body.decision).toMatchObject({ trust: 'L0', relay_state: null });
  });

  it('a Blueprint decision waits for the operator\'s confirmation', async () => {
    const X = await team();
    const t = await started(X);
    const id = await ask(X, t.id, { decision: true });
    const r = await X.C('team_ask_update', { decision_id: id, relayed_answer: 'HC-9', chosen: 'b', source: 'chat with operator' });
    expect(r.structuredContent.bp_key).toBeNull();
    const c = await api('POST', `/decisions/${id}/confirm`, {});
    expect(c.body.decision.bp_key).toMatch(/^ADR-\d{3}$/);
  });
});

describe('task_update keeps a started task where it is (fb_ue42pdolrkbw6)', () => {
  it('on in_progress and in_review: title, description, refs and reviewer change, the status does not, and task_submit still works', async () => {
    const X = await team();
    const t = await started(X);
    let v = app.teams.task(t.id)!.version;
    for (const change of [{ title: 'renamed' }, { description: 'new words' }, { refs: [] }, { reviewer: X.r2.id }]) {
      const u = await X.C('task_update', { task_id: t.id, version: v, ...change });
      expect(u.isError ? u.content[0]!.text : null).toBeNull();
      expect(u.structuredContent.task.status).toBe('in_progress');
      expect(u.structuredContent.task.assignee).toBe(X.w1.id);
      v = u.structuredContent.task.version;
    }
    const s1 = await X.W1('task_submit', { task_id: t.id, summary: 'first' });
    expect(s1.structuredContent.task).toMatchObject({ status: 'in_review', reviewer: X.r2.id });
    v = s1.structuredContent.task.version;
    for (const change of [{ title: 'renamed again' }, { description: 'more words' }, { refs: [] }, { reviewer: X.r.id }]) {
      const u = await X.C('task_update', { task_id: t.id, version: v, ...change });
      expect(u.isError ? u.content[0]!.text : null).toBeNull();
      expect(u.structuredContent.task.status).toBe('in_review');
      v = u.structuredContent.task.version;
    }
    const s2 = await X.W1('task_submit', { task_id: t.id, summary: 'replaced' });
    expect(s2.isError).toBeFalsy();
    expect(s2.structuredContent.task).toMatchObject({ status: 'in_review', reviewer: X.r.id, summary: 'replaced' });
  });
});

describe('the reviewer hears about a submission', () => {
  const notices = (id: string) => app.db.prepare("SELECT body FROM agent_notices WHERE agent_id=? AND kind='review_requested'").all(id) as { body: string }[];
  const items = (id: string, task: string) => (app.db.prepare("SELECT COUNT(*) n FROM work_items WHERE agent_id=? AND kind='review_requested' AND ref_id=? AND acked_at IS NULL").get(id, task) as { n: number }).n;
  const reviewTurns = (task: string) => app.db.prepare("SELECT holder_agent_id, seen_at FROM task_turns WHERE task_id=? AND phase='review' AND closed_at IS NULL").all(task).map((x) => ({ ...x }));
  it('a reviewer gets a review_requested notice on the first submit', async () => {
    const X = await team();
    const t = await started(X);
    expect(code(await X.W1('task_submit', { task_id: t.id, summary: 'done' }))).toBe('ok');
    const n = notices(X.r.id);
    expect(n).toHaveLength(1);
    expect(n[0]!.body).toContain(t.id);
    expect(n[0]!.body).not.toContain('done'); // the summary is L1, read through task_list
    // 8.A5 (turn side): one work item and one open review turn the reviewer has not seen yet.
    expect(items(X.r.id, t.id)).toBe(1);
    expect(reviewTurns(t.id)).toEqual([{ holder_agent_id: X.r.id, seen_at: null }]);
  });
});

describe('hand-off results (§8.4, TASKFLOW-5)', () => {
  const noticeCount = (id: string, kind: string, task: string) => (app.db.prepare('SELECT COUNT(*) n FROM agent_notices WHERE agent_id=? AND kind=? AND body LIKE ?').get(id, kind, `%${task}%`) as { n: number }).n;
  const itemCount = (id: string, kind: string, task: string) => (app.db.prepare('SELECT COUNT(*) n FROM work_items WHERE agent_id=? AND kind=? AND ref_id=? AND acked_at IS NULL').get(id, kind, task) as { n: number }).n;
  const label = (id: string) => app.keys.agent(id)!.label;

  it('8.A5: a submit names the reviewer, the wake text and the wake line, never task content', async () => {
    const X = await team();
    const t = await started(X, { title: 'SECRET-TITLE' });
    const r = await X.W1('task_submit', { task_id: t.id, summary: 'SECRET-SUMMARY' });
    expect(r.structuredContent.handoff).toEqual({ to: X.r.id, to_label: label(X.r.id), phase: 'review', on_demand: true, seen: false, wake_text: `review ${t.id}` });
    const line = r.content[0]!.text.split('\n').find((l) => l.includes('only sees this when woken'))!;
    expect(line).toBe(`${label(X.r.id)} only sees this when woken. Tell its session: review ${t.id}`);
    expect(line).not.toContain('SECRET');
    expect(noticeCount(X.r.id, 'review_requested', t.id)).toBe(1);
    expect(itemCount(X.r.id, 'review_requested', t.id)).toBe(1);
    expect(app.db.prepare("SELECT COUNT(*) n FROM task_turns WHERE task_id=? AND phase='review' AND closed_at IS NULL AND seen_at IS NULL").get(t.id)).toMatchObject({ n: 1 });
  });

  it('8.A9: no team gets on_demand false or a hand-off without wake text any more', async () => {
    const X = await team();
    const t = await started(X);
    const r = await X.W1('task_submit', { task_id: t.id, summary: 'done' });
    expect(r.structuredContent.handoff).toMatchObject({ to: X.r.id, phase: 'review', on_demand: true, wake_text: `review ${t.id}` });
    expect(r.content[0]!.text).toContain(`${label(X.r.id)} only sees this when woken`);
    expect(noticeCount(X.r.id, 'review_requested', t.id)).toBe(1);
  });

  it('8.A10: a assignment sends a task_assigned notice and a work item, and the hand-off is queued', async () => {
    const X = await team();
    const t = await mkTask(X);
    const r = await X.C('task_assign', { task_id: t.id, agent_id: X.w1.id });
    expect(r.structuredContent.handoff).toEqual({ to: X.w1.id, to_label: label(X.w1.id), phase: 'queued', on_demand: true, seen: false, wake_text: `start ${t.id}` });
    expect(r.content[0]!.text).toContain(`Tell its session: start ${t.id}`);
    expect(noticeCount(X.w1.id, 'task_assigned', t.id)).toBe(1);
    expect(itemCount(X.w1.id, 'task_assigned', t.id)).toBe(1);
  });

  it('task_review request_changes, task_unblock and a task_update reviewer change hand off; approve and plain edits do not', async () => {
    const X = await team();
    const t = await started(X);
    const v = (await X.W1('task_submit', { task_id: t.id, summary: 'first' })).structuredContent.task.version;
    // A new reviewer while in review: the hand-off goes to them.
    const u = await X.C('task_update', { task_id: t.id, version: v, reviewer: X.r2.id });
    expect(u.structuredContent.handoff).toMatchObject({ to: X.r2.id, phase: 'review', on_demand: true, wake_text: `review ${t.id}` });
    const plain = await X.C('task_update', { task_id: t.id, version: u.structuredContent.task.version, title: 'renamed' });
    expect(plain.structuredContent.handoff).toBeUndefined();
    const R2 = await X.r2.login();
    const rc = await R2('task_review', { task_id: t.id, decision: 'request_changes', comments: 'one more test', version: plain.structuredContent.task.version });
    expect(rc.structuredContent.handoff).toMatchObject({ to: X.w1.id, phase: 'queued', on_demand: true, wake_text: `start ${t.id}` });
    // Blocked and unblocked: whoever the task waits on again is named.
    const blk = await X.C('task_block', { task_id: t.id, reason: 'hold' });
    expect(code(blk)).toBe('ok');
    // No open question on the task: the result points at team_ask, so a wait for the operator reaches their Needs you.
    expect(blk.content![0]!.text).toContain(BLOCK_ASK_HINT);
    const ub = await X.C('task_unblock', { task_id: t.id });
    expect(ub.structuredContent.handoff).toMatchObject({ to: X.w1.id, phase: 'queued', wake_text: `start ${t.id}` });
    // Approve: nobody holds the task, so no hand-off.
    await X.W1('task_start', { task_id: t.id });
    const s = await X.W1('task_submit', { task_id: t.id, summary: 'fixed' });
    const ok = await R2('task_review', { task_id: t.id, decision: 'approve', comments: 'fine', version: s.structuredContent.task.version });
    expect(ok.structuredContent.task.status).toBe('approved');
    expect(ok.structuredContent.handoff).toBeUndefined();
    expect(ok.content[0]!.text).not.toContain('Hand-off');
  });
});

describe('task turns in task_list and session_whoami (§8.4)', () => {
  it('task_list shows the turn and each assignee\'s queue in hand-off order; starting one moves the rest up', async () => {
    const X = await team();
    const ts: { id: string }[] = [];
    for (const title of ['q1', 'q2', 'q3']) {
      const t = await mkTask(X, { title });
      expect(code(await X.C('task_assign', { task_id: t.id, agent_id: X.w1.id }))).toBe('ok');
      ts.push(t);
    }
    const other = await mkTask(X, { title: 'for w2' });
    await X.C('task_assign', { task_id: other.id, agent_id: X.w2.id });
    const list = async (call: Call, args: Record<string, unknown> = {}) => {
      const r = await call('task_list', { team_id: X.tid, ...args });
      return { r, m: new Map((r.structuredContent.tasks as any[]).map((t) => [t.id as string, t])) };
    };
    let { r, m } = await list(X.C);
    expect(ts.map((t) => m.get(t.id).queue_position)).toEqual([1, 2, 3]);
    expect(m.get(other.id).queue_position).toBe(1); // per assignee
    expect(m.get(ts[1]!.id).turn).toMatchObject({ phase: 'queued', holder: X.w1.id, seen_at: null, due_at: null });
    expect(typeof m.get(ts[1]!.id).turn.since).toBe('number');
    expect(r.content[0]!.text).toMatch(new RegExp(`${ts[1]!.id} \\[assigned\\].* turn=queued holder=${X.w1.id} queue=2 unseen`));
    // Starting the first one gives it a work turn with a deadline; a list fetch leaves the others unseen, a full read of one marks it seen.
    expect(code(await X.W1('task_start', { task_id: ts[0]!.id }))).toBe('ok');
    ({ r, m } = await list(X.W1, { assignee: 'me' }));
    expect(m.get(ts[0]!.id)).toMatchObject({ queue_position: null, turn: { phase: 'work', holder: X.w1.id } });
    expect(m.get(ts[0]!.id).turn.due_at).toBeGreaterThan(Date.now());
    expect([m.get(ts[1]!.id).queue_position, m.get(ts[2]!.id).queue_position]).toEqual([1, 2]);
    expect(m.get(ts[1]!.id).turn.seen_at).toBeNull();
    expect(r.content[0]!.text).toContain('unseen');
    expect((await X.W1('task_list', { task_id: ts[1]!.id })).structuredContent.tasks[0].turn.seen_at).not.toBeNull();
    // The full view carries them too.
    const full = (await X.C('task_list', { task_id: ts[2]!.id })).structuredContent.tasks[0];
    expect(full).toMatchObject({ id: ts[2]!.id, description: 'LONG-DESCRIPTION', queue_position: 2, turn: { phase: 'queued', holder: X.w1.id } });
  });

  it('an assignee in two teams has one queue across them', async () => {
    const X = await team();
    const res = await api('POST', '/teams', { name: `tt${++n}`, goal: 'second', members: [{ agent_id: X.c.id, role: 'coordinator' }, { agent_id: X.w1.id, role: 'worker' }, { agent_id: X.r.id, role: 'reviewer' }] });
    expect(res.status).toBe(201);
    const tid2 = res.body.team.id as string;
    expect((await api('POST', `/teams/${tid2}/start`)).status).toBe(200);
    const a = await mkTask(X, { title: 'first team' });
    expect(code(await X.C('task_assign', { task_id: a.id, agent_id: X.w1.id }))).toBe('ok');
    const b = (await X.C('task_create', { team_id: tid2, title: 'second team', reviewer: X.r.id })).structuredContent.task;
    expect(code(await X.C('task_assign', { task_id: b.id, agent_id: X.w1.id }))).toBe('ok');
    const r2 = await X.C('task_list', { team_id: tid2 });
    expect((r2.structuredContent.tasks as any[]).find((t) => t.id === b.id).queue_position).toBe(2);
    expect((await X.W1('session_whoami')).structuredContent.my_turns.map((x: any) => [x.task_id, x.queue_position])).toEqual([[a.id, 1], [b.id, 2]]);
  });

  it('session_whoami lists my_turns, oldest first', async () => {
    const X = await team();
    const a = await mkTask(X, { title: 'older' });
    await X.C('task_assign', { task_id: a.id, agent_id: X.w1.id });
    const b = await mkTask(X, { title: 'newer' });
    await X.C('task_assign', { task_id: b.id, agent_id: X.w1.id });
    app.db.prepare('UPDATE task_turns SET opened_at=opened_at-60000 WHERE task_id=? AND closed_at IS NULL').run(a.id);
    const r = await X.W1('session_whoami');
    expect(r.structuredContent.my_turns.map((x: any) => [x.task_id, x.phase, x.queue_position])).toEqual([[a.id, 'queued', 1], [b.id, 'queued', 2]]);
    expect(r.structuredContent.my_turns[0]).toMatchObject({ team_id: X.tid, title: 'older', holder: X.w1.id, due_at: null });
    expect(r.structuredContent.my_turns[0].seen_at).toBeNull(); // whoami is not a full read of the task
    expect(r.content[0]!.text).toContain(`Waiting on you, oldest first:\n- ${a.id} [queued #1] "older"`);
    expect((await X.R('session_whoami')).structuredContent.my_turns).toEqual([]);
  });
});

describe('the shipped hand-off playbook line (§8.4, D-21)', () => {
  const MIGRATION = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations', '0107_task_turns.sql'), 'utf8');
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const ends = (s: string) => s.endsWith(` ${HANDOFF_LINE}`) && s.split(HANDOFF_LINE).length === 2;
  it('equals the line migration 0107 appends and ends the shipped coordinator and worker playbooks once', async () => {
    expect(HANDOFF_LINE).toBe('After task_submit or task_assign, if the result names a hand-off to an on-demand member, end your turn by passing its wake line to whoever runs you.');
    // Coordinator copies, worker copies, then the polling defaults: the same replacement text each time.
    expect(MIGRATION.split(`playbook || ' ' || ${q(HANDOFF_LINE)}`)).toHaveLength(4);
    for (const role of ['coordinator', 'worker']) {
      expect(ends(ON_DEMAND_PLAYBOOKS[role]!)).toBe(true);
      // The polling defaults live in team_role_defaults: a fresh hub runs 0107, which appends the line there.
      expect(ends((app.db.prepare('SELECT playbook FROM team_role_defaults WHERE role=?').get(role) as { playbook: string }).playbook)).toBe(true);
    }
    expect(ON_DEMAND_PLAYBOOKS.reviewer).not.toContain(HANDOFF_LINE);
    // A new team's copies.
    const X = await team();
    for (const role of ['coordinator', 'worker']) expect(ends(app.teams.playbook(X.tid, role))).toBe(true);
  });
});
