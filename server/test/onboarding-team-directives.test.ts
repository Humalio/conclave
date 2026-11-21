/**
 * A new team arrives with its own directives and requirements (docs/directives.md#from-onboarding,
 * docs/onboarding.md#requirements-from-onboarding, docs/directives.md#suggestions-from-agents):
 * 1. a new_team request may carry requirements within the hub's bounds; the console shows them, and the rules, as inert text;
 * 2. approval always creates the two standard directives from the hub template, in the operator's wording;
 * 3. the kept requirements go into the team's Blueprint part as one proposal, never applied by the approval;
 * 4. the CLAUDE.md points to the directives without repeating them, and the check warns when the goal holds rules;
 * 5. a reported rule is a suggestion to the agent's team, ignored when a directive already says it; adopting it merges
 *    the same suggestion from other members.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { buildApp, type App } from '../src/app.js';
import { STANDARD_DIRECTIVES, goalHasRules, standardFor } from '../src/onboarding/teamStart.js';
import { MAX_OPEN_REPORTS } from '../src/directives/directives.js';
import { testConfig, adminLogin } from './hub.js';
// @ts-expect-error: a plain ES module without types
import { validateRequest, goalHasRules as clientGoalHasRules } from '../../deploy/client/setup.mjs';
// @ts-expect-error plain ESM without types
import { resumeMsg } from '../../deploy/client/connector/restore.mjs';
// @ts-expect-error plain ESM client script, no types
import { agentsOverride, resumeMessage, FIRST_CALL } from '../../deploy/client/codex.mjs';

const sys = { kind: 'system' as const, id: 'test' };
let app: App, base = '', cookie = '', csrf = '', dir = '';
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const ob = async (method: string, path: string, o: { key?: string; body?: unknown; from?: string } = {}) => {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-forwarded-proto': 'https', 'x-forwarded-for': o.from ?? '10.9.0.1' };
  if (o.key) headers.authorization = `Bearer ${o.key}`;
  const r = await fetch(`${base}/onboard${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
let ip = 1;
const enrol = async (name: string) => {
  const add = await api('POST', '/pcs/add', { name });
  const n = `n${Math.random().toString(36).slice(2)}`.padEnd(22, 'x'), from = `10.9.1.${ip++}`;
  const e = await ob('POST', '/enrol', { body: { code: add.body.code, nonce: n }, from });
  expect(e.status, JSON.stringify(e.body)).toBe(200);
  expect((await ob('POST', '/enrol/confirm', { body: { nonce: n }, from })).status).toBe(200);
  return e.body.app_key as string;
};
let seq = 0;
const REQS = [
  { kind: 'fr', title: 'Every deadline has an owner', text: 'Each calendar entry names the person who owns the deadline.', acs: ['No entry is done without an owner.', 'The owner shows in the list.'] },
  { kind: 'nfr', title: 'Entries are current within a day', text: 'A change on the funder page shows in the calendar within one working day.', category: 'rel' },
  { kind: 'fr', title: 'Entries link to the funder page', text: 'Each entry links to the funder page it came from.' },
];
const request = (over: Record<string, unknown> = {}) => ({
  kind: 'new_team', project: { name: `Arrive ${++seq}`, existing: false }, team: { name: `Grant team ${seq}`, goal: 'Keep the grant calendar current.' },
  roles: [
    { name: 'coordinator', team_role: 'coordinator', count: 1, job: 'Plans and assigns.' },
    { name: 'writer', team_role: 'worker', count: 1, job: 'Writes entries.' },
    { name: 'reviewer', team_role: 'reviewer', count: 1, job: 'Reviews entries.', reviews: ['writer'] },
  ],
  requirements: REQS, prompt: 'a grant calendar team', ...over,
});
const file = (key: string, body: unknown) => ob('POST', '/requests', { key, body });
const filed = async (pc: string, over: Record<string, unknown> = {}) => {
  const key = await enrol(pc);
  const f = await file(key, request(over));
  expect(f.status, JSON.stringify(f.body)).toBe(200);
  return { key, id: f.body.request_id as string, version: f.body.version as number };
};
const standardOf = (teamId: string) => app.db.prepare("SELECT title, body, scope_kind, scope_ref, source, category, tags, reviewed_at FROM directives WHERE scope_kind='team' AND scope_ref=? AND tags LIKE '%\"standard\"%' ORDER BY created_at, rowid").all(teamId) as { title: string; body: string; scope_kind: string; scope_ref: string; source: string; category: string | null; tags: string; reviewed_at: number | null }[];
const proposalsOf = (teamId: string) => app.db.prepare('SELECT id, agent_id, ops, status, reason FROM bp_proposals WHERE team_id=?').all(teamId) as { id: string; agent_id: string | null; ops: string; status: string; reason: string }[];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ahteamdir-'));
  mkdirSync(join(dir, 'vault'));
  app = await buildApp(testConfig(dir, { publicUrl: 'https://hub.test' }));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base));
});
afterAll(async () => { await app?.close(); });

describe('1. a new_team request may carry requirements', () => {
  it('the hub refuses requirements outside the bounds, with field paths', async () => {
    const key = await enrol('req-bounds-pc');
    const bad = await file(key, request({ requirements: [
      { kind: 'story', title: 't', text: 'x' },
      { kind: 'fr', title: 'two\nlines', text: 't'.repeat(2001), category: 'perf' },
      { kind: 'nfr', title: 't', text: 'x' },
      { kind: 'nfr', title: 't', text: 'x', category: 'speed', acs: Array.from({ length: 11 }, () => 'a') },
      { kind: 'fr', title: 't', text: 'x', acs: ['', 'two\nlines', 'a'.repeat(301)], extra: 1 },
      'not an object',
    ] }));
    expect(bad.status).toBe(400);
    const fields = bad.body.problems.map((x: { field: string }) => x.field);
    expect(fields).toEqual(expect.arrayContaining(['requirements[0].kind', 'requirements[1].title', 'requirements[1].text', 'requirements[1].category',
      'requirements[2].category', 'requirements[3].category', 'requirements[3].acs', 'requirements[4].acs[0]', 'requirements[4].acs[1]', 'requirements[4].acs[2]', 'requirements[4].extra', 'requirements[5]']));
  });
  it('max_requirements bounds the list; 0 turns requirements off', async () => {
    const key = await enrol('req-limit-pc');
    expect((await api('PUT', '/settings/onboarding', { max_requirements: 2 })).status).toBe(200);
    expect((await file(key, request())).body.problems.map((x: { field: string }) => x.field)).toContain('requirements');
    expect((await api('PUT', '/settings/onboarding', { max_requirements: 101 })).status).toBe(400);
    expect((await api('PUT', '/settings/onboarding', { max_requirements: 30 })).status).toBe(200);
    expect((await api('GET', '/settings/onboarding')).body.settings.max_requirements).toBe(30);
  });
  it('only a new team brings requirements: add_agents plans in its own Blueprint part', () => {
    const v = app.onboarding.validate({ ...request(), kind: 'add_agents', team: { id: 'team_x', goal: 'g' }, roles: [{ name: 'writer', team_role: 'worker', count: 1, job: 'Writes.' }] }, null);
    expect(v.problems.map((x) => x.field)).toContain('requirements');
  });
  it('setup.mjs checks the same bounds locally, and its example passes', () => {
    expect(validateRequest(request())).toEqual([]);
    const p = validateRequest(request({ requirements: [{ kind: 'nfr', title: 't', text: 'x' }, { kind: 'fr', title: 't', text: 'x', category: 'sec', z: 1 }] })).map((x: { field: string }) => x.field);
    expect(p).toEqual(expect.arrayContaining(['requirements[0].category', 'requirements[1].category', 'requirements[1].z']));
    expect(validateRequest(request({ requirements: Array.from({ length: 31 }, () => REQS[0]) })).map((x: { field: string }) => x.field)).toContain('requirements');
  });
  it('the approval screen gets the standard directives and the filed requirements', async () => {
    const r = await filed('req-detail-pc');
    const d = (await api('GET', `/onboarding/${r.id}`)).body;
    expect(d.standard_directives.map((x: { key: string }) => x.key)).toEqual(['who_decides', 'operator_only']);
    expect(d.written_by_agent.body.requirements).toHaveLength(3);
  });
});

describe('2. approval always creates the two standard directives', () => {
  it('without edits they come from the hub template, scoped to the team, reviewed and tagged', async () => {
    const r = await filed('std-default-pc', { requirements: undefined });
    const a = await api('POST', `/onboarding/${r.id}/approve`, { version: r.version });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const team = a.body.request.team_id as string;
    const D = standardOf(team);
    expect(D.map((d) => [d.title, d.category, d.source])).toEqual([['Who decides', 'process', 'hub template'], ['What stays with the operator', 'access', 'hub template']]);
    for (const d of D) {
      expect(d).toMatchObject({ scope_kind: 'team', scope_ref: team });
      expect(d.reviewed_at).toBeTypeOf('number');
      expect(JSON.parse(d.tags)).toEqual(['onboarding', 'standard']);
    }
    expect(D[1]!.body).toBe(STANDARD_DIRECTIVES[1]!.text);
    expect(D[1]!.body).toContain('team_ask');
  });
  it('the operator may reword them, never drop one', async () => {
    const r = await filed('std-edit-pc', { requirements: undefined });
    const a = await api('POST', `/onboarding/${r.id}/approve`, { version: r.version, edits: { standard: [{ key: 'who_decides', title: 'Who decides here', text: 'The coordinator decides; ask it first.' }] } });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const D = standardOf(a.body.request.team_id);
    expect(D).toHaveLength(2);
    expect(D.find((d) => d.title === 'Who decides here')).toMatchObject({ body: 'The coordinator decides; ask it first.', source: 'hub template, edited at approval' });
    expect(D.find((d) => d.title === 'What stays with the operator')).toMatchObject({ source: 'hub template' });
  });
  it('an edit is checked like any directive: an unknown key, an empty or two-line title, an empty text', async () => {
    expect(standardFor([{ key: 'nope' }]).problems.map((p) => p.field)).toEqual(['edits.standard[0].key']);
    expect(standardFor([{ key: 'who_decides', title: 'a\nb', text: ' ' }]).problems.map((p) => p.field)).toEqual(['edits.standard[0].title', 'edits.standard[0].text']);
    expect(standardFor([{ key: 'who_decides', drop: true }]).problems.map((p) => p.field)).toEqual(['edits.standard[0].drop']);
    expect(standardFor(undefined).list).toHaveLength(2);
    const r = await filed('std-bad-pc', { requirements: undefined });
    const bad = await api('POST', `/onboarding/${r.id}/approve`, { version: r.version, edits: { standard: [{ key: 'operator_only', title: '' }] } });
    expect(bad.status).toBe(400);
    expect(app.db.prepare("SELECT state FROM onboarding_requests WHERE id=?").get(r.id)).toMatchObject({ state: 'submitted' });
  });
});

describe('3. requirements go in as one Blueprint proposal, never applied', () => {
  it('the kept requirements become one open proposal of draft FRs, NFRs and their ACs, by no agent', async () => {
    const r = await filed('req-prop-pc');
    const a = await api('POST', `/onboarding/${r.id}/approve`, { version: r.version });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const team = a.body.request.team_id as string;
    const P = proposalsOf(team);
    expect(P).toHaveLength(1);
    expect(P[0]).toMatchObject({ agent_id: null, status: 'open' });
    expect(P[0]!.reason).toContain(r.id);
    const ops = JSON.parse(P[0]!.ops) as { op: string; kind: string; key: string; parent_key: string; title: string; status: string; fields?: { category: string } }[];
    const fr = ops.filter((o) => o.kind === 'fr'), nfr = ops.filter((o) => o.kind === 'nfr'), ac = ops.filter((o) => o.kind === 'ac');
    expect(fr.map((o) => o.title)).toEqual(['Every deadline has an owner', 'Entries link to the funder page']);
    expect(fr[0]!.key).toMatch(/^FR-[A-Z]{2,6}-01$/);
    expect(fr[1]!.key).toMatch(/^FR-[A-Z]{2,6}-02$/);
    expect(nfr).toEqual([expect.objectContaining({ key: expect.stringMatching(/^NFR-REL-\d{2}$/), status: 'draft', fields: { category: 'reliability' } })]);
    expect(ac.map((o) => [o.key, o.parent_key, o.status])).toEqual([[`${fr[0]!.key}/AC1`, fr[0]!.key, 'open'], [`${fr[0]!.key}/AC2`, fr[0]!.key, 'open']]);
    expect(new Set([...fr, ...nfr].map((o) => o.parent_key)).size).toBe(1);
    expect([...fr, ...nfr].every((o) => o.status === 'draft')).toBe(true);
    // nothing applied: no item with those keys exists yet
    const keys = ops.map((o) => o.key);
    expect(app.db.prepare(`SELECT COUNT(*) n FROM bp_items WHERE key IN (${keys.map(() => '?').join(',')}) AND deleted_at IS NULL`).get(...keys)).toMatchObject({ n: 0 });
  });
  it('unticking leaves a requirement out; an empty list makes no proposal', async () => {
    const r = await filed('req-pick-pc');
    const kept = [{ ...REQS[1], title: 'Current within a day' }];
    const a = await api('POST', `/onboarding/${r.id}/approve`, { version: r.version, edits: { requirements: kept } });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const ops = JSON.parse(proposalsOf(a.body.request.team_id)[0]!.ops) as { kind: string; title: string }[];
    expect(ops.filter((o) => o.kind !== 'module').map((o) => o.title)).toEqual(['Current within a day']);
    const r2 = await filed('req-none-pc');
    const a2 = await api('POST', `/onboarding/${r2.id}/approve`, { version: r2.version, edits: { requirements: [] } });
    expect(a2.status, JSON.stringify(a2.body)).toBe(200);
    expect(proposalsOf(a2.body.request.team_id)).toHaveLength(0);
  });
  it("FR-PLAN-12: a project's only team files them at project level, in a module the proposal opens", async () => {
    const r = await filed('req-solo-pc');
    const a = await api('POST', `/onboarding/${r.id}/approve`, { version: r.version });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const team = a.body.request.team_id as string;
    // No part: nothing in the Blueprint belongs to the team.
    expect(app.db.prepare('SELECT COUNT(*) n FROM bp_items WHERE team_id=? AND deleted_at IS NULL').get(team)).toMatchObject({ n: 0 });
    const P = proposalsOf(team);
    expect(P).toHaveLength(1);
    const ops = JSON.parse(P[0]!.ops) as { kind: string; key: string; parent_key?: string; team_id?: string | null }[];
    const mod = ops[0]!;
    expect(mod).toMatchObject({ kind: 'module', team_id: null });
    expect(mod.key).toMatch(/^[A-Z]{2,6}$/);
    expect(ops.filter((o) => o.kind === 'fr' || o.kind === 'nfr').every((o) => o.parent_key === mod.key)).toBe(true);
    expect(ops.filter((o) => o.kind === 'fr').map((o) => o.key)).toEqual([`FR-${mod.key}-01`, `FR-${mod.key}-02`]);
    // Applying it opens the module at project level and files the requirements there, still drafts.
    const adminId = (app.db.prepare('SELECT id FROM admin_users LIMIT 1').get() as { id: string }).id;
    const ap = app.blueprint.applyProposal(P[0]!.id, { kind: 'operator', id: adminId });
    expect(ap.stale).toBeNull();
    const row = (k: string) => app.db.prepare('SELECT kind, team_id, status, parent_key FROM bp_items WHERE key=? AND deleted_at IS NULL').get(k) as { kind: string; team_id: string | null; status: string | null; parent_key: string | null } | undefined;
    expect(row(mod.key)).toMatchObject({ kind: 'module', team_id: null });
    expect(row(`FR-${mod.key}-01`)).toMatchObject({ team_id: null, status: 'draft', parent_key: mod.key });
    expect(row(`FR-${mod.key}-01/AC1`)).toMatchObject({ kind: 'ac', team_id: null });
  });
  it("FR-PLAN-12: with more teams to come they go in the team's new part, as before", async () => {
    const r = await filed('req-more-pc', { project: { name: `Arrive more ${++seq}`, existing: false, more_teams: true } });
    const a = await api('POST', `/onboarding/${r.id}/approve`, { version: r.version });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const team = a.body.request.team_id as string;
    const part = app.db.prepare("SELECT key FROM bp_items WHERE team_id=? AND kind='module' AND deleted_at IS NULL").all(team) as { key: string }[];
    expect(part).toHaveLength(1);
    const ops = JSON.parse(proposalsOf(team)[0]!.ops) as { kind: string; parent_key?: string }[];
    expect(ops.some((o) => o.kind === 'module')).toBe(false);
    expect(ops.filter((o) => o.kind === 'fr').every((o) => o.parent_key === part[0]!.key)).toBe(true);
  });
  it('setup.mjs sends project.more_teams: a boolean, for a new team only', () => {
    expect(validateRequest(request({ project: { name: 'Arrive client', existing: false, more_teams: true } }))).toEqual([]);
    const f = (over: Record<string, unknown>) => validateRequest(request(over)).map((x: { field: string }) => x.field);
    expect(f({ project: { name: 'Arrive client', existing: false, more_teams: 'yes' } })).toContain('project.more_teams');
    expect(f({ kind: 'add_agents', project: { name: 'Arrive client', existing: true, more_teams: true }, team: { id: 'team_x', goal: 'g' }, requirements: undefined })).toContain('project.more_teams');
  });
  it('an edited requirement is checked like a filed one', async () => {
    const r = await filed('req-edit-bad-pc');
    const bad = await api('POST', `/onboarding/${r.id}/approve`, { version: r.version, edits: { requirements: [{ kind: 'nfr', title: 'x', text: 'y' }] } });
    expect(bad.status).toBe(400);
    expect(app.db.prepare("SELECT state FROM onboarding_requests WHERE id=?").get(r.id)).toMatchObject({ state: 'submitted' });
  });
});

describe('4. the CLAUDE.md points to the directives; the goal stays a goal', () => {
  it('the Directives section points to the hub list and does not repeat the standard directives', async () => {
    const r = await filed('md-pc', { requirements: undefined });
    expect((await api('POST', `/onboarding/${r.id}/approve`, { version: r.version })).status).toBe(200);
    const p = await ob('POST', '/pickup', { key: r.key, body: { request_id: r.id } });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    const md: string = p.body.agents[0].instructions;
    const sec = md.slice(md.indexOf('## Directives'), md.indexOf('## Writing for the operator'));
    expect(sec).toContain('This file does not repeat them: the hub\'s list is the one to follow.');
    expect(sec).toContain('It goes to your team as a suggestion for the operator');
    for (const d of STANDARD_DIRECTIVES) expect(md).not.toContain(d.text.split('\n')[0]!);
    // A Codex agent's AGENTS.override.md is built from the same hub text: its four shared sections are the CLAUDE.md ones.
    const section = (t: string, h: string) => { const i = t.indexOf(`## ${h}\n`); expect(i, h).toBeGreaterThan(-1); const j = t.indexOf('\n## ', i + 1); return t.slice(i, j < 0 ? undefined : j).trimEnd(); };
    const codex: string = agentsOverride({ label: 'dev', role: 'developer', team: 'T', instructions: md.replace(/\n/g, '\r\n'), playbook: 'ignored' });
    for (const h of ['Directives', 'Writing for the operator', 'Feedback', 'Connection']) expect(section(codex, h)).toBe(section(md, h));
    // The Connection section is exactly two lines, the same for both clients, and names no part of the old setup.
    const conn = section(md, 'Connection').split('\n').slice(1).filter((l) => l.trim()).slice(0, 2);
    expect(conn).toEqual([
      'The `conclave` server connects you to the hub through the Conclave connector on this PC; it is logged in for you. Never call session_login, leave session_token out, never read the connector\'s key file, never put a key or token anywhere.',
      'If the conclave tools are missing, stop and report your client\'s exact error and the output of `conclave check` in this folder.',
    ]);
    for (const old of ['keys.env', '.agent-hub.json', 'agent-hub-headers', 'headers helper', 'setup.mjs', 'codex-bridge', 'helper.log', 'session_var']) expect(section(md, 'Connection'), old).not.toContain(old);
  });
  it('both start lines read and confirm the directives first', () => {
    const claude: string = resumeMsg({ label: 'dev', role: 'developer' }, 'T'), codex: string = resumeMessage({ label: 'dev', role: 'developer', team: 'T' });
    expect(claude).toBe(codex);
    expect(codex).toContain(`Call ${FIRST_CALL}, then checkout_resume`);
    expect(FIRST_CALL).toBe('directives_read {unread: true, ack: true}');
  });
  it('the check warns when the goal reads like a list of rules, in the hub and in setup.mjs', () => {
    expect(goalHasRules('Keep the grant calendar current.')).toBe(false);
    expect(goalHasRules('Keep the calendar.\n- Never push.\n- Always ask first.')).toBe(true);
    expect(goalHasRules('You must test, never push and always ask.')).toBe(true);
    expect(clientGoalHasRules('You must test, never push and always ask.')).toBe(true);
    expect(clientGoalHasRules('Keep the grant calendar current.')).toBe(false);
    const ruled = app.onboarding.validate(request({ team: { name: 'Ruled', goal: 'Ship it.\n1. Never push.\n2. Always ask.' } }), null);
    expect(ruled.warnings.map((w) => w.code)).toContain('goal_has_rules');
    expect(app.onboarding.validate(request(), null).warnings.map((w) => w.code)).not.toContain('goal_has_rules');
  });
});

describe('5. a reported rule is a suggestion to the team', () => {
  const agents = (n: number) => Array.from({ length: n }, (_, i) => { const a = app.keys.createAgent(`sugg-${seq}-${i}`, null, sys); app.keys.createSessionKey({ agentId: a.id, label: `${a.label} key` }, sys); return a; });
  const teamOf = async (members: { id: string }[]) => {
    const res = await api('POST', '/teams', { name: `sugg team ${++seq}`, goal: 'ship it', members: members.map((m, i) => ({ agent_id: m.id, role: i === 0 ? 'coordinator' : 'worker' })) });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.team.id as string;
  };
  it('a report is an open suggestion for the agent\'s team: nothing is in force by it', async () => {
    const [c, w] = agents(2);
    const tid = await teamOf([c!, w!]);
    const r = app.directives.report(w!.id, { title: 'Dates in ISO format', source: 'AGENTS.md', summary: 'Write dates as YYYY-MM-DD.', category: 'process' });
    expect(r).toMatchObject({ status: 'open', team_id: tid, category: 'process', directive_id: null, known: null });
    expect(app.directives.forAgent(w!.id).some((d) => d.title === 'Dates in ISO format')).toBe(false);
    // the same title again updates the open suggestion
    const again = app.directives.report(w!.id, { title: 'dates in ISO format.', summary: 'Dates are YYYY-MM-DD.', text: 'Write every date as YYYY-MM-DD.' });
    expect(again.id).toBe(r.id);
    expect(again).toMatchObject({ summary: 'Dates are YYYY-MM-DD.', text: 'Write every date as YYYY-MM-DD.', category: 'process' });
    const list = (await api('GET', '/directive-reports')).body.reports.find((x: { id: string }) => x.id === r.id);
    expect(list).toMatchObject({ team_id: tid, team_label: expect.stringContaining('sugg team'), status: 'open' });
    expect((await api('GET', '/directives/unreviewed-count')).body.suggestions).toBeGreaterThanOrEqual(1);
    expect((await api('GET', `/teams/${tid}/directives`)).body.open_reports).toBe(1);
  });
  it('it is ignored when a directive in force already says the same thing', async () => {
    const [c, w] = agents(2);
    const tid = await teamOf([c!, w!]);
    const d = (await api('POST', '/directives', { title: 'Never push', body: 'Do not push to GitHub.', scope: { kind: 'team', ref: tid } })).body.directive;
    const byTitle = app.directives.report(w!.id, { title: 'never push.', summary: 'No pushing.' });
    expect(byTitle).toMatchObject({ status: 'known', directive_id: d.id });
    expect(byTitle.known?.id).toBe(d.id);
    const byText = app.directives.report(w!.id, { title: 'Git rule', summary: 'x', text: 'do not push to github' });
    expect(byText).toMatchObject({ status: 'known', directive_id: d.id });
    expect((await api('GET', `/teams/${tid}/directives`)).body.open_reports).toBe(0);
    await api('POST', `/directives/${d.id}/retire`, {});
  });
  it('adopting makes a team directive and closes the same suggestion from other members, telling each', async () => {
    const [c, w1, w2] = agents(3);
    const tid = await teamOf([c!, w1!, w2!]);
    const a = app.directives.report(w1!.id, { title: 'Short replies', summary: 'Keep replies short.', text: 'Keep replies short.', category: 'tokens' });
    const b = app.directives.report(w2!.id, { title: 'Short replies!', summary: 'Be brief.' });
    const other = app.directives.report(w2!.id, { title: 'Cite notes', summary: 'Cite the vault note.' });
    const res = await api('POST', `/directive-reports/${a.id}/adopt`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.merged).toBe(1);
    expect(res.body.directive).toMatchObject({ scope_kind: 'team', scope_ref: tid, category: 'tokens', body: 'Keep replies short.' });
    const st = (id: string) => (app.db.prepare('SELECT status, directive_id FROM directive_reports WHERE id=?').get(id) as { status: string; directive_id: string | null });
    expect(st(a.id)).toEqual({ status: 'adopted', directive_id: res.body.directive.id });
    expect(st(b.id)).toEqual({ status: 'known', directive_id: res.body.directive.id });
    expect(st(other.id).status).toBe('open');
    const told = app.db.prepare("SELECT agent_id FROM agent_notices WHERE kind='directive_changed' AND body LIKE ?").all(`%${res.body.directive.id}%`) as { agent_id: string }[];
    expect(new Set(told.map((x) => x.agent_id))).toEqual(new Set([c!.id, w1!.id, w2!.id]));
    expect(app.directives.forAgent(w2!.id).some((d) => d.id === res.body.directive.id)).toBe(true);
    await api('POST', `/directives/${res.body.directive.id}/retire`, {});
  });
  it('an agent may have at most 50 open suggestions', async () => {
    const [w] = agents(1);
    for (let i = 0; i < MAX_OPEN_REPORTS; i++) app.directives.report(w!.id, { title: `Rule ${i}`, summary: 's' });
    expect(() => app.directives.report(w!.id, { title: 'One more', summary: 's' })).toThrow(/50 suggestions/);
  });
  it('the agent tool says it is a suggestion', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'mcp', 'directiveTools.ts'), 'utf8');
    expect(src).toContain('It goes to your team as a suggestion for the operator');
    expect(src).toContain('Already a rule: directive');
  });
});

describe('6. the console shows requirements and standard directives safely', () => {
  const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
  const esc = js.match(/^const esc = .*$/m)![0];
  const plural = js.match(/^const plural = .*$/m)![0];
  const stdBlock = js.slice(js.indexOf('  // ── the standard directives (hub template)'), js.indexOf('  const stdSec'));
  const reqBlock = js.slice(js.indexOf('  // ── requirements the agent proposes (L2)'), js.indexOf('  const drawReqs'));
  const ic = (n: string) => `<i data-ic="${n}"></i>`;
  it('requirements start ticked; a requirement with markup renders escaped, as inert text', () => {
    expect(js).toContain('const RKEEP = E.requirements.map(() => true);');
    const ctx: Record<string, unknown> = { RKEEP: [true], ic };
    vm.runInNewContext(`${esc}\n${plural}\n${reqBlock}\nthis.reqRow = reqRow;`, ctx);
    const html = (ctx.reqRow as (x: object, i: number) => string)({ kind: 'nfr', category: 'sec', title: '"><img src=x onerror=alert(1)>', text: '</textarea><script>alert(1)</script>', acs: ['<b>bold</b>'] }, 0);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>');
    expect(html).toContain('value="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"');
    expect(html).toContain('&lt;/textarea&gt;&lt;script&gt;');
    expect(html).toContain('AC1 · &lt;b&gt;bold&lt;/b&gt;');
    expect(html).toContain('Non-functional · Security · 1 acceptance criterion');
    expect(html).toMatch(/data-rqi checked/);
    expect(js).toMatch(/Written by the agent on \$\{esc\(pcName\)\}<\/span><\/div>\s*<div id="obRq">/);
  });
  it('an unticked requirement is shown off, its fields disabled', () => {
    const ctx: Record<string, unknown> = { RKEEP: [false], ic };
    vm.runInNewContext(`${esc}\n${plural}\n${reqBlock}\nthis.reqRow = reqRow;`, ctx);
    const html = (ctx.reqRow as (x: object, i: number) => string)({ kind: 'fr', title: 't', text: 'x' }, 0);
    expect(html).toContain('class="ob-rule off"');
    expect(html).toMatch(/data-rqk="title"[^>]* disabled>/);
  });
  it('the standard directives are editable and cannot be unticked', () => {
    const ctx: Record<string, unknown> = { ic, DIR_CAT_LABEL: { process: 'Process & workflow' } };
    vm.runInNewContext(`${esc}\n${stdBlock}\nthis.stdRow = stdRow;`, ctx);
    const html = (ctx.stdRow as (x: object, i: number) => string)({ key: 'who_decides', title: 'Who <decides>', text: 'a & b', category: 'process' }, 0);
    expect(html).toContain('value="Who &lt;decides&gt;"');
    expect(html).toContain('a &amp; b');
    expect(html).toContain('Process &amp; workflow');
    expect(html).not.toContain('type="checkbox"');
  });
  it('approving sends the standard wording and the kept requirements; suggestions name the team', () => {
    expect(js).toContain('...(STD.length ? { standard } : {}), ...(E.requirements.length ? { requirements } : {})');
    expect(js).toContain("kd('Suggestions from agents'");
    expect(js).toContain('[r.agent_label, r.team_label, r.source');
    expect(js).toContain("['max_requirements', 'Requirements per request'");
  });
});
