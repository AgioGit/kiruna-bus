import test from 'node:test';
import assert from 'node:assert/strict';
import { buildJourneyStops, isNextStopSoon, isPositionFresh, refreshLiveVehicles } from '../src/js/live-vehicles.js';
import { api } from '../src/js/api.js';
import { store } from '../src/js/appState.js';

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
  const fetch = t.mock.method(api, 'getBuses', async () => ({
    serverTime: new Date(now).toISOString(), vehicles: [bus], error: 'Missing position',
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
  t.mock.method(api, 'getBuses', async () => ({
    serverTime: new Date(now).toISOString(), vehicles: [bus(179_000), bus(180_001)],
  }));
  await refreshLiveVehicles();
  assert.equal(store.get().liveVehicles.length, 1);
  t.mock.method(api, 'getBuses', async () => ({
    serverTime: new Date(now).toISOString(), vehicles: [bus(0)],
  }));
  await refreshLiveVehicles();
  t.mock.timers.tick(1001);
  assert.equal(store.get().liveVehicles.length, 1);
  t.mock.timers.tick(179_000);
  assert.deepEqual(store.get().liveVehicles, []);
});
