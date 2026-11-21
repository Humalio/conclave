/**
 * The connector service's worker (docs/connector.md "The connector service"): for every hub in the key file it checks in,
 * fetches PC actions on the pinned poll, runs the bridge's transfers with the app key, and looks for approved updates.
 * When a hub refuses the app key because it disconnected this PC, the worker finishes Disconnect this hub from this PC
 * (disconnect.mjs) on that tick and on the next ones until it is over, so an interrupted one resumes.
 * Once an hour, and only while the PC's user has opted in, it reads the usage of its registered worker sessions
 * (usage.mjs) and sends each hub its own days; while the user has not opted in, nothing is read.
 * A hub whose check-in answers `measure_only` has this PC as a compute machine (docs/hardware.md#measuring): while the
 * machine's user turned measuring on, the worker samples the whole machine every 15 seconds and sends that hub its samples
 * at each check-in, and it refuses that hub's orders but Update (Disconnect comes on its own route).
 * `runSupervisor` is what the logon entry starts: it runs the worker as a child through the launcher and restarts it, so
 * an update or a crash comes back on the current build.
 */
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { readKeyFile, keyFilePresent, encryptInPlace, markDisconnected } from './keyfile.mjs';
import { isHardened } from './isolation.mjs';
import { storeName } from './keystore.mjs';
import { startBroker } from './broker.mjs';
import { createWake } from './wake.mjs';
import { onResetOrder } from './reset.mjs';
import { grandfather, unauditedGrandfathered, markAudited, unauditedPickupAllowed, markPickupAudited, unreportedDenials, markDenialsReported, pruneDenied } from './approvals.mjs';
import { manifestPath } from './manifest.mjs';
import { recordStarted, forgetStarted, takeProcessLock } from './processes.mjs';
import { connect, request, pinnedFetch, openStream } from './hubclient.mjs';
import { recordDelivery, installationId } from './deliveries.mjs';
import { foldersOfHub } from './registry.mjs';
import { runCheck } from './check.mjs';
import { gitPath } from './entries.mjs';
import { readSettings, autoUpdateOn } from './settings.mjs';
import { runningAgents } from './run.mjs';
import { validateOrder, wasHandled, markHandled, ORDER_REASONS } from './orders.mjs';
import { sendResult, flushOutbox } from './outbox.mjs';
import { updateTo, pickUpdate, updateLine, failedVersions } from './update.mjs';
import { confirm, launcherPath, readBuilds, markUp, UP_MS } from './builds.mjs';
import { platformId } from './release.mjs';
import { CONNECTOR_VERSION } from './version.mjs';
import { execDefault, servicePidPath, workerLockPath } from './service.mjs';
import { atomicWrite, oneLine } from './paths.mjs';
import { runDisconnect } from './disconnect.mjs';
import { collectUsage, sendUsage, usageOptIn } from './usage.mjs';
import { runLoop as runBridge, foreignFoldersOf, ownFoldersOf } from './transfers.mjs';
import { createSyncHost } from './syncrunner.mjs';
import { sampler, queueSample, hardwareOptIn, SAMPLE_MS, SAMPLE_MAX } from './hardware.mjs';
import { reportDestinations } from './destinations.mjs';
import { contextReport } from './contextsize.mjs';
import { agentIdOf } from './run.mjs';
import { legacyLeftoverKinds } from './migrate.mjs';

/** The leftover kinds for the check-in, read at most once a minute (on Windows it reads the registry through a child process). */
let leftoversMemo = { at: 0, home: null, value: [] };
export function legacyLeftoverKindsCached(home, now = Date.now(), read = legacyLeftoverKinds) {
  if (leftoversMemo.home !== home || now - leftoversMemo.at >= 60_000) leftoversMemo = { at: now, home, value: read(home) };
  return leftoversMemo.value;
}
import { beginRestore, runRestore, activeRestores, finishRestore, save as saveRestore } from './restore.mjs';
import { runHandovers } from './handover.mjs';
import { advance as advanceSetup, loadSetup } from './onboard.mjs';

export const CHECK_IN_MS = 60_000;
export const UPDATE_CHECK_MS = 6 * 3600_000;
export const USAGE_MS = 3600_000;
/** Days sent: 30 on the first pass after the user opted in (or the worker started), then the last 3 (a day sent again replaces it). */
export const USAGE_FIRST_DAYS = 30, USAGE_DAYS = 3;
/** Exit code of a worker that installed an update and wants to start again on it. */
export const RESTART = 75;
/** Exit code of a worker that found no hub left (the key file gone, or empty) for EMPTY_TICKS check-ins in a row. */
export const NO_HUBS = 76;
export const EMPTY_TICKS = 3;
/** Exit code of a worker (or a supervisor) that found another one of this installation running: it holds the lock. */
export const LOCKED = 77;

/** Appends to connector.log, only while the connector is installed (its manifest is there): never creates its folder again. */
export const logTo = (home) => (what) => { try { if (!existsSync(manifestPath(home))) return; appendFileSync(join(home, 'connector.log'), `${new Date().toISOString()} service ${oneLine(what)}\n`); } catch { /* best effort */ } };
const verOf = (text) => /(\d+\.\d+\.\d+(?:-[a-z0-9.]+)?)/.exec(String(text ?? ''))?.[1] ?? null;

/** Node, git and the clients on this PC: `{node, git, clients}`; a client whose version cannot be read is `null`. */
export function versionsOnPc(home, exec = execDefault, win = process.platform === 'win32') {
  const git = gitPath(home);
  const gitVer = git ? verOf(exec(git, ['--version']).stdout) : null;
  const clients = [];
  for (const [client, names] of [['claude_code', win ? ['claude.exe', 'claude.cmd'] : ['claude']], ['codex', win ? ['codex.exe', 'codex.cmd'] : ['codex']]]) {
    for (const n of names) {
      const r = exec(n, ['--version']);
      if (r.status === 0 || verOf(r.stdout)) { clients.push({ client, version: verOf(r.stdout) }); break; }
    }
  }
  return { node: process.versions.node, git: gitVer, clients };
}

/**
 * The check-in body for one hub section (docs/connector.md "The connector's report"). The context field (numbers only, under the
 * usage opt-in; left out while it is off) needs the section and the worker's reader cache (contextsize.mjs).
 */
export function report(home, hubKey, pc, section = null, contextCache = null) {
  const s = readSettings(home);
  // The isolation level (docs/connector.md): standard here; the hardened service reports its own.
  const context = contextCache ? contextReport(home, hubKey, section, contextCache, { labelToId: (l) => agentIdOf(home, hubKey, l) }) : undefined;
  return { version: CONNECTOR_VERSION, platform: platformId(), node: pc.node, git: pc.git, clients: pc.clients, ...s, isolation: isHardened(home) ? 'hardened' : 'standard', key_store: isHardened(home) ? 'service' : storeName(home), agents: runningAgents(home, hubKey), destinations: reportDestinations(home), ...(() => { const k = legacyLeftoverKindsCached(home); return { legacy_leftovers: k.length > 0, legacy_leftover_kinds: k }; })(), ...(context ? { context } : {}) };
}

/** The rows a `check` order reports: one per agent folder of that hub, then the connector's own. At most 40. */
export async function checkRows(home, section, claudeJson) {
  const rows = [];
  for (const b of foldersOfHub(home, section.hub_id, section.ca_sha256).slice(0, 36)) {
    const r = await runCheck(home, b.path, { claudeJson });
    rows.push({ name: `Agent ${b.agent}`, ok: r.ok, detail: r.line.slice(0, 200) });
  }
  rows.push({ name: 'Connector', ok: true, detail: `Version ${CONNECTOR_VERSION} on ${platformId()}.` });
  rows.push({ name: 'Updates', ok: true, detail: autoUpdateOn(home) ? 'Updates to approved versions are on.' : 'Updates are turned off on this PC by its user.' });
  const rb = readBuilds(home).rolled_back;
  if (rb) rows.push({ name: 'Rollback', ok: false, detail: `Version ${rb} did not start, so this PC went back to the previous verified build.` });
  return rows;
}

/**
 * A refused renewal (pause, lockdown, suspended key) ends a run the wake started: the broker tells the wake which folder and hub,
 * and the wake stops the whole process tree of the run there. A chat opened by hand is not the wake's to stop (stopFolder says false).
 */
export function wireRefusal(broker, wake) {
  if (broker) broker.onRefused = (run) => wake.stopFolder(run.folder, run.hubKey);
}

/**
 * One worker: resolves `'restart'` after an update, `'no_hubs'` once no hub is left for EMPTY_TICKS check-ins in a row
 * (after an uninstall or the last hub's disconnect), or `'stopped'` when `signal` aborts. `deps` replaces the clock, the
 * interval, the update, the disconnect, the usage interval (`usageMs`) and the exec for tests.
 */
export async function runWorker({ home, signal, log = logTo(home), claudeJson, deps = {} }) {
  // One worker per installation: run/worker.json names it (process id and start time). A second one stops at once, so
  // two workers never check in, run orders or write state side by side.
  // Only while the connector is installed here (its manifest is there): a folder an uninstall emptied gets no file back.
  const lock = deps.noLock || !existsSync(manifestPath(home)) ? { ok: true, release: () => {} } : takeProcessLock(workerLockPath(home), 'worker');
  if (!lock.ok) { log(`another worker is running (${holderText(lock.holder)}); this one stops`); return 'locked'; }
  process.once('exit', lock.release);
  const exec = deps.exec ?? execDefault;
  const update = deps.updateTo ?? updateTo;
  const disconnect = deps.disconnect ?? runDisconnect;
  const usageEvery = deps.usageMs ?? USAGE_MS;
  let usageAt = 0, backfilled = false;
  // Measure-only hubs and the samples waiting for each; sampling runs only while one exists and the user opted in.
  const measured = new Map();
  let sample = null;
  const sampling = setInterval(() => {
    if (!measured.size) return;
    if (!hardwareOptIn(home)) { sample = null; for (const q of measured.values()) q.length = 0; return; }
    if (!sample) { sample = (deps.sampler ?? sampler)(); return; } // the first reading only starts the CPU clock
    try { const s = sample(); for (const q of measured.values()) queueSample(q, s); } catch (e) { log(`the machine could not be measured (${e.message})`); }
  }, deps.sampleMs ?? SAMPLE_MS);
  signal?.addEventListener('abort', () => clearInterval(sampling), { once: true });

  /** Sends a measure-only hub its waiting samples; they are kept for the next check-in only when the hub could not be reached. */
  async function sendSamples(section, hub, auth, q) {
    if (!q.length) return;
    const batch = q.splice(0, q.length);
    const r = await request(hub, 'POST', '/connector/v1/hardware', { body: { samples: batch }, headers: auth }).catch((e) => ({ status: 0, reason: e.reason }));
    if (r.status === 0 || r.status >= 500) { const keep = [...batch, ...q].slice(-SAMPLE_MAX); q.length = 0; q.push(...keep); log(`hub ${section.hub_id}: samples not sent (${r.reason ?? r.status}); kept for the next check-in`); }
    else if (r.status !== 200) log(`hub ${section.hub_id}: samples refused (${r.json?.error ?? r.status})`);
  }

  /** Reads usage once for every hub and sends each hub only its own days, over its pinned connection with its app key. */
  async function reportUsage(hubs) {
    if (!usageOptIn(home)) { backfilled = false; return; }
    const days = backfilled ? USAGE_DAYS : USAGE_FIRST_DAYS;
    let failed = false;
    const u = await collectUsage(home, { days });
    for (const h of u.hubs) {
      const section = Object.values(hubs).find((x) => x && x.hub_id === h.hub_id && x.ca_sha256 === h.ca_sha256);
      if (!section) continue;
      const c = connect(section);
      if (!c.ok) continue;
      const auth = { Authorization: `Bearer ${section.app_key}` };
      const post = async (path, body) => {
        const r = await request(c.hub, 'POST', path, { body, headers: auth });
        if (r.status !== 200) throw new Error(`the hub answered ${r.status}`);
      };
      try { const sent = await sendUsage(home, h, post); if (sent.length) log(`hub ${h.hub_id}: usage sent for ${sent.length} day(s)`); }
      catch (e) { log(`hub ${h.hub_id}: usage not sent (${e.reason ?? e.message})`); failed = true; } // the next hubs still get theirs
    }
    if (!failed) backfilled = true; // a hub that missed its 30 days gets them on the next pass
  }
  const interval = deps.intervalMs ?? CHECK_IN_MS;
  const bridges = new Map();
  // Vault sync (docs/vault-sync.md): the mirrors of this PC, one loop each, nudged by the stream's `vault_changed`.
  const syncHost = createSyncHost({ home, log: (m) => log(m), ...(deps.syncHost ?? {}) });
  // The context reader's state per session the connector started, kept in memory: each check-in reads only what was added.
  const contextCache = new Map();
  let pc = versionsOnPc(home, exec), pcAt = Date.now(), lastUpdateCheck = 0, confirmed = false, encrypted = false, restart = false;
  const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); signal?.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); });

  // A result is kept in the outbox before it is sent and resent at every check-in until the hub has it (outbox.mjs).
  const result = (hubKey, hub, auth, id, state, res) => sendResult({ home, hubKey, hub, auth, request, log }, id, state, res);
  const inflight = new Set();

  async function tryUpdate(hub, auth, version) {
    const a = await request(hub, 'GET', '/connector/v1/versions/approved', { headers: auth });
    const approved = a.status === 200 && Array.isArray(a.json?.versions) ? a.json.versions : [];
    const want = version ?? pickUpdate(approved, CONNECTOR_VERSION, failedVersions(home));
    if (!want) return null;
    const u = await update(home, { version: want, approved });
    log(u.ok ? `updated to ${want}; restarting on it` : `update to ${want} refused: ${u.reason}`);
    if (u.ok) restart = true;
    return u;
  }

  async function orders(hubKey, section, hub, auth, given) {
    let list = given;
    if (!list) {
      const r = await request(hub, 'GET', '/connector/v1/orders', { headers: auth });
      if (r.status !== 200 || !Array.isArray(r.json?.orders)) return;
      list = r.json.orders;
    }
    for (const raw of list) {
      if (typeof raw?.id !== 'string' || !/^pca_[A-Za-z0-9_-]{1,80}$/.test(raw.id)) { log('an order without a valid id was ignored'); continue; }
      // The hub hands an order out again until its result arrives. One already handled is skipped (its result is in the outbox, or a restore / the wake holds it);
      // one that was cut short by a crash is not marked, so it runs now.
      const key = `${hubKey}:${raw.id}`;
      if (wasHandled(home, hubKey, raw.id) || inflight.has(key)) continue;
      inflight.add(key);
      try { await handleOrder(hubKey, section, hub, auth, raw); markHandled(home, hubKey, raw.id); }
      catch (e) { log(`order ${raw.id} failed to run (${e.reason ?? e.message}); it is handed out again`); }
      finally { inflight.delete(key); }
    }
  }

  async function handleOrder(hubKey, section, hub, auth, raw) {
    {
      const v = validateOrder(raw);
      if (!v.ok) { log(`order ${raw.id} refused: ${v.reason}`); await result(hubKey, hub, auth, raw.id, 'failed', { reason: ORDER_REASONS[v.reason] }); return; }
      const { kind, payload } = v.order;
      if (kind !== 'update' && measured.has(hubKey)) await result(hubKey, hub, auth, raw.id, 'failed', { reason: ORDER_REASONS.measure_only });
      else if (kind === 'check') await result(hubKey, hub, auth, raw.id, 'done', { checks: await checkRows(home, section, claudeJson) });
      else if (kind === 'update') {
        if (!autoUpdateOn(home)) { await result(hubKey, hub, auth, raw.id, 'failed', { reason: ORDER_REASONS.auto_update_off }); return; }
        const u = await tryUpdate(hub, auth, payload.version).catch((e) => ({ ok: false, reason: e.reason ?? 'download_failed' }));
        await result(hubKey, hub, auth, raw.id, u?.ok ? 'done' : 'failed', u?.ok ? null : { reason: updateLine(u?.reason) });
      } else if (kind === 'deliver' && payload.reason === 'reset') {
        // Reset (reset.mjs): a hand-opened chat is answered now with the person's steps; a session the wake holds waits for its turn to end.
        const r = onResetOrder(home, hubKey, v.order);
        if (r.state === 'failed') await result(hubKey, hub, auth, raw.id, 'failed', { reason: r.reason, code: r.code });
      } else if (kind === 'deliver' && payload.reason === 'stop') {
        // The operator's Stop (audited by the hub): the run ends, its session is kept.
        const stopped = await wake.stop({ hubKey, section, hub, auth }, payload.agent_id).catch(() => false);
        await result(hubKey, hub, auth, raw.id, stopped ? 'done' : 'failed', stopped ? null : { reason: ORDER_REASONS.no_run });
      } else if (kind === 'deliver') {
        // The wake (wake.mjs): a turn starts, the running turn takes the item as a notice, or the order says why not.
        const r = await wake.onDeliver({ hubKey, section, hub, auth }, v.order, ORDER_REASONS);
        if (r.state === 'done') await result(hubKey, hub, auth, raw.id, 'done', null);
        else if (r.state === 'failed') await result(hubKey, hub, auth, raw.id, 'failed', { reason: r.reason, code: r.code });
      } else if (kind === 'restore') beginRestore(home, hubKey, v.order); // carried out by resumeRestores, at once and on every later check-in
      else await result(hubKey, hub, auth, raw.id, 'failed', { reason: ORDER_REASONS.disconnect_elsewhere });
    }
  }

  /**
   * Carries every unfinished restore of this hub as far as it goes. A restore order stays open while its checkout is live, so
   * one the connector restarted in the middle of, or one that waits for the PC's user, is taken up again here at each check-in.
   */
  async function resumeRestores(hubKey, section, hub, auth) {
    for (const s of activeRestores(home, hubKey)) {
      if (signal?.aborted || restart) return;
      const r = await (deps.runRestore ?? runRestore)({ home, hubKey, section, hub, auth, claudeJson, node: deps.node, connector: deps.connector, gitBin: deps.gitBin }, s);
      if (r.phase === 'waiting') {
        if (r.retry) log(`restore ${s.checkout_id}: will try again (${r.retry})`);
        if (r.note && r.note !== s.last_note) {
          const p = await request(hub, 'POST', `/connector/v1/orders/${s.order_id}/progress`, { body: { note: r.note }, headers: auth }).catch((e) => ({ status: 0, reason: e.reason }));
          if (p.status === 200) { s.last_note = r.note; saveRestore(home, s); }
          else if (p.status === 404 || p.status === 409) { finishRestore(home, s, 'ended'); log(`restore ${s.checkout_id}: the hub closed the order; stopped`); }
        }
      } else if (r.phase === 'done') { log(`restore ${s.checkout_id}: confirmed`); await result(hubKey, hub, auth, s.order_id, 'done', { start_lines: r.start_lines }); }
      else if (r.phase === 'failed') { finishRestore(home, s, 'failed'); log(`restore ${s.checkout_id}: failed (${r.reason})`); await result(hubKey, hub, auth, s.order_id, 'failed', { reason: String(r.reason).slice(0, 200) }); }
      else { finishRestore(home, s, 'ended'); log(`restore ${s.checkout_id}: the checkout ended; stopped`); }
    }
  }

  /**
   * The team request this PC filed (docs/onboarding.md, "The installer, in one step"): one step of setup each check-in, so an approved request is
   * picked up, built and confirmed with no one at the screen and no command to run. Nothing happens while there is no request, or one that is finished or closed.
   * A phase is logged once when it changes.
   */
  const setupPhase = new Map();
  // A step that failed (an error, or agents whose folders did not build) is tried again after a wait that doubles from one minute to half an hour, so a request that cannot finish does not retry at every check-in. Any other answer starts the wait over.
  const setupRetry = new Map();
  const SETUP_BACKOFF_BASE = deps.setupBackoffMs ?? 60_000, SETUP_BACKOFF_MAX = deps.setupBackoffMaxMs ?? 1_800_000;
  const setupFailed = (hubKey) => { const o = setupRetry.get(hubKey) ?? { n: 0 }; o.n += 1; o.at = Date.now() + Math.min(SETUP_BACKOFF_MAX, SETUP_BACKOFF_BASE * 2 ** (o.n - 1)); setupRetry.set(hubKey, o); };
  async function setupStep(hubKey, section) {
    if ((setupRetry.get(hubKey)?.at ?? 0) > Date.now()) return;
    let st;
    try { st = loadSetup(home, section.hub_id); } catch { return; }
    if (!st?.request || st.confirmed || ['denied', 'withdrawn', 'cancelled', 'collected'].includes(st.request.state)) return;
    try {
      const r = await (deps.advanceSetup ?? advanceSetup)(home, hubKey, { waitS: 0, claudeJson, node: deps.node, connector: deps.connector, gitBin: deps.gitBin });
      if (r.phase === 'set_up' && r.failed?.length) setupFailed(hubKey); else setupRetry.delete(hubKey);
      const line = r.phase === 'set_up' ? `set up (${r.built.length} built${r.failed.length ? `, ${r.failed.length} failed` : ''})` : r.phase === 'waiting' ? `waiting (${r.stage ?? 'admin'})` : r.phase;
      if (setupPhase.get(hubKey) !== line) { setupPhase.set(hubKey, line); log(`hub ${section.hub_id}: team request ${line}`); }
    } catch (e) { setupFailed(hubKey); const line = `not carried out (${e.reason ?? e.message})`; if (setupPhase.get(hubKey) !== line) { setupPhase.set(hubKey, line); log(`hub ${section.hub_id}: team request ${line}`); } }
  }

  /**
   * Key handovers waiting for this PC (docs/onboarding.md#key-handover-a-rotated-key-or-a-recruit-reaches-a-connector-pc): a rotated key
   * or a recruit's agents, picked up only after the PC's user allowed it on the local screen. One run per hub at a time; a hint while
   * one runs runs it again after.
   */
  const handing = new Map();
  async function handovers(hubKey, section) {
    if (handing.get(hubKey)) { handing.set(hubKey, 'again'); return; }
    handing.set(hubKey, 'busy');
    try {
      do {
        handing.set(hubKey, 'busy');
        const r = await (deps.runHandovers ?? runHandovers)(home, hubKey, { claudeJson, node: deps.node, connector: deps.connector, gitBin: deps.gitBin });
        for (const h of r.handovers) {
          if (h.phase === 'confirmed' && h.agents) log(`hub ${section.hub_id}: key handover ${h.id} confirmed${h.failed?.length ? `; ${h.failed.length} folder(s) not built` : ''}`);
          else if (h.phase === 'failed') log(`hub ${section.hub_id}: key handover ${h.id} failed (${h.reason})`);
        }
      } while (handing.get(hubKey) === 'again');
    } catch (e) { log(`hub ${section.hub_id}: key handovers not carried out (${e.reason ?? e.message})`); } finally { handing.delete(hubKey); }
  }

  /**
   * The push stream for one hub (docs/connector.md, "The push stream"). It only says "orders waiting": after every open and every
   * event the orders are fetched as always, so a dropped stream loses nothing. When it cannot open (a proxy that blocks it, an
   * older hub) the same orders come by a long poll. Reconnects back off from 2 s to 60 s and honour the hub's Retry-After.
   */
  const streams = new Map();
  async function runStream(hubKey, section, hub, auth, ac) {
    const sig = ac.signal, install = (deps.installationId ?? installationId)(home);
    let fails = 0, pending = false, again = false;
    const fetchOrders = async () => {
      if (pending) { again = true; return; }
      pending = true;
      try { do { again = false; await orders(hubKey, section, hub, auth).catch((e) => log(`hub ${section.hub_id}: orders failed (${e.reason ?? e.message})`)); } while (again && !sig.aborted); } finally { pending = false; }
    };
    while (!sig.aborted && !restart) {
      const t0 = Date.now();
      const r = await openStream(hub, { headers: auth, signal: sig, query: `?installation=${install}`, onOrders: fetchOrders, onEvent: (n, d) => { if (n === 'vault_changed' && typeof d?.reader === 'string') syncHost.hint(d.reader); else if (n === 'handovers') handovers(hubKey, section); }, ...(deps.streamTimings ?? {}) });
      if (sig.aborted || restart) break;
      if (r.status === 401 || r.status === 403) { log(`hub ${section.hub_id}: the push stream was refused (${r.status}); stopped`); break; }
      fails = Date.now() - t0 > 30_000 ? 0 : fails + 1;
      if (r.status === 0 && r.reason === 'tls_refused') { log(`hub ${section.hub_id}: the push stream was refused (tls_refused)`); fails = Math.max(fails, 3); }
      // The stream could not open or keeps failing: take the orders by long poll for a while, then try the stream again.
      if (r.reason === 'no_open' || r.status === 404 || r.status === 501 || fails >= 3) {
        log(`hub ${section.hub_id}: no push stream (${r.reason}); long polling`);
        const until = Date.now() + (deps.longPollWindowMs ?? 5 * 60_000);
        while (!sig.aborted && !restart && Date.now() < until) {
          const p = await request(hub, 'GET', `/connector/v1/orders?wait=${deps.longPollWait ?? 25}`, { headers: auth, timeoutMs: ((deps.longPollWait ?? 25) + 10) * 1000 }).catch((e) => ({ status: 0, reason: e.reason }));
          if (p.status === 200 && Array.isArray(p.json?.orders)) { if (p.json.orders.length) await orders(hubKey, section, hub, auth, p.json.orders).catch((e) => log(`hub ${section.hub_id}: orders failed (${e.reason ?? e.message})`)); }
          else if (p.status === 401 || p.status === 403) return;
          else await sleepOn(sig, 5000);
        }
        fails = 0;
        continue;
      }
      await sleepOn(sig, Math.max((r.retryAfter ?? 0) * 1000, Math.min(60_000, (deps.streamBackoffMs ?? 2000) * 2 ** Math.min(fails, 5))));
    }
  }
  const sleepOn = (sig, ms) => new Promise((r) => { const t = setTimeout(r, ms); sig.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); });
  function ensureStream(hubKey, section, hub, auth) {
    if (streams.has(hubKey) || deps.noStream || measured.has(hubKey)) return;
    const ac = new AbortController();
    signal?.addEventListener('abort', () => ac.abort(), { once: true });
    streams.set(hubKey, ac);
    runStream(hubKey, section, hub, auth, ac).catch((e) => log(`hub ${section.hub_id}: the push stream stopped (${e.message})`)).finally(() => { if (streams.get(hubKey) === ac) streams.delete(hubKey); });
  }

  /** One audit entry per grandfathered folder of this hub; kept and tried again at the next check-in when the hub does not take them. */
  /** One audit entry per folder allowed with a pickup (docs/connector.md, "Clicks"); kept and tried again until the hub takes it. */
  async function auditPickupAllowed(hubKey, section, hub, auth) {
    const todo = unauditedPickupAllowed(home, section.hub_id).slice(0, 100);
    if (!todo.length) return;
    try {
      const r = await request(hub, 'POST', '/connector/v1/folders-allowed-with-pickup', { body: { allowed: todo.map((t) => ({ agent_id: t.agent_id, ref: t.ref })) }, headers: auth });
      if (r.status === 200) markPickupAudited(home, todo.map((t) => t.key)); else log(`hub ${section.hub_id}: folders allowed with a pickup not audited yet (${r.status})`);
    } catch (e) { log(`hub ${section.hub_id}: folders allowed with a pickup not audited yet (${e.reason ?? e.message})`); }
  }

  async function auditGrandfathered(hubKey, section, hub, auth) {
    const todo = unauditedGrandfathered(home, section.hub_id);
    if (!todo.length) return;
    try {
      const r = await request(hub, 'POST', '/connector/v1/folders-grandfathered', { body: { agents: todo.slice(0, 200).map((t) => t.agent) }, headers: auth });
      if (r.status === 200) markAudited(home, todo.slice(0, 200).map((t) => t.key)); else log(`hub ${section.hub_id}: grandfathered folders not audited yet (${r.status})`);
    } catch (e) { log(`hub ${section.hub_id}: grandfathered folders not audited yet (${e.reason ?? e.message})`); }
  }

  /**
   * The real folder of each agent bound for this hub goes to the hub, which keeps each as a proposed folder for the operator to approve
   * (the transfers into this PC check approved folders only). Sent again only when the list changed; kept and tried again at the next
   * check-in when the hub does not take it. Never anything but the folder's canonical path and the agent's label.
   */
  const sentFolders = new Map();
  async function registerFolders(hubKey, section, hub, auth) {
    const list = foldersOfHub(home, section.hub_id, section.ca_sha256).filter((b) => b.agent && b.path).map((b) => ({ agent: b.agent, ...(b.agent_id ? { agent_id: b.agent_id } : {}), path: b.path })).sort((a, b) => (a.path < b.path ? -1 : 1)).slice(0, 200);
    const sig = JSON.stringify(list);
    if (!list.length || sentFolders.get(hubKey) === sig) return;
    try {
      const r = await request(hub, 'POST', '/connector/v1/folders', { body: { folders: list }, headers: auth });
      if (r.status === 200) { sentFolders.set(hubKey, sig); if (r.json?.proposed) log(`hub ${section.hub_id}: ${r.json.proposed} folder(s) proposed; the operator approves them in the console`); if (r.json?.refused?.length) log(`hub ${section.hub_id}: the hub refused ${r.json.refused.length} folder(s) (${[...new Set(r.json.refused.map((x) => x.reason))].join(', ')})`); }
      else log(`hub ${section.hub_id}: folders not registered yet (${r.status})`);
    } catch (e) { log(`hub ${section.hub_id}: folders not registered yet (${e.reason ?? e.message})`); }
  }

  /**
   * What the PC user denied on the connector screen, told to the hub once each: a folder's chat (the agent's label) or a key pickup
   * (the request id). Kept and tried again at the next check-in when the hub does not take it. The hub keeps one audit entry per
   * denial and alerts on repeats for one agent.
   */
  async function reportDenied(hubKey, section, hub, auth) {
    const todo = unreportedDenials(home).filter((d) => (d.kind === 'pickup' ? d.hub_key === hubKey : d.hub_id === section.hub_id)).slice(0, 50);
    if (!todo.length) return;
    try {
      const r = await request(hub, 'POST', '/connector/v1/folders-denied', { body: { denied: todo.map((d) => (d.kind === 'pickup' ? { what: 'pickup', request: String(d.request).slice(0, 100) } : { what: 'folder', agent: String(d.agent).slice(0, 100) })) }, headers: auth });
      if (r.status === 200) { markDenialsReported(home, todo.map((d) => d.id)); pruneDenied(home); } else log(`hub ${section.hub_id}: a denial is not reported yet (${r.status})`);
    } catch (e) { log(`hub ${section.hub_id}: a denial is not reported yet (${e.reason ?? e.message})`); }

  }

  async function tick(hubKey, section) {
    const c = connect(section);
    if (!c.ok) { log(`hub ${section.hub_id}: not contacted (${c.reason})`); return; }
    const hub = c.hub, auth = { Authorization: `Bearer ${section.app_key}` };
    let r;
    try { r = await request(hub, 'POST', '/connector/v1/check-in', { body: report(home, hubKey, pc, section, contextCache), headers: auth }); } catch (e) { log(`hub ${section.hub_id}: check-in failed (${e.reason})`); return; }
    if (r.status === 401) {
      bridges.get(hubKey)?.abort(); bridges.delete(hubKey);
      streams.get(hubKey)?.abort(); streams.delete(hubKey);
      if (r.json?.error !== 'disconnected') { log(`hub ${section.hub_id}: the app key was refused (PC suspended or key revoked)`); return; }
      log(`hub ${section.hub_id}: this hub disconnected this PC; finishing the disconnect`);
      const d = await disconnect(home, { hubId: section.hub_id, caSha256: section.ca_sha256 }, { claudeJson }).catch((e) => ({ state: 'resume_later', error: e.message }));
      log(`hub ${section.hub_id}: disconnect ${d.state === 'resume_later' ? 'not finished; tried again at the next check-in' : d.state}`);
      // With remote cleanup off nothing is removed, so the hub's section stays: it is marked, and the worker stops checking in with it.
      if (d.state === 'cleanup_off' && d.reported) { try { markDisconnected(home, hubKey); } catch (e) { log(`hub ${section.hub_id}: could not be marked as disconnected (${e.message})`); } }
      return;
    }
    if (r.status !== 200) { log(`hub ${section.hub_id}: check-in answered ${r.status}`); return; }
    await flushOutbox({ home, hubKey, hub, auth, request, log }).catch((e) => log(`hub ${section.hub_id}: results not sent (${e.reason ?? e.message})`));
    await auditGrandfathered(hubKey, section, hub, auth);
    await auditPickupAllowed(hubKey, section, hub, auth);
    await reportDenied(hubKey, section, hub, auth);
    await registerFolders(hubKey, section, hub, auth);
    if (!confirmed) { confirmed = true; if (confirm(home)) log(`version ${CONNECTOR_VERSION} confirmed after its first check-in`); }
    // A key file from an older connector is plain text. It is encrypted only now, after this version's first check-in is confirmed: a rollback to the
    // build before it must still be able to read the file.
    if (!encrypted) { encrypted = true; try { if (encryptInPlace(home)) log('the key file is now encrypted at rest'); } catch (e) { log(`the key file could not be encrypted (${e.reason ?? e.message})`); } }
    if (!bridges.has(hubKey) && !deps.noBridge) {
      const ac = new AbortController();
      signal?.addEventListener('abort', () => ac.abort(), { once: true });
      bridges.set(hubKey, ac);
      // A send reads only from the sending agent's own folder on this hub, never the connector's own folder (docs/transfers.md).
      const agentFolders = (who) => ownFoldersOf(foldersOfHub(home, section.hub_id, section.ca_sha256), who, (b) => agentIdOf(home, hubKey, b.agent));
      // A save lands in no other agent's folder: every folder bound on this hub to an agent other than the receiver.
      // The receiver is told apart by its agent id where this PC knows it (the binding's, else the id its relay recorded), by label only where it does not.
      const foreignFolders = (who) => foreignFoldersOf(foldersOfHub(home, section.hub_id, section.ca_sha256), who, (b) => agentIdOf(home, hubKey, b.agent));
      runBridge({ hub: hub.origin, key: section.app_key, signal: ac.signal, fetch: pinnedFetch(hub), log: (...a) => log(`transfers ${section.hub_id}: ${a.join(' ')}`), agentFolders, foreignFolders, refusedDirs: [home] })
        .catch((e) => log(`transfers ${section.hub_id} stopped: ${e.message}`)).finally(() => { if (bridges.get(hubKey) === ac) bridges.delete(hubKey); });
    }
    if (r.json?.measure_only === true) { if (!measured.has(hubKey)) measured.set(hubKey, []); } else measured.delete(hubKey);
    if (measured.has(hubKey)) { streams.get(hubKey)?.abort(); streams.delete(hubKey); } else { ensureStream(hubKey, section, hub, auth); if (!deps.noSync) { try { syncHost.ensure(section, hub, signal); } catch (e) { log(`sync: could not start (${e.message})`); } } } // a measure-only PC opens no stream and mirrors nothing
    if (!measured.has(hubKey)) {
      const wctx = { hubKey, section, hub, auth };
      if (!adopted.has(hubKey)) { adopted.add(hubKey); await wake.adopt(wctx).catch((e) => log(`wake: ${e.message}`)); }
      await wake.tick(wctx).catch((e) => log(`wake: ${e.message}`));
    }
    if (measured.has(hubKey) && hardwareOptIn(home)) await sendSamples(section, hub, auth, measured.get(hubKey));
    if (r.json?.handovers > 0) await handovers(hubKey, section);
    await setupStep(hubKey, section);
    if (r.json?.orders > 0) await orders(hubKey, section, hub, auth).catch((e) => log(`hub ${section.hub_id}: orders failed (${e.reason ?? e.message})`));
    if (!measured.has(hubKey)) await resumeRestores(hubKey, section, hub, auth).catch((e) => log(`hub ${section.hub_id}: restore failed (${e.reason ?? e.message})`));
    if (!restart && autoUpdateOn(home) && Date.now() - lastUpdateCheck > UPDATE_CHECK_MS) {
      lastUpdateCheck = Date.now();
      await tryUpdate(hub, auth, null).catch((e) => log(`update check failed (${e.reason ?? e.message})`));
    }
  }

  log(`worker ${CONNECTOR_VERSION} started`);
  // A new build that stays up a minute takes back the start the launcher counted (builds.mjs `markUp`), so starts while the
  // PC is offline never add up to a rollback; only starts that crash early do.
  const upTimer = setTimeout(() => { try { if (markUp(home, CONNECTOR_VERSION)) log(`version ${CONNECTOR_VERSION} has run a minute; this start is not a failed one`); } catch (e) { log(`the start could not be recorded as good (${e.message})`); } }, deps.upMs ?? UP_MS);
  upTimer.unref?.();
  // The upgrade to turn tokens, once: a folder registered before it and unchanged since needs no click (approvals.mjs, grandfather).
  try { grandfather(home, (m) => log(m)); } catch (e) { log(`folders could not be grandfathered (${e.message})`); }
  // The broker is how every session gets its turn token (broker.mjs); no other process loads a key.
  let broker = null;
  if (!deps.noBroker) { try { broker = await startBroker({ home, log: (w) => log(w), deps: deps.broker ?? {} }); } catch (e) { log(`the local broker could not start (${e.message}); sessions get no turn token until it does`); } }
  const wake = createWake({ home, log: (m) => log(m), broker, deps: deps.wake ?? {} });
  // A refused renewal (pause, lockdown, suspended key) ends a run the wake started, not only its token (broker.mjs, renewAll).
  wireRefusal(broker, wake);
  const adopted = new Set(), quiet = new Set();
  let empty = 0, noHubs = false;
  while (!signal?.aborted && !restart) {
    if (Date.now() - pcAt > 3600_000) { pc = versionsOnPc(home, exec); pcAt = Date.now(); }
    const kf = readKeyFile(home);
    if (!keyFilePresent(home) || (kf.ok && !Object.keys(kf.data.hubs).length)) {
      if (++empty >= (deps.emptyTicks ?? EMPTY_TICKS)) { noHubs = true; break; }
    } else empty = 0;
    if (!kf.ok) log(`the key file cannot be used (${kf.reason})`);
    else {
      for (const [k, s] of Object.entries(kf.data.hubs)) {
        if (signal?.aborted || restart) break;
        // A hub that disconnected this PC while its user kept remote cleanup off: no check-in until the PC is paired again.
        if (s.disconnected_at) { if (!quiet.has(k)) { quiet.add(k); log(`hub ${s.hub_id}: disconnected this PC (remote cleanup is off); no more check-ins until it is paired again`); } continue; }
        await tick(k, s);
      }
      if (!signal?.aborted && !restart && Date.now() - usageAt >= usageEvery) {
        usageAt = Date.now();
        await reportUsage(Object.fromEntries(Object.entries(kf.data.hubs).filter(([, s]) => !s.disconnected_at))).catch((e) => log(`usage could not be read (${e.message})`));
      }
    }
    if (!restart) await sleep(interval);
  }
  for (const ac of bridges.values()) ac.abort();
  for (const ac of streams.values()) ac.abort();
  syncHost.stop();
  clearInterval(sampling);
  clearTimeout(upTimer);
  await broker?.close().catch(() => {});
  process.off('exit', lock.release); lock.release();
  if (noHubs) log('no hub is left on this PC; the worker stops');
  return restart ? 'restart' : noHubs ? 'no_hubs' : 'stopped';
}

/**
 * The logon entry's process. It records its pid (so `service remove` can stop it), runs `launcher service worker` as a
 * child, and starts it again after it exits: at once after an update, otherwise after a pause that grows to a minute
 * while the worker keeps failing quickly.
 */
export async function runSupervisor({ home, log = logTo(home), node = process.execPath, signal, deps = {} }) {
  // One supervisor per installation (run/service.json, its process id and start time); a second one stops at once.
  const lock = takeProcessLock(servicePidPath(home), 'service');
  if (!lock.ok) { log(`the service is already running (${holderText(lock.holder)}); this one stops`); return { locked: lock.holder }; }
  process.once('exit', lock.release);
  let child = null, stopping = false, fails = 0;
  const stop = () => { stopping = true; child?.kill(); };
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(s, stop);
  signal?.addEventListener('abort', stop, { once: true });
  log('service started');
  while (!stopping) {
    const t0 = Date.now();
    // Whatever goes wrong in one round (a spawn that throws, a state file that is locked) counts as a failed start and is
    // retried after the same growing pause, never ends the service.
    const code = await new Promise((res) => {
      const script = launcherPath(home);
      child = spawn(node, [script, 'service', 'worker'], { cwd: home, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, CONCLAVE_HOME: home, HOME: process.env.HOME ?? homedir() } });
      const out = (d) => { for (const l of String(d).split(/\r?\n/)) if (l.trim()) log(l); };
      // Recorded, so an uninstall or a disconnect (stopStarted) ends the worker too, not only this supervisor.
      const pid = child.pid;
      if (pid) { try { recordStarted(home, { pid, image: node, script, what: 'service worker' }); } catch (e) { log(`the worker could not be recorded (${e.message})`); } }
      child.stdout.on('data', out); child.stderr.on('data', out);
      child.on('exit', (c) => { if (pid) { try { forgetStarted(home, pid); } catch { /* dropped at the next start */ } } res(c ?? 1); });
      child.on('error', () => res(1));
    }).catch((e) => { log(`the worker could not be started (${e.message})`); return 1; });
    child = null;
    if (stopping) break;
    if (code === RESTART) { fails = 0; continue; }
    // No hub left and the connector removed (its launcher is gone): nothing to supervise any more.
    if (code === NO_HUBS && !existsSync(launcherPath(home))) break;
    fails = Date.now() - t0 < 30_000 ? fails + 1 : 0;
    const wait = Math.min(60_000, (deps.backoffMs ?? 2000) * 2 ** Math.min(fails, 5));
    log(`worker exited (${code}); starting again in ${wait / 1000} s`);
    await new Promise((r) => setTimeout(r, wait));
  }
  log('service stopped');
  process.off('exit', lock.release); lock.release();
  return { locked: null };
}

/** "process 1234, started 2026-11-21T09:00:00Z": who holds a lock, for the log and the command line. */
export const holderText = (h) => `process ${h?.pid ?? 'unknown'}${h?.started_at ? `, started ${h.started_at}` : ''}`;
