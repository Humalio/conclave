/**
 * PC binding of session keys (docs/onboarding.md#pc-binding-of-session-keys): a bound key logs in only through an app
 * key on its PC; elsewhere it fails as an invalid key, raises bound_key_elsewhere and is audited. Keys start free.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base: string, cookie = '', csrf = '', pcA = '', pcB = '', appA = '', appB = '';

const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const client = async (appKey: string, headers: Record<string, string> = {}) => {
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}`, ...headers } } }));
  return c;
};
const login = async (appKey: string, secret: string) =>
  (await (await client(appKey)).callTool({ name: 'session_login', arguments: { session_key: secret } })) as { isError?: boolean; structuredContent?: any; content?: any };
const newKey = (label: string) => {
  const agent = app.keys.createAgent(label, null, sys);
  return app.keys.createSessionKey({ agentId: agent.id, label: `${label} key` }, sys);
};
const alerts = (cred: string) => app.db.prepare("SELECT * FROM security_alerts WHERE type='bound_key_elsewhere' AND subject=?").all(cred) as { severity: string; details: string }[];

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahbind-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  const config: Config = testConfig(dir, { maintenanceSeconds: undefined });
  app = await buildApp(config);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base));
  pcA = (await api('POST', '/pcs', { name: 'pc-a' })).body.pc.id;
  pcB = (await api('POST', '/pcs', { name: 'pc-b' })).body.pc.id;
  appA = app.keys.createAppKey({ machineId: pcA, appName: 'claude-code', maxLiveSessions: 100 }, sys).secret;
  appB = app.keys.createAppKey({ machineId: pcB, appName: 'claude-code', maxLiveSessions: 100 }, sys).secret;
});
afterAll(async () => { await app.close(); });

describe('PC binding of session keys', () => {
  it('keys start free and log in from any PC (existing behaviour unchanged)', async () => {
    const k = newKey('free');
    expect(k.credential.bound_machine_id).toBeNull();
    const created = await api('POST', '/keys', { kind: 'session_key', new_agent: { label: 'manual' }, label: 'manual key' });
    expect(created.body.key.bound_machine_id).toBeNull();
    expect(created.body.key.bound_pc).toBeNull();
    expect((await login(appA, k.secret)).isError).toBeFalsy();
    expect((await login(appB, k.secret)).isError).toBeFalsy();
    expect(alerts(k.credential.id)).toHaveLength(0);
  });

  it('a bound key logs in from its own PC', async () => {
    const k = newKey('own');
    const r = await api('PUT', `/keys/${k.credential.id}/binding`, { machine_id: pcA });
    expect(r.status).toBe(200);
    expect(r.body.key).toMatchObject({ bound_machine_id: pcA, bound_pc: { id: pcA, name: 'pc-a' } });
    const res = await login(appA, k.secret);
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.session_token).toMatch(/^ah_tok_/);
    const ev = app.db.prepare("SELECT details FROM audit_events WHERE action='key.binding_set' AND target_id=?").get(k.credential.id) as { details: string };
    expect(JSON.parse(ev.details)).toEqual({ from: null, to: pcA });
  });

  it('from another PC it fails as an invalid key, raises the alert and is audited', async () => {
    const k = newKey('elsewhere');
    app.keys.setBinding(k.credential.id, pcA, sys);
    const unknown = await login(appB, 'ah_ses_aaaaaaaaaaaa_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const res = await login(appB, k.secret);
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toBe(JSON.stringify(unknown.content)); // the caller learns nothing more
    const a = alerts(k.credential.id);
    expect(a).toHaveLength(1);
    expect(a[0]!.severity).toBe('warning');
    expect(JSON.parse(a[0]!.details)).toMatchObject({ bound_pc: { id: pcA, name: 'pc-a' }, used_from_pc: { id: pcB, name: 'pc-b' } });
    const auth = app.db.prepare("SELECT outcome FROM authentication_events WHERE credential_id=? ORDER BY created_at DESC").get(k.credential.id) as { outcome: string };
    expect(auth.outcome).toBe('invalid');
    expect(app.db.prepare("SELECT 1 FROM audit_events WHERE action='auth.bound_key_elsewhere' AND target_id=?").get(k.credential.id)).toBeTruthy();
    expect(app.db.prepare('SELECT COUNT(*) n FROM session_tokens WHERE session_credential_id=?').get(k.credential.id)).toEqual({ n: 0 });
  });

  it('flipping the switch takes effect at the next login; live logins go on', async () => {
    const k = newKey('flip');
    const tok = (await login(appB, k.secret)).structuredContent.session_token as string;
    await api('PUT', `/keys/${k.credential.id}/binding`, { machine_id: pcA });
    expect((await login(appB, k.secret)).isError).toBe(true);
    expect((await login(appA, k.secret)).isError).toBeFalsy();
    // The login made before binding still works (header login with that token).
    const viaHeader = await client(appB, { 'X-Agent-Hub-Session': tok });
    expect(((await viaHeader.callTool({ name: 'session_whoami', arguments: {} })) as { isError?: boolean }).isError).toBeFalsy();
    const free = await api('PUT', `/keys/${k.credential.id}/binding`, { machine_id: null });
    expect(free.body.key.bound_machine_id).toBeNull();
    expect((await login(appB, k.secret)).isError).toBeFalsy();
  });

  it('a session that signs in by header gets tool schemas without session_token', async () => {
    const k = newKey('schema');
    const tok = (await login(appA, k.secret)).structuredContent.session_token as string;
    const props = async (c: Client) => Object.keys(((await c.listTools()).tools.find((t) => t.name === 'session_whoami')!.inputSchema.properties ?? {}) as object);
    expect(await props(await client(appA, { 'X-Agent-Hub-Session': tok }))).not.toContain('session_token');
    expect(await props(await client(appA))).toContain('session_token');
  });

  it('rotation keeps the binding; app keys and unknown PCs are refused', async () => {
    const k = newKey('rot');
    app.keys.setBinding(k.credential.id, pcA, sys);
    const r = await api('POST', `/keys/${k.credential.id}/rotate`);
    expect(r.body.key.bound_machine_id).toBe(pcA);
    expect((await login(appB, r.body.secret)).isError).toBe(true);
    const appCred = app.keys.credentials({ kind: 'app_key', machineId: pcA })[0]!;
    expect((await api('PUT', `/keys/${appCred.id}/binding`, { machine_id: pcA })).status).toBe(400);
    expect((await api('PUT', `/keys/${r.body.key.id}/binding`, { machine_id: 'pc_nope' })).status).toBe(404);
    const old = (await api('POST', '/pcs', { name: 'pc-retired' })).body.pc.id;
    app.db.prepare("UPDATE machines SET status='retired' WHERE id=?").run(old);
    expect((await api('PUT', `/keys/${r.body.key.id}/binding`, { machine_id: old })).status).toBe(409);
  });
});
