# Operations: database health

The hub keeps its state in one SQLite file. **Security → Database** in the console (admin only) shows how healthy and how large that file is, runs the clean-up rules that keep it from only growing, and checks and compacts it. Every removal takes a backup first, is previewed with the same rows it will remove, and is recorded.

## Health at a glance

The page opens with one line, for example "Healthy · 74 MB · 72,779 records · last backup 2 h ago · last check OK", and then the details:

- the size of the database file (with its write-ahead log) and of the vault's stored blobs;
- the newest backup in the backups folder (`BACKUP_DIR`, by default `data/backups`), whoever wrote it: a deploy, a clean-up run or a Reset;
- the last integrity check and its result;
- the records per area (the same areas as Reset, plus the audit trail), with their growth over the last 7 and 30 days. The hub counts every table once a day and keeps those counts 400 days.

The line turns to a warning when the last check failed, or when the records grew more than 25% in 7 days (`db_health.growth_warn_pct`).

## Clean-up rules

Each rule has an on/off switch and an age in days, and a **Preview**. New rules are **off** until the operator switches them on; a rule that is on runs each night, after the nightly check. That includes the Audit trail rule: once it is on, each night it archives and removes the rows that have passed its age. Suspended keys is the exception: it has no switch and never runs by itself; only an operator runs it, from its preview.

| Rule | Removes | Never removes | Days (default, lowest) |
|---|---|---|---|
| Audit trail | audit rows older than N days, after archiving them (below) | the `audit.trimmed` records; anything younger than 365 days | 365, 365 |
| Activity log | sign-in events, tool calls, file access events, and alerts that are no longer open | open alerts | 180, 30 |
| Revoked keys | keys revoked more than N days ago, with their logins, read positions and key rules | a key with anything it wrote (a message, a team seat, a request, a grant), a pending handover or pickup, a checkout successor, or an open alert. A tombstone always stays (below) | 90, 30 |
| Suspended keys (by hand only) | nothing directly: the operator **revokes** the keys suspended longer than N days. The preview names each key, its agent and when it was suspended, and each revoke is recorded as that operator's own `key.revoke`. Revoked keys then follow the Revoked keys rule | a key moved by a checkout, with a pending handover, or with an open alert | 180, 30 |
| Finished items | onboarding requests decided (collected, denied, withdrawn or cancelled), ended checkouts with their handouts, used or expired enrolment codes, setup and pairing codes, and key pickups and collections | anything still open | 90, 30 |
| Stale PCs and agents | retired PCs with no keys, no agents and no open orders; archived agents in no team that never wrote anything | an agent with any record it wrote: messages, tasks, decisions, file revisions, feedback, blueprint events and the rest. Such an agent stays as a named record | 180, 90 |

The rules the hub always ran are shown as **built in**: closed shares (90 days), finished file transfer channels (90), acknowledged work items (30) and daily connector usage (400). Their days can be raised, never lowered below these values; so can the housekeeping the hub does on its own (dead logins after 30 days, except each agent's newest; notices after 90, except each agent's newest; history of finished tasks after 180). A lower value in a setting is read as the floor.

Never touched by any rule, in code and not only on the page: vault files and their history, projects, teams and their members, active keys, directives, the blueprint, tasks, and the record of the rules' own runs.

### Preview, then run

**Preview** lists how many records each table would lose, the date range, and what stays, and changes nothing. It follows the database's own foreign keys the way Reset does, so rows that depend on a removed row are counted too. A rule whose rows would pull in a table it may not touch is refused, not trimmed.

**Run now** asks for the admin's password, and the two-factor code when enrolled, like Reset. Then:

1. A backup: the database is copied with SQLite's online backup to the backups folder (`health-<date>-<time>.db`), and the page shows its name.
2. The rows are counted again inside the run's transaction; a difference from the preview is reported with the result.
3. The rows go in one transaction, with `PRAGMA foreign_key_check` at the end; any dangling reference rolls the whole run back.
4. The run is audited as `retention.run` (counts per table and the backup's name) and added to the run history.

A scheduled run does the same, with at most one backup a day. Runs are refused while any lockdown is active, and while another run, check or compact is in progress.

Each change to a rule (on, off, or its days) needs the same password check and is audited as `retention.rule_set`, with the values before and after.

### The audit trail

The audit trail is append-only: the database refuses to change any row and to delete any row younger than the **audit horizon**. The Audit trail rule is the only way to move the horizon, and only forward:

1. The rows older than the cut-off are written, oldest first, to `audit-<from>-<to>.jsonl.gz` in the backups folder. Each line carries the row and a hash chain: `hash = sha256(prev + row)`, where the first `prev` is the last hash of the previous archive (64 zeros for the first). Re-hashing the file proves it whole and in order, and that no archive is missing in between. The file is first written under a temporary name, flushed to disk, renamed, then read back and its sha256 checked. If any of that fails, the run stops: nothing is removed and the horizon stays where it was.
2. The hub records one `audit.trimmed` event with the date range, the count, the file's name and sha256, the chain's last hash and the new horizon.
3. Only then may the horizon move: the database accepts a new horizon only if it is later than the old one, at least 365 days ago, and named by an `audit.trimmed` event.
4. The rows older than the horizon are removed. `audit.trimmed` events are never removed.

So the last 365 days of security history are always in the hub, and everything older is in a file whose integrity can be checked.

### Keys: the tombstone

A revoked key that is used again is a sign it was stolen, and it raises the reused-key alert. When the Revoked keys rule removes a key, a tombstone stays: the key's public id and verifier, its agent or PC, and when and why it was revoked. A key presented again is checked against the tombstone and is refused as **revoked**, exactly as before, with the same alert; the leak guard still recognises it.

## Backups

Before every run the hub writes a backup. Its own backups (`health-…`) are rotated: the newest of each of the last 7 days and the newest of each of the 4 weeks before that are kept. Backups written by a deploy, by Reset or by hand are never rotated by the hub.

Removed data still exists in the backups until they age out, and in the audit archives, which are never rotated: keep that in mind for a privacy request. The backups folder is created readable only by the hub's account. The page shows the backups' count and total size.

## Maintenance

- **Check integrity.** Each night the hub runs `PRAGMA quick_check`. **Full check** runs `PRAGMA integrity_check` on request. Both are recorded in the run history, and a failed check turns the health line into a warning.
- **Compact.** `VACUUM` gives back the space freed by clean-up runs. It needs free disk space about the size of the database and blocks writes while it runs, so it is refused when free space is less than the database's size plus 10% and 64 MB, shows how long it is expected to take, asks for the password, and runs only from the page, never on the schedule. The run history shows the space it got back.

## Kept by Reset

The run history and the audit horizon are configuration and survive Reset, like the audit trail. The daily counts are part of **Activity logs**, and the key tombstones part of **Agents, keys and permissions**.

## API

All admin only (`403 admin_only` for members).

- `GET /api/db-health`: health, rules, backups, last check, and the run history.
- `GET /api/db-health/rules/:key/preview`: what a run of that rule would remove. Changes nothing.
- `PUT /api/db-health/rules/:key {enabled?, days?, password, totp?}`: change a rule (audited `retention.rule_set`).
- `POST /api/db-health/rules/:key/run {password, totp?}`: back up, then run the rule (audited `retention.run`).
- `POST /api/db-health/check {full?}`: run the quick or the full integrity check.
- `POST /api/db-health/compact {password, totp?}`: compact the database.
