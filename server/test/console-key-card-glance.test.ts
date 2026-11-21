/**
 * The key detail card shows only what is needed at a glance (whose key, the PC it reaches, its state, when it was last used);
 * everything else sits one level down in a "Details" fold. Read from the console source.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
const card = js.slice(js.indexOf("const idCard = `"), js.indexOf('// What it may do:'));
const labels = (s: string) => [...s.matchAll(/\bkv\('([^']+)'/g)].map((m) => m[1]);

describe('the key card', () => {
  it('keeps four rows above the Details fold', () => {
    const above = card.slice(0, card.indexOf('<details'));
    expect(labels(above)).toEqual(['PC', 'App', 'Agent', 'PC binding', 'Status', 'Last used']);
  });
  it('moves the rest under Details, with every action id kept', () => {
    const below = card.slice(card.indexOf('<details'));
    expect(below).toContain('<summary>Details</summary>');
    expect(labels(below)).toEqual(expect.arrayContaining(['Kind', 'Logs in through', 'Login limit', 'Created', 'Expires', 'Key id']));
    expect(below).toContain('admOnbKv(k, dead)');
    for (const id of ['kExp', 'kLim']) expect(below).toContain(`id="${id}"`);
    for (const id of ['kNew', 'kBind', 'kBindSw']) expect(card.slice(0, card.indexOf('<details'))).toContain(id);
    expect(below.trim().endsWith('</details></div>`;')).toBe(true);
  });
  it('remembers whether the fold was open across redraws', () => {
    expect(js).toContain("let keyMore = false;");
    expect(js).toContain("$('#kMore')?.addEventListener('toggle'");
    expect(css).toContain('.kd-more>summary{');
  });
});
