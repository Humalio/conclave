/**
 * Delegate one agent to a collaborator (docs/checkout.md §9 F1, "Delegate one agent"): the admin delegates one agent of a
 * team to a console member and an ordinary PC; the member opens the prompt in their own console (rendered then, so a new
 * PC's code runs 30 minutes from that moment) and confirms a new PC is theirs before the admin approves it. While it is
 * away the team keeps working around it; once it runs for the member, the member's grant is a ceiling and it works in
 * contributor mode. Take back revokes its key at once and can retire the PC. Teams are onboarded the real way, over HTTP.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { CODE_TTL_MS } from '../src/checkout/render.js';
import { OwnerScope } from '../src/policy/ownerScope.js';
import { opRight, type RightCtx } from '../src/blueprint/rights.js';
import { ownerAllows, withOwners } from '../src/policy/engine.js';
import type { ItemRow } from '../src/blueprint/blueprint.js';
import type { Credential } from '../src/keys/keys.js';
import type { Who } from '../src/teams/teams.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { RESTORE_TEMPLATE, scanClean } from './restoreTemplate.js';
import { testConfig, adminLogin } from './hub.js';

let app: App, base: string, admin = { cookie: '', csrf: '' };
const sys = { kind: 'system' as const, id: null };
type Sess = { cookie: string; csrf: string };

const call = async (who: Sess, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie: who.cookie, 'x-csrf-token': who.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const api = (method: string, path: string, body?: unknown) => call(admin, method, path, body);
const ob = async (method: string, path: string, o: { key?: string; body?: unknown; from?: string } = {}) => {
  if (method === 'POST' && path === '/pickup') scanClean(app.db, (o.body as { request_id?: unknown } | undefined)?.request_id);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (o.key) headers.authorization = `Bearer ${o.key}`;
  if (o.from) { headers['x-forwarded-for'] = o.from; headers['x-forwarded-proto'] = 'https'; }
  const r = await fetch(`${base}/onboard${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  const text = await r.text();
  let body: any; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
};
const nonce = () => `n${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`.slice(0, 24).padEnd(20, 'x');
let ipSeq = 1;
const freshIp = () => `10.9.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`;
const enrol = async (code: string, from = freshIp()) => {
  const n = nonce();
  const e = await ob('POST', '/enrol', { body: { code, nonce: n }, from });
  if (e.status === 200) await ob('POST', '/enrol/confirm', { body: { nonce: n }, from });
  return { status: e.status, key: e.body.app_key as string, from };
};
let seq = 0;
/** A PC enrolled the real way and a team of a coordinator and a worker onboarded from it (running, keys confirmed). */
const onboarded = async () => {
  const n = ++seq;
  const add = await api('POST', '/pcs/add', { name: `dsrc-pc-${n}` });
  expect(add.status, JSON.stringify(add.body)).toBe(200);
  const key = (await enrol(add.body.code)).key;
  const f = await ob('POST', '/requests', { key, body: {
    kind: 'new_team', project: { name: `Lend ${n}`, existing: false }, team: { name: `Lenders ${n}`, goal: 'Lend the work.' },
    roles: [{ name: 'lead', team_role: 'coordinator', count: 1, job: 'Plans.' }, { name: 'dev', team_role: 'worker', count: 1, job: 'Builds.' }],
    prompt: 'a small team', client: { app: 'claude-code', os: 'linux' },
  } });
  expect(f.status, JSON.stringify(f.body)).toBe(200);
  expect((await api('POST', `/onboarding/${f.body.request_id}/approve`, { version: f.body.version })).status).toBe(200);
  const p = await ob('POST', '/pickup', { key, body: { request_id: f.body.request_id } });
  const c = await ob('POST', '/pickup/confirm', { key, body: { pickup_id: p.body.pickup_id, written: p.body.agents.map((x: { session_var: string }) => x.session_var) } });
  expect(c.status, JSON.stringify(c.body)).toBe(200);
  const teamId = c.body.team_id as string;
  const role = (r: string) => app.teams.members(teamId).find((m) => m.role === r)!.agent_id;
  const secrets = p.body.agents as { agent_id: string; secret: string }[];
  return { pc: add.body.pc.id as string, key, teamId, lead: role('coordinator'), dev: role('worker'), devSecret: secrets.find((x) => x.agent_id === role('worker'))!.secret };
};
let users = 0;
/** A console member signed in with its own password, with a grant on the team's project that delegates the team. */
const member = async (teamId?: string, components = ['tasks', 'messages', 'blueprint']) => {
  const name = `lena${++users}`;
  const c = await api('POST', '/users', { username: name, display_name: `Lena ${users}`, role: 'member' });
  expect(c.status, JSON.stringify(c.body)).toBe(200);
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: name, password: c.body.password }) });
  const b = (await r.json()) as any;
  const id = c.body.user.id as string;
  if (teamId) {
    const prj = (app.db.prepare('SELECT project_id p FROM teams WHERE id=?').get(teamId) as { p: string }).p;
    const g = await api('PUT', `/users/${id}/grants`, { grants: [{ project_id: prj, components, delegation: { teams: [teamId] } }] });
    expect(g.status, JSON.stringify(g.body)).toBe(200);
  }
  return { id, label: `Lena ${users}`, s: { cookie: r.headers.get('set-cookie')!.split(';')[0]!, csrf: b.csrf } as Sess };
};
const head = (c: string) => c.repeat(40);
/** The agent checkpoints and writes its handout, as checkout_progress and checkout_handout would. */
const handout = (agentId: string) => {
  app.checkouts.checkpointing(agentId);
  app.checkouts.merged(agentId, { integration_branch: 'integration/core', integration_head: head('a'), merge_commits: [head('e')], worktrees_left: 0, clean: true,
    leftover_check: { worktrees: [], unmerged_branches: [], uncommitted_files: [], build_output: [], scratch: [], processes: [] } });
  app.checkouts.write(agentId, { folder: 'core-dev', notes: 'Next: the parser.', repo: { remote_name: 'origin', url: 'git@git.example.org:team/core.git', clone_folder: 'core' },
    provider_was: { provider: 'claude_code', model: 'opus', permissions: 'acceptEdits' } });
};
const collect = async (key: string, requestId: string) => {
  const p = await ob('POST', '/pickup', { key, body: { request_id: requestId } });
  expect(p.status, JSON.stringify(p.body)).toBe(200);
  const c = await ob('POST', '/pickup/confirm', { key, body: { pickup_id: p.body.pickup_id, written: p.body.agents.map((x: { session_var: string }) => x.session_var) } });
  expect(c.status, JSON.stringify(c.body)).toBe(200);
  return p.body.agents as { agent_id: string; secret: string }[];
};
const appCred = (secret: string): Credential => app.keys.verifyKey(secret, 'app_key');
const credOf = (secret: string) => app.db.prepare('SELECT id FROM credentials WHERE key_id=?').get(/^ah_ses_([a-z2-7]{12})_/.exec(secret)![1]!) as { id: string };
const codeIn = (text: string) => /cnc-pair-[a-z2-7]{26}/.exec(text)?.[0] ?? null;
const code = (fn: () => unknown): string => { try { fn(); } catch (e) { return (e as { code: string }).code ?? String(e); } return 'ok'; };
const auditOf = (action: string, id?: string) => app.db.prepare(`SELECT * FROM audit_events WHERE action=?${id ? ' AND target_id=?' : ''}`).all(...(id ? [action, id] : [action])) as { details: string }[];
const who = (agentId: string, teamId: string): Who => {
  const credId = app.teams.members(teamId).find((x) => x.agent_id === agentId)!.credential_id;
  return { agentId, credId, tokenHash: 'test', rules: app.keys.rules(app.keys.credential(credId)!.policy_id), cap: [] };
};
/** No key, token or enrolment secret in anything a person or the admin's sheet is shown. */
const noSecret = (x: unknown) => expect(JSON.stringify(x)).not.toMatch(/ah_(ses|app|tok)_[a-z0-9_]{8,}|cnv_key_/);
type Res = { isError?: boolean; structuredContent?: any; content: { text: string }[] };
const clients: Client[] = [];
/** An MCP login with a session key through a PC's app key, as the agent would make it there; the raw result, refused or not. */
const mcpLogin = async (appKey: string, secret: string) => {
  const c = new Client({ name: 'claude-code', version: '1' });
  try { await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } })); }
  catch { return { ok: false as const, call: null }; } // the app key itself is refused
  clients.push(c);
  const r = (await c.callTool({ name: 'session_login', arguments: { session_key: secret } }).catch(() => ({ isError: true, content: [] }))) as Res;
  if (r.isError) return { ok: false as const, call: null };
  const token = r.structuredContent.session_token as string;
  return { ok: true as const, call: async (name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name, arguments: { session_token: token, ...args } })
    .catch(() => ({ isError: true, content: [] }))) as Res }; // a refused app key: the transport throws
};
const toolOk = (r: Res) => { expect(r.isError, JSON.stringify(r.structuredContent ?? r.content)).toBeFalsy(); return r.structuredContent; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const away = (teamId: string, agentId: string) => app.teams.members(teamId).find((m) => m.agent_id === agentId)!.away_until ?? null;
const pcWithKey = async () => {
  const t = await api('POST', '/pcs/add', { name: `lena-pc-${++seq}` });
  return { id: t.body.pc.id as string, name: t.body.pc.name as string, key: (await enrol(t.body.code)).key };
};

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahdlg-'));
  mkdirSync(join(dir, 'vault', 'Papers', 'P1'), { recursive: true });
  const client = join(dir, 'client');
  mkdirSync(client);
  writeFileSync(join(client, 'agent-hub-headers.mjs'), 'export const helper = 1;\n');
  writeFileSync(join(client, 'setup.mjs'), 'export const setup = 1;\n');
  writeFileSync(join(client, 'onboarding-prompt.md'), 'Hub {{HUB_URL}} code {{ENROL_CODE}}\n');
  writeFileSync(join(client, 'restore-prompt.md'), RESTORE_TEMPLATE);
  const config: Config = testConfig(dir, { publicUrl: 'https://hub.test', clientDir: client, repoHosts: ['git.example.org'] });
  app = await buildApp(config);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  admin = await adminLogin(base);
});
afterAll(async () => { for (const c of clients) await c.close().catch(() => {}); await app.close(); });

describe('Delegate to an enrolled PC', () => {
  it('runs the whole story: away, the prompt only in the member\'s console, the ceiling, resume, then Take back revokes', async () => {
    const s = await onboarded();
    const lena = await member(s.teamId);
    const pc = await pcWithKey();
    // The sheet's preview: what the agent keeps, in plain words, with contributor mode.
    const pv = await api('GET', `/agents/${s.dev}/delegate/preview?user_id=${lena.id}`);
    expect(pv.status, JSON.stringify(pv.body)).toBe(200);
    expect(pv.body.preview).toMatchObject({ keeps_team_work: true, reads_project: true, contributor: true, loses: [] });
    expect(pv.body.preview.sentence).toContain('proposes them');
    const d = await api('POST', `/agents/${s.dev}/delegate`, { user_id: lena.id, machine_id: pc.id });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    const id = d.body.delegation.id as string;
    expect(d.body.delegation).toMatchObject({ status: 'collecting', contributor: true, delegate: { id: lena.id } });
    noSecret(d.body);
    expect(JSON.parse(auditOf('checkout.delegate', id)[0]!.details)).toMatchObject({ agent: s.dev, delegate: lena.id, pc: pc.id });
    // Collecting: not away yet, no prompt yet.
    expect(away(s.teamId, s.dev)).toBeNull();
    expect((await call(lena.s, 'POST', `/me/delegations/${id}/prompt`)).body.error).toBe('not_ready');
    handout(s.dev);
    expect(app.checkouts.checkout(id)!.status).toBe('ready');
    expect(away(s.teamId, s.dev)).toBeGreaterThan(Date.now()); // away from ready
    // The member's Home: one row, the prompt behind their own sign-in; another member does not see it.
    const mine = await call(lena.s, 'GET', '/me/delegations');
    expect(mine.status).toBe(200);
    expect(mine.body.delegations).toEqual([expect.objectContaining({ id, state: 'ready', prompt_available: true, pc: pc.name })]);
    const other = await member(s.teamId);
    expect((await call(other.s, 'GET', '/me/delegations')).body.delegations).toEqual([]);
    expect((await call(other.s, 'POST', `/me/delegations/${id}/prompt`)).status).toBe(404);
    const pr = await call(lena.s, 'POST', `/me/delegations/${id}/prompt`);
    expect(pr.status, JSON.stringify(pr.body)).toBe(200);
    expect(codeIn(pr.body.prompt)).toBeNull(); // an enrolled PC: no enrolment code
    noSecret(pr.body);
    expect(pr.body.needs_pc_confirmation).toBeUndefined();
    expect(app.checkouts.checkout(id)!.prompt_opened_at).not.toBeNull();
    // The admin's list shows the step, never the prompt.
    const list = await api('GET', '/delegations');
    const row = list.body.delegations.find((x: { id: string }) => x.id === id);
    expect(row.step).toContain('waiting for the restore');
    expect(JSON.stringify(list.body)).not.toContain(pr.body.prompt);
    // The restore on Lena's PC: pickup with that PC's key, confirm → restoring; the ceiling applies from here.
    const req = app.checkouts.checkout(id)!.request_id!;
    const got = await collect(pc.key, req);
    expect(got.map((a) => a.agent_id)).toEqual([s.dev]);
    expect(app.checkouts.checkout(id)!.status).toBe('restoring');
    const os = new OwnerScope(app.db, app.vault.alias);
    expect(os.enforced()).toBe(false);
    expect(os.layers(s.dev)).toEqual([expect.objectContaining({ basis: 'delegate', owner: lena.id, checkout: id })]); // owner enforcement off: still capped
    expect(os.layers(s.lead)).toBeNull(); // the rest of the team is not
    const nk = got[0]!.secret;
    expect(app.keys.credential(credOf(nk).id)!.bound_machine_id).toBe(pc.id);
    const tok = app.keys.login(appCred(pc.key), nk).token;
    // The agent resumes there: no longer away, restored, the member's row says so.
    const h = app.checkouts.handouts(id)[0]!;
    app.checkouts.consume(h.id, h.new_credential_id, sys);
    expect(app.checkouts.checkout(id)!.status).toBe('restored');
    expect(away(s.teamId, s.dev)).toBeNull();
    expect((await call(lena.s, 'GET', '/me/delegations')).body.delegations[0]).toMatchObject({ state: 'running', text: expect.stringContaining(`for `) });
    // A team checkout is refused while the agent is with Lena, and the team's checkout card lists it.
    const tc = await api('POST', `/teams/${s.teamId}/checkout`);
    expect(tc.status).toBe(409);
    expect(tc.body.error).toBe('checkout_conflict');
    expect((await api('GET', `/teams/${s.teamId}/checkout`)).body.delegated).toEqual([expect.objectContaining({ agent_id: s.dev, delegate: lena.label })]);
    // Take back: the key it runs with and its tokens are revoked at once, and the ceiling ends.
    const tb = await api('POST', `/delegations/${id}/take-back`, {});
    expect(tb.status, JSON.stringify(tb.body)).toBe(200);
    expect(tb.body.pc_retired).toBeUndefined();
    expect(app.keys.credential(credOf(nk).id)!.status).toBe('revoked');
    expect(code(() => app.keys.resolveToken(appCred(pc.key), tok))).not.toBe('ok');
    expect(app.keys.credential(tb.body.new_key_id)!.bound_machine_id).toBe(s.pc);
    expect(os.layers(s.dev)).toBeNull();
    expect((await call(lena.s, 'GET', '/me/delegations')).body.delegations[0]).toMatchObject({ state: 'taken_back', text: expect.stringContaining('took') });
    expect(JSON.parse(auditOf('checkout.take_back', id)[0]!.details)).toMatchObject({ agent: s.dev, delegate: lena.id, revoked_credential: credOf(nk).id });
    // Afterwards a team checkout works again.
    const again = await api('POST', `/teams/${s.teamId}/checkout`);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect((await api('POST', `/checkouts/${again.body.checkout.id}/cancel`, { reason: 'test' })).status).toBe(200);
  });
});

describe('Delegate to a new PC', () => {
  it('is refused: the person adds the PC with the connector first; no PC, key or code is created', async () => {
    const s = await onboarded();
    const lena = await member(s.teamId);
    const machines = app.keys.machines().length;
    const d = await api('POST', `/agents/${s.dev}/delegate`, { user_id: lena.id, new_pc_name: `lena-laptop-${seq}` });
    expect(d.status).toBe(409);
    expect(d.body).toMatchObject({ error: 'invalid_state', reason: 'add_pc_first', message: expect.stringMatching(/Add this PC with the connector first.*approve a destination/) });
    expect(app.keys.machines().length).toBe(machines);
    expect((await api('POST', `/agents/${s.dev}/delegate`, { user_id: lena.id })).status).toBe(400);
  });
});

describe('End to end over MCP: the delegated agent resumes on the PC of the member, and Take back shuts out both keys', () => {
  // The resume check on a throwaway hub: every code and key is issued and used in memory by the test, nothing printed or written.
  for (const path of ['an enrolled PC'] as const) {
    it(`${path}: delegate, open the prompt, restore, checkout_resume, then Take back`, async () => {
      const s = await onboarded();
      const lena = await member(s.teamId);
      // The agent runs on the admin's PC with its original key.
      const old = await mcpLogin(s.key, s.devSecret);
      expect(old.ok).toBe(true);
      toolOk(await old.call!('checkout_status'));
      const known = path === 'an enrolled PC' ? await pcWithKey() : null;
      const newName = `lena-e2e-${seq}`;
      const d = await api('POST', `/agents/${s.dev}/delegate`, known ? { user_id: lena.id, machine_id: known.id } : { user_id: lena.id, new_pc_name: newName });
      expect(d.status, JSON.stringify(d.body)).toBe(200);
      const id = d.body.delegation.id as string;
      handout(s.dev);
      // The member opens the prompt in their console: the render happens now.
      const pr = await call(lena.s, 'POST', `/me/delegations/${id}/prompt`);
      expect(pr.status, JSON.stringify(pr.body)).toBe(200);
      expect(app.checkouts.checkout(id)!.status).toBe('rendered');
      let pcKey: string;
      if (known) {
        expect(codeIn(pr.body.prompt)).toBeNull();
        pcKey = known.key;
      } else {
        // The new PC enrols with the prompt's code; the member confirms it is theirs; then the admin approves it.
        const e = await enrol(codeIn(pr.body.prompt)!);
        expect(e.status).toBe(200);
        expect((await api('POST', `/checkouts/${id}/approve-pc`)).body.error).toBe('pc_not_confirmed');
        expect((await call(lena.s, 'POST', `/me/delegations/${id}/pc`, { mine: true })).status).toBe(200);
        const a = await api('POST', `/checkouts/${id}/approve-pc`);
        expect(a.status, JSON.stringify(a.body)).toBe(200);
        pcKey = e.key;
      }
      // The restore on the member's PC: pickup and confirm with that PC's key.
      const got = await collect(pcKey, app.checkouts.checkout(id)!.request_id!);
      expect(got.map((x) => x.agent_id)).toEqual([s.dev]);
      expect(app.checkouts.checkout(id)!.status).toBe('restoring');
      await sleep(5); // a login after the confirm, as on a real PC
      // The agent starts there and calls checkout_resume: its handout comes back once and the move is restored.
      const moved = await mcpLogin(pcKey, got[0]!.secret);
      expect(moved.ok).toBe(true);
      const res = toolOk(await moved.call!('checkout_resume', { client: 'claude-code' }));
      expect(res).toMatchObject({ checkout_id: id, restored: true, handout: { trust: 'L2', folder: 'core-dev' } });
      expect(app.checkouts.checkout(id)!.status).toBe('restored');
      expect(away(s.teamId, s.dev)).toBeNull();
      toolOk(await moved.call!('checkout_status'));
      // The original key no longer works anywhere.
      expect((await old.call!('checkout_status')).isError).toBe(true);
      expect((await mcpLogin(s.key, s.devSecret)).ok).toBe(false);
      // Take back: the delegated key and its session are refused at once.
      const tb = await api('POST', `/delegations/${id}/take-back`, {});
      expect(tb.status, JSON.stringify(tb.body)).toBe(200);
      expect((await moved.call!('checkout_status')).isError).toBe(true);
      expect((await mcpLogin(pcKey, got[0]!.secret)).ok).toBe(false);
      expect((await mcpLogin(s.key, s.devSecret)).ok).toBe(false);
      expect(app.keys.credential(tb.body.new_key_id)!.status).not.toBe('revoked');
      expect(tb.body.pc_retired).toBeUndefined();
      noSecret(tb.body);
    });
  }
});

describe('Take back takes no options', () => {
  it('retire_pc is refused: a PC is never enrolled by a delegation, so there is nothing to retire', async () => {
    const s = await onboarded();
    const lena = await member(s.teamId);
    const pc = await pcWithKey();
    const id = (await api('POST', `/agents/${s.dev}/delegate`, { user_id: lena.id, machine_id: pc.id })).body.delegation.id as string;
    handout(s.dev);
    expect((await api('POST', `/delegations/${id}/take-back`, { retire_pc: true })).status).toBe(400);
    expect(app.checkouts.checkout(id)).toMatchObject({ status: 'ready', released_at: null });
    expect(auditOf('checkout.take_back', id)).toHaveLength(0);
    expect((await api('POST', `/delegations/${id}/take-back`, {})).status).toBe(200);
  });
});

describe('Who may delegate, and what is refused', () => {
  it('only the admin delegates and takes back; a member gets 403 on the admin routes', async () => {
    const s = await onboarded();
    const lena = await member(s.teamId);
    const pc = await pcWithKey();
    expect((await call(lena.s, 'POST', `/agents/${s.dev}/delegate`, { user_id: lena.id, machine_id: pc.id })).status).toBe(403);
    expect((await call(lena.s, 'GET', '/delegations')).status).toBe(403);
    expect((await call(lena.s, 'GET', `/agents/${s.dev}/delegate/preview?user_id=${lena.id}`)).status).toBe(403);
    const d = await api('POST', `/agents/${s.dev}/delegate`, { user_id: lena.id, machine_id: pc.id });
    expect((await call(lena.s, 'POST', `/delegations/${d.body.delegation.id}/take-back`, {})).status).toBe(403);
    expect((await api('POST', `/delegations/${d.body.delegation.id}/take-back`, {})).status).toBe(200);
  });
  it('refuses a team\'s only coordinator, a grant with no project to read, both PC fields, and a second delegation', async () => {
    const s = await onboarded();
    const lena = await member(s.teamId);
    const pc = await pcWithKey();
    const lead = await api('POST', `/agents/${s.lead}/delegate`, { user_id: lena.id, machine_id: pc.id });
    expect(lead.status).toBe(409);
    expect(lead.body.error).toBe('only_coordinator');
    const bare = await member(); // no grant at all
    const nb = await api('POST', `/agents/${s.dev}/delegate`, { user_id: bare.id, machine_id: pc.id });
    expect(nb.body.error).toBe('no_project');
    expect((await api('POST', `/agents/${s.dev}/delegate`, { user_id: lena.id, machine_id: pc.id, new_pc_name: 'x' })).status).toBe(400);
    const ok = await api('POST', `/agents/${s.dev}/delegate`, { user_id: lena.id, machine_id: pc.id });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await api('POST', `/agents/${s.dev}/delegate`, { user_id: lena.id, machine_id: pc.id })).body.error).toBe('checkout_open');
    await api('POST', `/delegations/${ok.body.delegation.id}/take-back`, {});
  });
  it('refuses to delegate while the team has an open team checkout', async () => {
    const s = await onboarded();
    const lena = await member(s.teamId);
    const pc = await pcWithKey();
    const tc = await api('POST', `/teams/${s.teamId}/checkout`);
    expect(tc.status).toBe(200);
    const d = await api('POST', `/agents/${s.dev}/delegate`, { user_id: lena.id, machine_id: pc.id });
    expect(d.status).toBe(409);
    expect(d.body.error).toBe('checkout_conflict');
    await api('POST', `/checkouts/${tc.body.checkout.id}/cancel`, { reason: 'test' });
  });
});

describe('Away routing and contributor mode in tasks', () => {
  it('while away: no assignment and no claim, and the sweeps skip it; once delegated it takes only named tasks', async () => {
    const s = await onboarded();
    const lena = await member(s.teamId);
    const pc = await pcWithKey();
    const lead = who(s.lead, s.teamId), dev = who(s.dev, s.teamId);
    const mk = (claimable = false) => app.teams.create_task(lead, { team_id: s.teamId, title: `Task ${++seq}`, claimable, operator_request: { source: 'test' } });
    const d = await api('POST', `/agents/${s.dev}/delegate`, { user_id: lena.id, machine_id: pc.id });
    const id = d.body.delegation.id as string;
    // The dev holds a started task past its check-in time when it goes away: the overdue sweep leaves it alone.
    const held = mk();
    app.teams.assign(lead, { task_id: held.id, agent_id: s.dev });
    app.db.prepare("UPDATE tasks SET status='in_progress', lease_expires_at=? WHERE id=?").run(Date.now() - 1000, held.id);
    handout(s.dev);
    const turns = (app.teams as unknown as { turns: { sweep(now?: number): { overdue: { id: string }[] } } }).turns;
    expect(turns.sweep().overdue.map((x) => x.id)).not.toContain(held.id);
    expect(app.teams.task(held.id)!.assignee_agent_id).toBe(s.dev); // it keeps its holder
    expect(code(() => app.teams.assign(lead, { task_id: mk().id, agent_id: s.dev }))).toBe('agent_away');
    const open = mk(true);
    expect(code(() => app.teams.claim(dev, { task_id: open.id, version: app.teams.task(open.id)!.version }))).toBe('agent_away');
    // Resumed on Lena's PC: assigned by name works; claiming does not, and it is not told of open claimable work.
    await call(lena.s, 'POST', `/me/delegations/${id}/prompt`);
    await collect(pc.key, app.checkouts.checkout(id)!.request_id!);
    const h = app.checkouts.handouts(id)[0]!;
    app.checkouts.consume(h.id, h.new_credential_id, sys);
    const named = mk();
    expect(code(() => app.teams.assign(lead, { task_id: named.id, agent_id: s.dev }))).toBe('ok');
    const open2 = mk(true);
    const dev2 = who(s.dev, s.teamId);
    expect(code(() => app.teams.claim(dev2, { task_id: open2.id, version: app.teams.task(open2.id)!.version }))).toBe('denied');
    const offered = app.db.prepare("SELECT COUNT(*) n FROM agent_notices WHERE agent_id=? AND kind='task_open' AND body LIKE ?").get(s.dev, `%${open2.id}%`) as { n: number };
    expect(offered.n).toBe(0);
    // Task text it writes is labelled with Lena (the handed-over label).
    expect(app.teams.delegatedTo(s.dev)).toBe(lena.id);
    await api('POST', `/delegations/${id}/take-back`, {});
    expect(app.teams.delegatedTo(s.dev)).toBeNull();
  });
});

describe('Contributor mode in the Blueprint (rights.ts)', () => {
  const since = 1_000;
  const row = (o: Partial<ItemRow>): ItemRow => ({ id: 'i', project_id: 'p', kind: 'finding', key: 'F1', parent_key: 'L1', title: 't', body: null, fields: '{}', status: null, team_id: 'T',
    position: 0, rev: 1, origin: null, origin_id: null, created_by_kind: 'agent', created_by_id: 'A', created_at: since + 10, updated_by_kind: 'agent', updated_by_id: 'A', updated_at: since + 10,
    deleted_at: null, changed_version: null, ...o } as ItemRow);
  const rows: Record<string, ItemRow> = {
    L1: row({ kind: 'line', key: 'L1', parent_key: null, status: 'active', created_by_kind: 'operator', created_by_id: null }),
    F1: row({}), // its own, created during the delegation
    F0: row({ key: 'F0', created_at: since - 10 }), // its own, but from before the delegation
    F9: row({ key: 'F9', created_by_id: 'B' }), // someone else's
    RK1: row({ kind: 'risk', key: 'RK-01', parent_key: null, status: 'open', team_id: null }),
  };
  const ctx = (role: 'coordinator' | 'member', contributor = true): RightCtx => ({ role, teamId: 'T', row: (k) => rows[k], contributor: contributor ? { agentId: 'A', since, delegate: 'Lena' } : null });
  it('creates a finding and edits what it created during the delegation, as its role allows', () => {
    expect(opRight({ op: 'upsert', kind: 'finding', key: 'F2', parent_key: 'L1', title: 'new' }, ctx('member')).verdict).toBe('apply');
    expect(opRight({ op: 'upsert', kind: 'finding', key: 'F1', title: 'edited' }, ctx('member')).verdict).toBe('apply');
  });
  it('proposes edits to items it created before the delegation or that others created', () => {
    const r0 = opRight({ op: 'upsert', kind: 'finding', key: 'F0', title: 'edited' }, ctx('member'));
    expect(r0).toMatchObject({ verdict: 'propose', why: expect.stringContaining('contributor mode (for Lena)') });
    expect(opRight({ op: 'upsert', kind: 'finding', key: 'F9', title: 'edited' }, ctx('member')).verdict).toBe('propose');
    expect(opRight({ op: 'upsert', kind: 'finding', key: 'F9', title: 'edited' }, ctx('member', false)).verdict).toBe('apply'); // without contributor mode it applies
  });
  it('refuses deleting, project-level items and moving to another team', () => {
    expect(opRight({ op: 'remove', key: 'F1' }, ctx('coordinator')).verdict).toBe('deny');
    expect(opRight({ op: 'upsert', kind: 'risk', key: 'RK-02', title: 'r' }, ctx('coordinator')).verdict).toBe('deny'); // project level
    expect(opRight({ op: 'upsert', kind: 'finding', key: 'F1', team_id: 'U', title: 'x' }, ctx('coordinator')).verdict).not.toBe('apply');
  });
  it('never widens the role: a delegated worker still only proposes a question', () => {
    const q = { op: 'upsert' as const, kind: 'question', key: 'Q-1', parent_key: 'L1', title: 'why?' };
    expect(opRight(q, ctx('member', false)).verdict).toBe('propose');
    expect(opRight(q, ctx('member')).verdict).toBe('propose');
  });
});

describe('Contributor mode in the vault and rooms', () => {
  it('the drafts folder is the admin\'s explicit grant, the only place the agent writes; it goes when the delegation ends', async () => {
    const s = await onboarded();
    const lena = await member(s.teamId);
    const pc = await pcWithKey();
    const drafts = '/Papers/P1/contrib/Dev/';
    const d = await api('POST', `/agents/${s.dev}/delegate`, { user_id: lena.id, machine_id: pc.id, drafts_folder: drafts });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    const id = d.body.delegation.id as string;
    expect(d.body.delegation.drafts_folder).toBe(drafts);
    expect(app.users.folderGrants(lena.id).map((g) => [g.path, g.mode])).toEqual([[drafts, 'contribute']]);
    handout(s.dev);
    await call(lena.s, 'POST', `/me/delegations/${id}/prompt`);
    await collect(pc.key, app.checkouts.checkout(id)!.request_id!);
    const os = new OwnerScope(app.db, app.vault.alias);
    const cap = withOwners([], os.layers(s.dev)!);
    const v = `/${app.vault.alias}`;
    expect(ownerAllows(cap, 'fs.create', `path:${v}${drafts}note.md`)).toBe(true);
    expect(ownerAllows(cap, 'fs.read', `path:${v}${drafts}note.md`)).toBe(true);
    expect(ownerAllows(cap, 'fs.create', `path:${v}/Papers/P1/paper.md`)).toBe(false);
    const room = (app.db.prepare('SELECT room_id r FROM teams WHERE id=?').get(s.teamId) as { r: string | null }).r;
    if (room) {
      expect(ownerAllows(cap, 'room.read_history', `room:${room}`)).toBe(true);
      expect(ownerAllows(cap, 'room.post', `room:${room}`)).toBe(false); // it reads the room, posts nothing
    }
    expect((await api('POST', `/delegations/${id}/take-back`, {})).status).toBe(200);
    expect(app.users.folderGrants(lena.id)).toEqual([]);
    expect(auditOf('checkout.drafts_removed', id)).toHaveLength(1);
  });
  it('a Blueprint write while delegated names contributor mode, and the item is labelled with the delegate', async () => {
    const s = await onboarded();
    const lena = await member(s.teamId);
    const pc = await pcWithKey();
    const d = await api('POST', `/agents/${s.dev}/delegate`, { user_id: lena.id, machine_id: pc.id });
    const id = d.body.delegation.id as string;
    handout(s.dev);
    await call(lena.s, 'POST', `/me/delegations/${id}/prompt`);
    await collect(pc.key, app.checkouts.checkout(id)!.request_id!);
    const h = app.checkouts.handouts(id)[0]!;
    app.checkouts.consume(h.id, h.new_credential_id, sys);
    expect(app.blueprint.contributorOf(s.dev)).toMatchObject({ agentId: s.dev, delegate: lena.label });
    expect(app.blueprint.contributorOf(s.lead)).toBeNull();
    // A risk filed at project level is refused in contributor mode, with the mode named.
    const p = app.blueprint.projectOfTeam(s.teamId)!;
    const r = app.blueprint.check(p.id, { version: p.version, ops: [{ op: 'upsert', kind: 'risk', key: 'RK-*', title: 'A risk' }] }, s.dev);
    expect(r.outcome).not.toBe('apply');
    // "via <delegate>" wherever the agent's writes show: the item's revisions, its proposals, and the work feed.
    const ver = () => app.blueprint.projectOfTeam(s.teamId)!.version;
    const keyOf = (title: string) => (app.db.prepare('SELECT key, id FROM bp_items WHERE project_id=? AND title=?').get(p.id, title) as { key: string; id: string });
    app.blueprint.write(p.id, { version: ver(), ops: [{ op: 'upsert', kind: 'risk', key: 'RK-*', title: 'Shared risk', team_id: s.teamId }] }, { kind: 'operator', id: null });
    app.blueprint.write(p.id, { version: ver(), ops: [{ op: 'upsert', kind: 'risk', key: 'RK-*', title: 'Agent risk', team_id: s.teamId }] }, { kind: 'agent', id: s.dev });
    expect(app.blueprint.revisions(keyOf('Agent risk').id)[0]).toMatchObject({ actor_kind: 'agent', via: lena.label });
    expect(app.blueprint.revisions(keyOf('Shared risk').id)[0]!.via).toBeUndefined(); // the operator's write has none
    const sub = app.blueprint.submit(p.id, { version: ver(), ops: [{ op: 'upsert', kind: 'risk', key: keyOf('Shared risk').key, title: 'Shared risk, reworded' }], team_id: s.teamId }, s.dev);
    expect(sub.status).toBe('proposed');
    const prop = (sub as { proposal: { id: string; via?: string } }).proposal;
    expect(app.blueprint.proposal(prop.id)!.via).toBe(lena.label);
    expect(app.blueprint.proposals(p.id).find((x) => x.id === prop.id)!.via).toBe(lena.label);
    const feed = await api('GET', '/work/recent?limit=50');
    expect(feed.status, JSON.stringify(feed.body)).toBe(200);
    const mineEv = feed.body.events.filter((e: { actor: { id: string | null } }) => e.actor.id === s.dev);
    expect(mineEv.length).toBeGreaterThan(0);
    for (const e of mineEv) expect(e.actor.via).toBe(lena.label);
    expect(feed.body.events.filter((e: { actor: { kind: string } }) => e.actor.kind !== 'agent').every((e: { actor: { via?: string } }) => e.actor.via === undefined)).toBe(true);
    await api('POST', `/delegations/${id}/take-back`, {});
    expect(app.blueprint.contributorOf(s.dev)).toBeNull();
    // After Take back its writes carry no label; the earlier ones keep theirs.
    await new Promise((res) => setTimeout(res, 5));
    app.blueprint.write(p.id, { version: ver(), ops: [{ op: 'upsert', kind: 'risk', key: 'RK-*', title: 'Later risk', team_id: s.teamId }] }, { kind: 'agent', id: s.dev });
    expect(app.blueprint.revisions(keyOf('Later risk').id)[0]!.via).toBeUndefined();
    expect(app.blueprint.revisions(keyOf('Agent risk').id)[0]!.via).toBe(lena.label);
  });
});
