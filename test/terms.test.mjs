// Watchlist terms tests — the v0.5.0 file-import feature:
//  1. Sample file parses cleanly (dogfood: what we hand users must import).
//  2. CSV edge cases: quoted commas, header anywhere, comments, bad actions,
//     duplicates, short terms, JSON input.
//  3. findTerm boundaries: whole-word vs substring, case sensitivity,
//     punctuation-edged terms (emails, +phones) where \b does not apply.
//  4. Detector integration: applyCustomTerms → detect() flags terms, term
//     matches win equal-span overlaps against built-in detectors.
// Run after npm install: node test/terms.test.mjs

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));

async function load(entry) {
  const out = await build({
    entryPoints: [path.join(dir, entry)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
  });
  return import(
    'data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64')
  );
}

const { parseTermsFile, sampleTermsFile, findTerm } = await load('../src/terms.ts');
const { detect, applyCustomTerms, termForType, labelFor } = await load('../src/detector.ts');

let failed = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failed++;
};

// ── 1. Sample file round-trip ─────────────────────────────────────────────────

{
  const { terms, errors } = parseTermsFile(sampleTermsFile());
  check('sample: parses with zero errors', errors.length === 0);
  check('sample: yields 5 example terms', terms.length === 5);
  const byTerm = Object.fromEntries(terms.map((t) => [t.term, t]));
  check('sample: name row is a decoy with fixed replacement',
    byTerm['Godfrey Lebo']?.action === 'decoy' && byTerm['Godfrey Lebo']?.replacement === 'John Doe');
  check('sample: company row is redact with custom placeholder',
    byTerm['Raeven Company']?.action === 'redact' && byTerm['Raeven Company']?.replacement === '[my-company]');
  check('sample: phone row auto-generates (empty replacement)',
    byTerm['+2348031234567']?.action === 'decoy' && byTerm['+2348031234567']?.replacement === undefined);
}

// ── 2. CSV edge cases ─────────────────────────────────────────────────────────

{
  const { terms } = parseTermsFile('"Lebo, Godfrey",mask,,yes,no');
  check('csv: quoted comma stays one term', terms.length === 1 && terms[0].term === 'Lebo, Godfrey');
  check('csv: match_case + whole_word flags honoured', terms[0].matchCase === true && terms[0].wholeWord === false);
}
{
  const { terms, errors } = parseTermsFile('Acme Corp,obliterate,,,\n');
  check('csv: unknown action defaults to decoy + reports it',
    terms[0]?.action === 'decoy' && errors.some((e) => e.includes('obliterate')));
}
{
  const { terms, errors } = parseTermsFile('Godfrey,decoy\ngodfrey,mask');
  check('csv: case-insensitive duplicate skipped, first wins',
    terms.length === 1 && terms[0].action === 'decoy' && errors.some((e) => e.includes('duplicate')));
}
{
  const { terms, errors } = parseTermsFile('x,decoy');
  check('csv: 1-char term rejected', terms.length === 0 && errors.length === 1);
}
{
  const { terms } = parseTermsFile('[{"term":"Project Falcon","action":"mask"},{"term":"emory@gmail.com"}]');
  check('json: array form accepted, defaults applied',
    terms.length === 2 && terms[0].action === 'mask' && terms[1].action === 'decoy' && terms[1].wholeWord === true);
}
{
  const { terms, errors } = parseTermsFile('');
  check('empty file: no terms, one friendly error', terms.length === 0 && errors.length === 1);
}

// ── 3. findTerm boundaries ────────────────────────────────────────────────────

const mk = (term, over = {}) => ({
  id: 't1', term, action: 'decoy', matchCase: false, wholeWord: true, enabled: true, ...over,
});

{
  const hits = findTerm('Contact Godfrey Lebo and godfrey lebo today', mk('Godfrey Lebo'));
  check('find: case-insensitive by default, both hits', hits.length === 2);
  check('find: positions are exact',
    hits[0].value === 'Godfrey Lebo' && hits[1].value === 'godfrey lebo');
}
{
  const hits = findTerm('Godfreyson is not Godfrey', mk('Godfrey'));
  check('find: whole-word does not match inside Godfreyson', hits.length === 1 && hits[0].start === 18);
}
{
  const hits = findTerm('mail emory@gmail.com now', mk('emory@gmail.com'));
  check('find: punctuation-edged term (email) matches', hits.length === 1);
}
{
  const hits = findTerm('call +2348031234567 now', mk('+2348031234567'));
  check('find: term starting with + matches (no \\b trap)', hits.length === 1);
}
{
  const hits = findTerm('AcmeX vs Acme', mk('Acme', { wholeWord: false }));
  check('find: substring mode matches inside words', hits.length === 2);
}
{
  const hits = findTerm('godfrey GODFREY Godfrey', mk('Godfrey', { matchCase: true }));
  check('find: case-sensitive matches exactly one', hits.length === 1);
}

// ── 4. Detector integration ───────────────────────────────────────────────────

{
  applyCustomTerms([
    mk('Project Falcon', { id: 'w1', action: 'redact' }),
    mk('Godfrey Lebo', { id: 'w2', action: 'decoy', replacement: 'John Doe' }),
  ]);

  const text = 'My name is Godfrey Lebo and I run Project Falcon.';
  const matches = detect(text);
  const termMatches = matches.filter((m) => m.type.startsWith('TERM:'));
  check('integration: both watchlist terms detected', termMatches.length === 2);

  // "Godfrey Lebo" is also caught by the conversational NAME anchor — the
  // watchlist match must win the equal-span overlap so its per-file action rules.
  const nameSpan = matches.find((m) => m.value === 'Godfrey Lebo');
  check('integration: watchlist beats NAME detector on equal span',
    nameSpan?.type === 'TERM:w2');
  check('integration: termForType resolves the imported term',
    termForType('TERM:w2')?.replacement === 'John Doe');
  check('integration: label is watchlist', labelFor('TERM:w1') === 'watchlist');

  applyCustomTerms([]);
  const cleared = detect(text).filter((m) => m.type.startsWith('TERM:'));
  check('integration: clearing terms removes detectors', cleared.length === 0);
}

console.log(failed === 0 ? '✅ all watchlist checks passed' : `❌ ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
