/**
 * Collaborator invites and the shared prompt (docs/onboarding.md, "An invite for a collaborator"; design v3 and its review):
 * the operator invites a collaborator to one team and role, and creating the invite is the approval. The collaborator opens
 * the code in their own console, behind sign-in and two-factor; each opening voids the code before. The prompt they get is
 * the hub's one prompt, without the code. After pairing, the invite's PC sees only its own team and role, never a list,
 * files nothing of its own, and joins with one call; everything is checked again when it joins, so an invite whose team
 * ended or whose owner lost the folders creates nothing. A pairing code is refused by the leak guard like a key.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { testConfig, adminLogin } from './hub.js';
// @ts-expect-error plain JS test helper
import { testCa } from './test-ca.mjs';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const ORIGIN = 'https://hub.test';
type Sess = { cookie: string; csrf: string };
let app: App, base = '', admin: Sess = { cookie: '', csrf: '' }, caSha = '';
let ipSeq = 1;
const freshIp = () => `10.6.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`;

const call = async (who: Sess, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie: who.cookie, 'x-csrf-token': who.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const api = (method: string, path: string, body?: unknown) => call(admin, method, path, body);
/** A call from the PC (the connector), through the trusted loopback proxy over HTTPS. */
const pcCall = async (method: string, path: string, o: { key?: string; body?: unknown } = {}) => {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-forwarded-for': freshIp(), 'x-forwarded-proto': 'https' };
  if (o.key) headers.authorization = `Bearer ${o.key}`;
  const r = await fetch(`${base}${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const pair = (code: string) => pcCall('POST', '/connector/v1/pair', { body: { pairing_code: code, hub_origin: ORIGIN, hub_ca_sha256: caSha, platform: 'linux-x64', version: '0.9.7' } });
const audits = (action: string) => app.db.prepare('SELECT details FROM audit_events WHERE action=? ORDER BY rowid').all(action).map((r: any) => JSON.parse(r.details));
const count = (sql: string, ...a: unknown[]) => (app.db.prepare(sql).get(...a) as { n: number }).n;

let seq = 0;
/** A team onboarded the real way from a PC the operator added: its id, project and the PC's app key. */
const team = async () => {
  const n = ++seq;
  const add = (await api('POST', '/pcs/add', { name: `inv-src-${n}` })).body;
  const key = (await pair(add.code)).body.app_key as string;
  const f = await pcCall('POST', '/onboard/requests', { key, body: {
    kind: 'new_team', project: { name: `Invite project ${n}`, existing: false }, team: { name: `Invite team ${n}`, goal: 'Keep the notes.' },
    roles: [{ name: 'lead', team_role: 'coordinator', count: 1, job: 'Plans.' }, { name: 'writer', team_role: 'worker', count: 1, job: 'Writes.' }],
    prompt: 'a small team', client: { app: 'claude-code', os: 'linux' },
  } });
  expect(f.status, JSON.stringify(f.body)).toBe(200);
  expect((await api('POST', `/onboarding/${f.body.request_id}/approve`, { version: f.body.version })).status).toBe(200);
  const teamId = (app.db.prepare('SELECT team_id t FROM onboarding_requests WHERE id=?').get(f.body.request_id) as { t: string }).t;
  // Picked up and confirmed: the team now counts as onboarded from this PC.
  const up = await pcCall('POST', '/onboard/pickup', { key, body: { request_id: f.body.request_id } });
  expect(up.status, JSON.stringify(up.body)).toBe(200);
  expect((await pcCall('POST', '/onboard/pickup/confirm', { key, body: { pickup_id: up.body.pickup_id, written: up.body.agents.map((x: { session_var: string }) => x.session_var) } })).status).toBe(200);
  return { teamId, project: `Invite project ${n}`, key };
};
let users = 0;
/** A collaborator signed in, with Contribute on /Shared/Team/ and, unless told otherwise, two-factor set up. */
const member = async (twoFactor = true) => {
  const name = `mia${++users}`;
  const c = await api('POST', '/users', { username: name, display_name: `Mia ${users}`, role: 'member' });
  expect(c.status, JSON.stringify(c.body)).toBe(200);
  const id = c.body.user.id as string;
  expect((await api('PUT', `/users/${id}/folder-grants`, { grants: [{ path: '/Shared/Team/', mode: 'contribute' }] })).status).toBe(200);
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: name, password: c.body.password }) });
  const b = (await r.json()) as any;
  if (twoFactor) app.db.prepare("UPDATE admin_users SET totp_secret='test' WHERE id=?").run(id);
  return { id, s: { cookie: r.headers.get('set-cookie')!.split(';')[0]!, csrf: b.csrf } as Sess };
};
const invite = async (teamId: string, ownerId: string, extra: Record<string, unknown> = {}) => {
  const r = await api('POST', '/invites', { team_id: teamId, role: 'writer', team_role: 'worker', owner_id: ownerId, folders: [{ path: '/vault/Shared/Team', access: 'write' }], ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.invite as { id: string };
};

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahinvite-'));
  mkdirSync(join(dir, 'vault', 'Shared', 'Team'), { recursive: true });
  const ca = testCa();
  writeFileSync(join(dir, 'ca.pem'), ca.caPem);
  caSha = ca.caSha256;
  const config: Config = testConfig(dir, { publicUrl: ORIGIN, caCertFile: join(dir, 'ca.pem'), maintenanceSeconds: undefined });
  app = await buildApp(config);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  admin = await adminLogin(base);
});
afterAll(async () => { await app.close(); });

describe('an invite', () => {
  it('is opened by its collaborator only, behind two-factor, with the shared prompt and the code apart', async () => {
    const t = await team(), m = await member(false), other = await member();
    const inv = await invite(t.teamId, m.id);
    expect(audits('onboarding.invite_created').at(-1)).toMatchObject({ invite: inv.id, role: 'writer', owner: m.id, folders: 1 });
    expect((await call(m.s, 'GET', '/me/invites')).body.invites.map((x: any) => x.id)).toEqual([inv.id]);
    expect((await call(other.s, 'GET', '/me/invites')).body.invites).toEqual([]);
    expect((await call(other.s, 'POST', `/me/invites/${inv.id}/code`)).status).toBe(404);
    expect((await call(m.s, 'GET', '/invites')).status).toBe(403); // the operator's list is not theirs
    const no2fa = await call(m.s, 'POST', `/me/invites/${inv.id}/code`);
    expect(no2fa.status).toBe(403);
    expect(no2fa.body.error).toBe('totp_required');
    app.db.prepare("UPDATE admin_users SET totp_secret='test' WHERE id=?").run(m.id);
    const o = await call(m.s, 'POST', `/me/invites/${inv.id}/code`);
    expect(o.status, JSON.stringify(o.body)).toBe(200);
    expect(o.body.code).toMatch(/^cnc-pair-[a-z2-7]{26}$/);
    expect(o.body.pairing.code).toBe(o.body.code);
    expect(o.body.connector_prompt).not.toContain(o.body.code);
    // The very prompt the operator's Add PC shows: one text for the whole hub.
    expect(o.body.connector_prompt).toBe((await api('POST', '/pcs/add', { name: `inv-same-${seq}` })).body.connector_prompt);
  });

  it('voids the old code when it is opened again, and pairs as an invite', async () => {
    const t = await team(), m = await member();
    const inv = await invite(t.teamId, m.id);
    const first = (await call(m.s, 'POST', `/me/invites/${inv.id}/code`)).body.code as string;
    const second = (await call(m.s, 'POST', `/me/invites/${inv.id}/code`)).body.code as string;
    expect(second).not.toBe(first);
    expect((await pair(first)).status).toBe(401);
    const p = await pair(second);
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body).toMatchObject({ code_kind: 'invite', invite: { id: inv.id, role: 'writer', team: { id: t.teamId } } });
    expect((await call(m.s, 'POST', `/me/invites/${inv.id}/code`)).status).toBe(409); // paired: no code to show again
  });

  it('goes through the relay chosen when it is made, and refuses once that relay is removed', async () => {
    const t = await team(), m = await member();
    expect((await api('POST', '/invites', { team_id: t.teamId, team_role: 'worker', owner_id: m.id, relay_id: 'rly_nope' })).status).toBe(404);
    const rca = testCa();
    const rl = await api('POST', '/relays', { name: 'invite-relay', origin: 'https://192.168.50.9:8443', ca_sha256: rca.caSha256 });
    expect(rl.status, JSON.stringify(rl.body)).toBe(200);
    const relay = rl.body.relay as { id: string; origin: string };
    const inv = await invite(t.teamId, m.id, { relay_id: relay.id });
    expect(audits('onboarding.invite_created').at(-1)).toMatchObject({ invite: inv.id, relay: relay.id });
    expect((await call(m.s, 'GET', '/me/invites')).body.invites[0]).toMatchObject({ id: inv.id, relay_id: relay.id });
    const o = await call(m.s, 'POST', `/me/invites/${inv.id}/code`);
    expect(o.status, JSON.stringify(o.body)).toBe(200);
    // The prompt and the pairing block name the relay's address and CA, as Add PC through a relay does.
    expect(o.body.pairing).toMatchObject({ hub_origin: 'https://192.168.50.9:8443', relay: { id: relay.id, name: 'invite-relay' } });
    expect(o.body.connector_prompt).toContain('https://192.168.50.9:8443');
    expect(o.body.connector_prompt).not.toContain(ORIGIN);
    expect((await api('DELETE', `/relays/${relay.id}`)).status).toBe(200);
    const gone = await call(m.s, 'POST', `/me/invites/${inv.id}/code`);
    expect(gone.status).toBe(409);
    expect(gone.body.message).toMatch(/relay this invite goes through was removed/);
    // Refused before a code was made: the code opened earlier is still the only one.
    expect(count("SELECT COUNT(*) n FROM enrolment_codes WHERE machine_id=? AND status='unused'", o.body.pc.id)).toBe(1);
  });

  it("shows the collaborator's agent no list of projects or teams, and the operator's PC its choices", async () => {
    const t = await team(), m = await member();
    const inv = await invite(t.teamId, m.id);
    const key = (await pair((await call(m.s, 'POST', `/me/invites/${inv.id}/code`)).body.code)).body.app_key as string;
    const c = await pcCall('GET', '/onboard/choices', { key });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body).toEqual({ kind: 'invite', invite: { id: inv.id, project: t.project, team: { id: t.teamId, name: expect.any(String) }, role: 'writer', status: 'open' } });
    expect(JSON.stringify(c.body)).not.toContain('projects');
    const pc = await pcCall('GET', '/onboard/choices', { key: t.key });
    expect(pc.body.kind).toBe('pc');
    expect(pc.body.projects.find((p: any) => p.name === t.project).teams[0]).toMatchObject({ id: t.teamId, roles: expect.arrayContaining(['coordinator', 'worker']) });
    // Another PC sees the project, but not this PC's team: it may add agents only to its own teams.
    const other = await team();
    const seen = (await pcCall('GET', '/onboard/choices', { key: other.key })).body.projects;
    expect(seen.find((p: any) => p.name === t.project)).toEqual({ name: t.project, teams: [] });
    expect((await pcCall('GET', '/onboard/choices')).status).toBe(401); // before pairing there is nothing to see
  });

  it('joins with one call, and a collaborator code cannot add a goal, rules or folders', async () => {
    const t = await team(), m = await member();
    const inv = await invite(t.teamId, m.id);
    const key = (await pair((await call(m.s, 'POST', `/me/invites/${inv.id}/code`)).body.code)).body.app_key as string;
    // Its own request, with a goal, rules and folders of its choosing: refused.
    const f = await pcCall('POST', '/onboard/requests', { key, body: { kind: 'add_agents', project: { name: t.project, existing: true }, team: { id: t.teamId, goal: 'Mine now.' },
      roles: [{ name: 'writer', team_role: 'worker', count: 3, job: 'Anything.', folders: [{ path: '/vault', access: 'write' }] }], rules: [{ title: 'r', source: 's', text: 'x' }], prompt: 'p' } });
    expect(f.status).toBe(409);
    expect(f.body.message).toMatch(/invite/);
    // The redeem call takes nothing from the PC: what it sends is ignored, the invite decides.
    const r = await pcCall('POST', `/onboard/invites/${inv.id}/redeem`, { key, body: { folders: [{ path: '/vault', access: 'write' }], goal: 'Mine now.' } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.state).toBe('approved');
    const slot = app.db.prepare('SELECT s.agent_id, s.ceiling, a.owner_user_id owner FROM onboarding_slots s JOIN agents a ON a.id=s.agent_id JOIN onboarding_requests q ON q.id=s.request_id WHERE q.app_credential_id=(SELECT id FROM credentials WHERE machine_id=(SELECT machine_id FROM onboarding_invites WHERE id=?) AND kind=\'app_key\' AND status=\'active\')').all(inv.id) as { agent_id: string; ceiling: string; owner: string }[];
    expect(slot).toHaveLength(1);
    expect(slot[0]!.owner).toBe(m.id);
    expect(slot[0]!.ceiling).not.toMatch(/"\/vault\/?\*?"/);
    expect(app.teams.team(t.teamId)!.goal).toBe('Keep the notes.');
    expect(audits('onboarding.invite_redeemed').at(-1)).toMatchObject({ invite: inv.id, owner: m.id });
    expect((await pcCall('POST', `/onboard/invites/${inv.id}/redeem`, { key })).body.request_id).toBe(r.body.request_id); // once
    expect((await call(m.s, 'GET', '/me/invites')).body.invites).toEqual([]);
  });

  it('creates nothing when the owner lost the folders or the team ended, and says why', async () => {
    const t = await team(), m = await member();
    const inv = await invite(t.teamId, m.id);
    const key = (await pair((await call(m.s, 'POST', `/me/invites/${inv.id}/code`)).body.code)).body.app_key as string;
    expect((await api('PUT', `/users/${m.id}/folder-grants`, { grants: [] })).status).toBe(200);
    const agents = count('SELECT COUNT(*) n FROM agents');
    const r = await pcCall('POST', `/onboard/invites/${inv.id}/redeem`, { key });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('invite_refused');
    expect(r.body.message).toMatch(/shared folders/);
    expect(count('SELECT COUNT(*) n FROM agents')).toBe(agents);
    expect(audits('onboarding.invite_refused').at(-1)).toMatchObject({ invite: inv.id });
    // An ended team: no new invite, and an open one refuses at use.
    const t2 = await team(), m2 = await member();
    const inv2 = await invite(t2.teamId, m2.id);
    const key2 = (await pair((await call(m2.s, 'POST', `/me/invites/${inv2.id}/code`)).body.code)).body.app_key as string;
    expect((await api('POST', `/teams/${t2.teamId}/stop`)).status).toBe(200);
    const agents2 = count('SELECT COUNT(*) n FROM agents');
    expect((await api('POST', '/invites', { team_id: t2.teamId, team_role: 'worker', owner_id: m2.id })).status).toBe(409);
    const r2 = await pcCall('POST', `/onboard/invites/${inv2.id}/redeem`, { key: key2 });
    expect(r2.status).toBe(409);
    expect(r2.body.message).toMatch(/stopped/);
    expect(count('SELECT COUNT(*) n FROM agents')).toBe(agents2);
  });

  it('refuses a folder the owner may not write to when it is made', async () => {
    const t = await team(), m = await member();
    expect((await api('PUT', `/users/${m.id}/folder-grants`, { grants: [{ path: '/Shared/Team/', mode: 'read' }] })).status).toBe(200);
    const r = await api('POST', '/invites', { team_id: t.teamId, team_role: 'worker', owner_id: m.id, folders: [{ path: '/vault/Shared/Team', access: 'write' }] });
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/Read/);
  });

  it('is withdrawn by the operator: the code no longer pairs', async () => {
    const t = await team(), m = await member();
    const inv = await invite(t.teamId, m.id);
    const code = (await call(m.s, 'POST', `/me/invites/${inv.id}/code`)).body.code as string;
    const d = await api('DELETE', `/invites/${inv.id}`);
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(d.body.invite.status).toBe('revoked');
    expect((await pair(code)).status).toBe(401);
    expect((await call(m.s, 'POST', `/me/invites/${inv.id}/code`)).status).toBe(409);
  });
});

describe('a pairing code is guarded like a key', () => {
  it('is an issued hit for the leak guard, and a request that carries it is refused', async () => {
    const add = (await api('POST', '/pcs/add', { name: `inv-leak-${++seq}` })).body;
    expect(app.guard.scan({ text: `my code: ${add.code}` })).toMatchObject({ issued: true });
    expect(app.guard.scan(`spaced ${add.code.split('').join(' ')}`)).toMatchObject({ issued: true });
    const other = (await api('POST', '/pcs/add', { name: `inv-leak-${++seq}` })).body;
    const key = (await pair(other.code)).body.app_key as string;
    const f = await pcCall('POST', '/onboard/requests', { key, body: { kind: 'new_team', project: { name: 'Leak', existing: false }, team: { name: 'Leak', goal: `Use ${add.code}.` },
      roles: [{ name: 'lead', team_role: 'coordinator', count: 1, job: 'Plans.' }], prompt: 'p' } });
    expect(f.status).toBe(400);
    expect(f.body.error).toBe('contains_key');
  });
});
