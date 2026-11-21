/**
 * Decisions (docs/decisions.md): a team member asks the operator a question, with options and a recommendation,
 * optionally blocking a task until the answer. The operator answers in the console; the answer comes back to the
 * agent as a notice (L0, it is the operator's word), the task returns to its assignee, and the answered question
 * stays in the team's decision log. Optionally the answer is also appended to a vault note.
 */
import { l2 } from '../notices/l2.js';
import { NOT_ALLOWED } from '../policy/engine.js';
import type { Db } from '../db/db.js';
import { tx } from '../db/db.js';
import type { Keys } from '../keys/keys.js';
import { KeyError } from '../keys/keys.js';
import type { Audit, Actor } from '../audit/audit.js';
import type { Teams, Who } from './teams.js';
import type { VaultStore } from '../vault/store.js';
import type { Vault } from '../vault/vault.js';
import { VaultError } from '../vault/vault.js';
import { randomToken, sha256Hex } from '../util/crypto.js';
import type { Blueprint } from '../blueprint/blueprint.js';

export type DecisionStatus = 'open' | 'needs_info' | 'answered' | 'declined' | 'withdrawn';
/** A relayed answer: recorded by the coordinator (L1) until the operator confirms it (L0) or overturns it. */
export type RelayState = 'pending' | 'confirmed' | 'overturned';
export interface DecisionOption { key: string; label: string; effect?: string | null }
/** A question a Blueprint write opens for a requirement it marks unclear (Decisions.askForItem, docs/blueprint.md §2.7). */
export interface ItemAsk { id: string; team_id: string; agent_id: string; key: string; question: string; options?: DecisionOption[]; recommended?: string; context?: string | null; dry: boolean; capped: boolean }
export interface DecisionRow {
  id: string; team_id: string; task_id: string | null; blocks_task: number; agent_id: string; credential_id: string | null;
  question: string; context: string | null; options: string; recommended: string | null; refs: string; needed_by: number | null;
  status: DecisionStatus; info_note: string | null; answer_option: string | null; answer_text: string | null;
  answered_by: string | null; answered_at: number | null; log_revision: string | null; created_at: number; updated_at: number;
  make_decision: number; bp_key: string | null;
  relayed_by: string | null; relayed_source: string | null; relayed_option: string | null; relayed_text: string | null; relayed_at: number | null;
  relay_state: RelayState | null; relay_settled_at: number | null;
  /** Migration 0153: when the answer reached the asker's session (the connector reports it); NULL again on every new answer. */
  delivered_at?: number | null;
}
export interface DecisionView extends Omit<DecisionRow, 'options' | 'refs' | 'blocks_task' | 'make_decision'> {
  options: DecisionOption[]; refs: string[]; blocks_task: boolean; make_decision: boolean; answer_label: string | null;
  agent_label: string | null; team_name: string | null; task_title: string | null; answered_by_name: string | null;
  /** L1 while the answer is relayed and not yet confirmed by the operator; L0 otherwise. */
  trust: 'L0' | 'L1'; relayed_by_label: string | null; relayed_label: string | null;
  /** 1 as asked; one more for each correction of the options (docs/decisions.md, "Correcting the options"). */
  options_version: number;
  /** Every version of the options, oldest first; empty while they were never corrected. */
  option_history: { version: number; options: DecisionOption[]; recommended: string | null; changed_by: string; changed_by_label: string | null; changed_at: number }[];
}

/** An agent may have this many questions waiting for the operator at once: questions stay deliberate. */
export const MAX_OPEN_PER_AGENT = 5;
/** team_ask's limits, also for a question a Blueprint write opens (the tool schema says the same). */
export const MAX_QUESTION = 300, MAX_OPTIONS = 6;
const OPEN: DecisionStatus[] = ['open', 'needs_info'];
const err = (code: string, msg: string) => new KeyError(code, msg);
/** Where an unblocked task stands now, for its assignee (it returns to the status it was blocked from). */
const whereNow = (status: string): string => ({
  assigned: 'assigned to you again: continue with task_start', in_progress: 'back in progress with you: carry on',
  changes_requested: 'back with changes requested: continue with task_start', in_review: 'back in review: no action until the verdict',
  approved: 'approved again: the coordinator closes it', open: 'open again: the coordinator assigns it',
} as Record<string, string>)[status] ?? `now ${status}`;

export class Decisions {
  /** Set by app.ts: an answer to a question with `decision: true`, or naming a proposed ADR, becomes a decision entry. */
  blueprint?: Blueprint;
  constructor(private readonly db: Db, private readonly keys: Keys, private readonly teams: Teams, private readonly audit: Audit,
    private readonly store: VaultStore, private readonly vault: Vault) {}
  /** Told after a question is settled (answered, declined, confirmed or overturned): the vault copy rewrites Decisions.md. */
  onSettled?: (teamId: string) => void;
  /** Told about each new question (the decider routing records where it went, docs/multi-user.md §1.3). */
  onAsked?: (decisionId: string, teamId: string) => void;

  private row(id: string): DecisionRow | null { return (this.db.prepare('SELECT * FROM decisions WHERE id=?').get(id) as unknown as DecisionRow) ?? null; }
  private must(id: string): DecisionRow { const d = this.row(id); if (!d) throw err('not_found', 'decision not found'); return d; }

  view(d: DecisionRow): DecisionView {
    const options = JSON.parse(d.options) as DecisionOption[];
    const admin = d.answered_by ? (this.db.prepare('SELECT username FROM admin_users WHERE id=?').get(d.answered_by) as { username: string } | undefined)?.username ?? null : null;
    return {
      ...d, options, refs: JSON.parse(d.refs) as string[], blocks_task: !!d.blocks_task, make_decision: !!d.make_decision,
      answer_label: d.answer_option ? options.find((o) => o.key === d.answer_option)?.label ?? d.answer_option : null,
      agent_label: this.keys.agent(d.agent_id)?.label ?? null, team_name: this.teams.team(d.team_id)?.name ?? null,
      task_title: d.task_id ? this.teams.task(d.task_id)?.title ?? null : null, answered_by_name: admin,
      trust: d.relay_state === 'pending' ? 'L1' : 'L0', relayed_by_label: d.relayed_by ? this.keys.agent(d.relayed_by)?.label ?? d.relayed_by : null,
      relayed_label: d.relayed_option ? options.find((o) => o.key === d.relayed_option)?.label ?? d.relayed_option : null,
      ...this.optionHistory(d.id),
    };
  }

  /**
   * The connector reports that the asker's session started a turn on the answer (step 2 of the delivery design): the
   * console then shows "Reached <asker> at hh:mm". Set once per answer; an open question has nothing to deliver.
   */
  delivered(id: string, now = Date.now()): boolean {
    return this.db.prepare("UPDATE decisions SET delivered_at=? WHERE id=? AND status='answered' AND delivered_at IS NULL").run(now, id).changes > 0;
  }

  /** The console's list: open questions first (oldest first), then the log (newest first). */
  list(f: { team?: string; teams?: string[]; status?: 'open' | 'closed' | 'all'; limit?: number } = {}): DecisionView[] {
    const where: string[] = [], args: (string | number)[] = [];
    if (f.team) { where.push('team_id=?'); args.push(f.team); }
    // Only these teams (a member's view): an empty list means none.
    if (f.teams) { where.push(f.teams.length ? `team_id IN (${f.teams.map(() => '?').join(',')})` : '0'); args.push(...f.teams); }
    if (f.status === 'open') where.push("status IN ('open','needs_info')");
    if (f.status === 'closed') where.push("status IN ('answered','declined','withdrawn')");
    const rows = this.db.prepare(`SELECT * FROM decisions ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY CASE WHEN status IN ('open','needs_info') THEN 0 ELSE 1 END, CASE WHEN status IN ('open','needs_info') THEN created_at ELSE -COALESCE(answered_at, updated_at) END LIMIT ?`)
      .all(...args, Math.min(500, Math.max(1, f.limit ?? 200))) as unknown as DecisionRow[];
    return rows.map((d) => this.view(d));
  }
  get(id: string): DecisionView { return this.view(this.must(id)); }
  private optionHistory(id: string): Pick<DecisionView, 'options_version' | 'option_history'> {
    const rows = this.db.prepare('SELECT version, options, recommended, changed_by, changed_at FROM decision_versions WHERE decision_id=? ORDER BY version').all(id) as
      { version: number; options: string; recommended: string | null; changed_by: string; changed_at: number }[];
    return {
      options_version: rows.length ? rows[rows.length - 1]!.version : 1,
      option_history: rows.map((r) => ({ ...r, options: JSON.parse(r.options) as DecisionOption[], changed_by_label: this.keys.agent(r.changed_by)?.label ?? null })),
    };
  }
  /** Open questions per team, for the team list and the Work badge. */
  openCounts(): Record<string, number> {
    return Object.fromEntries((this.db.prepare("SELECT team_id, COUNT(*) n FROM decisions WHERE status IN ('open','needs_info') GROUP BY team_id").all() as { team_id: string; n: number }[]).map((r) => [r.team_id, r.n]));
  }
  /** The open question that blocks each task, for the board cards. */
  openByTask(teamId: string): Record<string, string> {
    return Object.fromEntries((this.db.prepare("SELECT task_id, id FROM decisions WHERE team_id=? AND task_id IS NOT NULL AND blocks_task=1 AND status IN ('open','needs_info')").all(teamId) as { task_id: string; id: string }[]).map((r) => [r.task_id, r.id]));
  }

  /** Whether a team question about this task is still open (open or needs info), blocking it or not. */
  hasOpenQuestion(taskId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM decisions WHERE task_id=? AND status IN ('open','needs_info') LIMIT 1").get(taskId);
  }

  // ───── the agent side ─────
  ask(w: Who, a: { team_id: string; question: string; context?: string; options?: DecisionOption[]; recommended?: string; task_id?: string; refs?: string[]; needed_by?: number; decision?: boolean; project?: string }): DecisionView {
    const team = this.teams.checkAsk(w, a.team_id);
    // Keys are per project (docs/blueprint.md §3): the team fixes the project its refs resolve in; a project named must be it.
    const own = this.db.prepare('SELECT p.id, p.key FROM teams t JOIN projects p ON p.id=t.project_id WHERE t.id=?').get(team.id) as { id: string; key: string } | undefined;
    if (a.project !== undefined && (!own || (a.project !== own.id && a.project !== own.key))) {
      throw err('invalid_argument', `Team ${team.name} is in project ${own?.key ?? '(none yet)'}, and its refs resolve there. Leave project out${own ? `, or name ${own.key}` : ''}.`);
    }
    const { question, options } = this.checkQuestion(a);
    if (a.needed_by !== undefined && a.needed_by < Date.now()) throw err('invalid_argument', 'needed_by is in the past.');
    this.checkOpenCap(w.agentId);
    if (a.task_id && this.db.prepare("SELECT 1 FROM decisions WHERE task_id=? AND blocks_task=1 AND status IN ('open','needs_info')").get(a.task_id)) {
      throw err('invalid_state', 'This task already waits for an answer. Add to that question with team_ask_update instead.');
    }
    const refs = this.teams.checkRefsPublic(team.id, a.refs);
    const id = `dec_${randomToken(10)}`;
    tx(this.db, () => {
      if (a.task_id) this.teams.blockForDecision(w, team.id, a.task_id, question, id);
      this.insert(id, team, w.agentId, w.credId, { ...a, question, options, refs, project_id: own?.id ?? null });
    });
    this.announce(id, team, w.agentId, a.task_id ?? null);
    return this.get(id);
  }
  /**
   * A question a Blueprint write opens for the requirement it marks unclear (`unclear_ask` with the question's text,
   * docs/blueprint.md §2.7): the writing agent's, naming the requirement, inside the write's transaction (the item exists by
   * then). `dry` (a check or a proposal being filed) only validates; `capped` is false when the operator applies a proposal,
   * so the agent's open-question limit never refuses the operator's apply.
   */
  askForItem(a: ItemAsk): void {
    const { question, options } = this.checkQuestion(a);
    if (a.capped) this.checkOpenCap(a.agent_id);
    if (a.dry) return;
    const team = this.db.prepare('SELECT id, name, project_id FROM teams WHERE id=?').get(a.team_id) as { id: string; name: string; project_id: string | null } | undefined;
    if (!team) throw err('not_found', 'team not found');
    this.insert(a.id, team, a.agent_id, null, { question, options, recommended: a.recommended, context: a.context ?? undefined, refs: [a.key], project_id: team.project_id });
    this.announce(a.id, team, a.agent_id, null);
  }
  /** The question and its options, trimmed and checked (team_ask and a Blueprint write's unclear_ask share the rules). */
  checkQuestion(a: { question: string; options?: DecisionOption[]; recommended?: string }): { question: string; options: { key: string; label: string; effect: string | null }[] } {
    const question = a.question.trim();
    if (!question) throw err('invalid_argument', 'Ask a question.');
    if (question.length > MAX_QUESTION) throw err('invalid_argument', `A question holds at most ${MAX_QUESTION} characters; put the rest in context.`);
    const options = (a.options ?? []).map((o) => ({ key: o.key.trim(), label: o.label.trim(), effect: o.effect?.trim() || null }));
    const keys = options.map((o) => o.key);
    if (options.length === 1) throw err('invalid_argument', 'Give two or more options, or none for a free answer.');
    if (options.length > MAX_OPTIONS) throw err('invalid_argument', `Give at most ${MAX_OPTIONS} options.`);
    if (new Set(keys).size !== keys.length || options.some((o) => !o.key || !o.label)) throw err('invalid_argument', 'Each option needs a unique key and a label.');
    if (a.recommended !== undefined && !keys.includes(a.recommended)) throw err('invalid_argument', 'recommended must be one of the option keys.');
    return { question, options };
  }
  private checkOpenCap(agentId: string): void {
    const open = (this.db.prepare("SELECT COUNT(*) n FROM decisions WHERE agent_id=? AND status IN ('open','needs_info')").get(agentId) as { n: number }).n;
    if (open >= MAX_OPEN_PER_AGENT) throw err('rate_limited', `You already have ${open} questions waiting for the operator. Wait for answers, or withdraw one with team_ask_update.`);
  }
  private insert(id: string, team: { id: string }, agentId: string, credId: string | null, a: { question: string; options: { key: string; label: string; effect: string | null }[]; refs: string[]; project_id: string | null; context?: string; recommended?: string; task_id?: string; needed_by?: number; decision?: boolean }): void {
    const now = Date.now();
    this.db.prepare(`INSERT INTO decisions(id,team_id,task_id,blocks_task,agent_id,credential_id,question,context,options,recommended,refs,needed_by,status,created_at,updated_at,make_decision,project_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'open',?,?,?,?)`).run(id, team.id, a.task_id ?? null, a.task_id ? 1 : 0, agentId, credId, a.question, a.context?.trim() || null,
      JSON.stringify(a.options), a.recommended ?? null, JSON.stringify(a.refs), a.needed_by ?? null, now, now, a.decision ? 1 : 0, a.project_id);
  }
  private announce(id: string, team: { id: string; name: string }, agentId: string, taskId: string | null): void {
    const who = this.keys.agent(agentId)?.label ?? agentId;
    // A fixed notice: the question is the agent's words (L1). Coordinators read it with team_decisions.
    this.teams.notifyCoordinators(team.id, 'decision_asked', `${who} asked the operator question ${id}.${taskId ? ` It blocks task ${taskId} until answered.` : ''} Read it with team_decisions {decision_id: "${id}"}.`, agentId);
    this.audit.event({ kind: 'agent', id: agentId }, 'decision.ask', { kind: 'decision', id }, { team: team.name, task: taskId });
    try { this.onAsked?.(id, team.id); } catch { /* routing records must never fail a question */ }
  }
  /** The asker adds information (also the reply to "needs info") or withdraws the question. */
  update(w: Who, a: { decision_id: string; context?: string; withdraw?: boolean; relayed_answer?: string; chosen?: string; source?: string; options?: DecisionOption[]; recommended?: string }): DecisionView {
    const d = this.must(a.decision_id);
    if (a.relayed_answer !== undefined || a.chosen !== undefined || a.source !== undefined) return this.relay(w, d, a);
    if (a.options !== undefined || a.recommended !== undefined) return this.correct(w, d, a);
    if (d.agent_id !== w.agentId) throw err('denied', NOT_ALLOWED);
    if (!OPEN.includes(d.status)) throw err('invalid_state', `The question is ${d.status}.`);
    const now = Date.now(), me = { kind: 'agent' as const, id: w.agentId };
    if (a.withdraw) {
      tx(this.db, () => {
        this.db.prepare("UPDATE decisions SET status='withdrawn', blocks_task=0, updated_at=? WHERE id=?").run(now, d.id);
        if (d.task_id && d.blocks_task) this.teams.unblockAfterDecision(d.task_id, d.id, 'question withdrawn', me);
        this.audit.event(me, 'decision.withdraw', { kind: 'decision', id: d.id }, { task: d.task_id, unblocked: !!(d.task_id && d.blocks_task) });
      });
      return this.get(d.id);
    }
    const add = a.context?.trim();
    if (!add) throw err('invalid_argument', 'Give context to add, or withdraw: true.');
    const context = [d.context, `${new Date(now).toISOString().slice(0, 16).replace('T', ' ')}: ${add}`].filter(Boolean).join('\n\n').slice(0, 20_000);
    tx(this.db, () => {
      this.db.prepare("UPDATE decisions SET context=?, status='open', info_note=NULL, updated_at=? WHERE id=?").run(context, now, d.id);
      this.audit.event(me, 'decision.context', { kind: 'decision', id: d.id }, { added: add.length, reply_to_needs_info: d.status === 'needs_info' });
    });
    return this.get(d.id);
  }
  /**
   * Correct an open question's options or recommendation (docs/decisions.md, "Correcting the options"): its asker or the
   * asking team's coordinator, only while unanswered. Every version is kept in decision_versions, the change is audited,
   * the asker and the coordinators get an "options changed" notice, and an answer sent from the version before is refused
   * with conflict so the console reloads the question.
   */
  private correct(w: Who, d: DecisionRow, a: { options?: DecisionOption[]; recommended?: string; context?: string; withdraw?: boolean }): DecisionView {
    const coordinator = this.teams.roleOf(d.team_id, w.agentId) === 'coordinator';
    if (d.agent_id !== w.agentId && !coordinator) throw err('denied', 'Only the agent who asked, or its team\'s coordinator, can change the options.');
    if (d.agent_id !== w.agentId) this.teams.checkAsk(w, d.team_id);
    if (a.withdraw || a.context !== undefined) throw err('invalid_argument', 'Change the options on their own: no context or withdraw in the same call.');
    if (!OPEN.includes(d.status)) throw err('invalid_state', `The question is already ${d.status}; its options can no longer change.`);
    const before = JSON.parse(d.options) as DecisionOption[];
    const { options } = this.checkQuestion({ question: d.question, options: a.options ?? before, recommended: a.recommended });
    const recommended = a.recommended !== undefined ? a.recommended : a.options !== undefined && d.recommended && !options.some((o) => o.key === d.recommended) ? null : d.recommended;
    if (JSON.stringify(options) === JSON.stringify(before.map((o) => ({ key: o.key, label: o.label, effect: o.effect ?? null }))) && recommended === d.recommended) {
      throw err('invalid_argument', 'Nothing changed: give the corrected options or recommendation.');
    }
    const now = Date.now(), me = { kind: 'agent' as const, id: w.agentId };
    let version = 0;
    tx(this.db, () => {
      const last = (this.db.prepare('SELECT MAX(version) v FROM decision_versions WHERE decision_id=?').get(d.id) as { v: number | null }).v;
      if (last === null) this.db.prepare('INSERT INTO decision_versions(decision_id,version,options,recommended,changed_by,changed_at) VALUES (?,?,?,?,?,?)').run(d.id, 1, d.options, d.recommended, d.agent_id, d.created_at);
      version = (last ?? 1) + 1;
      this.db.prepare('INSERT INTO decision_versions(decision_id,version,options,recommended,changed_by,changed_at) VALUES (?,?,?,?,?,?)').run(d.id, version, JSON.stringify(options), recommended, w.agentId, now);
      this.db.prepare('UPDATE decisions SET options=?, recommended=?, updated_at=? WHERE id=?').run(JSON.stringify(options), recommended, now, d.id);
      this.audit.event(me, 'decision.options', { kind: 'decision', id: d.id }, { version, from: { options: before.map((o) => o.key), recommended: d.recommended }, to: { options: options.map((o) => o.key), recommended } });
    });
    const by = this.keys.agent(w.agentId)?.label ?? w.agentId;
    const msg = `${by} changed the options of question ${d.id} (${l2(d.question)}): options changed, now version ${version}. Read it with team_decisions {decision_id: "${d.id}"}.`;
    if (d.agent_id !== w.agentId) this.keys.notify(d.agent_id, 'decision', msg);
    this.teams.notifyCoordinators(d.team_id, 'decision_update', msg, w.agentId);
    return this.get(d.id);
  }
  /**
   * The asking team's coordinator records an answer the operator gave outside the hub (docs/decisions.md#relayed-answers).
   * It counts as an answer (the task is unblocked) but stays L1, "relayed by", until the operator confirms or overturns
   * it; Blueprint decisions it would record or accept wait for that confirmation.
   */
  private relay(w: Who, d: DecisionRow, a: { relayed_answer?: string; chosen?: string; source?: string; context?: string; withdraw?: boolean }): DecisionView {
    if (this.teams.roleOf(d.team_id, w.agentId) !== 'coordinator') throw err('denied', 'Only the coordinator of the team that asked can relay an answer.');
    // Team state, pause and the grant, as for any other team action: a paused or ended team cannot relay.
    this.teams.checkAsk(w, d.team_id);
    if (a.withdraw || a.context !== undefined) throw err('invalid_argument', 'Relay an answer on its own: no context or withdraw in the same call.');
    if (!OPEN.includes(d.status)) throw err('invalid_state', `The question is already ${d.status}.`);
    const options = JSON.parse(d.options) as DecisionOption[];
    const text = a.relayed_answer?.trim() || null, source = a.source?.trim() || null, option = a.chosen || null;
    if (!text) throw err('invalid_argument', 'relayed_answer is required: the operator\'s answer in their words.');
    if (!source) throw err('invalid_argument', 'source is required: where the operator gave the answer (for example "chat with operator").');
    if (option && !options.some((o) => o.key === option)) throw err('invalid_argument', `chosen must be one of the option keys (${options.map((o) => o.key).join(', ') || 'none: this question has no options'}).`);
    const now = Date.now(), label = option ? options.find((o) => o.key === option)!.label : null;
    const answerLine = [label, text].filter(Boolean).join(' — ');
    const by = this.keys.agent(w.agentId)?.label ?? w.agentId;
    tx(this.db, () => {
      this.db.prepare(`UPDATE decisions SET status='answered', answer_option=?, answer_text=?, answered_by=NULL, answered_at=?, delivered_at=NULL, blocks_task=0, updated_at=?,
        relayed_by=?, relayed_source=?, relayed_option=?, relayed_text=?, relayed_at=?, relay_state='pending', relay_settled_at=NULL WHERE id=?`)
        .run(option, text, now, now, w.agentId, source, option, text, now, d.id);
      if (d.task_id && d.blocks_task) this.teams.unblockAfterDecision(d.task_id, d.id, `answered (relayed by ${by}): ${answerLine}`, { kind: 'agent', id: w.agentId });
    });
    const task = d.task_id ? this.teams.task(d.task_id) : null;
    // A fixed notice: the answer and its source are the coordinator's words (L1). Agents read them with team_decisions.
    const what = `${by} relayed an answer from the operator to question ${d.id}. It is relayed (L1) until the operator confirms it. Read it with team_decisions {decision_id: "${d.id}"}.`;
    if (d.agent_id !== w.agentId) this.keys.notify(d.agent_id, 'decision', `${what}${task && d.blocks_task ? ` Task ${task.id} is ${whereNow(task.status)}.` : ''}`);
    if (task?.assignee_agent_id && task.assignee_agent_id !== d.agent_id && task.assignee_agent_id !== w.agentId) {
      this.keys.notify(task.assignee_agent_id, 'decision', `${what}${d.blocks_task ? ` The task is ${whereNow(task.status)}.` : ''}`);
    }
    this.audit.event({ kind: 'agent', id: w.agentId }, 'decision.relay', { kind: 'decision', id: d.id }, { option, text: text.slice(0, 500), source: source.slice(0, 200) });
    return this.get(d.id);
  }

  /** Decisions of the caller's team, for agents: the log, or only open ones. */
  forAgent(w: Who, teamId: string, status: 'open' | 'closed' | 'all' = 'all', limit = 50, decisionId?: string): DecisionView[] {
    if (!this.teams.roleOf(teamId, w.agentId)) throw err('denied', NOT_ALLOWED);
    if (decisionId) {
      // One question, whatever its status; only one of this team's.
      const d = this.db.prepare('SELECT * FROM decisions WHERE id=? AND team_id=?').get(decisionId, teamId) as unknown as DecisionRow | undefined;
      if (!d) throw err('not_found', NOT_ALLOWED);
      return [this.view(d)];
    }
    return this.list({ team: teamId, status, limit });
  }

  // ───── the operator side ─────
  async answer(id: string, a: { option?: string | null; text?: string | null; item_rev?: number | null; options_version?: number | null; reject?: boolean }, actor: Actor & { kind: 'admin' }): Promise<DecisionView> {
    const d = this.must(id);
    if (!OPEN.includes(d.status)) throw err('invalid_state', `The question is already ${d.status}.`);
    // Answered from a screen that showed older options: refused, so the console reloads the question first.
    if (a.options_version != null && a.options_version !== this.optionHistory(d.id).options_version) throw err('conflict', 'The options of this question changed while you had it open. Read them again before you answer.');
    const options = JSON.parse(d.options) as DecisionOption[], text = a.text?.trim() || null, option = a.option || null;
    if (option && !options.some((o) => o.key === option)) throw err('invalid_argument', 'Unknown option.');
    if (!option && !text) throw err('invalid_argument', 'Choose an option or write an answer.');
    // Reject (a design the operator turns down): no option, a reason, and a proposed decision item the question names.
    if (a.reject && (option || !text)) throw err('invalid_argument', 'Reject a design with a reason and no option.');
    if (a.reject && !this.blueprint?.designOf(d.team_id, JSON.parse(d.refs) as string[])) throw err('invalid_argument', 'Only a design (a question that names a decision item) can be rejected.');
    const now = Date.now(), label = option ? options.find((o) => o.key === option)!.label : null;
    const answerLine = a.reject ? `Rejected: ${text}` : [label, text].filter(Boolean).join(' — ');
    let cleared: string | null = null;
    tx(this.db, () => {
      // An unclear requirement's question: the answer clears the mark in the same step, by the answerer (the item's revision records who).
      cleared = this.clarified(d, text, actor, a.item_rev ?? null);
      this.db.prepare("UPDATE decisions SET status='answered', answer_option=?, answer_text=?, answered_by=?, answered_at=?, delivered_at=NULL, blocks_task=0, updated_at=? WHERE id=?").run(option, text, actor.id, now, now, d.id);
      if (d.task_id && d.blocks_task) this.teams.unblockAfterDecision(d.task_id, d.id, `answered: ${answerLine}`, actor);
    });
    const adr = this.recordInBlueprint(d.id, actor, a.reject ? { reason: text! } : undefined);
    const task = d.task_id ? this.teams.task(d.task_id) : null;
    const mine = task?.assignee_agent_id === d.agent_id, holder = task?.assignee_agent_id ? this.keys.agent(task.assignee_agent_id)?.label ?? task.assignee_agent_id : null;
    // The task went back to the status it was blocked from, not always to assigned.
    const back = task && d.blocks_task ? ` Task ${l2(task.title)} (${task.id}) is ${mine || task.status === 'open' ? whereNow(task.status) : task.status === 'assigned' ? `assigned to ${holder} again` : `back with ${holder} (${task.status.replace('_', ' ')})`}.` : '';
    const rec = (adr ? ` Recorded as ${adr} in the blueprint.` : '') + (cleared ? ` ${cleared} is no longer marked unclear.` : '');
    this.keys.notify(d.agent_id, 'decision', `The operator answered your question ${d.id} (${l2(d.question)}): ${answerLine}.${rec}${back}`);
    this.teams.notifyCoordinators(d.team_id, 'decision_update', `The operator answered ${d.id} (${l2(d.question)}): ${answerLine}.${rec}`, d.agent_id);
    // The worker of the blocked task hears it too when someone else (usually the coordinator) asked for it.
    if (task && task.assignee_agent_id && task.assignee_agent_id !== d.agent_id && this.teams.roleOf(d.team_id, task.assignee_agent_id) !== 'coordinator') {
      this.keys.notify(task.assignee_agent_id, 'decision', `The operator answered ${d.id} about your task ${l2(task.title)}: ${answerLine}.${d.blocks_task ? ` The task is ${whereNow(task.status)}.` : ''}`);
    }
    this.audit.event(actor, 'decision.answer', { kind: 'decision', id: d.id }, { option, text: text?.slice(0, 500) ?? null, ...(a.reject ? { rejected: true } : {}) });
    await this.mirror(d.id);
    return this.get(d.id);
  }
  /**
   * The answer as a blueprint decision entry (docs/blueprint.md §4): accepts a proposed ADR named in refs, or records a
   * new one when the question asked for it. Best effort, like the vault mirror: the answer stands if this fails.
   */
  private recordInBlueprint(id: string, actor: Actor, rejected?: { reason: string }): string | null {
    if (!this.blueprint) return null;
    const d = this.get(id);
    try {
      const key = this.blueprint.recordDecision({ ...d, make_decision: d.make_decision }, { kind: 'operator', id: actor.id }, rejected);
      if (key) this.db.prepare('UPDATE decisions SET bp_key=? WHERE id=?').run(key, id);
      return key;
    } catch (e) {
      this.audit.event({ kind: 'system', id: null }, 'blueprint.decision_failed', { kind: 'decision', id }, { error: (e as Error).message.slice(0, 300) });
      return null;
    }
  }
  /** An answer to an unclear requirement's question clears its mark (docs/blueprint.md §2.7); the operator's own id is the revision's actor. */
  private clarified(d: DecisionRow, text: string | null, actor: Actor, itemRev: number | null = null): string | null {
    return this.blueprint?.clarify({ id: d.id, team_id: d.team_id, refs: JSON.parse(d.refs) as string[] }, text, { kind: 'operator', id: actor.id }, itemRev) ?? null;
  }
  /** The operator confirms a relayed answer: it becomes the operator's word (L0), and Blueprint decisions are recorded now. */
  async confirmRelay(id: string, actor: Actor & { kind: 'admin' }): Promise<DecisionView> {
    const d = this.must(id);
    if (d.relay_state !== 'pending') throw err('invalid_state', d.relay_state ? `The relayed answer was already ${d.relay_state}.` : 'This answer was not relayed.');
    const now = Date.now(), shown = this.get(d.id), said = [shown.answer_label, shown.answer_text].filter(Boolean).join(' — ');
    let cleared: string | null = null;
    tx(this.db, () => {
      this.db.prepare("UPDATE decisions SET relay_state='confirmed', relay_settled_at=?, answered_by=?, updated_at=? WHERE id=?").run(now, actor.id, now, d.id);
      // The confirmed answer is the operator's word: it clears an unclear requirement's mark like a direct answer does.
      cleared = this.clarified(d, said, actor);
    });
    const adr = this.recordInBlueprint(d.id, actor);
    const v = this.get(d.id), line = [v.answer_label, v.answer_text].filter(Boolean).join(' — ');
    const msg = `The operator confirmed the relayed answer to ${d.id} (${l2(d.question)}): ${line}. It is now the operator's decision (L0).${adr ? ` Recorded as ${adr} in the blueprint.` : ''}${cleared ? ` ${cleared} is no longer marked unclear.` : ''}`;
    this.keys.notify(d.agent_id, 'decision', msg);
    this.teams.notifyCoordinators(d.team_id, 'decision_update', msg, d.agent_id);
    this.audit.event(actor, 'decision.relay_confirm', { kind: 'decision', id: d.id }, { relayed_by: d.relayed_by });
    await this.mirror(d.id);
    return this.get(d.id);
  }
  /** The operator overturns a relayed answer with their own; the relayed one stays on record. The task is not blocked again. */
  async overturnRelay(id: string, a: { option?: string | null; text?: string | null }, actor: Actor & { kind: 'admin' }): Promise<DecisionView> {
    const d = this.must(id);
    if (d.relay_state !== 'pending') throw err('invalid_state', d.relay_state ? `The relayed answer was already ${d.relay_state}.` : 'This answer was not relayed.');
    const options = JSON.parse(d.options) as DecisionOption[], text = a.text?.trim() || null, option = a.option || null;
    if (option && !options.some((o) => o.key === option)) throw err('invalid_argument', 'Unknown option.');
    if (!option && !text) throw err('invalid_argument', 'Choose an option or write an answer.');
    const now = Date.now(), answerLine = [option ? options.find((o) => o.key === option)!.label : null, text].filter(Boolean).join(' — ');
    let cleared: string | null = null;
    tx(this.db, () => {
      this.db.prepare("UPDATE decisions SET answer_option=?, answer_text=?, answered_by=?, answered_at=?, delivered_at=NULL, relay_state='overturned', relay_settled_at=?, updated_at=? WHERE id=?").run(option, text, actor.id, now, now, now, d.id);
      cleared = this.clarified(d, answerLine, actor);
    });
    const adr = this.recordInBlueprint(d.id, actor);
    const msg = `The operator overturned the relayed answer to ${d.id} (${l2(d.question)}). The operator's answer: ${answerLine}.${adr ? ` Recorded as ${adr} in the blueprint.` : ''}${cleared ? ` ${cleared} is no longer marked unclear.` : ''} Undo work done on the relayed answer where it differs.`;
    this.keys.notify(d.agent_id, 'decision', msg);
    this.teams.notifyCoordinators(d.team_id, 'decision_update', msg, d.agent_id);
    const task = d.task_id ? this.teams.task(d.task_id) : null;
    if (task?.assignee_agent_id && task.assignee_agent_id !== d.agent_id && this.teams.roleOf(d.team_id, task.assignee_agent_id) !== 'coordinator') this.keys.notify(task.assignee_agent_id, 'decision', msg);
    this.audit.event(actor, 'decision.relay_overturn', { kind: 'decision', id: d.id }, { option, text: text?.slice(0, 500) ?? null, relayed_by: d.relayed_by });
    await this.mirror(d.id);
    return this.get(d.id);
  }
  /** Ask the agent for more information; the question stays open and its task stays blocked. */
  needInfo(id: string, note: string, actor: Actor): DecisionView {
    const d = this.must(id);
    if (!OPEN.includes(d.status)) throw err('invalid_state', `The question is already ${d.status}.`);
    if (!note.trim()) throw err('invalid_argument', 'Say what you need to know.');
    this.db.prepare("UPDATE decisions SET status='needs_info', info_note=?, updated_at=? WHERE id=?").run(note.trim(), Date.now(), d.id);
    this.keys.notify(d.agent_id, 'decision_needs_info', `The operator needs more information on your question ${d.id} (${l2(d.question)}): ${note.trim()} Reply with team_ask_update {decision_id: "${d.id}", context}.`);
    this.audit.event(actor, 'decision.needs_info', { kind: 'decision', id: d.id }, { note: note.slice(0, 500) });
    return this.get(d.id);
  }
  /** The operator will not decide this: the question closes and its task goes back to the assignee. */
  async decline(id: string, note: string | null, actor: Actor): Promise<DecisionView> {
    const d = this.must(id);
    if (!OPEN.includes(d.status)) throw err('invalid_state', `The question is already ${d.status}.`);
    const now = Date.now();
    tx(this.db, () => {
      this.db.prepare("UPDATE decisions SET status='declined', answer_text=?, answered_by=?, answered_at=?, blocks_task=0, updated_at=? WHERE id=?").run(note?.trim() || null, actor.id, now, now, d.id);
      if (d.task_id && d.blocks_task) this.teams.unblockAfterDecision(d.task_id, d.id, 'question declined', actor);
    });
    this.keys.notify(d.agent_id, 'decision', `The operator declined to decide your question ${d.id} (${l2(d.question)})${note?.trim() ? `: ${note.trim()}` : '.'} Decide within your role, or ask the coordinator.`);
    this.audit.event(actor, 'decision.decline', { kind: 'decision', id: d.id }, { note: note?.slice(0, 500) ?? null });
    await this.mirror(d.id);
    return this.get(d.id);
  }

  /**
   * Append the settled question to the team's decision note in the vault, when the team names one. Best effort: the
   * hub's log is the record, so a failed vault write (a conflict, lockdown) never undoes the answer.
   */
  private async mirror(id: string): Promise<void> {
    const d = this.get(id), team = this.teams.team(d.team_id);
    // The hub's own copy, 99 Conclave/…/Decisions.md (docs/vault.md), after every answer, decline and overturn.
    if (this.onSettled) setImmediate(() => { try { this.onSettled?.(d.team_id); } catch (e) { console.error('decision copy hook failed', e); } });
    if (!team?.decision_log_path) return;
    try {
      const { rel } = this.vault.normalise(team.decision_log_path);
      for (let attempt = 0; attempt < 3; attempt++) {
        let cur: Buffer | null = null;
        try { cur = await this.vault.readBytes(rel); } catch (e) { if (!(e instanceof VaultError && e.code === 'not_found')) throw e; }
        const base = cur ? `sha256:${sha256Hex(cur)}` : 'absent';
        const entry = decisionMarkdown(d);
        const next = Buffer.from(`${cur ? cur.toString('utf8').replace(/\s*$/, '\n\n') : '# Decisions\n\n'}${entry}`, 'utf8');
        try {
          const r = await this.store.write(rel, next, base, cur ? 'update' : 'create', { adminId: d.answered_by });
          this.db.prepare('UPDATE decisions SET log_revision=? WHERE id=?').run(r.revision, d.id);
          return;
        } catch (e) { if (!(e instanceof VaultError && e.code === 'conflict')) throw e; }
      }
    } catch (e) { console.error('decision log mirror failed', d.id, e); }
  }
}

/** One settled decision as a Markdown section, for the vault note. */
export function decisionMarkdown(d: DecisionView): string {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
  const lines = [`## ${day(d.answered_at ?? d.updated_at)} · ${d.question}`, '',
    `- Asked by ${d.agent_label ?? d.agent_id}${d.task_title ? ` for task "${d.task_title}"` : ''}, ${day(d.created_at)}${d.refs.length ? ` (${d.refs.join(', ')})` : ''}`];
  if (d.options.length) lines.push(`- Options: ${d.options.map((o) => `${o.key}) ${o.label}${o.key === d.recommended ? ' (recommended)' : ''}`).join(' · ')}`);
  if (d.status === 'answered') lines.push(`- **Decision:** ${[d.answer_label, d.answer_text].filter(Boolean).join(' — ')}`);
  else lines.push(`- **Declined**${d.answer_text ? `: ${d.answer_text}` : ''}`);
  if (d.relay_state) lines.push(`- Relayed by ${d.relayed_by_label ?? d.relayed_by} from ${d.relayed_source}${d.relay_state === 'overturned' ? `; the operator overturned the relayed answer (${[d.relayed_label, d.relayed_text].filter(Boolean).join(' — ')})` : d.relay_state === 'confirmed' ? '; confirmed by the operator' : ''}`);
  lines.push(`- ${d.status === 'answered' ? 'Answered' : 'Declined'} by ${d.answered_by_name ?? 'the operator'} · ${d.id}`, '');
  return lines.join('\n');
}
