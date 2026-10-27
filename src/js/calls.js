import { api } from './api.js';
import { store } from './appState.js';
import { recordRouteIdsFromCalls } from './routes.js';
import { CLOCK_SAMPLE_MAX_AGE, now, subscribeClock, synchronizeClock } from './clock.js';
import { advanceDepartureHistory, effectiveDepartureTime, isPreviousDeparture, observeCalls } from './departure-history.js';

let expiryTimer;
let boundaryTimer;
let expiry = null;
let history = { previous: null, pending: [] };

export function resetSelectedStopCalls() {
  clearTimeout(expiryTimer);
  clearTimeout(boundaryTimer);
  expiry = null;
  history = { previous: null, pending: [] };
}

function scheduleExpiry() {
  clearTimeout(expiryTimer);
  if (!expiry) return;
  const { sequence, at } = expiry;
  expiryTimer = setTimeout(() => {
    if (store.get().stopSelectionSeq !== sequence) return;
    expiry = null;
    store.set({
      calls: [], messages: [], isStopCancelled: false, isCallsLoading: false,
      errors: { ...store.get().errors, calls: 'Cached departures have expired. Live departures are unavailable.' },
    });
  }, Math.max(0, at + 180000 - now()) + 1);
  expiryTimer?.unref?.();
}

function updateHistory() {
  clearTimeout(boundaryTimer);
  if (!store.get().selectedStop) return;
  const time = now();
  history = advanceDepartureHistory(history, [], time);
  if (store.get().previousDeparture !== history.previous) store.set({ previousDeparture: history.previous });
  const next = history.pending[0];
  if (next) {
    boundaryTimer = setTimeout(updateHistory, Math.max(0, effectiveDepartureTime(next.call) - time));
    boundaryTimer?.unref?.();
  }
}

subscribeClock(() => { updateHistory(); scheduleExpiry(); });
// Fetches GetCalls for the currently selected stop. Empty results are a
// valid "no departures" state, not an error; isStopCancelled/messages are
// surfaced as-is for the UI layer to render.
export async function fetchCallsForSelectedStop({ signal, isCurrent = () => true } = {}) {
  const { selectedStop } = store.get();
  if (!selectedStop) return [];

  const sequence = store.get().stopSelectionSeq;
  const resp = await api.getCalls({ stopId: selectedStop.id }, { signal });
  if (signal?.aborted || !isCurrent() || store.get().stopSelectionSeq !== sequence
    || store.get().selectedStop?.id !== selectedStop.id) return [];
  const flat = resp.calls;
  synchronizeClock(resp.serverTime, { maxAgeMs: resp[CLOCK_SAMPLE_MAX_AGE] });
  const observations = [
    ...(isPreviousDeparture(resp.previousDeparture) ? [resp.previousDeparture] : []),
    ...(Array.isArray(resp.pendingDepartures) ? resp.pendingDepartures.filter(isPreviousDeparture).slice(0, 64) : []),
    ...observeCalls(flat, resp.messages, resp.isStopCancelled, resp.updatedAt),
  ];
  history = advanceDepartureHistory(history, observations, now());

  // Feed any newly-seen routeIds into the lazy route-geometry cache.
  recordRouteIdsFromCalls(flat);

  const state = store.get();
  const knownLines = new Set(state.lines.map((line) => line.id));
  const newLines = [];
  for (const item of [history.previous, ...history.pending]) {
    if (!isPreviousDeparture(item)) continue;
    const { lineId, line } = item.call;
    if (!Number.isSafeInteger(lineId) || lineId < 1 || !line.trim() || knownLines.has(lineId)) continue;
    knownLines.add(lineId);
    newLines.push({ id: lineId, text: line });
  }

  store.set({
    ...(newLines.length ? {
      lines: [...state.lines, ...newLines],
      activeLineIds: new Set([...state.activeLineIds, ...newLines.map((line) => line.id)]),
    } : {}),
    calls: flat,
    previousDeparture: history.previous,
    isCallsLoading: false,
    isStopCancelled: !!resp.isStopCancelled,
    messages: resp.messages ?? [],
    departuresUpdatedAt: resp.updatedAt,
    errors: { ...store.get().errors, calls: resp.state === 'unavailable'
      ? 'Live departures are unavailable.'
      : resp.state === 'stale' ? `Cached departures from ${resp.updatedAt}; live refresh unavailable.` : null },
  });
  updateHistory();
  const updatedAt = Date.parse(resp.updatedAt);
  expiry = Number.isFinite(updatedAt) && resp.state !== 'unavailable' ? { sequence, at: updatedAt } : null;
  scheduleExpiry();
  return flat;
}
