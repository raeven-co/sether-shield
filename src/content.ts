// Sether Shield — content script.
//
// Honest architecture (the Grammarly pattern): we operate on the page's input
// box, NOT the network. We read what you're typing, detect PII locally, and let
// you scrub it before you hit send. We do not intercept the request packet
// (Manifest V3 cannot read request bodies) and we make no network calls.
//
// Everything is additive and wrapped so we never break the host site: if a
// selector misses, the shield simply stays idle.

import { detect, scrub, labelFor, type Match } from './detector.js';

interface Stats {
  promptsScrubbed: number;
  piiCaught: number;
}

const EDITOR_SELECTORS = [
  '#prompt-textarea',
  'div.ProseMirror[contenteditable="true"]',
  'div[contenteditable="true"][translate="no"]',
  'rich-textarea .ql-editor',
  'textarea[data-id]',
  'div[contenteditable="true"]',
  'textarea',
];

let enabled = true;
let matches: Match[] = [];
let ui: ShieldUI;

function boot(): void {
  ui = new ShieldUI();
  try {
    chrome.storage?.local.get('settings', (v) => {
      enabled = v?.settings?.enabled ?? true;
      ui.setEnabled(enabled);
      refresh();
    });
    chrome.storage?.onChanged.addListener((changes) => {
      if (changes.settings) {
        enabled = changes.settings.newValue?.enabled ?? true;
        ui.setEnabled(enabled);
        refresh();
      }
    });
  } catch {
    /* storage unavailable — run with defaults */
  }

  document.addEventListener('input', debounce(refresh, 250), true);
  document.addEventListener('focusin', debounce(refresh, 100), true);
  document.addEventListener('keydown', onKeydown, true);
}

function activeEditor(): HTMLElement | null {
  const a = document.activeElement as HTMLElement | null;
  if (a && isEditor(a)) return a;
  for (const sel of EDITOR_SELECTORS) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el && isVisible(el)) return el;
  }
  return null;
}

function isEditor(el: HTMLElement): boolean {
  return el instanceof HTMLTextAreaElement || el.getAttribute('contenteditable') === 'true';
}

function isVisible(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function getText(el: HTMLElement): string {
  return el instanceof HTMLTextAreaElement ? el.value : (el.innerText ?? el.textContent ?? '');
}

function setText(el: HTMLElement, text: string): boolean {
  try {
    if (el instanceof HTMLTextAreaElement) {
      el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    el.focus();
    const sel = window.getSelection();
    if (sel) {
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    const ok = document.execCommand('insertText', false, text);
    if (!ok) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
    return true;
  } catch {
    return false;
  }
}

function refresh(): void {
  try {
    if (!enabled) {
      matches = [];
      ui.render(null, []);
      return;
    }
    const el = activeEditor();
    const text = el ? getText(el) : '';
    matches = text.trim() ? detect(text) : [];
    ui.render(el, matches);
  } catch {
    /* never throw into the host page */
  }
}

function onKeydown(e: KeyboardEvent): void {
  // Non-blocking warning only — we never preventDefault, so we can't break a send.
  if (!enabled || e.key !== 'Enter' || e.shiftKey) return;
  const el = e.target as HTMLElement | null;
  if (!el || !isEditor(el)) return;
  if (matches.length > 0) ui.toast(matches.length);
}

function doScrub(): void {
  const el = activeEditor();
  if (!el) return;
  const result = scrub(getText(el));
  if (result.count === 0) return;
  if (setText(el, result.text)) {
    bumpStats(result.count);
    setTimeout(refresh, 50);
  }
}

function bumpStats(piiCaught: number): void {
  try {
    chrome.storage?.local.get('stats', (v) => {
      const s: Stats = v?.stats ?? { promptsScrubbed: 0, piiCaught: 0 };
      chrome.storage.local.set({
        stats: { promptsScrubbed: s.promptsScrubbed + 1, piiCaught: s.piiCaught + piiCaught },
      });
    });
  } catch {
    /* ignore */
  }
}

function debounce<T extends (...a: never[]) => void>(fn: T, ms: number): (...a: Parameters<T>) => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a: Parameters<T>) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

// ── UI (isolated in a shadow root so host CSS can't touch it) ─────────────────

class ShieldUI {
  #root: ShadowRoot;
  #pill: HTMLButtonElement;
  #count: HTMLSpanElement;
  #panel: HTMLDivElement;
  #toastEl: HTMLDivElement;
  #open = false;
  #enabled = true;

  constructor() {
    const host = document.createElement('div');
    host.id = 'sether-shield-host';
    host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647;';
    document.body.appendChild(host);
    this.#root = host.attachShadow({ mode: 'open' });
    this.#root.innerHTML = `
      <style>${CSS}</style>
      <div class="wrap">
        <div class="toast" part="toast"></div>
        <div class="panel" role="dialog" aria-label="Sether Shield"></div>
        <button class="pill" type="button" aria-label="Sether Shield">
          <span class="mark">${SHIELD_SVG}</span>
          <span class="count" hidden>0</span>
        </button>
      </div>`;
    this.#pill = this.#root.querySelector('.pill')!;
    this.#count = this.#root.querySelector('.count')!;
    this.#panel = this.#root.querySelector('.panel')!;
    this.#toastEl = this.#root.querySelector('.toast')!;
    this.#pill.addEventListener('click', () => this.#toggle());
  }

  setEnabled(v: boolean): void {
    this.#enabled = v;
    this.#pill.classList.toggle('off', !v);
  }

  render(_el: HTMLElement | null, found: Match[]): void {
    const n = found.length;
    this.#count.textContent = String(n);
    this.#count.hidden = n === 0;
    this.#pill.classList.toggle('alert', this.#enabled && n > 0);
    if (this.#open) this.#renderPanel(found);
  }

  #toggle(): void {
    this.#open = !this.#open;
    this.#panel.classList.toggle('show', this.#open);
    if (this.#open) this.#renderPanel(matches);
  }

  #renderPanel(found: Match[]): void {
    const byType = new Map<string, number>();
    for (const m of found) byType.set(labelFor(m.type), (byType.get(labelFor(m.type)) ?? 0) + 1);
    const rows = [...byType.entries()]
      .map(([label, c]) => `<li><span class="dot"></span>${label}<span class="n">×${c}</span></li>`)
      .join('');

    if (!this.#enabled) {
      this.#panel.innerHTML = `<div class="hd">Sether Shield</div><p class="muted">Paused. Turn it back on from the toolbar icon.</p>${FOOTER}`;
      return;
    }
    this.#panel.innerHTML = found.length
      ? `<div class="hd">${found.length} item${found.length === 1 ? '' : 's'} to scrub</div>
         <ul class="list">${rows}</ul>
         <button class="scrub" type="button">Scrub this prompt</button>${FOOTER}`
      : `<div class="hd">Nothing sensitive detected</div>
         <p class="muted">Keep typing — I'll flag emails, phone numbers, cards, secrets and more before you send.</p>${FOOTER}`;
    const btn = this.#panel.querySelector<HTMLButtonElement>('.scrub');
    btn?.addEventListener('click', () => {
      doScrub();
      this.#open = false;
      this.#panel.classList.remove('show');
    });
  }

  toast(n: number): void {
    this.#toastEl.textContent = `Heads up — your prompt still had ${n} sensitive item${n === 1 ? '' : 's'}.`;
    this.#toastEl.classList.add('show');
    setTimeout(() => this.#toastEl.classList.remove('show'), 3200);
  }
}

const SHIELD_SVG =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>';

const FOOTER =
  '<div class="ft"><span class="lock">●</span> 100% local — nothing leaves your browser. <a href="https://setherai.vercel.app" target="_blank" rel="noopener">sether</a></div>';

const CSS = `
  :host, * { box-sizing: border-box; }
  .wrap { position: fixed; right: 16px; bottom: 96px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; }
  .pill { display: inline-flex; align-items: center; gap: 6px; height: 36px; padding: 0 12px; border: none; border-radius: 999px; background: #4f46e5; color: #fff; cursor: pointer; box-shadow: 0 6px 20px -6px rgba(79,70,229,.6); transition: background .15s, transform .15s; }
  .pill:hover { transform: translateY(-1px); }
  .pill.alert { background: #eb7a09; box-shadow: 0 6px 20px -6px rgba(235,122,9,.65); }
  .pill.off { background: #71717a; box-shadow: none; opacity: .8; }
  .mark { display: inline-flex; }
  .count { font: 600 12px/1 ui-monospace, monospace; background: rgba(255,255,255,.22); padding: 2px 6px; border-radius: 999px; }
  .panel { position: absolute; right: 0; bottom: 46px; width: 260px; background: #fff; color: #18181b; border: 1px solid #e4e4e7; border-radius: 14px; box-shadow: 0 16px 40px -12px rgba(0,0,0,.28); padding: 14px; opacity: 0; transform: translateY(6px); pointer-events: none; transition: opacity .15s, transform .15s; }
  .panel.show { opacity: 1; transform: translateY(0); pointer-events: auto; }
  .hd { font-weight: 700; font-size: 14px; margin-bottom: 8px; }
  .muted { color: #71717a; font-size: 13px; line-height: 1.45; margin: 0; }
  .list { list-style: none; margin: 0 0 12px; padding: 0; max-height: 180px; overflow: auto; }
  .list li { display: flex; align-items: center; gap: 8px; font-size: 13px; padding: 5px 0; border-bottom: 1px solid #f4f4f5; }
  .list .dot { width: 7px; height: 7px; border-radius: 999px; background: #eb7a09; }
  .list .n { margin-left: auto; font: 600 11px/1 ui-monospace, monospace; color: #a1a1aa; }
  .scrub { width: 100%; height: 34px; border: none; border-radius: 9px; background: #4f46e5; color: #fff; font-weight: 600; font-size: 13px; cursor: pointer; }
  .scrub:hover { background: #4338ca; }
  .ft { margin-top: 10px; font-size: 11px; color: #a1a1aa; line-height: 1.4; }
  .ft .lock { color: #22c55e; }
  .ft a { color: #4f46e5; text-decoration: none; }
  .toast { position: absolute; right: 0; bottom: 46px; max-width: 280px; background: #18181b; color: #fff; font-size: 13px; line-height: 1.4; padding: 10px 12px; border-radius: 10px; box-shadow: 0 12px 30px -10px rgba(0,0,0,.4); opacity: 0; transform: translateY(6px); pointer-events: none; transition: opacity .2s, transform .2s; }
  .toast.show { opacity: 1; transform: translateY(0); }
`;

// Bootstrap LAST. Class and const declarations above are not hoisted (temporal
// dead zone), so boot() must run only after ShieldUI/CSS/etc. are initialized —
// running it at the top hit `new ShieldUI()` before the class existed.
if (window.top === window && !(window as unknown as { __setherShield?: boolean }).__setherShield) {
  (window as unknown as { __setherShield?: boolean }).__setherShield = true;
  boot();
}
