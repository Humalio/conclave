# Conclave connector

The connector runs on the computer where your agents work. It connects their coding clients to the hub, transfers files from approved folders, and can start a background turn for an agent when you enable wake.

- [Install and pair the connector](onboarding.md#with-the-conclave-connector)
- [Check a connection](#when-something-is-wrong)
- [Understand agent wake](#the-wake)
- [Move an existing installation](#moving-an-old-pc-conclave-migrate)
- [Disconnect or uninstall](#uninstall-and-disconnect)

## Hub API reference

These routes exchange status, setup progress, and action requests between the hub and the connector. The console displays the reported state.

**One rule for every value.** A value the connector has not reported reads **Unknown** (`null` in the API), never a
guess. The hub never runs anything on a PC by itself: a PC action is stored as an order, and the connector fetches it on
its pinned poll.

**Text from the PC is untrusted.** Everything the connector sends is agent-side text (L2): a check's `detail`, a failed
order's `reason`, a disconnect's `left` sentences and any other `result`. The hub runs the leak guard on it before
storing it: a Conclave key shape is refused (`contains_key`) and raises a `connector_key_in_report` alert; other secrets
are redacted, as for reviews. The console shows it as plain text only, never as Markdown or a link.

### Who calls what

| Caller | Authenticates with | Routes |
|---|---|---|
| The console (admin) | console session with CSRF, scope `admin` in `scopes.ts` | PCs: `/api/pcs/:id/setup-timeline`, `/api/pcs/:id/actions`, `/api/pcs/:id/disconnect`, `/api/pcs/:id/suspend` and `/reactivate`, `/api/pcs/:id/usage`, and `/api/connector/versions…`. Agents on a PC: `/api/agents/:id/message-states`, `/api/agents/:id/context`, `/api/agents/:id/reset`, `/api/agents/:id/usage`; per team, `/api/teams/:id/context` and `/api/teams/:id/usage`. None is open to a member. |
| The connector | the PC's app key (`Authorization: Bearer ah_app_…`) | every other `/connector/v1/…` route: `check-in`, `orders` (with `/:id/result` and `/:id/progress`), `stream`, `versions/approved`, `setup`, `messages/unread`, `messages/shown`, `usage`, and `hardware` (compute machines only) |
| The connector, before it has an app key | the pairing code, once | `GET /connector/v1/hub`, `POST /connector/v1/pair` (served; see "Pairing") |
| The connector, during the transition | the PC's bridge key (`ah_brg_…`) | `POST /connector/v1/check-in` only, besides the bridge's own transfer routes. Never orders, versions, messages, usage or the disconnect receipt. |
| The connector, disconnect only | the disconnect order's receipt credential (`Authorization: Bearer ah_dsc_…`) | `/connector/v1/disconnect`, `/connector/v1/disconnect/result` |

The app key is the installation's identity: it reports, polls and fetches orders, and never acts as an agent. A suspended
PC's key is refused on every `/connector/v1/` route with 401. The one exception is the PC's own app key while its
disconnect order is open (below).

**The bridge key ends.** It is accepted for check-in only until the pairing route is in force; the hub release that turns
on `POST /connector/v1/pair` (with connector 1.0.0) refuses it on `/connector/v1/`. Disconnect and Re-enrol PC revoke it
with the app key.

## The connector's report

`POST /connector/v1/check-in` (app key, or bridge key during the transition), about once a minute, and at once after a
start, an update or a check:
```
{ "version": "1.4.0", "platform": "win32-x64",
  "node": "22.11.0" | null, "git": "2.47.1" | null,
  "clients": [{ "client": "claude_code" | "claude_desktop" | "codex", "version": "2.0.31" | null }],
  "auto_update": true | false | null,       // the PC user's local switch
  "remote_cleanup": true | false | null,    // the PC user's local switch: false means Disconnect only revokes access
  "remove_connector_with_last_hub": true | false | null,
  "usage_opt_in": true | false | null,     // the PC user's local switch for usage reports
  "hardware_opt_in": true | false | null,  // on a compute machine: the user's switch for measuring (conclave hardware on|off)
  "agents": [{ "agent_id": "agent-…", "state": "open" | "repair_connection" | "chat_in_use",
               "profile"?: "work", "profile_hidden"?: true }],  // a run on an account profile: its name, or only that it is hidden
  "destinations": [{ "id": "dst_…", "label": "Projects on D:" }],  // restore destinations the PC's user approved there
  "legacy_leftover_kinds": ["unfinished_move" | "ca_setting" | "old_keys" | "bridge_pieces"],  // which pieces (fixed words, never a path)
  "legacy_leftovers": true | false,  // the old setup's pieces are still on the PC (see "Old setup left on the PC")
  "context": [{ "agent_id": "agent-…", "source": "connector" | "chat", "client": "claude_code" | "codex", "model": "claude-sonnet-4-5-…",
    "context_tokens": 62000, "window": 200000 | null, "percent": 31 | null, "turn_tokens": 120000,
    "compacted_at": 1763… | null, "compacts": 0, "at": 1763… | null }] }   // only while usage_opt_in is true; see Context size
```
Answer: `{ "ok": true, "orders": n, "handovers": n, "ignored_agents": n, "measure_only"?: true }` (`measure_only` only for a PC with a
compute role, see [Measure-only mode](#measure-only-mode)), where `orders` is the number of orders waiting (fetched with
`GET /connector/v1/orders`) and `handovers` the number of [key handovers](#receiving-a-rotated-key-or-a-recruit) open for this app key.

Every field is checked: a version is `^\d+\.\d+\.\d+(-[a-z0-9.]+)?$` and at most 40 characters; an unknown key, client
or state is refused with `invalid_argument`. The PC reports only what it sees for its own agents: an `agent_id` whose
session key is not bound to this PC is dropped and counted in `ignored_agents`. Waiting for approval and Ready to open are
the hub's states and cannot be reported. The hub stores the latest report per PC and the time of the first and the
latest check-in.

**Restore destinations.** `destinations` lists the places on the PC where its user approved restores, at most 20, each
an id (`dst_` and 6 to 32 lowercase letters or digits, unique) and a plain label of at most 80 characters. It never
holds a path: the connector keeps each destination's folder, identity and agent config in its own record, and the
label is display text that passes the leak guard. A check-in without `destinations` makes them Unknown again (`null`).

**Which old pieces.** `legacy_leftover_kinds` says which kind of the old setup is left, so the console can say what to clean: `unfinished_move` (rollback copies kept, or an interrupted move), `ca_setting` (the old CA environment setting), `old_keys` (the old setup's key file) and `bridge_pieces` (the old bridge and helper files in the connector folder). Fixed words only, at most four, never a path; `legacy_leftovers` is `true` exactly when the list is not empty. The PC page names them next to "Left on this PC".

**The transfer loop reports the connector's version.** The file transfers run inside the connector and poll the hub's `/bridge` relay with the connector's own version; the PC page therefore shows no "bridge" version for a PC that has a connector (the Connector card has it), and "bridge x.y.z" only for a PC that has no connector yet.

**Old setup left on the PC.** `legacy_leftovers` is one yes or no: `true` while the PC still holds pieces of the old setup that `conclave migrate --finish --remove-legacy-ca` clears, `false` when it holds none, absent (Unknown, `null`) from a connector that does not report it. It is `true` while a move to the connector is not finished (the rollback copies are kept until `--finish`, or an interrupted move waits) and while the user's `NODE_EXTRA_CA_CERTS` still names this connector home's `hub-ca.pem` and that file is the CA the move pinned (a variable that `--remove-legacy-ca` would leave is not reported, so the flag never repeats with nothing to clear). The console does not say which; the PC's `conclave check` does. The flag never carries a path, a folder or a name (a path or a list is refused with 400); the connector reads it at most once a minute. `conclave check` says the same in words, as a `tip` line after the checks that passed, and offers the command: it never runs it and the check still passes. The console lists the PCs with leftovers (the PCs page filter **Old setup left**, a flag on the row, and the **Old setup** row of the PC's Connector card).

**Online** means a check-in within the last 90 seconds; otherwise the PC is **Offline since** its latest check-in, or
**Never connected** when there is none. This is the PC's state only: agents have no Online or Offline.

## PC status (console)

`GET /api/pcs` gives each PC a `connector` object:
```
{ "online": bool, "status": "online" | "offline" | "never" | "suspended" | "disconnected",
  "first_check_in_at", "last_check_in_at",
  "version", "platform", "node", "git", "clients": [...],
  "auto_update", "remote_cleanup", "remove_connector_with_last_hub", "usage_opt_in", "hardware_opt_in",
  "destinations": [{ id, label }] | null,
  "legacy_leftovers": bool | null,
  "version_status": "approved" | "pending" | "refused" | null,     // of the version it runs
  "update_available": "1.5.0" | null }                            // the newest approved version above it
```
Each field is `null` until reported. `status` is `disconnected` while the PC has a disconnect that Re-enrol PC has not
ended, `suspended` when the PC is suspended otherwise (**Suspend access**), and only then online, offline or never. The
console never shows "Offline since" for a suspended or disconnected PC.

## Agents on the PC and the setup timeline

`GET /api/pcs/:id/setup-timeline` returns the PC's steps and, per agent, one state:
```
{ "steps": [{ "step": "added" | "paired" | "request_filed" | "approved" | "keys_collected" | "agents_connected",
              "state": "done" | "waiting" | "failed" | "not_yet", "at": ms | null,
              "reason": "plain sentence" | null,
              "next": { "action": "plain sentence", "who": "you" | "pc_user" | "agent" } | null }],
  "agents": [{ "agent_id" | null, "label", "team_id", "state": "waiting_for_approval" | "ready_to_open" | "connected" | "key_refused",
               "next": { "action", "who" } | null,
               "connected_at": ms | null, "last_active_at": ms | null,
               "pc_reported": "open" | "repair_connection" | "chat_in_use" | null }] }
```
The agent states (review v2 §3, and Key refused):
- **Waiting for approval:** the agent is in a team request the operator has not approved (it has no agent id yet).
- **Ready to open:** approved, and it has made no call of its own yet. While its keys are not collected on the PC, its
  next action is "Continue setup on the PC" (the PC's user); once they are, "Open the agent on the PC".
- **Connected:** its first authenticated call from its own client (`agents.connected_at`). A setup login or a check-in does
  not count. **Last active** is its latest call.
- **Key refused:** its keys were collected, and the hub accepts none of its session keys any more (revoked or suspended).
  It is never shown as Connected, the `agents_connected` step fails with "The hub no longer accepts the key of …", and the
  next action is yours: give the agent a new key. The connector's screen and `conclave setup status` say **Key refused by
  the hub**; when the hub refuses the PC's own app key, `setup status` says so and shows no agent as Connected.

Each step that waits or failed has one next action and names who takes it. For example: "Enter the pairing code on the
PC" (the PC's user), "Approve the team request" (you), "Open the agent on the PC" (the PC's user).

## PC actions

The fixed list of what an administrator may ask a PC to do: `check`, `restore`, `update`, `disconnect`. The fifth kind, `deliver`, is the hub's own ([Delivery orders](#delivery-orders)): `POST /api/pcs/:id/actions` refuses it, and Reset is the one console route that makes one. Each administrator action is admin-only,
audited (`pc.action_create`, `pc.action_report`), and carries typed data only: never a path or a command.

| Route (console) | Does |
|---|---|
| `GET /api/pcs/:id/actions` | The PC's orders, newest first |
| `POST /api/pcs/:id/actions` `{kind: "check"}` | Check this PC |
| `POST /api/pcs/:id/actions` `{kind: "restore", checkout_id, destination_id}` | Restore, only while that checkout is `rendered` and targets this PC, and only to a destination its user approved there (the latest check-in's `destinations`); anything else is refused with `invalid_state`. The order carries the two ids, never a path. |
| `POST /api/pcs/:id/actions` `{kind: "update", version}` | Update to an approved version above the one the PC runs; a lower or equal version is refused with `invalid_argument` (no downgrades) |
| `POST /api/pcs/:id/disconnect` | Disconnect this hub from this PC (below) |
| `POST /api/agents/:id/reset` | Reset an agent's context: a `deliver` order with `reason: "reset"` to the PC that runs it ([Reset](#reset)) |
| `POST /api/pcs/:id/suspend`, `/reactivate` | **Suspend access** and its undo (existing routes, renamed in the console). Reactivate is refused with `invalid_state` while the PC has a disconnect that Re-enrol PC has not ended |

An order: `{ id, kind, state, payload, created_at, created_by, fetched_at, finished_at, result }`. Its `state` is
`queued`, then `fetched` once the connector took it, then `done` or `failed`. One open order per kind and PC: a second is
refused with `conflict`. An order not fetched in 24 hours becomes `expired`, and so does an order the connector fetched but
did not report within 24 hours of `fetched_at` (its `result.reason` says so), so a lost order never blocks its kind for good.

**What the connector does with them** (its side, for the contract):
- **Check this PC** runs the same bounded, read-only status as the local Check connection, and reports it as the rows
  above: keys are named by their id, never their value (a row that holds a key is refused, `contains_key`).
- **Restore** runs checkout's §6 from the validated handouts into the approved destination: the config scan, the host
  and ref checks and the no-push rule stay, and it asks the PC's user again before trusting a folder whose identity or
  agent config changed since they approved it.
- **Notifications on the PC** (a setup step to take, an action the PC's user must confirm) are in fixed words built
  by the connector from hub ids and counts, never text from the hub, an agent or a message.

| Route (connector, app key only) | Does |
|---|---|
| `GET /connector/v1/orders` | The PC's queued orders; each moves to `fetched`. With `?wait=N` (at most 25) the hub holds the answer until an order is queued: the [long poll](#the-push-stream) |
| `GET /connector/v1/stream?installation=…` | The [push stream](#the-push-stream): Server-Sent Events that only say "orders waiting" |
| `POST /connector/v1/orders/:id/result` `{state: "done" \| "failed", result}` | Reports the outcome, once. Only for an order of this PC in state `fetched`: another PC's order, or one already reported, answers `not_found` (the connector then drops the result from its outbox). The order is looked up by id and PC, however many newer orders the PC has. For `check`, `result` is `{checks: [{name, ok, detail}]}`, at most 40 rows of 200 characters; for a failure, `{reason}`. Both pass the leak guard. |

### Disconnect this hub from this PC

**Disconnect this hub from this PC** (admin) stops that hub's access for the installation at once. The installation then fetches one expiring disconnect order with a credential that can do nothing else. It stops that hub's work, removes that hub's keys and entries, keeps a journal so an interrupted cleanup resumes, and reports back; the console shows **Access revoked**, **Cleanup pending**, **Removed** or **Needs attention**. The connector itself is removed only when no hub remains and the PC's user chose that. The PC's user can turn remote disk cleanup off, and then the order only revokes access.

Uninstall removes what the connector created or changed, and nothing else. A shared setting is restored only while it still holds the value the connector installed. An edited file, a conflict or an entry of unclear ownership is kept and listed. Repositories, worktrees, chat history and the user's own settings are always kept.

`POST /api/pcs/:id/disconnect` `{}`. At once, on the hub: the PC is suspended (its app keys, its bridge key and its
agents' session keys bound to it stop working) and the hub stores one disconnect order. The PC keeps the existing status
`suspended`; the disconnect itself lives only on the order. The response lists what the order removes and keeps:
```
{ "disconnect": { "state": "access_revoked", "created_at", "expires_at",
  "removes": ["This hub's worker and transfers, stopped first", "This hub's keys on the PC",
              "This hub's folder registrations", "The connector's files for this hub"],
  "keeps": ["Repositories and worktrees", "Chat history", "The PC user's own settings", "Other hubs on the PC"],
  "remote_cleanup": true | false | null } }
```
States, in the console's words:
- **Access revoked** (`access_revoked`): the hub refuses the PC; the order waits for the connector.
- **Cleanup pending** (`cleanup_pending`): the connector fetched the order and is cleaning up.
- **Removed** (`removed`): the connector reported the cleanup done.
- **Needs attention** (`needs_attention`): the connector reported a failure, or nothing was fetched before `expires_at`
  (7 days). The detail says what is left.

When the PC's user turned remote cleanup off, the connector still fetches the order and reports `cleanup_off`; the order
then stays at **Access revoked**, and the console says "Cleanup turned off on the PC" instead of waiting 7 days.

**After a disconnect only Re-enrol PC brings the PC back.** Reactivate is refused (above). Re-enrol PC ends the
disconnect: it retires the receipt, revokes the old keys and the bridge key, makes the PC active again and issues a new
code, as Re-enrol PC does today. It makes the PC active even if it was already suspended before the disconnect: Re-enrol
is a deliberate act, so suspend the PC again afterwards if it should stay off.

**The receipt credential** (`ah_dsc_…`) is a key, under the same rules as the others in authorization.md:
- It is stored as a verifier only (an HMAC with the hub's pepper), never in clear.
- It is handed out only as the answer to the PC's own app key while the order is open: that key gets 401
  `{error: "disconnected", receipt, disconnect_url}` and nothing else. Each hand-out replaces the last, so a lost answer is
  recovered by calling again. Never in a console answer, the `disconnect` object, the audit or a log.
- Once a result is reported or the order expired, no new receipt is handed out: the app key gets a plain 401.
- It is retired after the result, at `expires_at` and on Re-enrol PC.
- The leak guard knows the `ah_dsc_` shape, like `ah_app_`, `ah_ses_`, `ah_set_`, `ah_brg_` and `ah_tok_`.

| Route (receipt credential) | Does |
|---|---|
| `GET /connector/v1/disconnect` | The order; the state moves to `cleanup_pending` |
| `POST /connector/v1/disconnect/result` `{state: "removed" \| "needs_attention" \| "cleanup_off", left?: [plain sentences, at most 20]}` | Reports the outcome, once; the `left` sentences pass the leak guard |

`GET /api/pcs` carries `disconnect` for each PC (the latest order without its receipt, or `null`).

## Connector versions

An admin (the operator) approves each connector version once. A version is known to the hub when a PC reports it or when it is added by
hand.

| Route | Does |
|---|---|
| `GET /api/connector/versions` | `{versions: [{version, status: "pending" \| "approved" \| "refused", first_seen_at, first_seen_pc, decided_at, decided_by, pcs}]}`, newest first; `pcs` counts the PCs that run it |
| `POST /api/connector/versions` `{version}` | Adds a version by hand (pending) |
| `POST /api/connector/versions/:version/approve`, `/refuse` | Decides it; audited `connector.version_approve`, `…_refuse` |
| `GET /connector/v1/versions/approved` (app key) | The approved versions, for the connector's update check |

A reported version becomes pending only when it is well formed, above the newest approved version, and fewer than 5
versions are pending; otherwise the report is stored and no entry is made. A pending version raises one
`connector_version_pending` alert (info) until it is decided.

## Messages: delivery states

For the messages an agent receives, the console shows one state per message:
- **Not delivered yet:** no session of the agent has fetched it (`message_delivery_cursors.delivered_seq` below it);
- **Delivered:** a session fetched it;
- **Shown to the session:** the PC reported that the reminder line showed it to the agent's session. The console says
  "reported by the PC";
- **Read:** the agent confirmed it (`acked_seq`).

`POST /connector/v1/messages/shown` (app key) `{agent_id, room_id, seq}`: the highest message the reminder line showed,
for an agent whose session key is bound to this PC and who is in that conversation; any other is `not_found`.
`POST /connector/v1/messages/unread` (app key) `{agent_id}` gives the counts the reminder line is built from ([below](#the-one-reminder-line)).
`GET /api/agents/:id/message-states?room_id=` returns
`{states: [{room_id, last_seq, delivered_seq, shown_seq, shown_reported_at, acked_seq}]}`.

`GET /api/conversations/:roomId/delivery` (admin only) returns `{last_seq, members: [{agent_id, label, delivered_seq, shown_seq, shown_reported_at, acked_seq}]}`:
the positions of each agent in the conversation. The room works out each message from them: a message is **Read** when
`acked_seq` has reached it, else **Shown to the session (reported by the PC)** when `shown_seq` has, else **Delivered**
when `delivered_seq` has, else **Not delivered yet**. `shown_seq` is `null` (Unknown) until a PC reports, and an Unknown
is never counted as shown. The sender and hub notices are left out.

**The shown report is the PC's word.** A PC can say a message was shown and the session never saw it, so the console says
"reported by the PC" and the hub never treats Shown as Read: only the agent's own acknowledgement (`acked_seq`) is Read.
The report carries a position only, never message text, and only for an agent whose key is bound to that PC.

## Measure-only mode

A PC with a compute role ([Hardware](hardware.md#measuring)) runs the connector only to measure itself. The check-in
answer says `measure_only: true`, and then:

- **Orders.** The hub refuses every PC action but `update` for it with `invalid_state` ("its connector only measures it");
  Disconnect works as for any PC. The connector also refuses `check` and `restore` from that hub with a fixed reason.
- **Opt-in.** `conclave hardware on|off` (also `conclave settings hardware on|off`) sets `hardware_opt_in` in
  `preferences.json`; `conclave hardware` shows it. Never set reads as off: nothing is measured.
- **Samples.** While opted in, the worker samples the whole machine every 15 seconds (CPU % from the CPU times since the
  last sample, memory from the OS, GPUs from `nvidia-smi` when present, asked once and not again when missing) and
  sends each measure-only hub its samples after each check-in: `POST /connector/v1/hardware` with the app key,
  `{samples: [...]}`, numbers only. Samples a hub could not take because it was unreachable are kept for the next
  check-in, the newest 120. Turning measuring off drops the waiting samples.

## Usage and cost (admin only)

`POST /connector/v1/usage` (app key) `{day: "2026-11-19", rows: [{agent_id, client, model, input_tokens, output_tokens,
cache_read_tokens, cache_write_tokens, sessions, turns?}]}`: aggregate numbers only, from the connector's registered worker
sessions, and only when the PC's user opted in (`usage_opt_in` in the latest check-in; otherwise refused with
`invalid_state`). Only agents whose session key is bound to this PC: any other row is refused with `invalid_argument`.
A repeated day replaces that day's rows; rows for the same agent, client and model in one report are summed. `turns` is
optional: a row without it is stored as Unknown (null), never 0, and any total that includes such a row reads Unknown.
Turning the switch off stops new reports; how long the hub keeps what was
already sent is a separate retention rule: 400 days by the day the row describes (`retention.usage_days` in settings, or
`RETENTION_USAGE_DAYS`), the same whether the PC's user later turns reports off or not (review v2 §14).

`GET /api/pcs/:id/usage?days=30` (admin only, never for a member): `{opted_in: bool | null, days: [...], total:
{input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, turns, cost_usd}, priced_at: "API list prices"}`. The cost is computed by the hub from a list-price
table in its config (`connectorPrices`, per million tokens), labelled "at API list prices" wherever it shows; a model with no
list price has `cost_usd: null`, and so does the total.

`GET /api/agents/:id/usage?days=30` and `GET /api/teams/:id/usage?days=30` (admin only, never for a member):
`{reported: bool, total: {…as above}, by: [...], priced_at: "API list prices"}`. An agent's usage is summed over every
PC that reported it, with one line per PC in `by` (`pc_id`, `pc_name` and the totals). A team's is summed over its
current members, with one line per agent (`agent_id` and the totals), whatever team the work was for: the connector
reports per agent, not per team. `reported` is false while no PC sent anything for them in the window; the console
then reads Unknown, not zero. `days` is 1 to 90.

## Add PC: download and pairing

`POST /api/pcs/add` answers the PC, its key and the code, and:
```
{ "download_url": "https://github.com/…/releases/latest" | null,
  "connector_version": "0.9.5" | null,
  "pairing": { "code", "code_expires_at": ms, "ca_check": "ab12 cd34 ef56 7890", "hub_origin" } | null,
  "connector_prompt": "…" | null,
  "connector_unavailable": "no_ca" | "no_origin" | null }
```
`connector_prompt` is the hub's one prompt ([onboarding.md](onboarding.md#the-prompt)): the same text for every PC, with no code and no PC name in it; the console shows the code apart from it. There is no other prompt. When it is
`null`, `connector_unavailable` says why (no CA certificate, or no HTTPS public address) and the console says so too.
The download link is the GitHub Releases page set in the hub's config (`CONNECTOR_RELEASE_URL`, https only); `null` when
it is not set. `connector_version` is the newest version the operator approved (Connector versions), so the console
names the installer to run, `node conclave-install-<version>.mjs`; it is `null` while none is approved, and the console
then says `conclave-install-<version>.mjs`. The code is in this answer once and is never written to the audit or a log; **New code**
(`POST /api/pcs/:id/prompt`, before the PC has paired) voids the old one, and Re-enrol PC (`POST /api/pcs/:id/re-enrol`) makes a new app key and code.

**Pairing.** The agent on the PC asks its user for the code and passes it to the installer on standard input (`--pair -`), never as an argument or in a file ([onboarding.md](onboarding.md#the-code)). Add PC, New code and Re-enrol PC answer `pairing: {code, code_expires_at, ca_check, hub_origin}` next to `code`. `POST /connector/v1/pair` answers `code_kind`: `pc` for a code from Add PC, `invite` for a [collaborator invite](onboarding.md#an-invite-for-a-collaborator), with `invite: {id, project, team, role}`. After pairing, `GET /onboard/choices` (app key) lists the projects, their teams and roles for a code from Add PC, and only the invite for an invite; `POST /onboard/invites/:id/redeem` joins the invite's team. The code is the same single code: `/onboard/enrol` (`setup.mjs`) keeps today's rules, and `/connector/v1/pair` adds the 30 minutes and the binding below. `pairing` is `null` when the hub serves no CA (`CA_CERT_FILE`) or has no HTTPS public origin, because then nothing can be pinned; `connector_unavailable` is then `no_ca` or `no_origin`.

**The hub's identity.** Each hub has one stable id, `hub-` and 12 base32 characters, made the first time it is asked for and kept in its settings. `GET /connector/v1/hub` (no key) answers `{hub_id, origin}`, so the connector learns the identity over the CA-checked connection before it sends a code. The key file's section for the hub is `<hub id>@<CA sha256>`.

**The connector checks the hub first.** The console shows the code together with the short form of the hub's CA
fingerprint (`pairing.ca_check`: the first 16 hex characters of the SHA-256 of the CA the hub serves at
`/onboard/ca.crt`, in groups of four), and the PC's user enters both. Before it sends anything, the connector opens TLS to
the hub, takes the CA the server presented, and compares its fingerprint with the one entered. Only on a match does it
send the code. On a mismatch it says so on its local screen ("This is not the hub you were given: its certificate does not
match") and sends nothing, so someone in the middle ending TLS with their own CA never sees the code. The hub's own
comparison below stays as a second check.

**Exactly one certificate is pinned.** The text the hub serves at `/onboard/ca.crt` must hold one PEM block. A second
certificate after the first would be trusted too, behind the first one's fingerprint, so pairing refuses it (`ca_bundle`:
"The hub serves more than one certificate where it should serve exactly one") and sends nothing. The key file stores the
parsed certificate's own PEM, never the text around it. The same rule holds for `conclave migrate --ca-file` and
`--https-origin` (problem `ca_bundle`), and a key-file section that already holds more than one certificate is never
used: `conclave check` reports `ca_bundle` and the PC pairs again.

`POST /connector/v1/pair` (no key) `{pairing_code, hub_origin, hub_ca_sha256, platform, version}` answers
`{app_key, hub: {id, origin}, pc: {id, name}}` once. The hub refuses it (401 `invalid_pairing_code`, rate-limited like `/bridge/pair`) unless:
- the code is unused and was issued less than 30 minutes ago; it is single use, and a refused binding voids it;
- `hub_origin` is the hub's own HTTPS public origin and `hub_ca_sha256` is the fingerprint of the CA the hub serves at
  `/onboard/ca.crt`, so a code typed on another hub pairs nothing.

Tests, with the pairing work: a proxy with another CA never receives the code; a matching CA pairs once; a second redeem
of the same code is refused; a code older than 30 minutes is refused.

A code from an old checkout is refused here (a checkout issues no code now: a PC restores through the connector, checkout.md §6). Every refusal answers the same 401
`invalid_pairing_code` with one sentence ("This pairing code is not valid, has expired or was already used. Make a new
code in the console."), so a guess learns nothing; the audit records the real reason (`connector.pair_refused`).

`GET /connector/v1/setup` (app key) answers the PC's own setup timeline, the same `{steps, agents}` as
`/api/pcs/:id/setup-timeline`, for the connector's local screen. The **Paired** step is done from the moment the code
was redeemed.

## Relays (hub side)

A relay is a machine that passes requests on to this hub for PCs that cannot reach it directly (the relay package and its
Caddy config are described in `docs/relay.md`). The hub registers each relay in the console (**Security, Relays**): a
name, the origin PCs reach it at (`https://<address>:<port>`, nothing else) and the relay's CA fingerprint.

- **The secret.** Registering makes the relay's secret, `ah_rly_<12>_<32>` in base32, shown once in the console and kept only as a
  verifier. **Rotate** makes a new one and the old stops at once; **Remove** deletes the relay, so its secret fails and its origin
  is no longer allowed. The secret is a Conclave key shape: the leak guard treats an issued one as an incident, the audit
  redaction hides it, and the request log redacts the header that carries it. It is never put into a prompt or a message.
- **The real user address.** The relay sends `X-Conclave-Relay-Secret` and `X-Conclave-Relay-Client` (the user's address, one
  IP address and nothing else). Only when the secret verifies, compared in constant time, does the hub use that address as
  `req.ip`: the login and onboarding limits and the audit trail then count the user, not the relay. With no secret, a wrong
  one, or a client value that is not one address, the header is ignored and the connection address stays. A valid secret also
  records the relay's last-seen (at most one write every 30 seconds), which the console shows.
- **Pairing.** On a request with a valid relay secret, `GET /connector/v1/hub` answers that relay's origin, and
  `POST /connector/v1/pair` pins the relay's origin and CA instead of the hub's. The PC's key-file section is
  `<hub id>@<relay CA>`; moving a PC between direct and relay uses the existing `origin_changed` confirmation, one binding per
  agent, never two live sections.
- **Origins.** Each registered relay's origin is allowed for MCP (`originOk`) while the relay is registered. The console's
  CSRF check is its token, not the origin.
- **Prompts through a relay.** Add PC, Re-enrol PC, key rotation and "Make a prompt" take an optional `relay_id`. The answer
  and the prompt then carry the relay's origin, its CA fingerprint and a `release_base`
  (`<relay origin>/connector/v1/release`) instead of the hub's.
- **Updates through the hub.** With `CONNECTOR_RELEASE_DIR` set to a folder holding the signed release files
  (`conclave-connector-<version>.bundle`, `.json`, `.json.sig`), the hub serves them at
  `GET /connector/v1/release/<tag>/<file>`, no key needed, like the public release assets they copy. The connector's checks
  (approved version, signature, hashes) do not change, so the transport proves nothing.

## Plain HTTP

The connector always uses pinned HTTPS. The console drops the HTTP tag and the Trust row.

## The `conclave` program

## How an agent signs in

Claude Code or Codex starts `node <conclave.mjs> mcp <folder>` from the folder's own entry (`.mcp.json` or `.codex/config.toml`). That process is a local stdio MCP server for that one folder. It relays to the hub over HTTPS only, with a pinned CA: no plain HTTP, no redirects, no operating-system trust store.

- **Identity is the connector's own record.** The folder is bound to a hub and an agent in `~/.config/conclave/registry.json`, keyed by the canonical folder path and its filesystem identity. Nothing in the folder (`.agent-hub.json`, `.mcp.json`) decides who the agent is, so a copy, a clone or a moved folder has no identity until it is registered.
- **One key file, one section per hub.** `keys.json` (encrypted at rest, see Isolation levels) holds a section per hub keyed by hub identity and CA fingerprint (`<hub id>@<ca sha256>`): origin, CA, app key and one session key per agent. A lookup never falls back to another hub's section. On macOS and Linux a file that group or others can read is refused.
- **Token caches** are under `tokens/`, namespaced by hub and agent. A rotated session key, a removed agent or a migrated hub drops the cached token.
- **The tool list follows the session.** The hub lists only the tools the session could call and answers each request with an `X-Agent-Hub-Tools` digest of that list. When the digest differs from the one of the last `tools/list`, `conclave mcp` sends the client `notifications/tools/list_changed` ([MCP](mcp.md#tool-inventory)).
- **Keys stay out of the agent's process.** The model sees only the MCP stream. This process holds a turn token from the connector's broker and no key (see Isolation levels); the app key and session key are read by the connector's worker, which sends them to the pinned hub and nowhere else, and never prints or logs them. A tool call that the agent can retry (`task_submit`, `task_review`) gets a stable request id, so a retry returns the first result.

## Isolation levels

No session ever loads a long-lived key. A session (a hand-opened chat, a woken run, a Codex agent) talks to the hub with a **turn token** and nothing else; only the connector's worker process opens a key. Two levels say how well that holds. The console shows the level on the PC row and on each agent woken there: **Standard isolation** or **Hardened isolation**.

### Both levels

- **The broker.** The connector's worker runs a local broker: a named pipe on Windows (`\\.\pipe\conclave-broker-<id>`), a 0600 socket in `run/` elsewhere. `conclave mcp`, the folder hook and `conclave check --probe` ask it; the broker signs in with the agent's key and answers with a token, the hub's address and the hub's public CA, never a key. A session that finds no broker says so with one fixed line (`conclave service status`) and sends nothing anywhere.
- **The broker and its sessions prove themselves to each other.** At each start the broker writes a new random secret to `run/broker.secret`, readable by this OS user only, once it has taken its address (a second start that cannot take it leaves the running broker's secret alone). Every request carries a fresh nonce and a proof made with that secret; a request without a valid proof gets `bad_request` and nothing else (no token, no address, no CA). Every answer carries the broker's own proof for that nonce, and a session believes nothing without it: something else listening at the broker's address (for example a process of another user that took the address while the connector restarted) is refused with `broker_unverified`. A session also pins the hub from the folder's registry binding, never from the broker's answer: the binding records the hub's CA fingerprint and, since this change, its origin, and a broker answer naming another origin is refused (`ca_changed`); a binding from an older connector, with no origin yet, uses the verified broker's. On Linux and macOS the socket is `run/broker.sock`; when the connector folder's path is too long for a socket it is in the user's own `XDG_RUNTIME_DIR`, and with neither the broker does not start and the service log says why. It never falls back to a shared folder such as `/tmp`.
- **The turn token** is a hub session token with scope `turn`. It covers that one agent's tools, minus keys and access: it cannot call `session_login`, `setup_pc`, `setup_status` or `access_request`, so it can never ask for another token or change what the agent may do, and the key-pickup routes need the PC's app key, which a session never has. A call uses it but does not extend it: only the connector renews it (`POST /connector/v1/turn-tokens/renew`, every 5 minutes while the run's process lives, 15 minutes of life each time), so a turn of any length keeps its token and a run that is gone loses it within 15 minutes at most. A renewal the hub refuses (paused team, lockdown, a suspended key or PC) ends the run; a checkout's own pause is not one of them, so the resume run it starts keeps its token: its next call is refused with `login_required`.
- **The end of a turn.** The connector revokes the token (`POST /connector/v1/turn-tokens/revoke`) when the session says it is over or its process is gone, and a token used afterwards is refused. First it **scans the run's transcript** (the hook tells the broker where it is) for a long-lived key: text shaped like a Conclave key, or the agent's own keys. A hit revokes with the reason `leak_found` and raises a critical alert, `key_in_transcript`, on the PC, **whatever the token's state**: a token that already expired or was ended still had a key in its transcript, so the alert says which (`turn`: `ended_now`, `ended_before` or `unknown`) and names the agent when the hub knows the token. It reports where, never what. **Only Claude Code transcripts are scanned:** the scan is fed by the Claude Code hook, and Codex has no such hook, so Codex transcripts are not scanned (a Codex run still has its token revoked at the end of the turn).
- **Binding is for routing and audit, not for separating agents.** A folder is bound to an agent in the connector's registry. A hand-opened chat's **first registration in a folder waits for the PC user's click** on the connector screen (`pending.json`, `approvals.json`; once per folder, as that agent on that hub), because registration is self-asserted. A run the connector started itself needs no click, and neither does the first chat in a folder the connector built itself inside a key pickup or restore the PC user allowed (below, "Folders allowed with a pickup"). Two live runs of one agent raise the alert `agent_two_live_bindings`. The hub looks when a run renews its token (every 5 minutes), so it may come up to 5 minutes after the second run starts, and it counts only a token of **another run** issued more than a minute earlier: `conclave check --probe` issues a token and revokes it at once, so it never counts. One alert per agent; each pair of runs joins it once (as a short hash), so the renewals do not repeat it. **Neither level separates two live agents of one OS user:** a process running as the same user can ask the broker for another folder's token, read the same files and listen on the same pipe. What the levels do is keep keys out of sessions, transcripts, logs and backups, and make anything else visible.

### Standard isolation (no admin, the default)

- **The key file is encrypted at rest** (`keys.json`, AES-256-GCM). Its 32-byte secret is held by the platform: Windows DPAPI (current user), the macOS login keychain, the Linux secret service (`secret-tool`) when the session has one, otherwise a 0600 file (`keys.master`) next to it. A platform store that fails falls back to that file. `conclave check` says which, and the check-in reports it (`key_store`). A plain key file from an older connector is read as it is and encrypted after this version's first check-in is confirmed, never before, so a rollback to the build before it can still read the file. Once it is encrypted, a way back to a build that cannot read an encrypted key file (one without the key store) is handled as in [Self-update](#self-update): `conclave rollback` first writes the key file back in plain form, and the launcher, which cannot open the platform store, says why the build it went back to finds no keys. Setting `CONCLAVE_KEY_STORE=file` forces the file.
- **What this protects, and what it does not.** It protects against a key leaking: into a transcript, a log, a backup, a paste, a synced folder. It does not stop a determined agent running as the PC's user: the platform store opens for any process of that user, so such a process could ask it and read the key file. The local screen says so in those words. The hardened level closes it.
- **Folders that were already registered.** When a connector first starts with turn tokens, a folder registered before that, whose settings still hash as they did at registration and whose filesystem identity is unchanged, is allowed without a click (once per PC, never run again). It gets one line in `connector.log` and one audit entry on the hub (`connector.folder_grandfathered`, sent at the next check-in and retried until the hub takes it). A folder whose settings changed or are held, and every folder registered after the upgrade, waits for its click, except a folder the connector built itself inside an allowed pickup or restore (next-but-one bullet, "Folders allowed with a pickup").
- **Clicks.** A key pickup for a team request this PC filed itself goes ahead with no click at the standard level (the keys go only to this connector); at Hardened it waits for the click, and a pickup the PC user declined stays declined. A restore or a key handover (a rotated key, new agents) waits for the PC user's click on the connector screen, once per request, because a pickup hands over session keys. A recruit of a team the operator set to **Automatic** needs no click at the standard level: the hub marks its handover `no_click` in `GET /connector/v1/handovers`, the operator's setting is the approval, and the connector takes it with no click. A rotation, a recruit of a team that asks first, and every handover at Hardened still wait for the click. The hub reads the team's setting when the list is read, not when the recruit was filed: if the operator switches a team from asking first to Automatic while a recruit waits, that recruit is taken with no click. Before the click, the row lists each folder the connector will build, with its agent, and says that Allow also allows the first chat in these folders. Nothing is picked up before it; the setup and restore steps answer "waiting" with that reason until it is clicked. A recruit's folders are allowed with the pickup in both cases (the click, or the Automatic setting): the connector records the allowance right after it builds each folder, so the first chat there needs no second click.
- **Folders allowed with a pickup.** A folder the connector builds and registers itself inside a pickup or restore the PC user allowed counts as allowed for that agent on that hub, with no second click: nothing in it is self-asserted (the same reason a run the connector starts needs no click). It applies only to a folder that was new or empty when built (setup) or that the PC user approved on the restore screen (restore); an existing folder that is merely registered, or a restore folder still waiting for its trust, waits for its own click. The allowance is written after the folder is fully built and its registry entry is saved, with the folder's settings hash and filesystem identity as they are then (`approvals.json`, `by: pickup`); a crash before that costs one click later. It is bound to that agent, that hub and that folder: another agent or hub, a moved folder, or a changed hash or identity waits for a click again (this includes a later change to the folder's settings, for example a hub instruction update: it lapses to a normal click, which is not a fault), and `revokeFolder` withdraws it. Each one is reported at the next check-in to `POST /connector/v1/folders-allowed-with-pickup` (`{allowed: [{agent_id, ref}]}`, `ref` the pickup id) and audited on the hub as `connector.folder_allowed_with_pickup`, not as a grandfathered folder. Deny stays per row.
- **The wake** is turned on per agent, with that agent's level shown beside it.

### The connector's screen

One page, `conclave setup`, top to bottom. It opens on a one-time link, answers only to this PC's own address and the cookie that link sets, rejects a cross-origin form, loads nothing from outside, and closes after an hour idle.

- **Status line**: "Conclave on this PC", the connector's version and whether it is running, whether each hub answers, the isolation level, and "Closes after 1 h idle" on the right.
- **Needs you**: a warning card, shown only while something waits. Each row has **Deny** and **Allow**, one by one: there is no "Allow all". A folder row shows the full folder path, the program (claude or codex), how long ago it asked, the hub when this PC has more than one, and a warning when the folder's settings changed since the agent was registered (the settings hash, kept with the request). The card says: Allow only chats you opened yourself.
- **Teams**: one card each, collapsed except the first. The chips (ready, waiting, error) are also written as text when collapsed. Each agent is a compact row: label, role, wake on or off with its isolation level, a state chip, and Open; the terminal and Codex commands are behind Open. Delivered and restore notes sit inside the team.
- **Settings**: one-line summaries that open on a click: Wake, Isolation, Account profiles, Restore folders, Pair with another hub.
- Names and texts the hub supplied are escaped and marked on the screen as coming from the hub.
- **Real phase.** Until an agent's keys are written, its row (and `conclave setup continue` / `status`) says what it waits for: **Waiting for your administrator** (the request is not approved), **Waiting for your Allow** (approved; at the Hardened level, or for a pickup the PC user declined, the key pickup waits for the PC user's click), **Picking up keys**; **Ready to open** shows only once the keys are written.
- **Refresh.** While something waits (a click, a team that is not connected yet) the page reloads itself every 5 seconds (`/?r=1`); those reloads do not count as a visit for the idle close, and are skipped while a field has focus or holds text the person typed.
- **No browser.** On a PC with no browser program or display, `conclave setup` prints the link instead of opening it, and the installer says how to open the screen later and finishes with exit 0.

**Deny.** The chat gets the fixed line "This chat was not allowed on this PC. If you opened it, ask the PC user to allow it on the connector screen." (reason `denied`) and the folder is not asked about again. The connector remembers the deny for **10 minutes**, in `pending.json`; the row stays under **Denied** and can still be allowed. A denied key pickup is not made and its step answers "declined on this PC". The next check-in reports each deny once to `POST /connector/v1/folders-denied` (`{denied: [{what: 'folder', agent} | {what: 'pickup', request}]}`, up to 50, app key): the hub writes the audit entry `connector.folder_denied` (or `connector.pickup_declined`) and raises the warning alert `connector_folder_denied_repeat` when one agent is denied 3 times within an hour.
- The standard gate records proof G6(a) (a process of the same user cannot read the key) as **expected to fail**.

### Hardened isolation (admin, optional)

Standard stops a key from leaking; it does not stop a process of the PC user from opening the key store. **Hardened** moves the keys out of the PC user's reach: a **key service** under its own account holds every long-lived key, and nothing the PC user runs can read one. Standard stays the default; Hardened is opt-in, shown on the connector's screen and in `conclave check`, and can be switched off.

**What runs where.**

- **The key service** (`conclave vault run`) runs as `NT SERVICE\Conclave` on Windows (a virtual account: Windows manages it, there is no password) and as the system user `conclave` on Linux (a systemd unit). It owns the vault folder (`C:\ProgramData\Conclave\<id>\vault` on Windows, `/var/lib/conclave/<id>/vault` on Linux), readable by that account, SYSTEM and administrators only. Beside it are `view\` (the public view, readable by every user) and `app\` (the service's own copy of the connector's code, which only administrators may change, because it runs with the keys). The vault folder holds the encrypted key file (`keys.json`, written by the same module as at Standard, with its secret in a file the account alone can open).
- **The connector** (worker, broker, `conclave mcp`, the hook) keeps running as the PC user and keeps its own logic: registry, folder approvals, the click, process liveness, transcripts, the folders it starts. It never holds a key. Its key file is a **public view** (`keyview.json`): the hub's origin, CA and agent labels, with a **placeholder** where every key was (`vault:app` for the app key, `vault:agent:<label>:<tag>` for an agent's session key, the tag being a short hash so a rotation shows).
- **The relay.** The service listens on a local pipe (`\\.\pipe\conclave-vault-<id>`) or socket. Every hub call of the connector goes through it: the connector's pinned-HTTPS client sends the same request to the pipe instead of the hub, with the placeholder where the key goes; the service puts the real key in at two places only (the `Authorization: Bearer` header, and a JSON property named `session_key` whose whole value is a placeholder; a placeholder anywhere else stays plain text, so a caller cannot make the hub store or echo a key), sends it to the hub over the pinned CA, and streams the answer back. Turn tokens, renewals, revocations, check-ins, the push stream and the transfer bridge all work unchanged. The relay reaches only `/connector/v1/…`, `/bridge/…`, `/vault-sync/v1/…`, `/mcp`, and `/onboard/pickup` with its `/confirm` of a hub the vault knows, and an answer never carries a key. A pickup's answer (a key handover, or setup's pickup) does carry the new session keys, so the service reads it whole, keeps each key, and passes on a one-time reference in its place (`vault:pickup:<32 hex>`, good for 30 minutes and for that hub only; at most 256 wait at once, and past that the oldest is dropped and refused like an expired one). The connector hands the reference back to `put_agent` or `stage_agent`, and the service writes the key it stands for.
- **Writes.** Pairing, onboarding, a collected rotation and a disconnect change keys through the service (`vault put` helper, the key travels on standard input to the pipe), which rewrites the public view. A key never travels back to the connector.
- **The leak scan** of a finished run's transcript is asked of the service (`scan`), which answers only whether a key was found and of what kind.

**Install, step by step (an administrator's step).** `conclave install-service` needs administrator rights once; it does not ask for them itself: open a terminal as administrator on Windows, or use `sudo` on Linux, and run it there. Elevated, the keys are those of the PC user, not of the administrator: under `sudo` the hub finds them through `SUDO_USER` (that user's `~/.config/conclave`); on Windows, or when an administrator account other than the PC user runs it, pass `--home <the PC user's .configconclave folder>` (or set `CONCLAVE_HOME`), otherwise the command reports that the PC is not paired. Everything an elevated run writes into that folder (the marker, and on switching off the key file and its secret) is handed back to the PC user on Linux, so the connector can read and rewrite it. A PC whose user is not an administrator stays Standard, and the screen says "Wake held" where an agent needs the service. The command:

1. checks that the PC is paired and every agent can still sign in (a turn token is issued and revoked), then takes a **backup** of `keys.json` and its secret into the vault folder (`vault\backup`, which the user cannot read);
2. copies the connector's code to `app\`, creates the account and the vault folder with its access list, and writes the service (on Windows a small service host is compiled from source with `Add-Type`, because Node cannot speak the service protocol itself; nothing is downloaded);
3. **migrates**: copies the keys into the vault, checks that the service can sign in with every agent through the relay, then writes `isolation.json` and the public view and removes the user-level key file. **Any failure rolls back**: the marker is not written, the service is removed, the original file stays, and every agent keeps working at Standard;
4. says what changed in one line, and `conclave check` now reads "Hardened isolation".

**Old keys stay valid.** The install does not rotate a key: one the PC user's programs could read before it still works, and the vault's `backup` folder keeps a copy. If a leak is suspected, rotate the agent keys after installing. The service runs the connector's code with the keys, so it keeps its own copy (`app`) that only administrators may change; the copy is not refreshed when the connector updates (run `conclave install-service` again after an update). The service account must be able to run Node: if `node` lives in the PC user's profile the install ping fails and the install rolls back safely, so install Node for all users first.

**Switching off.** `conclave uninstall-service` asks the service to export every key back into the user's own encrypted key file (Standard), checks it reads back, removes the marker, then stops and deletes the service, the account and the vault folder. **No key is lost** and no agent needs to be paired again. If the service is already gone, the backup from step 1 is the way back and the command says so.

**What this protects, and what it does not.** A process of the PC user cannot read a key: not from a file, the environment, the pipe (no operation returns one), the service's memory or the vault folder. It can still ask the service to **use** a key for the hub calls above while it is logged in, which is why Hardened sits beside the other rules: the first registration per folder waits for the PC user's click, a turn token is scoped and short, and the hub alerts on two live bindings of one agent. **Neither level separates two live agents of one OS user**; that needs an OS account per agent. A PC administrator can still read the vault. **A key the hub hands over** (a new PC's app key at pairing, an agent's key at onboarding or a restore) passes through the connector's memory once on its way into the service and is never on disk; the pickup waits for the PC user's click, but a process of the PC user that asks the hub for a pending pickup itself would receive it. The service does not capture pickups yet, and `conclave check --hardened` does not cover that window.

**Proof G6.** (a) *A process running as the PC user cannot read an agent's key while Hardened is on* is the gate of this level: the test plants a recognisable key, then searches everything the user can reach (the home folder, the public view, the environment, every operation of the service) and finds nothing; at Standard the same search finds it, so G6(a) is recorded there as expected to fail. `conclave check --hardened` repeats the part the tests cannot, on the real PC after the install: this user is refused by the vault folder, its key file and its secret, the public view holds no key, and the service answers. (b) *A run cannot act as an agent that has no live run* is checked through the relay: a turn token is issued only for a registered folder, and the hub refuses it for another agent.

The connector starts agent processes under the PC user's account. The separate Windows service holds and uses credentials. Installing the hardened service requires a PC administrator.

### Hub side

Migration `0158_turn_tokens.sql` adds `scope` and `run_ref` to `session_tokens` and `isolation` and `key_store` to `connector_reports`. Migration `0165_review_fixes.sql` adds `run_id` to `wake_runs` and the reason `connector_too_old` to `task_turns.delivery_reason`. The check-in carries `isolation` (`standard` or `hardened`) and `key_store` (`dpapi`, `keychain`, `secret_service`, `file`, `service`); both read Unknown until reported.

### The wake

When the hub has work for an agent on this PC (a `deliver` order), the connector starts a turn for it: a headless `claude -p` (or `codex exec`) in the agent's folder. It replaces `codex-wake.mjs`. The PC user turns it on **per agent** on the local screen, with the agent's isolation level beside it; it is off until then (the order answers `wake_held` and the item waits for the agent's next prompt, as before). Agent messages wake nobody unless the PC user turns that on too, and then at most once per agent per 10 minutes. Even then an agent's message wakes only the agents it addresses: the other member of a direct room, an agent named by an @mention of its label (exact, any letter case), or the author of the message it replies to; the other members see it unread at their next prompt, and an operator message still wakes every member.

- **One session per task.** A new task's first item starts a fresh session with the folder's role file and a fixed prompt (fixed words and ids, never hub text). Later items on the same task resume that task's session. When the hub says the task is over, the session is forgotten and never resumed. An item with no task (a decision, a message) resumes the agent's **inbox session**, so the role file, tools and system prompt are not paid for again on every wake: the connector remembers the session id of the agent's last no-task run and resumes it when the agent has no run going and no chat open, the client is the same, and the session is under 12 hours old; otherwise it starts a fresh one and remembers that. **What this means:** text from earlier messages (other agents' text, L2 data) stays in the model's context across unrelated turns for up to 12 hours, where each turn used to start clean. It is accepted because the grants and the turn token do not change with the session, each wake's prompt is still fixed words and ids, a task keeps its own session, and a reset, a failed resume or the 12-hour limit clears the inbox ([threat model](threat-model.md)). If a resume fails (the run ends with no result), the inbox is forgotten and the same items run once more in a fresh session. A reason order (Start team, the handout, resume after a move) always starts fresh and never touches the inbox, and a reset forgets it.
- **The prompt names only what waits, and asks for the confirmation.** A task item says to call `task_list` for that task, a message `message_read`, a decision `team_decisions`; a prompt never names a read that nothing waits on. It ends by asking the agent to confirm the notices it handled with `session_ack`, so a later session is not sent the same notices again. A re-run the connector starts itself (a retry, or after a usage limit) says so; it never says a message arrived.
- **One turn at a time per agent folder.** An item for the running task (or with no task) reaches the turn as the hub's own inline notice, so its order is answered at once. An item for another task waits with its order open, the hub shows "Waiting behind task X" (`wake_runs.waiting_on`; the run stays running on its own task), and it starts when the turn ends. The coordinator can reassign it.
- **No keys, no click.** The connector starts the run itself, so the folder needs no first-registration click for it, and the run's `conclave mcp` gets a turn token from the broker. The run's environment holds no long-lived key: it is built from a short allowlist (the system folders, `PATH`, the user's home, proxy and certificate settings, locale), never the connector's whole environment, so `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `CODEX_API_KEY` in the connector's environment cannot switch a run to paid usage. The account profile's one variable (`CLAUDE_CONFIG_DIR` or `CODEX_HOME`, from `profiles.mjs`) is added to it, and the profile's name is what a usage pause is kept under.
- **The program is found by absolute path, never from the agent's folder.** The connector looks for `claude` or `codex` in the absolute `PATH` entries that are not inside the agent's folder, then in the clients' own install folders, and starts that path (an npm `.cmd` shim becomes Node running the package's script beside it). A program planted in a clone is never run, which matters on Windows, where a bare name is looked for in the working folder first. A client that is not found leaves the order open and starts nothing.
- **A launch is delivered only once it started.** The order is answered `done` after the process's `spawn` event; a program that cannot start leaves the order open and records nothing.
- **A pause, a lockdown or a suspended key ends the run.** When the hub refuses to renew a run's turn token, the broker tells the wake, which ends the run it started in that folder (the whole process tree at once, as for the operator's Stop: stronger than waiting for the current tool call) and reports it `stopped`; the transcript is scanned for a key on that path too. A chat opened by hand is not the wake's to end: its token just stops working.
- **Permissions are the folder's own.** At standard isolation a tool that needs approval is refused; the run's result lists it, the turn ends, and the console shows "Needs approval: open the session". Nothing is started again until a person acts.
- **A chat in use is never taken over.** If a person has that agent's chat open, the order answers `chat_in_use` and the item shows at the next prompt.
- **Completion is the hub's word.** `delivered_at` is set when the turn starts (the order is answered `done`). When a run ends the connector asks the hub (`POST /connector/v1/wake/check`) what the agent still holds: a task still queued on the agent is continued once, a task the hub closed has its session dropped. A process exit alone proves nothing.
- **Records.** The run's state, task, session id and last activity time go to the hub (`POST /connector/v1/wake/report`, table `wake_runs`). Transcripts stay on the PC. **One run is one clean record:** it starts once (one `started_at`, one `connector.wake_running` entry), and a heartbeat changes only the activity time. **Waiting is a field, not a state:** an item queued behind the run sets `waiting_on`; the run keeps its state, task and start time, and nothing is audited, however often it waits and resumes. A usage pause or a needed approval is audited once when it begins; going back to running in the same run is not a new start. A report may name its run (`run`, an id); without one the hub matches the task and session. A report that ends an earlier run (a late `ended` or `stopped`) never ends the run that followed it: the hub drops it.
- **Nothing is capped by length.** A run's turn token is renewed while it lives. A pause, lockdown or key suspension refuses renewal and ends the run as described above. After 30 minutes with no activity the console shows "No activity for 30 min"; nothing stops by itself. **Stop** is the operator's: **Stop the woken run** in the agent page's ⋯ (admins only) asks once, saying what is lost (anything the hub and git don't hold, such as uncommitted files and unsent words), then sends one `deliver` order with reason `stop` and no items to the PC the run reported from (`POST /api/agents/:id/wake/stop`, audited as `connector.wake_stop`; a second click while it is open is the same order). It ends the run and keeps its session. The agent page's Status card shows the run (`GET /api/agents/:id/wake`): its state, task and last activity.
- **Usage limits** are read from the run's structured events, never from the agent's words: a rejected rate-limit event with its reset time (Claude Code, and Codex when it emits one), or, for `codex exec`, the run's own error event for a usage limit, with its reset time or "try again in" delay, or one hour when it gives none. A reset is never taken as later than 8 days from now. Every run on that account profile pauses ("Usage limit, resumes at hh:mm"), resumes are spread over a few minutes after the reset, and paid extra usage is never turned on.
- **Restarts.** Each run writes its output to a file under the connector's state, and the record keeps its process id and start time. After a restart a run is taken up again only if the same process (id and start time) still runs, so a reused id is never adopted. A PC that is offline shows "PC offline since hh:mm"; nothing fails.
- **A reset** (`reset.mjs`) waits for the turn to end: the session is then dropped and the next item starts fresh.

### Codex folders

A Codex agent restored by the connector works in its own clone of the team repo: its folder is the clone itself, with no worktree, because Codex's `workspace-write` sandbox keeps `.git` read-only. A Codex agent set up from scratch (`conclave setup`, an onboarding request whose client is Codex) gets the same layout in its new folder: the same binding, role file, exclude lines and `commit` tool. It no longer gets an `AGENTS.md` of its own, and an `AGENTS.md` already there is left as it is. Either way its binding in `registry.json` records `provider: codex`, and setup records the folder's settings after writing them, so `conclave check` finds nothing changed. Claude Code folders are unchanged: `CLAUDE.md`, no override, no `provider`, no commit tool, and a shared clone's exclude list keeps `.claude/` visible.

- **Role file.** `AGENTS.override.md`, first line `<!-- conclave:role-file v1. … -->`, then a header telling the agent to read the folder's `AGENTS.md` as well and to commit with the `commit` tool, then the hub playbook. It, `.codex/` and the connector's own files there (`.claude/`, which holds the approval and hook registration writes, and `.mcp.json`) are in the folder's `.git/info/exclude`, so `git status` in a Codex clone stays clean; a file the repo tracks stays tracked, and a tracked `AGENTS.md` is never changed. A folder set up from scratch also lists `*` in that file (as every connector-built folder does), so a hand-run `git status` there shows nothing but the tracked files; the `commit` tool therefore adds the files it names with `--force`, after every refusal above has run (`.git`, `.codex`, the role file, the connector's files, and any path outside the clone). This was chosen over narrowing the exclude list to the connector's own files because it changes one flag, keeps `git status` clean and leaves the exclude list of a restored clone and a built one the same. A file that the repo's `.gitignore`, any other line of the clone's `.git/info/exclude` or the PC's global excludes ignores is refused, so a `.env` or a key file is never committed by this route. Setup records the folder's settings (the manifest hash) after its last write, `CLAUDE.md` included, so `conclave check` is clean right after setup. Setup stops for one agent, before writing anything, when its folder already holds an override the connector did not write (the reason is shown, and Retry works once it is moved away). The manifest records the text (kind `codex_role`), so `conclave repair` writes back a missing or edited one, and uninstall removes it only while it is unchanged. `conclave check` stops with `role_file_missing`, `role_file_edited` or `role_file_unmarked`. An unmarked override is never overwritten: one from the old `codex.mjs` setup is replaced by `conclave migrate` (its playbook kept), any other must be moved away by the PC's user.
- **A Codex that cannot run tools.** In a Codex folder `conclave check` also looks at the Codex program the connector would start for a woken run (the same search as the wake: the absolute PATH entries outside the folder, then the install folders). It asks that program `codex features list`, which is local and changes nothing. When the `code_mode_host` feature is on and `codex-code-mode-host` is missing (a native program: not beside it; an npm install: in none of its `vendor` folders, which are the package's own and those of its platform packages, nested in the package or beside it), every tool call of that Codex fails before it runs, its own shell included, so the check stops with `codex_tools_broken`: one fixed line that says Codex on this PC cannot run any tool and to reinstall it. This is a Codex install fault, not a version limit: the connector checks no Codex version. A Codex the connector does not find, one that does not answer, or an npm install with no `vendor` folder where one is looked for, is listed as a step and never fails the check (a chat opened from the Codex app runs its own copy).
- **`commit`.** The folder's `conclave mcp` lists one local tool beside the hub's, `commit {paths, message, branch?}`, and answers it itself; the call never reaches the hub. The connector runs git outside the sandbox, in the folder only:
  - only the files named (up to 200; files, not folders; a deleted tracked file counts), with `GIT_LITERAL_PATHSPECS` and `commit --only`, so nothing else staged goes in;
  - refused before git runs: anything in `.git` or `.codex` (also as `GIT~1`, with trailing dots or spaces, in any case), the role file, the connector's own files, `..`, absolute, drive and UNC paths, `:` and patterns, and any link or junction whose target is outside the clone or in `.git`;
  - only on a branch of the agent's own: the current one or `branch` (created from the current commit when new), never one a remote has and never one with an upstream; a worktree or a folder that is not the top of its repo is refused;
  - author and committer are the agent's label from the hub's sign-in (the agent's own label, never its key's, such as "(onboarded)"), with `<agent id>@agents.conclave.invalid`;
  - hooks off (`core.hooksPath` set to an empty folder of the connector's, `--no-verify`), no fsmonitor, no signing, and no inherited `GIT_*` variables;
  - **never pushes**. The answer names the commit, the branch and the files, and says nothing was pushed. Each call is one line in `connector.log`.

## When something is wrong

If the folder's hub or key is refused, the session says why and what to run, even when MCP never initializes: the connector answers `initialize` itself with one fixed sentence in `instructions`, offers one read-only tool `conclave_status`, and logs a line to `connector.log`. The sentences are fixed (no path, no hub text, no key): the folder is not registered, its recorded identity changed, this PC has no key for the folder's hub, the hub's certificate changed, a key is missing, the hub address is not HTTPS, the certificate does not match what the PC pinned, the hub could not be reached, the hub refused the key, the entry is stale, trust was turned off, the folder's settings changed.

```
conclave check [--folder <f>] [--probe] [--json]
```

`check` is local and read-only. It looks in a fixed order and stops at the first problem, so it names one reason. `--probe` asks the hub once whether the agent can sign in, and caches nothing. Exit 0 when set up, 1 on a problem.

```
conclave repair [--folder <f>] [--grant-trust] [--accept-folder-changes]
```

`repair` rewrites an entry whose Node or connector moved and restores a trust entry that disappeared. It never turns trust back on after the user turned it off, and never trusts a folder whose settings changed, unless the user says so with the flag. Exit 3 means the user must decide.

### The one reminder line

An agent that makes no hub calls would never see what waits for it, so the connector tells it in one line. The line
combines the agent's unread messages and unread directives, in fixed words, for example:
"Conclave: 3 unread messages (1 from the operator, 2 from Developer 2); 1 unread directive. Read with `message_read` and `directives_read`."

- **Shown when it changes, not on every prompt.** The connector remembers the counts it last showed an agent (in its own state, never on the hub). The same unread state is not shown again at the next prompt (it compares the counts, each room's `top_seq` and the directive count, not the line's text, so new messages from the same sender still show); the line appears again when the messages or directives count changes, and a count that drops to nothing clears the memory.
- **Built on the PC from the hub's counts, never from text.** `POST /connector/v1/messages/unread` (app key) `{agent_id}`
  returns `{total, senders: [{from: "operator" | "agent", label, count}], rooms: [{room_id, top_seq}], directives}` for an agent
  whose session key is bound to that PC (any other is `not_found`). It counts messages past the highest position any
  login of the agent acknowledged, leaves out the agent's own and removed messages, and changes no position. A message with no
  sending agent is "the operator". No message text, title or id goes into the line.
- **The sender is named only by a plain label.** The operator is "the operator". An agent shows by its label only when it
  is plain letters and digits with spaces, `.`, `_`, `·` or `-`, at most 40 characters and five words
  (`LABEL_RE` in `connector/reminder.mjs`, the one place that says); anything else, such as a label that carries
  instructions, shows as "an agent". Messages stay L2: the line says who and how many, never what.
- **Where it appears.** In Claude Code, through the folder hook below. In Codex, at the start of each woken turn: a woken
  turn is a new `conclave mcp` process, so the first tool result of that process ends with the line (`conclave reminder
  --folder <folder>` prints the same line, for a script). A Claude Code session needs no more: the hook covers it.
- **Shown.** When the line shows messages, the PC reports the top message of each room with `/messages/shown` (above). The
  console labels it as the PC's report, and it is never Read.

### The folder hook

Claude Code runs `conclave hook --folder <agent folder>` when a prompt is submitted and when a session starts, and the
hook adds the line as context (`hookSpecificOutput.additionalContext`).

- **Context only, never a block.** It prints no `decision`, `continue` or `stopReason`, so it cannot stop a prompt or keep
  a turn open. For every other event it prints nothing, and it does not ask the hub. **No printing hook runs at Stop.** Testing
  showed that context printed at Stop makes Claude Code continue the turn, which looped eight times. So the line reaches an
  agent when a prompt is submitted or a session starts, not "when a turn ends". A build test fails if any connector source
  registers the prompt hook for Stop or any event beyond the two.
- **The silent context hook.** `conclave context-hook --folder <agent folder>` is registered at Stop and PostToolUse only. It
  reads a hand-opened chat's context numbers (see [Context size](#context-size)), prints nothing, ever, asks no hub, and exits
  0 at once, so it cannot keep a turn open. Gate G1 (`hasStrayHook`) allows it at those two events and still refuses the
  prompt hook there, or the context hook anywhere else; a test runs the command with every kind of input and checks that
  nothing comes out.
- **Short and silent.** It waits at most 3.5 s (the entry's own timeout is 5 s). A hub that is down, slow or refuses, an
  unregistered folder, a missing key or unreadable input all end in no output and exit code 0.
- **Only in agent folders.** Setup and `conclave register` write the entries (the prompt hook's two and the context hook's two) into that folder's own
  `.claude/settings.json`, one entry at a time: other hooks and settings stay, an earlier entry of ours is replaced in place,
  and the `hook` manifest entry records the value before and after. It is never put in the user's own settings or in any
  other folder, and it runs only where the connector's registry knows the folder. The command names Node and the connector
  by absolute path, with forward slashes in double quotes; a path that cannot be carried (a quote, `$`, a backtick, `%` or a
  line break) leaves the folder registered without the hook. `conclave repair` puts it back when it is gone or names a moved
  Node or connector.

## Folders

A PC with only the connector (no `setup_pc`) still needs approved folders to receive file transfers. At each check-in the connector sends the folders of its bound agents to `POST /connector/v1/folders` (app key; body `{folders: [{agent, agent_id?, path}]}`, at most 200). `agent` is the connector's name for the agent (its folder slug) and `agent_id` is the hub id the connector holds for it. The hub knows an agent of this PC by that id first, then by label, then by slug when only one agent of the PC has it; a folder naming none of them is refused as `unknown_agent`. It sends again only when the list changes, and retries at the next check-in after an error.

The hub stores each new path as a `proposed` row in `machine_folders`, the same row `setup_pc` makes; the operator approves or rejects it with the usual folder approval. Nothing is approved by the connector. A path is refused when:

- its agent is not one bound to this PC;
- it is not a normalised absolute path (a drive path or one starting with `/`; no `.` or `..` parts);
- it is a root or a top-level folder (fewer than two parts below the root);
- the PC already has 500 folder rows.

A known row (proposed, approved or rejected) is left as it is. The answer is `{proposed, known, refused}`, and refusals are audited as `connector.folder_refused`, proposals as `connector.folder_proposed`. Transfers into a PC check approved rows only.

## Folder trust

Claude Code keeps one flag per folder in `~/.claude.json` (`projects["<folder>"].hasTrustDialogAccepted`). On Windows the key is matched with forward slashes, so both forms are written. The connector re-applies the flag only if the folder is registered, its identity and agent settings (`.mcp.json`, `.claude/settings*.json`, `CLAUDE.md`, `AGENTS.md`, `.codex/config.toml`) are unchanged since they were recorded, and the entry has disappeared. A flag set to false stays false. Anything else asks the user: the session shows the fixed line and `conclave repair --grant-trust` is the user's answer. The file is merged by key into its newest content and never written over a file that changed meanwhile or is not valid JSON.

## Account profiles

Several Claude or Codex accounts can share one PC. The PC user names local **profiles** on the connector's local screen, for example "work" and "personal". Each is its own Claude config folder (`CLAUDE_CONFIG_DIR`) or Codex home (`CODEX_HOME`), and the person logs in to it once, themselves. Profiles are kept in `profiles.json` in the connector's own folder; an agent (or a team) is bound to one in `registry.json`.

- **The connector sets one variable and nothing else.** `runEnv(home, folder)` (`connector/profiles.mjs`) returns `{ CLAUDE_CONFIG_DIR: dir }` or `{ CODEX_HOME: dir }` for the profile bound to the agent (an agent's own binding wins over its team's), or `{}` when there is none. The wake, built separately, calls it when it starts a run. The connector never reads a profile's login files.
- **Trust per profile.** Binding writes folder trust into that profile only: `.claude.json` inside the Claude config folder (merged by key, as in [Folder trust](#folder-trust)), or `[projects."<folder>"] trust_level = "trusted"` in the Codex home's `config.toml` (a `trust_level` already there is kept). That is the only write into a profile. The profile folder is created empty if it does not exist.
- **Bind team.** The Account profiles card lists the teams of the folders registered on this PC. Registration records each folder's team id and name as the hub gave them at pickup or restore (a folder registered by an older connector has no team on record, so its agent is bound on its own row). "Bind team" binds every folder of that team that runs the profile's program and writes trust into the profile for each; the team's agents of the other program keep their own binding or the default account. An agent's own binding still wins over the team's. "Default account" unbinds the team.
- **`config_changed` means run `conclave repair` first.** A bind, for one agent or a whole team, is refused with `config_changed` when an agent folder's settings changed since they were recorded. A team bind with one such folder writes nothing at all, for none of the team's folders.
- **The hub sees only the name, and only for a run on the profile.** Each relay records, on the PC only, the account variable (`CLAUDE_CONFIG_DIR` or `CODEX_HOME`) its run was started with. The check-in's `agents` row carries `profile` only when that is the folder of the profile the agent is bound to, as for a run the wake starts with `runEnv`. While the PC user hides the name it carries `profile_hidden: true` instead, so the console can say "Profile hidden". A name is a plain label of at most 40 characters; one that looks like an email address or a Conclave key is refused. The hub never sees a login, an email, a path or a credential.
- **Chats opened by hand** are unchanged: they use whatever account the app is logged into and report no profile, even for an agent bound to one.
- **Not proven yet: separate logins per platform.** Two config folders keeping separate logins has to be proven on each platform before the wake relies on it. The local screen says so on the profile card. What has been checked so far:
  - **Windows, Claude Code:** with the default config logged in, an empty `CLAUDE_CONFIG_DIR` folder reports "not logged in", so the login is kept per folder. A second account was not available, so two logins side by side are not tested.
  - **Linux, Claude Code; Windows and Linux, Codex:** not tested, no second account.
  - **macOS:** not tested, no Mac. Claude Code on macOS keeps its login in the keychain, so `CLAUDE_CONFIG_DIR` may not separate two accounts there.
- **In the console.** Under State on the agent's Status card, while the agent is live, muted text says "Profile: work" or "Profile hidden"; the PC page's agent row says the same after "open on the PC". Nothing shows for a chat opened by hand. A hub that does not know `profile` or `profile_hidden` refuses a check-in that carries them, so update the hub before binding an agent to a profile.
- **Codex runs:** the relay sees `CODEX_HOME` only if Codex passes it to the MCP server it starts. Where it does not, a Codex run on a profile reports no profile (never a wrong one) until the wake forwards it.
- **Codex trust headers in either quoting.** Codex itself writes a project key as a TOML literal string (`[projects.'C:\work\app']`) on Windows. Binding reads both basic and literal keys, and on Windows compares folders without regard to case, so it never adds a second table for a folder that is already there, and a `trust_level` the user set is kept.
- **Not undone by Uninstall:** the trust entries written into a profile are not in the manifest, so removing the connector leaves them in that profile.

## Paths and the manifest

The entry names Node by absolute path, with the connector and the folder as separate arguments, so paths with spaces work. Git is found by absolute path: the connector's own portable git (`~/.config/conclave/git`, MinGit on Windows) first, otherwise an absolute `PATH` entry; a relative entry is never used.

`manifest.json` records what the connector created as entries of fixed kinds at fixed places: `mcp_entry`, `mcp_approval`, `codex_entry`, `hook`, `git_exclude`, `trust_flag`, `key_section`, `registry_entry`, `token_cache`, `portable_git`. An entry whose kind is unknown, whose file is not that kind's place in a registered folder, or whose path crosses a link or junction is refused. For shared config it keeps the value before and the value installed, so a later removal undoes an entry only while it still holds the installed value and keeps and lists anything the user edited.

## Usage stats on the PC

The connector can report how many tokens its own worker sessions used (`connector/usage.mjs`), for the admin's
**Usage · 30 days** card. It is off until the PC's user turns it on (`conclave usage on`, kept as `usage_opt_in` in
`preferences.json`, and sent in the check-in). `conclave usage off` stops new reports; what the hub already has is kept
under the hub's retention rule, which is separate (review v2 §14). `conclave usage [--json] [--days n]` shows what would
be sent. While it is off, the connector opens no session file at all, not even to list them. Files are streamed line by
line, never read whole, so a session file of any size is read in bounded memory; a line over 16 MB is skipped and counted.
The connector service sends it: once an hour, while the user has opted in, the worker reads the usage once and sends
each hub only its own sessions' days over that hub's pinned connection with its app key. It sends the last 30 days on
its first pass after the user opts in (or after it starts), then the last 3 days; a day sent again replaces that day on
the hub, so nothing is counted twice. A turn is one assistant message for Claude Code and one token-count step for Codex.

- **Only registered worker sessions.** The connector registers each session it starts (`registerSession`:
  client, session id, agent id, hub, folder) in `sessions.json`, and only for a registered agent folder of that hub.
  Inside each file only rows whose recorded working folder is that session's folder count. A personal chat opened in an
  agent folder has its own session id and is never read; a folder name match alone counts nothing.
- **Structured events first.** Usage the connector recorded itself from a client's documented events
  (`recordUsageEvent`, `usage-events.jsonl`; Codex's app server where it is used) replaces the session file for that
  session. The file reader is the fallback.
- **Claude Code** (`<CLAUDE_CONFIG_DIR or ~/.claude>/projects/*/<session id>.jsonl`, and that session's `subagents`
  files): assistant rows with `message.usage`; each `message.id` counts once across all files, because a resume copies
  rows; API error rows are skipped; side-chain messages count and are reported apart; other row types are ignored.
- **Codex** (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-…-<id>.jsonl`, and `archived_sessions`): the `session_meta` row
  must name the session and its folder. `token_count` events carry a cumulative total, so each event adds the step from
  the previous total and a repeated total adds nothing. A fork has its own counter and is never added to its parent.
  Cached input is reported as cache reads, and the rest of the input as input. The model comes from `turn_context`.
- **Bad or unknown rows.** A line that is not JSON (a line still being written) is skipped and counted. A usage row or
  event in a layout the reader does not know gives that session no stats at all. The PC shows it as Unknown, and
  nothing is guessed or sent for it.
- **What leaves the PC**, per hub and per UTC day: agent id, client, model, the four token counts, the number of
  sessions and of turns (assistant messages for Claude Code, token-count steps for Codex), in the shape of `POST /connector/v1/usage`. A model name that is not a plain name goes out as `unknown`.
  Never text, file paths, folder names, session ids or client versions. Nothing read is logged.
- **No liveness.** Whether an agent is working comes only from the connector's own process state, otherwise
  **Unknown**. It is never read from these files.

The [usage tests](../deploy/client/usage.test.mjs) use [fixtures with transcript text removed](../deploy/client/fixtures/usage/).

## The connector service

One service runs per connector installation (one OS account on one host, which includes a Linux account reached over
SSH). It starts at the user's logon, runs as that user, and never needs admin rights. It is the one process that speaks
for the installation: it checks in, fetches PC actions, runs file transfers and updates the connector. It serves every
hub in the key file, each with that hub's own app key, CA and origin.

```
conclave service install | remove | status      the logon entry, as the user
conclave service run                            what the logon entry starts (a small supervisor that restarts the worker)
conclave update [--check]                       update now to the newest approved version, or only say what it would do
conclave rollback                               go back to the previous verified build kept on this PC
conclave settings [<switch> on|off]             the PC user's local switches (Settings, below)
conclave version
```

### Commands

The whole command line, as `conclave` (`~/.config/conclave/conclave.mjs`) lists it. Every command runs as the PC user,
and none takes a key or a pairing code as an argument.

| Command | Does |
|---|---|
| `conclave mcp <folder>` | The folder's local stdio MCP server, started by Claude Code or Codex from the folder's entry ([How an agent signs in](#how-an-agent-signs-in)) |
| `conclave hook`, `conclave context-hook`, `conclave reminder` | Called by the folder's hooks, never by hand ([The folder hook](#the-folder-hook), [Context size](#context-size), [The one reminder line](#the-one-reminder-line)) |
| `conclave check [--folder <f>] [--probe] [--json]` | Local and read-only: one fixed reason, or "set up". `--probe` asks the hub once ([When something is wrong](#when-something-is-wrong)) |
| `conclave repair [--folder <f>] [--grant-trust] [--accept-folder-changes]` | Rewrites a moved entry and restores a trust entry that disappeared; never turns trust back on after you turned it off unless you say so |
| `conclave register --folder <f> --hub-id <id> --ca-sha256 <hex> --agent <label>` | Binds a folder and writes its entry (pairing and setup call this) |
| `conclave setup [--no-browser]` | The local screen: pairing, then setup of each agent |
| `conclave setup schema`, `request --file <path> [--check]`, `continue [--wait <s>]`, `status [--json]`, `retry <agent>` | Setup without the screen, one step at a time ([onboarding](onboarding.md#with-the-conclave-connector)); each takes `--hub <hub id>` on a PC with several hubs |
| `conclave pair --hub <https origin> --check <hub check>` | Pairs without the screen; the code is read from standard input, never the command line |
| `conclave destinations [add <folder> [--label t] \| remove <id>] [--json]` | The folders you approved for a restored team; the hub sees a label, never the path |
| `conclave restores` | How to open each agent of the teams restored on this PC |
| `conclave usage [on \| off] [--json] [--days n]` | Usage reports: on or off on this PC, or what would be sent ([Usage stats on the PC](#usage-stats-on-the-pc)) |
| `conclave hardware [on \| off]` | On a compute machine: measuring its CPU, memory and GPU for the hub ([hardware](hardware.md#measuring)) |
| `conclave service install \| remove \| status \| run` | The logon service (above) |
| `conclave update [--check]`, `conclave rollback` | [Self-update](#self-update) and its undo |
| `conclave settings [<switch> on\|off]` | The PC user's switches (below) |
| `conclave migrate [--apply \| --rollback \| --finish [--remove-legacy-ca]]` | Moves an old PC to the connector ([below](#moving-an-old-pc-conclave-migrate)) |
| `conclave uninstall [--json]` | Removes what the connector created or changed, for every hub, then the connector itself ([Uninstall and disconnect](#uninstall-and-disconnect)) |
| `conclave disconnect --hub-id <id> --ca-sha256 <hex> [--json]` | Finishes Disconnect this hub from this PC for one hub; the service calls it |
| `conclave version` | The running build's version |

### Settings

The PC user's own switches, set with `conclave settings <switch> on|off` and reported in each check-in. A switch the user
never set reports `null` and reads **Unknown** in the console. The hub cannot change them.

| Switch | Check-in field | When off |
|---|---|---|
| `auto-update` | `auto_update` | The worker neither updates by itself nor runs an `update` order ([Self-update](#self-update)) |
| `remote-cleanup` | `remote_cleanup` | A disconnect order only revokes access; nothing is removed from the disk ([Disconnect](#disconnect-this-hub-from-this-pc)) |
| `remove-connector-with-last-hub` | `remove_connector_with_last_hub` | The connector stays installed when its last hub is disconnected |
| `usage` | `usage_opt_in` | No usage or context numbers are read or sent (the default); the same as `conclave usage off` |
| `hardware` | `hardware_opt_in` | A compute machine sends no samples; the same as `conclave hardware off` |

### Install and remove, as the user

| Platform | Logon entry | Removed by |
|---|---|---|
| Windows | A scheduled task for the current user with an **At log on** trigger, made with `Register-ScheduledTask` (PowerShell). It starts `conhost.exe --headless`, so no window opens. `schtasks /create /sc onlogon` is not used: it requires administrator rights for this trigger. | `Unregister-ScheduledTask` |
| macOS | A LaunchAgent, `~/Library/LaunchAgents/com.conclave.connector.<id>.plist`, loaded into the user's GUI session with `launchctl bootstrap gui/<uid>`. | `launchctl bootout`, then the file is deleted |
| Linux | A systemd user unit, `~/.config/systemd/user/conclave-connector-<id>.service`, enabled with `systemctl --user`. Where the user has no systemd session, an XDG autostart file, `~/.config/autostart/conclave-connector-<id>.desktop`. | `systemctl --user disable --now`, then the file is deleted |

`<id>` is a short hash of the connector's folder, so a second installation under another `CONCLAVE_HOME` gets its own
entry. The entry starts Node by absolute path with the connector's launcher (`~/.config/conclave/conclave.mjs`) as a
separate argument, so paths with spaces work. Install is safe to repeat: it replaces its own entry. The entry is recorded
in the manifest as kind `service_entry`, at the one place its platform allows, so uninstall removes exactly it.

### When it crashes

- **One worker, one service.** The service's supervisor holds `run/service.json` and its worker holds `run/worker.json`.
  Each lock names its process id and start time and is created in one step, so two processes started at once never both
  get it. A second `conclave service run` or `conclave service worker` stops at once with exit code 77 and names the one
  that runs ("the connector service is already running (process 1234, started …)"). A lock whose process is gone, or
  whose id now belongs to a process started at another time, is taken over. `conclave service remove` (and uninstall)
  ends the supervisor and then the worker its lock names, and only that very process.
- **Restart.** On Windows the scheduled task's logon trigger repeats every minute while the user is logged on, so a
  service that died (a crash, or its processes ended from Task Manager) starts again within about a minute. While the
  service runs, the repeat does nothing: the task ignores a new instance, and the supervisor's lock stops a second one.
  Task Scheduler's own restart-on-failure (every minute, up to 999 times) is still set, but it covers only a start
  that fails: the window-hiding `conhost.exe --headless` ends with 0 when node is killed, so Windows saw no failure
  and connector 0.9.4 did not come back. `conclave service remove` unregisters the task before it stops the service,
  so nothing comes back after it; after a logoff the task does not run. A PC that installed the service with 0.9.4
  or earlier keeps the old task until `conclave service install` is run once more, which replaces it in place. On every
  platform the supervisor restarts a worker that stops, after a pause that grows from 2 seconds to a minute while it
  keeps failing; an error in one round (a start that fails, a state file that is locked) never ends the supervisor.
- **State files.** The key file, the folder registry, `preferences.json`, `processes.json` and `app/builds.json` are
  each changed under a lock (`<file>.lock`, waited for up to 10 seconds), so two processes never write over each
  other's change. Each write is flushed to disk before it replaces the file, and a copy is kept as `<file>.bak`; a file
  that a power loss left unreadable is read from its `.bak`. Uninstall removes the `.bak` and `.lock` files too.

### Heartbeat

The worker checks in with each hub at once after it starts, after an update or a check, and then about once a minute
(`POST /connector/v1/check-in`, "The connector's report" above). It reports:
- the connector version, the platform (`win32-x64`, `darwin-arm64`, `linux-x64`, …), and the Node and git versions;
- each client found on the PC (`claude_code`, `codex`) with its version, or `null` when its version cannot be read;
- the PC user's switches (`auto_update` and the others; a switch the user never set is `null`);
- the agents running now: an agent counts as `open` only while a `conclave mcp` process the connector started for it is
  alive. Each such process keeps a small file under `run/` with its process id and agent id, and removes it when it
  ends. A file whose process is gone is ignored and deleted. Nothing is guessed from chat files.

The hub turns this into **Online** (a check-in within 90 seconds) or **Offline since**.

### PC actions on the pinned poll

When the check-in says orders are waiting, the worker fetches them (`GET /connector/v1/orders`) over the same pinned
HTTPS connection. An order is acted on only if it is one of the fixed list and carries exactly its typed fields:

| Kind | Fields | The worker |
|---|---|---|
| `check` | none | runs `conclave check` for every folder registered for that hub, and reports one row per agent plus the service and version rows |
| `update` | `version` (`1.4.0`) | runs the update below for that version; refused while the PC user turned auto-update off |
| `restore` | `checkout_id`, `destination_id` (`dst_…`, a destination the PC's user approved; never a path) | restores a moved team into that destination ([checkout.md](checkout.md) §6): scans, waits for the administrator's scan decision and the PC user's approval of a changed folder, picks up the keys, writes the same entries as onboarding per agent, and returns the start lines. It stays open while the checkout is `rendered` or `restoring` (no clock expiry), resumes after a connector restart and ends when the checkout is cancelled; progress notes go to `POST /connector/v1/orders/:id/progress`. |
| `deliver` | `agent_id`, `items` (each `notice` from the fixed list, and a `task` id when it is about one), `agent_msg`?, `reason`? | the hub's own order: an item waits on one agent of this PC. See [Delivery orders](#delivery-orders) |
| `disconnect` | none | never comes on this poll (it has its own receipt credential); reported as refused |

An order with another kind, a missing or extra field, or any value that looks like a path or a command (a slash or
backslash, `~`, `..`, or a shell character such as `;`, `|`, `&`, `$` or a backquote) is invalid as a whole: nothing in
it runs, and the worker reports it failed with a fixed sentence. Each order id is handled once: the worker keeps the ids
it handled, so a replayed id does nothing.

### The push stream

The hub tells the connector in seconds, not at the next check-in. `GET /connector/v1/stream` (the app key, over the same pinned
HTTPS connection as every other call) is a Server-Sent Events stream that **only says "orders waiting"**: `event: orders`,
sent at once when the stream opens and each time an order is queued, and `event: handovers` when the hub makes a [key handover](#receiving-a-rotated-key-or-a-recruit) for this PC, and a comment line every 20 seconds so no proxy ends
it for being idle. The orders themselves stay the record: after every open and every event the connector fetches
`GET /connector/v1/orders`, so a stream that dropped loses nothing and an order runs once (its id is remembered).

- **Pinned, never `fetch`.** The stream is read with `https.request` and the hub's pinned CA (`hubclient.mjs`), no redirect, so a
  certificate the hub's CA did not sign is refused before any byte, the app key included, is sent.
- **One stream per PC and hub.** A second stream replaces the first. If it comes from another installation id or another
  address, the hub raises the alert `connector_stream_replaced`: a copied app key must not push the real connector off in
  silence. A PC may open at most 6 streams a minute (`429`, with `Retry-After`); the connector backs off from 2 to 60 seconds.
- **Online still means a check-in.** An open stream does not count as one. A compute machine (measure-only) opens none (`403`).
- **The hub ends it when access ends.** Suspending or revoking the app key, Disconnect, retiring the PC and a lockdown of the
  PC close the stream at once, and the hub checks again at each heartbeat.
  A locked-down PC gets no orders either (the list answers empty, the stream `423`), and its queued orders wait, without expiring, until the lockdown ends.
- **Where the hub takes a client address from.** `X-Forwarded-For` is trusted only from a proxy on the hub host (`TRUST_PROXY` defaults to `loopback`). The HTTPS compose profile fixes Caddy at `172.29.0.2` and sets `TRUST_PROXY` to that address; any other address keeps its own. Behind a proxy, set `TRUST_PROXY` to the proxy's Docker subnet in the hub `.env`, or connector pairing fails with "hub cannot be reached" (the hub answers `426` on `/connector/v1/hub`). This holds for every hub behind Caddy, not only the HTTPS compose profile.
- **Long-poll fallback.** If the stream cannot open (a proxy that holds it back, a hub without it) the connector asks
  `GET /connector/v1/orders?wait=25`: the same orders, answered as soon as one is queued. It tries the stream again every
  five minutes.
- **Caddy.** The response is `text/event-stream` with `Cache-Control: no-store, no-transform` and `X-Accel-Buffering: no`, so
  `encode` leaves it alone and `reverse_proxy` flushes each event; the 20-second heartbeat is shorter than any proxy idle
  timeout in `deploy/caddy`.

#### Measured through Caddy (20 Nov 2026)

We measured on a throwaway hub built from this branch, behind a Caddy that runs the live site block (`tls internal`,
`encode zstd gzip`, `reverse_proxy`). The client was the connector's own `hubclient.mjs` with the pinned CA, in a separate
container. The live hub was not touched. The meter script reads only numbers and fixed words, and prints no key.

- **What the connector receives.** The stream opens `200` with `content-type: text/event-stream`,
  `cache-control: no-store, no-transform`, chunked, and no `content-encoding`. The connector sends no `Accept-Encoding`, so
  Caddy's `encode` does not compress it. The first chunk is the whole open event (`: conclave stream`, `retry: 5000`,
  `event: orders`, `data: {}`). After that, a `: hb` comment arrives every 20.0 s (gaps of 20 008, 20 021 and 20 015 ms).
- **Delivery time.** We timed from the moment the operator's request leaves to the moment the connector reads `event: orders`.
  Over 13 deliveries (12 team resumes and one Stop) it took 2 to 5 ms (median 3 ms), including after idle gaps of 2 to
  4 minutes. The stream never closed and was opened once in 20 minutes. That is far inside the 10 s target: Caddy
  flushes each event at once.
- **Order shapes.** The `deliver` order the connector fetched after each event passed `validateOrder`: `{id, kind,
  payload: {agent_id, items: [{notice}]}}`. The Stop order is `{id, kind: 'deliver', payload: {agent_id, items: [],
  reason: 'stop'}}`.
- **Turn token over a long turn.** A token is issued with 15 minutes of life (900 s). It was renewed at minutes 5, 10, 15 and
  20, and each renewal gave 900 s again. A tool call with it still worked at minute 20, past the first 15 minutes. Once the
  team was paused, the next renewal was refused (`409`, `paused`), and the token stopped working at once: the next call
  got `401`. The renewal does not wait for the token to run out.

### Delivery orders

When an item needs a turn of an agent whose session key is bound to this PC, the hub makes one `deliver` order (ids and fixed
words only) and signals the stream. The items that need a turn: a task assigned or sent back with changes, a review asked, a
decision answered, a backlog task accepted, a team resumed, and messages; for a coordinator also a plan or refinement asked
(`plan_request`), a task approved (`task_approved`), a task blocked (`task_blocked`) and an operator question asked
(`decision_asked`). A directive change and a pause make no order: they show at the agent's next turn. The other coordinator
notices (re-plan, blueprint proposal, status request, overdue, released) still make none; they show at the next turn.

- Items for the same agent fold into the order still queued. A message an agent wrote (it is L2) wakes the agent at most once per
  10 minutes; one that arrives inside that window is **not dropped**: it makes (or folds into) an order that is held until the
  window ends (`release_at`), and the agent is woken then. The operator's messages are never held back: one that arrives while
  such an order is held releases it at once.
- **An order is handed out until a result arrives.** The hub marks an order `fetched` when it hands it out, and hands a `fetched`
  order out again on a later fetch once 2 minutes have passed (`handed_at`), until its result is reported or it expires (24 hours
  after the first fetch, as before). The connector marks an order handled only after it ran, so an order lost in a crash in the
  middle of a batch runs on the next fetch.
- **The result is never lost on the PC.** The connector keeps each result it could not report in a local outbox
  (`outbox/<hub>.json`) and sends it again at every check-in and at start. The hub answers `not_found` for an order that has
  its result already (or is not this PC's); the connector then drops the entry. A result is found by its order id and PC, not
  among the PC's newest orders.
- **Messages are delivered again after a new login.** A new login of an agent starts each room at the last position the agent
  confirmed (`acked_seq`), not at the last one it read, so a message it read but never confirmed (a turn that ended first) is
  delivered again; it is not lost while the PC's reminder still counts it.
- **Upkeep.** The hub expires orders on a 30-second timer (not on each connector request) and signals the stream when a held
  order is due. A delivery order's agent and reason are columns (`agent_id`, `order_reason`), the PC's open orders are found
  by an index on `(kind, state)`, and the retention job deletes finished orders 30 days after they ended (a disconnect only once
  Re-enrol PC has ended it).
- Only the hub makes this order: an administrator's `POST /api/pcs/:id/actions` refuses the kind, and a measure-only PC makes
  and takes none.
- **A connector too old for it is never sent one.** Delivery orders came with connector 0.9.4; 0.9.3 refuses them as "not on the
  fixed list". While a PC's last reported version is older than 0.9.4 (`ORDER_MIN_VERSION`), the hub keeps its delivery orders
  queued on the hub: the fetch and the stream leave them out, the check-in does not count them, and each item with a task
  waits with the reason `connector_too_old` (**Connector too old**). A reset or a Stop for such a PC is refused with a line
  that names the version to update to. Once the PC reports 0.9.4 or newer, the waiting orders go out on its next fetch (they
  still expire 24 hours after they were made). A PC that never reported a version is treated as new enough.
- **Why the order was sent** (`reason`, a fixed word, never text; none means `item`): `item` (items wait, as above) and
  `reset` (a fresh context, no items; [Reset](#reset)) are made today. The connector also accepts `team_start`,
  `write_handout` and `resume`, kept for the wake and for moving a team ([checkout.md](checkout.md)); the hub makes none of
  them yet. Any other word makes the whole order invalid.
- The connector's one result: `done` means a session started a turn on the item (the hub records the time as
  `delivered_at`); `failed` carries the fixed reason that none started (`chat_in_use`, `wake_held` on this platform) as `code`, with its sentence as `reason`.
- **The failure codes** the hub accepts, in the console's words: `pc_offline` (**Waiting for the PC**), `chat_in_use`
  (**Chat in use**), `wake_held` (**Waking is off for this agent on its PC**) and `agent_unknown` (**This PC has no folder for the agent**). The hub
  records `connector_too_old` (**Connector too old**) itself, never from a PC. Today's
  connector reports `chat_in_use` and `wake_held`; `pc_offline` and `agent_unknown` are reserved for the wake and are not
  sent yet. A reset has its own codes, such as `reset_by_hand` ([Reset](#reset)). Any other code is refused.
- The hub joins the result to the items (one delivery model): for an item with a task, `done` sets the open turn's `delivered_at` (once, clearing any reason) and `failed` with a known code sets its `delivery_reason`; a `decision` item stamps the agent's answered decisions with `delivered_at`. The console shows these in its own words (`DELIVERY_WORDS`).
- Until the wake ships on a platform the result is always `wake_held`. The connector keeps the items on the PC: its local screen
  lists them, and the folder's prompt hook shows one line at the agent's next prompt (never on Stop): fixed words and counts, such
  as "Conclave: waiting for you: 1 task assigned to you. Check `task_list` and `message_read`.", never an id or any text of the item.

### Context size

How full each agent's context is, for the console's bar ("62k of 200k · 31%"). Numbers only: the tokens in the context now,
the model's window, the percent used, the tokens of the last turn, when the transcript last auto-compacted, and the model id.
Never message text, a path or a session id.

- **Under the usage opt-in only.** While the PC's user has usage reports off (`conclave usage off`, the default), nothing is
  read and the check-in has no `context` field; the hub also drops the field from a report whose `usage_opt_in` is not
  `true`, and the console reads **Not shared by this PC**. The hub keeps only rows for the PC's own agents, one row per agent
  (`agent_context`), the latest report winning.
- **Runs the connector started** (sessions it registered): the worker reads each transcript itself, at most once a minute,
  during the turn and at its end, taking only the bytes added since its last read. For Codex it reads the session log.
- **Hand-opened chats:** the silent context hook at PostToolUse (at most once a minute) and at Stop (always) reads the
  transcript Claude Code names, only under Claude Code's projects folder, and keeps the numbers in the connector's own file
  (`context/<hub>/<label>.json`) for the next check-in. Hand-opened Codex chats are not covered yet.
- **Counting.** Each Claude Code message id is counted once (a message repeats on several rows). Context now is the last
  main-thread assistant message's input plus its cache tokens (read and written). A turn starts at a person's prompt; a tool
  result does not start one. An auto-compact (`compact_boundary`) is not a turn: it shows as a drop in the bar, and the
  console notes when it happened. For Codex, context now is the last call's total from `token_count`, the window comes
  from the log, and a turn counts from `task_started`.
- **The window** comes from a table of model ids in `contextsize.mjs`, or from the Codex log. A model not in the table reads
  "window unknown" with no percent; so does a context larger than the table's window (a long-context beta), and the hub
  also drops a reported window smaller than its context. From Anthropic's model docs, the table holds the Claude 5 models
  (Opus 5 and 5.5, Sonnet 5 and 5.5, Haiku 5.5, Fable 5, 5.1 and 5.2, Mythos 5.1 and 5.2) and Opus 4.6 to 4.8 and Sonnet 4.6
  at 1M, and the Claude 3, 3.5, 3.7, the other Opus and Sonnet 4 and Haiku 4.5 at 200k; any other id reads unknown until
  it is added.
- **Console:** admins see the bar on the agent's page (a Context card with the last turn, compacts and Reset), on its member
  row and on its open task, from `GET /api/agents/:id/context` and `GET /api/teams/:id/context`. The bar turns warn from 60 %
  and bad from 85 %; numbers not reported for 15 minutes fade.

### Reset

Reset gives an agent a fresh context. It is a `deliver` order with `reason: "reset"` and no items, made by
`POST /api/agents/:id/reset` (the operator, any agent) or `agent_reset {team_id, agent_id}` (a coordinator, only an agent of
its own team, never itself). Both are audited as `agent.reset`. A second reset while one is queued is the same order, and a
reset never folds into an item order. An agent no PC runs gets no order: the answer is `by_hand` with the person's steps.

- **Never mid-turn.** A session the connector started closes when its current turn ends, and the next item starts a fresh
  one from the task's state on the hub. The worker keeps the reset open until then (`resetIfIdle`, called by the wake before
  it starts a turn and when a turn ends), then reports it `done`.
- **A hand-opened chat** cannot be cleared by the connector: the order is answered `failed` with code `reset_by_hand`, the
  console shows the steps (type `/clear` in that chat, or start a new session), and the agent's next prompt carries one fixed
  line asking it to record its progress with `task_progress` first.
- **Until the wake ships**, every session is opened by hand, so every reset is answered `reset_by_hand`. The wake takes over
  through `setWakeOwnsSession` in `reset.mjs`: when it holds the agent's session the order waits for the turn's end.

### Reason orders

A `deliver` order may carry a reason instead of items: the turn is about the agent, not about one task. The reason comes from a
fixed list (`item`, `team_start`, `write_handout`, `resume`, `reset`, `stop`), never free text, and only an item order carries
items. The connector refuses a reason order with an item, an item order without one, and any other reason. Each reason has its
own fixed prompt (`connector/wake.mjs`). The hub keeps one open order per agent and reason: pressing again while it waits gives
the same order, and no item folds into it. A reason order that comes while a turn runs waits for that turn to end, then gets a
turn of its own, in a fresh session. It is never continued: the wake retries only work tied to a task, so the agent gets
exactly one turn for it.

**Start team** (`POST /api/teams/:id/start-turns`, the operator only, audited as `team.start_turns`). On a running team, each
member's PC gets a `team_start` order, coordinator first. The turn reads its directives (`directives_read {unread: true,
ack: true}`), checks its tasks (`task_list`) and stops. A paused team is refused (`paused`): resume it first. A member whose
key no PC holds, or whose PC is suspended or disconnected, gets no order, and the answer says so (`no_pc`, `pc_unavailable`).
`GET /api/teams/:id/start-turns` gives each member's PC (online or not), its latest Start team order and the wake's latest
report. The console shows them on the team page under **Start on PCs**.

**Stop team** is the team's pause. After each turn the wake's completion check (`/connector/v1/wake/check`) answers `paused`.
On a paused team the connector starts nothing more for the agent: the turn that was running ends as it is, and every order
still waiting fails with the code `team_paused` and its fixed sentence. Nothing is ended mid-turn; the operator's Stop on one
run does that.

**Move team with no one at the keyboard** (docs/checkout.md):
1. The move's request (`checkout_requested`) becomes a `write_handout` order for each source agent. The turn calls
   `checkout_status`, follows its steps and writes the handout with `checkout_handout`.
2. The operator renders the target. The target PC's user approves the destination and any changed folder, and allows the
   key pickup on the connector's screen. The operator decides the scan findings. When the target PC's user approved exactly
   one destination, the hub sends Restore itself after the render (`restore_sent` in the answer); with several, the
   operator picks one and sends Restore.
3. The target connector restores the team and reports the restore order done.
4. The hub then sends each moved agent with a new key a `resume` order on its new PC. The turn calls `checkout_resume`
   first, so the old keys are suspended, then `task_list`, and carries on.

### File transfers

The service is the bridge. It runs the bridge's transfer loop (`deploy/client/connector/transfers.mjs`) in its own process for
each hub, with the PC's **app key** over the pinned connection, so there is no separate bridge pairing and no plain
HTTP. The hub accepts the app key on the bridge routes as it accepts the bridge key, and a suspended PC's app key is
refused there too. The operator still approves each folder a file is saved into, and hub and connector both check
authorized paths. A file sent from the PC (`share_upload`, `channel_open` and the task tools' `local_paths`) comes only from
the sending agent's own registered folder, never from any other folder of the PC
([transfers](transfers.md#task-files-from-the-pc)). The stand-alone bridge with its own bridge key keeps working for PCs
without the connector until the pairing route is in force ("The bridge key ends" above).

Whatever folders are approved, a transfer never reads or writes inside the connector's own folder (`~/.config/conclave`,
or `CONCLAVE_HOME`: the key file, the builds and the launcher) or the old bridge folder (`~/.agent-hub`). Paths are
compared as given and by their real paths, so a link, a case variant or a Windows short name of either folder is refused
too. A receive job also never writes a file that makes git or an agent run something, in any folder: a git hook
(`.git/hooks/*`), git settings (`.git/config`), Claude settings (`.claude/settings.json`, `.claude/settings.local.json`),
`.mcp.json`, Codex settings (`.codex/config.toml`) or `AGENTS.override.md`. A folder transfer that holds one is refused
whole, before any file is written, and the reason names the kind of file.

### Self-update

The hub never sends code. It only says which versions the operator approved (`GET /connector/v1/versions/approved`).
The code comes from the Conclave repository's GitHub Releases page, and the connector trusts it only after its own
checks, independently of the hub:

1. **Approved.** The version is in the hub's approved list.
2. **Signed.** The release's manifest (`conclave-connector-<version>.json`) has a valid Ed25519 signature
   (`….json.sig`) by a release key the running connector carries in its own signed files (`release-keys.json`). An
   unsigned manifest, a bad signature or an unknown key is refused.
3. **The right release.** The manifest names exactly the version asked for and lists this PC's platform.
4. **No downgrade.** The version is above the one running. A lower or equal version is refused, whoever asks.
5. **The bytes match.** The bundle's size and SHA-256 are the ones the signed manifest states. Every file in it has a
   plain relative path under `deploy/client/`; anything else refuses the whole bundle.

Only then is the build unpacked into `~/.config/conclave/app/<version>/`, and run once (`conclave version`) to confirm
it starts and reports the version it claims. Then it becomes the current build, and the worker restarts into it.

**Key rollover.** A new release key is accepted only when the manifest it signs also carries a rollover statement for
it, signed by a key the running connector already trusts. The new build carries the new key in its own
`release-keys.json`, so the next update needs no statement.

**Auto-update off.** The PC user can turn updates off (`conclave settings auto-update off`). The worker then neither
updates by itself nor runs an `update` order, and its check-in reports `auto_update: false`, so the console can say so.

**Rollback.** The previous build stays on the PC. If the new build fails to start more than three times in a row, or the user runs
`conclave rollback`, the launcher goes back to the previous build, and only to one it verified at install, after
checking every file of it against the hashes it recorded then. A build that was never verified (a developer copy) is
never a rollback target, and nothing is fetched again for a rollback. At every start, the launcher also checks the current build's files against the hashes recorded when it was installed. A build with a changed file is never run: the launcher goes back to the previous verified build (and says so), or, with none, stops and says to reinstall. **The key file on the way back.** The build being left may have encrypted the key file (Standard isolation). When the previous build cannot read an encrypted key file (it carries no key store), `conclave rollback` decrypts the key file and writes it back in plain form before it switches, as the older connector wrote it; when the file cannot be decrypted (its secret is gone from the platform store), the rollback is refused and says so, and the PC stays on the current build. When the launcher goes back on its own, it cannot open the platform store, so it says that the key file is encrypted and that the build it now runs cannot read it: the keys are still in the file, and installing the newer connector again reads them. At the hardened level the key file belongs to the key service and is left alone. Only starts that crash early count: a worker that has run a minute takes its start back, so a PC that is offline, restarts or sleeps keeps a good update. A worker that stops because the PC has no hub yet (exit 76, as on a PC that has not run `conclave migrate`), or because another worker of the installation runs (exit 77), is not counted as a failed start either; the installer says to migrate first on a PC that still has the old setup. Only the current and the previous build are kept.

**Where the files are.** `~/.config/conclave/conclave.mjs` is a small fixed launcher that runs the current build named in
`app/builds.json`. Folder entries name the launcher, so an update never rewrites an agent folder.

Releasing a version is the maintainer's job: see [connector releases](connector-release.md).

### Git on Windows

Claude Code on Windows needs a bash for its shell tool. MinGit's `usr\bin\sh.exe` is GNU bash, but Claude Code only
accepts it when the file is named `bash.exe`, and only when `CLAUDE_CODE_GIT_BASH_PATH` is in the environment the agent
starts with; the folder's `.claude/settings.json` is read too late. So, with the private git:
- MinGit 2.56.1 is pinned (zip SHA-256 `4a92850b6e917da4fd010669b614b55dccf5b0ec333a534cc4be4700dfefdafd`);
- after unpacking, `usr\bin\sh.exe` is copied to `usr\bin\bash.exe`, and the copy's hash is checked;
- `CLAUDE_CODE_GIT_BASH_PATH` is set in the user's environment (`HKCU\Environment`, no admin) and recorded in the
  manifest, so uninstall removes it.

This lets Claude Code run `git status` using the private installation. For Codex, use Git for Windows. See the [setup guide](onboarding.md#setting-up-the-folders).

## Uninstall and disconnect

Both remove only what the manifest says the connector owns, through one engine (`connector/uninstall.mjs`):

- **An agent's run file** records its program too, so an id the system gave to another program after a crash does not
  count that agent as open.
- **`conclave uninstall`** (on the PC, no hub needed) first removes the logon service and stops its supervisor, so nothing starts the worker again (the supervisor records its worker as a process the connector started, so the removal ends it too; a worker that finds no hub left for three check-ins stops, and the connector's log is never written once its manifest is gone, so nothing re-creates the folder), then every hub's traces, the private git, the verified builds and the launcher, and last the connector's own files in its folder, then the folder if nothing else is in it. It cannot tell a hub, so it says so: the PC stays enrolled until the hub's admin uses **Disconnect this hub from this PC** in the console.
- **Disconnect this hub from this PC** (`conclave disconnect`, which the service runs after its app key is refused with a receipt) removes only that hub's traces: its folders' entries and approvals, their trust flags, their registry records and its token caches. Other hubs, the private git and the connector stay. The connector fetches the order with the receipt, stops that hub's worker and transfers first, removes, reports `removed` or `needs_attention` once, and only then drops the hub's key section, so a lost receipt can be fetched again until the report is in. If the PC's user turned remote cleanup off, it reports `cleanup_off` and changes nothing on disk; the hub's section in the key file is marked as disconnected (at the hardened level the key service marks it, and its public view shows the mark), and the service no longer checks in with that hub until the PC is paired with it again. It removes the connector too only when no hub is left and the PC's user chose that.

Before anything is removed, the processes the connector started in that scope are ended, and only those: each is recorded in `processes.json` with its program, the script it runs (the service worker's launcher) and its hub when it starts, and is ended only while its pid still runs that program with that script (read from `/proc` on Linux, `ps` on macOS and the process's command line in CIM on Windows; whatever cannot be read counts as not ours). The user's own Claude Code, Codex or Node scripts, another hub's work and a recycled pid are never touched.

Each removal checks, at the moment of change, that the entry is of a fixed kind at its fixed place, that its folder still has the identity recorded at registration, and that no link or junction is on the path. On Windows every part of the path is also checked for the reparse-point attribute of any kind (mount points, cloud placeholders and the like, not only links), in one check per run; if that check cannot run, nothing on such a path is touched. A manifest entry whose folder is no longer registered is listed and left alone. A shared setting is undone only while it holds the value the connector installed. The agent's instructions file setup wrote (`CLAUDE.md` or `AGENTS.md`) is deleted only while it holds exactly what setup wrote (its hash is recorded); an edited one is kept and listed. A full uninstall puts `CLAUDE_CODE_GIT_BASH_PATH` back as it was before setup, or removes it, only while it still holds the private bash setup set. Files, JSON and text alike (the Codex config, the git exclude list), are changed into their newest content and never written over a file that changed between the read and the write (size, time and content are compared), with the file's own line endings kept: a client saving its settings meanwhile keeps what it saved, and after repeated saves the step waits for the next run. Repositories, worktrees, chat history and the user's own settings are never touched. Every step is written to `removal.json` before the next one, so an interrupted removal resumes where it stopped; a finished one deletes it.

What is kept is listed to the user on the PC with its path and a fixed reason. The hub gets at most 20 fixed sentences with the kind and the reason, never a path. Every notice the connector shows is a fixed sentence (`connector/notices.mjs`); only a count varies.

## Codex wake

This section describes the standalone wake for Codex reviewers on older installations. For connector-managed agents, see [The wake](#the-wake). If a PC has both during migration, see [Moving an existing installation](#moving-an-old-pc-conclave-migrate) for which standalone files remain.

When the hub gives a Codex reviewer a review, a small process on the reviewer's PC starts one Codex turn in that reviewer's
own session. Nobody has to open the session and paste a wake line. The program is
[`deploy/client/codex-wake.mjs`](../deploy/client/codex-wake.mjs) (Node 18 or later, no dependencies). It runs under the
PC user's account, next to the bridge, and it is off until the user opts an agent in.

### Opting in

The only switch is a file on the PC, `~/.config/conclave/codex-wake.json`, which only the user may write (on Windows the
profile's ACL protects it; elsewhere the program refuses a file that group or others can write). Nothing from the hub, a
notice or a message can create or change it.

```json
{"agents": [{
  "name": "rowan",
  "keys_file": "C:/Users/alice/.config/conclave/rowan-keys.env",
  "session_var": "CONCLAVE_CONCLAVE_DEVELOPERS_ROWAN_SESSION_KEY",
  "workspace": "C:/Users/alice/work/rowan-review",
  "codex_session": "<codex session id>",
  "codex_exe": "C:/Users/alice/AppData/Local/Programs/codex/codex.exe"
}]}
```

- `keys_file` and `session_var`: the keys file the setup wrote and the agent's session variable, as for
  [`codex-bridge.mjs`](../deploy/client/codex-bridge.mjs). The hub address is the file's `AGENT_HUB_URL` pin.
- `workspace`: the reviewer's own review folder, not the main repo. Each turn runs there. It holds the bridge's
  `.agent-hub.json` with the same `session_var`.
- `codex_session`: a dedicated CLI session kept for this reviewer alone, so each turn continues its memory. Keep it
  closed in Codex Desktop and other clients while the bridge uses it. Desktop can hold the write lock for an open
  session, so a separate `codex exec resume` cannot continue that session while Desktop owns it.
- `codex_exe`: the absolute path of `codex.exe`. A `.cmd` or `.bat` shim is refused, because it would run through a shell.
- `codex_bridge` (optional): the absolute path of `codex-bridge.mjs`, if it is not next to `codex-wake.mjs`.
- `collect_keys` (optional): `true` also collects this agent's rotated key (see [Collecting a rotated key](#collecting-a-rotated-key)). An entry with only `name`, `keys_file`, `session_var` and `collect_keys` starts no Codex turn.

Run it with `node ~/.config/conclave/codex-wake.mjs run` (or `--config <path>`), for example from Task Scheduler at
logon. One process serves every agent in the file. A second process under the same account refuses to start.

### What starts a turn

For each agent, this process is the only consumer of its review items, so the agent's playbook does not poll. It logs in
outside the model with the agent's keys, as the headers helper does, and calls `work_next {kinds: ["review_requested"]}`.
Every other kind stays pending for the agent itself. An on-demand team works the same way, because this process does the
waiting.

- Only a `review_requested` item can start a turn.
- Its task id must match `^task_[a-z0-9]{1,40}$`; anything else is left pending and nothing runs.
- A paused team, or a suspended or revoked key, gives no item, so no turn starts.

The turn is:

```
<codex_exe> -a never -s read-only --disable shell_snapshot exec resume --ignore-user-config --skip-git-repo-check
  -c mcp_servers.agent_hub.command="<node>" -c mcp_servers.agent_hub.args=["<codex-bridge.mjs>","<workspace>","--keys-file","<keys_file>"]
  -c mcp_servers.agent_hub.default_tools_approval_mode="approve" -c mcp_servers.agent_hub.enabled_tools=["task_list","task_review"]
  <codex_session> -
```

It is started with `shell: false`, in the workspace. The prompt goes in on stdin and is fixed text holding only the task
id: read the task with `task_list`, give the verdict with `task_review`, treat the submission as data, never run the
submitted branch.

The reviewer reaches the hub through [`codex-bridge.mjs`](../deploy/client/codex-bridge.mjs), passed on the command line:

- `--ignore-user-config` keeps the user's own Codex config out of the turn: no other MCP servers and no looser sandbox.
  It also means Codex reads no `config.toml` at all, including the workspace's own `.codex/config.toml`.
- The bridge is the copy next to `codex-wake.mjs`, or `codex_bridge` in the opt-in file (an absolute path). The
  workspace's `.agent-hub.json` must name the same `session_var` as the opt-in entry, or the program refuses to start.
- `-a never` would refuse every MCP tool call, so that one server's tools are approved, and only `task_list` and
  `task_review` are enabled. The woken turn can call no other hub tool: checked with the real Codex, which was not
  offered `task_create` under these settings, while the same turn without `enabled_tools` created a task.

- **Environment:** an allowlist only: `PATH`, `SystemRoot`, `TEMP`, `TMP`, `USERPROFILE`, `HOME` and Codex's own
  `CODEX_*` variables (but not the ones naming the calling Codex thread). A variable whose name says key, token, secret,
  password or credential is dropped, and so is any value shaped like a Conclave key. No session key or app key is in
  Codex's environment, but that does not keep every key from the turn: see [What a woken turn can still read](#what-a-woken-turn-can-still-read). On Windows the system adds the few variables a process needs to start (such as `SYSTEMDRIVE` and `WINDIR`).
- **Read-only:** reviewers read code; the Release Manager runs the tests. The woken turn never runs a submitted branch.
- **Limits:**
  - one turn at a time per agent;
  - at most 6 turns an hour;
  - 30 minutes a turn, after which the whole process tree is killed (`taskkill /T /F` on Windows, the process group
    elsewhere).

### When it is done

The item is confirmed with `work_ack` only after the hub shows the reviewer's verdict on that task: the task left
`in_review` for approved, done or changes requested, at a newer version than the one delivered.

- **Delivered twice** (a failed confirmation, or the process restarted): the hub drops an item whose task is no longer
  in review, and the program checks the task before it starts a turn. A second turn never starts for a submission that
  already has a verdict, and the hub refuses a second verdict on it anyway.
- **Restarted mid-turn:** the process records the running turn's process id in `~/.config/conclave/codex-wake/<name>.json`.
  At start it stops that turn's tree first, if the id still belongs to Codex, so two turns never overlap. On Windows the
  turn already ends with the process (Node closes its children's job object), and the log says the turn "had already
  ended".
- **Codex ended without a verdict** (an error, an early exit or the timeout): the item stays pending, and one fixed line
  goes to stderr and to `~/.config/conclave/helper.log`, such as "the turn for task_… ended without a review (exit code
  1)". If Codex reports an active writer, the line tells the operator to use a dedicated review session. The wake reads stderr only to
  match one fixed text ("already has an active writer"), on a bounded tail, while the turn runs and for at most 250 ms after it exits. Raw stderr is never
  printed, saved or forwarded, and stdout is discarded. The same
  submission is tried again after 15 minutes, within the hourly limit. Its item stays first in that agent's queue,
  so the agent's later reviews wait behind it for those 15 minutes. That is acceptable for one reviewer.
- **The hourly limit counts in memory.** A restart starts the count again, so a program that keeps restarting (for
  example a Task Scheduler restart loop) can start more than 6 turns in an hour.

### The hub side

A submission is L2 and could tell the woken reviewer to read a key and paste it into the review.

- **A Conclave key** in `task_review` (as in any call) is refused by the leak guard. The administrator is alerted
  (`key_in_payload`) and the reviewer's session key is suspended.
- **Other secrets:** review text goes through the vault copy's filter before it is stored. Third-party tokens, private
  key blocks and URL user parts become `[redacted]`, and the administrator gets a `review_redacted` alert.

### What a woken turn can still read

Read this before turning the wake on for a reviewer.

The environment holds no key, but the turn runs as the same PC user. A read-only sandbox still lets it read files, and
its command line names the keys file (`keys_file`) that the bridge reads. A hostile submission could tell the woken
reviewer to read that file and put a key into its verdict, and the submitter can read the review text.

- The only backstop is on the hub: the leak guard refuses a Conclave key in `task_review`, and the redaction filter
  removes other secrets. Both match known shapes, so a key written encoded, split or reworded gets through.
- **What to do:** give the reviewer a keys file that only it uses, holding its own session key and an app key no other
  agent shares. A leaked key then costs one rotation of that reviewer's keys, and no other agent is exposed. Rotate them
  at once if a review ever contains text that looks like a key.

### The startup check

Before it waits for anything, the wake checks every entry in the opt-in file. An entry that cannot start gets one plain
line, on the screen and in `~/.config/conclave/helper.log`, for example:

`rowan: not started: the keys file C:/Users/alice/.config/conclave/rowan-keys.env has no value for AGENT_HUB_APP_KEY`

The line names the agent, each missing entry by name (`AGENT_HUB_APP_KEY`, the entry's session variable,
`AGENT_HUB_URL`, or an unreadable file named by `AGENT_HUB_CA`) and the keys file. It never holds a value. A
collect-only entry needs no session variable.

An entry that also collects keeps its collector when only its session key is missing or stale, because the collection is what
repairs it. The wake says `the wake part is not started (the collection keeps running)` and the collector runs on. A
problem the collector needs too (the app key, the hub address, the CA, the keys file itself) stops both parts. The other
entries start as usual. If no part of any entry can start, the wake logs
`no agent could start` and exits with a non-zero code, so a scheduled task or service shows a failure instead of a
program that looks alive and does nothing. A lone collecting entry whose wake part cannot start is not that case: the
collector is running, so the program stays up and the exit code is 0 until it is stopped. If a line never reaches `helper.log`, check that the program runs as the same
PC user that reads the log: the log is under that user's `.config/conclave` folder.

### Receiving a rotated key or a recruit

A rotated session key, a new key made for an agent on this PC, and a coordinator's recruit reach the PC by **key handover**
(design and hub side: [onboarding](onboarding.md#key-handover-a-rotated-key-or-a-recruit-reaches-a-connector-pc)). Nothing is pasted, and no key goes through a chat, a model,
a log or the environment.

1. The check-in answer's `handovers`, or `event: handovers` on the push stream, makes the connector read
   `GET /connector/v1/handovers` (app key; `423 lockdown` under a lockdown of all writes or of this PC, which changes nothing on the PC): ids, plain descriptions, the agents and, for a rotation, the public id of each key
   being replaced. A rotation names agents by that id; the connector finds the label whose key has it (the key service
   answers this on a hardened PC). When this PC holds none of the keys a rotation names, it calls
   `POST /connector/v1/handovers/:id/skip {reason: "key_not_held"}`, and the hub cancels the handover (`not_on_pc`). A
   Re-enrol's handover names every agent key of the PC; a key this PC lost is still taken, under a label of its own, so
   the others are not held back. When a Re-enrol's handover is skipped, the hub revokes those keys and reopens the PC's
   collected requests: `conclave setup continue` picks them up again, or `conclave setup withdraw` withdraws one.
2. Each one is listed on the connector's screen with **Allow**, its description shown as the hub's words. Nothing is
   picked up before the click, on the standard and the hardened level alike. The click is bound to the handover's id and
   covers it until it is confirmed; it is spent at confirm, or when the handover leaves the list (cancelled or expired).
3. After the click: `POST /onboard/pickup {request_id}`, then the list is saved (`handovers/<hub id>.json`, no secrets), then
   the keys are written (through the key service on a hardened PC). A rotated key is **staged** beside the old one under
   the same label; the old key stays in use. A recruit's keys are staged the same way, and its folder is built and
   registered (below). Then `POST /onboard/pickup/confirm {pickup_id, written}`. When it answers 200 (also `already: true` after a lost
   answer), each staged key replaces the old one. When it is refused for good (a 4xx such as expired, cancelled or replaced, whose body carries the hub's own code: `invalid_state`, `not_found` or `conflict`), the staged keys are discarded and the old keys go on; a 401, 408, 429 or 5xx answer, or a bare 404 or 409 without the hub's code (a misrouted relay), counts as no answer, and the keys stay staged for the next run.
   On a hardened PC the pickup goes through the key service's relay, which keeps the new keys and gives the connector one-time references (above), and the key service does the staging (`stage_agent`, `commit_staged`, `discard_staged`, `label_for_key`): the key service runs its own copy of the connector's code (`app\`, which only administrators may change), so after an update to a build with key handover an administrator must put the new build there and restart the key service before a handover can be taken. Until then the key service refuses these steps, nothing is swapped, and the handover waits (it expires after 24 hours as any other).
4. A crash before the keys are written picks up again; a crash after they are written only confirms, then swaps or
   discards. The old key works until the confirm, so the agent is never left without a working key.
5. A recruit's folder name and its team's name come from the hub. The folder is built only inside the team's root on this
   PC (beside the team's other agents, else under the root of the request that set the team up here, else the default
   root), as a real path: each name follows the transfer rules (no `..`, no reserved name), and no folder below the root
   may be a link or junction. Anything else is refused and reported with
   `skip {reason: "folder_refused"}`, so the hub cancels the recruit.

The Codex wake's `collect_keys` and `setup.mjs key` no longer collect anything: the hub refuses their routes.

**After a possible leak.** A rotation answered "Yes, or I'm not sure" also replaces this PC's connector app key
([onboarding](onboarding.md#key-handover-a-rotated-key-or-a-recruit-reaches-a-connector-pc)). The old app key is refused
at once, also for the handover, so until the PC user pairs again (`conclave pair` with the new code the operator was shown
once) the connector cannot list the handover and no agent on this PC gets a session or turn token. The agents' session keys
stay valid: after pairing they work again, and the handover is picked up as above, within its 24 hours.

**What the operator can still do by hand.** When the connector cannot be paired again in time, or the operator wants no
connector involved, there are three ways. **Revoke** the agent's key in Keys: it stops at once, and the agent needs a new
key later. Or **bind the key Free**, then **Rotate and show the key once**: a free key has no connector PC, so the new key
is shown raw, once, in the console, and the person puts it on the PC by hand (`setup.mjs key` is refused). Or **Re-enrol
PC**: the PC pairs the connector again with the new code, and one handover moves every agent key on it to the new app
key (on a PC that holds none of them the keys are revoked and the requests reopened, [onboarding](onboarding.md#later)).

### Not covered

- Showing the woken turn in the operator's own desktop chat.
- Agents other than opted-in Codex reviewers.
- App keys: a key prompt (see Collecting a rotated key).

Checked with codex-cli 0.167 on a local dev hub. Two reviews in a row woke two turns and got two verdicts. A restart
mid-turn led to exactly one verdict.

## Moving an old PC (`conclave migrate`)

One release runs both sides: the hub serves the old helper and the connector together, so no PC breaks while it moves. The move is a command the user runs, never a side effect of an update, and it can be undone until the user says it is final.

- `conclave migrate` prints a plan and changes nothing. It stops with a named problem if the hub is plain HTTP (give `--https-origin`, `--ca-file` and `--ca-sha256` for the pinned HTTPS address), if the saved CA file no longer matches its recorded fingerprint, or if nothing of the old layout is left. It also asks the hub about each agent's key (one sign-in per agent over the pinned connection; the answer is the hub's, no key is printed) and lists the agents the hub reports as revoked, suspended, expired or unknown on one line: `Retired: will be skipped (n): <label> (<folder>); …`. If the hub cannot be reached, it says so and the plan still prints.
- `conclave migrate --apply` signs every agent in over the pinned connection before it changes anything. Each check ends its own session, so the PC key's limit of live sign-ins (default 100) is not used up by the move. If the hub still answers that the limit is reached, migrate says so, with the numbers, and tells the user to raise "Login limit" on this PC's key in the console; before the move that changes nothing, after it the move is rolled back. An agent the hub reports as retired (its key is revoked, suspended, expired or unknown) is **skipped**: its folder, `.mcp.json` and key lines stay exactly as they were, it is not copied into the key file, and the summary lists it. Any other refusal, or no answer, stops with nothing changed (if every agent is retired, nothing is changed either). It also asks the hub for its own id (`GET /connector/v1/hub`, believed only if it names the pinned address; a hub that cannot say it is refused with nothing changed). Then it stops the old Codex wake (only a process whose command line names `codex-wake.mjs`) and the old stand-alone transfer bridge (`agent-hub-bridge.mjs run`), so file transfers run in the connector's service with the app key from the key file (`conclave service install` if it is not installed). It copies the hub key and each agent key into the key file, in the section `<hub id>@<CA fingerprint>`, so a lookup never falls back to another hub, replaces each folder's `agent-hub` entry with the `conclave` entry (other servers in `.mcp.json` stay), replaces the bridge table in a Codex config that setup wrote (a hand-written one is left alone), binds the folders, and signs every agent in again through the connector. Only then does it remove the old pieces it replaced: `setup.mjs`, the headers helper, the Codex bridge and wake files, `keys.env`, `onboarding/state.json` and each moved folder's `.agent-hub.json`. If any step fails, everything is put back and the command says why. The old shared pieces go once every live agent has moved; a retired agent that was skipped does not keep them. If a live agent could not be moved, they stay.
- **A Codex agent with its own keys file.** Setup never recorded an agent whose Codex bridge entry names its own `--keys-file` (for example `rowan-keys.env`), so `discover` cannot list it. `conclave migrate` also reads `codex-wake.json`: a workspace listed there whose `.codex/config.toml` runs the old bridge with `--keys-file` is moved too. Its session variable is read from the folder's `.agent-hub.json`, its key from that keys file (never printed), and it goes through the same check, rollback and `--finish`. The old Codex wake keeps running for such an agent: migrate does not stop it, and leaves `codex-wake.json`, `codex-wake.mjs`, `codex.mjs`, `codex-bridge.mjs` (the wake loads its bridge from there), the agent's own keys file and the folder's `.agent-hub.json` (the wake checks it) in place. The standalone wake remains in place while `codex-wake.json` lists a workspace, including for agents that have moved.
- **A PC that already moved.** `conclave migrate` also runs after a first move, even after `--finish`: the hub comes from the key file, only folders still on the old layout are moved, the moved ones are left alone, and a rollback undoes only what that run did (it never removes the hub's section or the other agents' keys). Before `--finish`, a second move is refused with `finish_first` (it would lose the first move's rollback copies): run `--finish` first, removing any retired folders it names. The dry run lists what it would move.
- Every file is saved before it changes (mode 0600, in a folder of that run's own under `migration/backups`, so a second run never writes over the copies of the first). `conclave migrate --rollback` restores them byte for byte, including the removed old pieces, except a file edited or recreated since, which is kept and listed. It removes the key-file section and bindings this move created, and the folder-trust entries it added to `~/.claude.json` (only those keys). It does not restart the old Codex wake or the old transfer bridge.
- **A move a crash interrupted.** If the PC crashed or lost power during `--apply`, the journal still says the move was in progress. The dry run says so, `--apply` first rolls that move back from its own copies and then makes the move again, and `--rollback` only rolls it back. The interrupted run's copies are kept until `--finish`. If that rollback fails, `--apply` changes nothing else and says where the copies are (`interrupted_move`).
- `conclave migrate --finish` refuses while a skipped agent's folder is still on the PC (with its old `agent-hub` entry), and names it. There is no `--retire` command: the way out is to remove those folders yourself, then run `--finish` again. It deletes the rollback copies of every run, including the saved old pieces; after that the move cannot be undone. `--finish --remove-legacy-ca` also unsets `NODE_EXTRA_CA_CERTS` (it also works on a move that an earlier plain `--finish` already finished, then touching only that setting), only if it points at the old `hub-ca.pem`, that file is this hub's pinned CA, and the key file holds the pinned section. Otherwise it is left.
- Until a folder is moved, `conclave check` names it first (`old_layout`) and gives the command to run. `conclave migrate` is the only place that knows the old layout; the rest of the connector keeps no fallback for it. The global Codex entries are not part of this release's move.
- The old client files are removed from the repository the release after this one. There is no compatibility with the old bridge: a PC either removes the old version before installing the connector, or runs `conclave migrate`.

## Restore on this PC

The PC's user decides where a restored team may be built. `conclave destinations` lists the approved destinations,
`conclave destinations add <folder> [--label text]` approves one and `conclave destinations remove <id>` ends it; the
connector's local screen has the same add and remove forms. Only the id and label go to the hub (the console's Restore
names the id), never the path. `conclave restores` shows the restores in progress, what each waits for and the start
lines of finished ones. A folder that holds agent config of its own is built without trust and waits for the PC's user:
"Approve folder" on the local screen, or `conclave repair --grant-trust` in that folder. The service never asks.

An approved destination keeps the filesystem identity its folder had when it was approved. If the folder is swapped
afterwards (removed and made again, or replaced by a link or junction to another place), the destination is no longer
reported to the hub, a restore into it fails with a sentence saying so, and the local screen shows "The folder was
replaced since you approved it". The PC's user approves it again with `conclave destinations add`, which records the new
identity under the same id. A destination approved before identities were recorded is not blocked.

A restore that fails before the hub confirmed the key pickup removes the agent keys it wrote, so no unused key stays in
the key file (the old sessions keep running). When the restore is tried again, a folder it already bound keeps its
label: it is not renamed `folder-2`.

Restore runs git through the same wrapper as the `commit` tool: the clone's hooks are off (an empty hooks folder),
fsmonitor is off, and no `GIT_*` variable is inherited. Before its first git call in an existing clone it reads that clone's
`.git/config` (without following includes) and stops, naming the setting, if it holds one that makes git run a program
the command line cannot switch off: an `include` or `includeIf`, a filter, a diff or merge driver, `core.sshCommand`,
`core.gitProxy`, `core.askPass`, `core.pager`, `core.editor`, a credential helper, the `ext` protocol or an upload-pack
program. A clone whose `.git` is not a folder is refused too. The config scan also lists each hook in the clone's
`.git/hooks` that is not a `.sample`, as it lists tracked hooks.
