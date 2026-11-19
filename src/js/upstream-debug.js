import { api, errorMessage } from './api.js';
import { failureDelay } from './poller.js';
import { message, subscribeLocale, t } from './i18n.js';
import { refreshNotice, showNotice } from './notices.js';

const keyFor = (entry) => `${entry.provider}/${entry.call}`;

export function initUpstreamDebug() {
  if (new URLSearchParams(location.search).get('debug') !== '1') return;
  const panel = document.getElementById('upstream-debug');
  const filter = document.getElementById('debug-call-filter');
  const output = document.getElementById('debug-json');
  const status = document.getElementById('debug-status');
  const errorNotice = document.getElementById('debug-error');
  const pause = document.getElementById('debug-pause');
  panel.hidden = false;
  let entries = [], dropped = 0, timer = null, controller = null, generation = 0, failures = 0, paused = false, disabled = false;
  let lastSnapshot = null, retryAt = 0;

  function renderLabels() {
    filter.options[0].textContent = t('debugAll');
    const shown = filter.value ? entries.filter((entry) => keyFor(entry) === filter.value).length : entries.length;
    status.textContent = t('debugStatus', shown, entries.length, dropped);
    pause.textContent = t(paused ? 'debugResume' : 'debugPause');
    refreshNotice(errorNotice);
  }

  function render() {
    const selected = filter.value;
    const calls = [...new Set(entries.map(keyFor))];
    if (selected && !calls.includes(selected)) calls.push(selected);
    filter.replaceChildren(new Option(t('debugAll'), ''), ...calls.sort().map((key) => new Option(key, key)));
    filter.value = selected;
    const matches = selected ? entries.filter((entry) => keyFor(entry) === selected) : entries;
    const text = JSON.stringify(matches, null, 2);
    if (output.value !== text) {
      const { selectionStart, selectionEnd, scrollTop } = output;
      output.value = text;
      if (document.activeElement === output) output.setSelectionRange(selectionStart, selectionEnd);
      output.scrollTop = scrollTop;
    }
    renderLabels();
  }

  function stop() {
    generation++;
    clearTimeout(timer);
    controller?.abort();
    controller = null;
  }
  const active = () => !disabled && !paused && panel.open && !document.hidden;
  async function poll() {
    if (!active() || controller) return;
    clearTimeout(timer);
    if (Date.now() < retryAt) { timer = setTimeout(poll, retryAt - Date.now()); return; }
    const token = generation;
    const request = new AbortController();
    controller = request;
    let wait = 2000;
    try {
      const data = await api.getUpstreamDebug({ signal: request.signal });
      if (token !== generation) return;
      if (!data || !Array.isArray(data.entries) || !Number.isInteger(data.dropped) || data.dropped < 0 ||
          data.entries.some((entry) => !entry || !['boreal', 'lokaltrafiken'].includes(entry.provider) || typeof entry.call !== 'string')) {
        throw new Error('Invalid upstream debug response.');
      }
      const snapshot = JSON.stringify({ entries: data.entries, dropped: data.dropped });
      if (lastSnapshot !== snapshot) {
        entries = data.entries;
        dropped = data.dropped;
        lastSnapshot = snapshot;
        render();
      }
      failures = 0;
      showNotice(errorNotice, '');
    } catch (error) {
      if (token !== generation) return;
      disabled = error.status === 404 || error.status === 403;
      const detail = error.message === 'Invalid upstream debug response.' ? message('debugInvalid') : errorMessage(error);
      showNotice(errorNotice, disabled ? message('debugDisabled') : message('debugFailed', detail));
      wait = failureDelay(++failures, error.retryAfter);
      retryAt = Date.now() + wait;
    } finally {
      if (token === generation) {
        controller = null;
        if (active()) timer = setTimeout(poll, wait);
      }
    }
  }
  filter.addEventListener('change', render);
  pause.addEventListener('click', () => {
    paused = !paused;
    renderLabels();
    pause.setAttribute('aria-pressed', String(paused));
    stop();
    if (active()) void poll();
  });
  panel.addEventListener('toggle', () => { stop(); if (active()) void poll(); });
  document.addEventListener('visibilitychange', () => { stop(); if (active()) void poll(); });
  subscribeLocale(renderLabels);
  render();
  void poll();
}
