import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setMaxListeners } from 'node:events';
import { AppError } from './errors.js';
import { canonicalJson } from './boreal.js';
import { runPooled, withSignal } from './pool.js';
import { validate } from './validation.js';
import { correctLkabBoundRoute, LKAB_BOUND_ROUTE_ID, LKAB_RETURN_ROUTE_ID } from './routeCorrections.js';

const point = ({ lat, lon }) => ({ lat, lon });
const lineDto = ({ id, text }) => ({ id, text });
const stopDto = ({ id, text, location }) => ({ id, text, location: point(location) });
export const routeDto = (route) => ({ locations: route.locations.map(point) });

export function sealCatalog(data) {
  const version = createHash('sha256').update(canonicalJson(data)).digest('hex');
  return validateCatalog({ ...data, version });
}

export function validateCatalog(catalog) {
  validate('catalog', catalog);
  const lines = new Set(catalog.lines.map((line) => line.id));
  if (lines.size !== catalog.lines.length || new Set(catalog.stops.map((stop) => stop.id)).size !== catalog.stops.length) {
    throw new Error('Catalog contains duplicate identifiers');
  }
  for (const line of catalog.lines) {
    const ids = catalog.lineRoutes[line.id];
    if (!ids?.length || ids.some((id) => !catalog.routes[id])) throw new Error(`Missing route coverage for line ${line.id}`);
  }
  for (const id of Object.keys(catalog.lineRoutes)) {
    if (!lines.has(Number(id))) throw new Error('Catalog references an unknown line');
  }
  return catalog;
}

export function loadCatalog(file) {
  return validateCatalog(JSON.parse(readFileSync(file, 'utf8')));
}

export async function captureCatalog({ api, previous, signal, acceptRemovals = false, now = Date.now }) {
  if (signal) setMaxListeners(32, signal); // Eight workers each have bounded queue/wait cancellation listeners.
  const options = { signal, priority: 'background' };
  const [config, rawLines] = await withSignal(Promise.all([api.getConfig(options), api.getLines(options)]), signal);
  const lines = validate('lines', rawLines, { upstream: true }).map(lineDto);
  const areas = await runPooled(lines, 8, (line) => api.getStopAreas(line.id, options), { signal });
  const failedArea = areas.find((result) => result.status === 'rejected');
  if (failedArea) throw failedArea.reason;
  const byId = new Map(areas.flatMap((result) => result.value).map((stop) => [stop.id, stop]));
  const located = await runPooled([...byId.values()], 8, async (stop) => {
    const found = await api.findStopArea(stop.text, options);
    return stopDto(validate('locatedStop', { ...stop, location: found?.location }, { upstream: true }));
  }, { signal });
  const failed = located.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
  const stops = located.map((result) => result.value);
  if (previous && !acceptRemovals) {
    if (previous.lines.some((line) => !lines.some((next) => next.id === line.id))
      || previous.stops.some((stop) => !byId.has(stop.id))) {
      throw new Error('Catalog coverage decreased; review removals before using --accept-removals');
    }
  }
  const calls = await runPooled(stops, 8, (stop) => api.getCalls(stop.text, options), { signal });
  const failedCalls = calls.find((result) => result.status === 'rejected');
  if (failedCalls) throw failedCalls.reason;
  const lineRoutes = Object.fromEntries(lines.map((line) => [line.id, new Set(previous?.lineRoutes[line.id] ?? [])]));
  for (const response of calls) {
    for (const call of response.value.calls.flatMap((group) => group.calls)) {
      if (call.routeId && lineRoutes[call.lineId]) lineRoutes[call.lineId].add(call.routeId);
    }
  }
  const ids = [...new Set(Object.values(lineRoutes).flatMap((set) => [...set]))];
  if (ids.includes(LKAB_BOUND_ROUTE_ID) && !ids.includes(LKAB_RETURN_ROUTE_ID)) ids.push(LKAB_RETURN_ROUTE_ID);
  if (ids.length > 256) throw new Error('Catalog route limit exceeded; review obsolete route associations');
  const shapes = await runPooled(ids, 8, async (id) => [id, routeDto(validate('route', await api.getMapRoute(id, options), { upstream: true }))], { signal });
  const failedShape = shapes.find((result) => result.status === 'rejected');
  if (failedShape) throw failedShape.reason;
  const routes = Object.fromEntries(shapes.map((result) => result.value));
  if (routes[LKAB_BOUND_ROUTE_ID]) {
    routes[LKAB_BOUND_ROUTE_ID] = correctLkabBoundRoute(routes[LKAB_BOUND_ROUTE_ID], routes[LKAB_RETURN_ROUTE_ID]);
  }
  signal?.throwIfAborted();
  return sealCatalog({
    schemaVersion: 1, capturedAt: new Date(now()).toISOString(), provenance: 'Boreal AnyRide; validated basic-data capture',
    config: validate('mapConfig', { minZoom: config.minZoom, tiles: { urlTemplate: config.tiles?.urlTemplate } }),
    lines, stops, lineRoutes: Object.fromEntries(Object.entries(lineRoutes).map(([id, set]) => [id, [...set].sort((a, b) => a - b)])), routes,
  });
}

export function createCatalog({ snapshot, api, telemetry, now = Date.now, refreshTimeoutMs = 60000 }) {
  let current = validateCatalog(snapshot);
  let source = 'bundled';
  let nextRefresh = 0;
  let refreshing;
  const shutdown = new AbortController();
  const dynamicRoutes = new Map();
  return {
    get: () => current,
    bootstrap: () => ({ catalog: current, source, serverTime: new Date(now()).toISOString() }),
    async refresh() {
      if (!refreshing && now() >= nextRefresh && !shutdown.signal.aborted) {
        nextRefresh = now() + 3600000;
        refreshing = captureCatalog({
          api, previous: current, now,
          signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(refreshTimeoutMs)]),
        }).then((catalog) => { current = catalog; source = 'upstream'; dynamicRoutes.clear(); })
          .catch((error) => {
            nextRefresh = now() + 60000;
            telemetry?.count('catalogFailures');
            telemetry?.log('catalog_refresh_failed', { code: error.code ?? error.name });
          }).finally(() => { refreshing = null; });
      }
      return refreshing;
    },
    async route(id) {
      const known = current.routes[id] ?? dynamicRoutes.get(id);
      if (known) return known;
      let route = routeDto(await api.getMapRoute(id));
      if (id === LKAB_BOUND_ROUTE_ID) route = correctLkabBoundRoute(route, await api.getMapRoute(LKAB_RETURN_ROUTE_ID));
      if (dynamicRoutes.size >= 256) dynamicRoutes.delete(dynamicRoutes.keys().next().value);
      dynamicRoutes.set(id, route);
      return route;
    },
    stop(id) {
      const stop = current.stops.find((entry) => entry.id === id);
      if (!stop) throw new AppError('STOP_NOT_FOUND', 'That stop is not in the current catalog.', { status: 404 });
      return stop;
    },
    close: () => shutdown.abort(new DOMException('Server shutting down', 'AbortError')),
  };
}
