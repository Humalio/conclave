import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { DbHealth } from '../src/safety/dbHealth.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
const PASSWORD = 'correct horse battery';
const DAY = 86400_000;
let app: App, base: string, cookie = '', csrf = '', dir = '';

const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const health = () => app.maintenance.health!;
const backups = () => join(dir, 'data', 'backups');
const has = (t: string, id: string) => !!app.db.prepare(`SELECT 1 x FROM ${t} WHERE id=?`).get(id);
const on = (key: string, days?: number) => health().setRule(key, { enabled: true, ...(days ? { days } : {}) }, sys);
const oldAudit = (action: string, daysAgo: number) =>
  Number(app.db.prepare('INSERT INTO audit_events(actor_kind,actor_id,action,target_kind,target_id,details,created_at) VALUES (?,?,?,?,?,?,?)')
    .run('system', null, action, null, null, JSON.stringify({ n: daysAgo }), Date.now() - daysAgo * DAY).lastInsertRowid);

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ahdb-'));
  const vaultDir = join(dir, 'vault');
  mkdirSync(vaultDir, { recursive: true });
  const config: Config = testConfig(dir, { vaultDir, adminPassword: PASSWORD, vaultScanSeconds: undefined, vaultWatch: undefined, maintenanceSeconds: 0 });
  app = await buildApp(config);
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base, 'admin', PASSWORD));
});
afterEach(async () => { await app.close(); });

describe('the audit trail', () => {
  it('refuses a delete younger than the horizon, a horizon moved without audit.trimmed, backwards or under 365 days', () => {
    const young = oldAudit('x.young', 10), old = oldAudit('x.old', 500);
    expect(() => app.db.prepare('DELETE FROM audit_events WHERE id=?').run(young)).toThrow(/append-only/);
    expect(() => app.db.prepare('DELETE FROM audit_events WHERE id=?').run(old)).toThrow(/append-only/); // horizon is 0
    expect(() => app.db.prepare('UPDATE audit_events SET action=? WHERE id=?').run('y', old)).toThrow(/append-only/);
    const h = Date.now() - 400 * DAY;
    expect(() => app.db.prepare('UPDATE audit_horizon SET horizon=? WHERE id=1').run(h)).toThrow(/only moves forward/);
    app.audit.event(sys, 'audit.trimmed', { kind: 'system', id: 'audit' }, { horizon: Date.now() - 100 * DAY });
    expect(() => app.db.prepare('UPDATE audit_horizon SET horizon=? WHERE id=1').run(Date.now() - 100 * DAY)).toThrow(/only moves forward/);
    expect(() => app.db.prepare('DELETE FROM audit_horizon').run()).toThrow(/cannot be removed/);
  });

  it('archives with a hash chain, records audit.trimmed, moves the horizon and removes only what is older', async () => {
    const ids = [oldAudit('x.a', 700), oldAudit('x.b', 600), oldAudit('x.c', 30)];
    on('audit', 400);
    const p = health().preview('audit');
    expect(p.total).toBe(2);
    const r = await health().run('audit', sys);
    expect(r.total).toBe(2);
    expect(r.backup).toMatch(/^health-\d{8}-\d{6}\.db$/);
    expect(existsSync(join(backups(), r.backup!))).toBe(true);
    expect(app.db.prepare('SELECT 1 x FROM audit_events WHERE id=?').get(ids[0])).toBeUndefined();
    expect(app.db.prepare('SELECT 1 x FROM audit_events WHERE id=?').get(ids[2])).toBeTruthy();
    const trimmed = app.db.prepare("SELECT id, details FROM audit_events WHERE action='audit.trimmed'").get() as { id: number; details: string };
    const d = JSON.parse(trimmed.details);
    expect(d.count).toBe(2);
    const file = readFileSync(join(backups(), d.file));
    expect(createHash('sha256').update(file).digest('hex')).toBe(d.sha256);
    // The chain proves the file whole and in order.
    let prev = '0'.repeat(64);
    const lines = gunzipSync(file).toString().trim().split('\n').map((l) => JSON.parse(l));
    for (const l of lines) { expect(l.prev).toBe(prev); prev = createHash('sha256').update(prev + JSON.stringify(l.row)).digest('hex'); expect(l.hash).toBe(prev); }
    expect(prev).toBe(d.chain_last);
    expect(lines.map((l) => l.row.action)).toEqual(['x.a', 'x.b']);
    // The horizon moved; audit.trimmed itself is never removed, and a run is audited.
    expect((app.db.prepare('SELECT horizon FROM audit_horizon').get() as { horizon: number }).horizon).toBe(d.horizon);
    expect(() => app.db.prepare('DELETE FROM audit_events WHERE id=?').run(trimmed.id)).toThrow(/append-only/);
    expect(app.db.prepare("SELECT 1 x FROM audit_events WHERE action='retention.run'").get()).toBeTruthy();
    // A second archive continues the chain.
    oldAudit('x.d', 500);
    await health().run('audit', sys);
    const d2 = JSON.parse((app.db.prepare("SELECT details FROM audit_events WHERE action='audit.trimmed' ORDER BY id DESC LIMIT 1").get() as { details: string }).details);
    expect(d2.chain_first).toBe(d.chain_last);
  });

  it('never goes under 365 days', () => {
    expect(() => health().setRule('audit', { days: 90 }, sys)).toThrow(/365/);
    expect(health().rule('audit').min).toBe(365);
  });

  it('removes nothing and keeps the horizon when the archive cannot be written', async () => {
    const a = oldAudit('x.a', 700), b = oldAudit('x.b', 600);
    on('audit', 400);
    const day = (id: number) => new Date((app.db.prepare('SELECT created_at t FROM audit_events WHERE id=?').get(id) as { t: number }).t).toISOString().slice(0, 10);
    mkdirSync(join(backups(), `audit-${day(a)}-${day(b)}-${b}.jsonl.gz.tmp`), { recursive: true }); // the temporary name is taken
    await expect(health().run('audit', sys)).rejects.toThrow(/could not be written safely/);
    expect(has('audit_events', String(a))).toBe(true);
    expect(has('audit_events', String(b))).toBe(true);
    expect((app.db.prepare('SELECT horizon FROM audit_horizon WHERE id=1').get() as { horizon: number }).horizon).toBe(0);
    expect(app.db.prepare("SELECT 1 x FROM audit_events WHERE action='audit.trimmed'").get()).toBeUndefined();
    expect(readdirSync(backups()).filter((f) => f.startsWith('audit-') && f.endsWith('.gz'))).toEqual([]);
  });
});

describe('keys', () => {
  it('a revoked key removed by the rule leaves a tombstone: still refused as revoked, still known to the leak guard', async () => {
    const ag = app.keys.createAgent('Old', null, sys);
    const k = app.keys.createSessionKey({ agentId: ag.id, label: 'old' }, sys);
    app.keys.setStatus(k.credential.id, 'revoked', 'admin', sys);
    app.db.prepare('UPDATE credentials SET revoked_at=? WHERE id=?').run(Date.now() - 100 * DAY, k.credential.id);
    on('revoked_keys', 90);
    expect(health().preview('revoked_keys').tables.find((t) => t.table === 'credentials')?.rows).toBe(1);
    await health().run('revoked_keys', sys);
    expect(has('credentials', k.credential.id)).toBe(false);
    expect(has('permission_policies', k.credential.policy_id)).toBe(false);
    expect(() => app.keys.verifyKey(k.secret, 'session_key')).toThrow(expect.objectContaining({ code: 'revoked' }));
    const m = /^ah_ses_([a-z2-7]{12})_(.+)$/.exec(k.secret)!;
    expect(app.keys.isIssued('ses', m[1]!, m[2]!)).toBe(true);
  });

  it('never removes a suspended key, a revoked key with a pending pickup, or one that wrote something', async () => {
    const pc = app.keys.createMachine('pc-k', null, sys);
    const ag = app.keys.createAgent('Keys', null, sys);
    const suspended = app.keys.createSessionKey({ agentId: ag.id, label: 's' }, sys);
    const pending = app.keys.createSessionKey({ agentId: ag.id, label: 'p' }, sys);
    app.keys.setStatus(suspended.credential.id, 'suspended', 'admin', sys);
    app.keys.setStatus(pending.credential.id, 'revoked', 'admin', sys);
    app.db.prepare('UPDATE credentials SET revoked_at=?, suspended_at=? WHERE agent_id=?').run(Date.now() - 400 * DAY, Date.now() - 400 * DAY, ag.id);
    app.db.prepare("INSERT INTO key_pickups(id,credential_id,machine_id,session_var,code_hash,status,created_at,expires_at) VALUES ('kp1',?,?,'V','h1','open',?,?)")
      .run(pending.credential.id, pc.id, Date.now(), Date.now() + DAY);
    on('revoked_keys', 90);
    expect(health().preview('revoked_keys').total).toBe(0);
    await health().run('revoked_keys', sys);
    expect(has('credentials', suspended.credential.id)).toBe(true);
    expect(has('credentials', pending.credential.id)).toBe(true);
  });

  it('suspended keys are revoked only by hand, each named in the preview and audited as the operator\'s key.revoke', async () => {
    const ag = app.keys.createAgent('Sus', null, sys);
    const a = app.keys.createSessionKey({ agentId: ag.id, label: 'a' }, sys), b = app.keys.createSessionKey({ agentId: ag.id, label: 'b' }, sys);
    for (const k of [a, b]) app.keys.setStatus(k.credential.id, 'suspended', 'admin', sys);
    app.db.prepare('UPDATE credentials SET suspended_at=? WHERE agent_id=?').run(Date.now() - 200 * DAY, ag.id);
    app.audit.alert('warning', 'test_alert', b.credential.id, {});
    expect(health().rule('suspended_keys')).toMatchObject({ enabled: false, opt_in: true, manual: true });
    expect(() => on('suspended_keys')).toThrow(/no switch/);
    const p = health().preview('suspended_keys');
    expect(p.total).toBe(1);
    expect(p.items).toEqual([expect.objectContaining({ id: a.credential.id, label: 'a', agent: 'Sus' })]);
    await expect(health().run('suspended_keys', sys)).rejects.toThrow(/only when an operator/);
    await expect(health().run('suspended_keys', { kind: 'admin', id: 'admin' }, { scheduled: true })).rejects.toThrow(/only when an operator/);
    await health().nightly(Date.UTC(2030, 0, 1, 4));
    expect(app.keys.credential(a.credential.id)!.status).toBe('suspended');
    const op = { kind: 'admin' as const, id: 'admin' };
    await health().run('suspended_keys', op);
    expect(app.keys.credential(a.credential.id)!.status).toBe('revoked');
    expect(app.keys.credential(b.credential.id)!.status).toBe('suspended');
    expect(app.db.prepare("SELECT actor_kind, actor_id FROM audit_events WHERE action='key.revoke' AND target_id=?").get(a.credential.id)).toEqual({ actor_kind: 'admin', actor_id: 'admin' });
  });
});

describe('stale agents and PCs', () => {
  it('removes an archived agent that never wrote anything, never one with an authored record', async () => {
    const idle = app.keys.createAgent('Idle', null, sys), wrote = app.keys.createAgent('Wrote', null, sys);
    app.keys.createSessionKey({ agentId: idle.id, label: 'never used' }, sys);
    app.db.prepare("INSERT INTO directive_reports(id,agent_id,title,summary,created_at) VALUES ('drp_1',?,'t','s',?)").run(wrote.id, Date.now());
    app.db.prepare("UPDATE agents SET status='archived', archived_at=?, last_seen_at=NULL, created_at=? WHERE id IN (?,?)").run(Date.now() - 400 * DAY, Date.now() - 400 * DAY, idle.id, wrote.id);
    const pc = app.keys.createMachine('pc-old', null, sys);
    app.db.prepare("UPDATE machines SET status='retired', created_at=? WHERE id=?").run(Date.now() - 400 * DAY, pc.id);
    on('stale', 180);
    const p = health().preview('stale');
    const r = await health().run('stale', sys);
    expect(r.total).toBe(p.total);
    expect(has('agents', idle.id)).toBe(false);
    expect(has('agents', wrote.id)).toBe(true);
    expect(has('machines', pc.id)).toBe(false);
  });

  it('never removes a live agent\'s unused key or a live PC\'s finished order', async () => {
    const live = app.keys.createAgent('Live', null, sys);
    const fresh = app.keys.createSessionKey({ agentId: live.id, label: 'not used yet' }, sys);
    const pc = app.keys.createMachine('pc-live', null, sys);
    app.db.prepare("INSERT INTO pc_actions(id,machine_id,kind,state,created_at,expires_at) VALUES ('pca_done',?,'check','done',?,?)").run(pc.id, Date.now() - 400 * DAY, Date.now() - 399 * DAY);
    on('stale', 180);
    const p = health().preview('stale');
    expect(p.tables.find((t) => t.table === 'credentials')).toBeUndefined();
    expect(p.tables.find((t) => t.table === 'pc_actions')).toBeUndefined();
    await health().run('stale', sys);
    expect(has('credentials', fresh.credential.id)).toBe(true);
    expect(has('pc_actions', 'pca_done')).toBe(true);
    expect(has('agents', live.id)).toBe(true);
  });
});

describe('preview and run', () => {
  it('the preview count equals the run count on an unchanged database', async () => {
    for (let i = 0; i < 3; i++) app.audit.auth({ subject: 'admin', outcome: 'invalid', source: '10.0.0.1' });
    app.audit.alert('info', 'closed_one', null, {});
    app.db.prepare("UPDATE security_alerts SET status='closed'").run();
    app.db.prepare('UPDATE authentication_events SET created_at=?').run(Date.now() - 300 * DAY);
    app.db.prepare('UPDATE security_alerts SET updated_at=?').run(Date.now() - 300 * DAY);
    app.audit.alert('warning', 'open_one', null, {});
    app.db.prepare("UPDATE security_alerts SET updated_at=? WHERE type='open_one'").run(Date.now() - 300 * DAY);
    on('activity', 180);
    const p = health().preview('activity');
    expect(p.total).toBeGreaterThanOrEqual(4);
    const r = await health().run('activity', sys, { previewTotal: p.total });
    expect(r.total).toBe(p.total);
    expect(r.difference).toBe(0);
    expect(app.db.prepare("SELECT 1 x FROM security_alerts WHERE type='open_one'").get()).toBeTruthy();
  });

  it('refuses a rule whose walk reaches a table it never touches, and changes nothing', async () => {
    app.db.exec('CREATE TABLE zz_child (id INTEGER PRIMARY KEY, ev TEXT REFERENCES authentication_events(id))');
    app.audit.auth({ subject: 'admin', outcome: 'invalid', source: null });
    const ev = (app.db.prepare('SELECT id FROM authentication_events LIMIT 1').get() as { id: string }).id;
    app.db.prepare('INSERT INTO zz_child(ev) VALUES (?)').run(ev);
    app.db.prepare('UPDATE authentication_events SET created_at=?').run(Date.now() - 300 * DAY);
    const h = new DbHealth({ db: app.db, audit: app.audit, keys: app.keys, lockdown: app.lockdown, dbFile: join(dir, 'data', 't.db'), backupDir: backups() });
    // Hide the new foreign key from the guard only: the walk still follows it, so the rule is refused.
    const reset = (h as any).reset, orig = reset.childrenOf.bind(reset);
    reset.childrenOf = (t: string) => orig(t).filter((f: { child: string }) => f.child !== 'zz_child');
    h.setRule('activity', { enabled: true }, sys);
    expect(h.preview('activity').refused).toMatch(/zz_child/);
    await expect(h.run('activity', sys)).rejects.toThrow(/zz_child/);
    expect(app.db.prepare('SELECT 1 x FROM authentication_events WHERE id=?').get(ev)).toBeTruthy();
  });

  it('is refused during a lockdown', async () => {
    app.lockdown.set('writes', undefined, true, 'test');
    await expect(health().run('activity', sys)).rejects.toThrow(/lockdown/i);
  });
});

describe('built-in rules', () => {
  it('can be raised, never lowered below today\'s default, and never switched off', () => {
    expect(() => health().setRule('shares', { days: 30 }, sys)).toThrow(/raised/);
    expect(() => health().setRule('shares', { enabled: false }, sys)).toThrow(/always runs/);
    expect(health().setRule('shares', { days: 120 }, sys).days).toBe(120);
    app.db.prepare("UPDATE system_settings SET value='5' WHERE key='retention.shares_days'").run();
    expect(health().rule('shares').days).toBe(90);
  });
});

describe('backups and maintenance', () => {
  it('keeps the newest of the last 7 days and of the 4 weeks before them, and never touches other backups', () => {
    mkdirSync(backups(), { recursive: true });
    const now = Date.UTC(2026, 10, 21, 12);
    const name = (daysAgo: number, h = 12) => `health-${new Date(now - daysAgo * DAY).toISOString().slice(0, 10).replace(/-/g, '')}-${String(h).padStart(2, '0')}0000.db`;
    for (let i = 0; i < 60; i++) writeFileSync(join(backups(), name(i)), 'x');
    writeFileSync(join(backups(), name(0, 9)), 'x'); // an earlier one today
    writeFileSync(join(backups(), 'pre-reset-2026.db'), 'x');
    health().rotate();
    const left = readdirSync(backups()).filter((n) => n.startsWith('health-'));
    expect(left).toHaveLength(11);
    for (let i = 0; i < 7; i++) expect(left).toContain(name(i));
    expect(left).not.toContain(name(0, 9));
    expect(existsSync(join(backups(), 'pre-reset-2026.db'))).toBe(true);
  });

  it('refuses Compact when the disk is short, and checks integrity', async () => {
    (health() as any).freeBytes = () => 1024;
    await expect(health().compact(sys)).rejects.toThrow(/MB free/);
    expect((await health().check(true, sys)).ok).toBe(true);
    expect(health().runs(5)[0]).toMatchObject({ kind: 'check', rule: 'full', ok: true });
  });
});

describe('the API', () => {
  it('needs the password to change or run a rule, audits both, and Reset keeps the run history', async () => {
    expect((await api('PUT', '/db-health/rules/activity', { enabled: true, password: 'wrong' })).body.error).toBe('invalid_credentials');
    expect(health().rule('activity').enabled).toBe(false);
    const set = await api('PUT', '/db-health/rules/activity', { enabled: true, days: 200, password: PASSWORD });
    expect(set.status).toBe(200);
    expect(set.body.rule).toMatchObject({ enabled: true, days: 200 });
    const ev = app.db.prepare("SELECT details FROM audit_events WHERE action='retention.rule_set'").get() as { details: string };
    expect(JSON.parse(ev.details)).toMatchObject({ before: { enabled: false, days: 180 }, after: { enabled: true, days: 200 } });
    const g = await api('GET', '/db-health');
    expect(g.status).toBe(200);
    expect(g.body.health.status).toBe('healthy');
    expect(g.body.rules.map((r: { key: string }) => r.key)).toContain('revoked_keys');
    expect((await api('GET', '/db-health/rules/nope/preview')).status).toBe(404);
    expect((await api('GET', '/db-health/rules/shares/preview')).status).toBe(400);
    const run = await api('POST', '/db-health/rules/activity/run', { password: PASSWORD, preview_total: 0 });
    expect(run.status).toBe(200);
    expect(app.db.prepare("SELECT 1 x FROM audit_events WHERE action='retention.run'").get()).toBeTruthy();
    const before = (app.db.prepare('SELECT COUNT(*) n FROM db_health_runs').get() as { n: number }).n;
    app.lockdown.set('writes', undefined, false, 'test');
    expect((await api('POST', '/reset', { parts: ['all'], confirm: 'RESET', password: PASSWORD })).status).toBe(200);
    expect((app.db.prepare('SELECT COUNT(*) n FROM db_health_runs').get() as { n: number }).n).toBe(before);
  });
});
