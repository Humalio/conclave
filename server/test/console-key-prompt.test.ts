/**
 * Key prompts in the console (docs/onboarding.md#key-prompts-a-new-rotated-or-reissued-session-key, docs/dashboard-ux.md):
 * the one-time view guard asks "You haven't copied this prompt. Close anyway?" before a key prompt, raw key or onboarding
 * prompt closes uncopied (Back, Escape, the scrim, the rail, a link), and Copy or the key's first login lifts it; nothing on
 * these screens downloads; a session key that never logged in has Make a new prompt on its Overview, the same act as Rotate.
 * The guard runs from public/app.js in vm with stub sheets.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import vm from 'node:vm';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const g0 = js.indexOf('let ONCE = null;'), g1 = js.indexOf("addEventListener('beforeunload'", g0);
const guard = js.slice(g0, g1);
const fn = (name: string) => { const i = js.indexOf(`function ${name}(`); return js.slice(i, js.indexOf('\n}\n', i) + 3); };

type Sheet = { title: string; fields: string; label: string; tone: string; dismiss: string; onGo: () => unknown };
function harness(sheetHolds = false) {
  const appended: { className: string; innerHTML: string; listeners: Record<string, (e: unknown) => void> }[] = [];
  const el = { isConnected: true, focus() {}, contains: () => false };
  const sheetEl = { contains: (x: unknown) => sheetHolds && x === el, append: (n: never) => appended.push(n) };
  const out: { sheet?: Sheet; went: number; appended: typeof appended } = { went: 0, appended };
  const timers: (() => void)[] = [];
  const ctx: Record<string, unknown> = {
    SHEET: sheetHolds ? { sh: sheetEl } : null,
    fbSheet: (s: Sheet) => { out.sheet = s; },
    setTimeout: (f: () => void) => { timers.push(f); },
    $: (sel: string, root: { _q?: unknown }) => (sel === '.once-q' ? appended[0] ?? null : { focus() {} }),
    document: { createElement: () => { const n = { className: '', innerHTML: '', listeners: {} as Record<string, (e: unknown) => void>, setAttribute() {}, addEventListener(t: string, f: (e: unknown) => void) { n.listeners[t] = f; } }; return n; } },
  };
  vm.createContext(ctx);
  vm.runInContext(`${guard}\nthis.arm = onceArm; this.blocked = onceBlocked; this.once = () => ONCE;`, ctx);
  return { ctx, el, out, timers, go: () => { out.went++; } };
}

describe('console: the one-time view guard', () => {
  it('nothing armed, a copied prompt, or one no longer on screen lets the screen close', () => {
    const h = harness();
    expect((h.ctx.blocked as (g: () => void) => boolean)(h.go)).toBe(false);
    (h.ctx.arm as (e: unknown) => void)(h.el);
    (h.ctx.once as () => { copied: boolean })().copied = true;
    expect((h.ctx.blocked as (g: () => void) => boolean)(h.go)).toBe(false);
    (h.ctx.arm as (e: unknown) => void)(h.el);
    h.el.isConnected = false;
    expect((h.ctx.blocked as (g: () => void) => boolean)(h.go)).toBe(false);
    expect(h.out.sheet).toBeUndefined();
  });
  it('an uncopied key prompt on a screen asks first; Close anyway leaves, Keep it open stays', () => {
    const h = harness();
    (h.ctx.arm as (e: unknown) => void)(h.el);
    expect((h.ctx.blocked as (g: () => void) => boolean)(h.go)).toBe(true);
    expect(h.out.sheet!.fields).toContain("You haven't copied this prompt. Close anyway?");
    expect([h.out.sheet!.label, h.out.sheet!.dismiss, h.out.sheet!.tone]).toEqual(['Close anyway', 'Keep it open', 'bad']);
    expect(h.out.went).toBe(0);
    // Keep it open is the sheet's dismiss: nothing happens and the guard stays.
    expect((h.ctx.blocked as (g: () => void) => boolean)(h.go)).toBe(true);
    expect(h.out.sheet!.onGo()).toBeNull();
    expect((h.ctx.once as () => unknown)()).toBeNull();
    h.timers.forEach((f) => f());
    expect(h.out.went).toBe(1);
  });
  it('an uncopied prompt inside a sheet (Add PC, Re-enrol) asks in a row at its foot', () => {
    const h = harness(true);
    (h.ctx.arm as (e: unknown) => void)(h.el);
    expect((h.ctx.blocked as (g: () => void) => boolean)(h.go)).toBe(true);
    expect(h.out.sheet).toBeUndefined();
    expect(h.out.appended).toHaveLength(1);
    const q = h.out.appended[0]!;
    expect(q.className).toBe('once-q');
    expect(q.innerHTML).toContain("You haven't copied this prompt. Close anyway?");
    expect(q.innerHTML).toContain('data-once="go"');
    q.listeners.click!({ target: { closest: () => ({ dataset: { once: 'go' } }) }, stopPropagation() {} });
    expect(h.out.went).toBe(1);
  });
});

describe('console: where the guard applies', () => {
  it('Back, Escape, the rail, links and sheets go through it; a background redraw does not', () => {
    expect(fn('closeSheet')).toContain('if (!force && ONCE && SHEET.sh.contains(ONCE.el) && onceBlocked(() => closeSheet())) return;');
    expect(js).toContain("if (!replace && onceBlocked(() => openD(type, arg, replace, reset, origin))) return;");
    expect(fn('closeD')).toContain('if (onceBlocked(() => closeD())) return;');
    expect(fn('detailBack')).toContain('if (onceBlocked(() => detailBack())) return;');
    expect(fn('go')).toContain("if (t !== 'theme' && onceBlocked(() => go(t, arg))) return;");
    // Escape on a screen is detailBack, on a sheet closeSheet: both guarded above.
    expect(js).toMatch(/if \(e\.key === 'Escape' && SHEET\) \{ e\.preventDefault\(\); closeSheet\(\); return; \}/);
    expect(js).toContain("addEventListener('beforeunload', (e) => { if (onceLive()) { e.preventDefault(); e.returnValue = ''; } });");
  });
  it('every one-time prompt arms it, and Copy or the first login lifts it', () => {
    expect(fn('secretView')).toContain("onceArm($('#dB'));");
    expect(fn('secretView')).toContain('if (ONCE) ONCE.copied = true;');
    expect(fn('obPromptSheet')).toContain("onceArm($('.ob-pr'));");
    expect(fn('joinSheet')).toContain('onceArm(out);');
    expect(js).toContain("onceArm($('#nnOut'));");
    expect(js).toContain('const once = ONCE && ONCE.el.contains(c) ? ONCE : null; copy(v ? v.dataset.v : c.dataset.copy, () => { if (once && ONCE === once) once.copied = true; });');
  });
  it('a failed copy keeps the guard: copy() calls back only once the text is on the clipboard, on either path', async () => {
    const run = async (clip: 'ok' | 'reject' | 'none', exec: boolean | 'throw') => {
      const toasts: string[] = [];
      let ok = 0;
      const ctx: Record<string, unknown> = {
        toast: (m: string) => toasts.push(m),
        navigator: clip === 'none' ? {} : { clipboard: { writeText: () => (clip === 'ok' ? Promise.resolve() : Promise.reject(new Error('denied'))) } },
        document: { createElement: () => ({ value: '', select() {}, remove() {} }), body: { append() {} }, execCommand: () => { if (exec === 'throw') throw new Error('no'); return exec; } },
      };
      vm.createContext(ctx);
      vm.runInContext(`${fn('copy')}\nthis.copy = copy;`, ctx);
      (ctx.copy as (t: string, cb: () => void) => void)('prompt', () => { ok++; });
      await new Promise((r) => setTimeout(r, 0));
      return { ok, toasts };
    };
    expect((await run('ok', false)).ok).toBe(1);
    expect((await run('reject', true)).ok).toBe(1);
    const bad = await run('reject', false);
    expect(bad.ok).toBe(0);
    expect(bad.toasts[0]).toMatch(/Copy failed/);
    expect((await run('none', 'throw')).ok).toBe(0);
    expect((await run('none', true)).ok).toBe(1);
  });
  it('no prompt or key screen offers a download', () => {
    // The installer link is gone from Add PC: the prompt tells the PC's coding agent where to download it from.
    expect(js).not.toContain('jnInstallH');
    for (const f of ['secretView', 'obPromptSheet', 'joinSheet', 'keyPromptNote']) {
      expect(fn(f), f).not.toMatch(/download|Download|Blob\(/);
    }
  });
});

describe('console: the key prompt and Make a new prompt', () => {
  it('a session key with no connector PC shows its prompt with the raw-key warning; the pickup-code note is gone', () => {
    const src = fn('keyPromptNote') + fn('secretView');
    const ctx: Record<string, unknown> = { esc: (s: string) => s, dt: () => '25 Nov 2026' };
    vm.createContext(ctx);
    vm.runInContext(`${fn('keyPromptNote')}\nthis.note = keyPromptNote;`, ctx);
    const note = ctx.note as (p: unknown) => string;
    expect(note({ mode: 'secret' })).toContain('Do not paste it into a chat with a person or another agent.');
    // A key whose PC runs the connector reaches it by key handover (docs/onboarding.md#key-handover-a-rotated-key-or-a-recruit-reaches-a-connector-pc).
    expect(js).not.toContain('single-use pickup code');
    expect(js).not.toMatch(/reconnect agent-hub|goes into keys\.env/);
    expect(() => execFileSync(process.execPath, ['--check', join(__dirname, '../public/app.js')], { stdio: 'pipe' }), 'public/app.js must parse (node --check)').not.toThrow();
    expect(src).toContain("if (p) b += vnote(keyPromptNote(p)) + sec('Key prompt', codeBox(p.text, true)");
    expect(src).toContain("else b += sec('Key',");
  });
  it('Make a new prompt sits beside the status of an active session key that never logged in, and is Rotate with a note', () => {
    expect(js).toContain("const canNew = !isApp && !dead && !k.first_used_at && k.effective_status === 'active';");
    expect(js).toContain('${canNew ? \'<button type="button" class="btn ghost sm" id="kNew"');
    expect(js).toContain("const doNew = () => doRot('A new prompt was made. The old prompt and its key stop working.');");
    expect(js).toContain("if ($('#kNew')) arm($('#kNew'), doNew, 'Yes, the old prompt stops');");
    expect(js).toContain('const doRot = (note) => run(async () => { const r = await post(`${kp}/rotate`);');
  });
});
