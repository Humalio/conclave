/** Admin routes for directives (docs/directives.md): list with coverage, create, edit, retire, and agents' reports. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Actor } from '../audit/audit.js';
import { CATEGORIES, CATEGORY_IDS, type Directives } from '../directives/directives.js';

export interface DirectivesApiDeps { directives: Directives }

const category = z.enum(CATEGORY_IDS).nullable();
const tags = z.array(z.string().max(64)).max(10); // the hub trims each to 32 characters (normTags)
const scope = z.object({ kind: z.enum(['hub', 'project', 'team', 'role', 'agent']), ref: z.string().max(200).nullable().optional() });

export function registerDirectivesApi(api: FastifyInstance, d: DirectivesApiDeps, actor: (req: FastifyRequest) => Actor): void {
  const { directives } = d;
  const idOf = (req: FastifyRequest) => (req.params as { id: string }).id;
  const body = <T extends z.ZodType>(s: T, req: FastifyRequest): z.infer<T> => s.parse(req.body ?? {});

  api.get('/api/directives', async (req) => {
    const q = z.object({ status: z.enum(['active', 'retired', 'all']).optional(), category: z.enum([...CATEGORY_IDS, 'none']).optional(), tag: z.string().max(32).optional() }).parse(req.query ?? {});
    return { directives: directives.list(q.status ?? 'active', { category: q.category, tag: q.tag }), reports: directives.reports('open'), unreviewed: directives.unreviewed(),
      categories: CATEGORIES.map(([id, label]) => ({ id, label })), projects: directives.projects() };
  });
  // Before saving (docs/directives.md#project-reach): who it would reach, gain and lose with this scope or this target kept off.
  api.post('/api/directives/preview', async (req) => {
    const b = body(z.object({ id: z.string().max(100).optional(), scope: scope.optional(), exempt: z.object({ target_kind: z.enum(['agent', 'team', 'project']), target_ref: z.string().min(1).max(200) }).optional() }), req);
    return directives.preview({ id: b.id, scope: b.scope ? { kind: b.scope.kind, ref: b.scope.ref ?? null } : undefined, exempt: b.exempt ? { kind: b.exempt.target_kind, ref: b.exempt.target_ref } : undefined });
  });
  api.get('/api/directives/projects', async () => ({ projects: directives.projects() }));
  api.get('/api/directives/categories', async () => ({ categories: CATEGORIES.map(([id, label]) => ({ id, label })) }));
  api.get('/api/directives/unreviewed-count', async () => ({ count: directives.unreviewedCount(), suggestions: directives.openReportCount() }));
  api.get('/api/directives/:id', async (req) => directives.detail(idOf(req)));
  api.post('/api/directives', async (req) => {
    const b = body(z.object({ title: z.string().min(1).max(120), body: z.string().min(1).max(20000), scope, source: z.string().max(500).nullable().optional(), category: category.optional(), tags: tags.optional() }), req);
    return { directive: directives.create({ title: b.title, body: b.body, scope: { kind: b.scope.kind, ref: b.scope.ref ?? null }, source: b.source ?? 'console', category: b.category, tags: b.tags }, actor(req)) };
  });
  api.patch('/api/directives/:id', async (req) => {
    const b = body(z.object({ title: z.string().min(1).max(120).optional(), body: z.string().min(1).max(20000).optional(), scope: scope.optional(), note: z.string().max(500).nullable().optional(), category: category.optional(), tags: tags.optional(), minor: z.boolean().optional() }), req);
    return { directive: directives.update(idOf(req), { title: b.title, body: b.body, scope: b.scope ? { kind: b.scope.kind, ref: b.scope.ref ?? null } : undefined, note: b.note ?? null, category: b.category, tags: b.tags, minor: b.minor }, actor(req)) };
  });
  // Keep a registered rule; the category the agent proposed is confirmed unless the body gives one (null: none).
  api.post('/api/directives/:id/review', async (req) => ({ directive: directives.review(idOf(req), actor(req), body(z.object({ category: category.optional() }), req).category) }));
  // Bulk filing: set the category (null clears it) and/or replace or add tags on many directives; no new version, no notice.
  api.post('/api/directives/categorize', async (req) => {
    const b = body(z.object({ ids: z.array(z.string().max(100)).min(1).max(500), category: category.optional(), tags: tags.optional(), add_tags: tags.optional() }), req);
    return { changed: directives.categorize(b.ids, { category: b.category, tags: b.tags, addTags: b.add_tags }, actor(req)) };
  });
  api.post('/api/directives/review-all', async (req) => ({ reviewed: directives.reviewAll(actor(req), body(z.object({ agent_id: z.string().max(100).optional() }), req).agent_id) }));
  api.post('/api/directives/merge', async (req) => {
    const b = body(z.object({ ids: z.array(z.string().max(100)).min(2).max(50), title: z.string().min(1).max(120), body: z.string().min(1).max(20000), scope, category: category.optional(), tags: tags.optional() }), req);
    return { directive: directives.merge(b.ids, { title: b.title, body: b.body, scope: { kind: b.scope.kind, ref: b.scope.ref ?? null }, category: b.category, tags: b.tags }, actor(req)) };
  });
  api.post('/api/directives/:id/retire', async (req) => ({ directive: directives.retire(idOf(req), body(z.object({ note: z.string().max(500).nullable().optional() }), req).note ?? null, actor(req)) }));
  // Keep a directive off an agent, a team or a project; DELETE applies it there again (the row stays as history).
  api.post('/api/directives/:id/exemptions', async (req) => {
    const b = body(z.object({ target_kind: z.enum(['agent', 'team', 'project']), target_ref: z.string().min(1).max(200), note: z.string().max(500).nullable().optional() }), req);
    return directives.exempt(idOf(req), { kind: b.target_kind, ref: b.target_ref, note: b.note ?? null }, actor(req));
  });
  api.delete('/api/directives/:id/exemptions/:exemptionId', async (req) =>
    directives.unexempt(idOf(req), (req.params as { exemptionId: string }).exemptionId, actor(req)));
  api.get('/api/directive-reports', async (req) => ({ reports: directives.reports(z.object({ status: z.enum(['open', 'all']).optional() }).parse(req.query ?? {}).status ?? 'open') }));
  api.post('/api/directive-reports/:id/adopt', async (req) => {
    const b = body(z.object({ title: z.string().min(1).max(120).optional(), body: z.string().min(1).max(20000).optional(), scope: scope.optional(), directive_id: z.string().max(100).optional(), category: category.optional() }), req);
    return directives.adopt(idOf(req), { title: b.title, body: b.body, scope: b.scope ? { kind: b.scope.kind, ref: b.scope.ref ?? null } : undefined, directive_id: b.directive_id, category: b.category }, actor(req));
  });
  api.post('/api/directive-reports/:id/retire', async (req) => ({ report: directives.dismiss(idOf(req), body(z.object({ note: z.string().max(500).nullable().optional() }), req).note ?? null, actor(req)) }));
  api.get('/api/agents/:id/directives', async (req) => directives.agentView(idOf(req)));
  api.get('/api/teams/:id/directives', async (req) => directives.teamView(idOf(req)));
}
