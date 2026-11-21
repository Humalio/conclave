/**
 * Old setup left on a PC (docs/connector.md, "Old setup left on the PC"): the connector's check-in carries one yes-or-no flag
 * (never a path or a name); the PC's status reads it, Unknown until reported; the PCs page lists the PCs that still have
 * leftovers and says on the PC page what clears them.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { testConfig, adminLogin } from './hub.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
const sys = { kind: 'system' as const, id: null };
let app: App, base: string, cookie = '', csrf = '';
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const cn = async (key: string, body: unknown) => {
  const r = await fetch(`${base}/connector/v1/check-in`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const newPc = async (name: string) => {
  const id = (await api('POST', '/pcs', { name })).body.pc.id as string;
  return { id, key: app.keys.createAppKey({ machineId: id, appName: 'claude-code', maxLiveSessions: 10 }, sys).secret };
};
const pcOf = async (id: string) => (await api('GET', '/pcs')).body.pcs.find((p: any) => p.id === id);
const base0 = { version: '1.4.0', platform: 'win32-x64', node: '22.11.0', git: '2.47.1', clients: [] };

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahleft-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  app = await buildApp(testConfig(dir, { maintenanceSeconds: undefined } as Partial<Config>));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base));
});
afterAll(async () => { await app.close(); });

describe('the leftovers flag', () => {
  it('reads Unknown until the connector reports it', async () => {
    const pc = await newPc('never-said');
    expect((await pcOf(pc.id)).connector.legacy_leftovers).toBeNull();
    expect((await cn(pc.key, base0)).status).toBe(200);
    expect((await pcOf(pc.id)).connector.legacy_leftovers).toBeNull();
  });
  it('is kept as reported and follows the latest check-in', async () => {
    const pc = await newPc('has-leftovers');
    expect((await cn(pc.key, { ...base0, legacy_leftovers: true })).status).toBe(200);
    expect((await pcOf(pc.id)).connector.legacy_leftovers).toBe(true);
    expect((await cn(pc.key, { ...base0, legacy_leftovers: false })).status).toBe(200);
    expect((await pcOf(pc.id)).connector.legacy_leftovers).toBe(false);
  });
  it('takes only a yes or no: a path or a list is refused', async () => {
    const pc = await newPc('path-refused');
    expect((await cn(pc.key, { ...base0, legacy_leftovers: 'C:/Users/x/.conclave/migration' })).status).toBe(400);
    expect((await cn(pc.key, { ...base0, legacy_leftovers: ['keys.env'] })).status).toBe(400);
    expect((await pcOf(pc.id)).connector.legacy_leftovers).toBeNull();
  });
  it('says which kinds are left, as fixed words, and reads Unknown until reported', async () => {
    const pc = await newPc('kinds');
    expect((await pcOf(pc.id)).connector.legacy_leftover_kinds).toBeNull();
    expect((await cn(pc.key, { ...base0, legacy_leftovers: true, legacy_leftover_kinds: ['unfinished_move', 'old_keys'] })).status).toBe(200);
    expect((await pcOf(pc.id)).connector.legacy_leftover_kinds).toEqual(['unfinished_move', 'old_keys']);
    expect((await cn(pc.key, { ...base0, legacy_leftovers: false, legacy_leftover_kinds: [] })).status).toBe(200);
    expect((await pcOf(pc.id)).connector.legacy_leftover_kinds).toEqual([]);
  });
  it('takes only the fixed kinds: a path, a name or an unknown word is refused', async () => {
    const pc = await newPc('kinds-refused');
    for (const bad of [['C:/Users/x/keys.env'], ['keys.env'], ['made_up'], 'old_keys', ['old_keys', 'old_keys', 'ca_setting', 'bridge_pieces', 'unfinished_move']]) {
      expect((await cn(pc.key, { ...base0, legacy_leftover_kinds: bad })).status).toBe(400);
    }
    expect((await pcOf(pc.id)).connector.legacy_leftover_kinds).toBeNull();
  });
  it('lists the PCs that still have leftovers and no other', async () => {
    const a = await newPc('left-a'), b = await newPc('clean-b');
    await cn(a.key, { ...base0, legacy_leftovers: true });
    await cn(b.key, { ...base0, legacy_leftovers: false });
    const left = (await api('GET', '/pcs')).body.pcs.filter((p: any) => p.connector?.legacy_leftovers === true).map((p: any) => p.id);
    expect(left).toContain(a.id);
    expect(left).not.toContain(b.id);
  });
});

describe('the console', () => {
  const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
  it('filters the PCs page to the PCs with leftovers and flags their rows', () => {
    expect(js).toContain("['old', 'Old setup left', (p) => p.connector?.legacy_leftovers === true]");
    expect(js).toContain("p.connector?.legacy_leftovers === true ? pill('Old setup left', 'warn')");
  });
  it('names the kinds next to the flag, and shows no bridge version for a PC that has a connector', () => {
    expect(js).toContain("leftoverText(cn.legacy_leftover_kinds)");
    expect(js).toContain("unfinished_move: 'an unfinished move to the connector (rollback copies)'");
    expect(js).toContain("(cn.status !== 'never' ? null : 'bridge ' + br.version)");
  });
  it('says on the PC page what clears the leftovers, and reads Unknown until reported', () => {
    expect(js).toContain("kv('Old setup', cn.legacy_leftovers === true");
    expect(js).toContain('<span class="mono">conclave check</span> says what is left and how to clear it');
    expect(js).toContain("cn.legacy_leftovers === false ? 'Cleared' : CN_UNK");
  });
});
