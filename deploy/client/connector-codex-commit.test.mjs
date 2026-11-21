// A Codex agent commits through the connector (docs/connector.md "Codex folders"): the `commit` tool of its local
// `conclave` server commits only the files it names, on its own branch, as the agent, with hooks off and no push, and
// refuses anything in .git or .codex, the role file, and any path outside the clone. Its role file AGENTS.override.md is
// marked, kept out of git, checked by `conclave check` and put back by `conclave repair`. Temporary folders and a stub
// hub on 127.0.0.1 only; plain node:test.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testCa } from '../../server/test/test-ca.mjs';
import { cleanPath, commitFiles, validBranch, TOOL } from './connector/commit.mjs';
import { OVERRIDE_MARKER, overrideText, overrideState, roleFileProblem, writeOverride } from './connector/role.mjs';
import { putHub, putAgentKey, caFingerprint } from './connector/keyfile.mjs';
import { registerFolder, repairFolder } from './connector/register.mjs';
import { resolveFolder } from './connector/registry.mjs';
import { runCheck } from './connector/check.mjs';
import { codexToolsState } from './connector/codextools.mjs';
import { canonicalFolder, WIN } from './connector/paths.mjs';
import { line } from './connector/reasons.mjs';
import { commitAuthor } from './connector/mcpserver.mjs';
import { startBroker } from './connector/broker.mjs';
import { approveFolderByConnector } from './connector/approvals.mjs';
process.env.CONCLAVE_KEY_STORE = 'file';
/** The connector's broker for a test home, the folder allowed as if the PC user had clicked: the session asks it for its turn token. */
const withConnector = async (s, fn) => { approveFolderByConnector(s.home, s.folder, resolveFolder(s.home, s.folder).binding); const b = await startBroker({ home: s.home, deps: { renewMs: 3_600_000 } }); try { return await fn(); } finally { await b.close(); } };

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'conclave.mjs');
const hasGit = spawnSync('git', ['--version']).status === 0;
const gitOpts = { skip: hasGit ? false : 'git is not on this PC' };
const tmp = [];
const mk = (p = 'cx-commit-') => { const d = mkdtempSync(join(tmpdir(), p)); tmp.push(d); return d; };
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
const G = (dir, ...args) => {
  const r = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.org', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const AUTHOR = { name: 'Conclave · Developer 4', email: 'agent-dev4@agents.conclave.invalid' };

/** A remote with main (tracking AGENTS.md and a.txt) and the agent's folder as its own clone of it, on main. */
function clone() {
  const base = mk();
  const seed = join(base, 'seed'), remote = join(base, 'remote.git'), folder = join(base, 'agent folder'), home = join(base, 'conclave home');
  mkdirSync(seed); mkdirSync(home);
  G(seed, 'init', '-q', '-b', 'main');
  writeFileSync(join(seed, 'AGENTS.md'), 'project conventions\n'); writeFileSync(join(seed, 'a.txt'), 'one\n');
  G(seed, 'add', '.'); G(seed, 'commit', '-qm', 'start');
  G(base, 'clone', '-q', '--bare', seed, remote);
  G(base, 'clone', '-q', remote, folder);
  writeFileSync(join(folder, '.git', 'info', 'exclude'), 'AGENTS.override.md\n.codex/\n');
  return { base, remote, folder: canonicalFolder(folder), home, remoteHead: () => G(remote, 'rev-parse', 'refs/heads/main'), remoteRefs: () => G(remote, 'for-each-ref', '--format=%(refname) %(objectname)') };
}
const commit = (c, over) => commitFiles({ home: c.home, folder: c.folder, author: AUTHOR, message: 'Change things', ...over });

describe('the paths the commit tool takes', () => {
  test('a clean relative file path is taken, with either separator', () => {
    assert.equal(cleanPath('src\\a.ts'), 'src/a.ts');
    assert.equal(cleanPath('./docs//x.md'), 'docs/x.md');
    assert.equal(cleanPath('AGENTS.md'), 'AGENTS.md', 'the project\'s own AGENTS.md may be committed');
  });
  test('.git, .codex, the role file, the connector\'s files, "..", absolute paths and patterns are refused', () => {
    const cases = {
      '.git/config': /nothing in \.git/, 'sub/.git/hooks/x': /nothing in \.git/, '.GIT/hooks/pre-commit': /nothing in \.git/, '.git./x': /nothing in \.git/, '.git /x': /nothing in \.git/, 'GIT~1/config': /nothing in \.git/,
      '.codex/config.toml': /\.codex is this agent's own config/, 'a/.Codex/x': /\.codex/,
      'AGENTS.override.md': /role file/, 'docs/agents.OVERRIDE.md': /role file/,
      '.mcp.json': /connector's/, '.claude/settings.local.json': /connector's/,
      '../x': /"\.\." is refused/, 'a/../../x': /"\.\." is refused/, 'a/..': /"\.\." is refused/,
      '/etc/passwd': /absolute/, 'C:\\Windows\\x': /absolute/, 'c:x': /absolute/, '\\\\server\\share\\x': /absolute/, '~/x': /absolute/,
      'file.txt:stream': /":"/, '*.js': /patterns/, 'src/[ab].ts': /patterns/, '': /non-empty/, '.': /this folder itself/, 'a\u0000b': /control/,
    };
    for (const [p, re] of Object.entries(cases)) assert.throws(() => cleanPath(p), re, JSON.stringify(p));
  });
  test('branch names: own names are taken; options, "..", hidden parts and HEAD are not', () => {
    for (const b of ['dev/x', 'feature-1', 'a.b/c_d']) assert.ok(validBranch(b), b);
    for (const b of ['-f', '--force', 'a..b', '.hidden', 'a/.b', 'x.lock', 'HEAD', 'a b', 'a/', '/a', '', 'a//b', 'x;rm']) assert.ok(!validBranch(b), b);
  });
  test('the tool says what it refuses and never mentions pushing as something it does', () => {
    assert.match(TOOL.description, /nothing is pushed/);
    assert.match(TOOL.description, /\.git or \.codex, the role file AGENTS\.override\.md, and any path outside this folder/);
    const src = readFileSync(join(HERE, 'connector', 'commit.mjs'), 'utf8');
    assert.doesNotMatch(src, /'push'|"push"/, 'commit.mjs never runs git push');
  });
});

describe('commitFiles in the agent\'s own clone', gitOpts, () => {
  test('commits only the named files, on a new branch of its own, as the agent; nothing is pushed', () => {
    const c = clone();
    const before = c.remoteRefs();
    writeFileSync(join(c.folder, 'a.txt'), 'two\n'); writeFileSync(join(c.folder, 'b.txt'), 'new\n'); writeFileSync(join(c.folder, 'c.txt'), 'not named\n');
    const r = commit(c, { paths: ['a.txt', 'b.txt'], branch: 'dev/x', message: 'Edit a, add b\n\nWith a body.' });
    assert.equal(r.ok, true, r.reason);
    assert.deepEqual([r.branch, r.created, r.files], ['dev/x', true, ['a.txt', 'b.txt']]);
    assert.equal(G(c.folder, 'symbolic-ref', '--short', 'HEAD'), 'dev/x');
    assert.equal(G(c.folder, 'rev-parse', 'HEAD'), r.commit);
    assert.equal(G(c.folder, 'show', '--name-only', '--format=', 'HEAD'), 'a.txt\nb.txt');
    assert.equal(G(c.folder, 'log', '-1', '--format=%an <%ae>|%cn <%ce>|%B'), `${AUTHOR.name} <${AUTHOR.email}>|${AUTHOR.name} <${AUTHOR.email}>|Edit a, add b\n\nWith a body.`);
    assert.equal(G(c.folder, 'status', '--porcelain'), '?? c.txt', 'the file it did not name is left as it was');
    assert.notEqual(spawnSync('git', ['-C', c.folder, 'config', '--get', 'branch.dev/x.remote']).status, 0, 'the new branch has no upstream');
    assert.equal(c.remoteRefs(), before, 'the remote is unchanged: nothing was pushed');
    // A second commit on the same branch, the one checked out now.
    writeFileSync(join(c.folder, 'c.txt'), 'now named\n');
    const r2 = commit(c, { paths: ['c.txt'] });
    assert.equal(r2.ok, true, r2.reason);
    assert.deepEqual([r2.branch, r2.created], ['dev/x', false]);
  });
  test('a branch a remote has, or the one that tracks it, is refused, and nothing is committed', () => {
    const c = clone();
    writeFileSync(join(c.folder, 'a.txt'), 'two\n');
    const head = G(c.folder, 'rev-parse', 'HEAD');
    for (const branch of [null, 'main']) {
      const r = commit(c, { paths: ['a.txt'], branch });
      assert.equal(r.ok, false);
      assert.match(r.reason, /main is a shared branch \(origin\/main\); commit on a branch of your own/);
    }
    assert.equal(G(c.folder, 'rev-parse', 'HEAD'), head);
    assert.equal(commit(c, { paths: ['a.txt'], branch: '--force' }).reason.includes('is not a branch name'), true);
  });
  test('hooks never run: not in .git/hooks, not in a hooksPath the repo sets, not on the branch switch', () => {
    const c = clone();
    const marker = join(c.base, 'hook-ran').replace(/\\/g, '/');
    const hook = `#!/bin/sh\necho ran >> "${marker}"\n`;
    for (const d of [join(c.folder, '.git', 'hooks'), join(c.folder, 'myhooks')]) {
      mkdirSync(d, { recursive: true });
      for (const h of ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'post-checkout', 'pre-push', 'reference-transaction']) writeFileSync(join(d, h), hook, { mode: 0o755 });
    }
    // Proof that the hooks would run under plain git:
    G(c.folder, 'checkout', '-q', '-b', 'probe'); G(c.folder, 'checkout', '-q', 'main');
    assert.ok(existsSync(marker), 'plain git runs the planted post-checkout hook');
    rmSync(marker);
    G(c.folder, 'config', 'core.hooksPath', 'myhooks');
    writeFileSync(join(c.folder, 'a.txt'), 'two\n');
    const r = commit(c, { paths: ['a.txt'], branch: 'dev/hooks' });
    assert.equal(r.ok, true, r.reason);
    assert.equal(existsSync(marker), false, 'no hook ran during the commit or the branch switch');
    assert.deepEqual(readdirSync(join(c.home, 'no-hooks')), [], 'the connector\'s hooks folder is empty');
  });
  test('inherited GIT_* variables, the repo\'s fsmonitor and signing never reach the commit; GIT~1 is refused', () => {
    const c = clone();
    const other = join(c.base, 'other'); mkdirSync(other); G(other, 'init', '-q', '-b', 'main');
    const marker = join(c.base, 'ran').replace(/\\/g, '/');
    const script = (name) => { const p = join(c.base, name); writeFileSync(p, `#!/bin/sh\necho ${name} >> "${marker}"\nexit 1\n`, { mode: 0o755 }); return p.replace(/\\/g, '/'); };
    G(c.folder, 'config', 'core.fsmonitor', script('fsmonitor'));
    G(c.folder, 'config', 'commit.gpgsign', 'true');
    G(c.folder, 'config', 'gpg.program', script('gpg'));
    const saved = {};
    const inherit = { GIT_DIR: join(other, '.git'), GIT_WORK_TREE: other, GIT_INDEX_FILE: join(c.base, 'stray-index'), GIT_AUTHOR_NAME: 'PC User', GIT_AUTHOR_EMAIL: 'pc-user@example.org', GIT_COMMITTER_NAME: 'PC User', GIT_CONFIG_PARAMETERS: "'core.hookspath=/nowhere'" };
    for (const [k, v] of Object.entries(inherit)) { saved[k] = process.env[k]; process.env[k] = v; }
    let r, alias;
    try {
      writeFileSync(join(c.folder, 'a.txt'), 'two\n');
      alias = commit(c, { paths: ['GIT~1/config'], branch: 'dev/env' });
      r = commit(c, { paths: ['a.txt'], branch: 'dev/env' });
    } finally { for (const k of Object.keys(inherit)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
    assert.equal(alias.ok, false);
    assert.match(alias.reason, /nothing in \.git/);
    assert.equal(r.ok, true, r.reason);
    assert.equal(G(c.folder, 'log', '-1', '--format=%an <%ae>|%G?'), `${AUTHOR.name} <${AUTHOR.email}>|N`, 'the agent is the author, and the commit is not signed');
    assert.equal(G(c.folder, 'show', '--name-only', '--format=', 'HEAD'), 'a.txt', 'committed in the agent\'s clone');
    assert.equal(spawnSync('git', ['-C', other, 'rev-parse', '--verify', '-q', 'HEAD']).status === 0, false, 'nothing landed in the repo GIT_DIR named');
    assert.equal(existsSync(marker), false, 'neither the fsmonitor nor the signing program ran');
  });
  test('refused before git runs: .git, .codex, the role file, paths outside the clone, a folder, an unknown file', () => {
    const c = clone();
    G(c.folder, 'checkout', '-q', '-b', 'dev/r');
    mkdirSync(join(c.folder, '.codex')); writeFileSync(join(c.folder, '.codex', 'config.toml'), 'x = 1\n');
    writeFileSync(join(c.folder, 'AGENTS.override.md'), `${OVERRIDE_MARKER}\nrole\n`);
    mkdirSync(join(c.folder, 'sub')); writeFileSync(join(c.folder, 'sub', 'f.txt'), 'f\n');
    const cases = [
      [['.git/config'], /nothing in \.git/], [['.git/hooks/pre-commit'], /nothing in \.git/], [['.codex/config.toml'], /\.codex/],
      [['AGENTS.override.md'], /role file/], [['../outside.txt'], /"\.\." is refused/], [[join(c.base, 'x.txt')], /absolute/],
      [['sub'], /is a folder; name the files/], [['nope.txt'], /no such file, and git does not track it/],
      [['a.txt', '.git/HEAD'], /nothing in \.git/],
    ];
    const head = G(c.folder, 'rev-parse', 'HEAD');
    for (const [paths, re] of cases) {
      const r = commit(c, { paths });
      assert.equal(r.ok, false, JSON.stringify(paths));
      assert.match(r.reason, re, JSON.stringify(paths));
    }
    assert.equal(G(c.folder, 'rev-parse', 'HEAD'), head, 'nothing was committed');
    assert.equal(commit(c, { paths: [] }).reason, 'name at least one file in paths');
    assert.equal(commit(c, { paths: ['a.txt'], message: '  ' }).reason, 'a commit message is needed');
    assert.match(commit(c, { paths: ['a.txt'], author: null }).reason, /does not know this agent's name/);
  });
  test('a link that leads out of the clone, or into .git, is refused', (t) => {
    const c = clone();
    G(c.folder, 'checkout', '-q', '-b', 'dev/l');
    const outside = join(c.base, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'secret.txt'), 's\n');
    try { symlinkSync(outside, join(c.folder, 'out'), 'junction'); } catch (e) { return void t.skip(`no links here: ${e.code}`); }
    symlinkSync(join(c.folder, '.git'), join(c.folder, 'gitlink'), 'junction');
    for (const [p, re] of [['out/secret.txt', /leads outside this folder/], ['out/new.txt', /leads outside this folder/], ['gitlink/config', /nothing in \.git/]]) {
      const r = commit(c, { paths: [p] });
      assert.equal(r.ok, false, p);
      assert.match(r.reason, re, p);
    }
  });
  test('a deleted file is committed as deleted; unchanged files say there is nothing to commit', () => {
    const c = clone();
    G(c.folder, 'checkout', '-q', '-b', 'dev/d');
    rmSync(join(c.folder, 'a.txt'));
    const r = commit(c, { paths: ['a.txt'] });
    assert.equal(r.ok, true, r.reason);
    assert.equal(G(c.folder, 'show', '--name-status', '--format=', 'HEAD'), 'D\ta.txt');
    assert.equal(commit(c, { paths: ['AGENTS.md'] }).reason, 'nothing to commit: those files have no changes');
  });
  test('a file the exclude list hides is refused; a worktree is not the agent\'s own clone', () => {
    const c = clone();
    G(c.folder, 'checkout', '-q', '-b', 'dev/i');
    writeFileSync(join(c.folder, '.git', 'info', 'exclude'), 'AGENTS.override.md\n.codex/\n*.log\n');
    writeFileSync(join(c.folder, 'x.log'), 'log\n');
    assert.ok(commit(c, { paths: ['x.log'] }).reason.startsWith('x.log: is ignored by *.log in '));
    const wt = join(c.base, 'wt');
    G(c.folder, 'worktree', 'add', '-q', '-b', 'dev/wt', wt);
    writeFileSync(join(wt, 'a.txt'), 'wt\n');
    assert.match(commitFiles({ home: c.home, folder: wt, author: AUTHOR, message: 'm', paths: ['a.txt'] }).reason, /worktree or a linked repo/);
  });
  test('with * in the exclude list a new plain file is committed, one the repo .gitignore hides is refused', () => {
    const c = clone();
    G(c.folder, 'checkout', '-q', '-b', 'dev/star');
    const NL = String.fromCharCode(10);
    writeFileSync(join(c.folder, '.git', 'info', 'exclude'), '*' + NL);
    writeFileSync(join(c.folder, '.gitignore'), ['.env', 'secrets/', ''].join(NL));
    writeFileSync(join(c.folder, 'new.txt'), 'plain' + NL); writeFileSync(join(c.folder, '.env'), 'KEY=1' + NL);
    mkdirSync(join(c.folder, 'secrets')); writeFileSync(join(c.folder, 'secrets', 'k.pem'), 'x' + NL);
    assert.ok(commit(c, { paths: ['.env'] }).reason.startsWith('.env: is ignored by .env in .gitignore:1'));
    assert.match(commit(c, { paths: ['secrets/k.pem'] }).reason, /is ignored by/);
    assert.match(commit(c, { paths: ['new.txt', '.env'] }).reason, /is ignored by/, 'one refused file stops the whole commit');
    assert.equal(G(c.folder, 'rev-parse', 'HEAD'), G(c.folder, 'rev-parse', 'main'), 'nothing was committed');
    assert.equal(commit(c, { paths: ['new.txt'] }).ok, true);
    assert.equal(G(c.folder, 'ls-tree', '-r', '--name-only', 'HEAD', 'new.txt'), 'new.txt');
    assert.equal(G(c.folder, 'ls-tree', '-r', '--name-only', 'HEAD', '.env'), '');
  });
  test('a line above * in the exclude list, and a global excludes file, also refuse a file', () => {
    const NL = String.fromCharCode(10);
    const c = clone();
    G(c.folder, 'checkout', '-q', '-b', 'dev/above');
    writeFileSync(join(c.folder, '.git', 'info', 'exclude'), ['*.key', '*'].join(NL) + NL);
    writeFileSync(join(c.folder, 'a.key'), 'k' + NL); writeFileSync(join(c.folder, 'ok.txt'), 'ok' + NL);
    assert.match(commit(c, { paths: ['a.key'] }).reason, /^a.key: is ignored by/);
    const glob = join(c.base, 'global-ignore');
    writeFileSync(glob, 'secret.pem' + NL);
    G(c.folder, 'config', 'core.excludesFile', glob);
    writeFileSync(join(c.folder, '.git', 'info', 'exclude'), '*' + NL);
    writeFileSync(join(c.folder, 'secret.pem'), 'p' + NL);
    assert.match(commit(c, { paths: ['secret.pem'] }).reason, /^secret.pem: is ignored by/);
    assert.equal(commit(c, { paths: ['ok.txt'] }).ok, true, 'a plain file is still committed');
    assert.equal(G(c.folder, 'ls-tree', '-r', '--name-only', 'HEAD', 'secret.pem'), '');
  });
  test('the author is the agent\'s label from the hub, cleaned, with an address that never resolves', () => {
    assert.deepEqual(commitAuthor('Conclave · Dev <x>\n', 'agent-ab'), { name: 'Conclave · Dev  x', email: 'agent-ab@agents.conclave.invalid' });
    assert.equal(commitAuthor(null, 'agent-ab'), null);
  });
});

// ───── the role file, check and repair ─────
const APP = 'ah_app_FAKEappKEYforCODEXcommitTEST01';
const SES = 'ah_ses_FAKEsessionKEYforCODEXcommit01';
function connectorHome(pki, origin, { provider = 'codex' } = {}) {
  const c = clone();
  writeFileSync(join(c.home, 'conclave.mjs'), '');
  const hubKey = putHub(c.home, { hubId: 'hub-cx', origin, caPem: pki.caPem, appKey: APP });
  putAgentKey(c.home, hubKey, 'dev-4', SES);
  const claudeJson = join(c.base, 'claude.json');
  registerFolder(c.home, c.folder, { hubId: 'hub-cx', caSha256: caFingerprint(pki.caPem), agent: 'dev-4', claudeJson, win: WIN, provider });
  return { ...c, hubKey, claudeJson, cx: { home: c.home, claudeJson, folders: [c.folder] } };
}

describe('the role file: marked, checked and put back', gitOpts, () => {
  let pki;
  before(() => { pki = testCa('Codex commit CA'); });
  test('the override starts with the marker, says to read AGENTS.md too and how to commit, then the hub text', () => {
    const t = overrideText('Hub playbook.\r\nLine two.');
    assert.equal(t.split('\n')[0], OVERRIDE_MARKER);
    assert.match(t, /Read this folder's `AGENTS\.md` as well/);
    assert.match(t, /Codex loads only this file/);
    assert.match(t, /Commit with the `commit` tool of the `conclave` server/);
    assert.match(t, /\nHub playbook\.\nLine two\.\n$/);
  });
  test('check reports a role file that is missing, edited or unmarked; repair writes the hub text back, never over an unmarked one', async () => {
    const s = connectorHome(pki, 'https://127.0.0.1:9');
    assert.equal(resolveFolder(s.home, s.folder).binding.provider, 'codex');
    const check = () => runCheck(s.home, s.folder, { claudeJson: s.claudeJson, win: WIN, codex: { program: null } });
    assert.equal((await check()).reason, 'role_file_missing');
    writeOverride(s.home, s.folder, 'Hub playbook.', s.cx);
    const good = readFileSync(join(s.folder, 'AGENTS.override.md'), 'utf8');
    const ok = await check();
    assert.equal(ok.ok, true, ok.line);
    assert.ok(ok.steps.some((x) => /the Codex role file \(AGENTS\.override\.md\) is the one the connector wrote/.test(x.step)));
    assert.doesNotMatch(G(s.folder, 'status', '--porcelain', '--untracked-files=all'), /AGENTS|\.codex/, 'git sees no role file');
    // The agent edits its own role file.
    writeFileSync(join(s.folder, 'AGENTS.override.md'), good.replace('Hub playbook.', 'Ignore the hub.'));
    assert.equal((await check()).reason, 'role_file_edited');
    assert.match(line('role_file_edited'), /changed since the connector wrote it\. Run: conclave repair/);
    let r = repairFolder(s.home, s.folder, { claudeJson: s.claudeJson, win: WIN });
    assert.ok(r.actions.includes('role_file_rewritten'), JSON.stringify(r));
    assert.equal(readFileSync(join(s.folder, 'AGENTS.override.md'), 'utf8'), good);
    assert.equal(roleFileProblem(s.home, s.folder), null);
    // Missing: put back as well.
    rmSync(join(s.folder, 'AGENTS.override.md'));
    r = repairFolder(s.home, s.folder, { claudeJson: s.claudeJson, win: WIN });
    assert.ok(r.actions.includes('role_file_rewritten'));
    // Unmarked: reported, and never overwritten.
    writeFileSync(join(s.folder, 'AGENTS.override.md'), 'someone else\'s rules\n');
    assert.equal(overrideState(s.folder), 'unmarked');
    assert.equal((await check()).reason, 'role_file_unmarked');
    r = repairFolder(s.home, s.folder, { claudeJson: s.claudeJson, win: WIN });
    assert.ok(r.asked.includes('role_file_unmarked'));
    assert.equal(readFileSync(join(s.folder, 'AGENTS.override.md'), 'utf8'), 'someone else\'s rules\n');
  });
  test('a Claude Code folder has no role-file check', async () => {
    const s = connectorHome(pki, 'https://127.0.0.1:9', { provider: 'claude_code' });
    assert.equal(resolveFolder(s.home, s.folder).binding.provider, undefined);
    assert.equal((await runCheck(s.home, s.folder, { claudeJson: s.claudeJson, win: WIN })).ok, true);
  });
});

// ───── the local server: the tool is listed and answered for a Codex folder only ─────
function stubHub(pki) {
  const hub = { requests: [] };
  hub.server = https.createServer({ key: pki.leafKey, cert: pki.leafPem }, (req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const msg = JSON.parse(raw);
      const tool = msg.method === 'tools/call' ? msg.params.name : msg.method;
      if (req.url.startsWith('/connector/v1/turn-tokens')) {
        res.writeHead(req.headers.authorization === `Bearer ${APP}` ? 200 : 401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ token: 'tok-1', agent_id: 'agent-dev4', label: 'Conclave · Developer 4', expires_at: Date.now() + 900_000 }));
      }
      hub.requests.push(tool);
      const ok = (result) => { res.writeHead(200, { 'content-type': 'application/json', ...(hub.digest ? { 'x-agent-hub-tools': hub.digest } : {}) }); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })); };
      if (req.headers['x-agent-hub-session'] !== 'tok-1') { res.writeHead(401); return res.end('{}'); }
      if (tool === 'initialize') return ok({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '0' } });
      if (tool === 'tools/list') return ok({ tools: [{ name: 'task_list', inputSchema: { type: 'object' } }] });
      if (msg.method === 'notifications/initialized') { res.writeHead(202); return res.end(); }
      return ok({ content: [{ type: 'text', text: 'relayed' }], structuredContent: { relayed: tool } });
    });
  });
  return new Promise((ok) => hub.server.listen(0, '127.0.0.1', () => { hub.origin = `https://127.0.0.1:${hub.server.address().port}`; hub.close = () => new Promise((r) => hub.server.close(r)); ok(hub); }));
}
function mcp(s, msgs) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, 'mcp', s.folder], { env: { ...process.env, CONCLAVE_HOME: s.home }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('close', () => resolve(out.split('\n').filter(Boolean).map((l) => JSON.parse(l))));
    for (const m of msgs) c.stdin.write(JSON.stringify(m) + '\n');
    c.stdin.end();
  });
}
/** The same, one message at a time: each waits for the answer to the one before; before(i) runs ahead of message i. */
function mcpSteps(s, msgs, before = () => {}) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, 'mcp', s.folder], { env: { ...process.env, CONCLAVE_HOME: s.home }, stdio: ['pipe', 'pipe', 'pipe'] });
    const got = []; let buf = '', i = 0;
    const next = () => { if (i >= msgs.length) return c.stdin.end(); before(i); c.stdin.write(JSON.stringify(msgs[i++]) + '\n'); };
    c.stdout.on('data', (d) => {
      buf += d; let n;
      while ((n = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, n); buf = buf.slice(n + 1); if (!l.trim()) continue; const m = JSON.parse(l); got.push(m); if (m.id === msgs[i - 1]?.id) next(); }
    });
    c.on('close', () => resolve(got));
    next();
  });
}
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex-mcp-client', version: '0' } } };
const LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
const call = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

describe('conclave mcp tells the client when its tool list changed', { ...gitOpts, concurrency: false }, () => {
  let pki;
  before(() => { pki = testCa('Tool list CA'); });
  test('an answer whose tools digest differs from the last tools/list sends list_changed once, after that answer', async () => {
    const hub = await stubHub(pki);
    try {
      const s = connectorHome(pki, hub.origin, { provider: 'claude_code' });
      hub.digest = 'aaaa';
      const msgs = [INIT, LIST, call(3, 'task_list', {}), call(4, 'task_list', {}), call(5, 'task_list', {}), { ...LIST, id: 6 }, call(7, 'task_list', {})];
      const out = await withConnector(s, () => mcpSteps(s, msgs, (i) => { if (i === 3) hub.digest = 'bbbb'; }));
      const seq = out.map((m) => m.method ?? m.id);
      assert.deepEqual(seq, [1, 2, 3, 4, 'notifications/tools/list_changed', 5, 6, 7], 'told once, right after the first answer with the new digest');
      assert.match(readFileSync(join(s.home, 'connector.log'), 'utf8'), /mcp tools changed folder=/);
    } finally { await hub.close(); }
  });
  test('a hub that sends no digest never triggers it', async () => {
    const hub = await stubHub(pki);
    try {
      const s = connectorHome(pki, hub.origin, { provider: 'claude_code' });
      const out = await withConnector(s, () => mcpSteps(s, [INIT, LIST, call(3, 'task_list', {})]));
      assert.deepEqual(out.map((m) => m.method ?? m.id), [1, 2, 3]);
    } finally { await hub.close(); }
  });
});

describe('a Codex that cannot run tools', gitOpts, () => {
  const FEATURES = (on) => `code_mode                                under development  false\ncode_mode_host                           stable             ${on}\ncode_mode_interrupt                      stable             true\n`;
  const answers = (stdout, status = 0) => { const calls = []; return { calls, run: (file, args, o) => { calls.push({ file, args, cwd: o.cwd }); return { status, stdout }; } }; };
  const NATIVE = { file: join(tmpdir(), 'cx', 'codex.exe'), prefix: [] };
  test('a native Codex with the host feature on and no host beside it is broken; with the host it is fine', () => {
    const a = answers(FEATURES(true));
    assert.equal(codexToolsState({ program: NATIVE, run: a.run, exists: () => false, win: true }).state, 'broken');
    assert.deepEqual(a.calls[0].args, ['features', 'list'], 'asks the program itself, nothing else');
    let looked = null;
    assert.equal(codexToolsState({ program: NATIVE, run: a.run, exists: (p) => { looked = p; return true; }, win: true }).state, 'ok');
    assert.equal(looked, join(dirname(NATIVE.file), 'codex-code-mode-host.exe'));
  });
  test('an npm install is looked for in its package\'s vendor folder; with no vendor folder it is not checked', () => {
    const base = mkdtempSync(join(tmpdir(), 'cx-npm-'));
    const script = join(base, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    mkdirSync(dirname(script), { recursive: true }); writeFileSync(script, '');
    const prog = { file: process.execPath, prefix: [script] };
    const a = answers(FEATURES(true));
    assert.equal(codexToolsState({ program: prog, run: a.run, win: true }).state, 'unknown', 'no vendor folder at all: a step, not a failure');
    assert.deepEqual(a.calls[0].args, [script, 'features', 'list']);
    mkdirSync(join(base, 'node_modules', '@openai', 'codex', 'vendor'), { recursive: true });
    assert.equal(codexToolsState({ program: prog, run: a.run, win: true }).state, 'broken', 'a vendor folder without the host');
    const host = join(base, 'node_modules', '@openai', 'codex', 'vendor', 'x86_64-pc-windows-msvc', 'codex', 'codex-code-mode-host.exe');
    mkdirSync(dirname(host), { recursive: true }); writeFileSync(host, '');
    assert.equal(codexToolsState({ program: prog, run: a.run, win: true }).state, 'ok');
  });
  for (const [where, at] of [['nested in the package', ['codex', 'node_modules', '@openai']], ['beside the package', []]]) {
    test(`an npm install finds the host in a platform package ${where}`, () => {
      const base = mkdtempSync(join(tmpdir(), 'cx-npm-'));
      const script = join(base, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      mkdirSync(dirname(script), { recursive: true }); writeFileSync(script, '');
      const prog = { file: process.execPath, prefix: [script] };
      const vendor = join(base, 'node_modules', '@openai', ...at, 'codex-win32-x64', 'vendor');
      mkdirSync(vendor, { recursive: true });
      const a = answers(FEATURES(true));
      assert.equal(codexToolsState({ program: prog, run: a.run, win: true }).state, 'broken', 'its vendor folder without the host');
      const host = join(vendor, 'x86_64-pc-windows-msvc', 'codex', 'codex-code-mode-host.exe');
      mkdirSync(dirname(host), { recursive: true }); writeFileSync(host, '');
      assert.equal(codexToolsState({ program: prog, run: a.run, win: true }).state, 'ok');
    });
  }
  test('never a failure when it cannot tell: feature off or absent, no answer, or no Codex found', () => {
    assert.equal(codexToolsState({ program: NATIVE, run: answers(FEATURES(false)).run, exists: () => false }).state, 'ok');
    assert.equal(codexToolsState({ program: NATIVE, run: answers('code_mode stable true\n').run, exists: () => false }).state, 'ok', 'an older Codex without the feature');
    assert.equal(codexToolsState({ program: NATIVE, run: answers('', 1).run, exists: () => false }).state, 'unknown');
    assert.equal(codexToolsState({ program: NATIVE, run: () => ({ error: new Error('ENOENT') }), exists: () => false }).state, 'unknown');
    assert.equal(codexToolsState({ program: null }).state, 'not_found');
  });
  test('conclave check stops with one plain line that says to reinstall Codex; a Claude Code folder is never asked', async () => {
    const pki = testCa('Codex tools CA');
    const s = connectorHome(pki, 'https://127.0.0.1:9');
    writeOverride(s.home, s.folder, 'Hub playbook.', s.cx);
    const broken = { program: NATIVE, run: answers(FEATURES(true)).run, exists: () => false, win: true };
    const r = await runCheck(s.home, s.folder, { claudeJson: s.claudeJson, win: WIN, codex: broken });
    assert.equal(r.reason, 'codex_tools_broken');
    assert.equal(r.line, line('codex_tools_broken'));
    assert.match(r.line, /^Codex on this PC cannot run any tool: its code-mode host program is missing, so every tool call fails\. Reinstall Codex, then check again\. Run: conclave check \(in this folder\)$/);
    const fine = await runCheck(s.home, s.folder, { claudeJson: s.claudeJson, win: WIN, codex: { ...broken, exists: () => true } });
    assert.equal(fine.ok, true, fine.line);
    assert.ok(fine.steps.some((x) => /Codex can run tools/.test(x.step)));
    const cc = connectorHome(pki, 'https://127.0.0.1:9', { provider: 'claude_code' });
    let asked = false;
    assert.equal((await runCheck(cc.home, cc.folder, { claudeJson: cc.claudeJson, win: WIN, codex: { ...broken, run: () => { asked = true; return { status: 0, stdout: FEATURES(true) }; } } })).ok, true);
    assert.equal(asked, false);
  });
});

describe('conclave mcp in a Codex folder', { ...gitOpts, concurrency: false }, () => {
  let pki;
  before(() => { pki = testCa('Codex mcp CA'); });
  test('lists commit beside the hub\'s tools and commits as the agent the hub names; the hub never sees the call', async () => {
    const hub = await stubHub(pki);
    try {
      const s = connectorHome(pki, hub.origin);
      writeFileSync(join(s.folder, 'a.txt'), 'two\n');
      const out = await withConnector(s, () => mcp(s, [INIT, LIST, call(3, 'commit', { paths: ['a.txt'], message: 'From Codex', branch: 'dev/codex' }), call(4, 'commit', { paths: ['.git/config'], message: 'x' })]));
      const tools = out.find((m) => m.id === 2).result.tools.map((t) => t.name);
      assert.deepEqual(tools, ['task_list', 'commit']);
      const ok = out.find((m) => m.id === 3).result;
      assert.equal(ok.isError, undefined, JSON.stringify(ok));
      assert.equal(ok.structuredContent.branch, 'dev/codex');
      assert.equal(ok.structuredContent.pushed, false);
      assert.match(ok.content[0].text, /^Committed [0-9a-f]{12} on dev\/codex \(a new branch\): 1 file\. Nothing was pushed\.$/);
      assert.equal(G(s.folder, 'log', '-1', '--format=%an <%ae>'), 'Conclave · Developer 4 <agent-dev4@agents.conclave.invalid>');
      const refused = out.find((m) => m.id === 4).result;
      assert.equal(refused.isError, true);
      assert.match(refused.content[0].text, /^Not committed: \.git\/config: nothing in \.git can be committed$/);
      assert.ok(!hub.requests.includes('commit'), 'the commit call never reached the hub');
      assert.match(readFileSync(join(s.home, 'connector.log'), 'utf8'), /mcp commit ok [0-9a-f]{12} on dev\/codex, 1 file\(s\)/);
    } finally { await hub.close(); }
  });
  test('a Claude Code folder gets no commit tool, and a call by that name goes to the hub', async () => {
    const hub = await stubHub(pki);
    try {
      const s = connectorHome(pki, hub.origin, { provider: 'claude_code' });
      writeFileSync(join(s.folder, 'a.txt'), 'two\n');
      const out = await withConnector(s, () => mcp(s, [INIT, LIST, call(3, 'commit', { paths: ['a.txt'], message: 'x' })]));
      assert.deepEqual(out.find((m) => m.id === 2).result.tools.map((t) => t.name), ['task_list']);
      assert.deepEqual(out.find((m) => m.id === 3).result.structuredContent, { relayed: 'commit' });
      assert.equal(G(s.folder, 'status', '--porcelain', '--', 'a.txt'), 'M a.txt', 'nothing was committed locally');
    } finally { await hub.close(); }
  });
});
