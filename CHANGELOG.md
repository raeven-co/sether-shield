# Changelog

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
