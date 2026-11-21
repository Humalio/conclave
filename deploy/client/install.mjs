#!/usr/bin/env node
/**
 * The Conclave connector installer (docs/onboarding.md, "The installer"; docs/connector-release.md). Node 18 or later,
 * no dependencies, one file. This is the template: the release script (`connector-release.mjs sign`) writes
 * `conclave-install-<version>.mjs` from it with the version and the public release keys filled in, and publishes it on
 * the GitHub Releases page with the release. A copy without them refuses to run.
 *
 *   node conclave-install-<version>.mjs [--from <folder>] [--no-service] [--no-screen] [--no-browser]
 *   echo <code> | node conclave-install-<version>.mjs --pair - --hub <origin> --ca <fingerprint> [--from <folder>]
 *
 * `--pair -` pairs the PC with the hub with no screen and no click (docs/onboarding.md, "The prompt"). The one-time pairing code
 * is read from standard input only, never from an argument (an argument is refused, and so is a terminal with nothing piped in),
 * so it is not in the installer's own command line. (A hand-typed echo still reaches the shell history, and a wrapper such as bash -c holds it in its arguments for a few seconds; the code is single use and spent at pairing.) The installed connector checks the hub's CA against `--ca` and the
 * origin against `--hub` before it sends the code (a mismatch stops with nothing sent), pairs, and only then starts the service.
 *
 * It checks the release before anything of it runs, with no hub involved: the manifest's Ed25519 signature against the
 * keys it carries, that the manifest is for exactly its version and this platform, and that the bundle's size, hash and
 * file paths match the signed manifest. An unsigned, changed or older release is refused and nothing is installed.
 * `--from` takes the three release files from a folder (a PC that only reaches the LAN gets them from the hub); without
 * it they are downloaded from the Releases page. Then it installs the build into the connector's folder, installs the
 * logon service as the user, and opens the local pairing screen. It prints the release key's id, for the user to compare
 * with the one on the Releases page. CONCLAVE_HOME overrides ~/.config/conclave.
 */
import https from 'node:https';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// The release script replaces the next line. Its value: {version, release_base, keys: [{id, public_key}]}.
const EMBED = /*@@CONCLAVE_INSTALLER_EMBED@@*/null;

const MANIFEST_FORMAT = 'conclave-connector-release/1';
const VERSION_RE = /^\d+\.\d+\.\d+(-[a-z0-9.]+)?$/;
const FILE_RE = /^(?:deploy\/client|bridge)(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)+$/;
const MAX_BUNDLE = 25 * 1024 * 1024;
const LINES = {
  not_built: 'This installer was not made by the Conclave release script, so it has no release key to check against. Download it again from the Releases page.',
  unsigned: 'The release is not signed. Nothing was installed.',
  unknown_key: 'The release is signed by a key this installer does not know. Nothing was installed.',
  bad_signature: 'The release\'s signature does not match: it was changed after it was signed. Nothing was installed.',
  manifest_invalid: 'The release manifest is not valid. Nothing was installed.',
  version_mismatch: 'The release is for another version than this installer. Nothing was installed.',
  wrong_platform: 'The release is not built for this computer. Nothing was installed.',
  bundle_mismatch: 'The release files do not match the signed manifest. Nothing was installed.',
  bundle_invalid: 'The release bundle is not valid. Nothing was installed.',
  downgrade: 'A newer connector is already installed on this PC. Nothing was changed.',
  missing: 'The release files are missing. Nothing was installed.',
  old_node: 'The connector needs Node.js 18 or later. Install it, then run this installer again.',
  code_argument: 'The pairing code is never given as an argument: it would show in the process list. Use --pair - and send the code on standard input, for example: echo <code> | node <this file> --pair - --hub <origin> --ca <fingerprint>',
  pair_needs: '--pair - needs --hub <origin> and --ca <fingerprint>.',
  no_code: 'No pairing code came on standard input. Send it on standard input, for example: echo <code> | node <this file> --pair - --hub <origin> --ca <fingerprint>',
  invite_failed: 'The connector is paired, but the invite was refused or could not be redeemed; the line above says why.',
  pair_failed: 'The connector is installed but this PC is not paired; the line above says why. Nothing else was started.',
};

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const keyIdOf = (b64) => sha256(Buffer.from(b64, 'base64')).slice(0, 16);
const names = (v) => ({ manifest: `conclave-connector-${v}.json`, signature: `conclave-connector-${v}.json.sig`, bundle: `conclave-connector-${v}.bundle` });
function compare(a, b) {
  const s = (v) => { const [c, p] = v.split('-', 2); return { n: c.split('.').map(Number), p: p ?? null }; };
  const x = s(a), y = s(b);
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] < y.n[i] ? -1 : 1;
  if (x.p === y.p) return 0;
  if (x.p === null) return 1;
  if (y.p === null) return -1;
  return x.p < y.p ? -1 : 1;
}

/** The release checks, the same ones as the connector's own (connector/release.mjs), minus the operator's approval. */
export function checkRelease({ manifestText, signature, bundle }, embed, platform = `${process.platform}-${process.arch}`) {
  if (!embed || !VERSION_RE.test(String(embed.version)) || !Array.isArray(embed.keys)) return { ok: false, reason: 'not_built' };
  if (typeof manifestText !== 'string' || manifestText.length > 64 * 1024) return { ok: false, reason: 'manifest_invalid' };
  if (!signature || !String(signature).trim()) return { ok: false, reason: 'unsigned' };
  let m;
  try { m = JSON.parse(manifestText); } catch { return { ok: false, reason: 'manifest_invalid' }; }
  if (!m || m.format !== MANIFEST_FORMAT || typeof m.key_id !== 'string') return { ok: false, reason: 'manifest_invalid' };
  const entry = embed.keys.find((k) => k && k.id === m.key_id && keyIdOf(k.public_key) === k.id);
  if (!entry) return { ok: false, reason: 'unknown_key' };
  let good = false;
  try { good = verify(null, Buffer.from(manifestText, 'utf8'), createPublicKey({ key: Buffer.from(entry.public_key, 'base64'), format: 'der', type: 'spki' }), Buffer.from(String(signature).trim(), 'base64')); } catch { good = false; }
  if (!good) return { ok: false, reason: 'bad_signature' };
  const b = m.bundle;
  if (!VERSION_RE.test(String(m.version)) || !Array.isArray(m.platforms) || !b || !/^[0-9a-f]{64}$/.test(String(b.sha256)) || !Number.isSafeInteger(b.size) || b.size <= 0 || b.size > MAX_BUNDLE) return { ok: false, reason: 'manifest_invalid' };
  if (m.version !== embed.version) return { ok: false, reason: 'version_mismatch' };
  if (b.name !== names(m.version).bundle) return { ok: false, reason: 'manifest_invalid' };
  if (!m.platforms.includes(platform)) return { ok: false, reason: 'wrong_platform' };
  if (!Buffer.isBuffer(bundle) || bundle.length !== b.size || sha256(bundle) !== b.sha256) return { ok: false, reason: 'bundle_mismatch' };
  const files = [], seen = new Set();
  let o = 0;
  for (;;) {
    if (o + 4 > bundle.length) return { ok: false, reason: 'bundle_invalid' };
    const n = bundle.readUInt32BE(o); o += 4;
    if (n === 0) break;
    if (n > 4096 || o + n > bundle.length) return { ok: false, reason: 'bundle_invalid' };
    let h;
    try { h = JSON.parse(bundle.subarray(o, o + n).toString('utf8')); } catch { return { ok: false, reason: 'bundle_invalid' }; }
    o += n;
    if (!h || typeof h.p !== 'string' || !FILE_RE.test(h.p) || h.p.split('/').includes('..') || seen.has(h.p.toLowerCase()) || !Number.isSafeInteger(h.s) || h.s < 0 || o + h.s > bundle.length) return { ok: false, reason: 'bundle_invalid' };
    seen.add(h.p.toLowerCase());
    files.push({ path: h.p, data: bundle.subarray(o, o + h.s) });
    o += h.s;
  }
  if (o !== bundle.length || !files.some((f) => f.path === 'deploy/client/conclave.mjs') || !files.some((f) => f.path === 'deploy/client/connector/builds.mjs')) return { ok: false, reason: 'bundle_invalid' };
  return { ok: true, manifest: m, files, keyId: entry.id, manifestSha256: sha256(Buffer.from(manifestText, 'utf8')) };
}

function get(url, max = MAX_BUNDLE + 1024 * 1024) {
  return new Promise((ok, no) => {
    const go = (u, left) => {
      if (!u.startsWith('https://')) return no(new Error('only https'));
      https.get(u, { timeout: 60_000 }, (r) => {
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && left) { r.resume(); return go(new URL(r.headers.location, u).href, left - 1); }
        if (r.statusCode !== 200) { r.resume(); return no(new Error(`HTTP ${r.statusCode}`)); }
        const parts = []; let n = 0;
        r.on('data', (c) => { n += c.length; if (n > max) r.destroy(new Error('too large')); else parts.push(c); });
        r.on('end', () => ok(Buffer.concat(parts)));
        r.on('error', no);
      }).on('error', no);
    };
    go(url, 5);
  });
}

/** Reads the three release files, from `--from` or the Releases page. Missing files read as null. */
async function readRelease(embed, from) {
  const n = names(embed.version);
  const one = async (name) => {
    if (from) { const p = join(from, name); return existsSync(p) ? readFileSync(p) : null; }
    try { return await get(`${embed.release_base}/connector-v${embed.version}/${name}`); } catch { return null; }
  };
  const [m, s, b] = [await one(n.manifest), await one(n.signature), await one(n.bundle)];
  return { manifestText: m ? m.toString('utf8') : null, signature: s ? s.toString('utf8') : null, bundle: b };
}

/** The whole install. Answers `{ok, reason?, version, keyId, home}`; prints one line per step, never a secret (there is none). */
export async function install({ embed = EMBED, from, home, service = true, screen = true, browser = true, pair = null, out = (s) => process.stdout.write(s + '\n') } = {}) {
  if (Number(process.versions.node.split('.')[0]) < 18) return { ok: false, reason: 'old_node' };
  if (!embed) return { ok: false, reason: 'not_built' };
  const rel = await readRelease(embed, from);
  if (!rel.manifestText || !rel.bundle) return { ok: false, reason: 'missing' };
  const c = checkRelease(rel, embed);
  if (!c.ok) return c;
  out(`The release ${c.manifest.version} is signed by the Conclave release key ${c.keyId}. Compare this id with the one on the Releases page.`);
  // An older release never replaces a newer build; the same version already installed is kept as it is.
  let builds = null;
  try { builds = JSON.parse(readFileSync(join(home, 'app', 'builds.json'), 'utf8')); } catch { builds = null; }
  const cur = builds && VERSION_RE.test(String(builds.current)) ? builds.current : null;
  if (cur && compare(c.manifest.version, cur) < 0) return { ok: false, reason: 'downgrade' };
  // The verified files only: builds.mjs comes from the bundle that just passed the checks.
  const stage = join(home, 'tmp', `install-${c.manifest.version}-${process.pid}`);
  rmSync(stage, { recursive: true, force: true });
  try {
    for (const f of c.files) { const p = join(stage, ...f.path.split('/')); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, f.data); }
    const B = await import(pathToFileURL(join(stage, 'deploy', 'client', 'connector', 'builds.mjs')).href);
    if (cur !== c.manifest.version) { B.installVerified(home, c.manifest.version, c.files, c.manifestSha256); B.activate(home, c.manifest.version); } else B.writeLauncher(home);
  } finally { rmSync(stage, { recursive: true, force: true }); }
  out(`The connector ${c.manifest.version} is installed in ${home}.`);
  if (['keys.env', 'setup.mjs'].some((n) => existsSync(join(home, n)))) out('This PC still has the old setup. Run `conclave migrate` (then `conclave migrate --apply`) before you rely on the service: until the move it has no hub and stops by itself.');
  const launcher = join(home, 'conclave.mjs');
  const env = { ...process.env, CONCLAVE_HOME: home };
  // Pairing comes before the service, so the service starts with its hub. The code goes to the child on standard input and nowhere else.
  if (pair) {
    const r = spawnSync(process.execPath, [launcher, 'pair', '--hub', pair.hub, '--check', pair.ca], { env, input: String(pair.code), encoding: 'utf8' });
    for (const l of `${r.stdout ?? ''}${r.stderr ?? ''}`.split(/\r?\n/)) if (l.trim()) out(l);
    if (r.status !== 0) return { ok: false, reason: 'pair_failed', pairStatus: r.status ?? 1, version: c.manifest.version, home };
    screen = false;
    // A collaborator's invite: redeem it now, then pick up the keys and build the folder. The agent that runs the installer waits for the line below.
    const hubId = /^hub: ([A-Za-z0-9_-]+)$/m.exec(String(r.stdout ?? ''))?.[1];
    const hubArgs = hubId ? ['--hub', hubId] : [];
    const inv = /^code_kind: invite ([A-Za-z0-9_-]+)$/m.exec(String(r.stdout ?? ''));
    if (inv) {
      const red = spawnSync(process.execPath, [launcher, 'setup', 'redeem', inv[1], ...hubArgs], { env, encoding: 'utf8' });
      for (const l of `${red.stdout ?? ''}${red.stderr ?? ''}`.split(/\r?\n/)) if (l.trim()) out(l);
      if (red.status !== 0) return { ok: false, reason: 'invite_failed', pairStatus: 1, version: c.manifest.version, home };
      const go = spawnSync(process.execPath, [launcher, 'setup', 'continue', '--wait', '30', ...hubArgs], { env, encoding: 'utf8' });
      for (const l of `${go.stdout ?? ''}${go.stderr ?? ''}`.split(/\r?\n/)) if (l.trim()) out(l);
      out(go.status === 0 ? 'This PC joined the team from an invite.' : 'This PC redeemed the invite but is not set up yet. Run conclave setup continue --wait 30 to finish.');
    }
  }
  if (service) {
    const s = spawnSync(process.execPath, [launcher, 'service', 'install'], { env, stdio: 'inherit' });
    if (s.status !== 0) out('The logon service could not be installed; run `conclave service install` later. The connector works without it until then.');
  }
  // A PC with no display has no browser: the screen would wait for one for an hour. Say how to open it and finish (exit 0).
  const headless = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
  if (screen && headless) out('This PC has no browser or display. Run `conclave setup` when you can open a browser on this PC (or on a machine that reaches it); it prints the link.');
  else if (screen) spawnSync(process.execPath, [launcher, 'setup', ...(browser ? [] : ['--no-browser'])], { env, stdio: 'inherit' });
  return { ok: true, version: c.manifest.version, keyId: c.keyId, home };
}

const isMain = (() => { try { return resolve(process.argv[1] ?? '').toLowerCase() === resolve(fileURLToPath(import.meta.url)).toLowerCase(); } catch { return false; } })();
if (isMain) {
  const argv = process.argv.slice(2), has = (f) => argv.includes(f);
  const fromAt = argv.indexOf('--from');
  const from = fromAt >= 0 ? resolve(argv[fromAt + 1] ?? '.') : undefined;
  const home = process.env.CONCLAVE_HOME ? resolve(process.env.CONCLAVE_HOME) : join(homedir(), '.config', 'conclave');
  const val = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  let pair = null;
  if (has('--pair')) {
    const fail = (reason) => { process.stderr.write(`conclave installer: ${LINES[reason]}\n`); process.exit(2); };
    if (val('--pair') !== '-') fail('code_argument');
    if (!val('--hub') || !val('--ca')) fail('pair_needs');
    let code = '';
    if (!process.stdin.isTTY) { for await (const c of process.stdin) { code += c; if (code.length > 200) break; } }
    code = code.trim();
    if (!code) fail('no_code');
    pair = { hub: val('--hub'), ca: val('--ca'), code };
  }
  const r = await install({ from, home, service: !has('--no-service'), screen: !has('--no-screen'), browser: !has('--no-browser'), pair });
  // Exit 3: the hub's CA or origin did not match (nothing was sent); 4: the code was refused or the hub could not be reached; 5: paired, but the invite was refused.
  if (!r.ok) { process.stderr.write(`conclave installer: ${LINES[r.reason] ?? r.reason}\n`); process.exit(r.reason === 'pair_failed' ? (r.pairStatus === 3 ? 3 : 4) : r.reason === 'invite_failed' ? 5 : 1); }
}
