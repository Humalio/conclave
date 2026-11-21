import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { newId } from '../src/util/ids.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base = '', cookie = '', csrf = '', appKey = '', pcId = '', vaultDir = '';

const api = async (method: string, path: string, body?: unknown, raw = false) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (raw) return { status: r.status, text: await r.text(), headers: r.headers };
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
async function connect() {
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  return async (name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: any; content: { text: string }[] };
}
type Rules = { effect: 'allow' | 'deny'; actions: string[]; resource: string }[];
const TOOLS: Rules = [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }];
const FS = ['fs.list', 'fs.read', 'fs.search', 'fs.create', 'fs.update', 'fs.rename', 'fs.delete', 'fs.history'];
const mk = (label: string, rules: Rules) => {
  const agent = app.keys.createAgent(label, null, sys);
  const k = app.keys.createSessionKey({ agentId: agent.id, label }, sys);
  app.keys.setRules(k.credential.policy_id, [...TOOLS, ...rules], 'test', sys);
  return { agent, secret: k.secret, cred: k.credential };
};
async function login(secret: string) {
  const call = await connect();
  const r = await call('session_login', { session_key: secret });
  const token = r.structuredContent.session_token as string;
  return (name: string, args: Record<string, unknown> = {}) => call(name, { session_token: token, ...args });
}
const alertsOf = (type: string, subject?: string) => (app.db.prepare('SELECT * FROM security_alerts WHERE type=? AND (? IS NULL OR subject=?)').all(type, subject ?? null, subject ?? null)) as any[];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FULL: Rules = [{ effect: 'allow', actions: FS, resource: 'path:/vault/**' }];

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah5-'));
  vaultDir = join(dir, 'vault');
  for (const d of ['Projects/Open', 'Projects/Closed', 'Vol', 'Lock']) mkdirSync(join(vaultDir, d), { recursive: true });
  writeFileSync(join(vaultDir, 'Projects/Open/a.md'), 'open note\n');
  writeFileSync(join(vaultDir, 'Projects/Closed/b.md'), 'closed note\n');
  const config: Config = testConfig(dir, { vaultDir, alerts: { denialMax: 3, loginMax: 3, volumeFloor: 5 } });
  app = await buildApp(config);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base));
  pcId = (await api('POST', '/pcs', { name: 'pc' })).body.pc.id;
  appKey = app.keys.createAppKey({ machineId: pcId, appName: 'claude-code', maxLiveSessions: 100 }, sys).secret;
});
afterAll(async () => { await app.close(); });

describe('access requests and temporary grants', () => {
  it('request -> approve narrowed -> temporary grant works -> expires; rotation carries it', async () => {
    const p = mk('requester', []);
    let S = await login(p.secret);
    expect((await S('file_read', { path: '/vault/Projects/Open/a.md' })).structuredContent.error).toBe('denied');
    const r = await S('access_request', { actions: ['fs.read'], resource: '/vault/Projects/**', reason: 'need to read the project notes', duration: '1h' });
    expect(r.structuredContent.status).toBe('pending');
    const id = r.structuredContent.request_id as string;
    expect((await api('GET', '/requests?status=pending')).body.requests.map((x: any) => x.id)).toContain(id);

    const bad = await api('POST', `/requests/${id}/approve`, { narrowed_resource: '/vault/Other/**' });
    expect(bad.status).toBe(400);
    const ok = await api('POST', `/requests/${id}/approve`, { narrowed_resource: '/vault/Projects/Open/**', duration: 2 });
    expect(ok.status).toBe(200);
    expect(ok.body.request.status).toBe('partially_approved');

    const read = await S('file_read', { path: '/vault/Projects/Open/a.md' });
    expect(read.isError).toBeFalsy();
    expect(read.structuredContent.notices?.some((n: any) => n.kind === 'access_decision')).toBe(true);
    expect((await S('file_read', { path: '/vault/Projects/Closed/b.md' })).structuredContent.error).toBe('denied');
    const list = await S('access_list');
    const tmp = list.structuredContent.grants.find((g: any) => g.kind === 'temporary');
    expect(tmp.resource).toBe('path:/vault/Projects/Open/**');
    expect(Date.parse(tmp.expires_at)).toBeGreaterThan(Date.now());
    expect((await S('access_status', { request_id: id })).structuredContent.requests[0].status).toBe('partially_approved');
    expect((await api('POST', `/requests/${id}/approve`, {})).status).toBe(409);

    // rotation: the grant moves to the new key
    const rot = app.keys.rotate(p.cred.id, sys);
    S = await login(rot.secret);
    expect((await S('file_read', { path: '/vault/Projects/Open/a.md' })).isError).toBeFalsy();

    // expiry (real clock)
    await sleep(2200);
    expect((await S('file_read', { path: '/vault/Projects/Open/a.md' })).structuredContent.error).toBe('denied');
    expect((await S('access_list')).structuredContent.grants.some((g: any) => g.kind === 'temporary')).toBe(false);
    expect((await api('GET', '/grants')).body.grants.some((g: any) => g.access_request_id === id)).toBe(false);
  });

  it('a stored grant that is already past not_after does not apply (also after restart)', async () => {
    const p = mk('restart', []);
    const S = await login(p.secret);
    const admin = app.db.prepare('SELECT id FROM admin_users LIMIT 1').get() as { id: string };
    const now = Date.now();
    app.db.prepare('INSERT INTO temporary_grants(id,credential_id,actions,resource,resource_kind,not_before,not_after,granted_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(newId.grant(), p.cred.id, '["fs.read"]', 'path:/vault/Projects/Open/**', 'path', now - 2000, now - 1000, admin.id, now - 2000);
    expect((await S('file_read', { path: '/vault/Projects/Open/a.md' })).structuredContent.error).toBe('denied');
    app.db.prepare('INSERT INTO temporary_grants(id,credential_id,actions,resource,resource_kind,not_before,not_after,granted_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(newId.grant(), p.cred.id, '["fs.read"]', 'path:/vault/Projects/Open/**', 'path', now - 1000, now + 600_000, admin.id, now - 1000);
    expect((await S('file_read', { path: '/vault/Projects/Open/a.md' })).isError).toBeFalsy();
  });

  it('deny, withdraw-free flow, revoke a grant', async () => {
    const p = mk('denied', []);
    const S = await login(p.secret);
    const id = (await S('access_request', { actions: ['fs.update'], resource: '/vault/Projects/**', reason: 'edit please' })).structuredContent.request_id as string;
    expect((await api('POST', `/requests/${id}/deny`, { note: 'not now' })).body.request.status).toBe('denied');
    const st = await S('access_status');
    expect(st.structuredContent.requests[0]).toMatchObject({ status: 'denied', decision_note: 'not now' });
    expect(st.structuredContent.notices.some((n: any) => n.kind === 'access_decision' && n.body.includes('denied'))).toBe(true);
    expect((await api('POST', `/requests/${id}/approve`, {})).status).toBe(409);
    expect((await S('access_request', { actions: ['bad action'], resource: '/vault/x', reason: 'x' })).structuredContent.error).toBe('invalid_argument');

    const id2 = (await S('access_request', { actions: ['fs.read'], resource: '/vault/Projects/Open/**', reason: 'read' })).structuredContent.request_id as string;
    const ap = await api('POST', `/requests/${id2}/approve`, {});
    expect(ap.body.request.status).toBe('approved');
    expect((await S('file_read', { path: '/vault/Projects/Open/a.md' })).isError).toBeFalsy();
    expect((await api('DELETE', `/grants/${ap.body.grant_id}`)).status).toBe(200);
    expect((await S('file_read', { path: '/vault/Projects/Open/a.md' })).structuredContent.error).toBe('denied');
  });

  it('a pending request expires after 24 h', async () => {
    const p = mk('stale', []);
    const S = await login(p.secret);
    const id = (await S('access_request', { actions: ['fs.read'], resource: '/vault/Projects/**', reason: 'x' })).structuredContent.request_id as string;
    app.db.prepare('UPDATE access_requests SET created_at=? WHERE id=?').run(Date.now() - 25 * 3600_000, id);
    expect((await S('access_status', { request_id: id })).structuredContent.requests[0].status).toBe('expired');
  });
});

describe('lockdown scopes', () => {
  it('all writes, a vault, an agent, a PC and a team; reads and admins unaffected', async () => {
    const a = mk('lock-a', FULL), b = mk('lock-b', FULL);
    const A = await login(a.secret), B = await login(b.secret);
    let n = 0;
    const w = (S: typeof A) => S('file_create', { path: `/vault/Lock/f${n++}.md`, content: 'x' });
    expect((await w(A)).isError).toBeFalsy();
    const set = async (scope: string, id: string | undefined, on: boolean) => { const r = await api('POST', '/lockdown', { scope, id, on }); if (r.status !== 200) throw new Error(JSON.stringify(r)); return r.body; };

    expect((await set('writes', undefined, true)).writes_disabled).toBe(true);
    expect((await w(A)).structuredContent.error).toBe('lockdown');
    expect((await w(B)).structuredContent.error).toBe('lockdown');
    expect((await A('file_read', { path: '/vault/Projects/Open/a.md' })).isError).toBeFalsy();
    await set('writes', undefined, false);
    expect((await w(A)).isError).toBeFalsy();

    expect((await set('agent', a.agent.id, true)).agents).toEqual([a.agent.id]);
    expect((await w(A)).structuredContent.error).toBe('lockdown');
    expect((await w(B)).isError).toBeFalsy();
    await set('agent', a.agent.id, false);
    expect((await w(A)).isError).toBeFalsy();

    await set('pc', pcId, true);
    expect((await w(B)).structuredContent.error).toBe('lockdown');
    await set('pc', pcId, false);

    await set('vault', 'vault', true);
    expect((await w(A)).structuredContent.error).toBe('lockdown');
    await set('vault', 'vault', false);
    expect((await w(A)).isError).toBeFalsy();

    // team: the engine treats a locked team like a paused one
    expect(app.teams.isPaused('team:team_x', { id: 'r', effect: 'allow', actions: ['*'], resource: 'team:*' })).toBe(false);
    expect((await set('team', 'team_x', true)).teams).toEqual(['team_x']);
    expect(app.teams.isPaused('team:team_x', { id: 'r', effect: 'allow', actions: ['*'], resource: 'team:*' })).toBe(true);
    await set('team', 'team_x', false);
    expect(app.lockdown.list()).toMatchObject({ writes_disabled: false, vaults: [], agents: [], pcs: [], teams: [] });
    expect((await api('POST', '/lockdown', { writes_disabled: true })).body.writes_disabled).toBe(true);
    expect((await api('GET', '/lockdown')).body.writes_disabled).toBe(true);
    await api('POST', '/lockdown', { writes_disabled: false });
    expect((await api('POST', '/lockdown', { scope: 'agent', id: 'agent-nope', on: true })).status).toBe(404);
  });
});

describe('alert rules', () => {
  it('repeated denials fire once and dedupe; suspend-key from the alert', async () => {
    const p = mk('denier', []);
    const S = await login(p.secret);
    for (let i = 0; i < 6; i++) await S('file_read', { path: '/vault/Projects/Open/a.md' });
    const rows = alertsOf('repeated_denials', p.cred.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('open');
    const r = await api('POST', `/alerts/${rows[0].id}/suspend-key`);
    expect(r.status).toBe(200);
    expect(r.body.suspended).toEqual([p.cred.id]);
    expect(app.keys.credential(p.cred.id)!.status).toBe('suspended');
    expect(alertsOf('repeated_denials', p.cred.id)[0].status).toBe('closed');
    expect((await api('POST', `/alerts/${rows[0].id}/suspend-key`)).status).toBe(409);
    expect((await (await connect())('session_login', { session_key: p.secret })).structuredContent.error).toBe('key_inactive');
  });

  it('forbidden path attempts (escape, hidden folder) fire once and dedupe', async () => {
    const p = mk('prober', FULL);
    const S = await login(p.secret);
    await S('file_read', { path: '/vault/../etc/passwd' });
    await S('file_read', { path: '/vault/.obsidian/app.json' });
    const rows = alertsOf('forbidden_path', p.cred.id);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].details).repeats).toBe(2);
  });

  it('paths inside prose arguments raise no forbidden-path alert', async () => {
    const p = mk('writer', FULL);
    const S = await login(p.secret);
    await S('file_read', { path: '/vault/missing.md', note: 'see ../secret and /home/x/.claude/settings.json.' });
    expect(alertsOf('forbidden_path', p.cred.id)).toHaveLength(0);
  });

  it('unusual write volume fires once above the hourly floor', async () => {
    const p = mk('busy', FULL);
    const S = await login(p.secret);
    for (let i = 0; i < 8; i++) expect((await S('file_create', { path: `/vault/Vol/v${i}.md`, content: 'x' })).isError).toBeFalsy();
    const rows = alertsOf('unusual_volume', p.cred.id);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].details)).toMatchObject({ kind: 'write' });
  });

  it('unusual volume against the key own baseline', () => {
    const cred = 'crd_baseline';
    const H = 3600_000, w = Math.floor(Date.now() / H) * H;
    for (let h = 1; h <= 5; h++) app.db.prepare('INSERT INTO usage_counters(scope,metric,window_start,count) VALUES (?,?,?,?)').run(cred, 'alert_vol_message', w - h * H, 40);
    const call = (n: number) => { for (let i = 0; i < n; i++) app.alerts.onCall({ credentialId: cred, agentId: null, tool: 'message_send', args: {}, result: 'ok', errorCode: null }); };
    call(150); // floor is 5 but the baseline is 40/h, so the limit is 200
    expect(alertsOf('unusual_volume', cred)).toHaveLength(0);
    call(100);
    expect(alertsOf('unusual_volume', cred)).toHaveLength(1);
  });

  it('failed-login burst fires once', async () => {
    for (let i = 0; i < 5; i++) await api('POST', '/login', { username: 'admin', password: 'wrong' });
    const rows = alertsOf('login_burst');
    expect(rows).toHaveLength(1);
    expect(rows[0].subject).toBe('127.0.0.1');
  });

  it('concurrent use, stalled members and blocked tasks dedupe through Audit.alert', async () => {
    const p = mk('shared', []);
    await login(p.secret); await login(p.secret);
    expect(alertsOf('concurrent_use', p.cred.id).length).toBeLessThanOrEqual(1);
    app.audit.alert('warning', 'task_blocked', 'task_z', { reason: 'a' });
    app.audit.alert('warning', 'task_blocked', 'task_z', { reason: 'b' });
    app.audit.alert('warning', 'stalled_member', 'agent-z', { team: 't' });
    app.audit.alert('warning', 'stalled_member', 'agent-z', { team: 't' });
    expect(alertsOf('task_blocked', 'task_z')).toHaveLength(1);
    expect(alertsOf('stalled_member', 'agent-z')).toHaveLength(1);
    // a closed alert does not swallow a new one
    app.db.prepare("UPDATE security_alerts SET status='closed' WHERE subject='task_z'").run();
    app.audit.alert('warning', 'task_blocked', 'task_z', {});
    expect(alertsOf('task_blocked', 'task_z')).toHaveLength(2);
  });
});

describe('shares and channels admin', () => {
  it('revoke blocks recipients; delete removes the share', async () => {
    const A = mk('sh-author', [{ effect: 'allow', actions: ['message.send', 'message.receive'], resource: 'agent:*' }, { effect: 'allow', actions: ['share.create', 'share.upload', 'share.read'], resource: 'share:*' }]);
    const R = mk('sh-reader', [{ effect: 'allow', actions: ['message.send', 'message.receive'], resource: 'agent:*' }, { effect: 'allow', actions: ['share.read'], resource: 'share:*' }]);
    const SA = await login(A.secret), SR = await login(R.secret);
    const sid = (await SA('share_create', { name: 'doc', with: [R.agent.id] })).structuredContent.share_id as string;
    await SA('share_upload', { share_id: sid, files: [{ path: 'a.txt', content: 'hello' }], final: true });
    expect((await SR('share_read', { share_id: sid, version: 1, path: 'a.txt' })).isError).toBeFalsy();
    const list = await api('GET', '/shares');
    expect(list.body.shares.find((s: any) => s.id === sid)).toMatchObject({ status: 'open', recipients: [`agent:${R.agent.id}`] });
    expect((await api('GET', `/shares/${sid}/versions`)).body.versions[0].files[0].path).toBe('a.txt');
    expect((await api('GET', `/shares/${sid}/feedback`)).status).toBe(200);
    expect((await api('POST', `/shares/${sid}/revoke`)).body.share.status).toBe('revoked');
    expect((await SR('share_read', { share_id: sid, version: 1, path: 'a.txt' })).isError).toBe(true);
    expect((await api('DELETE', `/shares/${sid}`)).status).toBe(200);
    expect((await api('GET', `/shares/${sid}`)).status).toBe(404);
  });

  it('lists channels without paths and closes one', async () => {
    const a = app.keys.createAgent('ch-a', null, sys), b = app.keys.createAgent('ch-b', null, sys);
    const id = newId.channel();
    app.db.prepare("INSERT INTO data_channels(id,from_agent_id,from_credential_id,target_kind,target,to_agent_id,mode,from_local_path,status,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, a.id, 'crd_x', 'agent', `agent:${b.id}`, b.id, 'bridge', 'C:\\secret\\file.bin', 'open', Date.now(), Date.now() + 600_000);
    const l = await api('GET', '/channels');
    const row = l.body.channels.find((c: any) => c.channel_id === id);
    expect(row).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain('secret');
    expect((await api('POST', `/channels/${id}/close`)).body.channel.status).toBe('closed');
    expect((await api('POST', '/channels/chn_nope/close')).status).toBe(404);
  });
});

describe('retention', () => {
  it('deletes old closed shares, channel metadata, acked work items and unreferenced blobs', async () => {
    const DAY = 86400_000, old = Date.now() - 100 * DAY;
    const a = app.keys.createAgent('ret', null, sys);
    const oldShare = app.shares.create({ agentId: a.id, credId: 'crd_x' }, 'old', null, []);
    const openShare = app.shares.create({ agentId: a.id, credId: 'crd_x' }, 'open', null, []);
    const recentClosed = app.shares.create({ agentId: a.id, credId: 'crd_x' }, 'recent', null, []);
    app.shares.close(oldShare.id); app.shares.close(recentClosed.id);
    app.db.prepare('UPDATE shares SET updated_at=? WHERE id IN (?,?)').run(old, oldShare.id, openShare.id);
    app.db.prepare("INSERT INTO share_versions(share_id,version,manifest,total_bytes,upload_kind,status,created_at) VALUES (?,?,?,?,?,?,?)").run(oldShare.id, 1, '[]', 0, 'inline', 'published', old);

    const mkChan = (status: string, finished: number) => {
      const id = newId.channel();
      app.db.prepare('INSERT INTO data_channels(id,from_agent_id,from_credential_id,target_kind,target,status,created_at,expires_at,finished_at) VALUES (?,?,?,?,?,?,?,?,?)').run(id, a.id, 'crd_x', 'vault', 'vault:/x', status, finished, finished + 1000, finished);
      return id;
    };
    const oldChan = mkChan('done', old), newChan = mkChan('done', Date.now()), openChan = mkChan('open', old);
    const mkItem = (acked: number | null) => {
      const id = newId.item();
      app.db.prepare("INSERT INTO work_items(id,agent_id,kind,priority,ref_id,trust,created_at,acked_at) VALUES (?,?,'notice',1,'r','L0',?,?)").run(id, a.id, old, acked);
      return id;
    };
    const oldItem = mkItem(Date.now() - 31 * DAY), freshItem = mkItem(Date.now() - 2 * DAY), pendingItem = mkItem(null);

    const orphan = await app.store.putBlob(Buffer.from('orphan blob content'));
    const kept = await app.store.putBlob(Buffer.from('referenced by a share'));
    const fresh = await app.store.putBlob(Buffer.from('fresh unreferenced'));
    app.db.prepare('UPDATE blobs SET created_at=? WHERE hash IN (?,?)').run(old, orphan.hash, kept.hash);
    app.db.prepare("INSERT INTO share_versions(share_id,version,manifest,total_bytes,upload_kind,status,created_at) VALUES (?,?,?,?,?,?,?)").run(openShare.id, 1, JSON.stringify([{ path: 'k.txt', blob_hash: kept.hash, size: 3 }]), 3, 'inline', 'published', old);
    const blobFile = (h: string) => join(app.store.blobsDir, h.replace('sha256:', '').slice(0, 2), h.replace('sha256:', ''));
    expect(existsSync(blobFile(orphan.hash))).toBe(true);

    const res = await app.maintenance.run();
    expect(res.shares).toBe(1); expect(res.channels).toBe(1); expect(res.workItems).toBe(1); expect(res.blobs).toBeGreaterThanOrEqual(1);
    const has = (t: string, id: string) => !!app.db.prepare(`SELECT 1 x FROM ${t} WHERE id=?`).get(id);
    expect(has('shares', oldShare.id)).toBe(false);
    expect(app.db.prepare('SELECT COUNT(*) n FROM share_versions WHERE share_id=?').get(oldShare.id)).toMatchObject({ n: 0 });
    expect(has('shares', openShare.id)).toBe(true); expect(has('shares', recentClosed.id)).toBe(true);
    expect(has('data_channels', oldChan)).toBe(false); expect(has('data_channels', newChan)).toBe(true); expect(has('data_channels', openChan)).toBe(true);
    expect(has('work_items', oldItem)).toBe(false); expect(has('work_items', freshItem)).toBe(true); expect(has('work_items', pendingItem)).toBe(true);
    expect(existsSync(blobFile(orphan.hash))).toBe(false);
    expect(app.db.prepare('SELECT 1 x FROM blobs WHERE hash=?').get(orphan.hash)).toBeUndefined();
    expect(existsSync(blobFile(kept.hash))).toBe(true);
    expect(existsSync(blobFile(fresh.hash))).toBe(true);
    // the share retention period can be raised, never lowered below the default (docs/operations.md, built-in rules)
    app.db.prepare("INSERT INTO system_settings(key,value,updated_at) VALUES ('retention.shares_days','1',?)").run(Date.now());
    app.db.prepare('UPDATE shares SET updated_at=? WHERE id=?').run(Date.now() - 2 * DAY, recentClosed.id);
    expect((await app.maintenance.run()).shares).toBe(0);
    app.db.prepare("UPDATE system_settings SET value='200' WHERE key='retention.shares_days'").run();
    app.db.prepare('UPDATE shares SET updated_at=? WHERE id=?').run(Date.now() - 150 * DAY, recentClosed.id);
    expect((await app.maintenance.run()).shares).toBe(0);
    app.db.prepare('UPDATE shares SET updated_at=? WHERE id=?').run(Date.now() - 201 * DAY, recentClosed.id);
    expect((await app.maintenance.run()).shares).toBe(1);
    app.db.prepare("DELETE FROM system_settings WHERE key='retention.shares_days'").run();
  });
});

describe('audit export', () => {
  it('exports a time range as json and csv, redacted and formula-safe', async () => {
    const t0 = Date.now();
    app.audit.event(sys, '=HYPERLINK("x")', { kind: 'system', id: 'x' }, { note: 'hello, "world"' });
    app.db.prepare('INSERT INTO audit_events(actor_kind,actor_id,action,target_kind,target_id,details,created_at) VALUES (?,?,?,?,?,?,?)')
      .run('system', null, 'legacy.row', null, null, JSON.stringify({ text: 'oops ah_app_abcdefghijkl_ABCDEFGHIJKLMNOP leaked' }), Date.now());
    const j = await api('GET', `/audit/export?from=${t0}&to=${Date.now() + 1000}&format=json`);
    expect(j.status).toBe(200);
    const text = JSON.stringify(j.body);
    expect(text).not.toContain('ABCDEFGHIJKLMNOP');
    expect(j.body.events.some((e: any) => e.action === 'legacy.row')).toBe(true);
    const c = await api('GET', `/audit/export?from=${new Date(t0).toISOString()}&format=csv`, undefined, true);
    expect(c.headers.get('content-type')).toContain('text/csv');
    expect(c.text.split('\n')[0]).toBe('id,created_at,actor_kind,actor_id,action,target_kind,target_id,details');
    expect(c.text).toContain(`"'=HYPERLINK(""x"")"`);
    expect(c.text).not.toContain('ABCDEFGHIJKLMNOP');
    expect((await api('GET', '/audit/export?format=xml')).status).toBe(400);
  });
});

describe('bridge receive commit step', () => {
  it('the channel is done only after the receiving bridge reports committed', async () => {
    const m1 = (await api('POST', '/pcs', { name: 'm1' })).body.pc.id as string, m2 = (await api('POST', '/pcs', { name: 'm2' })).body.pc.id as string;
    const a = app.keys.createAgent('br-a', null, sys), b = app.keys.createAgent('br-b', null, sys);
    const sender = app.keys.createSessionKey({ agentId: a.id, label: 'sender' }, sys).credential.id;
    const receiver = app.keys.createSessionKey({ agentId: b.id, label: 'receiver' }, sys).credential.id;
    // An agent channel relays only while both agents still hold the channel grants (docs/transfers.md).
    for (const cred of [sender, receiver]) {
      const policy = (app.db.prepare('SELECT policy_id p FROM credentials WHERE id=?').get(cred) as { p: string }).p;
      app.keys.setRules(policy, [{ effect: 'allow', actions: ['channel.use'], resource: 'channel:*' }, { effect: 'allow', actions: ['channel.open', 'channel.accept'], resource: 'agent:*' }], 'test', sys);
    }
    const id = newId.channel(), sha = 'a'.repeat(64);
    app.db.prepare("INSERT INTO data_channels(id,from_agent_id,from_credential_id,target_kind,target,to_agent_id,to_credential_id,direction,mode,from_machine_id,to_machine_id,to_local_path,size,received_offset,status,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, a.id, sender, 'agent', `agent:${b.id}`, b.id, receiver, 'send', 'bridge', m1, m2, 'C:\\dest\\f.bin', 10, 10, 'open', Date.now(), Date.now() + 600_000);
    await app.channels.done(m1, id, 'send', { sha256: sha });
    expect((await app.channels.done(m2, id, 'receive', { committed: true })).status).toBe(409);
    const r = await app.channels.done(m2, id, 'receive', { sha256: sha });
    expect(r.body).toMatchObject({ status: 'open' });
    const st = app.channels.state(m2, id, 'receive').body as any;
    expect(st).toMatchObject({ status: 'open', verified: true, committed: false });
    expect((await app.channels.done(m1, id, 'receive', { committed: true })).status).toBe(404);
    const c = await app.channels.done(m2, id, 'receive', { committed: true });
    expect(c.body).toMatchObject({ status: 'done' });
    expect(app.channels.get(id)!.status).toBe('done');
  });

  it('a hash mismatch fails the channel before any commit', async () => {
    const m1 = (await api('POST', '/pcs', { name: 'm3' })).body.pc.id as string, m2 = (await api('POST', '/pcs', { name: 'm4' })).body.pc.id as string;
    const a = app.keys.createAgent('br-c', null, sys), b = app.keys.createAgent('br-d', null, sys);
    const sender = app.keys.createSessionKey({ agentId: a.id, label: 'sender' }, sys).credential.id;
    const receiver = app.keys.createSessionKey({ agentId: b.id, label: 'receiver' }, sys).credential.id;
    // An agent channel relays only while both agents still hold the channel grants (docs/transfers.md).
    for (const cred of [sender, receiver]) {
      const policy = (app.db.prepare('SELECT policy_id p FROM credentials WHERE id=?').get(cred) as { p: string }).p;
      app.keys.setRules(policy, [{ effect: 'allow', actions: ['channel.use'], resource: 'channel:*' }, { effect: 'allow', actions: ['channel.open', 'channel.accept'], resource: 'agent:*' }], 'test', sys);
    }
    const id = newId.channel();
    app.db.prepare("INSERT INTO data_channels(id,from_agent_id,from_credential_id,target_kind,target,to_agent_id,to_credential_id,direction,mode,from_machine_id,to_machine_id,to_local_path,size,received_offset,status,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, a.id, sender, 'agent', `agent:${b.id}`, b.id, receiver, 'send', 'bridge', m1, m2, 'C:\\dest\\g.bin', 10, 10, 'open', Date.now(), Date.now() + 600_000);
    await app.channels.done(m1, id, 'send', { sha256: 'a'.repeat(64) });
    await app.channels.done(m2, id, 'receive', { sha256: 'b'.repeat(64) });
    expect(app.channels.get(id)).toMatchObject({ status: 'failed', failure_reason: 'hash_mismatch' });
  });
});
