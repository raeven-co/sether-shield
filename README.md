# Sether Shield

> Catches personal data in your prompt **before** it reaches ChatGPT, Claude, or
> Gemini. 100% local, nothing leaves your browser.

The consumer/zero-code front door to [Sether](https://setherai.vercel.app). The
npm library and the hosted gateway protect *your app's* traffic; Sether Shield
protects *you* when you paste into a public AI tool. It's the growth funnel: a
viral, useful, honest demo of the core idea that drives B2B inbound.

## How it works (the honest architecture)

This is the **Grammarly pattern**, not a network proxy:

- A content script watches the prompt box on the supported sites.
- It detects PII **locally** (emails, phones — national formats included via
  multi-region libphonenumber — names, cards w/ Luhn, SSNs, IBANs, IPs,
  addresses, dates of birth, passwords, and API keys — OpenAI / AWS / GitHub /
  Slack / Stripe / prose-labelled) as you type.
- A floating shield shows a live count; one click **scrubs** the PII — either
  into masks (`e***@g***.com`) or, in **Decoy mode** (0.4.0), into realistic
  fakes: names become John Doe-style names, phones become officially-fictional
  numbers, emails move to example.com. The 🎭 button on each detection offers
  suggestion chips so you pick the decoy you like; the same value always gets
  the same decoy within a session.
- Changed your mind? **Restore originals** puts the real values back in one
  tap — even after you've edited around them. The vault mapping decoys to real
  values stays in this tab's memory only, never on disk.
- When the AI **echoes your decoy back** in its reply, the Response Guard
  offers **Copy reply with real values** — your clipboard gets the restored
  text; the page itself never sees it.
- A non-blocking nudge appears if you hit send with PII still present.

**What it deliberately does NOT do:**

- It does **not** intercept the network request. Manifest V3 cannot read request
  bodies, and anything that monkey-patches the page's `fetch` silently breaks or
  leaks when the site changes. We operate on the input box instead — robust and honest.
- It makes **zero network calls** and ships **no telemetry**. The only permission
  is `storage` (for your on/off setting + local stats). All detection is in-page.
- It does **not** rewrite the AI's reply. Restoring tokens inside the model's
  response is the library/gateway's job (that's where the durable vault lives).
  In the extension you choose what to scrub, and you can **undo a scrub locally**
  before you send. The undo buffer is in-memory only and cleared on reload.

## Install (developer / unpacked)

```bash
npm install
npm run build          # bundles src → dist/ with esbuild
```

Then in Chrome/Edge: `chrome://extensions` → enable **Developer mode** →
**Load unpacked** → select this folder. Open ChatGPT/Claude/Gemini and type an
email — the shield turns orange.

## Layout

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest — `storage` permission, content script on the 3 sites |
| `src/detector.ts` | Detection via the real `@raeven-co/sether/browser` packs (single source of truth) + conversational name/address heuristics; `scrub` / `restore` |
| `src/content.ts` | Watches the input, shadow-DOM shield UI, scrub + undo + warn |
| `src/popup.{html,ts}` | On/off toggle + session stats |
| `build.mjs` | esbuild bundler |

## Roadmap

- [x] Undo a scrub in the input box (local, ephemeral) — shipped in 0.2.0
- [ ] Best-effort token **restore** in the reply pane (experimental; opt-in)
- [ ] "Scrub on send" strict mode (block + confirm) as an option
- [ ] Brand icons (export from the Sether bird SVG to 16/48/128 PNG)
- [ ] Firefox build (MV3 parity)
- [ ] Org policy mode (managed deployment) → the enterprise upsell into the gateway

## Privacy

No accounts. No servers. No tracking. The detector runs entirely in your browser;
your prompts are never sent anywhere by this extension. Audit `src/` — it's small.
