/**
 * Home's "N more" row and the Needs you screen (docs/dashboard-ux.md, Home's attention and Needs you screen): the row counts
 * the items of urgent() after the card above it and opens #needs; the screen's cards (nyCard) lead with the message and keep
 * every action, the main decision first and the rest in ⋯. Static, like console-nav.test.ts: the functions from public/app.js run in vm.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { mdPlain } from '../public/md.js';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const html = readFileSync(join(process.cwd(), 'public', 'index.html'), 'utf8');
const at = (s: string) => { const i = js.indexOf(`\n${s}`); if (i < 0) throw new Error(`app.js has no ${s}`); return i + 1; };
const part = (s: string, end: string) => { const i = at(s); return js.slice(i, js.indexOf(end, i) + end.length); };
const line = (name: string) => part(`const ${name} = `, '\n');
const fn = (head: string) => part(head, '\n}\n');

const now = Date.now();
const nyItem = (id: string, title: string, mins: number) => ({ id, kind: 'access_request', source: { kind: 'request', id: 'req_' + id, version: 'v1' }, scope: { project_id: null, team_id: null },
  title, reason: 'Inside your ceiling', open: { kind: 'request', id: 'req_' + id }, actions: [{ id: 'approve', label: 'Approve', tone: 'ok' }, { id: 'deny', label: 'Deny' }], at: now - mins * 60_000 });

const ROW = [part('function mdText(', '\n'), ...['ic', 'esc', 'ago', 'plural', 'trunc', 'raw', 'txt', 'safeHref', 'cap', 'none', 'pill'].map(line), part('const overline = ', '\n'), part('const NY_KIND = ', '};\n'),
  line('nyKind'), fn('function nyOpenAttr('), line('nyActAttrs'), line('nyLaterBtn'), fn('function nyBtns('), fn('function awBtns('), line('nyUntil'), line('nyOffline'), line('nySum'), line('nyMeta'), line('nyLead'), line('nyRow'), line('awRow'), fn('function row('),
  line('NY_EFFECT_MAX'), part('const nyWho = ', '; };\n'), line('nyTeamOf'), line('nyHeadLine'), line('nyHead'), fn('function nyOpsLine('), line('nyReplyBtn'), line('nyReplyBox'), line('nyOpenBtn'), line('nyActBtn'), fn('function nyBody('), line('NY_QDET'), fn('function nyQCard('),
  part('const nyCardBox = ', '</article>`;\n'), fn('function nyCard('), fn('function awCard('), fn('function nyBacklogCard(')];
const ctx0 = (S: unknown) => ({ S, Date, mdPlain, mdDoc: (t: string) => `<p>${t}</p>`, NAV_NAMES: new Map([['prj_c', 'Conclave']]), BP_KIND: { fr: 'Requirement', decision: 'Decision', release_note: 'Release note' }, dt: () => '14 Nov, 10:00',
  K: () => undefined, AG: () => undefined, keyName: () => '', bpArg: () => '', bpItemArg: () => '', stOf: () => ['', '', ''] });

/* Home: three Needs you rows (the oldest goes on the card), one For awareness row and one security alert. */
const home = () => {
  const S = {
    ny: { total: 3, items: [nyItem('ny_a', 'Developer 1 asks to write notes', 30), nyItem('ny_b', 'Developer 2 asks to read plans', 20), nyItem('ny_c', 'Developer 3 asks to read specs', 10)],
      awareness: { total: 1, items: [{ id: 'aw_a', record: 'agent-x', episode: 'e1', kind: 'stalled', title: 'Writer has not given news', reason: '', scope: { project_id: null, team_id: null }, open: { kind: 'agent', id: 'agent-x' }, at: now - 5 * 60_000 }] } },
    teams: [], pcs: [], obPc: new Map(), fbc: null,
  };
  const alerts = [{ id: 'alr_a', type: 'secret_in_payload', severity: 'warning', status: 'open', subject: 'crd_x', created_at: now - 60_000, details: '{"message":"A key was sent in a message"}' }];
  const ctx = { ...ctx0(S), openAlerts: () => alerts, atype: () => ['Secret in payload', 'warn'], alertTeam: () => null, coAlertTeam: () => null, coHeld: () => false };
  vm.createContext(ctx);
  return vm.runInContext([...ROW, line('SEV'), line('det'), line('bt'), fn('function urgent() {'), 'urgent();'].join('\n'), ctx) as { id: string; g: string }[];
};

/* The Needs you screen's rows: a team question with options, a blocked task, a proposal and two backlog tasks. */
const screen = (rows: unknown[]) => {
  const ctx = ctx0({ teams: [{ id: 'team_a', name: 'Conclave Developers' }] });
  vm.createContext(ctx);
  vm.runInContext(ROW.join('\n') + '\nvar out = {};', ctx);
  (ctx as any).rows = rows;
  return vm.runInContext(`({ cards: rows.filter((r) => r.kind !== 'backlog').map((r) => nyCard(r)), backlog: nyBacklogCard(rows.filter((r) => r.kind === 'backlog')), aw: awCard({ id: 'aw_1', record: 'agent-x', episode: 'e1', kind: 'stalled', title: 'Writer is quiet', reason: 'No news for 2 hours', scope: { project_id: null, team_id: null }, open: { kind: 'agent', id: 'agent-x' }, at: Date.now() }) })`, ctx) as { cards: string[]; backlog: string; aw: string };
};
const sc = { project_id: 'prj_c', team_id: 'team_a' };
const question = (over: Record<string, unknown> = {}) => ({ id: 'question:dec_1', kind: 'question', source: { kind: 'decision', id: 'dec_1', version: '42' }, scope: sc, title: 'Ship the release <now>?', reason: 'Team question',
  open: { kind: 'question', id: 'dec_1' }, actions: [{ id: 'answer', label: 'Answer', input: true, path: '/api/decisions/dec_1/answer' }], at: now - 3_600_000,
  detail: { kind: 'question', context: 'Two fixes are in.', options: [{ key: 'b', label: 'Wait a week', effect: null }, { key: 'a', label: 'Ship now', effect: 'Goes out today' }], recommended: 'a', blocks: { id: 'task_1', title: 'Release notes' }, asked_by: 'Coordinator' }, ...over });
const blocked = { id: 'task:task_2', kind: 'unblock', source: { kind: 'task', id: 'task_2', version: '7' }, scope: sc, title: 'Waits on a key', reason: 'Blocked', open: { kind: 'task', id: 'task_2' },
  actions: [{ id: 'unblock', label: 'Unblock', path: '/api/tasks/task_2/unblock' }], at: now - 600_000, detail: { kind: 'blocked', reason: 'Needs the vault key <b>first</b>', blocked_by: 'Developer 9', blocked_at: now - 600_000, assignee: 'Developer 9' } };
const proposal = { id: 'proposal:bpp_1', kind: 'proposal', source: { kind: 'bp_proposal', id: 'bpp_1', version: 'open' }, scope: sc, title: 'Release notes for 4c', reason: 'From the coordinator', open: { kind: 'proposal', id: 'bpp_1', project_id: 'prj_c', team_id: 'team_a' },
  actions: [{ id: 'review', label: 'Review', input: true }, { id: 'apply', label: 'Apply', tone: 'ok' }, { id: 'reject', label: 'Reject' }], at: now - 60_000,
  detail: { kind: 'proposal', ops: [{ op: 'upsert', kind: 'release_note' }, { op: 'upsert', kind: 'release_note' }, { op: 'upsert', kind: 'decision' }, { op: 'remove', kind: 'fr' }] } };
const backlog = (id: string, title: string, mins: number) => ({ id: `backlog:${id}`, kind: 'backlog', source: { kind: 'task', id, version: '1' }, scope: sc, title, reason: 'From an agent', open: { kind: 'task', id }, actions: [{ id: 'accept', label: 'Accept' }], at: now - mins * 60_000 });

describe('Home: "N more" opens the Needs you screen', () => {
  it('counts the items after the card, in Home\'s order, and links to #needs; the old sheet is gone', () => {
    expect(home().map((x) => x.id)).toEqual(['ny_a', 'ny_b', 'ny_c', 'alr_a', 'aw_a']);
    const r = fn('function renderAlerts(');
    expect(r).toContain("row({ title: L.length > 1 ? `${L.length - 1} more` : 'Set aside'");
    // Rows this viewer set aside (Later) are named on the line, never counted in N.
    expect(r).toContain("S.ny?.later?.total ? `${S.ny.later.total} later` : ''");
    // Its "x need you · y for awareness · z alerts" counts the same N, not the card's item.
    expect(r).toContain('const M = L.slice(1), nN = M.filter(');
    // It opens the Needs you screen; with only set-aside rows behind the card, at its Later segment.
    expect(r).toContain("attrs: { 'data-go': 'needs', ...(L.length > 1 ? {} : { 'data-arg': 's=later' }) }");
    // Everything set aside: Home keeps a line that opens the Later list on the screen.
    expect(r).toContain("box.hidden = !a && !lt && !S.nyErr;");
    expect(r).toContain("row({ title: 'Nothing needs you', meta: `${lt} later`, chev: true, attrs: { 'data-go': 'needs', 'data-arg': 's=later' } })");
    expect(js).not.toMatch(/\bnyAll\b|data-ny-all/);
  });

  it('Later cuts every choice to the week, so "next Monday" on a Monday morning is not refused', () => {
    expect(js).toContain('const LATER_MAX_MS = 7 * 24 * 3600_000;');
    expect(fn('function nyLater(')).toContain('until = Math.min(until, Date.now() + LATER_MAX_MS)');
  });

  it('the security alerts log stays reachable from the Audit tabs', () => {
    expect(html).toMatch(/<button[^>]*data-go="log" data-arg="alerts"[^>]*>Alerts/);
  });
});

describe('The Needs you screen: each card leads with its title and is decided from the card', () => {
  const { cards, backlog: bl, aw } = screen([question(), blocked, proposal, backlog('task_8', 'Write the guide', 30), backlog('task_9', 'Old idea', 90)]);
  const [q, b, p] = cards;

  it('a team question: what it blocks, the question, then each answer once as a button with its effect, the recommended first and marked', () => {
    expect(q).toMatch(/^<article class="ny-card ny-q" data-ny-row="question:dec_1"><p class="ny-hd ny-qhd"><svg/);
    expect(q).toContain('<button type="button" class="pill warn pill-btn ny-blocks" data-task="team_a|task_1" title="Release notes" aria-label="Blocks 1 task: Release notes">Blocks 1 task</button><span>Conclave Developers · Coordinator · 1h ago</span></p><h3 class="ny-msg">Ship the release &lt;now&gt;?</h3><div class="ny-opts" role="group" aria-label="Answers">');
    // No meta line, no list of effects: the buttons carry them.
    expect(q).not.toContain('ny-meta');
    expect(q).not.toContain('recommends');
    expect(q).not.toContain('ny-fx');
    const a = q.indexOf('data-ny="question:dec_1|42|opt:a"'), w = q.indexOf('data-ny="question:dec_1|42|opt:b"');
    expect(a).toBeGreaterThan(-1);
    expect(a).toBeLessThan(w);
    expect(q).toContain('<button type="button" class="ny-opt rec" data-ny="question:dec_1|42|opt:a" data-ny-inline="note" data-ny-label="Ship now" aria-label="Choose: Ship now (recommended). Goes out today"><span class="ny-opt-l"><b>Ship now</b><span class="pill acc">Recommended</span></span><span class="ny-opt-fx">Goes out today</span></button>');
    expect(q).toContain('<button type="button" class="ny-opt" data-ny="question:dec_1|42|opt:b" data-ny-inline="note" data-ny-label="Wait a week" aria-label="Choose: Wait a week"><span class="ny-opt-l"><b>Wait a week</b></span></button>');
    expect(q).toContain('data-ny-reply aria-expanded="false">Add a note…<');
    expect(q).toContain('>Answer…<');
    expect(q).toContain('data-ny-note');
    expect(q).not.toContain('data-ny-need');
  });

  it('a question folds its context and the blocked task under Details', () => {
    expect(q).toContain('<div class="ny-acts ny-qfoot"><button type="button" class="btn ghost ny-qdet-btn" data-ny-qdet-btn aria-expanded="false">');
    expect(q).toContain('<div class="ny-qdet" data-ny-qdet hidden><article class="md ny-qdet-md"><p>Two fixes are in.</p></article><p class="ny-qdet-blk"><span class="meta">Blocks</span><button type="button" class="lnk" data-task="team_a|task_1">Release notes</button></p></div>');
    expect(q).not.toContain('ny-sum');
  });

  it('Home shows a question on top as the same card, with the "N more" row under it', () => {
    expect(fn('function urgent() {')).toContain("...(r.kind === 'question' && r.detail?.kind === 'question' ? { card: r } : {})");
    const r = fn('function renderAlerts(');
    expect(r).toContain(': (a.card ? nyQCard(a.card) : `<div class="alert');
    expect(r).toMatch(/<div class="alert-acts">\$\{a\.btns\}<\/div><\/div>`\)\s*\+ \(L\.length > 1/);
  });

  it('a question with no options, or an effect too long for a row, goes to Answer', () => {
    const { cards: [none] } = screen([question({ detail: { ...question().detail, options: [] } })]);
    expect(none).not.toContain('opt:');
    expect(none).toContain('>Answer<');
    const { cards: [long] } = screen([question({ detail: { ...question().detail, options: [{ key: 'a', label: 'Long', effect: 'x'.repeat(300) }, { key: 'b', label: 'Short', effect: null }] } })]);
    expect(long).not.toContain('opt:');
    expect(long).toContain('>Answer<');
  });

  it('every card offers Later once, in its ⋯ menu', () => {
    for (const c of cards) {
      expect(c.match(/data-ny-later=/g)).toHaveLength(1);
      expect(c.match(/data-ny-more /g)).toHaveLength(1);
      expect(c).toMatch(/<div class="ny-more-acts" hidden>.*data-ny-later=/);
    }
  });

  it('a blocked task leads with its title, its reason as the summary, then Unblock (no note) and Reply… (Send and unblock needs the note)', () => {
    expect(b).toContain('<span>Task blocked · Developer 9 · Conclave Developers · 10m ago</span></p><h3 class="ny-msg">Waits on a key</h3><p class="ny-sum">Needs the vault key &lt;b&gt;first&lt;/b&gt;</p>');
    expect(b).not.toContain('ny-meta');
    expect(b).not.toContain('no question was asked');
    expect(b).not.toContain('sends no note');
    expect(b).toMatch(/<div class="ny-reply" data-ny-reply-box hidden><textarea[^>]*data-ny-note[^>]*placeholder="Your note to Developer 9 and the coordinators"/);
    expect(b).toMatch(/data-ny="task:task_2\|7\|unblock" data-ny-inline="note" data-ny-need="1" data-ny-label="Reply and unblock">Send and unblock</);
    expect(b).toContain('data-ny-reply-x>Cancel<');
    expect(b).toMatch(/data-ny="task:task_2\|7\|unblock" data-ny-inline="none"[^>]*>Unblock</);
  });

  it('a proposal counts its changes as Blueprint Review names them', () => {
    expect(p).toContain('<h3 class="ny-msg">Release notes for 4c</h3><p class="ny-sum">What changes: <b>2 release notes, 1 decision, 1 removal</b></p>');
    expect(p).toContain('data-ny="proposal:bpp_1|open|apply"');
    expect(p).toContain('data-ny="proposal:bpp_1|open|reject"');
    expect(p).toContain('>Review<');
  });

  it('the backlog is one row with Open backlog, and For awareness keeps Dismiss', () => {
    expect(bl).toContain('<span>Backlog · 30m ago</span></p><h3 class="ny-msg">2 new briefs wait for you</h3><p class="ny-sum">Oldest: &quot;Write the guide&quot; (Conclave Developers).</p>');
    expect(bl).toContain('data-go="backlog"');
    expect(bl).not.toMatch(/accept|discard/);
    expect(aw).toContain('<h3 class="ny-msg">Writer is quiet</h3><p class="ny-sum">No news for 2 hours</p>');
    expect(aw).toContain('data-ny-dis="agent-x|e1"');
  });

  it('any row shows its step and who acts next, and a row back from Later says so', () => {
    const { cards: [c] } = screen([{ ...backlog('task_7', 'Handout', 5), kind: 'checkout', id: 'checkout:team_a', step: 'Step 3 of 5. The handout waits for your approval.', next: 'Then Echo Coordinator starts the new sessions.', back_from_later: true }]);
    expect(c.indexOf('Step 3 of 5.')).toBeGreaterThan(-1);
    expect(c.indexOf('Step 3 of 5.')).toBeLessThan(c.indexOf('Then Echo Coordinator'));
    expect(c).toContain('Back from Later');
  });

  it('the team page\'s Needs you card uses the same expanded row', () => {
    expect(fn('function teamAttention(')).toContain('const need = nyCards(ny?.items || []);');
  });

  it('#needs hangs under Home, rooted at a team or project when filtered', () => {
    expect(js).toContain("return t ? ['team', t] : p ? ['blueprint', bpArg(p, 'ov')] : homeUp(); }, label: () => 'Needs you' },");
    expect(js).toMatch(/ROUTE_OK[\s\S]*needs:/);
  });
});

/* Needs you fixes (docs/dashboard-ux.md, Needs you screen): every page is read, a failed read is never an all-clear, and the
   backlog links keep the entrance's scope. */
describe('Needs you reads every page and says when it could not', () => {
  const load = (pages: Record<string, unknown>) => {
    const calls: string[] = [];
    const ctx: Record<string, unknown> = { calls, api: async (q: string) => { calls.push(q); const p = pages[q]; if (!p) throw new Error('down'); return JSON.parse(JSON.stringify(p)); } };
    vm.createContext(ctx);
    vm.runInContext(`${part('const NY_Q = ', '\n')}${fn('async function nyRead(')}\nthis.nyRead = nyRead;`, ctx);
    return { nyRead: ctx.nyRead as (q: string) => Promise<any>, calls };
  };
  const rows = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: `q${from + i}` }));

  it('follows next_cursor to the end, so row 201 is in the list, with the filter on every page', async () => {
    const q = '/needs-you?limit=200&project=prj_b';
    const { nyRead, calls } = load({ [q]: { items: rows(1, 200), total: 201, next_cursor: '200', projects: { prj_b: 201 } }, [`${q}&cursor=200`]: { items: rows(201, 1), total: 201, next_cursor: null } });
    const nd = await nyRead(q);
    expect(nd.items).toHaveLength(201);
    expect(nd.items[200].id).toBe('q201');
    expect([nd.total, nd.next_cursor, nd.projects.prj_b]).toEqual([201, null, 201]);
    expect(calls).toEqual([q, `${q}&cursor=200`]);
  });

  it('a page that fails fails the whole read, so the caller can say the queue could not be checked', async () => {
    const q = '/needs-you?limit=200';
    const { nyRead } = load({ [q]: { items: rows(1, 200), total: 300, next_cursor: '200' } });
    await expect(nyRead(q)).rejects.toThrow('down');
  });

  it('no Needs you read turns an error into an empty list', () => {
    expect(js).not.toMatch(/api\(NY_Q/);
    expect(js).not.toMatch(/nyRead\([^)]*\)\.catch\(\(\) => NY_EMPTY\)/);
    const view = part('VIEWS.needs = async', '\n};\n');
    expect(view).toContain("if (!nd) return");
    expect(view).toContain('Could not check what waits for you');
    expect(view).toContain('id="nyRetry">Try again');
    // Home and the member card say so too, and Home never shows "Nothing needs you" over a failed read.
    const alerts = fn('function renderAlerts(');
    expect(alerts).toContain("'Could not check what needs you'");
    expect(alerts).toContain('lt && !S.nyErr');
    expect(fn('function muNeedsCard(')).toContain("if (MU.ndErr) return");
    expect(fn('async function muPoll(')).toContain('MU.ndErr = true');
  });

  it('Open backlog carries the entrance scope; from Home it has none', () => {
    const ctx = ctx0({ teams: [{ id: 'team_a', name: 'Conclave Developers' }] });
    vm.createContext(ctx);
    const r = vm.runInContext(ROW.join('\n') + `\n[nyBacklogCard([${JSON.stringify(backlog('task_9', 'Write the notes', 5))}], 'team=team_a&from=needs'), nyBacklogCard([${JSON.stringify(backlog('task_9', 'Write the notes', 5))}])]`, ctx) as string[];
    expect(r[0]).toContain('data-go="backlog" data-arg="team=team_a&amp;from=needs">Open backlog');
    expect(r[1]).toContain('data-go="backlog">Open backlog');
  });
});
