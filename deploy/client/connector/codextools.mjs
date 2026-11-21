/**
 * Can the Codex on this PC run tools? (docs/connector.md, "A Codex that cannot run tools".) With the `code_mode_host`
 * feature on, Codex runs every tool call through `codex-code-mode-host`; without that program every call fails before it
 * runs, its own shell included. This looks at the program the wake would start, asks it `codex features list` (local,
 * read-only) and looks for the host. It fails only when all three are known: the program, the feature on, the host missing.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { clientProgram } from './entries.mjs';
import { WIN } from './paths.mjs';

const HOST = (win) => (win ? 'codex-code-mode-host.exe' : 'codex-code-mode-host');

/** Whether a file named `name` is anywhere under `dir`, at most `depth` folders down. */
function findUnder(dir, name, depth = 4) {
  let list;
  try { list = readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of list) {
    if (e.isFile() && e.name.toLowerCase() === name) return true;
    if (e.isDirectory() && depth > 0 && findUnder(join(dir, e.name), name, depth - 1)) return true;
  }
  return false;
}

/** The folders an npm install keeps its programs in: the package's own `vendor`, and each platform package's `vendor`
 * (`@openai/codex-<platform>`), nested in the package's `node_modules` or beside the package. Only those that exist. */
function vendorFolders(pkg, exists) {
  const scopes = [join(pkg, 'node_modules', '@openai'), dirname(pkg)];
  const nested = scopes.flatMap((s) => { try { return readdirSync(s).filter((n) => /^codex-/.test(n)).map((n) => join(s, n, 'vendor')); } catch { return []; } });
  return [join(pkg, 'vendor'), ...nested].filter((d) => exists(d));
}

/** `{state, step}`: state `ok`, `broken`, `not_found` or `unknown`; step is the line for the check's list. */
export function codexToolsState({ folder = null, program, run = spawnSync, exists = existsSync, under = findUnder, win = WIN } = {}) {
  const prog = program === undefined ? clientProgram('codex', { folder }) : program;
  if (!prog) return { state: 'not_found', step: 'Codex was not found on this PC for woken runs (a chat opened from the Codex app runs its own copy)' };
  const r = run(prog.file, [...prog.prefix, 'features', 'list'], { encoding: 'utf8', timeout: 15_000, cwd: homedir(), windowsHide: true });
  if (r.error || r.status !== 0) return { state: 'unknown', step: 'Codex did not answer `codex features list`, so whether it can run tools was not checked' };
  const m = /^code_mode_host\s+.*\s(true|false)\s*$/m.exec(String(r.stdout ?? ''));
  if (!m || m[1] !== 'true') return { state: 'ok', step: 'Codex runs its tools without a code-mode host' };
  let has;
  if (prog.prefix.length) {
    const vendors = vendorFolders(join(dirname(resolve(prog.prefix[0])), '..'), exists);
    if (!vendors.length) return { state: 'unknown', step: 'Codex is an npm install whose program folder was not found, so whether it can run tools was not checked' };
    has = vendors.some((v) => under(v, HOST(win)));
  } else has = exists(join(dirname(prog.file), HOST(win)));
  return has ? { state: 'ok', step: 'Codex can run tools: its code-mode host is installed' } : { state: 'broken', step: null };
}
