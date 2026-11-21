/**
 * The hub's identity for connector pairing (docs/connector.md, "Add PC: download and pairing"): one stable id per hub,
 * made the first time it is asked for and kept in its settings, the HTTPS origin a code is bound to, and the short CA
 * check the console shows beside the pairing code.
 */
import type { Db } from '../db/db.js';
import { randomToken } from '../util/crypto.js';

export const HUB_ID_RE = /^hub-[a-z2-7]{12}$/;
/** A pairing code is valid for 30 minutes, the same lifetime as a checkout's code (review v2 §1 point 1). */
export const PAIRING_MS = 30 * 60_000;

/** The hub's id, `hub-` and 12 base32 characters. Two calls on a new hub agree: the first insert wins. */
export function hubIdentity(db: Db): string {
  const read = () => {
    const r = db.prepare("SELECT value FROM system_settings WHERE key='hub_id'").get() as { value: string } | undefined;
    try { const v = r ? JSON.parse(r.value) : null; return typeof v === 'string' && HUB_ID_RE.test(v) ? v : null; } catch { return null; }
  };
  const have = read();
  if (have) return have;
  db.prepare("INSERT INTO system_settings(key,value,updated_at) VALUES ('hub_id',?,?) ON CONFLICT(key) DO NOTHING").run(JSON.stringify(`hub-${randomToken(10).slice(0, 12)}`), Date.now());
  return read()!;
}

/** The origin a pairing code is bound to: the hub's public URL when it is HTTPS, otherwise null (nothing to pin). */
export function httpsOrigin(url: string | null | undefined): string | null {
  try { const u = new URL(String(url)); return u.protocol === 'https:' ? u.origin : null; } catch { return null; }
}

/** The short CA check the console shows and the PC's user types: the first 16 hex characters, in groups of four. */
export const caCheck = (sha256: string): string => sha256.slice(0, 16).match(/.{4}/g)!.join(' ');

/** What the refused-code line says, in the prompt, the installer and the docs (review v2, point 4). */
export const REFUSED_CODE_LINE = 'This code was refused. If you just received it, tell the operator now: someone else may have used it.';

/** What the prompt tells the agent about the code (review v3, point a). */
export const CODE_RULE_LINE = "Pass the code only to the installer command. Don't repeat it, save it or send it anywhere.";

/** What the agent says and does when its tool cannot pipe standard input (review v3, point b). */
export const NO_PIPE_LINE = 'My tool cannot pass the code safely on standard input, so I stopped. Run the installer yourself in a terminal.';

/** The prompt's input: the hub (or relay) it pins and the installer to fetch and check. Nothing in it is secret. */
export interface ConnectorPromptIn {
  hubUrl: string; relay?: string; caSha256: string;
  /** The newest approved connector version; null while none is approved. */
  version: string | null;
  /** Where the installer is downloaded from (the Releases page, or the relay's release files); null when the hub has none. */
  downloadUrl: string | null;
  /** The installer file's SHA-256 when the hub holds the file (CONNECTOR_RELEASE_DIR); null otherwise. */
  installerSha256: string | null;
}

/**
 * The one prompt (docs/onboarding.md, "The prompt"): the same text for every PC of this hub. It holds only the hub's
 * address, its CA fingerprint and the installer to check, none of it secret, so it may be shared freely. The code is not
 * in it: the agent asks the user for the code and passes it to the installer on standard input (`--pair -`), never as an
 * argument or in a file. The connector checks the origin and the CA before it sends the code. The hub then says what the
 * code is for: a code from Add PC lets the agent ask what the user needs; an invite joins its one team and role and asks nothing.
 */
export function connectorPrompt(o: ConnectorPromptIn): string {
  const file = `conclave-install-${o.version ?? '<version>'}.mjs`;
  const from = o.downloadUrl ? `from ${o.downloadUrl}` : "from the connector's release files (ask the operator where they are)";
  const want = o.installerSha256 ? `It must print ${o.installerSha256}.` : `It must match the line for ${file} in SHA256SUMS on the same release page.`;
  return [
    `Connect this PC to Conclave (hub ${o.hubUrl}${o.relay ? `, through relay "${o.relay}"` : ''}). It takes a few minutes and one code.`,
    '',
    'You are the agent on this PC. Run the commands below as written, one at a time, and stop at the first one that fails. Ask one question at a time, offer a default, and explain only when asked.',
    '',
    "1. Check Node.js with `node --version` (20 or later). If it is missing or older, give the user the install command for this platform and wait: Windows `winget install OpenJS.NodeJS.LTS`, macOS `brew install node`, Linux the distribution's nodejs package (20 or later).",
    `2. Download ${file} ${from} into the current folder.`,
    `3. Check the file before running it: Windows \`certutil -hashfile ${file} SHA256\`, macOS \`shasum -a 256 ${file}\`, Linux \`sha256sum ${file}\`. ${want} If it does not match, stop and tell the user.`,
    `4. Ask the user for their Conclave code. It starts with cnc-pair- and is in their Conclave console. ${CODE_RULE_LINE}`,
    `5. Install the connector and pair it, with the code on standard input: \`node ${file} --pair - --hub ${o.hubUrl} --ca ${o.caSha256}\`, writing the code to its standard input. If your tool cannot do that, tell the user exactly: "${NO_PIPE_LINE}" and stop.`,
    "   - If it says the hub's certificate does not match, stop. Do not try another address.",
    `   - If it says the code was refused, tell the user exactly: "${REFUSED_CODE_LINE}"`,
    '   - If it says this PC joined the team from an invite, there is nothing to ask: go to step 8. If it says to finish with `conclave setup continue --wait 30`, run that first.',
    '6. Run `conclave setup choices`. Ask: "Do you need a new project, a new team in a project, or another agent for a team on this PC?" and show the projects and teams it lists.',
    '   - A new project: ask for its name and its goal in one sentence.',
    '   - A new team: ask what it should do. Propose the roles and the rules yourself; the user says OK or changes them.',
    '   - An agent for a team: ask which role.',
    '7. Draft the request as a JSON file (`conclave setup schema` prints its shape), check it with `conclave setup request --file <path> --check`, fix what it reports, then file it with `conclave setup request --file <path>`. The operator approves it in the Conclave console.',
    "8. Tell the user the connector sets up the agents by itself, and its screen shows each one with the way to open it.",
  ].join('\n');
}
