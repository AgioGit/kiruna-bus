import test from 'node:test';
import assert from 'node:assert/strict';
import { api, request } from '../src/js/api.js';
import { store } from '../src/js/appState.js';
import { resetTracking } from '../src/js/tracking.js';
import { getLiveVehiclesSchedule, pausePolling, resumePolling } from '../src/js/poller.js';
import { CLOCK_SAMPLE_MAX_AGE, now as clockNow, synchronizeClock } from '../src/js/clock.js';
import { refreshBootstrap } from '../src/js/config.js';
import { applyService, routeServiceStatus } from '../src/js/service.js';
import { resetSelectedStopCalls } from '../src/js/calls.js';

// A tiny, fully synchronous stand-in for the browser's EventSource: records
// listeners per event type and lets tests fire them deterministically. No
// real networking, no automatic reconnect - that's exactly what lets these
// tests assert on poller.js's *own* generation/watchdog/reconnect logic in
// isolation from real transport behavior.
class FakeEventSource {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.closed = false;
    this.listeners = new Map();
    FakeEventSource.instances.push(this);
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }
  close() { this.closed = true; }
  emit(type, data) {
    if (this.closed) return;
    const event = data === undefined ? {} : { data: typeof data === 'string' ? data : JSON.stringify(data) };
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }
}

function busesSnapshot(overrides = {}) {
  return {
    epoch: 'epoch-1', revision: 0, catalogVersion: 'cv-1', serverTime: new Date().toISOString(),
    generatedAt: new Date().toISOString(), quality: { state: 'fresh', reasons: [] },
    vehicles: [], lineRoutes: {}, ...overrides,
  };
}

function catalogFixture(version) {
  return {
    schemaVersion: 1, version, capturedAt: new Date(Date.now() + 86400000).toISOString(), provenance: 'test',
    config: { minZoom: 10, tiles: { urlTemplate: 'https://tiles.example/{z}/{x}/{y}.png' } },
    lines: [{ id: 1, text: 'Line 1' }],
    stops: [{ id: 1, text: 'Stop 1', location: { lat: 10, lon: 10 } }],
    lineRoutes: { 1: [1] }, routes: { 1: { locations: [{ lat: 10, lon: 10 }, { lat: 11, lon: 11 }] } },
  };
}

function resetState() {
  resetSelectedStopCalls();
  store.set({
    liveVehicles: [], journeyStops: new Map(), selectedStop: null, calls: [], previousDeparture: null,
    messages: [], isStopCancelled: false, isCallsLoading: false, departuresUpdatedAt: null, catalogInfo: null, liveQuality: null,
    clockOffsetMs: 0, clockSynchronized: false,
    errors: { config: null, lines: null, vehicles: null, routes: null, calls: null, stopNotFound: null, cache: null, stops: null },
  });
}

let testNow = Date.parse('2026-01-01T10:00:00Z');
test.beforeEach((t) => {
  FakeEventSource.instances.length = 0;
  globalThis.EventSource = FakeEventSource;
  resetTracking();
  resetState();
  t.mock.method(api, 'getStops', async () => []);
  t.mock.method(api, 'getBootstrap', async () => { throw new Error('Basic information unavailable'); });
  testNow += 10 * 60000;
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: testNow });
  t.mock.method(performance, 'now', () => Date.now());
  t.after(() => {
    pausePolling();
    resetState();
    synchronizeClock(new Date().toISOString());
    applyService(null);
    delete globalThis.EventSource;
  });
});

async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

test('resumePolling opens exactly one stream against apiBase and reads cached /buses once immediately', async (t) => {
  const fetchBuses = t.mock.method(api, 'getBuses', async () => busesSnapshot({ revision: 0 }));
  resumePolling();
  await flush();
  assert.equal(FakeEventSource.instances.length, 1);
  assert.match(FakeEventSource.instances[0].url, /\/stream$/);
  assert.equal(fetchBuses.mock.callCount(), 1);
  assert.equal(getLiveVehiclesSchedule().connected, false); // no 'open' event simulated yet
  assert.equal(typeof getLiveVehiclesSchedule().nextFallbackAt, 'number'); // armed by the HTTP read
});

test('a newer-revision buses event resets the 60s watchdog, so the stream is not torn down early', async (t) => {
  t.mock.method(api, 'getBuses', async () => busesSnapshot({ revision: 0 }));
  resumePolling();
  await flush();
  const first = FakeEventSource.instances[0];
  first.emit('open');
  assert.equal(getLiveVehiclesSchedule().connected, true);
  t.mock.timers.tick(59000);
  first.emit('buses', busesSnapshot({ revision: 1 })); // re-arms from here
  t.mock.timers.tick(59000);
  assert.equal(FakeEventSource.instances.length, 1); // still the original connection
  t.mock.timers.tick(1001);
  await flush();
  assert.equal(FakeEventSource.instances.length, 2); // now reconnected, exactly once
});

test('a silent stuck stream (heartbeats only) reconnects exactly once at 60s without piling up duplicate connections', async (t) => {
  const fetchBuses = t.mock.method(api, 'getBuses', async () => busesSnapshot({ revision: 0 }));
  resumePolling();
  await flush();
  const first = FakeEventSource.instances[0];
  first.emit('open');
  t.mock.timers.tick(60000);
  await flush();
  assert.equal(first.closed, true);
  assert.equal(FakeEventSource.instances.length, 2);
  assert.equal(FakeEventSource.instances[1].closed, false);
  assert.equal(fetchBuses.mock.callCount(), 2); // the immediate read, plus one watchdog fallback read
});

test('an equal (duplicate) revision event is delivery evidence and resets the watchdog, without reapplying vehicles', async (t) => {
  t.mock.method(api, 'getBuses', async () => busesSnapshot({ revision: 5 }));
  resumePolling();
  await flush();
  const first = FakeEventSource.instances[0];
  first.emit('open');
  t.mock.timers.tick(59000);
  first.emit('buses', busesSnapshot({ revision: 5 })); // duplicate of what the HTTP read already applied
  t.mock.timers.tick(59000);
  assert.equal(FakeEventSource.instances.length, 1); // reset by the duplicate, so no reconnect yet
});

test('a stale or invalid event is never delivery evidence and does not delay the watchdog', async (t) => {
  t.mock.method(api, 'getBuses', async () => busesSnapshot({ revision: 5 }));
  resumePolling();
  await flush();
  const first = FakeEventSource.instances[0];
  first.emit('open');
  t.mock.timers.tick(45000);
  first.emit('buses', busesSnapshot({ revision: 2 })); // stale: ignored entirely
  first.emit('buses', '{not json'); // malformed: ignored entirely
  t.mock.timers.tick(15001); // the original 60s deadline, unaffected by either
  await flush();
  assert.equal(first.closed, true);
  assert.equal(FakeEventSource.instances.length, 2);
});

test('a valid tracking-status event is never delivery evidence, even though it updates quality', async (t) => {
  t.mock.method(api, 'getBuses', async () => busesSnapshot({ revision: 5 }));
  resumePolling();
  await flush();
  const first = FakeEventSource.instances[0];
  first.emit('open');
  t.mock.timers.tick(45000);
  first.emit('tracking-status', {
    epoch: 'epoch-1', revision: 6, catalogVersion: 'cv-1', serverTime: new Date().toISOString(),
    quality: { state: 'unavailable', reasons: ['upstream'] }, error: { code: 'UPSTREAM_DOWN', message: 'Upstream unavailable' }, retryAfter: 5,
  });
  assert.equal(store.get().liveQuality.state, 'unavailable');
  assert.equal(store.get().errors.vehicles, 'Upstream unavailable');
  t.mock.timers.tick(15001); // the original 60s deadline is untouched by the status event
  await flush();
  assert.equal(first.closed, true);
  assert.equal(FakeEventSource.instances.length, 2);
});

test('pausePolling tears down the stream/timers and a late previous-generation response cannot mutate state after resumePolling', async (t) => {
  let resolveFirst;
  const fetchBuses = t.mock.method(api, 'getBuses', () => new Promise((resolve) => { resolveFirst = resolve; }));
  resumePolling();
  await flush();
  assert.equal(FakeEventSource.instances.length, 1);
  pausePolling();
  assert.equal(FakeEventSource.instances[0].closed, true);
  assert.equal(getLiveVehiclesSchedule().connected, false);
  assert.equal(getLiveVehiclesSchedule().nextFallbackAt, null);

  fetchBuses.mock.mockImplementation(async () => busesSnapshot({ revision: 9 }));
  resumePolling(); // new generation
  await flush();
  assert.equal(FakeEventSource.instances.length, 2);
  assert.equal(store.get().liveVehicles.length, 0); // not yet resolved for generation 2 at this point

  // The stale generation-1 fetch now finally resolves with data for a bus
  // that was never otherwise reported - it must never reach the store.
  resolveFirst(busesSnapshot({ revision: 1, vehicles: [{ journeyId: 999, position: { timestamp: new Date().toISOString() } }] }));
  await flush();
  assert.equal(store.get().liveVehicles.some((bus) => bus.journeyId === 999), false);
});

test('a catalogVersion change triggers exactly one coalesced bootstrap refresh, not a refresh per snapshot', async (t) => {
  const catalog = {
    schemaVersion: 1, version: 'cv-2', capturedAt: new Date().toISOString(), provenance: 'test',
    config: { minZoom: 10, tiles: { urlTemplate: 'https://tiles.example/{z}/{x}/{y}.png' } },
    lines: [{ id: 1, text: 'Line 1' }],
    stops: [{ id: 1, text: 'Stop 1', location: { lat: 10, lon: 10 } }],
    lineRoutes: { 1: [1] },
    routes: { 1: { locations: [{ lat: 10, lon: 10 }, { lat: 11, lon: 11 }] } },
  };
  const fetchBootstrap = t.mock.method(api, 'getBootstrap', async () => ({ catalog, source: 'test', serverTime: new Date().toISOString() }));
  store.set({ catalogInfo: { source: 'test', capturedAt: new Date(0).toISOString(), version: 'cv-1' } });
  t.mock.method(api, 'getBuses', async () => busesSnapshot({ revision: 0, catalogVersion: 'cv-1' }));
  resumePolling();
  await flush();
  const first = FakeEventSource.instances[0];
  first.emit('open');
  // Two snapshots in a row report the same new catalogVersion: only one
  // refresh should be issued (the second trigger coalesces into the first).
  first.emit('buses', busesSnapshot({ revision: 1, catalogVersion: 'cv-2' }));
  first.emit('buses', busesSnapshot({ revision: 2, catalogVersion: 'cv-2' }));
  await flush();
  assert.equal(fetchBootstrap.mock.callCount(), 1);
  assert.equal(store.get().catalogInfo.version, 'cv-2');
});

test('selected-stop departures refetch once after a genuinely new revision, not on duplicate/stale snapshots', async (t) => {
  t.mock.method(api, 'getBuses', async () => busesSnapshot({ revision: 0 }));
  const fetchCalls = t.mock.method(api, 'getCalls', async () => ({ calls: [], isStopCancelled: false, messages: [], updatedAt: new Date().toISOString(), serverTime: new Date().toISOString() }));
  store.set({ selectedStop: { id: 42 }, stopSelectionSeq: 1 });
  resumePolling(); // selectedStop already set: triggers one immediate departures fetch too
  await flush();
  assert.equal(fetchCalls.mock.callCount(), 1);
  const first = FakeEventSource.instances[0];
  first.emit('open');
  first.emit('buses', busesSnapshot({ revision: 1 })); // newer: refetch
  await flush();
  assert.equal(fetchCalls.mock.callCount(), 2);
  first.emit('buses', busesSnapshot({ revision: 1 })); // duplicate: no refetch
  first.emit('buses', busesSnapshot({ revision: 0 })); // stale: no refetch
  await flush();
  assert.equal(fetchCalls.mock.callCount(), 2);
});

test('HTTP-only recovery performs one initial read and applies advertised catalog changes', async (t) => {
  delete globalThis.EventSource;
  const catalog = catalogFixture('http-catalog');
  const bootstrap = t.mock.method(api, 'getBootstrap', async () => ({ catalog, source: 'upstream', serverTime: new Date().toISOString() }));
  const buses = t.mock.method(api, 'getBuses', async () => busesSnapshot({ catalogVersion: catalog.version }));
  store.set({ catalogInfo: { version: 'old-catalog' } });
  resumePolling();
  await flush();
  assert.equal(buses.mock.callCount(), 1);
  assert.equal(bootstrap.mock.callCount(), 1);
  assert.equal(store.get().catalogInfo.version, catalog.version);
  assert.equal(FakeEventSource.instances.length, 0);
});

test('SSE recovery cancels a pending HTTP retry and respects longer Retry-After while silent', async (t) => {
  const buses = t.mock.method(api, 'getBuses', async () => busesSnapshot());
  resumePolling();
  await flush();
  buses.mock.mockImplementation(async () => { throw Object.assign(new Error('Overloaded'), { retryAfter: 120000 }); });
  t.mock.timers.tick(60000);
  await flush();
  assert.equal(buses.mock.callCount(), 2);
  t.mock.timers.tick(60000);
  await flush();
  assert.equal(buses.mock.callCount(), 2, 'a stream watchdog must not override the HTTP backoff');
  FakeEventSource.instances.at(-1).emit('buses', busesSnapshot({ revision: 2 }));
  t.mock.timers.tick(59000);
  await flush();
  assert.equal(buses.mock.callCount(), 2, 'healthy push cancels the old retry timer');
});

test('a late initial HTTP failure cannot replace a newer successful stream state', async (t) => {
  let reject;
  t.mock.method(api, 'getBuses', () => new Promise((_, fail) => { reject = fail; }));
  resumePolling();
  FakeEventSource.instances[0].emit('buses', busesSnapshot({ revision: 2 }));
  reject(new Error('Old HTTP request failed'));
  await flush();
  assert.equal(store.get().errors.vehicles, null);
  assert.equal(store.get().liveQuality.state, 'fresh');
});

test('an unseen old process in the initial HTTP response cannot displace a newer stream epoch', async (t) => {
  let resolve;
  t.mock.method(api, 'getBuses', () => new Promise((done) => { resolve = done; }));
  resumePolling();
  FakeEventSource.instances[0].emit('buses', busesSnapshot({ epoch: 'new-process', revision: 2 }));
  resolve(busesSnapshot({ epoch: 'unseen-old-process', revision: 90, error: 'Old state' }));
  await flush();
  assert.equal(store.get().errors.vehicles, null);
  FakeEventSource.instances[0].emit('buses', busesSnapshot({ epoch: 'new-process', revision: 3, error: 'Current state' }));
  assert.equal(store.get().errors.vehicles, 'Current state');
});

test('a malformed vehicle cannot advance the ordering gate or suppress recovery at the same revision', async (t) => {
  t.mock.method(api, 'getBuses', async () => busesSnapshot({ revision: 1 }));
  resumePolling();
  await flush();
  const stream = FakeEventSource.instances[0];
  stream.emit('buses', busesSnapshot({ revision: 2, vehicles: [null] }));
  assert.match(store.get().errors.vehicles, /invalid live data/);
  stream.emit('buses', busesSnapshot({ revision: 2 }));
  assert.equal(store.get().errors.vehicles, null);
});

test('basic catalog recovery runs even when every live response remains unavailable', async (t) => {
  const bootstrap = t.mock.method(api, 'getBootstrap', async () => { throw new Error('Basic outage'); });
  t.mock.method(api, 'getBuses', async () => { throw new Error('Live outage'); });
  resumePolling();
  await flush();
  assert.equal(bootstrap.mock.callCount(), 1);
  const catalog = catalogFixture('recovered-basic');
  bootstrap.mock.mockImplementation(async () => ({ catalog, source: 'upstream', serverTime: new Date().toISOString() }));
  t.mock.timers.tick(60000);
  await flush();
  assert.equal(bootstrap.mock.callCount(), 2);
  assert.equal(store.get().catalogInfo.version, catalog.version);
  assert.match(store.get().errors.vehicles, /Live outage/);
});

test('a catalog request completing after a hidden-tab pause cannot write state', async (t) => {
  let resolve;
  t.mock.method(api, 'getBootstrap', () => new Promise((done) => { resolve = done; }));
  t.mock.method(api, 'getBuses', async () => busesSnapshot());
  resumePolling();
  pausePolling();
  const catalog = catalogFixture('late-catalog');
  resolve({ catalog, source: 'upstream', serverTime: new Date().toISOString() });
  await flush();
  assert.equal(store.get().catalogInfo, null);
});

test('fast bootstrap, warming HTTP and healthy SSE recover through one bounded cached HTTP read', async (t) => {
  const start = Date.now(), iso = (ms) => new Date(ms).toISOString();
  const catalog = catalogFixture('cv-1');
  const bootstrap = { catalog, source: 'test', serverTime: iso(start + 3600000) };
  let resolveWarming, reads = 0;
  const service = { completeUntil: iso(start + 180000), windows: [{
    lineId: 1, routeId: 1, from: iso(start - 1000), until: iso(start + 300000), expiresAt: iso(start + 180000),
  }] };
  const bus = (time) => ({ key: 'bus', journeyId: 1, lineId: 1, routeId: 1, line: 'Line 1', destination: 'Town',
    ageMs: 0, stale: false, position: { timestamp: iso(time), location: { lat: 10, lon: 10 } },
    nextStop: { stopText: null, plannedTime: null, forecastTime: null }, followingStop: null, upcomingStops: [] });
  const streamData = busesSnapshot({ revision: 1, serverTime: iso(start), generatedAt: iso(start),
    vehicles: [bus(start)], service });
  t.mock.method(globalThis, 'fetch', (url) => {
    if (url.pathname.endsWith('/bootstrap')) {
      return Promise.resolve(Response.json(bootstrap, { headers: { 'x-server-time': bootstrap.serverTime } }));
    }
    if (++reads === 1) return new Promise((resolve) => { resolveWarming = resolve; });
    return Promise.resolve(Response.json(streamData, { headers: { 'x-server-time': iso(start) } }));
  });
  t.mock.method(api, 'getBootstrap', (opts) => request('/bootstrap', opts));
  const fetchBuses = t.mock.method(api, 'getBuses', (opts) => request('/buses', opts));
  t.mock.method(console, 'warn', () => {});
  await refreshBootstrap({ force: true });
  assert.equal(clockNow(), start + 3600000);
  resumePolling();
  const stream = FakeEventSource.instances[0];
  stream.emit('buses', streamData);
  assert.equal(fetchBuses.mock.callCount(), 1, 'do not overlap the initial request');
  assert.equal(routeServiceStatus(store.get().serviceView, 1, 1), 'unknown');
  assert.deepEqual(store.get().liveVehicles, []);
  resolveWarming(Response.json({ error: { code: 'WARMING_UP', message: 'Warming up' } }, { status: 503 }));
  await flush();
  await flush();
  await flush();
  await new Promise((resolve) => setImmediate(resolve));
  await flush();
  assert.equal(fetchBuses.mock.callCount(), 2);
  assert.equal(clockNow(), start);
  assert.equal(routeServiceStatus(store.get().serviceView, 1, 1), 'active');
  assert.deepEqual(store.get().liveVehicles, [], 'duplicate HTTP data does not reapply vehicles');
  t.mock.timers.tick(30000);
  stream.emit('buses', { ...streamData, revision: 2, serverTime: iso(start + 30000), vehicles: [bus(start + 30000)] });
  await flush();
  assert.equal(store.get().liveVehicles.length, 1);
  assert.equal(fetchBuses.mock.callCount(), 2);
  assert.equal(FakeEventSource.instances.length, 1);
});

test('clock recovery is single-flight, throttled and respects Retry-After despite repeated SSE', async (t) => {
  const start = Date.now(), iso = (ms) => new Date(ms).toISOString();
  synchronizeClock(iso(start + 3600000));
  store.set({ catalogInfo: { version: 'cv-1' } });
  let rejectRecovery, reads = 0;
  const fetchBuses = t.mock.method(api, 'getBuses', () => {
    const count = ++reads;
    if (count === 1) return Promise.reject(Object.assign(new Error('Warming'), { code: 'WARMING_UP' }));
    if (count === 2) return new Promise((_, reject) => { rejectRecovery = reject; });
    const response = busesSnapshot({ revision: 6, serverTime: iso(start + 119999) });
    Object.defineProperty(response, CLOCK_SAMPLE_MAX_AGE, { value: 0 });
    return Promise.resolve(response);
  });
  resumePolling();
  await flush();
  const stream = FakeEventSource.instances[0];
  stream.emit('buses', busesSnapshot({ revision: 1, serverTime: iso(start) }));
  stream.emit('buses', busesSnapshot({ revision: 2, serverTime: iso(start) }));
  assert.equal(fetchBuses.mock.callCount(), 2);
  rejectRecovery(Object.assign(new Error('Busy'), { retryAfter: 120000 }));
  await flush();
  await flush();
  for (const [advance, revision] of [[30000, 3], [30000, 4], [30000, 5], [29999, 6]]) {
    t.mock.timers.tick(advance);
    stream.emit('buses', busesSnapshot({ revision, serverTime: iso(Date.now()) }));
    await flush();
    assert.equal(fetchBuses.mock.callCount(), 2);
  }
  t.mock.timers.tick(1);
  await flush();
  assert.equal(fetchBuses.mock.callCount(), 3);
  assert.equal(clockNow(), start + 119999);
});

test('a warming response Retry-After also throttles discrepancy recovery', async (t) => {
  const start = Date.now(), iso = (ms) => new Date(ms).toISOString();
  synchronizeClock(iso(start + 3600000));
  store.set({ catalogInfo: { version: 'cv-1' } });
  let reads = 0;
  const fetchBuses = t.mock.method(api, 'getBuses', () => {
    if (++reads === 1) return Promise.reject(Object.assign(new Error('Warming'), { retryAfter: 20000 }));
    const response = busesSnapshot({ revision: 2, serverTime: iso(start + 20000) });
    Object.defineProperty(response, CLOCK_SAMPLE_MAX_AGE, { value: 0 });
    return Promise.resolve(response);
  });
  resumePolling();
  await flush();
  await flush();
  const stream = FakeEventSource.instances[0];
  stream.emit('buses', busesSnapshot({ revision: 1, serverTime: iso(start) }));
  assert.equal(fetchBuses.mock.callCount(), 1);
  t.mock.timers.tick(19999);
  stream.emit('buses', busesSnapshot({ revision: 2, serverTime: iso(start + 19999) }));
  assert.equal(fetchBuses.mock.callCount(), 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(fetchBuses.mock.callCount(), 2);
  assert.equal(clockNow(), start + 20000);
});

test('a bounded stale-revision HTTP sample can correct time without replacing newer stream data', async (t) => {
  const start = Date.now(), iso = (ms) => new Date(ms).toISOString();
  synchronizeClock(iso(start + 3600000));
  store.set({ catalogInfo: { version: 'cv-1' } });
  let reads = 0, resolveRecovery;
  const fetchBuses = t.mock.method(api, 'getBuses', () => {
    if (++reads === 1) return Promise.reject(new Error('Warming'));
    return new Promise((resolve) => { resolveRecovery = resolve; });
  });
  resumePolling();
  await flush();
  await flush();
  const stream = FakeEventSource.instances[0];
  stream.emit('buses', busesSnapshot({ revision: 1, serverTime: iso(start), error: 'older' }));
  const service = { completeUntil: iso(start + 60000), windows: [{
    lineId: 1, routeId: 1, from: iso(start), until: iso(start + 60000), expiresAt: iso(start + 60000),
  }] };
  stream.emit('buses', busesSnapshot({ revision: 2, serverTime: iso(start + 2000), error: null, service }));
  const olderRevision = busesSnapshot({ revision: 1, serverTime: iso(start + 3000), error: 'older' });
  Object.defineProperty(olderRevision, CLOCK_SAMPLE_MAX_AGE, { value: 0 });
  resolveRecovery(olderRevision);
  await flush();
  await flush();
  assert.equal(fetchBuses.mock.callCount(), 2);
  assert.equal(clockNow(), start + 3000);
  assert.equal(store.get().errors.vehicles, null);
  assert.equal(routeServiceStatus(store.get().serviceView, 1, 1), 'active');
});

test('an older bounded HTTP sample cannot displace a newer ordered stream clock', async (t) => {
  const start = Date.now(), iso = (ms) => new Date(ms).toISOString();
  synchronizeClock(iso(start + 3600000));
  store.set({ catalogInfo: { version: 'cv-1' } });
  let reads = 0, resolveRecovery;
  const fetchBuses = t.mock.method(api, 'getBuses', () => {
    if (++reads === 1) return Promise.reject(new Error('Warming'));
    if (reads === 2) return new Promise((resolve) => { resolveRecovery = resolve; });
    const response = busesSnapshot({ revision: 3, serverTime: iso(start + 60000) });
    Object.defineProperty(response, CLOCK_SAMPLE_MAX_AGE, { value: 0 });
    return Promise.resolve(response);
  });
  resumePolling();
  await flush();
  await flush();
  const stream = FakeEventSource.instances[0];
  stream.emit('buses', busesSnapshot({ revision: 1, serverTime: iso(start) }));
  stream.emit('buses', busesSnapshot({ revision: 2, serverTime: iso(start + 3000) }));
  const olderRevision = busesSnapshot({ revision: 1, serverTime: iso(start + 2000) });
  Object.defineProperty(olderRevision, CLOCK_SAMPLE_MAX_AGE, { value: 0 });
  resolveRecovery(olderRevision);
  await flush();
  await flush();
  assert.equal(clockNow(), start + 3600000);
  assert.equal(fetchBuses.mock.callCount(), 2);
  t.mock.timers.tick(59000);
  stream.emit('buses', busesSnapshot({ revision: 3, serverTime: iso(start + 59000) }));
  t.mock.timers.tick(1000);
  await flush();
  await flush();
  assert.equal(fetchBuses.mock.callCount(), 3);
  assert.equal(clockNow(), start + 60000);
});

test('one bounded confirmation suppresses repeated identical delayed SSE but not a new discrepancy', async (t) => {
  const start = Date.now(), iso = (ms) => new Date(ms).toISOString();
  store.set({ catalogInfo: { version: 'cv-1' } });
  let revision = 5;
  const service = { completeUntil: iso(start + 6000), windows: [{
    lineId: 1, routeId: 1, from: iso(start - 1000), until: iso(start + 60000), expiresAt: iso(start + 6000),
  }] };
  const bus = { key: 'bus', journeyId: 1, lineId: 1, routeId: 1, line: 'Line', destination: 'Town',
    ageMs: 179000, stale: false, position: { timestamp: iso(start - 179000), location: { lat: 10, lon: 10 } },
    nextStop: { stopText: null, plannedTime: null, forecastTime: null }, followingStop: null, upcomingStops: [] };
  const fetchBuses = t.mock.method(api, 'getBuses', () => {
    const response = busesSnapshot({ revision, serverTime: iso(Date.now()), service, vehicles: [bus] });
    Object.defineProperty(response, CLOCK_SAMPLE_MAX_AGE, { value: 0 });
    return Promise.resolve(response);
  });
  resumePolling();
  await flush();
  await flush();
  const stream = FakeEventSource.instances[0];
  const old = busesSnapshot({ revision: 5, serverTime: iso(start - 120000), service, vehicles: [bus] });
  stream.emit('buses', old);
  await flush();
  await flush();
  assert.equal(fetchBuses.mock.callCount(), 2);
  for (let i = 1; i <= 4; i++) {
    t.mock.timers.tick(30000);
    stream.emit('buses', old);
    await flush();
    assert.equal(fetchBuses.mock.callCount(), 2, `duplicate ${i} restarted resynchronization`);
    assert.equal(routeServiceStatus(store.get().serviceView, 1, 1), 'unknown');
    assert.deepEqual(store.get().liveVehicles, []);
  }
  revision = 6;
  stream.emit('buses', { ...old, revision });
  await flush();
  await flush();
  assert.equal(fetchBuses.mock.callCount(), 3);
  assert.equal(clockNow(), start + 120000);
});

test('a bounded read started before an SSE discrepancy cannot confirm that discrepancy', async (t) => {
  const start = Date.now(), iso = (ms) => new Date(ms).toISOString();
  synchronizeClock(iso(start + 3600000));
  store.set({ catalogInfo: { version: 'cv-1' } });
  let reads = 0, resolveInitial;
  const fetchBuses = t.mock.method(api, 'getBuses', () => {
    if (++reads === 1) return new Promise((resolve) => { resolveInitial = resolve; });
    const response = busesSnapshot({ revision: 1, serverTime: iso(start) });
    Object.defineProperty(response, CLOCK_SAMPLE_MAX_AGE, { value: 0 });
    return Promise.resolve(response);
  });
  resumePolling();
  const stream = FakeEventSource.instances[0];
  const corrected = busesSnapshot({ revision: 1, serverTime: iso(start) });
  stream.emit('buses', corrected);
  assert.equal(fetchBuses.mock.callCount(), 1);
  const oldSample = busesSnapshot({ revision: 1, serverTime: iso(start + 3600000) });
  Object.defineProperty(oldSample, CLOCK_SAMPLE_MAX_AGE, { value: 0 });
  resolveInitial(oldSample);
  await flush();
  await flush();
  assert.equal(fetchBuses.mock.callCount(), 2);
  assert.equal(clockNow(), start);
  stream.emit('buses', corrected);
  t.mock.timers.tick(30000);
  stream.emit('buses', corrected);
  t.mock.timers.tick(30000);
  await flush();
  assert.equal(fetchBuses.mock.callCount(), 2);
});

test('a different discrepancy arriving during an in-flight confirmation remains pending', async (t) => {
  const start = Date.now(), iso = (ms) => new Date(ms).toISOString();
  store.set({ catalogInfo: { version: 'cv-1' } });
  let reads = 0, resolveRecovery;
  const fetchBuses = t.mock.method(api, 'getBuses', () => {
    if (++reads === 2) return new Promise((resolve) => { resolveRecovery = resolve; });
    const response = busesSnapshot({ revision: 1, serverTime: iso(Date.now()) });
    Object.defineProperty(response, CLOCK_SAMPLE_MAX_AGE, { value: 0 });
    return Promise.resolve(response);
  });
  resumePolling();
  await flush();
  await flush();
  const stream = FakeEventSource.instances[0];
  const oldA = busesSnapshot({ revision: 1, serverTime: iso(start - 120000) });
  const oldB = busesSnapshot({ revision: 1, serverTime: iso(start - 180000) });
  stream.emit('buses', oldA);
  stream.emit('buses', oldB);
  assert.equal(fetchBuses.mock.callCount(), 2);
  const response = busesSnapshot({ revision: 1, serverTime: iso(start) });
  Object.defineProperty(response, CLOCK_SAMPLE_MAX_AGE, { value: 0 });
  resolveRecovery(response);
  await flush();
  await flush();
  t.mock.timers.tick(30000);
  stream.emit('buses', oldB);
  t.mock.timers.tick(30000);
  await flush();
  await flush();
  assert.equal(fetchBuses.mock.callCount(), 3);
});

test('resync Retry-After blocks silent watchdog and visibility resume reads until its deadline', async (t) => {
  const start = Date.now(), iso = (ms) => new Date(ms).toISOString();
  synchronizeClock(iso(start + 3600000));
  store.set({ catalogInfo: { version: 'cv-1' } });
  let reads = 0;
  const fetchBuses = t.mock.method(api, 'getBuses', () => {
    if (++reads === 1) return Promise.resolve(busesSnapshot({ revision: 0, serverTime: iso(start + 3600000) }));
    if (reads === 2) return Promise.reject(Object.assign(new Error('Busy'), { retryAfter: 120000 }));
    const response = busesSnapshot({ revision: 1, serverTime: iso(start + 120000) });
    Object.defineProperty(response, CLOCK_SAMPLE_MAX_AGE, { value: 0 });
    return Promise.resolve(response);
  });
  resumePolling();
  await flush();
  await flush();
  FakeEventSource.instances[0].emit('buses', busesSnapshot({ revision: 1, serverTime: iso(start) }));
  await flush();
  await flush();
  assert.equal(fetchBuses.mock.callCount(), 2);
  t.mock.timers.tick(60000);
  await flush();
  assert.equal(fetchBuses.mock.callCount(), 2, 'watchdog bypassed Retry-After');
  assert.equal(FakeEventSource.instances.length, 2, 'the SSE connection should still be retried');
  pausePolling();
  resumePolling();
  await flush();
  assert.equal(fetchBuses.mock.callCount(), 2, 'visibility resume bypassed Retry-After');
  t.mock.timers.tick(59999);
  await flush();
  assert.equal(fetchBuses.mock.callCount(), 2);
  t.mock.timers.tick(1);
  await flush();
  await flush();
  assert.equal(fetchBuses.mock.callCount(), 3);
});

test('HTTP-only visibility resume also honors a pending Retry-After', async (t) => {
  delete globalThis.EventSource;
  let reads = 0;
  const fetchBuses = t.mock.method(api, 'getBuses', () => {
    if (++reads === 1) return Promise.reject(Object.assign(new Error('Busy'), { retryAfter: 120000 }));
    return Promise.resolve(busesSnapshot());
  });
  resumePolling();
  await flush();
  await flush();
  assert.equal(fetchBuses.mock.callCount(), 1);
  t.mock.timers.tick(30000);
  pausePolling();
  resumePolling();
  await flush();
  assert.equal(fetchBuses.mock.callCount(), 1);
  t.mock.timers.tick(89999);
  await flush();
  assert.equal(fetchBuses.mock.callCount(), 1);
  t.mock.timers.tick(1);
  await flush();
  await flush();
  assert.equal(fetchBuses.mock.callCount(), 2);
});

test('a later authoritative clock change can reopen an identical discrepancy', async (t) => {
  const start = Date.now(), iso = (ms) => new Date(ms).toISOString();
  store.set({ catalogInfo: { version: 'cv-1' } });
  const fetchBuses = t.mock.method(api, 'getBuses', () => {
    const response = busesSnapshot({ revision: 1, serverTime: iso(Date.now()) });
    Object.defineProperty(response, CLOCK_SAMPLE_MAX_AGE, { value: 0 });
    return Promise.resolve(response);
  });
  resumePolling();
  await flush();
  await flush();
  const stream = FakeEventSource.instances[0];
  const old = busesSnapshot({ revision: 1, serverTime: iso(start - 120000) });
  stream.emit('buses', old);
  await flush();
  await flush();
  assert.equal(fetchBuses.mock.callCount(), 2);
  synchronizeClock(iso(start + 3600000), { maxAgeMs: 0 });
  stream.emit('buses', old);
  t.mock.timers.tick(30000);
  stream.emit('buses', old);
  await flush();
  assert.equal(fetchBuses.mock.callCount(), 2);
  t.mock.timers.tick(30000);
  await flush();
  await flush();
  assert.equal(fetchBuses.mock.callCount(), 3);
  assert.equal(clockNow(), start + 60000);
});

test('HTTP-only fallback honors Retry-After even when it exceeds the normal backoff cap', async (t) => {
  delete globalThis.EventSource;
  let reads = 0;
  const fetchBuses = t.mock.method(api, 'getBuses', () => {
    if (++reads === 1) return Promise.reject(Object.assign(new Error('Busy'), { retryAfter: 600000 }));
    return Promise.resolve(busesSnapshot());
  });
  resumePolling();
  await flush();
  await flush();
  t.mock.timers.tick(300000);
  await flush();
  assert.equal(fetchBuses.mock.callCount(), 1);
  t.mock.timers.tick(299999);
  await flush();
  assert.equal(fetchBuses.mock.callCount(), 1);
  t.mock.timers.tick(1);
  await flush();
  await flush();
  assert.equal(fetchBuses.mock.callCount(), 2);
});

test('a late Retry-After from a paused generation still gates the next resume', async (t) => {
  let rejectOld, reads = 0;
  const fetchBuses = t.mock.method(api, 'getBuses', () => {
    if (++reads === 1) return new Promise((_, reject) => { rejectOld = reject; });
    return Promise.resolve(busesSnapshot());
  });
  resumePolling();
  pausePolling();
  rejectOld(Object.assign(new Error('Busy'), { retryAfter: 120000 }));
  await flush();
  await flush();
  resumePolling();
  await flush();
  assert.equal(fetchBuses.mock.callCount(), 1);
  t.mock.timers.tick(119999);
  await flush();
  assert.equal(fetchBuses.mock.callCount(), 1);
  t.mock.timers.tick(1);
  await flush();
  await flush();
  assert.equal(fetchBuses.mock.callCount(), 2);
});
