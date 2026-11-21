/**
 * Operator console, Needs you cards (the Needs you screen and the team page's Needs you section): separate cards that lead
 * with the item's title (one small meta line, the title as the heading, a three-line summary), at most three buttons with the rest in
 * ⋯, Reply… opening the note box in the card, full-width buttons on phones, and no left accents anywhere in the console.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { mdPlain } from '../public/md.js';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
const guide = readFileSync(join(process.cwd(), '..', 'docs', 'design-guidelines.md'), 'utf8').replace(/\r\n/g, '\n');
const at = (s: string) => { const i = js.indexOf(`\n${s}`); if (i < 0) throw new Error(`app.js has no ${s}`); return i + 1; };
const part = (s: string, end: string) => { const i = at(s); return js.slice(i, js.indexOf(end, i) + end.length); };
const line = (name: string) => part(`const ${name} = `, '\n');
const fn = (head: string) => part(head, '\n}\n');

const SRC = [part('function mdText(', '\n'), ...['ic', 'esc', 'ago', 'plural', 'trunc', 'cap', 'pill'].map(line), part('const NY_KIND = ', '};\n'), line('nyKind'), fn('function nyOpenAttr('),
  line('nyActAttrs'), line('nyLaterBtn'), fn('function awBtns('), line('nyUntil'), line('nyOffline'), line('nySum'), line('NY_EFFECT_MAX'), part('const nyWho = ', '; };\n'), line('nyTeamOf'), line('nyHeadLine'), line('nyHead'), fn('function nyOpsLine('),
  line('nyReplyBtn'), line('nyReplyBox'), line('nyOpenBtn'), line('nyActBtn'), fn('function nyBody('), line('NY_QDET'), fn('function nyQCard('), part('const nyCardBox = ', '</article>`;\n'), fn('function nyCard(')].join('\n');
const card = (r: unknown) => {
  const ctx: Record<string, unknown> = { S: { teams: [{ id: 'team_a', name: 'Conclave Developers' }] }, Date, mdPlain, mdDoc: (t: string) => `<p>${t}</p>`, NAV_NAMES: new Map([['prj_c', 'Conclave']]), BP_KIND: {}, dt: () => '', bpArg: () => '', bpItemArg: () => '', r };
  vm.createContext(ctx);
  return vm.runInContext(`${SRC}\nnyCard(r)`, ctx) as string;
};
const now = Date.now();
const sc = { project_id: 'prj_c', team_id: 'team_a' };
const blocked = { id: 'task:t1', kind: 'unblock', source: { kind: 'task', id: 't1', version: '3' }, scope: sc, title: 'One consistent page header', reason: 'Blocked', open: { kind: 'task', id: 't1', team_id: 'team_a' },
  actions: [{ id: 'unblock', label: 'Unblock' }], at: now - 60_000, detail: { kind: 'blocked', reason: 'Review the brief. Say go.', blocked_by: 'Coordinator', blocked_at: now - 60_000, assignee: 'Developer 9' } };
const other = { id: 'request:r1', kind: 'access_request', source: { kind: 'request', id: 'r1', version: '1' }, scope: sc, title: 'Developer 1 asks to write notes', reason: 'Inside your ceiling', open: { kind: 'request', id: 'r1' },
  actions: [{ id: 'approve', label: 'Approve', tone: 'ok' }, { id: 'deny', label: 'Deny' }, { id: 'later2', label: 'Ask again' }], at: now - 120_000 };
// The visible buttons: from the start of the button row to the ⋯ button.
const acts = (c: string) => { const i = c.indexOf('<div class="ny-acts">'); return c.slice(i, c.indexOf('data-ny-more', i)); };

describe("Needs you cards lead with the item's title", () => {
  it('one meta line (kind, who, for whom, team, age), then the title as the heading, then its summary, in that order', () => {
    const c = card(blocked);
    const order = ['<p class="ny-hd"><svg', '<span>Task blocked · Coordinator · for Developer 9 · Conclave Developers · 1m ago</span></p>', '<h3 class="ny-msg">One consistent page header</h3>',
      '<p class="ny-sum">Review the brief. Say go.</p>', '<div class="ny-acts">'].map((s) => c.indexOf(s));
    expect(order.every((x) => x > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(c).not.toContain('class="pill'); // the meta line replaces the pill
    expect(c).not.toContain('ny-meta'); // and the separate team line
  });

  it('the meta line names the team, not also the project, and never says how long it waited twice', () => {
    const c = card(blocked);
    expect(c).not.toContain('Conclave ·');
    expect(c).not.toContain('waiting');
    expect(card({ ...blocked, scope: { project_id: 'prj_c', team_id: null } })).toContain('for Developer 9 · Conclave · 1m ago</span>');
  });

  it("the hub's summary and sender lead over the reason; a null summary leaves no third line and no generic instruction", () => {
    const bl = { ...other, id: 'backlog:t2', kind: 'backlog', title: 'Photograph the dump-resistor bay', reason: 'Proposed by Conclave Developers · accept or discard', by: 'Coordinator', summary: 'Take four photos of the bay.' };
    const c = card(bl);
    expect(c).toContain('<span>New brief · Coordinator · Conclave Developers · 2m ago</span>');
    expect(c).toContain('<h3 class="ny-msg">Photograph the dump-resistor bay</h3><p class="ny-sum">Take four photos of the bay.</p>');
    expect(c).not.toContain('accept or discard');
    const none = card({ ...bl, summary: null });
    expect(none).not.toContain('ny-sum');
    expect(none).not.toContain('accept or discard');
    // A kind the hub sends no summary for still shows its reason.
    expect(card(other)).toContain('<p class="ny-sum">Inside your ceiling</p>');
    // A blocked task's summary is the hub's (the block reason) when it sends one.
    expect(card({ ...blocked, summary: 'Waits for the brief.' })).toContain('<p class="ny-sum">Waits for the brief.</p>');
  });

  it('at most three buttons on the card, the main decision first; the rest and Later are in ⋯', () => {
    const c = card(other), a = acts(c);
    expect(a.match(/<button/g)!.length).toBe(3); // two actions and the ⋯ button
    expect(a).toMatch(/^<div class="ny-acts"><button type="button" class="btn pri" data-ny="request:r1\|1\|approve"/);
    expect(c).toMatch(/<div class="ny-more-acts" hidden>.*data-ny="request:r1\|1\|later2".*data-ny-later=/);
    expect(c).toContain('class="btn ic ny-more" data-ny-more aria-haspopup="true" aria-label="More actions: Developer 1 asks to write notes"');
  });

  it('a card with no reason keeps its title as the heading and has no summary line', () => {
    const c = card({ ...other, reason: '' });
    expect(c).toContain('<h3 class="ny-msg">Developer 1 asks to write notes</h3><div class="ny-acts">');
    expect(c).not.toContain('class="ny-sum"');
  });

  it('a question leads with what it blocks and who asks, then itself; the recommendation is on its button, not on a meta line', () => {
    const c = card({ id: 'question:q2', kind: 'question', source: { kind: 'question', id: 'q2', version: '1' }, scope: sc, title: 'Ship now?', reason: '', open: { kind: 'question', id: 'q2' }, actions: [], at: now - 60_000,
      by: 'Coordinator', summary: 'The gate passed.', detail: { kind: 'question', context: 'The gate passed.', asked_by: 'Coordinator', blocks: { id: 'task_g', title: 'Gate task' }, recommended: 'a', options: [{ key: 'a', label: 'Ship now' }, { key: 'b', label: 'Wait' }] } });
    expect(c).toContain('>Blocks 1 task</button><span>Conclave Developers · Coordinator · 1m ago</span></p><h3 class="ny-msg">Ship now?</h3><div class="ny-opts"');
    expect(c).not.toContain('ny-meta');
    expect(c).not.toContain('recommends');
    expect(c).toContain('class="ny-opt rec" data-ny="question:q2|1|opt:a"');
  });

  it('Reply… opens the note box in place of the buttons; ⋯ runs the hidden buttons and Later opens at ⋯', () => {
    expect(js).toContain("const nyr = t.closest('[data-ny-reply]'); if (nyr) { nyReply(nyr); return; }");
    expect(js).toContain("const nym = t.closest('[data-ny-more]'); if (nym) { nyMore(nym); return; }");
    expect(fn('function nyMore(')).toContain("fn: () => nyLater(btn, h.dataset.nyLater, nyAfter)");
    expect(fn('function nyMore(')).toContain('fn: () => h.click()');
    expect(css).toContain('.ny-card:has(>.ny-reply:not([hidden]))>.ny-acts{display:none}');
    // An action from ⋯ that asks for a note opens its sheet at the ⋯ button, not at its hidden button.
    expect(fn('function nyAct(')).toContain("const anchor = (b.closest('[hidden]') && b.closest('[data-ny-row]')?.querySelector('[data-ny-more]')) || b;");
  });

  it('the old Details fold and helper texts are gone', () => {
    expect(js).not.toContain('data-ny-det');
    expect(js).not.toContain('Ask for more and Decline are on the question');
    expect(css).not.toContain('.ny-det');
  });
});

describe('Needs you card styles', () => {
  it('separate cards with a gap, on the team page too, the title in the 16 px lead type and the summary cut to three lines', () => {
    expect(css).toContain('--t-lead:400 16px/24px var(--font-sans);');
    expect(css).toContain('.ny-msg{margin:0;font:var(--t-lead);');
    expect(css).toContain('.ny-sum{margin:0;font:var(--t-body);color:var(--muted);white-space:pre-wrap;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}');
    expect(css).toContain('.ny-hd{display:flex;gap:var(--s2);align-items:flex-start;margin:0;font:var(--t-meta);color:var(--muted);');
    expect(guide).toContain('Top: one meta line, `--t-meta` muted');
    expect(css).toContain('[data-ny-box="team"] .ny-card{background:var(--panel-2)}');
    expect(css).not.toMatch(/\[data-ny-box="team"\] \.ny-card\{[^}]*border:0/);
    expect(css).toContain('.ny-card+.ny-card,[data-ny-box]>div>.ny-card:first-child{margin-top:var(--s3)}');
  });

  it('phones keep the order with full-width buttons', () => {
    expect(css).toContain('  .ny-acts .btn{height:var(--h-touch);flex:1 1 100%;justify-content:center}');
  });

  it('no left accents anywhere in the console', () => {
    expect(css).not.toMatch(/border-(left|inline-start):\s*[3-9]px/);
    expect(css).not.toMatch(/border-(left|inline-start):\s*[2-9]px[^;}]*var\(--(warn|bad|ok|info|accent)/);
    expect(css).not.toContain('.ny-reason');
    expect(guide).toContain('8. **No left accents.**');
    expect(guide).toContain('| `--t-lead` | 400 16/24 |');
    expect(guide).toContain('| Needs you card | `.ny-card` |');
  });
});

describe('a question reads at a glance: each answer once, with its effect, and the rest under Details', () => {
  const q = { id: 'question:q1', kind: 'question', source: { kind: 'question', id: 'q1', version: '1' }, scope: sc, title: 'Which path for the gate?', reason: '', open: { kind: 'question', id: 'q1' },
    actions: [], at: now - 60_000, detail: { kind: 'question', context: 'The gate **slipped**.', blocks: { id: 'task_g', title: 'Gate task' }, recommended: 'b', options: [
      { key: 'a', label: 'Approve', effect: 'Ships the amendment today.' }, { key: 'b', label: 'Hold', effect: 'Waits a week for the reviewer.' }, { key: 'c', label: 'Split', effect: 'Ships half now, half later.' }] } };
  // What a reader sees before opening anything: the card up to Details' panel and the note box.
  const shown = (c: string) => c.slice(0, c.indexOf('<div class="ny-qdet"'));

  it('every answer appears once on the card, as a button with its effect under it, the recommended one first', () => {
    const c = card(q), v = shown(c);
    for (const [l, fx] of [['Approve', 'Ships the amendment today.'], ['Hold', 'Waits a week for the reviewer.'], ['Split', 'Ships half now, half later.']]) {
      expect(v.split(`<b>${l}</b>`).length - 1).toBe(1);
      expect(v.split(`<span class="ny-opt-fx">${fx}</span>`).length - 1).toBe(1);
      expect(v).toMatch(new RegExp(`<b>${l}</b>(<span class="pill acc">Recommended</span>)?</span><span class="ny-opt-fx">${fx.replace('.', '\\.')}</span></button>`));
    }
    expect(v.indexOf('opt:b')).toBeLessThan(v.indexOf('opt:a'));
    expect(v.indexOf('opt:a')).toBeLessThan(v.indexOf('opt:c'));
    // Every answer is on the card, none only in ⋯.
    const m = c.slice(c.indexOf('<div class="ny-more-acts" hidden>')); expect(m.slice(0, m.indexOf('</div>'))).not.toContain('opt:');
  });

  it('the recommended answer has the accent border and the Recommended tag, once; no meta line repeats it', () => {
    const c = shown(card(q));
    expect(c.match(/class="ny-opt rec"/g)).toHaveLength(1);
    expect(c).toContain('class="ny-opt rec" data-ny="question:q1|1|opt:b"');
    expect(c.match(/Recommended/g)).toHaveLength(1);
    expect(c).not.toContain('ny-meta');
    expect(css).toContain('.ny-opt.rec{border-color:var(--accent)}');
  });

  it('Details is a folded button with aria-expanded; it holds the context as Markdown and the blocked task as a link', () => {
    const c = card(q);
    expect(c).toContain('<button type="button" class="btn ghost ny-qdet-btn" data-ny-qdet-btn aria-expanded="false">');
    expect(c).toContain('<div class="ny-qdet" data-ny-qdet hidden><article class="md ny-qdet-md"><p>The gate **slipped**.</p></article>');
    expect(c).toContain('<p class="ny-qdet-blk"><span class="meta">Blocks</span><button type="button" class="lnk" data-task="team_a|task_g">Gate task</button></p>');
    expect(shown(c)).not.toContain('slipped');
    // The fold is this viewer's, for this page: a set in memory, never sent to the hub.
    const t = fn('function nyQDet(');
    expect(t).toContain("b.setAttribute('aria-expanded', String(on));");
    expect(t).toContain('NY_QDET.add(card.dataset.nyRow)');
    expect(t).not.toMatch(/post\(|api\(|localStorage/);
    expect(js).toContain("const nyq = t.closest('[data-ny-qdet-btn]'); if (nyq) { nyQDet(nyq); return; }");
  });

  it('the Blocks chip is warn-toned, names the task in its tooltip and opens it', () => {
    expect(card(q)).toContain('<button type="button" class="pill warn pill-btn ny-blocks" data-task="team_a|task_g" title="Gate task" aria-label="Blocks 1 task: Gate task">Blocks 1 task</button>');
    // Without a team to open it in, the chip is plain text.
    expect(card({ ...q, scope: { project_id: 'prj_c', team_id: null } })).toContain('<span class="pill warn ny-blocks" title="Gate task">Blocks 1 task</span>');
    // No task blocked: no chip, and no Details unless there is context.
    const free = card({ ...q, detail: { ...q.detail, blocks: null, context: null } });
    expect(free).not.toContain('ny-blocks');
    expect(free).not.toContain('data-ny-qdet');
  });

  it('the answer buttons send the same choice as before: the option key, with the note when one is written', () => {
    const c = card(q);
    for (const k of ['a', 'b', 'c']) expect(c).toMatch(new RegExp(`class="ny-opt( rec)?" data-ny="question:q1\\|1\\|opt:${k}" data-ny-inline="note" data-ny-label="`));
    // Add a note… opens the note box, which keeps one button per answer.
    expect(c).toMatch(/<div class="ny-reply" data-ny-reply-box hidden>.*data-ny="question:q1\|1\|opt:b".*data-ny="question:q1\|1\|opt:a".*data-ny="question:q1\|1\|opt:c"/);
    expect(css).toContain('.ny-card:has(>.ny-reply:not([hidden]))>.ny-opts{display:none}');
    expect(js).toContain("const nyb = t.closest('[data-ny]'); if (nyb) { nyAct(nyb, nyb.dataset.ny, nyAfter); return; }");
  });

  it('answers are full-width buttons with 3 px corners, on phones too', () => {
    expect(css).toContain('.ny-opts{display:flex;flex-direction:column;');
    expect(css).toMatch(/\.ny-opt\{[^}]*width:100%;[^}]*border-radius:var\(--r-chip\)/);
  });
});
