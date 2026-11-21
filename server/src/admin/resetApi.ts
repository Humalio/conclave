/** Admin routes for resetting hub data by part (Security → Reset). */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/db.js';
import type { RateLimit } from '../db/rateLimit.js';
import { KeyError } from '../keys/keys.js';
import type { Audit, Actor } from '../audit/audit.js';
import type { Config } from '../config.js';
import type { Maintenance } from '../safety/retention.js';
import { Reset, RESET_PARTS } from '../safety/reset.js';
import { verifyPasswordAsync } from '../util/crypto.js';
import type { Users } from './users.js';

export interface ResetDeps { db: Db; audit: Audit; config: Config; loginLimit: RateLimit; users: Users; maintenance: Maintenance }

const partsOf = (raw: unknown): string[] => {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
  try { return Reset.normalize(list.map((s) => String(s).trim()).filter(Boolean)); }
  catch (e) { throw new KeyError('invalid_argument', (e as Error).message); }
};

/**
 * Destructive acts (Reset, database clean-up): re-check the admin's password, and code when enrolled (used up like one at
 * sign-in), and count failures like sign-ins.
 */
export async function recheckAdmin(d: Pick<ResetDeps, 'db' | 'audit' | 'loginLimit' | 'users'>, req: FastifyRequest, password: string, totp?: string): Promise<void> {
  const admin = req.admin!, now = Date.now();
  if (d.loginLimit.blocked(admin.username, 'admin_login_fail', now).blocked) {
    d.audit.auth({ subject: 'admin', adminId: admin.id, outcome: 'rate_limited', source: req.ip });
    throw new KeyError('rate_limited', 'Too many failed attempts. Try again later.');
  }
  const u = d.db.prepare('SELECT password_hash, totp_secret FROM admin_users WHERE id=?').get(admin.id) as { password_hash: string; totp_secret: string | null };
  const ok = (await verifyPasswordAsync(password, u.password_hash)) && (!u.totp_secret || (!!totp && d.users.useTotp(admin.id, u.totp_secret, totp, now)));
  if (!ok) {
    d.loginLimit.fail(admin.username, 'admin_login_fail', now);
    d.audit.auth({ subject: 'admin', adminId: admin.id, outcome: 'invalid', source: req.ip });
    throw new KeyError('invalid_credentials', u.totp_secret ? 'Password or code is incorrect.' : 'Password is incorrect.');
  }
}

export function registerResetApi(api: FastifyInstance, d: ResetDeps, actor: (req: FastifyRequest) => Actor): void {
  const reset = new Reset(d.db);

  api.get('/api/reset/parts', async () => ({ parts: RESET_PARTS.map(({ key, label, detail }) => ({ key, label, detail })) }));

  api.get('/api/reset/plan', async (req) => ({ plan: reset.plan(partsOf((req.query as { parts?: string }).parts)) }));

  api.post('/api/reset', async (req, reply) => {
    const b = z.object({ parts: z.array(z.string()).min(1), confirm: z.string(), password: z.string(), totp: z.string().optional() }).parse(req.body ?? {});
    if (b.confirm !== 'RESET') throw new KeyError('invalid_argument', 'Type RESET to confirm.');
    const parts = partsOf(b.parts);
    await recheckAdmin(d, req, b.password, b.totp);
    const result = reset.run(parts);
    // Revisions and share versions may have been the last references to stored blobs.
    const blobs = await d.maintenance.gcBlobs(Date.now() + 1);
    d.audit.event(actor(req), 'system.reset', { kind: 'system', id: 'reset' },
      { parts: result.parts, implied: result.implied, rows: result.total, blobs, by_part: Object.fromEntries(result.byPart.filter((p) => p.rows).map((p) => [p.key, p.rows])) });
    // Services keep some state in memory (watchers, team timers, caches). In production the process exits
    // after replying and the container's restart policy brings it back on the reset data.
    const restart = d.config.production;
    if (restart) setTimeout(() => process.exit(0), 300);
    return reply.send({ result, blobs, restart });
  });
}
