/**
 * Tests for the connector's push stream and delivery orders (docs/connector.md, "The push stream", "Delivery orders"): the
 * stream is read over the pinned connection only and refuses a certificate the hub's CA did not sign; the worker fetches the
 * orders after every open and every event (so a dropped stream loses nothing and nothing runs twice); it falls back to a long
 * poll when the stream cannot open; a compute machine opens none; a delivery order is kept on the PC and shown once at the
 * agent's next prompt, in fixed words. Plain node:test, a stub hub over HTTPS made with openssl (skipped if there is none).
 */
import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateOrder, wasHandled, markHandled, ORDER_REASONS } from './connector/orders.mjs';
import { pendingResults, queueResult, sendResult, flushOutbox } from './connector/outbox.mjs';
import { runWorker } from './connector/worker.mjs';
import { putHub, caFingerprint } from './connector/keyfile.mjs';
import { connect, openStream } from './connector/hubclient.mjs';
import { recordDelivery, takeFor, waiting, deliveryLine } from './connector/deliveries.mjs';

const tmp = [];
const mk = (p = 'conclave-stream-') => { const d = mkdtempSync(join(tmpdir(), p)); tmp.push(d); return d; };
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (ok, ms = 10_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms && !ok()) await sleep(20); return ok(); };

function findOpenssl() {
  for (const c of ['openssl', 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe', 'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe']) {
    try { execFileSync(c, ['version'], { stdio: 'ignore' }); return c; } catch { /* next */ }
  }
  return null;
}
const OPENSSL = findOpenssl();
function makePki(cn) {
  const d = mk('conclave-pki-');
  const o = (...a) => execFileSync(OPENSSL, a, { cwd: d, stdio: 'ignore' });
  o('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', `/CN=${cn}`, '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign');
  o('req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 's.key', '-out', 's.csr', '-subj', '/CN=localhost');
  writeFileSync(join(d, 'ext.cnf'), 'subjectAltName=IP:127.0.0.1,DNS:localhost\nbasicConstraints=CA:FALSE\n');
  o('x509', '-req', '-in', 's.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 's.pem', '-days', '2', '-extfile', 'ext.cnf');
  return { ca: readFileSync(join(d, 'ca.pem'), 'utf8'), cert: readFileSync(join(d, 's.pem'), 'utf8'), key: readFileSync(join(d, 's.key'), 'utf8') };
}
const APP = 'ah_app_FAKEappKEYforSTREAMtests0001';

// ───────────── the order shapes ─────────────
describe('the deliver order', () => {
  const ok = { id: 'pca_d1', kind: 'deliver', payload: { agent_id: 'agent-abc12', items: [{ notice: 'task_assigned', task: 'task_x1' }, { notice: 'message' }], agent_msg: true } };
  test('is valid with ids and fixed words only', () => { assert.equal(validateOrder(ok).ok, true); });
  test('is refused as a whole with any other field, notice, or an unsafe id', () => {
    for (const bad of [
      { ...ok, payload: { ...ok.payload, extra: 1 } },
      { ...ok, payload: { ...ok.payload, items: [{ notice: 'run_this' }] } },
      { ...ok, payload: { ...ok.payload, items: [{ notice: 'message', body: 'hi' }] } },
      { ...ok, payload: { ...ok.payload, items: [{ notice: 'message', task: '../x' }] } },
      { ...ok, payload: { ...ok.payload, agent_id: 'a/b' } },
      { ...ok, payload: { ...ok.payload, items: [] } },
      { ...ok, payload: { agent_id: 'agent-abc12' } },
    ]) assert.equal(validateOrder(bad).ok, false);
  });
});

describe('what a delivery shows on the PC', () => {
  test('keeps items per agent, shows fixed words and counts only, and gives them once', () => {
    const home = mk(), hubKey = 'hub@abc';
    recordDelivery(home, hubKey, { payload: { agent_id: 'agent-a', items: [{ notice: 'task_assigned', task: 'task_secret1' }, { notice: 'review_requested' }, { notice: 'review_requested' }] } });
    assert.equal(waiting(home, hubKey)['agent-a'].length, 3);
    const line = deliveryLine(waiting(home, hubKey)['agent-a']);
    assert.equal(line, 'Conclave: waiting for you: 1 task assigned to you; 2 reviews asked of you. Check `task_list` and `message_read`.');
    assert.ok(!line.includes('secret'));
    assert.equal(takeFor(home, hubKey, 'agent-a').length, 3);
    assert.deepEqual(takeFor(home, hubKey, 'agent-a'), []);
    assert.equal(deliveryLine([]), null);
    assert.equal(deliveryLine([{ notice: 'rm -rf' }]), null);
  });
});

// ───────────── the stream and the worker against a stub hub ─────────────
describe('the stream against a stub hub over HTTPS', { skip: OPENSSL ? false : 'openssl is not available on this PC' }, () => {
  let pki, hub, other;
  const s = { openTimes: [], streams: [], opens: 0, checkIns: 0, polls: 0, results: [], installs: new Set(), plain: 0 };
  let retryAfter = 0, queue = [], mode = 'stream', measureOnly = false, resultFail = 0, resultStatus = 200;

  const serve = (p) => https.createServer({ key: p.key, cert: p.cert }, (req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const json = (st, b) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
      if (req.headers.authorization !== `Bearer ${APP}`) return json(401, { error: 'unauthorized' });
      const url = new URL(req.url, 'https://x');
      if (url.pathname === '/connector/v1/check-in') { s.checkIns++; return json(200, { ok: true, orders: 0, ignored_agents: 0, ...(measureOnly ? { measure_only: true } : {}) }); }
      if (url.pathname === '/connector/v1/stream') {
        s.opens++; s.installs.add(url.searchParams.get('installation'));
        if (mode === 'blocked') return; // a proxy that never lets the stream open
        if (mode === 'missing') return json(404, { error: 'not_found' });
        if (mode === 'ratelimit') { s.openTimes.push(Date.now()); res.writeHead(429, { 'content-type': 'application/json', ...(retryAfter ? { 'retry-after': String(retryAfter) } : {}) }); return res.end('{"error":"rate_limited"}'); }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: orders\ndata: {}\n\n');
        s.streams.push(res);
        return;
      }
      if (url.pathname === '/connector/v1/orders') {
        const take = () => { const o = queue; queue = []; return o; };
        if (url.searchParams.get('wait')) {
          s.polls++;
          const t0 = Date.now(), tick = () => { if (queue.length || Date.now() - t0 > 400) return json(200, { orders: take() }); setTimeout(tick, 20); };
          return tick();
        }
        s.plain++;
        return json(200, { orders: take() });
      }
      const m = /^\/connector\/v1\/orders\/([^/]+)\/result$/.exec(url.pathname);
      if (m) {
        if (resultFail > 0) { resultFail--; return json(503, { error: 'unavailable' }); }
        s.results.push({ id: m[1], ...JSON.parse(raw) });
        return resultStatus === 200 ? json(200, { ok: true }) : json(resultStatus, { error: 'not_found' });
      }
      if (url.pathname === '/connector/v1/versions/approved') return json(200, { versions: [] });
      return json(404, { error: 'not_found' });
    });
  });
  const ping = () => { for (const r of s.streams) { try { r.write('event: orders\ndata: {}\n\n'); } catch { /* closed */ } } };
  const reset = () => { for (const r of s.streams) { try { r.end(); } catch { /* closed */ } } retryAfter = 0; Object.assign(s, { openTimes: [], streams: [], opens: 0, checkIns: 0, polls: 0, results: [], installs: new Set(), plain: 0 }); queue = []; mode = 'stream'; measureOnly = false; };

  before(async () => {
    pki = makePki('stream-test-ca'); other = makePki('another-ca');
    hub = serve(pki);
    await new Promise((r) => hub.listen(0, '127.0.0.1', r));
  });
  after(() => new Promise((r) => { for (const x of s.streams) { try { x.destroy(); } catch { /* gone */ } } hub.close(r); }));

  const section = () => ({ hub_id: 'hub-stream', origin: `https://127.0.0.1:${hub.address().port}`, ca_pem: pki.ca, ca_sha256: caFingerprint(pki.ca), app_key: APP });
  const freshHome = () => { const home = mk(); putHub(home, { hubId: 'hub-stream', origin: `https://127.0.0.1:${hub.address().port}`, caPem: pki.ca, appKey: APP }); return home; };
  const run = (home, deps = {}) => {
    const ac = new AbortController();
    // A long check-in interval: orders reach the worker through the stream or the long poll, not through the check-in.
    const done = runWorker({ home, signal: ac.signal, log: () => {}, claudeJson: join(home, 'claude.json'), deps: { noBridge: true, intervalMs: 60_000, exec: () => ({ status: 1, stdout: '', stderr: '' }), streamBackoffMs: 50, ...deps } });
    return { ac, done, stop: async () => { ac.abort(); await done; } };
  };
  const deliver = (id, agent = 'agent-live1', items = [{ notice: 'task_assigned', task: 'task_t1' }]) => ({ id, kind: 'deliver', payload: { agent_id: agent, items } });

  test('an order made after the stream opened reaches the worker on the next event, and is handled once', async () => {
    reset();
    const home = freshHome(), w = run(home);
    assert.ok(await waitFor(() => s.streams.length === 1 && s.plain >= 1), 'the stream opened and the worker fetched at once');
    queue = [deliver('pca_ev1')];
    ping();
    assert.ok(await waitFor(() => s.results.length === 1), 'the order was fetched and answered');
    assert.equal(s.results[0].id, 'pca_ev1');
    assert.equal(s.results[0].state, 'failed');
    assert.match(s.results[0].result.reason, /no folder registered for that agent/); // this stub PC has no folder for the agent, so no turn starts
    const hubKey = `hub-stream@${caFingerprint(pki.ca)}`;
    assert.equal(waiting(home, hubKey)['agent-live1'].length, 1); // kept for the screen and the prompt hook
    // The same id again (a replay) does nothing.
    queue = [deliver('pca_ev1')]; ping();
    await sleep(300);
    assert.equal(s.results.length, 1);
    assert.equal(waiting(home, hubKey)['agent-live1'].length, 1);
    assert.equal(s.installs.size, 1);
    await w.stop();
  });

  test('a result the hub could not take is kept in the outbox and sent again at the next check-in, once', async () => {
    reset(); resultFail = 2;
    const home = freshHome(), hubKey = `hub-stream@${caFingerprint(pki.ca)}`;
    const w = run(home, { intervalMs: 150 });
    assert.ok(await waitFor(() => s.streams.length === 1 && s.plain >= 1));
    queue = [deliver('pca_ob1')];
    ping();
    assert.ok(await waitFor(() => s.results.length === 1, 15_000), 'the result reached the hub at a later check-in');
    assert.equal(s.results[0].id, 'pca_ob1');
    await sleep(500);
    assert.equal(s.results.length, 1, 'exactly once');
    assert.deepEqual(pendingResults(home, hubKey), [], 'the outbox is empty once the hub has it');
    await w.stop();
  });

  test('"not found" from the hub means it has the result already: the entry is dropped and not sent again', async () => {
    reset(); resultStatus = 404;
    try {
      const home = freshHome(), hubKey = `hub-stream@${caFingerprint(pki.ca)}`;
      const w = run(home, { intervalMs: 150 });
      assert.ok(await waitFor(() => s.streams.length === 1 && s.plain >= 1));
      queue = [deliver('pca_ob2')];
      ping();
      assert.ok(await waitFor(() => s.results.length >= 1));
      await sleep(500);
      assert.equal(s.results.length, 1);
      assert.deepEqual(pendingResults(home, hubKey), []);
      await w.stop();
    } finally { resultStatus = 200; }
  });

  test('an order handed out again (the hub does so until a result arrives) runs once; one cut short before it ran runs on the next fetch', async () => {
    reset();
    const home = freshHome(), hubKey = `hub-stream@${caFingerprint(pki.ca)}`;
    // A crash in the middle of a batch: the first order of an earlier batch was handled, the second never ran (so it was never marked).
    markHandled(home, hubKey, 'pca_cr1');
    assert.equal(wasHandled(home, hubKey, 'pca_cr1'), true);
    assert.equal(wasHandled(home, hubKey, 'pca_cr2'), false);
    const w = run(home);
    assert.ok(await waitFor(() => s.streams.length === 1 && s.plain >= 1));
    queue = [deliver('pca_cr1'), deliver('pca_cr2')]; // the hub hands both out again
    ping();
    assert.ok(await waitFor(() => s.results.length === 1));
    await sleep(300);
    assert.deepEqual(s.results.map((r) => r.id), ['pca_cr2']); // cr1 is skipped, cr2 runs
    assert.equal(wasHandled(home, hubKey, 'pca_cr2'), true);
    queue = [deliver('pca_cr2')]; ping();
    await sleep(300);
    assert.equal(s.results.length, 1);
    await w.stop();
  });

  test('the operator Stop is a valid order; with no run of that agent going it is answered failed with the fixed reason, never done', async () => {
    assert.equal(validateOrder({ id: 'pca_s0', kind: 'deliver', payload: { agent_id: 'agent-live1', items: [], reason: 'stop' } }).ok, true);
    reset();
    const home = freshHome(), w = run(home);
    assert.ok(await waitFor(() => s.streams.length === 1 && s.plain >= 1));
    queue = [{ id: 'pca_stop1', kind: 'deliver', payload: { agent_id: 'agent-live1', items: [], reason: 'stop' } }];
    ping();
    assert.ok(await waitFor(() => s.results.length === 1), 'the Stop was answered');
    assert.equal(s.results[0].id, 'pca_stop1');
    assert.equal(s.results[0].state, 'failed');
    assert.equal(s.results[0].result.reason, ORDER_REASONS.no_run);
    await w.stop();
  });

  test('after a dropped stream the worker reconnects, fetches what waited, and loses and repeats nothing', async () => {
    reset();
    const home = freshHome(), w = run(home);
    assert.ok(await waitFor(() => s.streams.length === 1));
    queue = [deliver('pca_gap1')]; // made while the stream is down: no event can say so
    for (const r of s.streams.splice(0)) r.destroy();
    assert.ok(await waitFor(() => s.opens >= 2 && s.results.length === 1), 'reconnected, and the order made during the gap was fetched');
    await sleep(300);
    assert.equal(s.results.filter((r) => r.id === 'pca_gap1').length, 1);
    await w.stop();
  });

  test('a 429 on the stream backs off: the Retry-After the hub sends is obeyed, and without one the wait grows from the base', async () => {
    reset(); mode = 'ratelimit'; retryAfter = 1;
    let home = freshHome(), w = run(home, { longPollWait: 1 });
    assert.ok(await waitFor(() => s.openTimes.length >= 2, 6000), 'it tried again');
    assert.ok(s.openTimes[1] - s.openTimes[0] >= 950, 'not before the second the hub named (' + (s.openTimes[1] - s.openTimes[0]) + ' ms)');
    await w.stop();
    reset(); mode = 'ratelimit';
    home = freshHome(); w = run(home, { longPollWait: 1 });
    assert.ok(await waitFor(() => s.openTimes.length >= 3, 6000));
    const g1 = s.openTimes[1] - s.openTimes[0], g2 = s.openTimes[2] - s.openTimes[1];
    assert.ok(g1 >= 90 && g2 > g1, 'the wait doubles from the base: ' + g1 + ' then ' + g2 + ' ms');
    await w.stop();
  });

  test('after the long poll window the stream is tried again, and orders then come by the stream', async () => {
    reset(); mode = 'missing';
    const home = freshHome(), w = run(home, { longPollWait: 1, longPollWindowMs: 700 });
    assert.ok(await waitFor(() => s.polls >= 1), 'long polling first');
    const opens = s.opens;
    mode = 'stream';
    assert.ok(await waitFor(() => s.streams.length === 1, 8000), 'the stream opened again after the window (' + opens + ' opens before)');
    queue = [deliver('pca_back1')]; ping();
    assert.ok(await waitFor(() => s.results.length === 1));
    await w.stop();
  });

  test('a disconnect order on the normal poll is refused with the fixed reason: it is fetched with its own credential, never here', async () => {
    reset();
    const home = freshHome(), w = run(home);
    assert.ok(await waitFor(() => s.streams.length === 1 && s.plain >= 1));
    queue = [{ id: 'pca_dc1', kind: 'disconnect', payload: {} }];
    ping();
    assert.ok(await waitFor(() => s.results.length === 1), 'it was answered');
    assert.equal(s.results[0].id, 'pca_dc1');
    assert.equal(s.results[0].state, 'failed');
    assert.equal(s.results[0].result.reason, ORDER_REASONS.disconnect_elsewhere);
    await w.stop();
  });

  test('when the stream cannot open (a hub without it) the same orders come by the long poll', async () => {
    reset(); mode = 'missing';
    const home = freshHome(), w = run(home, { longPollWait: 1 });
    assert.ok(await waitFor(() => s.polls >= 1), 'long polling');
    queue = [deliver('pca_lp1')];
    assert.ok(await waitFor(() => s.results.length === 1), 'the long poll delivered the order');
    await w.stop();
  });

  test('when a proxy blocks the stream behind an open connection, the long poll takes over', async () => {
    reset(); mode = 'blocked';
    const home = freshHome(), w = run(home, { longPollWait: 1, streamTimings: { openMs: 200 } });
    assert.ok(await waitFor(() => s.polls >= 1), 'long polling after the stream never opened');
    queue = [deliver('pca_blk1')];
    assert.ok(await waitFor(() => s.results.length === 1));
    await w.stop();
  });

  test('a compute machine opens no stream', async () => {
    reset(); measureOnly = true;
    const home = freshHome(), w = run(home, { intervalMs: 100 });
    assert.ok(await waitFor(() => s.checkIns >= 3));
    await w.stop();
    assert.equal(s.opens, 0);
  });

  test('the stream refuses a hub whose certificate its own CA did not sign, and sends nothing', async () => {
    reset();
    const hits = { n: 0 }, wrong = https.createServer({ key: other.key, cert: other.cert }, (_q, res) => { hits.n++; res.end('x'); });
    await new Promise((r) => wrong.listen(0, '127.0.0.1', r));
    try {
      // The section pins the stub hub's CA, but the server answering is signed by another CA.
      const c = connect({ origin: `https://127.0.0.1:${wrong.address().port}`, ca_pem: pki.ca, ca_sha256: caFingerprint(pki.ca) });
      assert.equal(c.ok, true);
      let events = 0;
      const r = await openStream(c.hub, { headers: { Authorization: `Bearer ${APP}` }, onOrders: () => { events++; }, openMs: 3000 });
      assert.deepEqual({ status: r.status, reason: r.reason }, { status: 0, reason: 'tls_refused' });
      assert.equal(events, 0);
      assert.equal(hits.n, 0); // no request, and so no app key, reached the wrong server
    } finally { await new Promise((r) => wrong.close(r)); }
  });

  test('an open stream says "orders waiting" at each event, and ends when the hub ends it', async () => {
    reset();
    const c = connect(section());
    let events = 0, opened = false;
    const p = openStream(c.hub, { headers: { Authorization: `Bearer ${APP}` }, onOpen: () => { opened = true; }, onOrders: () => { events++; } });
    assert.ok(await waitFor(() => events === 1 && opened));
    ping();
    assert.ok(await waitFor(() => events === 2));
    for (const r of s.streams) r.end();
    assert.deepEqual(await p, { status: 200, reason: 'closed' });
  });
});
