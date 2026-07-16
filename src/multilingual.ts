// Multilingual PII detectors for Sether Shield.
//
// Each language pack provides:
// - Conversational name anchors (e.g. "je m'appelle", "me llamo")
// - National ID format detection (e.g. French NIR, Spanish DNI, Chinese 身份证)
//
// Supported languages: French, Spanish, Portuguese, German, Arabic, Chinese (Simplified)
//
// These detectors use locally bundled regex patterns — no external API calls.
// All regexes are designed to be ReDoS-safe (no nested quantifiers, no ambiguous alternation).
//
// WHAT IS NOT COVERED (by design):
// - Generic address detection (too many false positives without NLP)
// - Freeform name detection in arbitrary prose (requires NER model)
// - Phone numbers (already handled by libphonenumber-js in the core library)
// - Emails (universal format, handled by core)

import type { Detector } from '@raeven-co/sether/browser';

// ── Helper: create a conversational name anchor detector ──────────────────────

function createNameAnchorDetector(
  regex: RegExp,
  stopwords: Set<string> = new Set(),
): Detector {
  return {
    type: 'NAME',
    detect(text: string) {
      const out: { start: number; end: number; value: string }[] = [];
      for (const m of text.matchAll(regex)) {
        const name = m[1];
        if (!name || m.index == null) continue;
        const firstWord = name.split(/\s+/)[0] ?? '';
        if (stopwords.has(firstWord)) continue;
        const start = m.index + m[0].length - name.length;
        out.push({ start, end: start + name.length, value: name });
      }
      return out;
    },
  };
}

// ── French ────────────────────────────────────────────────────────────────────

/** French conversational name anchors: "je m'appelle", "mon nom est", etc. */
export const frenchNameDetector = createNameAnchorDetector(
  /(?:[Jj]e m'appelle|[Mm]on nom est|[Jj]e suis|[Oo]n m'appelle)\s+([A-ZÀ-Ü][\p{L}''\-]+(?:\s+[A-ZÀ-Ü][\p{L}''\-]+){0,2})/gu,
  new Set(['Désolé', 'Sûr', 'Bien', 'Ici', 'Content', 'Prêt']),
);

/** French NIR (numéro de sécurité sociale): [12] YY MM CC CCC NNN KK
 *  Format: 1 or 2 + 12 digits + 2-digit control key = 15 digits total.
 *  We require the leading 1/2 (gender) and the structured digit groups. */
export const frenchNIRDetector: Detector = {
  type: 'NATIONAL_ID',
  detect(text: string) {
    const regex = /\b([12])\s?\d{2}\s?\d{2}\s?\d{2}\s?\d{3}\s?\d{3}\s?\d{2}\b/g;
    const out: { start: number; end: number; value: string }[] = [];
    for (const m of text.matchAll(regex)) {
      if (m.index == null) continue;
      out.push({ start: m.index, end: m.index + m[0].length, value: m[0] });
    }
    return out;
  },
};

// ── Spanish ───────────────────────────────────────────────────────────────────

/** Spanish conversational name anchors: "me llamo", "mi nombre es", etc. */
export const spanishNameDetector = createNameAnchorDetector(
  /(?:[Mm]e llamo|[Mm]i nombre es|[Ss]oy|[Mm]e dicen)\s+([A-ZÀ-Ü][\p{L}''\-]+(?:\s+[A-ZÀ-Ü][\p{L}''\-]+){0,2})/gu,
  new Set(['Seguro', 'Bien', 'Aquí', 'Listo', 'Contento']),
);

/** Spanish DNI: 8 digits + check letter (validated via modulo 23 lookup). */
export const spanishDNIDetector: Detector = {
  type: 'NATIONAL_ID',
  detect(text: string) {
    const regex = /\b(\d{8})\s?([A-Z])\b/g;
    const out: { start: number; end: number; value: string }[] = [];
    const validLetters = 'TRWAGMYFPDXBNJZSQVHLCKE';
    for (const m of text.matchAll(regex)) {
      if (m.index == null || !m[1] || !m[2]) continue;
      const num = parseInt(m[1], 10);
      const expectedLetter = validLetters[num % 23];
      if (m[2] === expectedLetter) {
        out.push({ start: m.index, end: m.index + m[0].length, value: m[0] });
      }
    }
    return out;
  },
};

/** Spanish NIE (foreigner ID): [XYZ] + 7 digits + check letter. */
export const spanishNIEDetector: Detector = {
  type: 'NATIONAL_ID',
  detect(text: string) {
    const regex = /\b([XYZ])\s?(\d{7})\s?([A-Z])\b/g;
    const out: { start: number; end: number; value: string }[] = [];
    for (const m of text.matchAll(regex)) {
      if (m.index == null) continue;
      out.push({ start: m.index, end: m.index + m[0].length, value: m[0] });
    }
    return out;
  },
};

// ── Portuguese ────────────────────────────────────────────────────────────────

/** Portuguese conversational name anchors: "meu nome é", "me chamo", etc. */
export const portugueseNameDetector = createNameAnchorDetector(
  /(?:[Mm]eu nome é|[Ee]u sou|[Mm]e chamo|[Cc]hamo-me)\s+([A-ZÀ-Ü][\p{L}''\-]+(?:\s+[A-ZÀ-Ü][\p{L}''\-]+){0,2})/gu,
  new Set(['Certo', 'Bem', 'Aqui', 'Pronto', 'Feliz']),
);

/** Brazilian CPF: XXX.XXX.XXX-XX (11 digits, dot-dash formatted).
 *  Rejects all-same-digit CPFs (e.g. 111.111.111-11) which are always invalid. */
export const brazilianCPFDetector: Detector = {
  type: 'NATIONAL_ID',
  detect(text: string) {
    const regex = /\b(\d{3})\.(\d{3})\.(\d{3})-(\d{2})\b/g;
    const out: { start: number; end: number; value: string }[] = [];
    for (const m of text.matchAll(regex)) {
      if (m.index == null) continue;
      const digits = m[0].replace(/\D/g, '');
      if (/^(\d)\1{10}$/.test(digits)) continue; // all same = invalid
      out.push({ start: m.index, end: m.index + m[0].length, value: m[0] });
    }
    return out;
  },
};

// ── German ────────────────────────────────────────────────────────────────────

/** German conversational name anchors: "mein Name ist", "ich heiße", etc. */
export const germanNameDetector = createNameAnchorDetector(
  /(?:[Mm]ein Name ist|[Ii]ch bin|[Ii]ch heiße|[Mm]an nennt mich)\s+([A-ZÀ-Ü][\p{L}''\-]+(?:\s+[A-ZÀ-Ü][\p{L}''\-]+){0,2})/gu,
  new Set(['Sicher', 'Gut', 'Hier', 'Fertig', 'Bereit', 'Froh']),
);

/** German Tax ID (Steuerliche Identifikationsnummer): 11 digits.
 *  Only matched when preceded by contextual keywords to avoid false positives. */
export const germanTaxIDDetector: Detector = {
  type: 'NATIONAL_ID',
  detect(text: string) {
    const regex = /(?:Steuer[\s-]?ID|IdNr|Identifikationsnummer|Steuernummer)\s*:?\s*(\d{2}\s?\d{3}\s?\d{3}\s?\d{3})\b/gi;
    const out: { start: number; end: number; value: string }[] = [];
    for (const m of text.matchAll(regex)) {
      if (m.index == null || !m[1]) continue;
      const digitsStart = m.index + m[0].indexOf(m[1]);
      out.push({ start: digitsStart, end: digitsStart + m[1].length, value: m[1] });
    }
    return out;
  },
};

// ── Arabic ────────────────────────────────────────────────────────────────────

/** Arabic conversational name anchors: "اسمي" (my name is), "أنا" (I am). */
export const arabicNameDetector: Detector = {
  type: 'NAME',
  detect(text: string) {
    const regex = /(?:اسمي|أنا|يدعونني)\s+([\p{Script=Arabic}''\-]+(?:\s+[\p{Script=Arabic}''\-]+){0,3})/gu;
    const out: { start: number; end: number; value: string }[] = [];
    for (const m of text.matchAll(regex)) {
      const name = m[1];
      if (!name || m.index == null) continue;
      if (name.length < 3) continue; // skip very short matches
      const start = m.index + m[0].length - name.length;
      out.push({ start, end: start + name.length, value: name });
    }
    return out;
  },
};

/** Egyptian National ID: 14 digits starting with 2 or 3 (birth century),
 *  followed by date-of-birth digits (YYMMDD) and a 7-digit serial. */
export const egyptianIDDetector: Detector = {
  type: 'NATIONAL_ID',
  detect(text: string) {
    const regex = /\b([23])\d{13}\b/g;
    const out: { start: number; end: number; value: string }[] = [];
    for (const m of text.matchAll(regex)) {
      if (m.index == null) continue;
      const digits = m[0];
      const month = parseInt(digits.slice(3, 5), 10);
      const day = parseInt(digits.slice(5, 7), 10);
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        out.push({ start: m.index, end: m.index + m[0].length, value: m[0] });
      }
    }
    return out;
  },
};

// ── Chinese (Simplified) ─────────────────────────────────────────────────────

/** Chinese conversational name anchors: "我叫" (I'm called), "我是" (I am), etc. */
export const chineseNameDetector: Detector = {
  type: 'NAME',
  detect(text: string) {
    const regex = /(?:我叫|我是|我的名字是|我姓|本人)\s*([\u4e00-\u9fff]{2,4})/gu;
    const out: { start: number; end: number; value: string }[] = [];
    const stopwords = new Set(['什么', '这个', '那个', '一个', '不是', '可以', '怎么', '谁的']);
    for (const m of text.matchAll(regex)) {
      const name = m[1];
      if (!name || m.index == null) continue;
      if (stopwords.has(name)) continue;
      const start = m.index + m[0].length - name.length;
      out.push({ start, end: start + name.length, value: name });
    }
    return out;
  },
};

/** Chinese Resident Identity Card: 18 chars.
 *  Format: 6-digit area code + 8-digit birth date (YYYYMMDD) + 3-digit serial + 1 check (digit or X). */
export const chineseIDDetector: Detector = {
  type: 'NATIONAL_ID',
  detect(text: string) {
    const regex = /\b[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g;
    const out: { start: number; end: number; value: string }[] = [];
    for (const m of text.matchAll(regex)) {
      if (m.index == null) continue;
      out.push({ start: m.index, end: m.index + m[0].length, value: m[0] });
    }
    return out;
  },
};

// ── Export all multilingual detectors ─────────────────────────────────────────

export const multilingualDetectors: readonly Detector[] = [
  frenchNameDetector,
  frenchNIRDetector,
  spanishNameDetector,
  spanishDNIDetector,
  spanishNIEDetector,
  portugueseNameDetector,
  brazilianCPFDetector,
  germanNameDetector,
  germanTaxIDDetector,
  arabicNameDetector,
  egyptianIDDetector,
  chineseNameDetector,
  chineseIDDetector,
];
