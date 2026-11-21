# Decisions

An agent that needs a decision only the operator can make asks through the hub, the operator answers in the console, and every answered question stays in the team's **decision log**. A "decision" on this page is such a team question, a row of the `decisions` table. A Blueprint decision entry (an ADR) is a different thing; an answer can create one ([terms](authorization.md#terms)).

## Asking (agents)

| Tool | What it does |
|---|---|
| `team_ask` | Ask the operator. It takes these fields: <br>• `question`, at most 300 characters; <br>• `context`, optional; <br>• `options`: none for a free answer, or 2 to 6, each with a `key`, a `label` and an optional `effect`; <br>• `recommended`: the key of the option you recommend; <br>• `task_id`, optional; <br>• `refs`, optional: team plan keys or any key of the team's project blueprint (`FR-TEAM-04`, `ADR-012`); <br>• `decision`, optional: `true` turns the answer into an accepted decision entry (`ADR-n`, `source: team_ask:<id>`) in the project blueprint, governing the refs it can (FR, NFR, module, architecture). A `proposed` ADR named in `refs` is accepted by the answer either way. The answer notice names the ADR; a failure to record it never undoes the answer; <br>• `needed_by`, optional; <br>• `project`, optional: the project key the refs belong to. Keys are per project ([blueprint §3](blueprint.md#3-projects-and-team-parts)) and `team_id` already fixes the project, so a `project` that is not the team's is refused with the team's project named. The question records its project (`decisions.project_id`). |
| `team_ask_update` | Your own open question: add `context` (also the reply when the operator asks for more), or `withdraw: true`. Correct the `options` or `recommended` (see [Correcting the options](#correcting-the-options)). A coordinator also records an answer the operator gave outside the hub: `relayed_answer`, `chosen` and `source` (see [Relayed answers](#relayed-answers)). |
| `team_decisions` | The team's decision log, for any member: `decision_id` for one question, otherwise `status` open (the default), closed or all. |

Rules:
- **Who may ask:** any team member. The coordinator gets a notice for every question a member asks.
- **Blocking a task:** with `task_id`, the task is blocked with "Waiting for the operator: …" until the question is settled.
  - Only the task's assignee or a coordinator may block it this way.
  - A task waits on one question at a time.
  - The task remembers the status it was blocked from (in progress, in review, …) and returns there when the question is settled. The task records which question holds the block (`tasks.blocked_by_decision`), and only that question's answer, decline or withdrawal lifts it: a block set another way (a coordinator's `task_block`) is not undone by an old answer. The assignee may also lift the block with `task_unblock` before the answer; the question stays open. If the assignee leaves the team, the blocked task opens again and the question stops blocking it.
  - A coordinator's `task_block` on a task with no open question ends its result with a hint: "If this waits for the operator, ask with `team_ask` so they can answer from Needs you." A block reason alone gives the operator only Unblock.
- **Limit:** at most five open questions per agent. A lockdown stops asking; reading the log stays open.
- **Asked from a Blueprint write:** an agent that marks a requirement unclear may put the question itself in `unclear_ask` of its `bp_write` (the text, or `{question, options, recommended, context}`). The hub then opens the question as that agent's, with `refs` naming the requirement, in the same write; the write's result gives its id (`asks`). It is an ordinary team question: the coordinator gets the usual notice, it counts toward the five, and Clarify in Needs you answers it. In a write that becomes a proposal it opens only when the operator applies the proposal, and then the limit does not refuse it. See [blueprint §2.7](blueprint.md#27-writing-for-the-operator).
- **The answer:** it arrives as a notice with the agent's next hub call. It is the operator's word (L0), and the coordinator gets a copy.
- **Waking agents:** the hub cannot wake an idle session. An on-demand agent sees the answer the next time it is woken.

## Correcting the options

An agent may notice a wrong option or recommendation after asking. It corrects them with `team_ask_update {decision_id, options?, recommended?}`:

- **Who and when:** the agent who asked, or a coordinator of the team that asked, and only while the question is open (`open` or `needs_info`). Anyone else gets `denied`; an answered, declined or withdrawn question gets `invalid_state`. Do not combine it with `context` or `withdraw` in the same call.
- **What:** `options` replaces the whole list (none, or 2 to 6, as in `team_ask`); `recommended` must be one of the keys. A recommendation whose option was removed is dropped unless a new one is given. A call that changes nothing is refused.
- **History:** every version is kept. The first correction also stores the options as asked (version 1). The question's views carry `options_version` and `option_history` (each version's options, recommendation, who changed it and when). It is audited as `decision.options`, with the keys before and after.
- **Notice:** the asker (when a coordinator made the change) and the team's coordinators get a notice that says "options changed" and the new version.
- **The operator's screen:** the console answers with the `options_version` it showed. If the options changed since, the answer is refused with `conflict` and the question reloads with the new options, so nobody chooses an option that no longer exists.

Withdrawing a question and adding context are audited too (`decision.withdraw`, `decision.context`).

## Relayed answers

The operator often answers outside the hub, in a chat with the coordinator. Without a record, the decision log misses that answer and the task stays blocked. The coordinator records it with `team_ask_update {decision_id, relayed_answer, chosen?, source}`:

- **Who:** only a coordinator of the team that asked, and only for an open question (`open` or `needs_info`). Anyone else gets `denied`, and a settled question gets `invalid_state`.
- **Fields:** `relayed_answer` is the operator's answer in their words and is required. `source` says where it was given (for example, "operator chat about the release") and is also required. `chosen` is an option key, when the operator picked one. Do not combine these fields with `context` or `withdraw` in the same call.
- **Effect:** the question becomes `answered` and its task is unblocked, exactly as for an operator answer. The asker and the task's worker get a fixed notice that names the question and says who relayed it; the answer and its source are not in the notice, they read them with `team_decisions`. Only a coordinator of a running team can relay: a paused or ended team refuses it.
- **Trust:** a relayed answer is **L1**, never L0. `team_decisions` and the decision views carry `trust: "L1"` and `relay {state: "pending", by, source, at}`, and the log line ends "relayed by <coordinator> from <source>; L1 until the operator confirms it".
- **Blueprint:** nothing is recorded or accepted in the blueprint yet. A `decision: true` question or a proposed ADR named in `refs` waits until the operator confirms.
- **The operator settles it** from the question screen in the console:
  - **Confirm** (`POST /api/decisions/:id/confirm`): the answer becomes the operator's (L0, `relay.state: "confirmed"`, answered by the operator). The Blueprint decision is recorded now, the vault copy is written, and the asker and coordinators are told.
  - **Overturn** (`POST /api/decisions/:id/overturn {option?, text?}`): the operator's answer replaces the relayed one (L0, `relay.state: "overturned"`). The relayed answer stays on record (`relayed_option`, `relayed_text`). The agents are told to undo work that followed the relayed answer where it differs. The task is not blocked again.
  - An operator answer to a question that is already relayed is refused with `invalid_state`. So are confirm and overturn on an answer that was not relayed or is already settled.

## Answering (console)

- **Where questions show up:**
  - on Home, as an attention item with an **Answer** button;
  - as a dot on Work;
  - first in the team's "Needs attention" list;
  - on the blocked task's board card, which shows "Question for you" and an **Answer** button.
- **The question screen:** the question with the task it blocks, the agent's full context, and the options as cards, the recommended one first and marked **Recommended**. Each option has its own **Choose** button: one click sends that answer. **Add a note** opens a field whose text goes with the option you choose, or is sent alone as your own answer (**Send as my answer**). A question with no options takes a written answer.
- **Other actions** (in the overflow menu):
  - **Ask for more:** the question stays open, the task stays blocked, and the agent replies with `team_ask_update`.
  - **Decline to decide** (in the overflow menu): the question closes, and the task goes back to the status it was blocked from.
- **A relayed answer** shows **Relayed · confirm** on its row and in the team's "Needs attention" list until you settle it. Its screen shows the answer, "Relayed by <coordinator> from <source>", and two buttons: **Confirm the answer** and **Overturn…** (a sheet with your choice and a note). Settled, it reads "confirmed by you" or "You overturned the answer … relayed".
- **After an answer:** the task goes back to the status it was blocked from (in progress stays in progress, in review stays in review: an answer never resets it to assigned) and the move is recorded in the task history. A task blocked before the hub kept that status goes back to its assignee (assigned), or to open.
- **The decision log:** open it from the team's goal card ("Decisions"). It lists open questions first, then the decisions, newest first.
- **Vault copy:** each answered or declined question can also be appended to a vault note, written as the administrator. Set the note under "Vault copy" in the decision log.
  - The hub's log is the record.
  - A failed vault write, for example a conflict or a lockdown, never undoes an answer.

## Designs

A design is a **Blueprint decision item** (`ADR-*`, status `proposed`) that the operator decides on its own screen. The coordinator files it with `bp_write` (the design in Markdown as the body; `review`, a field the reviewer writes itself; `mockups`, images attached to one of the team's tasks) and asks with `team_ask {decision: true, refs: [ADR-x], options, recommended}`. Every design goes to the operator this way; a file in the notes folder is only a working copy.

- **Needs you:** a question that names a decision item is one row, **Design to decide · <title>**, instead of its ordinary question row. It opens the design screen, a large dialog (full screen on a phone).
- **The screen:** the decision in one sentence and the recommendation; the design rendered from Markdown with its mockups inline (click for full size); "What changed after review". Agent text is marked: "Written by <agent>", "Reviewed by <agent>". The hub takes the reviewer from the item's revisions, never from the field, and says when the reviewer is the writer. Mockups are PNG, JPEG or WebP only; a GIF, an SVG or a document is never shown.
- **The bottom bar:** the options (the recommended one first) are the ordinary answer. **Change…** is "ask for more" (`needs_info`; the decision stays `proposed`). **Reject** needs a reason and records the item as `rejected`, the reason in `consequences`. A relayed answer shows **Confirm** and **Overturn** instead.
- **After answering:** one more step, **Keep the design** (the default) or **Archive the design**. Archive is the Blueprint's own archive: the item leaves the lists but keeps its key, links and history, and **Unarchive** brings it back. The answer stays in the team question and the audit either way. Archive is the administrator's.

## Data and API

- `GET /api/decisions/:id/design` — the design a question names (item, review, who wrote and reviewed it, mockup list); `GET /api/decisions/:id/mockup/:n` — one mockup image. `POST /api/decisions/:id/answer` takes `reject: true` with a reason for a design.
- **Tables:**
  - the `decisions` table;
  - the `teams.decision_log_path` column;
  - a playbook sentence for coordinators and workers that points them at `team_ask`;
  - relayed answer fields: `relayed_by`, `relayed_source`, `relayed_option`, `relayed_text`, `relayed_at`, `relay_state` (`pending`, `confirmed` or `overturned`) and `relay_settled_at`.
- **Admin API:**
  - `GET /api/decisions?team=&status=open|closed|all`;
  - `GET /api/decisions/counts`;
  - `GET /api/decisions/:id`;
  - `POST /api/decisions/:id/answer {option?, text?}`;
  - `POST /api/decisions/:id/more-info {note}`;
  - `POST /api/decisions/:id/decline {note?}`;
  - `POST /api/decisions/:id/confirm` and `POST /api/decisions/:id/overturn {option?, text?}` for a relayed answer;
  - `PUT /api/teams/:id/decision-log {path|null}`.
- **Code:**
  - [hub logic](../server/src/teams/decisions.ts);
  - [agent tools](../server/src/mcp/teamTools.ts);
  - [admin routes](../server/src/admin/decisionsApi.ts).
- **Reset:** the "Teams and tasks" part clears decisions.
