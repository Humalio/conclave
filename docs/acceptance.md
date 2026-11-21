# Acceptance checklist

Use this checklist to verify the [platform requirements](requirements.md) on a local review hub. Project-specific acceptance criteria and their results are recorded in the project’s Blueprint. Automated coverage includes the [server suites](../server/test/), [bridge suites](../bridge/test/), [graph benchmark](../bench/README.md), [client smoke test](mcp.md#client-setup), and [showcase](showcase.md). The Release Manager runs the server suite for the reviewed batch.

## Release checks

- **Deployment.** Start from a plain vault and a fresh database, then from populated state. Exercise restart, migration, and rollback using a pre-upgrade snapshot. Restore the database, blobs, configuration and vault. Test network interruption, oversized input, a missing vault mount and low storage. Through the LAN proxy, a plain-HTTP client without a header gets a `401`, never an OAuth redirect. Measure footprint on the target VM.
- **Desktop clients.** Open a fresh agent session in each supported client. Check the agent's identity, a permitted tool call, and delivery when the client is open or closed. For a legacy polling client, also check its timeout and acknowledgment behavior.
- **Onboarding with the connector.** Use clean accounts and a local HTTPS hub with a test CA. Try Claude Desktop on Windows, Claude Desktop over SSH to Linux, Claude Code in a macOS terminal, and Codex on Windows. Check setup without Node or Git, one failed agent start and retry, a second hub, and resuming after closing the app. Verify that an ordinary turn calls the hub and that **Connected** comes from the agent's own client. Record the client versions and which checks passed.
- **Wake and removal.** Verify opt-in wake and its isolation for each supported platform. Uninstall locally, then test remote disconnect separately. Confirm that connector-owned entries are removed and that edited files, user work, and other hubs are preserved.

  **Not yet recorded for 0.9.7.** None of the onboarding, wake or removal runs above has a recorded result yet; each is a release check still to be run and recorded for 0.9.7. The one recorded run is a local Windows move of a PC from the older setup with `conclave migrate` and Claude Code 2.1.325: two agent folders kept their identities, the connector passed its connection probe, and rollback restored their configuration byte for byte.

- **Console.** Check the operator questions on desktop and phone, in both themes, by keyboard, with untrusted content rendered as text, against [design guidelines](design-guidelines.md) §9.

## Criteria in the hub

These sections point at the acceptance criteria in the Blueprint and the suites that cover them.

### Collaboration and teams

Criteria under `FR-MSG-*`, `FR-TEAM-*` and `FR-AUTHZ-01`. The task backlog ([task lifecycle](specification.md#task-lifecycle)) is covered by the [backlog suite](../server/test/task-backlog.test.ts) and story step 4.2d: intake `backlog` by default; a coordinator's task lands in the backlog; assign, claim, start, progress, submit and `work_next` refuse or skip it; the operator accepts with a note, discards (kept, left out of `task_list` by default) and demotes an open task; a relayed `operator_request` opens at once as L1; intake `open` opens tasks at once; hub-raised tasks open at once; each move is audited and notifies the creator and the coordinators; agents and non-admin sessions cannot make the operator's moves. Postponement is covered by the [postpone suite](../server/test/task-backlog-postpone.test.ts): postpone and return to active are admin-only, versioned and audited, and keep the task in `backlog`, refused to agents; accept and discard work from either list and clear postponement; demotion starts active; `GET /api/tasks/backlog` combines list, project and tag before paging and counting and keeps relayed tasks in their own group; Home's count takes only active tasks. Task tags are covered by the [tags suite](../server/test/task-tags.test.ts) and the same story step: the directives normalisation and the limit of 8; the creator or another coordinator edits them only in the backlog, a worker never; the operator edits them on any task, audited, with a stale version refused; one-tag filters on `task_list`, `GET /api/tasks/backlog` and `GET /api/teams/:id/tasks`; a member reads a team's tagged list only with that team's tasks in their grant and cannot edit tags or read the backlog.

### Keywords and the Home Teams card

Keywords on projects and teams ([specification](specification.md#keywords-on-projects-and-teams)) are covered by the [keywords suite](../server/test/team-keywords.test.ts): migration 0103 and its default, the known list (validation, removal and its counts, respelling), keywords on project and team create and patch, the remembered Teams keyword, the console's matching rule (a team or its project has the keyword) and the Topology tab's route; story step 5.12 checks the defaults on a live hub. By hand, on desktop and phone in both themes: the keyword select sits before the search, filters together with it, survives a reload, Topology is its own Work tab (`#topology/<focus>`), and an old `#teams/…` link opens Home with the same choices (`#teams/o=topology&g=team:<id>` opens the Topology tab with that focus).

### Home

The Home contract in [Dashboard UX](dashboard-ux.md) is covered by the source-level [Home suite](../server/test/home-teams.test.ts): the team list mounted in the Home Teams card with its state in `#home/o=&k=&q=`, the declared layout (`HOME_CARDS` and one `grid-template-areas` block, no Sessions or `#tmCard` card), Backlog always shown, Activity sized from its own box, every team listed, the Topology tab, the `#teams` aliases, Home as the parent of team screens, the half-height key-figures strip with no sparklines, and no Home id reused by a view. By hand on the local dev hub, at 375, 768, 1180 and 1600 px in both themes: card edges line up, Tab follows the card order, the empty Backlog keeps its slot, Reorder works on Home, the Topology tab opens lit, and each operator’s pins, Organize and Keyword persist across sessions.

### Console navigation

The navigation and agent page behavior in [Dashboard UX](dashboard-ux.md#where-am-i) is covered by the source-level [navigation suite](../server/test/console-nav.test.ts): every view has a `ROUTES` entry whose chain ends at a root within 6 steps without a cycle, every `ROUTE_OK` pattern has an entry, no `teams` parent and no "Work ›"; the trail and Back of a Blueprint section with and without a team filter, a team opened from Home, from an agent and after a reload, the agent page from Members and from a link, `#ob/<id>` with no history; Back walks that end; `crumbsH` as the one breadcrumb renderer (vault and topology included); the phone app-bar meta built from the trail plus `here.meta`, and no view writing its own. The [Tell-the-agent suite](../server/test/console-tell.test.ts) covers Message on a Members row (admin only, before More, first in More), one form and one send path for the sheet and the agent page; the [agent cards suite](../server/test/console-agent-cards.test.ts) the `AG_CARDS` desktop and single-column orders drawn in DOM order, the Inbox (sender, subject, time, state, settled notices) and the playbook expand control; the [phase 2 suite](../server/test/phase2.test.ts) that opening the agent page never confirms a notice; the [MU1 suite](../server/test/multiuser-mu1.test.ts) the 403 `admin_only` on `POST /api/agents/:id/notices` for a member. By hand on the local dev hub, at 360, 390 and 1440 px in both themes: the crumb row and ‹ above a Blueprint section, no horizontal scroll at 360 px, Message rows sharing one right edge, one notice per send and the Pending line on the agent page, the agent page orders at 1440 and 1000 px with Tab following the cards as shown, and the agent page's Inbox and a long playbook expanded to its final paragraph at 390 and 1440 px.

### Project blueprint

Criteria under `FR-PLAN-05`, `FR-PLAN-07` and `FR-TEAM-16` (status reports). Trust per item, `q` and references are covered by the [refs and trust suite](../server/test/blueprint-refs-trust.test.ts) and story step 2.28; Start over (reset scope and first statuses, snapshot, keys kept, coordinator scope allowed and refused, one at a time, apply, send back, stale, cancel) by the [re-plan suite](../server/test/blueprint-replan.test.ts) and story step 2.29. A refused key names its format and an example (line, hypothesis, question, finding, issue), and every kind's example matches the §2.2 table: the [rights suite](../server/test/blueprint-rights.test.ts) and story step 2.25. Writing for the operator ([blueprint](blueprint.md) §2.7) is covered by the [plain suite](../server/test/blueprint-plain.test.ts) (the six warnings on the state after the batch, keys the batch creates, pending terms, the standing line, `plain: "issues"`, and sources by exact path, team folder and unique name, and every link form the vault viewer reads), the writing tests of the [tools suite](../server/test/blueprint-tools.test.ts) (the warning paragraph, 8 lines and the pointer, a clean write unchanged, a failing check never failing the write), the [console suite](../server/test/console-plain.test.ts) (code marks built with `textContent`, never inside links, code, buttons or the Records fold) and the [0102 suite](../server/test/migration-blueprint-writing.test.ts) (0100, 0101, 0102 on a fresh database and on a 0.x one recognised at 100; only copies equal to the shipped text change; a second run adds nothing). Trust boundary: a vault file outside the viewer's grant answers `missing`, the same as no file, for a console member and for an agent's `bp_write` and `bp_read`, so no warning tells either that the file exists.

Coverage and status meanings ([blueprint](blueprint.md) §3, §6, §9) are covered by the [coverage suite](../server/test/blueprint-coverage.test.ts):
- Given a requirement with no acceptance criteria, when the operator opens Coverage, then it is listed under "No acceptance criteria".
- Given a project with no gaps, when the operator opens Coverage, then it says so in one line.
- Given an agreed requirement that only another team's task names, when that team's agent reads `bp_read {plain: "coverage"}`, or a member without task access reads the summary, then that task is not counted, and the member gets no No task list at all.
- Given criteria passing with no evidence, accepted decisions that govern nothing and an open question asked 15 days ago, then each is in its list, and nothing new appears in Needs you or For awareness.
- Given a status report, then its hub facts carry the coverage counts of the team's part.
- Given a project where "built" means "deployed with a backup", when an agent reads the rules, then "built" comes with that sentence, marked L0.
- Given a member, an agent or a meaning over 200 characters, then `PATCH /api/projects/:id {status_meanings}` is refused, and nothing changes.

By hand on the local dev hub, at 1440 and 390 px in both themes: the Coverage card row and screen with gaps and with none, and a status tip on hover, on keyboard focus and as a sheet on touch.

### Agent feedback

Criteria under `FR-FDBK-*`; the server-side checks are the [feedback suite](../server/test/feedback.test.ts). Assignment read state: a bulk `session_ack` leaves an assignment unread, another agent's `feedback_read` too; only the assignee's `feedback_read` sets `read_at`, a new assignment clears it, `feedback_find {assigned: "me"}` and `session_whoami` show unread ones, and the console shows "not read yet" or "read <time>" plus the wake hint for an on-demand assignee ([assignment suite](../server/test/feedback-assign.test.ts), story step 2.18b). Check the Assigned to card and the list row in both themes at 1440 and 390 px.

### Onboarding

Verify the enrolment exchange, approval, one-time pickup, role and folder ceilings, key binding, and restart behavior in the [onboarding](../server/test/onboarding.test.ts) and [client setup](../deploy/client/setup.test.mjs) suites. Verify that operator-selected rules become directives and retained requirements produce a Blueprint proposal in the [team onboarding suite](../server/test/onboarding-team-directives.test.ts).

### Console access and team decisions

- **Project isolation.** A member sees only granted projects and components. Hidden IDs behave like unknown IDs and excluded data does not affect returned counts or cursors. An external member must enrol TOTP. See the [scope coverage](../server/test/multiuser-leak.test.ts), [external user and account tests](../server/test/multiuser-mu1.test.ts), and [member board tests](../server/test/member-board.test.ts).
- **Delegation.** A question or request inside the team's ceiling goes to its active decider. Out-of-ceiling requests go to the administrator. Decisions and fallbacks retain the actor and routing in audit. See the [routing tests](../server/test/multiuser-mu3.test.ts) and [Blueprint scoping tests](../server/test/multiuser-mu4.test.ts).
- **Question ownership.** Settling a question releases the block it owns. A separate question or manual task block stays in force. Confirming or overturning a relayed answer preserves its provenance. See the [team workflow tests](../server/test/team-workflow-regression.test.ts) and [task tools tests](../server/test/task-tools.test.ts).

### Checkout

The server suites `checkout.test.ts`, `checkout-keys.test.ts` and `checkout-tools.test.ts`, `feedback-fixes.test.ts` (no-repo checkpoint, per-member checkout branch, integration branch and repo hosts named up front, vault copy before the handout, reconnect hint, contributor notes, denial hints, graph_stale coverage), and story steps 5.13–5.15 (row `checkout`: checkpoint and leftover check, an operator-approved exception, handouts, pause at ready, render, restore with new keys, resume once), the connector's client suite `deploy/client/connector-restore.test.mjs` (tampered handout hash, a ref starting with `-`, a non-ancestor head, a divergence, the clone exclude, the config scan, start lines), and the real-hub test `server/test/connector-restore-real.test.ts`.

| Restore target | State |
|---|---|
| `same_user`, Claude Code | **Verified** by the real-hub test `server/test/connector-restore-real.test.ts`: a team onboarded the real way, a checkout rendered, then the connector's restore runs against the hub's own routes (config scan, scan gate, pickup, confirm, trust, suspended keys), builds the folders and entries, and every agent's `checkout_resume` is accepted. Step 5.15 of the story calls the same hub routes directly, the way the connector does. |
| Another OS user on the same PC | Not a render target any more: that user pairs their own connector, then the PC is a normal other-PC target. |
| `other_pc`, Claude Code | Not verified: needs a second PC (enrolment, approval, fetch and fast-forward from a real remote). |
| Codex | A local Windows test with Codex CLI 0.167 restored two agents using separate repository clones. It verified each identity and playbook, checkout acknowledgment, a task handoff through review, and a commit through the connector. The tracked `AGENTS.md` and Git hooks stayed intact, and the old credentials were revoked. See [Restore by the connector](checkout.md#6-restore-by-the-connector) and [Codex design and verification](checkout.md#9-design-choices). |

### Vault copy (99 Conclave)

The [vault copy suite](../server/test/vault-mirror.test.ts) and story step 5.16 (row `vault-copy`): pages for a checkout through each status, a hub-built handout, project folders by name with the key only on a clash, a team moved to another project and a project renamed moving the hub's pages (other files stay), the one-time move from the old key-and-name folders, a team rename that keeps its folder, colliding labels, a reset followed by a team of the same name (` (2)`); no token URL, third-party token, Conclave key or split issued key reaches a page (the last withholds its section and raises `key_in_result`); the deferred purge on resume, restore, finish, cancel and expiry (kept while the vault is frozen, cleared once the page is written), a replaced handout, the 7-day cap and its Attention item, a rolled-back sweep; every agent write under the folder refused, reads only with a rule that names it, `file_search`, backlinks and the graph skipping it, members only when granted by name, no decision log there; unchanged text writes nothing. On the local review hub, check that `99 Conclave/` holds the expected checkouts with their handout pages, that an agent key is refused there, and that the folder shows in Obsidian.

### Vault editing

The [vault editing suite](../server/test/vault-editing.test.ts) covers [people writing in the vault](vault.md#people-writing-in-the-vault): a console save is a revision whose author kind is `operator`; a stale save writes nothing and records no conflict, and Keep mine writes over the newer version while the agent's version stays in History; a recovered write intent keeps the person as author; agents' `file_history` shows the kind and a label and never a user id; `99 Conclave/` in any case, hidden names, Windows-reserved names, names ending in a dot or space and case aliases are refused at both ends of a rename; a removal is a tombstone that Restore brings back, refused when the path is taken; the link count leaves out notes the viewer cannot read; the write pause refuses with its reason; every write is audited; members are refused until Contribute is live, and the member rules (read only, not found, rechecked at save, audited external edit read) are checked against the switch. By hand on the local review hub, at 1440 and 390 px and by keyboard: create, edit with the preview, the clash banner with each choice, rename with the link count, remove and restore.

### Vault media

The [vault media suite](../server/test/vault-media.test.ts) covers [one byte path](vault.md#media-and-attachments) for the operator and members:
- types checked from the bytes, including an HTML or SVG file renamed `.png`, which is served only as an attachment;
- `200`, `206` and `416` with the right lengths, the 8 MiB cap, and `HEAD`;
- `rev`, `If-Range` and `If-None-Match`;
- the private cache, `nosniff`, resource-policy and sandbox headers;
- path escapes and hidden folders refused;
- a file outside the grant, or inside an unnamed restricted folder, answering like a missing one;
- `may_export` required for inline and attachment reads;
- a grant revoked between two ranges denying the next range with no size;
- the audit rows for an external playback and a member's download, including one that starts after byte 0, and none for `HEAD`, `304` or `416`.

The [console media suite](../server/test/console-media.test.ts) checks that one player is used in file views, folder rows and note embeds.

On the local review hub, check by hand in both themes, at 390 and 1440 px:
- preview an image;
- seek within embedded audio;
- revoke the folder grant, then seek again;
- open a disguised file;
- check that a clip that cannot play leaves its note readable.

### Directives

Criteria under `FR-DIR-02`; the server-side checks are the [directives tests](../server/test/phase3b.test.ts).

Verify [reach, exemptions, and notice settlement](directives.md#scope-and-order).
- The [exemptions suite](../server/test/directive-exemptions.test.ts): a directive kept off a team, a project or an agent leaves the list, login lines, `session_whoami`, `directives_list` and `directives_read` of exactly those agents (`directives_read {id}` is `not_found`), each told once to stop, and an older pending notice for it settles with no `session_ack`; a stop notice settles on the next `directives_read` in any form; a confirmed version settles its notice and a new version notifies again; a joiner loses it with no notice and a leaver gets it back; lifting the exemption tells them once and their old read state returns by version; coverage, `exempt_count`, `reach_label` and the team view drop the exempted agents; an agent-scoped directive, its own scope target or an unknown target is `invalid_argument`, a retired directive `invalid_state`; retire and merge keep the exemption as history; the audit rows; a 0105 database migrates to 0106 with every list and count unchanged and `ref_kind` backfilled.
- The extended [directives tests](../server/test/phase3b.test.ts): `directives_read {id, ack: true}` settles that version's notice; an unrelated later notice is still delivered and `notice_acked_seq` does not move; the team view's `tab`, `exempt_here`, `copy_of` and totals, with a member copy, an exempted hub row and a project exemption covering every member.
- The [scope registry test](../server/test/multiuser-mu1.test.ts): a member gets `403 admin_only` on the exemption routes.
- The [migration prefix test](../server/test/migrations-unique.test.ts): two migrations with the same 4-digit prefix fail the suite.
- The console's static tests: [team directives](../server/test/console-tdirs.test.ts) (the `role="tablist"` `.tabs`, no `TDIR_OPEN` or Hub-wide fold, the tab from the hash, Keep off and Apply again posting to `/exemptions`, Fold copies) and the [directive screen](../server/test/console-directive-detail.test.ts) (Kept off section, the Keep off sheet limited to agent, team and project, `reach_label` in the list, `exempted` on the agent card).

### Task turns

- **Migration and recovery.** [Migration coverage](../server/test/migration-task-turns.test.ts) verifies that existing held tasks get the matching turn, queued leases and stale overdue alerts clear, and activity and start fields are backfilled. Customized playbooks stay intact. Repeating startup leaves the data unchanged.
- **Transitions.** The [task turns suite](../server/test/task-turns.test.ts) verifies that each workflow transition closes the prior turn and opens at most one new turn. Only the holder's successful full read of that task (`task_list {task_id}`, a `work_next` item that delivers it) or successful action on it marks the turn seen; a list fetch, an unrelated call or a refused attempt leaves it unseen. A queued turn has no deadline. A review turn records its review due time.
- **Timing.** The [workflow suite](../server/test/phase3b.test.ts) checks that work clocks start at `task_start`, polling liveness uses the later of last activity and declared busy time, and one sweep releases the member's held tasks. The [reclaim suite](../server/test/task-reclaim.test.ts) checks that the worker a task lapsed from takes it back with `task_claim` within 24 hours in the status it held (a `changes_requested` task with its comments), and that another worker, a reassignment in the meantime, removal from the team, a cancellation, a block or 25 hours refuse or clear it; it also checks that a resubmission while in review returns the reviewer's wake line. On-demand overdue alerts apply to started work. Pause holds work and review timers. The [team pause suite](../server/test/team-pause-until.test.ts) checks a pause with an end time: when it passes, the team runs again, each lease restarts from then and no task lapsed; a coordinator sets a pause of at most 24 hours and ends only its own; the operator ends any pause early; and a pause past its end time raises an alert.
- **Delivery.** The [tool suite](../server/test/task-tools.test.ts) and [review notice suite](../server/test/review-notices.test.ts) verify turn and queue details, hand-off results, notices, and wake instructions. Wake text contains the task ID and action. Replacing or withdrawing a submission settles the review turn for the old submission.

### Hardware

SPEC-HARDWARE-01 to 03 ([Hardware](hardware.md)). The [hardware suite](../server/test/hardware.test.ts) walks two eligible agents of one team through joining, holding, reporting and release, with the second promoted and notified. It also checks:

- a cancellation;
- the operator removing an entry;
- revocation: a holder losing its task, and an agent losing access when its team is taken off the machine. The entry goes, the next one moves up, and only a holder raises a flag;
- two simultaneous joins giving one holder and one waiting entry;
- refusals for a machine the team may not use, a task not assigned to the caller, or a second join;
- another team's task title never appearing in `hw_list`;
- the preview matching what `hw_list` shows;
- the scheduled-window label across midnight and in the machine's timezone;
- the audit trail.

The [control suite](../server/test/hardware-control.test.ts) checks, with the hub clock set by the test:

- a join outside the opening hours waiting, and the hold starting when the window opens;
- the notice 10 minutes before the window ends, once, and the "past window" flag at the end, with the hold kept;
- a team's daily allowance: an entry whose hours do not cover it keeping its place while the next one holds, the notice and the flag, a join refused with the reset time, and use split at local midnight;
- pause and resume, and their audit entries;
- the analysis matching What ran, the waits, the share of open time held and the week grid;
- the period, the filters and their chip counts.

The [measuring suite](../server/test/hardware-measure.test.ts) checks, with the hub clock set by the test (SPEC-HARDWARE-02):

- samples refused while the check-in says measuring is off or says nothing, and taken once it says on;
- a PC without a compute role refused, and `measure_only` in the check-in answer only for a compute machine;
- a batch with text, a value out of range, none or more than 120 samples refused;
- samples more than 5 minutes from the hub clock dropped, a batch of only those refused, a repeat counted as a duplicate;
- a hold from 14:10 to 15:00 getting exactly the samples of that time, and the rest counted as Use with no holder;
- one over-limit flag after 2 minutes over the memory limit, a 4-minute gap restarting the count, the holder kept and
  told without figures;
- every PC order but Update refused for a compute machine;
- raw samples gone after 7 days, summaries kept after the machine is removed and gone after 400 days;
- `hw_list` showing the declared limits and no measured figures.

The [connector sampler tests](../deploy/client/connector-hardware.test.mjs) check CPU % from fixed CPU times, the
`nvidia-smi` parser, the 120-sample cap and the opt-in switch; the service suite checks, against a fake hub, that a
measure-only connector sends fixed samples only while measuring is on and refuses a check and a restore.

The [console suite](../server/test/console-hardware.test.ts) checks the routes, the tab and the screens' markup. By hand, at 1440 and 390 px in both themes: add a machine through the sheet, including a new one by name and Preview, then see a holder, a waiting entry and a flag; open the machine, drag the week grid, set a daily allowance, pause and resume.

## Regression cases at trust boundaries

- Search for a marker present only in an inaccessible note. Check paths, counts, snippets, backlinks and conflict results for disclosure.
- Put a disposable credential in an externally written note. Verify that full and partial reads, search snippets, history and graph delivery do not return the secret. Check that the reader's key remains active.
- Use a private cause and a readable dependent note in a mixed-permission team. Check flag details, generated tasks and notices, entity labels, summaries and aggregate health before and after revocation.
- Exercise lease expiry and batch redelivery after an individual submission. Confirm that expired or completed jobs do not reappear as pending batch work and that a partial impact verdict cannot silently finish the job.
- Relay an operator answer as the coordinator (`team_ask_update relayed_answer`). Confirm it is L1 in `team_decisions`, the notices and the console until the operator confirms it; that a worker or another team's coordinator cannot relay; that no Blueprint ADR is recorded or accepted before the confirmation; and that an overturn keeps the relayed answer on record. See [task tools](../server/test/task-tools.test.ts).
- Sign in as a member ([multi-user](multi-user.md)). Confirm that every admin route answers `403 admin_only`; that an external user without TOTP reaches only `/api/me`, `/api/totp/*` and `/api/logout`; that an expired user cannot sign in and their live session ends; that a new user's generated password is returned once, stored only as a hash and signs in, that a reset ends the user's sessions and the old password fails, and that `POST /api/me/password` checks the current password and the rules, ends the other sessions and is refused for the operator on a demo hub; and that a route missing from the scope registry fails the suite. See the [sign-in suite](../server/test/multiuser-mu1.test.ts). Run the [leak test](../server/test/multiuser-leak.test.ts): a member walking every route with another project's ids sees none of its data, and those ids answer exactly like unknown ones. Run the [routing test](../server/test/multiuser-mu3.test.ts): a team's questions and access requests inside its ceiling go to its active deciders, who act with `via: decider` in the audit; the admin's act is `admin_override` or `admin_fallback`; a request beyond the ceiling stays with the admin; an unanswered question escalates once after 24 h or `needed_by`. Run the [Blueprint scoping test](../server/test/multiuser-mu4.test.ts): a member lists granted projects only; a proposal touching one team's part goes to that team's deciders, and one touching a project-level item, two parts or an owner goes to the admin; a decider agrees or drops a requirement, settles a decision entry or submits a paper in their part and nothing else (`403 not_decider`); `export.md` needs `may_export`. Run the [member board test](../server/test/member-board.test.ts): with "Members can see the task board" off, a member with a grant gets `403 board_denied`; on, they read the board without the backlog, discarded or cancelled tasks and without agent ids, read only; a task of another project reads `404 not_found`; a member without the project and an external user (even with a grant and the switch on) get the same `403 board_denied` as an unknown project; turning it off closes the board at once.
- Move a task out of the backlog as an agent: coordinator `task_assign`, `task_block`, `task_cancel`, `team_ask` with the task, worker `task_claim`, and an agent credential against `POST /api/teams/:id/tasks/:taskId/accept|discard|demote`. Confirm each is refused and the task stays in `backlog`; that a relayed `operator_request` stays L1 and the operator can demote it; and that agent text in a discard note renders as text in the console.
- Try an agent credential against admin routes. During an asynchronous action, revoke the applicable grant and confirm that delivery or commit follows the current permission decision (held messages: `server/test/revoke-and-held-dm.test.ts`; transfers saved into the vault or a share, including a grant, app-key cap, key state, team pause or lockdown changed mid-transfer: `server/test/lockdown_bridge.test.ts`).

See [graph disclosure regressions](../server/test/graph-security-regressions.test.ts) and [job queue regressions](../server/test/graph-queue-regressions.test.ts).
