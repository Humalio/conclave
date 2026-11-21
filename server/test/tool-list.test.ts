/**
 * The tool list a session sees (docs/mcp.md, "The tool list"): only the tools its grants and team roles could allow. A tool
 * left out still answers a call with the same refusal, and the digest header tells the connector when the list changed.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { testConfig, adminLogin } from './hub.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const sys = { kind: 'system' as const, id: null };
let app: App, base = '', appKey = '', team = '', pc = '';
const tok: Record<string, string> = {};
const policy: Record<string, string> = {};

/** One /mcp request; with a token it goes in the session header, as the connector sends it. */
const rpc = async (method: string, params: Record<string, unknown>, token?: string) => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${appKey}`, ...(token ? { 'x-agent-hub-session': token } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return { status: r.status, digest: r.headers.get('x-agent-hub-tools'), body: (await r.json()) as any };
};
const list = async (token?: string) => { const r = await rpc('tools/list', {}, token); return { ...r, tools: r.body.result.tools as { name: string }[] }; };
const names = async (token?: string) => (await list(token)).tools.map((t) => t.name);

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahtools-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  const config: Config = testConfig(dir);
  app = await buildApp(config);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  const { cookie, csrf } = await adminLogin(base);
  pc = ((await (await fetch(`${base}/api/pcs`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: JSON.stringify({ name: 'pc' }) })).json()) as any).pc.id as string;
  appKey = app.keys.createAppKey({ machineId: pc, appName: 'claude-code', maxLiveSessions: 20 }, sys).secret;
  // Grants as onboarding gives them (file, directive and feedback tools); the team adds the rest.
  const agent = (label: string) => {
    const a = app.keys.createAgent(label, null, sys);
    const k = app.keys.createSessionKey({ agentId: a.id, label }, sys);
    app.keys.setRules(k.credential.policy_id, ['tool:file_*', 'tool:directives_*', 'tool:feedback_*'].map((resource) => ({ effect: 'allow' as const, actions: ['tool.invoke'], resource })), 'test', sys);
    policy[label] = k.credential.policy_id;
    return { id: a.id, cred: k.credential.id, secret: k.secret, policy: k.credential.policy_id };
  };
  const c = agent('coord'), w = agent('worker'), lone = agent('lone');
  team = app.teams.create({ name: 'Tool Lab', goal: 'g', members: [{ agent_id: c.id, role: 'coordinator', credential_id: c.cred }, { agent_id: w.id, role: 'worker', credential_id: w.cred }] }, sys).id;
  app.teams.start(team, sys);
  for (const [k, a] of Object.entries({ coord: c, worker: w, lone })) {
    const r = await rpc('tools/call', { name: 'session_login', arguments: { session_key: a.secret } });
    tok[k] = r.body.result.structuredContent.session_token;
  }
});
afterAll(async () => { await app?.close(); });

const COORDINATOR_ONLY = ['task_create', 'task_update', 'task_assign', 'task_complete', 'task_reopen', 'task_block', 'task_cancel', 'team_complete', 'team_pause', 'team_resume', 'agent_reset', 'bp_report'];

describe('the tool list follows the session', () => {
  it('the list is much smaller for a worker and a coordinator', async () => {
    const size = async (token?: string) => JSON.stringify((await list(token)).tools).length;
    const full = await size(), coord = await size(tok.coord), worker = await size(tok.worker);
    if (process.env.TOOL_SIZES) console.log('TOOLSIZE', JSON.stringify({ full, coordinator: coord, worker }));
    expect(coord).toBeLessThan(full * 0.8);
    expect(worker).toBeLessThan(full * 0.6);
  });
  it('a worker lists its own tools and no coordinator, graph, channel, room or hardware tools', async () => {
    const w = await names(tok.worker);
    for (const t of ['session_whoami', 'work_next', 'task_list', 'task_start', 'task_submit', 'task_claim', 'task_unblock', 'team_ask', 'bp_read', 'bp_write', 'bp_proposals', 'checkout_status', 'share_create', 'file_read', 'directives_read', 'feedback_file', 'channel_status']) expect(w, t).toContain(t);
    for (const t of [...COORDINATOR_ONLY, 'task_review', 'team_recruit', 'graph_query', 'channel_open', 'room_list', 'message_send', 'share_list', 'hw_list', 'hw_join']) expect(w, t).not.toContain(t);
  });
  it('a coordinator lists the coordinator tools; a session without the header lists every tool', async () => {
    const c = await names(tok.coord);
    for (const t of COORDINATOR_ONLY) expect(c, t).toContain(t);
    expect(c).not.toContain('task_claim');
    const all = await names();
    expect(all.length).toBeGreaterThan(c.length);
    for (const t of [...COORDINATOR_ONLY, 'graph_query', 'hw_list', 'channel_open']) expect(all).toContain(t);
    expect((await list()).digest).toBeNull();
  });
  it('a tool left out of the list answers a call with the same refusal as before', async () => {
    const graph = await rpc('tools/call', { name: 'graph_query', arguments: {} }, tok.worker);
    expect(graph.body.result.isError).toBe(true);
    expect(graph.body.result.structuredContent.error).toBe('denied');
    expect(graph.body.result.structuredContent.missing_grant).toEqual({ action: 'tool.invoke', resource: 'tool:graph_query' });
    const create = await rpc('tools/call', { name: 'task_create', arguments: { team_id: team, title: 'x', description: 'y' } }, tok.worker);
    expect(create.body.result.isError).toBe(true);
    expect(create.body.result.structuredContent.error).toBe('denied');
    expect(create.body.result.structuredContent.message).toMatch(/Only the team coordinator can/);
  });
  it('every answer carries the digest; a new grant or an offered machine changes it and the list', async () => {
    const before = await list(tok.worker);
    expect(before.digest).toMatch(/^[0-9a-f]{16}$/);
    const call = await rpc('tools/call', { name: 'session_whoami', arguments: {} }, tok.worker);
    expect(call.digest).toBe(before.digest);
    expect((await list(tok.coord)).digest).not.toBe(before.digest);
    const rules = app.keys.rules(policy.worker).filter((r) => !r.team_id).map(({ effect, actions, resource }) => ({ effect, actions, resource }));
    app.keys.setRules(policy.worker, [...rules, { effect: 'allow', actions: ['tool.invoke'], resource: 'tool:graph_query' }], 'test', sys);
    const granted = await rpc('tools/call', { name: 'session_whoami', arguments: {} }, tok.worker);
    expect(granted.digest).not.toBe(before.digest);
    expect(await names(tok.worker)).toContain('graph_query');
    app.hardware.register(pc, { access: 'ssh lab', timezone: 'UTC', windows: [], teams: [team] }, sys);
    const offered = await list(tok.worker);
    expect(offered.digest).not.toBe(granted.digest);
    expect(offered.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['hw_list', 'hw_join', 'hw_report', 'hw_leave']));
    expect(await names(tok.lone)).not.toContain('hw_list');
  });
});
