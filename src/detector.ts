// Detection engine for Sether Shield.
//
// SINGLE SOURCE OF TRUTH: we run the REAL @raeven-co/sether detector packs
// (basic + secrets + identity) via the package's browser-safe entry
// (`@raeven-co/sether/browser`) — no hand-ported regexes that could drift from
// the published library. On top we add:
//
// 1. Chat-specific heuristic: conversational name anchors ("my name is …")
//    that the label-anchored identity pack intentionally leaves to NER.
// 2. Multilingual detectors: name anchors + national IDs for
//    French, Spanish, Portuguese, German, Arabic, Chinese (Simplified).
// 3. Credential detectors: database URIs with embedded passwords,
//    env var secret assignments, generic password fields, PEM private keys.
// 4. Custom user-defined rules (regex-based), loaded from chrome.storage.local.
//
// Free-text names in arbitrary prose still need the model (server-side /
// @raeven-co/sether-ner).

import {
  basicDetectors,
  secretsDetectors,
  identityDetectors,
  type Detector,
} from '@raeven-co/sether/browser';

import { multilingualDetectors } from './multilingual.js';
import { credentialDetectors } from './credentials.js';

export interface Match {
  type: string;
  value: string;
  start: number;
  end: number;
  /** Whether this value arrived via clipboard paste vs. keyboard typing. */
  source?: 'paste' | 'typed';
}

const FRIENDLY: Record<string, string> = {
  EMAIL: 'email',
  PHONE: 'phone',
  CC: 'card number',
  SSN: 'SSN',
  IPV4: 'IP address',
  IPV6: 'IP address',
  IBAN: 'IBAN',
  NAME: 'name',
  DOB: 'date of birth',
  PASSPORT: 'passport',
  ADDRESS: 'address',
  JWT: 'token',
  HIGH_ENTROPY: 'secret',
  NATIONAL_ID: 'national ID',
  DB_URI: 'database URI',
  CREDENTIAL: 'credential',
  PRIVATE_KEY: 'private key',
  CUSTOM: 'custom',
};

export function labelFor(type: string): string {
  return FRIENDLY[type] ?? type.toLowerCase().replace(/_/g, ' ');
}

// ── English conversational name anchors ───────────────────────────────────────
// The anchor's first letter may be upper- or lowercase, but the NAME itself
// must be Capitalised — this keeps precision high ("my name is on the list"
// won't match). A small stopword set guards the common non-name continuations.

const NAME_ANCHOR =
  /(?:[Mm]y name is|[Ii] am|[Ii]'m|[Cc]all me|[Nn]ame's|[Tt]his is)\s+([A-Z][\p{L}''-]+(?:\s+[A-Z][\p{L}''-]+){0,2})/gu;

const NAME_STOPWORDS = new Set([
  'Sorry', 'Sure', 'Fine', 'Okay', 'Ok', 'Here', 'There', 'Not', 'Going', 'Trying',
  'Just', 'Still', 'Also', 'Happy', 'Glad', 'Good', 'Great', 'Ready', 'Done',
  'Looking', 'Working', 'Thinking', 'Awesome', 'Cool', 'Nice', 'Amazing', 'Perfect',
  'Confused', 'Curious', 'Interested', 'Wondering', 'Asking', 'Building', 'Using',
]);

const conversationalName: Detector = {
  type: 'NAME',
  detect(text: string) {
    const out: { start: number; end: number; value: string }[] = [];
    for (const m of text.matchAll(NAME_ANCHOR)) {
      const name = m[1];
      if (!name || m.index == null) continue;
      const firstWord = name.split(/\s+/)[0] ?? '';
      if (NAME_STOPWORDS.has(firstWord)) continue;
      const start = m.index + m[0].length - name.length;
      out.push({ start, end: start + name.length, value: name });
    }
    return out;
  },
};

// ── Composite detector list ───────────────────────────────────────────────────

const DETECTORS: readonly Detector[] = [
  ...basicDetectors,
  ...secretsDetectors,
  ...identityDetectors,
  conversationalName,
  ...multilingualDetectors,
  ...credentialDetectors,
];

// ── Custom rule detectors (user-defined, regex-based) ─────────────────────────
// These are loaded at runtime from chrome.storage.local and re-applied on each
// detect() call. They are appended after built-in detectors so built-in overlap
// resolution takes priority.

export interface CustomRule {
  id: string;
  /** Display name shown in the UI */
  name: string;
  /** Regex source string, e.g. "\\b\\d{9}\\b" */
  pattern: string;
  /** Regex flags, e.g. "gi" */
  flags: string;
  /** What to display as the replacement preview, e.g. "[CUSTOM]" */
  replacement: string;
  enabled: boolean;
  /** Built-in rules ship pre-seeded; users can disable but not delete them. */
  builtIn: boolean;
}

export function isRegexSafe(pattern: string, flags: string): boolean {
  try {
    const re = new RegExp(pattern, flags.includes('g') ? flags : flags + 'g');
    const testStrings = [
      "a".repeat(100),
      "a".repeat(25) + "!",
      " ".repeat(50),
      "1".repeat(50),
      "a1".repeat(25)
    ];
    for (const str of testStrings) {
      const start = performance.now();
      Array.from(str.matchAll(re));
      const dur = performance.now() - start;
      if (dur > 20) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Runtime-mutable list of active custom detectors. Updated by loadCustomRules(). */
let customDetectors: Detector[] = [];

/** Call this after loading CustomRule[] from storage to update the live detector set. */
export function applyCustomRules(rules: CustomRule[]): void {
  customDetectors = rules
    .filter((r) => r.enabled && isRegexSafe(r.pattern, r.flags))
    .map((r) => ({
      type: `CUSTOM:${r.id}`,
      detect(text: string) {
        const out: { start: number; end: number; value: string }[] = [];
        try {
          const re = new RegExp(r.pattern, r.flags.includes('g') ? r.flags : r.flags + 'g');
          for (const m of text.matchAll(re)) {
            if (m.index == null) continue;
            out.push({ start: m.index, end: m.index + m[0].length, value: m[0] });
          }
        } catch {
          // Invalid regex — silently skip
        }
        return out;
      },
    }));
}

function isAlreadyRedacted(value: string): boolean {
  return /\*{3,}/.test(value) || /^\[[a-z0-9_-]+\]$/i.test(value);
}

export function detect(text: string): Match[] {
  const all: Match[] = [];
  const allDetectors = [...DETECTORS, ...customDetectors];
  for (const d of allDetectors) {
    for (const m of d.detect(text)) {
      if (isAlreadyRedacted(m.value)) continue;
      all.push({ type: d.type, value: m.value, start: m.start, end: m.end });
    }
  }
  return resolveOverlaps(all);
}

// Drop matches that overlap an already-accepted one (earliest start, then longest).
function resolveOverlaps(matches: Match[]): Match[] {
  matches.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const out: Match[] = [];
  for (const m of matches) {
    if (!out.some((o) => m.start < o.end && o.start < m.end)) out.push(m);
  }
  return out.sort((a, b) => a.start - b.start);
}

export interface VaultEntry {
  /** The placeholder that replaced the value, e.g. "[email-1]". */
  placeholder: string;
  /** The original sensitive value. NEVER persist this to disk. */
  original: string;
}

export interface ScrubResult {
  text: string;
  count: number;
  /**
   * Placeholder→original mapping so the scrub can be reversed. The caller MUST
   * keep this in ephemeral memory only (never chrome.storage / disk) — holding
   * the originals anywhere persistent would defeat the point of the tool.
   */
  vault: VaultEntry[];
}

/** Replace each detected value with a numbered placeholder, e.g. [email-1]. */
export function scrub(text: string): ScrubResult {
  const matches = detect(text);
  if (matches.length === 0) return { text, count: 0, vault: [] };

  const counters: Record<string, number> = {};
  const vault: VaultEntry[] = [];
  let out = '';
  let pos = 0;
  for (const m of matches) {
    const label = labelFor(m.type).replace(/\s+/g, '-');
    counters[label] = (counters[label] ?? 0) + 1;
    const placeholder = `[${label}-${counters[label]}]`;
    out += text.slice(pos, m.start) + placeholder;
    vault.push({ placeholder, original: m.value });
    pos = m.end;
  }
  out += text.slice(pos);
  return { text: out, count: matches.length, vault };
}

/**
 * Reverse a scrub: swap every placeholder back to its original value.
 * Pure string substitution — works as long as the placeholders are still
 * present in `text` (the user may have typed around them).
 */
export function restore(text: string, vault: VaultEntry[]): string {
  let out = text;
  for (const { placeholder, original } of vault) {
    out = out.split(placeholder).join(original);
  }
  return out;
}

// ── Mask value for display ────────────────────────────────────────────────────
// Creates a human-readable masked preview of a detected value.
// Used in suggestion cards and redaction history — the original value is
// NEVER stored, only this masked form.

export function maskValue(value: string, type: string): string {
  // Custom rules use their stored replacement string if available,
  // but we don't have rule metadata here — fall through to default.
  switch (type) {
    case 'EMAIL': {
      const atIdx = value.indexOf('@');
      if (atIdx < 0) return '***@***.***';
      const local = value.slice(0, atIdx);
      const domain = value.slice(atIdx + 1);
      const localMask = local.length > 1 ? local[0] + '***' : '***';
      const domainParts = domain.split('.');
      const domainMask =
        domainParts.length > 1
          ? (domainParts[0]?.[0] ?? '') + '***.' + domainParts.slice(1).join('.')
          : '***';
      return `${localMask}@${domainMask}`;
    }
    case 'PHONE': {
      if (value.length < 4) return '***';
      return value.slice(0, 3) + '****' + value.slice(-2);
    }
    case 'CC': {
      const clean = value.replace(/\s/g, '');
      return '**** **** **** ' + clean.slice(-4);
    }
    case 'SSN':
      return '***-**-' + value.slice(-4);
    case 'NAME':
      return (value[0] ?? '') + '***';
    case 'IBAN':
      return value.slice(0, 4) + ' ****' + value.slice(-4);
    case 'NATIONAL_ID':
      return value.slice(0, 2) + '***' + value.slice(-2);
    case 'IPV4':
      return value.split('.').map((p, i) => (i === 0 ? p : '***')).join('.');
    case 'IPV6':
      return value.slice(0, 4) + ':****';
    case 'DB_URI': {
      // Mask the password: mongodb+srv://user:pass@host → mongodb+srv://user:***@host
      const uriMatch = value.match(/(.*?:\/\/[^:]*:)([^@]+)(@.*)/);
      if (uriMatch) return uriMatch[1] + '***' + uriMatch[3];
      return value.slice(0, 12) + '***';
    }
    case 'CREDENTIAL': {
      // Mask the value: KEY=secretvalue → KEY=***
      const eqIdx = value.indexOf('=');
      if (eqIdx >= 0) return value.slice(0, eqIdx + 1) + '***';
      const colonIdx = value.indexOf(':');
      if (colonIdx >= 0) return value.slice(0, colonIdx + 2) + '***';
      return value.slice(0, 6) + '***';
    }
    case 'PRIVATE_KEY':
      return '-----BEGIN PRIVATE KEY----- [REDACTED]';
    default:
      if (value.length <= 4) return '***';
      return value.slice(0, 2) + '***' + value.slice(-1);
  }
}
