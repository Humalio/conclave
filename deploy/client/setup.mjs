#!/usr/bin/env node
/**
 * Conclave onboarding client (docs/onboarding.md): enrols this PC, files a team request, waits for the operator's one
 * approval, picks up the agents' keys, builds their folders, tests each login, and diagnoses the PC (`check`).
 * Node 18 or later, no dependencies. Served by the hub at /onboard/client/setup.mjs; the prompt carries its SHA-256.
 *
 * Commands (run `node setup.mjs help`):
 *   enrol --hub <url> --ca-sha256 <hex> [--stdin]   swap the single-use code for the PC key (keys.env)
 *   schema                                          the request schema and an example, for the agent drafting it
 *   request --file <path> [--check] [--amend]       validate, then file (or amend) the request
 *   status | withdraw                               the current request
 *   wait --transport https|http [--lan-url <url>] [--root <dir>] [--replace] [--max-minutes <0-9, default 1>]
 *        [--request <obr_…>]                        long-poll until approved, then pickup, keys, folders, login tests;
 *                                                   --request takes that request (a recruit's pickup) beside the current one
 *   check [--https | --http [--lan-url <url>]]      the doctor; --https/--http also switch the MCP transport
 *   trust [--apply]                                 the commands that make Claude Code trust the hub's CA
 *   key [--stdin]                                   a key prompt's pickup code (onboarding/key-code) into keys.env
 *
 * Secrets: the enrolment code is read from ~/.config/conclave/onboarding/enrol-code, a key pickup code from
 * ~/.config/conclave/onboarding/key-code (or either from stdin with --stdin), never from the command line.
 * Keys go straight into keys.env (temporary file, then rename; mode 600 off Windows). The script
 * prints variable names, folders and results, never a key, a token or the code.
 *
 * Every step is recorded in ~/.config/conclave/onboarding/state.json (no secrets), so rerunning a command resumes.
 * Exit codes: 0 done, 1 failed, 2 usage, 3 still waiting, 4 changes asked, 5 request closed (denied, withdrawn, cancelled).
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, rmSync, chmodSync, statSync, copyFileSync, accessSync, readdirSync, constants as FS } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { X509Certificate, createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import https from 'node:https';
import http from 'node:http';

const VERSION = '1';
const HOME = homedir();
const CONF = join(HOME, '.config', 'conclave');
const OB = join(CONF, 'onboarding');
const STATE_FILE = join(OB, 'state.json');
const CODE_FILE = join(OB, 'enrol-code');
const KEY_CODE_FILE = join(OB, 'key-code');
const KEYS_FILE = join(CONF, 'keys.env');
const CA_FILE = join(CONF, 'hub-ca.pem');
const HELPER = join(CONF, 'agent-hub-headers.mjs');
const CLAUDE_JSON = join(HOME, '.claude.json');
const CLAUDE_JSON_HOME = CLAUDE_JSON;
const WIN = platform() === 'win32';
const POLL_S = 45;
const EXIT = { ok: 0, fail: 1, usage: 2, waiting: 3, changes: 4, closed: 5 };
const SECRET_RE = /(ah_(app|ses)_[a-z2-7]{12}_\S+|cnv_enrol_[a-z2-7]{26}|cnc-pair-[a-z2-7]{26}|cnv_key_[a-z2-7]{26})/gi;

// ───────────── output (never a secret) ─────────────
const scrub = (s) => String(s).replace(SECRET_RE, '[redacted]');
const out = (s = '') => process.stdout.write(scrub(s) + '\n');
class Fail extends Error { constructor(msg, code = EXIT.fail) { super(msg); this.exitCode = code; } }
const die = (msg, code = EXIT.fail) => { throw new Fail(msg, code); };
const fwd = (p) => p.replace(/\\/g, '/');

// ───────────── arguments ─────────────
function parseArgs(argv) {
  const [cmd = 'help', ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) die(`unexpected argument: ${a}`, EXIT.usage);
    const k = a.slice(2);
    if (k === 'code') die('--code is refused: write the code to ~/.config/conclave/onboarding/enrol-code (or pass it on stdin with --stdin), so it never shows in the process list', EXIT.usage);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) flags[k] = true; else { flags[k] = next; i++; }
  }
  return { cmd, flags };
}
const str = (flags, k) => (typeof flags[k] === 'string' ? flags[k] : undefined);

// ───────────── state ─────────────
/**
 * The state file, or a fresh state when there is none. A file that cannot be read as JSON is kept as state.json.corrupt-<time>
 * (it may hold the enrol nonce) and the user is told, so nothing is lost silently.
 */
export function loadState() {
  let text;
  try { text = readFileSync(STATE_FILE, 'utf8'); } catch { return { version: VERSION, requests: {} }; }
  try { return JSON.parse(text); } catch {
    const keep = `${STATE_FILE}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try { copyFileSync(STATE_FILE, keep); } catch { /* the warning below still says it */ }
    out(`warning: ${STATE_FILE} is not valid JSON; starting a fresh state. The old file is kept as ${keep}.`);
    return { version: VERSION, requests: {} };
  }
}
/** A session key's id (its public part, ah_ses_<id>_...), never its value; null for anything else. */
export const keyIdOf = (v) => /^ah_ses_([a-z2-7]{12})_/.exec(String(v ?? '').trim())?.[1] ?? null;
/**
 * The check of one folder's key by key id only (docs/onboarding.md, "Setup checks"): what keys.env holds for the variable
 * the folder's .agent-hub.json names, against the id setup wrote. Returns a problem sentence or null.
 */
export function keyIdProblem(sessionVar, have, wrote) {
  if (!have) return null; // a missing key is reported on its own
  if (wrote && have !== wrote) return `${sessionVar} in keys.env has key id ${have}, but setup wrote ${wrote}: another setup or a hand edit replaced it`;
  return null;
}
function saveState(s) {
  mkdirSync(OB, { recursive: true });
  atomicWrite(STATE_FILE, JSON.stringify(s, null, 2) + '\n', false);
}
function atomicWrite(path, text, secret) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, text, { mode: secret ? 0o600 : 0o644 });
  if (secret && !WIN) chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

// ───────────── keys.env (values never leave this module) ─────────────
function readKeys() {
  let text = '';
  try { text = readFileSync(KEYS_FILE, 'utf8'); } catch { /* none yet */ }
  const map = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    map.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  return { text, map };
}
/** Sets variables in keys.env, keeping every other line (comments included): a temporary file in the same folder, then a rename. */
function writeKeys(updates) {
  const { text } = readKeys();
  const lines = text ? text.split(/\r?\n/) : ['# Conclave keys: readable by you only. Written by setup.mjs and by hand.'];
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const left = new Map(Object.entries(updates));
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const k = t.slice(0, t.indexOf('=')).trim();
    if (left.has(k)) { lines[i] = `${k}=${left.get(k)}`; left.delete(k); }
  }
  for (const [k, v] of left) lines.push(`${k}=${v}`);
  atomicWrite(KEYS_FILE, lines.join('\n') + '\n', true);
}

// ───────────── HTTP with the pinned CA ─────────────
function hubOf(state) {
  if (!state.hub) die('This PC is not enrolled yet: run `node setup.mjs enrol --hub <url> --ca-sha256 <fingerprint>` first.');
  return state.hub;
}
const isLoopback = (u) => ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(new URL(u).hostname);
function caPem(state) {
  if (!state.hub || new URL(state.hub).protocol !== 'https:') return undefined;
  let pem;
  try { pem = readFileSync(CA_FILE, 'utf8'); } catch { die(`the pinned CA certificate is missing (${CA_FILE}); rerun enrol`); }
  if (fingerprint(pem) !== state.ca_sha256) die('the CA certificate on disk does not match the pinned fingerprint; rerun enrol');
  return pem;
}
const fingerprint = (pem) => new X509Certificate(pem).fingerprint256.replace(/:/g, '').toLowerCase();

/** One request. `pin`: a CA (PEM) trusted alone; `noVerify` only for the public CA download, whose bytes are then checked. */
function call(url, { method = 'GET', key, body, pin, noVerify = false, timeoutMs = 20_000, headers: extra = {} } = {}) {
  const u = new URL(url);
  const mod = u.protocol === 'https:' ? https : http;
  const data = body === undefined ? undefined : JSON.stringify(body);
  const headers = { accept: 'application/json', ...extra };
  if (data !== undefined) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
  if (key) headers.authorization = `Bearer ${key}`;
  const tls = u.protocol === 'https:' ? (noVerify ? { rejectUnauthorized: false } : pin ? { ca: pin } : {}) : {};
  return new Promise((ok, no) => {
    const req = mod.request(u, { method, headers, timeout: timeoutMs, ...tls, agent: false }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400) { r.resume(); return no(new Fail(`${u.pathname}: the hub answered a redirect (${r.statusCode}); not following it`)); }
      let raw = '';
      r.setEncoding('utf8');
      r.on('data', (c) => { raw += c; });
      r.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch { /* not JSON */ }
        ok({ status: r.statusCode, json, text: raw });
      });
      r.on('error', (e) => no(new Fail(`${u.pathname}: ${e.code || e.message}`)));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', (e) => no(new Fail(`Can't reach the hub at ${u.origin}${u.pathname} (${e.code || e.message}).`)));
    req.end(data);
  });
}
/** A call to the pinned hub; throws a one-line Fail with the hub's own error. */
async function hubCall(state, path, opts = {}) {
  const r = await call(hubOf(state) + path, { ...opts, pin: caPem(state) });
  if (r.status >= 200 && r.status < 300) return r.json ?? {};
  const e = r.json ?? {};
  const err = new Fail(`hub: ${e.error || `HTTP ${r.status}`}${e.message ? `: ${e.message}` : ''}`);
  err.hub = e; err.status = r.status;
  throw err;
}
const appKey = () => readKeys().map.get('AGENT_HUB_APP_KEY') || die('keys.env has no AGENT_HUB_APP_KEY: enrol first');

// ───────────── enrol ─────────────
async function enrol(flags) {
  const hubArg = str(flags, 'hub'), caArg = str(flags, 'ca-sha256');
  if (!hubArg) die('enrol needs --hub <url> (the hub URL from the prompt)', EXIT.usage);
  const hub = hubArg.replace(/\/+$/, '');
  let u;
  try { u = new URL(hub); } catch { die(`not a URL: ${hub}`, EXIT.usage); }
  if (u.protocol === 'http:' && !isLoopback(hub)) die('enrol needs the hub\'s HTTPS URL; plain HTTP is used only on this computer (loopback)', EXIT.usage);
  if (u.protocol === 'https:' && !/^[0-9a-f]{64}$/i.test(caArg ?? '')) die('enrol needs --ca-sha256 <64 hex characters> (the CA fingerprint from the prompt)', EXIT.usage);
  const state = loadState();

  let code = null;
  if (flags.stdin) code = readFileSync(0, 'utf8').trim();
  else if (existsSync(CODE_FILE)) code = readFileSync(CODE_FILE, 'utf8').trim();
  else if (str(flags, 'code-env') && process.env[str(flags, 'code-env')]) code = process.env[str(flags, 'code-env')].trim();
  const codeHash = code ? createHash('sha256').update(code).digest('hex') : null;
  const keys = readKeys().map;

  // Already enrolled with this hub, and no new code: nothing to do but the doctor.
  if (state.hub === hub && state.enrol?.confirmed && keys.get('AGENT_HUB_APP_KEY') && (!code || codeHash === state.enrol.code_sha256)) {
    if (code && !flags.stdin) rmSync(CODE_FILE, { force: true });
    out(`This PC is already enrolled with ${hub} as "${state.pc?.name ?? '?'}". Running check instead.`);
    return flags.quiet ? EXIT.ok : check({}, state);
  }
  if (!code) die(`No enrolment code: write it to ${CODE_FILE} with your file tool (or pass it on stdin with --stdin), then rerun.`, EXIT.usage);
  // A PC key set up by hand (not by this script) is not replaced silently: its agents would lose their logins.
  if (keys.get('AGENT_HUB_APP_KEY') && !(state.hub === hub && state.enrol?.keys_written) && !flags.replace) die('keys.env already holds an AGENT_HUB_APP_KEY that this script did not write. Enrolling replaces it, and agents that use it stop working. Rerun with --replace only if that is intended (for example a re-enrolled PC).');
  if (!/^(?:cnc-pair-|cnv_enrol_)[a-z2-7]{26}$/.test(code)) die('The enrolment code does not look right (cnc-pair- and 26 characters). Copy it again from the prompt.', EXIT.usage);

  // Pin the CA: download it (public), check its fingerprint against the prompt, keep it as the only trusted root.
  if (u.protocol === 'https:') {
    const r = await call(`${hub}/onboard/ca.crt`, { noVerify: true });
    if (r.status !== 200) die(`Can't get the hub's CA certificate (${hub}/onboard/ca.crt: HTTP ${r.status}).`);
    let fp;
    try { fp = fingerprint(r.text); } catch { die('The hub sent a CA certificate that cannot be read.'); }
    if (fp !== caArg.toLowerCase()) die('The hub\'s CA certificate does not match the fingerprint in the prompt. Stopping: do not continue on this network until the administrator confirms the hub.');
    mkdirSync(CONF, { recursive: true });
    atomicWrite(CA_FILE, r.text, false);
  }
  state.version = VERSION;
  state.hub = hub; state.ca_sha256 = caArg ? caArg.toLowerCase() : null;
  const health = await call(`${hub}/health`, { pin: caPem(state) });
  if (health.status !== 200) die(`Can't reach the hub at ${hub} (health: HTTP ${health.status}).`);

  // A retry of the same code reuses its nonce (a lost response); a new code gets a new one.
  if (!state.enrol || state.enrol.code_sha256 !== codeHash || state.enrol.confirmed) state.enrol = { nonce: randomBytes(18).toString('base64url'), code_sha256: codeHash, confirmed: false };
  saveState(state);
  // restore sends the code in a header (never a URL); the hub redacts that header from its logs.
  const e = await hubCall(state, '/onboard/enrol', flags.header
    ? { method: 'POST', body: { nonce: state.enrol.nonce }, headers: { 'x-conclave-enrol-code': code } }
    : { method: 'POST', body: { code, nonce: state.enrol.nonce } });
  if (typeof e.app_key !== 'string') die('The hub did not return the PC key.');
  writeKeys({ AGENT_HUB_APP_KEY: e.app_key, AGENT_HUB_URL: `${hub}/mcp`, ...(u.protocol === 'https:' ? { AGENT_HUB_CA: fwd(CA_FILE) } : {}) });
  state.pc = e.pc ?? null;
  state.enrol.keys_written = true;
  saveState(state);
  await hubCall(state, '/onboard/enrol/confirm', { method: 'POST', body: { nonce: state.enrol.nonce } });
  state.enrol.confirmed = true; state.enrol.confirmed_at = new Date().toISOString();
  saveState(state);
  if (!flags.stdin) rmSync(CODE_FILE, { force: true });
  out(`Enrolled this PC as "${state.pc?.name ?? '?'}" with ${hub}.`);
  out(`keys.env: AGENT_HUB_APP_KEY, AGENT_HUB_URL${u.protocol === 'https:' ? ', AGENT_HUB_CA' : ''} written (${KEYS_FILE}).`);
  return EXIT.ok;
}

// ───────────── key: a key prompt's pickup (docs/onboarding.md#key-prompts-a-new-rotated-or-reissued-session-key) ─────────────
/**
 * Swaps a key prompt's single-use pickup code for the session key and writes it into keys.env under the variable the hub
 * names. Needs no onboarding state: the hub, its CA and this PC's key come from keys.env. Prints only the variable name.
 */
async function keyCmd(flags) {
  let code = null;
  if (flags.stdin) code = readFileSync(0, 'utf8').trim();
  else if (existsSync(KEY_CODE_FILE)) code = readFileSync(KEY_CODE_FILE, 'utf8').trim();
  if (!code) die(`No key pickup code: write it to ${KEY_CODE_FILE} with your file tool (or pass it on stdin with --stdin), then rerun.`, EXIT.usage);
  if (!/^cnv_key_[a-z2-7]{26}$/.test(code)) die('The key pickup code does not look right (cnv_key_ and 26 characters). Copy it again from the prompt.', EXIT.usage);
  const keys = readKeys().map, app = appKey();
  const url = keys.get('AGENT_HUB_URL');
  if (!url) die('keys.env has no AGENT_HUB_URL: enrol this PC first');
  const hub = url.replace(/\/mcp\/?$/, '').replace(/\/+$/, '');
  let pin;
  if (new URL(hub).protocol === 'https:') {
    const ca = keys.get('AGENT_HUB_CA') || CA_FILE;
    try { pin = readFileSync(ca, 'utf8'); } catch { die(`the hub's CA certificate is missing (${ca}); rerun enrol`); }
  } else if (!isLoopback(hub)) die('keys.env names a plain-HTTP hub that is not on this computer; the key is fetched over HTTPS only');
  const r = await call(`${hub}/onboard/key-pickup`, { method: 'POST', key: app, body: { code }, pin });
  if (r.status < 200 || r.status >= 300) {
    const e = r.json ?? {};
    die(`hub: ${e.error || `HTTP ${r.status}`}${e.message ? `: ${e.message}` : ''}`);
  }
  const k = r.json ?? {};
  if (typeof k.secret !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(k.session_var ?? '')) die('The hub did not return the key.');
  writeKeys({ [k.session_var]: k.secret });
  { const st = loadState(); st.key_ids = { ...(st.key_ids ?? {}), [k.session_var]: keyIdOf(k.secret) }; saveState(st); } // the id only, for status checks
  if (!flags.stdin) rmSync(KEY_CODE_FILE, { force: true });
  out(`keys.env: ${k.session_var} written for "${k.label ?? '?'}" on ${k.pc ?? 'this PC'} (${KEYS_FILE}).`);
  return EXIT.ok;
}

// ───────────── the request: schema and validation ─────────────
const LIMITS = { roles: 8, agents: 12, per_role: 5, rules: 20, requirements: 30, lines: 10, per_line: 10, papers: 20 };
const PAPER_STATUSES = ['planned', 'drafting', 'submitted', 'accepted', 'published'];
const PAPER_TYPES = ['paper', 'preprint', 'report', 'thesis'];
const LOCAL_ID = /^[a-z0-9][a-z0-9_-]{0,19}$/;
const NFR_CATEGORIES = ['perf', 'sec', 'rel', 'use', 'ops'];
const RULE_CATEGORIES = ['access', 'communication', 'tokens', 'reporting', 'sources', 'process', 'tooling'];
const TEAM_ROLES = ['coordinator', 'worker', 'reviewer', 'stakeholder'];
export const SCHEMA = {
  kind: '"new_team" (default), "add_agents", or "vault_agent" (one agent with no team that edits a person\'s shared vault notes; it takes only agent, folders, prompt and client)',
  agent: 'vault_agent only: { name: 1-60 chars, ^[A-Za-z0-9][A-Za-z0-9 ._-]*$, job: 1-500 chars one line }',
  folders: 'vault_agent only: 1-10 of { path: "/vault/...", access: "read"|"write" }. A proposal: the administrator picks the person the agent works for, and only folders that person was given can be granted',
  project: '{ name: 1-80 chars, ^[A-Za-z0-9][A-Za-z0-9 ._-]*$, existing: boolean, kind?: "implementation"|"research" (a new project: ask the user; an existing project supplies its own), more_teams?: boolean (new_team only: true when more teams will join this project, so this team gets its own Blueprint part; default false, and the only team of the project keeps its whole Blueprint at project level. Ask the user) }',
  team: '{ name (new_team) | id (add_agents), goal: 1-4000 chars, delivery_mode?: "on_demand"|"poll", close_on_approve?: bool, coordinator_reviews?: bool, lease_minutes?: 1-1440, stall_minutes?: 1-1440, max_review_rounds?: 1-20 }',
  roles: `1-${LIMITS.roles} of { name: ^[a-z][a-z0-9_]{0,29}$, team_role: "coordinator"|"worker"|"reviewer"|"stakeholder", count: 1-${LIMITS.per_role}, job: 1-500 chars one line, reviews?: [role names], folders?: [{ path: "/vault/...", access: "read"|"write" }] }; new_team: exactly one coordinator with count 1; at most ${LIMITS.agents} agents`,
  rules: `optional, 0-${LIMITS.rules} of { title: 1-120 chars one line, source: 1-200 chars one line (where the rule comes from: "AGENTS.md", "CLAUDE.md", "the user"), text: 1-2000 chars (the rule as written), category?: ${RULE_CATEGORIES.map((c) => `"${c}"`).join('|')}, role?: a team_role of a role in the request (omit: the whole team) }. Fill it from the repo's AGENTS.md and CLAUDE.md files and the user's own instructions: one entry per rule the agents should follow. The administrator ticks the ones to keep; they become the team's directives. Keep rules out of team.goal: the goal says what the team achieves`,
  requirements: `optional, new_team only, 0-${LIMITS.requirements} of { kind: "fr" (what the team's work must do) | "nfr" (a quality: speed, security, reliability, usability, operations), title: 1-200 chars one line, text: 1-2000 chars, category: ${NFR_CATEGORIES.map((c) => `"${c}"`).join('|')} (nfr only, required), acs?: 0-10 acceptance criteria, each 1-300 chars one line }. Fill it from the repo's specification or the user's own words; the administrator ticks the ones to keep and reviews them in the team's Blueprint part`,
  source: 'new_team: { from: "existing" (a source that exists: ref is its path or URL, 1-400 chars one line) | "coordinator" (the team\'s coordinator derives them) | "operator" (the user supplies them later), ref?, note?: at most 500 chars }. Ask the user where the requirements or the research brief come from. A ref is information for the team, not a permission to read it',
  research: `optional, new_team only: { lines: 0-${LIMITS.lines} of { id: ^[a-z0-9][a-z0-9_-]{0,19}$, title: 1-200 chars one line, mode: "validate"|"explore", question?: at most 2000 chars, owner?: a role name, hypotheses?: 0-${LIMITS.per_line} of { id, title: the statement, criteria? } (validate lines only), questions?: 0-${LIMITS.per_line} of { title, criteria? } }, papers: 0-${LIMITS.papers} of { title, status: ${PAPER_STATUSES.join('|')}, venue?, type?: ${PAPER_TYPES.join('|')}, manuscript?: a path or URL, authors?: names, owner?: a role name, hypotheses?: [hypothesis ids] } }. Lines need a research project; papers fit either. A planned paper needs only a title; never write claims. Requirements and research records count together against the requirements limit`,
  prompt: "1-4000 chars: the user's own words",
  client: '{ app, os }: at most 40 chars each',
};
export const EXAMPLE = {
  kind: 'new_team',
  project: { name: 'Grants', existing: false },
  team: { name: 'Grant calendar', goal: 'Keep the grant calendar current: deadlines, owners and status.' },
  roles: [
    { name: 'coordinator', team_role: 'coordinator', count: 1, job: 'Plans the work and assigns tasks.' },
    { name: 'writer', team_role: 'worker', count: 1, job: 'Writes and updates calendar entries.', folders: [{ path: '/vault/Grants', access: 'write' }] },
    { name: 'reviewer', team_role: 'reviewer', count: 1, job: 'Reviews each entry before it is done.', reviews: ['writer'] },
  ],
  rules: [
    { title: 'Dates in ISO format', source: 'AGENTS.md', text: 'Write every date as YYYY-MM-DD.', category: 'process' },
    { title: 'Check each deadline against the funder page', source: 'the user', text: 'Before an entry is done, open the funder page and compare the deadline.', category: 'sources', role: 'reviewer' },
  ],
  requirements: [
    { kind: 'fr', title: 'Every deadline has an owner', text: 'Each calendar entry names the person who owns the deadline.', acs: ['No entry is done without an owner.'] },
    { kind: 'nfr', title: 'Entries are current within a day', text: 'A change on the funder page shows in the calendar within one working day.', category: 'rel' },
  ],
  source: { from: 'existing', ref: 'docs/specification.md', note: 'The calendar section.' },
  prompt: 'a team that keeps our grant calendar, with a writer and a reviewer',
  client: { app: 'claude-code', os: platform() },
};

/** The same rules the hub applies (the hub stays the judge, with its current limits); up to 20 problems. */
export function validateRequest(r) {
  const p = [];
  const add = (field, rule) => { if (p.length < 20) p.push({ field, rule }); };
  const isStr = (v, min, max) => typeof v === 'string' && v.length >= min && v.length <= max;
  const intIn = (v, a, b) => Number.isInteger(v) && v >= a && v <= b;
  if (!r || typeof r !== 'object' || Array.isArray(r)) return [{ field: 'body', rule: 'a JSON object' }];
  if (Buffer.byteLength(JSON.stringify(r)) > 32 * 1024) add('body', 'at most 32 KiB of JSON');
  const kind = r.kind ?? 'new_team';
  if (kind === 'vault_agent') {
    // One teamless agent for shared vault notes (docs/onboarding.md#a-vault-agent): no project, team, roles or rules.
    for (const k of Object.keys(r)) if (!['kind', 'agent', 'folders', 'prompt', 'client'].includes(k)) add(k, 'unknown field (vault_agent takes agent, folders, prompt and client)');
    const a = r.agent;
    if (!a || typeof a !== 'object' || Array.isArray(a)) add('agent', 'an object {name, job}');
    else {
      if (!isStr(a.name, 1, 60) || !/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(a.name)) add('agent.name', '1-60 characters, letters, digits, space . _ -, starting with a letter or digit');
      if (!isStr(a.job, 1, 500) || /[\r\n]/.test(a.job)) add('agent.job', '1-500 characters, one line');
      for (const k of Object.keys(a)) if (k !== 'name' && k !== 'job') add(`agent.${k}`, 'unknown field');
    }
    if (!Array.isArray(r.folders) || r.folders.length < 1 || r.folders.length > 10) add('folders', '1-10 {path, access}: the vault folders the agent asks for');
    else r.folders.forEach((d, j) => {
      const ff = `folders[${j}]`;
      if (!d || typeof d.path !== 'string' || !/^\/vault(\/|$)/.test(d.path) || d.path.length > 400 || d.path.split('/').includes('..') || /[*?[\]{}]/.test(d.path)) add(`${ff}.path`, 'absolute under /vault/, no .., no wildcards, at most 400 characters');
      if (!d || !['read', 'write'].includes(d.access)) add(`${ff}.access`, 'read or write');
    });
    if (!isStr(r.prompt, 1, 4000)) add('prompt', "1-4000 characters: the user's own words");
    return p;
  }
  if (!['new_team', 'add_agents'].includes(kind)) add('kind', 'new_team, add_agents or vault_agent');
  if (!r.project || typeof r.project !== 'object') add('project', '{name, existing}');
  else {
    if (!isStr(r.project.name, 1, 80) || !/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(r.project.name)) add('project.name', '1-80 characters, letters, digits, space . _ -, starting with a letter or digit');
    if (typeof r.project.existing !== 'boolean') add('project.existing', 'true or false');
    if (r.project.kind !== undefined && !['implementation', 'research'].includes(r.project.kind)) add('project.kind', 'implementation or research');
    if (r.project.more_teams !== undefined && typeof r.project.more_teams !== 'boolean') add('project.more_teams', 'true or false');
    if (r.project.more_teams !== undefined && kind !== 'new_team') add('project.more_teams', 'only for a new_team request');
  }
  const t = r.team;
  if (!t || typeof t !== 'object') add('team', 'an object');
  else {
    if (kind === 'add_agents') { if (!isStr(t.id, 1, 100)) add('team.id', 'the team id (add_agents)'); }
    else {
      if (!isStr(t.name, 1, 80)) add('team.name', '1-80 characters');
      if (!isStr(t.goal, 1, 4000)) add('team.goal', '1-4000 characters');
    }
    if (t.delivery_mode !== undefined && !['on_demand', 'poll'].includes(t.delivery_mode)) add('team.delivery_mode', 'on_demand or poll');
    for (const b of ['close_on_approve', 'coordinator_reviews']) if (t[b] !== undefined && typeof t[b] !== 'boolean') add(`team.${b}`, 'true or false');
    for (const [k, a, z] of [['lease_minutes', 1, 1440], ['stall_minutes', 1, 1440], ['max_review_rounds', 1, 20]]) if (t[k] !== undefined && !intIn(t[k], a, z)) add(`team.${k}`, `${a} to ${z}`);
  }
  const roles = Array.isArray(r.roles) ? r.roles : null;
  if (!roles || roles.length < 1 || roles.length > LIMITS.roles) add('roles', `1 to ${LIMITS.roles} roles`);
  if (roles) {
    const names = new Set(roles.map((x) => x?.name));
    let total = 0, coords = 0;
    roles.forEach((x, i) => {
      const f = `roles[${i}]`;
      if (!x || typeof x !== 'object') return add(f, 'an object');
      if (typeof x.name !== 'string' || !/^[a-z][a-z0-9_]{0,29}$/.test(x.name)) add(`${f}.name`, '^[a-z][a-z0-9_]{0,29}$');
      if (roles.filter((y) => y?.name === x.name).length > 1) add(`${f}.name`, 'unique in the request');
      if (!['coordinator', 'worker', 'reviewer', 'stakeholder'].includes(x.team_role)) add(`${f}.team_role`, 'coordinator, worker, reviewer or stakeholder');
      if (!intIn(x.count, 1, LIMITS.per_role)) add(`${f}.count`, `1 to ${LIMITS.per_role}`); else total += x.count;
      if (x.team_role === 'coordinator') { coords++; if (x.count !== 1) add(`${f}.count`, 'the coordinator has count 1'); }
      if (!isStr(x.job, 1, 500) || /[\r\n]/.test(x.job)) add(`${f}.job`, '1-500 characters, one line');
      if (x.reviews !== undefined) {
        if (!Array.isArray(x.reviews)) add(`${f}.reviews`, 'a list of role names');
        else for (const n of x.reviews) {
          if (!names.has(n)) add(`${f}.reviews`, `${n} is not a role in the request`);
          else if (n === x.name && !(x.count >= 2)) add(`${f}.reviews`, 'a role reviews itself only with count 2 or more');
          else if (roles.find((y) => y.name === n)?.team_role === 'coordinator' && !t?.coordinator_reviews) add(`${f}.reviews`, 'the coordinator reviews only with team.coordinator_reviews: true');
        }
      }
      if (x.folders !== undefined) {
        if (!Array.isArray(x.folders) || x.folders.length > 10) add(`${f}.folders`, 'at most 10 {path, access}');
        else x.folders.forEach((d, j) => {
          const ff = `${f}.folders[${j}]`;
          if (!d || typeof d.path !== 'string' || !/^\/vault(\/|$)/.test(d.path) || d.path.length > 400 || d.path.split('/').includes('..') || /[*?[\]{}]/.test(d.path)) add(`${ff}.path`, 'absolute under /vault/, no .., no wildcards, at most 400 characters');
          if (!d || !['read', 'write'].includes(d.access)) add(`${ff}.access`, 'read or write');
        });
      }
    });
    if (total > LIMITS.agents) add('roles', `${total} agents, at most ${LIMITS.agents}`);
    if (kind === 'new_team' && coords !== 1) add('roles', 'exactly one role with team_role "coordinator" (count 1)');
    if (kind === 'add_agents' && coords !== 0) add('roles', 'no coordinator role when adding agents');
  }
  if (r.rules !== undefined) {
    if (!Array.isArray(r.rules) || r.rules.length > LIMITS.rules) add('rules', `a list of at most ${LIMITS.rules} rules`);
    else {
      const teamRoles = new Set((Array.isArray(r.roles) ? r.roles : []).map((x) => x?.team_role));
      r.rules.forEach((x, i) => {
        const f = `rules[${i}]`;
        if (!x || typeof x !== 'object' || Array.isArray(x)) return add(f, 'an object {title, source, text, category?, role?}');
        const line = (v, max) => isStr(typeof v === 'string' ? v.trim() : v, 1, max) && !/[\r\n]/.test(v.trim());
        if (!line(x.title, 120)) add(`${f}.title`, '1-120 characters, one line');
        if (!line(x.source, 200)) add(`${f}.source`, '1-200 characters, one line: where the rule comes from');
        if (!isStr(typeof x.text === 'string' ? x.text.trim() : x.text, 1, 2000)) add(`${f}.text`, '1-2000 characters');
        if (x.category !== undefined && !RULE_CATEGORIES.includes(x.category)) add(`${f}.category`, RULE_CATEGORIES.join(', '));
        if (x.role !== undefined) {
          if (!TEAM_ROLES.includes(x.role)) add(`${f}.role`, 'a team role: coordinator, worker, reviewer or stakeholder');
          else if (kind === 'new_team' && !teamRoles.has(x.role)) add(`${f}.role`, 'the team_role of a role in the request');
        }
        for (const k of Object.keys(x)) if (!['title', 'source', 'text', 'category', 'role'].includes(k)) add(`${f}.${k}`, 'unknown field');
      });
    }
  }
  if (r.requirements !== undefined) {
    if (kind !== 'new_team') add('requirements', 'only in a new_team request');
    else if (!Array.isArray(r.requirements) || r.requirements.length > LIMITS.requirements) add('requirements', `a list of at most ${LIMITS.requirements} requirements`);
    else r.requirements.forEach((x, i) => {
      const f = `requirements[${i}]`;
      if (!x || typeof x !== 'object' || Array.isArray(x)) return add(f, 'an object {kind, title, text, category?, acs?}');
      const line = (v, max) => typeof v === 'string' && isStr(v.trim(), 1, max) && !/[\r\n]/.test(v.trim());
      if (!['fr', 'nfr'].includes(x.kind)) add(`${f}.kind`, 'fr or nfr');
      if (!line(x.title, 200)) add(`${f}.title`, '1-200 characters, one line');
      if (!isStr(typeof x.text === 'string' ? x.text.trim() : x.text, 1, 2000)) add(`${f}.text`, '1-2000 characters');
      if (x.kind === 'nfr' && !NFR_CATEGORIES.includes(x.category)) add(`${f}.category`, NFR_CATEGORIES.join(', '));
      if (x.kind === 'fr' && x.category !== undefined) add(`${f}.category`, 'only for an nfr');
      if (x.acs !== undefined) {
        if (!Array.isArray(x.acs) || x.acs.length > 10) add(`${f}.acs`, 'at most 10 acceptance criteria');
        else x.acs.forEach((a, j) => { if (!line(a, 300)) add(`${f}.acs[${j}]`, '1-300 characters, one line'); });
      }
      if (x.module !== undefined && (typeof x.module !== 'string' || !/^[A-Z]{2,6}$/.test(x.module))) add(`${f}.module`, 'a module key of the project, 2 to 6 capitals');
      for (const k of Object.keys(x)) if (!['kind', 'title', 'text', 'category', 'acs', 'module'].includes(k)) add(`${f}.${k}`, 'unknown field');
    });
  }
  const one = (v, max) => typeof v === 'string' && isStr(v.trim(), 1, max) && !/[\r\n]/.test(v.trim());
  if (r.source !== undefined) {
    const s = r.source;
    if (kind !== 'new_team') add('source', 'only in a new_team request');
    else if (!s || typeof s !== 'object' || Array.isArray(s)) add('source', '{from, ref?, note?}');
    else {
      if (!['existing', 'coordinator', 'operator'].includes(s.from)) add('source.from', 'existing, coordinator or operator');
      if (s.from === 'existing' && !one(s.ref, 400)) add('source.ref', 'the path or URL of the source, 1-400 characters, one line');
      if (s.from !== 'existing' && s.ref !== undefined) add('source.ref', 'only with from: existing');
      if (s.note !== undefined && !isStr(s.note, 1, 500)) add('source.note', 'at most 500 characters');
      for (const k of Object.keys(s)) if (!['from', 'ref', 'note'].includes(k)) add(`source.${k}`, 'unknown field');
    }
  }
  let records = Array.isArray(r.requirements) ? r.requirements.length : 0;
  if (r.research !== undefined) {
    const x = r.research;
    if (kind !== 'new_team') add('research', 'only in a new_team request');
    else if (!x || typeof x !== 'object' || Array.isArray(x)) add('research', '{lines, papers}');
    else {
      const ids = new Set(), hyps = new Set(), roles = new Set((r.roles ?? []).map((q) => q?.name));
      const id = (v, f) => { if (typeof v !== 'string' || !LOCAL_ID.test(v)) add(f, '^[a-z0-9][a-z0-9_-]{0,19}$'); else if (ids.has(v)) add(f, 'unique in the request'); else ids.add(v); };
      const owner = (v, f) => { if (v !== undefined && !roles.has(v)) add(f, 'a role name in the request'); };
      const lines = x.lines ?? [], papers = x.papers ?? [];
      if (!Array.isArray(lines) || lines.length > LIMITS.lines) add('research.lines', `at most ${LIMITS.lines} lines`);
      else lines.forEach((l, i) => {
        const f = `research.lines[${i}]`;
        if (!l || typeof l !== 'object') return add(f, 'an object {id, title, mode, ...}');
        records += 1;
        id(l.id, `${f}.id`);
        if (!one(l.title, 200)) add(`${f}.title`, '1-200 characters, one line');
        if (!['validate', 'explore'].includes(l.mode)) add(`${f}.mode`, 'validate or explore');
        if (l.question !== undefined && !isStr(l.question, 1, 2000)) add(`${f}.question`, 'at most 2000 characters');
        owner(l.owner, `${f}.owner`);
        for (const [key, max] of [['hypotheses', LIMITS.per_line], ['questions', LIMITS.per_line]]) {
          const L = l[key] ?? [];
          if (!Array.isArray(L) || L.length > max) { add(`${f}.${key}`, `at most ${max}`); continue; }
          if (key === 'hypotheses' && L.length && l.mode === 'explore') add(`${f}.hypotheses`, 'a line that explores has no hypotheses');
          L.forEach((h, j) => {
            const g = `${f}.${key}[${j}]`;
            records += 1;
            if (key === 'hypotheses') { id(h?.id, `${g}.id`); if (typeof h?.id === 'string') hyps.add(h.id); }
            if (!one(h?.title, 200)) add(`${g}.title`, '1-200 characters, one line');
            if (h?.criteria !== undefined && !isStr(h.criteria, 1, 2000)) add(`${g}.criteria`, 'at most 2000 characters');
          });
        }
      });
      if (Array.isArray(lines) && lines.length && r.project?.existing === false && r.project?.kind !== 'research') add('research.lines', 'lines need a research project: set project.kind "research"');
      if (!Array.isArray(papers) || papers.length > LIMITS.papers) add('research.papers', `at most ${LIMITS.papers} papers`);
      else papers.forEach((pp, i) => {
        const f = `research.papers[${i}]`;
        if (!pp || typeof pp !== 'object') return add(f, 'an object {title, status, ...}');
        records += 1;
        if (!one(pp.title, 200)) add(`${f}.title`, '1-200 characters, one line');
        if (!PAPER_STATUSES.includes(pp.status)) add(`${f}.status`, PAPER_STATUSES.join(', '));
        if (pp.type !== undefined && !PAPER_TYPES.includes(pp.type)) add(`${f}.type`, PAPER_TYPES.join(', '));
        if (pp.manuscript !== undefined && !one(pp.manuscript, 400)) add(`${f}.manuscript`, 'a path or URL, 1-400 characters, one line');
        if (pp.authors !== undefined && (!Array.isArray(pp.authors) || pp.authors.length > 20)) add(`${f}.authors`, 'at most 20 names');
        owner(pp.owner, `${f}.owner`);
        if (pp.hypotheses !== undefined) (Array.isArray(pp.hypotheses) ? pp.hypotheses : [null]).forEach((h, j) => { if (!hyps.has(h)) add(`${f}.hypotheses[${j}]`, 'the id of a hypothesis in research.lines'); });
        if (pp.claims !== undefined) add(`${f}.claims`, 'no claims: a paper\'s claims are the team\'s work');
      });
    }
  }
  if (records > LIMITS.requirements) add('requirements', `${records} records (requirements, lines, hypotheses, questions and papers together), at most ${LIMITS.requirements}`);
  if (!isStr(r.prompt, 1, 4000)) add('prompt', "1-4000 characters: the user's own words");
  if (r.client !== undefined) {
    if (!r.client || typeof r.client !== 'object') add('client', '{app, os}');
    else for (const k of ['app', 'os']) if (r.client[k] !== undefined && !isStr(r.client[k], 0, 40)) add(`client.${k}`, 'at most 40 characters');
  }
  if (SECRET_RE.test(JSON.stringify(r))) add('body', 'contains something that looks like a key or code; remove it');
  SECRET_RE.lastIndex = 0;
  return p;
}
/** The hub's warning (docs/onboarding.md#warnings): a goal that reads like a list of rules. */
export function goalHasRules(goal) {
  if (typeof goal !== 'string') return false;
  const lines = goal.split(/\r?\n/).filter((l) => /^\s*(?:[-*•]|\d+[.)])\s+\S/.test(l)).length;
  const words = (goal.match(/\b(?:never|always|must|do not|don't)\b/gi) ?? []).length;
  return lines >= 2 || words >= 3;
}
/** The one-screen summary the agent shows the user before filing. */
export function summary(r) {
  const lines = [];
  if (r.kind === 'vault_agent') {
    lines.push(`Vault agent: ${r.agent?.name}, with no team`, `Job: ${r.agent?.job}`);
    for (const d of r.folders ?? []) lines.push(`- ${d.path} (${d.access})`);
    lines.push('The folders are a proposal: the administrator picks the person it works for, and it can reach only folders that person shares.');
    return lines.join('\n');
  }
  lines.push(`Project: ${r.project?.name} (${r.project?.existing ? 'existing' : 'new'}${r.project?.kind ? `, ${r.project.kind}` : ''})`);
  if ((r.kind ?? 'new_team') === 'new_team') {
    const s = r.source, from = { existing: `an existing source: ${s?.ref}`, coordinator: 'the coordinator derives them', operator: 'you supply them later' }[s?.from];
    lines.push(from ? `Requirements or brief come from ${from}.` : 'Warning: the request does not say where the requirements or the brief come from. Ask the user, and set `source`.');
    lines.push(r.project?.more_teams ? 'More teams will join: this team gets its own Blueprint part.' : "One team for now: the project's whole Blueprint stays at project level.");
  }
  lines.push((r.kind ?? 'new_team') === 'add_agents' ? `Add agents to team ${r.team?.id}` : `Team: ${r.team?.name} · ${r.team?.delivery_mode ?? 'on_demand'}`);
  if (r.team?.goal) lines.push(`Goal: ${r.team.goal}`);
  if (goalHasRules(r.team?.goal)) lines.push('Warning: the goal reads like a list of rules. Move the rules to `rules` and keep the goal to what the team achieves.');
  let n = 0;
  for (const x of r.roles ?? []) {
    n += x.count;
    const f = (x.folders ?? []).map((d) => `${d.path} (${d.access})`).join(', ');
    lines.push(`- ${x.name} × ${x.count} [${x.team_role}]: ${x.job}${x.reviews?.length ? ` · reviews ${x.reviews.join(', ')}` : ''}${f ? ` · folders ${f}` : ''}`);
  }
  lines.push(`${n} agent${n === 1 ? '' : 's'} in total. Folders and access are a proposal: the administrator sets the real access.`);
  if (r.rules?.length) {
    lines.push(`Rules for the team (${r.rules.length}; the administrator keeps the ones that become directives):`);
    for (const x of r.rules) lines.push(`- ${x.title} (${x.source}${x.role ? `, ${x.role}s` : ''})`);
  }
  if (r.requirements?.length) {
    lines.push(`Requirements (${r.requirements.length}; the administrator keeps the ones that go to the team's Blueprint part as one proposal):`);
    for (const x of r.requirements) lines.push(`- ${x.kind.toUpperCase()}${x.category ? ` ${x.category}` : ''}: ${x.title}${x.acs?.length ? ` · ${x.acs.length} acceptance criteria` : ''}`);
  }
  if (r.research?.lines?.length || r.research?.papers?.length) {
    lines.push('Research (the administrator keeps the ones that join the same proposal):');
    for (const l of r.research.lines ?? []) lines.push(`- Line (${l.mode}): ${l.title}${l.hypotheses?.length ? ` · ${l.hypotheses.length} hypotheses` : ''}${l.questions?.length ? ` · ${l.questions.length} questions` : ''}${l.owner ? ` · ${l.owner}` : ''}`);
    for (const p of r.research.papers ?? []) lines.push(`- Paper (${p.status}): ${p.title}${p.manuscript ? ` · ${p.manuscript}` : ''}${p.owner ? ` · ${p.owner}` : ''}`);
  }
  if ((r.kind ?? 'new_team') === 'new_team') lines.push('Every new team also gets two standard directives, "Who decides" and "What stays with the operator", which the administrator may reword.');
  return lines.join('\n');
}

function schemaCmd() {
  out('The request (JSON) that `node setup.mjs request --file <path>` files. Limits are the hub defaults; the hub checks its current settings.');
  for (const [k, v] of Object.entries(SCHEMA)) out(`  ${k}: ${v}`);
  out('Example:');
  out(JSON.stringify(EXAMPLE, null, 2));
  return EXIT.ok;
}

async function requestCmd(flags) {
  const file = str(flags, 'file');
  if (!file) die('request needs --file <path>', EXIT.usage);
  let body;
  try { body = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { die(`cannot read ${file} as JSON: ${e.code || e.message}`, EXIT.usage); }
  const problems = validateRequest(body);
  if (problems.length) {
    out('The request has problems:');
    for (const x of problems) out(`- ${x.field}: ${x.rule}`);
    return EXIT.usage;
  }
  if (flags.check) { out('The request is valid. Summary:'); out(summary(body)); return EXIT.ok; }
  const state = loadState(), key = appKey();
  let res;
  if (flags.amend) {
    const cur = state.current && state.requests[state.current];
    if (!cur) die('There is no current request to amend.');
    const st = await hubCall(state, `/onboard/requests/${cur.id}`, { key });
    res = await hubCall(state, `/onboard/requests/${cur.id}`, { method: 'PUT', key, body: { ...body, version: st.version } });
  } else {
    try {
      res = await hubCall(state, '/onboard/requests', { method: 'POST', key, body });
    } catch (e) {
      if (e.hub?.error === 'invalid_state') out('Use `node setup.mjs status` to see it, then wait for it, amend it (request --amend) or withdraw it.');
      if (Array.isArray(e.hub?.problems)) for (const x of e.hub.problems) out(`- ${x.field}: ${x.rule}`);
      throw e;
    }
  }
  state.requests[res.request_id] = { ...(state.requests[res.request_id] ?? {}), id: res.request_id, kind: res.kind ?? body.kind ?? 'new_team', project: body.project?.name, team_name: body.team?.name ?? body.agent?.name ?? res.team_name ?? null, state: res.state, version: res.version, filed_at: res.filed_at };
  state.current = res.request_id;
  saveState(state);
  out(`${flags.amend ? 'Amended' : 'Filed'} request ${res.request_id} (${res.state}). Summary:`);
  out(summary(body));
  for (const w of res.warnings ?? []) out(`warning ${w.code}: ${w.message}`);
  out('Next: node setup.mjs wait --transport https|http');
  return EXIT.ok;
}

async function statusCmd() {
  const state = loadState(), key = appKey();
  const pend = await hubCall(state, '/onboard/requests?pending=1', { key });
  if (!pend.requests?.length) out('No pending request on this PC.');
  for (const r of pend.requests ?? []) out(`${r.request_id} · ${r.team_name ?? '?'} · ${r.state} · filed ${ago(r.filed_at)}${r.operator_note ? ` · note from the administrator: ${r.operator_note}` : ''}`);
  return EXIT.ok;
}
async function withdrawCmd() {
  const state = loadState(), key = appKey();
  const cur = state.current && state.requests[state.current];
  if (!cur) die('There is no current request to withdraw.');
  const r = await hubCall(state, `/onboard/requests/${cur.id}/withdraw`, { method: 'POST', key });
  cur.state = r.state; delete state.current;
  saveState(state);
  out(`Withdrew request ${cur.id}.`);
  return EXIT.ok;
}
function ago(ms) {
  if (!ms) return '?';
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
}

// ───────────── wait, pickup, folders ─────────────
function transportOf(state, flags) {
  const t = str(flags, 'transport') ?? state.transport;
  if (t !== 'https' && t !== 'http') die('wait needs --transport https or --transport http (ask the user how Claude Code should reach the hub)', EXIT.usage);
  const lan = (str(flags, 'lan-url') ?? state.lan_url ?? '').replace(/\/+$/, '') || null;
  if (t === 'http') {
    const base = lan ?? (new URL(hubOf(state)).protocol === 'http:' ? state.hub : null);
    if (!base) die('--transport http needs --lan-url <the LAN plain-HTTP URL from the prompt>', EXIT.usage);
    if (!/^http:\/\//.test(base)) die('--lan-url must be an http:// URL', EXIT.usage);
    return { transport: t, lan: lan ?? null, base };
  }
  if (new URL(hubOf(state)).protocol !== 'https:' && !isLoopback(state.hub)) die('this hub has no HTTPS URL', EXIT.usage);
  return { transport: t, lan, base: state.hub };
}
const mcpUrl = (base) => `${base.replace(/\/+$/, '')}/mcp`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const crashPoint = (name) => { if (process.env.CONCLAVE_SETUP_CRASH_AFTER === name) { out(`(test) stopping after ${name}`); process.exit(137); } };

async function waitCmd(flags) {
  const state = loadState(), key = appKey();
  const tr = transportOf(state, flags);
  state.transport = tr.transport; if (tr.lan) state.lan_url = tr.lan;
  let cur = state.current && state.requests[state.current];
  const want = str(flags, 'request');
  if (flags.request !== undefined && !/^obr_[a-z0-9]{1,40}$/i.test(want ?? '')) die('--request needs a request id (obr_…)', EXIT.usage);
  if (want && cur?.id !== want) {
    // A recruit's pickup (docs/onboarding.md#recruits-from-a-coordinator): the hub filed it for this PC, so the state file
    // may not know it. It does not replace the current request. Its folder goes beside the team's other folders.
    const st = await hubCall(state, `/onboard/requests/${want}`, { key });
    cur = state.requests[want] = { ...(state.requests[want] ?? {}), id: want, kind: st.kind, team_id: st.team_id, team_name: st.team_name, state: st.state, version: st.version, filed_at: st.filed_at };
    const same = Object.values(state.requests).find((r) => r.id !== want && r.team_id && r.team_id === st.team_id && r.root);
    if (!cur.root && same && !str(flags, 'root')) cur.root = same.root;
  }
  if (!cur) {
    const pend = await hubCall(state, '/onboard/requests?pending=1', { key });
    const r = pend.requests?.[0];
    if (!r) die('There is no request to wait for: file one with `node setup.mjs request --file <path>`.');
    cur = state.requests[r.request_id] = { ...(state.requests[r.request_id] ?? {}), id: r.request_id, kind: r.kind, team_name: r.team_name, state: r.state, version: r.version, filed_at: r.filed_at };
    state.current = r.request_id;
  }
  if (!cur.root) cur.root = resolve(str(flags, 'root') ?? process.cwd());
  if (tr.transport === 'http') out('warning: this PC talks to the hub over plain HTTP; keys cross the network unencrypted at login.');
  saveState(state);

  // Default 1 minute: a plain run ends inside Claude Code's 2-minute default command timeout. The prompt asks for
  // --max-minutes 9 with a 600000 ms timeout. Either way the script exits on its own, so the model never sees a kill.
  const maxMin = Number(str(flags, 'max-minutes') ?? 1);
  if (!Number.isFinite(maxMin) || maxMin < 0 || maxMin > 9) die('--max-minutes: 0 to 9', EXIT.usage);
  const deadline = Date.now() + Math.max(0, maxMin) * 60_000;
  let lastLine = null, version;
  for (;;) {
    const left = Math.floor((deadline - Date.now()) / 1000);
    const w = version === undefined ? 0 : Math.max(0, Math.min(POLL_S, left)); // the first call answers at once
    let st;
    try {
      st = await hubCall(state, `/onboard/requests/${cur.id}?wait_s=${w}${version !== undefined ? `&version=${version}` : ''}`, { key, timeoutMs: (w + 20) * 1000 });
    } catch (e) {
      if (e.hub?.error === 'rate_limited') { await sleep(Math.min(60, Number(e.hub.retry_after_s) || 30) * 1000); continue; }
      throw e;
    }
    version = st.version;
    cur.state = st.state; cur.version = st.version; cur.team_id = st.team_id ?? cur.team_id; cur.team_name = st.team_name ?? cur.team_name;
    if (st.project) cur.project = st.project;
    saveState(state);
    let line;
    if (st.state === 'submitted') line = `Waiting for the administrator · filed ${ago(st.filed_at)}`;
    else if (st.state === 'needs_changes') {
      out(`Changes asked by the administrator (their words): ${st.operator_note ?? '(no note)'}`);
      out('Amend the request with `node setup.mjs request --file <path> --amend`, or withdraw it.');
      return EXIT.changes;
    } else if (['denied', 'withdrawn', 'cancelled'].includes(st.state)) {
      out(`The request was ${st.state}${st.operator_note ? `. Note from the administrator (their words): ${st.operator_note}` : '.'}`);
      delete state.current; saveState(state);
      return EXIT.closed;
    } else if (st.state === 'approved' || st.state === 'collected') {
      if (st.edits?.length) out(`Approved with ${st.edits.length} edit${st.edits.length === 1 ? '' : 's'} by the administrator.`); else if (st.state === 'approved') out('Approved.');
      return setUp(state, cur, st, tr, flags);
    }
    if (line && line !== lastLine) { out(line); lastLine = line; }
    if (Date.now() >= deadline) {
      out("Still waiting for approval; rerun the prompt (or say 'continue') once it is approved.");
      return EXIT.waiting;
    }
  }
}

function folderOf(cur, a) {
  return resolve(cur.root, safeSeg(cur.project ?? (cur.kind === 'vault_agent' ? 'vault-agents' : 'project')), safeSeg(a.folder));
}
const safeSeg = (s) => String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/^\.+$/, '-').trim() || '-';

/** Before pickup: a variable already in keys.env (not ours), or a folder that belongs to another variable, stops setup. */
function collisions(state, cur, agents, replace) {
  const keys = readKeys().map, problems = [];
  const ours = new Set(cur.written ?? []);
  for (const a of agents) {
    if (keys.has(a.session_var) && !ours.has(a.session_var) && !replace) problems.push(`${a.session_var} already exists in keys.env (rerun with --replace only if it is this same agent and its old key is dead)`);
    const dir = folderOf(cur, a);
    try {
      const cfg = JSON.parse(readFileSync(join(dir, '.agent-hub.json'), 'utf8'));
      if (cfg.session_var && cfg.session_var !== a.session_var) problems.push(`${dir} belongs to ${cfg.session_var}`);
    } catch { /* free */ }
  }
  return problems;
}

async function setUp(state, cur, st, tr, flags) {
  const key = appKey();
  if (!cur.confirmed && st.state === 'approved') {
    if (!(cur.pickup_id && cur.keys_written_for === cur.pickup_id)) {
      const problems = collisions(state, cur, st.agents ?? [], !!flags.replace);
      if (problems.length) {
        for (const p of problems) out(`fail collision: ${p}`);
        out('Nothing was picked up. Use another root folder (--root), --replace, or ask the administrator to rename.');
        return EXIT.fail;
      }
      const p = await hubCall(state, '/onboard/pickup', { method: 'POST', key, body: { request_id: cur.id } });
      cur.pickup_id = p.pickup_id; cur.team_id = p.team?.id ?? cur.team_id; cur.team_name = p.team?.name ?? cur.team_name;
      cur.agents = p.agents.map(({ secret, ...a }) => a); // instructions, labels, variables, folders: no secrets
      saveState(state);
      writeKeys(Object.fromEntries(p.agents.map((a) => [a.session_var, a.secret])));
      cur.key_ids = Object.fromEntries(p.agents.map((a) => [a.session_var, keyIdOf(a.secret)])); // ids only, for status checks
      for (const a of p.agents) a.secret = undefined;
      cur.written = p.agents.map((a) => a.session_var);
      cur.keys_written_for = p.pickup_id;
      saveState(state);
      out(`keys.env: ${cur.written.join(', ')} written.`);
      crashPoint('keys_written');
    }
    let c;
    try {
      c = await hubCall(state, '/onboard/pickup/confirm', { method: 'POST', key, body: { pickup_id: cur.pickup_id, written: cur.written, transport: tr.transport } });
    } catch (e) {
      if (e.hub?.error === 'invalid_state' && /pickup again/i.test(e.hub.message ?? '')) {
        cur.pickup_id = null; cur.keys_written_for = null; saveState(state);
        out('The pickup was replaced; picking up again.');
        return setUp(state, cur, { ...st, state: 'approved' }, tr, flags);
      }
      throw e;
    }
    cur.confirmed = true; cur.state = 'collected'; cur.team_status = c.team_status ?? null; cur.started = !!c.started;
    saveState(state);
    crashPoint('confirmed');
  } else if (!cur.confirmed && st.state === 'collected') {
    if (!cur.keys_written_for) die('The hub says these keys were already collected, but not by this setup. Ask the administrator to re-enrol this PC.');
    cur.confirmed = true; cur.state = 'collected';
    saveState(state);
  }

  // Folders, from the state (pickup's agent list), so a rerun rebuilds them without a new pickup.
  const backup = { done: false };
  const results = [];
  for (const a of cur.agents ?? []) {
    const dir = folderOf(cur, a);
    buildFolder(dir, a, tr, backup);
    (cur.folders ??= []).includes(dir) || cur.folders.push(dir);
    saveState(state);
  }
  setKeysUrl(tr);
  state.transport = tr.transport;
  saveState(state);
  for (const a of cur.agents ?? []) {
    const dir = folderOf(cur, a);
    const t = loginTest(dir);
    results.push({ a, dir, t });
    out(`${t.ok ? 'ok  ' : 'fail'} login ${a.session_var}: ${t.ok ? 'ok' : t.error} · ${dir}`);
  }
  const allOk = results.every((r) => r.t.ok);
  const coord = (cur.agents ?? []).find((a) => a.team_role === 'coordinator');
  if (tr.transport === 'http') out('warning: this PC talks to the hub over plain HTTP; keys cross the network unencrypted at login.');
  if (tr.transport === 'https') out('Claude Code needs to trust the hub certificate for these folders: run `node setup.mjs trust` for the commands, then restart Claude Code.');
  out('Folder trust is in ~/.claude.json. A Claude Code session that is open now can overwrite it when it saves; if an agent session shows the trust dialog or has no hub tools, run `node setup.mjs check`, which re-applies it.');
  if (cur.kind === 'vault_agent') out(`Vault agent "${cur.team_name ?? '?'}": set up, with no team. Open its folder in Claude Code to use it.`);
  else out(`Team "${cur.team_name ?? '?'}": ${cur.team_status ?? 'set up'}${cur.started ? ' (started)' : ''}.`);
  if (cur.kind === 'vault_agent') { /* no coordinator and no team notices */ }
  else if (coord) out(`coordinator folder: ${folderOf(cur, coord)}`);
  else out('New agents added: the coordinator sees them in its team notices.');
  if (allOk) { cur.done = true; if (state.current === cur.id) delete state.current; }
  saveState(state);
  return allOk ? EXIT.ok : EXIT.fail;
}

function buildFolder(dir, a, tr, backup) {
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeJson(join(dir, '.agent-hub.json'), { session_var: a.session_var });
  writeMcp(dir, tr.base);
  const sp = join(dir, '.claude', 'settings.local.json');
  const s = readJson(sp) ?? {};
  const en = new Set(Array.isArray(s.enabledMcpjsonServers) ? s.enabledMcpjsonServers : []);
  en.add('agent-hub');
  s.enabledMcpjsonServers = [...en];
  writeJson(sp, s);
  const md = join(dir, 'CLAUDE.md');
  if (!existsSync(md) && a.instructions) { writeFileSync(md, a.instructions.endsWith('\n') ? a.instructions : a.instructions + '\n'); markOwn(md); }
  markOwn(join(dir, '.agent-hub.json'), sp);
  if (!existsSync(join(dir, '.git'))) execFileSync('git', ['init', '-q', dir], { stdio: ['ignore', 'ignore', 'pipe'] });
  const ex = join(dir, '.git', 'info', 'exclude');
  mkdirSync(dirname(ex), { recursive: true });
  const cur = existsSync(ex) ? readFileSync(ex, 'utf8') : '';
  if (!cur.split(/\r?\n/).includes('*')) writeFileSync(ex, (cur && !cur.endsWith('\n') ? cur + '\n' : cur) + '*\n');
  trustFolder(dir, backup);
}
/** One shell word. POSIX: single quotes, so $, backticks, double quotes and backslashes stay literal. Windows: double quotes (a path has no " there). */
export function shellQuote(p, win = WIN) {
  return win ? `"${p}"` : `'${p.replaceAll("'", "'\\''")}'`;
}
/** The headersHelper command line Claude Code runs through a shell: node, the helper and the agent folder. */
export function helperCommand(helper, dir, win = WIN) {
  return `node ${shellQuote(fwd(helper), win)} ${shellQuote(fwd(dir), win)}`;
}
function writeMcp(dir, base) {
  const p = join(dir, '.mcp.json');
  const j = readJson(p) ?? {};
  j.mcpServers = { ...(j.mcpServers ?? {}), 'agent-hub': { type: 'http', url: mcpUrl(base), headersHelper: helperCommand(HELPER, dir) } };
  writeJson(p, j);
  markOwn(p);
}
/**
 * The agent config files setup.mjs wrote: {path: sha256 of the bytes it wrote}, in onboarding/owned.json. The config scan
 * (§6 step 4) skips an untracked file whose bytes still match, so a rerun over its own output finds nothing. Any later
 * change (by hand, or Claude Code saving an allow rule) makes it a finding again. A tracked file is never skipped.
 * Files written by a client older than this record are reported once; the run that follows records them.
 */
const OWN_FILE = join(OB, 'owned.json');
const ownKey = (p) => { const k = fwd(resolve(p)); return WIN ? k.toLowerCase() : k; };
const fileSha = (p) => { try { return createHash('sha256').update(readFileSync(p)).digest('hex'); } catch { return null; } };
export function markOwn(...paths) {
  const m = readJson(OWN_FILE) ?? {};
  for (const p of paths) { const h = fileSha(p); if (h) m[ownKey(p)] = h; }
  atomicWrite(OWN_FILE, JSON.stringify(m, null, 2) + '\n', false);
}
export function isOwn(p) { const h = fileSha(p); return !!h && (readJson(OWN_FILE) ?? {})[ownKey(p)] === h; }
function setKeysUrl(tr) { writeKeys({ AGENT_HUB_URL: mcpUrl(tr.base) }); }
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const writeJson = (p, j) => atomicWrite(p, JSON.stringify(j, null, 2) + '\n', false);

/** The keys Claude Code uses for a folder in ~/.claude.json: forward slashes, and on Windows also the native form. */
const trustKeys = (dir) => (WIN ? [...new Set([fwd(dir), dir])] : [dir]);
/** Folder trust in a Claude Code config: ~/.claude.json, or $CLAUDE_CONFIG_DIR/.claude.json for another config root (restore). */
function trustFolder(dir, backup, CLAUDE_JSON = CLAUDE_JSON_HOME) {
  let j = {};
  if (existsSync(CLAUDE_JSON)) {
    const raw = readFileSync(CLAUDE_JSON, 'utf8');
    try { j = JSON.parse(raw); } catch { die(`${CLAUDE_JSON} is not valid JSON; not touching it. Open claude once in ${dir} and accept the trust dialog, then rerun.`); }
    const want = trustKeys(dir).every((k) => j.projects?.[k]?.hasTrustDialogAccepted === true);
    if (want) return;
    if (!backup.done) { copyFileSync(CLAUDE_JSON, `${CLAUDE_JSON}.conclave-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`); backup.done = true; }
  }
  j.projects ??= {};
  for (const k of trustKeys(dir)) j.projects[k] = { ...(j.projects[k] ?? {}), hasTrustDialogAccepted: true };
  atomicWrite(CLAUDE_JSON, JSON.stringify(j, null, 2) + '\n', false);
}

/** Runs the helper as Claude Code would; its own one-line error on failure. Its output (the headers) is never printed. */
function loginTest(dir) {
  if (!existsSync(HELPER)) return { ok: false, error: `the headers helper is missing (${HELPER}); download it again` };
  const r = spawnSync(process.execPath, [HELPER, dir], { cwd: dir, encoding: 'utf8', timeout: 15_000, env: process.env });
  if (r.status === 0) {
    try { const h = JSON.parse(r.stdout); if (h.Authorization && h['X-Agent-Hub-Session']) return { ok: true }; } catch { /* below */ }
    return { ok: false, error: 'the helper printed no headers' };
  }
  const line = (r.stderr || '').split(/\r?\n/).find(Boolean) ?? (r.error ? r.error.message : `exit ${r.status}`);
  return { ok: false, error: scrub(line.replace(/^agent-hub-headers:\s*/, '')) };
}

// ───────────── trust (Claude Code's own MCP over HTTPS) ─────────────
function trustCommands() {
  const pem = fwd(CA_FILE);
  if (WIN) return [
    ['certutil', ['-user', '-addstore', 'Root', CA_FILE], `certutil -user -addstore Root "${CA_FILE}"   (Windows asks you to confirm)`],
    ['setx', ['NODE_EXTRA_CA_CERTS', CA_FILE], `setx NODE_EXTRA_CA_CERTS "${CA_FILE}"`],
  ];
  return [[null, null, `add to your shell profile: export NODE_EXTRA_CA_CERTS="${pem}"   (or NODE_USE_SYSTEM_CA=1 on Node 23.8 and later, after adding the certificate to the system store)`]];
}
function trustCmd(flags) {
  const state = loadState();
  hubOf(state); caPem(state);
  out(`The hub's CA certificate (fingerprint checked): ${CA_FILE}`);
  out('Trusting it means this PC trusts that CA for every name. The commands:');
  for (const [, , label] of trustCommands()) out(`  ${label}`);
  if (!flags.apply) { out('Run them only after the user agrees: `node setup.mjs trust --apply`. Then restart Claude Code.'); return EXIT.ok; }
  for (const [bin, args, label] of trustCommands()) {
    if (!bin) { out(`by hand: ${label}`); continue; }
    const r = spawnSync(bin, args, { stdio: 'inherit' });
    out(`${r.status === 0 ? 'ok  ' : 'fail'} ${bin}${r.status === 0 ? '' : ` (exit ${r.status})`}`);
    if (r.status !== 0) return EXIT.fail;
  }
  out('Restart Claude Code so its sessions see the new trust.');
  return EXIT.ok;
}
function trustStatus(state) {
  const pem = CA_FILE;
  const env = process.env.NODE_EXTRA_CA_CERTS || (WIN ? regEnv('NODE_EXTRA_CA_CERTS') : null);
  const sys = process.env.NODE_USE_SYSTEM_CA === '1' || (WIN && regEnv('NODE_USE_SYSTEM_CA') === '1');
  let store = null;
  if (WIN) {
    try { const sha1 = new X509Certificate(readFileSync(pem, 'utf8')).fingerprint.replace(/:/g, ''); store = spawnSync('certutil', ['-user', '-store', 'Root', sha1], { stdio: 'ignore' }).status === 0; } catch { store = false; }
  }
  const envOk = !!env && resolve(env) === resolve(pem);
  return { ok: envOk || (sys && store !== false), detail: `NODE_EXTRA_CA_CERTS ${envOk ? 'set' : env ? 'points elsewhere' : 'not set'}${sys ? ', NODE_USE_SYSTEM_CA=1' : ''}${store === null ? '' : `, Windows user store ${store ? 'has it' : 'lacks it'}`}` };
}
function regEnv(name) {
  const r = spawnSync('reg', ['query', 'HKCU\\Environment', '/v', name], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const m = new RegExp(`${name}\\s+REG_\\w+\\s+(.+)`).exec(r.stdout);
  return m ? m[1].trim() : null;
}

// ───────────── check (the doctor) ─────────────
async function check(flags, preState) {
  const state = preState ?? loadState();
  let failed = 0;
  const line = (ok, what, msg) => { if (!ok) failed++; out(`${ok ? 'ok  ' : 'fail'} ${what}: ${msg}`); };

  // Switching the transport rewrites the folders' URL and keys.env's AGENT_HUB_URL; everything else only reads.
  if (flags.https || flags.http) {
    const tr = transportOf(state, { transport: flags.https ? 'https' : 'http', 'lan-url': str(flags, 'lan-url') });
    for (const cur of Object.values(state.requests ?? {})) for (const d of cur.folders ?? []) if (existsSync(d)) writeMcp(d, tr.base);
    setKeysUrl(tr);
    state.transport = tr.transport; if (tr.lan) state.lan_url = tr.lan;
    saveState(state);
    out(`Switched the folders to ${tr.transport.toUpperCase()} (${mcpUrl(tr.base)}).`);
    if (tr.transport === 'https') out('Then: `node setup.mjs trust` for the trust commands, and restart Claude Code.');
    else out('warning: this PC talks to the hub over plain HTTP; keys cross the network unencrypted at login.');
  }

  const major = Number(process.versions.node.split('.')[0]);
  line(major >= 18, 'node', `${process.version}${major >= 18 ? '' : ' (18 or later is needed)'}`);
  const g = spawnSync('git', ['--version'], { encoding: 'utf8' });
  line(g.status === 0, 'git', g.status === 0 ? g.stdout.trim() : 'not on the path');
  for (const [what, p] of [['config', CONF], ['claude.json', existsSync(CLAUDE_JSON) ? CLAUDE_JSON : HOME]]) {
    let ok = true; try { accessSync(p, FS.W_OK); } catch { ok = false; }
    line(ok, what, `${p} ${ok ? 'writable' : 'not writable'}`);
  }
  if (!state.hub) { line(false, 'enrolment', 'this PC is not enrolled (run enrol with the prompt)'); return failed ? EXIT.fail : EXIT.ok; }

  let pin = null;
  try { pin = caPem(state); if (pin) line(true, 'ca', `pinned fingerprint matches (${CA_FILE})`); } catch (e) { line(false, 'ca', e.message); }
  try {
    const h = await call(`${state.hub}/health`, { pin: pin ?? undefined, timeoutMs: 8000 });
    line(h.status === 200, 'hub', `${state.hub} ${h.status === 200 ? 'reachable' : `HTTP ${h.status}`} (${new URL(state.hub).protocol === 'https:' ? 'HTTPS, CA pinned' : 'plain HTTP, loopback'})`);
  } catch (e) { line(false, 'hub', e.message); }
  try {
    const m = await call(`${state.hub}/onboard/client/manifest`, { pin: pin ?? undefined, timeoutMs: 8000 });
    for (const [name, p] of [['setup.mjs', join(CONF, 'setup.mjs')], ['agent-hub-headers.mjs', HELPER]]) {
      const want = m.json?.files?.[name]?.sha256;
      let have = null; try { have = createHash('sha256').update(readFileSync(p, 'utf8').replace(/\r\n/g, '\n')).digest('hex'); } catch { /* missing */ }
      if (name === 'setup.mjs' && !have) continue; // may run from elsewhere
      line(!!have && (!want || have === want), name, !have ? `missing (${p})` : want && have !== want ? 'differs from the hub\'s copy (download it again over the pinned HTTPS URL)' : 'matches the hub');
    }
  } catch { /* the hub line already says it */ }

  const transport = state.transport ?? null;
  if (transport === 'https') { const t = trustStatus(state); line(t.ok, 'trust', `Claude Code over HTTPS: ${t.detail}`); }
  else if (transport === 'http') line(true, 'trust', 'plain HTTP by your choice (warning: keys cross the network unencrypted at login)');

  const keys = readKeys().map;
  const need = ['AGENT_HUB_APP_KEY', 'AGENT_HUB_URL', ...(new URL(state.hub).protocol === 'https:' ? ['AGENT_HUB_CA'] : [])];
  const missing = need.filter((k) => !keys.get(k));
  line(!missing.length, 'keys', missing.length ? `missing ${missing.join(', ')} in ${KEYS_FILE}` : `${need.join(', ')} present`);
  if (!WIN) { try { const m = statSync(KEYS_FILE).mode & 0o077; line(!m, 'keys mode', m ? `${KEYS_FILE} is readable by others (chmod 600)` : '600'); } catch { /* reported above */ } }

  // The Claude Code session that ran the prompt can rewrite ~/.claude.json from its own copy after setup, dropping the
  // folders' trust. The doctor puts it back (after one backup), and says so; it is the only thing it repairs.
  const backup = { done: false };
  for (const cur of Object.values(state.requests ?? {})) for (const a of cur.agents ?? []) {
    const dir = folderOf(cur, a);
    if (!existsSync(dir)) continue;
    const before = readJson(CLAUDE_JSON) ?? {};
    if (trustKeys(dir).every((k) => before.projects?.[k]?.hasTrustDialogAccepted === true)) continue;
    try { trustFolder(dir, backup); line(true, `trust ${a.session_var}`, `re-applied in ${CLAUDE_JSON} (it had been dropped, probably by a Claude Code session saving its own copy); restart Claude Code if it was open`); }
    catch (e) { line(false, `trust ${a.session_var}`, e.message); }
  }
  const claude = readJson(CLAUDE_JSON) ?? {};
  let lines = [];
  try { lines = readFileSync(join(CONF, 'helper.log'), 'utf8').split(/\r?\n/).filter(Boolean); } catch { /* none yet */ }
  for (const cur of Object.values(state.requests ?? {})) {
    for (const a of cur.agents ?? []) {
      const dir = folderOf(cur, a);
      const tag = `${a.session_var}`;
      if (!existsSync(dir)) { line(false, `folder ${tag}`, `${dir} no longer exists (moved? see docs/mcp.md)`); continue; }
      const mcp = readJson(join(dir, '.mcp.json'))?.mcpServers?.['agent-hub'];
      const cfg = readJson(join(dir, '.agent-hub.json'));
      const probs = [];
      if (!mcp?.url || !mcp?.headersHelper) probs.push('.mcp.json has no agent-hub server');
      else if (mcp.url !== keys.get('AGENT_HUB_URL')) probs.push('.mcp.json URL differs from AGENT_HUB_URL');
      if (cfg?.session_var !== a.session_var) probs.push('.agent-hub.json names another variable');
      if (!existsSync(join(dir, '.git'))) probs.push('not a git repository');
      if (!trustKeys(dir).some((k) => claude.projects?.[k]?.hasTrustDialogAccepted)) probs.push('not trusted in ~/.claude.json');
      if (!keys.get(a.session_var)) probs.push(`${a.session_var} missing in keys.env`);
      const kid = keyIdOf(keys.get(cfg?.session_var ?? a.session_var));
      const kp = keyIdProblem(a.session_var, kid, state.key_ids?.[a.session_var] ?? cur.key_ids?.[a.session_var]);
      if (kp) probs.push(kp);
      const want = resolve(dir);
      const last = [...lines].reverse().find((l) => l.includes(`dir=${want}`) || l.includes(`dir=${fwd(want)}`));
      line(!probs.length, `folder ${tag}`, probs.length ? `${probs.join('; ')} · ${dir}` : `${dir} (mcp, git, trust, key${kid ? ' id ' + kid : ''})`);
      const t = loginTest(dir);
      line(t.ok, `login ${tag}`, t.ok ? 'ok' : `${t.error}${kid ? ` (key id ${kid}: compare it with the agent's key in the console)` : ''}`);
      out(`     helper.log ${tag}: ${last ? last : 'no line yet (Claude Code has not run the helper here; see docs/mcp.md if a session there has no hub tools)'}`);
    }
  }
  return failed ? EXIT.fail : EXIT.ok;
}

function help() {
  out(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(2, 27).map((l) => l.replace(/^ \* ?/, '')).join('\n'));
  return EXIT.ok;
}

// ───────────── main ─────────────
const COMMANDS = { enrol, schema: schemaCmd, request: requestCmd, status: statusCmd, withdraw: withdrawCmd, wait: waitCmd, check: (f) => check(f), trust: trustCmd, key: keyCmd, help };
const isMain = (() => { try { return resolve(process.argv[1] ?? '').toLowerCase() === resolve(fileURLToPath(import.meta.url)).toLowerCase(); } catch { return false; } })();
if (isMain) {
  let code;
  try {
    const { cmd, flags } = parseArgs(process.argv.slice(2));
    const fn = COMMANDS[cmd];
    if (!fn) die(`unknown command: ${cmd} (try help)`, EXIT.usage);
    code = await fn(flags);
  } catch (e) {
    if (e instanceof Fail) { process.stderr.write(`setup: ${scrub(e.message)}\n`); code = e.exitCode; }
    else { process.stderr.write(`setup: ${scrub(e?.code || e?.message || e)}\n`); code = EXIT.fail; }
  }
  process.exitCode = code ?? EXIT.ok;
}
