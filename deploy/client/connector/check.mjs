/**
 * `conclave check`: a local, read-only report that names ONE fixed reason (docs/connector.md).
 *
 * It reads the key file, the registry, the folder's own entry and ~/.claude.json, and changes nothing. It looks in the
 * fixed ORDER of reasons.mjs and stops at the first problem, so the answer is always one line. With `probe` it also
 * asks the hub once whether the agent can sign in, WITHOUT caching a token or changing anything; that is the only
 * network step, and it only runs when asked.
 */
import { join } from 'node:path';
import { resolveContext } from './context.mjs';
import { entryState } from './entries.mjs';
import { nodePath, connectorPath, isApproved } from './entries.mjs';
import { trustStatus } from './trust.mjs';
import { askBroker } from './brokerclient.mjs';
import { line } from './reasons.mjs';
import { hasLegacyEntry, leftoversOffer } from './migrate.mjs';
import { canonicalFolder } from './paths.mjs';
import { roleFileProblem } from './role.mjs';
import { storeName, STORE_LINES } from './keystore.mjs';
import { isHardened } from './isolation.mjs';
import { folderApproved } from './approvals.mjs';
import { codexToolsState } from './codextools.mjs';

/** `{ok, reason, line, steps}`: `steps` lists each check and whether it passed, in the order run. */
export async function runCheck(home, folderArg, { claudeJson, node, connector, probe = false, win, codex = {} } = {}) {
  const steps = [];
  const stop = (reason) => { steps.push({ step: reason, ok: false }); return { ok: false, reason, line: line(reason), steps }; };
  const cf = canonicalFolder(folderArg); if (cf && hasLegacyEntry(cf)) return stop('old_layout');
  const ctx = resolveContext(home, folderArg);
  if (!ctx.ok) return stop(ctx.reason);
  steps.push({ step: 'registered, hub key and agent key found, hub pinned over https', ok: true });
  const st = storeName(home);
  steps.push({ step: isHardened(home) ? 'Hardened isolation: the keys are held by the Conclave key service under its own account; this PC user cannot read one. Sessions get a turn token, never a key.' : `Standard isolation: ${st ? STORE_LINES[st] : 'the key file has no secret yet.'} Sessions get a turn token, never a key.`, ok: true });
  steps.push({ step: folderApproved(home, ctx.folder, ctx.binding) ? 'the PC user has allowed a chat in this folder to work as its agent' : 'a chat opened here will wait once for your click on the connector screen (conclave setup)', ok: true });
  const want = { node: nodePath(node), connector: connectorPath(home, connector), folder: ctx.folder };
  const es = entryState(ctx.folder, want);
  if (es === 'stale' || es === 'missing') return stop('entry_stale');
  steps.push({ step: es === 'foreign' ? 'the folder has its own entry named conclave (left alone)' : 'the folder entry names this Node and this connector by absolute path', ok: true });
  steps.push({ step: isApproved(ctx.folder) ? 'the folder settings approve the server' : 'the folder settings do not approve the server yet (the client will ask once)', ok: true });
  const t = trustStatus(claudeJson, ctx.folder, ctx.binding, { win });
  if (t.action === 'ask' && ['trust_withdrawn', 'folder_changed', 'identity_changed'].includes(t.reason)) return stop(t.reason === 'identity_changed' ? 'identity_changed' : t.reason);
  steps.push({ step: t.action === 'none' ? 'folder trust is set' : 'folder trust entry is missing and repair can restore it', ok: true });
  if (ctx.binding.provider === 'codex') {
    const role = roleFileProblem(home, ctx.folder);
    if (role) return stop(role);
    steps.push({ step: 'the Codex role file (AGENTS.override.md) is the one the connector wrote', ok: true });
    const cx = codexToolsState({ folder: ctx.folder, ...codex });
    if (cx.state === 'broken') return stop('codex_tools_broken');
    steps.push({ step: cx.step, ok: true });
  }
  if (probe) {
    // The connector's broker makes the one call (a turn token, revoked at once): no other process signs in with a key.
    const r = await askBroker(home, { op: 'probe', folder: ctx.folder }, { timeoutMs: 15_000 });
    if (!r.ok) return stop(typeof r.reason === 'string' ? r.reason : 'connector_not_running');
    steps.push({ step: 'the hub accepted this agent (nothing kept)', ok: true });
  }
  // Old setup left on the PC: offered in plain words, never run, and never a reason to fail the check.
  const offer = leftoversOffer(home);
  if (offer) steps.push({ step: offer, ok: true, offer: 'migrate --finish --remove-legacy-ca' });
  return { ok: true, reason: null, line: 'Conclave is set up for this folder.', steps };
}
