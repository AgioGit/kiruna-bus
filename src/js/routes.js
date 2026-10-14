import { api } from './api.js';
import { store } from './appState.js';

const geometryRequests = new Map();

export function mergeLineRoutes(serverLineRoutes) {
  recordRouteIdsFromCalls(Object.entries(serverLineRoutes ?? {}).flatMap(([lineId, routeIds]) =>
    routeIds.map((routeId) => ({ lineId: Number(lineId), routeId }))));
}

export function recordRouteIdsFromCalls(calls) {
  const state = store.get();
  const lineRoutes = new Map(state.lineRoutes);
  let changed = false;
  for (const call of calls) {
    if (!call.routeId) continue;
    const ids = new Set(lineRoutes.get(call.lineId) ?? []);
    if (!ids.has(call.routeId)) {
      ids.add(call.routeId);
      lineRoutes.set(call.lineId, ids);
      changed = true;
    }
    if (!state.routeGeometry.has(call.routeId) && !geometryRequests.has(call.routeId)) {
      const pending = api.getMapRoute(call.routeId).then((route) => {
        if (![...store.get().lineRoutes.values()].some((ids) => ids.has(call.routeId))) return;
        const next = new Map(store.get().routeGeometry);
        next.set(call.routeId, route);
        store.set({ routeGeometry: next, errors: { ...store.get().errors, routes: null } });
      }).catch((error) => {
        if ([...store.get().lineRoutes.values()].some((ids) => ids.has(call.routeId))) store.set({ errors: { ...store.get().errors, routes: error.message } });
      }).finally(() => geometryRequests.delete(call.routeId));
      geometryRequests.set(call.routeId, pending);
    }
  }
  if (changed) store.set({ lineRoutes });
}

export async function ensureLineRouteDiscovered(lineId) {
  const ids = store.get().lineRoutes.get(lineId);
  if (ids?.size) recordRouteIdsFromCalls([...ids].map((routeId) => ({ lineId, routeId })));
}
