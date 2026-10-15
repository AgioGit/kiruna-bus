import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptBusesSnapshot, buildJourneyStops, isNextStopSoon, isPositionFresh, MAX_POSITION_AGE_MS, refreshLiveVehicles,
} from '../src/js/live-vehicles.js';
import { api } from '../src/js/api.js';
import { store } from '../src/js/appState.js';
import { resetTracking } from '../src/js/tracking.js';

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
  const now = Date.parse('2026-01-01T10:00:00Z');
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
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
  const now = Date.parse('2026-01-01T10:00:00Z');
  resetTracking();
  t.after(resetTracking);
  acceptBusesSnapshot(snapshot({ epoch: 'epoch-a', revision: 99, vehicles: [], serverTime: new Date(now).toISOString() }));
  const bus = { journeyId: 2, position: { timestamp: new Date(now).toISOString() } };
  const result = acceptBusesSnapshot(snapshot({
    epoch: 'epoch-b', revision: 0, vehicles: [bus], serverTime: new Date(now).toISOString(),
  }));
  assert.equal(result.outcome, 'new-epoch');
  assert.equal(store.get().liveVehicles.length, 1);
});
