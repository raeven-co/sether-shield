// Builds the Chrome Web Store zip.
//
// The file list is DERIVED FROM manifest.json rather than hand-listed. The old
// hand-listed `zip -r out.zip manifest.json dist icons popup.html` was duplicated
// across two CI jobs and silently omitted _locales/ once default_locale landed,
// which produces a package the store rejects. Deriving the list means adding a
// manifest key can never again leave the package behind.
//
// Run: npm run package

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

const fail = (msg) => { console.error(`✖ ${msg}`); process.exitCode = 1; };

// ── Version parity ────────────────────────────────────────────────────────────
// The store version comes from the manifest, but a drifting package.json makes
// every future "what shipped?" question a guess.
if (manifest.version !== pkg.version) {
  fail(`version mismatch: manifest.json ${manifest.version} vs package.json ${pkg.version}`);
}

// ── Collect every path the manifest actually references ───────────────────────
const files = new Set(['manifest.json']);

const addIcons = (obj) => { for (const p of Object.values(obj ?? {})) files.add(p); };
addIcons(manifest.icons);
addIcons(manifest.action?.default_icon);
if (manifest.action?.default_popup) files.add(manifest.action.default_popup);
if (manifest.background?.service_worker) files.add(manifest.background.service_worker);
for (const cs of manifest.content_scripts ?? []) {
  for (const js of cs.js ?? []) files.add(js);
  for (const css of cs.css ?? []) files.add(css);
}
for (const war of manifest.web_accessible_resources ?? []) {
  for (const r of war.resources ?? []) files.add(r);
}

// ── _locales: required whenever default_locale is set ─────────────────────────
if (manifest.default_locale) {
  if (!existsSync('_locales')) {
    fail('manifest sets default_locale but _locales/ does not exist');
  } else {
    const langs = readdirSync('_locales').filter((d) => statSync(join('_locales', d)).isDirectory());
    if (!langs.includes(manifest.default_locale)) {
      fail(`default_locale "${manifest.default_locale}" has no _locales/${manifest.default_locale}/`);
    }
    for (const l of langs) files.add(join('_locales', l, 'messages.json'));
  }
}

// popup.html pulls its script with a relative src; make sure that came along.
if (manifest.action?.default_popup && existsSync(manifest.action.default_popup)) {
  const html = readFileSync(manifest.action.default_popup, 'utf8');
  for (const m of html.matchAll(/(?:src|href)="([^"#:]+)"/g)) {
    const ref = m[1].replace(/^\.\//, '');
    if (!ref.startsWith('http') && existsSync(ref)) files.add(ref);
  }
}

// ── Everything referenced must exist ──────────────────────────────────────────
for (const f of files) {
  if (!existsSync(f)) fail(`manifest references "${f}" but it is not on disk (did you run npm run build?)`);
}

// ── Nothing sensitive or dead-weight may ship ─────────────────────────────────
for (const f of files) {
  if (/^(src|test|node_modules|store-assets)\//.test(f) || f.endsWith('.map') || f.endsWith('.ts')) {
    fail(`refusing to package "${f}" — source/test artifacts must not ship`);
  }
}

if (process.exitCode) {
  console.error('\nPackaging aborted.');
  process.exit(1);
}

// ── Zip ───────────────────────────────────────────────────────────────────────
const out = join('out', `sether-shield-v${manifest.version}.zip`);
mkdirSync('out', { recursive: true });
rmSync(out, { force: true });

// -X strips extra file attributes for a more reproducible archive.
execFileSync('zip', ['-q', '-X', '-r', out, ...[...files].sort()], { stdio: 'inherit' });

const size = statSync(out).size;
console.log(`\n📦 ${out}  (${(size / 1024).toFixed(0)} KB)`);
for (const f of [...files].sort()) console.log(`   ${f}`);

// Loud about what was intentionally left behind, so "did the icons ship?" is
// never a mystery.
const unreferenced = existsSync('icons')
  ? readdirSync('icons').map((f) => join('icons', f)).filter((f) => !files.has(f))
  : [];
if (unreferenced.length) {
  console.log(`\n   excluded (not referenced by manifest): ${unreferenced.join(', ')}`);
}
