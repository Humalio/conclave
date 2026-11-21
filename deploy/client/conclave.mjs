#!/usr/bin/env node
/**
 * conclave: the Conclave connector's command line (docs/connector.md). Node 18 or later, no dependencies.
 *
 *   conclave mcp <folder>                 the folder's local stdio MCP server (started by Claude Code or Codex)
 *   conclave check [--folder <f>] [--probe] [--json]
 *                                         local and read-only: one fixed reason, or "set up". --probe asks the hub once.
 *   conclave repair [--folder <f>] [--grant-trust] [--accept-folder-changes]
 *                                         rewrites a moved entry, restores a trust entry that disappeared; never turns
 *                                         trust back on after you turned it off unless you say so
 *   conclave migrate [--apply | --rollback | --finish [--remove-legacy-ca]] [--https-origin <u> --ca-file <pem> --ca-sha256 <hex>]
 *                                         moves an old PC to the connector: a plan by default, a rollback after
 *   conclave register --folder <f> --hub-id <id> --ca-sha256 <hex> --agent <label>
 *                                         binds a folder and writes its entry (pairing and setup call this)
 *   conclave sync add <hub> <folder> [--name n] | list [--json] | pause <name> | resume <name> | remove <name>
 *                                         a read-only mirror of a vault reader's scope in a folder (docs/vault-sync.md); the code is read from stdin
 *   conclave destinations [add <folder> [--label t] | remove <id>] [--json]
 *                                         the folders you approved for a restored team (the hub sees a label, never the path)
 *   conclave restores                     how to open each agent of the teams restored on this PC
 *   conclave usage [on | off] [--json] [--days n]
 *                                         usage reports: turns them on or off on this PC, or shows what would be sent
 *                                         (numbers only, from the connector's registered worker sessions)
 *   conclave hardware [on | off]          on a compute machine: measuring its CPU, memory and GPU use for the hub, on or off
 *                                         (the whole machine, numbers only; docs/hardware.md#measuring)
 *   conclave service install | remove | status
 *                                         the logon service, as the user (no admin rights)
 *   conclave service run                  what the logon entry starts: a supervisor that keeps the worker running
 *   conclave update [--check]             update to the newest approved version now, or only say which it would be
 *   conclave rollback                     back to the previous verified build kept on this PC
 *   conclave settings [<switch> on|off]   the PC user's switches: auto-update, remote-cleanup, usage, …
 *   conclave setup [--no-browser]       the local screen: pairing, then setup of each agent (Continue setup, Retry)
 *   conclave setup schema               the team request's shape and rules, for the coding agent drafting it
 *   conclave setup request --file <path> [--check] [--hub <hub id>]
 *                                         check the request, then file it (no key or code passes through the agent)
 *   conclave setup continue [--wait <s>] [--hub <hub id>]
 *                                         one step of setup: wait for approval, pick up, build and register folders
 *   conclave setup status [--json] [--hub <hub id>]    each agent: Waiting for approval, Ready to open, Connected, Key refused
 *   conclave setup retry <agent> [--hub <hub id>]      rebuild one agent's folder
 *   conclave setup withdraw [--hub <hub id>]           withdraw this PC's request (also one a Re-enrol reopened)
 *   conclave pair --hub <https origin> --check <hub check>
 *                                         pair without the screen; the code is read from stdin, never the command line
 *   conclave uninstall [--json]           removes what the connector created or changed, for every hub, then the
 *                                         connector itself; keeps and lists anything you edited; resumes if interrupted
 *   conclave disconnect --hub-id <id> --ca-sha256 <hex> [--json]
 *                                         finishes Disconnect this hub from this PC for one hub (the service calls this)
 *   conclave version
 *
 * Without --folder the working folder is used. CONCLAVE_HOME overrides ~/.config/conclave; CLAUDE_CONFIG_DIR is honoured
 * for ~/.claude.json like Claude Code does. Exit codes: 0 ok, 1 a problem was reported, 2 usage, 3 the user must decide.
 * Output never contains a key or a token.
 */
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { confDir } from './connector/paths.mjs';
import { runMcp } from './connector/mcpserver.mjs';
import { runCheck } from './connector/check.mjs';
import { registerFolder, repairFolder } from './connector/register.mjs';
import { runHook, lineFor, runContextHook } from './connector/hook.mjs';
import { line } from './connector/reasons.mjs';
import { collectUsage, setUsageOptIn } from './connector/usage.mjs';
import { CONNECTOR_VERSION } from './connector/version.mjs';
import { runRemoval, hubsLeft } from './connector/uninstall.mjs';
import { runDisconnect } from './connector/disconnect.mjs';
import { notice, KEPT_WHY } from './connector/notices.mjs';
import { plan, migrate, rollback, finish, dryRunRetired } from './connector/migrate.mjs';
import { readFileSync } from 'node:fs';

const home = confDir();
const claudeJson = process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : join(homedir(), '.claude.json');
const usage = (m) => { process.stderr.write(`conclave: ${m}\nusage: conclave mcp <folder> | check [--folder f] [--probe] [--json] | repair [--folder f] [--grant-trust] [--accept-folder-changes] | register --folder f --hub-id id --ca-sha256 hex --agent label | usage [on|off] [--json] [--days n] | destinations [add folder|remove id] | restores | hardware [on|off] | service install|remove|status|run | install-service | uninstall-service | check --hardened | update [--check] | rollback | settings [switch on|off] | setup [schema|request|continue|status|retry|withdraw] | pair --hub url --check hex | version | uninstall [--json] | disconnect --hub-id id --ca-sha256 hex [--json]\n`); process.exit(2); };

function flags(argv, valued, bool) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (valued.includes(a)) { out[a.slice(2)] = argv[++i]; if (out[a.slice(2)] === undefined) usage(`${a} needs a value`); } else if (bool.includes(a)) out[a.slice(2)] = true;
    else if (a.startsWith('-')) usage(`unknown option ${a}`);
    else out._.push(a);
  }
  return out;
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'mcp') {
  if (rest.length !== 1) usage('mcp needs exactly one agent folder');
  await runMcp(resolve(rest[0]), { home });
  process.exit(0);
} else if (cmd === 'hook') {
  // Claude Code's hook (docs/connector.md, The folder hook): context only, silent on any failure, always exit code 0.
  // The folder comes from --folder alone; nothing here may print a usage error or exit non-zero.
  try {
    const i = rest.indexOf('--folder'), folder = i >= 0 ? rest[i + 1] : null;
    let input = '';
    if (folder) { process.stdin.setEncoding('utf8'); for await (const c of process.stdin) { input += c; if (input.length > 1_000_000) break; } }
    const out = folder ? await runHook(home, resolve(folder), input) : null;
    if (out) process.stdout.write(out + '\n');
  } catch { /* nothing to add */ }
  process.exit(0);
} else if (cmd === 'context-hook') {
  // The silent context hook (docs/connector.md, Context size): reads numbers at Stop and PostToolUse and prints nothing,
  // ever, not even on a failure (proof 1: a Stop hook that prints loops the turn). Always exit code 0.
  try {
    const i = rest.indexOf('--folder'), folder = i >= 0 ? rest[i + 1] : null;
    let input = '';
    if (folder) { process.stdin.setEncoding('utf8'); for await (const c of process.stdin) { input += c; if (input.length > 1_000_000) break; } }
    if (folder) await runContextHook(home, resolve(folder), input);
  } catch { /* nothing to record */ }
  process.exit(0);
} else if (cmd === 'reminder') {
  // The same line, for the start of a Codex turn: prints it, or nothing; always exit code 0.
  try { const i = rest.indexOf('--folder'), l = await lineFor(home, resolve(i >= 0 && rest[i + 1] ? rest[i + 1] : '.')); if (l) process.stdout.write(l + '\n'); } catch { /* nothing to add */ }
  process.exit(0);
} else if (cmd === 'check') {
  const f = flags(rest, ['--folder'], ['--probe', '--json', '--hardened']);
  if (f.hardened) {
    const { g6aProbe } = await import('./connector/vaultservice.mjs');
    const g = await g6aProbe(home);
    if (f.json) process.stdout.write(JSON.stringify(g) + '\n');
    else { process.stdout.write(`${g.ok ? 'OK: no process of this user can read a key (G6(a) passes).' : 'PROBLEM: G6(a) does not pass on this PC.'}\n`); for (const s of g.steps) process.stdout.write(`  ${s.ok ? 'ok ' : 'FAIL'} ${s.step}\n`); }
    process.exit(g.ok ? 0 : 1);
  }
  const r = await runCheck(home, resolve(f.folder ?? '.'), { claudeJson, probe: !!f.probe });
  if (f.json) process.stdout.write(JSON.stringify(r) + '\n');
  else { process.stdout.write(`${r.ok ? 'OK' : 'PROBLEM'}: ${r.line}\n`); for (const s of r.steps) process.stdout.write(`  ${s.offer ? 'tip ' : s.ok ? 'ok ' : 'FAIL'} ${s.step}\n`); }
  process.exit(r.ok ? 0 : 1);
} else if (cmd === 'repair') {
  const f = flags(rest, ['--folder'], ['--grant-trust', '--accept-folder-changes']);
  const r = repairFolder(home, resolve(f.folder ?? '.'), { claudeJson, grantTrust: !!f['grant-trust'], acceptChanges: !!f['accept-folder-changes'] });
  for (const a of r.actions) process.stdout.write(`done: ${a}\n`);
  for (const a of r.asked) process.stdout.write(`needs you: ${REASON_FOR(a)}\n`);
  process.exit(r.asked.length ? 3 : 0);
} else if (cmd === 'register') {
  const f = flags(rest, ['--folder', '--hub-id', '--ca-sha256', '--agent'], []);
  if (!f.folder || !f['hub-id'] || !f['ca-sha256'] || !f.agent) usage('register needs --folder, --hub-id, --ca-sha256 and --agent');
  try { const r = registerFolder(home, resolve(f.folder), { hubId: f['hub-id'], caSha256: f['ca-sha256'], agent: f.agent, claudeJson }); process.stdout.write(`registered ${r.folder}\n`); } catch (e) { process.stderr.write(`conclave: ${e.message}\n`); process.exit(1); }
} else if (cmd === 'sync') {
  // Vault sync (docs/vault-sync.md, "The connector side"): a read-only mirror of a reader's scope. The code comes on stdin.
  const o = await import('./connector/syncops.mjs');
  const f = flags(rest, ['--name'], ['--json']);
  const [sub, a1, a2] = f._;
  const say = (m) => process.stdout.write(`${m}\n`), err = (m) => { process.stderr.write(`conclave: ${m}\n`); process.exit(1); };
  if (sub === 'add') {
    if (!a1 || !a2) usage('sync add needs a hub and a folder; the code comes on stdin');
    let code = '';
    process.stdin.setEncoding('utf8');
    for await (const c of process.stdin) { code += c; if (code.length > 200) break; }
    const r = await o.syncAdd(home, { hub: a1, folder: a2, name: f.name, code });
    if (!r.ok) err(r.reason);
    say(`sync "${r.name}" added: ${r.folder}. It starts with the connector's next check-in.${r.confirmed ? '' : ' (The hub did not confirm the code yet; it is retried by the hub, nothing is lost.)'}`);
  } else if (sub === 'pause' || sub === 'resume') {
    if (!a1) usage(`sync ${sub} needs a name`);
    const r = o.syncSet(home, a1, sub === 'pause' ? 'paused' : 'active');
    if (!r.ok) err(r.reason);
    say(`sync "${r.name}" ${sub === 'pause' ? 'paused' : 'resumed'}`);
  } else if (sub === 'remove') {
    if (!a1) usage('sync remove needs a name');
    const r = o.syncRemove(home, a1);
    if (!r.ok) err(r.reason);
    say(`sync "${r.name}" removed from this PC. The folder ${r.folder} and its .conclave-trash stay on disk; delete them if you do not want them. The reader stays in the console until the operator removes it there.`);
  } else if (sub === 'list' || sub === undefined) {
    const list = await o.syncList(home);
    if (f.json) say(JSON.stringify(list));
    else if (!list.length) say('no vault sync on this PC (conclave sync add <hub> <folder>, with the pairing code on stdin)');
    else {
      for (const s of list) {
        say(`${s.name}  [${s.state}]  ${s.folder}`);
        say(`  hub ${s.hub_id} · ${s.files} files · ${(s.bytes / 1048576).toFixed(1)} MiB · ${s.last_run_at ? `last run ${s.last_run_at}` : 'not run yet'}`);
        if (s.local_edits) say(`  WARNING: ${s.local_edits} file${s.local_edits === 1 ? ' holds a local edit' : 's hold local edits'}; the next hub change keeps the edit in .conclave-trash and replaces the file`);
        if (s.local_new) say(`  WARNING: ${s.local_new} file${s.local_new === 1 ? ' was' : 's were'} created here and ${s.local_new === 1 ? 'is' : 'are'} not on the hub; ${s.local_new === 1 ? 'it is' : 'they are'} never uploaded and stay as they are (a hub file with the same name would replace ${s.local_new === 1 ? 'it' : 'one'}, keeping yours in .conclave-trash)`);
        for (const w of s.warnings ?? []) say(`  WARNING: ${w}`);
        for (const x of (s.refused ?? []).slice(0, 10)) say(`  refused: ${x.path} (${x.reason})`);
        if (s.last_error) say(`  ${s.last_error}`);
      }
    }
  } else usage('sync takes add <hub> <folder> [--name n], list [--json], pause <name>, resume <name> or remove <name>');
  process.exit(0);
} else if (cmd === 'destinations') {
  const d = await import('./connector/destinations.mjs');
  const f = flags(rest, ['--label'], ['--json']);
  const [sub, arg] = f._;
  if (sub === 'add') {
    if (!arg) usage('destinations add needs a folder');
    const r = d.addDestination(home, resolve(arg), f.label);
    if (!r.ok) { process.stderr.write(`conclave: ${r.reason}\n`); process.exit(1); }
    process.stdout.write(`${r.existed ? 'already approved' : 'approved'}: ${r.destination.label} (${r.destination.id}). The hub sees the label only, never the folder.\n`);
  } else if (sub === 'remove') {
    if (!arg) usage('destinations remove needs an id');
    process.stdout.write(d.removeDestination(home, arg) ? 'removed\n' : 'no destination with that id\n');
  } else if (sub === undefined) {
    const list = d.listDestinations(home);
    if (f.json) process.stdout.write(JSON.stringify(list.map(({ id, label }) => ({ id, label }))) + '\n');
    else if (!list.length) process.stdout.write('no restore destination is approved on this PC (conclave destinations add <folder>)\n');
    else for (const x of list) process.stdout.write(`${x.id}  ${x.label}  ${x.path}\n`);
  } else usage('destinations takes add <folder> [--label t], remove <id> or nothing');
  process.exit(0);
} else if (cmd === 'restores') {
  // The start lines of the teams restored on this PC (also on the local screen): one command per agent.
  const { finishedLines } = await import('./connector/restore.mjs');
  const { readKeyFile } = await import('./connector/keyfile.mjs');
  const kf = readKeyFile(home);
  let any = false;
  if (kf.ok) for (const k of Object.keys(kf.data.hubs)) for (const r of finishedLines(home, k)) { any = true; process.stdout.write(`restore ${r.checkout_id}:\n`); for (const l of r.lines) process.stdout.write(`  ${l}\n`); }
  if (!any) process.stdout.write('no restored team on this PC\n');
  process.exit(0);
} else if (cmd === 'hardware') {
  const { readSettings, setSwitch } = await import('./connector/settings.mjs');
  if (rest.length > 1 || (rest[0] && !['on', 'off'].includes(rest[0]))) usage('hardware takes on, off or nothing');
  if (rest[0]) setSwitch(home, 'hardware', rest[0] === 'on');
  const on = readSettings(home).hardware_opt_in === true;
  process.stdout.write(on ? "measuring is on: a hub that has this PC as a compute machine gets the whole machine's CPU, memory and GPU use once a minute, numbers only\n"
    : 'measuring is off: nothing is measured or sent; what the hub already has is kept under its retention rule (conclave hardware on turns it on)\n');
  process.exit(0);
} else if (cmd === 'usage') {
  const f = flags(rest, ['--days'], ['--json']);
  if (f._.length > 1 || (f._[0] && !['on', 'off'].includes(f._[0]))) usage('usage takes on, off or nothing');
  if (f._[0]) {
    setUsageOptIn(home, f._[0] === 'on');
    process.stdout.write(f._[0] === 'on' ? "usage reports are on: numbers only, from the connector's worker sessions\n" : 'usage reports are off: nothing new is sent; what the hub already has is kept under its retention rule\n');
    process.exit(0);
  }
  const days = f.days === undefined ? 30 : Number(f.days);
  if (!Number.isInteger(days) || days < 1 || days > 400) usage('--days is a whole number from 1 to 400');
  const r = await collectUsage(home, { days });
  if (f.json) {
    process.stdout.write(JSON.stringify({ opted_in: r.opted_in, sessions: r.sessions.map(({ client, agent_id, source, unknown, usage: u }) => ({ client, agent_id, source, unknown, usage: u })), hubs: r.hubs }) + '\n');
    process.exit(0);
  }
  process.stdout.write(`usage reports: ${r.opted_in ? 'on' : 'off (conclave usage on turns them on)'}\n`);
  for (const s of r.sessions) {
    if (s.unknown) { process.stdout.write(`  ${s.client} ${s.agent_id}: Unknown (a format this connector does not read)\n`); continue; }
    const t = s.usage.reduce((a, u) => ({ input: a.input + u.input, output: a.output + u.output, turns: a.turns + u.turns }), { input: 0, output: 0, turns: 0 });
    process.stdout.write(`  ${s.client} ${s.agent_id}: ${t.input} in, ${t.output} out, ${t.turns} turns\n`);
  }
  process.exit(0);
} else if (cmd === 'setup' || cmd === 'pair') {
  process.exit(await setupCmd(cmd, rest));
} else if (cmd === 'version') {
  process.stdout.write(`${CONNECTOR_VERSION}\n`);
} else if (cmd === 'install-service' || cmd === 'uninstall-service') {
  // Hardened isolation (docs/connector.md): an administrator's step. This command never changes anything without admin rights.
  const { installVault, uninstallVault, VAULT_LINES } = await import('./connector/vaultservice.mjs');
  const f = flags(rest, ['--home'], ['--json']);
  const here = dirname(fileURLToPath(import.meta.url));
  // Elevated, the PC user's folder is not this account's: --home, CONCLAVE_HOME or SUDO_USER say whose it is.
  const { serviceHome } = await import('./connector/vaultservice.mjs');
  const sh = serviceHome({ flag: f.home });
  const r = cmd === 'install-service' ? await installVault(sh.home, { appSource: here }) : await uninstallVault(sh.home);
  if (f.json) process.stdout.write(JSON.stringify(r) + '\n');
  else if (r.ok) process.stdout.write(cmd === 'install-service'
    ? `Hardened isolation is on (keys of ${sh.home}): the Conclave key service holds ${r.agents} agent key(s) of ${r.hubs} hub(s), and this PC user can no longer read one. Keys the user could read before this are not changed and still work: if a leak is suspected, rotate the agent keys now. Switch hardened off with: conclave uninstall-service\n`
    : r.already ? 'This PC already runs at Standard isolation.\n' : `Standard isolation is back: ${r.agents} agent key(s) of ${r.hubs} hub(s) are in your own key file again, none lost, and the key service is removed.\n`);
  else process.stderr.write(`conclave: ${VAULT_LINES[r.reason] ?? r.reason}${r.detail ? ` (${r.detail})` : ''}${r.rolled_back ? ' Nothing was changed: every agent keeps working as before.' : ''}\n`);
  process.exit(r.ok ? 0 : 1);
} else if (cmd === 'vault') {
  // The key service itself (run by the service manager, as its own account): `conclave vault run --vault D --view V --address A`.
  const f = flags(rest.slice(1), ['--vault', '--view', '--address'], []);
  if (rest[0] !== 'run' || !f.vault || !f.view || !f.address) usage('vault run needs --vault, --view and --address');
  process.env.CONCLAVE_KEY_STORE = 'file';
  const { startVault } = await import('./connector/vault.mjs');
  const v = await startVault({ dir: f.vault, view: f.view, address: f.address, log: (m) => process.stderr.write(`${new Date().toISOString()} ${m}\n`) });
  for (const s of ['SIGINT', 'SIGTERM']) process.once(s, () => v.close().then(() => process.exit(0)));
} else if (cmd === 'service') {
  const svc = await import('./connector/service.mjs');
  const sub = rest[0];
  if (sub === 'install') {
    const { adoptRunning, writeLauncher, launcherPath, appDir } = await import('./connector/builds.mjs');
    const { record } = await import('./connector/manifest.mjs');
    adoptRunning(home, resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'), CONNECTOR_VERSION);
    writeLauncher(home);
    const r = svc.installService(home);
    if (!r.ok) { process.stderr.write(`conclave: the service could not be installed: ${r.detail || r.reason}\n`); process.exit(1); }
    const cx = { home, claudeJson, folders: [], serviceTargets: svc.serviceTargets(home) };
    record(home, { kind: 'service_entry', target: r.place.target, pointer: null, before: null, installed: { kind: r.place.kind, name: r.place.name } }, cx);
    record(home, { kind: 'launcher', target: launcherPath(home), pointer: null, before: null, installed: 'launcher' }, cx);
    record(home, { kind: 'app_build', target: appDir(home), pointer: null, before: null, installed: 'builds' }, cx);
    process.stdout.write(`The Conclave connector service is installed for this user and starts at logon (${r.place.name}).\n`);
  } else if (sub === 'remove') {
    const { forget } = await import('./connector/manifest.mjs');
    const r = svc.removeService(home);
    for (const pl of r.removed) forget(home, 'service_entry', pl.target);
    process.stdout.write('The Conclave connector service is removed; it no longer starts at logon.\n');
  } else if (sub === 'status') {
    const s = svc.serviceStatus(home);
    process.stdout.write(`${s.installed ? 'installed' : 'not installed'} (${s.place.name})${s.state ? `, ${s.state}` : ''}, ${s.running ? 'running' : 'not running'}\n`);
    process.exit(s.installed ? 0 : 1);
  } else if (sub === 'run') {
    const { runSupervisor, holderText, LOCKED } = await import('./connector/worker.mjs');
    try { const rf = svc.refreshService(home); if (rf.error) process.stderr.write(`conclave: the service task was not updated: ${rf.error}
`); } catch { /* the service runs on the task it has */ }
    const r = await runSupervisor({ home });
    if (r.locked) { process.stderr.write(`conclave: the connector service is already running (${holderText(r.locked)}); this one stops.\n`); process.exit(LOCKED); }
    process.exit(0);
  } else if (sub === 'worker') {
    const { runWorker, holderText, RESTART, NO_HUBS, LOCKED } = await import('./connector/worker.mjs');
    const ac = new AbortController();
    for (const s of ['SIGINT', 'SIGTERM']) process.once(s, () => ac.abort());
    // The worker starts through the launcher on the newest build, so this is where an update's new task definition is applied.
    try { const rf = svc.refreshService(home); if (rf.error) process.stderr.write(`conclave: the service task was not updated: ${rf.error}
`); } catch { /* the service runs on the task it has */ }
    const why = await runWorker({ home, signal: ac.signal, claudeJson });
    if (why === 'locked') {
      const { lockHolder } = await import('./connector/processes.mjs');
      process.stderr.write(`conclave: another connector worker is running (${holderText(lockHolder(svc.workerLockPath(home)))}); this one stops.\n`);
      process.exit(LOCKED);
    }
    process.exit(why === 'restart' ? RESTART : why === 'no_hubs' ? NO_HUBS : 0);
  } else usage('service needs install, remove, status or run');
} else if (cmd === 'update') {
  const f = flags(rest, [], ['--check']);
  const { readKeyFile } = await import('./connector/keyfile.mjs');
  const { connect, request } = await import('./connector/hubclient.mjs');
  const { updateTo, pickUpdate, updateLine, failedVersions } = await import('./connector/update.mjs');
  const kf = readKeyFile(home);
  if (!kf.ok) { process.stderr.write(`conclave: ${line(kf.reason)}\n`); process.exit(1); }
  let approved = null;
  for (const s of Object.values(kf.data.hubs)) {
    const c = connect(s);
    if (!c.ok) continue;
    const r = await request(c.hub, 'GET', '/connector/v1/versions/approved', { headers: { Authorization: `Bearer ${s.app_key}` } }).catch(() => null);
    if (r?.status === 200 && Array.isArray(r.json?.versions)) { approved = r.json.versions; break; }
  }
  if (!approved) { process.stderr.write('conclave: no hub answered with its approved versions.\n'); process.exit(1); }
  const want = pickUpdate(approved, CONNECTOR_VERSION, failedVersions(home));
  if (!want) { process.stdout.write(`Version ${CONNECTOR_VERSION} is the newest approved version.\n`); process.exit(0); }
  if (f.check) { process.stdout.write(`Version ${want} is approved; this PC runs ${CONNECTOR_VERSION}.\n`); process.exit(0); }
  const u = await updateTo(home, { version: want, approved });
  if (!u.ok) { process.stderr.write(`conclave: ${updateLine(u.reason)}\n`); process.exit(1); }
  process.stdout.write(`Updated to ${want}. The service starts on it at its next restart.\n`);
} else if (cmd === 'rollback') {
  const { rollback } = await import('./connector/builds.mjs');
  const r = rollback(home);
  if (!r.ok) { process.stderr.write(r.reason === 'no_previous_build' ? 'conclave: there is no previous build on this PC.\n' : r.reason === 'keys_unreadable' ? `conclave: version ${r.version} cannot read an encrypted key file, and this one cannot be decrypted (${r.detail}), so the PC stays on this version.\n` : 'conclave: the previous build was never verified, or its files changed, so it is not used.\n'); process.exit(1); }
  process.stdout.write(`Back on version ${r.version}.\n`);
} else if (cmd === 'settings') {
  const { readSettings, setSwitch, SWITCHES } = await import('./connector/settings.mjs');
  if (rest.length === 0) { const s = readSettings(home); for (const [n, k] of Object.entries(SWITCHES)) process.stdout.write(`${n}: ${s[k] === null ? 'not set' : s[k] ? 'on' : 'off'}\n`); }
  else if (rest.length === 2 && SWITCHES[rest[0]] && ['on', 'off'].includes(rest[1])) { setSwitch(home, rest[0], rest[1] === 'on'); process.stdout.write(`${rest[0]}: ${rest[1]}\n`); }
  else usage(`settings takes one of ${Object.keys(SWITCHES).join(', ')} and on or off`);
} else if (cmd === 'uninstall') {
  const f = flags(rest, [], ['--json']);
  const hubs = hubsLeft(home).length;
  const r = runRemoval(home, { kind: 'all' }, { claudeJson });
  if (f.json) process.stdout.write(JSON.stringify(r) + '\n');
  else {
    process.stdout.write((r.done ? notice(r.kept.length ? 'uninstall_kept' : 'uninstall_done', { count: r.kept.length }) : 'Conclave could not finish removing itself; run conclave uninstall again to resume.') + '\n');
    for (const k of r.kept) process.stdout.write(`  kept: ${k.target} (${KEPT_WHY[k.reason] ?? k.reason})\n`);
    if (hubs) process.stdout.write(notice('uninstall_offline') + '\n');
  }
  process.exit(r.done ? 0 : 1);
} else if (cmd === 'disconnect') {
  const f = flags(rest, ['--hub-id', '--ca-sha256'], ['--json']);
  if (!f['hub-id'] || !f['ca-sha256']) usage('disconnect needs --hub-id and --ca-sha256');
  const r = await runDisconnect(home, { hubId: f['hub-id'], caSha256: f['ca-sha256'] }, { claudeJson });
  if (f.json) process.stdout.write(JSON.stringify(r) + '\n');
  else { if (r.notice) process.stdout.write(r.notice + '\n'); for (const k of r.kept) process.stdout.write(`  kept: ${k.target} (${KEPT_WHY[k.reason] ?? k.reason})\n`); }
  process.exit(r.state === 'resume_later' ? 1 : 0);
} else if (cmd === 'migrate') {
  const f = flags(rest, ['--https-origin', '--ca-file', '--ca-sha256'], ['--apply', '--rollback', '--finish', '--remove-legacy-ca']);
  const say = (ls) => { for (const l of ls) process.stdout.write(`  ${l}\n`); };
  const nothing = (r) => process.stdout.write(r.reason === 'retired_agents_remain' ? 'not finished: retired agents are still on this PC\n' : `nothing to do: ${r.reason}\n`);
  if (f.rollback) { const r = rollback(home); if (r.ok) process.stdout.write('rolled back\n'); else nothing(r); say(r.lines); process.exit(r.ok ? 0 : 1); }
  if (f.finish) { const r = finish(home, { removeLegacyCa: !!f['remove-legacy-ca'] }); if (r.ok) process.stdout.write('finished\n'); else nothing(r); say(r.lines); process.exit(r.ok ? 0 : 1); }
  let https = null;
  if (f['https-origin']) { try { https = { origin: f['https-origin'], caPem: readFileSync(f['ca-file'] ?? '', 'utf8'), caSha256: f['ca-sha256'] ?? '' }; } catch { usage('--https-origin needs --ca-file (a readable PEM) and --ca-sha256'); } }
  const o = { claudeJson, https };
  if (!f.apply) { const p = plan(home, o); process.stdout.write(p.ok ? 'PLAN (nothing changed; add --apply to do it):\n' : 'BLOCKED:\n'); say(p.problems.map((x) => `problem: ${x}`)); say(p.steps ?? []); if (p.ok) say(await dryRunRetired(home, p)); process.exit(p.ok ? 0 : 1); }
  const r = await migrate(home, o);
  process.stdout.write(r.ok ? 'moved to the connector\n' : `not moved: ${r.reason}${r.rolledBack ? ' (rolled back)' : ''}\n`);
  say(r.lines); process.exit(r.ok ? 0 : 1);
} else usage(cmd ? `unknown command ${cmd}` : 'a command is needed');

/** `conclave setup …` and `conclave pair` (docs/onboarding.md, "With the Conclave connector"). Returns the exit code. */
async function setupCmd(cmd, argv) {
  const { readKeyFile } = await import('./connector/keyfile.mjs');
  const pickHub = (want) => {
    const kf = readKeyFile(home);
    if (!kf.ok) { process.stderr.write(`conclave: ${line(kf.reason)}\n`); return null; }
    const all = Object.entries(kf.data.hubs).filter(([, s]) => !want || s.hub_id === want);
    if (all.length === 1) return all[0][0];
    process.stderr.write(all.length ? 'conclave: this PC is paired with more than one hub; name one with --hub <hub id>.\n' : 'conclave: this PC is not paired with that hub yet. Run conclave setup to pair.\n');
    return null;
  };
  if (cmd === 'pair') {
    const f = flags(argv, ['--hub', '--check'], []);
    if (!f.hub || !f.check) usage('pair needs --hub and --check; the code comes on stdin');
    const { pair, PAIR_LINES } = await import('./connector/pairing.mjs');
    let code = '';
    for await (const c of process.stdin) { code += c; if (code.length > 200) break; }
    const r = await pair(home, { origin: f.hub, check: f.check, code: code.trim() });
    process[r.ok ? 'stdout' : 'stderr'].write(`${r.ok ? PAIR_LINES.paired : `conclave: ${PAIR_LINES[r.reason] ?? r.reason}`}\n`);
    // What the code was for, as fixed words an installer or an agent can read: `code_kind: pc`, or `code_kind: invite <id>`.
    if (r.ok) process.stdout.write('hub: ' + String(r.hub?.id ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) + '\n' + 'code_kind: ' + r.kind + (r.invite?.id ? ' ' + String(r.invite.id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) : '') + '\n');
    // 3: the hub is not the one given (nothing was sent) or it changed; 1: anything else.
    return r.ok ? 0 : ['ca_changed', 'origin_changed', 'ca_mismatch', 'origin_mismatch', 'tls_refused', 'no_ca', 'ca_bundle'].includes(r.reason) ? 3 : 1;
  }
  const sub = argv[0] && !argv[0].startsWith('-') ? argv[0] : null;
  const args = sub ? argv.slice(1) : argv;
  if (!sub) {
    const f = flags(args, [], ['--no-browser']);
    const { startScreen, openBrowser } = await import('./connector/screen.mjs');
    const s = await startScreen(home, { claudeJson });
    const opened = !f['no-browser'] && openBrowser(s.url);
    process.stdout.write(`${opened ? 'The Conclave setup screen is open in your browser.' : 'Open this address in your browser on this PC (it works once):'}\n${opened ? '' : s.url + '\n'}It closes after an hour without a visit, or with Ctrl+C.\n`);
    process.once('SIGINT', () => s.close());
    await s.closed;
    return 0;
  }
  if (sub === 'schema') {
    const { SCHEMA, EXAMPLE } = await import('./connector/request.mjs');
    process.stdout.write('The team request (JSON) that `conclave setup request --file <path>` files. Limits are the hub defaults; the hub checks its current settings.\n');
    for (const [k, v] of Object.entries(SCHEMA)) process.stdout.write(`  ${k}: ${v}\n`);
    process.stdout.write(`Example:\n${JSON.stringify(EXAMPLE, null, 2)}\n`);
    return 0;
  }
  const ob = await import('./connector/onboard.mjs');
  if (sub === 'request') {
    const f = flags(args, ['--file', '--hub', '--root'], ['--check']);
    if (!f.file) usage('setup request needs --file <path>');
    let body;
    try { body = JSON.parse((await import('node:fs')).readFileSync(resolve(f.file), 'utf8')); } catch { process.stderr.write(`conclave: ${f.file} cannot be read as JSON.\n`); return 2; }
    const hubKey = f.check ? null : pickHub(f.hub);
    if (!f.check && !hubKey) return 1;
    try {
      const r = await ob.fileRequest(home, hubKey, body, { check: !!f.check, root: f.root });
      if (!r.ok) { process.stdout.write('The request has problems:\n'); for (const x of r.problems) process.stdout.write(`- ${x.field}: ${x.rule}\n`); return 2; }
      process.stdout.write(`${f.check ? 'The request is valid.' : `Filed request ${r.request_id} (${r.state}).`} Summary:\n${r.summary}\n`);
      if (!f.check) process.stdout.write('Your administrator approves it in the Conclave console. The connector\'s screen (conclave setup) shows each agent once it is approved.\n');
      return 0;
    } catch (e) { process.stderr.write(`conclave: ${e.message}\n`); if (Array.isArray(e.hub?.problems)) for (const x of e.hub.problems) process.stderr.write(`- ${x.field}: ${x.rule}\n`); return 1; }
  }
  const f = flags(args.filter((a, i) => !((sub === 'retry' || sub === 'redeem') && i === 0)), ['--hub', '--wait', '--root', '--client'], ['--json']);
  const hubKey = pickHub(f.hub);
  if (!hubKey) return 1;
  try {
    if (sub === 'choices') { process.stdout.write(JSON.stringify(await ob.choices(home, hubKey)) + '\n'); return 0; }
    if (sub === 'redeem') {
      if (!args[0] || args[0].startsWith('-')) usage('setup redeem needs the invite id');
      const r = await ob.redeemInvite(home, hubKey, args[0], { root: f.root, client: f.client });
      if (!r.ok) { process.stderr.write('conclave: ' + r.message + '\n'); return 1; }
      process.stdout.write('Redeemed the invite: request ' + r.request_id + ' (' + r.state + '). Run conclave setup continue --wait 30 to pick up the keys and build the folder.\n');
      return 0;
    }
    if (sub === 'continue') {
      const r = await ob.advance(home, hubKey, { waitS: Number(f.wait ?? 0) || 0, claudeJson });
      process.stdout.write(`${r.phase === 'waiting' ? (r.declined ? 'The key pickup was declined on this PC. The PC user can still allow it on the connector screen (conclave setup).' : r.stage === 'allow' ? 'Approved. Waiting for the PC user to press Allow on the connector screen (conclave setup) before the keys are picked up.' : 'Waiting for your administrator to approve the request.') : r.phase === 'changes' ? `Changes asked by your administrator (their words): ${r.note ?? ''}` : r.phase === 'closed' ? `The request was ${r.state}.` : r.phase === 'no_request' ? 'No team request yet: file one with conclave setup request --file <path>.' : `Set up: ${r.built.join(', ') || 'none'}.${r.failed.length ? ` Not set up: ${r.failed.map((x) => `${x.label} (${x.error})`).join('; ')}.` : ''}`}\n`);
      return r.phase === 'set_up' ? (r.failed.length ? 1 : 0) : r.phase === 'waiting' ? 3 : 1;
    }
    if (sub === 'status') {
      const r = await ob.agentRows(home, hubKey);
      if (f.json) { process.stdout.write(JSON.stringify(r.agents) + '\n'); return 0; }
      if (r.hub === 'key_refused') process.stdout.write('The hub refused this PC\'s key: no agent here can be shown as connected. Pair again with the code your administrator gives you (conclave pair).\n');
      else if (r.hub === 'unreachable') process.stdout.write('The hub cannot be reached from this PC: the states below are this PC\'s own.\n');
      if (!r.agents.length) process.stdout.write(r.request ? `Request ${r.request.id}: ${r.request.state}.\n` : 'No team request yet.\n');
      for (const a of r.agents) process.stdout.write(`${a.label}: ${a.text}${a.error ? ` (${a.error})` : ''}${a.open && a.state !== 'connected' ? `\n  folder: ${a.open.desktop.folder}\n  terminal: ${a.open.terminal}${a.codex ? `\n  codex: ${a.open.codex}` : ''}` : ''}\n`);
      if (r.git.state !== 'ok') process.stdout.write(`${r.git.line}\n`);
      if (r.git.codex) process.stdout.write(`${r.git.codex}\n`);
      return 0;
    }
    if (sub === 'withdraw') {
      const r = await ob.withdrawRequest(home, hubKey);
      if (!r.ok) { process.stdout.write('No team request on this PC for this hub.\n'); return 1; }
      process.stdout.write(r.already ? `Request ${r.request_id} was already ${r.state}.\n` : `Withdrew request ${r.request_id}. Agents that already joined their team stay. You can file a new request with conclave setup request --file <path>.\n`);
      return 0;
    }
    if (sub === 'retry') {
      if (!args[0] || args[0].startsWith('-')) usage('setup retry needs the agent name');
      const r = ob.retryAgent(home, hubKey, args[0], { claudeJson });
      process[r.ok ? 'stdout' : 'stderr'].write(r.ok ? `${args[0]} is set up.\n` : `conclave: ${r.error}\n`);
      return r.ok ? 0 : 1;
    }
  } catch (e) { process.stderr.write(`conclave: ${e.message}\n`); return 1; }
  usage('setup takes schema, request, choices, redeem, continue, status, retry or withdraw');
}

function REASON_FOR(code) { return code === 'entry_foreign' ? 'this folder has its own MCP entry named conclave; it was left alone.' : line(code).replace(/ Run: .*$/, ''); }
