/**
 * file_patch across a line break (feedback fb_nbw2cdh4it53y: a markdown table row break did not match): an edit's line break
 * also matches a CRLF break and spaces or tabs at the end of that line, only when the exact text is not found. Nothing else
 * is loosened: every other character must be the same and the match must be unique, or nothing changes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import { testConfig, adminLogin } from './hub.js';
import { findPatch, withEol } from '../src/util/patchMatch.js';

const sys = { kind: 'system' as const, id: null };
type Res = { isError?: boolean; structuredContent?: any; content: { text: string }[] };
let app: App, W: (name: string, args?: Record<string, unknown>) => Promise<Res>;

const TABLE = '| Name | Owner |\n|---|---|\n| Plan | Ana |  \n| Budget | Ben |\n';

describe('findPatch', () => {
  it('keeps the exact match first, and its count', () => {
    expect(findPatch('a b a', 'a')).toMatchObject({ matches: 2, at: -1 });
    expect(findPatch('x\r\ny', 'x\r\ny')).toEqual({ at: 0, length: 4, matches: 1, eol: null });
  });
  it('matches a row break with spaces after the row', () => {
    const m = findPatch(TABLE, '| Plan | Ana |\n| Budget | Ben |');
    expect(m).toMatchObject({ matches: 1, eol: '\n' });
    expect(TABLE.slice(m.at, m.at + m.length)).toBe('| Plan | Ana |  \n| Budget | Ben |');
  });
  it('matches a CRLF row break and gives the new text CRLF breaks', () => {
    const crlf = TABLE.replace(/\n/g, '\r\n');
    const m = findPatch(crlf, '|---|---|\n| Plan | Ana |');
    expect(m).toMatchObject({ matches: 1, eol: '\r\n' });
    expect(withEol('|---|---|\n| Plan | Eve |', m.eol)).toBe('|---|---|\r\n| Plan | Eve |');
  });
  it('loosens nothing else: other spaces, case, cell text and a missing break stay exact', () => {
    expect(findPatch(TABLE, '| Plan |  Ana |\n| Budget | Ben |').matches).toBe(0);
    expect(findPatch(TABLE, '| plan | Ana |\n| Budget | Ben |').matches).toBe(0);
    expect(findPatch(TABLE, '| Plan | Ana || Budget | Ben |').matches).toBe(0);
    expect(findPatch(TABLE, '| Plan | Ana |\n\n| Budget | Ben |').matches).toBe(0); // a blank line is not a row break
    expect(findPatch(TABLE, ' | Plan | Ana |\n| Budget').matches).toBe(0);
  });
  it('a loose match must still be unique', () => {
    const twice = '| a |\r\n| b |\n| a | \n| b |\n';
    expect(findPatch(twice, '| a |\n| b |')).toMatchObject({ matches: 2, at: -1 });
  });
});

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahrows-'));
  const vaultDir = join(dir, 'vault');
  mkdirSync(vaultDir, { recursive: true });
  app = await buildApp(testConfig(dir, { vaultDir, maintenanceSeconds: undefined }));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  const { cookie, csrf } = await adminLogin(base);
  const pc = ((await (await fetch(`${base}/api/pcs`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: JSON.stringify({ name: 'pc' }) })).json()) as any).pc.id as string;
  const appKey = app.keys.createAppKey({ machineId: pc, appName: 'claude-code', maxLiveSessions: 5 }, sys).secret;
  const agent = app.keys.createAgent('rows', null, sys);
  const k = app.keys.createSessionKey({ agentId: agent.id, label: 'rows' }, sys);
  app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:file_*' },
    { effect: 'allow', actions: ['fs.list', 'fs.read', 'fs.create', 'fs.update'], resource: 'path:/vault/**' }], 'test', sys);
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  const call = async (name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name, arguments: args })) as Res;
  const token = (await call('session_login', { session_key: k.secret })).structuredContent.session_token as string;
  W = (name, args = {}) => call(name, { session_token: token, ...args });
});
afterAll(async () => { await app.close(); });

describe('file_patch', () => {
  const read = async (path: string) => (await W('file_read', { path })).structuredContent;
  it('patches across a table row break in a CRLF file and keeps its CRLF breaks', async () => {
    const path = '/vault/Rows/crlf.md';
    const c = await W('file_create', { path, content: TABLE.replace(/\n/g, '\r\n') });
    expect(c.isError, c.content[0]?.text).toBeFalsy();
    const p = await W('file_patch', { path, base_revision: c.structuredContent.revision, edits: [{ old: '| Plan | Ana |\n| Budget | Ben |', new: '| Plan | Eve |\n| Budget | Ben |' }] });
    expect(p.isError, p.content[0]?.text).toBeFalsy();
    expect((await read(path)).content).toBe('| Name | Owner |\r\n|---|---|\r\n| Plan | Eve |\r\n| Budget | Ben |\r\n');
  });
  it('refuses a near match and changes nothing', async () => {
    const path = '/vault/Rows/near.md';
    const c = await W('file_create', { path, content: TABLE });
    const p = await W('file_patch', { path, base_revision: c.structuredContent.revision, edits: [{ old: '| Plan | Ana |\n| Budget |  Ben |', new: 'x' }] });
    expect(p.structuredContent?.error).toBe('no_match');
    expect((await read(path)).content).toBe(TABLE);
  });
});
