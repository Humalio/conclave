-- "Paired just now" (docs/onboarding.md#paired-just-now): one row per redeemed pairing code, with the source address and the
-- connector's version and platform as it reported them. A new row is a Needs you item until the operator keeps it or revokes
-- it; Revoke revokes the PC's app key, cancels its open requests and pickups, and revokes the agent keys picked up with it.
CREATE TABLE connector_pairings (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL,
  app_credential_id TEXT NOT NULL,
  code_id TEXT NOT NULL,
  paired_at INTEGER NOT NULL,
  source TEXT,
  version TEXT,
  platform TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'kept', 'revoked')),
  decided_at INTEGER,
  decided_by TEXT
);
CREATE INDEX connector_pairings_status ON connector_pairings(status);
CREATE INDEX connector_pairings_machine ON connector_pairings(machine_id);
