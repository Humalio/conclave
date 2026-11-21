/**
 * The general limit on the hub's public routes: one address may make so many requests a minute to routes that need no
 * key, session or cookie; over it the hub answers 429 with Retry-After. Requests with a credential, /health and the
 * existing sign-in and pairing limits are untouched.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import { PublicLimiter, publicBucket, limitAddress } from '../src/util/publicLimit.js';
const isPublicRequest = (u: string, h: Record<string, unknown>) => publicBucket(u, h) === 'public';
import { testConfig } from './hub.js';

describe('PublicLimiter', () => {
  it('allows max requests in a window, then limits with the seconds left, then starts again', () => {
    const l = new PublicLimiter({ max: 3, windowMs: 60_000 });
    for (let i = 0; i < 3; i++) expect(l.hit('1.1.1.1', 1_000).limited).toBe(false);
    const r = l.hit('1.1.1.1', 21_000);
    expect(r).toEqual({ limited: true, retryAfterSeconds: 40 });
    expect(l.hit('2.2.2.2', 21_000).limited).toBe(false); // another address has its own count
    expect(l.hit('1.1.1.1', 61_000).limited).toBe(false); // the window has passed
  });
  it('max 0 turns it off', () => {
    const l = new PublicLimiter({ max: 0 });
    for (let i = 0; i < 1000; i++) expect(l.hit('1.1.1.1').limited).toBe(false);
  });
});

describe('release files and the address a request counts against', () => {
  it('release downloads have their own, larger bucket: a whole office updating together is not limited by the general one', () => {
    const l = new PublicLimiter({ max: 300 });
    expect(publicBucket('/connector/v1/release/v1/x.zip', {})).toBe('release');
    // Five PCs behind one address, about 85 files each: 425 release requests pass; the general bucket is untouched.
    for (let i = 0; i < 425; i++) expect(l.hit('10.0.0.1', 1_000, 'release').limited).toBe(false);
    expect(l.hit('10.0.0.1', 1_000, 'public').limited).toBe(false);
    for (let i = 0; i < 6000 - 425; i++) l.hit('10.0.0.1', 1_000, 'release');
    expect(l.hit('10.0.0.1', 1_000, 'release').limited).toBe(true);
  });
  it('counts the forwarded client address only when TRUST_PROXY is set or a relay vouched for it, else the connection address', () => {
    const req = { ip: '203.0.113.9', socket: { remoteAddress: '172.18.0.2' } };
    expect(limitAddress(req, undefined)).toBe('172.18.0.2');
    expect(limitAddress(req, false)).toBe('172.18.0.2');
    expect(limitAddress(req, '172.18.0.0/16')).toBe('203.0.113.9');
    expect(limitAddress(req, true)).toBe('203.0.113.9');
    expect(limitAddress({ ...req, relay: { id: 'r1' } }, undefined)).toBe('203.0.113.9');
  });
});

describe('isPublicRequest', () => {
  it('counts anonymous requests and the public-by-design paths, never /health or a request with a credential', () => {
    expect(isPublicRequest('/', {})).toBe(true);
    expect(isPublicRequest('/onboard/ca.crt', { authorization: 'Bearer x' })).toBe(true);
    expect(isPublicRequest('/connector/v1/pair', { authorization: 'Bearer x' })).toBe(true);
    expect(isPublicRequest('/mcp', {})).toBe(true);
    expect(isPublicRequest('/health', {})).toBe(false);
    expect(publicBucket('/connector/v1/release/v1/x.zip', {})).toBe('release');
    expect(isPublicRequest('/mcp', { authorization: 'Bearer ah_x' })).toBe(false);
    expect(isPublicRequest('/api/pcs', { cookie: 'sid=1' })).toBe(false);
    expect(isPublicRequest('/bridge/poll', { 'x-agent-hub-session': 's' })).toBe(false);
  });
});

describe('the hub limits its public routes per address', () => {
  let app: App; let base: string;
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'publim-'));
    mkdirSync(join(dir, 'vault', 'Notes'), { recursive: true });
    app = await buildApp(testConfig(dir, { publicRequestsPerMinute: 5 }));
    await app.store.ready;
    await app.fastify.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  });
  afterAll(async () => { await app.close(); });

  it('answers 429 with Retry-After after the limit, keeps /health and credentialed requests open', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await fetch(`${base}/onboard/ca.crt`)).status);
    expect(codes).not.toContain(429);
    const over = await fetch(`${base}/onboard/ca.crt`);
    expect(over.status).toBe(429);
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(await over.json()).toMatchObject({ error: 'rate_limited' });
    expect((await fetch(`${base}/`)).status).toBe(429);
    expect((await fetch(`${base}/health`)).status).toBe(200);
    // A request with a session cookie on a non-public path is not counted: the answer comes from the route (401), not the limiter.
    expect((await fetch(`${base}/api/pcs`, { headers: { cookie: 'ah_session=nope' } })).status).toBe(401);
  });
});
