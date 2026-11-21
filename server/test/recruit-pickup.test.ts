/**
 * Recruits get their key through onboarding's pickup (docs/onboarding.md#recruits-from-a-coordinator): team_recruit and
 * the operator's approval of a recruit request create the agent and an approved pickup on the coordinator's PC, and never
 * return a key. The PC's connector, once its user allows it, picks it up, writes it to its key file and confirms; then the recruit joins the team.
 * No recruit result, log line, audit event, alert or notice may contain key material.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base = '', admin = { cookie: '', csrf: '' }, pcKey = '', pcId = '', n = 0;
const KEY_RE = /ah_(ses|app|tok)_|cnc-pair-/;

const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie: admin.cookie, 'x-csrf-token': admin.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any, text: '' };
};
/** The connector's pickup calls, with the PC's app key. */
const ob = async (path: string, body: unknown) => {
  const r = await fetch(`${base}/onboard${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${pcKey}` }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};
type Call = (name: string, args?: Record<string, unknown>) => Promise<{ isError?: boolean; structuredContent?: any; content: { text: string }[] }>;
async function loginWith(appKey: string, secret: string): Promise<Call> {
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  const token = ((await c.callTool({ name: 'session_login', arguments: { session_key: secret } })) as any).structuredContent.session_token as string;
  return async (name, args = {}) => (await c.callTool({ name, arguments: { session_token: token, ...args } })) as never;
}
/** A started team whose coordinator works on the enrolled PC (or the given app key's PC), with vault access to share. */
async function team(over: Record<string, unknown> = {}, appKey = pcKey) {
  const coord = app.keys.createAgent(`Coord ${++n}`, null, sys);
  const k = app.keys.createSessionKey({ agentId: coord.id, label: 'c' }, sys);
  app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:file_*' }, { effect: 'allow', actions: ['fs.list', 'fs.read', 'fs.update'], resource: 'path:/vault/Notes/**' }], 'test', sys);
  const t = await api('POST', '/teams', { name: `Recruiters ${n}`, goal: 'g', members: [{ agent_id: coord.id, role: 'coordinator' }] });
  expect(t.status, JSON.stringify(t.body)).toBe(201);
  const tid = t.body.team.id as string;
  expect((await api('POST', `/teams/${tid}/start`)).status).toBe(200);
  expect((await api('PATCH', `/teams/${tid}`, { recruiting: 'auto', recruit_max: 2, recruit_days: 5, ...over })).status).toBe(200);
  return { tid, coord, C: await loginWith(appKey, k.secret) };
}
/** Everything the hub recorded or told anyone: audit events, alerts, notices, request history. */
const records = () => JSON.stringify(['audit_events', 'security_alerts', 'agent_notices', 'onboarding_events'].map((t) => {
  try { return app.db.prepare(`SELECT * FROM ${t}`).all(); } catch { return []; }
}));
/** Everything the hub process writes to stdout and stderr (its log lines) while fn runs. */
async function logged(fn: () => Promise<void>): Promise<string> {
  const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
  const out: string[] = [];
  const keep = { ws: fs.writeSync, w: fs.write, o: process.stdout.write, e: process.stderr.write };
  const grab = (fd: unknown, d: unknown) => { if (fd === 1 || fd === 2) out.push(String(d)); };
  (fs as any).writeSync = (fd: number, d: unknown, ...r: unknown[]) => { grab(fd, d); return (keep.ws as any)(fd, d, ...r); };
  (fs as any).write = (fd: number, d: unknown, ...r: unknown[]) => { grab(fd, d); return (keep.w as any)(fd, d, ...r); };
  process.stdout.write = ((d: unknown, ...r: unknown[]) => { out.push(String(d)); return (keep.o as any).call(process.stdout, d, ...r); }) as never;
  process.stderr.write = ((d: unknown, ...r: unknown[]) => { out.push(String(d)); return (keep.e as any).call(process.stderr, d, ...r); }) as never;
  try { await fn(); } finally { Object.assign(fs, { writeSync: keep.ws, write: keep.w }); process.stdout.write = keep.o; process.stderr.write = keep.e; }
  return out.join('');
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahrec-'));
  mkdirSync(join(dir, 'vault', 'Notes'), { recursive: true });
  writeFileSync(join(dir, 'vault', 'Notes', 'a.md'), '# A\n');
  const client = join(dir, 'client');
  mkdirSync(client);
  for (const f of ['agent-hub-headers.mjs', 'setup.mjs']) writeFileSync(join(client, f), 'export const x = 1;\n');
  writeFileSync(join(client, 'onboarding-prompt.md'), 'Hub {{HUB_URL}} code {{ENROL_CODE}} pc {{PC_NAME}}\n');
  // Info-level request logs on, so the log check below sees what an operator's log would hold.
  app = await buildApp(testConfig(dir, { publicUrl: 'https://hub.test', clientDir: client, logLevel: 'info', maintenanceSeconds: undefined }));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  admin = await adminLogin(base);
  // A PC set up with Add PC: its app key carries the onboarding capability.
  const add = await api('POST', '/pcs/add', { name: 'coordinator-pc' });
  expect(add.status, JSON.stringify(add.body)).toBe(200);
  pcId = add.body.pc.id;
  const nonce = 'recruit-pc-nonce-0123456789', h = { 'content-type': 'application/json', 'x-forwarded-for': '10.9.0.2', 'x-forwarded-proto': 'https' };
  pcKey = ((await fetch(`${base}/onboard/enrol`, { method: 'POST', headers: h, body: JSON.stringify({ code: add.body.code, nonce }) }).then((x) => x.json())) as any).app_key;
  await fetch(`${base}/onboard/enrol/confirm`, { method: 'POST', headers: h, body: JSON.stringify({ nonce }) });
  expect(pcKey).toMatch(/^ah_app_/);
});
afterAll(async () => { await app.close(); });

describe('a recruit\'s key goes to the coordinator\'s PC through a pickup', () => {
  it('auto: the result says where pickup happens and holds no key; the PC picks it up, and the recruit joins at confirm', async () => {
    const X = await team();
    let r: any, text = '';
    const log = await logged(async () => {
      const res = await X.C('team_recruit', { team_id: X.tid, label: 'Second reader', role: 'reviewer', purpose: 'Check the notes' });
      r = res.structuredContent; text = res.content.map((c) => c.text).join('\n');
    });
    expect(r.status, JSON.stringify(r)).toBe('created');
    expect(r.pickup).toMatchObject({ pc: { id: pcId, name: 'coordinator-pc' }, folder: 'second-reader' });
    expect(r.pickup.command).toBeUndefined();
    expect(r.pickup.expires_at).toBeGreaterThan(Date.now());
    expect(r.pickup.session_var).toMatch(/_SECOND_READER_SESSION_KEY$/);
    expect(text).toContain('coordinator-pc');
    expect(text).toContain("allows the new agent on the connector's screen");
    expect(text).not.toContain('setup.mjs');
    // No key anywhere: not in the result, not in the log, not in what the hub recorded or told anyone.
    expect(JSON.stringify(r) + text).not.toMatch(KEY_RE);
    expect(log).toContain('/mcp'); // the capture saw the hub's request log
    expect(log).not.toMatch(KEY_RE);
    expect(records()).not.toMatch(KEY_RE);
    // The agent exists (owner, role, recruiter kept) but has no key and is no member until the PC confirms.
    const aid = r.agent_id as string;
    expect(app.keys.agent(aid)).toMatchObject({ recruited_team_id: X.tid, recruited_by: X.coord.id, role: 'reviewer', role_detail: 'Check the notes' });
    expect(app.keys.credentials({ kind: 'session_key', agentId: aid })).toHaveLength(0);
    expect((await api('GET', `/teams/${X.tid}`)).body.team.members.some((m: any) => m.agent_id === aid)).toBe(false);
    // The operator sees it as an approved request of the PC.
    const req = app.onboarding.request(r.pickup.request_id)!;
    expect(req).toMatchObject({ machine_id: pcId, kind: 'add_agents', state: 'approved', team_id: X.tid });
    // The connector's pickup: the only answer that carries the key, and only to the PC's own app key.
    let p: any, c: any;
    const log2 = await logged(async () => {
      p = await ob('/pickup', { request_id: r.pickup.request_id });
      expect(p.status, JSON.stringify(p.body)).toBe(200);
      c = await ob('/pickup/confirm', { pickup_id: p.body.pickup_id, written: [r.pickup.session_var] });
    });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const a = p.body.agents[0];
    expect(a).toMatchObject({ agent_id: aid, session_var: r.pickup.session_var, folder: 'second-reader', team_role: 'reviewer' });
    expect(a.instructions).toContain('Check the notes');
    expect(log2).not.toContain(a.secret);
    expect(records()).not.toContain(a.secret);
    // The key: bound to the PC, expires after recruit_days from pickup, the recruit rules (a read-only copy).
    const cred = app.keys.credentials({ kind: 'session_key', agentId: aid })[0]!;
    expect(cred.bound_machine_id).toBe(pcId);
    expect(cred.expires_at!).toBeGreaterThan(Date.now() + 4.9 * 86_400_000);
    expect(cred.expires_at!).toBeLessThan(Date.now() + 5.1 * 86_400_000);
    expect(app.keys.rules(cred.policy_id, false).some((x) => x.actions.includes('fs.update'))).toBe(false);
    const R = await loginWith(pcKey, a.secret);
    expect((await R('team_info')).structuredContent.teams[0].my_role).toBe('reviewer');
    // Joined at confirm (a first login skips the hub's setup notices, so the notice is read from the table).
    expect(app.db.prepare("SELECT kind FROM agent_notices WHERE agent_id=? AND kind='team_joined'").all(aid)).toHaveLength(1);
    // whoami names each agent's own key by its public id prefix (ah_ses_<id>_…); its notices carry no key material.
    const notes = [(await R('session_whoami')).structuredContent.notices, (await X.C('session_whoami')).structuredContent.notices];
    expect(JSON.stringify(notes)).not.toMatch(KEY_RE);
    expect(log2).toContain('/onboard/pickup');
  });

  it('propose: the operator\'s approval returns no key; the coordinator\'s notice carries the pickup command', async () => {
    const X = await team({ recruiting: 'propose' });
    const q = (await X.C('team_recruit', { team_id: X.tid, label: 'Funder view', role: 'stakeholder', purpose: 'Reads the plan' })).structuredContent;
    expect(q.status).toBe('pending');
    const ap = await api('POST', `/recruits/${q.request_id}/approve`);
    expect(ap.status, JSON.stringify(ap.body)).toBe(200);
    expect(JSON.stringify(ap.body)).not.toMatch(KEY_RE);
    expect(ap.body.pickup.pc.id).toBe(pcId);
    const notes = (await X.C('session_whoami')).structuredContent.notices as { kind: string; body: string }[];
    const d = notes.find((x) => x.kind === 'recruit_decision')!;
    expect(d.body).toContain("allows the new agent on the connector's screen");
    expect(JSON.stringify(notes)).not.toMatch(KEY_RE);
    expect(records()).not.toMatch(KEY_RE);
  });

  it('waiting recruits count against the limit; switching recruiting off cancels their pickup and archives them', async () => {
    const X = await team({ recruit_max: 1 });
    const r = (await X.C('team_recruit', { team_id: X.tid, label: 'Only one', role: 'worker', purpose: 'p' })).structuredContent;
    expect(r.status).toBe('created');
    expect((await X.C('team_recruit', { team_id: X.tid, label: 'One more', role: 'worker', purpose: 'p' })).structuredContent.error).toBe('invalid_state');
    expect((await api('PATCH', `/teams/${X.tid}`, { recruiting: 'off' })).status).toBe(200);
    expect(app.onboarding.request(r.pickup.request_id)!.state).toBe('cancelled');
    expect(app.keys.agent(r.agent_id)!.status).toBe('archived');
    expect((await ob('/pickup', { request_id: r.pickup.request_id })).status).toBe(409);
  });

  it('a coordinator on a PC without key pickup is refused, and nothing is created', async () => {
    const plain = (await api('POST', '/pcs', { name: 'plain-pc' })).body.pc.id;
    const key = app.keys.createAppKey({ machineId: plain, appName: 'claude-code', maxLiveSessions: 50 }, sys).secret;
    const X = await team({}, key);
    const before = app.keys.agents().length;
    const r = (await X.C('team_recruit', { team_id: X.tid, label: 'Nowhere', role: 'worker', purpose: 'p' })).structuredContent;
    expect(r.error).toBe('invalid_state');
    expect(r.message).toMatch(/Add PC/);
    expect(app.keys.agents().length).toBe(before);
  });
});
