# Checkout and handouts

Use checkout to pause a team, save the state of its work, and restore it in Claude Code or Codex on a prepared computer. The connector restores the agent folders from the recorded handouts and approved repository. See [Restore by the connector](#6-restore-by-the-connector) and the [acceptance checks](acceptance.md#checkout).

## 1. Goal and terms

Move a running team so that the agents keep their identity, team, tasks, cursors, decisions and Blueprint part. Only the local side is rebuilt.

| Term | Meaning |
|---|---|
| **Checkout** | One move of one team, from start to restore, cancel or expiry. Row `checkouts`, id `cko_…`. |
| **Handout** | One agent's record of its local facts, written by that agent. Row `handouts`, id `hnd_…`. No secret, no copy of hub data. |
| **Render** | The operator's choices (target, agent keys, provider and permissions per agent) applied to the handouts. Render returns the restore prompt. |
| **Restore** | The operator presses Restore. The order names the checkout and a destination the target's user approved earlier on that PC, never a path. The connector runs §6 from the validated handouts, keeps the config scan, the host and ref checks and the no-push rule (F8), and asks the user before trusting any folder whose identity or agent config changed. A PC without the connector still gets the restore prompt for one release. |
| **Restore prompt** | The must-run text the operator pastes into one session on the target. It rebuilds folders, keys and MCP config, checks them, and prints one start command per agent. |

## 2. The flow end to end

1. **Start.** The operator presses Check out on a team (or `POST /api/teams/:id/checkout`). The checkout is `collecting`. Each member gets a `checkout_requested` notice and a work item, and its PC a `write_handout` order, so the agent writes its handout with no one at the keyboard ([connector.md](connector.md#reason-orders)).
2. **Checkpoint.** Each agent stops taking new work (its playbook step says so; the hub enforces it only from `ready`), stops at a good checkpoint, merges what it did into its team's integration branch and removes its worktrees (§4). Its progress shows `checkpointing`, then `merged`.
3. **Write.** The agent calls `checkout_handout` with the merge commits; its handout is `written`. The source is now quiet, all work is on integration branches and no worktree is left, though no key has changed.
4. **Ready.** When every handout is written, or the operator goes on without the missing ones, the checkout is `ready`. Handouts are locked and the team is paused (§9 F5). A missing handout is built from the onboarding slot and the agent row only, with no notes; that agent's unmerged work stays on the source, and the console says so.
5. **Render.** The operator picks the target, agent keys, and a provider, model and permission level per agent (§5). The hub checks the combination, stores a hash of each handout body, creates a checkout onboarding request on the target machine (§5) and returns the prompt. For another user or PC it also lists, per repo, the branches and heads the operator pushes before running the prompt (§9 F8). The checkout is `rendered`. No key is created yet.
6. **Collect.** On the target, the connector carries out the console's Restore order (§6); a PC needs Add PC and an approved destination first. When the target PC's user approved exactly one destination, the hub sends Restore itself after the render. The secrets are picked up once through the normal onboarding pickup, written to the connector's key file, and the folders are built. The checkout is `restoring` after confirm.
7. **Start.** Once the restore is done, the hub sends each moved agent a `resume` order on its new PC, so its connector starts it ([connector.md](connector.md#reason-orders)); the prompt's start commands stay for a PC without the wake. Each agent's first call is `checkout_resume`, accepted only from a login made with this checkout's new key (or, for a same-user move with reused keys, a login made after render). The handout is then `consumed`.
8. **Remove.** When every agent has resumed, the checkout is `restored`: the old keys are revoked (§5) and the team pause is lifted. Handout bodies are cleared once their vault copy is written (§3, the deferred purge).

If the prompt is never run, the checkout expires (§3), the old sessions are reinstated and the team resumes where it was. Cancel and expiry do not undo the checkpoint: the merges stay, and open tasks go on from `checkout/<id>` on the source.

## 3. Data model

The [schema baseline](../server/src/db/migrations/0100_v1_baseline.sql) defines checkout, handout, and key succession records.

**`checkouts`**

| Column | Meaning |
|---|---|
| `id` | `cko_…` |
| `team_id` | the team being moved |
| `status` | `collecting` → `ready` → `rendered` → `restoring` → `restored`, or `cancelled` / `expired` before `restored` |
| `source_machine_id` | the PC the team runs on (from its onboarding app key) |
| `target_machine_id` | set at render: the same PC, an existing PC, or a new `machines` row in `waiting_install` |
| `request_id` | the checkout onboarding request (§5) that carries slots, pickup and confirm |
| `choices` | JSON from render: `target`, `rotate_agent_keys`, per agent `{provider, model, permissions}` |
| `handout_hashes` | JSON `{agent_id: sha256}` stored at render, checked at pickup and resume |
| `requested_by`, `created_at`, `rendered_at`, `restored_at` | audit |
| `expires_at` | 48 hours after start, reset at render. Fixed, not configurable. |
| `scope`, `agent_id` | `team` (the default), or `agent`: one agent of the team is moved, named by `agent_id` ([Delegate one agent](#91-delegate-one-agent), migration 0143) |
| `delegate_user_id`, `delegate_render` | a one-agent checkout's delegate, the person who runs the agent while delegated, and the render the admin chose (the PC and provider choices, no secret), rendered when the delegate opens the prompt |
| `prompt_opened_at` | when the delegate opened the prompt (reset at every render). `pc_confirmed_at` and `pc_refused_at` remain as unused columns |
| `drafts_path` | contributor mode's drafts folder: the folder grant the admin gave the delegate at Delegate, removed when the delegation ends |
| `released_at`, `released_by`, `release_reason` | the delegation ended: `taken_back`, `moved_again`, `back_with_admin`, `cancelled` or `expired` |

**`handouts`**

| Column | Meaning |
|---|---|
| `id` | `hnd_…` |
| `checkout_id`, `agent_id` | one per agent per checkout (unique) |
| `status` | `requested` → `checkpointing` → `merged` → `written` → `consumed`, or `removed` (cancel, expiry) |
| `body` | JSON with the local facts (§4), at most 8 000 characters. Kept after `consumed` or `removed` until its vault page holds it, then set to `NULL` (the deferred purge below). |
| `purge_due` | When the body may be cleared: set by resume, restore, finish, cancel and expiry. |
| `written_at`, `consumed_at`, `new_credential_id` | audit, and the key issued for it |

- **State changes are guarded.** Every transition is `UPDATE … WHERE id=? AND status=?` and fails if the row moved. Pickup and resume re-check the checkout status inside their transaction, so cancel, expiry and a new render cannot race them.
- **Single use.** A handout moves to `consumed` once, inside the transaction that accepts `checkout_resume`, which also sets its `purge_due`. A second call answers `handout_consumed`.
- **The deferred purge.** Resume, restore, finish by hand, cancel and expiry change the status as before and set `purge_due`; none of them clears the body, since no vault write can run inside their transaction. After each run of the vault copy and every hour (also with vault scanning off), the hub clears a due body in its own statement, and only when the handout's page in `99 Conclave/` holds that version (`mirror_files.ref_version = version`), so a handout replaced after its page was written waits for the new page. A body whose page could not be written is cleared anyway 7 days after `purge_due`; 24 hours before that, the hub raises the Attention item `handout_purge_soon`: "The handout of X will be cleared before its vault copy was written." The wait holds while the vault copy is turned off. A kept body cannot be used: `consume()` needs `written`, pickup needs `rendered` and resume falls back only to `restored` checkouts. It shows only in the operator's view. A page the leak guard withholds whole (an issued key in the body) still counts as holding the body: the body is cleared, and the `key_in_result` alert is the only trace of the withheld text. See [vault](vault.md#the-hubs-folder-99-conclave).
- **Expiry.** A sweep in `Teams.tick()` moves past-due checkouts to `expired`: bodies due for the purge, unconfirmed keys revoked, old sessions reinstated, team pause lifted. A checkout that expires while `restoring` keeps its confirmed keys and handouts and raises an Attention item instead; the operator then cancels (the team stays paused unless forced, since some agents may already run on the target) or finishes by hand.
- **One checkout per team, and one per agent.** A team checkout and a one-agent checkout refuse each other (`checkout_conflict`). While one is open, `add_agents` and Re-enrol PC are refused for the team's PC with `checkout_open`.
- **Audit:** every state change, plus handout replaced, render superseded, approval, pickup (issue count), failed pickup (counted toward `pickup_fail`), binding set and resume refused. `checkout.rendered` records the handout hashes, since bodies are cleared later. A body cleared by the 7-day cap without its copy is audited as `checkout.handout_purged_uncopied`.

## 4. Checkpoint and handout

**Checkpoint first.** When a checkout starts, each agent:

1. stops at a good checkpoint: it finishes or cleanly pauses its current step, with tests passing where the task has them, and reports `checkpointing` (`checkout_progress`);
2. commits its work and merges it into its team's integration branch under the team's normal landing rules, with no force and no history rewrite. Work not yet approved goes to the agent's own checkout branch `checkout/<id>-<member>` instead (member: the agent's short name made safe for a ref; `checkout/<id>/<member>` cannot sit next to `checkout/<id>` in git) and its task stays open (§9 F7); the handout and the console say which commits are unreviewed. Local config (`keys.env`, `.mcp.json`, `.agent-hub.json`, `.claude/settings.local.json`, `.codex/`, role overlays) is never committed. It reports `merged` with the merge commits, `checkout_branch` and `checkout_head` if it used its checkout branch, the number of worktrees left and whether its tree is clean. With nothing to merge (no repository, review-only work) it reports `no_repo` with a short reason instead of the branch, head and merge commits: either the reason or a valid head, never both;
3. removes its task worktrees and deletes the branches it merged. Its own session folder is left clean at the integration tip and retires with the source;
4. runs the **leftover check** and reports it with `merged` (`checkout_progress {leftover_check}`): remaining worktrees (`git worktree list`), unmerged local branches, uncommitted or untracked files, `node_modules` and build output in task folders, temp browser profiles and scratch files the agent created, and running dev hubs or background processes it started. Each must be cleaned up or listed as an exception with a reason. The hub cannot see the disk, so the check is self-reported; the console shows the list next to the agent, and the operator approves any exception before render;
5. copies the files it wants kept to its project folder in the vault. This comes before the handout: once every handout is written the team pauses (§9 F5) and vault writes stop. The pause stays: it is what makes the handouts a fixed point, so there is no write window after it. `checkout_status` repeats this step to every member whose handout is not written yet;
6. writes its handout. The repo URL must be on the repo host allowlist (§8); the checkpoint steps and `checkout_status` name the allowed hosts up front.

The checkpoint steps and the `checkout_requested` notice name the team's integration branch where the hub knows it (the latest checkpoint report of any of the team's checkouts that names one); otherwise they say "the branch your team merges approved work into (usually `develop`)". The notice ends with "If you don't see `checkout_handout`, reconnect the Conclave server or restart your session.": the `checkout_*` tools are listed for every team member, but a client lists tools when it connects. `conclave mcp` sends `notifications/tools/list_changed` when the hub's `X-Agent-Hub-Tools` digest changes ([MCP](mcp.md#tool-inventory)); a session that connected before a hub update added tools, or a client that ignores the notification, does not see them until it reconnects.

Agents never push, at the checkpoint or after. How the commits reach another user or PC is §9 F8.

**A handout holds only what the hub cannot know.** Everything the hub holds is read live on the target with existing tools. A copy would go stale.

| Held by the hub (referenced, never copied) | Local facts (in the handout) |
|---|---|
| Identity, role, `role_detail`, model label (`agents`) | `folder`: name under the project root (`[A-Za-z0-9._-]`, at most 64 characters) |
| Team, goal, mode, playbook (`team_info`) | `repo`: `remote_name`, remote URL, `clone_folder` (shared by the agents of one repo) |
| Tasks, leases, reviews (`task_list`) | `checkpoint`: `integration_branch`, `integration_head` (the tip right after this agent's merge), `merge_commits`, and `checkout_head` with `checkout_branch` if it used its checkout branch; or `no_repo` with the reason when there was nothing to merge. A checkpoint stored without `checkout_branch` means `checkout/<id>` |
| Notices and room cursors (copied to new logins) | `provider_was`: `claude_code` or `codex`, model and effort, permission mode |
| Decisions, directives, Blueprint part, shares, vault files | `notes`: at most 1 500 characters for the next session: what it was doing, what comes next, anything from local memory worth keeping |

- **Clean or refused.** `checkout_handout` refuses with `checkpoint_incomplete` before the agent has reported `merged`, or while its `merged` report shows uncommitted work, a remaining worktree, or any leftover the operator has not approved as an exception. Branch names follow ref-name rules with no leading `-`; heads are exactly 40 hex characters. The report is the agent's own; the restore proves it by finding every recorded commit (§6).
- **Agent config travels only as tracked repo content**, which the restore scans before any trust is written (§6).
- **What does not move**, stated in the handout and in the resume answer: transcripts and `/resume` history, auto-memory, subagents, hooks, skills, and local session ids (on-demand wakes need the new ones). `notes` summarises what matters.

## 5. Keys

The handouts and the prompt hold **placeholders only**, for example `${CNV_CORE_LEAD_SESSION_KEY}`. The hub stores verifiers, never secrets, so every secret that reaches the target is newly issued and collected once.

**Reuse onboarding, do not copy it.** Render creates a pre-built `onboarding_requests` row with `kind='checkout'` on `target_machine_id`, with one slot per agent (folder, `session_var`, role, binding forced on). This keeps the per-PC uniqueness of folders and session variables, makes the agents visible to a later Re-enrol on the target, and reuses `pickup` and `confirm` with their nonce, 3-issue limit, rate limit and auth unchanged. There is no separate checkout code or `/onboard/checkout/*` route.

- **Enrolled PC** (the same PC, or another PC added with the connector): pickup is authenticated by that PC's app key, which the connector already holds. No code appears in the prompt. The request is approved at render.
- **New PC, or another OS user on a PC:** render issues no code and creates no key. A new PC is refused with `add_pc_first`, and `same_pc_other_user` with `other_user_pairs_first`: "That user installs the connector and pairs it, then approve a destination." Once that PC is enrolled, render for it by `machine_id`.

**Render choices**

| Choice | Options |
|---|---|
| `target` | `same_user` (same OS user: another provider, or another provider login via `CLAUDE_CONFIG_DIR` / `CODEX_HOME`) · `other_pc` (an enrolled PC, by `machine_id`) |
| `rotate_agent_keys` | Only offered for `same_user`; default on. Forced on for the other targets, because the secrets cannot reach another user or PC. |
| per agent | `provider` (default from `provider_was`), `model` for that provider, `permissions` (default from `provider_was`; can be lowered, never raised) |

**Issuing keys: `Keys.issueSuccessor(id, machineId)`.** `rotate()` cannot be used: it revokes the old key and its tokens at once, keeps the old `bound_machine_id` and tells the agent to wait for the administrator. The successor instead inserts a new active row with `replaces_credential_id`, binds it to the target in the same transaction (even for slots that had `bound=0`), moves team membership, grants and pending access requests, and sends no notice. The old row stays active, marked `superseded_pending`.

- **Create** at pickup, not at render, so an unrun render changes nothing. A retry before confirm revokes only this checkout's unconfirmed rows.
- **Suspend** the old session tokens at confirm (not revoke), so the source agent stops while the target starts. Cancel or expiry reinstates them.
- **Revoke** the old rows at `restored`.
- **Reuse (same user only).** No key is created and nothing is picked up. The old tokens are ended at render. The connector restores nothing in this case: the console tells the operator to start each agent again in its folder (removing the previous provider's MCP config first if the provider changes), and `checkout_resume` accepts only a login made after render. This is weaker than rotation (both providers share one folder and key), which is why rotation is the default.
- **Provider** has no effect on keys. One session key serves Claude Code or Codex.

## 6. Restore by the connector

The connector on the target PC restores a moved team. The hub does not run a script on the target and the operator
pastes nothing into a model: the console sends the connector a `restore` order (`checkout_id`, `destination_id`, never a
path, [connector.md](connector.md) "PC actions"), and the connector's worker carries it out. The prompt the render
produces still exists for the operator to read and for targets the connector cannot serve (below); it holds hub text (L0)
only, and handout fields appear in a fenced block labelled as data.

**Who can be restored this way**

| Target | How |
|---|---|
| Same user, or an enrolled other PC | The connector there restores it. The PC's user approved a **destination** first (`conclave destinations add <folder>`, or the connector's local screen); the console lists those by label and Restore names one by its id. |
| A new PC | Add PC first (install the connector and pair it), then approve a destination, then Restore. The render says so in plain words (`add_pc_first`). There is no separate script for it. |
| Same PC, other OS user | That user installs and pairs their own connector (Add PC), then the same steps as a new PC. The render says so (`other_user_pairs_first`). |

**The order.** The worker finds the request for the checkout (`GET /onboard/requests`), reads the checkout
(`GET /onboard/requests/:id`) and checks each handout against its render hash, then does the steps below. The order does
**not expire by the clock** while the checkout is `rendered` or `restoring`; it ends when the checkout is cancelled,
replaced or `restored`. After a connector restart the worker finds its state file (`restores/<hub>-<checkout>.json`,
no secrets) and resumes without picking up the keys a second time. Progress notes and the start lines go back with
`POST /connector/v1/orders/:id/progress` and the final result, and show on the Checkout screen and on the connector's
local screen.

1. **Destination.** The id must still be one the PC's user approved here; the folders go under it as `<destination>/<project>/<folder>`. A removed destination fails the order with a plain reason.
2. **Repos, then folders.** One clone of each repo into its `clone_folder` (or a fetch and fast-forward of a clean clone); a Codex agent gets its own clone in its own folder instead, with no worktree, because Codex keeps `.git` read-only outside the folder it runs in (§9 F4). The clone comes from the source F8 picks. Before any folder is built it checks out `integration_branch`, checks that every handout's `integration_head` and `merge_commits` are ancestors of its tip, fetches `checkout/<id>` when a handout records it and checks each `checkout_head` the same way. A missing commit, a head that is not an ancestor, a ref that is not a valid branch name (or starts with `-`), a repo host that is not allowed, or a diverged branch stops the restore before any folder is built. Updates are fast-forward only; every git call passes `--` before refs and paths. A clone excludes only `.mcp.json`, `.claude/settings.local.json`, `.codex/` and the role overlay files (for Codex, `AGENTS.override.md`). Nothing is pushed anywhere.
3. **Config scan.** Before the connector writes anything, it lists tracked agent config in each folder (hooks, `.mcp.json`, `.codex/`, tracked `CLAUDE.md` / `AGENTS.md`, a tracked `.agent-hub.json`, and any such path in the `checkout/<id>` diff; names match in any case) and untracked agent config too. It reports every folder with `POST /onboard/requests/:id/scan` (kinds `hooks`, `mcp_servers`, `claude_config`, `codex_config`, `role_file`, `checkout_diff`). The hub holds `pickup` and `confirm` with `scan_pending` until the administrator decides each folder with findings on the Checkout screen (audited as `checkout.scan_decided`); the order waits and says so.
4. **A changed folder waits for the PC's user.** A folder that already holds agent config of its own is registered with **no trust**: the connector's trust check reports it changed, so nothing is released into it. The PC's user approves it on the connector's local screen ("Approve folder") or with `conclave repair --grant-trust` in that folder. The service never asks and never approves for them; the order shows "Waiting for the PC's user" until they do. A folder without such config is trusted as in onboarding.
5. **Keys and entries, the same as onboarding.** Pickup (`POST /onboard/pickup`) releases each agent's new key once; the connector stores it in its own key file (never in a project file, never printed), then writes per agent:
   - *Claude Code:* `.mcp.json` with the connector entry (`conclave mcp <folder>`), the folder's `.claude/settings.json` (server approved, the connector hook), `.claude/settings.local.json` with `permissions.defaultMode` and the model from render, and the role file: `CLAUDE.md` with the hub playbook where the folder has none and git does not track one, otherwise `CLAUDE.local.md`. Folder trust goes in the config root's `.claude.json` once the hub's confirm says the folder is trusted.
   - *Codex:* `.codex/config.toml` with `[mcp_servers.conclave]` (Node and the connector by absolute path, `startup_timeout_sec = 60`), `model`, and the render's permission level as `approval_policy` and `sandbox_mode`; at the `auto` level the entry also carries `default_tools_approval_mode = "approve"`, because with `approval_policy = "never"` Codex refuses every MCP call otherwise. The role file is **`AGENTS.override.md`**, written by the connector: a marker line first (`<!-- conclave:role-file v1. … -->`), then a short header that tells the agent to read the folder's `AGENTS.md` as well (Codex loads only the override when both exist) and to commit with the `commit` tool of its `conclave` server, then the hub playbook. The connector adds it and `.codex/` to the clone's `.git/info/exclude`, so `git status` never shows them, and records its text so `conclave repair` can put it back. A tracked `AGENTS.md` is left exactly as it is. There is **no `codex-bridge.mjs`**: the connector's own `mcp` command is the server, as in onboarding. The restore is refused, before any key is picked up, where the repo tracks an `AGENTS.override.md`, where the folder holds the old unmarked one from `codex.mjs` ("run `conclave migrate`"), or where it holds one Conclave did not write: restore never overwrites it. `conclave check` reports a role file that is missing, edited or unmarked (`role_file_missing`, `role_file_edited`, `role_file_unmarked`). The folder's binding records `provider: codex`, which gives its `conclave mcp` the local `commit` tool ([connector.md](connector.md#codex-folders)).
6. **Login check and confirm.** The connector logs each agent in once through its own entry (outside the model) and, only for the agents that pass, sends the normal onboarding confirm (`written`, `transport: https`). The checkout is `restoring` and the old sessions are suspended; the connector then ends its cached tokens so the new keys are used at once.
7. **Start lines.** The connector cannot open an interactive session. It prints one line per agent, on the Checkout screen (order result `start_lines`) and on its local screen: `cd <dir> && claude "<resume msg>"` or `codex -C <dir> -a <policy> -s <sandbox> "<resume msg>"`. The resume message: "You are `<label>`, `<role>` of `<team>`. Call `directives_read {unread: true, ack: true}`, then `checkout_resume`, then `session_whoami`, `team_info`, `task_list`, `message_read`, `team_decisions`, `bp_read`, then continue." On-demand wakes need the new local session ids.
8. **Prove.** An agent counts as restored only when `checkout_resume` is accepted (§5); when all have resumed the checkout is `restored`.

The permission table the Codex entries use is the hub's (`codexPermission()` in [fields.ts](../server/src/checkout/fields.ts), with a copy in the connector that a test keeps equal):

| Render level | Codex level | `approval_policy` | `sandbox_mode` |
|---|---|---|---|
| `plan` | ask | `on-request` | `read-only` |
| `default`, `acceptEdits` | standard | `on-request` | `workspace-write` |
| `bypassPermissions` | auto | `never` | `workspace-write` |

No level maps to `danger-full-access`. Render offers `provider: codex` on every hub, and an agent whose `provider_was` is Codex keeps it, with its model, by default.

**The Codex move trial.** The Codex restore was verified with a real Codex on a development hub (§9 F4). The trial used a development-only switch, `CODEX_MOVE_TRIAL=1`, with a console strip and a `checkout.codex_trial` audit event; all three were removed once the second trial passed, and a hub now ignores the variable.

**The old script is gone.** `setup.mjs restore` and its tests were removed; everything in the steps above was ported to the connector and is tested in `deploy/client/connector-restore.test.mjs` and, against the real hub, in `server/test/connector-restore-real.test.ts`. A new PC or another OS user installs the connector first (Add PC).

## 7. MCP tools, admin routes and console

**MCP tools** (agent-facing, L1)

| Tool | Who | Does |
|---|---|---|
| `checkout_status` | team member | Whether a checkout asks for this agent's handout, and what is left: its checkpoint, each leftover exception (waiting, approved, refused with the note; the agent's own text, labelled L2), why the handout is not yet possible, the team's handouts, the next step and the checkpoint steps (L0), the team's integration branch where the hub knows it, the agent's own checkout branch and the repo host allowlist. Read-only, so lockdown allows it. With no open checkout it answers "No checkout for your team". |
| `checkout_progress` | team member, own handout only | Reports `checkpointing`, then `merged` with the integration branch and head, merge commits, `checkout_branch` (`checkout/<id>` or `checkout/<id>-…`, checked; left out means `checkout/<id>`) and `checkout_head` if any, or `no_repo` (a reason of at most 120 characters, in place of the branch, head and merge commits), worktrees left, whether the tree is clean, and `leftover_check`: every kind (`worktrees`, `unmerged_branches`, `uncommitted_files`, `build_output`, `scratch`, `processes`) as `[]` when cleaned up or a list of `{item, reason}` exceptions. A later `merged` replaces the earlier one; an approval carries over only for an identical item and reason. |
| `checkout_handout` | team member, own handout only | Writes or replaces the handout while `collecting`. Takes only `folder`, `repo {remote_name, url, clone_folder}`, `provider_was {provider, model, effort, permissions}` and `notes` (1500 characters), each checked; the hub adds `checkpoint` (from the `merged` report, with `checkout_branch` and `unreviewed` when `checkout_head` is set) and the approved `exceptions`, and records the SHA-256. Refuses `checkpoint_incomplete` (§4), and `repo_host_not_allowed` when `repo.url` names a host off the repo host allowlist (§8, audited as `checkout.repo_host_refused`). |
| `checkout_resume` | the moved agent | Accepted only from a token of `new_credential_id` minted after confirm (or, for reuse, a token minted after render). Checks the render hash, returns the handout once and consumes it (the body is cleared once its vault page is written, §3). Records the client name for audit. The login must come through an app key of the target PC. Refusals are `resume_refused` with a reason (`no_login`, `other_machine`, `not_confirmed`, `old_credential`, `login_before_confirm`, `login_before_render`, `other_credential`), audited. |

The team pause exempts `checkout_*` tools. While a checkout is open, `team_info` carries the checkpoint steps (hub text, L0) after the playbook; the stored playbooks are not changed.

**Admin routes**

| Route | Does |
|---|---|
| `POST /api/teams/:id/checkout` | Start. A refused start is audited as `checkout.start_refused` (see Refused starts below) |
| `GET /api/teams/:id/checkout` | The team's open checkout with its details, or `{checkout: null}` |
| `POST /api/checkouts/:id/proceed` | Go on without the missing handouts: the hub builds them from the slot and the agent row, and the checkout is `ready` |
| `GET /api/checkouts?open=1` | Attention: the open checkouts, oldest first, each with its team, handout counts and `needs_operator`, one item per step that waits on the operator: `leftovers` (per agent, exceptions to approve or refuse), `handouts_missing` (collecting and within 12 hours of expiry: go on or cancel), `handouts_complete` (ready: render), and `prompt_expiring` (rendered and within 12 hours of expiry). Without `open=1`, the latest checkouts in any state, newest first: `limit` sets how many (1 to 200, default 50). |
| `GET /api/checkouts/:id` | State, handouts (bodies visible to the admin until consumed), allowed render options |
| `POST /api/checkouts/:id/render` `{target, machine_id?, rotate_agent_keys, accept_unmerged_work?, agents:{id:{provider,model,permissions}}}` | Creates the checkout request and returns the prompt. A new render revokes everything issued under the previous one. A handout the hub built without a complete checkpoint (`unmerged_work_on_source`, listed in the view, the render answer and the prompt) is left off the push list, and so is an agent that reported `no_repo` (the answer's `nothing_to_merge` lists them with the reason; the prompt names only their ids, since the reason is L2); each other member's checkout branch is pushed as reported; another user or PC is refused with `unmerged_work` unless `accept_unmerged_work` is true. Render first checks the repo host allowlist as it stands now: a handout naming a host the operator has since removed is refused with `repo_host_not_allowed` (`agents`, `hosts`), audited, and nothing is created. |
| `POST /api/checkouts/:id/leftovers/:agent/approve` `{report_sha256, items?: [{kind, item}]}` | Approve an agent's leftover exceptions, all or the named ones; the agent gets a notice. `report_sha256` is the view's hash of the report the operator saw: a report replaced since is refused with `conflict`. |
| `POST /api/checkouts/:id/leftovers/:agent/refuse` `{report_sha256, note, items?: [{kind, item}]}` | Refuse them with a note: the agent cleans up and reports `merged` again; it gets the note as a notice |
| `POST /api/checkouts/:id/scan/:folder` `{decision: approve\|leave_untrusted, findings_sha256}` | Decide a folder's config scan (§6 step 4) while the checkout is `rendered`. Refused with `conflict` when the findings changed since the operator saw them, `invalid_state` for a folder with no findings. The client waiting on the request is woken. |
| `POST /api/checkouts/:id/cancel` | Mark the bodies for the purge, revoke unconfirmed keys, reinstate old sessions, lift the pause (while `restoring`, the pause stays unless `force`) |
| `POST /api/checkouts/:id/finish` | An overdue `restoring` checkout: mark it restored by hand, remove handouts not resumed, lift the pause |
| `GET /api/agents/:id/delegate/preview?user_id=` | The Delegate sheet's preview: per team whether the person's grant keeps team work and the project readable (`teams`, `loses`, `reads_project`), the vault folders still in reach, `contributor`, the repos the person's git login must read, and one plain `sentence` |
| `POST /api/agents/:id/delegate` `{user_id, machine_id, team_id?, drafts_folder?, agents?}` | Delegate one agent (§9.1): a one-agent checkout to an enrolled PC (a PC not yet added is refused with `add_pc_first`). Refused with `only_coordinator`, `no_project`, `checkout_conflict` or `checkout_open`. Returns the delegation (status and step, never the prompt) and the preview |
| `GET /api/delegations?agent_id=` | Standing delegations, newest first, each with its delegate, PC, step and `contributor` |
| `POST /api/delegations/:id/take-back` `{}` | Take back (§9.1): returns `{delegation, new_key_id}`. It takes no options; a PC is never enrolled by a delegation, so there is nothing to retire |
| `GET` / `PUT /api/settings/checkout` `{repo_hosts}` | The repo host allowlist (§8): `{hosts, source, default, max}`, where `source` is `settings`, `env` or `default`. A save takes exact host names (lower-cased, deduplicated, at most 50), refuses wildcards, ports, schemes and a leading `-`, and is audited as `checkout.repo_hosts_set`. An empty list allows no repo URL. |

**What it waits for.** Every checkout view has `waiting_for`: `{on, text, agents}`, one plain sentence for the operator,
or null once the checkout has ended. `on` is `agents` (the handouts not written yet while collecting, or the agents
not resumed while restoring, with their ids in `agents`), `operator` (leftovers to review, or every handout in and the
restore prompt to create) or `target` (the prompt is out and waits to be run on the target). The console shows it as
the first card of the Checkout screen, **Waiting for**, with the agents' names.

**Refused starts.** A refused `POST /api/teams/:id/checkout` or `POST /api/agents/:id/delegate` writes
`checkout.start_refused`, and a refused `PATCH /api/teams/:id` writes `team.update_refused`: who (the console user),
the target, the HTTP status, the error code and message, and the names of the fields sent (never their values). Only a
refusal by the route itself leaves one: a call stopped at sign-in, CSRF or the route's scope writes nothing, so no caller
can fill the trail. A start or change that "never
happened" can then be told apart from one that was refused.

**Delegate routes** (the delegate's own, `self` in the route scope registry; anyone else's delegation is `not_found`): `GET /api/me/delegations` (their Home rows), `POST /api/me/delegations/:id/prompt` (renders now and returns the prompt in this answer only). `GET /api/teams/:id/checkout` adds `delegated`: the team's agents with a delegate, to take back before a team checkout.

Pickup, confirm and status are the existing `/onboard/*` routes; for a checkout request the status adds `checkout` (§6 step 2) and `POST /onboard/requests/:id/scan` takes the scan. `GET /api/checkouts/:id` returns `scans` (per folder: findings, their SHA-256, decision, who decided, `waiting`, `trusted`).

**Console.** A team's *Checkout* screen (`#tco/<team>`, opened from **Check out team** in the team page's menu; [dashboard-ux](dashboard-ux.md) Work workspace): checkpoint and handout state per agent (`checkpointing`, `merged`, `written`, with unreviewed commits on the agent's checkout branch marked, and "Nothing to merge" with the reason for an agent that reported `no_repo`), leftover exceptions approved or refused per item with a note, **Go on without missing handouts**, the render form (refused choices disabled with the reason, permission mapping shown), the prompt with copy and expiry (held in the page only), the new-PC approval with name and IP, the push list, the config scan per folder (findings escaped and labelled as reported by the target, **Approve** with a confirm sheet or **Leave untrusted**; decided scans stay visible while restoring and after), and live progress; Finish and Cancel confirm first. A render refused with `restore_unavailable` says the hub's restore client files are missing. While a checkout holds the team, the team page shows "Paused for checkout" and a card leading to the screen. Home's urgent list (Attention) shows one row per `needs_operator` step, each opening `#tco/<team>`; a held team with no such step keeps one "Paused for checkout" row. The `checkout_overdue` alert names its team (`team_id`) and its action is **Open checkout**. **Settings → Checkout** (the Settings sheet on the PCs header) edits the repo host allowlist. The panel follows [design-guidelines](design-guidelines.md).

## 8. Threat-model and authorization deltas

- **Repo content can run code on the target** (hooks, MCP servers, role text). Unapproved work stays off the integration branch (F7); the restore scans tracked config and the `checkout/<id>` diff and withholds trust until the operator approves; the playbook comes only from the hub; refs are validated and git gets `--`.
- **The checkpoint is self-reported.** The hub cannot see the source tree. The restore checks every recorded commit, and a checkout never deletes source folders, so work left unmerged can still be recovered there.
- **The config scan is self-reported.** The hub takes the target client's findings as sent (§6 step 4). This is accepted: a modified client harms only its own PC, and every key stays held until each folder has a scan and none waits. A restored checkout skips the scan check at pickup.
- **Repo content never passes through the hub** (F8). The operator pushes, from the render's push list; agents never push.
- **Unreviewed work is labelled, never landed.** The checkpoint lands only approved work on the integration branch. The rest sits on each member's `checkout/<id>-<member>`, named as not approved in the handout, the push list and the console, and still goes through review before it lands.
- **The prompt reaches secrets.** For an existing PC it holds no credential. A new PC gets no code: it is added with the connector first.
- **The old session must not finish the move.** `checkout_resume` requires a login through an app key of the target PC, and, since same-PC moves share a `machine_id`, the new credential too. A same-user move that keeps keys has nothing to tell the two sessions apart: render ends the old logins, and a source session that logs in again after render could still resume. That is part of the operator's explicit exception.
- **Handout text is L2 inside an operator-authority prompt.** Fields are typed (folders, users and hosts start with a letter or digit, never `-` or `.`), `notes` reach only the resuming agent with their L2 label, and handouts are locked and hash-checked after review. Leftover items and reasons are made one line and shown in `checkout_status` JSON-quoted under an L2 label, apart from the L0 steps.
- **Repo host allowlist.** A handout's `repo.url` must name a host on the allowlist. The match is the exact host, case-insensitive, in the https, ssh and scp-like forms alike. The host is read after any `user@`, so `https://github.com@evil.example/x` is `evil.example`. There are no wildcards, and a host starting with `-` never matches. Entries are exact host names, and bare IPs and single labels such as `localhost` are accepted on purpose, for git hosts on the LAN. The list lives in system settings (`checkout.repo_hosts`), seeded from `CONCLAVE_REPO_HOSTS` (comma-separated) and otherwise `["github.com"]`; the operator edits it in Settings → Checkout. It is checked at `checkout_handout`, again at the top of render and again at pickup, so removing a host also stops a checkout whose handouts are already written or rendered. Refusals are audited as `checkout.repo_host_refused`.
- **Two copies of one agent.** Old tokens are suspended at confirm and keys revoked at restore; same-user reuse is the operator's explicit exception.
- **Delegating one agent** lends an agent's key to another person's PC. See the threat model row; the controls are in §9.1. The prompt is shown only in the delegate's own console, the PC is already enrolled, the delegate's grant is a ceiling while delegated, and Take back revokes at once.
- **Authorization.** Only the admin starts, renders, approves and cancels (a checkout creates keys), and only the admin delegates and takes back. An agent writes only its own handout. Grants and ceilings never widen. Console members (multi-user) never see a checkout, apart from their own delegation rows (§9.1): every checkout route is admin-only in the route scope registry (`server/src/admin/scopes.ts`), and a member's team view withholds a checkout pause reason.

## 9. Design choices

Each choice is named F1 to F8 where the sections above refer to it.

- **F1 Unit of checkout: a whole team, or one agent.** A one-agent checkout marks only that agent away (`team_members.away_until`) from `ready` until it resumes; the lease, stall and overdue sweeps skip it, its reviews go to a replacement reviewer and otherwise wait, and the rest of the team keeps working. A team's only coordinator cannot be checked out alone. A team checkout reuses the team pause as it is.
- **F2 A handout counts as used at an accepted `checkout_resume`.** Marking it used at render or pickup loses the handout on a failed restore, and a first login proves keys, not that the agent read its notes.
- **F3 Old sessions and keys.** Old tokens are suspended at confirm and the old keys revoked at restore. Revoking at pickup leaves nothing running if the target fails; leaving them leaves two live copies. This needs `issueSuccessor` and a suspended token state.
- **F4 Codex identity and repository access.** Each agent has a project-level `<folder>/.codex/config.toml` that starts the connector's MCP server for that folder. The user opens Codex in a trusted project. Each restored agent works in its own repository clone and gets a local `AGENTS.override.md` with its team instructions. The override tells the agent to read the repository's `AGENTS.md`, which the restore preserves. The checkout scan reports tracked agent configuration for approval.
  - **Git.** Codex's workspace sandbox keeps `.git` read-only. The connector's `commit` tool records explicitly named files on the agent's own local branch. It leaves hooks and remote branches untouched. See [Codex folders](connector.md#codex-folders).
  - **Verification.** A two-agent Windows trial with Codex CLI 0.167 on a local development hub checked identity, team instructions, checkout acknowledgment, a task handoff, and a commit through the connector. It also verified that the previous credentials were revoked and the tracked `AGENTS.md` and Git hook files were unchanged. An earlier trial reproduced the sandbox restriction with a shared clone outside the agent's folder. The 0.9.7 commit trial (21 November 2026, Codex CLI 0.166.0-alpha.6, workspace-write sandbox, a development hub from the release branch) checked the `commit` tool: the agent's own `git add` and `git commit` were refused (`.git` is read-only in the sandbox), `commit` committed the named file on a new branch as the agent's own label with nothing pushed, an ignored `.env` was refused, `.git/hooks` was unchanged and its hook never ran, and `git status` showed no role file. It found and fixed one fault: the turn token named the agent by its key's label (such as "(onboarded)"), so the author would have been that. The installed 0.167.0-alpha.3.2 copy could not run any tool on this PC (its code-mode host is not installed), so it was not used.

- **F5 In-flight tasks: pause the team at `ready`** with the existing team pause (`tick()` already skips leases and overdue checks). Releasing held tasks at start throws away claimed work; doing nothing lets tasks reopen mid-move. Pausing at `ready`, not at start, lets agents finish their checkpoint and handouts.
- **F6 Reusing agent keys on the same user is offered; rotation is the default.** Within one OS user the keys are already readable by both providers. Only rotation lets the hub tell old from new.
- **F7 Work not yet approved at the checkpoint merges into the member's own checkout branch `checkout/<id>-<member>`,** cut from the integration tip; the task stays open and lands under the normal rules after the restore. Merging it into the integration branch would put unreviewed code on the branch the team trusts; having the coordinator land everything bypasses review the same way and serialises the team on one agent. Each member resolves conflicts on their own branch. The report names the branch (`checkout_branch`, which must start with `checkout/<id>`); a report without it means `checkout/<id>`, which the hub accepts for compatibility. After the restore each open task's review covers its own merge commit on its checkout branch, then it lands as usual.
- **F8 How the commits reach the target: the operator pushes** the integration branch (and every reported checkout branch) to the repo's shared remote before running the prompt; render lists the branches and heads. Agents never push. A `same_user` move needs no push: the clone is already there and the restore only checks heads. "Reachable from the target" means every recorded commit is on the remote the handout names, which the restore checks before it builds anything (§6 step 3). A hub-held git bundle is rejected: it puts repo content on the hub and adds a large upload path to secure. Cloning from the source folder crosses OS-user file permissions, so the push serves `same_pc_other_user` too. A repo with no remote moves only to `same_user`; render refuses other targets with `repo_no_remote`.

### 9.1 Delegate one agent

The admin lends one agent to a collaborator: **Delegate** on the agent's page, a person and a PC, and the person runs one prompt from their own Home. The agent keeps its identity, owner, team, tasks and history. **Take back** ends it.

- **Who.** Only the admin delegates and takes back. The delegate is a console member, a colleague or an external partner, or the admin (**Delegate back**, which ends the delegation once it restores). The target is an ordinary PC from the admin's list, already enrolled. No PC belongs to a member.
- **Refused.** A team's only coordinator (`only_coordinator`); a person whose grant leaves the agent no project to read (`no_project`); an agent with an open checkout (`checkout_open`); a team with an open team checkout (`checkout_conflict`). A team checkout is refused the same way while any of its agents is delegated, listing them ("take back first").
- **The sheet** shows what the agent loses with this person ("While with Lena, Rowan can't reach team ECHO or edit shared items"), the repo the person's git login must read, and, optionally, a **drafts folder**: the admin's explicit folder grant for the delegate, Contribute on that folder only (for example `/Papers/P1/contrib/Rowan/`), removed when the delegation ends. An implementation project has no paper folder, so its delegated agents usually get none and write nothing in the vault.
- **The prompt** is shown only in the delegate's own console, behind their sign-in and 2FA, never on the admin's sheet. The hub renders the move when they open it. They may open it again until the restore has picked up the key (`prompt_in_use`).
- **Away.** From `ready` until it resumes, the agent is away (F1): no new assignment, no claim, the sweeps skip it, its reviews go to a replacement reviewer or wait. Its source session keeps its key until the confirm on the new PC.
- **While delegated** (from the confirm until Take back) the delegate's grant is a ceiling on the agent and it works in contributor mode ([authorization](authorization.md#owner-enforcement), [blueprint §4](blueprint.md)). The successor key is bound to the delegate's PC.
- **Take back** revokes the key the agent runs with and its tokens at once (a rotation; the new key is bound to the source PC and reaches it by [key handover](onboarding.md#key-handover-a-rotated-key-or-a-recruit-reaches-a-connector-pc)), ends the ceiling and contributor mode, and removes the drafts grant. **Also retire the PC** is on by default when this delegation enrolled the PC and no other agent's key is bound to it; it revokes the PC's app key too. Work left on the delegate's PC is not recovered: Delegate back, with a checkpoint first, is the way to bring it home. The delegate's Home row reads "the operator took Rowan back" for a week.
- **Restore.** The connector takes the one-agent request unchanged; it restores only that agent and says for whom.
- **Audit.** `checkout.delegate` (agent, delegate, PC, what it loses, the drafts folder), `checkout.prompt_opened`, `checkout.pc_confirmed` or `checkout.pc_refused`, the ceiling (shown in the inspector as `basis: delegate`), `checkout.drafts_removed` and `checkout.take_back` (the revoked and replacement credentials, the retired PC).
