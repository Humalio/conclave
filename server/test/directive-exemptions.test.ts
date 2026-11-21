/**
 * Directive reach (docs/directives.md, proposal console-systems §6): a directive is in force for the agents its scope
 * covers minus the agents an active exemption keeps it off (one agent, a live team's members, a project label). Every
 * consumer reads the same rule: forAgent and what follows it (summaryFor, read, agentView), coverage, list, teamView and
 * the notices. The first block inserts exemption rows directly; the second makes them with exempt/unexempt and checks
 * the notices they send and how directive notices settle (keys.ts NOTICE_SETTLERS; it supersedes the F5 fix 129c42a).
 * Migration 0106 adds the exemption table, the notice refs and directive_reads, and changes nothing a 0105 hub shows.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, readdirSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from '../src/db/db.js';
import { buildApp, type App } from '../src/app.js';
import type { DirectiveRow, ExemptionKind } from '../src/directives/directives.js';
import { inForceSql } from '../src/directives/reachSql.js';
import { testConfig } from './hub.js';

const sys = { kind: 'system' as const, id: 'test' };
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations');

describe('reach: scope minus exemptions', () => {
  let app: App, root = '';
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'conclave-dex-'));
    mkdirSync(join(root, 'vault'), { recursive: true });
    app = await buildApp(testConfig(root, { vaultDir: join(root, 'vault'), vaultScanSeconds: undefined, vaultWatch: undefined, maintenanceSeconds: undefined }));
  });
  afterAll(async () => { await app?.close(); rmSync(root, { recursive: true, force: true }); });

  let n = 0;
  const agent = (label: string, project: string | null = null) => {
    const a = app.keys.createAgent(`${label}${++n}`, project, sys);
    const k = app.keys.createSessionKey({ agentId: a.id, label: `${label} key` }, sys);
    return { id: a.id, cred: k.credential.id as string };
  };
  /** A team with a coordinator and a worker, plus an agent in the apps team's project and a teamless one. */
  const world = () => {
    const c = agent('coord'), w = agent('worker'), p = agent('apps'), o = agent('other');
    const team = app.teams.create({ name: `team${n}`, goal: 'reach', members: [{ agent_id: c.id, role: 'coordinator', credential_id: c.cred }, { agent_id: w.id, role: 'worker', credential_id: w.cred }] }, sys);
    // The apps agent is in a project through its team: reach follows live memberships, never a label (docs/directives.md#project-reach).
    const apps = app.teams.create({ name: `apps${n}`, goal: 'apps', members: [{ agent_id: p.id, role: 'coordinator', credential_id: p.cred }] }, sys);
    const prj = app.blueprint.projectOfTeam(apps.id)!;
    return { c, w, p, o, team: team.id, apps: apps.id, project: prj.id, projectName: prj.name };
  };
  const dir = (title: string, scope: { kind: 'hub' | 'team' | 'project' | 'agent' | 'role'; ref?: string | null }) =>
    app.directives.create({ title, body: `${title} text.`, scope: { kind: scope.kind, ref: scope.ref ?? null } }, sys);
  let ex = 0;
  const exempt = (d: DirectiveRow, kind: ExemptionKind, ref: string): string => {
    const id = `dex_test${++ex}`;
    app.db.prepare('INSERT INTO directive_exemptions(id,directive_id,target_kind,target_ref,note,created_by,created_at) VALUES (?,?,?,?,NULL,?,?)').run(id, d.id, kind, ref, 'test', Date.now());
    return id;
  };
  const unexempt = (id: string) => app.db.prepare('UPDATE directive_exemptions SET removed_at=?, removed_by=? WHERE id=?').run(Date.now(), 'test', id);
  const ids = (l: { id: string }[]) => l.map((x) => x.id);
  const covered = (d: DirectiveRow) => app.directives.coverage(d).map((c) => c.agent_id);
  const retire = (...L: DirectiveRow[]) => { for (const d of L) app.directives.retire(d.id, null, sys); };

  it('without exemptions, reach is the scope', () => {
    const W = world();
    const hub = dir('Hub parity', { kind: 'hub' }), team = dir('Team parity', { kind: 'team', ref: W.team });
    expect(covered(hub)).toEqual(expect.arrayContaining([W.c.id, W.w.id, W.p.id, W.o.id]));
    expect(covered(team).sort()).toEqual([W.c.id, W.w.id].sort());
    expect(app.directives.reach(team).map((a) => a.id).sort()).toEqual([W.c.id, W.w.id].sort());
    retire(hub, team);
  });

  it('a team exemption keeps a hub rule off every member: agent side, coverage, list and team view', () => {
    const W = world();
    const hub = dir('Hub kept off a team', { kind: 'hub' }), team = dir('Team rule', { kind: 'team', ref: W.team });
    exempt(hub, 'team', W.team);
    for (const m of [W.c.id, W.w.id]) {
      expect(ids(app.directives.forAgent(m))).toEqual([team.id]);
      expect(ids(app.directives.summaryFor(m))).not.toContain(hub.id);
      expect(ids(app.directives.read(m))).not.toContain(hub.id);
      expect(() => app.directives.read(m, hub.id)).toThrow(/No such directive in force for you/);
      expect(ids(app.directives.agentView(m).directives)).not.toContain(hub.id);
      expect(app.directives.applies(hub, app.keys.agent(m)!)).toBe(false);
    }
    // Others still have it.
    expect(ids(app.directives.forAgent(W.o.id))).toContain(hub.id);
    expect(app.directives.read(W.o.id, hub.id)).toHaveLength(1);
    const cov = covered(hub);
    expect(cov).toEqual(expect.arrayContaining([W.p.id, W.o.id]));
    expect(cov).not.toContain(W.c.id); expect(cov).not.toContain(W.w.id);
    expect(app.directives.list('active').find((d) => d.id === hub.id)).toMatchObject({ agents: cov.length, unread: cov.length });
    // The team view still returns the hub rule, marked as kept off this team, and counts only what is in force.
    const tv = app.directives.teamView(W.team);
    expect(tv.directives.map((d) => [d.id, d.tab, d.exempt_here?.kind ?? null, d.agents]).sort()).toEqual([[team.id, 'team', null, 2], [hub.id, 'hub', 'team', 0]].sort());
    expect(tv).toMatchObject({ count: 1, hub: 0, hub_behind: 0, hub_exempt: 1 });
    retire(hub, team);
  });

  it('an agent exemption keeps a team rule off one member only', () => {
    const W = world();
    const team = dir('Team rule minus one', { kind: 'team', ref: W.team });
    app.directives.read(W.c.id, team.id, { ack: true });
    exempt(team, 'agent', W.w.id);
    expect(covered(team)).toEqual([W.c.id]);
    expect(app.directives.teamView(W.team).directives.find((d) => d.id === team.id)).toMatchObject({ agents: 1, current: 1 });
    expect(app.directives.list('active').find((d) => d.id === team.id)).toMatchObject({ agents: 1, current: 1, unread: 0 });
    expect(ids(app.directives.forAgent(W.w.id))).not.toContain(team.id);
    retire(team);
  });

  it('a project exemption takes in the members of the project\'s live teams, not an agent label', () => {
    const W = world();
    const hub = dir('Hub kept off a project', { kind: 'hub' });
    exempt(hub, 'project', W.project);
    expect(covered(hub)).not.toContain(W.p.id);
    expect(covered(hub)).toContain(W.o.id);
    expect(ids(app.directives.forAgent(W.p.id))).not.toContain(hub.id);
    // A label naming the project changes nothing: the teamless agent still has the rule.
    app.keys.updateAgent(W.o.id, { project: W.projectName }, sys);
    expect(ids(app.directives.forAgent(W.o.id))).toContain(hub.id);
    // Membership counts: out of the project's team, the rule is in force again.
    const helper = agent('helper');
    app.teams.addMember(W.apps, { agent_id: helper.id, role: 'worker', credential_id: helper.cred }, sys);
    expect(ids(app.directives.forAgent(helper.id))).not.toContain(hub.id);
    app.teams.removeMember(W.apps, helper.id, sys);
    expect(ids(app.directives.forAgent(helper.id))).toContain(hub.id);
    retire(hub);
  });

  it('a team exemption follows live membership: joining drops the rule, leaving brings it back', () => {
    const W = world();
    const hub = dir('Hub off a team, joiners too', { kind: 'hub' });
    exempt(hub, 'team', W.team);
    const j = agent('joiner');
    expect(ids(app.directives.forAgent(j.id))).toContain(hub.id);
    app.teams.addMember(W.team, { agent_id: j.id, role: 'worker', credential_id: j.cred }, sys);
    expect(ids(app.directives.forAgent(j.id))).not.toContain(hub.id);
    app.teams.removeMember(W.team, j.id, sys);
    expect(ids(app.directives.forAgent(j.id))).toContain(hub.id);
    retire(hub);
  });

  it('the directive screen\'s coverage rows carry each agent\'s live teams and its role there, for the Team filter', () => {
    const W = world();
    const hub = dir('Hub with teams on the agent list', { kind: 'hub' });
    const rows = () => new Map(app.directives.detail(hub.id).coverage.map((c) => [c.agent_id, c.teams]));
    let m = rows();
    expect(m.get(W.c.id)).toEqual([{ id: W.team, name: expect.stringMatching(/^team\d+$/), role: 'coordinator' }]);
    expect(m.get(W.w.id)).toEqual([expect.objectContaining({ id: W.team, role: 'worker' })]);
    expect(m.get(W.p.id)).toEqual([expect.objectContaining({ id: W.apps, role: 'coordinator' })]);
    expect(m.get(W.o.id)).toEqual([]);
    // A member who leaves no longer lists the team.
    app.teams.removeMember(W.team, W.w.id, sys);
    m = rows();
    expect(m.get(W.w.id)).toEqual([]);
    // A retired directive reaches nobody, so there are no rows to carry teams.
    retire(hub);
    expect(app.directives.detail(hub.id).coverage).toEqual([]);
  });

  it('a removed exemption no longer counts, and the earlier ack is back', () => {
    const W = world();
    const hub = dir('Hub applied again', { kind: 'hub' });
    app.directives.read(W.w.id, hub.id, { ack: true });
    const x = exempt(hub, 'agent', W.w.id);
    expect(covered(hub)).not.toContain(W.w.id);
    unexempt(x);
    expect(app.directives.coverage(hub).find((c) => c.agent_id === W.w.id)).toMatchObject({ read: 'current', version: 1 });
    expect(app.directives.summaryFor(W.w.id).find((d) => d.id === hub.id)).toMatchObject({ read: 'current' });
    retire(hub);
  });

  it('notices go only to agents in reach: an edit, a scope change and a retire skip exempted agents', () => {
    const W = world();
    const team = dir('Team rule with notices', { kind: 'team', ref: W.team });
    exempt(team, 'agent', W.w.id);
    const notices = (agentId: string, id: string) => (app.db.prepare("SELECT body FROM agent_notices WHERE agent_id=? AND kind='directive_changed' AND body LIKE ?").all(agentId, `%${id}%`) as { body: string }[]).map((r) => r.body);
    app.directives.update(team.id, { body: 'Changed text.' }, sys);
    expect(notices(W.c.id, team.id).some((b) => b.startsWith('Changed directive'))).toBe(true);
    expect(notices(W.w.id, team.id).some((b) => b.startsWith('Changed directive'))).toBe(false);
    // A scope change: the coordinator leaves its reach and is told once; the exempted worker was never in it.
    app.directives.update(team.id, { scope: { kind: 'agent', ref: W.o.id } }, sys);
    expect(notices(W.c.id, team.id).filter((b) => b.includes('no longer applies to you'))).toHaveLength(1);
    expect(notices(W.w.id, team.id).filter((b) => b.includes('no longer applies to you'))).toHaveLength(0);
    expect(notices(W.o.id, team.id).some((b) => b.startsWith('Directive now applies to you'))).toBe(true);
    const hub = dir('Hub retired with an exemption', { kind: 'hub' });
    exempt(hub, 'team', W.team);
    retire(hub);
    expect(notices(W.c.id, hub.id).filter((b) => b.includes('is retired'))).toHaveLength(0);
    expect(notices(W.o.id, hub.id).filter((b) => b.includes('is retired'))).toHaveLength(1);
    retire(team);
  });

  it('a retired directive reaches nobody, and its exemption rows stay', () => {
    const W = world();
    const hub = dir('Hub retired, rows kept', { kind: 'hub' });
    exempt(hub, 'team', W.team);
    retire(hub);
    const d = app.directives.detail(hub.id);
    expect(app.directives.reach(d.directive)).toEqual([]);
    expect(app.directives.list('retired').find((x) => x.id === hub.id)).toMatchObject({ agents: 0 });
    expect(app.db.prepare('SELECT target_kind, target_ref, removed_at FROM directive_exemptions WHERE directive_id=?').all(hub.id)).toEqual([{ target_kind: 'team', target_ref: W.team, removed_at: null }]);
  });

  it('merging reads reach: an exempted agent is not told about the merge', () => {
    const W = world();
    const a = dir('Merge source A', { kind: 'team', ref: W.team }), b = dir('Merge source B', { kind: 'agent', ref: W.o.id });
    exempt(a, 'agent', W.w.id);
    const m = app.directives.merge([a.id, b.id], { title: 'Merged', body: 'Merged text.', scope: { kind: 'agent', ref: W.o.id } }, sys);
    const told = (agentId: string) => (app.db.prepare("SELECT COUNT(*) n FROM agent_notices WHERE agent_id=? AND body LIKE ?").get(agentId, `%is merged into%${m.id}%`) as { n: number }).n;
    expect(told(W.c.id)).toBe(1);
    expect(told(W.w.id)).toBe(0);
    expect(told(W.o.id)).toBe(1);
    // The coordinator is out of the merged scope: it is told to stop, not to read a directive it cannot see.
    const body = (agentId: string) => (app.db.prepare("SELECT body FROM agent_notices WHERE agent_id=? AND body LIKE ?").get(agentId, `%is merged into%${m.id}%`) as { body: string }).body;
    expect(body(W.c.id)).toContain('which does not apply to you. Stop following it.');
    expect(body(W.c.id)).not.toContain('directives_read');
    expect(body(W.o.id)).toContain(`directives_read {id: "${m.id}", ack: true}`);
    retire(m);
  });

  it('adopting into an existing directive tells only reporters in reach to follow it', () => {
    const W = world();
    const team = dir('Indentation rule', { kind: 'team', ref: W.team });
    exempt(team, 'agent', W.w.id);
    const rc = app.directives.report(W.c.id, { title: 'Tabs not spaces', summary: 'Indent with one tab.' });
    const rw = app.directives.report(W.w.id, { title: 'Tabs not spaces', summary: 'Indent with tabs.' });
    expect([rc.status, rw.status]).toEqual(['open', 'open']);
    const res = app.directives.adopt(rc.id, { directive_id: team.id }, sys);
    expect(res.merged).toBe(1);
    const notices = (agentId: string) => (app.db.prepare("SELECT body FROM agent_notices WHERE agent_id=? AND kind='directive_changed' AND body LIKE ?").all(agentId, `%Tabs not spaces%`) as { body: string }[]).map((r) => r.body);
    expect(notices(W.c.id).some((b) => b.includes(`directives_read {id: "${team.id}", ack: true}`))).toBe(true);
    expect(notices(W.w.id)).toHaveLength(1);
    expect(notices(W.w.id)[0]).not.toContain('directives_read');
    expect(notices(W.w.id)[0]).toContain('does not apply to you');
    retire(team);
  });
});

describe('keep off and apply again: exempt, unexempt and the notices that settle themselves', () => {
  let app: App, root = '';
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'conclave-dex2-'));
    mkdirSync(join(root, 'vault'), { recursive: true });
    app = await buildApp(testConfig(root, { vaultDir: join(root, 'vault'), vaultScanSeconds: undefined, vaultWatch: undefined, maintenanceSeconds: undefined }));
  });
  afterAll(async () => { await app?.close(); rmSync(root, { recursive: true, force: true }); });

  const admin = { kind: 'admin' as const, id: 'adm_test' };
  let n = 0;
  const agent = (label: string, project: string | null = null) => {
    const a = app.keys.createAgent(`${label}${++n}`, project, sys);
    const k = app.keys.createSessionKey({ agentId: a.id, label: `${label} key` }, sys);
    return { id: a.id, cred: k.credential.id as string };
  };
  const world = () => {
    const c = agent('coord'), w = agent('worker'), p = agent('apps'), o = agent('other');
    const team = app.teams.create({ name: `team${n}`, goal: 'reach', members: [{ agent_id: c.id, role: 'coordinator', credential_id: c.cred }, { agent_id: w.id, role: 'worker', credential_id: w.cred }] }, sys);
    // The apps agent is in a project through its team: reach follows live memberships, never a label (docs/directives.md#project-reach).
    const apps = app.teams.create({ name: `apps${n}`, goal: 'apps', members: [{ agent_id: p.id, role: 'coordinator', credential_id: p.cred }] }, sys);
    const prj = app.blueprint.projectOfTeam(apps.id)!;
    return { c, w, p, o, team: team.id, teamName: `team${n}`, apps: apps.id, project: prj.id, projectName: prj.name };
  };
  const dir = (title: string, scope: { kind: 'hub' | 'team' | 'project' | 'agent' | 'role'; ref?: string | null }) =>
    app.directives.create({ title, body: `${title} text.`, scope: { kind: scope.kind, ref: scope.ref ?? null } }, admin);
  const ids = (l: { id: string }[]) => l.map((x) => x.id);
  /** The agent's notices still delivered (not settled), oldest first, with no cursor: what its next tool answer would carry. */
  const live = (agentId: string, about?: string) =>
    (app.db.prepare('SELECT id, body FROM agent_notices WHERE agent_id=? ORDER BY seq').all(agentId) as { id: string; body: string }[])
      .filter((x) => app.keys.noticeCurrent(x.id) && (!about || x.body.includes(about))).map((x) => x.body);
  /** Every notice the agent was sent about this text, settled or not. */
  const sent = (agentId: string, about: string) => (app.db.prepare('SELECT body FROM agent_notices WHERE agent_id=? AND body LIKE ? ORDER BY seq').all(agentId, `%${about}%`) as { body: string }[]).map((x) => x.body);
  const audits = (action: string, id: string) => (app.db.prepare('SELECT details FROM audit_events WHERE action=? AND target_id=? ORDER BY rowid').all(action, id) as { details: string }[]).map((r) => JSON.parse(r.details));
  /** A stop notice settles on a read strictly after it: let the clock move past the notice first. */
  const tick = () => { const t = Date.now(); while (Date.now() <= t) { /* wait one millisecond */ } };
  const retire = (...L: DirectiveRow[]) => { for (const d of L) app.directives.retire(d.id, null, admin); };

  it('6.A1: keeping a hub rule off a team tells each member once to stop, hides it from them, and settles their old notice', () => {
    const W = world();
    const hub = dir('Hub kept off by the operator', { kind: 'hub' });
    // Every agent holds the unacked "New directive" notice.
    for (const a of [W.c, W.w, W.p, W.o]) expect(live(a.id, hub.id)).toEqual([expect.stringContaining('New directive')]);
    const r = app.directives.exempt(hub.id, { kind: 'team', ref: W.team, note: 'Research does not follow this' }, admin);
    expect(r).toMatchObject({ gained: 0, lost: 2, exemption: { target_kind: 'team', target_ref: W.team, note: 'Research does not follow this', label: `team ${W.teamName}`, removed_at: null } });
    expect(r.directive.version).toBe(1); // no new version
    for (const m of [W.c, W.w]) {
      expect(sent(m.id, `${hub.id}) no longer applies to you. Stop following it.`)).toHaveLength(1);
      // Only the stop notice rides along; the old "New directive" one settled without session_ack.
      expect(live(m.id, hub.id)).toEqual([expect.stringContaining('no longer applies to you. Stop following it.')]);
      expect(ids(app.directives.summaryFor(m.id))).not.toContain(hub.id);
      expect(ids(app.directives.read(m.id))).not.toContain(hub.id);
      expect(() => app.directives.read(m.id, hub.id)).toThrow(/No such directive in force for you/);
    }
    for (const a of [W.p, W.o]) {
      expect(sent(a.id, 'no longer applies')).toHaveLength(0);
      expect(live(a.id, hub.id)).toEqual([expect.stringContaining('New directive')]);
    }
    expect(audits('directive.exempt', hub.id)).toEqual([{ target_kind: 'team', target_ref: W.team, note: 'Research does not follow this', gained: 0, lost: 2 }]);
    retire(hub);
  });

  it('6.A10: a stop notice settles on the next directives_read in any form, even one answered not_found', () => {
    const W = world();
    const hub = dir('Hub stop then read', { kind: 'hub' });
    app.directives.exempt(hub.id, { kind: 'agent', ref: W.w.id }, admin);
    expect(live(W.w.id, hub.id)).toHaveLength(1);
    tick();
    expect(() => app.directives.read(W.w.id, hub.id)).toThrow(/not in force|No such directive/);
    expect(live(W.w.id, hub.id)).toEqual([]);
    // Retire: a plain read settles it too.
    const team = dir('Team rule retired', { kind: 'team', ref: W.team });
    app.directives.read(W.c.id, team.id, { ack: true });
    retire(team);
    expect(live(W.c.id, team.id)).toEqual([expect.stringContaining('is retired')]);
    tick();
    app.directives.read(W.c.id, undefined, { unread: true });
    expect(live(W.c.id, team.id)).toEqual([]);
    retire(hub);
  });

  it('6.A2: joining an exempted team drops the rule with one stop notice; leaving brings it back with one notice', () => {
    const W = world();
    const hub = dir('Hub off a team, joiner', { kind: 'hub' });
    app.directives.exempt(hub.id, { kind: 'team', ref: W.team }, admin);
    const j = agent('joiner');
    const before = sent(j.id, hub.id).length;
    app.teams.addMember(W.team, { agent_id: j.id, role: 'worker', credential_id: j.cred }, sys);
    expect(ids(app.directives.summaryFor(j.id))).not.toContain(hub.id);
    expect(sent(j.id, hub.id).slice(before)).toEqual([expect.stringContaining('no longer applies to you. Stop following it.')]);
    app.teams.removeMember(W.team, j.id, sys);
    expect(ids(app.directives.summaryFor(j.id))).toContain(hub.id);
    expect(sent(j.id, hub.id).slice(before + 1)).toEqual([expect.stringContaining('Directive now applies to you:')]);
    retire(hub);
  });

  it('6.A3: applying it again tells the members once, and their earlier acks read as current or outdated by version', () => {
    const W = world();
    const hub = dir('Hub applied again by version', { kind: 'hub' });
    app.directives.read(W.c.id, hub.id, { ack: true });
    app.directives.read(W.w.id, hub.id, { ack: true });
    const x = app.directives.exempt(hub.id, { kind: 'agent', ref: W.w.id }, admin).exemption;
    const y = app.directives.exempt(hub.id, { kind: 'agent', ref: W.c.id }, admin).exemption;
    // While kept off the worker, the text changes: the worker is not told.
    app.directives.update(hub.id, { body: 'Hub text v2.' }, admin);
    expect(sent(W.w.id, 'Changed directive')).toHaveLength(0);
    app.directives.unexempt(hub.id, y.id, admin); // the coordinator gets it back first (v2 unread: its ack is v1)
    expect(app.directives.unexempt(hub.id, x.id, admin)).toMatchObject({ gained: 1 });
    expect(sent(W.w.id, `Directive now applies to you: "Hub applied again by version" (${hub.id}, v2`)).toHaveLength(1);
    expect(app.directives.summaryFor(W.w.id).find((d) => d.id === hub.id)).toMatchObject({ read: 'outdated', version: 2 });
    app.directives.read(W.w.id, hub.id, { ack: true });
    expect(live(W.w.id, hub.id).filter((b) => b.includes('now applies'))).toEqual([]);
    expect(app.db.prepare('SELECT removed_by, removed_at IS NOT NULL gone FROM directive_exemptions WHERE id=?').get(x.id)).toEqual({ removed_by: admin.id, gone: 1 });
    expect(audits('directive.unexempt', hub.id).map((d) => d.gained)).toEqual([1, 1]);
    expect(() => app.directives.unexempt(hub.id, x.id, admin)).toThrow(/No such exemption/);
    retire(hub);
  });

  it('6.A4: a project exemption leaves its agents out of coverage, counts in exempt_count and reads in reach_label', () => {
    const W = world();
    const hub = dir('Hub off a project', { kind: 'hub' });
    // A console user adds it, so the directive screen can say who.
    app.db.prepare('INSERT OR IGNORE INTO admin_users(id,username,password_hash,created_at,display_name) VALUES (?,?,?,?,?)').run('adm_named', 'named', 'x', Date.now(), 'Ben');
    const named = { kind: 'admin' as const, id: 'adm_named' };
    app.directives.exempt(hub.id, { kind: 'project', ref: W.project, note: 'apps have their own' }, named);
    const d = app.directives.detail(hub.id);
    expect(d.coverage.map((c) => c.agent_id)).not.toContain(W.p.id);
    expect(d.coverage.map((c) => c.agent_id)).toContain(W.o.id);
    expect(d).toMatchObject({ exempt_count: 1, exemptions_removed: [], directive: { reach_label: `All agents except project ${W.projectName}`, except_label: `Except project ${W.projectName}` } });
    expect(d.exemptions).toEqual([expect.objectContaining({ target_kind: 'project', target_ref: W.project, label: `project ${W.projectName}`, note: 'apps have their own', created_by: named.id })]);
    // The directive screen: who added it (the console user's display name) and how many agents the scope covers but it is kept off.
    expect(d.exemptions[0]).toMatchObject({ created_by_label: 'Ben', removed_by_label: null });
    expect(d.kept_off).toBe(1);
    expect(app.directives.list('active').find((x) => x.id === hub.id)).toMatchObject({ reach_label: `All agents except project ${W.projectName}`, except_label: `Except project ${W.projectName}`, exempt_count: 1, scope_label: 'all agents' });
    // An actor with no console user row reads as no label.
    const anon = app.directives.exempt(hub.id, { kind: 'agent', ref: W.o.id }, admin).exemption;
    expect(app.directives.detail(hub.id).exemptions.find((e) => e.id === anon.id)).toMatchObject({ created_by_label: null });
    // Applying it again names who lifted it, under exemptions_removed.
    app.directives.unexempt(hub.id, anon.id, named);
    expect(app.directives.detail(hub.id).exemptions_removed).toEqual([expect.objectContaining({ id: anon.id, created_by_label: null, removed_by: named.id, removed_by_label: 'Ben' })]);
    // Two targets read as a list; without exemptions it is the scope.
    app.directives.exempt(hub.id, { kind: 'team', ref: W.team }, admin);
    expect(app.directives.detail(hub.id).directive).toMatchObject({ reach_label: `All agents except project ${W.projectName} and team ${W.teamName}`, except_label: `Except project ${W.projectName} and team ${W.teamName}` });
    const plain = dir('Hub with no exemption', { kind: 'hub' });
    expect(app.directives.list('active').find((x) => x.id === plain.id)).toMatchObject({ reach_label: 'All agents', except_label: '', exempt_count: 0 });
    retire(plain);
    // The agent page says why the rule is missing.
    expect(app.directives.agentView(W.p.id).exempted).toEqual([expect.objectContaining({ id: hub.id, scope_label: 'all agents', exemption: expect.objectContaining({ kind: 'project', label: `project ${W.projectName}` }) })]);
    expect(app.directives.agentView(W.o.id).exempted).toEqual([]);
    retire(hub);
  });

  it('6.A5: a team rule kept off one member tells only that member, and coverage counts the others', () => {
    const W = world();
    const team = dir('Team rule minus the worker', { kind: 'team', ref: W.team });
    app.directives.read(W.c.id, team.id, { ack: true });
    expect(app.directives.exempt(team.id, { kind: 'agent', ref: W.w.id }, admin)).toMatchObject({ lost: 1, gained: 0 });
    expect(sent(W.w.id, 'no longer applies')).toHaveLength(1);
    expect(sent(W.c.id, 'no longer applies')).toHaveLength(0);
    expect(app.directives.list('active').find((x) => x.id === team.id)).toMatchObject({ agents: 1, current: 1, reach_label: `Team ${W.teamName} except agent ${app.keys.agent(W.w.id)!.label}` });
    retire(team);
  });

  it('6.A6: refuses an agent-scoped directive, its own scope target, an unknown target, a repeat, and a retired directive', () => {
    const W = world();
    const own = dir('Own agent rule', { kind: 'agent', ref: W.o.id }), team = dir('Team rule refusals', { kind: 'team', ref: W.team }), prj = dir('Project rule refusals', { kind: 'project', ref: W.project });
    const code = (f: () => unknown) => { try { f(); return 'ok'; } catch (e) { return (e as { code: string }).code; } };
    expect(code(() => app.directives.exempt(own.id, { kind: 'agent', ref: W.o.id }, admin))).toBe('invalid_argument');
    expect(code(() => app.directives.exempt(own.id, { kind: 'team', ref: W.team }, admin))).toBe('invalid_argument');
    expect(code(() => app.directives.exempt(team.id, { kind: 'team', ref: W.team }, admin))).toBe('invalid_argument');
    expect(code(() => app.directives.exempt(prj.id, { kind: 'project', ref: W.project }, admin))).toBe('invalid_argument');
    expect(code(() => app.directives.exempt(team.id, { kind: 'team', ref: 'tm_nope' }, admin))).toBe('invalid_argument');
    expect(code(() => app.directives.exempt(team.id, { kind: 'agent', ref: 'ag_nope' }, admin))).toBe('invalid_argument');
    expect(code(() => app.directives.exempt(team.id, { kind: 'project', ref: ' ' }, admin))).toBe('invalid_argument');
    // A target outside the scope would change nothing: no agent the scope covers is in it.
    expect(code(() => app.directives.exempt(team.id, { kind: 'agent', ref: W.o.id }, admin))).toBe('invalid_argument');
    expect(code(() => app.directives.exempt(team.id, { kind: 'project', ref: W.project }, admin))).toBe('invalid_argument');
    expect(code(() => app.directives.exempt(prj.id, { kind: 'agent', ref: W.o.id }, admin))).toBe('invalid_argument');
    expect(code(() => app.directives.exempt(prj.id, { kind: 'team', ref: W.team }, admin))).toBe('invalid_argument');
    expect(code(() => app.directives.exempt(prj.id, { kind: 'project', ref: 'ELSEWHERE' }, admin))).toBe('invalid_argument');
    expect(app.directives.detail(team.id).directive.reach_label).toBe(`Team ${W.teamName}`);
    expect(code(() => app.directives.exempt(team.id, { kind: 'agent', ref: W.w.id }, admin))).toBe('ok');
    expect(code(() => app.directives.exempt(team.id, { kind: 'agent', ref: W.w.id }, admin))).toBe('conflict');
    retire(own, team, prj);
    expect(code(() => app.directives.exempt(team.id, { kind: 'agent', ref: W.c.id }, admin))).toBe('invalid_state');
    expect(app.db.prepare('SELECT COUNT(*) n FROM directive_exemptions WHERE directive_id IN (?,?,?)').get(own.id, team.id, prj.id)).toEqual({ n: 1 });
  });

  it('an exemption, its notices and its audit row land together: a failure part-way leaves none of them', () => {
    const W = world();
    const hub = dir('Hub exempt rolls back', { kind: 'hub' });
    const real = app.audit.event.bind(app.audit);
    app.audit.event = ((...a: Parameters<typeof real>) => { if (a[1] === 'directive.exempt' || a[1] === 'directive.unexempt') throw new Error('audit down'); return real(...a); }) as typeof real;
    try {
      expect(() => app.directives.exempt(hub.id, { kind: 'agent', ref: W.w.id }, admin)).toThrow('audit down');
    } finally { app.audit.event = real; }
    expect(app.db.prepare('SELECT COUNT(*) n FROM directive_exemptions WHERE directive_id=?').get(hub.id)).toEqual({ n: 0 });
    expect(sent(W.w.id, 'no longer applies')).toHaveLength(0);
    expect(ids(app.directives.summaryFor(W.w.id))).toContain(hub.id);
    // And applying it again rolls back the same way: the exemption stays in force, nobody is told.
    const x = app.directives.exempt(hub.id, { kind: 'agent', ref: W.w.id }, admin).exemption;
    app.audit.event = ((...a: Parameters<typeof real>) => { if (a[1] === 'directive.unexempt') throw new Error('audit down'); return real(...a); }) as typeof real;
    try {
      expect(() => app.directives.unexempt(hub.id, x.id, admin)).toThrow('audit down');
    } finally { app.audit.event = real; }
    expect(app.db.prepare('SELECT removed_at FROM directive_exemptions WHERE id=?').get(x.id)).toEqual({ removed_at: null });
    expect(sent(W.w.id, 'now applies')).toHaveLength(0);
    retire(hub);
  });

  it('6.A7: retire and merge leave exemption rows as history; reach is empty and the directive screen still lists them', () => {
    const W = world();
    const hub = dir('Hub retired with history', { kind: 'hub' });
    const x = app.directives.exempt(hub.id, { kind: 'team', ref: W.team }, admin).exemption;
    const row = () => app.db.prepare('SELECT * FROM directive_exemptions WHERE id=?').get(x.id);
    const was = row();
    retire(hub);
    expect(row()).toEqual(was);
    const d = app.directives.detail(hub.id);
    expect(app.directives.reach(d.directive)).toEqual([]);
    expect(d.exemptions.map((e) => e.id)).toEqual([x.id]);
    expect(() => app.directives.unexempt(hub.id, x.id, admin)).toThrow(/history/);
    // Merge: the sources retire, their exemptions stay.
    const a = dir('Merge source with exemption', { kind: 'team', ref: W.team }), b = dir('Other merge source', { kind: 'agent', ref: W.o.id });
    const y = app.directives.exempt(a.id, { kind: 'agent', ref: W.w.id }, admin).exemption;
    const m = app.directives.merge([a.id, b.id], { title: 'Merged with history', body: 'Merged.', scope: { kind: 'team', ref: W.team } }, admin);
    expect(app.db.prepare('SELECT removed_at FROM directive_exemptions WHERE id=?').get(y.id)).toEqual({ removed_at: null });
    expect(app.directives.detail(a.id)).toMatchObject({ coverage: [], exemptions: [expect.objectContaining({ id: y.id })] });
    retire(m);
  });

  it('a directive notice settles once its version or a later one is confirmed, for that agent only; a new version notifies again', () => {
    const W = world();
    const cite = dir('Cite sources', { kind: 'team', ref: W.team }), short = dir('Short replies', { kind: 'team', ref: W.team });
    expect(app.db.prepare('SELECT ref_kind, ref_id, ref_state FROM agent_notices WHERE agent_id=? AND body LIKE ?').get(W.c.id, '%"Cite sources"%'))
      .toEqual({ ref_kind: 'directive', ref_id: cite.id, ref_state: '1' });
    app.directives.read(W.c.id, cite.id, { ack: true });
    expect(live(W.c.id, cite.id)).toEqual([]);
    expect(live(W.c.id, short.id)).toHaveLength(1);
    expect(live(W.w.id, cite.id)).toHaveLength(1); // the other member still has it
    app.directives.update(cite.id, { body: 'Cite the vault note and the line.' }, admin);
    expect(live(W.c.id, cite.id)).toEqual([expect.stringMatching(/^Changed directive: "Cite sources" \(dir_\w+, v2/)]);
    expect(live(W.w.id, cite.id)).toHaveLength(2); // v1 and v2, both until it confirms v2
    app.directives.read(W.w.id, undefined, { ack: true });
    expect(live(W.w.id, cite.id)).toEqual([]);
    expect(live(W.w.id, short.id)).toEqual([]);
    retire(cite, short);
  });

  it('one-click adopt with no text uses the report summary when the agent sent no full text', () => {
    const W = world();
    const rep = app.directives.report(W.w.id, { title: 'Summary only rule', summary: 'Say agent, not a product name.' });
    const d = app.directives.adopt(rep.id, {}, admin).directive;
    expect(d.body).toBe('Say agent, not a product name.');
    retire(d);
  });
  it('merge and adopt notices settle when the agent confirms the directive they point to', () => {
    const W = world();
    const a = dir('Merge settle A', { kind: 'agent', ref: W.c.id }), b = dir('Merge settle B', { kind: 'agent', ref: W.c.id });
    const m = app.directives.merge([a.id, b.id], { title: 'Merge settle', body: 'One rule.', scope: { kind: 'agent', ref: W.c.id } }, admin);
    expect(live(W.c.id, 'is merged into')).toHaveLength(2);
    app.directives.read(W.c.id, m.id, { ack: true });
    expect(live(W.c.id, 'is merged into')).toEqual([]);
    expect(live(W.c.id, m.id)).toEqual([]);
    const rep = app.directives.report(W.w.id, { title: 'Settle on adopt', summary: 'A rule.' });
    const t = app.directives.adopt(rep.id, { body: 'Adopted text.' }, admin).directive;
    expect(live(W.w.id, 'Settle on adopt').some((x) => x.includes('which you reported following'))).toBe(true);
    app.directives.read(W.w.id, t.id, { ack: true });
    expect(live(W.w.id, 'Settle on adopt')).toEqual([]);
    retire(m, t);
  });

  it('the settler\'s SQL (reachSql) agrees with applies() for every scope and exemption kind', () => {
    const W = world();
    const L = [dir('Agree hub', { kind: 'hub' }), dir('Agree team', { kind: 'team', ref: W.team }), dir('Agree role', { kind: 'role', ref: `${W.team}|worker` }),
      dir('Agree project', { kind: 'project', ref: W.project }), dir('Agree agent', { kind: 'agent', ref: W.o.id })];
    app.directives.exempt(L[0]!.id, { kind: 'team', ref: W.team }, admin);
    app.directives.exempt(L[0]!.id, { kind: 'project', ref: W.project }, admin);
    app.directives.exempt(L[1]!.id, { kind: 'agent', ref: W.w.id }, admin);
    app.teams.addMember(W.apps, { agent_id: W.w.id, role: 'worker', credential_id: W.w.cred }, sys); // a team member in the project too: keeping the project rule off the team takes it off them
    app.directives.exempt(L[3]!.id, { kind: 'team', ref: W.team }, admin);
    const sql = app.db.prepare(`SELECT 1 FROM directives d JOIN agents ag ON ag.id=? WHERE d.id=? AND ${inForceSql('d', 'ag')}`);
    for (const d of L) for (const a of [W.c, W.w, W.p, W.o]) {
      const ag = app.keys.agent(a.id)!, row = app.directives.detail(d.id).directive;
      expect([d.title, ag.label, !!sql.get(a.id, d.id)]).toEqual([d.title, ag.label, app.directives.applies(row, ag)]);
    }
    retire(...L);
  });
});

/**
 * A hub at 0105, then upgraded with every migration. `extra` are later migrations it already recorded: the live hub ran
 * 0111 (D90) before 0106 existed, so there 0106 applies out of order (6.A14).
 */
const migration0106 = (name: string, extra: number[]) => describe(name, () => {
  const root = mkdtempSync(join(tmpdir(), 'conclave-0106-'));
  const UPTO_0105 = join(root, 'migrations');
  mkdirSync(UPTO_0105);
  for (const f of readdirSync(MIGRATIONS)) {
    const v = Number(f.slice(0, 4));
    if (/^\d{4}_.+\.sql$/.test(f) && (v <= 105 || extra.includes(v))) copyFileSync(join(MIGRATIONS, f), join(UPTO_0105, f));
  }
  let app: App;
  const T = 'tm_old', POL = 'pol_old';
  beforeAll(async () => {
    mkdirSync(join(root, 'vault'), { recursive: true }); mkdirSync(join(root, 'data'), { recursive: true });
    const config = testConfig(root, { vaultDir: join(root, 'vault'), vaultScanSeconds: undefined, vaultWatch: undefined, maintenanceSeconds: undefined });
    // A hub at 0105: four agents (one archived), a running team, directives of every scope, acks and notices.
    const db = new DatabaseSync(config.dbFile);
    migrate(db, UPTO_0105);
    expect((db.prepare('SELECT max(version) AS v FROM schema_migrations').get() as { v: number }).v).toBe(Math.max(105, ...extra));
    expect(db.prepare('SELECT 1 FROM schema_migrations WHERE version=106').get()).toBeUndefined();
    const now = Date.now();
    const ag = db.prepare("INSERT INTO agents(id,label,project,status,created_at) VALUES (?,?,?,?,?)");
    ag.run('ag_c', 'coord', null, 'active', now); ag.run('ag_w', 'worker', 'APPS', 'active', now); ag.run('ag_o', 'other', null, 'active', now); ag.run('ag_x', 'gone', null, 'archived', now);
    const pol = db.prepare("INSERT INTO permission_policies(id,kind,created_at,updated_at) VALUES (?,'credential',?,?)");
    pol.run(`${POL}c`, now, now); pol.run(`${POL}w`, now, now);
    const cred = db.prepare("INSERT INTO credentials(id,kind,agent_id,label,key_id,verifier,status,policy_id,created_at) VALUES (?,'session_key',?,?,?,?,'active',?,?)");
    cred.run('crd_c', 'ag_c', 'c', 'kidc', '00', `${POL}c`, now); cred.run('crd_w', 'ag_w', 'w', 'kidw', '00', `${POL}w`, now);
    // The team is in project APPS (key): migration 0117 maps the project rule's label to it, so the rule reaches its members.
    db.prepare("INSERT INTO projects(id,key,name,kind,created_by_kind,created_at,updated_at) VALUES ('prj_apps','APPS','Apps','implementation','system',?,?)").run(now, now);
    db.prepare("INSERT INTO teams(id,name,goal,status,created_at,updated_at,project_id) VALUES (?,?,?,'running',?,?,'prj_apps')").run(T, 'Old team', 'goal', now, now);
    const mem = db.prepare('INSERT INTO team_members(team_id,agent_id,credential_id,role,joined_at) VALUES (?,?,?,?,?)');
    mem.run(T, 'ag_c', 'crd_c', 'coordinator', now); mem.run(T, 'ag_w', 'crd_w', 'worker', now);
    const d = db.prepare("INSERT INTO directives(id,title,body,scope_kind,scope_ref,version,status,created_at,updated_at,tags) VALUES (?,?,?,?,?,?,?,?,?,'[]')");
    d.run('dir_hub', 'Hub', 'h', 'hub', null, 1, 'active', now, now);
    d.run('dir_team', 'Team', 't', 'team', T, 2, 'active', now + 1, now);
    d.run('dir_role', 'Role', 'r', 'role', `${T}|worker`, 1, 'active', now + 2, now);
    d.run('dir_prj', 'Project', 'p', 'project', 'APPS', 1, 'active', now + 3, now);
    d.run('dir_agent', 'Agent', 'a', 'agent', 'ag_o', 1, 'active', now + 4, now);
    d.run('dir_old', 'Retired', 'x', 'hub', null, 1, 'retired', now + 5, now);
    const ack = db.prepare('INSERT INTO directive_acks(directive_id,agent_id,version,acked_at) VALUES (?,?,?,?)');
    ack.run('dir_hub', 'ag_c', 1, now); ack.run('dir_team', 'ag_w', 1, now); ack.run('dir_team', 'ag_c', 2, now);
    const ntc = db.prepare('INSERT INTO agent_notices(id,agent_id,seq,kind,body,created_at,ref_task_id,ref_state,ref_feedback_id) VALUES (?,?,?,?,?,?,?,?,?)');
    ntc.run('ntc_task', 'ag_w', 1, 'task_assigned', 'task', now, 'tsk_x', 'assigned', null);
    ntc.run('ntc_fb', 'ag_w', 2, 'feedback', 'fb', now, null, '3', 'fb_x');
    ntc.run('ntc_dir', 'ag_w', 3, 'directive_changed', 'New directive', now, null, null, null);
    db.close();
    app = await buildApp(config);
  });
  afterAll(async () => { await app?.close(); rmSync(root, { recursive: true, force: true }); });

  it('runs unattended and adds the exemption table, the notice refs and directive_reads', () => {
    const v = (app.db.prepare('SELECT version FROM schema_migrations WHERE version > 105 ORDER BY version').all() as { version: number }[]).map((r) => r.version);
    expect(v).toContain(106);
    const cols = (t: string) => (app.db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols('directive_exemptions')).toEqual(['id', 'directive_id', 'target_kind', 'target_ref', 'note', 'created_by', 'created_at', 'removed_by', 'removed_at']);
    expect(cols('directive_reads')).toEqual(['agent_id', 'read_at']);
    expect(cols('agent_notices')).toEqual(expect.arrayContaining(['ref_kind', 'ref_id', 'ref_task_id', 'ref_feedback_id', 'ref_state']));
    expect(app.db.prepare('SELECT COUNT(*) n FROM directive_exemptions').get()).toEqual({ n: 0 });
    // One active exemption per target; a removed one may be made again.
    const ins = app.db.prepare("INSERT INTO directive_exemptions(id,directive_id,target_kind,target_ref,created_at,removed_at) VALUES (?,?,?,?,?,?)");
    ins.run('dex_1', 'dir_hub', 'team', T, 1, 2);
    ins.run('dex_2', 'dir_hub', 'team', T, 3, null);
    expect(() => ins.run('dex_3', 'dir_hub', 'team', T, 4, null)).toThrow(/UNIQUE/);
    expect(() => ins.run('dex_4', 'dir_hub', 'role', 'x', 4, null)).toThrow(/CHECK/);
    app.db.prepare('DELETE FROM directive_exemptions').run();
  });

  it('backfills ref_kind and ref_id for task and feedback notices only', () => {
    expect(app.db.prepare('SELECT id, ref_kind, ref_id, ref_task_id, ref_feedback_id, ref_state FROM agent_notices ORDER BY seq').all()).toEqual([
      { id: 'ntc_task', ref_kind: 'task', ref_id: 'tsk_x', ref_task_id: 'tsk_x', ref_feedback_id: null, ref_state: 'assigned' },
      { id: 'ntc_fb', ref_kind: 'feedback', ref_id: 'fb_x', ref_task_id: null, ref_feedback_id: 'fb_x', ref_state: '3' },
      { id: 'ntc_dir', ref_kind: null, ref_id: null, ref_task_id: null, ref_feedback_id: null, ref_state: null },
    ]);
    // New notices write both shapes.
    app.keys.notify('ag_o', 'task_assigned', 'x', { task: 'tsk_y', state: 'open' });
    app.keys.notify('ag_o', 'feedback', 'y', { feedback: 'fb_y', rev: 4 });
    app.keys.notify('ag_o', 'other', 'z');
    expect(app.db.prepare("SELECT ref_kind, ref_id, ref_task_id, ref_feedback_id, ref_state FROM agent_notices WHERE agent_id='ag_o' ORDER BY seq").all()).toEqual([
      { ref_kind: 'task', ref_id: 'tsk_y', ref_task_id: 'tsk_y', ref_feedback_id: null, ref_state: 'open' },
      { ref_kind: 'feedback', ref_id: 'fb_y', ref_task_id: null, ref_feedback_id: 'fb_y', ref_state: '4' },
      { ref_kind: null, ref_id: null, ref_task_id: null, ref_feedback_id: null, ref_state: null },
    ]);
  });

  it('settles legacy-shaped notices (old columns, no ref_kind) by the old columns, as after a rollback and upgrade', () => {
    const now = Date.now();
    app.db.prepare("INSERT INTO tasks(id,team_id,title,status,created_at,updated_at) VALUES ('tsk_leg',?,'Legacy','assigned',?,?)").run(T, now, now);
    const ins = app.db.prepare('INSERT INTO agent_notices(id,agent_id,seq,kind,body,created_at,ref_task_id,ref_state,ref_feedback_id) VALUES (?,?,?,?,?,?,?,?,?)');
    ins.run('ntc_leg_task', 'ag_c', 101, 'task_assigned', 'task', now, 'tsk_leg', 'assigned', null);
    ins.run('ntc_leg_gone', 'ag_c', 102, 'task_assigned', 'task', now, 'tsk_none', 'assigned', null);
    ins.run('ntc_leg_fb', 'ag_c', 103, 'feedback', 'fb', now, null, '3', 'fb_none');
    ins.run('ntc_leg_plain', 'ag_c', 104, 'other', 'plain', now, null, null, null);
    expect(app.db.prepare("SELECT COUNT(*) n FROM agent_notices WHERE id LIKE 'ntc_leg_%' AND ref_kind IS NULL").get()).toEqual({ n: 4 });
    const cur = (id: string) => app.keys.noticeCurrent(id);
    expect([cur('ntc_leg_task'), cur('ntc_leg_gone'), cur('ntc_leg_fb'), cur('ntc_leg_plain')]).toEqual([true, false, false, true]);
    app.db.prepare("UPDATE tasks SET status='done' WHERE id='tsk_leg'").run();
    expect(cur('ntc_leg_task')).toBe(false);
    app.db.prepare("DELETE FROM agent_notices WHERE id LIKE 'ntc_leg_%'").run();
    app.db.prepare("DELETE FROM tasks WHERE id='tsk_leg'").run();
  });

  it('leaves every agent\'s directive list and every coverage count as it was, the project rule now reaching the project\'s team (0117)', () => {
    const l = (a: string) => app.directives.summaryFor(a).map((d) => [d.id, d.read]);
    expect(l('ag_c')).toEqual([['dir_team', 'current'], ['dir_prj', 'unread'], ['dir_hub', 'current']]);
    expect(l('ag_w')).toEqual([['dir_role', 'unread'], ['dir_team', 'outdated'], ['dir_prj', 'unread'], ['dir_hub', 'unread']]);
    expect(l('ag_o')).toEqual([['dir_agent', 'unread'], ['dir_hub', 'unread']]);
    expect(l('ag_x')).toEqual([]);
    const counts = Object.fromEntries(app.directives.list('active').map((d) => [d.id, [d.agents, d.current, d.outdated, d.unread]]));
    expect(counts).toEqual({ dir_hub: [3, 1, 0, 2], dir_team: [2, 1, 1, 0], dir_role: [1, 0, 0, 1], dir_prj: [2, 0, 0, 2], dir_agent: [1, 0, 0, 1] });
    const tv = app.directives.teamView(T);
    expect(tv).toMatchObject({ count: 3, behind: 4, hub: 1, hub_behind: 1 });
  });
});
migration0106('migration 0106', []);
migration0106('migration 0106 after 0111 (the live hub)', [111]);
