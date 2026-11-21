/** Project Blueprint (docs/blueprint.md §5, §7): bp_read, bp_write, bp_proposals, bp_report, playbooks and grants. */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import type { Op } from '../src/blueprint/blueprint.js';
import { ON_DEMAND_PLAYBOOKS } from '../src/teams/teams.js';
import { Sources } from '../src/blueprint/sources.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
type Res = { isError?: boolean; structuredContent?: any; content?: { text: string }[] };
type Call = (name: string, args?: Record<string, unknown>) => Promise<Res>;
let app: App, dir = '', adminId = '', base = '', appKey = '', pcId = '';
let coordA = '', workerA = '', teamA = '', teamB = '', P = '';
let CA: Call, WA: Call, WG: Call, CB: Call;
const opr = () => ({ kind: 'operator' as const, id: adminId });
const v = () => app.blueprint.project(P)!.version;
const put = (ops: Op[]) => app.blueprint.write(P, { version: v(), ops }, opr());
const text = (r: Res) => (r.content ?? []).map((c) => c.text).join('\n');
const errCode = (r: Res) => (r.isError ? /^(\w+)/.exec(text(r))?.[1] ?? 'error' : 'ok');
const ok = (r: Res) => { if (r.isError) throw new Error(text(r)); return r.structuredContent; };
const keysOf = (r: Res) => (ok(r).items as { key: string }[]).map((i) => i.key);

async function session(secret: string): Promise<Call> {
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  const token = ((await c.callTool({ name: 'session_login', arguments: { session_key: secret } })) as Res).structuredContent.session_token;
  return async (name, args = {}) => (await c.callTool({ name, arguments: { session_token: token, ...args } })) as Res;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ahbp3-'));
  mkdirSync(join(dir, 'vault'));
  const config: Config = testConfig(dir);
  app = await buildApp(config);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  const { cookie, csrf } = await adminLogin(base);
  adminId = (app.db.prepare('SELECT id FROM admin_users LIMIT 1').get() as { id: string }).id;
  const pc = pcId = ((await (await fetch(`${base}/api/pcs`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: JSON.stringify({ name: 'pc' }) })).json()) as any).pc.id as string;
  appKey = app.keys.createAppKey({ machineId: pc, appName: 'claude-code', maxLiveSessions: 20 }, sys).secret;
  const agent = (label: string, open = true) => {
    const a = app.keys.createAgent(label, null, sys);
    const k = app.keys.createSessionKey({ agentId: a.id, label }, sys);
    if (open) app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }], 'test', sys);
    return { id: a.id, cred: k.credential.id, secret: k.secret };
  };
  // wg has no grants of its own: only the team's rules let it call the bp_* tools.
  const ca = agent('coord-a'), wa = agent('worker-a'), wg = agent('worker-grant', false), cb = agent('coord-b');
  coordA = ca.id; workerA = wa.id;
  teamA = app.teams.create({ name: 'Signals Lab', goal: 'g', members: [{ agent_id: ca.id, role: 'coordinator', credential_id: ca.cred }, { agent_id: wa.id, role: 'worker', credential_id: wa.cred }, { agent_id: wg.id, role: 'worker', credential_id: wg.cred }] }, sys).id;
  teamB = app.teams.create({ name: 'Tern-9 Keepers', goal: 'g', members: [{ agent_id: cb.id, role: 'coordinator', credential_id: cb.cred }] }, sys).id;
  app.teams.start(teamA, sys); app.teams.start(teamB, sys);
  P = app.blueprint.ensureTeamProject(teamA).id;
  app.db.prepare('UPDATE teams SET project_id=? WHERE id=?').run(P, teamB);
  put([
    { op: 'upsert', kind: 'module', key: 'FLD', title: 'Field model', team_id: teamA },
    { op: 'upsert', kind: 'module', key: 'PWR', title: 'Power', team_id: teamB },
    { op: 'upsert', kind: 'fr', key: 'FR-PWR-01', parent_key: 'PWR', title: 'Coils hold 2 T' },
    { op: 'upsert', kind: 'fr', key: 'FR-FLD-01', parent_key: 'FLD', title: 'Field model frozen' },
    { op: 'upsert', kind: 'ac', key: 'FR-FLD-01/AC1', parent_key: 'FR-FLD-01', title: 'Frozen', fields: { then: 'v2 tagged' } },
    { op: 'upsert', kind: 'line', key: 'L1', title: 'Field shape', fields: { mode: 'validate' }, team_id: teamA },
    { op: 'upsert', kind: 'line', key: 'L2', title: 'Coil heat', fields: { mode: 'validate' }, team_id: teamB },
    { op: 'upsert', kind: 'hypothesis', key: 'H-L1-01', parent_key: 'L1', title: 'The field is flat at depth' },
    { op: 'upsert', kind: 'hypothesis', key: 'H-L2-01', parent_key: 'L2', title: 'Heat stays below 80 K' },
    { op: 'upsert', kind: 'paper', key: 'PAP-1', title: 'A field model', team_id: teamA, fields: { venue: 'JFE' } },
    { op: 'upsert', kind: 'milestone', key: 'M1', title: 'First field', team_id: teamA },
    { op: 'upsert', kind: 'risk', key: 'RK-01', title: 'Echo 47 unexplained' },
  ]);
  [CA, WA, WG, CB] = await Promise.all([ca, wa, wg, cb].map((x) => session(x.secret)));
});
afterAll(async () => { await app?.close(); });

describe('bp_read (§5)', () => {
  it('reads the team part plus project-level items by default, the whole project on request', async () => {
    const part = keysOf(await CA('bp_read', {}));
    expect(part).toEqual(expect.arrayContaining(['FLD', 'FR-FLD-01', 'L1', 'H-L1-01', 'PAP-1', 'M1', 'RK-01']));
    expect(part).not.toContain('PWR');
    expect(part).not.toContain('H-L2-01');
    expect(keysOf(await CA('bp_read', { scope: 'project' }))).toEqual(expect.arrayContaining(['PWR', 'FR-PWR-01', 'H-L2-01']));
    expect(keysOf(await CA('bp_read', { track: 'L2' })).sort()).toEqual(['H-L2-01', 'L2']);
    expect(keysOf(await CA('bp_read', { keys: ['FR-PWR-01'] }))).toEqual(['FR-PWR-01']);
    expect(keysOf(await CA('bp_read', { section: 4 })).sort()).toEqual(['M1', 'PAP-1']);
    expect(keysOf(await CA('bp_read', { kinds: ['fr'], status: ['draft'] }))).toEqual(['FR-FLD-01']);
    const r = ok(await CA('bp_read', { limit: 2 }));
    expect(r.items).toHaveLength(2);
    expect(r.next_cursor).toBe(2);
    expect(errCode(await CA('bp_read', { track: 'FR-FLD-01' }))).toBe('invalid_argument');
  });

  it('is open to members through the team grant, and to nobody else', async () => {
    expect(keysOf(await WG('bp_read', {}))).toContain('FLD');
    const outsider = app.keys.createAgent('outsider', null, sys);
    const k = app.keys.createSessionKey({ agentId: outsider.id, label: 'o' }, sys);
    app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }], 'test', sys);
    const O = await session(k.secret);
    expect(errCode(await O('bp_read', {}))).toBe('denied');
    expect(errCode(await O('bp_read', { project: app.blueprint.project(P)!.key }))).toBe('denied');
  });

  it('since_version returns only what changed after it, and what was removed', async () => {
    const at = v();
    put([{ op: 'upsert', kind: 'milestone', key: 'M1', title: 'First field', status: 'in_progress' }, { op: 'upsert', kind: 'issue', key: 'I1', title: 'Scratch', team_id: teamA }]);
    put([{ op: 'remove', key: 'I1' }]);
    const r = ok(await CA('bp_read', { since_version: at }));
    expect(r.items.map((i: { key: string }) => i.key)).toEqual(['M1']);
    expect(r.removed).toEqual(['I1']);
    expect(ok(await CA('bp_read', { since_version: v() })).items).toEqual([]);
  });

  it('an agent in two teams of one project is asked to name team_id, and then reads that part', async () => {
    const a = app.keys.createAgent('dual', null, sys);
    const k = app.keys.createSessionKey({ agentId: a.id, label: 'dual' }, sys);
    app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }], 'test', sys);
    const t1 = app.teams.create({ name: 'Dual One', goal: 'g', members: [{ agent_id: a.id, role: 'coordinator' }] }, sys).id;
    const t2 = app.teams.create({ name: 'Dual Two', goal: 'g', members: [{ agent_id: a.id, role: 'coordinator' }] }, sys).id;
    app.teams.start(t1, sys); app.teams.start(t2, sys);
    app.db.prepare('UPDATE teams SET project_id=? WHERE id IN (?,?)').run(P, t1, t2);
    const D = await session(k.secret);
    const r = await D('bp_read', {});
    expect(errCode(r)).toBe('invalid_argument');
    expect(text(r)).toContain(`name team_id (${t1}, ${t2})`);
    expect(ok(await D('bp_read', { team_id: t1 })).project.id).toBe(P);
    // The proposals list needs no team: it lists the caller's own.
    expect(ok(await D('bp_proposals', {})).proposals).toEqual([]);
  });
});

describe('bp_write and the support it changes (§5)', () => {
  it('applies a coordinator write in its part and reports claims whose support changed', async () => {
    const r = ok(await CA('bp_write', { version: v(), ops: [
      { op: 'upsert', kind: 'claim', key: 'PAP-1/C*', parent_key: 'PAP-1', title: 'The field is flat' },
      { op: 'upsert', kind: 'finding', key: 'F-L1-*', parent_key: 'L1', title: 'Flat at 0.33 d', fields: { confidence: 'high' } },
    ] }));
    expect(r.status).toBe('applied');
    expect(r.keys).toEqual({ 'PAP-1/C*': 'PAP-1/C1', 'F-L1-*': 'F-L1-01' });
    expect(r.support_changed).toEqual([{ key: 'PAP-1/C1', was: null, now: 'unsupported' }]);
    const l = ok(await CA('bp_write', { version: v(), ops: [{ op: 'link', from: 'F-L1-01', to: 'PAP-1/C1', rel: 'evidence' }, { op: 'link', from: 'H-L1-01', to: 'PAP-1/C1', rel: 'evidence' }, { op: 'link', from: 'F-L1-01', to: 'H-L1-01', rel: 'evidence' }] }));
    expect(l.support_changed).toEqual([{ key: 'PAP-1/C1', was: 'unsupported', now: 'supported' }]);
    // A paper in full: its claims with their evidence chains, one level below the evidence.
    const paper = ok(await CA('bp_read', { keys: ['PAP-1'], detail: 'full' })).items[0];
    expect(paper).toMatchObject({ supported: '1 of 1', ready: true });
    const chain = paper.claims[0].chain as { key: string; from?: { key: string }[] }[];
    expect(chain.map((x) => x.key)).toEqual(['F-L1-01', 'H-L1-01']);
    expect(chain[1]!.from!.map((x) => x.key)).toEqual(['F-L1-01']);
    expect(text(await CA('bp_read', { keys: ['PAP-1/C1'], detail: 'full' }))).toMatch(/← H-L1-01 \[untested\][^\n]*\n {4}← F-L1-01 \[high\]/);
    // Conflicts are per item (F-24): PAP-1/C1 changed at the current version, so a write to it from the version before conflicts,
    // and the error carries the current version and the keys; a rev that does not match conflicts too.
    const stale = await CA('bp_write', { version: v() - 1, ops: [{ op: 'upsert', kind: 'claim', key: 'PAP-1/C1', title: 'x' }] });
    expect(errCode(stale)).toBe('conflict');
    expect(stale.structuredContent).toMatchObject({ error: 'conflict', current_version: v(), keys: ['PAP-1/C1'] });
    expect(errCode(await CA('bp_write', { version: v(), ops: [{ op: 'upsert', kind: 'claim', key: 'PAP-1/C1', title: 'x', rev: 99 }] }))).toBe('conflict');
    expect(errCode(await CA('bp_write', { version: v() + 1, ops: [{ op: 'upsert', kind: 'milestone', key: 'M1', title: 'x' }] }))).toBe('conflict');
  });

  it('turns a batch that needs the operator into one proposal, and refuses what is not the caller\'s', async () => {
    const r = ok(await CA('bp_write', { version: v(), ops: [{ op: 'upsert', kind: 'fr', key: 'FR-FLD-01', status: 'agreed' }], reason: 'v2 is frozen' }));
    expect(r).toMatchObject({ status: 'proposed' });
    expect(r.why.join(' ')).toMatch(/agreeing FR-FLD-01/);
    app.blueprint.rejectProposal(r.proposal_id, opr(), 'not yet');
    expect(errCode(await WA('bp_write', { version: v(), ops: [{ op: 'upsert', kind: 'report', key: 'SR-*', title: 'x', team_id: teamA, fields: { health: 'on_track' } }] }))).toBe('denied');
  });

  it('refuses report items in bp_write even from the coordinator: reports go through bp_report', async () => {
    const before = v();
    const r = await CA('bp_write', { version: v(), ops: [{ op: 'upsert', kind: 'report', key: 'SR-*', title: 'Week 1', team_id: teamA, fields: { health: 'on_track' } }] });
    expect(errCode(r)).toBe('denied');
    expect(text(r)).toMatch(/bp_report/);
    // Nor in a batch with ops that would apply, nor by editing or removing a filed one.
    expect(errCode(await CA('bp_write', { version: v(), ops: [{ op: 'upsert', kind: 'milestone', key: 'M1', title: 'First field', status: 'reached' }, { op: 'upsert', kind: 'report', key: 'SR-*', title: 'x', team_id: teamA, fields: { health: 'on_track' } }] }))).toBe('denied');
    put([{ op: 'upsert', kind: 'report', key: 'SR-*', title: 'By the operator', team_id: teamB, fields: { health: 'on_track' } }]);
    const sr = app.blueprint.items(P, { kinds: ['report'], team: teamB })[0]!.key;
    expect(errCode(await CB('bp_write', { version: v(), ops: [{ op: 'upsert', kind: 'report', key: sr, title: 'Edited', fields: { health: 'off_track' } }] }))).toBe('denied');
    expect(errCode(await CB('bp_write', { version: v(), ops: [{ op: 'remove', key: sr }] }))).toBe('denied');
    put([{ op: 'remove', key: sr }]);
    expect(app.blueprint.items(P, { kinds: ['report'], team: teamA })).toEqual([]);
    expect(v()).toBe(before + 2);
  });

  it('takes its caps from the operator\'s limits, up to the hard ceiling, and names the limit it hit (F-26)', async () => {
    const terms = (n: number, body?: string) => Array.from({ length: n }, (_, i) => ({ op: 'upsert', kind: 'term', key: `G-cap${i}`, title: `cap ${i}`, ...(body ? { body } : {}) }));
    const over = await CA('bp_write', { version: v(), ops: terms(51) });
    expect(errCode(over)).toBe('invalid_argument');
    expect(text(over)).toMatch(/at most 50 ops \(limit ops_per_write/);
    expect(text(await CA('bp_write', { version: v(), ops: terms(1, 'x'.repeat(16_001)) }))).toMatch(/limit body/); // past the old schema cap of 16k: the service answers
    const was = app.blueprint.limits;
    app.blueprint.setLimits({ ...was, opsPerWrite: 60 });
    try {
      const r = await CA('bp_write', { version: v(), ops: terms(55) });
      expect(errCode(r)).not.toBe('invalid_argument'); // a raised limit reaches agents (a term is proposed: project-level)
      const ceiling = await CA('bp_write', { version: v(), ops: terms(201) });
      expect(ceiling.isError && /-32602|200/.test(text(ceiling))).toBe(true); // the schema's hard ceiling
    } finally { app.blueprint.setLimits(was); }
    for (const p of app.blueprint.proposals(P, { status: 'open', agent: coordA })) app.blueprint.rejectProposal(p.id, opr(), null);
  });
});

describe('bp_proposals and the review notes', () => {
  it('lists the caller\'s own proposals and withdraws one; lockdown refuses the withdrawal, not the list', async () => {
    const r = ok(await WA('bp_write', { version: v(), ops: [{ op: 'upsert', kind: 'risk', key: 'RK-*', title: 'Coil supplier late', team_id: teamA }] }));
    expect(r.status).toBe('proposed');
    const mine = ok(await WA('bp_proposals', { status: 'open' })).proposals as { id: string }[];
    expect(mine.map((x) => x.id)).toEqual([r.proposal_id]);
    expect(ok(await CA('bp_proposals', { status: 'open' })).proposals).toEqual([]); // not the coordinator's own
    expect(errCode(await CA('bp_proposals', { withdraw: r.proposal_id }))).toBe('denied');
    app.lockdown.set('team', teamA, true, null);
    try {
      expect(errCode(await WA('bp_proposals', { withdraw: r.proposal_id }))).toBe('lockdown');
      expect(ok(await WA('bp_proposals', {})).proposals.length).toBeGreaterThan(0);
      expect(keysOf(await WA('bp_read', {}))).toContain('FLD');
    } finally { app.lockdown.set('team', teamA, false, null); }
    // A PC lockdown is the tool layer's (it knows the machine): it refuses the withdrawal too, not the list.
    app.lockdown.set('pc', pcId, true, null);
    try {
      expect(errCode(await WA('bp_proposals', { withdraw: r.proposal_id }))).toBe('lockdown');
      expect(ok(await WA('bp_proposals', {})).proposals.length).toBeGreaterThan(0);
    } finally { app.lockdown.set('pc', pcId, false, null); }
    expect(ok(await WA('bp_proposals', { withdraw: r.proposal_id })).proposal.status).toBe('withdrawn');
    // decide() only moves an open proposal: a withdrawn one cannot be applied or rejected afterwards.
    expect(() => app.blueprint.applyProposal(r.proposal_id, opr())).toThrow(/already withdrawn/);
    expect(() => app.blueprint.rejectProposal(r.proposal_id, opr())).toThrow(/already withdrawn/);
  });

  it('a decision that loses the race to a withdrawal rolls back the applied ops', () => {
    const r = app.blueprint.submit(P, { version: v(), ops: [{ op: 'upsert', kind: 'risk', key: 'RK-*', title: 'Race', team_id: teamA }] }, workerA);
    expect(r.status).toBe('proposed');
    const id = r.status === 'proposed' ? r.proposal.id : '';
    const before = v();
    // The proposal turns withdrawn between the check and the decision, as an async caller could see it.
    app.db.exec(`CREATE TEMP TRIGGER bp_race AFTER INSERT ON bp_events BEGIN UPDATE bp_proposals SET status='withdrawn' WHERE id='${id}'; END`);
    try { expect(() => app.blueprint.applyProposal(id, opr())).toThrow(/already withdrawn/); } finally { app.db.exec('DROP TRIGGER bp_race'); }
    expect(v()).toBe(before);
    expect(app.blueprint.items(P, { kinds: ['risk'] }).map((i) => i.title)).not.toContain('Race');
  });
});

describe('bp_report and its cadence (§7)', () => {
  const lastReport = () => app.db.prepare("SELECT * FROM bp_items WHERE project_id=? AND kind='report' AND team_id=? ORDER BY created_at DESC, key DESC LIMIT 1").get(P, teamA) as { key: string; fields: string; origin_id: string };
  it('files a report with the hub facts, keeps its short form as the team status report, and posts it', async () => {
    expect(errCode(await WA('bp_report', { health: 'on_track' }))).toBe('denied');
    // The schema carries the report shape (F-04): at most 3 bullets of at most 140 characters each.
    expect(errCode(await CA('bp_report', { health: 'on_track', done: ['a', 'b', 'c', 'd'] }))).not.toBe('ok');
    expect(errCode(await CA('bp_report', { health: 'on_track', done: ['x'.repeat(141)] }))).not.toBe('ok');
    expect(() => app.blueprint.fileReport(teamA, coordA, { health: 'on_track', done: ['a', 'b', 'c', 'd'] })).toThrow(/at most 3 bullets/);
    expect(errCode(await CA('bp_report', { health: 'on_track', refs: ['FR-NOPE-01'] }))).toBe('invalid_argument');
    const r = ok(await CA('bp_report', { health: 'on_track', done: ['F-L1-01 recorded'], next: ['FR-FLD-01 agree'], refs: ['FR-FLD-01'] }));
    expect(r.key).toMatch(/^SR-\d{3}$/);
    expect(r.facts.moved).toEqual(expect.arrayContaining(['M1 planned→in_progress']));
    expect(r.facts.claims).toEqual(['PAP-1/C1 new→supported']);
    const row = lastReport();
    expect(JSON.parse(row.fields)).toMatchObject({ health: 'on_track', done: ['F-L1-01 recorded'], refs: ['FR-FLD-01'], escalate: false });
    const status = app.db.prepare('SELECT body FROM team_status_reports WHERE id=?').get(row.origin_id) as { body: string };
    expect(status.body).toMatch(/^Status on track\nDone: F-L1-01 recorded/);
  });

  it('allows one a day, sooner when health drops or the operator asks, and refuses when nothing moved', async () => {
    expect(errCode(await CA('bp_report', { health: 'on_track', done: ['again'] }))).toBe('rate_limited');
    const drop = ok(await CA('bp_report', { health: 'at_risk', blockers: ['Echo 47'], escalate: true }));
    expect(drop.key).not.toBe('');
    expect(app.db.prepare("SELECT 1 FROM security_alerts WHERE type='bp_escalation'").get()).toBeTruthy();
    expect(errCode(await CA('bp_report', { health: 'at_risk', blockers: ['Echo 47'] }))).toBe('rate_limited');
    app.teams.requestStatus(teamA, 'before the review', { kind: 'admin', id: adminId });
    const asked = ok(await CA('bp_report', { health: 'at_risk', blockers: ['Echo 47'] }));
    expect(asked.requested).toBe(true);
    expect(JSON.parse(lastReport().fields).requested).toBe('before the review');
    // A day later with nothing moved: refused; a new blocker is news.
    app.db.prepare("UPDATE bp_items SET created_at=created_at-? WHERE project_id=? AND kind='report'").run(25 * 3600_000, P);
    app.db.prepare('UPDATE bp_events SET created_at=created_at-? WHERE project_id=?').run(25 * 3600_000, P);
    app.db.prepare('UPDATE tasks SET updated_at=updated_at-? WHERE team_id=?').run(25 * 3600_000, teamA);
    expect(text(await CA('bp_report', { health: 'at_risk', blockers: ['Echo 47'] }))).toMatch(/Nothing moved/);
    expect(ok(await CA('bp_report', { health: 'at_risk', blockers: ['Echo 47', 'Dish late'] })).key).toMatch(/^SR-/);
  });

  it('reads the newest three reports', async () => {
    expect(keysOf(await CA('bp_read', { kinds: ['report'] }))).toHaveLength(3);
  });

  it('charges the message limit with the filing: a spent limit files nothing and leaves the request open, a retry files once', async () => {
    app.teams.requestStatus(teamA, 'one more', { kind: 'admin', id: adminId });
    const cred = (app.db.prepare('SELECT credential_id FROM team_members WHERE agent_id=? AND team_id=?').get(coordA, teamA) as { credential_id: string }).credential_id;
    const spend = (n: number) => app.db.prepare("INSERT INTO usage_counters(scope,metric,window_start,count) VALUES (?,'messages',?,?) ON CONFLICT(scope,metric,window_start) DO UPDATE SET count=excluded.count")
      .run(`cred:${cred}`, Math.floor(Date.now() / 3600_000) * 3600_000, n);
    const reports = () => (app.db.prepare("SELECT COUNT(*) n FROM bp_items WHERE project_id=? AND kind='report'").get(P) as { n: number }).n;
    const statusRows = () => (app.db.prepare('SELECT COUNT(*) n FROM team_status_reports WHERE team_id=?').get(teamA) as { n: number }).n;
    const [n0, s0, v0] = [reports(), statusRows(), v()];
    spend(1_000_000);
    expect(errCode(await CA('bp_report', { health: 'at_risk', blockers: ['Run 47', 'Coil late'] }))).toBe('rate_limited');
    expect([reports(), statusRows(), v()]).toEqual([n0, s0, v0]);
    expect(app.teams.statusRequest(teamA)?.note).toBe('one more');
    spend(0);
    const r = ok(await CA('bp_report', { health: 'at_risk', blockers: ['Run 47', 'Coil late'] }));
    expect([r.requested, reports(), statusRows()]).toEqual([true, n0 + 1, s0 + 1]);
    expect(app.teams.statusRequest(teamA)).toBeUndefined();
  });
});

describe('playbooks and grants', () => {
  it('the default playbooks name the blueprint tools and the report cadence', () => {
    const d = (app.db.prepare("SELECT playbook FROM team_role_defaults WHERE role='coordinator'").get() as { playbook: string }).playbook;
    expect(d).toMatch(/bp_read \/ bp_write/);
    expect(d).toMatch(/Report with bp_report only when something moved/);
    expect(ON_DEMAND_PLAYBOOKS.coordinator).toMatch(/link new findings to the claims they carry/);
    expect(ON_DEMAND_PLAYBOOKS.worker).toMatch(/bp_read/);
    expect(ON_DEMAND_PLAYBOOKS.reviewer).toContain('is set by your directives (directives_read)');
  });

  it('gives a team missing the bp_* grant its grant on start', () => {
    app.db.prepare("DELETE FROM permission_rules WHERE team_id=? AND resource='tool:bp_*'").run(teamB);
    expect(app.teams.refreshGrants()).toBeGreaterThanOrEqual(1);
    expect(app.db.prepare("SELECT 1 FROM permission_rules WHERE team_id=? AND resource='tool:bp_*'").get(teamB)).toBeTruthy();
  });
});

describe('a new team has a project at once (docs/blueprint.md §3)', () => {
  it('team creation and onboarding\'s draft team get a project (the draft one named after its project), so bp_read works before any plan write', async () => {
    const t = app.teams.create({ name: 'Fresh Optics', goal: 'g', members: [{ agent_id: coordA, role: 'coordinator' }] }, sys);
    expect(app.blueprint.projectOfTeam(t.id)).toMatchObject({ name: 'Fresh Optics', status: 'active' });
    const d = app.teams.createDraftTeam({ name: 'Draft Lab', goal: 'g', project: 'Lab', delivery_mode: 'on_demand', close_on_approve: true, coordinator_reviews: false, lease_minutes: 30, max_review_rounds: 3 }, sys);
    expect(app.blueprint.projectOfTeam(d.id)).toMatchObject({ name: 'Lab' });
    app.teams.start(t.id, sys);
    const r = ok(await CA('bp_read', { team_id: t.id }));
    expect(r.project.name).toBe('Fresh Optics');
  });
});

describe('writing for the operator (docs/blueprint.md §2.7)', () => {
  const first = (r: Res) => text(r).split('\n')[0]!;
  /** The tool's own text, without the notices the session appends. */
  const own = (r: Res) => text(r).split(/\n+Notices \(confirm/)[0]!;

  it('an applied write keeps its first sentence and adds the warnings after it', async () => {
    const r = await CA('bp_write', { team_id: teamA, version: v(), ops: [{ op: 'upsert', kind: 'finding', key: 'F-L1-*', parent_key: 'L1', title: 'S2m A6 gate read' }] });
    const d = ok(r), k = d.keys['F-L1-*'] as string;
    expect(first(r)).toBe(`Applied in ${app.blueprint.project(P)!.key}: version ${d.version}; added ${k}; keys F-L1-*=${k}.`);
    expect(d.warnings[0]).toMatchObject({ kind: 'undefined_code', tokens: ['S2m', 'A6'], key: k });
    expect(text(r)).toContain(`For the operator (the write went through; fix these in your next write):\n- ${k} title uses S2m, A6`);
  });

  it('an empty acceptance criterion warns', async () => {
    const d = ok(await CA('bp_write', { team_id: teamA, version: v(), ops: [{ op: 'upsert', kind: 'ac', key: 'FR-FLD-01/AC*', parent_key: 'FR-FLD-01', title: 'Acceptance' }] }));
    expect(d.warnings).toEqual([expect.objectContaining({ kind: 'empty_ac', key: d.keys['FR-FLD-01/AC*'] })]);
  });

  it('a term in the batch makes it a proposal; its token waits for the operator, and a proposal carries warnings', async () => {
    const r = await CA('bp_write', { team_id: teamA, version: v(), ops: [
      { op: 'upsert', kind: 'term', key: 'G-p25', title: 'P25', body: 'The 25th protocol.', fields: { aliases: ['P-25'] } },
      { op: 'upsert', kind: 'finding', key: 'F-L1-*', parent_key: 'L1', title: 'P25 holds next to Q9' },
    ] });
    const d = ok(r);
    expect(d.status).toBe('proposed');
    expect(d.pending_terms).toEqual([{ key: 'G-p25', tokens: ['P25'] }]);
    expect(d.warnings).toEqual([expect.objectContaining({ kind: 'undefined_code', tokens: ['Q9'] })]);
    expect(text(r)).toContain('Terms waiting for the operator: G-p25. Until the operator applies them, P25 shows as not defined.');
    ok(await CA('bp_proposals', { team_id: teamA, withdraw: d.proposal_id }));
  });

  it('shows 8 warning lines and points at bp_read for the rest; data.warnings has them all', async () => {
    const ops = Array.from({ length: 9 }, (_, i) => ({ op: 'upsert', kind: 'finding', key: `F-L1-${String(40 + i)}`, parent_key: 'L1', title: `Run X${i}9 agreed` }));
    const r = await CA('bp_write', { team_id: teamA, version: v(), ops });
    expect(ok(r).warnings).toHaveLength(9);
    expect(own(r).split('\n').filter((l) => l.startsWith('- '))).toHaveLength(9);
    expect(text(r)).toContain('- and 1 more: bp_read {plain: "issues"}');
  });

  it('a clean write has no warnings key and the same text as before; a failing check never fails the write', async () => {
    const r = await CA('bp_write', { team_id: teamA, version: v(), ops: [{ op: 'upsert', kind: 'finding', key: 'F-L1-*', parent_key: 'L1', title: 'Two runs agreed on the field' }] });
    expect(ok(r).warnings).toBeUndefined();
    expect(ok(r).pending_terms).toBeUndefined();
    expect(own(r)).not.toContain('\n');
    const spy = vi.spyOn(app.blueprint, 'glossary').mockImplementation(() => { throw new Error('boom'); });
    try {
      const s = await CA('bp_write', { team_id: teamA, version: v(), ops: [{ op: 'upsert', kind: 'finding', key: 'F-L1-*', parent_key: 'L1', title: 'Z9 Y8 read' }] });
      expect(ok(s).status).toBe('applied');
      expect(ok(s).warnings).toBeUndefined();
    } finally { spy.mockRestore(); }
  });

  it('bp_read {plain: "issues"} lists only what does not read plainly, with why; without it the text is unchanged', async () => {
    const plain = await CA('bp_read', { team_id: teamA, plain: 'issues' });
    const lines = own(plain).split('\n').slice(1);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.includes(' · not plain: '))).toBe(true);
    expect(own(plain)).toMatch(/S2m A6 gate read.* · not plain: title codes: S2m, A6/);
    expect(own(await CA('bp_read', { team_id: teamA }))).not.toContain('not plain');
    const one = ok(await CA('bp_read', { team_id: teamA, plain: 'issues', limit: 1 }));
    expect(one.items).toHaveLength(1);
    expect(one.next_cursor).toBe(1);
  });

  it('a cited vault file outside the agent\'s grant warns exactly as a file that does not exist (no existence oracle)', async () => {
    mkdirSync(join(dir, 'vault', 'HR'), { recursive: true });
    writeFileSync(join(dir, 'vault', 'HR', 'pay.md'), '# Pay\n');
    // The operator can open it, so the file is really there.
    expect((await new Sources(app.db, app.vault).resolve(P, teamA, ['HR/pay.md']))[0]!.where).toBe('vault');
    const cite = async (src: string) => {
      const d = ok(await CA('bp_write', { team_id: teamA, version: v(), ops: [{ op: 'upsert', kind: 'finding', key: 'F-L1-*', parent_key: 'L1', title: 'Pay bands checked', fields: { evidence: src } }] }));
      const w = (d.warnings ?? []).filter((x: { kind: string }) => x.kind === 'source_missing');
      return w.map((x: { source: string; message: string }) => ({ ...x, key: 'K', title: 'T', source: x.source.replace(src, 'S'), message: x.message.split(d.keys['F-L1-*']).join('K').replace(src, 'S') }));
    };
    const there = await cite('HR/pay.md'), absent = await cite('HR/nope.md');
    expect(there).toHaveLength(1);
    expect(there).toEqual(absent);
  });

  it('repository paths under Records are not checked as vault sources; the same path above Records still is', async () => {
    const cite = async (body: string) => {
      const d = ok(await CA('bp_write', { team_id: teamA, version: v(), ops: [{ op: 'upsert', kind: 'finding', key: 'F-L1-*', parent_key: 'L1', title: 'The card shipped', body }] }));
      return (d.warnings ?? []).filter((x: { kind: string }) => x.kind === 'source_missing').map((x: { source: string }) => x.source);
    };
    expect(await cite('The card shipped.\n\n## Records\n- `server/public/app.js`\n- docs/dashboard-ux.md')).toEqual([]);
    expect(await cite('The card shipped, see `server/public/app.js`.')).toEqual(['server/public/app.js']);
  });

  it('the bp_write description stays short and points at the rules, which tell the writer who reads it and that nothing is refused for it', async () => {
    const c = new Client({ name: 'test', version: '1' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
    const tools = (await c.listTools()).tools;
    const write = tools.find((t) => t.name === 'bp_write')!, read = tools.find((t) => t.name === 'bp_read')!;
    expect(write.description).toContain('bp_read {rules: true}');
    expect(write.description!.length).toBeLessThan(600);
    expect(read.description!.length).toBeLessThan(600);
    await c.close();
    const rules = ok(await WA('bp_read', { rules: true })).rules as string;
    expect(rules).toContain('read by the operator, a person, in the console');
    expect(rules).toContain('never refused');
    expect(rules).toContain('Cite sources as [[note]] links to vault files.');
    expect(rules).toContain('end one in * for the next number');
  });
});
