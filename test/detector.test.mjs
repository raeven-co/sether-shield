// Detector smoke tests — exercises the REAL @raeven-co/sether detectors
// (via the browser-safe entry) plus conversational-name heuristic,
// credential detectors, and custom rule API.
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
const { detect, scrub, restore, maskValue, applyCustomRules } = mod;

let failed = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failed++;
};

// ── Core PII detection ────────────────────────────────────────────────────────

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

// ── Scrub + Restore ───────────────────────────────────────────────────────────

const scrubbed = scrub(sample);
check('scrub removes the email', !scrubbed.text.includes('amara.okafor@acme.com'));
check('scrub removes the card', !scrubbed.text.includes('4242 4242 4242 4242'));
check('scrub inserts placeholders', /\[email-1\]/.test(scrubbed.text));
check('scrub count matches', scrubbed.count === found.length);
check('scrub returns a vault', Array.isArray(scrubbed.vault) && scrubbed.vault.length === scrubbed.count);
check('restore round-trips to the original', restore(scrubbed.text, scrubbed.vault) === sample);
check('restore is a no-op without placeholders', restore('plain text', scrubbed.vault) === 'plain text');

// ── Credential detection ──────────────────────────────────────────────────────

// The exact prompt the user reported not being detected:
const mongoPrompt = 'I want to connect to mongodb using my credentials MONGODB_URI=mongodb+srv://acco_user:yv7G@cluster0.huckxlg.mongodb.net/ but it is not working.';
const mongoFound = detect(mongoPrompt);
check('detects MongoDB URI with credentials', mongoFound.some((m) => m.type === 'DB_URI' || m.type === 'CREDENTIAL'));
check('detects env var MONGODB_URI=', mongoFound.some((m) => m.type === 'CREDENTIAL' && m.value.includes('MONGODB_URI')));

check('detects SECRET_KEY env var', detect('SECRET_KEY=a8f2e9b1c3d4e5f6789').some((m) => m.type === 'CREDENTIAL'));
check('detects DB_PASSWORD env var', detect('DB_PASSWORD=hunter2').some((m) => m.type === 'CREDENTIAL'));
check('detects generic password: field', detect('password: "s3cretP@ss"').some((m) => m.type === 'CREDENTIAL'));
check('detects postgres URI with creds', detect('postgres://admin:secretpass@db.example.com:5432/mydb').some((m) => m.type === 'DB_URI'));
check('no false positive on normal env var', !detect('NODE_ENV=production').some((m) => m.type === 'CREDENTIAL'));
check('no false positive on LOG_LEVEL', !detect('LOG_LEVEL=debug').some((m) => m.type === 'CREDENTIAL'));

// ── Masking ───────────────────────────────────────────────────────────────────

if (maskValue) {
  check('masks DB_URI password', maskValue('mongodb+srv://user:mypass@host.net/', 'DB_URI').includes('***') && !maskValue('mongodb+srv://user:mypass@host.net/', 'DB_URI').includes('mypass'));
  check('masks CREDENTIAL value', maskValue('SECRET_KEY=abc123', 'CREDENTIAL') === 'SECRET_KEY=***');
  check('masks email', maskValue('alice@example.com', 'EMAIL').includes('***'));
  check('masks phone', maskValue('+14155552671', 'PHONE').includes('****'));
}

// ── Custom rules (F2) ─────────────────────────────────────────────────────────

if (applyCustomRules) {
  applyCustomRules([{
    id: 'test-rule-1',
    name: 'Test 9-digit number',
    pattern: '\\b\\d{9}\\b',
    flags: 'g',
    replacement: '[TEST]',
    enabled: true,
    builtIn: false,
  }]);
  const customFound = detect('patient ref 123456789 confirmed');
  check('custom rule detects 9-digit number', customFound.some((m) => m.type === 'CUSTOM:test-rule-1'));

  // Disabled rule should NOT fire
  applyCustomRules([{
    id: 'test-rule-2',
    name: 'Disabled rule',
    pattern: '\\b\\d{9}\\b',
    flags: 'g',
    replacement: '[TEST]',
    enabled: false,
    builtIn: false,
  }]);
  const disabledFound = detect('patient ref 123456789 confirmed');
  check('disabled custom rule does not fire', !disabledFound.some((m) => m.type === 'CUSTOM:test-rule-2'));

  // Reset custom rules
  applyCustomRules([]);
}

console.log(failed ? `\n❌ ${failed} failed` : '\n✅ all detector checks passed');
process.exit(failed ? 1 : 0);
