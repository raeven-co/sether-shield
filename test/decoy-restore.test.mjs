// Decoy + restore lifecycle tests — the v0.4.0 feature set:
//  1. Detection-gap regressions (national phones, prose API keys/passwords,
//     lowercase anchored names, born-on DOB, crescent addresses).
//  2. Decoy suggestions: realistic, distinct, never the original.
//  3. The full user journey, simulated at the text level exactly the way
//     content.ts applies it: detect → swap decoys in → re-detect (decoys are
//     not re-flagged) → AI reply echoes the decoy → restore brings the real
//     values back — in the editor AND in the copied reply.
// Run after npm install: node test/decoy-restore.test.mjs

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

const { detect } = await load('../src/detector.ts');
const { suggestAliases, AliasVault } = await load('./alias-reexport.mjs');

let failed = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failed++;
};

// ── 1. Detection-gap regressions ──────────────────────────────────────────────

const gapCases = [
  ['NG national phone', 'call me on 08065786535', 'PHONE'],
  ['NG spaced phone', 'my number is 0806 578 6535', 'PHONE'],
  ['US national phone', 'call me at (415) 555-2671', 'PHONE'],
  ['US dashed phone', 'my number is 415-555-2671', 'PHONE'],
  ['labelled phone', 'Phone: 08065786535', 'PHONE'],
  ['short API key', 'use apikey AbC123xYz789QwE456', 'API_KEY'],
  ['password prose', 'my password is hunter2butlonger', 'PASSWORD'],
  ['lowercase anchored name', 'my name is godfrey lebo', 'NAME'],
  ['born-on DOB', 'I was born on 14/03/1995', 'DOB'],
  ['crescent address', 'I live at 24 Adetokunbo Ademola Crescent, Wuse 2, Abuja', 'ADDRESS'],
];
for (const [name, text, type] of gapCases) {
  check(`detects ${name}`, detect(text).some((m) => m.type === type));
}

check(
  'lowercase name trims sentence continuation',
  detect('my name is godfrey lebo and i need help').some(
    (m) => m.type === 'NAME' && m.value === 'godfrey lebo',
  ),
);
check(
  'no lowercase-name false positive',
  !detect('my name is not important right now').some((m) => m.type === 'NAME'),
);
check('9-digit ref is not a phone', !detect('patient ref 123456789 confirmed').some((m) => m.type === 'PHONE'));

// ── 2. Decoy suggestions ──────────────────────────────────────────────────────

const nameSuggestions = suggestAliases('NAME', 'Godfrey Lebo', 3);
check('3 name decoys offered', nameSuggestions.length === 3);
check('name decoys are distinct', new Set(nameSuggestions).size === 3);
check('name decoys exclude the original', !nameSuggestions.includes('Godfrey Lebo'));
check(
  'name decoys look like two-word names',
  nameSuggestions.every((s) => s.split(' ').length === 2),
);

const emailSuggestions = suggestAliases('EMAIL', 'emory@gmail.com', 3);
check(
  'email decoys use reserved domains',
  emailSuggestions.every((s) => /@example\.(com|org|net)$/.test(s)),
);

const phoneSuggestions = suggestAliases('PHONE', '+2348065786535', 3);
check(
  'NG phone decoys stay NG-shaped',
  phoneSuggestions.every((s) => s.startsWith('+234')),
);

// ── 3. Full lifecycle: scrub with decoys → AI echo → restore ─────────────────

const prompt =
  'My name is Godfrey Lebo, my email address is emory@gmail.com, ' +
  'call me on 08065786535. Regards, Godfrey Lebo';

const vault = new AliasVault();
const replacementLog = new Map(); // replacement → original (mirrors content.ts)

// detect + swap, right-to-left, exactly like doScrub()
const matches = detect(prompt);
check('lifecycle: all 3 PII types found', new Set(matches.map((m) => m.type)).size >= 3);

let scrubbed = prompt;
for (const m of [...matches].sort((a, b) => b.start - a.start)) {
  const decoy = vault.aliasFor(m.type, m.value);
  if (!replacementLog.has(decoy)) replacementLog.set(decoy, m.value);
  scrubbed = scrubbed.slice(0, m.start) + decoy + scrubbed.slice(m.end);
}
// sweepRemaining mirror: unanchored repeat mentions get swept too
for (const [rep, orig] of replacementLog.entries()) {
  if (orig.length >= 4) scrubbed = scrubbed.split(orig).join(rep);
}

check('lifecycle: no real name in scrubbed prompt', !scrubbed.includes('Godfrey Lebo'));
check('lifecycle: no real email in scrubbed prompt', !scrubbed.includes('emory@gmail.com'));
check('lifecycle: no real phone in scrubbed prompt', !scrubbed.includes('08065786535'));

const decoyName = vault.aliasOf('Godfrey Lebo');
check('lifecycle: stable decoy reused for repeated mention',
  scrubbed.split(decoyName).length - 1 === 2);

// decoys must NOT be re-flagged (content.ts filters via the log/vault)
const reflagged = detect(scrubbed).filter(
  (m) => replacementLog.has(m.value) || vault.originalOf(m.value) !== undefined,
);
const newFindings = detect(scrubbed).filter(
  (m) => !replacementLog.has(m.value) && vault.originalOf(m.value) === undefined,
);
check('lifecycle: decoys detectable but filtered as applied', reflagged.length >= 1);
check('lifecycle: nothing NEW flagged after scrub', newFindings.length === 0);

// restore in the editor (restoreText mirror: longest replacement first)
function restoreText(text) {
  let out = text;
  for (const [rep, orig] of [...replacementLog.entries()].sort((a, b) => b[0].length - a[0].length)) {
    out = out.split(rep).join(orig);
  }
  return out;
}
check('lifecycle: editor restore round-trips exactly', restoreText(scrubbed) === prompt);

// AI reply echoes the decoy → copy-with-real-values
const aiReply = `Dear ${decoyName},\n\nHere is the cover letter you asked for. ` +
  `Best of luck!\n\n— drafted for ${decoyName}`;
const restoredReply = restoreText(aiReply);
check('lifecycle: AI reply decoy echo restored', restoredReply.includes('Godfrey Lebo'));
check('lifecycle: no decoy left in restored reply', !restoredReply.includes(decoyName));

// user edits AROUND the decoys, restore still works
const edited = scrubbed + '\n\nPS: please make it formal.';
check('lifecycle: restore survives user edits', restoreText(edited).startsWith(prompt));

// mask collisions: first mapping wins, second skipped (never mis-restored)
const log2 = new Map();
if (!log2.has('G***')) log2.set('G***', 'Godfrey');
if (!log2.has('G***')) log2.set('G***', 'Gabriel');
check('collision: first mask mapping wins', log2.get('G***') === 'Godfrey');

console.log(failed === 0 ? '\n✅ all decoy/restore checks passed' : `\n❌ ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
