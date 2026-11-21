/**
 * Key handovers (docs/onboarding.md#key-handover-a-rotated-key-or-a-recruit-reaches-a-connector-pc): the hub files an
 * approved onboarding request for one PC and one app key, the PC's user allows it on the connector's screen, and the
 * connector picks the keys up with the ordinary pickup (onboarding.ts) and confirms. A rotation's old key keeps working
 * until confirm; a handover not confirmed within 24 hours is cancelled. No secret is kept here or written to the audit.
 */
import type { Db } from '../db/db.js';
import { tx } from '../db/db.js';
import type { Audit, Actor } from '../audit/audit.js';
import { randomToken } from '../util/crypto.js';
import { KeyError, SESSION_VAR_RE, type Credential, type Keys } from './keys.js';

export const HANDOVER_TTL_MS = 24 * 60 * 60 * 1000;
export type HandoverKind = 'rotate' | 'recruit';
export type CancelReason = 'operator' | 'expired' | 'replaced' | 'revoked' | 'binding_changed' | 'not_on_pc' | 'folder_refused' | 'team_ended';
/** What the connector lists (GET /connector/v1/handovers): no secret, only the public id of a key being replaced. */
export interface HandoverListing { id: string; kind: HandoverKind; description: string; agents: { agent_id: string; label: string; key_id: string | null }[]; expires_at: number; no_click?: true }
/** An open rotation as the key's page shows it. */
export interface OpenHandover { id: string; pc: { id: string; name: string }; created_at: number; expires_at: number; picked_up: boolean }
/** The body a rotation's request keeps: why, and who rotated (the actor of the key.rotate at confirm). */
export interface RotateBody { kind: 'rotate'; reason: 'routine' | 'suspected_leak' | 're_enrol' | null; by: Actor }

const sys: Actor = { kind: 'system', id: null };
const rotateReason = (body: string | null): RotateBody['reason'] => { try { return body ? (JSON.parse(body) as RotateBody).reason ?? null : null; } catch { return null; } };
const OPEN = "state='approved' AND handover IS NOT NULL";

export class Handovers {
  /** Set by app.ts: tells the PC's connector that a handover waits (`event: handovers` on its push stream). */
  hint: ((machineId: string) => void) | null = null;
  /** Set by onboarding: a recruit's handover is cancelled the onboarding way (its waiting agent is archived). */
  cancelRecruit: ((requestId: string, note: string, actor: Actor) => void) | null = null;
  /** Set by onboarding: replace the PC's connector app key (revoke it, issue a new key and pairing code, move its handovers). */
  replaceAppKey: ((machineId: string, oldAppId: string, actor: Actor, why: string) => { key: Credential; code: string }) | null = null;
  /** Set by onboarding: a Re-enrol's handover reached a PC that holds none of the keys (reinstalled or replaced): the old way. */
  reEnrolKeysLost: ((machineId: string, credentialIds: string[]) => void) | null = null;

  constructor(private db: Db, private keys: Keys, private audit: Audit, private now: () => number = Date.now) {
    keys.handoverCancel = (credentialId, reason, actor) => this.cancelFor(credentialId, reason, actor);
  }

  /**
   * The app key a handover for this PC is bound to: the one its connector last checked in with, when it is still an active
   * app key of that PC. Null: the PC runs no connector, so nobody there could allow a handover; the caller shows the key once.
   */
  appKeyFor(machineId: string): Credential | null {
    const rep = this.db.prepare('SELECT app_credential_id a FROM connector_reports WHERE machine_id=?').get(machineId) as { a: string | null } | undefined;
    const c = rep?.a ? this.keys.credential(rep.a) : null;
    return c && c.kind === 'app_key' && c.machine_id === machineId && this.keys.effectiveStatus(c) === 'active' ? c : null;
  }

  /**
   * Rotate a session key by handover: an approved request of kind rotate for the key's PC, bound to the app key there.
   * Nothing changes on the key until confirm. An open handover of the same key is replaced. Null when the key's PC runs
   * no connector (or is retired): the caller shows the raw key once instead.
   *
   * After a possible leak (reason suspected_leak) the PC's connector app key is replaced first (docs/onboarding.md, key
   * handover): whoever took the session key may hold that app key too. Only the connector's app key is revoked; a new one
   * and its pairing code are issued, the code is answered here once (`pairing`), and the handover is bound to the new key.
   * It waits, with the usual 24-hour expiry, until the PC user pairs the connector again and it picks the key up.
   */
  rotate(credentialId: string, actor: Actor, reason: 'routine' | 'suspected_leak' | null = null): (OpenHandover & { pairing?: { code: string; app_key: string } }) | null {
    const c = this.keys.credential(credentialId);
    if (!c) throw new KeyError('not_found', 'key not found');
    if (c.kind !== 'session_key') return null;
    if (c.status === 'revoked') throw new KeyError('invalid_state', 'a revoked key cannot be rotated');
    if (c.succession) throw new KeyError('invalid_state', 'This key has a checkout successor that is not settled. Finish or cancel the checkout first.');
    const t = this.keys.keyTarget(credentialId);
    let app = t.pc ? this.appKeyFor(t.pc.id) : null;
    if (!t.pc || !app) return null;
    let pairing: { code: string; app_key: string } | undefined;
    const pc = t.pc;
    // A leak rotation replaces the app key, files the handover and holds the suspected key in one transaction: if the
    // handover cannot be filed, nothing is replaced. The held key's logins and turn tokens end at once; confirm revokes it.
    const id = tx(this.db, () => {
      if (reason === 'suspected_leak' && this.replaceAppKey) {
        const r = this.replaceAppKey(pc.id, app!.id, actor, 'suspected_leak');
        app = r.key; pairing = { code: r.code, app_key: r.key.id };
      }
      const filed = this.file(pc.id, app!, [credentialId], actor, reason);
      if (filed && reason === 'suspected_leak') this.keys.hold(credentialId, actor);
      return filed;
    });
    if (!id) return null;
    return { ...this.open(credentialId)!, ...(pairing ? { pairing } : {}) };
  }

  /**
   * Re-enrol (onboarding.reEnrol): one handover that rotates every given key of this PC, bound to the PC's new app key. The
   * old keys keep working until the connector confirms; one click on the PC covers them all. Null when there is no key.
   */
  rotateAll(machineId: string, app: Credential, credentialIds: string[], actor: Actor): string | null {
    const live = credentialIds.filter((id) => { const c = this.keys.credential(id); return c && c.kind === 'session_key' && c.status !== 'revoked' && !c.succession; });
    return live.length ? this.file(machineId, app, live, actor, 're_enrol') : null;
  }

  private file(machineId: string, app: Credential, credentialIds: string[], actor: Actor, reason: RotateBody['reason']): string | null {
    const id = `obr_${randomToken(10)}`, now = this.now(), expires = now + HANDOVER_TTL_MS;
    const body: RotateBody = { kind: 'rotate', reason, by: actor };
    const agents: (string | null)[] = [];
    tx(this.db, () => {
      for (const cid of credentialIds) this.cancelFor(cid, 'replaced', actor);
      this.db.prepare(`INSERT INTO onboarding_requests(id,app_credential_id,machine_id,kind,state,version,body,approved_body,team_id,start_when_set_up,filed_at,updated_at,waiting_since,decided_at,handover,expires_at)
        VALUES (?,?,?,'rotate','approved',1,?,?,NULL,0,?,?,?,?,'rotate',?)`).run(id, app.id, machineId, JSON.stringify(body), JSON.stringify(body), now, now, now, now, expires);
      for (const cid of credentialIds) {
        const c = this.keys.credential(cid)!, t = this.keys.keyTarget(cid);
        const agent = c.agent_id ? this.keys.agent(c.agent_id) : null;
        const sv = t.session_var && SESSION_VAR_RE.test(t.session_var) ? t.session_var : 'SESSION_KEY';
        this.db.prepare(`INSERT INTO onboarding_slots(id,request_id,slot,agent_id,role,team_role,label,session_var,folder,bound,template_id,ceiling,credential_id,status,created_at)
          VALUES (?,?,?,?,'rotate','worker',?,?,?,1,NULL,'[]',?,'waiting',?)`).run(`obs_${randomToken(8)}`, id, credentialIds.length > 1 ? `key${agents.length + 1}` : 'key', c.agent_id, agent?.label ?? c.label, sv, t.folder ?? '', cid, now);
        agents.push(c.agent_id);
      }
      this.audit.event(actor, 'key.handover.created', credentialIds.length === 1 ? { kind: 'credential', id: credentialIds[0]! } : { kind: 'onboarding_request', id }, { handover: id, kind: 'rotate', pc: machineId, app_key: app.id, agents, reason, expires_at: expires });
    });
    this.hint?.(machineId);
    return id;
  }

  /** A recruit's request was filed as a handover (onboarding.recruitFile): audit it and tell the PC. */
  recruitFiled(requestId: string, machineId: string, appId: string, agents: string[], actor: Actor, expires: number): void {
    this.audit.event(actor, 'key.handover.created', { kind: 'onboarding_request', id: requestId }, { handover: requestId, kind: 'recruit', pc: machineId, app_key: appId, agents, expires_at: expires });
    this.hint?.(machineId);
  }

  /** The open rotation that carries this key, if any. */
  open(credentialId: string): OpenHandover | null {
    const r = this.db.prepare(`SELECT r.id, r.machine_id, r.filed_at, r.expires_at, r.pickup_id FROM onboarding_requests r JOIN onboarding_slots s ON s.request_id=r.id
      WHERE r.state='approved' AND r.handover='rotate' AND s.credential_id=? AND r.expires_at>? ORDER BY r.filed_at DESC LIMIT 1`).get(credentialId, this.now()) as { id: string; machine_id: string; filed_at: number; expires_at: number; pickup_id: string | null } | undefined;
    if (!r) return null;
    const pc = this.keys.machine(r.machine_id);
    return { id: r.id, pc: { id: r.machine_id, name: pc?.name ?? r.machine_id }, created_at: r.filed_at, expires_at: r.expires_at, picked_up: !!r.pickup_id };
  }

  /**
   * The PC a rotation of this key would go to by handover (its connector checked in with an active app key), or null:
   * the console's Rotate sheet says "Rotate and send to <PC>" or "Rotate and show the key once" from this.
   */
  target(credentialId: string): { id: string; name: string } | null {
    const c = this.keys.credential(credentialId);
    if (!c || c.kind !== 'session_key' || c.status === 'revoked') return null;
    const t = this.keys.keyTarget(credentialId);
    return t.pc && this.appKeyFor(t.pc.id) ? { id: t.pc.id, name: t.pc.name } : null;
  }
  /**
   * The rotation of this key (or of the key it replaced) confirmed in the last 24 hours: the key's page shows it in green,
   * and the old key's page links to the new key.
   */
  confirmed(credentialId: string): { id: string; pc: { id: string; name: string }; confirmed_at: number; key: string } | null {
    const r = this.db.prepare(`SELECT r.id, r.machine_id, r.collected_at, s.credential_id FROM onboarding_requests r JOIN onboarding_slots s ON s.request_id=r.id
      WHERE r.handover='rotate' AND r.state='collected' AND r.collected_at>? AND (s.credential_id=? OR s.credential_id IN (SELECT id FROM credentials WHERE replaces_credential_id=?))
      ORDER BY r.collected_at DESC LIMIT 1`).get(this.now() - HANDOVER_TTL_MS, credentialId, credentialId) as { id: string; machine_id: string; collected_at: number; credential_id: string } | undefined;
    if (!r) return null;
    const pc = this.keys.machine(r.machine_id);
    return { id: r.id, pc: { id: r.machine_id, name: pc?.name ?? r.machine_id }, confirmed_at: r.collected_at, key: r.credential_id };
  }

  /** The rotation of this key a PC's connector skipped in the last 24 hours because that PC does not hold the key (not_on_pc). */
  notOnPc(credentialId: string): { id: string; pc: { id: string; name: string }; at: number } | null {
    if (this.open(credentialId)) return null;
    const r = this.db.prepare(`SELECT r.id, r.machine_id, r.decided_at FROM onboarding_requests r JOIN onboarding_slots s ON s.request_id=r.id
      WHERE r.handover='rotate' AND r.state='cancelled' AND r.operator_note='not_on_pc' AND r.decided_at>? AND s.credential_id=?
      ORDER BY r.decided_at DESC LIMIT 1`).get(this.now() - HANDOVER_TTL_MS, credentialId) as { id: string; machine_id: string; decided_at: number } | undefined;
    if (!r) return null;
    return { id: r.id, pc: { id: r.machine_id, name: this.keys.machine(r.machine_id)?.name ?? r.machine_id }, at: r.decided_at };
  }

  /** The open handovers for one app key, as its connector lists them. */
  list(app: Credential): HandoverListing[] {
    const rows = this.db.prepare(`SELECT id, handover, team_id, expires_at FROM onboarding_requests WHERE ${OPEN} AND app_credential_id=? AND expires_at>? ORDER BY filed_at`).all(app.id, this.now()) as { id: string; handover: HandoverKind; team_id: string | null; expires_at: number }[];
    return rows.map((r) => {
      const slots = this.db.prepare("SELECT agent_id, label, credential_id FROM onboarding_slots WHERE request_id=? AND status<>'closed' ORDER BY rowid").all(r.id) as { agent_id: string; label: string; credential_id: string | null }[];
      const agents = slots.map((s) => {
        const c = r.handover === 'rotate' && s.credential_id ? this.keys.credential(s.credential_id) : null;
        return { agent_id: s.agent_id, label: s.label, key_id: c && this.keys.hasSecret(c.id) ? c.key_id : null };
      });
      const team = r.team_id ? (this.db.prepare('SELECT name FROM teams WHERE id=?').get(r.team_id) as { name: string } | undefined)?.name ?? null : null;
      const description = r.handover === 'rotate'
        ? `New key for ${agents.map((a) => a.label).join(', ')} (rotation)`
        : `${agents.length} new ${agents.length === 1 ? 'agent' : 'agents'} for team ${team ?? 'unknown'}`;
      // A recruit of a team the operator set to Automatic was allowed when the operator set it: the connector needs no click on the PC (standard level only).
      const auto = r.handover === 'recruit' && !!r.team_id && (this.db.prepare('SELECT recruiting FROM teams WHERE id=?').get(r.team_id) as { recruiting: string } | undefined)?.recruiting === 'auto';
      return { id: r.id, kind: r.handover, description, agents, expires_at: r.expires_at, ...(auto ? { no_click: true as const } : {}) };
    });
  }
  /** How many handovers wait for this app key (the check-in's `handovers`). */
  count(appId: string | null | undefined): number {
    if (!appId) return 0;
    return (this.db.prepare(`SELECT COUNT(*) n FROM onboarding_requests WHERE ${OPEN} AND app_credential_id=? AND expires_at>?`).get(appId, this.now()) as { n: number }).n;
  }

  /** Cancel one open handover (the operator's Cancel, expiry, a replacement, or the key's revoke or re-binding). */
  cancel(id: string, reason: CancelReason, actor: Actor): boolean {
    const r = this.db.prepare(`SELECT id, handover, machine_id, body FROM onboarding_requests WHERE id=? AND ${OPEN}`).get(id) as { id: string; handover: HandoverKind; machine_id: string; body: string | null } | undefined;
    if (!r) return false;
    const agents = (this.db.prepare('SELECT agent_id FROM onboarding_slots WHERE request_id=?').all(id) as { agent_id: string }[]).map((s) => s.agent_id);
    if (r.handover === 'recruit') {
      if (!this.cancelRecruit) return false;
      this.cancelRecruit(id, reason === 'expired' ? 'The PC did not pick the recruit up within 24 hours.' : reason === 'team_ended' ? 'Recruiting ended for the team.' : 'The handover was cancelled.', actor);
    } else {
      tx(this.db, () => {
        this.db.prepare("UPDATE onboarding_slots SET status='closed', staged_key_id=NULL, staged_verifier=NULL WHERE request_id=?").run(id);
        // The reason stays on the row (the key's page says "Not on <PC>" after a not_on_pc skip); a handover row is never shown as a request.
        this.db.prepare("UPDATE onboarding_requests SET state='cancelled', operator_note=?, version=version+1, updated_at=?, decided_at=? WHERE id=?").run(reason, this.now(), this.now(), id);
      });
    }
    // A leak rotation that ends without confirm leaves its key held (Keys.hold): the audit says it was one.
    const leak = r.handover === 'rotate' && rotateReason(r.body) === 'suspected_leak';
    this.audit.event(actor, 'key.handover.cancelled', { kind: 'onboarding_request', id }, { kind: r.handover, pc: r.machine_id, agents, reason, ...(leak ? { rotation_reason: 'suspected_leak' } : {}) });
    return true;
  }
  /**
   * The connector says it cannot take this handover (POST /connector/v1/handovers/:id/skip): the PC does not hold the key
   * being rotated (`key_not_held`, cancelled as `not_on_pc`), or the recruit's folder broke the folder rules (`folder_refused`).
   * Only the app key the handover is bound to may skip it; anything else reads as not found.
   */
  skip(app: Credential, id: string, reason: 'key_not_held' | 'folder_refused'): void {
    const actor: Actor = { kind: 'agent', id: app.id };
    const r = this.db.prepare(`SELECT app_credential_id a, handover, machine_id, body FROM onboarding_requests WHERE id=? AND ${OPEN}`).get(id) as { a: string | null; handover: HandoverKind; machine_id: string; body: string } | undefined;
    if (!r || r.a !== app.id || (reason === 'key_not_held' && r.handover !== 'rotate')) throw new KeyError('not_found', 'No such handover for this PC.');
    const creds = (this.db.prepare('SELECT credential_id FROM onboarding_slots WHERE request_id=? AND credential_id IS NOT NULL').all(id) as { credential_id: string }[]).map((x) => x.credential_id);
    this.cancel(id, reason === 'key_not_held' ? 'not_on_pc' : 'folder_refused', actor);
    // A Re-enrol's handover on a PC that holds none of its keys (reinstalled, replaced): those keys are revoked and the PC's
    // collected requests reopened for a new pickup, as Re-enrol did before the handover. A lost PC's keys never stay valid.
    if (reason === 'key_not_held' && rotateReason(r.body) === 're_enrol') this.reEnrolKeysLost?.(r.machine_id, creds);
  }
  /**
   * A key held by a leak rotation that has no open handover any more (expired, cancelled, skipped): "Leak rotation not
   * finished: rotate again or revoke" on the key's page and in Needs you.
   */
  leakUnfinished(credentialId: string): boolean {
    const c = this.keys.credential(credentialId);
    return !!c && this.keys.isHeld(c) && !this.open(credentialId);
  }
  /** The open rotations that carry this key are cancelled (Keys.handoverCancel). */
  cancelFor(credentialId: string, reason: CancelReason, actor: Actor): number {
    const ids = (this.db.prepare(`SELECT DISTINCT r.id FROM onboarding_requests r JOIN onboarding_slots s ON s.request_id=r.id WHERE r.state='approved' AND r.handover='rotate' AND s.credential_id=?`).all(credentialId) as { id: string }[]).map((x) => x.id);
    let n = 0;
    for (const id of ids) if (this.cancel(id, reason, actor)) n++;
    return n;
  }
  /** Upkeep: a handover not confirmed within 24 hours is cancelled. */
  sweep(): number {
    const ids = (this.db.prepare(`SELECT id FROM onboarding_requests WHERE ${OPEN} AND expires_at<=?`).all(this.now()) as { id: string }[]).map((x) => x.id);
    let n = 0;
    for (const id of ids) { try { if (this.cancel(id, 'expired', sys)) n++; } catch { /* the next sweep tries again */ } }
    return n;
  }
}
