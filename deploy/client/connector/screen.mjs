/**
 * The connector's local screen (docs/onboarding.md, "Pairing" and "Starting the team"; docs/connector.md, "The connector's screen"):
 * pairing, then setup, on this PC only. It listens on 127.0.0.1 on a random port and answers nobody else:
 *
 * - The address it opens carries a one-time token; the first visit trades it for a cookie (HttpOnly, SameSite=Strict)
 *   and the token stops working. Every other request needs that cookie.
 * - The Host header must be this address (a DNS-rebinding page has another), and every POST must come with this
 *   address as its Origin (another site's form cannot post here).
 * - It stops on its own after an hour with no visit, and on `close()`.
 *
 * The page, top to bottom: a status line; a "Needs you" card when something waits (Deny and Allow for each folder and key pickup,
 * never "Allow all"; what was just denied stays below it, still allowable); one card per team, collapsed but the first; and the
 * settings as one-line summaries that open on click. Text that came from the hub (team and agent names, roles) is escaped and
 * underlined, so it is never mistaken for the connector's own words.
 *
 * The pairing code is never shown back, never put in a page, a log or the address. Pages are plain server-rendered
 * HTML with one small inline script for the Copy buttons; nothing is loaded from elsewhere.
 */
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { readKeyFile } from './keyfile.mjs';
import { pair, PAIR_LINES } from './pairing.mjs';
import { advance, agentRows, retryAgent, pending, AGENT_STATES } from './onboard.mjs';
import { installPrivateGit, GIT_OFFER } from './git.mjs';
import { WIN, oneLine } from './paths.mjs';
import { listDestinations, addDestination, removeDestination, destinationChanged } from './destinations.mjs';
import { restoreView, approveFolder } from './restore.mjs';
import { waiting, deliveryLine } from './deliveries.mjs';
import { listProfiles, addProfile, setHidden, removeProfile, bindAgent, profileOf, listTeams, bindRegisteredTeam } from './profiles.mjs';
import { foldersOfHub } from './registry.mjs';
import { pendingList, approveFolder as allowFolder, approvePickup, denyFolder, denyPickup } from './approvals.mjs';
import { storeName, STORE_LINES } from './keystore.mjs';
import { wakeSettings, setWake, setAgentMessages } from './wake.mjs';
import { allBindings } from './registry.mjs';
import { isHardened } from './isolation.mjs';
import { CONNECTOR_VERSION } from './version.mjs';
import { workerLockPath } from './service.mjs';
import { alive } from './run.mjs';

export const IDLE_MS = 60 * 60_000;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** Text the hub supplied (a team name, an agent label or role, an origin): escaped, and underlined so it reads as the hub's words. */
const hub = (s) => `<span class="hub" title="Text from the hub">${esc(s)}</span>`;
/** "just now", "3 min ago", "2 h ago", "1 d ago". */
export function ago(at, now = Date.now()) {
  const s = Math.max(0, Math.round((now - Number(at)) / 1000));
  if (!Number.isFinite(s) || !at) return '';
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}
/** True if a POST came from this screen: its Origin is one of the screen's own addresses, or it is `null` and the browser
 * says the request is same-origin (`Sec-Fetch-Site`, which a page cannot set). Host and the session cookie are checked apart. */
export const sentFromScreen = (headers, hosts) => {
  const origin = String(headers.origin ?? '');
  if (hosts.map((h) => `http://${h}`).includes(origin)) return true;
  return origin === 'null' && String(headers['sec-fetch-site'] ?? '') === 'same-origin';
};
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

// Type is 11, 12, 13 and 16 px in weights 400, 500 and 600; space is on a 4 px grid; chips have 3 px corners (docs/design-guidelines.md).
const CSS = `:root{--bg:#f7f7f5;--panel:#fff;--text:#1d1d1b;--muted:#6b6b66;--line:#e3e2dd;--accent:#3b5bdb;--ok:#2b8a3e;--warn:#b35c00;--bad:#c92a2a;--warn-bg:#fff4e6;--bad-bg:#fff0f0}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--panel:#1f1f1d;--text:#ecebe6;--muted:#a3a29b;--line:#34332f;--accent:#91a7ff;--ok:#69db7c;--warn:#ffa94d;--bad:#ff8787;--warn-bg:#2a2218;--bad-bg:#2b1b1b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:400 13px/20px system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:760px;margin:0 auto;padding:24px 16px}h1{font:600 16px/24px system-ui,-apple-system,"Segoe UI",sans-serif;margin:0 0 8px}h2{font:600 13px/20px system-ui;margin:0 0 8px}h3{font:600 13px/20px system-ui;margin:16px 0 4px}
p{margin:8px 0}.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 16px;margin:12px 0}.muted{color:var(--muted);font-size:12px;line-height:16px}
.card.needs{border-color:var(--warn);background:var(--warn-bg)}.card.needs h2{color:var(--warn)}
label{display:block;margin:8px 0 4px;font-weight:500}input[type=text],input[type=url],select{width:100%;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--text);font:inherit}
button{font:500 13px/20px system-ui;padding:4px 12px;border-radius:6px;border:1px solid var(--line);background:var(--panel);color:var(--text);cursor:pointer}button.pri{background:var(--accent);border-color:var(--accent);color:#fff}button.quiet{color:var(--muted)}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.row.between{justify-content:space-between}.grow{flex:1 1 auto;min-width:0}
.status{display:flex;gap:4px 16px;flex-wrap:wrap;align-items:center;justify-content:space-between}.status .l{display:flex;gap:4px 16px;flex-wrap:wrap}
.chip{display:inline-block;font-size:11px;line-height:16px;font-weight:500;padding:0 8px;border-radius:3px;border:1px solid currentColor;white-space:nowrap}.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}
.need{border-top:1px solid var(--line);padding:12px 0}.need:first-of-type{border-top:0}.need .path{display:block;margin:4px 0;word-break:break-all}ul.paths{margin:8px 0 0;padding:0;list-style:none}ul.paths li{margin:8px 0}
.alert{margin:4px 0;padding:4px 8px;border:1px solid var(--warn);border-radius:6px;color:var(--warn);font-size:12px;line-height:16px}
.hub{text-decoration:underline dotted;text-underline-offset:2px}
details{margin:0}details>summary{cursor:pointer;list-style:none;display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:4px 0}details>summary::-webkit-details-marker{display:none}
details>summary::before{content:"\\25B8";color:var(--muted);width:12px}details[open]>summary::before{content:"\\25BE"}
.team>summary{padding:0}.team .counts{margin-left:auto}.agentrow{border-top:1px solid var(--line);padding:4px 0}.agentrow:first-of-type{border-top:0}
.panel{margin:4px 0 8px 20px}.set{border-top:1px solid var(--line)}.set:first-of-type{border-top:0}.set>summary .sum{color:var(--muted);margin-left:auto;text-align:right}
code,pre{font:12px/16px ui-monospace,Consolas,monospace}pre{white-space:pre-wrap;word-break:break-all;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:8px;margin:4px 0}
.msg{border:1px solid var(--line);border-radius:6px;padding:8px 12px;margin:12px 0;background:var(--panel)}.msg.bad{border-color:var(--bad);background:var(--bad-bg)}`;
const COPY = `document.addEventListener('click',e=>{const b=e.target.closest('[data-copy]');if(!b)return;navigator.clipboard.writeText(document.getElementById(b.dataset.copy).textContent).then(()=>{b.textContent='Copied';setTimeout(()=>b.textContent='Copy',1500)})})`;

/** Reloads the page every `s` seconds while something waits, but never under someone typing: it skips while a field has focus or holds text the person changed. */
const REFRESH = (s) => `setTimeout(function t(){var a=document.activeElement,d=!!a&&/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);[].forEach.call(document.querySelectorAll('input,textarea'),function(i){if(i.type!=='hidden'&&i.value!==i.defaultValue)d=true});if(d)setTimeout(t,${s * 1000});else location.replace('/?r=1')},${s * 1000})`;
function page(title, body, { refresh = 0 } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body><main>${body}</main><script>${COPY}</script>${refresh ? `<script data-refresh="${refresh}">${REFRESH(refresh)}</script>` : ''}</body></html>`;
}
let copyId = 0;
const copyBox = (text) => { const id = `c${++copyId}`; return `<pre id="${id}">${esc(text)}</pre><button type="button" data-copy="${id}">Copy</button>`; };
const form = (action, fields, label, cls = '') => `<form method="post" action="${action}" style="display:inline">${Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('')}<button class="${cls}">${esc(label)}</button></form>`;
const chip = (text, tone = '') => `<span class="chip ${tone}">${esc(text)}</span>`;

/** The pairing form. The code field always starts empty: a code is never put back into a page. */
function pairForm(msg, { origin = '', check = '', confirm = false } = {}) {
  return `<h1>Pair this PC with your Conclave hub</h1>
<p class="muted">Enter what the console showed when your administrator added this PC. The connector checks the hub's certificate against the hub check before it sends the code.</p>
${msg ? `<div class="msg ${msg.bad ? 'bad' : ''}">${esc(msg.text)}</div>` : ''}
<form method="post" action="/pair" class="card" autocomplete="off">
<label for="o">Hub address</label><input id="o" type="url" name="origin" required placeholder="https://hub.example:8443" value="${esc(origin)}">
<label for="k">Hub check</label><input id="k" type="text" name="check" required placeholder="ab12 cd34 ef56 7890" value="${esc(check)}">
<label for="c">Pairing code</label><input id="c" type="text" name="code" required placeholder="cnc-pair-…" spellcheck="false">
${confirm ? '<label><input type="checkbox" name="confirm" value="1"> My administrator told me this hub\'s certificate or address changed.</label>' : ''}
<p class="row"><button class="pri">Pair</button></p></form>`;
}

const STATE_TONE = (s) => (s === 'connected' ? 'ok' : s === 'failed' || s === 'key_refused' ? 'bad' : 'warn');
/** The ready, waiting and error counts of a team's agents. Ready is connected; error is failed or key refused; everything else waits. */
export function teamCounts(rows) {
  const c = { ready: 0, waiting: 0, error: 0 };
  for (const a of rows ?? []) { if (a.state === 'connected') c.ready++; else if (a.state === 'failed' || a.state === 'key_refused') c.error++; else c.waiting++; }
  return c;
}

/** One compact agent row: label, role, wake, state, and an Open button that opens the commands. */
function agentHtml(hubKey, a, wakeOn, level) {
  const tone = STATE_TONE(a.state);
  const wake = wakeOn === undefined ? '' : `<span class="muted">wake ${wakeOn ? 'on' : 'off'} · ${esc(level)}</span>`;
  const head = `${hub(a.label)}<span class="muted">${a.role ? hub(a.role) : ''}</span>${wake}${chip(a.text ?? AGENT_STATES[a.state] ?? a.state, tone)}`;
  let more = '';
  if (a.state === 'key_refused') more += '<p>The hub no longer accepts this agent\'s key. Ask your administrator for a new key; it reaches this PC by itself.</p>';
  if (a.state === 'failed') more += `<p>${esc(a.error ?? 'Setup failed.')}</p><p>${form('/retry', { hub: hubKey, label: a.label }, 'Retry')}</p>`;
  if (a.open && a.state !== 'connected') {
    more += `<p class="muted">${esc(a.open.desktop.line)}</p>${copyBox(a.open.desktop.folder)} ${form('/open', { hub: hubKey, label: a.label }, 'Open agent', 'pri')}`;
    more += `<p class="muted">In a terminal:</p>${copyBox(a.open.terminal)}${a.codex ? `<p class="muted">With Codex:</p>${copyBox(a.open.codex)}` : ''}`;
  }
  if (!more) return `<div class="agentrow row">${head}</div>`;
  return `<details class="agentrow"><summary>${head}<span class="grow"></span>${chip('Open')}</summary><div class="panel">${more}</div></details>`;
}

/** Restore on this PC: what a restore waits for, and how to open each restored agent (inside the team). */
function restoreNotes(home, hubKey, { claudeJson, win }) {
  const v = restoreView(home, hubKey, { claudeJson, win });
  let h = '';
  for (const r of v.active) {
    h += `<div class="msg"><b>Restore in progress</b> <span class="muted">${esc(r.checkout_id)}</span><br>${esc(r.note ?? 'Working.')}</div>`;
    for (const f of r.waiting) h += `<div class="row"><span>The folder <b>${esc(f)}</b> has agent settings of its own. Approve it only if you trust what is in it.</span>${form('/restore-approve', { hub: hubKey, checkout: r.checkout_id, folder: f }, 'Approve folder', 'pri')}</div>`;
  }
  for (const r of v.done) h += `<details><summary>Restored: how to open each agent <span class="muted">(${esc(r.checkout_id)})</span></summary><div class="panel">${r.lines.map((l) => copyBox(l)).join('')}</div></details>`;
  return h;
}

/** Folders approved for a restored team (a setting). */
function restoreFoldersBody(home, hubKey) {
  const dests = listDestinations(home);
  let h = dests.length ? '<p class="muted">Folders approved for a restored team (the hub sees the name, never the folder):</p>' : '<p class="muted">No folder is approved yet. A restore from the console goes only into a folder you approve here.</p>';
  for (const d of dests) h += `<div class="row"><b>${esc(d.label)}</b><code>${esc(d.path)}</code>${destinationChanged(d) ? '<span class="muted">The folder was replaced since you approved it. Approve it again below.</span>' : ''}${form('/destination-remove', { hub: hubKey ?? '', id: d.id }, 'Remove')}</div>`;
  return h + `<form method="post" action="/destination-add" class="row"><input type="hidden" name="hub" value="${esc(hubKey ?? '')}"><input type="text" name="path" required placeholder="Folder, e.g. ${esc(WIN ? 'C:\\Users\\you\\Conclave' : '/home/you/conclave')}"><input type="text" name="label" placeholder="Name (optional)"><button>Approve this folder</button></form>`;
}

const PROFILE_LINES = { invalid_name: 'A profile name is letters, digits, spaces, dash or underscore, up to 40 characters.', email_shaped: 'A profile name cannot look like an email address.', key_shaped: 'A profile name cannot look like a key.', exists: 'A profile with that name already exists.', dir_not_absolute: 'Give the full path of the folder.', dir_unusable: 'That folder cannot be used.', dir_is_connector_folder: 'That is the connector own folder.', invalid_kind: 'Pick Claude or Codex.', too_many: 'That is the most profiles this PC keeps.', no_such_profile: 'No such profile.', wrong_kind: 'That profile is for the other program (Claude or Codex).', not_registered: 'That agent folder is not registered.', identity_changed: 'That agent folder changed; repair it first.', config_changed: 'The agent settings of that folder changed since they were recorded; run conclave repair first.', config_changed_team: 'The agent settings of one folder in this team changed since they were recorded, so nothing was bound. Run conclave repair first.', wrong_kind_team: 'No agent of this team runs that program (Claude or Codex).', no_such_team: 'No folder of that team is registered on this PC.' };

/** Account profiles: local names for Claude config folders and Codex homes. The hub sees only a name, and not at all while it is hidden. */
function profilesBody(home, hubs) {
  const ps = listProfiles(home);
  let h = '<p class="muted">Each profile is a separate Claude config folder or Codex home that you log in to yourself. Profiles are not used by any run yet: that waits until separate logins are proven with two accounts. The hub sees only the profile name, never a login, an email or a folder.</p>';
  for (const p of ps) h += `<div class="row"><b>${esc(p.name)}</b><span class="muted">${p.kind === 'codex' ? 'Codex' : 'Claude'}</span><code>${esc(p.dir)}</code>${p.hidden ? chip('Profile hidden', 'warn') : ''}${form('/profile-hide', { name: p.name, hidden: p.hidden ? '0' : '1' }, p.hidden ? 'Share name' : 'Hide name')}${form('/profile-remove', { name: p.name }, 'Remove')}</div>`;
  h += `<form method="post" action="/profile-add" class="row"><input type="text" name="name" required placeholder="Name, e.g. work" maxlength="40"><select name="kind"><option value="claude">Claude</option><option value="codex">Codex</option></select><input type="text" name="dir" required placeholder="Folder, e.g. ${esc(WIN ? 'C:\\Users\\you\\.claude-work' : '/home/you/.claude-work')}"><button>Add profile</button></form>`;
  if (ps.length) {
    const all = [];
    for (const [, s] of hubs) for (const b of foldersOfHub(home, s.hub_id, s.ca_sha256)) if (!all.some((x) => x.path === b.path)) all.push(b);
    // Bind team: one row per team of the registered folders; it binds the team's folders that run the profile's program.
    for (const t of listTeams(home, all)) {
      const n = t.folders.length;
      h += `<form method="post" action="/profile-bind-team" class="row"><input type="hidden" name="team" value="${esc(t.id)}"><b>${hub(t.name ?? t.id)}</b><span class="muted">Team, ${n} agent${n === 1 ? '' : 's'}</span><select name="profile"><option value="">Default account</option>${ps.map((p) => `<option value="${esc(p.name)}"${p.name === t.profile ? ' selected' : ''}>${esc(p.name)} (${p.kind === 'codex' ? 'Codex' : 'Claude'})</option>`).join('')}</select><button>Bind team</button><span class="muted">Binds the team's agents that run that program and trusts their folders in it. An agent bound on its own keeps its profile.</span></form>`;
    }
    for (const b of all) {
      const cur = b.profile ?? '';
      h += `<form method="post" action="/profile-bind" class="row"><input type="hidden" name="folder" value="${esc(b.path)}"><b>${hub(b.agent)}</b><select name="profile"><option value="">Default account</option>${ps.filter((p) => p.kind === (b.provider === 'codex' ? 'codex' : 'claude')).map((p) => `<option value="${esc(p.name)}"${p.name === cur ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select><button>Bind</button><span class="muted">Binding also trusts this folder in that profile.</span></form>`;
    }
  }
  return h;
}

/** Items the hub delivered to this PC for its agents (until the wake ships on this platform): fixed words and counts, never an id or any text of the item. */
function deliveredHtml(home, hubKey) {
  const w = waiting(home, hubKey), rows = Object.values(w).map((items) => deliveryLine(items)).filter(Boolean);
  return rows.length ? '<div class="msg"><b>Waiting for an agent on this PC.</b> Open its session to pick it up; the next prompt shows it.<br>' + rows.map((r) => esc(r.replace(/^Conclave: /, ''))).join('<br>') + '</div>' : '';
}

/** Isolation: what it protects and where the key file's secret lives. */
function isolationBody(home) {
  const st = storeName(home), hard = isHardened(home);
  let h = '';
  if (hard) h += '<p>Agents on this PC get a short-lived token for each turn. Every long-lived key is held by the Conclave key service under its own account, so nothing you run can read one. It does not separate two live agents of your own user, and the service still lets a process of yours use a key for the hub calls the connector makes. An administrator can switch this off with <b>conclave uninstall-service</b>; the keys come back to your own encrypted key file, none is lost.</p>';
  else h += '<p>Agents on this PC get a short-lived token for each turn and never open a long-lived key. The key file is encrypted. This protects against a key leaking into a transcript, a log, a backup or a paste. It does not stop a determined agent running as you: any process of your own user can ask the same key store. An administrator can add the hardened level for that.</p><p class="muted">Hardened isolation is optional and needs an administrator once: <b>conclave install-service</b>. Standard stays the default.</p>';
  if (st && !hard) h += `<p class="muted">${esc(STORE_LINES[st])}</p>`;
  return h;
}

function wakeLabels(home) {
  try { return [...new Set(allBindings(home).map((b) => b.agent))]; } catch { return []; /* no registry yet */ }
}
/** The wake, turned on per agent with its isolation level beside it. Agent messages never wake by default (an agent's text is not trusted). */
function wakeBody(home) {
  const labels = wakeLabels(home), s = wakeSettings(home), level = isHardened(home) ? 'Hardened' : 'Standard';
  let h = '<p class="muted">When the hub has work for an agent, the connector can start a turn for it in its folder, one fresh session for each task. A woken turn has the permissions of its own folder: a tool that needs your approval ends the turn, and the console says so. It never holds a long-lived key.</p>';
  if (!labels.length) h += '<p class="muted">No agent folder is registered on this PC yet.</p>';
  for (const l of labels) h += `<div class="row between"><span><b>${hub(l)}</b> <span class="muted">· ${level} isolation · wake ${s.agents[l] ? 'on' : 'off'}</span></span>${form('/wake-set', { label: l, on: s.agents[l] ? '0' : '1' }, s.agents[l] ? 'Turn off' : 'Turn on', s.agents[l] ? '' : 'pri')}</div>`;
  return h + `<div class="row between"><span>Wake an agent when another agent writes to it <span class="muted">· ${s.agent_messages ? 'on' : 'off (default)'}</span>. An agent's message is not trusted text, so this stays off unless you want it.</span>${form('/wake-messages', { on: s.agent_messages ? '0' : '1' }, s.agent_messages ? 'Turn off' : 'Turn on')}</div>`;
}

const connectorRunning = (home) => { try { const w = JSON.parse(readFileSync(workerLockPath(home), 'utf8')); return Number.isSafeInteger(w?.pid) && alive(w.pid); } catch { return false; } };

/** Status line: version and running state, each hub (connected or not), the isolation level; and the idle close on the right. */
export function statusHtml(home, hubs, reach, idleMs) {
  const run = connectorRunning(home);
  const parts = [`<span><b>${esc(CONNECTOR_VERSION)}</b> ${chip(run ? 'running' : 'not running', run ? 'ok' : 'warn')}</span>`];
  for (const [k, s] of hubs) parts.push(`<span>${hub(s.origin)} ${chip(reach.get(k) === false ? 'not reached' : 'connected', reach.get(k) === false ? 'warn' : 'ok')}</span>`);
  parts.push(`<span class="muted">${isHardened(home) ? 'Hardened' : 'Standard'} isolation</span>`);
  return `<div class="card status"><div class="l">${parts.join('')}</div><span class="muted">Closes after ${esc(idleMs >= 3_600_000 ? `${Math.round(idleMs / 3_600_000)} h` : `${Math.round(idleMs / 60_000)} min`)} idle</span></div>`;
}

/**
 * "Needs you": every folder allow and key pickup that waits, with Deny and Allow on each row; the rows just denied (kept ten minutes)
 * below, still allowable. There is no Allow all: a pickup is never allowed in bulk, and each chat is allowed by its own click.
 */
export function needsHtml(p, origins, now = Date.now()) {
  const multi = new Set(origins.values()).size > 1;
  const hubOf = (id) => (multi && origins.get(id) ? ` <span class="muted">on</span> ${hub(origins.get(id))}` : '');
  const folderRow = (f, denied) => `<div class="need"><div class="row between"><span><b>${hub(f.agent)}</b> ${chip(f.program === 'codex' ? 'codex' : 'claude')}<span class="muted"> ${esc(denied ? `denied ${ago(f.denied_at, now)}` : `asked ${ago(f.at, now)}`)}</span>${hubOf(f.hub_id)}</span><span class="row">${denied ? '' : form('/deny-folder', { key: f.key }, 'Deny')}${form('/allow-folder', { key: f.key }, 'Allow', 'pri')}</span></div><code class="path">${esc(f.folder)}</code>${f.config_changed ? '<div class="alert">The agent settings of this folder changed since it was registered. Allow it only if you made that change.</div>' : ''}</div>`;
  const pickupFolders = (k) => (k.folders?.length ? `<p class="muted">Allowing this also allows the first chat in ${k.folders.length === 1 ? 'this folder' : 'these folders'}, which the connector builds now:</p><ul class="paths">${k.folders.map((f) => `<li>${hub(f.agent)} <code class="path">${esc(f.path)}</code></li>`).join('')}</ul>` : '');
  const pickupRow = (k, denied) => `<div class="need"><div class="row between"><span>Pick up keys from the hub${hubOf(k.hub_key)}. In the hub's words: <q>${hub(k.what ?? 'keys')}</q>. The click covers this one handover.<span class="muted"> ${esc(denied ? `denied ${ago(k.denied_at, now)}` : `asked ${ago(k.at, now)}`)}</span></span><span class="row">${denied ? '' : form('/deny-pickup', { key: k.key }, 'Deny')}${form('/allow-pickup', { key: k.key }, 'Allow', 'pri')}</span></div>${pickupFolders(k)}</div>`;
  let h = '';
  const waitingN = p.folders.length + p.pickups.length;
  if (waitingN) {
    h += `<div class="card needs"><h2>Needs you · ${waitingN}</h2>${p.folders.map((f) => folderRow(f, false)).join('')}${p.pickups.map((k) => pickupRow(k, false)).join('')}<p class="muted">Allow only chats you opened yourself. Deny tells the chat it was not allowed.</p></div>`;
  }
  if (p.denied.length) {
    h += `<div class="card"><h2>Denied · ${p.denied.length} <span class="muted">(remembered for 10 minutes; you can still allow)</span></h2>${p.denied.map((d) => (d.kind === 'pickup' ? pickupRow(d, true) : folderRow(d, true))).join('')}</div>`;
  }
  return h;
}

/** One team card: the name, counts and hub; expanded, its agents, deliveries and restore notes. */
async function teamHtml(home, hubKey, section, { win, claudeJson }, open, wake, level) {
  let rows;
  try { rows = await agentRows(home, hubKey, { win }); } catch (e) { return { html: `<div class="card"><h2>${hub(section.origin)}</h2><p class="bad">${esc(oneLine(e.message))}</p></div>`, reachable: false }; }
  const req = rows.request, c = teamCounts(rows.agents);
  const counts = `<span class="counts row">${c.ready ? chip(`${c.ready} ready`, 'ok') : ''}${c.waiting ? chip(`${c.waiting} waiting`, 'warn') : ''}${c.error ? chip(`${c.error} error`, 'bad') : ''}</span>`;
  const text = `<span class="muted">${c.ready} ready, ${c.waiting} waiting, ${c.error} with an error</span>`;
  let h = `<div class="card"><details class="team"${open ? ' open' : ''}><summary><b>${hub(req?.team_name ?? 'Your team')}</b>${counts}<span class="muted">${hub(section.origin)}</span></summary><div class="panel">${text}`;
  if (rows.git.state === 'offer') h += `<div class="msg">${esc(GIT_OFFER)} ${form('/git', { hub: hubKey }, 'Install private git', 'pri')}</div>`;
  else if (rows.git.state === 'missing') h += `<div class="msg">${esc(rows.git.line)}</div>`;
  if (rows.git.codex) h += `<div class="msg">${esc(rows.git.codex)}</div>`;
  if (!req) h += '<p>Paired. Ask your coding agent to set up the team with the prompt from the console; it files the request with <code>conclave setup request</code>.</p>';
  else if (req.state === 'submitted') h += '<p>Waiting for your administrator to approve the team request. You can close this window; Continue setup picks up from here.</p>';
  else if (req.state === 'needs_changes') h += '<p>Your administrator asked for changes. Ask your coding agent to amend the request.</p>';
  for (const a of rows.agents) h += agentHtml(hubKey, a, wake.agents[a.label], level);
  h += deliveredHtml(home, hubKey);
  h += restoreNotes(home, hubKey, { claudeJson, win });
  if (pending(home, section.hub_id)) h += `<p class="row">${form('/continue', { hub: hubKey }, 'Continue setup', 'pri')}</p>`;
  return { html: h + '</div></details></div>', reachable: rows.reachable !== false, busy: rows.agents.some((a) => a.state !== 'connected' && a.state !== 'failed') };
}

/** The settings: one line each, opened on click. */
function settingsHtml(home, hubs, firstHubKey) {
  const labels = wakeLabels(home), w = wakeSettings(home), on = labels.filter((l) => w.agents[l]).length;
  const hard = isHardened(home), st = storeName(home), ps = listProfiles(home), dests = listDestinations(home);
  const set = (name, sum, body) => `<details class="set"><summary><b>${esc(name)}</b><span class="sum">${sum}</span></summary><div class="panel">${body}</div></details>`;
  return `<div class="card">${set('Wake', `${on} of ${labels.length} agent${labels.length === 1 ? '' : 's'} on · agent messages ${w.agent_messages ? 'on' : 'off'}`, wakeBody(home))}${set('Isolation', esc(`${hard ? 'Hardened' : 'Standard'}${st && !hard ? ` · ${st}` : ''}`), isolationBody(home))}${set('Account profiles', esc(`${ps.length} profile${ps.length === 1 ? '' : 's'}`), profilesBody(home, hubs))}${set('Restore folders', esc(`${dests.length} approved`), restoreFoldersBody(home, firstHubKey))}${set('Pair with another hub', 'opens the pairing form', '<p><a href="/?pair">Pair with another hub</a></p>')}</div>`;
}

/**
 * Starts the screen. Returns `{url, port, close, closed}`: `url` carries the one-time token (open it once, in the
 * user's browser). `io` = {pair, advance, retry, installGit, reveal, now} for tests.
 */
export function startScreen(home, { port = 0, idleMs = IDLE_MS, claudeJson, win = WIN, io = {} } = {}) {
  const doPair = io.pair ?? pair, doAdvance = io.advance ?? advance, doRetry = io.retry ?? retryAgent, doGit = io.installGit ?? installPrivateGit;
  const reveal = io.reveal ?? ((dir) => { try { spawn(win ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open', [dir], { detached: true, stdio: 'ignore' }).unref(); } catch { /* the folder is on the screen to copy */ } });
  let token = randomBytes(24).toString('base64url');
  const session = randomBytes(24).toString('base64url');
  let flash = null, idle, resolveClosed;
  const closed = new Promise((r) => { resolveClosed = r; });
  const server = http.createServer((req, res) => handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' }); res.end('Something went wrong on this screen.'); }));
  const touch = () => { clearTimeout(idle); idle = setTimeout(() => close(), idleMs); idle.unref?.(); };
  const close = () => { clearTimeout(idle); server.close(() => resolveClosed()); server.closeAllConnections?.(); };
  const addr = () => server.address().port;
  const hosts = () => [`127.0.0.1:${addr()}`, `localhost:${addr()}`];
  const send = (res, status, html, extra = {}) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'same-origin',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'", ...extra }); res.end(html); };
  const back = (res, msg) => { flash = msg ?? null; res.writeHead(303, { location: '/', 'cache-control': 'no-store' }); res.end(); };
  const body = (req) => new Promise((ok, no) => { let s = ''; req.setEncoding('utf8'); req.on('data', (c) => { s += c; if (s.length > 16_384) { req.destroy(); no(new Error('too large')); } }); req.on('end', () => ok(new URLSearchParams(s))); req.on('error', no); });
  const sections = () => { const kf = readKeyFile(home); return kf.ok ? Object.entries(kf.data.hubs) : []; };
  const opts = { claudeJson, win };

  async function handle(req, res) {
    if (!hosts().includes(String(req.headers.host ?? ''))) return send(res, 421, page('Refused', '<p>This screen answers only on this PC\'s own address.</p>'));
    const u = new URL(req.url, `http://${req.headers.host}`);
    const cookie = /(?:^|;\s*)conclave_screen=([A-Za-z0-9_-]+)/.exec(String(req.headers.cookie ?? ''))?.[1];
    if (req.method === 'GET' && u.pathname === '/' && u.searchParams.has('t')) {
      if (!token || !same(u.searchParams.get('t'), token)) return send(res, 403, page('Refused', '<p>This link was already used. Run <code>conclave setup</code> again for a new one.</p>'));
      token = null; touch();
      res.writeHead(303, { location: '/', 'set-cookie': `conclave_screen=${session}; HttpOnly; SameSite=Strict; Path=/`, 'cache-control': 'no-store' });
      return res.end();
    }
    if (!cookie || !same(cookie, session)) return send(res, 403, page('Refused', '<p>Open this screen from the link <code>conclave setup</code> gives you.</p>'));
    // A form is taken only from this screen: its own Origin, or (a page still open under the old no-referrer policy sends
    // `Origin: null`) a null Origin that the browser itself marks as same-origin. A missing Origin is refused.
    if (req.method === 'POST' && !sentFromScreen(req.headers, hosts())) return send(res, 403, page('Refused', '<p>This form must be sent from this screen.</p>'));
    if (!(req.method === 'GET' && u.searchParams.has('r'))) touch(); // the page's own refresh does not keep the screen open
    if (req.method === 'GET' && u.pathname === '/') {
      const msg = flash; flash = null;
      const hubs = sections();
      if (!hubs.length || u.searchParams.has('pair') || msg?.pairForm) return send(res, 200, page('Pair with Conclave', pairForm(msg, msg?.keep ?? {})));
      const wake = wakeSettings(home), level = isHardened(home) ? 'Hardened' : 'Standard', origins = new Map(hubs.map(([k, s]) => [s.hub_id, s.origin]).concat(hubs.map(([k, s]) => [k, s.origin])));
      const teams = [], reach = new Map(), busyTeams = [];
      let i = 0;
      for (const [k, s] of hubs) { const t = await teamHtml(home, k, s, opts, i++ === 0, wake, level); teams.push(t.html); reach.set(k, t.reachable); busyTeams.push(t.busy); }
      let html = `<h1>Conclave on this PC</h1>${msg ? `<div class="msg ${msg.bad ? 'bad' : ''}">${esc(msg.text)}</div>` : ''}`;
      html += statusHtml(home, hubs, reach, idleMs);
      html += needsHtml(pendingList(home), origins);
      html += teams.join('');
      html += settingsHtml(home, hubs, hubs[0]?.[0]);
      const p = pendingList(home);
      const busy = p.folders.length > 0 || p.pickups.length > 0 || busyTeams.some(Boolean);
      return send(res, 200, page('Conclave setup', html, { refresh: busy && !msg ? 5 : 0 }), {});
    }
    if (req.method !== 'POST') return send(res, 404, page('Not found', '<p>Nothing here.</p>'));
    const f = await body(req);
    const hubKey = f.get('hub');
    if (u.pathname === '/pair') {
      const r = await doPair(home, { origin: f.get('origin'), check: f.get('check'), code: f.get('code') }, { confirmChange: f.get('confirm') === '1' });
      if (!r.ok) return back(res, { bad: true, text: PAIR_LINES[r.reason] ?? PAIR_LINES.hub_unreachable, pairForm: true, keep: { origin: f.get('origin') ?? '', check: f.get('check') ?? '', confirm: r.reason === 'ca_changed' || r.reason === 'origin_changed' } });
      return back(res, { text: `${PAIR_LINES.paired} This PC is ${r.pc.name || 'paired'}.` });
    }
    if (u.pathname === '/profile-add') { const r = addProfile(home, f.get('name'), { kind: f.get('kind'), dir: String(f.get('dir') ?? '').trim() }); return back(res, r.ok ? { text: `${r.profile.name} added. Log in to it once yourself, then bind an agent to it.` } : { bad: true, text: PROFILE_LINES[r.reason] ?? 'That profile cannot be added.' }); }
    if (u.pathname === '/profile-hide') return back(res, setHidden(home, String(f.get('name')), f.get('hidden') === '1') ? { text: f.get('hidden') === '1' ? 'The hub is no longer told the name of this profile.' : 'The hub may see the name of this profile.' } : { bad: true, text: PROFILE_LINES.no_such_profile });
    if (u.pathname === '/profile-remove') return back(res, removeProfile(home, String(f.get('name'))) ? { text: 'Profile removed. Its folder was left as it is.' } : { bad: true, text: PROFILE_LINES.no_such_profile });
    if (u.pathname === '/profile-bind-team') {
      const r = bindRegisteredTeam(home, String(f.get('team') ?? ''), f.get('profile') ? String(f.get('profile')) : null, { win });
      if (!r.ok) return back(res, { bad: true, text: PROFILE_LINES[`${r.reason}_team`] ?? PROFILE_LINES[r.reason] ?? 'Could not bind the team.' });
      if (!r.profile) return back(res, { text: `${r.team} is back on the default account, except agents bound on their own.` });
      return back(res, { text: `${r.team}: ${r.folders} agent${r.folders === 1 ? '' : 's'} bound to ${r.profile}.${r.skipped ? ` ${r.skipped} run the other program and keep their account.` : ''}` });
    }
    if (u.pathname === '/profile-bind') { const r = bindAgent(home, String(f.get('folder')), f.get('profile') ? String(f.get('profile')) : null, { win }); return back(res, r.ok ? { text: r.profile ? `Bound to ${r.profile}.` : 'Back to the default account.' } : { bad: true, text: PROFILE_LINES[r.reason] ?? 'Could not bind.' }); }
    if (u.pathname === '/deny-folder') return back(res, denyFolder(home, String(f.get('key'))) ? { text: 'Denied. The chat is told it was not allowed, and you can still allow it for the next 10 minutes.' } : { bad: true, text: 'That folder is not waiting any more.' });
    if (u.pathname === '/deny-pickup') return back(res, denyPickup(home, String(f.get('key'))) ? { text: 'Denied. The hub is told the key pickup was declined on this PC.' } : { bad: true, text: 'That pickup is not waiting any more.' });
    if (u.pathname === '/allow-folder') return back(res, allowFolder(home, String(f.get('key'))) ? { text: 'Allowed. That chat can now work as its agent.' } : { bad: true, text: 'That folder is not waiting any more.' });
    if (u.pathname === '/wake-set') {
      const l = String(f.get('label') ?? '');
      let known = false; try { known = allBindings(home).some((b) => b.agent === l); } catch { /* none */ }
      if (!known) return back(res, { bad: true, text: 'That agent is not registered on this PC.' });
      setWake(home, l, f.get('on') === '1');
      return back(res, { text: f.get('on') === '1' ? `Wake is on for ${l}.` : `Wake is off for ${l}.` });
    }
    if (u.pathname === '/wake-messages') { setAgentMessages(home, f.get('on') === '1'); return back(res, { text: f.get('on') === '1' ? 'Agent messages can now wake an agent.' : 'Agent messages no longer wake an agent.' }); }
    if (u.pathname === '/allow-pickup') return back(res, approvePickup(home, String(f.get('key'))) ? { text: 'Allowed. The key pickup carries on.' } : { bad: true, text: 'That pickup is not waiting any more.' });
    if (!hubKey || !sections().some(([k]) => k === hubKey)) return back(res, { bad: true, text: 'That hub is not paired on this PC.' });
    if (u.pathname === '/continue') {
      try {
        const r = await doAdvance(home, hubKey, opts);
        return back(res, { text: r.phase === 'waiting' ? (r.pickup_click ? 'Waiting for you to allow the key pickup above.' : 'Still waiting for approval.') : r.phase === 'set_up' ? (r.failed.length ? `${r.failed.length} agent(s) could not be set up; see Retry.` : 'Every agent is set up.') : r.phase === 'changes' ? `Changes asked: ${r.note ?? ''}` : r.phase === 'closed' ? `The request was ${r.state}.` : 'No team request yet.' });
      } catch (e) { return back(res, { bad: true, text: oneLine(e.message) }); }
    }
    if (u.pathname === '/retry') { const r = doRetry(home, hubKey, f.get('label'), opts); return back(res, r.ok ? { text: `${f.get('label')} is set up.` } : { bad: true, text: r.error }); }
    if (u.pathname === '/open') {
      const rows = await agentRows(home, hubKey, { win }).catch(() => null);
      const a = rows?.agents.find((x) => x.label === f.get('label'));
      if (!a?.open) return back(res, { bad: true, text: 'That agent is not ready to open yet.' });
      reveal(a.open.desktop.folder);
      return back(res, { text: `${a.open.desktop.line} The folder is open in a window.` });
    }
    if (u.pathname === '/destination-add') { const r = addDestination(home, String(f.get('path') ?? '').trim(), f.get('label') ?? undefined); return back(res, r.ok ? { text: `${r.destination.label} is approved for a restored team.` } : { bad: true, text: `That folder cannot be used: ${r.reason}.` }); }
    if (u.pathname === '/destination-remove') return back(res, removeDestination(home, String(f.get('id'))) ? { text: 'Removed. A restore to it is refused from now on.' } : { bad: true, text: 'No such folder.' });
    if (u.pathname === '/restore-approve') { const r = await approveFolder(home, hubKey, String(f.get('checkout')), String(f.get('folder')), opts); return back(res, r.ok ? { text: 'Approved. The restore carries on at the next check-in.' } : { bad: true, text: 'That folder is not waiting for approval.' }); }
    if (u.pathname === '/git') {
      const r = await doGit(home, { claudeJson });
      return back(res, r.ok ? { text: r.bashVar === 'set' ? 'Private git installed. If Claude Desktop was open, close it and open it again once so it finds git.' : 'Private git installed.' } : { bad: true, text: r.reason === 'hash_mismatch' ? 'The downloaded file is not the pinned MinGit, so it was deleted and nothing was installed.' : 'Git could not be installed; check the network and try again.' });
    }
    return send(res, 404, page('Not found', '<p>Nothing here.</p>'));
  }

  return new Promise((ok, no) => {
    server.on('error', no);
    server.listen(port, '127.0.0.1', () => { touch(); ok({ url: `http://127.0.0.1:${addr()}/?t=${token}`, port: addr(), close, closed, server }); });
  });
}

/** Opens a URL in the user's browser, without a shell. */
/** Whether a program is on the PATH (a headless PC has no xdg-open). */
const onPath = (name) => (process.env.PATH ?? '').split(delimiter).some((d) => d && existsSync(join(d, name)));

export function openBrowser(url, win = WIN) {
  try {
    if (!win && process.platform !== 'darwin' && !onPath('xdg-open')) return false;
    const [cmd, args] = win ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => { /* no browser on this machine (a headless PC): the link is printed instead */ });
    child.unref();
    return true;
  } catch { return false; }
}
