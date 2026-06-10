// Detection engine for Sether Shield.
//
// SINGLE SOURCE OF TRUTH: we run the REAL @raeven-co/sether detector packs
// (basic + secrets + identity) via the package's browser-safe entry
// (`@raeven-co/sether/browser`) — no hand-ported regexes that could drift from
// the published library. On top we add ONE chat-specific heuristic:
// conversational name anchors ("my name is …") that the label-anchored identity
// pack intentionally leaves to NER. Free-text names in arbitrary prose still
// need the model (server-side / @raeven-co/sether-ner).

import {
  basicDetectors,
  secretsDetectors,
  identityDetectors,
  type Detector,
} from '@raeven-co/sether/browser';

export interface Match {
  type: string;
  value: string;
  start: number;
  end: number;
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
};

export function labelFor(type: string): string {
  return FRIENDLY[type] ?? type.toLowerCase().replace(/_/g, ' ');
}

// Conversational name anchors. The anchor's first letter may be upper- or
// lowercase, but the NAME itself must be Capitalised — this keeps precision high
// ("my name is on the list" won't match). A small stopword set guards the common
// non-name continuations after "I am" / "this is".
const NAME_ANCHOR =
  /(?:[Mm]y name is|[Ii] am|[Ii]'m|[Cc]all me|[Nn]ame's|[Tt]his is)\s+([A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+){0,2})/gu;

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

const DETECTORS: readonly Detector[] = [
  ...basicDetectors,
  ...secretsDetectors,
  ...identityDetectors,
  conversationalName,
];

export function detect(text: string): Match[] {
  const all: Match[] = [];
  for (const d of DETECTORS) {
    for (const m of d.detect(text)) {
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

export interface ScrubResult {
  text: string;
  count: number;
}

/** Replace each detected value with a numbered placeholder, e.g. [email-1]. */
export function scrub(text: string): ScrubResult {
  const matches = detect(text);
  if (matches.length === 0) return { text, count: 0 };

  const counters: Record<string, number> = {};
  let out = '';
  let pos = 0;
  for (const m of matches) {
    const label = labelFor(m.type).replace(/\s+/g, '-');
    counters[label] = (counters[label] ?? 0) + 1;
    out += text.slice(pos, m.start) + `[${label}-${counters[label]}]`;
    pos = m.end;
  }
  out += text.slice(pos);
  return { text: out, count: matches.length };
}
