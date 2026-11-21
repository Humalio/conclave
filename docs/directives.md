# Directives

Directives are the operator's standing rules, such as "save as many tokens as possible" or "cite the source note for every claim". Before this feature they lived in files on a share, in restart prompts, in each agent's memory and in one-off console messages. Nobody could see which rules reached which agent, or which version it had read. Now each directive is a hub record with:
- a scope;
- a version;
- a record of which version each agent confirmed.

A new team arrives with its own directives: two standard ones from a hub template, plus the rules the operator kept from its onboarding request ([From onboarding](#from-onboarding)). Agents also report the rules they follow from elsewhere. A report is a suggestion to their team, for the operator to adopt or retire; it is not in force by itself ([Suggestions from agents](#suggestions-from-agents)).

## Scope and order

A directive applies to one of:
- all agents;
- one project, meaning the current members of its live teams ([Project reach](#project-reach));
- one team, meaning its current members;
- one role in a team;
- one agent.

Ended teams and archived agents are left out. When two directives disagree, the more specific one wins: agent, then role, then team, then project, then all agents. Team playbooks stay as the role instructions; directives are the operator's rules on top.

**Kept off.** The operator can keep a directive off one agent, one team (its current members) or one project (the current members of its live teams), without retiring it for everyone. This is an exemption:
- it beats the scope: a hub-wide rule kept off team T is in force for every agent except T's members;
- a directive's **reach** is the agents its scope covers minus the agents an active exemption keeps it off. Everything an agent sees (its list, login lines, `session_whoami`, `directives_read`) and every count the operator sees (coverage, "x of y read", the team's counts) follows the reach;
- it is an exclusion from delivery: an agent any active exemption takes in does not get the rule, whatever else it belongs to. A hub rule kept off project A stays out of the list and the Inbox of an agent in teams of both A and B;
- targets are resolved live, like the scope: an agent that joins T loses the rule, and one that leaves T gets it back unless another exemption covers it. Each such change sends the agent one notice ([Project reach](#project-reach));
- it makes no new version and resets no read state. If the exemption is lifted, each agent's earlier confirmation shows again as read or out of date. The audit (`directive.exempt`, `directive.unexempt`) is its only record;
- it cannot target an agent-scoped directive (retire it instead), the directive's own scope target, or an unknown agent, team or project (`invalid_argument`). Under a scope narrower than all agents, a target that shares no agent with the scope is refused (`invalid_argument`), while a hub-wide scope takes any target. A target the directive is already kept off answers `conflict`; a retired directive answers `invalid_state`. There are no role exemptions;
- retiring or merging a directive leaves its exemptions as history; a retired directive reaches nobody.

The console says the reach in words: "All agents except team ECHO Research".

### Project reach

A project scope and a project exemption name a Blueprint project by its id (`prj_…`). An agent is in a project through its team memberships, never through a label:
- **Eligible memberships.** An agent is in every project one of its teams belongs to, counting each current membership (not removed) of a team that is not done or stopped. An agent in teams of two projects is in both. A teamless agent is in no project: only hub-wide rules and rules for it alone reach it. While [owner enforcement](authorization.md#owner-enforcement) is on, a membership counts only when the agent's owner may do team work there: the owner is an active admin, or the owner's grant on the team's project delegates that team. An unowned agent, or one whose owner is disabled or expired, is then in no project's scope. Team and role scopes still follow every live membership, and so does keeping a rule off a project: an exclusion takes in every current member of the project's live teams, eligible or not.
- **The label is gone from reach.** The agent's free-text project label is a description only. It plays no part in reach, authorization or the console's forms. An older client may still send a project's name or key where the id belongs: the hub resolves it to the project's id (an exact id first, then the key, then the name of an open project, ignoring case) and refuses one that names no project (`invalid_argument`).
- **Notices follow every change of reach.** When an agent joins or leaves a team, a team is created, approved from onboarding, ends, or moves to another project, and when an owner's grant or delegation, role, expiry date or status changes, an agent's owner changes (claim, reassign) or owner enforcement is switched, each agent whose reach changed is told once per directive: "now applies to you" for a rule it gained, which settles when it confirms that version, and "no longer applies to you. Stop following it." for one it lost. Its earlier confirmations stay: a rule it gains back reads as read or out of date by version. An owner's account that expires by its date leaves reach at that moment without a notice; the agent's list shows the change at its next call.
- **Before saving.** A new or edited scope, a merge and Keep off show the agents the change reaches, gains and loses before the operator saves (`POST /api/directives/preview`).
- **Migration 0117** rewrote stored project labels as project ids: a label equal to a project's key, else to its name (an open project first, ignoring case), became that project's id. A project-scoped directive whose label names no project keeps it and reaches nobody until the operator gives it a project. A project exemption keeps every agent it kept off before: an agent whose label matched but who is in no live team of that project gets an agent exemption of its own (note "Kept off project <label> before reach followed teams"), and an exemption whose label names no project is replaced by those agent exemptions and removed as history (`removed_by` `migration:0117`). The migration sends no notices; each agent's list shows the change at its next login. Directive versions keep the label they were saved with.

## Categories and tags

Each directive may have one **category** from a fixed list, and up to ten **tags**. They file directives; they do not change what an agent must do.

| Category | Id | For rules about |
|---|---|---|
| Access & security | `access` | keys, permissions, what may be pushed or deployed |
| Communication | `communication` | messages, rooms, language, who to ask |
| Token economy | `tokens` | reading less, short replies, call budgets |
| Reporting | `reporting` | status, summaries, units and dates |
| Sources & quality | `sources` | citing, quoting, marking assumptions |
| Process & workflow | `process` | tasks, reviews, leases, drafts |
| Tooling | `tooling` | which tool or format to use |

- **Tags** are short lowercase words (spaces become dashes, at most 32 characters), such as `vault` or `git`.
- **Only the operator sets a category.** An agent may propose one in `directives_report`. The proposal is kept apart (`proposed_category`) and becomes the category when the operator reviews the rule: **Keep as is** confirms it, or the operator picks another one or none. **Mark reviewed** and **Mark all as reviewed** confirm the proposals of the rules they keep. An edit counts as a review too.
- **Setting a category or tags is filing.** It makes no new version and sends no notice. A version made by an edit records the category and tags the directive had then.

## Agents

| Tool | What it does |
|---|---|
| `directives_list` | The directives in force for you, most specific first: id, title, version, scope, category, tags, and whether you read the current version. Optional filters: `category` (an id, or `none`) and `tag`. |
| `directives_read` | The text of one directive, or of all of them, most specific first. Each carries its `precedence` (1 wins when two disagree: agent, then role, team, project, hub) and its `scope_kind`. `unread: true` returns only those you have not read at their current version; `ack: true` confirms every directive it returns, so `directives_read {unread: true, ack: true}` reads and confirms the new ones in one call. |
| `directives_report` | Suggest a rule you follow that is not a hub directive yet: a title, its source (a file, a prompt, a chat instruction), a summary, and its text if you have it. It becomes a suggestion to your team for the operator, not a directive ([Suggestions from agents](#suggestions-from-agents)). When a directive in force for you already says the same thing, the report is ignored and the answer names that directive. Reporting the same title again updates your open suggestion. You may propose a `category`; the operator confirms or changes it. |

All three are default tools: agents have them without a grant. `directives_report` stops during a lockdown; the other two stay open. `directive_ack` was removed in 1.0: a call to it is answered with `removed` and points to `directives_read {ack: true}`.

**Cost to agents:**
- Login and `session_whoami` list the directives in force as one line each (id, version, title, read state). They never include the text, category or tags.
- A new or changed directive arrives once, as a notice. The notice names the directive and its version: confirming that version or a later one (`directives_read` with `ack: true`) clears it, with no `session_ack`. It also clears once the directive is no longer in force for the agent. A merge notice clears when the agent confirms the directive it was merged into.
- A directive that no longer applies (its scope narrowed, or the operator kept it off the agent, its team or its project), or is retired, also arrives as one notice that tells the agent to stop following it ("no longer applies to you. Stop following it."). From then on it is gone from the agent's list, and `directives_read {id}` answers `not_found`; an older notice still pending for it clears at once. The stop notice clears on the agent's next `directives_read`, in any form; that read's answer still carries it, so the agent always sees it once. Agents never see the operator's note and cannot exempt themselves.
- Directive notices sent before migration 0106 name no directive, and still need `session_ack`.
- An agent with no directive in force gets one line instead, at login and in `session_whoami`: suggest the rules it follows (from `AGENTS.md`, a `CLAUDE.md` or the user's instructions) with `directives_report`, once per rule.
- **A reminder while directives wait.** Notices arrive once, so an agent that started with directives already in force, or skipped its notices, could work without reading them. The answers to `work_next`, `task_list`, `task_start` and `task_review` therefore carry `directives_unread: N` at the top level, next to `notices`, and one fixed line: "You have N unread directives. Read them with directives_read {unread: true, ack: true} before you act."
  - N counts exactly what `directives_read {unread: true}` would return: directives in force for the agent (exemptions respected, retired ones left out) that it never confirmed or confirmed at an older version. It is the same count as the directives `session_whoami` marks unread or outdated, from one shared function.
  - Numbers only: no titles, ids or directive text. It is never inside an item, a task or a review.
  - One line per answer. It is left out when N is 0, and when every directive it would count already has its confirm notice in that answer's `notices`.
  - It is worked out on each call, with no cache, so the next call after `directives_read {unread: true, ack: true}` has no line. It never refuses work. Other tools never carry it.

### Agents report their rules

The `CLAUDE.md` that onboarding writes into each agent's folder (`CLAUDE.local.md` after a checkout, `AGENTS.override.md` for a Codex agent) has a **Directives** section, after the playbook. All three are built from the same hub text, and a test keeps the Codex file's sections equal to the Claude Code ones. The start message in the terminal and Codex commands that the connector shows for each agent tells it to call `directives_read {unread: true, ack: true}` first. The section points to the directives and does not repeat them: the hub's list is the one to follow, so a change reaches the agent without a new file.
- at first start, call `directives_read {unread: true, ack: true}`, and do the same when a notice says a directive changed;
- suggest each rule followed from a file, a prompt or the chat with `directives_report`, once per rule, with its source;
- "Don't report rules that are already in this file (playbook, goal, job, connection); report only rules from other files, prompts or chat." Those already reach the agent from the hub.

### Suggestions from agents

A report is a suggestion at team level, not a directive:
- It is kept as an open report for the agent's team (the first team it is a member of; none when it is in no team). Nothing is in force until the operator adopts it, and the agent keeps following its own file meanwhile.
- **It is ignored when the hub already has the rule.** When a directive in force for the agent, other than one scoped to that agent alone, has the same title or the same text (compared without case, punctuation or a `.md` ending), the report is recorded as **Already a rule**, linked to that directive. The answer tells the agent to follow the hub's version.
- The same title from the same agent again updates its open report; the same rule from several members of a team shows as one row per report, so the operator sees how widely it is followed.
- **Adopt** makes it a directive for the reporter's team by default, with the category the agent proposed. Every other open report of that team with the same title is closed as **Already a rule** in the same step, and each reporter is told to follow the new directive. That is the merge.
- **Retire** tells the agent to stop following the rule, with the operator's note.
- At most 50 open reports per agent; more are refused until the operator decides some.

Rules agents registered before this change stay as they were: directives in force for that agent, marked not reviewed, which the operator keeps, merges or retires as below.

## From onboarding

Approving a `new_team` request creates the team's directives in the same transaction:
- **Two standard directives**, always, from the hub template below. The approval screen shows their text for this team, editable before approving; they cannot be left out. Each is scoped to the team, tagged `onboarding` and `standard`, with the source `hub template`, and marked reviewed.
- **The rules the operator kept** from the request, as below.

The hub template:

| Title | Category | Text |
|---|---|---|
| Who decides | Process & workflow | The team coordinator decides the team's work, from the team goal and the specification: what comes next, in what order, who does it, and when reviewed work is ready. Bring questions and decisions to the coordinator. Only what "What stays with the operator" lists goes to the operator. |
| What stays with the operator | Access & security | These stay with the operator, a person: ask with `team_ask` and wait for the answer. Pushing or publishing anything; deleting data, or restoring a backup; editing the database by hand; keys, certificates and security settings; installing software; approving onboarding requests; changing the team goal or the specification. |

The goal stays a goal: the request check warns (`goal_has_rules`) when the goal reads like a list of rules, so they go in `rules` instead ([warnings](onboarding.md#warnings)).

An onboarding request (`new_team` or `add_agents`) may carry a `rules` list: the rules its agents should follow, as the filing agent found them in the repo's `AGENTS.md` and `CLAUDE.md` and in the user's own instructions ([the request](onboarding.md#the-request)). Each has a title, a source, its text, and optionally a category and a team role.

The rules are L2 text written by a model. None becomes a directive by itself:
- The approval screen shows them under the computed agents, inert and labelled as written by the agent, each with a tick and an editable title and text ([one approval](onboarding.md#one-approval)). Every rule starts unticked: the operator ticks each one to adopt it. Approving without ticking any adopts none, in the console and in the API (`edits.rules` absent).
- On approval, each ticked rule becomes a directive in the same transaction: scoped to the team, or to the team's role when the rule names one; with its source and category; tagged `onboarding`; and marked reviewed, since the operator read it to keep it. Covered agents get the usual notice when they join.
- An unticked rule is dropped. It is kept only in the request's history.
- Denying, or asking for changes, creates nothing.

Cancelling an approved request before pickup stops the draft team; its directives stay, scoped to that stopped team, until the operator retires them.

## Operator (Work → Directives)

**The list:**
- **Not reviewed** comes first: rules agents registered themselves. They are already in force for the agent that registered them; the review is only for you.
  - The same rule from several agents (matching titles) shows as one row with **Merge**: one directive with the title, text and scope you choose (by default their common team, else their common project). The originals retire, and each agent is told to follow the merged one; an agent the merged one does not reach is told to stop following the original instead. Exemptions are not carried over: the merged directive starts with none, so a team, project or agent you kept a source off gets the merged one (and a "New directive" notice) until you keep it off again. The sources' exemptions stay on them as history.
  - A single rule opens its screen: **Keep as is**, **Edit or widen** (for example to the whole team or project), or **Retire**. The review card has the category, preset to what the agent proposed; Keep as is saves it.
  - **Mark all as reviewed** keeps every rule as it is. It asks first, with the count from `GET /api/directives/unreviewed-count`.
- **Suggestions from agents** sits above the list (In force) while a report waits (`GET /api/directive-reports?status=all`): one row per open report, with the agent and its team, and **Adopt** (title and text, prefilled from the report; it applies to the reporter's team and opens the new directive) and **Retire** (an optional note the agent sees). The decided reports fold under it; each opens the directive it became.
- Then the reviewed directives, each with its scope, version and coverage, for example "2 of 5 read · 2 out of date".
- **Category chips** over the list (All, each category, No category, with counts) filter it; a tag filter shows as a removable `#tag` chip. The list groups by scope, by category, or not at all. Tick rows and **Set category** to file several at once.

**A directive's screen:**
- the text, scope, version, category, tags and source (a category or tag opens the list filtered by it);
- each agent it reaches, with "Read", "Out of date" (read an older version) or "Not read";
- its history.
- **Minor edit, don't ask agents to re-read** on the edit sheet (`minor: true` on `PATCH /api/directives/:id`): for a typo. It still makes a new version and is audited, but no agent is told, and an agent that had read the previous version counts as having read this one. A change of scope is never minor.

Edit creates a new version, and covered agents are told. Retire tells them to stop.

**Keep off and Apply again** (admins only):
- The directive's screen says who it applies to with its reach ("All agents except project APPS"), then a **Kept off · n** section: one row per exemption with its target, note, who added it and when, and **Apply again**. The Agents title reads "Agents · x of y read · n kept off".
- **Keep off…** (actions bar and menu) opens a sheet with Agent, Team or Project and an optional note. Projects are chosen from the hub's projects by name, never typed. It leaves out the directive's own target, the targets it is already kept off and, for a scope narrower than all agents, targets that share no agent with it. Under the choice it lists the agents the rule would leave before you save. A refusal shows in the sheet. It is not offered on an agent-scoped directive. The toast reads "Kept off <target>; n agents told to stop".
- **New directive**, **Edit** and **Merge** pick a project from the same list, and show under the scope who it would reach, with the agents it gains and loses, before you save.
- **Apply again** lifts an exemption: the agents it kept the rule off get one "now applies to you" notice.
- History interleaves the exemptions with the versions ("Kept off team X"). A retired directive shows its exemptions there only.
- In the list, a row kept off somewhere reads its reach in the meta line.
- On the agent page, the Directives card has "Kept off k rules" when any are: a sheet lists each rule with its target, note and scope, and opens it. It answers "why does this agent not have rule X".

**A team's directives** (`#tdirs/<team>`, from the team page's Directives row) has three tabs, kept in the address so a reload keeps the tab:
- **This team**: rules for the team, a role in it or its project, with an overline per kind when more than one is present.
- **Members**: rules scoped to one member, under an overline per member. A member's own rule that repeats a team, role or hub rule in force for it (same title, compared without case or punctuation) is flagged "Same as team rule" (or role, or hub) and reads 'Copy of "<title>"'. **Fold n copies** (admins only) retires each copy after one confirm sheet; the agent is told once and the wider rule stays in force for it. Copies are never folded on their own.
- **Hub-wide**: the hub-wide rules in force, each with **Not for this team** (admins only), which keeps it off the team after a sheet with an optional note. Below them, **Not for this team · n** lists the rules kept off the team, muted, with **Apply again** (admins only). Apply again on a rule kept off by this team lifts it at once; one kept off by a project, an agent or another team asks first, because agents outside the team are told too.

The team page's Directives row and the screen's header read "n directives · m not read · k hub-wide (j exempt)", or "j hub-wide kept off" when no hub-wide rule is in force for the team. Each tab's count is what it lists, kept-off rows included.

**Elsewhere in the console:**
- **The agent page** has a "Directives" card: the directives that reach the agent and their read state, plus anything it follows from outside.
- **"Tell the agent"** is on the agent page (its own card) and on each row of a team's Members (**Message**, admins only): the same form, with the same Keep default (ticked). A directive is kept as a standing one for that agent (scope: that agent) by default; untick the box to send a one-off notice instead. The Members sheet opens on Message, a one-off notice.
- **The team page** has a "Directives" row: how many are in force, how many are not yet read by members, and how many rules members follow that are not registered.
- **Home** shows how many registered rules and suggestions wait for your review, and the Work tab gets its dot.

## Data and API

- **Tables** (from the 1.0 baseline `0100_v1_baseline.sql`, D61, which holds the 0.x directive migrations with `reported_by`, `reviewed_at`, `category`, `tags` and `proposed_category` on `directives`, `category` and `tags` on `directive_versions`):
  - `directives`;
  - `directive_versions`;
  - `directive_acks`;
  - `directive_reports` (`0105_directive_suggestions.sql` adds `team_id`, the reporter's team, and `category`, the one it proposed);
  - `directive_exemptions` (`0106_directive_reach_and_notice_refs.sql`): `directive_id`, `target_kind` (`agent`, `team` or `project`), `target_ref`, `note`, who added it and when, and `removed_by`/`removed_at`. Removing one sets `removed_at`; rows are never deleted. One active row per directive and target;
  - `directive_reads` (0106): each agent's last `directives_read`, which settles its stop notices;
  - `0117_directive_project_ids.sql` rewrites project scopes and project exemptions from labels to project ids ([Project reach](#project-reach));
  - 0106 also adds `ref_kind` and `ref_id` to `agent_notices`, so a notice names what it is about (a task, a feedback item, a directive or a stop) and is skipped once it no longer describes the current state. Task and feedback notices were backfilled; `ref_task_id` and `ref_feedback_id` are still written for one release.
- **Admin API:**
  - `GET /api/directives?status=active|retired|all&category=<id>|none&tag=<tag>` (with the open reports, the category list, and `projects`, each with its `id`, `key`, `name` and `agent_ids`, the agents in it; each row has `reach_label`, "All agents except team ECHO Research", `except_label`, the except part alone or '', and `exempt_count`);
  - `POST /api/directives/:id/exemptions` (`{target_kind, target_ref, note?}`, note up to 500 characters; a project target is its id, or for an older client its key or name; returns the exemption, the directive and `lost`, the agents told to stop) and `DELETE /api/directives/:id/exemptions/:exemptionId` (soft-removes it; returns the directive and `gained`, the agents told it applies again);
  - `POST /api/directives/preview` (`{id?, scope?, exempt?: {target_kind, target_ref}}`): who a directive would reach with that scope, or with that target kept off as well, saving nothing. Returns `reach`, `gained` and `lost` (each `{id, label}`, measured against the directive `id` when given) and `project`, the resolved project of a project scope or target;
  - `GET /api/directives/categories`;
  - `GET /api/directives/projects` (`projects`, as in the list: the choices for a project scope or target);
  - `GET /api/directives/:id` (coverage, each row with the agent's live teams and its role there for the agent list's Team filter; versions; `exemptions` with who added them, `exemptions_removed`, `exempt_count` and `kept_off`, the agents the scope covers that an exemption keeps it off);
  - `POST /api/directives` and `PATCH /api/directives/:id` (both take `category` and `tags`; a PATCH that changes only these makes no new version);
  - `POST /api/directives/categorize` (`ids`, and `category` (null clears it), `tags` to replace or `add_tags` to add);
  - `POST /api/directives/:id/retire`;
  - `POST /api/directives/:id/review` (optional `category`; without it the agent's proposal is confirmed), `POST /api/directives/review-all` and `POST /api/directives/merge` (the merged directive takes the category its sources share and their tags, unless given);
  - `GET /api/directives/unreviewed-count` (`count`, the rules not reviewed, and `suggestions`, the open reports);
  - `GET /api/directive-reports`;
  - `POST /api/directive-reports/:id/adopt`;
  - `POST /api/directive-reports/:id/retire`;
  - `GET /api/agents/:id/directives` (with `exempted`, the rules kept off the agent and the exemption that does it);
  - `GET /api/teams/:id/directives` (each row has its `tab`: `team`, `members` or `hub`; `exempt_here` names the exemption that keeps a rule off every member (`own` when it is this team's own, otherwise lifting it reaches agents outside the team), and `copy_of` the team, role or hub rule a member's own rule repeats, with its `scope_kind`; `count`, `behind`, `hub` and `hub_behind` count only rules in force, `hub_exempt` the hub-wide rules kept off the team, `copies` the member copies).
- **Code:**
  - [hub logic](../server/src/directives/directives.ts);
  - [agent tools](../server/src/mcp/directiveTools.ts);
  - [admin routes](../server/src/admin/directivesApi.ts).

**Limit:** the hub cannot read files on a share, so a registered rule holds the text the agent sent. From then on the hub copy counts, and the share files should only point to it.
