-- Which kinds of the old setup a PC still holds (docs/connector.md, "Old setup left on the PC"): a JSON list of fixed words
-- (unfinished_move, ca_setting, old_keys, bridge_pieces) from the connector's check-in, never a path; NULL until reported.
ALTER TABLE connector_reports ADD COLUMN legacy_leftover_kinds TEXT;
