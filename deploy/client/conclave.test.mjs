/**
 * Tests for the Conclave connector core (deploy/client/conclave.mjs and connector/*), run with `npm run test:helper` in
 * server/ (plain node:test, works on Windows). Nothing touches the real ~/.config/conclave, ~/.claude.json or any hub:
 * every case uses a temporary CONCLAVE_HOME, a temporary Claude config and a stub hub on 127.0.0.1 with throwaway
 * certificates made by `openssl` at start (the TLS cases are skipped, and say so, if openssl is not on this PC).
 * Keys here are fake.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import https from 'node:https';
import { createServer as createNet } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync, readdirSync, statSync, symlinkSync, renameSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { putHub, putAgentKey, removeAgentKey, removeHub, readKeyFile, findHub, describe as describeKeys, caFingerprint, normalizeOrigin, hubKeyOf, keyFilePath } from './connector/keyfile.mjs';
import { bindFolder, resolveFolder, registryPath, configHash, rerecord } from './connector/registry.mjs';
import { readToken, writeToken, invalidate, invalidateHub, invalidateAll, countTokens } from './connector/tokens.mjs';
import { connect, post, callTool } from './connector/hubclient.mjs';
import { decide, applyTrust, grantTrust, trustStatus } from './connector/trust.mjs';
import { mcpEntry, codexToml, entryState, writeMcpEntry, approveInSettings, gitPath, nodePath } from './connector/entries.mjs';
import { validateEntry, record, undoDecision, entries, noRedirect } from './connector/manifest.mjs';
import { registerFolder, repairFolder } from './connector/register.mjs';
import { runCheck } from './connector/check.mjs';
import { speakUp, withRequestId } from './connector/mcpserver.mjs';
import { runHook } from './connector/hook.mjs';
import { startBroker, askBroker, brokerAddress } from './connector/broker.mjs';
import { brokerSecretPath, brokerProof } from './connector/brokerclient.mjs';
import { connect as netConnect } from 'node:net';
import { pendingList, approveFolder as allowFolder, approveFolderByConnector } from './connector/approvals.mjs';
process.env.CONCLAVE_KEY_STORE = 'file'; // tests keep the key file's secret in a private file: no PowerShell, keychain or secret service
import { line, REASONS, ORDER } from './connector/reasons.mjs';
import { canonicalFolder, folderIdentity, WIN } from './connector/paths.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'conclave.mjs');
const APP = 'ah_app_FAKEappKEYforCONNECTORtests01';
const SES = 'ah_ses_FAKEsessionKEYforCONNECTOR0001';
const SES2 = 'ah_ses_FAKEsessionKEYforCONNECTOR0002';
const tmp = [];
const mk = (p = 'conclave-test-') => { const d = mkdtempSync(join(tmpdir(), p)); tmp.push(d); return d; };
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });

// ───────────── throwaway certificates ─────────────
function findOpenssl() {
  for (const c of ['openssl', 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe', 'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe']) {
    try { execFileSync(c, ['version'], { stdio: 'ignore' }); return c; } catch { /* next */ }
  }
  return null;
}
const OPENSSL = findOpenssl();
const tlsOpts = { skip: OPENSSL ? false : 'openssl is not available on this PC' };
function makePki(name) {
  const d = mk('conclave-pki-');
  const o = (...a) => execFileSync(OPENSSL, a, { cwd: d, stdio: 'ignore' });
  o('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', `/CN=${name}`, '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign');
  o('req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 's.key', '-out', 's.csr', '-subj', '/CN=localhost');
  writeFileSync(join(d, 'ext.cnf'), 'subjectAltName=IP:127.0.0.1,DNS:localhost\nbasicConstraints=CA:FALSE\n');
  o('x509', '-req', '-in', 's.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 's.pem', '-days', '2', '-extfile', 'ext.cnf');
  return { ca: readFileSync(join(d, 'ca.pem'), 'utf8'), cert: readFileSync(join(d, 's.pem'), 'utf8'), key: readFileSync(join(d, 's.key'), 'utf8') };
}

/** A stub hub over HTTPS: logs in the session keys in `valid`, answers whoami for the tokens it issued, relays a few tools. */
function stubHub(pki, { valid = new Set([SES]), appKey = APP } = {}) {
  const hub = { requests: [], issued: new Set(), valid, rejectAll401: false, redirect: null, n: 0 };
  hub.server = https.createServer({ key: pki.key, cert: pki.cert }, (req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const msg = JSON.parse(raw);
      const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.url.startsWith('/connector/v1/turn-tokens')) {
        // The connector's broker, signed in with the app key: issue, renew and revoke a turn token.
        const act = req.url.slice('/connector/v1/turn-tokens'.length).replace(/^\//, '') || 'issue';
        hub.requests.push({ tool: 'turn_' + act, args: msg, auth: req.headers.authorization, session: null });
        if (hub.redirect) { res.writeHead(307, { location: hub.redirect }); return res.end(); }
        if (req.headers.authorization !== `Bearer ${appKey}`) return json(401, { error: 'unauthorized' });
        if (act === 'issue') {
          if (!hub.valid.has(msg.session_key)) return json(401, { error: 'unauthorized' });
          const t = `tok-${++hub.n}`; hub.issued.add(t); return json(200, { token: t, agent_id: 'agent-1', label: 'Stub agent', expires_at: Date.now() + 900_000 });
        }
        if (act === 'renew') { if (!hub.issued.has(msg.token)) return json(404, { error: 'unknown' }); hub.renewed = (hub.renewed ?? 0) + 1; return json(200, { expires_at: Date.now() + 900_000 }); }
        if (act === 'revoke') { hub.issued.delete(msg.token); (hub.revoked ??= []).push({ token: msg.token, reason: msg.reason }); return json(200, { ok: true }); }
        return json(404, { error: 'unknown' });
      }
      const tool = msg.method === 'tools/call' ? msg.params.name : msg.method;
      hub.requests.push({ tool, args: msg.params?.arguments, auth: req.headers.authorization, session: req.headers['x-agent-hub-session'] });
      if (hub.redirect) { res.writeHead(307, { location: hub.redirect }); return res.end(); }
      const ok = (result) => json(200, { jsonrpc: '2.0', id: msg.id, result });
      // A session holds a turn token only: no app key on the way to /mcp.
      const tok = req.headers['x-agent-hub-session'];
      if (hub.rejectAll401 || !hub.issued.has(tok)) return json(401, { error: 'unauthorized' });
      if (tool === 'session_whoami') return ok({ content: [], structuredContent: { agent_id: 'agent-1' } });
      if (tool === 'initialize') return ok({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '0' } });
      if (tool === 'tools/list') return ok({ tools: [{ name: 'session_whoami', inputSchema: { type: 'object' } }] });
      if (msg.method === 'notifications/initialized') { res.writeHead(202); return res.end(); }
      return ok({ content: [{ type: 'text', text: 'ok' }], structuredContent: { echoed: msg.params.arguments ?? null } });
    });
  });
  return new Promise((res) => hub.server.listen(0, '127.0.0.1', () => { hub.origin = `https://127.0.0.1:${hub.server.address().port}`; hub.close = () => new Promise((r) => hub.server.close(r)); res(hub); }));
}

/** A fresh connector home with one hub section and one registered agent folder (spaces in both paths). */
function setup(pki, hub, { label = 'dev-1', hubId = 'hub-one', key = SES } = {}) {
  const base = mk();
  const home = join(base, 'conclave home');
  mkdirSync(home, { recursive: true });
  const folder = join(base, 'agent folder');
  mkdirSync(folder);
  const hubKey = putHub(home, { hubId, origin: hub.origin, caPem: pki.ca, appKey: APP });
  putAgentKey(home, hubKey, label, key);
  writeFileSync(join(home, 'conclave.mjs'), ''); // the entry names the connector by absolute path, and it must exist
  const claudeJson = join(base, 'claude.json');
  const ca = caFingerprint(pki.ca);
  registerFolder(home, folder, { hubId, caSha256: ca, agent: label, claudeJson, win: WIN });
  return { base, home, folder: canonicalFolder(folder), hubKey, claudeJson, ca, label, hubId };
}

/** The connector's broker for a test home (the worker starts it in a real connector); every session of that home asks it for its token. */
const broker = async (s, { clicks = false, ...deps } = {}) => {
  // Most cases are about the relay, not the click: the folder is allowed as if the PC user had clicked. `clicks: true` leaves it waiting.
  if (!clicks) approveFolderByConnector(s.home, s.folder, resolveFolder(s.home, s.folder).binding);
  return startBroker({ home: s.home, deps: { renewMs: 3_600_000, ...deps } });
};
const withBroker = async (s, fn, deps) => { const b = await broker(s, deps); try { return await fn(b); } finally { await b.close(); } };

/** Runs `conclave mcp` against `s`, writes the messages, and returns the parsed stdout lines, stderr and the log. */
function runMcp(s, folder, msgs, env = {}) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, 'mcp', folder], { env: { ...process.env, CONCLAVE_HOME: s.home, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => {
      const lines = out.split('\n').filter(Boolean);
      const logPath = join(s.home, 'connector.log');
      resolve({ code, out, err, lines, msgs: lines.map((l) => JSON.parse(l)), log: existsSync(logPath) ? readFileSync(logPath, 'utf8') : '' });
    });
    for (const m of msgs) c.stdin.write(JSON.stringify(m) + '\n');
    c.stdin.end();
  });
}
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } };
const LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
const call = (id, name, args = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const noSecrets = (r, ...extra) => { for (const v of [APP, SES, SES2, ...extra]) for (const t of [r.out, r.err, r.log]) assert.ok(!t.includes(v), 'a key must never appear in output or log'); };

// ───────────── key file ─────────────
describe('key file', () => {
  const pem = OPENSSL ? makePki('Keyfile CA').ca : null;
  test('one section per hub, keyed by hub identity and CA fingerprint; nothing secret in what is described', tlsOpts, () => {
    const home = mk();
    const k = putHub(home, { hubId: 'hub-one', origin: 'https://10.0.0.5:8443', caPem: pem, appKey: APP });
    putAgentKey(home, k, 'dev-1', SES);
    assert.equal(k, hubKeyOf('hub-one', caFingerprint(pem)));
    const r = readKeyFile(home);
    assert.ok(r.ok);
    assert.deepEqual(Object.keys(r.data.hubs), [k]);
    const d = JSON.stringify(describeKeys(r.data));
    assert.ok(!d.includes(APP) && !d.includes(SES) && d.includes('dev-1'));
    if (!WIN) assert.equal(statSync(keyFilePath(home)).mode & 0o777, 0o600);
  });
  test('the same hub id under another CA is another section; a lookup never falls back', tlsOpts, () => {
    const home = mk();
    const other = makePki('Keyfile CA 2').ca;
    const k = putHub(home, { hubId: 'hub-one', origin: 'https://10.0.0.5:8443', caPem: pem, appKey: APP });
    const data = readKeyFile(home).data;
    assert.ok(findHub(data, 'hub-one', caFingerprint(pem)).ok);
    assert.deepEqual(findHub(data, 'hub-one', caFingerprint(other)), { ok: false, reason: 'ca_changed' });
    assert.deepEqual(findHub(data, 'hub-two', caFingerprint(pem)), { ok: false, reason: 'no_hub_key' });
    putHub(home, { hubId: 'hub-one', origin: 'https://10.0.0.5:8443', caPem: other, appKey: APP });
    assert.equal(Object.keys(readKeyFile(home).data.hubs).length, 2, 'a new CA is a new section, the old one is not replaced');
    assert.ok(removeHub(home, k));
    assert.equal(Object.keys(readKeyFile(home).data.hubs).length, 1);
  });
  test('plain http, credentials, a path, a bad CA and bad names are refused', tlsOpts, () => {
    const home = mk();
    for (const origin of ['http://10.0.0.5:8080', 'https://u:p@10.0.0.5', 'https://10.0.0.5/mcp', 'https://10.0.0.5?x=1', 'ftp://x', 'nonsense']) {
      assert.throws(() => putHub(home, { hubId: 'h', origin, caPem: pem, appKey: APP }), /https|origin/, origin);
      assert.equal(normalizeOrigin(origin), null);
    }
    assert.throws(() => putHub(home, { hubId: 'h', origin: 'https://10.0.0.5', caPem: 'not a cert', appKey: APP }), /CA/);
    assert.throws(() => putHub(home, { hubId: 'bad id!', origin: 'https://10.0.0.5', caPem: pem, appKey: APP }), /hub id/);
    const k = putHub(home, { hubId: 'h', origin: 'https://10.0.0.5', caPem: pem, appKey: APP });
    assert.throws(() => putAgentKey(home, k, '../x', SES), /label/);
    assert.equal(normalizeOrigin('https://10.0.0.5:8443/'), 'https://10.0.0.5:8443');
  });
  test('an unreadable file and (on macOS and Linux) a loose one are refused with a fixed reason', tlsOpts, () => {
    const home = mk();
    writeFileSync(keyFilePath(home), '{not json', { mode: 0o600 });
    if (!WIN) chmodSync(keyFilePath(home), 0o600);
    assert.deepEqual(readKeyFile(home), { ok: false, reason: 'keyfile_unreadable' });
    writeFileSync(keyFilePath(home), JSON.stringify({ version: 1, hubs: {} }), { mode: 0o644 });
    if (!WIN) { chmodSync(keyFilePath(home), 0o644); assert.deepEqual(readKeyFile(home), { ok: false, reason: 'keyfile_unsafe' }); }
    rmSync(keyFilePath(home));
    assert.deepEqual(readKeyFile(home), { ok: true, data: { version: 1, hubs: {} } }, 'no file is an empty one');
  });
  test('removing an agent key removes only that agent', tlsOpts, () => {
    const home = mk();
    const k = putHub(home, { hubId: 'h', origin: 'https://10.0.0.5', caPem: pem, appKey: APP });
    putAgentKey(home, k, 'a', SES); putAgentKey(home, k, 'b', SES2);
    assert.ok(removeAgentKey(home, k, 'a'));
    assert.deepEqual(Object.keys(readKeyFile(home).data.hubs[k].agents), ['b']);
    assert.equal(removeAgentKey(home, k, 'a'), false);
  });
});

// ───────────── registry: identity comes from the connector's own record ─────────────
describe('registry', () => {
  const H = { hubId: 'hub-one', caSha256: 'a'.repeat(64), agent: 'dev-1' };
  test('a registered folder resolves; a copy, a clone and a moved folder get no identity', () => {
    const base = mk(), home = join(base, 'h'), f = join(base, 'agent one');
    mkdirSync(f);
    bindFolder(home, f, H);
    assert.ok(resolveFolder(home, f).ok);
    cpSync(f, join(base, 'copy'), { recursive: true });
    assert.deepEqual(resolveFolder(home, join(base, 'copy')), { ok: false, reason: 'not_registered' });
    renameSync(f, join(base, 'moved'));
    assert.deepEqual(resolveFolder(home, join(base, 'moved')), { ok: false, reason: 'not_registered' });
    assert.deepEqual(resolveFolder(home, f), { ok: false, reason: 'not_registered' }, 'the old path no longer exists');
  });
  test("the folder's own files never decide identity, even a forged .agent-hub.json or .mcp.json", () => {
    const base = mk(), home = join(base, 'h'), f = join(base, 'a');
    mkdirSync(f);
    bindFolder(home, f, H);
    const c = join(base, 'clone');
    cpSync(f, c, { recursive: true });
    writeFileSync(join(c, '.agent-hub.json'), JSON.stringify({ session_var: 'DEV_1', url: 'https://hub-one.example/mcp' }));
    writeFileSync(join(c, '.mcp.json'), JSON.stringify({ mcpServers: { conclave: { command: 'x', args: [] } } }));
    assert.equal(resolveFolder(home, c).reason, 'not_registered');
  });
  test('the hub agent id is kept with the binding, and a re-registration without one keeps it', () => {
    const base = mk(), home = join(base, 'h'), f = join(base, 'a');
    mkdirSync(f);
    assert.equal(bindFolder(home, f, { ...H, agentId: 'agt_abc123' }).agent_id, 'agt_abc123');
    assert.equal(bindFolder(home, f, H).agent_id, 'agt_abc123');
    assert.equal(bindFolder(home, f, { ...H, agentId: 'bad id/..' }).agent_id, 'agt_abc123'); // a malformed id is not stored
  });
  test('a recorded path whose folder is no longer the same one is identity_changed', () => {
    const base = mk(), home = join(base, 'h'), f = join(base, 'a');
    mkdirSync(f);
    const b = bindFolder(home, f, H);
    if (b.identity === null) return; // this filesystem reports no identity: the path alone binds
    const reg = JSON.parse(readFileSync(registryPath(home), 'utf8'));
    reg.folders[Object.keys(reg.folders)[0]].identity = '0:1';
    writeFileSync(registryPath(home), JSON.stringify(reg));
    assert.deepEqual(resolveFolder(home, f), { ok: false, reason: 'identity_changed' });
  });
  test('the settings hash follows the folder and the connector can record its own change', () => {
    const base = mk(), home = join(base, 'h'), f = join(base, 'a');
    mkdirSync(f);
    bindFolder(home, f, H);
    const h0 = configHash(f);
    writeFileSync(join(f, 'CLAUDE.md'), 'new instructions');
    assert.notEqual(configHash(f), h0);
    assert.notEqual(resolveFolder(home, f).binding.config_sha256, configHash(f));
    rerecord(home, f);
    assert.equal(resolveFolder(home, f).binding.config_sha256, configHash(f));
  });
  test('invalid hub ids, fingerprints and labels are refused', () => {
    const base = mk(), f = join(base, 'a');
    mkdirSync(f);
    assert.throws(() => bindFolder(join(base, 'h'), f, { ...H, caSha256: 'xyz' }), /invalid/);
    assert.throws(() => bindFolder(join(base, 'h'), f, { ...H, agent: '../x' }), /invalid/);
    assert.throws(() => bindFolder(join(base, 'h'), join(base, 'nope'), H), /exist/);
  });
});

// ───────────── token caches ─────────────
describe('token caches', () => {
  test('namespaced by hub and agent; a rotated key drops the token; removal and migration drop them', () => {
    const home = mk();
    writeToken(home, 'hub-a@1', 'dev-1', SES, 'tok-a');
    writeToken(home, 'hub-b@2', 'dev-1', SES, 'tok-b');
    writeToken(home, 'hub-a@1', 'dev-2', SES, 'tok-c');
    assert.equal(readToken(home, 'hub-a@1', 'dev-1', SES), 'tok-a');
    assert.equal(readToken(home, 'hub-b@2', 'dev-1', SES), 'tok-b', 'the same agent label on another hub has its own token');
    assert.equal(readToken(home, 'hub-a@1', 'dev-2', SES), 'tok-c');
    assert.equal(readToken(home, 'hub-a@1', 'dev-1', SES2), null, 'a token issued for another key is not reused (rotation)');
    assert.equal(readToken(home, 'hub-a@1', 'dev-1', SES), null, '… and it was deleted');
    invalidate(home, 'hub-a@1', 'dev-2');
    assert.equal(readToken(home, 'hub-a@1', 'dev-2', SES), null);
    invalidateHub(home, 'hub-b@2');
    assert.equal(countTokens(home, 'hub-b@2'), 0);
    writeToken(home, 'hub-c@3', 'x', SES, 'tok');
    invalidateAll(home);
    assert.equal(readToken(home, 'hub-c@3', 'x', SES), null);
  });
  test('the cache file holds the token and a short tag, never the session key', () => {
    const home = mk();
    writeToken(home, 'hub-a@1', 'dev-1', SES, 'tok-a');
    const text = readdirSync(join(home, 'tokens'), { recursive: true }).filter((f) => f.endsWith('.json')).map((f) => readFileSync(join(home, 'tokens', f), 'utf8')).join('');
    assert.ok(text.includes('tok-a') && !text.includes(SES));
  });
  test('an agent label that is not a plain name cannot escape the cache folder', () => {
    assert.throws(() => writeToken(mk(), 'h', '../../x', SES, 't'), /label/);
  });
});

// ───────────── pinned HTTPS ─────────────
describe('pinned HTTPS', { concurrency: false }, () => {
  test('plain http never connects, and a section whose CA no longer matches its fingerprint is refused', tlsOpts, () => {
    const pki = makePki('Pin CA');
    const sec = { origin: 'http://127.0.0.1:1', ca_pem: pki.ca, ca_sha256: caFingerprint(pki.ca) };
    assert.deepEqual(connect(sec), { ok: false, reason: 'not_https' });
    assert.deepEqual(connect({ ...sec, origin: 'https://127.0.0.1:1', ca_sha256: 'b'.repeat(64) }), { ok: false, reason: 'ca_changed' });
    assert.ok(connect({ ...sec, origin: 'https://127.0.0.1:1' }).ok);
  });
  test('only the pinned CA is trusted: the pinned hub answers, another CA is tls_refused', tlsOpts, async () => {
    const good = makePki('Pin CA good'), evil = makePki('Pin CA evil');
    const hub = await stubHub(evil);
    try {
      const mkConn = (p) => connect({ origin: hub.origin, ca_pem: p.ca, ca_sha256: caFingerprint(p.ca) }).hub;
      await assert.rejects(callTool(mkConn(good), 'session_whoami', {}, {}), (e) => e.reason === 'tls_refused');
      const r = await callTool(mkConn(evil), 'session_whoami', {}, {});
      assert.equal(r.status, 401);
      assert.equal(hub.requests.length, 1, 'only the pinned connection reached the hub');
    } finally { await hub.close(); }
  });
  test('a redirect is never followed, so the app key never goes to another address', tlsOpts, async () => {
    const pki = makePki('Redirect CA');
    const a = await stubHub(pki), b = await stubHub(pki);
    a.redirect = `${b.origin}/mcp`;
    try {
      const hub = connect({ origin: a.origin, ca_pem: pki.ca, ca_sha256: caFingerprint(pki.ca) }).hub;
      await assert.rejects(post(hub, '{"jsonrpc":"2.0","id":1,"method":"ping"}', { Authorization: `Bearer ${APP}` }, 5000), (e) => e.reason === 'hub_unreachable');
      assert.equal(b.requests.length, 0);
    } finally { await a.close(); await b.close(); }
  });
});

// ───────────── the mcp relay ─────────────
describe('conclave mcp', { concurrency: false }, () => {
  test('relays initialize, tools/list and a call; the hub sees a turn token only, never a key; nothing leaks', tlsOpts, async () => {
    const pki = makePki('Relay CA'), hub = await stubHub(pki);
    try {
      const s = setup(pki, hub);
      const r = await withBroker(s, () => runMcp(s, s.folder, [INIT, { jsonrpc: '2.0', method: 'notifications/initialized' }, LIST, call(3, 'session_help', { a: 1 })]));
      assert.equal(r.code, 0);
      assert.deepEqual(r.msgs.map((m) => m.id).sort(), [1, 2, 3]);
      assert.equal(r.msgs.find((m) => m.id === 1).result.serverInfo.name, 'stub');
      assert.deepEqual(r.msgs.find((m) => m.id === 3).result.structuredContent, { echoed: { a: 1 } });
      for (const l of r.lines) assert.doesNotThrow(() => JSON.parse(l), 'stdout is JSON-RPC only');
      const issue = hub.requests.find((q) => q.tool === 'turn_issue');
      assert.equal(issue.auth, `Bearer ${APP}`, 'only the connector signs in with the app key');
      const mcp = hub.requests.filter((q) => !q.tool.startsWith('turn_'));
      assert.ok(mcp.length >= 3 && mcp.every((q) => /^tok-/.test(q.session) && q.auth === undefined), 'a session sends a turn token and no Authorization');
      assert.equal(hub.revoked?.length, 1, 'the turn token is revoked when the session ends');
      assert.equal(hub.revoked[0].reason, 'turn_ended');
      noSecrets(r);
      assert.match(r.log, /ok folder=/);
    } finally { await hub.close(); }
  }, 30000);
  test('a session works with an unreadable key file and holds no key; the key file is encrypted at rest', tlsOpts, async () => {
    const pki = makePki('Env CA'), hub = await stubHub(pki);
    try {
      const s = setup(pki, hub);
      await withBroker(s, async () => {
        // the broker is already running; the session process could not read a key even if it tried
        const kf = readFileSync(keyFilePath(s.home));
        writeFileSync(keyFilePath(s.home), 'not a key file');
        try {
          const r = await runMcp(s, s.folder, [INIT, call(2, 'session_help')]);
          assert.ok(r.msgs.find((m) => m.id === 2).result);
        } finally { writeFileSync(keyFilePath(s.home), kf); }
      });
      const raw = readFileSync(keyFilePath(s.home), 'utf8');
      assert.ok(!raw.includes(SES) && !raw.includes(APP), 'the key file is encrypted at rest');
    } finally { await hub.close(); }
  }, 30000);
  test('without the connector running a session gets the fixed line and nothing reaches a hub', tlsOpts, async () => {
    const pki = makePki('NoBroker CA'), hub = await stubHub(pki);
    try {
      const s = setup(pki, hub);
      const r = await runMcp(s, s.folder, [INIT, call(2, STATUS)]);
      assert.match(r.msgs.find((m) => m.id === 1).result.instructions, /connector is not running/i);
      assert.equal(hub.requests.length, 0);
    } finally { await hub.close(); }
  }, 30000);
  test("the first registration of a folder waits for the PC user's click; a click opens it", tlsOpts, async () => {
    const pki = makePki('Click CA'), hub = await stubHub(pki);
    try {
      const s = setup(pki, hub);
      await withBroker(s, async () => {
        const first = await runMcp(s, s.folder, [INIT, call(2, STATUS)]);
        assert.match(first.msgs.find((m) => m.id === 1).result.instructions, /click|conclave setup/i);
        assert.equal(hub.requests.length, 0, 'no token before the click');
        const p = pendingList(s.home);
        assert.equal(p.folders.length, 1);
        assert.equal(allowFolder(s.home, p.folders[0].key), true);
        const ok = await runMcp(s, s.folder, [INIT, call(2, 'session_help')]);
        assert.ok(ok.msgs.find((m) => m.id === 2).result);
      }, { clicks: true });
    } finally { await hub.close(); }
  }, 30000);
  test('the broker answers only a session that holds its secret, and a session believes only the broker that holds it', tlsOpts, async () => {
    const pki = makePki('Broker auth CA'), hub = await stubHub(pki);
    try {
      const s = setup(pki, hub);
      // The folder's binding records the hub's origin: a session pins it from there, not from the broker's answer.
      assert.equal(resolveFolder(s.home, s.folder).binding.origin, normalizeOrigin(hub.origin));
      const b = await broker(s);
      try {
        const secret = readFileSync(brokerSecretPath(s.home), 'utf8').trim();
        assert.match(secret, /^[0-9a-f]{64}$/);
        if (!WIN) assert.equal(statSync(brokerSecretPath(s.home)).mode & 0o077, 0, 'the secret is readable by this user only');
        const raw = (req) => new Promise((res, rej) => {
          let buf = '';
          const c = netConnect(brokerAddress(s.home), () => c.write(JSON.stringify(req) + '\n'));
          c.setEncoding('utf8'); c.on('data', (d) => { buf += d; }); c.on('end', () => res(JSON.parse(buf))); c.on('error', rej);
        });
        // A process that does not hold the secret (no proof, a wrong proof, a replayed proof for another nonce) gets nothing.
        const nonce = 'a'.repeat(32);
        for (const req of [{ op: 'turn', folder: s.folder, pid: process.pid },
          { op: 'turn', folder: s.folder, pid: process.pid, nonce, auth: brokerProof('b'.repeat(64), 'client', nonce) },
          { op: 'turn', folder: s.folder, pid: process.pid, nonce: 'c'.repeat(32), auth: brokerProof(secret, 'client', nonce) }]) {
          const a = await raw(req);
          assert.deepEqual(a, { ok: false, reason: 'bad_request' });
        }
        assert.equal(b.runs.size, 0, 'no turn was started for an unproven request');
        // The real session proves it holds the secret and checks the broker's proof.
        const a = await askBroker(s.home, { op: 'turn', folder: s.folder, pid: process.pid });
        assert.equal(a.ok, true); assert.equal(a.proof, undefined);
      } finally { await b.close(); }
      // Something else listening at an address, without the secret: a session never believes its answer.
      const fakeAt = WIN ? `\\\\.\\pipe\\conclave-fake-${process.pid}` : join(s.base, 'fake.sock');
      const fake = createNet((c) => c.on('data', () => c.end(JSON.stringify({ ok: true, token: 'stolen-turn', origin: 'https://evil.example', ca_pem: 'x', proof: 'f'.repeat(64) }) + '\n')));
      await new Promise((r) => fake.listen(fakeAt, r));
      try {
        assert.deepEqual(await askBroker(s.home, { op: 'turn', folder: s.folder, pid: process.pid }, { address: fakeAt }), { ok: false, reason: 'broker_unverified' });
      } finally { await new Promise((r) => fake.close(r)); }
      // With no secret (the connector has never run here) a session does not even connect.
      rmSync(brokerSecretPath(s.home));
      assert.deepEqual(await askBroker(s.home, { op: 'turn', folder: s.folder, pid: process.pid }, { address: fakeAt }), { ok: false, reason: 'connector_not_running' });
    } finally { await hub.close(); }
  }, 30000);
  test('a long connector folder listens in the private runtime folder, never in a shared temporary folder', () => {
    const long = '/home/someone/' + 'x'.repeat(120);
    assert.equal(brokerAddress(long, 'linux', {}), null);
    assert.equal(brokerAddress(long, 'linux', { XDG_RUNTIME_DIR: '/tmp' + 'y'.repeat(100) }), null);
    assert.match(brokerAddress(long, 'linux', { XDG_RUNTIME_DIR: '/run/user/1000' }), /^[\\/]run[\\/]user[\\/]1000[\\/]conclave-[^\\/]+\.sock$/);
    assert.match(brokerAddress('/home/someone/.config/conclave', 'linux', {}), /broker\.sock$/);
    assert.match(brokerAddress(long, 'win32', {}), /^\\\\\.\\pipe\\conclave-broker-/);
  });
  test('a long turn keeps its token through renewal; a hub refusal ends the run', tlsOpts, async () => {
    const pki = makePki('Renew CA'), hub = await stubHub(pki);
    try {
      const s = setup(pki, hub);
      const b = await broker(s);
      try {
        const a = await askBroker(s.home, { op: 'turn', folder: s.folder, pid: process.pid });
        assert.equal(a.ok, true);
        await b.renewAll(); await b.renewAll();
        assert.equal(hub.renewed, 2);
        assert.equal(b.runs.size, 1);
        hub.issued.clear(); // the hub no longer knows the token (revoked, team paused)
        await b.renewAll();
        assert.equal(b.runs.size, 0, 'a refused renewal ends the run');
      } finally { await b.close(); }
    } finally { await hub.close(); }
  }, 30000);
  test('a refused renewal (pause, lockdown, suspended key) stops the wake run in that folder and still scans its transcript', tlsOpts, async () => {
    const pki = makePki('Refuse CA'), hub = await stubHub(pki);
    try {
      const s = setup(pki, hub);
      const stopped = [];
      const b = await broker(s, { onRefused: async (run) => { stopped.push({ folder: run.folder, hubKey: run.hubKey }); return true; } });
      try {
        await askBroker(s.home, { op: 'turn', folder: s.folder, pid: process.pid });
        const t = join(s.base, 'transcript-refused.jsonl');
        writeFileSync(t, JSON.stringify({ role: 'assistant', text: `here is the key ${SES}` }) + '\n');
        await askBroker(s.home, { op: 'transcript', folder: s.folder, path: t });
        const revokes = (hub.revoked?.length ?? 0);
        hub.issued.clear(); // the hub refuses the renewal
        await b.renewAll();
        assert.deepEqual(stopped, [{ folder: s.folder, hubKey: s.hubKey }], 'the wake is told, with the folder and the hub');
        assert.equal(b.runs.size, 0);
        assert.equal((hub.revoked?.length ?? 0), revokes, 'the refused token is not revoked again');
      } finally { await b.close(); }
    } finally { await hub.close(); }
  }, 30000);
  test('a run whose process is gone is ended and its token revoked; a key in its transcript revokes it as a leak', tlsOpts, async () => {
    const pki = makePki('Leak CA'), hub = await stubHub(pki);
    try {
      const s = setup(pki, hub);
      let up = true;
      const b = await broker(s, { alive: () => up });
      try {
        await askBroker(s.home, { op: 'turn', folder: s.folder, pid: process.pid });
        const t = join(s.base, 'transcript.jsonl');
        writeFileSync(t, JSON.stringify({ role: 'assistant', text: `here is the key ${SES}` }) + '\n');
        await askBroker(s.home, { op: 'transcript', folder: s.folder, path: t });
        up = false;
        await b.renewAll();
        assert.equal(b.runs.size, 0);
        assert.equal(hub.revoked.at(-1).reason, 'leak_found');
      } finally { await b.close(); }
    } finally { await hub.close(); }
  }, 30000);
  test('task_submit and task_review get a stable request id, so a retry returns the first result', () => {
    const a = withRequestId(call(1, 'task_submit', { summary: 'x', task_id: 't' }));
    const b = withRequestId(call(2, 'task_submit', { task_id: 't', summary: 'x' }));
    assert.match(a.params.arguments.request_id, /^cb-[0-9a-f]{32}$/);
    assert.equal(a.params.arguments.request_id, b.params.arguments.request_id);
    assert.equal(withRequestId(call(1, 'task_submit', { request_id: 'mine' })).params.arguments.request_id, 'mine');
    assert.equal(withRequestId(call(1, 'task_list', {})).params.arguments.request_id, undefined);
  });
  test('a rotated key in the key file means the next turn signs in with it', tlsOpts, async () => {
    const pki = makePki('Cache CA'), hub = await stubHub(pki, { valid: new Set([SES, SES2]) });
    try {
      const s = setup(pki, hub);
      await withBroker(s, async () => {
        await runMcp(s, s.folder, [INIT]);
        putAgentKey(s.home, s.hubKey, s.label, SES2);
        await runMcp(s, s.folder, [INIT]);
      });
      assert.deepEqual(hub.requests.filter((q) => q.tool === 'turn_issue').map((q) => q.args.session_key), [SES, SES2]);
    } finally { await hub.close(); }
  }, 30000);
  test('a hub that refuses every call: one new turn token, then the fixed line', tlsOpts, async () => {
    const pki = makePki('Expire CA'), hub = await stubHub(pki);
    try {
      const s = setup(pki, hub);
      await withBroker(s, async () => {
        const first = await runMcp(s, s.folder, [INIT, call(2, 'session_help')]);
        assert.ok(first.msgs.find((m) => m.id === 2).result);
        hub.rejectAll401 = true;
        const third = await runMcp(s, s.folder, [INIT, call(2, 'session_help'), call(3, 'session_help')]);
        assert.match(third.msgs.find((m) => m.id === 2).error.message, /refused this agent's key/);
        noSecrets(third);
      });
    } finally { await hub.close(); }
  }, 30000);
  test("a folder from another hub gets the fixed line in the session and nothing is sent to any hub", tlsOpts, async () => {
    const pki = makePki('Other CA'), hub = await stubHub(pki);
    try {
      const s = setup(pki, hub);
      // the same folder is bound to a hub this PC has no key for
      bindFolder(s.home, s.folder, { hubId: 'hub-demo', caSha256: 'c'.repeat(64), agent: s.label });
      const b = await broker(s);
      let r; try { r = await runMcp(s, s.folder, [INIT, LIST, call(3, STATUS)]); } finally { await b.close(); }
      assert.equal(hub.requests.length, 0, 'no key was sent anywhere');
      assert.match(r.msgs.find((m) => m.id === 1).result.instructions, /belongs to a hub that this PC has no key for\. Run: conclave check/);
      assert.equal(r.msgs.find((m) => m.id === 2).result.tools[0].name, STATUS);
      const c = r.msgs.find((m) => m.id === 3).result;
      assert.equal(c.isError, true);
      assert.equal(c.structuredContent.reason, 'no_hub_key');
      assert.match(r.log, /speaking-up no_hub_key/);
      noSecrets(r);
    } finally { await hub.close(); }
  }, 30000);
  test('a copy of a registered folder gets no identity, even with a forged .agent-hub.json', tlsOpts, async () => {
    const pki = makePki('Copy CA'), hub = await stubHub(pki);
    try {
      const s = setup(pki, hub);
      const copy = join(s.base, 'copy of agent');
      cpSync(s.folder, copy, { recursive: true });
      writeFileSync(join(copy, '.agent-hub.json'), JSON.stringify({ session_var: 'X', url: hub.origin }));
      const r = await runMcp(s, copy, [INIT, call(2, STATUS)]);
      assert.match(r.msgs.find((m) => m.id === 1).result.instructions, /isn't registered with Conclave on this PC/);
      assert.equal(hub.requests.length, 0);
    } finally { await hub.close(); }
  }, 30000);
  test('a key the hub refuses, an unreachable hub and another CA are told apart, each with a fixed line', tlsOpts, async () => {
    const pki = makePki('Why CA'), hub = await stubHub(pki, { valid: new Set() });
    try {
      const s = setup(pki, hub);
      const refused = await withBroker(s, () => runMcp(s, s.folder, [INIT]));
      assert.match(refused.msgs[0].result.instructions, /refused this agent's key/);
    } finally { await hub.close(); }
    const down = await stubHub(pki); const port = down.origin; await down.close();
    const s2 = setup(pki, { origin: port });
    const unreachable = await withBroker(s2, () => runMcp(s2, s2.folder, [INIT]));
    assert.match(unreachable.msgs[0].result.instructions, /could not be reached\. Run: conclave check --probe/);
    const evil = makePki('Evil CA'), hub3 = await stubHub(evil);
    try {
      const s3 = setup(pki, hub3);
      const tls = await withBroker(s3, () => runMcp(s3, s3.folder, [INIT]));
      assert.match(tls.msgs[0].result.instructions, /certificate does not match what this PC pinned/);
    } finally { await hub3.close(); }
  }, 60000);
  test('a broker that passes the proof but names another hub address than the folder binding is refused with ca_changed, and no tool call is relayed', tlsOpts, async () => {
    const pki = makePki('Origin CA'), hub = await stubHub(pki);
    try {
      const s = setup(pki, hub);
      // The folder was bound to another address of the hub; the (verified) broker answers with this one.
      bindFolder(s.home, s.folder, { hubId: s.hubId, caSha256: s.ca, agent: s.label, origin: 'https://127.0.0.1:1' });
      assert.equal(resolveFolder(s.home, s.folder).binding.origin, 'https://127.0.0.1:1');
      const r = await withBroker(s, () => runMcp(s, s.folder, [INIT, call(2, STATUS)]));
      assert.match(r.msgs[0].result.instructions, new RegExp(line('ca_changed').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 40)));
      assert.match(r.log, /speaking-up ca_changed/);
      assert.deepEqual(hub.requests.filter((q) => !String(q.tool).startsWith('turn_')), [], 'no tool call was relayed to the hub the broker named');
      noSecrets(r);
    } finally { await hub.close(); }
  }, 30000);
  test('a second connector start that cannot take the broker address fails and leaves the running broker, its secret and its proof alone', tlsOpts, async () => {
    const pki = makePki('Second Broker CA'), hub = await stubHub(pki);
    try {
      const s = setup(pki, hub);
      const b = await broker(s);
      try {
        const secret = readFileSync(brokerSecretPath(s.home), 'utf8');
        await assert.rejects(() => startBroker({ home: s.home, deps: { renewMs: 3_600_000 } }), (e) => e.code === 'EADDRINUSE');
        assert.equal(readFileSync(brokerSecretPath(s.home), 'utf8'), secret, 'the secret of the running broker was not replaced');
        const a = await askBroker(s.home, { op: 'turn', folder: s.folder, pid: process.pid });
        assert.equal(a.ok, true, 'the first broker still answers, and its proof is still accepted');
      } finally { await b.close(); }
    } finally { await hub.close(); }
  }, 30000);
  test('the hook hands the transcript path to the broker, so the end-of-turn key scan runs and a key found revokes the token as a leak', tlsOpts, async () => {
    const pki = makePki('Hook Scan CA'), hub = await stubHub(pki);
    try {
      const s = setup(pki, hub);
      let up = true;
      const b = await broker(s, { alive: () => up });
      try {
        await askBroker(s.home, { op: 'turn', folder: s.folder, pid: process.pid });
        const t = join(s.base, 'claude-transcript.jsonl');
        writeFileSync(t, JSON.stringify({ role: 'assistant', text: `here is the key ${SES}` }) + '\n');
        // What Claude Code sends the hook: the event and the transcript's path. Nothing here calls the broker's transcript op by hand.
        await runHook(s.home, s.folder, JSON.stringify({ hook_event_name: 'UserPromptSubmit', transcript_path: t }));
        const t0 = Date.now(); while (Date.now() - t0 < 5000 && !b.runs.get([...b.runs.keys()][0])?.transcript) await new Promise((r) => setTimeout(r, 25));
        up = false;
        await b.renewAll();
        assert.equal(b.runs.size, 0);
        assert.equal(hub.revoked.at(-1).reason, 'leak_found');
      } finally { await b.close(); }
    } finally { await hub.close(); }
  }, 30000);
  test('the docs say the scan covers Claude Code transcripts only, and that a Codex transcript is never scanned', () => {
    const doc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'connector.md'), 'utf8').replace(/\r\n/g, '\n');
    assert.match(doc, /Codex transcripts are not scanned/);
  });
  test('speak-up answers are valid JSON-RPC: notifications get nothing, unknown methods an error with the line', () => {
    assert.equal(speakUp({ jsonrpc: '2.0', method: 'notifications/initialized' }, 'no_hub_key'), null);
    assert.equal(speakUp({ jsonrpc: '2.0', id: 9, method: 'resources/list' }, 'no_hub_key').error.code, -32601);
    assert.deepEqual(speakUp({ jsonrpc: '2.0', id: 9, method: 'ping' }, 'no_hub_key').result, {});
    assert.equal(speakUp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, 'no_hub_key').result.protocolVersion, '2025-03-26');
  });
});
const STATUS = 'conclave_status';

// ───────────── folder trust ─────────────
describe('folder trust', () => {
  const F = 'C:/work/agent one';
  const bind = { identity: '1:2', config_sha256: 'h1' };
  const now = { identity: '1:2', config_sha256: 'h1' };
  test('re-applied only for an unchanged registered folder whose entry disappeared', () => {
    assert.equal(decide({ projects: { [F]: { hasTrustDialogAccepted: true } } }, F, bind, now, false).action, 'none');
    assert.deepEqual(decide({ projects: {} }, F, bind, now, false), { action: 'reapply', reason: null, missing: [F] });
    assert.deepEqual(decide({}, F, bind, now, false).action, 'reapply', 'no projects key at all is a disappeared entry');
    assert.deepEqual(decide({ projects: { [F]: {} } }, F, bind, now, false).action, 'reapply', 'an entry without the flag is absent too');
  });
  test("the user's choice wins: a flag turned off is never turned on again", () => {
    const d = decide({ projects: { [F]: { hasTrustDialogAccepted: false } } }, F, bind, now, false);
    assert.deepEqual([d.action, d.reason], ['ask', 'trust_withdrawn']);
  });
  test('a replaced folder, or one that gained settings, is asked about, not trusted', () => {
    assert.equal(decide({}, F, bind, { ...now, identity: '9:9' }, false).reason, 'identity_changed');
    assert.equal(decide({}, F, bind, { ...now, config_sha256: 'h2' }, false).reason, 'folder_changed');
    assert.equal(decide({}, F, null, now, false).reason, 'not_registered');
  });
  test('on Windows both key forms are checked, and a missing form alone is restored', () => {
    const W = 'C:\\work\\agent one';
    const j = { projects: { 'C:/work/agent one': { hasTrustDialogAccepted: true } } };
    assert.deepEqual(decide(j, W, bind, now, true).missing, [W]);
    assert.equal(decide({ projects: { 'C:/work/agent one': { hasTrustDialogAccepted: true }, [W]: { hasTrustDialogAccepted: true } } }, W, bind, now, true).action, 'none');
  });
  const folderWith = (extra = {}) => { const base = mk(), f = join(base, 'agent one'); mkdirSync(f); const home = join(base, 'h'); const b = bindFolder(home, f, { hubId: 'h', caSha256: 'a'.repeat(64), agent: 'x' }); return { base, f: canonicalFolder(f), b, cj: join(base, '.claude.json'), ...extra }; };
  test('applyTrust writes only the missing key, keeps every other field, and is idempotent', () => {
    const { f, b, cj } = folderWith();
    const other = { projects: { '/elsewhere': { hasTrustDialogAccepted: true, allowedTools: ['x'] } }, theme: 'dark', numStartups: 7 };
    writeFileSync(cj, JSON.stringify(other));
    const r = applyTrust(cj, f, b, { win: false });
    assert.equal(r.wrote, true);
    const j = JSON.parse(readFileSync(cj, 'utf8'));
    assert.equal(j.projects[f].hasTrustDialogAccepted, true);
    assert.deepEqual(j.projects['/elsewhere'], other.projects['/elsewhere']);
    assert.equal(j.theme, 'dark'); assert.equal(j.numStartups, 7);
    assert.equal(applyTrust(cj, f, b, { win: false }).wrote, false);
  });
  test('applyTrust leaves a declined flag, a changed folder and an unreadable file exactly as they were', () => {
    const { f, b, cj } = folderWith();
    const declined = JSON.stringify({ projects: { [f]: { hasTrustDialogAccepted: false } } });
    writeFileSync(cj, declined);
    assert.equal(applyTrust(cj, f, b, { win: false }).wrote, false);
    assert.equal(readFileSync(cj, 'utf8'), declined);
    writeFileSync(cj, '{}');
    writeFileSync(join(f, 'CLAUDE.md'), 'a tracked instruction that appeared later');
    assert.equal(applyTrust(cj, f, b, { win: false }).reason, 'folder_changed');
    assert.equal(readFileSync(cj, 'utf8'), '{}');
    const { f: f2, b: b2, cj: cj2 } = folderWith();
    writeFileSync(cj2, '{ this is not json');
    assert.equal(applyTrust(cj2, f2, b2, { win: false }).reason, 'claude_json_unreadable');
    assert.equal(readFileSync(cj2, 'utf8'), '{ this is not json');
  });
  test('trustStatus is read-only and grantTrust (the user approved) sets every key form without touching other entries', () => {
    const { f, b, cj } = folderWith();
    assert.equal(trustStatus(cj, f, b, { win: false }).action, 'reapply');
    assert.equal(existsSync(cj), false, 'a status call wrote nothing');
    writeFileSync(cj, JSON.stringify({ projects: { [f]: { hasTrustDialogAccepted: false, keep: 1 } } }));
    grantTrust(cj, f, { win: false });
    assert.deepEqual(JSON.parse(readFileSync(cj, 'utf8')).projects[f], { hasTrustDialogAccepted: true, keep: 1 });
  });
});

// ───────────── entries, manifest, register, repair ─────────────
describe('entries and manifest', { concurrency: false }, () => {
  test('the entry names Node and the connector by absolute path, with the folder as its own argument', () => {
    const e = mcpEntry({ node: nodePath(), connector: '/abs/conclave.mjs', folder: '/work/agent one' });
    assert.ok(e.command.length > 1 && (e.command.startsWith('/') || /^[A-Za-z]:/.test(e.command)));
    assert.deepEqual(e.args, ['/abs/conclave.mjs', 'mcp', '/work/agent one']);
    const t = codexToml({ node: 'C:\\Program Files\\nodejs\\node.exe', connector: 'C:\\Users\\a b\\.config\\conclave\\conclave.mjs', folder: 'C:\\work\\agent one' });
    assert.match(t, /^\[mcp_servers\.conclave\]\ncommand = "C:\/Program Files\/nodejs\/node\.exe"\nargs = \["C:\/Users\/a b\/\.config\/conclave\/conclave\.mjs", "mcp", "C:\/work\/agent one"\]\nstartup_timeout_sec = 60\ntool_timeout_sec = 660\n$/);
  });
  test('git is found by absolute path: the connector\'s own first, a relative PATH entry never', () => {
    const home = mk(), bin = join(home, 'git', WIN ? 'cmd' : 'bin');
    mkdirSync(bin, { recursive: true });
    assert.equal(gitPath(home, { PATH: '' }, WIN), null);
    writeFileSync(join(bin, WIN ? 'git.exe' : 'git'), '');
    assert.equal(gitPath(home, { PATH: '' }, WIN), join(bin, WIN ? 'git.exe' : 'git'));
    const home2 = mk();
    writeFileSync(join(home2, WIN ? 'git.exe' : 'git'), '');
    assert.equal(gitPath(mk(), { PATH: '.' }, WIN), null, 'a relative PATH entry is not trusted');
  });
  test('writing the entry keeps every other server and settings; the approval is one list entry', () => {
    const f = mk();
    writeFileSync(join(f, '.mcp.json'), JSON.stringify({ mcpServers: { mine: { command: 'x', args: [] } }, other: 1 }));
    mkdirSync(join(f, '.claude'));
    writeFileSync(join(f, '.claude', 'settings.json'), JSON.stringify({ enabledMcpjsonServers: ['mine'], hooks: { a: 1 } }));
    const w = writeMcpEntry(f, { command: 'node', args: ['a', 'mcp', 'b'] });
    assert.equal(w.before, null);
    const j = JSON.parse(readFileSync(join(f, '.mcp.json'), 'utf8'));
    assert.deepEqual(Object.keys(j.mcpServers).sort(), ['conclave', 'mine']);
    assert.equal(j.other, 1);
    assert.deepEqual(approveInSettings(f), { before: false, installed: true });
    const s = JSON.parse(readFileSync(join(f, '.claude', 'settings.json'), 'utf8'));
    assert.deepEqual(s.enabledMcpjsonServers, ['mine', 'conclave']);
    assert.deepEqual(s.hooks, { a: 1 });
    assert.deepEqual(approveInSettings(f), { before: true, installed: true });
  });
  test('a .mcp.json that is not an object is never overwritten', () => {
    const f = mk();
    writeFileSync(join(f, '.mcp.json'), '[1,2]');
    assert.throws(() => writeMcpEntry(f, { command: 'n', args: [] }), /not touching/);
    assert.equal(readFileSync(join(f, '.mcp.json'), 'utf8'), '[1,2]');
  });
  const ctxFor = (home, f, cj) => ({ home, claudeJson: cj, folders: [f] });
  test('the manifest takes only fixed kinds at fixed places inside registered folders, and keeps the ORIGINAL value before', () => {
    const home = mk(), f = canonicalFolder(mk()), cj = join(mk(), '.claude.json');
    const cx = ctxFor(home, f, cj);
    const good = { kind: 'mcp_entry', target: join(f, '.mcp.json'), folder: f, pointer: 'mcpServers.conclave', before: { command: 'old' }, installed: { command: 'n' } };
    assert.ok(validateEntry(good, cx).ok);
    const bad = (patch, reason) => assert.equal(validateEntry({ ...good, ...patch }, cx).reason, reason);
    bad({ kind: 'delete_everything' }, 'unknown_kind');
    bad({ target: join(f, 'other.json') }, 'wrong_place');
    bad({ target: join(f, '..', '.mcp.json') }, 'wrong_place');
    bad({ pointer: 'mcpServers.other' }, 'wrong_pointer');
    bad({ folder: mk(), target: join(mk(), '.mcp.json') }, 'folder_not_registered');
    bad({ target: '.mcp.json' }, 'target_not_absolute');
    assert.equal(validateEntry({ ...good, installed: undefined, kind: 'mcp_entry' }, cx).ok, true, 'a missing value means undefined, still present as a key');
    record(home, good, cx);
    record(home, { ...good, before: { command: 'second' }, installed: { command: 'n2' } }, cx);
    const m = entries(home);
    assert.equal(m.length, 1);
    assert.deepEqual([m[0].before, m[0].installed], [{ command: 'old' }, { command: 'n2' }], 'the first before is kept');
    assert.throws(() => record(home, { ...good, kind: 'x' }, cx), /refused: unknown_kind/);
    assert.equal(validateEntry({ kind: 'trust_flag', target: cj, pointer: 'projects.C:/x.hasTrustDialogAccepted', installed: true }, cx).ok, true);
    assert.equal(validateEntry({ kind: 'trust_flag', target: join(mk(), '.claude.json'), pointer: 'projects.x.hasTrustDialogAccepted', installed: true }, cx).reason, 'wrong_place');
  });
  test('a path through a link, junction or reparse point is refused', () => {
    const home = mk(), real = mk(), base = canonicalFolder(mk());
    const link = join(base, 'linked');
    try { symlinkSync(real, link, 'junction'); } catch { return; /* this account may not create links: nothing to test */ }
    const f = canonicalFolder(base);
    const e = { kind: 'mcp_entry', target: join(f, 'linked', '.mcp.json'), folder: f, pointer: 'mcpServers.conclave', installed: {} };
    assert.equal(noRedirect(f, join(f, 'linked', 'x')), false);
    assert.notEqual(validateEntry(e, ctxFor(home, f, join(mk(), 'c.json'))).ok, true);
  });
  test('a later removal may undo an entry only while it still holds the installed value', () => {
    const e = { installed: { command: 'n' } };
    assert.equal(undoDecision(e, { command: 'n' }), 'undo');
    assert.equal(undoDecision(e, { command: 'edited by the user' }), 'keep_edited');
    assert.equal(undoDecision(e, undefined), 'already_gone');
  });
});

describe('register, repair and check', { concurrency: false }, () => {
  test('registering binds, writes the entry and approval, grants trust, and records each change', tlsOpts, async () => {
    const pki = makePki('Reg CA'), hub = await stubHub(pki);
    try {
      const s = setup(pki, hub);
      const j = JSON.parse(readFileSync(join(s.folder, '.mcp.json'), 'utf8')).mcpServers.conclave;
      assert.equal(j.args[1], 'mcp'); assert.equal(j.args[2], s.folder);
      assert.ok(existsSync(j.command), 'Node by an absolute path that exists');
      assert.ok(JSON.parse(readFileSync(join(s.folder, '.claude', 'settings.json'), 'utf8')).enabledMcpjsonServers.includes('conclave'));
      assert.equal(JSON.parse(readFileSync(s.claudeJson, 'utf8')).projects[s.folder.replace(/\\/g, '/')].hasTrustDialogAccepted, true);
      assert.deepEqual(entries(s.home).map((e) => e.kind).sort(), ['hook', 'mcp_approval', 'mcp_entry', 'registry_entry', 'trust_flag']);
      assert.throws(() => registerFolder(s.home, s.folder, { hubId: 'hub-none', caSha256: s.ca, agent: 'x', claudeJson: s.claudeJson }), /pair first/);
    } finally { await hub.close(); }
  }, 30000);
  test('check names one reason, in a fixed order, and changes nothing (no file, no cached token)', tlsOpts, async () => {
    const pki = makePki('Check CA'), hub = await stubHub(pki);
    try {
      const s = setup(pki, hub);
      const snap = (d) => readdirSync(d, { recursive: true }).sort().map((p) => { const st = statSync(join(d, p)); return `${p}:${st.isFile() ? readFileSync(join(d, p), 'utf8') : 'dir'}`; }).join('\n');
      const b = await broker(s);
      const before = [snap(s.home), snap(s.folder), readFileSync(s.claudeJson, 'utf8')];
      const ok = await runCheck(s.home, s.folder, { claudeJson: s.claudeJson, win: WIN });
      assert.equal(ok.ok, true);
      assert.deepEqual([snap(s.home), snap(s.folder), readFileSync(s.claudeJson, 'utf8')], before, 'check is read-only');
      const probe = await runCheck(s.home, s.folder, { claudeJson: s.claudeJson, win: WIN, probe: true });
      assert.equal(probe.ok, true);
      assert.deepEqual([snap(s.home), snap(s.folder)], [before[0], before[1]], 'a probe caches nothing either');
      hub.valid.clear();
      assert.equal((await runCheck(s.home, s.folder, { claudeJson: s.claudeJson, win: WIN, probe: true })).reason, 'login_refused');
      await b.close();
      assert.equal((await runCheck(s.home, s.folder, { claudeJson: s.claudeJson, win: WIN, probe: true })).reason, 'connector_not_running');
      assert.equal((await runCheck(s.home, join(s.base, 'nowhere'), { claudeJson: s.claudeJson })).reason, 'not_registered');
      for (const r of ORDER) assert.ok(REASONS[r], `${r} has a fixed sentence`);
      for (const r of Object.keys(REASONS)) { assert.ok(!/ah_(app|ses)_/.test(line(r))); if (r !== 'denied') assert.match(line(r), /Run: conclave /); }
    } finally { await hub.close(); }
  }, 30000);
  test('check reports the first reason that applies: no key, a stale entry, withdrawn trust, a changed folder', tlsOpts, async () => {
    const pki = makePki('Order CA'), hub = await stubHub(pki);
    try {
      const s = setup(pki, hub);
      const opts = { claudeJson: s.claudeJson, win: WIN };
      // trust turned off by the user
      const cj = JSON.parse(readFileSync(s.claudeJson, 'utf8'));
      for (const k of Object.keys(cj.projects)) cj.projects[k].hasTrustDialogAccepted = false;
      writeFileSync(s.claudeJson, JSON.stringify(cj));
      assert.equal((await runCheck(s.home, s.folder, opts)).reason, 'trust_withdrawn');
      // repair does NOT turn it back on by itself
      const r1 = repairFolder(s.home, s.folder, opts);
      assert.deepEqual(r1.asked, ['trust_withdrawn']);
      assert.equal(JSON.parse(readFileSync(s.claudeJson, 'utf8')).projects[s.folder.replace(/\\/g, '/')].hasTrustDialogAccepted, false);
      // only the user's explicit word does
      assert.deepEqual(repairFolder(s.home, s.folder, { ...opts, grantTrust: true }).actions, ['trust_granted_by_user']);
      assert.equal((await runCheck(s.home, s.folder, opts)).ok, true);
      // the folder gains settings: not trusted again behind the user's back
      writeFileSync(join(s.folder, 'AGENTS.md'), 'new instructions from a tracked file');
      writeFileSync(s.claudeJson, '{}');
      assert.equal((await runCheck(s.home, s.folder, opts)).reason, 'folder_changed');
      assert.deepEqual(repairFolder(s.home, s.folder, opts).asked, ['folder_changed']);
      assert.equal(readFileSync(s.claudeJson, 'utf8'), '{}');
      assert.ok(repairFolder(s.home, s.folder, { ...opts, acceptChanges: true }).actions.includes('settings_accepted'));
      assert.equal(readFileSync(s.claudeJson, 'utf8'), '{\n  "projects": {\n    "' + s.folder.replace(/\\/g, '/') + '": {\n      "hasTrustDialogAccepted": true\n    }' + (WIN ? ',\n    "' + s.folder.replace(/\\/g, '\\\\') + '": {\n      "hasTrustDialogAccepted": true\n    }' : '') + '\n  }\n}\n', 'accepting the settings let the lost trust entry be restored');
      // a missing key section
      removeHub(s.home, s.hubKey);
      assert.equal((await runCheck(s.home, s.folder, opts)).reason, 'no_hub_key');
    } finally { await hub.close(); }
  }, 30000);
  test('repair rewrites an entry whose Node or connector moved, and leaves another change visible', tlsOpts, async () => {
    const pki = makePki('Repair CA'), hub = await stubHub(pki);
    try {
      const s = setup(pki, hub);
      const opts = { claudeJson: s.claudeJson, win: WIN };
      const gone = join(s.base, 'old-conclave.mjs'); writeFileSync(gone, '');
      writeMcpEntry(s.folder, mcpEntry({ node: nodePath(), connector: gone, folder: s.folder }));
      rerecord(s.home, s.folder);
      rmSync(gone);
      assert.equal(entryState(s.folder, { node: nodePath(), connector: join(s.home, 'conclave.mjs'), folder: s.folder }), 'stale');
      assert.equal((await runCheck(s.home, s.folder, opts)).reason, 'entry_stale');
      // the connector program is not at its home in this test: give it one so the entry can be valid again
      writeFileSync(join(s.home, 'conclave.mjs'), '');
      const r = repairFolder(s.home, s.folder, opts);
      assert.deepEqual(r.actions, ['entry_rewritten']);
      assert.equal((await runCheck(s.home, s.folder, opts)).ok, true);
    } finally { await hub.close(); }
  }, 30000);
  test('an entry named conclave that is not ours is left alone and reported', tlsOpts, async () => {
    const pki = makePki('Foreign CA'), hub = await stubHub(pki);
    try {
      const s = setup(pki, hub);
      writeFileSync(join(s.folder, '.mcp.json'), JSON.stringify({ mcpServers: { conclave: { command: 'sh', args: ['-c', 'x'] } } }));
      assert.deepEqual(repairFolder(s.home, s.folder, { claudeJson: s.claudeJson, win: WIN }).asked.includes('entry_foreign'), true);
      assert.equal(JSON.parse(readFileSync(join(s.folder, '.mcp.json'), 'utf8')).mcpServers.conclave.command, 'sh');
    } finally { await hub.close(); }
  }, 30000);
  test('the command line: usage errors exit 2, check exits 0 or 1 and prints no key', tlsOpts, async () => {
    const pki = makePki('CLI CA'), hub = await stubHub(pki);
    try {
      const s = setup(pki, hub);
      // The PC's own NODE_EXTRA_CA_CERTS stays out: a missing file makes Node warn on stderr. The JSON is read from stdout only.
      const env = { ...process.env, CONCLAVE_HOME: s.home, CLAUDE_CONFIG_DIR: dirname(s.claudeJson) }; delete env.NODE_EXTRA_CA_CERTS;
      const run = (args) => new Promise((res) => { const c = spawn(process.execPath, [CLI, ...args], { env }); let o = '', out = ''; c.stdout.on('data', (d) => { o += d; out += d; }); c.stderr.on('data', (d) => { o += d; }); c.on('close', (code) => res({ code, o, out })); });
      assert.equal((await run([])).code, 2);
      assert.equal((await run(['bogus'])).code, 2);
      assert.equal((await run(['mcp'])).code, 2);
      assert.equal((await run(['check', '--bogus'])).code, 2);
      const bad = await run(['check', '--folder', join(s.base, 'nope')]);
      assert.equal(bad.code, 1); assert.match(bad.o, /PROBLEM: .*isn't registered/);
      const j = await run(['check', '--folder', s.folder, '--json']);
      assert.equal(JSON.parse(j.out).ok === true || JSON.parse(j.out).reason !== undefined, true);
      assert.ok(!j.o.includes(APP) && !j.o.includes(SES));
    } finally { await hub.close(); }
  }, 30000);
});
