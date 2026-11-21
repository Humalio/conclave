/**
 * The push stream and delivery orders (docs/connector.md, "The push stream" and "Delivery orders"): the stream only says
 * "orders waiting" and answers within a second or two; the long poll returns the same orders; the stream closes when the PC's
 * access ends; a notice that needs a turn makes one folded `deliver` order for its agent's PC, ids only; an admin cannot make one.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { DELIVER_REASONS } from '../src/connector/connector.js';
import { testConfig, adminLogin } from './hub.js';
import { sha256Hex } from '../src/util/crypto.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const sys = { kind: 'system' as const, id: null };
let app: App, base: string, cookie = '', csrf = '';

const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const cn = async (method: string, path: string, key: string | null, body?: unknown) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  const r = await fetch(`${base}/connector/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const newPc = async (name: string) => {
  const id = (await api('POST', '/pcs', { name })).body.pc.id as string;
  const k = app.keys.createAppKey({ machineId: id, appName: 'claude-code', maxLiveSessions: 10 }, sys);
  return { id, key: k.secret, credential: k.credential.id };
};
const agentOn = (pcId: string, label: string) => {
  const a = app.keys.createAgent(label, null, sys);
  app.keys.createSessionKey({ agentId: a.id, label: 'k', machineId: pcId }, sys);
  return a.id;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Opens the stream; `events` counts `event: orders`; `closed` resolves when the hub ends it. */
async function openSse(key: string, installation = 'inst-aaaaaa') {
  const ac = new AbortController();
  const r = await fetch(`${base}/connector/v1/stream?installation=${installation}`, { headers: { authorization: `Bearer ${key}`, accept: 'text/event-stream' }, signal: ac.signal });
  const s = { status: r.status, events: 0, text: '', closed: Promise.resolve(), cancel: () => ac.abort() };
  if (r.status !== 200) { await r.arrayBuffer().catch(() => null); return s; }
  const reader = r.body!.getReader(), dec = new TextDecoder();
  s.closed = (async () => {
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) return; s.text += dec.decode(value); s.events = (s.text.match(/event: orders/g) ?? []).length; }
    } catch { /* aborted */ }
  })();
  return s;
}
const until = async (f: () => boolean, ms = 3000) => { const t0 = Date.now(); while (!f() && Date.now() - t0 < ms) await sleep(20); return f(); };
const ended = (s: { closed: Promise<void> }, ms = 2000) => Promise.race([s.closed.then(() => true), sleep(ms).then(() => false)]);

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahstream-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  const config: Config = testConfig(dir, { maintenanceSeconds: undefined });
  app = await buildApp(config);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base));
});
afterAll(async () => { await app.close(); });

describe('the push stream', () => {
  it('opens with a signed key, tells at once, and tells again within 2 seconds of a new delivery order', async () => {
    const pc = await newPc('st-open'), agent = agentOn(pc.id, 'st-open-a');
    const s = await openSse(pc.key);
    expect(s.status).toBe(200);
    expect(await until(() => s.events >= 1)).toBe(true); // the first event: fetch whatever waits
    const t0 = Date.now();
    app.keys.notify(agent, 'task_assigned', 'x', { task: 'task_abc', state: 'assigned' });
    expect(await until(() => s.events >= 2, 2000)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2000);
    s.cancel();
  });
  it('refuses a missing or wrong key, and a compute machine opens none', async () => {
    expect((await openSse('ah_app_aaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')).status).toBe(401);
    const r = await fetch(`${base}/connector/v1/stream`);
    expect(r.status).toBe(401);
    const pc = await newPc('st-measure');
    app.db.prepare("INSERT INTO hw_machines(machine_id,access,timezone,created_at,updated_at) VALUES (?,?,?,?,?)").run(pc.id, 'ssh', 'UTC', Date.now(), Date.now());
    expect((await openSse(pc.key)).status).toBe(403);
  });
  it('limits openings per PC per minute', async () => {
    const pc = await newPc('st-rate');
    const open: Awaited<ReturnType<typeof openSse>>[] = [];
    for (let i = 0; i < 6; i++) open.push(await openSse(pc.key));
    expect(open.every((s) => s.status === 200)).toBe(true);
    expect((await openSse(pc.key)).status).toBe(429);
    open.forEach((s) => s.cancel());
  });
  it('a second stream replaces the first; one from another installation raises an alert', async () => {
    const pc = await newPc('st-replace');
    const a = await openSse(pc.key, 'inst-first1');
    expect(await until(() => a.events >= 1)).toBe(true);
    const b = await openSse(pc.key, 'inst-first1'); // the same installation: replaced quietly
    expect(await ended(a)).toBe(true);
    expect(app.db.prepare("SELECT COUNT(*) n FROM security_alerts WHERE type='connector_stream_replaced' AND subject=?").get(pc.id)).toEqual({ n: 0 });
    const c = await openSse(pc.key, 'inst-second');
    expect(await ended(b)).toBe(true);
    expect(app.db.prepare("SELECT COUNT(*) n FROM security_alerts WHERE type='connector_stream_replaced' AND subject=?").get(pc.id)).toEqual({ n: 1 });
    c.cancel();
  });
  it('closes at once when the key is revoked, the PC is suspended, disconnected or locked down', async () => {
    const revoke = await newPc('st-revoke'), s1 = await openSse(revoke.key);
    app.keys.setStatus(revoke.credential, 'revoked', 'test', sys);
    expect(await ended(s1)).toBe(true);

    const suspend = await newPc('st-suspend'), s2 = await openSse(suspend.key);
    app.keys.setMachineStatus(suspend.id, 'suspended', sys);
    expect(await ended(s2)).toBe(true);

    const dsc = await newPc('st-disconnect'), s3 = await openSse(dsc.key);
    expect((await api('POST', `/pcs/${dsc.id}/disconnect`, {})).status).toBeLessThan(300);
    expect(await ended(s3)).toBe(true);

    const lock = await newPc('st-lock'), s4 = await openSse(lock.key);
    app.lockdown.set('pc', lock.id, true, null);
    expect(await ended(s4)).toBe(true);
    app.lockdown.set('pc', lock.id, false, null);
  });
});

describe('the long poll', () => {
  it('holds the answer until an order is queued, then returns it', async () => {
    const pc = await newPc('lp-wait'), agent = agentOn(pc.id, 'lp-a');
    const t0 = Date.now();
    const p = cn('GET', '/orders?wait=10', pc.key);
    await sleep(300);
    app.keys.notify(agent, 'review_requested', 'x', { task: 'task_lp', state: 'in_review' });
    const r = await p;
    expect(r.status).toBe(200);
    expect(r.body.orders).toHaveLength(1);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
  it('answers an empty list when the wait runs out, and without wait answers at once', async () => {
    const pc = await newPc('lp-empty');
    const t0 = Date.now();
    expect((await cn('GET', '/orders', pc.key)).body).toEqual({ orders: [] });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect((await cn('GET', '/orders?wait=1', pc.key)).body).toEqual({ orders: [] });
  });
  it('refuses a refused key', async () => {
    expect((await cn('GET', '/orders?wait=1', 'ah_app_aaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')).status).toBe(401);
  });
});

describe('delivery orders', () => {
  it('a task assigned makes one order with ids only; more items for the agent fold into it', async () => {
    const pc = await newPc('dl-fold'), agent = agentOn(pc.id, 'dl-fold-a');
    app.keys.notify(agent, 'task_assigned', 'Task "secret title" was assigned', { task: 'task_one', state: 'assigned' });
    app.keys.notify(agent, 'review_requested', 'Please review', { task: 'task_two', state: 'in_review' });
    app.keys.notify(agent, 'review_requested', 'Please review', { task: 'task_two', state: 'in_review' }); // the same item twice: once
    const r = await cn('GET', '/orders', pc.key);
    expect(r.body.orders).toHaveLength(1);
    expect(r.body.orders[0]).toMatchObject({ kind: 'deliver', payload: { agent_id: agent, items: [{ notice: 'task_assigned', task: 'task_one' }, { notice: 'review_requested', task: 'task_two' }] } });
    expect(JSON.stringify(r.body)).not.toContain('secret title');
  });
  it('a directive change, a pause and other notices start no turn and make no order', async () => {
    const pc = await newPc('dl-none'), agent = agentOn(pc.id, 'dl-none-a');
    for (const k of ['directive_changed', 'team_paused', 'task_open', 'permissions_changed']) app.keys.notify(agent, k, 'x');
    expect((await cn('GET', '/orders', pc.key)).body.orders).toEqual([]);
  });
  it('an agent with no PC, or a suspended PC, gets no order', async () => {
    const loose = app.keys.createAgent('dl-loose', null, sys).id;
    app.keys.notify(loose, 'task_assigned', 'x', { task: 'task_x', state: 'assigned' });
    expect(app.db.prepare("SELECT COUNT(*) n FROM pc_actions WHERE json_extract(payload,'$.agent_id')=?").get(loose)).toEqual({ n: 0 });
    const pc = await newPc('dl-susp'), agent = agentOn(pc.id, 'dl-susp-a');
    app.keys.setMachineStatus(pc.id, 'suspended', sys);
    app.keys.notify(agent, 'task_assigned', 'x', { task: 'task_x', state: 'assigned' });
    expect(app.db.prepare("SELECT COUNT(*) n FROM pc_actions WHERE machine_id=?").get(pc.id)).toEqual({ n: 0 });
  });
  it('a compute machine refuses a delivery order', async () => {
    const pc = await newPc('dl-measure'), agent = agentOn(pc.id, 'dl-measure-a');
    app.db.prepare("INSERT INTO hw_machines(machine_id,access,timezone,created_at,updated_at) VALUES (?,?,?,?,?)").run(pc.id, 'ssh', 'UTC', Date.now(), Date.now());
    app.keys.notify(agent, 'task_assigned', 'x', { task: 'task_x', state: 'assigned' });
    expect(app.db.prepare("SELECT COUNT(*) n FROM pc_actions WHERE machine_id=?").get(pc.id)).toEqual({ n: 0 });
  });
  it('messages from agents make at most one order per agent per 10 minutes; the operator\'s are never held back', async () => {
    const pc = await newPc('dl-msg'), agent = agentOn(pc.id, 'dl-msg-a');
    expect(app.connector.deliver(agent, { notice: 'message', from: 'agent' })).not.toBeNull();
    await cn('GET', '/orders', pc.key); // fetched: the gap still counts
    expect(app.connector.deliver(agent, { notice: 'message', from: 'agent' })).toMatchObject({ held: true }); // held until the window ends, not dropped
    expect(app.connector.deliver(agent, { notice: 'message', from: 'operator' })).not.toBeNull();
    expect((await cn('GET', '/orders', pc.key)).body.orders).toHaveLength(1);
  });
  it('sent through messaging (a message with no sender agent is the operator/hub one): two operator messages in a row both make an order; a second agent message is held back', async () => {
    const pc = await newPc('dl-msgthru'), rcv = agentOn(pc.id, 'dl-recv'), other = app.keys.createAgent('dl-sender', null, sys).id;
    const room = app.messaging.createGroup('dl-room', other);
    app.messaging.addMember(room.id, rcv, 'member', null);
    const send = (agentId: string | null, n: number) => app.messaging.insert({ roomId: room.id, agentId, credId: null, kind: agentId === null ? 'system' : 'text', body: '@dl-recv hi ' + n, replyTo: null, clientMsgId: 'c' + n + Math.random() });
    const orders = async () => (await cn('GET', '/orders', pc.key)).body.orders as { payload: { agent_id: string; agent_msg?: boolean } }[];
    send(null, 1);
    expect(await orders()).toHaveLength(1);
    send(null, 2); // the operator again, at once: not held back
    expect(await orders()).toHaveLength(1);
    send(other, 3); // an agent: one order
    const first = await orders();
    expect(first).toHaveLength(1);
    expect(first[0]!.payload.agent_msg).toBe(true);
    send(other, 4); // an agent again within 10 minutes: none
    expect(await orders()).toHaveLength(0);
    send(null, 5); // and the operator still gets through
    expect(await orders()).toHaveLength(1);
  });
  describe('an agent message wakes only the agents it addresses', () => {
    /** A room on one PC with three agents; `woken()` lists the agents whose new orders appeared since the last call. */
    const setup = async (tag: string) => {
      const pc = await newPc(`wk-${tag}`);
      const [a, b, c] = ['ana', 'ben', 'cy'].map((l) => agentOn(pc.id, `${tag}-${l}`)) as [string, string, string];
      const room = app.messaging.createGroup(`wk-${tag}`, a);
      app.messaging.addMember(room.id, b, 'member', null);
      app.messaging.addMember(room.id, c, 'member', null);
      const say = (from: string | null, body: string, replyTo: string | null = null, roomId = room.id) =>
        app.messaging.insert({ roomId, agentId: from, credId: null, kind: from === null ? 'system' : 'text', body, replyTo, clientMsgId: `c${Math.random()}` });
      const woken = async () => ((await cn('GET', '/orders', pc.key)).body.orders as { payload: { agent_id: string } }[]).map((o) => o.payload.agent_id).sort();
      return { a, b, c, room, say, woken, tag };
    };
    it('two agents chatting in a room wake nobody', async () => {
      const r = await setup('chat');
      r.say(r.a, 'shall we start?');
      r.say(r.b, 'yes, starting now');
      expect(await r.woken()).toEqual([]);
      // The message is still there for the third member, unread at its next prompt.
      expect(app.messaging.members(r.room.id).map((m) => m.agent_id)).toContain(r.c);
    });
    it('an @mention of a label wakes only that agent, in any letter case, never inside a longer word or label', async () => {
      const r = await setup('men');
      r.say(r.a, 'email@men-cy.org and @men-cyclist are not mentions');
      expect(await r.woken()).toEqual([]);
      r.say(r.a, 'over to you, @MEN-CY.');
      expect(await r.woken()).toEqual([r.c]);
    });
    it('a reply wakes the author of the message replied to', async () => {
      const r = await setup('rep');
      const q = r.say(r.b, 'which file?');
      expect(await r.woken()).toEqual([]);
      r.say(r.a, 'plan.md', q.id);
      expect(await r.woken()).toEqual([r.b]);
    });
    it('a direct message wakes the other agent, never the sender', async () => {
      const r = await setup('dm');
      const dm = app.messaging.ensureDirect(r.a, r.b);
      r.say(r.a, 'a word in private', null, dm.id);
      expect(await r.woken()).toEqual([r.b]);
    });
    it('an operator message still wakes every member', async () => {
      const r = await setup('op');
      r.say(null, 'Everyone: the deadline moved.');
      expect(await r.woken()).toEqual([r.a, r.b, r.c].sort());
    });
  });
  it('an admin cannot create a delivery order', async () => {
    const pc = await newPc('dl-admin');
    const r = await api('POST', `/pcs/${pc.id}/actions`, { kind: 'deliver' });
    expect(r.status).toBe(400);
    expect(app.db.prepare("SELECT COUNT(*) n FROM pc_actions WHERE machine_id=? AND kind='deliver'").get(pc.id)).toEqual({ n: 0 });
  });
  it('the connector\'s result "turn started" records the delivery time; a reason is kept as it is', async () => {
    const pc = await newPc('dl-result'), agent = agentOn(pc.id, 'dl-result-a');
    app.keys.notify(agent, 'task_assigned', 'x', { task: 'task_r1', state: 'assigned' });
    const id = (await cn('GET', '/orders', pc.key)).body.orders[0].id as string;
    expect((await cn('POST', `/orders/${id}/result`, pc.key, { state: 'done' })).status).toBe(200);
    const row = app.db.prepare('SELECT state, result FROM pc_actions WHERE id=?').get(id) as { state: string; result: string };
    expect(row.state).toBe('done');
    expect(JSON.parse(row.result).delivered_at).toBeGreaterThan(0);
  });
  it('the result reaches the turn: a failed order keeps its reason, a done one stamps delivered_at', async () => {
    const pc = await newPc('dl-turn'), agent = agentOn(pc.id, 'dl-turn-a');
    app.db.exec('PRAGMA foreign_keys = OFF');
    app.db.prepare("INSERT INTO task_turns (id, task_id, team_id, phase, holder_agent_id, opened_at, opened_by_kind) VALUES ('trn_dl1','task_dl1','team_dl1','work',?,1,'system')").run(agent);
    app.db.exec('PRAGMA foreign_keys = ON');
    const turn = () => app.db.prepare("SELECT delivered_at, delivery_reason FROM task_turns WHERE id='trn_dl1'").get() as { delivered_at: number | null; delivery_reason: string | null };
    app.keys.notify(agent, 'task_assigned', 'x', { task: 'task_dl1', state: 'assigned' });
    const id = (await cn('GET', '/orders', pc.key)).body.orders[0].id as string;
    expect((await cn('POST', `/orders/${id}/result`, pc.key, { state: 'failed', result: { reason: 'The wake is not available yet.', code: 'wake_held' } })).status).toBe(200);
    expect(turn()).toEqual({ delivered_at: null, delivery_reason: 'wake_held' });
    app.keys.notify(agent, 'changes_requested', 'x', { task: 'task_dl1', state: 'changes_requested' });
    const id2 = (await cn('GET', '/orders', pc.key)).body.orders[0].id as string;
    expect((await cn('POST', `/orders/${id2}/result`, pc.key, { state: 'done' })).status).toBe(200);
    const t = turn();
    expect(t.delivered_at).toBeGreaterThan(0);
    expect(t.delivery_reason).toBeNull();
  });
  it('every reason the connector may report can be recorded on the turn (agent_unknown included)', async () => {
    const pc = await newPc('dl-reasons'), agent = agentOn(pc.id, 'dl-reasons-a');
    app.db.exec('PRAGMA foreign_keys = OFF');
    app.db.prepare("INSERT INTO task_turns (id, task_id, team_id, phase, holder_agent_id, opened_at, opened_by_kind) VALUES ('trn_dl2','task_dl2','team_dl2','work',?,1,'system')").run(agent);
    app.db.exec('PRAGMA foreign_keys = ON');
    for (const r of DELIVER_REASONS) {
      expect(app.teams.turns.undelivered('task_dl2', agent, r as never)).toBe(true);
      expect(app.db.prepare("SELECT delivery_reason r FROM task_turns WHERE id='trn_dl2'").get()).toEqual({ r });
    }
  });
});

describe('delivery reliability (docs/connector.md, "Delivery orders")', () => {
  const orders = async (pc: { key: string }) => (await cn('GET', '/orders', pc.key)).body.orders as { id: string; kind: string; payload: any }[];

  it('a fetched order is handed out again after 2 minutes until its result arrives; the result then ends it', async () => {
    const pc = await newPc('dr-rehand'), agent = agentOn(pc.id, 'dr-rehand-a');
    app.keys.notify(agent, 'task_assigned', 'x', { task: 'task_dr1', state: 'assigned' });
    const first = await orders(pc);
    expect(first).toHaveLength(1);
    expect(await orders(pc)).toHaveLength(0); // not at once
    app.db.prepare('UPDATE pc_actions SET handed_at=? WHERE id=?').run(Date.now() - 3 * 60_000, first[0]!.id);
    const again = await orders(pc);
    expect(again.map((o) => o.id)).toEqual([first[0]!.id]);
    expect(await orders(pc)).toHaveLength(0); // the hand-out was stamped
    expect((await cn('POST', `/orders/${first[0]!.id}/result`, pc.key, { state: 'done' })).status).toBe(200);
    app.db.prepare('UPDATE pc_actions SET handed_at=? WHERE id=?').run(Date.now() - 9 * 60_000, first[0]!.id);
    expect(await orders(pc)).toHaveLength(0); // finished: never again
    expect((await cn('POST', `/orders/${first[0]!.id}/result`, pc.key, { state: 'done' })).status).toBe(404); // a repeat: not_found, the connector drops it
    expect(app.db.prepare('SELECT state FROM pc_actions WHERE id=?').get(first[0]!.id)).toEqual({ state: 'done' });
  });

  it('after a new login, messages read but never confirmed are delivered again (delivered_seq starts at acked_seq)', async () => {
    const pc = await newPc('dr-login'), a = app.keys.createAgent('dr-login-a', null, sys).id, other = app.keys.createAgent('dr-login-s', null, sys).id;
    const sk = app.keys.createSessionKey({ agentId: a, label: 'k', machineId: pc.id }, sys).secret;
    const room = app.messaging.createGroup('dr-login-room', other);
    app.messaging.addMember(room.id, a, 'member', null);
    for (let i = 1; i <= 3; i++) app.messaging.insert({ roomId: room.id, agentId: other, credId: null, kind: 'text', body: 'm' + i, replyTo: null, clientMsgId: 'dl' + i });
    const appCred = app.keys.verifyKey(pc.key, 'app_key');
    const t1 = sha256Hex(app.keys.login(appCred, sk).token);
    expect(app.messaging.pending(t1, a, [room.id], 10).items).toHaveLength(3);
    app.messaging.advance(t1, a, { [room.id]: 3 }); // read all three ...
    app.messaging.ack(t1, a, { [room.id]: 1 }); // ... confirmed only the first
    const t2 = sha256Hex(app.keys.login(appCred, sk).token);
    expect(app.messaging.deliveredSeq(t2, room.id)).toBe(1);
    expect(app.messaging.pending(t2, a, [room.id], 10).items.map((m) => m.body)).toEqual(['m2', 'm3']);
  });

  it('check-in counts an order due again, so the connector fetches it', async () => {
    const pc = await newPc('dr-count'), agent = agentOn(pc.id, 'dr-count-a');
    app.keys.notify(agent, 'task_assigned', 'x', { task: 'task_dr2', state: 'assigned' });
    const [o] = await orders(pc);
    const ci = async () => (await cn('POST', '/check-in', pc.key, { version: '0.9.4' })).body.orders;
    expect(await ci()).toBe(0);
    app.db.prepare('UPDATE pc_actions SET handed_at=? WHERE id=?').run(Date.now() - 3 * 60_000, o!.id);
    expect(await ci()).toBe(1);
  });

  it("a result is matched by order id and PC, not among the PC's 50 newest orders (60 orders after a long restore)", async () => {
    const pc = await newPc('dr-old'), now = Date.now();
    const ins = app.db.prepare('INSERT INTO pc_actions(id,machine_id,kind,state,payload,created_at,created_by,fetched_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)');
    ins.run('pca_oldrestore0001', pc.id, 'update', 'fetched', JSON.stringify({ version: '9.9.9' }), now - 3 * 3600_000, 'x', now - 3 * 3600_000, now + 86400_000);
    for (let i = 0; i < 60; i++) ins.run(`pca_later${String(i).padStart(4, '0')}`, pc.id, 'check', 'done', '{}', now - 2 * 3600_000 + i, 'x', null, now + 86400_000);
    const r = await cn('POST', '/orders/pca_oldrestore0001/result', pc.key, { state: 'failed', result: { reason: 'later' } });
    expect(r.status).toBe(200);
    expect(app.db.prepare("SELECT state FROM pc_actions WHERE id='pca_oldrestore0001'").get()).toEqual({ state: 'failed' });
    const other = await newPc('dr-other');
    expect((await cn('POST', '/orders/pca_later0001/result', other.key, { state: 'failed' })).status).toBe(404); // another PC's order
  });

  it('an agent message inside the wake window is held and released when the window ends; the operator releases it at once', async () => {
    const pc = await newPc('dr-held'), agent = agentOn(pc.id, 'dr-held-a');
    expect(app.connector.deliver(agent, { notice: 'message', from: 'agent' })).toMatchObject({ folded: false });
    const [first] = await orders(pc);
    expect(first).toBeTruthy();
    // 2 minutes after the wake: held, not dropped.
    app.db.prepare('UPDATE pc_actions SET created_at=? WHERE id=?').run(Date.now() - 2 * 60_000, first!.id);
    const held = app.connector.deliver(agent, { notice: 'message', from: 'agent' });
    expect(held).toMatchObject({ held: true });
    expect(await orders(pc)).toHaveLength(0);
    const row = app.db.prepare('SELECT release_at FROM pc_actions WHERE id=?').get(held!.order) as { release_at: number };
    expect(Math.abs(row.release_at - (Date.now() - 2 * 60_000 + 10 * 60_000))).toBeLessThan(5000);
    // a second agent message folds into the held order
    expect(app.connector.deliver(agent, { notice: 'message', from: 'agent' })).toMatchObject({ order: held!.order, folded: true, held: true });
    // the window ends: the next fetch has it
    app.db.prepare('UPDATE pc_actions SET release_at=? WHERE id=?').run(Date.now() - 1000, held!.order);
    expect((await orders(pc)).map((o) => o.id)).toEqual([held!.order]);
    // the operator's message releases a held order at once
    const pc2 = await newPc('dr-held2'), a2 = agentOn(pc2.id, 'dr-held2-a');
    app.connector.deliver(a2, { notice: 'message', from: 'agent' });
    await orders(pc2);
    const h2 = app.connector.deliver(a2, { notice: 'message', from: 'agent' })!;
    expect(h2.held).toBe(true);
    expect(app.connector.deliver(a2, { notice: 'message', from: 'operator' })).toMatchObject({ order: h2.order, folded: true });
    expect((await orders(pc2)).map((o) => o.id)).toEqual([h2.order]);
  });

  it('the timer signals the stream when a held order is due', async () => {
    const pc = await newPc('dr-timer'), agent = agentOn(pc.id, 'dr-timer-a');
    app.connector.deliver(agent, { notice: 'message', from: 'agent' });
    await orders(pc);
    const h = app.connector.deliver(agent, { notice: 'message', from: 'agent' })!;
    const s = await openSse(pc.key);
    await until(() => s.events >= 1);
    const before = s.events;
    try {
      app.db.prepare('UPDATE pc_actions SET release_at=? WHERE id=?').run(Date.now() + 400, h.order);
      app.connector.tick(); // not due yet: no signal
      await sleep(600);
      app.connector.tick();
      expect(await until(() => s.events > before)).toBe(true);
    } finally { s.cancel(); }
  });

  it('a blocked task, an approved task and a plan request wake the coordinator', async () => {
    const pc = await newPc('dr-coord'), agent = agentOn(pc.id, 'dr-coord-a');
    for (const [n, k] of ['task_blocked', 'task_approved', 'plan_request'].entries()) {
      app.keys.notify(agent, k, 'x', { task: `task_dc${n}`, state: 'x' });
    }
    const [o] = await orders(pc);
    expect(o!.payload.items.map((i: { notice: string }) => i.notice)).toEqual(['task_blocked', 'task_approved', 'plan_request']);
    app.keys.notify(agent, 'replan_requested', 'x', {});
    expect(await orders(pc)).toHaveLength(0); // still no order for the others
  });

  it('notices that need no action wait for the next prompt: a question asked or answered, a task awaiting approval, a resume without work', async () => {
    const pc = await newPc('dr-quiet'), agent = agentOn(pc.id, 'dr-quiet-a');
    for (const k of ['decision_asked', 'decision_update', 'task_awaiting_approval', 'team_resumed_note']) app.keys.notify(agent, k, 'x', {});
    expect(await orders(pc)).toHaveLength(0);
    // A resume for a member with work still wakes it.
    app.keys.notify(agent, 'team_resumed', 'x', {});
    const [o] = await orders(pc);
    expect(o!.payload.items.map((i: { notice: string }) => i.notice)).toEqual(['team_resumed']);
  });

  it("a delivery order's agent and reason are columns; the retention job prunes finished orders after 30 days and keeps an open disconnect", async () => {
    const pc = await newPc('dr-prune'), agent = agentOn(pc.id, 'dr-prune-a');
    app.keys.notify(agent, 'task_assigned', 'x', { task: 'task_dp1', state: 'assigned' });
    const [o] = await orders(pc);
    expect(app.db.prepare('SELECT agent_id, order_reason FROM pc_actions WHERE id=?').get(o!.id)).toEqual({ agent_id: agent, order_reason: null });
    await cn('POST', `/orders/${o!.id}/result`, pc.key, { state: 'done' });
    const ins = app.db.prepare('INSERT INTO pc_actions(id,machine_id,kind,state,payload,created_at,created_by,finished_at,expires_at,ended_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
    const old = Date.now() - 40 * 86400_000;
    ins.run('pca_pruneold00001', pc.id, 'check', 'done', '{}', old, 'x', old, old + 1, null);
    ins.run('pca_prunefresh001', pc.id, 'check', 'done', '{}', Date.now(), 'x', Date.now(), Date.now() + 1, null);
    ins.run('pca_prunedsc00001', pc.id, 'disconnect', 'needs_attention', '{}', old, 'x', old, old + 1, null);
    ins.run('pca_prunedsc00002', pc.id, 'disconnect', 'removed', '{}', old, 'x', old, old + 1, old);
    const out = await app.maintenance.run();
    expect(out.pruned!.pc_actions).toBeGreaterThanOrEqual(2);
    const ids = (app.db.prepare("SELECT id FROM pc_actions WHERE id LIKE 'pca_prune%' ORDER BY id").all() as { id: string }[]).map((r) => r.id);
    expect(ids).toEqual(['pca_prunedsc00001', 'pca_prunefresh001']);
    expect(app.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='pc_actions_kind_state'").get()).toBeTruthy();
  });
});
