/**
 * The connector's local broker (docs/connector.md, "Isolation levels"): the one process that loads a long-lived key.
 *
 * Every session (a hand-opened chat, the wake's runs, a Codex agent) talks to the hub with a TURN TOKEN and nothing else.
 * `conclave mcp` and the folder hook ask this broker, over a local pipe (Windows) or a 0600 socket (macOS, Linux), for
 * the token of their folder; the broker signs in with the agent's key, which no other process opens, and keeps the run:
 *
 * - **registered**: folder, process id, agent. A hand-opened chat's first registration in a folder waits for the PC
 *   user's click (approvals.mjs); a run the connector started itself does not.
 * - **renewed** every few minutes while its process lives, so a turn of any length keeps its token; a hub that refuses
 *   a renewal (paused team, lockdown, suspended key) ends the run's token, and the run's next call is refused.
 * - **ended** when its process is gone (or the session says so): the token is revoked on the hub and the run's
 *   transcript is scanned for a long-lived key.
 *
 * The broker's answers hold a token, the hub's origin and its public CA, never a key. Neither isolation level separates two
 * live agents of one OS user: registration is self-asserted, which is why the first one per folder needs a click and why the
 * hub alerts on two live bindings of one agent.
 */
import net from 'node:net';
import { join } from 'node:path';
import { mkdirSync, rmSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { WIN, pathKey, oneLine, atomicWrite } from './paths.mjs';
import { brokerAddress, brokerSecretPath, brokerProof, proofMatches } from './brokerclient.mjs';
import { resolveContext } from './context.mjs';
import { request } from './hubclient.mjs';
import { alive, markRunning } from './run.mjs';
import { folderApproved, requestFolder, folderDenied } from './approvals.mjs';
import { scanTranscript } from './leak.mjs';
import { lineForLocal } from './hook.mjs';
import { readIsolation } from './isolation.mjs';
import { askVault } from './vaultclient.mjs';

/** Renew a turn token this often (it lives 15 minutes unless renewed). */
export { brokerAddress, askBroker } from './brokerclient.mjs';
export const RENEW_MS = 5 * 60_000;
/** The most one request line may be. */
const MAX_LINE = 16 * 1024;

/**
 * Starts the broker. `deps` replaces the renewal interval (`renewMs`), the clock-free pieces tests need (`alive`, `lineFor`),
 * and `launcherRuns` (a Set of folder keys the connector started itself, so they need no click).
 * Returns `{address, runs, close, endRun, renewAll}`.
 */
export async function startBroker({ home, log = () => {}, deps = {} }) {
  const address = deps.address ?? brokerAddress(home);
  if (!address) throw new Error('the connector folder path is too long for a local socket, and there is no private runtime folder (XDG_RUNTIME_DIR) to use instead');
  // A new secret at each start (brokerclient.mjs), readable by this OS user only. It is written once this broker listens, so a
  // second start that cannot take the address never replaces the secret of the broker that holds it.
  const secret = randomBytes(32).toString('hex');
  const isAlive = deps.alive ?? alive;
  const runs = new Map(); // pid -> run
  const launcherRuns = deps.launcherRuns ?? new Set();
  const auth = (run) => ({ Authorization: `Bearer ${run.appKey}` });
  const fresh = () => `r-${randomBytes(6).toString('hex')}`;

  /** The end-of-turn scan. At the hardened level the exact keys are only in the key service, so it is asked (a yes or no); the key-shaped text is looked for here. */
  async function scan(run) {
    const iso = readIsolation(home);
    if (iso.level !== 'hardened') return scanTranscript(run.transcript, [run.sessionKey, run.appKey]);
    const local = scanTranscript(run.transcript, []);
    if (!local.ok || local.found) return local;
    const v = await askVault(iso.address, 'scan', { path: run.transcript, hubKey: run.hubKey, label: run.label }, { timeoutMs: 10_000 });
    return v.ok ? { ok: true, found: v.found === true, kind: v.kind ?? null } : { ok: false };
  }

  /** Ends one run: revokes its token on the hub (after scanning its transcript) and forgets it. */
  async function endRun(run, why = 'turn_ended', { revoke = true } = {}) {
    if (!runs.delete(run.pid)) return;
    run.unmark?.();
    let reason = why;
    if (run.transcript) {
      const r = await scan(run);
      if (r.ok && r.found) { reason = 'leak_found'; log(`broker: a long-lived key was found in the transcript of ${run.label} (${r.kind}); the turn token was revoked`); }
      else if (!r.ok) log(`broker: the transcript of ${run.label} could not be scanned`);
    }
    run.sessionKey = null;
    if (revoke) await request(run.hub, 'POST', '/connector/v1/turn-tokens/revoke', { body: { token: run.token, reason: reason === 'leak_found' ? 'leak_found' : 'turn_ended' }, headers: auth(run) }).catch((e) => log(`broker: the turn token of ${run.label} could not be revoked (${e.reason ?? e.message})`));
    run.token = null;
  }

  /** Renews every live run's token; ends the runs whose process is gone. */
  async function renewAll() {
    for (const run of [...runs.values()]) {
      if (!isAlive(run.pid)) { await endRun(run); continue; }
      const r = await request(run.hub, 'POST', '/connector/v1/turn-tokens/renew', { body: { token: run.token }, headers: auth(run) }).catch((e) => ({ status: 0, reason: e.reason }));
      if (r.status === 200) run.expires_at = r.json?.expires_at ?? run.expires_at;
      else if (r.status >= 400 && r.status < 500) {
        // A pause, a lockdown or a suspended key: a run the wake started is ended (its process tree, after the tool it is in), and its transcript is scanned either way.
        log(`broker: the hub refused to renew the turn token of ${run.label} (${r.status}); the run ends`);
        let ended = false;
        try { ended = (await api.onRefused?.(run)) === true; } catch (e) { log(`broker: ${oneLine(e.message)}`); }
        if (ended) log(`broker: the woken run of ${run.label} was stopped`);
        await endRun(run, 'refused', { revoke: false });
      }
      // A hub that cannot be reached keeps the run: its token simply runs out in at most 15 minutes if the hub stays away.
    }
  }

  async function turn(q) {
    if (typeof q.folder !== 'string' || !Number.isSafeInteger(q.pid) || q.pid <= 0) return { ok: false, reason: 'bad_request' };
    let ctx = resolveContext(home, q.folder);
    if (!ctx.ok) return { ok: false, reason: ctx.reason };
    const bound = ctx.binding;
    if (!launcherRuns.has(pathKey(ctx.folder)) && !folderApproved(home, ctx.folder, bound)) {
      // A chat the PC user denied is told so for ten minutes and is not put back on the screen; after that it asks again.
      if (folderDenied(home, ctx.folder)) return { ok: false, reason: 'denied' };
      requestFolder(home, ctx.folder, bound);
      return { ok: false, reason: 'needs_click' };
    }
    const have = runs.get(q.pid);
    if (have && !q.fresh && have.folderKey === pathKey(ctx.folder)) return answer(have);
    if (have) await endRun(have, 'turn_ended');
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await request(ctx.hub, 'POST', '/connector/v1/turn-tokens', { body: { session_key: ctx.sessionKey, run: fresh() }, headers: { Authorization: `Bearer ${ctx.appKey}` } }).catch((e) => ({ status: 0, reason: e.reason }));
      if (r.status === 200 && typeof r.json?.token === 'string') {
        const run = { pid: q.pid, folder: ctx.folder, folderKey: pathKey(ctx.folder), label: bound.agent, hubKey: ctx.hubKey, hub: ctx.hub, caPem: ctx.caPem, appKey: ctx.appKey, sessionKey: ctx.sessionKey, token: r.json.token, agentId: r.json.agent_id ?? null, agentLabel: r.json.label ?? null, expires_at: r.json.expires_at ?? null, transcript: null, startedAt: Date.now() };
        run.unmark = markRunning(home, ctx.hubKey, bound.agent, run.agentId, q.pid);
        runs.set(q.pid, run);
        return answer(run);
      }
      if (r.status === 0) return { ok: false, reason: r.reason ?? 'hub_unreachable' };
      // The hub refused the key: the key file may have been rotated since this context was read; read it once more.
      const again = resolveContext(home, q.folder);
      if (attempt === 0 && again.ok && again.sessionKey !== ctx.sessionKey) { ctx = again; continue; }
      return { ok: false, reason: 'login_refused' };
    }
    return { ok: false, reason: 'login_refused' };
  }
  const answer = (run) => ({ ok: true, token: run.token, origin: run.hub.origin, ca_pem: run.caPem, agent_id: run.agentId, label: run.agentLabel, expires_at: run.expires_at });

  async function handle(q) {
    switch (q?.op) {
      case 'turn': return turn(q);
      case 'probe': {
        // `conclave check --probe`: can this folder's agent sign in? One turn token is issued and revoked at once; nothing is kept.
        if (typeof q.folder !== 'string') return { ok: false, reason: 'bad_request' };
        const ctx = resolveContext(home, q.folder);
        if (!ctx.ok) return { ok: false, reason: ctx.reason };
        const r = await request(ctx.hub, 'POST', '/connector/v1/turn-tokens', { body: { session_key: ctx.sessionKey, run: fresh() }, headers: { Authorization: `Bearer ${ctx.appKey}` } }).catch((e) => ({ status: 0, reason: e.reason }));
        if (r.status === 0) return { ok: false, reason: r.reason ?? 'hub_unreachable' };
        if (r.status !== 200 || typeof r.json?.token !== 'string') return { ok: false, reason: 'login_refused' };
        await request(ctx.hub, 'POST', '/connector/v1/turn-tokens/revoke', { body: { token: r.json.token, reason: 'turn_ended' }, headers: { Authorization: `Bearer ${ctx.appKey}` } }).catch(() => {});
        return { ok: true };
      }
      case 'end': { const r = runs.get(q.pid); if (r) await endRun(r); return { ok: true }; }
      case 'transcript': {
        // The hook reports where a chat's transcript is: the run of that folder keeps it for the end-of-turn scan.
        if (typeof q.folder !== 'string' || typeof q.path !== 'string' || q.path.length > 1024) return { ok: false, reason: 'bad_request' };
        const k = pathKey(q.folder);
        for (const r of runs.values()) if (r.folderKey === k || pathKey(r.folder) === k) r.transcript = q.path;
        return { ok: true };
      }
      case 'reminder': {
        if (typeof q.folder !== 'string') return { ok: false, reason: 'bad_request' };
        const line = await (deps.lineFor ?? lineForLocal)(home, q.folder, { timeoutMs: Math.min(Number(q.timeoutMs) || 3000, 10_000), report: q.report !== false });
        return { ok: true, line: line ?? null };
      }
      default: return { ok: false, reason: 'bad_request' };
    }
  }

  if (!WIN) {
    try { mkdirSync(join(address, '..'), { recursive: true, mode: 0o700 }); } catch { /* listen reports it */ }
    // A socket file left by a broker that died is removed; one a live broker still answers on is not: a second start fails and leaves it (and its secret) alone.
    const live = await new Promise((res) => { const c = net.connect(address); c.once('connect', () => { c.destroy(); res(true); }); c.once('error', () => res(false)); });
    if (live) throw Object.assign(new Error('the broker address is taken by a running broker'), { code: 'EADDRINUSE' });
    try { rmSync(address, { force: true }); } catch { /* listen reports it */ }
  }
  const server = net.createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.setTimeout(30_000, () => sock.destroy());
    sock.on('data', (d) => {
      buf += d;
      if (buf.length > MAX_LINE) return sock.destroy();
      const i = buf.indexOf('\n');
      if (i < 0) return;
      let q = null;
      try { q = JSON.parse(buf.slice(0, i)); } catch { /* answered below */ }
      buf = '';
      // A request that does not prove it holds the secret gets nothing: no token, no origin, no proof of this broker.
      const nonce = typeof q?.nonce === 'string' && /^[0-9a-f]{32}$/.test(q.nonce) ? q.nonce : null;
      if (!nonce || !proofMatches(brokerProof(secret, 'client', nonce), q.auth)) return sock.end(JSON.stringify({ ok: false, reason: 'bad_request' }) + '\n');
      handle(q).catch((e) => { log(`broker: ${oneLine(e.message)}`); return { ok: false, reason: 'broker_error' }; })
        .then((a) => sock.end(JSON.stringify({ ...a, proof: brokerProof(secret, 'broker', nonce) }) + '\n'));
    });
    sock.on('error', () => { /* the client went away */ });
  });
  await new Promise((ok, no) => { server.once('error', no); server.listen(address, () => { server.off('error', no); ok(); }); });
  if (!WIN) { try { chmodSync(address, 0o600); } catch { /* best effort */ } }
  try {
    mkdirSync(join(home, 'run'), { recursive: true, mode: 0o700 });
    atomicWrite(brokerSecretPath(home), secret + '\n', true);
  } catch (e) { await new Promise((ok) => server.close(() => ok())); throw e; }
  const timer = setInterval(() => { renewAll().catch((e) => log(`broker: renewal failed (${oneLine(e.message)})`)); }, deps.renewMs ?? RENEW_MS);
  timer.unref?.();

  // `onRefused(run)` is set by the worker: it stops the wake's run in that folder and answers true when there was one.
  const api = {
    address, runs, endRun, renewAll, launcherRuns, onRefused: deps.onRefused ?? null,
    async close() {
      clearInterval(timer);
      for (const r of [...runs.values()]) await endRun(r, 'turn_ended');
      await new Promise((ok) => server.close(() => ok()));
      if (!WIN) rmSync(address, { force: true });
    },
  };
  return api;
}
