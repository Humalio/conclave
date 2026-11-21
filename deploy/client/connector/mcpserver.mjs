/**
 * `conclave mcp <folder>`: the local stdio MCP server of one registered agent folder (docs/connector.md).
 *
 * Claude Code and Codex start it from the folder's own MCP entry. It asks the connector's broker (broker.mjs) for a turn
 * token, outside the model, and relays each JSON-RPC message to the hub over pinned HTTPS only, with that token and nothing
 * else: this process never opens a key file or holds a key. The agent never calls session_login and never sees a token. When the folder cannot sign in, the process still answers `initialize` itself, so the session gets the fixed
 * reason and what to run (as the server's instructions and as the one tool `conclave_status`) instead of a bare
 * "connection closed". stdout carries JSON-RPC only, one message per line; one line per start and failure goes to
 * connector.log (folder and a reason code, never a key or token).
 *
 * task_submit and task_review calls without a request_id get one (docs/mcp.md), so a retried call after a lost reply
 * returns the first result instead of recording twice.
 *
 * A Codex agent's folder (registered with provider codex) also gets one local tool, `commit` (commit.mjs): Codex keeps
 * `.git` read-only in its sandbox, so this server commits the files the agent names, outside the sandbox, as the agent,
 * with hooks off and no push. It is answered here and never reaches the hub.
 */
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { post, connect } from './hubclient.mjs';
import { resolveFolder } from './registry.mjs';
import { askBroker } from './brokerclient.mjs';
import { line as reasonLine } from './reasons.mjs';
import { oneLine } from './paths.mjs';
import { lineFor } from './hook.mjs';
import { TOOL as COMMIT_TOOL, TOOL_NAME as COMMIT, commitFiles, commitAnswer } from './commit.mjs';

export const VERSION = '1';
const CALL_TIMEOUT_MS = 10 * 60_000; // poll calls wait up to 45 s; tool calls can take longer
const STATUS_TOOL = 'conclave_status';
const ONCE_TOOLS = new Set(['task_submit', 'task_review']);
const sorted = (v) => (Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);

/** The same call (tool and arguments) always gets the same request id; key order does not matter. */
export function withRequestId(msg) {
  const p = msg && !Array.isArray(msg) && msg.method === 'tools/call' ? msg.params : null;
  if (!p || !ONCE_TOOLS.has(p.name) || !p.arguments || typeof p.arguments !== 'object' || p.arguments.request_id !== undefined) return msg;
  const rid = 'cb-' + createHash('sha256').update(JSON.stringify([p.name, sorted(p.arguments)])).digest('hex').slice(0, 32);
  return { ...msg, params: { ...p, arguments: { ...p.arguments, request_id: rid } } };
}

/** The local answers of a folder that cannot sign in: initialize, tools/list, the one status tool, ping. */
export function speakUp(msg, reason) {
  const text = `Conclave: ${reasonLine(reason)}`;
  const id = msg?.id;
  if (id === undefined || id === null) return null; // a notification: nothing to answer
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  switch (msg.method) {
    case 'initialize':
      return ok({ protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'conclave', version: VERSION }, instructions: text });
    case 'ping': return ok({});
    case 'tools/list':
      return ok({ tools: [{ name: STATUS_TOOL, description: 'Why this folder is not connected to its Conclave hub, and what to run. Read-only.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } }] });
    case 'tools/call':
      return ok({ content: [{ type: 'text', text }], structuredContent: { connected: false, reason, message: text }, isError: true });
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: text } };
  }
}

/** The author line of a commit: the agent's label from the hub (no angle brackets or line breaks) and an address that never resolves. */
export const commitAuthor = (label, agentId) => label ? { name: String(label).replace(/[<>\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 200), email: `${String(agentId ?? 'agent').replace(/[^A-Za-z0-9_.-]/g, '')}@agents.conclave.invalid` } : null;

export async function runMcp(folderArg, { home, input = process.stdin, output = process.stdout, err = process.stderr, gitBin } = {}) {
  const logLine = (what) => { try { mkdirSync(home, { recursive: true }); appendFileSync(join(home, 'connector.log'), `${new Date().toISOString()} mcp ${oneLine(what)}\n`); } catch { /* logging is best effort */ } };
  const write = (m) => output.write(JSON.stringify(m) + '\n');
  const rpcError = (id, text) => { if (id !== undefined && id !== null) write({ jsonrpc: '2.0', id, error: { code: -32000, message: `conclave: ${oneLine(text)}` } }); };

  // Identity comes from the connector's registry (no key in it). The session holds a turn token and nothing else: no session key, no app key.
  const reg = resolveFolder(home, folderArg);
  const folder = reg.ok ? reg.folder : folderArg;
  let token = null, hub = null, mode = 'speak', reason = reg.ok ? null : reg.reason, agentLabel = null, agentId = null;
  const codexFolder = reg.ok && reg.binding.provider === 'codex';
  /** Asks the connector's broker for this folder's turn token (a new one when `fresh`). `{ok: true}` or `{ok: false, reason}`. */
  const getToken = async (fresh) => {
    const r = await askBroker(home, { op: 'turn', folder, pid: process.pid, ...(fresh ? { fresh: true } : {}) });
    if (!r.ok) return { ok: false, reason: typeof r.reason === 'string' ? r.reason : 'connector_not_running' };
    // The hub is pinned by what the registry recorded when the folder was bound: its CA (the broker's certificate must be
    // exactly that one) and its origin. A binding from an older connector has no origin yet; the verified broker's is used.
    if (reg.binding.origin && r.origin !== reg.binding.origin) return { ok: false, reason: 'ca_changed' };
    const c = connect({ origin: reg.binding.origin ?? r.origin, ca_pem: r.ca_pem, ca_sha256: reg.binding.ca_sha256 });
    if (!c.ok) return { ok: false, reason: c.reason };
    hub = c.hub; token = r.token; agentLabel = r.label ?? null; agentId = r.agent_id ?? null;
    return { ok: true };
  };
  const start = (async () => {
    if (!reg.ok) return;
    const r = await getToken(false);
    if (r.ok) mode = 'relay'; else reason = r.reason;
  })();
  start.then(() => logLine(`${mode === 'relay' ? 'ok' : 'speaking-up ' + reason} folder=${folder}`));

  let protocolVersion = null, sessionId = null, relogin = null;
  // Codex gets the one reminder line at the start of each woken turn (docs/connector.md): a woken turn is a new process,
  // so the first tool result of this process carries it. Claude Code has the folder hook instead.
  let codexClient = false, lineDone = false;
  // The digest of the tools the client last listed: when an answer carries another one, the client is told to list again
  // (docs/connector.md, "The tool list follows the session"). The hub is stateless and cannot send this itself.
  let listed = null;
  const refresh = (stale) => {
    if (token !== stale) return Promise.resolve({ ok: true });
    relogin ??= getToken(true).finally(() => { relogin = null; });
    return relogin;
  };
  const headers = () => ({ 'X-Agent-Hub-Session': token, ...(protocolVersion ? { 'mcp-protocol-version': protocolVersion } : {}), ...(sessionId ? { 'mcp-session-id': sessionId } : {}) });

  async function relay(msg) {
    const id = Array.isArray(msg) ? null : msg?.id;
    if (codexFolder && !Array.isArray(msg) && msg?.method === 'tools/call' && msg.params?.name === COMMIT) {
      if (id === undefined || id === null) return;
      const a = msg.params.arguments && typeof msg.params.arguments === 'object' ? msg.params.arguments : {};
      const r = commitFiles({ home, folder, paths: a.paths, message: a.message, branch: a.branch ?? null, author: commitAuthor(agentLabel, agentId), gitBin });
      logLine(`commit ${r.ok ? `ok ${r.commit.slice(0, 12)} on ${r.branch}, ${r.files.length} file(s)` : 'refused'} folder=${folder}`);
      return write({ jsonrpc: '2.0', id, result: commitAnswer(r) });
    }
    const body = JSON.stringify(withRequestId(msg));
    try {
      const sent = token;
      let r = await post(hub, body, headers(), CALL_TIMEOUT_MS);
      if (r.status === 401) {
        const f = await refresh(sent);
        if (f.ok === false) { mode = 'speak'; reason = f.reason; logLine(`speaking-up ${reason} folder=${folder}`); return rpcError(id, reasonLine(reason)); }
        r = await post(hub, body, headers(), CALL_TIMEOUT_MS);
        if (r.status === 401) { mode = 'speak'; reason = 'login_refused'; logLine(`speaking-up ${reason} folder=${folder}`); return rpcError(id, reasonLine(reason)); }
      }
      if (r.status === 202 || r.status === 204) return; // a notification or a response: nothing comes back
      if (r.status !== 200) {
        const b = r.body && typeof r.body === 'object' && !Array.isArray(r.body) ? r.body : null;
        if (b && b.jsonrpc === '2.0' && b.error && typeof b.error === 'object' && b.id === id && id !== undefined && id !== null) return write(b);
        const code = typeof b?.error === 'string' ? b.error : null;
        const message = typeof b?.message === 'string' ? b.message : typeof b?.error?.message === 'string' ? b.error.message : null;
        return rpcError(id, `the hub answered HTTP ${r.status}${[code, message].filter(Boolean).length ? `: ${[code, message].filter(Boolean).join(': ').slice(0, 500)}` : ''}`);
      }
      if (r.sessionId) sessionId = r.sessionId;
      const listing = !Array.isArray(msg) && msg?.method === 'tools/list';
      const changed = !listing && r.tools && listed && r.tools !== listed;
      if (r.tools && (listing || changed)) listed = r.tools;
      for (const m of r.messages) {
        if (msg?.method === 'initialize' && m?.id === id && typeof m?.result?.protocolVersion === 'string') protocolVersion = m.result.protocolVersion;
        if (msg?.method === 'initialize') codexClient = /codex/i.test(String(msg?.params?.clientInfo?.name ?? ''));
        if (codexFolder && msg?.method === 'tools/list' && m?.id === id && Array.isArray(m?.result?.tools) && !msg.params?.cursor && !m.result.tools.some((t) => t?.name === COMMIT)) m.result.tools = [...m.result.tools, COMMIT_TOOL];
        if (codexClient && !lineDone && msg?.method === 'tools/call' && m?.id === id && Array.isArray(m?.result?.content) && !m.result.isError) {
          lineDone = true;
          const l = await lineFor(home, folder, { timeoutMs: 3000 });
          if (l) m.result.content = [...m.result.content, { type: 'text', text: l }];
        }
        write(m);
      }
      if (changed) { logLine(`tools changed folder=${folder}`); write({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }); }
    } catch (e) {
      logLine(`fail ${e.reason ?? 'hub_unreachable'} folder=${folder}`);
      rpcError(id, reasonLine(e.reason ?? 'hub_unreachable'));
    }
  }

  const pending = new Set();
  const rl = createInterface({ input, crlfDelay: Infinity });
  rl.on('line', (text) => {
    if (!text.trim()) return;
    const p = (async () => {
      let msg;
      try { msg = JSON.parse(text); } catch { return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'conclave: not JSON' } }); }
      await start;
      if (mode === 'relay') return relay(msg);
      const a = Array.isArray(msg) ? msg.map((m) => speakUp(m, reason)).filter(Boolean) : speakUp(msg, reason);
      if (a && (!Array.isArray(a) || a.length)) write(a);
    })().finally(() => pending.delete(p));
    pending.add(p);
  });
  await new Promise((res) => rl.on('close', res));
  await Promise.allSettled([...pending]);
  // The session is over: the connector revokes its turn token now instead of waiting for it to notice.
  if (mode === 'relay') await askBroker(home, { op: 'end', pid: process.pid }, { timeoutMs: 3000 });
  void err;
}
