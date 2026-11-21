/**
 * The team request the connector files for an agent (`conclave setup schema | request`): its schema, the checks the hub
 * also applies (the hub stays the judge), the one-screen summary, and the shell quoting the start lines use.
 * No dependencies; nothing here touches the PC.
 */
import { platform } from 'node:os';

const WIN = platform() === 'win32';
const SECRET_RE = /(ah_(app|ses)_[a-z2-7]{12}_\S+|cnv_enrol_[a-z2-7]{26}|cnc-pair-[a-z2-7]{26}|cnv_key_[a-z2-7]{26})/gi;
const LIMITS = { roles: 8, agents: 12, per_role: 5, rules: 20, requirements: 30, lines: 10, per_line: 10, papers: 20 };
const PAPER_STATUSES = ['planned', 'drafting', 'submitted', 'accepted', 'published'];
const PAPER_TYPES = ['paper', 'preprint', 'report', 'thesis'];
const LOCAL_ID = /^[a-z0-9][a-z0-9_-]{0,19}$/;
const NFR_CATEGORIES = ['perf', 'sec', 'rel', 'use', 'ops'];
const RULE_CATEGORIES = ['access', 'communication', 'tokens', 'reporting', 'sources', 'process', 'tooling'];
const TEAM_ROLES = ['coordinator', 'worker', 'reviewer', 'stakeholder'];
export const SCHEMA = {
  kind: '"new_team" (default), "add_agents", or "vault_agent" (one agent with no team that edits a person\'s shared vault notes; it takes only agent, folders, prompt and client)',
  agent: 'vault_agent only: { name: 1-60 chars, ^[A-Za-z0-9][A-Za-z0-9 ._-]*$, job: 1-500 chars one line }',
  folders: 'vault_agent only: 1-10 of { path: "/vault/...", access: "read"|"write" }. A proposal: the administrator picks the person the agent works for, and only folders that person was given can be granted',
  project: '{ name: 1-80 chars, ^[A-Za-z0-9][A-Za-z0-9 ._-]*$, existing: boolean, kind?: "implementation"|"research" (a new project: ask the user; an existing project supplies its own), more_teams?: boolean (new_team only: true when more teams will join this project, so this team gets its own Blueprint part; default false, and the only team of the project keeps its whole Blueprint at project level. Ask the user) }',
  team: '{ name (new_team) | id (add_agents), goal: 1-4000 chars, delivery_mode?: "on_demand"|"poll", close_on_approve?: bool, coordinator_reviews?: bool, lease_minutes?: 1-1440, stall_minutes?: 1-1440, max_review_rounds?: 1-20 }',
  roles: `1-${LIMITS.roles} of { name: ^[a-z][a-z0-9_]{0,29}$, team_role: "coordinator"|"worker"|"reviewer"|"stakeholder", count: 1-${LIMITS.per_role}, job: 1-500 chars one line, reviews?: [role names], folders?: [{ path: "/vault/...", access: "read"|"write" }] }; new_team: exactly one coordinator with count 1; at most ${LIMITS.agents} agents`,
  rules: `optional, 0-${LIMITS.rules} of { title: 1-120 chars one line, source: 1-200 chars one line (where the rule comes from: "AGENTS.md", "CLAUDE.md", "the user"), text: 1-2000 chars (the rule as written), category?: ${RULE_CATEGORIES.map((c) => `"${c}"`).join('|')}, role?: a team_role of a role in the request (omit: the whole team) }. Fill it from the repo's AGENTS.md and CLAUDE.md files and the user's own instructions: one entry per rule the agents should follow. The administrator ticks the ones to keep; they become the team's directives. Keep rules out of team.goal: the goal says what the team achieves`,
  requirements: `optional, new_team only, 0-${LIMITS.requirements} of { kind: "fr" (what the team's work must do) | "nfr" (a quality: speed, security, reliability, usability, operations), title: 1-200 chars one line, text: 1-2000 chars, category: ${NFR_CATEGORIES.map((c) => `"${c}"`).join('|')} (nfr only, required), acs?: 0-10 acceptance criteria, each 1-300 chars one line }. Fill it from the repo's specification or the user's own words; the administrator ticks the ones to keep and reviews them in the team's Blueprint part`,
  source: 'new_team: { from: "existing" (a source that exists: ref is its path or URL, 1-400 chars one line) | "coordinator" (the team\'s coordinator derives them) | "operator" (the user supplies them later), ref?, note?: at most 500 chars }. Ask the user where the requirements or the research brief come from. A ref is information for the team, not a permission to read it',
  research: `optional, new_team only: { lines: 0-${LIMITS.lines} of { id: ^[a-z0-9][a-z0-9_-]{0,19}$, title: 1-200 chars one line, mode: "validate"|"explore", question?: at most 2000 chars, owner?: a role name, hypotheses?: 0-${LIMITS.per_line} of { id, title: the statement, criteria? } (validate lines only), questions?: 0-${LIMITS.per_line} of { title, criteria? } }, papers: 0-${LIMITS.papers} of { title, status: ${PAPER_STATUSES.join('|')}, venue?, type?: ${PAPER_TYPES.join('|')}, manuscript?: a path or URL, authors?: names, owner?: a role name, hypotheses?: [hypothesis ids] } }. Lines need a research project; papers fit either. A planned paper needs only a title; never write claims. Requirements and research records count together against the requirements limit`,
  prompt: "1-4000 chars: the user's own words",
  client: '{ app, os }: at most 40 chars each',
};
export const EXAMPLE = {
  kind: 'new_team',
  project: { name: 'Grants', existing: false },
  team: { name: 'Grant calendar', goal: 'Keep the grant calendar current: deadlines, owners and status.' },
  roles: [
    { name: 'coordinator', team_role: 'coordinator', count: 1, job: 'Plans the work and assigns tasks.' },
    { name: 'writer', team_role: 'worker', count: 1, job: 'Writes and updates calendar entries.', folders: [{ path: '/vault/Grants', access: 'write' }] },
    { name: 'reviewer', team_role: 'reviewer', count: 1, job: 'Reviews each entry before it is done.', reviews: ['writer'] },
  ],
  rules: [
    { title: 'Dates in ISO format', source: 'AGENTS.md', text: 'Write every date as YYYY-MM-DD.', category: 'process' },
    { title: 'Check each deadline against the funder page', source: 'the user', text: 'Before an entry is done, open the funder page and compare the deadline.', category: 'sources', role: 'reviewer' },
  ],
  requirements: [
    { kind: 'fr', title: 'Every deadline has an owner', text: 'Each calendar entry names the person who owns the deadline.', acs: ['No entry is done without an owner.'] },
    { kind: 'nfr', title: 'Entries are current within a day', text: 'A change on the funder page shows in the calendar within one working day.', category: 'rel' },
  ],
  source: { from: 'existing', ref: 'docs/specification.md', note: 'The calendar section.' },
  prompt: 'a team that keeps our grant calendar, with a writer and a reviewer',
  client: { app: 'claude-code', os: platform() },
};

/** The same rules the hub applies (the hub stays the judge, with its current limits); up to 20 problems. */
export function validateRequest(r) {
  const p = [];
  const add = (field, rule) => { if (p.length < 20) p.push({ field, rule }); };
  const isStr = (v, min, max) => typeof v === 'string' && v.length >= min && v.length <= max;
  const intIn = (v, a, b) => Number.isInteger(v) && v >= a && v <= b;
  if (!r || typeof r !== 'object' || Array.isArray(r)) return [{ field: 'body', rule: 'a JSON object' }];
  if (Buffer.byteLength(JSON.stringify(r)) > 32 * 1024) add('body', 'at most 32 KiB of JSON');
  const kind = r.kind ?? 'new_team';
  if (kind === 'vault_agent') {
    // One teamless agent for shared vault notes (docs/onboarding.md#a-vault-agent): no project, team, roles or rules.
    for (const k of Object.keys(r)) if (!['kind', 'agent', 'folders', 'prompt', 'client'].includes(k)) add(k, 'unknown field (vault_agent takes agent, folders, prompt and client)');
    const a = r.agent;
    if (!a || typeof a !== 'object' || Array.isArray(a)) add('agent', 'an object {name, job}');
    else {
      if (!isStr(a.name, 1, 60) || !/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(a.name)) add('agent.name', '1-60 characters, letters, digits, space . _ -, starting with a letter or digit');
      if (!isStr(a.job, 1, 500) || /[\r\n]/.test(a.job)) add('agent.job', '1-500 characters, one line');
      for (const k of Object.keys(a)) if (k !== 'name' && k !== 'job') add(`agent.${k}`, 'unknown field');
    }
    if (!Array.isArray(r.folders) || r.folders.length < 1 || r.folders.length > 10) add('folders', '1-10 {path, access}: the vault folders the agent asks for');
    else r.folders.forEach((d, j) => {
      const ff = `folders[${j}]`;
      if (!d || typeof d.path !== 'string' || !/^\/vault(\/|$)/.test(d.path) || d.path.length > 400 || d.path.split('/').includes('..') || /[*?[\]{}]/.test(d.path)) add(`${ff}.path`, 'absolute under /vault/, no .., no wildcards, at most 400 characters');
      if (!d || !['read', 'write'].includes(d.access)) add(`${ff}.access`, 'read or write');
    });
    if (!isStr(r.prompt, 1, 4000)) add('prompt', "1-4000 characters: the user's own words");
    return p;
  }
  if (!['new_team', 'add_agents'].includes(kind)) add('kind', 'new_team, add_agents or vault_agent');
  if (!r.project || typeof r.project !== 'object') add('project', '{name, existing}');
  else {
    if (!isStr(r.project.name, 1, 80) || !/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(r.project.name)) add('project.name', '1-80 characters, letters, digits, space . _ -, starting with a letter or digit');
    if (typeof r.project.existing !== 'boolean') add('project.existing', 'true or false');
    if (r.project.kind !== undefined && !['implementation', 'research'].includes(r.project.kind)) add('project.kind', 'implementation or research');
    if (r.project.more_teams !== undefined && typeof r.project.more_teams !== 'boolean') add('project.more_teams', 'true or false');
    if (r.project.more_teams !== undefined && kind !== 'new_team') add('project.more_teams', 'only for a new_team request');
  }
  const t = r.team;
  if (!t || typeof t !== 'object') add('team', 'an object');
  else {
    if (kind === 'add_agents') { if (!isStr(t.id, 1, 100)) add('team.id', 'the team id (add_agents)'); }
    else {
      if (!isStr(t.name, 1, 80)) add('team.name', '1-80 characters');
      if (!isStr(t.goal, 1, 4000)) add('team.goal', '1-4000 characters');
    }
    if (t.delivery_mode !== undefined && !['on_demand', 'poll'].includes(t.delivery_mode)) add('team.delivery_mode', 'on_demand or poll');
    for (const b of ['close_on_approve', 'coordinator_reviews']) if (t[b] !== undefined && typeof t[b] !== 'boolean') add(`team.${b}`, 'true or false');
    for (const [k, a, z] of [['lease_minutes', 1, 1440], ['stall_minutes', 1, 1440], ['max_review_rounds', 1, 20]]) if (t[k] !== undefined && !intIn(t[k], a, z)) add(`team.${k}`, `${a} to ${z}`);
  }
  const roles = Array.isArray(r.roles) ? r.roles : null;
  if (!roles || roles.length < 1 || roles.length > LIMITS.roles) add('roles', `1 to ${LIMITS.roles} roles`);
  if (roles) {
    const names = new Set(roles.map((x) => x?.name));
    let total = 0, coords = 0;
    roles.forEach((x, i) => {
      const f = `roles[${i}]`;
      if (!x || typeof x !== 'object') return add(f, 'an object');
      if (typeof x.name !== 'string' || !/^[a-z][a-z0-9_]{0,29}$/.test(x.name)) add(`${f}.name`, '^[a-z][a-z0-9_]{0,29}$');
      if (roles.filter((y) => y?.name === x.name).length > 1) add(`${f}.name`, 'unique in the request');
      if (!['coordinator', 'worker', 'reviewer', 'stakeholder'].includes(x.team_role)) add(`${f}.team_role`, 'coordinator, worker, reviewer or stakeholder');
      if (!intIn(x.count, 1, LIMITS.per_role)) add(`${f}.count`, `1 to ${LIMITS.per_role}`); else total += x.count;
      if (x.team_role === 'coordinator') { coords++; if (x.count !== 1) add(`${f}.count`, 'the coordinator has count 1'); }
      if (!isStr(x.job, 1, 500) || /[\r\n]/.test(x.job)) add(`${f}.job`, '1-500 characters, one line');
      if (x.reviews !== undefined) {
        if (!Array.isArray(x.reviews)) add(`${f}.reviews`, 'a list of role names');
        else for (const n of x.reviews) {
          if (!names.has(n)) add(`${f}.reviews`, `${n} is not a role in the request`);
          else if (n === x.name && !(x.count >= 2)) add(`${f}.reviews`, 'a role reviews itself only with count 2 or more');
          else if (roles.find((y) => y.name === n)?.team_role === 'coordinator' && !t?.coordinator_reviews) add(`${f}.reviews`, 'the coordinator reviews only with team.coordinator_reviews: true');
        }
      }
      if (x.folders !== undefined) {
        if (!Array.isArray(x.folders) || x.folders.length > 10) add(`${f}.folders`, 'at most 10 {path, access}');
        else x.folders.forEach((d, j) => {
          const ff = `${f}.folders[${j}]`;
          if (!d || typeof d.path !== 'string' || !/^\/vault(\/|$)/.test(d.path) || d.path.length > 400 || d.path.split('/').includes('..') || /[*?[\]{}]/.test(d.path)) add(`${ff}.path`, 'absolute under /vault/, no .., no wildcards, at most 400 characters');
          if (!d || !['read', 'write'].includes(d.access)) add(`${ff}.access`, 'read or write');
        });
      }
    });
    if (total > LIMITS.agents) add('roles', `${total} agents, at most ${LIMITS.agents}`);
    if (kind === 'new_team' && coords !== 1) add('roles', 'exactly one role with team_role "coordinator" (count 1)');
    if (kind === 'add_agents' && coords !== 0) add('roles', 'no coordinator role when adding agents');
  }
  if (r.rules !== undefined) {
    if (!Array.isArray(r.rules) || r.rules.length > LIMITS.rules) add('rules', `a list of at most ${LIMITS.rules} rules`);
    else {
      const teamRoles = new Set((Array.isArray(r.roles) ? r.roles : []).map((x) => x?.team_role));
      r.rules.forEach((x, i) => {
        const f = `rules[${i}]`;
        if (!x || typeof x !== 'object' || Array.isArray(x)) return add(f, 'an object {title, source, text, category?, role?}');
        const line = (v, max) => isStr(typeof v === 'string' ? v.trim() : v, 1, max) && !/[\r\n]/.test(v.trim());
        if (!line(x.title, 120)) add(`${f}.title`, '1-120 characters, one line');
        if (!line(x.source, 200)) add(`${f}.source`, '1-200 characters, one line: where the rule comes from');
        if (!isStr(typeof x.text === 'string' ? x.text.trim() : x.text, 1, 2000)) add(`${f}.text`, '1-2000 characters');
        if (x.category !== undefined && !RULE_CATEGORIES.includes(x.category)) add(`${f}.category`, RULE_CATEGORIES.join(', '));
        if (x.role !== undefined) {
          if (!TEAM_ROLES.includes(x.role)) add(`${f}.role`, 'a team role: coordinator, worker, reviewer or stakeholder');
          else if (kind === 'new_team' && !teamRoles.has(x.role)) add(`${f}.role`, 'the team_role of a role in the request');
        }
        for (const k of Object.keys(x)) if (!['title', 'source', 'text', 'category', 'role'].includes(k)) add(`${f}.${k}`, 'unknown field');
      });
    }
  }
  if (r.requirements !== undefined) {
    if (kind !== 'new_team') add('requirements', 'only in a new_team request');
    else if (!Array.isArray(r.requirements) || r.requirements.length > LIMITS.requirements) add('requirements', `a list of at most ${LIMITS.requirements} requirements`);
    else r.requirements.forEach((x, i) => {
      const f = `requirements[${i}]`;
      if (!x || typeof x !== 'object' || Array.isArray(x)) return add(f, 'an object {kind, title, text, category?, acs?}');
      const line = (v, max) => typeof v === 'string' && isStr(v.trim(), 1, max) && !/[\r\n]/.test(v.trim());
      if (!['fr', 'nfr'].includes(x.kind)) add(`${f}.kind`, 'fr or nfr');
      if (!line(x.title, 200)) add(`${f}.title`, '1-200 characters, one line');
      if (!isStr(typeof x.text === 'string' ? x.text.trim() : x.text, 1, 2000)) add(`${f}.text`, '1-2000 characters');
      if (x.kind === 'nfr' && !NFR_CATEGORIES.includes(x.category)) add(`${f}.category`, NFR_CATEGORIES.join(', '));
      if (x.kind === 'fr' && x.category !== undefined) add(`${f}.category`, 'only for an nfr');
      if (x.acs !== undefined) {
        if (!Array.isArray(x.acs) || x.acs.length > 10) add(`${f}.acs`, 'at most 10 acceptance criteria');
        else x.acs.forEach((a, j) => { if (!line(a, 300)) add(`${f}.acs[${j}]`, '1-300 characters, one line'); });
      }
      if (x.module !== undefined && (typeof x.module !== 'string' || !/^[A-Z]{2,6}$/.test(x.module))) add(`${f}.module`, 'a module key of the project, 2 to 6 capitals');
      for (const k of Object.keys(x)) if (!['kind', 'title', 'text', 'category', 'acs', 'module'].includes(k)) add(`${f}.${k}`, 'unknown field');
    });
  }
  const one = (v, max) => typeof v === 'string' && isStr(v.trim(), 1, max) && !/[\r\n]/.test(v.trim());
  if (r.source !== undefined) {
    const s = r.source;
    if (kind !== 'new_team') add('source', 'only in a new_team request');
    else if (!s || typeof s !== 'object' || Array.isArray(s)) add('source', '{from, ref?, note?}');
    else {
      if (!['existing', 'coordinator', 'operator'].includes(s.from)) add('source.from', 'existing, coordinator or operator');
      if (s.from === 'existing' && !one(s.ref, 400)) add('source.ref', 'the path or URL of the source, 1-400 characters, one line');
      if (s.from !== 'existing' && s.ref !== undefined) add('source.ref', 'only with from: existing');
      if (s.note !== undefined && !isStr(s.note, 1, 500)) add('source.note', 'at most 500 characters');
      for (const k of Object.keys(s)) if (!['from', 'ref', 'note'].includes(k)) add(`source.${k}`, 'unknown field');
    }
  }
  let records = Array.isArray(r.requirements) ? r.requirements.length : 0;
  if (r.research !== undefined) {
    const x = r.research;
    if (kind !== 'new_team') add('research', 'only in a new_team request');
    else if (!x || typeof x !== 'object' || Array.isArray(x)) add('research', '{lines, papers}');
    else {
      const ids = new Set(), hyps = new Set(), roles = new Set((r.roles ?? []).map((q) => q?.name));
      const id = (v, f) => { if (typeof v !== 'string' || !LOCAL_ID.test(v)) add(f, '^[a-z0-9][a-z0-9_-]{0,19}$'); else if (ids.has(v)) add(f, 'unique in the request'); else ids.add(v); };
      const owner = (v, f) => { if (v !== undefined && !roles.has(v)) add(f, 'a role name in the request'); };
      const lines = x.lines ?? [], papers = x.papers ?? [];
      if (!Array.isArray(lines) || lines.length > LIMITS.lines) add('research.lines', `at most ${LIMITS.lines} lines`);
      else lines.forEach((l, i) => {
        const f = `research.lines[${i}]`;
        if (!l || typeof l !== 'object') return add(f, 'an object {id, title, mode, ...}');
        records += 1;
        id(l.id, `${f}.id`);
        if (!one(l.title, 200)) add(`${f}.title`, '1-200 characters, one line');
        if (!['validate', 'explore'].includes(l.mode)) add(`${f}.mode`, 'validate or explore');
        if (l.question !== undefined && !isStr(l.question, 1, 2000)) add(`${f}.question`, 'at most 2000 characters');
        owner(l.owner, `${f}.owner`);
        for (const [key, max] of [['hypotheses', LIMITS.per_line], ['questions', LIMITS.per_line]]) {
          const L = l[key] ?? [];
          if (!Array.isArray(L) || L.length > max) { add(`${f}.${key}`, `at most ${max}`); continue; }
          if (key === 'hypotheses' && L.length && l.mode === 'explore') add(`${f}.hypotheses`, 'a line that explores has no hypotheses');
          L.forEach((h, j) => {
            const g = `${f}.${key}[${j}]`;
            records += 1;
            if (key === 'hypotheses') { id(h?.id, `${g}.id`); if (typeof h?.id === 'string') hyps.add(h.id); }
            if (!one(h?.title, 200)) add(`${g}.title`, '1-200 characters, one line');
            if (h?.criteria !== undefined && !isStr(h.criteria, 1, 2000)) add(`${g}.criteria`, 'at most 2000 characters');
          });
        }
      });
      if (Array.isArray(lines) && lines.length && r.project?.existing === false && r.project?.kind !== 'research') add('research.lines', 'lines need a research project: set project.kind "research"');
      if (!Array.isArray(papers) || papers.length > LIMITS.papers) add('research.papers', `at most ${LIMITS.papers} papers`);
      else papers.forEach((pp, i) => {
        const f = `research.papers[${i}]`;
        if (!pp || typeof pp !== 'object') return add(f, 'an object {title, status, ...}');
        records += 1;
        if (!one(pp.title, 200)) add(`${f}.title`, '1-200 characters, one line');
        if (!PAPER_STATUSES.includes(pp.status)) add(`${f}.status`, PAPER_STATUSES.join(', '));
        if (pp.type !== undefined && !PAPER_TYPES.includes(pp.type)) add(`${f}.type`, PAPER_TYPES.join(', '));
        if (pp.manuscript !== undefined && !one(pp.manuscript, 400)) add(`${f}.manuscript`, 'a path or URL, 1-400 characters, one line');
        if (pp.authors !== undefined && (!Array.isArray(pp.authors) || pp.authors.length > 20)) add(`${f}.authors`, 'at most 20 names');
        owner(pp.owner, `${f}.owner`);
        if (pp.hypotheses !== undefined) (Array.isArray(pp.hypotheses) ? pp.hypotheses : [null]).forEach((h, j) => { if (!hyps.has(h)) add(`${f}.hypotheses[${j}]`, 'the id of a hypothesis in research.lines'); });
        if (pp.claims !== undefined) add(`${f}.claims`, 'no claims: a paper\'s claims are the team\'s work');
      });
    }
  }
  if (records > LIMITS.requirements) add('requirements', `${records} records (requirements, lines, hypotheses, questions and papers together), at most ${LIMITS.requirements}`);
  if (!isStr(r.prompt, 1, 4000)) add('prompt', "1-4000 characters: the user's own words");
  if (r.client !== undefined) {
    if (!r.client || typeof r.client !== 'object') add('client', '{app, os}');
    else for (const k of ['app', 'os']) if (r.client[k] !== undefined && !isStr(r.client[k], 0, 40)) add(`client.${k}`, 'at most 40 characters');
  }
  if (SECRET_RE.test(JSON.stringify(r))) add('body', 'contains something that looks like a key or code; remove it');
  SECRET_RE.lastIndex = 0;
  return p;
}
/** The hub's warning (docs/onboarding.md#warnings): a goal that reads like a list of rules. */
export function goalHasRules(goal) {
  if (typeof goal !== 'string') return false;
  const lines = goal.split(/\r?\n/).filter((l) => /^\s*(?:[-*•]|\d+[.)])\s+\S/.test(l)).length;
  const words = (goal.match(/\b(?:never|always|must|do not|don't)\b/gi) ?? []).length;
  return lines >= 2 || words >= 3;
}
/** The one-screen summary the agent shows the user before filing. */
export function summary(r) {
  const lines = [];
  if (r.kind === 'vault_agent') {
    lines.push(`Vault agent: ${r.agent?.name}, with no team`, `Job: ${r.agent?.job}`);
    for (const d of r.folders ?? []) lines.push(`- ${d.path} (${d.access})`);
    lines.push('The folders are a proposal: the administrator picks the person it works for, and it can reach only folders that person shares.');
    return lines.join('\n');
  }
  lines.push(`Project: ${r.project?.name} (${r.project?.existing ? 'existing' : 'new'}${r.project?.kind ? `, ${r.project.kind}` : ''})`);
  if ((r.kind ?? 'new_team') === 'new_team') {
    const s = r.source, from = { existing: `The requirements or the brief come from an existing source: ${s?.ref}.`, coordinator: 'The coordinator derives the requirements or the brief.', operator: 'You supply the requirements or the brief later.' }[s?.from];
    lines.push(from || 'Warning: the request does not say where the requirements or the brief come from. Ask the user, and set `source`.');
    lines.push(r.project?.more_teams ? 'More teams will join: this team gets its own Blueprint part.' : "One team for now: the project's whole Blueprint stays at project level.");
  }
  lines.push((r.kind ?? 'new_team') === 'add_agents' ? `Add agents to team ${r.team?.id}` : `Team: ${r.team?.name} · ${r.team?.delivery_mode ?? 'on_demand'}`);
  if (r.team?.goal) lines.push(`Goal: ${r.team.goal}`);
  if (goalHasRules(r.team?.goal)) lines.push('Warning: the goal reads like a list of rules. Move the rules to `rules` and keep the goal to what the team achieves.');
  let n = 0;
  for (const x of r.roles ?? []) {
    n += x.count;
    const f = (x.folders ?? []).map((d) => `${d.path} (${d.access})`).join(', ');
    lines.push(`- ${x.name} × ${x.count} [${x.team_role}]: ${x.job}${x.reviews?.length ? ` · reviews ${x.reviews.join(', ')}` : ''}${f ? ` · folders ${f}` : ''}`);
  }
  lines.push(`${n} agent${n === 1 ? '' : 's'} in total. Folders and access are a proposal: the administrator sets the real access.`);
  if (r.rules?.length) {
    lines.push(`Rules for the team (${r.rules.length}; the administrator keeps the ones that become directives):`);
    for (const x of r.rules) lines.push(`- ${x.title} (${x.source}${x.role ? `, ${x.role}s` : ''})`);
  }
  if (r.requirements?.length) {
    lines.push(`Requirements (${r.requirements.length}; the administrator keeps the ones that go to the team's Blueprint part as one proposal):`);
    for (const x of r.requirements) lines.push(`- ${x.kind.toUpperCase()}${x.category ? ` ${x.category}` : ''}: ${x.title}${x.acs?.length ? ` · ${x.acs.length} acceptance criteria` : ''}`);
  }
  if (r.research?.lines?.length || r.research?.papers?.length) {
    lines.push('Research (the administrator keeps the ones that join the same proposal):');
    for (const l of r.research.lines ?? []) lines.push(`- Line (${l.mode}): ${l.title}${l.hypotheses?.length ? ` · ${l.hypotheses.length} hypotheses` : ''}${l.questions?.length ? ` · ${l.questions.length} questions` : ''}${l.owner ? ` · ${l.owner}` : ''}`);
    for (const p of r.research.papers ?? []) lines.push(`- Paper (${p.status}): ${p.title}${p.manuscript ? ` · ${p.manuscript}` : ''}${p.owner ? ` · ${p.owner}` : ''}`);
  }
  if ((r.kind ?? 'new_team') === 'new_team') lines.push('Every new team also gets two standard directives, "Who decides" and "What stays with the operator", which the administrator may reword.');
  return lines.join('\n');
}

/** One shell word. POSIX: single quotes, so $, backticks, double quotes and backslashes stay literal. Windows: double quotes (a path has no " there). */
export function shellQuote(p, win = WIN) {
  return win ? `"${p}"` : `'${p.replaceAll("'", "'\\''")}'`;
}
