// Restore by the connector (docs/checkout.md §6): the handout and git checks, the config scan, the destinations a PC's user
// approves, and the whole run against a stub HTTPS hub: a Claude Code move, a folder with agent config of its own that waits
// for the PC's user, a restart in the middle, a cancelled checkout, a gone destination, and the Codex entries with the
// permission table, and a Codex agent in its own clone with its role file as AGENTS.override.md. Temporary folders only;
// plain node:test.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testCa } from '../../server/test/test-ca.mjs';
import { putHub, caFingerprint, readKeyFile, agentKey } from './connector/keyfile.mjs';
import { connect } from './connector/hubclient.mjs';
import { repairFolder } from './connector/register.mjs';
import { codexPermission, codexToml } from './connector/entries.mjs';
import { addDestination, destinationChanged, listDestinations, reportDestinations, resolveDestination, removeDestination } from './connector/destinations.mjs';
import { pendingList, approvePickup, folderApproved } from './connector/approvals.mjs';
import { verifyHandouts, repoPlan, prepareRepo, scanFolder, startLine, resumeMsg, writeAgentFiles, codexRoleBlock, beginRestore, runRestore as runRestoreRaw, activeRestores, restorePath } from './connector/restore.mjs';
import { OVERRIDE_MARKER, overrideState } from './connector/role.mjs';
import { resolveFolder } from './connector/registry.mjs';
import { agentsOverride } from './codex.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const hasGit = spawnSync('git', ['--version']).status === 0;
process.env.CONCLAVE_KEY_STORE = 'file';
/** A restore as the PC's user drives it: a key pickup waits for the click on the screen; click it and go on. */
async function runRestore(cx, s) {
  const r = await runRestoreRaw(cx, s);
  if (r.phase !== 'waiting' || !/key pickup/.test(r.note ?? '')) return r;
  for (const k of pendingList(cx.home).pickups) approvePickup(cx.home, k.key);
  return runRestoreRaw(cx, s);
}
const tmp = [];
const mk = (p = 'cn-rst-') => { const d = mkdtempSync(join(tmpdir(), p)); tmp.push(d); return d; };
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
const G = (dir, ...args) => {
  const r = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.org', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const agentOf = (b, i = 0, extra = {}) => ({ agent_id: `agt_${i}`, label: `agent ${i}`, role: 'developer', folder: `f${i}`, session_var: `V${i}`, provider: 'claude_code', permissions: 'default', handout: { status: 'written', body: JSON.stringify(b), render_sha256: sha(JSON.stringify(b)) }, ...extra });
const viewOf = (bodies) => ({ agents: bodies.map((b, i) => agentOf(b, i)) });
const H = (c) => c.repeat(40);

function lab() {
  const root = mk('cn-rst-lab-');
  const src = join(root, 'src');
  mkdirSync(src);
  G(src, 'init', '-q', '-b', 'integration/core');
  writeFileSync(join(src, 'a.txt'), 'one\n'); G(src, 'add', '.'); G(src, 'commit', '-qm', 'one');
  const first = G(src, 'rev-parse', 'HEAD');
  writeFileSync(join(src, 'a.txt'), 'two\n'); G(src, 'commit', '-qam', 'two');
  const tip = G(src, 'rev-parse', 'HEAD');
  // https://git.lab.example/... is rewritten to the local folder for this process only, in a user git config of its own
  // (restore's git keeps GIT_* variables out, so GIT_CONFIG_* would not reach it).
  const xdg = join(root, 'xdg');
  mkdirSync(join(xdg, 'git'), { recursive: true });
  writeFileSync(join(xdg, 'git', 'config'), `[url "${src.replace(/\\/g, '/')}"]\n\tinsteadOf = https://git.lab.example/core.git\n`);
  process.env.XDG_CONFIG_HOME = xdg;
  return { root, src, first, tip, project: join(root, 'project') };
}
const plan = (l, over = {}) => repoPlan(verifyHandouts(viewOf([{ repo: { remote_name: 'origin', url: 'https://git.lab.example/core.git', clone_folder: 'core' },
  checkpoint: { integration_branch: 'integration/core', integration_head: l.tip, merge_commits: [l.first], ...over } }])), l.project, 'cko_test1234')[0];

describe('what a handout may say (ported from the old restore script)', () => {
  test('a body that does not match its render hash is refused', () => {
    const v = viewOf([{ folder: 'f0' }]);
    v.agents[0].handout.body = v.agents[0].handout.body.replace('f0', 'f9');
    assert.throws(() => verifyHandouts(v), /does not match the one the administrator rendered/);
  });
  test('a branch that starts with "-" and a head that is not 40 hex are refused, also inside prepareRepo', () => {
    assert.throws(() => verifyHandouts(viewOf([{ checkpoint: { integration_branch: '--upload-pack=touch /tmp/x', integration_head: H('a') } }])), /not a valid ref/);
    assert.throws(() => verifyHandouts(viewOf([{ checkpoint: { integration_branch: '-x', integration_head: H('a') } }])), /not a valid ref/);
    assert.throws(() => verifyHandouts(viewOf([{ checkpoint: { integration_branch: 'main', integration_head: 'HEAD~1' } }])), /40 hex/);
    assert.throws(() => verifyHandouts(viewOf([{ repo: { remote_name: 'origin', url: 'ssh://-oProxyCommand=x/y', clone_folder: 'core' } }])), /repo URL/);
    assert.throws(() => prepareRepo({ dir: '/nowhere/core', clone_folder: 'core', remote: 'origin', url: null, branches: [{ branch: '-f', heads: [] }], checkout: [], checkout_branch: 'checkout/cko_x' }, { fetch: false }), /not a valid ref/);
  });
});

describe('repos (git)', { skip: !hasGit }, () => {
  test('a missing repo is cloned, every head checked, a narrow exclude written; a second run fast-forwards', () => {
    const l = lab();
    const r = prepareRepo(plan(l), { fetch: true });
    assert.equal(readFileSync(join(l.project, 'core', 'a.txt'), 'utf8').replace(/\r/g, ''), 'two\n');
    assert.equal(r.tip_ref, 'refs/heads/integration/core');
    const ex = readFileSync(join(l.project, 'core', '.git', 'info', 'exclude'), 'utf8');
    assert.match(ex, /^\.mcp\.json$/m);
    assert.doesNotMatch(ex, /^\*$/m);
    assert.doesNotMatch(ex, /^\.claude\/$/m, 'a shared (Claude Code) clone keeps .claude/ visible: only the Codex clone hides it');
    writeFileSync(join(l.src, 'a.txt'), 'three\n'); G(l.src, 'commit', '-qam', 'three');
    prepareRepo(plan(l, { integration_head: G(l.src, 'rev-parse', 'HEAD') }), { fetch: true });
    assert.equal(readFileSync(join(l.project, 'core', 'a.txt'), 'utf8').replace(/\r/g, ''), 'three\n');
  });
  test('a fresh clone with no integration branch is refused (nothing could be scanned)', () => {
    const l = lab();
    assert.throws(() => prepareRepo({ ...plan(l), branches: [] }, { fetch: true }), /no integration branch/);
    assert.equal(existsSync(join(l.project, 'core', '.git')), false);
  });
  test('a head that is not on the branch, a missing commit and a diverged clone are refused', () => {
    const l = lab();
    prepareRepo(plan(l), { fetch: true });
    G(l.src, 'checkout', '-q', '-b', 'side', l.first);
    writeFileSync(join(l.src, 'b.txt'), 'side\n'); G(l.src, 'add', '.'); G(l.src, 'commit', '-qm', 'side');
    const side = G(l.src, 'rev-parse', 'HEAD');
    G(l.src, 'checkout', '-q', 'integration/core');
    G(join(l.project, 'core'), 'fetch', '-q', 'origin', 'side');
    assert.throws(() => prepareRepo(plan(l, { merge_commits: [side] }), { fetch: false }), /is not in integration\/core/);
    assert.throws(() => prepareRepo(plan(l, { merge_commits: [H('d')] }), { fetch: false }), /is missing here/);
    writeFileSync(join(l.project, 'core', 'a.txt'), 'local\n'); G(join(l.project, 'core'), 'commit', '-qam', 'local');
    writeFileSync(join(l.src, 'a.txt'), 'remote\n'); G(l.src, 'commit', '-qam', 'remote');
    assert.throws(() => prepareRepo(plan(l), { fetch: true }), /diverged/);
  });
  test('restore runs git with the clone\'s hooks and fsmonitor off, reports the hooks, and refuses a .git/config that runs a program', () => {
    const l = lab();
    prepareRepo(plan(l), { fetch: true });
    const dir = join(l.project, 'core');
    const marker = join(l.root, 'ran').replace(/\\/g, '/');
    const script = `#!/bin/sh\necho ran >> "${marker}"\n`;
    for (const h of ['post-merge', 'post-checkout', 'reference-transaction', 'pre-auto-gc']) writeFileSync(join(dir, '.git', 'hooks', h), script, { mode: 0o755 });
    writeFileSync(join(l.root, 'fsmonitor.sh'), script, { mode: 0o755 });
    G(dir, 'config', 'core.fsmonitor', join(l.root, 'fsmonitor.sh').replace(/\\/g, '/'));
    writeFileSync(join(l.src, 'a.txt'), 'four\n'); G(l.src, 'commit', '-qam', 'four');
    prepareRepo(plan(l, { integration_head: G(l.src, 'rev-parse', 'HEAD') }), { fetch: true });
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8').replace(/\r/g, ''), 'four\n');
    assert.equal(existsSync(marker), false, 'no hook and no fsmonitor ran');
    const kinds = scanFolder(dir).map((x) => `${x.kind} ${x.path}`);
    assert.ok(kinds.includes('hooks .git/hooks/post-merge'), kinds.join('; '));
    assert.ok(!kinds.some((k) => k.endsWith('.sample')));
    assert.equal(existsSync(marker), false);
    for (const [k, v] of [['include.path', '../evil.cfg'], ['filter.x.smudge', 'evil'], ['core.sshCommand', 'evil'], ['diff.x.textconv', 'evil']]) {
      G(dir, 'config', k, v);
      assert.throws(() => prepareRepo(plan(l), { fetch: true }), new RegExp(`has ${k.toLowerCase().replace(/\./g, '\\.')}, which makes git run a program`));
      assert.throws(() => scanFolder(dir), /makes git run a program/);
      G(dir, 'config', '--unset', k);
    }
    assert.equal(existsSync(marker), false);
  });
  test('the config scan finds a tracked hook, role file and .mcp.json, and config the checkout branch changes', () => {
    const l = lab();
    prepareRepo(plan(l), { fetch: true });
    const dir = join(l.project, 'core');
    assert.deepEqual(scanFolder(dir), []);
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: './x.sh' }] }] } }));
    writeFileSync(join(dir, 'CLAUDE.md'), 'Be helpful.\n');
    G(dir, 'add', '.'); G(dir, 'commit', '-qm', 'config');
    G(dir, 'checkout', '-q', '-b', 'checkout/cko_test1234');
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { tools: { command: 'x' } } }));
    G(dir, 'add', '-f', '.mcp.json'); G(dir, 'commit', '-qm', 'mcp');
    const f = scanFolder(dir, { tipRef: 'refs/heads/integration/core', checkoutRef: 'refs/heads/checkout/cko_test1234' });
    const kinds = f.map((x) => `${x.kind} ${x.path}`);
    for (const k of ['hooks .claude/settings.json', 'role_file CLAUDE.md', 'mcp_servers .mcp.json', 'checkout_diff .mcp.json']) assert.ok(kinds.includes(k), `${k} in ${kinds.join('; ')}`);
    assert.match(f.find((x) => x.kind === 'hooks').detail, /PreToolUse/);
  });
  test('config names match in any case, a tracked .agent-hub.json is reported, and untracked config counts too', () => {
    const l = lab();
    prepareRepo(plan(l), { fetch: true });
    const dir = join(l.project, 'core');
    mkdirSync(join(dir, '.Claude'));
    writeFileSync(join(dir, '.Claude', 'Settings.json'), JSON.stringify({ hooks: { PreToolUse: [] } }));
    writeFileSync(join(dir, '.MCP.json'), JSON.stringify({ mcpServers: { tools: { command: 'x' } } }));
    writeFileSync(join(dir, 'Claude.md'), 'Be helpful.\n');
    writeFileSync(join(dir, '.agent-hub.json'), JSON.stringify({ session_var: 'V0' }));
    G(dir, 'add', '-f', '.'); G(dir, 'commit', '-qm', 'mixed case');
    const kinds = scanFolder(dir).map((x) => `${x.kind} ${x.path}`);
    for (const k of ['hooks .Claude/Settings.json', 'mcp_servers .MCP.json', 'role_file Claude.md', 'codex_config .agent-hub.json']) assert.ok(kinds.includes(k), `${k} in ${kinds.join('; ')}`);
    const d2 = mk('cn-rst-u-');
    G(d2, 'init', '-q');
    writeFileSync(join(d2, '.git', 'info', 'exclude'), '*\n'); // an ignored config file loads all the same
    writeFileSync(join(d2, 'AGENTS.md'), 'Do things.\n'); mkdirSync(join(d2, '.codex')); writeFileSync(join(d2, '.codex', 'config.toml'), '[mcp_servers.x]\ncommand = "x"\n');
    writeFileSync(join(d2, 'notes.md'), 'not config\n');
    assert.deepEqual(scanFolder(d2).map((x) => `${x.kind} ${x.path}`).sort(), ['codex_config .codex/config.toml', 'role_file AGENTS.md']);
  });
});

describe('destinations', () => {
  test('a folder the user approves gets an id; the hub is told the label only; remove ends it', () => {
    const home = mk(), dest = mk('cn-dst-');
    assert.deepEqual(listDestinations(home), []);
    assert.equal(addDestination(home, join(dest, 'missing')).ok, false);
    const a = addDestination(home, dest, 'Work folder');
    assert.ok(a.ok && /^dst_[a-f0-9]{12}$/.test(a.destination.id));
    assert.equal(addDestination(home, dest).existed, true);
    assert.deepEqual(reportDestinations(home), [{ id: a.destination.id, label: 'Work folder' }]);
    assert.ok(!JSON.stringify(reportDestinations(home)).includes(dest.replace(/\\/g, '\\\\')) && !JSON.stringify(reportDestinations(home)).includes('cn-dst-'));
    assert.equal(resolveDestination(home, a.destination.id).label, 'Work folder');
    assert.equal(resolveDestination(home, 'dst_unknown000'), null);
    assert.equal(removeDestination(home, a.destination.id), true);
    assert.equal(resolveDestination(home, a.destination.id), null);
  });
});

describe('a destination whose folder was swapped after the approval', () => {
  test('is no longer reported or restored into, and is approved again by the user', () => {
    const home = mk(), parent = mk('cn-dsw-'), dest = join(parent, 'work');
    mkdirSync(dest);
    const a = addDestination(home, dest, 'Work');
    assert.equal(typeof a.destination.identity, 'string'); // the filesystem identity is recorded with the approval
    assert.equal(destinationChanged(resolveDestination(home, a.destination.id)), false);
    // Replaced at the same path: the folder is removed and another made (or a link put there): another folder, same path.
    renameSync(dest, join(parent, 'old'));
    mkdirSync(join(parent, 'elsewhere'));
    try { symlinkSync(join(parent, 'elsewhere'), dest, 'junction'); } catch { mkdirSync(dest); }
    assert.equal(destinationChanged(resolveDestination(home, a.destination.id)), true);
    assert.deepEqual(reportDestinations(home), []); // the hub is not told it is approved
    // The user approves it again: the same id (the hub's order still names it) and the new folder's identity.
    const again = addDestination(home, dest, 'Work');
    assert.ok(again.ok);
    assert.ok(again.reapproved || again.destination.id !== a.destination.id);
    assert.equal(reportDestinations(home).length >= 1, true);
  });
  test('an approval made before identities were recorded is not blocked', () => {
    const home = mk(), dest = mk('cn-dold-');
    const a = addDestination(home, dest, 'Old');
    const file = join(home, 'destinations.json'), j = JSON.parse(readFileSync(file, 'utf8'));
    delete j.destinations[0].identity;
    writeFileSync(file, JSON.stringify(j));
    assert.equal(destinationChanged(resolveDestination(home, a.destination.id)), false);
    assert.equal(reportDestinations(home).length, 1);
  });
});

describe('the Codex entries and the start lines', () => {
  test('the permission table is the hub\'s', () => {
    for (const p of ['plan', 'default', 'acceptEdits', 'bypassPermissions']) assert.ok(codexPermission(p));
    const src = readFileSync(join(HERE, '..', '..', 'server', 'src', 'checkout', 'fields.ts'), 'utf8');
    for (const [mode, level, ap, sb] of [['plan', 'ask', 'on-request', 'read-only'], ['acceptEdits', 'standard', 'on-request', 'workspace-write'], ['bypassPermissions', 'auto', 'never', 'workspace-write']]) {
      assert.match(src, new RegExp(`'${mode}': return \\{ level: '${level}', approval_policy: '${ap}', sandbox_mode: '${sb}' \\}`));
      assert.deepEqual(codexPermission(mode), { level, approval_policy: ap, sandbox_mode: sb });
    }
    assert.equal(codexPermission('nonsense'), null);
  });
  test('ask, standard and auto: the settings in config.toml, default_tools_approval_mode only for auto, the role file as the marked override, no bridge', () => {
    for (const [mode, ap, sb, approve] of [['plan', 'on-request', 'read-only', false], ['acceptEdits', 'on-request', 'workspace-write', false], ['bypassPermissions', 'never', 'workspace-write', true]]) {
      const home = mk(), dir = mk('cn-cdx-');
      writeAgentFiles(home, dir, { label: 'dev', provider: 'codex', permissions: mode, model: 'm1' }, 'Play.', { claudeJson: join(home, 'c.json') });
      const toml = readFileSync(join(dir, '.codex', 'config.toml'), 'utf8');
      assert.match(toml, new RegExp(`^approval_policy = "${ap}"$`, 'm'));
      assert.match(toml, new RegExp(`^sandbox_mode = "${sb}"$`, 'm'));
      assert.match(toml, /^model = "m1"$/m);
      assert.match(toml, /\[mcp_servers\.conclave\]/);
      assert.equal(/default_tools_approval_mode = "approve"/.test(toml), approve, mode);
      assert.equal(existsSync(join(dir, 'AGENTS.md')), false, 'the connector writes no AGENTS.md');
      const role = readFileSync(join(dir, 'AGENTS.override.md'), 'utf8');
      assert.equal(role.split('\n')[0], OVERRIDE_MARKER);
      assert.match(role, /read this folder's `AGENTS\.md` as well/i);
      assert.match(role, /`commit` tool of the `conclave` server/);
      assert.match(role, /\nPlay\.\n$/);
      assert.doesNotMatch(toml, /codex-bridge/);
    }
    assert.match(codexToml({ node: '/n', connector: '/c', folder: '/f', approveTools: true }), /default_tools_approval_mode = "approve"/);
    assert.doesNotMatch(codexToml({ node: '/n', connector: '/c', folder: '/f' }), /default_tools_approval_mode/);
  });
  test('a tracked AGENTS.md is left exactly as it is and the override stays out of git; a tracked CLAUDE.md is never replaced (an untracked overlay beside it)', { skip: !hasGit }, () => {
    const dir = mk('cn-trk-');
    G(dir, 'init', '-q');
    writeFileSync(join(dir, 'AGENTS.md'), 'repo rules\n'); writeFileSync(join(dir, 'CLAUDE.md'), 'repo claude rules\n');
    G(dir, 'add', '.'); G(dir, 'commit', '-qm', 'rules');
    assert.equal(codexRoleBlock(dir), null, 'a tracked AGENTS.md no longer refuses a Codex restore');
    const cxHome = mk();
    writeAgentFiles(cxHome, dir, { label: 'dev', provider: 'codex', permissions: 'default' }, 'Hub playbook.', { claudeJson: join(cxHome, 'c.json') });
    assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), 'repo rules\n');
    assert.equal(overrideState(dir), 'ours');
    assert.match(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8'), /^AGENTS\.override\.md$/m);
    assert.equal(G(dir, 'status', '--porcelain'), '', 'git sees neither the role file nor .codex');
    rmSync(join(dir, 'AGENTS.override.md')); rmSync(join(dir, '.codex'), { recursive: true });
    const home = mk();
    writeAgentFiles(home, dir, { label: 'dev', provider: 'claude_code', permissions: 'default' }, 'Hub playbook.', { claudeJson: join(home, 'c.json') });
    assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), 'repo claude rules\n');
    assert.equal(readFileSync(join(dir, 'CLAUDE.local.md'), 'utf8'), 'Hub playbook.\n');
    assert.equal(JSON.parse(readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8')).permissions.defaultMode, 'default');
  });
  test('an override Conclave did not write, the old codex.mjs one and a tracked one all refuse a Codex restore', { skip: !hasGit }, () => {
    const dir = mk('cn-ovr-');
    writeFileSync(join(dir, 'AGENTS.override.md'), 'my own rules\n');
    assert.match(codexRoleBlock(dir), /Conclave did not write, and restore never overwrites it/);
    const home = mk();
    assert.throws(() => writeAgentFiles(home, dir, { label: 'dev', provider: 'codex', permissions: 'default' }, 'Hub.', { claudeJson: join(home, 'c.json') }), /did not write/);
    assert.equal(readFileSync(join(dir, 'AGENTS.override.md'), 'utf8'), 'my own rules\n', 'never overwritten');
    writeFileSync(join(dir, 'AGENTS.override.md'), agentsOverride({ label: 'dev', role: 'developer', team: 'T', instructions: 'Old text.' }));
    assert.match(codexRoleBlock(dir), /old Codex setup\. Run conclave migrate/);
    const repo = mk('cn-ovr-trk-');
    G(repo, 'init', '-q');
    writeFileSync(join(repo, 'AGENTS.override.md'), `${OVERRIDE_MARKER}\ncommitted by mistake\n`);
    G(repo, 'add', '.'); G(repo, 'commit', '-qm', 'override');
    assert.match(codexRoleBlock(repo), /tracks an AGENTS\.override\.md/);
  });
  test('start lines: Claude Code opens with claude, Codex with codex -C and its permission flags', () => {
    const msg = resumeMsg({ label: 'Dev 1', role: 'developer' }, 'Team');
    assert.match(msg, /^You are Dev 1, developer of Team\. Call directives_read \{unread: true, ack: true\}, then checkout_resume/);
    assert.equal(startLine('/x/y', 'hi', { win: false }), "cd '/x/y' && claude 'hi'");
    assert.equal(startLine('C:\\x y', 'hi', { win: true }), 'cd "C:\\x y"; claude "hi"');
    assert.equal(startLine('/x/y', 'hi', { provider: 'codex', permissions: 'bypassPermissions', win: false }), "codex -C '/x/y' -a never -s workspace-write 'hi'");
  });
});

// ───── the whole run, against a stub hub ─────
const APP = 'ah_app_FAKEappKEYforRESTOREtests0001';
function stubHub(pki, view, opts = {}) {
  const hub = { view, scans: [], pickups: 0, confirms: 0, scanPosts: 0, logins: 0, state: 'approved', confirmFails: 0, loginFails: 0, trust: { f0: true }, sockets: new Set() };
  hub.server = https.createServer({ key: pki.leafKey, cert: pki.leafPem }, (req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const json = (s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
      if (req.headers.authorization !== `Bearer ${APP}`) return json(401, { error: 'unauthorized' });
      const body = raw ? JSON.parse(raw) : {};
      if (req.url === '/mcp') {
        if (body.params?.name === 'session_login') { if (hub.loginFails-- > 0) return json(500, {}); hub.logins++; return json(200, { jsonrpc: '2.0', id: body.id, result: { content: [], structuredContent: { session_token: 'tok' } } }); }
        return json(404, {});
      }
      if (req.method === 'GET' && req.url === '/onboard/requests') return json(200, { requests: [{ request_id: 'obr_test1', kind: 'checkout', checkout_id: hub.view.id }] });
      if (req.method === 'GET' && req.url.startsWith('/onboard/requests/obr_test1')) return json(200, { state: hub.state, project: 'Proj', team_name: 'Team', checkout: { ...hub.view, scans: hub.scans } });
      if (req.url === '/onboard/requests/obr_test1/scan') { hub.scanPosts++; hub.scans = body.folders.map((f) => ({ folder: f.folder, findings_sha256: sha(JSON.stringify(f.findings)), waiting: opts.adminWaits === true })); return json(200, { scans: hub.scans }); }
      if (req.url === '/onboard/pickup') { hub.pickups++; return json(200, { pickup_id: `pk${hub.pickups}`, agents: hub.view.agents.map((a) => ({ agent_id: a.agent_id, secret: `ah_ses_SECRET${a.agent_id}`, instructions: `Playbook of ${a.label}.\n` })) }); }
      if (req.url === '/onboard/pickup/confirm') { if (hub.confirmFails-- > 0) return json(500, { message: 'boom' }); hub.confirms++; hub.confirmBody = body; return json(200, { request_id: 'obr_test1', state: 'collected', trust: hub.trust }); }
      json(404, {});
    });
  });
  hub.server.on('connection', (s) => { hub.sockets.add(s); s.on('close', () => hub.sockets.delete(s)); });
  return new Promise((ok) => hub.server.listen(0, '127.0.0.1', () => { hub.origin = `https://127.0.0.1:${hub.server.address().port}`; ok(hub); }));
}

describe('a restore run', { skip: !hasGit }, () => {
  let pki;
  before(() => { pki = testCa('Restore hub CA'); });
  const world = async (view, o = {}) => {
    const hub = await stubHub(pki, view, o);
    const base = mk(), home = join(base, 'conclave home'), dest = join(base, 'dest'), claudeJson = join(base, 'claude.json');
    mkdirSync(home, { recursive: true }); mkdirSync(dest);
    writeFileSync(join(home, 'conclave.mjs'), '');
    const hubKey = putHub(home, { hubId: 'hub-rst', origin: hub.origin, caPem: pki.caPem, appKey: APP });
    const section = readKeyFile(home).data.hubs[hubKey];
    const d = addDestination(home, dest, 'Test dest').destination;
    const cx = { home, hubKey, section, hub: connect(section).hub, auth: { Authorization: `Bearer ${APP}` }, claudeJson };
    const order = { id: 'pca_test1', kind: 'restore', payload: { checkout_id: view.id, destination_id: d.id } };
    return { hub, home, dest, claudeJson, hubKey, cx, order, d, close: () => { for (const s of hub.sockets) s.destroy(); hub.server.close(); } };
  };
  const view = (over = {}) => ({ id: 'cko_t1', status: 'rendered', target: 'other_pc', team: 'Team', scope: 'team', agents: [agentOf({}, 0, { permissions: 'acceptEdits' })], ...over });

  test('a Claude Code move: folders built, key from the key file, entries like onboarding, login tested, confirmed, trust, start lines', async () => {
    const w = await world(view());
    try {
      const s = beginRestore(w.home, w.hubKey, w.order);
      const r = await runRestore(w.cx, s);
      assert.equal(r.phase, 'done', JSON.stringify(r));
      const dir = join(w.dest, 'Proj', 'f0');
      const mcp = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'));
      assert.deepEqual(Object.keys(mcp.mcpServers), ['conclave']);
      const st = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'));
      assert.ok(st.hooks?.UserPromptSubmit, 'the folder hook');
      assert.deepEqual(st.enabledMcpjsonServers, ['conclave']);
      assert.equal(JSON.parse(readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8')).permissions.defaultMode, 'acceptEdits');
      assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), 'Playbook of agent 0.\n');
      for (const f of ['AGENTS.override.md', 'codex-bridge.mjs', '.agent-hub.json']) assert.equal(existsSync(join(dir, f)), false, f);
      const kf = readKeyFile(w.home);
      assert.equal(agentKey(kf.data.hubs[w.hubKey], 'f0'), 'ah_ses_SECRETagt_0');
      assert.equal(w.hub.pickups, 1); assert.equal(w.hub.confirms, 1); assert.equal(w.hub.logins, 1);
      assert.deepEqual(w.hub.confirmBody.written, ['V0']);
      assert.equal(JSON.parse(readFileSync(w.claudeJson, 'utf8')).projects[dir.replace(/\\/g, '/')].hasTrustDialogAccepted, true);
      assert.equal(r.start_lines.length, 1);
      assert.match(r.start_lines[0], /claude/);
      assert.match(r.start_lines[0], /checkout_resume/);
      assert.equal(activeRestores(w.home, w.hubKey).length, 0);
      assert.equal(folderApproved(w.home, dir, resolveFolder(w.home, dir).binding), true, 'a folder the user approved on the restore screen, with its trust given, needs no second click');
    } finally { w.close(); }
  });

  test('a restore folder whose trust the hub did not give is built, but its first chat still needs its own click', async () => {
    const w = await world(view());
    try {
      w.hub.trust = { f0: false };
      const r = await runRestore(w.cx, beginRestore(w.home, w.hubKey, w.order));
      assert.equal(r.phase, 'done', JSON.stringify(r));
      const dir = join(w.dest, 'Proj', 'f0');
      const b = resolveFolder(w.home, dir);
      assert.equal(b.ok, true, 'the folder is built and registered');
      assert.equal(folderApproved(w.home, dir, b.binding), false, 'but nobody allowed a chat in it yet');
      assert.equal(existsSync(w.claudeJson), false, 'and no trust was written');
    } finally { w.close(); }
  });

  test('a restored folder keeps the team the checkout names, for Bind team', async () => {
    const w = await world(view({ team_id: 'team_9' }));
    try {
      assert.equal((await runRestore(w.cx, beginRestore(w.home, w.hubKey, w.order))).phase, 'done');
      const b = resolveFolder(w.home, join(w.dest, 'Proj', 'f0')).binding;
      assert.deepEqual([b.team, b.team_name], ['team_9', 'Team']);
    } finally { w.close(); }
  });

  test('a folder with agent config of its own waits for the PC\'s user, and nothing is picked up until they approve', async () => {
    const w = await world(view());
    try {
      const dir = join(w.dest, 'Proj', 'f0');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { tools: { command: 'evil' } } }));
      const s = beginRestore(w.home, w.hubKey, w.order);
      const r = await runRestore(w.cx, s);
      assert.equal(r.phase, 'waiting');
      assert.deepEqual(r.waiting_for_user, ['f0']);
      assert.match(r.note, /Waiting for the PC's user/);
      assert.match(r.note, /repair --grant-trust/);
      assert.equal(w.hub.pickups, 0, 'no key picked up');
      assert.equal(existsSync(w.claudeJson), false, 'no trust written');
      // The service never asks: a second pass changes nothing.
      assert.equal((await runRestore(w.cx, activeRestores(w.home, w.hubKey)[0])).phase, 'waiting');
      assert.equal(w.hub.pickups, 0);
      // The user approves: conclave repair --grant-trust in that folder.
      const rr = repairFolder(w.home, dir, { claudeJson: w.claudeJson, grantTrust: true });
      assert.ok(rr.actions.includes('trust_granted_by_user'), JSON.stringify(rr));
      const done = await runRestore(w.cx, activeRestores(w.home, w.hubKey)[0]);
      assert.equal(done.phase, 'done', JSON.stringify(done));
      assert.equal(w.hub.pickups, 1);
      assert.equal(w.hub.scanPosts, 1, 'the scan was reported once, before the connector wrote anything');
    } finally { w.close(); }
  });

  test('the administrator\'s scan decision holds the pickup too', async () => {
    const w = await world(view(), { adminWaits: true });
    try {
      const r = await runRestore(w.cx, beginRestore(w.home, w.hubKey, w.order));
      assert.equal(r.phase, 'waiting');
      assert.match(r.note, /The administrator decides the config scan of f0/);
      assert.equal(w.hub.pickups, 0);
    } finally { w.close(); }
  });

  test('a restart in the middle resumes: the keys are not picked up twice', async () => {
    const w = await world(view());
    try {
      w.hub.confirmFails = 1;
      const r1 = await runRestore(w.cx, beginRestore(w.home, w.hubKey, w.order));
      assert.equal(r1.phase, 'waiting'); // the hub failed the confirm: kept, tried again
      assert.ok(r1.retry);
      const left = activeRestores(w.home, w.hubKey);
      assert.equal(left.length, 1);
      assert.equal(left[0].keys_written_for, 'pk1');
      // the order is fetched once; after a restart the same state is found again by its checkout
      const again = beginRestore(w.home, w.hubKey, { ...w.order, id: 'pca_test2' });
      assert.equal(again.order_id, 'pca_test2'); assert.equal(again.keys_written_for, 'pk1');
      const r2 = await runRestore(w.cx, again);
      assert.equal(r2.phase, 'done', JSON.stringify(r2));
      assert.equal(w.hub.pickups, 1); assert.equal(w.hub.confirms, 1);
      assert.ok(existsSync(restorePath(w.home, w.hubKey, 'cko_t1')));
    } finally { w.close(); }
  });

  test('a restore that fails before the hub confirmed leaves no key behind, and a retry keeps the folder label', async () => {
    const w = await world(view());
    try {
      w.hub.loginFails = 1;
      const r1 = await runRestore(w.cx, beginRestore(w.home, w.hubKey, w.order));
      assert.equal(r1.phase, 'failed', JSON.stringify(r1));
      assert.match(r1.reason, /could not log in/);
      assert.deepEqual(Object.keys(readKeyFile(w.home).data.hubs[w.hubKey].agents ?? {}), [], 'the key it wrote is removed');
      const label = resolveFolder(w.home, join(w.dest, 'Proj', 'f0')).binding?.agent;
      const again = beginRestore(w.home, w.hubKey, { ...w.order, id: 'pca_test3' });
      const r2 = await runRestore(w.cx, again);
      assert.equal(r2.phase, 'done', JSON.stringify(r2));
      const agents = Object.keys(readKeyFile(w.home).data.hubs[w.hubKey].agents);
      assert.equal(agents.length, 1);
      assert.ok(!/-2$/.test(agents[0]), 'not relabelled: ' + agents[0]);
      if (label) assert.equal(agents[0], label, 'the label the folder was bound with');
    } finally { w.close(); }
  });

  test('a cancelled or replaced checkout ends the run; a destination the user removed fails it with a plain reason', async () => {
    const w = await world(view());
    try {
      const s = beginRestore(w.home, w.hubKey, w.order);
      w.hub.view = { ...w.hub.view, status: 'cancelled' };
      assert.equal((await runRestore(w.cx, s)).phase, 'ended');
      removeDestination(w.home, w.d.id);
      w.hub.view = { ...w.hub.view, status: 'rendered' };
      const r = await runRestore(w.cx, s);
      assert.equal(r.phase, 'failed');
      assert.match(r.reason, /not approved on this PC any more/);
    } finally { w.close(); }
  });

  test('a Codex agent gets its own clone in its folder: the tracked AGENTS.md stays, the override is excluded, the folder is marked Codex', async () => {
    const l = lab();
    writeFileSync(join(l.src, 'AGENTS.md'), 'project conventions\n'); G(l.src, 'add', 'AGENTS.md'); G(l.src, 'commit', '-qm', 'agents');
    const tip = G(l.src, 'rev-parse', 'HEAD');
    const repo = { remote_name: 'origin', url: 'https://git.lab.example/core.git', clone_folder: 'core' };
    const cp = { integration_branch: 'integration/core', integration_head: tip, merge_commits: [l.first] };
    const agents = [agentOf({ repo, checkpoint: cp }, 0, { provider: 'codex', permissions: 'bypassPermissions' }), agentOf({ repo, checkpoint: cp }, 1, { provider: 'codex', permissions: 'default' })];
    const w = await world(view({ agents }));
    try {
      const r1 = await runRestore(w.cx, beginRestore(w.home, w.hubKey, w.order));
      // The clone tracks an AGENTS.md: the scan reports it, so each folder waits for the PC's user first.
      assert.equal(r1.phase, 'waiting', JSON.stringify(r1));
      for (const f of ['f0', 'f1']) assert.ok(repairFolder(w.home, join(w.dest, 'Proj', f), { claudeJson: w.claudeJson, grantTrust: true, acceptChanges: true }).actions.length);
      const r = await runRestore(w.cx, activeRestores(w.home, w.hubKey)[0]);
      assert.equal(r.phase, 'done', JSON.stringify(r));
      assert.equal(existsSync(join(w.dest, 'Proj', 'core')), false, 'no shared clone beside the Codex folders');
      for (const [i, f] of ['f0', 'f1'].entries()) {
        const dir = join(w.dest, 'Proj', f);
        assert.equal(G(dir, 'rev-parse', '--show-toplevel').toLowerCase(), dir.replace(/\\/g, '/').toLowerCase(), `${f} is its own clone`);
        assert.equal(G(dir, 'rev-parse', 'HEAD'), tip);
        assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8').replace(/\r\n/g, '\n'), 'project conventions\n', 'the tracked AGENTS.md is unchanged');
        assert.equal(G(dir, 'diff', '--stat', 'HEAD', '--', 'AGENTS.md'), '', 'and git sees no change to it');
        const role = readFileSync(join(dir, 'AGENTS.override.md'), 'utf8');
        assert.equal(role.split('\n')[0], OVERRIDE_MARKER);
        assert.match(role, new RegExp(`Playbook of agent ${i}\\.`));
        const ex = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8');
        for (const line of ['AGENTS.override.md', '.codex/', '.claude/', '.mcp.json']) assert.ok(ex.split(/\r?\n/).includes(line), `${line} is excluded`);
        assert.ok(existsSync(join(dir, '.claude', 'settings.json')), 'the connector wrote its approval into .claude/');
        const st = G(dir, 'status', '--porcelain', '--untracked-files=all');
        assert.equal(st, '', `git status is clean: no role file, no Codex config, none of the connector's files: ${st}`);
        assert.equal(resolveFolder(w.home, dir).binding.provider, 'codex');
      }
      assert.match(r.start_lines[0], /^codex -C .* -a never -s workspace-write /);
    } finally { w.close(); }
  });

  test('an AGENTS.override.md that Conclave did not write refuses a Codex restore before any key is picked up', async () => {
    const w = await world(view({ agents: [agentOf({}, 0, { provider: 'codex', permissions: 'default' })] }));
    try {
      const dir = join(w.dest, 'Proj', 'f0');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'AGENTS.override.md'), 'my own rules\n');
      const r = await runRestore(w.cx, beginRestore(w.home, w.hubKey, w.order));
      assert.equal(r.phase, 'failed');
      assert.match(r.reason, /agent 0: this folder holds an AGENTS\.override\.md that Conclave did not write/);
      assert.equal(w.hub.pickups, 0);
      assert.equal(readFileSync(join(dir, 'AGENTS.override.md'), 'utf8'), 'my own rules\n');
    } finally { w.close(); }
  });

  test('an unsupported provider and a handout that was changed are refused', async () => {
    const bad = agentOf({ folder: 'x' }, 0); bad.handout.body = bad.handout.body.replace('x', 'y');
    const w = await world(view({ agents: [bad] }));
    try {
      const r = await runRestore(w.cx, beginRestore(w.home, w.hubKey, w.order));
      assert.equal(r.phase, 'failed');
      assert.match(r.reason, /does not match the one the administrator rendered/);
      assert.equal(w.hub.pickups, 0);
    } finally { w.close(); }
  });

});

// docs/checkout.md §6 "Restore by the connector", target other_pc (docs/acceptance.md "Restore target"): the PC is paired,
// the request waits for the administrator, then the restore clones from a real git remote (a bare repository in a temporary
// folder, reached through an https URL that a git config of this test's own rewrites to it), or fetches and fast-forwards a
// clean clone that is already there. Nothing is pushed.
describe('a restore to another PC, from a real remote', { skip: !hasGit }, () => {
  let pki;
  before(() => { pki = testCa('Other PC restore CA'); });
  const URL_ = 'https://git.other.example/core.git';
  function remote() {
    const root = mk('cn-rst-remote-');
    const bare = join(root, 'core.git'), work = join(root, 'work');
    mkdirSync(work);
    spawnSync('git', ['init', '-q', '--bare', '-b', 'integration/core', bare]);
    G(work, 'init', '-q', '-b', 'integration/core');
    writeFileSync(join(work, 'a.txt'), 'one\n'); G(work, 'add', '.'); G(work, 'commit', '-qm', 'one');
    const first = G(work, 'rev-parse', 'HEAD');
    G(work, 'push', '-q', bare, 'integration/core');
    const xdg = join(root, 'xdg');
    mkdirSync(join(xdg, 'git'), { recursive: true });
    writeFileSync(join(xdg, 'git', 'config'), `[url "${bare.replace(/\\/g, '/')}"]\n\tinsteadOf = ${URL_}\n`);
    process.env.XDG_CONFIG_HOME = xdg;
    const commit = (text, msg) => { writeFileSync(join(work, 'a.txt'), text); G(work, 'commit', '-qam', msg); G(work, 'push', '-q', bare, 'integration/core'); return G(work, 'rev-parse', 'HEAD'); };
    return { root, bare, work, first, commit, tipOf: () => G(bare, 'rev-parse', 'refs/heads/integration/core') };
  }
  async function world(r, tip) {
    const handout = { repo: { remote_name: 'origin', url: URL_, clone_folder: 'f0' }, checkpoint: { integration_branch: 'integration/core', integration_head: tip, merge_commits: [r.first] } };
    const view = { id: 'cko_other1', status: 'rendered', target: 'other_pc', team: 'Team', scope: 'team', agents: [agentOf(handout, 0)] };
    const hub = await stubHub(pki, view);
    hub.state = 'submitted';
    const base = mk(), home = join(base, 'home'), dest = join(base, 'dest'), claudeJson = join(base, 'claude.json');
    mkdirSync(home, { recursive: true }); mkdirSync(dest);
    writeFileSync(join(home, 'conclave.mjs'), '');
    const hubKey = putHub(home, { hubId: 'hub-other', origin: hub.origin, caPem: pki.caPem, appKey: APP });
    const section = readKeyFile(home).data.hubs[hubKey];
    const d = addDestination(home, dest, 'Other PC').destination;
    const cx = { home, hubKey, section, hub: connect(section).hub, auth: { Authorization: `Bearer ${APP}` }, claudeJson };
    const order = { id: 'pca_other1', kind: 'restore', payload: { checkout_id: view.id, destination_id: d.id } };
    return { hub, home, dest, cx, order, dir: join(dest, 'Proj', 'f0'), close: () => { for (const s of hub.sockets) s.destroy(); hub.server.close(); } };
  }
  const head = (dir) => G(dir, 'rev-parse', 'HEAD');

  test('a PC with no clone waits for the approval, then clones from the remote at its tip; nothing is pushed', async () => {
    const r = remote();
    const tip = r.commit('two\n', 'two');
    const w = await world(r, tip);
    try {
      const s = beginRestore(w.home, w.cx.hubKey, w.order);
      const waiting = await runRestoreRaw(w.cx, s);
      assert.equal(waiting.phase, 'waiting');
      assert.match(waiting.note, /Waiting for the administrator to approve this PC/);
      assert.equal(existsSync(w.dir), false, 'nothing is cloned before the approval');
      assert.equal(w.hub.pickups, 0);
      w.hub.state = 'approved';
      const done = await runRestore(w.cx, s);
      assert.equal(done.phase, 'done', JSON.stringify(done));
      assert.equal(head(w.dir), tip, 'the agent folder is the clone, at the remote tip');
      assert.equal(G(w.dir, 'symbolic-ref', '--short', 'HEAD'), 'integration/core');
      assert.equal(G(w.dir, 'config', '--get', 'remote.origin.url'), URL_);
      assert.equal(readFileSync(join(w.dir, 'a.txt'), 'utf8').replace(/\r/g, ''), 'two\n');
      assert.equal(w.hub.pickups, 1); assert.equal(w.hub.confirms, 1);
      assert.equal(r.tipOf(), tip, 'nothing was pushed to the remote');
    } finally { w.close(); }
  });

  test('a PC with an older clean clone fetches and fast-forwards it to the remote tip; nothing is pushed', async () => {
    const r = remote();
    // The clone this PC already has, from before the new commits.
    const base = mk(), stale = join(base, 'stale');
    G(base, 'clone', '-q', URL_, stale);
    assert.equal(head(stale), r.first);
    const tip = r.commit('three\n', 'three');
    const w = await world(r, tip);
    try {
      mkdirSync(dirname(w.dir), { recursive: true });
      renameSync(stale, w.dir);
      assert.equal(head(w.dir), r.first, 'behind the remote before the restore');
      w.hub.state = 'approved';
      const done = await runRestore(w.cx, beginRestore(w.home, w.cx.hubKey, w.order));
      assert.equal(done.phase, 'done', JSON.stringify(done));
      assert.equal(head(w.dir), tip, 'fast-forwarded to the remote tip');
      assert.equal(G(w.dir, 'merge-base', '--is-ancestor', r.first, 'HEAD') === '', true, 'a fast-forward keeps the old commit in history');
      assert.equal(readFileSync(join(w.dir, 'a.txt'), 'utf8').replace(/\r/g, ''), 'three\n');
      assert.equal(G(w.dir, 'status', '--porcelain', '--untracked-files=no'), '', 'the clone is clean');
      assert.equal(r.tipOf(), tip, 'nothing was pushed to the remote');
    } finally { w.close(); }
  });
});
