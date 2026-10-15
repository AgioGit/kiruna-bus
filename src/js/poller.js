import { store } from './appState.js';
import { apiBase } from './api.js';
import { fetchCallsForSelectedStop } from './calls.js';
import { acceptBusesSnapshot, refreshLiveVehicles } from './live-vehicles.js';
import { isValidTrackingStatus, classifyRevision, acceptRevision } from './tracking.js';
import { refreshStopLocations } from './stop-locations.js';
import { refreshBootstrap } from './config.js';

// A visible tab opens one SSE connection (GET /api/v1/stream) that receives
// a full buses snapshot every dynamic collector cycle (~30s) plus
// 'tracking-status' events when no live picture is available, and otherwise
// stays silent but for a heartbeat comment every ~15s (not a client-visible
// event). WATCHDOG_MS is how long we tolerate a connection producing no
// *valid* snapshot/duplicate evidence before treating it as stuck: on fire we
// fetch the cached /buses once as a fallback (then re-arm on success, back
// off on failure) and force a bounded stream reconnect, without ever running
// two EventSource instances at once.
const WATCHDOG_MS = 60000;

let eventSource = null;
let streamGeneration = 0;
let watchdogTimer = null;
let fallbackTimer = null;
let liveAbort = null;
let callsTimer, callsAbort;
let callsGeneration = 0;
let liveFailures = 0, callsFailures = 0;
let paused = false, initialized = false;
let connected = false, nextFallbackAt = null;
let catalogRefreshPromise = null;
let lifecycleAbort = null, basicRecoveryTimer = null;
let lastFetchedCatalogVersion = null;
let deliveries = 0;

export function getLiveVehiclesSchedule() { return { connected, nextFallbackAt }; }

export function failureDelay(failures, retryAfter, random = Math.random) {
  return Math.min(300000, Math.max(retryAfter ?? 0, Math.min(300000, 5000 * 2 ** Math.min(failures - 1, 6)) * (1 + random() * 0.2)));
}

function clearWatchdog() {
  clearTimeout(watchdogTimer);
  watchdogTimer = null;
}

function clearFallbackTimer() {
  clearTimeout(fallbackTimer);
  fallbackTimer = null;
}

function armWatchdog(token) {
  clearWatchdog();
  clearFallbackTimer();
  watchdogTimer = setTimeout(() => onWatchdogFired(token), WATCHDOG_MS);
  watchdogTimer?.unref?.();
  nextFallbackAt = Date.now() + WATCHDOG_MS;
}

function closeStream() {
  eventSource?.close();
  eventSource = null;
  connected = false;
}

// Fetches the bootstrap bundle when a snapshot/status reports a different
// catalogVersion than what's currently applied. The in-flight guard
// coalesces multiple triggers referencing the same new version into a
// single request; applyCatalog's own content-hash check settles any race.
function maybeRefreshCatalog(data) {
  const needsRecovery = !store.get().catalogInfo || Boolean(store.get().errors.config);
  if (!needsRecovery && (!data.catalogVersion || store.get().catalogInfo.version === data.catalogVersion
    || lastFetchedCatalogVersion === data.catalogVersion)) return;
  if (catalogRefreshPromise) return;
  const signal = lifecycleAbort?.signal;
  const isCurrent = () => !paused && !signal?.aborted;
  const pending = refreshBootstrap({ force: true, signal, isCurrent })
    .then((result) => {
      if (isCurrent()) lastFetchedCatalogVersion = result?.catalog.version ?? null;
    })
    .catch((error) => {
      if (!isCurrent()) return;
      store.set({ errors: { ...store.get().errors, config: error.message } });
      clearTimeout(basicRecoveryTimer);
      basicRecoveryTimer = setTimeout(() => maybeRefreshCatalog(data), WATCHDOG_MS);
      basicRecoveryTimer?.unref?.();
    })
    .finally(() => { if (catalogRefreshPromise === pending) catalogRefreshPromise = null; });
  catalogRefreshPromise = pending;
}

// A stop remains selected across dynamic cycles: refetch its departures
// after a genuinely new revision (not a duplicate/stale one), so the server's
// shared calls cache is re-read without piling up overlapping requests.
function maybeRefreshSelectedStop() {
  if (paused || !store.get().selectedStop || callsAbort) return;
  clearTimeout(callsTimer);
  void fetchCallsOnce(callsGeneration);
}

// Applies one already-JSON-parsed buses DTO (from a stream 'buses' event or
// an HTTP fallback read) through the shared epoch/revision gate, then wires
// the catalog/selected-stop follow-up triggers. Returns the classification
// so the stream listener knows whether it counts as delivery-watchdog
// evidence.
function handleBusesPayload(data) {
  const { outcome } = acceptBusesSnapshot(data);
  if (outcome === 'invalid') {
    store.set({ errors: { ...store.get().errors, vehicles: 'The server returned invalid live data.' } });
  }
  return afterSnapshot(data, outcome);
}

function afterSnapshot(data, outcome) {
  if (outcome === 'invalid' || outcome === 'stale') return outcome;
  deliveries++;
  liveFailures = 0;
  maybeRefreshCatalog(data);
  if (outcome !== 'duplicate') maybeRefreshSelectedStop();
  return outcome;
}

function handleTrackingStatusPayload(data) {
  if (!isValidTrackingStatus(data)) {
    store.set({ errors: { ...store.get().errors, vehicles: 'The server returned invalid tracking status.' } });
    return 'invalid';
  }
  const outcome = classifyRevision(data);
  if (outcome === 'stale') return outcome;
  acceptRevision(data);
  deliveries++;
  store.set({
    liveQuality: data.quality ?? { state: 'unavailable', reasons: [] },
    errors: { ...store.get().errors, vehicles: data.error?.message ?? null },
  });
  maybeRefreshCatalog(data);
  if (outcome !== 'duplicate') maybeRefreshSelectedStop();
  return outcome;
}

async function onWatchdogFired(token) {
  if (token !== streamGeneration || paused) return;
  clearWatchdog(); // this firing consumed the timer
  // Bounded reconnect up front: exactly one fresh EventSource per watchdog
  // fire (handles a silently stuck stream - heartbeats but no data, no
  // error), never two connections at once. Bumping the generation first
  // means the fallback fetch below (and its failure-retry timer) targets the
  // generation that will still be current, instead of one we're about to
  // abandon.
  streamGeneration++;
  const next = streamGeneration;
  closeStream();
  openStream(next); // arms its own fresh watchdog immediately

  const controller = new AbortController();
  liveAbort = controller;
  const signal = controller.signal;
  const isCurrent = () => !signal.aborted && !paused && next === streamGeneration;
  const startedAtDelivery = deliveries;
  try {
    const { outcome, data } = await refreshLiveVehicles({ signal, isCurrent });
    if (!isCurrent()) return;
    if (outcome !== 'aborted') {
      if (data) afterSnapshot(data, outcome);
      if (outcome === 'newer' || outcome === 'new-epoch' || outcome === 'duplicate') armWatchdog(next);
    }
  } catch (error) {
    if (isCurrent() && error.name !== 'AbortError' && deliveries === startedAtDelivery) {
      const wait = failureDelay(++liveFailures, error.retryAfter);
      store.set({
        liveQuality: { ...(store.get().liveQuality ?? {}), state: 'unavailable' },
        errors: { ...store.get().errors, vehicles: error.message },
      });
      nextFallbackAt = Date.now() + wait;
      clearWatchdog();
      clearFallbackTimer();
      fallbackTimer = setTimeout(() => onWatchdogFired(next), wait);
      fallbackTimer?.unref?.();
    }
  } finally {
    if (liveAbort === controller) liveAbort = null;
  }
}

// Recurring HTTP-only cycle used when the browser has no EventSource at all:
// an immediate fetch, then a fresh WATCHDOG_MS-spaced fetch on success, or
// capped/jittered backoff on failure - the same cadence as the SSE delivery
// watchdog, just without ever touching eventSource.
async function runFallbackCycle(token) {
  if (token !== streamGeneration || paused) return;
  const controller = new AbortController();
  liveAbort = controller;
  const signal = controller.signal;
  const isCurrent = () => !signal.aborted && !paused && token === streamGeneration;
  let wait = WATCHDOG_MS;
  try {
    const { outcome, data } = await refreshLiveVehicles({ signal, isCurrent });
    if (!isCurrent()) return;
    if (outcome !== 'aborted') {
      if (data) afterSnapshot(data, outcome);
    }
  } catch (error) {
    if (isCurrent() && error.name !== 'AbortError') {
      wait = failureDelay(++liveFailures, error.retryAfter);
      store.set({
        liveQuality: { ...(store.get().liveQuality ?? {}), state: 'unavailable' },
        errors: { ...store.get().errors, vehicles: error.message },
      });
    }
  } finally {
    if (liveAbort === controller) liveAbort = null;
  }
  if (!isCurrent()) return;
  nextFallbackAt = Date.now() + wait;
  clearFallbackTimer();
  fallbackTimer = setTimeout(() => runFallbackCycle(token), wait);
  fallbackTimer?.unref?.();
}

function openStream(token) {
  if (token !== streamGeneration || paused) return;
  if (typeof EventSource !== 'function') {
    // No SSE support in this browser: run purely on the HTTP watchdog cycle,
    // independent of the (never created) EventSource/reconnect machinery.
    void runFallbackCycle(token);
    return;
  }
  const source = new EventSource(`${apiBase}/stream`);
  eventSource = source;
  source.addEventListener('open', () => { if (token === streamGeneration && !paused) connected = true; });
  source.addEventListener('error', () => { if (token === streamGeneration && !paused) connected = false; });
  source.addEventListener('buses', (event) => {
    if (token !== streamGeneration || paused) return;
    let data;
    try { data = JSON.parse(event.data); } catch {
      store.set({ errors: { ...store.get().errors, vehicles: 'The server returned invalid live data.' } });
      return;
    }
    const outcome = handleBusesPayload(data);
    if (outcome === 'newer' || outcome === 'new-epoch' || outcome === 'duplicate') armWatchdog(token);
  });
  source.addEventListener('tracking-status', (event) => {
    if (token !== streamGeneration || paused) return;
    let data;
    try { data = JSON.parse(event.data); } catch {
      store.set({ errors: { ...store.get().errors, vehicles: 'The server returned invalid tracking status.' } });
      return;
    }
    handleTrackingStatusPayload(data);
    // Status-only events are never delivery-watchdog evidence, even when
    // valid: no live picture means nothing actually arrived to prove the
    // stream is delivering fresh data.
  });
  armWatchdog(token);
}

async function fetchCallsOnce(token) {
  if (paused || token !== callsGeneration || !store.get().selectedStop) return;
  const controller = new AbortController();
  callsAbort = controller;
  const signal = controller.signal;
  const isCurrent = () => !signal.aborted && !paused && token === callsGeneration;
  try {
    await fetchCallsForSelectedStop({ signal, isCurrent });
    if (isCurrent()) callsFailures = 0;
  } catch (error) {
    if (isCurrent() && error.name !== 'AbortError') {
      const wait = failureDelay(++callsFailures, error.retryAfter);
      store.set({ isCallsLoading: false, errors: { ...store.get().errors, calls: error.message } });
      clearTimeout(callsTimer);
      callsTimer = setTimeout(() => fetchCallsOnce(token), wait);
      callsTimer?.unref?.();
    }
  } finally {
    if (callsAbort === controller) callsAbort = null;
  }
}

export function onStopSelected() {
  callsGeneration++;
  clearTimeout(callsTimer);
  callsAbort?.abort();
  callsFailures = 0;
  if (!paused) void fetchCallsOnce(callsGeneration);
}

export function onStopDeselected() {
  callsGeneration++;
  clearTimeout(callsTimer);
  callsAbort?.abort();
  store.set({ calls: [], isStopCancelled: false, messages: [], isCallsLoading: false, departuresUpdatedAt: null });
}

export function pausePolling() {
  paused = true;
  streamGeneration++;
  callsGeneration++;
  clearWatchdog();
  clearFallbackTimer();
  closeStream();
  liveAbort?.abort();
  liveAbort = null;
  lifecycleAbort?.abort();
  clearTimeout(basicRecoveryTimer);
  catalogRefreshPromise = null;
  clearTimeout(callsTimer);
  callsAbort?.abort();
  connected = false;
  nextFallbackAt = null;
}

export function resumePolling() {
  paused = false;
  streamGeneration++;
  const token = streamGeneration;
  liveFailures = 0;
  clearWatchdog();
  clearFallbackTimer();
  closeStream();
  liveAbort?.abort();
  lifecycleAbort?.abort();
  clearTimeout(basicRecoveryTimer);
  catalogRefreshPromise = null;
  lifecycleAbort = new AbortController();
  const basicSignal = lifecycleAbort.signal;
  const basicCurrent = () => !paused && !basicSignal.aborted;
  void refreshStopLocations({ signal: basicSignal, isCurrent: basicCurrent }).catch((error) => {
    if (basicCurrent()) store.set({ errors: { ...store.get().errors, stops: error.message } });
  });
  maybeRefreshCatalog({});
  if (typeof EventSource !== 'function') {
    openStream(token);
    if (store.get().selectedStop) onStopSelected();
    return;
  }
  // Immediate cached HTTP read for fast first paint, independent of the SSE
  // connection opened alongside it.
  const controller = new AbortController();
  liveAbort = controller;
  const isCurrent = () => !controller.signal.aborted && !paused && token === streamGeneration;
  const startedAtDelivery = deliveries;
  void refreshLiveVehicles({ signal: controller.signal, isCurrent }).then(({ outcome, data }) => {
    if (!isCurrent()) return;
    if (data) afterSnapshot(data, outcome);
    if (outcome === 'newer' || outcome === 'new-epoch' || outcome === 'duplicate') armWatchdog(token);
  }).catch((error) => {
    if (isCurrent() && error.name !== 'AbortError' && deliveries === startedAtDelivery) {
      store.set({
        liveQuality: { ...(store.get().liveQuality ?? {}), state: 'unavailable' },
        errors: { ...store.get().errors, vehicles: error.message },
      });
    }
  }).finally(() => { if (liveAbort === controller) liveAbort = null; });
  openStream(token);
  if (store.get().selectedStop) onStopSelected();
}

export function initPoller() {
  if (initialized) return;
  initialized = true;
  if (document.hidden) pausePolling();
  else resumePolling();
  document.addEventListener('visibilitychange', () => document.hidden ? pausePolling() : resumePolling());
}
