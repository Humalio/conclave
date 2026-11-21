/**
 * Moving an old PC to the connector (docs/onboarding.md "Moving an existing PC", review-v2 §1 point 17).
 *
 * An old PC has `keys.env` (app key, hub URL, CA path, one session variable per agent), `onboarding/state.json` (the hub,
 * its CA fingerprint and each agent's folder), per-folder `.mcp.json` entries named `agent-hub` that run the headers
 * helper, `.agent-hub.json`, and for Codex a `.codex/config.toml` that runs `codex-bridge.mjs`. `conclave migrate`
 *
 *   plan        (the default) lists what would change and what blocks it; changes nothing
 *   --apply     stops the old Codex wake, moves the keys into the key file, binds each folder, replaces its entry with the
 *               connector's, then signs every agent in through the connector. If any sign-in fails the whole move is
 *               rolled back. Then it removes the old pieces it replaced (setup.mjs, the headers helper, the Codex bridge and wake,
 *               keys.env, each folder's .agent-hub.json, onboarding/state.json); each is saved first, so --rollback restores it.
 *   --rollback  puts every file the move changed back, as long as nobody edited it since; edited files are kept and listed
 *   --finish    after a good week: forgets the rollback copies and, with --remove-legacy-ca and evidence of ownership,
 *               removes the CA environment setting the old setup wrote
 *
 * An HTTP PC moves to HTTPS only with `https` {origin, caPem, caSha256} given by the user: nothing is guessed, and the
 * connector never connects over plain HTTP afterwards. The key-file section is named by the hub's real id, which the
 * hub tells over the pinned connection (GET /connector/v1/hub) and which is keyed together with the CA fingerprint; a hub
 * that cannot say it is refused, with nothing changed. File transfers move to the app key by the same step: the old
 * stand-alone bridge (`agent-hub-bridge.mjs run`) is stopped, and the connector's service runs the transfer loop with the
 * key file's app key. This module is the only place that knows the old layout.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { X509Certificate, randomBytes } from 'node:crypto';
import { atomicWrite, canonicalFolder, readJson, sha256, pathKey, WIN } from './paths.mjs';
import { LABEL_RE, HUB_ID_RE, putHub, putAgentKey, removeAgentKey, removeHub, caFingerprint, pemBlocks, singleCaPem, normalizeOrigin, hubKeyOf, readKeyFile, findHub } from './keyfile.mjs';
import { bindFolder, unbindFolder, foldersOfHub } from './registry.mjs';
import { mcpEntry, nodePath, connectorPath, writeMcpEntry, approveInSettings, codexToml, SERVER_NAME } from './entries.mjs';
import { applyTrust } from './trust.mjs';
import { record, manifestPath } from './manifest.mjs';
import { connect, callTool, request } from './hubclient.mjs';
import { invalidateHub } from './tokens.mjs';
import { OVERRIDE, overrideState, oldOverrideBody, writeOverride } from './role.mjs';

const OLD = 'agent-hub';
const stateFile = (home) => join(home, 'migration', 'state.json');
/**
 * Where one move keeps its rollback copies: a folder of its own (`migration/backups/<run>`, named in its journal), so a
 * second run never overwrites the first run's copies. A journal from before had them in `migration/backup`.
 */
const backupDir = (home, data) => (typeof data?.backup_dir === 'string' && /^[a-z0-9-]{1,40}$/.test(data.backup_dir) ? join(home, 'migration', 'backups', data.backup_dir) : join(home, 'migration', 'backup'));

// ───────────── what an old PC looks like ─────────────
function parseEnv(text) {
  const map = new Map();
  for (const raw of String(text).split(/\r?\n/)) {
    const l = raw.trim();
    if (!l || l.startsWith('#') || !l.includes('=')) continue;
    map.set(l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim());
  }
  return map;
}
const safeSeg = (s) => String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/^\.+$/, '-').trim() || '-';
/** The old setup's files in the connector home that the move replaces (each is saved, then removed). */
const OLD_HOME_FILES = ['setup.mjs', 'agent-hub-headers.mjs', 'agent-hub-headers.py', 'codex-bridge.mjs', 'codex-wake.mjs', 'codex.mjs', 'codex-wake.json', 'keys.env', 'onboarding/state.json'];

/** Reads the old layout. Never returns a key's value in `notes`; `agents[].key` is for the move only. */
export function discover(home) {
  let env;
  try { env = parseEnv(readFileSync(join(home, 'keys.env'), 'utf8')); } catch { return { ok: false, reason: 'nothing_to_migrate' }; }
  const st = readJson(join(home, 'onboarding', 'state.json'), null);
  if (!st || typeof st !== 'object' || !st.hub) return { ok: false, reason: 'legacy_unreadable' };
  const appKey = env.get('AGENT_HUB_APP_KEY');
  if (!appKey) return { ok: false, reason: 'legacy_unreadable' };
  let hub;
  try { hub = new URL(st.hub); } catch { return { ok: false, reason: 'legacy_unreadable' }; }
  const agents = [];
  const seen = new Set();
  for (const cur of Object.values(st.requests ?? {})) {
    for (const a of cur.agents ?? []) {
      if (!a?.session_var || !a.folder || !cur.root || seen.has(a.session_var)) continue;
      seen.add(a.session_var);
      const folder = resolve(cur.root, safeSeg(cur.project ?? (cur.kind === 'vault_agent' ? 'vault-agents' : 'project')), safeSeg(a.folder));
      agents.push({ label: String(a.label ?? '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+/, '').slice(0, 64), sessionVar: a.session_var, folder, key: env.get(a.session_var) ?? null });
    }
  }
  const caFile = env.get('AGENT_HUB_CA') || join(home, 'hub-ca.pem');
  return { ok: true, hub: st.hub, origin: `${hub.protocol}//${hub.host}`, https: hub.protocol === 'https:', caSha256: st.ca_sha256 ?? null, caFile, appKey, agents };
}

/** Which old pieces a folder holds: `claude` (an `agent-hub` entry that runs the helper) and/or `codex` (the bridge). */
export function legacyPieces(folder) {
  const j = readJson(join(folder, '.mcp.json'), null);
  const e = j && typeof j === 'object' ? j.mcpServers?.[OLD] : null;
  const claude = !!e && typeof e.headersHelper === 'string' && /agent-hub-headers/.test(e.headersHelper);
  let codex = false;
  try { codex = /^\[mcp_servers\.agent_hub\]\s*$/m.test(readFileSync(join(folder, '.codex', 'config.toml'), 'utf8')); } catch { /* none */ }
  return { claude, codex };
}
export const hasLegacyEntry = (folder) => { const p = legacyPieces(folder); return p.claude || p.codex; };

/**
 * Codex agents the user's own wake config lists (`codex-wake.json`) whose project config runs the old bridge with its own
 * `--keys-file`: setup never recorded them, so `discover` cannot see them. The session variable is read from the folder's
 * `.agent-hub.json` and the key from that keys file; the key is for the move only and never printed.
 */
function wakeAgents(home, seen) {
  const j = readJson(join(home, 'codex-wake.json'), null);
  const out = [];
  for (const a of Array.isArray(j?.agents) ? j.agents : []) {
    if (!a || typeof a.workspace !== 'string' || typeof a.keys_file !== 'string') continue;
    const folder = canonicalFolder(a.workspace);
    if (!folder || seen.has(pathKey(folder))) continue;
    let toml = '';
    try { toml = readFileSync(join(folder, '.codex', 'config.toml'), 'utf8'); } catch { continue; }
    if (!/^\[mcp_servers\.agent_hub\]\s*$/m.test(toml) || !/--keys-file/.test(toml)) continue;
    const own = readJson(join(folder, '.agent-hub.json'), null);
    const sessionVar = typeof own?.session_var === 'string' ? own.session_var : a.session_var;
    let key = null;
    try { key = parseEnv(readFileSync(a.keys_file, 'utf8')).get(sessionVar) ?? null; } catch { key = null; }
    seen.add(pathKey(folder));
    out.push({ label: String(a.name ?? '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+/, '').slice(0, 64), sessionVar, folder, key, wake: true, ownKeys: basename(String(a.keys_file)) });
  }
  return out;
}

/** True while the user's wake config lists a Codex workspace: that wake stays, whether or not its folder has moved yet. */
function wakeListed(home) {
  const j = readJson(join(home, 'codex-wake.json'), null);
  return (Array.isArray(j?.agents) ? j.agents : []).some((a) => a && typeof a.workspace === 'string');
}
const FINISH_FIRST = 'A first move on this PC is not final yet, so its rollback copies would be lost if another folder were moved now. Run `conclave migrate --finish` first (if it names retired agents, remove those folders first), then run `conclave migrate` again.';

/**
 * The old layout plus the wake's own-keys-file agents. On a PC that already moved (the journal says applied or finished and
 * the key file still has that hub), the hub comes from the key file section, so only the folders still on the old layout
 * are left to move. `moved` says which.
 */
function discoverAll(home) {
  const prev = readJson(stateFile(home), null);
  const d = discover(home);
  let base = d.ok ? { ...d, moved: false } : null;
  if (prev && (prev.status === 'applied' || prev.status === 'finished' || (prev.status === 'rolled_back' && prev.own_hub === false)) && prev.hub_key) {
    const kf = readKeyFile(home);
    const sec = kf.ok ? kf.data.hubs[prev.hub_key] : null;
    if (sec) base = { unfinished: prev.status === 'applied', ok: true, moved: true, hub: sec.origin, origin: sec.origin, https: true, caSha256: sec.ca_sha256, caFile: null, caPem: sec.ca_pem, appKey: sec.app_key, hubKey: prev.hub_key, agents: d.ok ? d.agents : [] };
  }
  if (!base) return d;
  const seen = new Set(base.agents.map((a) => pathKey(canonicalFolder(a.folder) ?? a.folder)));
  const extra = wakeAgents(home, seen);
  if (base.moved && !d.ok && !extra.length) return d;
  return { ...base, agents: [...base.agents, ...extra] };
}

// ───────────── the plan ─────────────
/** `{ok, problems, steps, https}`: nothing is changed. `https` is the origin and CA the connector will pin. */
export function plan(home, { https = null } = {}) {
  // An interrupted move (a crash or a power loss) has removed some old pieces already: the plan can only be made again
  // once it is rolled back, which --apply does first.
  if (readJson(stateFile(home), null)?.status === 'applying') return { ok: true, problems: [], steps: ['an earlier move was interrupted (a crash or a power loss): --apply rolls it back first, from its own copies, then plans and makes the move again; --rollback only rolls it back'] };
  const d = discoverAll(home);
  if (!d.ok) return { ok: false, problems: [d.reason], steps: [] };
  const problems = [];
  const steps = [];
  let origin = d.origin, caPem = null, caSha = null;
  if (d.moved) { caPem = d.caPem; caSha = d.caSha256; } // a PC that already moved: the pinned hub is the key file's
  else if (d.https) {
    try { caPem = readFileSync(d.caFile, 'utf8'); caSha = caFingerprint(caPem); } catch { problems.push('ca_missing'); }
    // Exactly one certificate, stored as the parsed certificate's own PEM.
    if (caPem !== null && !caSha) problems.push(pemBlocks(caPem) > 1 ? 'ca_bundle' : 'ca_invalid'); else if (caPem !== null) caPem = singleCaPem(caPem);
    if (caSha && d.caSha256 && caSha !== d.caSha256) problems.push('ca_mismatch');
  } else if (!https) problems.push('http_needs_https');
  else {
    const o = normalizeOrigin(https.origin);
    try { caPem = https.caPem; caSha = caFingerprint(caPem); } catch { problems.push('ca_invalid'); }
    if (caPem && !caSha) problems.push(pemBlocks(caPem) > 1 ? 'ca_bundle' : 'ca_invalid'); else if (caPem) caPem = singleCaPem(caPem);
    if (!o) problems.push('https_origin_invalid'); else origin = o;
    if (caSha && caSha !== String(https.caSha256 ?? '').toLowerCase()) problems.push('ca_sha_differs_from_given');
  }
  const todo = d.agents.filter((a) => {
    if (!LABEL_RE.test(a.label)) { problems.push(`agent_label_invalid:${a.sessionVar}`); return false; }
    if (!a.key) { problems.push(`key_missing:${a.sessionVar}`); return false; }
    const f = canonicalFolder(a.folder);
    if (!f) { problems.push(`folder_missing:${a.label}`); return false; }
    const p = legacyPieces(f);
    if (!p.claude && !p.codex) { problems.push(`no_old_entry:${a.label}`); return false; }
    a.canon = f; a.pieces = p; return true;
  });
  if (!todo.length) problems.push(d.moved ? 'already_migrated' : 'no_agents_to_move');
  else if (d.unfinished) problems.push('finish_first');
  if (d.moved) steps.push('this PC already moved once: only the folders still on the old layout are moved now, the moved ones are left alone');
  if (d.https === false) steps.push(`move the hub to pinned HTTPS (${origin}); the connector never uses plain HTTP`);
  if (todo.some((a) => a.wake) || wakeListed(home)) steps.push('stop the old stand-alone file-transfer bridge if it is running; the old Codex wake keeps running, with its own config and keys file (a later task replaces it)');
  else steps.push('stop the old Codex wake and the old stand-alone file-transfer bridge if they are running (transfers then use the app key in the connector service)');
  steps.push("use the hub's own id for the key-file section (asked over the pinned connection)");
  steps.push(`copy the hub key and ${todo.length} agent key(s) into the key file`);
  for (const a of todo) steps.push(`${a.label}${a.wake ? ` (a Codex agent with its own keys file ${a.ownKeys}, found through the wake config)` : ''}: ${[a.pieces.claude && 'replace the agent-hub entry in .mcp.json', a.pieces.codex && 'replace the bridge in .codex/config.toml', a.pieces.codex && overrideState(a.canon) === 'old' && `replace the old ${OVERRIDE} with the connector's`].filter(Boolean).join(' and ')}`);
  steps.push('sign every agent in through the connector; if one fails, roll everything back');
  return { ok: !problems.some((p) => !/^(no_old_entry|key_missing|agent_label_invalid|folder_missing)/.test(p)) && todo.length > 0, problems, steps, origin, caPem, caSha, agents: todo, moved: !!d.moved, allAgents: d.agents };
}

// ───────────── the Codex wake, and the changes record ─────────────
/** Stops the old wake process named in its lock file, only if it really runs codex-wake.mjs. Returns `{stopped, pid}`. */
export function stopOldWake(home, run = spawnSync) {
  let pid = 0;
  try { pid = Number(readFileSync(join(home, 'codex-wake', 'lock'), 'utf8')) || 0; } catch { return { stopped: false, pid: 0 }; }
  if (!pid) return { stopped: false, pid: 0 };
  const cmd = WIN
    ? run('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: 'utf8' }).stdout
    : run('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' }).stdout;
  if (!/codex-wake\.mjs/.test(String(cmd ?? ''))) return { stopped: false, pid };
  if (WIN) run('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' });
  else { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
  return { stopped: true, pid };
}

/** Stops stand-alone bridges (`agent-hub-bridge.mjs run`): two loops on one PC would both take transfer jobs. Returns the pids. */
export function stopOldBridge(run = spawnSync, self = process.pid) {
  const out = WIN
    ? run('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match "agent-hub-bridge" } | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }'], { encoding: 'utf8' }).stdout
    : run('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' }).stdout;
  const pids = [];
  for (const l of String(out ?? '').split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(l);
    if (m && Number(m[1]) !== self && /agent-hub-bridge\.mjs["']?\s+run\b/.test(m[2])) pids.push(Number(m[1]));
  }
  for (const pid of pids) {
    if (WIN) run('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' });
    else { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
  }
  return pids;
}

/** The hub's own id over the pinned connection: `{id}`, or null when the hub cannot say (an older hub, or no answer). */
export async function askHubId(sec) {
  const c = connect(sec);
  if (!c.ok) return null;
  try {
    const r = await request(c.hub, 'GET', '/connector/v1/hub', { timeoutMs: 10_000 });
    if (r.status !== 200 || !HUB_ID_RE.test(String(r.json?.hub_id ?? '')) || normalizeOrigin(r.json?.origin) !== c.hub.origin) return null;
    return { id: r.json.hub_id };
  } catch { return null; }
}

class Journal {
  constructor(home) { this.home = home; this.files = []; this.n = 0; this.data = { version: 1, status: 'applying', started_at: new Date().toISOString(), backup_dir: `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`, files: [], hub_key: null, folders: [], wake: null, notes: [] }; }
  /** Saves the file as it is now (or its absence) before it is changed. */
  before(path) {
    const rec = { path, backup: null, after_sha: null };
    if (existsSync(path)) { mkdirSync(backupDir(this.home, this.data), { recursive: true }); rec.backup = `b${++this.n}.bak`; atomicWrite(join(backupDir(this.home, this.data), rec.backup), readFileSync(path), true); }
    this.data.files.push(rec); this.save(); return rec;
  }
  /** Records what the file holds after the move, so a rollback can tell whether anyone edited it since. */
  after(rec) { rec.after_sha = existsSync(rec.path) ? sha256(readFileSync(rec.path)) : null; this.save(); }
  save() { atomicWrite(stateFile(this.home), JSON.stringify(this.data, null, 2) + '\n'); }
}

const OWN_TOML_HEAD = /^# Written by Conclave setup\.mjs/;
/** Replaces the `[mcp_servers.agent_hub]` table of a setup-written project config with `block`. Null if it is not ours. */
export function replaceCodexTable(text, block) {
  if (!OWN_TOML_HEAD.test(text)) return null;
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const s = lines.findIndex((l) => /^\[mcp_servers\.agent_hub\]\s*$/.test(l));
  if (s < 0) return null;
  let e = lines.findIndex((l, i) => i > s && /^\[/.test(l));
  if (e < 0) e = lines.length;
  return [...lines.slice(0, s), ...block.trimEnd().split('\n'), '', ...lines.slice(e)].join(nl).replace(/(\r?\n)+$/, nl);
}

// ───────────── which agents are retired ─────────────
/**
 * One sign-in through the pinned connection: `'ok'`, `'retired'` (the hub says the key is revoked, suspended, expired or
 * unknown: its `key_inactive` or `denied` answer) or `'refused'` (anything else, e.g. the app key is wrong). Throws
 * with a `reason` when the hub cannot be reached. The answer is the hub's; no key is read back or printed.
 */
export async function defaultProbe(sec, key, appKey) {
  const c = connect(sec);
  if (!c.ok) throw Object.assign(new Error(c.reason), { reason: c.reason });
  const r = await callTool(c.hub, 'session_login', { session_key: key }, { Authorization: `Bearer ${appKey}` }, 10_000);
  if (r.status === 200 && typeof r.data?.session_token === 'string') {
    // The check must not leave a live session behind: the PC key allows a limited number, and the old helper's are still live.
    try { await callTool(c.hub, 'session_logout', { session_token: r.data.session_token }, { Authorization: `Bearer ${appKey}` }, 10_000); } catch { /* the session ends by itself */ }
    return 'ok';
  }
  if (r.status === 200 && (r.data?.error === 'key_inactive' || r.data?.error === 'denied')) return 'retired';
  if (r.status === 200 && r.data?.error === 'rate_limited') {
    const m = /(\d+) live sessions \(limit (\d+)\)/.exec(String(r.data.message ?? ''));
    return { verdict: 'rate_limited', live: m ? Number(m[1]) : null, limit: m ? Number(m[2]) : null };
  }
  return 'refused';
}
/** A probe answers `'ok'`, `'retired'`, `'refused'`, `{verdict: 'rate_limited', live, limit}`, or (older callers) true or false. */
const verdict = (v) => (v === true ? 'ok' : v === false ? 'refused' : v && typeof v === 'object' ? v.verdict : v);
/** The hub's own limit on this PC key's live sign-ins, in plain words and with the way out. */
const rateLine = (d) => `The hub says this PC's key has reached its limit of live sign-ins${d?.limit != null ? ` (${d.live ?? 'all'} live, at most ${d.limit})` : ''}. In the console, open Keys, this PC's key, and raise "Login limit" (up to 500), or end its old logins; then run this again.`;

/**
 * Asks the hub about each agent's key before anything changes. `{live, retired, bad}`: `retired` are skipped,
 * `bad` is the first agent the hub refused for another reason, or `{reason}` when it cannot be reached.
 */
export async function askAgents(pl, appKey, probe = defaultProbe) {
  const sec = { origin: pl.origin, ca_pem: pl.caPem, ca_sha256: pl.caSha };
  const live = [], retired = [];
  for (const a of pl.agents) {
    let raw, v;
    try { raw = await probe(sec, a.key, appKey); v = verdict(raw); } catch (e) { return { live, retired, bad: { reason: e.reason ?? 'hub_unreachable' } }; }
    if (v === 'ok') live.push(a); else if (v === 'retired') retired.push(a);
    else if (v === 'rate_limited') return { live, retired, bad: { agent: a.label, reason: 'rate_limited', rate: raw } };
    else return { live, retired, bad: { agent: a.label, reason: 'login_refused' } };
  }
  return { live, retired, bad: null };
}
const retiredLine = (a) => `${a.label} (${a.canon})`;

/** The dry run's extra lines: which agents the hub reports as retired, so apply will skip them. */
export async function dryRunRetired(home, pl, opts = {}) {
  const d = discoverAll(home);
  if (!d.ok || !pl.ok) return [];
  const r = await askAgents(pl, d.appKey, opts.probe ?? defaultProbe);
  if (r.bad?.reason === 'rate_limited') return [`${rateLine(r.bad.rate)} --apply would change nothing until then.`];
  if (r.bad?.agent) return [`the hub refused ${r.bad.agent}'s key for a reason other than retirement; --apply would change nothing`];
  if (r.bad) return [`could not ask the hub which agents are retired (${r.bad.reason}); --apply asks again`];
  return r.retired.length ? [`Retired: will be skipped (${r.retired.length}): ${r.retired.map(retiredLine).join('; ')}. Their folders stay exactly as they are.`] : ['Retired: none (the hub accepts every agent key)'];
}

// ───────────── apply ─────────────
/**
 * Moves the PC. `opts`: `https` {origin, caPem, caSha256}, `claudeJson`, `node`, `connector`, `win`, `run` (process runner
 * for the wake stop), `probe(hubSection, key)` (default: one session_login through the pinned connection).
 * Returns `{ok, rolledBack, reason, lines}`. The only network step is the sign-in probe, before any change and after.
 */
export async function migrate(home, opts = {}) {
  // A move that a crash or a power loss interrupted (its journal still says `applying`) is rolled back from its own copies
  // first, so this run starts from the PC as it was and never writes over the copies the first run saved.
  const resumed = [];
  const before = readJson(stateFile(home), null);
  if (before?.status === 'applying') {
    try { resumed.push('an earlier move was interrupted; it was rolled back first', ...rollbackFrom(home, before, { keepCopies: true }).lines); } catch (e) {
      return { ok: false, rolledBack: false, reason: 'interrupted_move', lines: [`An earlier move was interrupted and could not be rolled back (${String(e.message).slice(0, 120)}). Nothing else was changed; its copies are kept in ${backupDir(home, before)}.`] };
    }
  }
  const r = await migrateNow(home, opts);
  return resumed.length ? { ...r, lines: [...resumed, ...r.lines] } : r;
}

async function migrateNow(home, opts) {
  const pl = plan(home, opts);
  if (pl.problems.includes('finish_first')) return { ok: false, rolledBack: false, reason: 'finish_first', lines: [FINISH_FIRST] };
  if (!pl.ok) return { ok: false, rolledBack: false, reason: pl.problems.find((p) => !/^(no_old_entry|key_missing|agent_label_invalid|folder_missing)/.test(p)) ?? pl.problems[0], lines: pl.problems };
  const probe = opts.probe ?? defaultProbe;
  const d = discoverAll(home);
  const sec = { origin: pl.origin, ca_pem: pl.caPem, ca_sha256: pl.caSha };
  // 1. Before any change: ask the hub about every agent's key over the pinned connection. A retired agent (key revoked or
  //    unknown) is skipped and left exactly as it is; any other refusal, or no answer, changes nothing at all.
  const asked = await askAgents(pl, d.appKey, probe);
  if (asked.bad?.reason === 'rate_limited') return { ok: false, rolledBack: false, reason: 'rate_limited', lines: [`${rateLine(asked.bad.rate)} Nothing was changed.`] };
  if (asked.bad?.agent) return { ok: false, rolledBack: false, reason: 'login_refused', lines: [`The hub refused ${asked.bad.agent} over pinned HTTPS for a reason other than retirement; nothing was changed.`] };
  if (asked.bad) return { ok: false, rolledBack: false, reason: asked.bad.reason, lines: [`The hub could not be reached over pinned HTTPS (${asked.bad.reason}); nothing was changed.`] };
  if (!asked.live.length) return { ok: false, rolledBack: false, reason: 'all_retired', lines: [`The hub reports every agent as retired (${asked.retired.map(retiredLine).join('; ')}); nothing was changed.`] };
  pl.agents = asked.live;
  const skipped = asked.retired.map((a) => ({ label: a.label, folder: a.canon }));

  const real = await (opts.hubId ?? askHubId)(sec);
  if (!real) return { ok: false, rolledBack: false, reason: 'hub_id_unavailable', lines: ['The hub did not give its own id over the pinned connection (it may be too old for the connector); nothing was changed.'] };
  pl.hubId = real.id;
  const prevState = readJson(stateFile(home), null);
  const j = new Journal(home);
  const lines = [];
  // The folders an earlier move skipped as retired and that are still on the PC stay on the finish list.
  const carried = (prevState?.skipped ?? []).filter((s) => !skipped.some((n) => n.folder === s.folder));
  j.data.skipped = [...carried, ...skipped];
  const keepWake = d.agents.some((a) => a.wake) || wakeListed(home);
  j.data.own_hub = !pl.moved; j.data.added_agents = [];
  lines.push(`the hub's own id is ${real.id}`);
  const claudeJson = opts.claudeJson;
  try {
    const mrec = j.before(manifestPath(home));
    j.data.bridge = stopOldBridge(opts.run);
    if (j.data.bridge.length) lines.push(`stopped the old file-transfer bridge (process ${j.data.bridge.join(', ')}); transfers now run in the connector service with the app key (\`conclave service install\` if it is not installed)`);
    j.data.wake = keepWake ? { stopped: false, pid: null, kept: true } : stopOldWake(home, opts.run);
    if (keepWake) lines.push('left the old Codex wake running: it keeps its own config and keys file until it is replaced');
    if (j.data.wake.stopped) lines.push(`stopped the old Codex wake (process ${j.data.wake.pid}); start it again with \`node codex-wake.mjs run\` after a rollback`);
    const hubKey = putHub(home, { hubId: pl.hubId, origin: pl.origin, caPem: pl.caPem, appKey: d.appKey });
    j.data.hub_key = hubKey; j.save();
    const node = nodePath(opts.node), connector = connectorPath(home, opts.connector);
    for (const a of pl.agents) {
      putAgentKey(home, hubKey, a.label, a.key);
      j.data.added_agents.push(a.label); j.save();
      const f = a.canon;
      const cx = { home, claudeJson, folders: [f] };
      const entry = mcpEntry({ node, connector, folder: f });
      j.data.folders.push(f);
      if (a.pieces.claude) {
        const mcp = join(f, '.mcp.json'), set = join(f, '.claude', 'settings.json');
        const r1 = j.before(mcp), r2 = j.before(set);
        const w = writeMcpEntry(f, entry);
        const doc = readJson(mcp, {}); delete doc.mcpServers[OLD]; atomicWrite(mcp, JSON.stringify(doc, null, 2) + '\n');
        const ap = approveInSettings(f);
        j.after(r1); j.after(r2);
        record(home, { kind: 'mcp_entry', target: mcp, folder: f, pointer: `mcpServers.${SERVER_NAME}`, before: w.before, installed: w.installed }, cx);
        record(home, { kind: 'mcp_approval', target: set, folder: f, pointer: 'enabledMcpjsonServers', before: ap.before, installed: true }, cx);
      }
      if (a.pieces.codex) {
        const toml = join(f, '.codex', 'config.toml');
        const r3 = j.before(toml);
        const next = replaceCodexTable(readFileSync(toml, 'utf8'), codexToml({ node, connector, folder: f }));
        if (next === null) { lines.push(`${a.label}: .codex/config.toml was not written by setup, so it was left alone`); } else { atomicWrite(toml, next); record(home, { kind: 'codex_entry', target: toml, folder: f, pointer: `mcp_servers.${SERVER_NAME}`, before: null, installed: codexToml({ node, connector, folder: f }) }, cx); }
        j.after(r3);
      }
      // The role overlay the old codex.mjs wrote is an old piece: the connector's marked one replaces it, with the same hub text.
      if (a.pieces.codex && overrideState(f) === 'old') {
        const o = join(f, OVERRIDE), r4 = j.before(o), rx = j.before(join(f, '.git', 'info', 'exclude'));
        writeOverride(home, f, oldOverrideBody(readFileSync(o, 'utf8')), cx, { replaceOld: true });
        j.after(r4); j.after(rx);
        lines.push(`${a.label}: replaced the old ${OVERRIDE} with the connector's (the same hub text, with its marker line)`);
      }
      const binding = bindFolder(home, f, { hubId: pl.hubId, caSha256: pl.caSha, origin: pl.origin, agent: a.label, provider: a.pieces.codex && !a.pieces.claude ? 'codex' : null });
      if (claudeJson && a.pieces.claude) {
        const had = new Set(Object.keys(readJson(claudeJson, {})?.projects ?? {}));
        const t = applyTrust(claudeJson, f, binding, { win: opts.win });
        for (const k of Object.keys(readJson(claudeJson, {})?.projects ?? {})) if (!had.has(k)) (j.data.trust ??= []).push({ file: claudeJson, key: k });
        j.save();
        if (t.wrote) lines.push(`${a.label}: restored the folder trust entry that had gone missing`);
        else if (t.action === 'ask') lines.push(`${a.label}: folder trust needs you (${t.reason}); run \`conclave repair\``);
      }
      lines.push(`${a.label}: moved (${[a.pieces.claude && 'Claude Code', a.pieces.codex && 'Codex'].filter(Boolean).join(' and ')})`);
    }
    // 2. After the move: every agent signs in through the connector's own key file.
    const kf = readKeyFile(home); const found = kf.ok ? findHub(kf.data, pl.hubId, pl.caSha) : { ok: false };
    for (const a of pl.agents) {
      let ok = false, rate = null;
      try {
        if (found.ok && found.section.agents?.[a.label]?.session_key) { const raw = await probe(found.section, found.section.agents[a.label].session_key, d.appKey); ok = verdict(raw) === 'ok'; if (verdict(raw) === 'rate_limited') rate = raw; }
      } catch { ok = false; }
      if (!ok) throw Object.assign(new Error('probe'), { agent: a.label, rate });
    }
    // 3. Everything signs in: the old pieces this move replaced go, each saved first so --rollback restores it.
    // Once every live agent has moved (a retired one does not count), the old shared pieces go. A wake that stays keeps its own
    // files, its bridge, and each of its folders' .agent-hub.json (it reads them), so those are not removed.
    const unmoved = pl.problems.filter((p) => /^(key_missing|agent_label_invalid)/.test(p)).length;
    if (unmoved === 0) {
      const gone = [];
      const keep = new Set(keepWake ? ['codex-wake.mjs', 'codex.mjs', 'codex-wake.json', 'codex-bridge.mjs'] : []);
      for (const p of [...OLD_HOME_FILES.filter((n) => !keep.has(n)).map((n) => join(home, n)), ...pl.agents.filter((a) => !a.wake).map((a) => join(a.canon, '.agent-hub.json'))]) {
        if (!existsSync(p)) continue;
        const r = j.before(p); r.removed = true; rmSync(p, { force: true }); j.after(r); gone.push(p.slice(home.length + 1) === p ? basename(p) : p.slice(home.length + 1));
      }
      lines.push(gone.length ? `removed the old pieces: ${gone.join(', ')} (saved for \`conclave migrate --rollback\` until \`--finish\`)` : 'no old pieces to remove');
    } else lines.push('some agents were not moved, so the old pieces were left for them');
    for (const s of skipped) lines.push(`skipped retired agent ${s.label} (${s.folder}): the hub says its key is revoked or unknown; its folder, .mcp.json and key lines are exactly as they were`);
    j.after(mrec);
    j.data.status = 'applied'; j.data.finished_at = new Date().toISOString(); j.save();
    lines.push(`signed ${pl.agents.length} agent(s) in through the connector (\`conclave migrate --rollback\` undoes this)`);
    return { ok: true, rolledBack: false, reason: null, skipped, lines };
  } catch (e) {
    const rb = rollbackFrom(home, j.data);
    if (e.rate) return { ok: false, rolledBack: true, reason: 'rate_limited', lines: [`${rateLine(e.rate)} The whole move was rolled back.`, ...rb.lines] };
    return { ok: false, rolledBack: true, reason: e.agent ? 'login_refused' : 'move_failed', lines: [e.agent ? `${e.agent} could not sign in through the connector; the whole move was rolled back.` : `The move failed (${String(e.message).slice(0, 120)}); it was rolled back.`, ...rb.lines] };
  }
}

// ───────────── rollback and finish ─────────────
function rollbackFrom(home, data, { keepCopies = false } = {}) {
  const lines = [];
  for (const rec of [...data.files].reverse()) {
    const now = existsSync(rec.path) ? sha256(readFileSync(rec.path)) : null;
    if (rec.after_sha !== null && now !== rec.after_sha) { lines.push(`kept ${rec.path}: it was edited after the move`); continue; }
    if (rec.removed && rec.after_sha === null && now !== null) { lines.push(`kept ${rec.path}: a new file was put there after the move`); continue; }
    if (rec.after_sha === null && rec.backup === null && now === null) continue;
    if (rec.backup) atomicWrite(rec.path, readFileSync(join(backupDir(home, data), rec.backup)));
    else rmSync(rec.path, { force: true });
  }
  for (const f of data.folders ?? []) { try { unbindFolder(home, f); } catch { /* not bound */ } }
  // folder-trust entries this move added to the user's ~/.claude.json: only those keys go, nothing else in that file is touched
  const trustFiles = new Map();
  for (const { file, key } of data.trust ?? []) trustFiles.set(file, [...(trustFiles.get(file) ?? []), key]);
  for (const [file, keys] of trustFiles) {
    const doc = readJson(file, null);
    if (!doc?.projects) continue;
    for (const key of keys) delete doc.projects[key];
    atomicWrite(file, JSON.stringify(doc, null, 2) + '\n');
  }
  if (data.hub_key && data.own_hub === false) { for (const l of data.added_agents ?? []) removeAgentKey(home, data.hub_key, l); invalidateHub(home, data.hub_key); }
  else if (data.hub_key) { removeHub(home, data.hub_key); invalidateHub(home, data.hub_key); }
  lines.push('the old entries and keys are back as they were; the connector\'s key-file section and bindings for this move are gone');
  if (data.bridge?.length) lines.push('the old file-transfer bridge was stopped by the move and is not restarted for you (`node agent-hub-bridge.mjs run`)');
  if (data.wake?.stopped) lines.push('the old Codex wake was stopped by the move and is not restarted for you');
  data.status = 'rolled_back'; data.rolled_back_at = new Date().toISOString();
  atomicWrite(stateFile(home), JSON.stringify(data, null, 2) + '\n');
  // An interrupted move's copies stay until --finish: the run that follows it never writes over them.
  if (!keepCopies) rmSync(backupDir(home, data), { recursive: true, force: true });
  return { lines };
}

/** `conclave migrate --rollback`. */
export function rollback(home) {
  const data = readJson(stateFile(home), null);
  // `applying` is a move a crash or a power loss interrupted: it is rolled back from its own copies like a finished one.
  if (!data || (data.status !== 'applied' && data.status !== 'applying')) return { ok: false, reason: 'nothing_to_roll_back', lines: [] };
  const r = rollbackFrom(home, data);
  return { ok: true, reason: null, lines: r.lines };
}

/** A user-level environment variable (the old setup's NODE_EXTRA_CA_CERTS): Windows registry or the process environment. */
export const defaultUserEnv = {
  get(name) {
    if (!WIN) return process.env[name] ?? null;
    const r = spawnSync('reg', ['query', 'HKCU\\Environment', '/v', name], { encoding: 'utf8' });
    const m = /REG_(?:EXPAND_)?SZ\s+(.*)\r?$/m.exec(r.stdout ?? '');
    return m ? m[1].trim() : null;
  },
  unset(name) { if (WIN) spawnSync('reg', ['delete', 'HKCU\\Environment', '/v', name, '/f'], { encoding: 'utf8' }); },
};

/** True when the old setup's `hub-ca.pem` still holds the CA this move pinned (the key file has the move's section and its fingerprint matches). */
function caFileIsPinned(home, data) {
  try { const kf = readKeyFile(home); return !!(kf.ok && data?.hub_key && kf.data.hubs[data.hub_key] && new X509Certificate(readFileSync(join(home, 'hub-ca.pem'), 'utf8')).fingerprint256.replace(/:/g, '').toLowerCase() === kf.data.hubs[data.hub_key].ca_sha256); } catch { return false; }
}

/**
 * `conclave migrate --finish`: forgets the rollback copies. With `removeLegacyCa` it also removes NODE_EXTRA_CA_CERTS, but
 * only if its value is exactly the old setup's `hub-ca.pem` and that file still holds the CA this move pinned (the key
 * file has the section this move made, and the file's fingerprint is its CA); otherwise it says what it left. It does not
 * look for other programs that read the variable, which is why it needs the user's `--remove-legacy-ca`.
 */
export function finish(home, { removeLegacyCa = false, userEnv = defaultUserEnv } = {}) {
  const data = readJson(stateFile(home), null);
  // A move that is already finished can still have the old CA setting removed, when the user asks for it.
  const again = !!data && data.status === 'finished' && removeLegacyCa;
  if (!data || (data.status !== 'applied' && !again)) return { ok: false, reason: 'nothing_to_finish', lines: [] };
  // A retired agent the move skipped still holds the old entry: --finish waits until its folder is removed (or its old
  // agent-hub entry is), because the rollback copies are the only way back to the old shared pieces it still uses.
  const left = again ? [] : (data.skipped ?? []).filter((s) => { const f = canonicalFolder(s.folder); return f && hasLegacyEntry(f); });
  if (left.length) return { ok: false, reason: 'retired_agents_remain', lines: [`these retired agents were skipped and their folders are still on this PC: ${left.map((s) => `${s.label} (${s.folder})`).join('; ')}`, 'remove those folders (they have no live key), then run `conclave migrate --finish` again'] };
  const lines = [];
  if (!again) {
    data.status = 'finished'; data.finished_at = new Date().toISOString();
    // every run's copies go, an interrupted run's kept ones too
    rmSync(backupDir(home, data), { recursive: true, force: true });
    rmSync(join(home, 'migration', 'backups'), { recursive: true, force: true });
    atomicWrite(stateFile(home), JSON.stringify(data, null, 2) + '\n');
    lines.push('the rollback copies were removed; the move can no longer be undone');
  }
  const val = userEnv.get('NODE_EXTRA_CA_CERTS');
  const caFile = join(home, 'hub-ca.pem');
  if (!val) lines.push('no NODE_EXTRA_CA_CERTS setting found');
  else if (!removeLegacyCa) lines.push('NODE_EXTRA_CA_CERTS is set and was left; run with --remove-legacy-ca to remove it if setup wrote it');
  else if (pathKey(val) !== pathKey(caFile)) lines.push('NODE_EXTRA_CA_CERTS points to a file the old setup did not write, so it was left');
  else {
    if (!caFileIsPinned(home, data)) lines.push('NODE_EXTRA_CA_CERTS was left: its file is not the CA this move pinned');
    else { userEnv.unset('NODE_EXTRA_CA_CERTS'); lines.push('removed NODE_EXTRA_CA_CERTS (it named the old setup\'s hub-ca.pem); open programs keep the old value until restarted'); }
  }
  return { ok: true, reason: null, lines };
}

export const migrationState = (home) => readJson(stateFile(home), null);
export { hubKeyOf };

/**
 * Whether this PC still holds pieces of the old setup that `conclave migrate --finish` (with `--remove-legacy-ca`) would clear:
 * the rollback copies of a move that is not finished, or NODE_EXTRA_CA_CERTS still naming the old setup's `hub-ca.pem`. It
 * answers yes or no and never a path (the check-in carries only this flag). A user environment read that fails counts as no.
 */
export function legacyLeftovers(home, userEnv = defaultUserEnv) { return legacyLeftoverKinds(home, userEnv).length > 0; }

/** The kinds `legacyLeftoverKinds` names: fixed words, so the hub and the console can say what to clean without a path. */
export const LEFTOVER_KINDS = ['unfinished_move', 'ca_setting', 'old_keys', 'bridge_pieces'];
const OLD_BRIDGE_PIECES = ['setup.mjs', 'agent-hub-headers.mjs', 'agent-hub-headers.py', 'codex-bridge.mjs', 'codex-wake.mjs', 'codex.mjs', 'codex-wake.json', 'agent-hub-bridge.mjs'];

/**
 * Which kinds of the old setup this PC still holds, in the order of `LEFTOVER_KINDS` (empty: none): an unfinished move (rollback
 * copies, or an interrupted move), the old CA setting, the old setup's key file, the old bridge and helper files. Never a path.
 */
export function legacyLeftoverKinds(home, userEnv = defaultUserEnv) {
  const kinds = [];
  const data = readJson(stateFile(home), null);
  if (data && (data.status === 'applied' || data.status === 'applying')) kinds.push('unfinished_move');
  // Only a setting that `--finish --remove-legacy-ca` would really clear counts: a variable naming a file that is not the CA this move pinned is left alone by it, so reporting it would repeat for ever.
  try { const v = userEnv.get('NODE_EXTRA_CA_CERTS'); if (v && pathKey(v) === pathKey(join(home, 'hub-ca.pem')) && caFileIsPinned(home, data)) kinds.push('ca_setting'); } catch { /* unreadable: not reported */ }
  if (existsSync(join(home, 'keys.env'))) kinds.push('old_keys');
  if (OLD_BRIDGE_PIECES.some((f) => existsSync(join(home, f)))) kinds.push('bridge_pieces');
  return kinds;
}

/** What `conclave check` says about the leftovers, in plain words, or null when there are none. It only offers the command; it never runs it. */
export function leftoversOffer(home, userEnv = defaultUserEnv) {
  const kinds = legacyLeftoverKinds(home, userEnv);
  if (!kinds.length) return null;
  const data = readJson(stateFile(home), null);
  if (!kinds.includes('unfinished_move') && !kinds.includes('ca_setting')) return 'The old setup\'s files (its key file or its bridge and helper files) are still in the connector folder. `conclave migrate` lists what moving to the connector would change; Conclave never runs it for you.';
  if (data?.status === 'applying') return 'A move to the connector on this PC was interrupted. Run `conclave migrate --apply` again to complete it, or `conclave migrate --rollback` to undo it. Afterwards `conclave migrate --finish --remove-legacy-ca` clears the old setup\'s leftovers; Conclave never runs it for you.';
  return data?.status === 'applied'
    ? 'This PC still keeps the old setup\'s rollback copies, and may still set the old CA environment variable (NODE_EXTRA_CA_CERTS). Once everything has worked for a while, `conclave migrate --finish --remove-legacy-ca` deletes the copies (you can no longer undo the move) and removes that variable if the old setup wrote it. Conclave never runs it for you.'
    : 'The old setup\'s CA environment variable (NODE_EXTRA_CA_CERTS) still points at its old certificate file. `conclave migrate --finish --remove-legacy-ca` removes it if the old setup wrote it. Conclave never runs it for you.';
}
