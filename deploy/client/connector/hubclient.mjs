/**
 * The connector's only way to the hub: pinned HTTPS (docs/connector.md, review-v2 §1 point 7).
 *
 * - The origin must be https. There is no plain-HTTP mode and no fallback.
 * - Only the hub's own CA, from the key file section and checked against its recorded fingerprint, is trusted. The
 *   operating system's certificate store is never consulted (Node's `ca` option replaces it), so nothing is installed in
 *   the OS and nothing needs a restart.
 * - A redirect is never followed: it would send the app key to another address.
 * - A failure is mapped to a fixed reason (tls_refused, hub_unreachable), never to the hub's or the library's text.
 */
import https from 'node:https';
import http from 'node:http';
import { Readable } from 'node:stream';
import { caFingerprint, normalizeOrigin, pemBlocks, singleCaPem } from './keyfile.mjs';

const TLS_CODES = new Set(['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'CERT_UNTRUSTED', 'CERT_REVOKED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'HOSTNAME_MISMATCH', 'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_SSL_PACKET_LENGTH_TOO_LONG', 'EPROTO']);
/** The reason code for a transport error. */
export const reasonOfError = (e) => (TLS_CODES.has(e?.code) || /certificate|tls|ssl/i.test(String(e?.message ?? '')) ? 'tls_refused' : 'hub_unreachable');

/**
 * Every request to a hub starts here. At standard it is a pinned HTTPS request. At the hardened level the section carries
 * `relay` (the key service's pipe), and the same request goes there instead: the service puts the real key in where the
 * placeholder is and talks to the hub itself (docs/connector.md, "Hardened isolation"). The callers do not tell the two apart.
 */
function send(hub, url, { method = 'GET', headers = {}, timeout } = {}, cb) {
  if (!hub.relay) return https.request(url, { method, agent: hub.agent, timeout, rejectUnauthorized: true, headers }, cb);
  const u = new URL(url);
  return http.request({ socketPath: hub.relay.address, method, path: `/relay/${encodeURIComponent(hub.relay.hub_key)}${u.pathname}${u.search}`, timeout, headers }, cb);
}
/** The fixed reason when the key service could not reach the hub, else null. */
const relayReason = (hub, r) => (hub.relay && r.statusCode === 502 && /^(tls_refused|hub_unreachable)$/.test(String(r.headers['x-conclave-relay'] ?? '')) ? r.headers['x-conclave-relay'] : null);
export { send };

/** A hub connection from a key-file section: `{ok: true, hub}` or `{ok: false, reason}` before any byte is sent. */
export function connect(section) {
  const origin = normalizeOrigin(section?.origin);
  if (!origin) return { ok: false, reason: 'not_https' };
  // Exactly one pinned certificate: a key-file entry with a second one is refused, never trusted as a bundle.
  if (pemBlocks(section.ca_pem) !== 1) return { ok: false, reason: 'ca_bundle' };
  if (caFingerprint(section.ca_pem) !== section.ca_sha256) return { ok: false, reason: 'ca_changed' };
  return { ok: true, hub: { origin, url: `${origin}/mcp`, agent: new https.Agent({ ca: singleCaPem(section.ca_pem), keepAlive: false, minVersion: 'TLSv1.2', rejectUnauthorized: true }), relay: section.relay && typeof section.relay.address === 'string' && typeof section.relay.hub_key === 'string' ? section.relay : null } };
}

/**
 * One POST of a JSON-RPC body. Resolves `{status, messages, sessionId, body}`: `messages` are the JSON-RPC replies (JSON or
 * SSE); for a non-200 answer `body` is the hub's own JSON, kept for the relay to pass on. Rejects with an error whose
 * `reason` is a fixed reason code.
 */
export function post(hub, body, headers, timeoutMs) {
  return new Promise((res, rej) => {
    const fail = (e) => rej(Object.assign(new Error(e?.message ?? String(e)), { reason: e?.reason ?? reasonOfError(e) }));
    const req = send(hub, hub.url, { method: 'POST', timeout: timeoutMs,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': Buffer.byteLength(body), ...headers } }, (r) => {
      const rr = relayReason(hub, r); if (rr) { r.resume(); return fail({ message: 'the key service could not reach the hub', reason: rr }); }
      if (r.statusCode >= 300 && r.statusCode < 400) { r.resume(); return fail({ message: `redirect ${r.statusCode} not followed`, reason: 'hub_unreachable' }); }
      let raw = '';
      r.setEncoding('utf8');
      r.on('data', (c) => { raw += c; });
      r.on('error', fail);
      r.on('end', () => {
        if (r.statusCode !== 200) {
          let b = null;
          try { b = /^\s*[[{]/.test(raw) ? JSON.parse(raw) : null; } catch { b = null; }
          return res({ status: r.statusCode, messages: [], sessionId: null, body: b });
        }
        const messages = [];
        try {
          if (raw.trim() === '') { /* nothing */ } else if (/^\s*[[{]/.test(raw)) { const j = JSON.parse(raw); messages.push(...(Array.isArray(j) ? j : [j])); } else {
            for (const ev of raw.split(/\r?\n\r?\n/)) {
              const data = ev.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
              if (data) messages.push(JSON.parse(data));
            }
          }
        } catch { return fail({ message: 'the hub sent a reply that is not JSON', reason: 'hub_unreachable' }); }
        // x-agent-hub-tools: the digest of the tools this session lists (docs/mcp.md, "When the list changes").
        res({ status: 200, messages, sessionId: r.headers['mcp-session-id'] ?? null, body: null, tools: typeof r.headers['x-agent-hub-tools'] === 'string' ? r.headers['x-agent-hub-tools'] : null });
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`), { code: 'ETIMEDOUT' })));
    req.on('error', fail);
    req.end(body);
  });
}

/** One hub tool call with the structured result: `{status, data}`. */
export async function callTool(hub, name, args, headers, timeoutMs = 10_000) {
  const r = await post(hub, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), headers, timeoutMs);
  const data = r.messages[0]?.result?.structuredContent;
  return { status: r.status, data: data && typeof data === 'object' ? data : {} };
}

/**
 * One plain request to a `/connector/v1/…` or `/bridge/…` route over the pinned connection: `{status, json}`. A
 * redirect is never followed. Rejects with an error whose `reason` is a fixed reason code.
 */
export function request(hub, method, path, { body, headers = {}, timeoutMs = 15_000 } = {}) {
  return new Promise((res, rej) => {
    const fail = (e) => rej(Object.assign(new Error(e?.message ?? String(e)), { reason: e?.reason ?? reasonOfError(e) }));
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = send(hub, `${hub.origin}${path}`, { method, timeout: timeoutMs,
      headers: { accept: 'application/json', ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...headers } }, (r) => {
      const rr = relayReason(hub, r); if (rr) { r.resume(); return fail({ message: 'the key service could not reach the hub', reason: rr }); }
      if (r.statusCode >= 300 && r.statusCode < 400) { r.resume(); return fail({ message: `redirect ${r.statusCode} not followed`, reason: 'hub_unreachable' }); }
      let raw = '';
      r.setEncoding('utf8');
      r.on('data', (c) => { raw += c; if (raw.length > 4 * 1024 * 1024) r.destroy(new Error('answer too large')); });
      r.on('error', fail);
      r.on('end', () => { let json = null; try { json = raw ? JSON.parse(raw) : null; } catch { json = null; } res({ status: r.statusCode, json }); });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`), { code: 'ETIMEDOUT' })));
    req.on('error', fail);
    req.end(data ?? undefined);
  });
}

/**
 * A `fetch` for the bridge's transfer loop that goes only to this hub, over the pinned CA. It answers a standard
 * Response, streams both ways, honours the abort signal and never follows a redirect (`redirect: 'error'` behaviour).
 */
export function pinnedFetch(hub) {
  return (url, { method = 'GET', headers = {}, body, signal } = {}) => new Promise((res, rej) => {
    const u = new URL(url);
    if (u.origin !== hub.origin) return rej(new TypeError('the pinned fetch only reaches its own hub'));
    if (signal?.aborted) return rej(signal.reason ?? new Error('aborted'));
    const data = body === undefined || body === null ? null : typeof body === 'string' ? Buffer.from(body) : Buffer.from(body.buffer ?? body, body.byteOffset ?? 0, body.byteLength ?? body.length);
    const req = send(hub, u.href, { method, headers: { ...headers, ...(data ? { 'content-length': data.length } : {}) } }, (r) => {
      const rr = relayReason(hub, r); if (rr) { r.resume(); return rej(new TypeError(rr)); }
      if (r.statusCode >= 300 && r.statusCode < 400) { r.resume(); return rej(new TypeError(`redirect ${r.statusCode} not followed`)); }
      const h = new Headers();
      for (const [k, v] of Object.entries(r.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(', ') : String(v));
      const empty = r.statusCode === 204 || r.statusCode === 304 || method === 'HEAD';
      res(new Response(empty ? null : Readable.toWeb(r), { status: r.statusCode, headers: h }));
    });
    const abort = () => req.destroy(signal.reason ?? new Error('aborted'));
    signal?.addEventListener('abort', abort, { once: true });
    req.on('close', () => signal?.removeEventListener('abort', abort));
    req.on('error', rej);
    req.end(data ?? undefined);
  });
}

/**
 * The push stream (`GET /connector/v1/stream`, Server-Sent Events) over the same pinned connection as every other call: the
 * hub's CA only, no redirect, never `fetch`. The hub only says "orders waiting"; `onOrders` is called after the open and at
 * each event, and the caller fetches the orders itself. Resolves `{status, reason}` when the stream ends or cannot open
 * (`status` 0 with a fixed reason for a transport error, the hub's code otherwise); never rejects. A stream silent for `idleMs`
 * (three heartbeats) is dropped.
 */
export function openStream(hub, { headers = {}, signal, onOrders, onEvent, onOpen, idleMs = 65_000, openMs = 15_000, query = '' } = {}) {
  return new Promise((res) => {
    if (signal?.aborted) return res({ status: 0, reason: 'stopped' });
    let done = false, idle, req;
    const OPEN_MS = openMs;
    const end = (v) => { if (done) return; done = true; clearTimeout(idle); signal?.removeEventListener('abort', stop); try { req?.destroy(); } catch { /* gone */ } res(v); };
    const stop = () => end({ status: 0, reason: 'stopped' });
    const arm = (ms = idleMs, reason = 'hub_unreachable') => { clearTimeout(idle); idle = setTimeout(() => end({ status: 0, reason }), ms); };
    arm(OPEN_MS, 'no_open'); // a proxy that holds the stream back never lets it open
    signal?.addEventListener('abort', stop, { once: true });
    req = send(hub, `${hub.origin}/connector/v1/stream${query}`, { method: 'GET', headers: { accept: 'text/event-stream', ...headers } }, (r) => {
      const rr = relayReason(hub, r); if (rr) { r.resume(); return end({ status: 0, reason: rr }); }
      if (r.statusCode !== 200) { r.resume(); return end({ status: r.statusCode, reason: 'refused', retryAfter: Number(r.headers['retry-after']) || null }); }
      arm(); onOpen?.();
      let buf = '';
      r.setEncoding('utf8');
      r.on('data', (c) => {
        arm(); buf += c;
        if (buf.length > 64 * 1024) return end({ status: 0, reason: 'hub_unreachable' });
        let i;
        while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
          const ev = buf.slice(0, i); buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
          const lines = ev.split(/\r?\n/);
          if (lines.some((l) => l.trim() === 'event: orders')) { try { onOrders?.(); } catch { /* the caller's own error */ } }
          // Other events (vault sync's `vault_changed`) carry a small JSON body: they are passed on only when the caller asks.
          const name = /^event:\s*(\S+)/m.exec(ev)?.[1];
          if (name && name !== 'orders' && onEvent) {
            let data = null;
            try { data = JSON.parse(lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n') || 'null'); } catch { /* no body */ }
            try { onEvent(name, data); } catch { /* the caller's own error */ }
          }
        }
      });
      r.on('end', () => end({ status: 200, reason: 'closed' }));
      r.on('error', (e) => end({ status: 0, reason: reasonOfError(e) }));
    });
    req.on('error', (e) => end({ status: 0, reason: reasonOfError(e) }));
    req.end();
  });
}
