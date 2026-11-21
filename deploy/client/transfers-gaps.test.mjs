// Acceptance gaps of "Transfers and messaging" that live on the PC: a whole-folder send leaves out .git, .codex, node_modules and a
// root role file instead of failing; the Windows spellings of refused names are refused on send and on receive; and two agents
// with one label on a PC are told apart by agent id (a send by one is refused in the other's folder).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLoop, agentPathRefusal, spellingRefusal, protectedFileReason, ownFoldersOf, foreignFoldersOf } from './connector/transfers.mjs';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs one send job through runLoop and returns what the stub hub saw. */
async function sendOnce({ agentFolders, paths, framing = 'raw', agent = 'dev-1', agent_id }) {
  const seen = { chunks: [], done: null, polls: 0 };
  const job = { id: 'chn_t1:send', channel_id: 'chn_t1', kind: 'send', framing, agent, ...(agent_id ? { agent_id } : {}), local_paths: paths };
  const fetchStub = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === '/bridge/poll') { seen.polls++; return json(200, { allowed_folders: [], jobs: seen.polls === 1 ? [job] : [], poll_after_ms: 20_000 }); }
    if (u.pathname === '/bridge/channels/chn_t1') return json(200, { status: 'open', sender_done: false, received_offset: 0 });
    if (u.pathname === '/bridge/channels/chn_t1/chunk') { seen.chunks.push(Buffer.from(await new Response(init.body).arrayBuffer())); return json(200, { ok: true }); }
    if (u.pathname === '/bridge/channels/chn_t1/done') { seen.done = JSON.parse(init.body); return json(200, { status: 'done' }); }
    return json(404, { error: 'not_found' });
  };
  const ac = new AbortController();
  const run = runLoop({ hub: 'https://hub.test', key: 'ah_app_FAKE', signal: ac.signal, fetch: fetchStub, log: () => {}, agentFolders, refusedDirs: [] });
  const t0 = Date.now(); while (!seen.done && Date.now() - t0 < 10_000) await sleep(25);
  ac.abort(); await run.catch(() => {});
  return seen;
}

/** The entry names of a tar-framed stream: 4-byte header length, a JSON header {p, s}, then s bytes; a zero length ends it. */
function entryNames(buf) {
  const names = [];
  let pos = 0;
  for (;;) {
    const hl = buf.readUInt32BE(pos); pos += 4;
    if (hl === 0) break;
    const h = JSON.parse(buf.subarray(pos, pos + hl).toString('utf8')); pos += hl + h.s;
    names.push(h.p);
  }
  return names.sort();
}

test('a whole-folder send from an agent folder leaves out .git, .codex, node_modules and the root role files, and sends the rest', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ah-wholefolder-')));
  try {
    const folder = join(root, 'agent');
    for (const d of ['.git/hooks', '.codex', 'node_modules/x', 'src']) mkdirSync(join(folder, d), { recursive: true });
    for (const f of ['.git/config', '.git/hooks/pre-commit', '.codex/config.toml', 'node_modules/x/i.js', 'CLAUDE.md', 'AGENTS.md', 'AGENTS.override.md', 'notes.txt', 'src/a.js']) writeFileSync(join(folder, f), 'x');
    const r = await sendOnce({ agentFolders: () => [folder], paths: [folder], framing: 'tar' });
    assert.equal(r.done?.error, undefined, JSON.stringify(r.done));
    assert.deepEqual(entryNames(Buffer.concat(r.chunks)), ['notes.txt', 'src/a.js']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a role file sent on its own, or a file inside .git, is still refused', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ah-rolefile-')));
  try {
    const folder = join(root, 'agent');
    mkdirSync(join(folder, '.git'), { recursive: true });
    writeFileSync(join(folder, 'CLAUDE.md'), 'x'); writeFileSync(join(folder, '.git', 'config'), 'x');
    const role = await sendOnce({ agentFolders: () => [folder], paths: [join(folder, 'CLAUDE.md')] });
    assert.match(role.done?.error ?? '', /role file/);
    const git = await sendOnce({ agentFolders: () => [folder], paths: [join(folder, '.git', 'config')] });
    assert.match(git.done?.error ?? '', /\.git/);
    assert.equal(role.chunks.length + git.chunks.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('send: the Windows spellings of .git and .codex, a short name and a device name are refused', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ah-spell-')));
  try {
    const folder = join(root, 'agent'); mkdirSync(folder, { recursive: true });
    for (const name of ['.git.', '.git ', 'GIT~1', 'CODEX~1', '.codex.']) {
      assert.match(await agentPathRefusal(join(folder, name, 'config'), [folder]) ?? '', /\.git or \.codex/, name);
    }
    for (const rel of [['CON', 'x'], ['con.txt'], ['NUL'], ['COM1', 'x'], ['LPT9']]) {
      assert.equal(await agentPathRefusal(join(folder, ...rel), [folder]), 'a Windows device name', rel.join('/'));
    }
    assert.equal(spellingRefusal(join(folder, 'notes', 'a.txt')), null);
    assert.equal(spellingRefusal(join(folder, 'GITHUB~1', 'a.txt')), null); // another folder with a short name
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('receive: the same spellings cannot replace git settings, hooks or agent settings', () => {
  for (const p of ['C:/a/.git./config', 'C:/a/.git /config', 'C:/a/GIT~1/config', 'C:/a/.git./hooks/pre-commit', 'C:/a/GIT~1/hooks/post-merge', 'C:/a/.codex./config.toml', 'C:/a/CODEX~1/config.toml', 'C:/a/.claude./settings.json', 'C:/a/CON/x', 'C:/a/NUL', 'C:/a/aux.txt']) {
    assert.notEqual(protectedFileReason(p), null, p);
  }
  assert.equal(protectedFileReason('C:/a/notes/readme.md'), null);
});

test('two agents with one label on a PC are told apart by agent id: a send by one is refused in the other\'s folder', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ah-samelabel-')));
  try {
    const one = join(root, 'team-one', 'coordinator'), two = join(root, 'team-two', 'coordinator');
    for (const d of [one, two]) mkdirSync(d, { recursive: true });
    writeFileSync(join(one, 'plan.txt'), 'one'); writeFileSync(join(two, 'plan.txt'), 'two');
    // The hub calls both agents "Coordinator"; the PC registered the second as "Coordinator-2".
    const bound = [{ agent: 'Coordinator', agent_id: 'agt_one', path: one }, { agent: 'Coordinator-2', agent_id: 'agt_two', path: two }];
    const agentFolders = (who) => ownFoldersOf(bound, who);
    assert.deepEqual(foreignFoldersOf(bound, { agent: 'Coordinator', agent_id: 'agt_two' }), [one]);
    const own = await sendOnce({ agentFolders, paths: [join(two, 'plan.txt')], agent: 'Coordinator', agent_id: 'agt_two' });
    assert.equal(own.done?.error, undefined, JSON.stringify(own.done));
    assert.equal(Buffer.concat(own.chunks).toString(), 'two');
    // Coordinator of team two asks for team one's file: by label alone it would match team one's folder.
    const other = await sendOnce({ agentFolders, paths: [join(one, 'plan.txt')], agent: 'Coordinator', agent_id: 'agt_two' });
    assert.match(other.done?.error ?? '', /outside your own folder/);
    assert.equal(other.chunks.length, 0);
    // A job from an older hub (no id) still goes by label.
    const old = await sendOnce({ agentFolders, paths: [join(one, 'plan.txt')], agent: 'Coordinator' });
    assert.equal(Buffer.concat(old.chunks).toString(), 'one');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
