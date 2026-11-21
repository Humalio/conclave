/**
 * What the PC's user has clicked to allow on the connector's local screen (docs/connector.md, "Isolation levels").
 *
 * - A hand-opened chat's FIRST registration in an agent folder waits for a click, once per folder: registration is
 *   self-asserted, and this is what keeps a process from claiming another agent's folder unseen.
 * - At the standard level a KEY PICKUP waits for a click too, because the platform store opens for any process of the same
 *   user and a pickup hands over a rotated session key.
 *
 * `pending.json` is written by the connector when something waits; `approvals.json` only by the screen's own handlers
 * (approve*), which check that the thing is waiting. Neither file holds a key or a token. Neither level separates two live
 * agents of one OS user: a process that writes approvals.json itself is outside what this file protects, and the docs say so.
 */
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { keyFilePath } from './keyfile.mjs';
import { readJson, atomicWrite, pathKey, canonicalFolder, folderIdentity } from './paths.mjs';
import { allBindings, configHash, registryPath, resolveFolder } from './registry.mjs';

export const approvalsPath = (home) => join(home, 'approvals.json');
export const pendingPath = (home) => join(home, 'pending.json');
const EMPTY = () => ({ version: 1, folders: {}, pickups: {} });
const load = (path) => { const v = readJson(path, EMPTY()); return v && typeof v === 'object' && !Array.isArray(v) && v.folders && v.pickups ? v : EMPTY(); };
/** A pending request is dropped after a day with no click. */
export const PENDING_MS = 24 * 3600_000;

/** True if this folder, as bound now (same agent, hub and filesystem identity), was allowed by the PC's user. */
export function folderApproved(home, folder, binding) {
  const a = load(approvalsPath(home)).folders[pathKey(folder)];
  if (!a || a.agent !== binding.agent || a.hub_id !== binding.hub_id || a.identity !== (binding.identity ?? null)) return false;
  // An allowance that came with a pickup holds only while the folder's settings are as they were built.
  if (a.by === 'pickup' && a.config_sha256 && configHash(canonicalFolder(folder) ?? folder) !== a.config_sha256) return false;
  return true;
}

/** Records that a folder's chat waits for a click. Idempotent. */
export function requestFolder(home, folder, binding) {
  const p = load(pendingPath(home));
  const k = pathKey(folder);
  // The row on the connector's screen shows which program asks, how long ago, and whether the folder's settings changed since it was registered.
  p.folders[k] = { folder, agent: binding.agent, hub_id: binding.hub_id, identity: binding.identity ?? null, program: binding.provider === 'codex' ? 'codex' : 'claude', config_sha256: binding.config_sha256 ?? null, at: p.folders[k]?.at ?? Date.now() };
  atomicWrite(pendingPath(home), JSON.stringify(p, null, 2) + '\n');
}

/** A deny is remembered for this long: the chat is told it was not allowed, and its row stays under "Denied" (where it can still be allowed). */
export const DENY_MS = 10 * 60_000;
const denied = (p) => (p.denied && typeof p.denied === 'object' ? p.denied : (p.denied = {}));
const live = (d, now) => !!d && now - d.denied_at < DENY_MS;
/** True if a folder's chat was denied within the last ten minutes (it is not asked about again until then). */
export function folderDenied(home, folder, now = Date.now()) {
  return live(denied(load(pendingPath(home)))[`f|${pathKey(folder)}`], now);
}
/** True if a key pickup (one request on one hub) was denied within the last ten minutes. */
export function pickupDenied(home, hubKey, requestId, now = Date.now()) {
  return live(denied(load(pendingPath(home)))[`p|${pickupKey(hubKey, requestId)}`], now);
}

/** True if the folder's settings differ from what was recorded when it was registered (or were held then). Unknown is not a warning. */
function settingsChanged(w) {
  if (!w.config_sha256) return false;
  if (w.config_sha256 === 'held') return true;
  const canon = canonicalFolder(w.folder);
  return !!canon && configHash(canon) !== w.config_sha256;
}
const folderRow = (key, v) => ({ key, folder: v.folder, agent: v.agent, hub_id: v.hub_id, program: v.program ?? 'claude', at: v.at, config_changed: settingsChanged(v) });
const pickupRow = (key, v) => ({ key, hub_key: v.hub_key, request: v.request, what: v.what, folders: v.folders ?? [], at: v.at });

/**
 * What waits for a click now, and what was denied in the last ten minutes:
 * `{folders: [{key, folder, agent, hub_id, program, at, config_changed}], pickups: [{key, hub_key, request, what, at}], denied: [{kind, key, denied_at, ...the same fields}]}`.
 */
export function pendingList(home, now = Date.now()) {
  const p = load(pendingPath(home));
  return {
    folders: Object.entries(p.folders).filter(([, v]) => now - v.at < PENDING_MS).map(([key, v]) => folderRow(key, v)),
    pickups: Object.entries(p.pickups).filter(([, v]) => now - v.at < PENDING_MS).map(([key, v]) => pickupRow(key, v)),
    denied: Object.values(denied(p)).filter((v) => live(v, now)).map((v) => (v.kind === 'pickup' ? { kind: 'pickup', ...pickupRow(v.key, v), denied_at: v.denied_at } : { kind: 'folder', ...folderRow(v.key, v), denied_at: v.denied_at })).sort((x, y) => y.denied_at - x.denied_at),
  };
}

/** The PC user's click on a waiting (or just denied) folder. Returns whether it was waiting (and is now allowed). */
export function approveFolder(home, key) {
  const p = load(pendingPath(home)), d = denied(p), w = p.folders[key] ?? (d[`f|${key}`]?.kind === 'folder' ? d[`f|${key}`] : null);
  if (!w) return false;
  const canon = canonicalFolder(w.folder);
  if (!canon || pathKey(canon) !== key || folderIdentity(canon) !== w.identity && w.identity !== null) return false;
  const a = load(approvalsPath(home));
  a.folders[key] = { agent: w.agent, hub_id: w.hub_id, identity: w.identity, approved_at: Date.now() };
  delete p.folders[key]; delete d[`f|${key}`];
  atomicWrite(approvalsPath(home), JSON.stringify(a, null, 2) + '\n');
  atomicWrite(pendingPath(home), JSON.stringify(p, null, 2) + '\n');
  return true;
}

/**
 * The PC user's Deny on a waiting folder. The chat is told it was not allowed (broker, reason `denied`), the row moves to the
 * "Denied" list for ten minutes, and the hub gets one audit entry (unreportedDenials). Returns whether it was waiting.
 */
export function denyFolder(home, key) {
  const p = load(pendingPath(home)), w = p.folders[key];
  if (!w) return false;
  delete p.folders[key];
  denied(p)[`f|${key}`] = { ...w, kind: 'folder', key, denied_at: Date.now(), reported: false };
  atomicWrite(pendingPath(home), JSON.stringify(p, null, 2) + '\n');
  return true;
}
/** Deny on a waiting key pickup: it is not made, and the hub is told it was declined on this PC. */
export function denyPickup(home, key) {
  const p = load(pendingPath(home)), w = p.pickups[key];
  if (!w) return false;
  delete p.pickups[key];
  denied(p)[`p|${key}`] = { ...w, kind: 'pickup', key, denied_at: Date.now(), reported: false };
  atomicWrite(pendingPath(home), JSON.stringify(p, null, 2) + '\n');
  return true;
}
/** Denials the hub has not been told about: `[{id, kind, agent?, hub_id?, hub_key?, request?}]`. Kept (and tried again) until markDenialsReported. */
export function unreportedDenials(home) {
  return Object.entries(denied(load(pendingPath(home)))).filter(([, v]) => v.reported === false).map(([id, v]) => (v.kind === 'pickup' ? { id, kind: 'pickup', hub_key: v.hub_key, request: v.request } : { id, kind: 'folder', agent: v.agent, hub_id: v.hub_id }));
}
export function markDenialsReported(home, ids) {
  const p = load(pendingPath(home)), d = denied(p);
  for (const id of ids) if (d[id]) d[id].reported = true;
  atomicWrite(pendingPath(home), JSON.stringify(p, null, 2) + '\n');
}
/** Forgets what is older than the deny memory (and was reported). */
export function pruneDenied(home, now = Date.now()) {
  const p = load(pendingPath(home)), d = denied(p);
  let n = 0;
  for (const [k, v] of Object.entries(d)) if (!live(v, now) && v.reported !== false) { delete d[k]; n++; }
  if (n) atomicWrite(pendingPath(home), JSON.stringify(p, null, 2) + '\n');
}

/** The connector's own launcher starts a run it knows (the wake): it allows that folder without a click, because nothing self-asserted is involved. */
export function approveFolderByConnector(home, folder, binding) {
  const a = load(approvalsPath(home));
  a.folders[pathKey(folder)] = { agent: binding.agent, hub_id: binding.hub_id, identity: binding.identity ?? null, approved_at: Date.now() };
  atomicWrite(approvalsPath(home), JSON.stringify(a, null, 2) + '\n');
}


/**
 * The upgrade to turn tokens, once per PC: a folder registered BEFORE it, whose settings still hash as they did when it was registered
 * (and whose filesystem identity is unchanged), is allowed without a click, because the PC's user already set it up. A folder whose
 * settings changed or are held, and every folder registered after this runs, still waits for its click. Each grandfathered folder gets
 * one connector.log line (`log`) and one audit entry on its hub (unauditedGrandfathered, markAudited). Returns the folders it allowed.
 */
export function grandfather(home, log = () => {}) {
  // A folder that is not a connector home (removed, or holding only the user's files) is not written to; a real home is marked even before pairing, so a folder registered after this start still waits for its click.
  if (![join(home, 'conclave.mjs'), keyFilePath(home), registryPath(home)].some((p) => existsSync(p))) return [];
  const a = load(approvalsPath(home));
  if (a.grandfathered_at) return [];
  const done = [];
  let bindings;
  try { bindings = allBindings(home); } catch { return []; } // no readable registry: tried again at the next start
  for (const b of bindings) {
    const canon = b.path && canonicalFolder(b.path);
    if (!canon || !b.agent || !b.config_sha256 || b.config_sha256 === 'held') { log(`folder ${b.path ?? '?'} not grandfathered (its settings are held or not recorded); it waits for a click`); continue; }
    if ((b.identity ?? null) !== folderIdentity(canon) || configHash(canon) !== b.config_sha256) { log(`folder ${canon} not grandfathered (changed since it was registered); it waits for a click`); continue; }
    a.folders[pathKey(canon)] = { agent: b.agent, hub_id: b.hub_id, identity: b.identity ?? null, approved_at: Date.now(), by: 'upgrade', audited: false };
    done.push({ folder: canon, agent: b.agent, hub_id: b.hub_id });
    log(`folder ${canon} grandfathered: registered before the upgrade and unchanged since, so it is allowed as ${b.agent} without a click`);
  }
  a.grandfathered_at = Date.now();
  atomicWrite(approvalsPath(home), JSON.stringify(a, null, 2) + '\n');
  return done;
}

/** Grandfathered folders of one hub whose audit entry the hub has not yet confirmed: `[{key, agent}]`. */
export function unauditedGrandfathered(home, hubId) {
  return Object.entries(load(approvalsPath(home)).folders).filter(([, v]) => v.by === 'upgrade' && v.audited === false && v.hub_id === hubId).map(([key, v]) => ({ key, agent: v.agent }));
}
export function markAudited(home, keys) {
  const a = load(approvalsPath(home));
  for (const k of keys) if (a.folders[k]?.by === 'upgrade') a.folders[k].audited = true;
  atomicWrite(approvalsPath(home), JSON.stringify(a, null, 2) + '\n');
}

/**
 * A folder the connector itself built and registered inside a key pickup or restore the PC user allowed counts as allowed for that agent on
 * that hub: nothing self-asserted is involved (the same reason a run the connector starts needs no click). Called only after the folder is
 * fully built and its registry entry saved; it records the folder's settings hash and identity as they are now, so a later change waits for
 * a click (folderApproved). Returns whether it was recorded; a folder that is not bound to this agent and hub, or whose settings are held, is not.
 * One audit entry on the hub, under its own name (unauditedPickupAllowed, markPickupAudited).
 */
export function allowWithPickup(home, folder, { agent, agent_id = null, hub_id, ref }) {
  const canon = canonicalFolder(folder);
  if (!canon || !agent || !hub_id) return false;
  let r;
  try { r = resolveFolder(home, canon); } catch { return false; }
  if (!r?.ok || r.binding.agent !== agent || r.binding.hub_id !== hub_id) return false;
  const hash = configHash(canon);
  if (!hash || r.binding.config_sha256 === 'held') return false;
  const a = load(approvalsPath(home));
  a.folders[pathKey(canon)] = { agent, hub_id, identity: folderIdentity(canon), config_sha256: hash, approved_at: Date.now(), by: 'pickup', ref: String(ref ?? '').slice(0, 100), agent_id, audited: false };
  atomicWrite(approvalsPath(home), JSON.stringify(a, null, 2) + '\n');
  return true;
}
/** Allowances that came with a pickup whose audit entry the hub has not confirmed: `[{key, agent_id, ref}]`. */
export function unauditedPickupAllowed(home, hubId) {
  return Object.entries(load(approvalsPath(home)).folders).filter(([, v]) => v.by === 'pickup' && v.audited === false && v.hub_id === hubId && v.agent_id).map(([key, v]) => ({ key, agent_id: v.agent_id, ref: v.ref }));
}
export function markPickupAudited(home, keys) {
  const a = load(approvalsPath(home));
  for (const k of keys) if (a.folders[k]?.by === 'pickup') a.folders[k].audited = true;
  atomicWrite(approvalsPath(home), JSON.stringify(a, null, 2) + '\n');
}

/** Withdraws an allowance (a folder that was unregistered, or an agent moved to another folder). */
export function revokeFolder(home, folder) {
  const a = load(approvalsPath(home)), k = pathKey(folder);
  if (!a.folders[k]) return false;
  delete a.folders[k];
  atomicWrite(approvalsPath(home), JSON.stringify(a, null, 2) + '\n');
  return true;
}

const pickupKey = (hubKey, requestId) => `${hubKey}|${requestId}`;
/** True once the PC user allowed this key pickup (one request on one hub). */
export const pickupApproved = (home, hubKey, requestId) => !!load(approvalsPath(home)).pickups[pickupKey(hubKey, requestId)];
/** Records that a pickup waits for a click. `what` says in plain words what is being picked up. */
export function requestPickup(home, hubKey, requestId, what, folders = []) {
  const p = load(pendingPath(home)), k = pickupKey(hubKey, requestId);
  // `folders`: the agent folders this pickup builds, shown before the click: the click also allows the first chat in each.
  const list = (Array.isArray(folders) ? folders : []).slice(0, 50).map((f) => ({ agent: String(f.agent ?? '').slice(0, 100), path: String(f.path ?? '').slice(0, 400) }));
  p.pickups[k] = { hub_key: hubKey, request: requestId, what: String(what).slice(0, 120), folders: list, at: p.pickups[k]?.at ?? Date.now() };
  atomicWrite(pendingPath(home), JSON.stringify(p, null, 2) + '\n');
}
export function approvePickup(home, key) {
  const p = load(pendingPath(home)), d = denied(p), w = p.pickups[key] ?? (d[`p|${key}`]?.kind === 'pickup' ? d[`p|${key}`] : null);
  if (!w) return false;
  const a = load(approvalsPath(home));
  a.pickups[key] = { approved_at: Date.now() };
  delete p.pickups[key]; delete d[`p|${key}`];
  atomicWrite(approvalsPath(home), JSON.stringify(a, null, 2) + '\n');
  atomicWrite(pendingPath(home), JSON.stringify(p, null, 2) + '\n');
  return true;
}
/**
 * The pickup of a request this PC itself filed, allowed with no click (docs/onboarding.md, "The prompt"). The request came from this connector and the
 * keys go only to it, so there is nothing self-asserted to confirm. Not used at the hardened level, where the PC user is not the one who opens the keys.
 * Spent like a click, when the pickup is made.
 */
export function allowOwnPickup(home, hubKey, requestId, what, folders = []) {
  requestPickup(home, hubKey, requestId, what, folders);
  return approvePickup(home, pickupKey(hubKey, requestId));
}
/** One pickup is allowed once: a click is spent when the pickup is made. */
export function spendPickup(home, hubKey, requestId) {
  const a = load(approvalsPath(home)), k = pickupKey(hubKey, requestId);
  if (!a.pickups[k]) return;
  delete a.pickups[k];
  atomicWrite(approvalsPath(home), JSON.stringify(a, null, 2) + '\n');
}
/** A pickup the hub no longer lists (cancelled, expired, skipped): its click and any waiting request go, so the click cannot be reused. */
export function dropPickup(home, hubKey, requestId) {
  const k = pickupKey(hubKey, requestId);
  const a = load(approvalsPath(home)), p = load(pendingPath(home));
  if (a.pickups[k]) { delete a.pickups[k]; atomicWrite(approvalsPath(home), JSON.stringify(a, null, 2) + '\n'); }
  if (p.pickups[k]) { delete p.pickups[k]; atomicWrite(pendingPath(home), JSON.stringify(p, null, 2) + '\n'); }
}
