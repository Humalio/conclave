#!/usr/bin/env node
/**
 * `npm run test:helper`: runs `node --test <files>` inside one temp folder for the run (scripts/test-tmp.mjs), and deletes
 * that folder when the tests end, fail or are interrupted. The exit code is the tests' own. A test or file that runs over 120 s fails, so a hang shows as a failure.
 */
import { spawn } from 'node:child_process';
import { startRun } from './test-tmp.mjs';

const run = startRun();
const child = spawn(process.execPath, ['--test', '--test-timeout=120000', ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });
const forward = (sig) => () => { try { child.kill(sig); } catch { /* already gone */ } };
process.on('SIGINT', forward('SIGINT'));
process.on('SIGTERM', forward('SIGTERM'));
child.on('error', (e) => { process.stderr.write(`test-helper: ${e.message}\n`); run.end(); process.exit(1); });
child.on('exit', (code, signal) => { run.end(); process.exit(code ?? (signal ? 1 : 0)); });
