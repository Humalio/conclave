/**
 * The operator's second console pass for 0.9.6: the checkout screen has a visible Cancel checkout while the checkout is open
 * (1), Create restore prompt shows the required unmerged-work box and its reason instead of failing with a toast (2), and
 * Needs you folds identical items into one row with a count, so a burst of vault conflicts does not bury the rest (3).
 * Read from the source files; the Needs you helpers run in a sandbox, as in console-home-needs.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { mdPlain } from '../public/md.js';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
const at = (s: string) => { const i = js.indexOf(`\n${s}`); if (i < 0) throw new Error(`app.js has no ${s}`); return i + 1; };
const part = (s: string, end: string) => { const i = at(s); return js.slice(i, js.indexOf(end, i) + end.length); };
const line = (name: string) => part(`const ${name} = `, '\n');
const fn = (head: string) => part(head, '\n}\n');

describe('1. Cancel checkout on the checkout screen', () => {
  const view = fn('async function coView(');
  it('the header has a Cancel checkout button while the checkout is open, wired to the same sheet', () => {
    expect(view).toContain("a: open ? `<button type=\"button\" class=\"btn sm bad\" id=\"coCancel\">${ic('ban')}Cancel checkout</button>` : '',");
    expect(view).toContain("if ($('#coCancel')) $('#coCancel').onclick = () => coCancel(c, cP, re);");
    expect(view).not.toContain('moreBtn()');
  });
  it('the phone menu keeps it', () => {
    expect(view).toContain("const menu = [open ? { label: 'Cancel checkout', icon: 'ban', bad: true, fn: () => coCancel(c, cP, re) } : null];");
    expect(view).toContain("dbar: { title: 'Checkout', menu },");
  });
  it('the team page redraws once when a checkout starts or ends, so its menu says Open checkout', () => {
    const fill = fn('async function coTeamFill(');
    expect(fill).toContain("had = !!CO.team[t.id]; CO.team[t.id] = html;");
    expect(fill).toContain("if (had !== !!html && DR.type === 'team' && DR.arg === t.id) return openD('team', t.id, true);");
  });
});

describe('2. Create restore prompt and the unmerged work', () => {
  const form = fn('function coFormHtml(');
  const wire = fn('function coFormWire(');
  it('the box is a required field with its reason above it', () => {
    expect(form).toContain("overline('Unmerged work', null, pill('Required', 'warn'))");
    expect(form).toContain('It cannot move to the target: it stays on ${esc(unmPc)}. Tick the box to go on.');
    expect(form).toContain('id="coAccept" required aria-required="true" aria-describedby="coAcceptWhy"');
  });
  it('a press without it shows the reason at the box, scrolled into view, not only a toast', () => {
    expect(wire).not.toContain("toast('Tick the box to leave the unmerged work on the source PC', true)");
    expect(wire).toContain("x.closest('.fld').scrollIntoView({ block: 'center' }); fieldErr(x, `Tick this box first: the unmerged work stays on ${coPc(c.source_machine_id)} and does not move to the target.`);");
    // fieldErr puts the message under the field with role=alert and marks the box invalid.
    expect(fn('function fieldErr(')).toContain("m.setAttribute('role', 'alert')");
  });
  it('the box and its error have their own layout', () => {
    expect(css).toContain('.co-req{display:flex;flex-direction:column;gap:var(--s2)}');
  });
});

describe('3. Needs you folds identical items', () => {
  const now = Date.now();
  const req = (id: string, title: string, mins: number) => ({ id, kind: 'access_request', source: { kind: 'request', id: 'req_' + id, version: 'v1' }, scope: { project_id: null, team_id: null },
    title, reason: 'Inside your ceiling', open: { kind: 'request', id: 'req_' + id }, actions: [{ id: 'approve', label: 'Approve', tone: 'ok' }, { id: 'deny', label: 'Deny' }], at: now - mins * 60_000 });
  const conflict = (n: number) => ({ id: 'conflict:fc_' + n, kind: 'vault_conflict', source: { kind: 'file_conflict', id: 'fc_' + n, version: 'open' }, scope: { project_id: null, team_id: null },
    title: `Vault conflict · Stress/c1/append-${n}.md · Choose`, reason: '', open: { kind: 'file_conflict', id: 'fc_' + n }, actions: [], at: now - n * 60_000 });
  const ROW = [part('function mdText(', '\n'), ...['ic', 'esc', 'ago', 'plural', 'trunc', 'raw', 'txt', 'safeHref', 'cap', 'none', 'pill'].map(line), part('const overline = ', '\n'), part('const NY_KIND = ', '};\n'),
    line('nyKind'), fn('function nyOpenAttr('), line('nyActAttrs'), line('nyLaterBtn'), fn('function nyBtns('), fn('function awBtns('), line('nyUntil'), line('nyOffline'), line('nySum'), line('nyMeta'), line('nyLead'), line('nyRow'), line('awRow'), fn('function row('),
    line('NY_EFFECT_MAX'), part('const nyWho = ', '; };\n'), line('nyTeamOf'), line('nyHeadLine'), line('nyHead'), fn('function nyOpsLine('), line('nyReplyBtn'), line('nyReplyBox'), line('nyOpenBtn'), line('nyActBtn'), fn('function nyBody('), line('NY_QDET'), fn('function nyQCard('),
    part('const nyCardBox = ', '</article>`;\n'), fn('function nyCard('), fn('function nyCards('), part('const nyConflictCard = ', "Open conflicts</button>']);\n")];
  const cards = (rows: unknown[]) => {
    const ctx = { S: { teams: [] }, Date, mdPlain, mdDoc: (t: string) => `<p>${t}</p>`, NAV_NAMES: new Map(), BP_KIND: {}, dt: () => '', K: () => undefined, AG: () => undefined, keyName: () => '', bpArg: () => '', bpItemArg: () => '', stOf: () => ['', '', ''], rows };
    vm.createContext(ctx);
    return vm.runInContext(ROW.join('\n') + '\nnyCards(rows);', ctx) as string[];
  };

  it('every vault conflict becomes one card with the count, which opens Vault → Conflicts; the real items stay on top', () => {
    const out = cards([conflict(1), req('a', 'Developer 1 asks to write notes', 5), conflict(2), conflict(3)]);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('Developer 1 asks to write notes');
    expect(out[1]).toContain('3 vault conflicts wait for you');
    expect(out[1]).toContain('data-go="vault" data-arg="conf"');
    expect(out[1]).not.toContain('append-2.md');
  });
  it('one vault conflict stays its own card', () => {
    const out = cards([conflict(1)]);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('append-1.md');
  });
  it('rows of the same kind and title show the first card and "Show N more like this", with the others kept, folded', () => {
    const out = cards([req('a', 'Developer 1 asks to write notes', 5), req('b', 'Developer 1 asks to write notes', 4), req('c', 'Developer 1 asks to write notes', 3), req('d', 'Developer 2 asks to read plans', 2)]);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('Developer 2 asks to read plans');
    expect(out[1]).toContain('data-ny-grp');
    expect(out[1]).toContain('Show 2 more like this');
    expect(out[1]).toContain('<div class="ny-grp-more" hidden>');
    for (const id of ['a', 'b', 'c']) expect(out[1]).toContain(`data-ny-row="${id}"`);
  });
  it('questions never fold', () => {
    const q = (id: string) => ({ ...req(id, 'Which release?', 1), kind: 'question' });
    expect(cards([q('q1'), q('q2')])).toHaveLength(2);
  });
  it('the screen and the team page both use it, and the fold opens and closes', () => {
    expect(js).toContain("    : nyCards(rest).join('') + (bl.length ? nyBacklogCard(bl, blTo('')) : '')");
    expect(js).toContain('const need = nyCards(ny?.items || []);');
    expect(js).toContain("const nyg = t.closest('[data-ny-grp-btn]'); if (nyg) { nyGrpToggle(nyg); return; }");
    expect(fn('function nyGrpToggle(')).toContain("b.querySelector('span').textContent = on ? 'Show fewer' : `Show ${n} more like this`;");
    expect(css).toContain('.ny-grp-more[hidden]{display:none}');
  });
});
