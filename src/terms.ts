// Watchlist terms — user-supplied sensitive values imported from a file.
//
// The user downloads a sample CSV, fills in their own names / emails / IDs /
// project codenames with a per-term handling choice (redact | mask | decoy)
// and an optional fixed replacement, then imports it. From that point every
// prompt containing one of those terms is flagged and scrubbed with the
// handling the file specified — no regex knowledge required.
//
// PRIVACY: the terms themselves ARE sensitive values, and importing the file
// stores them in chrome.storage.local on this device (that is the entire
// point — they must survive restarts to keep protecting future prompts).
// The popup says this explicitly next to the import button. They never leave
// the machine; this extension makes zero network calls.

/** How a watchlist term is replaced when found in a prompt. */
export type TermAction = 'redact' | 'mask' | 'decoy';

export interface CustomTerm {
  id: string;
  /** The sensitive value to watch for, verbatim (e.g. "Godfrey Lebo"). */
  term: string;
  action: TermAction;
  /**
   * Optional fixed replacement. For 'decoy' this is the exact decoy to use
   * ("John Doe"); for 'redact'/'mask' it overrides the default placeholder.
   * Empty = generate automatically.
   */
  replacement?: string;
  /** Match case-sensitively. Default false. */
  matchCase: boolean;
  /** Require word boundaries around the term. Default true. */
  wholeWord: boolean;
  enabled: boolean;
}

export const TERM_TYPE_PREFIX = 'TERM:';

const VALID_ACTIONS: readonly TermAction[] = ['redact', 'mask', 'decoy'];

// ── Sample file ───────────────────────────────────────────────────────────────

/** The downloadable sample the user edits and re-imports. */
export function sampleTermsFile(): string {
  return [
    '# Sether Shield watchlist',
    '#',
    '# One line per sensitive value. Columns:',
    '#   term        - the exact value to protect (required)',
    '#   action      - redact | mask | decoy          (default: decoy)',
    '#   replacement - what to insert instead (optional; leave empty to auto-generate)',
    '#   match_case  - yes | no   match capitalisation exactly (default: no)',
    '#   whole_word  - yes | no   only match whole words       (default: yes)',
    '#',
    '# Lines starting with # are ignored. Wrap a term in "quotes" if it contains a comma.',
    '# Save the file and import it from the Sether Shield popup (Watchlist section).',
    '#',
    'term,action,replacement,match_case,whole_word',
    'Godfrey Lebo,decoy,John Doe,no,yes',
    'emory@gmail.com,decoy,jane.doe@example.com,no,yes',
    'Raeven Company,redact,[my-company],no,yes',
    '+2348031234567,decoy,,no,yes',
    'Project Falcon,mask,,no,yes',
    '',
  ].join('\n');
}

// ── CSV / JSON parsing ────────────────────────────────────────────────────────

/** Split one CSV line honouring double-quoted fields ("a,b" stays one field). */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '' ) return fallback;
  if (v === 'yes' || v === 'y' || v === 'true' || v === '1') return true;
  if (v === 'no' || v === 'n' || v === 'false' || v === '0') return false;
  return fallback;
}

export interface ParseResult {
  terms: CustomTerm[];
  /** Human-readable problems for lines that were skipped. */
  errors: string[];
}

let idCounter = 0;
function freshId(): string {
  idCounter++;
  return `term-${Date.now().toString(36)}-${idCounter}`;
}

/**
 * Parse an imported watchlist file. Accepts the CSV sample format (with or
 * without the header row) and, for convenience, a JSON array of CustomTerm-ish
 * objects. Never throws — malformed lines land in `errors`.
 */
export function parseTermsFile(content: string): ParseResult {
  const trimmed = content.trim();
  if (trimmed.startsWith('[')) return parseJsonTerms(trimmed);

  const terms: CustomTerm[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  const lines = trimmed.split(/\r\n|\r|\n/);
  for (let n = 0; n < lines.length; n++) {
    const line = (lines[n] ?? '').trim();
    if (!line || line.startsWith('#')) continue;

    const cols = splitCsvLine(line);
    const term = cols[0] ?? '';

    // Skip the header row wherever it appears.
    if (term.toLowerCase() === 'term' && (cols[1] ?? '').toLowerCase() === 'action') continue;

    if (term.length < 2) {
      errors.push(`Line ${n + 1}: term "${term}" is too short (minimum 2 characters)`);
      continue;
    }
    if (term.length > 200) {
      errors.push(`Line ${n + 1}: term is too long (maximum 200 characters)`);
      continue;
    }

    const actionRaw = (cols[1] ?? '').toLowerCase();
    const action: TermAction = (VALID_ACTIONS as readonly string[]).includes(actionRaw)
      ? (actionRaw as TermAction)
      : 'decoy';
    if (actionRaw && action !== actionRaw) {
      errors.push(`Line ${n + 1}: unknown action "${cols[1]}" (use redact, mask or decoy) — defaulted to decoy`);
    }

    const replacement = (cols[2] ?? '').trim() || undefined;
    if (replacement && replacement === term) {
      errors.push(`Line ${n + 1}: replacement equals the term itself — ignored`);
    }

    const matchCase = parseBool(cols[3], false);
    const dedupeKey = matchCase ? term : term.toLowerCase();
    if (seen.has(dedupeKey)) {
      errors.push(`Line ${n + 1}: duplicate term "${term}" — first entry wins`);
      continue;
    }
    seen.add(dedupeKey);

    terms.push({
      id: freshId(),
      term,
      action,
      replacement: replacement === term ? undefined : replacement,
      matchCase,
      wholeWord: parseBool(cols[4], true),
      enabled: true,
    });
  }

  if (terms.length === 0 && errors.length === 0) {
    errors.push('No terms found in the file. Fill in at least one row under the header.');
  }
  return { terms, errors };
}

function parseJsonTerms(content: string): ParseResult {
  const terms: CustomTerm[] = [];
  const errors: string[] = [];
  try {
    const raw = JSON.parse(content);
    if (!Array.isArray(raw)) return { terms, errors: ['JSON watchlist must be an array'] };
    const seen = new Set<string>();
    raw.forEach((entry, i) => {
      const term = typeof entry?.term === 'string' ? entry.term.trim() : '';
      if (term.length < 2 || term.length > 200) {
        errors.push(`Entry ${i + 1}: missing or invalid "term"`);
        return;
      }
      const matchCase = entry.matchCase === true;
      const dedupeKey = matchCase ? term : term.toLowerCase();
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);
      const action: TermAction = (VALID_ACTIONS as readonly string[]).includes(entry.action)
        ? entry.action
        : 'decoy';
      const replacement =
        typeof entry.replacement === 'string' && entry.replacement.trim() && entry.replacement !== term
          ? entry.replacement.trim()
          : undefined;
      terms.push({
        id: freshId(),
        term,
        action,
        replacement,
        matchCase,
        wholeWord: entry.wholeWord !== false,
        enabled: entry.enabled !== false,
      });
    });
  } catch {
    errors.push('File is not valid CSV or JSON — download a fresh sample and start from that.');
  }
  return { terms, errors };
}

// ── Detection ─────────────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** \b only works against word characters; for terms that start/end with
 *  punctuation (emails, phones with +) fall back to lookaround-free guards. */
function boundaryPattern(term: string): string {
  const core = escapeRegex(term);
  const startsWord = /^[\p{L}\p{N}_]/u.test(term);
  const endsWord = /[\p{L}\p{N}_]$/u.test(term);
  return `${startsWord ? '\\b' : ''}${core}${endsWord ? '\\b' : ''}`;
}

export interface TermMatchRange {
  start: number;
  end: number;
  value: string;
}

/** Find every occurrence of a term in `text`. Literal matching only — the
 *  term is regex-escaped, so imports can never inject a pathological pattern. */
export function findTerm(text: string, t: CustomTerm): TermMatchRange[] {
  const out: TermMatchRange[] = [];
  const flags = t.matchCase ? 'gu' : 'giu';
  const source = t.wholeWord ? boundaryPattern(t.term) : escapeRegex(t.term);
  let re: RegExp;
  try {
    re = new RegExp(source, flags);
  } catch {
    return out;
  }
  for (const m of text.matchAll(re)) {
    if (m.index == null || m[0].length === 0) continue;
    out.push({ start: m.index, end: m.index + m[0].length, value: m[0] });
  }
  return out;
}
