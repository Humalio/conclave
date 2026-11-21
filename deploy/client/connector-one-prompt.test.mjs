// The connector side of the one-prompt onboarding (docs/onboarding.md, "The prompt"): the installer takes the pairing code on standard
// input only, and a request this PC filed picks up its keys with no click. A temporary home only; no hub is reached.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PAIR_LINES, REFUSED_CODE_LINE } from './connector/pairing.mjs';
import { allowOwnPickup, pickupApproved, pendingList } from './connector/approvals.mjs';

const CODE = 'cnv_enrol_' + 'a'.repeat(26);
const installer = join(import.meta.dirname, 'install.mjs');
const run = (args, input) => {
  const home = mkdtempSync(join(tmpdir(), 'cn-op-'));
  try { return spawnSync(process.execPath, [installer, ...args], { input, encoding: 'utf8', env: { ...process.env, CONCLAVE_HOME: home } }); } finally { rmSync(home, { recursive: true, force: true }); }
};

describe('the installer takes the pairing code on standard input only', () => {
  test('a code given as an argument is refused, and never echoed back', () => {
    const r = run(['--pair', CODE, '--hub', 'https://hub.test', '--ca', 'ab12cd34ef567890'], '');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /never given as an argument/);
    assert.ok(!r.stdout.includes(CODE) && !r.stderr.includes(CODE));
  });
  test('--pair - needs the hub origin and the CA fingerprint', () => {
    const r = run(['--pair', '-'], CODE + '\n');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /needs --hub/);
    assert.ok(!r.stderr.includes(CODE));
  });
  test('nothing on standard input is refused with the way to send it', () => {
    const r = run(['--pair', '-', '--hub', 'https://hub.test', '--ca', 'ab12cd34ef567890'], '');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /No pairing code came on standard input/);
  });
});

describe('a refused code', () => {
  test('tells the operator someone else may have used it', () => {
    assert.ok(PAIR_LINES.code_refused.endsWith(REFUSED_CODE_LINE));
    assert.match(REFUSED_CODE_LINE, /tell the operator now/);
  });
});

describe('the pickup of a request this PC filed', () => {
  test('is allowed with no click and leaves nothing waiting', () => {
    const home = mkdtempSync(join(tmpdir(), 'cn-op-'));
    try {
      assert.equal(allowOwnPickup(home, 'hub-x', 'req_1', 'session keys for a team', [{ agent: 'a', path: join(home, 'a') }]), true);
      assert.equal(pickupApproved(home, 'hub-x', 'req_1'), true);
      assert.deepEqual(pendingList(home).pickups, []);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

import { CODE_RE } from './connector/pairing.mjs';
describe('the pairing code format', () => {
  test('cnc-pair- is the code now, cnv_enrol_ is still accepted, anything else is not', () => {
    assert.ok(CODE_RE.test('cnc-pair-' + 'a2'.repeat(13)));
    assert.ok(CODE_RE.test(CODE));
    assert.ok(!CODE_RE.test('cnc-pair-short') && !CODE_RE.test('cnc-pair-' + 'A'.repeat(26)) && !CODE_RE.test('xyz_' + 'a'.repeat(26)));
  });
});

import https from 'node:https';
import { testCa } from '../../server/test/test-ca.mjs';
import { putHub } from './connector/keyfile.mjs';
import { redeemInvite, choices, loadSetup } from './connector/onboard.mjs';
process.env.CONCLAVE_KEY_STORE = 'file';
describe('redeeming a collaborator invite', () => {
  const pki = testCa('One prompt CA'), APP = 'ah_app_FAKEappKEYforONEPROMPT0001';
  let hub, refuse = false;
  const seen = [];
  const setup = async () => {
    hub = https.createServer({ key: pki.leafKey, cert: pki.leafPem }, (req, res) => {
      let raw = ''; req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const json = (st, b) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
        if (req.headers.authorization !== `Bearer ${APP}`) return json(401, { error: 'unauthorized' });
        seen.push(`${req.method} ${req.url}`);
        if (req.url === '/onboard/choices') return json(200, { kind: 'invite', invite: { id: 'inv_1', project: 'Atlas', team: { id: 't1', name: 'Core' }, role: 'developer' } });
        if (req.url === '/onboard/invites/inv_1/redeem') return refuse ? json(409, { error: 'invite_refused', message: 'The team has ended.' }) : json(200, { request_id: 'req_9', state: 'approved', version: 1 });
        return json(404, { error: 'not_found' });
      });
    });
    await new Promise((r) => hub.listen(0, '127.0.0.1', r));
    const home = mkdtempSync(join(tmpdir(), 'cn-op-'));
    const hubKey = putHub(home, { hubId: 'hub-aaaabbbbcccc', origin: `https://127.0.0.1:${hub.address().port}`, caPem: pki.caPem, appKey: APP });
    return { home, hubKey };
  };
  test('the request is kept as this PC\'s own, in the approved state', async () => {
    const { home, hubKey } = await setup();
    try {
      assert.equal((await choices(home, hubKey)).kind, 'invite');
      const r = await redeemInvite(home, hubKey, 'inv_1', { root: join(home, 'root'), invite: { project: 'Atlas', team: { name: 'Core' } } });
      assert.deepEqual([r.ok, r.request_id, r.state], [true, 'req_9', 'approved']);
      const s = loadSetup(home, 'hub-aaaabbbbcccc');
      assert.deepEqual([s.request.id, s.request.state, s.request.project, s.request.team_name], ['req_9', 'approved', 'Atlas', 'Core']);
      const again = await redeemInvite(home, hubKey, 'inv_1', {});
      assert.deepEqual([again.ok, again.reason], [false, 'request_in_progress'], 'one request at a time');
    } finally { hub.closeAllConnections?.(); await new Promise((r) => hub.close(r)); rmSync(home, { recursive: true, force: true }); }
  });
  test('a refusal gives the reason in plain words and keeps nothing', async () => {
    refuse = true;
    const { home, hubKey } = await setup();
    try {
      const r = await redeemInvite(home, hubKey, 'inv_1', {});
      assert.deepEqual([r.ok, r.reason, r.message], [false, 'invite_refused', 'The team has ended.']);
      assert.ok(!loadSetup(home, 'hub-aaaabbbbcccc').request);
    } finally { hub.closeAllConnections?.(); await new Promise((r) => hub.close(r)); rmSync(home, { recursive: true, force: true }); }
  });
});

// The worker carries the team request this PC filed forward on its own, so nothing waits for a command or the screen.
import { runWorker } from './connector/worker.mjs';
import { statePath } from './connector/onboard.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
describe('the worker carries the PC\'s own request forward', () => {
  const pki = testCa('One prompt worker CA'), APP = 'ah_app_FAKEappKEYforWORKERSTEP001';
  let hub;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const mkHub = async () => {
    hub = https.createServer({ key: pki.leafKey, cert: pki.leafPem }, (req, res) => {
      req.resume();
      req.on('end', () => {
        const json = (st, b) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
        if (req.headers.authorization !== `Bearer ${APP}`) return json(401, { error: 'unauthorized' });
        if (req.url.startsWith('/connector/v1/check-in')) return json(200, { ok: true, orders: 0, ignored_agents: 0 });
        if (req.url.startsWith('/connector/v1/versions/approved')) return json(200, { versions: [] });
        return json(200, { ok: true });
      });
    });
    await new Promise((r) => hub.listen(0, '127.0.0.1', r));
  };
  const run = async (state, calls) => {
    await mkHub();
    const home = mkdtempSync(join(tmpdir(), 'cn-op-'));
    try {
      putHub(home, { hubId: 'hub-worker1', origin: `https://127.0.0.1:${hub.address().port}`, caPem: pki.caPem, appKey: APP });
      writeFileSync(join(home, 'conclave.mjs'), '');
      if (state) { mkdirSync(join(home, 'onboarding'), { recursive: true }); writeFileSync(statePath(home, 'hub-worker1'), JSON.stringify({ version: 1, hub_id: 'hub-worker1', agents: [], ...state })); }
      const ac = new AbortController();
      const done = runWorker({ home, signal: ac.signal, log: () => {}, claudeJson: join(home, 'claude.json'), deps: { noBridge: true, noStream: true, noSync: true, intervalMs: 100, exec: () => ({ status: 1, stdout: '', stderr: '' }), advanceSetup: async () => { calls.n++; return { phase: 'set_up', built: ['a'], failed: [] }; } } });
      const t0 = Date.now(); while (Date.now() - t0 < 3000 && calls.n < 2) await sleep(20);
      await sleep(250);
      ac.abort(); await done;
    } finally { hub.closeAllConnections?.(); await new Promise((r) => hub.close(r)); rmSync(home, { recursive: true, force: true }); }
  };
  test('an approved request is advanced at each check-in', async () => {
    const calls = { n: 0 };
    await run({ request: { id: 'req_1', state: 'approved', project: 'P', root: '/tmp/x' } }, calls);
    assert.ok(calls.n >= 2, `advanced ${calls.n} times`);
  });
  test('a step that fails is tried again after a wait, not at every check-in', async () => {
    const calls = { n: 0 };
    await mkHub();
    const home = mkdtempSync(join(tmpdir(), 'cn-op-'));
    try {
      putHub(home, { hubId: 'hub-worker1', origin: `https://127.0.0.1:${hub.address().port}`, caPem: pki.caPem, appKey: APP });
      writeFileSync(join(home, 'conclave.mjs'), '');
      mkdirSync(join(home, 'onboarding'), { recursive: true });
      writeFileSync(statePath(home, 'hub-worker1'), JSON.stringify({ version: 1, hub_id: 'hub-worker1', agents: [], request: { id: 'req_1', state: 'approved', project: 'P', root: '/tmp/x' } }));
      const ac = new AbortController();
      const done = runWorker({ home, signal: ac.signal, log: () => {}, claudeJson: join(home, 'claude.json'), deps: { noBridge: true, noStream: true, noSync: true, intervalMs: 50, setupBackoffMs: 60_000, exec: () => ({ status: 1, stdout: '', stderr: '' }), advanceSetup: async () => { calls.n++; return { phase: 'set_up', built: [], failed: ['a'] }; } } });
      await sleep(1200);
      ac.abort(); await done;
      assert.equal(calls.n, 1, `tried ${calls.n} times in 1.2 s with a one-minute wait`);
    } finally { hub.closeAllConnections?.(); await new Promise((r) => hub.close(r)); rmSync(home, { recursive: true, force: true }); }
  });
  test('no request, a collected one and a closed one are left alone', async () => {
    for (const state of [null, { request: { id: 'req_1', state: 'collected', root: '/tmp/x' }, confirmed: true }, { request: { id: 'req_1', state: 'denied', root: '/tmp/x' } }]) {
      const calls = { n: 0 };
      await run(state, calls);
      assert.equal(calls.n, 0);
    }
  });
});
