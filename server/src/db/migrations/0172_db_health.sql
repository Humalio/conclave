-- Database health (docs/operations.md): the audit horizon, key tombstones, when a key was suspended, the run history and daily counts.

-- The audit horizon: one row. Audit rows older than it may be deleted, nothing else. It moves only forward, never to less
-- than 365 days ago, and only to a value an `audit.trimmed` event names (that event records the archive first).
CREATE TABLE audit_horizon (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  horizon    INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO audit_horizon(id, horizon, updated_at) VALUES (1, 0, 0);
CREATE TRIGGER audit_horizon_no_delete BEFORE DELETE ON audit_horizon
  BEGIN SELECT RAISE(ABORT, 'audit_horizon cannot be removed'); END;
CREATE TRIGGER audit_horizon_forward BEFORE UPDATE ON audit_horizon
  WHEN NEW.id <> OLD.id OR NEW.horizon <= OLD.horizon
    OR NEW.horizon > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) - 365 * 86400000
    OR NOT EXISTS (SELECT 1 FROM audit_events WHERE action = 'audit.trimmed' AND json_extract(details, '$.horizon') = NEW.horizon)
  BEGIN SELECT RAISE(ABORT, 'the audit horizon only moves forward, to at least 365 days ago, as an audit.trimmed event names'); END;

DROP TRIGGER audit_events_no_delete;
CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
  WHEN OLD.action = 'audit.trimmed' OR OLD.created_at >= (SELECT horizon FROM audit_horizon WHERE id = 1)
  BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;

-- A removed revoked key: enough to refuse it as revoked (and alert) if it is used again, and for the leak guard to know it.
CREATE TABLE key_tombstones (
  key_id      TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('app_key','session_key')),
  verifier    TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  agent_id    TEXT,
  machine_id  TEXT,
  label       TEXT,
  status_reason TEXT,
  revoked_at  INTEGER,
  removed_at  INTEGER NOT NULL
);

-- When a key was last suspended (the opt-in Suspended keys rule counts from it). Earlier suspensions are dated from their audit event.
ALTER TABLE credentials ADD COLUMN suspended_at INTEGER;
UPDATE credentials SET suspended_at = COALESCE(
  (SELECT MAX(a.created_at) FROM audit_events a WHERE a.action = 'key.suspend' AND a.target_kind = 'credential' AND a.target_id = credentials.id),
  CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
WHERE status = 'suspended';

-- Each clean-up run, check, compact and rule change on the Database page. Kept forever (small); Reset keeps it.
CREATE TABLE db_health_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL CHECK (kind IN ('rule','check','compact','rule_set')),
  rule        TEXT,
  trigger     TEXT NOT NULL CHECK (trigger IN ('manual','scheduled')),
  ok          INTEGER NOT NULL,
  rows        INTEGER NOT NULL DEFAULT 0,
  backup      TEXT,
  details     TEXT CHECK (details IS NULL OR json_valid(details)),
  actor_id    TEXT,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER NOT NULL
);
CREATE INDEX db_health_runs_started ON db_health_runs(started_at);

-- Rows per table, once a day, kept 400 days: the growth figures on the page.
CREATE TABLE db_health_counts (
  day        TEXT NOT NULL,
  table_name TEXT NOT NULL,
  rows       INTEGER NOT NULL,
  PRIMARY KEY (day, table_name)
);
