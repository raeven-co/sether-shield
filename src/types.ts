// Shared type definitions for Sether Shield.
// All modules import from this file to avoid circular dependencies.

/** A single PII detection match with source position. */
export interface Match {
  type: string;
  value: string;
  start: number;
  end: number;
  /** Whether this value arrived via clipboard paste vs. keyboard typing. */
  source?: 'paste' | 'typed';
}

/** Result of scrubbing text — the cleaned text + how many items were replaced. */
export interface ScrubResult {
  text: string;
  count: number;
}

/** A single redaction record stored in chrome.storage.local.
 *  CRITICAL: Never store the original sensitive value — only the masked version. */
export interface RedactionRecord {
  id: string;
  pageUrl: string;
  category: string;
  redactedValue: string;
  timestamp: number;
  /** How the content arrived — paste or typed. */
  source?: 'paste' | 'typed';
}

/** Per-site settings — opt-IN allowlist model.
 *  The shield only runs on sites explicitly listed in allowedSites.
 *  Ships with defaults pre-seeded for major AI chat platforms. */
export interface SiteSettings {
  /** Legacy opt-out list — kept for backward compat migration only. */
  disabledSites?: string[];
  /** Allowlist of origins (e.g. "https://chatgpt.com") where shield is active. */
  allowedSites: string[];
}

/** Global on/off settings. */
export interface Settings {
  enabled: boolean;
  language?: string;
  autoRedact?: boolean;
}

/** Session statistics — aggregate counts only, no PII. */
export interface Stats {
  promptsScrubbed: number;
  piiCaught: number;
}

// ── Feature 2: Custom redaction rules ─────────────────────────────────────────

/** A user-configurable regex-based redaction rule. */
export interface CustomRule {
  id: string;
  /** Display name shown in the rule editor. */
  name: string;
  /** Regex source string (without delimiters), e.g. "\\b\\d{9}\\b" */
  pattern: string;
  /** Regex flags, e.g. "gi" */
  flags: string;
  /** Preview replacement shown in the panel, e.g. "[TAX-ID]" */
  replacement: string;
  enabled: boolean;
  /** Built-in rules ship pre-seeded; users can disable but not delete them. */
  builtIn: boolean;
}



// ── Messages between background service worker ↔ content scripts ──────────────

export type Message =
  | { action: 'triggerScan' }
  | { action: 'getStatus' }
  | { action: 'updateBadge'; count: number }
  | { action: 'scanDocument' };

export interface StatusResponse {
  matchCount: number;
  enabled: boolean;
  siteEnabled: boolean;
}
