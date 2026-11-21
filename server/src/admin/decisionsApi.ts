/** Admin routes for decisions (docs/decisions.md): the operator's open questions, answers, and each team's decision log. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Actor } from '../audit/audit.js';
import { isAdmin } from '../audit/audit.js';
import { KeyError } from '../keys/keys.js';
import type { Decisions, DecisionView } from '../teams/decisions.js';
import type { Teams } from '../teams/teams.js';
import type { Vault } from '../vault/vault.js';
import type { Db } from '../db/db.js';
import type { Routing } from './routing.js';
import { adminOnly } from './scopes.js';
import type { Blueprint, Design } from '../blueprint/blueprint.js';
import type { Keys } from '../keys/keys.js';
import type { TaskAttachments } from '../shares/taskAttachments.js';
import { sniff } from '../shares/taskAttachments.js';
import type { VaultStore } from '../vault/store.js';
import { disposition } from '../vault/media.js';
import { MIRROR_FOLDER, inMirrorFolder } from '../mirror/folder.js';

export interface DecisionsApiDeps { db: Db; decisions: Decisions; teams: Teams; vault: Vault; routing?: Routing; blueprint?: Blueprint; keys?: Keys; attachments?: TaskAttachments; store?: VaultStore }
/** A design's mockups are images only: SVG can carry script, and a GIF or a document is not a mockup. */
export const MOCKUP_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

export function registerDecisionsApi(api: FastifyInstance, d: DecisionsApiDeps, actor: (req: FastifyRequest) => Actor): void {
  const { decisions } = d;
  const idOf = (req: FastifyRequest) => (req.params as { id: string }).id;
  const body = <T extends z.ZodType>(s: T, req: FastifyRequest): z.infer<T> => s.parse(req.body ?? {});
  /** The admin's own acts; a member gets the scope hook's answer. */
  const admin = (req: FastifyRequest) => { const a = actor(req); if (!isAdmin(a)) throw adminOnly(); return a as Actor & { kind: 'admin' }; };
  /** Teams whose questions a member sees: granted with tasks, plus the teams they decide for (routed items, §2). */
  const seen = (req: FastifyRequest) => [...new Set([...req.member!.teams('tasks'), ...(d.routing?.decidesFor(req.member!.userId) ?? [])])];
  /**
   * A question as a member sees it (§1.4): no key id, and whoever answered (the admin or a decider) shows as plain
   * `operator`, never a console user id or username.
   */
  const out = (req: FastifyRequest, q: DecisionView): DecisionView => (req.member
    ? { ...q, credential_id: null, answered_by: q.answered_by ? 'operator' : null, answered_by_name: q.answered_by ? 'operator' : null }
    : q);
  /** The actor for an act on a question: the admin (with via when the team has deciders), or one of the team's active deciders. */
  const decider = (req: FastifyRequest): Actor & { kind: 'admin' } => {
    if (!d.routing) return admin(req);
    const q = decisions.get(idOf(req));
    return d.routing.act(req.member ? actor(req) : admin(req), req.member, q.team_id, 'decision not found') as Actor & { kind: 'admin' };
  };

  api.get('/api/decisions', async (req) => {
    const q = z.object({ team: z.string().max(100).optional(), status: z.enum(['open', 'closed', 'all']).optional(), limit: z.coerce.number().int().min(1).max(500).optional() }).parse(req.query ?? {});
    // Members: questions of teams in granted projects with tasks, filtered before the limit (§2), plus the teams they decide for.
    return { decisions: decisions.list(req.member ? { ...q, teams: seen(req) } : q).map((x) => out(req, x)) };
  });
  /** For the Work badge and the team list: open questions in all, and per team. */
  api.get('/api/decisions/counts', async (req) => {
    const all = decisions.openCounts(), vis = req.member ? new Set(seen(req)) : null;
    const by = vis ? Object.fromEntries(Object.entries(all).filter(([t]) => vis.has(t))) : all;
    return { open: Object.values(by).reduce((a, b) => a + b, 0), by_team: by };
  });
  api.get('/api/decisions/:id', async (req) => {
    const d = decisions.get(idOf(req));
    if (req.member && !seen(req).includes(d.team_id)) throw new KeyError('not_found', 'decision not found');
    return { decision: out(req, d) };
  });
  /**
   * The design a question asks about (docs/decisions.md, Designs): the decision item its refs name, the agent text marked as such
   * (who wrote it, who reviewed it, from the item's revisions and never from a field), and the mockups as routes of this hub.
   */
  const designOf = (req: FastifyRequest) => {
    const q = decisions.get(idOf(req));
    if (req.member && !seen(req).includes(q.team_id)) throw new KeyError('not_found', 'decision not found');
    const des = d.blueprint?.designOf(q.team_id, q.refs);
    if (!des) throw new KeyError('not_found', 'This question names no design.');
    return { q, des };
  };
  const who = (w: { kind: string; id: string | null } | null) => (w?.kind === 'agent' && w.id ? d.keys?.agent(w.id)?.label ?? 'an agent' : w?.kind === 'operator' || w?.kind === 'admin' ? 'the operator' : null);
  /** A design as the screen shows it: the agent text marked as such, the review, the mockups as routes of this hub. */
  const designView = (des: Design, mock: string, asker: string | null, member: boolean) => {
    const f = des.item.fields as Record<string, unknown>, rv = (f['review'] && typeof f['review'] === 'object' ? f['review'] : null) as { verdict?: string; changes?: unknown; summary?: unknown } | null;
    const reviewer = rv ? who(des.reviewed_by) : null, writer = who(des.written_by) ?? asker;
    const ms = Array.isArray(f['mockups']) ? (f['mockups'] as Record<string, unknown>[]) : [];
    return {
      key: des.item.key, title: des.item.title, status: des.item.status, archived: !!des.item.archived, project_id: des.project_id, rev: des.item.rev, body: des.item.body ?? '',
      written_by: writer, asked_by: asker, mock,
      review: rv ? { verdict: rv.verdict === 'approved' ? 'approved' : 'changes', summary: typeof rv.summary === 'string' ? rv.summary : '', changes: Array.isArray(rv.changes) ? rv.changes.filter((x): x is string => typeof x === 'string') : [], by: reviewer, independent: !!reviewer && reviewer !== writer, stale: des.stale } : null,
      mockups: ms.map((m, n) => ({ n, caption: typeof m['caption'] === 'string' ? m['caption'] : '', name: typeof m['path'] === 'string' ? m['path'].split('/').at(-1) : 'mockup' })),
      may_archive: !member && ['accepted', 'rejected'].includes(des.item.status ?? ''),
    };
  };
  api.get('/api/decisions/:id/design', async (req) => {
    const { q, des } = designOf(req);
    return { decision: out(req, q), design: designView(des, `/api/decisions/${encodeURIComponent(q.id)}/mockup`, d.keys?.agent(q.agent_id)?.label ?? null, !!req.member) };
  });
  /** One mockup, as an image the hub recognised from its bytes (PNG, JPEG or WebP): anything else is refused, never shown. teamOk says the task is this design's own team's. */
  const sendMockup = async (des: Design, n: number, teamOk: (teamId: string) => boolean, reply: FastifyReply) => {
    const m = Array.isArray(des.item.fields['mockups']) ? (des.item.fields['mockups'] as Record<string, unknown>[])[n] : undefined;
    if (!d.attachments || !d.store || !m || typeof m['task_id'] !== 'string' || typeof m['path'] !== 'string') throw new KeyError('not_found', 'No such mockup.');
    const task = d.teams.task(m['task_id']);
    if (!task || !task.team_id || !teamOk(task.team_id)) throw new KeyError('not_found', 'No such mockup.');
    const file = d.attachments.entry(m['task_id'], m['role'] === 'submission' ? 'submission' : 'brief', m['path'], typeof m['v'] === 'string' ? m['v'] : undefined);
    const bytes = file ? await d.store.getBlob(file.entry.blob_hash) : null;
    if (!file || !bytes) throw new KeyError('not_found', 'No such mockup.');
    const type = sniff(bytes);
    if (!MOCKUP_TYPES.includes(type)) throw new KeyError('invalid_argument', 'A mockup is a PNG, JPEG or WebP image.');
    return reply.code(200).type(type).header('Cache-Control', 'private, no-cache').header('X-Content-Type-Options', 'nosniff').header('Cross-Origin-Resource-Policy', 'same-origin')
      .header('Content-Security-Policy', "sandbox; default-src 'none'").header('Content-Disposition', disposition('inline', file.entry.path.split('/').at(-1) ?? 'mockup')).send(bytes);
  };
  api.get('/api/decisions/:id/mockup/:n', async (req, reply) => {
    const { q, des } = designOf(req);
    return sendMockup(des, Number((req.params as { n: string }).n), (t) => t === q.team_id, reply);
  });
  /** The Blueprint's Designs filter (admin): a project's designs, archived ones too, and one of them read-only by its key. */
  const projectDesign = (req: FastifyRequest) => {
    admin(req);
    const { id, key } = req.params as { id: string; key: string };
    const des = d.blueprint?.designAt(id, key);
    if (!des) throw new KeyError('not_found', 'No such design.');
    return des;
  };
  api.get('/api/projects/:id/designs', async (req) => {
    admin(req);
    const id = (req.params as { id: string }).id;
    if (!d.blueprint?.project(id)) throw new KeyError('not_found', 'No such project.');
    return { designs: d.blueprint.designs(id).map((x) => { const v = designView(x, '', null, false); return { key: v.key, title: v.title, status: v.status, archived: v.archived, review: v.review ? (v.review.stale ? 'out of date' : v.review.verdict === 'approved' ? 'approved' : `${v.review.changes.length || 1} change${(v.review.changes.length || 1) === 1 ? '' : 's'}`) : null, mockups: v.mockups.length, updated_at: x.item.updated_at }; }) };
  });
  api.get('/api/projects/:id/designs/:key', async (req) => {
    const des = projectDesign(req);
    return { design: designView(des, `/api/projects/${encodeURIComponent(des.project_id)}/designs/${encodeURIComponent(des.item.key)}/mockup`, null, false) };
  });
  api.get('/api/projects/:id/designs/:key/mockup/:n', async (req, reply) => {
    const des = projectDesign(req);
    return sendMockup(des, Number((req.params as { n: string }).n), (t) => d.blueprint?.projectOfTeam(t)?.id === des.project_id, reply);
  });
  api.post('/api/decisions/:id/answer', async (req) => {
    const b = body(z.object({ option: z.string().max(8).nullable().optional(), text: z.string().max(4000).nullable().optional(), item_rev: z.number().int().nullable().optional(), options_version: z.number().int().min(1).nullable().optional(), reject: z.boolean().optional() }), req);
    return { decision: out(req, await decisions.answer(idOf(req), b, decider(req))) };
  });
  /** A relayed answer (recorded by the coordinator, L1): confirm it as the operator's, or overturn it with another answer. */
  api.post('/api/decisions/:id/confirm', async (req) => ({ decision: out(req, await decisions.confirmRelay(idOf(req), decider(req))) }));
  api.post('/api/decisions/:id/overturn', async (req) => {
    const b = body(z.object({ option: z.string().max(8).nullable().optional(), text: z.string().max(4000).nullable().optional() }), req);
    return { decision: out(req, await decisions.overturnRelay(idOf(req), b, decider(req))) };
  });
  api.post('/api/decisions/:id/more-info', async (req) => ({ decision: out(req, decisions.needInfo(idOf(req), body(z.object({ note: z.string().min(1).max(2000) }), req).note, decider(req))) }));
  api.post('/api/decisions/:id/decline', async (req) => ({ decision: out(req, await decisions.decline(idOf(req), body(z.object({ note: z.string().max(2000).nullable().optional() }), req).note ?? null, decider(req))) }));
  /** The vault note answered decisions are also appended to, or null for none. */
  api.put('/api/teams/:id/decision-log', async (req) => {
    const t = d.teams.mustTeam(idOf(req));
    const { path } = body(z.object({ path: z.string().max(1024).nullable() }), req);
    let norm: string | null = null;
    if (path && path.trim()) {
      const n = d.vault.normalise(path.trim());
      if (!/\.md$/i.test(n.path)) throw new KeyError('invalid_argument', 'The decision log must be a Markdown note (.md).');
      // The hub writes 99 Conclave/ itself (its Decisions.md included): two hub writers never share one file.
      if (inMirrorFolder(n.rel.join('/'))) throw new KeyError('invalid_argument', `The decision log cannot be in ${MIRROR_FOLDER}/: the hub writes that folder itself. Choose a note in the project folder.`);
      norm = n.path;
    }
    d.db.prepare('UPDATE teams SET decision_log_path=?, updated_at=? WHERE id=?').run(norm, Date.now(), t.id);
    return { team: d.teams.view(d.teams.mustTeam(t.id)) };
  });
}
