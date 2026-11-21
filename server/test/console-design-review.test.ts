/**
 * The design screen (docs/decisions.md, Designs), read from the console source: a Needs you row of kind design opens its own
 * modal; agent text and the review are marked; mockups are plain images from the hub's own route (never SVG); the bar answers
 * through the existing decision routes; Reject and Change ask for words first.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
const fn = js.slice(js.indexOf('async function designOpen('), js.indexOf('function urgent() {'));

describe('the design screen', () => {
  it('is reached from a Needs you row of kind design, in both consoles', () => {
    expect(js).toMatch(/design: \['Design to decide', 'dec'\]/);
    expect(js).toMatch(/case 'design': return `data-design=/);
    expect(js).toMatch(/o\.kind === 'design'\) return `data-design=/);
    expect(js.match(/t\.closest\('\[data-design\]'\)/g)?.length).toBe(2);
  });
  it('marks the design as agent text and the review with who wrote it and whether it was independent', () => {
    expect(fn).toContain('agent text');
    expect(fn).toContain('written by');
    expect(fn).toContain('not an independent review');
    expect(fn).toContain('What changed after review');
  });
  it('shows mockups as images from the hub route and opens them full size', () => {
    expect(fn).toContain('${g.mock}/');
    expect(fn).toMatch(/<img src=/);
    expect(fn).toContain('target="_blank"');
    expect(fn).not.toMatch(/svg/i);
  });
  it('answers through the existing routes: options, change, reject, confirm, overturn', () => {
    expect(fn).toContain("base + '/answer', { option:");
    expect(fn).toContain("base + '/more-info'");
    expect(fn).toContain("base + '/answer', { reject: true, text:");
    expect(fn).toContain("base + '/confirm'");
    expect(fn).toContain("base + '/overturn'");
  });
  it('asks for words before Change or Reject, and puts the recommended option first', () => {
    expect(fn).toContain('Say what should change.');
    expect(fn).toContain('Say why, so the team knows.');
    expect(fn).toContain('(b.key === d.recommended) - (a.key === d.recommended)');
  });
  it('ends with one step: keep the design or archive it, admin only', () => {
    expect(fn).toContain('Keep the design');
    expect(fn).toMatch(/\/items\/\$\{encodeURIComponent\(g\.key\)\}\/\$\{a\}/);
    expect(fn).toContain('MU.on');
  });
  it('is a full-screen sheet on a phone', () => {
    expect(css).toMatch(/@media \(max-width:767px\)\{\.sheet\.ds\{height:100dvh/);
  });
});

describe('the Blueprint Designs filter', () => {
  it('is a Blueprint screen with Open, Accepted, Rejected, Archived and All, and a row opens the design read-only', () => {
    expect(js).toMatch(/const BP_SCREENS = \[[^\]]*'des'\]/);
    for (const l of ['Open', 'Accepted', 'Rejected', 'Archived', 'All']) expect(js).toContain(`'${l}', (x) =>`.replace("'All', (x) =>", "'All', () =>"));
    expect(js).toContain('data-design-item=');
    expect(js).toContain('designDraw(r.design, null,');
  });
});

describe('the answer buttons', () => {
  it('do not carry data-key, which the console opens as a key', () => {
    expect(fn).not.toMatch(/data-key=/);
    expect(fn).toContain('data-ds-key=');
  });
});
