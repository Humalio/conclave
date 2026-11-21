/**
 * The connector's routes (docs/connector.md, "Hub route contract"): check-in, orders, Disconnect's receipt, the messages it
 * reports shown, usage and the approved versions. The PC's app key authenticates them; during the transition the PC's
 * bridge key is accepted for check-in only. The disconnect routes take only that order's receipt credential.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { KeyError } from '../keys/keys.js';
import type { Keys } from '../keys/keys.js';
import type { Setup } from '../setup/setup.js';
import type { Db } from '../db/db.js';
import type { Hardware } from '../hardware/hardware.js';
import { SAMPLE_MAX } from '../hardware/hardware.js';
import { LONG_POLL_MAX_S } from './stream.js';
import { Connector, CLIENTS, DELIVER_REASONS, WAKE_STATES, ISOLATION, LEFTOVER_KIND_WORDS, KEY_STORES, DESTINATION_RE, PC_REPORTED, RESET_RESULT_CODES, VERSION_RE } from './connector.js';

const STATUS: Record<string, number> = { invalid_argument: 400, contains_key: 400, forbidden: 403, not_found: 404, conflict: 409, invalid_state: 409, lockdown: 423 };
const version = z.string().max(40).regex(VERSION_RE);
const short = (n: number) => z.string().max(n).nullable().optional();
const tokens = z.number().int().min(0).max(100_000_000);
const when = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable();
const ContextRow = z.object({
  agent_id: z.string().max(100), source: z.enum(['connector', 'chat']), client: z.enum(CLIENTS), model: z.string().max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,99}$/),
  context_tokens: tokens, window: tokens.nullable(), percent: z.number().int().min(0).max(1000).nullable().optional(), turn_tokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  compacted_at: when, compacts: z.number().int().min(0).max(1_000_000), at: when,
}).strict();
const SkipBody = z.object({ reason: z.enum(['key_not_held', 'folder_refused']) }).strict();
const CheckInBody = z.object({
  version, platform: short(40), node: short(40), git: short(40),
  clients: z.array(z.object({ client: z.enum(CLIENTS), version: z.string().max(40).nullable() }).strict()).max(10).optional(),
  auto_update: z.boolean().nullable().optional(), remote_cleanup: z.boolean().nullable().optional(),
  remove_connector_with_last_hub: z.boolean().nullable().optional(), usage_opt_in: z.boolean().nullable().optional(),
  hardware_opt_in: z.boolean().nullable().optional(),
  isolation: z.enum(ISOLATION).nullable().optional(), key_store: z.enum(KEY_STORES).nullable().optional(),
  // Only a yes or no: the PC never says which pieces or where.
  legacy_leftovers: z.boolean().nullable().optional(),
  // Which kinds, as fixed words: still no path or name.
  legacy_leftover_kinds: z.array(z.enum(LEFTOVER_KIND_WORDS)).max(4).nullable().optional(),
  agents: z.array(z.object({ agent_id: z.string().max(100), state: z.enum(PC_REPORTED), profile: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/).optional(), profile_hidden: z.literal(true).optional() }).strict()).max(200).optional(),
  // Restore destinations the PC's user approved: an id and a plain label, never a path.
  destinations: z.array(z.object({ id: z.string().regex(DESTINATION_RE), label: z.string().min(1).max(80) }).strict()).max(20)
    .refine((d) => new Set(d.map((x) => x.id)).size === d.length, 'destination ids must be unique').optional(),
  // How full each agent's context is (design 3c): numbers and a model id only, never text.
  context: z.array(ContextRow).max(100).optional(),
}).strict();
const line = z.string().max(200);
/** A restore's result: a reason when it failed, and the line that starts each restored agent (a PC's own folder in it). */
const RestoreResult = z.object({ reason: line.optional(), start_lines: z.array(z.string().max(400)).max(40).optional() }).strict();
/** A delivery order's result: done means a turn started; failed carries the fixed code (and its sentence) for why none did. */
// team_paused: Stop team dropped the waiting work (docs/connector.md, "Reason orders"); it is not a delivery state of a task turn.
const DeliverResult = z.object({ reason: line.optional(), code: z.enum([...DELIVER_REASONS, ...RESET_RESULT_CODES, 'team_paused']).optional() }).strict();
const CheckResult = z.object({ checks: z.array(z.object({ name: z.string().max(100), ok: z.boolean(), detail: line.optional() }).strict()).max(40) }).strict();
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export function registerConnector(f: FastifyInstance, db: Db, connector: Connector, keys: Keys, setup: Setup, directives?: { unreadIds(agentId: string): string[] }, hardware?: Hardware): void {
  const refuse = (reply: FastifyReply) => reply.code(401).header('www-authenticate', 'Bearer').send({ error: 'unauthorized', message: 'Invalid key, or the PC is suspended.' });
  const bearer = (req: FastifyRequest) => /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''))?.[1] ?? null;
  /**
   * The PC behind the app key (or bridge key): `{pc}`, or `{refused, disconnected?}`. A key whose secret is right but whose
   * PC was suspended by Disconnect gets that order's receipt credential instead, and nothing else.
   */
  const pcOf = (req: FastifyRequest, bridge: boolean): { pc: string; credential?: string } | { refused: true; receipt?: string } => {
    const k = bearer(req);
    if (!k) return { refused: true };
    try {
      if (k.startsWith('ah_app_')) { const c = keys.verifyKey(k, 'app_key'); return c.machine_id ? { pc: c.machine_id, credential: c.id } : { refused: true }; }
      // The bridge key: check-in only, and never handed a receipt.
      if (k.startsWith('ah_brg_')) return bridge ? { pc: setup.verifyBridgeKey(k).machine.id } : { refused: true };
    } catch (e) {
      if (!(e instanceof KeyError)) throw e;
      // Thrown only after the secret matched: the key is genuine, its PC is not active.
      if (e.code === 'suspended' && k.startsWith('ah_app_')) {
        const pc = suspendedPc(k);
        const r = pc ? connector.issueReceipt(pc) : null;
        if (r) return { refused: true, receipt: r };
      }
    }
    return { refused: true };
  };
  const suspendedPc = (k: string): string | null => {
    const app = /^ah_app_([a-z2-7]{12})_/.exec(k);
    return app ? (db.prepare("SELECT machine_id FROM credentials WHERE key_id=? AND kind='app_key'").get(app[1]!) as { machine_id: string | null } | undefined)?.machine_id ?? null : null;
  };
  const run = async (reply: FastifyReply, fn: () => unknown) => {
    try { return await fn(); }
    catch (e) {
      if (e instanceof z.ZodError) return reply.code(400).send({ error: 'invalid_argument', message: e.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
      if (e instanceof KeyError && STATUS[e.code]) return reply.code(STATUS[e.code]!).send({ error: e.code, message: e.message });
      throw e;
    }
  };
  const withPc = (fn: (pc: string, req: FastifyRequest, credential: string | null) => unknown, bridge = false) => async (req: FastifyRequest, reply: FastifyReply) => {
    const who = pcOf(req, bridge);
    if ('refused' in who) {
      if (who.receipt) return reply.code(401).send({ error: 'disconnected', message: 'This hub was disconnected from this PC. Fetch the cleanup order with the receipt credential.', receipt: who.receipt, disconnect_url: '/connector/v1/disconnect' });
      return refuse(reply);
    }
    return run(reply, () => fn(who.pc, req, who.credential ?? null));
  };

  f.post('/connector/v1/check-in', withPc((pc, req, cred) => connector.checkIn(pc, CheckInBody.parse(req.body ?? {}), cred), true));
  // Key handovers waiting for this app key (docs/connector.md, "Receiving a rotated key or a recruit"): descriptions and public key ids, no secret.
  // The app key only: a bridge key or a turn token gets nothing here.
  f.get('/connector/v1/handovers', withPc((pc, _req, cred) => {
    const app = cred ? keys.credential(cred) : null;
    // Under a lockdown of all writes or of this PC the list is refused like the pickup (423), not answered empty.
    if (connector.handoversLocked?.(pc) || connector.isLocked(pc)) throw new KeyError('lockdown', 'Key handovers are locked down by the administrator; nothing is listed until the lockdown is lifted.');
    if (!app || !connector.handovers) return { handovers: [] };
    return { handovers: connector.handovers.list(app) };
  }));
  // The connector cannot take a handover: the PC does not hold the key being rotated, or a recruit's folder broke the rules.
  // The hub cancels it at once (not_on_pc or folder_refused), so the operator sees why instead of waiting 24 hours.
  f.post('/connector/v1/handovers/:id/skip', withPc((pc, req, cred) => {
    const app = cred ? keys.credential(cred) : null;
    if (!app || app.kind !== 'app_key' || !connector.handovers) throw new KeyError('not_found', 'No such handover for this PC.');
    const { reason } = SkipBody.parse(req.body ?? {});
    connector.handovers.skip(app, (req.params as { id: string }).id, reason);
    return { ok: true };
  }));
  // The long poll (the fallback when the stream cannot open): with ?wait=N (at most 25 s) it holds the answer until an order is queued.
  f.get('/connector/v1/orders', async (req, reply) => {
    const who = pcOf(req, false);
    if ('refused' in who) return withPc(() => null)(req, reply);
    const w = Math.min(Number((req.query as { wait?: string }).wait ?? 0) || 0, LONG_POLL_MAX_S);
    return run(reply, async () => {
      let orders = connector.fetchOrders(who.pc);
      if (!orders.length && w > 0 && !connector.measureOnly(who.pc)) {
        const ac = new AbortController();
        req.raw.once('close', () => ac.abort());
        await connector.streams.wait(who.pc, w * 1000, ac.signal);
        if (ac.signal.aborted) return null;
        // Access may have ended while waiting: the same check as at the start.
        const again = pcOf(req, false);
        if ('refused' in again) return withPc(() => null)(req, reply);
        orders = connector.fetchOrders(who.pc);
      }
      return { orders };
    });
  });
  // The push stream: Server-Sent Events that only say "orders waiting". One per PC; a measure-only PC opens none (docs/connector.md, "The push stream").
  f.get('/connector/v1/stream', async (req, reply) => {
    const who = pcOf(req, false);
    if ('refused' in who) return withPc(() => null)(req, reply);
    if (connector.isLocked(who.pc)) return reply.code(423).send({ error: 'lockdown', message: 'This PC is locked down: its connector gets no orders and opens no stream until the lockdown is lifted.' });
    if (connector.measureOnly(who.pc)) return reply.code(403).send({ error: 'forbidden', message: 'A compute-machine connector only measures; it opens no push stream.' });
    if (!connector.streams.admit(who.pc)) return reply.code(429).header('retry-after', '30').send({ error: 'rate_limited', message: 'Too many stream openings from this PC. Wait and try again.' });
    const q = req.query as { installation?: string };
    const installation = /^[A-Za-z0-9_-]{6,64}$/.test(q.installation ?? '') ? q.installation! : 'unknown';
    reply.hijack();
    connector.streams.attach(who.pc, reply.raw, { installation, address: req.ip, credential: who.credential ?? null });
  });
  // A compute machine's samples (docs/hardware.md#measuring): the whole machine's use, numbers only, batched once a minute.
  if (hardware) f.post('/connector/v1/hardware', withPc((pc, req) => {
    const pct = z.number().min(0).max(100), gb = z.number().min(0).max(100_000);
    const gpu = z.object({ util_pct: pct, mem_used_gb: gb, mem_total_gb: gb }).strict();
    const sample = z.object({ at: z.number().int().min(0), cpu_pct: pct, cpu_count: z.number().int().min(1).max(100_000).optional(), mem_used_gb: gb, mem_total_gb: gb, gpus: z.array(gpu).max(16).optional() }).strict();
    const b = z.object({ samples: z.array(sample).min(1).max(SAMPLE_MAX) }).strict().parse(req.body ?? {});
    return hardware.ingest(pc, b.samples);
  }));
  f.post('/connector/v1/orders/:id/result', withPc((pc, req) => {
    const b = z.object({ state: z.enum(['done', 'failed']), result: z.unknown().optional() }).strict().parse(req.body ?? {});
    const id = (req.params as { id: string }).id;
    const kind = connector.orderKind(pc, id) ?? undefined;
    // A check's result is bounded and typed; other kinds report at most a short reason.
    const result = kind === 'check' && b.state === 'done' ? CheckResult.parse(b.result) : kind === 'restore' ? RestoreResult.parse(b.result ?? {}) : kind === 'deliver' ? DeliverResult.parse(b.result ?? {}) : z.object({ reason: line.optional() }).strict().optional().parse(b.result);
    return connector.reportOrder(pc, id, b.state, result ?? null);
  }));
  f.post('/connector/v1/orders/:id/progress', withPc((pc, req) => {
    const b = z.object({ note: line, start_lines: z.array(z.string().max(400)).max(40).optional() }).strict().parse(req.body ?? {});
    return connector.progressOrder(pc, (req.params as { id: string }).id, b);
  }));
  // Turn tokens (docs/connector.md, "Isolation levels"): the connector asks for one per run, renews it while the run lives and ends it with the turn.
  // The session key goes in this body only, from the connector to the hub; a session never sees one.
  f.post('/connector/v1/turn-tokens', withPc((pc, req) => {
    const b = z.object({ session_key: z.string().min(10).max(200), run: z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/) }).strict().parse(req.body ?? {});
    return connector.issueTurn(pc, b.session_key, b.run);
  }));
  f.post('/connector/v1/turn-tokens/renew', withPc((pc, req) => connector.renewTurn(pc, z.object({ token: z.string().max(100) }).strict().parse(req.body ?? {}).token)));
  f.post('/connector/v1/turn-tokens/revoke', withPc((pc, req) => {
    const b = z.object({ token: z.string().max(100), reason: z.enum(['turn_ended', 'leak_found']).optional() }).strict().parse(req.body ?? {});
    return connector.revokeTurn(pc, b.token, b.reason);
  }));
  // Folders the connector allowed without a click at the upgrade to turn tokens (registered before it, unchanged since): one audit entry each.
  f.post('/connector/v1/folders-denied', withPc((pc, req) => connector.foldersDenied(pc, z.object({ denied: z.array(z.discriminatedUnion('what', [z.object({ what: z.literal('folder'), agent: z.string().max(100) }).strict(), z.object({ what: z.literal('pickup'), request: z.string().max(100) }).strict()])).max(50) }).strict().parse(req.body ?? {}).denied)));
  f.post('/connector/v1/folders-allowed-with-pickup', withPc((pc, req) => connector.foldersAllowedWithPickup(pc, z.object({ allowed: z.array(z.object({ agent_id: z.string().max(100), ref: z.string().max(100) }).strict()).max(100) }).strict().parse(req.body ?? {}).allowed)));
  f.post('/connector/v1/folders-grandfathered', withPc((pc, req) => connector.foldersGrandfathered(pc, z.object({ agents: z.array(z.string().max(100)).max(200) }).strict().parse(req.body ?? {}).agents)));
  // The agent folders the connector registered: each becomes a proposed folder row, for the operator to approve (docs/connector.md, "Folders").
  f.post('/connector/v1/folders', withPc((pc, req) => connector.proposeFolders(pc, z.object({ folders: z.array(z.object({ agent: z.string().max(100), agent_id: z.string().max(100).optional(), path: z.string().max(600) }).strict()).max(200) }).strict().parse(req.body ?? {}).folders)));
  // The wake: a run's state (a heartbeat rides on it) and the completion check after it (docs/connector.md, "The wake").
  const wakeId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
  f.post('/connector/v1/wake/report', withPc((pc, req) => connector.wakeReport(pc, z.object({ agent_id: wakeId, state: z.enum(WAKE_STATES), run: wakeId.optional(), task: wakeId.optional(), session_id: z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/).optional(), last_activity: count.optional(), resumes_at: count.optional(), waiting_on: wakeId.optional() }).strict().parse(req.body ?? {}))));
  f.post('/connector/v1/wake/check', withPc((pc, req) => { const b = z.object({ agent_id: wakeId, task: wakeId.optional() }).strict().parse(req.body ?? {}); return connector.wakeCheck(pc, b.agent_id, b.task); }));
  f.get('/connector/v1/versions/approved', withPc(() => ({ versions: connector.approvedVersions() })));
  // The PC's own setup timeline, for the connector's local screen (docs/connector.md, "Pairing").
  f.get('/connector/v1/setup', withPc((pc) => connector.timeline(pc)));
  f.post('/connector/v1/messages/shown', withPc((pc, req) => {
    const b = z.object({ agent_id: z.string().max(100), room_id: z.string().max(100), seq: count }).strict().parse(req.body ?? {});
    return connector.reportShown(pc, b.agent_id, b.room_id, b.seq);
  }));
  // The reminder line's counts for one agent of this PC: numbers and sender labels only, read-only (docs/connector.md, "The one reminder line").
  f.post('/connector/v1/messages/unread', withPc((pc, req) => {
    const b = z.object({ agent_id: z.string().max(100) }).strict().parse(req.body ?? {});
    const m = connector.unreadSummary(pc, b.agent_id);
    let d = 0; try { d = directives?.unreadIds(b.agent_id).length ?? 0; } catch { d = 0; }
    return { ...m, directives: d };
  }));
  f.post('/connector/v1/usage', withPc((pc, req) => {
    const row = z.object({ agent_id: z.string().max(100), client: z.enum(CLIENTS), model: z.string().max(100), input_tokens: count, output_tokens: count,
      cache_read_tokens: count, cache_write_tokens: count, sessions: count, turns: count.optional() }).strict();
    const b = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), rows: z.array(row).max(500) }).strict().parse(req.body ?? {});
    return connector.reportUsage(pc, b.day, b.rows);
  }));

  // Disconnect: the receipt credential only, which works after the PC's own keys are dead.
  const receipt = (req: FastifyRequest) => {
    const k = bearer(req);
    if (!k) return null;
    try { return connector.verifyReceipt(k); } catch (e) { if (e instanceof KeyError) return null; throw e; }
  };
  f.get('/connector/v1/disconnect', async (req, reply) => {
    const a = receipt(req); if (!a) return refuse(reply);
    return run(reply, () => ({ order: connector.fetchDisconnect(a) }));
  });
  f.post('/connector/v1/disconnect/result', async (req, reply) => {
    const a = receipt(req); if (!a) return refuse(reply);
    return run(reply, () => {
      const b = z.object({ state: z.enum(['removed', 'needs_attention', 'cleanup_off']), left: z.array(line).max(20).optional() }).strict().parse(req.body ?? {});
      return connector.reportDisconnect(a, b.state, b.left ?? []);
    });
  });
}
