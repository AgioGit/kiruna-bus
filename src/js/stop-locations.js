import { api } from './api.js';
import { store } from './appState.js';

// Stop coordinates (GetStopAreas omits them) are resolved once by the server.
// Stops don't move, so this loads once and is never refreshed.
export async function refreshStopLocations({ signal, isCurrent = () => true } = {}) {
  if (store.get().stopLocations.size) return;
  const stops = await api.getStops({ signal });
  if (signal?.aborted || !isCurrent()) return;
  const stopLocations = new Map();
  for (const stop of stops) {
    if (stop.location) stopLocations.set(stop.id, { text: stop.text, location: stop.location });
  }
  store.set({ stopLocations, errors: { ...store.get().errors, stops: null } });
}
