import { subscribeLocale, t } from './i18n.js';

const STORAGE_KEY = 'theme';
const THEMES = ['light', 'dark'];

function storedTheme() {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return THEMES.includes(value) ? value : null;
  } catch {
    return null;
  }
}

function systemTheme() {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function currentTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const button = document.getElementById('theme-toggle');
  if (button) {
    button.textContent = t(theme === 'dark' ? 'lightTheme' : 'darkTheme');
    button.setAttribute('aria-label', t(theme === 'dark' ? 'switchLight' : 'switchDark'));
  }
}

// An explicit choice (saved in localStorage) wins; otherwise the page follows
// the OS setting, including live changes. index.html sets the initial theme
// inline so the first paint is already correct.
export function initTheme() {
  applyTheme(storedTheme() ?? systemTheme());
  subscribeLocale(() => applyTheme(currentTheme()));

  const query = window.matchMedia?.('(prefers-color-scheme: dark)');
  query?.addEventListener('change', () => {
    if (!storedTheme()) applyTheme(systemTheme());
  });

  document.getElementById('theme-toggle')?.addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage unavailable (private mode): the choice lasts for this page only.
    }
    applyTheme(next);
  });
}
