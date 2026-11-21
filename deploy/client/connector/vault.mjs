/**
 * The key service (docs/connector.md, "Hardened isolation"): the one process that opens a long-lived key at the hardened
 * level. It runs under its own account (`NT SERVICE\Conclave`, or the system user `conclave`) and owns the vault folder.
 *
 * It listens on a local pipe or socket and speaks plain HTTP there, two ways:
 *
 * - `/relay/<hub key>/<path>`: a call the connector would make to the hub, with a PLACEHOLDER where a key goes (`vault:app`,
 *   `vault:agent:<label>:<tag>`). The service puts the real key in (headers, and a small JSON body), sends it to the hub over
 *   the pinned CA, and streams the answer back. Only `/connector/v1/…`, `/bridge/…`, `/vault-sync/v1/…`, `/mcp` and
 *   `/onboard/pickup` (with `/confirm`) of a hub it knows; a pickup's answer has its keys swapped for one-time references.
 * - `/ops/<name>`: `put_hub`, `put_agent`, `stage_agent`, `remove_agent`, `remove_hub` (a key goes IN), `commit_staged` and
 *   `discard_staged` (a handover's rotated key swapped in or dropped), `label_for_key` (a label, never a key), `mark_disconnected` (a Disconnect
 *   with remote cleanup off: the hub's section is kept and marked, so the worker stops checking in with it), `scan` (does this transcript hold a
 *   key: a yes or no), `view` and `ping`. No operation returns a key; the tests search every answer for one.
 *
 * After every change the service rewrites the public view (`keyview.json`), the key file as the connector may read it.
 */
import http from 'node:http';
import https from 'node:https';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync, rmSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { readKeyFile, putHub, putAgentKey, removeAgentKey, removeHub, markDisconnected, findHub, hubKeyOf, normalizeOrigin, caFingerprint, stageAgentKey, commitStaged, discardStaged, labelIn } from './keyfile.mjs';
import { scanTranscript } from './leak.mjs';
import { APP_PLACEHOLDER, agentPlaceholder } from './isolation.mjs';
import { WIN, oneLine } from './paths.mjs';

/** The paths a relayed call may reach. */
const RELAY_PATH = /^\/(?:connector\/v1\/|bridge\/|vault-sync\/v1\/|mcp(?:[/?]|$)|onboard\/pickup(?:\/confirm)?$)/;
/**
 * A pickup's answer carries new session keys. The service keeps each one and the connector gets a one-time reference in its
 * place, which `put_agent` and `stage_agent` take instead of a key: so a key handover and setup work on a hardened PC, and
 * still no answer of the service holds a key.
 */
const PICKUP = '/onboard/pickup';
const PICKUP_REF_RE = /^vault:pickup:[0-9a-f]{32}$/;
const PICKUP_TTL_MS = 30 * 60_000;
/** At most this many pickup references wait at once; past it the oldest is dropped (a dropped one answers pickup_expired). */
export const PICKUP_REFS_MAX = 256;
/** A JSON body up to this size is read and has its placeholders replaced; a bigger body (a transfer) streams through untouched. */
const SUBST_MAX = 1024 * 1024;
const OP_MAX = 1024 * 1024;

const tagOf = (key) => createHash('sha256').update(`conclave-vault-tag\0${key}`).digest('hex').slice(0, 8);

/** The key file as the connector may read it: the same shape, every key replaced by its placeholder, plus where to relay. */
export function publicView(data, address) {
  const hubs = {};
  for (const [k, s] of Object.entries(data.hubs)) {
    const agents = {};
    for (const [label, a] of Object.entries(s.agents ?? {})) agents[label] = { session_key: agentPlaceholder(label, tagOf(a.session_key)) };
    hubs[k] = { hub_id: s.hub_id, origin: s.origin, ca_sha256: s.ca_sha256, ca_pem: s.ca_pem, app_key: APP_PLACEHOLDER, agents, relay: { address, hub_key: k }, ...(s.disconnected_at ? { disconnected_at: s.disconnected_at } : {}) };
  }
  return { version: 1, hubs };
}

/** Starts the service. `dir` is the vault folder, `view` the path of the public view, `address` where to listen. Returns `{address, close, writeView}`. */
export async function startVault({ dir, view, address, log = () => {} }) {
  const agents = new Map(); // pinned agent per hub key
  const picked = new Map(); // reference -> { hubKey, key, at }: keys from a pickup answer, until put_agent or stage_agent takes them
  /** A pickup answer's keys swapped for references (only `agents[].secret`); null when the answer is not the JSON expected. */
  function keepPicked(hubKey, raw) {
    let a; try { a = JSON.parse(raw); } catch { return null; }
    if (!a || typeof a !== 'object' || !Array.isArray(a.agents)) return null;
    const now = Date.now();
    for (const [r, e] of picked) if (now - e.at > PICKUP_TTL_MS) picked.delete(r);
    for (const x of a.agents) {
      if (!x || typeof x !== 'object' || typeof x.secret !== 'string') continue;
      const ref = `vault:pickup:${randomBytes(16).toString('hex')}`;
      picked.set(ref, { hubKey, key: x.secret, at: now });
      if (picked.size > PICKUP_REFS_MAX) picked.delete(picked.keys().next().value);
      x.secret = ref;
    }
    return JSON.stringify(a);
  }
  /** The key a reference stands for (spent here), or the value itself when it is a key. */
  function keyIn(hubKey, v) {
    if (typeof v !== 'string' || !v.startsWith('vault:pickup:')) return v;
    const e = PICKUP_REF_RE.test(v) ? picked.get(v) : null;
    if (!e || e.hubKey !== hubKey || Date.now() - e.at > PICKUP_TTL_MS) throw Object.assign(new Error('unknown or expired pickup reference'), { reason: 'pickup_expired' });
    return e.key;
  }
  const spend = (v) => { if (typeof v === 'string') picked.delete(v); };
  const agentFor = (k, s) => { let a = agents.get(k); if (!a || a.ca !== s.ca_sha256) { a = { ca: s.ca_sha256, agent: new https.Agent({ ca: s.ca_pem, keepAlive: false, minVersion: 'TLSv1.2', rejectUnauthorized: true }) }; agents.set(k, a); } return a.agent; };

  function writeView() {
    const kf = readKeyFile(dir);
    if (!kf.ok) throw Object.assign(new Error('the vault key file cannot be read'), { reason: kf.reason });
    mkdirSync(dirname(view), { recursive: true });
    const tmp = `${view}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(publicView(kf.data, address)) + '\n', { mode: 0o644 });
    renameSync(tmp, view);
    return kf.data;
  }

  /**
   * A key goes in at exactly two places, so a caller cannot make the hub store or echo one: the `Authorization: Bearer` header
   * (the app key) and a JSON property named `session_key` whose whole value is a placeholder. Anywhere else a placeholder is
   * only text. Null when a placeholder names an agent the section does not have.
   */
  function bearer(v, section) {
    const m = /^Bearer (vault:app)$/.exec(v);
    return m ? `Bearer ${section.app_key}` : v;
  }
  function inBody(node, section) {
    if (Array.isArray(node)) { for (const x of node) if (inBody(x, section) === null) return null; return node; }
    if (!node || typeof node !== 'object') return node;
    for (const [k, v] of Object.entries(node)) {
      if (k === 'session_key' && typeof v === 'string' && /^vault:agent:/.test(v)) {
        const m = /^vault:agent:([A-Za-z0-9][A-Za-z0-9_-]{0,63}):[0-9a-f]{8}$/.exec(v);
        const key = m ? section.agents?.[m[1]]?.session_key : null;
        if (!key) return null;
        node[k] = key;
      } else if (v && typeof v === 'object' && inBody(v, section) === null) return null;
    }
    return node;
  }

  function reply(res, status, obj, extra = {}) {
    const b = Buffer.from(JSON.stringify(obj));
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': b.length, ...extra });
    res.end(b);
  }

  async function relay(req, res, hubKey, rest) {
    const kf = readKeyFile(dir);
    const section = kf.ok ? kf.data.hubs[hubKey] : null;
    if (!section || normalizeOrigin(section.origin) === null || caFingerprint(section.ca_pem) !== section.ca_sha256) return reply(res, 404, { error: 'unknown_hub' });
    if (!RELAY_PATH.test(rest) || rest.includes('..')) return reply(res, 403, { error: 'path_refused' });
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive'].includes(k) || typeof v !== 'string') continue;
      headers[k] = k === 'authorization' ? bearer(v, section) : v;
    }
    const isJson = /json/i.test(req.headers['content-type'] ?? '');
    const len = Number(req.headers['content-length'] ?? '');
    let body = null;
    if (isJson && Number.isFinite(len) && len <= SUBST_MAX) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString('utf8');
      let parsed;
      try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
      if (parsed === undefined) body = Buffer.from(raw);
      else { if (inBody(parsed, section) === null) return reply(res, 400, { error: 'unknown_agent' }); body = Buffer.from(JSON.stringify(parsed)); }
      headers['content-length'] = String(body.length);
    } else if (req.headers['content-length'] !== undefined) headers['content-length'] = req.headers['content-length'];
    else if (req.method !== 'GET' && req.method !== 'HEAD') headers['transfer-encoding'] = 'chunked';
    const pickup = rest === PICKUP;
    if (pickup) delete headers['accept-encoding']; // the answer is read here, so it comes plain
    const out = https.request(`${section.origin}${rest}`, { method: req.method, agent: agentFor(hubKey, section), rejectUnauthorized: true, headers }, (r) => {
      if (pickup) {
        // Never streamed: read whole, its keys kept here, and only then answered (an answer not as expected goes nowhere).
        const chunks = []; let n = 0;
        r.on('data', (c) => { n += c.length; if (n > SUBST_MAX) { r.destroy(); return; } chunks.push(c); });
        r.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          const ok = (r.statusCode ?? 502) === 200;
          const body = ok ? keepPicked(hubKey, raw) : raw;
          if (body === null || n > SUBST_MAX) return reply(res, 502, { error: 'bad_answer' }, { 'x-conclave-relay': 'bad_answer' });
          const b = Buffer.from(body);
          res.writeHead(r.statusCode ?? 502, { 'content-type': r.headers['content-type'] ?? 'application/json', 'content-length': b.length });
          res.end(b);
        });
        r.on('error', () => { if (!res.headersSent) reply(res, 502, { error: 'hub_unreachable' }); else res.destroy(); });
        return;
      }
      const h = { ...r.headers };
      delete h.connection; delete h['keep-alive']; delete h['transfer-encoding'];
      if (r.headers['transfer-encoding']) h['transfer-encoding'] = 'chunked';
      res.writeHead(r.statusCode ?? 502, h);
      r.pipe(res);
      r.on('error', () => res.destroy());
    });
    const fail = (e) => {
      const tls = /certificate|tls|ssl|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(`${e?.code} ${e?.message}`);
      if (!res.headersSent) reply(res, 502, { error: tls ? 'tls_refused' : 'hub_unreachable' }, { 'x-conclave-relay': tls ? 'tls_refused' : 'hub_unreachable' }); else res.destroy();
    };
    out.on('error', fail);
    req.on('aborted', () => out.destroy());
    res.on('close', () => out.destroy());
    if (body) out.end(body); else req.pipe(out);
  }

  const OPS = {
    ping: () => ({ ok: true, hubs: Object.keys(readKeyFile(dir).data?.hubs ?? {}).length }),
    view: () => { const kf = readKeyFile(dir); return kf.ok ? { ok: true, view: publicView(kf.data, address) } : { ok: false, reason: kf.reason }; },
    put_hub: (p) => { const hub_key = putHub(dir, p); writeView(); return { ok: true, hub_key }; },
    put_agent: (p) => { putAgentKey(dir, p.hubKey, p.label, keyIn(p.hubKey, p.sessionKey)); spend(p.sessionKey); writeView(); return { ok: true }; },
    remove_agent: (p) => { const removed = removeAgentKey(dir, p.hubKey, p.label); writeView(); return { ok: true, removed }; },
    // A rotated key waits beside the old one until the hub confirms (keyfile.mjs): staged, then swapped in or dropped.
    stage_agent: (p) => { stageAgentKey(dir, p.hubKey, p.handoverId, p.label, keyIn(p.hubKey, p.sessionKey)); spend(p.sessionKey); return { ok: true }; },
    commit_staged: (p) => { const committed = commitStaged(dir, p.hubKey, p.handoverId); writeView(); return { ok: true, committed }; },
    discard_staged: (p) => ({ ok: true, discarded: discardStaged(dir, p.hubKey, p.handoverId) }),
    /** Which label holds the key with this public id: a label or null, never the key. */
    label_for_key: (p) => { const kf = readKeyFile(dir); return { ok: true, label: kf.ok ? labelIn(kf.data.hubs[p.hubKey], p.keyId) : null }; },
    remove_hub: (p) => { const removed = removeHub(dir, p.hubKey); writeView(); return { ok: true, removed }; },
    mark_disconnected: (p) => { const marked = markDisconnected(dir, p.hubKey, typeof p.at === 'string' ? p.at : undefined); writeView(); return { ok: true, marked }; },
    /** Does this transcript hold the exact key of one agent of one hub (or any agent of it)? A yes or no, never the key. */
    scan: (p) => {
      const kf = readKeyFile(dir);
      const s = kf.ok ? kf.data.hubs[p.hubKey] : null;
      if (!s) return { ok: false, reason: 'unknown_hub' };
      const secrets = [s.app_key, ...(p.label ? [s.agents?.[p.label]?.session_key] : Object.values(s.agents ?? {}).map((a) => a.session_key))];
      const r = scanTranscript(p.path, secrets);
      return r.ok ? { ok: true, found: r.found, kind: r.found ? r.kind : null } : { ok: false, reason: 'unreadable' };
    },
  };

  async function ops(req, res, name) {
    const chunks = []; let n = 0;
    for await (const c of req) { n += c.length; if (n > OP_MAX) return reply(res, 413, { ok: false, reason: 'too_large' }); chunks.push(c); }
    let p = {};
    try { p = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { return reply(res, 400, { ok: false, reason: 'bad_request' }); }
    const f = Object.hasOwn(OPS, name) ? OPS[name] : null;
    if (!f || !p || typeof p !== 'object') return reply(res, 404, { ok: false, reason: 'bad_request' });
    try { return reply(res, 200, await f(p)); } catch (e) { log(`vault: ${name}: ${oneLine(e.message)}`); return reply(res, 200, { ok: false, reason: e.reason ?? 'refused' }); }
  }

  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://vault');
    const m = /^\/relay\/([^/]+)(\/.*)$/.exec(u.pathname);
    const o = /^\/ops\/([a-z_]+)$/.exec(u.pathname);
    const go = m ? relay(req, res, decodeURIComponent(m[1]), m[2] + u.search) : o && req.method === 'POST' ? ops(req, res, o[1]) : Promise.resolve(reply(res, 404, { error: 'not_found' }));
    go.catch((e) => { log(`vault: ${oneLine(e.message)}`); if (!res.headersSent) reply(res, 500, { error: 'vault_error' }); else res.destroy(); });
  });
  server.requestTimeout = 0; // a push stream and a transfer stay open
  writeView();
  if (!WIN) { try { mkdirSync(dirname(address), { recursive: true, mode: 0o755 }); rmSync(address, { force: true }); } catch { /* listen reports it */ } }
  // Everyone local may connect (the connector runs as the PC user); what a connection can do is limited by the operations above.
  await new Promise((ok, no) => { server.once('error', no); server.listen({ path: address, readableAll: true, writableAll: true }, () => { server.off('error', no); ok(); }); });
  if (!WIN) { try { chmodSync(address, 0o666); } catch { /* best effort */ } }
  return {
    address, writeView,
    close: () => new Promise((ok) => { server.closeAllConnections?.(); server.close(() => { if (!WIN) rmSync(address, { force: true }); ok(); }); }),
  };
}

export { findHub, hubKeyOf };
