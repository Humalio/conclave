/**
 * Tests for the helpers in setup.mjs, run with `npm run test:helper` in server/ (plain node:test).
 * HOME points at a temporary folder before setup.mjs is imported, so the real state and keys are never touched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const home = mkdtempSync(join(tmpdir(), 'ahs-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
const { keyIdOf, keyIdProblem, shellQuote, helperCommand, loadState } = await import('./setup.mjs');
const OB = join(home, '.config', 'conclave', 'onboarding');

test('shellQuote keeps $, backticks, double quotes and single quotes literal for sh', { skip: spawnSync('sh', ['-c', 'true']).status !== 0 }, () => {
  const dir = '/tmp/it\'s $HOME `id` "x"';
  const cmd = helperCommand('/h/agent-hub-headers.mjs', dir, false);
  const r = spawnSync('sh', ['-c', `printf '%s\n' ${cmd}`], { encoding: 'utf8' });
  assert.equal(r.stdout, `node\n/h/agent-hub-headers.mjs\n${dir}\n`);
});

test('setup checks compare session keys by key id only', () => {
  assert.equal(keyIdOf('ah_ses_abcdefghijk2_secretpart'), 'abcdefghijk2');
  assert.equal(keyIdOf('not a key'), null);
  assert.equal(keyIdOf(undefined), null);
  assert.equal(keyIdProblem('X_SESSION_KEY', 'abcdefghijk2', 'abcdefghijk2'), null);
  assert.equal(keyIdProblem('X_SESSION_KEY', null, 'abcdefghijk2'), null); // missing: reported on its own
  assert.equal(keyIdProblem('X_SESSION_KEY', 'abcdefghijk2', undefined), null); // written before ids were kept
  const p = keyIdProblem('X_SESSION_KEY', 'qwertyuiop22', 'abcdefghijk2');
  assert.match(p, /X_SESSION_KEY in keys\.env has key id qwertyuiop22, but setup wrote abcdefghijk2/);
  assert.ok(!p.includes('secretpart'));
});

test('shellQuote on Windows uses double quotes and forward slashes', () => {
  assert.equal(helperCommand(String.raw`C:\Users\a b\h.mjs`, String.raw`C:\agents\x`, true), 'node "C:/Users/a b/h.mjs" "C:/agents/x"');
  assert.equal(shellQuote('a b', false), "'a b'");
});

test('loadState keeps a corrupt state file and says so', () => {
  mkdirSync(OB, { recursive: true });
  writeFileSync(join(OB, 'state.json'), '{"nonce": "abc", ');
  const lines = [];
  const write = process.stdout.write;
  process.stdout.write = (s) => { lines.push(String(s)); return true; };
  let st;
  try { st = loadState(); } finally { process.stdout.write = write; }
  assert.deepEqual(st.requests, {});
  const kept = readdirSync(OB).filter((f) => f.startsWith('state.json.corrupt-'));
  assert.equal(kept.length, 1);
  assert.equal(readFileSync(join(OB, kept[0]), 'utf8'), '{"nonce": "abc", ');
  assert.match(lines.join(''), /not valid JSON.*kept as/);
});

test('loadState on a missing file starts fresh without a warning', () => {
  mkdirSync(OB, { recursive: true });
  for (const f of readdirSync(OB)) if (f === 'state.json') writeFileSync(join(OB, f), '');
  const dir = mkdtempSync(join(tmpdir(), 'ahs2-'));
  const r = spawnSync(process.execPath, ['-e', `process.env.HOME=process.env.USERPROFILE=${JSON.stringify(dir)};const m=await import(${JSON.stringify(new URL('./setup.mjs', import.meta.url).href)});console.log(JSON.stringify(m.loadState()))`, '--input-type=module'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { version: '1', requests: {} });
});


test('key swaps a key prompt\'s pickup code for the key: keys.env gets the variable, the code file goes, nothing secret is printed', async () => {
  const { createServer } = await import('node:http');
  const { spawn } = await import('node:child_process');
  const KEY = `ah_ses_${'a'.repeat(12)}_${'b'.repeat(32)}`, APP = `ah_app_${'c'.repeat(12)}_${'d'.repeat(32)}`, CODE = `cnv_key_${'e'.repeat(26)}`;
  const seen = [];
  const srv = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(raw || '{}') });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ session_var: 'ROWAN_SESSION_KEY', secret: KEY, label: 'Rowan key', pc: 'office-pc' }));
    });
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const dir = mkdtempSync(join(tmpdir(), 'ahs-key-')), conf = join(dir, '.config', 'conclave');
  mkdirSync(join(conf, 'onboarding'), { recursive: true });
  writeFileSync(join(conf, 'keys.env'), `AGENT_HUB_APP_KEY=${APP}\nAGENT_HUB_URL=http://127.0.0.1:${srv.address().port}/mcp\nOTHER=1\n`);
  const run = (args, code) => new Promise((ok) => {
    if (code !== undefined) writeFileSync(join(conf, 'onboarding', 'key-code'), code + '\n');
    const p = spawn(process.execPath, [fileURLToPath(new URL('./setup.mjs', import.meta.url)), ...args], { env: { ...process.env, HOME: dir, USERPROFILE: dir } });
    let out = ''; p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { out += c; });
    p.on('close', (status) => ok({ status, out }));
  });
  try {
    const bad = await run(['key'], 'cnv_key_short');
    assert.equal(bad.status, 2);
    assert.match(bad.out, /does not look right/);
    assert.equal((await run(['key', '--code', CODE])).status, 2);
    const r = await run(['key'], CODE);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /ROWAN_SESSION_KEY written for "Rowan key" on office-pc/);
    assert.ok(!r.out.includes(KEY) && !r.out.includes(CODE));
    assert.deepEqual(seen.at(-1), { url: '/onboard/key-pickup', auth: `Bearer ${APP}`, body: { code: CODE } });
    const env = readFileSync(join(conf, 'keys.env'), 'utf8');
    assert.match(env, new RegExp(`^ROWAN_SESSION_KEY=${KEY}$`, 'm'));
    assert.match(env, /^OTHER=1$/m);
    assert.ok(!existsSync(join(conf, 'onboarding', 'key-code')));
  } finally { srv.close(); rmSync(dir, { recursive: true, force: true }); }
});

// docs/onboarding.md, "Collisions": before pickup, a variable already in keys.env that this setup did not write (unless
// --replace), or a target folder whose .agent-hub.json names another variable, stops setup. Nothing is picked up, so no
// issue is used. Against a stub hub on 127.0.0.1 (plain HTTP is accepted on loopback only), in temporary homes.
test('a variable or folder collision stops `wait` before pickup; --replace lets a variable collision through', async () => {
  const { createServer } = await import('node:http');
  const { spawn } = await import('node:child_process');
  const APP = `ah_app_${'c'.repeat(12)}_${'d'.repeat(32)}`, OLD = `ah_ses_${'o'.repeat(12)}_${'p'.repeat(32)}`, NEW = `ah_ses_${'n'.repeat(12)}_${'q'.repeat(32)}`;
  const VAR = 'CONCLAVE_ATLAS_COORDINATOR_SESSION_KEY';
  const agents = [{ agent_id: 'agt_c', label: 'Coordinator', role: 'coordinator', team_role: 'coordinator', session_var: VAR, folder: 'coordinator' }];
  const seen = [];
  const srv = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const path = new URL(req.url, 'http://x').pathname;
      seen.push(path);
      const json = (s, j) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
      if (req.headers.authorization !== `Bearer ${APP}`) return json(401, { error: 'unauthorized' });
      if (path === '/onboard/requests/obr_coll1') return json(200, { state: 'approved', version: 2, team_name: 'Atlas', project: 'Atlas', agents });
      if (path === '/onboard/pickup') return json(200, { pickup_id: 'opk_1', team: { id: 'team_1', name: 'Atlas' }, agents: agents.map((a) => ({ ...a, secret: NEW, instructions: '# Coordinator\n' })) });
      if (path === '/onboard/pickup/confirm') return json(200, { team_status: 'active', started: false });
      json(404, { error: 'not_found' });
    });
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const hub = `http://127.0.0.1:${srv.address().port}`;
  const dirs = [];
  /** A home enrolled with this hub and an approved request whose folders go under <home>/root. */
  const world = (keysExtra = '') => {
    const dir = mkdtempSync(join(tmpdir(), 'ahs-coll-')); dirs.push(dir);
    const conf = join(dir, '.config', 'conclave'), root = join(dir, 'root');
    mkdirSync(join(conf, 'onboarding'), { recursive: true });
    writeFileSync(join(conf, 'keys.env'), `AGENT_HUB_APP_KEY=${APP}\nAGENT_HUB_URL=${hub}/mcp\n${keysExtra}`);
    writeFileSync(join(conf, 'onboarding', 'state.json'), JSON.stringify({ version: '1', hub, transport: 'http', current: 'obr_coll1', requests: { obr_coll1: { id: 'obr_coll1', kind: 'new_team', state: 'submitted', root } } }));
    return { dir, conf, root };
  };
  const run = (w, extra = []) => new Promise((ok) => {
    const p = spawn(process.execPath, [fileURLToPath(new URL('./setup.mjs', import.meta.url)), 'wait', '--transport', 'http', '--max-minutes', '0', ...extra], { env: { ...process.env, HOME: w.dir, USERPROFILE: w.dir } });
    let out = ''; p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { out += c; });
    p.on('close', (status) => ok({ status, out }));
  });
  const pickups = () => seen.filter((p) => p === '/onboard/pickup').length;
  try {
    // A variable this setup did not write.
    const a = world(`${VAR}=${OLD}\n`);
    const r1 = await run(a);
    assert.equal(r1.status, 1, r1.out);
    assert.match(r1.out, new RegExp(`fail collision: ${VAR} already exists in keys\\.env`));
    assert.match(r1.out, /Nothing was picked up/);
    assert.equal(pickups(), 0, 'no pickup, so no issue is used');
    assert.ok(seen.includes('/onboard/requests/obr_coll1'), 'the hub was asked for the request');
    assert.match(readFileSync(join(a.conf, 'keys.env'), 'utf8'), new RegExp(`^${VAR}=${OLD}$`, 'm'), 'the old key is untouched');
    assert.ok(!r1.out.includes(OLD) && !r1.out.includes(APP));

    // A target folder whose .agent-hub.json names another variable stops setup, also with --replace.
    const b = world();
    mkdirSync(join(b.root, 'Atlas', 'coordinator'), { recursive: true });
    writeFileSync(join(b.root, 'Atlas', 'coordinator', '.agent-hub.json'), JSON.stringify({ session_var: 'SOMEONE_ELSES_SESSION_KEY' }));
    const r2 = await run(b, ['--replace']);
    assert.equal(r2.status, 1, r2.out);
    assert.match(r2.out, /fail collision: .*coordinator belongs to SOMEONE_ELSES_SESSION_KEY/);
    assert.equal(pickups(), 0);
    assert.doesNotMatch(readFileSync(join(b.conf, 'keys.env'), 'utf8'), new RegExp(VAR));

    // The same variable with --replace: setup goes on to the pickup and replaces it.
    const r3 = await run(a, ['--replace']);
    assert.doesNotMatch(r3.out, /fail collision/, r3.out);
    assert.equal(pickups(), 1, 'the pickup happens');
    assert.ok(seen.includes('/onboard/pickup/confirm'));
    assert.match(readFileSync(join(a.conf, 'keys.env'), 'utf8'), new RegExp(`^${VAR}=${NEW}$`, 'm'));
    assert.ok(!r3.out.includes(NEW) && !r3.out.includes(OLD));
  } finally { srv.close(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); }
});
