// Detector smoke test — now exercises the REAL @raeven-co/sether detectors
// (via the browser-safe entry) plus the conversational-name heuristic.
// Run after build: node test/detector.test.mjs

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
const { detect, scrub } = mod;

let failed = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failed++;
};

const sample =
  'Hi, email amara.okafor@acme.com, call +1 (415) 555-2671, card 4242 4242 4242 4242, ' +
  'SSN 123-45-6789, key AKIAIOSFODNN7EXAMPLE.';
const found = detect(sample);
const vals = found.map((m) => m.value);

check('detects email', vals.some((v) => v.includes('amara.okafor@acme.com')));
check('detects phone (formatted)', found.some((m) => m.type === 'PHONE'));
check('detects card', vals.some((v) => v.replace(/\s/g, '') === '4242424242424242'));
check('detects SSN', vals.includes('123-45-6789'));
check('detects AWS key', vals.includes('AKIAIOSFODNN7EXAMPLE'));
check('detects continuous intl phone (+234…)', detect('reach me on +2348065786535 anytime').some((m) => m.type === 'PHONE'));
check('detects labelled name', detect('Name: John Doe').some((m) => m.type === 'NAME'));
check('detects conversational name', detect('hey, my name is Emori and I build things').some((m) => m.type === 'NAME' && m.value === 'Emori'));
check('no conversational-name false positive', !detect('I am going to the market on tuesday').some((m) => m.type === 'NAME'));

const fakeCard = 'pay 1234 5678 9012 3456 now'; // fails Luhn
check('rejects non-Luhn card', !detect(fakeCard).some((m) => m.type === 'CC'));
check('no false positive on plain text', detect('the meeting is at 3pm on tuesday').length === 0);

const scrubbed = scrub(sample);
check('scrub removes the email', !scrubbed.text.includes('amara.okafor@acme.com'));
check('scrub removes the card', !scrubbed.text.includes('4242 4242 4242 4242'));
check('scrub inserts placeholders', /\[email-1\]/.test(scrubbed.text));
check('scrub count matches', scrubbed.count === found.length);

console.log(failed ? `\n❌ ${failed} failed` : '\n✅ all detector checks passed');
process.exit(failed ? 1 : 0);
