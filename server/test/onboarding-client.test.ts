/**
 * End to end for the onboarding client (docs/onboarding.md, build 4): deploy/client/setup.mjs against a local hub on
 * 127.0.0.1 behind an HTTPS proxy whose CA this test makes (pure Node, nothing committed). A clean root folder and a
 * fake HOME: Add PC, the legacy files copied from the repository (the hub serves only the restore template), enrol, request, a wait killed mid-way, the approval through the admin API,
 * a crash after keys.env is written, the resumed pickup and confirm, folders with working logins, the team started,
 * and the doctor. No secret may appear in any output.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { testConfig, adminLogin } from './hub.js';

// ───────────── a throwaway CA and server certificate (minimal DER) ─────────────
const len = (n: number) => (n < 128 ? Buffer.from([n]) : (() => { const b: number[] = []; for (let x = n; x > 0; x >>= 8) b.unshift(x & 0xff); return Buffer.from([0x80 | b.length, ...b]); })());
const tlv = (tag: number, ...parts: Buffer[]) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), len(body.length), body]); };
const seq = (...p: Buffer[]) => tlv(0x30, ...p);
const oid = (s: string) => { const [a, b, ...r] = s.split('.').map(Number); const out = [40 * a! + b!]; for (const n of r) { const t: number[] = []; let x = n; do { t.unshift(x & 0x7f); x >>= 7; } while (x); out.push(...t.map((v, i) => (i < t.length - 1 ? v | 0x80 : v))); } return tlv(0x06, Buffer.from(out)); };
const name = (cn: string) => seq(tlv(0x31, seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(cn)))));
const utc = (d: Date) => tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'));
const ext = (id: string, critical: boolean, der: Buffer) => seq(oid(id), ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []), tlv(0x04, der));
const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));
function cert(o: { subject: string; issuer: string; pub: KeyObject; signer: KeyObject; ca: boolean }): string {
  const exts = o.ca
    ? [ext('2.5.29.19', true, seq(tlv(0x01, Buffer.from([0xff])))), ext('2.5.29.15', true, tlv(0x03, Buffer.from([0x01, 0x06])))]
    : [ext('2.5.29.19', false, seq()), ext('2.5.29.15', true, tlv(0x03, Buffer.from([0x07, 0x80]))),
      ext('2.5.29.17', false, seq(tlv(0x87, Buffer.from([127, 0, 0, 1])), tlv(0x82, Buffer.from('localhost'))))];
  const now = Date.now();
  const tbs = seq(tlv(0xa0, tlv(0x02, Buffer.from([2]))), tlv(0x02, Buffer.concat([Buffer.from([1]), randomBytes(8)])), ECDSA_SHA256, name(o.issuer),
    seq(utc(new Date(now - 86_400_000)), utc(new Date(now + 30 * 86_400_000))), name(o.subject), o.pub.export({ type: 'spki', format: 'der' }), tlv(0xa3, seq(...exts)));
  const der = seq(tbs, ECDSA_SHA256, tlv(0x03, Buffer.concat([Buffer.from([0]), sign('sha256', tbs, o.signer)])));
  return `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
}
function testCa() {
  const ca = generateKeyPairSync('ec', { namedCurve: 'P-256' }), leaf = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const caPem = cert({ subject: 'Conclave test CA', issuer: 'Conclave test CA', pub: ca.publicKey, signer: ca.privateKey, ca: true });
  const leafPem = cert({ subject: '127.0.0.1', issuer: 'Conclave test CA', pub: leaf.publicKey, signer: ca.privateKey, ca: false });
  return { caPem, leafPem, leafKey: leaf.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string };
}

// ───────────── the hub, its HTTPS proxy, a fake HOME ─────────────
const SETUP_SRC = resolve('../deploy/client');
let app: App, base = '', hub = '', cookie = '', csrf = '', dir = '', home = '', root = '', conf = '', caSha = '';
let proxy: https.Server;
const outputs: string[] = [];

const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const env = (extra: Record<string, string> = {}) => {
  const e: Record<string, string> = { ...process.env as Record<string, string>, HOME: home, USERPROFILE: home, ...extra };
  delete e.CONCLAVE_SETUP_CRASH_AFTER;
  if (!extra.NODE_EXTRA_CA_CERTS) delete e.NODE_EXTRA_CA_CERTS;
  Object.assign(e, extra);
  return e;
};
/** Runs the downloaded setup.mjs as Claude would: from the user's folder, with the fake HOME. */
const setup = (args: string[], extra: Record<string, string> = {}) => new Promise<{ code: number; out: string }>((ok) => {
  execFile(process.execPath, [join(conf, 'setup.mjs'), ...args], { cwd: root, env: env(extra), timeout: 120_000 }, (err, stdout, stderr) => {
    const out = `${stdout}${stderr}`;
    outputs.push(out);
    ok({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out });
  });
});
const getPinned = (url: string) => new Promise<string>((ok, no) => {
  https.get(url, { ca: readFileSync(join(dir, 'ca.pem')) }, (r) => { let s = ''; r.setEncoding('utf8'); r.on('data', (c) => { s += c; }); r.on('end', () => ok(s)); }).on('error', no);
});
const teamStatus = (id: string) => (app.db.prepare('SELECT status FROM teams WHERE id=?').get(id) as { status: string }).status;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ahobc-'));
  home = join(dir, 'home'); root = join(dir, 'work'); conf = join(home, '.config', 'conclave');
  mkdirSync(conf, { recursive: true }); mkdirSync(root); mkdirSync(join(dir, 'vault', 'Grants'), { recursive: true });
  // A ~/.claude.json the user already has: kept, and backed up once before the first change.
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ numStartups: 3, projects: { [root]: { allowedTools: [] } } }));

  const tls = testCa();
  writeFileSync(join(dir, 'ca.pem'), tls.caPem);
  caSha = new X509Certificate(tls.caPem).fingerprint256.replace(/:/g, '').toLowerCase();
  proxy = https.createServer({ key: tls.leafKey, cert: tls.leafPem }, (req, res) => {
    const up = http.request(`${base}${req.url}`, { method: req.method, headers: { ...req.headers, 'x-forwarded-proto': 'https', 'x-forwarded-for': '127.0.0.1' } }, (ur) => {
      res.writeHead(ur.statusCode ?? 502, ur.headers); ur.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()));
  hub = `https://127.0.0.1:${(proxy.address() as { port: number }).port}`;

  const config: Config = testConfig(dir, { publicUrl: hub, clientDir: SETUP_SRC, caCertFile: join(dir, 'ca.pem'), maintenanceSeconds: undefined });
  app = await buildApp(config);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base));
});
afterAll(async () => {
  proxy?.closeAllConnections?.();
  await new Promise((r) => proxy?.close(r));
  await app?.close();
});

describe('setup.mjs end to end', () => {
  let requestId = '', vars: string[] = [], coordFolder = '';

  it('Add PC, the legacy files copied by hand (the hub no longer serves them), enrol over the pinned CA', async () => {
    const add = await api('POST', '/pcs/add', { name: 'e2e-pc' });
    expect(add.status).toBe(200);
    expect(add.body).not.toHaveProperty('prompt'); // the console offers only the connector prompt
    expect(add.body.connector_prompt).toContain('conclave setup request');
    expect(add.body.pairing.ca_check).toBe(caSha.slice(0, 16).match(/.{4}/g)!.join(' '));
    // The hub serves only the restore template now; the legacy client is copied from the repository for this test.
    expect(Object.keys(JSON.parse(await getPinned(`${hub}/onboard/client/manifest`)).files)).toEqual(['restore-prompt.md']);
    for (const f of ['setup.mjs', 'agent-hub-headers.mjs']) writeFileSync(join(conf, f), readFileSync(join(SETUP_SRC, f), 'utf8'));
    // The code goes to a file, never onto a command line; --code is refused.
    expect((await setup(['enrol', '--hub', hub, '--ca-sha256', caSha, '--code', add.body.code])).code).toBe(2);
    mkdirSync(join(conf, 'onboarding'), { recursive: true });
    writeFileSync(join(conf, 'onboarding', 'enrol-code'), `${add.body.code}\n`);
    // A wrong fingerprint stops before anything is sent.
    const bad = await setup(['enrol', '--hub', hub, '--ca-sha256', '0'.repeat(64)]);
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/does not match the fingerprint/);
    const e = await setup(['enrol', '--hub', hub, '--ca-sha256', caSha]);
    expect(e.code, e.out).toBe(0);
    expect(e.out).toMatch(/Enrolled this PC as "e2e-pc"/);
    expect(existsSync(join(conf, 'onboarding', 'enrol-code'))).toBe(false);
    const keys = readFileSync(join(conf, 'keys.env'), 'utf8');
    expect(keys).toMatch(/^AGENT_HUB_APP_KEY=ah_app_/m);
    expect(keys).toContain(`AGENT_HUB_URL=${hub}/mcp`);
    expect(keys).toMatch(/^AGENT_HUB_CA=.*hub-ca\.pem$/m);
    // Rerun of the same prompt: already enrolled, the doctor runs instead.
    writeFileSync(join(conf, 'onboarding', 'enrol-code'), add.body.code);
    const again = await setup(['enrol', '--hub', hub, '--ca-sha256', caSha]);
    expect(again.out).toMatch(/already enrolled/);
    expect(again.out).toMatch(/ok {3}hub: /);
  }, 60_000);

  it('validates and files the request the agent drafted', async () => {
    expect((await setup(['schema'])).out).toMatch(/team_role/);
    const bad = join(root, 'bad.json');
    writeFileSync(bad, JSON.stringify({ project: { name: 'Grants', existing: false }, team: { name: 'Cal', goal: 'x' }, roles: [{ name: 'Writer', team_role: 'worker', count: 9, job: 'w' }], prompt: 'p' }));
    const v = await setup(['request', '--file', bad]);
    expect(v.code).toBe(2);
    expect(v.out).toMatch(/roles\[0\]\.name/);
    expect(v.out).toMatch(/exactly one role with team_role "coordinator"/);
    const file = join(root, 'request.json');
    writeFileSync(file, JSON.stringify({
      kind: 'new_team', project: { name: 'Grants', existing: false }, team: { name: 'Calendar', goal: 'Keep the grant calendar.' },
      roles: [
        { name: 'coordinator', team_role: 'coordinator', count: 1, job: 'Plans and assigns.' },
        { name: 'writer', team_role: 'worker', count: 1, job: 'Writes entries.', folders: [{ path: '/vault/Grants', access: 'write' }] },
        { name: 'reviewer', team_role: 'reviewer', count: 1, job: 'Reviews entries.', reviews: ['writer'] },
      ],
      prompt: 'a team that keeps our grant calendar', client: { app: 'claude-code', os: process.platform },
    }));
    expect((await setup(['request', '--file', file, '--check'])).out).toMatch(/3 agents in total/);
    const f = await setup(['request', '--file', file]);
    expect(f.code, f.out).toBe(0);
    requestId = /Filed request (\S+)/.exec(f.out)![1]!;
    expect((await api('GET', `/onboarding/${requestId}`)).status).toBe(200);
    // One pending request per PC key: the hub refuses a second, the script says what to do.
    const second = await setup(['request', '--file', file]);
    expect(second.code).toBe(1);
    expect(second.out).toMatch(/already has a pending request/);
  }, 60_000);

  it('request --check allows a job line up to 500 characters, one line', async () => {
    const check = async (job: string) => {
      const file = join(root, 'job.json');
      writeFileSync(file, JSON.stringify({ kind: 'new_team', project: { name: 'Grants', existing: false }, team: { name: 'Calendar', goal: 'Keep the grant calendar.' },
        roles: [{ name: 'coordinator', team_role: 'coordinator', count: 1, job }], prompt: 'a team', client: { app: 'claude-code', os: process.platform } }));
      return setup(['request', '--file', file, '--check']);
    };
    const ok = await check('j'.repeat(500));
    expect(ok.code, ok.out).toBe(0);
    for (const job of ['j'.repeat(501), 'Plans the work.\nAnd assigns it.']) {
      const v = await check(job);
      expect(v.code).toBe(2);
      expect(v.out).toMatch(/roles\[0\]\.job.*1-500 characters, one line/);
    }
  });

  it('waits without the model, survives a kill, resumes after a crash, then sets everything up', async () => {
    expect((await setup(['wait'])).code).toBe(2); // the transport choice comes first
    // The wait is bounded below Claude Code's 10-minute ceiling (the prompt passes 9 with a 600000 ms timeout).
    expect((await setup(['wait', '--transport', 'https', '--max-minutes', '10'])).code).toBe(2);
    // A wait killed while the request is still submitted (the user stopped the turn).
    const child = spawn(process.execPath, [join(conf, 'setup.mjs'), 'wait', '--transport', 'https'], { cwd: root, env: env() });
    let seen = '';
    child.stdout.on('data', (c) => { seen += c; });
    await new Promise<void>((ok, no) => {
      const t = setInterval(() => { if (/Waiting for the administrator/.test(seen)) { clearInterval(t); ok(); } }, 50);
      setTimeout(() => { clearInterval(t); no(new Error(`no waiting line: ${seen}`)); }, 20_000);
    });
    child.kill();
    outputs.push(seen);
    // A short wait exits cleanly with the line Claude ends its turn with.
    const short = await setup(['wait', '--max-minutes', '0']);
    expect(short.code).toBe(3);
    expect(short.out).toMatch(/Still waiting for approval/);

    const d = await api('GET', `/onboarding/${requestId}`);
    const a = await api('POST', `/onboarding/${requestId}/approve`, { version: d.body.request.version });
    expect(a.status, JSON.stringify(a.body)).toBe(200);

    // Crash right after keys.env is written, before confirm: the rerun only confirms (no second issue).
    const crash = await setup(['wait'], { CONCLAVE_SETUP_CRASH_AFTER: 'keys_written' });
    expect(crash.code, crash.out).toBe(137);
    expect((await api('GET', `/onboarding/${requestId}`)).body.request.state).toBe('approved');
    const issuesBefore = (app.db.prepare('SELECT pickup_issues FROM onboarding_requests WHERE id=?').get(requestId) as { pickup_issues: number }).pickup_issues;

    const w = await setup(['wait']);
    expect(w.code, w.out).toBe(0);
    expect((app.db.prepare('SELECT pickup_issues FROM onboarding_requests WHERE id=?').get(requestId) as { pickup_issues: number }).pickup_issues).toBe(issuesBefore);
    const st = app.db.prepare('SELECT state, team_id, transport FROM onboarding_requests WHERE id=?').get(requestId) as { state: string; team_id: string; transport: string };
    expect(st.state).toBe('collected');
    expect(st.transport).toBe('https');
    expect(teamStatus(st.team_id)).toBe('running'); // auto-started at confirm
    vars = [...w.out.matchAll(/ok {3}login (\S+): ok/g)].map((m) => m[1]!);
    expect(vars).toHaveLength(3);
    coordFolder = /coordinator folder: (.+)/.exec(w.out)![1]!.trim();
    expect(coordFolder.startsWith(join(root, 'Grants'))).toBe(true);
  }, 120_000);

  it('built each folder: config, CLAUDE.md, git with exclude, trust after one backup', async () => {
    const folders = readdirSync(join(root, 'Grants')).map((f) => join(root, 'Grants', f));
    expect(folders).toHaveLength(3);
    const claude = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
    expect(claude.numStartups).toBe(3); // the rest of the file is kept
    expect(claude.projects[root].allowedTools).toEqual([]);
    expect(readdirSync(home).filter((f) => f.startsWith('.claude.json.conclave-'))).toHaveLength(1);
    const keys = readFileSync(join(conf, 'keys.env'), 'utf8');
    for (const f of folders) {
      const cfg = JSON.parse(readFileSync(join(f, '.agent-hub.json'), 'utf8'));
      expect(vars).toContain(cfg.session_var);
      expect(keys).toMatch(new RegExp(`^${cfg.session_var}=ah_ses_`, 'm'));
      const mcp = JSON.parse(readFileSync(join(f, '.mcp.json'), 'utf8')).mcpServers['agent-hub'];
      expect(mcp.url).toBe(`${hub}/mcp`);
      expect(mcp.headersHelper).toContain('agent-hub-headers.mjs');
      expect(mcp.headersHelper).toContain(f.replace(/\\/g, '/'));
      expect(JSON.parse(readFileSync(join(f, '.claude', 'settings.local.json'), 'utf8')).enabledMcpjsonServers).toEqual(['agent-hub']);
      const claudeMd = readFileSync(join(f, 'CLAUDE.md'), 'utf8');
      expect(claudeMd).toContain('through the Conclave connector on this PC');
      expect(claudeMd).not.toContain(cfg.session_var);
      expect(claudeMd).not.toMatch(/keys.env|headers helper|helper.log|codex-bridge/);
      expect(readFileSync(join(f, '.git', 'info', 'exclude'), 'utf8').split(/\r?\n/)).toContain('*');
      expect(claude.projects[f.replace(/\\/g, '/')]?.hasTrustDialogAccepted).toBe(true);
    }
    // Running the same wait again rebuilds nothing new and picks up nothing: the request is done.
    const again = await setup(['wait']);
    expect(again.out).not.toMatch(/written\./);
  }, 60_000);

  it('the doctor reports every check, one line each, and re-applies dropped trust', async () => {
    // The Claude Code session that ran the prompt saves its own copy of ~/.claude.json, dropping the folders' trust.
    const cj = join(home, '.claude.json');
    const dropped = JSON.parse(readFileSync(cj, 'utf8'));
    for (const k of Object.keys(dropped.projects)) if (k !== root) delete dropped.projects[k];
    writeFileSync(cj, JSON.stringify(dropped));
    const c = await setup(['check'], { NODE_EXTRA_CA_CERTS: join(conf, 'hub-ca.pem') });
    expect(c.code, c.out).toBe(0);
    for (const v of vars) expect(c.out).toMatch(new RegExp(`^ok {3}trust ${v}: re-applied`, 'm'));
    const restored = JSON.parse(readFileSync(cj, 'utf8'));
    expect(restored.projects[root].allowedTools).toEqual([]);
    for (const f of readdirSync(join(root, 'Grants'))) expect(restored.projects[join(root, 'Grants', f).replace(/\\/g, '/')]?.hasTrustDialogAccepted).toBe(true);
    // With trust in place, the next run repairs nothing.
    expect((await setup(['check'], { NODE_EXTRA_CA_CERTS: join(conf, 'hub-ca.pem') })).out).not.toMatch(/re-applied/);
    for (const k of ['node', 'git', 'config', 'claude.json', 'ca', 'hub', 'agent-hub-headers.mjs', 'trust', 'keys']) expect(c.out).toMatch(new RegExp(`^ok {3}${k.replace('.', '\\.')}: `, 'm'));
    for (const v of vars) {
      expect(c.out).toMatch(new RegExp(`^ok {3}folder ${v}: `, 'm'));
      expect(c.out).toMatch(new RegExp(`^ok {3}login ${v}: ok`, 'm'));
      expect(c.out).toMatch(new RegExp(`helper\\.log ${v}: .*ok dir=`));
    }
    // Without trust for Claude Code's HTTPS, that one line fails (and says why).
    const t = await setup(['check']);
    expect(t.code).toBe(1);
    expect(t.out).toMatch(/^fail trust: Claude Code over HTTPS: NODE_EXTRA_CA_CERTS (not set|points elsewhere)/m); // on Windows the user's registry environment counts too
    // A revoked key shows as a failed login with the helper's own reason.
    const kid = (app.db.prepare("SELECT s.credential_id AS id FROM onboarding_slots s WHERE s.request_id=? AND s.session_var=?").get(requestId, vars[0]) as { id: string }).id;
    expect((await api('POST', `/keys/${kid}/revoke`, {})).status).toBeLessThan(300);
    rmTokens();
    const r = await setup(['check'], { NODE_EXTRA_CA_CERTS: join(conf, 'hub-ca.pem') });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(new RegExp(`^fail login ${vars[0]}: login refused`, 'm'));
  }, 60_000);

  it('never printed a secret', () => {
    const keys = readFileSync(join(conf, 'keys.env'), 'utf8').split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=ah_/.test(l)).map((l) => l.slice(l.indexOf('=') + 1));
    expect(keys.length).toBeGreaterThanOrEqual(4);
    const all = outputs.join('\n');
    for (const k of keys) expect(all).not.toContain(k);
    expect(all).not.toMatch(/ah_(app|ses)_[a-z2-7]{12}_|cnc-pair-[a-z2-7]{26}/);
    const state = readFileSync(join(conf, 'onboarding', 'state.json'), 'utf8');
    for (const k of keys) expect(state).not.toContain(k);
    expect(state).not.toMatch(/ah_(app|ses)_|cnc-pair-/);
  });
});

function rmTokens() {
  const t = join(conf, 'tokens');
  if (existsSync(t)) for (const f of readdirSync(t)) writeFileSync(join(t, f), '');
}
