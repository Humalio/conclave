/**
 * Task backlog (task_rccuivx4jxcup75r): per project task_intake (backlog | open, default backlog). In backlog, agents'
 * task_create lands in `backlog`; only the operator accepts (→ open), discards (→ discarded, terminal) or demotes
 * (open → backlog), audited and told to the creator and the coordinators. A coordinator relaying the operator's own
 * request (operator_request {source}) opens the task at once, kept as relayed (L1).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import { migrate0, V0_MIGRATIONS } from './fixtures/v0/db0.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
type Res = { isError?: boolean; structuredContent?: any; content?: { text: string }[] };
type Call = (name: string, args?: Record<string, unknown>) => Promise<Res>;
let app: App, base = '', cookie = '', csrf = '', appKey = '', pcId = '';
const text = (r: Res) => (r.content ?? []).map((c) => c.text).join('\n');
const ok = (r: Res) => { if (r.isError) throw new Error(text(r)); return r.structuredContent; };
const code = (r: Res) => (r.isError ? /^(\w+)/.exec(text(r))?.[1] : 'ok');
const api = async (method: string, path: string, body?: unknown, auth = true) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', ...(auth ? { cookie, ...(method === 'GET' ? {} : { 'x-csrf-token': csrf }) } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};
async function session(secret: string): Promise<Call> {
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  const token = ((await c.callTool({ name: 'session_login', arguments: { session_key: secret } })) as Res).structuredContent.session_token;
  return async (name, args = {}) => (await c.callTool({ name, arguments: { session_token: token, ...args } })) as Res;
}

/** A running team with a coordinator, a worker and a reviewer, in its own project (task intake left at its default). */
async function team(name: string) {
  const agent = (label: string) => {
    const a = app.keys.createAgent(label, null, sys);
    const k = app.keys.createSessionKey({ agentId: a.id, label }, sys);
    app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }], 'test', sys);
    return { id: a.id, cred: k.credential.id, secret: k.secret };
  };
  const c = agent(`${name}-coord`), c2 = agent(`${name}-coord2`), w = agent(`${name}-worker`), r = agent(`${name}-reviewer`);
  const id = app.teams.create({ name, goal: 'g', members: [
    { agent_id: c.id, role: 'coordinator', credential_id: c.cred }, { agent_id: c2.id, role: 'coordinator', credential_id: c2.cred },
    { agent_id: w.id, role: 'worker', credential_id: w.cred }, { agent_id: r.id, role: 'reviewer', credential_id: r.cred }] }, sys).id;
  app.teams.start(id, sys);
  const project = app.blueprint.ensureTeamProject(id).id;
  return { id, project, c: { ...c, call: await session(c.secret) }, c2, w: { ...w, call: await session(w.secret) }, r };
}
type T = Awaited<ReturnType<typeof team>>;
const create = async (X: T, args: Record<string, unknown> = {}) => ok(await X.c.call('task_create', { team_id: X.id, title: `Task ${Math.random().toString(36).slice(2, 7)}`, ...args })).task;
const audits = (action: string, id: string) => (app.db.prepare('SELECT actor_kind, details FROM audit_events WHERE action=? AND target_id=?').all(action, id) as { actor_kind: string; details: string }[])
  .map((r) => ({ actor_kind: r.actor_kind, ...JSON.parse(r.details) }));
const notices = (agent: string, kind: string, task: string) => (app.db.prepare('SELECT body, ref_state FROM agent_notices WHERE agent_id=? AND kind=? AND ref_task_id=?').all(agent, kind, task) as { body: string; ref_state: string }[]);
const opSys = () => ({ kind: 'admin' as const, id: 'admin' });
const events = (task: string) => app.db.prepare('SELECT from_status, to_status, actor_kind, tool, note FROM task_events WHERE task_id=? ORDER BY id').all(task) as { from_status: string | null; to_status: string; actor_kind: string; tool: string; note: string | null }[];

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahbl-'));
  mkdirSync(join(dir, 'vault'));
  app = await buildApp(testConfig(dir, { pepper: 'p', publicUrl: 'http://127.0.0.1', adminPassword: 'admin-password-long' }));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base, 'admin', 'admin-password-long'));
  const pc = (await api('POST', '/pcs', { name: 'pc' })).body.pc.id as string;
  pcId = pc;
  appKey = app.keys.createAppKey({ machineId: pc, appName: 'claude-code', maxLiveSessions: 40 }, sys).secret;
});
afterAll(async () => { await app?.close(); });

describe('intake backlog (the default)', () => {
  it('a project defaults to backlog, and an agent\'s task_create lands there', async () => {
    const X = await team('Default');
    expect((await api('GET', '/projects')).body.projects.find((p: { id: string }) => p.id === X.project).task_intake).toBe('backlog');
    expect((await api('GET', `/teams/${X.id}`)).body.team).toBeTruthy();
    const r = await X.c.call('task_create', { team_id: X.id, title: 'Proposal', claimable: true });
    expect(text(r)).toMatch(/backlog/);
    const t = ok(r).task;
    expect(t.status).toBe('backlog');
    expect(t.operator_request).toBeNull();
    expect(events(t.id)[0]).toMatchObject({ from_status: null, to_status: 'backlog', tool: 'task_create' });
    // A claimable backlog task does not tell the workers it is open.
    expect(notices(X.w.id, 'task_open', t.id)).toHaveLength(0);
    // Agents read backlog tasks: listed by default and by status.
    expect(ok(await X.w.call('task_list', { team_id: X.id })).tasks.map((x: { id: string }) => x.id)).toContain(t.id);
    expect(ok(await X.w.call('task_list', { team_id: X.id, status: 'backlog' })).tasks.map((x: { status: string }) => x.status)).toEqual(['backlog']);
  });

  it('refuses assign, claim, start, block and cancel in backlog, naming the operator\'s accept; work_next has nothing', async () => {
    const X = await team('Refuse');
    const t = await create(X, { claimable: true });
    const as = await X.c.call('task_assign', { task_id: t.id, agent_id: X.w.id });
    expect(code(as)).toBe('invalid_state');
    expect(text(as)).toMatch(/only the operator can accept it/);
    const cl = await X.w.call('task_claim', { task_id: t.id, version: t.version, start: true });
    expect(code(cl)).toBe('invalid_state');
    expect(text(cl)).toMatch(/operator can accept/);
    const st = await X.w.call('task_start', { task_id: t.id });
    expect(code(st)).toBe('invalid_state');
    expect(text(st)).toMatch(/operator can accept/);
    expect(code(await X.c.call('task_block', { task_id: t.id, reason: 'x' }))).toBe('invalid_state');
    expect(code(await X.c.call('task_cancel', { task_id: t.id, reason: 'x' }))).toBe('invalid_state');
    const wn = ok(await X.w.call('work_next', { wait_seconds: 0 }));
    expect(wn.item?.task?.id).not.toBe(t.id);
    expect(app.teams.task(t.id)!.status).toBe('backlog');
  });

  it('the coordinator edits title, description and refs; the task stays in the backlog', async () => {
    const X = await team('Edit');
    const t = await create(X);
    const u = ok(await X.c.call('task_update', { task_id: t.id, version: t.version, title: 'Better title', description: 'Why and what.' })).task;
    expect(u).toMatchObject({ status: 'backlog', title: 'Better title', description: 'Why and what.', version: t.version + 1 });
    // The worker cannot edit it.
    expect(code(await X.w.call('task_update', { task_id: t.id, version: u.version, title: 'x' }))).toBe('denied');
  });

  it('a coordinator relaying the operator\'s request opens the task at once, kept as relayed (L1)', async () => {
    const X = await team('Relay');
    const r = await X.c.call('task_create', { team_id: X.id, title: 'Asked by the operator', claimable: true, operator_request: { source: 'chat with operator' } });
    expect(text(r)).toMatch(/relayed request/);
    const t = ok(r).task;
    expect(t.status).toBe('open');
    expect(t.operator_request).toMatchObject({ source: 'chat with operator', by: X.c.id, trust: 'L1', label: 'opened on the operator\'s relayed request' });
    expect(events(t.id)[0]!.note).toMatch(/relayed request \(chat with operator\)/);
    expect(audits('task.operator_request', t.id)).toMatchObject([{ actor_kind: 'agent', source: 'chat with operator', team: X.id }]);
    expect(notices(X.w.id, 'task_open', t.id)).toHaveLength(1);
    // A source is required.
    expect(code(await X.c.call('task_create', { team_id: X.id, title: 'x', operator_request: { source: '   ' } }))).toBe('invalid_argument');
    // It works as an open task, and the operator may demote it.
    expect(ok(await X.c.call('task_assign', { task_id: t.id, agent_id: X.w.id })).task.status).toBe('assigned');
    const t2 = ok(await X.c.call('task_create', { team_id: X.id, title: 'Another', operator_request: { source: 'call' } })).task;
    expect((await api('POST', `/teams/${X.id}/tasks/${t2.id}/demote`, {})).body.task).toMatchObject({ status: 'backlog', operator_request: { source: 'call' } });
  });
});

describe('the operator moves the backlog', () => {
  it('the accept wakes an on-demand coordinator: one delivery order on its PC for the accepted task, ids only (feedback: the accept never woke the coordinator)', async () => {
    const X = await team('WakeAccept');
    app.db.prepare('UPDATE credentials SET bound_machine_id=? WHERE id=?').run(pcId, X.c.cred); // the coordinator works on this PC
    const t = await create(X, { claimable: true });
    const orders = async () => ((await (await fetch(`${base}/connector/v1/orders`, { headers: { authorization: `Bearer ${appKey}` } })).json()) as { orders: { kind: string; payload: { agent_id: string; items: { notice: string; task?: string }[] } }[] }).orders;
    expect((await orders()).filter((o) => o.payload.agent_id === X.c.id)).toHaveLength(0); // a backlog proposal wakes no one
    expect((await api('POST', `/teams/${X.id}/tasks/${t.id}/accept`, { note: 'Go.' })).status).toBe(200);
    const mine = (await orders()).filter((o) => o.payload.agent_id === X.c.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ kind: 'deliver', payload: { items: [{ notice: 'task_accepted', task: t.id }] } });
    expect(JSON.stringify(mine[0])).not.toContain(t.title); // ids only
  });
  it('accept: backlog → open with a note, audited, the creator and the coordinators told; then it works as before', async () => {
    const X = await team('Accept');
    const t = await create(X, { claimable: true });
    const r = await api('POST', `/teams/${X.id}/tasks/${t.id}/accept`, { note: 'Good idea.' });
    expect(r.status).toBe(200);
    expect(r.body.task).toMatchObject({ status: 'open', version: t.version + 1 });
    expect(events(t.id).at(-1)).toMatchObject({ from_status: 'backlog', to_status: 'open', actor_kind: 'admin', tool: 'admin_accept', note: 'Good idea.' });
    expect(audits('task.accept', t.id)).toMatchObject([{ actor_kind: 'admin', from: 'backlog', to: 'open', note: 'Good idea.' }]);
    for (const a of [X.c.id, X.c2.id]) {
      const n = notices(a, 'task_accepted', t.id);
      expect(n).toHaveLength(1);
      expect(n[0]!.body).toMatch(/accepted .* it is open.*Note: Good idea\./);
      expect(n[0]!.ref_state).toBe('open');
    }
    expect(notices(X.w.id, 'task_accepted', t.id)).toHaveLength(0);
    expect(notices(X.w.id, 'task_open', t.id)).toHaveLength(1); // claimable: the workers hear it is open now
    // The coordinator reads the notice through work_next as an L0 hub item.
    const items: any[] = [];
    for (let i = 0; i < 10; i++) {
      const wn = ok(await X.c.call('work_next', { wait_seconds: 0 }));
      if (wn.status !== 'item') break;
      items.push(wn.item); ok(await X.c.call('work_ack', { item_id: wn.item.item_id }));
    }
    expect(items.find((i) => i.notice_kind === 'task_accepted')).toMatchObject({ trust: 'L0' });
    const cl = ok(await X.w.call('task_claim', { task_id: t.id, version: r.body.task.version, start: true })).task;
    expect(cl.status).toBe('in_progress');
    // Only a backlog task can be accepted.
    expect((await api('POST', `/teams/${X.id}/tasks/${t.id}/accept`, {})).status).toBe(409);
  });

  it('discard: backlog → discarded (terminal, kept for history), audited and told; hidden from the default list', async () => {
    const X = await team('Discard');
    const t = await create(X);
    const r = await api('POST', `/teams/${X.id}/tasks/${t.id}/discard`, { note: 'Out of scope.' });
    expect(r.body.task.status).toBe('discarded');
    expect(audits('task.discard', t.id)).toMatchObject([{ actor_kind: 'admin', from: 'backlog', to: 'discarded', note: 'Out of scope.' }]);
    expect(notices(X.c.id, 'task_discarded', t.id)[0]!.body).toMatch(/discarded .*stays in the history/);
    expect(ok(await X.w.call('task_list', { team_id: X.id })).tasks.map((x: { id: string }) => x.id)).not.toContain(t.id);
    expect(ok(await X.w.call('task_list', { team_id: X.id, status: 'discarded' })).tasks.map((x: { id: string }) => x.id)).toEqual([t.id]);
    // Terminal: no edits, no accept, no assign; the board may hide it.
    expect(code(await X.c.call('task_update', { task_id: t.id, version: r.body.task.version, title: 'x' }))).toBe('invalid_state');
    expect((await api('POST', `/teams/${X.id}/tasks/${t.id}/accept`, {})).status).toBe(409);
    expect(text(await X.c.call('task_assign', { task_id: t.id, agent_id: X.w.id }))).toMatch(/discarded by the operator/);
    expect((await api('POST', `/teams/${X.id}/tasks/${t.id}/dismiss`, { dismissed: true })).status).toBe(200);
    expect((await api('GET', '/teams')).body.teams.find((x: { id: string }) => x.id === X.id).counts).toMatchObject({ discarded: 1, backlog: 0 });
  });

  it('demote: only from open; audited and told', async () => {
    const X = await team('Demote');
    await api('PATCH', `/projects/${X.project}`, { task_intake: 'open' });
    const t = await create(X, { claimable: true });
    expect(t.status).toBe('open');
    const r = await api('POST', `/teams/${X.id}/tasks/${t.id}/demote`, { note: 'Not yet.' });
    expect(r.body.task.status).toBe('backlog');
    expect(audits('task.demote', t.id)).toMatchObject([{ actor_kind: 'admin', from: 'open', to: 'backlog', note: 'Not yet.' }]);
    expect(notices(X.c.id, 'task_demoted', t.id)[0]!.body).toMatch(/back to the backlog/);
    // The earlier "claimable task is open" notice is no longer current.
    const open = app.db.prepare("SELECT id FROM agent_notices WHERE agent_id=? AND kind='task_open' AND ref_task_id=?").get(X.w.id, t.id) as { id: string };
    expect(app.keys.noticeCurrent(open.id)).toBe(false);
    expect(code(await X.w.call('task_claim', { task_id: t.id, version: r.body.task.version }))).toBe('invalid_state');
    // Not from backlog, and not once someone holds it.
    expect((await api('POST', `/teams/${X.id}/tasks/${t.id}/demote`, {})).status).toBe(409);
    const u = await create(X);
    ok(await X.c.call('task_assign', { task_id: u.id, agent_id: X.w.id }));
    const d = await api('POST', `/teams/${X.id}/tasks/${u.id}/demote`, {});
    expect(d.status).toBe(409);
    expect(d.body.message).toMatch(/Only an open task/);
  });

  it('a non-operator is refused: no session, an agent actor, or the wrong team', async () => {
    const X = await team('Guard');
    const t = await create(X);
    expect((await api('POST', `/teams/${X.id}/tasks/${t.id}/accept`, {}, false)).status).toBe(401);
    expect(() => app.teams.adminAccept(X.id, t.id, null, { kind: 'agent', id: X.c.id })).toThrow(/Only the operator/);
    expect(() => app.teams.adminDiscard(X.id, t.id, null, sys)).toThrow(/Only the operator/);
    const Y = await team('Other');
    expect((await api('POST', `/teams/${Y.id}/tasks/${t.id}/accept`, {})).status).toBe(404);
    expect((await api('POST', `/teams/${X.id}/tasks/${t.id}/accept`, { status: 'open' })).status).toBe(400);
    expect(app.teams.task(t.id)!.status).toBe('backlog');
  });

  it('lists the backlog across teams for the console, oldest first, with team and creator', async () => {
    const X = await team('Listed');
    const a = await create(X, { title: 'First proposal' }), b = await create(X, { title: 'Second proposal' });
    expect((await api('GET', '/tasks/backlog', undefined, false)).status).toBe(401);
    const r = await api('GET', '/tasks/backlog');
    expect(r.status).toBe(200);
    const mine = r.body.tasks.filter((k: { team_id: string }) => k.team_id === X.id);
    expect(mine.map((k: { id: string }) => k.id)).toEqual([a.id, b.id]);
    expect(mine[0]).toMatchObject({ status: 'backlog', team_name: 'Listed', created_by: X.c.id, created_by_label: 'Listed-coord' });
    expect(r.body.total).toBeGreaterThanOrEqual(2);
    await api('POST', `/teams/${X.id}/tasks/${a.id}/accept`, {});
    expect((await api('GET', '/tasks/backlog')).body.tasks.some((k: { id: string }) => k.id === a.id)).toBe(false);
  });
});

describe('intake open', () => {
  it('is set like the review policy (audited, the coordinators told) and behaves as before', async () => {
    const X = await team('Open');
    const r = await api('PATCH', `/projects/${X.project}`, { task_intake: 'open' });
    expect(r.body.project.task_intake).toBe('open');
    expect(audits('blueprint.task_intake', X.project)).toMatchObject([{ from: 'backlog', to: 'open' }]);
    expect((app.db.prepare("SELECT body FROM agent_notices WHERE agent_id=? AND kind='project_changed' ORDER BY seq DESC").get(X.c.id) as { body: string }).body).toMatch(/task intake is now open/);
    expect((await api('PATCH', `/projects/${X.project}`, { task_intake: 'sometimes' })).status).toBe(400);
    expect((await api('GET', '/teams')).body.teams.find((x: { id: string }) => x.id === X.id).task_intake).toBe('open');
    const t = await create(X, { claimable: true });
    expect(t.status).toBe('open');
    expect(notices(X.w.id, 'task_open', t.id)).toHaveLength(1);
    expect(ok(await X.w.call('task_claim', { task_id: t.id, version: t.version, start: true })).task.status).toBe('in_progress');
    // Back to backlog: new tasks wait again.
    await api('PATCH', `/projects/${X.project}`, { task_intake: 'backlog' });
    expect((await create(X)).status).toBe('backlog');
  });

  it('tasks the hub raises itself keep their behaviour under backlog intake', async () => {
    const X = await team('Hub');
    const h = app.teams.hubTask(X.id, { title: 'Stale evidence', description: 'd' })!;
    expect(h.status).toBe('open');
    const a = app.teams.hubTask(X.id, { title: 'Stale evidence 2', description: 'd', assignee: X.w.id })!;
    expect(a.status).toBe('assigned');
  });
});

describe('review follow-ups', () => {
  it('lists recent relayed opens with the backlog until someone holds them, so the operator can demote in one click', async () => {
    const X = await team('Relayed');
    const t = ok(await X.c.call('task_create', { team_id: X.id, title: 'Asked in chat', operator_request: { source: 'chat with operator' } })).task;
    const u = ok(await X.c.call('task_create', { team_id: X.id, title: 'Asked by call', operator_request: { source: 'call' } })).task;
    const mine = async () => (await api('GET', '/tasks/backlog')).body.relayed.filter((k: { team_id: string }) => k.team_id === X.id);
    expect((await mine()).map((k: { id: string }) => k.id)).toEqual([u.id, t.id]);
    expect((await mine())[0]).toMatchObject({ status: 'open', team_name: 'Relayed', operator_request: { source: 'call', by: X.c.id } });
    ok(await X.c.call('task_assign', { task_id: u.id, agent_id: X.w.id }));
    await api('POST', `/teams/${X.id}/tasks/${t.id}/demote`, {});
    expect(await mine()).toEqual([]);
    // Older than 7 days: no longer listed.
    const v = ok(await X.c.call('task_create', { team_id: X.id, title: 'Old ask', operator_request: { source: 'chat' } })).task;
    app.db.prepare('UPDATE tasks SET operator_request_at=? WHERE id=?').run(Date.now() - 8 * 86_400_000, v.id);
    expect(await mine()).toEqual([]);
  });

  it('requirement coverage leaves backlog, cancelled and discarded tasks out', async () => {
    const X = await team('Coverage');
    const opr = { kind: 'operator' as const, id: null }, v = () => app.blueprint.project(X.project)!.version;
    app.blueprint.write(X.project, { version: v(), ops: [{ op: 'upsert', kind: 'module', key: 'COV', title: 'Cov', team_id: X.id },
      { op: 'upsert', kind: 'fr', key: 'FR-COV-01', parent_key: 'COV', title: 'Covered' }] }, opr);
    const a = await create(X, { refs: ['FR-COV-01'] }), b = await create(X, { refs: ['FR-COV-01'] });
    await create(X, { refs: ['FR-COV-01'] }); // stays in the backlog
    await api('POST', `/teams/${X.id}/tasks/${a.id}/discard`, {});
    await api('POST', `/teams/${X.id}/tasks/${b.id}/accept`, {});
    expect(app.teams.plan(X.id).requirements[0]!.tasks).toEqual({ done: 0, total: 1 });
    const d = await api('GET', `/projects/${X.project}/items/FR-COV-01`);
    expect(d.body.tasks).toMatchObject({ done: 0, total: 1 }); // every naming task is still listed
    expect(d.body.tasks.items).toHaveLength(3);
  });

  it('a discarded task can be hidden, and its history is pruned like a cancelled one', async () => {
    const X = await team('Ended');
    const t = await create(X);
    await api('POST', `/teams/${X.id}/tasks/${t.id}/discard`, {});
    expect(app.teams.dismiss(X.id, t.id, true, opSys()).dismissed_at).toBeTruthy();
    const u = await create(X);
    expect(() => app.teams.dismiss(X.id, u.id, true, opSys())).toThrow(/done, cancelled or discarded/);
    app.db.prepare('UPDATE tasks SET updated_at=? WHERE id=?').run(Date.now() - 200 * 86_400_000, t.id);
    app.maintenance.prune(Date.now());
    expect(events(t.id)).toEqual([]);
    expect(events(u.id).length).toBeGreaterThan(0);
  });

  it('tells the coordinators when moving the team to another project changes where its new tasks land', async () => {
    const X = await team('Mover');
    const other = app.blueprint.ensureTeamProject((await team('Target')).id).id;
    await api('PATCH', `/projects/${other}`, { task_intake: 'open' });
    const last = () => (app.db.prepare("SELECT body FROM agent_notices WHERE agent_id=? AND kind='project_changed' ORDER BY seq DESC").get(X.c.id) as { body: string }).body;
    expect((await api('PUT', `/teams/${X.id}/project`, { project_id: other })).status).toBe(200);
    expect(app.teams.taskIntake(X.id)).toBe('open');
    expect(last()).toMatch(/new tasks now open at once/);
    expect((await create(X)).status).toBe('open');
    // Back to a backlog project: told again.
    expect((await api('PUT', `/teams/${X.id}/project`, { project_id: X.project })).status).toBe(200);
    expect(last()).toMatch(/new tasks now land in the backlog/);
  });
});

describe('migration 0042 of 0.x (the 0.x runner and files, test/fixtures/v0)', () => {
  it('keeps existing tasks and their history; existing projects take intake backlog', () => {
    const src = V0_MIGRATIONS, old = mkdtempSync(join(tmpdir(), 'ahmig-'));
    for (const f of readdirSync(src)) if (/^\d{4}_.+\.sql$/.test(f) && Number(f.slice(0, 4)) < 42) copyFileSync(join(src, f), join(old, f));
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    migrate0(db, old);
    const now = Date.now();
    db.prepare("INSERT INTO projects(id,key,name,kind,version,created_by_kind,created_by_id,created_at,updated_at) VALUES ('prj_1','P1','P','implementation',1,'system',NULL,?,?)").run(now, now);
    db.prepare("INSERT INTO teams(id,name,goal,status,limits,checkpoints,grant_messaging,stall_minutes,lease_minutes,max_review_rounds,created_by,created_at,updated_at,project_id) VALUES ('tm_1','T','g','running','{}','[]',0,15,30,3,NULL,?,?,'prj_1')").run(now, now);
    db.prepare("INSERT INTO tasks(id,team_id,title,status,created_at,updated_at,review,plan_refs) VALUES ('task_1','tm_1','Old','in_review',?,?,'none','[\"R1\"]')").run(now, now);
    db.prepare("INSERT INTO task_events(task_id,from_status,to_status,actor_kind,created_at) VALUES ('task_1',NULL,'open','system',?)").run(now);
    expect(() => db.prepare("INSERT INTO tasks(id,team_id,title,status,created_at,updated_at) VALUES ('task_x','tm_1','x','backlog',?,?)").run(now, now)).toThrow(/CHECK/);
    // An orphan left from before (here in the table being rebuilt) is logged, not fatal: the migration still runs.
    db.exec('PRAGMA foreign_keys=OFF');
    db.prepare("INSERT INTO tasks(id,team_id,title,status,created_at,updated_at) VALUES ('task_orphan','tm_gone','Orphan','done',?,?)").run(now, now);
    db.exec('PRAGMA foreign_keys=ON');
    migrate0(db, src);
    expect(db.prepare("SELECT status, review, plan_refs, operator_request_source FROM tasks WHERE id='task_1'").get()).toMatchObject({ status: 'in_review', review: 'none', plan_refs: '["R1"]', operator_request_source: null });
    expect((db.prepare("SELECT COUNT(*) n FROM task_events WHERE task_id='task_1'").get() as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT task_intake FROM projects WHERE id='prj_1'").get() as { task_intake: string }).task_intake).toBe('backlog');
    expect((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1);
    expect((db.prepare('PRAGMA foreign_key_check').all() as { table: string }[]).map((r) => r.table)).toEqual(['tasks']); // only the old orphan
    db.prepare("INSERT INTO tasks(id,team_id,title,status,created_at,updated_at) VALUES ('task_2','tm_1','New','backlog',?,?)").run(now, now);
    // Foreign keys still hold on the rebuilt table and on the tables that reference it.
    expect(() => db.prepare("INSERT INTO task_events(task_id,to_status,actor_kind,created_at) VALUES ('task_none','open','system',?)").run(now)).toThrow(/FOREIGN KEY/);
    expect(() => db.prepare("INSERT INTO tasks(id,team_id,title,status,created_at,updated_at) VALUES ('task_3','tm_none','x','open',?,?)").run(now, now)).toThrow(/FOREIGN KEY/);
  });
});
