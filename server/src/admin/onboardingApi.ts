/** Admin routes for onboarding (docs/onboarding.md#admin-api): Add PC, Re-enrol, codes, settings, the one approval, capability. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Actor } from '../audit/audit.js';
import type { Keys } from '../keys/keys.js';
import type { Config } from '../config.js';
import type { Onboarding, ApproveIn } from '../onboarding/onboarding.js';
import type { ClientFiles } from '../onboarding/http.js';
import type { Connector } from '../connector/connector.js';
import { KeyError } from '../keys/keys.js';
import { through, type ThroughRelay, type Relays } from '../relay/relays.js';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PAIRING_MS, caCheck, connectorPrompt } from '../connector/identity.js';

export interface OnboardingApiDeps { keys: Keys; onboarding: Onboarding; files: ClientFiles; config: Config; connector?: Connector; relays?: Relays }

const folder = z.object({ path: z.string(), access: z.enum(['read', 'write']) });
const role = z.object({ name: z.string(), team_role: z.enum(['coordinator', 'worker', 'reviewer', 'stakeholder']), count: z.number().int(), job: z.string(), reviews: z.array(z.string()).optional(), folders: z.array(folder).optional() });
const rule = z.object({ title: z.string(), source: z.string(), text: z.string(), category: z.string().optional(), role: z.enum(['coordinator', 'worker', 'reviewer', 'stakeholder']).optional() });
// Bounds are checked by the hub (onboarding.ts), with field-level problems; the schema only fixes the shape.
const requirement = z.object({ kind: z.enum(['fr', 'nfr']), title: z.string(), text: z.string(), category: z.enum(['perf', 'sec', 'rel', 'use', 'ops']).optional(), acs: z.array(z.string()).optional(), module: z.string().optional() });
/** The kept research records; the hub's request rules check each field (docs/onboarding.md#the-request). */
const research = z.object({ lines: z.array(z.record(z.string(), z.unknown())), papers: z.array(z.record(z.string(), z.unknown())) });
const standard = z.object({ key: z.string(), title: z.string().optional(), text: z.string().optional() });
const team = z.object({ name: z.string().optional(), goal: z.string().optional(), delivery_mode: z.enum(['on_demand', 'poll']).optional(), close_on_approve: z.boolean().optional(), coordinator_reviews: z.boolean().optional(),
  lease_minutes: z.number().int().optional(), stall_minutes: z.number().int().optional(), max_review_rounds: z.number().int().optional() });

export function registerOnboardingApi(api: FastifyInstance, d: OnboardingApiDeps, actor: (req: FastifyRequest) => Actor): void {
  const { keys, onboarding: ob, files, config } = d;
  const idOf = (req: FastifyRequest) => (req.params as { id: string }).id;
  const body = <T extends z.ZodType>(s: T, req: FastifyRequest): z.infer<T> => s.parse(req.body ?? {});
  // "Through relay X": the prompt and the pairing block carry the relay's origin, its CA fingerprint and the release base instead of the hub's.
  const relayOf = (id: string | null | undefined): ThroughRelay | null => {
    if (!id) return null;
    const r = d.relays?.get(id);
    if (!r) throw new KeyError('not_found', 'No such relay.');
    return through(r);
  };
  // The connector's pairing block (docs/connector.md, "Pairing"): the same code, its 30 minutes, the hub check the PC's user
  // types, and the prompt, which never holds the code: it is the same for every PC of the hub (docs/onboarding.md, "The prompt"). When nothing can be pinned both are null and connector_unavailable says why: no_ca (the
  // hub serves no CA certificate) or no_origin (its public URL is not HTTPS). There is no other prompt: a PC joins with the connector.
  // The installer the prompt names: the newest approved version, and its SHA-256 when the hub holds the file in
  // CONNECTOR_RELEASE_DIR (hashed once per file change). Without the file the prompt points at SHA256SUMS on the release page.
  const shaSeen = new Map<string, { mtime: number; sha: string }>();
  const installer = () => {
    const version = d.connector?.approvedVersions().at(-1) ?? null;
    let sha: string | null = null;
    if (version && config.connectorReleaseDir) {
      const f = join(config.connectorReleaseDir, `conclave-install-${version}.mjs`);
      try {
        if (existsSync(f)) {
          const mtime = statSync(f).mtimeMs, had = shaSeen.get(f);
          sha = had && had.mtime === mtime ? had.sha : createHash('sha256').update(readFileSync(f)).digest('hex');
          shaSeen.set(f, { mtime, sha });
        }
      } catch { sha = null; }
    }
    return { version, sha };
  };
  const pairing = (code: string, relay: ThroughRelay | null = null) => {
    const inst = installer();
    if (relay) return { pairing: { code, code_expires_at: Date.now() + PAIRING_MS, ca_check: caCheck(relay.ca_sha256), hub_origin: relay.origin, relay: { id: relay.id, name: relay.name, release_base: relay.release_base } },
      connector_prompt: connectorPrompt({ hubUrl: relay.origin, relay: relay.name, caSha256: relay.ca_sha256, version: inst.version, downloadUrl: relay.release_base ?? config.connectorReleaseUrl ?? null, installerSha256: inst.sha }), connector_unavailable: null };
    const ca = files.ca(), hub = ob.hubInfo();
    if (!ca || !hub.origin) return { pairing: null, connector_prompt: null, connector_unavailable: !ca ? 'no_ca' as const : 'no_origin' as const };
    return { pairing: { code, code_expires_at: Date.now() + PAIRING_MS, ca_check: caCheck(ca.sha256), hub_origin: hub.origin },
      connector_prompt: connectorPrompt({ hubUrl: hub.origin, caSha256: ca.sha256, version: inst.version, downloadUrl: config.connectorReleaseUrl ?? null, installerSha256: inst.sha }), connector_unavailable: null };
  };

  // Add PC: the code appears only in this response (and in Re-enrol's).
  api.post('/api/pcs/add', async (req) => {
    const b = body(z.object({ name: z.string(), description: z.string().max(500).nullable().optional(), relay_id: z.string().nullable().optional() }), req);
    const relay = relayOf(b.relay_id);
    const r = ob.addPc(b.name, b.description ?? null, actor(req));
    // The connector download (null until set), the newest approved version (it names the installer file, null while none is
    // approved) and the pairing block (docs/connector.md, "Add PC").
    return { pc: r.pc, key: { id: r.key.id, label: r.key.label, onboarding_enabled_at: r.key.onboarding_enabled_at }, code: r.code,
      download_url: config.connectorReleaseUrl ?? null, connector_version: d.connector?.approvedVersions().at(-1) ?? null, ...pairing(r.code, relay) };
  });
  api.post('/api/pcs/:id/re-enrol', async (req) => {
    const relay = relayOf(body(z.object({ relay_id: z.string().nullable().optional() }), req).relay_id);
    const r = ob.reEnrol(idOf(req), actor(req));
    d.connector?.endDisconnect(idOf(req), actor(req)); // Re-enrol PC ends a disconnect (docs/connector.md)
    return { pc: r.pc, key: { id: r.key.id, label: r.key.label }, code: r.code, reopened: r.reopened, handover: r.handover, ...pairing(r.code, relay) };
  });
  // Show the prompt again (Add PC's New prompt): a new code, and the old one is void. Only before the PC has paired.
  api.post('/api/pcs/:id/prompt', async (req) => {
    const relay = relayOf(body(z.object({ relay_id: z.string().nullable().optional() }), req).relay_id);
    const r = ob.renewCode(idOf(req), actor(req));
    return { pc: r.pc, code: r.code, download_url: config.connectorReleaseUrl ?? null, connector_version: d.connector?.approvedVersions().at(-1) ?? null, ...pairing(r.code, relay) };
  });
  // "Paired just now" (Needs you): It was me keeps the pairing; Revoke undoes it (docs/onboarding.md#paired-just-now).
  api.get('/api/pairings', async () => ({ pairings: ob.newPairings() }));
  api.post('/api/pairings/:id/keep', async (req) => ob.keepPairing(idOf(req), actor(req)));
  api.post('/api/pairings/:id/revoke', async (req) => ob.revokePairing(idOf(req), actor(req)));
  // Collaborator invites (docs/onboarding.md#an-invite-for-a-collaborator): the operator makes one for a team and role; creating
  // it is the approval. The collaborator opens its code in their own console (self routes); each opening voids the one before.
  const inviteIn = z.object({ team_id: z.string().min(1), role: z.string().nullable().optional(), team_role: z.enum(['coordinator', 'worker', 'reviewer', 'stakeholder']),
    owner_id: z.string().min(1), folders: z.array(folder).max(20).optional(), template_id: z.string().nullable().optional(), bound: z.boolean().optional(), days: z.number().int().optional(),
    relay_id: z.string().nullable().optional() }).strict();
  // relay_id: the collaborator's PC reaches the hub through that relay; checked here, as in Add PC.
  api.post('/api/invites', async (req) => { const b = body(inviteIn, req); relayOf(b.relay_id); return { invite: ob.createInvite(b, actor(req)) }; });
  api.get('/api/invites', async () => ({ invites: ob.invites() }));
  api.delete('/api/invites/:id', async (req) => ({ invite: ob.revokeInvite(idOf(req), actor(req)) }));
  const userId = (req: FastifyRequest) => (req as unknown as { admin: { id: string } }).admin.id;
  api.get('/api/me/invites', async (req) => ({ invites: ob.myInvites(userId(req)) }));
  api.post('/api/me/invites/:id/code', async (req) => {
    // The invite's relay, checked before a code is made: a removed relay refuses with a plain reason instead of a code that cannot reach the hub.
    const relayId = ob.myInvites(userId(req)).find((v) => v.id === idOf(req))?.relay_id ?? null;
    let relay: ThroughRelay | null = null;
    try { relay = relayOf(relayId); } catch { throw new KeyError('invalid_state', 'The relay this invite goes through was removed. Ask the operator for a new invite.'); }
    const r = ob.openInviteCode(idOf(req), userId(req));
    return { invite: r.invite, pc: { id: r.pc.id, name: r.pc.name }, code: r.code, ...pairing(r.code, relay) };
  });
  api.get('/api/onboarding/pcs', async () => ({ pcs: ob.pcStates() }));
  api.get('/api/pcs/:id/enrolment', async (req) => ({ enrolment: ob.enrolment(idOf(req)) }));
  api.delete('/api/pcs/:id/enrolment', async (req) => ob.revokeCode(idOf(req), actor(req)));

  api.get('/api/settings/onboarding', async () => ({ settings: ob.settings() }));
  api.put('/api/settings/onboarding', async (req) => {
    const n = z.number().int().optional();
    const b = body(z.object({ max_roles: n, max_agents: n, max_per_role: n, max_rules: n, max_requirements: n, file_per_hour: n, file_per_day: n }).strict(), req);
    return { settings: ob.setSettings(Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)), actor(req)) };
  });

  api.get('/api/onboarding', async (req) => ({ requests: ob.list((req.query as { status?: string }).status) }));
  api.get('/api/onboarding/:id', async (req) => ob.detail(idOf(req)));
  api.post('/api/onboarding/:id/approve', async (req) => {
    const b = body(z.object({
      version: z.number().int(),
      edits: z.object({ project: z.object({ name: z.string(), existing: z.boolean(), kind: z.enum(['implementation', 'research']).optional(), more_teams: z.boolean().optional() }).optional(), team: team.optional(), roles: z.array(role).optional(), rules: z.array(rule).optional(), requirements: z.array(requirement).optional(), research: research.optional(), standard: z.array(standard).optional() }).optional(),
      agents: z.array(z.object({ slot: z.string(), include: z.boolean().optional(), template_id: z.string().nullable().optional(), bound: z.boolean().optional() })).optional(),
      start_when_set_up: z.boolean().optional(), confirm_root_write: z.boolean().optional(),
      // The owner of the agents the approval creates (docs/authorization.md#agent-owners); omitted: unowned.
      owner_id: z.string().min(1).max(100).nullable().optional(),
    }), req);
    return ob.approve(idOf(req), b as ApproveIn, actor(req)); // research records: checked field by field by the request rules
  });
  api.post('/api/onboarding/:id/needs-changes', async (req) => ob.needsChanges(idOf(req), body(z.object({ note: z.string().min(1).max(500) }), req).note, actor(req)));
  api.post('/api/onboarding/:id/deny', async (req) => ob.deny(idOf(req), body(z.object({ note: z.string().max(500).nullable().optional() }), req).note ?? null, actor(req)));
  api.post('/api/onboarding/:id/cancel', async (req) => ob.cancel(idOf(req), body(z.object({ note: z.string().max(500).nullable().optional() }), req).note ?? null, actor(req)));
  api.post('/api/onboarding/:id/reissue-pickup', async (req) => ob.reissuePickup(idOf(req), actor(req)));
  // The operator sets a team's source after setup, on its Setup card (docs/onboarding.md#setup-progress); checked like the request's.
  api.put('/api/onboarding/:id/source', async (req) => ({ setup: ob.setSource(idOf(req), body(z.object({ source: z.unknown() }).strict(), req).source, actor(req)) }));

  api.put('/api/keys/:id/onboarding', async (req) => ({ key: keys.setOnboarding(idOf(req), true, actor(req)) }));
  api.delete('/api/keys/:id/onboarding', async (req) => ({ key: keys.setOnboarding(idOf(req), false, actor(req)) }));
}
