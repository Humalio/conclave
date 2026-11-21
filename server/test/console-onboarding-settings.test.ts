/**
 * Settings → Onboarding on the PCs page (docs/dashboard-ux.md): the sheet fits a phone. Its labels and help lines are plain
 * words, shown under each label rather than behind an info button (on touch an info button opens its own sheet, which
 * replaced this one and lost unsaved edits). Titles and help wrap instead of being cut off, the claim button sits on its own
 * line, and a form sheet taller than the room scrolls inside itself with its buttons pinned to the bottom. Read from the
 * source files.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (...p: string[]) => readFileSync(join(process.cwd(), '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const js = read('server', 'public', 'app.js'), css = read('server', 'public', 'style.css');
const fn = (name: string) => { const i = js.indexOf(`async function ${name}(`); return js.slice(i, js.indexOf('\n}\n', i) + 3); };
const constFn = (name: string) => { const i = js.indexOf(`const ${name} = `); return js.slice(i, js.indexOf('\n};\n', i) + 4); };

describe('Settings → Onboarding', () => {
  const sheet = fn('obSettings');
  it('names each limit in plain words, with its help as a line under the label', () => {
    for (const [label, help] of [
      ['Roles per request', 'The most roles one team request can ask for.'],
      ['Agents per request', 'The most agents one request can ask for, all roles together.'],
      ['Agents per role', 'The most agents one role can ask for.'],
      ['Directives per request', 'The most directives one request can suggest; 0 turns this off.'],
      ['Requirements per request', 'The most Blueprint requirements a new team can suggest; 0 turns this off.'],
      ['Requests per PC each hour', 'Sending, changing and withdrawing a request each count once.'],
      ['Requests per PC each day', 'Sending, changing and withdrawing a request each count once.'],
    ]) expect(sheet).toContain(`'${label}', '${help}'`);
    expect(sheet).toContain('<p class="hint">Limits on what a PC can ask for when it sets up a team.</p>');
    expect(sheet).toContain("row({ as: 'div', title: l, meta: tip, trail:");
    expect(sheet).not.toContain('info(');
    expect(sheet).not.toMatch(/Filings|PC key|Per request, and per/);
  });
  it('repo hosts and agent owners say what they do in a line, not behind an info button', () => {
    expect(js).toContain("const coSetHead = (cs) => overline('Checkout · repo hosts', cs.edit.length) + '<p class=\"hint\">An agent moved to another PC can copy code only from these hosts.</p>';");
    expect(js).toContain("none('link', 'No hosts: a moved agent cannot copy any repo')");
    expect(js).not.toContain('From CONCLAVE_REPO_HOSTS until you save.');
    const ow = constFn('owSetHtml');
    expect(ow).toContain(`overline('Agent owners') + '<p class="hint">Each agent belongs to a person, who can limit what it does.</p>'`);
    expect(ow).not.toContain('info(');
    expect(ow).not.toContain('one: true'); // a one-line row drops its meta: the claim and enforcement state must show
    // The claim button sits on its own line, so the title is never cut off beside it.
    expect(ow).toContain('<div class="ob-act"><button type="button" class="btn sm" id="owClaim">');
    expect(ow).toContain("'On: an agent can do only what its owner allows.'");
  });
  it('wraps titles and help in this sheet, keeping the sections apart', () => {
    expect(sheet).toContain('fields: `<div class="ob-set">');
    expect(css).toContain('.ob-set{display:contents}');
    expect(css).toContain('.ob-set :is(.lrow-title,.lrow-meta){white-space:normal}');
    expect(css).toContain('.ob-set .lrow{height:auto;min-height:56px}');
  });
});

describe('form sheets', () => {
  it('keep their buttons pinned to the bottom while the rest scrolls', () => {
    expect(css).toContain('.sheet-form>.sheet-acts{position:sticky;bottom:calc(-1 * (var(--s4) + env(safe-area-inset-bottom)));');
    expect(css).toMatch(/\.sheet-form>\.sheet-acts\{[^}]*background:var\(--panel-3\)/);
  });
});
