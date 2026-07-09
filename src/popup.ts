// Popup: tabbed UI — Home (toggles, stats, history), Rules (friendly rule editor).
// All persistence via chrome.storage.local.

import {
  getSettings,
  setSettings,
  getStats,
  getRedactionHistory,
  deleteRedactionRecord,
  clearRedactionHistory,
  loadTranslations,
  translate,
  getCustomRules,
  addCustomRule,
  updateCustomRule,
  deleteCustomRule,
  resetBuiltinRules,
} from './storage.js';

import type { CustomRule } from './types.js';

// ── Constants ──────────────────────────────────────────────────────────────────

const LANG_NAMES: Record<string, string> = {
  en: 'English', fr: 'Français', es: 'Español', pt: 'Português',
  de: 'Deutsch', ar: 'العربية', zh_CN: '简体中文',
};
const LANG_LABELS: Record<string, string> = {
  en: 'Language', fr: "Langue", es: 'Idioma', pt: 'Idioma',
  de: 'Sprache', ar: 'لغة', zh_CN: '语言',
};

/** Friendly rule presets — no regex visible to the user. */
const RULE_PRESETS: Record<string, { icon: string; pattern: string; flags: string; desc: string; replacement: string }> = {
  phone:   { icon: '📞', pattern: '\\+?\\d[\\d\\s\\-().]{7,}\\d', flags: 'g',  desc: 'Detects phone numbers in various formats', replacement: '[PHONE]' },
  id:      { icon: '🪪', pattern: '\\b[A-Z]{0,3}\\d{6,12}[A-Z]?\\b',   flags: 'gi', desc: 'Detects ID/reference numbers (6–12 digits)', replacement: '[ID]' },
  account: { icon: '🏦', pattern: '\\b\\d{8,18}\\b',                     flags: 'g',  desc: 'Detects account/routing numbers (8–18 digits)', replacement: '[ACCOUNT]' },
  address: { icon: '📍', pattern: '\\d+\\s+[A-Za-z]+(?:\\s+[A-Za-z]+){1,5}(?:,\\s*[A-Za-z]+)?', flags: 'g', desc: 'Detects street addresses with numbers', replacement: '[ADDRESS]' },
};

const RULE_ICONS: Record<string, string> = {
  phone: '📞', id: '🪪', account: '🏦', address: '📍', keyword: '🔤', custom: '⚙️',
};

// ── DOM Elements ──────────────────────────────────────────────────────────────

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// Tabs
const tabBtns = document.querySelectorAll<HTMLButtonElement>('.tab-btn');
const panels  = document.querySelectorAll<HTMLElement>('.panel');

// Home
const toggle = $<HTMLInputElement>('toggle');
const stateEl = $('state');
const autoRedactToggle = $<HTMLInputElement>('autoRedactToggle');
const autoRedactState = $('autoRedactState');
const langSelect = $<HTMLSelectElement>('langSelect');
const selectedLangName = $('selectedLangName');
const scrubbedEl = $('scrubbed');
const caughtEl = $('caught');
const historyList = $('historyList');
const historyEmpty = $('historyEmpty');
const clearHistoryBtn = $('clearHistory');
const lblProtection = $('lblProtection');
const lblLanguage = $('lblLanguage');
const lblAutoRedact = $('lblAutoRedact');
const lblScrubbedCap = $('lblScrubbedCap');
const lblCaughtCap = $('lblCaughtCap');
const lblHistory = $('lblHistory');
const lblFooterPrivacy = $('lblFooterPrivacy');

// Rules
const rulesList = $('rulesList');
const rulesEmpty = $('rulesEmpty');
const addRuleBtn = $('addRuleBtn');
const resetRulesBtn = $('resetRulesBtn');

// Add Rule Overlay
const addRuleOverlay = $('addRuleOverlay');
const addRuleBack = $('addRuleBack');
const ruleNameIn = $<HTMLInputElement>('ruleNameIn');
const typeGrid = $('typeGrid');
const keywordGroup = $('keywordGroup');
const keywordIn = $<HTMLInputElement>('keywordIn');
const customGroup = $('customGroup');
const customPatternIn = $<HTMLInputElement>('customPatternIn');
const patternErr = $('patternErr');
const saveRuleBtn = $<HTMLButtonElement>('saveRuleBtn');

// Replacement Group Elements
const replacementGroup = $('replacementGroup');
const ruleReplacementIn = $<HTMLInputElement>('ruleReplacementIn');

// Suggestions Group Elements
const suggestionsGroup = $('suggestionsGroup');
const patternSuggestions = $('patternSuggestions');

// ── Tab Navigation ────────────────────────────────────────────────────────────

tabBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    tabBtns.forEach((b) => b.classList.remove('active'));
    panels.forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    const target = btn.getAttribute('data-tab');
    const panel = document.getElementById(`panel${capitalize(target || 'home')}`);
    panel?.classList.add('active');
  });
});

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function applyEnabled(enabled: boolean): void {
  toggle.checked = enabled;
  stateEl.textContent = enabled ? translate('statusOn') : translate('statusPaused');
  stateEl.className = enabled ? 'state state-active' : 'state state-inactive';
}

function applyAutoRedact(enabled: boolean): void {
  autoRedactToggle.checked = enabled;
  autoRedactState.textContent = enabled ? translate('enabled') : translate('disabled');
  autoRedactState.className = enabled ? 'state state-active' : 'state state-inactive';
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function renderLabels(): void {
  lblProtection.textContent = translate('protectionLabel');
  lblLanguage.textContent = LANG_LABELS[langSelect.value] || 'Language';
  lblAutoRedact.textContent = translate('autoRedactLabel');
  lblScrubbedCap.textContent = translate('promptsScrubbed');
  lblCaughtCap.textContent = translate('piiCaught');
  lblHistory.textContent = translate('redactionHistory');
  clearHistoryBtn.textContent = translate('clearAll');
  lblFooterPrivacy.textContent = translate('footerPrivacy') !== 'footerPrivacy'
    ? translate('footerPrivacy')
    : '100% local, nothing leaves your browser';
  selectedLangName.textContent = LANG_NAMES[langSelect.value] || 'English';
  applyEnabled(toggle.checked);
  applyAutoRedact(autoRedactToggle.checked);
}

// ── History ───────────────────────────────────────────────────────────────────

async function renderHistory(): Promise<void> {
  const history = await getRedactionHistory();
  historyList.innerHTML = '';

  if (history.length === 0) {
    historyEmpty.textContent = translate('noHistory') !== 'noHistory' ? translate('noHistory') : 'No redactions yet.';
    historyEmpty.style.display = 'block';
    historyList.appendChild(historyEmpty);
    clearHistoryBtn.style.display = 'none';
    return;
  }

  historyEmpty.style.display = 'none';
  clearHistoryBtn.style.display = '';

  const recent = history.slice(-15).reverse();
  for (const r of recent) {
    const item = document.createElement('div');
    item.className = 'h-item';

    let catHTML = `<span class="h-dot"></span><span style="text-transform:capitalize">${r.category}</span>`;
    if (r.source === 'paste') catHTML += `<span class="h-badge">📋</span>`;

    item.innerHTML = `
      <div class="h-info">
        <div class="h-cat">${catHTML}<span class="h-val">${escapeHtml(r.redactedValue)}</span></div>
        <div class="h-meta">${safeHostname(r.pageUrl)} — ${timeAgo(r.timestamp)}</div>
      </div>`;

    const del = document.createElement('button');
    del.className = 'h-del';
    del.textContent = '×';
    del.addEventListener('click', async () => { await deleteRedactionRecord(r.id); await renderHistory(); });
    item.appendChild(del);
    historyList.appendChild(item);
  }
}

function escapeHtml(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function safeHostname(url: string): string {
  try { return new URL(url).hostname; } catch { return ''; }
}

// ── Rules ─────────────────────────────────────────────────────────────────────

function ruleTypeIcon(rule: { pattern: string; builtIn: boolean }): string {
  if (rule.pattern.includes('\\d') && rule.pattern.includes('\\s') && rule.pattern.includes('+?')) return '📞';
  for (const [key, preset] of Object.entries(RULE_PRESETS)) {
    if (rule.pattern === preset.pattern) return RULE_ICONS[key] || '📋';
  }
  return rule.builtIn ? '📋' : '⚙️';
}

async function renderRules(): Promise<void> {
  const rules = await getCustomRules();
  rulesList.innerHTML = '';

  if (rules.length === 0) {
    rulesEmpty.style.display = 'block';
    rulesList.appendChild(rulesEmpty);
    return;
  }
  rulesEmpty.style.display = 'none';

  for (const rule of rules) {
    const card = document.createElement('div');
    card.className = 'rule-card';

    const icon = document.createElement('span');
    icon.className = 'rule-icon';
    icon.textContent = ruleTypeIcon(rule);

    const body = document.createElement('div');
    body.className = 'rule-body';

    const nameEl = document.createElement('div');
    nameEl.className = 'rule-name';

    const textSpan = document.createElement('span');
    textSpan.className = 'rule-title-txt';
    textSpan.textContent = rule.name;
    textSpan.title = rule.name;
    nameEl.appendChild(textSpan);

    if (rule.builtIn) {
      const badge = document.createElement('span');
      badge.className = 'rule-badge';
      badge.textContent = 'built-in';
      nameEl.appendChild(badge);
    }

    const desc = document.createElement('div');
    desc.className = 'rule-desc';
    desc.textContent = rule.enabled ? `Active · replaces with ${rule.replacement}` : 'Disabled';

    body.appendChild(nameEl);
    body.appendChild(desc);

    const actions = document.createElement('div');
    actions.className = 'rule-actions';

    const sw = document.createElement('label');
    sw.className = 'switch';
    sw.style.cssText = 'width:34px;height:18px;';
    const inp = document.createElement('input');
    inp.type = 'checkbox';
    inp.checked = rule.enabled;
    inp.addEventListener('change', async () => {
      await updateCustomRule(rule.id, { enabled: inp.checked });
      notifyContentScript();
      await renderRules();
    });
    const sli = document.createElement('span');
    sli.className = 'slider';
    sw.appendChild(inp);
    sw.appendChild(sli);
    actions.appendChild(sw);

    // Edit button
    const editBtn = document.createElement('button');
    editBtn.className = 'rule-edit';
    editBtn.textContent = '✏️';
    editBtn.title = 'Edit rule';
    editBtn.addEventListener('click', () => {
      openEditRule(rule);
    });
    actions.appendChild(editBtn);

    if (!rule.builtIn) {
      const del = document.createElement('button');
      del.className = 'rule-del';
      del.textContent = '×';
      del.addEventListener('click', async () => {
        await deleteCustomRule(rule.id);
        notifyContentScript();
        await renderRules();
      });
      actions.appendChild(del);
    }

    card.appendChild(icon);
    card.appendChild(body);
    card.appendChild(actions);
    rulesList.appendChild(card);
  }
}

function notifyContentScript(): void {
  try {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) chrome.tabs.sendMessage(tabs[0].id, { action: 'reloadRules' }).catch(() => {});
    });
  } catch {}
}

// ── Add/Edit Rule Overlay ──────────────────────────────────────────────────────

let selectedType: string | null = null;
let editingRuleId: string | null = null;

addRuleBtn.addEventListener('click', () => openAddRule());
addRuleBack.addEventListener('click', () => closeAddRule());

function openAddRule(): void {
  editingRuleId = null;
  addRuleOverlay.classList.add('open');
  addRuleOverlay.querySelector('.aro-title')!.textContent = 'Add a Rule';
  saveRuleBtn.textContent = 'Save rule';
  
  ruleNameIn.value = '';
  keywordIn.value = '';
  customPatternIn.value = '';
  ruleReplacementIn.value = '';
  selectedType = null;
  keywordGroup.style.display = 'none';
  customGroup.style.display = 'none';
  replacementGroup.style.display = 'none';
  suggestionsGroup.style.display = 'none';
  patternErr.classList.remove('show');
  customPatternIn.classList.remove('err');
  saveRuleBtn.disabled = true;
  typeGrid.querySelectorAll('.type-opt').forEach((o) => o.classList.remove('selected'));
  ruleNameIn.focus();
}

function openEditRule(rule: CustomRule): void {
  editingRuleId = rule.id;
  addRuleOverlay.classList.add('open');
  addRuleOverlay.querySelector('.aro-title')!.textContent = 'Edit Rule';
  saveRuleBtn.textContent = 'Save changes';

  ruleNameIn.value = rule.name;
  ruleReplacementIn.value = rule.replacement;
  
  keywordIn.value = '';
  customPatternIn.value = '';
  patternErr.classList.remove('show');
  customPatternIn.classList.remove('err');

  // Detect type
  let detectedType = 'custom';
  if (rule.pattern.includes('\\d') && rule.pattern.includes('\\s') && rule.pattern.includes('+?')) {
    detectedType = 'phone';
  } else {
    for (const [key, preset] of Object.entries(RULE_PRESETS)) {
      if (rule.pattern === preset.pattern) {
        detectedType = key;
        break;
      }
    }
  }

  // If custom, check if it's keyword-based
  if (detectedType === 'custom' && !/[*+?^${}()|[\]\\]/.test(rule.pattern.replace(/\\./g, ''))) {
    detectedType = 'keyword';
    keywordIn.value = rule.pattern.replace(/\\(.)/g, '$1');
  } else if (detectedType === 'custom') {
    customPatternIn.value = rule.pattern;
  }

  selectedType = detectedType;
  typeGrid.querySelectorAll('.type-opt').forEach((o) => {
    o.classList.toggle('selected', o.getAttribute('data-type') === detectedType);
  });

  keywordGroup.style.display = selectedType === 'keyword' ? 'block' : 'none';
  customGroup.style.display = selectedType === 'custom' ? 'block' : 'none';
  suggestionsGroup.style.display = selectedType === 'custom' ? 'block' : 'none';
  replacementGroup.style.display = 'block';

  updateSaveState();
}

function closeAddRule(): void {
  addRuleOverlay.classList.remove('open');
}

// Type picker
typeGrid.addEventListener('click', (e) => {
  const opt = (e.target as HTMLElement).closest<HTMLElement>('.type-opt');
  if (!opt) return;
  typeGrid.querySelectorAll('.type-opt').forEach((o) => o.classList.remove('selected'));
  opt.classList.add('selected');
  selectedType = opt.getAttribute('data-type');

  keywordGroup.style.display = selectedType === 'keyword' ? 'block' : 'none';
  customGroup.style.display = selectedType === 'custom' ? 'block' : 'none';
  suggestionsGroup.style.display = selectedType === 'custom' ? 'block' : 'none';
  replacementGroup.style.display = 'block';

  // Apply default replacement label if empty
  if (selectedType && selectedType !== 'keyword' && selectedType !== 'custom') {
    const preset = RULE_PRESETS[selectedType];
    if (preset) {
      ruleReplacementIn.value = preset.replacement;
    }
  } else if (selectedType === 'keyword') {
    ruleReplacementIn.value = '[REDACTED]';
  } else if (selectedType === 'custom') {
    ruleReplacementIn.value = '[CUSTOM]';
  }

  updateSaveState();
});

// Suggestions selection click handler
patternSuggestions.addEventListener('click', (e) => {
  const chip = (e.target as HTMLElement).closest<HTMLElement>('.type-opt');
  if (!chip) return;
  
  const pattern = chip.getAttribute('data-pattern') || '';
  const name = chip.getAttribute('data-name') || '';
  const rep = chip.getAttribute('data-rep') || '';

  ruleNameIn.value = name;
  customPatternIn.value = pattern;
  ruleReplacementIn.value = rep;

  // Clear errors if any
  patternErr.classList.remove('show');
  customPatternIn.classList.remove('err');

  updateSaveState();
});

// Live validation
ruleNameIn.addEventListener('input', updateSaveState);
keywordIn.addEventListener('input', updateSaveState);
ruleReplacementIn.addEventListener('input', updateSaveState);
customPatternIn.addEventListener('input', () => {
  const p = customPatternIn.value.trim();
  if (p) {
    try { new RegExp(p, 'gi'); patternErr.classList.remove('show'); customPatternIn.classList.remove('err'); }
    catch { patternErr.classList.add('show'); customPatternIn.classList.add('err'); }
  } else {
    patternErr.classList.remove('show');
    customPatternIn.classList.remove('err');
  }
  updateSaveState();
});

function updateSaveState(): void {
  const hasName = ruleNameIn.value.trim().length > 0;
  const hasType = selectedType !== null;
  const hasReplacement = ruleReplacementIn.value.trim().length > 0;
  let hasInput = true;

  if (selectedType === 'keyword') hasInput = keywordIn.value.trim().length > 0;
  if (selectedType === 'custom') {
    const p = customPatternIn.value.trim();
    hasInput = p.length > 0;
    try { new RegExp(p, 'gi'); } catch { hasInput = false; }
  }
  saveRuleBtn.disabled = !(hasName && hasType && hasInput && hasReplacement);
}

saveRuleBtn.addEventListener('click', async () => {
  if (saveRuleBtn.disabled) return;

  const name = ruleNameIn.value.trim();
  const replacement = ruleReplacementIn.value.trim() || '[REDACTED]';
  let pattern = '';
  let flags = 'gi';

  if (selectedType === 'keyword') {
    const kw = keywordIn.value.trim();
    pattern = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    flags = 'gi';
  } else if (selectedType === 'custom') {
    pattern = customPatternIn.value.trim();
    flags = 'gi';
  } else if (selectedType) {
    const preset = RULE_PRESETS[selectedType];
    if (preset) {
      pattern = preset.pattern;
      flags = preset.flags;
    }
  }

  if (!pattern) return;

  if (editingRuleId) {
    await updateCustomRule(editingRuleId, { name, pattern, flags, replacement });
    editingRuleId = null;
  } else {
    await addCustomRule({ name, pattern, flags, replacement, enabled: true, builtIn: false });
  }
  closeAddRule();
  notifyContentScript();
  await renderRules();
});

// ── Initialize ────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  const settings = await getSettings();
  await loadTranslations();

  // Language
  const uiLang = (chrome.i18n.getUILanguage ? chrome.i18n.getUILanguage() : 'en').replace('-', '_');
  const selectedLang = settings.language ?? uiLang ?? 'en';
  const locales = ['en', 'fr', 'es', 'pt', 'de', 'ar', 'zh_CN'];
  let targetLocale = locales.includes(selectedLang) ? selectedLang : 'en';
  if (selectedLang.startsWith('zh')) targetLocale = 'zh_CN';
  langSelect.value = targetLocale;

  applyEnabled(settings.enabled);
  renderLabels();

  const stats = await getStats();
  scrubbedEl.textContent = String(stats.promptsScrubbed);
  caughtEl.textContent = String(stats.piiCaught);
  applyAutoRedact(!!settings.autoRedact);

  // Parallel renders
  await Promise.all([renderRules(), renderHistory()]);
}

// ── Event Listeners ───────────────────────────────────────────────────────────

toggle.addEventListener('change', async () => {
  const settings = await getSettings();
  settings.enabled = toggle.checked;
  applyEnabled(toggle.checked);
  await setSettings(settings);
});

autoRedactToggle.addEventListener('change', async () => {
  const settings = await getSettings();
  settings.autoRedact = autoRedactToggle.checked;
  applyAutoRedact(autoRedactToggle.checked);
  await setSettings(settings);
});

langSelect.addEventListener('change', async () => {
  const settings = await getSettings();
  settings.language = langSelect.value;
  await setSettings(settings);
  await loadTranslations();
  renderLabels();
  await renderHistory();
});

clearHistoryBtn.addEventListener('click', async () => {
  await clearRedactionHistory();
  await renderHistory();
});

resetRulesBtn.addEventListener('click', async () => {
  if (confirm('Are you sure you want to reset all built-in rules back to their default settings?')) {
    await resetBuiltinRules();
    notifyContentScript();
    await renderRules();
  }
});

init();
