// The connector screen (docs/connector.md, "The connector's screen"): a status line, a Needs you card with Deny and Allow (never
// "Allow all"), what was denied kept for ten minutes, one card per team, the settings as one-line summaries; hub text escaped
// and marked. Deny: a fixed line to the chat, a Denied row that can still be allowed, a declined pickup. Temporary homes only.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testCa } from '../../server/test/test-ca.mjs';
import { putHub, putAgentKey, caFingerprint } from './connector/keyfile.mjs';
import { pendingList, requestFolder, requestPickup, approveFolder, approvePickup, denyFolder, denyPickup, folderDenied, pickupDenied, folderApproved, pickupApproved, unreportedDenials, markDenialsReported, pruneDenied, DENY_MS, allowWithPickup, unauditedPickupAllowed, markPickupAudited, revokeFolder } from './connector/approvals.mjs';
import { bindFolder, resolveFolder } from './connector/registry.mjs';
import { startBroker, askBroker } from './connector/broker.mjs';
import { line as reasonLine, REASONS } from './connector/reasons.mjs';
import { startScreen, ago, teamCounts, needsHtml, statusHtml } from './connector/screen.mjs';
import { canonicalFolder, folderIdentity } from './connector/paths.mjs';
import { writeMarker } from './connector/isolation.mjs';

process.env.CONCLAVE_KEY_STORE = 'file';
const tmp = [];
const mk = () => { const d = mkdtempSync(join(tmpdir(), 'cn-scr-')); tmp.push(d); return d; };
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
const pki = testCa('Screen CA');
const keys = (home, hubId = 'hub-scr', origin = 'https://127.0.0.1:9') => { const k = putHub(home, { hubId, origin, caPem: pki.caPem, appKey: 'ah_app_FAKEappKEYforSCREENtests0001' }); putAgentKey(home, k, 'dev-1', 'ah_ses_FAKEsessionKEYforSCREEN00001'); return k; };
const folderOf = (home, name = 'agent') => { const f = join(home, name); mkdirSync(f, { recursive: true }); return canonicalFolder(f); };
const bind = (c, over = {}) => ({ agent: 'dev-1', hub_id: 'hub-scr', identity: folderIdentity(c), ...over });
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

describe('what a request records', () => {
  test('program, time and the registered settings hash are stored, and a changed folder is flagged', () => {
    const home = mk(), c = folderOf(home);
    writeFileSync(join(c, 'CLAUDE.md'), 'a');
    requestFolder(home, c, bind(c, { config_sha256: 'a'.repeat(64) }));
    const [f] = pendingList(home).folders;
    assert.equal(f.program, 'claude'); assert.ok(Math.abs(Date.now() - f.at) < 5000); assert.equal(f.agent, 'dev-1'); assert.equal(f.folder, c);
    assert.equal(f.config_changed, true, 'the hash on disk now is not the registered one');
    const home2 = mk(), c2 = folderOf(home2);
    requestFolder(home2, c2, bind(c2, { provider: 'codex' }));
    assert.deepEqual(pendingList(home2).folders.map((x) => [x.program, x.config_changed]), [['codex', false]], 'no recorded hash is not a warning');
    const home3 = mk(), c3 = folderOf(home3);
    requestFolder(home3, c3, bind(c3, { config_sha256: 'held' }));
    assert.equal(pendingList(home3).folders[0].config_changed, true, 'held settings are flagged');
  });
  test('the first time of a request is kept when it asks again', () => {
    const home = mk(), c = folderOf(home);
    requestFolder(home, c, bind(c));
    const at = pendingList(home).folders[0].at;
    requestFolder(home, c, bind(c));
    assert.equal(pendingList(home).folders[0].at, at);
  });
  test('"ago" is a short plain phrase', () => {
    const now = 1_000_000_000;
    assert.equal(ago(now - 5_000, now), 'just now'); assert.equal(ago(now - 180_000, now), '3 min ago');
    assert.equal(ago(now - 2 * 3600_000, now), '2 h ago'); assert.equal(ago(now - 90_000_000, now), '1 d ago'); assert.equal(ago(0, now), '');
  });
});

describe('Deny', () => {
  test('a denied folder leaves the waiting list, is remembered for ten minutes, and can still be allowed', () => {
    const home = mk(), c = folderOf(home);
    requestFolder(home, c, bind(c));
    const key = pendingList(home).folders[0].key;
    assert.equal(denyFolder(home, key), true);
    const p = pendingList(home);
    assert.equal(p.folders.length, 0); assert.equal(p.denied.length, 1);
    assert.deepEqual([p.denied[0].kind, p.denied[0].agent, p.denied[0].program], ['folder', 'dev-1', 'claude']);
    assert.equal(folderDenied(home, c), true);
    assert.equal(folderDenied(home, c, Date.now() + DENY_MS + 1000), false, 'forgotten after ten minutes');
    assert.equal(pendingList(home, Date.now() + DENY_MS + 1000).denied.length, 0);
    assert.equal(folderApproved(home, c, bind(c)), false, 'a deny allows nothing');
    assert.equal(denyFolder(home, key), false, 'not waiting any more');
    assert.equal(approveFolder(home, key), true, 'allowed from the Denied row');
    assert.equal(folderApproved(home, c, bind(c)), true);
    assert.equal(folderDenied(home, c), false);
    assert.equal(pendingList(home).denied.length, 0);
  });
  test('a denied pickup is not made, is told as declined, and can still be allowed', () => {
    const home = mk();
    requestPickup(home, 'hub-scr@ca', 'obr_1', 'session keys for the Atlas team');
    const key = pendingList(home).pickups[0].key;
    assert.equal(denyPickup(home, key), true);
    assert.equal(pickupDenied(home, 'hub-scr@ca', 'obr_1'), true);
    assert.equal(pickupApproved(home, 'hub-scr@ca', 'obr_1'), false);
    assert.deepEqual(pendingList(home).denied.map((d) => [d.kind, d.what]), [['pickup', 'session keys for the Atlas team']]);
    assert.equal(approvePickup(home, key), true);
    assert.equal(pickupApproved(home, 'hub-scr@ca', 'obr_1'), true);
  });
  test('each denial is reported to the hub once, and kept until the hub takes it', () => {
    const home = mk(), c = folderOf(home);
    requestFolder(home, c, bind(c)); requestPickup(home, 'hub-scr@ca', 'obr_2', 'keys');
    denyFolder(home, pendingList(home).folders[0].key); denyPickup(home, pendingList(home).pickups[0].key);
    const todo = unreportedDenials(home);
    assert.deepEqual(todo.map((d) => d.kind).sort(), ['folder', 'pickup']);
    assert.deepEqual(todo.find((d) => d.kind === 'folder'), { id: todo.find((d) => d.kind === 'folder').id, kind: 'folder', agent: 'dev-1', hub_id: 'hub-scr' });
    markDenialsReported(home, [todo[0].id]);
    assert.equal(unreportedDenials(home).length, 1);
    markDenialsReported(home, todo.map((d) => d.id));
    assert.equal(unreportedDenials(home).length, 0);
    pruneDenied(home, Date.now() + DENY_MS + 1000);
    assert.equal(pendingList(home, Date.now() - 1).denied.length, 0);
  });
  test('the chat gets the fixed line, and a denied folder is not put back on the screen while the deny lasts', async () => {
    const home = mk();
    keys(home);
    const c = folderOf(home);
    bindFolder(home, c, { hubId: 'hub-scr', caSha256: caFingerprint(pki.caPem), agent: 'dev-1' });
    const b = await startBroker({ home, deps: { renewMs: 3_600_000 } });
    try {
      const ask = () => askBroker(home, { op: 'turn', folder: c, pid: process.pid }, { address: b.address });
      const first = await ask();
      assert.deepEqual([first.ok, first.reason], [false, 'needs_click']);
      assert.equal(pendingList(home).folders.length, 1);
      denyFolder(home, pendingList(home).folders[0].key);
      const again = await ask();
      assert.deepEqual([again.ok, again.reason], [false, 'denied']);
      assert.equal(pendingList(home).folders.length, 0, 'not asked about again');
      assert.equal(pendingList(home).denied.length, 1);
    } finally { await b.close(); }
    assert.equal(reasonLine('denied'), 'This chat was not allowed on this PC. If you opened it, ask the PC user to allow it on the connector screen.');
    assert.ok(REASONS.denied && !/\bRun:/.test(reasonLine('denied')));
    assert.match(reasonLine('needs_click'), /Run: conclave setup/);
  });
  test('the registered settings of a folder travel with the request the broker records', async () => {
    const home = mk();
    keys(home);
    const c = folderOf(home);
    bindFolder(home, c, { hubId: 'hub-scr', caSha256: caFingerprint(pki.caPem), agent: 'dev-1', provider: 'codex' });
    const b = await startBroker({ home, deps: { renewMs: 3_600_000 } });
    try {
      await askBroker(home, { op: 'turn', folder: c, pid: process.pid }, { address: b.address });
      const [f] = pendingList(home).folders;
      assert.equal(f.program, 'codex');
      assert.equal(resolveFolder(home, c).binding.config_sha256.length > 8, true);
      assert.equal(f.config_changed, false);
    } finally { await b.close(); }
  });
});

describe('the screen', () => {
  async function open(home, o = {}) {
    const s = await startScreen(home, { win: false, io: { reveal() {} }, ...o });
    const first = await fetch(s.url, { redirect: 'manual' });
    const cookie = first.headers.get('set-cookie').split(';')[0];
    const base = `http://127.0.0.1:${s.port}`;
    const get = async () => (await fetch(base + '/', { headers: { cookie } })).text();
    const post = (path, body, h = {}) => fetch(base + path, { method: 'POST', redirect: 'manual', headers: { cookie, origin: base, 'content-type': 'application/x-www-form-urlencoded', ...h }, body: new URLSearchParams(body) });
    return { s, get, post, base, cookie };
  }
  test('top to bottom: the status line, Needs you, the teams, the settings; nothing to allow means no Needs you card', async () => {
    const home = mk();
    keys(home);
    const { s, get } = await open(home);
    try {
      const page = await get();
      const at = (re) => page.search(re);
      assert.ok(at(/class="card status"/) > 0 && at(/class="card status"/) < at(/class="team"|details class="team"/), 'status, then teams');
      assert.ok(at(/details class="team"/) < at(/details class="set"/), 'teams, then settings');
      assert.match(page, /0\.9\.\d/); assert.match(page, /Closes after 1 h idle/); assert.match(page, /Standard isolation/);
      assert.doesNotMatch(page, /Needs you/, 'only when something waits');
      for (const name of ['Wake', 'Isolation', 'Account profiles', 'Restore folders', 'Pair with another hub']) assert.ok(page.includes(`<b>${name}</b>`), name);
      assert.doesNotMatch(page, /Allow all/i);
    } finally { s.close(); await s.closed; }
  });
  test('the status line says the level the PC is at: Standard, and Hardened once the marker is written', () => {
    const home = mk();
    assert.match(statusHtml(home, [], new Map(), 3_600_000), /Standard isolation/);
    writeMarker(home, { address: 'pipe-or-socket', view: 'view', vault: null });
    const html = statusHtml(home, [], new Map(), 3_600_000);
    assert.match(html, /Hardened isolation/);
    assert.doesNotMatch(html, /Standard/);
  });
  test('Needs you: each row has the full path, the program, how long ago, Deny and Allow; there is no Allow all', async () => {
    const home = mk();
    keys(home);
    const c = folderOf(home, 'a-rather-long-folder-name');
    requestFolder(home, c, bind(c, { provider: 'codex' }));
    requestPickup(home, 'hub-scr@ca', 'obr_5', 'session keys for the Atlas team');
    const { s, get, post } = await open(home);
    try {
      const page = await get();
      assert.match(page, /Needs you · 2/);
      assert.ok(page.includes(esc(c)), 'full path on the row');
      assert.match(page, /class="chip ">codex</); assert.match(page, /asked just now/);
      assert.equal((page.match(/action="\/deny-folder"/g) ?? []).length, 1); assert.equal((page.match(/action="\/allow-folder"/g) ?? []).length, 1);
      assert.equal((page.match(/action="\/deny-pickup"/g) ?? []).length, 1); assert.equal((page.match(/action="\/allow-pickup"/g) ?? []).length, 1);
      assert.match(page, /Allow only chats you opened yourself/);
      assert.doesNotMatch(page, /Allow all/i);
      assert.doesNotMatch(page, /action="\/allow-all|action="\/allow-pickups|Allow [0-9]+ /);
      // Deny a folder: it moves to Denied and can still be allowed.
      assert.equal((await post('/deny-folder', { key: pendingList(home).folders[0].key })).status, 303);
      let after = await get();
      assert.match(after, /Denied · 1/); assert.match(after, /denied just now/); assert.match(after, /Needs you · 1/);
      assert.equal((after.match(/action="\/deny-folder"/g) ?? []).length, 0, 'a denied row has no Deny');
      assert.equal((after.match(/action="\/allow-folder"/g) ?? []).length, 1, 'but can still be allowed');
      assert.equal((await post('/deny-pickup', { key: pendingList(home).pickups[0].key })).status, 303);
      after = await get();
      assert.doesNotMatch(after, /Needs you/); assert.match(after, /Denied · 2/);
      assert.equal(unreportedDenials(home).length, 2);
      assert.equal((await post('/allow-folder', { key: pendingList(home).denied.find((d) => d.kind === 'folder').key })).status, 303);
      assert.equal(folderApproved(home, c, bind(c)), true);
    } finally { s.close(); await s.closed; }
  });
  test('a folder whose settings changed shows a warning on its row', async () => {
    const home = mk();
    keys(home);
    const c = folderOf(home);
    writeFileSync(join(c, 'CLAUDE.md'), 'now');
    requestFolder(home, c, bind(c, { config_sha256: 'b'.repeat(64) }));
    const { s, get } = await open(home);
    try { assert.match(await get(), /settings of this folder changed since it was registered/); } finally { s.close(); await s.closed; }
  });
  test('with more than one hub, each row names its hub; with one it does not', () => {
    const p = { folders: [{ key: 'k', folder: '/x/y', agent: 'dev-1', hub_id: 'h1', program: 'claude', at: Date.now(), config_changed: false }], pickups: [], denied: [] };
    assert.doesNotMatch(needsHtml(p, new Map([['h1', 'https://one.example']])), /one\.example/);
    const two = needsHtml(p, new Map([['h1', 'https://one.example'], ['h2', 'https://two.example']]));
    assert.match(two, /one\.example/); assert.doesNotMatch(two, /two\.example/);
  });
  test('text from the hub is escaped and marked', () => {
    const evil = '<img src=x onerror=alert(1)>"\'';
    const html = needsHtml({ folders: [{ key: 'k', folder: '/x', agent: evil, hub_id: 'h', program: 'claude', at: Date.now(), config_changed: false }], pickups: [{ key: 'p', hub_key: 'h', request: 'r', what: evil, at: Date.now() }], denied: [] }, new Map());
    assert.ok(!html.includes('<img'), 'nothing from the hub is markup');
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
    assert.match(html, /class="hub" title="Text from the hub"/);
  });
  test('the counts of a team are ready, waiting and error', () => {
    assert.deepEqual(teamCounts([{ state: 'connected' }, { state: 'connected' }, { state: 'ready_to_open' }, { state: 'waiting_for_approval' }, { state: 'failed' }]), { ready: 2, waiting: 2, error: 1 });
    assert.deepEqual(teamCounts([]), { ready: 0, waiting: 0, error: 0 });
  });
  test('the first team is open and later ones are collapsed; counts are text when collapsed; chips have 3 px corners; light and dark', async () => {
    const home = mk();
    keys(home); keys(home, 'hub-two', 'https://127.0.0.2:9');
    const { s, get } = await open(home);
    try {
      const page = await get();
      assert.equal((page.match(/<details class="team"/g) ?? []).length, 2);
      assert.equal((page.match(/<details class="team" open>/g) ?? []).length, 1);
      assert.match(page, /\d+ ready, \d+ waiting, \d+ with an error/);
      assert.match(page, /\.chip\{[^}]*border-radius:3px/);
      assert.match(page, /prefers-color-scheme:dark/);
      assert.doesNotMatch(page, /border-left/, 'no left accents');
      assert.doesNotMatch(page, /https?:\/\/(?!127\.0\.0\.[12]|git-scm|hub\.example)[^"' <)]*\.(?:js|css|png|woff2?)/, 'no external assets');
    } finally { s.close(); await s.closed; }
  });
  test('the checks stay: wrong host, no cookie, a wrong origin and a reused link allow and deny nothing; the CSP is kept', async () => {
    const home = mk();
    keys(home);
    const c = folderOf(home);
    requestFolder(home, c, bind(c));
    const { s, post, base, cookie } = await open(home);
    try {
      const key = pendingList(home).folders[0].key;
      assert.equal((await post('/deny-folder', { key }, { origin: 'http://evil.example' })).status, 403);
      assert.equal((await fetch(base + '/deny-folder', { method: 'POST', headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body: `key=${encodeURIComponent(key)}` })).status, 403, 'no cookie');
      assert.equal(await new Promise((ok) => http.get(base + '/', { headers: { cookie, host: 'evil.example' } }, (r) => { r.resume(); ok(r.statusCode); })), 421, 'a wrong host');
      assert.equal(pendingList(home).folders.length, 1, 'nothing changed');
      assert.equal((await fetch(s.url, { redirect: 'manual' })).status, 403, 'the one-time link is spent');
      const r = await fetch(base + '/', { headers: { cookie } });
      assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
      assert.equal(r.headers.get('x-frame-options'), 'DENY');
    } finally { s.close(); await s.closed; }
  });
  test('it still closes after the idle time', async () => {
    const home = mk();
    keys(home);
    const s = await startScreen(home, { win: false, idleMs: 50 });
    await s.closed;
    assert.ok(true);
  });
});

describe('refresh and the browser', () => {
  test('the page reloads itself while something waits, and not otherwise; the reload does not keep the screen open', async () => {
    const home = mk();
    keys(home);
    const s = await startScreen(home, { win: false, io: { reveal() {} }, idleMs: 400 });
    try {
      const cookie = (await fetch(s.url, { redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
      const base = `http://127.0.0.1:${s.port}`;
      const get = async (p = '/') => (await fetch(base + p, { headers: { cookie } })).text();
      assert.doesNotMatch(await get(), /data-refresh/, 'nothing waits');
      const c = folderOf(home);
      requestFolder(home, c, bind(c));
      assert.match(await get(), /document\.activeElement[^<]*i\.value!==i\.defaultValue/, 'it skips while someone is typing');
      assert.match(await get(), /data-refresh="5"[^<]*location\.replace\('\/\?r=1'\)/);
      denyFolder(home, pendingList(home).folders[0].key);
      assert.doesNotMatch(await get(), /data-refresh/, 'a denied row does not need a reload');
      requestFolder(home, folderOf(home, 'b'), bind(c));
      const end = Date.now() + 1500;
      while (Date.now() < end) { await get('/?r=1').catch(() => {}); await new Promise((r) => setTimeout(r, 100)); }
      await s.closed; // reloads alone did not keep it open
    } finally { s.close(); }
  });
  test('without a browser program the link is for the user to open, and nothing throws', async () => {
    const { openBrowser } = await import('./connector/screen.mjs');
    const was = process.env.PATH;
    process.env.PATH = '';
    try { assert.equal(openBrowser('http://127.0.0.1:1/', false), process.platform === 'darwin'); } finally { process.env.PATH = was; }
    await new Promise((r) => setTimeout(r, 50));
  });
});

describe('folders allowed with a pickup', () => {
  const built = (home, name = 'built') => {
    keys(home);
    const c = folderOf(home, name);
    writeFileSync(join(c, 'CLAUDE.md'), 'role');
    bindFolder(home, c, { hubId: 'hub-scr', caSha256: caFingerprint(pki.caPem), agent: 'dev-1' });
    return c;
  };
  const binding = (home, c) => resolveFolder(home, c).binding;
  test('a folder built inside an allowed pickup is allowed for that agent and hub; a change, another agent or an unbound folder is not', () => {
    const home = mk(), c = built(home);
    assert.equal(folderApproved(home, c, binding(home, c)), false, 'nothing yet');
    assert.equal(allowWithPickup(home, c, { agent: 'dev-1', agent_id: 'agt_1', hub_id: 'hub-scr', ref: 'opk_1' }), true);
    assert.equal(folderApproved(home, c, binding(home, c)), true);
    assert.equal(folderApproved(home, c, { ...binding(home, c), agent: 'dev-2' }), false, 'another agent');
    assert.equal(folderApproved(home, c, { ...binding(home, c), hub_id: 'other' }), false, 'another hub');
    writeFileSync(join(c, 'CLAUDE.md'), 'changed after the build');
    assert.equal(folderApproved(home, c, binding(home, c)), false, 'a changed folder waits for a click');
    assert.equal(revokeFolder(home, c), true);
    const other = folderOf(home, 'unbound');
    assert.equal(allowWithPickup(home, other, { agent: 'dev-1', agent_id: 'agt_1', hub_id: 'hub-scr', ref: 'opk_1' }), false, 'a folder the registry does not hold');
    assert.equal(allowWithPickup(home, c, { agent: 'dev-9', agent_id: 'agt_9', hub_id: 'hub-scr', ref: 'opk_1' }), false, 'bound to a different agent');
  });
  test('each is audited once on the hub, under its own name, with the pickup it came with', () => {
    const home = mk(), c = built(home);
    allowWithPickup(home, c, { agent: 'dev-1', agent_id: 'agt_1', hub_id: 'hub-scr', ref: 'opk_7' });
    const todo = unauditedPickupAllowed(home, 'hub-scr');
    assert.deepEqual(todo.map((t) => [t.agent_id, t.ref]), [['agt_1', 'opk_7']]);
    assert.deepEqual(unauditedPickupAllowed(home, 'another-hub'), []);
    markPickupAudited(home, todo.map((t) => t.key));
    assert.deepEqual(unauditedPickupAllowed(home, 'hub-scr'), []);
  });
  test('before the click, the pickup row lists each folder and says the click also allows the first chat there', () => {
    const home = mk();
    requestPickup(home, 'hub-scr@ca', 'obr_9', 'session keys for the Atlas team', [{ agent: 'coordinator', path: '/work/Atlas/coordinator' }, { agent: 'dev-1<b>', path: '/work/Atlas/dev-1' }]);
    const html = needsHtml(pendingList(home), new Map());
    assert.match(html, /Allowing this also allows the first chat in these folders/);
    assert.ok(html.includes('/work/Atlas/coordinator') && html.includes('/work/Atlas/dev-1'));
    assert.ok(html.includes('dev-1&lt;b&gt;') && !html.includes('dev-1<b>'), 'hub names escaped');
    requestPickup(home, 'hub-scr@ca', 'obr_10', 'keys');
    assert.doesNotMatch(needsHtml({ ...pendingList(home), pickups: pendingList(home).pickups.filter((k) => k.request === 'obr_10') }, new Map()), /first chat/);
  });
});
