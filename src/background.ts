// Sether Shield — background service worker (MV3).
//
// Responsibilities:
// 1. Listen for keyboard shortcut commands (chrome.commands)
// 2. Forward scan triggers to content scripts via chrome.tabs.sendMessage
// 3. Update toolbar badge text/color based on PII count from content scripts
// 4. Right-click context menu: redact / mask / decoy the selected text
// 5. Grant content scripts access to chrome.storage.session (the restore
//    vault) — memory-only storage that survives tab reloads, never disk
//
// This service worker makes ZERO network calls.
// All detection runs in the content script; the service worker is a thin relay.

// chrome.storage.session is invisible to content scripts until the trusted
// context (this worker) raises its access level. Runs at top level so it
// re-applies every time MV3 restarts the worker.
try {
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
} catch {
  /* very old Chrome — vault falls back to per-page memory */
}

// ── Context menu (right-click → Sether Shield → …) ────────────────────────────

const MENU_PARENT = 'sether-shield';
const MENU_ACTIONS: Record<string, 'redact' | 'mask' | 'decoy'> = {
  'sether-redact': 'redact',
  'sether-mask': 'mask',
  'sether-decoy': 'decoy',
};

function buildMenus(): void {
  // removeAll first: onInstalled AND worker restarts both call this; creating
  // a duplicate id throws.
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_PARENT,
      title: 'Sether Shield',
      contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: 'sether-redact',
      parentId: MENU_PARENT,
      title: chrome.i18n.getMessage('ctxRedact') || 'Redact selection',
      contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: 'sether-mask',
      parentId: MENU_PARENT,
      title: chrome.i18n.getMessage('ctxMask') || 'Mask selection',
      contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: 'sether-decoy',
      parentId: MENU_PARENT,
      title: chrome.i18n.getMessage('ctxDecoy') || 'Swap for a decoy',
      contexts: ['selection'],
    });
  });
}

chrome.runtime.onInstalled.addListener(buildMenus);
chrome.runtime.onStartup.addListener(buildMenus);

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const mode = MENU_ACTIONS[String(info.menuItemId)];
  if (!mode || !tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, {
      action: 'contextAction',
      mode,
      selectionText: info.selectionText ?? '',
    });
  } catch {
    // Content script not injected on this page — ignore silently.
  }
});

// ── Keyboard shortcut ─────────────────────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command: string) => {
  if (command === 'trigger-scan') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      try {
        await chrome.tabs.sendMessage(tab.id, { action: 'triggerScan' });
      } catch {
        // Content script not injected on this page — ignore silently.
        // This happens on pages not matched by content_scripts.matches.
      }
    }
  }
});

// Relay badge updates from content scripts → toolbar icon
chrome.runtime.onMessage.addListener((message, sender) => {
  // Only accept messages from our own content scripts (not external pages)
  if (sender.id !== chrome.runtime.id) return;
  if (message.action === 'updateBadge' && sender.tab?.id) {
    const count = message.count as number;

    chrome.action.setBadgeText({
      text: count > 0 ? String(count) : '',
      tabId: sender.tab.id,
    });

    chrome.action.setBadgeBackgroundColor({
      color: count > 0 ? '#eb7a09' : '#4f46e5',
      tabId: sender.tab.id,
    });
  }
});
