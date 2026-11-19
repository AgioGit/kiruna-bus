import { departureReadState, readDepartures } from './departure-reads.js';
import { store } from './appState.js';
import { addActiveLineIds } from './filters.js';
import { recordRouteIdsFromCalls } from './routes.js';
import { CLOCK_SAMPLE_MAX_AGE, now, subscribeClock, synchronizeClock } from './clock.js';
import { advanceDepartureHistory, effectiveDepartureTime, isPreviousDeparture, observeCalls } from './departure-history.js';
import { message } from './i18n.js';

let freshnessTimer;
let boundaryTimer;
let history = { previous: null, pending: [] };

export function resetSelectedStopCalls() {
  clearTimeout(freshnessTimer);
  clearTimeout(boundaryTimer);
  history = { previous: null, pending: [] };
}

function scheduleFreshness(sequence, freshUntil, expiresAt) {
  clearTimeout(freshnessTimer);
  const elapsed = performance.now();
  const at = freshUntil > elapsed ? Math.min(freshUntil, expiresAt) : expiresAt;
  freshnessTimer = setTimeout(() => {
    if (store.get().stopSelectionSeq !== sequence) return;
    if (performance.now() < expiresAt) {
      if (performance.now() >= freshUntil) store.set({ departuresRetained: true });
      scheduleFreshness(sequence, freshUntil, expiresAt);
      return;
    }
    store.set({
      calls: [], messages: [], isStopCancelled: false, isCallsLoading: false,
      departuresUpdatedAt: null, departuresRetained: false,
      errors: { ...store.get().errors, calls: message('departuresUnavailable') },
    });
  }, Math.max(1, Math.ceil(at - elapsed)));
  freshnessTimer?.unref?.();
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

subscribeClock(updateHistory);
// Fetches GetCalls for the currently selected stop. Empty results are a
// valid "no departures" state, not an error; isStopCancelled/messages are
// surfaced as-is for the UI layer to render.
export async function fetchCallsForSelectedStop({ signal, isCurrent = () => true } = {}) {
  const { selectedStop } = store.get();
  if (!selectedStop) return [];

  const sequence = store.get().stopSelectionSeq;
  const read = await readDepartures(selectedStop.id, { signal });
  if (signal?.aborted || !isCurrent() || store.get().stopSelectionSeq !== sequence
    || store.get().selectedStop?.id !== selectedStop.id) return [];
  const { response: resp, freshUntil, expiresAt } = read;
  const readState = departureReadState(read);
  const available = readState !== 'unavailable';
  const flat = available ? resp.calls : [];
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
  for (const call of [...flat, history.previous?.call, ...history.pending.map((item) => item.call)]) {
    if (!call) continue;
    const { lineId, line } = call;
    if (!Number.isSafeInteger(lineId) || lineId < 1 || typeof line !== 'string' || !line.trim() || knownLines.has(lineId)) continue;
    knownLines.add(lineId);
    newLines.push({ id: lineId, text: line });
  }

  store.set({
    ...(newLines.length ? {
      lines: [...state.lines, ...newLines],
      activeLineIds: addActiveLineIds(state.activeLineIds, newLines),
    } : {}),
    calls: flat,
    previousDeparture: history.previous,
    isCallsLoading: false,
    isStopCancelled: available && !!resp.isStopCancelled,
    messages: available ? resp.messages ?? [] : [],
    departuresUpdatedAt: available ? resp.updatedAt : null,
    departuresRetained: readState === 'stale',
    errors: { ...store.get().errors, calls: available ? null : message('departuresUnavailable') },
  });
  updateHistory();
  if (available) scheduleFreshness(sequence, freshUntil, expiresAt);
  else clearTimeout(freshnessTimer);
  return flat;
}
