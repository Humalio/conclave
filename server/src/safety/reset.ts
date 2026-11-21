/**
 * Operator data reset: wipe the hub's state by part, or all of it.
 *
 * Each part names the rows it owns. Removing them also removes every row that depends on them,
 * following the schema's own foreign keys row by row, so a partial reset never leaves dangling
 * references: resetting PCs removes those PCs' app keys and their logins, not every key.
 * The plan reports exactly what will go, including rows pulled in from other parts.
 *
 * Never touched: permission templates, the audit trail (append-only by design; each reset is recorded in it) and its horizon,
 * the database-health run history (docs/operations.md), admin accounts and sessions, schema migrations, team role defaults, knowledge-graph budgets, other system settings,
 * and the vault files on disk. For a blank hub including the audit trail, stop it and delete its data folder.
 */
import type { Db } from '../db/db.js';
import { tx } from '../db/db.js';

export interface ResetPart { key: string; label: string; detail: string; seeds: { table: string; where?: string }[] }

const ALL = (tables: string[]) => tables.map((table) => ({ table }));
export const RESET_PARTS: ResetPart[] = [
  { key: 'activity', label: 'Activity logs', detail: 'Tool calls, file access log, sign-in events, alerts and rate-limit counters. The audit trail is kept.',
    seeds: ALL(['authentication_events', 'tool_invocations', 'resource_access_events', 'security_alerts', 'usage_counters', 'db_health_counts']) },
  { key: 'conversations', label: 'Conversations', detail: 'Direct and group chats with their messages.',
    seeds: ALL(['rooms', 'room_memberships', 'messages', 'message_delivery_cursors', 'message_ack_snapshots']) },
  { key: 'teams', label: 'Teams and tasks', detail: 'Teams, members, roles, task boards, work queues, decisions, team rooms and project blueprints.',
    seeds: [...ALL(['teams', 'team_members', 'team_roles', 'tasks', 'task_events', 'work_items', 'decisions', 'projects', 'bp_items', 'bp_links', 'bp_revisions', 'bp_events', 'bp_proposals', 'bp_report_requests']), { table: 'rooms', where: "kind='team'" }] },
  { key: 'agents', label: 'Agents, keys and permissions', detail: 'Agents, session and app keys, logins, rules and versions, links, notices, access requests and temporary grants.',
    // Only key policies: their rules and versions follow through foreign keys. Permission templates are configuration and stay.
    seeds: [...ALL(['agents', 'credentials', 'key_tombstones', 'session_tokens', 'agent_links', 'agent_notices', 'access_requests', 'temporary_grants', 'directive_acks', 'directive_reports']), { table: 'permission_policies', where: "kind='credential'" }] },
  { key: 'devices', label: 'PCs and bridges', detail: 'Registered PCs, bridge pairings, setup codes and approved folders, with the app keys issued to them, and the machines offered for compute with their waiting lists, flags and measured use.',
    seeds: ALL(['machines', 'machine_folders', 'bridge_keys', 'setup_keys', 'hw_machines', 'hw_machine_teams', 'hw_queue', 'hw_flags', 'hw_holds', 'hw_samples', 'hw_hold_use', 'hw_use_days']) },
  { key: 'shares', label: 'Shares and transfers', detail: 'Shares with their versions, recipients and feedback, promotions, and file transfer channels.',
    seeds: ALL(['shares', 'share_versions', 'share_recipients', 'share_feedback', 'share_promotions', 'data_channels']) },
  { key: 'vault', label: 'Vault history and index', detail: 'File index, revisions, conflicts, pending writes and the knowledge graph. Notes on disk stay; the hub rescans them on start.',
    seeds: [...ALL(['files', 'file_revisions', 'file_conflicts', 'write_intents']), { table: 'system_settings', where: "key LIKE 'vault.%'" }] },
  { key: 'feedback', label: 'Agent feedback', detail: 'Reports agents filed about the hub, their entries, evidence and history.',
    seeds: ALL(['feedback_reports', 'feedback_entries', 'feedback_links', 'feedback_calls', 'feedback_history', 'feedback_requests', 'feedback_hints', 'feedback_task_links']) },
  { key: 'lockdown', label: 'Lockdown switches', detail: 'Every active lockdown: paused writes, frozen vault, locked agents, PCs and teams.',
    seeds: [{ table: 'system_settings', where: "key LIKE 'emergency.%'" }] },
];
export const KEEP = new Set(['audit_events', 'audit_horizon', 'db_health_runs', 'admin_users', 'admin_sessions', 'schema_migrations', 'team_role_defaults', 'kg_budgets']);

export interface ResetPlan {
  parts: string[];
  /** Parts not selected that still lose rows because those rows depend on what is being removed. */
  implied: string[];
  byPart: { key: string; label: string; rows: number; selected: boolean }[];
  tables: Record<string, number>;
  /** The same counts with the part each table is charged to, so a preview can show what a part's number is made of. */
  byTable: { table: string; part: string; rows: number }[];
  total: number;
}

export type Fk = { child: string; from: string[]; to: string[] };

export class Reset {
  private kgTables: string[];
  private children = new Map<string, Fk[]>();

  constructor(private db: Db) {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name);
    this.kgTables = tables.filter((t) => t.startsWith('kg_') && !KEEP.has(t));
    for (const child of tables) {
      const rows = db.prepare(`PRAGMA foreign_key_list("${child}")`).all() as { id: number; table: string; from: string; to: string | null }[];
      const byId = new Map<number, { table: string; from: string[]; to: (string | null)[] }>();
      for (const r of rows) { const f = byId.get(r.id) ?? { table: r.table, from: [], to: [] }; f.from.push(r.from); f.to.push(r.to); byId.set(r.id, f); }
      for (const f of byId.values()) {
        const to = f.to.every((c) => c) ? (f.to as string[]) : this.pk(f.table);
        const list = this.children.get(f.table) ?? [];
        list.push({ child, from: f.from, to });
        this.children.set(f.table, list);
      }
    }
  }

  private pk(table: string): string[] {
    return (this.db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string; pk: number }[]).filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
  }

  private seedsOf(part: ResetPart): { table: string; where?: string }[] {
    return part.key === 'vault' ? [...part.seeds, ...ALL(this.kgTables)] : part.seeds;
  }

  static normalize(parts: string[]): string[] {
    const keys = parts.includes('all') ? RESET_PARTS.map((p) => p.key) : parts;
    const bad = keys.filter((k) => !RESET_PARTS.some((p) => p.key === k));
    if (bad.length) throw new Error(`unknown reset part: ${bad.join(', ')}`);
    if (!keys.length) throw new Error('choose at least one part to reset');
    return RESET_PARTS.map((p) => p.key).filter((k) => keys.includes(k));
  }

  /** The foreign keys that point at a table: each child table with its columns (database-health rules guard on them). */
  childrenOf(table: string): Fk[] { return this.children.get(table) ?? []; }

  private mark(parts: string[]): Map<string, number> {
    return this.walk(RESET_PARTS.filter((p) => parts.includes(p.key)).flatMap((p) => this.seedsOf(p)));
  }

  /**
   * Mark the seed rows in temp tables, then follow foreign keys from removed rows to their dependants. Read inside a
   * transaction; `deleteMarked` then removes exactly what was counted. Also used by the database-health rules.
   */
  walk(seeds: { table: string; where?: string }[]): Map<string, number> {
    const marked = new Set<string>();
    const ensure = (t: string) => { if (!marked.has(t)) { this.db.exec(`CREATE TEMP TABLE IF NOT EXISTS "_rs_${t}"(rid INTEGER PRIMARY KEY); DELETE FROM "_rs_${t}";`); marked.add(t); } };
    for (const s of seeds) { ensure(s.table); this.db.exec(`INSERT OR IGNORE INTO "_rs_${s.table}" SELECT rowid FROM "${s.table}"${s.where ? ` WHERE ${s.where}` : ''}`); }
    for (let grew = true; grew;) {
      grew = false;
      for (const parent of [...marked]) {
        for (const fk of this.children.get(parent) ?? []) {
          if (KEEP.has(fk.child)) continue;
          ensure(fk.child);
          const cols = (c: string[]) => (c.length === 1 ? `"${c[0]}"` : `(${c.map((x) => `"${x}"`).join(',')})`);
          const changes = Number(this.db.prepare(`INSERT OR IGNORE INTO "_rs_${fk.child}" SELECT rowid FROM "${fk.child}" WHERE ${cols(fk.from)} IN (SELECT ${fk.to.map((x) => `"${x}"`).join(',')} FROM "${parent}" WHERE rowid IN (SELECT rid FROM "_rs_${parent}"))`).run().changes);
          if (changes > 0) grew = true;
        }
      }
    }
    const counts = new Map<string, number>();
    for (const t of marked) counts.set(t, (this.db.prepare(`SELECT COUNT(*) n FROM "_rs_${t}"`).get() as { n: number }).n);
    return counts;
  }

  private ownerOf(table: string): string | null {
    return RESET_PARTS.find((part) => this.seedsOf(part).some((s) => s.table === table))?.key ?? null;
  }

  private summarize(parts: string[], counts: Map<string, number>): ResetPlan {
    const byPart = new Map<string, number>();
    const tables: Record<string, number> = {};
    const byTable: ResetPlan['byTable'] = [];
    let total = 0;
    for (const [t, n] of counts) {
      if (!n) continue;
      tables[t] = n; total += n;
      // A table seeded by a selected part counts there; otherwise it is charged to the part that owns it.
      const owner = RESET_PARTS.find((p) => parts.includes(p.key) && this.seedsOf(p).some((s) => s.table === t))?.key ?? this.ownerOf(t) ?? 'other';
      byPart.set(owner, (byPart.get(owner) ?? 0) + n);
      byTable.push({ table: t, part: owner, rows: n });
    }
    byTable.sort((a, b) => b.rows - a.rows);
    return {
      parts,
      implied: [...byPart.keys()].filter((k) => !parts.includes(k)),
      byPart: [...RESET_PARTS.map((p) => ({ key: p.key, label: p.label, rows: byPart.get(p.key) ?? 0, selected: parts.includes(p.key) })),
        ...(byPart.has('other') ? [{ key: 'other', label: 'Other linked records', rows: byPart.get('other')!, selected: false }] : [])],
      tables, byTable, total,
    };
  }

  /** Delete the rows a walk marked; foreign keys are checked at the end, so the caller's transaction rolls back on a dangling one. */
  deleteMarked(counts: Map<string, number>, what: string): void {
    this.db.exec('PRAGMA defer_foreign_keys=ON');
    for (const [t, n] of counts) if (n) this.db.exec(`DELETE FROM "${t}" WHERE rowid IN (SELECT rid FROM "_rs_${t}")`);
    const broken = this.db.prepare('PRAGMA foreign_key_check').all();
    if (broken.length) throw new Error(`${what} would leave ${broken.length} dangling references; nothing was changed`);
  }

  /** What a reset of these parts would remove. Nothing changes. */
  plan(requested: string[]): ResetPlan {
    const parts = Reset.normalize(requested);
    return tx(this.db, () => this.summarize(parts, this.mark(parts)));
  }

  /** Remove the rows in one transaction; foreign keys are checked at commit. */
  run(requested: string[]): ResetPlan {
    const parts = Reset.normalize(requested);
    return tx(this.db, () => {
      this.db.exec('PRAGMA defer_foreign_keys=ON');
      const counts = this.mark(parts);
      this.deleteMarked(counts, 'reset');
      return this.summarize(parts, counts);
    });
  }
}
