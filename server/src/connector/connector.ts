/**
 * The hub's side of the Conclave connector (docs/connector.md, "Hub route contract"): the connector's check-in, PC status,
 * the setup timeline, PC actions (stored orders the connector fetches), Disconnect's states and receipt credential,
 * connector versions, the messages a PC reports shown, and usage. A value no connector has reported is null (Unknown).
 * Nothing here runs on a PC: an order waits until the connector fetches it.
 */
import type { Db } from '../db/db.js';
import { tx } from '../db/db.js';
import type { Audit, Actor } from '../audit/audit.js';
import { hmacHex, randomToken, safeEqualHex, sha256Hex } from '../util/crypto.js';
import { KeyError } from '../keys/keys.js';
import type { Keys } from '../keys/keys.js';
import type { LeakGuard } from '../guard/leakGuard.js';
import type { Handovers } from '../keys/handover.js';
import { scrub } from '../audit/scrub.js';
import { Streams } from './stream.js';

export const ONLINE_MS = 90_000;
/** A fetched order with no result this long after it was fetched expires, so it never blocks its kind for good. */
export const FETCHED_TTL_MS = 24 * 60 * 60_000;
export const ORDER_TTL_MS = 24 * 3600_000;
export const DISCONNECT_TTL_MS = 7 * 86400_000;
export const VERSION_RE = /^\d+\.\d+\.\d+(-[a-z0-9.]+)?$/;
const RECEIPT_RE = /^ah_dsc_([a-z2-7]{12})_([a-z2-7]{32})$/;
export const CLIENTS = ['claude_code', 'claude_desktop', 'codex'] as const;
/** What a PC may report about its own agents; Waiting for approval and Ready to open are the hub's states. */
export const PC_REPORTED = ['open', 'repair_connection', 'chat_in_use'] as const;

/** What the console shows of the account profile a PC reported for a running agent: its name, that it is hidden, or nothing. */
export type PcProfile = { name: string } | { hidden: true } | null;
export const pcProfileOf = (a: { profile?: unknown; profile_hidden?: unknown } | undefined): PcProfile =>
  typeof a?.profile === 'string' && a.profile ? { name: a.profile } : a?.profile_hidden === true ? { hidden: true } : null;
/** At most this many versions wait for approval because PCs reported them. */
export const MAX_PENDING_REPORTED = 5;
export const ACTION_KINDS = ['check', 'restore', 'update'] as const;
/**
 * Notices that need a turn of their agent: only these make a delivery order. Everything else is shown at the next turn and
 * starts none: a directive change, a pause, a question asked or answered that the coordinator only hears about
 * (`decision_asked`, `decision_update`), a task waiting for the administrator's approval (`task_awaiting_approval`), and a
 * resume for a member with no live task (`team_resumed_note`).
 */
export const TURN_NOTICES = new Set(['task_assigned', 'changes_requested', 'review_requested', 'decision', 'task_accepted', 'team_resumed', 'plan_request', 'task_approved', 'task_blocked']);
/** A fetched order is handed out again when its last hand-out is this old and no result has come. */
export const REHAND_MS = 2 * 60_000;
/** What a delivery order's result may say when no turn started. */
export const WAKE_QUIET_MS = 30 * 60_000;
export const WAKE_STATES = ['running', 'waiting', 'paused_usage', 'needs_approval', 'ended', 'stopped'] as const;
/** The states of a run that still lives, which Stop can end. */
const WAKE_LIVE: readonly string[] = ['running', 'waiting', 'paused_usage', 'needs_approval'];
export const DELIVER_REASONS = ['pc_offline', 'chat_in_use', 'wake_held', 'agent_unknown'] as const;
/**
 * The oldest connector that takes each order kind the hub added after 0.9.3 (docs/connector.md, "Delivery orders"). A PC whose
 * reported version is older is never handed such an order: it waits on the hub, and its items read "connector too old".
 */
export const ORDER_MIN_VERSION: Record<string, string> = { deliver: '0.9.4' };
/** A turn token issued this recently is not counted as a second binding yet: `conclave check --probe` issues one and revokes it at once. */
export const PROBE_GRACE_MS = 60_000;
/** Why a delivery order was sent (spec review step 3, change 16): a fixed list, never free text. None stored means item. */
export const DELIVER_ORDER_REASONS = ['item', 'team_start', 'write_handout', 'resume', 'reset'] as const;
/** What a reset's result may say: a hand-opened chat the connector cannot clear (the console then shows the person's steps). */
export const RESET_RESULT_CODES = ['reset_by_hand'] as const;
/** Context bar levels (design 3c): amber from 60 %, red from 85 %. */
export const CONTEXT_AMBER = 60, CONTEXT_RED = 85;
/** Numbers older than this read as stale in the console (a PC that stopped reporting). */
export const CONTEXT_STALE_MS = 15 * 60_000;
/** One agent's context as a PC reports it on the check-in: numbers and a model id only. */
export interface ContextReport {
  agent_id: string; source: 'connector' | 'chat'; client: string; model: string; context_tokens: number; window: number | null; percent?: number | null;
  turn_tokens: number; compacted_at: number | null; compacts: number; at: number | null;
}
/**
 * A `deliver` order that is not an item (docs/connector.md, "Reason orders"): its reason says what the turn is for, from a fixed
 * list and never free text, and it carries no items.
 */
export const ORDER_REASONS = ['team_start', 'write_handout', 'resume'] as const;
export type OrderReason = (typeof ORDER_REASONS)[number];
/** Notices that make a reason order instead of an item: a move's request asks each agent for its handout. */
const REASON_NOTICES: Record<string, OrderReason> = { checkout_requested: 'write_handout' };
/** At most one order per agent per this long from messages that agents wrote (they are L2; the operator's messages are never held back). */
export const AGENT_MESSAGE_GAP_MS = 10 * 60_000;
const DELIVER_ITEMS_MAX = 20;
const OPEN_STATES = ['queued', 'fetched'];
const DISCONNECT_OPEN = ['access_revoked', 'cleanup_pending'];
/** A disconnect order still open: no result, not expired into Needs attention, not ended by Re-enrol PC. */
const DSC_OPEN_SQL = "kind='disconnect' AND state IN ('access_revoked','cleanup_pending') AND finished_at IS NULL AND ended_at IS NULL";

/** The most folder rows one PC holds, proposed or decided: an agent's folder count, with room to spare. */
const MAX_PC_FOLDERS = 500;
/** Why a path cannot be an agent's folder, or null: one absolute path (a drive path or a POSIX one), normalised, at least two folders deep. */
export function folderRefusal(p: unknown): string | null {
  if (typeof p !== 'string' || p === '' || p.length > 500) return 'bad_path';
  if (/[\u0000-\u001f\u007f]/.test(p)) return 'bad_path';
  const win = /^[A-Za-z]:[\\/]/.test(p);
  if (!win && !p.startsWith('/')) return 'not_absolute';
  const parts = (win ? p.slice(3) : p.slice(1)).split(win ? /[\\/]/ : '/');
  if (parts.some((s) => s === '' || s === '.' || s === '..')) return 'not_normalised';
  return parts.length < 2 ? 'too_wide' : null;
}
export const DISCONNECT_REMOVES =["This hub's worker and transfers, stopped first", "This hub's keys on the PC", "This hub's folder registrations", "The connector's files for this hub"];
export const DISCONNECT_KEEPS = ['Repositories and worktrees', 'Chat history', "The PC user's own settings", 'Other hubs on the PC'];

/** List prices per million tokens, by model, as the hub's config sets them; none set: every cost is Unknown. */
export interface ModelPrice { input: number; output: number; cache_read?: number; cache_write?: number }

export interface CheckIn {
  version: string; platform?: string | null; node?: string | null; git?: string | null;
  clients?: { client: (typeof CLIENTS)[number]; version: string | null }[];
  auto_update?: boolean | null; remote_cleanup?: boolean | null; remove_connector_with_last_hub?: boolean | null; usage_opt_in?: boolean | null;
  /** Measuring on a compute machine (`conclave hardware on|off`, docs/hardware.md#measuring). */
  hardware_opt_in?: boolean | null;
  /**
   * `profile` is the PC user's local account-profile name of a run the connector started on that profile (never a login);
   * `profile_hidden` says such a run uses a profile whose name the PC user hid. Both absent for a chat opened by hand.
   */
  /** How the PC protects its keys: 'standard' (a key file encrypted at rest, no admin) or 'hardened' (a key service under its own account), and where the file's key is held. */
  isolation?: (typeof ISOLATION)[number] | null; key_store?: (typeof KEY_STORES)[number] | null;
  agents?: { agent_id: string; state: (typeof PC_REPORTED)[number]; profile?: string; profile_hidden?: true }[];
  /** Restore destinations the PC's user approved on the PC: an id and a label, never a path. */
  destinations?: { id: string; label: string }[];
  /** True while the PC still holds pieces of the old setup (rollback copies, the old CA setting). A flag only: no path, no name. */
  legacy_leftovers?: boolean | null;
  /** Which kinds: fixed words, in `LEFTOVER_KIND_WORDS`. */
  legacy_leftover_kinds?: string[] | null;
  /** How full each agent's context is (design 3c), sent only while the PC's user opted in to usage reports. */
  context?: ContextReport[];
}
export const ISOLATION = ['standard', 'hardened'] as const;
export const LEFTOVER_KIND_WORDS = ['unfinished_move', 'ca_setting', 'old_keys', 'bridge_pieces'] as const;
export const KEY_STORES = ['dpapi', 'keychain', 'secret_service', 'file', 'service'] as const;
export const DESTINATION_RE = /^dst_[a-z0-9]{6,32}$/;
interface ReportRow {
  machine_id: string; version: string | null; platform: string | null; node: string | null; git: string | null; clients: string;
  auto_update: number | null; remote_cleanup: number | null; remove_with_last_hub: number | null; usage_opt_in: number | null; hardware_opt_in: number | null;
  agents: string; destinations: string | null; isolation: string | null; key_store: string | null; legacy_leftovers: number | null; legacy_leftover_kinds: string | null; first_check_in_at: number; last_check_in_at: number;
}
interface ActionRow {
  id: string; machine_id: string; kind: string; state: string; payload: string; result: string | null; created_at: number; created_by: string | null;
  agent_id: string | null; order_reason: string | null; release_at: number | null; handed_at: number | null;
  fetched_at: number | null; finished_at: number | null; expires_at: number; receipt_key_id: string | null; receipt_verifier: string | null; ended_at: number | null;
}
export interface UsageRow { agent_id: string; client: string; model: string; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; sessions: number; turns?: number | null }

const bool = (v: number | null) => (v === null ? null : v === 1);
const toInt = (v: boolean | null | undefined) => (v === undefined || v === null ? null : v ? 1 : 0);
const parse = <T>(s: string | null, d: T): T => { if (s === null) return d; try { return JSON.parse(s) as T; } catch { return d; } };
const cmpVersion = (a: string, b: string) => {
  const pa = a.split('-')[0]!.split('.').map(Number), pb = b.split('-')[0]!.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  return a.includes('-') === b.includes('-') ? a.localeCompare(b) : a.includes('-') ? -1 : 1; // a pre-release sorts below its release
};
const fail = (code: string, msg: string) => new KeyError(code, msg);
const who = (a: Actor) => (a.kind === 'admin' ? `operator:${a.id}` : a.kind);
const scrubDeep = (v: unknown): unknown => (typeof v === 'string' ? scrub(v) : Array.isArray(v) ? v.map(scrubDeep)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubDeep(x)])) : v);

export class Connector {
  /** Text from the PC is L2: a key shape is refused (and alerted), other secrets are redacted (docs/connector.md). */
  guard: LeakGuard | null = null;
  /** Key handovers (keys/handover.ts): the check-in says how many wait for the app key it came with. */
  handovers: Handovers | null = null;
  /** The push stream and the long poll (docs/connector.md, "The push stream"). */
  readonly streams: Streams;
  constructor(private db: Db, private keys: Keys, private audit: Audit, private pepper: string, private prices: Record<string, ModelPrice> = {}, private now: () => number = Date.now) {
    this.streams = new Streams(now);
    // A second stream from another installation or address may be a copied app key pushing the real connector off: the console alerts.
    this.streams.onReplaced = (pc, was, to) => this.audit.alert('warning', 'connector_stream_replaced', pc, { pc, was, now: to });
  }

  private pcText<T>(machineId: string, v: T): T {
    if (this.guard?.scan(v)) {
      this.audit.alert('warning', 'connector_key_in_report', machineId, { pc: machineId });
      throw fail('contains_key', 'What the PC reported contains a Conclave key; it was refused.');
    }
    return scrubDeep(v) as T;
  }
  /** Agents whose session key is bound to this PC: the only ones it may report on. */
  private ownAgents(machineId: string): Set<string> {
    return new Set((this.db.prepare("SELECT DISTINCT agent_id FROM credentials WHERE kind='session_key' AND bound_machine_id=? AND status<>'revoked' AND agent_id IS NOT NULL").all(machineId) as { agent_id: string }[]).map((r) => r.agent_id));
  }

  /** A compute machine's connector is measure-only (docs/hardware.md#measuring): check-in, samples, Update and Disconnect. */
  /**
   * The account profile of an agent's running relay, from the newest check-in that reports the agent: its name, `{hidden}`
   * when the PC user hid the name, or null (not running, or a chat opened by hand). The agent page shows it under State.
   */
  agentProfile(agentId: string): PcProfile {
    const row = this.db.prepare(`SELECT j.value v FROM connector_reports r, json_each(CASE WHEN json_valid(r.agents) THEN r.agents ELSE '[]' END) j
      WHERE json_extract(j.value, '$.agent_id')=? ORDER BY r.last_check_in_at DESC LIMIT 1`).get(agentId) as { v: string } | undefined;
    return row ? pcProfileOf(parse(row.v, {} as { profile?: string; profile_hidden?: true })) : null;
  }

  /** Whether this PC's connector reported a version older than the one an order kind needs (ORDER_MIN_VERSION). A PC that never reported is not. */
  tooOld(machineId: string, kind: string): boolean {
    const min = ORDER_MIN_VERSION[kind];
    if (!min) return false;
    const v = (this.db.prepare('SELECT version FROM connector_reports WHERE machine_id=?').get(machineId) as { version: string | null } | undefined)?.version ?? null;
    return v !== null && cmpVersion(v, min) < 0;
  }
  private tooOldFail(machineId: string) {
    const v = (this.db.prepare('SELECT version FROM connector_reports WHERE machine_id=?').get(machineId) as { version: string }).version;
    return fail('invalid_state', `This PC runs connector ${v}, which is too old for this order. Update the connector to ${ORDER_MIN_VERSION.deliver} or newer first.`);
  }

  measureOnly(machineId: string): boolean { return !!this.db.prepare('SELECT 1 FROM hw_machines WHERE machine_id=?').get(machineId); }

  // ───── the connector's report ─────
  checkIn(machineId: string, report: CheckIn, appCredentialId: string | null = null): { ok: true; orders: number; ignored_agents: number; handovers: number; measure_only?: true } {
    const r = this.pcText(machineId, report); // every string from the PC passes the leak guard
    const now = this.now(), own = this.ownAgents(machineId);
    const agents = (r.agents ?? []).filter((a) => own.has(a.agent_id));
    tx(this.db, () => {
      const had = this.db.prepare('SELECT 1 FROM connector_reports WHERE machine_id=?').get(machineId);
      const vals = [r.version, r.platform ?? null, r.node ?? null, r.git ?? null, JSON.stringify(r.clients ?? []), toInt(r.auto_update), toInt(r.remote_cleanup),
        toInt(r.remove_connector_with_last_hub), toInt(r.usage_opt_in), toInt(r.hardware_opt_in), JSON.stringify(agents), r.destinations === undefined ? null : JSON.stringify(r.destinations), r.isolation ?? null, r.key_store ?? null, toInt(r.legacy_leftovers)];
      // The app key it checked in with is the one a key handover for this PC is bound to (a bridge key leaves it as it was).
      if (had) this.db.prepare('UPDATE connector_reports SET version=?,platform=?,node=?,git=?,clients=?,auto_update=?,remote_cleanup=?,remove_with_last_hub=?,usage_opt_in=?,hardware_opt_in=?,agents=?,destinations=?,isolation=?,key_store=?,legacy_leftovers=?,last_check_in_at=?,app_credential_id=COALESCE(?, app_credential_id) WHERE machine_id=?').run(...vals, now, appCredentialId, machineId);
      else this.db.prepare('INSERT INTO connector_reports(version,platform,node,git,clients,auto_update,remote_cleanup,remove_with_last_hub,usage_opt_in,hardware_opt_in,agents,destinations,isolation,key_store,legacy_leftovers,first_check_in_at,last_check_in_at,app_credential_id,machine_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...vals, now, now, appCredentialId, machineId);
      this.db.prepare('UPDATE connector_reports SET legacy_leftover_kinds=? WHERE machine_id=?').run(r.legacy_leftover_kinds === undefined || r.legacy_leftover_kinds === null ? null : JSON.stringify(r.legacy_leftover_kinds), machineId);
      if (this.noteReported(r.version, machineId)) this.audit.alert('info', 'connector_version_pending', r.version, { version: r.version, pc: machineId });
      // Context numbers only under the usage opt-in, and only for this PC's own agents; with the opt-in off nothing is kept from this report.
      if (r.usage_opt_in === true) for (const c of (r.context ?? []).filter((x) => own.has(x.agent_id))) this.putContext(machineId, c, now);
    });
    // The hub learns a destination only here, after the checkout was rendered: a rendered checkout waiting for this PC starts its restore now.
    if (r.destinations?.length) {
      const waiting = this.db.prepare("SELECT id FROM checkouts WHERE status='rendered' AND target_machine_id=?").all(machineId) as { id: string }[];
      for (const c of waiting) { try { this.restoreIfOneDestination(c.id, { kind: 'system', id: null }); } catch { /* the operator's Restore button stays */ } }
    }
    const orders = this.isLocked(machineId) ? 0 : (this.db.prepare(`SELECT COUNT(*) n FROM pc_actions WHERE machine_id=? AND ((state='queued' AND COALESCE(release_at,0)<=?) OR (state='fetched' AND kind<>'disconnect' AND COALESCE(handed_at, fetched_at, 0)<=?))${this.tooOld(machineId, 'deliver') ? " AND kind<>'deliver'" : ''}`).get(machineId, now, now - REHAND_MS) as { n: number }).n;
    const handovers = this.isLocked(machineId) ? 0 : this.handovers?.count(appCredentialId) ?? 0;
    return { ok: true, orders, ignored_agents: (r.agents ?? []).length - agents.length, handovers, ...(this.measureOnly(machineId) ? { measure_only: true as const } : {}) };
  }

  private putContext(machineId: string, c: ContextReport, now: number) {
    // The window is kept only when it holds the context: a window smaller than what is in it is a wrong table row, so Unknown.
    const window = c.window !== null && c.window > 0 && c.window >= c.context_tokens ? c.window : null;
    this.db.prepare(`INSERT INTO agent_context(agent_id,machine_id,source,client,model,context_tokens,window_tokens,turn_tokens,compacted_at,compacts,read_at,reported_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(agent_id) DO UPDATE SET machine_id=excluded.machine_id, source=excluded.source, client=excluded.client, model=excluded.model, context_tokens=excluded.context_tokens,
      window_tokens=excluded.window_tokens, turn_tokens=excluded.turn_tokens, compacted_at=excluded.compacted_at, compacts=excluded.compacts, read_at=excluded.read_at, reported_at=excluded.reported_at`)
      .run(c.agent_id, machineId, c.source, c.client, c.model, c.context_tokens, window, c.turn_tokens, c.compacted_at, c.compacts, c.at, now);
  }

  /**
   * How full an agent's context is, for the console (design 3c): `{shared: false, why}` when there is nothing to show
   * (`no_pc`: no PC holds its key; `not_shared`: the PC's user has usage reports off, "Not shared by this PC";
   * `not_reported`: nothing reported yet), else the numbers with the percent and the bar's level worked out here.
   * `hand_opened` is true for a chat a person opened (the connector cannot reset it; the console shows the steps).
   */
  contextOf(agentId: string) {
    const pc = this.pcOfAgent(agentId);
    const row = this.db.prepare('SELECT * FROM agent_context WHERE agent_id=?').get(agentId) as { machine_id: string; source: string; client: string; model: string; context_tokens: number; window_tokens: number | null; turn_tokens: number; compacted_at: number | null; compacts: number; read_at: number | null; reported_at: number } | undefined;
    const machine = pc ?? row?.machine_id ?? null;
    const reset = this.lastReset(agentId);
    if (!machine) return { shared: false as const, why: 'no_pc' as const, reset };
    if (this.status(machine).usage_opt_in !== true) return { shared: false as const, why: 'not_shared' as const, reset };
    if (!row || row.machine_id !== machine) return { shared: false as const, why: 'not_reported' as const, reset };
    const percent = row.window_tokens ? Math.round((row.context_tokens / row.window_tokens) * 100) : null;
    return {
      shared: true as const, source: row.source, hand_opened: row.source === 'chat', client: row.client, model: row.model,
      context_tokens: row.context_tokens, window: row.window_tokens, percent,
      level: percent === null ? null : percent >= CONTEXT_RED ? 'red' as const : percent >= CONTEXT_AMBER ? 'amber' as const : 'ok' as const,
      turn_tokens: row.turn_tokens, compacted_at: row.compacted_at, compacts: row.compacts, read_at: row.read_at, reported_at: row.reported_at,
      stale: this.now() - row.reported_at > CONTEXT_STALE_MS, reset,
    };
  }
  /** Context for several agents at once (team and task views), by agent id. */
  contextOfMany(agentIds: string[]) { return Object.fromEntries([...new Set(agentIds)].slice(0, 200).map((id) => [id, this.contextOf(id)])); }

  /** The latest reset asked for an agent: when, its state, and whether the PC answered that a person must clear the chat. */
  private lastReset(agentId: string) {
    const a = this.db.prepare("SELECT id, state, result, created_at, finished_at FROM pc_actions WHERE kind='deliver' AND agent_id=? AND order_reason='reset' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(agentId) as { id: string; state: string; result: string | null; created_at: number; finished_at: number | null } | undefined;
    if (!a) return null;
    const code = parse(a.result, {} as { code?: string } | null)?.code ?? null;
    return { order: a.id, state: a.state, asked_at: a.created_at, finished_at: a.finished_at, by_hand: code === 'reset_by_hand' };
  }

  /**
   * Reset (design 3c): a `deliver` order with reason "reset" to the agent's PC. A session the connector started closes when its
   * current turn ends and the next item starts fresh; a chat a person opened is answered "reset_by_hand" and the console shows
   * the steps. A reset never folds into an item order, and a second one while the first is queued is the same order.
   * Who may ask is checked by the caller (the operator any agent; a coordinator its own team's, in Teams). Audited.
   * With no PC holding the agent's key there is no session the hub can reach: the answer is `by_hand` with no order,
   * and the console shows the person's steps (/clear, or a new session).
   */
  resetAgent(agentId: string, actor: Actor): { order: string | null; already: boolean; by_hand: boolean } {
    const pc = this.pcOfAgent(agentId);
    if (!pc) {
      this.audit.event(actor, 'agent.reset', { kind: 'agent', id: agentId }, { action: null, by_hand: true });
      return { order: null, already: false, by_hand: true };
    }
    if (this.keys.machine(pc)?.status !== 'active' || this.disconnected(pc)) throw fail('invalid_state', "This agent's PC is suspended or disconnected, so the reset cannot reach it.");
    if (this.measureOnly(pc)) throw fail('invalid_state', "This agent's PC is a compute machine; it runs no sessions.");
    if (this.tooOld(pc, 'deliver')) throw this.tooOldFail(pc);
    const now = this.now();
    const r = tx(this.db, () => {
      const open = this.db.prepare("SELECT id FROM pc_actions WHERE machine_id=? AND kind='deliver' AND state='queued' AND agent_id=? AND order_reason='reset'").get(pc, agentId) as { id: string } | undefined;
      if (open) return { order: open.id, already: true, by_hand: false };
      const id = `pca_${randomToken(10)}`;
      this.db.prepare("INSERT INTO pc_actions(id,machine_id,kind,state,payload,created_at,created_by,expires_at,agent_id,order_reason) VALUES (?,?,'deliver','queued',?,?,?,?,?,'reset')")
        .run(id, pc, JSON.stringify({ agent_id: agentId, reason: 'reset', items: [] }), now, who(actor), now + ORDER_TTL_MS, agentId);
      return { order: id, already: false, by_hand: false };
    });
    if (!r.already) {
      this.streams.signal(pc);
      this.audit.event(actor, 'agent.reset', { kind: 'agent', id: agentId }, { action: r.order, pc });
    }
    return r;
  }

  // ───── turn tokens (docs/connector.md, "Isolation levels") ─────
  /**
   * A turn token for one agent's run on this PC, asked for by the connector with the agent's session key. The token covers that agent's tools
   * only (no keys, no access, no new token) and lives 15 minutes unless the connector renews it. Every issue is audited. Two live
   * bindings are looked for at the renewal (renewTurn), not here: a probe's token is issued and revoked at once and never renewed.
   */
  issueTurn(machineId: string, sessionKey: string, runRef: string): { token: string; agent_id: string; label: string | null; expires_at: number } {
    const app = this.keys.machineAppCredential(machineId);
    if (!app) throw fail('forbidden', 'This PC has no active app key.');
    const { token, credential } = this.keys.login(app, sessionKey, { turn: { runRef } });
    this.audit.event({ kind: 'system', id: null }, 'connector.turn_token', { kind: 'agent', id: credential.agent_id! }, { pc: machineId, run: runRef });
    return { token, agent_id: credential.agent_id!, label: this.keys.agent(credential.agent_id!)?.label ?? null, expires_at: Date.now() + 15 * 60_000 };
  }
  /** Set in app.ts: why an agent's run may not keep its turn token (its team is paused, or a lockdown holds it or its PC), or null. */
  turnHold: ((agentId: string, machineId: string) => { code: 'paused' | 'lockdown'; message: string } | null) | null = null;
  /**
   * Renews a run's turn token for another 15 minutes. A paused team, or a lockdown of the agent or its PC, refuses the renewal and
   * ends the token at once (docs/connector.md, "Nothing is capped by length"): the connector then ends the run after its current call.
   */
  renewTurn(machineId: string, token: string) {
    const app = this.keys.machineAppCredential(machineId);
    if (!app) throw fail('forbidden', 'This PC has no active app key.');
    const agentId = this.keys.turnAgent(app, token);
    const hold = agentId ? this.turnHold?.(agentId, machineId) ?? null : null;
    if (hold) {
      if (this.keys.revokeTurn(app, token, hold.code)) this.audit.event({ kind: 'system', id: null }, 'connector.turn_token_end', { kind: 'agent', id: agentId! }, { pc: machineId, reason: hold.code });
      throw fail(hold.code, hold.message);
    }
    const renewed = this.keys.renewTurn(app, token);
    this.twoBindings(machineId, app, token);
    return renewed;
  }
  /**
   * Two live bindings (docs/connector.md, "Both levels"): a renewed run's token while a token of another run of the same agent is live
   * and older than PROBE_GRACE_MS. One alert per agent, and each pair of runs joins it once (as a short hash, never a run id), so a
   * renewal every 5 minutes does not repeat it.
   */
  private twoBindings(machineId: string, app: NonNullable<ReturnType<Keys['machineAppCredential']>>, token: string) {
    const me = this.keys.turnInfo(app, token);
    if (!me?.agent) return;
    for (const other of this.keys.otherLiveRuns(me.agent, me.run, this.now() - PROBE_GRACE_MS)) {
      const pair = sha256Hex([me.run ?? '', other].sort().join('|')).slice(0, 16);
      const known = this.db.prepare("SELECT 1 FROM security_alerts s, json_each(s.details, '$.pairs') j WHERE s.type='agent_two_live_bindings' AND s.subject=? AND j.value=?").get(me.agent, pair);
      if (!known) this.audit.digest('warning', 'agent_two_live_bindings', me.agent, { agent: me.agent, pc: machineId }, 'pairs', [pair]);
    }
  }
  revokeTurn(machineId: string, token: string, reason: 'turn_ended' | 'leak_found' = 'turn_ended') {
    const app = this.keys.machineAppCredential(machineId);
    if (!app) throw fail('forbidden', 'This PC has no active app key.');
    const t = reason === 'leak_found' ? this.keys.turnInfo(app, token) : null; // read before the revoke: was it still live?
    const ended = this.keys.revokeTurn(app, token, reason);
    if (ended) this.audit.event({ kind: 'system', id: null }, 'connector.turn_token_end', { kind: 'pc', id: machineId }, { reason });
    // A leak is reported whatever the token's state: one that expired or was already ended still had a key in its transcript.
    if (reason === 'leak_found') {
      this.audit.alert('critical', 'key_in_transcript', machineId, { pc: machineId, ...(t?.agent ? { agent: t.agent } : {}), turn: t?.live ? 'ended_now' : t ? 'ended_before' : 'unknown',
        note: 'A long-lived key was found in a session transcript at the end of a turn. Rotate the key of that agent.' });
    }
    return { ended };
  }

  /** The audit entry for each agent folder of this PC that the connector allowed at the upgrade without a click. Agents that are not this PC's are ignored. */
  foldersGrandfathered(machineId: string, agentIds: string[]) {
    const own = this.ownAgents(machineId);
    // The connector knows an agent by its label on this PC (its registry has no hub id), so a name matches an id or, when only one agent of this PC has it, a label.
    const rows = this.db.prepare('SELECT id, label FROM agents WHERE id IN (' + [...own].map(() => '?').join(',') + ')').all(...own) as { id: string; label: string }[];
    const resolve = (n: string) => (own.has(n) ? n : rows.filter((r) => r.label === n).length === 1 ? rows.find((r) => r.label === n)!.id : null);
    const ok = [...new Set(agentIds.map(resolve).filter((a): a is string => a !== null))];
    for (const a of ok) this.audit.event({ kind: 'system', id: null }, 'connector.folder_grandfathered', { kind: 'agent', id: a }, { pc: machineId });
    return { audited: ok.length };
  }

  /**
   * The folders the connector registered for this PC's agents (docs/connector.md, "Folders"): each becomes a proposed `machine_folders`
   * row, the same row and the same operator approval as setup_pc's, so a transfer into the PC still needs an approved one. A path is
   * refused when it names no agent of this PC (by id, then label, then folder slug, among the agents whose session key is bound to it), is not one absolute path,
   * or is a root or a top-level folder: an agent's folder is never that wide. A row that exists is left as it is (an approved or a
   * rejected one keeps its decision), and a PC holds at most MAX_PC_FOLDERS rows.
   */
  proposeFolders(machineId: string, entries: { agent: string; agent_id?: string; path: string }[]) {
    const own = this.ownAgents(machineId);
    const rows: { id: string; label: string }[] = [];
    for (const id of own) { const a = this.db.prepare('SELECT label FROM agents WHERE id=?').get(id) as { label: string } | undefined; if (a) rows.push({ id, label: a.label }); }
    // The agent id is exact. The connector's name for an agent is its folder slug (the label lower-cased, with dashes), so a name also matches a label or, when only one agent of this PC has it, a slug.
    const slugOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const isOwn = (e: { agent: string; agent_id?: string }) => (e.agent_id !== undefined && own.has(e.agent_id)) || rows.some((r) => r.label === e.agent) || rows.filter((r) => slugOf(r.label) === e.agent).length === 1;
    const now = this.now(), refused: { path: string; reason: string }[] = [];
    let proposed = 0, known = 0;
    tx(this.db, () => {
      for (const e of entries) {
        const why = !isOwn(e) ? 'unknown_agent' : folderRefusal(e.path);
        if (why) { refused.push({ path: e.path.slice(0, 200), reason: why }); continue; }
        if (this.db.prepare('SELECT 1 FROM machine_folders WHERE machine_id=? AND path=?').get(machineId, e.path)) { known++; continue; }
        const n = (this.db.prepare('SELECT COUNT(*) n FROM machine_folders WHERE machine_id=?').get(machineId) as { n: number }).n;
        if (n >= MAX_PC_FOLDERS) { refused.push({ path: e.path.slice(0, 200), reason: 'too_many_folders' }); continue; }
        this.db.prepare("INSERT INTO machine_folders(machine_id,path,status,proposed_at) VALUES (?,?,'proposed',?)").run(machineId, e.path, now);
        this.audit.event({ kind: 'system', id: null }, 'connector.folder_proposed', { kind: 'pc', id: machineId }, { path: e.path, agent: e.agent });
        proposed++;
      }
      if (refused.length) this.audit.event({ kind: 'system', id: null }, 'connector.folder_refused', { kind: 'pc', id: machineId }, { count: refused.length, reasons: [...new Set(refused.map((r) => r.reason))] });
    });
    return { proposed, known, refused: refused.slice(0, 20) };
  }

  /** The audit entry for each folder the connector built inside a pickup or restore the PC user allowed, and so allowed without a second click. Agents that are not this PC's are ignored. */
  foldersAllowedWithPickup(machineId: string, items: { agent_id: string; ref: string }[]) {
    const own = this.ownAgents(machineId);
    let audited = 0;
    for (const it of items) {
      if (!own.has(it.agent_id)) continue;
      this.audit.event({ kind: 'system', id: null }, 'connector.folder_allowed_with_pickup', { kind: 'agent', id: it.agent_id }, { pc: machineId, pickup: it.ref });
      audited++;
    }
    return { audited };
  }

  /**
   * What the PC's user denied on the connector's screen (docs/connector.md, "The connector's screen"): one audit entry for each, and a
   * warning alert when one agent is denied three times within an hour. A folder's chat is named by the agent's label on this PC (an id
   * also matches); a name that is not one of this PC's agents is counted only in the total. A pickup is named by its request id.
   */
  foldersDenied(machineId: string, items: { what: 'folder' | 'pickup'; agent?: string; request?: string }[]) {
    const rows = this.db.prepare("SELECT DISTINCT c.agent_id id, a.label label FROM credentials c JOIN agents a ON a.id=c.agent_id WHERE c.kind='session_key' AND c.bound_machine_id=? AND c.status<>'revoked'").all(machineId) as { id: string; label: string }[];
    let audited = 0;
    for (const it of items) {
      if (it.what === 'pickup') {
        this.audit.event({ kind: 'system', id: null }, 'connector.pickup_declined', { kind: 'pc', id: machineId }, { pc: machineId, request: it.request ?? null, note: 'Declined on this PC' });
        audited++;
        continue;
      }
      const name = it.agent ?? '';
      const own = rows.find((r) => r.id === name) ?? (rows.filter((r) => r.label === name).length === 1 ? rows.find((r) => r.label === name) : undefined);
      this.audit.event({ kind: 'system', id: null }, 'connector.folder_denied', own ? { kind: 'agent', id: own.id } : { kind: 'pc', id: machineId }, { pc: machineId, ...(own ? {} : { agent_name: name.slice(0, 100) }), note: 'Denied on this PC' });
      audited++;
      if (own) {
        const n = (this.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='connector.folder_denied' AND target_id=? AND created_at>?").get(own.id, Date.now() - 3600_000) as { n: number }).n;
        if (n >= 3) this.audit.alert('warning', 'connector_folder_denied_repeat', own.id, { pc: machineId, agent: own.id, denied_last_hour: n, note: 'The PC user denied this agent\'s chat again and again. Someone may be opening chats that claim this agent without being asked to.' });
      }
    }
    return { audited };

  }

  // ───── the wake (docs/connector.md, "The wake") ─────
  /** Set in app.ts: the task turns the hub keeps (who each task waits on), read-only, for the completion check. */
  turns: { held(agentId: string): { task_id: string; phase: string }[]; open(taskId: string): boolean; paused?(agentId: string): boolean } | null = null;
  /**
   * What the connector reports about a run it started for one of this PC's agents (docs/connector.md, "The wake"): its state, the task
   * and session, and when it last did anything. Numbers and fixed words only. One row per agent holds its latest run, and one run is one
   * clean record: it starts once (`started_at`, one `connector.wake_running` entry), a heartbeat changes nothing but the activity time,
   * and "waiting" is a field, not a state: an item for another task queued behind the run sets `waiting_on`, the run keeps its state,
   * start and task, and nothing is audited. A pause or a needed approval is audited once when it begins; a return to running within the
   * same run is not a new start. A report names its run (`run`; older connectors: its task and session): an end reported for an
   * earlier run never ends the run that followed it.
   */
  wakeReport(machineId: string, b: { agent_id: string; state: (typeof WAKE_STATES)[number]; run?: string; task?: string; session_id?: string; last_activity?: number; resumes_at?: number; waiting_on?: string }) {
    if (!this.ownAgents(machineId).has(b.agent_id)) throw fail('not_found', 'Agent not found on this PC');
    const now = this.now();
    const was = this.db.prepare('SELECT state, run_id, task_id, session_id, waiting_on, started_at FROM wake_runs WHERE agent_id=?').get(b.agent_id) as
      { state: string; run_id: string | null; task_id: string | null; session_id: string | null; waiting_on: string | null; started_at: number | null } | undefined;
    const r = this.pcText(machineId, b);
    const live = !!was && WAKE_LIVE.includes(was.state);
    // The same run: the same run id when both have one; otherwise the same task and, when both name one, the same session.
    const same = !!was && (r.run && was.run_id ? r.run === was.run_id
      : (r.task === undefined || r.task === was.task_id) && (r.session_id === undefined || was.session_id === null || r.session_id === was.session_id));
    // A late end of an earlier run (the hub already holds a newer one) is dropped.
    if (was && !same && (r.state === 'ended' || r.state === 'stopped' || r.state === 'needs_approval')) return { ok: true };
    const write = (row: { state: string; run: string | null; task: string | null; session: string | null; waiting_on: string | null; started_at: number | null }) =>
      this.db.prepare(`INSERT INTO wake_runs(agent_id,machine_id,state,run_id,task_id,session_id,waiting_on,started_at,last_activity_at,resumes_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(agent_id) DO UPDATE SET machine_id=excluded.machine_id,state=excluded.state,run_id=excluded.run_id,task_id=excluded.task_id,session_id=excluded.session_id,waiting_on=excluded.waiting_on,started_at=excluded.started_at,last_activity_at=excluded.last_activity_at,resumes_at=excluded.resumes_at,updated_at=excluded.updated_at`)
        .run(r.agent_id, machineId, row.state, row.run, row.task, row.session, row.waiting_on, row.started_at, r.last_activity ?? null, r.resumes_at ?? null, now);
    const ref = (task: string | null, session: string | null) => ({ pc: machineId, ...(task ? { task } : {}), ...(session ? { session } : {}) });
    if (r.state === 'waiting') {
      // An item queued behind the live run: the run keeps its state, task and start; only the field changes. No audit.
      if (live) { write({ state: was!.state, run: was!.run_id, task: was!.task_id, session: was!.session_id, waiting_on: r.waiting_on ?? was!.task_id, started_at: was!.started_at }); return { ok: true }; }
      write({ state: 'waiting', run: r.run ?? null, task: r.task ?? null, session: r.session_id ?? null, waiting_on: r.waiting_on ?? r.task ?? null, started_at: null });
      return { ok: true };
    }
    const fresh = !live || !same || was!.started_at === null;
    const startedAt = WAKE_LIVE.includes(r.state) ? (fresh ? now : was!.started_at) : was?.started_at ?? null;
    write({ state: r.state, run: r.run ?? (fresh ? null : was!.run_id), task: r.task ?? (fresh ? null : was!.task_id), session: r.session_id ?? (fresh ? null : was!.session_id),
      waiting_on: r.waiting_on ?? null, started_at: startedAt });
    const task = r.task ?? (fresh ? null : was!.task_id), session = r.session_id ?? (fresh ? null : was!.session_id);
    if ((WAKE_LIVE.includes(r.state) && fresh) || (r.state !== 'running' && was?.state !== r.state)) this.audit.event({ kind: 'system', id: null }, `connector.wake_${r.state}`, { kind: 'agent', id: r.agent_id }, ref(task, session));
    return { ok: true };
  }
  /** The completion check after a run: the open turns the agent still holds (a queued one was not acted on) and whether a task is still open. */
  wakeCheck(machineId: string, agentId: string, task?: string) {
    if (!this.ownAgents(machineId).has(agentId)) throw fail('not_found', 'Agent not found on this PC');
    const held = (this.turns?.held(agentId) ?? []).slice(0, 40).map((h) => ({ task: h.task_id, phase: h.phase }));
    // paused: the agent's team is paused (Stop team), so the wake starts nothing more for it; a turn already running ends as it is.
    return { held, task_open: task && this.turns ? this.turns.open(task) : null, paused: this.turns?.paused?.(agentId) ?? false };
  }
  /** The runs of this PC's agents, for the console: a run with no activity for 30 minutes is flagged (nothing stops by itself). */
  wakeRuns(machineId: string) {
    const rows = this.db.prepare('SELECT * FROM wake_runs WHERE machine_id=? ORDER BY updated_at DESC').all(machineId) as unknown as { agent_id: string; state: string; task_id: string | null; session_id: string | null; waiting_on: string | null; started_at: number | null; last_activity_at: number | null; resumes_at: number | null; updated_at: number }[];
    const now = this.now();
    return rows.map((w) => ({ agent_id: w.agent_id, state: w.state, task: w.task_id, session_id: w.session_id, waiting_on: w.waiting_on, started_at: w.started_at, last_activity_at: w.last_activity_at, resumes_at: w.resumes_at,
      no_activity: w.state === 'running' && now - (w.last_activity_at ?? w.updated_at) >= WAKE_QUIET_MS }));
  }

  /** One agent's woken run, wherever it runs (the agent page's Status card), or null when the connector never reported one. */
  wakeRunOf(agentId: string) {
    const w = this.db.prepare('SELECT machine_id FROM wake_runs WHERE agent_id=?').get(agentId) as { machine_id: string } | undefined;
    if (!w) return null;
    const r = this.wakeRuns(w.machine_id).find((x) => x.agent_id === agentId)!;
    const title = r.task ? (this.db.prepare('SELECT title FROM tasks WHERE id=?').get(r.task) as { title: string } | undefined)?.title ?? null : null;
    return { ...r, pc: w.machine_id, pc_name: this.keys.machine(w.machine_id)?.name ?? null, task_title: title };
  }
  /**
   * The operator's Stop (docs/connector.md, "The wake"): one `deliver` order with reason `stop` and no items, to the PC the run
   * reported from, audited (`connector.wake_stop`). The connector ends the run after its current tool call and keeps its session;
   * whatever only the run held (its unsaved files, its unsent words) is lost, the hub's records and git are not. A run that is not
   * live, or a PC that is suspended or disconnected, is refused.
   */
  stopRun(agentId: string, actor: Actor): { order: string } {
    const w = this.db.prepare('SELECT machine_id, state, task_id FROM wake_runs WHERE agent_id=?').get(agentId) as { machine_id: string; state: string; task_id: string | null } | undefined;
    if (!w || !WAKE_LIVE.includes(w.state)) throw fail('invalid_state', 'This agent has no woken run to stop.');
    const pc = w.machine_id;
    if (this.keys.machine(pc)?.status !== 'active' || this.disconnected(pc)) throw fail('invalid_state', 'The PC of this run has no access now, so it cannot be told to stop.');
    if (this.tooOld(pc, 'deliver')) throw this.tooOldFail(pc);
    const now = this.now();
    return tx(this.db, () => {
      const open = this.db.prepare("SELECT id FROM pc_actions WHERE machine_id=? AND kind='deliver' AND state IN ('queued','fetched') AND json_extract(payload,'$.agent_id')=? AND json_extract(payload,'$.reason')='stop'").get(pc, agentId) as { id: string } | undefined;
      if (open) return { order: open.id };
      const id = `pca_${randomToken(10)}`;
      this.db.prepare("INSERT INTO pc_actions(id,machine_id,kind,state,payload,created_at,created_by,expires_at) VALUES (?,?,'deliver','queued',?,?,?,?)")
        .run(id, pc, JSON.stringify({ agent_id: agentId, items: [], reason: 'stop' }), now, who(actor), now + ORDER_TTL_MS);
      this.audit.event(actor, 'connector.wake_stop', { kind: 'agent', id: agentId }, { pc, order: id, ...(w.task_id ? { task: w.task_id } : {}), run_state: w.state });
      this.streams.signal(pc);
      return { order: id };
    });
  }

  /** The PC's connector status, every field null until reported (docs/connector.md, "PC status"). */
  status(machineId: string) {
    const r = this.db.prepare('SELECT * FROM connector_reports WHERE machine_id=?').get(machineId) as unknown as ReportRow | undefined;
    const approved = this.approvedVersions();
    // Disconnected (until Re-enrol PC ends it) and Suspended come before Online: neither reads "Offline since".
    const held = this.disconnected(machineId) ? 'disconnected' as const : this.keys.machine(machineId)?.status === 'suspended' ? 'suspended' as const : null;
    if (!r) {
      return { online: false, status: held ?? 'never' as const, first_check_in_at: null, last_check_in_at: null, version: null, platform: null, node: null, git: null, clients: [],
        auto_update: null, remote_cleanup: null, remove_connector_with_last_hub: null, usage_opt_in: null, hardware_opt_in: null, destinations: null, isolation: null, key_store: null, legacy_leftovers: null, legacy_leftover_kinds: null, version_status: null, update_available: null };
    }
    const online = !held && this.now() - r.last_check_in_at < ONLINE_MS;
    const vs = r.version ? (this.db.prepare('SELECT status FROM connector_versions WHERE version=?').get(r.version) as { status: string } | undefined)?.status ?? null : null;
    const newer = r.version ? approved.filter((v) => cmpVersion(v, r.version!) > 0) : [];
    return {
      online, status: held ?? (online ? 'online' as const : 'offline' as const), first_check_in_at: r.first_check_in_at, last_check_in_at: r.last_check_in_at,
      version: r.version, platform: r.platform, node: r.node, git: r.git, clients: parse(r.clients, [] as unknown[]),
      auto_update: bool(r.auto_update), remote_cleanup: bool(r.remote_cleanup), remove_connector_with_last_hub: bool(r.remove_with_last_hub), usage_opt_in: bool(r.usage_opt_in), hardware_opt_in: bool(r.hardware_opt_in),
      destinations: parse(r.destinations, null as { id: string; label: string }[] | null), isolation: r.isolation, key_store: r.key_store, legacy_leftovers: bool(r.legacy_leftovers), legacy_leftover_kinds: parse(r.legacy_leftover_kinds, null as string[] | null),
      version_status: vs, update_available: newer.length ? newer[newer.length - 1]! : null,
    };
  }

  // ───── agents and the setup timeline ─────
  timeline(machineId: string) {
    const pc = this.keys.machine(machineId);
    if (!pc) throw fail('not_found', 'PC not found');
    const st = this.status(machineId);
    const reportedRows = new Map(parse((this.db.prepare('SELECT agents FROM connector_reports WHERE machine_id=?').get(machineId) as { agents: string } | undefined)?.agents ?? null, [] as { agent_id: string; state: string; profile?: string; profile_hidden?: true }[]).map((a) => [a.agent_id, a]));
    const bridge = this.db.prepare("SELECT created_at FROM bridge_keys WHERE machine_id=? AND status<>'revoked' ORDER BY created_at DESC LIMIT 1").get(machineId) as { created_at: number } | undefined;
    const reqs = this.db.prepare("SELECT id, state, body, filed_at, decided_at, collected_at, team_id FROM onboarding_requests WHERE machine_id=? AND kind<>'rotate' AND state NOT IN ('denied','withdrawn','cancelled') ORDER BY filed_at").all(machineId) as { id: string; state: string; body: string; filed_at: number; decided_at: number | null; collected_at: number | null; team_id: string | null }[];
    // live: the agent's session keys the hub still accepts. A connected agent with none is never shown as Connected.
    const slots = this.db.prepare(`SELECT s.agent_id, s.label, s.status, r.team_id, a.connected_at, a.last_active_at,
        (SELECT COUNT(*) FROM credentials c WHERE c.agent_id=s.agent_id AND c.kind='session_key' AND c.status='active') AS live FROM onboarding_slots s JOIN onboarding_requests r ON r.id=s.request_id JOIN agents a ON a.id=s.agent_id
      WHERE r.machine_id=? AND r.kind<>'rotate' AND s.status<>'closed' ORDER BY s.created_at`).all(machineId) as { agent_id: string; label: string; status: string; team_id: string | null; connected_at: number | null; last_active_at: number | null; live: number }[];

    type Next = { action: string; who: 'you' | 'pc_user' | 'agent' } | null;
    type Agent = { agent_id: string | null; label: string; team_id: string | null; state: 'waiting_for_approval' | 'ready_to_open' | 'connected' | 'key_refused'; next: Next; connected_at: number | null; last_active_at: number | null; pc_reported: string | null; pc_profile: PcProfile };
    const agents: Agent[] = [];
    for (const q of reqs.filter((x) => x.state === 'submitted' || x.state === 'needs_changes')) {
      const roles = parse(q.body, {} as { roles?: { name?: string; count?: number }[] }).roles ?? [];
      for (const ro of roles) for (let i = 1; i <= Math.min(Math.max(ro.count ?? 1, 1), 50); i++) {
        agents.push({ agent_id: null, label: (ro.count ?? 1) > 1 ? `${ro.name ?? 'agent'} ${i}` : String(ro.name ?? 'agent'), team_id: q.team_id, state: 'waiting_for_approval', next: { action: 'Approve the team request', who: 'you' }, connected_at: null, last_active_at: null, pc_reported: null, pc_profile: null });
      }
    }
    for (const s of slots) {
      // Three states (review v2 §3): keys not collected yet is Ready to open, with the PC user's next step.
      // An agent whose keys the hub no longer accepts (revoked or suspended) is Key refused, not Connected.
      const refused = s.status !== 'waiting' && !s.live;
      const state = refused ? 'key_refused' as const : s.connected_at ? 'connected' as const : 'ready_to_open' as const;
      const next: Next = refused ? { action: 'Give the agent a new key', who: 'you' } : s.connected_at ? null : s.status === 'waiting' ? { action: 'Continue setup on the PC', who: 'pc_user' } : { action: 'Open the agent on the PC', who: 'pc_user' };
      agents.push({ agent_id: s.agent_id, label: s.label, team_id: s.team_id, state, next, connected_at: s.connected_at, last_active_at: s.last_active_at, pc_reported: reportedRows.get(s.agent_id)?.state ?? null, pc_profile: pcProfileOf(reportedRows.get(s.agent_id)) });
    }

    type Step = { step: string; state: 'done' | 'waiting' | 'failed' | 'not_yet'; at: number | null; reason: string | null; next: { action: string; who: 'you' | 'pc_user' | 'agent' } | null };
    // Paired from the moment the PC's own code was redeemed (pairing or setup.mjs enrol), else its first check-in.
    const redeemed = (this.db.prepare("SELECT MIN(used_at) AS at FROM enrolment_codes WHERE machine_id=? AND expires_at IS NULL AND used_at IS NOT NULL AND status<>'revoked'").get(machineId) as { at: number | null }).at;
    const pairedAt = redeemed ?? st.first_check_in_at ?? bridge?.created_at ?? null;
    const steps: Step[] = [{ step: 'added', state: 'done', at: pc.created_at, reason: null, next: null }];
    // A PC set up before the connector (the older helper, or by hand) works through its app key: its agents call tools through
    // it, with no pairing, no team request and no pickup. The checklist says so instead of "has not paired yet" next to the
    // agents that work (the PC page lists them from the same calls).
    if (pairedAt === null && !reqs.length && !slots.length) {
      const calls = this.db.prepare(`SELECT MIN(created_at) AS first, COUNT(DISTINCT agent_id) AS n FROM tool_invocations WHERE app_credential_id IN (SELECT id FROM credentials WHERE machine_id=? AND kind='app_key')
        AND agent_id IS NOT NULL AND tool NOT IN ('session_login','session_whoami')`).get(machineId) as { first: number | null; n: number };
      if (calls.first !== null) {
        steps.push({ step: 'app_key', state: 'done', at: calls.first, reason: "Its agents log in with this PC's app key; the connector is not paired. Re-enrol PC makes a pairing code if you want the connector.", next: null });
        steps.push({ step: 'agents_connected', state: 'done', at: calls.first, reason: `${calls.n} ${calls.n === 1 ? 'agent has' : 'agents have'} worked through this PC.`, next: null });
        return { steps, agents };
      }
    }
    steps.push(pairedAt !== null ? { step: 'paired', state: 'done', at: pairedAt, reason: null, next: null }
      : { step: 'paired', state: 'waiting', at: null, reason: 'The connector has not paired with this hub yet.', next: { action: 'Enter the pairing code on the PC', who: 'pc_user' } });
    const filed = reqs[0];
    steps.push(filed ? { step: 'request_filed', state: 'done', at: filed.filed_at, reason: null, next: null }
      : { step: 'request_filed', state: pairedAt !== null ? 'waiting' : 'not_yet', at: null, reason: null, next: pairedAt !== null ? { action: 'Ask for a team on the PC', who: 'pc_user' } : null });
    const pending = reqs.filter((x) => x.state === 'submitted' || x.state === 'needs_changes');
    const decided = reqs.filter((x) => x.decided_at !== null && x.state !== 'submitted' && x.state !== 'needs_changes');
    steps.push(!filed ? { step: 'approved', state: 'not_yet', at: null, reason: null, next: null }
      : pending.some((x) => x.state === 'needs_changes') ? { step: 'approved', state: 'waiting', at: null, reason: 'You asked for changes to the request.', next: { action: 'Change the request and file it again', who: 'agent' } }
      : pending.length ? { step: 'approved', state: 'waiting', at: null, reason: null, next: { action: 'Approve the team request', who: 'you' } }
      : { step: 'approved', state: 'done', at: Math.max(...decided.map((x) => x.decided_at!)) || null, reason: null, next: null });
    const uncollected = slots.filter((s) => s.status === 'waiting');
    steps.push(!slots.length ? { step: 'keys_collected', state: 'not_yet', at: null, reason: null, next: null }
      : uncollected.length ? { step: 'keys_collected', state: 'waiting', at: null, reason: `${uncollected.length} of ${slots.length} agents have no keys on the PC yet.`, next: { action: 'Collect the keys on the PC', who: 'pc_user' } }
      : { step: 'keys_collected', state: 'done', at: Math.max(0, ...reqs.map((x) => x.collected_at ?? 0)) || null, reason: null, next: null });
    const ready = agents.filter((a) => a.state === 'ready_to_open' && a.agent_id && slots.find((s) => s.agent_id === a.agent_id)?.status !== 'waiting');
    const broken = agents.filter((a) => a.pc_reported === 'repair_connection' || a.state === 'key_refused');
    steps.push(!slots.length || uncollected.length === slots.length ? { step: 'agents_connected', state: 'not_yet', at: null, reason: null, next: null }
      : broken.some((a) => a.state === 'key_refused') ? { step: 'agents_connected', state: 'failed', at: null, reason: `The hub no longer accepts the key of ${broken.filter((a) => a.state === 'key_refused').map((a) => a.label).join(', ')}.`, next: { action: 'Give the agent a new key', who: 'you' } }
      : broken.length ? { step: 'agents_connected', state: 'failed', at: null, reason: `The PC reports that ${broken.map((a) => a.label).join(', ')} cannot reach the hub.`, next: { action: 'Repair the connection on the PC', who: 'pc_user' } }
      : ready.length ? { step: 'agents_connected', state: 'waiting', at: null, reason: `${ready.length} of ${slots.length} agents have not made their first call yet.`, next: { action: 'Open the agent on the PC', who: 'pc_user' } }
      : { step: 'agents_connected', state: 'done', at: Math.max(0, ...agents.map((a) => a.connected_at ?? 0)) || null, reason: null, next: null });
    return { steps, agents };
  }

  // ───── PC actions ─────
  private view(a: ActionRow) {
    const { receipt_key_id: _k, receipt_verifier: _v, payload, result, agent_id: _a, order_reason: _r, release_at: _l, handed_at: _h, ...rest } = a;
    return { ...rest, payload: parse(payload, {}), result: parse(result, null) };
  }
  private expire(): void {
    const now = this.now();
    // A restore is a long order: it does not expire by the clock while its checkout is rendered or restoring, and it ends when the checkout does.
    this.db.prepare(`UPDATE pc_actions SET state='expired', finished_at=?, result=? WHERE kind='restore' AND state IN ('queued','fetched')
      AND COALESCE((SELECT status FROM checkouts WHERE id=json_extract(pc_actions.payload,'$.checkout_id')),'') NOT IN ('rendered','restoring')`)
      .run(now, JSON.stringify({ reason: 'The checkout ended (cancelled, replaced or restored), so this restore stopped.' }));
    // Orders of a locked-down PC wait: they are handed out after the lockdown, so none expires by the clock meanwhile.
    const held = (this.db.prepare("SELECT DISTINCT machine_id m FROM pc_actions WHERE state='queued'").all() as { m: string }[]).map((r) => r.m).filter((m) => this.isLocked(m));
    this.db.prepare("UPDATE pc_actions SET state='expired', finished_at=? WHERE kind NOT IN ('disconnect','restore') AND state='queued' AND expires_at<=?" + (held.length ? ` AND machine_id NOT IN (${held.map(() => '?').join(',')})` : '')).run(now, now, ...held);
    this.db.prepare("UPDATE pc_actions SET state='expired', finished_at=?, result=? WHERE kind NOT IN ('disconnect','restore') AND state='fetched' AND fetched_at<=?")
      .run(now, JSON.stringify({ reason: 'The connector took this order but did not report a result within 24 hours.' }), now - FETCHED_TTL_MS);
    // A disconnect with no result by expires_at needs attention, and its receipt is retired with it.
    const late = this.db.prepare(`SELECT * FROM pc_actions WHERE ${DSC_OPEN_SQL} AND expires_at<=?`).all(now) as unknown as ActionRow[];
    for (const a of late) {
      const left = a.state === 'access_revoked' ? 'The connector did not fetch the cleanup within 7 days. Its keys no longer work; its files are still on the PC.'
        : 'The connector fetched the cleanup but did not report it within 7 days. Its keys no longer work; check the PC.';
      this.db.prepare("UPDATE pc_actions SET state='needs_attention', finished_at=?, result=?, receipt_verifier=NULL WHERE id=?").run(now, JSON.stringify({ left: [left] }), a.id);
    }
  }
  actions(machineId: string) {
    return (this.db.prepare('SELECT * FROM pc_actions WHERE machine_id=? ORDER BY created_at DESC, rowid DESC LIMIT 50').all(machineId) as unknown as ActionRow[]).map((a) => this.view(a));
  }
  createAction(machineId: string, b: { kind: (typeof ACTION_KINDS)[number]; checkout_id?: string; destination_id?: string; version?: string }, actor: Actor) {
    const pc = this.keys.machine(machineId);
    if (!pc) throw fail('not_found', 'PC not found');
    if (pc.status !== 'active') throw fail('invalid_state', 'This PC is suspended or retired; resume it first.');
    if (b.kind !== 'update' && this.measureOnly(machineId)) throw fail('invalid_state', 'This PC is a compute machine: its connector only measures it, so it takes Update and Disconnect and nothing else.');
    this.expire();
    let payload: Record<string, unknown> = {};
    if (b.kind === 'restore') {
      const c = b.checkout_id ? this.db.prepare('SELECT id, status, target_machine_id FROM checkouts WHERE id=?').get(b.checkout_id) as { id: string; status: string; target_machine_id: string | null } | undefined : undefined;
      if (!c) throw fail('not_found', 'Checkout not found');
      if (c.status !== 'rendered' || c.target_machine_id !== machineId) throw fail('invalid_state', 'Restore needs a checkout whose restore prompt is ready and that targets this PC.');
      // Only to a destination the PC's user approved on that PC, named by its id: the order never carries a path.
      const dest = this.status(machineId).destinations?.find((d) => d.id === b.destination_id);
      if (!dest) throw fail('invalid_state', "Restore goes only to a destination the PC's user approved on that PC. Ask them to approve one, then try again.");
      payload = { checkout_id: c.id, destination_id: dest.id };
    } else if (b.kind === 'update') {
      if (!b.version || !VERSION_RE.test(b.version)) throw fail('invalid_argument', 'version must look like 1.4.0');
      const v = this.db.prepare('SELECT status FROM connector_versions WHERE version=?').get(b.version) as { status: string } | undefined;
      if (v?.status !== 'approved') throw fail('invalid_state', 'Only an approved connector version can be installed.');
      const runs = this.status(machineId).version;
      if (runs && cmpVersion(b.version, runs) <= 0) throw fail('invalid_argument', `This PC runs ${runs}; an update must be a newer version (no downgrades).`);
      payload = { version: b.version };
    }
    if (this.db.prepare(`SELECT 1 FROM pc_actions WHERE machine_id=? AND kind=? AND state IN ('queued','fetched')`).get(machineId, b.kind)) throw fail('conflict', 'This PC already has an open order of that kind.');
    const id = `pca_${randomToken(10)}`, now = this.now();
    this.db.prepare("INSERT INTO pc_actions(id,machine_id,kind,state,payload,created_at,created_by,expires_at) VALUES (?,?,?,'queued',?,?,?,?)").run(id, machineId, b.kind, JSON.stringify(payload), now, who(actor), now + ORDER_TTL_MS);
    this.audit.event(actor, 'pc.action_create', { kind: 'pc', id: machineId }, { action: id, kind: b.kind, ...payload });
    this.streams.signal(machineId);
    return this.view(this.db.prepare('SELECT * FROM pc_actions WHERE id=?').get(id) as unknown as ActionRow);
  }
  /** The connector's pinned poll: the PC's queued orders, each moved to fetched (one-time). */
  fetchOrders(machineId: string) {
    if (this.isLocked(machineId)) return [];
    const now = this.now(), old = this.tooOld(machineId, 'deliver');
    return tx(this.db, () => {
      // The queued orders (a held one waits for its release_at), then the fetched ones whose result has not come: they are handed out again
      // every REHAND_MS, so an order lost in a crash on the PC is never lost for good. The connector skips what it already handled.
      const rows = this.db.prepare(`SELECT * FROM pc_actions WHERE machine_id=? AND kind<>'disconnect' AND ((state='queued' AND expires_at>? AND COALESCE(release_at,0)<=?)
        OR (state='fetched' AND COALESCE(handed_at, fetched_at, 0)<=? AND (kind='restore' OR fetched_at>?)))${old ? " AND kind<>'deliver'" : ''} ORDER BY created_at`).all(machineId, now, now, now - REHAND_MS, now - FETCHED_TTL_MS) as unknown as ActionRow[];
      for (const r of rows) this.db.prepare("UPDATE pc_actions SET state='fetched', fetched_at=COALESCE(fetched_at,?), handed_at=? WHERE id=?").run(now, now, r.id);
      return rows.map((r) => ({ id: r.id, kind: r.kind, payload: parse(r.payload, {}) }));
    });
  }
  /** The kind of one order of this PC, by id (never limited to its newest orders). */
  orderKind(machineId: string, id: string): string | null {
    return (this.db.prepare('SELECT kind FROM pc_actions WHERE id=? AND machine_id=?').get(id, machineId) as { kind: string } | undefined)?.kind ?? null;
  }
  private lastTick = 0;
  /**
   * The timer's work (every 30 s, app.ts): the expiry of orders that ran out, and the stream signal for a held order whose release time came.
   * Not done on every connector request any more.
   */
  tick(): void {
    const now = this.now(), since = this.lastTick || now - 60_000;
    this.lastTick = now;
    this.expire();
    const due = this.db.prepare("SELECT DISTINCT machine_id m FROM pc_actions WHERE kind='deliver' AND state='queued' AND release_at IS NOT NULL AND release_at>? AND release_at<=?").all(since, now) as { m: string }[];
    for (const d of due) this.streams.signal(d.m);
  }
  /** The PC this agent's session key is bound to, when its connector may be told. */
  private pcOfAgent(agentId: string): string | null {
    const r = this.db.prepare("SELECT bound_machine_id m FROM credentials WHERE kind='session_key' AND agent_id=? AND status='active' AND bound_machine_id IS NOT NULL ORDER BY created_at DESC LIMIT 1").get(agentId) as { m: string } | undefined;
    return r?.m ?? null;
  }
  /**
   * The hub's delivery order (docs/connector.md, "Delivery orders"): an item that needs a turn waits on this agent. Ids only. Items for
   * the same agent fold into the order still queued. Not for a compute machine, a suspended or disconnected PC, or an agent
   * with no PC. Messages from agents make at most one order per agent per ten minutes; the operator's, none held back.
   */
  deliver(agentId: string, item: { notice: string; task?: string; from?: 'agent' | 'operator' }): { order: string; folded: boolean; held?: true } | null {
    const why = REASON_NOTICES[item.notice];
    if (why) { const r = this.deliverReason(agentId, why); return r.order ? { order: r.order, folded: r.already } : null; }
    if (!TURN_NOTICES.has(item.notice) && item.notice !== 'message') return null;
    const pc = this.pcOfAgent(agentId);
    if (!pc || this.keys.machine(pc)?.status !== 'active' || this.measureOnly(pc) || this.disconnected(pc)) return null;
    const now = this.now();
    const agentMsg = item.notice === 'message' && item.from !== 'operator';
    const entry = { notice: item.notice, ...(item.task ? { task: item.task } : {}) };
    // A connector too old for delivery orders is never handed one: the order waits on the hub until the PC reports a newer version,
    // and the item reads "connector too old".
    if (this.tooOld(pc, 'deliver')) { try { this.onDelivery?.(agentId, [entry], { delivered: false, reason: 'connector_too_old' }); } catch { /* the console view never blocks the order */ } }
    return tx(this.db, () => {
      // An agent's message inside the window of its last wake is held, not dropped: its order is released when the window ends.
      let release: number | null = null;
      if (agentMsg) {
        const last = (this.db.prepare("SELECT MAX(COALESCE(release_at, created_at)) t FROM pc_actions WHERE kind='deliver' AND machine_id=? AND agent_id=? AND json_extract(payload,'$.agent_msg')=1 AND order_reason IS NULL AND state<>'expired'").get(pc, agentId) as { t: number | null }).t;
        if (last !== null && last + AGENT_MESSAGE_GAP_MS > now) release = last + AGENT_MESSAGE_GAP_MS;
      }
      const open = this.db.prepare("SELECT id, payload, release_at FROM pc_actions WHERE machine_id=? AND kind='deliver' AND state='queued' AND agent_id=? AND order_reason IS NULL").get(pc, agentId) as { id: string; payload: string; release_at: number | null } | undefined;
      if (open) {
        const p = parse(open.payload, { agent_id: agentId, items: [] as { notice: string; task?: string }[], agent_msg: false });
        if (!p.items.some((i) => i.notice === entry.notice && i.task === entry.task) && p.items.length < DELIVER_ITEMS_MAX) p.items.push(entry);
        if (agentMsg) p.agent_msg = true;
        // Anything but an agent's message (a task, the operator's word) releases a held order now.
        const held = open.release_at !== null && open.release_at > now;
        const keep = held && agentMsg ? open.release_at : null;
        this.db.prepare('UPDATE pc_actions SET payload=?, release_at=? WHERE id=?').run(JSON.stringify(p), keep, open.id);
        if (held && keep === null) this.streams.signal(pc);
        return { order: open.id, folded: true, ...(keep !== null ? { held: true as const } : {}) };
      }
      const id = `pca_${randomToken(10)}`;
      this.db.prepare("INSERT INTO pc_actions(id,machine_id,kind,state,payload,created_at,created_by,expires_at,agent_id,release_at) VALUES (?,?,'deliver','queued',?,?,?,?,?,?)")
        .run(id, pc, JSON.stringify({ agent_id: agentId, items: [entry], ...(agentMsg ? { agent_msg: true } : {}) }), now, 'hub', (release ?? now) + ORDER_TTL_MS, agentId, release);
      if (release === null) this.streams.signal(pc);
      return { order: id, folded: false, ...(release !== null ? { held: true as const } : {}) };
    });
  }
  /**
   * A reason order (Start team, write the handout, resume after a move): one per agent and reason while it is open, so pressing
   * again gives the same order and a member gets exactly one turn for it. Never folded into an item order, and no item folds
   * into it. `why` says why none was made: no PC holds the agent's key, or that PC cannot be told.
   */
  deliverReason(agentId: string, reason: OrderReason): { order: string; already: boolean } | { order: null; why: 'no_pc' | 'pc_unavailable' } {
    const pc = this.pcOfAgent(agentId);
    if (!pc) return { order: null, why: 'no_pc' };
    if (this.keys.machine(pc)?.status !== 'active' || this.measureOnly(pc) || this.disconnected(pc)) return { order: null, why: 'pc_unavailable' };
    this.expire();
    return tx(this.db, () => {
      const open = this.db.prepare("SELECT id FROM pc_actions WHERE machine_id=? AND kind='deliver' AND state IN ('queued','fetched') AND agent_id=? AND order_reason=?").get(pc, agentId, reason) as { id: string } | undefined;
      if (open) return { order: open.id, already: true };
      const id = `pca_${randomToken(10)}`, now = this.now();
      this.db.prepare("INSERT INTO pc_actions(id,machine_id,kind,state,payload,created_at,created_by,expires_at,agent_id,order_reason) VALUES (?,?,'deliver','queued',?,?,?,?,?,?)")
        .run(id, pc, JSON.stringify({ agent_id: agentId, items: [], reason }), now, 'hub', now + ORDER_TTL_MS, agentId, reason);
      this.streams.signal(pc);
      return { order: id, already: false };
    });
  }
  /** The latest reason order of an agent, for the console: its state and, when no turn started, the PC's code. */
  reasonOrderOf(agentId: string, reason: OrderReason): { order: string; state: string; code: string | null; created_at: number; finished_at: number | null } | null {
    this.expire();
    const r = this.db.prepare("SELECT id, state, result, created_at, finished_at FROM pc_actions WHERE kind='deliver' AND agent_id=? AND order_reason=? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(agentId, reason) as { id: string; state: string; result: string | null; created_at: number; finished_at: number | null } | undefined;
    if (!r) return null;
    const code = parse(r.result, {} as { code?: string }).code;
    return { order: r.id, state: r.state, code: typeof code === 'string' ? code : null, created_at: r.created_at, finished_at: r.finished_at };
  }
  /** The wake's latest report for an agent (running, waiting, ended, ...), or null: fixed words and ids only, for Start team. */
  wakeStateOf(agentId: string): { state: string; task: string | null; updated_at: number } | null {
    const w = this.db.prepare('SELECT state, task_id, updated_at FROM wake_runs WHERE agent_id=?').get(agentId) as { state: string; task_id: string | null; updated_at: number } | undefined;
    return w ? { state: w.state, task: w.task_id, updated_at: w.updated_at } : null;
  }
  /** Whether an agent's PC is online now (null: no PC holds its key). */
  pcOnlineOf(agentId: string): boolean | null {
    const pc = this.pcOfAgent(agentId);
    return pc ? this.status(pc).online : null;
  }
  /**
   * Move team with no one at the keyboard: a rendered checkout whose target PC's user approved exactly one destination needs no
   * choice, so Restore is sent at once. With none or several, nothing is sent and the operator picks. An open restore is not doubled.
   */
  restoreIfOneDestination(checkoutId: string, actor: Actor): { id: string } | null {
    const c = this.db.prepare('SELECT status, target_machine_id FROM checkouts WHERE id=?').get(checkoutId) as { status: string; target_machine_id: string | null } | undefined;
    if (!c?.target_machine_id || c.status !== 'rendered') return null;
    if (this.db.prepare("SELECT 1 x FROM pc_actions WHERE kind='restore' AND state IN ('queued','fetched') AND json_extract(payload,'$.checkout_id')=?").get(checkoutId)) return null;
    const dests = this.status(c.target_machine_id).destinations ?? [];
    return dests.length === 1 ? this.createAction(c.target_machine_id, { kind: 'restore', checkout_id: checkoutId, destination_id: dests[0]!.id }, actor) : null;
  }
  /** Set in app.ts: a restore order reported done on its target PC, so the moved agents can be woken to resume. */
  onRestored: ((checkoutId: string, machineId: string) => void) | null = null;
  /** Set in app.ts: a delivery order's result, for the items it carried (task ids, and whether decisions are among them). */
  onDelivery: ((agentId: string, items: { notice: string; task?: string }[], outcome: { delivered: true } | { delivered: false; reason: string | null }) => void) | null = null;
  /** Access to this PC ended (a key suspended or revoked, Disconnect, retire, lockdown): its stream and any long poll end now. */
  accessEnded(machineId: string): void { this.streams.close(machineId, 'access_ended'); }
  /** Whether the PC may still hold a stream. */
  /** Set in app.ts: whether this PC is locked down (safety/lockdown.ts). While it is, the connector gets no order, its orders wait queued and none expires, and it opens no stream. */
  locked: ((machineId: string) => boolean) | null = null;
  /** A lockdown of all writes or of this PC: the key handover list answers 423, as the pickup does (set by the app). */
  handoversLocked: ((machineId: string) => boolean) | null = null;
  isLocked(machineId: string): boolean { return this.locked?.(machineId) === true; }
  streamAllowed(machineId: string, locked: boolean): boolean {
    return !locked && this.keys.machine(machineId)?.status === 'active' && !this.disconnected(machineId);
  }
  /**
   * A long order's progress (a restore): one plain line and, once the agents are restored, how to start each. The order stays
   * fetched; only its own PC may report, and only while it is open. The latest line replaces the one before.
   */
  progressOrder(machineId: string, id: string, p: { note: string; start_lines?: string[] }) {
    const a = this.db.prepare("SELECT * FROM pc_actions WHERE id=? AND machine_id=? AND kind='restore' AND state='fetched'").get(id, machineId) as unknown as ActionRow | undefined;
    if (!a) throw fail('not_found', 'Order not found');
    const clean = this.pcText(machineId, p);
    this.db.prepare('UPDATE pc_actions SET result=? WHERE id=?').run(JSON.stringify({ progress: clean.note, ...(clean.start_lines?.length ? { start_lines: clean.start_lines } : {}) }), id);
    return { ok: true };
  }
  reportOrder(machineId: string, id: string, state: 'done' | 'failed', result: unknown) {
    const a = this.db.prepare("SELECT * FROM pc_actions WHERE id=? AND machine_id=? AND kind<>'disconnect'").get(id, machineId) as unknown as ActionRow | undefined;
    // One result per order, only from its own PC: anything else is not_found.
    if (!a || a.state !== 'fetched') throw fail('not_found', 'Order not found');
    const clean = a.kind === 'deliver' && state === 'done' ? { delivered_at: this.now() } : this.pcText(machineId, result ?? null);
    this.db.prepare('UPDATE pc_actions SET state=?, result=?, finished_at=? WHERE id=?').run(state, JSON.stringify(clean), this.now(), id);
    if (a.kind === 'deliver') {
      const p = parse(a.payload, { agent_id: '', items: [] as { notice: string; task?: string }[] });
      const code = (clean as { code?: string } | null)?.code;
      try { this.onDelivery?.(p.agent_id, p.items, state === 'done' ? { delivered: true } : { delivered: false, reason: (DELIVER_REASONS as readonly string[]).includes(code ?? '') ? code! : null }); } catch { /* the console view never blocks the result */ }
    }
    if (a.kind === 'restore' && state === 'done') {
      const p = parse(a.payload, { checkout_id: '' });
      try { if (p.checkout_id) this.onRestored?.(p.checkout_id, machineId); } catch { /* a wake that cannot be sent leaves the resume to a person */ }
    }
    this.audit.event({ kind: 'system', id: null }, 'pc.action_report', { kind: 'pc', id: machineId }, { action: id, kind: a.kind, state });
    return { ok: true };
  }

  // ───── Disconnect this hub from this PC ─────
  disconnectView(machineId: string) {
    this.expire();
    const a = this.db.prepare("SELECT * FROM pc_actions WHERE machine_id=? AND kind='disconnect' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(machineId) as unknown as ActionRow | undefined;
    if (!a) return null;
    const p = parse(a.payload, {} as { remote_cleanup?: boolean | null }), res = parse(a.result, {} as { left?: string[]; cleanup_off?: boolean });
    return { id: a.id, state: a.state, created_at: a.created_at, fetched_at: a.fetched_at, finished_at: a.finished_at, expires_at: a.expires_at, ended_at: a.ended_at,
      removes: DISCONNECT_REMOVES, keeps: DISCONNECT_KEEPS, remote_cleanup: p.remote_cleanup ?? null, cleanup_off: res.cleanup_off === true, left: res.left ?? [] };
  }
  /**
   * Revokes the PC's access at once (it is suspended: its app keys, bridge key and its agents' sessions stop working) and
   * stores one disconnect order. Its narrow receipt credential is issued only to the connector (issueReceipt). The cleanup
   * itself is the connector's.
   */
  disconnect(machineId: string, actor: Actor) {
    const pc = this.keys.machine(machineId);
    if (!pc) throw fail('not_found', 'PC not found');
    if (pc.status === 'retired') throw fail('invalid_state', 'A retired PC has no access to revoke.');
    this.expire();
    if (this.db.prepare(`SELECT 1 FROM pc_actions WHERE machine_id=? AND ${DSC_OPEN_SQL}`).get(machineId)) throw fail('conflict', 'A disconnect of this PC is already under way.');
    const remote_cleanup = this.status(machineId).remote_cleanup;
    const now = this.now(), id = `pca_${randomToken(10)}`;
    tx(this.db, () => {
      if (pc.status === 'active') this.keys.setMachineStatus(machineId, 'suspended', actor);
      this.db.prepare("UPDATE bridge_keys SET status='revoked', revoked_at=? WHERE machine_id=? AND status<>'revoked'").run(now, machineId);
      // Revoke any other open order: nothing else reaches this PC now.
      this.db.prepare(`UPDATE pc_actions SET state='expired', finished_at=? WHERE machine_id=? AND kind<>'disconnect' AND state IN ('queued','fetched')`).run(now, machineId);
      this.db.prepare("INSERT INTO pc_actions(id,machine_id,kind,state,payload,created_at,created_by,expires_at) VALUES (?,?,'disconnect','access_revoked',?,?,?,?)")
        .run(id, machineId, JSON.stringify({ remote_cleanup }), now, who(actor), now + DISCONNECT_TTL_MS);
    });
    this.audit.event(actor, 'pc.disconnect', { kind: 'pc', id: machineId }, { action: id, remote_cleanup });
    return { disconnect: this.disconnectView(machineId)! };
  }
  /**
   * The receipt credential, for the connector only: the hub answers the PC's own (now refused) key with it while a disconnect
   * is open. Each issue replaces the last one, so a lost answer is recovered by calling again; the console never sees it.
   */
  issueReceipt(machineId: string): string | null {
    this.expire();
    // Only while the order is open: after its result, its expiry or Re-enrol PC, the key gets a plain 401.
    const a = this.db.prepare(`SELECT id FROM pc_actions WHERE machine_id=? AND ${DSC_OPEN_SQL} ORDER BY created_at DESC LIMIT 1`).get(machineId) as { id: string } | undefined;
    if (!a) return null;
    const keyId = randomToken(8).slice(0, 12), secret = randomToken(20).slice(0, 32);
    this.db.prepare('UPDATE pc_actions SET receipt_key_id=?, receipt_verifier=? WHERE id=?').run(keyId, hmacHex(this.pepper, secret), a.id);
    return `ah_dsc_${keyId}_${secret}`;
  }
  /** The order a receipt credential may fetch; KeyError('invalid') for anything else. */
  verifyReceipt(presented: string): ActionRow {
    const m = RECEIPT_RE.exec(String(presented).trim());
    const a = m ? this.db.prepare("SELECT * FROM pc_actions WHERE receipt_key_id=? AND kind='disconnect'").get(m[1]!) as unknown as ActionRow | undefined : undefined;
    if (!m || !a || !a.receipt_verifier || !safeEqualHex(a.receipt_verifier, hmacHex(this.pepper, m[2]!))) throw fail('invalid', 'unknown receipt credential');
    if (!DISCONNECT_OPEN.includes(a.state) || a.finished_at !== null || a.ended_at !== null || a.expires_at <= this.now()) throw fail('revoked', 'this receipt credential is retired');
    return a;
  }
  fetchDisconnect(a: ActionRow) {
    if (a.state === 'access_revoked') this.db.prepare("UPDATE pc_actions SET state='cleanup_pending', fetched_at=? WHERE id=?").run(this.now(), a.id);
    const p = parse(a.payload, {} as { remote_cleanup?: boolean | null });
    return { id: a.id, kind: 'disconnect', remote_cleanup: p.remote_cleanup ?? null, removes: DISCONNECT_REMOVES, keeps: DISCONNECT_KEEPS };
  }
  reportDisconnect(a: ActionRow, state: 'removed' | 'needs_attention' | 'cleanup_off', left: string[]) {
    const now = this.now(), clean = this.pcText(a.machine_id, left);
    // After the result the credential is retired: its verifier goes, so it can never be used again. Cleanup turned off on
    // the PC ends the order at Access revoked, said as such.
    const final = state === 'cleanup_off' ? 'access_revoked' : state;
    this.db.prepare('UPDATE pc_actions SET state=?, result=?, finished_at=?, receipt_verifier=NULL WHERE id=?').run(final, JSON.stringify({ left: clean, ...(state === 'cleanup_off' ? { cleanup_off: true } : {}) }), now, a.id);
    this.audit.event({ kind: 'system', id: null }, 'pc.action_report', { kind: 'pc', id: a.machine_id }, { action: a.id, kind: 'disconnect', state });
    return { ok: true };
  }
  /** True while the PC has a disconnect that Re-enrol PC has not ended; Reactivate is refused then. */
  disconnected(machineId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM pc_actions WHERE machine_id=? AND kind='disconnect' AND ended_at IS NULL").get(machineId);
  }
  /** Re-enrol PC ends a disconnect: the receipt is retired, the bridge key revoked and the PC active again. */
  endDisconnect(machineId: string, actor: Actor): boolean {
    if (!this.disconnected(machineId)) return false;
    const now = this.now();
    tx(this.db, () => {
      this.db.prepare("UPDATE pc_actions SET ended_at=?, receipt_verifier=NULL WHERE machine_id=? AND kind='disconnect' AND ended_at IS NULL").run(now, machineId);
      this.db.prepare("UPDATE bridge_keys SET status='revoked', revoked_at=? WHERE machine_id=? AND status<>'revoked'").run(now, machineId);
      if (this.keys.machine(machineId)?.status === 'suspended') this.keys.setMachineStatus(machineId, 'active', actor);
    });
    this.audit.event(actor, 'pc.disconnect_end', { kind: 'pc', id: machineId }, {});
    return true;
  }

  // ───── versions ─────
  /** Records a version the first time it is seen; true when it is new (and so pending). */
  private noteVersion(version: string, machineId: string | null): boolean {
    return this.db.prepare("INSERT OR IGNORE INTO connector_versions(version,status,first_seen_at,first_seen_pc) VALUES (?,'pending',?,?)").run(version, this.now(), machineId).changes > 0;
  }
  /** A reported version becomes pending only above the newest approved one, and while fewer than 5 wait. */
  private noteReported(version: string, machineId: string): boolean {
    if (this.db.prepare('SELECT 1 FROM connector_versions WHERE version=?').get(version)) return false;
    const top = this.approvedVersions().at(-1);
    if (top && cmpVersion(version, top) <= 0) return false;
    if ((this.db.prepare("SELECT COUNT(*) n FROM connector_versions WHERE status='pending'").get() as { n: number }).n >= MAX_PENDING_REPORTED) return false;
    return this.noteVersion(version, machineId);
  }
  approvedVersions(): string[] {
    return (this.db.prepare("SELECT version FROM connector_versions WHERE status='approved'").all() as { version: string }[]).map((r) => r.version).sort(cmpVersion);
  }
  versions() {
    const rows = this.db.prepare(`SELECT v.*, (SELECT COUNT(*) FROM connector_reports r WHERE r.version=v.version) pcs FROM connector_versions v`).all() as { version: string }[];
    return rows.sort((a, b) => cmpVersion(b.version, a.version));
  }
  addVersion(version: string, actor: Actor) {
    if (!VERSION_RE.test(version) || version.length > 40) throw fail('invalid_argument', 'version must look like 1.4.0');
    if (this.noteVersion(version, null)) {
      this.audit.event(actor, 'connector.version_add', null, { version });
      this.audit.alert('info', 'connector_version_pending', version, { version, pc: null });
    }
    return this.versions().find((v) => v.version === version)!;
  }
  decideVersion(version: string, status: 'approved' | 'refused', actor: Actor) {
    const r = this.db.prepare('UPDATE connector_versions SET status=?, decided_at=?, decided_by=? WHERE version=?').run(status, this.now(), who(actor), version);
    if (!r.changes) throw fail('not_found', 'Connector version not found');
    this.audit.event(actor, status === 'approved' ? 'connector.version_approve' : 'connector.version_refuse', null, { version });
    this.db.prepare("UPDATE security_alerts SET status='closed', updated_at=? WHERE type='connector_version_pending' AND subject=? AND status<>'closed'").run(this.now(), version);
    return this.versions().find((v) => v.version === version)!;
  }

  // ───── messages: shown on the PC ─────
  /** The PC reports the highest message its reminder line showed the agent; only for an agent whose key is bound here. */
  reportShown(machineId: string, agentId: string, roomId: string, seq: number) {
    const bound = this.db.prepare("SELECT 1 FROM credentials WHERE kind='session_key' AND agent_id=? AND bound_machine_id=? AND status='active'").get(agentId, machineId);
    if (!bound) throw fail('not_found', 'No agent with a key bound to this PC');
    const room = this.db.prepare('SELECT last_seq FROM rooms WHERE id=?').get(roomId) as { last_seq: number } | undefined;
    if (!room || !this.db.prepare('SELECT 1 FROM room_memberships WHERE room_id=? AND agent_id=? AND left_at IS NULL').get(roomId, agentId)) throw fail('not_found', 'Room not found');
    const s = Math.min(seq, room.last_seq), now = this.now();
    this.db.prepare(`INSERT INTO message_shown(agent_id,room_id,shown_seq,machine_id,reported_at) VALUES (?,?,?,?,?)
      ON CONFLICT(agent_id,room_id) DO UPDATE SET shown_seq=MAX(shown_seq, excluded.shown_seq), machine_id=excluded.machine_id, reported_at=excluded.reported_at`).run(agentId, roomId, s, machineId, now);
    return { ok: true };
  }
  messageStates(agentId: string, roomId?: string) {
    const rooms = this.db.prepare(`SELECT DISTINCT room_id FROM room_memberships WHERE agent_id=? AND left_at IS NULL ${roomId ? 'AND room_id=?' : ''}`).all(...(roomId ? [agentId, roomId] : [agentId])) as { room_id: string }[];
    return rooms.map(({ room_id }) => {
      const c = this.db.prepare('SELECT MAX(delivered_seq) d, MAX(acked_seq) k FROM message_delivery_cursors WHERE agent_id=? AND room_id=?').get(agentId, room_id) as { d: number | null; k: number | null };
      const sh = this.db.prepare('SELECT shown_seq, reported_at FROM message_shown WHERE agent_id=? AND room_id=?').get(agentId, room_id) as { shown_seq: number; reported_at: number } | undefined;
      const last = (this.db.prepare('SELECT last_seq FROM rooms WHERE id=?').get(room_id) as { last_seq: number } | undefined)?.last_seq ?? 0;
      return { room_id, last_seq: last, delivered_seq: c.d ?? 0, shown_seq: sh?.shown_seq ?? null, shown_reported_at: sh?.reported_at ?? null, acked_seq: c.k ?? 0 };
    });
  }

  /**
   * What the reminder line counts for an agent whose key is bound to this PC: messages it has not read (past the highest
   * position any of its logins acknowledged), grouped by who sent them, and the top message of each such room, for the
   * PC's shown report. Counts and sender labels only, never message text. A message from no agent is the operator's.
   * Reading this changes nothing: it never advances a delivery position.
   */
  unreadSummary(machineId: string, agentId: string) {
    const bound = this.db.prepare("SELECT 1 FROM credentials WHERE kind='session_key' AND agent_id=? AND bound_machine_id=? AND status='active'").get(agentId, machineId);
    if (!bound) throw fail('not_found', 'No agent with a key bound to this PC');
    const rows = this.db.prepare(`SELECT m.room_id, m.sender_agent_id, a.label, COUNT(*) n, MAX(m.seq) top FROM messages m
      JOIN room_memberships rm ON rm.room_id=m.room_id AND rm.agent_id=? AND rm.left_at IS NULL
      LEFT JOIN agents a ON a.id=m.sender_agent_id
      WHERE m.redacted_at IS NULL AND m.sender_agent_id IS NOT ?
        AND m.seq>COALESCE((SELECT MAX(acked_seq) FROM message_delivery_cursors c WHERE c.agent_id=? AND c.room_id=m.room_id),0)
      GROUP BY m.room_id, m.sender_agent_id`).all(agentId, agentId, agentId) as { room_id: string; sender_agent_id: string | null; label: string | null; n: number; top: number }[];
    const senders = new Map<string, { from: 'operator' | 'agent'; label: string | null; count: number }>();
    const rooms = new Map<string, number>();
    for (const r of rows) {
      const k = r.sender_agent_id ?? '';
      const e = senders.get(k) ?? { from: r.sender_agent_id === null ? 'operator' as const : 'agent' as const, label: r.sender_agent_id === null ? null : r.label, count: 0 };
      e.count += r.n; senders.set(k, e);
      rooms.set(r.room_id, Math.max(rooms.get(r.room_id) ?? 0, r.top));
    }
    const list = [...senders.values()].sort((x, y) => y.count - x.count).slice(0, 5);
    return { total: [...senders.values()].reduce((t, x) => t + x.count, 0), senders: list, rooms: [...rooms].slice(0, 20).map(([room_id, top_seq]) => ({ room_id, top_seq })) };
  }

  /** Where each agent in a conversation stands on its messages: fetched (delivered), shown on its PC (null until a PC reports), read. */
  roomDelivery(roomId: string) {
    const last = (this.db.prepare('SELECT last_seq FROM rooms WHERE id=?').get(roomId) as { last_seq: number } | undefined)?.last_seq ?? 0;
    const members = this.db.prepare('SELECT agent_id FROM room_memberships WHERE room_id=? AND agent_id IS NOT NULL AND left_at IS NULL').all(roomId) as { agent_id: string }[];
    return {
      last_seq: last,
      members: members.map(({ agent_id }) => {
        const s = this.messageStates(agent_id, roomId)[0];
        return { agent_id, delivered_seq: s?.delivered_seq ?? 0, shown_seq: s?.shown_seq ?? null, shown_reported_at: s?.shown_reported_at ?? null, acked_seq: s?.acked_seq ?? 0 };
      }),
    };
  }

  // ───── usage (admin only) ─────
  reportUsage(machineId: string, day: string, report: UsageRow[]) {
    const rows = this.pcText(machineId, report); // the model and client names too
    const st = this.status(machineId);
    if (st.usage_opt_in !== true) throw fail('invalid_state', "The PC's user has not turned usage reports on.");
    const own = this.ownAgents(machineId), other = rows.find((r) => !own.has(r.agent_id));
    if (other) throw fail('invalid_argument', `${other.agent_id} has no key bound to this PC.`);
    const now = this.now();
    tx(this.db, () => {
      this.db.prepare('DELETE FROM connector_usage WHERE machine_id=? AND day=?').run(machineId, day);
      for (const r of rows) {
        this.db.prepare(`INSERT INTO connector_usage(machine_id,day,agent_id,client,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,sessions,turns,reported_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(machine_id,day,agent_id,client,model) DO UPDATE SET input_tokens=input_tokens+excluded.input_tokens, output_tokens=output_tokens+excluded.output_tokens,
          cache_read_tokens=cache_read_tokens+excluded.cache_read_tokens, cache_write_tokens=cache_write_tokens+excluded.cache_write_tokens, sessions=sessions+excluded.sessions,
          turns=CASE WHEN turns IS NULL OR excluded.turns IS NULL THEN NULL ELSE turns+excluded.turns END`)
          .run(machineId, day, r.agent_id, r.client, r.model, r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_write_tokens, r.sessions, r.turns ?? null, now);
      }
    });
    return { ok: true };
  }
  private cost(r: UsageRow): number | null {
    const p = this.prices[r.model];
    if (!p) return null;
    return (r.input_tokens * p.input + r.output_tokens * p.output + r.cache_read_tokens * (p.cache_read ?? p.input) + r.cache_write_tokens * (p.cache_write ?? p.input)) / 1e6;
  }
  /** Since when a window of `days` days runs, today included. */
  private since(days: number) { return new Date(this.now() - (days - 1) * 86400_000).toISOString().slice(0, 10); }
  /** Rows with their cost, and the total: a cost or a turn count is null (Unknown) when any row has none. */
  private priced(rows: (UsageRow & { day: string })[]) {
    const withCost = rows.map((r) => ({ day: r.day, agent_id: r.agent_id, client: r.client, model: r.model, input_tokens: r.input_tokens, output_tokens: r.output_tokens,
      cache_read_tokens: r.cache_read_tokens, cache_write_tokens: r.cache_write_tokens, sessions: r.sessions, turns: r.turns ?? null, cost_usd: this.cost(r) }));
    return { rows: withCost, total: this.totalOf(withCost) };
  }
  private totalOf(rows: { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; turns: number | null; cost_usd: number | null }[]) {
    const sum = (k: 'input_tokens' | 'output_tokens' | 'cache_read_tokens' | 'cache_write_tokens') => rows.reduce((s, r) => s + r[k], 0);
    return {
      input_tokens: sum('input_tokens'), output_tokens: sum('output_tokens'), cache_read_tokens: sum('cache_read_tokens'), cache_write_tokens: sum('cache_write_tokens'),
      turns: rows.length && rows.every((r) => r.turns !== null) ? rows.reduce((s, r) => s + r.turns!, 0) : null,
      cost_usd: rows.length && rows.every((r) => r.cost_usd !== null) ? Math.round(rows.reduce((s, r) => s + r.cost_usd!, 0) * 100) / 100 : null,
    };
  }
  usage(machineId: string, days: number) {
    const rows = this.db.prepare('SELECT * FROM connector_usage WHERE machine_id=? AND day>=? ORDER BY day DESC, agent_id, model').all(machineId, this.since(days)) as unknown as (UsageRow & { day: string })[];
    const p = this.priced(rows);
    return { opted_in: this.status(machineId).usage_opt_in, days: p.rows, total: p.total, priced_at: 'API list prices' };
  }
  /**
   * Usage of a set of agents across every PC that reported it (the agent and team views): the total and one line per PC
   * (`by: 'pc'`) or per agent (`by: 'agent'`). `reported` is false while no PC sent anything for them in the window, and
   * the console then reads Unknown, not zero.
   */
  usageOf(agentIds: string[], days: number, by: 'pc' | 'agent') {
    const ids = [...new Set(agentIds)];
    const rows = ids.length ? this.db.prepare(`SELECT u.*, m.name AS pc_name FROM connector_usage u JOIN machines m ON m.id=u.machine_id
      WHERE u.agent_id IN (${ids.map(() => '?').join(',')}) AND u.day>=? ORDER BY u.day DESC, u.agent_id, u.model`).all(...ids, this.since(days)) as unknown as (UsageRow & { day: string; machine_id: string; pc_name: string })[] : [];
    const p = this.priced(rows);
    const groups = new Map<string, { key: string; name: string | null; rows: typeof p.rows }>();
    p.rows.forEach((r, i) => {
      const key = by === 'pc' ? rows[i]!.machine_id : r.agent_id;
      const g = groups.get(key) ?? { key, name: by === 'pc' ? rows[i]!.pc_name : null, rows: [] };
      g.rows.push(r); groups.set(key, g);
    });
    return {
      reported: rows.length > 0, total: p.total, priced_at: 'API list prices',
      by: [...groups.values()].map((g) => ({ [by === 'pc' ? 'pc_id' : 'agent_id']: g.key, ...(by === 'pc' ? { pc_name: g.name } : {}), ...this.totalOf(g.rows) }))
        .sort((a, b) => b.input_tokens + b.output_tokens - (a.input_tokens + a.output_tokens)),
    };
  }
  /** The current members of a team, or null when there is no such team. */
  teamAgents(teamId: string): string[] | null {
    if (!this.db.prepare('SELECT 1 FROM teams WHERE id=?').get(teamId)) return null;
    return (this.db.prepare('SELECT agent_id FROM team_members WHERE team_id=? AND removed_at IS NULL').all(teamId) as { agent_id: string }[]).map((r) => r.agent_id);
  }
  /** Open orders of a PC, for the console's buttons. */
  openKinds(machineId: string): string[] {
    return (this.db.prepare(`SELECT DISTINCT kind FROM pc_actions WHERE machine_id=? AND state IN (${OPEN_STATES.map(() => '?').join(',')})`).all(machineId, ...OPEN_STATES) as { kind: string }[]).map((r) => r.kind);
  }
}
