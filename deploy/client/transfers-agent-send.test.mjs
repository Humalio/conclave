// Task screenshots from the PC without base64 in the call (docs/transfers.md, "Task files from the PC"): the connector's transfer
// loop, run the way the worker runs it (the agent's own folders by label), sends a file from the agent's folder and nothing
// outside it. The hub is a stub fetch: a poll that hands out one send job, the channel state, the chunks and the done call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLoop } from './connector/transfers.mjs';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs one send job through runLoop and returns what the stub hub saw. */
async function sendOnce({ agentFolders, paths, label = 'dev-1' }) {
  const seen = { chunks: [], done: null, polls: 0 };
  const job = { id: 'chn_t1:send', channel_id: 'chn_t1', kind: 'send', framing: 'raw', agent: label, local_paths: paths };
  const fetchStub = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === '/bridge/poll') { seen.polls++; return json(200, { allowed_folders: [], jobs: seen.polls === 1 ? [job] : [], poll_after_ms: 20_000 }); }
    if (u.pathname === '/bridge/channels/chn_t1') return json(200, { status: 'open', sender_done: false, received_offset: 0 });
    if (u.pathname === '/bridge/channels/chn_t1/chunk') { seen.chunks.push(Buffer.from(await new Response(init.body).arrayBuffer())); return json(200, { ok: true }); }
    if (u.pathname === '/bridge/channels/chn_t1/done') { seen.done = JSON.parse(init.body); return json(200, { status: 'done' }); }
    return json(404, { error: 'not_found' });
  };
  const ac = new AbortController(), logs = [];
  const run = runLoop({ hub: 'https://hub.test', key: 'ah_app_FAKE', signal: ac.signal, fetch: fetchStub, log: (m) => logs.push(m), agentFolders, refusedDirs: [] });
  const t0 = Date.now(); while (!seen.done && Date.now() - t0 < 10_000) await sleep(25);
  ac.abort(); await run.catch(() => {});
  return { ...seen, logs };
}

test('a screenshot in the agent\'s own folder is uploaded by the connector, bytes and checksum intact', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ah-agentsend-')));
  try {
    const folder = join(root, 'agent'); mkdirSync(join(folder, 'shots'), { recursive: true });
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(2000, 7)]);
    writeFileSync(join(folder, 'shots', 'a.png'), png);
    const r = await sendOnce({ agentFolders: (who) => (who.agent === 'dev-1' ? [folder] : []), paths: [join(folder, 'shots', 'a.png')] });
    assert.equal(r.done?.error, undefined, JSON.stringify(r.done));
    assert.equal(Buffer.concat(r.chunks).equals(png), true, 'the bytes went through the bridge route, not through a tool call');
    assert.equal(r.done.sha256, createHash('sha256').update(png).digest('hex'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a file outside the agent\'s folder, or from an agent with no folder here, is refused with the reason and nothing is uploaded', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ah-agentsend-')));
  try {
    const folder = join(root, 'agent'), other = join(root, 'other');
    mkdirSync(folder, { recursive: true }); mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'secret.png'), 'x'); writeFileSync(join(folder, 'a.png'), 'y');
    const outside = await sendOnce({ agentFolders: () => [folder], paths: [join(other, 'secret.png')] });
    assert.match(outside.done?.error ?? '', /outside your own folder/);
    assert.equal(outside.chunks.length, 0);
    const none = await sendOnce({ agentFolders: () => [], paths: [join(folder, 'a.png')] });
    assert.match(none.done?.error ?? '', /no folder registered for you/);
    assert.equal(none.chunks.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
