/**
 * Leak guard (SPECIFICATION F7). Scans what agents send and receive for Conclave keys and tokens, including
 * spaced, split, case-changed, base64- or hex-encoded forms.
 *
 * Both tests follow the real key structure, so ordinary prose never matches:
 * - **Issued:** after removing every separator (a key split by spaces, newlines or across fields), a candidate
 *   `ah<kind><12><32>` or `ahtok<40>` counts only when the hub verifies it as a key or token it issued. Glued prose
 *   such as "Yeah, settings for the deployment…" can have that shape, but it can never verify.
 * - **Shape:** the full structure with at most four separator characters between the parts. Words are never
 *   32 letters long, so "Utah application" is not a key. A shape that does not verify is reported as not issued.
 *
 * A PC pairing code (`cnc-pair-` and 26 characters, docs/onboarding.md#the-code) is found the same way: it verifies against
 * the hub's own codes, used or not, and is treated like a key.
 *
 * Callers treat an issued hit as an incident (reject, suspend, withhold). A key-shaped string the hub never issued
 * is at most a warning: it cannot unlock anything here.
 */

export type KeyKind = 'app' | 'ses' | 'set' | 'brg' | 'dsc' | 'tok' | 'rly' | 'pair';

export interface LeakHit {
  field: string;
  kind: 'key_pattern' | 'encoded_key';
  /** True when the hub verified the value as a key or token it issued (any status). */
  issued: boolean;
}

export interface LeakGuardOptions {
  /** Exact check against the stored verifiers. For 'tok', keyId is '' and secret is the 40 characters after ah_tok_; for 'pair', the 26 after cnc-pair-. */
  isIssued: (kind: KeyKind, keyId: string, secret: string) => boolean;
}

const SEP = '[\\s_\\-.:|/\\\\]{0,4}';
/** The full key structure, case-insensitive, with optional separators between the parts. */
const SHAPE = new RegExp(`ah${SEP}(?:app|ses|set|brg|dsc|rly)${SEP}[a-z2-7]{12}${SEP}[a-z2-7]{32}|ah${SEP}tok${SEP}[a-z2-7]{40}|cnc${SEP}pair${SEP}[a-z2-7]{26}`, 'i');
const PREFIX = /ah(app|ses|set|brg|dsc|rly|tok)/g;
const PAIR = /cncpair/g;
const B32_44 = /^[a-z2-7]{44}$/, B32_40 = /^[a-z2-7]{40}$/, B32_26 = /^[a-z2-7]{26}$/;

const INVISIBLE = /[​-‏⁠-⁤﻿­]/g;

const compactOf = (s: string) => s.replace(INVISIBLE, '').toLowerCase().replace(/[^a-z0-9]/g, '');

export class LeakGuard {
  constructor(private readonly opts: LeakGuardOptions) {}

  /**
   * Scan any JSON-like value. `skip` lists top-level fields that legitimately carry a key; `exempt` lists exact
   * values the hub minted for this response on purpose (a login token), which are blanked before scanning.
   */
  scan(value: unknown, skip: ReadonlySet<string> = new Set(), exempt: readonly string[] = []): LeakHit | null {
    const clean = (s: string) => { for (const e of exempt) if (e && s.includes(e)) s = s.split(e).join(' '); return s; };
    const parts: string[] = [];
    let fallback: LeakHit | null = null;
    const str = (raw: string, field: string, joined = true): LeakHit | null => {
      const s = clean(raw);
      if (joined) parts.push(compactOf(s));
      const h = this.scanString(s, field);
      if (h?.issued) return h;
      fallback ??= h;
      return null;
    };
    const walk = (v: unknown, field: string, depth: number): LeakHit | null => {
      if (depth > 20) return null;
      if (typeof v === 'string') return str(v, field);
      if (Array.isArray(v)) { for (const [i, x] of v.entries()) { const h = walk(x, `${field}[${i}]`, depth + 1); if (h) return h; } return null; }
      if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          if (depth === 0 && skip.has(k)) continue;
          const f = field ? `${field}.${k}` : k;
          const kh = str(k, f, false); if (kh) return kh;
          const h = walk(x, f, depth + 1); if (h) return h;
        }
      }
      return null;
    };
    const direct = walk(value, '', 0);
    if (direct) return direct;
    // A key split across fields (part in one string, rest in the next) still verifies once the parts are joined.
    if (parts.length > 1 && this.issuedIn(parts.join(''))) return { field: 'payload', kind: 'key_pattern', issued: true };
    return fallback;
  }

  scanString(s: string, field: string, depth = 0): LeakHit | null {
    if (s.length < 8) return null;
    const visible = s.replace(INVISIBLE, '');
    const kind = depth ? 'encoded_key' as const : 'key_pattern' as const;
    if (this.issuedIn(compactOf(visible))) return { field, kind, issued: true };
    let fallback: LeakHit | null = SHAPE.test(visible) ? { field, kind, issued: false } : null;
    if (depth < 2) {
      for (const decoded of decodeCandidates(visible)) {
        const h = this.scanString(decoded, field, depth + 1);
        if (h?.issued) return { field, kind: 'encoded_key', issued: true };
        if (h) fallback ??= { field, kind: 'encoded_key', issued: false };
      }
    }
    return fallback;
  }

  /** Does the compact text contain a key or token the hub issued? Each candidate costs one indexed lookup. */
  private issuedIn(compact: string): boolean {
    for (const m of compact.matchAll(PREFIX)) {
      const k = m[1] as KeyKind, at = m.index! + 5;
      if (k === 'tok') {
        const secret = compact.slice(at, at + 40);
        if (B32_40.test(secret) && this.opts.isIssued('tok', '', secret)) return true;
      } else {
        const rest = compact.slice(at, at + 44);
        if (B32_44.test(rest) && this.opts.isIssued(k, rest.slice(0, 12), rest.slice(12))) return true;
      }
    }
    for (const m of compact.matchAll(PAIR)) {
      const secret = compact.slice(m.index! + 7, m.index! + 33);
      if (B32_26.test(secret) && this.opts.isIssued('pair', '', secret)) return true;
    }
    return false;
  }
}

/**
 * Decode base64 / base64url / hex runs long enough to hide a key. Every alignment is tried (a run can start inside
 * a word), and non-printable bytes become spaces rather than discarding the candidate, so a key next to binary data
 * is still found. Only decoded text that could hold a key prefix is returned.
 */
function decodeCandidates(s: string): string[] {
  const out: string[] = [];
  const keep = (b: Buffer) => { const t = b.toString('latin1').replace(/[^\x20-\x7e]+/g, ' '); if (/ah|cnc/i.test(t)) out.push(t); };
  for (const m of s.matchAll(/[A-Za-z0-9+/_-]{20,}={0,2}/g)) {
    const run = m[0].replace(/-/g, '+').replace(/_/g, '/');
    for (let o = 0; o < 4 && run.length - o >= 20; o++) keep(Buffer.from(run.slice(o), 'base64'));
  }
  for (const m of s.matchAll(/[0-9a-fA-F]{24,}/g)) for (let o = 0; o < 2; o++) keep(Buffer.from(m[0].slice(o), 'hex'));
  return out;
}
