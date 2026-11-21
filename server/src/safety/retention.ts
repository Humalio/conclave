/** One in-process maintenance scheduler: retention (batched deletes), blob GC, expiry of requests and old counters. */
import type { Db } from '../db/db.js';
import { tx } from '../db/db.js';
import type { VaultStore } from '../vault/store.js';
import type { Access } from '../access/access.js';
import type { Alerts } from './alerts.js';
import type { DbHealth } from './dbHealth.js';

const DAY = 86400_000;
export const BATCH = 5000;
export interface RetentionConfig { sharesDays: number; channelsDays: number; workItemsDays: number; usageDays: number; blobGraceMs: number }
/** Connector usage reports are kept 400 days (a year compared with the last), whatever the PC's opt-in says later. */
export const DEFAULT_RETENTION: RetentionConfig = { sharesDays: 90, channelsDays: 90, workItemsDays: 30, usageDays: 400, blobGraceMs: DAY };
export interface RetentionResult { shares: number; channels: number; workItems: number; usage: number; blobs: number; pruned?: Record<string, number> }

export class Maintenance {
  private timer: NodeJS.Timeout | null = null;
  private lastRetention = 0;
  private running = false;
  /** Database health (docs/operations.md): its nightly step runs from this scheduler. */
  health: DbHealth | null = null;
  constructor(private readonly db: Db, private readonly store: VaultStore, private readonly access: Access, private readonly alerts: Alerts, private readonly cfg: RetentionConfig = DEFAULT_RETENTION) {}

  /** Start the single scheduler. Retention runs at most once an hour. */
  start(everyMs = 60_000): void {
    this.timer = setInterval(() => { void this.tick(); }, everyMs);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async tick(now = Date.now()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      this.access.expirePending(now);
      this.alerts.cleanup(now);
      if (now - this.lastRetention >= 3600_000) { this.lastRetention = now; await this.run(now); }
      await this.health?.nightly(now);
    } catch (e) { console.error('maintenance failed', e); }
    finally { this.running = false; }
  }

  /**
   * Settings raise the defaults, never lower them (docs/operations.md, built-in rules): retention.shares_days,
   * retention.channels_days, retention.work_items_days, retention.usage_days.
   */
  private days(key: string, dflt: number): number {
    const r = this.db.prepare('SELECT value FROM system_settings WHERE key=?').get(key) as { value: string } | undefined;
    const n = r ? Number(JSON.parse(r.value)) : NaN;
    return Number.isFinite(n) && n > dflt ? n : dflt;
  }

  async run(now = Date.now()): Promise<RetentionResult> {
    const out: RetentionResult = { shares: 0, channels: 0, workItems: 0, usage: 0, blobs: 0 };
    out.shares = this.deleteShares(now - this.days('retention.shares_days', this.cfg.sharesDays) * DAY);
    out.channels = this.batched("DELETE FROM data_channels WHERE id IN (SELECT id FROM data_channels WHERE status IN ('done','expired','closed','failed') AND COALESCE(finished_at, created_at)<? LIMIT ?)", now - this.days('retention.channels_days', this.cfg.channelsDays) * DAY);
    out.workItems = this.batched('DELETE FROM work_items WHERE id IN (SELECT id FROM work_items WHERE acked_at IS NOT NULL AND acked_at<? LIMIT ?)', now - this.days('retention.work_items_days', this.cfg.workItemsDays) * DAY);
    // Usage days older than the rule go, by the day they describe. Turning reports off on the PC stops new ones only.
    const usageCutoff = new Date(now - this.days('retention.usage_days', this.cfg.usageDays) * DAY).toISOString().slice(0, 10);
    out.usage = this.batched('DELETE FROM connector_usage WHERE rowid IN (SELECT rowid FROM connector_usage WHERE day<? LIMIT ?)', usageCutoff);
    out.pruned = this.prune(now);
    out.blobs = await this.gcBlobs(now - this.cfg.blobGraceMs);
    return out;
  }

  /**
   * Tables that otherwise only grow. Each rule keeps what later logic still reads:
   * - logins dead (expired or ended) for 30 days, with their read positions and cursor snapshots, except each agent's newest login,
   *   which a new login copies its notice and read positions from;
   * - notices older than 90 days, except each agent's newest (new notices number on from it);
   * - history of tasks finished (done, cancelled or discarded) more than 180 days ago, impact candidates of old revisions, curator results and
   *   finished curator jobs after 30 days, and usage counters after 30 days.
   */
  prune(now = Date.now()): Record<string, number> {
    const days = (n: number) => now - n * DAY;
    const deadTokens = `SELECT t.token_hash FROM session_tokens t JOIN credentials c ON c.id=t.session_credential_id
      WHERE COALESCE(t.revoked_at, t.expires_at) < ? AND t.expires_at < ${now}
      AND t.token_hash <> (SELECT t2.token_hash FROM session_tokens t2 JOIN credentials c2 ON c2.id=t2.session_credential_id WHERE c2.agent_id=c.agent_id ORDER BY t2.created_at DESC LIMIT 1)
      LIMIT ?`;
    const out: Record<string, number> = {};
    out.cursors = this.batched(`DELETE FROM message_delivery_cursors WHERE token_hash IN (${deadTokens})`, days(30));
    out.ack_snapshots = this.batched(`DELETE FROM message_ack_snapshots WHERE token_hash IN (${deadTokens})`, days(30));
    out.logins = this.batched(`DELETE FROM session_tokens WHERE token_hash IN (${deadTokens}) AND NOT EXISTS (SELECT 1 FROM message_delivery_cursors m WHERE m.token_hash=session_tokens.token_hash)
      AND NOT EXISTS (SELECT 1 FROM message_ack_snapshots a WHERE a.token_hash=session_tokens.token_hash)`, days(30));
    out.notices = this.batched(`DELETE FROM agent_notices WHERE id IN (SELECT n.id FROM agent_notices n WHERE n.created_at<?
      AND n.seq < (SELECT MAX(m.seq) FROM agent_notices m WHERE m.agent_id=n.agent_id) LIMIT ?)`, days(90));
    out.task_events = this.batched(`DELETE FROM task_events WHERE id IN (SELECT e.id FROM task_events e JOIN tasks k ON k.id=e.task_id
      WHERE k.status IN ('done','cancelled','discarded') AND k.updated_at<? LIMIT ?)`, days(180));
    out.impact = this.batched(`DELETE FROM kg_impact WHERE rowid IN (SELECT i.rowid FROM kg_impact i WHERE i.created_at<?
      AND NOT EXISTS (SELECT 1 FROM files f WHERE f.id=i.file_id AND f.current_revision=i.revision) LIMIT ?)`, days(90));
    out.job_results = this.batched('DELETE FROM kg_job_results WHERE rowid IN (SELECT rowid FROM kg_job_results WHERE created_at<? LIMIT ?)', days(30));
    out.jobs = this.batched("DELETE FROM kg_jobs WHERE id IN (SELECT j.id FROM kg_jobs j WHERE j.state='done' AND j.updated_at<? AND NOT EXISTS (SELECT 1 FROM kg_job_results r WHERE r.job_id=j.id) LIMIT ?)", days(30));
    // PC orders: finished ones after 30 days; a disconnect only once Re-enrol PC ended it (an open one decides whether the PC is disconnected).
    out.pc_actions = this.batched("DELETE FROM pc_actions WHERE rowid IN (SELECT rowid FROM pc_actions WHERE state IN ('done','failed','expired','removed','needs_attention') AND finished_at<? AND (kind<>'disconnect' OR ended_at IS NOT NULL) LIMIT ?)", days(30));
    out.counters = this.batched('DELETE FROM usage_counters WHERE rowid IN (SELECT rowid FROM usage_counters WHERE window_start<? LIMIT ?)', days(30));
    return out;
  }

  private batched(sql: string, cutoff: number | string): number {
    let total = 0;
    for (;;) {
      const n = Number(this.db.prepare(sql).run(cutoff, BATCH).changes);
      total += n;
      if (n < BATCH) return total;
    }
  }

  /** Closed or revoked shares, with their versions, feedback and recipients. */
  private deleteShares(cutoff: number): number {
    let total = 0;
    for (;;) {
      const ids = (this.db.prepare("SELECT id FROM shares WHERE status IN ('closed','revoked') AND (task_id IS NULL OR status='revoked') AND updated_at<? LIMIT ?").all(cutoff, BATCH) as { id: string }[]).map((r) => r.id);
      if (ids.length === 0) return total;
      tx(this.db, () => this.deleteShareRows(ids));
      total += ids.length;
      if (ids.length < BATCH) return total;
    }
  }
  deleteShareRows(ids: string[]): void {
    const ph = ids.map(() => '?').join(',');
    for (const t of ['share_feedback', 'share_versions', 'share_recipients']) this.db.prepare(`DELETE FROM ${t} WHERE share_id IN (${ph})`).run(...ids);
    this.db.prepare(`DELETE FROM shares WHERE id IN (${ph})`).run(...ids);
  }

  /**
   * Delete blobs nothing refers to any more (older than the grace period, so in-flight uploads are safe).
   * Mark and sweep, one batch per event-loop turn: the references kept in JSON or text (share manifests, conflicts)
   * are read once per batch rather than once per blob, and each batch checks and deletes, rows and files, in one
   * synchronous step, so no write can reuse a blob between the check and the delete.
   */
  async gcBlobs(cutoff: number): Promise<number> {
    let total = 0, after = '';
    for (;;) {
      const b = this.gcBatch(cutoff, after);
      total += b.deleted;
      if (b.last === null) return total;
      after = b.last;
      await new Promise((r) => setImmediate(r));
    }
  }
  private gcBatch(cutoff: number, after: string): { deleted: number; last: string | null } {
    const rows = this.db.prepare(`SELECT b.hash FROM blobs b WHERE b.hash>? AND b.created_at<?
      AND NOT EXISTS (SELECT 1 FROM file_revisions r WHERE r.revision=b.hash)
      AND NOT EXISTS (SELECT 1 FROM file_revisions r WHERE r.parent_revision=b.hash)
      AND NOT EXISTS (SELECT 1 FROM files f WHERE f.current_revision=b.hash)
      AND NOT EXISTS (SELECT 1 FROM write_intents w WHERE w.base_revision=b.hash)
      AND NOT EXISTS (SELECT 1 FROM write_intents w WHERE w.new_revision=b.hash)
      ORDER BY b.hash LIMIT ?`).all(after, cutoff, BATCH) as { hash: string }[];
    if (rows.length === 0) return { deleted: 0, last: null };
    const conflicts = (this.db.prepare("SELECT group_concat(revisions || ' ' || COALESCE(resolution,''), ' ') t FROM file_conflicts").get() as { t: string | null }).t ?? '';
    const shared = new Set((this.db.prepare("SELECT DISTINCT json_extract(j.value,'$.blob_hash') h FROM share_versions v, json_each(v.manifest) j").all() as { h: string | null }[]).map((r) => r.h));
    const gone = rows.map((r) => r.hash).filter((h) => !shared.has(h) && !conflicts.includes(h));
    const del = this.db.prepare('DELETE FROM blobs WHERE hash=?');
    tx(this.db, () => { for (const h of gone) del.run(h); });
    for (const h of gone) this.store.deleteBlobSync(h);
    return { deleted: gone.length, last: rows.length < BATCH ? null : rows[rows.length - 1]!.hash };
  }
}
