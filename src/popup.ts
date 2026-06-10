// Popup: on/off toggle + session stats. Reads/writes chrome.storage.local.

interface Settings {
  enabled: boolean;
}
interface Stats {
  promptsScrubbed: number;
  piiCaught: number;
}

const toggle = document.getElementById('toggle') as HTMLInputElement;
const state = document.getElementById('state') as HTMLElement;
const scrubbedEl = document.getElementById('scrubbed') as HTMLElement;
const caughtEl = document.getElementById('caught') as HTMLElement;

function applyEnabled(enabled: boolean): void {
  toggle.checked = enabled;
  state.textContent = enabled ? 'On' : 'Paused';
}

chrome.storage.local.get(['settings', 'stats'], (v) => {
  const settings: Settings = v.settings ?? { enabled: true };
  const stats: Stats = v.stats ?? { promptsScrubbed: 0, piiCaught: 0 };
  applyEnabled(settings.enabled);
  scrubbedEl.textContent = String(stats.promptsScrubbed);
  caughtEl.textContent = String(stats.piiCaught);
});

toggle.addEventListener('change', () => {
  const enabled = toggle.checked;
  applyEnabled(enabled);
  chrome.storage.local.set({ settings: { enabled } });
});
