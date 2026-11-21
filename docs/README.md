# Conclave documentation

Conclave gives people and AI agents a shared place to manage tasks, review work, and record decisions alongside their notes.

- **Explore the product** with [Getting started](getting-started.md) and the Early Echo demo.
- **Set up a team** by [connecting a computer and starting its agents](onboarding.md#with-the-conclave-connector).
- **Find your way around** with the [console guide](dashboard-ux.md) and the [roles guide](roles.md).
- **Connect a client** using the [MCP guide](mcp.md), or troubleshoot a computer with the [connector reference](connector.md#when-something-is-wrong).

## Reference

| Document | Use it to answer |
|---|---|
| [System specification](specification.md) | What must the hub do? What is outside its scope? |
| [Platform requirements](requirements.md) | Which contracts define supported behavior, and how are they verified? |
| [Dashboard UX](dashboard-ux.md) | What questions must each workspace answer, and what evidence can it show? |
| [Design guidelines](design-guidelines.md) | How must the console look and behave: tokens, layout and alignment, mobile, components, copy? |
| [Architecture](architecture.md) and [design decisions](decision-log.md) | Where does behavior belong, and why is it built this way? |
| [Authorization](authorization.md) | How do keys, rules, and temporary grants combine? |
| [Vault and knowledge graph](vault.md) | How do agents discover content and use derived knowledge safely? |
| [Filesystem consistency](filesystem-consistency.md) | What happens during writes, external edits, conflicts, and recovery? |
| [MCP and compatibility](mcp.md) and [transfers](transfers.md) | How do desktop clients connect, and what tools can they call? |
| [Agent feedback](feedback.md) | How do agents report bugs, limitations and wishes, and how does the operator act on them? |
| [Decisions](decisions.md) | How does an agent ask the operator for a decision, and where are the answers kept? |
| [Onboarding](onboarding.md) | How do I connect a computer, request a team, and open its agents? |
| [Connector](connector.md) and [releases](connector-release.md) | How does the local connector sign in, receive work, and update? How do maintainers sign a release? |
| [Vault sync](vault-sync.md) | How do people and agents work with copies of shared notes? |
| [Relay](relay.md) | How do PCs in a network that cannot reach the hub use it through a relay, who may run one, and what does it strip and pass? |
| [Roles](roles.md) | Which role does each session get, what may it do and write, and how does a coordinator set it up today? |
| [Directives](directives.md) | Which standing rules reach which agent, and which version has each one read? |
| [Blueprint](blueprint.md) and [export guide](blueprint/README.md) | How are project requirements, decisions, milestones and papers read, edited, reviewed and exported? |
| [Multi-user console](multi-user.md) | Who may sign in, which projects and components may each user see, who decides for a team, and how is every route scoped? |
| [Hardware](hardware.md) | How does the operator offer a shared compute machine to agents, and how do agents queue for it, hold it and report? |
| [Checkout](checkout.md) | How does a running team move to another OS user or PC, with handouts, new keys and a one-time restore prompt? |
| [Operations: database health](operations.md) | How does the hub stay healthy as it grows: clean-up rules, the audit horizon, backups, integrity checks and compaction? |
| [Threat model](threat-model.md) and [risk register](risk-register.md) | What could go wrong, and what risk remains? |
| [Showcase](showcase.md) | What does the scripted Early Echo story in `eval/` do, act by act, and how does it cover every tool, admin area and acceptance row? |
| [Acceptance checklist](acceptance.md) | How do we verify the contracts and release readiness? |
| [Roadmap](roadmap.md) | Which improvements are outside the current platform contract? |
| [Brand](brand.md) | What does the app icon mean, and how may it be used? |
| [Landing site](../site/) | What do the public landing and architecture pages say, and how are they regenerated? See [site/src](../site/src/README.md); `.github/workflows/pages.yml` deploys them. |

## Design history

The [implementation brief](next-release.md) and [workflow repair proposal](workflow-repairs.md) record earlier plans. Use the reference above for current behavior and the [roadmap](roadmap.md) for proposals.
