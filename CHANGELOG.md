# Changelog

## 0.4.0 — 2026-08-13

Decoy mode, restore, and the detection gaps from the field report. Built on
`@raeven-co/sether` 0.7.0. Still 100% local — the vault that maps decoys back
to your real values lives in tab memory only and never touches disk.

### Fixed — the detection gaps

"My name is Godfrey, my number is 0806 578 6535, my api key is …" used to
sail through with only the email caught. Now:

- **National-format phone numbers** are detected (multi-region libphonenumber:
  US/GB/NG/CA defaults + your browser locale's regions). `08065786535`,
  `(415) 555-2671`, `415-555-2671` all catch; `+…` international still works.
- **Prose-labelled API keys and passwords** — `my api key is AbC123…`,
  `password: hunter2butlonger` — via the core's new label-anchored detectors.
- **Lowercase anchored names** — `my name is godfrey lebo` — with trailing
  sentence words trimmed (`… godfrey lebo and i need help` captures just the
  name).
- **"born on" dates and Commonwealth addresses** (`24 … Crescent, Wuse 2`).
- **False positive fixed:** `my email address is x@y.com, call 0806…` was one
  giant ADDRESS match swallowing the whole line ("email/IP/wallet address"
  compounds no longer anchor the address detector).
- Once you scrub a value, **repeat unanchored mentions are swept too**
  ("Regards, Godfrey Lebo" at the end of the prompt no longer survives).

### Added — Decoy mode (redact by misleading)

A Mask/Decoy toggle in the panel (and popup). In decoy mode, scrubbing swaps
each value for a realistic fake the AI reads naturally: names become John
Doe-style names, phones become officially-fictional numbers (555-01XX /
07700 900XXX ranges), emails move to example.com, cards are Luhn-valid test
numbers, API keys keep their vendor prefix with a scrambled tail. The 🎭
button on each detection opens suggestion chips (3 decoys + reshuffle) so you
pick the decoy you like. The same value always gets the same decoy within a
session, so a prompt that mentions you three times stays coherent.

### Added — Restore

- **Restore originals** button in the panel: swaps every decoy/mask in the
  composer back to the real values (works even after you edit around them).
- **AI Response Guard** now recognises your decoys when the AI echoes them
  back and offers **Copy reply with real values** — the clipboard gets the
  reply with your real data restored; the page itself never sees it.

### Build & test surface

- Unit + lifecycle: 31 detector checks, 32 decoy/restore checks, all passing
- E2E in real Chrome (allowlist gate, no-reload activation): 13/13 passing
- New locale strings translated across all 7 languages

## 0.3.1 — 2026-07-16

First release of the 0.3 line. 0.3.0 was merged but never published; 0.3.1 is
what reaches the store, so there is exactly one 0.3.x anyone can install.

### Fixed — Adding a site now works without a reload

Adding the current site from the popup activated nothing until you reloaded the
page, which would have destroyed whatever prompt you were part-way through
typing. The shield now switches on in place, on the open tab, with your draft
intact.

### Fixed — Nothing is injected into sites you did not opt into

The shield's styles and host element were being injected into every page you
visited, even ones not on your allowlist. Nothing was read there, but any page
could detect that you run Sether Shield by probing for the element. Off your
allowlist, the extension now leaves no trace in the page at all.

### Fixed — Packaging

The release zip is now derived from the manifest instead of a hand-written file
list, which had already gone stale and omitted the translation files.

## 0.3.0 — 2026-07-16 (unreleased)

Seven languages, secret detection, custom rules, and a per-site allowlist.
Still 100% local, still zero network calls — now enforced by CSP, not just by
policy.

### Added — Seven languages

Full UI translation for English, Spanish, French, German, Portuguese, Arabic and
Simplified Chinese. The extension name and description localise in the Chrome
store listing too. `_locales/` is the single source of truth; `src/locales.ts` is
generated from it at build time and the build fails on key drift.

### Added — Credential and secret detection

Catches infrastructure secrets people paste into prompts when asking for help:
database connection strings with embedded passwords (`mongodb+srv://user:pass@…`),
credential-shaped env var assignments (`SECRET_KEY=`, `DB_PASSWORD=`), generic
password fields in code snippets, and PEM-encoded private keys.

### Added — Custom rules

Bring your own regex. Rules are validated against a backtracking check before
they go live, and ship with a pre-seeded built-in set you can disable but not
delete.

### Added — Per-site allowlist

The shield is opt-IN per origin. It ships enabled on 12 major AI chat platforms
and activates nowhere else unless you add the site yourself. On any origin not on
your list the content script exits before registering a single input listener.

### Added — Keyboard shortcut and toolbar badge

`Alt+Shift+S` triggers a scan on demand. The toolbar badge shows the live count
of detected items for the current tab.

### Changed — Permissions

Adds `activeTab` and host permissions for all sites. The host permissions exist
solely so the allowlist can cover sites you add yourself; access is gated at
runtime by that allowlist. Detection remains entirely local — a new
`content_security_policy` with `connect-src 'none'` makes the extension pages
structurally incapable of a network call.

## 0.2.0 — 2026-06-12

Reversibility plus smarter, more natural detection. Still 100% local, still only
the `storage` permission, still zero network calls.

### Added — Undo a scrub (reversibility)

Scrubbing is no longer a one-way street. After you scrub a prompt, the shield
shows a **"Restore original"** button that puts the real values back in one tap.

The originals are held **only in this tab's memory** so undo can work. They are
never written to `chrome.storage`, never saved to disk, and are cleared the
moment you reload the page, navigate away, or hit Undo. A privacy tool should
never persist the very data it hides, and this one doesn't.

### Added — natural-language name & address detection

On top of the label-anchored detection (`Name:`, `Address:`) the shield now
catches PII written the way people actually type into a chat:

- Names after conversational anchors (`my name is …`, `I'm called …`, `I go by …`).
- Addresses after phrasing like `I live at …` / `my address is …`, captured only
  when they look address-shaped (contain a number) to keep false positives low.

Free-text names in arbitrary prose (`I met Maria near the office`) still need a
model and remain out of scope for the local extension by design.

### Build & test

- 18 detector checks pass (added: scrub→restore round-trip, conversational address).
- New CI workflow builds, type-checks, tests, and **fails if any network call
  ever enters the shipped bundle** so the "100% local" promise can't regress.

## 0.1.0 — initial release

First Chrome Web Store release. Local PII detection on ChatGPT, Claude, and
Gemini; one-click scrub to placeholders; non-blocking nudge on send. Detection
runs the real `@raeven-co/sether` packs via the browser-safe entry.
