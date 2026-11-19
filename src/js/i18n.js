import { messages } from './translations.js';

const STORAGE_KEY = 'kiruna-bus-tracker.locale';
const supported = (value) => value === 'sv' || value === 'en';
const listeners = new Set();
let locale = 'en';

export function getLocale() { return locale; }

export function subscribeLocale(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function t(key, ...args) {
  const translation = messages[key]?.[locale === 'sv' ? 1 : 0] ?? key;
  return typeof translation === 'function' ? translation(...args.map(formatMessage)) : translation;
}

// Keep message descriptors until display so an error/event can outlive a language change.
export function message(key, ...args) { return { key, args }; }

export function formatMessage(value) {
  return value?.args ? t(value.key, ...value.args) : value;
}

export function formatLocale() { return locale === 'sv' ? 'sv-SE' : 'en-GB'; }

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

// Used inside existing render templates; language changes update these leaf
// nodes in place rather than replacing interactive cards and controls.
export function localizedText(key, ...args) {
  const params = args.length ? ` data-i18n-args="${escapeHtml(JSON.stringify(args))}"` : '';
  return `<span data-i18n="${key}"${params}>${escapeHtml(t(key, ...args))}</span>`;
}

export function localizedAttr(attribute, key, ...args) {
  const params = args.length ? ` data-i18n-args="${escapeHtml(JSON.stringify(args))}"` : '';
  return `${attribute}="${escapeHtml(t(key, ...args))}" data-i18n-${attribute}="${key}"${params}`;
}

function updateDocument(buttons) {
  document.documentElement.lang = locale;
  document.title = t('pageTitle');
  for (const [attribute, selector] of [
    [null, 'data-i18n'], ['aria-label', 'data-i18n-aria-label'],
    ['placeholder', 'data-i18n-placeholder'], ['title', 'data-i18n-title'],
  ]) {
    for (const element of document.querySelectorAll(`[${selector}]`)) {
      const args = element.dataset.i18nArgs ? JSON.parse(element.dataset.i18nArgs) : [];
      const text = t(element.getAttribute(selector), ...args);
      if (attribute) element.setAttribute(attribute, text);
      else if (element.textContent !== text) element.textContent = text;
    }
  }
  for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.locale === locale));
}

export function initLocale() {
  let override;
  try { override = localStorage.getItem(STORAGE_KEY); } catch { /* Storage is optional. */ }
  locale = supported(override) ? override : (navigator.languages ?? [])
    .map((tag) => tag.toLowerCase().split('-')[0]).find(supported) ?? 'en';
  const buttons = [...document.querySelectorAll('#language-switch button[data-locale]')];
  updateDocument(buttons);
  for (const button of buttons) {
    button.addEventListener('click', () => {
      const next = button.dataset.locale;
      try { localStorage.setItem(STORAGE_KEY, next); } catch { /* Use the choice in memory. */ }
      if (next === locale) return;
      locale = next;
      updateDocument(buttons);
      for (const listener of listeners) listener(locale);
    });
  }
}
