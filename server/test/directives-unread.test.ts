/**
 * The reminder while directives wait (docs/directives.md, Cost to agents; spec review of task_72chlz3wy2ueqal2): the
 * answers to work_next, task_list, task_start and task_review carry `directives_unread: N` and one fixed line at the top
 * level, next to `notices`, while directives in force for the caller wait unread or changed. N is what
 * `directives_read {unread: true}` returns and what session_whoami marks unread or outdated (one predicate, readState).
 * Numbers only; left out at 0 and when the directives' own confirm notices are in the same answer; no cache, so it clears
 * on the call after an ack; it never refuses work.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import { unreadLine } from '../src/mcp/tools.js';
import { intakeOpen } from './intake.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
type Res = { isError?: boolean; structuredContent?: any; content?: { text: string }[] };
type Call = (name: string, args?: Record<string, unknown>) => Promise<Res>;
let app: App, base = '', appKey = '', dir = '';
const text = (r: Res) => (r.content ?? []).map((c) => c.text).join('\n');
const ok = (r: Res) => { if (r.isError) throw new Error(text(r)); return r.structuredContent; };
async function session(secret: string): Promise<Call> {
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  const token = ((await c.callTool({ name: 'session_login', arguments: { session_key: secret } })) as Res).structuredContent.session_token;
  return async (name, args = {}) => (await c.callTool({ name, arguments: { session_token: token, ...args } })) as Res;
}
let n = 0;
/** A running polling team (coordinator, worker, reviewer), each logged in, with every pending notice confirmed. */
async function team() {
  const name = `DU${++n}`;
  const agent = (label: string) => {
    const a = app.keys.createAgent(`${name}-${label}`, null, sys);
    const k = app.keys.createSessionKey({ agentId: a.id, label }, sys);
    app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }], 'test', sys);
    return { id: a.id, cred: k.credential.id, secret: k.secret };
  };
  const c = agent('coord'), w = agent('worker'), r = agent('rev');
  const id = app.teams.create({ name, goal: 'g', members: [{ agent_id: c.id, role: 'coordinator', credential_id: c.cred }, { agent_id: w.id, role: 'worker', credential_id: w.cred },
    { agent_id: r.id, role: 'reviewer', credential_id: r.cred }] }, sys).id;
  app.teams.start(id, sys);
  const X = { id, c: { ...c, call: await session(c.secret) }, w: { ...w, call: await session(w.secret) }, r: { ...r, call: await session(r.secret) } };
  for (const m of [X.c, X.w, X.r]) await clear(m.call);
  return X;
}
/** Confirm every notice so far, as an agent that skipped them would: the directives stay unread. */
const clear = async (call: Call) => { ok(await call('session_ack', { notice_seq: 1_000_000 })); };
const rule = (teamId: string, title: string) => app.directives.create({ title, body: `${title}.`, scope: { kind: 'team', ref: teamId } }, sys);
/** The whoami count: directives it marks unread or outdated. */
const whoamiCount = async (call: Call) => (ok(await call('session_whoami')).directives as { read: string }[]).filter((d) => d.read !== 'current').length;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ahdu-'));
  mkdirSync(join(dir, 'vault'));
  app = await buildApp(testConfig(dir, { pepper: 'p', publicUrl: 'http://127.0.0.1', adminPassword: 'admin-password-long' }));
  intakeOpen(app);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  await adminLogin(base, 'admin', 'admin-password-long');
  const pc = app.db.prepare("INSERT INTO machines(id,name,created_at) VALUES ('pc_du','pc',?)").run(Date.now()) && 'pc_du';
  appKey = app.keys.createAppKey({ machineId: pc, appName: 'claude-code', maxLiveSessions: 40 }, sys).secret;
});
afterAll(async () => { await app?.close(); rmSync(dir, { recursive: true, force: true }); });

describe('the unread-directives reminder', () => {
  it('task_review with one unread directive carries directives_unread: 1 at the top level, not in notices or the task', async () => {
    const X = await team();
    const t = ok(await X.c.call('task_create', { team_id: X.id, title: 'Reviewed task', reviewer: X.r.id })).task;
    ok(await X.c.call('task_assign', { task_id: t.id, agent_id: X.w.id }));
    ok(await X.w.call('task_start', { task_id: t.id }));
    ok(await X.w.call('task_submit', { task_id: t.id, summary: 'done' }));
    rule(X.id, 'Reviewers read the code');
    await clear(X.r.call);
    const version = app.teams.task(t.id)!.version;
    const r = await X.r.call('task_review', { task_id: t.id, decision: 'approve', comments: 'Fine.', version });
    const d = ok(r);
    expect(d.directives_unread).toBe(1);
    expect(d.directives_hint).toBe(unreadLine(1));
    expect(text(r)).toContain('You have 1 unread directive. Read it with directives_read {unread: true, ack: true} before you act.');
    expect(JSON.stringify(d.notices ?? [])).not.toContain('unread directive');
    expect(JSON.stringify(d.task ?? {})).not.toContain('unread directive');
    expect(d.directives_unread).toBe(await whoamiCount(X.r.call));
  });

  it('counts a directive whose version changed, and only on the four calls', async () => {
    const X = await team();
    const d1 = rule(X.id, 'Branch per task');
    ok(await X.w.call('directives_read', { unread: true, ack: true }));
    app.directives.update(d1.id, { body: 'Each task on its own branch or worktree.' }, sys);
    await clear(X.w.call);
    const next = ok(await X.w.call('work_next', { wait_seconds: 0 }));
    expect(next.directives_unread).toBe(1);
    expect(ok(await X.w.call('directives_read', { unread: true })).directives_unread).toBeUndefined();
    expect(ok(await X.w.call('team_info', { team_id: X.id })).directives_unread).toBeUndefined();
    expect(ok(await X.w.call('message_read')).directives_unread).toBeUndefined();
    expect(await whoamiCount(X.w.call)).toBe(1);
  });

  it('a minor edit (a typo) asks no agent to read again, and cannot change the scope', async () => {
    const X = await team();
    const d1 = rule(X.id, 'Branch per taks');
    ok(await X.w.call('directives_read', { unread: true, ack: true }));
    const changed = () => (app.db.prepare("SELECT COUNT(*) n FROM agent_notices WHERE agent_id=? AND kind='directive_changed'").get(X.w.id) as { n: number }).n;
    const before = changed();
    const nd = app.directives.update(d1.id, { title: 'Branch per task', minor: true }, sys);
    expect(nd.version).toBe(d1.version + 1);
    expect(changed()).toBe(before);
    expect(await whoamiCount(X.w.call)).toBe(0);
    expect(ok(await X.w.call('work_next', { wait_seconds: 0 })).directives_unread).toBeUndefined();
    expect(() => app.directives.update(d1.id, { scope: { kind: 'hub', ref: null }, minor: true }, sys)).toThrow(/cannot be a minor edit/);
    // A normal edit still asks again.
    app.directives.update(d1.id, { body: 'Each task on its own branch.' }, sys);
    expect(changed()).toBe(before + 1);
    expect(await whoamiCount(X.w.call)).toBe(1);
  });

  it('leaves out a directive an exemption keeps off the agent', async () => {
    const X = await team();
    const a = rule(X.id, 'Kept off the worker'), b = rule(X.id, 'In force');
    app.directives.exempt(a.id, { kind: 'agent', ref: X.w.id }, sys);
    await clear(X.w.call);
    expect(ok(await X.w.call('task_list')).directives_unread).toBe(1);
    expect(app.directives.unreadIds(X.w.id)).toEqual([b.id]);
    expect(await whoamiCount(X.w.call)).toBe(1);
  });

  it('clears on the next call after an ack, and is absent with nothing unread', async () => {
    const X = await team();
    expect(ok(await X.w.call('task_list')).directives_unread).toBeUndefined();
    rule(X.id, 'One'); rule(X.id, 'Two');
    await clear(X.w.call);
    const before = await X.w.call('task_list');
    expect(ok(before).directives_unread).toBe(2);
    expect(text(before)).toContain(unreadLine(2));
    expect(text(before).match(/unread directives/g)).toHaveLength(1);
    expect(ok(await X.w.call('directives_read', { unread: true, ack: true })).directives).toHaveLength(2);
    const after = await X.w.call('task_list');
    expect(ok(after).directives_unread).toBeUndefined();
    expect(text(after)).not.toContain('unread directive');
    expect(await whoamiCount(X.w.call)).toBe(0);
  });

  it('adds no second line when the confirm notices for the same directives are in that answer', async () => {
    const X = await team();
    rule(X.id, 'Announced');
    const withNotice = ok(await X.w.call('task_list'));
    expect(withNotice.notices.some((x: { kind: string }) => x.kind === 'directive_changed')).toBe(true);
    expect(withNotice.directives_unread).toBeUndefined();
    // Once the notice is confirmed without reading the directive, the reminder takes over.
    await clear(X.w.call);
    expect(ok(await X.w.call('task_list')).directives_unread).toBe(1);
  });

  it('rides along on a refused call and never refuses work', async () => {
    const X = await team();
    rule(X.id, 'Still read me');
    await clear(X.w.call);
    const r = await X.w.call('task_start', { task_id: 'task_doesnotexist' });
    expect(r.isError).toBe(true);
    expect(r.structuredContent.directives_unread).toBe(1);
    const t = ok(await X.c.call('task_create', { team_id: X.id, title: 'Work goes on' })).task;
    ok(await X.c.call('task_assign', { task_id: t.id, agent_id: X.w.id }));
    await clear(X.w.call);
    const started = ok(await X.w.call('task_start', { task_id: t.id }));
    expect(started.directives_unread).toBe(1);
    expect(app.teams.task(t.id)!.status).toBe('in_progress');
  });
});
