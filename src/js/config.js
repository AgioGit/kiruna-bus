import { api, ApiError } from './api.js';
import { store } from './appState.js';
import { isCatalog, readCachedCatalog, writeCachedCatalog } from './catalog-cache.js';
import { CLOCK_SAMPLE_MAX_AGE, synchronizeClock } from './clock.js';
import { clearSelectedStop } from './stops.js';

let current = null;
let lastAttempt = -Infinity;
let configOptions = { minZoom: 10, tiles: { urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png' } };

function storageError(error) {
  console.warn('Basic-information cache unavailable:', error.message);
  store.set({ errors: { ...store.get().errors, cache: 'Browser cache unavailable; using server-provided basic information.' } });
}

export function applyCatalog(catalog, source) {
  if (!isCatalog(catalog)) throw new ApiError('Basic map information is invalid.', { code: 'INVALID_CATALOG' });
  if (current && Date.parse(catalog.capturedAt) < Date.parse(current.capturedAt)) return false;
  const changed = current?.version !== catalog.version;
  current = catalog;
  configOptions = catalog.config;
  const state = store.get();
  const knownLines = new Set(state.lines.map((line) => line.id));
  const lines = [...catalog.lines, ...state.lines.filter((line) => !catalog.lines.some((item) => item.id === line.id))];
  const activeLineIds = new Set(lines.filter((line) => !knownLines.has(line.id) || state.activeLineIds.has(line.id)).map((line) => line.id));
  const lineRoutes = new Map([...state.lineRoutes].map(([id, ids]) => [id, new Set(ids)]));
  for (const [id, routes] of Object.entries(catalog.lineRoutes)) {
    const ids = lineRoutes.get(Number(id)) ?? new Set();
    routes.forEach((routeId) => ids.add(routeId));
    lineRoutes.set(Number(id), ids);
  }
  const selectedStop = state.selectedStop ? catalog.stops.find((stop) => stop.id === state.selectedStop.id) : null;
  if (state.selectedStop && !selectedStop) clearSelectedStop();
  store.set({
    ...(changed ? {
      lines, activeLineIds,
      stopLocations: new Map(catalog.stops.map((stop) => [stop.id, { text: stop.text, location: stop.location }])),
      lineRoutes,
      routeGeometry: new Map([...state.routeGeometry, ...Object.entries(catalog.routes).map(([id, route]) => [Number(id), route])]),
      ...(selectedStop ? { selectedStop } : {}),
    } : {}),
    catalogInfo: { source, capturedAt: catalog.capturedAt, version: catalog.version },
    errors: { ...store.get().errors, config: null, stops: null, lines: null },
  });
  return true;
}

export async function refreshBootstrap({ signal, isCurrent = () => true, force = false } = {}) {
  if (!force && Date.now() - lastAttempt < 60000) return;
  lastAttempt = Date.now();
  const data = await api.getBootstrap({ signal, timeoutMs: 5000 });
  if (signal?.aborted || !isCurrent()) return;
  if (!isCatalog(data?.catalog)) throw new ApiError('Basic map information is invalid.', { code: 'INVALID_CATALOG' });
  synchronizeClock(data.serverTime, { maxAgeMs: data[CLOCK_SAMPLE_MAX_AGE] });
  if (applyCatalog(data.catalog, data.source)) await writeCachedCatalog(data.catalog).catch(storageError);
  return data;
}

export async function loadConfig() {
  let cached;
  try { cached = await readCachedCatalog(); }
  catch (error) { storageError(error); }
  if (cached) {
    applyCatalog(cached, 'browser');
    void refreshBootstrap({ force: true }).catch((error) => {
      store.set({ errors: { ...store.get().errors, config: error.message } });
    });
  } else {
    await refreshBootstrap({ force: true });
  }
  return configOptions;
}

export function getConfig() { return configOptions; }
