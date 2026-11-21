import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base = '', admin = { cookie: '', csrf: '' }, pcKey = '', pcId = '', n = 0;

const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie: admin.cookie, 'x-csrf-token': admin.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any, text: '' };
};
type Call = (name: string, args?: Record<string, unknown>) => Promise<{ isError?: boolean; structuredContent?: any; content: { text: string }[] }>;
async function loginWith(appKey: string, secret: string): Promise<Call> {
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  const token = ((await c.callTool({ name: 'session_login', arguments: { session_key: secret } })) as any).structuredContent.session_token as string;
  return async (name, args = {}) => (await c.callTool({ name, arguments: { session_token: token, ...args } })) as never;
}

/**
 * A recruit template is checked against the team's ceiling (docs/onboarding.md#the-teams-ceiling-for-a-recruit-template):
 * the standing rules the team's members who were not recruited hold for good, read at recruit time. A coordinator built
 * by the one-prompt flow holds only team rules, and needs no file access of its own to recruit. Nothing is stored on it.
 */
async function team(tplRules: Record<string, unknown>[] | null, o: { coordOwner?: string; workerOwner?: string; workerRules?: Record<string, unknown>[] } = {}) {
  const coord = app.keys.createAgent(`Coord ${++n}`, null, sys, o.coordOwner ?? null), worker = app.keys.createAgent(`Worker ${n}`, null, sys, o.workerOwner ?? null);
  const kc = app.keys.createSessionKey({ agentId: coord.id, label: 'c' }, sys), kw = app.keys.createSessionKey({ agentId: worker.id, label: 'w' }, sys);
  // As onboarding builds it: the coordinator has no standing rules; the worker holds the team's folder.
  app.keys.setRules(kw.credential.policy_id, (o.workerRules ?? [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:file_*' }, { effect: 'allow', actions: ['fs.list', 'fs.read', 'fs.update'], resource: 'path:/vault/Notes/**' }]) as never, 'test', sys);
  const t = await api('POST', '/teams', { name: `Granted ${n}`, goal: 'g', members: [{ agent_id: coord.id, role: 'coordinator' }, { agent_id: worker.id, role: 'worker' }] });
  expect(t.status, JSON.stringify(t.body)).toBe(201);
  const tid = t.body.team.id as string;
  expect((await api('POST', `/teams/${tid}/start`)).status).toBe(200);
  let tpl: string | null = null;
  if (tplRules) { const r = await api('POST', '/templates', { name: `recruit-tpl-${n}`, rules: tplRules }); expect(r.status, JSON.stringify(r.body)).toBeLessThan(300); tpl = r.body.id; }
  expect((await api('PATCH', `/teams/${tid}`, { recruiting: 'auto', recruit_max: 3, ...(tpl ? { recruit_template_id: tpl } : {}) })).status).toBe(200);
  return { tid, tpl, coord, worker, wPolicy: kw.credential.policy_id, policy: kc.credential.policy_id, C: await loginWith(pcKey, kc.secret) };
}
const ceilingAudits = (tid: string) => (app.db.prepare("SELECT details FROM audit_events WHERE action='team.recruit_ceiling' AND target_id=? ORDER BY rowid").all(tid) as { details: string }[]).map((r) => JSON.parse(r.details));
const recruit = (X: { tid: string; C: Call }, label: string) => X.C('team_recruit', { team_id: X.tid, label, role: 'worker', purpose: 'p' }).then((r) => r.structuredContent);

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahcrg-'));
  mkdirSync(join(dir, 'vault', 'Notes'), { recursive: true });
  writeFileSync(join(dir, 'vault', 'Notes', 'a.md'), '# A\n');
  const client = join(dir, 'client');
  mkdirSync(client);
  for (const f of ['agent-hub-headers.mjs', 'setup.mjs']) writeFileSync(join(client, f), 'export const x = 1;\n');
  writeFileSync(join(client, 'onboarding-prompt.md'), 'Hub {{HUB_URL}} code {{ENROL_CODE}} pc {{PC_NAME}}\n');
  app = await buildApp(testConfig(dir, { publicUrl: 'https://hub.test', clientDir: client, maintenanceSeconds: undefined }));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  admin = await adminLogin(base);
  const add = await api('POST', '/pcs/add', { name: 'grant-pc' });
  expect(add.status, JSON.stringify(add.body)).toBe(200);
  pcId = add.body.pc.id;
  const nonce = 'grant-pc-nonce-0123456789', h = { 'content-type': 'application/json', 'x-forwarded-for': '10.9.0.3', 'x-forwarded-proto': 'https' };
  pcKey = ((await fetch(`${base}/onboard/enrol`, { method: 'POST', headers: h, body: JSON.stringify({ code: add.body.code, nonce }) }).then((x) => x.json())) as any).app_key;
  await fetch(`${base}/onboard/enrol/confirm`, { method: 'POST', headers: h, body: JSON.stringify({ nonce }) });
  expect(pcKey).toMatch(/^ah_app_/);
});
afterAll(async () => { await app.close(); });

const READER = [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:file_*' }, { effect: 'allow', actions: ['fs.list', 'fs.read'], resource: 'path:/vault/Notes/**' }];

describe("a recruit template is checked against the team's ceiling", () => {
  it('a coordinator with only team rules recruits with a template inside the ceiling, and gets no file access itself', async () => {
    const X = await team(READER);
    const before = JSON.stringify(app.keys.rules(X.policy));
    const r = await recruit(X, 'Reader');
    expect(r.error, JSON.stringify(r)).toBeUndefined();
    expect(r).toMatchObject({ status: 'created' });
    // Least access: the coordinator holds no standing rule and no path rule of any kind, before or after.
    expect(app.keys.rules(X.policy, false)).toEqual([]);
    expect(app.keys.rules(X.policy).some((x) => x.resource.startsWith('path:'))).toBe(false);
    expect(JSON.stringify(app.keys.rules(X.policy))).toBe(before);
    expect(ceilingAudits(X.tid).at(-1)).toEqual({ template: X.tpl, owner: null, within: true, members: 2 });
  });

  it('a template wider than the ceiling is refused with a plain reason, and the check is audited', async () => {
    const X = await team([{ effect: 'allow', actions: ['fs.list', 'fs.read'], resource: 'path:/vault/Notes/**' }, { effect: 'allow', actions: ['fs.read'], resource: 'path:/vault/**' }]);
    const r = await recruit(X, 'Too wide');
    expect(r.error).toBe('denied');
    expect(r.message).toBe('The recruit template grants fs.read on path:/vault/**, which no member of the team holds for good. Ask the operator for a narrower template.');
    expect(ceilingAudits(X.tid).at(-1)).toEqual({ template: X.tpl, owner: null, within: false, beyond: { action: 'fs.read', resource: 'path:/vault/**', why: 'team' }, members: 2 });
  });

  it('without a template, or with recruiting off, it is refused with a plain reason', async () => {
    const X = await team(null);
    const r = await recruit(X, 'None');
    expect(r.error).toBe('invalid_state');
    expect(r.message).toMatch(/no recruit template, and the coordinator has no vault access of its own to copy/);
    const Y = await team(READER);
    expect((await api('PATCH', `/teams/${Y.tid}`, { recruiting: 'off' })).status).toBe(200);
    const off = await recruit(Y, 'Off');
    // The team's recruit permission goes with recruiting, so the earlier check refuses first, in its own words.
    expect(off.error).toBe('denied');
    expect(off.message).toMatch(/can recruit agents/);
  });

  it("a member's deny counts: a template reaching a path that member is kept out of is refused", async () => {
    const X = await team([{ effect: 'allow', actions: ['fs.read'], resource: 'path:/vault/Notes/**' }], {
      workerRules: [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:file_*' }, { effect: 'allow', actions: ['fs.list', 'fs.read'], resource: 'path:/vault/Notes/**' },
        { effect: 'deny', actions: ['fs.read'], resource: 'path:/vault/Notes/restricted/**' }] });
    const r = await recruit(X, 'Past the deny');
    expect(r.error).toBe('denied');
    expect(r.message).toMatch(/fs\.read on path:\/vault\/Notes\/\*\*, which no member of the team holds for good/);
    // A template that stays outside the denied part passes.
    const ok = await api('POST', '/templates', { name: `outside-deny-${n}`, rules: [{ effect: 'allow', actions: ['fs.read'], resource: 'path:/vault/Notes/open/**' }] });
    expect((await api('PATCH', `/teams/${X.tid}`, { recruit_template_id: ok.body.id })).status).toBe(200);
    expect(await recruit(X, 'Inside')).toMatchObject({ status: 'created' });
  });

  it("an owned coordinator counts only its owner's agents, within the owner's folder grants", async () => {
    const u = await api('POST', '/users', { username: `own${n}`, display_name: 'Owner', role: 'member' });
    expect(u.status, JSON.stringify(u.body)).toBe(200);
    const owner = u.body.user.id as string;
    // The folder is held only by an operator's (unowned) agent: it does not count for this coordinator.
    const X = await team(READER, { coordOwner: owner });
    const r = await recruit(X, 'Other owner');
    expect(r.error).toBe('denied');
    expect(r.message).toMatch(/no member of the team with the same owner holds for good/);
    expect(ceilingAudits(X.tid).at(-1)).toMatchObject({ owner, within: false, members: 1 });
    // The owner's own agent holds it, but the owner has no grant on the folder: refused, as an invite would be.
    const Y = await team(READER, { coordOwner: owner, workerOwner: owner });
    const r2 = await recruit(Y, 'No grant');
    expect(r2.error).toBe('denied');
    expect(r2.message).toMatch(/outside the owner's folders \(\/vault\/Notes is not inside a folder shared with the owner\)/);
    // With a Read grant on the folder it passes.
    expect((await api('PUT', `/users/${owner}/folder-grants`, { grants: [{ path: '/Notes/', mode: 'read' }] })).status).toBe(200);
    expect(await recruit(Y, 'Granted')).toMatchObject({ status: 'created' });
    // Rename and restore are writes: a Read grant does not cover them, whatever the member holds.
    for (const act of ['fs.rename', 'fs.restore']) {
      const Z = await team([{ effect: 'allow', actions: [act], resource: 'path:/vault/Notes/**' }], { coordOwner: owner, workerOwner: owner,
        workerRules: [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:file_*' }, { effect: 'allow', actions: ['fs.read', act], resource: 'path:/vault/Notes/**' }] });
      const r3 = await recruit(Z, 'Writer');
      expect(r3.error, act).toBe('denied');
      expect(r3.message).toMatch(/the owner's grant on \/Notes\/ is Read, so the agent cannot write there/);
    }
  });

  it('the ceiling is read at recruit time: a member whose access narrowed takes it with them', async () => {
    const X = await team(READER);
    app.keys.setRules(X.wPolicy, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:file_*' }], 'test', sys);
    expect((await recruit(X, 'Late')).error).toBe('denied');
  });

  it("a recruited member's access, a temporary grant and team rules never raise the ceiling", async () => {
    const X = await team(READER);
    // The only holder of the folder is now a recruit of this team: it no longer counts.
    app.db.prepare('UPDATE agents SET recruited_team_id=? WHERE id=?').run(X.tid, X.worker.id);
    expect((await recruit(X, 'Via recruit')).error).toBe('denied');
    app.db.prepare('UPDATE agents SET recruited_team_id=NULL WHERE id=?').run(X.worker.id);
    // A temporary grant on the folder is not held for good.
    app.keys.setRules(X.wPolicy, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:file_*' }], 'test', sys);
    const adminId = (app.db.prepare('SELECT id FROM admin_users LIMIT 1').get() as { id: string }).id, now = Date.now();
    const wCred = app.keys.credentials({ kind: 'session_key', agentId: X.worker.id })[0]!.id;
    app.db.prepare("INSERT INTO temporary_grants(id,credential_id,actions,resource,resource_kind,not_before,not_after,granted_by,created_at) VALUES ('tgr_crg1',?,?,?,'path',?,?,?,?)")
      .run(wCred, JSON.stringify(['fs.list', 'fs.read']), 'path:/vault/Notes/**', now, now + 3600_000, adminId, now);
    expect((await recruit(X, 'Via temp')).error).toBe('denied');
  });
});
