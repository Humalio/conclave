import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { PublicLimiter, publicBucket, limitAddress } from './util/publicLimit.js';
import { ZodError } from 'zod';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Config } from './config.js';
import { openDb } from './db/db.js';
import { RateLimit } from './db/rateLimit.js';
import { Audit } from './audit/audit.js';
import { Keys, KeyError } from './keys/keys.js';
import { Handovers } from './keys/handover.js';
import { LeakGuard } from './guard/leakGuard.js';
import { Vault, VaultError } from './vault/vault.js';
import { VaultStore, MAX_CONTENT } from './vault/store.js';
import { builtinTemplates } from './policy/catalogue.js';
import { buildMcpServer, removedToolAnswer, compactHeader, clientHint, toolsDigest } from './mcp/tools.js';
import { Setup } from './setup/setup.js';
import { Links } from './links/links.js';
import { OwnerScope } from './policy/ownerScope.js';
import { Delegations } from './checkout/delegate.js';
import { Messaging } from './messaging/messaging.js';
import { Teams } from './teams/teams.js';
import type { DeliveryReason } from './teams/turns.js';
import { Blueprint } from './blueprint/blueprint.js';
import { BlueprintViews } from './blueprint/views.js';
import { registerBridge } from './bridge/http.js';
import { Connector } from './connector/connector.js';
import { registerConnector } from './connector/http.js';
import { VaultSync } from './vaultsync/vaultSync.js';
import { Relays, RELAY_SECRET_HEADER, RELAY_CLIENT_HEADER, clientAddress } from './relay/relays.js';
import { registerVaultSync } from './vaultsync/http.js';
import { Shares } from './shares/shares.js';
import { TaskAttachments, ATTACH_LIMITS } from './shares/taskAttachments.js';
import { Channels } from './channels/channels.js';
import { Access } from './access/access.js';
import { Lockdown } from './safety/lockdown.js';
import { Alerts, DEFAULT_ALERT_OPTS } from './safety/alerts.js';
import { Maintenance, DEFAULT_RETENTION } from './safety/retention.js';
import { DbHealth } from './safety/dbHealth.js';
import { Graph } from './graph/graph.js';
import { Feedback } from './feedback/feedback.js';
import { Hardware } from './hardware/hardware.js';
import { Decisions } from './teams/decisions.js';
import { Directives } from './directives/directives.js';
import { bootstrapAdmin, registerAdminApi } from './admin/api.js';
import { Users } from './admin/users.js';
import { Routing } from './admin/routing.js';
import { loadBlueprintLimits } from './admin/blueprintApi.js';
import { Onboarding, OnboardError, CODE_PREFIX } from './onboarding/onboarding.js';
import { hmacHex } from './util/crypto.js';
import { Checkouts } from './checkout/checkout.js';
import { CheckoutKeys } from './checkout/render.js';
import { Mirror } from './mirror/mirror.js';
import { MIRROR_FOLDER } from './mirror/folder.js';
import { setReserved } from './policy/engine.js';
import { ClientFiles, findClientDir, registerOnboarding } from './onboarding/http.js';

/** The body limit of the /mcp route: the vault's 2 MiB text limit plus 64 KiB for the JSON around it (the figure docs/relay.md gives for the largest body a hub route takes). */
const MCP_BODY_LIMIT = MAX_CONTENT + 64 * 1024;

const STATUS: Record<string, number> = { not_found: 404, conflict: 409, already_clear: 409, lockdown: 423, too_large: 413, binary: 400, patch_failed: 409, invalid_state: 409, paused: 409, invalid_argument: 400, invalid_path: 400, denied: 404, gone: 410, admin_only: 403, totp_required: 403, export_denied: 403, read_only: 403, board_denied: 403, not_decider: 403,
  checkout_open: 409, checkpoint_incomplete: 409, handout_consumed: 409, handout_changed: 409, repo_no_remote: 409, unmerged_work: 409, restore_unavailable: 409, scan_pending: 409, rate_limited: 429,
  // Delegate one agent (docs/checkout.md §9 F1).
  checkout_conflict: 409, only_coordinator: 409, no_project: 409, not_ready: 409, prompt_in_use: 409, pc_not_confirmed: 409, agent_away: 409 };

/**
 * Where KaTeX lives: the copy Mermaid depends on, resolved through Mermaid (not through npm's hoisting), and the font
 * file names it ships, the only ones /vendor/katex/fonts/ serves. null when Mermaid or its KaTeX is missing.
 */
export function katexFiles(): { dist: string; version: string; fonts: Set<string> } | null {
  try {
    const viaMermaid = createRequire(createRequire(import.meta.url).resolve('mermaid/package.json'));
    const pkg = viaMermaid.resolve('katex/package.json'), dist = join(dirname(pkg), 'dist');
    const fonts = new Set(readdirSync(join(dist, 'fonts')).filter((n) => /^KaTeX_[A-Za-z0-9]+-[A-Za-z]+\.(woff2|woff|ttf)$/.test(n)));
    return { dist, version: (JSON.parse(readFileSync(pkg, 'utf8')) as { version: string }).version, fonts };
  } catch { return null; }
}

export async function buildApp(config: Config, extras: { demo?: import('./demo/demo.js').DemoController } = {}) {
  const db = openDb(config.dbFile);
  const audit = new Audit(db);
  const keys = new Keys(db, config.pepper, audit);
  // Key handovers (docs/onboarding.md#key-handover-a-rotated-key-or-a-recruit-reaches-a-connector-pc): sets keys.handoverCancel.
  const handovers = new Handovers(db, keys, audit);
  const vault = new Vault(config.vaultDir, config.vaultAlias);
  const store = new VaultStore(db, vault, audit, config.dataDir);
  // The vault folder "99 Conclave/" (docs/vault.md): only the hub writes it; agent walks (search, backlinks) skip it.
  setReserved([`/${vault.alias}/${MIRROR_FOLDER}`]);
  vault.agentSkip = [[MIRROR_FOLDER]];
  store.start({ scanSeconds: config.vaultScanSeconds ?? 60, watch: config.vaultWatch !== false });
  const relays = new Relays(db, config.pepper, audit);
  // A pairing code counts as issued when it is one of the hub's own codes, used or not (docs/onboarding.md#the-code).
  const guard = new LeakGuard({ isIssued: (k, id, s) => (k === 'rly' ? relays.isIssued(id, s) : k === 'pair' ? !!db.prepare('SELECT 1 x FROM enrolment_codes WHERE verifier=?').get(hmacHex(config.pepper, `${CODE_PREFIX}${s}`)) : keys.isIssued(k, id, s)) });
  const loginLimit = new RateLimit(db, 10, 10 * 60 * 1000);
  const setup = new Setup(db, config.pepper, audit, keys, config.publicUrl, config.bridgeFile);
  const links = new Links(db, keys, audit);
  const connector = new Connector(db, keys, audit, config.pepper, config.connectorPrices ?? {});
  connector.guard = guard;
  connector.handovers = handovers;
  handovers.hint = (pc) => connector.streams.handovers(pc);
  // Delivery (docs/connector.md, "Delivery orders"): a notice that needs a turn makes one order for its agent's PC; a closed access closes the stream.
  // The connector's result for a delivery order reaches the items: a task's open turn, and the agent's answered decisions (docs/connector.md, "Delivery orders").
  connector.onDelivery = (agentId, items, o) => {
    const now = Date.now();
    for (const i of items) {
      if (i.task) { if (o.delivered) teams.turns.delivered(i.task, agentId, now); else if (o.reason) teams.turns.undelivered(i.task, agentId, o.reason as DeliveryReason); }
      if (i.notice === 'decision' && o.delivered) db.prepare("UPDATE decisions SET delivered_at=? WHERE agent_id=? AND status='answered' AND delivered_at IS NULL").run(now, agentId);
    }
  };
  keys.onNotice = (agentId, kind, ref) => { connector.deliver(agentId, { notice: kind, ...(ref?.kind === 'task' ? { task: ref.id } : {}) }); };
  keys.onAccessEnded = (e) => { if (e.machine) connector.accessEnded(e.machine); if (e.credential) connector.streams.closeCredential(e.credential); };
  const messaging = new Messaging(db, keys, links);
  // Owner enforcement (docs/authorization.md#owner-enforcement): no ceiling while the setting is off.
  const ownerScope = new OwnerScope(db, vault.alias);
  // Vault sync (docs/vault-sync.md): the readers, the vault's change feed and the hint on the push stream.
  const vaultSync = new VaultSync(db, keys, audit, config.pepper, store, vault.alias);
  vaultSync.ownerScope = ownerScope;
  vaultSync.hintPc = (pc, reader) => connector.streams.hint(pc, reader);
  messaging.ownerScope = ownerScope;
  // A message with no sender agent (kind system, written by the hub for the operator) is never held back (docs/connector.md, "Delivery orders"): never held back; an agent's is L2 and capped.
  messaging.onSent = (m, to) => { for (const a of to) connector.deliver(a, { notice: 'message', from: m.sender_agent_id === null ? 'operator' : 'agent' }); };
  const teams = new Teams(db, keys, links, messaging, audit);
  // Reset (connector design 3c): a coordinator resets its own team's agents through the connector service, audited there.
  teams.onAgentReset = (agentId, actor) => connector.resetAgent(agentId, actor);
  connector.turns = { held: (a) => teams.turns.held(a).map((h) => ({ task_id: h.task_id, phase: h.turn.phase })), open: (t) => teams.turns.current(t) !== null, paused: (a) => teams.pausedTeamOf(a) !== null };
  const users = new Users(db, audit, config);
  // Notices follow the owner, and an owner whose account ends tells their agents at once (docs/authorization.md#owner-enforcement).
  keys.noticeFilter = (agentId, ref) => ownerScope.maySeeNotice(agentId, ref);
  users.onOwnerAccess = (userId, why) => {
    if (!ownerScope.enforced()) return;
    const who = ownerScope.label(userId);
    const body = why === 'expired' || why === 'disabled'
      ? `Your owner ${who}'s console account ${why === 'expired' ? 'expired' : 'was disabled'}, so the rules you work under changed: until the administrator hands you on to another owner, you keep only the tools every session has.`
      : `Your owner ${who}'s console account ${why === 'enabled' ? 'was enabled again' : 'is active again (its expiry was lifted or moved later)'}, so the rules you work under changed: you work within ${who}'s grant again.`;
    for (const a of keys.ownedBy(userId).filter((x) => !x.archived)) keys.notify(a.id, 'permissions_changed', `${body} Call access_list to see what you may do now.`);
  };
  // Project blueprints (docs/blueprint.md): every team plans in its own part.
  const blueprint = new Blueprint(db);
  loadBlueprintLimits(db, blueprint); // the operator's limits (Settings, docs/blueprint.md §6)
  teams.refreshGrants(); // teams created before an added coordinator action or tool get it on start
  // The sweep: alerts whose proposal, request or task was decided while nothing closed them. It includes task_overdue, so
  // after migration 0107 the overdue alerts of tasks that are now queued (no deadline) close on the first start.
  audit.settle();
  const shares = new Shares(db, keys, messaging, teams, store);
  // A new team gets its project at once, so bp_* work from the start (docs/blueprint.md §3); a submitted share is checked (F-19).
  teams.onTeamCreated = (teamId) => { blueprint.ensureTeamProject(teamId, { kind: 'system', id: null }); };
  teams.blueprint = blueprint; // status and plan requests are opened by the blueprint
  blueprint.onProposalClosed = (teamId, proposalId, status) => teams.settlePendingRefs(teamId, proposalId, status);
  blueprint.onKeysAdded = (projectId, keys) => teams.pendingRefsLive(projectId, keys);
  teams.checkShare = (agentId, shareId, version) => shares.checkSubmitted(agentId, shareId, version);
  if (config.shareBytesPerHour) shares.bytesPerHour = config.shareBytesPerHour;
  // Task attachments: hub-made shares bound to a task, read under the task rule (docs/specification.md, Tasks).
  const taskAttachments = new TaskAttachments(db, shares, teams, audit, store);
  // What a task names that its reviewer cannot read under the hub's rules: the submitted share and the brief and
  // submission files. Empty when everything opens, so a request for changes "evidence unreadable" counts as usual.
  teams.unreadableEvidence = (t, agentId) => {
    const out: string[] = [];
    if (t.share_id) { const sh = shares.share(t.share_id); if (!sh || !shares.canAccess(sh, agentId)) out.push(`the submitted share ${sh?.name ?? t.share_id}`); }
    for (const role of ['brief', 'submission'] as const) {
      const set = taskAttachments.setOf(t.id, role);
      if (set && set.status !== 'revoked' && !taskAttachments.canRead(set, agentId)) out.push(`the ${role} files`);
    }
    return out;
  };
  const channels = new Channels(db, keys, teams, setup, store, vault, shares, guard, audit, {
    inlineMax: config.channelInlineMax ?? 1024 * 1024, bridgeMax: config.channelBridgeMax ?? 20 * 1024 ** 3, perKey: config.channelPerKey ?? 4, global: config.channelGlobal ?? 32,
    bytesPerHour: config.channelBytesPerHour ?? 50 * 1024 ** 3, bufferBytes: config.channelBufferBytes ?? 8 * 1024 * 1024, tmpDir: join(config.dataDir, 'tmp'), expireMs: 10 * 60_000, idleMs: config.channelIdleMs ?? 2 * 3600_000,
  });
  channels.ownerScope = ownerScope;
  channels.peerAllows = (agentId, action, resource) => messaging.agentAllows(agentId, action, resource);
  // The connector's service carries an enrolled PC's transfers; task files from the PC land through TaskAttachments (docs/transfers.md).
  channels.connectorPc = (pc) => ['online', 'offline'].includes(connector.status(pc).status);
  channels.taskAttach = { refusal: (c) => taskAttachments.uploadRefusal(c), commit: (c, files) => taskAttachments.commitUpload(c, files), maxBytes: ATTACH_LIMITS.version, fileMax: ATTACH_LIMITS.file };
  const access = new Access(db, keys, audit);
  const lockdown = new Lockdown(db, vault.alias);
  connector.streams.allowed = (pc) => connector.streamAllowed(pc, lockdown.pc(pc));
  connector.turnHold = (agentId, pc) => {
    if (lockdown.agent(agentId) || lockdown.pc(pc)) return { code: 'lockdown', message: 'A lockdown holds this agent or its PC: the turn token ends.' };
    // A checkout's own pause (reason checkout:<id>) holds the team while its work moves; the resume run it starts keeps its token.
    const paused = db.prepare("SELECT 1 FROM team_members m JOIN teams t ON t.id=m.team_id WHERE m.agent_id=? AND m.removed_at IS NULL AND t.status='paused' AND (t.paused_reason IS NULL OR t.paused_reason NOT LIKE 'checkout:%') LIMIT 1").get(agentId);
    return paused ? { code: 'paused', message: 'The team is paused: the turn token ends, and the run with it after its current call.' } : null;
  };
  connector.locked = (pc) => lockdown.pc(pc);
  connector.handoversLocked = (pc) => lockdown.writes() || lockdown.pc(pc);
  lockdown.onSet = (kind, id) => { if (kind === 'pc' && id) connector.accessEnded(id); };
  lockdown.onLift = (kind, id, since) => teams.holdLifted(kind, id, since); // the sweep skipped held members: restart their leases
  taskAttachments.lockdown = lockdown;
  const feedback = new Feedback(db, keys, audit, teams);
  const hardware = new Hardware(db, keys, audit, guard);
  const decisions = new Decisions(db, keys, teams, audit, store, vault);
  // Decider routing (docs/multi-user.md §1.3): questions and access requests go to a team's deciders when it has any.
  const routing = new Routing(db, users, audit, vault.alias);
  decisions.onAsked = (id, teamId) => routing.routed(id, teamId);
  access.routeTeam = (agentId) => routing.requestTeam(agentId);
  blueprint.deps = { keys, audit, lockdown, exportMd: (id) => new BlueprintViews(db, blueprint).exportMarkdown(id).text, backupDir: config.backupDir ?? join(config.dataDir, 'backups') };
  decisions.blueprint = blueprint;
  blueprint.onItemAsk = (a) => decisions.askForItem(a); // an unclear mark's question, opened by its own write (docs/blueprint.md §2.7)
  const directives = new Directives(db, keys, teams, audit);
  // Directive reach follows live team memberships and their projects: each change tells the agents it moved (docs/directives.md#project-reach).
  teams.reachGuard = (ids, fn) => directives.refresh(ids, fn);
  blueprint.deps.reach = (ids, fn) => directives.refresh(ids, fn);
  // While owner enforcement is on, an owner's grant decides which memberships count: grant, owner and enforcement changes refresh too.
  users.reachGuard = (ids, fn) => directives.refresh(ids, fn);
  keys.reachGuard = (ids, fn) => directives.refresh(ids, fn);
  channels.lockdown = lockdown;
  // Checkout and handouts (docs/checkout.md): the expiry sweep runs on Teams.tick; the team pause at ready exempts checkout_* tools.
  const checkouts = new Checkouts(db, keys, teams, audit);
  // Move team with no one at the keyboard (docs/connector.md, "Reason orders"): once the target PC restored the agents, each moved one is woken to resume.
  connector.onRestored = (checkoutId) => { for (const h of checkouts.handouts(checkoutId)) if (h.new_credential_id && h.status !== 'consumed') connector.deliverReason(h.agent_id, 'resume'); };
  checkouts.seedRepoHosts = config.repoHosts ?? null; // the repo host allowlist until the operator saves one (§8)
  const onboarding = new Onboarding({ db, keys, teams, audit, vault, guard, lockdown, pepper: config.pepper, hubUrl: config.publicUrl, handovers });
  // A new team's part, or for a project's only team (FR-PLAN-12) the project-level module or line its kept records go in.
  onboarding.onTeamApproved = (teamId, actor, o) => blueprint.openTeamPart(teamId, { kind: 'operator', id: actor.id }, o) ?? blueprint.projectLevelHome(teamId);
  // The requirements and research records kept at approval: one linked proposal (docs/onboarding.md#content-from-onboarding).
  onboarding.proposeContent = (teamId, track, c, reason, actor) => blueprint.proposeOnboarding(teamId, track, c, reason, { kind: 'operator', id: actor.id });
  onboarding.projectInfo = (name) => blueprint.projectInfo(name);
  onboarding.setProjectKind = (teamId, kind, actor) => blueprint.setNewProjectKind(teamId, kind, { kind: 'operator', id: actor.id });
  onboarding.setupContent = (teamId) => blueprint.setupContent(teamId); // a team's setup reads Done once its part holds content
  onboarding.repoHostCheck = (id, actor) => checkouts.assertRepoHosts(id, actor, 'pickup'); // pickup re-checks the allowlist (§8)
  onboarding.createDirective = (a, actor) => { directives.create(a, actor); }; // the rules kept at approval (docs/directives.md)
  const clientFiles = new ClientFiles(findClientDir(config.clientDir), config.caCertFile);
  // Checkout keys and render (docs/checkout.md §5): the checkout kind of onboarding request, successor keys, the target table.
  const checkoutKeys = new CheckoutKeys({ db, keys, teams, audit, onboarding, checkouts, files: clientFiles, hubUrl: config.publicUrl });
  const delegations = new Delegations({ db, keys, teams, audit, onboarding, checkouts, checkoutKeys, ownerScope, users });
  // The read-only copies of the hub's records in "99 Conclave/" and the deferred purge of handout bodies (D63).
  const mirror = new Mirror({ db, store, vault, guard, audit, decisions, publicUrl: config.publicUrl, pushList: (id) => checkoutKeys.pushList(checkouts.mustCheckout(id)) });
  checkouts.onChange = (id, expect) => { void mirror.checkoutChanged(id, expect); };
  teams.onReviewed = (teamId) => mirror.reviewed(teamId);
  teams.onTaskEvent = (taskId) => {
    mirror.noteEvent({ kind: 'task', id: taskId }, null);
    // A linked task changed: close or reopen the feedback reports it fixes (docs/feedback.md#closing-by-itself).
    try { feedback.onTaskEvent(taskId); } catch (e) { console.error('feedback task check failed', e); }
  };
  decisions.onSettled = (teamId) => mirror.settled(teamId);
  audit.onEvent = (action, target, details) => mirror.noteEvent(target, details, action);
  mirror.start({ sweep: config.vaultScanSeconds !== 0 });
  const graph = new Graph(db, store, vault, teams, keys, config.graph, audit);
  const alerts = new Alerts(db, audit, keys, vault, config.alerts ? { ...DEFAULT_ALERT_OPTS, ...config.alerts } : DEFAULT_ALERT_OPTS);
  const maintenance = new Maintenance(db, store, access, alerts, config.retention ? { ...DEFAULT_RETENTION, ...config.retention } : DEFAULT_RETENTION);
  maintenance.health = new DbHealth({ db, audit, keys, lockdown, dbFile: config.dbFile, backupDir: config.backupDir ?? join(config.dataDir, 'backups'), retention: config.retention ? { ...DEFAULT_RETENTION, ...config.retention } : DEFAULT_RETENTION });
  if (config.maintenanceSeconds !== 0) maintenance.start((config.maintenanceSeconds ?? 60) * 1000);
  const upkeep = setInterval(() => { try { teams.tick(true); channels.sweep(); users.sweepExpired(); routing.escalate(); hardware.sweepAll(); handovers.sweep(); taskAttachments.sweep(); connector.tick(); } catch (e) { fastify.log.error(e); } }, 30_000);
  upkeep.unref();
  const pairLimit = new RateLimit(db, 10, 10 * 60 * 1000);
  const sys = { kind: 'system' as const, id: null };

  // Seed the built-in templates on first start.
  if (keys.templates().length === 0) {
    for (const t of builtinTemplates(config.vaultAlias)) keys.createTemplate(t.name, t.description, t.rules, sys);
  }
  bootstrapAdmin(db, audit, config);

  const fastify = Fastify({ logger: config.logLevel === 'silent' ? false : { level: config.logLevel, redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-agent-hub-session"]', 'req.headers["x-conclave-enrol-code"]', 'req.headers["x-conclave-relay-secret"]'] }, bodyLimit: 2 * 1024 * 1024, trustProxy: config.trustProxy ?? 'loopback' });
  await fastify.register(cookie);
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (body === '') return done(null, undefined);
    try { done(null, JSON.parse(body as string)); } catch { done(Object.assign(new Error('invalid JSON'), { statusCode: 400 }), undefined); }
  });

  fastify.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'invalid_argument', message: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
    if (err instanceof KeyError || err instanceof VaultError) return reply.code(STATUS[err.code] ?? 400).send({ error: err.code, message: err.message, ...(err instanceof KeyError ? err.extra ?? {} : {}) });
    const e = err as { statusCode?: number; message: string; code?: string };
    // A body over the limit: say what the limit is and what to do, instead of a bare refusal.
    // An MCP client reads a JSON-RPC error, not our {error, message}: for /mcp the reason (size and limit) goes in that shape, so the agent is told.
    if (e.statusCode === 413 && req.url.split('?')[0] === '/mcp') {
      const sent = Number(req.headers['content-length']);
      const size = Number.isFinite(sent) && sent > 0 ? ` The request was ${sent} bytes.` : '';
      return reply.code(413).type('application/json').send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: `too_large: the request is too large; this hub takes at most ${MCP_BODY_LIMIT} bytes (a 2 MiB text plus 64 KiB of JSON around it) in one call.${size} A vault text write takes at most ${MAX_CONTENT} bytes (2 MiB) of UTF-8 text; split larger text into several files.`, data: { error: 'too_large', limit_bytes: MCP_BODY_LIMIT, text_limit_bytes: MAX_CONTENT, ...(size ? { size_bytes: sent } : {}) } } });
    }
    if (e.statusCode === 413) return reply.code(413).send({ error: 'too_large', message: `The request body is too large for this route. A vault text write takes at most ${MAX_CONTENT} bytes (2 MiB) of UTF-8 text; split larger text into several files.` });
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: 'bad_request', message: e.message });
    fastify.log.error(err);
    return reply.code(500).send({ error: 'internal_error', message: 'Internal error.' });
  });

  // A registered relay's own secret makes its client-address header count (docs/relay.md): req.ip becomes the user's address and the
  // request records the relay as seen. Without the secret, or with a wrong one, the header is ignored and the connection address stays.
  fastify.decorateRequest('relay', null);
  fastify.addHook('onRequest', async (req) => {
    const secret = req.headers[RELAY_SECRET_HEADER];
    if (typeof secret !== 'string') return;
    const relay = relays.verify(secret);
    if (!relay) return;
    req.relay = relay;
    const c = req.headers[RELAY_CLIENT_HEADER];
    const ip = typeof c === 'string' ? clientAddress(c) : null;
    if (ip) Object.defineProperty(req, 'ip', { value: ip, configurable: true });
    relays.touch(relay.id, ip ?? req.ip);
  });

  // A general limit on the public routes, per address (after the relay hook above has set the user's address): 429 with Retry-After.
  const publicLimiter = new PublicLimiter({ max: config.publicRequestsPerMinute ?? 300 });
  fastify.addHook('onRequest', async (req, reply) => {
    const bucket = publicBucket(req.url, req.headers);
    if (!bucket) return;
    // The client address counts only when TRUST_PROXY is set (or a registered relay vouched for it); else the connection's own address.
    const r = publicLimiter.hit(limitAddress(req, config.trustProxy), Date.now(), bucket);
    if (!r.limited) return;
    return reply.code(429).header('retry-after', String(r.retryAfterSeconds)).send({ error: 'rate_limited', message: `Too many requests from this address. Try again in ${r.retryAfterSeconds} seconds.` });
  });

  fastify.addHook('onSend', async (req, reply, payload) => {
    if (!req.url.startsWith('/mcp')) {
      // A route that set a private policy keeps it (vault media: revalidated on every use, never in a shared cache).
      const cc = reply.getHeader('cache-control');
      reply.header('x-content-type-options', 'nosniff');
      if (!(typeof cc === 'string' && cc.startsWith('private'))) reply.header('cache-control', 'no-store');
      if (!req.url.startsWith('/api')) reply.header('content-security-policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'");
    }
    return payload;
  });

  fastify.get('/health', async () => ({ ok: true }));

  // ── static console ──
  const asset = (name: string, type: string) => {
    fastify.get(name === 'index.html' ? '/' : `/${name}`, async (_req, reply) => reply.type(type).send(readFileSync(join(config.publicDir, name))));
  };
  asset('index.html', 'text/html; charset=utf-8');
  asset('app.js', 'text/javascript; charset=utf-8');
  asset('md.js', 'text/javascript; charset=utf-8');
  asset('style.css', 'text/css; charset=utf-8');
  asset('favicon.svg', 'image/svg+xml');
  asset('fonts/geist.woff2', 'font/woff2');
  asset('fonts/geist-mono.woff2', 'font/woff2');
  // The Mermaid library (docs/design-guidelines.md, Diagrams), served by the hub from its own dependency, never a CDN. The
  // console loads it only when a page holds a diagram; read once, on the first request. Missing: 404, and the console
  // shows the diagram's code with a note.
  let mermaidJs: Buffer | null = null;
  fastify.get('/vendor/mermaid.min.js', async (_req, reply) => {
    try { mermaidJs ??= readFileSync(createRequire(import.meta.url).resolve('mermaid/dist/mermaid.min.js')); }
    catch { return reply.code(404).type('text/plain; charset=utf-8').send('Mermaid is not installed on this hub.'); }
    return reply.type('text/javascript; charset=utf-8').header('cache-control', 'public, max-age=86400').send(mermaidJs);
  });
  // KaTeX for maths in Markdown (docs/design-guidelines.md, Maths): Mermaid's own copy, resolved through Mermaid so nothing
  // new is installed. The console loads it only when a page holds a formula. Fonts: only the file names KaTeX ships.
  const katex = katexFiles();
  const vendor = (path: string, type: string, read: () => Buffer | string | null) => {
    let body: Buffer | string | null = null;
    fastify.get(path, async (_req, reply) => {
      try { body ??= read(); } catch { body = null; }
      if (body === null) return reply.code(404).type('text/plain; charset=utf-8').send('KaTeX is not installed on this hub.');
      return reply.type(type).header('cache-control', 'public, max-age=86400').send(body);
    });
  };
  vendor('/vendor/katex.min.js', 'text/javascript; charset=utf-8', () => katex && readFileSync(join(katex.dist, 'katex.min.js')));
  // The stylesheet names its fonts as fonts/<name>; here they live under /vendor/katex/fonts/.
  vendor('/vendor/katex.min.css', 'text/css; charset=utf-8', () => katex && readFileSync(join(katex.dist, 'katex.min.css'), 'utf8').replace(/url\(fonts\//g, 'url(katex/fonts/'));
  const fontBodies = new Map<string, Buffer>();
  fastify.get<{ Params: { name: string } }>('/vendor/katex/fonts/:name', async (req, reply) => {
    const name = req.params.name;
    if (!katex || !katex.fonts.has(name)) return reply.code(404).type('text/plain; charset=utf-8').send('No such font.');
    let body = fontBodies.get(name);
    if (!body) { body = readFileSync(join(katex.dist, 'fonts', name)); fontBodies.set(name, body); }
    const ext = name.slice(name.lastIndexOf('.') + 1);
    return reply.type(ext === 'woff2' ? 'font/woff2' : ext === 'woff' ? 'font/woff' : 'font/ttf').header('cache-control', 'public, max-age=86400').send(body);
  });

  const adminRoutes = registerAdminApi(fastify, { ownerScope, users, routing, demo: extras.demo, db, keys, audit, vault, store, config, loginLimit, setup, links, messaging, teams, phase5: { access, lockdown, alerts, shares, channels, maintenance }, graph, feedback, hardware, decisions, directives, onboarding, clientFiles, blueprint, checkouts, checkoutKeys, delegations, mirror, handovers, taskAttachments, connector, vaultSync, relays });
  registerOnboarding(fastify, onboarding, clientFiles, config.connectorReleaseDir);
  registerConnector(fastify, db, connector, keys, setup, directives, hardware);
  registerVaultSync(fastify, { db, keys, audit, sync: vaultSync, vault, store });
  const bridge = registerBridge(fastify, setup, pairLimit, channels, keys);
  fastify.addHook('preClose', async () => { bridge.releaseAll(); onboarding.releaseAll(); messaging.releaseAll(); teams.releaseAll(); clearInterval(upkeep); maintenance.stop(); vaultSync.stop(); });

  // ── MCP (stateless) ──
  const unauthorized = (reply: import('fastify').FastifyReply, msg: string) => reply.code(401).header('www-authenticate', 'Bearer').send({ error: 'unauthorized', message: msg });
  const originOk = (req: import('fastify').FastifyRequest) => {
    const o = req.headers.origin;
    const origin = String(o).replace(/[/]+$/, '');
    return o === undefined || config.allowedOrigins.includes(origin) || relays.origins().includes(origin);
  };
  // Failed app-key checks are audited, but at most 20 rows per client address per minute: a client looping on a
  // wrong key must not grow the audit table without bound. The first rows are enough to see and alert on it.
  const authNoise = new Map<string, number>();
  const authFail = (req: import('fastify').FastifyRequest, row: Parameters<typeof audit.auth>[0]) => {
    const minute = Math.floor(Date.now() / 60_000), k = `${minute}|${req.ip}`;
    if (authNoise.size > 10_000) for (const key of authNoise.keys()) if (!key.startsWith(`${minute}|`)) authNoise.delete(key);
    const n = (authNoise.get(k) ?? 0) + 1;
    authNoise.set(k, n);
    if (n <= 20) audit.auth(row);
  };
  // A 2 MiB text arrives inside a JSON body that is larger than the text itself (quotes, escapes, the other arguments).
  fastify.post('/mcp', { bodyLimit: MCP_BODY_LIMIT }, async (req, reply) => {
    if (!originOk(req)) return reply.code(403).send({ error: 'forbidden_origin', message: 'Origin not allowed.' });
    const h = req.headers.authorization;
    const m = typeof h === 'string' ? /^Bearer\s+(\S+)$/i.exec(h) : null;
    const keyId = m ? /^ah_app_([a-z2-7]{12})_/.exec(m[1]!)?.[1] ?? null : null;
    // A session holds no app key (docs/connector.md, "Isolation levels"): a call may carry a TURN token alone, and the hub finds the PC from it.
    const turnOnly = !m && typeof req.headers['x-agent-hub-session'] === 'string' ? req.headers['x-agent-hub-session'].trim() : null;
    if (!m && !turnOnly) { authFail(req, { subject: 'app_key', outcome: 'invalid', source: req.ip }); return unauthorized(reply, 'Missing app key.'); }
    let app;
    try { app = m ? keys.verifyKey(m[1]!, 'app_key') : keys.appOfTurnToken(turnOnly!); }
    catch (e) {
      const code = e instanceof KeyError ? e.code : 'invalid';
      if (!m) return reply.code(401).header('www-authenticate', 'Bearer error="invalid_token"').send({ error: 'login_required', message: 'This turn token is not valid. Ask the connector for a new one.' });
      authFail(req, { subject: 'app_key', keyId, outcome: ['invalid', 'unknown', 'suspended', 'expired', 'revoked'].includes(code) ? code : 'invalid', source: req.ip });
      return unauthorized(reply, 'Invalid app key.');
    }
    // Optional: a session token in a header, for clients whose credential helper logs in outside the model. An invalid or
    // expired one is refused here with 401, so the client re-runs its helper (a fresh login) and retries the call.
    const sh = req.headers['x-agent-hub-session'];
    const headerToken = typeof sh === 'string' && sh.trim() ? sh.trim() : null;
    let headerSession: ReturnType<typeof keys.resolveToken> | null = null;
    if (headerToken) {
      try { headerSession = keys.resolveToken(app, headerToken); }
      catch (e) {
        const code = e instanceof KeyError ? e.code : 'login_required';
        return reply.code(401).header('www-authenticate', 'Bearer error="invalid_token"').send({ error: code, message: e instanceof Error ? e.message : 'Session token not accepted.' });
      }
    }
    // A call to a tool removed in 1.0 is answered here, before the transport (docs/mcp.md, "Removed tools").
    const removed = removedToolAnswer(req.body);
    if (removed) return reply.code(200).type('application/json').send(removed);
    const server = buildMcpServer({ db, keys, audit, guard, vault, store, loginLimit, setup, links, messaging, teams, messagesPerHour: config.messagesPerHour ?? 120, shares, channels, access, lockdown, alerts, graph, feedback, hardware, decisions, directives, blueprint, checkouts, ownerScope, attachments: taskAttachments }, app, req.ip, headerToken, headerSession, compactHeader(req.headers['x-agent-hub-compact']), clientHint(req.headers['x-agent-hub-folder'], req.headers['x-agent-hub-session-var']));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    // The digest of what this session lists (docs/mcp.md, "When the list changes"): conclave mcp compares it to tell the client.
    const digest = toolsDigest(server);
    if (digest) reply.raw.setHeader('x-agent-hub-tools', digest);
    reply.raw.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
  const notAllowed = async (_req: unknown, reply: import('fastify').FastifyReply) => reply.code(405).header('allow', 'POST').send({ error: 'method_not_allowed', message: 'Use POST.' });
  fastify.get('/mcp', notAllowed);
  fastify.delete('/mcp', notAllowed);

  return { fastify, relays, guard, users, routing, adminRoutes, connector, onboarding, handovers, taskAttachments, checkouts, checkoutKeys, delegations, clientFiles, db, keys, audit, vault, store, config, setup, links, messaging, teams, blueprint, shares, channels, access, lockdown, alerts, maintenance, graph, feedback, hardware, decisions, directives, mirror, close: async () => { await fastify.close(); await mirror.stop(); await store.stop(); db.close(); } };
}
export type App = Awaited<ReturnType<typeof buildApp>>;
