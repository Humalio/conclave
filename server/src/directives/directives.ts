/**
 * Directives (docs/directives.md): the operator's standing rules, kept in the hub so it is visible which rules reach
 * which agent and which version each agent has read.
 *
 * - Scope: all agents (hub), one project, one team, one role in a team, or one agent. A directive is in force for an
 *   agent when the scope covers it and no active exemption keeps it off that agent, one of its teams or one of their
 *   projects (reach); ended teams and archived agents are left out. A project is a Blueprint project id, reached through
 *   the agent's live team memberships (docs/directives.md#project-reach), never its free-text project label.
 * - Every change of reach tells the agents it touched: an edit, keep off, apply again, and (refresh) a membership,
 *   team status or team project change.
 * - Delivery is cheap: login and session_whoami list titles and versions only; a new or changed directive arrives
 *   once as a notice; the text comes with directives_read.
 * - Agents confirm the version they read (directives_read {ack: true}), so the
 *   console shows who is missing one or out of date.
 * - Agents report rules they follow from elsewhere (directives_report): each is a suggestion to the agent's team, not
 *   a directive, ignored when a directive in force already says the same thing; the operator adopts it as a directive
 *   for the team (closing the same suggestion from other members) or tells the agent to stop following it.
 */
import type { Db } from '../db/db.js';
import { tx } from '../db/db.js';
import type { Keys, Agent, NoticeRef } from '../keys/keys.js';
import { KeyError } from '../keys/keys.js';
import type { Audit, Actor } from '../audit/audit.js';
import type { Teams } from '../teams/teams.js';
import { randomToken } from '../util/crypto.js';
import { l2 } from '../notices/l2.js';

export type ScopeKind = 'hub' | 'project' | 'team' | 'role' | 'agent';
/** The fixed category list (migration 0024 checks it too). Order is the console's order. */
export const CATEGORIES = [
  ['access', 'Access & security'], ['communication', 'Communication'], ['tokens', 'Token economy'], ['reporting', 'Reporting'],
  ['sources', 'Sources & quality'], ['process', 'Process & workflow'], ['tooling', 'Tooling'],
] as const;
export type Category = typeof CATEGORIES[number][0];
export const CATEGORY_IDS = CATEGORIES.map(([k]) => k) as [Category, ...Category[]];
export const categoryLabel = (c: string | null | undefined): string | null => CATEGORIES.find(([k]) => k === c)?.[1] ?? null;
/** At most this many tags per directive, each a short lowercase word (spaces become dashes). */
export const MAX_TAGS = 10;
export function normTags(tags: readonly string[]): string[] { return normTagList(tags, MAX_TAGS, 32, 'A directive'); }
/** An agent's read state of a directive in force: the one predicate behind whoami, `directives_read {unread}` and the reminder. */
export function readState(d: { version: number; acked_version: number | null }): 'current' | 'outdated' | 'unread' {
  return d.acked_version === null ? 'unread' : d.acked_version >= d.version ? 'current' : 'outdated';
}
/**
 * The hub's tag model, shared by directives and tasks: trimmed, lowercase, spaces become dashes, only a-z 0-9 . _ -,
 * each cut to `len` characters, duplicates and empty ones dropped; more than `max` is an error.
 */
export function normTagList(tags: readonly string[], max: number, len: number, what: string): string[] {
  const out = [...new Set(tags.map((t) => String(t).trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9._-]/g, '').slice(0, len)).filter(Boolean))];
  if (out.length > max) throw new KeyError('invalid_argument', `${what} takes at most ${max} tags.`);
  return out;
}
const checkCategory = (c: string | null | undefined): Category | null => {
  if (c === null || c === undefined || c === '') return null;
  if (!(CATEGORY_IDS as string[]).includes(c)) throw new KeyError('invalid_argument', `Unknown category "${c}". Use one of: ${CATEGORY_IDS.join(', ')}.`);
  return c as Category;
};
export interface DirectiveRow { id: string; title: string; body: string; scope_kind: ScopeKind; scope_ref: string | null; version: number; status: 'active' | 'retired'; source: string | null; created_by: string | null; created_at: number; updated_at: number; reported_by?: string | null; reviewed_at?: number | null; category: Category | null; tags: string[]; proposed_category: Category | null }
/** Rows come from SQLite with tags as JSON text. */
const parse = (d: any): DirectiveRow => { let tags: string[] = []; try { tags = JSON.parse(d.tags || '[]'); } catch { /* keep none */ } return { ...d, tags: Array.isArray(tags) ? tags : [] }; };
/** A list filter: category id or 'none' (no category yet), and one tag. */
export interface DirectiveFilter { category?: string; tag?: string }
export const filterMatch = (d: { category: string | null; tags: string[] }, f: DirectiveFilter = {}): boolean =>
  (!f.category || (f.category === 'none' ? !d.category : d.category === f.category)) && (!f.tag || d.tags.includes(f.tag.trim().toLowerCase()));
export interface ReportRow { id: string; agent_id: string; title: string; source: string | null; summary: string; text: string | null; status: 'open' | 'adopted' | 'retired' | 'known'; directive_id: string | null; note: string | null; created_at: number; decided_at: number | null; team_id: string | null; category: Category | null }
export interface Scope { kind: ScopeKind; ref: string | null }
/** What an exemption keeps a directive off: one agent, the current members of a live team, or of a project's live teams. */
export type ExemptionKind = 'agent' | 'team' | 'project';
export interface ExemptionRow { id: string; directive_id: string; target_kind: ExemptionKind; target_ref: string; note: string | null; created_by: string | null; created_at: number; removed_by: string | null; removed_at: number | null }
/** A reach resolver: exemptions, agents and live teams loaded once (Directives.resolver). */
interface Reach { covers(s: Scope, a: Agent): boolean; matches(x: { kind: ExemptionKind; ref: string }, a: Agent): boolean; applies(d: DirectiveRow, a: Agent): boolean; reach(d: DirectiveRow): Agent[]; reachWith(s: Scope, exemptions: { kind: ExemptionKind; ref: string }[]): Agent[] }
/**
 * Is the agent in this project? One of its live teams (the eligible memberships) belongs to it. A teamless agent is in
 * no project; the agent's own project label plays no part (docs/directives.md#project-reach).
 */
export const inProject = (live: readonly { project_id?: string | null }[], ref: string | null): boolean => !!ref && live.some((t) => t.project_id === ref);
/** A project an older client named by key or name instead of id: id first, then key, then the name of an open project. */
export interface ProjectRef { id: string; key: string; name: string }

const err = (code: string, msg: string) => new KeyError(code, msg);
/** A notice asking the agent to confirm this version: it settles once the agent confirms it or a later one, or the directive leaves its reach. */
const confirmRef = (d: { id: string; version: number }): NoticeRef => ({ kind: 'directive', id: d.id, state: d.version });
/** A notice telling the agent to stop following something: it settles on the agent's next directives_read. */
const stopRef = (id: string): NoticeRef => ({ kind: 'directive_stop', id });
/** More specific scopes win when two directives disagree: agent > role > team > project > hub. */
export const SCOPE_RANK: Record<ScopeKind, number> = { agent: 0, role: 1, team: 2, project: 3, hub: 4 };
/** An agent may have this many suggestions waiting for the operator (docs/directives.md#suggestions-from-agents). */
export const MAX_OPEN_REPORTS = 50;
/** Two titles name the same rule when they match ignoring case, spaces and punctuation. */
export const normTitle = (t: string) => t.toLowerCase().replace(/\.md$/, '').replace(/[^a-z0-9]+/g, ' ').trim();

export class Directives {
  constructor(private readonly db: Db, private readonly keys: Keys, private readonly teams: Teams, private readonly audit: Audit) {}

  private row(id: string): DirectiveRow | null { const r = this.db.prepare('SELECT * FROM directives WHERE id=?').get(id); return r ? parse(r) : null; }
  private rows(sql: string, ...args: (string | number | null)[]): DirectiveRow[] { return this.db.prepare(sql).all(...args).map(parse); }
  /** One version row, with the category and tags the directive had when it was saved. */
  private version(d: { id: string; version: number; title: string; body: string; scope_kind: string; scope_ref: string | null; category: string | null; tags: string[] }, note: string | null, by: string | null, at: number): void {
    this.db.prepare('INSERT INTO directive_versions(directive_id,version,title,body,scope_kind,scope_ref,change_note,changed_by,created_at,category,tags) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(d.id, d.version, d.title, d.body, d.scope_kind, d.scope_ref, note, by, at, d.category, JSON.stringify(d.tags));
  }
  private must(id: string): DirectiveRow { const d = this.row(id); if (!d) throw err('not_found', 'directive not found'); return d; }

  // ───── reach: who a directive is in force for ─────
  /**
   * The one answer to "is this directive in force for this agent" (docs/directives.md): the agents its scope covers,
   * minus the agents an active exemption keeps it off. A retired directive reaches nobody. Exemptions, agents and live
   * teams are loaded once per resolver, so a caller makes one and asks it about every directive it handles.
   */
  private resolver(): Reach {
    const ex = new Map<string, { kind: ExemptionKind; ref: string }[]>();
    for (const r of this.db.prepare('SELECT directive_id, target_kind, target_ref FROM directive_exemptions WHERE removed_at IS NULL').all() as { directive_id: string; target_kind: ExemptionKind; target_ref: string }[]) {
      const l = ex.get(r.directive_id) ?? []; l.push({ kind: r.target_kind, ref: r.target_ref }); ex.set(r.directive_id, l);
    }
    const teams = new Map<string, (ReturnType<Teams['teamsOf']>)>();
    const live = (agentId: string) => {
      let l = teams.get(agentId);
      if (!l) { l = this.teams.teamsOf(agentId).filter((t) => t.status !== 'done' && t.status !== 'stopped'); teams.set(agentId, l); }
      return l;
    };
    // Eligible memberships (docs/directives.md#project-reach): while owner enforcement is on, a team counts toward the
    // agent's projects only when its owner is an active admin, or the owner's grant on the team's project delegates it.
    const enforced = this.keys.ownerEnforcement(), owners = new Map<string, { admin: boolean; teams: Set<string> } | null>();
    const ownerOf = (userId: string) => {
      if (owners.has(userId)) return owners.get(userId)!;
      const u = this.db.prepare('SELECT role, status, expires_at FROM admin_users WHERE id=?').get(userId) as { role: string; status: string; expires_at: number | null } | undefined;
      let o: { admin: boolean; teams: Set<string> } | null = null;
      if (u && u.status === 'active' && (u.expires_at === null || u.expires_at > Date.now())) {
        o = { admin: u.role === 'admin', teams: new Set() };
        for (const g of this.db.prepare('SELECT project_id, delegation FROM user_project_grants WHERE user_id=?').all(userId) as { project_id: string; delegation: string }[]) {
          const teams = (JSON.parse(g.delegation || '{}') as { teams?: unknown }).teams;
          if (Array.isArray(teams)) for (const t of teams) o.teams.add(`${g.project_id}|${t}`);
        }
      }
      owners.set(userId, o);
      return o;
    };
    const eligible = (a: Agent) => (t: { id: string; project_id?: string | null }) => {
      if (!enforced) return true;
      const o = a.owner_user_id ? ownerOf(a.owner_user_id) : null;
      return !!o && (o.admin || o.teams.has(`${t.project_id}|${t.id}`));
    };
    const projectOf = (a: Agent, ref: string | null) => inProject(live(a.id).filter(eligible(a)), ref);
    let all: Agent[] | null = null;
    const covers = (s: Scope, a: Agent): boolean => {
      if (a.archived_at || a.status === 'archived') return false;
      switch (s.kind) {
        case 'hub': return true;
        case 'project': return projectOf(a, s.ref);
        case 'agent': return s.ref === a.id;
        case 'team': return live(a.id).some((t) => t.id === s.ref);
        case 'role': { const [team, role] = String(s.ref).split('|'); return live(a.id).some((t) => t.id === team && t.my_role === role); }
      }
    };
    /**
     * Does an exemption target take in the agent: the agent itself, a member of the live team, or a member of one of the
     * project's live teams. Keep off is an exclusion: every live membership counts here, eligible or not.
     */
    const matches = (x: { kind: ExemptionKind; ref: string }, a: Agent): boolean =>
      x.kind === 'agent' ? x.ref === a.id : x.kind === 'team' ? live(a.id).some((t) => t.id === x.ref) : inProject(live(a.id), x.ref);
    const exempted = (d: DirectiveRow, a: Agent): boolean => (ex.get(d.id) ?? []).some((x) => matches(x, a));
    const applies = (d: DirectiveRow, a: Agent): boolean => d.status === 'active' && covers({ kind: d.scope_kind, ref: d.scope_ref }, a) && !exempted(d, a);
    return { covers, matches, applies, reach: (d) => (all ??= this.keys.agents()).filter((a) => applies(d, a)),
      reachWith: (s, xs) => (all ??= this.keys.agents()).filter((a) => covers(s, a) && !xs.some((x) => matches(x, a))) };
  }
  /** Does this scope cover the agent? (The scope alone: exemptions are applies()'s part.) */
  covers(s: Scope, a: Agent): boolean { return this.resolver().covers(s, a); }
  /** Is the directive in force for the agent: active, covered by its scope, and not kept off it by an exemption. */
  applies(d: DirectiveRow, a: Agent): boolean { return this.resolver().applies(d, a); }
  /** The agents a directive is in force for (for notices and coverage). Empty once it is retired. */
  reach(d: DirectiveRow): Agent[] { return this.resolver().reach(d); }
  /**
   * Every change of who a directive reaches goes through here, with the agent ids it reached before. Agents it lost
   * are told to stop following it. With `what`, every agent it reaches now is told (an edit); without, only the ones
   * it gained. Returns how many gained and lost.
   */
  private reachChange(d: DirectiveRow, before: Set<string>, o: { what?: string; title?: string } = {}): { gained: number; lost: number } {
    const now = this.reach(d), after = new Set(now.map((a) => a.id));
    const gained = now.filter((a) => !before.has(a.id));
    this.tell(d, o.what ?? 'Directive now applies to you:', o.what ? now : gained);
    const lost = [...before].filter((id) => !after.has(id));
    for (const aid of lost) this.keys.notify(aid, 'directive_changed', `Directive "${o.title ?? d.title}" (${d.id}) no longer applies to you. Stop following it.`, stopRef(d.id));
    return { gained: gained.length, lost: lost.length };
  }

  private refreshDepth = 0;
  /**
   * Run a change that may move agents in or out of reach without touching a directive (a team membership, a team
   * ending, a team's project), then tell each of those agents once per directive: "now applies to you" for one it
   * gained, "no longer applies to you" for one it lost (docs/directives.md#project-reach). Nested calls notify once,
   * from the outermost, for the outermost's agents only: an inner call's other agents are not snapshotted, so a caller
   * that nests must pass every agent the whole change can move (today each outer list holds the inner ones). Returns what
   * fn returns.
   */
  refresh<T>(agentIds: readonly string[], fn: () => T): T {
    if (this.refreshDepth > 0 || !agentIds.length) return fn();
    const ids = [...new Set(agentIds)];
    const snap = () => {
      const R = this.resolver(), act = this.rows("SELECT * FROM directives WHERE status='active' ORDER BY created_at"), out = new Map<string, Set<string>>();
      for (const id of ids) { const a = this.keys.agent(id); out.set(id, new Set(a ? act.filter((d) => R.applies(d, a)).map((d) => d.id) : [])); }
      return { act, out };
    };
    const before = snap().out;
    this.refreshDepth++;
    let r: T;
    try { r = fn(); } finally { this.refreshDepth--; }
    const { act, out } = snap(), byId = new Map(act.map((d) => [d.id, d]));
    for (const id of ids) {
      const was = before.get(id) ?? new Set<string>(), now = out.get(id) ?? new Set<string>();
      for (const did of now) if (!was.has(did)) this.tell(byId.get(did)!, 'Directive now applies to you:', [this.keys.agent(id)!]);
      for (const did of was) if (!now.has(did)) {
        const d = byId.get(did) ?? this.row(did);
        this.keys.notify(id, 'directive_changed', `Directive "${d?.title ?? did}" (${did}) no longer applies to you. Stop following it.`, stopRef(did));
      }
    }
    return r;
  }
  /** The live members of a team, for refresh() around a change to it. */
  teamAgents(teamId: string): string[] { return this.teams.members(teamId).map((m) => m.agent_id); }

  // ───── projects: Blueprint project ids, resolved from an id, a key or a name ─────
  /** A project by id, else by key, else by the name of an open project (ignoring case); null when none matches. */
  projectRef(ref: string | null | undefined): ProjectRef | null {
    const r = (ref ?? '').trim();
    if (!r) return null;
    return (this.db.prepare("SELECT id, key, name FROM projects WHERE id=? OR lower(key)=lower(?) OR lower(name)=lower(?) ORDER BY (id=?) DESC, (lower(key)=lower(?)) DESC, (status='closed'), created_at, id LIMIT 1")
      .get(r, r, r, r, r) as ProjectRef | undefined) ?? null;
  }
  private mustProject(ref: string): ProjectRef {
    const p = this.projectRef(ref);
    if (!p) throw err('invalid_argument', `No such project: "${ref.slice(0, 80)}". Choose one of the hub's projects.`);
    return p;
  }
  private projectName(id: string | null): string { return (id && (this.db.prepare('SELECT name FROM projects WHERE id=?').get(id) as { name: string } | undefined)?.name) || (id ?? ''); }
  /** The hub's projects for the console's choices, each with the agents in it (members of its live teams). */
  projects(): (ProjectRef & { status: string; agent_ids: string[] })[] {
    const rows = this.db.prepare('SELECT id, key, name, status FROM projects ORDER BY lower(name), id').all() as unknown as (ProjectRef & { status: string })[];
    const mem = this.db.prepare("SELECT DISTINCT t.project_id p, m.agent_id a FROM team_members m JOIN teams t ON t.id=m.team_id JOIN agents ag ON ag.id=m.agent_id WHERE m.removed_at IS NULL AND t.status NOT IN ('done','stopped') AND t.project_id IS NOT NULL AND ag.archived_at IS NULL AND ag.status<>'archived'").all() as { p: string; a: string }[];
    const by = new Map<string, string[]>();
    for (const r of mem) { const l = by.get(r.p) ?? []; l.push(r.a); by.set(r.p, l); }
    return rows.map((p) => ({ ...p, agent_ids: by.get(p.id) ?? [] }));
  }
  /**
   * Before saving (docs/directives.md#project-reach): who a directive would reach with this scope, or with this target
   * kept off as well, and the agents that gains and loses against the directive as it is. Saves nothing.
   */
  preview(a: { id?: string; scope?: Scope; exempt?: { kind: ExemptionKind; ref: string } }) {
    const d = a.id ? this.must(a.id) : null;
    if (!d && !a.scope) throw err('invalid_argument', 'Give a scope, or a directive and what to keep it off.');
    const s = a.scope ? this.checkScope(a.scope) : { kind: d!.scope_kind, ref: d!.scope_ref };
    const xs = d ? (this.db.prepare('SELECT target_kind kind, target_ref ref FROM directive_exemptions WHERE directive_id=? AND removed_at IS NULL').all(d.id) as { kind: ExemptionKind; ref: string }[]) : [];
    let project: ProjectRef | null = s.kind === 'project' ? this.projectRef(s.ref) : null;
    if (a.exempt) {
      const k = a.exempt.kind, ref = (a.exempt.ref ?? '').trim();
      if (!['agent', 'team', 'project'].includes(k) || !ref) throw err('invalid_argument', 'Name the agent, team or project to keep it off.');
      const r = k === 'project' ? this.mustProject(ref).id : ref;
      if (k === 'project') project = this.projectRef(r);
      xs.push({ kind: k, ref: r });
    }
    const R = this.resolver(), now = d && d.status !== 'active' ? [] : R.reachWith(s, xs); // a retired directive reaches nobody
    const was = d ? R.reach(d) : [], wasIds = new Set(was.map((x) => x.id)), nowIds = new Set(now.map((x) => x.id));
    const brief = (x: Agent) => ({ id: x.id, label: x.label });
    return { reach: now.map(brief), gained: now.filter((x) => !wasIds.has(x.id)).map(brief), lost: was.filter((x) => !nowIds.has(x.id)).map(brief), scope_label: this.scopeLabel({ scope_kind: s.kind, scope_ref: s.ref }), project };
  }

  /** The directives in force for an agent, most specific first, with the version it last read. */
  forAgent(agentId: string): (DirectiveRow & { acked_version: number | null; acked_at: number | null })[] {
    const a = this.keys.agent(agentId); if (!a) return [];
    const acks = new Map((this.db.prepare('SELECT directive_id, version, acked_at FROM directive_acks WHERE agent_id=?').all(agentId) as { directive_id: string; version: number; acked_at: number }[]).map((r) => [r.directive_id, r]));
    const R = this.resolver();
    return this.rows("SELECT * FROM directives WHERE status='active' ORDER BY created_at")
      .filter((d) => R.applies(d, a))
      .sort((x, y) => SCOPE_RANK[x.scope_kind] - SCOPE_RANK[y.scope_kind] || x.created_at - y.created_at)
      .map((d) => ({ ...d, acked_version: acks.get(d.id)?.version ?? null, acked_at: acks.get(d.id)?.acked_at ?? null }));
  }
  /**
   * The ids of the directives in force for an agent that it never confirmed or confirmed at an older version: exactly what
   * `directives_read {unread: true}` returns and what `summaryFor` marks unread or outdated (one predicate, `readState`).
   */
  unreadIds(agentId: string): string[] {
    return this.forAgent(agentId).filter((d) => readState(d) !== 'current').map((d) => d.id);
  }
  /** One line per directive for login and whoami: cheap enough to send with every login. */
  summaryFor(agentId: string, f: DirectiveFilter = {}): { id: string; title: string; version: number; scope: string; category: Category | null; tags: string[]; read: 'current' | 'outdated' | 'unread' }[] {
    return this.forAgent(agentId).filter((d) => filterMatch(d, f)).map((d) => ({ id: d.id, title: d.title, version: d.version, scope: this.scopeLabel(d), category: d.category, tags: d.tags,
      read: readState(d) }));
  }
  scopeLabel(d: { scope_kind: ScopeKind; scope_ref: string | null }): string {
    switch (d.scope_kind) {
      case 'hub': return 'all agents';
      case 'project': return `project ${this.projectName(d.scope_ref)}`;
      case 'team': return `team ${this.teams.team(d.scope_ref ?? '')?.name ?? d.scope_ref}`;
      case 'role': { const [t, r] = String(d.scope_ref).split('|'); return `${r}s of team ${this.teams.team(t ?? "")?.name ?? t}`; }
      case 'agent': return `agent ${this.keys.agent(d.scope_ref ?? '')?.label ?? d.scope_ref}`;
    }
  }

  // ───── the agent side ─────
  /**
   * directives_read: the directives in force, most specific first; `precedence` is the place in that order (1 wins when
   * two disagree). `unread` keeps those not read at their current version; `ack` confirms every returned directive at its
   * current version in the same call.
   */
  read(agentId: string, id?: string, o: { unread?: boolean; ack?: boolean } = {}) {
    // Every read, in any form (even one answered not_found), settles the "stop following it" notices made before it.
    this.db.prepare('INSERT INTO directive_reads(agent_id,read_at) VALUES (?,?) ON CONFLICT(agent_id) DO UPDATE SET read_at=MAX(read_at, excluded.read_at)').run(agentId, Date.now());
    const all = this.forAgent(agentId).map((d, i) => ({ ...d, precedence: i + 1 }));
    let L = all;
    if (id) {
      const d = all.find((x) => x.id === id);
      if (!d) throw err('not_found', 'No such directive in force for you.');
      L = [d];
    }
    if (o.unread) L = L.filter((d) => readState(d) !== 'current');
    if (o.ack && L.length) {
      const now = Date.now(), up = this.db.prepare('INSERT INTO directive_acks(directive_id,agent_id,version,acked_at) VALUES (?,?,?,?) ON CONFLICT(directive_id,agent_id) DO UPDATE SET version=excluded.version, acked_at=excluded.acked_at');
      tx(this.db, () => { for (const d of L) up.run(d.id, agentId, d.version, now); });
      L = L.map((d) => ({ ...d, acked_version: d.version, acked_at: now }));
    }
    return L;
  }
  /** The agent's team for its suggestions: the first live team it is a member of, or none. */
  private teamOf(agentId: string): string | null {
    return this.teams.teamsOf(agentId).find((t) => t.status !== 'done' && t.status !== 'stopped')?.id ?? null;
  }
  /** A directive in force for the agent, other than one for it alone, that already says this: the same title or the same text. */
  private covering(agentId: string, title: string, body: string): DirectiveRow | null {
    const t = normTitle(title), b = normTitle(body);
    return this.forAgent(agentId).find((d) => d.scope_kind !== 'agent' && (normTitle(d.title) === t || (!!b && normTitle(d.body) === b))) ?? null;
  }
  /**
   * The agent follows a rule the hub does not list: a suggestion to its team, for the operator to adopt or retire
   * (docs/directives.md#suggestions-from-agents). Nothing is in force by it. When a directive in force for the agent
   * already says the same thing, the report is recorded as known, linked to that directive. The same title again
   * updates the agent's open suggestion.
   */
  report(agentId: string, a: { title: string; source?: string; summary: string; text?: string; category?: string }): ReportRow & { known: DirectiveRow | null; team_label: string | null } {
    const title = a.title.trim(), summary = a.summary.trim(), text = a.text?.trim() || null, source = a.source?.trim() || null, now = Date.now(), actor: Actor = { kind: 'agent', id: agentId };
    // An agent only proposes a category; the operator confirms it when adopting (or sets another).
    const proposed = checkCategory(a.category);
    const teamId = this.teamOf(agentId), teamLabel = teamId ? this.teams.team(teamId)?.name ?? null : null;
    const known = this.covering(agentId, title, text ?? summary);
    if (known) {
      const rid = `drp_${randomToken(10)}`;
      this.db.prepare("INSERT INTO directive_reports(id,agent_id,title,source,summary,text,status,directive_id,created_at,decided_at,team_id,category) VALUES (?,?,?,?,?,?,'known',?,?,?,?,?)")
        .run(rid, agentId, title, source, summary, text, known.id, now, now, teamId, proposed);
      this.audit.event(actor, 'directive.report_known', { kind: 'directive', id: known.id }, { title: title.slice(0, 200), source });
      return { ...this.report_(rid), known, team_label: teamLabel };
    }
    const mine = (this.db.prepare("SELECT * FROM directive_reports WHERE agent_id=? AND status='open' ORDER BY created_at").all(agentId) as unknown as ReportRow[])
      .find((r) => normTitle(r.title) === normTitle(title));
    if (mine) {
      this.db.prepare('UPDATE directive_reports SET summary=?, text=COALESCE(?,text), source=COALESCE(?,source), category=COALESCE(?,category), team_id=COALESCE(team_id,?) WHERE id=?').run(summary, text, source, proposed, teamId, mine.id);
      return { ...this.report_(mine.id), known: null, team_label: teamLabel };
    }
    const open = (this.db.prepare("SELECT COUNT(*) n FROM directive_reports WHERE agent_id=? AND status='open'").get(agentId) as { n: number }).n;
    if (open >= MAX_OPEN_REPORTS) throw err('rate_limited', `You already have ${open} suggestions waiting for the operator. Wait until some are decided.`);
    const rid = `drp_${randomToken(10)}`;
    this.db.prepare("INSERT INTO directive_reports(id,agent_id,title,source,summary,text,status,directive_id,created_at,decided_at,team_id,category) VALUES (?,?,?,?,?,?,'open',NULL,?,NULL,?,?)")
      .run(rid, agentId, title, source, summary, text, now, teamId, proposed);
    this.audit.event(actor, 'directive.report', { kind: 'directive_report', id: rid }, { title: title.slice(0, 200), source, team: teamId, proposed_category: proposed });
    return { ...this.report_(rid), known: null, team_label: teamLabel };
  }
  /** The operator keeps an agent-registered directive as it is. */
  /**
   * The operator keeps an agent-registered directive. The category the agent proposed is confirmed with it, unless the
   * operator gives one (a category id, or null for none).
   */
  review(id: string, actor: Actor, category?: string | null): DirectiveRow {
    const d = this.must(id);
    const cat = category === undefined ? d.category ?? d.proposed_category : checkCategory(category);
    if (!d.reviewed_at) {
      this.db.prepare('UPDATE directives SET reviewed_at=?, category=?, proposed_category=NULL WHERE id=?').run(Date.now(), cat, id);
      this.audit.event(actor, 'directive.review', { kind: 'directive', id }, { category: cat, proposed: d.proposed_category });
    } else if (category !== undefined) this.categorize([id], { category }, actor);
    return this.must(id);
  }
  /** Mark every not-reviewed directive as reviewed (optionally of one agent), confirming the categories agents proposed. */
  reviewAll(actor: Actor, agentId?: string): number {
    const r = this.db.prepare(`UPDATE directives SET reviewed_at=?, category=COALESCE(category, proposed_category), proposed_category=NULL WHERE status='active' AND reviewed_at IS NULL ${agentId ? 'AND reported_by=?' : ''}`).run(...[Date.now(), ...(agentId ? [agentId] : [])]);
    this.audit.event(actor, 'directive.review_all', { kind: 'system', id: 'directives' }, { count: Number(r.changes), agent: agentId ?? null });
    return Number(r.changes);
  }
  /**
   * Merge several directives (usually the same rule reported by several agents) into one with the given title, text
   * and scope. The others retire; their agents are told to follow the merged one, which counts as reviewed.
   */
  merge(ids: string[], a: { title: string; body: string; scope: Scope; category?: string | null; tags?: string[] }, actor: Actor): DirectiveRow {
    const src = ids.map((i) => this.must(i)).filter((x) => x.status === 'active');
    if (src.length < 2) throw err('invalid_argument', 'Choose two or more directives in force to merge.');
    // Unless the operator chose, the merged one takes the category all of them share (set or proposed) and all their tags.
    const cats = [...new Set(src.map((x) => x.category ?? x.proposed_category))];
    const category = a.category !== undefined ? a.category : cats.length === 1 ? cats[0] : null;
    const tags = a.tags ?? src.flatMap((x) => x.tags).slice(0, MAX_TAGS);
    const merged = this.create({ title: a.title, body: a.body, scope: a.scope, category, tags, source: [...new Set(src.map((x) => x.source).filter(Boolean))].join('; ') || 'merged' }, actor, true);
    const now = Date.now(), R = this.resolver();
    for (const x of src) {
      const had = this.reach(x);
      this.db.prepare("UPDATE directives SET status='retired', updated_at=? WHERE id=?").run(now, x.id);
      for (const ag of had) {
        // Settles once the agent confirms the merged one; an agent that one does not reach could not, so its notice settles on its next read.
        const follows = R.applies(merged, ag);
        this.keys.notify(ag.id, 'directive_changed', follows
          ? `Directive "${x.title}" (${x.id}) is merged into "${merged.title}" (${merged.id}, v${merged.version}, for ${this.scopeLabel(merged)}). Follow that one: directives_read {id: "${merged.id}", ack: true}.`
          : `Directive "${x.title}" (${x.id}) is merged into "${merged.title}" (${merged.id}), which does not apply to you. Stop following it.`,
          follows ? confirmRef(merged) : stopRef(x.id));
      }
    }
    this.audit.event(actor, 'directive.merge', { kind: 'directive', id: merged.id }, { from: src.map((x) => x.id) });
    return merged;
  }
  unreviewedCount(): number { return (this.db.prepare("SELECT COUNT(*) n FROM directives WHERE status='active' AND reviewed_at IS NULL").get() as { n: number }).n; }
  /** Directives agents registered that the operator has not reviewed, with the reporter and others reporting the same rule. */
  unreviewed() {
    const rows = this.rows("SELECT * FROM directives WHERE status='active' AND reviewed_at IS NULL ORDER BY created_at");
    return rows.map((d) => ({ ...d, scope_label: this.scopeLabel(d), reported_by_label: d.reported_by ? this.keys.agent(d.reported_by)?.label ?? d.reported_by : null, project: d.reported_by ? this.keys.agent(d.reported_by)?.project ?? null : null, key: normTitle(d.title) }));
  }
  private report_(id: string): ReportRow { const r = this.db.prepare('SELECT * FROM directive_reports WHERE id=?').get(id) as unknown as ReportRow | undefined; if (!r) throw err('not_found', 'report not found'); return r; }
  /** Suggestions waiting for the operator (Home and the Work tab count them with the rules not reviewed). */
  openReportCount(): number { return (this.db.prepare("SELECT COUNT(*) n FROM directive_reports WHERE status='open'").get() as { n: number }).n; }

  // ───── the operator side ─────
  private checkScope(s: Scope): Scope {
    if (s.kind === 'hub') return { kind: 'hub', ref: null };
    const ref = (s.ref ?? '').trim();
    if (!ref) throw err('invalid_argument', 'This scope needs a target.');
    if (s.kind === 'team' && !this.teams.team(ref)) throw err('invalid_argument', 'No such team.');
    if (s.kind === 'role') { const [t, r] = ref.split('|'); if (!this.teams.team(t ?? '') || !r) throw err('invalid_argument', 'A role scope is "<team id>|<role>".'); }
    if (s.kind === 'agent' && !this.keys.agent(ref)) throw err('invalid_argument', 'No such agent.');
    // A project is its id; an older client may send its key or name (docs/directives.md#project-reach).
    if (s.kind === 'project') return { kind: 'project', ref: this.mustProject(ref).id };
    return { kind: s.kind, ref };
  }
  /** Tell every agent the directive reaches about it (new, merged into, changed). */
  private announce(d: DirectiveRow, what: string): void { this.tell(d, what, this.reach(d)); }
  private tell(d: DirectiveRow, what: string, to: Agent[]): void {
    for (const a of to) {
      this.keys.notify(a.id, 'directive_changed', `${what} "${d.title}" (${d.id}, v${d.version}, for ${this.scopeLabel(d)}). Read and confirm it in one call: directives_read {id: "${d.id}", ack: true}.`, confirmRef(d));
    }
  }
  create(a: { title: string; body: string; scope: Scope; source?: string | null; category?: string | null; tags?: string[] }, actor: Actor, quietFor?: boolean): DirectiveRow {
    const title = a.title.trim(), body = a.body.trim();
    if (!title || !body) throw err('invalid_argument', 'A directive needs a title and its text.');
    const s = this.checkScope(a.scope), now = Date.now(), id = `dir_${randomToken(10)}`, category = checkCategory(a.category), tags = normTags(a.tags ?? []);
    tx(this.db, () => {
      this.db.prepare("INSERT INTO directives(id,title,body,scope_kind,scope_ref,version,status,source,created_by,created_at,updated_at,reviewed_at,category,tags) VALUES (?,?,?,?,?,1,'active',?,?,?,?,?,?,?)")
        .run(id, title, body, s.kind, s.ref, a.source ?? null, actor.id, now, now, now, category, JSON.stringify(tags));
      this.version({ id, version: 1, title, body, scope_kind: s.kind, scope_ref: s.ref, category, tags }, 'created', actor.id, now);
    });
    const d = this.must(id);
    this.audit.event(actor, 'directive.create', { kind: 'directive', id }, { title, scope: this.scopeLabel(d), category, tags });
    if (!quietFor) this.announce(d, 'New directive');
    else this.announce(d, 'Directive (merged from rules your team reported)');
    return d;
  }
  /**
   * Edit a directive. Title, text or scope make a new version that covered agents are told about. Category and tags
   * alone are the operator's filing: no new version and no notice (categorize). An edit is a review, so a category the
   * agent proposed is taken unless one is given.
   */
  /**
   * Edit a directive: a new version, and every agent it reaches is told to read it again. minor (the operator's "Minor edit",
   * a typo): the new version is kept and audited, but no agent is told, and an agent that had read the previous version
   * counts as having read this one. A scope change is never minor: who it reaches changes.
   */
  update(id: string, a: { title?: string; body?: string; scope?: Scope; note?: string | null; category?: string | null; tags?: string[]; minor?: boolean }, actor: Actor): DirectiveRow {
    const d = this.must(id);
    if (d.status !== 'active') throw err('invalid_state', 'Retired directives cannot be edited.');
    const title = a.title?.trim() || d.title, body = a.body?.trim() || d.body, s = a.scope ? this.checkScope(a.scope) : { kind: d.scope_kind, ref: d.scope_ref };
    if (title === d.title && body === d.body && s.kind === d.scope_kind && s.ref === d.scope_ref) {
      if (a.category !== undefined || a.tags !== undefined) this.categorize([id], { category: a.category, tags: a.tags }, actor);
      return this.must(id);
    }
    if (a.minor && (s.kind !== d.scope_kind || s.ref !== d.scope_ref)) throw err('invalid_argument', 'A change of who the directive applies to cannot be a minor edit: the agents it reaches are told.');
    const category = a.category !== undefined ? checkCategory(a.category) : d.category ?? (d.reviewed_at ? null : d.proposed_category);
    const tags = a.tags !== undefined ? normTags(a.tags) : d.tags;
    const before = new Set(this.reach(d).map((x) => x.id)), now = Date.now(), v = d.version + 1;
    tx(this.db, () => {
      this.db.prepare('UPDATE directives SET title=?, body=?, scope_kind=?, scope_ref=?, version=?, updated_at=?, reviewed_at=?, category=?, tags=?, proposed_category=NULL WHERE id=?').run(title, body, s.kind, s.ref, v, now, now, category, JSON.stringify(tags), id);
      this.version({ id, version: v, title, body, scope_kind: s.kind, scope_ref: s.ref, category, tags }, a.note ?? null, actor.id, now);
      // A minor edit: whoever had read the previous version stays current (their acknowledgement moves to this version).
      if (a.minor) this.db.prepare('UPDATE directive_acks SET version=? WHERE directive_id=? AND version=?').run(v, id, d.version);
    });
    const nd = this.must(id);
    this.audit.event(actor, 'directive.update', { kind: 'directive', id }, { version: v, note: a.note ?? null, ...(a.minor ? { minor: true } : {}) });
    if (a.minor) return nd;
    // Every agent it reaches now is told; agents the new scope no longer covers are told to stop following it.
    this.reachChange(nd, before, { what: body !== d.body ? `Changed directive${a.note ? ` (${a.note})` : ''}:` : 'Directive now applies to you:', title: d.title });
    return nd;
  }
  /**
   * Set the category (an id, or null for none) and/or the tags of one or more directives: the operator's filing, so no
   * new version and no notice to agents. An explicit category replaces what an agent proposed; the review stays open.
   * addTags adds to each directive's tags instead of replacing them.
   */
  categorize(ids: string[], a: { category?: string | null; tags?: string[]; addTags?: string[] }, actor: Actor): number {
    const cat = a.category === undefined ? undefined : checkCategory(a.category), tags = a.tags ? normTags(a.tags) : undefined, add = a.addTags ? normTags(a.addTags) : [];
    const L = [...new Set(ids)].map((i) => this.must(i));
    let n = 0;
    tx(this.db, () => {
      for (const d of L) {
        const nc = cat === undefined ? d.category : cat, nt = normTags([...(tags ?? d.tags), ...add]);
        if (nc === d.category && JSON.stringify(nt) === JSON.stringify(d.tags) && (cat === undefined || !d.proposed_category)) continue;
        this.db.prepare(`UPDATE directives SET category=?, tags=?${cat === undefined ? '' : ', proposed_category=NULL'} WHERE id=?`).run(nc, JSON.stringify(nt), d.id);
        n++;
      }
    });
    if (n) this.audit.event(actor, 'directive.categorize', L.length === 1 ? { kind: 'directive', id: L[0]!.id } : { kind: 'system', id: 'directives' }, { ids: L.map((d) => d.id), category: cat ?? null, tags: tags ?? null, add_tags: add.length ? add : null, changed: n });
    return n;
  }
  retire(id: string, note: string | null, actor: Actor): DirectiveRow {
    const d = this.must(id);
    if (d.status === 'retired') return d;
    const had = this.reach(d);
    this.db.prepare("UPDATE directives SET status='retired', updated_at=? WHERE id=?").run(Date.now(), id);
    for (const a of had) this.keys.notify(a.id, 'directive_changed', `Directive "${d.title}" (${id}) is retired${note ? `: ${note}` : ''}. Stop following it.`, stopRef(id));
    this.audit.event(actor, 'directive.retire', { kind: 'directive', id }, { note });
    return this.must(id);
  }

  // ───── exemptions: keep a directive off an agent, a team or a project ─────
  /** A row of directive_exemptions with what the console shows for its target. */
  private exemptionRows(directiveId?: string, active = true): (ExemptionRow & { label: string; created_by_label: string | null; removed_by_label: string | null })[] {
    const rows = this.db.prepare(`SELECT * FROM directive_exemptions WHERE ${active ? 'removed_at IS NULL' : 'removed_at IS NOT NULL'} ${directiveId ? 'AND directive_id=?' : ''} ORDER BY created_at, id`)
      .all(...(directiveId ? [directiveId] : [])) as unknown as ExemptionRow[];
    const who = (id: string | null): string | null => {
      if (!id) return null;
      const u = this.db.prepare('SELECT COALESCE(display_name, username) AS n FROM admin_users WHERE id=?').get(id) as { n: string } | undefined;
      return u?.n ?? null;
    };
    return rows.map((r) => ({ ...r, label: this.targetLabel(r.target_kind, r.target_ref), created_by_label: who(r.created_by), removed_by_label: who(r.removed_by) }));
  }
  /** "team ECHO Research", "agent scribe", "project APPS": how an exemption target reads. */
  targetLabel(kind: ExemptionKind, ref: string): string {
    return kind === 'team' ? `team ${this.teams.team(ref)?.name ?? ref}` : kind === 'agent' ? `agent ${this.keys.agent(ref)?.label ?? ref}` : `project ${this.projectName(ref)}`;
  }
  /** Who a directive is for, in words: its scope minus its active exemptions ("All agents except team ECHO Research"). */
  reachLabel(d: { scope_kind: ScopeKind; scope_ref: string | null }, exemptions: { label: string }[]): string {
    const s = this.scopeLabel(d), ex = this.exceptLabel(exemptions);
    return s.charAt(0).toUpperCase() + s.slice(1) + (ex ? ` e${ex.slice(1)}` : '');
  }
  /** What the exemptions add to the scope on their own: "Except team ECHO Research", or '' when nothing is kept off. */
  exceptLabel(exemptions: { label: string }[]): string {
    const L = exemptions.map((x) => x.label);
    return L.length ? `Except ${L.length > 1 ? `${L.slice(0, -1).join(', ')} and ${L[L.length - 1]}` : L[0]}` : '';
  }
  /**
   * Keep a directive off one agent, the members of a team or the members of a project's live teams (docs/directives.md). No new
   * version and no ack reset: the audit is the record. Agents it no longer reaches get one notice to stop following it.
   * Refused for an agent-scoped directive (retire it instead), for the directive's own scope target, for an unknown
   * target, for a target already kept off, for a target outside the scope (no agent the scope covers is in it; a hub
   * scope is never refused this way, as it covers every agent a project or team may gain), and for a retired directive.
   */
  exempt(id: string, t: { kind: ExemptionKind; ref: string; note?: string | null }, actor: Actor): { exemption: ExemptionRow & { label: string }; directive: DirectiveRow; gained: number; lost: number } {
    const d = this.must(id);
    if (d.status !== 'active') throw err('invalid_state', 'A retired directive is in force for nobody: there is nothing to keep it off.');
    if (d.scope_kind === 'agent') throw err('invalid_argument', 'This directive is for one agent: retire it instead.');
    let ref = (t.ref ?? '').trim();
    const note = t.note?.trim() || null;
    if (!ref) throw err('invalid_argument', 'Name the agent, team or project to keep it off.');
    if (!['agent', 'team', 'project'].includes(t.kind)) throw err('invalid_argument', 'A directive can be kept off an agent, a team or a project.');
    if (t.kind === 'project') ref = this.mustProject(ref).id;
    if (t.kind === d.scope_kind && ref === d.scope_ref) throw err('invalid_argument', 'That is the directive\'s own scope: retire it or change its scope instead.');
    if (t.kind === 'team' && !this.teams.team(ref)) throw err('invalid_argument', 'No such team.');
    if (t.kind === 'agent' && !this.keys.agent(ref)) throw err('invalid_argument', 'No such agent.');
    if (this.db.prepare('SELECT 1 FROM directive_exemptions WHERE directive_id=? AND target_kind=? AND target_ref=? AND removed_at IS NULL').get(id, t.kind, ref)) {
      throw err('conflict', `It is already kept off ${this.targetLabel(t.kind, ref)}.`);
    }
    if (d.scope_kind !== 'hub') {
      const R = this.resolver(), scope = { kind: d.scope_kind, ref: d.scope_ref }, x = { kind: t.kind, ref };
      if (!this.keys.agents().some((a) => R.covers(scope, a) && R.matches(x, a))) {
        throw err('invalid_argument', `Keeping it off ${this.targetLabel(t.kind, ref)} changes nothing: no agent there is in ${this.scopeLabel(d)}.`);
      }
    }
    const before = new Set(this.reach(d).map((a) => a.id)), xid = `dex_${randomToken(10)}`;
    // One transaction: the exemption, its notices and the audit row (the only record of it) land together or not at all.
    const r = tx(this.db, () => {
      this.db.prepare('INSERT INTO directive_exemptions(id,directive_id,target_kind,target_ref,note,created_by,created_at) VALUES (?,?,?,?,?,?,?)').run(xid, id, t.kind, ref, note, actor.id, Date.now());
      const c = this.reachChange(d, before);
      this.audit.event(actor, 'directive.exempt', { kind: 'directive', id }, { target_kind: t.kind, target_ref: ref, note, gained: c.gained, lost: c.lost });
      return c;
    });
    return { exemption: this.exemptionRows(id).find((x) => x.id === xid)!, directive: this.must(id), ...r };
  }
  /** Apply a directive again where an exemption kept it off: the exemption is soft-removed, and agents it reaches again are told. */
  unexempt(id: string, exemptionId: string, actor: Actor): { directive: DirectiveRow; gained: number } {
    const d = this.must(id);
    const x = this.db.prepare('SELECT * FROM directive_exemptions WHERE id=? AND directive_id=? AND removed_at IS NULL').get(exemptionId, id) as unknown as ExemptionRow | undefined;
    if (!x) throw err('not_found', 'No such exemption in force for this directive.');
    if (d.status !== 'active') throw err('invalid_state', 'A retired directive is in force for nobody: its exemptions stay as history.');
    const before = new Set(this.reach(d).map((a) => a.id));
    const r = tx(this.db, () => {
      this.db.prepare('UPDATE directive_exemptions SET removed_at=?, removed_by=? WHERE id=?').run(Date.now(), actor.id, exemptionId);
      const c = this.reachChange(d, before);
      this.audit.event(actor, 'directive.unexempt', { kind: 'directive', id }, { target_kind: x.target_kind, target_ref: x.target_ref, note: x.note, gained: c.gained, lost: c.lost });
      return c;
    });
    return { directive: this.must(id), gained: r.gained };
  }

  /**
   * Adopt a suggestion: a new directive (by default for the reporter's team, with the category it proposed) or a link to
   * an existing one. The same suggestion from other members of that team closes with it, and every reporter is told.
   */
  adopt(reportId: string, a: { title?: string; body?: string; scope?: Scope; directive_id?: string; category?: string | null }, actor: Actor): { report: ReportRow; directive: DirectiveRow; merged: number } {
    const r = this.report_(reportId);
    if (r.status !== 'open') throw err('invalid_state', `The report is ${r.status}.`);
    const team = r.team_id && this.teams.team(r.team_id) ? r.team_id : null;
    let d: DirectiveRow;
    if (a.directive_id) d = this.must(a.directive_id);
    else {
      const body = a.body?.trim() || r.text?.trim() || r.summary?.trim() || ''; // one-click Adopt (Needs you) sends no text: the summary every report has stands in
      if (!body) throw err('invalid_argument', 'Give the directive\'s text: the agent did not send it.');
      d = this.create({ title: a.title?.trim() || r.title, body, scope: a.scope ?? (team ? { kind: 'team', ref: team } : { kind: 'agent', ref: r.agent_id }),
        source: r.source ?? `reported by ${this.keys.agent(r.agent_id)?.label ?? r.agent_id}`, category: a.category !== undefined ? a.category : r.category }, actor);
    }
    const now = Date.now();
    const same = team ? (this.db.prepare("SELECT * FROM directive_reports WHERE status='open' AND team_id=? AND id<>?").all(team, r.id) as unknown as ReportRow[]).filter((x) => normTitle(x.title) === normTitle(r.title)) : [];
    tx(this.db, () => {
      this.db.prepare("UPDATE directive_reports SET status=?, directive_id=?, decided_at=? WHERE id=?").run(a.directive_id ? 'known' : 'adopted', d.id, now, reportId);
      for (const x of same) this.db.prepare("UPDATE directive_reports SET status='known', directive_id=?, decided_at=? WHERE id=?").run(d.id, now, x.id);
    });
    // Only reporters the directive reaches are told to follow it: for the rest (out of scope, exempted, retired) directives_read would answer not_found.
    const R = this.resolver();
    for (const x of [r, ...same]) {
      const ag = this.keys.agent(x.agent_id);
      if (ag && R.applies(d, ag)) this.keys.notify(x.agent_id, 'directive_changed', `${l2(x.title)}, which you reported following, is now hub directive ${d.id} ("${d.title}", v${d.version}, for ${this.scopeLabel(d)}). Follow the hub's version from now on: directives_read {id: "${d.id}", ack: true}.`, confirmRef(d));
      else this.keys.notify(x.agent_id, 'directive_changed', `The operator recorded ${l2(x.title)}, which you reported following, as hub directive ${d.id}. It does not apply to you.`, stopRef(d.id));
    }
    this.audit.event(actor, 'directive.report_adopt', { kind: 'directive_report', id: reportId }, { directive: d.id, merged: same.map((x) => x.id) });
    return { report: this.report_(reportId), directive: d, merged: same.length };
  }
  /** The operator does not want this rule followed: the reporter is told to stop. */
  dismiss(reportId: string, note: string | null, actor: Actor): ReportRow {
    const r = this.report_(reportId);
    if (r.status !== 'open') throw err('invalid_state', `The report is ${r.status}.`);
    this.db.prepare("UPDATE directive_reports SET status='retired', note=?, decided_at=? WHERE id=?").run(note, Date.now(), reportId);
    this.keys.notify(r.agent_id, 'directive_changed', `Stop following ${l2(r.title)}${r.source ? ` (${l2(r.source)})` : ''}: the operator retired it${note ? `: ${note}` : '.'}`, stopRef(reportId));
    this.audit.event(actor, 'directive.report_retire', { kind: 'directive_report', id: reportId }, { note });
    return this.report_(reportId);
  }

  // ───── views for the console ─────
  /** Each directive with how many covered agents read the current version. */
  list(status: 'active' | 'retired' | 'all' = 'active', f: DirectiveFilter = {}) { return this.listed(status, f).map(({ row }) => row); }
  /** list()'s rows with the coverage each was counted from, so callers that need it do not resolve reach again. */
  private listed(status: 'active' | 'retired' | 'all', f: DirectiveFilter = {}, R: Reach = this.resolver()) {
    const rows = this.rows(`SELECT * FROM directives ${status === 'all' ? '' : 'WHERE status=?'} ORDER BY status, updated_at DESC`, ...(status === 'all' ? [] : [status])).filter((d) => filterMatch(d, f));
    const ex = new Map<string, (ExemptionRow & { label: string })[]>();
    for (const x of this.exemptionRows()) { const l = ex.get(x.directive_id) ?? []; l.push(x); ex.set(x.directive_id, l); }
    return rows.map((d) => { const c = this.coverage(d, R), dx = ex.get(d.id) ?? []; return { cov: c, exemptions: dx, row: { ...d, scope_label: this.scopeLabel(d), reach_label: this.reachLabel(d, dx), except_label: this.exceptLabel(dx), exempt_count: dx.length, reported_by_label: d.reported_by ? this.keys.agent(d.reported_by)?.label ?? d.reported_by : null, agents: c.length, current: c.filter((x) => x.read === 'current').length, outdated: c.filter((x) => x.read === 'outdated').length, unread: c.filter((x) => x.read === 'unread').length } }; });
  }
  coverage(d: DirectiveRow, R: Reach = this.resolver()): { agent_id: string; label: string; read: 'current' | 'outdated' | 'unread'; version: number | null; acked_at: number | null }[] {
    const acks = new Map((this.db.prepare('SELECT agent_id, version, acked_at FROM directive_acks WHERE directive_id=?').all(d.id) as { agent_id: string; version: number; acked_at: number }[]).map((r) => [r.agent_id, r]));
    return R.reach(d).map((a) => { const k = acks.get(a.id);
      return { agent_id: a.id, label: a.label, read: !k ? 'unread' as const : k.version >= d.version ? 'current' as const : 'outdated' as const, version: k?.version ?? null, acked_at: k?.acked_at ?? null }; });
  }
  /** Agent id → its live teams (not done or stopped), by team name: id, name and the agent's role in it. */
  private memberTeams(): Map<string, { id: string; name: string; role: string }[]> {
    const rows = this.db.prepare("SELECT m.agent_id a, t.id, t.name, m.role FROM team_members m JOIN teams t ON t.id=m.team_id WHERE m.removed_at IS NULL AND t.status NOT IN ('done','stopped') ORDER BY t.name, t.id").all() as { a: string; id: string; name: string; role: string }[];
    const out = new Map<string, { id: string; name: string; role: string }[]>();
    for (const r of rows) { const l = out.get(r.a) ?? []; if (!l.some((x) => x.id === r.id)) l.push({ id: r.id, name: r.name, role: r.role }); out.set(r.a, l); }
    return out;
  }
  detail(id: string) {
    const d = this.must(id);
    const same = d.status === 'active' ? (this.db.prepare("SELECT id, title, reported_by, scope_kind, scope_ref FROM directives WHERE status='active' AND id<>?").all(id) as { id: string; title: string; reported_by: string | null; scope_kind: ScopeKind; scope_ref: string | null }[]).filter((x) => normTitle(x.title) === normTitle(d.title)).map((x) => ({ ...x, reported_by_label: x.reported_by ? this.keys.agent(x.reported_by)?.label ?? x.reported_by : null, scope_label: this.scopeLabel(x) })) : [];
    // Exemptions stay listed after a retire or a merge, as history; a retired directive reaches nobody anyway.
    const exemptions = this.exemptionRows(id), removed = this.exemptionRows(id, false);
    // kept_off: agents the scope covers that an exemption keeps it off ("Agents · x of y read · n kept off").
    const R = this.resolver(), scope = { kind: d.scope_kind, ref: d.scope_ref };
    const keptOff = d.status === 'active' && exemptions.length ? this.keys.agents().filter((a) => R.covers(scope, a) && !R.applies(d, a)).length : 0;
    // Each covered agent's live teams and its role there, so the console can filter the agent list by team and search by role.
    const cov = d.status === 'active' ? this.coverage(d, R) : [], tm = cov.length ? this.memberTeams() : new Map();
    return { same, directive: { ...d, scope_label: this.scopeLabel(d), reach_label: this.reachLabel(d, exemptions), except_label: this.exceptLabel(exemptions), reported_by_label: d.reported_by ? this.keys.agent(d.reported_by)?.label ?? d.reported_by : null },
      coverage: cov.map((c) => ({ ...c, teams: tm.get(c.agent_id) ?? [] })),
      exemptions, exemptions_removed: removed, exempt_count: exemptions.length, kept_off: keptOff,
      versions: this.db.prepare('SELECT version, title, change_note, created_at, category, tags FROM directive_versions WHERE directive_id=? ORDER BY version DESC').all(id).map((v: any) => ({ ...v, tags: (() => { try { return JSON.parse(v.tags || '[]'); } catch { return []; } })() })),
      reports: this.db.prepare('SELECT * FROM directive_reports WHERE directive_id=? ORDER BY created_at DESC').all(id) };
  }
  reports(status: 'open' | 'all' = 'open') {
    const rows = this.db.prepare(`SELECT * FROM directive_reports ${status === 'open' ? "WHERE status='open'" : ''} ORDER BY created_at DESC LIMIT 200`).all() as unknown as ReportRow[];
    return rows.map((r) => ({ ...r, agent_label: this.keys.agent(r.agent_id)?.label ?? r.agent_id, project: this.keys.agent(r.agent_id)?.project ?? null, team_label: r.team_id ? this.teams.team(r.team_id)?.name ?? null : null }));
  }
  /** For the agent screen: in force with read state, plus open and decided reports by that agent. */
  agentView(agentId: string) {
    // Directives whose scope covers the agent but an exemption keeps off it: "why does this agent not have rule X".
    const a = this.keys.agent(agentId), R = this.resolver(), ex = this.exemptionRows();
    const exempted = !a ? [] : this.rows("SELECT * FROM directives WHERE status='active' ORDER BY created_at").filter((d) => R.covers({ kind: d.scope_kind, ref: d.scope_ref }, a) && !R.applies(d, a)).map((d) => {
      const x = ex.find((e) => e.directive_id === d.id && R.covers({ kind: e.target_kind, ref: e.target_ref }, a))!;
      return { id: d.id, title: d.title, scope_label: this.scopeLabel(d), exemption: { id: x.id, kind: x.target_kind, ref: x.target_ref, label: x.label, note: x.note, created_by: x.created_by, created_at: x.created_at } };
    });
    return { exempted, directives: this.forAgent(agentId).map((d) => ({ id: d.id, title: d.title, version: d.version, scope_label: this.scopeLabel(d), acked_version: d.acked_version, acked_at: d.acked_at, reported_by: d.reported_by ?? null, reviewed: !!d.reviewed_at, category: d.category, tags: d.tags })),
      reports: this.db.prepare('SELECT * FROM directive_reports WHERE agent_id=? ORDER BY created_at DESC LIMIT 50').all(agentId) };
  }
  /**
   * For the team screen (#tdirs): the directives whose scope takes in one of the team's members, each on one tab.
   * `team` holds this team's, its roles' and its members' projects' rules, `members` the rules for one member, `hub`
   * the hub-wide ones. `group` keeps the finer kind (team, role, project, member, hub). Other teams' and roles' rules
   * belong to those teams and are left out.
   *
   * A row is in force here when it reaches at least one member. A row whose scope takes in members but that exemptions
   * keep off all of them is still returned, with `exempt_here` naming one exemption that does it (this team's own
   * first), so the operator can apply it again; `own` says whether it is this team's own exemption (otherwise lifting it
   * reaches agents outside the team). In-force rows have `exempt_here` null. An agent-scoped row is a copy (`copy_of`,
   * with the copied rule's `scope_kind`) when a team, role or hub rule in force for that agent has the same normalised title.
   * count, behind and open_reports count this team's in-force rows (hub-wide left out); hub and hub_behind the in-force
   * hub-wide rows; hub_exempt the hub-wide rows kept off this team; copies the member rows that copy another rule.
   */
  teamView(teamId: string) {
    const R = this.resolver();
    const members = this.teams.members(teamId).map((m) => this.keys.agent(m.agent_id)).filter((a): a is Agent => !!a);
    const ids = new Set(members.map((a) => a.id));
    const group = (d: DirectiveRow): 'team' | 'role' | 'member' | 'project' | 'hub' | null =>
      d.scope_kind === 'hub' ? 'hub' : d.scope_kind === 'team' ? (d.scope_ref === teamId ? 'team' : null)
        : d.scope_kind === 'role' ? (String(d.scope_ref).split('|')[0] === teamId ? 'role' : null)
          : d.scope_kind === 'agent' ? 'member' : 'project';
    const tabOf = (g: 'team' | 'role' | 'member' | 'project' | 'hub'): 'team' | 'members' | 'hub' => g === 'hub' ? 'hub' : g === 'member' ? 'members' : 'team';
    // This team's own exemption reads best ("Not for this team"); then a project, one agent, another team.
    const pref = (e: ExemptionRow) => e.target_kind === 'team' && e.target_ref === teamId ? 0 : ({ project: 1, agent: 2, team: 3 } as const)[e.target_kind];
    const listed = this.listed('active', {}, R);
    const L = listed.flatMap(({ row: d, cov, exemptions }) => {
      const g = group(d);
      if (!g) return [];
      const scoped = members.filter((a) => R.covers({ kind: d.scope_kind, ref: d.scope_ref }, a));
      if (!scoped.length) return [];
      const here = cov.filter((c) => ids.has(c.agent_id));
      let exempt_here: { id: string; kind: ExemptionKind; label: string; own: boolean } | null = null;
      if (!here.length) {
        // Edge case, kept as the spec reads: a match on any scoped member marks the row, even when the other members are
        // out of coverage for another reason (a revoked agent, say), so "apply again" may not bring it back for all.
        const x = exemptions.filter((e) => scoped.some((a) => R.matches({ kind: e.target_kind, ref: e.target_ref }, a))).sort((p, q) => pref(p) - pref(q))[0];
        if (!x) return [];
        exempt_here = { id: x.id, kind: x.target_kind, label: x.label, own: pref(x) === 0 };
      }
      return [{ d, g, cov: here, exempt_here }];
    });
    // Copies: a rule for one member that a team, role or hub rule in force for that member already says.
    const rank = (d: DirectiveRow) => d.scope_kind === 'team' && d.scope_ref === teamId ? 0 : d.scope_kind === 'role' && String(d.scope_ref).split('|')[0] === teamId ? 1 : d.scope_kind === 'hub' ? 2 : 3;
    const wide = listed.map((x) => x.row).filter((d) => d.scope_kind === 'team' || d.scope_kind === 'role' || d.scope_kind === 'hub');
    const copyOf = (d: DirectiveRow): { id: string; title: string; scope_kind: string; scope_label: string } | null => {
      const a = d.scope_kind === 'agent' ? members.find((m) => m.id === d.scope_ref) : undefined;
      if (!a) return null;
      const t = normTitle(d.title);
      const c = wide.filter((w) => normTitle(w.title) === t && R.applies(w, a)).sort((p, q) => rank(p) - rank(q))[0];
      return c ? { id: c.id, title: c.title, scope_kind: c.scope_kind, scope_label: c.scope_label } : null;
    };
    const rows = L.map((x) => ({ ...x, copy_of: x.exempt_here ? null : copyOf(x.d) }));
    const lag = (x: (typeof rows)[number]) => x.cov.filter((c) => c.read !== 'current').length;
    const live = rows.filter((x) => !x.exempt_here);
    const own = live.filter((x) => x.g !== 'hub'), hub = live.filter((x) => x.g === 'hub');
    return {
      count: own.length, behind: own.reduce((n, x) => n + lag(x), 0), hub: hub.length, hub_behind: hub.reduce((n, x) => n + lag(x), 0),
      hub_exempt: rows.filter((x) => x.g === 'hub' && x.exempt_here).length, copies: rows.filter((x) => x.copy_of).length,
      // Rules members registered before suggestions (not reviewed), plus the suggestions this team's members filed.
      open_reports: own.filter((x) => x.d.reported_by && !x.d.reviewed_at).length + (this.db.prepare("SELECT COUNT(*) n FROM directive_reports WHERE status='open' AND team_id=?").get(teamId) as { n: number }).n,
      directives: rows.map(({ d, g, cov, exempt_here, copy_of }) => ({ id: d.id, title: d.title, body: d.body, version: d.version, scope_kind: d.scope_kind, scope_label: d.scope_label, reach_label: d.reach_label, group: g, tab: tabOf(g), exempt_here, copy_of, category: d.category, tags: d.tags,
        reported_by: d.reported_by, reported_by_label: d.reported_by_label, reviewed_at: d.reviewed_at ?? null, agents: cov.length, current: cov.filter((c) => c.read === 'current').length, updated_at: d.updated_at })),
    };
  }
}
