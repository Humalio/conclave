/**
 * Restore by the connector (docs/checkout.md §6 "Restore by the connector"). The worker carries out a `restore` order: the
 * checkout's handouts are checked against their render hashes, the repos are cloned or fetched (fast-forward only, no push,
 * no worktree) into the destination the PC's user approved, each folder's agent config is scanned before the connector
 * writes anything, and each agent gets the entries onboarding writes (Claude Code: .mcp.json + folder hook; Codex: the
 * connector's codex entry and permission settings), with its key from the connector's one key file for that hub.
 * A Codex agent gets its own clone of the repo in its own folder (Codex keeps .git read-only in its sandbox, and a
 * worktree's git data would sit outside the folder), and its role file is AGENTS.override.md (role.mjs).
 *
 * The run is a state machine kept per checkout in restores/<hub>-<checkout>.json (no secrets), so a restart of the
 * connector resumes where it stopped. It never asks anything itself: a folder with agent config of its own waits for the PC's
 * user (the local screen, or `conclave repair --grant-trust`), and the order waits with it. Handout fields are L2 (an agent wrote
 * them): each is checked before it reaches a path or a git argument.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readJson, atomicWrite, canonicalFolder, pathKey, trustKeys, oneLine, WIN } from './paths.mjs';
import { readKeyFile, putAgentKey, removeAgentKey, agentKey, LABEL_RE } from './keyfile.mjs';
import { pickupApproved, requestPickup, spendPickup, pickupDenied, allowWithPickup } from './approvals.mjs';
import { request, callTool } from './hubclient.mjs';
import { registerFolder } from './register.mjs';
import { rerecord, resolveFolder, foldersOfHub } from './registry.mjs';
import { grantTrust, trustStatus } from './trust.mjs';
import { record } from './manifest.mjs';
import { codexToml, codexPermission, nodePath, connectorPath, gitPath } from './entries.mjs';
import { invalidate } from './tokens.mjs';
import { shellQuote } from './request.mjs';
import { resolveDestination, destinationChanged } from './destinations.mjs';
import { OVERRIDE, overrideState, writeOverride } from './role.mjs';
import { safeGit, noHooks, unsafeRepoConfig } from './commit.mjs';

class RestoreError extends Error { constructor(message) { super(message); this.name = 'RestoreError'; } }
const die = (m) => { throw new RestoreError(m); };

// ───────────── what a handout may say ─────────────
export const validRef = (r) => typeof r === 'string' && r.length <= 200 && /^[A-Za-z0-9._/-]+$/.test(r) && !r.startsWith('-') && !r.startsWith('/')
  && !r.endsWith('/') && !r.endsWith('.') && !r.endsWith('.lock') && !r.includes('..') && !r.includes('//') && !r.split('/').some((c) => c.startsWith('.') || c.endsWith('.lock'));
export const validHead = (h) => typeof h === 'string' && /^[0-9a-f]{40}$/.test(h);
export const validRemote = (r) => typeof r === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(r);
export const validFolder = (f) => typeof f === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(f);
export const validUrl = (u) => typeof u === 'string' && u.length <= 400 && !/[\s\x00-\x1f\x7f]/.test(u) && !u.startsWith('-')
  && (/^(https|ssh):\/\/([A-Za-z0-9][A-Za-z0-9._-]*@)?[A-Za-z0-9][A-Za-z0-9.-]*(:\d+)?\/\S+$/.test(u) || /^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.-]*:[^\s-]\S*$/.test(u));
/** What a clone never tracks from the restore: our own config and the role overlays. */
export const CLONE_EXCLUDE = ['.mcp.json', '.claude/settings.local.json', '.codex/', 'CLAUDE.local.md', 'AGENTS.override.md'];
const SCAN_MAX = 50, SCAN_TEXT = 300;
const text = (s) => oneLine(s).slice(0, SCAN_TEXT);
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const safeSeg = (s) => String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/^\.+$/, '-').trim() || '-';
/** Git's own stderr can carry a URL with credentials: they never reach a note. */
const scrub = (s) => String(s).replace(/(\w+:\/\/)[^/@\s]+@/g, '$1').slice(0, 200);

/** Each handout body against its render hash, then its fields, typed: [{agent, facts}]. */
export function verifyHandouts(view) {
  return (view.agents ?? []).map((a) => {
    if (!validFolder(a.folder)) die(`${a.label}: the folder name from the hub is not valid`);
    const h = a.handout;
    if (!h || typeof h.body !== 'string') die(`${a.label}: the hub sent no handout (status ${h?.status ?? 'none'}); ask the administrator`);
    if (!/^[0-9a-f]{64}$/.test(h.render_sha256 ?? '')) die(`${a.label}: the handout has no render hash`);
    if (sha256(h.body) !== h.render_sha256) die(`${a.label}: the handout does not match the one the administrator rendered (SHA-256 differs). Stopping: ask the administrator to render again.`);
    let b;
    try { b = JSON.parse(h.body); } catch { die(`${a.label}: the handout is not JSON`); }
    const r = b.repo && typeof b.repo === 'object' ? b.repo : null;
    const repo = r ? { remote_name: r.remote_name ?? null, url: r.url ?? null, clone_folder: r.clone_folder ?? null } : null;
    if (repo) {
      if (repo.remote_name !== null && !validRemote(repo.remote_name)) die(`${a.label}: the handout names a remote that is not valid`);
      if (repo.url !== null && !validUrl(repo.url)) die(`${a.label}: the handout names a repo URL that is not valid`);
      if (repo.clone_folder !== null && !validFolder(repo.clone_folder)) die(`${a.label}: the handout names a clone folder that is not valid`);
    }
    const c = b.checkpoint && typeof b.checkpoint === 'object' ? b.checkpoint : {};
    const cp = { integration_branch: c.integration_branch ?? null, integration_head: c.integration_head ?? null, merge_commits: Array.isArray(c.merge_commits) ? c.merge_commits : [], checkout_head: c.checkout_head ?? null };
    if (cp.integration_branch !== null && !validRef(cp.integration_branch)) die(`${a.label}: the handout names a branch that is not a valid ref (refused: it could be read as an option)`);
    for (const x of [cp.integration_head, cp.checkout_head, ...cp.merge_commits].filter((v) => v !== null)) if (!validHead(x)) die(`${a.label}: the handout names a commit that is not 40 hex characters`);
    return { agent: a, facts: { repo, checkpoint: cp, unmerged: b.unmerged_work_on_source === true } };
  });
}

// ───────────── git ─────────────
const gitBinOf = (home, gitBin) => gitBin === undefined ? (gitPath(home) ?? 'git') : (gitBin ?? 'git');
/**
 * Git through the commit tool's wrapper: the clone's hooks and fsmonitor off, GIT_* from the environment kept out, no
 * prompts. A clone whose .git/config would make git run a program (an include, a filter, an ssh command...) is refused
 * before any git call in it.
 */
function mkGit(bin) {
  const checked = new Set();
  const git = (dir, args) => {
    const gd = join(dir, '.git');
    if (!checked.has(gd) && existsSync(gd)) {
      if (!statSync(gd).isDirectory()) die(`${dir}: its .git is not a folder (a worktree or a linked repo); restore works only in a clone of its own`);
      const bad = unsafeRepoConfig(bin, gd);
      if (bad) die(`${dir}: the clone's .git/config has ${bad}, which makes git run a program; remove it, then send Restore again`);
      checked.add(gd);
    }
    return safeGit(bin, dir, noHooks(), null, { timeout: 180_000 })(args, undefined, { GIT_LITERAL_PATHSPECS: '0' });
  };
  const gitOk = (dir, args, what) => {
    const r = git(dir, args);
    if (r.status !== 0) die(`${what}: ${scrub((r.stderr || r.error?.message || '').split(/\r?\n/).find(Boolean) ?? `git exit ${r.status}`)}`);
    return r.stdout;
  };
  return { git, gitOk, hasRef: (dir, ref) => git(dir, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]).status === 0 };
}

/**
 * The repos the handouts name, one per clone folder: remote, URL, and the heads each branch must contain. A Codex agent's
 * clone goes into its own folder (its folder is the clone), so it never shares one; Claude Code agents share the clone_folder.
 */
export function repoPlan(verified, projectDir, checkoutId) {
  const byFolder = new Map();
  for (const { agent, facts } of verified) {
    const r = facts.repo, cp = facts.checkpoint;
    if (!r?.clone_folder || facts.unmerged) continue;
    const into = agent.provider === 'codex' ? agent.folder : r.clone_folder;
    const p = byFolder.get(into) ?? { dir: join(projectDir, into), clone_folder: into, remote: r.remote_name ?? 'origin', url: r.url, branches: new Map(), checkout: [], agents: [] };
    if (r.url && p.url && r.url !== p.url) die(`${agent.label}: two handouts name different URLs for ${into}`);
    p.url ??= r.url; p.agents.push(agent.label);
    if (cp.integration_branch) {
      const hs = p.branches.get(cp.integration_branch) ?? [];
      for (const h of [cp.integration_head, ...cp.merge_commits]) if (h && !hs.includes(h)) hs.push(h);
      p.branches.set(cp.integration_branch, hs);
    }
    if (cp.checkout_head) p.checkout.push(cp.checkout_head);
    byFolder.set(into, p);
  }
  return [...byFolder.values()].map((p) => ({ ...p, branches: [...p.branches.entries()].map(([branch, heads]) => ({ branch, heads })), checkout_branch: `checkout/${checkoutId}` }));
}

function addExclude(dir, lines) {
  const ex = join(dir, '.git', 'info', 'exclude');
  mkdirSync(dirname(ex), { recursive: true });
  const cur = existsSync(ex) ? readFileSync(ex, 'utf8') : '';
  const have = new Set(cur.split(/\r?\n/));
  const add = lines.filter((l) => !have.has(l));
  if (add.length) writeFileSync(ex, (cur && !cur.endsWith('\n') ? cur + '\n' : cur) + add.join('\n') + '\n');
}

/**
 * One repo (§6 step 3): clone it if it is not there, or (another user or PC) fetch and fast-forward an existing clean clone,
 * refusing a divergence; then check that every recorded head is an ancestor of its branch. `same_user` only checks.
 * Nothing is pushed and no worktree is created. Returns {dir, tip_ref, checkout_ref}.
 */
export function prepareRepo(p, { fetch, gitBin = 'git' }) {
  const { git, gitOk, hasRef } = mkGit(gitBin);
  if (!validFolder(p.clone_folder) || !validRemote(p.remote) || (p.url && !validUrl(p.url))) die(`${p.clone_folder}: the repo facts are not valid`);
  for (const b of p.branches) { if (!validRef(b.branch)) die(`${p.clone_folder}: ${JSON.stringify(b.branch)} is not a valid ref (refused)`); for (const h of b.heads) if (!validHead(h)) die(`${p.clone_folder}: a head is not 40 hex characters`); }
  if (!validRef(p.checkout_branch)) die(`${p.clone_folder}: the checkout branch is not a valid ref`);
  for (const h of p.checkout) if (!validHead(h)) die(`${p.clone_folder}: a checkout head is not 40 hex characters`);
  const R = p.remote, refspecs = [...p.branches.map((b) => `refs/heads/${b.branch}:refs/remotes/${R}/${b.branch}`), ...(p.checkout.length ? [`refs/heads/${p.checkout_branch}:refs/remotes/${R}/${p.checkout_branch}`] : [])];
  let moved = false, cloned = false;
  if (!existsSync(join(p.dir, '.git'))) {
    if (!p.url) die(`${p.clone_folder}: there is no clone and the handout names no remote URL`);
    if (!p.branches[0]?.branch) die(`${p.clone_folder}: there is no clone and no integration branch to check out, so nothing could be scanned; ask the administrator to render again`);
    if (existsSync(p.dir) && readdirSync(p.dir).length) die(`${p.clone_folder} exists in the destination and is not a git clone: move it away or empty it, then send Restore again`);
    mkdirSync(dirname(p.dir), { recursive: true });
    gitOk(dirname(p.dir), ['clone', '-q', '--no-checkout', '--origin', R, '--', p.url, p.dir], `clone ${scrub(p.url)}`);
    moved = cloned = true;
  } else {
    const url = git(p.dir, ['config', '--get', `remote.${R}.url`]); // as configured (get-url would apply insteadOf)
    if (url.status !== 0) die(`${p.clone_folder}: the clone has no remote ${R}`);
    if (p.url && url.stdout.trim() !== p.url) die(`${p.clone_folder}: remote ${R} points elsewhere than the handout says (${scrub(url.stdout.trim())}); not touching it`);
    if (fetch) {
      if (git(p.dir, ['status', '--porcelain', '--untracked-files=no']).stdout.trim()) die(`${p.clone_folder}: the clone has uncommitted changes; commit or stash them, then send Restore again`);
      gitOk(p.dir, ['fetch', '-q', '--no-tags', '--', R, ...refspecs], `fetch ${R}`);
      moved = true;
    }
  }
  const main = p.branches[0]?.branch ?? null;
  if (main && moved) {
    const remoteRef = `refs/remotes/${R}/${main}`;
    if (!hasRef(p.dir, remoteRef)) die(`${p.clone_folder}: ${R} has no branch ${main}; push it (the render's push list), then send Restore again`);
    if (cloned || !hasRef(p.dir, `refs/heads/${main}`)) {
      gitOk(p.dir, ['checkout', '-q', '-B', main, '--track', remoteRef, '--'], `checkout ${main}`);
    } else {
      const cur = git(p.dir, ['symbolic-ref', '-q', '--short', 'HEAD']).stdout.trim();
      if (cur !== main) gitOk(p.dir, ['checkout', '-q', main, '--'], `checkout ${main}`);
      const ff = git(p.dir, ['merge', '--ff-only', '-q', remoteRef]);
      if (ff.status !== 0) die(`${p.clone_folder}: ${main} has diverged from ${R}/${main}; fast-forward only, so nothing was changed. Ask the administrator.`);
    }
  }
  const refOf = (b) => (hasRef(p.dir, `refs/heads/${b}`) ? `refs/heads/${b}` : `refs/remotes/${R}/${b}`);
  const ancestor = (head, ref, name) => {
    const r = git(p.dir, ['merge-base', '--is-ancestor', head, ref]);
    if (r.status === 1) die(`${p.clone_folder}: commit ${head} is not in ${name} (not an ancestor of its tip). Stopping before any folder is built.`);
    if (r.status !== 0) die(`${p.clone_folder}: commit ${head} is missing here; push ${name} (the render's push list), then send Restore again`);
  };
  for (const b of p.branches) {
    const ref = refOf(b.branch);
    if (!hasRef(p.dir, ref)) die(`${p.clone_folder}: branch ${b.branch} is not there; push it, then send Restore again`);
    for (const h of b.heads) ancestor(h, ref, b.branch);
  }
  let checkoutRef = null;
  if (p.checkout.length) {
    checkoutRef = refOf(p.checkout_branch);
    if (!hasRef(p.dir, checkoutRef)) die(`${p.clone_folder}: ${p.checkout_branch} (work not approved yet) is not there; push it, then send Restore again`);
    for (const h of p.checkout) ancestor(h, checkoutRef, p.checkout_branch);
  }
  addExclude(p.dir, CLONE_EXCLUDE);
  return { dir: p.dir, tip_ref: main ? refOf(main) : null, checkout_ref: checkoutRef };
}

// ───────────── the config scan ─────────────
/** Which kind of agent config a path is (§6 step 4), or null. Matched on the lower-cased path with / separators. */
function configKind(p) {
  const q = p.replace(/\\/g, '/').toLowerCase();
  const base = q.split('/').pop();
  if (/(^|\/)\.claude\/settings(\.local)?\.json$/.test(q)) return 'settings';
  if (base === '.mcp.json') return 'mcp_servers';
  if (base === '.agent-hub.json') return 'agent_hub'; // reported as codex_config: the server knows only its SCAN_KINDS
  if (q.startsWith('.claude/') || q.includes('/.claude/')) return 'claude_config';
  if (q.startsWith('.codex/') || q.includes('/.codex/')) return 'codex_config';
  if (['claude.md', 'agents.md', 'claude.local.md', 'agents.override.md'].includes(base)) return 'role_file';
  return null;
}
const UNTRACKED_CONFIG = ['.claude/settings.json', '.claude/settings.local.json', '.mcp.json', '.codex', 'CLAUDE.md', 'AGENTS.md',
  'CLAUDE.local.md', 'AGENTS.override.md', '.agent-hub.json'].map((p) => `:(icase)${p}`);

/**
 * The config scan of one folder (§6 step 4): tracked agent config, untracked agent config at the root, and config the
 * checkout/<id> branch changes against the integration tip. Run BEFORE the connector writes anything into the folder, so its
 * own entries never count. Findings are {kind, path, detail}, one line each, at most 50.
 */
export function scanFolder(dir, { tipRef = null, checkoutRef = null, gitBin = 'git' } = {}) {
  if (!existsSync(join(dir, '.git'))) return [];
  const { git, gitOk } = mkGit(gitBin);
  const list = (args) => gitOk(dir, ['ls-files', '-z', ...args], `scan ${dir}`).split('\0').filter(Boolean);
  // --others without --exclude-standard: an ignored config file loads all the same.
  const files = [...list(['--']).map((f) => [f, true]), ...list(['--others', '--', ...UNTRACKED_CONFIG]).map((f) => [f, false])];
  const found = [];
  const push = (kind, path, detail) => { if (found.length < SCAN_MAX) found.push({ kind, path: text(path), detail: text(detail) }); };
  for (const [f, tracked] of files) {
    const k = configKind(f);
    if (!k) continue;
    const how = tracked ? 'tracked' : 'untracked';
    if (k === 'settings') {
      const j = readJson(join(dir, f));
      const hooks = j && typeof j.hooks === 'object' && j.hooks ? Object.keys(j.hooks) : [];
      if (hooks.length) push('hooks', f, `${how} hooks: ${hooks.join(', ')}`);
      else push('claude_config', f, j ? `${how} settings: ${Object.keys(j).slice(0, 10).join(', ')}` : `${how} settings (not JSON)`);
    } else if (k === 'mcp_servers') {
      const j = readJson(join(dir, f));
      push(k, f, `${how} servers: ${Object.keys(j?.mcpServers ?? {}).join(', ') || '(none read)'}`);
    } else if (k === 'agent_hub') push('codex_config', f, `${how} .agent-hub.json: picks the agent and hub for the Codex bridge`);
    else push(k, f, k === 'role_file' ? `${how} role file: loaded as instructions` : `${how} config`);
  }
  let hooks = [];
  try { hooks = readdirSync(join(dir, '.git', 'hooks')).filter((h) => !h.endsWith('.sample')); } catch { /* no hooks folder */ }
  for (const h of hooks) push('hooks', `.git/hooks/${h}`, "git hook in this clone: runs on the agent's own git commands");
  if (tipRef && checkoutRef) {
    const d = git(dir, ['diff', '--name-only', '-z', `${tipRef}...${checkoutRef}`, '--']);
    if (d.status === 0) for (const f of d.stdout.split('\0').filter(Boolean)) if (configKind(f)) push('checkout_diff', f, 'changed on the checkout branch (work not approved yet)');
  }
  return found;
}

// ───────────── what is written for each agent ─────────────
/** The resume message (checkout.md §6 step 9). It starts with the same first call as the Codex resume message. */
export const resumeMsg = (a, team) => `You are ${a.label}, ${a.role} of ${team}. Call directives_read {unread: true, ack: true}, then checkout_resume, then session_whoami, team_info, task_list, message_read, team_decisions, bp_read, then continue.`.replace(/["'`$\\]/g, '');

/** How to open one restored agent (one terminal each). Claude Code: `claude`; Codex: `codex -C` with the permission flags. */
export function startLine(dir, msg, { provider = 'claude_code', permissions = null, win = WIN } = {}) {
  if (provider === 'codex') {
    const p = codexPermission(permissions);
    const flags = p ? ` -a ${p.approval_policy} -s ${p.sandbox_mode}` : '';
    return `codex -C ${shellQuote(dir, win)}${flags} ${win ? `"${msg}"` : shellQuote(msg, false)}`;
  }
  if (win) return `cd ${shellQuote(dir, true)}; claude "${msg}"`;
  return `cd ${shellQuote(dir, false)} && claude ${shellQuote(msg, false)}`;
}

const trackedIn = (dir, git, pattern) => existsSync(join(dir, '.git')) && git(dir, ['ls-files', '-z', '--', `:(icase)${pattern}`]).stdout.length > 0;

/**
 * Why a Codex agent's role file cannot go into this folder, or null. A project's own AGENTS.md (tracked or not) is fine: it
 * is left exactly as it is. An AGENTS.override.md the connector did not write (no marker, or the old codex.mjs's) is never
 * overwritten, and neither is one git tracks.
 */
export function codexRoleBlock(dir, gitBin = 'git') {
  if (trackedIn(dir, mkGit(gitBin).git, OVERRIDE)) return `this folder's repo tracks an ${OVERRIDE}, which the connector would have to replace. Restore will not change a tracked file.`;
  const st = overrideState(dir);
  if (st === 'old') return `this folder holds an ${OVERRIDE} from the old Codex setup. Run conclave migrate (it replaces it), then send Restore again.`;
  if (st === 'unmarked') return `this folder holds an ${OVERRIDE} that Conclave did not write, and restore never overwrites it. Move it away, then send Restore again.`;
  return null;
}

/**
 * The files the agent itself needs, after its key is in the key file: Claude Code's permission mode and model in
 * .claude/settings.local.json (the entry and hook were written at registration), and the role file only where git
 * does not track one; for Codex, .codex/config.toml and the role file AGENTS.override.md, kept out of git, with a
 * project's own AGENTS.md left as it is. Returns nothing; every change is recorded in the manifest.
 */
export function writeAgentFiles(home, dir, a, instructions, { claudeJson, node, connector, gitBin = 'git' } = {}) {
  const { git } = mkGit(gitBin);
  const cx = { home, claudeJson, folders: [dir] };
  const body = (instructions || `You are ${a.label}. Call checkout_resume first.`).replace(/\n?$/, '\n');
  const role = (name, kind) => {
    const p = join(dir, name);
    if (trackedIn(dir, git, name) || existsSync(p)) return false; // the repo's own role file is never replaced
    writeFileSync(p, body);
    record(home, { kind, target: p, folder: dir, pointer: null, before: null, installed: { sha256: sha256(body) } }, cx);
    return true;
  };
  if (a.provider === 'codex') {
    const perm = codexPermission(a.permissions);
    if (!perm) die(`${a.label}: the permission mode ${text(a.permissions)} has no Codex setting`);
    const block = codexRoleBlock(dir, gitBin);
    if (block) die(`${a.label}: ${block}`);
    writeOverride(home, dir, instructions || `You are ${a.label}. Call checkout_resume first.`, cx);
    const toml = join(dir, '.codex', 'config.toml');
    const before = existsSync(toml) ? readFileSync(toml, 'utf8') : null;
    if (before === null || !/\[mcp_servers\.conclave\]/.test(before)) {
      mkdirSync(join(dir, '.codex'), { recursive: true });
      const top = [`approval_policy = ${JSON.stringify(perm.approval_policy)}`, `sandbox_mode = ${JSON.stringify(perm.sandbox_mode)}`, ...(a.model ? [`model = ${JSON.stringify(a.model)}`] : [])];
      const hasTop = before !== null && /^\s*(approval_policy|sandbox_mode)\s*=/m.test(before);
      const entry = codexToml({ node: nodePath(node), connector: connectorPath(home, connector), folder: dir, approveTools: perm.level === 'auto' });
      writeFileSync(toml, (hasTop ? '' : top.join('\n') + '\n\n') + (before ? before.replace(/\n?$/, '\n\n') : '') + entry);
      record(home, { kind: 'codex_entry', target: toml, folder: dir, pointer: 'mcp_servers.conclave', before: null, installed: entry }, cx);
    }
    return;
  }
  const sp = join(dir, '.claude', 'settings.local.json');
  mkdirSync(join(dir, '.claude'), { recursive: true });
  const s = readJson(sp) ?? {};
  // A tracked settings.local.json came with the repo (the scan reported it): its allow list is not carried over.
  const keep = !trackedIn(dir, git, '.claude/settings.local.json') && s.permissions && typeof s.permissions === 'object' ? s.permissions : {};
  s.permissions = { ...keep, defaultMode: a.permissions };
  if (a.model) s.model = a.model; else delete s.model;
  writeFileSync(sp, JSON.stringify(s, null, 2) + '\n');
  // The hub's playbook: CLAUDE.md where there is none; where the repo tracks one, an untracked overlay beside it.
  if (!role('CLAUDE.md', 'instructions')) {
    const md = join(dir, 'CLAUDE.local.md');
    if (!existsSync(md)) writeFileSync(md, body);
  }
}

// ───────────── the run ─────────────
export const restoresDir = (home) => join(home, 'restores');
const keyOf = (hubKey, checkoutId) => `${createHash('sha256').update(hubKey).digest('hex').slice(0, 16)}-${checkoutId}`;
export const restorePath = (home, hubKey, checkoutId) => join(restoresDir(home), `${keyOf(hubKey, checkoutId)}.json`);
export const save = (home, s) => atomicWrite(restorePath(home, s.hub_key, s.checkout_id), JSON.stringify(s, null, 2) + '\n');

/** The unfinished restores of one hub (a restart of the connector resumes them). */
export function activeRestores(home, hubKey) {
  const out = [];
  let names = [];
  try { names = readdirSync(restoresDir(home)); } catch { return out; }
  const pre = createHash('sha256').update(hubKey).digest('hex').slice(0, 16) + '-';
  for (const n of names) {
    if (!n.startsWith(pre) || !n.endsWith('.json')) continue;
    const s = readJson(join(restoresDir(home), n), null);
    if (s && s.version === 1 && s.hub_key === hubKey && !s.finished) out.push(s);
  }
  return out;
}

/** Starts (or restarts) the state for an order; a checkout already being restored keeps its progress under the new order. */
export function beginRestore(home, hubKey, order) {
  const old = readJson(restorePath(home, hubKey, order.payload.checkout_id), null);
  const s = old && old.version === 1 && !old.finished && old.destination_id === order.payload.destination_id
    ? { ...old, order_id: order.id }
    : { version: 1, hub_key: hubKey, order_id: order.id, checkout_id: order.payload.checkout_id, destination_id: order.payload.destination_id, request_id: null, step: 'start', finished: false, last_note: null };
  save(home, s);
  return s;
}

const transient = (e) => !(e instanceof RestoreError) && !(e?.hub && e.hub.error);

/**
 * Carries a restore as far as it goes. Answers {phase: 'waiting', note} (it stopped for something outside it: the
 * administrator, the PC's user, the hub), {phase: 'done', start_lines}, {phase: 'failed', reason} or {phase: 'ended'} (the
 * checkout was cancelled or replaced). `cx`: {home, hubKey, section, hub, auth, claudeJson, node, connector, win, gitBin}.
 */
export async function runRestore(cx, s) {
  const { home, hubKey, win = WIN } = cx;
  const gitBin = gitBinOf(home, cx.gitBin);
  const call = async (method, path, body) => {
    const r = await request(cx.hub, method, path, { body, headers: cx.auth, timeoutMs: 30_000 });
    if (r.status >= 200 && r.status < 300) return r.json ?? {};
    const e = new Error(`the hub answered ${r.status}`); e.hub = r.json && r.json.error ? r.json : null; e.status = r.status; throw e;
  };
  try {
    const dest = resolveDestination(home, s.destination_id);
    if (!dest) return { phase: 'failed', reason: 'That destination is not approved on this PC any more. Ask the PC\'s user to approve one, then send Restore again.' };
    if (!existsSync(dest.path)) return { phase: 'failed', reason: 'The approved destination folder is not there any more. Ask the PC\'s user to approve a destination, then send Restore again.' };
    if (destinationChanged(dest)) return { phase: 'failed', reason: 'The approved destination folder was replaced since it was approved (a link or a new folder at the same place). Ask the PC user to approve it again with conclave destinations add, then send Restore again.' };
    // 1. The request that carries this checkout.
    if (!s.request_id) {
      const l = await call('GET', '/onboard/requests');
      const r = (l.requests ?? []).find((x) => x.checkout_id === s.checkout_id);
      if (!r || typeof r.request_id !== 'string' && typeof r.id !== 'string') return { phase: 'failed', reason: 'The hub has no checkout request for this PC. Render the checkout again for this PC, then send Restore again.' };
      s.request_id = r.request_id ?? r.id; save(home, s);
    }
    const req = encodeURIComponent(s.request_id);
    let st = await call('GET', `/onboard/requests/${req}?wait_s=0`);
    if (['denied', 'withdrawn', 'cancelled'].includes(st.state)) return { phase: 'ended' };
    let view = st.checkout;
    if (!view || view.id !== s.checkout_id || !['rendered', 'restoring'].includes(view.status)) return { phase: 'ended' };
    if (!['approved', 'collected'].includes(st.state)) return { phase: 'waiting', note: 'Waiting for the administrator to approve this PC in the console.' };
    const team = view.team ?? st.team_name ?? '?';
    const agents = view.agents ?? [];
    for (const a of agents) if (!['claude_code', 'codex'].includes(a.provider)) return { phase: 'failed', reason: `${text(a.label)}: provider ${text(a.provider)} is not supported by restore.` };
    const projectDir = resolve(dest.path, safeSeg(st.project || team));
    const dirOf = (a) => join(projectDir, a.folder);

    // 2. Handouts, repos, folders, and the config scan: before the connector writes anything into a folder.
    if (!s.prepared) {
      const verified = verifyHandouts(view);
      const repos = [];
      for (const p of repoPlan(verified, projectDir, s.checkout_id)) repos.push({ ...p, ...prepareRepo(p, { fetch: view.target !== 'same_user', gitBin }) });
      for (const a of agents) {
        const dir = dirOf(a);
        mkdirSync(dir, { recursive: true });
        if (!existsSync(join(dir, '.git'))) { mkGit(gitBin).gitOk(dirname(dir), ['init', '-q', '--', dir], `init ${a.folder}`); addExclude(dir, ['*']); }
        const block = a.provider === 'codex' ? codexRoleBlock(dir, gitBin) : null;
        if (block) die(`${text(a.label)}: ${block}`);
      }
      const folders = agents.map((a) => {
        const repo = repos.find((r) => resolve(r.dir) === resolve(dirOf(a)));
        return { folder: a.folder, findings: scanFolder(dirOf(a), repo ? { tipRef: repo.tip_ref, checkoutRef: repo.checkout_ref, gitBin } : { gitBin }) };
      });
      const seen = new Map((view.scans ?? []).map((x) => [x.folder, x.findings_sha256]));
      if (folders.some((f) => seen.get(f.folder) !== sha256(JSON.stringify(f.findings)))) await call('POST', `/onboard/requests/${req}/scan`, { folders });
      s.held = folders.filter((f) => f.findings.length).map((f) => f.folder);
      s.prepared = true; save(home, s);
    }
    // 3. The administrator decides a scan with findings in the console; no key is picked up until then.
    st = await call('GET', `/onboard/requests/${req}?wait_s=0`);
    if (!st.checkout || !['rendered', 'restoring'].includes(st.checkout.status)) return { phase: 'ended' };
    view = st.checkout;
    const adminWait = (view.scans ?? []).filter((x) => x.waiting).map((x) => x.folder);
    if (adminWait.length) return { phase: 'waiting', note: `The administrator decides the config scan of ${adminWait.join(', ')} in the console (Checkout screen). No key is picked up until then.` };

    // 4. The connector's entries in every folder (registered without trust), the key file's label for each agent.
    const kf = readKeyFile(home);
    if (!kf.ok) die('the key file cannot be used on this PC');
    s.agents ??= [];
    if (!s.registered) {
      const taken = new Set(Object.keys(kf.data.hubs[hubKey]?.agents ?? {}));
      // A folder already bound to this hub (an earlier restore into it that failed, say) keeps its label: a retry never
      // renames it `folder-2`.
      const bound = new Map(foldersOfHub(home, cx.section.hub_id, cx.section.ca_sha256).map((b) => [pathKey(b.path), b.agent]));
      for (const a of agents) {
        const dir = dirOf(a);
        let label = bound.get(pathKey(canonicalFolder(dir) ?? dir));
        if (!label || !LABEL_RE.test(label)) {
          label = LABEL_RE.test(a.folder) ? a.folder : String(a.session_var ?? 'agent').replace(/[^A-Za-z0-9_-]/g, '_').replace(/^[^A-Za-z0-9]+/, '').slice(0, 60) || 'agent';
          const base = label; let i = 2;
          while (taken.has(label)) label = `${base.slice(0, 58)}-${i++}`;
        }
        taken.add(label);
        registerFolder(home, dir, { hubId: cx.section.hub_id, caSha256: cx.section.ca_sha256, agent: label, agentId: a.agent_id, claudeJson: cx.claudeJson, node: cx.node, connector: cx.connector, win, held: true, provider: a.provider, team: view.team_id ? { id: view.team_id, name: view.team } : null });
        s.agents.push({ agent_id: a.agent_id, folder: a.folder, dir: canonicalFolder(dir) ?? dir, label, session_var: a.session_var });
      }
      s.registered = true; save(home, s);
    }
    // 5. A folder with config of its own waits for the PC's user: the folder trust they grant is the approval.
    const waitingUser = [];
    for (const f of s.held ?? []) {
      const ag = s.agents.find((x) => x.folder === f);
      const r = ag && resolveFolder(home, ag.dir);
      if (!r?.ok) continue;
      if (trustStatus(cx.claudeJson, r.folder, r.binding, { win }).action === 'none') { s.approved = [...new Set([...(s.approved ?? []), f])]; rerecord(home, r.folder); } else waitingUser.push(ag);
    }
    if (waitingUser.length) {
      save(home, s);
      return { phase: 'waiting', waiting_for_user: waitingUser.map((x) => x.folder),
        note: `Waiting for the PC's user: ${waitingUser.map((x) => x.folder).join(', ')} has agent settings of its own. The user approves on the connector's screen, or with conclave repair --grant-trust in that folder.` };
    }

    // 6. Pickup, once (a restart after a crash reuses the keys it wrote), then each agent's files and a login test.
    if (!s.confirmed) {
      if (!(s.pickup_id && s.keys_written_for === s.pickup_id)) {
        if (!pickupApproved(home, hubKey, s.request_id) && pickupDenied(home, hubKey, s.request_id)) return { phase: 'waiting', note: 'Declined on this PC. The PC user can still allow it on the connector screen.' };
        if (!pickupApproved(home, hubKey, s.request_id)) { requestPickup(home, hubKey, s.request_id, 'session keys for a restored team', s.agents.map((x) => ({ agent: x.label, path: x.dir }))); return { phase: 'waiting', note: "Waiting for the PC's user to allow the key pickup on the connector's screen." }; }
        const p = await call('POST', '/onboard/pickup', { request_id: s.request_id });
        s.pickup_id = p.pickup_id; s.instructions = {};
        for (const pa of p.agents) {
          const ag = s.agents.find((x) => x.agent_id === pa.agent_id);
          if (!ag) die('the hub picked up an agent this restore does not know');
          s.instructions[pa.agent_id] = typeof pa.instructions === 'string' ? pa.instructions : '';
        }
        save(home, s); // the list first (no secrets), then the keys: a restart here picks up again
        for (const pa of p.agents) { putAgentKey(home, hubKey, s.agents.find((x) => x.agent_id === pa.agent_id).label, pa.secret); pa.secret = undefined; }
        s.keys_written_for = s.pickup_id; save(home, s);
      }
      for (const a of agents) {
        const ag = s.agents.find((x) => x.agent_id === a.agent_id);
        writeAgentFiles(home, ag.dir, a, s.instructions?.[a.agent_id], { claudeJson: cx.claudeJson, node: cx.node, connector: cx.connector, gitBin });
      }
      const section = readKeyFile(home).data.hubs[hubKey];
      for (const ag of s.agents) {
        const key = agentKey(section, ag.label);
        if (!key) die(`${ag.folder}: the agent key is not in the key file`);
        const r = await callTool(cx.hub, 'session_login', { session_key: key }, cx.auth, 15_000).catch((e) => ({ status: 0, reason: e.reason }));
        if (r.status !== 200 || typeof r.data?.session_token !== 'string') die(`${ag.folder}: the agent could not log in (${r.status || r.reason || 'hub unreachable'}); the old sessions keep running`);
      }
      // 7. Confirm: the checkout is restoring and the old sessions are suspended. The answer says which folders may be trusted.
      let c;
      try { c = await call('POST', '/onboard/pickup/confirm', { pickup_id: s.pickup_id, written: s.agents.map((x) => x.session_var), transport: 'https' }); }
      catch (e) {
        if (e.hub?.error === 'invalid_state' && /pickup again/i.test(e.hub.message ?? '')) { s.pickup_id = null; s.keys_written_for = null; save(home, s); return { phase: 'waiting', note: 'The pickup was replaced; picking the keys up again.' }; }
        throw e;
      }
      s.confirmed = true; s.trust = c.trust ?? {};
      // The click covers the request until confirm (docs/connector.md "Clicks"): a crash or a replaced pickup does not ask twice.
      spendPickup(home, hubKey, s.request_id);
      for (const ag of s.agents) invalidate(home, hubKey, ag.label); // checkout_resume accepts only a login made after confirm
      save(home, s);
    }

    // 8. Folder trust where the hub allows it; a folder the PC's user approved already has it.
    const withheld = [];
    for (const ag of s.agents) {
      if ((s.approved ?? []).includes(ag.folder)) continue;
      const r = resolveFolder(home, ag.dir);
      if (!r.ok) continue;
      if (s.trust?.[ag.folder] === true) {
        const t = grantTrust(cx.claudeJson, r.folder, { win });
        record(home, { kind: 'trust_flag', target: cx.claudeJson, folder: r.folder, pointer: `projects.${trustKeys(r.folder, win)[0]}.hasTrustDialogAccepted`, before: t.before === 'absent' ? null : t.before === 'true', installed: true }, { home, claudeJson: cx.claudeJson, folders: [r.folder] });
        rerecord(home, r.folder);
      } else withheld.push(ag.folder);
    }
    // The restore folders are the ones the PC user approved on the restore screen; the pickup they allowed also allows the first chat in each, once its settings are final (not for a folder still waiting for its trust).
    for (const ag of s.agents) if (!withheld.includes(ag.folder)) allowWithPickup(home, ag.dir, { agent: ag.label, agent_id: ag.agent_id, hub_id: cx.section.hub_id, ref: s.pickup_id ?? s.request_id });
    const lines = agents.map((a) => {
      const ag = s.agents.find((x) => x.agent_id === a.agent_id);
      return startLine(ag.dir, resumeMsg(a, team), { provider: a.provider, permissions: a.permissions, win });
    });
    s.start_lines = lines; s.finished = true; s.withheld = withheld; save(home, s);
    return { phase: 'done', start_lines: lines, withheld };
  } catch (e) {
    if (transient(e)) return { phase: 'waiting', note: null, retry: scrub(e.message ?? 'the hub could not be reached') };
    dropUnconfirmedKeys(home, hubKey, s);
    if (e instanceof RestoreError) return { phase: 'failed', reason: scrub(e.message) };
    return { phase: 'failed', reason: scrub(e.hub?.message ?? e.message ?? 'the hub refused the restore') };
  }
}

/**
 * A restore that failed before the hub confirmed its pickup leaves no key behind: the keys it wrote are removed from the
 * key file (the old sessions keep running, so those keys have no use on this PC). Keys of a confirmed restore stay.
 */
function dropUnconfirmedKeys(home, hubKey, s) {
  if (s.confirmed || !s.keys_written_for) return;
  for (const ag of s.agents ?? []) { try { removeAgentKey(home, hubKey, ag.label); } catch { /* the key file cannot be used: nothing to remove */ } }
  s.keys_written_for = null; save(home, s);
}

/** Marks a restore over (done, failed or ended): it is not resumed again. */
export function finishRestore(home, s, phase) { s.finished = true; s.phase = phase; save(home, s); }

/** The start lines of finished restores, for the connector's local screen: [{checkout_id, lines}], newest last. */
export function finishedLines(home, hubKey) {
  const out = [];
  let names = [];
  try { names = readdirSync(restoresDir(home)); } catch { return out; }
  const pre = createHash('sha256').update(hubKey).digest('hex').slice(0, 16) + '-';
  for (const n of names) {
    if (!n.startsWith(pre) || !n.endsWith('.json')) continue;
    const s = readJson(join(restoresDir(home), n), null);
    if (s?.version === 1 && s.hub_key === hubKey && s.confirmed && Array.isArray(s.start_lines)) out.push({ checkout_id: s.checkout_id, lines: s.start_lines });
  }
  return out;
}

/** The folders of a restore that wait for the PC's user: registered, with agent config of their own, and not trusted yet. */
export function awaitingUser(home, s, claudeJson, win = WIN) {
  const out = [];
  for (const f of s.held ?? []) {
    if ((s.approved ?? []).includes(f)) continue;
    const ag = (s.agents ?? []).find((x) => x.folder === f);
    const r = ag && resolveFolder(home, ag.dir);
    if (r?.ok && trustStatus(claudeJson, r.folder, r.binding, { win }).action !== 'none') out.push(f);
  }
  return out;
}

/** What the local screen shows for one hub: restores in progress (and what they wait for) and the start lines of finished ones. */
export function restoreView(home, hubKey, { claudeJson, win = WIN } = {}) {
  return { active: activeRestores(home, hubKey).map((s) => ({ checkout_id: s.checkout_id, note: s.last_note, waiting: awaitingUser(home, s, claudeJson, win) })), done: finishedLines(home, hubKey) };
}

/** The PC user's approval of one waiting folder on the local screen: the same as `conclave repair --grant-trust` there. */
export async function approveFolder(home, hubKey, checkoutId, folder, { claudeJson, win = WIN } = {}) {
  const { repairFolder } = await import('./register.mjs');
  const s = readJson(restorePath(home, hubKey, checkoutId), null);
  const ag = s?.version === 1 && !s.finished ? (s.agents ?? []).find((x) => x.folder === folder && (s.held ?? []).includes(folder)) : null;
  if (!ag) return { ok: false };
  const r = repairFolder(home, ag.dir, { claudeJson, win, grantTrust: true, acceptChanges: true });
  return { ok: !r.asked.length, actions: r.actions };
}
