/**
 * Tests for the connector side of vault sync (docs/vault-sync.md, "The connector side"): path safety on each system, the
 * mirror engine against a fake hub (first run, following, rename, delete, local edits, scope change, revoke, caps, the trash),
 * and the commands. Plain node:test; no network.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, symlinkSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { relRefusal, collisions, collisionKey, safeTarget, folderRefusal, fsPath } from './connector/syncpath.mjs';
import { addSync, findSync, listSyncs, loadManifest } from './connector/syncstore.mjs';
import { createEngine, TRASH, FILE_MAX } from './connector/syncengine.mjs';
import { syncAdd, syncList, syncSet, syncRemove, authFor, CODE_RE } from './connector/syncops.mjs';
import { putHub, readKeyFile } from './connector/keyfile.mjs';
import { createSyncHost } from './connector/syncrunner.mjs';

const tmp = [];
const mk = (p = 'conclave-vsync-') => { const d = mkdtempSync(join(tmpdir(), p)); tmp.push(d); return d; };
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
const sha = (b) => createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── path safety ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('path rules', () => {
  test('every system refuses an escape, an absolute path, an empty part, a control character and a backslash', () => {
    for (const os of ['win32', 'linux', 'darwin']) {
      for (const bad of ['../x.md', 'a/../../x.md', '/etc/passwd', 'a//b.md', 'a/./b.md', '', 'a\\b.md', 'a/b\u0000.md', 'C:/x.md']) assert.ok(relRefusal(bad, os), `${os}: ${JSON.stringify(bad)}`);
      assert.equal(relRefusal('Notes/Plan 2026.md', os), null);
      assert.ok(relRefusal('a/' + 'x'.repeat(256) + '.md', os));
    }
  });
  test('nothing is written into .git, .obsidian, the trash or the sync bookkeeping, at any depth, in any case', () => {
    for (const os of ['win32', 'linux', 'darwin']) for (const bad of ['.git/config', 'a/.GIT/x', '.obsidian/app.json', 'n/.Obsidian/x', '.conclave-trash/x', '.conclave-sync/x']) assert.ok(relRefusal(bad, os), `${os} ${bad}`);
  });
  test('Windows refuses its forbidden characters, trailing dots and spaces, and reserved names with any extension', () => {
    for (const bad of ['a:b.md', 'a*.md', 'a?.md', 'a"b.md', 'a<b.md', 'a>b.md', 'a|b.md', 'name.', 'name ', 'dir./x.md', 'CON', 'con.txt', 'Dir/NUL.md', 'aux.tar.gz', 'COM1.md', 'lpt9', 'COM¹.md', 'conin$', 'CONOUT$.x']) assert.ok(relRefusal(bad, 'win32'), bad);
    for (const ok of ['console.md', 'com10.md', 'nul2.md', 'a b.md', 'x/y.z.md']) assert.equal(relRefusal(ok, 'win32'), null, ok);
  });
  test('Windows 8.3 short names are refused, so GIT~1 cannot reach .git', () => {
    for (const bad of ['GIT~1/hooks/pre-commit', 'git~1', 'OBSIDI~1/app.json', 'CONCLA~1/x', 'CONCLA~2/x', 'a/PROGRA~1.TXT']) assert.ok(relRefusal(bad, 'win32'), bad);
    for (const os of ['linux', 'darwin']) assert.equal(relRefusal('GIT~1/x', os), null, os);
    assert.equal(relRefusal('notes/a~b.md', 'win32'), null);
  });
  test('Linux and macOS allow what Windows does not, except what is unsafe everywhere', () => {
    for (const os of ['linux', 'darwin']) for (const ok of ['ab:c.md', 'a*.md', 'CON.txt', 'name.', 'a|b']) assert.equal(relRefusal(ok, os), null, `${os} ${ok}`);
  });
  test('names that are the same file collide: by case on Windows and macOS, by Unicode form on every system', () => {
    const nfc = 'caf\u00e9.md', nfd = 'cafe\u0301.md';
    assert.equal(collisions(['Notes/A.md', 'notes/a.md'], 'win32').size, 1);
    assert.equal(collisions(['Notes/A.md', 'notes/a.md'], 'darwin').size, 1);
    assert.equal(collisions(['Notes/A.md', 'notes/a.md'], 'linux').size, 0);
    for (const os of ['win32', 'darwin', 'linux']) assert.equal(collisions([nfc, nfd], os).size, 1, os);
    assert.equal(collisionKey(nfd, 'linux'), nfc);
    assert.equal(collisions(['a.md', 'b.md'], 'win32').size, 0);
  });
  test('a long Windows path takes the \\\\?\\ form', () => {
    assert.equal(fsPath('C:\\a\\b', 'win32'), 'C:\\a\\b');
    const long = 'C:\\' + 'x'.repeat(250);
    assert.equal(fsPath(long, 'win32'), `\\\\?\\${long}`);
    assert.equal(fsPath('\\\\srv\\share\\' + 'y'.repeat(240), 'win32').startsWith('\\\\?\\UNC\\'), true);
    assert.equal(fsPath(long, 'linux'), long);
  });
  test('a target is never reached through a link, and never outside the folder', async () => {
    const root = mk(), out = mk('conclave-vsync-out-');
    mkdirSync(join(root, 'real'));
    let linked = true;
    try { symlinkSync(out, join(root, 'ln'), process.platform === 'win32' ? 'junction' : 'dir'); } catch { linked = false; }
    assert.equal((await safeTarget(root, 'real/x.md')).ok, true);
    assert.equal((await safeTarget(root, 'new/dir/x.md')).ok, true);
    assert.equal((await safeTarget(root, '../x.md')).ok, false);
    if (linked) { const r = await safeTarget(root, 'ln/x.md'); assert.equal(r.ok, false); assert.match(r.reason, /link/); }
    writeFileSync(join(root, 'file'), 'x');
    assert.equal((await safeTarget(root, 'file/x.md')).ok, false);
    mkdirSync(join(root, 'dirasfile'));
    assert.equal((await safeTarget(root, 'dirasfile')).ok, false);
  });
  test('a sync folder may not overlap the connector, an agent, another sync, a drive root or a .git folder', () => {
    const base = mk(), home = join(base, 'home'), agent = join(base, 'agent'), other = join(base, 'other'), free = join(base, 'free');
    for (const d of [home, agent, other, free, join(base, '.git', 'x')]) mkdirSync(d, { recursive: true });
    const others = [{ path: home, what: 'the connector' }, { path: agent, what: 'an agent' }, { path: other, what: 'a sync' }];
    assert.equal(folderRefusal(free, others), null);
    for (const f of [home, agent, other, join(home, 'sub'), base, join(base, '.git', 'x')]) { if (!existsSync(f)) mkdirSync(f, { recursive: true }); assert.ok(folderRefusal(f, others), f); }
    assert.ok(folderRefusal('relative/dir', others));
    assert.ok(folderRefusal(join(base, 'does-not-exist'), others));
  });
});

// ── a fake hub ──────────────────────────────────────────────────────────────────────────────────────────────────
function fakeHub() {
  const h = { files: new Map(), seq: 0, log: [], scope: 1, visible: () => true, revoked: false, hubPaused: false, runs: [], downloads: 0, corrupt: new Set(), failDownload: new Set(), calls: [] };
  const rev = (b) => `sha256:${sha(b)}`;
  h.put = (p, text) => { const b = Buffer.isBuffer(text) ? text : Buffer.from(text); h.files.set(p, b); h.log.push({ seq: ++h.seq, kind: 'put', path: p, revision: rev(b), size: b.length }); };
  h.del = (p) => { h.files.delete(p); h.log.push({ seq: ++h.seq, kind: 'delete', path: p }); };
  h.rename = (a, b) => { const c = h.files.get(a); h.files.delete(a); h.files.set(b, c); h.log.push({ seq: ++h.seq, kind: 'rename', path: b, from: a, revision: rev(c) }); };
  h.setScope = (fn) => { h.visible = fn; h.scope++; };
  const cur = () => `c.${h.scope}.${h.seq}`;
  const vis = () => [...h.files.keys()].filter((p) => h.visible(p)).sort();
  const url = (p) => new URL(p, 'https://hub.test');
  h.api = {
    async json(method, p, body) {
      h.calls.push(`${method} ${p.split('?')[0]}`);
      if (h.revoked) return { status: 401, json: { error: 'unauthorized' } };
      if (h.hubPaused) return { status: 403, json: { error: 'paused' } };
      const u = url(p);
      if (u.pathname === '/vault-sync/v1/files') {
        const after = u.searchParams.get('after') ?? '', limit = Number(u.searchParams.get('limit') ?? 200);
        const all = vis().filter((x) => x > after), page = all.slice(0, limit);
        return { status: 200, json: { files: page.map((x) => ({ path: x, revision: rev(h.files.get(x)), size: h.files.get(x).length })), next: all.length > limit ? page.at(-1) : null, ...(after === '' ? { cursor: cur() } : {}) } };
      }
      if (u.pathname === '/vault-sync/v1/changes') {
        const m = /^c\.(\d+)\.(\d+)$/.exec(u.searchParams.get('cursor') ?? '');
        if (!m || Number(m[1]) !== h.scope) return { status: 200, json: { changes: [], cursor: cur(), more: false, reset: true } };
        const entries = h.log.filter((c) => c.seq > Number(m[2])).map((c) => {
          if (c.kind === 'rename') { const a = h.visible(c.from), b = h.visible(c.path); return a && b ? c : a ? { kind: 'delete', path: c.from } : b ? { kind: 'put', path: c.path, revision: c.revision, size: h.files.get(c.path)?.length } : null; }
          return h.visible(c.path) ? c : null;
        }).filter(Boolean);
        return { status: 200, json: { changes: entries, cursor: cur(), more: false, reset: false } };
      }
      if (u.pathname === '/vault-sync/v1/runs') { h.runs.push(body); return { status: 200, json: { ok: true } }; }
      return { status: 404, json: null };
    },
    async download(p, dest) {
      h.calls.push(`GET ${p.split('?')[0]}`);
      if (h.revoked) return { status: 401 };
      const u = url(p), rel = u.searchParams.get('path');
      if (!h.files.has(rel) || !h.visible(rel)) return { status: h.files.has(rel) ? 403 : 404 };
      if (h.failDownload.has(rel)) throw Object.assign(new Error('the transfer was cut'), { reason: 'hub_unreachable' });
      h.downloads++;
      let b = h.files.get(rel);
      if (h.corrupt.has(rel)) b = Buffer.from('tampered');
      writeFileSync(dest, b);
      return { status: 200, revision: rev(h.files.get(rel)), sha256: sha(b), bytes: b.length };
    },
  };
  return h;
}

function setup(over = {}) {
  const home = mk('conclave-vsync-home-'), folder = mk('conclave-vsync-mirror-');
  addSync(home, { id: 's1', name: 'mirror', hub_id: 'hub-a', ca_sha256: 'a'.repeat(64), folder, label: 'vsync-s1', reader_id: 'r1', ...over });
  const h = fakeHub();
  let clock = Date.now();
  const engine = () => createEngine({ home, rec: findSync(home, 's1'), api: h.api, now: () => new Date(clock) });
  return { home, folder, h, run: (o) => engine().runOnce(o), at: (ms) => { clock += ms; }, advance: (days) => { clock += days * 86_400_000; }, rec: () => findSync(home, 's1'), read: (p) => readFileSync(join(folder, p), 'utf8') };
}
const trashFiles = (folder) => {
  const out = [], walk = (d, pre = '') => { for (const e of readdirSync(d, { withFileTypes: true })) { if (e.name === '.tmp') continue; e.isDirectory() ? walk(join(d, e.name), `${pre}${e.name}/`) : out.push(`${pre}${e.name}`); } };
  if (existsSync(join(folder, TRASH))) walk(join(folder, TRASH));
  return out;
};

// ── the engine ──────────────────────────────────────────────────────────────────────────────────────────────────
describe('first run', () => {
  test('a full listing, a download of each file, the cursor kept, one run reported', async () => {
    const t = setup();
    t.h.put('Notes/A/one.md', 'one'); t.h.put('Notes/B.md', 'bee'); t.h.put('top.md', 'top');
    const r = await t.run();
    assert.equal(r.full, true); assert.equal(r.files, 3);
    assert.equal(t.read('Notes/A/one.md'), 'one'); assert.equal(t.read('top.md'), 'top');
    assert.ok(t.rec().cursor); assert.equal(t.rec().files, 3);
    assert.deepEqual(t.h.runs, [{ files: 3, bytes: 9, version: 1 }]);
    assert.equal(loadManifest(t.home, 's1').files['top.md'].rev, `sha256:${sha('top')}`);
  });
  test('what already matches by hash is not downloaded again, and files that exist only locally are left alone', async () => {
    const t = setup();
    t.h.put('same.md', 'same'); t.h.put('new.md', 'new');
    writeFileSync(join(t.folder, 'same.md'), 'same'); writeFileSync(join(t.folder, 'mine-only.md'), 'private');
    await t.run();
    assert.equal(t.h.downloads, 1);
    assert.equal(t.read('mine-only.md'), 'private');
    assert.deepEqual(trashFiles(t.folder), []);
  });
  test('a file whose content differs and is not in the manifest is a local edit: kept in the trash, then replaced', async () => {
    const t = setup();
    t.h.put('doc.md', 'hub version');
    writeFileSync(join(t.folder, 'doc.md'), 'my version');
    const r = await t.run();
    assert.equal(r.kept, 1); assert.equal(t.read('doc.md'), 'hub version');
    const tf = trashFiles(t.folder);
    assert.equal(tf.length, 1); assert.match(tf[0], /doc \(local \d{4}-\d{2}-\d{2} \d{4}\)\.md$/);
    assert.equal(readFileSync(join(t.folder, TRASH, tf[0]), 'utf8'), 'my version');
  });
  test('more than one page of files, and 1,000 of them', async () => {
    const t = setup();
    for (let i = 0; i < 1000; i++) t.h.put(`bulk/f${String(i).padStart(4, '0')}.md`, `file ${i}`);
    const r = await t.run();
    assert.equal(r.files, 1000); assert.equal(t.rec().files, 1000);
    assert.equal(t.read('bulk/f0999.md'), 'file 999');
    assert.equal((await t.run()).files, 0); // nothing to do the second time
    assert.equal(t.h.downloads, 1000);
  });
});

describe('following the hub', () => {
  test('a put, a delete and a rename arrive as changes; a delete goes to the trash; a rename is a local rename', async () => {
    const t = setup();
    t.h.put('a.md', 'a1'); t.h.put('b.md', 'b1'); t.h.put('c.md', 'c1');
    await t.run();
    t.h.put('a.md', 'a2'); t.h.del('b.md'); t.h.rename('c.md', 'sub/c-renamed.md');
    const dl = t.h.downloads;
    const r = await t.run();
    assert.equal(r.full, false);
    assert.equal(t.read('a.md'), 'a2');
    assert.equal(existsSync(join(t.folder, 'b.md')), false);
    const tf = trashFiles(t.folder);
    assert.equal(tf.length, 1); assert.match(tf[0], /^\d{4}-\d{2}-\d{2}\/b\.md$/);
    assert.equal(readFileSync(join(t.folder, TRASH, tf[0]), 'utf8'), 'b1');
    assert.equal(existsSync(join(t.folder, 'c.md')), false); assert.equal(t.read('sub/c-renamed.md'), 'c1');
    assert.equal(t.h.downloads, dl + 1); // only a.md: the rename moved the bytes already here
    assert.equal(r.renamed, 1);
  });
  test('a local edit is kept in the trash when the hub version changes, and the mirror then matches the hub', async () => {
    const t = setup();
    t.h.put('n.md', 'v1');
    await t.run();
    writeFileSync(join(t.folder, 'n.md'), 'my local words');
    t.h.put('n.md', 'v2');
    await t.run();
    assert.equal(t.read('n.md'), 'v2');
    const tf = trashFiles(t.folder);
    assert.equal(tf.length, 1);
    assert.equal(readFileSync(join(t.folder, TRASH, tf[0]), 'utf8'), 'my local words');
  });
  test('an unedited old version is replaced with nothing kept, and a list warns about a local edit before it happens', async () => {
    const t = setup();
    t.h.put('n.md', 'v1');
    await t.run();
    t.h.put('n.md', 'v2'); await t.run();
    assert.deepEqual(trashFiles(t.folder), []);
    writeFileSync(join(t.folder, 'n.md'), 'edited!');
    const future = new Date(Date.now() + 5000); utimesSync(join(t.folder, 'n.md'), future, future);
    assert.equal(await createEngine({ home: t.home, rec: t.rec(), api: null }).countLocalEdits(), 1);
    assert.equal((await syncList(t.home))[0].local_edits, 1);
  });
  test('a file created locally in the mirror folder is counted and warned about by sync list, and left alone (never uploaded, never moved)', async () => {
    const t = setup();
    t.h.put('n.md', 'v1');
    await t.run();
    assert.equal((await syncList(t.home))[0].local_new, 0);
    mkdirSync(join(t.folder, 'mine'), { recursive: true });
    writeFileSync(join(t.folder, 'mine', 'draft.md'), 'only here');
    writeFileSync(join(t.folder, 'scratch.txt'), 'only here too');
    assert.equal(await createEngine({ home: t.home, rec: t.rec(), api: null }).countLocalNew(), 2, 'the mirror\'s own n.md and the trash are not counted');
    const row = (await syncList(t.home))[0];
    assert.equal(row.local_new, 2);
    t.h.put('n.md', 'v2');
    await t.run();
    assert.equal(t.read('mine/draft.md'), 'only here', 'a run leaves it alone');
    assert.equal(trashFiles(t.folder).length, 0);
    assert.equal((await syncList(t.home))[0].local_new, 2);
  });
  test('a file the reader may no longer see after a scope edit is a delete in the trash, never a moved path', async () => {
    const t = setup();
    t.h.put('Open/a.md', 'a'); t.h.put('Secret/b.md', 'b'); t.h.put('Open/c.md', 'c');
    await t.run();
    t.h.setScope((p) => p.startsWith('Open/'));
    const r = await t.run();
    assert.equal(r.full, true);
    assert.equal(existsSync(join(t.folder, 'Secret')), false);
    assert.equal(t.read('Open/a.md'), 'a');
    const tf = trashFiles(t.folder);
    assert.equal(tf.length, 1); assert.match(tf[0], /Secret\/b\.md$/);
    assert.deepEqual(Object.keys(loadManifest(t.home, 's1').files).sort(), ['Open/a.md', 'Open/c.md']);
    // and a scope that grows lists again and takes the new files
    t.h.setScope(() => true);
    await t.run();
    assert.equal(t.read('Secret/b.md'), 'b');
  });
  test('a rename across the edge of the scope is a delete or a put, never a rename', async () => {
    const t = setup();
    t.h.put('Open/a.md', 'a'); t.h.put('Hidden/x.md', 'x');
    t.h.setScope((p) => !p.startsWith('Hidden/'));
    await t.run();
    t.h.rename('Open/a.md', 'Hidden/a.md');
    await t.run();
    assert.equal(existsSync(join(t.folder, 'Open/a.md')), false);
    assert.equal(existsSync(join(t.folder, 'Hidden')), false);
    assert.equal(trashFiles(t.folder).length, 1);
    t.h.rename('Hidden/a.md', 'Open/back.md');
    await t.run();
    assert.equal(t.read('Open/back.md'), 'a');
  });
  test('the daily re-check lists everything again, and finds a file removed behind the mirror\'s back', async () => {
    const t = setup();
    t.h.put('a.md', 'a');
    await t.run();
    rmSync(join(t.folder, 'a.md'));
    assert.equal((await t.run()).full, false);
    assert.equal(existsSync(join(t.folder, 'a.md')), false);
    t.advance(1.1);
    const r = await t.run();
    assert.equal(r.full, true); assert.equal(t.read('a.md'), 'a');
  });
  test('a failed download is not skipped over: the cursor stays and the next run lists again', async () => {
    const t = setup();
    t.h.put('a.md', 'a');
    await t.run();
    const cursor = t.rec().cursor;
    t.h.put('b.md', 'b'); t.h.failDownload.add('b.md');
    const r = await t.run();
    assert.ok(r.errors.length || r.failed || r.full);
    assert.equal(existsSync(join(t.folder, 'b.md')), false);
    assert.notEqual(t.rec().last_error, null);
    t.h.failDownload.clear();
    await t.run();
    assert.equal(t.read('b.md'), 'b');
    assert.ok(cursor);
  });
});

describe('what is refused', () => {
  test('a hub path that would land outside the folder, a reserved or forbidden name: refused, reported, nothing written', async () => {
    const t = setup();
    const os = 'win32';
    const mkWin = () => createEngine({ home: t.home, rec: t.rec(), api: t.h.api, os });
    t.h.put('../escape.md', 'bad'); t.h.put('a/../../escape2.md', 'bad'); t.h.put('CON.txt', 'bad'); t.h.put('ok.md', 'ok'); t.h.put('.git/config', 'bad'); t.h.put('x:y.md', 'bad');
    const r = await mkWin().runOnce();
    assert.equal(r.refused, 5);
    assert.equal(t.read('ok.md'), 'ok');
    assert.equal(existsSync(join(t.folder, '..', 'escape.md')), false);
    assert.equal(existsSync(join(t.folder, '.git')), false);
    assert.deepEqual(readdirSync(t.folder).filter((n) => n !== TRASH), ['ok.md']);
    assert.ok(t.rec().refused.some((x) => x.path === 'CON.txt'));
    assert.ok(t.rec().warnings.length);
  });
  test('two names that collide: both are reported and neither is written', async () => {
    const t = setup();
    t.h.put('Notes/Plan.md', 'p1'); t.h.put('notes/plan.md', 'p2'); t.h.put('fine.md', 'f');
    const r = await createEngine({ home: t.home, rec: t.rec(), api: t.h.api, os: 'win32' }).runOnce();
    assert.equal(r.refused, 2);
    assert.equal(existsSync(join(t.folder, 'Notes')), false); assert.equal(existsSync(join(t.folder, 'notes')), false);
    assert.equal(t.read('fine.md'), 'f');
  });
  test('a collision that arrives later keeps the file already there and refuses the newcomer', async () => {
    const t = setup();
    t.h.put('Notes/Plan.md', 'p1');
    const mkWin = () => createEngine({ home: t.home, rec: t.rec(), api: t.h.api, os: 'win32' });
    await mkWin().runOnce();
    t.h.put('notes/plan.md', 'p2');
    const r = await mkWin().runOnce();
    assert.equal(r.refused, 1);
    assert.equal(t.read('Notes/Plan.md'), 'p1');
  });
  test('a link in the mirror is never written through', async (ctx) => {
    const t = setup(), out = mk('conclave-vsync-out-');
    try { symlinkSync(out, join(t.folder, 'Linked'), process.platform === 'win32' ? 'junction' : 'dir'); } catch { return ctx.skip('links cannot be made here'); }
    t.h.put('Linked/x.md', 'x'); t.h.put('ok.md', 'ok');
    const r = await t.run();
    assert.equal(r.refused, 1);
    assert.deepEqual(readdirSync(out), []);
  });
  test('a file that arrives with the wrong content hash is not written', async () => {
    const t = setup();
    t.h.put('a.md', 'real'); t.h.corrupt.add('a.md');
    const r = await t.run();
    assert.equal(existsSync(join(t.folder, 'a.md')), false);
    assert.ok(r.errors.length);
    assert.deepEqual(readdirSync(join(t.folder, TRASH, '.tmp')), []);
  });
  test('a file over the size limit is skipped and reported', async () => {
    const t = setup();
    t.h.put('ok.md', 'ok');
    t.h.files.set('big.bin', Buffer.alloc(8)); t.h.log.push({ seq: ++t.h.seq, kind: 'put', path: 'big.bin', revision: 'x', size: FILE_MAX + 1 });
    const orig = t.h.api.json;
    t.h.api.json = async (m, p, b) => { const r = await orig(m, p, b); if (r.json?.files) r.json.files = r.json.files.map((f) => (f.path === 'big.bin' ? { ...f, size: FILE_MAX + 1 } : f)); return r; };
    const r = await t.run();
    assert.equal(r.refused, 1); assert.equal(existsSync(join(t.folder, 'big.bin')), false); assert.equal(t.read('ok.md'), 'ok');
  });
  test('the size cap of a sync stops taking files and says so', async () => {
    const t = setup({ cap_bytes: 25 });
    t.h.put('a.md', 'x'.repeat(10)); t.h.put('b.md', 'y'.repeat(10)); t.h.put('c.md', 'z'.repeat(10));
    const r = await t.run();
    assert.equal(r.capped, true);
    assert.equal(r.files, 2);
    assert.ok(t.rec().warnings.some((w) => /size cap/.test(w)));
  });
});

describe('after a revoke, a pause, and the trash', () => {
  test('a 401 stops the sync with a clear message and the files stay', async () => {
    const t = setup();
    t.h.put('a.md', 'a');
    await t.run();
    t.h.revoked = true;
    const r = await t.run();
    assert.equal(r.revoked, true);
    assert.equal(t.rec().state, 'revoked'); assert.match(t.rec().last_error, /still on disk/);
    assert.equal(t.read('a.md'), 'a');
    t.h.revoked = false;
    assert.equal((await t.run()).skipped, 'revoked'); // a revoked sync does nothing more
    assert.deepEqual(syncSet(t.home, 'mirror', 'active').ok, false);
  });
  test('a paused sync does nothing, and one paused on the hub says so without stopping', async () => {
    const t = setup();
    t.h.put('a.md', 'a');
    syncSet(t.home, 'mirror', 'paused');
    assert.equal((await t.run()).skipped, 'paused'); assert.equal(existsSync(join(t.folder, 'a.md')), false);
    syncSet(t.home, 'mirror', 'active');
    t.h.hubPaused = true;
    const r = await t.run();
    assert.equal(r.hubPaused, true); assert.equal(t.rec().state, 'active'); assert.match(t.rec().last_error, /paused on the hub/);
  });
  test('trash older than 30 days is emptied; the trash is held to the size cap, oldest day first', async () => {
    const t = setup({ cap_bytes: 30 });
    const old = join(t.folder, TRASH, '2020-01-01'), d1 = join(t.folder, TRASH, '2026-11-01'), d2 = join(t.folder, TRASH, '2026-11-10');
    for (const d of [old, d1, d2]) mkdirSync(d, { recursive: true });
    writeFileSync(join(old, 'x.md'), 'o'); writeFileSync(join(d1, 'y.md'), 'y'.repeat(20)); writeFileSync(join(d2, 'z.md'), 'z'.repeat(20));
    t.at(0);
    await createEngine({ home: t.home, rec: t.rec(), api: t.h.api, now: () => new Date(2026, 10, 12) }).pruneTrash();
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(d1), false); assert.equal(existsSync(d2), true);
  });
  test('a trash folder that is a link is never used: the file stays where it is', async (ctx) => {
    const t = setup(), out = mk('conclave-vsync-out-');
    t.h.put('a.md', 'a');
    await t.run();
    try { symlinkSync(out, join(t.folder, TRASH), process.platform === 'win32' ? 'junction' : 'dir'); } catch { return ctx.skip('links cannot be made here'); }
    t.h.del('a.md');
    await t.run();
    assert.deepEqual(readdirSync(out), []);
    assert.equal(t.read('a.md'), 'a');
  });
});

// ── the commands ────────────────────────────────────────────────────────────────────────────────────────────────
const CA = `-----BEGIN CERTIFICATE-----
MIIBizCCATGgAwIBAgIUIgN82KjBUADrcJUa+haq0a2q2x8wCgYIKoZIzj0EAwIw
GjEYMBYGA1UEAwwPdmF1bHQtc3luYy10ZXN0MCAXDTI2MTEyMTAwMzQxMloYDzIx
MjYxMDI4MDAzNDEyWjAaMRgwFgYDVQQDDA92YXVsdC1zeW5jLXRlc3QwWTATBgcq
hkjOPQIBBggqhkjOPQMBBwNCAAQn0/VE/eBn2EOn9sKMzP14QqR8/XFc5Jazj6Iz
kY0YsPMun1rsn7cR2q6MXFCmp8cDGK01MRCnlMHELFJC480Xo1MwUTAdBgNVHQ4E
FgQUapW7zbzRHZPFP4O1wzQ89EAoBXgwHwYDVR0jBBgwFoAUapW7zbzRHZPFP4O1
wzQ89EAoBXgwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNIADBFAiBgHrGS
mWL+BAkuUeYoXtX1zCPPSF4y4o4Vl70Rqpbb2gIhAPugTKoiOEMSt+lUul5T4rCq
p6+4sSmuHa6lEcAQBeIL
-----END CERTIFICATE-----
`;
const GOOD = 'cnv_vsync_' + 'abcdefghijklmnopqrstuvwxyz'.slice(0, 26).replace(/[a-z]/g, (c) => 'abcdefghijklmnopqrstuvwxyz234567'[c.charCodeAt(0) - 97]);

function pairedHome() {
  const home = mk('conclave-vsync-cmd-'), saved = process.env.CONCLAVE_HOME;
  putHub(home, { hubId: 'hub-a', origin: 'https://hub.test:8443', caPem: CA, appKey: 'cnv_app_key' });
  void saved;
  return home;
}
const pairApi = (calls, over = {}) => () => ({
  async json(method, p, body) {
    calls.push({ method, p, body });
    if (p === '/vault-sync/v1/pair') return over.pair ?? { status: 200, json: { key: 'cnv_sess_SECRETKEY', reader: { id: 'rdr1', name: 'Mirror' }, version: 1 } };
    if (p === '/vault-sync/v1/pair/confirm') return over.confirm ?? { status: 200, json: { ok: true } };
    return { status: 404, json: null };
  },
});

describe('conclave sync commands', () => {
  test('the code has a fixed shape', () => {
    assert.ok(CODE_RE.test(GOOD), GOOD);
    for (const bad of ['', 'cnc-pair-' + 'a'.repeat(26), 'cnv_vsync_short', 'cnv_vsync_' + 'A'.repeat(26)]) assert.equal(CODE_RE.test(bad), false);
  });
  test('add redeems the code, keeps the key in the key file under vsync-<id>, confirms, and records the sync', async () => {
    const home = pairedHome(), folder = join(mk(), 'mirror'), calls = [];
    const r = await syncAdd(home, { hub: 'hub-a', folder, name: 'Notes', code: GOOD }, { makeApiFn: pairApi(calls), sleep: async () => {} });
    assert.equal(r.ok, true, r.reason); assert.equal(r.confirmed, true);
    assert.deepEqual(calls.map((c) => c.p), ['/vault-sync/v1/pair', '/vault-sync/v1/pair/confirm']);
    assert.equal(calls[0].body.code, GOOD); assert.equal(calls[0].body.version, 1); assert.equal(calls[0].body.nonce, calls[1].body.nonce);
    const rec = findSync(home, 'notes');
    assert.equal(rec.reader_id, 'rdr1'); assert.equal(rec.state, 'active'); assert.ok(existsSync(rec.folder));
    const kf = readKeyFile(home);
    assert.equal(kf.data.hubs[Object.keys(kf.data.hubs)[0]].agents[`vsync-${rec.id}`].session_key, 'cnv_sess_SECRETKEY');
    assert.equal(authFor(home, rec), 'Bearer cnv_sess_SECRETKEY');
    assert.doesNotMatch(JSON.stringify(await syncList(home)), /SECRETKEY/);
    assert.doesNotMatch(readFileSync(join(home, 'syncs.json'), 'utf8'), /SECRETKEY/);
  });
  test('add by origin works, and a hub the PC is not paired with is refused', async () => {
    const home = pairedHome();
    assert.equal((await syncAdd(home, { hub: 'https://hub.test:8443', folder: join(mk(), 'm'), code: GOOD }, { makeApiFn: pairApi([]), sleep: async () => {} })).ok, true);
    const r = await syncAdd(home, { hub: 'other-hub', folder: join(mk(), 'm2'), code: GOOD }, { makeApiFn: pairApi([]) });
    assert.equal(r.ok, false); assert.match(r.reason, /not paired/);
  });
  test('a bad or used code is refused in plain words and stores nothing', async () => {
    const home = pairedHome();
    assert.match((await syncAdd(home, { hub: 'hub-a', folder: join(mk(), 'm'), code: 'nonsense' })).reason, /pairing code/);
    const r = await syncAdd(home, { hub: 'hub-a', folder: join(mk(), 'm'), code: GOOD }, { makeApiFn: pairApi([], { pair: { status: 401, json: { error: 'unauthorized' } } }) });
    assert.equal(r.ok, false); assert.match(r.reason, /not valid|already used/);
    assert.equal(listSyncs(home).length, 0);
    const kf = readKeyFile(home); assert.deepEqual(Object.keys(kf.data.hubs[Object.keys(kf.data.hubs)[0]].agents), []);
  });
  test('a folder that overlaps the connector, an agent, or another sync is refused, and so is a name taken', async () => {
    const home = pairedHome(), base = mk(), f1 = join(base, 'one');
    assert.equal((await syncAdd(home, { hub: 'hub-a', folder: f1, name: 'one', code: GOOD }, { makeApiFn: pairApi([]), sleep: async () => {} })).ok, true);
    const inside = await syncAdd(home, { hub: 'hub-a', folder: join(f1, 'inner'), name: 'two', code: GOOD }, { makeApiFn: pairApi([]) });
    assert.equal(inside.ok, false); assert.match(inside.reason, /overlaps/);
    const holder = await syncAdd(home, { hub: 'hub-a', folder: base, name: 'three', code: GOOD }, { makeApiFn: pairApi([]) });
    assert.equal(holder.ok, false); assert.match(holder.reason, /overlaps/);
    const onHome = await syncAdd(home, { hub: 'hub-a', folder: join(home, 'x'), name: 'four', code: GOOD }, { makeApiFn: pairApi([]) });
    assert.equal(onHome.ok, false);
    const dup = await syncAdd(home, { hub: 'hub-a', folder: join(base, 'other'), name: 'ONE', code: GOOD }, { makeApiFn: pairApi([]) });
    assert.equal(dup.ok, false); assert.match(dup.reason, /already exists/);
  });
  test('pause and resume change the state; remove forgets the sync and its key but keeps the folder and the trash', async () => {
    const home = pairedHome(), folder = join(mk(), 'm');
    await syncAdd(home, { hub: 'hub-a', folder, name: 'm', code: GOOD }, { makeApiFn: pairApi([]), sleep: async () => {} });
    assert.equal(syncSet(home, 'm', 'paused').state, 'paused'); assert.equal(syncSet(home, 'M', 'active').state, 'active');
    assert.equal(syncSet(home, 'nope', 'paused').ok, false);
    mkdirSync(join(folder, TRASH), { recursive: true }); writeFileSync(join(folder, 'keep.md'), 'k');
    const rec = findSync(home, 'm');
    const r = syncRemove(home, 'm');
    assert.equal(r.ok, true); assert.equal(listSyncs(home).length, 0);
    assert.ok(existsSync(join(folder, 'keep.md'))); assert.ok(existsSync(join(folder, TRASH)));
    const kf = readKeyFile(home); assert.equal(kf.data.hubs[Object.keys(kf.data.hubs)[0]].agents[rec.label], undefined);
    assert.equal(syncRemove(home, 'm').ok, false);
  });
});

// ── the service's loop ──────────────────────────────────────────────────────────────────────────────────────────
describe('the service loop', () => {
  test('a loop starts for each sync of a hub, runs at once, runs again on a hint, and stops for a revoked reader', async () => {
    const home = pairedHome(), folder = join(mk(), 'm'), h = fakeHub();
    await syncAdd(home, { hub: 'hub-a', folder, name: 'm', code: GOOD }, { makeApiFn: pairApi([]), sleep: async () => {} });
    h.put('a.md', 'a1');
    const kf = readKeyFile(home), section = Object.values(kf.data.hubs)[0];
    const logs = [];
    const host = createSyncHost({ home, log: (m) => logs.push(m), pollMs: 60_000, makeApiFn: () => h.api });
    const ac = new AbortController();
    host.ensure(section, {}, ac.signal);
    host.ensure(section, {}, ac.signal); // a second check-in starts nothing new
    assert.equal(host.running().length, 1);
    const until = async (ok, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms && !ok()) await sleep(10); return ok(); };
    assert.ok(await until(() => existsSync(join(findSync(home, 'm').folder, 'a.md'))));
    h.put('a.md', 'a2');
    host.hint('rdr1'); // within a few milliseconds, not the 60 s timer
    assert.ok(await until(() => readFileSync(join(findSync(home, 'm').folder, 'a.md'), 'utf8') === 'a2'));
    h.put('a.md', 'a3');
    h.revoked = true;
    host.hint('rdr1');
    assert.ok(await until(() => host.running().length === 0));
    assert.equal(findSync(home, 'm').state, 'revoked');
    assert.equal(readFileSync(join(findSync(home, 'm').folder, 'a.md'), 'utf8'), 'a2');
    host.stop(); ac.abort();
  });
  test('a hint that arrives during a run is not lost', async () => {
    const home = pairedHome(), folder = join(mk(), 'm'), h = fakeHub();
    await syncAdd(home, { hub: 'hub-a', folder, name: 'm', code: GOOD }, { makeApiFn: pairApi([]), sleep: async () => {} });
    h.put('a.md', 'a1');
    const slow = { ...h.api, async download(p, d) { await sleep(60); return h.api.download(p, d); } };
    const section = Object.values(readKeyFile(home).data.hubs)[0];
    const host = createSyncHost({ home, pollMs: 60_000, makeApiFn: () => slow });
    host.ensure(section, {});
    await sleep(10);
    h.put('b.md', 'b1'); host.hint('rdr1'); // while the first run is downloading
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && !existsSync(join(findSync(home, 'm').folder, 'b.md'))) await sleep(10);
    assert.equal(readFileSync(join(findSync(home, 'm').folder, 'b.md'), 'utf8'), 'b1');
    host.stop();
  });
});
