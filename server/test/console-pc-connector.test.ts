/**
 * The PC page's connector view (docs/connector.md, "Hub route contract"; docs/dashboard-ux.md, the PC page): Online,
 * Offline since or Never connected for the PC; the connector's versions and switches, Unknown until it reports them; the
 * setup timeline with one next action and who takes it; the agents' states; Check this PC, Restore, Update and Suspend
 * access; Disconnect with what goes and stays, asked once more, and its four states; version approval on the PCs page;
 * the admin-only usage card at API list prices; the agent page's Messages card; Add PC's download line; no HTTP tag.
 * Read from the source files.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (...p: string[]) => readFileSync(join(process.cwd(), '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const js = read('server', 'public', 'app.js');
const css = read('server', 'public', 'style.css');
const fn = (name: string) => { const i = js.indexOf(`function ${name}(`); return js.slice(i, js.indexOf('\n}\n', i) + 3); };
const view = (name: string) => { const i = js.indexOf(`VIEWS.${name} = `); return js.slice(i, js.indexOf('\nVIEWS.', i + 10)); };

describe('PC status', () => {
  it('is Online, Offline since a time, or Never connected', () => {
    expect(js).toContain("pill('Never connected', 'idle')");
    expect(js).toContain("c.online ? pill('Online', 'ok')");
    expect(js).toContain("pill('Offline', 'bad')}<span class=\"kv-sub\"> since ${esc(dt(c.last_check_in_at))}");
  });
  it('reads Disconnected or Access suspended, not Offline since, while the hub holds the PC', () => {
    expect(js).toContain("c?.status === 'disconnected' ? pill('Disconnected', 'bad') : c?.status === 'suspended' ? pill('Access suspended', 'warn')");
  });
  it('shows Unknown for anything the connector has not reported', () => {
    expect(js).toContain("const CN_UNK = '<span class=\"kv-sub\">Unknown</span>';");
    expect(js).toContain('const cnV = (v) => (v ? `<span class="mono">${esc(v)}</span>` : CN_UNK);');
    expect(js).toContain("const cnSw = (v) => (v === null || v === undefined ? CN_UNK : v ? 'On' : 'Off');");
  });
});

describe('Setup timeline and agents', () => {
  it('names every step and gives one next action with who takes it', () => {
    for (const s of ['Added to the hub', 'Connector paired', 'Team request filed', 'Request approved', 'Keys collected on the PC', 'Agents connected']) expect(js).toContain(`'${s}'`);
    expect(js).toContain(`const CN_WHO = { you: 'You', pc_user: "The PC's user", agent: 'The agent' };`);
    expect(js).toContain('<span class="cn-next">Next: ${esc(s.next.action)} · <b>${esc(CN_WHO[s.next.who] || s.next.who)}</b></span>');
    for (const s of ['done', 'waiting', 'failed', 'not_yet']) expect(css).toContain(`.cn-step.${s}`);
  });
  it('gives each agent one state', () => {
    expect(js).toContain("waiting_for_approval: ['Waiting for approval', 'warn']");
    expect(js).toContain("ready_to_open: ['Ready to open', 'info']");
    expect(js).toContain("connected: ['Connected', 'ok']");
    expect(js).not.toContain('waiting_for_keys'); // shown as Ready to open, Next: Continue setup on the PC
    expect(js).toContain('${a.next ? ` · Next: ${esc(a.next.action)} (${esc(CN_WHO[a.next.who] || a.next.who)})` : \'\'}');
  });
  it("adds only the PC's own facts about an agent, said as the PC's report", () => {
    expect(js).toContain("const CN_PCREP = { repair_connection: 'the PC reports it cannot reach the hub', chat_in_use: 'the PC reports its chat is in use', open: 'open on the PC' };");
  });
  it('loads the timeline, the actions and, for an admin only, the usage', () => {
    const v = view('pc');
    expect(v).toContain("/setup-timeline");
    expect(v).toContain("/actions");
    expect(v).toContain('adm ? api(`/pcs/${encodeURIComponent(id)}/usage`)');
  });
});

describe('PC actions', () => {
  const v = view('pc');
  it('offers Check this PC, Restore, Update and Suspend access', () => {
    expect(js).toContain("const CN_ACT = { check: 'Check this PC', restore: 'Restore', update: 'Update', disconnect: 'Disconnect' };");
    for (const id of ['pcCheck', 'pcRestore', 'pcUpdate', 'pcSus']) expect(v).toContain(`id="${id}"`);
    expect(v).toContain("label: 'Suspend access'");
  });
  it('Restore picks a destination the PC user approved, by id, and is off while there is none', () => {
    expect(v).toContain('const dests = cn.destinations || [];');
    expect(v).toContain('<select id="pcDest" class="sel" aria-label="Destination on the PC">');
    expect(v).toContain("on && dests.length && !openK.has('restore') ? '' : ' disabled'");
    expect(v).toContain("doAct('restore', { checkout_id: rc.id, destination_id: $('#pcDest')?.value || dests[0]?.id })");
    expect(v).toContain("The PC's user has not approved a restore destination on this PC yet.");
    expect(v).toContain('Unknown: the connector has not reported the destinations its user approved.');
  });
  it('shows each order\'s state', () => {
    expect(js).toContain("queued: ['Waiting for the PC', 'idle'], fetched: ['Taken by the PC', 'info'], done: ['Done', 'ok'], failed: ['Failed', 'bad'], expired: ['Expired', 'idle']");
  });
  it('does not offer Resume access after a disconnect', () => {
    expect(v).toContain("dscGone ? '' : row({ lead: ic('play'), title: 'Resume access'");
    expect(v).toContain("dscGone ? null : { label: 'Resume access'");
  });
});

describe('Disconnect this hub from this PC', () => {
  const sh = fn('pcDisconnectSheet');
  it('sits in the danger zone and lists what is removed and kept', () => {
    expect(view('pc')).toContain("dz('out', 'Disconnect this hub from this PC'");
    expect(js).toContain("const CN_KEEPS = ['Repositories and worktrees', 'Chat history', \"The PC user's own settings\", 'Other hubs on the PC'];");
    expect(sh).toContain('CN_REMOVES');
    expect(sh).toContain('CN_KEEPS');
  });
  it('asks once more before it posts, and never shows a receipt', () => {
    expect(sh).toContain("arm($('#cnDscGo', sh), () => run(async () => { await post(`/pcs/${p.id}/disconnect`, {});");
    expect(sh).toContain("'Yes, disconnect'");
    expect(js).not.toContain('ah_dsc_');
  });
  it('says when cleanup was turned off on the PC and when Re-enrol PC ended it', () => {
    expect(js).toContain('Cleanup turned off on the PC: its access is revoked and nothing was removed from it.');
    expect(js).toContain('Ended by Re-enrol PC ${ago(dsc.ended_at)} ago.');
    expect(js).toContain("const CN_REMOVES = [\"This hub's worker and transfers, stopped first\",");
  });
  it('shows Access revoked, Cleanup pending, Removed or Needs attention', () => {
    expect(js).toContain("const CN_DSC = { access_revoked: ['Access revoked', 'warn'], cleanup_pending: ['Cleanup pending', 'info'], removed: ['Removed', 'ok'], needs_attention: ['Needs attention', 'bad'] };");
  });
});

describe('Connector versions', () => {
  it('the PCs page lists them for an admin with Approve and Refuse, Refuse asked once more', () => {
    const c = fn('pcVerCard');
    expect(c).toContain('data-ver="approve"');
    expect(c).toContain('data-ver="refuse"');
    expect(view('pcs')).toContain("S.me?.role === 'admin' ? ((await api('/connector/versions')");
    expect(view('pcs')).toContain("arm(b, () => ver(b.dataset.v, 'refuse'), 'Yes, refuse')");
  });
});

describe('Usage and messages', () => {
  it('the usage card says "at API list prices" and reads Unknown without a price', () => {
    const v = view('pc');
    expect(v).toContain("kd('Usage · 30 days', '<span class=\"meta\">at API list prices</span>')");
    expect(v).toContain("kv('Cost', cnCost(use.total.cost_usd))");
    expect(v).toContain("kv('Turns', use.total.turns === null ? CN_UNK");
    expect(js).toContain("const cnCost = (c) => (c === null ? CN_UNK : `$${c.toFixed(2)}<span class=\"kv-sub\"> at API list prices</span>`);");
  });
  it('the agent and team pages show usage to an admin only, Unknown until a PC reports, one line per PC or per agent', () => {
    const u = fn('cnUseH');
    expect(u).toContain('if (!u.reported) return `<p class="hint">Unknown:');
    expect(u).toContain("kv('Turns', u.total.turns === null ? CN_UNK");
    expect(u).toContain("kv('Cost', cnCost(u.total.cost_usd))");
    expect(u).toContain("overline(per === 'pc' ? 'By PC' : 'By agent', u.by.length)");
    expect(view('ses')).toContain("S.me?.role === 'admin' ? api('/agents/' + u + '/usage')");
    expect(view('ses')).toContain("card('pulse', 'Usage · 30 days', cnUseH(use, 'pc')");
    expect(view('team')).toContain("S.me?.role === 'admin' ? api(tp + '/usage')");
    expect(view('team')).toContain("sec('Usage · 30 days', `<div class=\"kvc\" id=\"tmUse\">${cnUseH(tUse, 'agent')}</div>`");
  });
  it('the agent page shows not delivered yet, shown to the session (reported by the PC) and read', () => {
    const m = fn('agMsgH');
    expect(m).toContain('not delivered yet');
    expect(m).toContain('(reported by the PC');
    expect(m).toContain("'Shown: Unknown'");
    expect(m).toContain("pill('Read', 'ok')");
    expect(view('ses')).toContain("S.me?.role === 'admin' ? api('/agents/' + u + '/message-states')");
  });
});

describe('Add PC and plain HTTP', () => {
  it('Add PC shows the one prompt and, apart from it, the 30-minute pairing code', () => {
    const s = fn('joinSheet');
    expect(s).toContain('${obGiveH(made)}');
    expect(s).toContain('<div id="jnCode">${obCodeH(made)}</div>');
    expect(js).toContain('The code works once, for 30 minutes');
    expect(js).not.toMatch(/const (jnInstallH|obPairH) = /);
  });
  it('drops the HTTP tag and the Plain HTTP pill', () => {
    expect(js).not.toContain('Plain HTTP');
    expect(js).not.toContain('obHttp');
  });
});
