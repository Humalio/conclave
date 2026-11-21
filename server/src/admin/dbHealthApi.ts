/** Admin routes for Security → Database (docs/operations.md): health, clean-up rules, checks and compaction. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { KeyError } from '../keys/keys.js';
import type { Actor } from '../audit/audit.js';
import { DbHealth, HealthError } from '../safety/dbHealth.js';
import { recheckAdmin, type ResetDeps } from './resetApi.js';

export type DbHealthDeps = Pick<ResetDeps, 'db' | 'audit' | 'loginLimit' | 'users'> & { health: DbHealth };

const CODE = { invalid_argument: 'invalid_argument', not_found: 'not_found', conflict: 'conflict', locked: 'lockdown', refused: 'invalid_state' } as const;
async function plain<T>(fn: () => T | Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e) { if (e instanceof HealthError) throw new KeyError(CODE[e.code], e.message); throw e; }
}

export function registerDbHealthApi(api: FastifyInstance, d: DbHealthDeps, actor: (req: FastifyRequest) => Actor): void {
  const h = d.health;
  const keyOf = (req: FastifyRequest) => String((req.params as { key: string }).key);
  const proof = z.object({ password: z.string(), totp: z.string().optional() });

  api.get('/api/db-health', async () => plain(() => ({ health: h.health(), rules: h.rules(), runs: h.runs(30) })));

  api.get('/api/db-health/rules/:key/preview', async (req) => plain(() => ({ preview: h.preview(keyOf(req)) })));

  api.put('/api/db-health/rules/:key', async (req) => {
    const b = proof.extend({ enabled: z.boolean().optional(), days: z.number().int().optional() }).parse(req.body ?? {});
    await plain(() => h.rule(keyOf(req)));
    await recheckAdmin(d, req, b.password, b.totp);
    return plain(() => ({ rule: h.setRule(keyOf(req), { enabled: b.enabled, days: b.days }, actor(req)) }));
  });

  api.post('/api/db-health/rules/:key/run', async (req) => {
    const b = proof.extend({ preview_total: z.number().int().min(0).optional() }).parse(req.body ?? {});
    await plain(() => h.preview(keyOf(req))); // unknown or built-in rules answer before the password is checked
    await recheckAdmin(d, req, b.password, b.totp);
    return plain(async () => ({ result: await h.run(keyOf(req), actor(req), { previewTotal: b.preview_total ?? null }) }));
  });

  api.post('/api/db-health/check', async (req) => {
    const b = z.object({ full: z.boolean().optional() }).parse(req.body ?? {});
    return plain(async () => ({ check: await h.check(!!b.full, actor(req)) }));
  });

  api.post('/api/db-health/compact', async (req) => {
    const b = proof.parse(req.body ?? {});
    await recheckAdmin(d, req, b.password, b.totp);
    return plain(async () => ({ compact: await h.compact(actor(req)) }));
  });
}
