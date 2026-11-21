/**
 * The Add dialog (docs/onboarding.md#1-one-key-add-pc-and-the-prompt): the header Add button, the More sheet and the command
 * list say just "Add" and open on "What do you want to add?" (a new PC, or a team on a PC that is already connected); the PCs
 * page's Add PC opens straight on the new-PC screen with Back to the choices. The new-PC screen says what it is for and asks
 * only for the PC's name: the agent on the PC asks its user the rest. Add PC and Re-enrol PC show the hub's one prompt and,
 * apart from it, the code, or why there is none. A third choice invites a collaborator's agent. The onboarding prompt tells no one to restart Claude Code or
 * run `claude`. Read from the source files.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const read = (...p: string[]) => readFileSync(join(process.cwd(), '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const js = read('server', 'public', 'app.js');
const fn = (name: string) => { const i = js.indexOf(`function ${name}(`); return js.slice(i, js.indexOf('\n}\n', i) + 3); };

describe('Add button', () => {
  it('is just "Add" in the header, the More sheet and the command list', () => {
    const html = read('server', 'public', 'index.html');
    expect(html).toMatch(/<button class="btn join hide-m" id="joinBtn" aria-label="Add" title="Add: a new PC or a team">[^]*?<\/svg>Add<\/button>/);
    expect(js).toContain("{ label: 'Add', icon: 'plus', fn: () => joinSheet(null) },");
    expect(js).toContain("item('join', 'plus', 'Add', '', '')");
    expect(js).not.toContain("'Add PC', icon");
  });
  it('the PCs page keeps Add PC and opens on the new-PC screen', () => {
    expect(js).toContain("const obAddPc = () => joinSheet(null, 'pc');");
  });
});

describe('Add dialog', () => {
  const sheet = fn('joinSheet');
  it('opens on "What do you want to add?" with a new PC and a team, and no invented agent flow', () => {
    expect(sheet).toContain("function joinSheet(anchor, start = 'choose')");
    expect(sheet).toContain("title: 'What do you want to add?'");
    expect(sheet).toContain('<b>A new PC</b><span>Connect a new PC to Conclave and set up its security and keys. The PC joins with its first team already set up.</span>');
    expect(sheet).toContain("<b>A team</b><span>On a PC that's already connected${known}</span>");
    expect(sheet).toContain("<b>A collaborator's agent</b>");
    expect(sheet).toContain("$('#jnOptInv', sh).onclick = () => { closeSheet(); run(invSheet); };");
    // A team opens the existing New team screen.
    expect(sheet).toContain("$('#jnOptTeam', sh).onclick = () => { closeSheet(); go('tbuild'); };");
  });
  it('lists the active PCs by name, at most four', () => {
    const known = js.slice(js.indexOf('const joinKnown'), js.indexOf('/* Add (header, the More sheet'));
    expect(known).toContain("p.status === 'active'");
    expect(known).toContain('n.slice(0, 4)');
  });
  it('the new-PC screen says what it is for, asks only for the name and has Back until the prompt exists', () => {
    expect(sheet).toContain('Use this to connect a new PC to Conclave and set up its security and keys.');
    expect(sheet).toContain('The agent on the PC asks its user what they need');
    expect(js).not.toMatch(/JN_CLIENTS|jnAgent|joinPrompt|id="jnW"/);
    expect(sheet).toContain("'Connect a new PC'");
    expect(sheet).toContain("back.setAttribute('aria-label', 'Back to the choices')");
    expect(sheet).toContain('back.hidden = v !== \'pc\' || !!made;');
    expect(sheet).toContain('view(start);');
  });
  it('shows the give line, the code apart and the waiting line', () => {
    expect(sheet).toContain('<div id="jnGive">${obGiveH(made)}</div>');
    expect(sheet).toContain('<div id="jnCode">${obCodeH(made)}</div>');
    expect(sheet).toContain("Waiting for <b>${esc(made.pc.name)}</b>. You'll approve its request here.");
    expect(sheet).not.toMatch(/into Claude Code/);
    expect(fn('obPromptSheet')).toContain('${obGiveH(r)}');
    expect(fn('obPromptSheet')).toContain('${obCodeH(r)}');
  });
});

/* Add PC and Re-enrol PC show only the connector prompt (connector_prompt); the legacy setup.mjs prompt is gone from the hub. */
describe('only the connector prompt', () => {
  const sheet = fn('joinSheet'), re = fn('obPromptSheet');
  it('never reads the legacy prompt', () => {
    for (const f of [sheet, re]) expect(f).not.toMatch(/\.prompt\.text|\.prompt\.hashes|prompt\?\.hashes/);
    expect(sheet).toContain('const text = () => made.connector_prompt;');
    expect(re).toContain('data-v="${esc(r.connector_prompt)}"');
    expect(re).toContain('b.dataset.copy = r.connector_prompt;');
  });
  it('says the prompt holds no secret, to send the code directly, that it works once for 30 minutes, and what New code does', () => {
    const give = js.slice(js.indexOf('const obCodeLife = '), js.indexOf('const OB_NO_PROMPT'));
    expect(give).toContain('Give the user of <b>${esc(r.pc.name)}</b> the prompt and the code.');
    expect(give).toContain('They paste the prompt into their agent, which sets everything up and asks them for the code.');
    expect(give).toContain('The prompt holds no secret; send the code directly, not through a shared chat.');
    expect(give).toContain('The code works once, for 30 minutes');
    expect(give).toContain(', and only with this hub.');
    expect(give).toContain('<b>New code</b> makes a new one and voids this one.');
    expect(give).toContain('codeBox(r.pairing.code, true)');
    expect(give).not.toMatch(/Claude/);
    expect(js).not.toContain('const obPairH');
  });
  it('without a connector prompt says why (no CA, or no HTTPS address), offers no Copy and falls back to nothing', () => {
    const no = js.slice(js.indexOf('const OB_NO_PROMPT = {'), js.indexOf('/* Re-enrol PC'));
    expect(no).toContain("no_ca: \"The hub has no CA certificate (<code>CA_CERT_FILE</code>), so the connector can't check the hub before it sends the code.\"");
    expect(no).toContain("no_origin: \"The hub's public address isn't HTTPS (<code>PUBLIC_URL</code>), so the connector has no hub address to check.\"");
    expect(no).toContain("OB_NO_PROMPT[r.connector_unavailable]");
    expect(no).toContain("then use <b>Re-enrol PC</b> on the PC's page for a new prompt.");
    expect(sheet).toContain("if (!made.connector_prompt || !made.pairing) { out.innerHTML = `${obNoPrompt(made)}<div class=\"sheet-acts jn-acts\"><button type=\"button\" class=\"btn lg\" data-sheet-close>Done</button></div>`; refresh(); return; }");
    expect(re).toContain(': obNoPrompt(r)}');
    expect(re).toContain("${ok ? `<button type=\"button\" class=\"btn lg\" id=\"obNewP\">");
    expect(re).toContain('<button type="button" class="btn pri lg" data-copy>');
  });
});

/* New prompt (POST /api/pcs/:id/prompt): a new code, the old one void; asked once more by arming the button. */
describe('New prompt', () => {
  const sheet = fn('joinSheet'), re = fn('obPromptSheet'), np = fn('obNewPrompt');
  it('arms first, then calls the route and says the old code no longer works', () => {
    expect(np).toContain("if (!confirmOnce(sh, id, 'New code: the old one stops working')) return null;");
    expect(np).toContain('await post(`/pcs/${encodeURIComponent(r.pc.id)}/prompt`');
    expect(np).toContain("toast('New code made. The old one no longer works');");
  });
  it('Add PC and Re-enrol both offer it, and Add PC hides it once the PC has used its code', () => {
    expect(sheet).toContain('<button type="button" class="btn lg" id="jnNewP">${ic(\'rot\')}New code</button>');
    expect(sheet).toContain("const np = $('#jnNewP', sh); if (np && e && e.status !== 'unused') np.hidden = true;");
    expect(sheet).toContain("made = { ...made, ...n }; draw(); $('#jnGive', sh).innerHTML = obGiveH(made); $('#jnCode', sh).innerHTML = obCodeH(made);");
    expect(re).toContain('<button type="button" class="btn lg" id="obNewP">${ic(\'rot\')}New code</button>');
    expect(re).toContain("const n = await obNewPrompt(r, sh, 'obNewP'); if (n) obPromptSheet(n, title);");
  });
  it('no installer step or pairing screen step is left on Add PC', () => {
    expect(js).not.toContain('jnInstallH');
    expect(sheet).not.toMatch(/<b>[123]\.<\/b>/);
  });
});

/* Paired just now: a Needs you row with It was me and Revoke, opening the PC. */
describe('Paired just now', () => {
  it('has its own kind and opens the PC', () => {
    expect(js).toContain("paired: ['Paired just now', 'pc']");
    expect(fn('nyOpenAttr')).toContain("case 'pc': return `data-pc=\"${e(o.id)}\"`;");
  });
});

/* The PCs list shows the connector's state, not "Bridge · Not paired" on a connector PC (onboarding-e2e findings 9). */
describe('PCs list connection', () => {
  const conn = js.slice(js.indexOf('const pcHasBridge = '), js.indexOf('const PCF_SEG'));
  it('reads the connector first, the bridge only where one is paired or being set up, else Not connected', () => {
    expect(conn).toContain("if (c && c.status !== 'never') return c.status === 'disconnected' ? ['Disconnected', 'bad'] : c.online ? ['Connector online', 'ok'] : ['Connector offline', 'idle'];");
    expect(conn).toContain('if (pcHasBridge(p)) { const [l, t] = pcBridge(p); return [`Bridge ${l.toLowerCase()}`, t]; }');
    expect(conn).toContain("return ['Not connected', ''];");
    expect(js).toContain('<span role="columnheader" class="pc-br">Connection</span>');
    expect(fn('pcRow')).toContain("pill('Suspended', 'bad') : pcConnH(p)");
    expect(js).toContain("(p) => pcLive(p) > 0 || p.bridge?.online || p.connector?.online]");
  });
  it('a bridge counts only when paired or being set up, not for setup_status none or done', () => {
    expect(conn).toContain("const pcHasBridge = (p) => !!(p.bridge?.paired || ['waiting_install', 'waiting_pairing', 'waiting_folder_approval'].includes(p.bridge?.setup_status));");
  });
  it('the PC page hides the Bridge row on a connector PC with no bridge', () => {
    expect(js).toContain("${pcHasBridge(p) || cn.status === 'never' ? kv('Bridge', ");
  });
});

/* A decision on a team request shows at once; the page does not read "Waiting for you" while it reloads (findings 9).
   obDecided runs in a vm with the console's own $ and $$ (line 3 of app.js) against a small fake page. */
describe('team request decision', () => {
  const helpers = js.slice(js.indexOf('const $ = '), js.indexOf('\n', js.indexOf('const $ = ')));
  const decide = js.slice(js.indexOf('const obDecided = '), js.indexOf('\n', js.indexOf('const obDecided = ')));
  const page = () => {
    const meta = { innerHTML: 'Waiting for you' }, buttons = [{ disabled: false }, { disabled: false }, { disabled: false }];
    const document = { querySelector: (s: string) => (s === '#ctxBar .ctx-meta' ? meta : null), querySelectorAll: (s: string) => (s === '#ctxBar .ws-act button' ? buttons : []) };
    const ctx = vm.createContext({ document, obPill: (st: string) => `pill:${st}` });
    vm.runInContext(`${helpers}\n${decide}\nthis.obDecided = obDecided;`, ctx);
    return { run: (ctx as unknown as { obDecided: (st: string) => void }).obDecided, meta, buttons };
  };
  it('swaps the header pill and turns every button off, without throwing', () => {
    for (const st of ['approved', 'denied']) {
      const p = page();
      expect(() => p.run(st)).not.toThrow();
      expect(p.meta.innerHTML).toBe(`pill:${st}`);
      expect(p.buttons.every((b) => b.disabled)).toBe(true);
    }
  });
  it('runs after a saved Approve or Deny, before the toast and the reload', () => {
    expect(js).toContain("obDecided('approved'); toast('Approved; the PC collects the keys'); viewEdited = false; re();");
    expect(js).toContain("obDecided('approved'); toast('Approved; the PC collects the key'); viewEdited = false; re();");
    expect(js).toContain("obDecided('denied'); toast('Denied'); re();");
  });
});

describe('onboarding prompt', () => {
  const p = read('deploy', 'client', 'onboarding-prompt.md');
  it('does not tell a Codex user to restart Claude Code or run `claude`', () => {
    expect(p).not.toMatch(/Claude Code restart|run `claude`|restart Claude Code/);
    expect(p).toContain('working after the client is restarted');
    expect(p).toContain('tell me to open my coding agent in that folder');
  });
  it('mentions ~/.claude.json only as Claude Code\'s own file', () => {
    expect(p).toContain('(Claude Code: ~/.claude.json)');
  });
});

/* Invites (docs/onboarding.md#an-invite-for-a-collaborator): the operator makes and withdraws them; the collaborator opens the
   code on their own Home, with the hub's one prompt beside it, held in the page only. */
describe('collaborator invites', () => {
  const sheet = fn('invSheet'), mine = fn('invMemberHtml'), act = fn('invMemberAct');
  it('the operator invites to one team and role and never sees the code', () => {
    expect(sheet).toContain("await post('/invites', { owner_id: $('#invUser', sh).value, team_id: $('#invTeam', sh).value, team_role: $('#invKind', sh).value");
    expect(sheet).toContain("await api(`/invites/${encodeURIComponent(b.dataset.invRm)}`, 'DELETE');");
    expect(sheet).toContain('Making the invite approves it');
    expect(sheet).not.toMatch(/\.code\b/);
  });
  it('the collaborator opens the code on Home, behind their own sign-in, and a new one voids the old', () => {
    expect(act).toContain('await post(`/me/invites/${encodeURIComponent(id)}/code`, {})');
    expect(mine).toContain('Show the code');
    expect(mine).toContain('New code');
    expect(mine).toContain("Pass it only to the installer; don't share it.");
    expect(js).toContain('const im = invMemberHtml(await invMine());');
    expect(js).toContain("return muPage('Home', `${dm}${im}<div");
    expect(js).toContain("if ((await invMine()).length) return ''; // so does an invite");
    expect(js).toContain("const im = t.closest('[data-inv-mu]'); if (im) { run(() => invMemberAct(im.dataset.id)); return; }");
    expect(mine + sheet).not.toMatch(/Claude/);
  });
});

describe('Revoke and the PC banner (one-prompt polish)', () => {
  const css = read('server', 'public', 'style.css');
  it('a Needs you action with confirm asks once in a sheet that names what it ends, and the toast says what happened', () => {
    expect(js).toContain('const nyActAttrs = (a) => `${a.confirm ? ` data-ny-confirm="${esc(a.confirm)}"` : \'\'}${a.done ? ` data-ny-done="${esc(a.done)}"` : \'\'}`;');
    expect(fn('nyBtns')).toContain('${nyActAttrs(a)}');
    const act = fn('nyAct');
    expect(act).toContain("if (b.dataset.nyConfirm) {");
    expect(act).toContain("return fbSheet({ title: b.dataset.nyConfirm, anchor, label, tone: 'bad', fields: '', onGo: async () => { await send(); } });");
    expect(act).toContain('toast(`${b.dataset.nyDone || label} · ');
  });
  it('the other revoke buttons name what ends on the second click and say what was revoked', () => {
    for (const s of ["`Key revoked: ${keyName(k)}`", "'Revoke? Logins stop for good'", "toast(`Code revoked for ${p.name}`)", "'Revoke? The code stops working'",
      "'Revoke? Access ends now'", "toast(`Grant revoked: ", "toast(`Share revoked: ${s.name}`)", "'Revoke? Recipients lose access'"]) expect(js).toContain(s);
    expect(js).not.toContain("toast('Revoked')");
    expect(js).not.toContain("'Yes, revoke'");
  });
  it('the PC banner leads with where it paired from and its version, then the warning, and wraps instead of cutting', () => {
    expect(js).toContain("full: r.kind === 'paired',");
    expect(js).toContain("msg: (r.kind === 'paired' ? [r.title, r.reason, r.summary] : [r.title, nyUntil(r), nySum(r)]).filter(Boolean).join(' · '),");
    expect(js).toContain("${a.full ? ' full' : ''}");
    expect(css).toContain('.alert.full .alert-msg,#ovAlert .alert.full .alert-msg{display:block;-webkit-line-clamp:unset;overflow:visible;overflow-wrap:anywhere}');
  });
  it('the collaborator reads "operator", never "admin", in their empty Home', () => {
    expect(js).toContain("'No projects yet. The operator adds the projects you see.'");
    expect(js).not.toContain('The admin adds the projects you see.');
  });
});
