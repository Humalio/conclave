/**
 * Designs to decide (docs/decisions.md, Designs): a team question that names a decision item is one Needs you row, "Design to decide";
 * the design screen reads the item (the design text, the review with who wrote it, the mockups as images only); the answer goes through
 * the ordinary answer route; Change… is needs_info; Reject records the item as rejected with the reason; Archive keeps the links.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import type { Who } from '../src/teams/teams.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base = '', cookie = '', csrf = '', P = '', team = '', task = '', adminId = '';
let coord: Who, reviewer: Who;
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const GIF = 'R0lGODlhAQABAAAAACw=';
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, text, type: r.headers.get('content-type') ?? '', body: (() => { try { return JSON.parse(text); } catch { return null; } })() as any };
};
const opr = () => ({ kind: 'operator' as const, id: adminId });
const agentOf = (id: string) => ({ kind: 'agent' as const, id });
const who = (id: string, cred: string): Who => ({ agentId: id, credId: cred, tokenHash: `th_${id}`, rules: app.keys.rulesFor(cred), cap: [] });
const ver = () => app.blueprint.project(P)!.version;
/** The coordinator files a proposed design and asks for it, the way team_ask {decision: true, refs} does. */
function propose(title: string, extra: Record<string, unknown> = {}) {
  // The open-question cap is per agent: earlier questions of this file are set aside.
  app.db.prepare("UPDATE decisions SET status='withdrawn' WHERE agent_id=? AND status IN ('open','needs_info')").run(coord.agentId);
  const r = app.blueprint.write(P, { version: ver(), ops: [{ op: 'upsert', kind: 'decision', key: 'ADR-*', title, body: `## ${title}\n\nThe design in **Markdown**.`, status: 'proposed', fields: { context: 'c', ...extra } }] }, agentOf(coord.agentId));
  const key = r.keys['ADR-*']!;
  const q = app.decisions.ask(coord, { team_id: team, question: `Approve ${title}?`, options: [{ key: 'a', label: 'Approve' }, { key: 'b', label: 'Approve later' }], recommended: 'a', refs: [key], decision: true });
  return { key, q };
}
const adr = (key: string) => app.blueprint.item(P, key)!;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-design-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  app = await buildApp(testConfig(dir));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base));
  adminId = (app.db.prepare('SELECT id FROM admin_users LIMIT 1').get() as { id: string }).id;
  P = (await api('POST', '/projects', { key: 'DSG', name: 'Designs' })).body.project.id as string;
  const mk = (label: string) => { const a = app.keys.createAgent(label, null, sys); const k = app.keys.createSessionKey({ agentId: a.id, label: `${label} key` }, sys); return { id: a.id, cred: k.credential.id }; };
  const c = mk('Design coordinator'), r = mk('Spec reviewer');
  team = app.teams.create({ name: 'Design team', goal: 'goal', members: [{ agent_id: c.id, role: 'coordinator' }, { agent_id: r.id, role: 'worker' }] }, sys).id;
  app.teams.start(team, sys);
  app.db.prepare('UPDATE teams SET project_id=? WHERE id=?').run(P, team);
  coord = who(c.id, c.cred); reviewer = who(r.id, r.cred);
  task = app.teams.create_task(coord, { team_id: team, title: 'Mockups', description: 'x' }).id;
  app.db.prepare("UPDATE tasks SET status='in_progress', assignee_agent_id=? WHERE id=?").run(r.id, task); // the assignee attaches its round
});
afterAll(async () => { await app?.close(); });

describe('Needs you', () => {
  it('shows one "Design to decide" row for a question that names a design, and no ordinary question row', async () => {
    const { key, q } = propose('Archive keys in the console');
    const items = ((await api('GET', '/needs-you')).body.items as any[]).filter((x) => x.source.id === q.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'design', title: 'Design to decide · Archive keys in the console', open: { kind: 'design', id: q.id }, design: { key, review: null } });
    expect(items[0].actions[0]).toMatchObject({ id: 'answer', label: 'Decide', input: true });
  });
  it('says what the review found in a few words', async () => {
    const { q } = propose('Reviewed design', { review: { verdict: 'changes', changes: ['One', 'Two'] } });
    const row = ((await api('GET', '/needs-you')).body.items as any[]).find((x) => x.source.id === q.id);
    expect(row.design.review).toBe('2 changes');
  });
  it('keeps the ordinary question row for a question that names no design', async () => {
    const q = app.decisions.ask(coord, { team_id: team, question: 'Which port?' });
    expect(((await api('GET', '/needs-you')).body.items as any[]).find((x) => x.source.id === q.id)).toMatchObject({ kind: 'question' });
  });
});

describe('the design screen', () => {
  it('reads the design, marks who wrote it and who reviewed it from the item\'s revisions, not from a field', async () => {
    const { key, q } = propose('Marked design');
    // The reviewer writes the review itself; a claim inside the field about who wrote it is ignored.
    app.blueprint.write(P, { version: ver(), ops: [{ op: 'upsert', kind: 'decision', key, fields: { review: { verdict: 'approved', summary: 'Fine.', changes: ['Archive, not delete'], by: 'the operator' } } }] }, agentOf(reviewer.agentId));
    const r = (await api('GET', `/decisions/${q.id}/design`)).body;
    expect(r.design).toMatchObject({ key, status: 'proposed', written_by: 'Design coordinator', asked_by: 'Design coordinator' });
    expect(r.design.body).toContain('The design in **Markdown**');
    expect(r.design.review).toMatchObject({ verdict: 'approved', by: 'Spec reviewer', independent: true, changes: ['Archive, not delete'] });
  });
  it('does not call a review independent when its writer wrote the design', async () => {
    const { key, q } = propose('Self-reviewed');
    app.blueprint.write(P, { version: ver(), ops: [{ op: 'upsert', kind: 'decision', key, fields: { review: { verdict: 'approved', changes: [] } } }] }, agentOf(coord.agentId));
    expect((await api('GET', `/decisions/${q.id}/design`)).body.design.review).toMatchObject({ by: 'Design coordinator', independent: false });
  });
  it('marks a review as out of date when the design changes after it, in the screen and on the Needs you row', async () => {
    const { key, q } = propose('Edited after review');
    app.blueprint.write(P, { version: ver(), ops: [{ op: 'upsert', kind: 'decision', key, fields: { review: { verdict: 'approved', changes: [] } } }] }, agentOf(reviewer.agentId));
    expect((await api('GET', `/decisions/${q.id}/design`)).body.design.review).toMatchObject({ verdict: 'approved', stale: false });
    app.blueprint.write(P, { version: ver(), ops: [{ op: 'upsert', kind: 'decision', key, body: 'A different design the reviewer never read.' }] }, agentOf(coord.agentId));
    expect((await api('GET', `/decisions/${q.id}/design`)).body.design.review).toMatchObject({ verdict: 'approved', stale: true });
    const row = ((await api('GET', '/needs-you')).body.items as any[]).find((i) => i.source.id === q.id);
    expect(row.design.review).toBe('out of date');
    // A new review of the new text is current again.
    app.blueprint.write(P, { version: ver(), ops: [{ op: 'upsert', kind: 'decision', key, fields: { review: { verdict: 'changes', changes: ['One'] } } }] }, agentOf(reviewer.agentId));
    expect((await api('GET', `/decisions/${q.id}/design`)).body.design.review).toMatchObject({ stale: false });
  });
  it('refuses a question that names no design', async () => {
    const q = app.decisions.ask(coord, { team_id: team, question: 'Plain?' });
    expect((await api('GET', `/decisions/${q.id}/design`)).status).toBe(404);
  });
  it('serves a PNG mockup of the team\'s own task, and refuses a GIF and another team\'s task', async () => {
    const A = app.taskAttachments, w = { agentId: reviewer.agentId, credId: reviewer.credId, actor: { kind: 'agent' as const, id: reviewer.agentId } };
    const s = (await A.stage(w, [{ path: 'add-pc.png', content: PNG, encoding: 'base64' }, { path: 'spinner.gif', content: GIF, encoding: 'base64' }], undefined))!; // one round holds both
    A.commit(app.teams.task(task)!, 'submission', s, w);
    const { q } = propose('With mockups', { mockups: [{ task_id: task, role: 'submission', path: 'add-pc.png', caption: 'Add PC' }, { task_id: task, role: 'submission', path: 'spinner.gif' }, { task_id: 'tsk_other', role: 'brief', path: 'x.png' }] });
    const d = (await api('GET', `/decisions/${q.id}/design`)).body.design;
    expect(d.mockups.map((m: { caption: string }) => m.caption)).toEqual(['Add PC', '', '']);
    const png = await api('GET', `/decisions/${q.id}/mockup/0`);
    expect(png.status).toBe(200);
    expect(png.type).toBe('image/png');
    expect((await api('GET', `/decisions/${q.id}/mockup/1`)).status).toBe(400); // a GIF is not a mockup
    expect((await api('GET', `/decisions/${q.id}/mockup/2`)).status).toBe(404); // not a task of this team
    expect((await api('GET', `/decisions/${q.id}/mockup/7`)).status).toBe(404);
  });
});

describe('answering a design', () => {
  it('records the decision once, through the ordinary answer route, and keeps it for Archive afterwards', async () => {
    const { key, q } = propose('Answer through the path');
    const r = await api('POST', `/decisions/${q.id}/answer`, { option: 'a' });
    expect(r.status, r.text).toBe(200);
    expect(adr(key)).toMatchObject({ status: 'accepted', fields: { source: `team_ask:${q.id}`, decided_by: 'operator' } });
    expect(app.db.prepare("SELECT COUNT(*) n FROM bp_items WHERE project_id=? AND kind='decision' AND title=?").get(P, 'Answer through the path')).toMatchObject({ n: 1 });
    expect(app.db.prepare('SELECT bp_key FROM decisions WHERE id=?').get(q.id)).toMatchObject({ bp_key: key });
    const arch = await api('POST', `/projects/${P}/items/${key}/archive`, {});
    expect(arch.status, arch.text).toBe(200);
    expect(adr(key).archived).toBeTruthy();
    expect(adr(key).status).toBe('accepted');
    expect((await api('POST', `/projects/${P}/items/${key}/unarchive`, {})).status).toBe(200);
  });
  it('Change… asks for more information and leaves the design proposed', async () => {
    const { key, q } = propose('Needs a change');
    expect((await api('POST', `/decisions/${q.id}/more-info`, { note: 'Show the phone view' })).status).toBe(200);
    expect(app.decisions.get(q.id).status).toBe('needs_info');
    expect(adr(key).status).toBe('proposed');
  });
  it('Reject records the design as rejected, with the reason as its consequence, and needs a reason and no option', async () => {
    const { key, q } = propose('Turned down');
    expect((await api('POST', `/decisions/${q.id}/answer`, { reject: true })).status).toBe(400);
    expect((await api('POST', `/decisions/${q.id}/answer`, { reject: true, option: 'a', text: 'no' })).status).toBe(400);
    const r = await api('POST', `/decisions/${q.id}/answer`, { reject: true, text: 'Too much for 0.9.7' });
    expect(r.status, r.text).toBe(200);
    expect(r.body.decision.answer_text).toBe('Too much for 0.9.7');
    expect(adr(key)).toMatchObject({ status: 'rejected', fields: { chosen: 'Rejected', consequences: 'Too much for 0.9.7' } });
  });
  it('refuses Reject on a question that names no design', async () => {
    const q = app.decisions.ask(coord, { team_id: team, question: 'Plain?' });
    expect((await api('POST', `/decisions/${q.id}/answer`, { reject: true, text: 'no' })).status).toBe(400);
  });
  it('shows a relayed answer with Confirm and Overturn, and records the decision on confirm', async () => {
    const { key, q } = propose('Relayed design');
    app.decisions.update(coord, { decision_id: q.id, relayed_answer: 'Yes, go', chosen: 'a', source: 'chat with operator' });
    const row = ((await api('GET', '/needs-you')).body.items as any[]).find((x) => x.source.id === q.id);
    expect(row).toMatchObject({ kind: 'design' });
    expect(row.actions.map((a: { id: string }) => a.id)).toEqual(['confirm', 'overturn']);
    expect(adr(key).status).toBe('proposed');
    expect((await api('POST', `/decisions/${q.id}/confirm`, {})).status).toBe(200);
    expect(adr(key).status).toBe('accepted');
  });
});

describe('what a design may not carry', () => {
  it('refuses an SVG named as a mockup: it is never an image the hub serves', async () => {
    const A = app.taskAttachments, w = { agentId: reviewer.agentId, credId: reviewer.credId, actor: { kind: 'agent' as const, id: reviewer.agentId } };
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>').toString('base64');
    const s = (await A.stage(w, [{ path: 'm.svg', content: svg, encoding: 'base64' }], undefined))!;
    A.commit(app.teams.task(task)!, 'submission', s, w);
    const { q } = propose('With an SVG', { mockups: [{ task_id: task, role: 'submission', path: 'm.svg' }] });
    expect((await api('GET', `/decisions/${q.id}/mockup/0`)).status).toBe(400);
  });
});

describe('the Blueprint Designs filter', () => {
  it('lists the project\'s designs, archived ones too, and reads one without a question', async () => {
    const A = app.taskAttachments, w = { agentId: reviewer.agentId, credId: reviewer.credId, actor: { kind: 'agent' as const, id: reviewer.agentId } };
    A.commit(app.teams.task(task)!, 'submission', (await A.stage(w, [{ path: 'add-pc.png', content: PNG, encoding: 'base64' }], undefined))!, w);
    const { key, q } = propose('Listed design', { mockups: [{ task_id: task, role: 'submission', path: 'add-pc.png', caption: 'Add PC' }] });
    const r1 = await api('GET', `/projects/${P}/designs`);
    expect(r1.status, r1.text).toBe(200);
    expect(r1.body.designs.find((d: { key: string }) => d.key === key)).toMatchObject({ title: 'Listed design', status: 'proposed', archived: false, mockups: 1 });
    await api('POST', `/decisions/${q.id}/answer`, { option: 'a' });
    expect((await api('POST', `/projects/${P}/items/${key}/archive`, {})).status).toBe(200);
    const one = (await api('GET', `/projects/${P}/designs`)).body.designs.find((d: { key: string }) => d.key === key);
    expect(one).toMatchObject({ status: 'accepted', archived: true });
    const g = await api('GET', `/projects/${P}/designs/${key}`);
    expect(g.status, g.text).toBe(200);
    expect(g.body.design).toMatchObject({ key, status: 'accepted', archived: true, may_archive: true });
    expect(g.body.design.mockups[0].caption).toBe('Add PC');
    expect((await api('GET', `/projects/${P}/designs/${key}/mockup/0`)).type).toBe('image/png');
    expect((await api('GET', `/projects/${P}/designs/NOPE-1`)).status).toBe(404);
    expect((await api('GET', `/projects/${P}/designs/${key}/mockup/9`)).status).toBe(404);
  });
});

describe('the Designs filter and a design nobody reviewed', () => {
  it('lists a rejected design that has no review and no mockups, because a team asked about it', async () => {
    const { key, q } = propose('Plain rejected design');
    await api('POST', `/decisions/${q.id}/answer`, { reject: true, text: 'No.' });
    expect((await api('GET', `/projects/${P}/designs`)).body.designs.find((d: { key: string }) => d.key === key)).toMatchObject({ status: 'rejected', review: null });
  });
});
