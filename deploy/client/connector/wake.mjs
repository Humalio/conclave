/**
 * The wake (docs/connector.md, "The wake"): the connector starts a headless turn for an agent when the hub has work for it.
 * It replaces codex-wake.mjs.
 *
 * - **One session per task.** A new task's first item starts a fresh `claude -p` (or `codex exec`) in the agent's folder: the role
 *   file, a fixed prompt and ids, nothing else. Later items on the same task resume that session. When the task ends the session
 *   is forgotten and never resumed. An item with no task resumes the agent's one inbox session (under 12 h, same client, no chat open), else starts fresh and remembers it.
 * - **One turn at a time per agent folder.** An item for the running task (or with no task) reaches the turn as the hub's own
 *   inline notice, so it is answered at once. An item for another task waits here, its order open, and starts when the turn ends.
 * - **No keys.** The run is started by the connector's launcher (the folder is marked as a launcher run, so it needs no click), and
 *   the folder's `conclave mcp` asks the broker for a turn token. The run's environment holds no key (docs, "Isolation levels").
 * - **Completion** is checked against the hub (`wake/check`), never a process exit alone. `delivered_at` is set when the turn starts.
 * - **Long runs.** Nothing here stops a run for its length. The run writes to a file under the connector's state; the record keeps its
 *   process id and start time, so a restart re-adopts a live run and never a reused id. Usage limits (read from the run's structured
 *   events, never its text) pause every run on that account profile until the reset, spread over a few minutes; paid extra usage is
 *   never turned on. Stop is the operator's, through a `stop` order.
 *
 * Everything the wake needs from outside is a dependency (`deps`) so a test runs it with a fake program and no hub.
 */
import { join } from 'node:path';
import { spawn as spawnDefault } from 'node:child_process';
import { openSync, closeSync, readFileSync, statSync, mkdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { readJson, atomicWrite, pathKey, canonicalFolder, folderIdentity } from './paths.mjs';
import { foldersOfHub, resolveFolder } from './registry.mjs';
import { clientProgram } from './entries.mjs';
import { runEnv as profileEnv, profileOf as profileOfBinding } from './profiles.mjs';
import { killTree, startTimeOf, recordStarted, forgetStarted } from './processes.mjs';
import { runningAgents, alive } from './run.mjs';
import { recordDelivery } from './deliveries.mjs';
import { request } from './hubclient.mjs';
import { sendResult } from './outbox.mjs';
import { setWakeOwnsSession, resetIfIdle } from './reset.mjs';
import { ORDER_REASONS } from './orders.mjs';

export const INBOX_MAX_MS = 12 * 3600_000;    // an inbox session older than this is not resumed
export const WAKE_CAP_MS = 10 * 60_000;      // agent messages: one wake per agent per 10 minutes
export const NO_ACTIVITY_MS = 30 * 60_000;    // the console says "No activity for 30 min" after this; nothing stops
export const RESUME_SPREAD_MS = 4 * 60_000;   // resumes after a usage limit are spread over this long
export const MAX_RETRIES = 1;                 // a turn that left the work unacted is continued once

/** Where the account profile's environment comes from (account-profiles: CLAUDE_CONFIG_DIR / CODEX_HOME): profiles.mjs. */
const profileRunEnv = (home, folder) => { try { return profileEnv(home, folder); } catch { return {}; } };
export let runEnv = profileRunEnv;
export function setRunEnv(fn) { runEnv = typeof fn === 'function' ? fn : profileRunEnv; } // null puts the profiles back
/** The profile's name for a folder, or null (the pause is per profile). */
const profileNameOf = (home, folder) => { try { const f = resolveFolder(home, folder); return f.ok ? profileOfBinding(home, f.binding)?.name ?? null : null; } catch { return null; } };
export let profileOf = profileNameOf;
export function setProfileOf(fn) { profileOf = typeof fn === 'function' ? fn : profileNameOf; }

/**
 * The environment of a woken run: a short allowlist of what a program needs to start, never the connector's whole environment. No
 * API key or token can reach a run this way (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `CODEX_API_KEY` would switch it to paid usage),
 * and the account profile adds its one variable. `extra` is for tests.
 */
const ENV_ALLOW = /^(PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|OS|COMPUTERNAME|USERNAME|USERDOMAIN|USERPROFILE|HOMEDRIVE|HOMEPATH|HOME|USER|LOGNAME|SHELL|TEMP|TMP|TMPDIR|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMW6432|COMMONPROGRAMFILES|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|LANG|LANGUAGE|TERM|COLORTERM|TZ|NO_COLOR|HTTPS?_PROXY|NO_PROXY|ALL_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|CLAUDE_CODE_GIT_BASH_PATH|LC_[A-Z_]+|XDG_[A-Z_]+)$/i;
const ENV_DENY = /(API_KEY|AUTH_TOKEN|SECRET|PASSWORD|ANTHROPIC_|OPENAI_|CODEX_API|AH_|CONCLAVE_)/i;
export function runEnvironment(source, profile = {}, extra = {}) {
  const out = {};
  for (const [k, v] of Object.entries(source)) if (typeof v === 'string' && ENV_ALLOW.test(k) && !ENV_DENY.test(k)) out[k] = v;
  for (const [k, v] of Object.entries(profile)) if (typeof v === 'string' && !ENV_DENY.test(k)) out[k] = v;
  return { ...out, ...extra };
}

const dirOf = (home) => join(home, 'wake');
const hubFile = (home, hubKey) => join(dirOf(home), `${createHash('sha256').update(hubKey).digest('hex').slice(0, 24)}.json`);
const settingsFile = (home) => join(home, 'wake.json');
const EMPTY = () => ({ agents: {}, pause: {}, ids: {} });
const load = (home, hubKey) => { const d = readJson(hubFile(home, hubKey), null); return d && typeof d === 'object' && d.agents ? { pause: {}, ids: {}, ...d } : EMPTY(); };
const save = (home, hubKey, d) => atomicWrite(hubFile(home, hubKey), JSON.stringify(d) + '\n');

/** The PC user's choice per agent (turned on once, on the local screen): `{agents: {label: true}, agent_messages: false}`. */
export const wakeSettings = (home) => { const s = readJson(settingsFile(home), {}) ?? {}; return { agents: s.agents && typeof s.agents === 'object' ? s.agents : {}, agent_messages: s.agent_messages === true }; };
export function setWake(home, label, on) {
  const s = wakeSettings(home);
  if (on) s.agents[label] = true; else delete s.agents[label];
  atomicWrite(settingsFile(home), JSON.stringify(s, null, 2) + '\n');
}
export function setAgentMessages(home, on) { const s = wakeSettings(home); s.agent_messages = !!on; atomicWrite(settingsFile(home), JSON.stringify(s, null, 2) + '\n'); }
export const wakeEnabled = (home, label) => wakeSettings(home).agents[label] === true;

/** The words of a notice, fixed (never text from the hub). */
const WORDS = { task_assigned: 'a task was assigned to you', changes_requested: 'changes were requested on your task', review_requested: 'a review was requested', decision: 'a decision was answered', task_accepted: 'a backlog task was accepted', retry: 'a task you worked on still waits on you', limit: 'your earlier turn was cut short by a usage limit', team_resumed: 'your team was resumed', message: 'a message arrived', plan_request: 'the administrator asked for a plan or refinement', task_approved: 'a task was approved', task_blocked: 'a task was blocked', decision_asked: 'an operator question was asked' };
/** The prompt of a reason order (docs/connector.md, "Reason orders"): fixed words per reason, never text from the hub. */
const REASON_PROMPTS = {
  team_start: 'Conclave woke you for a check-in: your team was started from the console. Call directives_read {unread: true, ack: true} and task_list, start nothing new unless a task assigned to you says so, then end your turn.',
  write_handout: 'Conclave woke you: your team is being moved to another PC. Call checkout_status and follow its steps, write your handout with checkout_handout, then end your turn.',
  resume: 'Conclave woke you: your team was moved to this PC. Call checkout_resume first, then task_list, and carry on with what waits on you.',
};
const TASK_NOTICES = new Set(['task_assigned', 'changes_requested', 'review_requested', 'task_accepted', 'task_approved', 'task_blocked', 'retry']);
/** What the prompt says to read: only what waits (a task item its task, a message the messages, a decision the decision log), never a read nothing waits on. */
const readsFor = (items, task) => {
  const kinds = new Set(items.map((i) => i.notice)), reads = [];
  if (task || [...kinds].some((k) => TASK_NOTICES.has(k))) reads.push(task ? `task_list {task_id: "${task}"}` : 'task_list');
  if (kinds.has('message')) reads.push('message_read');
  if (kinds.has('decision') || kinds.has('decision_asked')) reads.push('team_decisions');
  return reads.length ? reads : ['task_list', 'message_read']; // a notice with no read of its own (a plan request, a usage-limit re-run): both, as before
};
export const promptFor = (items, task, reason) => REASON_PROMPTS[reason] ?? `Conclave woke you: ${[...new Set(items.map((i) => WORDS[i.notice] ?? 'work waits'))].join('; ')}${task ? ` (task ${task})` : ''}. Call ${readsFor(items, task).join(' and ')} for the details, do what waits on you, confirm the notices you handled with session_ack (the highest notice_seq you saw), then end your turn.`;

/** The fixed lines the connector sends the hub about a run (never text from the run). */
export const STATES = ['running', 'waiting', 'paused_usage', 'needs_approval', 'ended', 'stopped'];

/** The text the hub-bound `note` of a state carries is built here from numbers and fixed words only. */
const clock = (ms) => new Date(ms).toTimeString().slice(0, 5);

/**
 * Codex reports its plan limit as an error of the run (an `error` event, or `turn.failed` with an `error`), never as agent text.
 * The reset time is its own structured field (`resets_at`, seconds since 1970, or `resets_in_seconds`) or the "try again in
 * 3 hours 20 minutes" of the error; with none the pause is an hour. `null` when the event is not a usage limit.
 */
const CODEX_LIMIT = /usage limit|hit your (?:\w+ )?limit|reached your (?:\w+ )?limit|rate limit(?:ed)? reached/i;
const DEFAULT_PAUSE_MS = 60 * 60_000;
/** No plan resets later than this; a reset given in the wrong unit (milliseconds read as seconds) must not pause a profile for years. */
export const MAX_PAUSE_MS = 8 * 24 * 3600_000;
export function codexLimitAt(e, nowMs) {
  const err = e.type === 'error' ? e : e.type === 'turn.failed' ? e.error : null;
  if (!err || typeof err !== 'object') return null;
  const message = typeof err.message === 'string' ? err.message : '';
  if (!CODEX_LIMIT.test(message) && !/usage_limit/i.test(String(err.code ?? err.type ?? ''))) return null;
  const info = err.rate_limits ?? err.rate_limit ?? err;
  const at = Number(info.resets_at), inSeconds = Number(info.resets_in_seconds ?? info.resets_in);
  if (Number.isFinite(at) && at > 0) return Math.max(at * 1000, nowMs);
  if (Number.isFinite(inSeconds) && inSeconds > 0) return nowMs + inSeconds * 1000;
  const m = /try again in\s+(?:(\d+)\s*(?:days?|d)\s*)?(?:(\d+)\s*(?:hours?|hrs?|h)\s*)?(?:(\d+)\s*(?:minutes?|mins?|m)\s*)?(?:(\d+)\s*(?:seconds?|secs?|s)\b)?/i.exec(message);
  const ms = m ? ((+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0)) * 1000 : 0;
  return nowMs + (ms > 0 ? ms : DEFAULT_PAUSE_MS);
}

/**
 * Reads a run's output file (JSON lines) for the numbers and structured facts that matter: the session id, whether the turn
 * produced a result, tool approvals it was refused, and a usage limit with its reset time (never later than 8 days from now). Text of messages is never read.
 */
export function readRun(file, nowMs = Date.now()) {
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return { session: null, result: false, error: false, denials: 0, limit: null, last: null }; }
  const out = { session: null, result: false, error: false, denials: 0, limit: null, last: null };
  for (const l of text.split('\n')) {
    if (!l.startsWith('{')) continue;
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (typeof e.session_id === 'string') out.session = e.session_id;
    if (e.type === 'thread.started' && typeof e.thread_id === 'string') out.session = e.thread_id;
    if (e.type === 'result') { out.result = true; out.error = e.is_error === true; if (Array.isArray(e.permission_denials)) out.denials = e.permission_denials.length; }
    if (e.type === 'turn.completed') out.result = true;
    const cl = codexLimitAt(e, nowMs); if (cl) out.limit = cl;
    if (e.type === 'rate_limit_event' && e.rate_limit_info && e.rate_limit_info.status === 'rejected' && Number.isFinite(e.rate_limit_info.resetsAt)) out.limit = e.rate_limit_info.resetsAt * 1000;
  }
  if (out.limit) out.limit = Math.min(out.limit, nowMs + MAX_PAUSE_MS);
  return out;
}

/**
 * The wake of one worker. `broker` is the worker's broker (its `launcherRuns` set marks the folders it starts). `deps`: `spawn`,
 * `startTime`, `now`, `bin(provider)`, `isAlive`, `kill`, `args(provider, {prompt, session, resume})`.
 */
export function createWake({ home, log = () => {}, broker = null, deps = {} }) {
  let runSeq = 0;
  const now = deps.now ?? Date.now;
  const spawnFn = deps.spawn ?? spawnDefault;
  const req = deps.request ?? request;
  const startTime = deps.startTime ?? startTimeOf;
  const isAlive = deps.isAlive ?? alive;
  const kill = deps.kill ?? killTree;
  const children = new Map(); // `${hubKey}|${agentId}` -> exit code, once the child ended
  const hubs = new Map();     // hubKey -> ctx, kept so a child's exit can finish its turn at once

  // The program is found by absolute path, never from the agent's folder (entries.mjs, clientProgram); `deps.bin` is for tests.
  const program = (provider, folder) => { const b = deps.bin?.(provider); return b ? { file: b, prefix: [] } : (deps.program ?? clientProgram)(provider, { folder }); };
  const argsFor = (provider, { prompt, session, resume }) => deps.args?.(provider, { prompt, session, resume })
    ?? (provider === 'codex' ? (resume ? ['exec', 'resume', session, '--json', prompt] : ['exec', '--json', prompt])
      : ['-p', prompt, '--output-format', 'stream-json', '--verbose', resume ? '--resume' : '--session-id', session]);

  // The reset seam (reset.mjs): the wake holds an agent's session when it is on and has run, so a reset waits for the turn to end.
  setWakeOwnsSession((h, k, agentId) => { const a = load(h, k).agents[agentId]; return !!a && wakeEnabled(h, a.label); });

  const agentOf = (d, id, label = null) => (d.agents[id] ??= { label, run: null, queue: [], sessions: {}, cap_at: 0 });

  async function report(ctx, agentId, a, state, extra = {}) {
    const run = a.run;
    try {
      await req(ctx.hub, 'POST', '/connector/v1/wake/report', { headers: ctx.auth, body: { agent_id: agentId, state,
        ...(run?.task ? { task: run.task } : extra.task ? { task: extra.task } : {}), ...(run?.session ? { session_id: run.session } : {}),
        ...(run ? { last_activity: Math.floor(run.activity ?? run.began) } : {}), ...(extra.resumes_at ? { resumes_at: extra.resumes_at } : {}), ...(extra.waiting_on ? { waiting_on: extra.waiting_on } : {}) } });
    } catch (e) { log(`wake: report to ${ctx.section.hub_id} failed (${e.reason ?? e.message})`); }
  }

  /** The hub agent id's label on this PC, learned once per label: a turn token is issued with the agent's key and revoked at once. */
  const keyRefused = new Map(); // hubKey → labels whose key the hub refused at the last try: the reason an agent stays unknown
  async function labelOf(ctx, agentId, d) {
    if (d.ids[agentId]) return d.ids[agentId];
    const found = {}, refused = new Set();
    for (const [label, k] of Object.entries(ctx.section.agents ?? {})) {
      if (Object.values(d.ids).includes(label)) continue;
      const r = await req(ctx.hub, 'POST', '/connector/v1/turn-tokens', { body: { session_key: k.session_key, run: `id-${randomUUID().slice(0, 8)}` }, headers: ctx.auth }).catch(() => null);
      if (r?.status === 401 || r?.status === 403) refused.add(label); // only a refusal, never a network error or a 5xx
      if (r?.status === 200 && r.json?.token) {
        found[r.json.agent_id] = label;
        await req(ctx.hub, 'POST', '/connector/v1/turn-tokens/revoke', { body: { token: r.json.token }, headers: ctx.auth }).catch(() => {});
      }
    }
    // The state is read again after the awaits: only the ids are added to what is on disk now.
    const fresh = load(home, ctx.hubKey);
    Object.assign(fresh.ids, found);
    save(home, ctx.hubKey, fresh);
    keyRefused.set(ctx.hubKey, refused);
    return fresh.ids[agentId] ?? null;
  }

  const folderOf = (ctx, label) => foldersOfHub(home, ctx.section.hub_id, ctx.section.ca_sha256).find((b) => b.agent === label) ?? null;

  /** The usage pause now in force for a profile, or null. */
  const pausedUntil = (d, profile) => { const p = d.pause[profile ?? '-']; return p && p.until > now() ? p.until : null; };

  /** Starts one turn. Returns whether it started. */
  async function startTurn(ctx, d, agentId, a, work) {
    const bind = folderOf(ctx, a.label);
    const folder = bind && canonicalFolder(bind.path);
    if (!folder) return false;
    const provider = bind.provider === 'codex' ? 'codex' : 'claude';
    // An item with no task resumes the agent's inbox session while it is the same client and young enough; a reason order or a re-run after a failed resume starts fresh.
    const inboxOk = !work.task && !work.reason && !work.fresh && a.inbox?.id && a.inbox.provider === provider && now() - a.inbox.at < INBOX_MAX_MS;
    const known = work.task ? a.sessions[work.task] : inboxOk ? a.inbox : null;
    const resume = !!known, session = known?.id ?? (provider === 'codex' ? null : randomUUID());
    mkdirSync(dirOf(home), { recursive: true });
    const out = join(dirOf(home), `run-${createHash('sha256').update(ctx.hubKey + agentId).digest('hex').slice(0, 12)}-${now()}-${++runSeq}.jsonl`);
    const fd = openSync(out, 'a');
    let child;
    const prog = program(provider, folder);
    if (!prog) { closeSync(fd); log(`wake: the turn for ${a.label} could not start (${provider === 'codex' ? 'Codex' : 'Claude Code'} was not found on this PC)`); return false; }
    children.delete(`${ctx.hubKey}|${agentId}`); // an exit seen for an earlier run is not this one's
    try {
      // The broker knows this folder as a launcher run (no click) for as long as the run lives, and not a moment longer: a chat a
      // person opens by hand afterwards waits for its click again. Nothing is written to approvals.json for it.
      broker?.launcherRuns.add(pathKey(folder));
      child = spawnFn(prog.file, [...prog.prefix, ...argsFor(provider, { prompt: promptFor(work.items, work.task, work.reason), session, resume })], { cwd: folder, env: runEnvironment(process.env, runEnv(home, folder), deps.env), stdio: ['ignore', fd, fd], detached: true, windowsHide: true, shell: false });
    } catch (e) { closeSync(fd); broker?.launcherRuns.delete(pathKey(folder)); log(`wake: the turn for ${a.label} could not start (${e.message})`); return false; }
    closeSync(fd);
    // A launch is delivered only after the `spawn` event: a program that cannot start (not found, not allowed) emits `error` instead, and a
    // turn that never began must not be reported as delivered.
    const launched = await new Promise((resolve) => {
      if (typeof child?.once !== 'function') return resolve({ ok: true });
      const t = setTimeout(() => resolve({ ok: !!child.pid }), 5000);
      child.once('spawn', () => { clearTimeout(t); resolve({ ok: true }); });
      child.once('error', (e) => { clearTimeout(t); resolve({ ok: false, error: e }); });
    });
    if (!launched.ok) { broker?.launcherRuns.delete(pathKey(folder)); log(`wake: the turn for ${a.label} could not start (${launched.error?.code ?? launched.error?.message ?? 'no process'})`); return false; }
    child.on?.('error', (e) => { log(`wake: ${a.label}: ${e.message}`); children.set(`${ctx.hubKey}|${agentId}`, { pid: child.pid, code: -1 }); finishSoon(ctx.hubKey, agentId, child.pid); });
    child.on?.('exit', (code) => { children.set(`${ctx.hubKey}|${agentId}`, { pid: child.pid, code: code ?? 0 }); finishSoon(ctx.hubKey, agentId, child.pid); });
    child.unref?.();
    try { if (child.pid) recordStarted(home, { pid: child.pid, image: prog.file, ...(prog.prefix[0] ? { script: prog.prefix[0] } : {}), hubKey: ctx.hubKey, what: `woken turn for ${a.label}` }); } catch { /* not recorded: it is then never ended by Disconnect */ }
    a.run = { pid: child.pid, started: startTime(child.pid) ?? now(), began: now(), out, task: work.task ?? null, session, provider, tries: work.tries ?? 0, items: work.items.length, work: work.items.slice(0, 20), inbox: work.task || work.reason ? null : (resume ? 'resumed' : 'fresh'), profile: profileOf(home, folder), folder };
    save(home, ctx.hubKey, d);
    log(`wake: a turn started for ${a.label}${work.task ? ` on task ${work.task}` : ''} (${resume ? 'resumed' : 'fresh'} ${provider} session)`);
    await report(ctx, agentId, a, 'running');
    return true;
  }

  let finishing = Promise.resolve();
  // An exit counts only for the run it belongs to: a stopped run's exit never ends the next one.
  const finishSoon = (hubKey, agentId, pid) => { finishing = finishing.then(() => { const ctx = hubs.get(hubKey); return ctx && load(home, hubKey).agents[agentId]?.run?.pid === pid ? finish(ctx, agentId) : null; }).catch((e) => log(`wake: ${e.message}`)); };

  /** The run of this agent has ended: read what it left, close or keep its session, and start what waits. */
  // State rule: every function reads the state itself, changes it and saves it with no await in between, and reads it again after
  // any await. Nothing holds a copy across an await or is handed one by its caller, so a write never puts back stale data.
  async function finish(ctx, agentId) {
    let d = load(home, ctx.hubKey), a = d.agents[agentId];
    if (!a?.run) return;
    const run = a.run, seen = readRun(run.out, now());
    const key = run.task ?? null;
    if (seen.session && key) a.sessions[key] = { id: seen.session, at: now(), provider: run.provider };
    const failedResume = run.inbox === 'resumed' && !seen.result && !seen.limit;
    const inboxId = seen.session ?? (seen.result ? run.session : null);
    if (run.inbox && inboxId && !failedResume) a.inbox = { id: inboxId, at: now(), provider: run.provider };
    a.run = null;
    forgetStarted(home, run.pid);
    broker?.launcherRuns.delete(pathKey(run.folder));
    // A usage limit pauses every run on this profile until the reset; the work waits and the same session resumes (never paid extra usage).
    if (seen.limit) {
      const spread = Math.floor(parseInt(createHash('sha256').update(agentId).digest('hex').slice(0, 6), 16) / 0xffffff * RESUME_SPREAD_MS);
      d.pause[run.profile ?? '-'] = { until: seen.limit + spread };
      a.queue.unshift({ order: null, task: run.task, items: [{ notice: 'limit' }], tries: run.tries });
      save(home, ctx.hubKey, d);
      log(`wake: ${a.label}: usage limit, resumes at ${clock(seen.limit + spread)}`);
      await report(ctx, agentId, a, 'paused_usage', { resumes_at: seen.limit + spread });
      return;
    }
    // A turn that ended on a refused tool is not continued by itself (a person acts first). Work waiting behind it for another task
    // is not held back: the next check-in starts it.
    if (seen.denials > 0) { save(home, ctx.hubKey, d); log(`wake: ${a.label}: a tool needed approval; the turn ended`); await report(ctx, agentId, a, 'needs_approval'); return; }
    save(home, ctx.hubKey, d); // the run is over on disk before anything is awaited
    // A reset waits for the turn's end (reset.mjs): the next item starts a fresh session.
    const r = await resetIfIdle(home, ctx.hubKey, agentId, { turnRunning: () => false, closeSession: () => { const x = load(home, ctx.hubKey); if (x.agents[agentId]) { x.agents[agentId].sessions = {}; delete x.agents[agentId].inbox; save(home, ctx.hubKey, x); } } });
    if (r.state === 'done' && r.order) await sendResult({ home, hubKey: ctx.hubKey, hub: ctx.hub, auth: ctx.auth, request: req, log }, r.order, 'done', null);
    // Completion is the hub's word: does the agent still hold work on this task?
    let check = null;
    try { const c = await req(ctx.hub, 'POST', '/connector/v1/wake/check', { body: { agent_id: agentId, ...(run.task ? { task: run.task } : {}) }, headers: ctx.auth }); if (c.status === 200) check = c.json; } catch { /* unreachable: the next check-in decides */ }
    d = load(home, ctx.hubKey); a = d.agents[agentId]; // read again: a delivery may have saved while the check was out
    if (!a) return;
    // A resumed inbox session that did not run (the client could not resume it): forget it and run the same items once more, fresh.
    if (failedResume) { delete a.inbox; a.queue.unshift({ order: null, task: null, items: run.work?.length ? run.work : [{ notice: 'retry' }], tries: run.tries, fresh: true }); log(`wake: ${a.label}: the inbox session could not be resumed; it starts fresh`); }
    if (run.task && check && check.task_open === false) delete a.sessions[run.task]; // the task ended: its session is closed for good
    const unacted = !!check && (run.task ? check.held?.some((h) => h.task === run.task && h.phase === 'queued') : false);
    // Stop team: the hub paused the team, so nothing more starts; the waiting orders say why, and the turn that just ended was the last.
    if (check?.paused) {
      for (const w of a.queue.splice(0)) if (w.order) await sendResult({ home, hubKey: ctx.hubKey, hub: ctx.hub, auth: ctx.auth, request: req, log }, w.order, 'failed', { reason: ORDER_REASONS.team_paused, code: 'team_paused' });
      save(home, ctx.hubKey, d);
      log(`wake: ${a.label}: the team is paused; the turn ended and nothing more starts`);
      await report(ctx, agentId, a, 'ended');
      return;
    }
    if (unacted && run.tries < MAX_RETRIES && !seen.error) a.queue.unshift({ order: null, task: run.task, items: [{ notice: 'retry' }], tries: run.tries + 1 });
    else if (unacted) log(`wake: ${a.label}: the turn ended and task ${run.task} still waits on it; the hub's deadline flags it`);
    save(home, ctx.hubKey, d);
    await report(ctx, agentId, a, 'ended');
    await drain(ctx, agentId);
  }

  /** Starts the next waiting work of an agent, if it may run now. Reads the state itself. */
  async function drain(ctx, agentId) {
    const d = load(home, ctx.hubKey), a = d.agents[agentId];
    if (!a || a.run || !a.queue.length || !wakeEnabled(home, a.label)) return;
    const bind = folderOf(ctx, a.label);
    if (!bind) return;
    const until = pausedUntil(d, profileOf(home, bind.path));
    if (until) { await report(ctx, agentId, a, 'paused_usage', { resumes_at: until }); return; }
    // A person opened this agent's chat while the item waited behind a turn: a chat they have open is never taken over (connector.md, "The wake"). Every waiting item is held as chat_in_use: kept for the prompt hook and the screen, its order reported failed.
    if (runningAgents(home, ctx.hubKey).some((r) => r.agent_id === agentId)) {
      const held = a.queue.splice(0);
      save(home, ctx.hubKey, d);
      for (const w of held) {
        recordDelivery(home, ctx.hubKey, { payload: { agent_id: agentId, items: w.items?.length ? w.items : [{ notice: 'message' }] } });
        if (w.order) await sendResult({ home, hubKey: ctx.hubKey, hub: ctx.hub, auth: ctx.auth, request: req, log }, w.order, 'failed', { reason: ORDER_REASONS.chat_in_use, code: 'chat_in_use' });
      }
      log(`wake: ${a.label}: a chat is open, so ${held.length} waiting item${held.length === 1 ? '' : 's'} were held and no run started`);
      return;
    }
    const next = a.queue.shift();
    if (await startTurn(ctx, d, agentId, a, next)) {
      if (next.order) await sendResult({ home, hubKey: ctx.hubKey, hub: ctx.hub, auth: ctx.auth, request: req, log }, next.order, 'done', null);
    } else { a.queue.unshift(next); save(home, ctx.hubKey, d); }
  }

  /** Not delivered now: the item is kept for the local screen and the prompt hook (deliveries.mjs), and the order says why. */
  const held = (hubKey, order, code, reason) => { recordDelivery(home, hubKey, order); return { state: 'failed', code, reason }; };

  const api = {
    /**
     * A `deliver` order (reason item, team_start, resume, write_handout; a reset is reset.mjs's). Returns what the worker reports for it:
     * `{state: 'done'}` (a turn started, or the running turn takes the item as a notice), `{state: 'failed', code, reason}`, or
     * `{state: 'open'}` (the order stays open: it waits behind another task or a usage pause, and is reported when it starts), or
     * `{state: 'reported'}` (the wake already reported it).
     */
    async onDeliver(ctx, order, reasons) {
      hubs.set(ctx.hubKey, ctx);
      const p = order.payload, agentId = p.agent_id;
      const label = await labelOf(ctx, agentId, load(home, ctx.hubKey));
      const d = load(home, ctx.hubKey); // after the await
      // No label: the agent's key on this PC is not one the hub accepts (replaced or revoked), or it was never set up here. Say which.
      if (!label) return held(ctx.hubKey, order, 'agent_unknown', keyRefused.get(ctx.hubKey)?.size ? reasons.agent_key_refused : reasons.agent_unknown);
      if (!folderOf(ctx, label)) return held(ctx.hubKey, order, 'agent_unknown', reasons.agent_unknown);
      const a = agentOf(d, agentId, label);
      a.label = label;
      if (!wakeEnabled(home, label)) return held(ctx.hubKey, order, 'wake_held', reasons.wake_held);
      if (p.agent_msg) {
        if (!wakeSettings(home).agent_messages || now() - a.cap_at < WAKE_CAP_MS) return held(ctx.hubKey, order, 'wake_held', reasons.wake_held);
      }
      const task = p.items.find((i) => i.task)?.task ?? null;
      const reason = p.reason && p.reason !== 'item' ? p.reason : undefined;
      if (a.run && reason) {
        // A reason order is a turn of its own (one check-in, the handout, the resume): it waits for the running turn to end.
        a.queue.push({ order: order.id, task: null, items: [], reason, tries: 0 });
        save(home, ctx.hubKey, d);
        await report(ctx, agentId, a, 'waiting', { waiting_on: a.run.task ?? undefined });
        return { state: 'open' };
      }
      if (a.run) {
        // The running turn gets the item as the hub's inline notice; an item for another task waits behind it.
        if (!task || task === a.run.task || p.items.every((i) => !i.task || i.task === a.run.task)) return { state: 'done' };
        a.queue.push({ order: order.id, task, items: p.items, tries: 0 });
        save(home, ctx.hubKey, d);
        await report(ctx, agentId, a, 'waiting', { waiting_on: a.run.task ?? undefined });
        return { state: 'open' };
      }
      if (runningAgents(home, ctx.hubKey).some((r) => r.agent_id === agentId)) return held(ctx.hubKey, order, 'chat_in_use', reasons.chat_in_use);
      const bind = folderOf(ctx, label);
      const until = pausedUntil(d, profileOf(home, bind.path));
      a.queue.push({ order: order.id, task, items: p.items, ...(reason ? { reason } : {}), tries: 0 });
      if (p.agent_msg) a.cap_at = now();
      save(home, ctx.hubKey, d);
      if (until) { await report(ctx, agentId, a, 'paused_usage', { resumes_at: until }); return { state: 'open' }; }
      await drain(ctx, agentId);
      // drain reports the order done itself when the turn starts; otherwise it stays open and is tried again at the next check-in.
      return { state: load(home, ctx.hubKey).agents[agentId]?.run ? 'reported' : 'open' };
    },

    /** Each check-in: finds runs that ended (including ones this process did not start), heartbeats, resumes paused work. */
    async tick(ctx) {
      hubs.set(ctx.hubKey, ctx);
      for (const agentId of Object.keys(load(home, ctx.hubKey).agents)) {
        // Each agent is read fresh: what an earlier agent's finish or drain saved (or a delivery during its awaits) is on disk.
        const d = load(home, ctx.hubKey), a = d.agents[agentId];
        if (!a) continue;
        if (a.run) {
          const done = children.get(`${ctx.hubKey}|${agentId}`)?.pid === a.run.pid || !isAlive(a.run.pid);
          if (done) { await finish(ctx, agentId); continue; }
          try { a.run.activity = Math.max(a.run.began, statSync(a.run.out).mtimeMs); } catch { /* no output yet */ }
          save(home, ctx.hubKey, d);
          await report(ctx, agentId, a, 'running', {});
        } else if (a.queue.length) await drain(ctx, agentId);
      }
    },

    /** After a connector restart: a recorded run is taken up again only if the same process (id and start time) is still alive. */
    async adopt(ctx) {
      hubs.set(ctx.hubKey, ctx);
      const d = load(home, ctx.hubKey);
      for (const [agentId, a] of Object.entries(d.agents)) {
        if (!a.run) continue;
        const same = isAlive(a.run.pid) && Math.abs((startTime(a.run.pid) ?? 0) - a.run.started) < 2000;
        if (same) { broker?.launcherRuns.add(pathKey(a.run.folder)); log(`wake: ${a.label}: a running turn was taken up again`); await report(ctx, agentId, a, 'running'); } else children.set(`${ctx.hubKey}|${agentId}`, { pid: a.run.pid, code: 0 });
      }
    },

    /** The operator's Stop: ends the run (whole process tree) and records it as stopped; the session is kept. */
    async stop(ctx, agentId) {
      const d = load(home, ctx.hubKey), a = d.agents[agentId];
      if (!a?.run) return false;
      const run = a.run;
      kill(run.pid);
      children.delete(`${ctx.hubKey}|${agentId}`);
      broker?.launcherRuns.delete(pathKey(run.folder));
      if (run.task) a.sessions[run.task] ??= { id: run.session, at: now(), provider: run.provider };
      a.run = null;
      save(home, ctx.hubKey, d);
      log(`wake: ${a.label}: the run was stopped by the operator`);
      await report(ctx, agentId, a, 'stopped', { task: run.task });
      return true;
    },

    /** For tests and the local screen. */
    state: (hubKey) => load(home, hubKey),
    finishAll: () => finishing,
  };
  /**
   * The hub refused to renew a run's turn token (a pause, a lockdown or a suspended key): a run the wake started in that folder is
   * ended. Returns whether there was one; a chat opened by hand is not the wake's to stop.
   */
  api.stopFolder = async (folder, hubKey) => {
    const ctx = hubs.get(hubKey);
    if (!ctx) return false;
    for (const [agentId, a] of Object.entries(load(home, hubKey).agents)) if (a.run && pathKey(a.run.folder) === pathKey(folder)) return api.stop(ctx, agentId);
    return false;
  };
  return api;
}
