/**
 * Needs you and For awareness (docs/dashboard-ux.md "Attention words", docs/multi-user.md §4): one server-side list per
 * viewer, filtered entrances that agree, totals counted before paging, actions that recheck version and decider through
 * the source workflow, and dismissals keyed by viewer, record and episode.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import type { Who } from '../src/teams/teams.js';
import type { Op } from '../src/blueprint/blueprint.js';
import { testConfig, adminLogin, ADMIN_PASSWORD } from './hub.js';
import { NeedsYou, sourceReply } from '../src/admin/needsYou.js';
import { hubShortSummary } from '../src/teams/shortSummary.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base = '';
type S = { cookie: string; csrf: string };
let admin: S, dana: S, dana2: S, eve: S;
const PW = 'needs you test password 1234';
const call = async (who: S, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie: who.cookie, 'x-csrf-token': who.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, body: (() => { try { return JSON.parse(text); } catch { return null; } })() as any };
};
const login = (username: string): Promise<S> => adminLogin(base, username, username === 'admin' ? ADMIN_PASSWORD : PW);
type A = { id: string; cred: string };
const mk = (label: string): A => {
  const a = app.keys.createAgent(label, null, sys);
  const k = app.keys.createSessionKey({ agentId: a.id, label: `${label} key` }, sys);
  app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }], 'test', sys);
  return { id: a.id, cred: k.credential.id };
};
const who = (a: A): Who => ({ agentId: a.id, credId: a.cred, tokenHash: `th_${a.id}`, rules: app.keys.rulesFor(a.cred), cap: [] });
const ver = (p: string) => app.blueprint.project(p)!.version;
const propose = (ops: Op[], agent: A, teamId: string, p: string) => {
  const r = app.blueprint.submit(p, { version: ver(p), ops, reason: 'test', team_id: teamId }, agent.id);
  if (r.status !== 'proposed') throw new Error('expected a proposal');
  return r.proposal.id;
};
const needs = async (s: S, q = '') => (await call(s, 'GET', `/needs-you${q}`)).body;
const ids = (b: any) => b.items.map((i: any) => i.id);

let cnv = '', brz = '', one = '', two = '', other = '', coord: A, worker: A, coord2: A, danaId = '';
const team = (project: string, name: string, members: A[]) => {
  const t = app.teams.create({ name, goal: `${name} goal`, members: members.map((m, i) => ({ agent_id: m.id, role: i ? 'worker' : 'coordinator' })) }, sys);
  app.teams.start(t.id, sys);
  app.db.prepare('UPDATE teams SET project_id=? WHERE id=?').run(project, t.id);
  return t.id;
};
const blockedTask = (teamId: string, title: string) => {
  const t = app.teams.create_task(who(teamId === one ? coord : coord2), { team_id: teamId, title, description: 'd' });
  app.db.prepare("UPDATE tasks SET status='blocked', blocked_from='open', blocked_reason='waits for a call', version=version+1 WHERE id=?").run(t.id);
  return t.id;
};

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahneeds-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  const config: Config = testConfig(dir);
  app = await buildApp(config);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  admin = await login('admin');
  cnv = (await call(admin, 'POST', '/projects', { key: 'CNV', name: 'Conclave' })).body.project.id;
  brz = (await call(admin, 'POST', '/projects', { key: 'BRZ', name: 'Echo' })).body.project.id;
  coord = mk('cnv-coord'); worker = mk('cnv-worker'); coord2 = mk('cnv2-coord');
  one = team(cnv, 'CNV One', [coord, worker]); two = team(cnv, 'CNV Two', [coord2]); other = team(brz, 'BRZ One', [mk('brz-coord')]);
  expect((await call(admin, 'POST', `/projects/${cnv}/ops`, { version: ver(cnv), ops: [
    { op: 'upsert', kind: 'module', key: 'ONE', title: 'Team one module', team_id: one },
    { op: 'upsert', kind: 'fr', key: 'FR-ONE-01', parent_key: 'ONE', title: 'First requirement' },
    { op: 'upsert', kind: 'fr', key: 'FR-ONE-02', parent_key: 'ONE', title: 'Second requirement' },
    { op: 'upsert', kind: 'milestone', key: 'M1', title: 'First release', team_id: one, fields: { target_at: Date.parse('2026-03-03') } },
  ] })).status).toBe(200);
  const mkUser = async (username: string) => {
    const c = await call(admin, 'POST', '/users', { username });
    const first = await adminLogin(base, username, c.body.password);
    expect((await call(first, 'POST', '/me/password', { current: c.body.password, new: PW })).status).toBe(200);
    expect((await call(admin, 'PUT', `/users/${c.body.user.id}/grants`, { grants: [{ project_id: cnv, components: ['tasks', 'blueprint'] }] })).status).toBe(200);
    return c.body.user.id as string;
  };
  danaId = await mkUser('dana'); await mkUser('eve');
  expect((await call(admin, 'PUT', `/teams/${one}/deciders`, { user_ids: [danaId] })).status).toBe(200);
  dana = await login('dana'); dana2 = await login('dana'); eve = await login('eve');
});
afterAll(async () => { await app?.close(); });

describe('Needs you: one list per viewer', () => {
  it('routes each decision to the person who may make it, and never lists the agent\'s or the reviewer\'s turn', async () => {
    const q = app.decisions.ask(who(coord), { team_id: one, question: 'Ship it?' }).id;
    const qTwo = app.decisions.ask(who(coord2), { team_id: two, question: 'Theirs?' }).id;
    const waiting = app.decisions.ask(who(coord), { team_id: one, question: 'Waiting for the agent?' }).id;
    app.db.prepare("UPDATE decisions SET status='needs_info' WHERE id=?").run(waiting);
    const review = app.teams.create_task(who(coord), { team_id: one, title: 'In review', description: 'd' }).id;
    app.db.prepare("UPDATE tasks SET status='in_review' WHERE id=?").run(review);
    const d = await needs(dana), a = await needs(admin);
    expect(ids(d)).toContain(`question:${q}`);
    expect(ids(d)).not.toContain(`question:${qTwo}`); // team two has no decider: the admin's
    expect(ids(a)).toContain(`question:${qTwo}`);
    expect(ids(a)).not.toContain(`question:${q}`); // routed to Dana, not escalated
    for (const b of [d, a]) expect(ids(b).filter((x: string) => x === `question:${waiting}` || x === `task:${review}` || x === `backlog:${review}`)).toEqual([]);
    expect(await needs(eve)).toMatchObject({ items: [], total: 0 });
    const row = d.items.find((i: any) => i.id === `question:${q}`);
    expect(row).toMatchObject({ kind: 'question', source: { kind: 'decision', id: q }, scope: { project_id: cnv, team_id: one }, actions: [{ id: 'answer', input: true }] });
    // A member never sees the admin's own queues.
    expect(d.items.every((i: any) => ['question', 'relayed_answer', 'access_request', 'checkpoint', 'unblock', 'proposal'].includes(i.kind))).toBe(true);
  });

  it('Home, team, project and Blueprint Review are filtered entrances to the same list, counted before paging', async () => {
    blockedTask(one, 'Blocked in one'); blockedTask(two, 'Blocked in two');
    propose([{ op: 'upsert', kind: 'fr', key: 'FR-ONE-02', status: 'agreed' }], coord, one, cnv);
    for (const s of [dana, admin]) {
      const all = await needs(s);
      expect(all.total).toBe(all.items.length);
      const t = await needs(s, `?team=${one}`), p = await needs(s, `?project=${cnv}`), r = await needs(s, `?project=${cnv}&review=1`);
      expect(ids(t)).toEqual(all.items.filter((i: any) => i.scope.team_id === one).map((i: any) => i.id));
      expect(ids(p)).toEqual(all.items.filter((i: any) => i.scope.project_id === cnv).map((i: any) => i.id));
      expect(ids(r)).toEqual(all.items.filter((i: any) => i.scope.project_id === cnv && ['proposal', 'unclear'].includes(i.kind)).map((i: any) => i.id));
      expect([t.total, p.total, r.total]).toEqual([t.items.length, p.items.length, r.items.length]);
    }
    expect((await needs(dana, `?project=${cnv}&review=1`)).items.map((i: any) => i.kind)).toEqual(['proposal']);
    // Paging keeps the total of the whole filtered list.
    const all = await needs(admin);
    expect(all.total).toBeGreaterThan(1);
    const p1 = await needs(admin, '?limit=1'), p2 = await needs(admin, `?limit=1&cursor=${p1.next_cursor}`);
    expect([p1.total, p2.total, p1.items.length, p1.next_cursor]).toEqual([all.total, all.total, 1, '1']);
    expect([...ids(p1), ...ids(p2)]).toEqual(ids(all).slice(0, 2));
    expect((await call(admin, 'GET', '/needs-you?bogus=1')).status).toBe(400);
  });

  it('resolves an entry once: the second tab gets a conflict and both see the count drop', async () => {
    const pid = propose([{ op: 'upsert', kind: 'fr', key: 'FR-ONE-01', status: 'agreed' }], coord, one, cnv);
    const id = `proposal:${pid}`;
    const t1 = await needs(dana), t2 = await needs(dana2);
    expect(ids(t1)).toContain(id); expect(t2.total).toBe(t1.total);
    const first = await call(dana, 'POST', '/needs-you/act', { id, version: 'open', action: 'apply' });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true, total: t1.total - 1 });
    expect(app.blueprint.proposal(pid)!.status).toBe('applied');
    const second = await call(dana2, 'POST', '/needs-you/act', { id, version: 'open', action: 'reject' });
    expect([second.status, second.body.error]).toEqual([409, 'conflict']);
    expect((await needs(dana2)).total).toBe(t1.total - 1);
    // The decision went through the source workflow, recorded as the decider's.
    const audit = app.db.prepare("SELECT details FROM audit_events WHERE action='blueprint.proposal_decide' AND target_id=? ORDER BY id DESC").get(pid) as { details: string };
    expect(JSON.parse(audit.details)).toMatchObject({ via: 'decider', via_team: one });
  });

  it('rechecks the version and the decider, and leaves one-screen actions to their screen', async () => {
    const k = blockedTask(one, 'Stale one');
    const row = (await needs(dana)).items.find((i: any) => i.id === `task:${k}`);
    expect(row).toMatchObject({ kind: 'unblock', actions: [{ id: 'unblock' }] });
    app.db.prepare('UPDATE tasks SET version=version+1 WHERE id=?').run(k);
    expect((await call(dana, 'POST', '/needs-you/act', { id: row.id, version: row.source.version, action: 'unblock' })).status).toBe(409);
    const fresh = (await needs(dana)).items.find((i: any) => i.id === `task:${k}`);
    expect((await call(dana, 'POST', '/needs-you/act', { id: fresh.id, version: fresh.source.version, action: 'unblock' })).status).toBe(200);
    expect(app.db.prepare('SELECT status FROM tasks WHERE id=?').get(k)).toMatchObject({ status: 'open' });
    // Not Eve's to decide: it reads like something that no longer waits for her.
    const k2 = blockedTask(one, 'Not Eve\'s');
    const r2 = (await needs(dana)).items.find((i: any) => i.id === `task:${k2}`);
    expect((await call(eve, 'POST', '/needs-you/act', { id: r2.id, version: r2.source.version, action: 'unblock' })).status).toBe(409);
    // An answer needs its own screen; an unknown action is refused.
    const q = (await needs(dana)).items.find((i: any) => i.kind === 'question');
    expect((await call(dana, 'POST', '/needs-you/act', { id: q.id, version: q.source.version, action: 'answer' })).body.error).toBe('invalid_argument');
    expect((await call(dana, 'POST', '/needs-you/act', { id: q.id, version: q.source.version, action: 'delete' })).body.error).toBe('invalid_argument');
  });
});

describe('For awareness and dismissal', () => {
  it('a postponed backlog task leaves Needs you, and comes back when restored', async () => {
    const k = app.teams.create_task(who(coord2), { team_id: two, title: 'Postpone me', description: 'd' }).id;
    app.db.prepare("UPDATE tasks SET status='backlog', version=version+1 WHERE id=?").run(k);
    const has = async () => ids(await needs(admin)).includes(`backlog:${k}`);
    expect(await has()).toBe(true);
    const ver_ = () => app.teams.task(k)!.version;
    expect((await call(admin, 'POST', `/teams/${two}/tasks/${k}/postpone`, { version: ver_() })).status).toBe(200);
    expect([await has(), ids(await needs(admin, `?team=${two}`)).includes(`backlog:${k}`)]).toEqual([false, false]);
    expect((await call(admin, 'POST', `/teams/${two}/tasks/${k}/restore`, { version: ver_() })).status).toBe(200);
    expect(await has()).toBe(true);
    expect((await call(admin, 'POST', `/teams/${two}/tasks/${k}/discard`, {})).status).toBe(200);
  });

  it('missed milestones and stall warnings are off until switched on, and only the admin switches them', async () => {
    const res = await call(admin, 'POST', `/projects/${cnv}/ops`, { version: ver(cnv), ops: [{ op: 'upsert', kind: 'milestone', key: 'M1', status: 'missed' }] });
    expect(res.status).toBe(200);
    // One delivery model: a member stalls only while it holds started work past its check-in time.
    const k = app.teams.create_task(who(coord), { team_id: one, title: 'Stalls', operator_request: { source: 'test' } });
    app.teams.assign(who(coord), { task_id: k.id, agent_id: worker.id });
    app.teams.start_task(who(worker), k.id);
    app.db.prepare('UPDATE tasks SET lease_expires_at=? WHERE id=?').run(Date.now() - 60_000, k.id);
    app.db.prepare('UPDATE task_turns SET due_at=? WHERE task_id=? AND closed_at IS NULL').run(Date.now() - 60_000, k.id);
    const kinds = async (s: S) => (await needs(s)).awareness.items.map((i: any) => i.kind);
    expect(await kinds(admin)).not.toContain('missed_milestone');
    expect(await kinds(admin)).not.toContain('stalled');
    // The team tick raises no stalled-member alert either until the team switches stall warnings on.
    const stallAlerts = () => app.db.prepare("SELECT 1 FROM security_alerts WHERE type='stalled_member' AND subject=?").all(worker.id).length;
    app.teams.tick(true);
    expect(stallAlerts()).toBe(0);
    expect((await call(dana, 'PUT', `/projects/${cnv}/attention`, { missed_warnings: true })).status).toBe(403);
    expect((await call(dana, 'PUT', `/teams/${one}/attention`, { stall_warnings: true })).status).toBe(403);
    expect((await call(admin, 'PUT', `/projects/${cnv}/attention`, { missed_warnings: true })).status).toBe(200);
    expect((await call(admin, 'PUT', `/teams/${one}/attention`, { stall_warnings: true })).status).toBe(200);
    expect((await call(admin, 'PUT', `/teams/nope/attention`, { stall_warnings: true })).status).toBe(404);
    expect((await call(admin, 'GET', `/teams/${one}`)).body).toMatchObject({ team: { stall_warnings: true } });
    app.teams.tick(true);
    expect(stallAlerts()).toBe(1);
    for (const s of [admin, dana]) expect(await kinds(s)).toEqual(expect.arrayContaining(['missed_milestone', 'stalled']));
    expect(await kinds(eve)).toContain('missed_milestone');
    // Echo is outside Eve's grant: nothing from it reaches her.
    expect((await needs(eve)).awareness.items.every((i: any) => i.scope.project_id === cnv)).toBe(true);
  });

  it('every item a member\'s For awareness row opens is one that member may read', async () => {
    for (const s of [dana, eve]) {
      const rows = (await needs(s)).awareness.items.filter((i: any) => i.open?.kind === 'item');
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r.open.project_id).toBeTruthy();
        expect((await call(s, 'GET', `/projects/${r.open.project_id}/items/${encodeURIComponent(r.open.id)}`)).status).toBe(200);
      }
    }
  });

  it('a dismissal hides one row for one viewer and one episode; a new episode shows it again', async () => {
    const row = (await needs(dana)).awareness.items.find((i: any) => i.kind === 'missed_milestone');
    expect(row).toMatchObject({ record: `milestone:${cnv}:M1`, episode: `missed:${Date.parse('2026-03-03')}` });
    expect((await call(dana, 'POST', '/needs-you/dismiss', { record: row.record, episode: 'missed:1' })).status).toBe(409);
    expect((await call(dana, 'POST', '/needs-you/dismiss', { record: 'milestone:nope:M9', episode: 'x' })).status).toBe(404);
    expect((await call(dana, 'POST', '/needs-you/dismiss', { record: row.record, episode: row.episode })).status).toBe(200);
    const has = async (s: S) => (await needs(s)).awareness.items.some((i: any) => i.record === row.record);
    expect([await has(dana), await has(dana2), await has(admin), await has(eve)]).toEqual([false, false, true, true]);
    // Nothing else changed: the milestone is still missed.
    expect(app.blueprint.item(cnv, 'M1')!.status).toBe('missed');
    // Re-dated and missed again: a new episode, so the row is back.
    expect((await call(admin, 'POST', `/projects/${cnv}/ops`, { version: ver(cnv), ops: [{ op: 'upsert', kind: 'milestone', key: 'M1', fields: { target_at: Date.parse('2026-04-01') } }] })).status).toBe(200);
    expect(await has(dana)).toBe(true);
    // A stalled member who gives news leaves; stalled again later is a new episode.
    const stall = (await needs(dana)).awareness.items.find((i: any) => i.kind === 'stalled');
    expect((await call(dana, 'POST', '/needs-you/dismiss', { record: stall.record, episode: stall.episode })).status).toBe(200);
    expect((await needs(dana)).awareness.items.some((i: any) => i.kind === 'stalled')).toBe(false);
    app.db.prepare('UPDATE team_members SET last_work_next_at=? WHERE team_id=? AND agent_id=?').run(Date.now() + 1000, one, worker.id); // news, but the work is still overdue
    expect((await needs(dana)).awareness.items.find((i: any) => i.kind === 'stalled')).toMatchObject({ record: stall.record });
  });
});

describe('Needs you follow-ups (review of slice 4a)', () => {
  it('stall warnings switched off: no Stalled flag on the team, and its open stalled-member alerts close', async () => {
    const flag = async () => (await call(admin, 'GET', `/teams/${one}`)).body.team.members.find((m: any) => m.agent_id === worker.id).stalled;
    const count = async () => (await call(admin, 'GET', '/teams')).body.teams.find((t: any) => t.id === one).stalled;
    const alert = () => (app.db.prepare("SELECT status FROM security_alerts WHERE type='stalled_member' AND subject=? ORDER BY created_at DESC").get(worker.id) as { status: string } | undefined)?.status;
    app.db.prepare('UPDATE team_members SET last_work_next_at=? WHERE team_id=? AND agent_id=?').run(Date.now() - 3 * 3600_000, one, worker.id);
    app.teams.tick(true);
    expect([await flag(), await count(), alert()]).toEqual([true, 1, 'open']);
    expect((await call(admin, 'PUT', `/teams/${one}/attention`, { stall_warnings: false })).status).toBe(200);
    expect([await flag(), await count(), alert()]).toEqual([false, 0, 'closed']);
    app.teams.tick(true);
    expect(alert()).toBe('closed'); // and the tick raises no new one
    // Switched back on, the member still stalled is alerted on again: the team check forgot it while the switch was off.
    const open = () => app.db.prepare("SELECT 1 FROM security_alerts WHERE type='stalled_member' AND subject=? AND status='open'").all(worker.id).length;
    expect((await call(admin, 'PUT', `/teams/${one}/attention`, { stall_warnings: true })).status).toBe(200);
    app.teams.tick(true);
    expect([await flag(), open()]).toEqual([true, 1]);
    app.teams.tick(true);
    expect(open()).toBe(1); // once per stall, not once per tick
    expect((await call(admin, 'PUT', `/teams/${one}/attention`, { stall_warnings: false })).status).toBe(200);
  });

  it('a claim episode only moves forward: weak, unsupported, then weak again shows the row again', async () => {
    expect((await call(admin, 'POST', `/projects/${cnv}/ops`, { version: ver(cnv), ops: [
      { op: 'upsert', kind: 'paper', key: 'PAP-1', title: 'The paper' }, { op: 'upsert', kind: 'claim', key: 'PAP-1/C1', parent_key: 'PAP-1', title: 'A claim' },
      { op: 'link', from: 'FR-ONE-02', to: 'PAP-1/C1', rel: 'evidence' }] })).status).toBe(200);
    const claim = async () => (await needs(admin)).awareness.items.find((i: any) => i.record === `claim:${cnv}:PAP-1/C1`);
    const first = await claim();
    expect(first.episode).toMatch(/^weak:/);
    expect((await call(admin, 'POST', '/needs-you/dismiss', { record: first.record, episode: first.episode })).status).toBe(200);
    expect(await claim()).toBeUndefined();
    const link = (op: string) => call(admin, 'POST', `/projects/${cnv}/ops`, { version: ver(cnv), ops: [{ op, from: 'FR-ONE-02', to: 'PAP-1/C1', rel: 'evidence' }] });
    expect((await link('unlink')).status).toBe(200);
    expect((await claim()).episode).toMatch(/^unsupported:/);
    expect((await link('link')).status).toBe(200);
    const again = await claim();
    expect(again.episode).toMatch(/^weak:/);
    expect(again.episode).not.toBe(first.episode);
  });

  it('a dismissed claim stays dismissed when its evidence changes wording, and comes back when the evidence status changes', async () => {
    const claim = async () => (await needs(admin)).awareness.items.find((i: any) => i.record === `claim:${cnv}:PAP-1/C1`);
    const ops = (o: Op[]) => call(admin, 'POST', `/projects/${cnv}/ops`, { version: ver(cnv), ops: o });
    const row = await claim();
    expect(row.episode).toMatch(/^weak:/);
    expect((await call(admin, 'POST', '/needs-you/dismiss', { record: row.record, episode: row.episode })).status).toBe(200);
    // Wording only: the evidence changes, the claim's support does not, so the dismissal holds.
    expect((await ops([{ op: 'upsert', kind: 'fr', key: 'FR-ONE-02', title: 'Second requirement, reworded' }])).status).toBe(200);
    expect(await claim()).toBeUndefined();
    // The evidence's status changes (still not verified, so still weak): a new episode, and the row is back.
    const was = app.blueprint.item(cnv, 'FR-ONE-02')!.status;
    expect((await ops([{ op: 'upsert', kind: 'fr', key: 'FR-ONE-02', status: was === 'built' ? 'agreed' : 'built' }])).status).toBe(200);
    const back = await claim();
    expect(back.episode).toMatch(/^weak:/);
    expect(back.episode).not.toBe(row.episode);
  });

  it('a claim touched by its evidence records a revision that names who did it', async () => {
    const hist = async () => (await call(admin, 'GET', `/projects/${cnv}/items/${encodeURIComponent('PAP-1/C1')}/history`)).body.revisions as { rev: number; actor: string; note: string | null }[];
    const before = await hist();
    const link = (op: string) => call(admin, 'POST', `/projects/${cnv}/ops`, { version: ver(cnv), ops: [{ op, from: 'FR-ONE-02', to: 'PAP-1/C1', rel: 'evidence' }] });
    expect((await link('unlink')).status).toBe(200);
    const after = await hist();
    expect(after[0].rev).toBe(before[0].rev + 1);
    expect(after[0].note).toBe('evidence FR-ONE-02 unlinked');
    // The editor is the operator who unlinked, the same actor the evidence's own revisions name.
    const evid = (await call(admin, 'GET', `/projects/${cnv}/items/FR-ONE-02/history`)).body.revisions[0];
    expect(after[0].actor).toBe(evid.actor);
    expect(after[0].actor).not.toBe('system');
    expect(app.blueprint.item(cnv, 'PAP-1/C1')!.rev).toBe(after[0].rev);
    expect((await link('link')).status).toBe(200);
    expect((await hist())[0].note).toBe('evidence FR-ONE-02 linked');
  });

  it('an act builds the list once, and its count is the count of the entrance it came from', async () => {
    const k = app.teams.create_task(who(coord2), { team_id: two, title: 'Backlog in two', description: 'd' }).id;
    app.db.prepare("UPDATE tasks SET status='backlog', version=version+1 WHERE id=?").run(k);
    // One more row for the admin outside team two, so the team's count and the whole list's count differ.
    const elsewhere = app.teams.create_task(who(coord), { team_id: one, title: 'Backlog in one', description: 'd' }).id;
    app.db.prepare("UPDATE tasks SET status='backlog', version=version+1 WHERE id=?").run(elsewhere);
    const row = (await needs(admin, `?team=${two}`)).items.find((i: any) => i.id === `backlog:${k}`);
    expect(row).toBeTruthy();
    const spy = vi.spyOn(NeedsYou.prototype, 'rows');
    try {
      const r = await call(admin, 'POST', '/needs-you/act', { id: row.id, version: row.source.version, action: 'accept', filter: { team: two } });
      expect(r.status).toBe(200);
      expect(spy.mock.calls.map((c) => c[1] ?? 'all')).toEqual(['backlog', 'all']);
      expect(r.body.total).toBe((await needs(admin, `?team=${two}`)).total);
      expect(r.body.total).not.toBe((await needs(admin)).total);
    } finally { spy.mockRestore(); }
    expect((await call(admin, 'POST', '/needs-you/act', { id: 'backlog:x', version: '1', action: 'accept', filter: { bogus: 1 } })).status).toBe(400);
  });

  it('a source reply that is not JSON keeps its status and gets a plain message', () => {
    expect(sourceReply({ statusCode: 502, body: '<html>Bad gateway</html>' })).toMatchObject({ error: 'internal_error', message: expect.stringContaining('HTTP 502') });
    expect(sourceReply({ statusCode: 404, body: '' })).toMatchObject({ error: 'bad_request', message: expect.stringContaining('HTTP 404') });
    expect(sourceReply({ statusCode: 409, body: '{"error":"conflict","message":"Moved on."}' })).toEqual({ error: 'conflict', message: 'Moved on.' });
    expect(sourceReply({ statusCode: 200, body: '' })).toEqual({});
    expect(sourceReply({ statusCode: 200, body: '[1]' })).toEqual({ result: [1] });
  });

  it('counts per project are exact past the first page', async () => {
    const all = await needs(admin, '?limit=1');
    expect(all.items).toHaveLength(1);
    expect(all.projects[cnv]).toBe((await needs(admin, `?project=${cnv}`)).total);
    expect(all.projects[cnv]).toBeGreaterThan(1);
    const d = await needs(dana, '?limit=1');
    expect(d.projects[cnv] ?? 0).toBe((await needs(dana, `?project=${cnv}`)).total);
  });
  it('each row carries what it needs to be decided on the Needs you screen', async () => {
    const opts = [{ key: 'a', label: 'Ship now', effect: 'Goes out today' }, { key: 'b', label: 'Wait a week' }];
    const k = app.teams.create_task(who(coord), { team_id: one, title: 'Release notes', description: 'd' }).id;
    app.db.prepare("UPDATE tasks SET status='open' WHERE id=?").run(k);
    const q = app.decisions.ask(who(coord), { team_id: one, question: 'Ship the release?', context: 'Two fixes are in.', options: opts, recommended: 'a', task_id: k }).id;
    const b = blockedTask(one, 'Waits on a key');
    app.db.prepare('UPDATE tasks SET assignee_agent_id=? WHERE id=?').run(worker.id, b);
    app.db.prepare("INSERT INTO task_events(task_id,from_status,to_status,actor_kind,actor_id,tool,note,created_at) VALUES (?,?,?,?,?,?,?,?)").run(b, 'open', 'blocked', 'agent', worker.id, 'task_block', 'waits for a call', 1_700_000_000_000);
    const p = propose([{ op: 'upsert', kind: 'fr', key: 'FR-ONE-09', parent_key: 'ONE', title: 'New one' }, { op: 'remove', key: 'FR-ONE-02' }], coord, one, cnv);
    const L = (await needs(dana, `?team=${one}`)).items;
    const qr = L.find((i: any) => i.id === `question:${q}`), br = L.find((i: any) => i.id === `task:${b}`), pr = L.find((i: any) => i.source.id === p);
    expect(qr.detail).toEqual({ kind: 'question', context: 'Two fixes are in.', options: [{ key: 'a', label: 'Ship now', effect: 'Goes out today' }, { key: 'b', label: 'Wait a week', effect: null }],
      recommended: 'a', blocks: { id: k, title: 'Release notes' }, asked_by: 'cnv-coord' });
    expect(br.detail).toEqual({ kind: 'blocked', reason: 'waits for a call', blocked_by: 'cnv-worker', blocked_at: 1_700_000_000_000, assignee: 'cnv-worker' });
    expect(pr.detail).toEqual({ kind: 'proposal', ops: [{ op: 'upsert', kind: 'fr' }, { op: 'remove', kind: 'fr' }] });
    // Who sent each one, by label, and its own text for the card's summary: the question's context, the block's reason.
    expect([qr.by, qr.summary, br.by, br.summary, pr.by, pr.summary]).toEqual(['cnv-coord', 'Two fixes are in.', 'cnv-worker', 'waits for a call', 'cnv-coord', null]);
    // An option answers the question in one click; the note goes in as the answer's text.
    expect((await call(dana, 'POST', '/needs-you/act', { id: qr.id, version: qr.source.version, action: 'opt:zz' })).status).toBe(400);
    expect((await call(dana, 'POST', '/needs-you/act', { id: qr.id, version: qr.source.version, action: 'opt:b', note: 'After the demo.' })).status).toBe(200);
    expect(app.decisions.get(q)).toMatchObject({ status: 'answered', answer_option: 'b', answer_text: 'After the demo.' });
    expect((await needs(dana, `?team=${one}`)).items.some((i: any) => i.id === qr.id)).toBe(false);
  });

  it('a block\'s reason shows its text only: the Records part stays out of the row, its summary and the reason line', async () => {
    const b = blockedTask(one, 'Parked for the squash');
    app.db.prepare('UPDATE tasks SET blocked_reason=? WHERE id=?').run('**Parked until after the history squash.**\n\n## Records\n- branch dev/token-bench', b);
    const r = (await needs(dana, `?team=${one}`)).items.find((i: any) => i.id === `task:${b}`);
    expect(r.summary).toBe('**Parked until after the history squash.**');
    expect(r.reason).toBe('Blocked: **Parked until after the history squash.**');
    expect(`${r.summary} ${r.reason}`).not.toContain('Records');
  });

  it('a new brief names who wrote it and carries its In short, never "accept or discard"', async () => {
    const k = app.teams.create_task(who(coord), { team_id: one, title: 'Photograph the bay', description: 'Take four photos of the bay from the door.\n\nMore detail follows.' }).id;
    app.db.prepare("UPDATE tasks SET status='backlog', short_summary=NULL, version=version+1 WHERE id=?").run(k);
    const row = async () => (await needs(admin)).items.find((i: any) => i.id === `backlog:${k}`);
    const r1 = await row();
    expect(r1.by).toBe('cnv-coord');
    expect(r1.summary).toBe(hubShortSummary('Take four photos of the bay from the door.\n\nMore detail follows.'));
    expect(r1.summary).not.toContain('accept or discard');
    app.db.prepare("UPDATE tasks SET short_summary='Four photos of the bay.', version=version+1 WHERE id=?").run(k);
    expect((await row()).summary).toBe('Four photos of the bay.');
  });

  it("a summary goes only to whoever decides the item: the team's decider sees it, anyone else never", async () => {
    const qOne = app.decisions.ask(who(coord), { team_id: one, question: 'Order the clamps?', context: 'Secret one: the clamp budget.' }).id;
    const qTwo = app.decisions.ask(who(coord2), { team_id: two, question: 'Order the brackets?', context: 'Secret two: the bracket budget.' }).id;
    const bOne = blockedTask(one, 'Waits on the clamp quote'), bTwo = blockedTask(two, 'Waits on the bracket quote');
    app.db.prepare("UPDATE tasks SET blocked_reason=? WHERE id=?").run('Secret three: the quote is late.', bOne);
    app.db.prepare("UPDATE tasks SET blocked_reason=? WHERE id=?").run('Secret four: the quote is late.', bTwo);
    const sumOf = (b: any, id: string) => b.items.find((i: any) => i.id === id)?.summary;
    // Dana decides for team one: its question and its blocked task carry their summaries.
    const d = await needs(dana, `?team=${one}`);
    expect([sumOf(d, `question:${qOne}`), sumOf(d, `task:${bOne}`)]).toEqual(['Secret one: the clamp budget.', 'Secret three: the quote is late.']);
    // Team two has no decider of hers: neither its rows nor their text reach her, on any entrance.
    const dAll = JSON.stringify(await needs(dana));
    expect(dAll).not.toContain('Secret two');
    expect(dAll).not.toContain('Secret four');
    // Eve reads the same project but decides for no team: no row and no summary, in Needs you or For awareness.
    const e = await needs(eve), eAll = JSON.stringify(e);
    expect(e.items).toEqual([]);
    for (const s of ['Secret one', 'Secret two', 'Secret three', 'Secret four']) expect(eAll).not.toContain(s);
    for (const id of [qOne, qTwo]) app.db.prepare("UPDATE decisions SET status='answered' WHERE id=?").run(id);
    for (const id of [bOne, bTwo]) app.db.prepare("UPDATE tasks SET status='open', blocked_reason=NULL WHERE id=?").run(id);
  });
});

describe('Later: a Needs you row set aside per viewer (SPEC-ATTENTION-05)', () => {
  const DAY = 24 * 3600_000;
  const rowOf = async (s: S, id: string) => (await needs(s)).items.find((i: any) => i.id === id);
  const later = (s: S, r: any, until?: number | null) => call(s, 'POST', '/needs-you/dismiss', { record: r.id, episode: r.source.version, kind: 'later', ...(until === undefined ? {} : { until }) });
  const entry = (record: string) => app.db.prepare("SELECT until, dismissed_at FROM attention_dismissals WHERE kind='later' AND record=?").get(record) as { until: number | null; dismissed_at: number } | undefined;

  it('leaves the viewer\'s list and counts, lists under later, and stays as it is for everyone else', async () => {
    const eveId = (app.db.prepare("SELECT id FROM admin_users WHERE username='eve'").get() as { id: string }).id;
    expect((await call(admin, 'PUT', `/teams/${one}/deciders`, { user_ids: [danaId, eveId] })).status).toBe(200);
    const id = `task:${blockedTask(one, 'Later: first')}`;
    const before = await needs(dana), r = before.items.find((i: any) => i.id === id);
    expect(r).toBeTruthy();
    const res = await later(dana, r, Date.now() + 3600_000);
    expect(res.status).toBe(200);
    expect(res.body.later).toMatchObject({ changes: false });
    const after = await needs(dana);
    expect(ids(after)).not.toContain(id);
    expect(after.total).toBe(before.total - 1);
    expect(after.later.total).toBe(1);
    expect(after.later.items[0]).toMatchObject({ id, later: { changes: false } });
    expect((await needs(dana, `?team=${one}`)).later.items.map((i: any) => i.id)).toEqual([id]);
    // The same person on another device sees it set aside too; another decider still sees it waiting.
    expect(ids(await needs(dana2))).not.toContain(id);
    expect(ids(await needs(eve))).toContain(id);
    expect((await needs(eve)).later.total).toBe(0);
    // It still waits: the task is unchanged.
    expect((app.db.prepare('SELECT status FROM tasks WHERE id=?').get(id.slice(5)) as { status: string }).status).toBe('blocked');
  });

  it('refuses the wrong kind, an end in the past or past 7 days, a changed version and a row that does not wait', async () => {
    const r = await rowOf(dana, `task:${blockedTask(one, 'Later: refusals')}`);
    expect((await call(dana, 'POST', '/needs-you/dismiss', { record: r.id, episode: r.source.version })).status).toBe(400);
    expect((await call(dana, 'POST', '/needs-you/dismiss', { record: r.id, episode: r.source.version, kind: 'dismiss', until: Date.now() + 1000 })).status).toBe(400);
    expect((await later(dana, r, Date.now() - 1000)).status).toBe(400);
    expect((await later(dana, r, Date.now() + 8 * DAY)).status).toBe(400);
    // Next Monday 9:00 from a Monday at 8:00 is 7 days and 1 hour away: refused by the hub, which is why the console cuts it to the week.
    expect((await later(dana, r, Date.now() + 7 * DAY + 3600_000)).body.message).toMatch(/at most 7 days/);
    expect((await call(dana, 'POST', '/needs-you/dismiss', { record: r.id, episode: 'stale', kind: 'later' })).status).toBe(409);
    expect((await call(dana, 'POST', '/needs-you/dismiss', { record: 'task:nope', episode: '1', kind: 'later' })).status).toBe(404);
    const aw = (await needs(admin)).awareness.items[0];
    expect(aw).toBeTruthy();
    expect((await call(admin, 'POST', '/needs-you/dismiss', { record: aw.record, episode: aw.episode, kind: 'later' })).status).toBe(400);
    // Exactly 7 days is accepted.
    expect((await later(dana, r, Date.now() + 7 * DAY)).status).toBe(200);
  });

  it('comes back marked when its time passes, when its version changes, and after 7 days of "until it changes"', async () => {
    const t1 = blockedTask(one, 'Later: on time'), t2 = blockedTask(one, 'Later: changes'), t3 = blockedTask(one, 'Later: week');
    for (const t of [t1, t2, t3]) expect((await later(dana, await rowOf(dana, `task:${t}`), t === t1 ? Date.now() + 3600_000 : null)).status).toBe(200);
    expect(ids(await needs(dana)).filter((x: string) => [t1, t2, t3].some((t) => x === `task:${t}`))).toEqual([]);
    expect((await needs(dana)).later.items.find((i: any) => i.id === `task:${t2}`).later.changes).toBe(true);
    // The hour passes.
    app.db.prepare("UPDATE attention_dismissals SET until=? WHERE kind='later' AND record=?").run(Date.now() - 1, `task:${t1}`);
    expect(await rowOf(dana, `task:${t1}`)).toMatchObject({ back_from_later: true });
    // The task changes (a new block reason): a new version, so it is back at once.
    app.db.prepare("UPDATE tasks SET blocked_reason='more context', version=version+1 WHERE id=?").run(t2);
    expect(await rowOf(dana, `task:${t2}`)).toMatchObject({ back_from_later: true });
    // "Until it changes" ends 7 days after it was set, even with no change.
    app.db.prepare("UPDATE attention_dismissals SET dismissed_at=? WHERE kind='later' AND record=?").run(Date.now() - 7 * DAY - 1000, `task:${t3}`);
    expect(await rowOf(dana, `task:${t3}`)).toMatchObject({ back_from_later: true });
    // Set aside again: the earlier choice is replaced, and the mark goes with it.
    const back = await rowOf(dana, `task:${t1}`);
    expect((await later(dana, back, Date.now() + 3600_000)).status).toBe(200);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM attention_dismissals WHERE kind='later' AND record=?").get(`task:${t1}`)).toEqual({ n: 1 });
    expect(entry(`task:${t1}`)!.until).toBeGreaterThan(Date.now());
  });

  it('Bring back now lists it again at once, without the mark', async () => {
    const id = `task:${blockedTask(one, 'Later: bring back')}`;
    expect((await later(dana, await rowOf(dana, id))).status).toBe(200);
    expect(entry(id)!.until).toBeNull();
    expect(ids(await needs(dana))).not.toContain(id);
    expect((await call(dana, 'POST', '/needs-you/bring-back', { record: id })).status).toBe(200);
    const r = await rowOf(dana, id);
    expect(r).toBeTruthy();
    expect(r.back_from_later).toBeUndefined();
    expect((await call(dana, 'POST', '/needs-you/bring-back', { record: id })).status).toBe(404);
  });

  it('a row set aside can still be resolved, and the act count leaves it out', async () => {
    const tid = blockedTask(one, 'Later: still resolvable'), id = `task:${tid}`, r = await rowOf(dana, id);
    expect((await later(dana, r, Date.now() + 3600_000)).status).toBe(200);
    const res = await call(dana, 'POST', '/needs-you/act', { id, version: r.source.version, action: 'unblock', note: 'go on' });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe((await needs(dana)).total);
    expect((await needs(dana)).later.items.map((i: any) => i.id)).not.toContain(id);
  });
});

/* The console reads every page (docs/dashboard-ux.md, Needs you screen, "Every row, every page"): row 201 and a project's
   lone row behind 200 of another project's are reachable by following next_cursor, and each scope keeps its own total. */
describe('past the first page of 200', () => {
  it('row 201 is on the next page, and a project filter finds its one row behind 200 others', async () => {
    const bc = mk('brz-c2'), t3 = team(brz, 'BRZ Paging', [bc]);
    // An agent may have five questions open, so forty members of one Conclave team ask five each.
    const askers = Array.from({ length: 40 }, (_, i) => mk(`cnv-pager-${i}`)), pg = team(cnv, 'CNV Paging', askers);
    for (let i = 0; i < 200; i++) app.decisions.ask(who(askers[i % 40]!), { team_id: pg, question: `Page question ${i + 1}?` });
    const lone = app.decisions.ask(who(bc), { team_id: t3, question: 'The one Echo question?' }).id;
    const p1 = await needs(admin, '?limit=200');
    expect(p1.total).toBeGreaterThan(200);
    expect(p1.items).toHaveLength(200);
    const rest: any[] = []; let c = p1.next_cursor;
    while (c) { const p = await needs(admin, `?limit=200&cursor=${c}`); rest.push(...p.items); c = p.next_cursor; }
    const every = [...ids(p1), ...rest.map((i) => i.id)];
    expect(every).toHaveLength(p1.total);
    expect(new Set(every).size).toBe(p1.total);
    expect(every).toContain(`question:${lone}`);
    // The project's own list has it on its first page, and its count is per scope.
    const b = await needs(admin, `?project=${brz}&limit=200`);
    expect(ids(b)).toContain(`question:${lone}`);
    expect(b.total).toBe(b.items.length);
    expect(p1.projects[brz]).toBe(b.total);
    expect(p1.projects[cnv]).toBe((await needs(admin, `?project=${cnv}&limit=1`)).total);
  });
});

describe('checkpoint wording', () => {
  // A checkpoint (approved, waiting for the decider) says how its task got there, from its last move into approved.
  const checkpoint = (title: string, tool: string, actor: string | null) => {
    const t = app.teams.create_task(who(coord), { team_id: one, title, description: 'd' });
    app.db.prepare("UPDATE tasks SET status='approved', approval_requested=1, version=version+1 WHERE id=?").run(t.id);
    app.db.prepare("INSERT INTO task_events(task_id,from_status,to_status,actor_kind,actor_id,tool,note,created_at) VALUES (?,'in_review','approved','agent',?,?,'x',?)").run(t.id, actor, tool, Date.now());
    app.db.prepare("INSERT INTO task_events(task_id,from_status,to_status,actor_kind,actor_id,tool,note,created_at) VALUES (?,'approved','approved','agent',?,?,'awaiting administrator approval',?)").run(t.id, actor, tool, Date.now());
    return `task:${t.id}`;
  };
  it('a reviewed checkpoint names its reviewer; one that skipped review says "Submitted without review"', async () => {
    const reviewed = checkpoint('Checkpoint: reviewed', 'task_review', worker.id), skipped = checkpoint('Checkpoint: no review', 'no_review', worker.id);
    const rows = (await needs(dana, '?limit=200')).items as any[];
    expect(rows.find((r) => r.id === reviewed)).toMatchObject({ kind: 'checkpoint', reason: 'Approved by cnv-worker · waits for your approval' });
    expect(rows.find((r) => r.id === skipped)).toMatchObject({ kind: 'checkpoint', reason: 'Submitted without review · waits for your approval' });
  });
});

describe('every option a row shows works', () => {
  it('Later works on every row of the list, including a past-its-check-in or not-delivered row (its id says delivery, its source is the task queue)', async () => {
    const rows = (await needs(admin)).items as any[];
    expect(rows.some((r) => r.kind === 'overdue' || r.kind === 'undelivered')).toBe(true);
    for (const r of rows) {
      const x = await call(admin, 'POST', '/needs-you/dismiss', { record: r.id, episode: r.source.version, kind: 'later', until: Date.now() + 3600_000 });
      expect([r.id, x.status, x.body?.message]).toEqual([r.id, 200, undefined]);
    }
  });
  it('a dismissal accepts a long episode (the blocking rows list every blocker in theirs) and refuses a wrong one with a plain conflict, not a validation error', async () => {
    await call(admin, 'PUT', `/projects/${cnv}/attention`, { missed_warnings: true });
    const row = (await needs(admin)).awareness.items.find((i: any) => i.kind === 'missed_milestone');
    expect((await call(admin, 'POST', '/needs-you/dismiss', { record: row.record, episode: 'x'.repeat(500) })).status).toBe(409);
  });
});
