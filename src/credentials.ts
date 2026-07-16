// Credential & secret detectors for Sether Shield.
//
// These detectors catch infrastructure secrets that users commonly paste
// into AI chat prompts when asking for help:
//
// 1. Database connection strings with embedded passwords (MongoDB, Postgres, etc.)
// 2. Environment variable credential assignments (SECRET_KEY=..., DB_PASSWORD=...)
// 3. Generic password/secret assignments in code snippets
// 4. PEM-encoded private keys
//
// All patterns are ReDoS-safe and run locally — no network calls.

import type { Detector } from '@raeven-co/sether/browser';

// ── 1. Database Connection Strings ────────────────────────────────────────────
//
// Catches URIs with embedded credentials: scheme://user:password@host/db
// Examples:
//   mongodb+srv://acco_user:yv7G@cluster0.huckxlg.mongodb.net/
//   postgres://admin:secretpass@db.example.com:5432/mydb
//   redis://default:p4ssw0rd@redis-12345.c1.us-east.ec2.cloud.redislabs.com:12345

export const dbConnectionStringDetector: Detector = {
  type: 'DB_URI',
  detect(text: string) {
    const regex =
      /(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|mariadb|redis(?:s)?|amqp(?:s)?|ftp(?:s)?|mssql|cockroachdb):\/\/[^\s:]+:[^\s@]+@[^\s"'`,;\])}>]+/gi;
    const out: { start: number; end: number; value: string }[] = [];
    for (const m of text.matchAll(regex)) {
      if (m.index == null) continue;
      out.push({ start: m.index, end: m.index + m[0].length, value: m[0] });
    }
    return out;
  },
};

// ── 2. Environment Variable Credential Assignments ────────────────────────────
//
// Catches KEY=value patterns where the key name strongly suggests a credential.
// Examples:
//   MONGODB_URI=mongodb+srv://user:pass@host.net/
//   SECRET_KEY=a8f2e9b1c3d4e5f6
//   DB_PASSWORD=hunter2
//   AUTH_TOKEN=eyJhbGciOiJIUzI1NiJ9...

/** Env var name segments that independently signal a credential. */
const SENSITIVE_SEGMENTS = new Set([
  'SECRET', 'PASSWORD', 'PASSWD', 'TOKEN', 'CREDENTIAL', 'AUTH', 'PRIVATE',
]);

/** Compound substrings in env var names that signal credentials. */
const SENSITIVE_COMPOUNDS = [
  // Key patterns
  'API_KEY', 'ACCESS_KEY', 'SECRET_KEY', 'PRIVATE_KEY', 'ENCRYPTION_KEY',
  'SIGNING_KEY', 'MASTER_KEY', 'SERVICE_KEY', 'APP_KEY',
  // Database URIs
  'MONGODB_URI', 'MONGO_URI', 'MONGO_URL',
  'DATABASE_URL', 'DATABASE_URI', 'DB_URL', 'DB_URI', 'DB_DSN',
  'DB_PASS', 'DB_PASSWORD',
  'REDIS_URL', 'REDIS_URI',
  'POSTGRES_URL', 'POSTGRES_URI', 'PG_URL', 'PG_URI',
  'MYSQL_URL', 'MYSQL_URI',
  'SUPABASE_URL', 'SUPABASE_KEY',
  'FIREBASE_URL', 'FIREBASE_KEY',
  'CONNECTION_STRING', 'CONN_STR', 'CONN_STRING',
  // Auth
  'CLIENT_SECRET', 'CLIENT_ID',
  'JWT_SECRET', 'SESSION_SECRET', 'COOKIE_SECRET',
  'WEBHOOK_SECRET', 'SIGNING_SECRET',
];

function isSensitiveEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  const parts = upper.split('_');
  // Check if any individual segment is a known sensitive word
  if (parts.some((p) => SENSITIVE_SEGMENTS.has(p))) return true;
  // Check compound patterns (e.g., API_KEY, MONGODB_URI)
  return SENSITIVE_COMPOUNDS.some((c) => upper.includes(c));
}

/** Values that are clearly placeholders, not real credentials. */
const PLACEHOLDER_VALUES = new Set([
  'null', 'undefined', 'none', 'true', 'false', 'your_secret_here',
  'your_key_here', 'change_me', 'changeme', 'xxxxxxxx', 'TODO',
]);

export const envCredentialDetector: Detector = {
  type: 'CREDENTIAL',
  detect(text: string) {
    // Match UPPER_CASE_NAME = value (with optional quotes)
    const regex = /\b([A-Z][A-Z0-9_]{2,})\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/g;
    const out: { start: number; end: number; value: string }[] = [];
    for (const m of text.matchAll(regex)) {
      if (m.index == null || !m[1] || !m[2]) continue;
      if (!isSensitiveEnvName(m[1])) continue;
      // Strip quotes and check for placeholders
      const rawValue = m[2].replace(/^["']|["']$/g, '');
      if (
        !rawValue ||
        rawValue.length < 2 ||
        PLACEHOLDER_VALUES.has(rawValue.toLowerCase()) ||
        (rawValue.startsWith('<') && rawValue.endsWith('>'))
      ) {
        continue;
      }
      out.push({ start: m.index, end: m.index + m[0].length, value: m[0] });
    }
    return out;
  },
};

// ── 3. Generic Password/Secret Assignments ────────────────────────────────────
//
// Catches lowercase/mixed-case assignments in code snippets:
//   password: "hunter2"
//   secret = "abc123"
//   api_key: sk-1234567890

const NON_CREDENTIAL_VALUES = new Set([
  'true', 'false', 'yes', 'no', 'none', 'null', 'undefined',
  'required', 'optional', 'empty', 'blank', 'default', 'example',
]);

export const genericPasswordDetector: Detector = {
  type: 'CREDENTIAL',
  detect(text: string) {
    const regex =
      /\b(password|passwd|pass(?:word|wd)?|secret|api[_-]?key|auth[_-]?token|access[_-]?token|client[_-]?secret|private[_-]?key|master[_-]?key|encryption[_-]?key)\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/gi;
    const out: { start: number; end: number; value: string }[] = [];
    for (const m of text.matchAll(regex)) {
      if (m.index == null || !m[2]) continue;
      const rawValue = m[2].replace(/^["']|["']$/g, '');
      if (
        !rawValue ||
        rawValue.length < 2 ||
        NON_CREDENTIAL_VALUES.has(rawValue.toLowerCase()) ||
        (rawValue.startsWith('<') && rawValue.endsWith('>'))
      ) {
        continue;
      }
      out.push({ start: m.index, end: m.index + m[0].length, value: m[0] });
    }
    return out;
  },
};

// ── 4. PEM Private Keys ──────────────────────────────────────────────────────
//
// Catches PEM-encoded private keys commonly pasted in chat:
//   -----BEGIN RSA PRIVATE KEY-----
//   MIIEpAIBAAKCAQEA...
//   -----END RSA PRIVATE KEY-----

export const privateKeyDetector: Detector = {
  type: 'PRIVATE_KEY',
  detect(text: string) {
    const regex =
      /-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+|ENCRYPTED\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+|ENCRYPTED\s+)?PRIVATE\s+KEY-----/g;
    const out: { start: number; end: number; value: string }[] = [];
    for (const m of text.matchAll(regex)) {
      if (m.index == null) continue;
      out.push({ start: m.index, end: m.index + m[0].length, value: m[0] });
    }
    return out;
  },
};

// ── Export ─────────────────────────────────────────────────────────────────────

export const credentialDetectors: readonly Detector[] = [
  dbConnectionStringDetector,
  envCredentialDetector,
  genericPasswordDetector,
  privateKeyDetector,
];
