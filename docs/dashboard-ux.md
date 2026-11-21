# Dashboard UX

The console is an operator workspace. Each view must answer a specific question and link directly to the next useful action. Keep global alerts visible and keep the selected agent, team, file, or folder in context while inspecting it. How the views look and behave (tokens, layout, mobile, components) is set by the [design guidelines](design-guidelines.md).

| Operator need | Entry point |
|---|---|
| Start a session | **Session**: label, template, scope and expiry; copy the one-time key and task handoff, then verify the login. |
| Set up a device or app | **Add** in the header (after Lockdown; also in the More sheet on phones), or **Security → PCs → Add PC**: one screen, one field, then a ready-to-copy prompt that sets up the PC and its team ([Onboarding](onboarding.md)). The header button is just **Add** (also in the More sheet on phones): it opens on "What do you want to add?", a new PC or a team on a connected PC, and the new-PC screen says it connects a new PC and sets up its security and keys, asks for the PC's coding agent (Claude Code, Codex or another) and names it in the paste line. The PCs page keeps **Add PC**, which opens on that screen with Back to the choices. **App** makes an app key by hand; bridge pairing and folder approval are on the PC page. |
| Approve a team a PC asks for | The Home item **Team request from <PC>** (**Vault agent request from <PC>** for one teamless vault agent), or the **Team requests** band in Home's Teams card: the one approval screen (`#ob/<id>`). |
| Respond to a security event | Urgent items and **Alerts**: identify the actor and reason; expose the applicable acknowledgement, suspension, or lockdown action. |
| Lock an agent, PC or team | **Lockdown**: one switch per row, locked ones first, under **Agents**, **PCs** and **Teams**. Each list's overline carries its count ("Agents · 2 of 8 · 1 locked"), which the search above the lists updates as it filters. |
| Approve an access request | **Security → Requests**: inspect the requested action, target, reason and duration; narrow, approve, or deny. |
| Accept or discard proposed tasks | The Home **Backlog** card, **Work → Backlog** (`#backlog`), or a team's **Backlog** tab: [Backlog](#backlog). |
| Inspect work | The **Teams** card on Home, **Work → Sessions, Chats**: follow the relevant entity into its detail view. The connections graph is **Work → Topology**. |
| Triage what slows agents down | **Work → Feedback**: decide new reports, follow open ones, check that a fix worked. |
| Trace a change | **Vault → Activity** for a path; **Auditing** for cross-system activity. |
| Check the knowledge graph | **Vault → Knowledge**: is it keeping up, what needs review, what does it cost? |

## Attention words

One word for each way the console and the hub ask for someone's attention. Every screen, response field and doc uses
these words with this meaning and no other; a new kind of attention is fitted to one of them before it is built.

| Word | What it is | Who sees it | What clears it |
|---|---|---|---|
| **Needs you** | A decision that waits for this viewer and that they can make now from its own workflow: a question for this decider, a proposal awaiting their approval, an access request inside their ceiling, a checkpoint or unblock; for the operator also the active backlog, submitted onboarding requests, checkout steps he can advance, directive suggestions, feedback to triage, vault conflicts, a team paused by the operator or by a team limit (Resume), a team setup whose next step is the operator's (`setup`: "Setup: <next step>", which opens the setup details) and unclear requirements that **Clarify** can save: a team marks one with a `team_ask` that names it, so its row is that question's (routed like any question, answered with **Clarify**), and a requirement marked with no question is the admin's, with **Ask the team what's unclear**. Home, a team, a project and Blueprint Review show filtered entrances to one list, counted the same way. | The person the decision is routed to: a team's active decider, or the operator when routing sends it to him. Never an agent. | Only resolving it in its source workflow (answer, approve, reject, accept, unblock and so on), by whoever may decide; the row and its count leave every open console together. It cannot be dismissed. The viewer can set it aside with **Later**, which hides it from their own surfaces until a time or until it changes. |
| **For awareness** | Something worth knowing that asks no decision of this viewer: a stalled member, a team its coordinator paused until a set time, a missed milestone, a claim not supported, Blueprint items that block work ("2 items block work in <project>", one row per project and part, also on Blueprint Review; a new blocker is a new episode), a key not collected, changes a team's rule applied without a proposal, an informational notice about a move. It links to the record and names who is responsible. | Anyone who may see the record. Stall warnings are off by default per team and missed milestones off per project; the setting applies to every surface, team badges included. | The condition ending (the member gives news, the milestone is reached or re-dated), or this viewer's dismissal for the current episode. |
| **Notice** | A message from the hub or the operator to an agent (hub notices, **Tell the agent**, directive and Blueprint notices), delivered with the agent's next hub call. | The agent it is for; the operator sees it in that agent's Inbox. | The agent's acknowledgement. Opening a console card never acknowledges a notice. |
| **Alert** | A record the hub raises about an event (a key in a payload, a login burst) or about a workflow that waits (a proposal, a blocked task, an overdue checkout). Listed under **Auditing → Alerts**; urgent ones also above the Home cards. | Admins. | A workflow alert closes by itself when its workflow is decided, and is not shown again beside that workflow's Needs you row. An event alert stays until an admin acknowledges it; critical security incidents stay visible until then. |
| **Agent Inbox** | The area on an agent's page that lists the notices sent to that agent, with sender, time, subject and acknowledgement state, apart from its Activity. | The operator. The agent reads the same notices through its hub tools. | Nothing: it is a history. Each entry shows whether the agent has acknowledged it. |
| **Later** | One viewer setting one Needs you row aside: for 1 hour, until tomorrow 9:00, until next Monday (in the viewer's time zone) or until it changes (the row's version), and never for more than 7 days. The decision still waits for everyone; only this viewer's surfaces change. While it is set aside the row leaves their Home, their Needs you counts and the team card, its workflow alert stays hidden for them, and it is counted as **Later · n** ("· n later" on Home's line, "Later · n" on the Needs you screen). **Bring back now** ends it early. Later is never offered on For awareness rows or on alerts, and it is not **Postpone**, which is a backlog task's state for everyone. | Only the viewer who set it aside. | The chosen time passing, the row's version changing, or **Bring back now**. The row comes back marked "Back from Later". |
| **Dismissal** | One viewer hiding one For awareness row for its current episode. It changes nothing for anyone else: the record, its status, any alert and the audit trail stay as they are. It persists across refresh and devices. | Only the viewer who dismissed it. | A new episode of the same record shows the row again. |
| **Acknowledgement** | An authorized actor confirming the underlying item for everyone: an agent acknowledging a notice, an admin acknowledging an alert. It is recorded and audited, and it is separate from any viewer's dismissal. | Everyone who sees the item, as its state. | It is the clearing act itself. |
| **Episode** | One occurrence of a condition on one record, the unit a dismissal applies to: for example milestone M2 missed with due date 3 March, or a member stalled since its last news at 14:05, or a claim weakly supported since its evidence was last linked, unlinked or removed, or changed status or result (a change of wording alone starts no new episode). | Not shown as a word; it is why a dismissed row can come back. | A new episode starts when what defines it changes (a new due date, a new stall after news). |

## Where am I

Every screen with a parent says where it is and has one way back, from one route tree. The rules:

- **The trail.** Above the title sits a crumb row: **‹** then the screens above this one, root first, each a link
  ("‹ Home › Conclave Developers › Blueprint · Conclave", then the title "Needs you"). The root is the root tab's own
  label, with no area prefix such as "Work ›". Team screens root at **Home**, because Home holds the team list; the Home
  crumb carries the operator's list filters (`o`, `k`, `q`). A root tab (Home, Topology, Sessions, Keys, Vault, Audit…)
  has no trail. The agent, key, PC and onboarding-request screens draw the same row at the start of their context bar
  ("‹ Sessions › Leonor"). On phones the detail app bar shows the title and, under it, the collapsed parent trail
  ("Home › … › Conclave Developers"), then the screen's own count or state after a middle dot; screens write no meta of
  their own.
- **Back.** One rule for the ‹ button, the phone app bar's back and the context bar's: go to the screen this one was
  opened from when that is not above it in the trail (an agent, Activity, another item), else to the nearest screen
  above it. ‹ is an icon whose `aria-label` names the target ("Back to Conclave Developers"); when Back leaves the
  structure it names the origin first ("‹ Leonor") while the crumbs still read "Home › <team>". On phones the app
  bar's ‹ names it the same way, before the title ("‹ Conclave Developers", then "PAP-1"), while the line under the
  title keeps the collapsed trail; it is the same button, not a second Back. An origin lasts for the
  visit: a reload, a link or the browser's history records none, so Back then goes to the structural parent (a team to
  Home with the list filters, an agent to Sessions, `#ob/<id>` to Home). Back never loops: it always ends at a root.
- **Where screens hang.** A team and the Needs you screen hang under Home; its screens (members, settings, status, directives, chats,
  sessions, tasks, a task, decisions) under the team; a question under its team's decisions; a Blueprint section under
  "Blueprint · <project>" (a crumb that opens the team page, or the first section with no team filter), then the team,
  or Home with no team filter; an item under its section. Detail screens hang under their tab: an agent under Sessions,
  a key under Keys, a PC under PCs, a chat under Chats.
- **The contract for new screens.** The tree is `ROUTES` in `server/public/app.js`: one entry per view,
  `{ parent(arg) → [type, arg] | null, label(arg) }` (and `crumb(arg)` for a step that shows in the trail but is never
  Back's target). Labels come from data the console already holds, so a trail fetches nothing. A view returns
  `here: { label, meta }`, its own crumb and an optional count or state; it never builds Back or app-bar meta itself.
  `navTrail(type, arg)` returns `{ crumbs, here, back }` and is the only source of the crumbs, the Back target and the
  phone meta. A screen's area (which rail and bottom-nav item lights) is not in `ROUTES`: it stays in `AREA`, which the
  rail, the bottom nav and the team-screen set read. **Any change that adds a view or a new hash argument shape adds
  its `ROUTES` entry and its `ROUTE_OK` pattern in the same change**; `server/test/console-nav.test.ts` walks every
  chain and fails on a view without an entry, a chain longer than 6 steps or with a cycle, or a `teams` parent.

## Overview and Monitoring

**Home is Work's first tab** (`#home`, before Topology), not a rail button of its own: the rail and the bottom nav have one
**Work** entry (shortcut G), which opens on Home, and the hub opens there too. Home is the root of the console: there is
no Teams tab, and every team screen hangs under Home ([Where am I](#where-am-i)). The Work tab bar sits above the Home
cards.

**Home** is declared once: the cards are listed in `HOME_CARDS`
(`app.js`) in DOM order, which is also the phone order and the Tab order, and from 1180 px they are placed by one
`grid-template-areas` block in `style.css`. Above the cards are urgent items, alerts and the key figures. Then, from
1180 px: **Teams** across the full width (area `teams`); **Backlog** (area `bl`, 8 columns) beside **Work in motion**
(`wm`, 4 columns) over **Activity** (`act`, 4 columns); then **Fleet** (`fleet`, 8 columns) with **Exposure** (`exp`,
4 columns). Below 1180 px every card spans the full width and they stack in that order. There is no Sessions card:
Sessions is a Work tab and a key figure. **Activity** is a flex column whose chart takes the height left in its own
card (at least 150 px on phones and 190 px from 768 px, redrawn through a `ResizeObserver`); its row is the flexible one,
so when Backlog is taller the Activity card takes the extra height. No card reads another card's size. **When the backlog
is empty** (nothing waiting, nothing relayed, no tag chosen), from 1180 px the Backlog card is one line across the width
(its title, "Nothing waiting. Tasks agents propose land here." and **All backlog**), and **Work in motion** and
**Activity** sit side by side under it, 6 columns each. The rule holds for every Home scope (all teams, a project or
keyword, a team). As soon as one task waits the layout above comes back. Below 1180 px the cards stack as always.

**Backlog.** Tasks agents proposed wait for the operator ([Backlog](#backlog)). The **Backlog** card is always shown: "3 waiting" in its header, **All backlog**, and the four oldest tasks,
then "All N in the backlog". Under them, **Opened on your relayed request · n** lists the tasks coordinators opened at
once on a relayed request in the last 7 days that nobody holds yet ("Relayed by <coordinator> from <source> · 2h ago",
**Back to backlog**). The header says "3 waiting · 1 relayed". With nothing waiting or relayed it says "Nothing
waiting. Tasks agents propose land here." and keeps **All backlog**.

**Pinned teams.** Each team in the Home Teams card has a pin toggle leading its row (an icon button, "Pin team
<name>" / "Unpin team <name>", `aria-pressed`; the pin fills in accent when on). Pinned teams come first, in the order
the operator sets (a new pin goes last; **Reorder** on the Pinned line changes it), then the rest as Organize groups
them. The card lists every team, with no cut-off and no "N more teams" row. Pins belong to the signed-in operator and
are kept in the hub (`GET` / `PUT /api/teams/pins {team_ids}`, stored in `system_settings` as
`home.pinned_teams:<admin id>`), so they follow the operator across browsers and PCs. A team that no longer exists drops
out; at most 50 pins. The team name is the row's button for keyboards and screen readers ("Open team <name>"); a click
anywhere else on the row still opens the team.

**Work in motion.** What is going on across every project right now: the latest task changes and plan moves, newest
first, five rows by default.

- **Rows** have two lines, because real task titles run long (median 74 characters, up to 150). Line 1 is the task title
  (or the team, for a plan move or a folded row), cut with "…" and shown whole on hover and when opened. Line 2 starts
  with the change, so the change is the last part to be cut: "Submitted for review", "Changes requested, round 2",
  "Submission replaced", "Blocked: <reason>", "Approved", "Done", "Blueprint: MH-M2 missed · MH-R1 unclear", "Start over asked
  by the operator". Then come the team (it opens the team's part of the Blueprint), the actor (desktop only), the plan key the task
  serves (desktop only), and the time. The icon carries the tone: danger for blocked or missed, warning for changes
  requested, unclear or a re-plan request, ok for approved, done, met or reached. Progress heartbeats are not changes and
  stay out.
- **Folding.** Consecutive changes to one team within a minute fold into one row: the team, "N changes" and the changes
  in order. The full view shows every change on its own.
- **A calm list.** The list does not move under the reader. New changes wait behind "↑ N new changes" and come in when
  the reader clicks it or after six quiet seconds. **Pause** (`aria-pressed`) holds them however long it takes.
- **Demo replay.** While a replay runs (demo mode), each row starts with the story step that caused it (2.24, 3.11b),
  from the replay's step log, and the card counts changes since the replay started.
- **Footer.** "Showing N of M" (since the replay started, or in the last 24 hours), **Show 10 more**, and **All activity**,
  which opens the full view: the same rows unfolded, 30 per page, with **Load older**.
- **Data.** `GET /api/work/recent?limit=&before=&since=` (admin, or a member with the `feed` grant, filtered to granted projects) merges `task_events` and the blueprint's `bp_events` (team plans are blueprint parts; [blueprint](blueprint.md) §2.5). Each event names its `project`; a project-level event (an operator report request, a write outside every part) has no team: its row shows the project name as plain text, folds only with the same project, and a report request reads "Status report asked by the operator".
  It is bounded (at most 50 per page and 7 days back; a bad cursor or an unknown parameter is a 400) and paged with the
  cursor in `next`. Plan updates record their status moves (`moves: [{key, status, was}]` on each `bp_events` row), so the feed
  can say what moved. The card polls every 2 s while Home is shown.

**Monitoring** shows the Sessions, PCs, Requests, Tasks, Messages, Calls and Denials key figures together with the
Activity chart; the sessions themselves are **Work → Sessions** (there is no Sessions table on Home). From 768 px the key
figures are a strip about 48 px tall: each cell is one baseline line (label, value, denominator), with no sparklines at
any width; phones keep the stats grid with NOW and LAST HOUR. The **Tasks** figure scrolls to Home's Teams card and
focuses its search.
**Security → Keys** is the entry point for inspecting keys and grants.

**Home's attention** ([Attention words](#attention-words)). Above the cards, one item at a time: the most urgent of the
critical alerts, the operator's **Needs you** rows (oldest waiting first), the other alerts and the **For awareness** rows.
A Needs you row carries its one-click actions (Approve, Deny, Apply, Reject, Accept, Discard, Unblock, Keep, Adopt and so
on) and **Open**, named after the action when that action needs its own screen (Answer, Review, Clarify, Choose). A
workflow alert is not shown beside its Needs you row, and stalled-member alerts give way to the For awareness row of a
team with stall warnings on (with them off, the hub raises none). Every Needs you row also has **Later**, so the next item takes the top. "N more · 3 need you · 1 for awareness · 2 alerts · 1 later" is a link to
the [Needs you screen](#needs-you-screen) (`#needs`), which lists every row in full, the set-aside ones under its **Later** segment; with only set-aside rows behind the card the line reads "Set aside · 1 later", and with everything set aside Home keeps one line, "Nothing needs you · n later"; both open the screen at Later (`#needs/s=later`). The alerts stay in **All alerts** (Auditing → Alerts). An action goes through `POST /api/needs-you/act`: when another tab or person resolved the row first it
says so, and the row and its count leave together; focus moves to the next row. On a team, project or Blueprint Review
page the count that comes back is that page's ("2 still need you here").

A team page has the same split: **Needs you · N** (the team's entrance, `?team=`) above **For awareness · N** (stalls and
missed milestones from the hub, overdue tasks, warnings, report requests, plan items). Team **Settings → How it works** has
**Stall warnings** (this team) and **Missed milestones** (its project), both off by default; they apply to every surface,
team badges, the members' Stalled flag and stalled-member alerts included. It also has the **Release notes rule** (Off, On,
Paused; [blueprint](blueprint.md) §4, Rules): while it is on, the team's coordinator creates releases and writes their notes
without a proposal. The member console's Needs you card reads the same list, with its For awareness rows under it.

**Changes applied by rules.** Each team with a rule on that applied changes in the last 30 days since the viewer last dismissed it
has one For awareness row, "3 changes applied by rules", meta "Conclave core · Release notes · today". It opens **Changes applied by
rules** for that team: the changes newest first, grouped by day, each with its item key and title, what it did ("Release
created", "Release notes written"), who wrote it and when, and the line "The coordinator wrote these. The Release notes rule
let them apply without a proposal; they are not your approval." Beside it, the **Rule** card names the rule, the team, what it
applies to and since when, with **Pause** and **Turn off** (or **Turn on** while paused). Dismissing the row hides it until a
change on a later day, so it shows at most once a day. It is never a Needs you row: it asks no decision.

### Needs you screen

`#needs` is the whole list behind every entrance, with enough on each row to decide there. It hangs under Home in the
route tree ("‹ Home", title **Needs you**); with `?team=` or `?project=` (`#needs/team=<id>`, `#needs/project=<id>`) the
trail roots at that team or project ("‹ Home › Conclave Developers") and the counts are that entrance's. It is not a nav
destination: Home's "N more" opens it, and the dot on Work stays the only nav signal.

- **Header.** The title **Needs you** (icon and count) sits at the right end of the back-button row, after "‹ Home" and the
  crumbs (a view returns `one: true` for this; under 720 px it wraps below the crumbs). There is no count line under it: the
  segments below carry the counts, and **Later · n** keeps the set-aside rows one click away.
- **Segments.** **Needs you · n | For awareness · n | Later · n**. Alerts are not a segment: **All alerts · n** at the
  bottom opens Auditing → Alerts. Beside it, **Postponed backlog tasks · n** opens Work → Backlog → Postponed (a postponed
  task is set aside for everyone; Later is for one viewer, so the two never share a list). From a team or project entrance
  both the count and the backlog it opens are that team's or project's.
- **Every row, every page.** The hub pages the list at 200 rows; the console reads every page (`next_cursor`) before it
  draws, so row 201 is on the screen like the first. A member's project page draws from the same whole list, so another
  project's rows never push this project's out; its count is the hub's per-project total. The list reads again after
  every decision.
- **When the list cannot be read.** A failed read, first or on a refresh, never reads as an all-clear: the screen says
  "Could not check what waits for you" with **Try again**, the screen says so instead of showing "0", and Home shows a
  row "Could not check what needs you" (it opens this screen) above any alert. A member's Needs you card says the same.
  Only a read that answered with no rows shows "Nothing waits for you".
- **Each row, expanded, title first.** One small line saying what it is (the kind's icon, the kind such as "New brief",
  "Task blocked" or "Question for you", who sent it by label, the team, how long it has waited), the item's own title as
  the heading, its summary in at most three lines (a task's In short, a question's context, a block's reason; the row's
  `summary` and `by` from `GET /api/needs-you`), the context to decide, then the actions: the primary decision first, then the others, **Open** for what needs its own screen, and Later on
  the right (Dismiss on a For awareness row). On a phone the context folds under **Details** and the actions wrap
  under it, the primary one first; nothing scrolls sideways.
- **A team question** reads at a glance, the same on Home (when it is the most urgent item), the team page and this
  screen. Top: a warn chip for what it blocks ("Blocks 1 task", the task titles in its tooltip; it opens the task), then
  the team, the asker and the age, smaller. Then the question as the heading. Then each answer once, as a full-width
  stacked button: its label in bold and its effect on a second, smaller line; the team's recommended answer comes first
  with the accent border and a **Recommended** tag (no meta line repeats it). One click answers through
  `POST /api/needs-you/act` (`action: "opt:<key>"`), which checks the version and the decider as any act does. Then the
  footer: **Details** (folded; a button with `aria-expanded`; it shows the context as Markdown and the blocked task as a
  link; whether it is open is the viewer's own, for the page, never saved on the hub), **Add a note…** (the note box,
  with one button per answer: the note goes with the answer chosen as its text) and ⋯ (Answer…, Later). A question with
  no options, an option whose effect is too long for a button, and a relayed answer (Confirm or Overturn) go to the
  question's screen (**Answer**), where Ask for more and Decline also are.
- **A blocked task with no question.** The block reason as its summary (three lines; Open task has it in full), who blocked it and when, and its assignee, then a reply
  field with **Reply and unblock** (the note goes to the assignee and the coordinators with the unblock) and **Unblock**
  (no note). A task blocked by a question is never this row: the question is.
- **A proposal.** What changes, counted as Blueprint Review lists the operations ("2 release notes, 1 decision, 1
  removal"), with **Review** (Blueprint Review), Apply and Reject.
- **The backlog.** One row, "Backlog · n waiting for you", with the oldest task and its team, and **Open backlog** (Work
  → Backlog). The tasks are not listed one by one here. From a team or project entrance it opens that team's or project's
  backlog (`#backlog/team=<id>&from=needs`, `p=<id>`), with only its tasks and totals, and Back returns to that entrance's
  Needs you. Later stays the viewer's own and Postponed stays shared.
- **Other rows** (access requests, checkpoints, onboarding, checkout steps, directives, feedback, vault conflicts,
  unclear requirements, paused teams) show their reason in full with the actions Home gives them. A checkpoint says how
  its task reached approval, read from the task's history rather than its review setting now: "Approved by <reviewer> ·
  waits for your approval" after a review, or "Submitted without review · waits for your approval" when it needed none
  (created with review off, or its review switched off after it was submitted).

The hub sends the context as the row's `detail`: a question's `context`, `options` (`key`, `label`, `effect`),
`recommended` and `blocks` (the task); a blocked task's `reason`, `blocked_by`, `blocked_at` and `assignee`; a
proposal's `ops` (`op` and item `kind` for each operation). Any row may also carry `step` (the current step, one
sentence, such as a checkout's "Step 3 of 5. …") and `next` (who acts after it), shown first in its context; a row whose
Later ended shows **Back from Later**. After an action the row leaves, its count drops and focus
moves to the next row, as on Home.

## Vault workspace

The **Vault** button opens the vault's view of what is happening in the center
pane. The folder tree stays visible as the operator selects an item and moves
between **Contents**, **Access**, **Activity**, and **Conflicts**.

| Operator question | Where to answer it |
|---|---|
| What does the vault contain? | Expand folders in **Browse Vault**. **Contents** shows the selected folder's files, a text preview for supported files, and the player for an image or audio file. A row for an image or audio file has a **Play** button that opens the same player under the row. A file the console cannot play offers **Download** ([vault](vault.md#media-and-attachments)). |
| How do I look at a task's attachments? | The operator opens a task's **Attachments**: images show in place, an HTML mockup in a sandboxed frame that runs no script, and every other file, SVG included, offers **Download**. A project member sees only how many files there are ([specification](specification.md)). |
| How do I add, change or remove a file? | A folder's header has **New note** and **Upload** (in the overflow on phones). A `.md` or `.txt` file has **Edit**: the editor with **Preview** beside it on desktop and an **Edit**/**Preview** switch on phones, then **Cancel** and **Save**. The file's menu adds **Rename or move** and **Remove**; **History** has **Restore** on a removal or an earlier revision. A save over a newer version shows "Changed since you opened it" with **Reload**, **Copy my text** and **Keep mine**, and adds nothing to Needs you ([vault](vault.md#people-writing-in-the-vault)). |
| Who can access this folder or file? | **Access** lists agents with read or edit grants. Folder reach may cover only some descendants. **Manage access** opens the relevant key editor. |
| What can this agent access? | Select the agent in the picker. Tree icons distinguish reachable folders, readable or editable files, and items outside their grants. Icon tooltips explain each state. |
| Who touched this part of the vault? | **Activity** shows reads, edits, and denied attempts for the selected folder and descendants, or for a single selected file. Rows align the action, actor and path, time, and available diff. One toolbar row sits over it, as on the Audit tabs: the search box (file, folder, agent or action), with **Outside the hub** or **Denied** as a chip when picked in **Filters**, then **All · Changes · Reads**, then **Filters**. The box's ✕ clears the text and the chip and keeps the segment. |
| Is content locked, and by whom? | Show a vault-wide write pause when active. A future per-file lock indicator should show scope, owner, and expiry when applicable. |
| Who is working on this file? | A future indicator should show agents with an explicit, current work signal. **Last touched by** describes recorded history. |
| What did the hub write, and can I turn it off? | **99 Conclave** is the hub's own folder ([vault](vault.md#the-hubs-folder-99-conclave)). In it, Contents opens with a note: "Nobody can write here; the hub replaces its pages." No write action is offered there. When writing is off, it adds "Writing is off in Settings." Its pages show as touched by **The hub**. **Settings** (the last control in the header; **Vault settings** in the overflow on phones) holds the **Hub folder** switch, saved as soon as it flips. |
| Is a handout about to be cleared uncopied? | The `handout_purge_soon` alert (**Handout cleared soon**, a day before the 7-day cap) opens the checkout. A `key_in_result` alert from the vault copy (**Secret kept out of the vault copy**) opens the page. |

### Knowledge

**Vault → Knowledge** (`#knowledge/<tab>`) answers: is the knowledge graph keeping up with the vault, what needs my review, and what is it costing? Tabs: **Overview**, **Entities**, **Flags**, **Jobs** and **Settings**; **Refresh** (with a confirm; in the overflow on phones) recomputes communities and folder summaries.

| Operator question | Where to answer it |
|---|---|
| Is it keeping up? | **Overview**: notes indexed, claims, communities, open flags, jobs waiting and parked, and coverage by folder (a row opens the folder in Contents). |
| What is it costing? | **Overview**: curator spend today against the vault's daily cap; **Settings → Token budgets**: used against the cap for every budget, editable. |
| What needs my review? | **Flags**: stale and contradiction flags with the note, section and the change that caused them; **Mark fixed** or **Dismiss** (asks to confirm). Overview counts old source changes, pending merges and budget blocks. |
| Is work stuck? | **Jobs**: queued, working (by whom, lease left), parked (failed three times) and done. |
| What does the graph know about X? | **Entities**: search names and aliases; type, claim count and aliases per entity. |
| Who gets which jobs, and what comes first? | **Settings → Model routing** (model-label patterns to light or strong jobs) and **Priority folders** (picked from the vault tree). |

Flag reasons are agent-written and shown as plain text.

Access indicators reflect session key grants. App key restrictions and pauses
can further limit a session. Activity remains visible in its file or folder
context even when there is a conflict to inspect.

## Security workspace

The **Security** button opens **Keys** by default. The center pane shows one
Security view at a time. The Security bar's tabs are Keys, PCs, Hardware, Users, Requests, Shares and Relays. **Reset** is not a tab: it is the **Danger zone** at the end of the **Lockdown** page (admins only), so browsing the tabs never lands one click from wiping the hub; at the right
end of that row (lined up with the right edge of the filters below), on every Security tab, one **New** button opens a menu of what to create: **Session key** (for an agent, `#new`),
**App key** (for a PC, `#app`), **Permission template** (`#tplnew`), then, after a divider, **All access options**
(`#grant`, the Agent access page). The menu opens right-aligned to the button. It is lit while one of those pages is open. On a phone the bar keeps **Agent access**
as a tab, and the app bar's **+** offers a session or app key.

| Operator question | Where to answer it |
|---|---|
| Which devices have access? | **PCs** is a table of PCs to compare: app keys and live logins, the agents that called through the PC in the last 7 days, their teams, last seen, **Connection** (the connector's state: Connector online, Connector offline or Disconnected; Bridge online, offline or being set up only on a PC that uses the legacy bridge; else Not connected), and the **Onboarding** state (Request waiting, Keys not collected, Changes asked, Code not used · age, Enrolling, Enrolled). There is no HTTP tag: the connector always uses pinned HTTPS. Below the table, an admin sees **Connector versions**: each version a PC reported or that was added, with **Approve** and **Refuse** (asks once more) while it waits, and how many PCs run it. All, Live, Needs you (folders to approve or a request waiting) and Suspended filter it; a search matches PC, agent and team names. A row opens the PC page. |
| What is this PC doing, and what can I do about it? | The PC page shows whether the connector is **Online** (its service checks in) or **Offline since** a time, the connector, Node, git and client versions, and a setup timeline in which each agent is **Waiting for approval**, **Ready to open** or **Connected**, then **Last active** a time. A failed step shows its reason and one next action, naming who takes it. The actions are **Check this PC**, **Restore** while a checkout targets it, **Suspend access** and, in the danger zone, **Disconnect this hub from this PC**, which lists what will be kept and asks once more. In detail ([the hub route contract](connector.md)): **Connector** lists what the connector last reported (status, versions, clients, auto-update, remote cleanup); each value reads **Unknown** until it reports it, and a version still waiting shows **Approve** and **Refuse** there. **Setup** is the timeline: added, connector paired, team request filed, request approved, keys collected, agents connected; a step that waits or failed says why and gives the next action with **You**, **The PC's user** or **The agent**. **Agents** gives each agent one of three states: Waiting for approval, Ready to open (with its next step, such as "Continue setup on the PC" while its keys are not collected), or Connected · Last active. **Actions** holds Check this PC (its last result, check by check), Restore (to a destination the PC's user approved there, picked from their list; while there is none the card says so and Restore is off), **Update to** an approved version when one is newer, Suspend or Resume access, and the last orders with their state (Waiting for the PC, Taken by the PC, Done, Failed, Expired); the hub stores each one and the connector fetches it on its next call. **Disconnect this hub from this PC** opens a sheet listing what is removed and what is kept, and asks once more; the PC's access is revoked at once and a **Disconnect** card shows **Access revoked**, **Cleanup pending**, **Removed** or **Needs attention** (with what was left on the PC). After a disconnect the PC reads **Disconnected**, Resume access is not offered (the hub refuses it too), and only **Re-enrol PC** brings it back. A PC suspended with Suspend access reads **Access suspended**, never "Offline since". When the PC's user turned cleanup off, the card says "Cleanup turned off on the PC". An admin also sees **Usage · 30 days** at API list prices: tokens, turns and cost, or Unknown until the PC's user turns usage reports on or a model has no list price. Turning reports off on the PC stops new reports only; what was already sent is kept by the hub for 400 days, as any other record under retention. The agent page has a **Usage · 30 days** card (admin only): tokens, turns and cost at API list prices summed over every PC that reported the agent, then one line per PC; it reads Unknown until a PC reports, and turns or cost read Unknown when a row has none. The team page shows the same **Usage · 30 days** section under the Team card (admin only), summed over the team's current members with one line per agent; the connector reports per agent, so an agent in two teams counts in both. A member sees neither. The agent page has a **Messages** card (admin only): per conversation, how many are not delivered yet, how far the session was shown them (reported by the PC, Unknown until it reports) and how far the agent read them. The **PC page** (`#pc/<id>`) also shows the PC (its name with **Rename**, status, last seen, onboarding state with **Revoke code** while the code is unused, bridge, added), its team requests, agents, app keys, teams and proposed folders, then a danger zone with **Re-enrol PC** (a new prompt; revokes the PC's app key, its onboarded session keys and any unused code at once; asks once more) and Disconnect (on phones, both in the overflow, with Suspend access). **Set up bridge** creates the one-hour setup message; **Add app key** opens the app key form for this PC. **Rename** (also **Rename PC** in ⋯) opens a small sheet with the name field, under the same rules as Add PC (lowercase letters, digits and dashes, up to 63 characters). A name another PC already has shows an inline error under the field and changes nothing. A saved name shows at once on the PC page, the PCs list, Topology and Sessions, and `PATCH /api/pcs/:id` writes a `pc.rename` entry (old and new name) to the audit log. Only an admin sees Rename. The PC is known by its id, so its keys, agents, app keys and bridge are unaffected and stay connected; the sheet says that files on the PC itself keep the old name until the PC is set up again. |
| Which machines can agents use, who is using each, for what, and until when? | **Hardware** (`#hardware`), the tab after PCs ([Hardware](hardware.md)). Its header reads "Hardware · 2 machines · 1 in use · 3 waiting", with a **period** select (24 hours, 7 days, 30 days; 7 days first) and **Add machine** (on a phone, in the action bar). Under it the shared list toolbar of the Blueprint lists: a search, then filter chips for each machine, team and agent with what ran in the period, each with its count; an active filter is an accent chip with ✕ on a **Where you are** line ("Showing 4 of 9 holds", the chips, **Clear**). Open flags come first (**Needs you · n**), one row each, by kind: "<agent> was holding <machine> when it lost its task (or access). It may still be using the machine.", "<agent> is still holding <machine> after its window ended.", "<agent> is still holding <machine> past <team>'s daily allowance.", and, where the machine is measured, "<agent>'s hold on <machine>: the machine used 52 GB during this hold, over the 48 GB limit." (or CPUs), each with **Clear**. Then **Machines · n**: one row per machine with its name, its window state ("In window · until 22:00", "Closed · opens Mon 08:00", "Any time", or "Paused"), the holder with its task and estimated finish (or "Free"), the waiting count, three small bars for the machine's CPU, memory and GPU use now (or **Not measured**, with the reason on hover; hidden on a phone) and a chevron; the row opens the machine. Then **Analysis**, for all machines in the period (see the machine page). With nothing registered the screen says so, with **Add machine**. |
| What happens on one machine, and how do I control it? | The **machine page** (`#hwm/<pc id>`) has **Edit** and a **Pause** switch in its header (pausing stops new holders; the holder keeps the machine). Then: **Holder** and **Waiting · n**, as on the list before (agent, team, task, since, estimate, last report; each entry has **Remove**, which asks once more); the **week grid**, seven rows (Mon–Sun) of 24 hour cells in the machine's timezone, open hours light and hours held in the last 7 days dark, edited by dragging across cells (a drag from a closed cell opens hours, from an open one closes them, and the change saves at once as hour windows); under it, the same hours as a **list of windows** (days, from, to), edited in the sheet: the keyboard and phone alternative, and the only form on a phone, where the grid is hidden; **Allowances**, one row per team with today's use out of its daily hours as a bar ("1.5 of 4 h today", or "No daily limit"); **Use now**, the machine's CPU, memory and each GPU as labelled bars with their figures ("41 % of 16 CPUs", "12.3 GB of 32 GB"), "The whole machine's figures 20 s ago, not proof of what the holder ran.", and when **Shared with people** is set, that they include people's own use; or **Not measured** with why (no connector on it, its user has not turned measuring on, no figures in the last 3 minutes); the declared **Limits**; **What ran · n**, one row per hold in the period, newest first: agent, team, task, start, length ("running" while held), last report, "The machine during this hold: CPU 50 % average, 60 % peak · memory …" where it was measured, and a pill per flag; and the **Analysis** for this machine: hours held per day as bars stacked by team (with a team legend), the share of open time held, the median and longest wait, holds with a flag, **Machine use** (While held, and **Use with no holder**, each with averages and peaks), and the top tasks, still ranked by hours held only. The toolbar filters What ran and the analysis. |
| How do I offer a machine to agents? | **Add machine** (the Hardware header; the phone action bar) opens the registration sheet in steps: **Machine** (pick a PC without a compute role, or **Add one by name**, which makes a PC record with no key), **Access** (an SSH alias or instructions; the sheet says credentials stay on the machine), **Opening hours** (timezone, then windows: weekdays, from, to; **Add window**), **Limits** (memory GB, CPUs, GPU, notes, and **Shared with people**), **Teams** (the teams whose agents may join, each with its optional daily hours), **Preview**, which shows the text an eligible agent will get from `hw_list` before anything is saved, and last **Measure this machine** (optional: pair it from its PC page with **Re-enrol PC**, then its user runs `conclave hardware on`; for a registered machine it says whether it is measured now, with a link to the PC page). **Edit** opens the same sheet filled in, with **Stop offering compute** at its foot, which asks once more and says how many entries it ends. |
| Who can sign in, and what does each person see? | **Users** (`#users`) is a table of console users: name and username, role, organisation with an External tag, projects, 2FA, access ends, status (Active, 2FA pending, Expired, Disabled) and last sign-in. All, Colleagues, External and Disabled filter it; a search matches names, organisations and projects. **Add user** asks for the account, External partner (member only, 2FA on, an end date 90 days out), and an optional first project with a preset, then shows the generated password once with a Copy button (the console calls a member a Collaborator). A row opens the user's page. |
| What may this user see, and what can I change? | The **user page** (`#user/<id>`) shows, for a member, one access block per project: a preset (Blueprint only, Follow the work, Full project), the parts as boxes (Graph needs Vault, Topology needs Tasks; ticking or unticking keeps them consistent), vault folders only when Vault is ticked, and an Exports switch; **Save access** saves the draft and shows what the server changed. Beside it: the account with **Edit** (making someone an admin asks once more), the teams they decide for, and a danger zone with **Reset password** (shows a new generated password once and signs the user out everywhere) and Disable or Enable user (both ask once more; on phones, in the overflow). An admin's page says admins see every project. |
| Is anything waiting for access? | **Requests** shows pending access requests and their requested scope. The Security button and Requests view show a badge while requests are pending. |
| Which keys are active, and what do they grant? | **Keys** filters by status. Open a key to inspect its rules and simulate access. |
| What is this key, and what may it do? | The key's **Overview** answers in reading order: what the key is (kind, agent or PC and app, the PC and app it logs in through, the PC binding, status and live logins (a session key that never logged in has **Make a new prompt** beside its status: the same act as Rotate secret, with softer wording and a note that the old prompt stops working), for an app key its **Login limit** (default 100, 1 to 500) with **Change limit** in a sheet that saves, is audited and applies at the next login, created and first used, last used, expiry, the key it replaces); what it may do (folders, tools and rules, each a row that opens its tab, and **Simulate a call**); recent use in the last hour (calls, denied, live logins, the latest denials, a door to every call in Audit); and a danger zone where each action says what it does: Rotate secret, End logins, Suspend or Resume key, Revoke key. Rotate and Revoke ask once more (Rotate secret on a session key opens a sheet that asks "Could this key have leaked?" and offers **Rotate and send to <PC>** by [key handover](onboarding.md#key-handover-a-rotated-key-or-a-recruit-reaches-a-connector-pc), or **Rotate and show the key once** for a key with no connector PC; a key with an open handover shows its status card first). On phones the danger zone is in the overflow. The **PC binding** switch (session keys) binds the key to the PC it logs in through, or asks which PC when it has none; off frees it; **Change PC** picks another. It applies at the next login. |
| What is shared? | **Shares** shows shared items and their details. |
| How do I give a session or device access? | **Agent access** offers a session key with a permission template and expiry, or an app key for a new or existing device. The Security bar's **New** menu opens the same forms directly (**Session key**, **App key**); the Keys header has no buttons of its own. |
| Which app keys can file team requests? | The key list says "Onboarding on" in an app key's line; the key's Overview has an **Onboarding** row ("On since <date>" or "Off") with a switch. On is one click; off asks first ([Onboarding](onboarding.md)). |
| Which permission templates exist, and how do I add one? | **Agent access → Permission templates** (`#tpls`) lists them; a row shows its rules. **New template** (`#tplnew`) takes a name, a description, an optional copy of another template's rules, and rules (effect, actions, resource). Templates can't be changed after saving (no edit or delete route), so **Save template** asks once more. |

**Add PC** is one screen that needs no other reading. It opens from **Add PC** in the header, right after Lockdown,
and from **Add PC** in the More sheet on phones (where Lockdown also lives). The same button on the PCs header and the
phone action bar opens the same screen.

- **Steps.** Three numbered steps come first: name the PC; paste the prompt into Claude Code on that PC; approve its
  request here.
- **Fields.** The PC name, and an optional "What the team should do" (the project, the goal, the roles). Its text is
  appended to the prompt's closing "What I want:", so the person at the PC adds nothing. The agent asks for whatever is
  missing.
- **The prompt.** **Get the prompt** calls `POST /api/pcs/add`. Then, in place, one line and the one prompt
  (`connector_prompt`) with **Copy prompt** and the hub's address. The line says to give the prompt to the user of <PC>
  directly, not through a shared chat; that they paste it into <the PC's coding agent>, which installs the connector,
  pairs it and files the team request; that it holds a pairing code that works once, for 30 minutes (until the time it
  runs out), and only with this hub; and that **New prompt** makes a new code and voids this one. **New prompt**
  (`POST /api/pcs/:id/prompt`, asks once more by arming the button) replaces the prompt in place; it is hidden once the PC
  has used its code. There is no other prompt: when `connector_prompt` is null the screen says why instead (no CA
  certificate on the hub, or no HTTPS public address) and how to fix it, with only **Done**. Re-enrol PC shows the same
  line and prompt, with New prompt, or the same reason. Editing "What the team should do" after the prompt is created
  updates the prompt.
- **Paired just now.** When the code is used, Needs you on Home shows **Paired just now** for that PC: the time, the
  address it came from, and the connector's version and platform, then the warning, with **It was me** and **Revoke**. The
  banner wraps rather than cutting its text. **Revoke** asks once, in a sheet that names what it ends, and its toast says
  "Pairing revoked for <PC>". It stays until one of them is chosen ([onboarding.md](onboarding.md#paired-just-now)).
- **Revoke elsewhere.** Every revoke in the console asks once and says what ends (a key: "Revoke? Logins stop for good";
  a share: "Revoke? Recipients lose access"; a grant: "Revoke? Access ends now"; a PC's code: "Revoke? The code stops
  working"), and its toast names what was revoked.
- **Live status.** While the screen stays open it follows the PC every 3 s through the existing routes
  (`GET /api/pcs/:id/enrolment`, then `GET /api/onboarding?status=pending`): "Waiting for <PC> to enrol…",
  "<PC> is enrolling…", "<PC> enrolled. Waiting for its request…", then "Request filed for <team>", with **Review it**,
  which opens the approval screen (`#ob/<id>`).

**Re-enrol PC** shows a new prompt in its own sheet.
**Settings** on the PCs header (Onboarding settings in the phone overflow) holds the onboarding limits: roles,
agents and agents per role in one request, and filings an hour and a day per PC key. The console has no separate
Settings screen; as for Feedback, the settings sit with the screen they govern.

## Work workspace

**Onboarding request** (`#ob/<id>`, under Home) is the one approval for a PC's team request. Pending
requests are flagged where the operator looks: Home items (Team request from <PC> with its age, oldest first; Keys
approved, not collected yet; Code not used yet), the Work badge, and a **Team requests** band at the top of Home's
Teams card, above the list, shown only while requests wait. Back from a request opened without history goes to Home.
The screen leads with what the hub computed: one row per agent with the vault access its key will carry, its
permission ceiling (generated from the requested folders, or a template), the **Only from <PC>** binding switch
(on by default) and an include box (a new team keeps its coordinator). Everything is editable: roles (name, team
role, count, job, the roles it reviews, folders with read or write), project, **More teams will join** (off by default:
the project's only team keeps its whole Blueprint at project level; on: the team gets its own part), team name, goal
and settings, and **Start when set up**. Warnings from the hub and from the edits (a reviewed role dropped, a worker without a
reviewer, agents left out) update while the operator edits; a write on the vault root needs a second confirmation.
**Approve**, **Ask for changes** (a note the PC sees) and **Deny** end it. The request text sits beneath in a dashed
box labelled **L2 · untrusted** and "Written by the agent on <PC>", as plain text, the user's words folded. After
approval the screen shows the created agents and their slots, the pickup count, **Reissue pickup**, **Cancel
request** and the history.

The **Work** button opens **Home**. **Topology** is the connections graph, Work's second tab (`#topology/<focus>`; old
`#teams/o=topology&g=<focus>` links open it with that focus, and Topology is lit). Its toolbar holds the time window,
the layers and the legend, with no Organize control. At rest, agents sit in clusters
around their team hub (the arc grows with the member count). Each project is one compact block: its team
clusters and, in a small grid, its agents in no team, under the project name. Blocks sit side by side in rows
with a modest gap (No project and group chats last), and the whole picture is fitted to the graph width and
the height left in the window: positions shrink when needed (never the nodes, and only so far that names stay
readable; on a phone the graph may then scroll), and the graph is only as tall as its content, so it always
starts right under the toolbar.

**Zoom has two levels.** **Overview** is the default, on phones too: every agent is a small dot in its state
colour (green working: a call in the last 5 minutes; amber waiting: connected, no recent call; grey idle:
offline), team hubs and group chats are small marks with no names, and each project is named with a badge
counting its working agents. Dashed lines join projects that share a room in the time window; agent lines are
hidden. **Details** shows from 1.8× zoom, and always for a project or team scope: agents become pills with
their role name (the part of the label after its first separator) and a state dot, with team names and every
link. The toolbar holds **Overview** and **Details** buttons around a zoom slider (1× to 3×; phones keep the
two buttons, on their own row). The wheel or a trackpad pinch zooms about the pointer, two fingers pinch on
touch screens (only this graph takes the pinch itself; the Members graph and a collaborator's Topology card
leave it to the browser, so the page zooms as usual), and dragging the background pans a zoomed graph. A click on a project's name, or in Overview on
any of its nodes (a tap on phones), zooms to 2.6× centred on that project. Esc, or **Overview**, goes back to
1×. Zoom scales positions, never the nodes, so text keeps its size. The address keeps the zoom and its centre
(`#topology/<focus>|z2.6@0.42,0.31`, the centre as fractions of the graph), so Back, a reload or a link reopens
the same view. A team's Members graph has one level. In Overview, resting on a dot only names it;
the focus view below works from Details and in the Members graph. Agent names show on hover there, team names
always. When every agent shown carries the same
name prefix up to " · ", " - " or ": " (such as "ECHO · "), the node names leave it out; the tooltip, the focus
panel and the connection list keep the full name.

Resting the pointer on a node for about a quarter of a second (or giving it keyboard focus) opens the focus
view: the node moves to the centre of the part of the graph on screen (a graph taller than the window, or a
page scrolled down, never puts it below the fold; a graph mostly off screen is scrolled to first), its direct
connections form a ring around it that stays inside that part (team first, then messages by count, then links)
and everything else fades out. Positions animate (reduced-motion settings skip the
animation). Resting on a ring node walks to it; the trail above the graph jumps back. Moving the pointer off
the graph, or Esc, goes back. A click (Enter, or a tap on phones) pins the focus so the pointer can leave the
graph; click the focus again to unpin. The live refresh every 4 s reads only what the graph draws (see
[Loading and polling](#loading-and-polling)), keeps the focus and the pin, and redraws
only when something it shows changed (relative times and the 30 s activity colours update every 10 s).
Activity motion (the moving dashes and the pulse around active agents) is stepped and pauses while nodes
move, so the view stays smooth with many active agents.

The side panel (under the graph on phones) lists the focused node's connections by kind (teams or members,
messages, group chats, links) with their last activity; clicking one walks there. Its **Open agent**, **Open
team** or **Open chat** button opens the agent's security and activity panel (logins, role, session keys,
links, recent file activity, calls, and links to its teams and chats), the team's work board or the chat.
`#topology/agent:<id>` opens the graph with that agent focused and pinned. **Connections graph** on a project in
the Home Teams card opens `#topology/project:<name>`: the graph limited to that project (agents it talks to elsewhere stay
visible, faded), under the breadcrumb "Everyone › Connections graph · <project>". The focus is in the address and follows
every walk (`team:<id>` too), so Back and a link reopen it. A bare `#topology` opens with no focus (Everyone). The live refresh patches the graph in place so it keeps the focused node.

**Home Teams card** (`#homeTeams`) answers, at a glance: which of my teams need me, which ones do I keep an eye on, and
how far along is each. One card holds the whole list in two parts.
The header has **Teams** and the count, then **Projects** and **+ Team** on the right
and **Keywords** in its overflow menu; the **Team requests** band follows while requests wait, then the toolbar
(keyword select, search, Organize) and the list. Every team is listed, with no cut-off.

- **Pinned** comes first, in the order the operator sets. Each row starts with a pin toggle ("Pin team <name>" /
  "Unpin team <name>", `aria-pressed`, the pin fills in accent when on). These are the Home pins: one list, kept in
  the hub per operator (`GET` / `PUT /api/teams/pins`); a new pin goes last. **Reorder** (shown from two pins) opens a
  drag handle and ▲ ▼ buttons on the pinned rows only, so every move also works without dragging; **Done** closes it.
  The order is saved as it changes. Pinned teams stay on top whatever Organize says. With no pins the group stays,
  as one line: "Pin a team to keep it on top, in the order you set."
- **Organize** is one segmented control, one click, always visible: **Attention** (default), **Status**, **Project**,
  **A–Z**. Its label and the control wrap together: on a narrow card (768 to 1179 px) they take their own line under the
  keyword select and the search, at the right edge. It orders the teams below the pinned ones, in groups with an overline and a count: Attention gives *Needs
  you* (questions or approvals waiting on you), *Stalled or blocked* and *No issues*, strongest first; Status gives
  Running, Paused, Draft and Done; Project gives one group per project, the most pressing first, whose line holds the
  project's **3 denied calls** pill (opens Audit) and **Connections graph**; A–Z is one flat list. The choice is in
  Home's address (`#home/o=status`, `o=project`, `o=name`; none for Attention) and kept per operator in the hub: a link
  wins, a bare `#home` (the Work button, the hub start, Back) opens the last choice and writes it into the address, and
  Back returns to it. A search matches teams, agents and projects and filters both parts; it is in the address too
  (`q=`) but never remembered. An old `#teams/o=…&k=…&q=…` link opens Home with the same choices
  (`#home/o=status&q=gest`). While the operator types in the search, the 10 s refresh redraws the list in place, keeps
  the text and the caret and replaces the address without a new history entry; while **Reorder** is on, or the keyword
  select has focus, it waits.
- **Keyword** is a select right before the search: **All** (default), then each known keyword in the order set in
  Projects → Keywords. A team shows when the team or its project has the keyword, and the search applies on top;
  a project group shows only its matching teams. Unassigned agents carry no keywords and are hidden while a keyword
  is chosen. The choice is in the address (`k=Applications`) and kept per operator in the hub (`GET` / `PUT
  /api/teams/keyword`) like Organize; a keyword removed since reads as All, and the empty state names the keyword
  ("No team matches Applications"). While a keyword or a search hides teams, **Reorder** is not offered.
- **A team is one row**, and each team shows once: its name, then the project and the lead beneath (the status word
  too when the team is not running: Paused in warning, with its end time when it has one, "Paused until 07:50", Draft, Done); up to two attention pills beside it, **N waiting
  on you** (bad), **N blocked** and **N stalled** (warn), **N in backlog** (info, last), and none when nothing needs anyone; the task bar with
  `done/total`; and the time of the last activity. On desktop the name and its line take the free width at the left; the
  pills, the task bar, the time and the chevron sit at the right in fixed columns, pills right-aligned next to the bar, so
  the bars line up row under row. A running team has no status pill: only exceptions are marked. The
  whole row opens the team; the name is the keyboard way in, and the pin is a separate control. Members, the goal and
  the full attention list are on the team page and in the row's `title`, not in the row.
- **Phones:** a row is two lines, the name over `done/total tasks · project`, with the strongest pill, the time and
  a chevron on the right. The keyword select and a search button share the first toolbar row, Organize is the
  full-width segmented control under them (with no label), and the search, when open, goes below; **Reorder**
  and its ▲ ▼ buttons work as on desktop, with 44 px targets.
- **Shortcut M** opens Home and focuses the team search (the shortcuts sheet reads "M Teams on Home").

Agents in no team stay the last group, "Unassigned agents": rows with a round agent icon that open the agent, hidden
when there are none. The status chips with counts, **Needs you**, the Sort select, the Members and **Open team ›** columns,
the column headers, the project bands and their fold buttons are gone: Organize replaces the first three (its first
Attention group is Needs you, its Status groups carry the counts), and the rest was detail that the team page already
holds.

A **team page** (`#team/<id>`) answers, in this order: what needs me (questions, relayed answers to confirm, approvals, blocked and overdue
tasks, stalled members, plan items to decide, an open status or plan request), where its part of the project stands,
the tasks, and the team. The header's muted line ends with **Backlog · n**, the team's active backlog, a link to Work →
Backlog filtered to the team (the same scope as the list it opens, SPEC-BLUEPRINT-05), hidden at 0; the Blueprint
screen's title carries the same link for the whole project. The **Needs you** card uses the Needs you screen's rows,
and its header links to that screen filtered to the team: **See all**, and **Later · n** when you set rows aside. A blocked task without a question for you carries **Unblock** (`task_unblock`'s operator
route; a short sheet takes an optional note, and the task returns to the step it was blocked at); the task screen
has the same button while the task is blocked. The status request row reads the team's open `bp_report_requests` row
("Asked 2 d ago for the whole project; no report yet"), so each team of a multi-team project shows only its own.

A **task screen** (`#task/<team>|<task>`) answers: what the task is in a sentence or two, where it stands, who holds it,
and what review said. **In short** comes first: the coordinator's `short_summary`, or the hub's cut of the brief (an
info tip says so); the full **Original brief** is folded under it. Then the lifecycle, People beside it, and **Review
rounds** only when there are rounds (no empty headings; a zero round count is left out of People). Files and the
timeline sit below the main column, or in a third column from 1600 px, where the timeline starts open.

**Attachments** ([specification](specification.md), "Task attachments") show on the operator's task screen in two places.
- **The brief's**, under In short: a header line, "Attachments · from the brief", with who added the version, its
  number, when, and the file count and size ("Coordinator · v2 · 19 Nov 09:12 · 3 files, 1.4 MB").
  - Images (PNG, JPEG, GIF, WebP) are 160 px thumbnails in a strip that scrolls sideways, each with its name and size.
    A thumbnail opens the **viewer**: the image at full size with its name, pixel size and file size, and **Previous**,
    **Next**, **Download** and **Close**. The arrow keys step and Esc closes.
  - An HTML mockup is a card ("Mockup · 46 KB · shown without scripts") with **Preview**, **Open in a new tab** and
    **Download**. Preview opens the **locked frame** under the card: a `sandbox` iframe 260 px high, headed
    "rename-sheet.html · locked preview: no scripts, no network" with **Close**. The hub's header locks the page the
    same way in a new tab ([design guidelines](design-guidelines.md), "Mockups in the locked frame").
  - Any other file, SVG included, is a row with its size, why it is not shown ("not shown inline", "SVG is download
    only") and **Download**.
  - A version copied from a share says so under the header ("Copied from the share "rename screenshots", version 3").
  - The operator's **Attach** (a ghost button on the header line, or the whole row while the brief has none) picks PNG,
    JPEG, GIF, WebP or HTML files, at most 1 MB in one go, and adds them to the brief as its next version; a file of the
    same name replaces the earlier one.
- **The submission's**, in each review round, beside the summary from 1180 px and under it below that. A round's
  header reads "Round 2 · submitted 19 Nov 14:02 · Developer 2". Files named `before-…` and `after-…` with the same rest
  of the name show as a pair, labelled Before and After; the other images follow as thumbnails, then the mockups and
  other files as on the brief. The newest round shows its files; an earlier one folds to a line ("4 screenshots ·
  Show").
- **Removed** sets read "Removed by the administrator on 19 Nov." in place of the files.

A board card with attachments carries a paperclip and the count. A project member sees the same count on the shared
board and in the task sheet ("7 attachments"), with "Attachments are visible to the team and the operator only.",
never a thumbnail, a name or a file. An external member sees no board. When a team's attachments reach 80 % of its
limit, Needs you lists it ("Conclave Developers' attachments use 4.1 of 5 GB") with the team's settings to raise it.

A team's **Pause** opens a short sheet: an optional end time ("Resume by itself at", empty for no end) and an optional
reason. While the team is paused, the title pill reads **Paused until 07:50** (or **Paused** without an end time), and
the pause is one item of the team's attention lists ([Attention words](#attention-words)), "<team> is paused" with
"until 07:50 · usage limit, by the coordinator". A coordinator's pause, which ends by itself, is a **For awareness**
row. A pause the operator set or a team limit is a **Needs you** row for the operator, with **Resume**, because only the
operator ends it; Home's Needs you lists it too. A checkout keeps its own checkout steps. A pause ends by itself at its
end time; a pause
still running past it raises the `pause_overrun` alert. **Resume** ends any pause at once, a coordinator's too.

A team's **Checkout** (`#tco/<id>`, [checkout](checkout.md) §7) answers: where each agent is in its handout, what
waits on me, and what to do next. The team page's menu holds **Check out team** (or **Open checkout** while one is
open), and while a checkout holds the team the title pill reads "Paused for checkout", Resume is hidden and a card at
the top of the first column leads to the screen. The card states the current step in one sentence, from the checkout's
own state ("Step 1 of 5. Developer 2 merged its work and left 2 leftovers that wait for your review."), with five step
marks, the one action you can take now (Review the leftovers, Choose the target and keys, Run the
restore prompt), which opens the screen, and who acts next by label ("Next: Developer 3 writes its handout.");
**Open checkout** is always there. The checkout's Needs you rows read the same sentence (`step` on
`GET /api/teams/:id/checkout` and `GET /api/checkouts`). The screen shows, top to bottom: leftover exceptions to approve or
refuse (each with a note), the handouts per agent (checkpoint, merged commits, unreviewed commits on the agent's checkout branch, `checkout/<id>-<member>` or `checkout/<id>` in older reports, "Nothing to merge" with the reason for an agent that reported no repository,
status) with progress and expiry, and **Go on without missing handouts**; when ready, the target and keys form
(refused targets disabled with the reason, permissions capped at Default) and a summary of what happens to the keys;
once rendered, the one-time prompt with Copy and its expiry (kept in the page only, so a reload says it was shown
once), the new-PC approval with the PC's name and IP, the **config scan** and the push list. The config scan lists
each agent folder the restore scanned: "Nothing found", or its findings (kind, path, one-line detail; reported by the
target, so escaped and labelled as data) with **Approve** (a confirm sheet: the folder is then trusted and its config
runs without the provider asking) or **Leave untrusted**; its title counts the folders still to decide, and no key is
collected until none waits. Decided scans stay on the screen while restoring and after. Finish and Cancel checkout
confirm first.

Home's urgent list (Attention) answers "which checkout waits on me, and for what". It shows one row per step a checkout
waits on the operator for (`GET /api/checkouts?open=1`): leftover exceptions for an agent, handouts missing near
expiry, handouts complete (render) and a prompt nearing
expiry. Each row's **Open checkout** opens `#tco/<team>`. A team held by a checkout with no such step keeps one
"Paused for checkout" row. The `checkout_overdue` alert also opens the checkout. The **Settings** sheet on the PCs
header has two sections: **Onboarding** (the request limits) and **Checkout · repo hosts**, the allowlist a handout's
repo URL must match ([checkout](checkout.md) §8). That section has a row per host with a remove button, an add row and
a line saying whether the list comes from settings, the environment or the default. Save writes it only when it
changed. Each limit and section says what it does in one plain line under its label, not behind an info button (on a
phone an info button opens a sheet of its own in place of this one), and titles and help lines wrap rather than being
cut off; **Claim all existing agents as mine** sits on its own line under its row.

The **Blueprint card** replaces Objective; a team page shows exactly one ([blueprint](blueprint.md) §9). Its header is
the overline every card has, "BLUEPRINT · IMPLEMENTATION" ("RESEARCH" for a research project: the kind sits where the
other cards show a count), with the project's name under it; it opens the Blueprint's first section, filtered to the
team (its `aria-label` says "Open the Blueprint of <project>"). When something waits for the operator, one line says so
under the header. It counts the same list Blueprint Review shows (its Needs you and For awareness rows, with the same team
scope), so **Review** always opens what the line counts: "2 changes wait for you" (to Proposals) for open Blueprint
changes, "3 items need you" (to Needs you) for unclear requirements and changes together. With nothing waiting, rows for
awareness are named as what they are ("1 claim not supported", "2 acceptance criteria failing", "3 items for awareness")
with **View** (to Needs you), and open proposals someone else reviews read "1 proposal open" with **Open** (to
Proposals); otherwise there is no line. When the list cannot be read the line says "Could not check what waits for you",
and the screen says so with **Try again** instead of "Nothing waits for you".
Then **one list**, a 44 px row per part of the Blueprint, each opening its section in one click. A row shows a bar where
something is measured, otherwise a count, both ending on one right edge:
- **Implementation:** Foundation (no count), Requirements (bar, verified of the live FRs and NFRs), Acceptance (bar,
  passing of the live criteria), Decisions (the architecture and decisions, the project's own included), Milestones
  (bar, reached of the live milestones), Risks ("2 open" or "None"), Appendix (count), Coverage ("3 gaps" or "No gaps").
- **Setup**, after Coverage (in either kind), when the team was created by an onboarding request: `Setup · <state> · <the
  source, in short>`, the value in the state's tone (Done plain), the full source in its tooltip. It opens the setup
  details in a sheet; the team page has no Setup card while the Blueprint card shows ([onboarding](onboarding.md#setup-progress)).
- **Research:** Foundation, Lines ("3 active"), Hypotheses (bar, decided of the live ones), Findings ("5 this month"),
  then a **Papers** overline with one row per paper ("PAP-1 · due soon", a bar of claims supported, or **Ready**; it
  opens the paper), then a **Plan** overline: Decisions, Milestones (bar), Risks, Appendix. A research project's header
  opens the **research workspace** instead of the Foundation. Coverage follows Appendix here too.
- **Dropped** (count), last, only when something is dropped.

A row whose count is a list opens exactly that list: "Requirements 3/12" opens the 12 live FRs and NFRs, "2 open" the
two open risks, "5 this month" the five findings, each as the server's paged list with that selection set, so the
number on the card and the list's total always agree ([blueprint](blueprint.md) §6.1). A bar with nothing to measure
(0 of 0) is not drawn; the row stays, so an empty section and its first action are still one click away.

The foundation, the decisions and the appendix belong to the whole project, so a team's counts include the
project-level items. The health of the newest report is on **Team status** (the team's overflow).
**Decisions** (the team's questions) are on the TEAM card. A relayed answer (recorded by the coordinator from a chat, L1) shows
**Relayed · confirm** on its row and in the team's Needs you until the operator settles it; its question screen shows "Relayed by
<coordinator> from <source>" with **Confirm the answer** and **Overturn…** ([decisions](decisions.md#relayed-answers)).

The **question screen** (`#dec/<id>`) answers "what is asked, what do I need to know, and which way do I go?" in one
pass, top to bottom: the question as the page heading; one line under it with the blocked task in red ("Blocks <task>",
opening the task; a linked task that is not blocked reads "Linked to <task>" in muted text), the team and the age
(and "needed by" when set), then the plan items it names; the agent's **full context**, never clamped, with no heading;
the options as cards, the recommended one first, marked **Recommended** and highlighted, each with its own **Choose**
button (primary on the recommended one), so **one click answers**; then **Add a note**, which opens a field whose text
goes with the option you choose, or is sent alone as your own answer with **Send as my answer**. A question without
options shows that field open with **Send answer**. There is no bottom action bar: **Ask for more information** and
**Decline to decide** are in the overflow menu. The member's question page (`#m/dec/<id>`) is built from the same parts
(heading, context, option cards, note and the one-click answer); there **Ask for more** and **Decline** are buttons
under the options, since the member console has no overflow menu.

The **Blueprint screen** (`#blueprint/<project>|<tab>|<team>|<status>`) is the project's, not the team's: `#objective/<team>`,
`#goal/<team>`, `#plan/<team>|req|ms|sum` and `#project/<project>` redirect to it (the team filter set, Requirements
or Planning for the plan lists), so old links and the Work in motion team buttons keep working. There is **no Overview
page**: the team page's Blueprint card is the index. A link to the former Overview (`#blueprint/<project>|ov`) opens
the team page when it names a team, and the first section otherwise. Each section, Needs you and Proposals is its own
screen, so there is no tab strip and no list on the side; the trail reads "Home › <team> › Blueprint · <project>" and
Back goes to the team page (Home with no team filter; [Where am I](#where-am-i)).
The header is the team page's: the project's name with its kind as a pill and a muted line ("Blueprint · <section>").
**Foundation** opens the project information: its vision, kind, teams, milestones and, for an ecosystem, the overview of its projects (each with health, next milestone and what waits, or "No report yet"), with **Project settings** for the administrator. A **Team** select (all teams, each team, project level) filters every screen, shown only when two or more teams contribute: a project with one team (FR-PLAN-12; a project set to Single team is one) reads as one list of project and team items, and the scope stays in the link and on Back. Inside a
section one row of filters: a search field (key, title and body, searched by the hub), a segmented control **Open · n ·
Dropped · n · All · n** (Open first and All last, as in every state filter in the console; a selection a card opened,
such as Live or This month, sits right after Open) and a **Filters** button ("Filters · 1" when one is set) whose sheet picks the kind, in the
section's words (FRs and NFRs; ACs; Lines, Hypotheses, Questions, Findings; Papers), and the exact stored status. The
filters are the route's fifth part (`|q=…&kind=…&sel=open&at=…`), so Back from an item returns to the same list and
page. With no filter the section draws its grouped cards (below); with any filter it shows the hub's list, 25 rows a
page in a deterministic order, each row the item's key, title, status pill and team, with a **Pager** under it ("26–50
of 112", Previous, Next). A filtered list that is empty says "Nothing matches these filters" with **Clear search and filters**; an
empty section offers its first action (**Ask for a plan** on a team's part, the plan request). The app bar holds only the overflow (⋯). Its first row, at every width, is **Ask for a report** (one request per running team of an active project, each
answered by that team's own report; a sheet takes an optional note), then **Export** (`export.md`)
and **Start over** (red); on a phone the overflow holds **Ask for a report** only.
- **List analysis** breaks a long section list down, the same way on every section; every count in it is the hub's
  (`GET …/browse` `counts`, `facets` and `cross`, [blueprint](blueprint.md) §6.1), never the console's:
  - **The row** is one row (two on a phone): the search field with chips, the Open · Dropped · All segment, then **Gaps** (a short menu of this section's gaps,
    each with its count, one active at a time; each gap is a named selection, shared with Coverage and the section-2
    summary), then **Filter** (the sheet above, with one group per dimension of the section, each value with its count
    under the other filters), **Views**, and at the end **Show count table** or **Hide count table**, a quiet icon button
    (`aria-expanded`, `aria-controls`, no `aria-pressed`) offered only where a table is (two dimensions or more), never on
    the section summary. The active filters are chips inside the search box, before the text, in this order: status, kind,
    the dimension filters, then the gap (see [Search field with chips](design-guidelines.md)); a default is never a chip.
    The ✕ at the end of the box, **Clear search and filters**, clears the text, every filter and the gap, and keeps Open ·
    Dropped · All, the team, the table's axes, the group and the sort. Past two lines the last filter chips fold into
    "+k", which opens the Filters sheet; the gap chip never folds. There is no Where you are line: "1 filter no longer
    applies" and the reason items are hidden stay as muted lines under the row.
  - **The count table** is always a full-width card above the list, at every width, and never scrolls inside itself (no
    side-by-side layout, never sticky). Folded or not offered, the list follows the row. Its header is one line,
    "**6** of 21 · Line ▾ by Confidence ▾ ⇄": "N of M" (the one live region, `aria-live="polite"`, focusable), the Rows and
    Columns selects (inline, sentence case, a visible ▾, those accessible names), and the swap (44 px on a phone). A table
    too wide for the card is **turned** when swapping rows and columns makes it fit ("Turned to fit" by the swap button); a
    swap or a Rows or Columns pick of the viewer's own is kept until the window's width changes. If it still does not fit,
    the side with fewer columns keeps the columns with the largest totals and folds the rest into a last **Other · k**
    column, each cell the sum of the row's folded columns; clicking it opens a small popover listing them with their
    counts, each filtering like its own cell. The console re-fits when the window's width changes. A cell click keeps the
    page where it is and the focus on that cell. Totals are muted and right-aligned, a zero is faint, the selected cell has
    the accent outline. The number columns keep their size (column headers wrap to two lines before they are cut) and the
    row names take the free width, wrapping to three lines before they are cut (96 px at least); the full name is the
    tooltip, and a cell never shrinks below its number. Two dimensions picked as rows and columns,
    each cell its count, cells holding gap items tinted, and a click on a cell sets both filters (a second click clears
    them). On a phone it is a list, one row per row value with its count and a chevron to the column values, never a
    sideways-scrolling table. An item with several values of a dimension (an FR delivered by two milestones) counts in
    each column, so the card then says "An item can sit in more than one column"; "N of M" counts items once.
    A **No milestone** column holds the items with none.
  - **The list overline** reads "MATCHING · 18 · Grouped by line ▾ · Most at risk first ▾" (the shared list overline, see
    [design guidelines](design-guidelines.md)): Group by and Sort are inline selects whose options carry the words ("Not
    grouped", "Grouped by line"; "Blueprint order", "Most at risk first"…), in sentence case with a visible ▾, keeping
    the accessible names Group by and Sort, 44 px on a phone. While the count table is folded, "N of M" is the overline's
    count instead ("MATCHING · 18 of 112", the same live region, the focus held across a fold); it is never added to a
    group's count.
  - **The grouped list** groups by any dimension with the existing group rows and overlines, a group's count after a
    middle dot ("M2 · 14"), with the same **No milestone** group. Sorts: most at risk (from the `risk` and `decide`
    reasons the summary already computes), oldest change, name (`s=risk`, `s=old`, `s=name`; the hub's `g` and `s`,
    so groups and pages hold across the whole list). **Blueprint order** is the hub's default order: the link then has no `s=`. An item with several values sits in each of its groups.
  - **Where it shows:** the paged list of sections 2, 4 and 5, so each screen the team card opens (Requirements,
    Acceptance, Hypotheses, Findings, Milestones, and Risks with issues, kind as a filter) has it. The count table opens
    on the pair for what is in view: requirements area (module) × milestone, acceptance area × result (status),
    hypotheses line × verdict (status), findings line × confidence, milestones phase × status, risks and issues
    likelihood × impact (an issue has no likelihood, so it counts in the table only when the kind is Issues, as impact
    × status), and anything else kind × status. The Rows and Columns selects pick any two dimensions in view; **Hide
    count table** (at the end of the row) folds the card, **Show count table** brings it back, and the link remembers it (, which the console never sends to the hub).
  - **Chips** are square-ish (3 px corners) like the mockup: a gap chip is warn-tinted, an active filter chip is the
    accent with ✕, each its own button named "Remove …"; every cell and group row is a button reachable by Tab, with its
    count in its name ("Milestone M2, 14 items").
  - **Saved views** keep the filters, the gap, the table's axes, the group and the sort, never counts or items. They
    live in the hub, per user and per section, in the per-user store Home's pinned teams use (`system_settings`,
    `blueprint.views:<user id>`, through `GET` and `PUT /api/blueprint/views`): at most 20 per section, a pinned view
    first. **Views** sits in the toolbar row beside Filters (on the section summary too) and lists this screen's views: a row opens
    the view, and each row has Pin, Copy link and Delete. **Save view**, the menu's first row shown only while the view differs from the default, asks for a name and Pin it; saving under a
    name the screen already uses replaces that view, and at 20 it says to delete one first. They are re-checked on read (a view naming a project the user no longer sees drops out), left out of the
    export, and removed with the user. A member keeps views on what they read.
  - **Refine with coordinator** (section 2, Requirements; a toolbar button after Views, in the ⋯ menu on a phone) sends a plan request in words ([blueprint](blueprint.md) §2.6). Its sheet has **What should change** (required, at most 2000 characters), **Which requirements** (the ones the current filters show, or all; frozen as keys when sent), **Checks** (Consistency on, Duplicates on, Missing acceptance criteria off) and **Send to coordinator**. Until the coordinator answers, For awareness shows "Refining requirements · waiting for the coordinator" (never Needs you); asking again edits the open request, and once a proposal exists the only way back is Send back. The proposal is a Needs you card that opens the **review**: one row per change, **Added**, **Changed** (new text, the old struck through) or **Removed** (dropped, never deleted), with the coordinator's reason, its resulting status ("Added · agreed") and a tick, all ticked by default. Ticking a change that needs another ticks that one too and shows "needed by FR-…" (the hub's `needs`, never the agent's words); unticking a change unticks what needs it. **Apply n of m** writes exactly the ticked ones in one batch (history: "4 of 5 applied"); **Send back with a note** rejects it, the request stays open and the coordinator is told.
  - **The link** is readable and versioned, in the route's fifth part, for example
    `|v=1&f=status:agreed,module:TEAM&gap=no_ac&x=module*milestone&g=milestone&s=risk`, with its `ROUTES` entry and
    `ROUTE_OK` pattern in the same change. It holds closed words only: dimension ids, stored values, item keys, team
    ids, and the search `q` as today. No names: the owner filter is has owner or no owner, or a stakeholder key. A
    value that no longer applies is dropped with one muted line, "1 filter no longer applies", the same for an
    unknown value and one outside the viewer's scope.
  - **Scope.** A shared link carries filters, never results: whoever opens it gets counts computed for them. Gaps and
    filters that read tasks (**No task**) show only with task access, and the line says why ("No task needs task
    access"). Cursors stay bound to the filters and the viewer. The section-2 summary (Waiting on a decision, At risk,
    the area cards) stays section 2's default view; this row acts on the lists it opens.
- **Research workspace** (`|res`, a research project's first page) answers "which papers are planned or out, and which
  hypotheses do they rest on?": a **Papers** card (planned and published, each with status, deadline, claims supported
  and the manuscript when you may read it) and a **Hypotheses** card (status and criteria). A **Milestone** and a
  **Hypothesis** select filter the papers, and each filtered row says why it is there ("Studies H-L1-02", "PAP-1/C2
  cites H-L1-02 as evidence", "Delivered by M2"). A **hypothesis** page reads in the order a reader asks, using only
  the fields a hypothesis has:
  1. the **head**: key, title and status pill, then one meta line (its line, the line's mode, the team, who changed it
     and when), with the hub's standing line and **Next** step under it in one plain panel ("Testing. Backs C2, from
     4 findings." / "Next: Decide its status: 3 of 4 findings have medium or high confidence."). Both come from the
     hub ([blueprint](blueprint.md) §2.7), never from agent text;
  2. **Statement**: the `statement` field as Markdown in a larger body size, the summary under it in muted text;
  3. **Criteria**: the `criteria` field as one Markdown block. A hypothesis under a validate line without criteria says
     "No criteria written";
  4. **Results**: the `evidence` note first, then the findings linked as evidence (not every finding of the line),
     newest first, each with its confidence in words and as three small bars, and its date;
  5. **Papers** that study or cite it, each with why;
  6. **Experiment runs** (tasks tagged `run` that name it, with task access only) and **Status changes**, dated;
  7. any other field an agent wrote, as rows;
  8. **Records**, last and always folded: the screen already puts what a reader wants first.

  Links, Tasks and History sit on the right, and stack under the left column on phones.
- **Sections** draw as cards: Foundation (summary fields, stakeholders), Requirements (FRs by module with "Must · 2 of
  3 ACs passing · Unplanned", NFRs by category; research lines as cards, a validate line with hypotheses and verdict
  pills and its findings, an explore line with questions and findings only, no verdict or progress, and four counts
  above them), Decisions & Architecture (the decision log by date with its source, and the overview text; see below), Planning &
  Execution (milestones, releases, papers), Tracking & Governance (the newest three reports with health and
  escalation, risks and issues), Appendix (glossary, references). A row that does not read plainly yet adds one
  amber part to its meta ("2 undefined codes", "Nothing to check"), and a requirement's **Acceptance criteria** card
  says "· 2 empty".
- **Decisions & Architecture** reads like a document with notes beside it. From 1180 px the section is two columns
  (7 + 5 of 12): the **Decision log** on the left and the **Architecture overview** on the right. The overview is
  sticky under the app bar, and when it is taller than the window it scrolls on its own. Below 1180 px it is one
  column: the overview comes first, folded to its first four lines with **Show all**, then the log. There is no
  sideways scroll. With no overview the log takes the full width, and with no decisions the overview does. The
  search, the Open · Dropped · All choice and **Filters** stay above both columns, because they filter the whole
  section; a filtered section is one paged list, as in every section. The rule holds for every project kind and for
  every team's part.
- **Appendix** answers "which codes in use has nobody defined?": each glossary row shows the term's first sentence and
  its other spellings ("also T', T-prime"); under them, **NOT DEFINED · n** lists each code the items use that no term
  defines, with where it is used ("Used in M3, PAP-1/C3 +4") and **Define** (a sheet: title, a one-sentence
  definition, other spellings; the term applies at once, because terms are the operator's).
- **Needs you** is Blueprint Review, the project's entrance to the viewer's Needs you list (`GET /api/needs-you?project=&review=1`, the team filter applies): a row to the proposals that wait for this viewer, then the unclear requirements with **Clarify**. Under **For awareness**: claims not supported and missed milestones (with **Dismiss**), and failing ACs.
- **Clarify** answers an unclear requirement. A team that marks a requirement unclear asks the operator one question with
  `team_ask` (its `refs` name the requirement) and points the mark at it (`unclear_ask`), so the question and its answer
  live where every other answer lives: one notice, the decision log, one trust rule. Clarify on the Needs you row (Home,
  the Needs you screen, Blueprint Review) and the item page's **Unclear** pill open the same sheet:
  - **Head**: the key and title, the priority, the team that asked and when.
  - **What the team asks**: the question, as plain text under "<team> asks" (agent text, never rendered as Markdown or
    links).
  - **The requirement**: its text (the item's body, "No summary written" without one), and its evidence folded under
    **Evidence**.
  - **Your answer**: a text area (1 to 2000 characters), then **Send and mark clear** (primary), **Edit the
    requirement**, **Drop it** and **Later**. Send answers the question (`POST /api/decisions/:id/answer`) and the hub
    clears the mark in the same write; the team gets the answer as the question's answer notice. **Edit the requirement**
    opens the title and text in the sheet, the answer kept, and **Save the edit** sends the answer first, then saves the
    edit; **Drop it** sends the answer, then retires the requirement. If the answer is refused, nothing else is written.
    The answer is the item's revision note ("clarified: …"); the edit or drop is a later revision, with the same
    note in the item's own history and in the project's change log. Edit and Drop change the requirement, so a decider sees only Send.
  - **Refusals**: if the team cleared the mark while the sheet was open, the sheet says "The team cleared this already"
    with **Open the requirement**, never a bare conflict; any other change says the requirement changed and reloads.
  - **No question** (an item marked unclear before this rule): "The team didn't say what is unclear", the evidence as
    context, and **Ask the team what's unclear** in place of Send (a fixed notice to the coordinator); Edit and Drop
    stay, and clear the mark, with the note box as the write's note. A decider sees only Later. Old items are not
    rewritten.
  - **Declined question** (the team's question was declined and the mark stayed): the row reads "The team's question was
    declined", and the sheet says there is nothing to answer, with **Ask the team what's unclear**, Edit and Drop as for
    an item with no question.
  - **History** names who answered or changed it: "You", or the other user's name (a decider, another admin).
  - **Afterwards** the item page reads "Clarified by you · 19 Nov" (or the decider's name) with the answer, and the
    item's history keeps it.
- **Coverage** (`|cov`, the card's Coverage row) answers "what is missing that nobody would see without reading every item?": one card per gap list with its count (No acceptance criteria, No milestone, No task, Passing with no evidence, Decisions governing nothing, Questions older than 14 days), each row an item's title with "Requirement · Agreed · no open or done task" or "Question · Open · asked 2 Nov · 16 days" under it, opening the item. A meta line above says "5 gaps in 4 lists · counts the tasks you can see". With no gaps it is one line: "No gaps: every requirement has criteria, a milestone and a task, and nothing is waiting." Coverage is a view: nothing in it reaches Needs you or For awareness. Layout: each card is as tall as its rows and never stretches to its neighbour; a card shows its first 8 rows and a **Show all n** button ("Show 50 of n" when the hub sent only the first 50; `aria-expanded`, "Show fewer" when open) shows the rest in place, so one long list does not push the next row of cards a screen down. Two columns from 1180 px, the cards in list order row by row and the last one alone at the left when the count is odd; a single list takes the full width, like the other Blueprint lists. One column below 1180 px, phones included, with no sideways scroll.
- **Status meanings**: on an item page, an FR, NFR or AC status pill whose status has a meaning in this project sits in a focusable wrapper, the `.ref` tip pattern: hover or focus shows "**Built** in this project: <the operator's sentence>" and "Set by the operator in project settings"; a tap on touch opens it as a sheet ("What Built means", **Close**). The pill does not become a button; a status without a meaning draws as before. **Project settings** has a **What each status means** group: one field per status of FRs, of NFRs and of acceptance criteria, each labelled with the status; an empty field means that status has no meaning here.
- **Dropped** (`#blueprint/<project>|dropped|<team>`, from the card's Dropped row): the retired items under an overline
  per section they come from ("REQUIREMENTS · 3"), a section only when it has some. Each row opens the item; **Archive**
  sits beside it (never inside it), for the admin only. Keeping an item needs nothing: it stays here. **Archive** opens a sheet that names what goes with it
  ("R4/AC1, R4/AC2 under it go with it, and come back with it") or what must be settled first ("R4/AC3 is still
  open: drop it or move it first", and the button is disabled), then archives. A finding, risk or term under
  it has no dropped status, so it goes with it. **Unarchive** brings back what went with it ("R4 and R4/AC1, R4/AC2
  come back to the lists, as they were"); a child whose parent is still archived says so and is brought back with the
  parent. An archived item leaves every list, count and search; it still opens by its key, with an **Archived** pill
  and **Unarchive** in the overflow, and its page lists the children archived with it, its acceptance criteria
  included; the export keeps it, marked.
- **Acceptance counts** leave waived ACs out: "2 of 3 ACs passing" counts the others. A requirement whose ACs are all
  waived says "2 ACs waived" on its row and "· 2 waived" on its **Acceptance criteria** card, never "No ACs" or
  "0 of 0 passing"; "No ACs" means it has none.
- **Section titles** for research: **Lines & Hypotheses** (2) and **Papers & Planning** (4).
- **Proposals**: each open proposal as a card with the agent, team, age, base version, its reason (L2, shown as
  "Reason given"), and its changes as a diff against the current items (a title struck through and the new one, a
  status change, a new item, a link); **Reject** (a sheet with a note for the agent) and **Apply**. A stale result is
  said in the toast.
- **Start over** (overflow, desktop and tablet; [blueprint](blueprint.md) §4.1): a sheet picks the whole project or
  one team's part, the kinds to reset (requirements, NFRs, criteria, milestones, releases, risks and glossary terms
  ticked; issues, hypotheses and questions offered) and an optional note for the coordinator; it says what is kept and
  that a snapshot is saved first. A refusal (another re-plan open) shows in the toast.
- **An open re-plan** shows as a card above every tab, with an amber edge: "Starting over · Integration's part", the
  items it holds and their kinds, its age, "1 added · 6 changed · 1 removed", the operator's note, and a pill
  (Coordinator rebuilding, Docs import, or Waits for your review). Its actions: **Snapshot** (the saved export),
  **Cancel re-plan** (a sheet: everything returns to the snapshot, items it added are removed, a pending submission is
  withdrawn; **Restore snapshot**), and **Review** (to Proposals) or, with nothing submitted, **File the review**.
  The card and its actions work on the phone.
- **A start-over submission** in Proposals is one card: "Start over of Integration's part · Saoirse", its reason, then
  **Added**, **Changed** (the old title struck through and the new one, the old status and the new one, or what else
  changed), **Removed** and **Links**, each with its count, and how many items are unchanged; **Send back** (a note
  for the coordinator; the re-plan stays open) and **Apply re-plan** (draft requirements become agreed).

An **item** (`#bp/<project>|<key>`; Back returns to the Blueprint screen it was opened from, with its team filter, or to its section when it was opened by a link; from the item, the section's crumb and Back to it open the section scrolled to the item's row) has the item on the left and Links, Tasks, History on
the right (stacked on phones). It answers "what is it, in plain words, and what do its codes mean"
([blueprint](blueprint.md) §2.7): a claim or hypothesis first shows the hub's standing line ("3 of 5 claims
supported. C4 has only undecided evidence; C5 has none."), then the summary, then **Sources** (a vault file opens in the
vault viewer, a file found elsewhere than cited says **Found at** and the path, a missing one says "Not in the vault"),
then the **Records** folded. Codes in the title, summary and given/when/then are marked: a defined one shows its term, an
undefined one says it is not in the glossary. Agent ids read as the agent's name. **Blueprint rows: title first; the key
leads the muted second line** ("Evidence accuracy is at least 95%" over "H-L2-02 · Hypothesis · studies"; a claim row
"CLM-3 · R2 Field model … · Draft"). The second line ends in an ellipsis and the row's tooltip holds the full text, so
the row's name reads the title first. One-line rows (Inside on a sheet, the submit sheet), headings, search and places that
show only a key keep the key first; a defined code inside a title stays marked. A **Check · n** pill in the head lists
what does not read plainly yet ("Title codes: P25, P26", "Acceptance says nothing to check"). An empty summary says "No
summary written"; an empty criterion "No given, when or then written". An FR shows its stories and its ACs as Given / When / Then blocks with status pills and
evidence; tasks that name the item show their status, and a blocked one has **Unblock**. The actions an item offers
are the ones the hub lists for this viewer (`actions`, [blueprint](blueprint.md) §6.1), never a copy of the rules in
the console. A **risk** shows likelihood, impact and owner in one muted line under its title, then the summary; its
Records are open when they are short (600 characters or fewer) and folded under the **Records** control otherwise. A
**milestone** starts with its title and description, then target, phase and exit; a **Progress** bar ("1 of 3 tasks
done") shows only when eligible tasks the viewer may see name it. A **paper** reads as an argument, in this order:
1. the **top card**. On the left: the title, one muted line with its venue, type, status, team and deadline, then two labelled lines. **Manuscript** is the file name, which opens the vault viewer (Back returns to the paper) with the full path in its tooltip; a manuscript this viewer cannot read shows "Not available to you" and no path. **Delivers** lists the milestones that deliver the paper, each a link to the milestone, joined by " · ": a milestone's short name (up to 24 characters, set with `bp_write`), or its title cut off with "…" when it has none, with the full title in the tooltip. Authors, when set, follow as a third line. On the right, behind a hairline, **readiness** in its own block: the **Ready** or **Not ready** tag, "n of m" large, "claims supported", and a strip with one segment per
   kept claim (supported, weak, unsupported or contradicted). The strip is one graphic with one label under it ("2 supported,
   1 weak, 3 unsupported, 1 contradicted"): no tooltip per segment, nothing to focus per segment. **Holding it back** lists
   at most 5 claims, worst first (contradicted, unsupported, weak), then "and n more in Claims by part", which scrolls to
   the outline;
3. **Claims by part**, its own card, always open: the claims as an outline by part of the paper (Introduction, Method,
   Results, Discussion, Unplaced), each claim once: the wording, then its key and the first piece of evidence in the muted
   line ("C3 · H-L2-02 Accuracy is at least 95% · Refuted", "No evidence yet"), its support pill and an arrow to the claim;
4. **Summary**: the framing, with the hub's standing line under it;
5. **Sources**: as on any item;
6. **Records**: open when 600 characters or fewer, folded otherwise; last on the page (under the left column on desktop, after the right column's cards on phones).

The Paper screen, like every item screen, is shared by both consoles: a collaborator opens it as a read-only page (`#m/p/<id>/item/<key>`, [multi-user](multi-user.md) §7) without the app bar's actions, the overflow, History, Next or the Check pill.

On the right, a **Studies** card (there is no separate Paper card: its Manuscript and milestones moved into the top card) with the hypotheses it studies (they leave the Links card), then Links, Tasks and
History. On phones the right column stacks under the left, and under 720 px the readiness block moves below the title inside the top card, so readiness stays first. The app bar has one action, while planned or drafting: **Mark submitted** (advisory; its sheet
lists the claims not supported and the button reads **Submit anyway**); **Export outline** is in the overflow. A
**claim** is a verdict and the evidence behind it: the statement as the heading, its paper, part and wording status
in a muted line, then a card with the support pill and the reason in words ("2 pieces of decided evidence",
"Contradicted by R9/AC1", "Its evidence is not decided yet", "No evidence yet", "Cut from the paper") and the evidence
as rows that open the item (a criterion under its requirement is indented once, and shown once); **Add evidence** is
in the app bar and **Cut claim** (a confirm sheet) in the overflow. Back from an item
returns to the screen it was opened from, named: from a claim to its paper, from a paper opened on the team page to the
team page. A confirmed hypothesis, a medium or
high finding and a verified FR or NFR offer **Add as claim** (paper, part, wording prefilled; a draft claim with its
`evidence` link). A **decision** shows context, options with the chosen one marked, decision, consequences, and on
the right when, by whom, the source ("via question dec_…" opens it), governs and supersedes. A **report** shows health,
escalation, Done / Next / Blockers, the hub's facts in a muted line and the request it answers. Home lists a
contradicted **paper claim** as an urgent item ("Paper claim contradicted", opening the paper); "note claim" stays the
knowledge graph's word, so one word never means two things. Blueprint proposals and escalations arrive as alerts, and each open proposal routed to the operator is also a row in that team's
Needs you: its reason as the title, "Blueprint change · <reason> · 2 h ago", with **Open** (to Proposals), **Apply** and **Reject**. A submitted
start over shows **Review** (to Proposals, where its diff is) instead of Apply, since applying it replaces the team's part.
On desktop the board's Done column shows the newest eight; **Show all 18** shows the rest and **Hide all** hides
every done task still on the board in one call (it confirms with the count, "Hide 18 done tasks?", and the toast
offers **Undo**). Hidden tasks stay in the hub and in agents' task lists; **18 hidden** shows them again. On phones
the Done list has the same **Hide all 18** row. A screen inside a team (a task, the tasks, members, settings, status
and decisions) shows its trail from Home ("‹ Home › GESTAMP › Tasks") and Back follows [Where am I](#where-am-i).

A team is a focused screen: the team page and every screen inside it show no Work tab bar (Home, Topology,
Sessions, Chats, Feedback, Directives), however they were opened; the trail's root, Home, says where you are. The
team's parent is Home: Back returns to Home with the operator's list filters, or to the agent it was opened from (‹
then names that agent); a reload or a link of `#team/<id>` goes back to Home. The **Team** card is the team's hub, rows with an icon, a count and a chevron:
- **Members** ("4 members · 2 live · 1 stalled", `#members/<id>`): the members list, then **Connections**, the
  connections graph scoped to the team: its agents, their team hubs, direct messages, group chats and links, with
  outside agents they talk to faded. It keeps the graph's focus (rest on an agent or Tab to it; click to pin; Esc
  unpins) and its activity feed or, on phones, the team's most active agents. **Open in Topology** opens the same
  scope in Work → Topology (`#topology/team:<id>`), with the time window and layers.
- **Directives** ("22 directives · 17 not read · 8 hub-wide (2 exempt)", or "2 hub-wide kept off" when none is in force, `#tdirs/<id>|team|members|hub`): only
  what applies to the team, in one `.tabs` bar of three tabs with counts, the tab in the hash (default **This
  team**), every tab the same row and section. **This team**: team, role and project rules, with an overline per
  kind when more than one is present; the meta is the rule's reach (`reach_label`). **Members**: an overline per
  member; a member's rule that repeats a team, role or hub rule (`copy_of`) has the pill "Same as team rule" (role,
  hub) and the meta 'Copy of "<title>"', and **Fold n copies** (admins only) retires them after one confirm sheet (the wider rule
  stays; each agent is told once); empty, "No member-only rules". **Hub-wide**: rules in force, each with **Not for
  this team** (admins only; a sheet with an optional note; on phones in the row's ⋯ menu), then **Not for this team · n**, the
  rules kept off the team (`exempt_here`), muted, with **Apply again** (admins only; this team's own exemption lifts at once;
  a project, agent or other-team one asks first and names the wider target); a footer line says hub-wide rules
  reach every agent unless kept off. Other teams' directives that reach a member who is also in that team are left
  out. A row opens the directive, whose Back returns to the team's list on the same tab; **All directives** opens
  Work → Directives. The counts (`count`, `behind`, `hub`, `hub_exempt`, `copies`) count only rules in force, and
  the main count leaves hub-wide directives out. The trail reads "Home › <team> › Directives".
- **Chats** (`#tchats/<id>`): the team room, then direct chats between members, newest first; each opens the chat.
  The operator has no two-way chat with an agent (Message on a member sends a one-way notice), so every direct chat
  shown there is one agents started.
- **Sessions** (`#tses/<id>`): the members' sessions, live first; each opens the agent.
- **Settings**: how the team works. **Review** (Required · Per task · None) is the review policy of the team's
  project, so it applies to every team of that project; its info button says what each choice does and that
  nobody reviews their own work. **New tasks** (Backlog · Open), right under it, is the project's task intake, set
  the same way (`PATCH /api/projects/:id {task_intake}`): Backlog (the default) holds what agents create for the
  operator; Open opens it at once. The TEAM card's Settings line says "New tasks to backlog"
  or "New tasks open at once". Above them, **Team** has **Name** (Rename, 1-80 characters, not another team's name; the new name shows
  everywhere, each member gets a notice, and files on their PCs keep the old name until the next setup), **Project** and **Part** (one sheet: move the team to another project and tick the top-level
  Blueprint parts it owns; a part owned by another team says whose it is), and **Keywords** (the team's own, then
  "from the project: …"; Change opens a checkbox per known keyword, a keyword the project already has marked "also from
  the project", since the team matches its project's keywords whatever it ticks). **Who decides** lists the deciders,
  only members with a grant on the project can be ticked, a decider who cannot decide now shows a warning, and
  nobody ticked shows "You decide". **Deciders may approve** is the ceiling: file actions, folders and hours; it
  is sent only when edited, and **Reset to default** returns it to the default (the sheet says when it already is).
- On **Members**, **Add member** (header; phone overflow) picks an agent with a session key, its role and, when it
  has more than one, the key; any warnings the hub returns (members who may stall in a Chat app) open in a sheet.
  Each member row's overflow has **Remove from team**, with a confirm step.
- A member row's trail is the **Stalled** pill when it applies, **Copy handoff** (desktop only), **Message** and More,
  on one right edge. **Message** (admins only, every width; also the first item of the row's More menu) opens the
  **Tell the agent** sheet, the same form as the agent page's card: it opens on **Message**, a one-off notice
  (`POST /api/agents/:id/notices`), says the 4,000-character limit and that the notice arrives with the agent's next hub
  call and is confirmed with `session_ack`; switching to **Directive** shows "Keep as a standing directive for this
  agent", ticked, which saves a directive scoped to that agent instead (`POST /api/directives`). The notice shows on the
  agent page's Tell the agent list as Pending until the agent confirms it. A member (non-admin) user sees no Message,
  and the hub answers 403 `admin_only`.
- **Team status** has **Ask for plan update** next to the status request; it sends the optional note too.

### Projects, agents and a team's history

| Operator question | Where to answer it |
|---|---|
| Which projects are there, and how do I add or close one? | **Projects** in the header of Home's Teams card opens `#projects`: projects grouped Active, Paused, Closed. **New project** creates a standalone one; a row edits its name, kind, status, **Single team** (off allows several teams; on with several attached explains the conflict and changes nothing), **Ecosystem** (the project it sits under, one level deep) and keywords (a checkbox per known keyword; New project ticks Research & Development); a change of kind on a populated project shows what it changes and keeps before the save, and closing asks once more ([Blueprint](blueprint.md) §9). Each row's line lists its keywords. |
| Which keywords can projects and teams have? | The **Keywords** card on Projects (also in the overflow menu of Home's Teams card): each known keyword with how many projects and teams have it. **Edit** adds, reorders and removes them (1 to 40 characters, not "All", at most 20); removing one in use says what it comes off before the save, and the save takes it off every project and team. The list starts as Research & Development and Applications; the Teams keyword select shows them in this order. |
| What are the Blueprint limits? | The **Blueprint limits** card on Projects: each value, and its default when changed. **Edit** shows default and maximum per limit, a Reset per limit and Reset all to defaults. |
| How do I rename an agent or move it to another project? | The agent page's overflow: **Rename** (the name). An agent is in the projects of its teams: add it to a team, or move its team, to change them ([Project reach](directives.md#project-reach)). |
| What did this team's coordinator ask for, and what start-overs did its project have? | The TEAM card's **Recruits and start-overs** row opens `#thist/<team>`: recruit requests filtered All, Waiting, Approved, Denied, and the project's re-plans. A closed or cancelled re-plan opens `#replan/<id>` with its diff against the snapshot. |
| Which tracker story or pull request does this Blueprint item mirror? | The chips after the item's meta line ("tracker 90048"). A chip whose system has a URL template in Project settings opens the record in a new tab; the others are plain text. |
| What did a Blueprint item look like before its last ten changes? | The item's History: **Show older revisions** pages back. |

### Backlog

The backlog answers: what did agents propose, and do I want it done? With the project's intake at **Backlog**, a task an
agent creates waits there; agents can read and edit it but nobody can assign, claim or start it. Only the operator moves it.

- **Project settings → Tags** (admin only; a team's settings, "Task tags" row with **Edit tags**). A sheet with up to 7 name fields (add, remove); the word links and filters use is the lowercase name. Each old tag in use that is not in the new list gets a map select (leave unmapped, or a list tag). **Show what changes** previews: the tags dropped, the tasks that lose a tag and the tasks left with none; only then **Save the list** runs the map. An empty list goes back to free tags (at most 2 per task, 7 in use). A project already over 7 tags without a list shows "More than 7 tags: set a list" in the row and the sheet. An eighth entry is refused: "A project has at most 7 tags. To classify differently, change the list and retag the tasks."
- **Home's Backlog card tag row.** One row: **All** plus at most 7 tags with counts, by display name ("Platform", not "#platform"); a picked tag outside them takes the last of the 7 places, and **All backlog** has the rest; in chips with the 3 px chip corners (`--r-chip`), not the button corners. The Backlog screen's Filters sheet has a **Tag** select over the same list.
- **Tags.** The agent that creates a task files it under 1 or 2 tags (from the project's list where it has one, see Project settings → Tags below). A task row (not a backlog card) shows up to three as `.tag` chips in its
  trailing area from 768 px ("+n" for the rest, named in its `title`); on phones "#docs #ux" leads the meta line. Over
  Home's Backlog card, the tag row (**All** plus at most 7 tags, see Home's Backlog card tag row) narrows the list to one tag; on Work → Backlog and a team's
  task list the tag is a chip in the search box (by display name), picked in **Filters**. Work → Backlog keeps it in the
  route (`#backlog/t=docs`), a team's list too (`#tasks/<team>|<status>|docs`), and Home's card hands it to **All
  backlog**. The header then says "2 of 5 waiting", and an empty result says "Nothing tagged #docs"; these, the breadcrumbs and the Tasks header name the tag by its display name where the project list has one. The task screen's
  People section has a **Tags** row: each tag opens the team's tasks with that tag, and the operator's **Edit** (**Add**
  while there are none) opens a sheet with one comma-separated field; saving is audited and works on a task in any status.
- **Rows.** A backlog task is a card: its row (title; the team and its plan refs) with **Postpone**, **Discard** and
  **Accept** (`ok`) at its top right, and its **In short** under it. There is no "Proposed by" line, no bottom action row
  and no tag chips on the card (who proposed it and when stay on the task page; the tags stay as the filter chips above the
  list). In short is
  plain text (the coordinator's `short_summary`, else the hub's cut of the brief, `short_summary_hub`), never Markdown:
  the whole of it shows when it fits in four rendered lines, and otherwise it is cut at four lines with **Show all**
  (`aria-expanded`), which opens it in place; the task screen always has the full text and the brief, rendered as
  Markdown. On a postponed task the meta line starts "Postponed 3d ago" and the first button is **Return to active**. On
  phones the buttons wrap under the title, full width and equal, in the same order. The row opens the task. Agent text is
  escaped everywhere.
- **Postponed.** **Postpone** keeps a task in the backlog for later: one click in lists (**Return to active** undoes it,
  also one click), audited (`task.postpone`, `task.restore`), no notice to the team, and it raises the task's version.
  A postponed task still cannot be assigned, claimed or started. It leaves Home's Backlog card, Needs you and the
  "waiting" counts; Work → Backlog shows it under **Postponed**. Accept and Discard work from either list; accepting or
  discarding clears the postponement, and a task sent **Back to backlog** starts active.
- **Accept** is one click in lists (backlog → open; the coordinators and the proposer are told). The task screen's
  **Accept** opens a sheet with an optional note for the team. **Discard** always opens a sheet with an optional "Why";
  the task becomes **discarded**, closed and kept for history. **Back to backlog** (open → backlog, only while nobody
  holds it) is a header button on the task screen and an item in the phone overflow, with an optional note. Every move
  is audited (`task.accept`, `task.discard`, `task.demote`).
- **Where it shows.** Home's Backlog card (active tasks only); **Work → Backlog** (`#backlog`, Back to Home), grouped by
  team, oldest first, each group with **Team tasks**; each active task (not a postponed one) is also a row in the team's
  and Home's Needs you, with **Accept** and **Discard**. Work → Backlog has one toolbar row ([Search field with
  chips](design-guidelines.md)): the search box, with the team, the project and the tag as chips before the text, then the
  segmented control **Active n** · **Postponed n**, then **Filters**, a sheet with the **Team**, **Project** and **Tag**
  selects (each tag with its count). The search matches words in a task's title or brief as typed. The box's ✕, **Clear
  search and filters**, goes back to the default (the same list, no filter, no search); a default is never a chip. The
  list, the search, the team, the project and the tag combine before the server pages and counts, so each count names
  exactly the tasks its list shows, and all are in the route (`#backlog/l=postponed&p=<project>&t=docs&q=relay`, the
  search encoded), so Back restores them. A team filter (`team=<team>`, `?team=`) comes from the team page's **Backlog ·
  n** and is a chip like the others. The list's overline reads "WAITING · 50 of 112 · Oldest first" ("POSTPONED · …" under
  Postponed): the count is the one live region and the backlog has one order. The list shows the oldest 50; **Show more**
  loads the next 50 and the count follows. An empty result says what is filtered ("No backlog task matches these
  filters") with **Clear search and filters**. Data: `GET /api/tasks/backlog?list=&project=&team=&tag=&q=&limit=&cursor=`
  (`total`, `active_total`, `postponed_total`, `all_total`, `next_cursor`, the `tags` and `projects` counts).
- **A team's tasks** (`#tasks/<team>|backlog`) have a **Backlog** tab first and a **Discarded** tab last (the discarded
  filter); neither is a board column, so the desktop board header carries **Backlog n** and **Discarded n** buttons and
  the phone task index adds the two rows. Progress leaves both out. Over the status tabs sits one toolbar row (the shared
  [search field with chips](design-guidelines.md)): the search box, with the tag as a chip ("#docs"), then **Filters**,
  which holds **Tag** (each with its count over all the team's tasks). The search reads each task's title and brief, every
  word, across the whole loaded board: a done task past the Done list's newest eight and a task hidden from the board are
  found too, and while a search runs the Done tab shows every match. The status tabs stay a row of their own under the
  toolbar (a tab is not a filter) and count what the search and tag leave. The ✕, **Clear search and filters**, clears the
  text and the tag and keeps the tab; an empty result says "No task matches this search" with the same action. The route
  keeps the search after the tag, encoded: `#tasks/<team>|<status>|<tag>|<search>`.
- **Relayed requests.** A coordinator who relays the operator's own request (`operator_request {source}`) opens the task
  at once. The task stores it as relayed (L1): its row's meta says "on your relayed request", and the task screen's People
  section starts with "Opened on your relayed request · Relayed by <coordinator> from <source>, <date>" (the relayed-answer
  wording of decisions). The operator may send it back with **Back to backlog**: for 7 days, while nobody holds it, it
  is also listed under **Opened on your relayed request** on Home's Backlog card and at the end of Work → Backlog
  (`relayed` in `GET /api/tasks/backlog`), so a relay never skips the backlog unseen. Relayed tasks keep this group
  under both Active and Postponed (they are open, never postponed); the project and tag filters narrow it too.
- **Task screen.** A backlog task shows the action line on top ("In the backlog · Proposed by …", or "Postponed 3d ago ·
  Proposed by …", with **Postpone** or **Return to active** beside Discard and Accept; on `--panel-2` on
  desktop, a card of its own on phones) and the lifecycle with
  no step reached, labelled **Backlog**; a discarded one shows a note with the date and the operator's note, and the
  lifecycle greyed, labelled **Discarded**. The timeline names the moves (Accepted by the operator, Discarded by the
  operator, Back to the backlog), and so does Work in motion ("Proposed, in the backlog", "Opened on your relayed request").

A **waiting review** answers: who has it, since when, and have they seen it? A task in review shows, on its board
card's meta line and in the task screen's last review round, the submitted version, the reviewer, how long it has
waited and the turn's seen state: "v3 · Code Reviewer 2 · waiting 2 h · not seen yet", or "· seen 40 min ago". The
reviewer's turn counts as seen only when the reviewer read that task in full or acted on it
([task turns](specification.md#task-turns-and-deadlines)); a list fetch or another call does not count. While the
reviewer has not seen it, the round adds the hand-off text the hub gave the submitter: "Code Reviewer 2 only sees this
when woken. Tell its session:" with the copyable `review <task id>`. Until the connector reports delivery, "not seen
yet" reads "not delivered yet". Under the task's progress a delivery line names the holder and where delivery stands:
Delivered (hh:mm); Waiting behind task X while the agent's woken run works on another task; Not delivered: PC offline
since hh:mm (the time of its last check-in, in the viewer's clock; a PC is never called asleep); Not delivered: waiting for
the PC, chat in use, waking off for the agent on its PC or no folder for the agent on it, as the connector reported; or Not delivered yet, with **Reassign**
for the operator while the task is assigned, changes requested or in progress. Needs you lists such an item once the
team's pickup time has passed (**Not delivered yet**) and started work past its check-in time (**Past its check-in
time**), each with Reassign and Open task; nothing returns to open by itself. An answered question says when the answer
reached the asker: "· Reached <agent> at hh:mm". Seen, started and reviewed
stay apart: Started is the lifecycle step, reviewed is the verdict in the round. Data: `turn` on each task of
`GET /api/teams/:id` and on `GET /api/teams/:id/tasks/:taskId`.

A **task** page shows who reviews it under People: the reviewer, or **No review** ("Review · project policy" or
"Review · set for this task") when the task needs none. Until the task is approved, a **Review** row shows
**Required** or **None** with a button that switches it (**No review** only where the policy is not Required, or
**Ask for review**); the sheet asks for a reason, kept in the audit trail, and keeps itself open with an inline
error when the reason is empty. A task with no review shows "Submitted, no review" and "Done, no review" in its
timeline and in Work in motion. Each review on a task page (the reviewer's verdict and note) sits in a quiet box: a 1 px `--line` border, an almost transparent background, rounded corners and inner padding, with no coloured bar down its side. Only the status label keeps its colour (**Approved** green, **Changes requested** amber), so the box reads the same in light and dark.

**Topology**, **Sessions**, **Chats**, **Feedback** and **Directives** are focused views within Work, after Home. Chats
can be filtered to direct conversations or group conversations, including team
rooms.

| Operator question | Where to answer it |
|---|---|
| Who is connected? | **Topology** shows live connections with device and app names and marks offline agents. **Sessions** shows the login details. |
| Who is working, and with whom? | **Topology** shows team membership. Open a team to see assigned work and progress. Membership and connection alone do not indicate active work. |
| What are they doing or discussing? | Open **Chats** for direct and group conversations, or open an agent's chats from their panel. Team boards show tracked work and its status. An admin also sees, under each message of a conversation, where it stands for the agents that receive it: **Not delivered yet**, **Delivered**, **Shown to the session (reported by the PC)** or **Read**. A direct chat names one state; a group counts them ("1 read · 1 shown (reported by the PC) · 1 not delivered yet"). A PC that has not reported shows no Shown at all, and the marks refresh with the room. Members do not see them. |
| How is this agent configured? | Open the agent to see its role and instructions, connections, session keys, and links. Open a key to inspect its grants. |
| How do I define how agents collaborate? | Open a team from Home's **Teams** card to choose members and roles and organize their work. Use **Links** in an agent's panel to define peer relationships and whether the link grants messaging. |

### Agent page

The **agent page** (`#ses/<agent>|overview`, under Sessions; tabs Overview, Keys, Teams, Chats, Links, Activity)
answers "who is this agent, what does it follow, and is it live?". Its overview is declared as data (`AG_CARDS`), one
card style throughout, each card with the same header:
- **Desktop** (from 1180 px), two columns. Column 1 is who the agent is: **Role** (the role you set and the agent's
  own words), **Team playbooks**, **Directives** (what reaches it and whether it confirmed the current version).
  Column 2 is talking to it: **Tell the agent**, **Inbox**, then **Status** (state, connected, last active, last call,
  logins, team, project, model).
- **Agent status.** **Connected** is the time of the agent's first call after signing in, or **Not connected yet**;
  **Last active** is its latest call. Both come from the hub's own records (`agents.connected_at`,
  `agents.last_active_at`), and sign-in calls on their own (`session_login`, `session_whoami`, such as the connector's
  sign-in check) never set them, so a sign-in check does not show an agent that never started as connected. Member rows and session cards show Last
  active the same way, and a PC's agent list leaves out agents that only signed in.
- **One column** (below 1180 px): **Status**, **Tell the agent**, **Inbox**, **Role**, **Team playbooks**,
  **Directives**. On a small screen the first question is whether the agent is live; the action follows. Each card is
  in the page once, and the page is drawn in the order it shows, so Tab and a screen reader follow the cards as seen.
  Crossing 1180 px moves the cards without reloading the page or losing focus.
- **Tell the agent** is the compose action, the same form as a team's Members **Message** sheet: Directive (kept as a
  standing directive for this agent by default) or Message (a one-off notice). The hub takes notices from admins only
  (403 `admin_only` otherwise). What it sends shows in the Inbox.
- **Inbox** answers "what did this agent get told, and has it confirmed it?". It lists the notices the hub delivers to
  the agent (its 50 newest), newest first: what you sent with Tell the agent and the hub's own notices (task, review,
  team, link and access changes). Each shows the sender, the subject (the kind of notice, such as Message, Directive or
  Review requested), the time, the text, and the acknowledgement state. The sender of a Message or Directive is the
  admin who sent it, read from that send's audit entry (`agent.notice`, which records the notice's `seq`): **You** when
  it is the viewer, else that admin's name, and **Operator** for a notice sent before the hub recorded it. Every other
  notice is from **Hub**. The state is **No longer needed** when the hub settled the notice before delivery (a review
  cancelled, a task that moved on), so it never reached the agent, even if the agent later confirmed newer notices;
  otherwise **Pending** until a login of the agent confirms it with `session_ack`, then **Confirmed**. The header counts
  the pending ones. The first 6 show; **Show all n** (a button with `aria-expanded`) shows the rest. With none: "No
  notices yet". **Activity** keeps describing what the agent did (files and calls).
- **No side effects.** Opening the agent page, or any card on it, only reads: it never confirms a notice for the agent.
  Only the agent's own `session_ack` does.
- **Team playbooks** shows each team role's complete playbook, rendered as Markdown. A short one (up to about ten lines)
  shows in full. A longer one shows its start and a **Show the full playbook** button (`aria-expanded`, keyboard
  reachable, focus stays on it); expanded, the whole text shows down to its final paragraph, and **Show less** folds it
  again.
- **Back** follows [Where am I](#where-am-i): opened from a team's Members, the context bar starts with "‹ Members"
  then "Sessions › <agent>", and Back returns to that list; opened from a link, Back goes to Sessions.

#### Delegate an agent

**Delegate** is an action in the agent page's menu for the administrator only. It lends this one agent to a member as a **contributor**: the agent keeps its identity, team, tasks and history, and works for the member on a PC of the administrator's, away from "ready" until it resumes. The design is in docs/specification.md (delegation); this section is what the console shows.

- **The sheet** (the 560 px dialog; a full-width sheet on a phone), in this order. **Member**: a select of the active members. **PC**: **Already set up** (a select of the administrator's own PCs), or **PC not added yet**, which says to add the PC with the connector first (Add PC) and approve a destination on it. The member never owns or sees a PC. **Run with**: provider, model and permissions; permissions can be lowered, never raised above the agent's own. **What the agent loses while delegated**: a short list (for example "projects the member cannot see"). The member's project access is a ceiling on the agent; the sheet is refused if the agent would keep no project. A note says repository access is the member's PC's to provide. **Drafts folder**: **None** by default; the administrator may pick a folder (in a research project the paper's contributions folder, in an implementation project any folder offered, or none). Picking one is an explicit, audited folder grant for the member that ends at Take back; it never widens what the member already has. One primary action: **Delegate**.
- **Status only.** After Delegate the sheet shows the step ("Saving work…", "Waiting for Lena Ortiz to run the prompt", "Restored on lena-laptop") and **Cancel delegation**. It never shows the prompt: the prompt is in the member's own console.
- **The member's Home** shows a card **Run <agent> for <administrator>** behind their sign-in (and 2FA). **Show the prompt** makes it; the prompt is shown in a code box with **Copy**, held in the page only,. While it runs the card says so, and after a take-back it reads "<administrator> took <agent> back".
- **Via the member.** While delegated, what the agent writes and proposes shows "· via <member>" wherever the console names who wrote it (the Blueprint proposals, the work feed), so the operator can tell the member's session from the agent's own.
- **The status line.** The **Status** card shows the same step as a **Delegation** row; once the agent resumes it reads "Running on lena-laptop · delegated to Lena Ortiz". The agent page's title carries a **Contributor** tag while delegated.
- **Take back.** While delegated the menu offers **Take back**. It confirms: "The copy on Lena Ortiz's PC stops working at once. Work that is not merged or pushed is not recovered." Afterwards **Run on my PC** issues the agent on the administrator's PC.
- **Refusals** show in the sheet in plain words: the agent is in a team checkout, already delegated, the member has no active key. Only the administrator sees the action.
- **Phone (390 px).** The sheet is full width with the two PC choices stacked; the member's prompt box scrolls inside itself, and **Copy**, **Yes** and **No** are full-width touch targets.

### Feedback

**Work → Feedback** lists what agents reported about the hub. It opens on **New**, sorted by impact (backers, then severity, then last seen); the toolbar is one row (two on a phone), the shared [search field with chips](design-guidelines.md): the search box (title, tool, error code) with the active filters as chips (kind, tool or area, team, "From <agent>", "Assigned to <agent>", Linked or Not linked), then **New · Open · Closed**, then **Filters**, which holds every picker (kind, tool or area, team, agent, assigned to, linked tasks). The ✕, **Clear search and filters**, clears the text and every filter and keeps the bucket, the grouping and the sort. The list overline reads "**12** of 40 · Not grouped ▾ · Most impact first ▾": the live count of the bucket, then Group by (Not grouped, Grouped by tool or area) and Sort (Most impact first, Last seen first) as inline selects. The Work button shows a badge while any report is `new`. A blocking report in `new` that three or more agents backed within a day also appears in Home's urgent items. Settings (feedback on or off, agents seeing only their own reports) and export sit beside the list.

| Operator question | Where to answer it |
|---|---|
| What is new and needs a decision? | **New**, in impact order. A row shows the kind glyph, the title, "tool · error · agents · age", and a `Blocking` or `Reopened` pill only when it applies. |
| What hurts agents most? | **Open**, with each report's backers and summed cost estimates; group the list by tool or area. |
| Is this real, and how often? | The report's **Hub evidence** card: the filer's calls to the tool before filing with result, error code and duration, and the calls that failed the same way across all agents in 7 days. Each call opens **Auditing → Calls**. The **Agent's account** card is kept apart and labelled as the agents' own words and estimates. |
| Who is affected? | **Affected** lists the filer and backers with teams, app and client; each name opens the agent panel. |
| What did I decide, and did it reach them? | The status, note and guidance, the history, and "Notified 4 · seen 3" for the latest decision. |
| Did a fix work? | A `still_happening` after a fix moves the report back to **New** with a `Reopened` pill; closed reports show the reopen count. |
| Is someone working on it? | The **Linked tasks** card: each task that fixes the report, with its team and status. The row's meta line says "→ task in review"; the filter sheet shows Linked, Not linked or All. When every linked task is approved and done, an accepted report closes by itself with a `Closed by task` pill; a `new` one shows `Task done` and waits for you. |

A report opens with an impact strip under its title (severity, agents, extra calls and tokens, minutes lost, backers, tool). From 1024 px the queue of the list it came from sits on its left (ordered by impact, newest or most backed), and the report has a main column (guidance, edited in place; the agent's account as a 2×2 grid; one timeline with an Add a note field) and a details column (facts, affected agents, hub evidence). "‹ n of N ›" and `j` / `k` step through the queue. The primary action is a split button following the status: **Accept** for `new`, **Mark fixed** for `accepted`, a Status menu otherwise; its menu holds Ask a question, Won't fix, Reopen as new and Merge into another report. The overflow holds Assign to… (or Reassign and Unassign), Change severity, Edit title, Hide from other agents, Export as Markdown or JSON, and Delete (with a confirm). Under **Assigned to**, the **Linked tasks** card lists the tasks that fix the report (title, team, status, who linked it) with Unlink, and **Link a task…** to add one; a task's screen shows "From feedback: *title*" for each linked report. The details column opens with **Assigned to**: which agent works on the report, since when, whether it has read it ("not read yet" or "read <time>": only the assignee's own `feedback_read` counts, not acknowledging the notice) and with what note, with Assign, Reassign and Unassign. When the assignee is in an on-demand team and has not read it, the card says "This agent only sees it when woken. Tell its session:" with a copyable `read feedback <id>`. The list shows the assignee and the same read state in each row's meta line and the filter sheet filters by it. It answers "who is on this, and have they seen it?" without leaving the report. Empty and zero fields are left out. Report text is agent-written and shown as plain text. See [Feedback](feedback.md#triage-in-the-console) for the details.

### Directives

**Work → Directives** lists the standing rules agents follow ([Directives](directives.md)), **In force** or **Retired**. From 1024 px the list and the selected directive sit side by side: selecting a row (or `j` / `k`) shows it on the right and keeps the list's scroll, filters and ticked rows; the first row is selected when none is. Narrower, a row opens the directive's own screen and Back returns to the list as it was.

A row shows a tick box, the title (with a `New` pill until you review a rule an agent registered), the rule's first line, the scope, and "7/9 read": muted when everyone read the current version, a warn pill when some lag or read an old version, a bad pill when nobody did. A row kept off somewhere reads its reach: on desktop, after the scope chip, the meta starts with the except part ("Except team ECHO Research", `except_label`); on phones with the whole `reach_label` ("All agents except team ECHO Research"); the chip's tooltip and the search read `reach_label`. The directive's screen, and its pane beside the list, name no section the page already makes obvious: under the title and the one meta line (reach, category, version and date, tags) come the text, then **Kept off · n** (it keeps its heading because it carries a count), the agent list and History. The agent list and History start under a thin divider with no uppercase label, and the text carries none. The agent list opens with one toolbar row (two on a phone): the search box (label, id or role) with the active filters as chips (each chosen team, then the state), then **Filters**, which holds **Team** (each with its agents and how many have not confirmed) and the state (All, Confirmed, Out of date, Not confirmed, each with its count under the other filters). The ✕ at the end of the box, **Clear search and filters**, clears the text and every filter; there is no separate Clear filters link. The list overline reads "**4** of 9 agents · 2 not confirmed" (the live region; its tooltip says that agents confirm a version when they read it). A **Kept off · n** section with **Apply again**, and **Keep off…** for admins ([Directives](directives.md#operator-work--directives)). On phones the scope moves into the row's meta line. Filters and the selected directive are in the URL (`#directives/rd=new&g=none&d=dir_…`), so a filtered list can be linked and survives a reload.

| Operator question | Where to answer it |
|---|---|
| What did agents register that I have not reviewed? | Read state **Not reviewed**: rules with a `New` pill, not reviewed first. Tick them and **Mark reviewed**, or open one to keep it, edit or widen it, or merge the same rule from several agents. **Mark all as reviewed** (header, while any wait) asks with the count and keeps them all as they are. |
| Which rules did agents suggest that I have not decided? | **Suggestions from agents**, above the list while one waits, each with the agent and its team: **Adopt** makes it a directive for that team (title and text, prefilled) and closes the same suggestion from its other members, **Retire** tells the agent to stop. Decided reports fold under it. |
| Which rules are agents not following yet? | Read state **Not read by everyone** or **Read an old version**; the pane lists each agent with Read, Out of date or Not read. |
| What applies to this team or project? | Scope filter or the scope groups; search for the team or project name. |
| Which rules are about tokens, or about access? | **Category** in Filters, or **Grouped by category**; tick rows and **Set category** to file the rest. |
| How do I retire several rules at once? | Tick them; the bulk bar's **Retire** asks once, with an optional note the agents see. |

The toolbar is one row (two on a phone: the search box, then the rest), the shared [search field with chips](design-guidelines.md):
the search box (title, text, scope and tags, as you type) with the active filters as chips before the text, in the order
category, scope ("Scope: Team"), read state, tag ("#relay", set from a tag on a directive); then **In force · Retired**, then
**Filters**: **Category** (All, the seven categories and No category, each with its count under the other filters),
**Scope** and **Read state** (not read by everyone, read an old version, read by everyone, not reviewed; in force only).
A default is never a chip. A chip's ✕ removes that filter; the ✕ at the end of the box, **Clear search and filters**,
clears the text and every filter and keeps In force · Retired and the grouping, and so does the empty state's **Clear
search and filters**. Filters change the list in place: the box keeps the text and the focus, and its chips are swapped.
Past two lines the last chips fold into "+k", which opens Filters.

The list overline (the shared list overline) reads "☐ · **6** of 14 · 2 not reviewed · 1 not read by everyone · Grouped
by scope ▾": **Select all shown** (it ticks only the rows the filters show and is not part of the live region), the count
line (the live region), then Group by, an inline select (Grouped by scope, Grouped by category, Not grouped; group headers
fold). The URL keeps `c=`, `t=` and `g=cat`. A row's meta line starts with its category, or "Proposed: …" while an agent's proposal waits for review; the review card has the category preset to the proposal.

Ticking rows shows a bulk bar (count, **Mark reviewed**, **Set category**, **Retire**, clear); a filter change keeps only the ticked rows still shown. Set category files the rows without a new version or a notice to agents.

## Auditing workspace

**Auditing** is a separate menu entry for system-wide logs. It opens **Audit**
by default and also offers **Calls** and **Alerts**. The keyboard shortcut is `L`.

Audit, Calls, Files and Alerts share one toolbar row (two on a phone: the box on the first line), the shared
[search field with chips](design-guidelines.md): the search box with the active filters as chips, the tab's segment
(the actor on Audit, the result on Calls, the change on Files, the status on Alerts), then **Filters** with every picker.
The chips are the category and the From and To dates on Audit; the agent or key and the tool on Calls; who, and a change
kind the segment does not offer, on Files; the severity, and **All states** when the status is not one of the segment's,
on Alerts. A chip's ✕ removes that filter; the box's ✕ clears the text and every chip and keeps the segment. The list
changes in place and the box keeps the text and the focus.

An alert that only waits for a decision closes by itself once the decision is made, so **Alerts** never asks twice:
a Blueprint proposal (`bp_proposal`) once applied, rejected, withdrawn, replaced or stale; a re-plan (`bp_replan`) once
applied or cancelled; an onboarding request (`onboarding_request`) once it is no longer submitted; a team's recruit
requests (`recruit_request`) once none is pending; a task completion waiting for approval (`checkpoint`) once approved
or moved on; a blocked task (`task_blocked`) once unblocked or cancelled; an overdue task (`task_overdue`) once its
assignee gives news or it moves on; an overdue restoring checkout (`checkout_overdue`) once finished or cancelled. The hub
also sweeps these at start, which closes the ones left open before this rule. Alerts about something that happened (a
key in a payload, a login burst) stay until the operator closes them.

## Member console

A member signs in to a shell of their own ([multi-user](multi-user.md) §7), never the admin console.

| Member question | Where to answer it |
|---|---|
| Is anything waiting for me? | **Home** (`#m`) starts with **Needs you**: the questions, access requests, task approvals and unblocks, and Blueprint proposals routed to the member as a team's decider, each with its action. A dot on Home shows while something waits. |
| How is my project going? | A project card on Home and Projects shows Blueprint health, the measure bars and the next milestone. The **project page** (`#m/p/<id>/<tab>`) has tabs that follow the grant: Overview (quick actions, four headline numbers that open their tab, Needs you and For awareness for the project, Next, Progress, and the projects of an ecosystem that the grant shows, never a hidden one), Work with Tasks (tasks or the shared board, roadmap, Activity, Topology), Research when the project has research lines, and Blueprint (the other items, each opens a sheet). One tab left: no tab bar. On phones the tab bar scrolls inside itself; there are no section chips. |
| What are the agents saying? | **Messages** (`#m/msgs`, with a `messages` grant) lists the team rooms by project with a search; a room shows its thread, read-only. |
| What is in the project's notes? | **Vault** (`#m/vault`, with a `vault` grant or a folder grant) browses the granted folders full width and previews files; its **Graph** tab lists the knowledge-graph entities. An empty Vault says whether no folders are shared yet or the shared folder is empty. |
| Who works on my project, and who talks? | The project page's **Topology** section (with a `topology` grant) draws each team: the room in the centre, its agents around it, lines by messages in the last 7 days, and a row per agent with role and count. |
| Can I take a copy? | **Export Markdown** on the project page and **Export** on a room, only when the grant allows exports; each export is audited. |
| How do I answer a question? | The **question page** (`#m/dec/<id>`) is the operator's question screen: the question as the heading, the team, asker and age, the full context, then the options as cards, the recommended one first and marked **Recommended**, each with its own **Choose** button, so one click answers. **Add a note** sends a note with the choice, or alone with **Send as my answer**. **Ask for more** and **Decline** (it goes to the admin) are buttons under the options. The member sees and answers only the questions of the teams they decide for. |
| Where do I start? | Signing in lands on the one place that fits the grants ([multi-user](multi-user.md#7-member-views)): the project when there is one project with one team, Vault when only folders are shared, Home otherwise. A link to a screen always opens that screen. |
| Who am I here, and what can I see? | **Account** (`#m/account`) says **Collaborator** with Colleague or External partner, the organisation and the access end; lists each project and folder grant, and the agents the person owns with the teams and folders each may work in; says that the admin changes access; then two-factor (Set up when off), theme, password and Sign out. It shows no key, credential identifier, PC or secret. |

## Loading and polling

The operator console reads only what the open screen shows ([next-release brief](next-release.md) §4, "Console load").

- **Identity, once.** The console reads who is signed in once at start (`/api/me`), and the operator's own choices (pins, Organize, keyword) at sign-in and when the tab comes back. Neither is polled.
- **Shell, together, every 10 s.** One refresh reads, in a single batch, everything the shell shows on every screen: the attention list and its counts (Needs you and For awareness from `GET /api/needs-you`, which already holds Blueprint attention, checkout steps and vault conflicts, so the shell does not read those lists; alerts, access requests, questions, onboarding, directives to review, feedback, the backlog) and the lists screens look names up in (keys, PCs, agents, sessions, teams, lockdown). The open screen in the background-redraw list redraws in place after it. The next tick comes 10 s after the last refresh ended, so sign-in and an action's own refresh are not followed by a second full read.
- **Home and Topology data, only there.** Activity (`/invocations`), the KPIs (`/metrics`), the fleet (`/topology`) and team links (`/links`) are read by the 10 s refresh only while Home is on screen; on Topology its own 4 s timer reads them. Elsewhere the last copy stays, and returning to Home or Topology reads that screen's data again when its copy is over 10 s old.
- **A screen's own poll stops when it closes.** Work in motion (Home, every 2 s) first asks for its 5 newest changes and pages only when one of them is new. A chat room polls every 3 s while it is open. Topology's 4 s timer reads only the fleet, links, activity and sessions and redraws only the graph. Each checks that its screen is still open before it reads.
- **After an action.** The action's own handler refreshes the shell and reopens its screen, so the result shows at once, without waiting for a tick.
- **Measuring.** `node scripts/console-load-trace.mjs --port <port>` (in `server/`) signs in to the seeded local design-review hub in a headless browser and counts `/api/` requests and bytes for the sign-in and 30 s each of Home, a team, a Blueprint section and Topology. Run it on a freshly seeded hub before and after a change to compare like for like.

## Interaction rules

- Distinguish a live login, bridge heartbeat, active task lease, and recent activity. Each comes from different evidence. A role or team membership does not imply work in progress.
- Use the policy simulator to explain a concrete action and resource. A grant summary, exposure chart, or reachable ancestor is not proof of effective access for a particular login.
- Keep controls and status labels keyboard accessible; show text or icons alongside color. Keep urgent actions usable on mobile and respect reduced-motion preferences.
- Favor short, recognizable labels. Keep evidence, errors, and handoff instructions explicit where an operator needs them to act. See the [console code](../server/public/) for current controls and shortcuts.

## Dashboard signals

Prioritize critical security incidents, then pending access decisions and denial bursts. Keep the actor, scope and available action visible. Exposure estimates vault reach. The access inspector explains a concrete rule decision.

Show team progress from task state and stall signals. Show the time window for activity, and distinguish app and device connections from team links. Preserve keyboard focus and selected context when closing details. Keep topology and activity understandable with reduced motion. See the [console implementation](../server/public/).
