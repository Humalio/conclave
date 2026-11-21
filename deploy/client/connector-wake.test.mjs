// The wake (docs/connector.md, "The wake"): a delivery order starts a headless turn for the agent, one fresh session per task,
// resumed for later items on that task, never two turns at once, stopped at the first approval, paused by a usage limit, taken up
// again after a restart only when the same process still runs. A fake program stands in for claude, and a fake hub for the routes;
// temporary homes, no keys, nothing installed.
import { test, describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindFolder } from './connector/registry.mjs';
import { procStartMs } from './connector/processes.mjs';
import { createWake, setRunEnv, setProfileOf, setWake, promptFor, readRun, codexLimitAt, runEnvironment, WAKE_CAP_MS } from './connector/wake.mjs';
import { clientProgram } from './connector/entries.mjs';
import { EventEmitter } from 'node:events';
import { addProfile, bindAgent } from './connector/profiles.mjs';
import { folderApproved, approveFolderByConnector } from './connector/approvals.mjs';
import { recordReset, setWakeOwnsSession, wakeOwnsSession, onResetOrder } from './connector/reset.mjs';
import { waiting } from './connector/deliveries.mjs';
import { ORDER_REASONS, validateOrder } from './connector/orders.mjs';
import { pathKey, canonicalFolder, folderIdentity } from './connector/paths.mjs';

const SHA = 'b'.repeat(64);
const tmp = [];
const mk = () => { const d = mkdtempSync(join(tmpdir(), 'cn-wake-')); tmp.push(d); return d; };
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });

// The fake program: argv[2] is a JSON file with its instructions; it writes JSON lines like `claude -p --output-format stream-json`.
const fakeDir = mk();
const FAKE = join(fakeDir, 'fake-claude.mjs');
writeFileSync(FAKE, `
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
const [, , mode, sid, argsLog, how] = process.argv;
if (mode === 'noresume' && how === 'resume') { appendFileSync(argsLog, JSON.stringify({ argv: process.argv.slice(2), env: {} }) + '\\n'); await new Promise((r) => setTimeout(r, 150)); process.exit(1); }
appendFileSync(argsLog, JSON.stringify({ argv: process.argv.slice(2), env: { PROFILE: process.env.WAKE_PROFILE ?? null, hasKey: Object.keys(process.env).some((k) => /^ah_(app|ses)_/.test(String(process.env[k]))), paid: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY'].filter((k) => process.env[k]), config: process.env.CLAUDE_CONFIG_DIR ?? null, hasPath: !!(process.env.PATH ?? process.env.Path) } }) + '\\n');
const line = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
line({ type: 'system', subtype: 'init', session_id: sid });
if (mode === 'hang') setInterval(() => {}, 1000);
else if (mode === 'limit') { line({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: Number(process.env.WAKE_RESETS) } }); line({ type: 'result', is_error: true, session_id: sid, permission_denials: [] }); }
else if (mode === 'codexlimit') { line({ type: 'turn.failed', error: { message: process.env.WAKE_MSG || 'x' } }); }
else if (mode === 'denial') line({ type: 'result', is_error: false, session_id: sid, permission_denials: [{ tool_name: 'Bash' }] });
else line({ type: 'result', is_error: false, session_id: sid, permission_denials: [] });
`);

/** A world: a home, an agent folder bound as label "dev", a fake hub that records calls, and a wake whose program is the fake. */
function world({ mode = 'quick', hub = {}, start = 1_800_000_000_000 } = {}) {
  const home = mk();
  const folder = join(home, 'work', 'dev'); mkdirSync(folder, { recursive: true });
  bindFolder(home, folder, { hubId: 'hub-w', caSha256: SHA, agent: 'dev' });
  const other = join(home, 'work', 'dev2'); mkdirSync(other, { recursive: true });
  bindFolder(home, other, { hubId: 'hub-w', caSha256: SHA, agent: 'dev2' });
  setWake(home, 'dev', true); setWake(home, 'dev2', true);
  const calls = [], argsLog = join(home, 'args.log');
  const state = { mode, t: start, checks: [], open: true, held: [], paused: false };
  const ids = { 'agent-dev': 'dev', 'agent-dev2': 'dev2' };
  const req = async (_hub, method, path, o = {}) => {
    calls.push({ path, body: o.body });
    if (path === '/connector/v1/turn-tokens') { const label = o.body.session_key === 'k-dev' ? 'dev' : 'dev2'; return { status: 200, json: { token: 'ah_turn_x', agent_id: `agent-${label}` } }; }
    if (path === '/connector/v1/wake/check') return { status: 200, json: { held: state.held, task_open: state.open, paused: state.paused } };
    return { status: 200, json: {} };
  };
  const launcherRuns = new Set();
  const wake = createWake({ home, log: () => {}, broker: { launcherRuns }, deps: {
    now: () => state.t, request: req, bin: () => process.execPath,
    args: (_p, { prompt, session, resume }) => [FAKE, state.mode, session ?? 'sid-new', argsLog, resume ? 'resume' : 'fresh', prompt],
    startTime: (pid) => (pid === process.pid ? 1234 : Date.now()), ...hub } });
  const section = { hub_id: 'hub-w', ca_sha256: SHA, app_key: 'x', agents: { dev: { session_key: 'k-dev' }, dev2: { session_key: 'k-dev2' } } };
  const ctx = { hubKey: 'hk', section, hub: { origin: 'https://127.0.0.1:1' }, auth: {} };
  const order = (n, agent, items, extra = {}) => ({ id: `pca_${n}`, kind: 'deliver', payload: { agent_id: agent, items, ...extra } });
  const sent = (suffix) => calls.filter((c) => c.path.endsWith(suffix));
  const started = () => (existsSync(argsLog) ? readFileSync(argsLog, 'utf8') : '').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return; await new Promise((r) => setTimeout(r, 25)); } throw new Error('timed out'); };
  const idle = async (agent = 'agent-dev') => { await until(() => !wake.state('hk').agents[agent]?.run); await wake.finishAll(); };
  return { home, folder, other, wake, ctx, state, calls, order, sent, started, until, idle, launcherRuns, ids };
}
const TASK_A = 'task_aaaa1111', TASK_B = 'task_bbbb2222';
const item = (task, notice = 'task_assigned') => ({ notice, ...(task ? { task } : {}) });

describe('a turn starts for the agent', () => {
  test('a new task starts a fresh session, and the later item on that task resumes it', async () => {
    const w = world();
    const r = await w.wake.onDeliver(w.ctx, w.order(1, 'agent-dev', [item(TASK_A)]), ORDER_REASONS);
    assert.equal(r.state, 'reported');
    await w.idle();
    const first = w.started()[0];
    assert.equal(first.argv[3], 'fresh');
    assert.ok(w.sent('/wake/report').some((c) => c.body.state === 'running' && c.body.task === TASK_A && c.body.session_id === first.argv[1]), 'the run and its session go to the hub against the task');
    assert.ok(w.sent('/orders/pca_1/result').some((c) => c.body.state === 'done'), 'delivered_at is set when the turn starts');
    // changes requested on the same task, seconds later: the same session, resumed
    const t0 = Date.now();
    await w.wake.onDeliver(w.ctx, w.order(2, 'agent-dev', [item(TASK_A, 'changes_requested')]), ORDER_REASONS);
    await w.idle();
    const second = w.started()[1];
    assert.equal(second.argv[3], 'resume');
    assert.equal(second.argv[1], first.argv[1], 'the task\'s own session');
    assert.ok(Date.now() - t0 < 10_000, 'within 10 s');
    // another task: a fresh session
    await w.wake.onDeliver(w.ctx, w.order(3, 'agent-dev', [item(TASK_B)]), ORDER_REASONS);
    await w.idle();
    assert.equal(w.started()[2].argv[3], 'fresh');
    assert.notEqual(w.started()[2].argv[1], first.argv[1]);
  });

  test('an item with no task resumes the agent\'s inbox session instead of paying for a fresh one each time', async () => {
    const w = world();
    await w.wake.onDeliver(w.ctx, w.order(1, 'agent-dev', [item(null, 'message')]), ORDER_REASONS); await w.idle();
    await w.wake.onDeliver(w.ctx, w.order(2, 'agent-dev', [item(null, 'decision')]), ORDER_REASONS); await w.idle();
    const s = w.started();
    assert.deepEqual(s.map((x) => x.argv[3]), ['fresh', 'resume']);
    assert.equal(s[1].argv[1], s[0].argv[1], 'the same session');
    assert.equal(w.wake.state('hk').agents['agent-dev'].inbox.id, s[0].argv[1]);
    // a task item keeps its own session and never touches the inbox
    await w.wake.onDeliver(w.ctx, w.order(3, 'agent-dev', [item(TASK_A)]), ORDER_REASONS); await w.idle();
    assert.equal(w.started()[2].argv[3], 'fresh');
    assert.notEqual(w.started()[2].argv[1], s[0].argv[1]);
    assert.equal(w.wake.state('hk').agents['agent-dev'].inbox.id, s[0].argv[1]);
  });

  test('an inbox session older than 12 hours starts fresh and the new session is remembered', async () => {
    const w = world();
    await w.wake.onDeliver(w.ctx, w.order(1, 'agent-dev', [item(null, 'message')]), ORDER_REASONS); await w.idle();
    w.state.t += 12 * 3600_000 + 1000;
    await w.wake.onDeliver(w.ctx, w.order(2, 'agent-dev', [item(null, 'message')]), ORDER_REASONS); await w.idle();
    const s = w.started();
    assert.deepEqual(s.map((x) => x.argv[3]), ['fresh', 'fresh']);
    assert.notEqual(s[1].argv[1], s[0].argv[1]);
    assert.equal(w.wake.state('hk').agents['agent-dev'].inbox.id, s[1].argv[1]);
    w.state.t += 3600_000; // one hour on: young enough again
    await w.wake.onDeliver(w.ctx, w.order(3, 'agent-dev', [item(null, 'message')]), ORDER_REASONS); await w.idle();
    assert.equal(w.started()[2].argv[3], 'resume');
  });

  test('a resume the client cannot do falls back to a fresh session with the same items, once, and the inbox moves on', async () => {
    const w = world();
    await w.wake.onDeliver(w.ctx, w.order(1, 'agent-dev', [item(null, 'message')]), ORDER_REASONS); await w.idle();
    w.state.mode = 'noresume';
    await w.wake.onDeliver(w.ctx, w.order(2, 'agent-dev', [item(null, 'decision')]), ORDER_REASONS);
    await w.until(() => w.started().length >= 3); await w.idle();
    const s = w.started();
    assert.deepEqual(s.map((x) => x.argv[3]), ['fresh', 'resume', 'fresh']);
    assert.equal(s[2].argv[4], promptFor([item(null, 'decision')], null), 'the fresh run carries the items the resume was for');
    assert.notEqual(s[2].argv[1], s[0].argv[1]);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(w.started().length, 3, 'no loop');
    assert.equal(w.wake.state('hk').agents['agent-dev'].inbox.id, s[2].argv[1]);
  });

  test('a reason order starts fresh and leaves the inbox alone, and a reset forgets the inbox', async () => {
    const w = world();
    await w.wake.onDeliver(w.ctx, w.order(1, 'agent-dev', [item(null, 'message')]), ORDER_REASONS); await w.idle();
    const inbox = w.wake.state('hk').agents['agent-dev'].inbox.id;
    await w.wake.onDeliver(w.ctx, w.order(2, 'agent-dev', [], { reason: 'team_start' }), ORDER_REASONS); await w.idle();
    assert.equal(w.started()[1].argv[3], 'fresh');
    assert.equal(w.wake.state('hk').agents['agent-dev'].inbox.id, inbox);
    recordReset(w.home, 'hk', 'agent-dev', 'pca_reset9');
    await w.wake.onDeliver(w.ctx, w.order(3, 'agent-dev', [item(null, 'message')]), ORDER_REASONS); await w.idle(); // resumes, and the reset is applied when it ends
    assert.equal(w.wake.state('hk').agents['agent-dev'].inbox, undefined, 'the reset dropped it');
    await w.wake.onDeliver(w.ctx, w.order(4, 'agent-dev', [item(null, 'message')]), ORDER_REASONS); await w.idle();
    assert.equal(w.started().at(-1).argv[3], 'fresh');
  });

  test('the prompt names only what waits and asks for the session_ack; a retry never says a message arrived', () => {
    const p = (items, task) => promptFor(items, task);
    assert.match(p([item(TASK_A)], TASK_A), /Call task_list \{task_id: "task_aaaa1111"\} for the details/);
    assert.doesNotMatch(p([item(TASK_A)], TASK_A), /message_read/);
    assert.match(p([item(null, 'message')], null), /Call message_read for the details/);
    assert.doesNotMatch(p([item(null, 'message')], null), /task_list/);
    assert.match(p([item(null, 'decision')], null), /Call team_decisions for the details/);
    assert.match(p([item(null, 'message'), item(null, 'decision')], null), /Call message_read and team_decisions/);
    for (const x of [p([item(TASK_A)], TASK_A), p([item(null, 'message')], null), p([{ notice: 'retry' }], TASK_A)]) assert.match(x, /confirm the notices you handled with session_ack/);
    assert.doesNotMatch(p([{ notice: 'retry' }], TASK_A), /message arrived/);
    assert.doesNotMatch(p([{ notice: 'limit' }], null), /message arrived/);
    assert.match(p([{ notice: 'retry' }], TASK_A), /still waits on you/);
  });


  test('the prompt is fixed words and ids only, and the run holds no key and needs no click', async () => {
    const w = world();
    assert.equal(folderApproved(w.home, w.folder, { agent: 'dev', hub_id: 'hub-w', identity: folderIdentity(canonicalFolder(w.folder)) }), false);
    await w.wake.onDeliver(w.ctx, w.order(1, 'agent-dev', [item(TASK_A, 'review_requested')]), ORDER_REASONS); await w.idle();
    const s = w.started()[0];
    assert.equal(s.argv[4], promptFor([item(TASK_A, 'review_requested')], TASK_A));
    assert.match(s.argv[4], /a review was requested \(task task_aaaa1111\)/);
    assert.equal(s.env.hasKey, false, 'no long-lived key in the run\'s environment');
    assert.equal(folderApproved(w.home, w.folder, { agent: 'dev', hub_id: 'hub-w', identity: folderIdentity(canonicalFolder(w.folder)) }), false, 'nothing is written to the approvals');
  });

  test('the launcher mark lasts only while the run lives: after it ends, is stopped or fails to start, a hand-opened chat needs its click again', async () => {
    const key = (w) => pathKey(canonicalFolder(w.folder));
    const bound = (w) => ({ agent: 'dev', hub_id: 'hub-w', identity: folderIdentity(canonicalFolder(w.folder)) });
    // while it runs, the broker knows it; when it ends, it does not
    const w = world({ mode: 'hang' });
    await w.wake.onDeliver(w.ctx, w.order(1, 'agent-dev', [item(TASK_A)]), ORDER_REASONS);
    await w.until(() => w.started().length === 1);
    assert.ok(w.launcherRuns.has(key(w)), 'the broker knows it is a launcher run');
    w.state.mode = 'quick';
    assert.equal(await w.wake.stop(w.ctx, 'agent-dev'), true);
    assert.equal(w.launcherRuns.has(key(w)), false, 'stopped');
    await w.wake.onDeliver(w.ctx, w.order(2, 'agent-dev', [item(TASK_A, 'changes_requested')]), ORDER_REASONS);
    await w.idle();
    assert.equal(w.launcherRuns.has(key(w)), false, 'ended');
    assert.equal(folderApproved(w.home, w.folder, bound(w)), false, 'a chat opened by hand now waits for the click');
    // a spawn that fails leaves no mark
    const f = world({ hub: { spawn() { throw new Error('no such program'); } } });
    const r = await f.wake.onDeliver(f.ctx, f.order(1, 'agent-dev', [item(TASK_A)]), ORDER_REASONS);
    assert.equal(r.state, 'open');
    assert.equal(f.launcherRuns.has(key(f)), false, 'failed to start');
  });

  test('the account profile\'s environment reaches the run (the runEnv seam)', async () => {
    const w = world();
    setRunEnv((_h, folder) => (folder === canonicalFolder(w.folder) ? { WAKE_PROFILE: 'work' } : {}));
    try { await w.wake.onDeliver(w.ctx, w.order(1, 'agent-dev', [item(TASK_A)]), ORDER_REASONS); await w.idle(); } finally { setRunEnv(null); }
    assert.equal(w.started()[0].env.PROFILE, 'work');
  });
});

describe('one turn at a time per agent', () => {
  test('an item for another task waits, one for the running task is a notice, and the waiting one starts when the turn ends', async () => {
    const w = world({ mode: 'hang' });
    await w.wake.onDeliver(w.ctx, w.order(1, 'agent-dev', [item(TASK_A)]), ORDER_REASONS);
    await w.until(() => w.started().length === 1);
    const b = await w.wake.onDeliver(w.ctx, w.order(2, 'agent-dev', [item(TASK_B)]), ORDER_REASONS);
    assert.equal(b.state, 'open', 'its order stays open');
    assert.ok(w.sent('/wake/report').some((c) => c.body.state === 'waiting' && c.body.waiting_on === TASK_A), 'the console can say "Waiting behind task A"');
    const a = await w.wake.onDeliver(w.ctx, w.order(3, 'agent-dev', [item(TASK_A, 'changes_requested')]), ORDER_REASONS);
    assert.equal(a.state, 'done', 'the running turn gets it as an inline notice');
    assert.equal(w.started().length, 1, 'no second turn');
    // the running turn ends (the operator stops it); the waiting task starts, fresh
    w.state.mode = 'quick';
    assert.equal(await w.wake.stop(w.ctx, 'agent-dev'), true);
    await w.wake.tick(w.ctx);
    await w.idle();
    assert.equal(w.started().length, 2);
    assert.equal(w.started()[1].argv[3], 'fresh');
    assert.ok(w.sent('/orders/pca_2/result').some((c) => c.body.state === 'done'), 'the waiting order is reported when its turn starts');
  });

  test('two agents: one ending during a check-in leaves the other\'s run, queue and sessions alone, and starts no second turn', async () => {
    const w = world({ mode: 'hang' });
    await w.wake.onDeliver(w.ctx, w.order(1, 'agent-dev', [item(TASK_A)]), ORDER_REASONS);
    await w.wake.onDeliver(w.ctx, w.order(2, 'agent-dev2', [item(TASK_B)]), ORDER_REASONS);
    await w.until(() => w.started().length === 2);
    await w.wake.onDeliver(w.ctx, w.order(3, 'agent-dev', [item('task_cccc3333')]), ORDER_REASONS); // waits behind task A
    const before = w.wake.state('hk').agents;
    const dev2 = before['agent-dev2'].run.pid, dev = before['agent-dev'].run.pid;
    process.kill(dev); // dev's turn ends; dev2's goes on
    await w.until(() => { const r = w.wake.state('hk').agents['agent-dev'].run; return r && r.pid !== dev; });
    await w.wake.tick(w.ctx); await w.wake.finishAll();
    await w.wake.tick(w.ctx); await w.wake.finishAll();
    const after = w.wake.state('hk').agents;
    assert.equal(after['agent-dev2'].run.pid, dev2, 'the other agent\'s run is still recorded');
    assert.ok(after['agent-dev'].run && after['agent-dev'].run.pid !== dev, 'the waiting task started in the finished run\'s place');
    assert.equal(after['agent-dev'].queue.length, 0, 'what waited was started, not put back');
    assert.ok(after['agent-dev'].sessions[TASK_A], 'the finished run\'s session is kept');
    await w.until(() => w.started().length >= 3); await new Promise((r) => setTimeout(r, 400));
    const count = w.started().length;
    await w.wake.stop(w.ctx, 'agent-dev'); await w.wake.stop(w.ctx, 'agent-dev2');
    assert.equal(count, 3, 'exactly one new turn, not two at once');
  });

  test('a stop ends the run, is reported as stopped, and keeps the task\'s session', async () => {
    const w = world({ mode: 'hang' });
    await w.wake.onDeliver(w.ctx, w.order(1, 'agent-dev', [item(TASK_A)]), ORDER_REASONS);
    await w.until(() => w.started().length === 1);
    const pid = w.wake.state('hk').agents['agent-dev'].run.pid;
    assert.equal(await w.wake.stop(w.ctx, 'agent-dev'), true);
    assert.ok(w.sent('/wake/report').some((c) => c.body.state === 'stopped'));
    assert.equal(w.wake.state('hk').agents['agent-dev'].run, null);
    await w.until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
    assert.equal(await w.wake.stop(w.ctx, 'agent-dev'), false, 'nothing left to stop');
    assert.ok(w.wake.state('hk').agents['agent-dev'].sessions[TASK_A], 'the session stays for the next item');
  });
});

describe('when a turn ends', () => {
  test('completion is the hub\'s word: a task still waiting on the agent is continued once, then left to the hub\'s deadline', async () => {
    const w = world();
    w.state.held = [{ task: TASK_A, phase: 'queued' }];
    await w.wake.onDeliver(w.ctx, w.order(1, 'agent-dev', [item(TASK_A)]), ORDER_REASONS);
    await w.until(() => w.started().length >= 2);
    await w.idle();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(w.started().length, 2, 'one continuation, not a loop');
    assert.equal(w.started()[1].argv[3], 'resume');
  });

  test('a task that ended closes its session: it is never resumed', async () => {
    const w = world();
    await w.wake.onDeliver(w.ctx, w.order(1, 'agent-dev', [item(TASK_A)]), ORDER_REASONS); await w.idle();
    assert.ok(w.wake.state('hk').agents['agent-dev'].sessions[TASK_A]);
    w.state.open = false;
    await w.wake.onDeliver(w.ctx, w.order(2, 'agent-dev', [item(TASK_A, 'changes_requested')]), ORDER_REASONS); await w.idle();
    assert.equal(w.wake.state('hk').agents['agent-dev'].sessions[TASK_A], undefined, 'closed when the hub says the task is over');
  });

  test('a standard-level run that met an approval ends, says so, and is not started again', async () => {
    const w = world({ mode: 'denial' });
    await w.wake.onDeliver(w.ctx, w.order(1, 'agent-dev', [item(TASK_A)]), ORDER_REASONS); await w.idle();
    assert.ok(w.sent('/wake/report').some((c) => c.body.state === 'needs_approval'));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(w.started().length, 1);
  });

  test('a reset waits for the turn to end, then the next item starts a fresh session', async () => {
    const w = world({ mode: 'hang' });
    await w.wake.onDeliver(w.ctx, w.order(1, 'agent-dev', [item(TASK_A)]), ORDER_REASONS);
    await w.until(() => w.started().length === 1);
    recordReset(w.home, 'hk', 'agent-dev', 'pca_reset1');
    w.state.mode = 'quick';
    await w.wake.stop(w.ctx, 'agent-dev'); // the turn ends (stopped keeps the session) ...
    await w.wake.onDeliver(w.ctx, w.order(2, 'agent-dev', [item(TASK_A, 'changes_requested')]), ORDER_REASONS); await w.idle();
    // ... the reset is applied when the next turn finishes: its session is dropped, so the one after starts fresh
    await w.wake.onDeliver(w.ctx, w.order(3, 'agent-dev', [item(TASK_A, 'changes_requested')]), ORDER_REASONS); await w.idle();
    assert.ok(w.sent('/orders/pca_reset1/result').some((c) => c.body.state === 'done'), 'the reset order is reported done');
    assert.equal(w.started().at(-1).argv[3], 'fresh');
  });
});

describe('an agent whose key the hub refuses', () => {
  test('is reported as a refused key, not as a missing folder', async () => {
    const w = world({ hub: { request: async (_h, _m, path) => (path === '/connector/v1/turn-tokens' ? { status: 401, json: { error: 'key_inactive' } } : { status: 200, json: {} }) } });
    const r = await w.wake.onDeliver(w.ctx, w.order(1, 'agent-dev', [item(TASK_A)]), ORDER_REASONS);
    assert.deepEqual([r.state, r.code], ['failed', 'agent_unknown']);
    assert.equal(r.reason, ORDER_REASONS.agent_key_refused);
    assert.match(r.reason, /no longer accepts the key/);
  });
});

describe('what keeps a turn from starting', () => {
  test('a chat in use, a wake that is off, and an agent with no folder each say why, and keep the item for the prompt hook', async () => {
    const w = world();
    setWake(w.home, 'dev', false);
    const off = await w.wake.onDeliver(w.ctx, w.order(1, 'agent-dev', [item(TASK_A)]), ORDER_REASONS);
    assert.deepEqual([off.state, off.code], ['failed', 'wake_held']);
    assert.ok(waiting(w.home, 'hk')['agent-dev'], 'kept for the prompt hook');
    setWake(w.home, 'dev', true);
    const none = await w.wake.onDeliver(w.ctx, w.order(2, 'agent-nobody', [item(TASK_A)]), ORDER_REASONS);
    assert.deepEqual([none.state, none.code], ['failed', 'agent_unknown']);
    assert.ok(waiting(w.home, 'hk')['agent-nobody'], 'kept for the prompt hook');
    assert.equal(w.started().length === 0 || !existsSync(join(w.home, 'args.log')), true, 'no turn started');
  });

  test('a chat a person has open is never taken over', async () => {
    const w = world();
    const { markRunning } = await import('./connector/run.mjs');
    const un = markRunning(w.home, 'hk', 'dev', 'agent-dev');
    try {
      const r = await w.wake.onDeliver(w.ctx, w.order(1, 'agent-dev', [item(TASK_A)]), ORDER_REASONS);
      assert.deepEqual([r.state, r.code], ['failed', 'chat_in_use']);
      assert.ok(waiting(w.home, 'hk')['agent-dev']);
      assert.equal(existsSync(join(w.home, 'args.log')), false);
    } finally { un(); }
  });

  test('an item that waited behind a turn is held when a person opened the chat meanwhile: no run, the order fails as chat_in_use, the item is kept', async () => {
    const w = world({ mode: 'hang' });
    const { markRunning } = await import('./connector/run.mjs');
    await w.wake.onDeliver(w.ctx, w.order(1, 'agent-dev', [item(TASK_A)]), ORDER_REASONS);
    await w.until(() => w.started().length === 1);
    assert.equal((await w.wake.onDeliver(w.ctx, w.order(2, 'agent-dev', [item(TASK_B)]), ORDER_REASONS)).state, 'open', 'queued behind task A');
    const un = markRunning(w.home, 'hk', 'dev', 'agent-dev'); // a person opens the chat while it waits
    try {
      w.state.mode = 'quick';
      assert.equal(await w.wake.stop(w.ctx, 'agent-dev'), true);
      await w.wake.tick(w.ctx); await w.wake.finishAll();
      assert.equal(w.started().length, 1, 'no second run was started');
      assert.equal(w.wake.state('hk').agents['agent-dev'].queue.length, 0, 'the queue is emptied, not retried');
      const res = w.sent('/orders/pca_2/result').find((c) => c.body.state === 'failed');
      assert.equal(res?.body.result.code, 'chat_in_use', 'the order says why');
      assert.ok(waiting(w.home, 'hk')['agent-dev'], 'kept for the prompt hook');
    } finally { un(); }
  });

  test('the wake\'s own run is not a chat in use once it ended: its marker (the broker writes it under the run\'s pid) is gone, so the waiting item starts', async () => {
    const w = world({ mode: 'hang' });
    const { markRunning } = await import('./connector/run.mjs');
    await w.wake.onDeliver(w.ctx, w.order(1, 'agent-dev', [item(TASK_A)]), ORDER_REASONS);
    await w.until(() => w.started().length === 1);
    assert.equal((await w.wake.onDeliver(w.ctx, w.order(2, 'agent-dev', [item(TASK_B)]), ORDER_REASONS)).state, 'open');
    const pid = w.wake.state('hk').agents['agent-dev'].run.pid;
    markRunning(w.home, 'hk', 'dev', 'agent-dev', pid); // as the broker does when the run asks for its turn token; never unmarked here
    w.state.mode = 'quick';
    assert.equal(await w.wake.stop(w.ctx, 'agent-dev'), true);
    await w.wake.tick(w.ctx); await w.wake.finishAll();
    await w.until(() => w.started().length === 2);
    assert.equal(w.sent('/orders/pca_2/result').some((c) => c.body.state === 'failed'), false, 'not held as chat_in_use');
  });

  test('agent messages are off by default, and when on, one wake per agent per 10 minutes', async () => {
    const w = world();
    const msg = (n) => w.order(n, 'agent-dev', [item(null, 'message')], { agent_msg: true });
    assert.equal((await w.wake.onDeliver(w.ctx, msg(1), ORDER_REASONS)).code, 'wake_held');
    writeFileSync(join(w.home, 'wake.json'), JSON.stringify({ agents: { dev: true }, agent_messages: true }));
    assert.equal((await w.wake.onDeliver(w.ctx, msg(2), ORDER_REASONS)).state, 'reported'); await w.idle();
    assert.equal((await w.wake.onDeliver(w.ctx, msg(3), ORDER_REASONS)).code, 'wake_held', 'inside the 10 minute cap');
    w.state.t += WAKE_CAP_MS + 1000;
    assert.equal((await w.wake.onDeliver(w.ctx, msg(4), ORDER_REASONS)).state, 'reported'); await w.idle();
  });
});

describe('a plan usage limit', () => {
  test('pauses every run on that profile until the reset, then resumes the same session, never with paid usage', async () => {
    const resets = Math.floor((1_800_000_000_000 + 3600_000) / 1000);
    const w = world({ mode: 'limit', hub: { env: { WAKE_RESETS: String(resets) } } }); // a run's environment is an allowlist: the fake gets this one from the test
    setProfileOf(() => 'work');
    try {
      await w.wake.onDeliver(w.ctx, w.order(1, 'agent-dev', [item(TASK_A)]), ORDER_REASONS); await w.idle();
      const paused = w.sent('/wake/report').find((c) => c.body.state === 'paused_usage');
      assert.ok(paused && paused.body.resumes_at >= resets * 1000 && paused.body.resumes_at <= resets * 1000 + 4 * 60_000, 'resumes at the reset, spread over a few minutes');
      // another agent on the same profile waits too
      const o = await w.wake.onDeliver(w.ctx, w.order(2, 'agent-dev2', [item(TASK_B)]), ORDER_REASONS);
      assert.equal(o.state, 'open');
      assert.equal(w.started().length, 1);
      // before the reset nothing starts; after it the same session resumes
      await w.wake.tick(w.ctx);
      assert.equal(w.started().length, 1);
      w.state.mode = 'quick'; w.state.t = paused.body.resumes_at + 1000;
      await w.wake.tick(w.ctx); await w.idle(); await w.idle('agent-dev2');
      const again = w.started().filter((s) => s.argv[3] === 'resume');
      assert.equal(again.length, 1);
      assert.equal(again[0].argv[1], w.started()[0].argv[1], 'the same session');
      assert.ok(w.started().every((s) => !s.argv.some((a) => /extra|overage|paid/i.test(a))), 'paid extra usage is never turned on');
    } finally { setProfileOf(null); }
  });

  test('the limit is read from the run\'s structured events, never from its words', () => {
    const f = join(mk(), 'o.jsonl');
    writeFileSync(f, JSON.stringify({ type: 'result', is_error: true, result: 'Claude usage limit reached, resets at 3pm' }) + '\n');
    assert.equal(readRun(f).limit, null, 'words alone are not a limit');
    writeFileSync(f, JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1900000000 } }) + '\n');
    assert.equal(readRun(f, 1899999000_000).limit, 1900000000_000);
    writeFileSync(f, JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1900000000 } }) + '\n');
    assert.equal(readRun(f).limit, null);
  });
});

describe('a Codex usage limit', () => {
  const T0 = 1_800_000_000_000;
  test('is read from the run error events: its own reset time, else the try-again delay, else an hour; never from agent text', () => {
    const f = join(mk(), 'o.jsonl'), at = (o) => { writeFileSync(f, JSON.stringify(o) + '\n'); return readRun(f, T0).limit; };
    assert.equal(at({ type: 'turn.failed', error: { message: "You've hit your usage limit. Try again in 2 hours 5 minutes." } }), T0 + (2 * 3600 + 5 * 60) * 1000);
    assert.equal(at({ type: 'error', message: 'You have hit your usage limit', resets_in_seconds: 90 }), T0 + 90_000);
    assert.equal(at({ type: 'error', message: 'usage limit reached', resets_at: (T0 + 7200_000) / 1000 }), T0 + 7200_000);
    assert.equal(at({ type: 'turn.failed', error: { message: 'You hit your usage limit.' } }), T0 + 3600_000, 'no reset given: one hour');
    assert.equal(at({ type: 'turn.failed', error: { message: 'network down' } }), null, 'another failure is not a limit');
    assert.equal(at({ type: 'item.completed', item: { type: 'agent_message', text: 'I hit my usage limit, try again in 5 hours' } }), null, 'agent text is not a limit');
    assert.equal(codexLimitAt({ type: 'result' }, T0), null);
    // A reset in the wrong unit or absurdly far away is cut to 8 days, for Codex and for Claude alike.
    assert.equal(at({ type: 'error', message: 'usage limit', resets_at: T0 }), T0 + 8 * 86400_000, 'milliseconds read as seconds');
    assert.equal(at({ type: 'turn.failed', error: { message: 'usage limit, try again in 400 days' } }), T0 + 8 * 86400_000);
    writeFileSync(f, JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 9e12 } }) + '\n');
    assert.equal(readRun(f, T0).limit, T0 + 8 * 86400_000);
  });
  test('pauses the profile like the Claude limit: held wakes wait for the reset, then the same session resumes', async () => {
    const w = world({ mode: 'codexlimit', hub: { env: { WAKE_MSG: "You've hit your usage limit. Try again in 2 hours." } } });
    setProfileOf(() => 'codex-work');
    try {
      await w.wake.onDeliver(w.ctx, w.order(1, 'agent-dev', [item(TASK_A)]), ORDER_REASONS); await w.idle();
      const paused = w.sent('/wake/report').find((c) => c.body.state === 'paused_usage');
      assert.ok(paused && paused.body.resumes_at >= w.state.t + 7200_000 && paused.body.resumes_at <= w.state.t + 7200_000 + 4 * 60_000, 'resumes at the reset, spread over a few minutes');
      const o = await w.wake.onDeliver(w.ctx, w.order(2, 'agent-dev2', [item(TASK_B)]), ORDER_REASONS);
      assert.equal(o.state, 'open', 'another agent on the profile waits, its order stays open');
      assert.equal(w.started().length, 1);
      w.state.mode = 'quick'; w.state.t = paused.body.resumes_at + 1000;
      await w.wake.tick(w.ctx); await w.idle(); await w.idle('agent-dev2');
      assert.equal(w.started().filter((s) => s.argv[3] === 'resume').length, 1, 'the same session resumes');
    } finally { setProfileOf(null); }
  });
});

describe('a connector restart', () => {
  test('takes up a live run again only when its process id and start time both match', async () => {
    const w = world({ mode: 'hang' });
    await w.wake.onDeliver(w.ctx, w.order(1, 'agent-dev', [item(TASK_A)]), ORDER_REASONS);
    await w.until(() => w.started().length === 1);
    const run = w.wake.state('hk').agents['agent-dev'].run;
    // a new worker (same home): the process is alive and its start time is the recorded one -> adopted, still running
    const same = createWake({ home: w.home, log: () => {}, deps: { request: async () => ({ status: 200, json: {} }), startTime: () => run.started } });
    await same.adopt(w.ctx);
    await same.tick(w.ctx);
    assert.ok(same.state('hk').agents['agent-dev'].run, 'still its run');
    // a reused pid: alive, but a different start time -> not adopted; the run is closed out
    const reused = createWake({ home: w.home, log: () => {}, deps: { request: async () => ({ status: 200, json: { held: [], task_open: true } }), startTime: () => run.started + 60_000, kill: () => {} } });
    await reused.adopt(w.ctx);
    await reused.tick(w.ctx);
    await reused.finishAll();
    assert.equal(reused.state('hk').agents['agent-dev'].run, null, 'a reused process id is never adopted');
    await w.wake.stop(w.ctx, 'agent-dev').catch(() => {});
    process.kill(run.pid);
  });
});

describe('the start time on Linux', () => {
  test('is read from real /proc text: boot time plus the process\'s ticks, with a command name that holds spaces and brackets', () => {
    // /proc/<pid>/stat as the kernel writes it (field 22 is the start time in ticks after boot), and the start of /proc/stat
    const stat = '4242 (my (odd) cmd) S 1 4242 4242 0 -1 4194560 1000 0 0 0 5 3 0 0 20 0 1 0 123456 12345678 900 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 2 0 0 0 0 0';
    const procStat = 'cpu  100 0 50 1000 0 0 0 0 0 0\ncpu0 100 0 50 1000 0 0 0 0 0 0\nintr 12345\nctxt 98765\nbtime 1795000000\nprocesses 5000\n';
    assert.equal(procStartMs(stat, procStat), 1795000000 * 1000 + 123456 * 10);
    assert.equal(procStartMs(stat, 'cpu 1\n'), null, 'no boot time: unknown, never a guess');
    assert.equal(procStartMs('garbage', procStat), null);
  });
});

describe('reason orders: Start team, the handout and the resume (docs/connector.md, "Reason orders")', () => {
  const deliver = (payload) => validateOrder({ id: 'pca_r1', kind: 'deliver', payload });
  test('a reason order carries no items and its reason comes from the fixed list; an item order still needs an item', () => {
    for (const reason of ['team_start', 'write_handout', 'resume']) {
      const v = deliver({ agent_id: 'agent-dev', items: [], reason });
      assert.equal(v.ok, true, reason);
      assert.deepEqual(v.order.payload, { agent_id: 'agent-dev', items: [], reason });
      assert.equal(deliver({ agent_id: 'agent-dev', items: [item(TASK_A)], reason }).ok, false, `${reason} with an item is refused`);
    }
    assert.equal(deliver({ agent_id: 'agent-dev', items: [] }).ok, false, 'an item order with no item');
    assert.equal(deliver({ agent_id: 'agent-dev', items: [], reason: 'item' }).ok, false, 'reason item with no item');
    assert.equal(deliver({ agent_id: 'agent-dev', items: [], reason: 'check in please' }).ok, false, 'free text is never a reason');
  });

  test('each reason has its own fixed prompt that names the tools to call', () => {
    assert.match(promptFor([], null, 'team_start'), /directives_read \{unread: true, ack: true\} and task_list.*end your turn/);
    assert.match(promptFor([], null, 'write_handout'), /checkout_status.*checkout_handout.*end your turn/);
    assert.match(promptFor([], null, 'resume'), /checkout_resume first, then task_list/);
    assert.equal(promptFor([item(TASK_A)], TASK_A, undefined), promptFor([item(TASK_A)], TASK_A), 'an item order keeps its prompt');
  });

  test('Start team runs exactly one check-in turn, in a fresh session, even when a task still waits on the agent', async () => {
    const w = world();
    w.state.held = [{ task: TASK_A, phase: 'queued' }];
    const r = await w.wake.onDeliver(w.ctx, w.order(1, 'agent-dev', [], { reason: 'team_start' }), ORDER_REASONS);
    assert.equal(r.state, 'reported');
    await w.idle();
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(w.started().length, 1, 'one turn, never continued');
    assert.equal(w.started()[0].argv[3], 'fresh');
    assert.equal(w.started()[0].argv[4], promptFor([], null, 'team_start'));
    assert.ok(w.sent('/orders/pca_1/result').some((c) => c.body.state === 'done'), 'the order is done when the turn starts');
    assert.ok(w.sent('/wake/report').some((c) => c.body.state === 'ended'), 'the console sees the turn end');
  });

  test('a reason order that comes while a turn runs waits for it, then gets its own turn', async () => {
    const w = world({ mode: 'hang' });
    await w.wake.onDeliver(w.ctx, w.order(1, 'agent-dev', [item(TASK_A)]), ORDER_REASONS);
    await w.until(() => w.started().length === 1);
    const r = await w.wake.onDeliver(w.ctx, w.order(2, 'agent-dev', [], { reason: 'write_handout' }), ORDER_REASONS);
    assert.equal(r.state, 'open', 'not taken as a notice by the running turn');
    w.state.mode = 'quick';
    await w.wake.stop(w.ctx, 'agent-dev');
    await w.wake.tick(w.ctx);
    await w.idle();
    assert.equal(w.started().length, 2);
    assert.equal(w.started()[1].argv[4], promptFor([], null, 'write_handout'));
    assert.ok(w.sent('/orders/pca_2/result').some((c) => c.body.state === 'done'));
  });

  test('Stop team: once the hub says the team is paused, the running turn ends as it is and the waiting work is dropped with the fixed reason', async () => {
    const w = world({ mode: 'hang' });
    await w.wake.onDeliver(w.ctx, w.order(1, 'agent-dev', [item(TASK_A)]), ORDER_REASONS);
    await w.until(() => w.started().length === 1);
    await w.wake.onDeliver(w.ctx, w.order(2, 'agent-dev', [item(TASK_B)]), ORDER_REASONS);
    await w.wake.onDeliver(w.ctx, w.order(3, 'agent-dev', [], { reason: 'team_start' }), ORDER_REASONS);
    w.state.paused = true;
    const pid = w.wake.state('hk').agents['agent-dev'].run.pid;
    process.kill(pid); // the turn ends on its own (here: its process exits)
    await w.until(() => w.sent('/orders/pca_3/result').length > 0);
    await w.idle();
    await new Promise((res) => setTimeout(res, 200));
    assert.equal(w.started().length, 1, 'nothing more starts');
    for (const o of ['pca_2', 'pca_3']) {
      const res = w.sent(`/orders/${o}/result`).at(-1).body;
      assert.equal(res.state, 'failed');
      assert.equal(res.result.code, 'team_paused');
      assert.equal(res.result.reason, ORDER_REASONS.team_paused);
    }
    assert.deepEqual(w.wake.state('hk').agents['agent-dev'].queue, []);
    assert.ok(ORDER_REASONS.team_paused.length <= 200);
  });
});

describe('the reset seam', () => {
  test('once the wake has run an agent, a reset order for it waits for the wake instead of answering "by hand"', async () => {
    const w = world();
    assert.equal(wakeOwnsSession(w.home, 'hk', 'agent-dev'), false, 'nothing run yet');
    await w.wake.onDeliver(w.ctx, w.order(1, 'agent-dev', [item(TASK_A)]), ORDER_REASONS); await w.idle();
    assert.equal(wakeOwnsSession(w.home, 'hk', 'agent-dev'), true);
    assert.deepEqual(onResetOrder(w.home, 'hk', { id: 'pca_r', payload: { agent_id: 'agent-dev' } }), { state: 'waiting' });
    setWake(w.home, 'dev', false);
    assert.equal(onResetOrder(w.home, 'hk', { id: 'pca_r2', payload: { agent_id: 'agent-dev' } }).code, 'reset_by_hand', 'a wake that is off holds nothing');
    setWakeOwnsSession(null);
  });
});

describe('a woken run starts safely (wake-safety)', () => {
  test('the program is found by absolute path and never from the agent folder; an npm shim becomes Node and its script', () => {
    const root = mk(), clone = join(root, 'clone'), bin = join(root, 'bin');
    mkdirSync(clone); mkdirSync(bin);
    const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
    writeFileSync(join(clone, exe), ''); writeFileSync(join(bin, exe), '');
    const win = process.platform === 'win32';
    const env = { PATH: [clone, '.', 'relative', bin].join(win ? ';' : ':') };
    // the planted program in the clone, a bare '.' and a relative entry are all skipped
    assert.deepEqual(clientProgram('claude', { env, folder: clone, home: root, win }), { file: join(bin, exe), prefix: [] });
    assert.equal(clientProgram('codex', { env, folder: clone, home: root, win }), null, 'not on this PC');
    const inner = join(clone, 'tools'); mkdirSync(inner); writeFileSync(join(inner, exe), '');
    assert.equal(clientProgram('claude', { env: { PATH: inner }, folder: clone, home: root, win }), null, 'a folder inside the clone is the clone too');
    // npm's Windows shim cannot start without a shell: Node runs the package's script beside it
    const npm = join(root, 'npm'); mkdirSync(join(npm, 'node_modules', '@openai', 'codex', 'bin'), { recursive: true });
    writeFileSync(join(npm, 'codex.cmd'), ''); writeFileSync(join(npm, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), '');
    assert.deepEqual(clientProgram('codex', { env: { PATH: npm }, win: true, home: root }), { file: process.execPath, prefix: [join(npm, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')] });
  });

  test('a run gets an allowlisted environment: no API key reaches it, the profile variable does', async () => {
    const env = runEnvironment({ PATH: '/bin', HOME: '/h', CLAUDE_CODE_GIT_BASH_PATH: '/g', ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', CODEX_API_KEY: 'c', ANTHROPIC_AUTH_TOKEN: 't', AWS_SECRET_ACCESS_KEY: 's', MY_SECRET: 'x' }, { CLAUDE_CONFIG_DIR: '/p', ANTHROPIC_API_KEY: 'no' });
    assert.deepEqual(env, { PATH: '/bin', HOME: '/h', CLAUDE_CODE_GIT_BASH_PATH: '/g', CLAUDE_CONFIG_DIR: '/p' });
    const saved = { A: process.env.ANTHROPIC_API_KEY, O: process.env.OPENAI_API_KEY, C: process.env.CODEX_API_KEY };
    Object.assign(process.env, { ANTHROPIC_API_KEY: 'sk-ant-x', OPENAI_API_KEY: 'sk-x', CODEX_API_KEY: 'sk-y' });
    try {
      const w = world();
      await w.wake.onDeliver(w.ctx, w.order(1, 'agent-dev', [item(TASK_A)]), ORDER_REASONS); await w.idle();
      const run = w.started()[0];
      assert.deepEqual(run.env.paid, [], 'the paid-usage keys are not inherited');
      assert.equal(run.env.hasPath, true, 'but the program can still start');
    } finally { for (const [k, v] of [['ANTHROPIC_API_KEY', saved.A], ['OPENAI_API_KEY', saved.O], ['CODEX_API_KEY', saved.C]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  });

  test('the account profile is wired in: its variable reaches the run', async () => {
    const w = world();
    const dir = join(mk(), 'profile-work');
    const added = addProfile(w.home, 'work', { kind: 'claude', dir }); assert.equal(added.ok, true, JSON.stringify(added));
    const bound = bindAgent(w.home, w.folder, 'work'); assert.equal(bound.ok, true, JSON.stringify(bound));
    await w.wake.onDeliver(w.ctx, w.order(1, 'agent-dev', [item(TASK_A)]), ORDER_REASONS); await w.idle();
    assert.equal(canonicalFolder(w.started()[0].env.config), canonicalFolder(dir));
  });

  test('a program that cannot start (the spawn event never comes) is not reported as delivered', async () => {
    const child = new EventEmitter(); child.pid = undefined; child.unref = () => {};
    const f = world({ hub: { spawn() { queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn x ENOENT'), { code: 'ENOENT' }))); return child; } } });
    const r = await f.wake.onDeliver(f.ctx, f.order(1, 'agent-dev', [item(TASK_A)]), ORDER_REASONS);
    assert.equal(r.state, 'open', 'the order stays open');
    assert.equal(f.sent('/orders/pca_1/result').length, 0, 'never reported delivered');
    assert.equal(f.sent('/wake/report').some((c) => c.body.state === 'running'), false);
    assert.equal(f.launcherRuns.size, 0);
    assert.equal(f.wake.state('hk').agents['agent-dev'].run, null);
  });

  test('a missing client program leaves the order open and starts nothing', async () => {
    const f = world({ hub: { bin: () => null, program: () => null } });
    const r = await f.wake.onDeliver(f.ctx, f.order(1, 'agent-dev', [item(TASK_A)]), ORDER_REASONS);
    assert.equal(r.state, 'open');
    assert.equal(f.started().length, 0);
  });

  test('work that waited behind a turn stays queued and its order open while the program cannot start, and starts once it can', async () => {
    let broken = false;
    const w = world({ mode: 'hang', hub: { bin: () => (broken ? null : process.execPath), program: () => (broken ? null : process.execPath) } });
    await w.wake.onDeliver(w.ctx, w.order(1, 'agent-dev', [item(TASK_A)]), ORDER_REASONS);
    await w.until(() => w.started().length === 1);
    const r = await w.wake.onDeliver(w.ctx, w.order(2, 'agent-dev', [item(TASK_B)]), ORDER_REASONS); // waits behind task A
    assert.equal(w.wake.state('hk').agents['agent-dev'].queue.length, 1);
    broken = true;
    const pid = w.wake.state('hk').agents['agent-dev'].run.pid;
    process.kill(pid); // the running turn ends; the waiting one is next, but the program cannot start
    await w.until(() => !w.wake.state('hk').agents['agent-dev'].run);
    await w.wake.tick(w.ctx); await w.wake.finishAll();
    const a = w.wake.state('hk').agents['agent-dev'];
    assert.equal(a.run, null, 'nothing runs');
    assert.equal(a.queue.length, 1, 'the work stays queued');
    assert.equal(w.sent('/orders/pca_2/result').length, 0, 'its order is not answered: it stays open');
    assert.equal(w.started().length, 1, 'no second turn started');
    broken = false; w.state.mode = 'quick';
    await w.wake.tick(w.ctx); await w.idle();
    assert.equal(w.started().length, 2, 'it started once the program could');
    assert.ok(w.sent('/orders/pca_2/result').some((c) => c.body.state === 'done'));
    assert.equal(w.wake.state('hk').agents['agent-dev'].queue.length, 0);
    void r;
  });

  test('stopFolder ends the wake run in that folder only, and says whether there was one', async () => {
    const w = world({ mode: 'hang' });
    assert.equal(await w.wake.stopFolder(w.folder, 'hk'), false, 'nothing runs yet');
    await w.wake.onDeliver(w.ctx, w.order(1, 'agent-dev', [item(TASK_A)]), ORDER_REASONS);
    await w.until(() => w.started().length === 1);
    assert.equal(await w.wake.stopFolder(w.other, 'hk'), false, 'another agent folder');
    assert.equal(await w.wake.stopFolder(w.folder, 'hk'), true);
    assert.equal(w.wake.state('hk').agents['agent-dev'].run, null);
    assert.ok(w.sent('/wake/report').some((c) => c.body.state === 'stopped'));
  });
});
