/**
 * Onboarding HTTP endpoints (docs/onboarding.md#endpoints): plain HTTPS outside /mcp and /api. Off loopback, plain HTTP
 * is refused with 426, except the public downloads (their hashes, not the transport, make them safe).
 */
import { existsSync, readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { KeyError } from '../keys/keys.js';
import { sha256Hex } from '../util/crypto.js';
import { OnboardError, MAX_WAIT_S, type Onboarding } from './onboarding.js';

/**
 * The files the hub serves under /onboard/client/: only the restore template, which the checkout fills (checkout/render.ts). A PC
 * joins with the connector, which it installs from its release, so the legacy setup script, helper and prompt are no longer served.
 */
export const CLIENT_FILES = ['restore-prompt.md'] as const;

export function findClientDir(explicit?: string): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [explicit, join(here, '../client'), join(here, '../../../deploy/client'), join(process.cwd(), '../deploy/client')].filter(Boolean) as string[];
  return candidates.find((c) => existsSync(join(c, 'restore-prompt.md'))) ?? null;
}

/** Client files and the hub's CA certificate, read from disk on each call (small; an upgrade needs no restart). Line ends are LF. */
export class ClientFiles {
  constructor(private readonly dir: string | null, private readonly caFile?: string) {}
  file(name: string): { text: string; sha256: string } | null {
    if (!this.dir || !(CLIENT_FILES as readonly string[]).includes(name)) return null;
    const p = join(this.dir, name);
    if (!existsSync(p)) return null;
    const text = readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    return { text, sha256: sha256Hex(text) };
  }
  manifest(): Record<string, { sha256: string; bytes: number } | null> {
    const out: Record<string, { sha256: string; bytes: number } | null> = {};
    for (const n of CLIENT_FILES) { const f = this.file(n); out[n] = f ? { sha256: f.sha256, bytes: Buffer.byteLength(f.text) } : null; }
    return out;
  }
  /** The CA certificate (PEM) and its SHA-256 fingerprint: lowercase hex of the DER, as X509Certificate.fingerprint256. */
  ca(): { pem: string; sha256: string } | null {
    if (!this.caFile || !existsSync(this.caFile)) return null;
    const pem = readFileSync(this.caFile, 'utf8');
    try { return { pem, sha256: new X509Certificate(pem).fingerprint256.replace(/:/g, '').toLowerCase() }; } catch { return null; }
  }
}

const STATUS: Record<string, number> = {
  invalid_argument: 400, contains_key: 400, unauthorized: 401, invalid_pairing_code: 401, capability_off: 403, suspended: 403, not_found: 404, denied: 404,
  conflict: 409, invalid_state: 409, invite_refused: 409, checkout_open: 409, handout_changed: 409, scan_pending: 409, lockdown: 423, upgrade_required: 426, rate_limited: 429,
};

const isLoopback = (ip: string) => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip.startsWith('127.');

export function registerOnboarding(f: FastifyInstance, ob: Onboarding, files: ClientFiles, releaseDir?: string): void {
  const send = (reply: FastifyReply, e: unknown) => {
    if (e instanceof KeyError) {
      const extra = e.extra ?? {};
      if (typeof extra.retry_after_s === 'number') reply.header('retry-after', String(extra.retry_after_s));
      if (e.code === 'unauthorized') reply.header('www-authenticate', 'Bearer');
      return reply.code(STATUS[e.code] ?? 400).send({ error: e.code, message: e.message, ...extra });
    }
    throw e;
  };
  /** Enrolment, requests and pickup carry secrets or authority: HTTPS only, off loopback. */
  const httpsOnly = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (req.protocol === 'https' || isLoopback(req.ip)) return true;
    void reply.code(426).header('upgrade', 'TLS/1.2, HTTP/1.1').header('connection', 'Upgrade').send({ error: 'upgrade_required', message: 'Use the hub\'s HTTPS URL; plain HTTP is refused for onboarding.' });
    return false;
  };
  const bearer = (req: FastifyRequest) => { const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? '')); return m ? m[1]! : null; };
  const obj = (b: unknown) => (b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : {});
  const route = (method: 'get' | 'post' | 'put', path: string, fn: (req: FastifyRequest) => unknown) => {
    f[method](path, async (req, reply) => {
      if (!httpsOnly(req, reply)) return reply;
      try { return await fn(req); } catch (e) { return send(reply, e); }
    });
  };

  // ── public downloads (also on the LAN plain-HTTP port) ──
  f.get('/onboard/client/manifest', async () => ({ files: files.manifest(), ca_sha256: files.ca()?.sha256 ?? null }));
  f.get('/onboard/client/:name', async (req, reply) => {
    const name = (req.params as { name: string }).name, file = files.file(name);
    if (!file) return reply.code(404).send({ error: 'not_found', message: 'No such client file on this hub.' });
    const type = name.endsWith('.md') ? 'text/markdown; charset=utf-8' : 'text/javascript; charset=utf-8';
    return reply.type(type).header('x-content-sha256', file.sha256).send(file.text);
  });
  f.get('/onboard/ca.crt', async (_req, reply) => {
    const ca = files.ca();
    if (!ca) return reply.code(404).send({ error: 'not_found', message: 'No CA certificate is configured on this hub (CA_CERT_FILE).' });
    return reply.type('application/x-pem-file').header('x-ca-sha256', ca.sha256).send(ca.pem);
  });

  // ── signed connector releases, for PCs behind a relay (docs/relay.md) ──
  // Public files, like the GitHub release assets they copy: the connector checks the signature and the hashes itself, so the transport proves nothing.
  f.get('/connector/v1/release/:tag/:name', async (req, reply) => {
    const { tag, name } = req.params as { tag: string; name: string };
    const ok = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(tag) && /^conclave-connector-[A-Za-z0-9][A-Za-z0-9._+-]{0,60}\.(bundle|json|json\.sig)$/.test(name);
    const p = releaseDir && ok ? join(releaseDir, name) : null;
    if (!p || !existsSync(p)) return reply.code(404).send({ error: 'not_found', message: 'No such release file on this hub.' });
    return reply.type('application/octet-stream').header('cache-control', 'public, max-age=300').send(readFileSync(p));
  });

  // ── enrolment (the code) ──
  // The code may come in the x-conclave-enrol-code header (the legacy setup script), never in a URL.
  route('post', '/onboard/enrol', (req) => { const b = obj(req.body), h = req.headers['x-conclave-enrol-code']; return ob.enrol((b.code ?? (typeof h === 'string' ? h : undefined)) as string, b.nonce as string, req.ip); });
  route('post', '/onboard/enrol/confirm', (req) => ob.enrolConfirm(obj(req.body).nonce as string, req.ip));

  // ── connector pairing (docs/connector.md, "Pairing"): no key; the code is bound to this hub's id, origin and CA ──
  // Through a registered relay (its secret was verified for this request) the hub the PC pins is the relay: its origin and its CA.
  const pinned = (req: FastifyRequest) => req.relay ? { ...ob.hubInfo(), origin: req.relay.origin, caSha256: req.relay.ca_sha256 } : { ...ob.hubInfo(), caSha256: files.ca()?.sha256 ?? null };
  route('get', '/connector/v1/hub', (req) => { const h = pinned(req); return { hub_id: h.id, origin: h.origin }; });
  route('post', '/connector/v1/pair', (req) => { const b = obj(req.body); return ob.pair(b.pairing_code, { origin: b.hub_origin, caSha256: b.hub_ca_sha256 }, pinned(req), req.ip, { version: b.version, platform: b.platform }); });

  // ── requests (the PC key) ──
  route('post', '/onboard/requests', (req) => ob.file(ob.authApp(bearer(req), req.ip), req.body));
  // After pairing (app key): what the agent may ask about, and an invite's pre-approved join (docs/onboarding.md#the-prompt).
  route('get', '/onboard/choices', (req) => ob.choices(ob.authApp(bearer(req), req.ip)));
  route('post', '/onboard/invites/:id/redeem', (req) => ob.redeemInvite(ob.authApp(bearer(req), req.ip), (req.params as { id: string }).id, req.ip));
  route('get', '/onboard/requests', (req) => ({ requests: ob.pending(ob.authApp(bearer(req), req.ip)) }));
  route('get', '/onboard/requests/:id', async (req) => {
    const app = ob.authApp(bearer(req), req.ip);
    const q = obj(req.query);
    const w = q.wait_s === undefined ? 0 : Number(q.wait_s), v = q.version === undefined ? undefined : Number(q.version);
    if (!Number.isFinite(w) || w < 0 || w > MAX_WAIT_S) throw new OnboardError('invalid_argument', `wait_s: 0 to ${MAX_WAIT_S}`);
    return ob.status(app, (req.params as { id: string }).id, w, Number.isInteger(v) ? v : undefined);
  });
  route('put', '/onboard/requests/:id', (req) => {
    const app = ob.authApp(bearer(req), req.ip);
    const { version, ...rest } = obj(req.body);
    return ob.amend(app, (req.params as { id: string }).id, version, rest);
  });
  // The restore's config scan of each folder, before pickup (docs/checkout.md §6 step 4).
  route('post', '/onboard/requests/:id/scan', (req) => ob.reportScan(ob.authApp(bearer(req), req.ip), (req.params as { id: string }).id, req.body));
  route('post', '/onboard/requests/:id/withdraw', (req) => ob.withdraw(ob.authApp(bearer(req), req.ip), (req.params as { id: string }).id));

  // ── pickup ──
  route('post', '/onboard/pickup', (req) => ob.pickup(ob.authApp(bearer(req), req.ip), obj(req.body).request_id as string, req.ip));
  // Key pickup codes and the Codex wake's key collection ended with the key handover (docs/onboarding.md#key-handover-a-rotated-key-or-a-recruit-reaches-a-connector-pc).
  for (const p of ['/onboard/key-pickup', '/onboard/key-collect/poll', '/onboard/key-collect/confirm']) route('post', p, (req) => { ob.authApp(bearer(req), req.ip); return ob.keyRouteGone(); });
  route('post', '/onboard/pickup/confirm', (req) => { const b = obj(req.body); return ob.confirm(ob.authApp(bearer(req), req.ip), b.pickup_id as string, b.written, b.transport, req.ip); });
}
