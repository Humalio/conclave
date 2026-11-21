# Multi-user console

Administrators manage the hub. Members sign in to a project-scoped console and can decide for a team when an administrator delegates that authority. [Authorization](authorization.md#terms) defines these roles. Manage accounts and grants in **Security → Users**, and set decision routing and ceilings under **Who decides** in team settings. See the [platform requirements](requirements.md) for the access and delegation contract.

## 1. Model

### 1.1 Roles

| Role | Who | Can |
|---|---|---|
| `admin` | the operator(s) | everything the console does; manages users, grants and deciders; is always the fallback decider |
| `member` | colleagues and external partners (the console says **Collaborator**) | sees only granted projects and components; decides only for teams that name them |

The `admin_users` table has `role` (`admin` or `member`), `display_name`, `external` (0/1), `org` (free text, shown next to the name), `expires_at` (nullable), `totp_required` (0/1), `password_set` (always 1 now: the hub generates the first password; rows from before generated passwords may hold 0 and cannot sign in until the admin resets the password), `expired_at` (set once expiry is enforced), `password_changed_at` (set on create, reset and own change; NULL for older rows) and `created_by`. The console calls these rows **Users**. A member never sees Security, Audit, Settings, PCs, keys, lockdown or directives, and gets no Join button.

Disabling a user or changing their role ends their sessions. The last active admin cannot be disabled or demoted. Whenever an admin gets an expiry, is demoted or is disabled, at least one other active admin who can sign in and has no `expires_at` must remain: admins who all have expiries would end in a lockout.

### 1.2 Project grants and components

`user_project_grants(user_id, project_id, components JSON, vault_folders JSON, may_export 0/1, granted_by, granted_at)`, one row per project. No row means the project does not exist for that user. Admins take no grants.

| Component | Shows | Needs |
|---|---|---|
| `blueprint` | the project's Blueprint (card, Overview, sections, items, papers, reports) | always on in a grant |
| `tasks` | team pages, members (agent labels and roles), tasks and their status, decisions log | |
| `feed` | Work in motion and the team activity rows for the project | |
| `messages` | the project's team rooms and search inside them | |
| `vault` | read-only tree, preview, revisions and diff under the granted folders | at least one folder in `vault_folders`, within the project's `vault_roots` |
| `graph` | knowledge-graph entities whose sources lie in the granted folders | `vault` |
| `topology` | the project's teams and agents, and the edges among them | `tasks` |

A grant stores an explicit component list; presets are only a shortcut in the editor. The editor offers three presets that fill the checkboxes: **Blueprint only** (the default), **Follow the work** (blueprint, tasks, feed) and **Full project** (all seven). The grant is auditable as written, a component added in a later release never widens an existing grant, and an edited preset stays honest because nothing claims it is still "Follow the work".

The same editor holds the grant's **agent delegation** (**Their agents**): the teams and folders where the person's agents may work. It delegates nothing by default and shows the exact permitted operations before save. A project grant's agent folders are Read; a shared folder (§1.2a) has its own **Their agents** part, where Contribute is offered only while the grant is Contribute. See [Authorization: owner enforcement](authorization.md#owner-enforcement).

`PUT /api/users/:id/grants {grants: [{project_id, components?, vault_folders?, may_export?}]}` replaces all of a user's grants and adds the Blueprint component to each. Losing a project's grant removes the user as decider of its teams (audited `team.deciders_set`).

**Members can see the task board.** A project setting, not a component: `projects.member_board` (0/1, off by default). When it is on, every member with a grant on the project (any components, `blueprint` alone included) reads its team task board, read only, through `GET /api/projects/:id/board` and `/board/:taskId`. The admin sets it in team Settings → How it works ("Members can see the task board", for the whole project) or with `PATCH /api/projects/:id {member_board: true|false}`, audited `blueprint.member_board` (`from`, `to`). The board shows the columns Open, Doing, Review, Blocked and Done (the newest 50 done); backlog, discarded, cancelled and hidden done tasks are left out, and so are agent ids: a card has the title, the assignee's label, the status, review rounds, plan refs, the blocked reason and an overdue flag. A task adds its team, description, summary and reviewer label; the detail route opens any task on the board, done ones beyond the 50 the board lists included. An external user never sees the board, even with the switch on (§1.4). Off, an external user, a member without a grant on the project and an unknown project all answer the same `403 board_denied`; a task off the board or of another project answers `404`. Turning it off closes the board at once. Nothing on it writes: accept, unblock and the other task acts keep their own scopes.

Projects have `vault_roots` (folders the admin assigns to the project; an empty list means `/Projects/<name>/`). Vault folders can carry a **restricted** mark (`vault_folder_flags(path, restricted)`, for example `/Restricted/`). A restricted folder is never inside a member grant unless ticked by name (a grant on a folder inside it opens only that folder), and never for an external user; the answer to a grant lists the restricted folders that stay hidden inside a granted folder. The mark is set in the database only.

### 1.2a Folder grants

A person can be granted specific **vault folders** without any project: `user_folder_grants(user_id, path, mode, may_export, delegation JSON, granted_by, granted_at)`, one row per folder. A folder grant gives no project membership: no Blueprint, teams, tasks, rooms or graph. A person may hold project grants and folder grants together. Admins take no folder grants.

- **Read** (the default) shows the folder in Vault: the tree, preview, revisions and diff, as the `vault` component does for a project's folders.
- **Contribute** also lets the person create a note or revise one there (§1.5), through the vault's own revision and conflict checks.
- **Export** (`may_export`, off by default) is the export permission for that folder only.

Each operation is checked against its own target: a write needs a Contribute grant that covers the target, and an export needs a grant covering the target that allows export. A permission on one folder never combines with another folder's write or export permission. A grant may sit inside another (Read on `/Shared/`, Contribute on `/Shared/Drafts/`): **the most specific grant decides**. For a path inside both, the deeper grant's mode and export apply, so Contribute on `/Shared/Drafts/` writes there while `/Shared/` stays Read, and Read (or no export) on an inner folder takes back the outer grant's Contribute (or export) there. The same rule bounds the person's agents (`authorization.md`, delegation), a vault agent's approval and the console's fit check ([onboarding](onboarding.md#a-vault-agent)). Export of a vault file (`GET /api/vault/media`, playback and download) is allowed by a project grant with `may_export` or by the deciding folder grant with export; inside a restricted folder only a grant that names it, or a folder in it, counts.

Folder rules:

- A path is vault-relative and normalised (`/Shared/Papers/`). The vault root and the hub's own folder (`/99 Conclave/`) cannot be granted.
- **Restricted folders** apply to writes as to reads. A restricted folder inside a granted folder stays hidden and unwritable unless it, or a folder inside it, is granted by name. An external user never gets a folder at or inside a restricted folder, and the hub refuses making a user external while they hold one.
- Expiry, two-factor and disabling work as for project grants: a folder grant ends with the person's access.

`GET /api/users/:id/folder-grants`, and `PUT /api/users/:id/folder-grants {grants: [{path, mode?, may_export?, delegation?}]}`, which replaces all of a person's folder grants (admin, audited `user.folder_grant_set` with before and after). The answer lists the restricted folders that stay hidden inside a granted folder. `GET /api/me` and `GET /api/users/:id` carry `folder_grants: [{path, mode, may_export, granted_by, granted_at, delegation}]` next to `grants`. Granting a person folders, like granting a project, creates no key: an agent gets a key only through the admin or an approved onboarding request.

### 1.3 Who decides for a team

`team_deciders(team_id, user_id, added_by, added_at)`, set with `GET` and `PUT /api/teams/:id/deciders {user_ids, ceiling?}` (admin; audited `team.deciders_set`, before and after). An empty list means **the admin decides**. A decider is a member holding a grant on the team's project; admins are refused, because they decide for every team already. One decider is enough for any item: the first answer wins.

An **active** decider is active, set up (`password_set`), enrolled in 2FA when required, not expired, and still granted the project. Only active deciders get items or may act.

| Item | Routed to | Admin fallback |
|---|---|---|
| `team_ask` question (`decisions.team_id`) | the team's active deciders | when the team has no active decider; and after `needed_by`, or 24 h with no answer, as a Home attention item |
| Task checkpoint approval (`/api/teams/:id/tasks/:taskId/approve`), task unblock (`…/unblock`), task dismiss, plan and status requests | the team's deciders | same |
| A task's review (`…/review`, `required` or `none`), only where the project's review policy is `per_task` (the project policy itself stays admin-only) | the team's deciders | same |
| Access request (`access_requests`) | the deciders of the agent's only running team | agent in no team or in several; any request beyond the team's ceiling |
| Blueprint proposal (`bp_proposals`) | the deciders of the team that owns every item it touches | ops touching project-level items, more than one part, or track and paper ownership |
| Operator acts in a team's part (agree an FR or take it back, accept or reject a decision entry, move a paper on from `drafting`, request a report), except on items an open re-plan marks | the team's deciders | project-level items (summary, stakeholders, module and line creation, ownership) stay with the admin |
| Recruits, onboarding requests, team create, start, stop, members and roles | admin only | — |

Admins see every routed item and can act on it at any time. A decider sees only items routed to them, in a **Needs you** list (`GET /api/needs-you`):
- A member gets the open questions, the pending requests inside the ceiling, the tasks waiting for a checkpoint approval or an unblock, and the proposals routed to them, for the teams they decide for.
- The admin gets what routing sent to them: escalated questions, questions of teams whose deciders cannot act, requests no decider may approve (no team, no active decider, or beyond the ceiling), and the open proposals no decider may decide.

- The admin also gets their own queues: the active backlog, submitted onboarding requests, checkout steps waiting on them, directives to review and directive suggestions, new feedback, vault conflicts and unclear requirements.
- An agent's turn never shows: a question waiting for the agent's reply (`needs_info`) or a task in review (review stays with the reviewer).

Routing is computed from the item as it is now, so a change of owner reroutes a proposal.

**One list, filtered entrances.** `GET /api/needs-you` takes `team`, `project`, `review=1` (Blueprint Review: proposals and unclear requirements), `limit` (50, at most 200) and `cursor`. It returns `{items, total, projects, next_cursor, filter, awareness}`. Home, a team, a project and Blueprint Review read the same list. Routing and authorization filter it first; `total` then counts the distinct source decisions, before paging, and `projects` counts them per project the same way, so a project's count is exact past the first page. Each item has `id`, `kind`, `source {kind, id, version}`, `scope {project_id, team_id}`, `title`, `reason`, `open` (the record to open) and `actions` (`id`, `label`, `path`, `input` when the action needs its own screen).

**Acting from the list.** `POST /api/needs-you/act {id, version, action, note?, filter?}` checks that the row still waits for this viewer at the version they saw (reading only that row's own queue), then runs the source workflow's own route as the same user, which checks the decider and the state again. A second tab, or a version that changed, gets `409 conflict`; an action that needs its own screen (answer, clarify, review a start over, choose a conflict version) gets `400 invalid_argument`. The response carries the new `total`, built once after the action and counted for `filter {team?, project?, review?}`, the entrance the action came from, so that entrance's count is the one that comes back. A source reply that is not JSON keeps its status and comes back with a plain message.

**For awareness.** `awareness {items, total}` lists what is worth knowing but asks no decision: stalled members (only in teams with stall warnings on), missed milestones (only in projects with missed milestones on), claims not supported, and, for the admin, keys approved but not collected. Each row names a `record` and its current `episode`, which only moves forward: a claim's episode is its support level and the latest change to the claim or its evidence (adding or removing evidence touches the claim), so a claim that goes weak, unsupported and weak again is a new episode. `POST /api/needs-you/dismiss {record, episode}` hides it for this viewer until a new episode starts; nothing else changes. `PUT /api/teams/:id/attention {stall_warnings}` and `PUT /api/projects/:id/attention {missed_warnings}` (admin, audited) switch the two warnings; both are off by default. With stall warnings off the hub raises no stalled-member alert for that team, closes the open ones (Auditing → Alerts no longer lists them), and the team's member list shows no Stalled flag.

**The ceiling.** A decider approves an access request only inside the team's ceiling, which the admin sets with `PUT …/deciders` (`ceiling: {actions?, folders?, max_hours?}`, `null` for the default). The default is vault actions only (`fs.list`, `fs.read`, `fs.search`, `fs.history`, `fs.create`, `fs.update`), folders within the project's vault roots, never a restricted folder, and at most 168 hours. A request is inside the ceiling when every action is in it, its resource is a vault path under a ceiling folder, its fixed part neither lies in nor contains a restricted folder, and its duration fits. A decider sees (`GET /api/requests`, filtered before the limit) and decides only routed requests inside the ceiling, rechecked at decision time with the grant's actual duration; anything else reads like an unknown request, or is `403 not_decider`. A ceiling never overrides a deny: the policy engine checks the grant like any other.

**Escalation.** The upkeep loop (every 30 s) marks an open question of a team with deciders as escalated once it passes `needed_by`, or 24 h with no answer, audited once (`decision.escalated`). It stays with the deciders and joins the admin's Needs you.

**Who may act.** An active decider of the item's team acts. A member who can see the team but does not decide for it gets `403 not_decider`; any other item answers `404` exactly like an unknown id. Routed acts are the decision answer, confirm, overturn, more-info and decline; task approve, unblock, dismiss (one or many), plan and status requests; and a task's review switch under `per_task`. Answering an unclear requirement's question with Clarify also clears its `unclear` mark; Edit and Drop on that sheet are the admin's. The decision-log setting stays admin-only.

### 1.4 External users

`external = 1` sets defaults the editor shows and the server enforces:
- **2FA required.** 2FA is required when `totp_required` is set, and always for an external user. Until TOTP is enrolled the session reaches only `GET /api/me`, `/api/totp/*` and `POST /api/logout` (`403 totp_required` elsewhere), login and `GET /api/me` answer `setup_needed: true`, and the user is not an active decider. The user enrols in their own view right after the first sign-in (`POST /api/totp/enroll`, then `/confirm`); `setup_needed` now means only this, since every user has a password.
- **One use per TOTP code.** A code accepted at sign-in or at enrolment is refused after that. Wrong codes at `/api/totp/confirm` count against a per-user limit (`429 rate_limited`).
- **Admins.** An admin is never external, and promotion to admin takes the user off every decider list (audited `team.deciders_set`).
- **Expiry optional, suggested.** The editor fills 90 days; the admin may clear it. At `expires_at` login answers `401 expired`, live sessions end on their next call, and the user drops out of every decider list (routing falls back to the admin; audited once as `user.expired`). A maintenance sweep does the same for users nobody is using.
- **Never restricted folders.** The grant editor does not offer them, and the server refuses a project or folder grant or an access-request ceiling that includes one, and refuses making a user external while they hold one.
- **No exports by default.** `may_export` starts off.
- **No task board.** "Members can see the task board" (§1.2) never applies to an external user: the server answers `GET /api/projects/:id/board` and `/board/:taskId` with the same `403 board_denied` as for a project that is not shared, and their project page shows no board. The switch's text in team Settings says so.
- **Generated password.** There is no registration or setup page. The admin creates a user, admin or member, with `POST /api/users {username, display_name?, role?, external?, org?, expires_at?, totp_required?}` (role defaults to member); the hub generates a password (20 characters from `crypto.randomBytes` over letters and digits without look-alikes such as 0/O and 1/l/I, about 116 bits, never containing the username), stores only its hash, sets `password_set` and answers `{user, password}`. The password appears in that answer only: never in the user view, the list or the audit. The admin copies it and hands it over. Audited as `user.create`.
- **Reset.** `POST /api/users/:id/reset-password` (admin) generates a new password the same way, answers `{password}` once, and ends every session of the user, so the old password stops working at once. A disabled user is `409 invalid_state`. Audited as `user.password_reset`.
- **Own password.** `POST /api/me/password {current, new}` (self, any signed-in user who has passed the 2FA gate) checks `current` (wrong: `400 invalid_credentials`; failures count against the sign-in limit, `429 rate_limited` once it trips; a wrong current password and a blocked attempt are each recorded in `authentication_events` as `invalid` / `rate_limited` and audited as `user.password_change_failed` with the reason, never the submitted value), requires `new` to be at least 12 characters and not contain the username, case-insensitive (`400 invalid_argument`), keeps the current session and ends the user's other sessions, and clears the username's sign-in failure count. Audited as `user.password_changed`, with the user as actor. On a `DEMO_MODE` hub the operator named by `ADMIN_USERNAME` is refused with `409 invalid_state` ("On a demo hub the operator's password comes from .env; Replay signs in with it."); other users may change theirs.
- **Rate limits answer 429.** `rate_limited` is `429` on every console route that raises it: sign-in, own password, reset, TOTP confirm, access requests, Blueprint proposals, channels, directives and live key sessions.
- **Narrow identity.** Agent labels and roles are shown; PC names, key ids, credential ids and hostnames are not.

The other user routes are `GET /api/users`, `GET /api/users/:id`, `PATCH /api/users/:id` and `POST /api/users/:id/disable` and `/enable`, all admin. The setup links of earlier versions (`/api/setup/:token`, `POST /api/users/:id/setup-link`) are gone; the `user_setup_links` table stays, unused.

### 1.5 Write rights

Members read; deciders decide. A member has no edit, comment or proposal path of their own, with one exception: **Contribute** on a folder grant (§1.2a). A decider's acts are the routed acts of §1.3: status moves in their team's part, sent through `POST /api/projects/:id/ops` (§4), and the answers, approvals and requests above. Pins (`home.pinned_teams:<user id>`) stay per user and only hold visible teams.

**Creating and editing a note.** A member uses the vault editor's own routes ([vault](vault.md#people-writing-in-the-vault)): `POST /api/vault/files {path, text}` creates a text note and `PUT /api/vault/files {path, text, base_revision}` saves one against the revision the person read. They are open to a member whose folder grant gives Contribute on the path, outside every hidden restricted folder. Where the member only reads, they answer `403 read_only`; a path the member cannot read answers `404` as for a path that is not there, and a new name that matches a hidden file in other capitals is refused without naming it. The vault's own checks apply: a stale `base_revision` is `409 conflict` with the current revision, the vault's size limit and write lock hold, and the revision records the person as its author (a collaborator). Only Markdown and plain-text notes up to 2 MB are edited this way. Uploads, deleting, renaming and restoring stay with the admin. In Vault, a folder the person may write in has **New note**, and a file they may edit has **Edit** on its preview, which opens the editor.

## 2. Scoping

Every route declares a scope in one registry ([scopes.ts](../server/src/admin/scopes.ts); `public`, `self`, `admin`, `filtered` or `decider`, keyed by "METHOD /pattern"). The auth hook looks up the route's pattern: `public` skips the session; an undeclared route is admin-only (**fail closed**), so a new route is admin-only until someone scopes it. A member reaches `public` and `self` routes, and the `filtered` and `decider` routes the registry opens to members (`MEMBER_READY`); elsewhere they get `403 admin_only`. Out-of-grant ids answer `404 not_found` with the same body as an unknown id. Lists filter **before** paging, limits and counts; totals, badges and "N more" count only what the user may see. [The registry test](../server/test/multiuser-mu1.test.ts) compares the registry with the routes the hub registers and fails on any undeclared or stale entry. The demo routes are declared but registered only in demo mode.

The hook builds the member's grants into sets (projects per component, teams, agents, team rooms, vault folders and the restricted folders hidden inside them) on every call ([memberScope.ts](../server/src/admin/memberScope.ts)), so a revoked grant applies to the next call. Authorization never reads the audit actor's kind: a console user is recorded as kind `admin` (§3), so every admin-only check tests the role (`role !== 'member'`): the scope hook first, and the route guards in [blueprintApi.ts](../server/src/admin/blueprintApi.ts) and [decisionsApi.ts](../server/src/admin/decisionsApi.ts) as a second line.

Legend: **admin** = admin-only (403). **self** = the signed-in user's own data. **filtered** = only granted projects, with the component named. **decider** = items routed to the user (§1.3).

| Route(s) | Member scope |
|---|---|
| `GET /api/session` | public: `{signed_in}` only, so the console can show the login page without a refused `/api/me` |
| `POST /api/login`, `GET /api/me`, `POST /api/me/password`, `POST /api/logout`, `POST /api/totp/enroll`, `/confirm` | self. `/api/me` adds `role`, `display_name`, `external`, `org`, `expires_at`, `totp_required`, `setup_needed` (2FA still to enrol), `password_locked` (true for the .env operator on a demo hub, whose `POST /api/me/password` is refused) and `password_changed_at` (null when the password was set before the hub recorded the date); for a member also `grants`, `decider_teams` and `deciding_now` (the teams they decide for now), and it omits `public_url` and demo state |
| `GET/POST /api/pcs`, `/api/pcs/:id/*` (suspend, reactivate, setup, add, re-enrol, enrolment), `GET /api/onboarding/pcs`, `/api/onboarding*`, `PUT/DELETE /api/keys/:id/onboarding` | admin |
| `/api/keys*` (list, create, get, rotate, end-logins, binding, patch, rules, versions, rollback, apply-template, effective), `POST /api/simulate`, `/api/templates` | admin |
| `GET/PUT /api/settings/onboarding`, `/api/feedback/settings`, `PUT /api/graph/budget`, `/tier`, `/priority-folders`, `PUT /api/telemetry/baseline` | admin |
| `GET/POST /api/lockdown`, `GET /api/grants`, `DELETE /api/grants/:id` | admin |
| `/api/directives*`, `/api/directive-reports*`, `GET /api/agents/:id/directives`, `GET /api/teams/:id/directives` | admin |
| `POST /api/directives/:id/exemptions`, `DELETE /api/directives/:id/exemptions/:exemptionId` (keep a directive off an agent, a team or a project, and apply it there again) | admin: declared one by one in the registry, not in `MEMBER_READY` |
| `GET /api/audit`, `GET /api/audit/export`, `GET /api/invocations`, `GET /api/alerts`, `POST /api/alerts/:id/ack`, `/close`, `/suspend-key` | admin (a member's own sign-ins are in `/api/me`) |
| `GET /api/metrics`, `GET /api/telemetry` | admin: hub-wide counts leak the size of ungranted projects |
| `GET /api/sessions`, `/api/sessions/:agentId`, `POST /api/sessions/:agentId/archive`, `/api/links*`, `/api/shares*`, `/api/channels*` | admin |
| `/api/feedback*` (list, counts, export, item, status, assign, merge, patch, notes, delete) | admin |
| `/api/demo*`, `/api/reset*` | admin |
| `POST /api/agents/:agentId/notices` | admin (notices to agents act on agents) |
| `GET /api/agents` | filtered (`tasks`): agents that are members of granted teams; `id`, `label`, `role` and `status` only; no credential, PC or key fields |
| `POST /api/agents`, `PATCH /api/agents/:id` | admin |
| `GET /api/teams` | filtered: teams of granted projects; with `blueprint` only, `{id, name, status, project_id, tasks: false}`; with `tasks` the summary |
| `GET/PUT /api/teams/pins` | self, filtered: a pin of a hidden team is refused like an unknown team |
| `GET/PUT /api/teams/organize` | self |
| `POST /api/teams`, `PATCH /api/teams/:id`, `start`, `pause` (`{reason?, until?}`: an optional end time, any length; on a team already paused by the operator or a coordinator it sets a new end time and reason), `resume` (ends any pause, a coordinator's too), `stop`, `members`, `roles/:role`, `GET /api/teams/:id/handoff` | admin |
| `GET /api/teams/:id`, `GET /api/teams/:id/status`, `GET /api/teams/:id/tasks/:taskId` | filtered (`tasks`; `status` also with `blueprint`): members (label, role, activity), the board, the latest status report and the plan; never credential ids, key labels, playbooks, limits, recruits, usage, warnings or the decision-log path |
| `POST /api/teams/:id/tasks/:taskId/approve`, `tasks/:taskId/unblock`, `tasks/dismiss`, `tasks/:taskId/dismiss`, `plan-request`, `status-request` | decider |
| `GET /api/recruits`, `POST /api/recruits/:id/approve`, `/deny` | admin |
| `GET /api/decisions`, `GET /api/decisions/:id` | filtered (`tasks`), plus every item routed to the user; the list takes a team set |
| `GET /api/decisions/counts` | counts over the same filtered set |
| `POST /api/decisions/:id/answer`, `confirm`, `overturn`, `more-info`, `decline` | decider |
| `PUT /api/teams/:id/decision-log` | admin |
| `GET /api/requests` | decider: only requests routed to the user, inside the ceiling |
| `POST /api/requests/:id/approve`, `/deny` | decider; approval checked against the ceiling at decision time |
| `GET /api/needs-you`, `POST /api/needs-you/act`, `/dismiss` | self (§1.3); act rechecks version and decider through the source route |
| `PUT /api/teams/:id/attention`, `PUT /api/projects/:id/attention` | admin only |
| `GET /api/work/recent` | filtered (`feed`): task and Blueprint events of granted projects, filtered before `limit` and cursor; `total` and `next` never count or point past a hidden event |
| `GET /api/conversations`, `/api/conversations/:roomId/messages` | filtered (`messages`): team rooms of granted teams only; direct and ad-hoc rooms hidden |
| `GET /api/messages/search` | filtered (`messages`): the query runs inside the visible rooms; hit counts and snippets from those rooms only |
| `GET /api/conversations/:roomId/export` | filtered (`messages`) and `may_export`, else `403 export_denied` |
| `GET /api/vault/tree` | filtered (`vault`): lists the way down to the granted folders, then only what is visible, with file counts from visible files and no exposure data; restricted folders inside a grant stay hidden unless named |
| `GET /api/vault/activity`, `/preview`, `/revisions/:fileId`, `/diff` | filtered (`vault`): the path is re-resolved and checked on each call; a `fileId` outside the folders is 404; activity has no access events and no credential or admin ids; a revision path outside the grant is left out, and diff refuses a revision the file never had inside the grant |
| `POST`, `PUT /api/vault/files` | filtered (`vault`), member-ready: a note or a text edit where the member's folder grant gives Contribute, `403 read_only` where they only read, `404` where they cannot read; uploads stay `403 admin_only` ([vault](vault.md#people-writing-in-the-vault)) |
| `POST /api/vault/files/rename`, `POST /api/vault/files/restore`, `DELETE /api/vault/files` | admin |
| `GET /api/vault/backlinks` | filtered (`vault`), member-ready with the write routes; counts only notes the member can read |
| `GET /api/vault/media` | filtered (`vault`) and `may_export` on a grant that opens the file, else `403 export_denied` (with `as=text`, the editor's read, Contribute on the folder instead, else `403 read_only`); every request and range is checked again; a file outside the grant is 404; a refusal carries no size ([vault](vault.md#media-and-attachments)) |
| `GET /api/vault/conflicts`, `POST …/resolve` | admin |
| `GET /api/graph/entities` | filtered (`graph`): entities with a live claim sourced in a visible file; `claims` counts those claims only; the name is matched, not aliases, and description and aliases are left out because they may come from other sources; `merged_into` is hidden when its target is outside the member's view |
| `GET /api/graph/health`, `/budget`, `/flags`, `/jobs`, `POST /api/graph/flags/:id/resolve`, `/refresh` | admin |
| `GET /api/topology` | filtered (`topology`): `{teams, message_edges, comm_edges, pcs: []}` with granted teams, their agents and edges in their team rooms; no PCs, folders, app keys, direct rooms or edges to hidden agents (not even as a count) |
| Blueprint `GET /api/projects`, `/api/projects/:id/blueprint`, `/items/:key`, `/history`, `/research`, `/summary` | filtered (`blueprint`) |
| `GET /api/projects/:id/proposals`, `POST /api/proposals/:id/apply`, `/reject`, `POST /api/projects/:id/report-request` | decider (proposals routed to them; report request for their team's part) |
| `POST /api/projects/:id/ops` | decider, operator acts in their team's part only (§4); else admin |
| `GET /api/projects/:id/export.md` | filtered (`blueprint`) and `may_export` |
| `GET /api/projects/:id/export.json` | admin, even with `may_export`: it carries agent and team ids |
| `POST /api/projects/:id/restore` | admin |
| `GET /api/projects/:id/board`, `/board/:taskId` | filtered: `member_board` on and a grant on the project (§1.2), never an external user (§1.4), else `403 board_denied`; read only |
| `GET /api/projects/:id/overview` | filtered (`blueprint`): the ecosystem needs a grant, and each child is listed only with its own grant; a project's `parent` is named only with a grant on it, so a collaborator of one child learns nothing about a hidden sibling or ecosystem ([blueprint](blueprint.md) §3) |
| `POST/PATCH /api/projects`, `GET /api/projects/:id/kind-effects`, `PUT /api/teams/:id/project`, re-plans | admin |
| `GET/PUT /api/blueprint/views` | filtered (`blueprint`): a view of a project the user does not read is refused like an unknown project, and drops out of the list when the grant is lost |
| `GET /api/blueprint/attention` | filtered (`blueprint`): proposals routed to the user, escalations and contradicted claims of granted projects; counts from those only |
| `GET`/`PUT /api/settings/blueprint` | admin |
| `/api/users*`, `PUT /api/users/:id/grants`, `PUT /api/teams/:id/deciders` | admin |
| Streams | No stream exists; the console polls. A stream would declare a scope like a route and filter each event server-side at send time, rechecking the grant per event. |

The task backlog's accept, discard and demote are not Blueprint routes and stay admin-only.

A member's Home is built from these filtered routes only: attention items are **Needs you** (routed decisions, requests, proposals), the Blueprint cards of granted projects, the papers of granted projects, and Work in motion when `feed` is granted. It has no hub-wide KPI row.

## 3. Audit

- **Actor.** `audit_events` is append-only (no row changes; only rows older than the audit horizon, at least 365 days, can leave, archived first: [operations](operations.md#the-audit-trail)) and its check on `actor_kind` cannot change without rewriting the trail, so a console user is recorded with `actor_kind 'admin'` and `actor_role` set to `admin` or `member`. The in-code actor is `{kind: 'admin', id, role}`. Authorization never reads `actor.kind`: every admin-only check tests the role with `isAdmin()` ([audit.ts](../server/src/audit/audit.ts)), first in the scope hook, then as a second line in the route guards and service checks, which answer `403 admin_only` like the hook.
- **No console user id reaches a member.** Decisions, access requests, task events and the work feed drop them: whoever answered or decided shows as `operator`, and no key id is shown. A hook on every `/api` answer to a member replaces any other user id with `operator`.
- **Routed acts.** A routed act records `via` and `via_team` in the event details: `decider` for a member; for an admin, `admin_override` when the team has an active decider and `admin_fallback` when it has deciders but none can act. A team without deciders records nothing extra. `blueprint.write` and `blueprint.report_request` carry the same fields; a decided proposal routed to a team with deciders records `blueprint.proposal_decide` (`status` applied, rejected or stale).
- **Events.** `user.create`, `user.update`, `user.disable`, `user.enable`, `user.expired`, `user.grant_set` (before and after), `user.password_reset`, `user.password_changed`, `team.deciders_set`, `decision.routed` (to the active deciders, or `to: admin, reason: no_active_decider`; only for teams with deciders) and `decision.escalated`. A console write in the vault records `vault.file.create`, `vault.file.update`, `vault.file.rename`, `vault.file.delete` or `vault.file.restore` (target the path; details the revision and `author_kind` `operator` or `collaborator`).
- Member reads are not audited, except exports and vault preview by an external user. A member's `GET /api/projects/:id/export.md` and `GET /api/conversations/:roomId/export` record `export.read` (target the project or the room; details `what` (`blueprint` or `conversation`), `project_id`, and `bytes`, `paper` or `messages`). An external user's `GET /api/vault/preview` records `vault.preview` (target `vault_file`, the path; details `path`, `bytes`). An external user's inline `GET /api/vault/media` also records `vault.preview` (details add `media: true`), and a member's attachment download records `export.read` (target `vault_file`; details `what: vault_file`, `path`, `bytes` as the file size). Both count any response that sends bytes, from any range; `HEAD`, `304` and `416` record nothing. At most one row is kept per member, file revision and representation in 10 minutes. The admin's exports and a refused export record nothing. The audit log names these actors Collaborator.

The threats and controls for members are in the [threat model](threat-model.md).

## 4. Blueprint for members

- **Reads.** `GET /api/projects` lists granted projects only (total and paging from those); `/blueprint`, `/items/:key`, `/history`, `/research` and `/summary` of any other project answer `404 No such project.` exactly like an unknown id. An item's linked tasks, and a hypothesis's experiment runs, need the `tasks` component (else `{items: [], done: 0}` and no runs). A paper's manuscript on `/research` opens only where the member may read its vault path. `export.md` needs `may_export`; `export.json` is admin only (`403 admin_only`). No console user id reaches a member in any Blueprint answer: an operator or decider shows as plain `operator` (item and revision labels, a proposal's `decided_by`, the Markdown export). In every item answer to a member (`/items/:key`), agents show by their label and console users as `operator`, never an agent id, a user id or a username: who created and last changed the item, who moved a hypothesis's status, and an agent id held in a field (a paper's authors, a risk's owner); an agent that no longer exists reads "an agent". The answer has no History rows (`/history` answers a member with none), no Next, no issue marks and no actions. Who clarified a requirement reads "the operator", or the member's own name when they answered it.
- **Proposal routing** ([bpRouting.ts](../server/src/admin/bpRouting.ts)). A proposal goes to the deciders of the one team that owns every item it touches (for a new item, its parent's team or the `team_id` it names; for a link, both ends). It goes to the admin when it touches a project-level item (summary, stakeholder, architecture, term, reference), more than one part or an item without a team, opens or removes a track (module or line), or changes the owner of a track or paper; a re-plan submission too. `GET /api/projects/:id/proposals` gives a member the proposals routed to the teams they decide for now, filtered before paging; `apply` and `reject` of any other answer `404 No such proposal.`
- **Operator acts** (`POST /api/projects/:id/ops`). A member's batch passes only when every op is a status move on an existing item of one team they decide for that the Blueprint counts as the operator's (`isOperatorAct`, [blueprint.md §4](blueprint.md)): a requirement (FR, NFR) moving between `draft`/`dropped` and `agreed`/`built`/`verified`, either way; any status move of a decision entry (ADR); a paper leaving `planned` or `drafting`. Anything else (text, other moves, removals, links, project-level items, another team's part, an item an open re-plan marks) answers `403 not_decider`: those are the admin's. The write is recorded as the operator's, with the member's user id.
- **Report requests.** `POST /api/projects/:id/report-request` takes `team_id`. A decider must name a team they decide for and asks that team only (`400` without it, `403 not_decider` for another team of the project, `404` for a team elsewhere); the coordinator's notice says a decider asks. The admin asks one team, or every running team.
- **Admin only.** Creating and changing projects, moving a team to another project, the import, re-plans and the Blueprint settings.

## 5. Leak test

[`server/test/multiuser-leak.test.ts`](../server/test/multiuser-leak.test.ts) runs in `npm test`.

1. **Seed** two test projects (`CNV` and `BRZ`), each with two teams, agents, tasks, decisions, access requests, Blueprint items and a proposal, team-room messages, vault notes under each project's root and under `/Restricted/`, graph entities (including one entity with sources in both projects), feed events and a share. Every ECHO string carries a canary (`zzBRZ…`); collect every ECHO id (team, task, agent, room, file, entity, decision, request, item, proposal) in a set.
2. **Users:** `ana` (member, CNV full project) and `jonas` (external, BRZ blueprint and feed, 2FA enrolled), plus the admin as control.
3. **Walk every route** from Fastify's route table (`onRoute` hook), not a hand list. A route missing from the scope registry fails the test. For each route and user: fill path params once with a CNV id, once with a BRZ id, once with a random id; walk every page of paged GETs to the end.
4. **Assert** for `ana`: no response body, header or export contains a BRZ canary or id, a restricted note or a direct message; counts and totals equal the length of the filtered list; BRZ-id and random-id 404 bodies are byte-identical; admin routes answer 403; every mutating call outside her scope leaves the DB snapshot hash unchanged. Same for `jonas` against CNV, plus no `/Restricted/` path, no PC name or key id anywhere, and 403 on export. The search's echo of the typed query is not scanned.
5. **Lifecycle:** revoke a grant mid-session (next call filtered); expire `jonas` (401, removed as decider, routing falls back); an external without TOTP reaches only `/api/me` and `/api/totp/*`.
6. **Routing:** a CNV question goes to CNV's decider, not to `jonas`; with no active decider it goes to the admin; past `needed_by` the admin gets the attention item; a request beyond the ceiling goes to the admin.

The decider routes and the Blueprint routes are walked with the other project's ids too. [`multiuser-mu3.test.ts`](../server/test/multiuser-mu3.test.ts) covers routing, the ceiling, escalation and the `via` audit; [`multiuser-mu4.test.ts`](../server/test/multiuser-mu4.test.ts) covers proposal routing, the operator acts and report requests.

## 6. Design choices

Team deciders can approve access only within the administrator’s ceiling. Project-level Blueprint items and team ownership stay with the administrator. Members can perform the routed acts defined for their team.

## 7. Member views

A member's views are a shell of their own, not the admin console with parts hidden. They answer two questions for a colleague or an external research partner: how is my project going, and is anything waiting for me? The shell includes Home (Needs you; project cards, then Teams, in the left column; **Papers**, then Work in motion, in the right), Projects, one page per project (`#m/p/<id>`, with its tabs at `#m/p/<id>/<tab>`), one page per Blueprint item (`#m/p/<id>/item/<key>`), a question page (`#m/dec/<id>`) and Account. Needs you lists questions, access requests, task approvals and unblocks, and Blueprint proposals, with their actions (Answer opens the question; Approve, Deny; Approve; Unblock; Review, Apply, Reject), then its For awareness rows with Dismiss; it refreshes every 15 seconds. Tasks and Activity show only with those grants. The rail (bottom bar on phones) adds **Messages** and **Vault** when any project grants them:

- **Messages** (`#m/msgs`) lists the granted team rooms grouped by project, with a search over them; a room (`#m/room/<id>`) shows its thread, loads older messages and polls for new ones. Members read only; nothing is sent from the shell.
- **Vault** (`#m/vault/<path>`) browses the granted folders read-only. Inside a folder, breadcrumbs show the path (the middle crumbs fold to "…" on phones); at the top level there is none, since it would only repeat the page title "Vault"; a file (`#m/file/<path>`) shows its preview, Markdown rendered, or the player for an image or audio file. Without `may_export`, the reason shows beside the player ([vault](vault.md#media-and-attachments)); links into the vault resolve against the member's own folders exactly as they do for the operator ([vault](vault.md#links-in-notes)), and web links open in a new tab. A **Graph** tab (`#m/graph`), shown with the `graph` component, lists the entities `GET /api/graph/entities` returns, with a search; rows do not open.
- **Topology** is a section of the project page (with the `topology` component): per team, the room as hub and its agents around it, the line width by messages in the last 7 days, then a row per agent with its role and message count. Nothing opens; no PC, key or host is shown.
- **Task board** is a section of the project page when the admin turned on "Members can see the task board" (§1.2); an external user never sees it (§1.4). It sits full width under the overview: five columns (Open, Doing, Review, Blocked, Done) of cards with the title, the assignee and the state, one board per team; on phones the same columns are lists. A card opens a read-only sheet (state, team, who holds it, plan refs, description and summary) with no actions. The board replaces the Tasks list; without it, Tasks leaves out the backlog (the admin's queue).
- **An item opens as a page** (`#m/p/<id>/item/<key>`, the key encoded whole, so a claim is `PAP-1%2FC2`): the admin's item screen read only (one renderer for both consoles, `bpItemScreen`), without History, Next and actions (no overflow, Undo, Clarify, Add as claim, Archive or Export outline), and without issue marks. The page title is the item's title, with its key, kind and project in the line under it. A paper reads as on the admin screen: the top card with the readiness strip, Claims by part, Summary, Sources, and Records last. The Tasks card shows, as rows that do not open, only with the `tasks` component. Every link to an item opens that item's page, and Back follows the history, so Back from a claim returns to its paper; a page opened from a link returns to its project. A cited vault note opens the file viewer; one outside the member's folders shows its name only, with no path and no link. An unknown key and a project without a grant show the same "No such item" page. On a phone the page is one column with Records last.
- **Long lists** in a project page (each Blueprint group, each board column) show their first 8 rows (5 on phones for board columns) and a "Show all N" button.
- **Exports** appear only where the grant has `may_export`: **Export Markdown** in the project page header and **Export** on a room. Both download through the console's fetch-and-save helper and are audited (§3).
- **Width:** member pages use the full width, as the operator's pages do. From 1180 px a page with cards in both columns splits 7 to 5; a page with cards in one column only (Needs you and a question always, Home, a project page or Account depending on their content) gives that column the full width.
- **A delegated agent** ([checkout](checkout.md#91-delegate-one-agent)): a member who runs a delegated agent sees one row on their Home with its prompt and status, and confirms a new PC enrolled for it; they still see no PCs or keys. The prompt is rendered when they open it and shown only in that answer; after Take back the row reads "the operator took Rowan back" for a week.
- **Account** names the user's access: Colleague or External partner, the end date, their projects, and **Your agents**. That list shows each agent they own by label, with the teams and folders it may work in ([effective scope](authorization.md#owner-enforcement)). It never shows a PC, key or credential.

**First sign-in and two-factor gate.** There is no setup page: the user signs in with the password the admin handed over, and can choose their own from Account (`POST /api/me/password`). A user who must add 2FA and signs in without it sees the two-factor gate first, inside their own view (Start, the key, the code, or Sign out); a member who may skip it reaches the same screen from Account with "Not now".

**Where a collaborator lands.** After the sign-in and two-factor gates, a bare `#m` (no explicit destination) opens one place, decided from the grants in `GET /api/me`:

| Grants | Lands on |
|---|---|
| One project grant, no folder grants, and that project has exactly one team | That project, on Overview (`#m/p/<id>`) |
| Folder grants only (no project grant) | Vault (`#m/vault`) |
| Anything else: several projects, a project with several or no teams, or project and folder grants together | Home, which lists the destinations they have |

An explicit link (`#m/<view>/…`, a bookmark, a link in a note or a message) always opens where it points; landing applies only to `#m`. The rail keeps **Vault** whenever any grant includes a folder (a project grant with Vault, or a folder grant), so a collaborator with mixed grants still reaches it from any screen. Back and Home keep working: landing replaces `#m` in the history instead of adding a step.

**Account.** Account (`#m/account`) says what this person is and what they may do, without anything an agent could use:

- **Who:** the name, **Collaborator** with **Colleague** or **External partner**, the organisation and when access ends ("No end date" otherwise).
- **Access:** one row per project grant (its preset or components, "Exports on" when it may export) and one row per folder grant (its path and Read or Contribute). Each row opens its project or folder.
- **Your agents:** the agents this person owns, by label, each with its effective scope: the teams it works in and the folders it may read or contribute to. "No agents" when they own none. The scope is what the hub would allow today (§1.2, the owner's grant capped by live team membership): a folder from a project grant is Read, and Contribute shows only where a Contribute folder grant (§1.2a) delegates Contribute. Account never shows a key, a key or credential identifier, a PC, a host or a secret; those stay in the admin's Agent access and on the agent's machine.
- **Who can change this:** "The admin sets your access, when it ends and what your agents may do. Ask the admin to change them." There are no access controls in Account.
- Two-factor, theme, password and Sign out, as before.

**Empty Vault.** Vault fills the content width (no empty right column), and an empty state says which of two things is true:

- **No granted folders:** "No folders are shared with you yet. The admin shares vault folders; ask them if you expected some." Nothing to open.
- **An empty shared folder:** "This shared folder is empty. Files appear here when someone adds them." The breadcrumbs stay, so the collaborator can go back up.

**One project page, in tabs.** One page per project: a header (kind, name, key, health, Export Markdown when the grant allows it), then a tab bar (the console's `.tabs`). The tabs follow the grant: **Overview** always; **Work** (tasks ongoing and done lately, or the shared board; the roadmap of milestones; Activity and Topology when granted) only with Tasks; **Research** (lines, hypotheses, findings, papers) only when the project has research lines; **Blueprint** (every other item, read only) with every grant. With one tab left, there is no tab bar. **Overview** holds quick actions, four headline numbers that open their tab (plain text when that tab is not in the grant), this member's Needs you and For awareness filtered to the project (the same list as Home), **Papers** (this project's papers, the same list as Home without the project name; right after the card when it holds Needs you rows, before it when it holds only For awareness or Later rows), Next (milestone, nearest paper or task) and Progress (the measure bars). The tab is kept in the route, `#m/p/<id>/work`, `/research`, `/blueprint`; `#m/p/<id>` is Overview, and an unknown tab or one outside the grant falls back to Overview. An external partner sees the same page with less on it, not a different app. On a phone the tab bar scrolls sideways inside itself and replaces the section chips.

**Papers.** On Home it is the first card of the right column, above Work in motion, and lists every paper of every granted project; the hub already sends them with `GET /api/projects` (every page is read), and leaves dropped papers out. Each row is the paper's title on one line, then its project (Home only), its status, "due 12 Dec" for an open paper (in the warning colour once the date has passed) and "3 of 5 claims supported" ("No claims yet" without claims). While a paper is planned or drafting a chip says **Ready** or **Not ready**; other papers have no chip. Open papers (planned, drafting, submitted) come first, nearest date first and undated last; then accepted and published papers, latest date first; then rejected ones; ties go by project, then key. Eight rows, then Show all N. A row opens the paper's item page; the rows have no buttons. With no papers the card is not drawn.

**Admin flow.** Security → Users is one table (role, external, org, access ends, 2FA, projects, last sign-in) with one **Grant access** action. Its form holds the kind (Colleague or External partner), the first project and its preset; choosing External partner pre-fills a 90-day end date, required 2FA and no export. A user's page opens a per-project access editor where presets fill the component boxes and vault folders appear only when Vault is ticked (restricted folders are never offered to external users). A team's "Who decides" lists only users with a grant on that project, and shows "You decide" when nobody is named; it is built in team Settings, with **Deciders may approve** for the ceiling (sent only when edited; **Reset to default** sends `ceiling: null`). The console calls a member a **Collaborator** (an invited colleague or an external partner; the API role stays `member`). Agent keys and devices are under **Agent access**, a separate screen. After creating a user, the admin sees the generated password once with a Copy button and hands it over; a user's page offers a password reset that shows a new one the same way (§1.4).

The admin console stays as it is, with no grant-dependent hiding. A member never reaches it: the server answers every admin route `403 admin_only`.
