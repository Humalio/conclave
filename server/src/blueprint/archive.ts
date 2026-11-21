/**
 * Archive and unarchive of dropped Blueprint items (docs/blueprint.md §6.1). Archiving reuses the `archived` column the
 * status-report retention uses: the item leaves browse, counts and search, and keeps its key, revisions, links and
 * fields; it still opens by its key and the export lists it, marked. One call is one write: the project version goes
 * up, each item gets one revision, and one event names them as changed, through blueprint.ts's own revision and event helpers.
 */
import type { Db } from '../db/db.js';
import { tx } from '../db/db.js';
import { KeyError } from '../keys/keys.js';
import type { Blueprint, BpActor, ItemRow } from './blueprint.js';
import { RETIRED } from './kinds.js';
import { isRetired } from './browse.js';

export interface ArchivePlan {
  /** The items the call archives (or brings back), the named one first. */
  keys: string[];
  /** Descendants still in play: an archive is refused while there are any. */
  blocking: { key: string; kind: string; title: string; status: string | null }[];
}
export interface ArchiveResult extends ArchivePlan { version: number; done: boolean }

const err = (code: string, msg: string, extra?: Record<string, unknown>) => new KeyError(code, msg, extra);

export class BlueprintArchive {
  constructor(private readonly db: Db, private readonly bp: Blueprint) {}

  /** The live descendants of an item, nearest first (archived ones too, for unarchive). */
  private subtree(projectId: string, key: string, archived: 0 | 1): ItemRow[] {
    return this.db.prepare(`WITH RECURSIVE inside(k, d) AS (SELECT ?, 0 UNION SELECT i.key, inside.d+1 FROM bp_items i JOIN inside ON i.parent_key=inside.k
        WHERE i.project_id=? AND i.deleted_at IS NULL AND i.archived=?)
      SELECT b.* FROM bp_items b JOIN inside ON b.key=inside.k WHERE b.project_id=? AND inside.d>0 ORDER BY inside.d, b.key`).all(key, projectId, archived, projectId) as unknown as ItemRow[];
  }
  private mustItem(projectId: string, key: string): ItemRow {
    const r = this.db.prepare('SELECT * FROM bp_items WHERE project_id=? AND key=? AND deleted_at IS NULL').get(projectId, key) as ItemRow | undefined;
    if (!r) throw err('not_found', `No item ${key} in this project.`);
    return r;
  }

  plan(projectId: string, key: string, to: 'archive' | 'unarchive'): ArchivePlan {
    const r = this.mustItem(projectId, key);
    if (r.kind === 'report') throw err('invalid_state', 'Status reports are archived by the retention rule (the newest ones stay), not one by one.');
    if (to === 'unarchive') {
      if (!r.archived) throw err('invalid_state', `${key} is not archived.`);
      // A child comes back only with its parent: alone it would be live under an archived item.
      const up = r.parent_key ? this.db.prepare('SELECT archived FROM bp_items WHERE project_id=? AND key=? AND deleted_at IS NULL').get(projectId, r.parent_key) as { archived: number } | undefined : undefined;
      if (up?.archived) throw err('invalid_state', `${key} sits under ${r.parent_key}, which is archived. Unarchive ${r.parent_key} first.`, { parent: r.parent_key });
      // Only what this archive took comes back: a child archived on its own before stays archived, with its own subtree.
      // Items archived before archived_with was recorded (NULL) come back with their nearest archived ancestor, as before.
      const kids = this.subtree(projectId, key, 1).filter((c) => c.archived_with === key || c.archived_with == null);
      return { keys: [key, ...kids.map((c) => c.key)], blocking: [] };
    }
    if (r.archived) throw err('invalid_state', `${key} is already archived.`);
    // A settled design (an accepted decision) is archived too, once the operator no longer wants it in the list: the item, its key and its links stay whole.
    if (!isRetired(r.kind, r.status) && !(r.kind === 'decision' && r.status === 'accepted')) throw err('invalid_state', `Only a dropped item can be archived; ${key} is ${r.status ?? 'without a status'}. Drop it first.`);
    if (r.replan_id) throw err('invalid_state', `${key} is held by an open re-plan; finish or cancel it first.`);
    const kids = this.subtree(projectId, key, 0);
    // A descendant blocks while it is still in play: a kind that can be dropped and is not, or one an open re-plan holds.
    // Kinds with no retired status (a finding, a risk, a term) cannot be dropped, so they go with the item.
    const blocking = kids.filter((c) => (RETIRED[c.kind] && !isRetired(c.kind, c.status)) || c.replan_id).map((c) => ({ key: c.key, kind: c.kind, title: c.title, status: c.status }));
    return { keys: [key, ...kids.map((c) => c.key)], blocking };
  }

  /** Archive (or bring back) an item and its subtree; `check` answers the plan and writes nothing. */
  apply(projectId: string, key: string, to: 'archive' | 'unarchive', actor: BpActor, o: { check?: boolean; note?: string | null } = {}, now = Date.now()): ArchiveResult {
    return tx(this.db, () => {
      const p = this.bp.project(projectId);
      if (!p) throw err('not_found', 'No such project.');
      const plan = this.plan(projectId, key, to);
      if (o.check) return { ...plan, version: p.version, done: false };
      if (plan.blocking.length) {
        throw err('invalid_state', `${key} still holds items in play: ${plan.blocking.map((b) => `${b.key} (${b.status ?? b.kind})`).join(', ')}. Drop or move them first.`, { blocking: plan.blocking.map((b) => b.key) });
      }
      const flag = to === 'archive' ? 1 : 0, note = o.note?.trim() || null;
      // archived_with records the key whose archive took the item, so its unarchive brings back exactly that set.
      const upd = this.db.prepare('UPDATE bp_items SET archived=?, archived_with=?, rev=rev+1, updated_by_kind=?, updated_by_id=?, updated_at=? WHERE project_id=? AND key=? AND deleted_at IS NULL');
      for (const k of plan.keys) {
        upd.run(flag, flag ? key : null, actor.kind, actor.id, now, projectId, k);
        // One revision per item, through the write path's own helper (the oldest collapse past the limit there).
        this.bp.revision(this.mustItem(projectId, k).id, actor, now, to === 'archive' ? 'archived' : 'unarchived');
      }
      // Coming back counts like a new item (the items stay dropped, so this refuses only when their limits say so).
      if (to === 'unarchive') this.bp.checkCapacity(projectId, plan.keys);
      // The version bump, changed_version and the event are blueprint.ts's, so a Blueprint write has one way to do them.
      const team = this.mustItem(projectId, key).team_id;
      const version = this.bp.replanEvent(p, team, actor, plan.keys, note ?? `${to === 'archive' ? 'archived' : 'unarchived'} ${key}`);
      return { ...plan, version, done: true };
    });
  }
}
