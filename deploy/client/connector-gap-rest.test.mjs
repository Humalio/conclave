// The "Connector and wake" gaps of acceptance-gaps.md that no other suite covers: the audit entries for folder decisions are
// sent at check-in and kept and sent again until the hub takes them (docs/connector.md, "Clicks"), the leftover kinds the check-in
// carries, and the transfer loop reporting the connector's own version. A stub hub over pinned HTTPS and temporary homes only.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testCa } from '../../server/test/test-ca.mjs';
import { putHub } from './connector/keyfile.mjs';
import { runWorker } from './connector/worker.mjs';
import { approvalsPath, requestFolder, denyFolder, unreportedDenials } from './connector/approvals.mjs';
import { pathKey, canonicalFolder } from './connector/paths.mjs';
import { bindFolder } from './connector/registry.mjs';
import { readRun } from './connector/wake.mjs';
import { runLoop, VERSION as TRANSFERS_VERSION } from './connector/transfers.mjs';
import { CONNECTOR_VERSION } from './connector/version.mjs';

process.env.CONCLAVE_KEY_STORE = 'file';
const APP = 'ah_app_FAKEappKEYforGAPRESTtests0001';
const tmp = [];
const mk = () => { const d = mkdtempSync(join(tmpdir(), 'cn-gap-')); tmp.push(d); return d; };
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (ok, ms = 10_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms && !ok()) await sleep(20); return ok(); };

describe('the audit entries for folder decisions', () => {
  const pki = testCa('Gap rest CA');
  const seen = { grandfathered: [], pickup: [], denied: [], folders: [], checkIns: 0, last: null };
  let failNext = 0, hub;
  before(async () => {
    hub = https.createServer({ key: pki.leafKey, cert: pki.leafPem }, (req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const json = (st, b) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
        if (req.headers.authorization !== `Bearer ${APP}`) return json(401, { error: 'unauthorized' });
        const p = req.url.split('?')[0];
        if (p === '/connector/v1/check-in') { seen.checkIns++; try { seen.last = JSON.parse(raw); } catch { /* not json */ } return json(200, { ok: true, orders: 0, ignored_agents: 0 }); }
        if (p === '/connector/v1/orders') return json(200, { orders: [] });
        if (p === '/connector/v1/versions/approved') return json(200, { versions: [] });
        const key = { '/connector/v1/folders-grandfathered': 'grandfathered', '/connector/v1/folders-allowed-with-pickup': 'pickup', '/connector/v1/folders-denied': 'denied', '/connector/v1/folders': 'folders' }[p];
        if (key) {
          if (failNext > 0) { failNext--; return json(503, { error: 'unavailable' }); }
          seen[key].push(JSON.parse(raw)); return json(200, { ok: true });
        }
        return json(200, { ok: true });
      });
    });
    await new Promise((r) => hub.listen(0, '127.0.0.1', r));
  });
  after(() => new Promise((r) => { hub.closeAllConnections?.(); hub.close(r); }));

  function prepare() {
    const home = mk();
    const origin = `https://127.0.0.1:${hub.address().port}`;
    putHub(home, { hubId: 'hub-gap', origin, caPem: pki.caPem, appKey: APP });
    writeFileSync(join(home, 'conclave.mjs'), '');
    const f = join(home, 'f1'); mkdirSync(f); const c = canonicalFolder(f);
    // A grandfathered folder and one allowed with a pickup, both with their audit entry still to send; the upgrade already ran.
    writeFileSync(approvalsPath(home), JSON.stringify({ folders: {
      [pathKey(c)]: { agent: 'dev-old', hub_id: 'hub-gap', identity: null, approved_at: 1, by: 'upgrade', audited: false },
      [pathKey(join(home, 'f2'))]: { agent: 'dev-new', hub_id: 'hub-gap', identity: null, approved_at: 1, by: 'pickup', ref: 'opk_1', agent_id: 'agt_new', audited: false },
    }, pickups: {}, grandfathered_at: 1 }));
    // A folder the user denied, not yet reported.
    const f3 = join(home, 'f3'); mkdirSync(f3); const c3 = canonicalFolder(f3);
    requestFolder(home, c3, { agent: 'dev-denied', hub_id: 'hub-gap', identity: null });
    denyFolder(home, pathKey(c3));
    return home;
  }
  const start = (home) => {
    const ac = new AbortController();
    const done = runWorker({ home, signal: ac.signal, log: () => {}, claudeJson: join(home, 'claude.json'), deps: { noBridge: true, noStream: true, noSync: true, intervalMs: 150, exec: () => ({ status: 1, stdout: '', stderr: '' }) } });
    return async () => { ac.abort(); await done; };
  };

  test('each entry is sent at check-in once the hub takes it, and not again', async () => {
    Object.assign(seen, { grandfathered: [], pickup: [], denied: [], checkIns: 0 }); failNext = 0;
    const home = prepare(), stop = start(home);
    assert.ok(await waitFor(() => seen.grandfathered.length === 1 && seen.pickup.length === 1 && seen.denied.length === 1), 'all three were sent');
    assert.deepEqual(seen.grandfathered[0], { agents: ['dev-old'] });
    assert.deepEqual(seen.pickup[0], { allowed: [{ agent_id: 'agt_new', ref: 'opk_1' }] });
    assert.deepEqual(seen.denied[0].denied.map((d) => [d.what, d.agent]), [['folder', 'dev-denied']]);
    assert.equal(typeof seen.last?.legacy_leftovers, 'boolean', 'the flag is in the check-in');
    assert.deepEqual(seen.last?.legacy_leftover_kinds, [], 'and so is the list of kinds: nothing old on this PC');
    const n = seen.checkIns;
    assert.ok(await waitFor(() => seen.checkIns >= n + 3), 'more check-ins went by');
    await stop();
    assert.equal(seen.grandfathered.length, 1); assert.equal(seen.pickup.length, 1); assert.equal(seen.denied.length, 1, 'once each');
    assert.deepEqual(unreportedDenials(home), []);
  });

  test('the folders sent for registration carry the agent id beside the folder slug, so the hub can tell the agent', async () => {
    Object.assign(seen, { grandfathered: [], pickup: [], denied: [], folders: [], checkIns: 0 }); failNext = 0;
    const home = prepare();
    const f = join(home, 'auto-coordinator'); mkdirSync(f);
    bindFolder(home, f, { hubId: 'hub-gap', caSha256: pki.caSha256, agent: 'auto-coordinator', agentId: 'agent-qnevzruq' });
    const stop = start(home);
    assert.ok(await waitFor(() => seen.folders.length >= 1), 'the folder was sent');
    await stop();
    assert.deepEqual(seen.folders[0].folders.map((x) => [x.agent, x.agent_id]), [['auto-coordinator', 'agent-qnevzruq']]);
  });

  test('an entry the hub could not take is kept and sent again at a later check-in, then not again', async () => {
    Object.assign(seen, { grandfathered: [], pickup: [], denied: [], checkIns: 0 }); failNext = 3; // the first try of each route fails
    const home = prepare(), stop = start(home);
    assert.ok(await waitFor(() => seen.grandfathered.length >= 1 && seen.pickup.length >= 1 && seen.denied.length >= 1), 'each arrived on a later check-in');
    const n = seen.checkIns;
    assert.ok(await waitFor(() => seen.checkIns >= n + 3));
    await stop();
    assert.equal(seen.grandfathered.length, 1); assert.equal(seen.pickup.length, 1); assert.equal(seen.denied.length, 1);
  });
});

describe('the version the transfer loop reports', () => {
  test('the transfer loop reports the connector\'s own version, so the console never shows an old bridge version for a connector PC', async () => {
    assert.equal(TRANSFERS_VERSION, CONNECTOR_VERSION);
    let body = null;
    const ac = new AbortController();
    const fetchStub = async (url, init = {}) => {
      if (new URL(url).pathname === '/bridge/poll') { body = JSON.parse(init.body); ac.abort(); }
      return new Response(JSON.stringify({ allowed_folders: [], jobs: [], poll_after_ms: 20_000 }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    await runLoop({ hub: 'https://hub.test', key: 'ah_app_FAKE', signal: ac.signal, fetch: fetchStub, log: () => {}, agentFolders: () => [], refusedDirs: [] }).catch(() => {});
    assert.equal(body?.version, CONNECTOR_VERSION);
  });
});

// install-service really sets the account and the access (docs/connector.md, "Install, step by step"). The command strings are
// tested elsewhere; this runs the Linux steps for real, in a throw-away container: only where the user is root on Linux and CI=1
// (the .5 runner), never on a person's PC. The systemd unit itself needs systemd, so its text is checked and not started.
import { spawnSync } from 'node:child_process';
import { statSync, existsSync } from 'node:fs';
import { vaultSpec, LINUX_USER } from './connector/vaultservice.mjs';

const REAL = process.platform === 'linux' && process.getuid?.() === 0 && process.env.CI === '1';
describe('install-service on Linux, run for real', { skip: REAL ? false : 'runs only as root on Linux with CI=1 (the .5 runner)' }, () => {
  test('the service user is created, owns the vault folder privately, and the app copy stays root\'s', () => {
    const base = mk(), root = join(base, 'conclave'), place = { id: 'gaptest', root, dir: join(root, 'vault'), app: join(root, 'app'), view: join(root, 'view', 'keyview.json'), address: join(base, 'vault.sock') };
    for (const d of [place.dir, place.app, join(root, 'view')]) mkdirSync(d, { recursive: true });
    const spec = vaultSpec(join(base, 'home'), { platform: 'linux', place });
    assert.equal(spec.account, LINUX_USER);
    assert.match(spec.unitText, new RegExp(`User=${LINUX_USER}\n`));
    assert.match(spec.unitText, /NoNewPrivileges=true/);
    // Everything but the systemd calls, which need a running systemd.
    for (const [what, cmd, args] of [...spec.create, ...spec.secure.filter(([, c]) => c !== 'systemctl')]) {
      const r = spawnSync(cmd, args, { encoding: 'utf8' });
      assert.equal(r.status, 0, `${what}: ${r.stderr}`);
    }
    const id = spawnSync('id', ['-u', LINUX_USER], { encoding: 'utf8' });
    assert.equal(id.status, 0, 'the system user exists');
    const uid = Number(id.stdout.trim());
    assert.equal(statSync(place.dir).uid, uid, 'the vault folder belongs to the service user');
    assert.equal(statSync(place.dir).mode & 0o777, 0o700, 'and nobody else can open it');
    assert.equal(statSync(join(root, 'view')).mode & 0o777, 0o755, 'the key view folder is readable by the PC user');
    assert.equal(statSync(place.app).uid, 0, 'the service runs a copy of the connector that only root owns');
    assert.ok(!existsSync(join(place.dir, 'keys.json')));
  });
});

describe('a Codex usage limit', () => {
  const file = () => join(mk(), 'run.jsonl');
  const lines = (list) => list.map((e) => JSON.stringify(e) + '\n').join('');
  test('a Codex run that failed on a limit with no reset time we can read pauses for an hour; a structured rate-limit event pauses until its reset', () => {
    const f = file();
    writeFileSync(f, lines([{ type: 'thread.started', thread_id: 'thr_1' }, { type: 'turn.failed', error: { message: 'You have hit your usage limit. Try again at 3pm.' } }]));
    const r = readRun(f, 1_800_000_000_000);
    assert.equal(r.session, 'thr_1'); assert.equal(r.result, false); assert.equal(r.limit, 1_800_000_000_000 + 3600_000, 'the error event names no reset the connector can read: one hour');
    writeFileSync(f, lines([{ type: 'thread.started', thread_id: 'thr_1' }, { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1900000000 } }]));
    assert.equal(readRun(f, 1899999000_000).limit, 1900000000_000, 'a structured limit pauses, for either client');
  });
});
