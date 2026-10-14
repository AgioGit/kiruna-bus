import { api } from './api.js';
import { store } from './appState.js';
import { onStopSelected, onStopDeselected } from './poller.js';

const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 300;

let debounceTimer = null;
let autocompleteAbort = null;
let requestSeq = 0;
let selectionRequest = 0;

// Debounced, stale-response-guarded autocomplete search.
export function searchStops(query, onResults) {
  if (store.get().errors.stopNotFound) store.set({ errors: { ...store.get().errors, stopNotFound: null } });
  clearTimeout(debounceTimer);
  requestSeq += 1;
  autocompleteAbort?.abort();
  autocompleteAbort = null;
  if (!query || query.trim().length < MIN_QUERY_LENGTH) {
    onResults([]);
    return;
  }
  debounceTimer = setTimeout(async () => {
    const mySeq = ++requestSeq;
    autocompleteAbort?.abort();
    autocompleteAbort = new AbortController();
    try {
      const results = await api.autocomplete(query.trim(), { signal: autocompleteAbort.signal });
      if (mySeq !== requestSeq) return; // a newer keystroke already superseded this
      store.set({ errors: { ...store.get().errors, stopNotFound: null } });
      onResults(results ?? []);
    } catch (err) {
      if (err.name === 'AbortError' || mySeq !== requestSeq) return;
      store.set({ errors: { ...store.get().errors, stopNotFound: `Stop search failed: ${err.message}` } });
      onResults([]);
    }
  }, DEBOUNCE_MS);
}

// Cancels any pending/in-flight autocomplete lookup. Used when a stop gets
// selected some other way (map click, map circle, clear button) so a
// debounced search started before that selection can't repopulate the
// suggestion list afterwards.
export function cancelStopSearch() {
  clearTimeout(debounceTimer);
  debounceTimer = null;
  requestSeq += 1;
  autocompleteAbort?.abort();
  autocompleteAbort = null;
}

export async function selectStopByText(stopText) {
  const request = ++selectionRequest;
  const selectionSeq = store.get().stopSelectionSeq;
  if (store.get().errors.stopNotFound) store.set({ errors: { ...store.get().errors, stopNotFound: null } });
  let stop;
  try {
    stop = await api.findStopArea(stopText);
  } catch (err) {
    if (request === selectionRequest && selectionSeq === store.get().stopSelectionSeq) store.set({ errors: { ...store.get().errors, stopNotFound: err.message } });
    return null;
  }
  if (request !== selectionRequest || store.get().stopSelectionSeq !== selectionSeq) return null;
  if (!stop) {
    store.set({ errors: { ...store.get().errors, stopNotFound: `Stop "${stopText}" was not found.` } });
    return null;
  }
  selectStopArea(stop);
  return stop;
}

export async function selectStopsNearLocation(coordinate) {
  return api.findStopsNearLocation(coordinate, { maxCount: 5 });
}

export function selectStopArea(stop) {
  selectionRequest++;
  store.set((state) => ({
    selectedStop: stop,
    stopSelectionSeq: state.stopSelectionSeq + 1,
    calls: [],
    messages: [],
    isStopCancelled: false,
    isCallsLoading: true,
    errors: { ...state.errors, calls: null, stopNotFound: null },
  }));
  onStopSelected();
}

export function clearSelectedStop() {
  selectionRequest++;
  store.set((state) => ({
    selectedStop: null, stopSelectionSeq: state.stopSelectionSeq + 1,
    errors: { ...state.errors, calls: null, stopNotFound: null },
  }));
  onStopDeselected();
}
