/**
 * Where a file_patch edit's old text sits in the file (docs/mcp.md, file_patch). The exact text first. Only when it is not
 * found, a second try in which each line break of the old text also matches a break written as CRLF, and spaces or tabs at
 * the end of that line on either side: a markdown table row break read back through file_read, or a file saved on Windows.
 * Nothing else is loosened: every other character must be the same, and the match must still be unique.
 */
export interface PatchMatch { at: number; length: number; matches: number; eol: '\n' | '\r\n' | null }

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function findPatch(text: string, old: string): PatchMatch {
  const exact = text.split(old).length - 1;
  if (exact > 0 || !/\r?\n/.test(old)) return { at: exact === 1 ? text.indexOf(old) : -1, length: old.length, matches: exact, eol: null };
  // Each line of the old text, its trailing spaces dropped; the breaks between them match [ \t]*\r?\n.
  const lines = old.split(/\r?\n/).map((l, i, all) => (i < all.length - 1 ? l.replace(/[ \t]+$/, '') : l));
  const re = new RegExp(lines.map(escape).join('[ \\t]*(\\r?\\n)'), 'g');
  const found = [...text.matchAll(re)];
  if (found.length !== 1) return { at: -1, length: 0, matches: found.length, eol: null };
  const m = found[0]!;
  return { at: m.index!, length: m[0].length, matches: 1, eol: m.slice(1).some((b) => b === '\r\n') ? '\r\n' : '\n' };
}

/** The new text with the file's line breaks, when the match was found through a CRLF break. */
export const withEol = (s: string, eol: PatchMatch['eol']): string => (eol === '\r\n' ? s.replace(/\r?\n/g, '\r\n') : s);
