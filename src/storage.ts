// Storage helpers for Sether Shield.
//
// All persistence uses chrome.storage.local ONLY. No external databases,
// no network calls. This is a deliberate architectural decision — browser
// extensions cannot securely use external databases because credentials
// would be fully exposed in the extension source.
//
// Storage schema:
// ┌──────────────────┬─────────────────────────────────────────────────────┐
// │ Key              │ Value                                               │
// ├──────────────────┼─────────────────────────────────────────────────────┤
// │ settings         │ { enabled: boolean, autoRedact?: boolean,           │
// │                  │   language?: string }                               │
// │ stats            │ { promptsScrubbed: number, piiCaught: number }      │
// │ siteSettings     │ { allowedSites: string[] }                          │
// │ redactionHistory │ RedactionRecord[] (max 500, FIFO eviction)          │
// │ customRules      │ CustomRule[] (user-defined regex rules, incl.       │
// │                  │ pre-seeded built-ins)                               │
// └──────────────────┴─────────────────────────────────────────────────────┘
//
// CRITICAL: redactionHistory stores ONLY masked values (e.g. "j***@***.com"),
// NEVER the original sensitive data.

import type {
  RedactionRecord,
  SiteSettings,
  Settings,
  Stats,
  CustomRule,
} from './types.js';
import { LOCALES } from './locales.js';

// ── Settings ──────────────────────────────────────────────────────────────────

export async function getSettings(): Promise<Settings> {
  return new Promise((resolve) => {
    chrome.storage.local.get('settings', (v) => {
      resolve({ enabled: true, autoRedact: false, ...v?.settings });
    });
  });
}

export async function setSettings(settings: Settings): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ settings }, resolve);
  });
}

// ── Stats ─────────────────────────────────────────────────────────────────────

export async function getStats(): Promise<Stats> {
  return new Promise((resolve) => {
    chrome.storage.local.get('stats', (v) => {
      resolve(v?.stats ?? { promptsScrubbed: 0, piiCaught: 0 });
    });
  });
}

export async function bumpStats(piiCaught: number): Promise<void> {
  const stats = await getStats();
  return new Promise((resolve) => {
    chrome.storage.local.set({
      stats: {
        promptsScrubbed: stats.promptsScrubbed + 1,
        piiCaught: stats.piiCaught + piiCaught,
      },
    }, resolve);
  });
}

// ── Per-site allowlist (opt-IN model) ─────────────────────────────────────────
//
// Design decision: OPT-IN model.
// The shield activates ONLY on origins explicitly listed in allowedSites.
// Default list contains major AI chat platforms.

const DEFAULT_ALLOWED_SITES = [
  'https://chatgpt.com',
  'https://chat.openai.com',
  'https://claude.ai',
  'https://gemini.google.com',
  'https://chat.deepseek.com',
  'https://www.perplexity.ai',
  'https://copilot.microsoft.com',
  'https://poe.com',
  'https://character.ai',
  'https://huggingface.co',
  'https://chat.mistral.ai',
  'https://grok.x.ai',
];

export const DEFAULT_ALLOWED_SITES_LIST = DEFAULT_ALLOWED_SITES;

export async function getSiteSettings(): Promise<SiteSettings> {
  return new Promise((resolve) => {
    chrome.storage.local.get('siteSettings', (v) => {
      const stored = v?.siteSettings as SiteSettings | undefined;
      // If allowedSites exists, use it directly
      if (stored?.allowedSites) {
        resolve(stored);
        return;
      }
      // First run or legacy — seed defaults
      const defaults: SiteSettings = { allowedSites: [...DEFAULT_ALLOWED_SITES] };
      chrome.storage.local.set({ siteSettings: defaults }, () => resolve(defaults));
    });
  });
}

export async function setSiteSettings(siteSettings: SiteSettings): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ siteSettings }, resolve);
  });
}

export async function isSiteEnabled(origin: string): Promise<boolean> {
  const settings = await getSiteSettings();
  return settings.allowedSites.includes(origin);
}

export async function addAllowedSite(origin: string): Promise<boolean> {
  const settings = await getSiteSettings();
  if (settings.allowedSites.includes(origin)) {
    return false; // already exists
  }
  settings.allowedSites.push(origin);
  await setSiteSettings(settings);
  return true; // newly added
}

export async function removeAllowedSite(origin: string): Promise<void> {
  const settings = await getSiteSettings();
  settings.allowedSites = settings.allowedSites.filter((s) => s !== origin);
  await setSiteSettings(settings);
}

export async function resetAllowedSites(): Promise<void> {
  await setSiteSettings({ allowedSites: [...DEFAULT_ALLOWED_SITES] });
}

// ── Redaction history ─────────────────────────────────────────────────────────

export async function getRedactionHistory(): Promise<RedactionRecord[]> {
  return new Promise((resolve) => {
    chrome.storage.local.get('redactionHistory', (v) => {
      resolve(v?.redactionHistory ?? []);
    });
  });
}

/** Store a redaction record. NEVER pass the original sensitive value.
 *  Only store the masked/redacted version (e.g. "j***@***.com"). */
export async function addRedactionRecord(
  record: Omit<RedactionRecord, 'id'>,
): Promise<void> {
  const history = await getRedactionHistory();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  history.push({ ...record, id });
  // FIFO eviction: keep at most 500 records
  if (history.length > 500) history.splice(0, history.length - 500);
  return new Promise((resolve) => {
    chrome.storage.local.set({ redactionHistory: history }, resolve);
  });
}

export async function deleteRedactionRecord(id: string): Promise<void> {
  const history = await getRedactionHistory();
  const filtered = history.filter((r) => r.id !== id);
  return new Promise((resolve) => {
    chrome.storage.local.set({ redactionHistory: filtered }, resolve);
  });
}

export async function clearRedactionHistory(): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ redactionHistory: [] }, resolve);
  });
}

// ── Feature 2: Custom redaction rules ─────────────────────────────────────────

/** Pre-seeded built-in rules. Users can disable but not delete these. */
const BUILTIN_RULES: CustomRule[] = [
  {
    id: 'builtin-national-id',
    name: 'National Identification Number',
    pattern: '\\b[A-Za-z]{2}\\s?\\d{6}\\s?[A-Za-z0-9]\\b|\\b\\d{3}-\\d{2}-\\d{4}\\b',
    flags: 'gi',
    replacement: '[NATIONAL-ID]',
    enabled: true,
    builtIn: true,
  },
  {
    id: 'builtin-tax-id',
    name: 'Employer ID / Tax Number',
    pattern: '\\b\\d{2}-\\d{7}\\b',
    flags: 'g',
    replacement: '[TAX-ID]',
    enabled: true,
    builtIn: true,
  },
  {
    id: 'builtin-dob-verbal',
    name: 'Date of Birth (verbal, e.g. "born on January 5, 1990")',
    pattern: '\\bborn\\s+(?:on\\s+)?(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\b',
    flags: 'gi',
    replacement: '[DOB]',
    enabled: true,
    builtIn: true,
  },
  {
    id: 'builtin-bank-account',
    name: 'Bank Account Number (8–18 digits)',
    pattern: '\\b\\d{8,18}\\b',
    flags: 'g',
    replacement: '[ACCOUNT]',
    enabled: false,
    builtIn: true,
  },
  {
    id: 'builtin-drivers-license',
    name: "Driver's License / Permit ID",
    pattern: '\\b[A-Za-z]\\d{4}-\\d{5}-\\d{5}\\b|\\b(?=.*\\d)[A-Za-z0-9]{6,12}\\b',
    flags: 'gi',
    replacement: '[LICENSE-ID]',
    enabled: false,
    builtIn: true,
  },
  {
    id: 'builtin-api-key-assign',
    name: 'API Key / Password Assignment',
    pattern: '\\b(?:key|token|secret|password|passwd|pwd)\\s*[:=]\\s*["\']?[A-Za-z0-9_\\-]{16,64}["\']?\\b',
    flags: 'gi',
    replacement: '[API-KEY]',
    enabled: true,
    builtIn: true,
  },
];

export async function getCustomRules(): Promise<CustomRule[]> {
  return new Promise((resolve) => {
    chrome.storage.local.get('customRules', (v) => {
      let stored: CustomRule[] = v?.customRules ?? [];
      let updated = false;

      // Migrate existing stored driver's license rule if it uses the old pattern
      stored = stored.map((r) => {
        if (
          r.id === 'builtin-drivers-license' &&
          r.pattern === '\\b[A-Za-z]\\d{4}-\\d{5}-\\d{5}\\b|\\b[A-Za-z0-9]{6,12}\\b'
        ) {
          updated = true;
          return {
            ...r,
            pattern: '\\b[A-Za-z]\\d{4}-\\d{5}-\\d{5}\\b|\\b(?=.*\\d)[A-Za-z0-9]{6,12}\\b',
          };
        }
        return r;
      });

      if (updated) {
        chrome.storage.local.set({ customRules: stored });
      }

      // Merge built-ins: add any missing built-in IDs
      const storedIds = new Set(stored.map((r) => r.id));
      const merged = [...stored];
      for (const builtin of BUILTIN_RULES) {
        if (!storedIds.has(builtin.id)) {
          merged.unshift(builtin);
        }
      }
      resolve(merged);
    });
  });
}

export async function setCustomRules(rules: CustomRule[]): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ customRules: rules }, resolve);
  });
}

export async function addCustomRule(rule: Omit<CustomRule, 'id'>): Promise<CustomRule> {
  const rules = await getCustomRules();
  const newRule: CustomRule = {
    ...rule,
    id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  };
  rules.push(newRule);
  await setCustomRules(rules);
  return newRule;
}

export async function updateCustomRule(id: string, updates: Partial<CustomRule>): Promise<void> {
  const rules = await getCustomRules();
  const idx = rules.findIndex((r) => r.id === id);
  if (idx >= 0) {
    rules[idx] = { ...rules[idx]!, ...updates };
    await setCustomRules(rules);
  }
}

export async function deleteCustomRule(id: string): Promise<void> {
  const rules = await getCustomRules();
  // Built-in rules cannot be deleted — only disabled
  const filtered = rules.filter((r) => r.id !== id || r.builtIn);
  await setCustomRules(filtered);
}

export async function resetBuiltinRules(): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.get('customRules', (v) => {
      const stored: CustomRule[] = v?.customRules ?? [];
      // Keep only user-created rules
      const userRules = stored.filter((r) => !r.builtIn && !r.id.startsWith('builtin-'));
      chrome.storage.local.set({ customRules: userRules }, () => resolve());
    });
  });
}



// ── Translation Loader (dynamic i18n override) ────────────────────────────────

let cachedMessages: Record<string, string> = {};

export async function loadTranslations(): Promise<void> {
  try {
    const settings = await getSettings();
    const uiLang = (chrome.i18n.getUILanguage ? chrome.i18n.getUILanguage() : 'en').replace('-', '_');
    const lang = settings.language ?? uiLang ?? 'en';
    
    const checkLocales = ['en', 'fr', 'es', 'pt', 'de', 'ar', 'zh_CN'];
    let targetLocale = checkLocales.includes(lang) ? lang : 'en';
    if (lang.startsWith('zh')) {
      targetLocale = 'zh_CN';
    }
    
    const data = LOCALES[targetLocale] || LOCALES['en'];
    cachedMessages = { ...data };
  } catch (err) {
    console.error('Failed to load translations:', err);
  }
}

export function translate(key: string, ...subs: string[]): string {
  let msgStr = cachedMessages[key];
  if (!msgStr) {
    try {
      const fallback = chrome.i18n.getMessage(key, subs);
      if (fallback) return fallback;
    } catch {}
    return key;
  }
  
  for (let i = 0; i < subs.length; i++) {
    const s = subs[i] || '';
    msgStr = msgStr.replace(`$${i + 1}`, s);
    msgStr = msgStr.replace(`$COUNT$`, s);
  }
  return msgStr;
}
