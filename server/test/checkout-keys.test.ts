/**
 * Checkout phase 2, keys and render (docs/checkout.md §5, §9 F6 and F8, §10 row 2): Keys.issueSuccessor, suspended tokens,
 * the checkout kind of onboarding request with forced binding, a second app key for another OS user, the new-PC approval,
 * the render route with the push list and repo_no_remote, and the target table. One story per target, over HTTP: teams are
 * onboarded the real way, so the source PC, its key and slots are what the hub would have.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildApp, type App } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { EXPIRY_MS } from '../src/checkout/checkout.js';
import { TARGETS, validRef } from '../src/checkout/render.js';
import type { Credential } from '../src/keys/keys.js';
import { RESTORE_TEMPLATE, scanClean } from './restoreTemplate.js';
import { testConfig, adminLogin } from './hub.js';

let app: App, base: string, cookie = '', csrf = '';
const sys = { kind: 'system' as const, id: null };

const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const ob = async (method: string, path: string, o: { key?: string; body?: unknown; from?: string } = {}) => {
  // The config scan is not what these tests are about: every folder is recorded clean before a pickup (docs/checkout.md §6 step 4).
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
const freshIp = () => `10.8.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`;
const enrol = async (code: string, from = freshIp()) => {
  const n = nonce();
  const e = await ob('POST', '/enrol', { body: { code, nonce: n }, from });
  if (e.status === 200) await ob('POST', '/enrol/confirm', { body: { nonce: n }, from });
  return { status: e.status, key: e.body.app_key as string, from };
};
let seq = 0;
let clientDir = '';
/** A PC enrolled the real way, and a team of a coordinator and a worker onboarded from it (running, keys confirmed). */
const onboarded = async (pcName?: string) => {
  const n = ++seq;
  const add = await api('POST', '/pcs/add', { name: pcName ?? `src-pc-${n}` });
  expect(add.status, JSON.stringify(add.body)).toBe(200);
  const e = await enrol(add.body.code);
  const team = await onboardTeam(e.key, n);
  return { pc: add.body.pc.id as string, key: e.key, keyId: add.body.key.id as string, ...team };
};
const onboardTeam = async (key: string, n = ++seq) => {
  const f = await ob('POST', '/requests', { key, body: {
    kind: 'new_team', project: { name: `Move ${n}`, existing: false }, team: { name: `Mover ${n}`, goal: 'Move the work.' },
    roles: [{ name: 'lead', team_role: 'coordinator', count: 1, job: 'Plans.' }, { name: 'dev', team_role: 'worker', count: 1, job: 'Builds.' }],
    prompt: 'a small team', client: { app: 'claude-code', os: 'linux' },
  } });
  expect(f.status, JSON.stringify(f.body)).toBe(200);
  const a = await api('POST', `/onboarding/${f.body.request_id}/approve`, { version: f.body.version });
  expect(a.status, JSON.stringify(a.body)).toBe(200);
  const p = await ob('POST', '/pickup', { key, body: { request_id: f.body.request_id } });
  expect(p.status, JSON.stringify(p.body)).toBe(200);
  const c = await ob('POST', '/pickup/confirm', { key, body: { pickup_id: p.body.pickup_id, written: p.body.agents.map((x: { session_var: string }) => x.session_var) } });
  expect(c.status, JSON.stringify(c.body)).toBe(200);
  return { teamId: c.body.team_id as string, requestId: f.body.request_id as string,
    agents: p.body.agents.map((x: { agent_id: string; secret: string; session_var: string; folder: string }) => ({ id: x.agent_id, secret: x.secret, var: x.session_var, folder: x.folder })) as { id: string; secret: string; var: string; folder: string }[] };
};
const head = (c: string) => c.repeat(40);
/** Start a checkout and write every handout: clean checkpoints, a repo (with a remote unless noRemote), provider facts. */
const ready = async (teamId: string, o: { noRemote?: boolean; unreviewed?: boolean; codexAt?: number } = {}) => {
  const s = await api('POST', `/teams/${teamId}/checkout`);
  expect(s.status, JSON.stringify(s.body)).toBe(200);
  const id = s.body.checkout.id as string;
  const heads = ['a', 'b', 'c', 'd'];
  app.checkouts.handouts(id).forEach((h, i) => {
    app.checkouts.checkpointing(h.agent_id);
    app.checkouts.merged(h.agent_id, { integration_branch: 'integration/core', integration_head: head(heads[i]!), merge_commits: [head('e')], worktrees_left: 0, clean: true,
      leftover_check: { worktrees: [], unmerged_branches: [], uncommitted_files: [], build_output: [], scratch: [], processes: [] },
      ...(o.unreviewed && i === 1 ? { checkout_head: head('f') } : {}) });
    app.checkouts.write(h.agent_id, { folder: `core-${i}`, notes: 'Next: the parser.',
      repo: o.noRemote ? { remote_name: 'origin', clone_folder: 'core' } : { remote_name: 'origin', url: 'git@git.example.org:team/core.git', clone_folder: 'core' },
      provider_was: o.codexAt === i ? { provider: 'codex', model: 'gpt-5-codex', permissions: 'default' } : { provider: 'claude_code', model: 'opus', permissions: 'acceptEdits' } });
  });
  expect(app.checkouts.checkout(id)!.status).toBe('ready');
  return id;
};
const appCred = (secret: string): Credential => app.keys.verifyKey(secret, 'app_key');
const memberKey = (teamId: string, agentId: string) => app.teams.members(teamId).find((m) => m.agent_id === agentId)!.credential_id;
const keyId = (secret: string) => /^ah_ses_([a-z2-7]{12})_/.exec(secret)![1]!;
const credOf = (secret: string) => app.db.prepare('SELECT id FROM credentials WHERE key_id=?').get(keyId(secret)) as { id: string };
const codeIn = (text: string) => /cnc-pair-[a-z2-7]{26}/.exec(text)?.[0] ?? null;
const err = (fn: () => unknown): string => { try { fn(); } catch (e) { return (e as { code: string }).code; } return 'ok'; };
const auditOf = (action: string, id?: string) => app.db.prepare(`SELECT * FROM audit_events WHERE action=?${id ? ' AND target_id=?' : ''}`).all(...(id ? [action, id] : [action])) as { details: string }[];
/** Pick up and confirm a checkout request with an app key, as setup.mjs restore will. */
const collect = async (key: string, requestId: string) => {
  const p = await ob('POST', '/pickup', { key, body: { request_id: requestId } });
  expect(p.status, JSON.stringify(p.body)).toBe(200);
  const c = await ob('POST', '/pickup/confirm', { key, body: { pickup_id: p.body.pickup_id, written: p.body.agents.map((x: { session_var: string }) => x.session_var) } });
  expect(c.status, JSON.stringify(c.body)).toBe(200);
  return p.body.agents as { agent_id: string; secret: string; session_var: string; folder: string }[];
};

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahckk-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  const client = join(dir, 'client');
  clientDir = client;
  mkdirSync(client);
  writeFileSync(join(client, 'agent-hub-headers.mjs'), 'export const helper = 1;\n');
  writeFileSync(join(client, 'setup.mjs'), 'export const setup = 1;\n');
  writeFileSync(join(client, 'onboarding-prompt.md'), 'Hub {{HUB_URL}} code {{ENROL_CODE}}\n');
  writeFileSync(join(client, 'restore-prompt.md'), RESTORE_TEMPLATE);
  // The handouts name git.example.org: the repo host allowlist (§8) is seeded with it, as CONCLAVE_REPO_HOSTS would.
  const config: Config = testConfig(dir, { publicUrl: 'https://hub.test', clientDir: client, repoHosts: ['git.example.org'] });
  app = await buildApp(config);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base));
});
afterAll(async () => { await app.close(); });

describe('Keys.issueSuccessor and suspended tokens', () => {
  it('adds an active successor bound to the target, keeps the old key working, moves membership and sends no notice', async () => {
    const s = await onboarded();
    const free = app.keys.createAgent('free agent', null, sys);
    const old = app.keys.createSessionKey({ agentId: free.id, label: 'free key' }, sys);
    app.keys.setRules(old.credential.policy_id, [{ effect: 'allow', actions: ['fs.read'], resource: 'path:/vault/X/**' }], 'grant', sys);
    const notices = () => (app.db.prepare('SELECT COUNT(*) n FROM agent_notices WHERE agent_id=?').get(free.id) as { n: number }).n;
    const before = notices();
    const n = app.keys.issueSuccessor(old.credential.id, s.pc, sys);
    expect(n.credential.replaces_credential_id).toBe(old.credential.id);
    expect(n.credential.bound_machine_id).toBe(s.pc); // bound even though the old key was free
    expect(app.keys.rules(n.credential.policy_id).map((r) => r.resource)).toEqual(['path:/vault/X/**']);
    expect(app.keys.credential(old.credential.id)).toMatchObject({ status: 'active', succession: 'superseded_pending' });
    expect(notices()).toBe(before);
    expect(err(() => app.keys.issueSuccessor(old.credential.id, s.pc, sys))).toBe('conflict'); // one at a time
    // Old logins go on until confirm; then they are suspended (not revoked) and the old key cannot log in again.
    const via = appCred(s.key);
    const tok = app.keys.login(via, old.secret).token;
    app.keys.confirmSuccessor(n.credential.id, 'cko_test', sys);
    expect(err(() => app.keys.resolveToken(via, tok))).toBe('key_inactive');
    expect(err(() => app.keys.login(via, old.secret))).toBe('suspended');
    expect(app.keys.liveLogins({ credentialId: old.credential.id })).toHaveLength(0);
    // Revert: the successor is revoked and the old session works again.
    app.keys.revertSuccessor(n.credential.id, 'test', sys, 'cko_test');
    expect(app.keys.credential(n.credential.id)!.status).toBe('revoked');
    expect(app.keys.credential(old.credential.id)!.succession).toBeNull();
    expect(app.keys.resolveToken(via, tok).credential.id).toBe(old.credential.id);
    expect(app.keys.login(via, old.secret).token).toMatch(/^ah_tok_/);
  });
});

/** An enrolled PC to move to: its own key picks the request up. */
const targetPc = async () => {
  const t = await api('POST', '/pcs/add', { name: `target-pc-${++seq}` });
  return { pc: t.body.pc.id as string, key: (await enrol(t.body.code)).key as string, keyId: t.body.key.id as string };
};

describe('the target table', () => {
  it('lists the targets with their rules, defaults per agent, and refuses other targets for a repo with no remote', async () => {
    expect(TARGETS.same_user).toMatchObject({ rotate: 'default_on', push_list: false, needs_remote: false });
    expect(Object.keys(TARGETS)).toEqual(['same_user', 'other_pc']);
    expect(TARGETS.other_pc).toMatchObject({ rotate: 'forced', push_list: true, needs_remote: true });
    const s = await onboarded();
    const id = await ready(s.teamId, { noRemote: true });
    const v = await api('GET', `/checkouts/${id}`);
    expect(v.status).toBe(200);
    expect(v.body.options.targets.same_user).toMatchObject({ allowed: true, reason: null });
    expect(v.body.options.targets.same_pc_other_user).toBeUndefined();
    expect(v.body.options.targets.other_pc).toMatchObject({ allowed: false, reason: 'repo_no_remote' });
    expect(v.body.options.repo_no_remote.sort()).toEqual(s.agents.map((a) => a.id).sort());
    expect(v.body.options.agents[s.agents[0]!.id]).toEqual({ provider: 'claude_code', model: 'opus', permissions: 'acceptEdits' });
    const target = await onboarded();
    const r = await api('POST', `/checkouts/${id}/render`, { target: 'other_pc', machine_id: target.pc });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('repo_no_remote');
    expect((await api('POST', `/checkouts/${id}/render`, { target: 'same_user' })).status).toBe(200);
  });
  it('validates the render: rotation forced off same_user, machine_id only for other_pc, permissions only lowered', async () => {
    const s = await onboarded();
    const id = await ready(s.teamId);
    const w = s.agents[1]!.id;
    expect((await api('POST', `/checkouts/${id}/render`, { target: 'other_pc', machine_id: (await targetPc()).pc, rotate_agent_keys: false })).status).toBe(400);
    expect((await api('POST', `/checkouts/${id}/render`, { target: 'same_user', machine_id: s.pc })).status).toBe(400);
    expect((await api('POST', `/checkouts/${id}/render`, { target: 'other_pc', machine_id: s.pc })).status).toBe(400); // that is the source
    expect((await api('POST', `/checkouts/${id}/render`, { target: 'moon' })).status).toBe(400);
    expect((await api('POST', `/checkouts/${id}/render`, { target: 'same_user', agents: { [w]: { permissions: 'bypassPermissions' } } })).status).toBe(400);
    expect((await api('POST', `/checkouts/${id}/render`, { target: 'same_user', agents: { agt_nobody: {} } })).status).toBe(400);
    expect((await api('POST', `/checkouts/${id}/render`, { target: 'same_user', agents: { [w]: { provider: 'gemini' } } })).status).toBe(400);
    // Codex is offered on every hub since the second Codex move trial passed (docs/checkout.md §9 F4).
    const cx = await api('POST', `/checkouts/${id}/render`, { target: 'same_user', agents: { [w]: { provider: 'codex', model: 'gpt-5-codex', permissions: 'plan' } } });
    expect(cx.status, JSON.stringify(cx.body)).toBe(200);
    expect(cx.body.checkout.choices.agents[w]).toEqual({ provider: 'codex', model: 'gpt-5-codex', permissions: 'plan' });
    const opts = (await api('GET', `/checkouts/${id}`)).body.options;
    expect(opts.providers).toEqual(['claude_code', 'codex']);
    expect(opts).not.toHaveProperty('codex_trial');
    const ok = await api('POST', `/checkouts/${id}/render`, { target: 'same_user', agents: { [w]: { model: 'sonnet', permissions: 'plan' } } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.checkout.choices.agents[w]).toEqual({ provider: 'claude_code', model: 'sonnet', permissions: 'plan' });
    expect(ok.body.checkout.choices.agents[s.agents[0]!.id]).toEqual({ provider: 'claude_code', model: 'opus', permissions: 'acceptEdits' });
  });
  it('an agent that ran on Codex keeps Codex and its model by default, and the render is not audited as a trial', async () => {
    const s = await onboarded();
    const id = await ready(s.teamId, { codexAt: 1 });
    const v = await api('GET', `/checkouts/${id}`);
    expect(v.body.options.agents[s.agents[1]!.id]).toEqual({ provider: 'codex', model: 'gpt-5-codex', permissions: 'default' });
    const r = await api('POST', `/checkouts/${id}/render`, { target: 'same_user' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.checkout.choices.agents[s.agents[1]!.id]).toEqual({ provider: 'codex', model: 'gpt-5-codex', permissions: 'default' });
    expect(auditOf('checkout.codex_trial')).toHaveLength(0);
  });
  it('the Codex move trial switch is gone: the console is not told, and a production hub ignores CODEX_MOVE_TRIAL', async () => {
    expect((await api('GET', '/me')).body).not.toHaveProperty('codex_trial');
    const dir = mkdtempSync(join(tmpdir(), 'ahcxg-'));
    expect(() => loadConfig({ NODE_ENV: 'production', CODEX_MOVE_TRIAL: '1', VAULT_DIR: dir })).not.toThrow(/CODEX_MOVE_TRIAL/);
    expect(loadConfig({ CODEX_MOVE_TRIAL: '1', VAULT_DIR: dir })).not.toHaveProperty('codexMoveTrial');
    expect(readFileSync(join(process.cwd(), 'public', 'index.html'), 'utf8')).not.toContain('trialBar');
  });
  it('render needs a ready checkout', async () => {
    const s = await onboarded();
    const st = await api('POST', `/teams/${s.teamId}/checkout`);
    const r = await api('POST', `/checkouts/${st.body.checkout.id}/render`, { target: 'same_user' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('invalid_state');
  });
});

describe('same_user', () => {
  it('rotate: a checkout request on the source PC, successors at pickup, old sessions suspended at confirm, old keys revoked at restored', async () => {
    const s = await onboarded();
    const id = await ready(s.teamId, { unreviewed: true });
    const via = appCred(s.key);
    const oldTok = app.keys.login(via, s.agents[1]!.secret).token;
    const r = await api('POST', `/checkouts/${id}/render`, { target: 'same_user' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.checkout.status).toBe('rendered');
    expect(r.body.checkout.target_machine_id).toBe(s.pc);
    expect(r.body.push_list).toEqual([]); // F8: no move for the same user
    expect(codeIn(r.body.prompt.text)).toBeNull(); // the source user's key picks up: no code
    expect(r.body.prompt.text).not.toMatch(/ah_(ses|app)_|Next: the parser/); // placeholders only, notes never
    expect(r.body.prompt.text).toContain(`\${${s.agents[0]!.var}}`);
    expect(app.keys.credentials({ agentId: s.agents[0]!.id })).toHaveLength(1); // no key at render
    const req = app.onboarding.request(r.body.checkout.request_id)!;
    expect(req).toMatchObject({ kind: 'checkout', state: 'approved', machine_id: s.pc, app_credential_id: s.keyId });
    const slots = app.onboarding.slots(req.id);
    expect(slots.every((x) => x.bound === 1)).toBe(true);
    // Same OS user: the same folders and session variables, so keys.env is updated in place.
    expect(slots.map((x) => x.session_var).sort()).toEqual(s.agents.map((a) => a.var).sort());
    expect(slots.map((x) => x.folder).sort()).toEqual(['core-0', 'core-1']);
    // The generic onboarding decisions refuse a checkout request.
    expect((await api('POST', `/onboarding/${req.id}/cancel`, {})).status).toBe(409);
    expect((await api('POST', `/onboarding/${req.id}/reissue-pickup`)).status).toBe(409);
    expect((await ob('GET', `/requests/${req.id}`, { key: s.key })).body.checkout_id).toBe(id);

    const oldKeys = s.agents.map((a) => credOf(a.secret).id);
    const p = await ob('POST', '/pickup', { key: s.key, body: { request_id: req.id } });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    for (const [i, a] of s.agents.entries()) {
      const n = app.keys.credential(credOf(p.body.agents.find((x: { agent_id: string }) => x.agent_id === a.id).secret).id)!;
      expect(n).toMatchObject({ replaces_credential_id: oldKeys[i], bound_machine_id: s.pc, status: 'active' });
      expect(app.keys.credential(oldKeys[i]!)).toMatchObject({ status: 'active', succession: 'superseded_pending' });
      expect(memberKey(s.teamId, a.id)).toBe(n.id);
    }
    expect(app.keys.resolveToken(via, oldTok).agent.id).toBe(s.agents[1]!.id); // the old session runs until confirm
    // A retry before confirm revokes only this checkout's unconfirmed rows and gives membership back first.
    const firstNew = credOf(p.body.agents[0].secret).id;
    const p2 = await ob('POST', '/pickup', { key: s.key, body: { request_id: req.id } });
    expect(p2.status).toBe(200);
    expect(app.keys.credential(firstNew)!.status).toBe('revoked');
    expect(app.keys.credential(oldKeys[0]!)!.status).toBe('active');
    const c = await ob('POST', '/pickup/confirm', { key: s.key, body: { pickup_id: p2.body.pickup_id, written: p2.body.agents.map((x: { session_var: string }) => x.session_var) } });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(app.checkouts.checkout(id)!.status).toBe('restoring');
    expect(err(() => app.keys.resolveToken(via, oldTok))).toBe('key_inactive');
    expect(err(() => app.keys.login(via, s.agents[1]!.secret))).toBe('suspended');
    const newSecret = (aid: string) => p2.body.agents.find((x: { agent_id: string }) => x.agent_id === aid).secret as string;
    expect(app.keys.login(via, newSecret(s.agents[1]!.id)).credential.id).toBe(memberKey(s.teamId, s.agents[1]!.id));
    // Team rules moved with membership: the new key has them, the old has none; no permissions notice.
    const teamRules = (cred: string) => app.keys.rules(app.keys.credential(cred)!.policy_id).filter((x) => x.team_id === s.teamId).length;
    expect(teamRules(memberKey(s.teamId, s.agents[1]!.id))).toBeGreaterThan(0);
    expect(teamRules(oldKeys[1]!)).toBe(0);
    expect(app.db.prepare("SELECT COUNT(*) n FROM agent_notices WHERE agent_id=? AND kind IN ('permissions_changed','team_joined','key_rotated') AND created_at>=?").get(s.agents[1]!.id, app.checkouts.checkout(id)!.rendered_at!)).toEqual({ n: 0 });
    const hs = app.checkouts.handouts(id);
    expect(hs.every((h) => h.new_credential_id === memberKey(s.teamId, h.agent_id))).toBe(true);
    // The moved key names the team's checkout in words, never the checkout id (operator walk-through finding 4).
    const moved = app.keys.credential(memberKey(s.teamId, s.agents[1]!.id))!.label;
    expect(moved).toContain(`(moved by the ${app.teams.team(s.teamId)!.name} checkout)`);
    expect(moved).not.toContain(id);
    for (const h of hs) app.checkouts.consume(h.id, h.new_credential_id, sys);
    expect(app.checkouts.checkout(id)!.status).toBe('restored');
    for (const k of oldKeys) expect(app.keys.credential(k)).toMatchObject({ status: 'revoked', status_reason: 'superseded' });
    expect(app.onboarding.slots(s.requestId).every((x) => x.status === 'closed')).toBe(true); // the moved agents left their old slots
    expect(app.keys.credential(s.keyId)!.status).toBe('active'); // same user: the PC key stays
    expect(app.teams.team(s.teamId)!.status).toBe('running');
    expect(auditOf('checkout.keys_settled', id)).toHaveLength(1);
    expect(auditOf('checkout.pickup')).not.toHaveLength(0);
  });
  it('reuse: no request and no key; the old logins end at render and the keys stay', async () => {
    const s = await onboarded();
    const id = await ready(s.teamId);
    const via = appCred(s.key);
    const tok = app.keys.login(via, s.agents[0]!.secret).token;
    const r = await api('POST', `/checkouts/${id}/render`, { target: 'same_user', rotate_agent_keys: false });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.checkout.request_id).toBeNull();
    expect(r.body.checkout.choices.rotate_agent_keys).toBe(false);
    expect(r.body.prompt.text).toContain('Keys are reused');
    expect(err(() => app.keys.resolveToken(via, tok))).toBe('login_required');
    expect(app.keys.login(via, s.agents[0]!.secret).token).toMatch(/^ah_tok_/); // a later login is the one resume accepts
    expect(app.keys.credentials({ agentId: s.agents[0]!.id })).toHaveLength(1);
  });
});

describe('another OS user on the same PC', () => {
  it('gets no code and no key: the answer says that user pairs the connector first, and nothing is created', async () => {
    const s = await onboarded();
    const id = await ready(s.teamId);
    const keys = app.db.prepare('SELECT COUNT(*) n FROM credentials').get() as { n: number }, codes = app.db.prepare('SELECT COUNT(*) n FROM enrolment_codes').get() as { n: number };
    const r = await api('POST', `/checkouts/${id}/render`, { target: 'same_pc_other_user' });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: 'invalid_state', reason: 'other_user_pairs_first', message: expect.stringMatching(/That user installs the connector and pairs it.*approve a destination/) });
    expect(JSON.stringify(r.body)).not.toMatch(/cnc-pair-/);
    expect(app.db.prepare('SELECT COUNT(*) n FROM credentials').get()).toEqual(keys);
    expect(app.db.prepare('SELECT COUNT(*) n FROM enrolment_codes').get()).toEqual(codes);
    expect(app.checkouts.checkout(id)!.status).toBe('ready');
  });
});

describe('other_pc', () => {
  it('an enrolled PC: approved at render, picked up with that PC\'s key, keys bound there', async () => {
    const s = await onboarded();
    const t = await api('POST', '/pcs/add', { name: `target-pc-${seq}` });
    const tk = (await enrol(t.body.code)).key;
    const id = await ready(s.teamId);
    const r = await api('POST', `/checkouts/${id}/render`, { target: 'other_pc', machine_id: t.body.pc.id });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(codeIn(r.body.prompt.text)).toBeNull(); // the target user already holds the PC key
    expect(r.body.push_list[0].branches[0].branch).toBe('integration/core');
    const req = app.onboarding.request(r.body.checkout.request_id)!;
    expect(req).toMatchObject({ state: 'approved', machine_id: t.body.pc.id, app_credential_id: t.body.key.id });
    expect((await ob('POST', '/pickup', { key: s.key, body: { request_id: req.id } })).status).toBe(404);
    const got = await collect(tk, req.id);
    const nk = got[0]!.secret;
    expect(app.keys.credential(credOf(nk).id)!.bound_machine_id).toBe(t.body.pc.id);
    expect(err(() => app.keys.login(appCred(s.key), nk))).toBe('bound_elsewhere'); // the source PC cannot use it
    expect(app.keys.login(appCred(tk), nk).token).toMatch(/^ah_tok_/);
    const d = await api('GET', `/checkouts/${id}`);
    expect(d.body.target).toMatchObject({ target: 'other_pc', request: { state: 'collected' } });
  });
  it('Re-enrol of the connector PC the team moved away from hands over only the keys still there; the moved keys stay active on the target', async () => {
    const s = await onboarded();
    const stay = await onboardTeam(s.key); // a second team on the same PC that does not move
    const t = await targetPc();
    const id = await ready(s.teamId);
    const r = await api('POST', `/checkouts/${id}/render`, { target: 'other_pc', machine_id: t.pc });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const moved = await collect(t.key, r.body.checkout.request_id);
    // Every moved agent resumes on the target, so the checkout is restored and closed (the gate is not what this is about).
    const gate = app.teams.checkoutGate;
    app.teams.checkoutGate = () => app.teams.mustTeam(s.teamId);
    try {
      for (const a of moved) {
        app.keys.login(appCred(t.key), a.secret);
        const credId = credOf(a.secret).id;
        const tok = app.db.prepare('SELECT token_hash FROM session_tokens WHERE session_credential_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(credId) as { token_hash: string };
        app.checkouts.resume({ agentId: a.agent_id, credId, tokenHash: tok.token_hash, rules: [], cap: [] });
      }
    } finally { app.teams.checkoutGate = gate; }
    expect(app.checkouts.checkout(id)!.status).toBe('restored');
    // The source PC runs the connector, then its user re-enrols it.
    const ci = await fetch(`${base}/connector/v1/check-in`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${s.key}` }, body: JSON.stringify({ version: '0.9.6' }) });
    expect(ci.status).toBe(200);
    const re = await api('POST', `/pcs/${s.pc}/re-enrol`, {});
    expect(re.status, JSON.stringify(re.body)).toBe(200);
    expect(re.body.handover).toBeTruthy();
    // The handover carries the staying team's agents only.
    const slots = (app.db.prepare('SELECT agent_id FROM onboarding_slots WHERE request_id=?').all(re.body.handover) as { agent_id: string }[]).map((x) => x.agent_id).sort();
    expect(slots).toEqual(stay.agents.map((a) => a.id).sort());
    expect(JSON.parse(auditOf('pc.re_enrol', s.pc).at(-1)!.details)).toMatchObject({ agents_handed_over: stay.agents.length, handover: re.body.handover });
    // The moved keys are neither handed over nor revoked: they still log in on the target.
    for (const a of moved) {
      expect(app.keys.credential(credOf(a.secret).id)).toMatchObject({ status: 'active', bound_machine_id: t.pc });
      expect(app.keys.login(appCred(t.key), a.secret).token).toMatch(/^ah_tok_/);
    }
    // The staying keys work until the PC confirms the handover.
    for (const a of stay.agents) expect(app.keys.credential(credOf(a.secret).id)!.status).toBe('active');
  });
  it('a new PC is not rendered for: no PC, key or code is created, and the answer says to add the PC with the connector first', async () => {
    const s = await onboarded();
    const id = await ready(s.teamId);
    const name = `fresh-pc-${seq}`;
    const machines = app.keys.machines().length, keys = app.db.prepare('SELECT COUNT(*) n FROM credentials').get() as { n: number }, codes = app.db.prepare('SELECT COUNT(*) n FROM enrolment_codes').get() as { n: number };
    const r = await api('POST', `/checkouts/${id}/render`, { target: 'other_pc', new_pc_name: name });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: 'invalid_state', reason: 'add_pc_first', message: expect.stringMatching(/Add this PC with the connector first.*approve a destination/) });
    expect(JSON.stringify(r.body)).not.toMatch(/cnc-pair-/);
    expect(app.keys.machines().length).toBe(machines);
    expect(app.db.prepare('SELECT COUNT(*) n FROM credentials').get()).toEqual(keys);
    expect(app.db.prepare('SELECT COUNT(*) n FROM enrolment_codes').get()).toEqual(codes);
    expect(app.checkouts.checkout(id)!.status).toBe('ready'); // nothing rendered
    // Neither name nor id: also refused, with the plain reason.
    expect((await api('POST', `/checkouts/${id}/render`, { target: 'other_pc' })).status).toBe(400);
  });
});

describe('a new render, cancel and expiry', () => {
  it('a new render cancels the previous request and what was issued under it', async () => {
    const s = await onboarded();
    const id = await ready(s.teamId);
    const tp = await targetPc();
    const r1 = await api('POST', `/checkouts/${id}/render`, { target: 'other_pc', machine_id: tp.pc });
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    const r2 = await api('POST', `/checkouts/${id}/render`, { target: 'same_user' });
    expect(r2.status, JSON.stringify(r2.body)).toBe(200);
    expect(app.onboarding.request(r1.body.checkout.request_id)!.state).toBe('cancelled');
    expect((await ob('POST', '/pickup', { key: tp.key, body: { request_id: r1.body.checkout.request_id } })).status).toBe(409);
    expect(auditOf('checkout.render_superseded', id)).toHaveLength(1);
    // Issued successors of a superseded render are revoked and membership goes back.
    const old = memberKey(s.teamId, s.agents[0]!.id);
    const p = await ob('POST', '/pickup', { key: s.key, body: { request_id: r2.body.checkout.request_id } });
    expect(p.status).toBe(200);
    const issued = credOf(p.body.agents[0].secret).id;
    expect(memberKey(s.teamId, p.body.agents[0].agent_id)).toBe(issued);
    const r3 = await api('POST', `/checkouts/${id}/render`, { target: 'same_user' });
    expect(r3.status).toBe(200);
    expect(app.keys.credential(issued)!.status).toBe('revoked');
    expect(memberKey(s.teamId, s.agents[0]!.id)).toBe(old);
    expect(app.keys.credential(old)!.succession).toBeNull();
    // The earlier pickup is gone; the new request picks up fresh.
    expect((await ob('POST', '/pickup/confirm', { key: s.key, body: { pickup_id: p.body.pickup_id, written: [] } })).status).toBe(409);
    expect((await ob('POST', '/pickup', { key: s.key, body: { request_id: r3.body.checkout.request_id } })).status).toBe(200);
  });
  it('cancel while restoring: an agent that resumed stays moved; the others get their old sessions back', async () => {
    const s = await onboarded();
    const id = await ready(s.teamId);
    const via = appCred(s.key);
    const [lead, dev] = s.agents as [typeof s.agents[0], typeof s.agents[0]];
    const devTok = app.keys.login(via, dev.secret).token;
    const oldLead = credOf(lead.secret).id, oldDev = credOf(dev.secret).id;
    const r = await api('POST', `/checkouts/${id}/render`, { target: 'same_user' });
    await collect(s.key, r.body.checkout.request_id);
    expect(err(() => app.keys.resolveToken(via, devTok))).toBe('key_inactive');
    const hLead = app.checkouts.handouts(id).find((h) => h.agent_id === lead.id)!;
    const newLead = hLead.new_credential_id!, newDev = memberKey(s.teamId, dev.id);
    app.checkouts.consume(hLead.id, newLead, sys);
    const c = await api('POST', `/checkouts/${id}/cancel`, { note: 'target broke', force: true });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body.checkout.status).toBe('cancelled');
    expect(app.keys.credential(newLead)!.status).toBe('active');
    expect(app.keys.credential(oldLead)!.status).toBe('revoked');
    expect(memberKey(s.teamId, lead.id)).toBe(newLead);
    expect(app.keys.credential(newDev)!.status).toBe('revoked');
    expect(memberKey(s.teamId, dev.id)).toBe(oldDev);
    expect(app.keys.resolveToken(via, devTok).agent.id).toBe(dev.id); // reinstated
    expect(app.keys.credential(oldDev)!.succession).toBeNull();
    expect(app.db.prepare("SELECT COUNT(*) n FROM agent_notices WHERE agent_id=? AND kind='permissions_changed' AND created_at>=?").get(dev.id, app.checkouts.checkout(id)!.rendered_at!)).toEqual({ n: 0 });
    expect(app.teams.team(s.teamId)!.status).toBe('running');
  });
  it('expiry of a rendered checkout revokes the unconfirmed successors and gives membership back', async () => {
    const s = await onboarded();
    const id = await ready(s.teamId);
    const old = memberKey(s.teamId, s.agents[1]!.id);
    const r = await api('POST', `/checkouts/${id}/render`, { target: 'same_user' });
    const p = await ob('POST', '/pickup', { key: s.key, body: { request_id: r.body.checkout.request_id } });
    const issued = credOf(p.body.agents.find((x: { agent_id: string }) => x.agent_id === s.agents[1]!.id).secret).id;
    expect(app.checkouts.sweep(Date.now() + EXPIRY_MS + 1000).expired).toContain(id);
    expect(app.keys.credential(issued)!.status).toBe('revoked');
    expect(memberKey(s.teamId, s.agents[1]!.id)).toBe(old);
    expect(app.onboarding.request(r.body.checkout.request_id)!.state).toBe('cancelled');
    expect((await ob('POST', '/pickup', { key: s.key, body: { request_id: r.body.checkout.request_id } })).status).toBe(409);
    expect(app.teams.team(s.teamId)!.status).toBe('running');
    expect(auditOf('checkout.keys_undone', id)).toHaveLength(1);
  });
  it('pickup is refused once the handouts no longer match the render', async () => {
    const s = await onboarded();
    const id = await ready(s.teamId);
    const r = await api('POST', `/checkouts/${id}/render`, { target: 'same_user' });
    app.db.prepare("UPDATE handouts SET body=json_set(body,'$.folder','evil') WHERE checkout_id=? AND agent_id=?").run(id, s.agents[0]!.id);
    const p = await ob('POST', '/pickup', { key: s.key, body: { request_id: r.body.checkout.request_id } });
    expect(p.status).toBe(409);
    expect(p.body.error).toBe('handout_changed');
    expect(app.keys.credentials({ agentId: s.agents[0]!.id })).toHaveLength(1);
  });
});

describe('push list refs', () => {
  it('accepts ref names and refuses option-looking or malformed ones', () => {
    for (const ok of ['integration/core', 'main', 'checkout/cko_abc', 'release-1.2']) expect(validRef(ok)).toBe(true);
    for (const bad of ['-f', '--upload-pack=x', 'a..b', 'a//b', 'a/', '.hidden', 'x.lock', 'a b', 'a;rm', '']) expect(validRef(bad)).toBe(false);
  });
  it('checkout_progress refuses a malformed or option-looking ref before it can reach a handout', async () => {
    const s = await onboarded();
    const st = await api('POST', `/teams/${s.teamId}/checkout`);
    const a = app.checkouts.handouts(st.body.checkout.id)[0]!.agent_id;
    app.checkouts.checkpointing(a);
    const none = { worktrees: [], unmerged_branches: [], uncommitted_files: [], build_output: [], scratch: [], processes: [] };
    for (const bad of ['--upload-pack=x', 'a..b', '-f']) {
      let c: unknown = null;
      try { app.checkouts.merged(a, { integration_branch: bad, integration_head: head('a'), merge_commits: [], worktrees_left: 0, clean: true, leftover_check: none }); } catch (e) { c = (e as { code?: string }).code; }
      expect(c, bad).toBe('invalid_argument');
    }
    await api('POST', `/checkouts/${st.body.checkout.id}/cancel`, {});
  });
  it('a handout with a malformed ref fails the render for another user or PC', async () => {
    const s = await onboarded();
    const id = await ready(s.teamId);
    // checkout_progress refuses such a ref; this one is planted in the stored handout, as if written before the checks.
    app.db.prepare("UPDATE handouts SET body=json_set(body,'$.checkpoint.integration_branch','--upload-pack=x') WHERE checkout_id=?").run(id);
    const r = await api('POST', `/checkouts/${id}/render`, { target: 'other_pc', machine_id: (await targetPc()).pc });
    expect(r.status).toBe(400);
    expect(app.checkouts.checkout(id)!.status).toBe('ready');
  });
});

describe('review fixes', () => {
  const hashOf = (tok: string) => createHash('sha256').update(tok).digest('hex');
  const tokRow = (tok: string) => app.db.prepare('SELECT expires_at, suspended_at FROM session_tokens WHERE token_hash=?').get(hashOf(tok)) as { expires_at: number; suspended_at: number | null };

  it('cancel does not bring an expired token back, and a live one gets back only the idle time it had left', async () => {
    const s = await onboarded();
    const id = await ready(s.teamId);
    const via = appCred(s.key);
    const [lead, dev] = s.agents as [typeof s.agents[0], typeof s.agents[0]];
    const dead = app.keys.login(via, dev.secret).token, live = app.keys.login(via, lead.secret).token;
    app.db.prepare('UPDATE session_tokens SET expires_at=? WHERE token_hash=?').run(Date.now() - 1000, hashOf(dead));
    const r = await api('POST', `/checkouts/${id}/render`, { target: 'same_user' });
    await collect(s.key, r.body.checkout.request_id);
    expect(tokRow(dead).suspended_at).toBeNull(); // expired: never suspended
    const e0 = tokRow(live).expires_at;
    expect(tokRow(live).suspended_at).not.toBeNull();
    // Ten minutes spent suspended: the expiry moves on by that, not to a fresh hour.
    app.db.prepare('UPDATE session_tokens SET suspended_at=suspended_at-600000 WHERE token_hash=?').run(hashOf(live));
    const c = await api('POST', `/checkouts/${id}/cancel`, { note: 'test', force: true });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(err(() => app.keys.resolveToken(via, dead))).toBe('login_required');
    const moved = tokRow(live).expires_at - e0;
    expect(moved).toBeGreaterThanOrEqual(600000);
    expect(moved).toBeLessThan(600000 + 60000);
    expect(app.keys.resolveToken(via, live).agent.id).toBe(lead.id);
  });

  it('revoking or suspending the old key after pickup takes its successor down, and confirm is refused', async () => {
    const s = await onboarded();
    const id = await ready(s.teamId);
    const r = await api('POST', `/checkouts/${id}/render`, { target: 'same_user' });
    const reqId = r.body.checkout.request_id;
    const p = await ob('POST', '/pickup', { key: s.key, body: { request_id: reqId } });
    expect(p.status).toBe(200);
    const [lead, dev] = s.agents as [typeof s.agents[0], typeof s.agents[0]];
    const succ = (aid: string) => credOf(p.body.agents.find((x: { agent_id: string }) => x.agent_id === aid).secret).id;
    expect((await api('POST', `/keys/${credOf(dev.secret).id}/revoke`)).status).toBe(200);
    expect(app.keys.credential(succ(dev.id))).toMatchObject({ status: 'revoked', status_reason: 'admin' });
    app.keys.setStatus(credOf(lead.secret).id, 'suspended', 'leak_guard', sys); // the leak guard's path
    expect(app.keys.credential(succ(lead.id))).toMatchObject({ status: 'suspended', status_reason: 'leak_guard' });
    const c = await ob('POST', '/pickup/confirm', { key: s.key, body: { pickup_id: p.body.pickup_id, written: p.body.agents.map((x: { session_var: string }) => x.session_var) } });
    expect(c.status).toBe(409);
    expect(app.checkouts.checkout(id)!.status).toBe('rendered'); // rolled back: nothing moved
    expect(app.onboarding.request(reqId)!.state).toBe('approved');
  });

  it('keeps secrets and codes out of the audit log, the stored choices and the checkout views', async () => {
    const s = await onboarded();
    const id = await ready(s.teamId);
    const tp = await targetPc();
    const r = await api('POST', `/checkouts/${id}/render`, { target: 'other_pc', machine_id: tp.pc });
    expect(r.status).toBe(200);
    expect(codeIn(r.body.prompt.text)).toBeNull();
    const got = await collect(tp.key, r.body.checkout.request_id);
    const secrets = [tp.key, ...got.map((a) => a.secret)];
    const audit = (app.db.prepare('SELECT details FROM audit_events').all() as { details: string | null }[]).map((x) => x.details ?? '').join('\n');
    const choices = app.checkouts.checkout(id)!.choices ?? '';
    const view = JSON.stringify((await api('GET', `/checkouts/${id}`)).body);
    for (const text of [audit, choices, view]) {
      for (const x of secrets) expect(text).not.toContain(x);
      expect(text).not.toMatch(/cnc-pair-[a-z2-7]{26}|ah_(ses|app)_[a-z2-7]{12}_/);
    }
    expect(auditOf('checkout.render_choices', id)).toHaveLength(1);
    expect(JSON.parse(auditOf('checkout.rendered', id)[0]!.details).handout_hashes).toBeTruthy();
  });

  it('render without the CSRF header is refused', async () => {
    const s = await onboarded();
    const id = await ready(s.teamId);
    const res = await fetch(`${base}/api/checkouts/${id}/render`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ target: 'same_user' }) });
    expect(res.status).toBe(403);
    expect(app.checkouts.checkout(id)!.status).toBe('ready');
  });

  it('slots are named by role as onboarding names them', async () => {
    const s = await onboarded();
    const id = await ready(s.teamId);
    const r = await api('POST', `/checkouts/${id}/render`, { target: 'same_user' });
    expect(app.onboarding.slots(r.body.checkout.request_id).map((x) => x.slot).sort()).toEqual(['dev', 'lead']);
  });

  it('a handout whose body went away since render counts as changed', async () => {
    const s = await onboarded();
    const id = await ready(s.teamId);
    const r = await api('POST', `/checkouts/${id}/render`, { target: 'same_user' });
    app.db.prepare('UPDATE handouts SET body=NULL WHERE checkout_id=? AND agent_id=?').run(id, s.agents[0]!.id);
    const p = await ob('POST', '/pickup', { key: s.key, body: { request_id: r.body.checkout.request_id } });
    expect(p.status).toBe(409);
    expect(p.body.error).toBe('handout_changed');
  });
});

describe('onboarding and checkout review fixes', () => {
  const TEMPLATE = () => join(clientDir, 'restore-prompt.md');
  it('render refuses while the hub has no restore-prompt.md, and nothing is created', async () => {
    const s = await onboarded();
    const id = await ready(s.teamId);
    const text = readFileSync(TEMPLATE(), 'utf8');
    unlinkSync(TEMPLATE());
    try {
      const r = await api('POST', `/checkouts/${id}/render`, { target: 'same_user' });
      expect(r.status).toBe(409);
      expect(r.body.error).toBe('restore_unavailable');
      expect(app.checkouts.checkout(id)!.status).toBe('ready');
      expect(app.onboarding.request(app.checkouts.checkout(id)!.request_id ?? 'none')).toBeNull();
    } finally { writeFileSync(TEMPLATE(), text); }
  });
  it('Re-enrol of the source PC after a move leaves the moved agents\' keys and the old request alone', async () => {
    const s = await onboarded();
    const t = await api('POST', '/pcs/add', { name: `target-pc-${seq}` });
    const tk = (await enrol(t.body.code)).key;
    const id = await ready(s.teamId);
    const r = await api('POST', `/checkouts/${id}/render`, { target: 'other_pc', machine_id: t.body.pc.id });
    await collect(tk, r.body.checkout.request_id);
    for (const h of app.checkouts.handouts(id)) app.checkouts.consume(h.id, h.new_credential_id, sys);
    expect(app.checkouts.checkout(id)!.status).toBe('restored');
    const moved = s.agents.map((a) => memberKey(s.teamId, a.id));
    const re = await api('POST', `/pcs/${s.pc}/re-enrol`);
    expect(re.status, JSON.stringify(re.body)).toBe(200);
    expect(re.body.reopened).toEqual([]);
    for (const k of moved) expect(app.keys.credential(k)!.status).toBe('active');
    expect(app.onboarding.request(s.requestId)).toMatchObject({ state: 'collected', app_credential_id: s.keyId });
    // The team's source PC is still the target PC.
    expect(app.checkouts.start(s.teamId, sys).source_machine_id).toBe(t.body.pc.id);
  });
  it('a PC key cannot withdraw or amend the request of a checkout', async () => {
    const s = await onboarded();
    const id = await ready(s.teamId);
    const tp = await targetPc();
    const r = await api('POST', `/checkouts/${id}/render`, { target: 'other_pc', machine_id: tp.pc });
    const e = { key: tp.key };
    const rid = r.body.checkout.request_id as string;
    const state0 = app.onboarding.request(rid)!.state;
    const w = await ob('POST', `/requests/${rid}/withdraw`, { key: e.key });
    expect(w.status).toBe(409);
    expect(w.body.message).toMatch(/belongs to a checkout/);
    const a = await ob('PUT', `/requests/${rid}`, { key: e.key, body: { version: 1, kind: 'new_team' } });
    expect(a.status).toBe(409);
    expect(app.onboarding.request(rid)!.state).toBe(state0);
  });
  it('render refuses when the PC key already has a pending request', async () => {
    const s = await onboarded();
    const f = await ob('POST', '/requests', { key: s.key, body: { kind: 'new_team', project: { name: `Other ${seq}`, existing: false }, team: { name: `Other team ${seq}`, goal: 'g' },
      roles: [{ name: 'lead', team_role: 'coordinator', count: 1, job: 'Plans.' }], prompt: 'p' } });
    expect(f.status, JSON.stringify(f.body)).toBe(200);
    const id = await ready(s.teamId);
    const r = await api('POST', `/checkouts/${id}/render`, { target: 'same_user' });
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/pending request/);
    expect(app.checkouts.checkout(id)!.status).toBe('ready');
  });
  it('the enrol error tells a revoked and an expired code from an unknown one, and an issued code is handed out three times at most', async () => {
    const msg = async (code: string) => (await ob('POST', '/enrol', { body: { code, nonce: nonce() }, from: freshIp() })).body.message as string;
    const add = await api('POST', '/pcs/add', { name: `err-pc-${++seq}` });
    expect(await msg('cnc-pair-' + 'a'.repeat(26))).toMatch(/not valid/);
    const rev = await api('POST', '/pcs/add', { name: `err-pc-${++seq}` });
    await api('DELETE', `/pcs/${rev.body.pc.id}/enrolment`);
    expect(await msg(rev.body.code)).toMatch(/revoked/);
    const old = await api('POST', '/pcs/add', { name: `err-pc-${++seq}` });
    app.db.prepare('UPDATE enrolment_codes SET expires_at=? WHERE app_credential_id=?').run(Date.now() - 1, old.body.key.id);
    expect(await msg(old.body.code)).toMatch(/expired/);
    // Same nonce, never confirmed: three issues, then a refusal.
    const n = nonce(), from = freshIp();
    for (let i = 0; i < 3; i++) expect((await ob('POST', '/enrol', { body: { code: add.body.code, nonce: n }, from })).status).toBe(200);
    const fourth = await ob('POST', '/enrol', { body: { code: add.body.code, nonce: n }, from });
    expect(fourth.status).toBe(409);
    expect(fourth.body.message).toMatch(/re-enrol/);
  });
  it('a PC added without a key (POST /api/pcs) is refused as a target with a way forward', async () => {
    const s = await onboarded();
    const bare = await api('POST', '/pcs', { name: `bare-pc-${seq}` });
    const id = await ready(s.teamId);
    const r = await api('POST', `/checkouts/${id}/render`, { target: 'other_pc', machine_id: bare.body.pc.id });
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/Re-enrol it first/);
    const opts = (await api('GET', `/checkouts/${id}`)).body.options.targets.other_pc.machines as { id: string; has_key: boolean }[];
    expect(opts.find((m) => m.id === bare.body.pc.id)!.has_key).toBe(false);
  });
});

describe('the restore config scan (§6 step 4)', () => {
  /** Straight to the onboard routes, so the test helper does not record a clean scan first. */
  const raw = async (key: string, path: string, body: unknown) => {
    const x = await fetch(`${base}/onboard${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
    return { status: x.status, body: (await x.json()) as any };
  };
  it('pickup waits for a scan of every folder; findings keep a folder untrusted until the operator approves; confirm returns trust per folder', async () => {
    const s = await onboarded();
    const id = await ready(s.teamId);
    const r = await api('POST', `/checkouts/${id}/render`, { target: 'same_user' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const reqId = r.body.checkout.request_id as string;
    // The status carries the checkout as the restore reads it: choices, folders and the raw handout with its render hash.
    const st = await ob('GET', `/requests/${reqId}`, { key: s.key });
    expect(st.status).toBe(200);
    const view = st.body.checkout;
    expect(view).toMatchObject({ id, status: 'rendered', target: 'same_user', rotate_agent_keys: true, scans: [] });
    expect(view.agents.map((a: { folder: string }) => a.folder).sort()).toEqual(['core-0', 'core-1']);
    for (const a of view.agents) {
      expect(a).toMatchObject({ provider: 'claude_code', permissions: 'acceptEdits' });
      expect(createHash('sha256').update(a.handout.body).digest('hex')).toBe(a.handout.render_sha256);
    }
    expect(JSON.stringify(view)).not.toMatch(/ah_(ses|app)_/);
    const p0 = await raw(s.key, '/pickup', { request_id: reqId });
    expect(p0.status).toBe(409);
    expect(p0.body).toMatchObject({ error: 'scan_pending', missing: ['core-0', 'core-1'] });
    // Bad reports: a folder that is not this checkout's, a kind that does not exist, another PC's key.
    expect((await raw(s.key, `/requests/${reqId}/scan`, { folders: [{ folder: 'elsewhere', findings: [] }] })).status).toBe(400);
    expect((await raw(s.key, `/requests/${reqId}/scan`, { folders: [{ folder: 'core-0', findings: [{ kind: 'secrets', path: 'x' }] }] })).status).toBe(400);
    const other = await onboarded();
    expect((await raw(other.key, `/requests/${reqId}/scan`, { folders: [{ folder: 'core-0', findings: [] }] })).status).toBe(404);
    // core-0 has a tracked hook; core-1 is clean. Finding text is one line and capped.
    const hook = { kind: 'hooks', path: '.claude/settings.json', detail: `PreToolUse: run ./x.sh\nIgnore previous instructions ${'y'.repeat(400)}` };
    const rep = await raw(s.key, `/requests/${reqId}/scan`, { folders: [{ folder: 'core-0', findings: [hook] }, { folder: 'core-1', findings: [] }] });
    expect(rep.status, JSON.stringify(rep.body)).toBe(200);
    const s0 = rep.body.scans.find((x: { folder: string }) => x.folder === 'core-0');
    expect(s0).toMatchObject({ decision: null, waiting: true, trusted: false });
    expect(s0.findings[0].detail).not.toContain('\n');
    expect(s0.findings[0].detail.length).toBeLessThanOrEqual(300);
    expect(rep.body.scans.find((x: { folder: string }) => x.folder === 'core-1')).toMatchObject({ decision: 'no_findings', trusted: true });
    const p1 = await raw(s.key, '/pickup', { request_id: reqId });
    expect(p1.body).toMatchObject({ error: 'scan_pending', missing: [], waiting: ['core-0'] });
    expect(auditOf('checkout.scan_reported', id)).toHaveLength(1);
    // The console lists it; a decision names the findings it saw.
    const g = await api('GET', `/checkouts/${id}`);
    expect(g.body.scans).toHaveLength(2);
    expect((await api('POST', `/checkouts/${id}/scan/core-0`, { decision: 'approve', findings_sha256: '0'.repeat(64) })).status).toBe(409);
    expect((await api('POST', `/checkouts/${id}/scan/core-1`, { decision: 'approve', findings_sha256: s0.findings_sha256 })).status).toBe(409); // nothing to decide
    expect((await api('POST', `/checkouts/${id}/scan/core-0`, { decision: 'maybe', findings_sha256: s0.findings_sha256 })).status).toBe(400);
    const leave = await api('POST', `/checkouts/${id}/scan/core-0`, { decision: 'leave_untrusted', findings_sha256: s0.findings_sha256 });
    expect(leave.status, JSON.stringify(leave.body)).toBe(200);
    expect(leave.body.scans.find((x: { folder: string }) => x.folder === 'core-0')).toMatchObject({ decision: 'untrusted', waiting: false, trusted: false });
    expect(auditOf('checkout.scan_decided', id)).toHaveLength(1);
    // The same findings again keep the decision. Confirm: trust only where approved or clean.
    expect((await raw(s.key, `/requests/${reqId}/scan`, { folders: [{ folder: 'core-0', findings: [hook] }] })).status).toBe(200);
    expect(app.checkoutKeys.scans(app.checkouts.checkout(id)!).find((x) => x.folder === 'core-0')!.decision).toBe('untrusted');
    const p = await raw(s.key, '/pickup', { request_id: reqId });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    const c = await raw(s.key, '/pickup/confirm', { pickup_id: p.body.pickup_id, written: p.body.agents.map((x: { session_var: string }) => x.session_var) });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body.trust).toEqual({ 'core-0': false, 'core-1': true });
    expect(app.checkouts.checkout(id)!.status).toBe('restoring');
    // After confirm the scan is closed to change.
    expect((await api('POST', `/checkouts/${id}/scan/core-0`, { decision: 'approve', findings_sha256: s0.findings_sha256 })).status).toBe(409);
    // (Called directly: this key has used its hourly pickup budget, which the scan shares.)
    expect(err(() => app.checkoutKeys.reportScan(app.onboarding.request(reqId)!, { folders: [{ folder: 'core-0', findings: [] }] }))).toBe('invalid_state');
  });
  it('different findings reset a decision, and a decision wakes a waiting status call', async () => {
    const s = await onboarded();
    const id = await ready(s.teamId);
    const reqId = (await api('POST', `/checkouts/${id}/render`, { target: 'same_user' })).body.checkout.request_id as string;
    const f1 = { kind: 'mcp_servers', path: '.mcp.json', detail: 'servers: tools' };
    const rep = await raw(s.key, `/requests/${reqId}/scan`, { folders: [{ folder: 'core-0', findings: [f1] }, { folder: 'core-1', findings: [] }] });
    const sha = rep.body.scans.find((x: { folder: string }) => x.folder === 'core-0').findings_sha256 as string;
    const wait = ob('GET', `/requests/${reqId}?wait_s=20`, { key: s.key });
    await new Promise((res) => setTimeout(res, 150));
    const t0 = Date.now();
    expect((await api('POST', `/checkouts/${id}/scan/core-0`, { decision: 'approve', findings_sha256: sha })).status).toBe(200);
    const w = await wait;
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(w.body.checkout.scans.find((x: { folder: string }) => x.folder === 'core-0')).toMatchObject({ decision: 'approved', trusted: true });
    const rep2 = await raw(s.key, `/requests/${reqId}/scan`, { folders: [{ folder: 'core-0', findings: [f1, { kind: 'role_file', path: 'CLAUDE.md', detail: '' }] }] });
    expect(rep2.body.scans.find((x: { folder: string }) => x.folder === 'core-0')).toMatchObject({ decision: null, waiting: true });
  });
});
