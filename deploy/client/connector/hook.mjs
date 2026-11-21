/**
 * The Claude Code hook (docs/connector.md, "The folder hook"): `conclave hook --folder <agent folder>`, run by Claude
 * Code when a prompt is submitted and when a session starts. It adds the one reminder line as context and nothing else.
 *
 * - It only ever adds context. It never prints a `decision`, a `continue` or a `stopReason`, so it can never block a prompt
 *   or hold a turn open; any other event (above all Stop, where printed context makes Claude Code continue the turn) gets
 *   no output at all.
 * - It has a short time limit and does nothing on any failure: a hub that is down, slow or refuses, a folder that is not
 *   registered, a key that is gone, or input it does not understand all end in no output and exit code 0.
 * - It runs only in a registered agent folder (the folder is resolved from the connector's own registry), and it is
 *   installed only there, in the folder's project settings (`entries.mjs`), never in the user's own settings.
 * - It tells the hub the lines it showed, so the console can say "Shown to the session (reported by the PC)".
 * - It holds no key: it asks the connector's broker (broker.mjs) for the line, and the broker does the signing in. It also
 *   tells the broker where the chat's transcript is, for the end-of-turn leak scan.
 */
import { resolveContext, signIn } from './context.mjs';
import { request } from './hubclient.mjs';
import { reminderLine } from './reminder.mjs';
import { HOOK_EVENTS, CONTEXT_HOOK_EVENTS } from './entries.mjs';
import { takeFor, waiting, deliveryLine } from './deliveries.mjs';
import { resolveFolder } from './registry.mjs';
import { hubKeyOf } from './keyfile.mjs';
import { agentIdOf } from './run.mjs';
import { recordChatContext } from './contextsize.mjs';
import { resetLine, takeResetNotice } from './reset.mjs';
import { askBroker } from './brokerclient.mjs';

export const HOOK_TIMEOUT_MS = 3500;

const auth = (ctx) => ({ Authorization: `Bearer ${ctx.appKey}` });

/** The hub's counts for the agent, or null. Never throws. */
export async function fetchCounts(ctx, agentId, timeoutMs) {
  try {
    const r = await request(ctx.hub, 'POST', '/connector/v1/messages/unread', { body: { agent_id: agentId }, headers: auth(ctx), timeoutMs });
    return r.status === 200 && r.json && typeof r.json === 'object' ? r.json : null;
  } catch { return null; }
}

/** Reports the highest message of each room as shown (the line named it). Never throws. */
export async function reportShown(ctx, agentId, rooms, timeoutMs) {
  const list = Array.isArray(rooms) ? rooms.slice(0, 20) : [];
  await Promise.all(list.map(async (r) => {
    if (typeof r?.room_id !== 'string' || !Number.isSafeInteger(r?.top_seq)) return;
    try { await request(ctx.hub, 'POST', '/connector/v1/messages/shown', { body: { agent_id: agentId, room_id: r.room_id, seq: r.top_seq }, headers: auth(ctx), timeoutMs }); } catch { /* the line was still shown */ }
  }));
}

/**
 * The reminder line for an agent folder, or null (nothing waits, the connector is not running, or any failure). `report` says
 * the line is about to be shown, so the PC reports it. Used by the hook, by `conclave reminder` and by the Codex server.
 * No key is loaded here: the connector's broker builds the line.
 */
export async function lineFor(home, folder, { timeoutMs = HOOK_TIMEOUT_MS, report = true } = {}) {
  const r = await askBroker(home, { op: 'reminder', folder, report, timeoutMs }, { timeoutMs: timeoutMs + 500 });
  return r.ok && typeof r.line === 'string' ? r.line : null;
}

/**
 * What the unread line was last shown for, per hub and agent, in the connector's own process: shown again only when it differs. It compares the
 * counts, each room's top_seq and the directive count, not the line's text: new messages from the same sender give the same text.
 */
const lastShown = new Map();
/** The state the line stands for: totals, each room's top_seq (a new message raises it) and the directive count. */
export const unreadState = (c) => JSON.stringify([c?.total ?? 0, c?.directives ?? 0, (Array.isArray(c?.rooms) ? c.rooms : []).map((r) => [String(r?.room_id), r?.top_seq ?? 0]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)), (Array.isArray(c?.senders) ? c.senders : []).map((g) => [g?.from, g?.label ?? null, g?.count ?? 0])]);
/** Forgets what was shown (tests, and a connector that restarts starts empty anyway). */
export function forgetShown() { lastShown.clear(); }

/** The same line, built in the connector's own process (the broker's side of `lineFor`): the only place this loads a key. */
export async function lineForLocal(home, folder, { timeoutMs = HOOK_TIMEOUT_MS, report = true } = {}) {
  try {
    const ctx = resolveContext(home, folder);
    if (!ctx.ok) return null;
    const s = await signIn(home, ctx);
    if (!s.ok || !s.agentId) return null;
    const counts = await fetchCounts(ctx, s.agentId, timeoutMs);
    let line = reminderLine(counts);
    // The unread line shows when what waits changes, not at every prompt: the same state again says nothing new (docs/connector.md).
    if (report) {
      const key = ctx.hubKey + '|' + s.agentId, state = unreadState(counts);
      if (!line) lastShown.delete(key);
      else if (lastShown.get(key) === state) line = null;
      else lastShown.set(key, state);
    }
    if (line && report && counts.total > 0) await reportShown(ctx, s.agentId, counts.rooms, timeoutMs);
    // Items the hub delivered to this PC for the agent (a delivery order, until the wake ships here): shown once, at the agent's next prompt.
    const items = report ? takeFor(home, ctx.hubKey, s.agentId) : (waiting(home, ctx.hubKey)[s.agentId] ?? []);
    const dl = deliveryLine(items);
    // A reset asked for this agent: in a chat a person opened, the agent records its progress first (spec review step 3, change 10).
    const rl = report && takeResetNotice(home, ctx.hubKey, s.agentId) ? resetLine() : null;
    return [rl, dl, line].filter(Boolean).join('\n') || null;
  } catch { return null; }
}

/**
 * The silent context hook (`conclave context-hook --folder <agent folder>`, design 3c and 3g): at Stop and PostToolUse
 * in a hand-opened chat it reads the transcript Claude Code names and keeps the numbers for the next check-in. It prints
 * nothing, sends nothing and never signs in, whatever happens (proof 1: a Stop hook that prints loops the turn): the
 * caller writes nothing to stdout. PostToolUse reads at most once a minute; Stop always reads. Resolves `{state}` for tests.
 */
export async function runContextHook(home, folder, stdin, { env = process.env, now = Date.now() } = {}) {
  try {
    let input; try { input = JSON.parse(stdin); } catch { return { state: 'skipped' }; }
    const event = input?.hook_event_name;
    if (!CONTEXT_HOOK_EVENTS.includes(event)) return { state: 'skipped' };
    const r = resolveFolder(home, folder);
    if (!r.ok) return { state: 'skipped' };
    const hubKey = hubKeyOf(r.binding.hub_id, r.binding.ca_sha256);
    return recordChatContext(home, { hubKey, label: r.binding.agent, folder: r.folder, sessionId: input.session_id, transcript: input.transcript_path, agentId: agentIdOf(home, hubKey, r.binding.agent), force: event === 'Stop', now, env });
  } catch { return { state: 'skipped' }; }
}

/**
 * What the hook prints for the hook input `stdin` (Claude Code's JSON), or null for no output. Resolves within
 * `timeoutMs` whatever the hub does.
 */
export async function runHook(home, folder, stdin, { timeoutMs = HOOK_TIMEOUT_MS } = {}) {
  let event = null, transcript = null;
  try { const j = JSON.parse(stdin); event = j?.hook_event_name ?? null; transcript = typeof j?.transcript_path === 'string' ? j.transcript_path : null; } catch { return null; }
  if (!HOOK_EVENTS.includes(event)) return null; // Stop and every other event: no output, ever
  if (transcript) void askBroker(home, { op: 'transcript', folder, path: transcript }, { timeoutMs: 1500 });
  let timer;
  const line = await Promise.race([
    lineFor(home, folder, { timeoutMs }),
    new Promise((res) => { timer = setTimeout(() => res(null), timeoutMs); }),
  ]);
  clearTimeout(timer);
  return line ? JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: line } }) : null;
}
