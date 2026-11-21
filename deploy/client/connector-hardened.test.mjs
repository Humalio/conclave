// Hardened isolation (docs/connector.md): the key service holds every key and the connector sees placeholders.
//  - G6(a): a process of the PC user cannot read an agent's key while Hardened is on (and can at Standard: expected to fail there).
//  - Turn tokens still work through the service: the broker, the hook's calls, a stream and a revoke all go through the relay.
//  - Uninstalling returns to Standard with no key lost; any install failure rolls back and leaves the user's key file as it was.
// The service runs in this process on a temporary folder; the system commands are recorded, never run (nothing on this PC changes).
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testCa } from '../../server/test/test-ca.mjs';
import { putHub, putAgentKey, readKeyFile, keyFilePath, caFingerprint, markDisconnected, stageAgentKey, commitStaged, discardStaged, labelHoldingKey } from './connector/keyfile.mjs';
import { readIsolation, vaultPlace, markerPath } from './connector/isolation.mjs';
import { masterPath } from './connector/keystore.mjs';
import { askVault } from './connector/vaultclient.mjs';
import { startVault, publicView, PICKUP_REFS_MAX } from './connector/vault.mjs';
import { installVault, uninstallVault, vaultSpec, g6aProbe, serviceHome, handBack, HOST_SOURCE } from './connector/vaultservice.mjs';
import { connect, request, openStream } from './connector/hubclient.mjs';
import { startBroker, askBroker } from './connector/broker.mjs';
import { registerFolder } from './connector/register.mjs';
import { approveFolderByConnector, pendingList, approvePickup } from './connector/approvals.mjs';
import { runHandovers } from './connector/handover.mjs';
import { canonicalFolder, WIN } from './connector/paths.mjs';
import { scanTranscript } from './connector/leak.mjs';

process.env.CONCLAVE_KEY_STORE = 'file';
const CLI = join(dirname(fileURLToPath(import.meta.url)), 'conclave.mjs');
const APP = 'ah_app_FAKEappKEYforHARDENEDtests01';
const SES = 'ah_ses_FAKEsessionKEYforHARDENED0001';
const SES2 = 'ah_ses_FAKEsessionKEYforHARDENED0002';
const tmp = [];
const mk = (p = 'cn-hard-') => { const d = mkdtempSync(join(tmpdir(), p)); tmp.push(d); return d; };
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
const pki = testCa('Hardened CA');

/** A stub hub: issues, renews and revokes turn tokens for the app key and session keys it knows, streams, and logs every request it saw. */
function stubHub() {
  const h = { seen: [], issued: new Set(), valid: new Set([SES, SES2]), n: 0, handovers: [], pickups: [], confirms: [] };
  h.server = https.createServer({ key: pki.leafKey, cert: pki.leafPem }, (req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const json = (s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
      let body = null; try { body = raw ? JSON.parse(raw) : null; } catch { /* not json */ }
      h.seen.push({ url: req.url, auth: req.headers.authorization, body });
      if (req.url === '/connector/v1/stream') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: orders\ndata: 1\n\n'); return setTimeout(() => res.end(), 50); }
      // A key handover (docs/onboarding.md): list, pickup with the new secret, confirm.
      if (req.url === '/onboard/pickup' || req.url === '/onboard/pickup/confirm') {
        if (req.headers.authorization !== `Bearer ${APP}`) return json(401, { error: 'unauthorized' });
        if (req.url === '/onboard/pickup') {
          const x = h.handovers.find((y) => y.id === body?.request_id && !y.done);
          if (!x) return json(404, { error: 'not_found' });
          h.pickups.push(x.id); x.pickup = `pku_${++h.n}`;
          return json(200, { pickup_id: x.pickup, kind: x.kind, team: null, agents: x.agents.map((a) => ({ ...a, secret: x.secret })) });
        }
        const x = h.handovers.find((y) => y.pickup === body?.pickup_id);
        if (!x) return json(409, { error: 'invalid_state' });
        h.confirms.push({ id: x.id, written: body.written }); x.done = true;
        return json(200, { request_id: x.id, state: 'collected' });
      }
      if (!req.url.startsWith('/connector/v1/')) return json(404, { error: 'not_found' });
      if (req.headers.authorization !== `Bearer ${APP}`) return json(401, { error: 'unauthorized' });
      if (req.url === '/connector/v1/handovers') return json(200, { handovers: h.handovers.filter((x) => !x.done).map(({ secret, pickup, done, ...x }) => x) });
      if (req.url === '/connector/v1/turn-tokens') {
        if (!h.valid.has(body?.session_key)) return json(401, { error: 'unauthorized' });
        const t = `tok-${++h.n}`; h.issued.add(t); return json(200, { token: t, agent_id: 'agent-1', label: 'Agent', expires_at: Date.now() + 900_000 });
      }
      if (req.url === '/connector/v1/turn-tokens/renew') return h.issued.has(body?.token) ? json(200, { expires_at: Date.now() + 900_000 }) : json(404, { error: 'unknown' });
      if (req.url === '/connector/v1/turn-tokens/revoke') { h.issued.delete(body?.token); return json(200, { ok: true }); }
      return json(200, { ok: true });
    });
  });
  return new Promise((r) => h.server.listen(0, '127.0.0.1', () => { h.origin = `https://127.0.0.1:${h.server.address().port}`; h.close = () => new Promise((x) => { h.server.closeAllConnections?.(); h.server.close(x); }); r(h); }));
}

/** A standard PC with one hub, two agents and one registered folder; and the places the service would use (temporary). */
function pc(hub) {
  const base = mk(), home = join(base, 'home'), folder = join(base, 'agent');
  mkdirSync(home); mkdirSync(folder);
  const hubKey = putHub(home, { hubId: 'hub-h', origin: hub.origin, caPem: pki.caPem, appKey: APP });
  putAgentKey(home, hubKey, 'dev-1', SES); putAgentKey(home, hubKey, 'dev-2', SES2);
  writeFileSync(join(home, 'conclave.mjs'), '');
  registerFolder(home, folder, { hubId: 'hub-h', caSha256: caFingerprint(pki.caPem), agent: 'dev-1', claudeJson: join(base, 'claude.json'), win: WIN });
  const root = join(base, 'machine');
  const address = WIN ? `\\\\.\\pipe\\cn-hard-${Date.now()}-${Math.random().toString(16).slice(2)}` : join(base, 'v.sock');
  const place = { id: 'test', root, dir: join(root, 'vault'), app: join(root, 'app'), view: join(root, 'view', 'keyview.json'), address };
  const appSource = join(base, 'src'); mkdirSync(appSource); writeFileSync(join(appSource, 'conclave.mjs'), '// copy');
  return { base, home, folder: canonicalFolder(folder), hubKey, place, appSource };
}

/** The install's options for a test: Linux commands recorded, the service started in this process. */
function opts(p, extra = {}) {
  const calls = [], h = { vault: null };
  return {
    calls, h, o: { platform: 'linux', place: p.place, appSource: p.appSource, isAdmin: () => true, writeFile: () => {}, waitMs: 20, pings: 5,
      exec: (cmd, args) => { calls.push([cmd, ...args].join(' ')); return { status: 0, stdout: '', stderr: '' }; },
      start: async () => { h.vault = await startVault({ dir: p.place.dir, view: p.place.view, address: p.place.address }); }, ...extra },
  };
}

/** Every file under `dir`, as text (the search of G6(a): what a process of the PC user can open). */
function everyFile(dir, out = []) {
  for (const f of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, f.name); if (f.isDirectory()) everyFile(p, out); else out.push(p); }
  return out;
}
const holds = (text, ...secrets) => secrets.some((s) => text.includes(s) || text.includes(Buffer.from(s).toString('base64').replace(/=+$/, '')) || text.includes(Buffer.from(s).toString('hex')));
/** What a process of the PC user can reach: its own folders (never the service's vault), its environment, and everything the service says. */
function reachable(p) {
  const text = [JSON.stringify(process.env)];
  for (const f of everyFile(p.home)) text.push(readFileSync(f, 'utf8') + f);
  for (const f of everyFile(join(p.place.root, 'view'))) text.push(readFileSync(f, 'utf8'));
  return text.join('\n');
}

describe('G6(a): can a process of the PC user read an agent key?', () => {
  test('at Standard it can (expected to fail there); at Hardened it cannot, by any way the user has', async () => {
    const hub = await stubHub();
    try {
      const p = pc(hub);
      // Standard: the connector's own key file gives the key to any process of this user.
      assert.equal(readKeyFile(p.home).data.hubs[p.hubKey].agents['dev-1'].session_key, SES, 'G6(a) fails at Standard, as documented');
      const { o, h } = opts(p);
      const r = await installVault(p.home, o);
      assert.equal(r.ok, true, JSON.stringify(r));
      try {
        assert.equal(readIsolation(p.home).level, 'hardened');
        // The same read now returns placeholders.
        const k = readKeyFile(p.home).data.hubs[p.hubKey];
        assert.equal(k.app_key, 'vault:app');
        assert.match(k.agents['dev-1'].session_key, /^vault:agent:dev-1:[0-9a-f]{8}$/);
        assert.ok(!existsSync(keyFilePath(p.home)), 'the user-level key file is gone');
        assert.equal(holds(reachable(p), APP, SES, SES2), false, 'no key in anything the user can open');
        // Every operation of the service, with good and bad input, and relayed calls, never answer with a key.
        const answers = [];
        for (const op of ['ping', 'view', 'nothing']) answers.push(JSON.stringify(await askVault(p.place.address, op, {})));
        answers.push(JSON.stringify(await askVault(p.place.address, 'scan', { path: join(p.base, 'none'), hubKey: p.hubKey })));
        answers.push(JSON.stringify(await askVault(p.place.address, 'scan', { path: 1, hubKey: 'x' })));
        const hubC = connect(k).hub;
        for (const path of ['/connector/v1/turn-tokens', '/connector/v1/other', '/api/secret']) {
          const x = await request(hubC, 'POST', path, { body: { session_key: k.agents['dev-1'].session_key }, headers: { Authorization: `Bearer ${k.app_key}` } }).catch((e) => ({ err: e.reason }));
          answers.push(JSON.stringify(x));
        }
        assert.equal(holds(answers.join('\n'), APP, SES, SES2), false, 'no answer of the service carries a key');
        // A relayed call outside /connector/v1, /bridge and /mcp (or one climbing out with "..") is refused by the service: the hub never sees it.
        hub.seen.length = 0;
        for (const path of ['/api/secret', '/admin/keys', '/connector/v1/../api/secret', '/connector/v1x/turn-tokens', '/mcpx']) {
          const x = await request(hubC, 'POST', path, { body: { session_key: k.agents['dev-1'].session_key }, headers: { Authorization: `Bearer ${k.app_key}` } }).catch((e) => ({ err: e.reason }));
          assert.ok(x.status === 403 || x.status === 404 || x.err, `refused: ${path} (${JSON.stringify(x).slice(0, 80)})`);
          assert.notEqual(x.status, 200, path);
        }
        assert.deepEqual(hub.seen.map((q) => q.url), [], 'none of those reached the hub');
        // The service may not be made to put a key anywhere else: only the Authorization header and a session_key value are substituted.
        hub.seen.length = 0;
        const echo = await request(hubC, 'POST', '/connector/v1/echo', { body: { note: 'vault:app', also: k.agents['dev-1'].session_key, nested: { session_key: 'vault:agent:nope:00000000' } }, headers: { Authorization: `Bearer ${k.app_key}`, 'x-note': 'Bearer vault:app' } });
        assert.equal(echo.status, 400, 'a placeholder naming an agent the service does not know is refused');
        await request(hubC, 'POST', '/connector/v1/echo', { body: { note: 'vault:app', also: k.agents['dev-1'].session_key }, headers: { 'x-note': 'Bearer vault:app', Authorization: `Bearer ${k.app_key}` } });
        const seen = hub.seen.at(-1);
        assert.equal(seen.auth, `Bearer ${APP}`, 'the hub got the real app key in the header');
        assert.equal(seen.body.note, 'vault:app', 'a placeholder in any other place stays text');
        assert.equal(seen.body.also, k.agents['dev-1'].session_key, 'and is not turned into a key');
      } finally { await h.vault?.close(); }
    } finally { await hub.close(); }
  });
  test('the probe on the real PC: a refused vault folder, a clean view, an answering service', async () => {
    const hub = await stubHub();
    try {
      const p = pc(hub);
      const { o, h } = opts(p);
      assert.equal((await installVault(p.home, o)).ok, true);
      try {
        const eacces = Object.assign(new Error('denied'), { code: 'EACCES' });
        const fsx = { readdirSync: () => { throw eacces; }, readFileSync: (f, enc) => (enc ? readFileSync(f, enc) : (() => { throw eacces; })()) };
        const ok = await g6aProbe(p.home, { fsx });
        assert.equal(ok.ok, true, JSON.stringify(ok));
        const open = await g6aProbe(p.home, { fsx: { readdirSync, readFileSync } });
        assert.equal(open.ok, false, 'a vault folder this user can open fails the probe');
        assert.equal(open.steps[0].ok, false);
      } finally { await h.vault?.close(); }
      assert.equal((await g6aProbe(p.home, { fsx: { readdirSync: () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); }, readFileSync } })).steps.at(-1).ok, false, 'a stopped service fails');
      assert.equal((await g6aProbe(pc(hub).home)).ok, false, 'at Standard the probe says it is expected to fail');
    } finally { await hub.close(); }
  });
});

describe('turn tokens through the service', () => {
  test('the broker, the push stream and a revoke work with placeholders only; the hub sees the real keys', async () => {
    const hub = await stubHub();
    try {
      const p = pc(hub);
      const { o, h } = opts(p);
      assert.equal((await installVault(p.home, o)).ok, true);
      try {
        approveFolderByConnector(p.home, p.folder, (await import('./connector/registry.mjs')).resolveFolder(p.home, p.folder).binding);
        const b = await startBroker({ home: p.home, deps: { renewMs: 3_600_000 } });
        try {
          const a = await askBroker(p.home, { op: 'turn', folder: p.folder, pid: process.pid }, { address: b.address });
          assert.equal(a.ok, true, JSON.stringify(a));
          assert.match(a.token, /^tok-/);
          assert.equal(holds(JSON.stringify(a), APP, SES), false, 'the broker answers with a token, never a key');
          const turn = hub.seen.find((s) => s.url === '/connector/v1/turn-tokens');
          assert.equal(turn.auth, `Bearer ${APP}`); assert.equal(turn.body.session_key, SES, 'the hub received the real keys');
          await b.renewAll();
          assert.ok(hub.seen.some((s) => s.url.endsWith('/renew') && s.auth === `Bearer ${APP}`), 'a renewal goes through the service');
          const bad = await askBroker(p.home, { op: 'probe', folder: p.folder }, { address: b.address });
          assert.equal(bad.ok, true);
          // The transcript scan: a key in a transcript is found (a yes or no from the service), a clean one is not.
          const tr = join(p.base, 'chat.jsonl'); writeFileSync(tr, `{"text":"here is ${SES}"}\n`);
          const r = b.runs.get(process.pid); r.transcript = tr;
          await b.endRun(r);
          assert.ok(hub.seen.some((s) => s.url.endsWith('/revoke') && s.body.reason === 'leak_found'), 'the leak is found through the service and the token revoked');
        } finally { await b.close(); }
        // The push stream is relayed too.
        const k = readKeyFile(p.home).data.hubs[p.hubKey];
        let got = 0;
        const end = await openStream(connect(k).hub, { headers: { Authorization: `Bearer ${k.app_key}` }, onOrders: () => { got++; } });
        assert.equal(end.status, 200); assert.ok(got >= 1);
        // A stopped service is a fixed reason, not a hang, and not a fall back to a key.
        await h.vault.close(); h.vault = null;
        const r2 = await request(connect(k).hub, 'POST', '/connector/v1/turn-tokens', { body: { session_key: k.agents['dev-1'].session_key } }).catch((e) => ({ reason: e.reason }));
        assert.ok(r2.reason === 'hub_unreachable' || r2.status !== 200);
      } finally { await h.vault?.close(); }
    } finally { await hub.close(); }
  });
  test('a new agent key (a collected rotation) goes in through the real service process and shows as a new placeholder', async () => {
    const hub = await stubHub();
    let child = null;
    try {
      const p = pc(hub);
      const { o } = opts(p, {
        pings: 100, waitMs: 100,
        // The service as the service manager would run it: a separate process (the key file's writers are synchronous and wait for it).
        start: async () => { child = spawn(process.execPath, [CLI, 'vault', 'run', '--vault', p.place.dir, '--view', p.place.view, '--address', p.place.address], { stdio: 'ignore' }); },
      });
      const r = await installVault(p.home, o);
      assert.equal(r.ok, true, JSON.stringify(r));
      const before = readKeyFile(p.home).data.hubs[p.hubKey].agents['dev-1'].session_key;
      putAgentKey(p.home, p.hubKey, 'dev-1', 'ah_ses_FAKEsessionKEYforHARDENEDrotated1');
      const after2 = readKeyFile(p.home).data.hubs[p.hubKey].agents['dev-1'].session_key;
      assert.notEqual(after2, before, 'a rotation changes the tag');
      assert.equal(holds(reachable(p), 'rotated1'), false, 'the new key is nowhere the user can read');
      assert.throws(() => putAgentKey(p.home, 'no-such-hub', 'dev-1', 'ah_ses_FAKEsessionKEYforHARDENEDrotated2'), (e) => e.reason !== undefined);
      // A key handover's rotated key: staged beside the old one (not in the view, not readable), swapped in only at commit.
      stageAgentKey(p.home, p.hubKey, 'obr_h1', 'dev-1', 'ah_ses_stagedKEYid01_FAKEsecretSTAGED');
      assert.equal(readKeyFile(p.home).data.hubs[p.hubKey].agents['dev-1'].session_key, after2, 'the old key stays until commit');
      assert.equal(readKeyFile(p.home).data.hubs[p.hubKey].staged, undefined, 'the view never shows a staged key');
      assert.equal(holds(reachable(p), 'FAKEsecretSTAGED'), false);
      assert.equal(labelHoldingKey(p.home, p.hubKey, 'stagedKEYid01'), null);
      assert.equal(commitStaged(p.home, p.hubKey, 'obr_h1'), 1);
      assert.notEqual(readKeyFile(p.home).data.hubs[p.hubKey].agents['dev-1'].session_key, after2, 'swapped in');
      assert.equal(labelHoldingKey(p.home, p.hubKey, 'stagedKEYid01'), 'dev-1', 'a label, never the key');
      assert.equal(discardStaged(p.home, p.hubKey, 'obr_h1'), false, 'nothing left to drop');
      assert.equal(holds(reachable(p), 'FAKEsecretSTAGED'), false);
      // A Disconnect with remote cleanup off: marked through the service, shown in the view the worker reads, once; pairing again clears it.
      assert.equal(markDisconnected(p.home, p.hubKey, '2026-11-21T01:00:00.000Z'), true);
      assert.equal(readKeyFile(p.home).data.hubs[p.hubKey].disconnected_at, '2026-11-21T01:00:00.000Z');
      assert.equal(markDisconnected(p.home, p.hubKey), false, 'already marked');
      assert.equal(markDisconnected(p.home, 'no-such-hub'), false);
      assert.equal(holds(reachable(p), APP, SES), false, 'the mark brings no key into reach');
      putHub(p.home, { hubId: 'hub-h', origin: hub.origin, caPem: pki.caPem, appKey: APP });
      assert.equal(readKeyFile(p.home).data.hubs[p.hubKey].disconnected_at, undefined, 'pairing again clears it');
    } finally { child?.kill(); await new Promise((r) => setTimeout(r, 100)); await hub.close(); }
  });
});

describe('a key handover on a hardened PC', () => {
  test('still waits for the PC user\'s click, and the new key goes in through the key service, never where the user can read it', async () => {
    const hub = await stubHub();
    let child = null;
    try {
      const p = pc(hub);
      const { o } = opts(p, { pings: 100, waitMs: 100,
        start: async () => { child = spawn(process.execPath, [CLI, 'vault', 'run', '--vault', p.place.dir, '--view', p.place.view, '--address', p.place.address], { stdio: 'ignore' }); } });
      assert.equal((await installVault(p.home, o)).ok, true);
      assert.equal(readIsolation(p.home).level, 'hardened');
      // An agent whose key the hub rotates: its key is in the service (put after Hardened went on).
      putAgentKey(p.home, p.hubKey, 'dev-3', 'ah_ses_hardoldkey01_FAKEsecretOLDKEY');
      const before = readKeyFile(p.home).data.hubs[p.hubKey].agents['dev-3'].session_key;
      assert.match(before, /^vault:agent:dev-3:/);
      hub.handovers = [{ id: 'obr_hard', kind: 'rotate', description: 'New key for dev-3 (rotation)', expires_at: Date.now() + 86_400_000, secret: 'ah_ses_hardnewkey01_FAKEsecretNEWKEY',
        agents: [{ agent_id: 'agent-3', label: 'dev-3', role: 'developer', team_role: 'worker', session_var: 'CONCLAVE_DEV3_SESSION_KEY', folder: 'dev-3', key_id: 'hardoldkey01', instructions: '' }] }];
      const run = () => runHandovers(p.home, p.hubKey, { claudeJson: join(p.base, 'claude.json'), gitBin: null, node: process.execPath, connector: join(p.home, 'conclave.mjs'), root: p.base });
      // Hardened changes nothing about consent: no pickup until the PC user allows it on the connector's screen.
      assert.deepEqual((await run()).handovers.map((x) => [x.phase, x.pickup_click]), [['waiting', true]]);
      assert.deepEqual(hub.pickups, []);
      const waiting = pendingList(p.home).pickups;
      assert.deepEqual(waiting.map((x) => x.what), ['New key for dev-3 (rotation)']);
      approvePickup(p.home, waiting[0].key);
      const r = await run();
      assert.equal(r.handovers[0].phase, 'confirmed', JSON.stringify(r));
      assert.deepEqual(hub.pickups, ['obr_hard']);
      assert.deepEqual(hub.confirms, [{ id: 'obr_hard', written: ['CONCLAVE_DEV3_SESSION_KEY'] }]);
      assert.equal(hub.seen.filter((s) => s.url.startsWith('/onboard/pickup')).every((s) => s.auth === `Bearer ${APP}`), true, 'the service sent the real app key');
      // The new key went to the service: the view shows a new placeholder for the same label, and the secret is nowhere the user can read.
      const after2 = readKeyFile(p.home).data.hubs[p.hubKey].agents['dev-3'].session_key;
      assert.match(after2, /^vault:agent:dev-3:/);
      assert.notEqual(after2, before, 'swapped in');
      assert.equal(labelHoldingKey(p.home, p.hubKey, 'hardnewkey01'), 'dev-3');
      assert.equal(holds(reachable(p), 'FAKEsecretNEWKEY', 'FAKEsecretOLDKEY'), false);
      assert.equal(existsSync(keyFilePath(p.home)), false, 'no user key file came back');
    } finally { child?.kill(); await new Promise((r) => setTimeout(r, 100)); await hub.close(); }
  });
  test('the relayed pickup answer holds references, never a key; a reference is taken once, for its own hub only', async () => {
    const hub = await stubHub();
    try {
      const p = pc(hub);
      const { o, h } = opts(p);
      assert.equal((await installVault(p.home, o)).ok, true);
      try {
        hub.handovers = [{ id: 'obr_ref', kind: 'rotate', description: 'x', expires_at: Date.now() + 86_400_000, secret: 'ah_ses_refnewkey001_FAKEsecretREFKEY',
          agents: [{ agent_id: 'agent-1', label: 'dev-1', session_var: 'CONCLAVE_DEV1_SESSION_KEY', folder: 'dev-1', key_id: null }] }];
        const k = readKeyFile(p.home).data.hubs[p.hubKey];
        const r = await request(connect(k).hub, 'POST', '/onboard/pickup', { body: { request_id: 'obr_ref' }, headers: { Authorization: `Bearer ${k.app_key}` } });
        assert.equal(r.status, 200);
        const text = JSON.stringify(r.json);
        assert.doesNotMatch(text, /FAKEsecretREFKEY|ah_ses_/);
        const ref = r.json.agents[0].secret;
        assert.match(ref, /^vault:pickup:[0-9a-f]{32}$/);
        // Another hub cannot take it, nor a made-up reference; the right hub takes it once.
        assert.deepEqual(await askVault(p.place.address, 'stage_agent', { hubKey: 'other-hub', handoverId: 'obr_ref', label: 'dev-1', sessionKey: ref }), { ok: false, reason: 'pickup_expired' });
        assert.equal((await askVault(p.place.address, 'stage_agent', { hubKey: p.hubKey, handoverId: 'obr_ref', label: 'dev-1', sessionKey: `vault:pickup:${'0'.repeat(32)}` })).ok, false);
        assert.deepEqual(await askVault(p.place.address, 'stage_agent', { hubKey: p.hubKey, handoverId: 'obr_ref', label: 'dev-1', sessionKey: ref }), { ok: true });
        assert.equal((await askVault(p.place.address, 'put_agent', { hubKey: p.hubKey, label: 'dev-9', sessionKey: ref })).ok, false, 'spent');
        assert.equal((await askVault(p.place.address, 'commit_staged', { hubKey: p.hubKey, handoverId: 'obr_ref' })).committed, 1);
        assert.equal((await askVault(p.place.address, 'label_for_key', { hubKey: p.hubKey, keyId: 'refnewkey001' })).label, 'dev-1');
        assert.equal(holds(reachable(p), 'FAKEsecretREFKEY'), false);
        // The references are capped: past PICKUP_REFS_MAX the oldest is dropped, and a dropped one is refused.
        const many = Array.from({ length: PICKUP_REFS_MAX + 1 }, (_, i) => ({ agent_id: `agent-m${i}`, label: `m-${i}`, session_var: `CONCLAVE_M${i}_SESSION_KEY`, folder: `m-${i}`, key_id: null }));
        hub.handovers.push({ id: 'obr_many', kind: 'add_agents', description: 'x', expires_at: Date.now() + 86_400_000, secret: 'ah_ses_manynewkey01_FAKEsecretMANY', agents: many });
        const m = await request(connect(k).hub, 'POST', '/onboard/pickup', { body: { request_id: 'obr_many' }, headers: { Authorization: `Bearer ${k.app_key}` } });
        assert.equal(m.json.agents.length, PICKUP_REFS_MAX + 1);
        assert.deepEqual(await askVault(p.place.address, 'stage_agent', { hubKey: p.hubKey, handoverId: 'obr_many', label: 'm-0', sessionKey: m.json.agents[0].secret }), { ok: false, reason: 'pickup_expired' }, 'the oldest was dropped');
        assert.deepEqual(await askVault(p.place.address, 'stage_agent', { hubKey: p.hubKey, handoverId: 'obr_many', label: 'm-1', sessionKey: m.json.agents[1].secret }), { ok: true });
        // A refusal passes through as the hub said it (it holds no key).
        const no = await request(connect(k).hub, 'POST', '/onboard/pickup', { body: { request_id: 'obr_none' }, headers: { Authorization: `Bearer ${k.app_key}` } }).catch((e) => ({ status: e.status }));
        assert.equal(no.status, 404);
      } finally { await h.vault?.close(); }
    } finally { await hub.close(); }
  });
});

describe('run elevated: whose folder, and who owns what is written', () => {
  test('the PC user folder is found by --home, CONCLAVE_HOME, then SUDO_USER, never root by accident', () => {
    const passwd = (u) => (u === 'ana' ? '/home/ana' : null);
    assert.equal(serviceHome({ flag: '/x/conf', env: { SUDO_USER: 'ana' }, platform: 'linux', passwd }).source, '--home');
    assert.equal(serviceHome({ env: { CONCLAVE_HOME: '/y/conf', SUDO_USER: 'ana' }, platform: 'linux', passwd }).source, 'CONCLAVE_HOME');
    const s = serviceHome({ env: { SUDO_USER: 'ana' }, platform: 'linux', passwd });
    assert.equal(s.source, 'SUDO_USER');
    assert.equal(s.home.split(String.fromCharCode(92)).join('/').replace(/^[A-Za-z]:/, ''), '/home/ana/.config/conclave');
    assert.equal(serviceHome({ env: { SUDO_USER: 'ghost' }, platform: 'linux', passwd }).source, 'this account', 'an unknown user falls back to the running account');
    assert.equal(serviceHome({ env: { SUDO_USER: 'root' }, platform: 'linux', passwd }).source, 'this account');
    assert.equal(serviceHome({ env: { SUDO_USER: 'ana' }, platform: 'win32', passwd }).source, 'this account', 'SUDO_USER means nothing on Windows');
  });

  test('switching off hands the restored key file, its secret, the marker and the folder back to the PC user', async () => {
    const hub = await stubHub();
    let H = null;
    try {
      const p = pc(hub);
      const { o, h } = opts(p); H = h;
      assert.equal((await installVault(p.home, { ...o, owner: { uid: 4242, gid: 4343 }, chown: () => {} })).ok, true);
      await h.vault.close(); h.vault = null;
      const chowned = [];
      const u = await uninstallVault(p.home, { platform: 'linux', place: p.place, isAdmin: () => true, owner: { uid: 4242, gid: 4343 }, chown: (path, uid, gid) => chowned.push([path, uid, gid]), exec: () => ({ status: 0, stdout: '', stderr: '' }) });
      assert.equal(u.ok, true, JSON.stringify(u));
      for (const f of [keyFilePath(p.home), masterPath(p.home)].filter((x) => existsSync(x))) assert.ok(chowned.some(([x, uid, gid]) => x === f && uid === 4242 && gid === 4343), f + ' is given back');
      assert.ok(chowned.some(([x]) => x === p.home), 'the folder too');
    } finally { await H?.vault?.close(); await hub.close(); }
  });

  test('installing hands the marker to the PC user; Windows changes no owner', async () => {
    const hub = await stubHub();
    let H = null;
    try {
      const p = pc(hub);
      const { o, h } = opts(p); H = h;
      const chowned = [];
      assert.equal((await installVault(p.home, { ...o, owner: { uid: 4242, gid: 4343 }, chown: (path) => chowned.push(path) })).ok, true);
      assert.ok(chowned.includes(markerPath(p.home)));
      assert.deepEqual(handBack(p.home, { platform: 'win32', owner: { uid: 1, gid: 1 }, chown: () => { throw new Error('no'); } }), []);
    } finally { await H?.vault?.close(); await hub.close(); }
  });
});

describe('install and uninstall', () => {
  test('uninstalling returns to Standard with every key back, none lost', async () => {
    const hub = await stubHub();
    try {
      const p = pc(hub);
      const orig = readKeyFile(p.home).data;
      const { o, h } = opts(p);
      assert.equal((await installVault(p.home, o)).ok, true);
      await h.vault.close();
      const calls = [];
      const u = await uninstallVault(p.home, { platform: 'linux', place: p.place, isAdmin: () => true, exec: (c, a) => { calls.push([c, ...a].join(' ')); return { status: 0, stdout: '', stderr: '' }; } });
      assert.equal(u.ok, true, JSON.stringify(u));
      assert.equal(u.agents, 2);
      assert.equal(readIsolation(p.home).level, 'standard');
      assert.deepEqual(readKeyFile(p.home).data, orig, 'every key is back, byte for byte');
      assert.ok(!existsSync(p.place.root), 'the service folder is removed');
      assert.ok(calls.some((c) => c.startsWith('systemctl disable --now')), 'the service is stopped and removed');
      assert.equal((await uninstallVault(p.home, { platform: 'linux', place: p.place, isAdmin: () => true, exec: () => ({ status: 0 }) })).already, true, 'again: nothing to do');
      // and the agents still sign in at Standard
      const k = readKeyFile(p.home).data.hubs[p.hubKey];
      const t = await request(connect(k).hub, 'POST', '/connector/v1/turn-tokens', { body: { session_key: k.agents['dev-2'].session_key }, headers: { Authorization: `Bearer ${k.app_key}` } });
      assert.equal(t.status, 200);
    } finally { await hub.close(); }
  });
  test('any failure rolls back: the user key file is untouched and no marker is left', async () => {
    const hub = await stubHub();
    try {
      for (const fail of ['sc create', 'chown', 'systemctl enable', 'never answers', 'cannot sign in through the relay']) {
        const p = pc(hub);
        const raw = readFileSync(keyFilePath(p.home), 'utf8');
        const { o, h, calls } = opts(p);
        let signIns = 0;
        if (fail === 'sc create') o.exec = (cmd, args) => { calls.push(cmd); return cmd === 'useradd' || args.join(' ').includes('useradd') ? { status: 1, stderr: 'no' } : { status: 0, stdout: '', stderr: '' }; };
        if (fail === 'chown') o.exec = (cmd) => (cmd === 'chown' ? { status: 1, stderr: 'no' } : { status: 0, stdout: '', stderr: '' });
        if (fail === 'systemctl enable') { o.start = undefined; o.exec = (cmd, args) => (args[0] === 'enable' ? { status: 1, stderr: 'no' } : { status: 0, stdout: '', stderr: '' }); }
        if (fail === 'never answers') o.start = async () => {};
        if (fail === 'cannot sign in through the relay') o.signInAll = async (d) => { signIns++; if (signIns === 1) return { ok: true }; return { ok: false, reason: 'login_refused', label: 'dev-1' }; };
        const r = await installVault(p.home, o);
        await h.vault?.close();
        assert.equal(r.ok, false, fail); assert.equal(r.rolled_back, true, fail);
        assert.equal(readFileSync(keyFilePath(p.home), 'utf8'), raw, `${fail}: the key file is as it was`);
        assert.equal(readIsolation(p.home).level, 'standard', fail);
        assert.equal(readKeyFile(p.home).data.hubs[p.hubKey].agents['dev-1'].session_key, SES, fail);
        assert.ok(!existsSync(p.place.root), `${fail}: nothing is left in the service folder`);
      }
    } finally { await hub.close(); }
  });
  test('it never changes anything without administrator rights, or when an agent cannot sign in', async () => {
    const hub = await stubHub();
    try {
      const p = pc(hub);
      const { o } = opts(p);
      const n = await installVault(p.home, { ...o, isAdmin: () => false });
      assert.deepEqual(n, { ok: false, reason: 'needs_admin' });
      hub.valid.delete(SES2);
      const bad = await installVault(p.home, o);
      assert.equal(bad.reason, 'agent_cannot_sign_in'); assert.ok(!existsSync(p.place.root));
      assert.equal(readIsolation(p.home).level, 'standard');
    } finally { await hub.close(); }
  });
});

describe('the platform commands (pure)', () => {
  test('Windows: a virtual account, an owner-only vault folder, a service host built from source, and the install is admin-only', () => {
    const s = vaultSpec('C:\\Users\\x\\.config\\conclave', { platform: 'win32', node: 'C:\\Program Files\\nodejs\\node.exe', place: vaultPlace('C:\\Users\\x\\.config\\conclave', { platform: 'win32', programData: 'C:\\ProgramData' }) });
    const all = [...s.create, ...s.secure, ...s.start].map((c) => [c[1], ...c[2]].join(' '));
    assert.ok(all.some((c) => c.includes('create Conclave') && c.includes('obj= NT SERVICE\\Conclave') && c.includes('"vault" "run"')));
    assert.ok(all.some((c) => c.startsWith('icacls') && c.includes('/inheritance:r') && c.includes('NT SERVICE\\Conclave:(OI)(CI)F') && !c.includes('Users')), 'the vault folder is the service, SYSTEM and administrators only');
    assert.ok(all.some((c) => c.includes('view') && c.includes('BUILTIN\\Users:(OI)(CI)R')), 'only the public view is readable by users');
    assert.ok(all.some((c) => c.includes('Add-Type') && c.includes('ConsoleApplication')), 'the service host is compiled on the PC, nothing is downloaded');
    assert.match(HOST_SOURCE, /ServiceBase/);
    assert.match(s.place.address, /^\\\\\.\\pipe\\conclave-vault-/);
  });
  test('Linux: a system user, a private vault folder, a hardened unit; macOS has no hardened level', () => {
    const s = vaultSpec('/home/x/.config/conclave', { platform: 'linux', node: '/usr/bin/node' });
    const all = [...s.create, ...s.secure].map((c) => [c[1], ...c[2]].join(' '));
    assert.ok(all.some((c) => c.includes('useradd --system') && c.includes('nologin')));
    assert.ok(all.some((c) => c.startsWith('chmod 0700') && c.includes('/vault')));
    assert.match(s.files[0].text, /User=conclave/); assert.match(s.files[0].text, /NoNewPrivileges=true/); assert.match(s.files[0].text, /ProtectHome=true/);
    assert.equal(vaultSpec('/h', { platform: 'darwin' }), null);
  });
  test('the public view has the same shape as the key file, with placeholders only', () => {
    const v = publicView({ version: 1, hubs: { k: { hub_id: 'h', origin: 'https://a:1', ca_sha256: 'c'.repeat(64), ca_pem: 'PEM', app_key: APP, agents: { a1: { session_key: SES } } } } }, 'addr');
    assert.equal(holds(JSON.stringify(v), APP, SES), false);
    assert.equal(v.hubs.k.relay.address, 'addr');
    assert.equal(v.hubs.k.disconnected_at, undefined);
    const m = publicView({ version: 1, hubs: { k: { hub_id: 'h', origin: 'https://a:1', ca_sha256: 'c'.repeat(64), ca_pem: 'PEM', app_key: APP, agents: {}, disconnected_at: '2026-11-21T01:00:00.000Z' } } }, 'addr');
    assert.equal(m.hubs.k.disconnected_at, '2026-11-21T01:00:00.000Z', 'a disconnect mark is shown to the worker');
  });
});

test('the transcript scan keeps working for key-shaped text with no exact key', () => {
  const d = mk(), f = join(d, 't.txt'); writeFileSync(f, 'x ah_ses_abcdefghijkl_abcdefghijklmnop2 y');
  assert.equal(scanTranscript(f, []).found, true);
});
