/**
 * Hardware (docs/hardware.md, SPEC-HARDWARE-01 to 03): a PC's optional compute role, the teams it serves with their daily
 * allowances, and one ordered waiting list per machine whose first eligible entry holds it: only while the machine is open,
 * not paused, and the entry's team has hours left today. The hub records what the holder reports and never opens SSH or
 * starts or stops jobs; where the machine's user turned measuring on, the connector sends the whole machine's use, which is
 * tied to the hold by time and checked against the declared limits (step 2, docs/hardware.md#measuring). Every read and write sweeps the list first (and the 30 s upkeep does it on
 * its own): an entry whose agent lost its task or access goes, a holder running out of its window or allowance is warned
 * 10 minutes before and flagged after, and every hold is kept in hw_holds for the allowances, What ran and the analysis.
 */
import type { Db } from '../db/db.js';
import { tx } from '../db/db.js';
import type { Audit, Actor } from '../audit/audit.js';
import type { Keys } from '../keys/keys.js';
import { KeyError } from '../keys/keys.js';
import type { LeakGuard } from '../guard/leakGuard.js';
import { randomToken } from '../util/crypto.js';

export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Day = typeof DAYS[number];
export interface HwWindow { days: Day[]; from: string; to: string }
export interface ComputeIn {
  access: string; timezone: string; windows: HwWindow[];
  memory_gb?: number | null; cpus?: number | null; gpu?: string | null; notes?: string | null; teams: string[];
  /** Daily hours per team id (null: no limit). A team left out keeps the allowance it had. */
  allowances?: Record<string, number | null>;
  /** People use the machine too: the console says the measured figures include their use. */
  shared_with_people?: boolean;
}
interface ComputeRow { machine_id: string; access: string; timezone: string; windows: string; memory_gb: number | null; cpus: number | null; gpu: string | null; notes: string | null; created_at: number; updated_at: number; paused_at: number | null; paused_by: string | null; shared_with_people: number }
export interface Compute extends Omit<ComputeIn, 'teams' | 'allowances' | 'shared_with_people'> { teams: { id: string; name: string; daily_hours: number | null }[] }
interface EntryRow {
  seq: number; machine_id: string; agent_id: string; team_id: string; task_id: string; joined_at: number; estimate_minutes: number | null;
  held_since: number | null; estimate_until: number | null; report: string | null; reported_at: number | null;
  warned_window: number | null; warned_day: string | null;
  agent_label: string; agent_status: string; team_name: string; team_status: string; task_title: string | null; task_status: string | null;
  task_assignee: string | null; task_team: string | null; member: number | null; served: number | null;
}
export interface Entry {
  /** position: the place in the list's order; line: the place among the waiting entries (0 for the holder). */
  seq: number; position: number; line: number; holder: boolean; agent_id: string; label: string; team_id: string; team_name: string; task_id: string; task_title: string;
  joined_at: number; estimate_minutes: number | null; held_since: number | null; estimate_until: number | null; report: string | null; reported_at: number | null;
}
/** Open now (or any time), until when and when the next window opens: local clock words and epoch ms. */
export interface Availability { any: boolean; now: boolean; until: string | null; next: string | null; ends_at: number | null; next_at: number | null }
/** A team's allowance today on one machine: hours per local day (null: no limit), held and left (ms), and the reset. */
export interface Allowance { team_id: string; team_name: string; daily_hours: number | null; used_ms: number; left_ms: number | null; resets_at: number; day: string }
export type FlagKind = 'lost' | 'window' | 'allowance' | 'limit';
export type Period = '24h' | '7d' | '30d';
export const PERIODS: Record<Period, number> = { '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 };
export interface Hold {
  /** use: the machine's figures during the hold, when it was measured (set by the operator's overview only). */
  use?: HoldUse | null;
  seq: number; machine_id: string; machine_name: string; agent_id: string; label: string; team_id: string; team_name: string; task_id: string | null; task_title: string;
  joined_at: number; held_since: number; ended_at: number | null; ended: string | null; report: string | null; reported_at: number | null; flags: FlagKind[];
}
/** One sample from the connector: the whole machine, numbers only. */
export interface GpuIn { util_pct: number; mem_used_gb: number; mem_total_gb: number }
export interface SampleIn { at: number; cpu_pct: number; cpu_count?: number; mem_used_gb: number; mem_total_gb: number; gpus?: GpuIn[] }
interface SampleRow { machine_id: string; at: number; cpu_pct: number; cpu_count: number | null; mem_used_gb: number; mem_total_gb: number; gpus: string; hold_seq: number | null }
interface HoldUseRow {
  hold_seq: number; machine_id: string; n: number; first_at: number; last_at: number; cpu_sum: number; cpu_peak: number; cpus_peak: number | null; mem_sum: number; mem_peak: number;
  gpu_n: number; gpu_sum: number; gpu_peak: number; gpu_mem_peak: number; mem_over_since: number | null; cpu_over_since: number | null;
}
interface UseDayRow { machine_id: string; date: string; held: number; n: number; cpu_sum: number; cpu_peak: number; mem_sum: number; mem_peak: number; gpu_n: number; gpu_sum: number; gpu_peak: number }
/** The machine's use during a hold: averages and peaks of its samples (CPU and GPU in %, memory in GB). */
export interface HoldUse { samples: number; first_at: number; last_at: number; cpu_avg: number; cpu_peak: number; cpus_peak: number | null; mem_avg_gb: number; mem_peak_gb: number; gpu_avg: number | null; gpu_peak: number | null; gpu_mem_peak_gb: number | null }
export interface UseSum { samples: number; cpu_avg: number; cpu_peak: number; mem_avg_gb: number; mem_peak_gb: number; gpu_avg: number | null; gpu_peak: number | null }
const useOf = (u: HoldUseRow): HoldUse => ({ samples: u.n, first_at: u.first_at, last_at: u.last_at, cpu_avg: u.cpu_sum / u.n, cpu_peak: u.cpu_peak, cpus_peak: u.cpus_peak,
  mem_avg_gb: u.mem_sum / u.n, mem_peak_gb: u.mem_peak, gpu_avg: u.gpu_n ? u.gpu_sum / u.gpu_n : null, gpu_peak: u.gpu_n ? u.gpu_peak : null, gpu_mem_peak_gb: u.gpu_n ? u.gpu_mem_peak : null });
/** At most this many samples in one batch (the connector sends once a minute). */
export const SAMPLE_MAX = 120;
const SKEW_MS = 5 * 60_000, OVER_MS = 2 * 60_000, GAP_MS = 3 * 60_000, LIVE_MS = 3 * 60_000;
const RAW_KEEP_MS = 7 * 86_400_000, SUMMARY_KEEP_MS = 400 * 86_400_000;
export interface HoldFilter { machine?: string | null; team?: string | null; agent?: string | null; q?: string | null }

/** Task states an agent may join with, and the wider set it may stay with (a submitted or blocked task is still its own). */
const JOIN_STATES = ['assigned', 'in_progress', 'changes_requested'];
const GONE_STATES = ['done', 'cancelled', 'discarded', 'open', 'backlog'];
const TEAM_LIVE = ['running', 'paused'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;
const DAY_NAME: Record<Day, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
const NOT_OFFERED = 'No machine of that name is offered to your teams. Call hw_list for the machines you may use.';
const WARN_MS = 10 * 60_000;
const HOUR_MS = 3_600_000;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

const dayAt = (i: number): Day => DAYS[((i % 7) + 7) % 7]!;
const mins = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
const bad = (msg: string) => new KeyError('invalid_argument', msg);

/** The local date and time at `at` in time zone `tz`; one formatter per zone, since the analysis calls this often. */
const FMT = new Map<string, Intl.DateTimeFormat>();
function local(tz: string, at: number): { day: number; date: string; h: number; mi: number; s: number } {
  let f = FMT.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); FMT.set(tz, f); }
  const p = Object.fromEntries(f.formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return { day: DAYS.indexOf(String(p.weekday).toLowerCase().slice(0, 3) as Day), date: `${p.year}-${p.month}-${p.day}`, h: Number(p.hour) % 24, mi: Number(p.minute), s: Number(p.second) };
}
/** The weekday and minute of the day at `at` in time zone `tz`. */
function localNow(tz: string, at: number): { day: number; min: number } {
  const l = local(tz, at);
  return { day: l.day, min: l.h * 60 + l.mi };
}
const dayStart = (tz: string, at: number) => { const l = local(tz, at); return at - (((l.h * 60 + l.mi) * 60 + l.s) * 1000 + (((at % 1000) + 1000) % 1000)); };
/** The local day holding `at`: its date, its start (local midnight) and the next midnight, DST included. */
export function localDay(tz: string, at: number): { date: string; start: number; end: number } {
  const start = dayStart(tz, at);
  return { date: local(tz, at).date, start, end: dayStart(tz, start + 26 * HOUR_MS) };
}
/** Sorted, merged intervals. */
function union(iv: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [a, b] of [...iv].filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b); else out.push([a, b]);
  }
  return out;
}
const span = (iv: [number, number][]) => iv.reduce((n, [a, b]) => n + b - a, 0);
function overlap(x: [number, number][], y: [number, number][]): number {
  let n = 0;
  for (const [a, b] of x) for (const [c, d] of y) n += Math.max(0, Math.min(b, d) - Math.max(a, c));
  return n;
}
/** The machine's open intervals between `from` and `to` (epoch ms), from its windows in its own time zone. */
export function openIntervals(c: { timezone: string; windows: HwWindow[] }, from: number, to: number): [number, number][] {
  if (!c.windows.length) return [[from, to]];
  const iv: [number, number][] = [];
  for (let d = localDay(c.timezone, from - 26 * HOUR_MS); d.start < to; d = localDay(c.timezone, d.end)) {
    const wd = dayAt(local(c.timezone, d.start + HOUR_MS).day);
    for (const w of c.windows) {
      if (!w.days.includes(wd)) continue;
      const f = mins(w.from), t = mins(w.to);
      iv.push([Math.max(from, d.start + f * 60_000), Math.min(to, (f < t ? d.start : d.end) + t * 60_000)]);
    }
  }
  return union(iv);
}
export function validTimezone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/**
 * Whether the machine is in a scheduled window at `at`, until when, and when the next one opens, all in its own time zone.
 * A window whose end is before its start runs past midnight into the next day. No windows: any time.
 */
export function availability(c: { timezone: string; windows: HwWindow[] }, at = Date.now()): Availability {
  if (!c.windows.length) return { any: true, now: true, until: null, next: null, ends_at: null, next_at: null };
  const { day, min } = localNow(c.timezone, at);
  let until: number | null = null, next: { off: number; day: number; from: string } | null = null;
  for (const w of c.windows) {
    const f = mins(w.from), t = mins(w.to), on = (d: number) => w.days.includes(dayAt(d));
    // Minutes from now to the end of this window, when now is inside it.
    const end = f < t ? (on(day) && min >= f && min < t ? t - min : null)
      : on(day) && min >= f ? 1440 - min + t : on(day - 1) && min < t ? t - min : null;
    if (end !== null) until = Math.max(until ?? 0, end);
    for (let d = 0; d <= 7; d++) {
      if (!on(day + d)) continue;
      const off = d * 1440 + f - min;
      if (off > 0 && (!next || off < next.off)) next = { off, day: (day + d) % 7, from: w.from };
    }
  }
  const clock = (off: number) => { const m = (min + off) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
  const base = at - (((at % 60_000) + 60_000) % 60_000);
  return { any: false, now: until !== null, until: until !== null ? clock(until) : null, next: next ? `${DAY_NAME[dayAt(next.day)]} ${next.from}` : null,
    ends_at: until !== null ? base + until * 60_000 : null, next_at: next ? base + next.off * 60_000 : null };
}

/** "Mon–Fri 09:00–18:00; Sat 10:00–14:00", or "Any time". */
export function windowsText(windows: HwWindow[]): string {
  if (!windows.length) return 'Any time';
  return windows.map((w) => {
    const idx = [...new Set(w.days)].map((d) => DAYS.indexOf(d)).sort((a, b) => a - b), runs: string[] = [];
    for (let i = 0; i < idx.length;) {
      let j = i; while (j + 1 < idx.length && idx[j + 1] === idx[j]! + 1) j++;
      runs.push(j - i >= 2 ? `${DAY_NAME[dayAt(idx[i]!)]}–${DAY_NAME[dayAt(idx[j]!)]}` : idx.slice(i, j + 1).map((x) => DAY_NAME[dayAt(x)]).join(', '));
      i = j + 1;
    }
    return `${runs.join(', ')} ${w.from}–${w.to}`;
  }).join('; ');
}
export function limitsText(c: { memory_gb?: number | null; cpus?: number | null; gpu?: string | null }): string {
  const p = [c.memory_gb != null ? `memory ${c.memory_gb} GB` : '', c.cpus != null ? `${c.cpus} ${c.cpus === 1 ? 'CPU' : 'CPUs'}` : '', c.gpu ? `GPU ${c.gpu}` : ''].filter(Boolean);
  return p.length ? p.join(' · ') : 'none declared';
}
const hoursText = (ms: number) => `${Math.round(ms / 360_000) / 10} h`;
const localClock = (tz: string, at: number) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));

export class Hardware {
  /** The hub's clock. Tests set it to walk a machine through its windows, allowances and midnight. */
  now: () => number = () => Date.now();
  constructor(private db: Db, private keys: Keys, private audit: Audit, private guard: LeakGuard) {}

  // ───── Reading ─────

  private computeRow(machineId: string): ComputeRow | null {
    return (this.db.prepare('SELECT * FROM hw_machines WHERE machine_id=?').get(machineId) as unknown as ComputeRow) ?? null;
  }
  private compute(r: ComputeRow): Compute {
    const teams = this.db.prepare('SELECT t.id, t.name, mt.daily_hours FROM hw_machine_teams mt JOIN teams t ON t.id=mt.team_id WHERE mt.machine_id=? ORDER BY t.name').all(r.machine_id) as { id: string; name: string; daily_hours: number | null }[];
    return { access: r.access, timezone: r.timezone, windows: JSON.parse(r.windows) as HwWindow[], memory_gb: r.memory_gb, cpus: r.cpus, gpu: r.gpu, notes: r.notes, teams };
  }
  private rows(machineId: string): EntryRow[] {
    return this.db.prepare(`SELECT q.*, a.label agent_label, a.status agent_status, t.name team_name, t.status team_status,
        k.title task_title, k.status task_status, k.assignee_agent_id task_assignee, k.team_id task_team,
        (SELECT 1 FROM team_members m WHERE m.team_id=q.team_id AND m.agent_id=q.agent_id AND m.removed_at IS NULL) member,
        (SELECT 1 FROM hw_machine_teams s WHERE s.machine_id=q.machine_id AND s.team_id=q.team_id) served
      FROM hw_queue q JOIN agents a ON a.id=q.agent_id JOIN teams t ON t.id=q.team_id LEFT JOIN tasks k ON k.id=q.task_id
      WHERE q.machine_id=? ORDER BY q.seq`).all(machineId) as unknown as EntryRow[];
  }
  private entries(machineId: string): Entry[] {
    let w = 0;
    return this.rows(machineId).map((r, i) => ({
      seq: r.seq, position: i + 1, line: r.held_since !== null ? 0 : ++w, holder: r.held_since !== null, agent_id: r.agent_id, label: r.agent_label, team_id: r.team_id, team_name: r.team_name,
      task_id: r.task_id, task_title: r.task_title ?? '', joined_at: r.joined_at, estimate_minutes: r.estimate_minutes, held_since: r.held_since,
      estimate_until: r.estimate_until, report: r.report, reported_at: r.reported_at,
    }));
  }
  /** Why an entry may no longer stay: its access (agent, membership, team, machine's team list) first, then its task. */
  private lost(r: EntryRow): 'access' | 'task' | null {
    if (r.agent_status !== 'active' || !r.member || !r.served || !TEAM_LIVE.includes(r.team_status)) return 'access';
    if (!r.task_status || r.task_assignee !== r.agent_id || r.task_team !== r.team_id || GONE_STATES.includes(r.task_status)) return 'task';
    return null;
  }

  // ───── Allowances and eligibility ─────

  /** What the team held on the machine during the local day holding `at` (holds split at midnight), and what is left. */
  private allowanceOf(machineId: string, tz: string, team: { id: string; name: string; daily_hours: number | null }, at: number): Allowance {
    const d = localDay(tz, at);
    const held = this.db.prepare('SELECT held_since, ended_at FROM hw_holds WHERE machine_id=? AND team_id=? AND held_since<? AND (ended_at IS NULL OR ended_at>?)')
      .all(machineId, team.id, d.end, d.start) as { held_since: number; ended_at: number | null }[];
    const used = held.reduce((n, h) => n + Math.max(0, Math.min(h.ended_at ?? at, at, d.end) - Math.max(h.held_since, d.start)), 0);
    return { team_id: team.id, team_name: team.name, daily_hours: team.daily_hours, used_ms: used, left_ms: team.daily_hours == null ? null : Math.max(0, team.daily_hours * HOUR_MS - used), resets_at: d.end, day: d.date };
  }
  private teamAllowance(machineId: string, c: Compute, teamId: string, at: number): Allowance | null {
    const t = c.teams.find((x) => x.id === teamId);
    return t ? this.allowanceOf(machineId, c.timezone, t, at) : null;
  }
  /** Why the machine cannot go to this entry now, or null when it can: paused, closed, or too few of its team's hours left. */
  private blocked(r: ComputeRow, c: Compute, e: { team_id: string; estimate_minutes: number | null }, at: number): 'paused' | 'closed' | 'allowance' | null {
    if (r.paused_at) return 'paused';
    if (!availability(c, at).now) return 'closed';
    const a = this.teamAllowance(r.machine_id, c, e.team_id, at);
    if (a && a.left_ms !== null && (a.left_ms <= 0 || (e.estimate_minutes != null && e.estimate_minutes * 60_000 > a.left_ms))) return 'allowance';
    return null;
  }

  // ───── The list: sweep, promote, watch, remove ─────

  private name(machineId: string): string { return this.keys.machine(machineId)?.name ?? machineId; }
  private endHold(seq: number, how: string): void {
    this.db.prepare('UPDATE hw_holds SET ended_at=?, ended=? WHERE seq=? AND ended_at IS NULL').run(this.now(), how, seq);
  }
  /** Raises a flag of this kind on the hold, at most once per hold and kind (a cleared one is not raised again). */
  private flag(machineId: string, h: { seq: number; agent_id: string; task_id: string; held_since: number | null }, kind: FlagKind, reason: 'task' | 'access' | null, detail: 'memory' | 'cpus' | null = null): boolean {
    const id = `hwf_${randomToken(8)}`;
    const n = this.db.prepare('INSERT OR IGNORE INTO hw_flags(id,machine_id,agent_id,task_id,kind,reason,detail,hold_seq,held_since,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, machineId, h.agent_id, h.task_id, kind, reason, detail, h.seq, h.held_since, this.now()).changes;
    if (n) this.audit.event({ kind: 'system', id: null }, 'hardware.flag', { kind: 'agent', id: h.agent_id }, { machine: machineId, flag: id, kind, reason, ...(detail ? { limit: detail } : {}) });
    return !!n;
  }

  /** Remove entries that lost their task or access (a holder raises a lost flag), promote the first eligible entry if none
     holds, then warn or flag a holder that is running out of its window or its team's allowance. */
  sweep(machineId: string, skipNotice: string | null = null): void {
    tx(this.db, () => {
      const sys: Actor = { kind: 'system', id: null };
      for (const r of this.rows(machineId)) {
        const why = this.lost(r); if (!why) continue;
        this.db.prepare('DELETE FROM hw_queue WHERE seq=?').run(r.seq);
        const held = r.held_since !== null, m = this.name(machineId);
        this.audit.event(sys, 'hardware.remove', { kind: 'agent', id: r.agent_id }, { machine: machineId, task: r.task_id, reason: why, held });
        this.keys.notify(r.agent_id, 'hardware_removed', `You were taken off ${m}'s waiting list because you ${why === 'task' ? 'no longer have the task you joined with' : 'no longer have access to it'}.${held ? ' Stop using the machine now.' : ''}`);
        if (held) { this.endHold(r.seq, why); this.flag(machineId, r, 'lost', why); }
      }
      this.promote(machineId, skipNotice);
      this.watch(machineId);
    });
  }
  /** The hub's 30 s upkeep (app.ts): every machine with a list is swept, so a lost entry goes, a window that opens or an
     allowance that resets gives the machine to the next eligible entry, and a holder is warned and flagged, without
     waiting for someone to read the list. */
  private retained = 0;
  sweepAll(): void {
    if (this.now() - this.retained >= HOUR_MS) { this.retained = this.now(); this.retain(); }
    const ids = (this.db.prepare('SELECT DISTINCT machine_id FROM hw_queue').all() as { machine_id: string }[]).map((r) => r.machine_id);
    for (const id of ids) this.sweep(id);
  }
  private promote(machineId: string, skipNotice: string | null): void {
    if (this.db.prepare('SELECT 1 FROM hw_queue WHERE machine_id=? AND held_since IS NOT NULL').get(machineId)) return;
    const r = this.computeRow(machineId); if (!r) return;
    const c = this.compute(r), now = this.now();
    for (const e of this.db.prepare('SELECT * FROM hw_queue WHERE machine_id=? ORDER BY seq').all(machineId) as unknown as EntryRow[]) {
      const why = this.blocked(r, c, e, now);
      if (why === 'paused' || why === 'closed') return;
      if (why) continue; // Its team's hours do not cover it: it keeps its place, and the next eligible entry moves up.
      this.db.prepare('UPDATE hw_queue SET held_since=?, estimate_until=?, warned_window=NULL, warned_day=NULL WHERE seq=?').run(now, e.estimate_minutes ? now + e.estimate_minutes * 60_000 : null, e.seq);
      this.db.prepare('INSERT OR REPLACE INTO hw_holds(seq,machine_id,agent_id,team_id,task_id,joined_at,held_since) VALUES (?,?,?,?,?,?,?)').run(e.seq, machineId, e.agent_id, e.team_id, e.task_id, e.joined_at, now);
      this.audit.event({ kind: 'system', id: null }, 'hardware.hold', { kind: 'agent', id: e.agent_id }, { machine: machineId, task: e.task_id });
      if (e.agent_id !== skipNotice) this.keys.notify(e.agent_id, 'hardware_hold', `You now hold ${this.name(machineId)} for task ${e.task_id}. Use it within the limits hw_list shows, report progress with hw_report, and call hw_leave when you are done or stop.`);
      return;
    }
  }
  /** The holder's window and allowance: a notice 10 minutes before either ends, a flag once it has (the hold stays). */
  private watch(machineId: string): void {
    const h = this.db.prepare('SELECT * FROM hw_queue WHERE machine_id=? AND held_since IS NOT NULL').get(machineId) as unknown as EntryRow | undefined;
    const r = this.computeRow(machineId);
    if (!h || !r) return;
    const c = this.compute(r), at = this.now(), m = this.name(machineId), tz = c.timezone;
    const inMin = (t: number) => plural(Math.max(1, Math.ceil((t - at) / 60_000)), 'minute');
    if (c.windows.length) {
      const a = availability(c, at);
      if (a.now && a.ends_at !== null && a.ends_at - at <= WARN_MS && h.warned_window !== a.ends_at) {
        this.db.prepare('UPDATE hw_queue SET warned_window=? WHERE seq=?').run(a.ends_at, h.seq);
        this.keys.notify(h.agent_id, 'hardware_window_ending', `${m}'s window ends at ${a.until} (${tz}), in ${inMin(a.ends_at)}. Finish and call hw_leave before then; after it, the operator sees your hold flagged.`);
      }
      if (!a.now && this.flag(machineId, h, 'window', null)) this.keys.notify(h.agent_id, 'hardware_flagged', `${m}'s window has ended and you still hold it. Finish now and call hw_leave; the operator sees your hold flagged.`);
    }
    const al = this.teamAllowance(machineId, c, h.team_id, at);
    if (al && al.left_ms !== null && al.daily_hours !== null) {
      if (al.left_ms > 0 && al.left_ms <= WARN_MS && h.warned_day !== al.day) {
        this.db.prepare('UPDATE hw_queue SET warned_day=? WHERE seq=?').run(al.day, h.seq);
        this.keys.notify(h.agent_id, 'hardware_allowance_ending', `${al.team_name}'s ${al.daily_hours} h on ${m} today run out in ${inMin(at + al.left_ms)}. Finish and call hw_leave before then; after that, the operator sees your hold flagged.`);
      }
      if (al.left_ms <= 0 && this.flag(machineId, h, 'allowance', null)) this.keys.notify(h.agent_id, 'hardware_flagged', `${al.team_name} has used its ${al.daily_hours} h on ${m} today and you still hold it. Finish now and call hw_leave; the operator sees your hold flagged.`);
    }
  }

  // ───── Measuring (step 2, docs/hardware.md#measuring) ─────

  /** The connector's samples for its machine: refused unless the machine offers compute and its user turned measuring on;
     a sample more than 5 minutes from the hub's clock is dropped. Each kept sample is tied by its time to the hold that
     covered it (or to none), adds to that hold's and that local day's summary, and runs the over-limit check. */
  ingest(machineId: string, samples: SampleIn[]): { accepted: number; duplicates: number; skewed: number } {
    const r = this.computeRow(machineId);
    if (!r) throw new KeyError('invalid_state', 'This PC does not offer compute, so the hub takes no hardware samples from it.');
    const opt = (this.db.prepare('SELECT hardware_opt_in FROM connector_reports WHERE machine_id=?').get(machineId) as { hardware_opt_in: number | null } | undefined)?.hardware_opt_in;
    if (opt !== 1) throw new KeyError('forbidden', "Measuring is off on this machine. Its user turns it on with `conclave hardware on`; the hub takes no samples until the connector's check-in says so.");
    const now = this.now(), c = this.compute(r);
    const ok = samples.filter((s) => Math.abs(s.at - now) <= SKEW_MS).sort((a, b) => a.at - b.at);
    if (!ok.length) throw new KeyError('invalid_argument', "Every sample is more than 5 minutes from the hub's clock. Set this PC's clock, then try again.");
    let accepted = 0;
    tx(this.db, () => {
      for (const s of ok) {
        const gpus = s.gpus ?? [];
        const hold = this.db.prepare('SELECT seq, agent_id, task_id, held_since FROM hw_holds WHERE machine_id=? AND held_since<=? AND (ended_at IS NULL OR ended_at>?) ORDER BY held_since DESC LIMIT 1')
          .get(machineId, s.at, s.at) as { seq: number; agent_id: string; task_id: string; held_since: number } | undefined;
        const n = this.db.prepare('INSERT OR IGNORE INTO hw_samples(machine_id,at,cpu_pct,cpu_count,mem_used_gb,mem_total_gb,gpus,hold_seq) VALUES (?,?,?,?,?,?,?,?)')
          .run(machineId, s.at, s.cpu_pct, s.cpu_count ?? null, s.mem_used_gb, s.mem_total_gb, JSON.stringify(gpus), hold?.seq ?? null).changes;
        if (!n) continue;
        accepted++;
        const gpu = gpus.length ? gpus.reduce((a, g) => a + g.util_pct, 0) / gpus.length : null, gpuMem = gpus.reduce((a, g) => a + g.mem_used_gb, 0);
        const cpus = s.cpu_count ? (s.cpu_pct / 100) * s.cpu_count : null;
        this.db.prepare(`INSERT INTO hw_use_days(machine_id,date,held,n,cpu_sum,cpu_peak,mem_sum,mem_peak,gpu_n,gpu_sum,gpu_peak) VALUES (?,?,?,1,?,?,?,?,?,?,?)
            ON CONFLICT(machine_id,date,held) DO UPDATE SET n=n+1, cpu_sum=cpu_sum+excluded.cpu_sum, cpu_peak=MAX(cpu_peak,excluded.cpu_peak), mem_sum=mem_sum+excluded.mem_sum,
              mem_peak=MAX(mem_peak,excluded.mem_peak), gpu_n=gpu_n+excluded.gpu_n, gpu_sum=gpu_sum+excluded.gpu_sum, gpu_peak=MAX(gpu_peak,excluded.gpu_peak)`)
          .run(machineId, localDay(c.timezone, s.at).date, hold ? 1 : 0, s.cpu_pct, s.cpu_pct, s.mem_used_gb, s.mem_used_gb, gpu === null ? 0 : 1, gpu ?? 0, gpu ?? 0);
        if (!hold) continue;
        const u = this.db.prepare('SELECT * FROM hw_hold_use WHERE hold_seq=?').get(hold.seq) as unknown as HoldUseRow | undefined;
        // A gap of more than 3 minutes in the samples restarts the over-limit clock: the hub cannot tell what happened in it.
        const gap = !u || s.at - u.last_at > GAP_MS;
        const memOver = c.memory_gb != null && s.mem_used_gb > c.memory_gb, cpuOver = c.cpus != null && cpus !== null && cpus > c.cpus;
        const memSince = memOver ? (gap ? s.at : u!.mem_over_since ?? s.at) : null, cpuSince = cpuOver ? (gap ? s.at : u!.cpu_over_since ?? s.at) : null;
        if (!u) {
          this.db.prepare(`INSERT INTO hw_hold_use(hold_seq,machine_id,n,first_at,last_at,cpu_sum,cpu_peak,cpus_peak,mem_sum,mem_peak,gpu_n,gpu_sum,gpu_peak,gpu_mem_peak,mem_over_since,cpu_over_since)
              VALUES (?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(hold.seq, machineId, s.at, s.at, s.cpu_pct, s.cpu_pct, cpus, s.mem_used_gb, s.mem_used_gb, gpu === null ? 0 : 1, gpu ?? 0, gpu ?? 0, gpuMem, memSince, cpuSince);
        } else {
          this.db.prepare(`UPDATE hw_hold_use SET n=n+1, first_at=MIN(first_at,?), last_at=MAX(last_at,?), cpu_sum=cpu_sum+?, cpu_peak=MAX(cpu_peak,?), cpus_peak=MAX(COALESCE(cpus_peak,0),COALESCE(?,0)),
              mem_sum=mem_sum+?, mem_peak=MAX(mem_peak,?), gpu_n=gpu_n+?, gpu_sum=gpu_sum+?, gpu_peak=MAX(gpu_peak,?), gpu_mem_peak=MAX(gpu_mem_peak,?), mem_over_since=?, cpu_over_since=? WHERE hold_seq=?`)
            .run(s.at, s.at, s.cpu_pct, s.cpu_pct, cpus, s.mem_used_gb, s.mem_used_gb, gpu === null ? 0 : 1, gpu ?? 0, gpu ?? 0, gpuMem, memSince, cpuSince, hold.seq);
        }
        // Over a declared limit for 2 minutes: one flag per hold, worded as the machine's use. Nothing is stopped.
        for (const [since, detail] of [[memSince, 'memory'], [cpuSince, 'cpus']] as const) {
          if (since === null || s.at - since < OVER_MS) continue;
          if (this.flag(machineId, hold, 'limit', null, detail)) {
            this.keys.notify(hold.agent_id, 'hardware_flagged', `${this.name(machineId)} went over its declared ${detail === 'memory' ? 'memory' : 'CPU'} limit during your hold. The hub stops nothing; the operator sees your hold flagged. Keep within the machine's limits.`);
          }
        }
      }
    });
    return { accepted, duplicates: ok.length - accepted, skewed: samples.length - ok.length };
  }

  /** Raw samples go after 7 days; hold and day summaries after 400 days, whether or not the machine still offers compute. */
  retain(): { samples: number; holds: number; days: number } {
    const now = this.now();
    const samples = this.db.prepare('DELETE FROM hw_samples WHERE at<?').run(now - RAW_KEEP_MS).changes;
    const holds = this.db.prepare('DELETE FROM hw_hold_use WHERE last_at<?').run(now - SUMMARY_KEEP_MS).changes;
    const days = this.db.prepare('DELETE FROM hw_use_days WHERE date<?').run(new Date(now - SUMMARY_KEEP_MS).toISOString().slice(0, 10)).changes;
    return { samples: Number(samples), holds: Number(holds), days: Number(days) };
  }

  /** What the console shows about measuring a machine: the opt-in as last reported, whether people use it too, and its
     latest sample when it is under 3 minutes old. Never part of what agents read. */
  private measure(r: ComputeRow, at: number) {
    const rep = this.db.prepare('SELECT hardware_opt_in, last_check_in_at FROM connector_reports WHERE machine_id=?').get(r.machine_id) as { hardware_opt_in: number | null; last_check_in_at: number } | undefined;
    const s = this.db.prepare('SELECT * FROM hw_samples WHERE machine_id=? ORDER BY at DESC LIMIT 1').get(r.machine_id) as unknown as SampleRow | undefined;
    const live = s && at - s.at <= LIVE_MS ? { at: s.at, cpu_pct: s.cpu_pct, cpu_count: s.cpu_count, mem_used_gb: s.mem_used_gb, mem_total_gb: s.mem_total_gb, gpus: JSON.parse(s.gpus) as GpuIn[] } : null;
    return { connector: !!rep, opt_in: rep ? (rep.hardware_opt_in === null ? null : rep.hardware_opt_in === 1) : null, shared_with_people: r.shared_with_people === 1, live, last_at: s?.at ?? null };
  }
  /** The machine's average and peak use during each of these holds (absent for a hold with no samples). */
  private holdUse(seqs: number[]): Map<number, HoldUse> {
    const m = new Map<number, HoldUse>();
    if (!seqs.length) return m;
    for (const u of this.db.prepare(`SELECT * FROM hw_hold_use WHERE hold_seq IN (${seqs.map(() => '?').join(',')})`).all(...seqs) as unknown as HoldUseRow[]) m.set(u.hold_seq, useOf(u));
    return m;
  }
  /** Use over the local days of the period, while held and with no holder, from the day summaries of these machines. */
  private periodUse(ids: string[], from: number, to: number, tz: string) {
    const out = { held: null as UseSum | null, idle: null as UseSum | null };
    if (!ids.length) return out;
    const rows = this.db.prepare(`SELECT * FROM hw_use_days WHERE machine_id IN (${ids.map(() => '?').join(',')}) AND date>=? AND date<=?`)
      .all(...ids, localDay(tz, from).date, localDay(tz, to).date) as unknown as UseDayRow[];
    for (const k of ['held', 'idle'] as const) {
      const rs = rows.filter((x) => x.held === (k === 'held' ? 1 : 0)), n = rs.reduce((a, x) => a + x.n, 0), gn = rs.reduce((a, x) => a + x.gpu_n, 0);
      if (!n) continue;
      out[k] = { samples: n, cpu_avg: rs.reduce((a, x) => a + x.cpu_sum, 0) / n, cpu_peak: Math.max(...rs.map((x) => x.cpu_peak)), mem_avg_gb: rs.reduce((a, x) => a + x.mem_sum, 0) / n,
        mem_peak_gb: Math.max(...rs.map((x) => x.mem_peak)), gpu_avg: gn ? rs.reduce((a, x) => a + x.gpu_sum, 0) / gn : null, gpu_peak: gn ? Math.max(...rs.map((x) => x.gpu_peak)) : null };
    }
    return out;
  }

  // ───── History and analysis ─────

  /** Holds that overlap [from, to), newest first, with every flag each one raised. */
  holds(from: number, to: number, machineId: string | null = null): Hold[] {
    const rows = this.db.prepare(`SELECT h.*, m.name machine_name, a.label, COALESCE(t.name, h.team_id) team_name, k.title task_title FROM hw_holds h
        JOIN machines m ON m.id=h.machine_id JOIN agents a ON a.id=h.agent_id LEFT JOIN teams t ON t.id=h.team_id LEFT JOIN tasks k ON k.id=h.task_id
      WHERE h.held_since<? AND (h.ended_at IS NULL OR h.ended_at>?) AND (? IS NULL OR h.machine_id=?) ORDER BY h.held_since DESC, h.seq DESC`)
      .all(to, from, machineId, machineId) as unknown as (Omit<Hold, 'flags' | 'task_title'> & { task_title: string | null })[];
    const flags = new Map<number, FlagKind[]>();
    for (const f of this.db.prepare(`SELECT f.hold_seq, f.kind FROM hw_flags f JOIN hw_holds h ON h.seq=f.hold_seq
        WHERE h.held_since<? AND (h.ended_at IS NULL OR h.ended_at>?) ORDER BY f.created_at`).all(to, from) as { hold_seq: number; kind: FlagKind }[]) {
      flags.set(f.hold_seq, [...(flags.get(f.hold_seq) ?? []), f.kind]);
    }
    return rows.map((r) => ({ ...r, task_title: r.task_title ?? '', flags: flags.get(r.seq) ?? [] }));
  }

  /** Minutes held per weekday and local hour over the 7 days before `at`, in the machine's timezone (the week grid). */
  private week(tz: string, holds: Hold[], at: number): number[][] {
    const g = DAYS.map(() => Array<number>(24).fill(0)), from = at - 7 * 24 * HOUR_MS;
    for (const h of holds) {
      const b = Math.min(h.ended_at ?? at, at);
      for (let t = Math.max(h.held_since, from); t < b;) {
        const l = local(tz, t), next = Math.min(b, t + ((60 - l.mi) * 60 - l.s) * 1000 - (((t % 1000) + 1000) % 1000));
        g[l.day]![l.h]! += (next - t) / 60_000; t = next;
      }
    }
    return g.map((d) => d.map((x) => Math.round(x)));
  }

  /** The analysis of these holds over [from, to): hours per local day and team, the share of open time held, waits,
     flagged holds and the top tasks. Days are local days in `tz`; open time comes from each machine's own hours. */
  analyse(holds: Hold[], machines: { id: string; c: Compute }[], from: number, to: number, tz: string) {
    const iv = (h: Hold): [number, number] => [Math.max(h.held_since, from), Math.min(h.ended_at ?? to, to)];
    const days: { date: string; label: string; start: number; end: number; teams: Record<string, number> }[] = [];
    for (let d = localDay(tz, from); d.start < to; d = localDay(tz, d.end)) {
      days.push({ date: d.date, label: `${DAY_NAME[dayAt(local(tz, d.start + HOUR_MS).day)]} ${Number(d.date.slice(8))}`, start: d.start, end: d.end, teams: {} });
    }
    const teams = new Map<string, { id: string; name: string; ms: number }>(), tasks = new Map<string, { task_id: string | null; task_title: string; team_id: string; team_name: string; ms: number }>();
    let held = 0;
    for (const h of holds) {
      const [a, b] = iv(h); if (b <= a) continue;
      for (const d of days) { const x = Math.max(0, Math.min(b, d.end) - Math.max(a, d.start)); if (x) d.teams[h.team_id] = (d.teams[h.team_id] ?? 0) + x; }
      held += b - a;
      const t = teams.get(h.team_id) ?? { id: h.team_id, name: h.team_name, ms: 0 }; t.ms += b - a; teams.set(h.team_id, t);
      const k = h.task_id ?? `-${h.seq}`, tk = tasks.get(k) ?? { task_id: h.task_id, task_title: h.task_title, team_id: h.team_id, team_name: h.team_name, ms: 0 }; tk.ms += b - a; tasks.set(k, tk);
    }
    let open = 0, heldOpen = 0;
    for (const m of machines) {
      const o = openIntervals(m.c, from, to);
      open += span(o);
      heldOpen += overlap(holds.filter((h) => h.machine_id === m.id).map(iv).filter(([a, b]) => b > a), o);
    }
    const waits = holds.filter((h) => h.held_since >= from).map((h) => h.held_since - h.joined_at).sort((a, b) => a - b), n = waits.length;
    return {
      from, to, tz, held_ms: held, holds: holds.length,
      teams: [...teams.values()].sort((a, b) => b.ms - a.ms),
      days: days.map((d) => ({ date: d.date, label: d.label, teams: d.teams })),
      open_ms: open, held_open_ms: heldOpen, share: open ? heldOpen / open : null,
      waits: { n, median_ms: n ? (n % 2 ? waits[(n - 1) / 2]! : (waits[n / 2 - 1]! + waits[n / 2]!) / 2) : null, longest_ms: n ? waits[n - 1]! : null },
      flagged: holds.filter((h) => h.flags.length).length,
      top_tasks: [...tasks.values()].sort((a, b) => b.ms - a.ms).slice(0, 5),
    };
  }

  // ───── Operator ─────

  overview(o: { period?: Period; tz?: string | null; filter?: HoldFilter } = {}) {
    const ids = (this.db.prepare('SELECT machine_id FROM hw_machines').all() as { machine_id: string }[]).map((r) => r.machine_id);
    for (const id of ids) this.sweep(id);
    const at = this.now(), period: Period = o.period ?? '7d', from = at - PERIODS[period], tz = o.tz && validTimezone(o.tz) ? o.tz : 'UTC', f = o.filter ?? {};
    const all = this.holds(from, at), q = f.q?.trim().toLowerCase() || '';
    const match = (h: Hold, skip = '') => (skip === 'machine' || !f.machine || h.machine_id === f.machine) && (skip === 'team' || !f.team || h.team_id === f.team)
      && (skip === 'agent' || !f.agent || h.agent_id === f.agent) && (!q || [h.label, h.team_name, h.task_title, h.report ?? '', h.machine_name].some((x) => x.toLowerCase().includes(q)));
    // Each chip counts the holds the other filters leave, so a chip says what picking it would show.
    const facet = (dim: 'machine' | 'team' | 'agent', id: (h: Hold) => string, name: (h: Hold) => string) => {
      const m = new Map<string, { id: string; name: string; n: number }>();
      for (const h of all) { const k = id(h), e = m.get(k) ?? { id: k, name: name(h), n: 0 }; if (match(h, dim)) e.n++; m.set(k, e); }
      return [...m.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
    };
    const facets = { machine: facet('machine', (h) => h.machine_id, (h) => h.machine_name), team: facet('team', (h) => h.team_id, (h) => h.team_name), agent: facet('agent', (h) => h.agent_id, (h) => h.label) };
    const use = this.holdUse(all.map((h) => h.seq));
    for (const h of all) h.use = use.get(h.seq) ?? null;
    const shown = all.filter((h) => match(h));
    const scope: { id: string; c: Compute }[] = [];
    const machines = (this.db.prepare('SELECT h.*, m.name, m.status pc_status, m.os FROM hw_machines h JOIN machines m ON m.id=h.machine_id ORDER BY m.name').all() as unknown as (ComputeRow & { name: string; pc_status: string; os: string | null })[])
      .map((r) => {
        const c = this.compute(r), list = this.entries(r.machine_id), mine = shown.filter((h) => h.machine_id === r.machine_id);
        if (!f.machine || f.machine === r.machine_id) scope.push({ id: r.machine_id, c });
        const flags = this.db.prepare(`SELECT f.id, f.kind, f.reason, f.detail, u.mem_peak, u.cpus_peak, f.agent_id, a.label, f.task_id, k.title task_title, COALESCE(k.team_id, h.team_id) team_id, t.name team_name, f.held_since, f.created_at
            FROM hw_flags f JOIN agents a ON a.id=f.agent_id LEFT JOIN tasks k ON k.id=f.task_id LEFT JOIN hw_holds h ON h.seq=f.hold_seq LEFT JOIN teams t ON t.id=h.team_id LEFT JOIN hw_hold_use u ON u.hold_seq=f.hold_seq
          WHERE f.machine_id=? AND f.cleared_at IS NULL ORDER BY f.created_at`).all(r.machine_id);
        return {
          id: r.machine_id, name: r.name, pc_status: r.pc_status, os: r.os, ...c, paused: r.paused_at !== null, paused_at: r.paused_at,
          shared_with_people: r.shared_with_people === 1, measure: this.measure(r, at),
          availability: availability(c, at), allowances: c.teams.map((t) => this.allowanceOf(r.machine_id, c.timezone, t, at)),
          holder: list.find((e) => e.holder) ?? null, waiting: list.filter((e) => !e.holder), flags,
          what_ran: mine, week: this.week(c.timezone, this.holds(at - 7 * 24 * HOUR_MS, at, r.machine_id), at),
          analysis: { ...this.analyse(mine, [{ id: r.machine_id, c }], from, at, c.timezone), use: this.periodUse([r.machine_id], from, at, c.timezone) }, updated_at: r.updated_at,
        };
      });
    const pcs = this.db.prepare("SELECT id, name, status FROM machines WHERE status<>'retired' AND id NOT IN (SELECT machine_id FROM hw_machines) ORDER BY name").all() as { id: string; name: string; status: string }[];
    const counts = { machines: machines.length, in_use: machines.filter((m) => m.holder).length, waiting: machines.reduce((n, m) => n + m.waiting.length, 0), holds: all.length, shown: shown.length };
    return { at, period, from, tz, counts, facets, analysis: { ...this.analyse(shown, scope, from, at, tz), use: this.periodUse(scope.map((m) => m.id), from, at, tz) }, machines, pcs };
  }

  private check(c: ComputeIn): ComputeIn {
    const access = c.access.trim();
    if (!access || access.length > 500) throw bad('Access: an SSH alias or instructions, 1 to 500 characters.');
    if (!validTimezone(c.timezone)) throw bad('Timezone: an IANA name such as Europe/Lisbon.');
    if (c.windows.length > 14) throw bad('Opening hours: at most 14 windows.');
    for (const w of c.windows) {
      if (!w.days.length || w.days.some((d) => !DAYS.includes(d))) throw bad('Opening hours: each window needs at least one weekday.');
      if (!HHMM.test(w.from) || !HHMM.test(w.to) || w.from === '24:00' || w.from === w.to) throw bad('Opening hours: times are HH:MM, and a window cannot start and end at the same time.');
    }
    if (c.memory_gb != null && !(c.memory_gb > 0 && c.memory_gb <= 100_000)) throw bad('Memory: a positive number of GB.');
    if (c.cpus != null && !(Number.isInteger(c.cpus) && c.cpus > 0 && c.cpus <= 100_000)) throw bad('CPUs: a whole number above 0.');
    if (c.gpu != null && c.gpu.length > 120) throw bad('GPU: at most 120 characters.');
    if (c.notes != null && c.notes.length > 1000) throw bad('Notes: at most 1000 characters.');
    for (const h of Object.values(c.allowances ?? {})) if (h != null && !(h >= 0.25 && h <= 24)) throw bad('Daily allowance: between 0.25 and 24 hours a day, or no limit.');
    const hit = this.guard.scan({ access, gpu: c.gpu ?? '', notes: c.notes ?? '' });
    if (hit) throw bad('Access, GPU and notes must not contain a key or credential. Keep credentials on the machine or in its SSH setup.');
    const teams = [...new Set(c.teams)];
    for (const t of teams) if (!this.db.prepare('SELECT 1 FROM teams WHERE id=?').get(t)) throw new KeyError('not_found', `No team ${t}.`);
    return { ...c, access, teams, gpu: c.gpu?.trim() || null, notes: c.notes?.trim() || null };
  }

  register(machineId: string, input: ComputeIn, actor: Actor): void {
    const pc = this.keys.machine(machineId);
    if (!pc || pc.status === 'retired') throw new KeyError('not_found', 'No such PC.');
    const c = this.check(input), now = this.now(), had = !!this.computeRow(machineId);
    tx(this.db, () => {
      if (had) this.db.prepare('UPDATE hw_machines SET access=?, timezone=?, windows=?, memory_gb=?, cpus=?, gpu=?, notes=?, shared_with_people=COALESCE(?,shared_with_people), updated_at=? WHERE machine_id=?')
        .run(c.access, c.timezone, JSON.stringify(c.windows), c.memory_gb ?? null, c.cpus ?? null, c.gpu ?? null, c.notes ?? null, c.shared_with_people == null ? null : c.shared_with_people ? 1 : 0, now, machineId);
      else this.db.prepare('INSERT INTO hw_machines(machine_id,access,timezone,windows,memory_gb,cpus,gpu,notes,shared_with_people,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(machineId, c.access, c.timezone, JSON.stringify(c.windows), c.memory_gb ?? null, c.cpus ?? null, c.gpu ?? null, c.notes ?? null, c.shared_with_people ? 1 : 0, now, now);
      // A team the input names no allowance for keeps the one it had.
      const prev = new Map((this.db.prepare('SELECT team_id, daily_hours FROM hw_machine_teams WHERE machine_id=?').all(machineId) as { team_id: string; daily_hours: number | null }[]).map((r) => [r.team_id, r.daily_hours]));
      this.db.prepare('DELETE FROM hw_machine_teams WHERE machine_id=?').run(machineId);
      const hours = (t: string) => (c.allowances && t in c.allowances ? c.allowances[t] ?? null : prev.get(t) ?? null);
      for (const t of c.teams) this.db.prepare('INSERT INTO hw_machine_teams(machine_id,team_id,daily_hours) VALUES (?,?,?)').run(machineId, t, hours(t));
      this.audit.event(actor, had ? 'hardware.update' : 'hardware.register', { kind: 'pc', id: machineId },
        { timezone: c.timezone, windows: c.windows.length, teams: c.teams, allowances: Object.fromEntries(c.teams.map((t) => [t, hours(t)])) });
    });
    // A team taken off the list loses its entries now, not at the next read; new hours may open the machine to the next entry.
    this.sweep(machineId);
  }

  unregister(machineId: string, actor: Actor): { ended: number } {
    if (!this.computeRow(machineId)) throw new KeyError('not_found', 'This PC does not offer compute.');
    const m = this.name(machineId);
    return tx(this.db, () => {
      const list = this.rows(machineId);
      for (const r of list) this.keys.notify(r.agent_id, 'hardware_removed', `${m} is no longer offered for compute, so you were taken off its waiting list.${r.held_since !== null ? ' Stop using the machine now.' : ''}`);
      for (const r of list) if (r.held_since !== null) this.endHold(r.seq, 'unregistered');
      this.db.prepare('DELETE FROM hw_queue WHERE machine_id=?').run(machineId);
      // Its open flags would no longer show on the Hardware screen, which lists only machines that offer compute: they close here.
      const flags = this.db.prepare('UPDATE hw_flags SET cleared_at=?, cleared_by=? WHERE machine_id=? AND cleared_at IS NULL').run(this.now(), actor.id, machineId).changes;
      this.db.prepare('DELETE FROM hw_machine_teams WHERE machine_id=?').run(machineId);
      this.db.prepare('DELETE FROM hw_machines WHERE machine_id=?').run(machineId);
      this.audit.event(actor, 'hardware.unregister', { kind: 'pc', id: machineId }, { ended: list.length, flags_cleared: flags });
      return { ended: list.length };
    });
  }

  /** Pause: nobody new holds the machine; the holder keeps it until it leaves. Resume promotes the first eligible entry. */
  pause(machineId: string, actor: Actor): void {
    if (!this.computeRow(machineId)) throw new KeyError('not_found', 'This PC does not offer compute.');
    const n = this.db.prepare('UPDATE hw_machines SET paused_at=?, paused_by=? WHERE machine_id=? AND paused_at IS NULL').run(this.now(), actor.id, machineId).changes;
    if (n) this.audit.event(actor, 'hardware.pause', { kind: 'pc', id: machineId }, null);
  }
  resume(machineId: string, actor: Actor): void {
    if (!this.computeRow(machineId)) throw new KeyError('not_found', 'This PC does not offer compute.');
    const n = this.db.prepare('UPDATE hw_machines SET paused_at=NULL, paused_by=NULL WHERE machine_id=? AND paused_at IS NOT NULL').run(machineId).changes;
    if (n) this.audit.event(actor, 'hardware.resume', { kind: 'pc', id: machineId }, null);
    this.sweep(machineId);
  }

  removeEntry(seq: number, actor: Actor): void {
    const r = this.db.prepare('SELECT * FROM hw_queue WHERE seq=?').get(seq) as unknown as EntryRow | undefined;
    if (!r) throw new KeyError('not_found', 'That entry is no longer on the list.');
    tx(this.db, () => {
      this.db.prepare('DELETE FROM hw_queue WHERE seq=?').run(seq);
      if (r.held_since !== null) this.endHold(seq, 'removed');
      this.audit.event(actor, 'hardware.remove', { kind: 'agent', id: r.agent_id }, { machine: r.machine_id, task: r.task_id, reason: 'operator', held: r.held_since !== null });
      this.keys.notify(r.agent_id, 'hardware_removed', `The operator took you off ${this.name(r.machine_id)}'s waiting list.${r.held_since !== null ? ' Stop using the machine now.' : ''} Join again with hw_join if you still need it.`);
      this.promote(r.machine_id, null);
    });
  }

  clearFlag(id: string, actor: Actor): void {
    const r = this.db.prepare('UPDATE hw_flags SET cleared_at=?, cleared_by=? WHERE id=? AND cleared_at IS NULL').run(this.now(), actor.id, id);
    if (!r.changes) throw new KeyError('not_found', 'No open flag with that id.');
    this.audit.event(actor, 'hardware.flag_clear', { kind: 'hw_flag', id }, null);
  }

  /** What an eligible agent not yet on the list would get from hw_list, for a draft before it is saved. */
  preview(machineId: string | null, input: ComputeIn): string {
    const c = this.check(input);
    const name = machineId ? this.name(machineId) : '(new machine)';
    const row = machineId ? this.computeRow(machineId) : null;
    const list = row ? this.entries(machineId!) : [];
    const { teams: _t, allowances: _a, ...draft } = c;
    return this.render({ id: machineId ?? '', name, paused: !!row?.paused_at, ...draft }, list, null, new Set(), [], '');
  }

  // ───── Agents ─────

  /** The machines an agent may use: offered to a team it is a live member of, on an active PC. */
  /** Whether any machine is offered to one of the agent's teams: the hw_* tools are listed only then (docs/mcp.md). */
  offers(agentId: string): boolean { return this.offered(agentId).length > 0; }
  private offered(agentId: string): { id: string; name: string }[] {
    return this.db.prepare(`SELECT DISTINCT m.id, m.name FROM hw_machines h JOIN machines m ON m.id=h.machine_id
      JOIN hw_machine_teams s ON s.machine_id=h.machine_id JOIN team_members tm ON tm.team_id=s.team_id AND tm.agent_id=? AND tm.removed_at IS NULL
      JOIN teams t ON t.id=s.team_id AND t.status IN ('running','paused') WHERE m.status='active' ORDER BY m.name`).all(agentId) as { id: string; name: string }[];
  }
  private teamsOf(agentId: string): Set<string> {
    return new Set((this.db.prepare('SELECT team_id FROM team_members WHERE agent_id=? AND removed_at IS NULL').all(agentId) as { team_id: string }[]).map((r) => r.team_id));
  }
  private resolve(agentId: string, ref: string): { id: string; name: string } {
    const m = this.offered(agentId).find((x) => x.id === ref || x.name === ref);
    if (!m) throw new KeyError('not_found', NOT_OFFERED);
    return m;
  }
  /** Why a waiting agent does not hold the machine, in words, when nobody holds it. */
  private waitWhy(why: 'paused' | 'closed' | 'allowance' | null, a: Availability, al: Allowance | null, tz: string): string {
    if (why === 'paused') return 'the operator paused the machine';
    if (why === 'closed') return `the machine is closed${a.next ? ` until ${a.next} (${tz})` : ''}`;
    if (why === 'allowance' && al) return `your team has ${hoursText(al.left_ms ?? 0)} left today, less than your estimate; it resets ${localClock(tz, al.resets_at)} (${tz})`;
    return '';
  }

  /** The agent's view of one machine: header lines, then the list as it may see it, then its teams' hours today. */
  private render(m: { id: string; name: string; paused: boolean } & Omit<ComputeIn, 'teams' | 'allowances'>, list: Entry[], agentId: string | null, mine: Set<string>, hours: Allowance[], why: string): string {
    const a = availability(m, this.now()), tz = m.timezone;
    const when = m.paused ? 'Paused by the operator: nobody new gets it until it resumes'
      : a.any ? 'Open any time' : a.now ? `Open now, until ${a.until}` : `Closed${a.next ? `; the next window opens ${a.next}` : ''}`;
    const who = (e: Entry) => (e.agent_id === agentId ? 'you' : mine.has(e.team_id) ? `${e.label} (task "${e.task_title}")` : 'an agent of another team');
    const holder = list.find((e) => e.holder), waiting = list.filter((e) => !e.holder), me = list.find((e) => e.agent_id === agentId);
    const lines = [
      `${m.name}${m.id ? ` (${m.id})` : ''}: ${when} (${tz})`,
      `  Access: ${m.access}`,
      `  Opening hours: ${windowsText(m.windows)}`,
      `  Limits, declared by the operator and not measured: ${limitsText(m)}`,
      ...(m.notes ? [`  Notes: ${m.notes}`] : []),
      `  Holder: ${holder ? `${who(holder)}, since ${localClock(tz, holder.held_since!)}${holder.estimate_until ? `, estimated finish ${localClock(tz, holder.estimate_until)}` : ''}${holder.reported_at && (holder.agent_id === agentId || mine.has(holder.team_id)) ? `, last report ${localClock(tz, holder.reported_at)}: "${holder.report}"` : ''}` : 'none'}`,
      `  Waiting: ${waiting.length ? waiting.map((e, i) => `${i + 1}. ${who(e)}${e.estimate_minutes ? `, about ${e.estimate_minutes} min` : ''}`).join('; ') : 'nobody'}`,
      `  You: ${me ? (me.holder ? 'you hold it. Report with hw_report; call hw_leave when done.' : `waiting, number ${me.line} in line${why ? `: ${why}` : ''}.`) : 'not on the list. Join with hw_join {machine, task_id} when a task needs it.'}`,
      ...(hours.length ? [`  Your teams' hours today: ${hours.map((x) => (x.daily_hours == null ? `${x.team_name}, no daily limit` : `${x.team_name}, ${hoursText(x.left_ms ?? 0)} left of ${x.daily_hours} h, resets ${localClock(tz, x.resets_at)}`)).join('; ')}`] : []),
    ];
    return lines.join('\n');
  }
  private dataFor(m: { id: string; name: string }, r: ComputeRow, c: Compute, list: Entry[], agentId: string, mine: Set<string>, hours: Allowance[]) {
    const vis = (e: Entry) => (e.agent_id === agentId || mine.has(e.team_id)
      ? { agent_id: e.agent_id, label: e.label, task_id: e.task_id, task_title: e.task_title, held_since: e.held_since, estimate_until: e.estimate_until, estimate_minutes: e.estimate_minutes, report: e.report, reported_at: e.reported_at }
      : { agent_id: null, label: 'an agent of another team', held_since: e.held_since, estimate_until: e.estimate_until, estimate_minutes: e.estimate_minutes });
    const holder = list.find((e) => e.holder), me = list.find((e) => e.agent_id === agentId);
    return { id: m.id, name: m.name, access: c.access, timezone: c.timezone, windows: c.windows, availability: availability(c, this.now()), paused: r.paused_at !== null,
      allowances: hours.map((x) => ({ team_id: x.team_id, team_name: x.team_name, daily_hours: x.daily_hours, left_hours: x.left_ms === null ? null : Math.round(x.left_ms / 36_000) / 100, resets_at: x.resets_at })),
      memory_gb: c.memory_gb, cpus: c.cpus, gpu: c.gpu, notes: c.notes,
      holder: holder ? vis(holder) : null, waiting: list.filter((e) => !e.holder).map(vis), you: me ? { holder: me.holder, position: me.position, line: me.line } : null };
  }

  list(agentId: string): { text: string; data: Record<string, unknown> } {
    const mine = this.teamsOf(agentId), out: string[] = [], data: Record<string, unknown>[] = [];
    for (const m of this.offered(agentId)) {
      this.sweep(m.id);
      const r = this.computeRow(m.id); if (!r) continue;
      const c = this.compute(r), list = this.entries(m.id), at = this.now();
      const hours = c.teams.filter((t) => mine.has(t.id)).map((t) => this.allowanceOf(m.id, c.timezone, t, at));
      const me = list.find((e) => e.agent_id === agentId);
      const why = me && !me.holder && !list.some((e) => e.holder) ? this.waitWhy(this.blocked(r, c, me, at), availability(c, at), hours.find((x) => x.team_id === me.team_id) ?? null, c.timezone) : '';
      const { teams: _t, ...shown } = c;
      out.push(this.render({ ...m, paused: r.paused_at !== null, ...shown }, list, agentId, mine, hours, why));
      data.push(this.dataFor(m, r, c, list, agentId, mine, hours));
    }
    const text = out.length ? `Machines your teams may use (the hub records what holders report; it does not measure the machine):\n\n${out.join('\n\n')}` : 'No machine is offered to your teams.';
    return { text, data: { machines: data } };
  }

  join(agentId: string, ref: string, taskId: string, estimateMinutes: number | null): { holder: boolean; position: number; line: number; machine: string; why: string } {
    const m = this.resolve(agentId, ref);
    this.sweep(m.id);
    return tx(this.db, () => {
      const mine = this.db.prepare('SELECT seq FROM hw_queue WHERE machine_id=? AND agent_id=?').get(m.id, agentId);
      if (mine) throw new KeyError('conflict', `You are already on ${m.name}'s list. Call hw_list to see your place, or hw_leave first.`);
      const t = this.db.prepare('SELECT id, team_id, status, assignee_agent_id FROM tasks WHERE id=?').get(taskId) as { id: string; team_id: string; status: string; assignee_agent_id: string | null } | undefined;
      if (!t || t.assignee_agent_id !== agentId || !t.team_id) throw new KeyError('denied', 'That task is not assigned to you.');
      if (!JOIN_STATES.includes(t.status)) throw new KeyError('invalid_state', `Join with a task you can work on (assigned, in progress or changes requested); this one is ${t.status.replace(/_/g, ' ')}.`);
      const ok = this.db.prepare(`SELECT 1 FROM hw_machine_teams s JOIN team_members tm ON tm.team_id=s.team_id AND tm.agent_id=? AND tm.removed_at IS NULL
        JOIN teams tt ON tt.id=s.team_id AND tt.status IN ('running','paused') JOIN agents a ON a.id=tm.agent_id AND a.status='active' WHERE s.machine_id=? AND s.team_id=?`).get(agentId, m.id, t.team_id);
      if (!ok) throw new KeyError('denied', `${m.name} is not offered to the team of that task.`);
      const r = this.computeRow(m.id)!, c = this.compute(r), at = this.now();
      const al = this.teamAllowance(m.id, c, t.team_id, at);
      if (al && al.left_ms !== null && al.left_ms <= 0) {
        throw new KeyError('invalid_state', `${al.team_name} has used its ${al.daily_hours} h on ${m.name} today. The allowance resets at ${localClock(c.timezone, al.resets_at)} (${c.timezone}); join again then.`);
      }
      this.db.prepare('INSERT INTO hw_queue(machine_id,agent_id,team_id,task_id,joined_at,estimate_minutes) VALUES (?,?,?,?,?,?)').run(m.id, agentId, t.team_id, t.id, at, estimateMinutes);
      this.audit.event({ kind: 'agent', id: agentId }, 'hardware.join', { kind: 'pc', id: m.id }, { task: t.id, estimate_minutes: estimateMinutes });
      this.promote(m.id, agentId);
      this.watch(m.id);
      const list = this.entries(m.id), e = list.find((x) => x.agent_id === agentId)!;
      const why = !e.holder && !list.some((x) => x.holder) ? this.waitWhy(this.blocked(r, c, { team_id: t.team_id, estimate_minutes: estimateMinutes }, at), availability(c, at), al, c.timezone) : '';
      return { holder: e.holder, position: e.position, line: e.line, machine: m.name, why };
    });
  }

  report(agentId: string, ref: string, progress: string, estimateMinutes: number | null): { estimate_until: number | null; machine: string } {
    const m = this.resolve(agentId, ref);
    this.sweep(m.id);
    const e = this.entries(m.id).find((x) => x.agent_id === agentId);
    if (!e) throw new KeyError('not_found', `You are not on ${m.name}'s list.`);
    if (this.guard.scan({ progress })) throw bad('Progress must not contain a key or credential.');
    if (!e.holder) throw new KeyError('invalid_state', `Only the holder reports. You are number ${e.line} in line; you get a notice when you hold ${m.name}.`);
    const now = this.now(), until = estimateMinutes != null ? now + estimateMinutes * 60_000 : e.estimate_until;
    this.db.prepare('UPDATE hw_queue SET report=?, reported_at=?, estimate_until=? WHERE seq=?').run(progress, now, until, e.seq);
    this.db.prepare('UPDATE hw_holds SET report=?, reported_at=? WHERE seq=?').run(progress, now, e.seq);
    return { estimate_until: until, machine: m.name };
  }

  leave(agentId: string, ref: string, outcome: 'done' | 'cancelled', note: string | null): { machine: string; moved_up: boolean } {
    const m = this.resolve(agentId, ref);
    if (note && this.guard.scan({ note })) throw bad('The note must not contain a key or credential.');
    this.sweep(m.id);
    return tx(this.db, () => {
      const e = this.entries(m.id).find((x) => x.agent_id === agentId);
      if (!e) throw new KeyError('not_found', `You are not on ${m.name}'s list.`);
      this.db.prepare('DELETE FROM hw_queue WHERE seq=?').run(e.seq);
      if (e.holder) this.endHold(e.seq, outcome);
      this.audit.event({ kind: 'agent', id: agentId }, 'hardware.leave', { kind: 'pc', id: m.id }, { task: e.task_id, outcome, held: e.holder, note });
      this.promote(m.id, null);
      this.watch(m.id);
      return { machine: m.name, moved_up: e.holder && this.entries(m.id).some((x) => x.holder) };
    });
  }
}
