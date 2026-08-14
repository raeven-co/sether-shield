// End-to-end lifecycle test — drives the real unpacked extension in real Chrome.
//
// Covers the two things unit tests cannot reach:
//   1. The allowlist gate. A non-allowlisted origin must get ZERO injected DOM,
//      so a page cannot fingerprint the extension by probing for it.
//   2. Activation without a reload. Adding the current site from the popup must
//      light up the already-open tab, because reloading would destroy the
//      user's in-progress prompt.
//
// Run: npm run test:e2e   (requires Google Chrome installed)

import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';

// Defaults to the repo. Set EXT_PATH to an unzipped store package to verify the
// artifact you are about to submit, rather than the working tree it came from.
const EXT = process.env.EXT_PATH
  ? resolve(process.env.EXT_PATH)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOST_SEL = '#sether-shield-host';
const STYLE_SEL = '#sether-shield-global-styles';

/** Locate Chrome for Testing.
 *
 *  Branded Google Chrome cannot be used here: it hard-refuses
 *  --disable-extensions-except ("not allowed in Google Chrome, ignoring"), so the
 *  extension never loads and every assertion below would vacuously pass.
 *  Install with: npx @puppeteer/browsers install chrome@stable */
function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const root = join(process.env.PUPPETEER_CACHE_DIR ?? join(homedir(), '.cache', 'puppeteer'), 'chrome');
  if (!existsSync(root)) return null;
  for (const build of readdirSync(root).sort().reverse()) {
    for (const p of [
      join(root, build, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
      join(root, build, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
      join(root, build, 'chrome-linux64', 'chrome'),
    ]) {
      if (existsSync(p)) return p;
    }
  }
  return null;
}

const CHROME = findChrome();
if (!CHROME) {
  console.error('Chrome for Testing not found. Run: npx @puppeteer/browsers install chrome@stable');
  process.exit(1);
}

let pass = 0;
let fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}`); }
};

// Minimal page with a contenteditable, standing in for an AI chat composer.
const server = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!doctype html><meta charset=utf-8><title>t</title><div id="prompt-textarea" contenteditable="true"></div>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  // Puppeteer's defaults include --disable-extensions, which would silently
  // defeat the whole point of this file.
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
});

/** Grab the MV3 service worker so we can drive chrome.storage as the popup would. */
async function serviceWorker() {
  const t = await browser.waitForTarget((t) => t.type() === 'service_worker', { timeout: 10_000 });
  return t.worker();
}

/** Write the allowlist exactly as the popup's addAllowedSite/removeAllowedSite do. */
async function setAllowedSites(sw, sites) {
  await sw.evaluate(
    (s) => new Promise((r) => chrome.storage.local.set({ siteSettings: { allowedSites: s } }, r)),
    sites,
  );
}

const has = (page, sel) => page.evaluate((s) => !!document.querySelector(s), sel);
const countOf = (page, sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel);
const settle = (ms = 900) => new Promise((r) => setTimeout(r, ms));

/** Type PII into the composer and report whether the shield actually flagged it.
 *
 *  This is the load-bearing assertion. Presence of #sether-shield-host proves
 *  nothing: the pre-fix code created it unconditionally and merely hid it. Only a
 *  live detection proves the input listeners are really attached.
 *
 *  Reads the pill, which carries the live match count. Not the panel: the panel
 *  only renders its contents once opened, so it reads empty even on a successful
 *  detection. Not shadowRoot.textContent either, which includes the injected CSS
 *  and the "100% local" footer, so loose matching gives false positives. */
async function detectsPII(page, text) {
  await page.evaluate(() => { document.querySelector('#prompt-textarea').textContent = ''; });
  await page.focus('#prompt-textarea');
  await page.type('#prompt-textarea', text);
  await settle(1400);
  return page.evaluate((s) => {
    const pill = document.querySelector(s)?.shadowRoot?.querySelector('.pill');
    const n = parseInt((pill?.textContent ?? '').trim(), 10);
    return Number.isFinite(n) && n > 0;
  }, HOST_SEL);
}

try {
  const sw = await serviceWorker();

  // ── 1. Off-allowlist origin: nothing injected ───────────────────────────────
  await setAllowedSites(sw, ['https://chatgpt.com']);
  const page = await browser.newPage();
  await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' });
  await settle();

  ok('off-allowlist: no shield host injected', (await has(page, HOST_SEL)) === false);
  ok('off-allowlist: no global styles injected (not fingerprintable)', (await has(page, STYLE_SEL)) === false);

  // ── 2. Add current site from popup: activates WITHOUT a reload ──────────────
  await setAllowedSites(sw, ['https://chatgpt.com', ORIGIN]);
  await settle();

  ok('add site: shield host appears on the open tab, no reload', (await has(page, HOST_SEL)) === true);
  ok('add site: global styles now injected', (await has(page, STYLE_SEL)) === true);
  // The one that actually proves activation rather than mere presence.
  ok('add site: shield is FUNCTIONAL without a reload (listeners attached)',
     (await detectsPII(page, 'email me at jane.doe@example.com ok')) === true);

  // The user's draft must survive activation — reloading would have wiped it.
  await page.evaluate(() => { document.querySelector('#prompt-textarea').textContent = 'draft survives'; });
  await setAllowedSites(sw, ['https://chatgpt.com', ORIGIN, 'https://claude.ai']);
  await settle();
  ok(
    'add site: in-progress prompt not destroyed',
    (await page.evaluate(() => document.querySelector('#prompt-textarea').textContent)) === 'draft survives',
  );

  // ── 3. Idempotency: repeated activation must not duplicate the host ─────────
  ok('activate is idempotent: exactly one shield host', (await countOf(page, HOST_SEL)) === 1);

  // ── 4. Remove site: deactivates in place ───────────────────────────────────
  await setAllowedSites(sw, ['https://chatgpt.com']);
  await settle();

  ok('remove site: shield host removed', (await has(page, HOST_SEL)) === false);
  ok('remove site: global styles removed', (await has(page, STYLE_SEL)) === false);

  // ── 5. Re-add after removal: cleanly comes back ────────────────────────────
  await setAllowedSites(sw, ['https://chatgpt.com', ORIGIN]);
  await settle();

  ok('re-add after removal: shield returns', (await has(page, HOST_SEL)) === true);
  ok('re-add after removal: still exactly one host', (await countOf(page, HOST_SEL)) === 1);

  // ── 6. Detection still works after a deactivate/activate cycle ─────────────
  ok('re-add after removal: detection works again (listeners re-attached)',
     (await detectsPII(page, 'my card is 4111 1111 1111 1111')) === true);

  // ── 7. Off-allowlist, the shield must NOT read the composer ───────────────
  await setAllowedSites(sw, ['https://chatgpt.com']);
  await settle();
  ok('off-allowlist: composer is not scanned', (await detectsPII(page, 'ssn 123-45-6789')) === false);
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${fail === 0 ? '✅' : '❌'} lifecycle e2e: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
