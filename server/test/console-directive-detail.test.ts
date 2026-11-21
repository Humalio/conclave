/**
 * Directive screen, list and agent card (docs/proposals/console-systems.md §6.5 items 2-4, DIRECTIVES-5, 6.A4, 6.A7):
 * `#directive/<id>` shows reach_label, a "Kept off · n" section with Apply again (the exemption DELETE route), Keep off…
 * (an agent, team or project sheet that leaves out the directive's own target) and exemption events in History; the
 * Work → Directives list reads reach_label; the agent page's Directives card has a muted "Kept off k rules" line from
 * `exempted`. The screen's one-line header and its agent list (one toolbar row: the search box with the team and state chips, then Filters; filters in the route) follow
 * the approved directive screen. Static, like console-tdirs.test.ts: it reads public/app.js, checks the source, and renders the pieces with
 * their own helpers and stubs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
/* One top-level declaration of app.js, up to the next one. */
const decl = (head: string) => {
  const i = js.indexOf(head); expect(i, head).toBeGreaterThan(-1);
  const rest = js.slice(i + head.length), m = /\n(?=const |function |async function |let |\/\*|\/\/|VIEWS\.)/.exec(rest);
  return js.slice(i, i + head.length + (m ? m.index : rest.length));
};
const block = (start: string, end: string) => {
  const i = js.indexOf(start); expect(i, start).toBeGreaterThan(-1);
  const j = js.indexOf(end, i + start.length); expect(j, end).toBeGreaterThan(i);
  return js.slice(i, j);
};
const detail = decl('async function dirDetail(arg, agf = null) {');
const helpers = ['const esc = ', 'const ic = ', 'const plural = ', 'const raw = ', 'const txt = ', 'const safeHref = ', 'function row(', 'const overline = ',
  'const pill = ', 'function listOverline(', 'function csChipsHtml(', 'function chipSearch(', 'const none = ', 'const cap = ', 'const kv = ', 'const sec = ', 'const dirFirstLine = ', 'const dirReadPill = ', 'const dirTarget = ', 'const dirExcept = ',
  'const DIR_KIND_LABEL = ', 'const DIR_CATS = ', 'const DIR_CAT_LABEL = ', 'const dirCatText = ', 'const DIR_UI = ', 'const RID = ', 'const emptyAct = ', 'const filterBtn = ',
  'const DIR_AG = ', 'const DIR_AG_CHIPS = ', 'const DIR_AG_RANK = ', 'const dirAgArgs = ', 'const dirAgOk = ', 'const dirAgStr = ', 'const dirAgSplit = ', 'const dirAgMatch = ',
  'const dirAgTeams = ', 'const dirAgTeamLabel = ', 'const dirAgChips = ', 'const DAG_MORE = ', 'function dirAgRow(', 'function dirAgBody(', 'function dirAgSection(', 'function dirMetaLine('].map(decl).join('\n');

/* GET /api/directives/:id for a hub-wide rule kept off one team (still in force) and one project (lifted). */
const DETAIL = {
  same: [], reports: [], exempt_count: 1, kept_off: 2,
  directive: { id: 'dir_hub', title: 'Log every call', body: 'Log it.', status: 'active', reviewed_at: 1, version: 2, updated_at: 1, scope_kind: 'hub', scope_ref: null,
    scope_label: 'all agents', reach_label: 'All agents except team ECHO Research', except_label: 'Except team ECHO Research', tags: [] },
  coverage: [{ agent_id: 'ag_1', label: 'scribe', read: 'current', version: 2, acked_at: 1 }],
  exemptions: [{ id: 'dex_1', target_kind: 'team', target_ref: 'team_bz', label: 'team ECHO Research', note: 'they log elsewhere', created_by: 'adm_1', created_by_label: 'Ben', created_at: 3000 }],
  exemptions_removed: [{ id: 'dex_0', target_kind: 'project', target_ref: 'APPS', label: 'project APPS', note: null, created_by: 'adm_1', created_by_label: 'Ben', created_at: 1500, removed_by: 'adm_1', removed_by_label: 'Ben', removed_at: 2500 }],
  versions: [{ version: 2, title: 'Log every call', change_note: 'Sharper', created_at: 2000 }, { version: 1, title: 'Log calls', change_note: null, created_at: 1000 }],
};
const renderDetail = async (admin = true, data: unknown = DETAIL, arg = 'dir_hub') => {
  const calls: string[] = [];
  const api = async (p: string) => { calls.push(p); return data; };
  const stubs = { api, S: { me: { role: admin ? 'admin' : 'member' } }, prose: (s: string) => s, dt: () => 'date', ago: (t: number) => `t${t}`, info: () => '', moreBtn: () => '<more>',
    initials: () => 'AB', dirRead: () => '', dirCatOpts: () => '' };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const f = new Function(...Object.keys(stubs), `${helpers}\n${detail}\nreturn dirDetail;`);
  return { r: await f(...Object.values(stubs))(arg), calls };
};
/* The helpers alone, for the agent list and its route keys. */
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const H = new Function('initials', 'ago', 'dt', `${helpers}\nreturn { dirAgArgs, dirAgOk, dirAgStr, dirAgSplit, dirAgBody, dirAgRow, dirAgChips, dirAgSection, dirMetaLine };`)(
  (l: string) => l.slice(0, 2).toUpperCase(), (t: number) => `t${t}`, () => 'date');

describe('directive screen', () => {
  it('reads exemptions from the directive and lifts one through the exemptions route', () => {
    expect(detail).toMatch(/x\.exemptions \|\| \[\]/);
    expect(detail).toMatch(/x\.exemptions_removed/);
    expect(detail).toContain("api(`${dp}/exemptions/${encodeURIComponent(e.id)}`, 'DELETE')");
    expect(js).toMatch(/function dirKeepOffSheet\(d, kept, anchor, onDone\) \{[\s\S]*?post\(`\/directives\/\$\{encodeURIComponent\(d\.id\)\}\/exemptions`, \{ target_kind: t\.kind, target_ref: t\.ref, note:/);
  });

  it('opens with one meta line, then Text, Kept off, Agents and History, with the kept-off count in the agent list', async () => {
    const { r } = await renderDetail();
    expect(r.b.startsWith('<div class="dir-meta">')).toBe(true);
    // The key–value card is gone: reach, version and date sit in the meta line and move to the agent list and History.
    expect(r.b).not.toContain('pcard kvc');
    expect(r.b).toContain('data-dgo="dirAg" title="Go to the agent list">All agents except team ECHO Research</button>');
    expect(r.b).toContain('data-dgo="dirHist" title="Go to History">v2, date</button>');
    const iText = r.b.indexOf('class="sec dir-text"'), iKept = r.b.indexOf('Kept off · 1'), iAgents = r.b.indexOf('id="dirAg"'), iHist = r.b.indexOf('id="dirHist"');
    expect(iText).toBeGreaterThan(0);
    expect(iKept).toBeGreaterThan(iText);
    expect(iAgents).toBeGreaterThan(iKept);
    expect(iHist).toBeGreaterThan(iAgents);
    // The labels and lines that only repeat the page are gone: the meta line names the reach, the agent count explains confirmation (as a tooltip).
    for (const gone of ['<h4>Text', '<h4>Agents', '<h4>History', 'dag-intro', 'Applies to', 'kept off above']) expect(r.b).not.toContain(gone);
    expect(r.b).toContain('aria-live="polite" title="Agents confirm a version when they read it."><b>1</b> of 1 agent</span>');
    // Kept off keeps its heading (it carries a count); the agent list and History stand under a divider, still named for assistive tech.
    expect(r.b).toContain('class="sec dir-sec" id="dirAg" tabindex="-1" aria-label="Agents"');
    expect(r.b).toContain('class="sec dir-sec" id="dirHist" tabindex="-1" aria-label="History"');
    expect(r.b).toContain('Team ECHO Research');
    expect(r.b).toContain('By Ben · they log elsewhere, t3000 ago');
    expect(r.b).toContain('data-dir-again="dex_1"');
    expect(r.here.meta).toBe('All agents except team ECHO Research · v2 · 1 of 1 read');
  });

  it('offers Keep off… in the actions bar and the dbar menu to admins only', async () => {
    const a = await renderDetail(true);
    expect(a.r.a).toContain('id="dirKeepOff"');
    expect(a.r.dbar.menu.filter(Boolean).map((m: { label: string }) => m.label)).toEqual(['Edit', 'Keep off…', 'Retire']);
    // Its own glyph (a circle with a bar), not the close ✕ nor Retire's ⊘.
    expect(a.r.a).toMatch(/id="dirKeepOff"[^>]*><svg class="i[^"]*"><use href="#i-off"/);
    expect(a.r.dbar.menu.find((m: { label: string } | null) => m?.label === 'Keep off…').icon).toBe('off');
    expect(readFileSync(join(process.cwd(), 'public', 'index.html'), 'utf8')).toContain('<symbol id="i-off" viewBox="0 0 24 24">');
    const m = await renderDetail(false);
    expect(m.r.a).not.toContain('dirKeepOff');
    expect(m.r.b).not.toContain('data-dir-again');
    expect(m.r.dbar.menu.filter(Boolean).map((x: { label: string }) => x.label)).not.toContain('Keep off…');
    // An agent-scoped directive is retired instead: no Keep off.
    const own = await renderDetail(true, { ...DETAIL, directive: { ...DETAIL.directive, scope_kind: 'agent', scope_ref: 'ag_1', scope_label: 'agent scribe', reach_label: 'Agent scribe' } });
    expect(own.r.a).not.toContain('dirKeepOff');
  });

  it('interleaves exemption events with versions in History, newest first', async () => {
    const { r } = await renderDetail();
    const h = r.b.slice(r.b.indexOf('id="dirHist"'));
    const order = ['Kept off team ECHO Research', 'Applied again to project APPS', 'v2 · Log every call', 'Kept off project APPS', 'v1 · Log calls'].map((s) => h.indexOf(s));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((p, q) => p - q)).toEqual(order);
    // The author leads the meta, so it survives truncation on phones; the note follows.
    expect(h).toContain('By Ben · they log elsewhere');
    expect(h).not.toContain('they log elsewhere · by');
  });

  it('a retired directive lists its exemptions under History only, with no agent list', async () => {
    const { r } = await renderDetail(true, { ...DETAIL, coverage: [], kept_off: 0, directive: { ...DETAIL.directive, status: 'retired' } });
    expect(r.b).not.toContain('Kept off · ');
    expect(r.b).toContain('Kept off team ECHO Research');
    expect(r.a).not.toContain('dirKeepOff');
    expect(r.b).not.toContain('id="dirAg"');
    // The reach is plain text (there is no list to go to) and the line says it is retired.
    expect(r.b).not.toContain('data-dgo="dirAg"');
    expect(r.b).toContain('<span class="dms"><span>retired</span></span>');
  });

  it('a rule waiting for review offers no Keep off, shows its proposed category and keeps the review card under the meta line', async () => {
    const { r } = await renderDetail(true, { ...DETAIL, directive: { ...DETAIL.directive, reviewed_at: null, proposed_category: 'tokens', reported_by_label: 'scribe', source: 'AGENTS.md' } });
    expect(r.a).not.toContain('dirKeepOff');
    expect(r.dbar.menu.filter(Boolean).map((m: { label: string }) => m.label)).toEqual(['Keep as is', 'Edit', 'Retire']);
    expect(r.b).toContain('<span class="warn-t">Proposed: Token economy</span>');
    expect(r.b.indexOf('dir-review')).toBeGreaterThan(r.b.indexOf('dir-meta'));
    expect(r.b.indexOf('dir-review')).toBeLessThan(r.b.indexOf('class="sec dir-text"'));
    // The review card tells who registered it, so History's v1 row does not repeat it yet.
    expect(r.b.slice(r.b.indexOf('id="dirHist"'))).not.toContain('Registered by');
  });

  it('once reviewed, History dates each row and its v1 row says who registered the rule and from where', async () => {
    const { r } = await renderDetail(true, { ...DETAIL, directive: { ...DETAIL.directive, category: 'process', reported_by_label: 'scribe', source: 'AGENTS.md' } });
    const h = r.b.slice(r.b.indexOf('id="dirHist"'));
    expect(h).toContain('Registered by scribe from AGENTS.md');
    expect(h).toContain('<span>date</span>');
    expect(h).not.toMatch(/ ago</);
    expect(r.b).toContain('<a href="#directives/c=process" data-dirs="c=process">Process &amp; workflow</a>');
    // The hub stores "created" as v1's note: it reads as none, so v1 still names who registered it; other notes start with a capital.
    const v = [{ version: 2, title: 'Log every call', change_note: 'sharper', created_at: 2000 }, { version: 1, title: 'Log calls', change_note: 'created', created_at: 1000 }];
    const c = (await renderDetail(true, { ...DETAIL, versions: v, directive: { ...DETAIL.directive, reported_by_label: 'scribe', source: null } })).r.b;
    expect(c).toContain('Registered by scribe<');
    expect(c).toContain('Sharper');
    expect(c).not.toContain('>created<');
    expect((await renderDetail(true, { ...DETAIL, versions: v })).r.b).toContain('>Created<');
  });

  it('takes its agent-list filters from the route after the id', async () => {
    const { r, calls } = await renderDetail(true, DETAIL, 'dir_hub&aq=nobody');
    expect(calls).toEqual(['/directives/dir_hub']);
    expect(r.b).toContain('value="nobody"');
    expect(r.b).toContain('No agent matches these filters');
  });
});

describe('keep-off sheet', () => {
  // dirScopeFields reads the hub's projects (GET /api/directives/projects): chosen by id, each with the members of its live teams.
  const fields = `${decl('const dirProj = ')}\n${decl('function dirScopeFields(')}`;
  const DIR_PROJ = [{ id: 'prj_apps', key: 'APPS', name: 'Apps', status: 'active', agent_ids: ['ag_1'] }, { id: 'prj_ops', key: 'OPS', name: 'Ops', status: 'active', agent_ids: ['ag_3'] },
    { id: 'prj_old', key: 'OLD', name: 'Old', status: 'closed', agent_ids: [] }];
  const scope = (cur: unknown, o: unknown) => {
    const S = { agents: [{ id: 'ag_1', label: 'scribe', project: 'APPS', status: 'active' }, { id: 'ag_2', label: 'clerk', project: null, status: 'active' }],
      teams: [{ id: 'team_bz', name: 'ECHO Research', status: 'running' }, { id: 'team_cd', name: 'Conclave Developers', status: 'running' }] };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    return new Function('S', 'DIR_PROJ', `${helpers}\n${fields}\nreturn dirScopeFields;`)(S, DIR_PROJ)(cur, o).html as string;
  };
  const kinds = (html: string) => [...html.matchAll(/<option value="(\w+)"/g)].map((m) => m[1]);

  it('offers only agent, team and project, and leaves out the own target and what it is already kept off', () => {
    const sheet = decl('function dirKeepOffSheet(');
    expect(sheet).toContain("only: ['agent', 'team', 'project']");
    expect(sheet).toContain('{ kind: d.scope_kind, ref: d.scope_ref }');
    const html = scope({ kind: 'agent', ref: null }, { only: ['agent', 'team', 'project'], skip: [{ kind: 'team', ref: 'team_cd' }], label: 'Keep it off' });
    expect(kinds(html)).toEqual(['agent', 'team', 'project']);
    expect(html).toContain('Keep it off');
    // The other choices are filled by bind(); the skip list and the keep filter are applied to them in the source.
    expect(fields).toContain('opts[k] = opts[k].filter(([v]) => !skip.some((s) => s.kind === k && s.ref === v) && (!keep || keep(k, v)))');
  });

  /* The sheet itself, with fbSheet stubbed: the choices it offers per kind, and what onGo does with the hub's answer. */
  const S2 = { agents: [{ id: 'ag_1', label: 'scribe', status: 'active' }, { id: 'ag_2', label: 'clerk', status: 'active' }, { id: 'ag_3', label: 'ops', status: 'active' }],
    teams: [{ id: 'team_bz', name: 'ECHO Research', status: 'running', agent_ids: ['ag_1', 'ag_2'] }, { id: 'team_cd', name: 'Conclave Developers', status: 'running', agent_ids: ['ag_3'] },
      { id: 'team_mx', name: 'Mixed', status: 'running', agent_ids: ['ag_2', 'ag_3'] }] };
  const openKeepOff = async (d: Record<string, unknown>, post: (p: string, b: unknown) => Promise<unknown>) => {
    const el: Record<string, { value?: string; innerHTML?: string; hidden?: boolean; onchange?: () => void }> = { '#dsK': { value: 'agent' }, '#dsR': { value: '' }, '#dsRF': {} };
    let go: ((sh: unknown) => Promise<unknown>) | null = null;
    const toasts: string[] = [];
    const stubs = { S: S2, DIR_PROJ, dirLoadProjects: async () => DIR_PROJ, $: (s: string) => el[s], fbSheet: (o: { onGo: typeof go }) => { go = o.onGo; return {}; }, fbArea: () => '', fbVal: () => '', post, toast: (t: string) => toasts.push(t) };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const sheet = new Function(...Object.keys(stubs), `${helpers}\n${fields}\n${decl('function dirScopeAgents(')}\n${decl('async function dirKeepOffSheet(')}\nreturn dirKeepOffSheet;`)(...Object.values(stubs));
    await sheet(
      { id: 'dir_x', title: 'X', ...d }, [], null, () => toasts.push('done'));
    const choices = (kind: string) => { el['#dsK'].value = kind; el['#dsK'].onchange!(); return [...String(el['#dsR'].innerHTML).matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]); };
    const pick = (kind: string, ref: string) => { el['#dsK'].value = kind; el['#dsR'].value = ref; };
    return { choices, pick, go: () => go!({}), toasts };
  };

  it('for a team scope offers only its members, their projects and teams that share a member', async () => {
    const s = await openKeepOff({ scope_kind: 'team', scope_ref: 'team_bz' }, async () => ({}));
    expect(s.choices('agent')).toEqual(['ag_1', 'ag_2']);
    expect(s.choices('team')).toEqual(['team_mx']);
    expect(s.choices('project')).toEqual(['prj_apps']);
  });

  it('for a project scope offers its agents and the teams they are in; a hub scope offers everything', async () => {
    const p = await openKeepOff({ scope_kind: 'project', scope_ref: 'prj_ops' }, async () => ({}));
    expect(p.choices('agent')).toEqual(['ag_3']);
    expect(p.choices('team')).toEqual(['team_cd', 'team_mx']);
    expect(p.choices('project')).toEqual([]);
    const h = await openKeepOff({ scope_kind: 'hub', scope_ref: null }, async () => ({}));
    expect(h.choices('agent')).toEqual(['ag_1', 'ag_2', 'ag_3']);
    expect(h.choices('team')).toEqual(['team_bz', 'team_cd', 'team_mx']);
    // A project is its id and its agents come from its live teams; a closed project is not offered.
    expect(h.choices('project')).toEqual(['prj_apps', 'prj_ops']);
  });

  it('waits for the hub: a refusal stays in the sheet, a success closes it with a toast', async () => {
    const no = await openKeepOff({ scope_kind: 'team', scope_ref: 'team_bz' }, async () => { throw new Error('Keeping it off team Mixed changes nothing'); });
    no.pick('team', 'team_mx');
    expect(await no.go()).toEqual(['Keeping it off team Mixed changes nothing', 'dsR']);
    expect(no.toasts).toEqual([]);
    const sent: unknown[] = [];
    const ok = await openKeepOff({ scope_kind: 'team', scope_ref: 'team_bz' }, async (p, b) => { sent.push([p, b]); return { exemption: { label: 'agent clerk' }, lost: 1 }; });
    ok.pick('agent', 'ag_2');
    expect(await ok.go()).toBeUndefined();
    expect(sent).toEqual([['/directives/dir_x/exemptions', { target_kind: 'agent', target_ref: 'ag_2', note: null }]]);
    expect(ok.toasts).toEqual(['Kept off agent clerk; 1 agent told to stop', 'done']);
    const none = await openKeepOff({ scope_kind: 'team', scope_ref: 'team_bz' }, async () => ({}));
    none.pick('agent', '');
    expect(await none.go()).toEqual(['Choose what to keep it off.', 'dsR']);
  });

  it('the directive form still offers every scope kind', () => {
    expect(kinds(scope({ kind: 'hub', ref: null }, undefined))).toEqual(['hub', 'project', 'team', 'role', 'agent']);
  });
});

describe('Work → Directives list', () => {
  const dirRow = decl('function dirRow(d, f) {');
  const render = (d: Record<string, unknown>) => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    return new Function(`${helpers}\n${dirRow}\nreturn dirRow;`)()({ id: 'dir_hub', title: 'Log every call', body: 'Log it.', status: 'active', reviewed_at: 1, scope_kind: 'hub', scope_label: 'all agents', agents: 3, current: 3, ...d }, { d: '', g: '' }) as string;
  };
  it('row meta uses reach_label when a rule is kept off somewhere', () => {
    expect(dirRow).toContain('d.reach_label');
    const h = render({ reach_label: 'All agents except team ECHO Research', except_label: 'Except team ECHO Research', exempt_count: 1 });
    expect(h).toContain('<span class="only-d">Except team ECHO Research · </span>');
    expect(h).toContain('<span class="only-m">All agents except team ECHO Research · </span>');
    expect(h).toContain('title="All agents except team ECHO Research"');
  });
  it('the except part comes from except_label, not from parsing reach_label', () => {
    // A team named "All except ops": its scope label holds the word, the except part is still only the exemptions.
    const h = render({ scope_kind: 'team', scope_label: 'team All except ops', reach_label: 'Team All except ops except agent scribe', except_label: 'Except agent scribe', exempt_count: 1 });
    expect(h).toContain('<span class="only-d">Except agent scribe · </span>');
    expect(h).not.toContain('Except ops');
  });
  it('a rule kept off nowhere reads as before', () => {
    const h = render({ reach_label: 'All agents', exempt_count: 0 });
    expect(h).not.toContain('Except');
    expect(h).toContain('<span class="only-m">All agents · </span>');
  });
  it('search matches the reach', () => {
    expect(decl('const dirMatch = ')).toContain('d.reach_label || d.scope_label');
  });
});

describe('agent page Directives card', () => {
  const overview = block('    overview: () => {', '\n    keys: () => ({');
  it('reads exempted into a muted "Kept off k rules" line that opens a short list', () => {
    const card = block("{ key: 'directives', col: 1, narrow: 6,", "{ key: 'tell',");
    expect(card).toContain('dv.exempted?.length');
    expect(card).toContain("title: `Kept off ${plural(dv.exempted.length, 'rule')}`");
    expect(card).toContain("cls: 'ag-kept'");
    expect(js).toContain("api('/agents/' + u + '/directives')");
    expect(overview).toContain('dv.exempted?.length');
    expect(css).toContain('.lrow.ag-kept .lrow-title{color:var(--muted)}');
    // The list: one row per kept-off rule, naming the exemption; a row opens the directive.
    expect(js).toMatch(/on\('\[data-ag-kept\]', \(e\) => \{ const sh = openSheet\(\{ title: `Kept off \$\{a\.label\}`/);
    expect(js).toContain("openD('directive', b.dataset.agKeptDir)");
    expect(js).toContain('Kept off ${x.exemption.label}');
  });
  it('a failed directives call still gives an empty exempted list', () => {
    expect(js).toContain(".catch(() => ({ directives: [], reports: [] }))");
    // exempted is read with ?. and || [] so the fallback above renders no line.
    expect(js).toContain('(dv.exempted || [])');
  });
});

describe('directive agent list', () => {
  type C = { agent_id: string; label: string; read: string; version: number | null; acked_at: number | null; teams: { id: string; name: string; role: string }[] };
  const CD = { id: 'team_cd', name: 'Conclave Developers' }, BZ = { id: 'team_bz', name: 'ECHO Research' };
  const COV: C[] = [
    { agent_id: 'ag_1', label: 'scribe', read: 'current', version: 2, acked_at: 5, teams: [{ ...CD, role: 'worker' }] },
    { agent_id: 'ag_2', label: 'clerk', read: 'unread', version: null, acked_at: null, teams: [{ ...BZ, role: 'coordinator' }] },
    { agent_id: 'ag_3', label: 'ops', read: 'outdated', version: 1, acked_at: 4, teams: [{ ...CD, role: 'coordinator' }, { ...BZ, role: 'worker' }] },
    { agent_id: 'ag_4', label: 'alpha', read: 'unread', version: null, acked_at: null, teams: [] },
  ];
  const body = (f: Record<string, unknown>) => H.dirAgBody(COV, { q: '', at: [], as: '', ...f }) as string;
  const order = (h: string) => [...h.matchAll(/data-ses="([^"]+)"/g)].map((m) => m[1]);
  const count = (h: string) => /<span class="lov-n"[^>]*>(.*?)<\/span><\/div>/.exec(h)?.[1].replace(/<[^>]+>/g, '');

  it('sorts not confirmed first, then out of date, then confirmed, and puts "n of m agents" in the list overline', () => {
    const h = body({});
    expect(order(h)).toEqual(['ag_4', 'ag_2', 'ag_3', 'ag_1']);
    expect(h).toContain('<div class="overline lov"><span class="lov-n" tabindex="-1" aria-live="polite" title="Agents confirm a version when they read it."><b>4</b> of 4 agents');
    expect(count(h)).toBe('4 of 4 agents · 2 not confirmed');
    // No state chip row and no Clear filters link: the state is a chip in the box, picked in Filters.
    expect(h).not.toMatch(/data-dag-st|dag-cnt|data-dag-clr|dl-cats/);
  });

  it('each row names its teams and roles, when it confirmed, and its state', () => {
    const h = H.dirAgRow(COV[2]) as string;
    expect(h).toContain('Conclave Developers · coordinator, ECHO Research · worker · confirmed v1 t4 ago');
    expect(h).toContain('Out of date · v1');
    expect(h).toContain('role="listitem"');
    expect(H.dirAgRow(COV[3])).toContain('has not confirmed it');
  });

  it('the Team filter keeps the agents of the chosen teams, and the count follows', () => {
    const h = body({ at: ['team_bz'] });
    expect(order(h)).toEqual(['ag_2', 'ag_3']);
    expect(count(h)).toBe('2 of 4 agents · 1 not confirmed');
    expect(h).not.toContain('data-dag-clr');
    expect(order(body({ at: ['team_bz', 'team_cd'] }))).toEqual(['ag_2', 'ag_3', 'ag_1']);
  });

  it('a state filter keeps that state; "not confirmed" is left out of the count when it is the filter', () => {
    const h = body({ as: 'unread' });
    expect(order(h)).toEqual(['ag_4', 'ag_2']);
    expect(count(h)).toBe('2 of 4 agents');
  });

  it('search matches the label, the agent id and the role; no match shows an empty state with Clear search and filters', () => {
    expect(order(body({ q: 'coord' }))).toEqual(['ag_2', 'ag_3']);
    expect(order(body({ q: 'ag_1' }))).toEqual(['ag_1']);
    const h = body({ q: 'zzz' });
    expect(order(h)).toEqual([]);
    expect(h).toContain('No agent matches these filters');
    expect(h).toContain('data-dag-clr>Clear search and filters');
  });

  it('draws one toolbar row: the search box with a chip per team and the state, then Filters', () => {
    const f = { q: 'ops', at: ['team_bz', 'team_cd'], as: 'outdated' };
    expect(H.dirAgChips(COV, f)).toEqual([
      { label: 'ECHO Research', name: 'Remove team ECHO Research', attrs: 'data-dag-rm="t:team_bz"' },
      { label: 'Conclave Developers', name: 'Remove team Conclave Developers', attrs: 'data-dag-rm="t:team_cd"' },
      { label: 'Out of date', name: 'Remove the state filter Out of date', attrs: 'data-dag-rm="as"' },
    ]);
    expect(H.dirAgChips(COV, { q: 'ops', at: [], as: '' })).toEqual([]);
    const sec = H.dirAgSection({}, COV, f) as string;
    expect(sec).toContain('<div class="ltb"><form class="srch csrch" role="search" id="dagQ">');
    expect(sec).toContain('aria-label="Remove team ECHO Research">ECHO Research');
    expect(sec).toContain('data-cs-more data-cs-filt="dagMore" hidden>');
    expect(sec).toContain('value="ops"');
    expect(sec).toContain('aria-label="Clear search and filters"');
    expect(sec).toMatch(/<\/form><button type="button" class="btn on" id="dagMore" aria-haspopup="dialog">[^]*· 3<\/span><\/button><\/div>/);
    expect(sec).not.toMatch(/dagTeam|only-m|only-d/);
    // Filters holds Team and the states, at every width; changes swap the chips in place.
    const sheet = decl('function dirAgSheet(');
    expect(sheet).toContain('<legend class="vlabel">Team</legend>');
    expect(sheet).toContain('<legend class="vlabel">State</legend>');
    expect(sheet).not.toContain('phone');
    expect(decl('function dirAgBind(')).toContain("const ch = dirAgChips(C, f); csrchSet(form, ch, DAG_MORE); setFilterCount('dagMore', ch.length); dirAgRoute(f);");
    expect(decl('function dirAgBind(')).toContain("set(k === 'as' ? { as: '' } : { at: f.at.filter((id) => id !== k.slice(2)) }); q?.focus();");
  });

  it('reads and writes only aq, at and as, each well formed', () => {
    expect(H.dirAgArgs('aq=Ops&at=team_a,bad!&as=unread&x=1')).toEqual({ q: 'ops', at: ['team_a'], as: 'unread' });
    expect(H.dirAgArgs('as=nope')).toEqual({ q: '', at: [], as: '' });
    expect(H.dirAgOk('')).toBe(true);
    expect(H.dirAgOk('aq=x&at=team_a,team_b&as=outdated')).toBe(true);
    for (const bad of ['zz=1', 'as=nope', 'at=bad!', `aq=${'x'.repeat(101)}`]) expect(H.dirAgOk(bad), bad).toBe(false);
    expect(H.dirAgStr({ q: 'ops', at: ['team_a', 'team_b'], as: 'unread' })).toBe('aq=ops&at=team_a%2Cteam_b&as=unread');
    expect(H.dirAgStr({ q: '', at: [], as: '' })).toBe('');
    expect(H.dirAgSplit('dir_x&aq=a&as=unread')).toEqual(['dir_x', 'aq=a&as=unread']);
    expect(H.dirAgSplit('team_a|dir_x|members')).toEqual(['team_a|dir_x|members', '']);
  });

  it('routes carry the filters: #directive and #tdir after the id, #directives beside the list keys while a directive is open', () => {
    expect(js).toContain('directive: (a) => { const [i, k] = dirAgSplit(a); return RID.test(i) && dirAgOk(k); }');
    expect(js).toContain("tdir: (a) => { const [b, k] = dirAgSplit(a), p = b.split('|'); return dirAgOk(k) &&");
    // The route region is self-contained (console-nav.test.ts runs it alone), so its tdir parent strips the keys itself.
    expect(js).toContain("tdir: { parent: (a) => { const [t, , k] = String(a).split('&')[0].split('|');");
    expect(js).toContain("const [b, k] = dirAgSplit(arg), [, id] = b.split('|'), r = await dirDetail(id + (k ? '&' + k : ''));");
    // Side by side, #directive/<id>&… opens in the list's pane with the same filters.
    expect(js).toContain("arg = dirArgStr({ ...f, d: i, aq: g.q, at: g.at.join(','), as: g.as });");
    expect(js).toContain("r = await dirDetail(id, dirAgArgs(DR.type === 'directives' ? DR.arg : ''));");
    // Choosing another directive in the list starts its agent list unfiltered.
    expect(js).toContain("dirSet({ d: id, aq: '', at: '', as: '' });");
    const args = ['const DIR_KINDS = ', 'const DIR_READS = ', 'const DIR_GROUPS = ', 'function dirArgs(', 'function dirArgStr('].map(decl).join('\n');
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const L = new Function(`${helpers}\n${args}\nreturn { dirArgs, dirArgStr };`)();
    expect(L.dirArgs('d=dir_x&as=unread&at=team_a')).toMatchObject({ d: 'dir_x', as: 'unread', at: 'team_a' });
    expect(L.dirArgs('as=unread')).toBeNull();
    expect(L.dirArgs('d=dir_x&as=nope')).toBeNull();
    expect(L.dirArgStr({ ...L.dirArgs(''), d: 'dir_x', aq: 'ops', as: 'unread' })).toBe('d=dir_x&aq=ops&as=unread');
    expect(L.dirArgStr({ ...L.dirArgs(''), aq: 'ops' })).toBe('');
  });

  it('the meta line links each part', () => {
    const h = H.dirMetaLine({ reach_label: 'Team Conclave Developers', scope_label: 'team Conclave Developers', category: 'tokens', version: 3, updated_at: 1, tags: ['cost'] }, { active: true, pending: false }) as string;
    expect(h).toBe('<div class="dir-meta"><span class="dms"><button type="button" class="lnk" data-dgo="dirAg" title="Go to the agent list">Team Conclave Developers</button></span>'
      + '<span class="dms"><a href="#directives/c=tokens" data-dirs="c=tokens">Token economy</a></span>'
      + '<span class="dms"><button type="button" class="lnk" data-dgo="dirHist" title="Go to History">v3, date</button></span>'
      + '<span class="dms"><span class="dir-tags"><a class="tag txt" href="#directives/t=cost" data-dirs="t=cost">#cost</a></span></span></div>');
    expect(css).toContain(".dir-meta .dms:not(:last-child)::after{content:'·'");
    expect(css).not.toMatch(/\.dag-chips|\.dag-flt|\.dag-cnt/);
  });
});

describe('the directive edit sheet', () => {
  it('offers a minor edit when editing, sends minor: true, and refuses it with a scope change', () => {
    const sheet = js.slice(js.indexOf('async function dirSheet('), js.indexOf('async function dirSheet(') + 8000);
    expect(sheet).toContain(`<input type="checkbox" id="dsMinor"> Minor edit, don't ask agents to re-read`);
    expect(sheet).toContain("...(minor ? { minor: true } : {})");
    expect(sheet).toContain('A minor edit cannot change what the directive applies to.');
  });
});
