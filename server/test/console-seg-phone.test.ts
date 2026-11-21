/**
 * A row of segmented buttons (.seg: the PCs filter "All, Connected, Needs you, Suspended, Old setup left") is wider than a phone.
 * It must scroll inside its own box and never widen the page: on a phone a page widened by one row also widens the fixed bars, and
 * the PCs page's Add PC button ran past the edge. Read from the style sheet.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');

describe('the segmented row on a phone', () => {
  it('scrolls inside its own box, hides its scrollbar and keeps its buttons at their own width', () => {
    const rule = /^\.seg\{([^}]*)\}/m.exec(css)?.[1] ?? '';
    expect(rule).toContain('max-width:100%');
    expect(rule).toContain('overflow-x:auto');
    expect(rule).toContain('scrollbar-width:none');
    expect(css).toContain('.seg::-webkit-scrollbar{display:none}');
    expect(/^\.seg button\{([^}]*)\}/m.exec(css)?.[1] ?? '').toContain('flex:1 0 auto');
  });
});

describe('the team settings task tags row on a phone', () => {
  it('wraps, and the tag list takes its own line, so the page does not grow wider than the screen', () => {
    expect(css).toContain('.tw-row:has(.tw-tags){flex-wrap:wrap}');
    expect(css).toMatch(/\.tw-row>\.tw-tags\{flex:1 1 100%;min-width:0/);
  });
});
