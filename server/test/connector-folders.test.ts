/**
 * The connector registers its agents' folders (docs/connector.md, "Folders"): it sends each bound folder to the hub, which
 * stores a proposed machine_folders row. The operator approves it as for setup_pc; a transfer checks approved rows only.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { isPathAllowed } from '../src/util/paths.js';
import { testConfig, adminLogin } from './hub.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const sys = { kind: 'system' as const, id: null };
let app: App, base: string, cookie = '', csrf = '';

const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const cn = async (method: string, path: string, key: string | null, body?: unknown) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  const r = await fetch(`${base}/connector/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const world = async (name: string, label = 'folder agent') => {
  const id = (await api('POST', '/pcs', { name })).body.pc.id as string;
  const appKey = app.keys.createAppKey({ machineId: id, appName: 'conclave-connector', maxLiveSessions: 10 }, sys).secret;
  const a = app.keys.createAgent(label, null, sys);
  app.keys.createSessionKey({ agentId: a.id, label: 'k', machineId: id }, sys);
  return { pc: id, appKey, label };
};
const rows = (pc: string) => app.db.prepare('SELECT path,status FROM machine_folders WHERE machine_id=? ORDER BY path').all(pc) as { path: string; status: string }[];
const send = (w: { appKey: string }, folders: unknown[]) => cn('POST', '/folders', w.appKey, { folders });

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahfold-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  app = await buildApp(testConfig(dir, { maintenanceSeconds: undefined }) as Config);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base));
});
afterAll(async () => { await app.close(); });

describe('a folder the connector sends', () => {
  it('becomes a proposed row, once, and the route needs the app key', async () => {
    const w = await world('fold-basic');
    const p = 'C:\\Users\\b\\Work\\Notes';
    const r = await send(w, [{ agent: w.label, path: p }]);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ proposed: 1, known: 0, refused: [] });
    expect(rows(w.pc)).toEqual([{ path: p, status: 'proposed' }]);
    expect((await send(w, [{ agent: w.label, path: p }])).body).toMatchObject({ proposed: 0, known: 1 });
    expect(rows(w.pc)).toHaveLength(1);
    expect((await cn('POST', '/folders', null, { folders: [] })).status).toBe(401);
    expect((await cn('POST', '/folders', w.appKey, { folders: [], extra: 1 })).status).toBe(400);
  });
  it('is approved by the operator like a setup_pc proposal, and an approved row is left as it is', async () => {
    const w = await world('fold-approve');
    const p = '/home/b/work/notes';
    await send(w, [{ agent: w.label, path: p }]);
    expect(app.setup.approvedFolders(w.pc)).toEqual([]);
    expect((await api('POST', `/pcs/${w.pc}/folders/${encodeURIComponent(p)}/approve`)).status).toBe(200);
    expect(app.setup.approvedFolders(w.pc)).toEqual([p]);
    expect((await send(w, [{ agent: w.label, path: p }])).body).toMatchObject({ proposed: 0, known: 1 });
    expect(rows(w.pc)).toEqual([{ path: p, status: 'approved' }]);
  });
  it('is refused for an unknown agent, a relative, unnormalised or too wide path, and the rest still goes through', async () => {
    const w = await world('fold-refuse');
    const good = 'C:\\Users\\b\\Docs';
    const r = await send(w, [
      { agent: 'someone else', path: 'C:\\Users\\b\\Other' },
      { agent: w.label, path: 'docs\\notes' },
      { agent: w.label, path: 'C:\\Users\\b\\..\\x\\y' },
      { agent: w.label, path: 'C:\\' },
      { agent: w.label, path: '/home' },
      { agent: w.label, path: good },
    ]);
    expect(r.status).toBe(200);
    expect(r.body.proposed).toBe(1);
    expect(r.body.refused).toHaveLength(5);
    expect(rows(w.pc)).toEqual([{ path: good, status: 'proposed' }]);
  });
  it('is matched by the agent id, or by the folder slug of its label (what the connector knows), not only by the label', async () => {
    const w = await world('fold-slug', 'Auto coordinator');
    const id = (app.db.prepare('SELECT id FROM agents WHERE label=?').get('Auto coordinator') as { id: string }).id;
    const r = await send(w, [
      { agent: 'auto-coordinator', path: 'C:\\Users\\b\\Slug' },
      { agent: 'auto-coordinator-2', agent_id: id, path: 'C:\\Users\\b\\ById' },
      { agent: 'nobody', agent_id: 'agent-notmine', path: 'C:\\Users\\b\\Nobody' },
    ]);
    expect(r.body).toMatchObject({ proposed: 2 });
    expect(r.body.refused.map((x: { reason: string }) => x.reason)).toEqual(['unknown_agent']);
  });
  it('is refused for an agent of another PC', async () => {
    const w = await world('fold-own', 'own agent'), other = await world('fold-foreign', 'foreign agent');
    expect((await send(w, [{ agent: other.label, path: 'C:\\Users\\b\\Foreign' }])).body.proposed).toBe(0);
    expect(rows(w.pc)).toEqual([]);
  });
});

describe('a transfer into a PC', () => {
  it('is allowed only for an approved row, never for a proposed one', async () => {
    const w = await world('fold-transfer');
    const p = 'C:\\Users\\b\\Shared';
    await send(w, [{ agent: w.label, path: p }]);
    expect(isPathAllowed(`${p}\\a.txt`, app.setup.approvedFolders(w.pc), 'win32')).toBe(false);
    await api('POST', `/pcs/${w.pc}/folders/${encodeURIComponent(p)}/approve`);
    expect(isPathAllowed(`${p}\\a.txt`, app.setup.approvedFolders(w.pc), 'win32')).toBe(true);
    expect(isPathAllowed('C:\\Users\\b\\Elsewhere\\a.txt', app.setup.approvedFolders(w.pc), 'win32')).toBe(false);
  });
});
