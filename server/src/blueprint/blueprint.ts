/**
 * Project Blueprint & Execution: the model and service (docs/blueprint.md §2, §3, §5).
 *
 * A project owns the blueprint; a team owns the modules and lines given to it, and the items inside them carry its id.
 * Every write is a batch of ops checked against the kind table (kinds.ts), applied in one transaction against the
 * project version the writer read, recorded as item revisions and one project event.
 *
 * Every team has a project from the start (`ensureTeamProject`); its plan is its part of the blueprint (§5).
 * §5, §7: `read`, `chain` and `supports` serve bp_read and bp_write; `fileReport` files bp_report with its cadence
 * and the hub's facts.
 * §4, §2.6: `write` is the operator's (or the hub's own) and trusts its caller; agents go through `submit`, which
 * checks each op against the rights matrix (rights.ts) and applies the batch or files it as one proposal for the operator.
 */
import { l2 } from '../notices/l2.js';
import { NOT_ALLOWED } from '../policy/engine.js';
import type { Db } from '../db/db.js';
import { tx } from '../db/db.js';
import { delegateAt } from '../checkout/via.js';
import { KeyError } from '../keys/keys.js';
import { randomToken } from '../util/crypto.js';
import { KINDS, SHORT_NAME_MAX, keyHint, RULES_HINT, RIGHTS_RULE, RELS, DEFAULT_LIMITS, RETIRED_SQL, relAllows, relText, BP_RULES, ruleNote, type BpLimits, type FieldType, type BpRule } from './kinds.js';
import { coverage, coverageCounts, type Coverage, type TasksSeen } from './coverage.js';
import { questions, blockingCount, type Questions } from './questions.js';
import { claimSupport, paperReadiness, contradicts, decided, type Support, type ClaimState } from './support.js';
import { glossaryOf, findCodes, termWords, resolve, splitBody, leadingCode, acceptanceEmpty, isNoiseCode, citedSources, citedRefs, classifySource, warn, issueText, type Known, type TermRef, type Warning, type PlainCheck } from './plain.js';
import { opRight, batchVerdict, type BpRole, type Verdict } from './rights.js';
import { STATUS_FORMAT, openRequest, openRequests, answerRequests, openRefine, requestById, refineKeys, refineChecks, type RequestScope, type RequestRow, type RefineChecks } from './requests.js';
import { scanRefs, RefError } from '../util/refs.js';
import type { Keys } from '../keys/keys.js';
import type { Audit, Actor } from '../audit/audit.js';
import type { Lockdown } from '../safety/lockdown.js';
import type { RequirementIn, ResearchIn, FiledItem } from '../onboarding/teamStart.js';
import { parseExport, stable, type Snapshot, type SnapItem } from './restore.js';
import { checkExternal, checkSystems, parseSystems, parseExternalFilter, refsOf, type ExternalRef } from './external.js';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { DecisionOption, ItemAsk } from '../teams/decisions.js';

const err = (code: string, msg: string, extra?: Record<string, unknown>) => new KeyError(code, msg, extra);

export type BpActorKind = 'operator' | 'agent' | 'import' | 'system';
export interface BpActor { kind: BpActorKind; id: string | null }

export interface ProjectRow {
  id: string; key: string; name: string; kind: 'implementation' | 'research'; status: string; version: number;
  created_by_kind: string; created_by_id: string | null; created_at: number; updated_at: number;
  /** The project's fixed task-tag list: a JSON array of {tag, name}, at most 7; '[]' means free tags (teams.ts). */
  task_tags?: string;
  /** Whether this project's tasks need review: required (default), per_task (the task creator decides) or none. */
  review_policy: 'required' | 'per_task' | 'none';
  /** Where agents' new tasks land: in the operator's backlog (default) or open at once. */
  task_intake: 'backlog' | 'open';
  /** 1 when the operator lets members with a grant on the project read its task board (docs/multi-user.md §1.2). */
  member_board: number;
  /** 1 when the operator keeps this project to one contributing team (docs/blueprint.md §3). */
  single_team: number;
  /** The ecosystem this project sits in, one level deep (docs/blueprint.md §3), or null. */
  parent_id: string | null;
  /** The outside systems its items may name, with the operator's URL templates (JSON, external.ts; §3), or null for any. */
  external_systems?: string | null;
  /** What each status of fr, nfr and ac means here, in the operator's words: JSON {kind: {status: sentence}} (§3). */
  status_meanings?: string;
}
/** The kinds whose statuses the operator may give a meaning (§3), and the longest sentence. */
export const MEANING_KINDS = ['fr', 'nfr', 'ac'] as const;
export const MEANING_MAX = 200;
export type StatusMeanings = Partial<Record<(typeof MEANING_KINDS)[number], Record<string, string>>>;
/** A project's status meanings, only the kinds and statuses that still exist and have a sentence. */
export function statusMeanings(p: { status_meanings?: string | null }): StatusMeanings {
  let raw: unknown;
  try { raw = JSON.parse(p.status_meanings || '{}'); } catch { return {}; }
  const out: StatusMeanings = {};
  for (const k of MEANING_KINDS) {
    const m = (raw as Record<string, unknown> | null)?.[k];
    if (!m || typeof m !== 'object') continue;
    const kept = Object.fromEntries(Object.entries(m as Record<string, unknown>).filter(([s, t]) => KINDS[k]!.statuses!.includes(s) && typeof t === 'string' && t.trim()));
    if (Object.keys(kept).length) out[k] = kept as Record<string, string>;
  }
  return out;
}
/** The rules' last block (bp_read {rules: true}): the operator's words, so L0. Empty when none is set. */
export function meaningsText(m: StatusMeanings): string {
  const lines = MEANING_KINDS.flatMap((k) => KINDS[k]!.statuses!.filter((s) => m[k]?.[s]).map((s) => `- ${k} ${s}: ${m[k]![s]}`));
  return lines.length ? ['(L0) What each status means in this project, in the operator\'s words (text only: the statuses and who may move them stay as above):', ...lines].join('\n') : '';
}
/** What a project's teams leave behind if they moved to another project (docs/blueprint.md §3). */
export interface TeamDependencies { items: string[]; proposals: string[]; tasks: { id: string; title: string }[] }
/** The only kinds an ecosystem holds: its Foundation (docs/blueprint.md §3). */
const ECOSYSTEM_KINDS = new Set(['summary', 'stakeholder']);
const OPEN_TASK = "status NOT IN ('done','cancelled','discarded')";
export interface ItemRow {
  id: string; project_id: string; kind: string; key: string; parent_key: string | null; title: string; body: string | null;
  fields: string; status: string | null; team_id: string | null; position: number; rev: number; origin: string | null; origin_id: string | null;
  created_by_kind: string; created_by_id: string | null; created_at: number; updated_by_kind: string; updated_by_id: string | null; updated_at: number; deleted_at: number | null; changed_version: number | null;
  /** The open re-plan that reset or created it, cleared when the re-plan is applied or cancelled. */
  replan_id?: string | null;
  /** 1 for a status report moved to the archive (§6): left out of live reads, kept in the export. */
  archived?: number;
  /** The author an export claimed for a restored item the hub could not verify, as JSON {kind, id}: attribution only (§4.2, migration 0120). */
  attributed_to?: string | null;
  /** For an item archived by hand (§6.1): the key whose archive took it; unarchiving that key brings it back. */
  archived_with?: string | null;
}
export interface Item extends Omit<ItemRow, 'fields'> { fields: Record<string, unknown> }
export interface LinkRow { project_id: string; from_key: string; to_key: string; rel: string; created_by_kind: string; created_by_id: string | null; created_at: number }
export interface EventRow {
  id: number; project_id: string; team_id: string | null; kind: string; version: number | null; actor_kind: string; actor_id: string | null; items: number | null;
  added: string[]; removed: string[]; changed: string[]; moves: { key: string; status: string | null; was: string | null }[]; note: string | null; proposal_id: string | null; created_at: number;
}

export type Op =
  | { op: 'upsert'; kind: string; key: string; parent_key?: string | null; title?: string; body?: string | null; fields?: Record<string, unknown>; status?: string | null; team_id?: string | null; position?: number; rev?: number;
      /**
       * Hub-only (§4.2): an op of a restore plan. It may bring back a deleted key, replaces the fields as a whole and
       * names the writer. bp_write strips unknown op fields and POST …/ops refuses them, so only restorePlan sets it.
       */
      restore?: { by?: BpActor; claimed?: BpActor | null };
      /** Why this op (at most 200 characters, L2 text), and an optional group: ops of one group are applied together. */
      reason?: string; group?: string }
  | { op: 'remove'; key: string; rev?: number; reason?: string; group?: string }
  | { op: 'link' | 'unlink'; from: string; to: string; rel: string; reason?: string; group?: string }
  | { op: 'move'; key: string; parent_key?: string | null; position?: number; rev?: number; reason?: string; group?: string };

export type ProposalStatus = 'open' | 'applied' | 'rejected' | 'withdrawn' | 'stale';
export interface Proposal {
  id: string; project_id: string; team_id: string | null; agent_id: string | null; ops: Op[]; base_version: number; reason: string | null;
  status: ProposalStatus; decided_by: string | null; decided_at: number | null; note: string | null; created_at: number; revs: Record<string, number | null>;
  /** `ops`: a batch of ops; `replan`: the submission of a re-plan, reviewed as a before/after diff. */
  type: 'ops' | 'replan'; replan_id: string | null;
  /** The delegate the proposing agent ran for when it proposed (contributor mode, docs/checkout.md §9.1). */
  via?: string;
  /** The refine request it answers, the ops the operator left out of a partial apply (index and key), and how many were written. */
  request_id: number | null; declined: { index: number; key: string | null }[] | null; applied_ops: number | null;
  /** Per op: the indices of the ops it needs (parent staged in the batch, link to a new key, same group, earlier op on the same key). */
  needs?: number[][];
}
/** Kinds a re-plan may reset, and the default set. Decisions, reports, papers and claims are kept by default. */
export const REPLAN_KINDS = ['fr', 'nfr', 'ac', 'milestone', 'release', 'risk', 'issue', 'term', 'hypothesis', 'question'];
export const REPLAN_DEFAULT = ['fr', 'nfr', 'ac', 'milestone', 'release', 'risk', 'term'];
export interface Replan {
  id: string; project_id: string; team_id: string | null; kinds: string[]; note: string | null; status: 'open' | 'applied' | 'cancelled';
  base_version: number; source: 'operator' | 'import'; opened_by_kind: string; opened_by_id: string | null; opened_at: number;
  closed_by: string | null; closed_at: number | null; close_note: string | null;
  /** Items it holds now (marked), and its submission: the open (or last) replan proposal. */
  items: number; proposal: { id: string; status: ProposalStatus; agent_id: string | null; created_at: number; note: string | null } | null;
}
export interface DiffItem { key: string; kind: string; title: string; status: string | null }
/** A re-plan's before/after against its snapshot: what the operator reviews. */
export interface ReplanDiff {
  added: DiffItem[]; removed: DiffItem[];
  changed: (DiffItem & { what: string[]; was: { title: string; status: string | null; body: string | null; parent_key: string | null } })[];
  unchanged: number; links: { added: string[]; removed: string[] };
}
/** An agent's team in a project and its blueprint role. */
export interface Seat { team: { id: string; name: string; status: string; paused_reason: string | null }; role: BpRole }
/** What an agent's write did: applied (the new version) or filed as one proposal for the operator. */
export type SubmitResult = ({ status: 'applied'; rule?: BpRule } & WriteResult) | { status: 'proposed'; proposal: Proposal; why: string[] };

/** What a write would do (check mode, §4): nothing is written or proposed. */
export interface CheckResult {
  outcome: 'apply' | 'propose' | 'refused';
  /** Each op's verdict and its reason, numbered from 1. */
  ops: { op: number; key: string; verdict: Verdict; why: string }[];
  /** What the dry run added, changed, removed and allocated; null when it was refused before or during the run. */
  would: Pick<WriteResult, 'added' | 'changed' | 'removed' | 'keys' | 'moves'> | null;
  /** The reasons for propose or deny. */
  why: string[];
  /** Every refused op (or the one refusal), in the write's own words. */
  problems: string[];
  /** The error code a refused write would get (invalid_argument, conflict, denied, lockdown, paused, …). */
  code?: string;
  conflict?: { keys: string[]; current_version: number | null };
  /** When the write would propose and the open-proposal limit is reached. */
  limit?: string;
}
/** A restore's input (§4.2): an export's text and the scope. */
export interface RestoreIn {
  text: string; team_id?: string | null; tracks?: string[]; remove_missing?: boolean;
  /** The pre-reset backup to read authorship from: a file name in the backup folder (operator only). */
  backup?: string | null;
  /** Backup agent id → agent id: a verified agent writer is credited to the agent it names. */
  authors?: Record<string, string>;
  /** File team id → team id of the destination project. */
  team_map?: Record<string, string>;
}
/** What a restore does, before it runs: its ops and the counts the operator reviews. */
export interface RestorePlan {
  format: 'json' | 'markdown'; from_project: string | null;
  ops: Op[];
  added: string[]; restored: string[]; changed: string[]; unchanged: number; removed: string[];
  links: { added: number; removed: number }; skipped_links: string[];
  /** Items of the file outside the scope, and status reports, which are never restored. */
  left_out: number;
  lost: string[];
  /** Where it goes: the destination project and its version, which is the base version to apply against. */
  destination: { project: string; version: number };
  base_version: number;
  /** The hub's hash of the text, scope, backup and maps: with the base version, what makes a retry the same restore. */
  digest: string;
  /** Each team the file names and where its items go: the same team, a mapped one, or the hub's (null: project level). */
  teams: { from: string; to: string | null; how: 'same' | 'mapped' | 'not_in_project' }[];
  /** Authorship of the items the restore writes: verified from the backup or the hub's own records, or L2. */
  authors: { backup: string | null; verified: number; from_backup: number; from_hub: number; l2: number; unverified: string[] };
  /** Keys the hub holds as another kind. */
  collisions: string[];
  /** Items whose parent neither the file nor the hub holds. */
  unknown_refs: string[];
  /** The earlier result of this same restore, if it was applied before. */
  prior: { base_version: number; version: number | null; at: number } | null;
}
export type RestoreResult =
  | { status: 'checked'; plan: RestorePlan; outcome: 'apply' | 'propose' | 'refused'; would: CheckResult['would']; problems: string[]; limit?: string }
  | { status: 'applied'; plan: RestorePlan; result: WriteResult | null; retried?: boolean }
  | { status: 'proposed'; plan: RestorePlan; proposal: Proposal };
export const RESTORE_NOTE = 'restored from the export';
/** Wired by app.ts: notices to agents, alerts to the operator, lockdown flags. Without them the service skips notices. */
export interface BpDeps {
  keys?: Keys; audit?: Audit; lockdown?: Lockdown; exportMd?: (projectId: string) => string;
  /** The folder of database backups a restore may read authorship from (§4.2). */
  backupDir?: string;
  /** Directive reach follows a team's project (docs/directives.md#project-reach): runs a change, then tells the members what they gained or lost. */
  reach?: <T>(agentIds: string[], fn: () => T) => T;
}
/** A backup a restore reads: a plain file name ending .db, never a path. */
const BACKUP_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,118}\.db$/;
/** Open proposals allowed at once (§2.6). */
export const MAX_OPEN_PROPOSALS = { agent: 5, project: 20 };
/** Team statuses that no longer count as live when a call's project is resolved (§3, keys are per project). */
const ENDED_TEAM: readonly string[] = ['done', 'stopped'];
/** A team_ask answer to record as a decision entry (§4). */
export interface AskAnswer {
  id: string; team_id: string; question: string; context: string | null; options: { key: string; label: string; effect?: string | null }[];
  refs: string[]; answer_label: string | null; answer_text: string | null; answered_at: number | null; make_decision: boolean;
}
const OPERATOR_ERRORS = new Set(['invalid_argument', 'conflict', 'not_found']);

/** The kinds in each section (§1), for `bp_read {section}`. */
export const SECTION_KINDS: Record<number, string[]> = {
  1: ['summary', 'stakeholder'], 2: ['module', 'fr', 'nfr', 'ac', 'line', 'hypothesis', 'question', 'finding'], 3: ['architecture', 'decision'],
  4: ['milestone', 'release', 'paper', 'claim'], 5: ['report', 'risk', 'issue'], 6: ['term', 'reference'],
};
export interface ReadQuery {
  section?: number; track?: string; keys?: string[]; kinds?: string[]; status?: string[]; detail?: 'index' | 'full'; since_version?: number;
  scope?: 'part' | 'project'; cursor?: number; limit?: number;
  /** Admin reads (§6): one team's part only (`project` for project-level items), and words matched in key, title and body. */
  team?: string; q?: string;
  /** Items with this outside reference, "system:id" or "system:*" (§2.2); like keys, read wherever they sit. */
  external?: string;
  /** Only items the operator cannot read plainly yet (§2.2, E2), each with `plain_issues`. */
  plain?: 'issues';
}
export interface ChainLink { key: string; kind: string; title: string; status: string | null; confidence?: string | null; from?: ChainLink[] }
export interface ReadItem {
  key: string; kind: string; title: string; status: string | null; parent: string | null; team_id: string | null; links: string[];
  /** Who last changed it (operator, import:<source>, agent:<id>), and the trust of its text for this reader (F-23). */
  updated_by: string; trust: Trust;
  /** The collaborator the writing agent ran for when it last changed the item (docs/checkout.md §9 F1). */
  via?: string;
  support?: Support; supported?: string; ready?: boolean; body?: string | null; fields?: Record<string, unknown>; rev?: number;
  created_by?: string; created_at?: number; updated_at?: number; chain?: ChainLink[]; claims?: unknown[];
  /** detail full: the author an export claimed for a restored item the hub could not verify (attribution only). */
  attributed_to?: string;
  /** The open re-plan that holds it. */
  replan?: string;
  /** With `plain: issues`: why the operator cannot read it plainly yet, one short line per issue. */
  plain_issues?: string[];
  /** With `detail: full`, for a paper, claim or hypothesis: the hub's standing line (E1), data only. */
  standing?: string;
  /** With `detail: full`, for a hypothesis: the hub's next step (§2.7), data only. */
  next?: string;
}
export interface ReadResult {
  project: { id: string; key: string; name: string; kind: string; status: string; version: number }; team_id: string | null;
  items: ReadItem[]; total: number; next_cursor: number | null; removed?: string[];
  /** The lowest trust among the items returned (L0 when none): what the whole answer may be taken as. */
  trust: Trust;
  /** An open re-plan of the reader's part: its note is the operator's (L0). */
  replan?: { id: string; team_id: string | null; kinds: string[]; source: string; items: number; note: string | null; submitted: string | null };
}
/** Report shape (§7): bullets per list, characters per bullet, characters in all. */
export const REPORT_SHAPE = { bullets: 3, bullet: 140, total: 1200 };
const HEALTH_RANK: Record<string, number> = { on_track: 0, at_risk: 1, off_track: 2 };
const DAY = 24 * 3600_000;
export interface ReportInput { health: string; done?: string[]; next?: string[]; blockers?: string[]; escalate?: boolean; refs?: string[] }
/** The hub's facts on a report: what moved since the previous one, and the support of the team's claims (to compare next time). */
export interface ReportFacts {
  since: number | null; tasks_done: string[]; tasks_moved: number; moved: string[]; claims: string[];
  /** The team's team_ask questions still waiting for an answer (open or needs_info), not blueprint `question` items. */
  open_team_asks: string[];
  support: Record<string, Support>;
  /** Each coverage list's count for the team's part, its No task list counted from the team's own tasks (§6, §7). */
  coverage?: ReturnType<typeof coverageCounts>;
  /** How many open issues and questions of the team's part block an open item (§7). */
  blocking?: number;
}
export interface SupportChange { key: string; was: Support | null; now: Support | null }
/** A live claim with its support and the live items linked to it as evidence. */
export interface ClaimRowState extends ClaimState {
  title: string; parent: string | null; team_id: string | null; updated_at: number;
  evidence: { kind: string; key: string; status: string | null; fields: Record<string, unknown>; updated_at: number }[];
}

export interface WriteResult {
  version: number; added: string[]; removed: string[]; changed: string[]; moves: EventRow['moves']; keys: Record<string, string>;
  /** Ready-made ops the writer may send next, never applied by themselves: a proposed decision for each answered question (§4). */
  offers?: Offer[];
  /** The team questions this write opened, one per requirement it marked unclear with the question's text in unclear_ask (§2.7). */
  asks?: { key: string; decision_id: string }[];
}
/** An op the hub offers after a write, with the reason in words. */
export interface Offer { why: string; op: Extract<Op, { op: 'upsert' }> }

/** Internal options: origin ids, timestamps and authorship per key, no event of its own, no version check. */
interface WriteOpts {
  origin?: Record<string, string>; at?: Record<string, number>; by?: Record<string, BpActor>;
  noEvent?: boolean; force?: boolean;
  /** Whose text the items carry when it is not the actor: a proposal applied by the operator keeps its proposer as the writer (F-23). */
  author?: BpActor; teamId?: string | null; note?: string | null; proposalId?: string | null;
  /** A dry run (check mode, a proposal being filed): questions an unclear mark asks are checked, never opened. */
  trial?: boolean;
  /** Keys the coordinator agreed under coordinator_decides_blueprint: their revision says so, and so does the event. */
  decided?: string[];
  /** Keys a rule the operator turned on applied (§4 Rules): their revision names the rule, and so does the event. */
  ruled?: { rule: BpRule; keys: string[] };
  /** A revision note per key, for a change the hub makes itself in the write (superseding on accept). */
  notes?: Record<string, string>;
  /** Keys a restore writes itself: a track's new team does not add a retagging revision to them (one revision per item, §4.2). */
  restoring?: Set<string>;
}
/** The revision note of a requirement its coordinator agreed under the team setting; the console offers Undo on it. */
export const DECIDED_NOTE = 'agreed by the coordinator (team setting)';

/** All or nothing, also inside a caller's transaction (a savepoint), so a failed step never leaves half a write. */
let sp = 0;
function atomic<T>(db: Db, fn: () => T): T {
  if (!db.isTransaction) return tx(db, fn);
  const name = `bp_${++sp}`;
  db.exec(`SAVEPOINT ${name}`);
  try { const r = fn(); db.exec(`RELEASE ${name}`); return r; }
  catch (e) { db.exec(`ROLLBACK TO ${name}`); db.exec(`RELEASE ${name}`); throw e; }
}

const parse = <T>(s: string | null | undefined, d: T): T => { try { return s ? JSON.parse(s) as T : d; } catch { return d; } };
const toItem = (r: ItemRow): Item => ({ ...r, fields: parse(r.fields, {}) });
const toProposal = (r: any): Proposal => ({ ...r, ops: parse(r.ops, []), revs: parse(r.revs, {}), type: r.type ?? 'ops', replan_id: r.replan_id ?? null,
  request_id: r.request_id ?? null, declined: parse(r.declined, null), applied_ops: r.applied_ops ?? null });
/** The kinds, in section order (§1): bp_read lists items in this order, and errors name them. */
export const KIND_ORDER: string[] = Object.values(SECTION_KINDS).flat();
/** The SQL order of bp_items: section, then position and key. */
const SECTION_ORDER = `CASE kind ${KIND_ORDER.map((k, i) => `WHEN '${k}' THEN ${i}`).join(' ')} ELSE ${KIND_ORDER.length} END, position, key`;
const unknownKind = (k: string) => err('invalid_argument', `Unknown kind ${k}; kinds are ${KIND_ORDER.join(', ')}. ${RULES_HINT}`, { kinds: KIND_ORDER });
function checkEvidence(v: string): void {
  try {
    for (const r of scanRefs(v)) if (r.kind === 'bp') throw new RefError(`Evidence that is another item is a link: bp_write {op: link, from: ${r.key}, rel: evidence} (or governs, delivers…), not bp:${r.key} in a field.`);
  } catch (e) { if (e instanceof RefError) throw err('invalid_argument', `Field evidence: ${e.message}`); throw e; }
}
/** Trust of an item's text (F-23): the operator, the import and the hub are L0; an agent of the reader's team L1; any other agent L2. */
export type Trust = 'L0' | 'L1' | 'L2';
export const lowestTrust = (ts: Trust[]): Trust => (ts.includes('L2') ? 'L2' : ts.includes('L1') ? 'L1' : 'L0');
const actorText = (kind: string, id: string | null) => `${kind}${id ? `:${id}` : ''}`;
const L0_WRITERS = new Set(['operator', 'import', 'system']);
/** The lower of the creator's and the last writer's trust: an operator's status move does not vouch for an agent's title. */
function itemTrust(r: ItemRow, mates: Set<string>): Trust {
  // Only the operator, the import and the hub are L0; any other writer, an unnamed agent included, is L2 unless a mate's.
  const one = (kind: string, id: string | null): Trust => (L0_WRITERS.has(kind) ? 'L0' : kind === 'agent' && id && mates.has(id) ? 'L1' : 'L2');
  return lowestTrust([one(r.created_by_kind, r.created_by_id), one(r.updated_by_kind, r.updated_by_id)]);
}
const auditActor = (a: BpActor) => ({ kind: a.kind === 'operator' ? 'admin' as const : a.kind === 'agent' ? 'agent' as const : 'system' as const, id: a.id });

/** The id of a team question (team_ask): dec_ and its token. Any other text in unclear_ask is the question itself (§2.7). */
const ASK_ID = /^dec_[A-Za-z0-9]{4,}$/;
/** What rule unclear_needs_ask asks for, in words: the question itself, or the id of an open one naming the item. */
const unclearHow = (key: string) => `Put your question to the operator in unclear_ask, as its text or as {question, options, recommended}, and the write asks it for you, naming ${key}. Or give the id of an open team_ask of your team that names ${key} in refs.`;

/** A decision item read as a design: who wrote it and who last changed its review come from its revisions. */
export interface Design { item: Item; project_id: string; written_by: { kind: string; id: string | null } | null; reviewed_by: { kind: string; id: string | null; at: number } | null; stale: boolean }
export class Blueprint {
  limits: BpLimits;
  deps: BpDeps = {};
  /** A proposal of a team closed (applied, rejected, withdrawn or stale): its tasks' pending refs are settled (docs/blueprint.md §2.3). */
  onProposalClosed?: (teamId: string, proposalId: string, status: string) => void;
  /** An applied write added these keys: tasks of the project's teams that named them while pending get them live (§2.3). */
  onKeysAdded?: (projectId: string, keys: string[]) => void;
  /** Opens (or, dry, checks) the team question an agent's unclear mark asks in its own write (Decisions.askForItem, §2.7). */
  onItemAsk?: (a: ItemAsk) => void;
  /** The questions a write's unclear marks ask, opened once all its ops are in. */
  private readonly asksOf = new WeakMap<WriteResult, Omit<ItemAsk, 'dry' | 'capped'>[]>();
  constructor(private readonly db: Db, limits: Partial<BpLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    // bp_read's text search folds case as JavaScript does, not only ASCII as SQLite's lower() does.
    db.function('bp_fold', { deterministic: true }, (v) => String(v ?? '').toLowerCase());
  }
  /** Settings (§6): the operator's limits over the defaults; a lower limit refuses writes until the blueprint fits. */
  setLimits(limits: Partial<BpLimits>): BpLimits { this.limits = { ...DEFAULT_LIMITS, ...limits }; return this.limits; }

  // ───── projects ─────
  project(id: string): ProjectRow | undefined { return this.db.prepare('SELECT * FROM projects WHERE id=?').get(id) as ProjectRow | undefined; }
  projectByKey(key: string): ProjectRow | undefined { return this.db.prepare('SELECT * FROM projects WHERE key=?').get(key) as ProjectRow | undefined; }
  projects(): ProjectRow[] { return this.db.prepare('SELECT * FROM projects ORDER BY created_at, key').all() as unknown as ProjectRow[]; }
  projectOfTeam(teamId: string): ProjectRow | undefined {
    return this.db.prepare('SELECT p.* FROM projects p JOIN teams t ON t.project_id=p.id WHERE t.id=?').get(teamId) as ProjectRow | undefined;
  }

  createProject(a: { key: string; name: string; kind?: 'implementation' | 'research'; version?: number; at?: number; single_team?: boolean; parent_id?: string | null }, actor: BpActor): ProjectRow {
    if (!/^[A-Z]{2,8}$/.test(a.key)) throw err('invalid_argument', 'A project key is 2 to 8 capital letters, e.g. CNV.');
    const name = a.name.trim();
    if (!name || name.length > 200) throw err('invalid_argument', 'A project needs a name of at most 200 characters.');
    const kind = a.kind ?? 'implementation';
    if (kind !== 'implementation' && kind !== 'research') throw err('invalid_argument', 'A project kind is implementation or research.');
    if (this.projectByKey(a.key)) throw err('conflict', `Project key ${a.key} is taken.`);
    if (a.parent_id) this.checkParent(null, a.parent_id);
    const id = `prj_${randomToken(10)}`, at = a.at ?? Date.now();
    this.db.prepare('INSERT INTO projects(id,key,name,kind,version,created_by_kind,created_by_id,created_at,updated_at,single_team,parent_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, a.key, name, kind, a.version ?? 0, actor.kind, actor.id, at, at, a.single_team ? 1 : 0, a.parent_id ?? null);
    return this.project(id)!;
  }

  // ───── project settings (§3): single team, ecosystem, kind ─────
  /** The teams that contribute to a project: every team in it that is not stopped. */
  contributingTeams(projectId: string): { id: string; name: string }[] {
    return this.db.prepare("SELECT id, name FROM teams WHERE project_id=? AND status<>'stopped' ORDER BY created_at, id").all(projectId) as { id: string; name: string }[];
  }
  /** The projects of an ecosystem. */
  children(projectId: string): ProjectRow[] {
    return this.db.prepare('SELECT * FROM projects WHERE parent_id=? ORDER BY name, key').all(projectId) as unknown as ProjectRow[];
  }
  /** An ecosystem is a project that has projects in it: it holds only its Foundation and their overview. */
  isEcosystem(projectId: string): boolean { return !!this.db.prepare('SELECT 1 FROM projects WHERE parent_id=? LIMIT 1').get(projectId); }

  /**
   * May this team join project p? An ecosystem has no teams of its own, and a single-team project accepts no second
   * contributing team. Said in words here; the database's triggers (0114) refuse the same for every write path.
   */
  private checkTeamJoins(p: ProjectRow, teamId: string): void {
    if (this.isEcosystem(p.id)) throw err('invalid_state', `${p.name} is an ecosystem: it groups projects and has no teams of its own. Put the team in one of its projects.`);
    if (!p.single_team) return;
    const other = this.contributingTeams(p.id).filter((t) => t.id !== teamId);
    if (other.length) throw err('conflict', `${p.name} is a single-team project, and ${other[0]!.name} already works on it. Add agents to that team, or turn off Single team in the project's settings first.`, { project_id: p.id, teams: other });
  }

  /** May project p (null for a new one) sit in the ecosystem parentId? One level deep, never itself, and the ecosystem has only its Foundation. */
  private checkParent(p: ProjectRow | null, parentId: string): ProjectRow {
    const parent = this.project(parentId);
    if (!parent) throw err('not_found', 'No such ecosystem.');
    if (p && parent.id === p.id) throw err('invalid_argument', 'A project cannot be its own ecosystem.');
    if (parent.parent_id) throw err('invalid_argument', `${parent.name} sits in an ecosystem itself. Ecosystems are one level deep.`);
    if (p && this.isEcosystem(p.id)) throw err('invalid_argument', `${p.name} is an ecosystem itself. Ecosystems are one level deep.`);
    const teams = this.db.prepare('SELECT name FROM teams WHERE project_id=? ORDER BY created_at').all(parent.id) as { name: string }[];
    if (teams.length) throw err('invalid_state', `${parent.name} has teams (${teams.map((t) => t.name).join(', ')}). An ecosystem has no teams of its own: choose a project without teams, or create a new one for the ecosystem.`);
    const other = (this.db.prepare(`SELECT COUNT(*) n FROM bp_items WHERE project_id=? AND deleted_at IS NULL AND kind NOT IN (${[...ECOSYSTEM_KINDS].map(() => '?').join(',')})`).get(parent.id, ...ECOSYSTEM_KINDS) as { n: number }).n;
    if (other) throw err('invalid_state', `${parent.name} has ${other} Blueprint items beyond its Foundation. An ecosystem holds only its Foundation and the overview of its projects.`);
    return parent;
  }

  /** What changes and what stays when a project's kind changes, shown before the save (§3). */
  kindEffects(id: string, kind: 'implementation' | 'research') {
    const p = this.project(id);
    if (!p) throw err('not_found', 'No such project.');
    if (kind !== 'implementation' && kind !== 'research') throw err('invalid_argument', 'A project kind is implementation or research.');
    const n = (sql: string) => (this.db.prepare(sql).get(p.id) as { n: number }).n;
    const items = n('SELECT COUNT(*) n FROM bp_items WHERE project_id=? AND deleted_at IS NULL');
    const tracks = n("SELECT COUNT(*) n FROM bp_items WHERE project_id=? AND deleted_at IS NULL AND kind IN ('module','line')");
    const links = n('SELECT COUNT(*) n FROM bp_links WHERE project_id=?');
    const label = (k: string) => (k === 'research' ? 'Research' : 'Implementation');
    const same = kind === p.kind;
    return {
      project: { id: p.id, key: p.key, name: p.name }, from: p.kind, to: kind, populated: items > 0,
      keeps: { items, tracks, links },
      changes: same ? [] : [
        `The Blueprint opens on the ${kind === 'research' ? 'research lines, hypotheses and findings' : 'requirements and acceptance criteria'} instead of the ${p.kind === 'research' ? 'research lines' : 'requirements'}.`,
        `The project card measures ${kind === 'research' ? 'hypotheses decided and findings' : 'requirements verified and acceptance criteria passing'}.`,
        `A team that joins from now on starts with a ${kind === 'research' ? 'validate line' : 'module'}.`,
      ],
      keeps_text: same ? [] : [`Every existing track, item and link stays as it is (${items} items, ${tracks} tracks, ${links} links), and browse and export find them as before.`, `${label(p.kind)} items can still be added, and either kind may publish a paper.`],
    };
  }

  /** What would be left behind or reinterpreted if this team left its project (§3): its part's content, open proposals, open tasks with Blueprint refs. */
  teamDependencies(teamId: string, projectId: string): TeamDependencies {
    const items = (this.db.prepare(`SELECT i.key FROM bp_items i WHERE i.project_id=? AND i.team_id=? AND i.deleted_at IS NULL
      AND NOT (i.parent_key IS NULL AND i.kind IN ('module','line') AND NOT EXISTS (SELECT 1 FROM bp_items c WHERE c.project_id=i.project_id AND c.parent_key=i.key AND c.deleted_at IS NULL))
      ORDER BY i.key LIMIT 50`).all(projectId, teamId) as { key: string }[]).map((r) => r.key);
    const proposals = (this.db.prepare("SELECT id FROM bp_proposals WHERE project_id=? AND team_id=? AND status='open' ORDER BY created_at LIMIT 50").all(projectId, teamId) as { id: string }[]).map((r) => r.id);
    const tasks = this.db.prepare(`SELECT id, title FROM tasks WHERE team_id=? AND ${OPEN_TASK} AND plan_refs NOT IN ('[]','') ORDER BY created_at LIMIT 50`).all(teamId) as { id: string; title: string }[];
    return { items, proposals, tasks };
  }

  /** A project key from a name: its initials (or first letters), made unique with a letter suffix. */
  suggestKey(name: string): string {
    const words = name.toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').split(/\s+/).filter((w) => /[A-Z]/.test(w));
    let base = words.length > 1 ? words.map((w) => w.replace(/[^A-Z]/g, '')[0]).join('') : (words[0] ?? '').replace(/[^A-Z]/g, '');
    if (base.length < 2) base = (words.join('').replace(/[^A-Z]/g, '') + 'PRJ').slice(0, 3);
    base = base.slice(0, 6);
    if (!this.projectByKey(base)) return base;
    for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') for (const d of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') { const k = `${base}${c}${d}`.slice(0, 8); if (!this.projectByKey(k)) return k; }
    throw err('conflict', 'No free project key.');
  }

  /**
   * The team's project (§3). A team created with a project name (onboarding, team_create) joins the open project of that
   * name, or starts one with that name; a team without a project name gets its own project, named after the team.
   */
  ensureTeamProject(teamId: string, actor: BpActor = { kind: 'import', id: null }): ProjectRow { return this.reached(teamId, () => this.ensureTeamProject_(teamId, actor)); }
  /** Runs a change of the team's project through the directive reach refresh, for the team's live members. */
  private reached<T>(teamId: string, fn: () => T): T {
    if (!this.deps.reach) return fn();
    const ids = (this.db.prepare('SELECT agent_id a FROM team_members WHERE team_id=? AND removed_at IS NULL').all(teamId) as { a: string }[]).map((r) => r.a);
    return this.deps.reach(ids, fn);
  }
  private ensureTeamProject_(teamId: string, actor: BpActor): ProjectRow {
    const t = this.db.prepare('SELECT id, name, project, project_id, created_at FROM teams WHERE id=?').get(teamId) as { id: string; name: string; project: string | null; project_id: string | null; created_at: number } | undefined;
    if (!t) throw err('not_found', 'No such team.');
    if (t.project_id) return this.project(t.project_id)!;
    const named = t.project?.trim() || null;
    return atomic(this.db, () => {
      const same = named ? this.db.prepare("SELECT * FROM projects WHERE lower(name)=lower(?) AND status<>'closed' ORDER BY created_at LIMIT 1").get(named) as ProjectRow | undefined : undefined;
      if (same) {
        this.checkTeamJoins(same, t.id); // a single-team project or an ecosystem refuses the approval, all of it
        this.db.prepare('UPDATE teams SET project_id=? WHERE id=?').run(same.id, t.id);
        // A team joining a tagged project takes its tags, not the hub default (Research & Development) a new team gets.
        const tags = this.db.prepare('SELECT keyword, position FROM project_keywords WHERE project_id=? ORDER BY position').all(same.id) as { keyword: string; position: number }[];
        if (tags.length) {
          this.db.prepare('DELETE FROM team_keywords WHERE team_id=?').run(t.id);
          for (const k of tags) this.db.prepare('INSERT INTO team_keywords(team_id, keyword, position) VALUES (?,?,?)').run(t.id, k.keyword, k.position);
        }
        return same;
      }
      const name = named ?? t.name;
      const p = this.createProject({ key: this.suggestKey(name), name, at: t.created_at }, actor);
      this.db.prepare('UPDATE teams SET project_id=? WHERE id=?').run(p.id, t.id);
      return p;
    });
  }

  /**
   * Open a team's part when the operator approves the team (ADR-001, §4): a track named after the team, owned by it, a
   * module in an implementation project and a validate line in a research one. Its coordinator's first plan then
   * applies as drafts inside it instead of reaching the operator as one proposal. A team that already owns a track, or
   * whose project is closed, keeps what it has. A project's only team gets no part unless more teams will join and the
   * project is not set to Single team (FR-PLAN-12, §3): its whole Blueprint stays at project level. Returns the new
   * track's key, or null.
   */
  openTeamPart(teamId: string, actor: BpActor, o: { moreTeams?: boolean } = {}): string | null {
    const p = this.ensureTeamProject(teamId, actor);
    if (p.status === 'closed') return null;
    // A project set to Single team never gets a second team, so it is a one-team project whatever onboarding said.
    if ((!o.moreTeams || p.single_team) && this.soleTeam(p.id) === teamId) return null;
    const t = this.db.prepare('SELECT id, name, goal FROM teams WHERE id=?').get(teamId) as { id: string; name: string; goal: string | null };
    const owned = this.db.prepare("SELECT 1 FROM bp_items WHERE project_id=? AND team_id=? AND kind IN ('module','line') AND deleted_at IS NULL LIMIT 1").get(p.id, t.id);
    if (owned) return null;
    const research = p.kind === 'research';
    const key = research ? `L${this.maxNumber(p.id, 'L') + 1}` : this.trackKey(p.id, t.name);
    const op: Op = { op: 'upsert', kind: research ? 'line' : 'module', key, title: t.name.trim().slice(0, 200) || key, team_id: t.id,
      ...(research ? { status: 'active', fields: { mode: 'validate' } } : {}) };
    return atomic(this.db, () => {
      this.apply(p.id, [op], actor, { force: true, note: 'part opened when the team was approved', teamId: t.id });
      return key;
    });
  }
  /**
   * How much a team's part holds beyond its own track (docs/onboarding.md#setup-progress): live, non-archived items inside
   * the module or line the team owns, or owned by the team and not a module or line; for a project's only team (no part,
   * FR-PLAN-12) its project-level items too. Dropped and cut items do not count. Right after approval it is 0.
   */
  setupContent(teamId: string): number {
    const t = this.db.prepare('SELECT project_id FROM teams WHERE id=?').get(teamId) as { project_id: string | null } | undefined;
    if (!t?.project_id) return 0;
    const live = "deleted_at IS NULL AND archived=0 AND COALESCE(status,'') NOT IN ('dropped','cut')";
    const sole = this.soleTeam(t.project_id) === teamId ? " OR (team_id IS NULL AND kind NOT IN ('module','line'))" : '';
    return (this.db.prepare(`SELECT COUNT(*) n FROM bp_items WHERE project_id=? AND ${live} AND ((team_id=? AND kind NOT IN ('module','line')) OR parent_key IN (SELECT key FROM bp_items WHERE project_id=? AND team_id=? AND kind IN ('module','line') AND deleted_at IS NULL)${sole})`)
      .get(t.project_id, teamId, t.project_id, teamId) as { n: number }).n;
  }
  /** An open project's kind and live modules, by name (case-insensitive), for checking an onboarding request; null when none. */
  projectInfo(name: string): { kind: 'implementation' | 'research'; modules: string[] } | null {
    const p = this.db.prepare("SELECT id, kind FROM projects WHERE lower(name)=lower(?) AND status<>'closed' ORDER BY created_at LIMIT 1").get(name) as { id: string; kind: 'implementation' | 'research' } | undefined;
    if (!p) return null;
    const modules = (this.db.prepare("SELECT key FROM bp_items WHERE project_id=? AND kind='module' AND deleted_at IS NULL ORDER BY key").all(p.id) as { key: string }[]).map((r) => r.key);
    return { kind: p.kind, modules };
  }
  /**
   * A new project created by an onboarding approval takes the kind its request asked for, before the team's part opens
   * (docs/onboarding.md#the-request). Only a project with nothing in it yet changes; any other keeps its kind.
   */
  setNewProjectKind(teamId: string, kind: 'implementation' | 'research', actor: BpActor): void {
    const p = this.ensureTeamProject(teamId, actor);
    if (p.kind === kind) return;
    if ((this.db.prepare('SELECT COUNT(*) n FROM bp_items WHERE project_id=?').get(p.id) as { n: number }).n) return;
    this.db.prepare('UPDATE projects SET kind=?, updated_at=? WHERE id=?').run(kind, Date.now(), p.id);
  }
  /**
   * The requirements and research records a new team's onboarding request filed and the operator kept
   * (docs/onboarding.md#content-from-onboarding): one proposal, filed by the approval and never applied by it, with each
   * item's intended scope. Requirements go into a module (the team's, or a named module of the project), never under a
   * line; lines go inside the team's line, with their hypotheses and questions; papers at project level, owned by the
   * team, or by no team when the team is its project's only one (FR-PLAN-12). Runs inside the approval's transaction. Returns null, filing nothing, when nothing was kept.
   */
  proposeOnboarding(teamId: string, track: string | null, c: { requirements?: readonly RequirementIn[]; research?: ResearchIn }, reason: string, actor: BpActor): { id: string; items: FiledItem[] } | null {
    const t = this.db.prepare('SELECT id, name, project_id FROM teams WHERE id=?').get(teamId) as { id: string; name: string; project_id: string | null } | undefined;
    const p = t?.project_id ? this.project(t.project_id) : undefined;
    if (!t || !p) throw err('not_found', 'The team has no project.');
    const NFR_FIELD = { perf: 'performance', sec: 'security', rel: 'reliability', use: 'usability', ops: 'operations' } as const;
    const ops: Op[] = [], items: FiledItem[] = [], next = new Map<string, number>();
    // A project's only team has no part (FR-PLAN-12): its track is a project-level home named after it (projectLevelHome)
    // that this proposal opens first, with no team_id, so applying it opens the home and files the records in one step.
    const research = p.kind === 'research';
    // A project's only team with no part (it did not ask for more teams) owns no papers either, with or without lines in the
    // brief: they stay the project's if a second team joins.
    const atProject = this.soleTeam(p.id) === t.id && !this.db.prepare("SELECT 1 FROM bp_items WHERE project_id=? AND team_id=? AND kind IN ('module','line') AND deleted_at IS NULL LIMIT 1").get(p.id, t.id);
    const opens = !!track && !this.liveRow(p.id, track) && this.projectLevelHome(t.id) === track;
    const homeRow = (k: string | null | undefined) => (opens && k === track ? { kind: research ? 'line' : 'module', team_id: null as string | null, parent_key: null as string | null } : k ? this.liveRow(p.id, k) : undefined);
    if (opens && (research ? c.research?.lines.length : c.requirements?.length)) ops.push({ op: 'upsert', kind: research ? 'line' : 'module', key: track!, title: t.name.trim().slice(0, 200) || track!, team_id: null, ...(research ? { status: 'active', fields: { mode: 'validate' } } : {}) });
    // Keys in the order filed: each prefix continues after the project's highest, deleted keys included.
    const key = (prefix: string, pad = 2) => { const n = (next.get(prefix) ?? this.maxNumber(p.id, prefix)) + 1; next.set(prefix, n); return prefix + String(n).padStart(pad, '0'); };
    for (const q of c.requirements ?? []) {
      const moduleKey = q.module ?? track;
      const mod = homeRow(moduleKey);
      if (!moduleKey || !mod || mod.kind !== 'module') {
        throw err('invalid_argument', `requirements: "${q.title}" needs a module of project ${p.key}; a requirement is never put under a line. Name a module, or untick it to approve.`);
      }
      const scope = mod.team_id === t.id ? 'team' : 'project';
      const k = q.kind === 'fr' ? key(`FR-${moduleKey}-`) : key(`NFR-${q.category!.toUpperCase()}-`);
      ops.push({ op: 'upsert', kind: q.kind, key: k, parent_key: moduleKey, title: q.title, body: q.text, status: 'draft', ...(q.kind === 'nfr' ? { fields: { category: NFR_FIELD[q.category!] } } : {}) });
      items.push({ key: k, kind: q.kind, title: q.title, scope });
      (q.acs ?? []).forEach((a, i) => ops.push({ op: 'upsert', kind: 'ac', key: `${k}/AC${i + 1}`, parent_key: k, title: a, status: 'open' }));
    }
    const r = c.research;
    const hypKey = new Map<string, string>();
    if (r?.lines.length) {
      const home = homeRow(track);
      if (!track || !home || home.kind !== 'line' || home.parent_key) throw err('invalid_argument', `research.lines: the team has no line in project ${p.key} to hold them (lines need a research project). Untick them to approve.`);
      for (const l of r.lines) {
        const lk = key(`${track}.`, 0);
        ops.push({ op: 'upsert', kind: 'line', key: lk, parent_key: track, title: l.title, status: 'active', fields: { mode: l.mode, ...(l.question ? { question: l.question } : {}) } });
        items.push({ key: lk, kind: 'line', title: l.title, scope: opens ? 'project' : 'team', ...(l.owner ? { owner: l.owner } : {}) });
        for (const h of l.hypotheses ?? []) {
          const hk = key(`H-${lk}-`);
          hypKey.set(h.id, hk);
          ops.push({ op: 'upsert', kind: 'hypothesis', key: hk, parent_key: lk, title: h.title, status: 'untested', fields: { statement: h.title, ...(h.criteria ? { criteria: h.criteria } : {}) } });
          items.push({ key: hk, kind: 'hypothesis', title: h.title, scope: opens ? 'project' : 'team' });
        }
        for (const q of l.questions ?? []) {
          const qk = key(`Q-${lk}-`);
          ops.push({ op: 'upsert', kind: 'question', key: qk, parent_key: lk, title: q.title, status: 'open', ...(q.criteria ? { fields: { criteria: q.criteria } } : {}) });
          items.push({ key: qk, kind: 'question', title: q.title, scope: opens ? 'project' : 'team' });
        }
      }
    }
    for (const pp of r?.papers ?? []) {
      const pk = key('PAP-', 0);
      const fields = { ...(pp.venue ? { venue: pp.venue } : {}), ...(pp.type ? { type: pp.type } : {}), ...(pp.manuscript ? { manuscript: pp.manuscript } : {}), ...(pp.authors?.length ? { authors: pp.authors } : {}) };
      ops.push({ op: 'upsert', kind: 'paper', key: pk, title: pp.title, status: pp.status, team_id: atProject ? null : t.id, ...(Object.keys(fields).length ? { fields } : {}) });
      items.push({ key: pk, kind: 'paper', title: pp.title, scope: atProject ? 'project' : 'team', ...(pp.owner ? { owner: pp.owner } : {}) });
      // A paper studies its hypotheses once the Blueprint has that relation; until then the request keeps them.
      if (RELS['studies']) for (const h of pp.hypotheses ?? []) { const hk = hypKey.get(h); if (hk && relAllows('studies', 'paper', 'hypothesis')) ops.push({ op: 'link', from: pk, to: hk, rel: 'studies' }); }
    }
    if (!ops.length) return null;
    const id = `bpp_${randomToken(10)}`;
    atomic(this.db, () => {
      this.dryRun(p.id, ops, actor, p.version);
      const revs = Object.fromEntries(ops.flatMap((o) => (o.op === 'upsert' ? [[o.key, null]] : [])));
      this.db.prepare("INSERT INTO bp_proposals(id,project_id,team_id,agent_id,ops,base_version,reason,status,created_at,revs) VALUES (?,?,?,NULL,?,?,?,'open',?,?)")
        .run(id, p.id, t.id, JSON.stringify(ops), p.version, reason.slice(0, 2000), Date.now(), JSON.stringify(revs));
    });
    const keys = this.opKeys(ops);
    this.deps.audit?.alert('info', 'bp_proposal', id, { project: p.key, team: t.name, agent: 'onboarding', ops: ops.length, keys });
    this.deps.audit?.event(auditActor(actor), 'blueprint.propose', { kind: 'bp_proposal', id }, { project: p.key, ops: ops.length, from: 'onboarding' });
    return { id, items };
  }
  /**
   * Where a project's only team files what its approval kept (FR-PLAN-12): a new project-level track, a module named after
   * the team or, in a research project, a validate line, its key as a part would get; the onboarding proposal opens it with
   * no team_id. Null when the team is not the project's only one or the project is closed.
   */
  projectLevelHome(teamId: string): string | null {
    const t = this.db.prepare('SELECT id, name, project_id FROM teams WHERE id=?').get(teamId) as { id: string; name: string; project_id: string | null } | undefined;
    const p = t?.project_id ? this.project(t.project_id) : undefined;
    if (!t || !p || p.status === 'closed' || this.soleTeam(p.id) !== t.id) return null;
    return p.kind === 'research' ? `L${this.maxNumber(p.id, 'L') + 1}` : this.trackKey(p.id, t.name);
  }
  /**
   * The project's only team, or null when it has none or several (FR-PLAN-12, §3). While a project has one team, its
   * project-level items are that team's own (rights), its reads and summary cover the whole project, and the part
   * limit gives way to the project limit. Every team that names the project counts unless it is stopped.
   */
  /** The Questions view (§6) of a team's part, or of the whole project when `teamId` is null or the project's only team. */
  questionsOf(projectId: string, teamId: string | null): Questions {
    const all = this.items(projectId);
    const part = !!teamId && this.soleTeam(projectId) !== teamId;
    return questions(part ? all.filter((i) => i.team_id === teamId) : all, all, this.links(projectId), this.project(projectId)?.kind === 'research');
  }

  /**
   * Coverage (§6) of a team's part, or of the whole project when `teamId` is null or the project's only team. `seen` is
   * the tasks the reader may see; the summary computes the same lists from its own items (views.ts).
   */
  coverageOf(projectId: string, teamId: string | null, seen: TasksSeen): Coverage {
    const all = this.items(projectId);
    const part = !!teamId && this.soleTeam(projectId) !== teamId;
    return coverage(this.db, projectId, part ? all.filter((i) => i.team_id === teamId) : all, all, this.links(projectId), seen);
  }

  soleTeam(projectId: string | null): string | null {
    if (!projectId) return null;
    const rows = this.db.prepare("SELECT id FROM teams WHERE project_id=? AND status<>'stopped' LIMIT 2").all(projectId) as { id: string }[];
    return rows.length === 1 ? rows[0]!.id : null;
  }
  /** One plain line for an answer that used a part option in a one-team project (FR-PLAN-12): use the project level instead. */
  oneTeamHint(projectId: string): string {
    const p = this.project(projectId);
    return `Project ${p?.key ?? projectId} has one team, so its whole Blueprint is at project level: read and write there, without scope: part or team_id.`;
  }
  /** A module key from a team name: its initials (or first letters), 2 to 6 capitals, unique in the project, deleted keys included. */
  private trackKey(projectId: string, name: string): string {
    const taken = (k: string) => !!this.db.prepare('SELECT 1 FROM bp_items WHERE project_id=? AND key=? LIMIT 1').get(projectId, k);
    const words = name.toUpperCase().replace(/[^A-Z ]+/g, ' ').split(/\s+/).filter(Boolean);
    let base = words.length > 1 ? words.map((w) => w[0]).join('') : (words[0] ?? '');
    if (base.length < 2) base = (words.join('') + 'TEAM').slice(0, 4);
    base = base.slice(0, 4);
    if (!taken(base)) return base;
    for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') for (const d of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') { const k = `${base}${c}${d}`; if (!taken(k)) return k; }
    throw err('conflict', 'No free module key.');
  }

  /** The operator renames a project, changes its kind or pauses, resumes or closes it (§6 PATCH). */
  updateProject(id: string, a: { name?: string; kind?: 'implementation' | 'research'; status?: 'active' | 'paused' | 'closed'; review_policy?: 'required' | 'per_task' | 'none'; task_intake?: 'backlog' | 'open'; member_board?: boolean; single_team?: boolean; parent_id?: string | null; external_systems?: unknown; status_meanings?: StatusMeanings }, actor: BpActor): ProjectRow {
    const p = this.project(id);
    if (!p) throw err('not_found', 'No such project.');
    const name = a.name === undefined ? p.name : a.name.trim();
    if (!name || name.length > 200) throw err('invalid_argument', 'A project needs a name of at most 200 characters.');
    const kind = a.kind ?? p.kind, status = a.status ?? p.status;
    if (kind !== 'implementation' && kind !== 'research') throw err('invalid_argument', 'A project kind is implementation or research.');
    if (!['active', 'paused', 'closed'].includes(status)) throw err('invalid_argument', 'A project status is active, paused or closed.');
    const policy = a.review_policy ?? p.review_policy;
    if (!['required', 'per_task', 'none'].includes(policy)) throw err('invalid_argument', 'A review policy is required, per_task or none.');
    const intake = a.task_intake ?? p.task_intake;
    if (!['backlog', 'open'].includes(intake)) throw err('invalid_argument', 'A task intake is backlog or open.');
    const board = a.member_board === undefined ? !!p.member_board : a.member_board;
    const single = a.single_team === undefined ? !!p.single_team : a.single_team;
    if (single && !p.single_team) {
      const teams = this.contributingTeams(p.id);
      if (teams.length > 1) throw err('conflict', `${p.name} has ${teams.length} teams (${teams.map((t) => t.name).join(', ')}). Single team keeps a project to one team: move the others to their own projects first. Nothing changed.`, { teams });
    }
    const parent = a.parent_id === undefined ? p.parent_id : a.parent_id;
    if (parent && parent !== p.parent_id) this.checkParent(p, parent);
    // Outside systems (§3): compared as stored, so saving the same list again changes nothing.
    const systems = a.external_systems === undefined ? (p.external_systems ?? null) : checkSystems(a.external_systems);
    const systemsChanged = systems !== (p.external_systems ?? null);
    // Status meanings (§3): only the statuses sent change; an empty sentence removes one. Checked whole before anything is written.
    const wasMeanings = statusMeanings(p), meanings: StatusMeanings = JSON.parse(JSON.stringify(wasMeanings)), meaningsChanged: string[] = [];
    for (const [k, m] of Object.entries(a.status_meanings ?? {})) {
      if (!(MEANING_KINDS as readonly string[]).includes(k)) throw err('invalid_argument', `Status meanings are for ${MEANING_KINDS.join(', ')}; ${k} has none.`);
      const kind = k as (typeof MEANING_KINDS)[number], statuses = KINDS[kind]!.statuses!;
      for (const [s, t] of Object.entries(m ?? {})) {
        if (!statuses.includes(s)) throw err('invalid_argument', `${kind} has no status ${s}; its statuses are ${statuses.join(', ')}.`);
        const text = String(t ?? '').replace(/\s+/g, ' ').trim();
        if (text.length > MEANING_MAX) throw err('invalid_argument', `What ${kind} ${s} means is one sentence of at most ${MEANING_MAX} characters; this one has ${text.length}.`);
        if ((wasMeanings[kind]?.[s] ?? '') === text) continue;
        meaningsChanged.push(`${kind}.${s}`);
        if (text) (meanings[kind] ??= {})[s] = text; else if (meanings[kind]) { delete meanings[kind]![s]; if (!Object.keys(meanings[kind]!).length) delete meanings[kind]; }
      }
    }
    const policyChanged = policy !== p.review_policy, intakeChanged = intake !== p.task_intake, boardChanged = board !== !!p.member_board;
    const singleChanged = single !== !!p.single_team, parentChanged = parent !== p.parent_id;
    const renamed = name !== p.name || kind !== p.kind || status !== p.status;
    if (!policyChanged && !intakeChanged && !boardChanged && !renamed && !singleChanged && !parentChanged && !systemsChanged && !meaningsChanged.length) return p;
    // Everything is checked above: the update and its notices are written whole, then audited.
    atomic(this.db, () => {
      this.db.prepare('UPDATE projects SET name=?, kind=?, status=?, review_policy=?, task_intake=?, member_board=?, single_team=?, parent_id=?, external_systems=?, status_meanings=?, updated_at=? WHERE id=?').run(name, kind, status, policy, intake, board ? 1 : 0, single ? 1 : 0, parent, systems, JSON.stringify(meanings), Date.now(), p.id);
      // The coordinators read the meanings with the rules: tell them they changed, not what they say (that is in the rules).
      if (meaningsChanged.length) this.notify(this.projectCoordinators(p.id), 'project_changed', `Project ${p.key}: the operator changed what ${meaningsChanged.map((x) => x.replace('.', ' ')).join(', ')} means. Read it with bp_read {rules: true}.`);
      // The review policy and the task intake are told to the coordinators (they change what task_create does).
      if (policyChanged) {
        const text = policy === 'required' ? 'every task needs review' : policy === 'per_task' ? 'the task creator decides whether a task needs review (task_create review)' : 'tasks need no review unless created with review "required"; a submitted task is approved at once';
        this.notify(this.projectCoordinators(p.id), 'project_changed', `Project ${p.key} review policy is now ${policy}: ${text} (set by the administrator).`);
      }
      if (intakeChanged) {
        const text = intake === 'backlog'
          ? 'new tasks land in the backlog until the operator accepts them; pass operator_request {source} on task_create when the operator asked for the task'
          : 'new tasks are open at once';
        this.notify(this.projectCoordinators(p.id), 'project_changed', `Project ${p.key} task intake is now ${intake}: ${text} (set by the administrator).`);
      }
      if (systemsChanged) {
        const names = parseSystems(systems).map((s) => s.system);
        this.notify(this.projectCoordinators(p.id), 'project_changed', `Project ${p.key} outside references now ${names.length ? `name only these systems: ${names.join(', ')}` : 'take any system'}; bp_read {rules: true} lists them (set by the administrator).`);
      }
      if (renamed) {
        // Every member of the project's teams (F-15): a pause or close refuses their writes; a resume or rename is news too.
        const what = status !== p.status
          ? (status === 'active' ? `is active again: writes and proposals work` : status === 'paused' ? 'is paused: the blueprint stays readable, writes and proposals wait until it resumes' : 'is closed: the blueprint stays readable, writes and proposals are refused')
          : `changed: ${[name !== p.name ? `now named "${name}"` : '', kind !== p.kind ? `now a ${kind} project` : ''].filter(Boolean).join(', ')}`;
        this.notify(this.projectMembers(p.id), status !== p.status && status !== 'active' ? 'project_paused' : 'project_changed', `Project ${p.key} ${what} (set by the administrator).`);
      }
    });
    // Each change is audited on its own.
    const who = auditActor(actor), target = { kind: 'project', id: p.id };
    if (policyChanged) this.deps.audit?.event(who, 'blueprint.review_policy', target, { key: p.key, from: p.review_policy, to: policy });
    if (intakeChanged) this.deps.audit?.event(who, 'blueprint.task_intake', target, { key: p.key, from: p.task_intake, to: intake });
    // Who may read the task board is an access change: audited, no notice to the agents (it changes nothing they do).
    if (boardChanged) this.deps.audit?.event(who, 'blueprint.member_board', target, { key: p.key, from: !!p.member_board, to: board });
    if (renamed) this.deps.audit?.event(who, 'blueprint.project_update', target, { key: p.key, ...(name !== p.name ? { name } : {}), ...(kind !== p.kind ? { kind, kind_from: p.kind } : {}), ...(status !== p.status ? { status } : {}) });
    if (singleChanged) this.deps.audit?.event(who, 'blueprint.single_team', target, { key: p.key, from: !!p.single_team, to: single });
    if (parentChanged) this.deps.audit?.event(who, 'blueprint.project_parent', target, { key: p.key, from: p.parent_id, to: parent });
    if (systemsChanged) this.deps.audit?.event(who, 'blueprint.external_systems', target, { key: p.key, from: parseSystems(p.external_systems), to: parseSystems(systems) });
    if (meaningsChanged.length) this.deps.audit?.event(who, 'blueprint.status_meanings', target, { key: p.key, changed: meaningsChanged });
    return this.project(p.id)!;
  }

  /**
   * The operator puts a team in a project and gives it its part (§6 PUT /api/teams/:id/project): `owns` names the
   * modules, lines and papers the team owns there, all of them; tracks and papers of the team not named go back to
   * project level. A team that moves leaves its old part at project level as history and starts its new part empty.
   */
  assignTeam(teamId: string, projectId: string, owns: string[], actor: BpActor): { project: ProjectRow; owns: string[]; released: string[]; moved_from: string | null } {
    return this.reached(teamId, () => this.assignTeam_(teamId, projectId, owns, actor));
  }
  private assignTeam_(teamId: string, projectId: string, owns: string[], actor: BpActor): { project: ProjectRow; owns: string[]; released: string[]; moved_from: string | null } {
    const t = this.db.prepare('SELECT id, project_id FROM teams WHERE id=?').get(teamId) as { id: string; project_id: string | null } | undefined;
    if (!t) throw err('not_found', 'No such team.');
    const p = this.project(projectId);
    if (!p) throw err('not_found', 'No such project.');
    const want = [...new Set(owns)];
    if (want.length > 200) throw err('invalid_argument', 'A part names at most 200 tracks and papers.');
    for (const k of want) {
      const r = this.liveRow(p.id, k);
      if (!r) throw err('invalid_argument', `${k} is not in the blueprint of ${p.key}.`);
      if (!KINDS[r.kind]!.track && r.kind !== 'paper') throw err('invalid_argument', `${k} is a ${r.kind}; a part is made of modules, lines and papers.`);
      if (r.parent_key !== null) throw err('invalid_argument', `${k} sits in ${r.parent_key} and takes its owner from it.`);
    }
    const ops = (rows: ItemRow[], team: string | null): Op[] => rows.map((r) => ({ op: 'upsert', kind: r.kind, key: r.key, team_id: team }));
    const note = 'part assigned by the operator';
    return atomic(this.db, () => {
      const from = t.project_id && t.project_id !== p.id ? t.project_id : null;
      if (t.project_id !== p.id) this.checkTeamJoins(p, t.id);
      if (from) {
        // A move to another project never releases or reinterprets work silently (§3): it is refused with what holds it.
        const dependencies = this.teamDependencies(t.id, from);
        if (dependencies.items.length || dependencies.proposals.length || dependencies.tasks.length) {
          const old = this.project(from)!;
          const said = [dependencies.items.length && `${dependencies.items.length} items of its part`, dependencies.proposals.length && `${dependencies.proposals.length} open proposals`, dependencies.tasks.length && `${dependencies.tasks.length} open tasks that refer to its Blueprint`].filter(Boolean).join(', ');
          throw err('conflict', `The team still has work in ${old.name}: ${said}. Moving it would release or reinterpret that work, so nothing changed. Finish, move or drop it first, or give the team a new project of its own.`, { dependencies, from: old.id });
        }
      }
      if (from) {
        // Everything of the team at the top of its old project goes back to project level (children follow).
        const top = this.db.prepare('SELECT * FROM bp_items WHERE project_id=? AND team_id=? AND parent_key IS NULL AND deleted_at IS NULL ORDER BY key').all(from, t.id) as unknown as ItemRow[];
        if (top.length) this.apply(from, ops(top, null), actor, { force: true, note });
      }
      this.db.prepare('UPDATE teams SET project_id=? WHERE id=?').run(p.id, t.id);
      if (from) {
        // A since_version held from the old project must not match this one's counter (F-15): the version jumps past
        // both, and every live item counts as changed at it, so a reader that held the old version gets the whole part.
        const jump = Math.max(p.version, this.project(from)!.version) + 1;
        this.db.prepare('UPDATE projects SET version=?, updated_at=? WHERE id=?').run(jump, Date.now(), p.id);
        this.db.prepare('UPDATE bp_items SET changed_version=? WHERE project_id=? AND deleted_at IS NULL').run(jump, p.id);
      }
      // In a one-team project an empty part means project level (FR-PLAN-12): every top-level item of the team goes back
      // there (risks and issues filed in the part too); children follow their track or paper.
      const whole = !want.length && this.soleTeam(p.id) === t.id;
      const held = this.db.prepare(`SELECT * FROM bp_items WHERE project_id=? AND team_id=? AND parent_key IS NULL AND deleted_at IS NULL${whole ? '' : " AND kind IN ('module','line','paper')"} ORDER BY key`).all(p.id, t.id) as unknown as ItemRow[];
      const release = held.filter((r) => !want.includes(r.key));
      const take = want.map((k) => this.liveRow(p.id, k)!).filter((r) => r.team_id !== t.id);
      if (release.length + take.length) this.apply(p.id, [...ops(release, null), ...ops(take, t.id)], actor, { force: true, note, teamId: t.id });
      const part = this.db.prepare("SELECT key FROM bp_items WHERE project_id=? AND team_id=? AND parent_key IS NULL AND deleted_at IS NULL AND kind IN ('module','line','paper') ORDER BY key").all(p.id, t.id) as { key: string }[];
      if (from || release.length || take.length) {
        const old = from ? this.project(from)! : null;
        this.notify(this.teamMembers(t.id), 'project_changed', old
          ? `Your team moved from project ${old.key} to ${p.key} (set by the administrator). Read the blueprint again in full: bp_read without since_version; versions from ${old.key} no longer apply. Your part: ${part.map((x) => x.key).join(', ') || 'none yet'}.`
          : `Your team's part of project ${p.key} changed (set by the administrator): ${part.map((x) => x.key).join(', ') || 'none'}.`);
      }
      // Where the team's new tasks land follows the project (task_intake; `open` with no project): tell its coordinators when that changes.
      const was = t.project_id ? this.project(t.project_id)?.task_intake ?? 'open' : 'open';
      if (was !== p.task_intake) {
        this.notify(this.coordinators(t.id), 'project_changed', p.task_intake === 'backlog'
          ? `Your team's new tasks now land in the backlog (project ${p.key}, set by the administrator): they wait until the operator accepts them. Pass operator_request {source} on task_create when the operator asked for the task.`
          : `Your team's new tasks now open at once (project ${p.key}, set by the administrator).`);
      }
      this.deps.audit?.event(auditActor(actor), 'blueprint.team_assign', { kind: 'team', id: t.id }, { project: p.key, owns: want.slice(0, 50), released: release.map((r) => r.key).slice(0, 50), ...(from ? { from } : {}) });
      return { project: this.project(p.id)!, owns: want, released: release.map((r) => r.key), moved_from: from };
    });
  }

  /**
   * The one way to ask for a status report (§6, §7). Project scope: every running team of an active project, or the one
   * team named (a decider asks their own team); recorded as a plan event, so Work in motion shows it. Team scope (the
   * team's status panel): that one team, whatever its state. Each team reports for its own part (F-04, §10): one request
   * row per notified team, open until that team's next report; another team's report leaves it open.
   */
  requestReport(projectId: string, note: string | null, actor: BpActor, o: { teamId?: string; scope?: RequestScope; as?: Actor; by?: string } = {}): { project: ProjectRow; teams: string[] } {
    const p = this.project(projectId);
    if (!p) throw err('not_found', 'No such project.');
    const scope = o.scope ?? 'project';
    if (scope === 'team' && !o.teamId) throw err('invalid_argument', 'Name the team to ask.');
    if (scope === 'project' && p.status !== 'active') throw err('invalid_state', `Project ${p.key} is ${p.status}; resume it before asking its teams for a report.`);
    const teams = scope === 'team'
      ? this.db.prepare('SELECT id, name FROM teams WHERE id=? AND project_id=?').all(o.teamId!, p.id) as { id: string; name: string }[]
      : (this.db.prepare("SELECT id, name FROM teams WHERE project_id=? AND status='running' ORDER BY created_at").all(p.id) as { id: string; name: string }[]).filter((t) => !o.teamId || t.id === o.teamId);
    const coords = teams.map((t) => ({ t, c: this.coordinators(t.id) })).filter((x) => x.c.length);
    if (!coords.length) throw err('invalid_state', scope === 'team' ? 'This team has no coordinator to report.' : `No running team of ${p.key} has a coordinator to report.`);
    const now = Date.now(), by = o.by ?? 'The administrator';
    atomic(this.db, () => {
      for (const { t } of coords) openRequest(this.db, { teamId: t.id, scope, kind: 'status', note, by: actor, at: now });
      if (scope === 'project') this.reviewRequestEvent(p, null, actor, note, now);
      for (const { t, c } of coords) {
        this.notify(c, 'status_request', scope === 'team'
          ? `${by} asks for a status update of team "${t.name}" (${t.id}). ${STATUS_FORMAT}${note ? ` Note: ${note}` : ''}`
          : `${by} asks for a status report of project ${p.key} from team "${t.name}" (${t.id}), ${this.soleTeam(p.id) === t.id ? 'for the whole project (your team is its only one)' : "for your team's part"}. ${STATUS_FORMAT}${note ? ` Note: ${note}` : ''}`);
      }
    });
    const who = o.as ?? auditActor(actor), detail = note ? { note: note.slice(0, 300) } : {};
    if (scope === 'team') this.deps.audit?.event(who, 'team.status_request', { kind: 'team', id: coords[0]!.t.id }, detail);
    else this.deps.audit?.event(who, 'blueprint.report_request', { kind: 'project', id: p.id }, { key: p.key, teams: coords.length, ...detail });
    return { project: this.project(p.id)!, teams: coords.map((x) => x.t.id) };
  }

  /** The operator asks a team's coordinators to review its plan: an open plan request and a plan event in the team's history. */
  requestPlan(teamId: string, note: string | null, actor: BpActor): void {
    const p = this.projectOfTeam(teamId);
    const now = Date.now();
    atomic(this.db, () => {
      openRequest(this.db, { teamId, scope: 'team', kind: 'plan', note, by: actor, at: now });
      if (p) this.reviewRequestEvent(p, teamId, actor, note, now);
    });
  }
  /**
   * Refine requirements with the coordinator (docs/blueprint.md): a plan request that carries the keys it covers (frozen
   * now) and the checks asked for. Asking again edits the open request until a proposal exists; then only Send back
   * reopens it. Returns the request id.
   */
  requestRefine(teamId: string, a: { note: string; keys: string[]; checks: RefineChecks }, actor: BpActor): { id: number; edited: boolean } {
    const p = this.projectOfTeam(teamId);
    if (!p) throw err('invalid_state', 'The team is not in a project.');
    const live = new Set(this.items(p.id).map((i) => i.key));
    const keys = [...new Set(a.keys)].filter((k) => live.has(k));
    if (!keys.length) throw err('invalid_argument', 'Pick at least one requirement that exists.');
    const note = a.note.trim();
    if (!note || note.length > 2000) throw err('invalid_argument', 'Say what should change, in 1 to 2000 characters.');
    return atomic(this.db, () => {
      const r = openRefine(this.db, { teamId, note, keys, checks: a.checks, by: actor });
      if (!r) throw err('invalid_state', 'The coordinator has already proposed changes for this request. Review them, or send them back with a note, before asking again.');
      if (!r.edited) this.reviewRequestEvent(p, teamId, actor, note, Date.now());
      return r;
    });
  }
  /** The team's open refine request, if any. */
  openRefineOf(teamId: string): RequestRow | undefined {
    return openRequests(this.db, teamId, 'plan').find((r) => r.scope_keys !== null);
  }
  /**
   * A refine proposal's rules (enforced at filing): only the request's own team may answer it; every op says why (at most
   * 200 characters); nothing is deleted (a requirement is dropped by status); an op touches only keys in the request's
   * scope or items it adds; existing acceptance criteria are never edited; new ones only when that check was asked for.
   */
  private checkRefine(p: ProjectRow, team: { id: string }, role: BpRole, req: RequestRow, ops: Op[]): void {
    if (role !== 'coordinator') throw err('denied', 'Only the coordinator of the team answers a refine request.');
    if (req.team_id !== team.id || req.answered_at !== null) throw err('invalid_state', 'That request is not open for your team.');
    if (req.proposal_id) throw err('invalid_state', 'The request already has a proposal; the operator reviews it or sends it back first.');
    const scope = new Set(refineKeys(req) ?? []), checks = refineChecks(req);
    const live = new Map(this.items(p.id).map((i) => [i.key, i]));
    const added = new Set<string>();
    const inScope = (k: string) => scope.has(k) || added.has(k);
    ops.forEach((o, i) => {
      const at = `op ${i + 1}`;
      if (!o.reason?.trim()) throw err('invalid_argument', `${at}: a refine proposal gives a reason on every op (at most 200 characters).`);
      if (o.reason.length > 200) throw err('invalid_argument', `${at}: the reason is at most 200 characters.`);
      if (o.op === 'remove') throw err('denied', `${at}: a refine proposal never deletes. Drop a requirement with an upsert of status dropped (for a merge, name the target in the reason).`);
      if (o.op === 'upsert') {
        const cur = live.get(o.key);
        if (cur) {
          if (cur.kind === 'ac' || o.kind === 'ac') throw err('denied', `${at}: ${o.key} is an existing acceptance criterion, or would become one; a refine proposal may add criteria but never edit them.`);
          if (!scope.has(o.key)) throw err('denied', `${at}: ${o.key} is outside the requirements this request covers.`);
        } else {
          added.add(o.key);
          if (o.kind === 'ac') {
            if (!checks.missing_ac) throw err('denied', `${at}: the missing acceptance criteria check was not asked for, so no criteria may be added.`);
            if (!inScope(o.parent_key ?? '')) throw err('denied', `${at}: a new criterion goes under a requirement this request covers.`);
          }
        }
      } else if (o.op === 'move') {
        if (!scope.has(o.key)) throw err('denied', `${at}: ${o.key} is outside the requirements this request covers.`);
      } else if (!inScope(o.from) && !inScope(o.to)) {
        throw err('denied', `${at}: neither ${o.from} nor ${o.to} is in the requirements this request covers.`);
      }
    });
  }
  private reviewRequestEvent(p: ProjectRow, teamId: string | null, actor: BpActor, note: string | null, at: number): void {
    this.db.prepare("INSERT INTO bp_events(project_id,team_id,kind,version,actor_kind,actor_id,items,note,created_at) VALUES (?,?,'review_request',?,?,?,?,?,?)")
      .run(p.id, teamId, this.project(p.id)!.version, actor.kind, actor.id, this.liveCount(p.id), note, at);
  }

  // ───── reading ─────
  /** The live items; archived status reports (§6) only with `includeArchived` (the export). */
  items(projectId: string, f: { kinds?: string[]; team?: string; includeDeleted?: boolean; includeArchived?: boolean } = {}): Item[] {
    const rows = this.db.prepare(`SELECT * FROM bp_items WHERE project_id=? ${f.includeDeleted ? '' : 'AND deleted_at IS NULL'} ${f.includeArchived ? '' : 'AND archived=0'} ORDER BY kind, position, key`).all(projectId) as unknown as ItemRow[];
    return rows.filter((r) => (!f.kinds || f.kinds.includes(r.kind)) && (!f.team || r.team_id === f.team)).map(toItem);
  }
  item(projectId: string, key: string, includeDeleted = false): Item | undefined {
    const r = this.row(projectId, key);
    return r && (includeDeleted || !r.deleted_at) ? toItem(r) : undefined;
  }
  links(projectId: string): LinkRow[] { return this.db.prepare('SELECT * FROM bp_links WHERE project_id=? ORDER BY from_key, rel, to_key').all(projectId) as unknown as LinkRow[]; }
  revisions(itemId: string): { rev: number; snapshot: Record<string, unknown>; actor_kind: string; actor_id: string | null; at: number; change_note: string | null; via?: string }[] {
    return (this.db.prepare('SELECT * FROM bp_revisions WHERE item_id=? ORDER BY rev DESC').all(itemId) as any[]).map((r) => {
      const via = r.actor_kind === 'agent' ? this.viaAt(r.actor_id, r.at) : null;
      return { ...r, snapshot: parse(r.snapshot, {}), ...(via ? { via } : {}) };
    });
  }
  events(projectId: string, limit = 50): EventRow[] {
    return (this.db.prepare('SELECT * FROM bp_events WHERE project_id=? ORDER BY created_at DESC, id DESC LIMIT ?').all(projectId, Math.max(1, Math.min(200, limit))) as any[])
      .map((r) => ({ ...r, added: parse(r.added, []), removed: parse(r.removed, []), changed: parse(r.changed, []), moves: parse(r.moves, []) }));
  }
  /** A claim's support from its evidence links (§2.4), with the evidence it rests on. */
  claim(projectId: string, key: string): { item: Item; support: Support; evidence: Item[] } | undefined {
    const item = this.item(projectId, key);
    if (!item || item.kind !== 'claim') return undefined;
    const evidence = this.evidenceOf(projectId, key).map(toItem);
    return { item, support: claimSupport(evidence), evidence };
  }
  /** The live items linked as evidence to one item (a claim, or a hypothesis in a claim's chain). */
  private evidenceOf(projectId: string, key: string): ItemRow[] {
    return this.db.prepare("SELECT i.* FROM bp_links l JOIN bp_items i ON i.project_id=l.project_id AND i.key=l.from_key WHERE l.project_id=? AND l.to_key=? AND l.rel='evidence' AND i.deleted_at IS NULL ORDER BY i.key").all(projectId, key) as unknown as ItemRow[];
  }
  /**
   * The support of many claims in two queries: every live claim of the project, or only those of one paper, one team's
   * part or the keys named. Keys that are not live claims are left out. Each carries its evidence, by key.
   */
  claimStates(projectId: string, f: { papers?: Iterable<string>; team?: string; keys?: Iterable<string> } = {}): ClaimRowState[] {
    const keys = f.keys ? JSON.stringify([...f.keys]) : null, papers = f.papers ? JSON.stringify([...f.papers]) : null;
    const where = `project_id=? AND kind='claim' AND deleted_at IS NULL${papers ? ' AND parent_key IN (SELECT value FROM json_each(?))' : ''}${f.team ? ' AND team_id=?' : ''}${keys ? ' AND key IN (SELECT value FROM json_each(?))' : ''}`;
    const args = [projectId, ...(papers ? [papers] : []), ...(f.team ? [f.team] : []), ...(keys ? [keys] : [])];
    const claims = this.db.prepare(`SELECT key, title, status, parent_key, team_id, updated_at FROM bp_items WHERE ${where} ORDER BY position, key`).all(...args) as { key: string; title: string; status: string | null; parent_key: string | null; team_id: string | null; updated_at: number }[];
    if (!claims.length) return [];
    const ev = new Map<string, ClaimRowState['evidence']>();
    for (const r of this.db.prepare(`SELECT l.to_key claim, i.kind, i.key, i.status, i.fields, i.updated_at FROM bp_links l JOIN bp_items i ON i.project_id=l.project_id AND i.key=l.from_key
      WHERE l.project_id=? AND l.rel='evidence' AND i.deleted_at IS NULL AND l.to_key IN (SELECT key FROM bp_items WHERE ${where}) ORDER BY i.key`).all(projectId, ...args) as { claim: string; kind: string; key: string; status: string | null; fields: string; updated_at: number }[]) {
      (ev.get(r.claim) ?? ev.set(r.claim, []).get(r.claim)!).push({ kind: r.kind, key: r.key, status: r.status, fields: parse(r.fields, {}), updated_at: r.updated_at });
    }
    return claims.map((c) => ({ key: c.key, title: c.title, status: c.status, parent: c.parent_key, team_id: c.team_id, updated_at: c.updated_at, evidence: ev.get(c.key) ?? [], support: claimSupport(ev.get(c.key) ?? []) }));
  }
  /** A paper with each claim's support and whether it is ready to write (every claim not cut is supported). */
  paper(projectId: string, key: string): { item: Item; claims: (ClaimState & { title: string })[]; ready: boolean; supported: number; total: number; holding: string[] } | undefined {
    const item = this.item(projectId, key);
    if (!item || item.kind !== 'paper') return undefined;
    return { item, ...Blueprint.readiness(this.claimStates(projectId, { papers: [key] })) };
  }
  /** A paper's readiness from its claims' states. */
  static readiness(states: (ClaimState & { title: string })[]): { claims: (ClaimState & { title: string })[]; ready: boolean; supported: number; total: number; holding: string[] } {
    const claims = states.map((c) => ({ key: c.key, title: c.title, status: c.status, support: c.support }));
    const r = paperReadiness(claims);
    return { claims, ready: r.ready, supported: r.supported, total: r.total, holding: r.holding.map((c) => c.key) };
  }
  private row(projectId: string, key: string): ItemRow | undefined { return this.db.prepare('SELECT * FROM bp_items WHERE project_id=? AND key=?').get(projectId, key) as ItemRow | undefined; }

  // ───── writing ─────
  /** Apply a batch of ops against the project version the writer read; all or nothing. */
  /** item_note: the note a person wrote with the change (Edit or Drop on the Clarify sheet); it shows in the history of each item the write puts, as well as in the project's change log. */
  write(projectId: string, a: { version: number; ops: Op[]; note?: string | null; team_id?: string | null; item_note?: string | null }, actor: BpActor): WriteResult {
    if (!Number.isInteger(a.version)) throw err('invalid_argument', 'Pass the project version you read.');
    return atomic(this.db, () => {
      const notes = a.item_note ? Object.fromEntries(a.ops.flatMap((o) => (o.op === 'upsert' && typeof o.key === 'string' && !o.key.endsWith('*') ? [[o.key, a.item_note!.slice(0, 500)]] : []))) : undefined;
      const r = this.apply(projectId, a.ops, actor, { note: a.note ?? null, notes, teamId: a.team_id ?? null }, a.version);
      // Items the operator adds inside an open re-plan's scope join it, so its review shows them and a cancel removes them.
      if (r.added.length) {
        const open = this.db.prepare("SELECT id, team_id, kinds FROM bp_replans WHERE project_id=? AND status='open'").all(projectId) as { id: string; team_id: string | null; kinds: string }[];
        for (const k of r.added) {
          const row = this.liveRow(projectId, k);
          const rp = row && open.find((o) => parse<string[]>(o.kinds, []).includes(row.kind) && (o.team_id === null || o.team_id === row.team_id));
          if (rp) this.db.prepare('UPDATE bp_items SET replan_id=? WHERE id=?').run(rp.id, row!.id);
        }
      }
      return r;
    });
  }

  /** A batch holds at least one op and, unless the hub writes it (`force`), at most the operator's ops_per_write. */
  private checkBatch(ops: Op[], force = false): void {
    if (!Array.isArray(ops) || ops.length === 0) throw err('invalid_argument', 'A write needs at least one op.');
    if (!force && ops.length > this.limits.opsPerWrite) throw err('invalid_argument', `A write holds at most ${this.limits.opsPerWrite} ops (limit ops_per_write, set by the operator).`);
  }

  private apply(projectId: string, ops: Op[], actor: BpActor, o: WriteOpts, version?: number): WriteResult {
    this.checkBatch(ops, o.force);
    return atomic(this.db, () => {
      const p = this.project(projectId);
      if (!p) throw err('not_found', 'No such project.');
      if (version !== undefined) this.checkConflicts(p, ops, version);
      if (this.isEcosystem(p.id)) {
        const off = ops.filter((op) => (op.op === 'upsert' && !ECOSYSTEM_KINDS.has(op.kind)) || op.op === 'link' || (op.op === 'move' && !ECOSYSTEM_KINDS.has(this.mustRow(p.id, op.key).kind)));
        if (off.length) throw err('invalid_state', `${p.name} is an ecosystem: it holds only its Foundation (summary and stakeholders) and the overview of its projects. Write the rest in one of its projects.`);
      }
      const now = Date.now();
      const res: WriteResult = { version: p.version, added: [], removed: [], changed: [], moves: [], keys: {} };
      const touched = new Set<string>();
      // Every refused op of the batch is reported at once (the transaction is rolled back), so one retry can fix them all;
      // an op whose parent was itself refused is left out, its own problem is usually the same one.
      const problems: string[] = [], refused = new Set<string>();
      let first: unknown = null;
      ops.forEach((op, i) => {
        try {
          this.refuseArchived(p, op, res);
          if (op.op === 'upsert') this.upsert(p, op, actor, o, now, res, touched);
          else if (op.op === 'remove') this.remove(p, op.key, actor, o, now, res);
          else if (op.op === 'move') this.upsert(p, { ...this.asUpsert(p, op.key), parent_key: op.parent_key === undefined ? this.mustRow(p.id, op.key).parent_key : op.parent_key, ...(op.position === undefined ? {} : { position: op.position }) }, actor, o, now, res, touched);
          else if (op.op === 'link' || op.op === 'unlink') this.link(p, { ...op, from: res.keys[op.from] ?? op.from, to: res.keys[op.to] ?? op.to }, actor, now, res); // a key allocated earlier in the batch ("P-1/C*") names its item
          else throw err('invalid_argument', `Unknown op ${(op as { op: string }).op}.`);
        } catch (e) {
          if ((e as { code?: string }).code !== 'invalid_argument' || ops.length === 1) throw e;
          const key = 'key' in op ? op.key : `${op.from}→${op.to}`, parent = 'parent_key' in op ? op.parent_key : null;
          refused.add(key);
          first ??= e;
          if (!(parent && refused.has(parent))) problems.push(`op ${i + 1} (${key}): ${(e as Error).message}`);
        }
      });
      if (problems.length === 1) throw first;
      if (!problems.length) this.supersedeOnAccept(p, actor, o, now, res, touched);
      if (!problems.length) this.openAsks(res, o);
      if (problems.length) throw err('invalid_argument', `${problems.length} ops were refused; nothing was written:\n${problems.slice(0, 12).map((x) => `- ${x}`).join('\n')}${problems.length > 12 ? `\n- and ${problems.length - 12} more` : ''}`, { problems: problems.slice(0, 200) });
      for (const key of touched) this.checkLinkCount(p.id, key);
      this.checkCounts(p.id, touched);
      if (!res.added.length && !res.removed.length && !res.changed.length) return res;
      res.version = p.version + 1;
      this.db.prepare('UPDATE projects SET version=?, updated_at=? WHERE id=?').run(res.version, now, p.id);
      // The version each item last changed at (links touch both ends), for bp_read since_version; writes with noEvent leave no event, so events cannot say.
      const hit = new Set([...res.added, ...res.removed, ...res.changed.flatMap((k) => k.split('→'))]);
      const mark = this.db.prepare('UPDATE bp_items SET changed_version=? WHERE project_id=? AND key=?');
      for (const k of hit) mark.run(res.version, p.id, k);
      if (!o.noEvent) {
        // The keys a rule applied, only those this write actually added or changed.
        const ruled = o.ruled ? o.ruled.keys.filter((k) => res.added.includes(k) || res.changed.includes(k)) : [];
        this.db.prepare("INSERT INTO bp_events(project_id,team_id,kind,version,actor_kind,actor_id,items,added,removed,changed,moves,note,proposal_id,created_at,decided,rule) VALUES (?,?,'update',?,?,?,?,?,?,?,?,?,?,?,?,?)")
          .run(p.id, o.teamId ?? null, res.version, actor.kind, actor.id, this.liveCount(p.id), JSON.stringify(res.added), JSON.stringify(res.removed), JSON.stringify(res.changed), JSON.stringify(res.moves), o.note ?? null, o.proposalId ?? null, now, o.decided?.length ? JSON.stringify(o.decided) : null,
            ruled.length ? JSON.stringify({ rule: o.ruled!.rule, keys: ruled }) : null);
      }
      // A key a task named while it was only proposed goes live as soon as any write adds it, not only when the proposal closes.
      if (res.added.length && !o.trial) this.onKeysAdded?.(p.id, res.added);
      return res;
    });
  }

  /**
   * Per-item concurrency (F-24, §2.5): the project version stays the delta cursor, but a write conflicts only on the items
   * it touches. An op with `rev` must match the item's current rev (0: the key must be free); an op without one conflicts
   * when its item changed after the version the writer read. Another team's write elsewhere never gets in the way.
   */
  private checkConflicts(p: ProjectRow, ops: Op[], version: number): void {
    if (version > p.version) throw err('conflict', `Version ${version} is ahead of the blueprint (current version ${p.version}). Read it again first.`, { current_version: p.version });
    const hit = new Set<string>();
    for (const o of ops) {
      if (o.op === 'link' || o.op === 'unlink') continue;
      const { key, rev } = o as { key?: unknown; rev?: number };
      if (typeof key !== 'string' || key.endsWith('*')) continue;
      const r = this.row(p.id, key);
      if (rev !== undefined) { if ((r && !r.deleted_at ? r.rev : 0) !== rev) hit.add(key); }
      else if (version < p.version && r && (r.changed_version ?? 0) > version) hit.add(key);
    }
    if (hit.size) {
      const keys = [...hit], them = keys.length === 1 ? 'it' : 'them';
      throw err('conflict', `Changed since you read ${them}: ${keys.join(', ')} (current version ${p.version}). Read ${them} again (bp_read keys) and retry.`, { current_version: p.version, keys });
    }
  }

  /**
   * An archived item (§6.1) is kept whole: a write may not edit, move or remove it, put an item under it, or link to it;
   * it is unarchived first. Removing a link that touches it is allowed. Status reports are archived by their retention
   * rule and are never written by ops, so this concerns items archived by hand.
   */
  private refuseArchived(p: ProjectRow, op: Op, res: WriteResult): void {
    const named = op.op === 'link' ? [res.keys[op.from] ?? op.from, res.keys[op.to] ?? op.to]
      : op.op === 'unlink' ? []
      : [(op as { key?: unknown }).key, ...('parent_key' in op && typeof op.parent_key === 'string' ? [op.parent_key] : [])];
    for (const k of named) {
      if (typeof k !== 'string' || k.endsWith('*')) continue;
      const r = this.row(p.id, k);
      if (r?.archived && !r.deleted_at) throw err('invalid_argument', `${k} is archived and kept as it is; the operator can unarchive it (Dropped screen) before it is written again.`);
    }
  }

  private mustRow(projectId: string, key: string): ItemRow {
    const r = this.row(projectId, key);
    if (!r || r.deleted_at) throw err('not_found', `No item ${key} in this blueprint.`);
    return r;
  }
  private asUpsert(p: ProjectRow, key: string): Extract<Op, { op: 'upsert' }> {
    const r = this.mustRow(p.id, key);
    return { op: 'upsert', kind: r.kind, key: r.key };
  }

  /** Next free key for a prefix ending in `*`; deleted keys count, so a key is never reused. */
  private allocate(projectId: string, kind: string, key: string): string {
    const prefix = key.slice(0, -1);
    return prefix + String(this.maxNumber(projectId, prefix) + 1).padStart(KINDS[kind]!.pad ?? 0, '0');
  }
  /** The highest number after a key prefix in the project, deleted keys included (0 when none). */
  private maxNumber(projectId: string, prefix: string): number {
    const like = prefix.replace(/[\\%_]/g, (c) => `\\${c}`) + '%';
    let max = 0;
    for (const r of this.db.prepare("SELECT key FROM bp_items WHERE project_id=? AND key LIKE ? ESCAPE '\\'").all(projectId, like) as { key: string }[]) {
      const n = /^\d+$/.test(r.key.slice(prefix.length)) ? Number(r.key.slice(prefix.length)) : 0;
      if (n > max) max = n;
    }
    return max;
  }

  /** Evidence never names past work recorded as done: nobody reviewed it (docs/teams.md, "Record past work"). */
  private checkRecordedEvidence(v: string): void {
    for (const r of scanRefs(v)) {
      if (r.kind !== 'task') continue;
      const t = this.db.prepare('SELECT recorded_at FROM tasks WHERE id=?').get(r.id) as { recorded_at: number | null } | undefined;
      if (t?.recorded_at) throw err('invalid_argument', `Field evidence: task:${r.id} was recorded as done without review, so it cannot be evidence. Name reviewed work instead.`);
    }
  }
  private checkFields(kind: string, given: Record<string, unknown>, checkRefs = false, ext: { allowed: readonly string[] | null; kept: ExternalRef[] } = { allowed: null, kept: [] }): Record<string, unknown> {
    const spec = KINDS[kind]!;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(given)) {
      const t: FieldType | undefined = spec.fields[k];
      if (!t) throw err('invalid_argument', `A ${kind} has no field ${k}; its fields are ${Object.keys(spec.fields).join(', ') || 'none'}.`, { fields: Object.keys(spec.fields) });
      if (v === null || v === undefined) continue;
      // Outside references (§2.2): {system, id} only, from the project's systems; [] removes them.
      if (k === 'external') { const refs = checkExternal(v, ext.allowed, ext.kept); if (refs) out[k] = refs; continue; }
      const bad = () => err('invalid_argument', `Field ${k} of a ${kind} must be ${Array.isArray(t) ? `one of ${(t as readonly string[]).join(', ')}` : t}.`);
      if (Array.isArray(t)) { if (typeof v !== 'string' || !t.includes(v)) throw bad(); }
      else if (t === 'str') { if (typeof v !== 'string') throw bad(); if (k === 'short' && kind === 'milestone' && v.length > SHORT_NAME_MAX) throw err('invalid_argument', `A milestone's short name is at most ${SHORT_NAME_MAX} characters; this one has ${v.length}.`); }
      else if (t === 'bool') { if (typeof v !== 'boolean') throw bad(); }
      else if (t === 'num') { if (typeof v !== 'number' || !Number.isFinite(v)) throw bad(); }
      else if (t === 'strs') { if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw bad(); }
      else if (t === 'objs') { if (!Array.isArray(v) || v.some((x) => !x || typeof x !== 'object' || Array.isArray(x))) throw bad(); }
      else if (t === 'obj') { if (typeof v !== 'object' || Array.isArray(v)) throw bad(); }
      // Evidence holds outside pointers (F-18): every reference in it must parse, and another item is a link, not a field.
      if (k === 'evidence' && checkRefs && typeof v === 'string') { checkEvidence(v); this.checkRecordedEvidence(v); }
      out[k] = v;
    }
    return out;
  }

  /** Whether a team question is still open (asked, or waiting for more information). */
  private openAsk(id: string): boolean {
    const d = this.db.prepare('SELECT status FROM decisions WHERE id=?').get(id) as { status: string } | undefined;
    return !!d && ['open', 'needs_info'].includes(d.status);
  }
  /** Rule unclear_needs_ask: an agent's unclear mark names one open team_ask of its team whose refs include the item. */
  private checkUnclearAsk(p: ProjectRow, key: string, ask: unknown, teamId: string | null): void {
    const rule = { rule: 'unclear_needs_ask' };
    const how = unclearHow(key);
    if (typeof ask !== 'string' || !ask) throw err('invalid_argument', `${key} cannot be marked unclear without a question for the operator. ${how}`, rule);
    const d = this.db.prepare('SELECT team_id, status, refs FROM decisions WHERE id=?').get(ask) as { team_id: string; status: string; refs: string } | undefined;
    if (!d || !['open', 'needs_info'].includes(d.status)) throw err('invalid_argument', `unclear_ask ${ask} is not an open team question. ${how}`, rule);
    const ours = teamId ? d.team_id === teamId : !!this.db.prepare('SELECT 1 FROM teams WHERE id=? AND project_id=?').get(d.team_id, p.id);
    if (!ours) throw err('invalid_argument', `unclear_ask ${ask} is not a question of your team. ${how}`, rule);
    if (!(parse<string[]>(d.refs, [])).includes(key)) throw err('invalid_argument', `Question ${ask} does not name ${key} in its refs. ${how}`, rule);
  }

  /**
   * The question an agent's unclear mark asks in its own write (§2.7): unclear_ask holds its text, or {question, options,
   * recommended, context}. Checked here, with the id it will have; opened by openAsks once the item exists. Null for the id of
   * an existing question (checkUnclearAsk), for no value, and for writes that are not an agent's.
   */
  private itemAsk(op: Extract<Op, { op: 'upsert' }>, key: string, actor: BpActor, o: WriteOpts, hook = true): Omit<ItemAsk, 'key' | 'team_id' | 'agent_id' | 'dry' | 'capped'> | null {
    if ((op.kind !== 'fr' && op.kind !== 'nfr') || op.restore || !op.fields || !('unclear_ask' in op.fields) || (o.author ?? actor).kind !== 'agent') return null;
    const v = op.fields['unclear_ask'];
    if (v === null || v === undefined || (typeof v === 'string' && (!v.trim() || ASK_ID.test(v.trim())))) return null;
    const rule = { rule: 'unclear_needs_ask' }, how = unclearHow(key);
    const bad = (what: string) => err('invalid_argument', `unclear_ask of ${key} ${what}. ${how}`, rule);
    const q = typeof v === 'string' ? { question: v } : v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
    if (!q) throw bad('is neither a question nor the id of one');
    const extra = Object.keys(q).filter((k) => !['question', 'options', 'recommended', 'context'].includes(k));
    if (extra.length) throw bad(`takes question, options, recommended and context, not ${extra.join(', ')}`);
    if (typeof q['question'] !== 'string' || !q['question'].trim()) throw bad('needs the question in words');
    const str = (x: unknown, max: number) => typeof x === 'string' && x.trim().length > 0 && x.length <= max;
    const opts = q['options'];
    if (opts !== undefined && !(Array.isArray(opts) && opts.every((x) => x && typeof x === 'object' && str((x as DecisionOption).key, 8) && str((x as DecisionOption).label, 160)
      && ((x as DecisionOption).effect === undefined || (x as DecisionOption).effect === null || (typeof (x as DecisionOption).effect === 'string' && (x as DecisionOption).effect!.length <= 400))))) {
      throw bad('has options that are not a list of {key, label, effect}: a key of at most 8 characters, a label of at most 160');
    }
    if (q['recommended'] !== undefined && typeof q['recommended'] !== 'string') throw bad('has a recommended that is not an option key');
    if (q['context'] !== undefined && q['context'] !== null && !(typeof q['context'] === 'string' && q['context'].length <= 4000)) throw bad('has a context that is not text of at most 4000 characters');
    const a = { id: `dec_${randomToken(10)}`, question: q['question'], ...(opts ? { options: (opts as DecisionOption[]).map((x) => ({ key: x.key, label: x.label, ...(x.effect ? { effect: x.effect } : {}) })) } : {}),
      ...(q['recommended'] !== undefined ? { recommended: q['recommended'] as string } : {}), context: (q['context'] as string | undefined) ?? null };
    // The question's own rules (length, two or more options, recommended among them), as team_ask has them.
    if (hook) this.askHook(key, { ...a, key, team_id: o.teamId ?? '', agent_id: (o.author ?? actor).id ?? '', dry: true, capped: false });
    return a;
  }
  private askHook(key: string, a: ItemAsk): void {
    if (!this.onItemAsk) throw err('invalid_state', 'This hub cannot open a question from a Blueprint write.');
    try { this.onItemAsk(a); }
    catch (e) { if ((e as { code?: string }).code === 'invalid_argument') throw err('invalid_argument', `unclear_ask of ${key}: ${(e as Error).message} ${unclearHow(key)}`, { rule: 'unclear_needs_ask' }); throw e; }
  }
  /** Open the questions the write's unclear marks ask (§2.7), now that their items exist; a dry run only checks the limit-free rules. */
  private openAsks(res: WriteResult, o: WriteOpts): void {
    const asks = this.asksOf.get(res);
    if (!asks?.length || o.trial) return;
    for (const a of asks) {
      if (!a.team_id) throw err('invalid_argument', `${a.key}: name your team (team_id) so the write can ask the operator for it.`, { rule: 'unclear_needs_ask' });
      // The operator applying a proposal is never refused for the agent's open-question limit.
      this.askHook(a.key, { ...a, dry: false, capped: !o.proposalId });
    }
    res.asks = asks.map((a) => ({ key: a.key, decision_id: a.id }));
  }

  private upsert(p: ProjectRow, op: Extract<Op, { op: 'upsert' }>, actor: BpActor, o: WriteOpts, now: number, res: WriteResult, touched: Set<string>): void {
    const spec = KINDS[op.kind];
    if (!spec) throw unknownKind(op.kind);
    let key = op.key;
    if (typeof key !== 'string' || !key) throw err('invalid_argument', 'Every item needs a key.');
    if (key.endsWith('*')) { const k = this.allocate(p.id, op.kind, key); res.keys[key] = k; key = k; }
    const prev = this.row(p.id, key);
    if (prev && prev.kind !== op.kind) throw err('invalid_argument', `${key} is a ${prev.kind}, not a ${op.kind}.`);
    if (prev?.deleted_at && !op.restore) throw err('conflict', `Key ${key} was used before and is never reused.`);
    if (!prev && !spec.key.test(key)) throw err('invalid_argument', `${key} is not a valid ${op.kind} key. ${keyHint(op.kind)} ${RULES_HINT}`);
    if (spec.single && !prev && this.items(p.id, { kinds: [op.kind] }).length) throw err('conflict', `A blueprint has one ${op.kind}.`);
    const cur = prev && !prev.deleted_at ? prev : undefined;

    // Parent: the kinds it may sit under; tracks nest one level; the AC key names its parent.
    const parentKey = op.parent_key === undefined ? (cur?.parent_key ?? null) : op.parent_key;
    let parent: ItemRow | undefined;
    if (parentKey !== null) {
      if (!spec.parents?.length) throw err('invalid_argument', `A ${op.kind} sits at project level and has no parent. ${RULES_HINT}`);
      parent = this.row(p.id, parentKey);
      if (!parent || parent.deleted_at) throw err('invalid_argument', `${key} names parent ${parentKey}, which is not in the blueprint.`);
      if (!spec.parents.includes(parent.kind)) throw err('invalid_argument', `A ${op.kind} sits under a ${spec.parents.join(' or ')}, not a ${parent.kind}. ${RULES_HINT}`);
      if (op.kind === 'line' && parent.parent_key !== null) throw err('invalid_argument', 'Lines nest one level; open a sibling line instead.');
    } else if (spec.parentRequired) throw err('invalid_argument', `A ${op.kind} needs a parent (${spec.parents!.join(' or ')}). ${RULES_HINT}`);
    if (op.kind === 'ac' && !key.startsWith(`${parentKey}/AC`)) throw err('invalid_argument', `An acceptance criterion of ${parentKey} is keyed ${parentKey}/ACn.`);
    if (op.kind === 'claim' && !key.startsWith(`${parentKey}/C`)) throw err('invalid_argument', `A claim of ${parentKey} is keyed ${parentKey}/Cn.`);
    // A question's key names its place: Q-L1-… under a line, Q-TEAM-… under the module TEAM, Q-nn at project level.
    if (op.kind === 'question' && (!cur || op.parent_key !== undefined)) {
      const m = /^Q-(?:(L\d+(?:\.\d+)?)|([A-Z]{2,6}))-\d+$/.exec(key), want = m?.[1] ? 'line' : m?.[2] ? 'module' : null;
      // A module question stays in the module its key names, moves included: a key never changes (tasks, links and
      // decisions name it), so asking it elsewhere is a new question there, not a re-keyed one.
      const fits = want === (parent?.kind ?? null) && (want !== 'module' || parentKey === m![2]);
      const elsewhere = cur ? ` A key never changes: to ask it ${parent ? `under ${parentKey}` : 'at project level'}, write a new question there (${parent ? `Q-${parentKey}-*` : 'Q-*'}) and drop this one.` : '';
      if (!fits) throw err('invalid_argument', `${key} ${want === 'line' ? 'is a research line\'s question and sits under a line' : want === 'module' ? `is a question of module ${m![2]} and sits under it` : 'is a project-level question and has no parent'}.${elsewhere} ${keyHint('question')} ${RULES_HINT}`);
    }

    const title = (op.title ?? cur?.title ?? '').trim();
    if (!title) throw err('invalid_argument', `${key} needs a title.`);
    if (title.length > this.limits.title) throw err('invalid_argument', `A title holds at most ${this.limits.title} characters (limit title, set by the operator).`);
    const body = op.body === undefined ? (cur?.body ?? null) : op.body;
    const maxBody = op.kind === 'architecture' ? this.limits.archBody : this.limits.body;
    if (body !== null && (typeof body !== 'string' || body.length > maxBody)) throw err('invalid_argument', `A body holds at most ${maxBody} characters${` (limit ${op.kind === 'architecture' ? 'architecture_body' : 'body'}, set by the operator)`}.`);
    // unclear_ask may hold the question itself (§2.7): the field keeps the id it will have, and the write opens it once the item exists.
    // An item already unclear with an open question keeps it: the text sent again is taken as unchanged, never a second question.
    const before = cur ? parse<Record<string, unknown>>(cur.fields, {}) : {};
    const keep = before['unclear'] === true && typeof before['unclear_ask'] === 'string' && this.openAsk(before['unclear_ask']) ? before['unclear_ask'] : null;
    const asked = keep ? null : this.itemAsk(op, key, actor, o);
    const resent = keep && op.fields && 'unclear_ask' in op.fields && op.fields['unclear_ask'] !== keep && this.itemAsk(op, key, actor, { ...o, trial: true }, false);
    if (resent) op = { ...op, fields: { ...op.fields, unclear_ask: keep } };
    const opFields = asked ? { ...op.fields, unclear_ask: asked.id } : op.fields;
    // A restore replaces the fields as a whole (the plan already kept the ones its file does not carry).
    const fields = this.checkFields(op.kind, op.restore ? { ...(opFields ?? {}) } : { ...(cur ? parse<Record<string, unknown>>(cur.fields, {}) : {}), ...(opFields ?? {}) },
      // Only evidence this op writes is checked: a stored value from before the grammar never blocks a later edit (F-18).
      !!op.fields && 'evidence' in op.fields && op.fields['evidence'] !== (cur ? parse<Record<string, unknown>>(cur.fields, {})['evidence'] : undefined),
      // A restore keeps the references its file holds; any other write may add only systems the project lists.
      { allowed: op.restore ? null : parseSystems(p.external_systems).map((s) => s.system), kept: refsOf(cur ? parse<Record<string, unknown>>(cur.fields, {}) : {}) });
    // An unclear mark is one question to the operator (docs/blueprint.md §2.7): an agent marks it only with the open team_ask that names the item.
    // Clearing the mark clears the ask's id with it.
    if ((op.kind === 'fr' || op.kind === 'nfr') && !op.restore) {
      if (fields['unclear'] !== true) {
        if (asked) throw err('invalid_argument', `${key}: a question in unclear_ask goes with unclear: true.`, { rule: 'unclear_needs_ask' });
        delete fields['unclear_ask'];
      } else if (asked) {
        const list = this.asksOf.get(res) ?? [];
        list.push({ ...asked, key, team_id: o.teamId ?? '', agent_id: (o.author ?? actor).id ?? '' });
        this.asksOf.set(res, list);
      } else if ((o.author ?? actor).kind === 'agent' && op.fields && ('unclear' in op.fields || 'unclear_ask' in op.fields)) this.checkUnclearAsk(p, key, fields['unclear_ask'], o.teamId ?? null);
    }
    for (const f of spec.required ?? []) if (fields[f] === undefined) throw err('invalid_argument', `A ${op.kind} needs ${f}.`);
    const fieldsJson = JSON.stringify(fields);
    if (fieldsJson.length > this.limits.fields) throw err('invalid_argument', `Fields hold at most ${this.limits.fields} characters (limit fields, set by the operator).`);
    const status = op.status === undefined ? (cur?.status ?? spec.statuses?.[0] ?? null) : op.status;
    if (spec.statuses ? !spec.statuses.includes(status ?? '') : status !== null) {
      throw err('invalid_argument', spec.statuses ? `A ${op.kind} status is one of ${spec.statuses.join(', ')}.` : `A ${op.kind} has no status.`);
    }

    // Per-line shape (F3): hypotheses and criteria belong to lines that validate; an explore line has neither.
    const line = parent?.kind === 'line' ? parse<Record<string, unknown>>(parent.fields, {}) : null;
    if (op.kind === 'question' && !line) {
      if (fields['criteria'] !== undefined) throw err('invalid_argument', `${key} is not under a research line; validation criteria belong to questions of a line that validates.`);
      // Outside a line nothing else answers it (a line question is answered by findings linked as evidence).
      if (status === 'answered' && !(typeof fields['answer'] === 'string' && fields['answer'].trim())) throw err('invalid_argument', `${key} needs its answer to be answered: give fields.answer, the answer in words.`);
    }
    if (line && line['mode'] === 'explore') {
      if (op.kind === 'hypothesis') throw err('invalid_argument', `${parentKey} explores; hypotheses belong to a line that validates.`);
      if (op.kind === 'question' && fields['criteria'] !== undefined) throw err('invalid_argument', `${parentKey} explores; its questions have no validation criteria.`);
    }
    if (op.kind === 'line' && cur && fields['mode'] === 'explore' && parse<Record<string, unknown>>(cur.fields, {})['mode'] !== 'explore') {
      const kids = this.db.prepare("SELECT key FROM bp_items WHERE project_id=? AND parent_key=? AND deleted_at IS NULL AND (kind='hypothesis' OR (kind='question' AND json_extract(fields,'$.criteria') IS NOT NULL))").all(p.id, key) as { key: string }[];
      if (kids.length) throw err('invalid_argument', `${key} still has items to validate (${kids.map((k) => k.key).join(', ')}).`);
    }

    // Team part: tracks carry it; items inside a track take the track's; project-level items may name one.
    // A new track or paper written for a team (its bp_write or proposal) is that team's part unless the op says otherwise.
    const ownable = !!KINDS[op.kind]!.track || op.kind === 'paper';
    let teamId = op.team_id === undefined ? (cur ? cur.team_id : ownable && !parent && o.teamId ? o.teamId : null) : op.team_id;
    if (parent) teamId = parent.team_id;
    // A project-level question is in no team's part: it needs the operator (§4), so no team_id makes it a team's.
    else if (op.kind === 'question') {
      if (op.team_id) throw err('invalid_argument', `${key} is a project-level question, which is in no team's part and needs the operator. Put a team's question under its module (Q-<module>-nn) instead.`);
      teamId = null;
    }
    if (teamId !== null && !this.db.prepare('SELECT 1 FROM teams WHERE id=? AND project_id=?').get(teamId, p.id)) throw err('invalid_argument', `Team ${teamId} is not part of project ${p.key}.`);
    const position = op.position ?? cur?.position ?? (this.db.prepare('SELECT COALESCE(MAX(position)+1,0) n FROM bp_items WHERE project_id=? AND kind=?').get(p.id, op.kind) as { n: number }).n;
    if (!Number.isInteger(position) || position < 0) throw err('invalid_argument', 'A position is a whole number from 0.');

    const by = op.restore?.by ?? o.by?.[key] ?? o.author ?? actor, at = o.at?.[key] ?? now;
    // A restore sets the claimed attribution of the text it writes (null when its writer is verified); other writes keep it.
    const claimed = op.restore ? (op.restore.claimed ? JSON.stringify(op.restore.claimed) : null) : undefined;
    const originId = o.origin?.[key] ?? null;
    touched.add(key);
    if (op.kind === 'question' && status === 'answered' && cur?.status !== 'answered' && !op.restore) (res.offers ??= []).push(this.decisionOffer(key, title, fields, teamId));
    if (!cur && prev) {
      // A restore brings a deleted key back (§4.2): the same row, its history kept, one revision.
      this.db.prepare(`UPDATE bp_items SET deleted_at=NULL,parent_key=?,title=?,body=?,fields=?,status=?,team_id=?,position=?,rev=rev+1,updated_by_kind=?,updated_by_id=?,updated_at=? WHERE id=?`)
        .run(parentKey, title, body, fieldsJson, status, teamId, position, by.kind, by.id, at, prev.id);
      this.revision(prev.id, by, at, 'restored');
      if (claimed !== undefined) this.db.prepare('UPDATE bp_items SET attributed_to=? WHERE id=?').run(claimed, prev.id);
      res.added.push(key);
      return;
    }
    if (!cur) {
      const id = `bpi_${randomToken(10)}`;
      this.db.prepare(`INSERT INTO bp_items(id,project_id,kind,key,parent_key,title,body,fields,status,team_id,position,rev,origin,origin_id,created_by_kind,created_by_id,created_at,updated_by_kind,updated_by_id,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?)`)
        .run(id, p.id, op.kind, key, parentKey, title, body, fieldsJson, status, teamId, position, null, originId, by.kind, by.id, at, by.kind, by.id, at);
      this.revision(id, by, at, op.restore ? 'restored' : o.ruled?.keys.includes(key) ? `created, ${ruleNote(o.ruled.rule)}` : 'created');
      if (claimed) this.db.prepare('UPDATE bp_items SET attributed_to=? WHERE id=?').run(claimed, id);
      res.added.push(key);
      return;
    }
    const same = cur.parent_key === parentKey && cur.title === title && cur.body === body && cur.fields === fieldsJson && cur.status === status && cur.team_id === teamId && cur.position === position;
    if (same) return;
    this.db.prepare(`UPDATE bp_items SET parent_key=?,title=?,body=?,fields=?,status=?,team_id=?,position=?,rev=rev+1,updated_by_kind=?,updated_by_id=?,updated_at=? WHERE id=?`)
      .run(parentKey, title, body, fieldsJson, status, teamId, position, by.kind, by.id, at, cur.id);
    this.revision(cur.id, by, at, op.restore ? 'restored' : o.notes?.[key] ?? (o.ruled?.keys.includes(key) ? ruleNote(o.ruled.rule) : o.decided?.includes(key) && cur.status !== status ? DECIDED_NOTE : null));
    // Evidence whose status or decided/contradicting result changed changes its claims' support: touch them. A change of
    // wording alone does not, so a dismissed claim stays dismissed (docs/dashboard-ux.md, Needs you).
    const was = { kind: cur.kind, key, status: cur.status, fields: parse<Record<string, unknown>>(cur.fields, {}) }, now_ = { kind: cur.kind, key, status, fields };
    if (cur.status !== status || decided(was) !== decided(now_) || contradicts(was) !== contradicts(now_)) this.touchClaims(p.id, this.claimsOf(p.id, key), by, at, `evidence ${key} changed`, res);
    if (claimed !== undefined) this.db.prepare('UPDATE bp_items SET attributed_to=? WHERE id=?').run(claimed, cur.id);
    res.changed.push(key);
    if (cur.status !== status) res.moves.push({ key, status, was: cur.status });
    // Children follow the team of their track or paper (claims sit in a paper).
    if ((KINDS[op.kind]!.track || op.kind === 'paper') && cur.team_id !== teamId) this.retagChildren(p.id, key, teamId, by, at, res, o.restoring);
  }

  /**
   * The op offered when a question becomes answered (§4): a proposed decision whose context is the question and its
   * answer and whose source names the question, in the question's part. It is only offered; the writer sends it or not.
   */
  private decisionOffer(key: string, title: string, fields: Record<string, unknown>, teamId: string | null): Offer {
    const s = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    const answer = s(fields['answer']), to = s(fields['asked_to']);
    const context = `Question${to ? ` asked of ${to}` : ''}: ${title}${answer ? `\nAnswer: ${answer}` : ''}\nFrom question ${key}.`.slice(0, 2000);
    return {
      why: `${key} is answered. If the answer decides something, send this op to record it as a proposed decision; nothing is created by itself.`,
      op: { op: 'upsert', kind: 'decision', key: 'ADR-*', title: `${title.slice(0, Math.max(1, this.limits.title - 30))} (answered in ${key})`, status: 'proposed', fields: { context, source: `bp:${key}` }, ...(teamId ? { team_id: teamId } : {}) },
    };
  }

  /**
   * Each child that takes its parent's new team is a change of its own: a new rev and revision, and it counts as changed
   * in the write, so since_version readers see it. Its writer stays, so the trust of its text does not change.
   */
  private retagChildren(projectId: string, key: string, teamId: string | null, by: BpActor, at: number, res: WriteResult, skip?: Set<string>): void {
    for (const c of this.db.prepare('SELECT id, key, team_id FROM bp_items WHERE project_id=? AND parent_key=? AND deleted_at IS NULL ORDER BY key').all(projectId, key) as { id: string; key: string; team_id: string | null }[]) {
      if (c.team_id !== teamId && !skip?.has(c.key)) {
        this.db.prepare('UPDATE bp_items SET team_id=?, rev=rev+1 WHERE id=?').run(teamId, c.id);
        this.revision(c.id, by, at, `team follows ${key}`);
        if (!res.changed.includes(c.key)) res.changed.push(c.key);
      }
      this.retagChildren(projectId, c.key, teamId, by, at, res, skip);
    }
  }

  revision(itemId: string, by: BpActor, at: number, note: string | null): void {
    const r = this.db.prepare('SELECT * FROM bp_items WHERE id=?').get(itemId) as unknown as ItemRow;
    const { id: _i, project_id: _p, ...snap } = r;
    this.db.prepare('INSERT INTO bp_revisions(item_id,rev,snapshot,actor_kind,actor_id,at,change_note) VALUES (?,?,?,?,?,?,?)')
      .run(itemId, r.rev, JSON.stringify({ ...snap, fields: parse(r.fields, {}) }), by.kind, by.id, at, note);
    // Keep the newest revisions; older ones collapse into the oldest kept, marked as earlier changes.
    const keep = this.limits.revisionsPerItem;
    const n = (this.db.prepare('SELECT COUNT(*) n FROM bp_revisions WHERE item_id=?').get(itemId) as { n: number }).n;
    if (n > keep) {
      const cut = (this.db.prepare('SELECT rev FROM bp_revisions WHERE item_id=? ORDER BY rev DESC LIMIT 1 OFFSET ?').get(itemId, keep - 1) as { rev: number }).rev;
      this.db.prepare('DELETE FROM bp_revisions WHERE item_id=? AND rev<?').run(itemId, cut);
      this.db.prepare("UPDATE bp_revisions SET change_note='earlier changes collapsed' WHERE item_id=? AND rev=?").run(itemId, cut);
    }
  }

  private remove(p: ProjectRow, key: string, actor: BpActor, o: WriteOpts, now: number, res: WriteResult): void {
    const r = this.mustRow(p.id, key);
    const kids = this.db.prepare('SELECT key FROM bp_items WHERE project_id=? AND parent_key=? AND deleted_at IS NULL').all(p.id, key) as { key: string }[];
    if (kids.length) throw err('invalid_argument', `${key} still holds ${kids.map((k) => k.key).join(', ')}; remove or move them first.`);
    const by = o.by?.[key] ?? o.author ?? actor, at = o.at?.[key] ?? now;
    this.db.prepare('UPDATE bp_items SET deleted_at=?, rev=rev+1, updated_by_kind=?, updated_by_id=?, updated_at=? WHERE id=?').run(at, by.kind, by.id, at, r.id);
    this.revision(r.id, by, at, 'removed');
    // The claims this item was evidence for change support: touch them, so their attention episode moves on.
    this.touchClaims(p.id, this.claimsOf(p.id, key), by, at, `evidence ${key} removed`, res);
    this.db.prepare('DELETE FROM bp_links WHERE project_id=? AND (from_key=? OR to_key=?)').run(p.id, key, key);
    res.removed.push(key);
  }

  private link(p: ProjectRow, op: Extract<Op, { op: 'link' | 'unlink' }>, actor: BpActor, now: number, res: WriteResult): void {
    if (!RELS[op.rel]) throw err('invalid_argument', `Unknown link ${op.rel}; links are ${Object.keys(RELS).join(', ')} (an AC verifies its parent).`);
    if (op.op === 'unlink') {
      const r = this.db.prepare('DELETE FROM bp_links WHERE project_id=? AND from_key=? AND to_key=? AND rel=?').run(p.id, op.from, op.to, op.rel);
      if (r.changes) res.changed.push(`${op.from}→${op.to}`);
      if (r.changes && op.rel === 'evidence') this.touchClaims(p.id, [op.to], actor, now, `evidence ${op.from} unlinked`, res);
      return;
    }
    const from = this.row(p.id, op.from), to = this.row(p.id, op.to);
    if (!from || from.deleted_at) throw err('invalid_argument', `${op.from} is not in the blueprint.`);
    if (!to || to.deleted_at) throw err('invalid_argument', `${op.to} is not in the blueprint.`);
    if (op.from === op.to) throw err('invalid_argument', 'An item cannot link to itself.');
    if (!relAllows(op.rel, from.kind, to.kind)) {
      throw err('invalid_argument', `${op.rel} links ${relText(op.rel)}; not a ${from.kind} to a ${to.kind}.`);
    }
    const r = this.db.prepare('INSERT OR IGNORE INTO bp_links(project_id,from_key,to_key,rel,created_by_kind,created_by_id,created_at) VALUES (?,?,?,?,?,?,?)').run(p.id, op.from, op.to, op.rel, actor.kind, actor.id, now);
    if (r.changes) { res.changed.push(`${op.from}→${op.to}`); this.checkLinkCount(p.id, op.from); this.checkLinkCount(p.id, op.to); if (op.rel === 'evidence') this.touchClaims(p.id, [op.to], actor, now, `evidence ${op.from} linked`, res); }
  }
  /** The live items an item is evidence for. */
  private claimsOf(projectId: string, key: string): string[] {
    return (this.db.prepare("SELECT to_key k FROM bp_links WHERE project_id=? AND from_key=? AND rel='evidence'").all(projectId, key) as { k: string }[]).map((r) => r.k);
  }
  /**
   * Evidence linked, unlinked, removed, or a change to its status or result changes a claim's support: the claim changes
   * (strictly later), with a new rev and a revision naming who did it, so its attention episode moves on and its history
   * says why. Like any other claim change: it counts as changed in the write (its changed_version and the event).
   */
  private touchClaims(projectId: string, keys: string[], by: BpActor, at: number, note: string, res: WriteResult): void {
    for (const key of new Set(keys)) {
      const r = this.row(projectId, key);
      if (!r || r.deleted_at) continue;
      this.db.prepare('UPDATE bp_items SET rev=rev+1, updated_by_kind=?, updated_by_id=?, updated_at=MAX(updated_at+1, ?) WHERE id=?').run(by.kind, by.id, at, r.id);
      this.revision(r.id, by, (this.row(projectId, key)!).updated_at, note);
      if (!res.changed.includes(key)) res.changed.push(key);
    }
  }

  private checkLinkCount(projectId: string, key: string): void {
    const n = (this.db.prepare('SELECT COUNT(*) n FROM bp_links WHERE project_id=? AND (from_key=? OR to_key=?)').get(projectId, key, key) as { n: number }).n;
    if (n > this.limits.linksPerItem) throw err('invalid_argument', `${key} has more than ${this.limits.linksPerItem} links (limit links_per_item, set by the operator).`);
  }
  /**
   * The report archive (§6): a project keeps the newest reports_per_project status reports live; older ones get
   * archived=1, which live reads, the card and the summary skip and the export keeps. One way: raising the limit later
   * does not bring archived reports back. Each team's newest report stays live whatever its age, so a team that reports
   * rarely keeps its last report on the card, in bp_report and in Home attention. Returns how many were archived now.
   */
  archiveReports(projectId: string): number {
    const keep = this.limits.reportsPerProject;
    const r = this.db.prepare(`UPDATE bp_items SET archived=1 WHERE id IN (SELECT id FROM bp_items WHERE project_id=? AND kind='report' AND deleted_at IS NULL AND archived=0
      ORDER BY created_at DESC, key DESC LIMIT -1 OFFSET ?)
      AND id NOT IN (SELECT b.id FROM bp_items b WHERE b.project_id=? AND b.kind='report' AND b.deleted_at IS NULL AND NOT EXISTS (
        SELECT 1 FROM bp_items c WHERE c.project_id=b.project_id AND c.team_id IS b.team_id AND c.kind='report' AND c.deleted_at IS NULL
          AND (c.created_at>b.created_at OR (c.created_at=b.created_at AND c.key>b.key))))`).run(projectId, keep, projectId);
    return Number(r.changes);
  }
  /** Every project's reports over the limit (after the operator lowers reports_per_project). */
  archiveAllReports(): number {
    let n = 0;
    for (const { id } of this.db.prepare('SELECT id FROM projects').all() as { id: string }[]) n += this.archiveReports(id);
    return n;
  }
  private liveCount(projectId: string): number { return (this.db.prepare('SELECT COUNT(*) n FROM bp_items WHERE project_id=? AND deleted_at IS NULL AND archived=0').get(projectId) as { n: number }).n; }

  /**
   * The item limits for items coming back into active work outside an ordinary write (unarchiving, §6): the project,
   * part, parent and per-kind limits, as for a new item. Call it inside the transaction that brings them back, so an
   * excess refuses the whole change and leaves the project as it was.
   */
  checkCapacity(projectId: string, keys: Iterable<string>): void { this.checkCounts(projectId, new Set(keys)); }

  private checkCounts(projectId: string, touched: Set<string>): void {
    const L = this.limits;
    // Status reports have their own limit, reports_per_project, and leave the item limits; so do retired and archived
    // items (§6). A status move out of a retired status touches the item, so reopening is checked here like a creation.
    const count = (where: string, ...args: string[]): { n: number; retired: number } => {
      const r = this.db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN ${RETIRED_SQL} THEN 1 ELSE 0 END), 0) r FROM bp_items WHERE project_id=? AND deleted_at IS NULL AND archived=0 AND ${where}`)
        .get(projectId, ...args) as { n: number; r: number };
      return { n: r.n - r.r, retired: r.r };
    };
    const also = (c: { retired: number }) => (c.retired ? ` ${c.retired} retired item${c.retired === 1 ? ' is' : 's are'} not counted.` : '');
    const items = count("kind<>'report'");
    if (items.n > L.itemsPerProject) throw err('invalid_argument', `A blueprint holds at most ${L.itemsPerProject} items (limit items_per_project, set by the operator).${also(items)}`);
    const lines = (this.db.prepare("SELECT COUNT(*) n FROM bp_items WHERE project_id=? AND kind='line' AND deleted_at IS NULL").get(projectId) as { n: number }).n;
    if (lines > L.lines) throw err('invalid_argument', `A blueprint holds at most ${L.lines} lines (limit lines, set by the operator).`);
    const papers = count("kind='paper'");
    if (papers.n > L.papers) throw err('invalid_argument', `A blueprint holds at most ${L.papers} papers (limit papers, set by the operator).${also(papers)}`);
    const teams = new Set<string>(), parents = new Set<string>(), paperKeys = new Set<string>();
    for (const k of touched) {
      const r = this.row(projectId, k);
      if (!r || r.deleted_at) continue;
      if (r.team_id) teams.add(r.team_id);
      if (r.kind === 'ac' && r.parent_key) parents.add(r.parent_key);
      if (r.kind === 'claim' && r.parent_key) paperKeys.add(r.parent_key);
    }
    for (const pk of paperKeys) {
      const c = count("parent_key=? AND kind='claim'", pk);
      if (c.n > L.claimsPerPaper) throw err('invalid_argument', `${pk} holds at most ${L.claimsPerPaper} claims (limit claims_per_paper, set by the operator).${also(c)}`);
    }
    // The only team of a project has no part limit: the project limit above holds (FR-PLAN-12).
    const sole = teams.size ? this.soleTeam(projectId) : null;
    for (const t of teams) {
      if (t === sole) continue; // the only team's part gives way to the project limit (FR-PLAN-12)
      const c = count("team_id=? AND kind<>'report'", t);
      if (c.n > L.itemsPerTeam) throw err('invalid_argument', `A team's part holds at most ${L.itemsPerTeam} items (limit items_per_team, set by the operator).${also(c)}`);
    }
    for (const pk of parents) {
      const c = count("parent_key=? AND kind='ac'", pk);
      if (c.n > L.acsPerParent) throw err('invalid_argument', `${pk} holds at most ${L.acsPerParent} acceptance criteria (limit acs_per_fr, set by the operator).${also(c)}`);
    }
  }

  // ───── start over (re-plan) for a project or one team's part ─────
  private toReplan(r: any): Replan {
    const items = (this.db.prepare('SELECT COUNT(*) n FROM bp_items WHERE replan_id=? AND deleted_at IS NULL').get(r.id) as { n: number }).n;
    const pr = this.db.prepare("SELECT id, status, agent_id, created_at, note FROM bp_proposals WHERE replan_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(r.id) as Replan['proposal'] | undefined;
    const { snapshot: _s, saved: _v, ...rest } = r;
    return { ...rest, kinds: parse(r.kinds, []), items, proposal: pr ?? null };
  }
  replan(id: string): Replan | undefined { const r = this.db.prepare('SELECT * FROM bp_replans WHERE id=?').get(id); return r ? this.toReplan(r) : undefined; }
  replans(projectId: string): Replan[] { return (this.db.prepare('SELECT * FROM bp_replans WHERE project_id=? ORDER BY opened_at DESC, rowid DESC LIMIT 50').all(projectId) as any[]).map((r) => this.toReplan(r)); }
  /** The export saved when the re-plan started. */
  replanSnapshot(id: string): { replan: Replan; text: string } | undefined {
    const r = this.db.prepare('SELECT * FROM bp_replans WHERE id=?').get(id) as any;
    return r ? { replan: this.toReplan(r), text: r.snapshot as string } : undefined;
  }
  /** The open re-plan that covers a team's part: one of that part, or one of the whole project. */
  openReplanFor(projectId: string, teamId: string | null): Replan | undefined {
    const r = this.db.prepare("SELECT * FROM bp_replans WHERE project_id=? AND status='open' AND (team_id IS NULL OR team_id=?) ORDER BY opened_at LIMIT 1").get(projectId, teamId);
    return r ? this.toReplan(r) : undefined;
  }
  private mustOpenReplan(id: string): any {
    const r = this.db.prepare('SELECT * FROM bp_replans WHERE id=?').get(id) as any;
    if (!r) throw err('not_found', 'No such re-plan.');
    if (r.status !== 'open') throw err('invalid_state', `The re-plan is ${r.status} already.`);
    return r;
  }
  /** Teams a re-plan speaks to: its part's team, or every team of the project that has not ended. */
  private replanTeams(projectId: string, teamId: string | null): { id: string; name: string }[] {
    return teamId ? this.db.prepare('SELECT id, name FROM teams WHERE id=?').all(teamId) as { id: string; name: string }[]
      : this.db.prepare("SELECT id, name FROM teams WHERE project_id=? AND status IN ('draft','running','paused') ORDER BY created_at").all(projectId) as { id: string; name: string }[];
  }
  /**
   * One event in history and the work feed, at a new version, for what a re-plan did (the items it touched count as
   * changed at it). `version`: a write without its own event already moved the project to that version; the event uses it.
   */
  replanEvent(p: ProjectRow, teamId: string | null, actor: BpActor, keys: string[], note: string, proposalId: string | null = null, moves: EventRow['moves'] = [], version?: number): number {
    const v = version ?? this.project(p.id)!.version + 1, now = Date.now();
    if (version === undefined) this.db.prepare('UPDATE projects SET version=?, updated_at=? WHERE id=?').run(v, now, p.id);
    const mark = this.db.prepare('UPDATE bp_items SET changed_version=? WHERE project_id=? AND key=?');
    for (const k of keys) mark.run(v, p.id, k);
    this.db.prepare("INSERT INTO bp_events(project_id,team_id,kind,version,actor_kind,actor_id,items,added,removed,changed,moves,note,proposal_id,created_at) VALUES (?,?,'update',?,?,?,?,'[]','[]',?,?,?,?,?)")
      .run(p.id, teamId, v, actor.kind, actor.id, this.liveCount(p.id), JSON.stringify(keys.slice(0, 500)), JSON.stringify(moves.slice(0, 500)), note, proposalId, now);
    return v;
  }

  /**
   * Open a re-plan (no side effects outside the database): save the export and the rows it may restore, reset
   * the chosen kinds of the part to their first status (FR, NFR → draft, AC → open, milestone, release → planned,
   * risk, issue → open; a glossary term has none), and mark them. Nothing is deleted, so keys, links, task refs and
   * history stay. One open re-plan per part: a project-wide one excludes any part's, and the reverse.
   */
  private openReplan(p: ProjectRow, a: { team_id?: string | null; kinds?: string[]; note?: string | null; extra?: string[] }, actor: BpActor, source: 'operator' | 'import'): { id: string; reset: string[] } {
    if (p.status !== 'active') throw err('invalid_state', `Project ${p.key} is ${p.status}; resume it before starting over.`);
    const teamId = a.team_id ?? null;
    if (teamId && !this.db.prepare('SELECT 1 FROM teams WHERE id=? AND project_id=?').get(teamId, p.id)) throw err('invalid_argument', `Team ${teamId} is not part of project ${p.key}.`);
    const kinds = [...new Set(a.kinds?.length ? a.kinds : REPLAN_DEFAULT)];
    const bad = kinds.filter((k) => !REPLAN_KINDS.includes(k));
    if (bad.length) throw err('invalid_argument', `A re-plan resets ${REPLAN_KINDS.join(', ')}; not ${bad.join(', ')}.`, { kinds: REPLAN_KINDS });
    const open = this.db.prepare("SELECT id, team_id FROM bp_replans WHERE project_id=? AND status='open'").all(p.id) as { id: string; team_id: string | null }[];
    const clash = open.find((o) => o.team_id === null || teamId === null || o.team_id === teamId);
    if (clash) {
      const name = clash.team_id ? (this.db.prepare('SELECT name FROM teams WHERE id=?').get(clash.team_id) as { name: string } | undefined)?.name ?? clash.team_id : null;
      throw err('invalid_state', `A re-plan of ${name ? `${name}'s part` : 'the whole project'} is still open (${clash.id}); apply or cancel it first.`, { replan_id: clash.id });
    }
    const rows = (this.db.prepare(`SELECT * FROM bp_items WHERE project_id=? AND deleted_at IS NULL AND kind IN (${kinds.map(() => '?').join(',')}) ${teamId ? 'AND team_id=?' : ''} ORDER BY kind, position, key`)
      .all(p.id, ...kinds, ...(teamId ? [teamId] : [])) as unknown as ItemRow[]);
    const scope = new Set(rows.map((r) => r.key));
    for (const k of a.extra ?? []) { const r = this.liveRow(p.id, k); if (r && !scope.has(k)) { rows.push(r); scope.add(k); } }
    const links = this.links(p.id).filter((l) => scope.has(l.from_key) || scope.has(l.to_key));
    const snapshot = this.deps.exportMd ? this.deps.exportMd(p.id) : rows.map((r) => `- ${r.key} [${r.status ?? r.kind}] ${r.title}`).join('\n');
    const id = `bpr_${randomToken(10)}`, now = Date.now();
    this.db.prepare('INSERT INTO bp_replans(id,project_id,team_id,kinds,note,status,snapshot,saved,base_version,source,opened_by_kind,opened_by_id,opened_at) VALUES (?,?,?,?,?,\'open\',?,?,?,?,?,?,?)')
      .run(id, p.id, teamId, JSON.stringify(kinds), a.note ?? null, snapshot, JSON.stringify({ items: rows, links }), p.version, source, actor.kind, actor.id, now);
    // Back to the first status, keeping each item's last writer (its text's trust does not change with a reset).
    const reset = rows.filter((r) => kinds.includes(r.kind) && (KINDS[r.kind]!.statuses?.[0] ?? null) !== r.status);
    const by = Object.fromEntries(reset.map((r) => [r.key, { kind: r.updated_by_kind as BpActorKind, id: r.updated_by_id }]));
    if (reset.length) this.apply(p.id, reset.map((r) => ({ op: 'upsert', kind: r.kind, key: r.key, status: KINDS[r.kind]!.statuses![0]! })), actor, { force: true, noEvent: true, by, teamId });
    const mark = this.db.prepare('UPDATE bp_items SET replan_id=? WHERE id=?');
    for (const r of rows) mark.run(id, r.id);
    const moves = reset.map((r) => ({ key: r.key, status: KINDS[r.kind]!.statuses![0]!, was: r.status }));
    this.replanEvent(p, teamId, actor, [...scope], `re-plan ${id} started${source === 'import' ? ' by the docs import' : ''}: ${scope.size} item${scope.size === 1 ? '' : 's'} of ${kinds.join(', ')}${a.note ? ` (${a.note})` : ''}`, null, moves);
    return { id, reset: [...scope] };
  }

  /** The operator starts over (§6 POST /api/projects/:id/replan): the part's coordinators get a replan_requested notice. */
  startReplan(projectId: string, a: { team_id?: string | null; kinds?: string[]; note?: string | null }, actor: BpActor): { replan: Replan; reset: string[] } {
    const p = this.project(projectId);
    if (!p) throw err('not_found', 'No such project.');
    const note = a.note?.trim().slice(0, 1000) || null;
    const r = atomic(this.db, () => this.openReplan(p, { ...a, note }, actor, 'operator'));
    const rp = this.replan(r.id)!;
    for (const t of this.replanTeams(p.id, rp.team_id)) {
      this.notify(this.coordinators(t.id), 'replan_requested',
        `The administrator started over ${rp.team_id ? `your team's part of project ${p.key}` : `project ${p.key}`} (re-plan ${rp.id}): ${r.reset.length} item${r.reset.length === 1 ? '' : 's'} of ${rp.kinds.join(', ')} are back to their first status and marked re-plan. `
        + `Read them with bp_read (marked items show {re-plan}); in your part, rewrite, re-link or delete them with bp_write without a proposal per change, and new items of those kinds join the re-plan. Requirements stay draft: approving the re-plan agrees them. `
        + `When done, submit once with bp_proposals {action: "submit_replan", team_id: "${t.id}"}; the operator reviews the before/after as a whole.${note ? ` Note: ${note}` : ''}`);
    }
    this.deps.audit?.event(auditActor(actor), 'blueprint.replan_start', { kind: 'project', id: p.id }, { key: p.key, replan: rp.id, team: rp.team_id, kinds: rp.kinds, items: r.reset.length });
    this.deps.audit?.alert('info', 'bp_replan', rp.id, { project: p.key, team: rp.team_id, items: r.reset.length });
    return { replan: rp, reset: r.reset };
  }

  /** Withdraw the re-plan's open submission (a new one replaces it, a cancel closes it). */
  private closeReplanProposal(replanId: string, by: string | null, note: string): void {
    this.db.prepare("UPDATE bp_proposals SET status='withdrawn', decided_by=?, decided_at=?, note=? WHERE replan_id=? AND status='open'").run(by, Date.now(), note, replanId);
    this.deps.audit?.settle('bp_proposal');
  }
  private fileReplanProposal(p: ProjectRow, rp: Replan, teamId: string | null, agentId: string | null, reason: string | null): Proposal {
    const id = `bpp_${randomToken(10)}`;
    this.closeReplanProposal(rp.id, agentId, 'replaced by a new submission');
    this.db.prepare("INSERT INTO bp_proposals(id,project_id,team_id,agent_id,ops,base_version,reason,status,created_at,revs,type,replan_id) VALUES (?,?,?,?,'[]',?,?,'open',?,'{}','replan',?)")
      .run(id, p.id, teamId, agentId, this.project(p.id)!.version, reason, Date.now(), rp.id);
    return this.proposal(id)!;
  }

  /**
   * The coordinator submits its re-plan once (bp_proposals {action: submit_replan}): one proposal of type `replan`, which the
   * operator reviews as a before/after diff against the snapshot. Submitting again replaces the pending submission.
   */
  submitReplan(projectId: string, a: { reason?: string | null; team_id?: string | null }, agentId: string): { proposal: Proposal; replan: Replan; diff: ReplanDiff } {
    const p = this.project(projectId);
    if (!p) throw err('not_found', 'No such project.');
    const { team, role } = this.seat(p.id, agentId, a.team_id);
    this.guard(p, team, agentId);
    if (role !== 'coordinator') throw err('denied', 'The coordinator submits the re-plan.');
    const rp = this.openReplanFor(p.id, team.id);
    if (!rp) throw err('invalid_state', `No re-plan of your team's part of ${p.key} is open.`);
    if (rp.source !== 'operator') throw err('denied', `Re-plan ${rp.id} is the docs import's; the operator reviews it.`);
    const reason = a.reason?.trim().slice(0, 2000) || null;
    const pr = atomic(this.db, () => this.fileReplanProposal(p, rp, team.id, agentId, reason));
    const who = this.label(agentId), diff = this.replanDiff(rp.id);
    this.deps.audit?.alert('info', 'bp_proposal', pr.id, { project: p.key, team: team.name, agent: who, ops: 0, keys: `re-plan ${rp.id}: ${diff.added.length} added, ${diff.changed.length} changed, ${diff.removed.length} removed` });
    this.deps.audit?.event({ kind: 'agent', id: agentId }, 'blueprint.replan_submit', { kind: 'bp_proposal', id: pr.id }, { project: p.key, replan: rp.id });
    return { proposal: pr, replan: this.replan(rp.id)!, diff };
  }

  /** The operator files the review itself (an import's re-plan, or after sending a coordinator's back and fixing it with ops). */
  submitReplanAsOperator(replanId: string, actor: BpActor, note?: string | null): { proposal: Proposal; replan: Replan } {
    const r = this.mustOpenReplan(replanId), p = this.project(r.project_id)!;
    const pr = atomic(this.db, () => this.fileReplanProposal(p, this.toReplan(r), r.team_id, null, note?.trim().slice(0, 2000) || 'filed by the operator'));
    this.deps.audit?.event(auditActor(actor), 'blueprint.replan_submit', { kind: 'bp_proposal', id: pr.id }, { project: p.key, replan: r.id });
    return { proposal: pr, replan: this.replan(r.id)! };
  }

  /** What the re-plan changed against what it saved: added, removed and changed items, and links. */
  replanDiff(replanId: string): ReplanDiff {
    const r = this.db.prepare('SELECT * FROM bp_replans WHERE id=?').get(replanId) as any;
    if (!r) throw err('not_found', 'No such re-plan.');
    const saved = parse<{ items: ItemRow[]; links: LinkRow[] }>(r.saved, { items: [], links: [] });
    const before = new Map(saved.items.map((i) => [i.key, i]));
    const now = new Map((this.db.prepare('SELECT * FROM bp_items WHERE project_id=? AND (replan_id=? OR key IN (SELECT value FROM json_each(?)))').all(r.project_id, r.id, JSON.stringify([...before.keys()])) as unknown as ItemRow[]).map((i) => [i.key, i]));
    const d: ReplanDiff = { added: [], removed: [], changed: [], unchanged: 0, links: { added: [], removed: [] } };
    const di = (i: ItemRow): DiffItem => ({ key: i.key, kind: i.kind, title: i.title, status: i.status });
    for (const [k, b] of before) {
      const n = now.get(k);
      if (!n || n.deleted_at) { d.removed.push(di(b)); continue; }
      const what = (['title', 'body', 'status', 'parent_key', 'fields', 'team_id', 'position'] as const).filter((f) => (b[f] ?? null) !== (n[f] ?? null));
      if (what.length) d.changed.push({ ...di(n), what, was: { title: b.title, status: b.status, body: b.body, parent_key: b.parent_key } });
      else d.unchanged++;
    }
    for (const [k, n] of now) if (!before.has(k) && !n.deleted_at) d.added.push(di(n));
    const keys = new Set([...before.keys(), ...now.keys()]);
    const lk = (l: LinkRow) => `${l.from_key} ${l.rel} ${l.to_key}`;
    const was = new Set(saved.links.map(lk)), is = new Set(this.links(r.project_id).filter((l) => keys.has(l.from_key) || keys.has(l.to_key)).map(lk));
    d.links.added = [...is].filter((x) => !was.has(x));
    d.links.removed = [...was].filter((x) => !is.has(x));
    const order = (a: DiffItem, b: DiffItem) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.key.localeCompare(b.key, 'en', { numeric: true });
    d.added.sort(order); d.removed.sort(order); d.changed.sort(order);
    return d;
  }

  /**
   * The operator applies a re-plan's submission as a whole: requirements still draft become agreed (other kinds keep the
   * status the coordinator set), the marks clear and the re-plan closes. If a marked item changed after the submission,
   * nothing is applied: the submission turns stale and the re-plan stays open for a new one.
   */
  private applyReplan(pr: Proposal, actor: BpActor, note?: string | null): { proposal: Proposal; result: WriteResult | null; stale: string | null } {
    const r = this.mustOpenReplan(pr.replan_id!), p = this.project(pr.project_id)!;
    const moved = (this.db.prepare('SELECT key FROM bp_items WHERE replan_id=? AND changed_version>? ORDER BY key LIMIT 20').all(r.id, pr.base_version) as { key: string }[]).map((x) => x.key);
    if (moved.length) {
      const stale = `${moved.join(', ')} changed after it was submitted`;
      this.decide(pr, 'stale', actor, stale);
      return { proposal: this.proposal(pr.id)!, result: null, stale };
    }
    const agree = this.db.prepare("SELECT * FROM bp_items WHERE replan_id=? AND deleted_at IS NULL AND kind IN ('fr','nfr') AND status='draft' ORDER BY key").all(r.id) as unknown as ItemRow[];
    const by = Object.fromEntries(agree.map((x) => [x.key, { kind: x.updated_by_kind as BpActorKind, id: x.updated_by_id }]));
    // The agreement and the close are one event at one new version.
    let result: WriteResult | null = null;
    if (agree.length) result = this.apply(p.id, agree.map((x) => ({ op: 'upsert', kind: x.kind, key: x.key, status: 'agreed' })), actor, { force: true, noEvent: true, by, note: `re-plan ${r.id} applied`, teamId: r.team_id, proposalId: pr.id });
    const held = (this.db.prepare('SELECT key FROM bp_items WHERE replan_id=?').all(r.id) as { key: string }[]).map((x) => x.key);
    this.db.prepare('UPDATE bp_items SET replan_id=NULL WHERE replan_id=?').run(r.id);
    this.db.prepare("UPDATE bp_replans SET status='applied', closed_by=?, closed_at=?, close_note=? WHERE id=?").run(actor.id, Date.now(), note?.trim() || null, r.id);
    this.deps.audit?.settle('bp_replan', r.id);
    const v = this.replanEvent(p, r.team_id, actor, held, `re-plan ${r.id} applied: ${held.length} item${held.length === 1 ? '' : 's'}${agree.length ? `, ${agree.length} requirement${agree.length === 1 ? '' : 's'} agreed` : ''}`, pr.id, result?.moves ?? [], result && result.version > p.version ? result.version : undefined);
    if (result) result.version = v;
    this.decide(pr, 'applied', actor, note?.trim() || null);
    for (const t of this.replanTeams(p.id, r.team_id)) this.notify(this.coordinators(t.id).filter((c) => c !== pr.agent_id), 'replan_requested', `The administrator applied re-plan ${r.id} of ${r.team_id ? `team "${t.name}"'s part of` : 'project'} ${p.key}: the blueprint is agreed again. Read it with bp_read.`);
    this.deps.audit?.event(auditActor(actor), 'blueprint.replan_apply', { kind: 'project', id: p.id }, { key: p.key, replan: r.id, proposal: pr.id, items: held.length });
    return { proposal: this.proposal(pr.id)!, result, stale: null };
  }

  /**
   * The operator cancels a re-plan: every item it saved gets its status and content back from the snapshot (removed ones
   * return), items it created are removed, links return to what they were, and its open submission is withdrawn.
   */
  cancelReplan(id: string, actor: BpActor, note?: string | null): { replan: Replan; restored: string[]; removed: string[] } {
    const out = atomic(this.db, () => {
      const r = this.mustOpenReplan(id), p = this.project(r.project_id)!, now = Date.now();
      const saved = parse<{ items: ItemRow[]; links: LinkRow[] }>(r.saved, { items: [], links: [] });
      const keys = new Set(saved.items.map((i) => i.key));
      const created = this.db.prepare('SELECT * FROM bp_items WHERE replan_id=? AND deleted_at IS NULL').all(r.id) as unknown as ItemRow[];
      const removed: string[] = [], restored: string[] = [];
      for (const c of created.filter((c) => !keys.has(c.key))) {
        this.db.prepare('UPDATE bp_items SET deleted_at=?, rev=rev+1, updated_by_kind=?, updated_by_id=?, updated_at=?, replan_id=NULL WHERE id=?').run(now, actor.kind, actor.id, now, c.id);
        this.revision(c.id, actor, now, 're-plan cancelled');
        removed.push(c.key);
      }
      const put = this.db.prepare('UPDATE bp_items SET parent_key=?, title=?, body=?, fields=?, status=?, team_id=?, position=?, rev=rev+1, updated_by_kind=?, updated_by_id=?, updated_at=?, deleted_at=NULL, replan_id=NULL WHERE id=?');
      for (const s of saved.items) {
        const cur = this.db.prepare('SELECT * FROM bp_items WHERE id=?').get(s.id) as ItemRow | undefined;
        if (!cur) continue;
        const same = !cur.deleted_at && (['parent_key', 'title', 'body', 'fields', 'status', 'team_id', 'position'] as const).every((f) => (cur[f] ?? null) === (s[f] ?? null));
        if (same) { this.db.prepare('UPDATE bp_items SET replan_id=NULL WHERE id=?').run(s.id); continue; }
        put.run(s.parent_key, s.title, s.body, s.fields, s.status, s.team_id, s.position, s.updated_by_kind, s.updated_by_id, now, s.id);
        this.revision(s.id, { kind: s.updated_by_kind as BpActorKind, id: s.updated_by_id }, now, 'restored: re-plan cancelled');
        restored.push(s.key);
      }
      this.db.prepare('UPDATE bp_items SET replan_id=NULL WHERE replan_id=?').run(r.id);
      // Links: those touching its items go back to the saved set (when both ends live).
      const all = new Set([...keys, ...removed]);
      for (const l of this.links(p.id)) if (all.has(l.from_key) || all.has(l.to_key)) this.db.prepare('DELETE FROM bp_links WHERE project_id=? AND from_key=? AND to_key=? AND rel=?').run(p.id, l.from_key, l.to_key, l.rel);
      const ins = this.db.prepare('INSERT OR IGNORE INTO bp_links(project_id,from_key,to_key,rel,created_by_kind,created_by_id,created_at) VALUES (?,?,?,?,?,?,?)');
      for (const l of saved.links) if (this.liveRow(p.id, l.from_key) && this.liveRow(p.id, l.to_key)) ins.run(p.id, l.from_key, l.to_key, l.rel, l.created_by_kind, l.created_by_id, l.created_at);
      this.closeReplanProposal(r.id, actor.id, 're-plan cancelled');
      this.db.prepare("UPDATE bp_replans SET status='cancelled', closed_by=?, closed_at=?, close_note=? WHERE id=?").run(actor.id, now, note?.trim().slice(0, 1000) || null, r.id);
      this.deps.audit?.settle('bp_replan', r.id);
      this.replanEvent(p, r.team_id, actor, [...all], `re-plan ${r.id} cancelled: ${restored.length} restored, ${removed.length} removed${note?.trim() ? ` (${note.trim()})` : ''}`);
      return { r, p, restored, removed };
    });
    for (const t of this.replanTeams(out.p.id, out.r.team_id)) this.notify(this.coordinators(t.id), 'replan_requested', `The administrator cancelled re-plan ${out.r.id} of ${out.r.team_id ? `team "${t.name}"'s part of` : 'project'} ${out.p.key}: the blueprint is back to its snapshot. Read it again with bp_read.${note?.trim() ? ` Note: ${note.trim()}` : ''}`);
    this.deps.audit?.event(auditActor(actor), 'blueprint.replan_cancel', { kind: 'project', id: out.p.id }, { key: out.p.key, replan: out.r.id, restored: out.restored.length, removed: out.removed.length });
    return { replan: this.replan(id)!, restored: out.restored, removed: out.removed };
  }

  // ───── agents: rights and proposals (§4, §2.6) ─────
  /**
   * An agent's write. Each op is checked against the rights matrix for the caller's team and role: all allowed → applied
   * at once; any that needs the operator → the whole batch becomes one proposal; any the caller may not even propose →
   * refused. Lockdown, a paused or ended team and a paused or closed project refuse writes and proposals alike.
   */
  submit(projectId: string, a: { version: number; ops: Op[]; reason?: string | null; team_id?: string | null; request_id?: number }, agentId: string): SubmitResult {
    const p = this.project(projectId);
    if (!p) throw err('not_found', 'No such project.');
    const { team, role } = this.seat(p.id, agentId, a.team_id);
    this.guard(p, team, agentId);
    if (!Number.isInteger(a.version)) throw err('invalid_argument', 'Pass the project version you read.');
    this.checkBatch(a.ops);
    this.noRestoreMarker(a.ops);
    const req = a.request_id !== undefined ? requestById(this.db, a.request_id) : undefined;
    if (a.request_id !== undefined && !req) throw err('not_found', 'No such request.');
    if (req) this.checkRefine(p, team, role, req, a.ops);
    const reason = a.reason?.trim().slice(0, 2000) || null;
    const { rights, verdict, replan } = this.rightsOf(p, team.id, role, a.ops, agentId);
    if (verdict === 'deny') {
      // What is wrong with the ops comes before whose they are: a bad key, kind, parent or field is named first, with
      // its rule, so the writer fixes it instead of chasing rights for an item that could never be written. Only
      // invalid_argument is raised from the dry run; a conflict or anything else leaves the refusal below.
      try { this.dryRun(p.id, a.ops, { kind: 'agent', id: agentId }, a.version); }
      catch (e) { if ((e as { code?: string }).code === 'invalid_argument') throw e; }
      throw err('denied', `Not yours to change: ${[...new Set(rights.filter((r) => r.verdict === 'deny').map((r) => r.why))].join('; ')}. ${RIGHTS_RULE}`);
    }
    const actor: BpActor = { kind: 'agent', id: agentId };
    // A write with a refine request's id is always a proposal, even where the coordinator could write directly.
    if (verdict === 'apply' && !req) {
      const r = atomic(this.db, () => {
        const decided = a.ops.flatMap((o, i) => (rights[i]!.decided && 'key' in o ? [o.key] : []));
        const ruled = this.ruledOf(a.ops, rights);
        const w = this.apply(p.id, a.ops, actor, { note: reason, teamId: team.id, ...(decided.length ? { decided } : {}), ...(ruled ? { ruled } : {}) }, a.version);
        if (decided.length) this.recordDecided(p, team, agentId, decided, w);
        if (ruled) this.recordRuled(p, team, agentId, ruled, w);
        // New items of the re-plan's kinds in this part join it, so a cancel removes them again.
        if (replan && role === 'coordinator' && w.added.length) {
          const mark = this.db.prepare(`UPDATE bp_items SET replan_id=? WHERE project_id=? AND key=? AND team_id=? AND kind IN (${replan.kinds.map(() => '?').join(',')})`);
          for (const k of w.added) mark.run(replan.id, p.id, k, team.id, ...replan.kinds);
        }
        return w;
      });
      // A coordinator's applied write answers the team's open plan review requests (F-04, §6).
      if (role === 'coordinator' && (r.added.length || r.changed.length || r.removed.length)) answerRequests(this.db, team.id, 'plan', 'bp_write');
      const rule = this.ruledOf(a.ops, rights)?.rule;
      return { status: 'applied', ...r, ...(rule ? { rule } : {}) };
    }
    const proposal = this.propose(p, team, agentId, a.ops, a.version, reason, false, req?.id);
    return { status: 'proposed', proposal, why: [...new Set(rights.filter((r) => r.verdict === 'propose').map((r) => r.why))] };
  }

  /**
   * The caller's project and team, for the bp_* tools and every agent write: the project named (key or id) and the team
   * named, or the only ones the agent is in. With `needTeam`, an agent in several teams of the project must name one;
   * without it the team is null then. Not a member answers like a missing project.
   */
  locate(agentId: string, a: { project?: string | null; team_id?: string | null }, needTeam: boolean): { project: ProjectRow; seat: Seat | null } {
    const p = a.project ? this.projectByKey(a.project) ?? this.project(a.project) : undefined;
    if (a.project && !p) throw err('denied', NOT_ALLOWED);
    const rows = this.db.prepare(`SELECT t.id, t.name, t.status, t.paused_reason, t.project_id, m.role FROM team_members m JOIN teams t ON t.id=m.team_id
      WHERE m.agent_id=? AND m.removed_at IS NULL AND t.project_id IS NOT NULL ${a.team_id ? 'AND t.id=?' : ''} ${p ? 'AND t.project_id=?' : ''} ORDER BY t.created_at, t.id`)
      .all(agentId, ...(a.team_id ? [a.team_id] : []), ...(p ? [p.id] : [])) as (Seat['team'] & { project_id: string; role: string })[];
    if (!rows.length) throw err('denied', NOT_ALLOWED);
    // Keys such as M14 are per project (§3): without a project or team named, the caller's live teams must all be in one
    // project, or the call is refused with those projects listed. Ended teams do not make it ambiguous.
    const live = rows.filter((r) => !ENDED_TEAM.includes(r.status));
    const projects = [...new Set((live.length ? live : rows).map((r) => r.project_id))];
    if (projects.length > 1) throw err('invalid_argument', `Your live teams are in ${projects.length} projects, and a key such as M14 means a different item in each; name project (${projects.map((id) => this.project(id)!.key).join(', ')}) or team_id.`);
    if (!p && !a.team_id && live.length) rows.splice(0, rows.length, ...rows.filter((r) => r.project_id === projects[0]));
    const project = p ?? this.project(projects[0]!)!;
    if (rows.length > 1 && needTeam) throw err('invalid_argument', `You are in ${rows.length} teams of ${project.key}; name team_id (${rows.map((r) => r.id).join(', ')}).`);
    if (rows.length > 1) return { project, seat: null };
    const { project_id: _p, role, ...team } = rows[0]!;
    return { project, seat: { team, role: role === 'coordinator' ? 'coordinator' : 'member' } };
  }
  /** The caller's team in this project and its blueprint role; a member of several teams there names one. */
  seat(projectId: string, agentId: string, teamId?: string | null): Seat {
    return this.locate(agentId, { project: projectId, team_id: teamId }, true).seat!;
  }

  /**
   * A coordinator agreed requirements under coordinator_decides_blueprint (§4): audited with its actor, and added to the
   * operator's digest, one `info` alert per team and day that lists every requirement agreed that day (Log → Alerts).
   */
  private recordDecided(p: ProjectRow, team: { id: string; name: string }, agentId: string, keys: string[], w: WriteResult): void {
    const moves = w.moves.filter((m) => keys.includes(m.key));
    if (!moves.length) return;
    this.deps.audit?.event({ kind: 'agent', id: agentId }, 'blueprint.coordinator_decide', { kind: 'team', id: team.id }, { project: p.key, version: w.version, items: moves.map((m) => ({ item: m.key, from: m.was, to: m.status })) }); // 'key' would be redacted
    this.deps.audit?.digest('info', 'bp_coordinator_decided', `${team.id}|${new Date().toISOString().slice(0, 10)}`,
      { project: p.key, team: team.name, agent: this.label(agentId) }, 'items', moves.map((m) => `${m.key} ${m.was} → ${m.status}`));
  }

  /** The keys of a batch that a rule applied, with the rule; null when none did. One rule exists, so one rule per batch. */
  private ruledOf(ops: Op[], rights: { rule?: BpRule }[]): { rule: BpRule; keys: string[] } | null {
    const keys = ops.flatMap((o, i) => (rights[i]!.rule && 'key' in o ? [o.key] : []));
    const rule = rights.find((r) => r.rule)?.rule;
    return rule && keys.length ? { rule, keys } : null;
  }
  /** A write a rule applied (§4 Rules): audited with the agent as actor; the operator sees it under For awareness. */
  private recordRuled(p: ProjectRow, team: { id: string; name: string }, agentId: string, ruled: { rule: BpRule; keys: string[] }, w: WriteResult): void {
    const items = ruled.keys.filter((k) => w.added.includes(k) || w.changed.includes(k));
    if (!items.length) return;
    this.deps.audit?.event({ kind: 'agent', id: agentId }, 'blueprint.rule_applied', { kind: 'team', id: team.id }, { project: p.key, rule: ruled.rule, version: w.version, items });
  }

  // ───── Rules the operator turns on (§4 Rules, ADR-006) ─────
  /** The rules on (not paused) for a team in a project. */
  activeRules(projectId: string, teamId: string): Set<BpRule> {
    return new Set((this.db.prepare("SELECT rule FROM bp_rules WHERE project_id=? AND team_id=? AND state='on'").all(projectId, teamId) as { rule: BpRule }[]).map((r) => r.rule));
  }
  /** Every rule of the fixed list for each team of the project, with its state (off when it has no row). */
  rules(projectId: string): { team_id: string; team: string; rule: BpRule; label: string; applies: string; state: 'on' | 'paused' | 'off'; on_since: number | null; set_by: string | null; set_at: number | null }[] {
    if (!this.project(projectId)) throw err('not_found', 'No such project.');
    const teams = this.db.prepare("SELECT id, name FROM teams WHERE project_id=? AND status<>'stopped' ORDER BY name").all(projectId) as { id: string; name: string }[];
    const rows = this.db.prepare('SELECT * FROM bp_rules WHERE project_id=?').all(projectId) as { team_id: string; rule: BpRule; state: 'on' | 'paused'; on_since: number; set_by: string | null; set_at: number }[];
    return teams.flatMap((t) => (Object.keys(BP_RULES) as BpRule[]).map((rule) => {
      const r = rows.find((x) => x.team_id === t.id && x.rule === rule);
      return { team_id: t.id, team: t.name, rule, label: BP_RULES[rule].label, applies: BP_RULES[rule].applies, state: r?.state ?? 'off', on_since: r?.on_since ?? null, set_by: r?.set_by ?? null, set_at: r?.set_at ?? null };
    }));
  }
  /**
   * Turn a rule on, pause it or turn it off for one team of the project. It takes effect on the next write. Returns the
   * state before and after; the caller audits it. Turning it on again keeps its first on_since only while it is paused.
   */
  setRule(projectId: string, teamId: string, rule: BpRule, state: 'on' | 'paused' | 'off', by: string | null, now = Date.now()): { was: 'on' | 'paused' | 'off'; state: 'on' | 'paused' | 'off' } {
    const p = this.project(projectId);
    if (!p) throw err('not_found', 'No such project.');
    if (!this.db.prepare('SELECT 1 FROM teams WHERE id=? AND project_id=?').get(teamId, projectId)) throw err('invalid_argument', `That team is not a team of project ${p.key}.`);
    const cur = this.db.prepare('SELECT state FROM bp_rules WHERE project_id=? AND team_id=? AND rule=?').get(projectId, teamId, rule) as { state: 'on' | 'paused' } | undefined;
    const was = cur?.state ?? 'off';
    if (state === 'off') this.db.prepare('DELETE FROM bp_rules WHERE project_id=? AND team_id=? AND rule=?').run(projectId, teamId, rule);
    else if (!cur) this.db.prepare('INSERT INTO bp_rules(project_id,team_id,rule,state,on_since,set_by,set_at) VALUES (?,?,?,?,?,?,?)').run(projectId, teamId, rule, state, now, by, now);
    else this.db.prepare('UPDATE bp_rules SET state=?, set_by=?, set_at=? WHERE project_id=? AND team_id=? AND rule=?').run(state, by, now, projectId, teamId, rule);
    return { was, state };
  }
  /**
   * The changes rules applied in a project, newest first: one row per item per write, with what it did (created, or its
   * text written), who wrote it and when. `team` and `since` narrow it; at most `limit` rows. It reads the newest 500
   * events and expands each into one row per item, so a `limit` beyond what those events hold returns fewer rows.
   */
  appliedByRules(projectId: string, f: { team?: string; since?: number; limit?: number } = {}): { at: number; version: number | null; team_id: string | null; rule: BpRule; label: string; agent_id: string | null; agent: string; key: string; kind: string | null; title: string | null; status: string | null; created: boolean }[] {
    if (!this.project(projectId)) throw err('not_found', 'No such project.');
    const ev = this.db.prepare(`SELECT team_id, version, actor_id, added, created_at, rule FROM bp_events WHERE project_id=? AND rule IS NOT NULL${f.team ? ' AND team_id=?' : ''}${f.since ? ' AND created_at>?' : ''} ORDER BY created_at DESC, id DESC LIMIT 500`)
      .all(projectId, ...(f.team ? [f.team] : []), ...(f.since ? [f.since] : [])) as { team_id: string | null; version: number | null; actor_id: string | null; added: string; created_at: number; rule: string }[];
    const out = [];
    for (const e of ev) {
      const r = JSON.parse(e.rule) as { rule: BpRule; keys: string[] }, added = JSON.parse(e.added) as string[];
      for (const key of r.keys) {
        const it = this.liveRow(projectId, key);
        out.push({ at: e.created_at, version: e.version, team_id: e.team_id, rule: r.rule, label: BP_RULES[r.rule]?.label ?? r.rule, agent_id: e.actor_id, agent: this.label(e.actor_id ?? ''), key, kind: it?.kind ?? null, title: it?.title ?? null, status: it?.status ?? null, created: added.includes(key) });
      }
    }
    return out.slice(0, Math.max(1, Math.min(500, f.limit ?? 200)));
  }

  /**
   * Superseding on accept (§4): a decision this write accepted (moved or created as accepted) moves each decision it
   * supersedes that is still proposed or accepted to superseded, in the same write, with superseded_by set. Its links
   * may be written in the same write. Only the operator accepts a decision, so this is the operator's one act.
   */
  private supersedeOnAccept(p: ProjectRow, actor: BpActor, o: WriteOpts, now: number, res: WriteResult, touched: Set<string>): void {
    const accepted = [...res.moves.filter((m) => m.status === 'accepted').map((m) => m.key), ...res.added]
      .filter((k, i, a) => a.indexOf(k) === i && (() => { const r = this.liveRow(p.id, k); return r?.kind === 'decision' && r.status === 'accepted'; })());
    for (const key of accepted) {
      const olds = this.db.prepare("SELECT i.key FROM bp_links l JOIN bp_items i ON i.project_id=l.project_id AND i.key=l.to_key WHERE l.project_id=? AND l.from_key=? AND l.rel='supersedes' AND i.kind='decision' AND i.deleted_at IS NULL AND i.status IN ('proposed','accepted') ORDER BY i.key")
        .all(p.id, key) as { key: string }[];
      for (const old of olds) {
        this.upsert(p, { op: 'upsert', kind: 'decision', key: old.key, status: 'superseded', fields: { superseded_by: key } }, actor,
          { ...o, author: undefined, decided: undefined, ruled: undefined, notes: { [old.key]: `superseded by ${key} (accepted)` } }, now, res, touched);
      }
    }
  }

  /** Lockdown and pause refuse writes and proposals; reads stay open (§4). Admins are never affected. */
  private lockdownGuard(agentId: string, teamId: string | null): void {
    const L = this.deps.lockdown;
    if (L?.writes()) throw err('lockdown', 'All agent writes are disabled by the administrator (lockdown).');
    if (L?.agent(agentId)) throw err('lockdown', 'This agent is locked down by the administrator.');
    if (teamId && L?.team(teamId)) throw err('lockdown', 'This team is locked down by the administrator.');
  }
  private guard(p: ProjectRow, team: { id: string; status: string; paused_reason: string | null }, agentId: string): void {
    this.lockdownGuard(agentId, team.id);
    if (team.status === 'paused') throw err('paused', `The team is paused${team.paused_reason ? ` (${team.paused_reason})` : ''}. The blueprint stays readable; writes and proposals wait until it resumes.`);
    if (team.status !== 'running') throw err('invalid_state', team.status === 'draft' ? 'The team has not been started yet.' : `The team is ${team.status}.`);
    if (p.status === 'paused') throw err('paused', `Project ${p.key} is paused. The blueprint stays readable; writes and proposals wait until it resumes.`);
    if (p.status !== 'active') throw err('invalid_state', `Project ${p.key} is ${p.status}.`);
  }

  private liveRow(projectId: string, key: unknown): ItemRow | undefined {
    if (typeof key !== 'string') return undefined;
    const r = this.row(projectId, key);
    return r && !r.deleted_at ? r : undefined;
  }

  /** Run the ops and roll them back: a proposal is valid when it is filed, or the error says why. */
  private dryRun(projectId: string, ops: Op[], actor: BpActor, version: number, force = false): void {
    this.trial(projectId, ops, actor, { force }, version);
  }
  /** Run the ops and roll them back, answering what the write would have done (check mode, §4; a restore's check, §4.2). */
  private trial(projectId: string, ops: Op[], actor: BpActor, o: WriteOpts, version?: number): WriteResult {
    const done = Symbol('trial'), box: { r?: WriteResult } = {};
    try { atomic(this.db, () => { box.r = this.apply(projectId, ops, actor, { ...o, trial: true }, version); throw done; }); }
    catch (e) { if (e !== done) throw e; }
    return box.r!;
  }

  /**
   * The rights of an agent's batch (§4): each op's verdict, the batch's, and the open re-plan that widened them. An open
   * re-plan of the part widens the coordinator's rights to its marked items; the import's has no coordinator step.
   */
  private rightsOf(p: ProjectRow, teamId: string, role: BpRole, ops: Op[], agentId?: string): { rights: ReturnType<typeof opRight>[]; verdict: Verdict; replan: { id: string; kinds: string[] } | null } {
    const rp = this.openReplanFor(p.id, teamId);
    const replan = rp && rp.source === 'operator' ? { id: rp.id, kinds: rp.kinds } : null;
    const decides = role === 'coordinator' && !!(this.db.prepare('SELECT coordinator_decides_blueprint d FROM teams WHERE id=?').get(teamId) as { d: number } | undefined)?.d;
    // An item this write creates is seen by the ops after it, so a requirement and its criteria written together are judged
    // by the requirement's place (§4, parents in the same write). Only literal keys: a `*` key is allocated later.
    const made = new Map<string, ItemRow>();
    const look = (k: string): ItemRow | undefined => made.get(k) ?? this.liveRow(p.id, k);
    // The project's only team owns its project level too (FR-PLAN-12, §3).
    const sole = this.soleTeam(p.id) === teamId;
    // The rules the operator turned on for this team (§4 Rules); only its coordinator uses them.
    const rules = role === 'coordinator' ? this.activeRules(p.id, teamId) : undefined;
    // Contributor mode while the agent is delegated to a collaborator (§4, Contributor column).
    const contributor = agentId ? this.contributorOf(agentId) : null;
    const rights = ops.map((o) => {
      const right = opRight(o, { role, teamId, row: look, replan, decides, sole, rules, contributor });
      if (o.op === 'upsert' && typeof o.key === 'string' && !o.key.endsWith('*') && !look(o.key)) {
        const parent = o.parent_key ? look(o.parent_key) : undefined;
        made.set(o.key, {
          kind: o.kind, key: o.key, parent_key: o.parent_key ?? null, team_id: parent ? parent.team_id : (o.team_id ?? null),
          status: o.status ?? KINDS[o.kind]?.statuses?.[0] ?? null, title: o.title ?? '', body: o.body ?? null, fields: JSON.stringify(o.fields ?? {}), position: o.position ?? 0,
        } as ItemRow);
      }
      return right;
    });
    return { rights, verdict: batchVerdict(rights), replan };
  }
  /**
   * The delegation an agent works under now (docs/checkout.md §9 F1): delegated to a person who is not an admin, from the
   * confirm on their PC until Take back. Items it created after `since` are its own in contributor mode.
   */
  contributorOf(agentId: string): { agentId: string; since: number; delegate: string } | null {
    const r = this.db.prepare(`SELECT COALESCE(c.restoring_at, c.created_at) since, COALESCE(u.display_name, u.username) who FROM checkouts c
      JOIN admin_users u ON u.id=c.delegate_user_id WHERE c.scope='agent' AND c.agent_id=? AND c.released_at IS NULL
      AND c.status IN ('restoring','restored') AND u.role <> 'admin' ORDER BY c.created_at DESC LIMIT 1`).get(agentId) as { since: number; who: string } | undefined;
    return r ? { agentId, since: r.since, delegate: r.who } : null;
  }
  /** The person who steered an agent when it wrote at `at`: a delegate whose delegation covered that moment. */
  private viaAt(agentId: string | null, at: number): string | null { return delegateAt(this.db, agentId, at); }
  /** A proposal with its "via <delegate>" label, when its agent proposed it while delegated. */
  private withVia(p: Proposal): Proposal {
    const via = this.viaAt(p.agent_id, p.created_at);
    const q = p.type === 'ops' && p.status === 'open' && p.ops.length > 1 ? { ...p, needs: this.opNeeds(p.project_id, p.ops) } : p;
    return via ? { ...q, via } : q;
  }
  /**
   * What each op of a proposal needs, by index (docs/blueprint.md §2.6), worked out by the hub and never taken from the
   * agent's text: the op that adds the parent it sits under, the op that adds a key it links to, an earlier op on the
   * same key, and every other op of its `group` (the agent's group only adds to these).
   */
  opNeeds(projectId: string, ops: Op[]): number[][] {
    const adds = new Map<string, number>(); // key → the op that adds it (an upsert of a key that is not live)
    ops.forEach((o, i) => { if (o.op === 'upsert' && !adds.has(o.key) && !this.liveRow(projectId, o.key)) adds.set(o.key, i); });
    const keyOf = (o: Op) => ('key' in o ? o.key : null);
    const out = ops.map((o, i) => {
      const n = new Set<number>();
      const add = (k: string | null | undefined) => { const j = k ? adds.get(k) : undefined; if (j !== undefined && j !== i) n.add(j); };
      if (o.op === 'upsert' || o.op === 'move') add(o.parent_key);
      if (o.op === 'link' || o.op === 'unlink') { add(o.from); add(o.to); }
      const k = keyOf(o);
      if (k) for (let j = 0; j < i; j++) if (keyOf(ops[j]!) === k) n.add(j);
      if (o.group) ops.forEach((x, j) => { if (j !== i && x.group === o.group) n.add(j); });
      return n;
    });
    return out.map((n) => [...n].sort((a, b) => a - b));
  }
  /** The op indices a choice needs in all: the choice and everything it needs, transitively. */
  private closure(needs: number[][], pick: number[]): number[] {
    const seen = new Set<number>(), todo = [...pick];
    while (todo.length) { const i = todo.pop()!; if (seen.has(i)) continue; seen.add(i); todo.push(...(needs[i] ?? [])); }
    return [...seen].sort((a, b) => a - b);
  }
  /** The restore marker is the hub's own (§4.2): an agent's ops never carry one, even if a caller other than the tools passes it. */
  private noRestoreMarker(ops: Op[]): void {
    if (ops.some((o) => (o as { restore?: unknown }).restore !== undefined)) throw err('invalid_argument', 'restore is not an op field. To restore from an export, use bp_write {restore: {text}} instead of ops.');
  }
  /** Why a new proposal of this agent would be refused for the open-proposal limits, or null when there is room. */
  private proposalRoom(p: ProjectRow, agentId: string): string | null {
    const open = (col: 'agent_id' | 'project_id', v: string) => (this.db.prepare(`SELECT COUNT(*) n FROM bp_proposals WHERE ${col}=? AND status='open'`).get(v) as { n: number }).n;
    const mine = open('agent_id', agentId);
    if (mine >= MAX_OPEN_PROPOSALS.agent) return `You already have ${mine} open blueprint proposals. Wait for the operator, or withdraw one.`;
    if (open('project_id', p.id) >= MAX_OPEN_PROPOSALS.project) return `Project ${p.key} already has ${MAX_OPEN_PROPOSALS.project} open proposals waiting for the operator.`;
    return null;
  }

  /**
   * Check mode (§4): the agent's write as a dry run. Nothing is written and nothing is proposed. The answer says whether
   * it would apply, become a proposal or be refused, with each op's verdict, what the run would add, change and remove,
   * and every problem at once. A guard (lockdown, pause, a stopped team or closed project) answers refused with its text.
   */
  check(projectId: string, a: { version: number; ops: Op[]; team_id?: string | null }, agentId: string): CheckResult {
    const p = this.project(projectId);
    if (!p) throw err('not_found', 'No such project.');
    const { team, role } = this.seat(p.id, agentId, a.team_id);
    const keyOf = (o: Op) => ('key' in o ? String(o.key) : `${o.from}→${o.to}`);
    const refused = (e: KeyError, ops: CheckResult['ops'], why: string[] = []): CheckResult => {
      const x = e.extra ?? {};
      return {
        outcome: 'refused', ops, would: null, why, code: e.code,
        problems: Array.isArray(x['problems']) ? x['problems'] as string[] : [e.message],
        ...(e.code === 'conflict' ? { conflict: { keys: Array.isArray(x['keys']) ? x['keys'] as string[] : [], current_version: typeof x['current_version'] === 'number' ? x['current_version'] : null } } : {}),
      };
    };
    try {
      this.guard(p, team, agentId);
      if (!Number.isInteger(a.version)) throw err('invalid_argument', 'Pass the project version you read.');
      this.checkBatch(a.ops);
      this.noRestoreMarker(a.ops);
    } catch (e) { if (e instanceof KeyError) return refused(e, []); throw e; }
    const { rights, verdict } = this.rightsOf(p, team.id, role, a.ops, agentId);
    const ops = rights.map((r, i) => ({ op: i + 1, key: keyOf(a.ops[i]!), verdict: r.verdict, why: r.why }));
    const whys = (v: Verdict) => [...new Set(rights.filter((r) => r.verdict === v).map((r) => r.why))];
    let w: WriteResult;
    try {
      const decided = verdict === 'apply' ? a.ops.flatMap((o, i) => (rights[i]!.decided && 'key' in o ? [o.key] : [])) : [];
      const ruled = verdict === 'apply' ? this.ruledOf(a.ops, rights) : null;
      w = this.trial(p.id, a.ops, { kind: 'agent', id: agentId }, { teamId: team.id, ...(decided.length ? { decided } : {}), ...(ruled ? { ruled } : {}) }, a.version);
    } catch (e) { if (e instanceof KeyError) return refused(e, ops, verdict === 'apply' ? [] : whys(verdict)); throw e; }
    const would = { added: w.added, changed: w.changed, removed: w.removed, keys: w.keys, moves: w.moves };
    if (verdict === 'deny') return { outcome: 'refused', ops, would: null, why: whys('deny'), code: 'denied', problems: [`Not yours to change: ${whys('deny').join('; ')}. ${RIGHTS_RULE}`] };
    if (verdict === 'propose') { const limit = this.proposalRoom(p, agentId); return { outcome: 'propose', ops, would, why: whys('propose'), problems: [], ...(limit ? { limit } : {}) }; }
    return { outcome: 'apply', ops, would, why: [], problems: [] };
  }

  // ───── restore from an export (§4.2) ─────
  /** A restore waits for an open re-plan of the project, or of a part its scope touches, to be applied or cancelled. */
  private restoreGuard(p: ProjectRow, teamId: string | null): void {
    const open = this.db.prepare("SELECT id, team_id FROM bp_replans WHERE project_id=? AND status='open'").all(p.id) as { id: string; team_id: string | null }[];
    const clash = open.find((r) => r.team_id === null || teamId === null || r.team_id === teamId);
    if (clash) throw err('invalid_state', `A re-plan of ${clash.team_id ? 'a part' : 'the whole project'} of ${p.key} is open (${clash.id}); apply or cancel it before restoring.`, { replan_id: clash.id });
  }

  /**
   * The plan of a restore (§4.2): the ops that make the scope match the file, parents first, with the hub-only restore
   * marker and each item's writer. Nothing is written. The writer comes only from the hub's records of the same text,
   * the pre-reset backup the operator names first, then the hub's own database: the file is L2 data and never decides
   * trust, and what it claims is kept as attribution only. With no record, an agent's proposal credits the proposer
   * (the marker names no writer and the proposal's author applies) and the operator's restore an unnamed agent (L2).
   */
  restorePlan(projectId: string, snap: Snapshot, a: RestoreIn, mode: { operator: BpActor } | { agent: string }): RestorePlan {
    const p = this.project(projectId);
    if (!p) throw err('not_found', 'No such project.');
    if (a.team_id && !this.db.prepare('SELECT 1 FROM teams WHERE id=? AND project_id=?').get(a.team_id, p.id)) throw err('invalid_argument', `Team ${a.team_id} is not part of project ${p.key}.`);
    if (a.backup && 'agent' in mode) throw err('denied', 'Only the operator restores with a backup.');
    const backup = a.backup ? this.openBackup(a.backup) : null;
    try { return this.planWith(p, snap, a, mode, backup); } finally { backup?.db.close(); }
  }

  /** A pre-reset backup, read-only: a file name in the backup folder holding a hub database (§4.2). */
  private openBackup(name: string): { db: DatabaseSync; name: string } {
    if (!BACKUP_NAME.test(name)) throw err('invalid_argument', 'backup is the file name of a backup in the hub\'s backup folder, such as agent-hub-2026-11-16.db: letters, digits, ".", "_" and "-", ending in .db.');
    const dir = this.deps.backupDir;
    const file = dir ? join(dir, name) : null;
    if (!file || !existsSync(file)) throw err('not_found', `No backup ${name} in the hub's backup folder.`);
    let db: DatabaseSync;
    try { db = new DatabaseSync(file, { readOnly: true }); } catch { throw err('invalid_argument', `Backup ${name} does not open as a database.`); }
    try {
      const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name));
      if (!['projects', 'bp_items', 'bp_revisions'].every((t) => tables.has(t))) throw err('invalid_argument', `Backup ${name} is not a Conclave hub database with a Blueprint.`);
    } catch (e) { db.close(); if (e instanceof KeyError) throw e; throw err('invalid_argument', `Backup ${name} does not open as a database.`); }
    return { db, name };
  }

  /** The hub's hash of a restore's input: the text, the scope, the backup and the maps (keys sorted). */
  static restoreDigest(a: RestoreIn): string {
    const sorted = (m?: Record<string, string>) => (m ? Object.fromEntries(Object.entries(m).sort(([x], [y]) => x.localeCompare(y))) : null);
    const input = stable({ text: a.text, team_id: a.team_id ?? null, tracks: a.tracks?.length ? [...a.tracks].sort() : null, remove_missing: !!a.remove_missing, backup: a.backup ?? null, authors: sorted(a.authors), team_map: sorted(a.team_map) });
    return `sha256:${createHash('sha256').update(input).digest('hex')}`;
  }

  /** The latest applied restore of this project with this digest. */
  private priorRestore(projectId: string, digest: string, baseVersion?: number): { base_version: number; result: string; created_at: number } | undefined {
    return (baseVersion === undefined
      ? this.db.prepare('SELECT base_version, result, created_at FROM bp_restores WHERE project_id=? AND digest=? ORDER BY created_at DESC, base_version DESC LIMIT 1').get(projectId, digest)
      : this.db.prepare('SELECT base_version, result, created_at FROM bp_restores WHERE project_id=? AND digest=? AND base_version=?').get(projectId, digest, baseVersion)) as { base_version: number; result: string; created_at: number } | undefined;
  }

  private planWith(p: ProjectRow, snap: Snapshot, a: RestoreIn, mode: { operator: BpActor } | { agent: string }, backup: { db: DatabaseSync; name: string } | null): RestorePlan {
    const rows = new Map((this.db.prepare('SELECT * FROM bp_items WHERE project_id=?').all(p.id) as unknown as ItemRow[]).map((r) => [r.key, r]));
    const teams = new Set((this.db.prepare('SELECT id FROM teams WHERE project_id=?').all(p.id) as { id: string }[]).map((r) => r.id));
    const file = new Map(snap.items.map((i) => [i.key, i]));
    const lost = new Set(snap.lost);
    if (snap.project.key && snap.project.key !== p.key) lost.add(`The file is the export of project ${snap.project.key}; its items go into ${p.key} with the same keys.`);
    const rootOf = (k: string, parentOf: (k: string) => string | null | undefined): string => { let x = k; for (let n = 0, pk = parentOf(x); pk && n < 10; n++, pk = parentOf(x)) x = pk; return x; };
    const fileRoot = (k: string) => rootOf(k, (x) => file.get(x)?.parent_key);
    const hubRoot = (k: string) => rootOf(k, (x) => rows.get(x)?.parent_key);
    // The team an item ends up in: a child takes its parent's; a top-level item the file's (JSON), else the hub's.
    for (const [from, to] of Object.entries(a.team_map ?? {})) if (!teams.has(to)) throw err('invalid_argument', `team_map: team ${to} (for ${from}) is not part of project ${p.key}.`);
    const teamMap = new Map<string, { to: string | null; how: 'same' | 'mapped' | 'not_in_project' }>();
    const teamOf = (i: SnapItem, n = 0): string | null => {
      if (i.parent_key) { const par = file.get(i.parent_key); return par && n < 10 ? teamOf(par, n + 1) : (rows.get(i.parent_key)?.team_id ?? null); }
      const hub = rows.get(i.key)?.team_id ?? null;
      if (i.team_id === undefined || i.team_id === null) return i.team_id === null ? null : hub;
      const mapped = a.team_map?.[i.team_id];
      if (mapped) { teamMap.set(i.team_id, { to: mapped, how: 'mapped' }); return mapped; }
      if (teams.has(i.team_id)) { teamMap.set(i.team_id, { to: i.team_id, how: 'same' }); return i.team_id; }
      if (!teamMap.has(i.team_id)) teamMap.set(i.team_id, { to: hub, how: 'not_in_project' });
      lost.add(`Team ${i.team_id} of ${i.key} is not in ${p.key} and not in team_map: the item keeps the team the hub knows, or goes to project level.`);
      return hub;
    };
    const tracks = a.tracks?.length ? new Set(a.tracks) : null;
    if (tracks) for (const t of tracks) if (!file.get(t) || file.get(t)!.parent_key) throw err('invalid_argument', `${t} is not a top-level item of the export.`);
    const inScope = (i: SnapItem) => i.kind !== 'report' && (!tracks || tracks.has(fileRoot(i.key))) && (!a.team_id || teamOf(i) === a.team_id);
    const hubInScope = (r: ItemRow) => !r.deleted_at && r.kind !== 'report' && (!tracks || tracks.has(hubRoot(r.key))) && (!a.team_id || r.team_id === a.team_id);
    const depthIn = (k: string, parentOf: (k: string) => string | null | undefined) => { let d = 0; for (let pk = parentOf(k); pk && d < 10; pk = parentOf(pk)) d++; return d; };
    const scoped = snap.items.filter(inScope)
      .map((i, n) => ({ i, n, d: depthIn(i.key, (x) => (file.has(x) ? file.get(x)!.parent_key : null)) }))
      .sort((x, y) => x.d - y.d || x.n - y.n).map((x) => x.i);
    const scopedKeys = new Set(scoped.map((i) => i.key));

    const one = (s: string) => s.replace(/\s+/g, ' ').trim();
    const empty = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length);
    // Who wrote exactly this text, in a database (the hub's own, or the backup): the actor of the revision that introduced
    // it, the creation or a revision whose previous one held other text. A revision snapshots the whole row for any change,
    // so a later status move, position change, retag or removal repeats the text under its own actor and proves nothing.
    // If the text came back more than once, the latest introduction wrote it. A revision whose earlier history was
    // collapsed cannot show who wrote its text: unverified.
    const recordIn = (db: DatabaseSync, itemId: string, t: { title: string; body: string | null; fields: Record<string, unknown> }): BpActor | undefined => {
      const want = stable({ t: t.title, b: t.body, f: t.fields });
      let prev: string | null = null, intro: BpActor | null | undefined;
      for (const v of db.prepare('SELECT snapshot, actor_kind, actor_id, change_note FROM bp_revisions WHERE item_id=? ORDER BY rev').all(itemId) as { snapshot: string; actor_kind: string; actor_id: string | null; change_note: string | null }[]) {
        const s = parse<Record<string, unknown>>(v.snapshot, {});
        const text = stable({ t: s['title'], b: s['body'] ?? null, f: s['fields'] ?? {} });
        if (text === want && prev !== want) intro = v.change_note === 'earlier changes collapsed' ? null : { kind: v.actor_kind as BpActorKind, id: v.actor_id };
        prev = text;
      }
      return intro ?? undefined;
    };
    // The backup's project: the file's project key, else the destination's.
    const bProject = backup ? ([snap.project.key, p.key].filter((k): k is string => !!k).map((k) => backup.db.prepare('SELECT id FROM projects WHERE key=?').get(k) as { id: string } | undefined).find(Boolean)?.id ?? null) : null;
    if (backup && !bProject) lost.add(`Backup ${backup.name} holds no project ${snap.project.key ?? p.key}: no writer could be verified from it.`);
    for (const [from, to] of Object.entries(a.authors ?? {})) if (!this.db.prepare('SELECT 1 FROM agents WHERE id=?').get(to)) throw err('invalid_argument', `authors: agent ${to} (for ${from}) is not known to this hub.`);
    const auth = { backup: backup?.name ?? null, verified: 0, from_backup: 0, from_hub: 0, l2: 0, unverified: [] as string[] };
    const unnamed: BpActor = { kind: 'agent', id: null };
    /** The writer and the claimed attribution of a text the restore writes; verified writers are remapped explicitly. */
    const writer = (i: SnapItem, row: ItemRow | undefined, t: { title: string; body: string | null; fields: Record<string, unknown> }): { by?: BpActor; claimed: BpActor | null } => {
      const fromFile = i.created_by ?? i.updated_by ?? null;
      const bRow = backup && bProject ? backup.db.prepare('SELECT id FROM bp_items WHERE project_id=? AND key=?').get(bProject, i.key) as { id: string } | undefined : undefined;
      const inBackup = bRow ? recordIn(backup!.db, bRow.id, t) : undefined;
      const inHub = !inBackup && row ? recordIn(this.db, row.id, t) : undefined;
      let found = inBackup ?? inHub;
      // Text an unnamed agent wrote (an earlier restore's L2 text) is verified as L2 only: it counts as unverified.
      if (found?.kind === 'agent' && !found.id) found = undefined;
      // A backup agent is credited to the agent `authors` names, or to itself if this hub still knows it; otherwise unverified.
      if (found?.kind === 'agent' && inBackup) {
        const to = found.id ? a.authors?.[found.id] : undefined;
        if (to) found = { kind: 'agent', id: to };
        else if (!found.id || !this.db.prepare('SELECT 1 FROM agents WHERE id=?').get(found.id)) { lost.add('A writer the backup names is an agent this hub does not know and authors does not map: its text reads as L2, the agent kept as attribution.'); auth.l2++; auth.unverified.push(i.key); return { ...('agent' in mode ? {} : { by: unnamed }), claimed: found }; }
      }
      if (found) { auth.verified++; if (inBackup) auth.from_backup++; else auth.from_hub++; return { by: found, claimed: null }; }
      auth.l2++; auth.unverified.push(i.key);
      return { ...('agent' in mode ? {} : { by: unnamed }), claimed: fromFile };
    };

    const digest = Blueprint.restoreDigest(a);
    const prior = this.priorRestore(p.id, digest);
    const plan: RestorePlan = { format: snap.format, from_project: snap.project.key, ops: [], added: [], restored: [], changed: [], unchanged: 0, removed: [], links: { added: 0, removed: 0 }, skipped_links: [], left_out: snap.items.length - scoped.length, lost: [],
      destination: { project: p.key, version: p.version }, base_version: p.version, digest, teams: [], authors: auth, collisions: [], unknown_refs: [],
      prior: prior ? { base_version: prior.base_version, version: parse<{ result?: { version?: number } | null }>(prior.result, {}).result?.version ?? null, at: prior.created_at } : null };
    const upserts: Op[] = [];
    for (const i of scoped) {
      const row = rows.get(i.key), cur = row && !row.deleted_at ? row : undefined;
      if (row && row.kind !== i.kind) plan.collisions.push(`${i.key}: the hub holds it as ${row.kind}, the file as ${i.kind}`);
      if (i.parent_key && !file.has(i.parent_key) && !(rows.get(i.parent_key) && !rows.get(i.parent_key)!.deleted_at)) plan.unknown_refs.push(`${i.key} under ${i.parent_key}`);
      const hubFields = row ? parse<Record<string, unknown>>(row.fields, {}) : {};
      // What Markdown flattened (one-lined titles and text fields, day-only dates, lists) keeps the hub's value when it reads the same.
      let title = i.no_title ? (row?.title ?? 'Architecture') : i.title;
      let body = i.body;
      let fields = i.fields;
      if (snap.format === 'markdown') {
        if (row && one(row.title) === title) title = row.title;
        if (row?.body && body !== null && row.body.replace(/\s+$/, '') === body.replace(/\s+$/, '')) body = row.body;
        if (i.partial_fields) {
          const spec = KINDS[i.kind]!;
          fields = Object.fromEntries(Object.entries(hubFields).filter(([k, v]) => k === 'auto' || empty(v)));
          for (const [k, v] of Object.entries(i.fields)) {
            const h = hubFields[k], t = spec.fields[k];
            const same = (t === 'num' && /_at$/.test(k) && typeof h === 'number' && Math.floor(h / 86_400_000) * 86_400_000 === v)
              || (t === 'str' && typeof h === 'string' && one(h) === v)
              || (t === 'strs' && Array.isArray(h) && Array.isArray(v) && one(String(h)) === one((v as string[]).join(',')))
              || ((t === 'objs' || t === 'obj') && stable(h) === stable(v));
            fields[k] = same ? h : v;
          }
        }
      }
      const team = teamOf(i);
      const position = i.position ?? row?.position;
      if (cur && cur.parent_key === i.parent_key && cur.title === title && (cur.body ?? null) === body && stable(hubFields) === stable(fields) && cur.status === i.status && cur.team_id === team && (position === undefined || cur.position === position)) { plan.unchanged++; continue; }
      const w = writer(i, row, { title, body, fields });
      upserts.push({ op: 'upsert', kind: i.kind, key: i.key, parent_key: i.parent_key, title, body, fields, status: i.status, ...(i.parent_key ? {} : { team_id: team }), ...(position === undefined ? {} : { position }), restore: { ...(w.by ? { by: w.by } : {}), claimed: w.claimed } });
      (!row ? plan.added : row.deleted_at ? plan.restored : plan.changed).push(i.key);
    }

    // Removals (remove_missing): items in scope the file does not hold, deepest first; links between items in scope it does not hold.
    const gone = a.remove_missing ? [...rows.values()].filter((r) => hubInScope(r) && !file.has(r.key)) : [];
    const goneKeys = new Set(gone.map((r) => r.key));
    gone.sort((x, y) => depthIn(y.key, (k) => rows.get(k)?.parent_key) - depthIn(x.key, (k) => rows.get(k)?.parent_key) || x.key.localeCompare(y.key));
    const after = new Set([...[...rows.values()].filter((r) => !r.deleted_at && !goneKeys.has(r.key)).map((r) => r.key), ...scopedKeys]);
    const lk = (f: string, t: string, rel: string) => `${f}|${t}|${rel}`;
    const hubLinks = this.links(p.id), has = new Set(hubLinks.map((l) => lk(l.from_key, l.to_key, l.rel))), want = new Set(snap.links.map((l) => lk(l.from, l.to, l.rel)));
    const linkOps: Op[] = [], unlinkOps: Op[] = [];
    for (const l of snap.links) {
      if (!scopedKeys.has(l.from) && !scopedKeys.has(l.to)) continue;
      if (!after.has(l.from) || !after.has(l.to)) { plan.skipped_links.push(`${l.from} ${l.rel} ${l.to}`); continue; }
      if (!has.has(lk(l.from, l.to, l.rel))) linkOps.push({ op: 'link', from: l.from, to: l.to, rel: l.rel });
    }
    if (a.remove_missing) {
      const inScopeKey = (k: string) => scopedKeys.has(k) || (!!rows.get(k) && hubInScope(rows.get(k)!));
      for (const l of hubLinks) {
        if (inScopeKey(l.from_key) && inScopeKey(l.to_key) && !want.has(lk(l.from_key, l.to_key, l.rel)) && !goneKeys.has(l.from_key) && !goneKeys.has(l.to_key)) unlinkOps.push({ op: 'unlink', from: l.from_key, to: l.to_key, rel: l.rel });
      }
    }
    plan.ops = [...unlinkOps, ...upserts, ...linkOps, ...gone.map((r): Op => ({ op: 'remove', key: r.key }))];
    plan.removed = gone.map((r) => r.key);
    plan.links = { added: linkOps.length, removed: unlinkOps.length };
    plan.skipped_links = plan.skipped_links.slice(0, 200);
    plan.lost = [...lost].slice(0, 50);
    plan.teams = [...teamMap].map(([from, t]) => ({ from, ...t }));
    plan.collisions = plan.collisions.slice(0, 200);
    plan.unknown_refs = plan.unknown_refs.slice(0, 200);
    auth.unverified = auth.unverified.slice(0, 200);
    return plan;
  }
  /** The write options of a restore: one event, not held to ops_per_write, and no retagging revisions for items it writes. */
  private restoreOpts(ops: Op[], note: string | null, teamId: string | null): WriteOpts {
    return { force: true, note, teamId, restoring: new Set(ops.flatMap((o) => (o.op === 'upsert' ? [o.key] : []))) };
  }
  private static problemsOf(e: KeyError): string[] { const x = e.extra?.['problems']; return Array.isArray(x) ? x as string[] : [e.message]; }

  /**
   * The operator restores the project, or a part, from an export in one write (§4.2): one event, one revision per item
   * it adds, brings back or changes. With `check`, the plan and a dry run's outcome, and nothing is written.
   */
  restore(projectId: string, a: RestoreIn & { check?: boolean; note?: string | null; version?: number }, actor: BpActor): RestoreResult {
    const p = this.project(projectId);
    if (!p) throw err('not_found', 'No such project.');
    const snap = parseExport(a.text);
    return atomic(this.db, () => {
      if (!a.check) {
        if (!Number.isInteger(a.version)) throw err('invalid_argument', 'Pass version: the base_version the check returned, so the restore applies to the Blueprint you reviewed.');
        // The same restore against the same base version again (a lost response, a double click): its first result, nothing written.
        const done = this.priorRestore(p.id, Blueprint.restoreDigest(a), a.version);
        if (done) return { ...parse<RestoreResult>(done.result, { status: 'applied', plan: null as unknown as RestorePlan, result: null }), retried: true } as RestoreResult;
        const now = this.project(p.id)!.version;
        if (now !== a.version) throw err('conflict', `The Blueprint moved since the check (version ${a.version}, now ${now}); check the restore again.`, { current_version: now });
      }
      this.restoreGuard(p, a.team_id ?? null);
      const plan = this.restorePlan(p.id, snap, a, { operator: actor });
      const o = this.restoreOpts(plan.ops, a.note?.trim() || RESTORE_NOTE, a.team_id ?? null);
      if (a.check) {
        if (!plan.ops.length) return { status: 'checked', plan, outcome: 'apply', would: null, problems: [] };
        try {
          const w = this.trial(p.id, plan.ops, actor, o);
          return { status: 'checked', plan, outcome: 'apply', would: { added: w.added, changed: w.changed, removed: w.removed, keys: w.keys, moves: w.moves }, problems: [] };
        } catch (e) { if (e instanceof KeyError && OPERATOR_ERRORS.has(e.code)) return { status: 'checked', plan, outcome: 'refused', would: null, problems: Blueprint.problemsOf(e) }; throw e; }
      }
      const out: RestoreResult = { status: 'applied', plan, result: plan.ops.length ? this.apply(p.id, plan.ops, actor, o) : null };
      // The record a retry finds: the plan without its ops (they can be thousands) and the result.
      const { ops: _ops, ...kept } = plan;
      this.db.prepare('INSERT INTO bp_restores(id,project_id,digest,base_version,actor_kind,actor_id,result,created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(`bpr_${randomToken(10)}`, p.id, plan.digest, plan.base_version, actor.kind, actor.id, JSON.stringify({ ...out, plan: { ...kept, ops: [] } }), Date.now());
      return out;
    });
  }

  /**
   * An agent proposes a restore (§4.2, bp_write {restore}): always one proposal, whatever its rights, routed to the
   * admin. With `check`, the plan and a dry run's outcome only. The plan is made from the hub's records when it is
   * filed, and replayed like any proposal: it turns stale if an item it writes changed meanwhile.
   */
  submitRestore(projectId: string, a: RestoreIn & { version: number; reason?: string | null; check?: boolean; seat_team?: string | null }, agentId: string): RestoreResult {
    const p = this.project(projectId);
    if (!p) throw err('not_found', 'No such project.');
    const { team } = this.seat(p.id, agentId, a.seat_team);
    this.guard(p, team, agentId);
    if (!Number.isInteger(a.version)) throw err('invalid_argument', 'Pass the project version you read.');
    this.restoreGuard(p, a.team_id ?? null);
    const snap = parseExport(a.text);
    const plan = this.restorePlan(p.id, snap, a, { agent: agentId });
    const actor: BpActor = { kind: 'agent', id: agentId };
    if (a.check) {
      const limit = this.proposalRoom(p, agentId);
      if (!plan.ops.length) return { status: 'checked', plan, outcome: 'refused', would: null, problems: ['Nothing to restore: the Blueprint already matches the export in this scope.'] };
      try {
        const w = this.trial(p.id, plan.ops, actor, this.restoreOpts(plan.ops, null, team.id), a.version);
        return { status: 'checked', plan, outcome: 'propose', would: { added: w.added, changed: w.changed, removed: w.removed, keys: w.keys, moves: w.moves }, problems: [], ...(limit ? { limit } : {}) };
      } catch (e) { if (e instanceof KeyError && OPERATOR_ERRORS.has(e.code)) return { status: 'checked', plan, outcome: 'refused', would: null, problems: Blueprint.problemsOf(e) }; throw e; }
    }
    if (!plan.ops.length) throw err('invalid_state', 'Nothing to restore: the Blueprint already matches the export in this scope.');
    const reason = a.reason?.trim().slice(0, 2000) || null;
    return { status: 'proposed', plan, proposal: this.propose(p, team, agentId, plan.ops, a.version, reason, true) };
  }

  private propose(p: ProjectRow, team: { id: string; name: string }, agentId: string, ops: Op[], version: number, reason: string | null, force = false, requestId?: number): Proposal {
    const id = `bpp_${randomToken(10)}`;
    atomic(this.db, () => {
      const full = this.proposalRoom(p, agentId);
      if (full) throw err('rate_limited', full);
      this.dryRun(p.id, ops, { kind: 'agent', id: agentId }, version, force);
      // The revision of every item the proposal writes, so applying it later can tell whether it moved underneath.
      const revs: Record<string, number | null> = {};
      for (const o of ops) {
        const k = o.op === 'upsert' || o.op === 'remove' || o.op === 'move' ? o.key : null;
        if (typeof k === 'string' && !k.endsWith('*')) revs[k] = this.liveRow(p.id, k)?.rev ?? null;
      }
      this.db.prepare("INSERT INTO bp_proposals(id,project_id,team_id,agent_id,ops,base_version,reason,status,created_at,revs,request_id) VALUES (?,?,?,?,?,?,?,'open',?,?,?)")
        .run(id, p.id, team.id, agentId, JSON.stringify(ops), version, reason, Date.now(), JSON.stringify(revs), requestId ?? null);
      if (requestId !== undefined) this.db.prepare('UPDATE bp_report_requests SET proposal_id=? WHERE id=?').run(id, requestId);
    });
    const pr = this.proposal(id)!, who = this.label(agentId), keys = this.opKeys(ops);
    // Hub-written text only: the agent's reason is L2 and is read with the proposal, never carried in a notice.
    this.notify(this.coordinators(team.id).filter((c) => c !== agentId), 'bp_proposal',
      `${who} proposed a blueprint change in ${p.key} (${id}, ${ops.length} op${ops.length === 1 ? '' : 's'}: ${l2(keys, 300)}). The operator applies or rejects it.`);
    this.deps.audit?.alert('info', 'bp_proposal', id, { project: p.key, team: team.name, agent: who, ops: ops.length, keys });
    this.deps.audit?.event({ kind: 'agent', id: agentId }, 'blueprint.propose', { kind: 'bp_proposal', id }, { project: p.key, ops: ops.length });
    return pr;
  }

  proposal(id: string): Proposal | undefined {
    const r = this.db.prepare('SELECT * FROM bp_proposals WHERE id=?').get(id) as any;
    return r ? this.withVia(toProposal(r)) : undefined;
  }
  /** A project's proposals, oldest first. */
  proposals(projectId: string, f: { status?: ProposalStatus; agent?: string } = {}): Proposal[] {
    return (this.db.prepare(`SELECT * FROM bp_proposals WHERE project_id=? ${f.status ? 'AND status=?' : ''} ${f.agent ? 'AND agent_id=?' : ''} ORDER BY created_at, id`)
      .all(...[projectId, f.status, f.agent].filter((x): x is string => !!x)) as any[]).map((r) => this.withVia(toProposal(r)));
  }
  /** One page of a project's proposals, newest first, with the total. */
  proposalsPage(projectId: string, f: { status?: ProposalStatus; limit: number; offset: number }): { proposals: Proposal[]; total: number } {
    const where = `project_id=? ${f.status ? 'AND status=?' : ''}`, args = f.status ? [projectId, f.status] : [projectId];
    const total = (this.db.prepare(`SELECT COUNT(*) n FROM bp_proposals WHERE ${where}`).get(...args) as { n: number }).n;
    const rows = this.db.prepare(`SELECT * FROM bp_proposals WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(...args, f.limit, f.offset) as any[];
    return { proposals: rows.map((r) => this.withVia(toProposal(r))), total };
  }
  /** Open proposals, oldest first: of the projects named, or of every project. */
  openProposals(projectIds?: string[]): Proposal[] {
    if (projectIds && !projectIds.length) return [];
    return (this.db.prepare(`SELECT * FROM bp_proposals WHERE status='open' ${projectIds ? 'AND project_id IN (SELECT value FROM json_each(?))' : ''} ORDER BY created_at, id`)
      .all(...(projectIds ? [JSON.stringify(projectIds)] : [])) as any[]).map((r) => this.withVia(toProposal(r)));
  }
  /** Kind, team and parent of the live items named, in one query: what decider routing needs to place a batch of ops. */
  places(projectId: string, keys: Iterable<string>): Map<string, { kind: string; team_id: string | null; parent_key: string | null; status: string | null; replan_id: string | null }> {
    const rows = this.db.prepare("SELECT key, kind, team_id, parent_key, status, replan_id FROM bp_items WHERE project_id=? AND deleted_at IS NULL AND key IN (SELECT value FROM json_each(?))")
      .all(projectId, JSON.stringify([...keys])) as { key: string; kind: string; team_id: string | null; parent_key: string | null; status: string | null; replan_id: string | null }[];
    return new Map(rows.map(({ key, ...r }) => [key, r]));
  }
  private mustOpen(id: string): Proposal {
    const pr = this.proposal(id);
    if (!pr) throw err('not_found', 'No such proposal.');
    if (pr.status !== 'open') throw err('invalid_state', `The proposal is already ${pr.status}.`);
    return pr;
  }

  /**
   * The operator applies a proposal: its ops replay against the current version. If an item it writes changed since it
   * was filed, or an op no longer fits, nothing is written and the proposal turns stale; the agent is told to re-propose.
   */
  applyProposal(id: string, actor: BpActor, note?: string | null, pick?: number[]): { proposal: Proposal; result: WriteResult | null; stale: string | null } {
    return atomic(this.db, () => this.applyOpen(this.mustOpen(id), actor, note, pick));
  }
  private applyOpen(pr0: Proposal, actor: BpActor, note?: string | null, pick?: number[]): { proposal: Proposal; result: WriteResult | null; stale: string | null } {
    if (pr0.type === 'replan') {
      if (pick) throw err('invalid_argument', 'A re-plan is applied as a whole; choose items in its review instead.');
      return this.applyReplan(pr0, actor, note);
    }
    // Partial apply (§2.6): the chosen ops must carry what they need; the rest are recorded as declined.
    let pr = pr0, declined: Proposal['declined'] = null;
    if (pick) {
      const all = pr0.ops, idx = [...new Set(pick)].sort((a, b) => a - b);
      if (!idx.length || idx.some((i) => !Number.isInteger(i) || i < 0 || i >= all.length)) throw err('invalid_argument', `Choose op numbers between 1 and ${all.length}.`);
      const needs = this.opNeeds(pr0.project_id, all), full = this.closure(needs, idx);
      const miss = full.filter((i) => !idx.includes(i));
      if (miss.length) throw err('invalid_argument', `The ops you chose need op ${miss.map((i) => i + 1).join(', ')} too.`, { needs: miss.map((i) => i + 1) });
      if (idx.length < all.length) {
        const keyOf = (o: Op) => ('key' in o ? o.key : null);
        declined = all.flatMap((o, i) => (idx.includes(i) ? [] : [{ index: i + 1, key: keyOf(o) }]));
        const keys = new Set(idx.map((i) => keyOf(all[i]!)).filter((k): k is string => !!k));
        pr = { ...pr0, ops: idx.map((i) => all[i]!), revs: Object.fromEntries(Object.entries(pr0.revs).filter(([k]) => keys.has(k))) };
      }
    }
    const id = pr.id, total = pr0.ops.length;
    const moved = Object.entries(pr.revs).filter(([k, rev]) => (this.liveRow(pr.project_id, k)?.rev ?? null) !== rev).map(([k]) => k);
    let stale: string | null = moved.length ? `${moved.join(', ')} changed since it was proposed` : null, result: WriteResult | null = null;
    if (!stale) {
      // The operator decides, but the text is the proposer's: items keep the agent as their writer, so their trust stays L1 or L2 (F-23).
      // A restore's proposal (§4.2) is applied as one restore write: not held to ops_per_write, one revision per item.
      const restore = pr.ops.some((o) => o.op === 'upsert' && !!o.restore);
      try { result = this.apply(pr.project_id, pr.ops, actor, { note: declined ? `${pr.ops.length} of ${total} applied${pr.reason ? ': ' + pr.reason : ''}` : pr.reason ?? (restore ? RESTORE_NOTE : null), teamId: pr.team_id, proposalId: pr.id, ...(pr.agent_id ? { author: { kind: 'agent', id: pr.agent_id } } : {}), ...(restore ? { force: true, restoring: this.restoreOpts(pr.ops, null, null).restoring! } : {}) }); }
      catch (e) { if (e instanceof KeyError && OPERATOR_ERRORS.has(e.code)) stale = e.message; else throw e; }
    }
    this.decide(pr0, stale ? 'stale' : 'applied', actor, stale ?? (note?.trim() || null), stale ? undefined : { declined, applied: pr.ops.length });
    // A question the proposal answered offers its decision to the proposer, who would have had it in a direct write (§4).
    // The notice is hub words and keys only (no agent text in notices): the op is built from the question, which bp_read gives.
    const answered = (result?.offers ?? []).map((x) => String(x.op.fields?.['source'] ?? '').slice(3)).filter(Boolean);
    if (answered.length && pr.agent_id) {
      const p = this.project(pr.project_id)!;
      this.notify([pr.agent_id], 'bp_proposal', `Your proposal ${pr.id} in ${p.key} answered ${answered.join(', ')}. If an answer decides something, record it as a proposed decision with bp_write: an upsert of kind decision, key ADR-*, status proposed, fields.source bp:<question key>, and the question and its answer as fields.context (bp_read {keys: [${answered.join(', ')}]} has them). Nothing was created by itself.`);
    }
    // The coordinator's own plan change, applied by the operator, answers the team's open plan review requests too (§6).
    if (result && pr.team_id && pr.agent_id && this.coordinators(pr.team_id).includes(pr.agent_id) && (result.added.length || result.changed.length || result.removed.length)) answerRequests(this.db, pr.team_id, 'plan', 'bp_write');
    if (result && pr.request_id !== null) this.db.prepare("UPDATE bp_report_requests SET answered_at=?, answered_by='refine' WHERE id=? AND answered_at IS NULL").run(Date.now(), pr.request_id);
    return { proposal: this.proposal(id)!, result, stale };
  }
  rejectProposal(id: string, actor: BpActor, note?: string | null): Proposal {
    atomic(this.db, () => this.decide(this.mustOpen(id), 'rejected', actor, note?.trim().slice(0, 2000) || null));
    return this.proposal(id)!;
  }
  /** The proposing agent takes an open proposal back. A withdrawal is a write: lockdown refuses it, a pause does not (§4). */
  withdrawProposal(id: string, agentId: string): Proposal {
    const pr = this.proposal(id);
    if (!pr || pr.agent_id !== agentId) throw err('denied', NOT_ALLOWED);
    this.lockdownGuard(agentId, pr.team_id);
    this.mustOpen(id);
    const r = this.db.prepare("UPDATE bp_proposals SET status='withdrawn', decided_by=?, decided_at=? WHERE id=? AND status='open'").run(agentId, Date.now(), id);
    if (!r.changes) throw err('invalid_state', 'The proposal was decided meanwhile.');
    // A refine request stays open when its proposal is withdrawn: the link is cleared so the coordinator can file again.
    if (pr.request_id !== null) this.db.prepare('UPDATE bp_report_requests SET proposal_id=NULL WHERE id=? AND proposal_id=?').run(pr.request_id, pr.id);
    this.deps.audit?.settle('bp_proposal', id);
    if (pr.team_id && pr.type === 'ops') this.onProposalClosed?.(pr.team_id, id, 'withdrawn');
    return this.proposal(id)!;
  }

  private decide(pr: Proposal, status: 'applied' | 'rejected' | 'stale', actor: BpActor, note: string | null, part?: { declined: Proposal['declined']; applied: number }): void {
    // Only an open proposal is decided: a second decision (or a withdrawal in between) is refused, and the caller's transaction rolls back.
    const r = this.db.prepare("UPDATE bp_proposals SET status=?, decided_by=?, decided_at=?, note=? WHERE id=? AND status='open'").run(status, actor.id, Date.now(), note, pr.id);
    if (part) this.db.prepare('UPDATE bp_proposals SET declined=?, applied_ops=? WHERE id=?').run(part.declined ? JSON.stringify(part.declined) : null, part.applied, pr.id);
    // A refine request stays open when its proposal is sent back or goes stale: the link is cleared so the operator can ask again.
    if (status !== 'applied' && pr.request_id !== null) this.db.prepare('UPDATE bp_report_requests SET proposal_id=NULL WHERE id=? AND proposal_id=?').run(pr.request_id, pr.id);
    if (!r.changes) throw err('invalid_state', `The proposal is already ${this.proposal(pr.id)?.status ?? 'gone'}.`);
    this.deps.audit?.settle('bp_proposal', pr.id); // its alert in Log → Alerts has nothing left to ask
    // Tasks that named keys this proposal writes keep them, live, only if it was applied (inside the caller's transaction).
    if (pr.team_id && pr.type === 'ops') this.onProposalClosed?.(pr.team_id, pr.id, status);
    const p = this.project(pr.project_id)!, who = pr.agent_id ? this.label(pr.agent_id) : 'an agent';
    const mine = pr.type === 'replan' && status === 'rejected' ? `The operator sent back your re-plan submission ${pr.id} (re-plan ${pr.replan_id}) in ${p.key}${note ? `: ${note}` : '.'} The re-plan stays open: revise its items, then submit again with bp_proposals {action: "submit_replan"}.`
      : pr.type === 'replan' && status === 'stale' ? `Your re-plan submission ${pr.id} in ${p.key} could not be applied: ${note}. The re-plan stays open: check its items and submit again.`
      : status === 'applied' && part?.declined ? `The operator applied ${part.applied} of ${pr.ops.length} ops of your blueprint proposal ${pr.id} in ${p.key} (now version ${p.version}). Left out: ${part.declined.map((d) => `op ${d.index}${d.key ? ` (${l2(d.key, 80)})` : ''}`).join(', ')}.${note ? ` Operator's note: ${note}` : ''}`
      : status === 'applied' ? `The operator applied your blueprint proposal ${pr.id} in ${p.key} (now version ${p.version}).`
      : status === 'rejected' ? `The operator rejected your blueprint proposal ${pr.id} in ${p.key}${note ? `: ${note}` : '.'}`
      : `Your blueprint proposal ${pr.id} in ${p.key} could not be applied: ${note}. Read the blueprint again and propose anew.`;
    if (pr.agent_id) this.notify([pr.agent_id], 'bp_proposal', mine);
    if (pr.team_id) this.notify(this.coordinators(pr.team_id).filter((c) => c !== pr.agent_id), 'bp_proposal',
      `${status === 'stale' ? `${who}'s blueprint proposal ${pr.id} in ${p.key} turned stale (the blueprint moved under it)` : `The operator ${status} ${who}'s blueprint proposal ${pr.id} in ${p.key}`}.`);
    this.deps.audit?.event({ kind: actor.kind === 'operator' ? 'admin' : actor.kind === 'agent' ? 'agent' : 'system', id: actor.id }, `blueprint.proposal_${status}`, { kind: 'bp_proposal', id: pr.id }, { project: p.key });
  }

  /**
   * A team_ask answer (§4): a `proposed` decision named in its refs is accepted with the answer; otherwise, when the
   * agent asked with `decision: true`, a new accepted ADR records it and governs the refs it can. Returns the ADR key.
   */
  recordDecision(d: AskAnswer, actor: BpActor, rejected?: { reason: string }): string | null {
    const p = this.projectOfTeam(d.team_id);
    if (!p) return null;
    const settled = { chosen: [d.answer_label, d.answer_text].filter(Boolean).join(' — ').slice(0, 1000), decided_at: d.answered_at ?? Date.now(), decided_by: 'operator', source: `team_ask:${d.id}` };
    return atomic(this.db, () => {
      const adr = d.refs.map((k) => this.liveRow(p.id, k)).find((r) => r?.kind === 'decision' && r.status === 'proposed');
      if (adr) {
        // A rejected design: the decision is recorded as rejected, with the operator's reason as its consequence.
        const to = rejected ? { status: 'rejected', fields: { ...settled, chosen: 'Rejected', consequences: rejected.reason.slice(0, 2000) } } : { status: 'accepted', fields: settled };
        this.apply(p.id, [{ op: 'upsert', kind: 'decision', key: adr.key, status: to.status, fields: to.fields }], actor, { note: `${rejected ? 'rejected' : 'answered'} ${d.id}`, teamId: d.team_id });
        return adr.key;
      }
      if (!d.make_decision) return null;
      const r = this.apply(p.id, [{ op: 'upsert', kind: 'decision', key: 'ADR-*', title: d.question.trim().slice(0, this.limits.title), status: 'accepted',
        fields: { context: d.context?.slice(0, 2000) ?? null, options: d.options.map((o) => ({ key: o.key, label: o.label, ...(o.effect ? { effect: o.effect } : {}) })), ...settled } }],
        actor, { note: `answered ${d.id}`, teamId: d.team_id });
      const key = r.keys['ADR-*']!;
      const governs: Op[] = d.refs.map((k) => this.liveRow(p.id, k)).filter((x): x is ItemRow => !!x && relAllows('governs', 'decision', x.kind))
        .map((x) => ({ op: 'link', from: key, to: x.key, rel: 'governs' }));
      if (governs.length) this.apply(p.id, governs, actor, { note: `answered ${d.id}`, teamId: d.team_id });
      return key;
    });
  }

  /**
   * The design a decision question asks about (docs/decisions.md, Designs): the first decision item its refs name (live, any status),
   * with its body, the review and who wrote it. Null when the question names none.
   */
  designOf(teamId: string, refs: string[]): Design | null {
    const p = this.projectOfTeam(teamId);
    if (!p) return null;
    for (const k of refs) { const d = this.designAt(p.id, k); if (d) return d; }
    return null;
  }
  /** The decision item with this key as a design (archived or not), or null when the key is not a live decision. */
  designAt(projectId: string, key: string): Design | null {
    const r = this.liveRow(projectId, key);
    if (r?.kind !== 'decision') return null;
    const item = toItem(r);
    // Revisions, oldest first: the writer is who made the first one; the reviewer is who last changed the review field.
    const revs = this.revisions(r.id).slice().reverse();
    let reviewed: { kind: string; id: string | null; at: number } | null = null, prev = 'null', atReview: string | null = null;
    // What the reviewer read: the title, body, options and mockups of the revision that set the review.
    const content = (snap: Record<string, unknown>): string => { const f = (snap['fields'] as Record<string, unknown> | undefined) ?? {}; return JSON.stringify([snap['title'] ?? null, snap['body'] ?? null, f['options'] ?? null, f['mockups'] ?? null]); };
    let stale = false;
    for (const v of revs) {
      const now = JSON.stringify(((v.snapshot['fields'] as Record<string, unknown> | undefined) ?? {})['review'] ?? null);
      if (now !== prev && now !== 'null') { reviewed = { kind: v.actor_kind, id: v.actor_id, at: v.at }; atReview = content(v.snapshot); stale = false; }
      else if (atReview !== null && content(v.snapshot) !== atReview) stale = true;
      prev = now;
    }
    return { item, project_id: projectId, written_by: revs[0] ? { kind: revs[0].actor_kind, id: revs[0].actor_id } : null, reviewed_by: reviewed, stale: !!reviewed && stale };
  }
  /** The designs of a project for the Blueprint filter: decision items that are designs (proposed, asked about, reviewed or with mockups), archived ones too. */
  designs(projectId: string): Design[] {
    const rows = this.db.prepare("SELECT key FROM bp_items WHERE project_id=? AND kind='decision' AND deleted_at IS NULL ORDER BY created_at DESC, key DESC").all(projectId) as { key: string }[];
    // A decision a team asked the operator about is a design too, reviewed or not.
    const asked = new Set<string>(); for (const q of this.db.prepare('SELECT d.refs, d.bp_key FROM decisions d JOIN teams t ON t.id=d.team_id WHERE t.project_id=?').all(projectId) as { refs: string; bp_key: string | null }[]) { if (q.bp_key) asked.add(q.bp_key); try { for (const k of JSON.parse(q.refs) as string[]) asked.add(k); } catch { /* a malformed refs list names nothing */ } }
    return rows.map((r) => this.designAt(projectId, r.key)).filter((d): d is Design => !!d && (d.item.status === 'proposed' || asked.has(d.item.key) || !!d.item.fields['review'] || (Array.isArray(d.item.fields['mockups']) && (d.item.fields['mockups'] as unknown[]).length > 0)));
  }

  /**
   * Answering an unclear requirement's question clears its mark in the same step (docs/blueprint.md §2.7). Returns the key it cleared,
   * or null when no item names this ask. With itemRev (what the answerer saw): an item that moved is a conflict, and an item the
   * team already cleared is already_clear. Runs inside the caller's transaction; the answer is the revision's note.
   */
  clarify(d: { id: string; team_id: string; refs: string[] }, text: string | null, actor: BpActor, itemRev: number | null): string | null {
    const p = this.projectOfTeam(d.team_id);
    if (!p) return null;
    const items = d.refs.map((k) => this.liveRow(p.id, k)).filter((r): r is ItemRow => !!r && (r.kind === 'fr' || r.kind === 'nfr'));
    const named = items.find((r) => parse<Record<string, unknown>>(r.fields, {})['unclear_ask'] === d.id);
    if (!named) {
      if (itemRev !== null && items.length) throw err('already_clear', `${items[0]!.key} is no longer marked unclear: the team cleared it already. Your answer is not needed to clear it.`, { key: items[0]!.key });
      return null;
    }
    if (itemRev !== null && named.rev !== itemRev) throw err('conflict', `${named.key} changed since you opened it (now revision ${named.rev}). Read it again before answering.`, { key: named.key, rev: named.rev });
    const note = `clarified: ${(text ?? 'answered').replace(/\s+/g, ' ').trim().slice(0, 500)}`;
    this.apply(p.id, [{ op: 'upsert', kind: named.kind as 'fr' | 'nfr', key: named.key, fields: { unclear: null, unclear_ask: null } }], actor, { note, notes: { [named.key]: note }, teamId: d.team_id });
    return named.key;
  }

  /** The operator asks a team what is unclear in a legacy item (marked before the question route): one fixed notice to its coordinators. */
  askClarify(projectId: string, key: string): { notified: number } {
    const p = this.project(projectId);
    if (!p) throw err('not_found', 'No such project.');
    const r = this.liveRow(p.id, key);
    if (!r || (r.kind !== 'fr' && r.kind !== 'nfr')) throw err('not_found', `${key} is not a requirement of this project.`);
    const f = parse<Record<string, unknown>>(r.fields, {});
    if (f['unclear'] !== true) throw err('invalid_state', `${key} is not marked unclear.`);
    const open = typeof f['unclear_ask'] === 'string' && this.db.prepare("SELECT 1 FROM decisions WHERE id=? AND status IN ('open','needs_info')").get(f['unclear_ask']);
    if (open) throw err('invalid_state', `${key} already has an open question to the operator.`);
    const to = r.team_id ? this.coordinators(r.team_id) : [];
    const who = to.length ? to : this.projectCoordinators(p.id);
    if (!who.length) throw err('invalid_state', `No team in ${p.key} has a coordinator to ask.`);
    this.notify(who, 'unclear_ask', `The operator asks what is unclear in ${key} (${l2(r.title, 120)}). Ask them with one team_ask that names ${key} in refs, then write unclear: true with unclear_ask set to that question's id.`);
    return { notified: who.length };
  }

  private opKeys(ops: Op[]): string {
    const ks = [...new Set(ops.map((o) => ('from' in o ? `${o.from}→${o.to}` : String(o.key))))];
    return ks.slice(0, 6).join(', ') + (ks.length > 6 ? ` and ${ks.length - 6} more` : '');
  }
  private label(agentId: string): string { return this.deps.keys?.agent(agentId)?.label ?? agentId; }
  private coordinators(teamId: string): string[] {
    return (this.db.prepare("SELECT agent_id FROM team_members WHERE team_id=? AND role='coordinator' AND removed_at IS NULL").all(teamId) as { agent_id: string }[]).map((r) => r.agent_id);
  }
  private teamMembers(teamId: string): string[] {
    return (this.db.prepare('SELECT agent_id FROM team_members WHERE team_id=? AND removed_at IS NULL').all(teamId) as { agent_id: string }[]).map((r) => r.agent_id);
  }
  private projectMembers(projectId: string): string[] {
    return [...new Set((this.db.prepare("SELECT m.agent_id FROM team_members m JOIN teams t ON t.id=m.team_id WHERE t.project_id=? AND m.removed_at IS NULL AND t.status IN ('running','paused','draft')").all(projectId) as { agent_id: string }[]).map((r) => r.agent_id))];
  }
  private projectCoordinators(projectId: string): string[] {
    return [...new Set((this.db.prepare("SELECT m.agent_id FROM team_members m JOIN teams t ON t.id=m.team_id WHERE t.project_id=? AND m.role='coordinator' AND m.removed_at IS NULL").all(projectId) as { agent_id: string }[]).map((r) => r.agent_id))];
  }
  private notify(agents: string[], kind: string, body: string): void { for (const a of agents) this.deps.keys?.notify(a, kind, body); }

  // ───── what the MCP tools read (bp_read) and the status reports they file (bp_report) ─────
  /** The next free top-level line key; deleted lines count, so a key is never reused. */
  private nextLine(projectId: string): string {
    let max = 0;
    for (const r of this.db.prepare("SELECT key FROM bp_items WHERE project_id=? AND kind='line'").all(projectId) as { key: string }[]) {
      const m = /^L(\d+)$/.exec(r.key);
      if (m && Number(m[1]) > max) max = Number(m[1]);
    }
    return `L${max + 1}`;
  }

  // ───── plain writing (docs/blueprint.md §2.7): read only, never refuses ─────
  private glossCache = new Map<string, { version: number; known: Known }>();
  /** The project's glossary from its live terms, with the live keys and the project key, which are never codes. */
  glossary(projectId: string): Known {
    const p = this.project(projectId);
    if (!p) throw err('not_found', 'No such project.');
    const hit = this.glossCache.get(p.id);
    if (hit && hit.version === p.version && !this.db.isTransaction) return hit.known;
    const rows = this.db.prepare('SELECT kind, key, title, body, fields FROM bp_items WHERE project_id=? AND deleted_at IS NULL').all(p.id) as { kind: string; key: string; title: string; body: string | null; fields: string }[];
    const known = glossaryOf(rows.filter((r) => r.kind === 'term').map((r) => ({ key: r.key, title: r.title, body: r.body, fields: parse(r.fields, {}) })), [p.key, ...rows.map((r) => r.key)]);
    // Inside a transaction the rows may still roll back (the trial run of plainWarnings), so only a settled read is kept.
    if (!this.db.isTransaction) this.glossCache.set(p.id, { version: p.version, known });
    return known;
  }

  /** An item's summary, Records and the codes it uses with the term that defines each, or null (§2.2). Records are not scanned. */
  plainOf(projectId: string, item: { kind: string; title: string; body: string | null; fields: Record<string, unknown> }, known = this.glossary(projectId)): { summary: string; records: string | null; codes: { token: string; term: TermRef | null }[] } {
    const { summary, records } = splitBody(item.body);
    const f = item.fields ?? {};
    const texts = [item.title, summary, ...(item.kind === 'ac' ? [f['given'], f['when'], f['then']] : []), ...(item.kind === 'milestone' ? [f['exit']] : [])].filter((s): s is string => typeof s === 'string' && !!s);
    const codes = new Map<string, TermRef | null>();
    for (const t of texts) {
      for (const c of findCodes(t, known)) if (!codes.has(c)) codes.set(c, resolve(c, known));
      for (const w of termWords(t, known)) if (!codes.has(w.token)) codes.set(w.token, w.term);
    }
    return { summary, records, codes: [...codes].map(([token, term]) => ({ token, term })) };
  }

  /** The checks on one item's own text: codes in the title, a title that starts with a code, an empty acceptance criterion. */
  private textChecks(r: { key: string; kind: string; title: string; body: string | null; fields: Record<string, unknown> }, label: string, known: Known, pending: Known | null, hits: Map<string, Set<string>>): Warning[] {
    if (r.kind === 'term' || r.kind === 'report') return [];
    const out: Warning[] = [], undef: string[] = [];
    for (const t of findCodes(r.title, known)) {
      if (resolve(t, known)) continue;
      const later = pending ? resolve(t, pending) : null;
      if (later) (hits.get(later.key) ?? hits.set(later.key, new Set()).get(later.key)!).add(t);
      else undef.push(t);
    }
    if (undef.length) out.push(warn.undefined_code(label, r.title, undef));
    const lead = leadingCode(r.title, known);
    if (lead) out.push(warn.code_first(label, r.title, lead));
    if (r.kind === 'ac' && acceptanceEmpty(r)) out.push(warn.empty_ac(label, r.title));
    // A cited text in the form of a key is an item, never a file: one the project does not have says so (key_missing).
    for (const k of citedRefs(r).keys) if (!known.keys.has(k)) out.push(warn.key_missing(label, r.title, k));
    return out;
  }

  /**
   * final_unsupported and unlinked_evidence on the blueprint as it stands (E2): the claims named, plus the claims that
   * share a rare code with the evidence items named. A rare code is in at most 3 items, is no term and is not noise.
   */
  private claimChecks(projectId: string, claims: Set<string> | 'all', evidence: Set<string>, known: Known, label: (k: string) => string): Warning[] {
    const rows = this.db.prepare('SELECT key, kind, title, body, status FROM bp_items WHERE project_id=? AND deleted_at IS NULL AND archived=0').all(projectId) as { key: string; kind: string; title: string; body: string | null; status: string | null }[];
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const index = new Map<string, Set<string>>(), codesOf = new Map<string, string[]>();
    let built = false;
    const build = () => {
      if (built) return;
      built = true;
      for (const r of rows) {
        if (r.kind === 'term' || r.kind === 'report') continue;
        const cs = findCodes(`${r.title}\n${splitBody(r.body).summary}`, known);
        codesOf.set(r.key, cs);
        for (const c of cs) (index.get(c) ?? index.set(c, new Set()).get(c)!).add(r.key);
      }
    };
    const rare = (t: string) => !resolve(t, known) && !isNoiseCode(t, known) && (index.get(t)?.size ?? 0) <= 3;
    const want = new Set<string>(claims === 'all' ? rows.filter((r) => r.kind === 'claim').map((r) => r.key) : [...claims].filter((k) => byKey.get(k)?.kind === 'claim'));
    if (evidence.size) {
      build();
      for (const k of evidence) for (const c of codesOf.get(k) ?? []) if (rare(c)) for (const o of index.get(c) ?? []) if (byKey.get(o)?.kind === 'claim') want.add(o);
    }
    if (!want.size) return [];
    const out: Warning[] = [];
    for (const s of this.claimStates(projectId, { keys: want })) {
      if (s.status === 'final' && (s.support === 'unsupported' || s.support === 'contradicted')) out.push(warn.final_unsupported(label(s.key), s.title, s.support));
      if (s.status === 'cut' || s.evidence.length) continue;
      build();
      for (const t of codesOf.get(s.key) ?? []) {
        if (!rare(t)) continue;
        const others = [...index.get(t)!].filter((o) => o !== s.key && relAllows('evidence', byKey.get(o)!.kind, 'claim'));
        const o = others.find((x) => evidence.has(x)) ?? others[0];
        if (o) { out.push(warn.unlinked_evidence(label(s.key), s.title, label(o), t)); break; }
      }
    }
    return out;
  }

  /**
   * What a batch leaves that the operator cannot read plainly (§2.2, E2), worked out on a trial run of the batch that is
   * rolled back, so link checks see the state after the batch. A `*` key is reported as written; the caller swaps in the
   * key the write allocated. Read only and never throws: any error gives empty lists. `cited` lists the vault sources
   * each upserted item cites, for the caller to resolve (E4.6).
   */
  plainWarnings(projectId: string, ops: Op[], _teamId?: string | null): PlainCheck & { cited: { key: string; title: string; texts: string[] }[] } {
    const none = { warnings: [], pending: [], cited: [] };
    try {
      const p = this.project(projectId);
      if (!p || !Array.isArray(ops)) return none;
      // Term definitions come from the state before the batch (its terms are pending); keys come from after it, below.
      const before = this.glossary(p.id);
      const ups = ops.filter((o): o is Extract<Op, { op: 'upsert' }> => o?.op === 'upsert' && !!KINDS[o.kind] && typeof o.key === 'string');
      const terms = ups.filter((o) => o.kind === 'term');
      // Terms are the operator's, so a term in the batch is pending: it defines its codes only once applied.
      const pending = terms.length ? glossaryOf(terms.map((t) => ({ key: t.key, title: t.title ?? this.liveRow(p.id, t.key)?.title ?? '', body: t.body ?? null, fields: t.fields ?? {} })), []) : null;
      const hits = new Map<string, Set<string>>();
      let out: PlainCheck & { cited: { key: string; title: string; texts: string[] }[] } = none;
      const done = Symbol('plain');
      try {
        atomic(this.db, () => {
          const res = this.apply(p.id, ops, { kind: 'system', id: null }, { noEvent: true, force: true });
          // A key the batch creates (H-L1-09, or one allocated from *) is known, as plainIssues will see it once settled.
          const known: Known = { ...before, keys: this.glossary(p.id).keys };
          const star = new Map(Object.entries(res.keys).map(([s, k]) => [k, s]));
          const label = (k: string) => star.get(k) ?? k;
          const warnings: Warning[] = [], cited: { key: string; title: string; texts: string[] }[] = [];
          const seen = new Set<string>(), claims = new Set<string>(), evidence = new Set<string>();
          for (const o of ups) {
            const r = this.liveRow(p.id, res.keys[o.key] ?? o.key);
            if (!r || seen.has(r.key)) continue;
            seen.add(r.key);
            const it = toItem(r);
            warnings.push(...this.textChecks(it, label(r.key), known, pending, hits));
            if (r.kind === 'claim') claims.add(r.key);
            else if (r.kind !== 'term') evidence.add(r.key);
            const texts = citedSources(it).filter((t) => classifySource(t) !== 'outside');
            if (texts.length) cited.push({ key: label(r.key), title: r.title, texts });
          }
          for (const o of ops) if (o?.op === 'link' && o.rel === 'evidence') claims.add(res.keys[o.to] ?? o.to);
          warnings.push(...this.claimChecks(p.id, claims, evidence, known, label));
          out = { warnings, pending: terms.map((t) => ({ key: t.key, tokens: [...(hits.get(t.key) ?? [])] })), cited };
          throw done;
        });
      } catch (e) { if (e !== done) return none; }
      return out;
    } catch { return none; }
  }

  /** Every plain-writing issue of the live items, by key: bp_read {plain: "issues"}, the console list and its Check pill. */
  plainIssues(projectId: string): Map<string, Warning[]> {
    const out = new Map<string, Warning[]>();
    try {
      const known = this.glossary(projectId);
      for (const r of this.db.prepare('SELECT * FROM bp_items WHERE project_id=? AND deleted_at IS NULL AND archived=0').all(projectId) as unknown as ItemRow[]) {
        const ws = this.textChecks(toItem(r), r.key, known, null, new Map());
        if (ws.length) out.set(r.key, ws);
      }
      for (const w of this.claimChecks(projectId, 'all', new Set(), known, (k) => k)) (out.get(w.key) ?? out.set(w.key, []).get(w.key)!).push(w);
    } catch { /* read only: no issues rather than an error */ }
    return out;
  }

  /**
   * The standing line the hub writes from the support model (E1), never from agent text: for a paper, a claim or a
   * hypothesis; null for any other kind. It uses the verdicts of paperReadiness, so a paper shows one number everywhere.
   */
  standing(projectId: string, key: string): string | null {
    const it = this.item(projectId, key);
    if (!it) return null;
    const short = (k: string, paper?: string | null) => (paper && k.startsWith(`${paper}/`) ? k.slice(paper.length + 1) : k);
    const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
    const tag = (e: { kind: string; status: string | null; fields: Record<string, unknown> }) => (e.kind === 'finding' ? `${(e.fields['confidence'] as string | undefined) ?? 'no'} confidence` : e.status ?? e.kind);
    const findings = (keys: string[]) => keys.reduce((n, k) => n + this.evidenceOf(projectId, k).filter((r) => r.kind === 'finding').length, 0);
    const from = (n: number) => (n ? `, from ${n} finding${n === 1 ? '' : 's'}` : '');
    if (it.kind === 'paper') {
      const states = this.claimStates(projectId, { papers: [key] });
      const r = paperReadiness(states);
      if (!r.total) return 'No claims yet.';
      const parts: string[] = [];
      for (const c of states.filter((s) => s.status !== 'cut' && s.support === 'contradicted')) parts.push(`${short(c.key, key)} is contradicted by ${list(c.evidence.filter(contradicts).map((e) => e.key))}.`);
      if (!r.holding.length) parts.push(`All ${r.total} claim${r.total === 1 ? '' : 's'} supported.`);
      else {
        parts.push(`${r.supported} of ${r.total} claim${r.total === 1 ? '' : 's'} supported.`);
        const weak = r.holding.filter((c) => c.support === 'weak').map((c) => short(c.key, key)), bare = r.holding.filter((c) => c.support === 'unsupported').map((c) => short(c.key, key));
        const bits = [weak.length ? `${list(weak)} ${weak.length === 1 ? 'has' : 'have'} only undecided evidence` : '', bare.length ? `${list(bare)} ${bare.length === 1 ? 'has' : 'have'} none` : ''].filter(Boolean);
        if (bits.length) parts.push(`${bits.join('; ')}.`);
      }
      return parts.join(' ');
    }
    if (it.kind === 'claim') {
      const c = this.claim(projectId, key)!;
      if (c.support === 'unsupported') return 'No evidence linked.';
      if (c.support === 'contradicted') return `Contradicted by ${list(c.evidence.filter(contradicts).map((e) => `${e.key} (${tag(e)})`))}.`;
      if (c.support === 'weak') return `Only undecided evidence: ${list(c.evidence.map((e) => `${e.key} (${tag(e)})`))}.`;
      const dec = c.evidence.filter(decided);
      return `Supported by ${list(dec.map((e) => `${e.key} (${tag(e)})`))}${from(findings(dec.filter((e) => e.kind === 'hypothesis').map((e) => e.key)))}.`;
    }
    if (it.kind === 'hypothesis') {
      const backs = this.db.prepare("SELECT l.to_key k, i.parent_key p FROM bp_links l JOIN bp_items i ON i.project_id=l.project_id AND i.key=l.to_key WHERE l.project_id=? AND l.from_key=? AND l.rel='evidence' AND i.kind='claim' AND i.deleted_at IS NULL ORDER BY l.to_key").all(projectId, key) as { k: string; p: string | null }[];
      const onePaper = new Set(backs.map((b) => b.p)).size === 1, n = findings([key]);
      const st = it.status ?? 'untested';
      const head = `${st[0]!.toUpperCase()}${st.slice(1)}.`;
      if (backs.length) return `${head} Backs ${list(backs.map((b) => (onePaper ? short(b.k, b.p) : b.k)))}${from(n)}.`;
      return n ? `${head} From ${n} finding${n === 1 ? '' : 's'}; backs no claim yet.` : head;
    }
    return null;
  }

  /**
   * A hypothesis's next step (§2.7), computed from its status and the findings linked to it as evidence, never from agent
   * text; null for any other kind, and when there is nothing to do next.
   */
  nextStep(projectId: string, key: string): string | null {
    const it = this.item(projectId, key);
    if (!it || it.kind !== 'hypothesis') return null;
    const found = this.evidenceOf(projectId, key).filter((e) => e.kind === 'finding'), n = found.length;
    const dec = found.filter((e) => decided({ kind: e.kind, key: e.key, status: e.status, fields: JSON.parse(e.fields || '{}') as Record<string, unknown> })).length;
    const st = it.status ?? 'untested';
    if (!n) return 'Link a finding as evidence.';
    if (st === 'untested' || st === 'testing') {
      if (!dec) return 'Add a finding with medium or high confidence.';
      return `Decide its status: ${n === 1 ? 'its one finding has' : dec < n ? `${dec} of ${n} findings have` : n === 2 ? 'both findings have' : `all ${n} findings have`} medium or high confidence.`;
    }
    if (st === 'confirmed' || st === 'refuted') {
      const backs = this.db.prepare("SELECT 1 FROM bp_links l JOIN bp_items i ON i.project_id=l.project_id AND i.key=l.to_key WHERE l.project_id=? AND l.from_key=? AND l.rel='evidence' AND i.kind='claim' AND i.deleted_at IS NULL LIMIT 1").get(projectId, key);
      if (!backs) return 'Cite it as evidence in a paper claim.';
    }
    return null;
  }

  /** Every live claim's support, optionally of one team's part (the facts of a status report, §7). */
  supports(projectId: string, teamId?: string): Record<string, Support> {
    return Object.fromEntries(this.claimStates(projectId, teamId ? { team: teamId } : {}).map((c) => [c.key, c.support]));
  }
  /**
   * The support of the claims a batch of ops can move, read before it runs; call the answer after the write for what
   * changed (§2.4, §5 bp_write). A claim moves when the batch writes it, or an item linked to it as evidence, or one of its
   * evidence links. Claims the write adds count too.
   */
  supportWatch(projectId: string, ops: Op[]): (r: { added: string[] }) => SupportChange[] {
    const keys = new Set<string>();
    for (const o of ops) {
      if (o.op === 'link' || o.op === 'unlink') { keys.add(o.from); keys.add(o.to); continue; }
      const key = (o as { key?: unknown }).key;
      if (typeof key === 'string' && !key.endsWith('*')) keys.add(key);
    }
    const linked = this.db.prepare("SELECT DISTINCT to_key FROM bp_links WHERE project_id=? AND rel='evidence' AND from_key IN (SELECT value FROM json_each(?))").all(projectId, JSON.stringify([...keys])) as { to_key: string }[];
    for (const l of linked) keys.add(l.to_key);
    const of = (ks: Iterable<string>) => Object.fromEntries(this.claimStates(projectId, { keys: ks }).map((c) => [c.key, c.support]));
    const before = of(keys);
    return (r) => Blueprint.supportChanges(before, of([...keys, ...r.added]));
  }
  static supportChanges(before: Record<string, Support>, after: Record<string, Support>): SupportChange[] {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
      .filter((k) => before[k] !== after[k]).map((k) => ({ key: k, was: before[k] ?? null, now: after[k] ?? null }));
  }

  /**
   * bp_read (§5): by default the team's part plus project-level items, as an index (the whole project when the team is
   * its only one, FR-PLAN-12). `scope: project` reads every part;
   * `keys` and `track` read exactly those items wherever they sit. `since_version` keeps what changed after that version
   * and lists what was removed. Reports are the newest three unless keys name others. Paged by `cursor` (an offset).
   */
  read(projectId: string, teamId: string | null, q: ReadQuery = {}, extraIssues?: Map<string, Warning[]>): ReadResult {
    const p = this.project(projectId);
    if (!p) throw err('not_found', 'No such project.');
    const limit = Math.max(1, Math.min(100, q.limit ?? 100)), offset = Math.max(0, q.cursor ?? 0);
    const kinds = q.section ? SECTION_KINDS[q.section] : undefined;
    if (q.section && !kinds) throw err('invalid_argument', 'A section is 1 to 6 (§1: foundation, requirements, decisions, planning, tracking, appendix).');
    for (const k of q.kinds ?? []) if (!KINDS[k]) throw unknownKind(k);
    // Every filter is SQL; only the page's rows, links and claims are loaded.
    const where = ['project_id=?', 'deleted_at IS NULL', 'archived=0'], args: (string | number | null)[] = [p.id];
    const add = (sql: string, ...v: (string | number | null)[]) => { where.push(sql); args.push(...v); };
    const inList = (col: string, xs: readonly string[]) => add(`${col} IN (SELECT value FROM json_each(?))`, JSON.stringify(xs));
    if (q.since_version !== undefined) add('changed_version>?', q.since_version);
    const ext = q.external !== undefined ? parseExternalFilter(q.external) : null;
    if (ext) add("EXISTS (SELECT 1 FROM json_each(bp_items.fields, '$.external') e WHERE json_extract(e.value, '$.system')=? AND (? IS NULL OR json_extract(e.value, '$.id')=?))", ext.system, ext.id, ext.id);
    if (q.keys?.length) inList('key', q.keys);
    else if (q.track) {
      const t = this.liveRow(p.id, q.track);
      if (!t || !KINDS[t.kind]!.track) throw err('invalid_argument', `${q.track} is not a module or line of ${p.key}.`);
      add('key IN (WITH RECURSIVE inside(k) AS (SELECT ? UNION SELECT i.key FROM bp_items i JOIN inside ON i.parent_key=inside.k WHERE i.project_id=? AND i.deleted_at IS NULL) SELECT k FROM inside)', t.key, p.id);
    } else if (!ext && q.scope !== 'project' && !(teamId && this.soleTeam(p.id) === teamId)) add('(team_id IS NULL OR team_id=?)', teamId);
    if (q.team) { if (q.team === 'project') add('team_id IS NULL'); else add('team_id=?', q.team); }
    for (const w of (q.q ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8)) add("instr(bp_fold(key || ' ' || title || ' ' || COALESCE(body, '')), ?) > 0", w);
    if (kinds) inList('kind', kinds);
    if (q.kinds?.length) inList('kind', q.kinds);
    if (q.status?.length) inList("COALESCE(status, '')", q.status);
    let cond = where.join(' AND '), condArgs = args;
    if (!q.keys?.length) { // the newest three reports, not the whole log (§7)
      cond = `${cond} AND (kind<>'report' OR id IN (SELECT id FROM bp_items WHERE ${cond} AND kind='report' ORDER BY created_at DESC, key DESC LIMIT 3))`;
      condArgs = [...args, ...args];
    }
    // `plain: issues` filters in JS on what the SQL matched, then pages; without it the read is the SQL page as before.
    const issues = q.plain === 'issues' ? this.plainIssues(p.id) : null;
    if (issues) for (const [k, ws] of extraIssues ?? []) issues.set(k, [...(issues.get(k) ?? []), ...ws]);
    const matched = issues ? (this.db.prepare(`SELECT * FROM bp_items WHERE ${cond} ORDER BY ${SECTION_ORDER}`).all(...condArgs) as unknown as ItemRow[]).filter((r) => issues.get(r.key)?.length) : null;
    const total = matched ? matched.length : (this.db.prepare(`SELECT COUNT(*) n FROM bp_items WHERE ${cond}`).get(...condArgs) as { n: number }).n;
    const page = matched ? matched.slice(offset, offset + limit) : this.db.prepare(`SELECT * FROM bp_items WHERE ${cond} ORDER BY ${SECTION_ORDER} LIMIT ? OFFSET ?`).all(...condArgs, limit, offset) as unknown as ItemRow[];
    const removed = q.since_version === undefined ? []
      // Removed and archived items (§6.1) both leave the reader's copy.
      : (this.db.prepare(`SELECT key FROM bp_items WHERE project_id=? AND changed_version>? AND (deleted_at IS NOT NULL OR archived=1) ORDER BY ${SECTION_ORDER}`).all(p.id, q.since_version) as { key: string }[]).map((r) => r.key);
    const keys = JSON.stringify(page.map((r) => r.key)), out = new Map<string, string[]>(), inn = new Map<string, string[]>();
    const links = this.db.prepare('SELECT * FROM bp_links WHERE project_id=? AND (from_key IN (SELECT value FROM json_each(?)) OR to_key IN (SELECT value FROM json_each(?))) ORDER BY from_key, rel, to_key').all(p.id, keys, keys) as unknown as LinkRow[];
    for (const l of links) { (out.get(l.from_key) ?? out.set(l.from_key, []).get(l.from_key)!).push(`${l.rel}:${l.to_key}`); (inn.get(l.to_key) ?? inn.set(l.to_key, []).get(l.to_key)!).push(`${l.rel}<${l.from_key}`); }
    // Claim support for the page's claims, and every claim of its papers for their readiness.
    const papers = page.filter((r) => r.kind === 'paper').map((r) => r.key);
    const support = new Map(this.claimStates(p.id, { keys: page.filter((r) => r.kind === 'claim').map((r) => r.key) }).map((c) => [c.key, c.support]));
    const paperClaims = papers.length ? this.claimStates(p.id, { papers }) : [];
    const mates = new Set(teamId ? (this.db.prepare('SELECT agent_id FROM team_members WHERE team_id=? AND removed_at IS NULL').all(teamId) as { agent_id: string }[]).map((m) => m.agent_id) : []);
    const items = page.map((r): ReadItem => {
      const it: ReadItem = { key: r.key, kind: r.kind, title: r.title, status: r.status, parent: r.parent_key, team_id: r.team_id, links: [...(out.get(r.key) ?? []), ...(inn.get(r.key) ?? [])],
        updated_by: actorText(r.updated_by_kind, r.updated_by_id), trust: itemTrust(r, mates) };
      // Written by an agent while it ran for a collaborator: labelled with that person ("· via Lena").
      const via = r.updated_by_kind === 'agent' && r.updated_by_id ? this.viaAt(r.updated_by_id, r.updated_at) : null;
      if (via) it.via = via;
      if (r.replan_id) it.replan = r.replan_id;
      if (issues) it.plain_issues = issues.get(r.key)!.map(issueText);
      if (r.kind === 'claim') it.support = support.get(r.key)!;
      const pp = r.kind === 'paper' ? Blueprint.readiness(paperClaims.filter((c) => c.parent === r.key)) : null;
      if (pp) { it.supported = `${pp.supported} of ${pp.total}`; it.ready = pp.ready; }
      if (q.detail === 'full') {
        Object.assign(it, { body: r.body, fields: parse(r.fields, {}), rev: r.rev, created_by: actorText(r.created_by_kind, r.created_by_id), created_at: r.created_at, updated_at: r.updated_at });
        // An author the export claimed but the hub could not verify: attribution only, never trust (§4.2).
        const claimed = parse<BpActor | null>(r.attributed_to, null);
        if (claimed) it.attributed_to = actorText(claimed.kind, claimed.id);
        if (r.kind === 'claim') it.chain = this.chain(p.id, r.key);
        if (pp) it.claims = pp.claims.map((c) => ({ ...c, chain: this.chain(p.id, c.key) }));
        const st = r.kind === 'paper' || r.kind === 'claim' || r.kind === 'hypothesis' ? this.standing(p.id, r.key) : null;
        if (st) it.standing = st;
        const nx = r.kind === 'hypothesis' ? this.nextStep(p.id, r.key) : null;
        if (nx) it.next = nx;
      }
      return it;
    });
    const rp = this.openReplanFor(p.id, teamId);
    return { project: { id: p.id, key: p.key, name: p.name, kind: p.kind, status: p.status, version: p.version }, team_id: teamId, items, total, trust: lowestTrust(items.map((i) => i.trust)),
      ...(rp ? { replan: { id: rp.id, team_id: rp.team_id, kinds: rp.kinds, source: rp.source, items: rp.items, note: rp.note, submitted: rp.proposal?.status === 'open' ? rp.proposal.id : null } } : {}),
      next_cursor: offset + limit < total ? offset + limit : null, ...(q.since_version !== undefined ? { removed } : {}) };
  }

  /** A claim's evidence chain: its evidence plus one level (findings on a hypothesis, the ACs of an FR or NFR); nothing deeper (§2.4). */
  chain(projectId: string, claimKey: string): ChainLink[] {
    const c = this.claim(projectId, claimKey);
    if (!c) return [];
    const brief = (i: Item): ChainLink => ({ key: i.key, kind: i.kind, title: i.title, status: i.status, ...(i.kind === 'finding' ? { confidence: (i.fields['confidence'] as string | undefined) ?? null } : {}) });
    return c.evidence.map((e) => {
      const below = e.kind === 'hypothesis'
        ? this.evidenceOf(projectId, e.key)
        : e.kind === 'fr' || e.kind === 'nfr' ? (this.db.prepare("SELECT * FROM bp_items WHERE project_id=? AND parent_key=? AND kind='ac' AND deleted_at IS NULL ORDER BY position, key").all(projectId, e.key) as unknown as ItemRow[]) : [];
      return { ...brief(e), ...(below.length ? { from: below.map((b) => brief(toItem(b))) } : {}) };
    });
  }

  /**
   * bp_report (§7): the coordinator's status report as an `SR-nnn` item of the team's part, with the hub's facts.
   * Cadence: at most one per 24 h unless the operator asked or health dropped; refused when nothing moved since the last
   * one and nobody asked. The short form is also kept as the team's status report (team_status_reports, the Team
   * status screen); the item carries that row's id. `then` runs inside the same transaction once the report is written
   * (the tool charges the message budget and posts it there), so a failure there files nothing.
   */
  fileReport(teamId: string, agentId: string, a: ReportInput, then?: (r: { key: string; short: string }) => void): { key: string; version: number; short: string; facts: ReportFacts; requested: boolean } {
    const p = this.projectOfTeam(teamId) ?? this.ensureTeamProject(teamId);
    const { team, role } = this.seat(p.id, agentId, teamId);
    if (role !== 'coordinator') throw err('denied', 'Status reports are written by the team coordinator. As a member, tell the coordinator what moved.');
    const k = this.contributorOf(agentId);
    if (k) throw err('denied', `Contributor mode (for ${k.delegate}): a delegated agent files no status report. Tell another coordinator what moved.`);
    this.guard(p, team, agentId);
    const R = REPORT_SHAPE;
    if (!['on_track', 'at_risk', 'off_track'].includes(a.health)) throw err('invalid_argument', 'health is on_track, at_risk or off_track.');
    const list = (name: string, v: string[] | undefined) => {
      const xs = (v ?? []).map((x) => String(x).trim()).filter(Boolean);
      if (xs.length > R.bullets) throw err('invalid_argument', `${name}: at most ${R.bullets} bullets; keep each to one plain sentence.`);
      for (const x of xs) if (x.length > R.bullet) throw err('invalid_argument', `${name}: each bullet holds at most ${R.bullet} characters ("${x.slice(0, 40)}…").`);
      return xs;
    };
    const done = list('done', a.done), next = list('next', a.next), blockers = list('blockers', a.blockers);
    const size = [...done, ...next, ...blockers].reduce((n, x) => n + x.length, 0);
    if (size > R.total) throw err('invalid_argument', `A report holds at most ${R.total} characters; this one has ${size}.`);
    const refs = [...new Set(a.refs ?? [])].slice(0, 20);
    const bad = refs.filter((k) => !this.liveRow(p.id, k));
    if (bad.length) throw err('invalid_argument', `Not in the blueprint of ${p.key}: ${bad.join(', ')}.`);

    const now = Date.now();
    const reports = (this.db.prepare("SELECT * FROM bp_items WHERE project_id=? AND kind='report' AND team_id=? AND deleted_at IS NULL AND archived=0 ORDER BY created_at DESC, key DESC").all(p.id, team.id) as unknown as ItemRow[]).map(toItem);
    const last = reports[0], lastKnown = reports.find((r) => r.fields['health'] && r.fields['health'] !== 'unknown');
    // Only this team's open status requests count (F-04): a project request answered by another team stays open here.
    const asked = openRequests(this.db, team.id, 'status');
    const requested = asked.length > 0;
    const dropped = !!lastKnown && HEALTH_RANK[a.health]! > HEALTH_RANK[lastKnown.fields['health'] as string]!;
    if (last && now - last.created_at < DAY && !requested && !dropped) {
      throw err('rate_limited', `One status report per 24 h: ${last.key} was filed ${new Date(last.created_at).toISOString()}; the next is allowed after ${new Date(last.created_at + DAY).toISOString()}, sooner if the operator asks or health drops.`);
    }

    // The hub's facts since the last report, so the coordinator does not restate them.
    const since = last?.created_at ?? 0;
    const tasks = this.db.prepare('SELECT id, status FROM tasks WHERE team_id=? AND updated_at>? ORDER BY updated_at').all(team.id, since) as { id: string; status: string }[];
    // Writes since then that touched the team's part, whoever made them (the operator's included).
    const partOf = new Map((this.db.prepare('SELECT key, team_id FROM bp_items WHERE project_id=?').all(p.id) as { key: string; team_id: string | null }[]).map((r) => [r.key, r.team_id]));
    const ours = (k: string) => k.split('→').some((x) => partOf.get(x) === team.id);
    const events = (this.db.prepare('SELECT team_id, added, removed, changed, moves FROM bp_events WHERE project_id=? AND created_at>? ORDER BY id').all(p.id, since) as { team_id: string | null; added: string; removed: string; changed: string; moves: string }[])
      .filter((e) => e.team_id === team.id || [...parse<string[]>(e.added, []), ...parse<string[]>(e.removed, []), ...parse<string[]>(e.changed, [])].some(ours));
    const moved = [...new Set(events.flatMap((e) => parse<EventRow['moves']>(e.moves, [])).filter((m) => ours(m.key)).map((m) => `${m.key} ${m.was ?? '—'}→${m.status ?? '—'}`))];
    const support = this.supports(p.id, team.id);
    const before = (last?.fields['auto'] as ReportFacts | undefined)?.support ?? {};
    const claims = Blueprint.supportChanges(before, support).filter((c) => c.now).map((c) => `${c.key} ${c.was ?? 'new'}→${c.now}`);
    const open = (this.db.prepare("SELECT id FROM decisions WHERE team_id=? AND status IN ('open','needs_info') ORDER BY created_at").all(team.id) as { id: string }[]).map((r) => r.id);
    const facts: ReportFacts = { since: since || null, tasks_done: tasks.filter((x) => x.status === 'done').map((x) => x.id).slice(0, 10), tasks_moved: tasks.length, moved: moved.slice(0, 20), claims: claims.slice(0, 20), open_team_asks: open.slice(0, 10), support, coverage: coverageCounts(this.coverageOf(p.id, team.id, { teams: [team.id] })), blocking: blockingCount(this.questionsOf(p.id, team.id)) };

    const prevBlockers = new Set((last?.fields['blockers'] as string[] | undefined) ?? []);
    const nothing = !!last && !requested && !dropped && !a.escalate && a.health === last.fields['health'] && blockers.every((b) => prevBlockers.has(b))
      && !tasks.length && !events.length && !claims.length;
    if (nothing) throw err('invalid_state', `Nothing moved since ${last!.key} and the operator did not ask: no report is needed. Write one when a milestone, health, a blocker or a claim moves.`);

    const label = a.health.replace('_', ' ');
    const short = [`Status ${label}`, done.length ? `Done: ${done.join('; ')}` : '', next.length ? `Next: ${next.join('; ')}` : '', blockers.length ? `Blockers: ${blockers.join('; ')}` : '',
      refs.length ? `Refs: ${refs.join(', ')}` : '', a.escalate ? 'Escalated to the operator.' : ''].filter(Boolean).join('\n');
    const statusId = `tsr_${randomToken(10)}`;
    let fields: Record<string, unknown> = { health: a.health, done, next, blockers, escalate: !!a.escalate, refs, auto: facts, requested: requested ? (asked.find((r) => r.note)?.note ?? `asked ${new Date(asked[0]!.requested_at).toISOString()}`).slice(0, 300) : null };
    if (JSON.stringify(fields).length > this.limits.fields) fields = { ...fields, auto: { ...facts, support: {} } };
    const key = atomic(this.db, () => {
      const key = this.allocate(p.id, 'report', 'SR-*');
      this.db.prepare('INSERT INTO team_status_reports(id,team_id,agent_id,body,created_at) VALUES (?,?,?,?,?)').run(statusId, team.id, agentId, short, now);
      this.apply(p.id, [{ op: 'upsert', kind: 'report', key, title: `Status ${label}`, team_id: team.id, fields }], { kind: 'agent', id: agentId }, { origin: { [key]: statusId }, teamId: team.id, note: 'status report' });
      answerRequests(this.db, team.id, 'status', key, now);
      this.archiveReports(p.id);
      then?.({ key, short });
      return key;
    });
    if (a.escalate) this.deps.audit?.alert('warning', 'bp_escalation', key, { project: p.key, team: team.name, health: a.health });
    this.deps.audit?.event({ kind: 'agent', id: agentId }, 'blueprint.report', { kind: 'team', id: team.id }, { project: p.key, key, health: a.health, escalate: !!a.escalate });
    return { key, version: this.project(p.id)!.version, short, facts, requested };
  }
}
