-- Collaborator invites (docs/onboarding.md#an-invite-for-a-collaborator): the operator invites a collaborator to one team and
-- role. Creating the invite is the approval; it is checked again, in one transaction, when the collaborator's PC redeems it.
-- The collaborator opens the pairing code in their own console (signed in, two-factor); each opening makes a new code on the
-- invite's own PC record and voids the old one. No secret is stored here. relay_id: the relay the collaborator's PC reaches the hub
-- through (chosen and checked when the invite is made); its prompt and code carry the relay's address and CA. No foreign key:
-- removing the relay deletes its row, and the code route then refuses with a plain reason.
CREATE TABLE onboarding_invites (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  role TEXT NOT NULL,
  team_role TEXT NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES admin_users(id),
  folders TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(folders)),
  template_id TEXT,
  bound INTEGER NOT NULL DEFAULT 1 CHECK (bound IN (0,1)),
  relay_id TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','redeemed','revoked','expired')),
  machine_id TEXT REFERENCES machines(id),
  code_opened_at INTEGER,
  request_id TEXT,
  agent_id TEXT,
  redeemed_at INTEGER,
  ended_at INTEGER,
  ended_by TEXT
);
CREATE INDEX onboarding_invites_owner ON onboarding_invites(owner_user_id, status);
CREATE INDEX onboarding_invites_machine ON onboarding_invites(machine_id);
