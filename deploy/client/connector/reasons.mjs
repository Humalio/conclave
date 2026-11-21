/**
 * The fixed reasons the connector gives when a folder cannot sign in, and what to run. They are fixed sentences: no hub
 * text, no key and no path is ever put into them, so the line is safe to show in a session and in the console.
 * `conclave mcp` puts the line in the session even when MCP never initializes with the hub, and `conclave check`
 * reports the first reason that applies, in ORDER.
 */
export const REASONS = {
  keyfile_unreadable: { why: "This PC's Conclave key file cannot be read.", run: 'conclave check' },
  keystore_unavailable: { why: "This PC's key store did not open the Conclave key file (its secret is gone or the platform store is locked).", run: 'conclave check' },
  broker_unverified: { why: "Something answered at the connector's local address but could not prove it is this PC's connector, so this session did not trust it.", run: 'conclave service status' },
  connector_not_running: { why: "The Conclave connector is not running on this PC, so this session cannot get its turn token.", run: 'conclave service status' },
  needs_click: { why: "This is the first Conclave chat in this folder: the PC's user has to allow it once on the connector's screen.", run: 'conclave setup' },
  denied: { why: 'This chat was not allowed on this PC. If you opened it, ask the PC user to allow it on the connector screen.', run: null },
  vault_unavailable: { why: "The Conclave key service of this PC (hardened isolation) is not running or cannot be reached.", run: 'conclave check' },
  keyfile_unsafe: { why: "This PC's Conclave key file can be read by other users.", run: 'conclave check' },
  not_registered: { why: "This folder isn't registered with Conclave on this PC (it may be a copy or a clone).", run: 'conclave check' },
  identity_changed: { why: 'This folder was replaced or copied since it was registered, so it gets no identity.', run: 'conclave check' },
  no_hub_key: { why: 'This folder belongs to a hub that this PC has no key for.', run: 'conclave check' },
  ca_changed: { why: "The hub's certificate authority is not the one this PC paired with.", run: 'conclave check' },
  ca_bundle: { why: "This PC's pinned hub certificate holds more than one certificate, so the connector will not use it. Pair with the hub again.", run: 'conclave check' },
  key_missing: { why: "This PC's key file has no key for this agent.", run: 'conclave check' },
  not_https: { why: "This hub's address is not a pinned https address, so the connector will not use it.", run: 'conclave check' },
  tls_refused: { why: "The hub's certificate does not match what this PC pinned.", run: 'conclave check' },
  hub_unreachable: { why: 'The hub could not be reached.', run: 'conclave check --probe' },
  login_refused: { why: "The hub refused this agent's key (revoked, rotated, or issued by another hub).", run: 'conclave check --probe' },
  entry_stale: { why: "This folder's Conclave entry points to a Node or connector file that has moved.", run: 'conclave repair' },
  trust_withdrawn: { why: 'Folder trust for this agent was turned off.', run: 'conclave repair' },
  old_layout: { why: 'This folder still uses the old Conclave setup (the headers helper or the Codex bridge); `conclave migrate` moves it to the connector.', run: 'conclave migrate' },
  folder_changed: { why: 'This folder gained or changed agent settings since it was registered.', run: 'conclave repair' },
  role_file_missing: { why: "This Codex folder's role file (AGENTS.override.md) is missing, so the agent does not get the hub's playbook.", run: 'conclave repair' },
  codex_tools_broken: { why: "Codex on this PC cannot run any tool: its code-mode host program is missing, so every tool call fails. Reinstall Codex, then check again.", run: "conclave check" },
  role_file_edited: { why: "This Codex folder's role file (AGENTS.override.md) was changed since the connector wrote it.", run: 'conclave repair' },
  role_file_unmarked: { why: "This Codex folder's AGENTS.override.md was not written by the connector, so the agent reads it instead of the hub's playbook. Move it away first (for an old one from codex.mjs, run conclave migrate).", run: 'conclave repair' },
};

/** The order in which `conclave check` looks, so it always names one reason. */
export const ORDER = ['old_layout', 'keyfile_unreadable', 'keystore_unavailable', 'vault_unavailable', 'keyfile_unsafe', 'not_registered', 'identity_changed', 'no_hub_key', 'ca_bundle', 'ca_changed', 'key_missing', 'not_https', 'entry_stale', 'trust_withdrawn', 'folder_changed', 'role_file_unmarked', 'role_file_missing', 'role_file_edited', 'codex_tools_broken', 'tls_refused', 'hub_unreachable', 'login_refused'];

/** "Why. Run: what" for a reason code, in the fixed words. The commands act on the working folder, so no path is named. */
export function line(code) {
  const r = REASONS[code];
  if (!r) return 'Conclave could not sign this folder in. Run: conclave check';
  return r.run ? `${r.why} Run: ${r.run} (in this folder)` : r.why;
}
