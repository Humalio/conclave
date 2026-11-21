/** Rooms, messages, delivery cursors and the in-process wake-up for bounded waits (SPECIFICATION F3, design/08 "Agents and messages"). */
import { EventEmitter } from 'node:events';
import type { Db } from '../db/db.js';
import { tx } from '../db/db.js';
import type { Keys } from '../keys/keys.js';
import type { Links } from '../links/links.js';
import type { Rule } from '../policy/engine.js';
import { authorize } from '../policy/engine.js';
import type { OwnerScope } from '../policy/ownerScope.js';
import { randomToken } from '../util/crypto.js';

export const MAX_BODY_BYTES = 64 * 1024;
export const MESSAGE_KINDS = ['text', 'proposal', 'review_request', 'agreement', 'task_update'] as const;

export interface RoomRow { id: string; kind: 'direct' | 'group' | 'team'; team_id: string | null; name: string | null; direct_key: string | null; last_seq: number; archived_at: number | null; created_at: number }
export interface MessageRow {
  id: string; room_id: string; seq: number; sender_agent_id: string | null; sender_credential_id: string | null; client_msg_id: string | null;
  kind: string; body: string; reply_to: string | null; size_bytes: number; created_at: number; redacted_at: number | null;
}

export const envelope = (m: MessageRow) => ({
  trust: 'L2' as const, from: m.sender_agent_id ?? 'hub', kind: m.kind, content: m.redacted_at ? '' : m.body, seq: m.seq, room_id: m.room_id,
  message_id: m.id, reply_to: m.reply_to, created_at: m.created_at, ...(m.redacted_at ? { redacted: true } : {}),
});

export class Messaging {
  private readonly em = new EventEmitter();
  private waiters = new Set<() => void>();
  private _closed = false;
  /** Set by Teams: fed every stored message so team members get it as a work item. */
  onInsert: ((m: MessageRow) => void) | null = null;
  /**
   * Set in app.ts: a stored message and the members it wakes, for the connector's delivery orders (an agent's are L2:
   * rate-limited there). See `wakes` for who that is.
   */
  onSent: ((m: MessageRow, recipients: string[]) => void) | null = null;
  constructor(private readonly db: Db, private readonly keys: Keys, private readonly links: Links) { this.em.setMaxListeners(0); }

  // ───── permissions ─────
  /** Implicit rules from links with grants_messaging: bidirectional send and receive, tagged "link:". */
  linkRules(agentId: string): Rule[] {
    const out: Rule[] = [];
    for (const l of this.links.list(agentId)) {
      if (!l.grants_messaging) continue;
      const other = l.from_agent_id === agentId ? l.to_agent_id : l.from_agent_id;
      out.push({ id: `link:${l.id}`, effect: 'allow', actions: ['message.send', 'message.receive'], resource: `agent:${other}`, note: `link ${l.kind}` });
    }
    return out;
  }
  /** May this agent (any of its usable session keys, plus links) do this? Used for the receiving side, which has no login in this request. */
  agentAllows(agentId: string, action: string, resource: string): boolean {
    const link = this.linkRules(agentId), owners = this.owners(agentId);
    const creds = this.keys.credentials({ kind: 'session_key', agentId }).filter((c) => !['revoked', 'expired'].includes(this.keys.effectiveStatus(c)));
    return creds.some((c) => authorize([...this.keys.rulesFor(c.id), ...link], owners, action, resource).allowed);
  }
  /** Owner ceilings for the receiving side (docs/authorization.md#owner-enforcement); set by app.ts. */
  ownerScope: OwnerScope | null = null;
  private owners(agentId: string) { return this.ownerScope ? this.ownerScope.cap(agentId, []) : []; }

  /**
   * May this agent read this room: membership plus grants, as message_read decides. `login` gives a live login's
   * rules and app cap; without it, any usable session key of the agent counts (the receiving side, which has no
   * login in this request). Work-queue delivery checks this too, so a room member without read rights gets nothing.
   */
  mayRead(agentId: string, room: RoomRow, login?: { rules: Rule[]; cap: Rule[] }): boolean {
    if (!this.isMember(room.id, agentId)) return false;
    const link = this.linkRules(agentId), other = room.kind === 'direct' ? this.otherOf(room, agentId) : null;
    const ok = (rules: Rule[], cap: Rule[]) => {
      const all = [...rules, ...link];
      if (room.kind === 'direct') return !!other && (authorize(all, cap, 'message.receive', `agent:${other}`).allowed || authorize(all, cap, 'message.send', `agent:${other}`).allowed);
      return authorize(all, cap, 'room.read_history', `room:${room.id}`).allowed;
    };
    if (login) return ok(login.rules, login.cap);
    return this.keys.credentials({ kind: 'session_key', agentId }).filter((c) => !['revoked', 'expired'].includes(this.keys.effectiveStatus(c)))
      .some((c) => ok(this.keys.rulesFor(c.id), this.owners(agentId)));
  }

  // ───── rooms ─────
  room(id: string): RoomRow | null { return (this.db.prepare('SELECT * FROM rooms WHERE id=?').get(id) as unknown as RoomRow) ?? null; }
  isMember(roomId: string, agentId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM room_memberships WHERE room_id=? AND agent_id=? AND left_at IS NULL AND (expires_at IS NULL OR expires_at>?)').get(roomId, agentId, Date.now());
  }
  members(roomId: string): { agent_id: string; role: string; joined_at: number }[] {
    return this.db.prepare('SELECT agent_id, role, joined_at FROM room_memberships WHERE room_id=? AND left_at IS NULL ORDER BY joined_at').all(roomId) as never;
  }
  addMember(roomId: string, agentId: string, role: 'owner' | 'member', invitedBy: string | null): boolean {
    if (this.isMember(roomId, agentId)) return false;
    this.db.prepare('INSERT INTO room_memberships(room_id,agent_id,role,joined_at,invited_by) VALUES (?,?,?,?,?)').run(roomId, agentId, role, Date.now(), invitedBy);
    this.em.emit(`rooms:${agentId}`); // a waiting message_read of this agent also watches its new room
    return true;
  }
  directKey(a: string, b: string): string { return [a, b].sort().join('|'); }
  findDirect(a: string, b: string): RoomRow | null {
    return (this.db.prepare('SELECT * FROM rooms WHERE direct_key=?').get(this.directKey(a, b)) as unknown as RoomRow) ?? null;
  }
  ensureDirect(a: string, b: string): RoomRow {
    return tx(this.db, () => {
      let r = this.findDirect(a, b);
      if (!r) {
        const id = `room_${randomToken(10)}`;
        this.db.prepare("INSERT INTO rooms(id,kind,direct_key,created_by_agent,created_at) VALUES (?,'direct',?,?,?)").run(id, this.directKey(a, b), a, Date.now());
        r = this.room(id)!;
      }
      this.addMember(r.id, a, 'member', null); this.addMember(r.id, b, 'member', null);
      return r;
    });
  }
  createGroup(name: string, creator: string): RoomRow {
    const id = `room_${randomToken(10)}`;
    tx(this.db, () => {
      this.db.prepare("INSERT INTO rooms(id,kind,name,created_by_agent,created_at) VALUES (?,'group',?,?,?)").run(id, name, creator, Date.now());
      this.addMember(id, creator, 'owner', null);
    });
    return this.room(id)!;
  }
  /** The other participant of a direct room. */
  otherOf(room: RoomRow, me: string): string | null { return room.direct_key ? room.direct_key.split('|').find((x) => x !== me) ?? null : null; }
  memberRooms(agentId: string): RoomRow[] {
    return this.db.prepare(`SELECT r.* FROM rooms r JOIN room_memberships m ON m.room_id=r.id AND m.agent_id=? AND m.left_at IS NULL AND (m.expires_at IS NULL OR m.expires_at>?)
      WHERE r.archived_at IS NULL ORDER BY r.created_at`).all(agentId, Date.now()) as never;
  }
  groupRooms(): RoomRow[] { return this.db.prepare("SELECT * FROM rooms WHERE kind='group' AND archived_at IS NULL ORDER BY created_at").all() as never; }
  leave(roomId: string, agentId: string): void { this.db.prepare('UPDATE room_memberships SET left_at=? WHERE room_id=? AND agent_id=? AND left_at IS NULL').run(Date.now(), roomId, agentId); }

  // ───── sending ─────
  findDuplicate(credId: string, clientMsgId: string): MessageRow | null {
    return (this.db.prepare('SELECT * FROM messages WHERE sender_credential_id=? AND client_msg_id=?').get(credId, clientMsgId) as unknown as MessageRow) ?? null;
  }
  /**
   * Who a stored message wakes through the connector (docs/connector.md, delivery orders). The operator's or the hub's message:
   * every member. An agent's message: in a direct room the other member; in any other room only the members it addresses, by
   * an @mention of their label (exact, any letter case, not inside a longer word or label) or by replying to their message.
   * Never the sender. The others still get the message as unread at their next prompt.
   */
  wakes(m: MessageRow): string[] {
    const members = this.members(m.room_id).map((x) => x.agent_id).filter((a) => a !== m.sender_agent_id);
    if (m.sender_agent_id === null) return members;
    if (this.room(m.room_id)?.kind === 'direct') return members;
    const replied = m.reply_to ? this.message(m.reply_to)?.sender_agent_id ?? null : null;
    const body = m.body.toLowerCase();
    return members.filter((a) => {
      if (a === replied) return true;
      const label = this.keys.agent(a)?.label?.trim().toLowerCase();
      if (!label) return false;
      const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(String.raw`(^|[^\p{L}\p{N}_@-])@${esc}(?![\p{L}\p{N}_-])`, 'u').test(body);
    });
  }
  message(id: string): MessageRow | null { return (this.db.prepare('SELECT * FROM messages WHERE id=?').get(id) as unknown as MessageRow) ?? null; }
  /** Count one message against the key's hourly allowance. Returns seconds to wait when over the limit, else null. */
  rateCheck(credId: string, limit: number, now = Date.now()): number | null {
    const H = 3600_000, w = Math.floor(now / H) * H, scope = `cred:${credId}`;
    const row = this.db.prepare("SELECT count FROM usage_counters WHERE scope=? AND metric='messages' AND window_start=?").get(scope, w) as { count: number } | undefined;
    if ((row?.count ?? 0) >= limit) return Math.max(1, Math.ceil((w + H - now) / 1000));
    this.db.prepare("INSERT INTO usage_counters(scope,metric,window_start,count) VALUES (?,'messages',?,1) ON CONFLICT(scope,metric,window_start) DO UPDATE SET count=count+1").run(scope, w);
    this.db.prepare("DELETE FROM usage_counters WHERE metric='messages' AND window_start<?").run(w - 2 * H);
    return null;
  }
  insert(o: { roomId: string; /** null: the operator wrote it */ agentId: string | null; credId: string | null; kind: string; body: string; replyTo: string | null; clientMsgId: string }): MessageRow {
    const m = tx(this.db, () => {
      const seq = (this.db.prepare('SELECT last_seq FROM rooms WHERE id=?').get(o.roomId) as { last_seq: number }).last_seq + 1;
      this.db.prepare('UPDATE rooms SET last_seq=? WHERE id=?').run(seq, o.roomId);
      const id = `msg_${randomToken(10)}`;
      this.db.prepare('INSERT INTO messages(id,room_id,seq,sender_agent_id,sender_credential_id,client_msg_id,kind,body,reply_to,size_bytes,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, o.roomId, seq, o.agentId, o.credId, o.clientMsgId, o.kind, o.body, o.replyTo, Buffer.byteLength(o.body), Date.now());
      return this.message(id)!;
    });
    this.onInsert?.(m);
    try { this.onSent?.(m, this.wakes(m)); } catch { /* delivery never blocks a message */ }
    this.em.emit(`message:${m.room_id}`);
    return m;
  }

  // ───── reading ─────
  /** Messages after each room's delivered position for this login (or after `since`), not my own. */
  pending(tokenHash: string, agentId: string, roomIds: string[], limit: number, since?: number): { items: MessageRow[]; more: boolean } {
    if (roomIds.length === 0) return { items: [], more: false };
    const ph = roomIds.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT m.* FROM messages m LEFT JOIN message_delivery_cursors c ON c.token_hash=? AND c.room_id=m.room_id
      WHERE m.room_id IN (${ph}) AND m.seq > ${since === undefined ? 'COALESCE(c.delivered_seq,0)' : '?'} AND m.sender_agent_id IS NOT ?
      ORDER BY m.rowid LIMIT ?`).all(tokenHash, ...roomIds, ...(since === undefined ? [] : [since]), agentId, limit + 1) as unknown as MessageRow[];
    return { items: rows.slice(0, limit), more: rows.length > limit };
  }
  advance(tokenHash: string, agentId: string, delivered: Record<string, number>): void {
    for (const [room, seq] of Object.entries(delivered)) {
      this.db.prepare(`INSERT INTO message_delivery_cursors(agent_id,token_hash,room_id,delivered_seq,acked_seq,updated_at) VALUES (?,?,?,?,0,?)
        ON CONFLICT(token_hash,room_id) DO UPDATE SET delivered_seq=MAX(delivered_seq,excluded.delivered_seq), updated_at=excluded.updated_at`).run(agentId, tokenHash, room, seq, Date.now());
    }
  }
  ack(tokenHash: string, agentId: string, acked: Record<string, number>): number {
    let n = 0;
    for (const [room, seq] of Object.entries(acked)) {
      const r = this.room(room);
      if (!r || !this.isMember(room, agentId)) continue;
      const s = Math.min(seq, r.last_seq);
      this.db.prepare(`INSERT INTO message_delivery_cursors(agent_id,token_hash,room_id,delivered_seq,acked_seq,updated_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(token_hash,room_id) DO UPDATE SET acked_seq=MAX(acked_seq,excluded.acked_seq), delivered_seq=MAX(delivered_seq,excluded.acked_seq), updated_at=excluded.updated_at`).run(agentId, tokenHash, room, s, s, Date.now());
      n++;
    }
    return n;
  }
  /** This login's delivered position in one room (0 when it has read nothing there). */
  deliveredSeq(tokenHash: string, roomId: string): number {
    return (this.db.prepare('SELECT delivered_seq s FROM message_delivery_cursors WHERE token_hash=? AND room_id=?').get(tokenHash, roomId) as { s: number } | undefined)?.s ?? 0;
  }
  /**
   * Delivered positions of this login in the rooms it has not acknowledged that far. A room acknowledged up to its
   * delivered position is left out: acknowledging it again changes nothing, and leaving it out keeps the cursor short.
   */
  cursorOf(tokenHash: string): Record<string, number> {
    const o: Record<string, number> = {};
    for (const r of this.db.prepare('SELECT room_id, delivered_seq FROM message_delivery_cursors WHERE token_hash=? AND delivered_seq>acked_seq').all(tokenHash) as { room_id: string; delivered_seq: number }[]) o[r.room_id] = r.delivered_seq;
    return o;
  }
  /**
   * The next_cursor for message_read: the positions inline while they stay short, otherwise a snapshot id bound to this
   * login (`s1.<id>`), so message_ack can always take its own cursor however many rooms the agent is in.
   */
  cursorFor(tokenHash: string): string {
    const rooms = this.cursorOf(tokenHash);
    const inline = encodeCursor(rooms);
    if (inline.length <= INLINE_CURSOR_MAX) return inline;
    const id = Number(this.db.prepare('INSERT INTO message_ack_snapshots(token_hash,rooms,created_at) VALUES (?,?,?)').run(tokenHash, JSON.stringify(rooms), Date.now()).lastInsertRowid);
    this.db.prepare('DELETE FROM message_ack_snapshots WHERE token_hash=? AND id NOT IN (SELECT id FROM message_ack_snapshots WHERE token_hash=? ORDER BY id DESC LIMIT ?)').run(tokenHash, tokenHash, SNAPSHOTS_KEPT);
    return `${SNAPSHOT_PREFIX}${id}`;
  }
  /** Positions a cursor stands for: an inline cursor (any login's, as before), or a snapshot of this login's. Null if neither. */
  resolveCursor(tokenHash: string, cursor: string): Record<string, number> | null {
    if (!cursor.startsWith(SNAPSHOT_PREFIX)) return decodeCursor(cursor);
    const id = cursor.slice(SNAPSHOT_PREFIX.length);
    if (!/^[1-9]\d{0,15}$/.test(id)) return null;
    const row = this.db.prepare('SELECT rooms FROM message_ack_snapshots WHERE id=? AND token_hash=?').get(Number(id), tokenHash) as { rooms: string } | undefined;
    return row ? positions(JSON.parse(row.rooms)) : null;
  }
  unread(tokenHash: string, agentId: string, roomId: string): number {
    return (this.db.prepare(`SELECT COUNT(*) n FROM messages m LEFT JOIN message_delivery_cursors c ON c.token_hash=? AND c.room_id=m.room_id
      WHERE m.room_id=? AND m.seq>COALESCE(c.delivered_seq,0) AND m.sender_agent_id IS NOT ?`).get(tokenHash, roomId, agentId) as { n: number }).n;
  }
  history(roomId: string, before: number | undefined, limit: number): MessageRow[] {
    const rows = this.db.prepare(`SELECT * FROM messages WHERE room_id=? ${before === undefined ? '' : 'AND seq<?'} ORDER BY seq DESC LIMIT ?`)
      .all(roomId, ...(before === undefined ? [] : [before]), limit) as unknown as MessageRow[];
    return rows.reverse();
  }

  // ───── wake-up ─────
  /** Resolves when any message is stored, after `ms`, or when the server shuts down. */
  /** Wait for a message in one of these rooms or for the agent joining a room (only those waiters wake), or the timeout. */
  wait(ms: number, roomIds: string[], agentId: string): Promise<void> {
    return new Promise((resolve) => {
      const evs = [...roomIds.map((r) => `message:${r}`), `rooms:${agentId}`];
      const done = () => { clearTimeout(t); for (const e of evs) this.em.off(e, done); this.waiters.delete(done); resolve(); };
      const t = setTimeout(done, ms);
      for (const e of evs) this.em.on(e, done);
      this.waiters.add(done);
    });
  }
  get closed(): boolean { return this._closed; }
  releaseAll(): void { this._closed = true; for (const w of [...this.waiters]) w(); }
}

/** Longest inline cursor; longer ones become snapshot ids. Well under message_ack's 4,000-character argument limit. */
export const INLINE_CURSOR_MAX = 2000;
/** Snapshot cursors kept per login; an older one is refused and the agent reads again. */
export const SNAPSHOTS_KEPT = 16;
const SNAPSHOT_PREFIX = 's1.';
export const encodeCursor = (m: Record<string, number>): string => Buffer.from(JSON.stringify(m)).toString('base64url');
export function decodeCursor(c: string): Record<string, number> | null {
  try { return positions(JSON.parse(Buffer.from(c, 'base64url').toString('utf8'))); } catch { return null; }
}
function positions(o: unknown): Record<string, number> | null {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(o)) { if (!Number.isInteger(v) || (v as number) < 0) return null; out[k] = v as number; }
  return out;
}
