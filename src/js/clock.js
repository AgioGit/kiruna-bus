import { store } from './appState.js';

export const CLOCK_SAMPLE_MAX_AGE = Symbol('clockSampleMaxAge');
let anchorServer = 0;
let anchorMonotonic = 0;
const listeners = new Set();

function anchoredNow(monotonic) {
  return Math.floor(anchorServer + Math.max(0, monotonic - anchorMonotonic));
}

export function subscribeClock(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// An HTTP response header is sampled during the request; its round-trip time
// bounds its age. An SSE or cached timestamp has no such bound, so a backward
// sample is ambiguous and cannot safely correct the clock.
export function synchronizeClock(serverTime, { maxAgeMs } = {}) {
  const timestamp = Date.parse(serverTime);
  if (!Number.isFinite(timestamp)) return;
  const monotonic = performance.now();
  const state = store.get();
  const synchronizedNow = state.clockSynchronized ? anchoredNow(monotonic) : timestamp;
  let corrected = Math.max(timestamp, synchronizedNow);
  if (Number.isFinite(maxAgeMs) && maxAgeMs >= 0 && timestamp < synchronizedNow) {
    corrected = Math.min(synchronizedNow, timestamp + maxAgeMs);
  }
  anchorServer = corrected;
  anchorMonotonic = monotonic;
  store.set({ clockOffsetMs: corrected - Date.now(), clockSynchronized: true });
  for (const listener of listeners) listener();
}

export function now() {
  const state = store.get();
  return state.clockSynchronized ? anchoredNow(performance.now()) : Date.now() + state.clockOffsetMs;
}

const STOCKHOLM_TZ = 'Europe/Stockholm';

// Times are formatted (and delays computed) from parsed instants, never from
// display strings, and pinned to Europe/Stockholm regardless of the
// visitor's own timezone.
export function formatTime(isoString) {
  if (!isoString) return '—';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: STOCKHOLM_TZ,
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function minutesUntil(isoString) {
  if (!isoString) return null;
  const target = new Date(isoString).getTime();
  if (Number.isNaN(target)) return null;
  return Math.round((target - now()) / 60000);
}
