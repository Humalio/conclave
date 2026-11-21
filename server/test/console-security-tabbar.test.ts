/**
 * The workspace tab bars (docs/design-guidelines.md, Workspace tab bar): one row at every width. Security's tabs never wrap
 * (they scroll sideways when they do not fit) and one "New" button, an action and not a tab, sits at the right end of the same
 * row, apart from the tabs: its menu creates a session key, an app key or a permission template, or opens every access option
 * (Agent access). On a phone Agent access stays the last tab.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const pub = (f: string) => readFileSync(join(process.cwd(), 'public', f), 'utf8').replace(/\r\n/g, '\n');
const html = pub('index.html'), css = pub('style.css');
const bar = html.slice(html.indexOf('id="securityBar"'), html.indexOf('id="vaultBar"'));
const appJs = () => pub('app.js');

describe('Security tab bar', () => {
  it('the desktop tabs no longer hold Agent access; one New menu button sits beside them in the same row', () => {
    const seg = bar.slice(bar.indexOf('<nav class="seg ws-tabs'), bar.indexOf('</nav>'));
    expect(seg).not.toContain('data-go="grant"');
    for (const g of ['keys', 'pcs', 'hardware', 'users', 'req', 'shares']) expect(seg, g).toContain(`data-go="${g}"`);
    expect(seg).not.toContain('data-go="reset"'); // Reset is in Lockdown's danger zone, not a tab
    const row = bar.slice(bar.indexOf('<div class="ws-row only-d">'), bar.indexOf('</div>'));
    expect(row).toContain('<nav class="seg ws-tabs');
    expect(row).toContain('<button type="button" class="btn sm ws-grant" data-sec-new aria-haspopup="true"><svg class="i"><use href="#i-plus"/></svg>New<svg class="i"><use href="#i-cdown"/></svg></button>');
    expect(row).not.toContain('data-go="grant"');
  });
  it('the phone tabs end with Agent access, have no Reset tab and no New button', () => {
    const m = bar.slice(bar.indexOf('<nav class="tabs only-m"'));
    expect([...m.slice(0, m.indexOf('</nav>')).matchAll(/data-go="([a-z]+)"/g)].map((x) => x[1])).toEqual(['keys', 'pcs', 'hardware', 'users', 'req', 'shares', 'db', 'grant']);
    expect(m).not.toContain('data-sec-new');
  });
  it('Reset is a danger zone at the end of the Lockdown page, for admins only (operator walk-through finding 3)', () => {
    expect(html).not.toContain('data-go="reset"');
    const js = appJs();
    const dangerFn = js.slice(js.indexOf('const lkDanger = '), js.indexOf('VIEWS.lock = '));
    expect(dangerFn).toContain("S.me?.role !== 'admin' ? ''");
    expect(dangerFn).toContain("kd('Danger zone')");
    expect(dangerFn).toContain('data-go="reset"');
    expect(dangerFn).toContain('nothing is removed until you confirm with your password');
    const lock = js.slice(js.indexOf('VIEWS.lock = '), js.indexOf('\n};\n', js.indexOf('VIEWS.lock = ')));
    expect(lock).toContain("'<div id=\"lkNone\" hidden></div>' + lkDanger(),");
  });
  it('a workspace tab bar is one row: the tabs never wrap and scroll sideways instead', () => {
    expect(css).toContain('.ws-tabs{flex-wrap:nowrap;overflow-x:auto;max-width:100%;min-width:0;scrollbar-width:none}');
    expect(css).not.toMatch(/\.ws-tabs\{flex-wrap:wrap\}/);
    expect(css).toContain('.ws-tabs button{flex:none}');
    // The strip clips what is outside it, so the focus ring sits inside the button.
    expect(css).toContain('.ws-tabs button:focus-visible{outline-offset:-2px}');
    expect(css).toContain('.ws-row{display:flex;align-items:center;gap:var(--s3);flex:1 1 420px;min-width:0}');
    expect(css).toContain('.ws-grant{flex:none;margin-left:auto}');
    // In the view card the Security row fills the card's width, so New sits at its right end, not right after the tabs.
    expect(css).toContain('#workspaceView>#securityBar>.ws-row{flex:1 1 100%}');
  });
});

const js = pub('app.js');
const part = (start: string, end: string) => { const i = js.indexOf(start); if (i < 0) throw new Error(`app.js has no ${start}`); return js.slice(i, js.indexOf(end, i) + end.length); };

describe('the Security bar\'s New menu', () => {
  const went: string[] = [];
  let sheet = '';
  const sh = { listeners: [] as ((e: unknown) => void)[], addEventListener(_: string, f: (e: unknown) => void) { this.listeners.push(f); } };
  const ctx = vm.createContext({
    go: (t: string) => went.push(t), esc: (x: string) => x, ic: (n: string) => `<i data-ic="${n}"></i>`, closeSheet: () => {},
    openSheet: (o: { html: string }) => { sheet = o.html; return sh; },
  });
  vm.runInContext(part('const SEC_NEW = ', '}];\n') + part('function openMenu(', '\n}\n') + '\nthis.F = { SEC_NEW, openMenu };', ctx);
  const F = (ctx as unknown as { F: Record<string, any> }).F;

  it('lists Session key, App key and Permission template, then a divider and All access options; each opens its route', () => {
    const items = F.SEC_NEW();
    expect(items.map((m: { label?: string; divider?: boolean }) => m.divider ? '---' : m.label)).toEqual(['Session key', 'App key', 'Permission template', '---', 'All access options']);
    for (const m of items) if (m.fn) m.fn();
    expect(went).toEqual(['new', 'app', 'tplnew', 'grant']);
  });

  it('draws the divider as a rule between the items, in the console\'s menu, and a click runs the item', () => {
    went.length = 0;
    F.openMenu(F.SEC_NEW(), {});
    expect(sheet.match(/class="sheet-item"/g)).toHaveLength(4);
    expect(sheet).toMatch(/Permission template<\/span><\/button><hr class="sheet-sep"><button type="button" class="sheet-item" data-ovf="4">/);
    expect(sheet).toContain('<span class="sheet-val">for an agent</span>');
    const b = { dataset: { ovf: '4' }, classList: { contains: () => false } };
    sh.listeners[0]!({ target: { closest: () => b } });
    expect(went).toEqual(['grant']);
    expect(css).toContain('.sheet-list .sheet-sep{border:0;border-top:1px solid var(--line);margin:var(--s1) 0}');
  });

  it('is wired: the button opens the menu, and it is lit while a key, a template or Agent access is open', () => {
    expect(js).toContain("const sn = t.closest('[data-sec-new]'); if (sn) { openMenu(SEC_NEW(), sn); return; }");
    expect(js).toContain("grant: 'grant', new: 'grant', app: 'grant', tpls: 'grant', tplnew: 'grant',");
    expect(js).toContain("$$('#securityBar [data-sec-new]').forEach(button => highlight(button, securityTab === 'grant'));");
  });

  it('the Keys header no longer has Session or App buttons; its filters and search stay', () => {
    const keys = part('  async keys() {', '\n  },\n');
    expect(keys).not.toContain('data-go="new"');
    expect(keys).not.toContain('data-go="app"');
    expect(keys).not.toMatch(/\ba: `/);
    expect(keys).toContain('id="fKind"');
    expect(keys).toContain('id="fMore"');
  });
});
