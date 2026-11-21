/**
 * One-prompt onboarding (docs/onboarding.md): Add PC and the enrolment code, requests over /onboard/requests, the one
 * approval, the one-time pickup, Re-enrol PC, settings and rate limits, HTTPS-only endpoints, served client files.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { sha256Hex } from '../src/util/crypto.js';
import { CLIENT_FILES, findClientDir } from '../src/onboarding/http.js';
import { testConfig, adminLogin } from './hub.js';
import { mdPlain } from '../public/md.js';

let app: App, base: string, cookie = '', csrf = '', dir = '';
const sys = { kind: 'system' as const, id: null };

const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
/** A call to /onboard/*; from= sets the client address (through the trusted loopback proxy), proto= its scheme. */
const ob = async (method: string, path: string, o: { key?: string; body?: unknown; from?: string; proto?: string } = {}) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (o.key) headers.authorization = `Bearer ${o.key}`;
  if (o.from) { headers['x-forwarded-for'] = o.from; headers['x-forwarded-proto'] = o.proto ?? 'https'; }
  const r = await fetch(`${base}/onboard${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  const text = await r.text();
  let body: any; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body, headers: r.headers };
};
const nonce = () => `n${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`.slice(0, 24).padEnd(20, 'x');
let ipSeq = 1;
const freshIp = () => `10.9.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`;

/** Add a PC and enrol it: returns the PC id, the app key secret and the code. */
const addAndEnrol = async (name: string) => {
  const add = await api('POST', '/pcs/add', { name });
  expect(add.status).toBe(200);
  const n = nonce(), from = freshIp();
  const e = await ob('POST', '/enrol', { body: { code: add.body.code, nonce: n }, from });
  expect(e.status).toBe(200);
  expect((await ob('POST', '/enrol/confirm', { body: { nonce: n }, from })).status).toBe(200);
  return { pc: add.body.pc.id as string, key: e.body.app_key as string, code: add.body.code as string, keyId: add.body.key.id as string };
};
let projSeq = 0;
const request = (over: Record<string, unknown> = {}) => ({
  kind: 'new_team', project: { name: `Proj ${++projSeq}`, existing: false },
  team: { name: `Team ${projSeq}`, goal: 'Keep the grant calendar.' },
  roles: [
    { name: 'coordinator', team_role: 'coordinator', count: 1, job: 'Plans and assigns.' },
    { name: 'writer', team_role: 'worker', count: 2, job: 'Writes entries.', folders: [{ path: '/vault/Grants', access: 'write' }] },
    { name: 'reviewer', team_role: 'reviewer', count: 1, job: 'Reviews entries.', reviews: ['writer'] },
  ],
  prompt: 'a team that keeps our grant calendar, with writers and a reviewer',
  client: { app: 'claude-code', os: 'windows' },
  ...over,
});
const fileApproved = async (key: string, over: Record<string, unknown> = {}, approve: Record<string, unknown> = {}) => {
  const f = await ob('POST', '/requests', { key, body: request(over) });
  expect(f.status, JSON.stringify(f.body)).toBe(200);
  const a = await api('POST', `/onboarding/${f.body.request_id}/approve`, { version: f.body.version, ...approve });
  expect(a.status, JSON.stringify(a.body)).toBe(200);
  return f.body.request_id as string;
};
const login = async (appKey: string, secret: string) => {
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  return (await c.callTool({ name: 'session_login', arguments: { session_key: secret } })) as { isError?: boolean };
};
const alerts = (type: string) => app.db.prepare('SELECT * FROM security_alerts WHERE type=?').all(type) as { subject: string; details: string }[];
/** Open or acknowledged alerts of a type for one subject: the ones still asking the operator. */
const asking = (type: string, subject: string) => (app.db.prepare("SELECT COUNT(*) n FROM security_alerts WHERE type=? AND subject=? AND status IN ('open','acknowledged')").get(type, subject) as { n: number }).n;
/** A connector route with the PC's app key. */
const cnr = async (method: string, path: string, key: string, body?: unknown) => {
  const r = await fetch(`${base}/connector/v1${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'x-forwarded-for': freshIp(), 'x-forwarded-proto': 'https' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const auditOf = (action: string) => app.db.prepare('SELECT * FROM audit_events WHERE action=?').all(action) as { details: string }[];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ahonb-'));
  mkdirSync(join(dir, 'vault', 'Grants'), { recursive: true });
  const client = join(dir, 'client');
  mkdirSync(client);
  // The restore template is the only file the hub serves; the legacy files sit beside it to show they are not served.
  writeFileSync(join(client, 'restore-prompt.md'), 'Restore {{TEAM_NAME}}\r\n');
  writeFileSync(join(client, 'agent-hub-headers.mjs'), 'export const helper = 1;\n');
  writeFileSync(join(client, 'setup.mjs'), 'export const setup = 1;\n');
  writeFileSync(join(client, 'onboarding-prompt.md'), 'Hub {{HUB_URL}} code {{ENROL_CODE}}\n');
  const config: Config = testConfig(dir, { publicUrl: 'https://hub.test', clientDir: client, maintenanceSeconds: undefined });
  app = await buildApp(config);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base));
});
afterAll(async () => { await app.close(); });

describe('client files and the prompt', () => {
  it('serves only the restore template, with its hash, also over plain HTTP; the legacy setup files are not served', async () => {
    const h = await ob('GET', '/client/restore-prompt.md', { from: '192.0.2.50', proto: 'http' });
    expect(h.status).toBe(200);
    expect(h.body).toBe('Restore {{TEAM_NAME}}\n'); // LF, whatever the checkout
    expect(h.headers.get('x-content-sha256')).toBe(sha256Hex('Restore {{TEAM_NAME}}\n'));
    for (const f of ['setup.mjs', 'agent-hub-headers.mjs', 'onboarding-prompt.md', 'other.mjs']) expect((await ob('GET', `/client/${f}`)).status, f).toBe(404);
    const m = await ob('GET', '/client/manifest');
    expect(m.body.files).toEqual({ 'restore-prompt.md': { sha256: sha256Hex('Restore {{TEAM_NAME}}\n'), bytes: 22 } });
    expect((await ob('GET', '/ca.crt')).status).toBe(404); // no CA_CERT_FILE in this test
  });
  it('finds the client folder by the restore template, not by the legacy helper', () => {
    expect(CLIENT_FILES).toEqual(['restore-prompt.md']);
    const only = mkdtempSync(join(tmpdir(), 'ahonb-rp-'));
    writeFileSync(join(only, 'restore-prompt.md'), 'x\n');
    expect(findClientDir(only)).toBe(only);
    const legacy = mkdtempSync(join(tmpdir(), 'ahonb-lg-'));
    writeFileSync(join(legacy, 'agent-hub-headers.mjs'), 'x\n');
    expect(findClientDir(legacy)).not.toBe(legacy);
  });
  it('Add PC and Re-enrol return the code but no legacy prompt, and say why there is no connector prompt; the code is stored only as a verifier', async () => {
    const add = await api('POST', '/pcs/add', { name: 'prompt-pc' });
    expect(add.body.code).toMatch(/^cnc-pair-[a-z2-7]{26}$/);
    expect(add.body).not.toHaveProperty('prompt');
    // This hub serves no CA certificate, so nothing can be pinned: no pairing, no connector prompt, and the reason.
    expect(add.body).toMatchObject({ pairing: null, connector_prompt: null, connector_unavailable: 'no_ca' });
    const re = await api('POST', `/pcs/${(await api('POST', '/pcs/add', { name: 'prompt-pc-re' })).body.pc.id}/re-enrol`);
    expect(re.body).not.toHaveProperty('prompt');
    expect(re.body).toMatchObject({ pairing: null, connector_prompt: null, connector_unavailable: 'no_ca' });
    expect(add.body.key.onboarding_enabled_at).toBeTypeOf('number');
    const dump = JSON.stringify(app.db.prepare('SELECT * FROM enrolment_codes').all());
    expect(dump).not.toContain(add.body.code);
    expect(auditOf('pc.add').length).toBeGreaterThan(0);
    expect((await api('GET', `/pcs/${add.body.pc.id}/enrolment`)).body.enrolment.status).toBe('unused');
  });
});

describe('enrolment code', () => {
  it('swaps once; a retry with the same nonce reissues and kills the previous secret; reuse after confirm is refused and alerts', async () => {
    const add = await api('POST', '/pcs/add', { name: 'enrol-pc' });
    const n = nonce(), from = freshIp();
    const a = await ob('POST', '/enrol', { body: { code: add.body.code, nonce: n }, from });
    expect(a.status).toBe(200);
    expect(a.body.app_key).toMatch(/^ah_app_/);
    expect(a.body.pc.name).toBe('enrol-pc');
    const b = await ob('POST', '/enrol', { body: { code: add.body.code, nonce: n }, from });
    expect(b.status).toBe(200);
    expect(b.body.app_key).not.toBe(a.body.app_key);
    expect(() => app.keys.verifyKey(a.body.app_key, 'app_key')).toThrow();
    expect(app.keys.verifyKey(b.body.app_key, 'app_key').id).toBe(add.body.key.id);
    // another nonce before confirm: someone else holds the code
    const other = await ob('POST', '/enrol', { body: { code: add.body.code, nonce: nonce() }, from: freshIp() });
    expect(other.status).toBe(409);
    expect((await ob('POST', '/enrol/confirm', { body: { nonce: n }, from })).status).toBe(200);
    const again = await ob('POST', '/enrol', { body: { code: add.body.code, nonce: n }, from });
    expect(again.status).toBe(409);
    expect(again.body.message).toMatch(/already used/);
    expect(alerts('enrolment_code_reused').some((x) => x.subject === add.body.pc.id)).toBe(true);
    expect(app.keys.verifyKey(b.body.app_key, 'app_key').id).toBe(add.body.key.id); // nothing issued
    expect(JSON.stringify(app.db.prepare('SELECT * FROM credentials').all())).not.toContain(b.body.app_key.split('_')[3]);
  });
  it('locks an address out after 10 failed codes and alerts', async () => {
    const from = freshIp();
    for (let i = 0; i < 10; i++) expect((await ob('POST', '/enrol', { body: { code: 'cnc-pair-aaaaaaaaaaaaaaaaaaaaaaaaaa', nonce: nonce() }, from })).status).toBe(401);
    const r = await ob('POST', '/enrol', { body: { code: 'cnc-pair-aaaaaaaaaaaaaaaaaaaaaaaaaa', nonce: nonce() }, from });
    expect(r.status).toBe(429);
    expect(r.body.retry_after_s).toBeGreaterThan(0);
    expect(alerts('enrol_fail').some((x) => x.subject === from)).toBe(true);
  });
  it('revoking an unused code makes it worthless', async () => {
    const add = await api('POST', '/pcs/add', { name: 'revoke-pc' });
    expect((await api('DELETE', `/pcs/${add.body.pc.id}/enrolment`)).status).toBe(200);
    expect((await ob('POST', '/enrol', { body: { code: add.body.code, nonce: nonce() }, from: freshIp() })).status).toBe(401);
  });
  it('the console reads every PC\'s onboarding state in one call: code state and pending requests', async () => {
    const fresh = await api('POST', '/pcs/add', { name: 'state-pc-1' });
    const e = await addAndEnrol('state-pc-2');
    await ob('POST', '/requests', { key: e.key, body: request() });
    const L = (await api('GET', '/onboarding/pcs')).body.pcs as { machine_id: string; enrolment: { status: string } | null; pending: number }[];
    expect(L.find((x) => x.machine_id === fresh.body.pc.id)).toMatchObject({ enrolment: { status: 'unused' }, pending: 0 });
    expect(L.find((x) => x.machine_id === e.pc)).toMatchObject({ enrolment: { status: 'confirmed' }, pending: 1 });
    expect(JSON.stringify(L)).not.toContain(fresh.body.code);
  });
});

describe('HTTPS only', () => {
  it('refuses plain HTTP off loopback with 426 and accepts HTTPS through the proxy', async () => {
    const add = await api('POST', '/pcs/add', { name: 'tls-pc' });
    const plain = await ob('POST', '/enrol', { body: { code: add.body.code, nonce: nonce() }, from: '192.0.2.60', proto: 'http' });
    expect(plain.status).toBe(426);
    expect(plain.body.error).toBe('upgrade_required');
    expect((await ob('POST', '/pickup', { body: { request_id: 'x' }, from: '192.0.2.60', proto: 'http' })).status).toBe(426);
    expect((await ob('GET', '/requests', { from: '192.0.2.60', proto: 'http' })).status).toBe(426);
    expect((await ob('POST', '/enrol', { body: { code: add.body.code, nonce: nonce() }, from: '192.0.2.60', proto: 'https' })).status).toBe(200);
  });
});

describe('requests', () => {
  it('validates with field paths and rules, and limits from Settings', async () => {
    const pc = await addAndEnrol('valid-pc');
    const bad = await ob('POST', '/requests', { key: pc.key, body: request({ roles: [{ name: 'Bad Name', team_role: 'boss', count: 9, job: '' }], project: { name: '-x', existing: true } }) });
    expect(bad.status).toBe(400);
    const fields = bad.body.problems.map((p: { field: string }) => p.field);
    expect(fields).toEqual(expect.arrayContaining(['roles[0].name', 'roles[0].team_role', 'roles[0].count', 'roles[0].job', 'project.name']));
    expect((await api('PUT', '/settings/onboarding', { max_agents: 3 })).body.settings.max_agents).toBe(3);
    const big = await ob('POST', '/requests', { key: pc.key, body: request() });
    expect(big.status).toBe(400);
    expect(big.body.message).toMatch(/4 agents, at most 3/);
    expect((await api('PUT', '/settings/onboarding', { max_agents: 12 })).status).toBe(200);
    expect((await api('PUT', '/settings/onboarding', { max_agents: 0 })).status).toBe(400);
    expect((await api('GET', '/settings/onboarding')).body.settings).toEqual({ max_roles: 8, max_agents: 12, max_per_role: 5, max_rules: 20, max_requirements: 30, file_per_hour: 5, file_per_day: 20 });
  });

  it('a role\'s job line may be up to 500 characters, one line (it becomes the agent\'s role description)', async () => {
    const withJob = (job: string) => request({ roles: [{ name: 'coordinator', team_role: 'coordinator', count: 1, job }] });
    const problems = (r: { body: { problems?: { field: string; rule: string }[] } }) => (r.body.problems ?? []).filter((p) => p.field === 'roles[0].job').map((p) => p.rule);
    const pc = await addAndEnrol('job-pc');
    const long = await ob('POST', '/requests', { key: pc.key, body: withJob('j'.repeat(501)) });
    expect(long.status).toBe(400);
    expect(problems(long)).toEqual(['1–500 characters']);
    const broken = await ob('POST', '/requests', { key: pc.key, body: withJob('Plans the work.\nAnd assigns it.') });
    expect(broken.status).toBe(400);
    expect(problems(broken)).toEqual(['one line']);
    const ok = await ob('POST', '/requests', { key: pc.key, body: withJob('j'.repeat(500)) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(JSON.stringify((await api('GET', `/onboarding/${ok.body.request_id}`)).body)).toContain('j'.repeat(500));
  });
  it('one pending request per key, the refusal naming it; warnings for missing folders; long poll returns on a change', async () => {
    const pc = await addAndEnrol('pending-pc');
    const f = await ob('POST', '/requests', { key: pc.key, body: request({ roles: [
      { name: 'coordinator', team_role: 'coordinator', count: 1, job: 'Plans.' },
      { name: 'dev', team_role: 'worker', count: 1, job: 'Builds.', folders: [{ path: '/vault/Nope', access: 'read' }] }] }) });
    expect(f.status).toBe(200);
    expect(f.body.state).toBe('submitted');
    expect(f.body.warnings.map((w: { code: string }) => w.code)).toContain('folder_missing');
    const second = await ob('POST', '/requests', { key: pc.key, body: request() });
    expect(second.status).toBe(409);
    expect(second.body.message).toContain(f.body.request_id);
    expect(second.body.message).toMatch(/waiting for the approval/);
    expect((await ob('GET', '/requests?pending=1', { key: pc.key })).body.requests).toHaveLength(1);
    const t0 = Date.now();
    const poll = ob('GET', `/requests/${f.body.request_id}?wait_s=20`, { key: pc.key });
    await new Promise((r) => setTimeout(r, 200));
    expect((await api('POST', `/onboarding/${f.body.request_id}/needs-changes`, { note: 'Name the dev role developer.' })).status).toBe(200);
    const p = await poll;
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(p.body.state).toBe('needs_changes');
    expect(p.body.operator_note).toBe('Name the dev role developer.');
    const openFor = () => (app.db.prepare("SELECT COUNT(*) n FROM security_alerts WHERE type='onboarding_request' AND subject=? AND status='open'").get(f.body.request_id) as { n: number }).n;
    expect(openFor()).toBe(0); // sent back: it waits on the PC
    // amend: a stale version conflicts; the current one goes back to submitted
    expect((await ob('PUT', `/requests/${f.body.request_id}`, { key: pc.key, body: { ...request(), version: 1 } })).status).toBe(409);
    const am = await ob('PUT', `/requests/${f.body.request_id}`, { key: pc.key, body: { ...request(), version: p.body.version } });
    expect(am.status, JSON.stringify(am.body)).toBe(200);
    expect(am.body.state).toBe('submitted');
    expect(openFor()).toBe(1); // amended: it waits for the operator again
    const w = await ob('POST', `/requests/${f.body.request_id}/withdraw`, { key: pc.key });
    expect(w.body.state).toBe('withdrawn');
    expect(openFor()).toBe(0);
    // a sixth filing-type call this hour (file, refused file, 2 amends, withdraw): over the 5-an-hour budget
    expect((await ob('POST', `/requests/${f.body.request_id}/withdraw`, { key: pc.key })).status).toBe(429);
    expect(app.onboarding.request(f.body.request_id)!.state).toBe('withdrawn');
    // another PC cannot read it
    const other = await addAndEnrol('pending-other');
    expect((await ob('GET', `/requests/${f.body.request_id}`, { key: other.key })).status).toBe(404);
  });
  it('filing, amending and withdrawing share the per-key budget (refused calls count); capability off refuses filing, status stays readable', async () => {
    const pc = await addAndEnrol('rate-pc');
    const f = await ob('POST', '/requests', { key: pc.key, body: request() });
    for (let i = 0; i < 4; i++) expect((await ob('POST', '/requests', { key: pc.key, body: request() })).status).toBe(409);
    const limited = await ob('POST', '/requests', { key: pc.key, body: request() });
    expect(limited.status).toBe(429);
    expect(limited.body.retry_after_s).toBeGreaterThan(0);
    expect((await api('DELETE', `/keys/${pc.keyId}/onboarding`)).body.key.onboarding_enabled_at).toBeNull();
    expect((await ob('GET', `/requests/${f.body.request_id}`, { key: pc.key })).status).toBe(200);
    expect((await ob('POST', '/pickup', { key: pc.key, body: { request_id: f.body.request_id } })).status).toBe(403);
    expect((await api('PUT', `/keys/${pc.keyId}/onboarding`)).body.key.onboarding_enabled_at).toBeTypeOf('number');
  });
  it('refuses a request carrying a Conclave key and alerts', async () => {
    const pc = await addAndEnrol('leak-pc');
    const r = await ob('POST', '/requests', { key: pc.key, body: request({ prompt: `use ${pc.key} please` }) });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('contains_key');
    expect(alerts('credential_leak').some((a) => a.subject === pc.keyId)).toBe(true);
    expect(app.db.prepare('SELECT COUNT(*) n FROM onboarding_requests WHERE app_credential_id=?').get(pc.keyId)).toEqual({ n: 0 });
  });
  it('wrong or missing PC keys are refused and audited', async () => {
    expect((await ob('GET', '/requests', { key: 'ah_app_aaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' })).status).toBe(401);
    expect((await ob('GET', '/requests')).status).toBe(401);
  });
});

/**
 * The console's Home list of what waits for the operator (public/app.js urgent()), run in vm on the hub's own request list.
 * Only the helpers it calls are loaded; everything else on Home is empty.
 */
/** The line Home's Needs you row shows under its title (app.js nyMeta), for a row of GET /needs-you. */
const homeMeta = (r: unknown) => {
  const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
  const at = (s: string) => { const i = js.indexOf(`\n${s}`); if (i < 0) throw new Error(`app.js has no ${s}`); return i + 1; };
  const part = (s: string, end: string) => { const i = at(s); return js.slice(i, js.indexOf(end, i) + end.length); };
  const src = [part('const ago = ', '\n'), part('const cap = ', '\n'), part('const NY_KIND = ', '};\n'), part('const nyKind = ', '\n'), part('const nyUntil = ', '\n'), part('const nyOffline = ', '\n'), part('const nySum = ', '\n'), part('const nyMeta = ', '\n'), 'nyMeta(r);'].join('\n');
  return vm.runInNewContext(src, { r, Date, mdPlain }) as string;
};

describe('keys and requests: acceptance checks', () => {
  it('FR-KEYS-03/AC1: a key\'s secret cannot be read back after creation', async () => {
    const r = await api('POST', '/keys', { kind: 'session_key', new_agent: { label: 'secret-once' }, label: 'secret-once key' });
    expect([200, 201], JSON.stringify(r.body)).toContain(r.status);
    const secret = r.body.secret as string, id = r.body.key.id as string;
    const [, , keyId, tail] = secret.split('_');
    expect(tail && tail.length).toBeGreaterThan(10);
    // The console's key view and list show the masked public id only.
    const one = await api('GET', `/keys/${id}`), all = await api('GET', '/keys?kind=session_key');
    expect(one.body.key.masked_key).toBe(`ah_ses_${keyId}_…`);
    for (const body of [one.body, all.body]) { expect(JSON.stringify(body)).not.toContain(tail); expect(JSON.stringify(body)).not.toContain(secret); }
    // The database holds the public id and a verifier, never the secret.
    const row = app.db.prepare('SELECT * FROM credentials WHERE id=?').get(id) as Record<string, unknown>;
    expect(row.key_id).toBe(keyId);
    expect(row.verifier).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(tail);
    const everything = JSON.stringify(app.db.prepare('SELECT * FROM credentials').all()) + JSON.stringify(app.db.prepare('SELECT * FROM audit_events').all());
    expect(everything).not.toContain(tail);
  });

  it('NFR-SEC-04: a key revocation shows in the audit', async () => {
    const r = await api('POST', '/keys', { kind: 'session_key', new_agent: { label: 'revoke-audit' }, label: 'revoke-audit key' });
    const id = r.body.key.id as string, before = Date.now();
    expect((await api('POST', `/keys/${id}/revoke`)).status).toBe(200);
    const adminId = (app.db.prepare('SELECT id FROM admin_users LIMIT 1').get() as { id: string }).id;
    const ev = (await api('GET', `/audit?target=${id}`)).body.events.find((e: { action: string }) => e.action === 'key.revoke');
    expect(ev, 'a key.revoke event for the key').toBeTruthy();
    expect(ev).toMatchObject({ actor_kind: 'admin', actor_id: adminId, target_kind: 'credential', target_id: id });
    expect(ev.created_at).toBeGreaterThanOrEqual(before);
    expect(ev.created_at).toBeLessThanOrEqual(Date.now());
  });

  it('FR-ONB-04/AC2: denying a request leaves nothing behind', async () => {
    const pc = await addAndEnrol('deny-nothing-pc');
    const count = () => Object.fromEntries(['projects', 'teams', 'agents', 'credentials'].map((t) => [t, (app.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n]));
    const before = count();
    const f = await ob('POST', '/requests', { key: pc.key, body: request() });
    expect(f.status, JSON.stringify(f.body)).toBe(200);
    const d = await api('POST', `/onboarding/${f.body.request_id}/deny`, { note: 'Not this quarter.' });
    expect(d.body.request.state).toBe('denied');
    const st = await ob('GET', `/requests/${f.body.request_id}`, { key: pc.key });
    expect(st.body).toMatchObject({ state: 'denied', operator_note: 'Not this quarter.' });
    expect(count()).toEqual(before);
    expect(app.db.prepare('SELECT team_id FROM onboarding_requests WHERE id=?').get(f.body.request_id)).toEqual({ team_id: null });
  });
});

describe('FR-ONB-03: a waiting request stays in view and does not expire', () => {
  it('FR-ONB-03/AC1: a waiting request shows on Home with its age and does not expire', async () => {
    const pc = await addAndEnrol('lab-pc-3d');
    const f = await ob('POST', '/requests', { key: pc.key, body: request() });
    expect(f.status, JSON.stringify(f.body)).toBe(200);
    const id = f.body.request_id as string;
    // Filed three days ago and not decided.
    const then = Date.now() - 3 * 86_400_000 - 60_000;
    app.db.prepare('UPDATE onboarding_requests SET filed_at=?, waiting_since=?, updated_at=? WHERE id=?').run(then, then, then, id);
    app.db.prepare("UPDATE security_alerts SET created_at=? WHERE type='onboarding_request' AND subject=?").run(then, id);
    // Nothing pending expires: a maintenance pass leaves the request waiting and its alert open.
    app.maintenance.prune();
    expect(app.onboarding.list('pending').find((q) => q.id === id)).toMatchObject({ state: 'submitted', waiting_since: then, pc: { id: pc.pc, name: 'lab-pc-3d' } });
    expect(asking('onboarding_request', id)).toBe(1);
    const al = (await api('GET', `/alerts?status=open&credential=${id}`)).body.alerts.find((a: { type: string; subject: string }) => a.type === 'onboarding_request' && a.subject === id);
    expect(JSON.parse(al.details)).toMatchObject({ pc: 'lab-pc-3d', request: id });
    // Home's Needs you (GET /needs-you, docs/dashboard-ux.md "Attention words") names the PC and the wait.
    const item = (await api('GET', '/needs-you?limit=200')).body.items.find((x: { kind: string; source: { id: string } }) => x.kind === 'onboarding' && x.source.id === id);
    expect(item, 'a Home item for the request').toBeTruthy();
    expect(item.title).toBe('Team request from lab-pc-3d');
    expect(item.at).toBe(then);
    expect(homeMeta(item)).toMatch(/^Team request · .+ · 3d ago$/);
  });
});

describe('approval and pickup', () => {
  it('approve creates the project, a draft team with no members, agents and slots; no key exists yet', async () => {
    const pc = await addAndEnrol('approve-pc');
    const f = await ob('POST', '/requests', { key: pc.key, body: request() });
    const d = await api('GET', `/onboarding/${f.body.request_id}`);
    expect(d.body.written_by_agent.trust).toBe('L2');
    expect(d.body.proposed_slots.map((s: { slot: string }) => s.slot)).toEqual(['coordinator', 'writer_1', 'writer_2', 'reviewer']);
    expect((await api('POST', `/onboarding/${f.body.request_id}/approve`, { version: 99 })).status).toBe(409);
    const a = await api('POST', `/onboarding/${f.body.request_id}/approve`, {
      version: f.body.version, edits: { team: { goal: 'Keep the 2027 grant calendar.' } },
      agents: [{ slot: 'writer_2', include: false }, { slot: 'reviewer', bound: false }],
    });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body.request.state).toBe('approved');
    expect(asking('onboarding_request', f.body.request_id)).toBe(0); // approved: its alert closed
    const team = app.teams.team(a.body.request.team_id)!;
    expect(team.status).toBe('draft');
    expect(team.goal).toBe('Keep the 2027 grant calendar.');
    expect(team.project).toMatch(/^Proj /);
    expect(app.teams.members(team.id)).toHaveLength(0);
    // The new project's only team gets no Blueprint part: its whole Blueprint stays at project level (FR-PLAN-12).
    expect(app.db.prepare("SELECT kind FROM bp_items WHERE team_id=? AND kind='module' AND deleted_at IS NULL").all(team.id)).toEqual([]);
    expect(a.body.slots).toHaveLength(3);
    expect(a.body.slots.every((s: { credential_id: string | null }) => s.credential_id === null)).toBe(true);
    for (const s of a.body.slots) expect(app.keys.credentials({ agentId: s.agent_id })).toHaveLength(0);
    expect(a.body.request.edits.map((e: { field: string }) => e.field)).toEqual(['team.goal', 'agents.writer_2']);
    const st = await ob('GET', `/requests/${f.body.request_id}`, { key: pc.key });
    expect(st.body.agents.map((x: { session_var: string }) => x.session_var)).toEqual(expect.arrayContaining([expect.stringMatching(/^PROJ_\d+_TEAM_\d+_WRITER_1_SESSION_KEY$/)]));
    expect(JSON.stringify(st.body)).not.toMatch(/ah_ses_/);
    expect(st.body.edits).toHaveLength(2);
  });
  it('the coordinator cannot be dropped; deny ends a request', async () => {
    const pc = await addAndEnrol('deny-pc');
    const f = await ob('POST', '/requests', { key: pc.key, body: request() });
    expect(asking('onboarding_request', f.body.request_id)).toBe(1);
    expect((await api('POST', `/onboarding/${f.body.request_id}/approve`, { version: f.body.version, agents: [{ slot: 'coordinator', include: false }] })).status).toBe(400);
    expect(asking('onboarding_request', f.body.request_id)).toBe(1); // a refused approval decides nothing
    const d = await api('POST', `/onboarding/${f.body.request_id}/deny`, { note: 'Not now.' });
    expect(d.body.request.state).toBe('denied');
    expect(asking('onboarding_request', f.body.request_id)).toBe(0);
    expect((await ob('GET', `/requests/${f.body.request_id}`, { key: pc.key })).body.operator_note).toBe('Not now.');
    expect((await api('POST', `/onboarding/${f.body.request_id}/approve`, { version: d.body.request.version })).status).toBe(409);
  });
  it('pickup issues bound keys with the ceiling; a retry revokes the previous set; at most 3; confirm starts the team; never again after', async () => {
    const pc = await addAndEnrol('pickup-pc');
    const rid = await fileApproved(pc.key);
    const other = await addAndEnrol('pickup-thief');
    expect((await ob('POST', '/pickup', { key: other.key, body: { request_id: rid } })).status).toBe(404);
    const p1 = await ob('POST', '/pickup', { key: pc.key, body: { request_id: rid } });
    expect(p1.status, JSON.stringify(p1.body)).toBe(200);
    expect(p1.body.agents).toHaveLength(4);
    expect(p1.body.hub_url).toBe('https://hub.test');
    const writer = p1.body.agents.find((x: { role: string }) => x.role === 'writer');
    expect(writer.secret).toMatch(/^ah_ses_/);
    expect(writer.instructions).toContain('Never call session_login');
    const cred = app.keys.verifyKey(writer.secret, 'session_key');
    expect(cred.bound_machine_id).toBe(pc.pc);
    expect(cred.expires_at).toBeNull();
    expect(app.keys.rules(cred.policy_id).some((r) => r.resource === 'path:/vault/Grants/**' && r.actions.includes('fs.create'))).toBe(true);
    // the secret is never stored
    expect(JSON.stringify(app.db.prepare('SELECT * FROM onboarding_slots').all())).not.toContain(writer.secret.split('_')[3]);
    expect(JSON.stringify(app.db.prepare('SELECT * FROM audit_events').all())).not.toContain(writer.secret.split('_')[3]);
    const p2 = await ob('POST', '/pickup', { key: pc.key, body: { request_id: rid } });
    expect(() => app.keys.verifyKey(writer.secret, 'session_key')).toThrow();
    expect((await ob('POST', '/pickup/confirm', { key: pc.key, body: { pickup_id: p1.body.pickup_id, written: p1.body.agents.map((x: { session_var: string }) => x.session_var) } })).status).toBe(409);
    const p3 = await ob('POST', '/pickup', { key: pc.key, body: { request_id: rid } });
    expect(p3.status).toBe(200);
    expect(alerts('onboarding_pickup_retry').some((x) => x.subject === rid)).toBe(true);
    expect((await ob('POST', '/pickup', { key: pc.key, body: { request_id: rid } })).status).toBe(409);
    expect((await api('POST', `/onboarding/${rid}/reissue-pickup`)).status).toBe(200);
    expect(() => app.keys.verifyKey(p3.body.agents[0].secret, 'session_key')).toThrow();
    const p4 = await ob('POST', '/pickup', { key: pc.key, body: { request_id: rid } });
    expect(p4.status).toBe(200);
    const vars = p4.body.agents.map((x: { session_var: string }) => x.session_var);
    expect((await ob('POST', '/pickup/confirm', { key: pc.key, body: { pickup_id: p4.body.pickup_id, written: vars.slice(1) } })).status).toBe(400);
    const c = await ob('POST', '/pickup/confirm', { key: pc.key, body: { pickup_id: p4.body.pickup_id, written: vars, transport: 'http' } });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body.started).toBe(true);
    const team = app.teams.team(c.body.team_id)!;
    expect(team.status).toBe('running');
    expect(app.teams.members(team.id).map((m) => m.role).sort()).toEqual(['coordinator', 'reviewer', 'worker', 'worker']);
    expect((app.keys.machine(pc.pc) as unknown as { mcp_transport: string }).mcp_transport).toBe('http');
    // repeating a lost confirm is harmless
    expect((await ob('POST', '/pickup/confirm', { key: pc.key, body: { pickup_id: p4.body.pickup_id, written: vars } })).body.already).toBe(true);
    // the onboarded key logs in from its PC, and only there
    const coord = p4.body.agents.find((x: { team_role: string }) => x.team_role === 'coordinator');
    expect((await login(pc.key, coord.secret)).isError).toBeFalsy();
    expect((await login(other.key, coord.secret)).isError).toBe(true);
    const again = await ob('POST', '/pickup', { key: pc.key, body: { request_id: rid } });
    expect(again.status).toBe(409);
    expect(alerts('onboarding_pickup_after_collect').some((x) => x.subject === rid)).toBe(true);
    expect(auditOf('onboarding.pickup_confirm').length).toBeGreaterThan(0);
    void p2;
  });
  it('start when set up off leaves the team in draft', async () => {
    const pc = await addAndEnrol('nostart-pc');
    const rid = await fileApproved(pc.key, {}, { start_when_set_up: false });
    const p = await ob('POST', '/pickup', { key: pc.key, body: { request_id: rid } });
    const c = await ob('POST', '/pickup/confirm', { key: pc.key, body: { pickup_id: p.body.pickup_id, written: p.body.agents.map((x: { session_var: string }) => x.session_var) } });
    expect(c.body.started).toBe(false);
    expect(app.teams.team(c.body.team_id)!.status).toBe('draft');
  });
  it('cancel after approval revokes unconfirmed keys, archives the agents and stops the draft team', async () => {
    const pc = await addAndEnrol('cancel-pc');
    const rid = await fileApproved(pc.key);
    const p = await ob('POST', '/pickup', { key: pc.key, body: { request_id: rid } });
    const c = await api('POST', `/onboarding/${rid}/cancel`, { note: 'Wrong PC.' });
    expect(c.body.request.state).toBe('cancelled');
    for (const a of p.body.agents) {
      expect(() => app.keys.verifyKey(a.secret, 'session_key')).toThrow();
      expect(app.keys.agent(a.agent_id)!.status).toBe('archived');
    }
    expect(app.teams.team(c.body.request.team_id)!.status).toBe('stopped');
    // the PC may file again
    expect((await ob('POST', '/requests', { key: pc.key, body: request() })).status).toBe(200);
  });
  it('add_agents works for a team onboarded from this PC, continues numbering, and is refused from another PC', async () => {
    const pc = await addAndEnrol('grow-pc');
    const rid = await fileApproved(pc.key);
    const p = await ob('POST', '/pickup', { key: pc.key, body: { request_id: rid } });
    const c = await ob('POST', '/pickup/confirm', { key: pc.key, body: { pickup_id: p.body.pickup_id, written: p.body.agents.map((x: { session_var: string }) => x.session_var) } });
    const team = app.teams.team(c.body.team_id)!;
    const more = { kind: 'add_agents', project: { name: team.project, existing: true }, team: { id: team.id }, roles: [{ name: 'writer', team_role: 'worker', count: 1, job: 'Writes more.' }], prompt: 'one more writer' };
    const other = await addAndEnrol('grow-other');
    const refused = await ob('POST', '/requests', { key: other.key, body: more });
    expect(refused.status).toBe(400);
    expect(refused.body.problems[0].field).toBe('team.id');
    const f = await ob('POST', '/requests', { key: pc.key, body: more });
    expect(f.status, JSON.stringify(f.body)).toBe(200);
    const a = await api('POST', `/onboarding/${f.body.request_id}/approve`, { version: f.body.version });
    expect(a.body.slots[0].label).toBe(`${team.name} writer 3`);
    const p2 = await ob('POST', '/pickup', { key: pc.key, body: { request_id: f.body.request_id } });
    const c2 = await ob('POST', '/pickup/confirm', { key: pc.key, body: { pickup_id: p2.body.pickup_id, written: p2.body.agents.map((x: { session_var: string }) => x.session_var) } });
    expect(c2.status).toBe(200);
    expect(app.teams.members(team.id)).toHaveLength(5);
    expect(app.teams.team(team.id)!.status).toBe('running');
  });
  it('Re-enrol PC revokes the old keys at once, issues a new code, and reopens a pickup on collected requests', async () => {
    const pc = await addAndEnrol('reenrol-pc');
    const rid = await fileApproved(pc.key);
    const p = await ob('POST', '/pickup', { key: pc.key, body: { request_id: rid } });
    const c = await ob('POST', '/pickup/confirm', { key: pc.key, body: { pickup_id: p.body.pickup_id, written: p.body.agents.map((x: { session_var: string }) => x.session_var) } });
    const r = await api('POST', `/pcs/${pc.pc}/re-enrol`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.reopened).toEqual([rid]);
    expect(r.body.code).not.toBe(pc.code);
    expect(() => app.keys.verifyKey(pc.key, 'app_key')).toThrow();
    for (const a of p.body.agents) expect(() => app.keys.verifyKey(a.secret, 'session_key')).toThrow();
    const n = nonce(), from = freshIp();
    const e = await ob('POST', '/enrol', { body: { code: r.body.code, nonce: n }, from });
    expect(e.status).toBe(200);
    await ob('POST', '/enrol/confirm', { body: { nonce: n }, from });
    expect((await ob('POST', '/pickup', { key: pc.key, body: { request_id: rid } })).status).toBe(401);
    const p2 = await ob('POST', '/pickup', { key: e.body.app_key, body: { request_id: rid } });
    expect(p2.status, JSON.stringify(p2.body)).toBe(200);
    const c2 = await ob('POST', '/pickup/confirm', { key: e.body.app_key, body: { pickup_id: p2.body.pickup_id, written: p2.body.agents.map((x: { session_var: string }) => x.session_var) } });
    expect(c2.status).toBe(200);
    const members = app.teams.members(c.body.team_id);
    expect(members).toHaveLength(4);
    for (const m of members) expect(app.keys.credential(m.credential_id)!.status).toBe('active');
    expect((await login(e.body.app_key, p2.body.agents[0].secret)).isError).toBeFalsy();
    expect(auditOf('pc.re_enrol').length).toBeGreaterThan(0);
  });
  it('Re-enrol on a connector PC hands every agent key over: the old keys work until confirm and are revoked then', async () => {
    const pc = await addAndEnrol('reenrol-conn-pc');
    expect((await cnr('POST', '/check-in', pc.key, { version: '0.9.6' })).status).toBe(200);
    const rid = await fileApproved(pc.key);
    const p = await ob('POST', '/pickup', { key: pc.key, body: { request_id: rid } });
    const c = await ob('POST', '/pickup/confirm', { key: pc.key, body: { pickup_id: p.body.pickup_id, written: p.body.agents.map((x: { session_var: string }) => x.session_var) } });
    expect(c.status).toBe(200);
    const r = await api('POST', `/pcs/${pc.pc}/re-enrol`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.reopened).toEqual([]);
    expect(r.body.handover).toMatch(/^obr_/);
    expect(app.onboarding.request(rid)!.state).toBe('collected');
    expect(() => app.keys.verifyKey(pc.key, 'app_key')).toThrow();
    // The agents' keys are not revoked: they work again once the PC is paired with the new code.
    for (const a of p.body.agents) expect(app.keys.verifyKey(a.secret, 'session_key').status).toBe('active');
    const n = nonce(), from = freshIp();
    const e = await ob('POST', '/enrol', { body: { code: r.body.code, nonce: n }, from });
    expect(e.status).toBe(200);
    await ob('POST', '/enrol/confirm', { body: { nonce: n }, from });
    expect((await cnr('GET', '/handovers', pc.key)).status).toBe(401);
    const list = (await cnr('GET', '/handovers', e.body.app_key)).body.handovers;
    expect(list.map((h: any) => h.id)).toEqual([r.body.handover]);
    expect(list[0].agents).toHaveLength(4);
    expect((await login(e.body.app_key, p.body.agents[0].secret)).isError).toBeFalsy();
    const p2 = await ob('POST', '/pickup', { key: e.body.app_key, body: { request_id: r.body.handover } });
    expect(p2.status, JSON.stringify(p2.body)).toBe(200);
    expect(p2.body.agents).toHaveLength(4);
    for (const a of p.body.agents) expect(app.keys.verifyKey(a.secret, 'session_key').status).toBe('active');
    const c2 = await ob('POST', '/pickup/confirm', { key: e.body.app_key, body: { pickup_id: p2.body.pickup_id, written: p2.body.agents.map((x: { session_var: string }) => x.session_var) } });
    expect(c2.status, JSON.stringify(c2.body)).toBe(200);
    for (const a of p.body.agents) expect(() => app.keys.verifyKey(a.secret, 'session_key')).toThrow();
    for (const a of p2.body.agents) expect((await login(e.body.app_key, a.secret)).isError).toBeFalsy();
    const members = app.teams.members(c.body.team_id);
    expect(members).toHaveLength(4);
    for (const m of members) expect(app.keys.credential(m.credential_id)!.status).toBe('active');
    expect(JSON.parse(auditOf('pc.re_enrol').at(-1)!.details)).toMatchObject({ agents_handed_over: 4, handover: r.body.handover });
  });
  it('a Re-enrol handover the connector holds none of the keys for revokes them and reopens the pickup, which the PC can withdraw', async () => {
    const pc = await addAndEnrol('reenrol-lost-pc');
    expect((await cnr('POST', '/check-in', pc.key, { version: '0.9.6' })).status).toBe(200);
    const rid = await fileApproved(pc.key);
    const p = await ob('POST', '/pickup', { key: pc.key, body: { request_id: rid } });
    const c = await ob('POST', '/pickup/confirm', { key: pc.key, body: { pickup_id: p.body.pickup_id, written: p.body.agents.map((x: { session_var: string }) => x.session_var) } });
    const r = (await api('POST', `/pcs/${pc.pc}/re-enrol`)).body;
    const n = nonce(), from = freshIp();
    const e = await ob('POST', '/enrol', { body: { code: r.code, nonce: n }, from });
    await ob('POST', '/enrol/confirm', { body: { nonce: n }, from });
    // The reinstalled PC holds none of the keys.
    expect((await cnr('POST', `/handovers/${r.handover}/skip`, e.body.app_key, { reason: 'key_not_held' })).status).toBe(200);
    expect(app.onboarding.request(r.handover)!.state).toBe('cancelled');
    for (const a of p.body.agents) expect(() => app.keys.verifyKey(a.secret, 'session_key')).toThrow();
    expect(app.onboarding.request(rid)!.state).toBe('approved');
    expect(auditOf('pc.re_enrol_keys_lost')).toHaveLength(1);
    // Setup cannot finish it (say the folders are gone for good): the PC withdraws it, and the agents stay in their team.
    const w = await ob('POST', `/requests/${rid}/withdraw`, { key: e.body.app_key });
    expect(w.status, JSON.stringify(w.body)).toBe(200);
    expect(app.onboarding.request(rid)!.state).toBe('withdrawn');
    expect(app.teams.members(c.body.team_id)).toHaveLength(4);
    // A new request can be filed.
    expect((await ob('POST', '/requests', { key: e.body.app_key, body: request() })).status).toBe(200);
  });
  it('an agent whose keys the hub no longer accepts is Key refused, never Connected', async () => {
    const pc = await addAndEnrol('refused-pc');
    expect((await cnr('POST', '/check-in', pc.key, { version: '0.9.6' })).status).toBe(200);
    const rid = await fileApproved(pc.key);
    const p = await ob('POST', '/pickup', { key: pc.key, body: { request_id: rid } });
    await ob('POST', '/pickup/confirm', { key: pc.key, body: { pickup_id: p.body.pickup_id, written: p.body.agents.map((x: { session_var: string }) => x.session_var) } });
    expect((await login(pc.key, p.body.agents[0].secret)).isError).toBeFalsy();
    const a0 = p.body.agents[0];
    app.keys.setStatus(app.keys.verifyKey(a0.secret, 'session_key').id, 'revoked', 'test', { kind: 'system', id: null });
    const t = (await cnr('GET', '/setup', pc.key)).body;
    const row = t.agents.find((x: any) => x.agent_id === a0.agent_id);
    expect(row.state).toBe('key_refused');
    expect(row.next).toMatchObject({ who: 'you' });
    expect(t.agents.filter((x: any) => x.state === 'key_refused')).toHaveLength(1);
    expect(t.steps.find((x: any) => x.step === 'agents_connected')).toMatchObject({ state: 'failed' });
  });
  it('cancelling a pickup reopened by Re-enrol keeps the working agents as members', async () => {
    const pc = await addAndEnrol('reenrol-cancel-pc');
    const rid = await fileApproved(pc.key);
    const p = await ob('POST', '/pickup', { key: pc.key, body: { request_id: rid } });
    const c = await ob('POST', '/pickup/confirm', { key: pc.key, body: { pickup_id: p.body.pickup_id, written: p.body.agents.map((x: { session_var: string }) => x.session_var) } });
    const teamId = c.body.team_id as string;
    expect((await api('POST', `/pcs/${pc.pc}/re-enrol`)).body.reopened).toEqual([rid]);
    const x = await api('POST', `/onboarding/${rid}/cancel`, { note: 'Not now.' });
    expect(x.body.request.state).toBe('cancelled');
    expect(app.teams.members(teamId)).toHaveLength(4);
    for (const a of p.body.agents) {
      expect(app.keys.agent(a.agent_id)!.status).not.toBe('archived');
      expect(app.teams.roleOf(teamId, a.agent_id)).toBeTruthy();
    }
    const st = app.db.prepare('SELECT DISTINCT status FROM onboarding_slots WHERE request_id=?').all(rid) as { status: string }[];
    expect(st.map((s) => s.status)).toEqual(['confirmed']);
    expect(app.teams.team(teamId)!.status).toBe('running');
  });
  it('confirm refuses a pickup whose key was revoked after it was issued', async () => {
    const pc = await addAndEnrol('revoked-slot-pc');
    const rid = await fileApproved(pc.key);
    const p = await ob('POST', '/pickup', { key: pc.key, body: { request_id: rid } });
    const victim = p.body.agents[0];
    const cred = app.db.prepare('SELECT credential_id FROM onboarding_slots WHERE request_id=? AND session_var=?').get(rid, victim.session_var) as { credential_id: string };
    app.keys.setStatus(cred.credential_id, 'revoked', 'test', sys);
    const c = await ob('POST', '/pickup/confirm', { key: pc.key, body: { pickup_id: p.body.pickup_id, written: p.body.agents.map((x: { session_var: string }) => x.session_var) } });
    expect(c.status).toBe(409);
    expect(c.body.message).toMatch(/Run the pickup again/);
    expect(c.body.inactive ?? c.body.details?.inactive).toEqual([victim.session_var]);
    expect(app.db.prepare('SELECT state FROM onboarding_requests WHERE id=?').get(rid)).toMatchObject({ state: 'approved' });
  });
  it('add_agents refuses fields under team other than its id', async () => {
    const pc = await addAndEnrol('grow-strict-pc');
    const rid = await fileApproved(pc.key);
    const p = await ob('POST', '/pickup', { key: pc.key, body: { request_id: rid } });
    const c = await ob('POST', '/pickup/confirm', { key: pc.key, body: { pickup_id: p.body.pickup_id, written: p.body.agents.map((x: { session_var: string }) => x.session_var) } });
    const team = app.teams.team(c.body.team_id)!;
    const more = { kind: 'add_agents', project: { name: team.project, existing: true }, team: { id: team.id, goal: 'A new goal' }, roles: [{ name: 'writer', team_role: 'worker', count: 1, job: 'Writes more.' }], prompt: 'one more writer' };
    const r = await ob('POST', '/requests', { key: pc.key, body: more });
    expect(r.status).toBe(400);
    expect(r.body.problems.map((x: { field: string }) => x.field)).toContain('team.goal');
  });
});

describe('docs consistency', () => {
  it('the build copies only the restore template into the image\'s client folder', () => {
    const copy = readFileSync(join(process.cwd(), 'scripts', 'copy-assets.mjs'), 'utf8');
    expect(copy).toContain("for (const f of ['restore-prompt.md'])");
    expect(copy).not.toMatch(/agent-hub-headers|setup\.mjs|onboarding-prompt/);
  });
  it('the LAN plain-HTTP site proxies only the CA certificate of onboarding, and the relay no client files', () => {
    const cf = readFileSync(join(process.cwd(), '..', 'deploy', 'caddy', 'lan.Caddyfile'), 'utf8');
    const http = cf.slice(cf.indexOf('http://:'));
    const paths = [...http.matchAll(/^\s*@\w+ path (.+)$/gm)].flatMap((m) => m[1]!.trim().split(/\s+/)).filter((x) => x.startsWith('/onboard'));
    expect(paths.sort()).toEqual(['/onboard/ca.crt']);
    expect(readFileSync(join(process.cwd(), '..', 'deploy', 'relay', 'relay.Caddyfile'), 'utf8')).not.toContain('/onboard/client');
    expect(http).toMatch(/@onboard_files path [^\n]+\n\s*handle @onboard_files \{\s*reverse_proxy agent-hub:8080/);
    // Everything else still falls through to the redirect to HTTPS.
    expect(http).toMatch(/handle \{\s*redir https:/);
  });
  void sys;
});
