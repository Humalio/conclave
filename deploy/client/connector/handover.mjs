/**
 * Key handover on the PC (docs/onboarding.md#key-handover-a-rotated-key-or-a-recruit-reaches-a-connector-pc): a rotated key or
 * a recruit's new agents reach this PC through its connector, never through a chat. The hub says a handover waits (the
 * check-in's `handovers` count, or `event: handovers` on the push stream); the connector lists them with its app key, and
 * picks one up only after the PC's user allowed it on the local screen. The click covers that one handover: it is spent at
 * confirm, and dropped when the hub no longer lists the handover (cancelled, expired or skipped).
 *
 * A rotation of keys this PC holds none of is skipped at once (`key_not_held`, the hub cancels it as not_on_pc), before
 * anyone is asked to click. A Re-enrol hands every agent key of the PC over in one handover. A recruit whose folder breaks the folder rules is skipped as `folder_refused`.
 *
 * Order, so a crash anywhere leaves nothing half done: the list is saved first (no secrets) in handovers/<hub id>.json, then
 * the new keys are STAGED beside the old ones (keyfile.mjs), then a recruit's folders are built and registered, then the
 * pickup is confirmed. Only after the hub's 200 (or its "already confirmed") are the staged keys swapped in; a refusal drops
 * them and the old keys go on working. A lost answer leaves them staged and the next run confirms again (the hub's confirm
 * is idempotent per pickup). A crash before the keys are staged picks up again (the hub replaces the secrets it staged)
 * and reuses the same labels, so no agent is added twice. Nothing here prints or returns a key.
 */
import { join, dirname, basename, resolve, relative, isAbsolute } from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';
import { readJson, atomicWrite, oneLine } from './paths.mjs';
import { readKeyFile, stageAgentKey, commitStaged, discardStaged, labelHoldingKey } from './keyfile.mjs';
import { pickupApproved, requestPickup, allowOwnPickup, allowWithPickup, spendPickup, dropPickup } from './approvals.mjs';
import { isHardened } from './isolation.mjs';
import { foldersOfHub } from './registry.mjs';
import { relRefusal } from './syncpath.mjs';
import { hubCall, localLabel, buildAgent, defaultRoot, loadSetup } from './onboard.mjs';

/**
 * A definitive refusal of a confirm: a 4xx other than 401, 408 and 429 whose body carries the hub's own code (invalid_state,
 * not_found, conflict). Only this drops staged keys; anything else, also a bare 404 or 409 from a relay, is treated as no answer.
 */
const HUB_REFUSALS = new Set(['invalid_state', 'not_found', 'conflict']);
export const refused = (e) => Number.isInteger(e?.status) && e.status >= 400 && e.status < 500 && ![401, 408, 429].includes(e.status) && HUB_REFUSALS.has(e?.hub?.error);

export const handoverPath = (home, hubId) => join(home, 'handovers', `${hubId}.json`);

function load(home, hubId) {
  const s = readJson(handoverPath(home, hubId), null);
  return s && typeof s === 'object' && s.version === 1 && s.items && typeof s.items === 'object' ? s : { version: 1, hub_id: hubId, items: {} };
}
function save(home, s) { atomicWrite(handoverPath(home, s.hub_id), JSON.stringify(s, null, 2) + '\n'); }

/** Where a recruit's folders go: beside the team's other agents on this PC, else the team's root from its setup, else the default root. */
function placeOf(home, section, team, root) {
  const sib = team?.id ? foldersOfHub(home, section.hub_id, section.ca_sha256).find((b) => b.team === team.id && b.path) : null;
  if (sib) return { root: dirname(dirname(sib.path)), project: basename(dirname(sib.path)), client: sib.provider === 'codex' ? 'codex' : 'claude-code' };
  const req = loadSetup(home, section.hub_id).request;
  const own = req && req.team_id && req.team_id === team?.id && typeof req.root === 'string' ? req.root : null;
  return { root: own ?? root ?? defaultRoot(), project: team?.name ?? 'project', client: 'claude-code' };
}

/**
 * Why a recruit's folder may not be built, or null. The folder is `<root>/<project>/<folder>`: each name one plain part
 * (no `..`, no name the system reserves), the result inside the root, and no part of it that exists a link or junction.
 */
export function folderRefusal(root, project, folder, os = process.platform) {
  if (typeof root !== 'string' || !isAbsolute(root)) return 'the team root is not an absolute path';
  for (const [what, n] of [['project', project], ['folder', folder]]) {
    const r = relRefusal(String(n ?? ''), os);
    if (r) return `the ${what} name has ${r}`;
    if (String(n).includes('/')) return `the ${what} name is more than one folder`;
  }
  const dir = resolve(root, project, folder);
  const rel = relative(resolve(root), dir);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return 'the folder is outside the team root';
  // Every part below the root that already exists must be a real folder, not a link or junction.
  let at = resolve(root);
  for (const part of rel.split(/[\\/]/).filter(Boolean)) {
    at = join(at, part);
    let st;
    try { st = lstatSync(at); } catch (e) { if (e.code === 'ENOENT') break; return 'a part of the folder cannot be read'; }
    if (st.isSymbolicLink()) return 'a part of the folder is a link';
    if (!st.isDirectory()) return 'a part of the folder is a file';
    try { if (realpathSync.native(at).toLowerCase() !== at.toLowerCase() && os === 'win32') return 'a part of the folder is a link'; } catch { return 'a part of the folder cannot be read'; }
  }
  return null;
}

/**
 * Carries every handover the hub lists for this PC as far as it goes. Answers `{handovers: [{id, kind, phase, ...}]}` with
 * phase `waiting` (pickup_click: the PC's user has not allowed it yet), `confirmed`, `skipped` (reason), or `failed` (reason).
 * `deps.afterKeys` is a test hook: it runs after the keys are staged and before they are marked staged.
 */
export async function runHandovers(home, hubKey, { claudeJson, node, connector, gitBin, root, os = process.platform, deps = {} } = {}) {
  const kf = readKeyFile(home);
  if (!kf.ok || !kf.data.hubs[hubKey]) return { handovers: [] };
  const section = kf.data.hubs[hubKey];
  const list = (await hubCall(home, hubKey, 'GET', '/connector/v1/handovers')).handovers ?? [];
  const s = load(home, section.hub_id);
  const out = [];
  for (const h of list) {
    try { out.push({ id: h.id, kind: h.kind, ...(await one(h)) }); } catch (e) { out.push({ id: h.id, kind: h.kind, phase: 'failed', reason: e.reason ?? 'error', message: oneLine(e.message ?? String(e)).slice(0, 300) }); }
  }
  // A handover the hub no longer lists is over: confirmed, or cancelled, expired or skipped. Its click goes, a key still
  // staged for it is dropped (the hub never swapped it in), and its entry goes.
  const listed = new Set(list.map((h) => h.id));
  for (const [id, it] of Object.entries(s.items)) {
    if (listed.has(id)) continue;
    // Keys staged and a confirm whose answer was lost: the hub may have swapped already and stopped listing it. Confirm
    // again (the hub answers `already` for the same pickup); only a refusal drops the staged keys.
    if (!it.confirmed && it.pickup_id && it.keys_written_for === it.pickup_id) {
      try {
        await hubCall(home, hubKey, 'POST', '/onboard/pickup/confirm', { pickup_id: it.pickup_id, written: it.agents.map((a) => a.session_var), transport: 'https' });
        commitStaged(home, hubKey, id); it.confirmed = true;
        out.push({ id, kind: it.kind, phase: 'confirmed', agents: it.agents.map((a) => a.label), failed: [] });
      } catch (e) { if (!refused(e)) continue; /* no answer, or one that settles nothing: the next run tries again */ }
    }
    if (!it.confirmed) { try { discardStaged(home, hubKey, id); } catch { /* the next run tries again */ continue; } }
    dropPickup(home, hubKey, id);
    delete s.items[id];
  }
  save(home, s);
  return { handovers: out };

  async function skip(h, reason, message) {
    await hubCall(home, hubKey, 'POST', `/connector/v1/handovers/${encodeURIComponent(h.id)}/skip`, { reason });
    try { discardStaged(home, hubKey, h.id); } catch { /* nothing staged */ }
    dropPickup(home, hubKey, h.id);
    delete s.items[h.id];
    save(home, s);
    return { phase: 'skipped', reason: reason === 'key_not_held' ? 'not_on_pc' : reason, message };
  }

  async function one(h, redo = 0) {
    // A rotation of keys this PC holds none of: say so before anyone is asked to click. A Re-enrol's handover lists every
    // agent key of the PC; one this PC lost is still handed over, under a label of its own, so the others are not held back.
    if (h.kind === 'rotate' && !s.items[h.id]?.pickup_id) {
      const listed = (h.agents ?? []).filter((a) => a.key_id);
      const missing = listed.filter((a) => !labelHoldingKey(home, hubKey, a.key_id));
      if (listed.length && missing.length === listed.length) return skip(h, 'key_not_held', `This PC does not hold the key for ${missing.map((a) => a.label).join(', ')}.`);
    }
    const it = s.items[h.id] ??= { kind: h.kind, pickup_id: null, keys_written_for: null, team: null, agents: [], confirmed: false };
    if (it.confirmed) return { phase: 'confirmed' };
    if (!it.pickup_id || it.keys_written_for !== it.pickup_id) {
      // A pickup hands over session keys, and the platform store opens for any process of this user: the PC's user clicks first.
      // A recruit of a team the operator set to Automatic needs no click at the standard level (the hub says so with no_click); Hardened, a rotation and every other handover still wait for it.
      if (!pickupApproved(home, hubKey, h.id) && h.kind === 'recruit' && h.no_click === true && !isHardened(home)) allowOwnPickup(home, hubKey, h.id, h.description ?? 'new agents', []);
      if (!pickupApproved(home, hubKey, h.id)) { requestPickup(home, hubKey, h.id, h.description ?? (h.kind === 'rotate' ? 'a rotated key' : 'new agents')); return { phase: 'waiting', pickup_click: true }; }
      const p = await hubCall(home, hubKey, 'POST', '/onboard/pickup', { request_id: h.id });
      const sec = readKeyFile(home).data?.hubs?.[hubKey] ?? section;
      const known = new Map(it.agents.map((a) => [a.agent_id, a]));
      const keyIds = new Map((h.agents ?? []).map((a) => [a.agent_id, a.key_id]));
      const taken = new Set([...Object.keys(sec.agents ?? {})].filter((l) => ![...known.values()].some((a) => a.label === l)));
      it.pickup_id = p.pickup_id;
      if (p.team?.id) it.team = { id: p.team.id, name: p.team.name ?? null };
      it.agents = p.agents.map((a) => {
        // The same agent keeps the label it got at an earlier pickup of this handover: a redo never adds it twice.
        // A rotated key goes under the label that holds the key it replaces.
        const label = known.get(a.agent_id)?.label ?? (h.kind === 'rotate' ? (labelHoldingKey(home, hubKey, keyIds.get(a.agent_id)) ?? localLabel(a, taken)) : localLabel(a, taken));
        taken.add(label);
        const was = known.get(a.agent_id);
        return { agent_id: a.agent_id, label, hub_label: a.label, role: a.role, team_role: a.team_role, session_var: a.session_var, folder: a.folder, instructions: h.kind === 'recruit' ? a.instructions ?? null : null, built: was?.built ?? h.kind === 'rotate', dir: was?.dir ?? null, error: null };
      });
      save(home, s); // the list first (no secrets), then the keys: a crash here picks up again
      discardStaged(home, hubKey, h.id); // a redo replaces what an earlier pickup staged
      for (let i = 0; i < p.agents.length; i++) { stageAgentKey(home, hubKey, h.id, it.agents[i].label, p.agents[i].secret); p.agents[i].secret = undefined; }
      deps.afterKeys?.(h, it);
      it.keys_written_for = it.pickup_id;
      save(home, s);
    }
    if (h.kind === 'recruit') {
      const place = placeOf(home, section, it.team, root);
      for (const a of it.agents) {
        const why = folderRefusal(place.root, place.project, a.folder, os);
        if (why) return skip(h, 'folder_refused', `The folder for ${a.hub_label ?? a.label} was refused: ${why}.`);
      }
      const setup = { hub_id: section.hub_id, hub_key: hubKey, request: { root: place.root, project: place.project, client: place.client, kind: 'add_agents', team_id: it.team?.id ?? null, team_name: it.team?.name ?? null } };
      for (const a of it.agents) {
        if (a.built) continue;
        try { a.dir = buildAgent(home, setup, a, { claudeJson, node, connector, gitBin }); a.built = true; a.error = null; allowWithPickup(home, a.dir, { agent: a.label, agent_id: a.agent_id, hub_id: section.hub_id, ref: it.pickup_id }); } catch (e) { a.built = false; a.error = oneLine(e.message ?? String(e)).slice(0, 300); }
      }
      save(home, s);
    }
    try {
      await hubCall(home, hubKey, 'POST', '/onboard/pickup/confirm', { pickup_id: it.pickup_id, written: it.agents.map((a) => a.session_var), transport: 'https' });
    } catch (e) {
      // No answer, or one that settles nothing (401, 408, 429, 5xx, a relay's 502): the keys stay staged and the next run
      // confirms again. The hub may have swapped already, and then the old key is gone: dropping the staged one would leave none.
      if (!refused(e)) throw e;
      // The hub answered no: the staged keys go and the old ones keep working. The next run picks up again (the click still holds).
      discardStaged(home, hubKey, h.id);
      it.pickup_id = null; it.keys_written_for = null; save(home, s);
      // The hub replaced this pickup (or lost it): pick up again at once, once, with the same labels.
      if (redo < 1 && e.reason === 'invalid_state' && /pickup again/i.test(e.message)) return one(h, redo + 1);
      throw e;
    }
    commitStaged(home, hubKey, h.id);
    it.confirmed = true;
    spendPickup(home, hubKey, h.id);
    save(home, s);
    return { phase: 'confirmed', agents: it.agents.map((a) => a.label), failed: it.agents.filter((a) => !a.built).map((a) => ({ label: a.label, error: a.error })) };
  }
}
