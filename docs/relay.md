# Relay

A relay lets PCs in a network that cannot reach the hub use it anyway. It is one Caddy container on a machine in that network. PCs point at the relay's IP exactly as they point at a LAN hub, and the relay passes every request on to the hub. The package is [`deploy/relay/`](../deploy/relay/): [`relay.Caddyfile`](../deploy/relay/relay.Caddyfile), a [compose file](../deploy/relay/docker-compose.yml) and an [example env](../deploy/relay/.env.example).

```
PC (connector, MCP client or browser) --HTTPS by IP, relay's own CA--> relay (Caddy) --HTTPS, hub's public certificate--> hub
```

- **No new program and no state.** The relay has no database and keeps no files but its own certificate authority. It forwards only to the one hub named in its env file.
- **Its own certificate.** It serves HTTPS by IP with `tls internal`, as the hub's [lan mode](getting-started.md) does. A PC set up through the relay pins the relay's CA, which the relay serves at `/onboard/ca.crt`.
- **The hub's certificate is checked.** The relay connects to the hub over HTTPS and checks its public certificate against the hub's name.
- **The hub knows it is a relay.** Each relay has a secret, which the hub makes when the relay is registered. The relay sends it with every request, together with the PC's address, so the hub counts logins, lockouts and audit entries against the PC and not against the relay. The hub side (registration, the secret check, pairing and prompts through a relay) is in [Relays (hub side)](connector.md#relays-hub-side).

## Who may run a relay

**Only a machine you trust as much as the hub itself.** The relay ends the PCs' TLS, so it sees app keys, session tokens, pairing codes and file contents in memory while it passes them on. That is the same trust a LAN hub gets today. It also holds the relay secret, which lets it tell the hub which address a request came from.

If a relay would have to run somewhere less trusted, do not use this package. Use **option A** instead: a pass-through relay (TCP, no TLS ending) plus a hosts-file line on each PC that maps the hub's name to the relay. The PC then talks TLS to the hub itself, and the relay never sees anything.

## What the relay changes on a request

Every request to the HTTPS port goes to the hub unchanged except for these headers.

| Header | What the relay does |
|---|---|
| `X-Conclave-Relay-Client` | **Set** to the PC's address as the relay saw it: one IPv4 or IPv6 address, no port. Any copy the PC sent is replaced. |
| `X-Conclave-Relay-Secret` | **Set** to the relay's secret from its env file. Any copy the PC sent is replaced. |
| `Host` | **Set** to the hub's name, so routes, the origin check and the certificate match. |
| `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto` | **Removed.** The hub takes a client address only from the relay header, and only with a valid secret. |

Everything else **passes unchanged**: `Authorization`, cookies, the session header (`X-Agent-Hub-Session`), the enrolment code header of the [older setup](onboarding.md#the-older-setup-deprecated), `Origin`, `Content-Type`, the request body and the response. The hub reads the relay header only when the secret matches a registered relay; it compares the secret in constant time. A request that reaches the hub with a missing or wrong secret is treated as a direct request, from the address it came from.

The secret's shape is `ah_rly_<id>_<secret>` (lower-case letters and digits 2 to 7). The hub's leak guard knows the shape, and the hub's log redaction removes the header, so the secret never lands in a transcript, a share or a log.

On plain HTTP the relay serves only its own `/onboard/ca.crt`. A new PC fetches it before it trusts the relay's CA, and checks it against the fingerprint the operator gave it. Everything else on plain HTTP is redirected to HTTPS; MCP, the connector and transfers are never carried in clear text through a relay. The one exception is OAuth discovery (`/.well-known/*`) and the OAuth paths (`/authorize`, `/register`, `/token`, `/revoke`): on plain HTTP the relay answers them with 404 itself, as the LAN hub does, so an MCP client shows the real 401 instead of a redirect error. On HTTPS they go to the hub like everything else, and the hub answers them.

## Long connections and sizes

- **Nothing is buffered.** Responses are flushed as they arrive (`flush_interval -1`) and request bodies are streamed, so the push stream, long polls and bridge transfers behave as they do on a direct connection.
- **Timeouts sit above the hub's own.** The relay waits up to 60 seconds for the hub's response headers (a long poll answers within 25 seconds) and up to 90 seconds between reads (the push stream sends a heartbeat every 20 seconds and a PC treats 65 seconds of silence as a drop). There is no write timeout. A request body must arrive within 5 minutes (`read_body`), which stops a client that trickles an upload; it does not end the push stream, which has no body. The test holds the stream open for 6 minutes, and a PC reconnects by itself whenever a stream does end.
- **The body limit is the hub's.** The largest body any hub route takes is a vault write: 2 MiB of content plus 64 KiB, 2,162,688 bytes. The relay refuses anything larger with 413. Bridge transfers send 1 MiB chunks, well under it.

## Logs

The relay logs one line per request: time, method, path, status, size and duration. An explicit filter deletes the request headers, the response headers and the query string, on the access log and on Caddy's own error log alike. No hub route carries a key or token in a query string, and the filter removes the query anyway. Bodies are never logged. Logs go to the container's output, capped at three files of 10 MB.

## Updates through the relay

A PC behind a relay gets its connector updates through the hub: the hub serves the signed release bundles, and a setup prompt made "through relay X" points `release_base` at the relay (`https://<relay>/connector/v1/release`). The hub serves the files at `/connector/v1/release/<tag>/<file>` when `CONNECTOR_RELEASE_DIR` is set on it. The relay forwards that path like any other. The connector checks each bundle's signature exactly as it does on a direct connection.

## Setting up a relay

1. **On the relay machine,** copy `deploy/relay/` there, then in that folder:
   ```bash
   cp .env.example .env
   ```
   Fill in `RELAY_HOST` (the IP the PCs use) and `HUB_NAME` (the hub's public name). Leave `RELAY_SECRET` empty for now.
2. **Start it once,** which makes the relay's certificate authority:
   ```bash
   docker compose up -d
   ```
3. **Read the relay's CA fingerprint:**
   ```bash
   docker compose exec relay cat /data/caddy/pki/authorities/local/root.crt | openssl x509 -noout -fingerprint -sha256
   ```
4. **Register the relay on the hub.** In the console, open **Security → Relays** and add the relay with a name, its address (`https://<ip>:<port>`) and the fingerprint from step 3. Copy the secret the hub shows: it is shown once.
5. **Give the relay its secret.** Paste it as `RELAY_SECRET` in `.env`, and nowhere else: never into a prompt, a message or a shared file. Then start the relay again so it reads it:
   ```bash
   docker compose up -d
   ```
   Until this step the hub treats the relay's requests as direct ones from the relay's address, so don't set up PCs before it.
6. **Set up PCs through it.** When you make a setup or key-rotation prompt in the console, pick "through relay X". The prompt then carries the relay's address and CA fingerprint, so the PC pairs with the relay's CA pinned. A PC moved between direct and relay gets the usual "origin changed" confirmation.
7. **Check it.** The relay's row in **Relays** shows when it was last seen. `docker compose logs relay` shows the request lines.

Keep the `relay_data` volume: it holds the relay's CA. A new CA means every PC behind the relay must be set up again. **Guard it like the secret:** it also holds the CA's private key, and whoever has that key can pose as the relay to every PC that pinned it.

**Rotate** the secret in the console if it may have leaked, then put the new one in `.env` and run `docker compose up -d` again. Until then the hub treats the relay's requests as direct ones from the relay's address. **Remove** the relay in the console to stop the hub trusting it at once.

## Testing

`CI_HOST=<test server> bash deploy/relay/e2e/run-on-5.sh [hub worktree]` runs the relay end to end on .5 in about eight minutes. It sends only tracked files, so commit or stage a change first. It starts a throwaway hub with temporary data, a Caddy front for it with its own CA under the name `hub.test` (the only test-only change: the relay trusts that CA instead of the public roots), and the real `relay.Caddyfile`. They run on a private Docker network with no published ports, so the live and demo hubs and host ports 8080 and 8443 are never touched. It follows the setup steps above: first start without a secret, then registration with the relay's fingerprint, then a restart with the secret. It checks:

- the relay serves its own CA, and before it has a secret the hub treats it as a direct client;
- with the secret, the hub answers the relay's origin and records the PC's address as last seen; forged relay and forwarded headers from the PC change nothing;
- a wrong login counts the PC's address, not the relay's or the hub front's;
- a PC set up "through relay" pairs with the relay's origin and CA pinned, and its app key works;
- MCP `initialize` and `tools/list` with that key;
- a release file under `/connector/v1/release/`;
- a 2 MiB vault upload, the hub's limit, goes through, and the hub refuses one byte more;
- the push stream tells a new order at once, stays open for 6 minutes with a heartbeat every 20 seconds (`STREAM_HOLD_S` changes this), ends when the relay is restarted, and opens again through the new relay;
- the relay's log holds none of the test's secrets (session cookie, CSRF token, relay secret, pairing code, app key) and no headers or query strings.
