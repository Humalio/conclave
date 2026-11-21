// Standard isolation (docs/connector.md, "Isolation levels"): the key file is encrypted at rest and says where its secret lives;
// a platform store that fails falls back to the private file; a key in a transcript is found, a clean one is not; a folder or
// a key pickup waits for the PC user's click and a click is spent once; the local screen lists what waits and says what the
// level protects. Temporary homes, fake keys, no platform store (CONCLAVE_KEY_STORE=file) except where a fake store is injected.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testCa } from '../../server/test/test-ca.mjs';
import { putHub, putAgentKey, readKeyFile, keyFilePath, encryptInPlace } from './connector/keyfile.mjs';
import { storeName, STORE_LINES, forgetMasters, masterPath, io as storeIo, preferredStores } from './connector/keystore.mjs';
import { scanTranscript } from './connector/leak.mjs';
import { pendingList, approveFolder, approvePickup, requestFolder, requestPickup, folderApproved, pickupApproved, spendPickup, approveFolderByConnector, revokeFolder, grandfather, unauditedGrandfathered, markAudited } from './connector/approvals.mjs';
import { bindFolder } from './connector/registry.mjs';
import { wakeEnabled, wakeSettings } from './connector/wake.mjs';
import { startScreen } from './connector/screen.mjs';
import { canonicalFolder, folderIdentity, pathKey } from './connector/paths.mjs';

process.env.CONCLAVE_KEY_STORE = 'file';
const APP = 'ah_app_FAKEappKEYforISOLATIONtests01';
const SES = 'ah_ses_FAKEsessionKEYforISOLATION0001';
const tmp = [];
const mk = () => { const d = mkdtempSync(join(tmpdir(), 'cn-iso-')); tmp.push(d); return d; };
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
const pki = testCa('Isolation CA');
const withKeys = (home) => { const k = putHub(home, { hubId: 'hub-iso', origin: 'https://127.0.0.1:9', caPem: pki.caPem, appKey: APP }); putAgentKey(home, k, 'dev-1', SES); return k; };

describe('the key file is encrypted at rest', () => {
  test('no key is plain text on disk, the file reads back, and the store is named', () => {
    const home = mk();
    const k = withKeys(home);
    const raw = readFileSync(keyFilePath(home), 'utf8');
    assert.ok(!raw.includes(SES) && !raw.includes(APP) && !raw.includes('hub-iso'), 'nothing readable in the file');
    assert.equal(JSON.parse(raw).format, 'conclave-keys-enc');
    assert.equal(storeName(home), 'file');
    assert.ok(STORE_LINES.file && STORE_LINES.dpapi && STORE_LINES.keychain && STORE_LINES.secret_service);
    forgetMasters(); // a new process: the secret is read back from its store
    assert.equal(readKeyFile(home).data.hubs[k].agents['dev-1'].session_key, SES);
  });
  test('a plain key file from an older connector is read, and encrypted in place', () => {
    const home = mk();
    const k = withKeys(home);
    const data = readKeyFile(home).data;
    writeFileSync(keyFilePath(home), JSON.stringify(data) + '\n'); // as the old connector wrote it
    assert.ok(readFileSync(keyFilePath(home), 'utf8').includes(SES));
    assert.equal(readKeyFile(home).data.hubs[k].app_key, APP);
    assert.equal(encryptInPlace(home), true);
    assert.ok(!readFileSync(keyFilePath(home), 'utf8').includes(SES));
    assert.equal(encryptInPlace(home), false, 'already encrypted: nothing to do');
    assert.equal(readKeyFile(home).data.hubs[k].app_key, APP);
  });
  test('a lost or damaged secret is a fixed reason, never a guess, and a changed file is refused', () => {
    const home = mk();
    withKeys(home);
    forgetMasters();
    rmSync(masterPath(home));
    assert.deepEqual(readKeyFile(home), { ok: false, reason: 'keystore_unavailable' });
    const home2 = mk();
    withKeys(home2);
    const f = JSON.parse(readFileSync(keyFilePath(home2), 'utf8'));
    f.data = Buffer.from('tampered').toString('base64');
    writeFileSync(keyFilePath(home2), JSON.stringify(f));
    assert.equal(readKeyFile(home2).ok, false);
  });
  test('a platform store that fails falls back to the private file; one that works is used and named', () => {
    const saved = { ...storeIo }, env = process.env.CONCLAVE_KEY_STORE;
    try {
      delete process.env.CONCLAVE_KEY_STORE;
      assert.deepEqual(preferredStores({ ...process.env }), [process.platform === 'win32' ? 'dpapi' : process.platform === 'darwin' ? 'keychain' : 'secret_service', 'file']);
      // a macOS keychain that works: the secret goes to the "keychain" (here a map), keys.master holds only a reference
      const vault = new Map();
      storeIo.platform = 'darwin';
      storeIo.exec = (cmd, args) => {
        if (cmd !== 'security') return { status: 1, stdout: '', stderr: '' };
        if (args[0] === 'add-generic-password') { vault.set(args[args.indexOf('-s') + 1], args[args.indexOf('-w') + 1]); return { status: 0, stdout: '', stderr: '' }; }
        const v = vault.get(args[args.indexOf('-s') + 1]);
        return v ? { status: 0, stdout: v + '\n', stderr: '' } : { status: 44, stdout: '', stderr: '' };
      };
      const home = mk();
      forgetMasters();
      const k = withKeys(home);
      assert.equal(storeName(home), 'keychain');
      assert.ok(!readFileSync(masterPath(home), 'utf8').includes([...vault.values()][0]), 'the secret is not in keys.master');
      forgetMasters();
      assert.equal(readKeyFile(home).data.hubs[k].app_key, APP);
      // a keychain that refuses: the private file holds the secret, and the check says so
      storeIo.exec = () => ({ status: 1, stdout: '', stderr: 'denied' });
      const home2 = mk();
      forgetMasters();
      withKeys(home2);
      assert.equal(storeName(home2), 'file');
    } finally { Object.assign(storeIo, saved); process.env.CONCLAVE_KEY_STORE = env; forgetMasters(); }
  });
});

describe('the platform stores keep the key file\'s secret, give it back, and fail with a fixed reason', () => {
  const asPlatformStore = (fn) => {
    const saved = { ...storeIo }, env = process.env.CONCLAVE_KEY_STORE, dbus = process.env.DBUS_SESSION_BUS_ADDRESS;
    try { delete process.env.CONCLAVE_KEY_STORE; forgetMasters(); return fn(); }
    finally { Object.assign(storeIo, saved); process.env.CONCLAVE_KEY_STORE = env; if (dbus === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS; else process.env.DBUS_SESSION_BUS_ADDRESS = dbus; forgetMasters(); }
  };
  test('DPAPI (real, on Windows): the secret is protected, not in keys.master, read back by a new process, and a damaged blob is keystore_unavailable', { skip: process.platform === 'win32' ? false : 'DPAPI exists on Windows only' }, () => asPlatformStore(() => {
    const home = mk();
    const k = withKeys(home);
    assert.equal(storeName(home), 'dpapi');
    const rec = JSON.parse(readFileSync(masterPath(home), 'utf8'));
    assert.equal(rec.store, 'dpapi');
    assert.equal(typeof rec.blob, 'string');
    assert.ok(!('secret' in rec), 'the 32-byte secret itself is not on disk');
    forgetMasters(); // a new process
    assert.equal(readKeyFile(home).data.hubs[k].agents['dev-1'].session_key, SES);
    // a later failure of the store: a fixed reason, and no secret in it
    writeFileSync(masterPath(home), JSON.stringify({ ...rec, blob: 'AAAA' }) + '\n');
    forgetMasters();
    assert.deepEqual(readKeyFile(home), { ok: false, reason: 'keystore_unavailable' });
  }));
  test('the Linux secret service (a fake secret-tool): the secret goes in on stdin, keys.master holds only a reference, it reads back, and a failing store is keystore_unavailable', () => asPlatformStore(() => {
    const vault = new Map(), calls = [];
    process.env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/run/fake-bus';
    storeIo.platform = 'linux';
    let broken = false;
    storeIo.exec = (cmd, args, o = {}) => {
      calls.push({ cmd, args, input: o.input });
      if (cmd !== 'secret-tool' || broken) return { status: 1, stdout: '', stderr: 'locked' };
      if (args[0] === '--version') return { status: 0, stdout: 'secret-tool 0.21', stderr: '' };
      const service = args[args.indexOf('service') + 1];
      if (args[0] === 'store') { vault.set(service, o.input); return { status: 0, stdout: '', stderr: '' }; }
      const v = vault.get(service);
      return v ? { status: 0, stdout: v, stderr: '' } : { status: 1, stdout: '', stderr: '' };
    };
    const home = mk();
    const k = withKeys(home);
    assert.equal(storeName(home), 'secret_service');
    const secret = [...vault.values()][0];
    assert.match(secret, /^[0-9a-f]{64}$/);
    assert.ok(!readFileSync(masterPath(home), 'utf8').includes(secret), 'the secret is not in keys.master');
    assert.ok(calls.every((c) => !c.args.some((a) => a.includes(secret))), 'the secret was never a command argument');
    forgetMasters();
    assert.equal(readKeyFile(home).data.hubs[k].agents['dev-1'].session_key, SES);
    broken = true; forgetMasters();
    const r = readKeyFile(home);
    assert.deepEqual(r, { ok: false, reason: 'keystore_unavailable' });
    assert.ok(!JSON.stringify(r).includes(secret));
  }));
});

describe('the leak guard reads a transcript at the end of a turn', () => {
  const write = (text) => { const p = join(mk(), 't.jsonl'); writeFileSync(p, text); return p; };
  test('a clean transcript passes; a key of the agent, or anything shaped like a key, is found; an unreadable file is not a pass', () => {
    assert.deepEqual(scanTranscript(write('{"text":"I read the task and began."}\n'), [SES, APP]), { ok: true, found: false });
    assert.deepEqual(scanTranscript(write(`{"text":"it is ${SES}"}\n`), [SES, APP]), { ok: true, found: true, kind: 'exact' });
    assert.equal(scanTranscript(write('{"text":"ah_ses_abcdefghijkl_abcdefghijklmnop"}\n'), []).found, true);
    assert.equal(scanTranscript(join(mk(), 'missing.jsonl'), [SES]).ok, false);
    assert.equal(scanTranscript(null, [SES]).ok, false);
  });
});

describe('what waits for the PC user\'s click', () => {
  const agentFolder = (home) => { const f = join(home, 'agent'); mkdirSync(f, { recursive: true }); const c = canonicalFolder(f); return { folder: c, binding: { agent: 'dev-1', hub_id: 'hub-iso', identity: folderIdentity(c) } }; };
  test('a folder waits, is allowed by a click, and is allowed only as the same agent on the same folder', () => {
    const home = mk(), { folder, binding } = agentFolder(home);
    assert.equal(folderApproved(home, folder, binding), false);
    requestFolder(home, folder, binding);
    const p = pendingList(home);
    assert.deepEqual(p.folders.map((f) => [f.folder, f.agent]), [[folder, 'dev-1']]);
    assert.equal(approveFolder(home, 'not-a-key'), false, 'only what waits can be allowed');
    assert.equal(approveFolder(home, p.folders[0].key), true);
    assert.equal(pendingList(home).folders.length, 0);
    assert.equal(folderApproved(home, folder, binding), true);
    assert.equal(folderApproved(home, folder, { ...binding, agent: 'someone-else' }), false, 'another agent in the same folder needs its own click');
    assert.equal(folderApproved(home, folder, { ...binding, hub_id: 'other-hub' }), false);
    assert.equal(revokeFolder(home, folder), true);
    assert.equal(folderApproved(home, folder, binding), false);
  });
  test('a folder the connector started itself needs no click', () => {
    const home = mk(), { folder, binding } = agentFolder(home);
    approveFolderByConnector(home, folder, binding);
    assert.equal(folderApproved(home, folder, binding), true);
  });
  test('a key pickup waits for a click, and one click is one pickup', () => {
    const home = mk();
    assert.equal(pickupApproved(home, 'hub@ca', 'obr_1'), false);
    requestPickup(home, 'hub@ca', 'obr_1', 'session keys for a team');
    const [w] = pendingList(home).pickups;
    assert.equal(w.what, 'session keys for a team');
    assert.equal(approvePickup(home, w.key), true);
    assert.equal(pickupApproved(home, 'hub@ca', 'obr_1'), true);
    assert.equal(pickupApproved(home, 'hub@ca', 'obr_2'), false, 'another request needs its own click');
    spendPickup(home, 'hub@ca', 'obr_1');
    assert.equal(pickupApproved(home, 'hub@ca', 'obr_1'), false, 'spent');
  });
  test('a request nobody clicked is forgotten after a day', () => {
    const home = mk(), { folder, binding } = agentFolder(home);
    requestFolder(home, folder, binding);
    assert.equal(pendingList(home, Date.now() + 25 * 3600_000).folders.length, 0);
  });
  test('the pending and approval files hold no key', () => {
    const home = mk(), { folder, binding } = agentFolder(home);
    requestFolder(home, folder, binding); requestPickup(home, 'hub@ca', 'obr_1', 'session keys');
    for (const f of ['pending.json']) assert.ok(!/ah_(ses|app)_/.test(readFileSync(join(home, f), 'utf8')));
  });
});

describe('the upgrade grandfathers unchanged folders, and only those', () => {
  const SHA = 'a'.repeat(64);
  const reg = (home, name, opts = {}) => { const f = join(home, name); mkdirSync(f, { recursive: true }); writeFileSync(join(f, 'CLAUDE.md'), 'x'); return bindFolder(home, f, { hubId: 'hub-iso', caSha256: SHA, agent: name, ...opts }); };
  const ok = (home, b) => folderApproved(home, b.path, { agent: b.agent, hub_id: b.hub_id, identity: b.identity });
  test('a folder registered before the upgrade and unchanged skips the click, with one log line; a changed or held one still waits', () => {
    const home = mk(), lines = [];
    const same = reg(home, 'same'), changed = reg(home, 'changed'), held = reg(home, 'held', { held: true });
    writeFileSync(join(home, 'changed', 'CLAUDE.md'), 'edited after it was registered');
    const done = grandfather(home, (m) => lines.push(m));
    assert.deepEqual(done.map((d) => d.agent), ['same']);
    assert.equal(ok(home, same), true);
    assert.equal(ok(home, changed), false, 'changed since it was registered: waits for the click');
    assert.equal(ok(home, held), false, 'held settings: waits for the click');
    assert.equal(lines.filter((l) => l.includes('grandfathered:')).length, 1);
    assert.equal(lines.filter((l) => l.includes('not grandfathered')).length, 2);
    assert.deepEqual(unauditedGrandfathered(home, 'hub-iso'), [{ key: pathKey(same.path), agent: 'same' }]);
    markAudited(home, [pathKey(same.path)]);
    assert.deepEqual(unauditedGrandfathered(home, 'hub-iso'), [], 'the audit entry is sent once');
    assert.equal(ok(home, same), true);
  });
  test('a first start before pairing marks the upgrade done: a folder registered after it still waits for its click', () => {
    const home = mk();
    writeFileSync(join(home, 'conclave.mjs'), '');
    assert.equal(grandfather(home).length, 0);
    const late = reg(home, 'late');
    assert.equal(grandfather(home).length, 0, 'not run again');
    assert.equal(ok(home, late), false);
  });
  test('a folder that is not a connector home is not written to', () => {
    const home = mk();
    assert.equal(grandfather(home).length, 0);
    assert.equal(existsSync(join(home, 'approvals.json')) || existsSync(join(home, 'approvals')), false);
  });
  test('it runs once: a folder registered after the upgrade waits for its click', () => {
    const home = mk(), early = reg(home, 'early');
    assert.equal(grandfather(home).length, 1);
    const late = reg(home, 'late');
    assert.equal(grandfather(home).length, 0, 'not run again');
    assert.equal(ok(home, early), true);
    assert.equal(ok(home, late), false);
  });
  test('a folder whose filesystem identity changed (replaced under the same path) is not grandfathered', () => {
    const home = mk(), b = reg(home, 'swapped');
    const file = join(home, 'registry.json'), r = JSON.parse(readFileSync(file, 'utf8'));
    r.folders[pathKey(b.path)].identity = 'some-other-identity';
    writeFileSync(file, JSON.stringify(r));
    assert.equal(grandfather(home).length, 0);
    assert.equal(ok(home, b), false);
  });
});

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
describe('the local screen', () => {
  async function open(home) {
    const s = await startScreen(home, { win: false, io: { reveal() {} } });
    const first = await fetch(s.url, { redirect: 'manual' });
    const cookie = first.headers.get('set-cookie').split(';')[0];
    const base = `http://127.0.0.1:${s.port}`;
    const get = async () => (await fetch(base + '/', { headers: { cookie } })).text();
    const post = (path, body) => fetch(base + path, { method: 'POST', redirect: 'manual', headers: { cookie, origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
    return { s, get, post };
  }
  test('it says what standard isolation protects, lists what waits, and a click allows it', async () => {
    const home = mk();
    withKeys(home);
    const f = join(home, 'agent'); mkdirSync(f);
    const c = canonicalFolder(f);
    requestFolder(home, c, { agent: 'dev-1', hub_id: 'hub-iso', identity: folderIdentity(c) });
    requestPickup(home, 'hub-iso@ca', 'obr_9', 'session keys for the Atlas team');
    const { s, get, post } = await open(home);
    try {
      const page = await get();
      assert.match(page, /Standard isolation/);
      assert.match(page, /does not stop a determined agent/);
      assert.match(page, /key file is encrypted/);
      assert.match(page, /Needs you/);
      assert.ok(page.includes('<span class="hub" title="Text from the hub">dev-1</span>'));
      assert.ok(page.includes(esc(c)), 'the full folder path is on the row');
      assert.match(page, /claude/);
      assert.doesNotMatch(page, /Allow all/);
      assert.match(page, /session keys for the Atlas team/);
      const { folders, pickups } = pendingList(home);
      assert.equal((await post('/allow-folder', { key: folders[0].key })).status, 303);
      assert.equal((await post('/allow-pickup', { key: pickups[0].key })).status, 303);
      assert.equal(pendingList(home).folders.length + pendingList(home).pickups.length, 0);
      assert.equal(folderApproved(home, c, { agent: 'dev-1', hub_id: 'hub-iso', identity: folderIdentity(c) }), true);
      assert.equal(pickupApproved(home, 'hub-iso@ca', 'obr_9'), true);
    } finally { s.close(); await s.closed; }
  });
  test('the wake is turned on per agent, with its level beside it, and agent messages stay off until asked', async () => {
    const home = mk();
    withKeys(home);
    const f = join(home, 'agent'); mkdirSync(f);
    bindFolder(home, f, { hubId: 'hub-iso', caSha256: 'c'.repeat(64), agent: 'dev-1' });
    const { s, get, post } = await open(home);
    try {
      let page = await get();
      assert.ok(page.includes('dev-1</span></b> <span class="muted">· Standard isolation · wake off'));
      assert.ok(page.includes('off (default)'));
      assert.equal(wakeEnabled(home, 'dev-1'), false);
      assert.equal((await post('/wake-set', { label: 'dev-1', on: '1' })).status, 303);
      assert.equal(wakeEnabled(home, 'dev-1'), true);
      page = await get();
      assert.match(page, /wake on/);
      await post('/wake-set', { label: 'not-an-agent', on: '1' });
      assert.equal(wakeEnabled(home, 'not-an-agent'), false, 'only a registered agent');
      assert.equal(wakeSettings(home).agent_messages, false);
      await post('/wake-messages', { on: '1' });
      assert.equal(wakeSettings(home).agent_messages, true);
      await post('/wake-set', { label: 'dev-1', on: '0' });
      assert.equal(wakeEnabled(home, 'dev-1'), false);
    } finally { s.close(); await s.closed; }
  });
  test('a click from another page (wrong origin) or without the cookie allows nothing', async () => {
    const home = mk();
    withKeys(home);
    requestPickup(home, 'hub-iso@ca', 'obr_9', 'x');
    const { s, post } = await open(home);
    try {
      const key = pendingList(home).pickups[0].key;
      const base = `http://127.0.0.1:${s.port}`;
      assert.equal((await fetch(base + '/allow-pickup', { method: 'POST', headers: { origin: 'http://evil.example', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ key }) })).status, 403);
      assert.equal(pickupApproved(home, 'hub-iso@ca', 'obr_9'), false);
      void post;
    } finally { s.close(); await s.closed; }
  });
});
