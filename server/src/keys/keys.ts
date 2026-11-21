/**
 * Keys & identities (SPECIFICATION F1, ADR-0012).
 *   app key      ah_app_<keyid>_<secret>  one per app per PC, in the app's MCP config
 *   session key  ah_ses_<keyid>_<secret>  one per agent session, pasted in chat
 *   token        ah_tok_<secret>          returned by session_login, passed on every call
 * Only an HMAC of each secret is stored. Key ids are public and used for lookup.
 */
import { plainNotice } from '../notices/l2.js';
import type { Db } from '../db/db.js';
import { tx } from '../db/db.js';
import { hmacHex, randomToken, safeEqualHex, sha256Hex } from '../util/crypto.js';
import { newId } from '../util/ids.js';
import type { Rule } from '../policy/engine.js';
import { describeRuleChanges, validateRules } from '../policy/engine.js';
import type { Audit, Actor } from '../audit/audit.js';
import { isAdmin } from '../audit/audit.js';
import { inForceSql } from '../directives/reachSql.js';

export type KeyKind = 'app_key' | 'session_key';
export type KeyStatus = 'active' | 'suspended' | 'revoked';

export interface Credential {
  id: string; kind: KeyKind; agent_id: string | null; machine_id: string | null; app_name: string | null;
  label: string; key_id: string; status: KeyStatus; status_reason: string | null; expires_at: number | null;
  replaces_credential_id: string | null; policy_id: string; max_live_sessions: number;
  /** Session keys only: the one PC this key may log in from (through an app key on it); null is free. */
  bound_machine_id: string | null;
  /** App keys only: when the onboarding capability was turned on (docs/onboarding.md); null is off. */
  onboarding_enabled_at: number | null;
  /** Session keys only: a checkout issued a successor (docs/checkout.md §5). 'superseded_pending': not confirmed, this key
   *  still works. 'suspended': the successor was confirmed; this key cannot log in and its tokens are suspended. */
  succession?: 'superseded_pending' | 'suspended' | null;
  /** Session keys only: the variable in keys.env that holds it on its PC (key prompts); null until the hub needs one. */
  session_var?: string | null;
  created_at: number; first_used_at: number | null; last_used_at: number | null; revoked_at: number | null;
}
export interface Agent {
  id: string; label: string; project: string | null; model_label: string | null; role: string | null; role_detail: string | null;
  role_source: 'agent' | 'admin' | null; role_note: string | null; status_text: string | null; status: string; created_at: number; last_seen_at: number | null; archived_at?: number | null;
  /** The agent's first and latest call other than the helper's session_login and session_whoami (migration 0144). */
  connected_at?: number | null; last_active_at?: number | null;
  recruited_team_id?: string | null; recruited_by?: string | null;
  /** The console user who owns the agent (docs/authorization.md#agent-owners); null: unowned. */
  owner_user_id?: string | null;
}
/** The admin's claim of the agents that had no owner (Settings → Agent owners), as system_settings keeps it. */
export interface OwnerClaim { by: string; at: number; agents: number }
const CLAIM_KEY = 'agent_owner.claim', ENFORCE_KEY = 'agent_owner.enforcement';
export interface Machine { id: string; name: string; description: string | null; status: string; created_at: number; os?: string | null; setup_status?: string; bridge_version?: string | null; bridge_last_seen_at?: number | null }
export interface Notice { id: string; agent_id: string; seq: number; kind: string; body: string; created_at: number; ref_kind?: string | null; ref_id?: string | null; l2?: string[] }

/** The default and the largest limit of live logins on one app key. A new app key starts at the default. */
export const DEFAULT_LIVE_LOGINS = 100, MAX_LIVE_LOGINS = 500;
/** A session key keeps the old stored value: the limit is read from the app key, and the column default of 100 is for app keys only. */
export const SESSION_KEY_LIVE_LOGINS = 20;
const CRED_COLS = 'id,kind,agent_id,machine_id,app_name,label,key_id,status,status_reason,expires_at,replaces_credential_id,policy_id,max_live_sessions,bound_machine_id,onboarding_enabled_at,succession,session_var,created_at,first_used_at,last_used_at,revoked_at';
/** The status reason of a session key held by a leak rotation that is not confirmed yet (Keys.hold). */
export const LEAK_HOLD = 'leak_hold';
/** The variable names a session key may be kept under on its PC (keys.env, and the connector's key file). */
export const SESSION_VAR_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
/** A key handover's pickup secret: its public key id and the verifier the hub keeps until confirm. */
export interface StagedSecret { keyId: string; verifier: string }
export const TOKEN_IDLE_MS = 60 * 60 * 1000;
/** A turn token lives this long unless the connector renews it (docs/connector.md, "Isolation levels"). */
export const TURN_TOKEN_MS = 15 * 60 * 1000;
/** What a notice is about (agent_notices.ref_kind, 0106): its settler says when it stops describing the current state. */
export type NoticeRefKind = 'task' | 'feedback' | 'directive' | 'directive_stop' | 'checkout';
/** notify()'s ref: the one shape, or the two older ones (`{task, state}`, `{feedback, rev}`) that callers still pass. */
export type NoticeRef = { kind: NoticeRefKind; id: string; state?: string | number | null } | { task: string; state: string } | { feedback: string; rev: number };
/**
 * One SQL condition per ref kind, on agent_notices n: "this notice still describes the current state". A notice whose
 * condition no longer holds is settled: skipped, never acked, so the cumulative cursor clears nothing else.
 * - task: the task is still in the state the notice describes.
 * - feedback: the report's status_rev is still the one the notice describes.
 * - directive: the directive is still in force for the agent (the same rule as Directives.applies(), reachSql.ts) and the
 *   agent has not confirmed this version or a later one (ref_state is the version, as TEXT).
 * - directive_stop: the agent has not called directives_read since the notice was made. Strictly after: a read in the
 *   same millisecond may have come before it, and a stop notice must not be lost.
 */
export const NOTICE_SETTLERS: Record<NoticeRefKind, string> = {
  task: 'EXISTS (SELECT 1 FROM tasks k WHERE k.id=n.ref_id AND k.status=n.ref_state)',
  feedback: 'EXISTS (SELECT 1 FROM feedback_reports f WHERE f.id=n.ref_id AND CAST(f.status_rev AS TEXT)=n.ref_state)',
  directive: `EXISTS (SELECT 1 FROM directives d JOIN agents ag ON ag.id=n.agent_id WHERE d.id=n.ref_id AND ${inForceSql('d', 'ag')})
    AND NOT EXISTS (SELECT 1 FROM directive_acks a WHERE a.directive_id=n.ref_id AND a.agent_id=n.agent_id AND a.version>=CAST(n.ref_state AS INTEGER))`,
  directive_stop: 'NOT EXISTS (SELECT 1 FROM directive_reads r WHERE r.agent_id=n.agent_id AND r.read_at>n.created_at)',
  // "Stop taking new work" (checkout_requested) holds only until the move starts: a restored agent never gets it again.
  checkout: "EXISTS (SELECT 1 FROM checkouts c WHERE c.id=n.ref_id AND c.status IN ('collecting','ready','rendered'))",
};
const REF_KINDS = Object.keys(NOTICE_SETTLERS) as NoticeRefKind[];
/**
 * Legacy-shaped rows (ref_kind NULL, ref_task_id or ref_feedback_id set) are written by pre-0106 code after a rollback
 * and kept on the next upgrade. They settle by the old columns, so they never ride along until session_ack.
 */
const LEGACY_SETTLERS = `(n.ref_kind IS NULL AND n.ref_task_id IS NOT NULL AND EXISTS (SELECT 1 FROM tasks k WHERE k.id=n.ref_task_id AND k.status=n.ref_state))
  OR (n.ref_kind IS NULL AND n.ref_task_id IS NULL AND n.ref_feedback_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM feedback_reports f WHERE f.id=n.ref_feedback_id AND CAST(f.status_rev AS TEXT)=n.ref_state))`;
/** SQL condition on agent_notices n: no ref (or a kind this hub does not know), or its settler says it is still current. */
const CURRENT_NOTICE = `((n.ref_kind IS NULL AND n.ref_task_id IS NULL AND n.ref_feedback_id IS NULL)
  OR n.ref_kind NOT IN (${REF_KINDS.map((k) => `'${k}'`).join(',')})
  OR ${LEGACY_SETTLERS}
  OR ${REF_KINDS.map((k) => `(n.ref_kind='${k}' AND ${NOTICE_SETTLERS[k]})`).join('\n  OR ')})`;
const KEY_RE = /^ah_(app|ses)_([a-z2-7]{12})_([a-z2-7]{32})$/;
const TOKEN_RE = /^ah_tok_([a-z2-7]{40})$/;

export class KeyError extends Error {
  constructor(public readonly code: string, message: string, public readonly extra?: Record<string, unknown>) { super(message); }
}
/** A bound session key presented through an app key on another PC (or on none). Callers report it as an invalid key. */
export class BoundElsewhereError extends KeyError {
  constructor(public readonly credential: Credential, public readonly app: Credential) { super('bound_elsewhere', 'this session key is bound to another PC'); }
}

export class Keys {
  constructor(private readonly db: Db, private readonly pepper: string, private readonly audit: Audit) {}

  // ───────────── Agents and PCs ─────────────
  /**
   * `owner`: the console user who owns the new agent, as the admin named it or as a path carries it on (a recruit gets
   * its coordinator's owner). Never inferred. A named owner must be an active console user; a `carried` one is the
   * source agent's recorded owner, kept as it is, so a path that worked before owners existed is not refused by them
   * (owner enforcement decides what such an agent may do). Omitted or null: unowned.
   */
  createAgent(label: string, project: string | null, actor: Actor, owner: string | null = null, o: { carried?: boolean } = {}): Agent {
    // Only the admin (by hand or by approving onboarding) or the hub itself makes an agent, never a member or an agent; a
    // recruit is made for its coordinator and carries that coordinator's owner, never one the caller names.
    if (!o.carried && actor.kind !== 'system' && !isAdmin(actor)) throw new KeyError('admin_only', 'Only an admin can do this.');
    if (owner && !o.carried) this.checkOwner(owner);
    const id = newId.agent();
    this.db.prepare('INSERT INTO agents(id,label,project,created_at,owner_user_id) VALUES (?,?,?,?,?)').run(id, label, project, Date.now(), owner);
    this.audit.event(actor, 'agent.create', { kind: 'agent', id }, { label, project, ...(owner ? { owner } : {}) });
    return this.agent(id)!;
  }

  // ───────────── Agent owners (docs/authorization.md#agent-owners) ─────────────
  /** An owner is an active console user that exists: anything else is refused, so an owner is never a guess. */
  checkOwner(userId: string): void {
    const u = this.db.prepare('SELECT status, expires_at FROM admin_users WHERE id=?').get(userId) as { status: string; expires_at: number | null } | undefined;
    if (!u) throw new KeyError('invalid_argument', 'The owner must be a console user.');
    if (u.status !== 'active' || (u.expires_at !== null && u.expires_at <= Date.now())) throw new KeyError('invalid_state', 'The owner must be an active console user.');
  }
  /**
   * Directive reach follows the owner's grant while owner enforcement is on (docs/directives.md#project-reach): runs an
   * owner or enforcement change, then tells these agents what directives they gained or lost (Directives.refresh).
   */
  reachGuard?: <T>(agentIds: string[], fn: () => T) => T;
  private reached<T>(agentIds: string[], fn: () => T): T { return this.reachGuard ? this.reachGuard(agentIds, fn) : fn(); }
  /** Only the admin assigns or changes an owner; null clears it. */
  setOwner(agentId: string, owner: string | null, actor: Actor): Agent { return this.reached([agentId], () => this.setOwner_(agentId, owner, actor)); }
  private setOwner_(agentId: string, owner: string | null, actor: Actor): Agent {
    if (!isAdmin(actor)) throw new KeyError('admin_only', 'Only an admin can do this.');
    const a = this.agent(agentId); if (!a) throw new KeyError('not_found', 'agent not found');
    if (owner) this.checkOwner(owner);
    if ((a.owner_user_id ?? null) === owner) return a;
    this.db.prepare('UPDATE agents SET owner_user_id=? WHERE id=?').run(owner, agentId);
    this.audit.event(actor, 'agent.owner', { kind: 'agent', id: agentId }, { from: a.owner_user_id ?? null, to: owner });
    return this.agent(agentId)!;
  }
  private setting<T>(key: string): T | null {
    const r = this.db.prepare('SELECT value FROM system_settings WHERE key=?').get(key) as { value: string } | undefined;
    return r ? JSON.parse(r.value) as T : null;
  }
  private putSetting(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO system_settings(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at').run(key, JSON.stringify(value), Date.now());
  }
  /**
   * Claim all existing agents as mine: the signed-in admin becomes the owner of every unowned agent (archived ones too).
   * Agents with an owner keep it. The admin's act only, recorded and audited; it may run again for agents unowned since.
   */
  claimUnowned(actor: Actor): OwnerClaim {
    const ids = (this.db.prepare('SELECT id FROM agents WHERE owner_user_id IS NULL').all() as { id: string }[]).map((r) => r.id);
    return this.reached(ids, () => this.claimUnowned_(actor));
  }
  private claimUnowned_(actor: Actor): OwnerClaim {
    if (!isAdmin(actor) || !actor.id) throw new KeyError('admin_only', 'Only an admin can do this.');
    this.checkOwner(actor.id);
    return tx(this.db, () => {
      const ids = (this.db.prepare('SELECT id FROM agents WHERE owner_user_id IS NULL').all() as { id: string }[]).map((r) => r.id);
      this.db.prepare('UPDATE agents SET owner_user_id=? WHERE owner_user_id IS NULL').run(actor.id);
      const claim: OwnerClaim = { by: actor.id!, at: Date.now(), agents: ids.length };
      this.putSetting(CLAIM_KEY, claim);
      this.audit.event(actor, 'agent.owner_claim', { kind: 'system', id: CLAIM_KEY }, { agents: ids.length, ids: ids.slice(0, 20) });
      return claim;
    });
  }
  /** The last claim, or null when the admin has not claimed the existing agents yet. */
  ownerClaim(): OwnerClaim | null { return this.setting<OwnerClaim>(CLAIM_KEY); }
  /**
   * Whether owner enforcement is on (a hub setting, off by default). It is on only once the claim step has run; while it
   * is off the owner is recorded and shown, and no decision reads it.
   */
  ownerEnforcement(): boolean { return this.ownerClaim() !== null && this.setting<boolean>(ENFORCE_KEY) === true; }
  setOwnerEnforcement(on: boolean, actor: Actor): boolean { return this.reached(this.agents().map((a) => a.id), () => this.setOwnerEnforcement_(on, actor)); }
  private setOwnerEnforcement_(on: boolean, actor: Actor): boolean {
    if (!isAdmin(actor)) throw new KeyError('admin_only', 'Only an admin can do this.');
    if (on && !this.ownerClaim()) throw new KeyError('invalid_state', 'Claim the existing agents first: owner enforcement stays off until then.');
    const was = this.ownerEnforcement();
    this.putSetting(ENFORCE_KEY, on);
    if (was !== on) this.audit.event(actor, 'agent_owner.enforcement', { kind: 'system', id: ENFORCE_KEY }, { from: was, to: on });
    return this.ownerEnforcement();
  }
  /** The agents a console user owns (archived ones too), for the user's page and before the user is disabled. */
  ownedBy(userId: string): { id: string; label: string; archived: boolean }[] {
    return (this.db.prepare('SELECT id, label, status FROM agents WHERE owner_user_id=? ORDER BY label').all(userId) as { id: string; label: string; status: string }[])
      .map((a) => ({ id: a.id, label: a.label, archived: a.status === 'archived' }));
  }
  /**
   * Move every agent a console user owns to another active console user, in one audited step: the admin's path for a
   * person who leaves (disable them, then hand their agents on). Only the admin can do this.
   */
  reassignOwner(from: string, to: string, actor: Actor): { agents: number } { return this.reached(this.ownedBy(from).map((a) => a.id), () => this.reassignOwner_(from, to, actor)); }
  private reassignOwner_(from: string, to: string, actor: Actor): { agents: number } {
    if (!isAdmin(actor)) throw new KeyError('admin_only', 'Only an admin can do this.');
    if (from === to) throw new KeyError('invalid_argument', 'Choose another person to hand the agents to.');
    this.checkOwner(to);
    return tx(this.db, () => {
      const ids = this.ownedBy(from).map((a) => a.id);
      this.db.prepare('UPDATE agents SET owner_user_id=? WHERE owner_user_id=?').run(to, from);
      this.audit.event(actor, 'agent.owner_reassign', { kind: 'user', id: from }, { to, agents: ids.length, ids: ids.slice(0, 20) });
      return { agents: ids.length };
    });
  }
  unownedCount(): number { return (this.db.prepare('SELECT COUNT(*) n FROM agents WHERE owner_user_id IS NULL').get() as { n: number }).n; }
  agent(id: string): Agent | null { return (this.db.prepare('SELECT * FROM agents WHERE id=?').get(id) as unknown as Agent) ?? null; }
  agents(): Agent[] { return this.db.prepare('SELECT * FROM agents ORDER BY created_at DESC').all() as unknown as Agent[]; }
  updateAgent(id: string, patch: { label?: string; project?: string | null; role?: string | null; role_detail?: string | null }, actor: Actor): Agent {
    const a = this.agent(id); if (!a) throw new KeyError('not_found', 'agent not found');
    const next = { ...a, ...patch };
    const roleChanged = (patch.role !== undefined && patch.role !== a.role) || (patch.role_detail !== undefined && patch.role_detail !== a.role_detail);
    const adminSetsRole = patch.role !== undefined || patch.role_detail !== undefined;
    this.db.prepare('UPDATE agents SET label=?, project=?, role=?, role_detail=?, role_source=? WHERE id=?')
      .run(next.label, next.project, next.role, next.role_detail, adminSetsRole ? (next.role === null ? null : 'admin') : a.role_source, id);
    this.audit.event(actor, 'agent.update', { kind: 'agent', id }, { before: { label: a.label, role: a.role }, after: patch });
    if (roleChanged) this.notify(id, 'role_changed', `Your role is now "${next.role}"${next.role_detail ? `: ${next.role_detail}` : ''} (set by the administrator).`);
    return this.agent(id)!;
  }
  /** session_describe: the agent states its role; an admin-set role stays in force. Never changes permissions. */
  describeSelf(agentId: string, d: { role?: string; role_detail?: string; status_text?: string; model_label?: string }): Agent {
    const a = this.agent(agentId)!;
    if (d.role !== undefined) {
      if (a.role_source === 'admin') {
        this.db.prepare('UPDATE agents SET role_note=? WHERE id=?').run(`${d.role}${d.role_detail ? `: ${d.role_detail}` : ''}`, agentId);
      } else {
        this.db.prepare("UPDATE agents SET role=?, role_detail=?, role_source='agent' WHERE id=?").run(d.role, d.role_detail ?? null, agentId);
      }
    }
    if (d.status_text !== undefined) this.db.prepare('UPDATE agents SET status_text=? WHERE id=?').run(d.status_text, agentId);
    if (d.model_label !== undefined) this.db.prepare('UPDATE agents SET model_label=? WHERE id=?').run(d.model_label, agentId);
    return this.agent(agentId)!;
  }

  /** The one name rule for a PC, at create and at rename: lowercase letters, digits and dashes, 1 to 63 characters, unique. */
  private checkMachineName(name: string, exceptId: string | null): void {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw new KeyError('invalid_argument', 'PC name: lowercase letters, digits and dashes');
    const same = this.db.prepare('SELECT id FROM machines WHERE name=?').get(name) as { id: string } | undefined;
    if (same && same.id !== exceptId) throw new KeyError('conflict', `a PC named "${name}" exists`);
  }
  createMachine(name: string, description: string | null, actor: Actor): Machine {
    this.checkMachineName(name, null);
    const id = newId.pc();
    this.db.prepare('INSERT INTO machines(id,name,description,created_at) VALUES (?,?,?,?)').run(id, name, description, Date.now());
    this.audit.event(actor, 'pc.create', { kind: 'pc', id }, { name });
    return this.machine(id)!;
  }
  /** Give a PC a new name. A PC is known by its id everywhere (keys, sessions, the bridge), so nothing else holds the name. The same name is a no-op. */
  renameMachine(id: string, name: string, actor: Actor): Machine {
    const m = this.machine(id); if (!m) throw new KeyError('not_found', 'PC not found');
    if (m.name === name) return m;
    this.checkMachineName(name, id);
    tx(this.db, () => {
      this.db.prepare('UPDATE machines SET name=? WHERE id=?').run(name, id);
      this.audit.event(actor, 'pc.rename', { kind: 'pc', id }, { from: m.name, to: name });
    });
    return this.machine(id)!;
  }
  machine(id: string): Machine | null { return (this.db.prepare('SELECT * FROM machines WHERE id=?').get(id) as unknown as Machine) ?? null; }
  machines(): Machine[] { return this.db.prepare('SELECT * FROM machines ORDER BY name').all() as unknown as Machine[]; }
  /**
   * Retire a PC (Take back of a delegation, docs/checkout.md §9 F1): its app keys are revoked with their tokens, so the
   * PC can no longer file requests or log agents in, and it is marked retired. Refused while a live session key of an
   * agent is still bound to it.
   */
  retireMachine(id: string, reason: string, actor: Actor): void {
    const pc = this.machine(id);
    if (!pc) throw new KeyError('not_found', 'PC not found');
    if (pc.status === 'retired') return;
    const bound = this.credentialsWhere("kind='session_key' AND bound_machine_id=? AND status<>'revoked'", id);
    if (bound.length) throw new KeyError('invalid_state', `${pc.name} still holds ${bound.length} agent key(s); it cannot be retired.`, { keys: bound.map((k) => k.id) });
    tx(this.db, () => {
      let revoked = 0;
      for (const c of this.credentialsWhere("machine_id=? AND status<>'revoked'", id)) {
        this.db.prepare("UPDATE credentials SET status='revoked', status_reason=?, revoked_at=? WHERE id=?").run(reason.slice(0, 200), Date.now(), c.id);
        this.revokeTokensFor(c.id, 'pc_retired');
        revoked++;
      }
      this.db.prepare("UPDATE machines SET status='retired' WHERE id=?").run(id);
      this.audit.event(actor, 'pc.retire', { kind: 'pc', id }, { reason, app_keys_revoked: revoked });
    });
    this.onAccessEnded?.({ machine: id });
  }
  setMachineStatus(id: string, status: 'active' | 'suspended', actor: Actor): void {
    if (!this.machine(id)) throw new KeyError('not_found', 'PC not found');
    tx(this.db, () => {
      this.db.prepare('UPDATE machines SET status=? WHERE id=?').run(status, id);
      if (status === 'suspended') {
        for (const c of this.credentialsWhere('machine_id=?', id)) this.revokeTokensFor(c.id, 'pc_suspended');
      }
    });
    this.audit.event(actor, status === 'suspended' ? 'pc.suspend' : 'pc.reactivate', { kind: 'pc', id });
    if (status === 'suspended') this.onAccessEnded?.({ machine: id });
  }

  // ───────────── Credentials ─────────────
  private newSecret(kind: KeyKind): { keyId: string; secret: string; full: string } {
    const keyId = randomToken(8).slice(0, 12), secret = randomToken(20).slice(0, 32);
    return { keyId, secret, full: `ah_${kind === 'app_key' ? 'app' : 'ses'}_${keyId}_${secret}` };
  }
  private verifier(secret: string): string { return hmacHex(this.pepper, secret); }

  private insertPolicy(kind: 'credential' | 'template', name: string | null, description: string | null): string {
    const id = newId.policy(), now = Date.now();
    this.db.prepare('INSERT INTO permission_policies(id,kind,name,version,description,created_at,updated_at) VALUES (?,?,?,1,?,?,?)').run(id, kind, name, description, now, now);
    this.db.prepare('INSERT INTO policy_versions(policy_id,version,rules,changed_by,change_note,created_at) VALUES (?,1,?,NULL,?,?)').run(id, '[]', 'created', now);
    return id;
  }

  /**
   * A new session key. `machineId` binds it to that PC from the start (docs/onboarding.md#pc-binding-of-session-keys), in
   * the same transaction, so the key is never free in between; the binding is audited as key.binding_set.
   */
  createSessionKey(o: { agentId: string; label: string; expiresAt?: number | null; templateId?: string | null; machineId?: string | null }, actor: Actor): { credential: Credential; secret: string } {
    if (!this.agent(o.agentId)) throw new KeyError('not_found', 'agent not found');
    if (o.machineId) {
      const pc = this.machine(o.machineId);
      if (!pc) throw new KeyError('not_found', 'PC not found');
      if (pc.status === 'retired') throw new KeyError('invalid_state', 'a key cannot be bound to a retired PC');
    }
    return tx(this.db, () => {
      const s = this.newSecret('session_key');
      const policyId = this.insertPolicy('credential', null, null);
      const id = newId.credential();
      this.db.prepare(`INSERT INTO credentials(id,kind,agent_id,label,key_id,verifier,status,expires_at,policy_id,max_live_sessions,bound_machine_id,created_at,created_by_admin)
        VALUES (?,?,?,?,?,?,'active',?,?,?,?,?,?)`).run(id, 'session_key', o.agentId, o.label, s.keyId, this.verifier(s.secret), o.expiresAt ?? null, policyId, SESSION_KEY_LIVE_LOGINS, o.machineId ?? null, Date.now(), actor.kind === 'admin' ? actor.id : null);
      if (o.templateId) this.applyTemplate(id, o.templateId, actor, 'template applied at creation');
      this.audit.event(actor, 'key.create', { kind: 'credential', id }, { kind: 'session_key', agent: o.agentId, label: o.label });
      if (o.machineId) this.audit.event(actor, 'key.binding_set', { kind: 'credential', id }, { from: null, to: o.machineId, source: 'create' });
      return { credential: this.credential(id)!, secret: s.full };
    });
  }

  createAppKey(o: { machineId: string; appName: string; label?: string; maxLiveSessions?: number }, actor: Actor): { credential: Credential; secret: string } {
    const m = this.machine(o.machineId); if (!m) throw new KeyError('not_found', 'PC not found');
    return tx(this.db, () => {
      const s = this.newSecret('app_key');
      const policyId = this.insertPolicy('credential', null, null);
      const id = newId.credential();
      this.db.prepare(`INSERT INTO credentials(id,kind,machine_id,app_name,label,key_id,verifier,status,policy_id,max_live_sessions,created_at,created_by_admin)
        VALUES (?,?,?,?,?,?,?,'active',?,?,?,?)`).run(id, 'app_key', o.machineId, o.appName, o.label ?? `${o.appName} on ${m.name}`, s.keyId, this.verifier(s.secret), policyId, o.maxLiveSessions ?? DEFAULT_LIVE_LOGINS, Date.now(), actor.kind === 'admin' ? actor.id : null);
      this.audit.event(actor, 'key.create', { kind: 'credential', id }, { kind: 'app_key', pc: m.name, app: o.appName });
      return { credential: this.credential(id)!, secret: s.full };
    });
  }

  credential(id: string): Credential | null { return (this.db.prepare(`SELECT ${CRED_COLS} FROM credentials WHERE id=?`).get(id) as unknown as Credential) ?? null; }
  private credentialsWhere(where: string, ...args: (string | number | null)[]): Credential[] {
    return this.db.prepare(`SELECT ${CRED_COLS} FROM credentials WHERE ${where} ORDER BY created_at DESC`).all(...args) as unknown as Credential[];
  }
  credentials(filter: { kind?: KeyKind; agentId?: string; machineId?: string } = {}): Credential[] {
    const w: string[] = ['1=1'], a: string[] = [];
    if (filter.kind) { w.push('kind=?'); a.push(filter.kind); }
    if (filter.agentId) { w.push('agent_id=?'); a.push(filter.agentId); }
    if (filter.machineId) { w.push('machine_id=?'); a.push(filter.machineId); }
    return this.credentialsWhere(w.join(' AND '), ...a);
  }
  /**
   * Leak guard: is this a key or token the hub issued, whatever its status? An exact verifier check, so text that
   * merely looks like a key never counts. For 'tok', keyId is '' and secret is the part after ah_tok_.
   */
  isIssued(kind: 'app' | 'ses' | 'set' | 'brg' | 'dsc' | 'tok', keyId: string, secret: string): boolean {
    if (kind === 'tok') return !!this.db.prepare('SELECT 1 FROM session_tokens WHERE token_hash=?').get(sha256Hex(`ah_tok_${secret}`));
    if (kind === 'dsc') { // a disconnect receipt (docs/connector.md); a retired one has no verifier left
      const r = this.db.prepare('SELECT receipt_verifier v FROM pc_actions WHERE receipt_key_id=?').get(keyId) as { v: string | null } | undefined;
      return !!r?.v && safeEqualHex(r.v, this.verifier(secret));
    }
    const table = kind === 'set' ? 'setup_keys' : kind === 'brg' ? 'bridge_keys' : 'credentials';
    // A removed revoked key is still one the hub issued: its tombstone keeps the verifier (docs/operations.md).
    const row = (this.db.prepare(`SELECT verifier FROM ${table} WHERE key_id=?`).get(keyId)
      ?? (table === 'credentials' ? this.db.prepare('SELECT verifier FROM key_tombstones WHERE key_id=?').get(keyId) : undefined)) as { verifier: string } | undefined;
    return !!row && safeEqualHex(row.verifier, this.verifier(secret));
  }

  /** Effective status: revoked > suspended > expired > active. */
  effectiveStatus(c: Credential, now = Date.now()): 'active' | 'suspended' | 'revoked' | 'expired' {
    if (c.status !== 'active') return c.status;
    if (c.expires_at !== null && now >= c.expires_at) return 'expired';
    return 'active';
  }

  /** Check a presented key. Returns the credential or throws KeyError with an auth outcome code. */
  verifyKey(presented: string, expect: KeyKind): Credential {
    const m = KEY_RE.exec(presented.trim());
    if (!m) throw new KeyError('invalid', 'malformed key');
    const kind: KeyKind = m[1] === 'app' ? 'app_key' : 'session_key';
    const c = this.db.prepare('SELECT * FROM credentials WHERE key_id=?').get(m[2]!) as unknown as (Credential & { verifier: string }) | undefined;
    if (!c) {
      // A revoked key the Revoked keys rule removed is still refused as revoked, so its reuse raises the same alert.
      const t = this.db.prepare('SELECT kind, verifier FROM key_tombstones WHERE key_id=?').get(m[2]!) as { kind: KeyKind; verifier: string } | undefined;
      if (t && t.kind === kind && kind === expect && safeEqualHex(t.verifier, this.verifier(m[3]!))) throw new KeyError('revoked', 'key is revoked');
    }
    if (!c || c.kind !== kind || kind !== expect || !safeEqualHex(c.verifier, this.verifier(m[3]!))) throw new KeyError('unknown', 'unknown key');
    const st = this.effectiveStatus(c);
    if (st !== 'active') throw new KeyError(st, `key is ${st}`);
    if (c.machine_id) {
      const pc = this.machine(c.machine_id);
      if (pc && pc.status !== 'active') throw new KeyError('suspended', 'this PC is suspended');
    }
    const now = Date.now();
    this.db.prepare('UPDATE credentials SET last_used_at=?, first_used_at=COALESCE(first_used_at, ?) WHERE id=?').run(now, now, c.id);
    const { verifier: _v, ...rest } = c;
    return rest;
  }

  setStatus(id: string, status: 'active' | 'suspended' | 'revoked', reason: string | null, actor: Actor): Credential {
    const c = this.credential(id); if (!c) throw new KeyError('not_found', 'key not found');
    if (c.status === 'revoked') throw new KeyError('invalid_state', 'a revoked key cannot change');
    // A key held by a leak rotation may have leaked: it comes back only as a new key (rotate) or not at all (revoke).
    if (status === 'active' && this.isHeld(c)) throw new KeyError('invalid_state', 'This key is held because it may have leaked, so it cannot be resumed. Rotate it again to send a new key, or revoke it.');
    tx(this.db, () => {
      const at = Date.now();
      // suspended_at dates the suspension (the opt-in Suspended keys rule counts from it); a revoke keeps it.
      this.db.prepare("UPDATE credentials SET status=?, status_reason=?, revoked_at=?, suspended_at=CASE ? WHEN 'suspended' THEN ? WHEN 'active' THEN NULL ELSE suspended_at END WHERE id=?").run(status, reason, status === 'revoked' ? at : null, status, at, id);
      if (status !== 'active') this.revokeTokensFor(id, status);
      // An open key handover for it (keys/handover.ts) would hand a suspended or revoked key a new secret: it is cancelled.
      if (status !== 'active') this.handoverCancel?.(id, 'revoked', actor);
      // A checkout successor that is not confirmed yet stands for this key: it goes down with it (docs/checkout.md §5),
      // so a key suspended or revoked after pickup cannot live on as its successor.
      if (status !== 'active' && c.succession === 'superseded_pending') {
        for (const s of this.db.prepare("SELECT id FROM credentials WHERE replaces_credential_id=? AND kind='session_key' AND status='active'").all(id) as { id: string }[]) {
          this.setStatus(s.id, status, reason ?? 'predecessor', actor);
        }
      }
    });
    if (status !== 'active') this.onAccessEnded?.({ credential: id });
    this.audit.event(actor, `key.${status === 'active' ? 'reactivate' : status === 'suspended' ? 'suspend' : 'revoke'}`, { kind: 'credential', id }, { reason });
    return this.credential(id)!;
  }

  /**
   * A leak rotation holds the suspected session key at once (docs/onboarding.md, key handover, "After a possible leak"):
   * it is suspended with the reason `leak_hold`, so its logins and turn tokens end and none is given again through any PC's
   * app key. Unlike a suspend it does not cancel the key's handover; confirm still rotates the held key.
   */
  hold(id: string, actor: Actor): Credential {
    const c = this.credential(id); if (!c) throw new KeyError('not_found', 'key not found');
    if (c.status === 'revoked') throw new KeyError('invalid_state', 'a revoked key cannot change');
    tx(this.db, () => {
      this.db.prepare("UPDATE credentials SET status='suspended', status_reason=?, revoked_at=NULL WHERE id=?").run(LEAK_HOLD, id);
      this.revokeTokensFor(id, 'suspended');
    });
    this.onAccessEnded?.({ credential: id });
    this.audit.event(actor, 'key.hold', { kind: 'credential', id }, { reason: 'suspected_leak' });
    return this.credential(id)!;
  }
  /** Held by a leak rotation that has not been confirmed (hold). */
  isHeld(c: Credential): boolean { return c.status === 'suspended' && c.status_reason === LEAK_HOLD; }

  /**
   * PC binding (docs/onboarding.md#pc-binding-of-session-keys): a bound session key logs in only through an app key
   * on that PC; null makes it free. Checked at every login, so a change applies to the next one; live logins go on.
   */
  setBinding(id: string, machineId: string | null, actor: Actor): Credential {
    const c = this.credential(id); if (!c) throw new KeyError('not_found', 'key not found');
    if (c.kind !== 'session_key') throw new KeyError('invalid_argument', 'only a session key can be bound to a PC');
    if (c.status === 'revoked') throw new KeyError('invalid_state', 'a revoked key cannot change');
    const pc = machineId !== null ? this.machine(machineId) : null;
    if (machineId !== null && !pc) throw new KeyError('not_found', 'PC not found');
    if (pc && pc.status === 'retired' && c.bound_machine_id !== machineId) throw new KeyError('invalid_state', 'a key cannot be bound to a retired PC');
    if (c.bound_machine_id === machineId) return c;
    this.db.prepare('UPDATE credentials SET bound_machine_id=? WHERE id=?').run(machineId, id);
    // An open key handover names the PC and app key it was made for; after a move it would hand the key to the PC it just left.
    this.handoverCancel?.(id, 'binding_changed', actor);
    this.audit.event(actor, 'key.binding_set', { kind: 'credential', id }, { from: c.bound_machine_id, to: machineId });
    return this.credential(id)!;
  }

  /** The onboarding capability on an app key (docs/onboarding.md#the-app-key-and-its-onboarding-capability). */
  setOnboarding(id: string, on: boolean, actor: Actor): Credential {
    const c = this.credential(id); if (!c) throw new KeyError('not_found', 'key not found');
    if (c.kind !== 'app_key') throw new KeyError('invalid_argument', 'only an app key can carry the onboarding capability');
    if (on && c.status === 'revoked') throw new KeyError('invalid_state', 'a revoked key cannot change');
    if (!!c.onboarding_enabled_at === on) return c;
    this.db.prepare('UPDATE credentials SET onboarding_enabled_at=? WHERE id=?').run(on ? Date.now() : null, id);
    this.audit.event(actor, on ? 'onboarding.capability_grant' : 'onboarding.capability_remove', { kind: 'credential', id });
    return this.credential(id)!;
  }

  /**
   * A fresh secret for the same credential (enrolment): the previous secret stops working and its logins end. The id,
   * policy, PC and capability stay, so nothing that names the key changes.
   */
  reissueSecret(id: string, reason: string): { credential: Credential; secret: string } {
    const c = this.credential(id); if (!c) throw new KeyError('not_found', 'key not found');
    if (c.status !== 'active') throw new KeyError('invalid_state', `the key is ${c.status}`);
    return tx(this.db, () => {
      const s = this.newSecret(c.kind);
      this.db.prepare('UPDATE credentials SET key_id=?, verifier=? WHERE id=?').run(s.keyId, this.verifier(s.secret), id);
      this.revokeTokensFor(id, reason);
      return { credential: this.credential(id)!, secret: s.full };
    });
  }

  /** The most live logins an app key allows (docs/onboarding.md): 1 to 500, applied at the next login; the audit row has the old and the new limit. */
  setLiveLimit(id: string, limit: number, actor: Actor): Credential {
    const c = this.credential(id);
    if (!c) throw new KeyError('not_found', 'key not found');
    if (c.kind !== 'app_key') throw new KeyError('invalid_state', 'Only an app key has a limit of live logins.');
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIVE_LOGINS) throw new KeyError('invalid_argument', 'The limit is a whole number from 1 to 500.');
    if (limit === c.max_live_sessions) return c;
    // The new limit and its audit row commit together: if the audit write fails, the limit stays as it was.
    return tx(this.db, () => {
      this.db.prepare('UPDATE credentials SET max_live_sessions=? WHERE id=?').run(limit, id);
      this.audit.event(actor, 'key.live_limit', { kind: 'credential', id }, { from: c.max_live_sessions, to: limit });
      return this.credential(id)!;
    });
  }

  setExpiry(id: string, expiresAt: number | null, actor: Actor): Credential {
    if (!this.credential(id)) throw new KeyError('not_found', 'key not found');
    this.db.prepare('UPDATE credentials SET expires_at=? WHERE id=?').run(expiresAt, id);
    this.audit.event(actor, 'key.expiry', { kind: 'credential', id }, { expires_at: expiresAt });
    return this.credential(id)!;
  }

  /**
   * Rotate: the new key takes over the policy (and thus grants); the old key is revoked,
   * every token of it ends, and the agent gets a key_rotated notice. A key in an unsettled checkout move (one with a
   * successor, or a successor whose old key is not settled) is refused: rotating it would leave the agent two live keys.
   */
  rotate(id: string, actor: Actor, why: { reason?: 'routine' | 'suspected_leak' | 're_enrol' | null; delivery?: 'prompt' | 'handover' | 'shown'; staged?: StagedSecret } = {}): { credential: Credential; secret: string } {
    const old = this.credential(id); if (!old) throw new KeyError('not_found', 'key not found');
    if (old.status === 'revoked') throw new KeyError('invalid_state', 'a revoked key cannot be rotated');
    if (old.succession) throw new KeyError('invalid_state', 'This key has a checkout successor that is not settled. Finish or cancel the checkout first.');
    if (old.replaces_credential_id && this.credential(old.replaces_credential_id)?.succession) throw new KeyError('invalid_state', 'This key is the successor in a checkout that is not settled. Finish or cancel the checkout first.');
    return tx(this.db, () => {
      // A handover's confirm brings the secret its pickup staged (the hub has only its verifier); otherwise a new one.
      const fresh = why.staged ? null : this.newSecret(old.kind);
      const s = why.staged ? { keyId: why.staged.keyId, verifier: why.staged.verifier, full: '' } : { keyId: fresh!.keyId, verifier: this.verifier(fresh!.secret), full: fresh!.full };
      const spare = this.insertPolicy('credential', null, 'released by rotation');
      this.db.prepare("UPDATE credentials SET policy_id=?, status='revoked', status_reason='rotated', revoked_at=? WHERE id=?").run(spare, Date.now(), id);
      this.revokeTokensFor(id, 'rotated');
      this.handoverCancel?.(id, 'replaced', actor);
      const nid = newId.credential();
      this.db.prepare(`INSERT INTO credentials(id,kind,agent_id,machine_id,app_name,label,key_id,verifier,status,expires_at,replaces_credential_id,policy_id,max_live_sessions,bound_machine_id,onboarding_enabled_at,session_var,created_at,created_by_admin)
        VALUES (?,?,?,?,?,?,?,?,'active',?,?,?,?,?,?,?,?,?)`).run(nid, old.kind, old.agent_id, old.machine_id, old.app_name, old.label, s.keyId, s.verifier, old.expires_at, id, old.policy_id, old.max_live_sessions, old.bound_machine_id, old.onboarding_enabled_at, old.session_var ?? null, Date.now(), actor.kind === 'admin' ? actor.id : null);
      this.db.prepare('UPDATE temporary_grants SET credential_id=? WHERE credential_id=?').run(nid, id);
      this.db.prepare("UPDATE access_requests SET credential_id=? WHERE credential_id=? AND status='pending'").run(nid, id);
      // Team membership names the key its team rules live on; left on the old key, the next re-wire would drop them.
      this.db.prepare('UPDATE team_members SET credential_id=? WHERE credential_id=?').run(nid, id);
      // An app key's onboarding requests and enrolment code follow it, so its pickup still counts as the filing key's.
      this.db.prepare('UPDATE onboarding_requests SET app_credential_id=? WHERE app_credential_id=?').run(nid, id);
      this.db.prepare('UPDATE enrolment_codes SET app_credential_id=? WHERE app_credential_id=?').run(nid, id);
      // The connector's report names the app key a handover binds to: the new key takes its place until the next check-in.
      this.db.prepare('UPDATE connector_reports SET app_credential_id=? WHERE app_credential_id=?').run(nid, id);
      if (old.agent_id) this.notify(old.agent_id, 'key_rotated', why.delivery === 'handover'
        ? 'Your session key was rotated. The connector on your PC wrote the new key: start a new chat, or call session_login with it.'
        : 'Your session key was rotated. Wait for the new key from the administrator, then call session_login with it.');
      this.audit.event(actor, 'key.rotate', { kind: 'credential', id: nid }, { replaces: id, ...(old.kind === 'session_key' ? { reason: why.reason ?? null, delivery: why.delivery ?? 'prompt' } : {}) });
      return { credential: this.credential(nid)!, secret: s.full };
    });
  }

  // ───────────── Key prompts (docs/onboarding.md#key-prompts-a-new-rotated-or-reissued-session-key) ─────────────
  /**
   * Where a session key's prompt sends it, from what the hub knows and nothing else: the PC (the binding, else the PC of
   * the key's last login, else the PC that collected the key at onboarding, through the rotation chain), the keys.env
   * variable (the stored one, else the onboarding slot's, else one derived from the agent's name for a PC; stored once
   * chosen, always one setup.mjs accepts) and the client (the app of that last login on that PC, else the onboarding
   * request's). A PC that is not retired keeps its pickup even without an active app key or while suspended: note then
   * says what the operator must fix before setup.mjs can collect the key. No PC, or a retired one: pc is null and the
   * prompt falls back to the raw key.
   */
  keyTarget(id: string): { pc: Machine | null; session_var: string | null; client_app: string | null; folder: string | null; note: string | null } {
    const c = this.credential(id); if (!c) throw new KeyError('not_found', 'key not found');
    if (c.kind !== 'session_key') throw new KeyError('invalid_argument', 'only a session key has a key prompt');
    const chain = `WITH RECURSIVE ch(id) AS (SELECT ? UNION SELECT c.replaces_credential_id FROM credentials c JOIN ch ON c.id=ch.id WHERE c.replaces_credential_id IS NOT NULL)`;
    const slot = this.db.prepare(`${chain}
      SELECT s.session_var, s.folder, r.machine_id, r.body FROM onboarding_slots s JOIN onboarding_requests r ON r.id=s.request_id
      WHERE s.credential_id IN (SELECT id FROM ch) AND r.kind<>'rotate' ORDER BY s.created_at DESC LIMIT 1`).get(id) as { session_var: string; folder: string; machine_id: string; body: string } | undefined;
    // The last login says where the agent runs today and through which client; the onboarding slot may be older than a move.
    const last = this.db.prepare(`${chain}
      SELECT a.machine_id, a.app_name FROM session_tokens t JOIN credentials a ON a.id=t.app_credential_id
      WHERE t.session_credential_id IN (SELECT id FROM ch) ORDER BY t.created_at DESC LIMIT 1`).get(id) as { machine_id: string; app_name: string } | undefined;
    let slotApp: string | null = null;
    if (slot) { try { const x = (JSON.parse(slot.body) as { client?: { app?: unknown } }).client?.app; slotApp = typeof x === 'string' ? x : null; } catch { /* no client */ } }
    const pcId = c.bound_machine_id ?? last?.machine_id ?? slot?.machine_id ?? null;
    let pc = pcId ? this.machine(pcId) : null;
    if (pc && pc.status === 'retired') pc = null;
    const clientApp = pc && last?.machine_id === pc.id ? last.app_name : pc && slot?.machine_id === pc.id ? slotApp : last?.app_name ?? slotApp;
    let note: string | null = null;
    if (pc && pc.status !== 'active') note = `The PC ${pc.name} is ${pc.status}: reactivate it before running the command there.`;
    else if (pc && !this.db.prepare("SELECT 1 FROM credentials WHERE kind='app_key' AND machine_id=? AND status='active' AND (expires_at IS NULL OR expires_at>?)").get(pc.id, Date.now()))
      note = `The PC ${pc.name} has no active app key: issue or reactivate one before running the command there.`;
    let sv = [c.session_var, slot?.session_var].find((v) => typeof v === 'string' && SESSION_VAR_RE.test(v)) ?? null;
    if (!sv && pc) {
      const agent = this.agent(c.agent_id!);
      // setup.mjs accepts at most 64 characters; keep room for the "_<n>" a clash adds and for "_SESSION_KEY".
      const base = ((agent?.label ?? c.label).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'AGENT').replace(/^(\d)/, 'A_$1').slice(0, 64 - '_SESSION_KEY'.length - 5).replace(/_+$/, '');
      const taken = new Set((this.db.prepare(`SELECT DISTINCT session_var v FROM credentials WHERE session_var IS NOT NULL AND agent_id IS NOT NULL AND id<>? AND status<>'revoked'
        AND bound_machine_id=? AND agent_id<>?`).all(id, pc.id, c.agent_id) as { v: string }[]).map((r) => r.v));
      sv = `${base}_SESSION_KEY`;
      for (let n = 2; taken.has(sv); n++) sv = `${base}_${n}_SESSION_KEY`;
    }
    if (sv && sv !== c.session_var) this.db.prepare('UPDATE credentials SET session_var=? WHERE id=?').run(sv, id);
    return { pc, session_var: sv, client_app: clientApp, folder: slot?.folder ?? null, note };
  }

  /**
   * A new session-key secret for a key handover's pickup (keys/handover.ts): the full key goes to the PC once, and the hub keeps
   * only its key id and verifier on the handover's slot until confirm. Nothing changes on the credential here.
   */
  stageSecret(): StagedSecret & { full: string } {
    const s = this.newSecret('session_key');
    return { keyId: s.keyId, verifier: this.verifier(s.secret), full: s.full };
  }
  /** A key with no working secret yet (a new key sent by handover) takes the staged one at confirm. Its logins end. */
  takeStagedSecret(id: string, staged: StagedSecret, reason: string): void {
    this.db.prepare('UPDATE credentials SET key_id=?, verifier=? WHERE id=?').run(staged.keyId, staged.verifier, id);
    this.revokeTokensFor(id, reason);
  }
  /** A session key's secret stops working at once: a fresh key id, no usable verifier, and its logins end. */
  blankSecret(id: string, reason: string): void {
    this.db.prepare("UPDATE credentials SET key_id=?, verifier='' WHERE id=?").run(this.newSecret('session_key').keyId, id);
    this.revokeTokensFor(id, reason);
  }
  /** Whether a key has a working secret: a new key sent by handover has none until its confirm. */
  hasSecret(id: string): boolean {
    return !!this.db.prepare("SELECT 1 x FROM credentials WHERE id=? AND verifier<>''").get(id);
  }
  /**
   * Set by the key handovers (keys/handover.ts): cancels the open handovers that carry this key when it is revoked,
   * suspended, re-bound or rotated another way. Runs inside the caller's transaction.
   */
  handoverCancel: ((credentialId: string, reason: 'revoked' | 'binding_changed' | 'replaced', actor: Actor) => void) | null = null;
  /** Vault sync (docs/vault-sync.md): a reader's rules stay read-only whoever edits them, and its key never logs in as a working agent. */
  ruleGuard: ((policyId: string, rules: Omit<Rule, 'id'>[]) => void) | null = null;
  loginGuard: ((credentialId: string) => void) | null = null;
  /**
   * A checkout's successor key (docs/checkout.md §5). Unlike rotate(), the old key stays active (marked succession
   * 'superseded_pending') and no notice is sent: the new row replaces it, is bound to the target PC in the same transaction (even
   * when the old key was free), gets a copy of the old key's own rules (team rules follow membership at the next wire),
   * and takes over team membership, temporary grants and pending access requests. revertSuccessor() undoes it.
   */
  issueSuccessor(id: string, machineId: string, actor: Actor, label?: string): { credential: Credential; secret: string } {
    return tx(this.db, () => {
      const old = this.credential(id); if (!old) throw new KeyError('not_found', 'key not found');
      if (old.kind !== 'session_key') throw new KeyError('invalid_argument', 'only a session key has a successor');
      if (old.status !== 'active') throw new KeyError('invalid_state', `the key is ${old.status}`);
      if (old.succession) throw new KeyError('conflict', 'this key already has a successor that is not settled');
      const pc = this.machine(machineId); if (!pc) throw new KeyError('not_found', 'PC not found');
      if (pc.status === 'retired') throw new KeyError('invalid_state', 'a key cannot be bound to a retired PC');
      const s = this.newSecret('session_key'), now = Date.now();
      const policyId = this.insertPolicy('credential', null, 'successor (checkout)');
      // Team rules are copied too (with their team tag and position), so the next wire finds nothing changed and sends no notice.
      this.copyRules(old.policy_id, policyId, 'all');
      const stored = this.rules(policyId, false);
      if (stored.length) {
        this.db.prepare('UPDATE permission_policies SET version=2, updated_at=? WHERE id=?').run(now, policyId);
        this.db.prepare('INSERT INTO policy_versions(policy_id,version,rules,changed_by,change_note,created_at) VALUES (?,2,?,NULL,?,?)').run(policyId, JSON.stringify(stored), `copied from ${old.id}`, now);
      }
      const nid = newId.credential();
      this.db.prepare(`INSERT INTO credentials(id,kind,agent_id,label,key_id,verifier,status,expires_at,replaces_credential_id,policy_id,max_live_sessions,bound_machine_id,created_at,created_by_admin)
        VALUES (?,?,?,?,?,?,'active',?,?,?,?,?,?,?)`).run(nid, 'session_key', old.agent_id, label ?? old.label, s.keyId, this.verifier(s.secret), old.expires_at, id, policyId, old.max_live_sessions, machineId, now, actor.kind === 'admin' ? actor.id : null);
      this.moveHoldings(id, nid);
      this.db.prepare("UPDATE credentials SET succession='superseded_pending' WHERE id=?").run(id);
      this.audit.event(actor, 'key.successor', { kind: 'credential', id: nid }, { replaces: id, agent: old.agent_id, bound_to: machineId });
      this.audit.event(actor, 'key.binding_set', { kind: 'credential', id: nid }, { from: null, to: machineId, source: 'successor' });
      return { credential: this.credential(nid)!, secret: s.full };
    });
  }
  private copyRules(fromPolicy: string, toPolicy: string, which: 'all' | 'team'): void {
    const ins = this.db.prepare('INSERT INTO permission_rules(id,policy_id,position,effect,actions,resource,from_template,note,team_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
    for (const r of this.db.prepare(`SELECT * FROM permission_rules WHERE policy_id=?${which === 'team' ? ' AND team_id IS NOT NULL' : ''} ORDER BY position`).all(fromPolicy) as { position: number; effect: string; actions: string; resource: string; from_template: string | null; note: string | null; team_id: string | null; created_at: number }[]) {
      ins.run(newId.rule(), toPolicy, r.position, r.effect, r.actions, r.resource, r.from_template, r.note, r.team_id, r.created_at);
    }
  }
  /** Team membership, temporary grants and pending access requests follow the key that serves the agent. */
  private moveHoldings(from: string, to: string): void {
    this.db.prepare('UPDATE temporary_grants SET credential_id=? WHERE credential_id=?').run(to, from);
    this.db.prepare("UPDATE access_requests SET credential_id=? WHERE credential_id=? AND status='pending'").run(to, from);
    this.db.prepare('UPDATE team_members SET credential_id=? WHERE credential_id=?').run(to, from);
  }
  /**
   * Undo a successor that never took over (a pickup retry, a new render, cancel or expiry): the holdings go back to the
   * old key, the successor is revoked with its tokens, and the old key's tokens suspended by `by` are reinstated.
   * Returns the old key's id. The caller re-wires the teams whose membership moved.
   */
  revertSuccessor(newCredentialId: string, reason: string, actor: Actor, by?: string): string {
    return tx(this.db, () => {
      const n = this.credential(newCredentialId); if (!n?.replaces_credential_id) throw new KeyError('not_found', 'successor not found');
      const old = this.credential(n.replaces_credential_id)!;
      this.moveHoldings(n.id, old.id);
      // The team rules come back with membership (a wire since the issue may have moved them), so the caller's re-wire finds nothing changed.
      this.db.prepare('DELETE FROM permission_rules WHERE policy_id=? AND team_id IS NOT NULL').run(old.policy_id);
      this.copyRules(n.policy_id, old.policy_id, 'team');
      if (n.status !== 'revoked') {
        this.db.prepare("UPDATE credentials SET status='revoked', status_reason=?, revoked_at=? WHERE id=?").run(reason, Date.now(), n.id);
        this.revokeTokensFor(n.id, 'revoked');
      }
      if (old.succession) this.db.prepare('UPDATE credentials SET succession=NULL WHERE id=?').run(old.id);
      const reinstated = by ? this.reinstateTokens(old.id, by) : 0;
      this.audit.event(actor, 'key.successor_reverted', { kind: 'credential', id: n.id }, { replaces: old.id, reason, reinstated });
      return old.id;
    });
  }
  /** The successor took over (confirm): the old key cannot log in again and its live tokens are suspended by `by`. */
  confirmSuccessor(newCredentialId: string, by: string, actor: Actor): number {
    return tx(this.db, () => {
      const n = this.credential(newCredentialId); if (!n?.replaces_credential_id) throw new KeyError('not_found', 'successor not found');
      this.db.prepare("UPDATE credentials SET succession='suspended' WHERE id=? AND status<>'revoked'").run(n.replaces_credential_id);
      // Only tokens still inside their idle window: an expired one stays expired, so a later reinstate cannot revive it.
      const now = Date.now();
      const r = this.db.prepare('UPDATE session_tokens SET suspended_at=?, suspended_by=? WHERE session_credential_id=? AND revoked_at IS NULL AND suspended_at IS NULL AND expires_at>?')
        .run(now, by, n.replaces_credential_id, now);
      this.audit.event(actor, 'key.tokens_suspended', { kind: 'credential', id: n.replaces_credential_id }, { by, tokens: Number(r.changes), successor: n.id });
      return Number(r.changes);
    });
  }
  /** The move is done (restored): the old key is revoked, its suspended tokens with it. */
  finishSuccessor(newCredentialId: string, actor: Actor): void {
    tx(this.db, () => {
      const n = this.credential(newCredentialId); if (!n?.replaces_credential_id) throw new KeyError('not_found', 'successor not found');
      const old = this.credential(n.replaces_credential_id!)!;
      this.db.prepare('UPDATE credentials SET succession=NULL WHERE id=?').run(old.id);
      if (old.status !== 'revoked') this.setStatus(old.id, 'revoked', 'superseded', actor);
    });
  }
  /**
   * Tokens suspended by `by` (a checkout id) work again with the idle time they had left when suspended: the expiry moves
   * on by the time spent suspended, never further. Only live tokens were suspended, so none comes back from expiry.
   */
  reinstateTokens(credentialId: string, by: string): number {
    const now = Date.now();
    const r = this.db.prepare('UPDATE session_tokens SET expires_at=expires_at + MAX(0, ? - suspended_at), suspended_at=NULL, suspended_by=NULL WHERE session_credential_id=? AND suspended_by=? AND suspended_at IS NOT NULL AND revoked_at IS NULL')
      .run(now, credentialId, by);
    return Number(r.changes);
  }
  /** End a key's logins without a notice (a same-user reuse move ends them at render); the key can log in again. */
  endTokens(credentialId: string, reason: string): number { return this.revokeTokensFor(credentialId, reason); }

  /** "End logins": revokes tokens; the session can log in again. */
  endLogins(id: string, actor: Actor): number {
    const c = this.credential(id); if (!c) throw new KeyError('not_found', 'key not found');
    const n = this.revokeTokensFor(id, 'end_logins');
    if (c.agent_id) this.notify(c.agent_id, 'logins_ended', 'The administrator ended your logins. Call session_login again if you still have work.');
    this.audit.event(actor, 'key.end_logins', { kind: 'credential', id }, { tokens: n });
    return n;
  }

  /** Archive an agent: end every login, revoke its session keys, keep all history. */
  archiveAgent(id: string, actor: Actor): { ended: number } {
    const a = this.agent(id); if (!a) throw new KeyError('not_found', 'agent not found');
    if (a.status === 'archived') throw new KeyError('invalid_state', 'already archived');
    const ended = tx(this.db, () => {
      let n = 0;
      for (const c of this.credentialsWhere('agent_id=?', id)) {
        n += this.revokeTokensFor(c.id, 'archived');
        if (c.status !== 'revoked') this.db.prepare("UPDATE credentials SET status='revoked', status_reason='archived', revoked_at=? WHERE id=?").run(Date.now(), c.id);
      }
      this.db.prepare("UPDATE agents SET status='archived', archived_at=? WHERE id=?").run(Date.now(), id);
      return n;
    });
    this.audit.event(actor, 'agent.archive', { kind: 'agent', id }, { tokens: ended });
    return { ended };
  }

  private revokeTokensFor(credentialId: string, reason: string): number {
    const r = this.db.prepare('UPDATE session_tokens SET revoked_at=?, revoked_reason=? WHERE (session_credential_id=? OR app_credential_id=?) AND revoked_at IS NULL')
      .run(Date.now(), reason, credentialId, credentialId);
    return Number(r.changes);
  }

  // ───────────── Policies ─────────────
  rules(policyId: string, includeTeam = true): Rule[] {
    return (this.db.prepare(`SELECT id,effect,actions,resource,from_template,note,team_id FROM permission_rules WHERE policy_id=? ${includeTeam ? '' : 'AND team_id IS NULL'} ORDER BY position`).all(policyId) as { id: string; effect: 'allow' | 'deny'; actions: string; resource: string; from_template: string | null; note: string | null; team_id: string | null }[])
      .map(({ team_id, ...r }) => ({ ...r, actions: JSON.parse(r.actions) as string[], ...(team_id ? { team_id } : {}) }));
  }
  /** Policy rules plus the credential's temporary grants (each carries its window; the engine checks it per decision). */
  rulesFor(credentialId: string): Rule[] {
    const c = this.credential(credentialId);
    return c ? [...this.rules(c.policy_id), ...this.activeGrants(credentialId).map((g): Rule => ({ id: `tmp:${g.id}`, effect: 'allow', actions: g.actions, resource: g.resource, note: 'temporary grant', not_before: g.not_before, not_after: g.not_after }))] : [];
  }
  /** Grants not revoked and not yet expired (future ones included). */
  activeGrants(credentialId: string): { id: string; actions: string[]; resource: string; not_before: number; not_after: number; access_request_id: string | null }[] {
    return (this.db.prepare('SELECT id,actions,resource,not_before,not_after,access_request_id FROM temporary_grants WHERE credential_id=? AND revoked_at IS NULL AND not_after>? ORDER BY created_at').all(credentialId, Date.now()) as { id: string; actions: string; resource: string; not_before: number; not_after: number; access_request_id: string | null }[])
      .map((g) => ({ ...g, actions: JSON.parse(g.actions) as string[] }));
  }
  policyVersion(policyId: string): number { return (this.db.prepare('SELECT version FROM permission_policies WHERE id=?').get(policyId) as { version: number }).version; }

  /** Replace a policy's rules; records a new immutable version. */
  setRules(policyId: string, rules: Omit<Rule, 'id'>[], note: string | null, actor: Actor): number {
    rules = rules.filter((r) => !r.team_id); // team-generated rules are managed by the team only
    validateRules(rules);
    this.ruleGuard?.(policyId, rules);
    return tx(this.db, () => {
      const before = this.rules(policyId, false);
      this.db.prepare('DELETE FROM permission_rules WHERE policy_id=? AND team_id IS NULL').run(policyId);
      const now = Date.now();
      const stored: Rule[] = rules.map((r, i) => {
        const id = newId.rule();
        this.db.prepare('INSERT INTO permission_rules(id,policy_id,position,effect,actions,resource,from_template,note,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(id, policyId, i, r.effect, JSON.stringify(r.actions), r.resource, r.from_template ?? null, r.note ?? null, now);
        return { id, effect: r.effect, actions: r.actions, resource: r.resource, from_template: r.from_template ?? null, note: r.note ?? null };
      });
      const v = this.policyVersion(policyId) + 1;
      this.db.prepare('UPDATE permission_policies SET version=?, updated_at=? WHERE id=?').run(v, now, policyId);
      this.db.prepare('INSERT INTO policy_versions(policy_id,version,rules,changed_by,change_note,created_at) VALUES (?,?,?,?,?,?)')
        .run(policyId, v, JSON.stringify(stored), actor.kind === 'admin' ? actor.id : null, note, now);
      this.audit.event(actor, 'policy.update', { kind: 'policy', id: policyId }, { version: v, rules: rules.length, note });
      const cred = this.db.prepare('SELECT agent_id FROM credentials WHERE policy_id=?').get(policyId) as { agent_id: string | null } | undefined;
      // Say what changed, so the agent need not diff its grants; nothing changed means no notice.
      const changes = describeRuleChanges(before, stored);
      if (cred?.agent_id && changes.length) this.notify(cred.agent_id, 'permissions_changed', `The administrator changed your permissions: ${changes.join('; ')}.${note ? ` Note: ${note}` : ''} Call access_list for the full list.`);
      return v;
    });
  }

  versions(policyId: string): { version: number; rules: Rule[]; changed_by: string | null; change_note: string | null; created_at: number }[] {
    return (this.db.prepare('SELECT version,rules,changed_by,change_note,created_at FROM policy_versions WHERE policy_id=? ORDER BY version DESC').all(policyId) as { version: number; rules: string; changed_by: string | null; change_note: string | null; created_at: number }[])
      .map((v) => ({ ...v, rules: JSON.parse(v.rules) as Rule[] }));
  }

  rollback(policyId: string, version: number, actor: Actor): number {
    const v = this.versions(policyId).find((x) => x.version === version);
    if (!v) throw new KeyError('not_found', 'version not found');
    return this.setRules(policyId, v.rules.map(({ id: _i, ...r }) => r), `rollback to version ${version}`, actor);
  }

  // ───────────── Templates ─────────────
  templates(): { id: string; name: string; description: string | null; version: number; rules: Rule[] }[] {
    return (this.db.prepare("SELECT id,name,description,version FROM permission_policies WHERE kind='template' ORDER BY name").all() as { id: string; name: string; description: string | null; version: number }[])
      .map((t) => ({ ...t, rules: this.rules(t.id) }));
  }
  createTemplate(name: string, description: string | null, rules: Omit<Rule, 'id'>[], actor: Actor): string {
    if (this.db.prepare("SELECT 1 FROM permission_policies WHERE kind='template' AND name=?").get(name)) throw new KeyError('conflict', `template "${name}" exists`);
    return tx(this.db, () => { const id = this.insertPolicy('template', name, description); this.setRules(id, rules, 'created', actor); return id; });
  }
  /** Copy a template's rules into a key (appended; provenance kept; no inheritance). */
  applyTemplate(credentialId: string, templateId: string, actor: Actor, note = 'template applied'): number {
    const c = this.credential(credentialId); if (!c) throw new KeyError('not_found', 'key not found');
    const t = this.templates().find((x) => x.id === templateId); if (!t) throw new KeyError('not_found', 'template not found');
    const merged = [...this.rules(c.policy_id, false).map(({ id: _i, ...r }) => r), ...t.rules.map(({ id: _i, ...r }) => ({ ...r, from_template: `${t.name}@${t.version}` }))];
    return this.setRules(c.policy_id, merged, `${note}: ${t.name}`, actor);
  }

  // ───────────── Login tokens ─────────────
  login(app: Credential, sessionKey: string, opts: { compact?: boolean; turn?: { runRef: string } } = {}): { token: string; credential: Credential; concurrent: boolean } {
    const ses = this.verifyKey(sessionKey, 'session_key');
    if (ses.succession === 'suspended') throw new KeyError('suspended', 'this session key was moved by a checkout; its successor is in use');
    this.loginGuard?.(ses.id);
    if (ses.bound_machine_id && ses.bound_machine_id !== app.machine_id) throw new BoundElsewhereError(ses, app);
    const now = Date.now();
    const live = (this.db.prepare('SELECT COUNT(*) n FROM session_tokens WHERE app_credential_id=? AND revoked_at IS NULL AND suspended_at IS NULL AND expires_at>?').get(app.id, now) as { n: number }).n;
    if (live >= app.max_live_sessions) throw new KeyError('rate_limited', `this app already has ${live} live sessions (limit ${app.max_live_sessions})`);
    const others = (this.db.prepare('SELECT COUNT(*) n FROM session_tokens WHERE session_credential_id=? AND revoked_at IS NULL AND suspended_at IS NULL AND expires_at>?').get(ses.id, now) as { n: number }).n;
    const token = `ah_tok_${randomToken(25).slice(0, 40)}`, hash = sha256Hex(token);
    // A new login continues where the agent left off: notices after the last one it confirmed (so a directive sent
    // while it was logged out still arrives), and room read positions from its earlier logins (so history is not replayed).
    // Messages read but never confirmed (acked) are delivered again: the new login's delivered position starts at the last confirmed one.
    // An agent's first login skips the hub's own setup notices but still gets the operator's directives and messages.
    const prev = (this.db.prepare('SELECT MAX(t.notice_acked_seq) s FROM session_tokens t JOIN credentials c ON c.id=t.session_credential_id WHERE c.agent_id=?').get(ses.agent_id!) as { s: number | null }).s;
    const firstDirective = (this.db.prepare("SELECT MIN(seq) s FROM agent_notices WHERE agent_id=? AND kind IN ('directive','message')").get(ses.agent_id!) as { s: number | null }).s;
    const newest = (this.db.prepare('SELECT COALESCE(MAX(seq),0) s FROM agent_notices WHERE agent_id=?').get(ses.agent_id!) as { s: number }).s;
    const acked = prev !== null ? Math.min(prev, newest) : firstDirective !== null ? firstDirective - 1 : newest;
    tx(this.db, () => {
      this.db.prepare('INSERT INTO session_tokens(token_hash,app_credential_id,session_credential_id,notice_acked_seq,created_at,last_used_at,expires_at,compact,scope,run_ref) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(hash, app.id, ses.id, acked, now, now, now + (opts.turn ? TURN_TOKEN_MS : TOKEN_IDLE_MS), opts.compact ? 1 : 0, opts.turn ? 'turn' : 'login', opts.turn?.runRef ?? null);
      this.db.prepare(`INSERT INTO message_delivery_cursors(agent_id,token_hash,room_id,delivered_seq,acked_seq,updated_at)
        SELECT agent_id, ?, room_id, MAX(acked_seq), MAX(acked_seq), ? FROM message_delivery_cursors WHERE agent_id=? GROUP BY room_id`).run(hash, now, ses.agent_id!);
    });
    this.db.prepare('UPDATE agents SET last_seen_at=? WHERE id=?').run(now, ses.agent_id!);
    return { token, credential: ses, concurrent: others > 0 };
  }

  /** Resolve a token presented with an app key. Slides the idle expiry. */
  resolveToken(app: Credential, token: string): { tokenHash: string; credential: Credential; agent: Agent; scope: 'login' | 'turn' } {
    if (!TOKEN_RE.test(token)) throw new KeyError('login_required', 'missing or malformed session_token; call session_login');
    const h = sha256Hex(token), now = Date.now();
    const t = this.db.prepare('SELECT * FROM session_tokens WHERE token_hash=?').get(h) as { app_credential_id: string; session_credential_id: string; expires_at: number; revoked_at: number | null; revoked_reason: string | null; suspended_at: number | null; scope: string } | undefined;
    if (!t || t.app_credential_id !== app.id) throw new KeyError('login_required', 'unknown session_token; call session_login');
    if (t.revoked_at === null && t.suspended_at !== null) throw new KeyError('key_inactive', 'this session moved to another place (checkout); it is suspended until the move ends');
    if (t.revoked_at !== null) {
      if (t.revoked_reason === 'rotated') throw new KeyError('key_rotated', 'your key was rotated; wait for the new key');
      if (t.revoked_reason === 'suspended' || t.revoked_reason === 'revoked' || t.revoked_reason === 'pc_suspended' || t.revoked_reason === 'leak_guard' || t.revoked_reason === 'archived') throw new KeyError('key_inactive', 'your session key is not active');
      throw new KeyError('login_required', 'this login ended; call session_login again');
    }
    if (t.expires_at <= now) throw new KeyError('login_required', 'session_token expired; call session_login again');
    const c = this.credential(t.session_credential_id)!;
    if (this.effectiveStatus(c) !== 'active') throw new KeyError('key_inactive', `your session key is ${this.effectiveStatus(c)}`);
    // A turn token is never slid by use: only the connector's renewal extends it, so a run the connector no longer vouches for runs out.
    if (t.scope === 'turn') this.db.prepare('UPDATE session_tokens SET last_used_at=? WHERE token_hash=?').run(now, h);
    else this.db.prepare('UPDATE session_tokens SET last_used_at=?, expires_at=? WHERE token_hash=?').run(now, now + TOKEN_IDLE_MS, h);
    this.db.prepare('UPDATE credentials SET last_used_at=? WHERE id=?').run(now, c.id);
    this.db.prepare('UPDATE agents SET last_seen_at=? WHERE id=?').run(now, c.agent_id!);
    return { tokenHash: h, credential: c, agent: this.agent(c.agent_id!)!, scope: t.scope === 'turn' ? 'turn' : 'login' };
  }

  /**
   * The app key's credential behind a live TURN token, for a call that carries the token alone (a session holds no app key).
   * Only turn tokens qualify; anything else, an expired or revoked token, or an app key that is no longer active, is refused.
   */
  appOfTurnToken(token: string): Credential {
    if (!TOKEN_RE.test(token)) throw new KeyError('login_required', 'missing or malformed turn token');
    const t = this.db.prepare('SELECT app_credential_id, expires_at, revoked_at, scope FROM session_tokens WHERE token_hash=?').get(sha256Hex(token)) as { app_credential_id: string; expires_at: number; revoked_at: number | null; scope: string } | undefined;
    if (!t || t.scope !== 'turn' || t.revoked_at !== null || t.expires_at <= Date.now()) throw new KeyError('login_required', 'this turn token is not valid (ended, expired or unknown)');
    const app = this.credential(t.app_credential_id);
    if (!app || app.kind !== 'app_key' || this.effectiveStatus(app) !== 'active') throw new KeyError('key_inactive', 'the PC behind this turn token is not active');
    return app;
  }

  /** The active app key credential of a PC, or null. */
  machineAppCredential(machineId: string): Credential | null {
    const c = this.db.prepare("SELECT id FROM credentials WHERE kind='app_key' AND machine_id=? AND status='active' ORDER BY created_at DESC").all(machineId) as { id: string }[];
    for (const r of c) { const cr = this.credential(r.id); if (cr && this.effectiveStatus(cr) === 'active') return cr; }
    return null;
  }

  /** Extends a live turn token of this PC by another TURN_TOKEN_MS. Refused once it ended, expired or is not this PC's. */
  renewTurn(app: Credential, token: string): { expires_at: number } {
    const now = Date.now(), h = sha256Hex(token);
    const t = this.db.prepare('SELECT app_credential_id, session_credential_id, expires_at, revoked_at, suspended_at, scope FROM session_tokens WHERE token_hash=?').get(h) as { app_credential_id: string; session_credential_id: string; expires_at: number; revoked_at: number | null; suspended_at: number | null; scope: string } | undefined;
    if (!t || t.scope !== 'turn' || t.app_credential_id !== app.id || t.revoked_at !== null || t.suspended_at !== null || t.expires_at <= now) throw new KeyError('login_required', 'this turn token cannot be renewed');
    const c = this.credential(t.session_credential_id);
    if (!c || this.effectiveStatus(c) !== 'active') throw new KeyError('key_inactive', 'the agent key behind this turn token is not active');
    const expires_at = now + TURN_TOKEN_MS;
    this.db.prepare('UPDATE session_tokens SET expires_at=? WHERE token_hash=?').run(expires_at, h);
    return { expires_at };
  }

  /** The agent of a live turn token of this PC, or null. */
  turnAgent(app: Credential, token: string): string | null {
    const r = this.db.prepare("SELECT c.agent_id a FROM session_tokens t JOIN credentials c ON c.id=t.session_credential_id WHERE t.token_hash=? AND t.app_credential_id=? AND t.scope='turn' AND t.revoked_at IS NULL AND t.expires_at>?").get(sha256Hex(token), app.id, Date.now()) as { a: string | null } | undefined;
    return r?.a ?? null;
  }

  /** Ends a turn token of this PC at once. Returns whether one was live. */
  revokeTurn(app: Credential, token: string, reason = 'turn_ended'): boolean {
    const r = this.db.prepare("UPDATE session_tokens SET revoked_at=?, revoked_reason=? WHERE token_hash=? AND app_credential_id=? AND scope='turn' AND revoked_at IS NULL").run(Date.now(), reason, sha256Hex(token), app.id);
    return Number(r.changes) > 0;
  }

  /** One turn token of this PC, live or not: its agent and run, and whether it is still live. Null when the PC never had it. */
  turnInfo(app: Credential, token: string): { agent: string | null; run: string | null; live: boolean } | null {
    const r = this.db.prepare("SELECT c.agent_id a, t.run_ref r, t.revoked_at x, t.suspended_at s, t.expires_at e FROM session_tokens t JOIN credentials c ON c.id=t.session_credential_id WHERE t.token_hash=? AND t.app_credential_id=? AND t.scope='turn'").get(sha256Hex(token), app.id) as { a: string | null; r: string | null; x: number | null; s: number | null; e: number } | undefined;
    return r ? { agent: r.a, run: r.r, live: r.x === null && r.s === null && r.e > Date.now() } : null;
  }

  /**
   * The runs of the other live turn tokens of one agent, issued at or before `issuedBy` (docs/connector.md, "Both levels"): a second
   * live run is two live bindings. A token issued after `issuedBy` is left out, so a `conclave check --probe` (issued and revoked
   * at once) never counts.
   */
  otherLiveRuns(agentId: string, run: string | null, issuedBy: number): string[] {
    return (this.db.prepare("SELECT DISTINCT t.run_ref r FROM session_tokens t JOIN credentials c ON c.id=t.session_credential_id WHERE c.agent_id=? AND t.scope='turn' AND t.revoked_at IS NULL AND t.suspended_at IS NULL AND t.expires_at>? AND t.created_at<=? AND t.run_ref IS NOT ?")
      .all(agentId, Date.now(), issuedBy, run) as { r: string | null }[]).map((x) => x.r ?? '');
  }

  /** How many live turn tokens an agent has. */
  liveTurnCount(agentId: string): number {
    return (this.db.prepare("SELECT COUNT(*) n FROM session_tokens t JOIN credentials c ON c.id=t.session_credential_id WHERE c.agent_id=? AND t.scope='turn' AND t.revoked_at IS NULL AND t.suspended_at IS NULL AND t.expires_at>?").get(agentId, Date.now()) as { n: number }).n;
  }

  logout(tokenHash: string): void {
    this.db.prepare("UPDATE session_tokens SET revoked_at=?, revoked_reason='logout' WHERE token_hash=? AND revoked_at IS NULL").run(Date.now(), tokenHash);
  }

  liveLogins(filter: { credentialId?: string } = {}): { token_hash: string; app_credential_id: string; session_credential_id: string; created_at: number; last_used_at: number; expires_at: number }[] {
    const now = Date.now();
    const sql = `SELECT token_hash,app_credential_id,session_credential_id,created_at,last_used_at,expires_at FROM session_tokens
      WHERE revoked_at IS NULL AND suspended_at IS NULL AND expires_at>? ${filter.credentialId ? 'AND (session_credential_id=? OR app_credential_id=?)' : ''} ORDER BY last_used_at DESC`;
    return (filter.credentialId ? this.db.prepare(sql).all(now, filter.credentialId, filter.credentialId) : this.db.prepare(sql).all(now)) as never;
  }

  // ───────────── Notices ─────────────
  /**
   * ref names what the notice is about, so it settles (stops being delivered) once it no longer describes the current
   * state (NOTICE_SETTLERS): a task that moved on, a directive the agent confirmed. The older `{task, state}` and
   * `{feedback, rev}` shapes are mapped to `{kind, id, state}` here.
   */
  /** Owner enforcement's check on a notice's subject (OwnerScope.maySeeNotice); null delivers every notice. */
  /** Set in app.ts: a notice was made (agent, kind, ref), for the connector's delivery orders. Never throws into the caller. */
  onNotice: ((agentId: string, kind: string, ref: { kind: NoticeRefKind; id: string } | null) => void) | null = null;
  /** Set in app.ts: a PC's access ended (suspended, retired) or one app key did, so its push stream closes. */
  onAccessEnded: ((e: { machine?: string; credential?: string }) => void) | null = null;
  noticeFilter: ((agentId: string, ref: { kind: NoticeRefKind; id: string } | null) => boolean) | null = null;
  notify(agentId: string, kind: string, body: string, ref?: NoticeRef): void {
    const r = !ref ? null : 'task' in ref ? { kind: 'task' as const, id: ref.task, state: ref.state } : 'feedback' in ref ? { kind: 'feedback' as const, id: ref.feedback, state: ref.rev } : ref;
    const state = r?.state === undefined || r.state === null ? null : String(r.state);
    // While owner enforcement is on, a notice about work the agent's owner may not see is not made at all (app.ts sets this).
    if (this.noticeFilter && !this.noticeFilter(agentId, r)) return;
    tx(this.db, () => {
      const seq = (this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 s FROM agent_notices WHERE agent_id=?').get(agentId) as { s: number }).s;
      // ref_kind/ref_id (0106) is the one ref shape; ref_task_id and ref_feedback_id are still written for one release.
      this.db.prepare('INSERT INTO agent_notices(id,agent_id,seq,kind,body,created_at,ref_task_id,ref_state,ref_feedback_id,ref_kind,ref_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(newId.notice(), agentId, seq, kind, body, Date.now(), r?.kind === 'task' ? r.id : null, state, r?.kind === 'feedback' ? r.id : null, r?.kind ?? null, r?.id ?? null);
    });
    try { this.onNotice?.(agentId, kind, r ? { kind: r.kind, id: r.id } : null); } catch { /* a delivery order never blocks the notice */ }
  }
  /** Notices after this login's cursor, without settled ones (NOTICE_SETTLERS).
      Settled ones are skipped, not acknowledged: the cursor is cumulative and must not clear unrelated notices. */
  pendingNotices(tokenHash: string, agentId: string): Notice[] {
    const acked = (this.db.prepare('SELECT notice_acked_seq s FROM session_tokens WHERE token_hash=?').get(tokenHash) as { s: number } | undefined)?.s ?? 0;
    return this.db.prepare(`SELECT n.* FROM agent_notices n WHERE n.agent_id=? AND n.seq>? AND ${CURRENT_NOTICE} ORDER BY n.seq`).all(agentId, acked) as unknown as Notice[];
  }
  /** The agent's newest notices for the console Inbox, newest first, each with `current` (1 unless the hub settled it
      before delivery, so it never reaches the agent). Read only: it confirms nothing (dashboard-ux.md, Agent page). */
  recentNotices(agentId: string, limit = 50): { seq: number; kind: string; body: string; created_at: number; delivered_at: number | null; current: number }[] {
    return this.db.prepare(`SELECT n.seq,n.kind,n.body,n.created_at,n.delivered_at,CASE WHEN ${CURRENT_NOTICE} THEN 1 ELSE 0 END current
      FROM agent_notices n WHERE n.agent_id=? ORDER BY n.seq DESC LIMIT ?`).all(agentId, limit).map((n) => ({ ...n, body: plainNotice(String(n.body)) })) as unknown as { seq: number; kind: string; body: string; created_at: number; delivered_at: number | null; current: number }[];
  }
  /** This login's delivery cursor (docs/mcp.md, "Replies and notices"): every pending notice up to it rode inline once. */
  deliveredSeq(tokenHash: string): number {
    return (this.db.prepare('SELECT notice_delivered_seq s FROM session_tokens WHERE token_hash=?').get(tokenHash) as { s: number } | undefined)?.s ?? 0;
  }
  /**
   * Record that these notices reached this login inline: its delivery cursor moves to the highest, and each notice keeps the
   * first time any login of its agent received it (the console Inbox's "Delivered"). Delivery confirms nothing: the
   * notices stay pending, and counted, until session_ack.
   */
  markDelivered(tokenHash: string, notices: { seq: number; id?: string }[]): void {
    if (!notices.length) return;
    const now = Date.now(), top = Math.max(...notices.map((n) => n.seq));
    tx(this.db, () => {
      this.db.prepare('UPDATE session_tokens SET notice_delivered_seq=MAX(notice_delivered_seq, ?) WHERE token_hash=?').run(top, tokenHash);
      const set = this.db.prepare('UPDATE agent_notices SET delivered_at=? WHERE id=? AND delivered_at IS NULL');
      for (const n of notices) if (n.id) set.run(now, n.id);
    });
  }
  /** Whether this login asked for compact replies at session_login. */
  compact(tokenHash: string): boolean {
    return !!(this.db.prepare('SELECT compact FROM session_tokens WHERE token_hash=?').get(tokenHash) as { compact: number } | undefined)?.compact;
  }
  /** Whether a stored notice is still current: not settled (always true for notices without a ref). */
  noticeCurrent(noticeId: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM agent_notices n WHERE n.id=? AND ${CURRENT_NOTICE}`).get(noticeId);
  }
  /** Confirm notices up to upTo, never past the agent's newest notice: a too-large number would hide every future one. */
  ackNotices(tokenHash: string, upTo: number): void {
    this.db.prepare(`UPDATE session_tokens SET notice_acked_seq=MAX(notice_acked_seq, MIN(?, (SELECT COALESCE(MAX(n.seq),0) FROM agent_notices n
      JOIN credentials c ON c.agent_id=n.agent_id WHERE c.id=session_tokens.session_credential_id))) WHERE token_hash=?`).run(upTo, tokenHash);
  }
}
