# Platform requirements

These requirements describe the supported Conclave platform. The [system specification](specification.md) defines its scope and trust model. The subsystem guides define behavior, limits, and exceptions. The [acceptance checklist](acceptance.md) identifies how to verify those contracts.

Conclave's project Blueprint holds the operator's backlog, decisions, and verification status. The identifiers below retain the existing Blueprint identifiers where available. Named rows capture platform contracts that have no corresponding project item key in this catalog. Use the [Blueprint export guide](blueprint/README.md) to reconcile these contracts with a specific hub's project records.

## Identity, authority, and delivery

| Requirement | Platform contract | Reference |
|---|---|---|
| `FR-KEYS-01`–`03` | Give each agent a stable ID. Authenticate an app installation separately from the agent using it. Bind session tokens to the app and recheck key state. Inventory credentials and reveal newly issued secrets once. | [Authorization](authorization.md) |
| `FR-KEYS-04`–`07` | Keep administrator-assigned roles authoritative. Provide setup and session handoff instructions, record login and device activity, and revoke keys and end logins when archiving an agent. | [Authorization](authorization.md), [Roles](roles.md), [MCP](mcp.md#client-setup) |
| `FR-AUTHZ-01`–`04` | Deny by default and enforce the current decision at the hub. Separate tool invocation from resource grants. Narrow session grants with app caps, honor explicit denies, and expose the decision through policy inspection. Support versioned rules and temporary access requests with purpose, scope, and expiry. | [Authorization](authorization.md) |
| `FR-MSG-01`–`04` | Support direct and group conversations with durable room order, bounded reads, and explicit acknowledgement. Deliver eligible work at least once. Recheck access on delivery, and let the operator inspect, search, and export conversations. | [MCP](mcp.md#calling-patterns), [Architecture](architecture.md) |
| Console access and delegation | Keep human console accounts separate from agent credentials. Scope member reads, counts, cursors, and exports to current project grants and components. Require TOTP for external members. Limit deciders to their current team assignment, allowed acts, and access-request ceiling. Keep administrator fallback and overrides auditable. | [Multi-user console](multi-user.md) |
| `NFR-SEC-01`–`05` | Preserve content provenance and render untrusted text as data. Protect credentials, record security-relevant actions and actor identities, and support lockdown with an operator recovery path. Protect the console with password authentication, session cookies, CSRF checks, and TOTP where required. | [Threat model](threat-model.md), [Authorization](authorization.md) |

## Team work and project governance

| Requirement | Platform contract | Reference |
|---|---|---|
| `FR-ONB-01`–`03` | Onboard a PC with an operator-issued prompt and one pending request per app key. Pair the connector with a single-use code given apart from the prompt, and keep long-lived secrets out of model-visible material. | [Onboarding](onboarding.md) |
| `FR-ONB-04`–`07` | Review project, roles, and access in one approval. Treat proposed rules and requirements as data until the operator acts. Let the setup client wait and pick up credentials, verify the setup, and confirm membership before starting an approved team. Support PC-bound and portable session keys. | [Onboarding](onboarding.md), [Directives](directives.md#from-onboarding) |
| `FR-TEAM-01`–`03` | Apply the project's task intake rules. Keep backlog acceptance, discard, and demotion under administrator control. Enforce role and version checks on assignment, claiming, and start. Track on-demand team work and leave agent process execution with the local client or connector. | [Task lifecycle](specification.md#task-lifecycle), [MCP](mcp.md#team-modes) |
| `FR-TEAM-04`–`08`, `12`–`14` | Tie review to the current submission and any published share version it names. Support resubmission and withdrawal. Keep self-review forbidden and apply the configured review and completion checkpoints. | [Task lifecycle](specification.md#task-lifecycle), [Acceptance](acceptance.md#collaboration-and-teams) |
| `FR-TEAM-09`–`11`, `15`–`17` | Support blocks, cancellation, and return to a valid previous state. Record the holder and phase of each hand-off. Distinguish queued work, active work and review. Use delivery and progress records to show queued and overdue work. Provide bounded recruiting and status reporting. | [Task lifecycle](specification.md#task-lifecycle), [MCP](mcp.md#team-modes), [Blueprint reports](blueprint.md#7-status-reports) |
| Team questions and decisions | Ask the appropriate operator or decider for a decision, retain who acted and why, and release only the task block owned by that question. Keep a coordinator's relayed answer distinguishable from a confirmed operator answer. | [Decisions](decisions.md), [Multi-user console](multi-user.md#13-who-decides-for-a-team) |
| `FR-PLAN-01`–`04` | Keep the Blueprint at project level with scoped team parts. Support implementation requirements and acceptance criteria, research lines with evidence, milestones, and links to team tasks. | [Blueprint](blueprint.md) |
| `FR-PLAN-05`–`07` | Provide versioned edits, per-item provenance and conflicts, and reviewable proposals where direct edits are outside an agent's scope. Support scoped start-over, per-team report requests, and a readable operator console and export. Make paper support traceable to decided evidence. | [Blueprint](blueprint.md) |
| Blueprint list analysis | Let the reader break each long Blueprint list down: one-click gaps, filters with counts, a two-way count table, and grouping and sorting, all acting on one filter state, with saved views and stable links. Every count is the server's, from the same filters and the reader's scope as the list it opens. See [Blueprint screens: user needs](#blueprint-screens-user-needs). | [Blueprint](blueprint.md), [Dashboard UX](dashboard-ux.md) |
| `FR-DIR-01`–`02` | Keep standing rules scoped, versioned, and confirmable. Apply exemptions to the current reach, settle obsolete notices, and let the operator review and file rules suggested by agents. | [Directives](directives.md) |
| Team checkout | Move a whole team while preserving hub identity and work. Require checkpoint or explicit exception, verify handouts, and control source and successor keys through the restore. Consume a handout only on accepted resume. Keep client and target verification limits explicit. | [Checkout](checkout.md), [Acceptance](acceptance.md#checkout) |

## Data, knowledge, and operations

| Requirement | Platform contract | Reference |
|---|---|---|
| `FR-VAULT-01`–`04` | Confine access to permitted paths under the configured vault alias. Use revision-checked writes with recoverable history and conflict reporting. Observe external edits and recover committed write intents. Keep current file bytes on disk and make browsing, history, and access available in context. | [Vault](vault.md), [Filesystem consistency](filesystem-consistency.md) |
| `FR-VAULT-05` | Derive knowledge from versioned vault evidence. Limit results and delivery to permitted sources, retain provenance, and distinguish curator output from independent review. | [Vault and knowledge graph](vault.md#deriving-knowledge) |
| Hub records in the vault | Write filtered Markdown copies of hub records to its reserved folder. Keep the database authoritative, limit reads to explicitly authorized readers, and exclude the copies from agent search, backlinks, and graph indexing. | [Hub folder](vault.md#the-hubs-folder-99-conclave) |
| `FR-SHARE-01`–`04` | Keep versioned share manifests, recheck access and membership on reads, and treat vault promotion as a separately authorized write. Use bounded inline or bridge transfers with approved local paths, offsets and integrity checks. Keep peer relay bytes off hub disk. | [Transfers](transfers.md) |
| `FR-FDBK-01`–`07` | Let agents find, file, read, and add evidence to feedback. Merge duplicates, bound usage by agent identity, filter restricted references and credentials, and provide operator triage, assignment, and read state. | [Agent feedback](feedback.md) |
| `NFR-OPS-01`, `NFR-REL-01` | Run as a single self-hosted hub with bounded requests, waits, concurrency, and transfer buffers. Define which state is durable and which in-flight data can be lost. | [Architecture](architecture.md), [Deployment](getting-started.md#container-deployment) |
| `NFR-REL-02` | Verify restart, migration, backup, and restore with populated data. Keep the database, blobs, vault, and credential pepper recoverable together. Profile the 1 vCPU and 2 GB RAM deployment target before making capacity claims. | [Acceptance](acceptance.md#release-checks), [Deployment](getting-started.md#container-deployment) |
| `NFR-USE-01`, `FR-OPS-01` | Let operators answer who is connected, what they can do, and what they have done. Keep Home and detail screens navigable on desktop and mobile, in both themes, with accessible controls and stable links. | [Dashboard UX](dashboard-ux.md), [Design guidelines](design-guidelines.md) |

## Blueprint screens: user needs

The operator holds a large Blueprint, and each screen is one long list. Each screen answers one question and gives the tools to break its list down: the gaps that need attention, filters by the screen's dimensions, a count table across two of them, and grouping. Collaborators with limited access read the same screens, with counts limited to what they may read. A view limited to what they may decide is future work.

| Screen | The reader's question | What the reader needs to see | What the reader does there |
|---|---|---|---|
| Requirements | Is what we promised being built, and what's missing? | Each requirement's status (draft, agreed, built, verified) and whether it is unclear, with the acceptance criteria and tasks behind it. The gaps: no acceptance criteria, no task, or unclear. | Answer an unclear requirement, approve a proposed change, set the priority. |
| Acceptance | Can I trust it's done? | Each criterion as passing, failing, or never tested, with the last evidence and its date. What broke since the last pass. | Open the evidence, ask for a rerun. |
| Hypotheses | What do we believe, and how sure are we? | Untested, testing, confirmed, refuted or inconclusive, with the findings linked to it. The next planned test, the claims and papers that depend on it, and which hypotheses are stale. | Pursue, drop, or approve a test. |
| Findings | What did we learn, and what does it change? | Newest first, with what each finding is linked to, how confident it is, and which claims it affects. Findings linked to nothing are flagged. Whether a finding supports or contradicts an item comes later, with a link direction. | Link, accept, or flag a finding. |
| Milestones | Are we on time, and what blocks the next one? | A timeline with the share of requirements met, whether it is late against its date, and the blockers of the next milestone. | Move a date, cut scope. |
| Risks | What could hurt us, and is someone handling it? | Likelihood and impact, owner, and mitigation state. The milestone each risk threatens, and the issues it became. | Accept a risk, assign a mitigation. |

Every screen opens on its list with the gaps one click away. Each item shows its chain, and the reader can follow it from one item to the next:
- hypothesis, then finding, then claim;
- requirement, then acceptance criterion, then task, then milestone.

The chain is shown on each item's page.

The [risk register](risk-register.md) records deployment and recovery limits. Broader quota coverage (`NFR-OPS-02`) and a consolidated system-health view (`FR-OPS-02`) remain [roadmap work](roadmap.md).
