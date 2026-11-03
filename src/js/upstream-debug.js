import { api } from './api.js';
import { failureDelay } from './poller.js';

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

  function render() {
    const selected = filter.value;
    const calls = [...new Set(entries.map(keyFor))];
    if (selected && !calls.includes(selected)) calls.push(selected);
    filter.replaceChildren(new Option('All calls', ''), ...calls.sort().map((key) => new Option(key, key)));
    filter.value = selected;
    const matches = selected ? entries.filter((entry) => keyFor(entry) === selected) : entries;
    const text = JSON.stringify(matches, null, 2);
    if (output.value !== text) {
      const { selectionStart, selectionEnd, scrollTop } = output;
      output.value = text;
      if (document.activeElement === output) output.setSelectionRange(selectionStart, selectionEnd);
      output.scrollTop = scrollTop;
    }
    status.textContent = `${matches.length} of ${entries.length} pairs shown. ${dropped} older or oversized pairs discarded. Bodies above 64 KiB are truncated.`;
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
      errorNotice.hidden = true;
      errorNotice.textContent = '';
    } catch (error) {
      if (token !== generation) return;
      errorNotice.hidden = false;
      disabled = error.status === 404 || error.status === 403;
      errorNotice.textContent = disabled
        ? 'Local debugging requires LOCAL_DEBUG=true and HOST=127.0.0.1 on a non-production server. Open this page on the same local origin.'
        : `Could not update upstream debug capture: ${error.message}`;
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
    pause.textContent = paused ? 'Resume updates' : 'Pause updates';
    pause.setAttribute('aria-pressed', String(paused));
    stop();
    if (active()) void poll();
  });
  panel.addEventListener('toggle', () => { stop(); if (active()) void poll(); });
  document.addEventListener('visibilitychange', () => { stop(); if (active()) void poll(); });
  render();
  void poll();
}
