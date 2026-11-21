/**
 * Pairing (docs/connector.md, "Pairing"; docs/onboarding.md, "Pairing"). The PC's user enters the hub's address, the
 * short CA check the console shows, and the pairing code. The connector checks the hub before it sends the code:
 *
 * 1. It fetches the CA the hub serves (`/onboard/ca.crt`) and compares its fingerprint with the CA check entered. On a
 *    mismatch it stops: "This is not the hub you were given: its certificate does not match". Nothing else is sent.
 * 2. From then on it talks to the hub only over a connection pinned to that CA, so a server whose certificate was not
 *    issued by that CA (someone in the middle with their own CA) is refused by TLS before any byte of the code leaves.
 * 3. It reads the hub's identity (`GET /connector/v1/hub`) and checks the origin the hub names is the one entered.
 * 4. A hub already in the key file under another CA, or at another origin, needs the user's confirmation first.
 * 5. Only then does it send the code (`POST /connector/v1/pair`) and keep the app key in the hub's section of keys.json.
 *
 * Nothing here prints, logs or returns the code or the app key.
 */
import https from 'node:https';
import { X509Certificate } from 'node:crypto';
import { platform, arch } from 'node:os';
import { connect, request, reasonOfError } from './hubclient.mjs';
import { readKeyFile, putHub, normalizeOrigin, caFingerprint, pemBlocks, singleCaPem, hubKeyOf, HUB_ID_RE } from './keyfile.mjs';
import { CONNECTOR_VERSION } from './version.mjs';

// `cnc-pair-` is the code the hub makes now; `cnv_enrol_` is the older form, still accepted from a hub that has not changed yet.
export const CODE_RE = /^(?:cnc-pair-|cnv_enrol_)[a-z2-7]{26}$/;

/** What a one-prompt install tells the operator when the hub refuses a code (docs/onboarding.md, "The prompt"): the same words as the hub's prompt. */
export const REFUSED_CODE_LINE = 'This code was refused. If you just received it, tell the operator now: someone else may have used it.';

/** What the screen says for each outcome. One sentence each, never the hub's or the library's own text. */
export const PAIR_LINES = {
  not_https: 'The hub address must start with https://.',
  bad_check: 'The hub check is the 16 letters and digits the console shows next to the code (for example ab12 cd34 ef56 7890).',
  bad_code: 'The pairing code starts with cnc-pair-. Copy it again from the console.',
  ca_mismatch: 'This is not the hub you were given: its certificate does not match. Nothing was sent.',
  no_ca: 'The hub does not serve its certificate (/onboard/ca.crt), so it cannot be checked. Nothing was sent.',
  ca_bundle: 'The hub serves more than one certificate where it should serve exactly one, so it cannot be pinned. Nothing was sent.',
  tls_refused: 'The hub\'s certificate was not issued by the hub\'s own CA. Nothing was sent.',
  hub_unreachable: 'The hub cannot be reached from this PC. Check the address and the network, then try again.',
  origin_mismatch: 'The hub answers for another address than the one entered. Nothing was sent.',
  ca_changed: 'This hub is already set up on this PC with another certificate. Pair again only if your administrator told you its certificate changed.',
  origin_changed: 'This hub is already set up on this PC at another address. Pair again only if your administrator told you the address changed.',
  code_refused: `This pairing code is not valid, has expired or was already used. Make a new code in the console. ${REFUSED_CODE_LINE}`,
  rate_limited: 'Too many failed attempts from this PC. Wait a while, then try again.',
  paired: 'Paired with the hub.',
};

/** The CA check as entered: 16 hex digits (the console's short form, spaces allowed) or the full 64. Null if neither. */
export function normalizeCheck(s) {
  const h = String(s ?? '').replace(/[\s:]/g, '').toLowerCase();
  return /^[0-9a-f]{16}$/.test(h) || /^[0-9a-f]{64}$/.test(h) ? h : null;
}

/** GET a small text over TLS without trusting anything yet: only to learn which CA the hub claims. No secret is sent. */
function fetchUnpinned(origin, path, timeoutMs) {
  return new Promise((res, rej) => {
    const req = https.get(`${origin}${path}`, { rejectUnauthorized: false, agent: false, timeout: timeoutMs, headers: { accept: 'application/x-pem-file' } }, (r) => {
      let raw = '';
      r.setEncoding('utf8');
      r.on('data', (c) => { raw += c; if (raw.length > 64 * 1024) r.destroy(new Error('too large')); });
      r.on('error', rej);
      r.on('end', () => res({ status: r.statusCode, text: raw }));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', rej);
  });
}

/**
 * Steps 1 to 4: checks the hub and answers what is known, without sending the code.
 * `{ok: true, hub: {id, origin}, caPem, caSha256, conn}` or `{ok: false, reason}`.
 */
export async function checkHub(home, { origin: given, check }, { timeoutMs = 15_000, confirmChange = false } = {}) {
  const origin = normalizeOrigin(given);
  if (!origin) return { ok: false, reason: 'not_https' };
  const want = normalizeCheck(check);
  if (!want) return { ok: false, reason: 'bad_check' };
  let ca;
  try { ca = await fetchUnpinned(origin, '/onboard/ca.crt', timeoutMs); } catch (e) { return { ok: false, reason: reasonOfError(e) === 'tls_refused' ? 'tls_refused' : 'hub_unreachable' }; }
  if (ca.status !== 200) return { ok: false, reason: 'no_ca' };
  // Exactly one PEM block: a second certificate would be trusted too, behind the first one's fingerprint.
  if (pemBlocks(ca.text) > 1) return { ok: false, reason: 'ca_bundle' };
  const caPem = singleCaPem(ca.text), caSha256 = caFingerprint(caPem);
  if (!caSha256) return { ok: false, reason: 'no_ca' };
  try { if (!new X509Certificate(caPem).ca) return { ok: false, reason: 'ca_mismatch' }; } catch { return { ok: false, reason: 'no_ca' }; }
  if (!caSha256.startsWith(want)) return { ok: false, reason: 'ca_mismatch' };
  // Pinned from here: TLS itself refuses a server certificate that this CA did not issue, or one for another host.
  const c = connect({ origin, ca_pem: caPem, ca_sha256: caSha256 });
  if (!c.ok) return { ok: false, reason: c.reason };
  let id;
  try { id = await request(c.hub, 'GET', '/connector/v1/hub', { timeoutMs }); } catch (e) { return { ok: false, reason: e.reason ?? 'hub_unreachable' }; }
  if (id.status !== 200 || !HUB_ID_RE.test(String(id.json?.hub_id ?? ''))) return { ok: false, reason: 'hub_unreachable' };
  if (normalizeOrigin(id.json.origin) !== origin) return { ok: false, reason: 'origin_mismatch' };
  const hub = { id: id.json.hub_id, origin };
  const kf = readKeyFile(home);
  if (!kf.ok) return { ok: false, reason: kf.reason };
  const same = Object.values(kf.data.hubs).filter((s) => s?.hub_id === hub.id);
  if (!confirmChange && same.length && !same.some((s) => s.ca_sha256 === caSha256)) return { ok: false, reason: 'ca_changed', hub };
  if (!confirmChange && same.some((s) => s.ca_sha256 === caSha256 && s.origin !== origin)) return { ok: false, reason: 'origin_changed', hub };
  return { ok: true, hub, caPem, caSha256, conn: c.hub };
}

/**
 * The whole pairing: checks the hub (steps 1 to 4), then sends the code and keeps the app key (step 5).
 * `{ok: true, hubKey, hub, pc}` or `{ok: false, reason}`. A refusal by the hub is `code_refused` or `rate_limited`.
 */
export async function pair(home, { origin, check, code }, opts = {}) {
  const c = String(code ?? '').trim();
  if (!CODE_RE.test(c)) return { ok: false, reason: 'bad_code' };
  const h = await checkHub(home, { origin, check }, opts);
  if (!h.ok) return h;
  let r;
  try {
    r = await request(h.conn, 'POST', '/connector/v1/pair', { timeoutMs: opts.timeoutMs ?? 15_000,
      body: { pairing_code: c, hub_origin: h.hub.origin, hub_ca_sha256: h.caSha256, platform: `${platform()}-${arch()}`, version: CONNECTOR_VERSION } });
  } catch (e) { return { ok: false, reason: e.reason ?? 'hub_unreachable' }; }
  if (r.status === 429) return { ok: false, reason: 'rate_limited' };
  if (r.status !== 200 || typeof r.json?.app_key !== 'string' || r.json.hub?.id !== h.hub.id) return { ok: false, reason: 'code_refused' };
  const hubKey = putHub(home, { hubId: h.hub.id, origin: h.hub.origin, caPem: h.caPem, appKey: r.json.app_key });
  // What the code was for: an operator's Add PC code (`pc`), or a collaborator's invite (`invite`, with the hub's words for it). A hub that says nothing is `pc`.
  const kind = r.json.code_kind === 'invite' ? 'invite' : 'pc';
  const inv = kind === 'invite' && r.json.invite && typeof r.json.invite === 'object' ? r.json.invite : null;
  return { ok: true, hubKey, hub: h.hub, pc: { id: String(r.json.pc?.id ?? ''), name: String(r.json.pc?.name ?? '') }, kind, invite: inv };
}

export { hubKeyOf };
