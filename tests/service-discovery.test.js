import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { api } from '../src/js/api.js';
import { store } from '../src/js/appState.js';
import { applyCatalog } from '../src/js/config.js';
import { acceptBusesSnapshot } from '../src/js/live-vehicles.js';
import { colorForLineId } from '../src/js/lineColors.js';
import { routeServiceStatus, applyService } from '../src/js/service.js';
import { resetTracking } from '../src/js/tracking.js';
import { CALL_RETENTION_MS, createTracker } from '../server/lib/tracker.js';

test('green and a special red variant are discovered without GPS and survive catalog refresh and service expiry', async (t) => {
  const original = api.getMapRoute;
  const requests = [];
  const shape = { locations: [{ lat: 67.85, lon: 20.2 }, { lat: 67.86, lon: 20.21 }] };
  api.getMapRoute = async (id) => { requests.push(id); return shape; };
  resetTracking();
  t.after(() => { api.getMapRoute = original; applyService(null); resetTracking(); });
  const catalog = JSON.parse(readFileSync(new URL('../server/data/bootstrap.json', import.meta.url), 'utf8'));
  applyCatalog(catalog, 'bundled');
  const red = catalog.lines.find((line) => /röd/i.test(line.text));
  const green = 110000999, special = 777001, greenRoute = 777002;
  const time = Date.now(), iso = (ms) => new Date(ms).toISOString();
  const observedLines = [{ id: green, text: 'Grön.' }];
  const windows = [green, red.id].map((lineId, i) => ({
    lineId, routeId: i ? special : greenRoute, from: iso(time - 1000),
    until: iso(time + 600000), expiresAt: iso(time + 60000),
  }));
  const result = acceptBusesSnapshot({
    epoch: 'discovery', revision: 1, catalogVersion: catalog.version,
    generatedAt: iso(time), serverTime: iso(time), quality: { state: 'partial', reasons: ['NO_POSITION_FIX'] },
    vehicles: [], lineRoutes: { [green]: [greenRoute], [red.id]: [special] },
    observedLines, service: { completeUntil: iso(time + 60000), windows },
  });
  assert.equal(result.outcome, 'new-epoch');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requests.sort(), [special, greenRoute]);
  assert.equal(colorForLineId(green), '#2e7d32');
  assert.ok(store.get().activeLineIds.has(green));
  assert.equal(store.get().routeGeometry.get(special), shape);
  assert.equal(routeServiceStatus(store.get().serviceView, red.id, special), 'active');
  const active = new Set(store.get().activeLineIds);
  active.delete(green);
  store.set({ activeLineIds: active });
  applyCatalog({ ...catalog, version: 'refreshed', capturedAt: iso(time + 1000) }, 'upstream');
  assert.ok(store.get().lines.some((line) => line.id === green));
  assert.equal(store.get().activeLineIds.has(green), false);
  assert.equal(store.get().routeGeometry.get(special), shape);
  assert.ok(store.get().lineRoutes.get(red.id).has(special));
  applyService({ completeUntil: iso(time - 1), windows: [] });
  assert.equal(routeServiceStatus(store.get().serviceView, red.id, special), 'unknown');
  assert.equal(store.get().routeGeometry.get(special), shape);
});

test('a retained vehicle discovers its absent line without reselecting it later or inventing service', async (t) => {
  const time = Date.now(), iso = (ms) => new Date(ms).toISOString();
  const line = 110000998, route = 777003;
  t.mock.method(api, 'getMapRoute', async () => ({ locations: [{ lat: 67.85, lon: 20.2 }, { lat: 67.86, lon: 20.21 }] }));
  store.set({ lines: [], activeLineIds: new Set(), lineRoutes: new Map(), routeGeometry: new Map(),
    clockOffsetMs: 0, clockSynchronized: false });
  resetTracking();
  t.after(() => { applyService(null); resetTracking(); });
  const snapshot = {
    epoch: 'retained-green', revision: 1, catalogVersion: '1', generatedAt: iso(time), serverTime: iso(time),
    quality: { state: 'fresh', reasons: [] }, observedLines: [{ id: line, text: 'Grön' }],
    lineRoutes: { [line]: [route] }, service: { completeUntil: iso(time + 60000), windows: [] },
    vehicles: [{ key: 'green', lineId: line, routeId: route, line: 'Grön', destination: 'Town', journeyId: 1,
      ageMs: 1000, stale: true, position: { location: { lat: 67.85, lon: 20.2 }, timestamp: iso(time - 1000) },
      nextStop: { stopText: null, plannedTime: null, forecastTime: null }, followingStop: null, upcomingStops: [] }],
  };
  acceptBusesSnapshot(snapshot);
  assert.equal(store.get().liveVehicles.length, 1);
  assert.ok(store.get().activeLineIds.has(line));
  assert.ok(store.get().lineRoutes.get(line).has(route));
  assert.equal(routeServiceStatus(store.get().serviceView, line, route), 'inactive');
  store.set({ activeLineIds: new Set() });
  acceptBusesSnapshot({ ...snapshot, revision: 2 });
  assert.equal(store.get().activeLineIds.has(line), false);
  await new Promise((resolve) => setImmediate(resolve));
});

test('fresh client discovers retained call evidence without GPS and preserves a later deselection', async (t) => {
  const start = Date.now(), iso = (ms) => new Date(ms).toISOString();
  let time = start, empty = false;
  const line = 110000997, route = 777004;
  const shape = { locations: [{ lat: 67.85, lon: 20.2 }, { lat: 67.86, lon: 20.21 }] };
  t.mock.method(api, 'getMapRoute', async () => shape);
  const upstream = {
    getSystemTimestamp: async (clientTimestamp) => ({ clientTimestamp, systemTimestamp: clientTimestamp }),
    getCalls: async (stop) => {
      if (stop === 'B') throw new Error('offline');
      return { calls: empty ? [] : [{ calls: [{ id: '1', journeyId: 1, lineId: line, routeId: route,
        line: 'Grön', destination: 'Town', sequenceNumber: 1,
        departure: { plannedTime: iso(start + 600000), forecastTime: iso(start + 600000) } }] }] };
    },
    getVehiclePosition: async () => null,
  };
  const tracker = createTracker({ api: upstream, now: () => time, initialStops: [{ id: 1, text: 'A' }, { id: 2, text: 'B' }],
    options: { retryDelayMs: 0 } });
  store.set({ lines: [], activeLineIds: new Set(), lineRoutes: new Map(), routeGeometry: new Map(),
    clockOffsetMs: 0, clockSynchronized: false });
  resetTracking();
  t.after(() => { tracker.close(); applyService(null); resetTracking(); });
  await tracker.collect();
  empty = true;
  time += 60000;
  await tracker.collect();
  const data = { ...tracker.getSnapshot(), epoch: 'retained-calls', revision: 1, catalogVersion: '1' };
  assert.deepEqual(data.vehicles, []);
  assert.equal(data.service.windows[0].expiresAt, iso(start + CALL_RETENTION_MS));
  assert.equal(acceptBusesSnapshot(data).outcome, 'new-epoch');
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(store.get().activeLineIds.has(line));
  assert.equal(store.get().routeGeometry.get(route), shape);
  assert.equal(routeServiceStatus(store.get().serviceView, line, route), 'active');
  store.set({ activeLineIds: new Set() });
  acceptBusesSnapshot({ ...data, revision: 2 });
  assert.equal(store.get().activeLineIds.has(line), false);
  time = start + CALL_RETENTION_MS;
  const expired = { ...tracker.getSnapshot(), epoch: 'retained-calls', revision: 3, catalogVersion: '1' };
  assert.deepEqual(expired.observedLines, []);
  assert.deepEqual(expired.lineRoutes, {});
  acceptBusesSnapshot(expired);
  assert.equal(routeServiceStatus(store.get().serviceView, line, route), 'unknown');
  assert.equal(store.get().activeLineIds.has(line), false);
  assert.equal(store.get().routeGeometry.get(route), shape);
});

test('a fresh client does not discover expired calls after a whole-cycle timeout', async (t) => {
  const start = Date.now(), iso = (ms) => new Date(ms).toISOString();
  let time = start, stalled = false;
  const line = 110000996, route = 777005;
  const requests = [];
  t.mock.method(api, 'getMapRoute', async (id) => { requests.push(id); return { locations: [] }; });
  const upstream = {
    getSystemTimestamp: async (clientTimestamp) => ({ clientTimestamp, systemTimestamp: clientTimestamp }),
    getCalls: async () => stalled ? new Promise(() => {}) : { calls: [{ calls: [{
      id: '1', journeyId: 1, lineId: line, routeId: route, line: 'Grön', destination: 'Town', sequenceNumber: 1,
      departure: { plannedTime: iso(start + 600000), forecastTime: iso(start + 600000) },
    }] }] },
    getVehiclePosition: async () => null,
  };
  const tracker = createTracker({ api: upstream, now: () => time, initialStops: [{ id: 1, text: 'A' }],
    options: { refreshTimeoutMs: 20, retryDelayMs: 0 } });
  store.set({ lines: [], activeLineIds: new Set(), lineRoutes: new Map(), routeGeometry: new Map(),
    clockOffsetMs: 0, clockSynchronized: false, liveVehicles: [] });
  resetTracking();
  t.after(() => { tracker.close(); applyService(null); resetTracking(); });
  await tracker.collect();
  stalled = true;
  time += CALL_RETENTION_MS + 1;
  const keepAlive = setTimeout(() => {}, 500);
  try { await tracker.collect(); } finally { clearTimeout(keepAlive); }
  const snapshot = { ...tracker.getSnapshot(), epoch: 'expired-calls', revision: 1, catalogVersion: '1' };
  assert.deepEqual(snapshot.observedLines, []);
  assert.deepEqual(snapshot.lineRoutes, {});
  acceptBusesSnapshot(snapshot);
  assert.equal(store.get().lines.some((item) => item.id === line), false);
  assert.deepEqual(requests, []);

  const shape = { locations: [{ lat: 67.85, lon: 20.2 }, { lat: 67.86, lon: 20.21 }] };
  store.set({ lines: [{ id: line, text: 'Grön' }], activeLineIds: new Set([line]),
    lineRoutes: new Map([[line, new Set([route])]]), routeGeometry: new Map([[route, shape]]) });
  acceptBusesSnapshot({ ...snapshot, revision: 2 });
  assert.equal(store.get().routeGeometry.get(route), shape);
  assert.ok(store.get().activeLineIds.has(line));
  assert.equal(routeServiceStatus(store.get().serviceView, line, route), 'unknown');
});
