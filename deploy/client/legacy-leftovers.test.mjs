/**
 * Old setup left on a PC (connector/migrate.mjs `legacyLeftovers`, `leftoversOffer`; `conclave check`; the check-in flag in
 * connector/worker.mjs), run with `npm run test:helper`. The migration journal and the user environment are stand-ins in a
 * temporary home: nothing here touches the real registry or a real key.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
process.env.CONCLAVE_KEY_STORE = 'file';
import { legacyLeftovers, legacyLeftoverKinds, LEFTOVER_KINDS, leftoversOffer, finish, migrationState } from './connector/migrate.mjs';
import { putHub } from './connector/keyfile.mjs';
import { legacyLeftoverKindsCached } from './connector/worker.mjs';

function findOpenssl() {
  for (const c of ['openssl', 'C:/Program Files/Git/usr/bin/openssl.exe', 'C:/Program Files/Git/mingw64/bin/openssl.exe']) { try { execFileSync(c, ['version'], { stdio: 'ignore' }); return c; } catch { /* next */ } }
  return null;
}
const OPENSSL = findOpenssl();
const tlsOpts = { skip: OPENSSL ? false : 'openssl is not available on this PC' };
const tmp = [];
const home = () => { const d = mkdtempSync(join(tmpdir(), 'conclave-left-')); tmp.push(d); return d; };
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
const journal = (h, status, extra = {}) => { mkdirSync(join(h, 'migration'), { recursive: true }); writeFileSync(join(h, 'migration', 'state.json'), JSON.stringify({ status, files: [], folders: [], ...extra })); };
const env = (value) => { const e = { value, unsets: 0, get: () => e.value, unset() { e.unsets++; e.value = null; } }; return e; };

test('nothing is left on a PC that never moved and has no old CA setting', () => {
  const h = home();
  assert.equal(legacyLeftovers(h, env(null)), false);
  assert.equal(leftoversOffer(h, env(null)), null);
});

test('a move that is not finished leaves its rollback copies: reported, and offered', () => {
  for (const status of ['applied', 'applying']) {
    const h = home(); journal(h, status);
    assert.equal(legacyLeftovers(h, env(null)), true, status);
    const o = leftoversOffer(h, env(null));
    assert.match(o, /conclave migrate --finish --remove-legacy-ca/);
    assert.match(o, /never runs it/);
  }
});

test('a finished or rolled-back move leaves nothing by itself', () => {
  for (const status of ['finished', 'rolled_back']) { const h = home(); journal(h, status); assert.equal(legacyLeftovers(h, env(null)), false, status); }
});

/** A throwaway CA in a connector home: hub-ca.pem plus the key-file section a move pins (skipped where openssl is missing). */
function pinnedHome() {
  const h = home();
  const d = mkdtempSync(join(tmpdir(), 'conclave-leftca-')); tmp.push(d);
  execFileSync(OPENSSL, ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', join(d, 'ca.key'), '-out', join(d, 'ca.pem'), '-days', '2', '-subj', '/CN=leftovers', '-addext', 'basicConstraints=critical,CA:TRUE'], { stdio: 'ignore' });
  const pem = readFileSync(join(d, 'ca.pem'), 'utf8');
  writeFileSync(join(h, 'hub-ca.pem'), pem);
  const hub_key = putHub(h, { hubId: 'hub_leftovers01', origin: 'https://hub.example.test', caPem: pem, appKey: 'ah_app_FAKEappKEYforLEFTOVERStest01' });
  return { h, hub_key };
}

test('the old CA setting counts only while it names the pinned hub-ca.pem; one naming another file does not', tlsOpts, () => {
  const { h, hub_key } = pinnedHome(); journal(h, 'finished', { hub_key });
  assert.equal(legacyLeftovers(h, env(join(h, 'hub-ca.pem'))), true);
  assert.match(leftoversOffer(h, env(join(h, 'hub-ca.pem'))), /NODE_EXTRA_CA_CERTS/);
  assert.equal(legacyLeftovers(h, env(join(tmpdir(), 'their-own-ca.pem'))), false);
  assert.equal(legacyLeftovers(h, { get() { throw new Error('registry unreadable'); } }), false, 'a failed read is not reported');
});

test('a variable that --remove-legacy-ca would leave is not reported (the flag never repeats with nothing to clear)', tlsOpts, () => {
  const { h, hub_key } = pinnedHome(); journal(h, 'finished', { hub_key });
  writeFileSync(join(h, 'hub-ca.pem'), readFileSync(join(h, 'hub-ca.pem'), 'utf8').replace(/[A-Za-z]/, (c) => (c === 'A' ? 'B' : 'A')));
  const e = env(join(h, 'hub-ca.pem'));
  const r = finish(h, { removeLegacyCa: true, userEnv: e });
  assert.match(r.lines.join(' '), /was left/);
  assert.equal(legacyLeftovers(h, e), false);
  assert.equal(leftoversOffer(h, e), null);
  const h2 = home(); journal(h2, 'finished'); writeFileSync(join(h2, 'hub-ca.pem'), 'not a certificate');
  assert.equal(legacyLeftovers(h2, env(join(h2, 'hub-ca.pem'))), false, 'a file that is not a certificate cannot be the pinned one');
});

test('a pinned variable is cleared by --finish --remove-legacy-ca, and the flag goes with it', tlsOpts, () => {
  const { h, hub_key } = pinnedHome(); journal(h, 'applied', { hub_key });
  const e = env(join(h, 'hub-ca.pem'));
  assert.equal(legacyLeftovers(h, e), true);
  assert.equal(finish(h, { removeLegacyCa: true, userEnv: e }).ok, true);
  assert.equal(e.unsets, 1);
  assert.equal(legacyLeftovers(h, e), false);
});

test('the offer is only words: asking never changes the journal, the files or the environment', () => {
  const h = home(); journal(h, 'applied'); const e = env(join(h, 'hub-ca.pem'));
  const before = readFileSync(join(h, 'migration', 'state.json'), 'utf8');
  leftoversOffer(h, e); legacyLeftovers(h, e);
  assert.equal(readFileSync(join(h, 'migration', 'state.json'), 'utf8'), before);
  assert.equal(e.unsets, 0);
  assert.equal(migrationState(h).status, 'applied');
});

test('--finish --remove-legacy-ca can still clear the old CA setting after a plain --finish, and keeps the finished journal', () => {
  const h = home(); journal(h, 'finished', { hub_key: 'hub_x' });
  const e = env(join(h, 'hub-ca.pem'));
  const plain = finish(h, { userEnv: e });
  assert.equal(plain.ok, false, 'without the flag a finished move has nothing to do');
  const r = finish(h, { removeLegacyCa: true, userEnv: e });
  assert.equal(r.ok, true);
  assert.equal(migrationState(h).status, 'finished');
  assert.ok(!r.lines.some((l) => /rollback copies were removed/.test(l)), 'the copies are not announced twice');
  assert.equal(finish(home(), { removeLegacyCa: true, userEnv: e }).ok, false, 'a PC that never moved has nothing to finish');
});

test('the check-in flag is read once a minute, not on every call', () => {
  let reads = 0;
  const read = () => { reads++; return reads === 1 ? ['old_keys'] : []; };
  const h = '/memo/home-' + Math.random();
  assert.deepEqual(legacyLeftoverKindsCached(h, 1_000_000, read), ['old_keys']);
  assert.deepEqual(legacyLeftoverKindsCached(h, 1_030_000, read), ['old_keys']);
  assert.equal(reads, 1);
  assert.deepEqual(legacyLeftoverKindsCached(h, 1_061_000, read), []);
  assert.equal(reads, 2);
});

test('the PC says which kind of the old setup is left: fixed words, in a fixed order, never a path', () => {
  const none = home();
  assert.deepEqual(legacyLeftoverKinds(none, env(null)), []);
  const h = home(); journal(h, 'applied');
  writeFileSync(join(h, 'keys.env'), 'x'); writeFileSync(join(h, 'codex-bridge.mjs'), 'x');
  const kinds = legacyLeftoverKinds(h, env(null));
  assert.deepEqual(kinds, ['unfinished_move', 'old_keys', 'bridge_pieces']);
  assert.ok(kinds.every((k) => LEFTOVER_KINDS.includes(k)));
  assert.equal(legacyLeftovers(h, env(null)), true);
  const k = home(); writeFileSync(join(k, 'keys.env'), 'x');
  assert.deepEqual(legacyLeftoverKinds(k, env(null)), ['old_keys']);
  assert.match(leftoversOffer(k, env(null)), /conclave migrate/);
  assert.doesNotMatch(leftoversOffer(k, env(null)), /--finish/, 'old files are not what --finish clears');
  const b = home(); writeFileSync(join(b, 'agent-hub-bridge.mjs'), 'x');
  assert.deepEqual(legacyLeftoverKinds(b, env(null)), ['bridge_pieces']);
});
