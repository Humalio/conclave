/**
 * Setup with the connector (docs/onboarding.md, "With the Conclave connector"): after pairing, `conclave setup` files the
 * team request, waits for the operator's one approval, picks up the agents' keys straight into the hub's section of
 * keys.json, builds and registers each agent's folder, confirms the pickup, and shows each agent as Waiting for approval,
 * Ready to open or Connected, with the way to open it. There is no transport question (always the connector's pinned
 * HTTPS) and nothing in the operating system's certificate store.
 *
 * Progress is kept per hub in onboarding/<hub id>.json, with no secret in it, so Continue setup resumes after the screen
 * or the PC was closed, and Retry rebuilds one agent without touching the others. Nothing here prints or returns a key.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { readJson, atomicWrite, canonicalFolder, WIN, oneLine } from './paths.mjs';
import { readKeyFile, putAgentKey, LABEL_RE } from './keyfile.mjs';
import { pickupApproved, requestPickup, spendPickup, pickupDenied, allowWithPickup, allowOwnPickup } from './approvals.mjs';
import { isHardened } from './isolation.mjs';
import { connect, request } from './hubclient.mjs';
import { registerFolder } from './register.mjs';
import { record } from './manifest.mjs';
import { rerecord } from './registry.mjs';
import { OVERRIDE, overrideState, writeOverride } from './role.mjs';
import { codexToml, nodePath, connectorPath, gitPath } from './entries.mjs';
import { gitState } from './git.mjs';
import { validateRequest, shellQuote, summary } from './request.mjs';

export const statePath = (home, hubId) => join(home, 'onboarding', `${hubId}.json`);
export const defaultRoot = () => join(homedir(), 'Conclave');
const safeSeg = (s) => String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/^\.+$/, '-').trim() || '-';
const isCodex = (client) => /codex/i.test(String(client ?? ''));

/** What a person reads for each state of an agent. */
export const AGENT_STATES = {
  waiting_for_approval: 'Waiting for your administrator',
  waiting_for_allow: 'Waiting for your Allow',
  picking_up: 'Picking up keys',
  ready_to_open: 'Ready to open',
  connected: 'Connected',
  key_refused: 'Key refused by the hub',
  failed: 'Setup failed',
};
export const DESKTOP_LINE = 'In Claude Desktop, start a new Code session in this folder; the chat shows under that folder.';

class SetupError extends Error { constructor(reason, message, extra = {}) { super(message); this.reason = reason; Object.assign(this, extra); } }

// ───────────── the hub ─────────────

function hubOf(home, hubKey) {
  const kf = readKeyFile(home);
  if (!kf.ok) throw new SetupError(kf.reason, 'The key file cannot be used.');
  const section = kf.data.hubs[hubKey];
  if (!section) throw new SetupError('not_paired', 'This PC is not paired with that hub yet.');
  const c = connect(section);
  if (!c.ok) throw new SetupError(c.reason, 'The hub connection cannot be made.');
  return { section, hub: c.hub };
}

async function call(home, hubKey, method, path, body, timeoutMs = 20_000) {
  const { section, hub } = hubOf(home, hubKey);
  let r;
  try { r = await request(hub, method, path, { body, timeoutMs, headers: { Authorization: `Bearer ${section.app_key}` } }); } catch (e) { throw new SetupError(e.reason ?? 'hub_unreachable', 'The hub cannot be reached from this PC.'); }
  if (r.status >= 200 && r.status < 300) return r.json ?? {};
  throw new SetupError(r.json?.error ?? `http_${r.status}`, oneLine(r.json?.message ?? `The hub answered ${r.status}.`), { hub: r.json, status: r.status });
}

/** The hub key's section id (the hub's own id) for the state file name. */
function hubIdOf(home, hubKey) { return hubOf(home, hubKey).section.hub_id; }

// ───────────── state (no secrets) ─────────────

export function loadSetup(home, hubId) {
  const s = readJson(statePath(home, hubId), null);
  return s && typeof s === 'object' && s.version === 1 ? s : { version: 1, hub_id: hubId, request: null, agents: [] };
}
function save(home, s) { atomicWrite(statePath(home, s.hub_id), JSON.stringify(s, null, 2) + '\n'); }

// ───────────── the request ─────────────

/**
 * `conclave setup request --file <path> [--check]`: checks the request with the same rules as the hub, then files it.
 * `{ok, problems?, summary, request_id?, state?}`.
 */
export async function fileRequest(home, hubKey, body, { check = false, root } = {}) {
  const problems = validateRequest(body);
  if (problems.length) return { ok: false, problems };
  if (check) return { ok: true, summary: summary(body) };
  const hubId = hubIdOf(home, hubKey);
  const s = loadSetup(home, hubId);
  if (s.request && !s.request.done && !['denied', 'withdrawn', 'cancelled'].includes(s.request.state)) return { ok: false, problems: [{ field: 'request', rule: 'a request is already in progress on this PC for this hub; continue setup or withdraw it first' }] };
  const res = await call(home, hubKey, 'POST', '/onboard/requests', body);
  s.hub_key = hubKey;
  s.request = { id: res.request_id, kind: res.kind ?? body.kind ?? 'new_team', client: body.client?.app ?? 'claude-code', project: body.project?.name ?? null, team_name: body.team?.name ?? body.agent?.name ?? null, state: res.state, version: res.version, root: resolve(root ?? defaultRoot()) };
  s.agents = [];
  delete s.pickup_id; delete s.confirmed;
  save(home, s);
  return { ok: true, request_id: res.request_id, state: res.state, summary: summary(body) };
}

/** `conclave setup choices`: what this PC may ask for, as the hub answers it (a PC code: the projects and teams; an invite: the invite). Nothing is stored. */
export async function choices(home, hubKey) { return call(home, hubKey, 'GET', '/onboard/choices'); }

/**
 * `conclave setup redeem <invite id>`: redeems a collaborator's invite. The hub checks it again and files an approved request for this PC;
 * the request is kept as this PC's own, so setup carries on from it (the pickup needs no click). The only choice made here is the local folder.
 * `{ok: true, request_id, state}`, or `{ok: false, reason: 'invite_refused', message}` with the hub's plain reason.
 */
export async function redeemInvite(home, hubKey, inviteId, { root, client = 'claude-code', invite = null } = {}) {
  const hubId = hubIdOf(home, hubKey);
  const s = loadSetup(home, hubId);
  if (s.request && !s.request.done && !['denied', 'withdrawn', 'cancelled', 'collected'].includes(s.request.state)) return { ok: false, reason: 'request_in_progress', message: 'A request is already in progress on this PC for this hub; continue setup first.' };
  let res;
  try { res = await call(home, hubKey, 'POST', `/onboard/invites/${encodeURIComponent(inviteId)}/redeem`, {}); } catch (e) { if (e.reason === 'invite_refused') return { ok: false, reason: 'invite_refused', message: oneLine(e.message ?? '') }; throw e; }
  s.hub_key = hubKey;
  s.request = { id: res.request_id, kind: 'add_agents', client, project: invite?.project ?? res.project ?? null, team_name: invite?.team?.name ?? res.team_name ?? null, state: res.state, version: res.version, root: resolve(root ?? defaultRoot()) };
  s.agents = [];
  delete s.pickup_id; delete s.confirmed;
  save(home, s);
  return { ok: true, request_id: res.request_id, state: res.state };
}

/**
 * `conclave setup withdraw`: withdraws this PC's request for this hub, so a new one can be filed. That includes a request
 * an earlier Re-enrol reopened for a new pickup, which setup could not finish (docs/onboarding.md, Re-enrol): agents that
 * already joined their team stay. Answers `{ok, request_id?, state?, reason?}`; `reason` is `no_request` when there is none.
 */
export async function withdrawRequest(home, hubKey) {
  const s = loadSetup(home, hubIdOf(home, hubKey));
  if (!s.request) return { ok: false, reason: 'no_request' };
  if (['denied', 'withdrawn', 'cancelled'].includes(s.request.state)) return { ok: true, request_id: s.request.id, state: s.request.state, already: true };
  const st = await call(home, hubKey, 'POST', `/onboard/requests/${encodeURIComponent(s.request.id)}/withdraw`, {});
  s.request.state = st.state ?? 'withdrawn'; s.request.version = st.version ?? s.request.version;
  delete s.pickup_id; delete s.confirmed;
  save(home, s);
  return { ok: true, request_id: s.request.id, state: s.request.state };
}

// ───────────── one step of setup ─────────────

const folderOf = (s, a) => resolve(s.request.root, safeSeg(s.request.project ?? (s.request.kind === 'vault_agent' ? 'vault-agents' : 'project')), safeSeg(a.folder));

/** The agent's label in keys.json and the registry: its folder name when that is a valid label, else its variable. */
function localLabel(a, taken) {
  let base = LABEL_RE.test(String(a.folder ?? '')) ? String(a.folder) : String(a.session_var ?? 'agent').replace(/[^A-Za-z0-9_-]/g, '_').replace(/^[^A-Za-z0-9]+/, '').slice(0, 60) || 'agent';
  let label = base, i = 2;
  while (taken.has(label)) label = `${base.slice(0, 58)}-${i++}`;
  return label;
}

/**
 * Builds one agent's folder and registers it: the folder, git with everything excluded (when git is there), the
 * connector's MCP entry, approval and folder trust, all in the manifest. A Claude Code agent gets its instructions as
 * CLAUDE.md (if there is none). A Codex agent gets the layout a restored one gets (docs/connector.md "Codex folders"):
 * its binding marked Codex, so its local server offers the commit tool; the role file AGENTS.override.md with its marker,
 * listed in .git/info/exclude with the connector's other files; and .codex/config.toml. An AGENTS.md there is left as it is.
 */
export function buildAgent(home, s, a, { claudeJson, node, connector, win = WIN, gitBin } = {}) {
  const dir = folderOf(s, a);
  // Only a folder that is new or empty when built is allowed with the pickup; one that already holds files waits for its own click.
  const fresh = !existsSync(dir) || readdirSync(dir).length === 0;
  mkdirSync(dir, { recursive: true });
  const { section } = hubOf(home, s.hub_key);
  const codex = isCodex(a.client ?? s.request.client);
  // An override the connector did not write (someone else's, or the old Codex setup's) is never replaced: stop before writing anything.
  if (codex) {
    const st = overrideState(dir);
    if (st === 'old') throw new Error(`This folder holds an ${OVERRIDE} from the old Codex setup. Run conclave migrate (it replaces it), then Retry.`);
    if (st === 'unmarked') throw new Error(`This folder holds an ${OVERRIDE} that Conclave did not write, and setup never overwrites it. Move it away, then Retry.`);
  }
  const reg = registerFolder(home, dir, { hubId: section.hub_id, caSha256: section.ca_sha256, agent: a.label, agentId: a.agent_id, claudeJson, node, connector, win, provider: codex ? 'codex' : null, team: s.request.team_id ? { id: s.request.team_id, name: s.request.team_name } : null });
  const folder = reg.folder, cx = { home, claudeJson, folders: [folder] };
  const md = join(folder, 'CLAUDE.md');
  if (!codex && !existsSync(md) && a.instructions) {
    const text = a.instructions.endsWith('\n') ? a.instructions : a.instructions + '\n';
    writeFileSync(md, text);
    // The hash of what setup wrote: a removal deletes the file only while it still holds exactly that.
    record(home, { kind: 'instructions', target: md, folder, pointer: null, before: null, installed: { sha256: createHash('sha256').update(text).digest('hex') } }, cx);
  }
  if (codex) {
    const toml = join(folder, '.codex', 'config.toml');
    const before = existsSync(toml) ? readFileSync(toml, 'utf8') : null;
    if (before === null || !/\[mcp_servers\.conclave\]/.test(before)) {
      mkdirSync(join(folder, '.codex'), { recursive: true });
      const entry = codexToml({ node: nodePath(node), connector: connectorPath(home, connector), folder });
      writeFileSync(toml, (before ? before.replace(/\n?$/, '\n\n') : '') + entry);
      record(home, { kind: 'codex_entry', target: toml, folder, pointer: 'mcp_servers.conclave', before: null, installed: entry }, cx);
    }
  }
  const git = gitBin === undefined ? gitPath(home) : gitBin;
  if (git) {
    if (!existsSync(join(folder, '.git'))) execFileSync(git, ['init', '-q', folder], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 60_000 });
    const ex = join(folder, '.git', 'info', 'exclude');
    mkdirSync(join(folder, '.git', 'info'), { recursive: true });
    const cur = existsSync(ex) ? readFileSync(ex, 'utf8') : '';
    if (!cur.split(/\r?\n/).includes('*')) {
      writeFileSync(ex, (cur && !cur.endsWith('\n') ? cur + '\n' : cur) + '*\n');
      record(home, { kind: 'git_exclude', target: ex, folder, pointer: null, before: null, installed: '*' }, cx);
    }
  }
  // After git init, so the role file and the connector's files are listed in .git/info/exclude as in a restored clone.
  // The connector wrote these files itself: record the folder's settings as they now are, so check sees no change.
  if (codex) writeOverride(home, folder, a.instructions ?? '', cx);
  // Last, after every write above (CLAUDE.md included): the folder's settings as they now are, so `conclave check` sees no change.
  rerecord(home, folder);
  // Last of all, after the registry entry and the settings are final: the pickup the PC user allowed also allows the first chat here.
  if (fresh && s.pickup_id) allowWithPickup(home, folder, { agent: a.label, agent_id: a.agent_id, hub_id: section.hub_id, ref: s.pickup_id });
  return folder;
}

/**
 * One step of setup, from wherever it stopped. `waitS` long-polls the request (0: answer at once). Answers
 * `{phase, ...}`: `no_request`, `waiting`, `changes` (the operator's note), `closed`, `collision`, or `set_up` with the
 * agents built (and any that failed, each with its reason).
 */
export async function advance(home, hubKey, { waitS = 0, claudeJson, node, connector, win = WIN, gitBin } = {}) {
  const s = loadSetup(home, hubIdOf(home, hubKey));
  s.hub_key = hubKey;
  if (!s.request) return { phase: 'no_request' };
  if (!s.confirmed) {
    const st = await call(home, hubKey, 'GET', `/onboard/requests/${encodeURIComponent(s.request.id)}?wait_s=${Math.max(0, Math.min(45, waitS))}`, undefined, (waitS + 20) * 1000);
    s.request.state = st.state; s.request.version = st.version; s.request.team_name = st.team_name ?? s.request.team_name;
    if (st.project) s.request.project = typeof st.project === 'string' ? st.project : st.project.name ?? s.request.project;
    save(home, s);
    if (st.state === 'submitted') return { phase: 'waiting', stage: 'admin', filed_at: st.filed_at ?? null };
    if (st.state === 'needs_changes') return { phase: 'changes', note: st.operator_note ?? null };
    if (['denied', 'withdrawn', 'cancelled'].includes(st.state)) return { phase: 'closed', state: st.state, note: st.operator_note ?? null };
    if (st.state === 'collected' && !s.pickup_id) throw new SetupError('collected_elsewhere', 'The hub says these keys were already collected, but not by this PC\'s setup. Ask the administrator to re-enrol this PC.');
    if (st.state === 'approved' && (!s.pickup_id || s.keys_written_for !== s.pickup_id)) {
      // At the standard level a pickup hands over session keys, and the platform store opens for any process of this user: the PC's user clicks first.
      if (!pickupApproved(home, hubKey, s.request.id) && pickupDenied(home, hubKey, s.request.id)) return { phase: 'waiting', stage: 'allow', declined: true, note: 'Declined on this PC. The PC user can still allow it on the connector screen.' };
      // A request this PC filed picks up its keys by itself, with no click; at Hardened the PC user's click stays, since the keys are not theirs to open.
      const what = `session keys for the approved team request ${s.request.team_name ?? s.request.id}`, where = (st.agents ?? []).map((x) => ({ agent: x.label ?? x.folder, path: folderOf(s, x) }));
      if (!pickupApproved(home, hubKey, s.request.id) && !isHardened(home)) allowOwnPickup(home, hubKey, s.request.id, what, where);
      if (!pickupApproved(home, hubKey, s.request.id)) { requestPickup(home, hubKey, s.request.id, `session keys for the approved team request ${s.request.team_name ?? s.request.id}`, (st.agents ?? []).map((x) => ({ agent: x.label ?? x.folder, path: folderOf(s, x) }))); return { phase: 'waiting', stage: 'allow', pickup_click: true }; }
      const { section } = hubOf(home, hubKey);
      const taken = new Set(Object.keys(section.agents ?? {}));
      const p = await call(home, hubKey, 'POST', '/onboard/pickup', { request_id: s.request.id });
      s.pickup_id = p.pickup_id;
      s.request.team_name = p.team?.name ?? s.request.team_name;
      if (p.team?.id) s.request.team_id = p.team.id;
      s.agents = p.agents.map((a) => {
        const label = localLabel(a, taken);
        taken.add(label);
        return { agent_id: a.agent_id, label, hub_label: a.label, role: a.role, team_role: a.team_role, session_var: a.session_var, folder: a.folder, client: s.request.client, instructions: a.instructions ?? null, built: false, error: null };
      });
      save(home, s); // the list first (no secrets), then the keys: a crash here re-picks up
      for (let i = 0; i < p.agents.length; i++) { putAgentKey(home, hubKey, s.agents[i].label, p.agents[i].secret); p.agents[i].secret = undefined; }
      s.keys_written_for = s.pickup_id;
      save(home, s);
    }
    for (const a of s.agents) if (!a.built) tryBuild(home, s, a, { claudeJson, node, connector, win, gitBin });
    save(home, s);
    if (st.state === 'approved') {
      try {
        await call(home, hubKey, 'POST', '/onboard/pickup/confirm', { pickup_id: s.pickup_id, written: s.agents.map((a) => a.session_var), transport: 'https' });
      } catch (e) {
        if (e.reason === 'invalid_state' && /pickup again/i.test(e.message)) { s.pickup_id = null; s.keys_written_for = null; save(home, s); return advance(home, hubKey, { waitS: 0, claudeJson, node, connector, win, gitBin }); }
        throw e;
      }
    }
    s.confirmed = true; s.request.state = 'collected';
    // The click covers this request until it is confirmed (docs/connector.md "Clicks": once per request), so a crash between
    // pickup and confirm, or a pickup the hub replaced, picks up again without asking the PC user twice. Spent here.
    spendPickup(home, hubKey, s.request.id);
    save(home, s);
  } else {
    for (const a of s.agents) if (!a.built) tryBuild(home, s, a, { claudeJson, node, connector, win, gitBin });
    save(home, s);
  }
  return { phase: 'set_up', built: s.agents.filter((a) => a.built).map((a) => a.label), failed: s.agents.filter((a) => !a.built).map((a) => ({ label: a.label, error: a.error })) };
}

function tryBuild(home, s, a, opts) {
  try { a.dir = buildAgent(home, s, a, opts); a.built = true; a.error = null; } catch (e) { a.built = false; a.error = oneLine(e.message ?? String(e)).slice(0, 300); }
}

/** Retry for one agent: rebuilds only its folder and registration. `{ok, error?}`. */
export function retryAgent(home, hubKey, label, opts = {}) {
  const s = loadSetup(home, hubIdOf(home, hubKey));
  s.hub_key = hubKey;
  const a = s.agents.find((x) => x.label === label);
  if (!a) return { ok: false, error: 'No agent of that name in this setup.' };
  tryBuild(home, s, a, opts);
  save(home, s);
  return a.built ? { ok: true } : { ok: false, error: a.error };
}

// ───────────── what the screen shows ─────────────

const startMsg = (a, team) => `You are ${a.hub_label ?? a.label}, ${a.role} of ${team ?? 'your team'}. Call directives_read {unread: true, ack: true}, then session_whoami, team_info, task_list and message_read, then follow your playbook.`.replace(/["'`$\\]/g, '');

/** The ways to open one agent: the folder for Claude Desktop, and one command each for a terminal and for Codex. */
export function openWays(dir, a, team, win = WIN) {
  const msg = startMsg(a, team);
  const cd = win ? `cd ${shellQuote(dir, true)}; ` : `cd ${shellQuote(dir, false)} && `;
  return {
    desktop: { folder: dir, line: DESKTOP_LINE },
    terminal: `${cd}claude ${win ? `"${msg}"` : shellQuote(msg, false)}`,
    codex: `codex -C ${shellQuote(dir, win)} ${win ? `"${msg}"` : shellQuote(msg, false)}`,
  };
}

/**
 * The agents' rows: each with its state (Waiting for approval, Ready to open, Connected, Key refused by the hub, or Setup
 * failed with the reason and Retry), and the ways to open it. Connected and Key refused come from the hub
 * (`/connector/v1/setup`), the rest from this PC. With no answer from the hub, no agent is shown as Connected.
 */
export async function agentRows(home, hubKey, { win = WIN, env = process.env } = {}) {
  const s = loadSetup(home, hubIdOf(home, hubKey));
  let tl = null;
  let hub = null;
  try { tl = await call(home, hubKey, 'GET', '/connector/v1/setup'); } catch (e) { tl = null; hub = e.status === 401 || e.status === 403 ? 'key_refused' : 'unreachable'; }
  const hubAgents = new Map((tl?.agents ?? []).filter((x) => x.agent_id).map((x) => [x.agent_id, x]));
  const git = gitState(home, { env, win, codex: isCodex(s.request?.client) });
  if (!s.agents.length) {
    // Until the keys are written an agent is not "ready to open", whatever the hub says: it waits for the administrator, for this PC's Allow, or for the pickup.
    const early = !!s.request && !s.confirmed;
    const approved = early && s.request.state === 'approved';
    const local = (x) => (!early || x.state === 'connected' || x.state === 'failed' || x.state === 'key_refused' ? x.state : !approved ? 'waiting_for_approval' : pickupApproved(home, hubKey, s.request.id) ? 'picking_up' : 'waiting_for_allow');
    return { request: s.request, steps: tl?.steps ?? [], reachable: tl !== null, git, hub, agents: (tl?.agents ?? []).map((x) => { const st = local(x); return { label: x.label, state: st, text: AGENT_STATES[st] ?? st }; }) };
  }
  const agents = s.agents.map((a) => {
    const h = hubAgents.get(a.agent_id);
    const state = !a.built ? (s.pickup_id ? 'failed' : 'waiting_for_approval') : h?.state === 'key_refused' ? 'key_refused' : h?.state === 'connected' ? 'connected' : 'ready_to_open';
    const dir = a.dir ?? folderOf(s, a);
    return { label: a.label, role: a.role, team_role: a.team_role, state, text: AGENT_STATES[state], error: state === 'failed' ? a.error : null, folder: dir, open: a.built ? openWays(dir, a, s.request?.team_name, win) : null, codex: isCodex(a.client) };
  });
  return { request: s.request, steps: tl?.steps ?? [], reachable: tl !== null, git, hub, agents };
}

/** Whether a Continue setup is waiting for this hub (a request filed and not finished). */
export function pending(home, hubId) {
  const s = loadSetup(home, hubId);
  return !!s.request && !['denied', 'withdrawn', 'cancelled'].includes(s.request.state) && (!s.confirmed || s.agents.some((a) => !a.built));
}

export { SetupError, canonicalFolder, call as hubCall, localLabel };
