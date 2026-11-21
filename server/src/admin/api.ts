/** Admin API under /api (JSON). Cookie session + CSRF header; TOTP once enrolled. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RateLimit } from '../db/rateLimit.js';
import { z } from 'zod';
import type { Db } from '../db/db.js';
import { tx } from '../db/db.js';
import type { Keys, Credential } from '../keys/keys.js';
import { KeyError } from '../keys/keys.js';
import { registerAttachmentApi } from './attachmentApi.js';
import type { TaskAttachments } from '../shares/taskAttachments.js';
import type { Handovers } from '../keys/handover.js';
import type { Audit, Actor } from '../audit/audit.js';
import type { Vault } from '../vault/vault.js';
import type { Config } from '../config.js';
import { authorize, canReach, validateRules, parseResource, explicitlyDenied } from '../policy/engine.js';
import type { Rule, Cap } from '../policy/engine.js';
import type { OwnerScope } from '../policy/ownerScope.js';
import { BASE_TOOLS, DEFAULT_TOOLS, GRANTED_TOOLS } from '../policy/catalogue.js';
import { hashPassword, randomToken, safeEqualHex, sha256Hex, verifyPasswordAsync } from '../util/crypto.js';
import { newId } from '../util/ids.js';
import type { Setup } from '../setup/setup.js';
import type { Links } from '../links/links.js';
import { registerPhase2 } from './phase2.js';
import { registerPhase3 } from './phase3.js';
import type { Messaging } from '../messaging/messaging.js';
import type { Teams } from '../teams/teams.js';
import { registerTeams } from './teams.js';
import { TeamStart } from '../teams/teamStart.js';
import { registerMemberBoard } from './memberBoard.js';
import { registerWorkFeed } from './workFeed.js';
import { registerVaultApi } from './vaultApi.js';
import { registerVaultLinksApi } from './vaultLinksApi.js';
import { registerVaultWriteApi } from './vaultWrite.js';
import { registerResetApi } from './resetApi.js';
import { registerDbHealthApi } from './dbHealthApi.js';
import { registerDemoApi } from './demoApi.js';
import type { DemoController } from '../demo/demo.js';
import { registerTelemetryApi } from './telemetryApi.js';
import { registerFeedbackApi } from './feedbackApi.js';
import { registerHardwareApi } from './hardwareApi.js';
import type { Hardware } from '../hardware/hardware.js';
import { registerDecisionsApi } from './decisionsApi.js';
import { registerBlueprintApi } from './blueprintApi.js';
import type { Blueprint } from '../blueprint/blueprint.js';
import { registerDirectivesApi } from './directivesApi.js';
import type { Directives } from '../directives/directives.js';
import type { Decisions } from '../teams/decisions.js';
import type { Feedback } from '../feedback/feedback.js';
import type { VaultStore } from '../vault/store.js';
import { Sources } from '../blueprint/sources.js';
import { Meetings } from '../blueprint/meetings.js';
import { registerPhase5 } from './phase5.js';
import { registerGraphAdmin } from './graphApi.js';
import type { Graph } from '../graph/graph.js';
import type { Phase5Deps } from './phase5.js';
import { registerOnboardingApi } from './onboardingApi.js';
import { PAIRING_MS, caCheck } from '../connector/identity.js';
import { registerConnectorApi } from './connectorApi.js';
import { through, type Relays, type ThroughRelay } from '../relay/relays.js';
import { registerRelayApi } from './relayApi.js';
import { registerVaultSyncApi } from './vaultSyncApi.js';
import type { VaultSync } from '../vaultsync/vaultSync.js';
import type { Connector } from '../connector/connector.js';
import { registerCheckoutApi } from './checkoutApi.js';
import type { Delegations } from '../checkout/delegate.js';
import { registerMirrorApi } from './mirrorApi.js';
import type { Mirror } from '../mirror/mirror.js';
import type { Checkouts } from '../checkout/checkout.js';
import type { CheckoutKeys } from '../checkout/render.js';
import type { Onboarding } from '../onboarding/onboarding.js';
import type { ClientFiles } from '../onboarding/http.js';
import { secretPrompt, toolsLine, clientOf } from '../keys/keyPrompt.js';
import { NeedsYou, NEEDS_PAGE_MAX, sourceReply, type Viewer, type CheckoutNeeds } from './needsYou.js';
import { Users, registerUsersApi, type UserRow } from './users.js';
import { scopeOf, MEMBER_LIVE, MEMBER_READY, BEFORE_TOTP, ADMIN_ONLY } from './scopes.js';
import type { Routing } from './routing.js';
import { CEILING_ACTIONS } from './routing.js';
import { BpRouting } from './bpRouting.js';
import { MemberScope } from './memberScope.js';
import { ownedAgents } from './accountView.js';

const COOKIE = 'ah_admin';
const SESSION_MS = 12 * 60 * 60 * 1000;

export interface AdminDeps { users: Users; routing: Routing; demo?: DemoController; db: Db; keys: Keys; audit: Audit; vault: Vault; store: VaultStore; config: Config; loginLimit: RateLimit; setup: Setup; links: Links; messaging: Messaging; teams: Teams; phase5: Omit<Phase5Deps, 'db' | 'keys' | 'audit'>; graph: Graph; feedback: Feedback; hardware: Hardware; decisions: Decisions; directives: Directives; onboarding: Onboarding; clientFiles: ClientFiles; blueprint: Blueprint; checkouts?: Checkouts; checkoutKeys?: CheckoutKeys; delegations?: Delegations; mirror?: Mirror; ownerScope?: OwnerScope; handovers?: Handovers; taskAttachments?: TaskAttachments; connector?: Connector; vaultSync?: VaultSync; relays?: Relays }
interface AdminCtx { id: string; username: string; csrf: string; totp: boolean; role: 'admin' | 'member'; user: UserRow }
declare module 'fastify' { interface FastifyRequest { admin?: AdminCtx; member?: MemberScope } }

const DUMMY_HASH = hashPassword('not-a-real-password');
/** Password checks running at once; more sign-ins wait their turn with a 429 instead of queueing scrypt work. */
const MAX_VERIFYING = 2;
let verifying = 0;

export function bootstrapAdmin(db: Db, audit: Audit, config: Config): void {
  const n = (db.prepare('SELECT COUNT(*) n FROM admin_users').get() as { n: number }).n;
  if (n > 0 || !config.adminUsername || !config.adminPassword) return;
  const id = newId.admin(), now = Date.now();
  db.prepare('INSERT INTO admin_users(id,username,password_hash,created_at,password_changed_at) VALUES (?,?,?,?,?)').run(id, config.adminUsername, hashPassword(config.adminPassword), now, now);
  audit.event({ kind: 'system', id: null }, 'admin.bootstrap', { kind: 'admin', id }, { username: config.adminUsername });
}

const ts = z.union([z.number().int(), z.string()]).nullable().optional().transform((v, ctx) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Date.parse(v);
  if (Number.isNaN(n)) { ctx.addIssue({ code: 'custom', message: 'invalid date' }); return z.NEVER; }
  return n;
});
const ruleSchema = z.object({
  effect: z.enum(['allow', 'deny']), actions: z.array(z.string()).min(1), resource: z.string(),
  from_template: z.string().nullable().optional(), note: z.string().nullable().optional(),
});
const checkRules = (rules: unknown): Omit<Rule, 'id'>[] => {
  try { validateRules(rules); return rules; } catch (e) { throw new KeyError('invalid_argument', (e as Error).message); }
};
const withSlash = (r: string) => (r.startsWith('/') ? `path:${r}` : r);

/** Routes whose refusals are audited, with the action written and the kind of the :id target. */
const REFUSED_AUDIT: Record<string, { name: string; target: string }> = {
  'PATCH /api/teams/:id': { name: 'team.update_refused', target: 'team' },
  'POST /api/teams/:id/checkout': { name: 'checkout.start_refused', target: 'team' },
  'POST /api/agents/:id/delegate': { name: 'checkout.start_refused', target: 'agent' },
};

/** Registers the admin API; returns the /api routes it registered ("METHOD /pattern"), which the scope registry must cover. */
export function registerAdminApi(f: FastifyInstance, d: AdminDeps): string[] {
  const { db, keys, audit, vault, config, loginLimit, users } = d;
  const routes: string[] = [];

  f.register(async (api) => {
    api.addHook('onRoute', (r) => { for (const m of [r.method].flat()) if (m !== 'HEAD' && r.url.startsWith('/api')) routes.push(`${m} ${r.url}`); });
    // ───── auth hook: session, expiry, 2FA requirement, then the route's scope (docs/multi-user.md §2) ─────
    api.addHook('preHandler', async (req, reply) => {
      const pattern = req.routeOptions.url ?? '';
      const scope = scopeOf(req.method, pattern), key = `${req.method === 'HEAD' ? 'GET' : req.method} ${pattern}`;
      if (scope === 'public') return;
      const sid = req.cookies[COOKIE];
      const row = sid ? db.prepare(`SELECT s.admin_id, s.csrf_token, s.expires_at session_expires_at, u.* FROM admin_sessions s JOIN admin_users u ON u.id=s.admin_id WHERE s.id_hash=?`)
        .get(Buffer.from(sha256Hex(sid), 'hex')) as (UserRow & { admin_id: string; csrf_token: string; session_expires_at: number }) | undefined : undefined;
      if (!row || row.session_expires_at < Date.now() || row.status !== 'active') return reply.code(401).send({ error: 'unauthenticated', message: 'Sign in first.' });
      if (users.isExpired(row)) { users.enforceExpiry(row); return reply.code(401).send({ error: 'expired', message: 'This account has expired.' }); }
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        const h = req.headers['x-csrf-token'];
        if (typeof h !== 'string' || !safeEqualHex(sha256Hex(h), sha256Hex(row.csrf_token))) return reply.code(403).send({ error: 'csrf', message: 'Missing or wrong x-csrf-token header.' });
      }
      db.prepare('UPDATE admin_sessions SET last_seen_at=? WHERE id_hash=?').run(Date.now(), Buffer.from(sha256Hex(sid!), 'hex'));
      req.admin = { id: row.admin_id, username: row.username, csrf: row.csrf_token, totp: row.totp_secret !== null, role: row.role, user: row };
      // 2FA required but not enrolled (§1.4): only /api/me, /api/totp/* and /api/logout until it is.
      if (!users.ready(row) && !BEFORE_TOTP.has(key)) return reply.code(403).send({ error: 'totp_required', message: 'Set up two-factor authentication first.' });
      // Undeclared routes are admin-only (fail closed); members reach only the scopes that are filtered for them.
      if (row.role !== 'admin' && (!scope || !(MEMBER_LIVE.has(scope) || ((scope === 'filtered' || scope === 'decider') && MEMBER_READY.has(key))))) return reply.code(403).send(ADMIN_ONLY);
      // A member's view of the hub, rebuilt on every call so a revoked grant applies at once (§2).
      if (row.role !== 'admin') req.member = new MemberScope(db, row.id, !!row.external);
    });
    // No console user id reaches a member (§1.4): views drop the ones they know of (who answered, who decided, task
    // event actors), and this pass replaces any other one (a Blueprint label, a proposal's decided_by, a grant's
    // granted_by) with plain `operator`.
    api.addHook('onSend', async (req, _reply, payload) => {
      if (!req.member || typeof payload !== 'string') return payload;
      let out = payload;
      for (const { id } of db.prepare('SELECT id FROM admin_users').all() as { id: string }[]) if (out.includes(id)) out = out.split(`operator:${id}`).join('operator').split(id).join('operator');
      return out;
    });
    // A refused team change or checkout start leaves a record (who, what, why), so "it never happened" can be read from
    // the audit trail (docs/checkout.md, "Refused starts"). Only a refusal by the route itself counts: one by the auth hook
    // (no session, CSRF, a member outside the route's scope) writes nothing, so no caller can fill the trail.
    const reached = new WeakSet<FastifyRequest>();
    api.addHook('preHandler', async (req) => { if (req.admin) reached.add(req); });
    api.addHook('onSend', async (req, reply, payload) => {
      const action = REFUSED_AUDIT[`${req.method} ${req.routeOptions.url ?? ''}`];
      if (!action || reply.statusCode < 400 || !req.admin || !reached.has(req)) return payload;
      let e: { error?: unknown; message?: unknown } = {};
      try { e = typeof payload === 'string' ? JSON.parse(payload) : {}; } catch { /* not JSON */ }
      const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? Object.keys(req.body as object).slice(0, 30) : [];
      try {
        audit.event({ kind: 'admin', id: req.admin.id, role: req.admin.role }, action.name, { kind: action.target, id: String((req.params as { id?: string }).id ?? '') },
          { status: reply.statusCode, error: typeof e.error === 'string' ? e.error : null, message: typeof e.message === 'string' ? e.message.slice(0, 500) : null, ...(b.length ? { fields: b } : {}) });
      } catch (err) { console.error('refused-action audit failed', err); }
      return payload;
    });
    const actor = (req: FastifyRequest): Actor => ({ kind: 'admin', id: req.admin!.id, role: req.admin!.role });
    const body = <T extends z.ZodType>(s: T, req: FastifyRequest): z.infer<T> => s.parse(req.body ?? {});
    /** A key prompt "through relay X" (docs/relay.md): the registered relay, or a not_found. */
    const relayOf = (id: string | null | undefined): ThroughRelay | null => {
      if (!id) return null;
      const r = d.relays?.get(id);
      if (!r) throw new KeyError('not_found', 'No such relay.');
      return through(r);
    };
    const idOf = (req: FastifyRequest) => (req.params as { id: string }).id;
    const cred = (id: string): Credential => { const c = keys.credential(id); if (!c) throw new KeyError('not_found', 'key not found'); return c; };

    /** On a demo hub the .env operator's password is fixed (Replay signs in with it). */
    const passwordLocked = (u: UserRow) => !!(config.demoMode && config.adminUsername && u.role === 'admin' && u.username.toLowerCase() === config.adminUsername.toLowerCase());

    // ───── login / session ─────
    api.post('/api/login', async (req, reply) => {
      const b = body(z.object({ username: z.string(), password: z.string(), totp: z.string().optional() }), req);
      const now = Date.now();
      // Per username and per client address: a stream of attempts with changing usernames is limited too.
      if (loginLimit.blocked(b.username, 'admin_login_fail', now).blocked || loginLimit.blocked(`ip:${req.ip}`, 'admin_login_fail_ip', now).blocked) {
        audit.auth({ subject: 'admin', outcome: 'rate_limited', source: req.ip });
        return reply.code(429).send({ error: 'rate_limited', message: 'Too many failed sign-ins. Try again later.' });
      }
      const u = db.prepare('SELECT * FROM admin_users WHERE username=?').get(b.username) as UserRow | undefined;
      if (verifying >= MAX_VERIFYING) return reply.code(429).send({ error: 'rate_limited', message: 'Sign-in is busy. Try again in a moment.' });
      verifying++;
      let okPw = false;
      try { okPw = (await verifyPasswordAsync(b.password, u?.password_hash ?? DUMMY_HASH)) && !!u && u.status === 'active' && !!u.password_set; } finally { verifying--; }
      if (!okPw) { loginLimit.fail(b.username, 'admin_login_fail', now); loginLimit.fail(`ip:${req.ip}`, 'admin_login_fail_ip', now); audit.auth({ subject: 'admin', adminId: u?.id ?? null, outcome: 'invalid', source: req.ip }); return reply.code(401).send({ error: 'invalid_credentials', message: 'Wrong username or password.' }); }
      if (users.isExpired(u!, now)) {
        users.enforceExpiry(u!, now);
        audit.auth({ subject: 'admin', adminId: u!.id, outcome: 'expired', source: req.ip });
        return reply.code(401).send({ error: 'expired', message: 'This account has expired. Ask the admin.' });
      }
      if (u!.totp_secret) {
        if (!b.totp) return reply.code(401).send({ error: 'mfa_required', message: 'Enter the 6-digit code from your authenticator.' });
        // A code works once: a code already used (at sign-in, enrolment or setup) is refused like a wrong one.
        if (!users.useTotp(u!.id, u!.totp_secret, b.totp, now)) { loginLimit.fail(b.username, 'admin_login_fail', now); audit.auth({ subject: 'admin', adminId: u!.id, outcome: 'mfa_failed', source: req.ip }); return reply.code(401).send({ error: 'mfa_failed', message: 'Wrong code.' }); }
      }
      const sid = randomToken(24), csrf = randomToken(16);
      db.prepare('INSERT INTO admin_sessions(id_hash,admin_id,csrf_token,created_at,last_seen_at,expires_at) VALUES (?,?,?,?,?,?)').run(Buffer.from(sha256Hex(sid), 'hex'), u!.id, csrf, now, now, now + SESSION_MS);
      db.prepare('UPDATE admin_users SET last_login_at=? WHERE id=?').run(now, u!.id);
      audit.auth({ subject: 'admin', adminId: u!.id, outcome: 'success', source: req.ip });
      reply.setCookie(COOKIE, sid, { httpOnly: true, sameSite: 'strict', secure: config.production, path: '/', maxAge: SESSION_MS / 1000 });
      // A user who must enrol 2FA signs in to a session that reaches only /api/me, /api/totp/* and /api/logout;
      // setup_needed says so (the console's two-factor gate). The password is always set: the hub generates it.
      return { username: b.username, csrf, totp_enrolled: u!.totp_secret !== null, role: u!.role, totp_required: users.totpRequired(u!), setup_needed: !users.ready(u!) };
    });
    // Public: whether this browser holds a live session, and nothing else. The console asks it first, so a signed-out start
    // shows the login page without a refused /api/me in the browser's log.
    api.get('/api/session', async (req) => {
      const sid = req.cookies[COOKIE];
      const row = sid ? db.prepare('SELECT s.expires_at, u.status FROM admin_sessions s JOIN admin_users u ON u.id=s.admin_id WHERE s.id_hash=?').get(Buffer.from(sha256Hex(sid), 'hex')) as { expires_at: number; status: string } | undefined : undefined;
      return { signed_in: !!row && row.expires_at >= Date.now() && row.status === 'active' };
    });
    api.get('/api/me', async (req) => {
      const u = req.admin!.user;
      const me = { id: u.id, username: req.admin!.username, csrf: req.admin!.csrf, totp_enrolled: req.admin!.totp, vault_alias: vault.alias, role: u.role, display_name: u.display_name,
        external: !!u.external, org: u.org, expires_at: u.expires_at, totp_required: users.totpRequired(u), setup_needed: !users.ready(u),
        // POST /api/me/password refuses this user: on a demo hub the operator's password is ADMIN_PASSWORD in .env.
        password_locked: passwordLocked(u), password_changed_at: u.password_changed_at ?? null };
      // Members get their grants and decider teams, and no hub URL or demo state (§2).
      // agents: the ones this person owns, with their effective scope, for Account (accountView.ts); no key, machine or secret.
      // Each team adds what the delegation permits there (docs/authorization.md#owner-enforcement), and owner_enforcement
      // says whether the hub enforces it yet.
      if (u.role !== 'admin') {
        const ops = d.ownerScope ? d.ownerScope.scopes(u.id) : new Map<string, Map<string, unknown[]>>();
        const agents = ownedAgents(db, u.id, !!u.external).map((a) => ({ ...a, teams: a.teams.map((t) => ({ ...t, operations: ops.get(a.id)?.get(t.id) ?? [] })) }));
        return { ...me, grants: users.grants(u.id), folder_grants: users.folderGrants(u.id), decider_teams: users.deciderTeams(u.id), deciding_now: d.routing.decidesFor(u.id),
          agents, owner_enforcement: d.ownerScope ? d.ownerScope.enforced() : false };
      }
      return { ...me, public_url: config.publicUrl, demo: !!(config.demoMode && d.demo) };
    });
    /**
     * Any signed-in user replaces their own password: the current one is checked (failures count like sign-ins), the new
     * one follows the password rules, and the user's other sessions end while this one stays.
     */
    api.post('/api/me/password', async (req) => {
      const b = body(z.object({ current: z.string().max(200), new: z.string().max(200) }).strict(), req);
      const me = req.admin!, now = Date.now();
      // On a demo hub the operator's password is ADMIN_PASSWORD in .env, which Replay signs in with.
      if (passwordLocked(me.user))
        throw new KeyError('invalid_state', "On a demo hub the operator's password comes from .env; Replay signs in with it.");
      // Audited like a sign-in (an authentication event) and, since it comes from a signed-in session, as user.password_change_failed too:
      // a wrong current password there points to a stolen session rather than guessing at the sign-in page.
      const failed = (reason: 'invalid' | 'rate_limited') => {
        audit.auth({ subject: 'admin', adminId: me.id, outcome: reason, source: req.ip });
        audit.event({ kind: 'admin', id: me.id, role: me.role }, 'user.password_change_failed', { kind: 'user', id: me.id }, { reason });
      };
      if (loginLimit.blocked(me.username, 'admin_login_fail', now).blocked) {
        failed('rate_limited');
        throw new KeyError('rate_limited', 'Too many failed attempts. Try again later.');
      }
      const u = db.prepare('SELECT * FROM admin_users WHERE id=?').get(me.id) as unknown as UserRow;
      if (!(await verifyPasswordAsync(b.current, u.password_hash))) {
        loginLimit.fail(me.username, 'admin_login_fail', now);
        failed('invalid');
        throw new KeyError('invalid_credentials', 'The current password is wrong.');
      }
      users.setOwnPassword(u, b.new, Buffer.from(sha256Hex(req.cookies[COOKIE]!), 'hex'));
      // The current password was proven: earlier wrong guesses against this username no longer count, including guesses
      // others made at /api/login. They start a fresh count against a new password; the old one no longer works.
      loginLimit.clear(me.username, 'admin_login_fail');
      return { ok: true };
    });
    api.post('/api/logout', async (req, reply) => {
      db.prepare('DELETE FROM admin_sessions WHERE id_hash=?').run(Buffer.from(sha256Hex(req.cookies[COOKIE]!), 'hex'));
      reply.clearCookie(COOKIE, { path: '/' });
      return { ok: true };
    });
    api.post('/api/totp/enroll', async (req) => {
      if (req.admin!.totp) throw new KeyError('conflict', 'TOTP is already enrolled');
      const secret = randomToken(20).slice(0, 32);
      db.prepare('INSERT INTO system_settings(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at')
        .run(`totp_pending:${req.admin!.id}`, JSON.stringify(secret), Date.now());
      const s = secret.toUpperCase();
      return { secret: s, otpauth_uri: `otpauth://totp/Conclave:${encodeURIComponent(req.admin!.username)}?secret=${s}&issuer=Conclave` };
    });
    /** Confirm enrolment with a code. Wrong codes count against the sign-in limit, per user; the confirming code is used up. */
    api.post('/api/totp/confirm', async (req, reply) => {
      const { code } = body(z.object({ code: z.string().max(10) }), req);
      const now = Date.now(), scope = `totp:${req.admin!.id}`;
      if (loginLimit.blocked(scope, 'totp_confirm_fail', now).blocked) return reply.code(429).send({ error: 'rate_limited', message: 'Too many wrong codes. Try again later.' });
      const row = db.prepare('SELECT value FROM system_settings WHERE key=?').get(`totp_pending:${req.admin!.id}`) as { value: string } | undefined;
      if (!row) throw new KeyError('invalid_state', 'start enrolment first');
      const secret = JSON.parse(row.value) as string;
      const step = users.totpStep(secret, code, now);
      if (step === null) { loginLimit.fail(scope, 'totp_confirm_fail', now); throw new KeyError('invalid_argument', 'wrong code'); }
      db.prepare('UPDATE admin_users SET totp_secret=?, totp_last_step=? WHERE id=?').run(secret, step, req.admin!.id);
      db.prepare('DELETE FROM system_settings WHERE key=?').run(`totp_pending:${req.admin!.id}`);
      audit.event(actor(req), 'admin.totp_enrolled', { kind: 'admin', id: req.admin!.id });
      return { ok: true };
    });

    // ───── users ─────
    registerUsersApi(api, users, actor, d.ownerScope, db);
    // ───── decider routing ─────
    // Needs you and For awareness (docs/dashboard-ux.md "Attention words"): one list per viewer; Home reads it whole, a
    // team, a project and Blueprint Review read it filtered, and every entrance counts the same rows.
    const bpRouting = new BpRouting(db, d.blueprint, d.routing);
    // Checkout steps come from the checkout API itself (its needs_operator), read as the signed-in admin.
    const checkoutNeeds = (req: FastifyRequest) => async () => {
      const r = await f.inject({ method: 'GET', url: '/api/checkouts?open=1', headers: { cookie: req.headers.cookie ?? '' } });
      return r.statusCode === 200 ? (r.json() as { checkouts: Awaited<ReturnType<CheckoutNeeds>> }).checkouts : [];
    };
    const needs = (req: FastifyRequest) => new NeedsYou(db, { routing: d.routing, bpRouting, blueprint: d.blueprint, teams: d.teams, onboarding: d.onboarding, attachments: d.taskAttachments, ...(d.checkouts ? { checkouts: checkoutNeeds(req) } : {}) });
    const viewer = (req: FastifyRequest): Viewer => ({ id: req.admin!.id, isAdmin: req.admin!.role === 'admin', can: (pid, c) => !!req.member?.has(pid, c as never) });
    const needsQuery = z.object({ team: z.string().max(100).optional(), project: z.string().max(100).optional(), review: z.enum(['1', 'true']).optional(), cursor: z.string().max(20).optional(), limit: z.coerce.number().int().min(1).max(NEEDS_PAGE_MAX).optional() }).strict();
    api.get('/api/needs-you', async (req) => {
      const q = needsQuery.parse(req.query ?? {}), f = { team: q.team, project: q.project, review: !!q.review }, v = viewer(req);
      const list = await needs(req).list(v, f, { cursor: q.cursor, limit: q.limit });
      return { ...list, awareness: needs(req).awareness(v, f) };
    });
    // A resolving action from any entrance: the row must still wait for this viewer at the version they saw (checked by
    // reading that row's own queue only); then the source workflow's own route runs as this viewer and checks its rights
    // again. The fresh count comes back with it, built once and counted for the entrance the action came from (`filter`).
    const actFilter = z.object({ team: z.string().max(100).optional(), project: z.string().max(100).optional(), review: z.boolean().optional() }).strict();

    api.post('/api/needs-you/act', async (req, reply) => {
      const b = body(z.object({ id: z.string().min(1).max(300), version: z.string().max(100), action: z.string().min(1).max(40), note: z.string().max(2000).optional(), filter: actFilter.optional() }).strict(), req);
      const v = viewer(req), n = needs(req);
      const { act } = await n.check(v, b.id, b.version, b.action);
      const r = await f.inject({ method: 'POST', url: act.path, headers: { cookie: req.headers.cookie ?? '', 'x-csrf-token': req.admin!.csrf, 'content-type': 'application/json' },
        payload: JSON.stringify({ ...(act.body ?? {}), ...(b.note ? { [act.noteAs ?? 'note']: b.note } : {}) }) });
      const total = await n.total(v, b.filter ?? {}), out = sourceReply(r);
      if (r.statusCode >= 400) return reply.code(r.statusCode).send({ ...out, total });
      return { ok: true, result: out, total };
    });
    // One endpoint hides a row for this viewer, by kind: a For awareness row is dismissed for its episode; a Needs you row
    // is set aside with Later (record: the row id, episode: its version) until `until`, or until it changes when `until`
    // is null or left out, and at most 7 days. The wrong kind for the row is refused. Bring back now ends a Later.
    api.post('/api/needs-you/dismiss', async (req) => {
      const b = body(z.object({ record: z.string().min(1).max(300), episode: z.string().max(2000), kind: z.enum(['dismiss', 'later']).optional(), until: z.number().int().positive().nullable().optional() }).strict(), req);
      if (b.kind !== 'later') {
        if (b.until !== undefined) throw new KeyError('invalid_argument', 'A dismissal has no end time; only Later does.');
        await needs(req).dismiss(viewer(req), b.record, b.episode);
        return { ok: true };
      }
      return { ok: true, later: await needs(req).later(viewer(req), b.record, b.episode, b.until ?? null) };
    });
    api.post('/api/needs-you/bring-back', async (req) => {
      const b = body(z.object({ record: z.string().min(1).max(300) }).strict(), req);
      needs(req).bringBack(viewer(req), b.record);
      return { ok: true };
    });
    // The attention settings (off by default): stall warnings per team, missed milestones per project. Audited.
    api.put('/api/teams/:id/attention', async (req) => {
      const b = body(z.object({ stall_warnings: z.boolean() }).strict(), req);
      if (!db.prepare('UPDATE teams SET stall_warnings=? WHERE id=?').run(b.stall_warnings ? 1 : 0, idOf(req)).changes) throw new KeyError('not_found', 'team not found');
      audit.event(actor(req), 'team.attention', { kind: 'team', id: idOf(req) }, { stall_warnings: b.stall_warnings });
      // Switched off: its open stalled-member alerts have nothing left to say (Auditing → Alerts no longer lists them).
      if (!b.stall_warnings) { audit.settle('stalled_member'); d.teams.forgetStalls(idOf(req)); }
      return { stall_warnings: b.stall_warnings };
    });
    api.put('/api/projects/:id/attention', async (req) => {
      const b = body(z.object({ missed_warnings: z.boolean() }).strict(), req);
      if (!db.prepare('UPDATE projects SET missed_warnings=? WHERE id=?').run(b.missed_warnings ? 1 : 0, idOf(req)).changes) throw new KeyError('not_found', 'project not found');
      audit.event(actor(req), 'project.attention', { kind: 'project', id: idOf(req) }, { missed_warnings: b.missed_warnings });
      return { missed_warnings: b.missed_warnings };
    });
    api.get('/api/teams/:id/deciders', async (req) => d.routing.view(idOf(req)));
    api.put('/api/teams/:id/deciders', async (req) => {
      const b = z.object({
        user_ids: z.array(z.string().max(100)).max(50),
        ceiling: z.object({ actions: z.array(z.enum(CEILING_ACTIONS as [string, ...string[]])).min(1).max(20).optional(), folders: z.array(z.string().max(1024)).min(1).max(50).nullable().optional(), max_hours: z.number().int().optional() }).nullable().optional(),
      }).parse(req.body ?? {});
      return d.routing.setDeciders(idOf(req), b.user_ids, b.ceiling, actor(req));
    });

    // ───── PCs and agents ─────
    api.post('/api/pcs', async (req) => {
      const b = body(z.object({ name: z.string(), description: z.string().nullable().optional() }), req);
      return { pc: keys.createMachine(b.name, b.description ?? null, actor(req)) };
    });
    // A PC is known by its id, so a new name touches nothing else (docs/dashboard-ux.md, the PC page).
    api.patch('/api/pcs/:id', async (req) => {
      const b = body(z.object({ name: z.string().max(200) }), req);
      return { pc: keys.renameMachine(idOf(req), b.name, actor(req)) };
    });
    api.post('/api/pcs/:id/suspend', async (req) => { keys.setMachineStatus(idOf(req), 'suspended', actor(req)); return { pc: keys.machine(idOf(req)) }; });
    api.post('/api/pcs/:id/reactivate', async (req) => {
      // After Disconnect only Re-enrol PC brings the PC back (docs/connector.md).
      if (d.connector?.disconnected(idOf(req))) throw new KeyError('invalid_state', 'This PC was disconnected from this hub; use Re-enrol PC to bring it back.');
      keys.setMachineStatus(idOf(req), 'active', actor(req)); return { pc: keys.machine(idOf(req)) };
    });

    api.get('/api/agents', async (req) => {
      if (!req.member) return { agents: keys.agents() };
      // Members (§2): agents of granted teams with tasks; label, role and status, no credential, PC or key fields.
      const ids = req.member.agents('tasks');
      return { agents: keys.agents().filter((a) => ids.has(a.id)).map((a) => ({ id: a.id, label: a.label, role: a.role, status: a.status })) };
    });
    // owner_id: the console user who owns the agent (docs/authorization.md#agent-owners); the admin names it, never the hub.
    const ownerId = z.string().min(1).max(100).nullable().optional();
    api.post('/api/agents', async (req) => {
      const b = body(z.object({ label: z.string().min(1).max(80), project: z.string().nullable().optional(), owner_id: ownerId }), req);
      return { agent: keys.createAgent(b.label, b.project ?? null, actor(req), b.owner_id ?? null) };
    });
    api.patch('/api/agents/:id', async (req) => {
      const b = body(z.object({ label: z.string().min(1).max(80).optional(), project: z.string().nullable().optional(), role: z.string().max(80).nullable().optional(), role_detail: z.string().max(500).nullable().optional(), owner_id: ownerId }), req);
      const { owner_id, ...rest } = b;
      // A rename and an owner change in one request land together or not at all.
      return tx(db, () => {
        if (owner_id !== undefined) keys.setOwner(idOf(req), owner_id, actor(req));
        return { agent: Object.keys(rest).length || owner_id === undefined ? keys.updateAgent(idOf(req), rest, actor(req)) : keys.agent(idOf(req)) };
      });
    });
    // A person's agents: listed on their page, and handed to another person in one audited step (before or after they are disabled).
    api.get('/api/agent-owners/:id/agents', async (req) => ({ agents: keys.ownedBy(idOf(req)) }));
    api.post('/api/agent-owners/:id/reassign', async (req) => {
      const b = body(z.object({ to: z.string().min(1).max(100) }).strict(), req);
      return { ...keys.reassignOwner(idOf(req), b.to, actor(req)), ...ownersView() };
    });
    // Agent owners: the claim step for the agents that existed before owners, and the owner enforcement setting.
    const ownersView = () => {
      const claim = keys.ownerClaim(), by = claim ? db.prepare('SELECT username, display_name FROM admin_users WHERE id=?').get(claim.by) as { username: string; display_name: string | null } | undefined : undefined;
      return { claim: claim ? { ...claim, by_label: by ? by.display_name || by.username : null } : null, enforcement: keys.ownerEnforcement(), unowned: keys.unownedCount() };
    };
    api.get('/api/agent-owners', async () => ownersView());
    api.post('/api/agent-owners/claim', async (req) => { const c = keys.claimUnowned(actor(req)); return { claimed: c.agents, ...ownersView() }; });
    api.put('/api/agent-owners/enforcement', async (req) => {
      keys.setOwnerEnforcement(body(z.object({ on: z.boolean() }).strict(), req).on, actor(req));
      return ownersView();
    });

    // ───── keys ─────
    const view = (c: Credential) => {
      const agent = c.agent_id ? keys.agent(c.agent_id) : null, pc = c.machine_id ? keys.machine(c.machine_id) : null;
      const bound = c.bound_machine_id ? keys.machine(c.bound_machine_id) : null;
      return {
        bound_pc: bound ? { id: bound.id, name: bound.name, status: bound.status } : null,
        ...c, effective_status: keys.effectiveStatus(c), masked_key: `ah_${c.kind === 'app_key' ? 'app' : 'ses'}_${c.key_id}_…`,
        agent: agent ? { id: agent.id, label: agent.label, role: agent.role } : null, pc: pc ? { id: pc.id, name: pc.name, status: pc.status } : null,
        live_logins: keys.liveLogins({ credentialId: c.id }).length,
      };
    };
    api.get('/api/keys', async (req) => {
      const q = req.query as { kind?: string; status?: string; pc?: string; agent?: string };
      let list = keys.credentials({ kind: q.kind === 'app_key' || q.kind === 'session_key' ? q.kind : undefined, agentId: q.agent, machineId: q.pc }).map(view);
      if (q.status) list = list.filter((c) => c.effective_status === q.status);
      return { keys: list };
    });
    api.post('/api/keys', async (req) => {
      const b = body(z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('session_key'), agent_id: z.string().optional(), new_agent: z.object({ label: z.string().min(1), project: z.string().nullable().optional(), owner_id: ownerId }).optional(),
          label: z.string().min(1).max(120), template_id: z.string().nullable().optional(), expires_at: ts,
          // Bind the new key to this PC at once (the PC page's "New session key"); omitted or null: a free key.
          machine_id: z.string().min(1).nullable().optional() }),
        z.object({ kind: z.literal('app_key'), machine_id: z.string(), app_name: z.string().min(1).max(60), label: z.string().optional() }),
      ]), req);
      if (b.kind === 'app_key') {
        const r = keys.createAppKey({ machineId: b.machine_id, appName: b.app_name, label: b.label }, actor(req));
        const url = `${config.publicUrl}/mcp`;
        return {
          key: view(r.credential), secret: r.secret,
          setup: {
            claude_code: `claude mcp add --transport http agent-hub ${url} --header "Authorization: Bearer ${r.secret}"`,
            codex_env: `AGENT_HUB_APP_KEY=${r.secret}`,
            codex_config_toml: `[mcp_servers.agent_hub]\nurl = "${url}"\nbearer_token_env_var = "AGENT_HUB_APP_KEY"\nstartup_timeout_sec = 20\ntool_timeout_sec = 300`,
          },
        };
      }
      if (!b.agent_id && !b.new_agent) throw new KeyError('invalid_argument', 'agent_id or new_agent is required');
      // Checked before a new agent is made, so a bad PC leaves no agent behind.
      const pc = b.machine_id ? keys.machine(b.machine_id) : null;
      if (b.machine_id && !pc) throw new KeyError('not_found', 'PC not found');
      if (pc?.status === 'retired') throw new KeyError('invalid_state', 'a key cannot be bound to a retired PC');
      const agentId = b.agent_id ?? keys.createAgent(b.new_agent!.label, b.new_agent!.project ?? null, actor(req), b.new_agent!.owner_id ?? null).id;
      return tx(db, () => {
        const r = keys.createSessionKey({ agentId, label: b.label, expiresAt: b.expires_at, templateId: b.template_id, machineId: b.machine_id ?? null }, actor(req));
        // A key for a PC that runs the connector reaches it by key handover: its secret is never shown, and it works from confirm on.
        const h = d.handovers?.rotate(r.credential.id, actor(req), null) ?? null;
        if (h) { keys.blankSecret(r.credential.id, 'handover'); return { key: view(keys.credential(r.credential.id)!), handover: h }; }
        return keyPrompt(r, 'new', actor(req));
      });
    });
    api.get('/api/keys/:id', async (req) => {
      const c = cred(idOf(req));
      return { key: view(c), policy_version: keys.policyVersion(c.policy_id), logins: keys.liveLogins({ credentialId: c.id }), handover: d.handovers?.open(c.id) ?? null };
    });
    for (const [path, fn] of [
      ['suspend', (id: string, a: Actor) => keys.setStatus(id, 'suspended', 'admin', a)],
      ['reactivate', (id: string, a: Actor) => keys.setStatus(id, 'active', null, a)],
      ['revoke', (id: string, a: Actor) => keys.setStatus(id, 'revoked', 'admin', a)],
    ] as const) {
      api.post(`/api/keys/:id/${path}`, async (req) => ({ key: view(fn(idOf(req), actor(req))) }));
    }
    api.post('/api/keys/:id/rotate', async (req) => {
      // Rotate secret, and Make a new prompt for a key that never logged in: the same act. A session key whose PC runs the
      // connector is rotated by key handover (docs/onboarding.md#key-handover-a-rotated-key-or-a-recruit-reaches-a-connector-pc):
      // nothing changes until the PC confirms, and the answer is the open handover. Any other key is rotated now and its raw
      // key shown once. reason: could the key have leaked.
      const b = body(z.object({ reason: z.enum(['routine', 'suspected_leak']).optional(), relay_id: z.string().nullable().optional() }), req);
      const old = cred(idOf(req));
      return tx(db, () => {
        const h = old.kind === 'session_key' ? d.handovers?.rotate(old.id, actor(req), b.reason ?? null) ?? null : null;
        if (h) {
          // After a possible leak the PC's connector app key was replaced: its new pairing code is answered here once.
          const { pairing: p, ...ho } = h;
          const ca = d.clientFiles?.ca(), hub = d.onboarding.hubInfo();
          return { key: view(keys.credential(old.id)!), handover: ho, ...(p ? { pairing: { code: p.code, code_expires_at: Date.now() + PAIRING_MS, ca_check: ca ? caCheck(ca.sha256) : null, hub_origin: hub.origin ?? null, pc: ho.pc } } : {}) };
        }
        const r = keys.rotate(old.id, actor(req), { reason: b.reason ?? null, delivery: old.kind === 'session_key' ? 'shown' : 'prompt' });
        return r.credential.kind === 'session_key' ? keyPrompt(r, old.first_used_at ? 'rotated' : 'reissued', actor(req)) : { key: view(r.credential), secret: r.secret };
      });
    });
    // The key's handover for its page: the open one (Waiting for the PC user), the PC a rotation would go to (target: null
    // means the raw key is shown once), and a rotation confirmed in the last 24 hours.
    api.get('/api/keys/:id/handover', async (req) => {
      const c = cred(idOf(req));
      return { handover: d.handovers?.open(c.id) ?? null, target: d.handovers?.target(c.id) ?? null, confirmed: d.handovers?.confirmed(c.id) ?? null, not_on_pc: d.handovers?.notOnPc(c.id) ?? null, leak_unfinished: d.handovers?.leakUnfinished(c.id) ?? false };
    });
    // Cancel: nothing changes on the key; the old key goes on working.
    api.post('/api/keys/:id/handover/cancel', async (req) => {
      const c = cred(idOf(req));
      const h = d.handovers?.open(c.id) ?? null;
      if (!h) throw new KeyError('invalid_state', 'This key has no open handover.');
      d.handovers!.cancel(h.id, 'operator', actor(req));
      return { key: view(keys.credential(c.id)!), handover: null };
    });
    api.post('/api/keys/:id/end-logins', async (req) => ({ ended: keys.endLogins(idOf(req), actor(req)) }));
    // PC binding: {machine_id} binds a session key to that PC, {machine_id: null} makes it free.
    api.put('/api/keys/:id/binding', async (req) => {
      const b = body(z.object({ machine_id: z.string().min(1).nullable() }), req);
      return { key: view(keys.setBinding(idOf(req), b.machine_id, actor(req))) };
    });
    api.patch('/api/keys/:id', async (req) => {
      const b = body(z.object({ expires_at: ts }), req);
      return { key: view(keys.setExpiry(idOf(req), b.expires_at, actor(req))) };
    });
    api.put('/api/keys/:id/live-limit', async (req) => {
      const b = body(z.object({ max_live_sessions: z.number().int().min(1).max(500) }), req);
      return { key: view(keys.setLiveLimit(idOf(req), b.max_live_sessions, actor(req))) };
    });
    api.get('/api/keys/:id/rules', async (req) => { const c = cred(idOf(req)); return { rules: keys.rules(c.policy_id), version: keys.policyVersion(c.policy_id) }; });
    api.put('/api/keys/:id/rules', async (req) => {
      const b = body(z.object({ rules: z.array(ruleSchema), note: z.string().nullable().optional() }), req);
      const c = cred(idOf(req));
      const version = keys.setRules(c.policy_id, checkRules(b.rules), b.note ?? null, actor(req));
      return { rules: keys.rules(c.policy_id), version };
    });
    api.get('/api/keys/:id/versions', async (req) => ({ versions: keys.versions(cred(idOf(req)).policy_id) }));
    api.post('/api/keys/:id/rollback', async (req) => {
      const b = body(z.object({ version: z.number().int() }), req);
      const c = cred(idOf(req));
      return { version: keys.rollback(c.policy_id, b.version, actor(req)), rules: keys.rules(c.policy_id) };
    });
    api.post('/api/keys/:id/apply-template', async (req) => {
      const b = body(z.object({ template_id: z.string() }), req);
      const c = cred(idOf(req));
      return { version: keys.applyTemplate(c.id, b.template_id, actor(req)), rules: keys.rules(c.policy_id) };
    });
    // The access inspector shows the owner ceilings (docs/authorization.md#owner-enforcement): whose grant caps the agent,
    // why (its own owner, or work handed over by another owner's agent), and the operations each one allows.
    const withCeilings = (c: { agent_id: string | null }, cap: Rule[]): Cap => (d.ownerScope && c.agent_id ? d.ownerScope.cap(c.agent_id, cap) : cap);
    // A task ceiling names the task (title, status, team and its originating owner, for the inspector) and how its owner is involved (via).
    // The team lets the console open the task: its route needs both the team and the task.
    const taskRef = (id: string | undefined) => {
      if (!id) return null;
      const t = db.prepare('SELECT id, title, status, team_id, origin_owner_id o FROM tasks WHERE id=?').get(id) as { id: string; title: string; status: string; team_id: string | null; o: string | null } | undefined;
      if (!t) return { id, title: null, status: null, team_id: null, origin_owner: null };
      return { id: t.id, title: t.title, status: t.status, team_id: t.team_id, origin_owner: t.o && d.ownerScope ? d.ownerScope.label(t.o) : null };
    };
    /** The key's tools as the Tools tab shows them: base tools always, default tools unless denied, the rest by rule. */
    function effectiveTools(c: Credential, capCred: Credential | null = null): { tool: string; allowed: boolean; reason: string; source?: unknown }[] {
      const rules = keys.rules(c.policy_id), cap = withCeilings(c, capCred ? keys.rules(capCred.policy_id) : []);
      return [...BASE_TOOLS, ...DEFAULT_TOOLS, ...GRANTED_TOOLS].map((t) => {
        if ((BASE_TOOLS as readonly string[]).includes(t)) return { tool: t, allowed: true, reason: 'always available when logged in' };
        if ((DEFAULT_TOOLS as readonly string[]).includes(t)) {
          const no = explicitlyDenied(rules, cap, 'tool.invoke', `tool:${t}`);
          return { tool: t, allowed: !no, reason: no ? 'refused by an explicit deny rule' : 'on by default for every logged-in session' };
        }
        const dec = authorize(rules, cap, 'tool.invoke', `tool:${t}`);
        return { tool: t, allowed: dec.allowed, reason: dec.reason, source: dec.source };
      });
    }
    /**
     * A session key's key prompt (docs/onboarding.md#key-prompts-a-new-rotated-or-reissued-session-key). A known PC gets a
     * single-use pickup code and the key's secret is made at pickup, so it never leaves the hub here; a free key with no PC
     * gets its raw key, the one accepted exception. `handoff` is the prompt text, for the screens that only show text.
     */
    function keyPrompt(r: { credential: Credential; secret: string }, reason: 'new' | 'rotated' | 'reissued', _a: Actor) {
      const t = keys.keyTarget(r.credential.id), c = keys.credential(r.credential.id)!;
      const agent = keys.agent(c.agent_id!)?.label ?? c.label;
      // The login and work-loop tools every session has are left out: the line says what the rules decide, for this key on
      // the PC it is sent to, the way a real call decides (mcp/tools.ts): the key's rules with its temporary grants, capped by
      // that PC's app key (the client's, else the newest active one) with the owner ceilings. task_list is decided the same
      // way: team rules give it, so a team member that a deny rule or the app key refuses is not told it has it.
      const capApp = t.pc ? db.prepare(`SELECT id FROM credentials WHERE kind='app_key' AND machine_id=? AND status='active' AND (expires_at IS NULL OR expires_at>?)
        ORDER BY (app_name=?) DESC, created_at DESC LIMIT 1`).get(t.pc.id, Date.now(), t.client_app ?? '') as { id: string } | undefined : undefined;
      const rules = keys.rulesFor(c.id), cap = withCeilings(c, capApp ? keys.rulesFor(capApp.id) : []);
      const tools = toolsLine([...DEFAULT_TOOLS, ...GRANTED_TOOLS, 'task_list'].map((tool) => ({ tool,
        allowed: (DEFAULT_TOOLS as readonly string[]).includes(tool) ? !explicitlyDenied(rules, cap, 'tool.invoke', `tool:${tool}`) : authorize(rules, cap, 'tool.invoke', `tool:${tool}`).allowed })));
      const text = secretPrompt({ secret: r.secret, agent, tools, reason });
      return { key: view(c), secret: r.secret, prompt: { text, mode: 'secret' as const, pc: null, session_var: t.session_var, client: clientOf(t.client_app) }, handoff: text };
    }
    const ceilingsView = (cap: Cap) => cap.owners ? cap.owners.map((l) => ({ owner_id: l.owner, owner: l.label, basis: l.basis, task_id: l.task ?? null, task: taskRef(l.task), via: l.via ?? null, allows: l.rules.filter((r) => r.effect === 'allow').map((r) => ({ actions: r.actions, resource: r.resource })), denies: l.rules.filter((r) => r.effect === 'deny').map((r) => ({ actions: r.actions, resource: r.resource })) })) : null;
    api.get('/api/keys/:id/effective', async (req) => {
      const c = cred(idOf(req));
      const q = req.query as { app_key_id?: string };
      const rules = keys.rules(c.policy_id);
      const capCred = q.app_key_id ? cred(q.app_key_id) : null;
      const cap = withCeilings(c, capCred ? keys.rules(capCred.policy_id) : []);
      const tools = effectiveTools(c, capCred);
      const folders = (await vault.list([])).filter((e) => e.type === 'folder').map((e) => ({
        path: e.path, list: canReach(rules, cap, 'fs.list', e.path), read: canReach(rules, cap, 'fs.read', e.path),
      }));
      const root = `/${vault.alias}`;
      return { rules, app_key_cap: [...cap], owner_ceilings: ceilingsView(cap), tools, folders, root: { path: root, list: canReach(rules, cap, 'fs.list', root), read: canReach(rules, cap, 'fs.read', root) } };
    });

    api.post('/api/simulate', async (req) => {
      const b = body(z.object({ credential_id: z.string(), app_credential_id: z.string().nullable().optional(), action: z.string(), resource: z.string() }), req);
      const c = cred(b.credential_id), app = b.app_credential_id ? cred(b.app_credential_id) : null;
      const resource = withSlash(b.resource);
      try { parseResource(resource); } catch (e) { throw new KeyError('invalid_argument', (e as Error).message); }
      const cap = withCeilings(c, app ? keys.rules(app.policy_id) : []);
      const decision = authorize(keys.rules(c.policy_id), cap, b.action, resource);
      return { decision: decision.owner ? { ...decision, owner: { owner_id: decision.owner.owner, owner: decision.owner.label, basis: decision.owner.basis, task: taskRef(decision.owner.task), via: decision.owner.via ?? null } } : decision, owner_ceilings: ceilingsView(cap) };
    });

    registerPhase2(api, { db, keys, setup: d.setup, links: d.links, config, audit, connector: d.connector }, actor);
    if (d.connector) registerConnectorApi(api, { keys, connector: d.connector, messaging: d.messaging }, actor);
    if (d.vaultSync) registerVaultSyncApi(api, { sync: d.vaultSync }, actor);
    registerPhase3(api, { db, keys, messaging: d.messaging }, actor);
    registerTeams(api, { db, keys, teams: d.teams, routing: d.routing, openPart: (id, a, o) => { d.blueprint.openTeamPart(id, { kind: 'operator', id: a.id }, o); }, setupOf: (id) => d.onboarding.setupOfTeam(id), attachments: d.taskAttachments, teamStart: d.connector ? new TeamStart(d.teams, keys, d.connector, audit) : undefined }, actor);
    if (d.taskAttachments) registerAttachmentApi(api, { attachments: d.taskAttachments, store: d.store });
    registerMemberBoard(api, { db, keys, teams: d.teams, attachments: d.taskAttachments });
    registerWorkFeed(api, { db });
    registerPhase5(api, { db, keys, audit, routing: d.routing, ...d.phase5 }, actor);
    registerGraphAdmin(api, { db, audit, graph: d.graph }, actor);
    registerVaultApi(api, { db, keys, audit, vault, store: d.store }, actor);
    registerVaultLinksApi(api, { vault });
    registerVaultWriteApi(api, { db, audit, vault, store: d.store }, actor);
    registerResetApi(api, { db, audit, config, loginLimit, users, maintenance: d.phase5.maintenance }, actor);
    if (d.phase5.maintenance.health) registerDbHealthApi(api, { db, audit, loginLimit, users, health: d.phase5.maintenance.health }, actor);
    if (config.demoMode && d.demo) registerDemoApi(api, { demo: d.demo, audit }, actor);
    registerTelemetryApi(api, { db, audit }, actor);
    registerFeedbackApi(api, { feedback: d.feedback }, actor);
    registerHardwareApi(api, { hardware: d.hardware }, actor);
    registerDirectivesApi(api, { directives: d.directives }, actor);
    registerOnboardingApi(api, { keys, onboarding: d.onboarding, files: d.clientFiles, config, connector: d.connector, relays: d.relays }, actor);
    if (d.relays) registerRelayApi(api, { relays: d.relays }, actor);
    if (d.checkouts && d.checkoutKeys) registerCheckoutApi(api, { checkouts: d.checkouts, checkoutKeys: d.checkoutKeys, delegations: d.delegations, teams: d.teams, label: (a) => keys.agent(a)?.label ?? a,
      restoreNow: d.connector ? (id, who) => d.connector!.restoreIfOneDestination(id, who) : undefined }, actor);
    if (d.mirror) registerMirrorApi(api, d.mirror, actor);
    registerDecisionsApi(api, { db, decisions: d.decisions, teams: d.teams, vault, routing: d.routing, blueprint: d.blueprint, keys, attachments: d.taskAttachments, store: d.store }, actor);
    const bpSources = new Sources(db, vault);
    registerBlueprintApi(api, { db, blueprint: d.blueprint, teams: d.teams, routing: d.routing, bpRouting, sources: bpSources, meetings: new Meetings(db, vault, bpSources) }, actor);

    // ───── templates ─────
    api.get('/api/templates', async () => ({ templates: keys.templates() }));
    api.post('/api/templates', async (req) => {
      const b = body(z.object({ name: z.string().min(1).max(60), description: z.string().nullable().optional(), rules: z.array(ruleSchema) }), req);
      return { id: keys.createTemplate(b.name, b.description ?? null, checkRules(b.rules), actor(req)) };
    });

    // ───── audit ─────
    const limit = (req: FastifyRequest, max = 200) => Math.min(max, Math.max(1, Number((req.query as { limit?: string }).limit ?? 200) || 200));
    api.get('/api/audit', async (req) => {
      const t = (req.query as { target?: string }).target;
      const rows = t ? db.prepare('SELECT * FROM audit_events WHERE target_id=? ORDER BY id DESC LIMIT ?').all(t, limit(req)) : db.prepare('SELECT * FROM audit_events ORDER BY id DESC LIMIT ?').all(limit(req));
      return { events: rows };
    });
    /** since (epoch ms) bounds the window, so "calls in the last hour" counts more than the latest 200 rows (up to 2000). */
    /**
     * A denied call stays denied in the record, but the console should not present it as an open problem once the
     * access was granted. For denied calls on a vault path (the hub logged the refused action and path), re-check
     * that action against the key's current rules and app key cap: now_allowed says it would pass today, and
     * access_changed_at is when the key's rules last changed (or a temporary grant was made).
     */
    const nowAllowed = (rows: Record<string, unknown>[]) => {
      const ev = db.prepare("SELECT action, path FROM resource_access_events WHERE credential_id=? AND decision='deny' AND created_at BETWEEN ? AND ? ORDER BY ABS(created_at-?) LIMIT 1");
      const rulesOf = new Map<string, Rule[]>(), changedOf = new Map<string, number | null>();
      const rules = (id: string) => { if (!rulesOf.has(id)) rulesOf.set(id, keys.rulesFor(id)); return rulesOf.get(id)!; };
      const changed = (credId: string) => {
        if (!changedOf.has(credId)) {
          const c = keys.credential(credId);
          const pv = c ? (db.prepare('SELECT MAX(created_at) t FROM policy_versions WHERE policy_id=?').get(c.policy_id) as { t: number | null }).t : null;
          const tg = (db.prepare('SELECT MAX(created_at) t FROM temporary_grants WHERE credential_id=? AND revoked_at IS NULL').get(credId) as { t: number | null }).t;
          changedOf.set(credId, Math.max(pv ?? 0, tg ?? 0) || null);
        }
        return changedOf.get(credId)!;
      };
      let checked = 0;
      return rows.map((r) => {
        if (r.result !== 'denied' || typeof r.credential_id !== 'string' || checked >= 300) return r;
        checked++;
        const at = Number(r.created_at), e = ev.get(r.credential_id, at - 5000, at + 5000, at) as { action: string; path: string } | undefined;
        if (!e) return r;
        const c = keys.credential(r.credential_id);
        if (!c || keys.effectiveStatus(c) !== 'active') return { ...r, now_allowed: false };
        const cap = typeof r.app_credential_id === 'string' ? rules(r.app_credential_id) : [];
        const ok = authorize(rules(r.credential_id), cap, e.action, `path:${e.path}`).allowed;
        return { ...r, now_allowed: ok, denied_action: e.action, denied_path: e.path, ...(ok ? { access_changed_at: changed(r.credential_id) } : {}) };
      });
    };
    api.get('/api/invocations', async (req) => {
      const q = req.query as { credential?: string; since?: string };
      const since = Number(q.since ?? 0) || 0, n = limit(req, 2000);
      const rows = q.credential
        ? db.prepare('SELECT * FROM tool_invocations WHERE credential_id=? AND created_at>=? UNION SELECT * FROM tool_invocations WHERE app_credential_id=? AND created_at>=? ORDER BY created_at DESC LIMIT ?').all(q.credential, since, q.credential, since, n)
        : db.prepare('SELECT * FROM tool_invocations WHERE created_at>=? ORDER BY created_at DESC LIMIT ?').all(since, n);
      return { invocations: nowAllowed(rows as Record<string, unknown>[]) };
    });
    api.get('/api/alerts', async (req) => {
      const { credential: c, status } = req.query as { credential?: string; status?: string };
      const rows = db.prepare('SELECT * FROM security_alerts WHERE (? IS NULL OR subject=?) AND (? IS NULL OR status=?) ORDER BY created_at DESC LIMIT ?').all(c ?? null, c ?? null, status ?? null, status ?? null, limit(req));
      return { alerts: rows };
    });
  });
  return routes;
}
