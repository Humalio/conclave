# Connect a computer and start a team

Use this guide when a person or an AI agent will work on a new computer. The **hub** hosts the console, tasks, and vault. The **connector** runs on the computer where an agent works and signs it in.

## With the Conclave connector

Connecting a PC takes one prompt and one code. The agent on the PC does the rest.

1. **In the console**, choose **Add → A new PC** and name the computer. You get the prompt and, apart from it, a code.
2. **Give both to the PC's user.** The prompt is the same for every PC of this hub and holds no secret. Send the code directly, not through a shared chat: it works once, for 30 minutes, and only with this hub.
3. **On the PC**, the user pastes the prompt into their agent. The agent checks Node.js, downloads and checks the installer, asks for the code and pairs the connector. Then it asks what the user needs: a new project, a new team, or another agent for a team set up from this PC. It asks one question at a time, offers a default, and files the request.
4. **Approve the request** in the console. The connector sets up the agents by itself, and its screen shows each one with the way to open it.
5. **Open the agents.** When an agent makes its first authenticated call from its own client, the console marks it **Connected**.

To bring in someone else's agent, on their own PC, use an [invite](#an-invite-for-a-collaborator) instead: nobody approves anything when their PC joins. If you already use the older setup, see [Moving an existing PC](#moving-existing-pcs-to-the-connector).

### The installer

Get the installer from the Conclave repository's GitHub Releases page. The installer checks the release signature with the public key it carries, then verifies the version, platform, and contents before installing. If your computer only reaches the local network, get the same installer and signed files from your administrator. Compare the signing-key fingerprint and installer checksum with the release page through a trusted connection. See [How connector releases are signed](connector-release.md).

Node must be on the PC first. When it is missing, the prompt gives the install command for the platform; installing Node never needs an app restart afterwards, because the connector calls Node by its absolute path.

The prompt names the installer, `conclave-install-<version>.mjs` for the newest approved version, and its SHA-256 when the hub holds the file (`CONNECTOR_RELEASE_DIR`); otherwise the agent checks it against `SHA256SUMS` on the release page. The release script writes the installer from the template `deploy/client/install.mjs`, filling in the version and the public release keys; the template itself refuses to run.

### The installer, in one step

`echo <code> | node conclave-install-<version>.mjs --pair - --hub <origin> --ca <fingerprint>` installs and pairs a PC with no screen and no click. The code is read from standard input only: given as an argument (`--pair <code>`) it is refused, and so is a terminal with nothing piped in, so the code is never in the installer's own command line. A hand-typed `echo <code> |` still reaches the shell history, and a wrapper such as `bash -c` or `cmd /c` holds it in its arguments for a few seconds; that is accepted because the code is single use and spent at pairing. The older `cnv_enrol_` prefix is still accepted and stops being accepted in 0.9.8. After the release checks, the installed connector runs the pairing of the next section with the code on its standard input: it checks the hub's CA against `--ca` (the 16-digit short form or the full 64) and the origin against `--hub` **before** it sends the code, and a mismatch stops with nothing sent (exit 3). Only after a successful pairing is the service installed and started, so it starts with its hub; the pairing screen is not opened. A refused code exits 4 and says "This code was refused. If you just received it, tell the operator now: someone else may have used it." Any other stop before pairing (a wrong release, no code, no `--hub` or `--ca`) exits 1 or 2 with nothing sent.

**What the code was for.** The pairing code is `cnc-pair-` and 26 characters of `a-z2-7` (the older `cnv_enrol_` form is still accepted). The hub's answer to the pairing says whether it was an operator's Add PC code (`code_kind: pc`) or a collaborator's invite (`code_kind: invite`, with the invite's id, project, team and role), and the connector prints it as a fixed line, `code_kind: pc` or `code_kind: invite <id>`, for the agent that runs the installer. Two commands follow it, both on the paired PC's own key: `conclave setup choices` prints the hub's answer from `GET /onboard/choices` as one line of JSON (for a PC code the projects, teams and roles the agent may ask the user about; for an invite the invite alone), and `conclave setup redeem <invite id> [--root <folder>] [--client claude-code|codex]` calls `POST /onboard/invites/:id/redeem`. The hub checks the invite again and files an already approved request for this PC, which the connector keeps as this PC's own, so `conclave setup continue --wait 30` picks up the keys and builds the folder with no Allow. When the code was an invite, the installer does both steps itself before it installs the service: it redeems the invite, runs `conclave setup continue --wait 30`, and prints "This PC joined the team from an invite." (or says to finish with `conclave setup continue --wait 30`); a refused invite stops with exit 5. A refusal (`invite_refused`) is printed in the hub's plain words and nothing is kept. The only choice made on the PC is the local folder, and it never goes to the hub. The installer's exit 3 covers every stop before the code was sent because the hub is not the one given: its certificate does not match `--ca`, it answers for another address, or it is already set up here with another certificate or address.

The connector's service carries a team request this PC filed forward by itself: at each check-in (every minute) it takes one setup step (waits for the approval, picks up the keys, builds the folders, confirms), so nothing needs a command or the screen after the request is filed. The log says each phase once, for example `team request set up (2 built)`. A step that fails (an error, or agents whose folders did not build) is tried again after a wait that doubles from one minute to half an hour, so a request that cannot finish does not retry at every check-in; any other answer starts the wait over. Such a request picks up its keys by itself once the operator approves it: no Allow on the screen. The request came from this connector and the keys go only to it. At the Hardened level the PC user's Allow stays. A pickup the PC user declined stays declined. A folder the connector builds in a new or empty place is allowed for its agent with the pickup, as before; a folder that already holds files still waits for its own click.

### Pairing

Add PC creates the PC, its app key and a single-use **pairing code**, shown only in the console. The code is valid for 30 minutes, is bound to this hub's identity and HTTPS origin as well as its CA pin, and is entered on the connector's local pairing screen. **Make a new code** voids the old one. A change of the hub's CA or origin is accepted only after the PC's user confirms it on that screen.

- **The screen.** `conclave setup` opens it in the browser. It listens only on `127.0.0.1`, on a random port, and opens with a one-time token in its address: the first visit trades the token for a cookie, and the token is dead after that. Every request must name that exact address as its host, and every form must come from that same origin, so another web page in the user's browser cannot post to it. It stops after an hour without use, or when its command is stopped.
- **The CA check comes first.** The console shows the code together with the hub's address and the short form of its CA fingerprint. The user enters all three. Before it sends anything, the connector opens TLS to the hub, checks that the certificate it was given was issued by the CA the hub serves, and compares that CA's fingerprint with the one entered. Only on a match does it ask the hub for its identity, and only when that identity is new on this PC, or the same as before with the same CA and address, does it send the code. On a mismatch it says "This is not the hub you were given: its certificate does not match" and sends nothing.
- **A known hub that changed.** When this PC already has a section for that hub's identity with another CA or address, the screen says so and pairs only after the user confirms that their administrator told them of the change. The old section stays until then.
- **The code** never appears in a command line, a URL or a log. The user types it into the screen, and the screen never shows it back; the one-prompt route sends it on standard input ([The installer, in one step](#the-installer-in-one-step)), never as an argument.
- **After pairing** the connector holds the hub's section in `keys.json` (its identity, address, CA and app key) and the PC page shows the **Paired** step.

### The prompt

The prompt holds only the hub's HTTPS address, its full CA fingerprint and the installer to check. None of it is secret, so it is the same text for every PC and may be shared. It says "agent", never a product name.

The agent runs `node conclave-install-<version>.mjs --pair - --hub <address> --ca <fingerprint>` and writes the code to the installer's standard input. The code is never an argument, a file or part of a URL. If the agent's tool cannot pipe standard input, it stops and tells the user to run the installer in a terminal. The prompt tells the agent: "Pass the code only to the installer command. Don't repeat it, save it or send it anywhere."

After pairing, the hub says what the code was for:

- **A code from Add PC.** The agent runs `conclave setup choices`, which lists the projects, and the teams set up from this PC with their roles (a PC adds agents only to its own teams). It asks at most four questions, one at a time: a new project, a new team or an agent for a team; the name and goal; what a new team should do (the agent proposes roles and rules); and the role. It drafts the request, checks it with `conclave setup request --file <path> --check` and files it with `conclave setup request --file <path>`. The operator approves it in the console.
- **An invite.** The agent asks nothing: the installer redeems the invite itself and the PC joins its one team and role. If the installer says to finish with `conclave setup continue --wait 30`, the agent runs that.

Before pairing there is nothing to list: `GET /onboard/choices` needs the PC's app key, which only pairing gives.

### The code

A code is `cnc-pair-` followed by 26 base32 characters. It works once, for 30 minutes, and only for this hub's identity, HTTPS origin and CA. A wrong binding voids it, and every refusal gives the same answer, `invalid_pairing_code`. **New code** (Add PC, Re-enrol PC) makes a new one and voids the old one; once the PC has paired, Re-enrol PC is the way.

The fixed prefix lets the leak guard find a code anywhere the hub stores or sends text: a message, a task, a vault file, a channel or a request. A code the hub issued is refused there like a key. When a code is refused at pairing, the installer tells the user: "This code was refused. If you just received it, tell the operator now: someone else may have used it."

### Paired just now

Each pairing shows on Home as **Paired just now**, with the time, the source address and the connector's version, until the operator answers it. **It was me** keeps it. **Revoke** asks once ("Revoke this PC's pairing? Its agents stop connecting."), then revokes the PC's app key, cancels its open requests and pickups, and revokes the agent keys picked up with that app key; nothing of another PC changes; the toast says "Pairing revoked for <PC>". Both are audited (`connector.paired`, `connector.pairing_revoke`). There is no separate PC approval: the operator's answer here is the check.

### An invite for a collaborator

An invite brings a collaborator's agent, on their own PC, into one of your teams. Choose **Add → A collaborator's agent**, then the collaborator, the team, the kind of role, an optional role name, an optional vault folder (read or write), how their PC reaches the hub (directly, or through one of your [relays](relay.md), shown when you have one) and how many days the invite stays open (7 by default, 1 to 90). Through a relay, the prompt and code they open carry the relay's address and CA instead of the hub's; if that relay is removed, opening a code is refused and you make a new invite.

- **Making the invite is the approval.** The hub checks it as an approval would: the team is running, the role exists in it, the collaborator is an active member, and the folder sits inside a folder shared with them (write needs Contribute there). The invite carries no free text; nothing the PC sends can add a goal, rules, folders or more agents.
- **The collaborator opens the code** on their own Home, behind their sign-in and two-factor: **Show the code** gives the hub's one prompt and a code for 30 minutes from that moment. **New code** voids the one before. The operator never sees the code.
- **Joining.** After pairing, the PC calls `POST /onboard/invites/:id/redeem`. In one transaction the hub checks everything again (team, role, the collaborator's access and folders, any template, no checkout of the team), then creates the agent, owned by the collaborator, with the invite's ceiling, and a pre-approved request the connector picks up without a click. If anything no longer holds, nothing is created and the PC is told why (`invite_refused`).
- **Withdraw** in the same sheet ends an open invite: its code stops working.
- A PC paired with an invite files no requests of its own, and `conclave setup choices` shows it only its invite, never a list of projects or teams.

Audited as `onboarding.invite_created`, `onboarding.invite_code_opened`, `onboarding.invite_redeemed`, `onboarding.invite_refused` and `onboarding.invite_revoked`.

### Withdrawing a request

`conclave setup withdraw` withdraws the PC's current request, also one an earlier Re-enrol reopened for a new pickup that setup cannot finish; agents that already joined their team stay, and a new request can be filed. After a Re-enrol that fell back (the PC held none of the keys), those agents' keys are revoked: they stay in their team, shown as **Key refused**, until the operator archives them or gives them new keys. The request's rules are the ones in [The request](#the-request). The agent never handles a key, and the connector reads none into its output.

### Setting up the folders

After the operator approves, `conclave setup` (on its screen, or in a terminal) picks up the keys into the hub's section of `keys.json`, builds each agent's folder under the chosen root, writes its instructions file, and registers the folder with the connector: its `.mcp.json` entry runs `conclave mcp <folder>` by Node's absolute path, approved in the folder's own `.claude/settings.json`, and the folder is trusted in `~/.claude.json` (see [connector.md](connector.md#folder-trust)). Every change is recorded in the manifest. Then it confirms the pickup.

If git is missing on Windows, setup offers to install a private copy of git into the connector's folder, with no admin rights and no change to the user's own git settings. The connector checks it against the version and hash in its own signed release. When no Git for Windows is installed, setup also sets `CLAUDE_CODE_GIT_BASH_PATH` for the user (`HKCU\Environment`, no admin), which is how Claude Code finds it; this is the one change outside the connector's folder, and it is recorded for uninstall. A git the user installs is always preferred, and uninstall removes the private copy and the variable. On macOS and Linux, setup gives the install command for the platform.

- **It's an offer.** The screen asks "Git is missing. Install a private copy for Conclave only (about 50 MB, no admin rights)?" and installs only on yes. If you decline, setup shows the Git installation command for your platform.
- **What it is.** MinGit 2.56.1 (64-bit), pinned by version and SHA-256 in the connector's signed release; any other file is refused. After unpacking, its `usr\bin\sh.exe` (GNU bash) is copied to `usr\bin\bash.exe`, and the copy is checked against the original.
- **How the agents find it.** Claude Code's shell is the private bash, which brings its own git. Claude Code reads its Git Bash path only from the environment it starts with (the folder's own settings are too late), so setup sets `CLAUDE_CODE_GIT_BASH_PATH` in the user's environment (`HKCU\Environment`, no admin), only when no Git for Windows is installed. A Claude Desktop that was already open reads it after it is closed and opened once; the screen says so. The connector itself calls the private git by its absolute path. The copy and the variable are manifest entries, removed by uninstall.
- **Codex.** Use Git for Windows for Codex. The private Git installation is documented for Claude Code. [Git on Windows](connector.md#git-on-windows)

### Starting the team

For each agent, the connector offers one way to open it on that surface: **Open agent** in Claude Desktop, one copyable command in a terminal or for Codex. Each names the folder and where the chat will show. Each agent is **Waiting for approval**, **Ready to open** or **Connected**, and one failed agent can be retried alone.

- **Claude Desktop.** The screen shows the exact folder with a Copy button and says where the chat will appear: "In Claude Desktop, start a new Code session in this folder; the chat shows under that folder". **Open agent** also opens that folder in a file window. Nothing outside Desktop can start a Desktop chat, so this is the one click the user makes per agent.
- **Terminal (Claude Code).** One command per agent: it changes to the folder and starts `claude` with a fixed first message that tells the agent to read its directives and its team.
- **Codex.** The same, with `codex -C <folder>`.
- **Connected** comes from the hub: the agent's first authenticated call from its own new client. A setup login or the service's check-in does not count. An agent whose session keys the hub no longer accepts (revoked or suspended) is **Key refused by the hub**, never Connected; when the hub refuses the PC's own app key, `conclave setup status` says so and shows no agent as Connected.
- **Retry** rebuilds one agent's folder and entries; the others are not touched. `conclave check --folder <folder>` checks that folder's connection.

### Continue setup

**Continue setup**, on the connector's local screen or in the console, picks up where setup stopped, bound to the same installation and request. Nothing is pasted again.

The connector keeps its setup state per hub on the PC (`onboarding/<hub>.json`, no secrets): the request, the root folder, each agent's folder and its last result. Closing the app or the screen while the request waits loses nothing: `conclave setup` (or the console's "Continue setup on the PC") reopens the screen at the same step. In the console, the PC page's setup timeline shows the same steps and states, and each step that waits names its next action and who takes it.

### Folder trust

Claude Code keeps its own copy of `~/.claude.json` and can save it over a folder's trust. When the trust entry of a folder the connector registered has disappeared and the folder is unchanged, the connector puts it back, by key, never over a newer file. When the user turned trust off, or the folder's identity or agent config changed, it doesn't: the session and the PC page offer **Repair connection**, which asks the user. Each folder's MCP server lives in its own `.mcp.json`.

### Secure connection

The connector uses HTTPS and verifies the hub's certificate authority from pairing. This avoids changing the operating system's certificate store or restarting the app for certificate setup. If setup installs private Git for Claude Code on Windows, reopen Claude Desktop so it can pick up the new Git Bash setting.

For an existing installation, see [Migration](connector.md#moving-an-old-pc-conclave-migrate). To remove it, see [Uninstall and disconnect](connector.md#uninstall-and-disconnect).

## Reference

The rest of this page is the reference behind the steps above: what the hub stores, the request the PC's agent files, the one approval, the key pickup, recovery and the threat model. A new PC joins with the connector. The older setup is deprecated: it is kept only for PCs not yet on a connector, and a later release removes it; see [The older setup (deprecated)](#the-older-setup-deprecated).

## Hub backend

Server code: `server/src/onboarding/` (service and `/onboard/*` routes), `server/src/connector/` (pairing and the `/connector/v1/*` routes), `server/src/admin/onboardingApi.ts`, the [schema baseline](../server/src/db/migrations/0100_v1_baseline.sql) (`enrolment_codes`, which holds the pairing codes, `onboarding_requests`, `onboarding_events`, `onboarding_slots`; `credentials.onboarding_enabled_at`, `machines.mcp_transport`, `teams.project`). Tests: `server/test/onboarding.test.ts`.

| Point | Behavior |
|---|---|
| Hub calls | Only the `/onboard/*` and `/connector/v1/*` HTTP endpoints below; there are no onboarding MCP tools. |
| Pairing | `POST /connector/v1/pair` trades the code for the PC's app key: it gives the app key that Add PC or Re-enrol PC made a fresh secret in place (same key id, policy and capability) and marks the code used. See [The code](#the-code). |
| Member role | A slot's `team_role` is its team membership role (so team permissions apply); the request's role `name` becomes the agent's role and its `job` the role detail. Playbooks are per team role. |
| Labels, variables, folders | Label `<team> <role>[ <n>]` (numbered when the role has more than one agent or the team already has one); `session_var` and folder derived from it, unique among the PC's open slots. |
| Ceiling | The approval's `template_id` per slot, else rules generated from the role's folders: `read` gives `fs.list/read/search`, `write` adds `fs.create/update/history`, plus `tool:file_*`. A write on the vault root needs `confirm_root_write: true`. |
| Start | `start_when_set_up` (default `true`) on approve: a new team starts at confirm. |
| PC key errors | Every bearer route on `/onboard/*` audits a bad PC key (`authentication_events`) and counts it per address in `pickup_fail` (10 an hour, then `rate_limited` and an `onboarding_auth_fail` alert). Capability off is `403 capability_off`; lockdown `423`. |
| Client files | `GET /onboard/client/restore-prompt.md` (LF line ends, `x-content-sha256` header) and `GET /onboard/client/manifest`: only the [checkout](checkout.md) restore template, from `deploy/client/` (`CLIENT_DIR` overrides). The connector itself comes from its signed release ([The installer](#the-installer)). |
| Prompt | Rendered by Add PC, Re-enrol PC and **New code** (`connectorPrompt` in `server/src/connector/identity.ts`): the hub's HTTPS address, its CA fingerprint and the installer's version and SHA-256. It never holds the code. Through a relay it names the relay's address, CA and release base instead. See [The prompt](#the-prompt). |
| CA | `GET /onboard/ca.crt` serves `CA_CERT_FILE`; its fingerprint is the SHA-256 of the certificate's DER (`X509Certificate.fingerprint256`, lowercase hex without colons). A hub with no CA, or no HTTPS address, offers no prompt (`connector_unavailable`: `no_ca` or `no_origin`). |
| Console | Add PC and Re-enrol on the PCs page and the PC page; the approval screen `#ob/<id>`; Settings → Onboarding is the **Settings** sheet on the PCs page. `GET /api/onboarding/pcs` returns every PC's code state, MCP transport and pending count in one call, for the PCs table. |
| Long poll | `GET /onboard/requests/:id?wait_s=0..45[&version=n]` returns at once when the request changes (or already differs from `version`). |

<a id="user-guide"></a>

## Setup commands on the PC

The steps at the top of this page are the whole flow. The agent on the PC drives it with these connector commands; the PC's user can run them in a terminal too. None of them prints or takes a key, and the code goes only to the installer or to `conclave pair` on standard input.

| Command | What it does |
|---|---|
| `conclave setup [--no-browser]` | Opens the connector's local screen: pairing, then each agent's setup, with **Continue setup**, **Retry** and the **Allow** for a key pickup. |
| `conclave pair --hub <https origin> --check <hub check>` | Pairs without the screen. The code is read from standard input, never from the command line. |
| `conclave setup choices` | After pairing: what this PC may ask for (projects, and the teams set up from this PC with their roles), or its one invite. |
| `conclave setup schema` | The request's fields, limits and an example, for the agent drafting it. |
| `conclave setup request --file <path> [--check]` | Checks the request against the hub's rules locally and prints a one-screen summary; without `--check` it files it. |
| `conclave setup continue [--wait <s>]` | One step of setup from wherever it stopped: wait for the approval, ask for the PC user's **Allow**, pick up, build and register the folders, confirm. |
| `conclave setup status [--json]` | Each agent: Waiting for approval, Ready to open, Connected or Key refused, with the way to open it. |
| `conclave setup retry <agent>` | Rebuilds one agent's folder and entries; the others are not touched. |
| `conclave setup withdraw` | Withdraws this PC's request ([Withdrawing a request](#withdrawing-a-request)). |
| `conclave check [--folder <f>] [--probe]` | The [doctor](#doctor). |

`conclave setup continue` exits with 0 when every agent is set up, 3 while it waits (for the operator or for the PC user's Allow), and 1 otherwise. `conclave setup request` exits with 2 when the request has problems, listed one per line.

<a id="client"></a>

## The connector's side

Client code: [deploy/client/connector/onboard.mjs](../deploy/client/connector/onboard.mjs) (setup), `connector/request.mjs` (the request's local check), `connector/pairing.mjs` and `connector/handover.mjs`. Tests: `deploy/client/connector-onboarding.test.mjs` and `deploy/client/connector-handover.test.mjs`.

| Point | Behavior |
|---|---|
| Pinning | Every connector call to the hub uses the HTTPS address and CA pinned at pairing; nothing goes into the operating system's certificate store. A hub address that is not pinned HTTPS is refused (`not_https`). |
| State file | `onboarding/<hub id>.json` in the connector's folder: the request, the root folder, each agent's label, role, variable, folder and last result, and the `pickup_id`. No secrets. |
| Resume | The list of agents is saved before any key is written, so a crash before the keys are written picks up again, and one after only confirms. A confirm the hub refuses as replaced picks up again. After confirm, Continue setup and Retry rebuild folders from the state file, without a pickup. |
| The PC user's Allow | A pickup hands session keys to the PC, so the connector asks the PC's user on its screen first. Without the click nothing is picked up, and `conclave setup continue` says it is waiting for it. |
| Keys | Written straight into the hub's section of the connector's key file (through the key service on a hardened PC), never into a log, the environment or a chat. Each agent's local label is unique on the PC. |
| Folders | Built under the chosen root, per project. For Claude Code: the `conclave` entry in `.mcp.json`, approved in `.claude/settings.json`, `CLAUDE.md`, and trust in `~/.claude.json`; for Codex: `.codex/config.toml` and `AGENTS.override.md`. `git init` with `*` in `.git/info/exclude`. Every change is recorded in the manifest, so uninstall can undo it. |
| Starting the team | The team is already running: the hub starts it at confirm. The connector's screen offers each agent's way to open it ([Starting the team](#starting-the-team)). |

## Add PC and the app key

**Add** in the console (the header, the More sheet on phones) opens on "What do you want to add?": **A new PC**, **A collaborator's agent** ([invite](#an-invite-for-a-collaborator)) or **A team** (on a PC that is already connected, with the active PCs named; it opens the existing New team screen). There is no choice for an agent on its own: a coordinator's recruit request adds one to a team, and **Members**, **Add member** adds an agent that already has a session key. The PCs page keeps a contextual **Add PC**, which opens straight on the new-PC screen. **A new PC** asks for the PC's name and:
- creates the PC and its **app key** (`kind: "app_key"`, `machine_id`, no expiry), with the onboarding capability on;
- creates a **pairing code** for that app key;
- shows the hub's one [prompt](#the-prompt) and, apart from it, the [code](#the-code).

The prompt is the user's own message to their agent, so its steps are the user's instructions. Everything the hub later returns to the connector (status, operator notes) is data.

<a id="the-enrolment-code"></a>

### Pairing codes

| Rule | Value |
|---|---|
| Format | `cnc-pair-` + 26 characters of base32, 130 random bits; the fixed prefix lets the leak guard find it ([the code](#the-code)). Stored only as a verifier, like every key. |
| Single use | `POST /connector/v1/pair` trades it once for the app key's secret, which the connector writes into its key file. |
| Lifetime | 30 minutes from the moment it was made, and only for this hub's identity, HTTPS origin and CA. A code that names another hub is voided. **New code** voids the previous unused one; once the PC has paired, Re-enrol PC is the way. |
| Used again | Refused with the same `invalid_pairing_code` as every other refusal, audited as `connector.pair_refused` with the real reason, and alerted as `enrolment_code_reused` (warning): someone else may have used it. |
| Brute force | Failed codes count per source address in a persisted counter (`enrol_fail`); 10 failures an hour lock that address out for the hour and alert. |
| Re-enrol PC | For a reinstalled, replaced or lost PC, or one whose connector key went astray. Issues a new code and a new app key, and revokes the PC's old app keys and any unused code at once. Every agent key still onboarded there (an agent a checkout moved away is left alone) is handed over to the new app key by one [key handover](#key-handover-a-rotated-key-or-a-recruit-reaches-a-connector-pc): the PC's user pairs the connector again with the new code, allows the handover once, and the old session keys are revoked only at confirm. If the connector holds none of those keys (the PC was reinstalled or replaced), or the PC has no connector report, the session keys are revoked at once and the pickup reissues fresh keys for each of the PC's collected requests that still have an agent on it (see [later](#later)); `conclave setup continue` picks them up, and `conclave setup withdraw` withdraws such a reopened request instead. |

### The app key and its onboarding capability

The app key and its onboarding permission have **no timer**. Both last until the operator acts.

| Rule | Value |
|---|---|
| The PC key | An ordinary app key with no expiry: the key the PC's agents log in with. It ends only when the operator suspends or revokes it. |
| Live logins | An app key allows **100 live logins** by default (`max_live_sessions`); a login over the limit is refused as `rate_limited`, and logins already live go on. The admin edits the limit per key, 1 to 500, in Keys → the app key → Overview → **Login limit** (`PUT /api/keys/:id/live-limit {max_live_sessions}`, audited as `key.live_limit` with the old and the new limit); it applies at the next login. The default was 20 until migration `0137`, which moved every app key still at exactly 20 to 100 and left any other value (such as 60) as it was. |
| The capability | On for keys made by Add PC; the operator can turn it off or on in Keys (`PUT` / `DELETE /api/keys/:id/onboarding`) or give it to an existing app key. In the console the key list says "Onboarding on" in an app key's line, and the key's Overview has an **Onboarding** row ("On since <date>" or "Off") with a switch: on is one click, off asks first. |
| What it allows | Without a session token, and nothing else: filing, amending and withdrawing a request, and pickup ([endpoints](#endpoints)). Reading the key's own requests needs no capability. No vault, team, message or policy action. |
| How long it lasts | No timer; a pickup does not end it. Over time the key can file any number of requests: new projects, new teams, or more agents in a team it onboarded. |
| One pending request per key | At most one request that is not yet decided or collected (see [states](#states)). A second is refused with `invalid_state` naming the pending one: "This PC already has a pending request: `<id>` "<team name>", filed <time>, waiting for <the approval / key pickup / your changes>." No request is recorded; the refusal is audited as `onboarding.request_refused_pending`. A waiting key handover counts as the pending request too ([key handover](#key-handover-a-rotated-key-or-a-recruit-reaches-a-connector-pc)). |
| Rate limits (per app key) | Defaults, editable in console **Settings → Onboarding** (`onboarding.file_per_hour`, `onboarding.file_per_day`). Filing, amending and withdrawing: 5 an hour and 20 a day (refused second requests count). Status: 120 an hour (long polls count once per call). Pickup: 10 an hour; failed pickup authentication uses a `pickup_fail` counter per address. `rate_limited` carries `retry_after_s`; counters persist. |
| PC or key state | A suspended PC, or a suspended or revoked app key, refuses all of it. Capability off: filing and pickup refused, status readable. Lockdown: filing and pickup refused, status readable. |

## The team request

After pairing, the agent on the PC drafts the request from the user's words ([schema](#the-request)), asks only what is missing, one question at a time, and shows the user a one-screen summary (project, team, roles, counts, folders). Only after the user agrees does it write the request to a file and run `conclave setup request --file <path>`, which checks it again and files it. `conclave setup schema` gives the agent the fields and limits; `--check` validates without filing.

Later requests use the same prompt or the same commands: "add a team …" or "add two developers to <team>". A paired PC never needs a new code for them.

Setup is idempotent and kept in the connector's [state file](#the-connectors-side). If the user stops the turn or closes the app, **Continue setup** (or `conclave setup`) resumes where it stopped.

### The request

`conclave setup request` posts the request to `POST /onboard/requests`. The agent writes it; it contains no secrets.

| Field | Type and limits | Notes |
|---|---|---|
| `kind` | `new_team` (default) or `add_agents`. | See [later requests](#later-requests-from-the-same-pc). |
| `project` | `{name, existing, kind?, more_teams?}`. `name`: 1–80 characters, `^[A-Za-z0-9][A-Za-z0-9 ._-]*$`. `existing`: boolean. `kind`: `implementation` or `research`. | With `existing: true` the name must match an existing project, case-insensitively; otherwise `invalid_argument` lists close matches. With `false` it must not match one. For `add_agents`, it must be the team's project. An existing project supplies its kind: `kind` may be left out, and a different one is refused. A new project asks for it; left out, it is `implementation` and the request carries the warning `project_kind_missing`. `more_teams` (boolean, default false, `new_team` only): more teams will join the project, so the team gets its own Blueprint part at approval; without it the only team of a project keeps its whole Blueprint at project level ([blueprint](blueprint.md) §3). The operator can change it at approval. |
| `team.name` | 1–80 characters, unique among teams that are not done or stopped. | For `add_agents`, give `team.id` instead. |
| `team.goal` | 1–4000 characters. | Becomes the team goal once approved. |
| `team.delivery_mode` | Ignored: every team acts when woken. Older connectors still send it. | |
| `team.close_on_approve` | boolean, default `true`. | |
| `team.coordinator_reviews` | boolean, default `false`. | |
| `team.lease_minutes` | 1–1440, default 30. | Same bounds as the team builder. |
| `team.stall_minutes` | 1–1440, optional. | |
| `team.max_review_rounds` | 1–20, default 3. | |
| `roles` | 1–8 entries (default limit; see below). | For `new_team`, exactly one has `team_role: "coordinator"` with `count: 1`. For `add_agents`, none does. |
| `roles[].name` | `^[a-z][a-z0-9_]{0,29}$`, unique in the request. | The playbook role name. |
| `roles[].team_role` | `coordinator`, `worker`, `reviewer` or `stakeholder`. | |
| `roles[].count` | 1–5. | At most 12 agents in total. |
| `roles[].job` | 1–500 characters, one line. | Shown to the operator; the agent's role detail once approved. |
| `roles[].reviews` | Role names, optional. | Each must exist in the request. A role may name itself only with `count` ≥ 2. The coordinator may appear only with `coordinator_reviews: true`. |
| `roles[].folders` | 0–10 `{path, access}`. `path`: absolute under `/vault/`, no `..`, no wildcards, at most 400 characters. `access`: `read` or `write`. | A proposal; the operator sets the real ceiling. `write` implies `read`. |
| `rules` | 0–20 entries, optional (default limit; see below). | Rules the agents should follow, as the filing agent found them: `conclave setup schema` tells it to fill the list from the repo's `AGENTS.md` and `CLAUDE.md` files and the user's own instructions, one entry per rule. Each is a proposed directive; it becomes one only if the operator keeps it at approval ([directives from onboarding](directives.md#from-onboarding)). |
| `rules[].title` | 1–120 characters, one line. | The directive's title. |
| `rules[].source` | 1–200 characters, one line. | Where the rule comes from, for example `repo AGENTS.md` or `user instruction`. Kept as the directive's source. |
| `rules[].text` | 1–2000 characters. | The rule as written; the directive's text. |
| `rules[].category` | Optional: `access`, `communication`, `tokens`, `reporting`, `sources`, `process` or `tooling`. | The directive's category. |
| `rules[].role` | Optional: a team role (`coordinator`, `worker`, `reviewer`, `stakeholder`). For `new_team`, the team role of a role in the request. | The directive is then for that role of the team; without it, for the whole team. |
| `source` | `{from, ref?, note?}`, `new_team` only. Optional for older clients; left out, the request carries the warning `source_missing`. | Where the requirements or the research brief come from. `from`: `existing` (a source that exists: `ref` is required, a path or URL of 1–400 characters, one line), `coordinator` (the team's coordinator derives them) or `operator` (the operator supplies them). `note`: at most 500 characters. A `ref` is information for the team: it grants no permission to fetch or read it ([setup progress](#setup-progress)). |
| `requirements` | 0–30 entries, optional, `new_team` only (default limit; see below). | What the team should build, as the filing agent found it in the repo's specification and the user's words: functional (FR) and non-functional (NFR) requirements with their acceptance criteria. At approval they go into the team's Blueprint part as **one proposal** for the operator to review; they are never applied silently ([requirements from onboarding](#requirements-from-onboarding)). |
| `requirements[].kind` | `fr` or `nfr`. | |
| `requirements[].title` | 1–200 characters, one line. | The requirement's title. |
| `requirements[].text` | 1–2000 characters. | What it asks for; the item's body. |
| `requirements[].category` | For `nfr`, required: `perf`, `sec`, `rel`, `use` or `ops`. Not allowed for `fr`. | The NFR's key category (`NFR-SEC-nn`). |
| `requirements[].acs` | 0–10 entries, each 1–300 characters, one line. Optional. | Its acceptance criteria, one item each (`<key>/ACn`). |
| `requirements[].module` | Optional: an existing module of an existing project, 2–6 capitals. | Where the requirement goes. Left out: the team's new module. In a research project, required: a requirement sits in a module, never under a line. |
| `research` | `{lines, papers}`, optional, `new_team` only. | The research brief, typed. Lines need a research project (`project.kind: "research"`, or an existing research project); papers fit either kind. |
| `research.lines` | 0–10 of `{id, title, mode, question?, owner?, hypotheses?, questions?}`. | `id`: `^[a-z0-9][a-z0-9_-]{0,19}$`, unique in the request, for references. `title`: 1–200 characters, one line. `mode`: `validate` or `explore`. `question`: at most 2000 characters. `owner`: a role name in the request. |
| `research.lines[].hypotheses` | 0–10 of `{id, title, criteria?}`. | `id` as for lines, unique in the request. `title`: the statement, 1–200 characters, one line. `criteria`: at most 2000 characters, what would confirm or refute it. |
| `research.lines[].questions` | 0–10 of `{title, criteria?}`. | As for hypotheses, without `id`. |
| `research.papers` | 0–20 of `{title, status, venue?, type?, manuscript?, authors?, owner?, hypotheses?}`. | Existing **and** planned papers. `status`: `planned`, `drafting`, `submitted`, `accepted` or `published`. `type`: `paper`, `preprint`, `report` or `thesis`. `manuscript`: a path or URL, 1–400 characters, when there is one; a planned title needs none. `authors`: 0–20 names. `owner`: a role name in the request. `hypotheses`: ids of hypotheses in the request the paper is about. No claims: a paper's claims are the team's work. |
| `prompt` | 1–4000 characters. | The user's own words, kept for the operator. |
| `client` | `{app, os}`, each at most 40 characters. | Descriptive only. |

The per-request limits (8 roles, 12 agents, 5 per role, 20 rules, 30 requirements) are defaults; the requirements limit counts every typed record together (requirements, lines, hypotheses, questions and papers). They are defaults, editable in console **Settings → Onboarding** (`onboarding.max_roles`, `onboarding.max_agents`, `onboarding.max_per_role`, `onboarding.max_rules`, `onboarding.max_requirements`; `max_rules` and `max_requirements` may be 0, which refuses any); the hub validates against the current settings and names the limit in its error. At most 32 KiB of JSON. Validation runs in the hub and returns `invalid_argument` with the field path and the rule, up to 20 problems. The inbound key scan runs on every field: a secret in the request is refused and alerts.

<a id="warnings"></a>The hub also returns **warnings**, never errors, to the connector and to the operator: a folder that does not exist in the vault (`folder_missing`); a `write` folder at the vault root or a top-level folder; a folder never granted to anyone; more than one worker role without a reviewer; a polling team on a client that cannot sustain the loop (`chatWarnings`); a goal that reads like a list of rules (`goal_has_rules`: two or more list lines, or three or more of "never", "always", "must", "do not", "don't"), which belong in `rules` so the goal stays a goal.

Amending (`PUT /onboard/requests/:id` with `version`) replaces the whole request while it is `submitted` or `needs_changes`; a stale `version` fails with `conflict`. Withdrawing (`POST /onboard/requests/:id/withdraw`) works in the same states.

### Later requests from the same PC

| Want | Request |
|---|---|
| A new team in a new project | `kind: "new_team"`, `project.existing: false`. |
| A new team in an existing project | `kind: "new_team"`, `project.existing: true`. |
| More agents in an existing team | `kind: "add_agents"`, `team: {id}`. The team must have been created by an earlier `collected` request from this PC (looked up in `onboarding_requests`); otherwise `denied` with the generic message. The team keeps its own settings. Each role names an existing team role or a new one; a new one gets the default playbook for its team role. |
| One agent with no team, for a person's shared notes | `kind: "vault_agent"`: see [A vault agent](#a-vault-agent). |

Agent names continue the team's numbering (`Echo developer 3` after `Echo developer 2`). Variable names are unique on the PC.

### Recruits from a coordinator

A recruit's key reaches its PC the same way: through a [key handover](#key-handover-a-rotated-key-or-a-recruit-reaches-a-connector-pc) that the PC's user allows on the connector's screen. No key is ever returned to the coordinator, to the operator or to any chat, so a key cannot leak through a conversation (feedback `fb_sde3hhmnsgpia`).

When a coordinator calls `team_recruit` in a team set to **Automatic**, or the operator approves a recruit request in a team set to **Ask me**, the hub, in one transaction:

1. creates the agent, with its recruiting coordinator's owner ([agent owners](authorization.md#agent-owners)), `recruited_team_id` and `recruited_by`, its role and the purpose as its role description;
2. files an onboarding request for **the coordinator's PC**, of kind `add_agents`, already `approved` (the recruit envelope the operator set for the team is the approval), with one slot: the recruit's label, a session variable `<PROJECT>_<TEAM>_<LABEL>_SESSION_KEY` and a folder unique on that PC, the recruit's rules as the slot's ceiling (the same rules as before: a read-only copy of the coordinator's standing access, or the team's recruit template, checked against [the team's ceiling](#the-teams-ceiling-for-a-recruit-template)), and the binding to that PC.

No key and no membership exist yet. The coordinator's PC is the PC of the app key the coordinator's `team_recruit` call came through; for an operator's approval, the PC the coordinator's key is bound to, else the PC of its latest login. That PC needs an app key with the onboarding capability (a PC set up with **Add PC**); otherwise the recruit is refused with `invalid_state` and nothing is created.

The tool result (and the operator's approval) names the PC, the request and the folder, and says that **the PC's user allows the new agent on the connector's screen**: no command is run. The request is a key handover of kind `recruit`, so the connector sees it at its next check-in and lists it on its screen. After the click it picks the key up, writes it into its key file, builds the folder beside the team's other agents (under the root of the request that set up the team) and confirms. The recruit joins the team at confirm, and the coordinator gets the usual `team_joined` notice. The session key expires after the team's `recruit_days`, counted from pickup. A recruit not picked up within 24 hours is cancelled like any handover.

What stays the same: recruits count against `recruit_max` from the moment they are created, also while they wait for pickup; switching recruiting off, or ending the team, revokes the recruits' keys and cancels their waiting pickups (the waiting agents are archived). A waiting recruit on a connector PC is a handover, so it is cancelled like one: the connector no longer lists it, and the audit has `key.handover.cancelled` with the reason `team_ended`. The operator sees a waiting recruit in the PC's onboarding requests, as an approved request, with **Cancel** and **Reissue pickup**. A recruit's request is not checked against "created by an earlier request from this PC": the recruit envelope already limits it. While it waits, it is the PC's pending request, so the PC files nothing else until it is picked up or cancelled.

#### The team's ceiling for a recruit template

A coordinator built by onboarding holds only team rules: it has no file access of its own, and it gets none to recruit. A recruit template is checked against **the team's ceiling** instead of the coordinator's own rules, read when `team_recruit` runs (and again when the operator approves a request in a team set to **Ask me**). Nothing is stored on the coordinator, so there is no copy to keep current: a member whose access has narrowed since takes it with them.

- **One member holds each allow whole.** For each action and resource the template allows, one member of the team who was not recruited into it must hold it for good: a standing allow of that member covers it, and none of that member's deny rules overlaps it. So a template never reaches a path a member is kept out of, and never stitches together rights no single member has. Team rules, temporary grants and recruits' own rules never count.
- **The coordinator's owner.** A recruit takes its coordinator's [owner](authorization.md#agent-owners). When the coordinator has one, only that owner's agents count, and each folder in the template must sit within the owner's folder grants, as an [invite's](#an-invite-for-a-collaborator) folders do. Under a Read grant the template may only list, read, search, see history and see conflicts; any other action on the folder (create, update, rename, restore, delete, download, or a wildcard) needs a Contribute grant. An unowned coordinator counts the whole team.
- **The app key's cap.** Each allow must also stay within the coordinator's app key's cap, and the coordinator's and the cap's deny rules on paths come along to the recruit, as before.

`team_recruit` is refused, with a plain reason, when recruiting is off; when the team has no recruit template and the coordinator has no vault access of its own to copy ("… Ask the operator to choose a recruit template in the team's settings."); and when the template is beyond the ceiling ("The recruit template grants fs.read on path:/vault/**, which no member of the team holds for good. Ask the operator for a narrower template.", with "with the same owner" or the owner's folder problem where that is the reason). Without a template, a coordinator with vault access of its own still gives the recruit a read-only copy of it, as before. Every check of a template is audited as `team.recruit_ceiling`, by the coordinator: the template, the owner, whether it was within the ceiling, the first action beyond it with the reason, and how many members counted.

### A vault agent

A person who shares vault folders ([folder grants](multi-user.md)) can have one agent of their own that reads and revises notes in those folders, with no project, team, task board or Blueprint.

The request takes only `kind: "vault_agent"`, `agent: {name, job}` (name 1–60 characters, job one line), `folders` (1–10 `{path, access}` under `/vault/`), `prompt` and `client`. Any other field, a team or roles among them, is refused, by the hub and by `conclave setup request` before filing. The folders are a proposal, like a team's.

The approval needs an **owner**: a member (not an administrator) the agent works for. The operator may rename the agent, edit its job and its folders. Each folder must lie inside one of the owner's folder grants and be visible to the owner (a restricted folder never is); `write` needs a Contribute grant. Where the owner's grants nest, the most specific one that covers the folder decides: with Read on `/Shared/` and Contribute on `/Shared/Team/`, a write to `/Shared/Team/` is approved and delegated on that inner grant, and a write to `/Shared/` is refused. Otherwise the approval names every folder that does not fit and creates nothing. Approve then, in one transaction:
- adds the folders to the delegation of the owner's grants that hold them (Contribute only where the folder asks for `write`), so the owner sees them under **Shared folders** as delegated to agents;
- creates the agent with no project, owned by the owner, with the role `vault_agent` and the job as its role detail;
- writes one slot whose ceiling is the folder rules for those folders plus the directive, session and feedback tools: no task, team, message or Blueprint tool;
- moves the request to `approved` with no team, and issues no key.

Every agent file the hub writes (CLAUDE.md, and Codex's AGENTS.override.md) ends its **Connection** section with the same two lines for both clients: the `conclave` server connects the agent through the Conclave connector and is logged in for it (never call `session_login`, never read the connector's key file, never put a key or token anywhere), and if the conclave tools are missing it stops and reports the client's exact error and the output of `conclave check` in that folder. The text is `connectionLines()` in `server/src/onboarding/onboarding.ts`; a test pins it.

Pickup issues the one key and a short **CLAUDE.md** for a teamless agent: who it works for, its job and folders; read a note with `file_read`, then revise it with `file_update` and the `base_revision` it read, and on a conflict read again and merge; create with `file_create`; never delete, rename or restore; and when a folder is refused, its access was withdrawn, so it stops and tells the person. It has no `work_next` and never polls. Confirm joins no team; `team_id` stays empty.

Only directives scoped to the whole hub (or to the agent itself) reach it: it has no project, team or role, so a project's or team's directives never do.

**Revocation.** The agent is bounded twice: by its key's ceiling (the approved folders) and, while [owner enforcement](authorization.md) is on, by its owner's current folder grants. Removing the owner's grant, or lowering it to Read, refuses the agent's next edit at once. While owner enforcement is off, only the key's ceiling applies: revoke or narrow the agent's key to stop it. Cancelling an approved request archives the agent; the delegation stays on the owner's grant until the operator edits it.

### Trust

Everything in the request is **L2 data** written by a model on an unverified PC: a proposal for the operator, never an instruction to the hub, the operator or any agent.
- The console renders every request field as inert text (no HTML, Markdown or links), labelled "Written by the agent on <PC>".
- The approval screen leads with what the hub computed from the structured fields (agents, roles, folders, the access each would get), and shows the free text (`goal`, `job`, `prompt`) beneath it, `prompt` collapsed.
- Request text enters no playbook, directive, requirement or rule automatically. Once the operator approves, the goal and role jobs become operator-approved team text (L0 for the agents), so the operator sees and can edit them first. Rules become directives only when ticked; requirements reach the Blueprint only as a proposal the operator reviews.

## States

| State | Meaning | Who moves it on |
|---|---|---|
| `submitted` | Waiting for the approval. | Operator: approve, ask for changes, deny. The PC's connector: amend, withdraw. |
| `needs_changes` | The operator asked for changes, with a note. | The PC's connector: amend (back to `submitted`), withdraw. Operator: deny. |
| `approved` | Project, team and agents exist; keys wait for pickup. | The PC's connector: pickup and confirm. Operator: reissue, cancel. |
| `collected` | Pickup confirmed. Terminal (a [Re-enrol PC](#later) reopens a pickup on it). | |
| `denied`, `withdrawn`, `cancelled` | Terminal. | |

**Pending** means `submitted`, `needs_changes` or `approved`. Nothing pending expires: a request and an uncollected pickup stay open until the operator acts or the PC withdraws the request. The console keeps each one in view with its age: a Home attention item ("Team request from <PC> waiting for you · 3 days", "Keys approved, not collected yet · 2 days"), the PC's page and the Team requests band in the Teams card on Home.

## One approval

One console screen, **Onboarding request**, reached from the Home attention item and the PC's page, shows the project, the team and every agent together. It replaces the two approvals of the earlier draft.

The operator can edit anything before deciding:
- project, team name, goal and settings;
- roles, counts and jobs (the coordinator row cannot be dropped for a new team);
- per agent: the **permission ceiling** (a permission template, prefilled with one generated from the role's requested folders, or an existing template; a `write` on the vault root needs a second confirmation), and the **PC binding** switch (prefilled "Use only from <PC>", see [binding](#pc-binding-of-session-keys));
- for a new team, the **standard directives**, "Who decides" and "What stays with the operator", from the hub template ([directives from onboarding](directives.md#from-onboarding)): hub text, not L2, editable for this team, always created;
- the **rules** the agent proposes, in their own section under the computed agents: each shown as L2 text ("Written by the agent on <PC>"), with its source, category and whether it is for the team or one role. Every rule starts unticked, so agent-written text never becomes a directive by default: the operator ticks each rule to adopt it, and can then edit its title and text. A ticked rule becomes a directive at approval; an unticked one is dropped.
- the **requirements** the agent proposes, in their own section: each shown as L2 text with its kind, editable title and text, and its acceptance criteria. Each starts ticked, since it still goes to the Blueprint as a proposal; unticking one leaves it out of that proposal.
- the **source** of the requirements or brief (an existing source and its reference, the coordinator, or the operator), and the **research records**: lines with their mode, hypotheses and questions, and papers with their status, manuscript and owner. Each is L2 text, each line and paper starts ticked, and unticking one leaves it out (`edits.research` is the kept list). Records that cannot go in, such as lines in an implementation project or a requirement without a module in a research project, are named with the field and the fix before the approval is accepted.

A new team **starts automatically** once it is approved and setup completes; there is no separate Start step.

Edits are recorded as a diff in the request history and returned to the connector with the status. The screen warns when an edit breaks the plan: a role named in another role's `reviews` is dropped, or a worker role is left without a reviewer.

Then:
- **Approve**, in one transaction: creates the project (if new), the team as `draft` with the approved settings (for `add_agents`: adds any new role playbooks, nothing else), its role playbooks with each job as role detail, and each agent (project, role, role detail, `role_source='admin'`); writes one `onboarding_slots` row per agent with its team role, `session_var`, folder, binding and ceiling (template ID plus a snapshot of its rules). Each rule the operator kept becomes a directive, scoped to the team (or to `<team id>|<role>` when the rule names a role), with its source and category, the tag `onboarding`, and marked reviewed by this approval; the console sends the ticked list as `edits.rules`, and without it no rule is adopted. For a new team it also creates the two standard directives (the operator's wording from `edits.standard`, else the template), sets a new project's kind from `project.kind`, and, when requirements or research records are kept, files them as **one** Blueprint proposal linked to the request (`edits.requirements` and `edits.research` are the kept lists; without them, everything filed). The request's version, the limits, the references and the current grants are checked again inside this transaction, so a request changed or a limit lowered since the screen loaded fails the approval and creates nothing. No session key, permission rule or team membership exists yet. The request moves to `approved`.
- **Ask for changes:** a note (at most 500 characters); the request moves to `needs_changes`.
- **Deny:** an optional note; the request moves to `denied`. Nothing was created, so nothing is left behind.
- **Cancel** (after approval, before collection): revokes any unconfirmed keys, archives the request's agents, closes the slots and, for a new team, stops the draft team.

### Requirements from onboarding

<a id="content-from-onboarding"></a>Everything typed that the operator kept goes into **one Blueprint proposal**, linked to the request (`proposal_id`), and the approval lists each item with its intended scope: **team** (inside the team's part) or **project** (a module of the project outside the part).

The kept requirements become **one Blueprint proposal** in the new team's part, filed by the approval in the same transaction, for the operator to apply or reject in the Blueprint like any other ([proposals](blueprint.md)):
- each FR is keyed `FR-<module>-nn` under the team's new module, numbered in the order filed; each NFR `NFR-<CAT>-nn`, numbered after the project's highest; each acceptance criterion `<key>/ACn` under its requirement;
- every item is `draft`, with the title and text as the operator left them;
- the proposal has no agent behind it: its reason names the onboarding request, and it waits in the project's proposals with the usual `bp_proposal` alert.

A project's only team has no part ([blueprint](blueprint.md) §3, FR-PLAN-12): what would go in its module or line goes at project level instead, in a module (a line, in a research project) named after the team with no `team_id`, which the same proposal opens first, so applying it opens that module or line and files the records in one step; the items show scope **project**.

Nothing is applied silently: until the operator applies the proposal, the team's part holds only its module (or line), and a project's only team has nothing in the Blueprint yet.

Requirements go into a module: the team's new one, or the module named in `requirements[].module` (scope project when another team or the project owns it). A research project's new team gets a line, not a module, so a requirement there must name an existing module of the project; it is never put under a line. Without one, the approval names the requirement and the fix: untick it, name a module, or change the project.

Research records go into the team's line:
- each line becomes a line inside the team's line (`L3.1`, `L3.2`, …) with its mode and question, `active`;
- each hypothesis `H-<line>-nn` (`untested`, its statement and criteria), each question `Q-<line>-nn` (`open`);
- each paper `PAP-n` at project level, owned by the team, with its status, venue, type, manuscript and authors. A planned paper needs only a title. A paper's hypotheses are kept on the request and shown in the setup record; once the Blueprint has the `studies` relation (`paper → hypothesis`), the proposal also links each paper to them.

The owner of a line or paper (a role in the request) is shown with it in the setup record. The research coordinator keeps the papers current through the team's playbook and standard directive, like the rest of its part.

When nothing typed was kept (for example the only answer is "the operator will supply them"), no proposal is filed, never an empty one, and the setup record shows who owes the content.

### Setup progress

The request is the setup record. Its **setup** view, on the request and on the team's page in the console, is derived from the answers, the proposal's status and what the team's part holds, never stored:

| State | Who | Next step |
|---|---|---|
| Source not asked (the onboarding client did not ask: an older client left `source` out) | The operator | Set where the requirements or the brief come from. |
| `existing`, nothing kept | The coordinator | Read the source at its reference with the access the team has, and propose the requirements or brief with `bp_write`. |
| `coordinator`, nothing kept | The coordinator | Derive the requirements or brief from the goal and propose them with `bp_write`. |
| `operator`, nothing kept | The operator | Supply the requirements or brief. |
| Proposal open | The operator | Review the proposal in the Blueprint. |
| Proposal applied | Nobody | Done: the team plans from its part. |
| Proposal rejected, stale or withdrawn | Back to the named person (the operator for `operator`, else the coordinator) | Correct the content and propose again. |
| No proposal linked, and the part already holds content | Nobody | Done: the team plans from its part (n items). |

A rejected or stale proposal also notifies the team's coordinators, as for any team proposal.

**The part already holds content.** A team set up before the setup proposal existed has no proposal, so the card would never finish. With no proposal linked, the card reads Done as soon as the team's part holds live content beyond its own track: a live, non-archived item inside the module or line the team owns (other than that track item), or owned by the team and not a module or line. For a project's only team, which has no part (FR-PLAN-12), live project-level items count instead. Dropped and cut items do not count. The hub computes the count; a team right after approval, holding only its track item, is not Done. With a proposal linked, the proposal's status decides, as above.

**Setting the source on the card.** The operator can set or correct the source from the setup details (below), or on the Setup card where the team has no Blueprint to show (**Set the source**: the same three choices and checks as the request's `source`), in every state except while a proposal is in review. `PUT /api/onboarding/:id/source {source}` (admin) takes an approved or collected `new_team` request; any other request is refused with `invalid_state`, as is an open proposal. The answer is stored beside the approved request (`source_set`, migration 0136), never inside it: the approved body stays the record of what the operator approved, and the setup view reads `source_set` first. Each set is audited as `onboarding.source_set` with the old and new values. Only the operator sets it, because it is the operator's answer; a coordinator that needs it asks with `team_ask`. When the new state gives the coordinators work (an existing source, or the coordinator derives it), the team's coordinators get one `setup_source` notice: "The operator set where your requirements come from: … Next: …". Nothing is sent for `operator`, or when the card reads Done. The reference stays information: it grants no access.

**The setup is one row on the Blueprint card.** The team page gives the setup no card of its own: it is one row on the team's Blueprint card, after Coverage, reading `Setup · <state> · <the source, in short>` (Source not asked and Coordinator derives stand alone), with the full source in its tooltip. The value takes the state's tone; Done is plain. The row opens the setup details in a sheet: the state, the source, who, next, the proposal and what it filed, the note that a source reference grants no access, and **Set the source** in every state except while a proposal is in review. When the next step is the operator's (Source not asked, Waiting for you, or Returned to the operator), the operator's Needs you lists "Setup: <next step>" (kind `setup`, scoped to the team), which opens the sheet; its episode is the setup's state, so the row leaves by itself when the state changes. A proposal in review is already there as the proposal. A team with no Blueprint to show (no project yet, or one that could not be read) keeps the card in every state.

Why keys and members wait: `team_members.credential_id` is `NOT NULL`, `insertMember` (through `pickCredential`) refuses an agent with no active session key, and standing rules live on the key's policy (`setRules(credential.policy_id, …)`). So:

| When | What happens |
|---|---|
| Approve | Agents and slots, as above. |
| Pickup (each issue) | Per slot: `createSessionKey` with no expiry, the slot's ceiling applied to its policy, the binding set. A reissue revokes the previous unconfirmed keys first. No team membership. |
| Confirm (one transaction) | Each agent joins the team with its confirmed key (`insertMember`). A new team starts. Agents for a running team (`add_agents`) join here. |

Approval does not reuse `recruit_requests` (its `requested_by` is `NOT NULL REFERENCES agents`, and no status fits a pickup slot). The other way round, a [recruit](#recruits-from-a-coordinator) reuses onboarding's pickup: its request and slot are created by the recruit path, not by this approval, and only a recruit's agent has `recruited_team_id`, so switching recruiting off never revokes agents onboarded by a request the operator approved.

<a id="3-the-script-waits-not-the-model"></a>

## Waiting and pickup on the PC

The connector waits, not the model. `conclave setup continue --wait <s>` long-polls `GET /onboard/requests/:id?wait_s=…` (at most 45 seconds a call), so waiting costs no model tokens, and the connector's screen shows where the request stands. When the request is approved, the connector goes on by itself:

1. **The PC user's Allow.** The screen lists the pickup ("session keys for the approved team request …") with the folders it will build, and nothing is picked up before the click.
2. **Pickup and confirm** ([endpoints](#endpoints)): the hub creates the session keys now. The connector saves the list of agents first (no secrets), then writes each key into the hub's section of its key file, builds and registers each agent's folder, and confirms.
3. **Folders**, for each agent under the chosen root, as in [Setting up the folders](#setting-up-the-folders). A folder that already holds files waits for its own click on the screen.
4. Shows each agent as **Ready to open**, with its way to open it, until the agent's first call makes it **Connected**.

If the approval does not come while the agent's command runs, the command ends with "Waiting for your administrator to approve the request." and exit code 3. The agent tells the user and ends its turn; it never loops on its own. The screen, or `conclave setup continue` in a later turn, picks up from there.

For `add_agents`, the new folders join the existing team; the coordinator sees them in its team notices.

## Endpoints

Plain HTTPS on the hub, outside `/mcp` and the admin API. `Cache-Control: no-store`. Off loopback, plain HTTP is refused with `426`, except the public downloads.

| Call | Auth | Result |
|---|---|---|
| `GET /onboard/ca.crt`, `GET /onboard/client/restore-prompt.md`, `GET /onboard/client/manifest` | None (public files) | The hub's CA certificate and the checkout restore template. The LAN plain-HTTP port serves only `ca.crt`, which is checked against the fingerprint in the prompt. |
| `GET /connector/v1/hub`, `POST /connector/v1/pair` | The pairing code, once | The hub's identity, then the app key's secret, the hub, the PC and what the code was for (`code_kind`: `pc` or `invite`). See [The code](#the-code) and [connector.md](connector.md#add-pc-download-and-pairing). |
| `GET /onboard/choices` | App key | What this PC may ask for: the projects, and the teams set up from this PC with their roles; for an invite's PC, only its invite. |
| `POST /onboard/invites/:id/redeem` | The app key the invite's code paired | Joins the invite's team and role ([An invite for a collaborator](#an-invite-for-a-collaborator)). |
| `POST /onboard/requests`, `PUT /onboard/requests/:id`, `POST /onboard/requests/:id/withdraw` | App key with the capability | File, amend, withdraw. `{request_id, version, state, warnings}`. |
| `GET /onboard/requests/:id?wait_s=0..45`, `GET /onboard/requests?pending=1` | App key (its own requests) | `{request_id, state, version, operator_note, edits, project, team_id, filed_at, waiting_since, agents}`; `agents` from `approved` on: `[{label, role, session_var, folder}]`, no secrets. Returns early on a change. A checkout request adds `checkout` (agents, render choices, handout bodies and hashes, config scans; [checkout §6](checkout.md#6-restore-by-the-connector)). |
| `POST /onboard/requests/:id/scan {folders: [{folder, findings: [{kind, path, detail}]}]}` | The app key that filed the checkout request | The restore's config scan, before pickup. Returns `{scans}`. Counts against the pickup limit. Pickup is refused with `scan_pending` until every agent folder is scanned and none waits for the operator; confirm then answers `trust: {folder: bool}`. |
| `POST /onboard/pickup {request_id}` | The app key that filed the request, with the capability | Creates the session keys and returns `{pickup_id, hub_url, team: {id, name}, agents: [{agent_id, label, role, team_role, session_var, folder, secret, instructions}]}`. `session_var` is `<PROJECT>_<TEAM>_<ROLE>[_<n>]_SESSION_KEY`, upper-cased, non-alphanumerics as `_`, unique among the PC's keys; the connector uses it as the slot's name, not as an environment variable. |
| `POST /onboard/pickup/confirm {pickup_id, written: [session_var…]}` | Same | Adds the agents to the team, moves the request to `collected`, starts a new team. Records the PC's MCP transport, which the connector always sends as `https`. `written` must list every slot. |

There are no onboarding MCP tools: the session that runs the prompt has no hub connection yet, and the connector makes every hub call itself.

### One-time pickup, retries and a lost response

- **Secrets are created at pickup, not stored.** The hub keeps only verifiers. Approval stores slots, not secrets or keys.
- **Before confirmation, a retry reissues.** A second `pickup` before `confirm` creates fresh keys and revokes the previous unconfirmed ones; no team member points at an unconfirmed key. `confirm` accepts only the latest `pickup_id`.
- **At most 3 issues before confirmation.** The fourth is refused and alerts; the operator checks the PC and presses **Reissue pickup**, which allows 3 more and revokes any unconfirmed set.
- **After confirmation, never again.** `pickup` on a `collected` request returns `invalid_state` and raises `onboarding_pickup_after_collect` (warning). Only [Re-enrol PC](#later) reopens one.
- **A lost confirm.** The connector writes the keys into its key file before confirming and keeps the `pickup_id` (not a secret) in its state file; on the next run it only repeats `confirm`.
- **Bound to the PC:** only the app key that filed the request can pick up and confirm.
- **A lost approval response.** The approval records the version it was made against. Sending the same approval again (`version` unchanged) after the request moved on returns the original result, with the same team and proposal and `replayed: true`, and creates nothing; a different `version` gets the usual `invalid_state` or `conflict`.

## PC binding of session keys

Migration 0025, the login check, `PUT /api/keys/:id/binding` and the switch on the key's overview in Keys implement it; rotation keeps the binding. The approval screen has a per-agent "Only from <PC>" switch, on by default for onboarded agents.

**Every session key has a binding switch** in Keys: "Use only from <PC>" or "Free (any permitted PC)". It is a general key feature, not only for onboarding.

| Rule | Value |
|---|---|
| Storage | `credentials.bound_machine_id`, null when free. |
| Defaults | Onboarded keys: bound to the PC that collected them. Keys made with **New session key** on a PC's page: bound to that PC, with **Free** as the other choice on the form. Keys created by hand in Keys: free. |
| Where it is set | Per agent on the approval screen (prefilled bound); at creation, `POST /api/keys {kind: "session_key", …, machine_id}` (the PC page sends it), bound in the same transaction so the key is never free in between and audited as `key.binding_set` with `source: "create"`; any time in Keys on the key's row (`PUT /api/keys/:id/binding {machine_id}`; `{machine_id: null}` makes it free). Changing it is audited (`key.binding_set`) and takes effect at the next login. |
| Effect | `session_login`, and header login, with a bound key succeed only through an app key whose PC is the bound one. Elsewhere it fails as an invalid key (the caller learns nothing more), raises `bound_key_elsewhere` (warning, with both PCs) and is audited. Existing sessions are not ended by binding; the operator ends them in Keys if needed. |
| What it protects | A **session key leaked without its PC key** (pasted into a chat, a log, a share) cannot be used from any other PC. It does **not** stop a thief who holds the PC's app key: the binding is satisfied by that app key, and the session keys sit in the same key file. |

Bound by default whenever the hub knows the PC: a key made from a PC's own page starts bound to it. A separate `PUT /binding` after create was not chosen, because the key would be free between the two calls.

## Key handover: a rotated key or a recruit reaches a connector PC

A session key never travels through a chat, a prompt or the console when its PC runs the connector. The hub makes a **key handover** for that PC, the PC's user allows it on the connector's screen (a recruit of a team set to **Automatic** needs no click at the standard level, because the operator's setting is the approval; the handover list marks it `no_click`), and the connector picks the keys up, writes them into its key file and confirms. It is the same pickup an onboarding request uses (`POST /onboard/pickup` and its confirm), so it survives a crash the same way. It replaces the key pickup codes (`setup.mjs key`) and the Codex wake's collection: those routes refuse from this release on, and their tables (`key_pickups`, `key_collections`, `key_collect_polls`) are no longer read or written; they are dropped one release later. Server code: `server/src/keys/handover.ts`, with the pickup in `server/src/onboarding/onboarding.ts`. Connector code: `deploy/client/connector/handover.mjs`. Tests: `server/test/key-handover.test.ts` and `deploy/client/connector-handover.test.mjs`.

| Rule | Value |
|---|---|
| What it is | An onboarding request the hub files itself (`handover` set on the row): `rotate` (new secrets for existing session keys; the request's kind is `rotate`) or `recruit` (new agents from `team_recruit`; kind `add_agents`). One slot per key or agent. It is born `approved`: the operator's Rotate, or the team's recruit envelope, is the approval. It is never an onboarding request anyone can act on: the operator's request queue leaves it out, and approve, deny, needs-changes, amend, withdraw and the PC's `GET /onboard/requests/:id` answer `not_found` for it. It still counts as the PC key's one pending request ([the app key and its onboarding capability](#the-app-key-and-its-onboarding-capability)): while it waits, the PC files nothing else (`invalid_state`, audited as `onboarding.request_refused_pending`) until it is confirmed, cancelled or expires after 24 hours. |
| Bound to | One PC and one app key: the app key the PC's connector last checked in with (`connector_reports`). There is no other fallback: a PC with no connector report gets the show-once path, because no connector there could ever allow the handover. Only that app key can list, pick up or confirm it. When that app key is rotated or replaced (after a leak, below, or at Re-enrol), its open handovers move to the new key, and the old one is refused for them. A woken run or a turn token cannot reach these routes, because they need the app key. |
| Which PC | For a rotation, the key's PC: the binding, else the PC of the last login, else the PC that collected it. A key whose PC has no connector report, or is retired, is shown once instead (the raw key, the one fallback; audited as `key.rotate` with `delivery: "shown"`). For a recruit, the coordinator's PC, as before. |
| Signal | The check-in answer carries `handovers` (the number open for this app key) and the push stream sends `event: handovers`. Neither carries a secret. `GET /connector/v1/handovers` (app key) lists `{id, kind, description, agents: [{agent_id, label, key_id}], expires_at}`: plain descriptions and, for a rotation, the public id of the key being replaced (`ah_ses_<key_id>`, never the secret), so the connector finds the agent that holds it. Under a lockdown of all writes or of this PC the list answers `423 lockdown`, as the pickup does; the connector keeps its clicks and staged keys and tries again after the lift. A connector that holds no key with that id reports it with `POST /connector/v1/handovers/:id/skip {reason: "key_not_held"}`, and the hub cancels the handover at once (`not_on_pc`), so the console says so instead of waiting 24 hours. A recruit whose folder the connector refuses (below) is reported the same way (`folder_refused`). |
| The click | The connector asks the PC's user first (except for a recruit of an Automatic team at the standard level, which the hub lists as `no_click` and the connector takes with no click), on both the standard and the hardened level: the screen lists the hub's description, shown as the hub's words ("New key for Coordinator (rotation)", "2 new agents for team X"), with **Allow**. The click is bound to that handover's id. It covers that handover until it is confirmed, so a crash before confirm does not ask again, and it is spent at confirm or when the handover is cancelled or expires. A new Rotate is a new handover and asks again. Without the click nothing is picked up. |
| Pickup | `POST /onboard/pickup {request_id}` with that app key. Refused for another app key or PC (`not_found`), after 24 hours (`invalid_state`, expired), and once confirmed. For a rotation the answer holds each key's new secret once; the hub keeps only its verifier on the slot, and **the old key keeps working**. A second pickup before confirm replaces the staged secrets, so a key picked up and lost never works. For a recruit the agents' keys are made as for any onboarding pickup. |
| On the PC | The connector saves the list first (no secrets), then writes the keys (through the key service on a hardened PC), never into a log, the environment or a chat. **A rotated key is staged:** the new secret goes beside the old one, as a `staged` entry under the same label, and the old key stays the one in use. Only when confirm answers 200 does the connector swap them; when confirm is refused for good (a 4xx such as expired, cancelled or replaced, carrying the hub's own code `invalid_state`, `not_found` or `conflict`), it discards the staged secret and the old key goes on working. Any other answer (401, 408, 429, a 5xx, a relay's 502, or a bare 404 or 409 without the hub's code) counts as no answer: the hub may already have swapped and revoked the old key, so the staged secret is kept and confirmed again at the next run. After a restart a staged entry is confirmed again, then swapped or discarded. A recruit's keys are staged the same way, so a refused confirm leaves no key behind. A recruit's folder name and its team's name come from the hub, so the connector builds the folder only inside the team's root on this PC (beside the team's other agents, else under the root of the request that set the team up here, else the default root), as a real path, under the same name rules as transfers: no `..`, no reserved name, and no folder below the root that is a link or junction. Anything else is refused and reported (`folder_refused`), and no key is kept. The folder is registered, so the hub sees it as a proposed folder for the operator to approve. |
| Confirm | `POST /onboard/pickup/confirm {pickup_id, written}`. For a rotation, only now is each old key revoked, with its logins and turn tokens ended, and the new key takes over its rules, grants and team places (the usual `key.rotate`, `delivery: "handover"`). For a recruit, the agents join the team. Confirm is idempotent per `pickup_id`: a second confirm after a lost answer answers 200 with the same result (`already: true`), so the connector keeps the new key. A crash between pickup and confirm leaves the old key working: the connector confirms when it already wrote the keys, and picks up again when it did not. |
| After a possible leak | A rotation with the answer "Yes, or I'm not sure" (`reason: suspected_leak`) on a connector PC also **replaces that PC's connector app key**, because whoever took the session key may hold it too. Only that app key is revoked (`pc.app_key_replaced`, with the old and new key and the codes revoked); the PC's other app keys and the other agents' session keys stay. **The suspected session key is held at once** (`key.hold`; the console shows it as **Held: leak rotation**): it is suspended with the reason `leak_hold`, so its logins and turn tokens end and none is given again, through any PC's app key, so a free key (`bound: false`) used from another PC is refused too. This costs nothing, because the agent's PC is offline until it is paired again anyway. Holding the key does not cancel its handover (an operator's suspend does, below). Replacing the app key, filing the handover and holding the key are one transaction: if the handover cannot be filed, nothing is replaced. A new app key and its pairing code are issued, and the rotate answer carries the code once (`pairing: {code, code_expires_at, ca_check, hub_origin, pc}`). The handover is bound to the new key; the old app key cannot list, pick up or confirm it. Revoking the old app key ends every session and turn token issued through it, so **until the PC user pairs the connector again, no agent on that PC can reach the hub**; the other agents' session keys stay valid and work again once the connector is paired. `conclave pair` with the new code replaces the app key in the same section of the PC's key file (same hub, same CA), so the agents' keys and the folder approvals on the PC stay: pairing again loses nothing. The handover waits, with the usual 24-hour expiry, until the new app key picks it up; its confirm makes the new secret the agent's key and revokes the held one. |
| Expiry and cancel | A handover not confirmed within **24 hours** is cancelled (nothing changes on the hub; for a recruit, the waiting agent is archived as when recruiting is switched off). The console shows an open handover as **Waiting for the PC user** on the key's Overview and in Needs you, with **Cancel**; the operator can also rotate again, which replaces it. Revoking, suspending or re-binding the key cancels it too, and so does the connector's skip report; holding it for a leak rotation does not. **A leak rotation that ends without confirm** (expired, cancelled, skipped) leaves the old key held, never live again by itself: the key's page and Needs you say **Leak rotation not finished: rotate again or revoke**. Rotating again starts a new handover for the held key. **Resume** is refused for a held key, because it may have leaked: it comes back only as a new key (rotate) or not at all (revoke). |
| Audit | `key.handover.created`, `key.handover.picked_up`, `key.handover.confirmed` and `key.handover.cancelled` (with the reason: `operator`, `expired`, `replaced`, `revoked`, `binding_changed`, `not_on_pc`, `folder_refused`, `team_ended` (a suspended key is recorded as `revoked`), and `rotation_reason: suspected_leak` when it was a leak rotation), each with the PC and the agents, never a secret. A leak rotation adds `pc.app_key_replaced` and `key.hold`; a Re-enrol handover on a PC that holds none of the keys adds `pc.re_enrol_keys_lost`. |

**In the console.** **Rotate secret** keeps its question "Could this key have leaked?". When the key's PC runs the connector, the action is **Rotate and send to <PC>**: the result is a status card on the key's Overview ("Waiting for the PC user to allow it on <PC>", with Cancel), which turns green at confirm. After a possible leak the sheet says that the connector's app key on that PC is replaced too, that the key is held at once, and that until the PC user pairs the connector again no agent on that PC can reach the hub; the result then shows the new pairing code once, with the `conclave pair` command for that PC. A key with no connector PC gets **Rotate and show the key once**: the raw key, shown once, with the existing one-time view. No Conclave client writes such a key for the person, so **Re-enrol PC** is usually the better way: the PC pairs the connector and its keys arrive by handover. A handover the PC reported as not held there shows "Not on <PC>: this PC does not hold the key", with Rotate again. **New session key** on a PC's page works the same way: the new key reaches the PC by handover.

**Never into a repository.** No step writes a key into a file inside a repository. Keys live in the connector's key file, outside version control.

## HTTPS without OS trust

The connector **pins the hub's CA at pairing**: the prompt carries the CA's full fingerprint, the installer checks `/onboard/ca.crt` against it, and the connector keeps that CA as the only trusted root for the hub. Pairing, requests, pickup and every agent's calls run over HTTPS with that pin, and `426` on plain HTTP stays. Nothing is added to the operating system's certificate store, and no app restart is needed for it. The agents' own clients reach the hub through the connector (`conclave mcp <folder>`), so they need no certificate setting either.

What each step may use on the LAN profile ([lan.Caddyfile](../deploy/caddy/lan.Caddyfile)), and why it is safe:

| Step | Transport | Why it is safe |
|---|---|---|
| The installer | From the release page, or from the administrator on a local-only network | Signed with the release key the installer carries, and checked against the SHA-256 in the prompt or in `SHA256SUMS` ([connector-release.md](connector-release.md)). |
| `/onboard/ca.crt` | Plain HTTP or HTTPS. Caddy's plain-HTTP site proxies this onboarding path only. | The certificate is public, and it is checked against the fingerprint in the prompt before use. A swapped certificate fails that check, so it is never trusted. |
| Pairing (`/connector/v1/pair`) and requests (`/onboard/requests*`, `/onboard/choices`) | HTTPS only, with the CA pinned. Plain HTTP gets Caddy's 308 to HTTPS, and the hub answers `426` if it is reached on plain HTTP anyway. | The code and the PC's app key travel here. The pinned CA means a machine in the middle cannot present its own certificate. |
| Pickup (`/onboard/pickup`, `/pickup/confirm`) | HTTPS only, with the CA pinned. | Session keys travel here, once; the same pinning and `426` apply. |

There is no plain-HTTP choice for the agents: the connector refuses a hub address that is not pinned HTTPS. The console still marks a PC whose recorded transport is plain HTTP; only a PC set up before the connector can have one.

## Doctor

`conclave check` diagnoses a folder on the PC. It is read-only: it reads the key file, the registry, the folder's own entry and `~/.claude.json`, stops at the first problem and names it in one line with the command that fixes it. `--probe` also asks the hub once whether the agent can sign in, without keeping a token. `conclave setup status` shows every agent of the PC with its state, and says so when the hub refuses the PC's own app key. The reasons and their order are in [connector.md](connector.md#when-something-is-wrong).

| Reason | Means | Fix |
|---|---|---|
| `not_registered`, `identity_changed`, `folder_changed` | The folder is not the one the connector set up (a copy, a clone, or changed agent settings). | `conclave check`, then `conclave repair` |
| `no_hub_key`, `key_missing` | The key file has no key for this hub or this agent. | Continue setup, or ask the operator to re-enrol the PC. |
| `ca_changed`, `tls_refused`, `not_https` | The hub's address or CA is not the one this PC paired with. | Pair again with a code from the operator. |
| `trust_withdrawn`, `entry_stale` | Folder trust was turned off, or the folder's entry points to a Node or connector file that moved. | `conclave repair` |
| `hub_unreachable`, `login_refused` (with `--probe`) | The hub cannot be reached, or it refused the agent's key (revoked, rotated, or issued by another hub). | Check the network; for a refused key, the operator rotates it or re-enrols the PC. |
| `connector_not_running`, `needs_click` | The connector's service is not running, or the folder's first chat waits for the PC user's Allow. | `conclave service status`; `conclave setup` |

The agent reports the line as it is, then the [recovery](#blockers-and-recovery).

## Blockers and recovery

Where onboarding can get stuck, and how this design removes or handles each case. The agent reports the connector's line or the hub's error as it is, then the recovery; it never guesses a cause it did not see.

### Before the request (new PC)

| Case | What the user sees | How this design handles it | Who acts |
|---|---|---|---|
| **No Node** | The prompt's install command for the platform. | Checked first. The agent gives the command and runs it only after the user agrees. The connector calls Node by its absolute path, so no app restart is needed. | User agrees; agent runs |
| **The installer does not check out** | The installer refuses to run. | The signature and the SHA-256 in the prompt are checked before anything is installed. Get the installer again from the release page or the administrator and compare the fingerprint through a trusted connection. | User, operator |
| **The code is refused** | "This code was refused. If you just received it, tell the operator now: someone else may have used it." | Every refusal gives the same answer. The operator makes a **New code** (or Re-enrol PC once the PC has paired) and checks **Paired just now** for a pairing that was not the user. | Operator |
| **No route to the hub** | The installer or the connector says the hub cannot be reached. | Nothing is filed until pairing succeeds. Check the network, VPN, and that the address in the prompt is the one the certificate was issued for. | User; operator if the hub is down |
| **No standard input for the code** | The agent stops and asks the user to run the installer in a terminal. | The code is never an argument, a file or part of a URL. | User |
| **Config not writable** (corporate PCs) | Setup names the folder or file it cannot write. | Found before anything is filed. Ask IT for write access; another config location is not supported. | User, IT |

### The request

| Case | What the user sees | How this design handles it | Who acts |
|---|---|---|---|
| **A second request while one is pending** | "This PC already has a pending request: <team>, filed <time>, waiting for <step>." | The connector reads the pending request first (`GET /onboard/requests?pending=1`) and offers to wait, amend (while `submitted` or `needs_changes`) or withdraw it. A waiting key handover is not listed there: the refusal names it, and the PC user allows it on the connector's screen or waits until it is cancelled or expires. After approval only the operator can cancel. | User; operator to cancel |
| **Over the limits** | The field and the rule ("13 agents, at most 12"). | `invalid_argument` with the field path. The agent proposes a smaller team, or a second request (`add_agents`) once the first is collected. | User |
| **Vault folders that do not exist** | A warning per folder. | `folder_missing` warning, to the connector and the operator. The agent asks whether it is a typo or a folder to create; the operator may grant it anyway. | User; operator decides |
| **Project name clash** | "A project <name> already exists. Did you mean it?" | `invalid_argument` with close matches; use the existing project or another name. | User |
| **The model misreads the prompt** | The summary does not match what the user meant. | Nothing is filed without the user's yes to the one-screen summary. After filing, amend while `submitted` or `needs_changes`. The operator also sees the user's own words. | User |

### The approval

| Case | What the user sees | How this design handles it | Who acts |
|---|---|---|---|
| **The operator is away** | "Waiting for your administrator to approve the request." | One wait, not two. Nothing expires; Home shows the request with its age, oldest first. The connector's screen keeps the request; the user may contact the operator outside Conclave. | Operator |
| **`needs_changes` with an unclear note** | The operator's note, word for word, labelled as theirs. | The agent explains what it may mean, marked as its reading, and proposes an amendment for the user to confirm; if still unclear, the user asks the operator. | User, operator |
| **Operator edits that conflict with the plan** | The edits as a list, with conflicts called out ("The reviewer role was removed; the developer's work has no reviewer"). | The approval screen warns the operator about such edits before approving. Each agent's instructions file is built from the approved playbooks, never from the request, so it matches the edits. If the user cannot work with them, they ask the operator, who edits the team page or cancels. | Operator; user |

### Pickup and setup

| Case | What the user sees | How this design handles it | Who acts |
|---|---|---|---|
| **Lost response or crash** | Continue setup finishes on the next run. | Every step is idempotent with a state file; see [retries](#one-time-pickup-retries-and-a-lost-response). After 3 issues the operator presses **Reissue pickup**. | User; operator after 3 |
| **The pickup waits for Allow** | "Approved. Waiting for the PC user to press Allow on the connector screen." | Nothing is picked up without the PC user's click. A declined pickup can still be allowed on the screen. | User |
| **Keys collected elsewhere** | "The hub says these keys were already collected, but not by this PC's setup." | The request was collected by another app key or an earlier install. The operator re-enrols the PC. | Operator |
| **One agent fails** | That agent's row shows its reason; the others are set up. | **Retry** (`conclave setup retry <agent>`) rebuilds that folder alone. | User |
| **Git missing** | Setup offers a private git on Windows, or gives the install command elsewhere. | See [Setting up the folders](#setting-up-the-folders). | User agrees |

### Starting the team

| Case | What the user sees | How this design handles it | Who acts |
|---|---|---|---|
| **A chat needs one click per agent** | The screen's **Open agent** with the folder to choose. | Nothing outside Claude Desktop can start a Desktop chat, so the screen names the exact folder and where the chat will show. A terminal or Codex agent has one copyable command. | User clicks |
| **A session opened in the wrong folder** | That session has no hub tools. | Each agent's instructions say to stop and report the client's error and the output of `conclave check` when the conclave tools are missing; `conclave check` names the reason. | User |
| **Usage limits stop sessions mid-task** | A usage-limit message. | Hub state is kept; started work passes its check-in time, is flagged overdue and stays with its holder. Resume after the reset; the coordinator picks up from `task_list`. The operator can lengthen `lease_minutes` or `stall_minutes`. | User; operator for settings |

### Later

| Case | What the user sees | How this design handles it | Who acts |
|---|---|---|---|
| **Adding agents from another PC** | `denied`. | `add_agents` works only from the PC that onboarded the team. Run the prompt there, or the operator adds agents in the console from that PC's page, and each key reaches the PC by [key handover](#key-handover-a-rotated-key-or-a-recruit-reaches-a-connector-pc). | User or operator |
| **Agent folders moved** | The folder's session has no hub tools. | The connector binds each folder by its identity. `conclave check` names the moved or copied folder (`not_registered` or `identity_changed`); `conclave setup retry <agent>` rebuilds it at its recorded place. | User |
| **A rotated or revoked key leaves a dead folder** | `conclave check --probe` says `login_refused`; the screen shows **Key refused by the hub**. | A rotation reaches the PC by key handover, so the PC's user allows it on the screen. For a revoked key the operator makes a new one (it also arrives by handover) or re-enrols the PC. | Operator, then user |
| **PC replaced, reinstalled or lost** | Keys and folders gone; pickup says already collected. | **Re-enrol PC** issues a new code and app key and revokes the PC's old app keys at once. The agents' keys are handed over once the PC is paired again; a connector that holds none of them reports it, and the hub then revokes them and reopens the PC's collected requests for a fresh pickup, which Continue setup takes. For a lost PC whose keys must stop at once, the operator also revokes them in Keys. | Operator, then user |
| **A hub upgrade does not start** (for example a database the runner does not recognise, or an applied migration that changed) | The connector says the hub cannot be reached. | Nothing is filed or collected, and nothing pending is lost. The operator fixes the deployment (the stop message in the log says what to do). | Operator |

## Admin API

| Route | Purpose |
|---|---|
| `POST /api/pcs/add {name, description?, relay_id?}` | Add PC: PC, app key with the capability, pairing code. Returns the code, the pairing block (`code_expires_at`, the hub check, the origin) and the hub's prompt (`connector_prompt`), or `connector_unavailable` when the hub cannot be pinned. The code appears only in this response. |
| `POST /api/pcs/:id/prompt` | **New code**: a new code for the PC's app key, with the prompt again; the old unused code is void. Only before the PC has paired. |
| `GET /api/pairings` · `POST /api/pairings/:id/keep` · `/revoke` | [Paired just now](#paired-just-now): It was me, or Revoke. |
| `POST /api/invites` · `GET /api/invites` · `DELETE /api/invites/:id`; `GET /api/me/invites` · `POST /api/me/invites/:id/code` | [Invites](#an-invite-for-a-collaborator): the operator's side, and the collaborator's own. |
| `POST /api/pcs/:id/re-enrol` | New code, prompt and app key (it also ends a disconnect); revokes the PC's old app keys and any unused code at once. With a connector report, answers `handover` (the handover that carries every agent key; the old keys work until confirm). Without one, revokes the onboarded session keys and reopens a pickup on each of the PC's collected requests (`reopened`). |
| `GET` / `PUT /api/settings/onboarding` | The per-request limits (roles, agents, per role, rules, requirements) and the filing rate limits; defaults 8, 12, 5, 20, 30, and 5 an hour, 20 a day per PC key. |
| `GET` / `DELETE /api/pcs/:id/enrolment` | The PC's code state; revoke an unused code. |
| `GET /api/onboarding?status=` · `GET /api/onboarding/:id` | List; one request with its versions, computed access, warnings and history. |
| `POST /api/onboarding/:id/approve {version, edits?, agents: [{slot, include, template_id, bound}]}` | The one approval. `edits` may carry `rules` (the ticked rules), `requirements` (the kept requirements), `research` (the kept lines and papers) and, for a new team, `standard` (the wording of the two standard directives, `[{key, title, text}]` with `key` `who_decides` or `operator_only`). Onboarded session keys have no expiry. A new team starts when setup completes. A [vault agent](#a-vault-agent) request also needs `owner_id`, and its `edits` may carry `team.name` (the agent's name) and `roles[0]` (job and folders). |
| `POST /api/onboarding/:id/needs-changes {note}` · `/deny {note?}` · `/cancel {note?}` · `/reissue-pickup` | As above. |
| `PUT /api/keys/:id/onboarding` · `DELETE /api/keys/:id/onboarding` | Capability on or off. |
| `PUT /api/keys/:id/binding {machine_id}` | Bind a session key to a PC, or `null` for free. For any session key. |
| `POST /api/keys {kind: "session_key", …, machine_id?}` | Create a session key bound to that PC from the start (the PC page's **New session key**); omitted or null: free. An unknown PC is refused before a new agent is made. |

A [checkout](checkout.md) restore is an onboarding request of kind `checkout`, picked up and confirmed on the same `/onboard` routes. The request is approved at render, because the target PC is already paired with the connector. Its keys are successors: the old key is suspended at confirm, and the moved agent's first call, `checkout_resume`, is accepted only from a login of the new key made after confirm.

## Audit, alerts and notices

| Event | Audit | Alert |
|---|---|---|
| PC added, re-enrolled, code renewed or revoked; connector paired or pairing refused; app key replaced after a leak | `pc.add`, `pc.re_enrol`, `pc.re_enrol_keys_lost`, `pc.app_key_replaced`, `onboarding.code_renew`, `onboarding.code_revoke`, `connector.paired`, `connector.pair_refused`, `connector.pairing_revoke` | `enrolment_code_reused` (warning); `enrol_fail` burst (warning) |
| Capability on or off | `onboarding.capability_grant`, `…_remove` | |
| Request filed, amended, withdrawn; second refused | `onboarding.request_file`, `…_amend`, `…_withdraw`, `…_refused_pending` | `onboarding_request` (info, a Home item while it waits; it closes by itself once the request is approved, sent back, denied, withdrawn or cancelled, and opens again when a request that was sent back is amended) |
| Approved (edit summary, agent IDs, templates, bindings), changes asked, denied, cancelled | `onboarding.approve`, `…_needs_changes`, `…_deny`, `…_cancel` | |
| A recruit filed for pickup on the coordinator's PC | `agent.recruit` (with the request), `onboarding.recruit_file` | `agent_recruited` (info) |
| Pickup issued, confirmed, reissued, reopened by re-enrol | `onboarding.pickup_issue` (issue number), `…_confirm`, `…_reissue`, `…_reopen` | `onboarding_pickup_retry` (warning) on the 3rd issue |
| Pickup refused (after collect, wrong key, failed auth) | `onboarding.pickup_refused` | `onboarding_pickup_after_collect` (warning); failed-auth burst as for logins |
| Key prompt: a key picked up; a pickup code refused | `key.pickup`; `key.pickup_refused` | failed-auth burst as for pickup |
| Binding changed; bound key used elsewhere | `key.binding_set`; `auth.bound_key_elsewhere` | `bound_key_elsewhere` (warning) |
| Request refused by the key scan | `onboarding.request_refused` | `credential_leak` as today |
| An unknown session key retried from one place | the sign-in records (`authentication_events`) | `unknown_session_key` (warning), see below |

### Unknown session key

An agent whose folder holds a stale or mistyped key keeps retrying its login, and the hub refuses each one the same way
as any wrong key. When one session key id that the hub cannot match (outcome `unknown` or `invalid`; a bound key used
elsewhere has its own alert) is refused **3 times within 10 minutes from one source**, the hub raises
`unknown_session_key`. A single typo raises nothing. The count is a sliding window over the sign-in records, by source
and key id; the thresholds are `alerts.unknownKeyMax` and `alerts.unknownKeyWindowMs` in the config.

The alert has one row per PC and key id (subject `<pc>/<key id>`; later refusals bump its repeat count). It names the
PC behind the app key and the teams whose active keys are bound to that PC. The console says "this agent's key is not
recognised". On that PC, `conclave setup status` and `conclave check --probe` in each agent's folder show which agent
it is; the operator then rotates its key or re-enrols the PC, and the new key reaches the PC by key handover.

### Setup checks

The connector keeps each agent's key under its own label in the hub's section of the key file, and `conclave check`
looks only at whether a key is there for the folder's agent (`key_missing`), never at its value. `conclave check --probe`
asks the hub whether that key can sign in and reports `login_refused` when it cannot, so a folder whose key is stale is
told apart from one whose connection is broken.

Audit details hold IDs, states, counts and field names, never request free text or secrets. There are no agent notices before pickup; the connector learns everything from the status. After pickup, the coordinator's first login carries the usual team notices.

## Threat model

| Threat | Controls | Remaining exposure |
|---|---|---|
| **Installer and updates:** the hub, or someone in the middle, serves a tampered connector; a downgrade to a weak version; a lost signing key. | The installer and every update are signed by a release key that is not on the hub, and checked against a key the connector carries, independently of the hub, for signer, version and platform. Downgrades the hub asks for are refused. Rollback goes only to the previous verified build on the PC. Key rollover is signed by the old key. The maintainer approves each version; the PC user can turn updates off. A private git, when the user accepts it, is a pinned version checked against the hash in the connector's signed release. | Whoever holds the release key can ship code to every PC that updates. Flaws in that git version until the next connector release. |
| **Pairing:** a code read from a chat or a log; a second hub with the same CA; a CA swapped in later. | The code appears only in the console and on the local pairing screen, never in a prompt, chat, argument or log. It lasts 30 minutes and is bound to the hub's identity, origin and CA pin. A changed CA or origin needs the PC user's local confirmation. A web pairing screen listens on loopback only, with a one-time token and an origin check. | Someone at the user's screen during those 30 minutes. |
| **The prompt leaks** (a transcript, a chat, a screen share) | It holds no secret: the hub's address, a public fingerprint and the installer's hash. It is the same for every PC. | None from the prompt itself. |
| **The code leaks** (sent through a shared chat, read over a shoulder) | It is sent apart from the prompt, works once, for 30 minutes, and only for this hub's identity, origin and CA. The agent passes it only to the installer on standard input, so it is never an argument, a file or part of a URL, and the leak guard refuses it in hub content. Reuse is refused and alerts (`enrolment_code_reused`); every pairing shows on Home as **Paired just now** until the operator keeps or revokes it. | Someone who uses a leaked code within its 30 minutes pairs as that PC. The operator sees it under Paired just now and revokes it, and the real user's code is refused with the warning to tell the operator. |
| **Stolen PC key** (from the connector's key file or a backup) | The capability allows only filing, status and pickup. One pending request per key; every request needs the operator's approval with the PC name and its history on screen. The operator can turn the capability off, or suspend or revoke the key, at any time. Pickup after collection alerts. | A thief can file requests while the capability is on (each reaches the operator) and can collect an approved request's keys before the real connector, which then fails and alerts. **PC binding does not help here**: the thief holds the PC's app key, which satisfies it, and the session keys sit in the same key file. Turn the capability off on PCs that no longer need it. |
| **A session key leaked without its PC key** | Bound keys (the default for onboarded keys) fail from any other PC, alert and are audited. The inbound key scan refuses keys pasted into hub content. | A free key works from any permitted PC, as today. |
| **Replayed or intercepted pickup** | Keys are created at pickup and never stored. A retry revokes the previous unconfirmed set. Confirm accepts only the latest `pickup_id`; after confirm, pickup is refused and alerts. Pinned HTTPS for every connector call; `426` on plain HTTP; `no-store`. | An attacker who holds the PC key and wins the race to confirm gets the keys; the real connector then fails with an alert. |
| **A tampered installer** | The installer and every update are signed by the release key (first row), and the prompt also carries the installer's SHA-256, which the agent checks before running it. | A tampered prompt (hash and fingerprint replaced) defeats the hash check, not the signature; the prompt should come from the console to the user directly. |
| **A request that asks for too much** | Fixed schema with bounds; at most 12 agents by default (Settings); no wildcards; folders are a proposal. The operator sets each ceiling from a template. Warnings for broad writes. Nothing is created before approval, and no access exists before pickup. | An operator can approve too much; the computed access summary is there to prevent it. |
| **Request text as prompt injection to the operator** | All request text is L2, rendered inert, labelled with its source, under the computed summary. Nothing flows into a playbook, directive or rule without the operator approving it. The console never passes request text to a model. | The operator reads persuasive text written by a model. The computed access summary is the defence. |
| **Request text as injection to the team** | Goal and jobs become L0 only after approval, editable in place. A goal that reads like rules is flagged (`goal_has_rules`). | As for any operator-written goal. |
| **A source reference as a fetch instruction** | `source.ref` and `manuscript` are text for the team, shown inert. The hub never fetches them, and they grant no folder, repo or network access: the team reads a source only with access the operator granted separately. | A team may follow a link it was given; its own access rules apply. |
| **Proposed requirements as injection to the plan** | Requirements in a request are L2 text: shown inert and editable at approval, then filed as one Blueprint proposal of `draft` items that the operator applies or rejects; never applied by the approval itself. Bounds on count and length; the key scan covers them. | The operator may apply a proposal without reading every item; drafts stay editable, and agreeing them is a separate step. |
| **Proposed rules as injection to the team** | A rule in a request is L2 text and never reaches an agent by itself: it becomes a directive (L0) only if the operator ticks it at approval (every rule starts unticked), after reading it inert, labelled as written by the agent, with its source, and editable in place. Bounds on count and length; the inbound key scan covers the rules too; every created directive carries the tag `onboarding` and is audited. | The operator may tick a persuasive rule without reading it closely; it can be edited or retired in Work → Directives like any other. |
| **A rotated key on its way to the PC** | A key whose PC runs the connector gets no prompt and no pickup code: it reaches the PC by [key handover](#key-handover-a-rotated-key-or-a-recruit-reaches-a-connector-pc), picked up only with that PC's app key after the PC user's click, and the old key is revoked only at confirm. A key with no connector PC is shown raw, once, in the console, with the warning not to paste it into a chat. After a possible leak the PC's connector app key is replaced too and the suspected key is held at once. | A raw key shown once and then leaked works until it is revoked or rotated as a possible leak (bind it to a PC to narrow it). Whoever holds the PC's current app key and can click on its screen can take a handover. |
| **Secrets reaching the model** | Pairing and pickup are done by the connector, which prints no key; the prompt carries none. The one secret the model handles is the pairing code, which it passes to the installer on standard input (row above). | At the standard isolation level a shell-capable model running as the same user can read the connector's key file ([threat model](threat-model.md)); the hardened level keeps the keys in a separate key service. |
| **Trusting the hub certificate** | The connector pins the hub's CA for the hub alone, after checking the fingerprint from the prompt; nothing is added to the operating system's store. | Whoever gets the hub's CA key can impersonate the hub to the connector. |
| **Keys with no expiry** (the PC key and onboarded session keys) | Revocation in Keys; a leak rotation, which replaces the connector's app key too; and Re-enrol PC, which revokes the PC's app keys and any unused code at once and replaces its session keys (by handover); PC binding by default; alerts on misuse. | A leaked key works until the operator revokes it. |
| **Flooding** | Per-key and per-address rate limits; one pending request per key; size bounds. | |

## The older setup (deprecated)

Before the connector, a PC joined with the setup script (`setup.mjs`, enrolling with `/onboard/enrol`), its agents signed in through the headers helper with a `keys.env` file, and the stand-alone bridge (`setup_pc`, `setup_status` and a bridge key) and the Codex wake ran beside them. This path is deprecated: it is kept only for PCs not yet on a connector, and a later release removes it. In 0.9.7 a PC already on it keeps working, with one exception: rotated keys and recruits reach a PC only through the connector's [key handover](#key-handover-a-rotated-key-or-a-recruit-reaches-a-connector-pc). A new PC cannot be set up this way, because the hub no longer serves the setup script. The console and this page describe only the connector.

## Moving existing PCs to the connector

A PC still on the older setup moves to the connector. The operator chooses **Re-enrol PC** on the PC's page, which gives the hub's prompt and a new code and revokes the PC's old app keys; the PC's user pastes the prompt into their agent, which installs and pairs the connector. A freshly paired connector holds none of the old session keys, so the hub revokes them and reopens the PC's collected requests for a fresh pickup with the new app key. The same agents, teams and history stay on the hub. The old pieces left on the PC are not used by the connector. A PC whose old folders and keys are still on disk can instead be moved in place with `conclave migrate`, which also removes those pieces; see [connector.md](connector.md#moving-an-old-pc-conclave-migrate).
