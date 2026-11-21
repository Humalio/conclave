/**
 * Needs you and For awareness (docs/dashboard-ux.md "Attention words", docs/multi-user.md §1.3): one server-side list
 * per viewer that every console entrance reads with a filter. Home reads it whole; a team, a project and Blueprint
 * Review read it filtered. A row is a decision that waits for this viewer and that they can make now from its own
 * workflow: it names the source record and its version, the scope, the reason, where it opens and the resolving
 * actions. A row with no resolving action is never listed ("Open" or "Dismiss" alone never qualify).
 *
 * Who gets a row is decided by the same routing the source workflow checks when it acts: a member gets what is routed
 * to them as a team's active decider; the admin gets what routing sends to the admin (no active decider, escalated, or
 * outside the team's ceiling) plus the admin's own queues. Counts are of distinct source decisions after routing and
 * the filter, before paging, so every entrance counts the same rows.
 *
 * For awareness rows ask no decision. A viewer may dismiss one for its current episode (attention_dismissals); a new
 * episode of the same record shows again. Stall warnings are off per team and missed milestones off per project
 * unless switched on (migration 0123).
 *
 * Later (SPEC-ATTENTION-05, migration 0132): a viewer may set one Needs you row aside, for themselves, until a time or
 * until its version changes, and never for more than LATER_MAX_MS. The decision still waits for everyone. A set-aside row
 * leaves this viewer's list and counts and is reported under `later`; when its time passes or its version changes it is
 * listed again, marked `back_from_later`.
 */
import { tx, type Db } from '../db/db.js';
import type { Routing } from './routing.js';
import type { BpRouting } from './bpRouting.js';
import type { Blueprint } from '../blueprint/blueprint.js';
import { BP_RULES, milestoneLate, type BpRule } from '../blueprint/kinds.js';
import { pauseLabel, type Teams, type TeamRow, type MemberRow } from '../teams/teams.js';
import type { Onboarding } from '../onboarding/onboarding.js';
import { KeyError, LEAK_HOLD } from '../keys/keys.js';
import { questions } from '../blueprint/questions.js';
import { hubShortSummary } from '../teams/shortSummary.js';
import type { TaskAttachments } from '../shares/taskAttachments.js';
import { deliveryWhy, deliveryLine } from '../connector/deliveryWhy.js';
/** The statuses a task can be reassigned from (Teams.adminReassign); review rows outside them open the task. */
const REASSIGN_FROM = ['assigned', 'changes_requested', 'in_progress'];

/** One resolving action: the source workflow's own route. `input` actions need the source screen (a choice, a text). */
/** noteAs: the body field the source workflow reads the operator's note from (an answer's text), when not `note`. */
/** confirm: the question the console asks once before it acts, naming what the action ends; done: what its toast says happened. */
export interface NeedsAction { id: string; label: string; path: string; body?: Record<string, unknown>; input?: boolean; tone?: 'ok' | 'bad'; noteAs?: string; confirm?: string; done?: string }
/**
 * What a row needs to be decided on its own (docs/dashboard-ux.md, Needs you screen). Agent text (L2), shown escaped:
 * a question's context and options, a blocked task's reason and who blocked it, a proposal's operations.
 */
export type NeedsDetail =
  | { kind: 'question'; context: string | null; options: { key: string; label: string; effect: string | null }[]; recommended: string | null; blocks: { id: string; title: string } | null; asked_by: string }
  | { kind: 'blocked'; reason: string | null; blocked_by: string | null; blocked_at: number | null; assignee: string | null }
  | { kind: 'proposal'; ops: { op: string; kind: string | null }[] };
/** Where the row opens: the source record, by kind and id. */
export interface NeedsOpen { kind: string; id: string; team_id?: string | null; project_id?: string | null }
/** An unclear requirement as its row carries it: what the answerer needs to read, and the revision they saw (for item_rev). */
type Un = { project_id: string; key: string; title: string; body: string | null; rev: number; fields: string; unclear_ask: string | null };
const itemOf = (x: Un) => {
  const f = JSON.parse(x.fields) as Record<string, unknown>;
  return { project_id: x.project_id, key: x.key, title: x.title, priority: typeof f['priority'] === 'string' ? f['priority'] : null, statement: x.body, evidence: typeof f['evidence'] === 'string' ? f['evidence'] : null, rev: x.rev };
};
export interface NeedsRow {
  id: string; kind: string; source: { kind: string; id: string; version: string };
  scope: { project_id: string | null; team_id: string | null };
  title: string; reason: string; open: NeedsOpen; actions: NeedsAction[]; at: number;
  /** What the row needs to be decided on its own (NeedsDetail). */
  detail?: NeedsDetail;
  /** A design to decide: the decision item's key and the review in a few words ("approved", "2 changes"), or null when it has none. */
  design?: { key: string; review: string | null };
  /** A paused team's end time (epoch ms), shown in the viewer's own clock. */
  until?: number | null;
  /** An undelivered item's PC went offline at this time (epoch ms): the console adds "since hh:mm" in the viewer's own clock. */
  offline_since?: number | null;
  /** This viewer had set it aside with Later, and its time passed or its version changed. */
  back_from_later?: boolean;
  /** The context to decide, in one sentence (a checkout's current step), and who acts after it, by agent label. */
  step?: string; next?: string | null;
  /** Who sent it, by label (an agent, the operator), and the item's own text for its card: a task's In short, a question's
   *  context, a block's reason. Null when it has none; a kind that leaves them out shows its reason instead. */
  by?: string | null; summary?: string | null;
  /** An unclear requirement's row: the team's open question (Clarify answers it) and the requirement it names. A legacy row has the item only. */
  ask?: { id: string; question: string; team_id: string; team_label: string; asked_at: number; version: string };
  item?: ReturnType<typeof itemOf>;
}
/** A row this viewer set aside: when it ends (at most LATER_MAX_MS after it was set), and whether it was "until it changes". */
export interface LaterRow extends NeedsRow { later: { until: number; changes: boolean; at: number } }
/** Later lasts at most a week, "until it changes" included. */
export const LATER_MAX_MS = 7 * 24 * 3600_000;
/** A Later end a little past the week (the console's clock against the hub's) is accepted and cut to the week. */
const LATER_SLACK_MS = 5 * 60_000;
export interface AwareRow {
  id: string; kind: string; record: string; episode: string;
  scope: { project_id: string | null; team_id: string | null };
  title: string; reason: string; open: NeedsOpen; at: number;
  until?: number | null;
}
/** The filtered entrances: one team, one project, or Blueprint Review (the Blueprint decisions of a project). */
export interface NeedsFilter { team?: string; project?: string; review?: boolean }
/** The viewer: the admin, or a member with their grants (`can` answers per project and component). */
export interface Viewer { id: string; isAdmin: boolean; can: (projectId: string, component: string) => boolean }
/** Checkout steps that wait on the admin (GET /api/checkouts?open=1 needs_operator), read through the checkout API. */
export type CheckoutNeeds = () => Promise<{ id: string; team_id: string; team: string | null; needs_operator: { kind: string; at: number; agent_id?: string; count?: number; of?: number }[]; step?: { text: string; action: string | null; next: string | null } }[]>;

export const NEEDS_PAGE = 50;
/** For awareness counts the changes rules applied in this many days (docs/dashboard-ux.md, Changes applied by rules). */
export const RULES_AWARE_DAYS = 30;
export const NEEDS_PAGE_MAX = 200;

const enc = (s: string) => encodeURIComponent(s);
/** A task's In short: the coordinator's summary, else the hub's cut of the brief (teams.taskView's rule). */
/* A block's reason is Markdown with an optional "## Records" part for hashes and paths; a row shows only what comes before it. */
const beforeRecords = (s: string) => s.split(/\n#{2,3}[ \t]*Records[ \t]*(?:\n|$)/i)[0]!.trim();
const inShort = (k: { short_summary: string | null; description: string | null }) => k.short_summary || hubShortSummary(k.description);
const CO_STEP: Record<string, string> = {
  leftovers: 'Leftovers to review', handouts_missing: 'Handouts missing', handouts_complete: 'Choose the target and keys',
  prompt_expiring: 'Restore prompt not run yet',
};
/** The checkout step's action (checkout/step.ts) that belongs to each Needs you row kind. */
const CO_ACTION: Record<string, string> = { leftovers: 'Review the leftovers', handouts_complete: 'Choose the target and keys' };

/** A question's options as stored ([{key,label,effect}]), tolerant of a bad row. */
const qOptions = (raw: string): { key: string; label: string; effect: string | null }[] => {
  try {
    return (JSON.parse(raw) as { key?: unknown; label?: unknown; effect?: unknown }[]).filter((o) => o && typeof o.key === 'string' && typeof o.label === 'string')
      .map((o) => ({ key: o.key as string, label: o.label as string, effect: typeof o.effect === 'string' && o.effect ? o.effect : null }));
  } catch { return []; }
};

export class NeedsYou {
  constructor(private readonly db: Db, private readonly d: {
    routing: Routing; bpRouting: BpRouting; blueprint: Blueprint; teams: Teams; onboarding?: Onboarding; checkouts?: CheckoutNeeds;
    /** Task attachments: a team whose attachments near their limit (docs/specification.md, Tasks "Attachments"). */
    attachments?: TaskAttachments;
  }) {}

  private projectOf = new Map<string, string | null>();
  private teamProject(teamId: string | null): string | null {
    if (!teamId) return null;
    if (!this.projectOf.has(teamId)) this.projectOf.set(teamId, (this.db.prepare('SELECT project_id FROM teams WHERE id=?').get(teamId) as { project_id: string | null } | undefined)?.project_id ?? null);
    return this.projectOf.get(teamId)!;
  }
  private teamName(teamId: string | null): string {
    return teamId ? ((this.db.prepare('SELECT name FROM teams WHERE id=?').get(teamId) as { name: string } | undefined)?.name ?? 'A team') : 'No team';
  }
  /** Who blocked a task and when: the last move into blocked (task_events), named as the operator reads it. */
  private blockDetail(taskId: string, reason: string | null, assignee: string | null): NeedsDetail {
    const e = this.db.prepare("SELECT actor_kind, actor_id, created_at FROM task_events WHERE task_id=? AND to_status='blocked' ORDER BY id DESC LIMIT 1").get(taskId) as { actor_kind: string; actor_id: string | null; created_at: number } | undefined;
    const by = !e ? null : e.actor_kind === 'agent' ? this.agentName(e.actor_id) : e.actor_kind === 'admin' ? 'the operator' : 'the hub';
    return { kind: 'blocked', reason, blocked_by: by, blocked_at: e?.created_at ?? null, assignee: assignee ? this.agentName(assignee) : null };
  }
  /** A proposal's operations as Blueprint Review lists them: what each does, and to which kind of item (looked up when the op names none). */
  private propOps(proposalId: string, projectId: string): { op: string; kind: string | null }[] {
    const raw = (this.db.prepare('SELECT ops FROM bp_proposals WHERE id=?').get(proposalId) as { ops: string } | undefined)?.ops;
    let ops: { op?: string; kind?: string; key?: string }[] = [];
    try { ops = raw ? JSON.parse(raw) : []; } catch { ops = []; }
    const kindOf = this.db.prepare('SELECT kind FROM bp_items WHERE project_id=? AND key=? AND deleted_at IS NULL');
    return ops.slice(0, 500).map((o) => ({ op: String(o.op ?? 'upsert'), kind: o.kind ?? (o.key ? ((kindOf.get(projectId, o.key) as { kind: string } | undefined)?.kind ?? null) : null) }));
  }
  /** How a checkpoint's task reached approved: its last move into approved (task_events), so a later policy change can't reword it. */
  private checkpointReason(taskId: string): string {
    const e = this.db.prepare("SELECT tool, actor_id FROM task_events WHERE task_id=? AND to_status='approved' AND (from_status IS NULL OR from_status<>'approved') ORDER BY id DESC LIMIT 1").get(taskId) as { tool: string | null; actor_id: string | null } | undefined;
    if (e?.tool === 'no_review') return 'Submitted without review · waits for your approval';
    return e?.tool === 'task_review' ? `Approved by ${this.agentName(e.actor_id)} · waits for your approval` : 'Approved by review · waits for your approval';
  }
  private agentName(agentId: string | null): string {
    return agentId ? ((this.db.prepare('SELECT label FROM agents WHERE id=?').get(agentId) as { label: string | null } | undefined)?.label || 'An agent') : 'An agent';
  }

  /**
   * Every row that waits for this viewer, unfiltered and in order (oldest waiting first, then by id). `only` limits the
   * build to the source of one row id (its prefix, such as "task" or "proposal"), so checking one row before an action
   * reads one queue instead of all of them.
   */
  async rows(v: Viewer, only?: string): Promise<NeedsRow[]> {
    this.projectOf.clear();
    // A row's id prefix names its source, except a delivery row (delivery:<task>), which is built with the task rows.
    const want = (src: string) => !only || only === src || (only === 'delivery' && src === 'task');
    const out: NeedsRow[] = [];
    const scope = (team_id: string | null) => ({ project_id: this.teamProject(team_id), team_id });
    // Routing per team, read once: a member's teams, or for the admin the teams with no active decider.
    const mine = new Set(v.isAdmin ? [] : this.d.routing.decidesFor(v.id));
    const active = new Map<string, boolean>();
    const adminDecides = (t: string | null) => !t || !(active.get(t) ?? active.set(t, this.d.routing.activeDeciders(t).length > 0).get(t)!);
    const routedHere = (t: string | null) => (v.isAdmin ? adminDecides(t) : !!t && mine.has(t));

    // Questions for this decider (open), and relayed answers waiting to be confirmed; a question waiting for the agent's
    // reply (needs_info) is the agent's, not the viewer's.
    type Q = { id: string; team_id: string; agent_id: string; question: string; status: string; relay_state: string | null; escalated_at: number | null; created_at: number; updated_at: number; relayed_at: number | null;
      context: string | null; options: string; recommended: string | null; refs: string; task_id: string | null; task_title: string | null };
    // A requirement marked unclear is one team question (docs/blueprint.md §2.7): the ask's row is the item's, and answering it clears the mark.
    const unclearOf = new Map<string, Un & { unclear_ask: string }>();
    for (const x of this.db.prepare("SELECT project_id, key, title, body, rev, fields, json_extract(fields,'$.unclear_ask') AS unclear_ask FROM bp_items WHERE kind IN ('fr','nfr') AND deleted_at IS NULL AND json_extract(fields,'$.unclear')=1 AND json_extract(fields,'$.unclear_ask') IS NOT NULL").all() as (Un & { unclear_ask: string })[]) unclearOf.set(x.unclear_ask, x);
    if (want('question')) for (const q of this.db.prepare("SELECT d.id, d.team_id, d.agent_id, d.question, d.status, d.relay_state, d.escalated_at, d.created_at, d.updated_at, d.relayed_at, d.context, d.options, d.recommended, d.refs, d.task_id, k.title AS task_title FROM decisions d LEFT JOIN tasks k ON k.id=d.task_id WHERE d.status='open' OR d.relay_state='pending'").all() as Q[]) {
      if (!(routedHere(q.team_id) || (v.isAdmin && q.escalated_at !== null))) continue;
      const relay = q.relay_state === 'pending';
      const un = !relay ? unclearOf.get(q.id) : undefined;
      if (un) {
        out.push({
          id: `question:${q.id}`, kind: 'unclear', source: { kind: 'decision', id: q.id, version: String(q.updated_at) }, scope: { project_id: un.project_id, team_id: q.team_id },
          title: `${un.key} · ${un.title}`, reason: `${this.agentName(q.agent_id)} asks what is unclear${this.teamName(q.team_id) === 'A team' ? '' : ` for ${this.teamName(q.team_id)}`}`,
          open: { kind: 'item', id: un.key, project_id: un.project_id, team_id: q.team_id },
          actions: [{ id: 'clarify', label: 'Clarify', path: `/api/decisions/${enc(q.id)}/answer`, input: true }],
          at: q.created_at, by: this.agentName(q.agent_id), summary: q.question,
          ask: { id: q.id, question: q.question, team_id: q.team_id, team_label: this.teamName(q.team_id), asked_at: q.created_at, version: String(q.updated_at) },
          item: itemOf(un),
        });
        continue;
      }
      // A question that names a design (a decision item) is one row, "Design to decide", in place of its ordinary question row (docs/decisions.md, Designs).
      const des = this.d.blueprint?.designOf(q.team_id, JSON.parse(q.refs) as string[]);
      if (des && ['proposed', 'accepted', 'rejected'].includes(des.item.status ?? '')) {
        const rv = (des.item.fields['review'] && typeof des.item.fields['review'] === 'object' ? des.item.fields['review'] : null) as { verdict?: string; changes?: unknown } | null;
        const n = Array.isArray(rv?.changes) ? (rv!.changes as unknown[]).length : 0;
        out.push({
          id: `question:${q.id}`, kind: 'design', source: { kind: 'decision', id: q.id, version: String(q.updated_at) }, scope: scope(q.team_id),
          title: `Design to decide · ${des.item.title}`, reason: relay ? `${this.agentName(q.agent_id)} relayed an answer · confirm or overturn it` : `${this.agentName(q.agent_id)} asks${this.teamName(q.team_id) === 'A team' ? '' : ` for ${this.teamName(q.team_id)}`}`,
          open: { kind: 'design', id: q.id, team_id: q.team_id },
          actions: relay ? [{ id: 'confirm', label: 'Confirm', path: `/api/decisions/${enc(q.id)}/confirm`, tone: 'ok' }, { id: 'overturn', label: 'Overturn', path: `/api/decisions/${enc(q.id)}/overturn`, input: true }]
            : [{ id: 'answer', label: 'Decide', path: `/api/decisions/${enc(q.id)}/answer`, input: true }],
          at: relay ? (q.relayed_at ?? q.updated_at) : q.created_at, by: this.agentName(q.agent_id), summary: q.question,
          detail: { kind: 'question', context: null, options: qOptions(q.options), recommended: q.recommended, blocks: q.task_id ? { id: q.task_id, title: q.task_title ?? q.task_id } : null, asked_by: this.agentName(q.agent_id) },
          design: { key: des.item.key, review: rv ? (des.stale ? 'out of date' : rv.verdict === 'approved' ? 'approved' : `${n} change${n === 1 ? '' : 's'}`) : null },
        });
        continue;
      }
      out.push({
        id: `question:${q.id}`, kind: relay ? 'relayed_answer' : 'question', source: { kind: 'decision', id: q.id, version: String(q.updated_at) }, scope: scope(q.team_id),
        title: q.question, reason: relay ? `${this.agentName(q.agent_id)} relayed an answer · confirm or overturn it` : `${this.agentName(q.agent_id)} asks ${this.teamName(q.team_id) === 'A team' ? '' : `for ${this.teamName(q.team_id)}`}`.trim(),
        open: { kind: 'question', id: q.id, team_id: q.team_id },
        actions: relay ? [{ id: 'confirm', label: 'Confirm', path: `/api/decisions/${enc(q.id)}/confirm`, tone: 'ok' }, { id: 'overturn', label: 'Overturn', path: `/api/decisions/${enc(q.id)}/overturn`, input: true }]
          : [{ id: 'answer', label: 'Answer', path: `/api/decisions/${enc(q.id)}/answer`, input: true }],
        at: relay ? (q.relayed_at ?? q.updated_at) : q.created_at,
        by: this.agentName(q.agent_id), summary: q.context || null,
        detail: { kind: 'question', context: q.context, options: qOptions(q.options), recommended: q.recommended, blocks: q.task_id ? { id: q.task_id, title: q.task_title ?? q.task_id } : null, asked_by: this.agentName(q.agent_id) },
      });
    }

    // Access requests inside this viewer's ceiling (a member), or that routing leaves to the admin.
    const within = (r: { team_id: string | null; actions: string[]; resource: string; requested_duration_s: number | null }) => this.d.routing.withinCeiling(r);
    type R = { id: string; agent_id: string; team_id: string | null; actions: string; resource: string; requested_duration_s: number | null; created_at: number };
    if (want('request')) for (const r of (this.db.prepare("SELECT id, agent_id, team_id, actions, resource, requested_duration_s, created_at FROM access_requests WHERE status='pending'").all() as R[]).map((x) => ({ ...x, actions: JSON.parse(x.actions) as string[] }))) {
      const ok = v.isAdmin ? adminDecides(r.team_id) || !within(r) : !!r.team_id && mine.has(r.team_id) && within(r);
      if (!ok) continue;
      out.push({
        id: `request:${r.id}`, kind: 'access_request', source: { kind: 'access_request', id: r.id, version: 'pending' }, scope: scope(r.team_id),
        title: `${this.agentName(r.agent_id)} asks to ${r.actions.join(', ')}`, reason: `Access request on ${r.resource}`, by: this.agentName(r.agent_id), summary: `On ${r.resource}`, open: { kind: 'request', id: r.id, team_id: r.team_id },
        actions: [{ id: 'approve', label: 'Approve', path: `/api/requests/${enc(r.id)}/approve`, tone: 'ok' }, { id: 'deny', label: 'Deny', path: `/api/requests/${enc(r.id)}/deny`, tone: 'bad' }], at: r.created_at,
      });
    }

    // Human checkpoints (approved and waiting for the decider's approval) and eligible unblocks (not held by a question).
    type T = { id: string; team_id: string; title: string; status: string; version: number; updated_at: number; blocked_reason: string | null; assignee_agent_id: string | null; short_summary: string | null; description: string | null };
    if (want('task')) for (const k of this.db.prepare("SELECT id, team_id, title, status, version, updated_at, blocked_reason, assignee_agent_id, short_summary, description FROM tasks WHERE (status='approved' AND approval_requested=1) OR (status='blocked' AND blocked_by_decision IS NULL)").all() as T[]) {
      if (!routedHere(k.team_id)) continue;
      const base = `/api/teams/${enc(k.team_id)}/tasks/${enc(k.id)}`, blocked = k.status === 'blocked';
      const bd = blocked ? this.blockDetail(k.id, k.blocked_reason, k.assignee_agent_id) : null;
      out.push({
        id: `task:${k.id}`, kind: blocked ? 'unblock' : 'checkpoint', source: { kind: 'task', id: k.id, version: String(k.version) }, scope: scope(k.team_id),
        title: k.title, reason: blocked ? `Blocked${k.blocked_reason ? ': ' + beforeRecords(k.blocked_reason) : ''}` : this.checkpointReason(k.id),
        open: { kind: 'task', id: k.id, team_id: k.team_id },
        actions: blocked ? [{ id: 'unblock', label: 'Unblock', path: `${base}/unblock` }] : [{ id: 'approve', label: 'Approve', path: `${base}/approve`, tone: 'ok' }], at: k.updated_at,
        ...(bd ? { detail: bd } : {}),
        by: bd ? (bd as { blocked_by: string | null }).blocked_by : k.assignee_agent_id ? this.agentName(k.assignee_agent_id) : null,
        summary: (blocked && k.blocked_reason && beforeRecords(k.blocked_reason)) || inShort(k),
      });
    }

    // Blueprint proposals routed to this viewer. A re-plan is reviewed on its screen (its diff), never applied in one click.
    if (want('proposal')) for (const p of this.d.bpRouting.needsYou(v.id, v.isAdmin)) {
      const row = this.db.prepare('SELECT type, request_id FROM bp_proposals WHERE id=?').get(p.id) as { type: string; request_id: number | null } | undefined;
      const replan = row?.type === 'replan', refine = row?.request_id != null;
      out.push({
        id: `proposal:${p.id}`, kind: 'proposal', source: { kind: 'bp_proposal', id: p.id, version: 'open' }, scope: { project_id: p.project_id, team_id: p.route },
        title: refine ? `Refined requirements, ${p.ops} change${p.ops === 1 ? '' : 's'}` : p.reason || (replan ? 'Start over submitted' : `Blueprint change, ${p.ops} edit${p.ops === 1 ? '' : 's'}`), reason: refine ? `Proposed by ${this.agentName(p.agent_id)} for your refine request` : `Blueprint ${replan ? 'start over' : 'change'} by ${this.agentName(p.agent_id)}`,
        open: { kind: 'proposal', id: p.id, team_id: p.route, project_id: p.project_id },
        actions: replan || refine ? [{ id: 'review', label: 'Review', path: `/api/proposals/${enc(p.id)}/apply`, input: true }, refine ? { id: 'send_back', label: 'Send back', path: `/api/proposals/${enc(p.id)}/reject`, input: true } : { id: 'reject', label: 'Reject', path: `/api/proposals/${enc(p.id)}/reject`, tone: 'bad' }]
          : [{ id: 'apply', label: 'Apply', path: `/api/proposals/${enc(p.id)}/apply`, tone: 'ok' }, { id: 'reject', label: 'Reject', path: `/api/proposals/${enc(p.id)}/reject`, tone: 'bad' }],
        at: p.created_at, detail: { kind: 'proposal', ops: this.propOps(p.id, p.project_id) }, by: this.agentName(p.agent_id), summary: null,
      });
    }
    if (v.isAdmin) await this.adminRows(out, scope, want);
    return out.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  }

  /**
   * One delivery model (migration 0153): nothing returns to open by itself, so the operator sees what waits on an agent that
   * has not reached it (not delivered and not seen, past the team's pickup_minutes) and started work past its check-in time
   * (flagged overdue, still held). Each row says where delivery stands and offers Reassign (POST …/reassign, a sheet in the
   * console). Running teams only: a paused team's work waits by design.
   */
  private deliveryRows(out: NeedsRow[], scope: (t: string | null) => { project_id: string | null; team_id: string | null }) {
    type W = { id: string; team_id: string; title: string; version: number; status: string; overdue_at: number | null; holder: string; phase: string;
      opened_at: number; seen_at: number | null; delivered_at: number | null; delivery_reason: string | null; pickup: number };
    const now = Date.now();
    const rows = this.db.prepare(`SELECT k.id, k.team_id, k.title, k.version, k.status, k.overdue_at, u.holder_agent_id AS holder, u.phase, u.opened_at,
        u.seen_at, u.delivered_at, u.delivery_reason, t.pickup_minutes AS pickup
      FROM task_turns u JOIN tasks k ON k.id=u.task_id JOIN teams t ON t.id=u.team_id
      WHERE u.closed_at IS NULL AND t.status='running'
        AND ((k.status='in_progress' AND k.overdue_at IS NOT NULL)
          OR (u.seen_at IS NULL AND u.delivered_at IS NULL AND u.opened_at + t.pickup_minutes*60000 < ?))`).all(now) as unknown as W[];
    for (const k of rows) {
      const overdue = k.status === 'in_progress' && k.overdue_at !== null, who = this.agentName(k.holder);
      const why = k.delivered_at || k.seen_at ? null : deliveryWhy(this.db, k.holder, k.id, now);
      const state = k.delivered_at ? 'Delivered' : why ? deliveryLine(why, k.delivery_reason) : null;
      const doing = k.phase === 'review' ? 'review' : 'work on';
      const base = `/api/teams/${enc(k.team_id)}/tasks/${enc(k.id)}`, canRe = REASSIGN_FROM.includes(k.status);
      out.push({
        id: `delivery:${k.id}`, kind: overdue ? 'overdue' : 'undelivered',
        source: { kind: 'task', id: k.id, version: `${k.version}:${k.opened_at}:${k.delivered_at ?? ''}:${k.delivery_reason ?? ''}` }, scope: scope(k.team_id),
        title: k.title,
        reason: overdue ? `Past its check-in time · ${who} still holds it` : `${state} · waiting for ${who} to ${doing} it`,
        open: { kind: 'task', id: k.id, team_id: k.team_id },
        actions: canRe ? [{ id: 'reassign', label: 'Reassign', path: `${base}/reassign`, input: true }] : [],
        at: overdue ? k.overdue_at! : k.opened_at + k.pickup * 60000,
        by: who, offline_since: why && !why.waiting_behind ? why.pc_offline_since : null,
        summary: overdue ? `${who} has not checked in on it${state ? ` · ${state.charAt(0).toLowerCase()}${state.slice(1)}` : ''}. It stays with them until you reassign it.`
          : `${state}. It stays with ${who} until it reaches them or you reassign it.`,
      });
    }
  }

  /** The admin's own queues: the active backlog, onboarding, checkout steps, teams paused by the operator or a limit, directives, feedback, vault conflicts and unclear requirements. */
  private async adminRows(out: NeedsRow[], scope: (t: string | null) => { project_id: string | null; team_id: string | null }, want: (src: string) => boolean) {
    if (want('task')) this.deliveryRows(out, scope);
    type B = { id: string; team_id: string; title: string; version: number; created_at: number; short_summary: string | null; description: string | null; created_by_agent: string | null };
    if (want('backlog')) for (const k of this.db.prepare("SELECT id, team_id, title, version, created_at, short_summary, description, created_by_agent FROM tasks WHERE status='backlog' AND postponed_at IS NULL").all() as B[]) {
      const base = `/api/teams/${enc(k.team_id)}/tasks/${enc(k.id)}`;
      out.push({ id: `backlog:${k.id}`, kind: 'backlog', source: { kind: 'task', id: k.id, version: String(k.version) }, scope: scope(k.team_id), title: k.title,
        reason: `Proposed by ${this.teamName(k.team_id)} · accept or discard`, open: { kind: 'task', id: k.id, team_id: k.team_id },
        by: k.created_by_agent ? this.agentName(k.created_by_agent) : null, summary: inShort(k),
        actions: [{ id: 'accept', label: 'Accept', path: `${base}/accept`, tone: 'ok' }, { id: 'discard', label: 'Discard', path: `${base}/discard`, tone: 'bad' }], at: k.created_at });
    }
    if (want('onboarding')) for (const q of (this.d.onboarding?.list('submitted') ?? []).filter((x) => x.kind !== 'checkout')) {
      out.push({ id: `onboarding:${q.id}`, kind: 'onboarding', source: { kind: 'onboarding_request', id: q.id, version: String(q.version) }, scope: scope(q.team_id ?? null),
        title: `${q.kind === 'vault_agent' ? 'Vault agent' : 'Team'} request from ${q.pc?.name ?? 'a PC'}`, // 2c-2's wording (docs/onboarding.md#a-vault-agent)
        reason: q.kind === 'vault_agent' ? 'One agent for shared folders, no team' : `${q.kind === 'new_team' ? 'A new team' : 'More agents'}, ${q.agents} agent${q.agents === 1 ? '' : 's'}`,
        open: { kind: 'onboarding', id: q.id },
        actions: [{ id: 'approve', label: 'Approve', path: `/api/onboarding/${enc(q.id)}/approve`, input: true }, { id: 'deny', label: 'Deny', path: `/api/onboarding/${enc(q.id)}/deny`, tone: 'bad' }], at: q.waiting_since ?? q.filed_at });
    }
    // "Paired just now" (docs/onboarding.md#paired-just-now): a connector redeemed a PC's code. It stays until the operator
    // says it was them, or revokes the pairing, which also cancels the PC's requests and revokes the keys picked up with it.
    if (want('paired')) for (const x of this.d.onboarding?.newPairings() ?? []) {
      const pc = x.pc_name ?? 'a PC';
      out.push({ id: `paired:${x.id}`, kind: 'paired', source: { kind: 'connector_pairing', id: x.id, version: 'new' }, scope: { project_id: null, team_id: null },
        title: `${pc} paired just now`, reason: [`From ${x.source ?? 'an unknown address'}`, x.version ? `connector ${x.version}` : null, x.platform].filter(Boolean).join(' · '),
        open: { kind: 'pc', id: x.machine_id }, summary: `If this wasn't the PC you added, revoke it: its connector key, its open requests and any agent keys it picked up stop at once.`,
        actions: [{ id: 'keep', label: 'It was me', path: `/api/pairings/${enc(x.id)}/keep`, tone: 'ok' }, { id: 'revoke', label: 'Revoke', path: `/api/pairings/${enc(x.id)}/revoke`, tone: 'bad',
          confirm: "Revoke this PC's pairing? Its agents stop connecting.", done: `Pairing revoked for ${pc}` }], at: x.paired_at });
    }
    if (want('checkout')) for (const c of (await this.d.checkouts?.().catch(() => []) ?? [])) for (const x of c.needs_operator) {
      out.push({ id: `checkout:${c.id}:${x.kind}${x.agent_id ? ':' + x.agent_id : ''}`, kind: 'checkout', source: { kind: 'checkout', id: c.id, version: `${x.kind}:${x.count ?? ''}` }, scope: scope(c.team_id),
        title: CO_STEP[x.kind] ?? 'Checkout step', reason: `Checkout of ${c.team ?? 'a team'}`, open: { kind: 'checkout', id: c.id, team_id: c.team_id },
        // The checkout's own step sentence and its one action (checkout/step.ts), the same text the team page shows.
        ...(c.step ? { step: c.step.text, next: c.step.next } : {}),
        // The step's action names only the row it belongs to (leftovers, a ready checkout, a new PC); other rows read Review.
        actions: [{ id: 'review', label: c.step?.action && c.step.action === CO_ACTION[x.kind] ? c.step.action : 'Review', path: `/api/teams/${enc(c.team_id)}/checkout`, input: true }], at: x.at });
    }
    // A team paused by the operator or by a team limit waits for the operator to resume it (docs/dashboard-ux.md, Pause). A
    // coordinator's pause ends by itself and is For awareness; a checkout's pause is its checkout steps.
    type Pz = { id: string; name: string; paused_reason: string; paused_until: number | null; paused_note: string | null; paused_at: number | null; updated_at: number };
    if (want('pause')) for (const t of this.db.prepare("SELECT id, name, paused_reason, paused_until, paused_note, paused_at, updated_at FROM teams WHERE status='paused' AND paused_reason IS NOT NULL AND paused_reason<>'coordinator' AND paused_reason NOT LIKE 'checkout:%'").all() as Pz[]) {
      out.push({ id: `pause:${t.id}`, kind: 'team_pause', source: { kind: 'team', id: t.id, version: `${t.paused_at ?? t.updated_at}:${t.paused_until ?? ''}` }, scope: scope(t.id),
        title: `${t.name} is paused`, reason: pauseLabel(t), open: { kind: 'team', id: t.id, team_id: t.id },
        actions: [{ id: 'resume', label: 'Resume', path: `/api/teams/${enc(t.id)}/resume`, tone: 'ok' }], at: t.paused_at ?? t.updated_at, until: t.paused_until });
    }
    // A team's attachments at 80 % of their limit wait for the operator to raise it (team settings) or remove old ones.
    if (want('attachments') && this.d.attachments) for (const x of this.d.attachments.nearFull()) {
      const gb = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.ceil(n / 1024 ** 2)} MB`);
      out.push({ id: `attachments:${x.team.id}`, kind: 'attachments_full', source: { kind: 'team', id: x.team.id, version: `${x.used >= x.limit ? 'full' : 'near'}:${x.limit}` }, scope: scope(x.team.id),
        title: `${x.team.name}'s attachments use ${gb(x.used)} of ${gb(x.limit)}`,
        reason: x.used >= x.limit ? 'New attachments are refused · raise the limit or remove old ones' : 'Near the team\'s limit · raise it or remove old ones',
        open: { kind: 'team', id: x.team.id, team_id: x.team.id },
        actions: [{ id: 'raise', label: 'Raise the limit', path: `/api/teams/${enc(x.team.id)}`, input: true }], at: Date.now() });
    }
    // A team's setup whose next step is the operator's (docs/onboarding.md#setup-progress): Source not asked, Waiting for
    // you, or Returned to the operator. A proposal in review is already the proposal's row. The version is the setup's
    // state, so the row leaves by itself when the state changes; opening it opens the setup details on the team page.
    if (want('setup') && this.d.onboarding) for (const t of this.db.prepare("SELECT id, name FROM teams WHERE status<>'stopped'").all() as { id: string; name: string }[]) {
      const s = this.d.onboarding.setupOfTeam(t.id);
      if (!s || !(s.state === 'not_asked' || s.state === 'operator_supplies' || (s.state === 'returned' && s.responsible === 'operator'))) continue;
      const at = (this.db.prepare('SELECT COALESCE(decided_at, updated_at) AS at FROM onboarding_requests WHERE id=?').get(s.request_id) as { at: number } | undefined)?.at ?? 0;
      out.push({ id: `setup:${t.id}`, kind: 'setup', source: { kind: 'onboarding_request', id: s.request_id, version: `${s.state}:${s.proposal?.id ?? ''}` }, scope: scope(t.id),
        title: `Setup: ${s.next.replace(/\.$/, '')}`, reason: `${t.name} · the setup waits for you`, open: { kind: 'setup', id: s.request_id, team_id: t.id }, summary: null, actions: [], at });
    }
    type Dr = { id: string; title: string; version: number; created_at: number };
    if (want('directive')) for (const x of this.db.prepare("SELECT id, title, version, created_at FROM directives WHERE status='active' AND reviewed_at IS NULL").all() as Dr[]) {
      out.push({ id: `directive:${x.id}`, kind: 'directive', source: { kind: 'directive', id: x.id, version: String(x.version) }, scope: { project_id: null, team_id: null },
        title: x.title, reason: 'A rule an agent registered is in force · keep it or edit it', open: { kind: 'directive', id: x.id }, summary: 'An agent registered this rule and it is in force.',
        actions: [{ id: 'review', label: 'Keep', path: `/api/directives/${enc(x.id)}/review`, tone: 'ok' }], at: x.created_at });
    }
    type Rp = { id: string; agent_id: string; title: string; team_id: string | null; created_at: number };
    if (want('suggestion')) for (const x of this.db.prepare("SELECT id, agent_id, title, team_id, created_at FROM directive_reports WHERE status='open'").all() as Rp[]) {
      out.push({ id: `suggestion:${x.id}`, kind: 'directive_suggestion', source: { kind: 'directive_report', id: x.id, version: 'open' }, scope: scope(x.team_id),
        title: x.title, reason: `${this.agentName(x.agent_id)} follows this rule · adopt or retire it`, open: { kind: 'directive_report', id: x.id }, by: this.agentName(x.agent_id), summary: null,
        actions: [{ id: 'adopt', label: 'Adopt', path: `/api/directive-reports/${enc(x.id)}/adopt`, tone: 'ok' }, { id: 'retire', label: 'Retire', path: `/api/directive-reports/${enc(x.id)}/retire` }], at: x.created_at });
    }
    type Fb = { id: string; title: string; severity: string; status_rev: number; created_at: number };
    if (want('feedback')) for (const x of this.db.prepare("SELECT id, title, severity, status_rev, created_at FROM feedback_reports WHERE status='new'").all() as Fb[]) {
      out.push({ id: `feedback:${x.id}`, kind: 'feedback', source: { kind: 'feedback', id: x.id, version: String(x.status_rev) }, scope: { project_id: null, team_id: null },
        title: x.title, reason: `New ${x.severity} feedback · accept it or decide otherwise`, open: { kind: 'feedback', id: x.id }, summary: null,
        actions: [{ id: 'accept', label: 'Accept', path: `/api/feedback/${enc(x.id)}/status`, body: { status: 'accepted' }, tone: 'ok' }, { id: 'triage', label: 'Triage', path: `/api/feedback/${enc(x.id)}/status`, input: true }], at: x.created_at });
    }
    type Cf = { id: string; path: string | null; created_at: number };
    if (want('conflict')) for (const x of this.db.prepare("SELECT c.id, f.path, c.created_at FROM file_conflicts c LEFT JOIN files f ON f.id=c.file_id WHERE c.status='open'").all() as Cf[]) {
      out.push({ id: `conflict:${x.id}`, kind: 'vault_conflict', source: { kind: 'file_conflict', id: x.id, version: 'open' }, scope: { project_id: null, team_id: null },
        title: x.path ?? 'A vault file', reason: 'Choose the version to keep', open: { kind: 'conflict', id: x.id }, summary: null,
        actions: [{ id: 'resolve', label: 'Choose', path: `/api/vault/conflicts/${enc(x.id)}/resolve`, input: true }], at: x.created_at });
    }
    // A legacy unclear requirement (marked with no question): the admin asks the team, or edits or drops it with the usual admin writes.
    type U = { project_id: string; key: string; title: string; body: string | null; fields: string; team_id: string | null; rev: number; updated_at: number; unclear_ask: string | null };
    // An ask still waiting (open, needs more information, or answered by a relay the operator has not settled) keeps the item's row; once settled it is answered, or declined.
    const openAsk = this.db.prepare("SELECT 1 FROM decisions WHERE id=? AND (status IN ('open','needs_info') OR relay_state='pending')");
    const declined = this.db.prepare("SELECT 1 FROM decisions WHERE id=? AND status='declined'");
    if (want('unclear')) for (const x of this.db.prepare("SELECT project_id, key, title, body, fields, team_id, rev, updated_at, json_extract(fields,'$.unclear_ask') AS unclear_ask FROM bp_items WHERE kind IN ('fr','nfr') AND deleted_at IS NULL AND archived=0 AND COALESCE(status,'') <> 'dropped' AND json_extract(fields,'$.unclear')=1").all() as U[]) {
      if (x.unclear_ask && openAsk.get(x.unclear_ask)) continue; // its ask's row stands for it (above)
      out.push({ id: `unclear:${x.project_id}:${x.key}`, kind: 'unclear', source: { kind: 'bp_item', id: `${x.project_id}:${x.key}`, version: String(x.rev) }, scope: { project_id: x.project_id, team_id: x.team_id },
        title: `${x.key} · ${x.title}`, reason: x.unclear_ask && declined.get(x.unclear_ask) ? 'Marked unclear · its question was declined' : 'Marked unclear · no question was asked', open: { kind: 'item', id: x.key, project_id: x.project_id, team_id: x.team_id }, summary: null,
        actions: [{ id: 'ask_team', label: "Ask the team what's unclear", path: `/api/projects/${enc(x.project_id)}/items/${enc(x.key)}/ask-unclear` }], at: x.updated_at, item: itemOf(x) });
    }
  }

  /**
   * The rows one entrance shows: filtered, counted, then paged. `cursor` is the offset the previous page ended at.
   * `projects` counts the filtered rows per project before paging, so a project's count is exact past the first page.
   */
  async list(v: Viewer, f: NeedsFilter = {}, page: { cursor?: string; limit?: number } = {}, now = Date.now()) {
    const { live: all, later } = this.split(v, filtered(await this.rows(v), f), now);
    const from = page.cursor ? Math.max(0, Number(page.cursor) || 0) : 0, limit = Math.min(page.limit ?? NEEDS_PAGE, NEEDS_PAGE_MAX);
    const items = all.slice(from, from + limit), projects: Record<string, number> = {};
    for (const r of all) if (r.scope.project_id) projects[r.scope.project_id] = (projects[r.scope.project_id] ?? 0) + 1;
    return { items, total: all.length, projects, next_cursor: from + limit < all.length ? String(from + limit) : null,
      later: { items: later.sort((a, b) => a.later.until - b.later.until || a.id.localeCompare(b.id)), total: later.length }, filter: { team: f.team ?? null, project: f.project ?? null, review: !!f.review } };
  }
  /** How many rows wait for this viewer at one entrance (after an action: the entrance it was taken from). */
  async total(v: Viewer, f: NeedsFilter = {}, now = Date.now()): Promise<number> { return this.split(v, filtered(await this.rows(v), f), now).live.length; }

  /**
   * This viewer's rows split by Later: the ones set aside now (same version, before their end), and the rest, where a row
   * whose Later ended or whose version changed is marked back_from_later until the viewer sets it aside again or it leaves.
   */
  private split(v: Viewer, rows: NeedsRow[], now: number): { live: NeedsRow[]; later: LaterRow[] } {
    type L = { record: string; episode: string; until: number | null; dismissed_at: number };
    const set = new Map((this.db.prepare("SELECT record, episode, until, dismissed_at FROM attention_dismissals WHERE user_id=? AND kind='later'").all(v.id) as L[]).map((x) => [x.record, x]));
    const live: NeedsRow[] = [], later: LaterRow[] = [];
    for (const r of rows) {
      const e = set.get(r.id);
      if (!e) { live.push(r); continue; }
      const until = Math.min(e.until ?? Infinity, e.dismissed_at + LATER_MAX_MS);
      if (e.episode === r.source.version && until > now) later.push({ ...r, later: { until, changes: e.until === null, at: e.dismissed_at } });
      else live.push({ ...r, back_from_later: true });
    }
    return { live, later };
  }

  /**
   * Set one Needs you row aside for this viewer (Later): until `until` (epoch ms), or until its version changes when
   * `until` is null, and at most LATER_MAX_MS either way. Only a row that waits for them now, at the version they saw.
   * Setting it aside again replaces the earlier choice. Returns when it ends.
   */
  async later(v: Viewer, id: string, version: string, until: number | null, now = Date.now()): Promise<{ until: number; changes: boolean }> {
    if (this.awareness(v, {}, now).items.some((r) => r.record === id)) throw new KeyError('invalid_argument', 'For awareness rows are dismissed, not set aside with Later.');
    const row = (await this.rows(v, id.slice(0, id.indexOf(':')))).find((r) => r.id === id);
    if (!row) throw new KeyError('not_found', 'Nothing to set aside: this no longer waits for you.');
    if (row.source.version !== version) throw new KeyError('conflict', 'This changed since you opened it. The list is refreshed.');
    if (until !== null && until <= now) throw new KeyError('invalid_argument', 'Choose a time in the future.');
    if (until !== null && until > now + LATER_MAX_MS + LATER_SLACK_MS) throw new KeyError('invalid_argument', 'Later lasts at most 7 days.');
    const end = until === null ? null : Math.min(until, now + LATER_MAX_MS);
    tx(this.db, () => {
      // Entries long past their week are of no use any more (the row came back, or left), so they go here.
      this.db.prepare("DELETE FROM attention_dismissals WHERE user_id=? AND kind='later' AND (record=? OR dismissed_at<?)").run(v.id, id, now - 2 * LATER_MAX_MS);
      this.db.prepare("INSERT INTO attention_dismissals(user_id, record, episode, dismissed_at, kind, until) VALUES (?,?,?,?,'later',?)").run(v.id, id, version, now, end);
    });
    return { until: end ?? now + LATER_MAX_MS, changes: end === null };
  }

  /** Bring back now: end this viewer's Later on one row; it is listed again at once, without the "Back from Later" mark. */
  bringBack(v: Viewer, id: string): void {
    if (!this.db.prepare("DELETE FROM attention_dismissals WHERE user_id=? AND record=? AND kind='later'").run(v.id, id).changes) throw new KeyError('not_found', 'This is not set aside for you.');
  }

  /**
   * Before a resolving action: the row must still wait for this viewer, at the version they saw, and the action must be
   * one of its one-click actions. Throws conflict (gone or changed) or invalid_argument; returns the row otherwise.
   * The source workflow then checks its own rights again when it runs.
   */
  async check(v: Viewer, id: string, version: string, action: string): Promise<{ row: NeedsRow; act: NeedsAction }> {
    const row = (await this.rows(v, id.slice(0, id.indexOf(':')))).find((r) => r.id === id);
    if (!row) throw new KeyError('conflict', 'This no longer waits for you: someone else resolved it, or it moved on.');
    if (row.source.version !== version) throw new KeyError('conflict', 'This changed since you opened it. The list is refreshed.');
    // A question's option answers it in one click (docs/dashboard-ux.md, Needs you screen); the note becomes the answer's text.
    const opt = row.kind === 'question' && action.startsWith('opt:') && row.detail?.kind === 'question' ? row.detail.options.find((o) => `opt:${o.key}` === action) : undefined;
    const act: NeedsAction | undefined = opt ? { id: action, label: opt.label, path: row.actions[0]!.path, body: { option: opt.key }, noteAs: 'text' } : row.actions.find((a) => a.id === action);
    if (!act) throw new KeyError('invalid_argument', `"${action}" is not an action of this row.`);
    if (act.input) throw new KeyError('invalid_argument', `"${act.label}" needs its own screen.`);
    return { row, act };
  }

  // ───── For awareness ─────

  /** For awareness rows this viewer may see, without the ones they dismissed for the current episode. */
  awareness(v: Viewer, f: NeedsFilter = {}, now = Date.now()): { items: AwareRow[]; total: number } {
    const out: AwareRow[] = [];
    // Stalled members, only in teams that switched stall warnings on.
    for (const t of this.db.prepare("SELECT * FROM teams WHERE stall_warnings=1 AND status='running'").all() as unknown as (TeamRow & { project_id: string | null })[]) {
      if (!v.isAdmin && !(t.project_id && v.can(t.project_id, 'tasks'))) continue;
      for (const m of this.d.teams.members(t.id) as MemberRow[]) {
        if (!this.d.teams.stalled(t, m, now)) continue;
        const last = this.d.teams.lastActivity(m);
        out.push({ id: `stalled:${t.id}:${m.agent_id}`, kind: 'stalled', record: `member:${t.id}:${m.agent_id}`, episode: String(last), scope: { project_id: t.project_id, team_id: t.id },
          title: `${this.agentName(m.agent_id)} is stalled`, reason: `${t.name} · no news since ${new Date(last).toISOString().slice(0, 16).replace('T', ' ')} UTC`, open: { kind: 'agent', id: m.agent_id, team_id: t.id }, at: last });
      }
    }
    // A team its coordinator paused until a set time: it resumes by itself, so it asks nobody (docs/dashboard-ux.md, Pause).
    type Pz = { id: string; name: string; project_id: string | null; paused_reason: string; paused_until: number | null; paused_note: string | null; paused_at: number | null; updated_at: number };
    for (const t of this.db.prepare("SELECT id, name, project_id, paused_reason, paused_until, paused_note, paused_at, updated_at FROM teams WHERE status='paused' AND paused_reason='coordinator'").all() as Pz[]) {
      if (!v.isAdmin && !(t.project_id && v.can(t.project_id, 'tasks'))) continue;
      const at = t.paused_at ?? t.updated_at;
      out.push({ id: `paused:${t.id}`, kind: 'team_paused', record: `team:${t.id}`, episode: String(at), scope: { project_id: t.project_id, team_id: t.id },
        title: `${t.name} is paused`, reason: pauseLabel(t), open: { kind: 'team', id: t.id, team_id: t.id }, at, until: t.paused_until });
    }
    // Missed milestones, only in projects that switched them on.
    type M = { project_id: string; key: string; title: string; team_id: string | null; status: string; fields: string; updated_at: number };
    for (const x of this.db.prepare("SELECT i.project_id, i.key, i.title, i.team_id, i.status, i.fields, i.updated_at FROM bp_items i JOIN projects p ON p.id=i.project_id WHERE p.missed_warnings=1 AND i.kind='milestone' AND i.status='missed' AND i.deleted_at IS NULL AND i.archived=0").all() as M[]) {
      if (!v.isAdmin && !v.can(x.project_id, 'blueprint')) continue;
      const due = (JSON.parse(x.fields) as { target_at?: number }).target_at ?? null;
      // The missed state of the one late-milestone function the section 2 summary's At risk list also reads (kinds.ts).
      if (milestoneLate({ status: x.status, target_at: due }, now)?.state !== 'missed') continue;
      out.push({ id: `missed:${x.project_id}:${x.key}`, kind: 'missed_milestone', record: `milestone:${x.project_id}:${x.key}`, episode: `missed:${due ?? ''}`, scope: { project_id: x.project_id, team_id: x.team_id },
        title: `${x.key} missed`, reason: x.title, open: { kind: 'item', id: x.key, project_id: x.project_id, team_id: x.team_id }, at: x.updated_at });
    }
    // Claims not supported, in projects this viewer may read. The episode is the support level and the claim's last
    // change: linking, unlinking or removing evidence, or a change to its status or result, changes the claim (with a
    // revision), and a change of the evidence's wording does not. So it only moves forward: a claim that goes weak, then
    // unsupported, then weak again is a new episode, and an earlier dismissal no longer hides it.
    for (const p of this.db.prepare('SELECT id FROM projects').all() as { id: string }[]) {
      if (!v.isAdmin && !v.can(p.id, 'blueprint')) continue;
      for (const c of this.d.blueprint.claimStates(p.id)) {
        if (c.status === 'cut' || c.support === 'supported') continue;
        out.push({ id: `claim:${p.id}:${c.key}`, kind: 'claim_not_supported', record: `claim:${p.id}:${c.key}`, episode: `${c.support}:${c.updated_at}`, scope: { project_id: p.id, team_id: c.team_id },
          title: `${c.key} is ${c.support === 'contradicted' ? 'contradicted' : c.support === 'weak' ? 'weakly supported' : 'not supported'}`, reason: c.title, open: { kind: 'item', id: c.key, project_id: p.id, team_id: c.team_id }, at: c.updated_at });
      }
    }
    // A refine request the coordinator has not answered yet: awareness only, the coordinator's proposal is what needs the operator.
    for (const r of this.db.prepare("SELECT r.id, r.requested_at, r.team_id, t.project_id, t.name FROM bp_report_requests r JOIN teams t ON t.id=r.team_id WHERE r.kind='plan' AND r.scope_keys IS NOT NULL AND r.answered_at IS NULL AND r.proposal_id IS NULL").all() as { id: number; requested_at: number; team_id: string; project_id: string | null; name: string }[]) {
      if (!v.isAdmin && !(r.project_id && v.can(r.project_id, 'blueprint'))) continue;
      out.push({ id: `refine:${r.id}`, kind: 'refine_waiting', record: `refine:${r.id}`, episode: String(r.requested_at), scope: { project_id: r.project_id, team_id: r.team_id },
        title: 'Refining requirements · waiting for the coordinator', reason: `The coordinator of ${r.name}`, open: { kind: 'team', id: r.team_id, team_id: r.team_id }, at: r.requested_at });
    }
    // Blocking work (docs/blueprint.md §6): one row per project and part whose open issues or questions block an open item.
    // Only blocking items come here, never every open question, and never Needs you: an outside answer is not the operator's
    // decision. The episode is the set of blockers, so a dismissed row comes back when a new item starts blocking.
    for (const p of this.db.prepare("SELECT id, name, kind FROM projects WHERE id IN (SELECT DISTINCT project_id FROM bp_links WHERE rel='blocks')").all() as { id: string; name: string; kind: string }[]) {
      if (!v.isAdmin && !v.can(p.id, 'blueprint')) continue;
      const all = this.d.blueprint.items(p.id), q = questions(all, all, this.d.blueprint.links(p.id), p.kind === 'research', 'open', now);
      const parts = new Map<string | null, typeof q.items>();
      // A project with one team is one part: its project-level blockers count with the team's, as on its card.
      const sole = this.d.blueprint.soleTeam(p.id), part = (r: { team_id: string | null }) => sole ?? r.team_id;
      for (const r of [...q.blocking, ...q.items.filter((i) => i.blocks.length)]) (parts.get(part(r)) ?? parts.set(part(r), []).get(part(r))!).push(r);
      for (const [tid, L] of parts) {
        L.sort((a, b) => a.since - b.since || a.key.localeCompare(b.key));
        const short = (t: string) => (t.length > 32 ? t.slice(0, 31).replace(/[\s,;:.]+$/, '') + '…' : t);
        const days = Math.floor((now - L[0]!.since) / 86_400_000);
        out.push({ id: `blocking:${p.id}:${tid ?? 'project'}`, kind: 'blocking_work', record: `blocking:${p.id}:${tid ?? 'project'}`, episode: L.map((r) => r.key).sort().join(','),
          scope: { project_id: p.id, team_id: tid }, title: `${L.length} ${L.length === 1 ? 'item blocks' : 'items block'} work in ${p.name}`,
          reason: [L.slice(0, 3).map((r) => `${r.key} ${short(r.title)}`).join(', ') + (L.length > 3 ? ` and ${L.length - 3} more` : ''), `oldest ${days} ${days === 1 ? 'day' : 'days'}`].join(' · '),
          open: { kind: 'questions', id: p.id, project_id: p.id, team_id: tid }, at: L[0]!.since });
      }
    }
    // Changes a team's rule applied without a proposal (docs/blueprint.md §4 Rules): one row per project and team, counting
    // the items changed since this viewer last dismissed it. The episode is the UTC day of the latest change, so a dismissed
    // row comes back only for a change on a later day: at most once a day. Only the last RULES_AWARE_DAYS count, so the
    // read stays small however long a rule has been on.
    type Ru = { project_id: string; team_id: string; team: string | null; rule: string; keys: number; created_at: number };
    const ruled = this.db.prepare("SELECT e.project_id, e.team_id, t.name AS team, json_extract(e.rule,'$.rule') AS rule, json_array_length(e.rule,'$.keys') AS keys, e.created_at FROM bp_events e LEFT JOIN teams t ON t.id=e.team_id WHERE e.rule IS NOT NULL AND e.team_id IS NOT NULL AND e.created_at>? ORDER BY e.created_at").all(now - RULES_AWARE_DAYS * 864e5) as Ru[];
    if (ruled.length) {
      const seen = new Map((this.db.prepare("SELECT record, MAX(dismissed_at) AS at FROM attention_dismissals WHERE user_id=? AND record LIKE 'rules:%' GROUP BY record").all(v.id) as { record: string; at: number }[]).map((x) => [x.record, x.at]));
      const rows = new Map<string, { project_id: string; team_id: string; team: string; rules: Set<string>; n: number; at: number }>();
      for (const e of ruled) {
        if (!v.isAdmin && !v.can(e.project_id, 'blueprint')) continue;
        const record = `rules:${e.project_id}:${e.team_id}`;
        if (e.created_at <= (seen.get(record) ?? 0)) continue;
        const r = rows.get(record) ?? { project_id: e.project_id, team_id: e.team_id, team: e.team ?? 'A team', rules: new Set<string>(), n: 0, at: 0 };
        r.rules.add(BP_RULES[e.rule as BpRule]?.label ?? e.rule); r.n += e.keys; r.at = Math.max(r.at, e.created_at);
        rows.set(record, r);
      }
      const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
      for (const [record, r] of rows) {
        if (!r.n) continue;
        const when = day(r.at) === day(now) ? 'today' : new Date(r.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
        out.push({ id: `rules:${r.project_id}:${r.team_id}`, kind: 'rules_applied', record, episode: day(r.at), scope: { project_id: r.project_id, team_id: r.team_id },
          title: `${r.n} ${r.n === 1 ? 'change' : 'changes'} applied by rules`, reason: `${r.team} · ${[...r.rules].join(', ')} · ${when}`, open: { kind: 'rules', id: r.project_id, team_id: r.team_id, project_id: r.project_id }, at: r.at });
      }
    }
    // Keys approved but not collected yet (the admin's onboarding).
    if (v.isAdmin) for (const q of (this.d.onboarding?.list('approved') ?? [])) {
      out.push({ id: `keys:${q.id}`, kind: 'keys_not_collected', record: `onboarding:${q.id}`, episode: String(q.version), scope: { project_id: null, team_id: q.team_id ?? null },
        title: 'Keys approved, not collected yet', reason: `${q.pc?.name ?? 'The PC'} has not collected them`, open: { kind: 'onboarding', id: q.id }, at: q.waiting_since ?? q.updated_at });
    }
    // A rotated key waiting for its PC's user (docs/onboarding.md#key-handover-a-rotated-key-or-a-recruit-reaches-a-connector-pc):
    // the old key works on until the connector confirms; the key's page has Cancel. The row leaves when the handover ends.
    if (v.isAdmin) {
      for (const h of this.db.prepare(`SELECT r.id, r.filed_at, r.pickup_id, s.credential_id, s.agent_id, m.name AS pc FROM onboarding_requests r
        JOIN onboarding_slots s ON s.request_id=r.id LEFT JOIN machines m ON m.id=r.machine_id
        WHERE r.handover='rotate' AND r.state='approved' AND r.expires_at>?`).all(now) as { id: string; filed_at: number; pickup_id: string | null; credential_id: string; agent_id: string | null; pc: string | null }[]) {
        out.push({ id: `handover:${h.credential_id}`, kind: 'key_handover', record: `handover:${h.credential_id}`, episode: h.id, scope: { project_id: null, team_id: null },
          title: `${this.agentName(h.agent_id)}'s new key: waiting for the PC user`, reason: `${h.pickup_id ? 'Picked up, not confirmed yet' : 'Not allowed on the PC yet'}${h.pc ? ` · ${h.pc}` : ''}`, open: { kind: 'key', id: h.credential_id }, at: h.filed_at });
      }
      // A leak rotation that ended without confirm: the old key stays held (Keys.hold) until the operator rotates again or revokes.
      for (const c of this.db.prepare(`SELECT c.id, c.agent_id, c.created_at, m.name AS pc FROM credentials c LEFT JOIN machines m ON m.id=c.machine_id
        WHERE c.kind='session_key' AND c.status='suspended' AND c.status_reason=? AND NOT EXISTS (SELECT 1 FROM onboarding_requests r JOIN onboarding_slots s ON s.request_id=r.id
          WHERE r.handover='rotate' AND r.state='approved' AND r.expires_at>? AND s.credential_id=c.id)`).all(LEAK_HOLD, now) as { id: string; agent_id: string | null; created_at: number; pc: string | null }[]) {
        out.push({ id: `leak:${c.id}`, kind: 'key_leak_unfinished', record: `leak:${c.id}`, episode: c.id, scope: { project_id: null, team_id: null },
          title: 'Leak rotation not finished: rotate again or revoke', reason: `${this.agentName(c.agent_id)}'s key is held; its logins are refused${c.pc ? ` · ${c.pc}` : ''}`, open: { kind: 'key', id: c.id }, at: c.created_at });
      }
    }
    const gone = new Set((this.db.prepare("SELECT record, episode FROM attention_dismissals WHERE user_id=? AND kind='dismiss'").all(v.id) as { record: string; episode: string }[]).map((x) => `${x.record}\u0000${x.episode}`));
    const items = out.filter((r) => match(r.scope, f) && (!f.review || r.kind === 'claim_not_supported' || r.kind === 'missed_milestone' || r.kind === 'blocking_work') && !gone.has(`${r.record}\u0000${r.episode}`))
      .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
    return { items, total: items.length };
  }

  /**
   * Dismiss one For awareness row for this viewer and its current episode. Only a row they see now can be dismissed; a
   * Needs you row never can (it can be set aside with Later).
   */
  async dismiss(v: Viewer, record: string, episode: string, now = Date.now()): Promise<void> {
    const row = this.awareness(v, {}, now).items.find((r) => r.record === record);
    if (!row && record.includes(':') && (await this.rows(v, record.slice(0, record.indexOf(':')))).some((r) => r.id === record)) throw new KeyError('invalid_argument', 'A decision that waits for you cannot be dismissed. Set it aside with Later instead.');
    if (!row) throw new KeyError('not_found', 'Nothing to dismiss: it is not on your list.');
    if (row.episode !== episode) throw new KeyError('conflict', 'This changed since you opened it. The list is refreshed.');
    this.db.prepare('INSERT OR IGNORE INTO attention_dismissals(user_id, record, episode, dismissed_at) VALUES (?,?,?,?)').run(v.id, record, episode, now);
  }
}

/**
 * The source route's reply, as JSON for the act route. A reply that is not JSON (a proxy page, an empty body) keeps its
 * status, and an error gets a plain message instead of failing the act with a generic 500.
 */
export function sourceReply(r: { statusCode: number; body: string }): Record<string, unknown> {
  try {
    const j = JSON.parse(r.body) as unknown;
    return j && typeof j === 'object' && !Array.isArray(j) ? j as Record<string, unknown> : { result: j };
  } catch {
    return r.statusCode < 400 ? {} : { error: r.statusCode >= 500 ? 'internal_error' : 'bad_request', message: `The action was refused (HTTP ${r.statusCode}) without a reason. Open it on its own screen to see why.` };
  }
}

const filtered = (rows: NeedsRow[], f: NeedsFilter) => rows.filter((r) => match(r.scope, f) && (!f.review || r.kind === 'proposal' || r.kind === 'unclear'));

function match(s: { project_id: string | null; team_id: string | null }, f: NeedsFilter): boolean {
  if (f.team && s.team_id !== f.team) return false;
  if (f.project && s.project_id !== f.project) return false;
  return true;
}
