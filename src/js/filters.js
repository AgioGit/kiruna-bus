import { store } from './appState.js';
import { isLineEnabledByDefault } from './lineProperties.js';
import { ensureLineRouteDiscovered } from './routes.js';

const STORAGE_KEY = 'kiruna-bus-tracker.lineFilters.v1';
let preferences;

function linePreferences() {
  if (preferences) return preferences;
  preferences = new Map();
  if (typeof window === 'undefined') return preferences;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return preferences;
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new TypeError('Invalid saved line filters');
    for (const [key, enabled] of Object.entries(saved)) {
      const id = Number(key);
      if (Number.isSafeInteger(id) && id > 0 && String(id) === key && typeof enabled === 'boolean') preferences.set(id, enabled);
    }
  } catch (error) {
    console.warn('Line filters could not be loaded from browser storage.', error);
  }
  return preferences;
}

export function addActiveLineIds(activeLineIds, newLines) {
  const next = new Set(activeLineIds);
  for (const { id } of newLines) {
    if (linePreferences().get(id) ?? isLineEnabledByDefault(id)) next.add(id);
    else next.delete(id);
  }
  return next;
}

// Toggling never triggers a calls/vehicles refetch by itself - it only
// changes which cached data renders. The one exception: enabling a line
// whose route geometry is still unknown kicks off a lazy discovery probe.
export function toggleLine(lineId) {
  const { activeLineIds } = store.get();
  const next = new Set(activeLineIds);
  const enabled = !next.has(lineId);
  if (enabled) next.add(lineId);
  else next.delete(lineId);
  linePreferences().set(lineId, enabled);
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(linePreferences())));
    } catch (error) {
      console.warn('Line filters could not be saved to browser storage.', error);
    }
  }
  store.set({ activeLineIds: next });
  if (enabled) void ensureLineRouteDiscovered(lineId);
}

export function isLineActive(lineId) {
  return store.get().activeLineIds.has(lineId);
}
