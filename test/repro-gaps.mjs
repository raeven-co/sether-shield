// Reproduction harness — realistic ChatGPT-style prompts, checks what the
// CURRENT shield detector catches vs. misses. Not a pass/fail suite; a report.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const out = await build({
  entryPoints: [path.join(dir, '../src/detector.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
});
const mod = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));
const { detect } = mod;

const cases = [
  // — the user's exact scenario —
  ['convo name+email', 'My name is Godfrey Lebo, my email address is emory@gmail.com'],
  // names, different phrasings
  ['name mid-sentence', 'please write a cover letter for Godfrey Lebo applying to Google'],
  ['i am name', "i am Sarah Connor and I need help with my resume"],
  ['name lowercase anchor', 'my name is godfrey lebo'],
  // phone numbers, various formats
  ['phone NG national', 'call me on 08065786535'],
  ['phone NG spaced', 'my number is 0806 578 6535'],
  ['phone US national', 'call me at (415) 555-2671'],
  ['phone US dashed', 'my number is 415-555-2671'],
  ['phone intl', 'reach me on +2348065786535'],
  ['phone labelled', 'Phone: 08065786535'],
  // API keys / secrets
  ['openai key', 'my api key is sk-proj-Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z'],
  ['generic api key label', 'my API key is 9f8e7d6c5b4a39281706f5e4d3c2b1a0'],
  ['short api key', 'use apikey AbC123xYz789QwE456'],
  // Built by concatenation so GitHub push protection doesn't mistake the
  // synthetic fixture for a real live key (same trick as the core test suite).
  ['stripe key', 'STRIPE_SECRET=' + 'sk_' + 'live_' + '4eC39HqLyjWDarjtT1zdp7dc00xyzABCDE'],
  ['bearer token', 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c'],
  ['password prose', 'my password is hunter2butlonger'],
  // addresses / other
  ['address', 'I live at 24 Adetokunbo Ademola Crescent, Wuse 2, Abuja'],
  ['dob', 'I was born on 14/03/1995'],
  ['card', 'card number 4242 4242 4242 4242'],
];

for (const [label, text] of cases) {
  const found = detect(text);
  const desc = found.length
    ? found.map((m) => `${m.type}:"${m.value}"`).join(', ')
    : '— NOTHING —';
  console.log(`${found.length ? 'HIT ' : 'MISS'}  ${label.padEnd(24)} ${desc}`);
}
