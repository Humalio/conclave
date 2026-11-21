/**
 * Item kinds of the Project Blueprint (docs/blueprint.md §2.2): key format, where an item may sit, its statuses and its
 * typed fields. The service checks every write against this table, so a new kind needs no migration.
 */

export type FieldType = 'str' | 'bool' | 'num' | 'strs' | 'objs' | 'obj' | readonly string[];
export interface KindSpec {
  /** Key format. */
  key: RegExp;
  /** The key format in words and one valid key: the bp_write error and docs/blueprint.md §2.2 quote them. */
  format: string;
  example: string;
  /** Prefix and zero padding used when a writer gives only the prefix (`FR-TEAM-*`). */
  pad?: number;
  /** Kinds the item may sit under; `parentRequired` when it must have one. */
  parents?: readonly string[];
  parentRequired?: boolean;
  statuses?: readonly string[];
  fields: Record<string, FieldType>;
  required?: readonly string[];
  /** At most one per project (SUM, ARCH). */
  single?: boolean;
  /** A module or a line: the track whose `team_id` the items inside it carry. */
  track?: boolean;
  /** One more sentence for the rules text (bp_read {rules: true}): what a field holds, where the writer must take care. */
  note?: string;
}

/** Fields every kind takes (docs/blueprint.md §2.2): outside references, checked in external.ts. */
/** A milestone's short name (the paper page's Delivers line) is at most this many characters. */
export const SHORT_NAME_MAX = 24;
export const COMMON_FIELDS: Readonly<Record<string, FieldType>> = { external: 'objs' };

const LMH = ['low', 'medium', 'high'] as const;
const PRIORITY = ['must', 'should', 'could'] as const;
const REQ_STATUS = ['draft', 'agreed', 'built', 'verified', 'dropped'] as const;

export const KINDS: Record<string, KindSpec> = {
  summary: { key: /^SUM$/, format: 'SUM (one per project)', example: 'SUM', single: true, fields: { vision: 'str', objective: 'str', value: 'str' } },
  stakeholder: { key: /^SH-\d+$/, format: 'SH-n', example: 'SH-1', pad: 1, fields: { role: 'str', decides: 'bool', seat: 'str', contact: 'str' } },
  module: { key: /^[A-Z]{2,6}$/, format: '2 to 6 capitals', example: 'TEAM', track: true, fields: { epic: 'str' } },
  fr: {
    key: /^FR-[A-Z]{2,6}-\d{2,}$/, format: 'FR-<module>-nn', example: 'FR-TEAM-04', pad: 2, parents: ['module'], parentRequired: true, statuses: REQ_STATUS,
    fields: { priority: PRIORITY, stories: 'strs', unclear: 'bool', unclear_ask: 'str', evidence: 'str', source: 'str' },
  },
  nfr: {
    key: /^NFR-(PERF|SEC|REL|USE|OPS)-\d{2,}$/, format: 'NFR-<CAT>-nn, CAT one of PERF, SEC, REL, USE, OPS', example: 'NFR-SEC-01', pad: 2, parents: ['module'], statuses: REQ_STATUS,
    fields: { category: ['performance', 'security', 'reliability', 'usability', 'operations'], subcategory: 'str', target: 'str', priority: PRIORITY, unclear: 'bool', unclear_ask: 'str', evidence: 'str', source: 'str' },
  },
  ac: {
    key: /^.+\/AC\d+$/, format: '<parent>/ACn', example: 'FR-TEAM-04/AC1', pad: 0, parents: ['fr', 'nfr'], parentRequired: true, statuses: ['open', 'passing', 'failing', 'waived'],
    fields: { given: 'str', when: 'str', then: 'str', evidence: 'str' },
  },
  line: { key: /^L\d+(\.\d+)?$/, format: 'Ln, or Ln.m under a line', example: 'L1', parents: ['line'], track: true, statuses: ['active', 'parked', 'closed'], fields: { mode: ['validate', 'explore'], question: 'str' }, required: ['mode'] },
  hypothesis: {
    key: /^H-L\d+(\.\d+)?-\d{2,}$/, format: 'H-<line>-nn', example: 'H-L1-02', pad: 2, parents: ['line'], parentRequired: true,
    statuses: ['untested', 'testing', 'confirmed', 'refuted', 'inconclusive', 'dropped'], fields: { statement: 'str', criteria: 'str', evidence: 'str' },
  },
  // A module key never starts with L and a digit (2-6 capitals), so Q-<module>-nn, Q-<line>-nn and Q-nn cannot clash.
  question: {
    key: /^Q-(?:L\d+(?:\.\d+)?-|[A-Z]{2,6}-)?\d{2,}$/, format: 'Q-<line>-nn under a line, Q-<module>-nn under a module, or Q-nn at project level', example: 'Q-L1-01', pad: 2,
    parents: ['line', 'module'], statuses: ['open', 'answered', 'dropped'], fields: { criteria: 'str', asked_to: 'str', asked_at: 'num', purpose: 'str', answer: 'str', source: 'str' },
    note: 'criteria only under a line that validates. purpose: what the team does today and what each answer would change (context stays in the body); ask for it on questions to outsiders. asked_to: whom it was asked of, preferably a stakeholder key (SH-2); a name is personal data and goes into the export. asked_at: the date asked. answer: needed to move a question outside a line to answered; a line question is answered by findings linked as evidence and needs none. Answering one offers a ready-made proposed decision op in the write result.',
  },
  finding: { key: /^F-L\d+(\.\d+)?-\d{2,}$/, format: 'F-<line>-nn', example: 'F-L1-03', pad: 2, parents: ['line'], parentRequired: true, fields: { evidence: 'str', confidence: LMH } },
  architecture: { key: /^ARCH$/, format: 'ARCH (one per project)', example: 'ARCH', single: true, fields: {} },
  decision: {
    key: /^ADR-\d{3,}$/, format: 'ADR-nnn', example: 'ADR-007', pad: 3, statuses: ['proposed', 'accepted', 'superseded', 'rejected'],
    fields: { context: 'str', options: 'objs', chosen: 'str', decided_at: 'num', decided_by: 'str', consequences: 'str', source: 'str', superseded_by: 'str', review: 'obj', mockups: 'objs' },
    note: 'A design the operator decides in the console (docs/decisions.md, Designs): the body is the design in Markdown. review: { verdict: approved or changes, changes: [text], summary } written by the reviewer itself; the hub shows who wrote it from the revision, not from this field. mockups: [{ task_id, role: brief or submission, path, caption }] name images attached to one of the team tasks (PNG, JPEG or WebP only; SVG is refused).',
  },
  paper: {
    key: /^PAP-\d+$/, format: 'PAP-n', example: 'PAP-1', pad: 0, statuses: ['planned', 'drafting', 'submitted', 'accepted', 'rejected', 'published', 'dropped'],
    fields: { venue: 'str', type: ['paper', 'preprint', 'report', 'thesis'], target_at: 'num', authors: 'strs', manuscript: 'str' },
  },
  // `support` is computed on read (support.ts), never written.
  claim: { key: /^PAP-\d+\/C\d+$/, format: '<paper>/Cn', example: 'PAP-1/C3', pad: 0, parents: ['paper'], parentRequired: true, statuses: ['draft', 'final', 'cut'], fields: { part: ['intro', 'method', 'results', 'discussion'] } },
  milestone: { key: /^M\d+$/, format: 'Mn', example: 'M2', pad: 0, statuses: ['planned', 'in_progress', 'reached', 'missed', 'dropped'], fields: { phase: 'str', target_at: 'num', exit: 'str', evidence: 'str', short: 'str' },
    note: `short: an optional name of up to ${SHORT_NAME_MAX} characters; the paper page lists the milestones that deliver it by this name (without one, by the title cut off).` },
  release: { key: /^REL-[0-9A-Za-z.]+$/, format: 'REL-<version>', example: 'REL-1.4', statuses: ['planned', 'released', 'cancelled'], fields: { version: 'str', target_at: 'num', notes: 'str' } }, // scope is its ships links
  report: {
    key: /^SR-\d{3,}$/, format: 'SR-nnn', example: 'SR-012', pad: 3,
    fields: { health: ['on_track', 'at_risk', 'off_track', 'unknown'], done: 'strs', next: 'strs', blockers: 'strs', escalate: 'bool', refs: 'strs', auto: 'obj', requested: 'str' },
  },
  risk: {
    key: /^RK-\d{2,}$/, format: 'RK-nn', example: 'RK-03', pad: 2, statuses: ['open', 'mitigated', 'accepted', 'closed'],
    fields: { likelihood: LMH, impact: LMH, control: 'str', mitigation: 'str', owner: 'str', source: 'str' },
  },
  issue: { key: /^I\d+$/, format: 'In', example: 'I4', pad: 0, statuses: ['open', 'resolved'], fields: { impact: LMH, owner: 'str', due_at: 'num', source: 'str' } },
  term: { key: /^G-[a-z0-9-]+$/, format: 'G-<slug> (lower case, digits, hyphens)', example: 'G-lead-time', fields: { aliases: 'strs' } }, // title: the code as written; body: one plain sentence; aliases: other spellings (docs/blueprint.md §2.7)
  reference: { key: /^REF-\d+$/, format: 'REF-n', example: 'REF-2', pad: 0, fields: { url: 'str', kind: ['design', 'repo', 'api', 'doc'] } },
};

// Every kind takes the common fields, so the write check, the export and the restore read them like the kind's own.
for (const s of Object.values(KINDS)) s.fields = { ...s.fields, ...COMMON_FIELDS };

/** The paper statuses in which its coordinator still edits it. */
export const PAPER_OPEN: readonly string[] = ['planned', 'drafting'];
/** Retired statuses (docs/blueprint.md §6, Limits): the item stays in the part, the reads and the export, but no longer counts toward the item limits. */
export const RETIRED: Readonly<Record<string, readonly string[]>> = {
  fr: ['dropped'], nfr: ['dropped'], ac: ['waived'], hypothesis: ['dropped'], question: ['dropped'], decision: ['superseded', 'rejected'],
  paper: ['dropped'], claim: ['cut'], milestone: ['dropped'], release: ['cancelled'],
};
/** SQL that is true for a retired bp_items row; built from the constants above only. */
export const RETIRED_SQL = `(${Object.entries(RETIRED).map(([k, s]) => `(kind='${k}' AND status IN (${s.map((x) => `'${x}'`).join(',')}))`).join(' OR ')})`;

/**
 * The operator's status moves (docs/blueprint.md §4). The statuses of these kinds fall into groups: a move inside one
 * group is the owner's, a move between groups is the operator's. A status in no group is a group of its own, so every
 * status move of a decision is the operator's. The rights matrix (rights.ts) and the decider routing (bpRouting.ts)
 * both read this one table.
 */
const STATUS_GROUPS: Record<string, readonly (readonly string[])[]> = {
  fr: [['draft', 'dropped'], ['agreed', 'built', 'verified']],
  nfr: [['draft', 'dropped'], ['agreed', 'built', 'verified']],
  decision: [],
  paper: [PAPER_OPEN],
};
/** True when moving an item of this kind from `was` to `to` is the operator's act. */
export function isOperatorAct(kind: string, was: string | null, to: string | null): boolean {
  const groups = STATUS_GROUPS[kind];
  if (!groups || was === to) return false;
  const a = groups.findIndex((g) => g.includes(was ?? '')), b = groups.findIndex((g) => g.includes(to ?? ''));
  return a < 0 || a !== b;
}

/**
 * What a refused key should have looked like: "A hypothesis key is H-<line>-nn, e.g. H-L1-02 (or H-L1-* for the next
 * number)." Kinds with a counter (`pad`) also name the `*` form, made from the example's prefix.
 */
export const keyHint = (kind: string): string => {
  const s = KINDS[kind];
  if (!s) return '';
  const star = s.pad !== undefined ? ` (or ${s.example.replace(/\d+$/, '')}* for the next number)` : '';
  return `${/^[aeiou]/.test(kind) ? 'An' : 'A'} ${kind} key is ${s.format}, e.g. ${s.example}${star}.`;
};

/**
 * Rules the operator turns on per project and team (docs/blueprint.md §4 Rules, ADR-006): a named kind of change the
 * team's coordinator applies without a proposal. A fixed list, never free-form; nothing touching keys, rights, goals, the
 * spec or deletions can be one. What a rule applies stays the agent's writing (L1/L2), never the operator's (L0).
 * rights.ts decides what each one covers; migration 0133's CHECK lists the same ids.
 */
export const BP_RULES = {
  release_notes: {
    label: 'Release notes',
    applies: 'Creating a release for a deploy, and writing its title, body and notes',
  },
} as const;
export type BpRule = keyof typeof BP_RULES;
export const isBpRule = (r: unknown): r is BpRule => typeof r === 'string' && Object.prototype.hasOwnProperty.call(BP_RULES, r);
/** A release field a rule may write: notes always, version only when it creates the release (its name, not a date or scope). */
export const RULE_RELEASE_FIELDS: readonly string[] = ['notes', 'version'];
/** The revision note of an item a rule applied. */
export const ruleNote = (r: BpRule): string => `applied by the ${BP_RULES[r].label} rule (team setting)`;

/** Where a refused writer finds every rule at once; refusals of keys, places and rights end with it. */
export const RULES_HINT = 'bp_read {rules: true} lists every kind\'s key, place and who may change it.';
/** Where a denied write's rule lives: appended to "Not yours to change". */
export const RIGHTS_RULE = `Who may change what: docs/blueprint.md §4; ${RULES_HINT}`;

const fieldText = (t: FieldType): string => (Array.isArray(t) ? (t as readonly string[]).join('|') : t as string);
/** Where an item of this kind may sit, in words: "under a module (required)", "project level, or under a line". */
const placeText = (kind: string, s: KindSpec): string => {
  const ps = s.parents?.join(' or ');
  if (kind === 'question') return 'under a line or a module, taking its team from it, or at project level, which is in no team\'s part (no team_id)';
  if (s.parentRequired) return `under a ${ps}; takes its team from it`;
  if (ps) return `project level, or under a ${ps}`;
  if (s.single) return 'project level, one per project';
  if (kind === 'report') return 'written by bp_report only';
  return 'project level; give team_id to put it in your part';
};

/**
 * Every rule a writer needs before the first write (bp_read {rules: true}): each kind's key format with an example and
 * the `*` form, where it may sit, its statuses and fields; the link relations; who may change what (§4, rights.ts); the
 * operator's limits. Built from this table and RELS, so it cannot drift from what the service checks.
 */
export function rulesText(limits: BpLimits, order: readonly string[] = Object.keys(KINDS)): string {
  const kinds = order.filter((k) => KINDS[k]).map((k) => {
    const s = KINDS[k]!;
    const star = s.pad !== undefined ? `, next number ${s.example.replace(/\d+$/, '')}*` : '';
    const fields = Object.entries(s.fields).filter(([f]) => !(f in COMMON_FIELDS)).map(([f, t]) => `${f} (${fieldText(t)})`).join(', ');
    return `- ${k}: key ${s.format}, e.g. ${s.example}${star}. Sits ${placeText(k, s)}.${s.statuses ? ` Statuses ${s.statuses.join(', ')}.` : ''}${fields ? ` Fields ${fields}.` : ''}${s.required?.length ? ` Needs ${s.required.join(', ')}.` : ''}${s.note ? ` ${s.note}` : ''}`;
  });
  const rels = Object.keys(RELS).map((r) => `- ${r}: ${relText(r)}`);
  return [
    'Kinds (key format, where an item sits, statuses, fields). A new item\'s key must match; an existing key keeps its kind. An AC is keyed <parent>/ACn and a claim <paper>/Cn.',
    ...kinds,
    '- Every kind also takes external: outside references, a list of at most 20 {system, id} such as [{"system": "tracker", "id": "90048"}]; system is a short lower-case word, id the record\'s id there (1-100 characters). Never a link: links come from the project\'s outside systems, which the operator sets. Find items with bp_read {external: "tracker:90048"} or "tracker:*". Tracker story ids and pull request numbers go here, not in the body.',
    'Links (rel: from → to):',
    ...rels,
    'Who may change what (docs/blueprint.md §4). Your part is the items whose track or paper is your team\'s; project-level items are in no team\'s part.',
    '- Coordinator, own part: edits FRs and NFRs while draft, hypotheses while untested, questions while open, ACs while their parent is draft, papers and claims while the paper is planned or drafting (and links them to the hypotheses they study); findings, risks and issues; milestone and release status; adds decisions as proposed. Other edits there become a proposal.',
    '- Questions: one under a module is in that module\'s team part, like its FRs; one at project level (Q-nn) is in no team\'s part and needs the operator.',
    '- Coordinator, outside the own part: a proposal; moving another part\'s status or evidence is refused.',
    '- Coordinator, own part, outside references only (an op that changes nothing but fields.external): applied whatever the status, agreed requirements and accepted decisions too; never on an archived item or a status report.',
    '- Team agent (any role but coordinator): proposes; writes findings in its team\'s lines; may not move statuses, delete, or write papers, decisions, milestones, releases or tracks.',
    '- The operator\'s acts are always a proposal: agreeing an FR or NFR or taking one back, every status move of a decision, a paper leaving planned or drafting, deleting, opening a module or line, summary, stakeholders, architecture, terms and references. Accepting a decision that supersedes others moves them to superseded in the same write.',
    '- Rules the operator may turn on for one team: Release notes (release_notes): in its own part, the coordinator creates a release and writes its title, body, notes and, when creating it, its version, without a proposal. Dates (target_at) and ships links still need the operator. A write that also changes anything else is one proposal. Each applied write names the rule in its history; what it applies stays your writing, not the operator\'s approval.',
    '- Status reports are filed with bp_report only.',
    `- Any op needing the operator makes the whole write one proposal; any op refused refuses the whole write. Limits: ${limits.opsPerWrite} ops per write, titles ${limits.title} characters, bodies ${limits.body} (architecture ${limits.archBody}); retired items (dropped, waived, superseded, rejected, cut, cancelled) do not count toward the item limits.`,
  ].join('\n');
}

/**
 * Allowed link relations (§2.3): each a list of from kinds → to kinds. `verifies` (AC → FR) is the parent, never a row.
 * This table is the one list: write validation, the rules text, the export and the restore read it. The `bp_links.rel`
 * CHECK constraint repeats it (a new relation needs a migration that rebuilds bp_links, as 0122 did for `studies`), and
 * rights.ts gives each relation its rule.
 */
export type RelPair = { from: readonly string[]; to: readonly string[] | '*' };
export const RELS: Record<string, readonly RelPair[]> = {
  delivers: [{ from: ['milestone'], to: ['fr', 'nfr', 'hypothesis', 'paper'] }],
  ships: [{ from: ['release'], to: ['fr', 'nfr', 'milestone'] }],
  governs: [{ from: ['decision'], to: ['fr', 'nfr', 'module', 'architecture'] }],
  supersedes: [{ from: ['decision'], to: ['decision'] }],
  threatens: [{ from: ['risk'], to: ['fr', 'nfr', 'milestone', 'release', 'paper'] }],
  // The target waits on it: the console shows "Waiting on I4" or "Waiting on Q-TEAM-02" on the target.
  blocks: [{ from: ['issue', 'question'], to: '*' }],
  // The source bears on the target's verdict or support; item-to-item evidence is always a link, never a field.
  evidence: [{ from: ['finding'], to: ['question', 'hypothesis', 'claim'] }, { from: ['hypothesis', 'fr', 'nfr', 'ac'], to: ['claim'] }],
  // Planned coverage: the paper sets out to report on the hypothesis. It carries no support (support.ts reads evidence
  // only), so a planned paper is found by its hypotheses before it has a claim (papersForHypothesis).
  studies: [{ from: ['paper'], to: ['hypothesis'] }],
};
export const relAllows = (rel: string, from: string, to: string): boolean =>
  (RELS[rel] ?? []).some((p) => p.from.includes(from) && (p.to === '*' || p.to.includes(to)));
/** "a" or "an" before a list of kinds, by the first one's first letter ("an issue or question", "a finding"). */
const article = (kinds: readonly string[]): string => `${/^[aeiou]/.test(kinds[0] ?? '') ? 'an' : 'a'} ${kinds.join(' or ')}`;
export const relText = (rel: string): string =>
  (RELS[rel] ?? []).map((p) => `${article(p.from)} to ${p.to === '*' ? 'any item' : article(p.to)}`).join('; or ');

/** Limits (§6). Settings can change them; tests pass smaller ones. */
export interface BpLimits {
  itemsPerProject: number; itemsPerTeam: number; acsPerParent: number; lines: number; papers: number; claimsPerPaper: number;
  title: number; body: number; archBody: number; fields: number; linksPerItem: number; opsPerWrite: number; revisionsPerItem: number;
  /** Status reports kept live per project; older ones are archived (§6): left out of live reads, kept in the export. */
  reportsPerProject: number;
}
export const DEFAULT_LIMITS: BpLimits = {
  itemsPerProject: 2000, itemsPerTeam: 300, acsPerParent: 50, lines: 30, papers: 10, claimsPerPaper: 40,
  title: 200, body: 4000, archBody: 16000, fields: 4000, linksPerItem: 200, opsPerWrite: 50, revisionsPerItem: 200, reportsPerProject: 500,
};

/**
 * The limits the operator may set in Settings (§6), API name → service name, each with a hard ceiling. Tool and route
 * schemas take the ceiling; the service enforces the live limit and names it in its errors.
 */
export const LIMIT_SETTINGS: Record<string, { key: keyof BpLimits; max: number }> = {
  items_per_project: { key: 'itemsPerProject', max: 20_000 }, items_per_team: { key: 'itemsPerTeam', max: 5_000 }, acs_per_fr: { key: 'acsPerParent', max: 500 },
  lines: { key: 'lines', max: 300 }, papers: { key: 'papers', max: 100 }, claims_per_paper: { key: 'claimsPerPaper', max: 400 },
  title: { key: 'title', max: 200 }, body: { key: 'body', max: 40_000 }, architecture_body: { key: 'archBody', max: 160_000 }, fields: { key: 'fields', max: 40_000 },
  links_per_item: { key: 'linksPerItem', max: 2_000 }, ops_per_write: { key: 'opsPerWrite', max: 200 }, revisions_per_item: { key: 'revisionsPerItem', max: 2_000 },
  reports_per_project: { key: 'reportsPerProject', max: 5_000 },
};
/** Hard ceilings for schemas: at most this many ops in one write, characters in one body. */
export const MAX_OPS = LIMIT_SETTINGS['ops_per_write']!.max;
export const MAX_BODY = LIMIT_SETTINGS['architecture_body']!.max;

/** Work still in play, per kind (docs/blueprint.md §6.1). A kind not named here has no open items. */
export const OPEN: Readonly<Record<string, readonly string[]>> = {
  fr: ['draft', 'agreed', 'built'], nfr: ['draft', 'agreed', 'built'], ac: ['open', 'failing'], line: ['active'],
  hypothesis: ['untested', 'testing'], question: ['open'], decision: ['proposed'], paper: ['planned', 'drafting', 'submitted'],
  claim: ['draft'], milestone: ['planned', 'in_progress'], release: ['planned'], risk: ['open'], issue: ['open'],
};
export const isOpen = (kind: string, status: string | null): boolean => !!status && !!OPEN[kind]?.includes(status);

/**
 * A late milestone (docs/blueprint.md §6.1, `risk`): missed, or a target date that has passed while it is planned or in
 * progress. The one function the section 2 summary's At risk list and the For awareness missed-milestone row both read.
 */
export function milestoneLate(m: { status: string | null; target_at?: unknown }, now = Date.now()): { state: 'missed' } | { state: 'overdue'; days: number } | null {
  if (m.status === 'missed') return { state: 'missed' };
  const due = typeof m.target_at === 'number' ? m.target_at : null;
  if ((m.status === 'planned' || m.status === 'in_progress') && due !== null && due < now) return { state: 'overdue', days: Math.max(1, Math.floor((now - due) / 86_400_000)) };
  return null;
}
