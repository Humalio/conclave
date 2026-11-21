import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { mapLine } from '../src/shares/shares.js';
import { LeakGuard } from '../src/guard/leakGuard.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base: string, cookie = '', csrf = '', appKey = '', vaultDir = '';

const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
type Call = (name: string, args?: Record<string, unknown>) => Promise<{ isError?: boolean; structuredContent?: any; content: { text: string }[] }>;
type Rules = { effect: 'allow' | 'deny'; actions: string[]; resource: string }[];

const TOOLS: Rules = [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }];
const MSG: Rules = [{ effect: 'allow', actions: ['message.send', 'message.receive'], resource: 'agent:*' }];
const SHARE: Rules = [{ effect: 'allow', actions: ['share.create', 'share.upload', 'share.read', 'share.comment', 'share.suggest', 'share.promote'], resource: 'share:*' }];
const FS: Rules = [{ effect: 'allow', actions: ['fs.list', 'fs.read', 'fs.search', 'fs.create', 'fs.update', 'fs.history', 'fs.download'], resource: 'path:/vault/**' }];
const CHAN: Rules = [{ effect: 'allow', actions: ['channel.use'], resource: 'channel:*' }, { effect: 'allow', actions: ['channel.open', 'channel.accept'], resource: 'agent:*' }];
const BASE_RULES = [...TOOLS, ...MSG, ...SHARE, ...FS];

async function loginWith(key: string, secret: string): Promise<Call> {
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  const token = ((await c.callTool({ name: 'session_login', arguments: { session_key: secret } })) as any).structuredContent.session_token as string;
  return async (name, args = {}) => (await c.callTool({ name, arguments: { session_token: token, ...args } })) as never;
}
const mk = async (label: string, rules: Rules = BASE_RULES) => {
  const agent = app.keys.createAgent(label, null, sys);
  const k = app.keys.createSessionKey({ agentId: agent.id, label: `${label} key` }, sys);
  app.keys.setRules(k.credential.policy_id, rules, 'test', sys);
  return { id: agent.id, cred: k.credential, call: await loginWith(appKey, k.secret) };
};
type P = Awaited<ReturnType<typeof mk>>;
const sha = (b: Buffer | string) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const b64 = (b: Buffer) => b.toString('base64');

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah4b-'));
  vaultDir = join(dir, 'vault');
  mkdirSync(vaultDir, { recursive: true });
  const config: Config = testConfig(dir, { vaultDir, maintenanceSeconds: undefined });
  app = await buildApp(config);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base));
  const pc = (await api('POST', '/pcs', { name: 'pc' })).body.pc.id;
  appKey = app.keys.createAppKey({ machineId: pc, appName: 'claude-code', maxLiveSessions: 500 }, sys).secret;
});
afterAll(async () => { await app.close(); });

describe('an open agent-to-agent channel stops relaying when its grants are revoked', () => {
  const open = async (A: P, R: P, chunks: Buffer[]) => {
    const data = Buffer.concat(chunks);
    const o = await A.call('channel_open', { to: `agent:${R.id}`, purpose: 'x', size: data.length, sha256: sha(data) });
    const cid = o.structuredContent.channel_id as string;
    expect((await R.call('channel_accept', { channel_id: cid })).structuredContent.status).toBe('open');
    expect((await A.call('channel_send', { channel_id: cid, seq: 0, data: b64(chunks[0]!) })).structuredContent.ok).toBe(true);
    return cid;
  };
  const chunks = () => [randomBytes(1000), randomBytes(1000)];

  it.each([
    ['the sender loses channel.use', 'sender', [...BASE_RULES, { effect: 'allow', actions: ['channel.open'], resource: 'agent:*' }] as Rules],
    ['the sender loses channel.open on the receiver', 'sender', [...BASE_RULES, { effect: 'allow', actions: ['channel.use'], resource: 'channel:*' }] as Rules],
    ['the receiver loses channel.accept', 'receiver', [...BASE_RULES, { effect: 'allow', actions: ['channel.use'], resource: 'channel:*' }] as Rules],
    ['the receiver loses channel.use', 'receiver', [...BASE_RULES, { effect: 'allow', actions: ['channel.open', 'channel.accept'], resource: 'agent:*' }] as Rules],
  ])('%s', async (_name, who, rules) => {
    const A = await mk('s-' + _name.slice(0, 8), [...BASE_RULES, ...CHAN]), R = await mk('r-' + _name.slice(0, 8), [...BASE_RULES, ...CHAN]);
    const cs = chunks(), cid = await open(A, R, cs);
    app.keys.setRules((who === 'sender' ? A : R).cred.policy_id, rules, 'test', sys);
    // the next chunk is refused and the channel ends, so the receiver's call finds it failed
    const next = (await A.call('channel_send', { channel_id: cid, seq: 1, data: b64(cs[1]!), final: true })).structuredContent;
    expect(next.ok).not.toBe(true);
    expect(next.error === 'denied' || next.failure_reason === 'denied').toBe(true);
    expect(app.channels.get(cid)).toMatchObject({ status: 'failed', failure_reason: 'denied' });
    const got = (await R.call('channel_receive', { channel_id: cid })).structuredContent; // a receiver without channel.use is refused by the tool itself
    expect(got.status === 'failed' || got.error === 'denied').toBe(true);
  });

  it('a receiver waiting in channel_receive is released as failed when a sender grant is revoked', async () => {
    const A = await mk('s-wait', [...BASE_RULES, ...CHAN]), R = await mk('r-wait', [...BASE_RULES, ...CHAN]);
    const cs = chunks(), cid = await open(A, R, cs);
    app.keys.setRules(A.cred.policy_id, BASE_RULES, 'test', sys);
    app.channels.sweep(); // the hub's regular sweep ends it
    expect(app.channels.get(cid)).toMatchObject({ status: 'failed', failure_reason: 'denied' });
  });

  it('a channel whose grants stay is not touched', async () => {
    const A = await mk('s-ok', [...BASE_RULES, ...CHAN]), R = await mk('r-ok', [...BASE_RULES, ...CHAN]);
    const cs = chunks(), cid = await open(A, R, cs);
    app.channels.sweep();
    expect(app.channels.get(cid)!.status).toBe('open');
    expect((await A.call('channel_send', { channel_id: cid, seq: 1, data: b64(cs[1]!), final: true })).structuredContent.ok).toBe(true);
  });
});
