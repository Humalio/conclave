/**
 * Connector pairing on the hub (docs/connector.md, "Add PC: download and pairing"): one stable hub id; Add PC answers the
 * pairing block with the code and a prompt without it (the agent pipes the code to the installer), or the reason there is none (no CA, no HTTPS origin), never the legacy prompt; the code pairs once, within 30 minutes, only for this hub's origin and CA; a
 * wrong binding voids it; a checkout's code is refused; every refusal is the same 401 sentence; the PC reads its own
 * setup timeline with its app key, Paired done from the moment the code was redeemed.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { hubIdentity, caCheck, HUB_ID_RE, PAIRING_MS } from '../src/connector/identity.js';
import { testConfig, adminLogin } from './hub.js';
// @ts-expect-error plain JS test helper
import { testCa } from './test-ca.mjs';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const ORIGIN = 'https://hub.test';
const REFUSED = 'This pairing code is not valid, has expired or was already used. Make a new code in the console.';
let app: App, base = '', cookie = '', csrf = '', caSha = '';
let ipSeq = 1;
const freshIp = () => `10.7.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`;

const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const cn = async (method: string, path: string, o: { key?: string; body?: unknown; from?: string } = {}) => {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-forwarded-for': o.from ?? freshIp(), 'x-forwarded-proto': 'https' };
  if (o.key) headers.authorization = `Bearer ${o.key}`;
  const r = await fetch(`${base}/connector/v1${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const pair = (code: string, over: Record<string, unknown> = {}, from?: string) =>
  cn('POST', '/pair', { body: { pairing_code: code, hub_origin: ORIGIN, hub_ca_sha256: caSha, platform: 'win32-x64', version: '1.0.0', ...over }, from });
const audits = (action: string) => app.db.prepare('SELECT details FROM audit_events WHERE action=? ORDER BY rowid').all(action).map((r: any) => JSON.parse(r.details));

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahpair-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  const ca = testCa();
  writeFileSync(join(dir, 'ca.pem'), ca.caPem);
  caSha = ca.caSha256;
  const config: Config = testConfig(dir, { publicUrl: ORIGIN, caCertFile: join(dir, 'ca.pem'), maintenanceSeconds: undefined });
  app = await buildApp(config);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base));
});
afterAll(async () => { await app.close(); });

describe('the hub identity', () => {
  it('is made once, kept, and served with the origin before any key', async () => {
    const id = hubIdentity(app.db);
    expect(id).toMatch(HUB_ID_RE);
    expect(hubIdentity(app.db)).toBe(id);
    expect(await cn('GET', '/hub')).toEqual({ status: 200, body: { hub_id: id, origin: ORIGIN } });
  });
  it('the CA check is the first 16 hex characters in groups of four', () => {
    expect(caCheck('0123456789abcdef' + 'f'.repeat(48))).toBe('0123 4567 89ab cdef');
  });
});

describe('Add PC and Re-enrol', () => {
  it('answer the pairing block with the code, and a connector prompt without it', async () => {
    const before = Date.now();
    const r = (await api('POST', '/pcs/add', { name: 'pair-add' })).body;
    expect(r.pairing).toMatchObject({ code: r.code, ca_check: caCheck(caSha), hub_origin: ORIGIN });
    expect(r.pairing.code_expires_at).toBeGreaterThanOrEqual(before + PAIRING_MS);
    expect(r.connector_prompt).toContain('conclave setup request --file <path> --check');
    expect(r.connector_prompt).toContain(`node conclave-install-<version>.mjs --pair - --hub ${ORIGIN} --ca ${caSha}`);
    expect(r.connector_prompt).not.toContain(r.code);
    expect(r.connector_prompt).not.toMatch(/Claude/);
    expect(r.connector_prompt).not.toMatch(/cnv_|cnc-pair-[a-z2-7]/); // no key and no code
    expect(r.connector_unavailable).toBeNull();
    expect(r).not.toHaveProperty('prompt'); // no legacy setup.mjs prompt beside it
    expect(r.connector_version).toBeNull(); // no approved version yet: the console says conclave-install-<version>.mjs
    const re = (await api('POST', `/pcs/${r.pc.id}/re-enrol`)).body;
    expect(re.pairing.code).toBe(re.code);
    expect(re.code).not.toBe(r.code);
    expect(re.connector_prompt).toContain('conclave setup request');
    expect(re).not.toHaveProperty('prompt');
  });
  it('say no_origin, with no prompt at all, on a hub whose public address is not HTTPS', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ahpair-http-'));
    mkdirSync(join(dir, 'vault'), { recursive: true });
    writeFileSync(join(dir, 'ca.pem'), testCa().caPem);
    const plain = await buildApp(testConfig(dir, { publicUrl: 'http://hub.test', caCertFile: join(dir, 'ca.pem'), maintenanceSeconds: undefined }));
    try {
      await plain.store.ready;
      await plain.fastify.listen({ port: 0, host: '127.0.0.1' });
      const at = `http://127.0.0.1:${(plain.fastify.server.address() as { port: number }).port}`, s = await adminLogin(at);
      const post = async (path: string) => (await fetch(`${at}/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: s.cookie, 'x-csrf-token': s.csrf }, body: JSON.stringify({ name: 'plain-pc' }) })).json() as Promise<any>;
      const r = await post('/pcs/add');
      expect(r).toMatchObject({ pairing: null, connector_prompt: null, connector_unavailable: 'no_origin' });
      expect(r).not.toHaveProperty('prompt');
      expect(await post(`/pcs/${r.pc.id}/re-enrol`)).toMatchObject({ pairing: null, connector_prompt: null, connector_unavailable: 'no_origin' });
    } finally { await plain.close(); }
  });
});

describe('Add PC names the installer version', () => {
  it('is the newest approved connector version, never a pending or refused one', async () => {
    for (const v of ['0.9.4', '0.9.5', '0.9.6']) expect((await api('POST', '/connector/versions', { version: v })).status).toBe(200);
    expect((await api('POST', '/connector/versions/0.9.4/approve')).status).toBe(200);
    expect((await api('POST', '/connector/versions/0.9.5/approve')).status).toBe(200);
    expect((await api('POST', '/connector/versions/0.9.6/refuse')).status).toBe(200);
    expect((await api('POST', '/pcs/add', { name: 'pair-ver' })).body.connector_version).toBe('0.9.5');
  });
});

describe('POST /connector/v1/pair', () => {
  it('pairs once with the matching origin and CA, and a second redeem is refused', async () => {
    const r = (await api('POST', '/pcs/add', { name: 'pair-ok' })).body;
    const ok = await pair(r.code);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ hub: { id: hubIdentity(app.db), origin: ORIGIN }, pc: { id: r.pc.id, name: 'pair-ok' } });
    expect(ok.body.app_key).toMatch(/\S{20,}/);
    // The app key works at once: the PC's own setup timeline, Paired done from the redeem.
    const t = await cn('GET', '/setup', { key: ok.body.app_key });
    expect(t.status).toBe(200);
    expect(t.body.steps[1]).toMatchObject({ step: 'paired', state: 'done' });
    const again = await pair(r.code);
    expect(again).toEqual({ status: 401, body: { error: 'invalid_pairing_code', message: REFUSED } });
    expect(audits('connector.pair_refused').at(-1)).toMatchObject({ reason: 'used' });
    expect(JSON.stringify(audits('connector.paired'))).not.toContain(r.code);
  });
  it('a wrong CA or origin pairs nothing and voids the code', async () => {
    const a = (await api('POST', '/pcs/add', { name: 'pair-ca' })).body;
    expect(await pair(a.code, { hub_ca_sha256: 'ab'.repeat(32) })).toMatchObject({ status: 401, body: { message: REFUSED } });
    expect(audits('connector.pair_refused').at(-1)).toMatchObject({ reason: 'wrong_hub', voided: true });
    expect((await pair(a.code)).status).toBe(401); // voided: the right binding no longer helps
    const b = (await api('POST', '/pcs/add', { name: 'pair-origin' })).body;
    expect((await pair(b.code, { hub_origin: 'https://evil.test' })).status).toBe(401);
    expect((await pair(b.code)).status).toBe(401);
  });
  it('refuses a code older than 30 minutes', async () => {
    const r = (await api('POST', '/pcs/add', { name: 'pair-old' })).body;
    app.db.prepare('UPDATE enrolment_codes SET created_at=created_at-? WHERE machine_id=?').run(PAIRING_MS + 1000, r.pc.id);
    expect((await pair(r.code)).status).toBe(401);
    expect(audits('connector.pair_refused').at(-1)).toMatchObject({ reason: 'expired' });
  });
  it("refuses a checkout's code and an unknown code with the same sentence", async () => {
    const r = (await api('POST', '/pcs/add', { name: 'pair-co' })).body;
    app.db.prepare('UPDATE enrolment_codes SET expires_at=? WHERE machine_id=?').run(Date.now() + PAIRING_MS, r.pc.id);
    expect(await pair(r.code)).toEqual({ status: 401, body: { error: 'invalid_pairing_code', message: REFUSED } });
    expect(audits('connector.pair_refused').at(-1)).toMatchObject({ reason: 'checkout_code' });
    expect(await pair('cnc-pair-' + 'a'.repeat(26))).toEqual({ status: 401, body: { error: 'invalid_pairing_code', message: REFUSED } });
    expect(await pair('nonsense')).toEqual({ status: 401, body: { error: 'invalid_pairing_code', message: REFUSED } });
  });
  it('rate-limits failures from one address', async () => {
    const from = freshIp();
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await pair('cnc-pair-' + 'b'.repeat(26), {}, from)).status;
    expect(last).toBe(429);
  });
  it('the setup timeline needs the app key', async () => {
    expect((await cn('GET', '/setup')).status).toBe(401);
  });
});
