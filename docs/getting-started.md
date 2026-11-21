# Getting started

Try the sample investigation on your computer, or deploy your own hub and connect a team.

## Try the Early Echo demo

The demo is a fictional investigation with a shared vault and a team already at work. You can open a task, inspect the team's evidence, and answer a question that changes what happens next.

1. Install Node.js 24 or later and download or clone this repository. Open a terminal in the repository folder and run:

   ```text
   cd server
   npm ci
   ```

2. Enable the **Replay** controls and start a local demo hub. Leave this terminal running.

   **macOS and Linux**

   ```bash
   DEMO_MODE=1 npm run dev:hub
   ```

   **Windows PowerShell**

   ```powershell
   $env:DEMO_MODE = '1'
   npm run dev:hub
   ```

3. Open <http://127.0.0.1:8099/>. The terminal shows where to find the generated sign-in details in the checkout's `.dev/hub.env` file.
4. Open **Explore the case** and choose **Replay through Act 3** to investigate the first clues. To reach the team handoff, use **Replay** and let the story run through Act 5.

The demo uses a disposable copy of the [Early Echo vault](../eval/vault/). Replaying replaces the demo's data. See the [showcase guide](showcase.md#demo-mode) for the replay controls and the [case board](../eval/vault/Case%20Command/Case%20board.md) to read the notes without starting the hub.

## Container deployment

On a Linux host, WSL or macOS with Docker, run from the repository root:

```bash
deploy/setup.sh
```

It asks for a vault and how the hub is reached, writes `.env` with a random `KEY_PEPPER` and admin password, builds and starts the containers, waits for `/health`, and prints the console address and login. `.env` is readable only by you and `./data` only by its owner. The admin password is shown once: the hub needs it only to create the first admin, so the script then removes it from `.env` and recreates the container without it. Flags skip the questions:

| Mode | Command | Console | MCP endpoint |
|---|---|---|---|
| This machine only | `deploy/setup.sh --vault ~/Notes --mode local` | `http://localhost:8080` | `http://localhost:8080/mcp` |
| Your network | `deploy/setup.sh --vault ~/Notes --mode lan --host hub.example.internal` | `https://hub.example.internal:8443` | `https://hub.example.internal:8443/mcp` (recommended), or `http://hub.example.internal:8080/mcp` (unencrypted) |
| Public domain | `deploy/setup.sh --vault /srv/notes --mode domain --host hub.example.com --email you@example.com` | `https://hub.example.com` | `https://hub.example.com/mcp` |

- **Vault.** Point `--vault` at any folder; an Obsidian vault works as is. Use `--demo` to start with a copy of the [Early Echo vault](showcase.md) in `./vault`. The container runs as your user so it can write the vault and `./data`.
- **lan.** Caddy serves everything over HTTPS on port 8443 with its own certificate authority: the console, `/mcp` and `/bridge/*`. Use HTTPS for agents and bridges once each client trusts the root certificate (see [below](#trusting-the-lan-certificate)). Plain HTTP on port 8080 carries only `/mcp`, `/bridge/*` and `/health`, so clients that do not trust the certificate yet keep working. It answers OAuth discovery and endpoint paths with 404 (the hub has no OAuth, so a client that falls back to OAuth after a `401` gets a plain refusal instead of a redirect) and redirects everything else to HTTPS. **On plain HTTP, app keys, session tokens, session keys at login, pairing codes and file contents cross the network unencrypted.** Use it only on a network you trust, and move clients to HTTPS. The address must be the one clients type: the certificate is issued for it.
- **domain.** The DNS name must point at the host and ports 80 and 443 must be reachable from the internet; Caddy obtains and renews a Let's Encrypt certificate.
- **local.** The hub listens on `127.0.0.1` only. The admin session cookie is HTTPS-only outside localhost, so use `lan` or `domain` for any other address rather than publishing plain HTTP.

The script refuses to replace an existing `.env`; use `--force` to start over. After that, manage the service with `docker compose up -d --build`, `docker compose logs -f` and `docker compose down`. To configure by hand instead, copy [`.env.example`](../.env.example) to `.env`; HTTPS is enabled by its `COMPOSE_FILE` and `HTTPS_*` lines. Remove `ADMIN_PASSWORD` once you can sign in.

To clear a deployed hub without touching the host, use **Lockdown → Danger zone → Reset hub data** in the console. Pick parts (activity logs, conversations, teams and tasks, agents and keys, PCs and bridges, shares and transfers, vault history and index, agent feedback, lockdown switches) or everything. The preview counts what will go, including records in other parts that depend on your choice. You confirm by typing `RESET` and your password, plus your two-factor code if enrolled. The audit trail, admin accounts, permission templates and the notes on disk are always kept, and each reset is recorded in the audit trail. In production the service restarts itself afterwards and the page reloads. For a completely blank hub, audit trail included, stop the service and delete `./data`.

Check `/health` and confirm that an MCP request without an app credential is rejected. Keep the database and blobs in `./data`, the vault, and `KEY_PEPPER` backed up: changing the pepper invalidates every key. Use a consistent snapshot or stop the service for a coordinated backup. The backup taken before every deploy holds all four: the database, the blobs, the vault folder (it lives outside `./data`, in `VAULT_HOST_DIR`) and `.env`, each with its checksum; a deploy stops if the vault folder is missing. At startup the hub refuses to run if an applied migration's text changed; line endings do not count, so a deploy packed from a Windows (CRLF) checkout or with `git archive` (LF) starts either way, and `.gitattributes` keeps `*.sql` files LF. See [config.ts](../server/src/config.ts) for all server settings.

The hub also writes read-only Markdown copies of its records (checkouts, teams, sessions, reviews, decisions) into the vault folder `99 Conclave/`, so you can read them in Obsidian. Agents cannot write there. Turn it off in **Settings → Vault → Hub folder**; see [vault](vault.md#the-hubs-folder-99-conclave).

After signing in to your own hub, follow [Connect a computer and start a team](onboarding.md#with-the-conclave-connector). Connector pairing needs an HTTPS address configured as `PUBLIC_URL` and a hub CA certificate configured as `CA_CERT_FILE`. Behind a proxy, set `TRUST_PROXY` to the proxy's Docker subnet in the hub `.env`, or connector pairing fails with "hub cannot be reached" (the hub answers `426` on `/connector/v1/hub`). This holds for every hub behind Caddy, not only the HTTPS compose profile. The loopback HTTP deployment above is suitable for trying the console on one machine.

### Upgrading to 1.0

1.0 folds the 56 migrations of 0.x into one generated baseline, `0100_v1_baseline.sql`; later migrations are 0101 and up. **Back up first:** an online backup of `agent-hub.db`, the blobs, `.env` and `KEY_PEPPER`. To check a copy before the upgrade, run `node scripts/v1-baseline.mjs --check <copy of agent-hub.db>` in `server/`: it prints each object that differs from the baseline.

- **A 0.x hub at migration 69** (the last 0.x version) is recognised when it starts: its recorded migrations must be exactly the 56 of 0.x, its schema must equal the baseline (every table, index and trigger, compared exactly), and `quick_check` and `foreign_key_check` must pass. The hub then records 100 as applied without running it and logs `[db] recognised a 0.x database at migration 69`. No row changes.
- **A new hub** (an empty database) runs the baseline.
- **When the hub stops instead,** it has changed nothing. The log says why:
  - "the database is at migration N of 0.x, which is too old to move to 1.0 directly …": an older hub. It must first be upgraded to the last 0.x release (migration 69), then to 1.0. That release is not in the public repository, so this path is not supported from it.
  - "the database is at migration 69 but is not the 0.x schema", then one line per difference (a missing, extra or differing object, a migration that is not one of 0.x or has another checksum, a failed `quick_check` or `foreign_key_check`): the database was changed by hand or is damaged. Restore the backup or fix the difference.
  - "the database has N table(s), index(es) or trigger(s) but no recorded migrations": not a Conclave database, or its `schema_migrations` rows are gone.
- **Rollback:** the 0.x image starts on a 1.0 database as it is, because rows 1 to 69 stay and 0.x ignores row 100. Check first that `SELECT max(version) FROM schema_migrations` is 100; once a 0101+ migration has run, restore the backup instead.
- **Removed in 1.0:** the `directive_ack` tool (a call to it answers `removed` and points to `directives_read {ack: true}`), and the one-time docs import (its route, script and console card).

### Trusting the LAN certificate

1. On the host, export the root certificate once: `docker compose exec caddy cat /data/caddy/pki/authorities/local/root.crt > agent-hub-root.crt`. Copy it to each client machine. It is public: it holds no private key.
2. Add it to the system store, for browsers and most tools:
   - Windows: `certutil -user -addstore Root agent-hub-root.crt`
   - macOS: `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain agent-hub-root.crt`
   - Linux: `sudo cp agent-hub-root.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates`
3. The Conclave connector needs none of this: it checks the hub certificate during pairing and pins it for its own connections and its agents'. A direct Node.js client may need its own certificate setting: set `NODE_EXTRA_CA_CERTS=/path/to/agent-hub-root.crt` in its environment.
4. Switch the clients to HTTPS:
   - Use `https://<host>:8443/mcp` as the MCP URL.
   - Pair stand-alone bridges of the [older setup](onboarding.md#the-older-setup-deprecated) with `https://<host>:8443`. A paired bridge keeps its address in `hub` in `~/.agent-hub/bridge.json`; edit it or pair again.
   - Set `PUBLIC_URL=https://<host>:8443` in `.env` so the console's setup snippets use HTTPS. Apply it with `docker compose up -d --force-recreate agent-hub`.

Plain HTTP is available for direct clients on a trusted network. The connector pairs and connects only over HTTPS; use HTTPS for any connection to a hub on another machine.

## Verification

In `server/`, run `npm run typecheck`, `npm run build`, and `npm test`. `npm test` also runs the connector client's tests in `deploy/client/` (`npm run test:helper`, `node --test` through `scripts/test-helper.mjs`, on Windows too). In `bridge/`, run `npm test`. Server tests exercise HTTP/MCP behavior and domain rules; bridge tests cover path confinement and transfers. Each test run (vitest and the helper tests) keeps its temp files in one folder, `conclave-test-<pid>-<time>` in the system temp folder, that `TMPDIR`, `TEMP` and `TMP` point at for the run; the run deletes it when it ends, also after a failure, and a later run deletes the folder of a killed run once it is a day old and its process is gone (`scripts/test-tmp.mjs`). A test writes only under `os.tmpdir()`. For changes to a trust boundary, include a denied case and a revocation or stale-state case as applicable. For dashboard changes, check the relevant operator questions on both desktop and mobile.

## The Early Echo story: test suite and design-review data

The [showcase](showcase.md) story in `eval/` runs a whole investigation against a hub on 127.0.0.1: 29 agents on four simulated PCs, eight teams, an outside lab that joins through onboarding, and the Early Echo vault (`eval/vault/`). Every step asserts its result, and a coverage gate fails the run if any MCP tool, scriptable admin-API area or scriptable acceptance row is missed. `npm test` runs the whole story.

```bash
cd server
npm run story                                  # throwaway hub, Acts 0–5, coverage report in eval/out/
npm run story -- --until 3 --keep              # stop after Act 3 and keep the hub for the console
npm run story -- --from 3 --until 3 --pace 1x --act-pause 2   # replay Act 3 at watchable speed
```

`--pace` takes a factor (`0.5x`, `1x`, `2x`); each step holds its on-screen beat divided by the factor, and pacing never changes an outcome. `--scale` adds an optional act with volume (three more projects, 30 agents, 11 teams in every status, 115 directives, more feedback). The report (`coverage.json`, `coverage.md`, `outcomes.log`) goes to `eval/out/<run>/`. The runner is also a module: `runStory({ hub, from, until, pace, onProgress, signal })` in `eval/run.mjs`.

## Demo hub

A demonstrator hub can replay the story from its console. Add `DEMO_MODE=1` and `DEMO_ALLOW_PRODUCTION=1` (the Docker image runs as production, which otherwise refuses demo mode) to its `.env` (with `ADMIN_USERNAME` and `ADMIN_PASSWORD`, which the story signs in with) and an empty `VAULT_DIR` of its own: every replay replaces the hub's data and the files in it, so a replay refuses a folder that has files but no `.conclave-demo` marker (the first replay writes it). Don't enrol two-factor on that admin account: the story signs in without a code. Never point a demo hub at another hub's data or vault. A bar above every page then has **Replay** (speed, start and stop acts) and, while it runs, the act and step and **Stop**. Never set it on a hub with real data. See [Demo mode](showcase.md#demo-mode). Locally: `DEMO_MODE=1 npm run dev:hub`.

## Local design review hub

To review the console with sample data, run a local hub and populate it from the story. It listens only on `127.0.0.1` and keeps its data and copied vault under `.dev/`. The `--reset` flag clears that directory before starting. Run `npm ci` in `server/` first if you have a fresh checkout.

```bash
cd server
npm run dev:hub -- --reset   # start a fresh hub (leave it running)
npm run dev:seed             # in a second terminal: run the story against it (eval/run.mjs --hub)
```

Open <http://127.0.0.1:8099/>. To run a second hub next to it (for example from another worktree), set `HUB_PORT` for both commands: `HUB_PORT=8100 npm run dev:hub` in bash, `$env:HUB_PORT=8100; npm run dev:hub` in PowerShell; each checkout keeps its own `.dev/`. The admin sign-in (username and generated password) and the pepper are in `.dev/hub.env`. The seed never prints the collaborators' generated passwords: it writes them to `.dev/members.env` beside it (owner-only, one `username=password` line each) and prints only where. A script that signs in as a member reads that file (`readLogins` in `eval/run.mjs`), never the terminal. The story needs a fresh hub: on a seeded one it stops at step 0.2 and says so; restart with `npm run dev:hub -- --reset` and seed again. Against the dev hub the restart steps (4.13b–c) are skipped, because the runner does not control that process. Add `-- --scale` for volume, or `-- --until <act>` to review the console at an earlier act.

The hub limits its public routes (no key, session or cookie: the console pages, onboarding downloads, pairing, an unauthenticated `/mcp`) to 300 requests a minute per address and answers `429` with `Retry-After` beyond that; `/health` and requests with a credential are not counted, and the connector release downloads have a separate bucket 20 times larger (one update is about 85 files). The limit counts the real client address only from a proxy that `TRUST_PROXY` trusts (default: loopback; `false` trusts none); from any other connection, and with `TRUST_PROXY=false`, it counts the connection's own address, which behind a proxy is the proxy. Set `PUBLIC_REQUESTS_PER_MINUTE` to change the limit (`0` turns it off).
