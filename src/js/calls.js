import { api } from './api.js';
import { store } from './appState.js';
import { recordRouteIdsFromCalls } from './routes.js';

let expiryTimer;
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

  // Feed any newly-seen routeIds into the lazy route-geometry cache.
  recordRouteIdsFromCalls(flat);

  store.set({
    calls: flat,
    isCallsLoading: false,
    isStopCancelled: !!resp.isStopCancelled,
    messages: resp.messages ?? [],
    departuresUpdatedAt: resp.updatedAt,
    errors: { ...store.get().errors, calls: resp.state === 'stale' ? `Cached departures from ${resp.updatedAt}; live refresh unavailable.` : null },
  });
  clearTimeout(expiryTimer);
  const updatedAt = Date.parse(resp.updatedAt);
  const serverTime = Date.parse(resp.serverTime) || Date.now();
  if (Number.isFinite(updatedAt)) {
    expiryTimer = setTimeout(() => {
      if (store.get().stopSelectionSeq !== sequence) return;
      store.set({
        calls: [], isCallsLoading: false,
        errors: { ...store.get().errors, calls: 'Cached departures have expired. Live departures are unavailable.' },
      });
    }, Math.max(0, updatedAt + 180000 - serverTime) + 1);
    expiryTimer?.unref?.();
  }
  return flat;
}
