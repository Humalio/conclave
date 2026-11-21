/**
 * A general per-address limit for the hub's public routes: the ones anyone can call without a key, session or cookie
 * (the console's pages, the onboarding downloads, pairing; /health is left out so probes never fail). Requests that
 * carry a credential are not counted here; they have their own limits (sign-in, pairing, message and byte limits).
 * The connector release files have a bucket of their own, much larger, because one update fetches about 85 files and
 * several PCs behind one office address may update together.
 * Counts live in memory in one-minute windows: a restart forgets them, which only ever lets one extra burst through.
 */
export interface PublicLimitOptions { max: number; windowMs?: number; releaseFactor?: number }

/** Paths always counted, whatever headers the request carries, because they are public by design. */
const ALWAYS = [/^\/onboard\//, /^\/connector\/v1\/pair(?:[/?]|$)/, /^\/bridge\/pair(?:[/?]|$)/, /^\/vault-sync\/v1\/pair/, /^\/api\/login(?:[/?]|$)/];
const RELEASE = /^\/connector\/v1\/release\//;
const HEALTH = /^\/health(?:[/?]|$)/;
const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'x-agent-hub-session', 'x-conclave-relay-secret'];

/** Which bucket a request counts in: the general one, the release-file one, or none. */
export function publicBucket(url: string, headers: Record<string, unknown>): 'public' | 'release' | null {
  const path = url.split('?')[0] ?? url;
  if (HEALTH.test(path)) return null;
  if (RELEASE.test(path)) return 'release';
  if (ALWAYS.some((r) => r.test(path))) return 'public';
  return CREDENTIAL_HEADERS.some((h) => typeof headers[h] === 'string' && (headers[h] as string) !== '') ? null : 'public';
}

/**
 * The address a request counts against: the client address the proxy reported (`ip`) only when the operator set
 * TRUST_PROXY or a registered relay vouched for it; otherwise the address of the connection itself, which a client
 * cannot choose with a forwarded-for header.
 */
export function limitAddress(req: { ip: string; socket: { remoteAddress?: string }; relay?: unknown }, trustProxy: boolean | string | undefined): string {
  const trusted = req.relay != null || (trustProxy !== undefined && trustProxy !== false && trustProxy !== '');
  return trusted ? req.ip : (req.socket.remoteAddress ?? req.ip);
}

export class PublicLimiter {
  private readonly windowMs: number;
  private readonly hits = new Map<string, { start: number; count: number }>();
  private lastSweep = 0;
  constructor(private readonly opts: PublicLimitOptions) { this.windowMs = opts.windowMs ?? 60_000; }

  /** Counts one request from `ip` in `bucket`; `retryAfterSeconds` is set once the address is over its limit. */
  hit(ip: string, now = Date.now(), bucket: 'public' | 'release' = 'public'): { limited: boolean; retryAfterSeconds: number } {
    if (this.opts.max <= 0) return { limited: false, retryAfterSeconds: 0 };
    const max = bucket === 'release' ? this.opts.max * (this.opts.releaseFactor ?? 20) : this.opts.max;
    if (now - this.lastSweep > this.windowMs) {
      this.lastSweep = now;
      for (const [k, v] of this.hits) if (now - v.start >= this.windowMs) this.hits.delete(k);
    }
    const key = `${bucket}|${ip}`;
    let e = this.hits.get(key);
    if (!e || now - e.start >= this.windowMs) { e = { start: now, count: 0 }; this.hits.set(key, e); }
    e.count++;
    if (e.count <= max) return { limited: false, retryAfterSeconds: 0 };
    return { limited: true, retryAfterSeconds: Math.max(1, Math.ceil((e.start + this.windowMs - now) / 1000)) };
  }
}
