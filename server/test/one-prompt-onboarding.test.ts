/**
 * One-prompt onboarding on the hub (docs/onboarding.md, "The prompt and the request", "Paired just now"; review v2 of the
 * design, v3): the prompt is the same for every PC and never holds the code: the agent asks for it and pipes it to the
 * installer; it says "agent", never a product; New prompt makes a new code and voids the old one, and is refused once the PC has paired; a pairing is a Needs
 * you row with the source address and the connector's version until the operator keeps it or revokes it; Revoke revokes the
 * PC's app key, cancels its open requests and pickups, and revokes the agent keys picked up with that app key, and nothing
 * of another PC.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { REFUSED_CODE_LINE, CODE_RULE_LINE, NO_PIPE_LINE } from '../src/connector/identity.js';
import { testConfig, adminLogin } from './hub.js';
// @ts-expect-error plain JS test helper
import { testCa } from './test-ca.mjs';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const ORIGIN = 'https://hub.test';
let app: App, base = '', cookie = '', csrf = '', caSha = '', releaseDir = '';
let ipSeq = 1;
const freshIp = () => `10.8.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`;

const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
/** A call from the PC (the connector), through the trusted loopback proxy over HTTPS. */
const pcCall = async (method: string, path: string, o: { key?: string; body?: unknown; from?: string } = {}) => {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-forwarded-for': o.from ?? freshIp(), 'x-forwarded-proto': 'https' };
  if (o.key) headers.authorization = `Bearer ${o.key}`;
  const r = await fetch(`${base}${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const pair = (code: string, from?: string) =>
  pcCall('POST', '/connector/v1/pair', { body: { pairing_code: code, hub_origin: ORIGIN, hub_ca_sha256: caSha, platform: 'win32-x64', version: '0.9.7' }, from });
const audits = (action: string) => app.db.prepare('SELECT details FROM audit_events WHERE action=? ORDER BY rowid').all(action).map((r: any) => JSON.parse(r.details));
const keyStatus = (id: string) => (app.db.prepare('SELECT status FROM credentials WHERE id=?').get(id) as { status: string }).status;
const needs = async () => (await api('GET', '/needs-you')).body.items as any[];
let projSeq = 0;
const request = () => ({
  kind: 'new_team', project: { name: `One prompt ${++projSeq}`, existing: false },
  team: { name: `Prompt team ${projSeq}`, goal: 'Keep the grant calendar.' },
  roles: [{ name: 'coordinator', team_role: 'coordinator', count: 1, job: 'Plans and assigns.' }, { name: 'writer', team_role: 'worker', count: 1, job: 'Writes entries.' }],
  prompt: 'a small team', client: { app: 'claude-code', os: 'windows' },
});
/** Add a PC and pair its connector from the given address: the PC, its app key id and secret. */
const addAndPair = async (name: string, from = freshIp()) => {
  const add = (await api('POST', '/pcs/add', { name })).body;
  const p = await pair(add.code, from);
  expect(p.status, JSON.stringify(p.body)).toBe(200);
  return { pc: add.pc.id as string, keyId: add.key.id as string, key: p.body.app_key as string, from };
};
const fileApproved = async (key: string) => {
  const f = await pcCall('POST', '/onboard/requests', { key, body: request() });
  expect(f.status, JSON.stringify(f.body)).toBe(200);
  const a = await api('POST', `/onboarding/${f.body.request_id}/approve`, { version: f.body.version });
  expect(a.status, JSON.stringify(a.body)).toBe(200);
  return f.body.request_id as string;
};

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahprompt-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  const ca = testCa();
  writeFileSync(join(dir, 'ca.pem'), ca.caPem);
  caSha = ca.caSha256;
  releaseDir = join(dir, 'release');
  mkdirSync(releaseDir);
  const config: Config = testConfig(dir, { publicUrl: ORIGIN, caCertFile: join(dir, 'ca.pem'), connectorReleaseDir: releaseDir, connectorReleaseUrl: 'https://github.com/example/conclave/releases/latest', maintenanceSeconds: undefined });
  app = await buildApp(config);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base));
});
afterAll(async () => { await app.close(); });

describe('the Add PC prompt', () => {
  it('never holds the code: the agent asks for it and pipes it to the installer with the hub and its full CA, and names no product', async () => {
    const r = (await api('POST', '/pcs/add', { name: 'prompt-pc' })).body;
    const p: string = r.connector_prompt;
    expect(r.code).toMatch(/^cnc-pair-[a-z2-7]{26}$/);
    expect(p).not.toContain(r.code);
    expect(p).not.toContain('prompt-pc'); // nor the PC: the same text for everyone on this hub
    expect(p).not.toMatch(/cnc-pair-[a-z2-7]/);
    expect(p).toContain(`node conclave-install-<version>.mjs --pair - --hub ${ORIGIN} --ca ${caSha}`);
    expect(p).not.toMatch(/--pair (?!-)/); // the installer never takes the code as an argument
    expect(p).toContain(CODE_RULE_LINE);
    expect(p).toContain(NO_PIPE_LINE);
    expect(p).toContain('conclave setup choices');
    expect(p).toContain('If it says this PC joined the team from an invite, there is nothing to ask: go to step 8. If it says to finish with `conclave setup continue --wait 30`, run that first.');
    expect(p).toContain('You are the agent on this PC.');
    const other = (await api('POST', '/pcs/add', { name: 'prompt-pc-2' })).body;
    expect(other.connector_prompt).toBe(p);
    expect(p).not.toMatch(/Claude|Codex/);
    expect(p).toContain(REFUSED_CODE_LINE);
    expect(p).toContain('Do not try another address.');
    expect(p).toContain('`node --version`');
    expect(p).toContain('certutil -hashfile conclave-install-<version>.mjs SHA256');
    expect(p).toContain('shasum -a 256 conclave-install-<version>.mjs');
    expect(p).toContain('sha256sum conclave-install-<version>.mjs');
    expect(p).toContain('SHA256SUMS'); // no approved version yet, so no file to hash
    expect(p).toContain('conclave setup request --file <path> --check');
  });
  it('names the approved installer and its SHA-256 when the hub holds the file', async () => {
    const body = 'console.log("installer")\n';
    writeFileSync(join(releaseDir, 'conclave-install-0.9.7.mjs'), body);
    expect((await api('POST', '/connector/versions', { version: '0.9.7' })).status).toBe(200);
    expect((await api('POST', '/connector/versions/0.9.7/approve')).status).toBe(200);
    const r = (await api('POST', '/pcs/add', { name: 'prompt-sha' })).body;
    expect(r.connector_prompt).toContain(`It must print ${createHash('sha256').update(body).digest('hex')}.`);
    expect(r.connector_prompt).toContain('`node conclave-install-0.9.7.mjs --pair -');
    expect(r.connector_prompt).toContain('from https://github.com/example/conclave/releases/latest');
  });
});

describe('New prompt', () => {
  it('makes a new code and voids the old one', async () => {
    const r = (await api('POST', '/pcs/add', { name: 'renew-pc' })).body;
    const n = await api('POST', `/pcs/${r.pc.id}/prompt`);
    expect(n.status, JSON.stringify(n.body)).toBe(200);
    expect(n.body.code).not.toBe(r.code);
    expect(n.body.pairing.code).toBe(n.body.code);
    expect(n.body.connector_prompt).not.toContain(n.body.code);
    expect(n.body.connector_prompt).not.toContain(r.code);
    expect(audits('onboarding.code_renew').at(-1)).toMatchObject({ codes_revoked: 1 });
    expect((await pair(r.code)).status).toBe(401);
    expect(audits('connector.pair_refused').at(-1)).toMatchObject({ reason: 'revoked' });
    expect((await pair(n.body.code)).status).toBe(200);
  });
  it('is refused once the PC has paired: Re-enrol PC is the way then', async () => {
    const { pc } = await addAndPair('renew-paired');
    const n = await api('POST', `/pcs/${pc}/prompt`);
    expect(n.status).toBe(409);
    expect(n.body.message).toMatch(/Re-enrol PC/);
  });
});

describe('Paired just now', () => {
  it('is a Needs you row with the address and version until the operator keeps it', async () => {
    const { pc, keyId, from } = await addAndPair('paired-keep');
    expect(audits('connector.paired').at(-1)).toMatchObject({ source: from, version: '0.9.7', platform: 'win32-x64' });
    const row = (await needs()).find((x) => x.kind === 'paired' && x.open.id === pc);
    expect(row).toMatchObject({ title: 'paired-keep paired just now', open: { kind: 'pc', id: pc } });
    expect(row.reason).toBe(`From ${from} · connector 0.9.7 · win32-x64`);
    expect(row.actions.map((a: any) => a.id)).toEqual(['keep', 'revoke']);
    // Revoke asks once, naming what it ends, and its toast says what happened.
    expect(row.actions[1]).toMatchObject({ confirm: "Revoke this PC's pairing? Its agents stop connecting.", done: 'Pairing revoked for paired-keep' });
    expect(row.actions[0].confirm).toBeUndefined();
    // It stays: nothing but the operator's answer takes it away.
    expect((await needs()).some((x) => x.id === row.id)).toBe(true);
    const k = await api('POST', '/needs-you/act', { id: row.id, version: row.source.version, action: 'keep' });
    expect(k.status, JSON.stringify(k.body)).toBe(200);
    expect((await needs()).some((x) => x.id === row.id)).toBe(false);
    expect(keyStatus(keyId)).toBe('active');
    expect((await api('POST', `/pairings/${row.source.id}/revoke`)).status).toBe(409); // decided already
  });
  it('Revoke revokes the app key, cancels open requests and revokes the agent keys picked up with it, and nothing of another PC', async () => {
    const pc = await addAndPair('paired-revoke'), other = await addAndPair('paired-other');
    // A team picked up and confirmed with this app key, then a second request still waiting.
    const rid = await fileApproved(pc.key);
    const up = await pcCall('POST', '/onboard/pickup', { key: pc.key, body: { request_id: rid } });
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    const vars = up.body.agents.map((a: { session_var: string }) => a.session_var);
    expect((await pcCall('POST', '/onboard/pickup/confirm', { key: pc.key, body: { pickup_id: up.body.pickup_id, written: vars } })).status).toBe(200);
    const picked = (app.db.prepare('SELECT s.credential_id id FROM onboarding_slots s WHERE s.request_id=?').all(rid) as { id: string }[]).map((x) => x.id);
    expect(picked).toHaveLength(2);
    const waiting = (await pcCall('POST', '/onboard/requests', { key: pc.key, body: request() })).body.request_id as string;
    // The other PC's team, picked up with its own app key, must not be touched.
    const orid = await fileApproved(other.key);
    const oup = await pcCall('POST', '/onboard/pickup', { key: other.key, body: { request_id: orid } });
    const otherKeys = (app.db.prepare('SELECT credential_id id FROM onboarding_slots WHERE request_id=?').all(orid) as { id: string }[]).map((x) => x.id);
    expect(oup.status).toBe(200);

    const row = (await needs()).find((x) => x.kind === 'paired' && x.open.id === pc.pc);
    const r = await api('POST', '/needs-you/act', { id: row.id, version: row.source.version, action: 'revoke' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.result).toMatchObject({ status: 'revoked', requests_cancelled: 1, agent_keys_revoked: 2 });
    expect(keyStatus(pc.keyId)).toBe('revoked');
    for (const id of picked) expect(keyStatus(id)).toBe('revoked');
    expect((app.db.prepare('SELECT state FROM onboarding_requests WHERE id=?').get(waiting) as { state: string }).state).toBe('cancelled');
    expect((await pcCall('GET', '/connector/v1/setup', { key: pc.key })).status).toBe(401);
    expect(audits('connector.pairing_revoke').at(-1)).toMatchObject({ source: pc.from, requests_cancelled: 1, agents_revoked: 2 });
    expect((await needs()).some((x) => x.id === row.id)).toBe(false);
    // The other PC: its app key and its picked-up keys stay, and its approved request is still there to confirm.
    expect(keyStatus(other.keyId)).toBe('active');
    for (const id of otherKeys) expect(keyStatus(id)).toBe('active');
    expect((app.db.prepare('SELECT state FROM onboarding_requests WHERE id=?').get(orid) as { state: string }).state).toBe('approved');
  });
  it("another PC's app key never picks up this PC's approved request", async () => {
    const a = await addAndPair('auto-a'), b = await addAndPair('auto-b');
    const rid = await fileApproved(a.key);
    expect((await pcCall('POST', '/onboard/pickup', { key: b.key, body: { request_id: rid } })).status).toBe(404);
  });
});
