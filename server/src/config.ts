import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Config {
  dataDir: string;
  dbFile: string;
  vaultDir: string;
  vaultAlias: string;
  port: number;
  host: string;
  pepper: string;
  publicUrl: string;
  production: boolean;
  adminUsername?: string;
  adminPassword?: string;
  publicDir: string;
  logLevel: string;
  /**
   * Which proxies may set X-Forwarded-For (the client address used in audit and rate limits). Default: loopback and
   * private networks, where Caddy runs; set TRUST_PROXY=false when clients reach the hub without the proxy.
   */
  trustProxy?: boolean | string;
  /** Browser Origins allowed to call /mcp (default none). */
  allowedOrigins: string[];
  /** Path of the bridge program served by setup_pc (default: found next to the server or in ../bridge). */
  bridgeFile?: string;
  /** Requests per minute one address may make to the public routes (no key, session or cookie; default 300; 0 turns the limit off). */
  publicRequestsPerMinute?: number;
  /** Messages one session key may send per hour (default 120). */
  messagesPerHour?: number;
  /** Seconds between full vault scans for external changes (default 60; 0 turns the periodic scan off). */
  vaultScanSeconds?: number;
  /** Watch the vault folder for external changes (default true). */
  vaultWatch?: boolean;
  /** Data channel limits (bytes / counts); defaults in app.ts. */
  channelInlineMax?: number; channelBridgeMax?: number; channelPerKey?: number; channelGlobal?: number; channelBytesPerHour?: number; channelBufferBytes?: number; channelIdleMs?: number; shareBytesPerHour?: number;
  /** Alert thresholds (src/safety/alerts.ts) and retention (src/safety/retention.ts) overrides; seconds between maintenance runs (0 = off). */
  alerts?: Partial<import('./safety/alerts.js').AlertOpts>;
  retention?: Partial<import('./safety/retention.js').RetentionConfig>;
  maintenanceSeconds?: number;
  /** Demo mode (DEMO_MODE=1): the console's Replay bar and /api/demo; off by default. A production hub refuses it unless DEMO_ALLOW_PRODUCTION=1. */
  demoMode?: boolean;
  /** Knowledge graph tuning (src/graph/graph.ts), e.g. debounceMs. */
  graph?: Partial<import('./graph/graph.js').GraphOpts>;
  /** Onboarding (docs/onboarding.md): the LAN plain-HTTP URL in the prompt, the hub CA certificate served at /onboard/ca.crt, the client files folder. */
  lanUrl?: string;
  caCertFile?: string;
  clientDir?: string;
  /** CONCLAVE_REPO_HOSTS: the repo host allowlist for checkout handouts until the operator saves one (docs/checkout.md §8). */
  repoHosts?: string[];
  /** CONNECTOR_RELEASE_URL: the GitHub Releases page Add PC links to for the connector download (docs/connector.md). */
  connectorReleaseUrl?: string;
  /** CONNECTOR_RELEASE_DIR: a folder with the signed release files (conclave-connector-<version>.bundle, .json, .json.sig) the hub serves at /connector/v1/release/<tag>/<file>, for PCs behind a relay (docs/relay.md). */
  connectorReleaseDir?: string;
  /** API list prices per million tokens, by model, for the admin's usage view; a model without one has an Unknown cost. */
  connectorPrices?: Record<string, import('./connector/connector.js').ModelPrice>;
  /** BACKUP_DIR: the folder of database backups a Blueprint restore may read authorship from (default <DATA_DIR>/backups, docs/blueprint.md §4.2). */
  backupDir?: string;
}

/** TRUST_PROXY: true / false, or a comma list of addresses, CIDR ranges or the names loopback, linklocal, uniquelocal. Unset trusts only a proxy on the hub's own host (loopback): X-Forwarded-For from any other address is ignored, so a host on the LAN that reaches the hub's port directly cannot fake its address. The HTTPS compose file sets it to the Caddy container's fixed address. */
export function parseTrustProxy(v: string | undefined): boolean | string {
  const s = (v ?? '').trim();
  if (!s) return 'loopback';
  if (/^(true|false)$/i.test(s)) return s.toLowerCase() === 'true';
  return s;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === 'production';
  // Demo mode replays the Early Echo story, which needs the indexing debounce and the vault scan to be short.
  const demo = /^(1|true|yes)$/i.test(env.DEMO_MODE ?? '');
  // Replay wipes the database, so a production hub (the Docker image sets NODE_ENV=production) must say it is a demonstrator.
  if (demo && production && !/^(1|true|yes)$/i.test(env.DEMO_ALLOW_PRODUCTION ?? '')) throw new Error('DEMO_MODE is not allowed when NODE_ENV=production: Replay wipes the database. A demonstrator hub in the Docker image sets DEMO_ALLOW_PRODUCTION=1 as well.');
  const vaultDir = env.VAULT_DIR;
  if (!vaultDir) throw new Error('VAULT_DIR is required (the folder of your Obsidian vault)');
  let pepper = env.KEY_PEPPER;
  if (!pepper) {
    if (production) throw new Error('KEY_PEPPER is required in production');
    console.warn('WARNING: KEY_PEPPER not set; using an insecure development default');
    pepper = 'dev-only-insecure-pepper';
  }
  const dataDir = resolve(env.DATA_DIR ?? './data');
  const port = Number(env.PORT ?? 8080);
  return {
    dataDir, dbFile: join(dataDir, 'agent-hub.db'), vaultDir: resolve(vaultDir), vaultAlias: env.VAULT_ALIAS ?? 'vault',
    port, host: env.HOST ?? '0.0.0.0', pepper, publicUrl: (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, ''), production,
    adminUsername: env.ADMIN_USERNAME, adminPassword: env.ADMIN_PASSWORD,
    publicDir: fileURLToPath(new URL('../public', import.meta.url)), logLevel: env.LOG_LEVEL ?? 'info',
    bridgeFile: env.BRIDGE_FILE, messagesPerHour: env.MESSAGES_PER_HOUR ? Number(env.MESSAGES_PER_HOUR) : 120,
    vaultScanSeconds: env.VAULT_SCAN_SECONDS !== undefined ? Number(env.VAULT_SCAN_SECONDS) : demo ? 5 : 60, vaultWatch: env.VAULT_WATCH !== '0',
    channelBridgeMax: env.CHANNEL_MAX_BYTES ? Number(env.CHANNEL_MAX_BYTES) : undefined, channelBufferBytes: env.CHANNEL_BUFFER_BYTES ? Number(env.CHANNEL_BUFFER_BYTES) : undefined,
    channelBytesPerHour: env.CHANNEL_BYTES_PER_HOUR ? Number(env.CHANNEL_BYTES_PER_HOUR) : undefined, shareBytesPerHour: env.SHARE_BYTES_PER_HOUR ? Number(env.SHARE_BYTES_PER_HOUR) : undefined,
    retention: { ...(env.RETENTION_SHARES_DAYS ? { sharesDays: Number(env.RETENTION_SHARES_DAYS) } : {}), ...(env.RETENTION_CHANNELS_DAYS ? { channelsDays: Number(env.RETENTION_CHANNELS_DAYS) } : {}), ...(env.RETENTION_WORK_ITEMS_DAYS ? { workItemsDays: Number(env.RETENTION_WORK_ITEMS_DAYS) } : {}), ...(env.RETENTION_USAGE_DAYS ? { usageDays: Number(env.RETENTION_USAGE_DAYS) } : {}) },
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    publicRequestsPerMinute: env.PUBLIC_REQUESTS_PER_MINUTE?.trim() && Number.isFinite(Number(env.PUBLIC_REQUESTS_PER_MINUTE)) ? Number(env.PUBLIC_REQUESTS_PER_MINUTE) : 300,
    lanUrl: env.LAN_URL ? env.LAN_URL.replace(/\/+$/, '') : undefined, caCertFile: env.CA_CERT_FILE || undefined, clientDir: env.CLIENT_DIR || undefined,
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim().replace(/[/]+$/, '')).filter(Boolean),
    // Test and demo hubs (eval/run.mjs) shorten the indexing debounce so curator jobs appear within the run.
    ...(env.GRAPH_DEBOUNCE_MS !== undefined && Number.isFinite(Number(env.GRAPH_DEBOUNCE_MS)) ? { graph: { debounceMs: Number(env.GRAPH_DEBOUNCE_MS) } } : demo ? { graph: { debounceMs: 1000 } } : {}),
    demoMode: demo,
    ...(env.CONNECTOR_RELEASE_DIR?.trim() ? { connectorReleaseDir: env.CONNECTOR_RELEASE_DIR.trim() } : {}),
    ...(env.CONNECTOR_RELEASE_URL?.trim() && /^https:\/\//.test(env.CONNECTOR_RELEASE_URL.trim()) ? { connectorReleaseUrl: env.CONNECTOR_RELEASE_URL.trim() } : {}),
    backupDir: resolve(env.BACKUP_DIR ?? join(dataDir, 'backups')),
    ...(env.CONCLAVE_REPO_HOSTS?.trim() ? { repoHosts: env.CONCLAVE_REPO_HOSTS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) } : {}),
  };
}
