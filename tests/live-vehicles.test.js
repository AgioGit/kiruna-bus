import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptBusesSnapshot, buildJourneyStops, isNextStopSoon, isPositionFresh, MAX_POSITION_AGE_MS, refreshLiveVehicles,
} from '../src/js/live-vehicles.js';
import { api } from '../src/js/api.js';
import { store } from '../src/js/appState.js';
import { resetTracking } from '../src/js/tracking.js';
import { CLOCK_SAMPLE_MAX_AGE, now as clockNow } from '../src/js/clock.js';
import { refreshBootstrap } from '../src/js/config.js';
import { readFileSync } from 'node:fs';

test('buildJourneyStops maps each journey to its upcoming stops', () => {
  const stops = [{ stopText: 'A', sequenceNumber: 1, plannedTime: null, forecastTime: null }];
  const map = buildJourneyStops([
    { journeyId: 7, upcomingStops: stops },
    { journeyId: 8 },
    { journeyId: null, upcomingStops: stops },
  ]);
  assert.deepEqual([...map.keys()], [7, 8]);
  assert.equal(map.get(7), stops);
  assert.deepEqual(map.get(8), []);
});

test('isNextStopSoon hides buses whose next stop is over 10 minutes away', () => {
  const now = Date.parse('2026-01-01T10:00:00Z');
  const at = (minutes) => ({ nextStop: { forecastTime: new Date(now + minutes * 60000).toISOString() } });
  assert.equal(isNextStopSoon(at(5), now), true);
  assert.equal(isNextStopSoon(at(11), now), false);
  assert.equal(isNextStopSoon({ nextStop: null }, now), true);
});

test('position freshness includes exactly three minutes, but hides older or undated fixes', () => {
  const now = Date.parse('2026-01-01T10:00:00Z');
  const bus = (age) => ({ position: { timestamp: new Date(now - age).toISOString() } });
  assert.equal(isPositionFresh(bus(180_000), now), true);
  assert.equal(isPositionFresh(bus(180_001), now), false);
  assert.equal(isPositionFresh({ position: { timestamp: 'invalid' } }, now), false);
});

test('a retained bus expires between polls without changing its updated timestamp', async (t) => {
  const now = Date.parse('2026-01-01T10:00:00Z');
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: now + 3600_000 });
  store.set({ clockOffsetMs: 0, clockSynchronized: false });
  t.mock.method(performance, 'now', () => Date.now());
  const timestamp = new Date(now - 179_000).toISOString();
  const bus = { journeyId: 7, position: { timestamp }, upcomingStops: [{ stopText: 'A' }] };
  const fetch = t.mock.method(api, 'getBuses', async () => snapshot({
    epoch: 'epoch-a', revision: 1, catalogVersion: 'cv-1',
    serverTime: new Date(now).toISOString(), vehicles: [bus], error: 'Missing position', lineRoutes: {},
  }));
  await refreshLiveVehicles();
  assert.equal(store.get().liveVehicles[0].position.timestamp, timestamp);
  assert.equal(store.get().errors.vehicles, 'Missing position');
  t.mock.timers.tick(1000);
  assert.equal(store.get().liveVehicles.length, 1);
  t.mock.timers.tick(1);
  assert.deepEqual(store.get().liveVehicles, []);
  assert.equal(store.get().journeyStops.size, 0);
  assert.equal(fetch.mock.callCount(), 1);
});

test('a newer fetch replaces the expiry timer and removes already-expired buses', async (t) => {
  const now = Date.parse('2026-01-02T10:00:00Z');
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  store.set({ clockOffsetMs: 0, clockSynchronized: false });
  t.mock.method(performance, 'now', () => Date.now());
  const bus = (age) => ({ journeyId: 7, position: { timestamp: new Date(now - age).toISOString() } });
  t.mock.method(api, 'getBuses', async () => snapshot({
    epoch: 'epoch-b', revision: 1, catalogVersion: 'cv-1',
    serverTime: new Date(now).toISOString(), vehicles: [bus(179_000), bus(180_001)], lineRoutes: {},
  }));
  await refreshLiveVehicles();
  assert.equal(store.get().liveVehicles.length, 1);
  t.mock.method(api, 'getBuses', async () => snapshot({
    epoch: 'epoch-b', revision: 2, catalogVersion: 'cv-1',
    serverTime: new Date(now).toISOString(), vehicles: [bus(0)], lineRoutes: {},
  }));
  await refreshLiveVehicles();
  t.mock.timers.tick(1001);
  assert.equal(store.get().liveVehicles.length, 1);
  t.mock.timers.tick(179_000);
  assert.deepEqual(store.get().liveVehicles, []);
});

function snapshot(overrides = {}) {
  return {
    epoch: 'epoch-x', revision: 0, catalogVersion: 'cv-1', serverTime: new Date().toISOString(),
    generatedAt: new Date().toISOString(), quality: { state: 'fresh', reasons: [] },
    lineRoutes: {}, ...overrides,
    vehicles: (overrides.vehicles ?? []).map((bus) => ({
      key: 'bus', lineId: 1, line: 'Line', destination: 'Town', ageMs: 0, stale: false,
      nextStop: { stopText: null, plannedTime: null, forecastTime: null }, followingStop: null,
      upcomingStops: [], ...bus,
      position: { location: { lat: 67.85, lon: 20.22 }, timestamp: new Date().toISOString(), ...bus.position },
    })),
  };
}

test('acceptBusesSnapshot: a malformed payload is rejected before touching any state', (t) => {
  resetTracking();
  t.after(resetTracking);
  const before = store.get().liveVehicles;
  const result = acceptBusesSnapshot({ epoch: 'epoch-x', revision: 0 }); // missing vehicles/lineRoutes/catalogVersion
  assert.equal(result.outcome, 'invalid');
  assert.equal(result.vehicles, null);
  assert.equal(store.get().liveVehicles, before); // untouched, same reference
});

test('acceptBusesSnapshot: a stale revision is ignored and never reaches state', (t) => {
  resetTracking();
  t.after(resetTracking);
  acceptBusesSnapshot(snapshot({ revision: 5, vehicles: [{ journeyId: 1 }] }));
  const before = store.get().liveVehicles;
  const result = acceptBusesSnapshot(snapshot({ revision: 4, vehicles: [] }));
  assert.equal(result.outcome, 'stale');
  assert.equal(result.vehicles, null);
  assert.equal(store.get().liveVehicles, before);
});

test('acceptBusesSnapshot: an equal (duplicate) revision is valid evidence but never resurrects expired state', async (t) => {
  const now = Date.parse('2026-01-01T10:00:00Z');
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  store.set({ clockOffsetMs: 0, clockSynchronized: false });
  t.mock.method(performance, 'now', () => Date.now());
  resetTracking();
  t.after(resetTracking);
  const bus = { journeyId: 1, position: { timestamp: new Date(now).toISOString() } };
  acceptBusesSnapshot(snapshot({ revision: 7, vehicles: [bus], serverTime: new Date(now).toISOString() }));
  assert.equal(store.get().liveVehicles.length, 1);
  t.mock.timers.tick(MAX_POSITION_AGE_MS + 1); // the bus's own expiry timer clears it locally
  assert.deepEqual(store.get().liveVehicles, []);
  // The exact same revision arrives again (e.g. a reconnect snapshot): duplicate,
  // must not reapply the now-stale vehicle list and resurrect the expired bus.
  const result = acceptBusesSnapshot(snapshot({ revision: 7, vehicles: [bus], serverTime: new Date().toISOString(),
    quality: { state: 'stale', reasons: ['GPS_OLD'] } }));
  assert.equal(result.outcome, 'duplicate');
  assert.equal(result.vehicles, null);
  assert.deepEqual(store.get().liveVehicles, []);
  assert.deepEqual(store.get().liveQuality, { state: 'stale', reasons: ['GPS_OLD'] });
});

test('acceptBusesSnapshot: a new epoch always applies, even with a lower revision number', (t) => {
  const now = Date.parse('2026-01-04T10:00:00Z');
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  t.mock.method(performance, 'now', () => Date.now());
  store.set({ clockOffsetMs: 0, clockSynchronized: false });
  resetTracking();
  t.after(() => { resetTracking(); store.set({ clockOffsetMs: 0, clockSynchronized: false }); });
  acceptBusesSnapshot(snapshot({ epoch: 'epoch-a', revision: 99, vehicles: [], serverTime: new Date(now).toISOString() }));
  const bus = { journeyId: 2, position: { timestamp: new Date(now).toISOString() } };
  const result = acceptBusesSnapshot(snapshot({
    epoch: 'epoch-b', revision: 0, vehicles: [bus], serverTime: new Date(now).toISOString(),
  }));
  assert.equal(result.outcome, 'new-epoch');
  assert.equal(store.get().liveVehicles.length, 1);
});

test('a newer revision with an old server timestamp cannot resurrect an expired position', (t) => {
  const start = Date.parse('2026-01-05T10:00:00Z');
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start });
  t.mock.method(performance, 'now', () => Date.now());
  store.set({ clockOffsetMs: 0, clockSynchronized: false });
  resetTracking();
  t.after(() => { resetTracking(); store.set({ clockOffsetMs: 0, clockSynchronized: false }); });
  const bus = { journeyId: 7, position: { timestamp: new Date(start).toISOString() } };
  const data = snapshot({ epoch: 'delayed-newer', revision: 1, vehicles: [bus], serverTime: new Date(start).toISOString() });
  acceptBusesSnapshot(data);
  t.mock.timers.setTime(start + MAX_POSITION_AGE_MS + 1);
  assert.equal(acceptBusesSnapshot({ ...data, revision: 2 }).outcome, 'newer');
  assert.equal(store.get().liveVehicles.length, 0);
});

test('bootstrap clock changes expire vehicles; newer snapshots use the corrected clock', async (t) => {
  const start = Date.parse('2026-01-03T10:00:00Z');
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start });
  t.mock.method(performance, 'now', () => Date.now());
  store.set({ clockOffsetMs: 0, clockSynchronized: false, liveVehicles: [] });
  resetTracking();
  t.after(() => { resetTracking(); store.set({ clockOffsetMs: 0, clockSynchronized: false }); });
  const bus = { journeyId: 7, position: { timestamp: new Date(start).toISOString() },
    upcomingStops: [{ stopText: 'A', plannedTime: null, forecastTime: null }] };
  const data = snapshot({ epoch: 'bootstrap-expiry', revision: 1, vehicles: [bus], serverTime: new Date(start).toISOString() });
  acceptBusesSnapshot(data);
  assert.equal(store.get().liveVehicles.length, 1);
  assert.equal(store.get().journeyStops.size, 1);
  const catalog = JSON.parse(readFileSync(new URL('../server/data/bootstrap.json', import.meta.url), 'utf8'));
  let serverTime = start + 300000;
  t.mock.method(api, 'getBootstrap', async () => {
    const response = { catalog, source: 'test', serverTime: new Date(serverTime).toISOString() };
    Object.defineProperty(response, CLOCK_SAMPLE_MAX_AGE, { value: 0 });
    return response;
  });
  t.mock.method(console, 'warn', () => {});
  await refreshBootstrap({ force: true });
  assert.equal(clockNow(), start + 300000);
  assert.deepEqual(store.get().liveVehicles, []);
  assert.equal(store.get().journeyStops.size, 0);

  serverTime = start + 60000;
  await refreshBootstrap({ force: true });
  assert.equal(clockNow(), start + 60000);
  acceptBusesSnapshot(data);
  assert.deepEqual(store.get().liveVehicles, []);
  acceptBusesSnapshot({ ...data, revision: 2 });
  assert.equal(store.get().liveVehicles.length, 1);
  acceptBusesSnapshot({ ...data, revision: 3, vehicles: [] });
  assert.deepEqual(store.get().liveVehicles, []);
  acceptBusesSnapshot({ ...data, revision: 4 });
  assert.equal(store.get().liveVehicles.length, 1);
  const fresh = { ...bus, position: { timestamp: new Date(serverTime).toISOString() } };
  acceptBusesSnapshot(snapshot({ epoch: 'bootstrap-expiry', revision: 5, vehicles: [fresh],
    serverTime: new Date(serverTime).toISOString() }));
  assert.equal(store.get().liveVehicles.length, 1);
  t.mock.timers.tick(MAX_POSITION_AGE_MS);
  assert.equal(store.get().liveVehicles.length, 1);
  t.mock.timers.tick(1);
  assert.deepEqual(store.get().liveVehicles, []);
  t.mock.timers.tick(10000);
  assert.deepEqual(store.get().liveVehicles, []);
});

test('bootstrap clock correction reschedules a still-fresh vehicle at its original GPS deadline', async (t) => {
  const start = Date.parse('2026-01-06T10:00:00Z');
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start });
  t.mock.method(performance, 'now', () => Date.now());
  store.set({ clockOffsetMs: 0, clockSynchronized: false, liveVehicles: [] });
  resetTracking();
  t.after(() => { resetTracking(); store.set({ clockOffsetMs: 0, clockSynchronized: false }); });
  const bus = { journeyId: 7, position: { timestamp: new Date(start).toISOString() } };
  acceptBusesSnapshot(snapshot({ epoch: 'bootstrap-reschedule', revision: 1, vehicles: [bus],
    serverTime: new Date(start).toISOString() }));
  const catalog = JSON.parse(readFileSync(new URL('../server/data/bootstrap.json', import.meta.url), 'utf8'));
  t.mock.method(api, 'getBootstrap', async () => {
    const response = { catalog, source: 'test', serverTime: new Date(start + 120000).toISOString() };
    Object.defineProperty(response, CLOCK_SAMPLE_MAX_AGE, { value: 0 });
    return response;
  });
  t.mock.method(console, 'warn', () => {});
  await refreshBootstrap({ force: true });
  assert.equal(store.get().liveVehicles.length, 1);
  t.mock.timers.tick(60000);
  assert.equal(store.get().liveVehicles.length, 1);
  t.mock.timers.tick(1);
  assert.deepEqual(store.get().liveVehicles, []);
});
