// Sether Shield — background service worker (MV3).
//
// Responsibilities:
// 1. Listen for keyboard shortcut commands (chrome.commands)
// 2. Forward scan triggers to content scripts via chrome.tabs.sendMessage
// 3. Update toolbar badge text/color based on PII count from content scripts
//
// This service worker makes ZERO network calls.
// All detection runs in the content script; the service worker is a thin relay.

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
