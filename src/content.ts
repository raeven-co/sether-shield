// Sether Shield — content script.
//
// Universal PII protection — works on any editable field on any site
// (the Grammarly pattern). Detects sensitive data as you type or paste,
// shows the shield pill + panel, and offers inline redaction.
//
// Key capabilities added in v0.3:
//  • Universal field detection — <all_urls> injection, generic selectors
//  • Paste tracking (F1) — distinguishes paste-sourced vs typed content
//  • AI Response Guard (F3) — scans AI replies for echoed pasted PII
//  • Shield Score events (F4) — fires exposure events on paste/scrub

import { detect, labelFor, maskValue, applyCustomRules, type Match } from './detector.js';
import {
  isSiteEnabled,
  bumpStats,
  addRedactionRecord,
  loadTranslations,
  translate,
  getCustomRules,
} from './storage.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Universal editor selectors, ordered generic-first.
 * Generic selectors are first so they match any site; AI-specific IDs are
 * checked last as high-priority hints on supported platforms.
 */
const EDITOR_SELECTORS = [
  'textarea:not([type="hidden"]):not([readonly])',
  'input[type="text"]:not([readonly]):not([type="hidden"])',
  'input[type="search"]:not([readonly])',
  '[contenteditable="true"]',
  '[contenteditable=""]',
  // AI-platform-specific (checked after generic for priority)
  '#prompt-textarea',
  'div.ProseMirror[contenteditable="true"]',
  'div[contenteditable="true"][translate="no"]',
  'rich-textarea .ql-editor',
  'textarea[data-id]',
];

/**
 * Selectors for AI chat response containers — used by F3 (Response Guard).
 * Only relevant on supported chat UIs; detection runs separately on these.
 */
const AI_RESPONSE_SELECTORS = [
  // ChatGPT
  'div[data-message-author-role="assistant"]',
  '.markdown.prose',
  // Claude
  '[data-is-streaming="false"] .font-claude-message',
  // Gemini
  'model-response .response-content',
  '.model-response-text',
];

// ── i18n fallback dictionary ───────────────────────────────────────────────────

const FALLBACK: Record<string, string> = {
  accept: 'Accept',
  reject: 'Reject',
  dismiss: 'Dismiss',
  localPrivacy: '100% local, nothing leaves your browser.',
  pausedMessage: 'Paused. Turn it back on from the toolbar icon.',
  nothingDetected: 'Nothing sensitive detected',
  keepTyping: "Keep typing, I'll flag emails, phone numbers, cards, secrets and more before you send.",
  scrubPrompt: 'Scrub all',
  headsUp: 'Heads up — your prompt still has $1 sensitive item(s).',
};

/** Get an i18n message, falling back to English hardcoded strings. */
function msg(key: string, ...subs: string[]): string {
  const result = translate(key, ...subs);
  if (result !== key) return result;
  
  let fallback = FALLBACK[key] ?? key;
  subs.forEach((s, i) => {
    fallback = fallback.replace(`$${i + 1}`, s);
  });
  return fallback;
}

// ── State ─────────────────────────────────────────────────────────────────────

let globalEnabled = true;
let siteEnabled = true;
let autoRedactEnabled = false;
let currentMatches: Match[] = [];

/** Session-scoped dismissed suggestions. Key = `type:value`. */
const dismissedKeys = new Set<string>();

/**
 * F1: Paste tracking.
 * Stores the text content of the most recent paste event per element.
 * Key = element (WeakMap so GC handles removed nodes).
 * Value = Set of pasted text fragments (trimmed) — cleared on page unload.
 */
const pasteFragments = new WeakMap<HTMLElement, Set<string>>();

/**
 * F3: AI Response Guard.
 * Session-scoped set of PII values that arrived via paste in this session.
 * Used to detect "echoed" PII in AI replies (paste-sourced → reflected back).
 */
const pastedPIIValues = new Set<string>();

/**
 * F3: Session-scoped dismissed response guard alerts.
 * Key = `type:value`. Reset on page reload.
 */
const responseGuardDismissed = new Set<string>();

// UI instances
let shieldUI: ShieldUI;

// Cleanup references for context invalidation
let onInputDebounced: ((...args: any[]) => void) | undefined;
let onInputRaw: ((...args: any[]) => void) | undefined;
let onFocusInDebounced: ((...args: any[]) => void) | undefined;
let onPasteHandler: ((e: ClipboardEvent) => void) | undefined;
let scanIntervalId: ReturnType<typeof setInterval> | undefined;
let autoRedactTimeoutId: ReturnType<typeof setTimeout> | undefined;
let responseGuardObserver: MutationObserver | undefined;

// ── Utility Functions ─────────────────────────────────────────────────────────

function matchKey(m: Match): string {
  return `${m.type}:${m.value}`;
}

function isEditor(el: HTMLElement): boolean {
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) {
    const t = el.type;
    return t === 'text' || t === 'search' || t === '' || !t;
  }
  const ce = el.getAttribute('contenteditable');
  return ce === 'true' || ce === '';
}

function isVisible(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function isInsideShield(el: Element | null): boolean {
  while (el) {
    if (el.id === 'sether-shield-host') return true;
    el = el.parentElement;
  }
  return false;
}

interface DOMPosition {
  node: Node;
  offset: number;
}

function getDOMTextAndMap(el: HTMLElement): { text: string; map: DOMPosition[] } {
  let text = '';
  const map: DOMPosition[] = [];

  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const val = node.nodeValue || '';
      for (let i = 0; i < val.length; i++) {
        map.push({ node, offset: i });
      }
      text += val;
    } else if (node.nodeName === 'BR') {
      map.push({ node, offset: 0 });
      text += '\n';
    } else {
      let isBlock = false;
      if (node instanceof HTMLElement) {
        const name = node.nodeName;
        if (name === 'P' || name === 'DIV' || name === 'LI' || name === 'TR') {
          isBlock = true;
        } else {
          try {
            const style = window.getComputedStyle(node);
            isBlock = style.display === 'block' || style.display === 'flex';
          } catch {}
        }
      }

      const needsNewlineBefore = isBlock && text.length > 0 && !text.endsWith('\n');
      if (needsNewlineBefore) {
        text += '\n';
        map.push({ node, offset: 0 });
      }

      for (let i = 0; i < node.childNodes.length; i++) {
        const child = node.childNodes[i];
        if (child) walk(child);
      }

      const needsNewlineAfter = isBlock && text.length > 0 && !text.endsWith('\n');
      if (needsNewlineAfter) {
        text += '\n';
        map.push({ node, offset: 0 });
      }
    }
  };

  walk(el);
  return { text, map };
}

function getText(el: HTMLElement): string {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return el.value;
  return getDOMTextAndMap(el).text;
}

/** Set text on an editor element, compatible with React/Vue/Angular controlled inputs. */
function setText(el: HTMLElement, text: string): boolean {
  try {
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      const proto =
        el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      descriptor?.set?.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    // contenteditable — use execCommand for undo support
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

/** Replace a single match at a specific position. */
function replaceMatchInElement(el: HTMLElement, match: Match, replacement: string): boolean {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const text = el.value;
    const actual = text.slice(match.start, match.end);
    if (actual !== match.value) return false; // stale match
    const newText = text.slice(0, match.start) + replacement + text.slice(match.end);
    return setText(el, newText);
  }

  // contenteditable element:
  const { text, map } = getDOMTextAndMap(el);
  const actual = text.slice(match.start, match.end);
  if (actual !== match.value) return false; // stale match

  // Get the DOM start and end positions
  const startPos = map[match.start];
  const endPos = map[match.end - 1];
  if (!startPos || !endPos) return false;

  try {
    el.focus();
    const range = document.createRange();
    
    range.setStart(startPos.node, startPos.offset);
    
    if (endPos.node.nodeType === Node.TEXT_NODE) {
      range.setEnd(endPos.node, endPos.offset + 1);
    } else {
      range.setEndAfter(endPos.node);
    }

    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    }

    const ok = document.execCommand('insertHTML', false, `<u>${escapeHtml(replacement)}</u>`);
    if (!ok) {
      document.execCommand('insertText', false, replacement);
    }
    if (!ok) {
      const newText = text.slice(0, match.start) + replacement + text.slice(match.end);
      el.textContent = newText;
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
    return true;
  } catch (err) {
    console.error('[Sether] Failed to replace match in contenteditable:', err);
    return false;
  }
}

function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void,
  ms: number
): (...args: Args) => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...args: Args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Shadow DOM Traversal ──────────────────────────────────────────────────────

/** Find the active editor element, chasing through shadow roots. */
function activeEditor(): HTMLElement | null {
  // Chase activeElement through shadow roots
  let el: Element | null = document.activeElement;
  while (el?.shadowRoot?.activeElement) {
    el = el.shadowRoot.activeElement;
  }
  if (el instanceof HTMLElement && isEditor(el) && isVisible(el) && !isInsideShield(el)) {
    return el;
  }

  // Fallback: query selectors, including inside open shadow roots
  for (const sel of EDITOR_SELECTORS) {
    const found = querySelectorDeep<HTMLElement>(sel);
    if (found && isVisible(found) && !isInsideShield(found)) return found;
  }
  return null;
}

/** querySelector that traverses open shadow roots recursively. */
function querySelectorDeep<T extends Element>(selector: string): T | null {
  const result = document.querySelector<T>(selector);
  if (result) return result;

  const walk = (root: Document | ShadowRoot): T | null => {
    const els = root.querySelectorAll('*');
    for (const el of els) {
      if (el.shadowRoot) {
        const found = el.shadowRoot.querySelector<T>(selector);
        if (found) return found;
        const deep = walk(el.shadowRoot);
        if (deep) return deep;
      }
    }
    return null;
  };
  return walk(document);
}



// ── F1: Paste Tracking ────────────────────────────────────────────────────────

/**
 * Called on capture-phase 'paste' event.
 * Records the pasted text for the target element so that downstream detection
 * can tag matches with source='paste'.
 */
function onPaste(e: ClipboardEvent): void {
  if (!globalEnabled || !siteEnabled) return;

  const target = e.target as HTMLElement | null;
  if (!target || !isEditor(target) || isInsideShield(target)) return;

  const text = e.clipboardData?.getData('text/plain') ?? '';
  if (!text) return;

  // Record paste fragment
  if (!pasteFragments.has(target)) {
    pasteFragments.set(target, new Set());
  }
  pasteFragments.get(target)!.add(text.trim());

  // Detect PII in the pasted text right now for F3 and F4
  const pastedMatches = detect(text);
  for (const m of pastedMatches) {
    // F3: Track pasted PII values for response guard
    pastedPIIValues.add(m.value);
  }



  // Tag matches with source='paste' when refresh() runs after this event
  // by scheduling a refresh — the pasteFragments WeakMap will be checked there
  setTimeout(refresh, 50);
}

/** Check whether a match's value was part of a paste into the given element. */
function isPastedMatch(el: HTMLElement, m: Match): boolean {
  const frags = pasteFragments.get(el);
  if (!frags || frags.size === 0) return false;
  for (const frag of frags) {
    if (frag.includes(m.value)) return true;
  }
  return false;
}

// ── Global Event Handlers ─────────────────────────────────────────────────────

function onInput(): void {
  refresh();
  
  if (autoRedactEnabled && globalEnabled && siteEnabled) {
    autoRedactTimeoutId = setTimeout(() => {
      doScrub();
    }, 1750); // 250ms debounce + 1750ms = 2000ms after last keystroke
  }
}

function isFocusInShield(): boolean {
  let el: Element | null = document.activeElement;
  while (el) {
    if (el.id === 'sether-shield-host') return true;
    if (el.shadowRoot?.activeElement) {
      el = el.shadowRoot.activeElement;
    } else {
      break;
    }
  }
  return false;
}

function onFocusIn(): void {
  if (isFocusInShield()) return;
  refresh();
}

function isContextValid(): boolean {
  try {
    return !!(chrome.runtime && chrome.runtime.id);
  } catch {
    return false;
  }
}

function cleanupInvalidatedContext(): void {
  try {
    if (scanIntervalId) clearInterval(scanIntervalId);
    if (autoRedactTimeoutId) {
      clearTimeout(autoRedactTimeoutId);
      autoRedactTimeoutId = undefined;
    }
    if (onInputRaw) {
      document.removeEventListener('input', onInputRaw, true);
    } else if (onInputDebounced) {
      document.removeEventListener('input', onInputDebounced, true);
    }
    if (onFocusInDebounced) {
      document.removeEventListener('focusin', onFocusInDebounced, true);
    }
    if (onPasteHandler) {
      document.removeEventListener('paste', onPasteHandler, true);
    }
    document.removeEventListener('keydown', onKeydown, true);
    responseGuardObserver?.disconnect();

    const host = document.getElementById('sether-shield-host');
    if (host) host.remove();
  } catch {}
}

function refresh(): void {
  try {
    if (!isContextValid()) {
      cleanupInvalidatedContext();
      return;
    }
    if (!globalEnabled || !siteEnabled) {
      currentMatches = [];
      shieldUI.render(null, []);
      updateBadge(0);
      return;
    }
    const el = activeEditor();
    const text = el ? getText(el) : '';
    if (!text.trim()) {
      currentMatches = [];
      shieldUI.render(el, []);
      updateBadge(0);
      return;
    }

    const rawMatches = detect(text);

    // F1: Annotate each match with source='paste'/'typed'
    currentMatches = rawMatches.map((m) => ({
      ...m,
      source: el && isPastedMatch(el, m) ? 'paste' : 'typed',
    }));

    shieldUI.render(el, currentMatches);
    updateBadge(currentMatches.length);
  } catch {
    /* never throw into the host page */
  }
}

function onKeydown(e: KeyboardEvent): void {
  if (!globalEnabled || !siteEnabled || e.key !== 'Enter' || e.shiftKey) return;
  const el = e.target as HTMLElement | null;
  if (!el || !isEditor(el)) return;
  
  const activeMatches = currentMatches.filter((m) => !dismissedKeys.has(matchKey(m)));
  if (activeMatches.length > 0) {
    shieldUI.toast(activeMatches.length);
  }
}

function updateBadge(count: number): void {
  try {
    if (!isContextValid()) return;
    chrome.runtime?.sendMessage({ action: 'updateBadge', count });
  } catch { /* ignore — service worker may be asleep */ }
}

/** Scrub ALL non-dismissed PII from the active editor at once. */
function doScrub(): void {
  if (autoRedactTimeoutId) {
    clearTimeout(autoRedactTimeoutId);
    autoRedactTimeoutId = undefined;
  }
  const el = activeEditor();
  if (!el) return;

  const text = getText(el);
  const matches = detect(text);
  const activeMatches = matches.filter((m) => !dismissedKeys.has(matchKey(m)));
  if (activeMatches.length === 0) return;

  // Replace active matches from right to left to avoid index shifting
  const reversed = [...activeMatches].sort((a, b) => b.start - a.start);

  let successCount = 0;
  for (const m of reversed) {
    const replacement = maskValue(m.value, m.type);
    if (replaceMatchInElement(el, m, replacement)) {
      const source: 'paste' | 'typed' = isPastedMatch(el, m) ? 'paste' : 'typed';
      addRedactionRecord({
        pageUrl: location.origin + location.pathname,
        category: labelFor(m.type),
        redactedValue: replacement,
        timestamp: Date.now(),
        source,
      }).catch(() => {});
      successCount++;
    }
  }

  if (successCount > 0) {
    bumpStats(successCount).catch(() => {});
    setTimeout(refresh, 50);
  }
}

function matchesEqual(a: Match[], b: Match[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ma = a[i]!;
    const mb = b[i]!;
    if (
      ma.type !== mb.type ||
      ma.value !== mb.value ||
      ma.start !== mb.start ||
      ma.end !== mb.end
    ) {
      return false;
    }
  }
  return true;
}

// ── F3: AI Response Guard ─────────────────────────────────────────────────────

/**
 * Checks whether a detected PII value in an AI reply was "echoed" from
 * the user's pasted content this session.
 *
 * Definition: echoed = the value appears verbatim in pastedPIIValues.
 * This deliberately does NOT use fuzzy/similarity matching to avoid false
 * positives — only exact-string matches qualify as "echoed".
 */
function isEchoed(value: string): boolean {
  return pastedPIIValues.has(value);
}

/** Show an in-panel response guard prompt when echoed PII is found. */
function showResponseGuardPrompt(matches: Match[], responseEl: HTMLElement): void {
  const echoed = matches.filter(
    (m) => !responseGuardDismissed.has(matchKey(m)) && isEchoed(m.value)
  );
  const detected = matches.filter(
    (m) => !responseGuardDismissed.has(matchKey(m)) && !isEchoed(m.value)
  );

  if (echoed.length === 0 && detected.length === 0) return;

  shieldUI.showResponseGuard(echoed, detected, responseEl);
}

/**
 * Start observing AI response nodes for new content.
 * Called once during boot — only attaches on supported AI chat UIs.
 */
function initResponseGuard(): void {
  if (responseGuardObserver) return;

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  responseGuardObserver = new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (!globalEnabled || !siteEnabled) return;
      if (pastedPIIValues.size === 0) return; // nothing pasted — skip entirely

      for (const sel of AI_RESPONSE_SELECTORS) {
        const nodes = document.querySelectorAll<HTMLElement>(sel);
        nodes.forEach((node) => {
          const text = node.textContent ?? '';
          if (!text.trim()) return;
          const matches = detect(text);
          if (matches.length > 0) {
            showResponseGuardPrompt(matches, node);
          }
        });
      }
    }, 800); // wait for streaming to settle
  });

  responseGuardObserver.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}

// ── Shield UI (global floating pill + panel) ──────────────────────────────────

class ShieldUI {
  #root: ShadowRoot;
  #pill: HTMLButtonElement;
  #count: HTMLSpanElement;
  #panel: HTMLDivElement;
  #toastEl: HTMLDivElement;
  #host: HTMLDivElement;
  #open = false;
  #enabled = true;
  #activeEl: HTMLElement | null = null;
  #lastRenderedMatches: Match[] = [];

  constructor() {
    this.#host = document.createElement('div');
    this.#host.id = 'sether-shield-host';
    this.#host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; cursor: pointer;';
    
    // Load saved position
    try {
      chrome.storage?.local.get('shieldPosition', (r) => {
        const pos = r?.shieldPosition;
        if (pos && typeof pos.top === 'number') {
          this.#host.style.top = `${pos.top}px`;
          this.#host.style.bottom = 'auto';
          
          if (pos.side === 'left') {
            this.#host.style.right = 'auto';
            this.#host.style.left = '8px';
          } else if (pos.side === 'right') {
            this.#host.style.left = 'auto';
            this.#host.style.right = '8px';
          } else if (typeof pos.left === 'number') {
            const isLeft = pos.left < window.innerWidth / 2;
            if (isLeft) {
              this.#host.style.right = 'auto';
              this.#host.style.left = '8px';
            } else {
              this.#host.style.left = 'auto';
              this.#host.style.right = '8px';
            }
          }
        } else {
          this.#host.style.left = 'auto';
          this.#host.style.right = '8px';
          this.#host.style.bottom = '96px';
        }
      });
    } catch {
      this.#host.style.left = 'auto';
      this.#host.style.right = '8px';
      this.#host.style.bottom = '96px';
    }

    document.body.appendChild(this.#host);
    this.#root = this.#host.attachShadow({ mode: 'open' });
    this.#root.innerHTML = `
      <style>${SHIELD_CSS}</style>
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

    // Drag handlers
    let isDragging = false;
    let dragged = false;
    let startX = 0;
    let startY = 0;
    let initialLeft = 0;
    let initialTop = 0;

    this.#pill.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      isDragging = true;
      dragged = false;
      startX = e.clientX;
      startY = e.clientY;
      
      const rect = this.#host.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;
      
      this.#host.style.cursor = 'grabbing';
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) dragged = true;
      
      let newLeft = initialLeft + dx;
      let newTop = initialTop + dy;
      
      const rect = this.#host.getBoundingClientRect();
      const maxLeft = window.innerWidth - rect.width - 8;
      const maxTop = window.innerHeight - rect.height - 8;
      
      newLeft = Math.max(8, Math.min(newLeft, maxLeft));
      newTop = Math.max(8, Math.min(newTop, maxTop));
      
      this.#host.style.right = 'auto';
      this.#host.style.bottom = 'auto';
      this.#host.style.left = `${newLeft}px`;
      this.#host.style.top = `${newTop}px`;
    });

    window.addEventListener('mouseup', () => {
      if (!isDragging) return;
      isDragging = false;
      this.#host.style.cursor = 'pointer';
      
      if (dragged) {
        const rect = this.#host.getBoundingClientRect();
        const isLeft = (rect.left + rect.width / 2 < window.innerWidth / 2);
        
        this.#host.style.bottom = 'auto';
        if (isLeft) {
          this.#host.style.right = 'auto';
          this.#host.style.left = '8px';
        } else {
          this.#host.style.left = 'auto';
          this.#host.style.right = '8px';
        }
        
        chrome.storage?.local.set({
          shieldPosition: { side: isLeft ? 'left' : 'right', top: rect.top }
        });
      } else {
        this.#toggle();
      }
    });

    // Close panel when clicking outside the widget
    document.addEventListener('click', (e) => {
      if (!this.#open) return;
      const path = e.composedPath();
      if (!path.includes(this.#host)) {
        this.#close();
      }
    }, true);
  }

  setEnabled(v: boolean): void {
    this.#enabled = v;
    this.#pill.classList.toggle('off', !v);
  }

  hide(): void { this.#host.style.display = 'none'; }
  show(): void { this.#host.style.display = ''; }

  openPanel(): void {
    if (!this.#open) this.#toggle();
  }

  render(el: HTMLElement | null, found: Match[]): void {
    this.#host.style.display = '';
    this.#activeEl = el;
    
    const activeMatches = found.filter((m) => !dismissedKeys.has(matchKey(m)));
    const n = activeMatches.length;
    
    this.#count.textContent = String(n);
    this.#count.hidden = n === 0;
    this.#pill.classList.toggle('alert', this.#enabled && n > 0);
    
    if (this.#open) {
      if (!matchesEqual(this.#lastRenderedMatches, activeMatches)) {
        this.#renderPanel(found);
        this.#lastRenderedMatches = activeMatches;
      }
    } else {
      this.#lastRenderedMatches = [];
    }
  }

  #toggle(): void {
    this.#open = !this.#open;
    this.#panel.classList.toggle('show', this.#open);
    
    if (this.#open) {
      const rect = this.#host.getBoundingClientRect();
      const isLeftHalf = rect.left < window.innerWidth / 2;
      const isTopHalf = rect.top < window.innerHeight / 2;
      
      this.#panel.classList.toggle('align-left', isLeftHalf);
      this.#panel.classList.toggle('align-right', !isLeftHalf);
      this.#panel.classList.toggle('align-bottom', isTopHalf);
      this.#panel.classList.toggle('align-top', !isTopHalf);
      
      const activeMatches = currentMatches.filter((m) => !dismissedKeys.has(matchKey(m)));
      this.#renderPanel(currentMatches);
      this.#lastRenderedMatches = activeMatches;
    } else {
      this.#lastRenderedMatches = [];
    }
  }

  #close(): void {
    if (this.#open) {
      this.#open = false;
      this.#panel.classList.remove('show');
      this.#lastRenderedMatches = [];
    }
  }

  #renderPanel(found: Match[]): void {
    const activeMatches = found.filter((m) => !dismissedKeys.has(matchKey(m)));

    const listEl = this.#panel.querySelector('.list');
    const scrollTop = listEl ? listEl.scrollTop : 0;

    let rowsHtml = '';
    activeMatches.forEach((m, idx) => {
      const category = labelFor(m.type);
      const masked = maskValue(m.value, m.type);
      const sourceBadge = m.source === 'paste'
        ? `<span class="src-badge paste">📋 pasted</span>`
        : '';
      rowsHtml += `
        <li class="match-row">
          <div class="match-info">
            <div class="match-meta">
              <span class="match-dot"></span>
              <span class="match-cat">${escapeHtml(category)}</span>
              ${sourceBadge}
            </div>
            <div class="match-preview">
              <span class="match-orig">${escapeHtml(m.value)}</span>
              <span class="match-arrow">→</span>
              <span class="match-masked">${escapeHtml(masked)}</span>
            </div>
          </div>
          <div class="match-actions">
            <button class="match-accept" data-idx="${idx}" title="Accept suggestion">✓</button>
            <button class="match-dismiss" data-idx="${idx}" title="Dismiss suggestion">×</button>
          </div>
        </li>
      `;
    });

    if (!this.#enabled) {
      this.#panel.innerHTML = `<div class="hd">Sether Shield</div><p class="muted">${escapeHtml(msg('pausedMessage'))}</p>${getFooter()}`;
      return;
    }

    this.#panel.innerHTML = activeMatches.length
      ? `<div class="hd">${activeMatches.length} item${activeMatches.length === 1 ? '' : 's'} to scrub</div>
         <ul class="list">${rowsHtml}</ul>
         <button class="scrub" type="button">${escapeHtml(msg('scrubPrompt'))}</button>${getFooter()}`
      : `<div class="hd">${escapeHtml(msg('nothingDetected'))}</div>
         <p class="muted">${escapeHtml(msg('keepTyping'))}</p>${getFooter()}`;

    const newListEl = this.#panel.querySelector('.list');
    if (newListEl) newListEl.scrollTop = scrollTop;

    // Action listeners
    if (activeMatches.length) {
      this.#panel.querySelectorAll<HTMLButtonElement>('.match-accept').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const idx = parseInt(btn.getAttribute('data-idx') || '0', 10);
          const match = activeMatches[idx];
          if (match) this.#accept(match);
        });
      });

      this.#panel.querySelectorAll<HTMLButtonElement>('.match-dismiss').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const idx = parseInt(btn.getAttribute('data-idx') || '0', 10);
          const match = activeMatches[idx];
          if (match) this.#dismiss(match);
        });
      });
    }

    const scrubBtn = this.#panel.querySelector<HTMLButtonElement>('.scrub');
    scrubBtn?.addEventListener('click', () => doScrub());
  }


  /** F3: Show an in-panel response guard prompt. */
  showResponseGuard(echoed: Match[], detected: Match[], _responseEl: HTMLElement): void {
    if (!this.#open) this.#toggle();

    let rowsHtml = '';

    if (echoed.length > 0) {
      rowsHtml += `<p class="rg-label rg-echo">⚠️ Echoed from your input (${echoed.length}):</p>`;
      echoed.forEach((m, idx) => {
        const masked = maskValue(m.value, m.type);
        rowsHtml += `
          <li class="match-row">
            <div class="match-info">
              <div class="match-meta">
                <span class="match-dot rg-dot"></span>
                <span class="match-cat">${escapeHtml(labelFor(m.type))}</span>
              </div>
              <div class="match-preview">
                <span class="match-orig">${escapeHtml(m.value)}</span>
                <span class="match-arrow">→</span>
                <span class="match-masked">${escapeHtml(masked)}</span>
              </div>
            </div>
            <div class="match-actions">
              <button class="rg-mask" data-idx="${idx}" data-kind="echo" title="Mask in reply">🛡</button>
              <button class="rg-skip" data-idx="${idx}" data-kind="echo" title="Dismiss">×</button>
            </div>
          </li>`;
      });
    }

    if (detected.length > 0) {
      rowsHtml += `<p class="rg-label">Detected in reply (${detected.length}):</p>`;
      detected.forEach((m, idx) => {
        const masked = maskValue(m.value, m.type);
        rowsHtml += `
          <li class="match-row">
            <div class="match-info">
              <div class="match-meta">
                <span class="match-dot"></span>
                <span class="match-cat">${escapeHtml(labelFor(m.type))}</span>
              </div>
              <div class="match-preview">
                <span class="match-orig">${escapeHtml(m.value)}</span>
                <span class="match-arrow">→</span>
                <span class="match-masked">${escapeHtml(masked)}</span>
              </div>
            </div>
            <div class="match-actions">
              <button class="rg-skip" data-idx="${idx}" data-kind="detected" title="Dismiss">×</button>
            </div>
          </li>`;
      });
    }

    this.#panel.innerHTML = `
      <div class="hd rg-hd">🛡 AI Response Guard</div>
      <p class="muted">PII found in the AI reply. Review before copying.</p>
      <ul class="list">${rowsHtml}</ul>
      ${getFooter()}`;

    // Mask button handlers
    this.#panel.querySelectorAll<HTMLButtonElement>('.rg-mask').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.getAttribute('data-idx') || '0', 10);
        const m = echoed[idx];
        if (!m) return;
        responseGuardDismissed.add(matchKey(m));
        refresh();
      });
    });

    // Dismiss button handlers
    this.#panel.querySelectorAll<HTMLButtonElement>('.rg-skip').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.getAttribute('data-idx') || '0', 10);
        const kind = btn.getAttribute('data-kind');
        const m = kind === 'echo' ? echoed[idx] : detected[idx];
        if (!m) return;
        responseGuardDismissed.add(matchKey(m));
        refresh();
      });
    });
  }

  #accept(m: Match): void {
    if (!this.#activeEl) return;
    const replacement = maskValue(m.value, m.type);

    if (replaceMatchInElement(this.#activeEl, m, replacement)) {
      addRedactionRecord({
        pageUrl: location.origin + location.pathname,
        category: labelFor(m.type),
        redactedValue: replacement,
        timestamp: Date.now(),
        source: m.source,
      }).catch(() => {});
      bumpStats(1).catch(() => {});
      refresh();
    }
  }

  #dismiss(m: Match): void {
    dismissedKeys.add(matchKey(m));
    refresh();
  }

  toast(n: number): void {
    this.#toastEl.textContent = msg('headsUp', String(n));
    this.#toastEl.classList.add('show');
    setTimeout(() => this.#toastEl.classList.remove('show'), 3200);
  }
}

function injectGlobalStyles(): void {
  try {
    const id = 'sether-shield-global-styles';
    if (document.getElementById(id)) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = `
      #prompt-textarea u,
      #prompt-textarea span[style*="underline"],
      #prompt-textarea .underline,
      div[contenteditable="true"] u,
      div[contenteditable="true"] span[style*="underline"],
      div[contenteditable="true"] .underline,
      .ql-editor u,
      .ql-editor span[style*="underline"] {
        text-decoration: underline !important;
        text-decoration-style: dashed !important;
        text-decoration-color: #ea580c !important;
        text-decoration-thickness: 1.5px !important;
        text-underline-offset: 3px !important;
      }
    `;
    document.head.appendChild(style);
  } catch {}
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  try {
    injectGlobalStyles();
    await loadTranslations();
    siteEnabled = await isSiteEnabled(location.origin);

    // Load custom rules and apply to detector
    try {
      const rules = await getCustomRules();
      applyCustomRules(rules);
    } catch { /* ignore */ }

    try {
      const v = await new Promise<Record<string, unknown>>((resolve) => {
        chrome.storage?.local.get('settings', (r) => resolve(r ?? {}));
      });
      globalEnabled =
        (v?.settings as { enabled?: boolean } | undefined)?.enabled ?? true;
      autoRedactEnabled =
        (v?.settings as { autoRedact?: boolean } | undefined)?.autoRedact ?? false;
    } catch {
      /* storage unavailable — run with defaults */
    }

    shieldUI = new ShieldUI();
    shieldUI.setEnabled(globalEnabled);

    if (!siteEnabled) {
      shieldUI.hide();
      return;
    }

    // F1: Paste tracking (capture-phase, fires before input event)
    onPasteHandler = (e: ClipboardEvent) => onPaste(e);
    document.addEventListener('paste', onPasteHandler, true);

    // Auto-detect typed content
    onInputDebounced = debounce(onInput, 250);
    onInputRaw = () => {
      if (autoRedactTimeoutId) {
        clearTimeout(autoRedactTimeoutId);
        autoRedactTimeoutId = undefined;
      }
      onInputDebounced?.();
    };
    onFocusInDebounced = debounce(onFocusIn, 100);

    document.addEventListener('input', onInputRaw, true);
    document.addEventListener('focusin', onFocusInDebounced, true);
    document.addEventListener('keydown', onKeydown, true);

    // Periodic scanner + DOM watchdog.
    // ChatGPT and other SPAs can replace document.body during navigation,
    // which detaches the shield host element. Re-mount ShieldUI if that happens.
    scanIntervalId = setInterval(() => {
      if (!document.getElementById('sether-shield-host')) {
        // Host was removed — re-create the UI
        try {
          shieldUI = new ShieldUI();
          shieldUI.setEnabled(globalEnabled);
          if (!siteEnabled) shieldUI.hide();
        } catch { /* ignore */ }
      }
      refresh();
    }, 2000);

    // F3: AI Response Guard — only relevant on AI chat UIs
    initResponseGuard();

    // Settings changes listener
    try {
      chrome.storage?.onChanged.addListener((changes) => {
        if (changes.settings) {
          globalEnabled = changes.settings.newValue?.enabled ?? true;
          autoRedactEnabled = changes.settings.newValue?.autoRedact ?? false;
          if (!autoRedactEnabled && autoRedactTimeoutId) {
            clearTimeout(autoRedactTimeoutId);
            autoRedactTimeoutId = undefined;
          }
          shieldUI.setEnabled(globalEnabled);
          loadTranslations().then(() => refresh());
        }
        if (changes.siteSettings) {
          isSiteEnabled(location.origin).then((enabled) => {
            siteEnabled = enabled;
            if (!enabled) {
              shieldUI.hide();
            } else {
              shieldUI.show();
              refresh();
            }
          });
        }
        if (changes.customRules) {
          // Reload custom rules into detector when changed from popup
          getCustomRules().then((rules) => applyCustomRules(rules));
        }
      });
    } catch { /* ignore */ }

    // Message handler from background
    try {
      chrome.runtime?.onMessage.addListener((message, _sender, sendResponse) => {
        if (message.action === 'triggerScan') {
          refresh();
          shieldUI.openPanel();
          sendResponse({ ok: true });
        } else if (message.action === 'getStatus') {
          sendResponse({
            matchCount: currentMatches.filter((m) => !dismissedKeys.has(matchKey(m))).length,
            enabled: globalEnabled,
            siteEnabled,
          });
        } else if (message.action === 'reloadRules') {
          // Rules changed from popup — reload into detector
          getCustomRules().then((rules) => applyCustomRules(rules));
          sendResponse({ ok: true });
        }
        return true;
      });
    } catch { /* ignore */ }
  } catch {
    /* never throw into the host page */
  }
}

// ── SVG Icons ─────────────────────────────────────────────────────────────────

const SHIELD_SVG =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>';

function getFooter(): string {
  return `<div class="ft"><span class="lock">●</span> ${escapeHtml(msg('localPrivacy'))} <a href="https://setherai.vercel.app" target="_blank" rel="noopener">sether</a></div>`;
}

// ── CSS ───────────────────────────────────────────────────────────────────────

const SHIELD_CSS = `
  :host, * { box-sizing: border-box; }
  .wrap { position: relative; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
  .pill { display: inline-flex; align-items: center; gap: 6px; height: 36px; padding: 0 12px; border: none; border-radius: 999px; background: linear-gradient(135deg, #f97316 0%, #ea580c 100%); color: #fff; cursor: pointer; box-shadow: 0 6px 20px -6px rgba(249,115,22,.5); transition: transform .15s; }
  .pill:active { cursor: grabbing; }
  .pill:hover { transform: translateY(-1px); }
  .pill:focus-visible { outline: 2px solid #f97316; outline-offset: 2px; }
  .pill.alert { background: linear-gradient(135deg, #ef4444 0%, #f97316 100%); box-shadow: 0 6px 20px -6px rgba(239,68,68,.7); animation: pulse 2s ease-in-out infinite; }
  .pill.off { background: #71717a; box-shadow: none; opacity: .8; }
  .mark { display: inline-flex; pointer-events: none; }
  .count { font: 600 12px/1 ui-monospace, monospace; background: rgba(255,255,255,.25); padding: 2.5px 6.5px; border-radius: 999px; pointer-events: none; }
  
  .panel {
    position: absolute; right: 0; bottom: 46px; width: 320px;
    background: #ffffff; color: #1f2937;
    border: 1px solid #e5e7eb; border-radius: 16px;
    box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
    padding: 16px; opacity: 0; transform: translateY(8px);
    pointer-events: none; transition: opacity .2s, transform .2s;
  }
  .panel.show { opacity: 1; transform: translateY(0); pointer-events: auto; }
  .panel.align-left { right: auto; left: 0; }
  .panel.align-right { left: auto; right: 0; }
  .panel.align-bottom { bottom: auto; top: 46px; }
  .panel.align-top { top: auto; bottom: 46px; }

  .hd { font-weight: 700; font-size: 14px; margin-bottom: 12px; color: #111827; }
  .rg-hd { color: #dc2626; }
  .muted { color: #6b7280; font-size: 13px; line-height: 1.5; margin: 0 0 10px; }
  
  .list { list-style: none; margin: 0 0 14px; padding: 0; max-height: 240px; overflow-y: auto; }
  .match-row {
    display: flex; align-items: flex-start; justify-content: space-between;
    padding: 10px 0; border-bottom: 1px solid #f3f4f6; gap: 12px;
  }
  .match-row:last-child { border-bottom: none; }
  .match-info { flex: 1; min-width: 0; }
  .match-meta { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; flex-wrap: wrap; }
  .match-dot { width: 6px; height: 6px; border-radius: 999px; background: #f97316; flex-shrink: 0; }
  .rg-dot { background: #dc2626; }
  .match-cat { font-size: 9px; font-weight: 700; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; }
  .match-preview { font-size: 12px; line-height: 1.5; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; word-break: break-all; color: #374151; }
  .match-orig { text-decoration: line-through; color: #ef4444; opacity: 0.85; }
  .match-arrow { color: #9ca3af; margin: 0 4px; }
  .match-masked { color: #10b981; font-weight: 600; }

  /* F1: Paste source badge */
  .src-badge { font-size: 9px; font-weight: 600; padding: 1px 5px; border-radius: 4px; }
  .src-badge.paste { background: #fef3c7; color: #92400e; }
  
  .match-actions { display: flex; gap: 6px; align-items: center; margin-top: 2px; }
  .match-actions button {
    width: 24px; height: 24px; border-radius: 6px; border: none; cursor: pointer;
    font-size: 12px; display: flex; align-items: center; justify-content: center;
    transition: background-color 0.15s, color 0.15s;
  }
  .match-accept { background: #e0f2fe; color: #0369a1; }
  .match-accept:hover { background: #0284c7; color: #fff; }
  .match-dismiss, .rg-skip { background: #f3f4f6; color: #4b5563; }
  .match-dismiss:hover, .rg-skip:hover { background: #e5e7eb; color: #111827; }
  .rg-mask { background: #fee2e2; color: #dc2626; }
  .rg-mask:hover { background: #dc2626; color: #fff; }

  /* F3: Response Guard labels */
  .rg-label { font-size: 11px; font-weight: 700; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; margin: 8px 0 4px; }
  .rg-echo { color: #dc2626; }

  .scrub {
    width: 100%; height: 36px; border: none; border-radius: 10px;
    background: linear-gradient(135deg, #f97316 0%, #ea580c 100%); color: #fff; font-weight: 600; font-size: 13px;
    cursor: pointer; transition: opacity .15s; margin-top: 4px;
    box-shadow: 0 4px 12px rgba(249,115,22,.2);
  }
  .scrub:hover { opacity: 0.9; }
  .scrub:focus-visible { outline: 2px solid #f97316; outline-offset: 2px; }

  
  .ft { margin-top: 12px; font-size: 11px; color: #9ca3af; line-height: 1.4; border-top: 1px solid #f3f4f6; padding-top: 8px; }
  .ft .lock { color: #10b981; }
  .ft a { color: #ea580c; text-decoration: none; font-weight: 600; }
  .ft a:hover { text-decoration: underline; }
  .toast { position: absolute; right: 0; bottom: 46px; max-width: 280px; background: #111827; color: #fff; font-size: 13px; line-height: 1.4; padding: 10px 12px; border-radius: 10px; box-shadow: 0 12px 30px -10px rgba(0,0,0,.4); opacity: 0; transform: translateY(6px); pointer-events: none; transition: opacity .2s, transform .2s; }
  .toast.show { opacity: 1; transform: translateY(0); }
  @keyframes pulse {
    0%, 100% { box-shadow: 0 6px 20px -6px rgba(239,68,68,.5); }
    50% { box-shadow: 0 6px 28px -4px rgba(239,68,68,.7); }
  }
`;

// Guard: only run once per top-level frame, avoid duplicate injection
if (
  !(window as unknown as { __setherShield?: boolean }).__setherShield
) {
  (window as unknown as { __setherShield?: boolean }).__setherShield = true;
  boot();
}
