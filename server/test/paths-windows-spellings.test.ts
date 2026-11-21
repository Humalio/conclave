import { describe, expect, it } from 'vitest';
import { refusedLocalName } from '../src/util/paths.js';

const ok = 'C:\\Users\\a\\agent';
const win = (...rest: string[]) => [ok, ...rest].join('\\');

describe('the hub refuses the Windows spellings of the names it refuses', () => {
  it.each([
    [win('.git', 'config'), 'plain .git'],
    [win('.git.', 'config'), 'trailing dot'],
    [win('.git ', 'config'), 'trailing space'],
    [win('GIT~1', 'config'), 'short name'],
    [win('CODEX~1', 'x'), 'short .codex'],
    [win('.codex.', 'x'), '.codex with a dot'],
    [win('AGENT-~1', 'x'), 'short .agent-hub'],
    [win('CON', 'x'), 'device name'],
    [win('con.txt'), 'device name with an extension'],
    [win('NUL'), 'device name alone'],
    [win('COM1', 'x'), 'COM1'],
    [win('CLAUDE.md.'), 'role file with a dot'],
    [win('CLAUDE~1.MD'), 'role file short name'],
    [win('.git::$INDEX_ALLOCATION', 'x'), 'alternate stream of .git'],
  ])('%s (%s)', (p) => { expect(refusedLocalName(p, 'win32')).not.toBeNull(); });

  it('leaves ordinary names alone, also ones that look similar', () => {
    for (const p of [win('notes', 'a.txt'), win('GITHUB~1', 'x'), win('config.txt'), win('console', 'x'), win('git-notes', 'x')]) expect(refusedLocalName(p, 'win32'), p).toBeNull();
  });

  it('on a POSIX PC a trailing dot or a tilde name is an ordinary name', () => {
    expect(refusedLocalName('/home/a/.git./x', 'posix')).toBeNull();
    expect(refusedLocalName('/home/a/GIT~1/x', 'posix')).toBeNull();
    expect(refusedLocalName('/home/a/.git/x', 'posix')).not.toBeNull();
  });
});
