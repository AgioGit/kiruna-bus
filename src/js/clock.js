import { store } from './appState.js';

// One-time client/server clock offset so countdowns aren't skewed by the
// visitor's system clock.
export function synchronizeClock(serverTime) {
  const timestamp = Date.parse(serverTime);
  if (Number.isFinite(timestamp)) store.set({ clockOffsetMs: timestamp - Date.now() });
}

export function now() {
  return Date.now() + store.get().clockOffsetMs;
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
