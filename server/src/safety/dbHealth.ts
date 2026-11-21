/**
 * Database health (docs/operations.md): the clean-up rules on top of Reset's foreign-key walk, backup first, the audit
 * archive and its forward-only horizon, key tombstones, integrity checks, compaction, daily counts and the run history.
 *
 * Each rule names the tables it may touch. A seed table carries a predicate (what is old and finished); a follower table
 * (null) is any row that hangs off a removed row. A row is a candidate only if every row that points at it is in a table
 * the rule may touch and is itself removable (the guard, built from the schema's own foreign keys). The walk then marks
 * exactly what goes; if it still reaches a table the rule may not touch, the rule is refused, never trimmed.
 */
import { backup as sqliteBackup } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, statfsSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { Db } from '../db/db.js';
import { tx } from '../db/db.js';
import type { Audit, Actor } from '../audit/audit.js';
import type { Keys } from '../keys/keys.js';
import type { Lockdown } from './lockdown.js';
import { KEEP, RESET_PARTS, Reset } from './reset.js';
import { DEFAULT_RETENTION, type RetentionConfig } from './retention.js';

const DAY = 86400_000;
export const AUDIT_MIN_DAYS = 365;
const SYSTEM: Actor = { kind: 'system', id: 'db-health' };

export class HealthError extends Error {
  constructor(readonly code: 'invalid_argument' | 'not_found' | 'conflict' | 'locked' | 'refused', message: string) { super(message); }
}

type Pred = (a: string, cutoff: number, now: number) => string;
interface RuleDef {
  key: string; label: string; detail: string; keeps: string; dflt: number; min: number; optIn?: boolean;
  /** No switch and never scheduled: only an operator runs it, from its preview. */
  manual?: boolean;
  /** Tables the rule may touch: a predicate for a seed table, null for a follower. */
  tables?: Record<string, Pred | null>;
  /** Tables whose predicate only limits which rows may go along with a removed parent; they never seed a removal of their own. */
  guardOnly?: string[];
}

const openAlert = (a: string) => `NOT EXISTS (SELECT 1 FROM security_alerts s WHERE s.subject=${a}.id AND s.status='open')`;
const revokedKey: Pred = (a, c) => `${a}.status='revoked' AND ${a}.revoked_at<${c} AND ${openAlert(a)}`;

export const RULES: RuleDef[] = [
  { key: 'audit', label: 'Audit trail', dflt: 365, min: AUDIT_MIN_DAYS,
    detail: 'Audit rows older than this go to a compressed archive beside the backups, with a hash chain that proves it whole, then leave the hub.',
    keeps: 'The last 365 days, and every audit.trimmed record.' },
  { key: 'activity', label: 'Activity log', dflt: 180, min: 30,
    detail: 'Sign-in events, tool calls, file access events, and alerts that are no longer open.',
    keeps: 'Open alerts.',
    tables: {
      authentication_events: (a, c) => `${a}.created_at<${c}`,
      tool_invocations: (a, c) => `${a}.created_at<${c}`,
      resource_access_events: (a, c) => `${a}.created_at<${c}`,
      security_alerts: (a, c) => `${a}.status<>'open' AND ${a}.updated_at<${c}`,
    } },
  { key: 'revoked_keys', label: 'Revoked keys', dflt: 90, min: 30,
    detail: 'Keys revoked longer ago than this, with their logins, read positions and key rules.',
    keeps: 'A tombstone of each key, so its reuse still raises the reused-key alert; keys with anything they wrote, a pending handover, a checkout successor or an open alert.',
    tables: {
      credentials: revokedKey,
      permission_policies: (a, c) => `${a}.kind='credential' AND ${a}.id IN (SELECT k.policy_id FROM credentials k WHERE ${revokedKey('k', c, 0)})`,
      session_tokens: null, message_delivery_cursors: null, message_ack_snapshots: null, permission_rules: null, policy_versions: null,
    } },
  { key: 'suspended_keys', label: 'Suspended keys', dflt: 180, min: 30, optIn: true, manual: true,
    detail: 'By hand only: you revoke the keys suspended longer than this, each as your own key revoke. They then follow the Revoked keys rule.',
    keeps: 'Keys moved by a checkout, with a pending handover, or with an open alert.' },
  { key: 'finished', label: 'Finished items', dflt: 90, min: 30,
    detail: 'Decided onboarding requests, ended checkouts with their handouts, used or expired enrolment, setup and pairing codes, and key pickups and collections.',
    keeps: 'Anything still open.',
    tables: {
      onboarding_requests: (a, c) => `${a}.state IN ('collected','denied','withdrawn','cancelled') AND ${a}.updated_at<${c}`,
      onboarding_events: null, onboarding_slots: null,
      checkouts: (a, c) => `${a}.status IN ('restored','cancelled','expired') AND ${a}.updated_at<${c}`,
      handouts: null, checkout_scans: null,
      enrolment_codes: (a, c, n) => `(${a}.status IN ('confirmed','revoked') OR COALESCE(${a}.expires_at, ${n})<${n}) AND ${a}.created_at<${c}`,
      setup_keys: (a, c) => `${a}.expires_at<${c} AND COALESCE(${a}.pairing_expires_at, 0)<${c}`,
      key_pickups: (a, c, n) => `(${a}.status IN ('used','void') OR ${a}.expires_at<${n}) AND ${a}.created_at<${c}`,
      key_collections: (a, c) => `${a}.status<>'open' AND ${a}.created_at<${c}`,
      key_collect_polls: (a, c) => `${a}.last_at<${c}`,
    } },
  { key: 'stale', label: 'Stale PCs and agents', dflt: 180, min: 90,
    detail: 'Retired PCs with no keys, agents or open orders, and archived agents in no team that never wrote anything.',
    keeps: 'Any agent with a record it wrote: it stays as a named record.',
    tables: {
      machines: (a, c) => `${a}.status='retired' AND COALESCE(${a}.bridge_last_seen_at, ${a}.created_at)<${c}`,
      machine_folders: null, connector_reports: null, connector_usage: null, message_shown: null, agent_context: null,
      pc_actions: (a) => `${a}.state IN ('done','failed','expired','removed')`,
      agents: (a, c) => `${a}.status='archived' AND COALESCE(${a}.archived_at, ${a}.last_seen_at, ${a}.created_at)<${c} AND COALESCE(${a}.last_seen_at, 0)<${c}`,
      agent_notices: null, agent_links: null, directive_acks: null, directive_reads: null, room_memberships: null,
      credentials: (a) => `${a}.kind='session_key' AND ${a}.first_used_at IS NULL`,
    },
    guardOnly: ['pc_actions', 'credentials'] },
];

/** The rules the hub always ran: their days can be raised, never lowered below the hub's defaults. */
export const BUILTIN = [
  { key: 'shares', label: 'Closed shares', setting: 'retention.shares_days', cfg: 'sharesDays' },
  { key: 'channels', label: 'Finished transfer channels', setting: 'retention.channels_days', cfg: 'channelsDays' },
  { key: 'work_items', label: 'Acknowledged work items', setting: 'retention.work_items_days', cfg: 'workItemsDays' },
  { key: 'usage', label: 'Daily connector usage', setting: 'retention.usage_days', cfg: 'usageDays' },
] as const;

export interface RuleState { key: string; label: string; detail: string; keeps: string; enabled: boolean; days: number; min: number; opt_in: boolean; builtin: boolean; manual: boolean }
export interface Preview {
  rule: string; days: number; cutoff: number; total: number;
  tables: { table: string; rows: number }[];
  range: { from: number | null; to: number | null };
  keeps: string;
  /** Set when the walk reaches a table the rule may not touch: the rule is refused. */
  refused: string | null;
  /** Suspended keys only: each key the run would revoke. */
  items?: { id: string; label: string; agent: string | null; suspended_at: number | null }[];
}
export interface RunResult extends Preview { backup: string | null; preview_total: number | null; difference: number | null; archive?: string | null }

export interface DbHealthDeps { db: Db; audit: Audit; keys: Keys; lockdown: Lockdown; dbFile: string; backupDir: string; blobsDir?: string; retention?: RetentionConfig }

export class DbHealth {
  private readonly reset: Reset;
  private busy: string | null = null;
  constructor(private readonly d: DbHealthDeps) { this.reset = new Reset(d.db); }

  private get db(): Db { return this.d.db; }
  private setting<T>(key: string): T | undefined {
    const r = this.db.prepare('SELECT value FROM system_settings WHERE key=?').get(key) as { value: string } | undefined;
    if (!r) return undefined;
    try { return JSON.parse(r.value) as T; } catch { return undefined; }
  }
  private put(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO system_settings(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at')
      .run(key, JSON.stringify(value), Date.now());
  }

  // ───────────── Rules ─────────────

  rules(): RuleState[] {
    const cfg = this.d.retention ?? DEFAULT_RETENTION;
    const own = RULES.map((r) => {
      const s = this.setting<{ enabled?: boolean; days?: number }>(`retention.rule.${r.key}`) ?? {};
      return { key: r.key, label: r.label, detail: r.detail, keeps: r.keeps, enabled: !r.manual && !!s.enabled, days: Math.max(r.min, Number(s.days) || r.dflt), min: r.min, opt_in: !!r.optIn, builtin: false, manual: !!r.manual };
    });
    const built = BUILTIN.map((b) => {
      const floor = cfg[b.cfg];
      return { key: b.key, label: b.label, detail: 'Always on.', keeps: '', enabled: true, days: Math.max(floor, Number(this.setting<number>(b.setting)) || floor), min: floor, opt_in: false, builtin: true, manual: false };
    });
    return [...own, ...built];
  }
  rule(key: string): RuleState {
    const r = this.rules().find((x) => x.key === key);
    if (!r) throw new HealthError('not_found', `No clean-up rule named ${key}.`);
    return r;
  }

  /** Change a rule: on or off, and its days (never below its lowest; a built-in rule only upward). Audited as retention.rule_set. */
  setRule(key: string, change: { enabled?: boolean; days?: number }, actor: Actor): RuleState {
    const before = this.rule(key);
    if (change.days !== undefined && (!Number.isInteger(change.days) || change.days < before.min || change.days > 3650)) {
      throw new HealthError('invalid_argument', before.builtin ? `${before.label}: days can only be raised, to at least ${before.min}.` : `${before.label}: days must be ${before.min} to 3650.`);
    }
    if (before.manual && change.enabled !== undefined) throw new HealthError('invalid_argument', `${before.label} has no switch: it runs only when you run it.`);
    if (before.builtin && change.enabled === false) throw new HealthError('invalid_argument', `${before.label} always runs; only its days can be raised.`);
    const b = BUILTIN.find((x) => x.key === key);
    if (b) { if (change.days !== undefined) this.put(b.setting, change.days); }
    else this.put(`retention.rule.${key}`, { enabled: change.enabled ?? before.enabled, days: change.days ?? before.days });
    const after = this.rule(key);
    const now = Date.now();
    this.d.audit.event(actor, 'retention.rule_set', { kind: 'retention_rule', id: key }, { before: { enabled: before.enabled, days: before.days }, after: { enabled: after.enabled, days: after.days } });
    this.record('rule_set', key, actor.kind === 'system' ? 'scheduled' : 'manual', true, 0, null, { before: { enabled: before.enabled, days: before.days }, after: { enabled: after.enabled, days: after.days } }, actor.id, now);
    return after;
  }

  /** The guard: rows pointing at a row of `table` (alias a) are all in tables the rule may touch, and removable themselves. */
  private guard(def: RuleDef, table: string, a: string, cutoff: number, now: number, depth = 0, n = { i: 0 }): string {
    const parts: string[] = [];
    for (const fk of this.reset.childrenOf(table)) {
      const x = `g${++n.i}`;
      const on = fk.from.map((f, i) => `${x}."${f}"=${a}."${fk.to[i]}"`).join(' AND ');
      const allowed = def.tables![fk.child] !== undefined && !KEEP.has(fk.child) && fk.child !== table && depth < 4;
      if (!allowed) { parts.push(`NOT EXISTS (SELECT 1 FROM "${fk.child}" ${x} WHERE ${on})`); continue; }
      const pred = def.tables![fk.child];
      const inner = [pred ? pred(x, cutoff, now) : '', this.guard(def, fk.child, x, cutoff, now, depth + 1, n)].filter(Boolean).join(' AND ');
      if (inner) parts.push(`NOT EXISTS (SELECT 1 FROM "${fk.child}" ${x} WHERE ${on} AND NOT (${inner}))`);
    }
    return parts.join(' AND ');
  }

  private seeds(def: RuleDef, cutoff: number, now: number): { table: string; where: string }[] {
    return Object.entries(def.tables!).filter(([t, p]) => p && !def.guardOnly?.includes(t)).map(([table, p]) => {
      const a = `"${table}"`;
      const where = [p!(a, cutoff, now), this.guard(def, table, a, cutoff, now)].filter(Boolean).join(' AND ');
      return { table, where };
    });
  }

  /** Mark (inside the caller's transaction) and count. Tables a rule may not touch refuse it. */
  private mark(def: RuleDef, cutoff: number, now: number): { counts: Map<string, number>; refused: string | null } {
    const counts = this.reset.walk(this.seeds(def, cutoff, now));
    const outside = [...counts].filter(([t, n]) => n > 0 && def.tables![t] === undefined).map(([t]) => t);
    return { counts, refused: outside.length ? `It would also remove rows from ${outside.join(', ')}, which this rule never touches, so it was refused.` : null };
  }

  private suspendedCandidates(cutoff: number): { id: string; label: string; agent: string | null; suspended_at: number }[] {
    return this.db.prepare(`SELECT c.id, c.label, (SELECT a.label FROM agents a WHERE a.id=c.agent_id) agent, c.suspended_at FROM credentials c WHERE c.status='suspended' AND COALESCE(c.suspended_at, c.created_at)<?
      AND c.succession IS NULL AND ${openAlert('c')}
      AND NOT EXISTS (SELECT 1 FROM key_pickups p WHERE p.credential_id=c.id AND p.status='open')
      AND NOT EXISTS (SELECT 1 FROM key_collections k WHERE k.credential_id=c.id AND k.status='open')
      AND NOT EXISTS (SELECT 1 FROM credentials s WHERE s.replaces_credential_id=c.id AND s.status<>'revoked') ORDER BY c.suspended_at`).all(cutoff) as { id: string; label: string; agent: string | null; suspended_at: number }[];
  }

  private auditRows(cutoff: number): { n: number; from: number | null; to: number | null } {
    const r = this.db.prepare("SELECT COUNT(*) n, MIN(created_at) f, MAX(created_at) t FROM audit_events WHERE created_at<? AND action<>'audit.trimmed'").get(cutoff) as { n: number; f: number | null; t: number | null };
    return { n: r.n, from: r.f, to: r.t };
  }

  private def(key: string): RuleDef {
    const d = RULES.find((r) => r.key === key);
    if (!d) throw new HealthError(this.rules().some((r) => r.key === key) ? 'invalid_argument' : 'not_found', `${key} runs on its own each hour; it has no preview.`);
    return d;
  }

  /** What a run would remove now. Nothing changes. */
  preview(key: string, now = Date.now(), days?: number): Preview {
    const def = this.def(key);
    const state = this.rule(key);
    const d = Math.max(def.min, days ?? state.days), cutoff = now - d * DAY;
    if (key === 'audit') {
      const a = this.auditRows(cutoff);
      return { rule: key, days: d, cutoff, total: a.n, tables: a.n ? [{ table: 'audit_events', rows: a.n }] : [], range: { from: a.from, to: a.to }, keeps: def.keeps, refused: null };
    }
    if (key === 'suspended_keys') {
      const c = this.suspendedCandidates(cutoff);
      return { rule: key, days: d, cutoff, total: c.length, tables: c.length ? [{ table: 'credentials (to revoke)', rows: c.length }] : [], range: this.range(c.map((x) => x.suspended_at)), keeps: def.keeps, refused: null,
        items: c.map((x) => ({ id: x.id, label: x.label, agent: x.agent, suspended_at: x.suspended_at })) };
    }
    return tx(this.db, () => {
      const { counts, refused } = this.mark(def, cutoff, now);
      return { rule: key, days: d, cutoff, ...this.summary(counts), keeps: def.keeps, refused };
    });
  }

  private range(times: (number | null)[]): { from: number | null; to: number | null } {
    const t = times.filter((x): x is number => typeof x === 'number');
    return { from: t.length ? Math.min(...t) : null, to: t.length ? Math.max(...t) : null };
  }

  /** Counts per table and the date range of the seed rows that go. */
  private summary(counts: Map<string, number>): { total: number; tables: { table: string; rows: number }[]; range: { from: number | null; to: number | null } } {
    const tables = [...counts].filter(([, n]) => n > 0).map(([table, rows]) => ({ table, rows })).sort((a, b) => b.rows - a.rows);
    const times: number[] = [];
    for (const { table } of tables) {
      const cols = (this.db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((c) => c.name);
      const col = ['created_at', 'filed_at', 'first_at'].find((c) => cols.includes(c));
      if (!col) continue;
      const r = this.db.prepare(`SELECT MIN("${col}") f, MAX("${col}") t FROM "${table}" WHERE rowid IN (SELECT rid FROM "_rs_${table}")`).get() as { f: number | null; t: number | null };
      if (r.f !== null) times.push(r.f); if (r.t !== null) times.push(r.t);
    }
    return { total: tables.reduce((s, t) => s + t.rows, 0), tables, range: this.range(times) };
  }

  private refuseIfLocked(): void {
    const l = this.d.lockdown.list();
    if (l.writes_disabled || l.vaults.length || l.agents.length || l.pcs.length || l.teams.length) throw new HealthError('locked', 'A lockdown is active, so database clean-up is refused until it is lifted.');
  }
  private async exclusive<T>(what: string, fn: () => Promise<T>): Promise<T> {
    if (this.busy) throw new HealthError('conflict', `The database is busy with ${this.busy}. Try again when it has finished.`);
    this.busy = what;
    try { return await fn(); } finally { this.busy = null; }
  }

  /** Back up, then run one rule: counted again in its transaction, removed, checked, audited and recorded. */
  async run(key: string, actor: Actor, opts: { scheduled?: boolean; previewTotal?: number | null; now?: number } = {}): Promise<RunResult> {
    const def = this.def(key);
    if (def.manual && (opts.scheduled || actor.kind === 'system')) throw new HealthError('refused', `${def.label} runs only when an operator runs it.`);
    this.refuseIfLocked();
    return this.exclusive(`the ${def.label} rule`, async () => {
      const started = Date.now(), now = opts.now ?? started;
      const state = this.rule(key);
      const cutoff = now - Math.max(def.min, state.days) * DAY;
      const pre = this.preview(key, now);
      if (pre.refused) { this.record('rule', key, opts.scheduled ? 'scheduled' : 'manual', false, 0, null, { refused: pre.refused }, actor.id, started); throw new HealthError('refused', pre.refused); }
      const backup = pre.total > 0 ? await this.backup(opts.scheduled ? 'daily' : 'always', now) : null;
      let result: RunResult;
      if (key === 'audit') result = await this.trimAudit(pre, cutoff, actor, backup);
      else if (key === 'suspended_keys') {
        const ids = this.suspendedCandidates(cutoff).map((c) => c.id);
        for (const id of ids) this.d.keys.setStatus(id, 'revoked', `suspended over ${state.days} days`, actor);
        result = { ...pre, total: ids.length, tables: ids.length ? [{ table: 'credentials (revoked)', rows: ids.length }] : [], backup, preview_total: opts.previewTotal ?? null, difference: null };
      } else {
        result = tx(this.db, () => {
          const { counts, refused } = this.mark(def, cutoff, now);
          if (refused) throw new HealthError('refused', refused);
          const s = this.summary(counts);
          if (key === 'revoked_keys' && counts.get('credentials')) {
            this.db.prepare(`INSERT OR REPLACE INTO key_tombstones(key_id,kind,verifier,credential_id,agent_id,machine_id,label,status_reason,revoked_at,removed_at)
              SELECT key_id, kind, verifier, id, agent_id, machine_id, label, status_reason, revoked_at, ? FROM credentials WHERE rowid IN (SELECT rid FROM "_rs_credentials")`).run(Date.now());
          }
          this.reset.deleteMarked(counts, `the ${def.label} rule`);
          return { ...pre, ...s, backup, preview_total: opts.previewTotal ?? null, difference: null };
        });
      }
      const base = opts.previewTotal ?? pre.total;
      result.preview_total = base;
      result.difference = result.total - base;
      const byTable = Object.fromEntries(result.tables.map((t) => [t.table, t.rows]));
      this.d.audit.event(actor, 'retention.run', { kind: 'retention_rule', id: key },
        // A list, not an object: the audit redacts any field named like a key or token (session_tokens, key_pickups).
        { rule: key, days: result.days, rows: result.total, tables: result.tables, backup, scheduled: !!opts.scheduled, ...(result.difference ? { difference: result.difference } : {}), ...(result.archive ? { archive: result.archive } : {}) });
      this.record('rule', key, opts.scheduled ? 'scheduled' : 'manual', true, result.total, backup, { days: result.days, by_table: byTable, difference: result.difference, archive: result.archive ?? null }, actor.id, started);
      return result;
    });
  }

  // ───────────── The audit trail ─────────────

  /** Write to a temporary name, flush it to disk, rename it, then read it back and check its sha256. Throws on any failure, leaving no file. */
  protected writeDurable(path: string, bytes: Buffer, sha: string): void {
    const tmp = `${path}.tmp`;
    try {
      const fd = openSync(tmp, 'wx', 0o600);
      try { for (let off = 0; off < bytes.length;) off += writeSync(fd, bytes, off, bytes.length - off); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(tmp, path);
      try { const dfd = openSync(this.d.backupDir, 'r'); try { fsyncSync(dfd); } finally { closeSync(dfd); } } catch { /* a folder cannot be flushed on every system */ }
      if (createHash('sha256').update(readFileSync(path)).digest('hex') !== sha) throw new Error('the archive read back does not match what was written');
    } catch (e) {
      for (const f of [tmp, path]) { try { unlinkSync(f); } catch { /* not there */ } }
      throw new HealthError('refused', `The audit archive could not be written safely, so nothing was removed: ${(e as Error).message}`);
    }
  }

  /** Archive (hash-chained, gzip), record audit.trimmed, move the horizon, then remove: in that order (docs/operations.md). */
  private async trimAudit(pre: Preview, cutoff: number, actor: Actor, backup: string | null): Promise<RunResult> {
    const horizon = (this.db.prepare('SELECT horizon FROM audit_horizon WHERE id=1').get() as { horizon: number }).horizon;
    if (cutoff <= horizon || pre.total === 0) return { ...pre, total: 0, tables: [], backup, preview_total: null, difference: null, archive: null };
    const rows = this.db.prepare("SELECT * FROM audit_events WHERE created_at<? AND action<>'audit.trimmed' ORDER BY id").all(cutoff) as Record<string, unknown>[];
    const last = this.db.prepare("SELECT details FROM audit_events WHERE action='audit.trimmed' ORDER BY id DESC LIMIT 1").get() as { details: string } | undefined;
    let prev = (last ? (JSON.parse(last.details) as { chain_last?: string }).chain_last : null) ?? '0'.repeat(64);
    const first = prev;
    const lines = rows.map((row) => {
      const body = JSON.stringify(row);
      const hash = createHash('sha256').update(prev + body).digest('hex');
      const line = JSON.stringify({ prev, hash, row });
      prev = hash;
      return line;
    });
    const day = (t: number) => new Date(t).toISOString().slice(0, 10);
    const from = rows[0]!.created_at as number, to = rows[rows.length - 1]!.created_at as number;
    const name = `audit-${day(from)}-${day(to)}-${rows[rows.length - 1]!.id}.jsonl.gz`;
    const bytes = gzipSync(Buffer.from(lines.join('\n') + '\n'));
    this.backupFolder();
    const sha = createHash('sha256').update(bytes).digest('hex');
    this.writeDurable(join(this.d.backupDir, name), bytes, sha); // on disk and checked before anything is removed
    return tx(this.db, () => {
      this.d.audit.event(actor, 'audit.trimmed', { kind: 'system', id: 'audit' },
        { from, to, count: rows.length, file: name, sha256: sha, chain_first: first, chain_last: prev, horizon: cutoff, backup });
      this.db.prepare('UPDATE audit_horizon SET horizon=?, updated_at=? WHERE id=1').run(cutoff, Date.now());
      const n = Number(this.db.prepare("DELETE FROM audit_events WHERE created_at<? AND action<>'audit.trimmed'").run(cutoff).changes);
      return { ...pre, total: n, tables: [{ table: 'audit_events', rows: n }], range: { from, to }, backup, preview_total: null, difference: null, archive: name };
    });
  }

  // ───────────── Backups ─────────────

  private backupFolder(): void {
    if (!existsSync(this.d.backupDir)) mkdirSync(this.d.backupDir, { recursive: true, mode: 0o700 });
    try { chmodSync(this.d.backupDir, 0o700); } catch { /* not every filesystem keeps modes */ }
  }

  /** SQLite's online backup to the backups folder. 'daily': reuse today's backup if there is one (scheduled runs). */
  async backup(mode: 'always' | 'daily', now = Date.now()): Promise<string> {
    this.backupFolder();
    const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    if (mode === 'daily') {
      const today = `health-${stamp.slice(0, 8)}-`;
      const have = this.ownBackups().find((b) => b.name.startsWith(today));
      if (have) return have.name;
    }
    let name = `health-${stamp}.db`;
    for (let i = 1; existsSync(join(this.d.backupDir, name)); i++) name = `health-${stamp}-${i}.db`;
    await sqliteBackup(this.db, join(this.d.backupDir, name));
    try { chmodSync(join(this.d.backupDir, name), 0o600); } catch { /* as above */ }
    this.rotate();
    return name;
  }

  private ownBackups(): { name: string; size: number; at: number }[] {
    if (!existsSync(this.d.backupDir)) return [];
    return readdirSync(this.d.backupDir).filter((n) => /^health-\d{8}-\d{6}(-\d+)?\.db$/.test(n))
      .map((name) => ({ name, size: statSync(join(this.d.backupDir, name)).size, at: Date.UTC(+name.slice(7, 11), +name.slice(11, 13) - 1, +name.slice(13, 15), +name.slice(16, 18), +name.slice(18, 20), +name.slice(20, 22)) }))
      .sort((a, b) => b.at - a.at || b.name.localeCompare(a.name));
  }

  /** Keep the newest of each of the last 7 days that have one, and the newest of each of the 4 weeks before those. Only the hub's own (health-…). */
  rotate(): string[] {
    const own = this.ownBackups();
    const keep = new Set<string>();
    const days = new Map<string, string>(), weeks = new Map<number, string>();
    for (const b of own) { const d = b.name.slice(7, 15); if (!days.has(d)) days.set(d, b.name); }
    const daily = [...days.values()].slice(0, 7);
    daily.forEach((n) => keep.add(n));
    const oldestDaily = daily.length ? own.find((b) => b.name === daily[daily.length - 1])!.at : Infinity;
    for (const b of own) {
      if (b.at >= oldestDaily) continue;
      const w = Math.floor((b.at / DAY + 3) / 7); // weeks starting Monday
      if (!weeks.has(w)) weeks.set(w, b.name);
    }
    [...weeks.values()].slice(0, 4).forEach((n) => keep.add(n));
    const gone = own.filter((b) => !keep.has(b.name)).map((b) => b.name);
    for (const n of gone) { try { unlinkSync(join(this.d.backupDir, n)); } catch { /* already gone */ } }
    return gone;
  }

  backups(): { count: number; bytes: number; own: number; newest: { name: string; at: number; size: number } | null; oldest_own: string | null } {
    if (!existsSync(this.d.backupDir)) return { count: 0, bytes: 0, own: 0, newest: null, oldest_own: null };
    const all = readdirSync(this.d.backupDir).filter((n) => n.endsWith('.db')).map((name) => { const s = statSync(join(this.d.backupDir, name)); return { name, at: s.mtimeMs, size: s.size }; })
      .sort((a, b) => b.at - a.at);
    const own = this.ownBackups();
    return { count: all.length, bytes: all.reduce((s, b) => s + b.size, 0), own: own.length, newest: all[0] ?? null, oldest_own: own[own.length - 1]?.name ?? null };
  }

  // ───────────── Checks and compaction ─────────────

  async check(full: boolean, actor: Actor, scheduled = false): Promise<{ ok: boolean; result: string[] }> {
    return this.exclusive(full ? 'a full integrity check' : 'a quick check', async () => {
      const started = Date.now();
      const rows = this.db.prepare(full ? 'PRAGMA integrity_check' : 'PRAGMA quick_check').all() as Record<string, string>[];
      const result = rows.map((r) => String(Object.values(r)[0])).slice(0, 20);
      const ok = result.length === 1 && result[0] === 'ok';
      this.record('check', full ? 'full' : 'quick', scheduled ? 'scheduled' : 'manual', ok, 0, null, { result }, actor.id, started);
      if (!ok) this.d.audit.alert('critical', 'database_check_failed', null, { full, result });
      return { ok, result };
    });
  }

  private fileBytes(): number {
    let n = 0;
    for (const f of [this.d.dbFile, `${this.d.dbFile}-wal`]) { try { n += statSync(f).size; } catch { /* in memory, or no log */ } }
    return n;
  }
  private freeBytes(): number | null {
    try { const s = statfsSync(this.d.backupDir && existsSync(this.d.backupDir) ? this.d.backupDir : '.'); return Number(s.bavail) * Number(s.bsize); } catch { return null; }
  }
  /** Compact needs about the database's size free, plus 10% and 64 MB. Roughly 40 MB a second. */
  compactPlan(): { bytes: number; free: number | null; needed: number; ok: boolean; seconds: number } {
    const bytes = this.fileBytes(), free = this.freeBytes(), needed = Math.ceil(bytes * 1.1) + 64 * 1024 * 1024;
    return { bytes, free, needed, ok: free === null ? false : free >= needed, seconds: Math.max(1, Math.ceil(bytes / (40 * 1024 * 1024))) };
  }
  async compact(actor: Actor): Promise<{ before: number; after: number; saved: number }> {
    this.refuseIfLocked();
    const plan = this.compactPlan();
    if (!plan.ok) throw new HealthError('refused', plan.free === null ? 'Free disk space could not be read, so Compact was refused.' : `Compact needs ${Math.ceil(plan.needed / 1048576)} MB free and only ${Math.floor(plan.free! / 1048576)} MB are, so it was refused.`);
    return this.exclusive('Compact', async () => {
      const started = Date.now(), before = this.fileBytes();
      this.db.exec('VACUUM');
      try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* not in WAL mode */ }
      const after = this.fileBytes(), saved = Math.max(0, before - after);
      this.d.audit.event(actor, 'database.compact', { kind: 'system', id: 'database' }, { before, after, saved });
      this.record('compact', null, 'manual', true, 0, null, { before, after, saved }, actor.id, started);
      return { before, after, saved };
    });
  }

  // ───────────── Counts, health and history ─────────────

  private tables(): string[] {
    return (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_rs\\_%' ESCAPE '\\' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
  }
  private counts(): Map<string, number> {
    const m = new Map<string, number>();
    for (const t of this.tables()) m.set(t, (this.db.prepare(`SELECT COUNT(*) n FROM "${t}"`).get() as { n: number }).n);
    return m;
  }
  /** Today's rows per table, once a day; counts older than 400 days go. */
  snapshot(now = Date.now()): void {
    const day = new Date(now).toISOString().slice(0, 10);
    const counts = this.counts();
    tx(this.db, () => {
      const ins = this.db.prepare('INSERT OR REPLACE INTO db_health_counts(day,table_name,rows) VALUES (?,?,?)');
      for (const [t, n] of counts) ins.run(day, t, n);
      ins.run(day, ':file_bytes', this.fileBytes());
      this.db.prepare('DELETE FROM db_health_counts WHERE day<?').run(new Date(now - 400 * DAY).toISOString().slice(0, 10));
    });
  }

  private areaOf(table: string): string {
    if (table === 'audit_events' || table === 'audit_horizon') return 'audit';
    return RESET_PARTS.find((p) => p.seeds.some((s) => s.table === table))?.key ?? (table.startsWith('kg_') ? 'vault' : 'other');
  }

  health(now = Date.now()): Record<string, unknown> {
    const counts = this.counts();
    const total = [...counts.values()].reduce((s, n) => s + n, 0);
    const labels: Record<string, string> = { audit: 'Audit trail', other: 'Other records', ...Object.fromEntries(RESET_PARTS.map((p) => [p.key, p.label])) };
    const past = (days: number) => {
      const day = (this.db.prepare('SELECT MAX(day) d FROM db_health_counts WHERE day<=?').get(new Date(now - days * DAY).toISOString().slice(0, 10)) as { d: string | null }).d;
      if (!day) return null;
      return new Map((this.db.prepare('SELECT table_name t, rows n FROM db_health_counts WHERE day=?').all(day) as { t: string; n: number }[]).map((r) => [r.t, r.n]));
    };
    const w7 = past(7), w30 = past(30);
    const areas = new Map<string, { key: string; label: string; rows: number; d7: number | null; d30: number | null }>();
    for (const [t, n] of counts) {
      const k = this.areaOf(t);
      const a = areas.get(k) ?? { key: k, label: labels[k] ?? k, rows: 0, d7: w7 ? 0 : null, d30: w30 ? 0 : null };
      a.rows += n;
      if (w7) a.d7! += n - (w7.get(t) ?? 0);
      if (w30) a.d30! += n - (w30.get(t) ?? 0);
      areas.set(k, a);
    }
    const sum = (m: Map<string, number> | null) => (m ? [...m].filter(([t]) => !t.startsWith(':')).reduce((s, [, n]) => s + n, 0) : null);
    const t7 = sum(w7), t30 = sum(w30);
    const lastCheck = this.db.prepare("SELECT rule, ok, details, finished_at FROM db_health_runs WHERE kind='check' ORDER BY id DESC LIMIT 1").get() as { rule: string; ok: number; details: string; finished_at: number } | undefined;
    const growthPct = Number(this.setting<number>('db_health.growth_warn_pct')) || 25;
    const growth7 = t7 ? Math.round(((total - t7) / Math.max(1, t7)) * 100) : null;
    const warnings: string[] = [];
    if (lastCheck && !lastCheck.ok) warnings.push('The last integrity check failed.');
    if (growth7 !== null && growth7 > growthPct) warnings.push(`Records grew ${growth7}% in 7 days, more than ${growthPct}%.`);
    const blobs = (this.db.prepare('SELECT COALESCE(SUM(size),0) b FROM blobs WHERE stored=1').get() as { b: number }).b;
    const horizon = (this.db.prepare('SELECT horizon FROM audit_horizon WHERE id=1').get() as { horizon: number }).horizon;
    return {
      status: warnings.length ? 'warning' : 'healthy', warnings,
      file_bytes: this.fileBytes(), blob_bytes: blobs, records: total,
      growth: { d7: t7 === null ? null : total - t7, d30: t30 === null ? null : total - t30, pct7: growth7 },
      areas: [...areas.values()].sort((a, b) => b.rows - a.rows),
      last_check: lastCheck ? { kind: lastCheck.rule, ok: !!lastCheck.ok, at: lastCheck.finished_at, result: (JSON.parse(lastCheck.details) as { result: string[] }).result } : null,
      backups: this.backups(), compact: this.compactPlan(), audit_horizon: horizon || null, busy: this.busy,
    };
  }

  runs(limit = 50): Record<string, unknown>[] {
    return (this.db.prepare('SELECT * FROM db_health_runs ORDER BY id DESC LIMIT ?').all(limit) as Record<string, unknown>[])
      .map((r) => ({ ...r, ok: !!r.ok, details: r.details ? JSON.parse(String(r.details)) : null }));
  }

  private record(kind: string, rule: string | null, trigger: 'manual' | 'scheduled', ok: boolean, rows: number, backup: string | null, details: unknown, actorId: string | null, started: number): void {
    this.db.prepare('INSERT INTO db_health_runs(kind,rule,trigger,ok,rows,backup,details,actor_id,started_at,finished_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(kind, rule, trigger, ok ? 1 : 0, rows, backup, JSON.stringify(details ?? null), actorId, started, Date.now());
  }

  // ───────────── The nightly step ─────────────

  /** Once a day, from 03:00 UTC: today's counts, the quick check, then each rule that is on (backup first, one a day). */
  async nightly(now = Date.now()): Promise<void> {
    const day = new Date(now).toISOString().slice(0, 10);
    if (new Date(now).getUTCHours() < 3 || this.setting<string>('db_health.nightly_day') === day) return;
    this.put('db_health.nightly_day', day);
    this.snapshot(now);
    await this.check(false, SYSTEM, true);
    for (const r of this.rules().filter((x) => !x.builtin && !x.manual && x.enabled)) {
      try { await this.run(r.key, SYSTEM, { scheduled: true, now }); }
      catch (e) { if (!(e instanceof HealthError)) console.error('db-health rule failed', r.key, e); }
    }
  }
}
