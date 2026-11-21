/**
 * Task attachments (docs/specification.md, Tasks "Attachments"; task-attachments design §2-§4, §7, §8): a task's brief and
 * submission files live in hub-made shares bound to the task (shares.task_id, shares.task_role). Only the hub creates one,
 * the first time a task gets files of that role; agents never create, rebind or close one. Each change is a new version.
 *
 * Who opens the files is one rule, checked on every read: the operator, and the agents of the task's team who may read
 * that task (its creator, assignee and reviewer, and the team's coordinators). A share given at submission, or named by
 * attachments_from, is copied (content-addressed blobs, nothing duplicated on disk), never rebound, and only from a share
 * the caller authored, so a share someone else sent the caller never becomes readable by the whole task team.
 */
import type { Db } from '../db/db.js';
import { tx } from '../db/db.js';
import type { Audit, Actor } from '../audit/audit.js';
import { KeyError } from '../keys/keys.js';
import type { Lockdown } from '../safety/lockdown.js';
import type { Teams, TaskRow, TeamRow } from '../teams/teams.js';
import type { VaultStore } from '../vault/store.js';
import { isText } from '../vault/vault.js';
import { safeRel } from '../util/frames.js';
import { newId } from '../util/ids.js';
import type { Entry, ShareRow, Shares } from './shares.js';

export type AttachRole = 'brief' | 'submission';
export const MB = 1024 * 1024;
export const ATTACH_LIMITS = {
  /** One file. */
  file: 8 * MB,
  /** An HTML mockup. */
  html: 2 * MB,
  /** Files in one set version. */
  files: 40,
  /** One set version. */
  version: 50 * MB,
  /** One task, both sets, every version. */
  task: 200 * MB,
  /** One team, all its tasks' attachments, each blob counted once (raised per team as limits.attachment_bytes). */
  team: 5 * 1024 * MB,
} as const;
/** Inline attachments per call, as share_upload. */
export const ATTACH_INLINE_MAX = MB;
/** The team total's Needs-you row shows from this share of the limit. */
export const TEAM_WARN_AT = 0.8;
/** A cancelled or discarded task's attachments are deleted this long after the task closes (the operator, 19 Nov). */
export const ATTACH_DELETE_AFTER_MS = 30 * 24 * 3600_000;
const TERMINAL = ['done', 'cancelled', 'discarded'];
const CLOSED = ['cancelled', 'discarded'];
/** Names an attachment may not have: environment files and key material (the share filters skip these on a bridge upload). */
const REFUSED_NAME = /(^|\/)(\.env(\..*)?|keys\.env|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|[^/]*\.(pem|key|p12|pfx))$/i;

/** An attachment's entry: a share entry plus the type sniffed from its bytes (never from the name). */
export type AttachEntry = Entry & { type: string };
export interface AttachFile { path: string; content: string; encoding?: 'utf8' | 'base64' }
/** Files ready to commit: blobs stored, the quota charged (refund undoes it), the copy's source if any, and the upload's channel. */
export interface Staged { entries: AttachEntry[]; copiedFrom: string | null; bytes: number; refund: () => void; channel?: string }
/** A task upload from the PC as its channel recorded it (channels.ts, TaskAttachHook). */
export interface TaskUpload { id?: string; target: string; from_agent_id: string; from_credential_id: string; from_machine_id: string | null }
/** Who attaches: an agent of the task's team, or the operator (who acts through the console). */
export interface Attacher { agentId: string | null; credId: string | null; machineId?: string | null; actor: Actor }
export interface SetView {
  role: AttachRole; share_id: string; status: string; version: number; files: { path: string; size: number; type: string }[]; total_bytes: number;
  added_by: string | null; added_by_label: string | null; copied_from: string | null; created_at: number; removed: boolean;
}

/** One version of a set as the operator's console shows it. */
export interface AttachVersion {
  version: number; created_at: number; added_by_label: string | null; total_bytes: number; files: { path: string; size: number; type: string }[];
  copied_from: { name: string; version: number } | null; removed_at: number | null;
}

/** The type sniffed from the bytes: the four inline image types, HTML, other text, or binary. */
export function sniff(b: Buffer): string {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && (b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a')) return 'image/gif';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (isText(b)) {
    const head = b.subarray(0, 1024).toString('utf8').replace(/^﻿/, '').trimStart().toLowerCase();
    if (head.startsWith('<!doctype html') || head.startsWith('<html')) return 'text/html';
    return 'text/plain';
  }
  return 'application/octet-stream';
}
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

const err = (c: string, m: string) => new KeyError(c, m);

/** One file a task upload delivered, as the hub stored it. */
export interface ReceivedFile { name: string; size: number; sha256: string }
/** One task upload from the PC as task_list shows it (TaskAttachments.uploads). */
export interface UploadView {
  role: AttachRole; state: 'uploading' | 'received' | 'failed'; started_at: number; finished_at: number | null;
  files: { name: string; size?: number; sha256?: string }[]; reason?: string;
}
/** A failed upload's reason: the hub's fixed words for the channel's code, never the message (which may quote a path). */
const UPLOAD_REASONS: Record<string, string> = {
  too_large: 'A file or the set was over the size limit.',
  invalid_argument: 'A file name or type was refused.',
  denied: 'The task ended or changed hands, or you may no longer change these files.',
  invalid_state: 'The task ended or changed hands, or you may no longer change these files.',
  conflict: 'The task ended or changed hands, or you may no longer change these files.',
  lockdown: 'A lockdown stopped it.',
  paused: 'The team is paused.',
  idle: 'The upload stopped before it finished and timed out.',
  expired: 'The upload stopped before it finished and timed out.',
  closed_by_sender: 'The upload was closed before it finished.',
  closed_by_peer: 'The upload was closed before it finished.',
  closed: 'The upload was closed before it finished.',
  restart: 'The hub restarted during the upload.',
  hash_mismatch: 'The bytes that arrived did not match what the PC sent.',
  size_mismatch: 'The bytes that arrived did not match what the PC sent.',
  leak_guard: 'The leak guard refused a file.',
  bridge_error: 'The PC could not read or send a file.',
};
export function uploadReason(code: string | null): string {
  const k = (code ?? '').split(':')[0]!.trim();
  return UPLOAD_REASONS[k] ?? 'The upload did not finish.';
}
/** The names an upload sent: the last part of each path the call gave (never the PC path itself). */
function sentNames(fromLocalPath: string | null): string[] {
  if (!fromLocalPath) return [];
  let paths: unknown;
  try { paths = JSON.parse(fromLocalPath); } catch { paths = [fromLocalPath]; }
  return (Array.isArray(paths) ? paths : [paths]).map((p) => String(p).split(/[\\/]/).filter(Boolean).pop() ?? '').filter(Boolean);
}

export class TaskAttachments {
  /** Set in app.ts: a lockdown refuses new attachments, as it refuses a share upload. */
  lockdown: Lockdown | null = null;
  constructor(private readonly db: Db, private readonly shares: Shares, private readonly teams: Teams, private readonly audit: Audit, private readonly store: VaultStore) {
    shares.taskReader = (sh, agentId) => this.canRead(sh, agentId);
    shares.taskTitle = (taskId) => this.teams.task(taskId)?.title ?? taskId;
  }

  /** Run a task change and its attachments as one: both apply or neither does. */
  inTx<T>(fn: () => T): T { return tx(this.db, fn); }
  /** An attachments-only change is an edit of the task: its version goes up, so a stale task_update is refused. */
  touchTask(taskId: string, version: number): void {
    const r = this.db.prepare('UPDATE tasks SET version=version+1, updated_at=? WHERE id=? AND version=?').run(Date.now(), taskId, version);
    if (!Number(r.changes)) throw err('conflict', `The task changed (current version ${this.teams.task(taskId)?.version ?? '?'}). Re-read it with task_list.`);
  }

  setOf(taskId: string, role: AttachRole): ShareRow | null {
    return (this.db.prepare('SELECT * FROM shares WHERE task_id=? AND task_role=?').get(taskId, role) as unknown as ShareRow) ?? null;
  }

  /**
   * May this agent read the task's attachments? The agents of the task's team who may read that task: its creator,
   * assignee and reviewer, and the team's coordinators, while they are members. Checked again on every request, so an
   * agent the task was taken from is refused at once. A cancelled or discarded task's sets are closed: only the operator
   * opens them (the admin routes, not this rule).
   */
  mayRead(t: TaskRow, agentId: string): boolean {
    if (!t.team_id || CLOSED.includes(t.status)) return false;
    const role = this.teams.roleOf(t.team_id, agentId);
    if (!role) return false;
    if (role === 'coordinator' || t.created_by_agent === agentId) return true;
    // The assignee and the reviewer read while the task is live: once it is done their access ends (specification, "Task read access").
    return t.status !== 'done' && (t.assignee_agent_id === agentId || t.reviewer_agent_id === agentId);
  }
  /** The task rule for a task-bound share (Shares.canAccess delegates here): an open set and a reader of its task. */
  canRead(sh: ShareRow, agentId: string): boolean {
    if (!sh.task_id || sh.status !== 'open') return false;
    const t = this.teams.task(sh.task_id);
    return !!t && this.mayRead(t, agentId);
  }

  /**
   * One file of a set, for the console's byte route: the set must exist and not be removed by the operator, the version
   * (the latest published one unless `v` names one) must be published, and the path must be in its manifest. Anything
   * else is null, so the route answers one `not_found` for all of them.
   */
  entry(taskId: string, role: AttachRole, path: string, v?: string): { entry: AttachEntry; version: number } | null {
    const sh = this.setOf(taskId, role);
    if (!sh || sh.status === 'revoked') return null;
    const p = safeRel(path);
    if (!p) return null;
    let version = this.shares.latest(sh.id);
    if (v !== undefined && v !== '') { if (!/^[1-9]\d{0,8}$/.test(v)) return null; version = Number(v); }
    const row = version ? this.shares.version(sh.id, version) : null;
    if (!row || row.status !== 'published') return null;
    const entry = (this.shares.manifestOf(row) as AttachEntry[]).find((e) => e.path === p);
    return entry && entry.stored !== false ? { entry, version } : null;
  }

  /** The latest version of each set, for task_list and the console (the operator sees a removed set as removed). */
  sets(taskId: string): SetView[] {
    const out: SetView[] = [];
    for (const role of ['brief', 'submission'] as AttachRole[]) {
      const sh = this.setOf(taskId, role);
      if (!sh) continue;
      const v = this.db.prepare("SELECT * FROM share_versions WHERE share_id=? AND status='published' ORDER BY version DESC LIMIT 1").get(sh.id) as { version: number; manifest: string; total_bytes: number; added_by: string | null; copied_from: string | null; created_at: number } | undefined;
      if (!v) continue;
      const m = JSON.parse(v.manifest) as AttachEntry[];
      out.push({ role, share_id: sh.id, status: sh.status, version: v.version, files: m.map((e) => ({ path: e.path, size: e.size, type: e.type ?? 'application/octet-stream' })), total_bytes: v.total_bytes,
        added_by: v.added_by, added_by_label: this.label(v.added_by), copied_from: v.copied_from, created_at: v.created_at, removed: sh.status === 'revoked' });
    }
    return out;
  }
  /**
   * The operator's task screen (docs/dashboard-ux.md, task screen "Attachments"): the brief's latest version, and every
   * submission version as a review round, newest last. A copy names its source share; a removed set has no files and
   * says when it was removed. Agents never get this (they read the sets through the share tools).
   */
  consoleView(taskId: string): { brief: AttachVersion | null; rounds: AttachVersion[] } {
    type V = { version: number; manifest: string; total_bytes: number; added_by: string | null; copied_from: string | null; created_at: number };
    const one = (sh: ShareRow, v: V): AttachVersion => {
      const removed = sh.status === 'revoked';
      const m = removed ? [] : (JSON.parse(v.manifest) as AttachEntry[]);
      const src = v.copied_from ? /^share:(shr_[A-Za-z0-9]+)@v(\d+)$/.exec(v.copied_from) : null;
      return { version: v.version, created_at: v.created_at, added_by_label: this.label(v.added_by), total_bytes: removed ? 0 : v.total_bytes,
        files: m.map((e) => ({ path: e.path, size: e.size, type: e.type ?? 'application/octet-stream' })),
        copied_from: src ? { name: this.shares.share(src[1]!)?.name ?? src[1]!, version: Number(src[2]) } : null,
        removed_at: removed ? sh.updated_at : null };
    };
    const versions = (sh: ShareRow) => this.db.prepare("SELECT version, manifest, total_bytes, added_by, copied_from, created_at FROM share_versions WHERE share_id=? AND status='published' ORDER BY version").all(sh.id) as V[];
    const b = this.setOf(taskId, 'brief'), s = this.setOf(taskId, 'submission');
    const bv = b ? versions(b).at(-1) : undefined;
    return { brief: b && bv ? one(b, bv) : null, rounds: s ? versions(s).map((v) => one(s, v)) : [] };
  }
  /** Files in the latest version of each set: what a project member's board shows (a count, never a file). */
  count(taskId: string): number { return this.sets(taskId).filter((s) => !s.removed).reduce((n, s) => n + s.files.length, 0); }
  /** Counts for many tasks at once (the board). */
  counts(taskIds: string[]): Map<string, number> {
    const out = new Map<string, number>();
    for (const id of taskIds) { const n = this.count(id); if (n) out.set(id, n); }
    return out;
  }

  /** A team's attachment bytes: every blob of every version of its tasks' sets, each counted once. */
  teamBytes(teamId: string): number {
    const r = this.db.prepare(`SELECT COALESCE(SUM(size),0) n FROM (SELECT DISTINCT json_extract(j.value,'$.blob_hash') h, json_extract(j.value,'$.size') size
      FROM shares s JOIN tasks k ON k.id=s.task_id JOIN share_versions v ON v.share_id=s.id, json_each(v.manifest) j WHERE k.team_id=?)`).get(teamId) as { n: number };
    return Number(r.n);
  }
  teamLimit(team: TeamRow): number { return this.teams.limits(team).attachment_bytes ?? ATTACH_LIMITS.team; }
  /** Teams whose attachments use at least TEAM_WARN_AT of their limit (the Needs-you row). */
  nearFull(): { team: TeamRow; used: number; limit: number }[] {
    const ids = (this.db.prepare('SELECT DISTINCT k.team_id id FROM shares s JOIN tasks k ON k.id=s.task_id WHERE k.team_id IS NOT NULL').all() as { id: string }[]).map((r) => r.id);
    const out: { team: TeamRow; used: number; limit: number }[] = [];
    for (const id of ids) {
      const team = this.teams.team(id);
      if (!team) continue;
      const used = this.teamBytes(id), limit = this.teamLimit(team);
      if (used >= limit * TEAM_WARN_AT) out.push({ team, used, limit });
    }
    return out;
  }
  private taskBytes(taskId: string): number {
    return Number((this.db.prepare('SELECT COALESCE(SUM(v.total_bytes),0) n FROM shares s JOIN share_versions v ON v.share_id=s.id WHERE s.task_id=?').get(taskId) as { n: number }).n);
  }

  /**
   * Store the files' blobs and resolve a copy, before anything is committed. Inline files are at most ATTACH_INLINE_MAX
   * per call and charged to the key's share upload quota (refund undoes it). `from` names a share version the caller
   * authored (share:<id>@v<n>, or an id for its latest version): a share someone else sent the caller is refused.
   */
  async stage(w: Attacher, files: AttachFile[] | undefined, from: string | undefined): Promise<Staged | null> {
    if (!files?.length && !from) return null;
    const byPath = new Map<string, AttachEntry>();
    let copiedFrom: string | null = null;
    if (from) {
      const src = this.copySource(w, from);
      copiedFrom = `share:${src.share.id}@v${src.version}`;
      for (const e of src.entries) byPath.set(e.path, { ...e, type: e.type ?? (await this.typeOf(e)) });
    }
    let bytes = 0;
    const decoded = (files ?? []).map((f) => {
      const b = Buffer.from(f.content, f.encoding === 'base64' ? 'base64' : 'utf8');
      bytes += b.length;
      return { path: f.path, bytes: b };
    });
    if (bytes > ATTACH_INLINE_MAX) throw err('too_large', `Inline attachments are at most ${ATTACH_INLINE_MAX} bytes per call. Upload larger files to a share of your own with share_upload (local_paths uses your PC's bridge), then copy it with attachments_from.`);
    for (const f of decoded) this.checkName(f.path);
    const refund = bytes && w.credId ? this.shares.charge(w.credId, bytes) : () => {};
    try {
      for (const f of decoded) {
        const p = safeRel(f.path)!;
        const type = sniff(f.bytes);
        this.checkSize(p, f.bytes.length, type);
        const r = await this.store.putBlob(f.bytes, ATTACH_LIMITS.file);
        byPath.set(p, { path: p, blob_hash: r.hash, size: f.bytes.length, is_text: isText(f.bytes), stored: r.stored, type });
      }
    } catch (e) { refund(); throw e; }
    return { entries: [...byPath.values()], copiedFrom, bytes, refund };
  }
  private checkName(path: string): void {
    const p = safeRel(path);
    if (!p) throw err('invalid_argument', `bad attachment path "${path}": use relative paths with "/" and no ".."`);
    if (REFUSED_NAME.test(p)) throw err('invalid_argument', `"${p}" looks like an environment or key file and is not attached. Attach screenshots, mockups and other work files only.`);
  }
  private checkSize(path: string, size: number, type: string): void {
    if (type === 'text/html' && size > ATTACH_LIMITS.html) throw err('too_large', `"${path}" is an HTML mockup of ${size} bytes; a mockup is at most ${ATTACH_LIMITS.html} bytes.`);
    if (size > ATTACH_LIMITS.file) throw err('too_large', `"${path}" is ${size} bytes; one attachment is at most ${ATTACH_LIMITS.file} bytes.`);
  }
  private async typeOf(e: Entry): Promise<string> {
    const b = e.stored ? await this.store.getBlob(e.blob_hash) : null;
    return b ? sniff(b) : 'application/octet-stream';
  }
  /** A share version the caller may copy into a task: one they authored, open, published, and not itself task-bound. */
  private copySource(w: Attacher, ref: string): { share: ShareRow; version: number; entries: AttachEntry[] } {
    const m = /^(?:share:)?(shr_[A-Za-z0-9]+)(?:@v(\d+))?$/.exec(ref.trim());
    if (!m) throw err('invalid_argument', 'attachments_from is a share reference: share:<id>@v<n> (or share:<id> for its latest version).');
    const sh = this.shares.share(m[1]!);
    // Only a share the caller authored (Specification Reviewer): otherwise a share another team sent the caller would
    // become readable by the whole task team. Unknown, closed and someone else's shares all read the same.
    if (!sh || sh.task_id || !w.agentId || sh.author_agent_id !== w.agentId || sh.status !== 'open') {
      throw err('invalid_argument', `Share ${m[1]} is not one you can copy into a task: only a share you made yourself, still open, can be copied. Attach the files inline, or upload them to a share of your own first.`);
    }
    const version = m[2] ? Number(m[2]) : this.shares.latest(sh.id);
    const v = version ? this.shares.version(sh.id, version) : null;
    if (!v || v.status !== 'published') throw err('invalid_argument', `Share ${sh.id} has no published version ${m[2] ?? ''}`.trim() + '.');
    return { share: sh, version, entries: this.shares.manifestOf(v) as AttachEntry[] };
  }

  /**
   * Who may change a set: the brief, the task's creator or a coordinator of its team, while the task has not ended; the
   * submission, its assignee. The operator may change the brief (the console's Attach).
   */
  private mayChange(t: TaskRow, role: AttachRole, w: Attacher): void {
    if (TERMINAL.includes(t.status) || t.status === 'discarded') throw err('invalid_state', `Task ${t.id} is ${t.status}: its attachments can no longer change.`);
    if (!w.agentId) {
      if (role === 'brief' && w.actor.kind === 'admin') return;
      throw err('denied', 'Only an agent of the task\'s team attaches a submission.');
    }
    const role_ = t.team_id ? this.teams.roleOf(t.team_id, w.agentId) : null;
    const ok = role === 'brief' ? !!role_ && (role_ === 'coordinator' || t.created_by_agent === w.agentId) : t.assignee_agent_id === w.agentId && !!role_;
    if (!ok) throw err('denied', role === 'brief' ? 'Only the task\'s creator or a coordinator of its team changes the brief\'s attachments.' : 'Only the task\'s assignee attaches files to its submission.');
  }

  /**
   * Write the next version of a task's set (synchronous, so it runs in the caller's transaction): the brief merges onto
   * its previous version (a path given again replaces that file), a submission is its own round. Checks who may change it,
   * the lockdown and pause, and the limits; creates the set the first time; audits task.attach (names and sizes, never
   * contents). Throws and commits nothing when a check fails.
   */
  commit(t: TaskRow, role: AttachRole, staged: Staged, w: Attacher): { share_id: string; version: number } {
    this.mayChange(t, role, w);
    if (w.agentId) {
      const locked = this.lockdown?.blocks('share_upload', w.agentId, w.machineId ?? null) ?? null;
      if (locked) throw err('lockdown', locked);
      this.teams.guardWrite(w.agentId);
    } else if (this.lockdown?.writes()) throw err('lockdown', 'The hub is in lockdown: new attachments are refused until it ends.');
    return tx(this.db, () => {
      let sh = this.setOf(t.id, role);
      if (sh && sh.status !== 'open') throw err('invalid_state', sh.status === 'revoked' ? 'The administrator removed this task\'s attachments; they cannot be added to.' : 'This task\'s attachments are closed.');
      const map = new Map<string, AttachEntry>();
      if (sh && role === 'brief') {
        const prev = this.shares.latest(sh.id);
        if (prev) for (const e of this.shares.manifestOf(this.shares.version(sh.id, prev)!) as AttachEntry[]) map.set(e.path, e);
      }
      for (const e of staged.entries) map.set(e.path, e);
      const list = [...map.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
      const total = list.reduce((n, e) => n + e.size, 0);
      if (list.length > ATTACH_LIMITS.files) throw err('too_large', `A set of attachments holds at most ${ATTACH_LIMITS.files} files (this one would have ${list.length}).`);
      if (total > ATTACH_LIMITS.version) throw err('too_large', `One set of attachments is at most ${ATTACH_LIMITS.version} bytes (this one would be ${total}).`);
      if (this.taskBytes(t.id) + total > ATTACH_LIMITS.task) throw err('too_large', `A task's attachments, all versions, are at most ${ATTACH_LIMITS.task} bytes.`);
      if (t.team_id) {
        const team = this.teams.team(t.team_id)!;
        const known = new Set((this.db.prepare(`SELECT DISTINCT json_extract(j.value,'$.blob_hash') h FROM shares s JOIN tasks k ON k.id=s.task_id JOIN share_versions v ON v.share_id=s.id, json_each(v.manifest) j WHERE k.team_id=?`).all(t.team_id) as { h: string }[]).map((r) => r.h));
        const added = [...new Map(list.filter((e) => !known.has(e.blob_hash)).map((e) => [e.blob_hash, e.size])).values()].reduce((n, s) => n + s, 0);
        const used = this.teamBytes(t.team_id), limit = this.teamLimit(team);
        if (added > 0 && used + added > limit) {
          // The refusal rolls the transaction back, so the alert is raised just after it, outside the transaction.
          const details = { team: team.name, metric: 'attachment_bytes', limit, count: used + added };
          queueMicrotask(() => { try { this.audit.alert('warning', 'quota_trip', team.id, details); } catch { /* the refusal stands */ } });
          throw err('too_large', `This team's attachments are full (${used} of ${limit} bytes). Remove old ones, or ask the operator to raise the limit.`);
        }
      }
      const now = Date.now();
      if (!sh) {
        // Hub-made: the author is the task's creator (or the first attacher); the readers are the task's, never a recipient list.
        const author = t.created_by_agent ?? w.agentId ?? t.assignee_agent_id;
        if (!author) throw err('invalid_state', 'This task has no agent to hold its attachments yet; assign it first.');
        const id = newId.share();
        this.db.prepare("INSERT INTO shares(id,author_agent_id,author_credential_id,name,description,created_at,updated_at,task_id,task_role) VALUES (?,?,'hub',?,?,?,?,?,?)")
          .run(id, author, `${role === 'brief' ? 'Brief' : 'Submission'}: ${t.title}`.slice(0, 200), `Attachments of task ${t.id} (${role}).`, now, now, t.id, role);
        sh = this.shares.share(id)!;
      }
      const v = this.shares.latest(sh.id) + 1;
      const by = w.agentId ?? (w.actor.id ? `admin:${w.actor.id}` : 'admin');
      this.db.prepare("INSERT INTO share_versions(share_id,version,note,manifest,total_bytes,upload_kind,status,created_at,added_by,copied_from) VALUES (?,?,?,?,?,'inline','published',?,?,?)")
        .run(sh.id, v, role === 'submission' ? `Round ${v}` : null, JSON.stringify(list), total, now, by, staged.copiedFrom);
      this.db.prepare('UPDATE shares SET updated_at=? WHERE id=?').run(now, sh.id);
      this.audit.event(w.actor, 'task.attach', { kind: 'task', id: t.id }, { role, version: v, files: list.map((e) => e.path), total_bytes: total, copied_from: staged.copiedFrom, share: sh.id, ...(staged.channel ? { channel: staged.channel } : {}) });
      return { share_id: sh.id, version: v };
    });
  }

  // ───── files from the PC (docs/transfers.md, "Task files from the PC") ─────
  /** A task upload's target: `<task id>#<role>`. */
  static uploadTarget(taskId: string, role: AttachRole): string { return `${taskId}#${role}`; }
  private uploadOf(c: TaskUpload): { t: TaskRow | null; role: AttachRole; w: Attacher } {
    const [taskId, role] = c.target.split('#') as [string, AttachRole];
    return { t: this.teams.task(taskId), role: role === 'submission' ? 'submission' : 'brief', w: { agentId: c.from_agent_id, credId: c.from_credential_id, machineId: c.from_machine_id, actor: { kind: 'agent', id: c.from_agent_id } } };
  }
  /**
   * May a task upload from the PC still land? The same checks as an inline attachment, for the agent who started it: the
   * task has not ended and the agent may still change that set, no lockdown stops it and its team is not paused. Checked
   * before each chunk is staged and again as the files land. Returns the channel's failure reason and message, or null.
   */
  uploadRefusal(c: TaskUpload): { reason: string; message: string } | null {
    const { t, role, w } = this.uploadOf(c);
    if (!t) return { reason: 'denied', message: 'The task no longer exists.' };
    try { this.mayChange(t, role, w); } catch (e) { if (e instanceof KeyError) return { reason: e.code, message: e.message }; throw e; }
    const locked = this.lockdown?.blocks('share_upload', w.agentId!, w.machineId ?? null) ?? null;
    if (locked) return { reason: 'lockdown', message: locked };
    if (this.teams.pausedTeamOf(w.agentId!)) return { reason: 'paused', message: 'Your team is paused: the files were not attached.' };
    return null;
  }
  /**
   * The files of a task upload, complete and scanned by the channel: the inline rules apply (names, types sniffed from the
   * bytes, sizes, the set's, task's and team's limits), then commit writes the set's next version and audits it with the
   * channel. A submission's files make a new round; when the task is in review on that submission, it names that round.
   */
  async commitUpload(c: TaskUpload, files: { path: string; bytes: Buffer }[]): Promise<{ task_id: string; role: AttachRole; share_id: string; version: number; files: number; total_bytes: number; received: ReceivedFile[] }> {
    const { t, role, w } = this.uploadOf(c);
    if (!t) throw err('denied', 'The task no longer exists.');
    if (!files.length) throw err('invalid_argument', 'The upload held no files.');
    const entries: AttachEntry[] = [];
    let bytes = 0;
    for (const f of files) {
      this.checkName(f.path);
      const p = safeRel(f.path)!;
      const type = sniff(f.bytes);
      this.checkSize(p, f.bytes.length, type);
      const r = await this.store.putBlob(f.bytes, ATTACH_LIMITS.file);
      entries.push({ path: p, blob_hash: r.hash, size: f.bytes.length, is_text: isText(f.bytes), stored: r.stored, type });
      bytes += f.bytes.length;
    }
    return tx(this.db, () => {
      const cur = this.teams.task(t.id)!;
      const set = this.commit(cur, role, { entries, copiedFrom: null, bytes, refund: () => {}, ...(c.id ? { channel: c.id } : {}) }, w);
      if (role === 'submission' && cur.status === 'in_review' && cur.assignee_agent_id === w.agentId) {
        // The submission names its files' round; the task's version stays, so a verdict already being written still lands.
        this.db.prepare('UPDATE tasks SET share_id=?, share_version=?, updated_at=? WHERE id=?').run(set.share_id, set.version, Date.now(), cur.id);
      }
      // What landed, as the hub stored it: each file's name, size and sha256 of its bytes (the task's upload state shows these).
      const received = entries.map((e) => ({ name: e.path, size: e.size, sha256: e.blob_hash.replace(/^sha256:/, '') }));
      return { task_id: cur.id, role, share_id: set.share_id, version: set.version, files: entries.length, total_bytes: bytes, received };
    });
  }
  /**
   * The task's uploads from the PC, newest first, for task_list (docs/transfers.md, "State on the task"): each upload's set,
   * state and files. Received files carry the size and sha256 the hub computed as they landed; an upload still open past its
   * channel's expiry counts as failed even before the sweep ends it, so none shows "uploading" for ever. The reason is the
   * hub's fixed wording for the channel's code, never a message; the names are the uploader's text (L2). No channel id, token
   * or PC path. The caller checks mayRead first.
   */
  uploads(taskId: string, now = Date.now(), limit = 20): UploadView[] {
    const rows = this.db.prepare(`SELECT target, status, failure_reason, result, from_local_path, created_at, finished_at, expires_at FROM data_channels
      WHERE opened_with='task_attach' AND target IN (?,?) ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(TaskAttachments.uploadTarget(taskId, 'brief'), TaskAttachments.uploadTarget(taskId, 'submission'), limit) as { target: string; status: string; failure_reason: string | null; result: string | null; from_local_path: string | null; created_at: number; finished_at: number | null; expires_at: number | null }[];
    return rows.map((r) => {
      const role: AttachRole = r.target.endsWith('#submission') ? 'submission' : 'brief';
      const names = sentNames(r.from_local_path).map((name) => ({ name }));
      const base = { role, started_at: r.created_at, finished_at: r.finished_at };
      if (r.status === 'done') {
        let got: ReceivedFile[] | undefined;
        try { got = (JSON.parse(r.result ?? '{}') as { received?: ReceivedFile[] }).received; } catch { got = undefined; }
        return { ...base, state: 'received' as const, files: Array.isArray(got) ? got.map((f) => ({ name: String(f.name), size: Number(f.size), sha256: String(f.sha256) })) : names };
      }
      const live = r.status === 'offered' || r.status === 'open';
      if (live && !(r.expires_at !== null && r.expires_at < now)) return { ...base, state: 'uploading' as const, files: names };
      return { ...base, state: 'failed' as const, files: names, reason: uploadReason(live ? 'idle' : r.status === 'expired' ? 'idle' : r.failure_reason) };
    });
  }
  /** The call that starts a task upload: who, which task and set, the channel and how many paths (never the paths). */
  noteUpload(w: Attacher, taskId: string, role: AttachRole, channelId: string, paths: number): void {
    this.audit.event(w.actor, 'task.attach_local', { kind: 'task', id: taskId }, { role, channel: channelId, paths, machine: w.machineId ?? null });
  }

  /**
   * Upkeep: a cancelled or discarded task's sets close (no new versions; only the operator opens them, and the task rule
   * already refuses agents the moment the task closes), and 30 days after closing they are deleted with their versions.
   * Done tasks keep theirs. The blobs go with the hub's blob sweep once nothing refers to them.
   */
  sweep(now = Date.now()): { closed: number; deleted: number } {
    const closed = Number(this.db.prepare(`UPDATE shares SET status='closed', updated_at=? WHERE status='open' AND task_id IN (SELECT id FROM tasks WHERE status IN ('cancelled','discarded'))`).run(now).changes);
    const old = this.db.prepare(`SELECT s.id, s.task_id FROM shares s JOIN tasks k ON k.id=s.task_id WHERE k.status IN ('cancelled','discarded') AND s.status IN ('closed','revoked') AND s.updated_at<? LIMIT 200`).all(now - ATTACH_DELETE_AFTER_MS) as { id: string; task_id: string }[];
    if (old.length) tx(this.db, () => {
      for (const r of old) {
        for (const tbl of ['share_feedback', 'share_versions', 'share_recipients']) this.db.prepare(`DELETE FROM ${tbl} WHERE share_id=?`).run(r.id);
        this.db.prepare('DELETE FROM shares WHERE id=?').run(r.id);
        this.audit.event({ kind: 'system', id: null }, 'task.attachments_deleted', { kind: 'task', id: r.task_id }, { share: r.id, after_days: 30 });
      }
    });
    return { closed, deleted: old.length };
  }

  private label(by: string | null): string | null {
    if (!by) return null;
    if (by.startsWith('admin')) return 'The operator';
    return (this.db.prepare('SELECT label FROM agents WHERE id=?').get(by) as { label: string | null } | undefined)?.label ?? by;
  }
}
