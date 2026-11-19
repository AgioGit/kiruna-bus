import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setMaxListeners } from 'node:events';
import { AppError } from './errors.js';
import { canonicalJson } from './boreal.js';
import { runPooled } from './pool.js';
import { TtlCache } from './cache.js';
import { validate } from './validation.js';
import { correctLkabBoundRoute, LKAB_BOUND_ROUTE_ID, LKAB_RETURN_ROUTE_ID } from './routeCorrections.js';

const point = ({ lat, lon }) => ({ lat, lon });
const lineDto = ({ id, text }) => ({ id, text });
const stopDto = ({ id, text, location }) => ({ id, text, location: point(location) });
export const routeDto = (route) => ({ locations: route.locations.map(point) });
const MAX_STOPS = 1000;
const MAX_ROUTES = 256;

export function sealCatalog(data) {
  // Content hash excludes capturedAt: an unchanged successful check (same
  // lines/stops/routes/config) must not mint a new catalog version just
  // because it ran at a different time.
  const { capturedAt, ...content } = data;
  const version = createHash('sha256').update(canonicalJson(content)).digest('hex');
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
    // Stops and line metadata can exist before an upcoming call exposes a route ID.
    if (!ids || ids.some((id) => !Object.hasOwn(catalog.routes, id))) throw new Error(`Missing route coverage for line ${line.id}`);
  }
  for (const id of Object.keys(catalog.lineRoutes)) {
    if (!lines.has(Number(id))) throw new Error('Catalog references an unknown line');
  }
  return catalog;
}

export function loadCatalog(file) {
  return validateCatalog(JSON.parse(readFileSync(file, 'utf8')));
}

export async function captureCatalog({
  api, previous, signal, acceptRemovals = false, now = Date.now, fresh = false, lineRoutes: suppliedLineRoutes,
  onDegraded, shutdownSignal,
}) {
  if (signal) setMaxListeners(32, signal); // Eight workers each have bounded queue/wait cancellation listeners.
  const options = { signal, priority: 'background', fresh };
  const runtime = Boolean(onDegraded);
  const pool = { signal, keepPartial: runtime };
  const issues = { config: 0, lines: 0, stopLists: 0, missingStops: 0, stopLocations: 0, calls: 0, shapes: 0, capacity: 0 };
  const [configResult, lineResult] = await runPooled([
    async () => {
      const { minZoom, tiles } = await api.getConfig(options);
      return validate('mapConfig', { minZoom, tiles: { urlTemplate: tiles?.urlTemplate } });
    },
    async () => validate('lines', await api.getLines(options), { upstream: true }).map(lineDto),
  ], 2, (read) => read(), pool);
  if (configResult.status === 'rejected' && !runtime) throw configResult.reason;
  if (lineResult.status === 'rejected' && !runtime) throw lineResult.reason;
  issues.config = Number(configResult.status === 'rejected');
  issues.lines = Number(lineResult.status === 'rejected');
  const config = configResult.value ?? previous.config;
  const currentLines = lineResult.value ?? previous.lines;
  // GetLines is day-dependent. Recheck previously validated lines' stops,
  // rather than interpreting their absence today as a catalog deletion.
  const lines = acceptRemovals ? currentLines : [...currentLines,
    ...(previous?.lines ?? []).filter((line) => !currentLines.some((item) => item.id === line.id))];
  const areas = await runPooled(lines, 8, (line) => api.getStopAreas(line.id, options), pool);
  const areaFailures = areas.filter((result) => result.status === 'rejected');
  if (areaFailures.length && (!runtime || (issues.lines && issues.config && areaFailures.length === areas.length))) throw areaFailures[0].reason;
  issues.stopLists = areaFailures.length;
  const byId = new Map(areas.flatMap((result) => result.value ?? []).map((stop) => [stop.id, stop]));
  const located = await runPooled([...byId.values()], 8, async (stop) => {
    const found = await api.findStopArea(stop.text, options);
    return stopDto(validate('locatedStop', { ...stop, location: found?.location }, { upstream: true }));
  }, pool);
  const locationFailures = located.filter((result) => result.status === 'rejected');
  if (locationFailures.length && !onDegraded) throw locationFailures[0].reason;
  issues.stopLocations = locationFailures.length;
  issues.missingStops = previous?.stops.filter((stop) => !byId.has(stop.id)).length ?? 0;
  if (issues.missingStops && !acceptRemovals && !onDegraded) {
    throw new Error('Catalog coverage decreased; review removals before using --accept-removals');
  }
  const stopsById = new Map(onDegraded ? previous.stops.map((stop) => [stop.id, stop]) : []);
  for (const { value } of located) {
    if (!value) continue;
    if (onDegraded && !stopsById.has(value.id) && stopsById.size >= MAX_STOPS) issues.capacity++;
    else stopsById.set(value.id, value);
  }
  const stops = [...stopsById.values()];
  const lineRoutes = Object.fromEntries(lines.map((line) => [line.id, new Set(previous?.lineRoutes[line.id] ?? [])]));
  if (suppliedLineRoutes) {
    // Consume call/route associations already collected by the shared live
    // collector instead of re-scanning every stop's GetCalls here too.
    for (const [lineId, routeIds] of Object.entries(suppliedLineRoutes)) {
      if (!lineRoutes[lineId]) continue;
      for (const routeId of routeIds) lineRoutes[lineId].add(routeId);
    }
    const previousStops = new Set(previous?.stops.map((stop) => stop.id));
    const newStops = stops.filter((stop) => !previousStops.has(stop.id));
    if (newStops.length) {
      const results = await runPooled(newStops, 8, (stop) => api.getCalls(stop.text, options), pool);
      const failures = results.filter((result) => result.status === 'rejected');
      if (failures.length && !onDegraded) throw failures[0].reason;
      issues.calls = failures.length;
      for (const result of results) {
        if (result.status === 'rejected') continue;
        for (const call of result.value.calls.flatMap((group) => group.calls)) {
          if (call.routeId && lineRoutes[call.lineId]) lineRoutes[call.lineId].add(call.routeId);
        }
      }
    }
  } else {
    const calls = await runPooled(stops, 8, (stop) => api.getCalls(stop.text, options), { signal });
    const failedCalls = calls.find((result) => result.status === 'rejected');
    if (failedCalls) throw failedCalls.reason;
    for (const response of calls) {
      for (const call of response.value.calls.flatMap((group) => group.calls)) {
        if (call.routeId && lineRoutes[call.lineId]) lineRoutes[call.lineId].add(call.routeId);
      }
    }
  }
  let ids = [...new Set([
    ...(runtime ? Object.keys(previous.routes).map(Number) : []),
    ...Object.values(lineRoutes).flatMap((set) => [...set]),
  ])];
  if (ids.includes(LKAB_BOUND_ROUTE_ID) && !ids.includes(LKAB_RETURN_ROUTE_ID)) ids.push(LKAB_RETURN_ROUTE_ID);
  if (ids.length > MAX_ROUTES) {
    if (!onDegraded) throw new Error('Catalog route limit exceeded; review obsolete route associations');
    issues.capacity += ids.length - MAX_ROUTES;
    ids.sort((a, b) => Number(Object.hasOwn(previous.routes, b)) - Number(Object.hasOwn(previous.routes, a)) || a - b);
    ids = ids.slice(0, MAX_ROUTES);
  }
  const shapes = await runPooled(ids, 8, async (id) => [id, routeDto(validate('route', await api.getMapRoute(id, options), { upstream: true }))], pool);
  const failedShape = shapes.find((result) => result.status === 'rejected');
  if (failedShape && !onDegraded) throw failedShape.reason;
  const fetchedRoutes = Object.fromEntries(shapes.flatMap((result) => result.value ? [result.value] : []));
  issues.shapes = shapes.length - Object.keys(fetchedRoutes).length;
  if (ids.includes(LKAB_BOUND_ROUTE_ID)) {
    try {
      if (!fetchedRoutes[LKAB_BOUND_ROUTE_ID] || !fetchedRoutes[LKAB_RETURN_ROUTE_ID]) throw new Error('Either LKAB route shape is missing.');
      fetchedRoutes[LKAB_BOUND_ROUTE_ID] = correctLkabBoundRoute(fetchedRoutes[LKAB_BOUND_ROUTE_ID], fetchedRoutes[LKAB_RETURN_ROUTE_ID]);
    } catch (error) {
      if (!onDegraded) throw error;
      delete fetchedRoutes[LKAB_BOUND_ROUTE_ID];
      delete fetchedRoutes[LKAB_RETURN_ROUTE_ID];
      issues.shapes = shapes.length - Object.keys(fetchedRoutes).length;
    }
  }
  const routes = Object.fromEntries(ids.flatMap((id) => {
    const shape = fetchedRoutes[id] ?? (onDegraded ? previous.routes[id] : undefined);
    return shape ? [[id, shape]] : [];
  }));
  for (const set of Object.values(lineRoutes)) {
    for (const id of set) if (!Object.hasOwn(routes, id)) set.delete(id);
  }
  (runtime ? shutdownSignal : signal)?.throwIfAborted();
  const catalog = sealCatalog({
    schemaVersion: 1, capturedAt: new Date(now()).toISOString(), provenance: 'Boreal AnyRide; validated basic-data capture',
    config,
    lines, stops, lineRoutes: Object.fromEntries(Object.entries(lineRoutes).map(([id, set]) => [id, [...set].sort((a, b) => a - b)])), routes,
  });
  if (onDegraded && Object.values(issues).some(Boolean)) onDegraded(issues);
  return catalog;
}

export function createCatalog({ snapshot, api, telemetry, now = Date.now, refreshTimeoutMs = 60000 }) {
  let current = validateCatalog(snapshot);
  let source = 'bundled';
  let refreshing;
  const shutdown = new AbortController();
  const dynamicRoutes = new TtlCache({ maxEntries: MAX_ROUTES, now });
  return {
    get: () => current,
    bootstrap: () => ({ catalog: current, source, serverTime: new Date(now()).toISOString() }),
    // Cadence/backoff is entirely owned by the shared collector; this is a
    // single-flight, on-demand capture. `fresh` forces a genuine upstream
    // check bypassing Boreal's opportunistic cache. `lineRoutes` lets the
    // caller (the collector, from the live tracker) supply already-collected
    // call/route associations instead of this doing its own per-stop scan.
    async refresh({ fresh = false, lineRoutes } = {}) {
      if (!refreshing && !shutdown.signal.aborted) {
        let degraded = false;
        refreshing = captureCatalog({
          api, previous: current, now, fresh, lineRoutes: lineRoutes ?? {},
          onDegraded(issues) {
            degraded = true;
            telemetry?.count('catalogDegraded');
            telemetry?.log('catalog_refresh_degraded', issues);
          },
          shutdownSignal: shutdown.signal,
          signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(refreshTimeoutMs)]),
        }).then((catalog) => {
          const changed = catalog.version !== current.version;
          if (changed || !degraded) current = catalog;
          source = degraded ? 'retained' : 'upstream';
          return { changed };
        }).catch((error) => {
          telemetry?.count('catalogFailures');
          telemetry?.log('catalog_refresh_failed', { code: error.code ?? error.name });
          throw error;
        }).finally(() => { refreshing = null; });
      }
      return refreshing ?? Promise.resolve({ changed: false });
    },
    async route(id, { observed = false } = {}) {
      const key = String(id);
      const known = current.routes[id] ?? dynamicRoutes.get(key);
      if (known) return known;
      if (!(typeof observed === 'function' ? observed() : observed)) {
        throw new AppError('ROUTE_NOT_FOUND', 'That route is not in the catalog or recently observed.', { status: 404 });
      }
      const options = { priority: 'public', signal: shutdown.signal };
      let route = routeDto(await api.getMapRoute(id, options));
      if (id === LKAB_BOUND_ROUTE_ID) {
        try { route = correctLkabBoundRoute(route, await api.getMapRoute(LKAB_RETURN_ROUTE_ID, options)); }
        catch (cause) { throw new AppError('ROUTE_GEOMETRY_UNAVAILABLE', 'Corrected route geometry is unavailable.', { status: 502, cause }); }
      }
      dynamicRoutes.set(key, route, 60 * 60 * 1000);
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
