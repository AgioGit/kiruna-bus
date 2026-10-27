import test from 'node:test';
import assert from 'node:assert/strict';
import { serviceView, routeServiceStatus, visibleLineCount, applyService, refreshServiceView } from '../src/js/service.js';
import { acceptBusesSnapshot } from '../src/js/live-vehicles.js';
import { resetTracking } from '../src/js/tracking.js';
import { store } from '../src/js/appState.js';
import { CLOCK_SAMPLE_MAX_AGE, now, synchronizeClock } from '../src/js/clock.js';
import { refreshBootstrap } from '../src/js/config.js';
import { api } from '../src/js/api.js';
import { readFileSync } from 'node:fs';

const t0 = Date.parse('2026-10-24T10:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const window = (lineId, routeId, from, until, expiresAt) => ({
  lineId, routeId, from: iso(from), until: iso(until), expiresAt: iso(expiresAt),
});

test('threshold, ongoing trip, expiry and incomplete coverage preserve manual choices', () => {
  const data = { completeUntil: iso(t0 + 600000), windows: [
    window(1, 101, t0 + 1000, t0 + 3600000, t0 + 600000),
    window(2, 202, t0 - 1000, t0 + 3600000, t0 + 600000),
  ] };
  const state = { lines: [{ id: 1 }, { id: 2 }, { id: 3 }], activeLineIds: new Set([1, 2]),
    lineRoutes: new Map([[1, new Set([101])], [2, new Set([202])], [3, new Set([303])]]),
    routeGeometry: new Map([[101, {}], [202, {}], [303, {}]]) };
  state.serviceView = serviceView(data, t0);
  assert.equal(routeServiceStatus(state.serviceView, 1, 101), 'inactive');
  assert.equal(routeServiceStatus(state.serviceView, 2, 202), 'active');
  assert.equal(visibleLineCount(state), 1);
  state.serviceView = serviceView(data, t0 + 1000);
  assert.equal(visibleLineCount(state), 2);
  state.serviceView = serviceView(data, t0 + 600000);
  assert.equal(routeServiceStatus(state.serviceView, 1, 101), 'unknown');
  assert.equal(visibleLineCount(state), 2);
  assert.deepEqual([...state.activeLineIds], [1, 2]);
});

test('timers, duplicate deliveries, stale ordering and older payloads do not renew evidence', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: t0 });
  t.mock.method(performance, 'now', () => Date.now());
  store.set({ clockOffsetMs: 0, clockSynchronized: false });
  resetTracking();
  t.after(() => { applyService(null); resetTracking(); });
  const snapshot = (revision, serverTime, service) => ({
    epoch: 'service-epoch', revision, catalogVersion: '1', generatedAt: iso(t0), serverTime: iso(serverTime),
    vehicles: [], lineRoutes: {}, quality: { state: 'fresh', reasons: [] }, ...(service === undefined ? {} : { service }),
  });
  const service = { completeUntil: iso(t0 + 6000), windows: [window(1, 101, t0 + 1000, t0 + 5000, t0 + 6000)] };
  assert.equal(acceptBusesSnapshot(snapshot(3, t0, service)).outcome, 'new-epoch');
  assert.equal(routeServiceStatus(store.get().serviceView, 1, 101), 'inactive');
  t.mock.timers.tick(1000);
  assert.equal(routeServiceStatus(store.get().serviceView, 1, 101), 'active');
  assert.equal(acceptBusesSnapshot(snapshot(2, t0 + 1000, { completeUntil: iso(t0 + 999999), windows: [] })).outcome, 'stale');
  t.mock.timers.tick(5000);
  assert.equal(routeServiceStatus(store.get().serviceView, 1, 101), 'unknown');
  assert.equal(acceptBusesSnapshot(snapshot(3, t0 + 6000, service)).outcome, 'duplicate');
  assert.equal(routeServiceStatus(store.get().serviceView, 1, 101), 'unknown');
  assert.equal(acceptBusesSnapshot(snapshot(4, t0 + 6000, undefined)).outcome, 'newer');
  assert.equal(store.get().serviceView.complete, false);
  assert.equal(acceptBusesSnapshot(snapshot(5, t0 + 6000, { windows: 'bad' })).outcome, 'invalid');
  assert.equal(acceptBusesSnapshot(snapshot(5, t0 + 6000, { windows: [] })).outcome, 'invalid');
});

test('resuming a suspended tab recomputes expired evidence against the server clock', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: t0 });
  t.mock.method(performance, 'now', () => Date.now());
  t.after(() => applyService(null));
  store.set({ clockOffsetMs: 0, clockSynchronized: false });
  synchronizeClock(iso(t0));
  applyService({ completeUntil: iso(t0 + 6000), windows: [window(1, 1, t0, t0 + 5000, t0 + 6000)] });
  assert.equal(routeServiceStatus(store.get().serviceView, 1, 1), 'active');
  t.mock.timers.setTime(t0 + 10000);
  refreshServiceView();
  assert.equal(routeServiceStatus(store.get().serviceView, 1, 1), 'unknown');
});

test('delayed duplicates, newer snapshots and bootstrap cannot rewind time; newer clock samples still correct it', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: t0 });
  t.mock.method(performance, 'now', () => Date.now());
  store.set({ clockOffsetMs: 0, clockSynchronized: false });
  resetTracking();
  t.after(() => { applyService(null); resetTracking(); store.set({ clockOffsetMs: 0, clockSynchronized: false }); });
  const service = { completeUntil: iso(t0 + 6000), windows: [window(1, 6101, t0, t0 + 60000, t0 + 6000)] };
  const snapshot = { epoch: 'delayed', revision: 1, catalogVersion: '1', generatedAt: iso(t0),
    serverTime: iso(t0), vehicles: [], lineRoutes: {}, quality: { state: 'fresh', reasons: [] }, service };
  acceptBusesSnapshot(snapshot);
  assert.equal(routeServiceStatus(store.get().serviceView, 1, 6101), 'active');
  t.mock.timers.tick(10000);
  assert.equal(routeServiceStatus(store.get().serviceView, 1, 6101), 'unknown');
  assert.equal(acceptBusesSnapshot(snapshot).outcome, 'duplicate');
  assert.equal(now(), t0 + 10000);
  assert.equal(routeServiceStatus(store.get().serviceView, 1, 6101), 'unknown');

  assert.equal(acceptBusesSnapshot({ ...snapshot, serverTime: iso(t0 + 20000) }).outcome, 'duplicate');
  assert.equal(now(), t0 + 20000);
  assert.equal(acceptBusesSnapshot({ ...snapshot, revision: 2, serverTime: iso(t0 + 5000) }).outcome, 'newer');
  assert.equal(now(), t0 + 20000);
  assert.equal(routeServiceStatus(store.get().serviceView, 1, 6101), 'unknown');

  const catalog = JSON.parse(readFileSync(new URL('../server/data/bootstrap.json', import.meta.url), 'utf8'));
  t.mock.method(api, 'getBootstrap', async () => ({ catalog, source: 'test', serverTime: iso(t0 + 3000) }));
  t.mock.method(console, 'warn', () => {});
  await refreshBootstrap({ force: true });
  assert.equal(now(), t0 + 20000);
  assert.equal(routeServiceStatus(store.get().serviceView, 1, 6101), 'unknown');
});

test('bounded HTTP clock correction moves backward and re-evaluates absolute deadlines', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: t0 });
  t.mock.method(performance, 'now', () => Date.now());
  store.set({ clockOffsetMs: 0, clockSynchronized: false });
  resetTracking();
  t.after(() => { applyService(null); resetTracking(); store.set({ clockOffsetMs: 0, clockSynchronized: false }); });
  const service = { completeUntil: iso(t0 + 6000), windows: [window(1, 101, t0, t0 + 60000, t0 + 6000)] };
  const snapshot = { epoch: 'correction', revision: 1, catalogVersion: '1', generatedAt: iso(t0),
    serverTime: iso(t0), vehicles: [], lineRoutes: {}, quality: { state: 'fresh', reasons: [] }, service };
  acceptBusesSnapshot(snapshot);
  t.mock.timers.tick(10000);
  const delayed = { ...snapshot };
  Object.defineProperty(delayed, CLOCK_SAMPLE_MAX_AGE, { value: 10000 });
  acceptBusesSnapshot(delayed);
  assert.equal(now(), t0 + 10000);

  const corrected = { ...snapshot, serverTime: iso(t0 + 8000) };
  Object.defineProperty(corrected, CLOCK_SAMPLE_MAX_AGE, { value: 100 });
  acceptBusesSnapshot(corrected);
  assert.equal(now(), t0 + 8100);
  assert.equal(routeServiceStatus(store.get().serviceView, 1, 101), 'unknown');
  t.mock.timers.tick(1000);
  assert.equal(now(), t0 + 9100);
  t.mock.timers.tick(2000);
  assert.equal(now(), t0 + 11100);
  assert.equal(routeServiceStatus(store.get().serviceView, 1, 101), 'unknown');
});

test('bounded buses correct a fast bootstrap and restore still-valid service', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: t0 });
  t.mock.method(performance, 'now', () => Date.now());
  store.set({ clockOffsetMs: 0, clockSynchronized: false, liveVehicles: [] });
  resetTracking();
  t.after(() => { applyService(null); resetTracking(); store.set({ clockOffsetMs: 0, clockSynchronized: false }); });
  const catalog = JSON.parse(readFileSync(new URL('../server/data/bootstrap.json', import.meta.url), 'utf8'));
  const bootstrap = { catalog, source: 'test', serverTime: iso(t0 + 3600000) };
  Object.defineProperty(bootstrap, CLOCK_SAMPLE_MAX_AGE, { value: 0 });
  t.mock.method(api, 'getBootstrap', async () => bootstrap);
  t.mock.method(console, 'warn', () => {});
  await refreshBootstrap({ force: true });
  t.mock.timers.tick(1000);
  assert.equal(now(), t0 + 3601000);
  const service = { completeUntil: iso(t0 + 6100), windows: [window(1, 7101, t0, t0 + 60000, t0 + 6100)] };
  const snapshot = { epoch: 'fast-bootstrap', revision: 1, catalogVersion: '1', generatedAt: iso(t0),
    serverTime: iso(t0 + 1000), vehicles: [], lineRoutes: {}, quality: { state: 'fresh', reasons: [] }, service };
  Object.defineProperty(snapshot, CLOCK_SAMPLE_MAX_AGE, { value: 0 });
  acceptBusesSnapshot(snapshot);
  assert.equal(now(), t0 + 1000);
  assert.equal(routeServiceStatus(store.get().serviceView, 1, 7101), 'active');
  t.mock.timers.tick(5100);
  assert.equal(routeServiceStatus(store.get().serviceView, 1, 7101), 'unknown');
  const corrected = { ...snapshot, serverTime: iso(t0 + 4000) };
  Object.defineProperty(corrected, CLOCK_SAMPLE_MAX_AGE, { value: 0 });
  acceptBusesSnapshot(corrected);
  assert.equal(now(), t0 + 4000);
  assert.equal(routeServiceStatus(store.get().serviceView, 1, 7101), 'active');
  acceptBusesSnapshot({ ...snapshot, revision: 2, serverTime: iso(t0 + 1000) });
  assert.equal(now(), t0 + 4000);
  assert.equal(routeServiceStatus(store.get().serviceView, 1, 7101), 'active');
  acceptBusesSnapshot({ ...snapshot, revision: 3, serverTime: iso(t0 + 4000), service: undefined });
  assert.equal(routeServiceStatus(store.get().serviceView, 1, 7101), 'unknown');
  acceptBusesSnapshot({ ...snapshot, revision: 4, serverTime: iso(t0 + 4000) });
  assert.equal(routeServiceStatus(store.get().serviceView, 1, 7101), 'active');
  assert.equal(routeServiceStatus(store.get().serviceView, 1, 7102), 'inactive');
  const freshService = { completeUntil: iso(t0 + 12000), windows: [window(1, 7101, t0, t0 + 60000, t0 + 12000)] };
  acceptBusesSnapshot({ ...snapshot, revision: 5, serverTime: iso(t0 + 4000), service: freshService });
  assert.equal(routeServiceStatus(store.get().serviceView, 1, 7101), 'active');
  t.mock.timers.tick(1000);
  assert.equal(now(), t0 + 5000);
  t.mock.timers.tick(60000);
  const later = { ...snapshot, revision: 6, serverTime: iso(t0 + 65000), service: freshService };
  Object.defineProperty(later, CLOCK_SAMPLE_MAX_AGE, { value: 0 });
  acceptBusesSnapshot(later);
  assert.equal(now(), t0 + 65000);
  assert.equal(routeServiceStatus(store.get().serviceView, 1, 7101), 'unknown');
});

test('a bounded correction re-evaluates ended and reshaped windows against corrected time', (t) => {
  const start = t0 + 86400000;
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start });
  t.mock.method(performance, 'now', () => Date.now());
  store.set({ clockOffsetMs: 0, clockSynchronized: false });
  resetTracking();
  t.after(() => { applyService(null); resetTracking(); store.set({ clockOffsetMs: 0, clockSynchronized: false }); });
  const snapshot = { epoch: 'reshaped', revision: 1, catalogVersion: '1', generatedAt: iso(start),
    serverTime: iso(start), vehicles: [], lineRoutes: {}, quality: { state: 'fresh', reasons: [] },
    service: { completeUntil: null, windows: [window(1, 9101, start, start + 5000, start + 60000)] } };
  acceptBusesSnapshot(snapshot);
  assert.equal(routeServiceStatus(store.get().serviceView, 1, 9101), 'active');
  t.mock.timers.tick(5001);
  assert.equal(routeServiceStatus(store.get().serviceView, 1, 9101), 'unknown');
  const corrected = { ...snapshot, serverTime: iso(start + 4000) };
  Object.defineProperty(corrected, CLOCK_SAMPLE_MAX_AGE, { value: 0 });
  acceptBusesSnapshot(corrected);
  assert.equal(now(), start + 4000);
  assert.equal(routeServiceStatus(store.get().serviceView, 1, 9101), 'active');
  const extended = { completeUntil: null, windows: [window(1, 9101, start, start + 9000, start + 60000)] };
  acceptBusesSnapshot({ ...snapshot, revision: 2, serverTime: iso(start + 4000), service: extended });
  assert.equal(routeServiceStatus(store.get().serviceView, 1, 9101), 'active');
  t.mock.timers.tick(5001);
  assert.equal(routeServiceStatus(store.get().serviceView, 1, 9101), 'unknown');
});

test('a fresh scan with the same expiry after a real clock correction remains usable', (t) => {
  const start = t0 + 2 * 86400000;
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start });
  t.mock.method(performance, 'now', () => Date.now());
  store.set({ clockOffsetMs: 0, clockSynchronized: false });
  resetTracking();
  t.after(() => { applyService(null); resetTracking(); store.set({ clockOffsetMs: 0, clockSynchronized: false }); });
  const expires = start + 10 * 60000;
  const service = { completeUntil: iso(expires), windows: [window(1, 101, start, start + 3600000, expires)] };
  const snapshot = { epoch: 'same-expiry', revision: 1, catalogVersion: '1', generatedAt: iso(start),
    serverTime: iso(start + 4 * 60000), vehicles: [], lineRoutes: {}, quality: { state: 'fresh', reasons: [] }, service };
  acceptBusesSnapshot(snapshot);
  assert.equal(routeServiceStatus(store.get().serviceView, 1, 101), 'active');
  t.mock.timers.tick(10 * 60000);
  assert.equal(routeServiceStatus(store.get().serviceView, 1, 101), 'unknown');
  const fresh = { ...snapshot, revision: 2, serverTime: iso(start + 4 * 60000) };
  Object.defineProperty(fresh, CLOCK_SAMPLE_MAX_AGE, { value: 0 });
  acceptBusesSnapshot(fresh);
  assert.equal(now(), start + 4 * 60000);
  assert.equal(routeServiceStatus(store.get().serviceView, 1, 101), 'active');
  assert.equal(store.get().serviceView.complete, true);
  acceptBusesSnapshot({ ...fresh, serverTime: iso(start + 3 * 60000) });
  assert.equal(now(), start + 4 * 60000);
  t.mock.timers.tick(6 * 60000);
  assert.equal(routeServiceStatus(store.get().serviceView, 1, 101), 'unknown');
  acceptBusesSnapshot({ ...snapshot, revision: 2, serverTime: iso(start + 4 * 60000) });
  assert.equal(routeServiceStatus(store.get().serviceView, 1, 101), 'unknown');
});

test('48 hours of changing service observations retain only the current view', (t) => {
  const start = t0 + 4 * 86400000;
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start });
  t.mock.method(performance, 'now', () => Date.now());
  store.set({ clockOffsetMs: 0, clockSynchronized: false });
  t.after(() => { applyService(null); store.set({ clockOffsetMs: 0, clockSynchronized: false }); });
  synchronizeClock(iso(start));
  for (let cycle = 0; cycle < 48 * 60 * 2; cycle++) {
    const time = start + cycle * 30000;
    t.mock.timers.setTime(time);
    applyService({ completeUntil: iso(time + 60000), windows: Array.from({ length: 20 }, (_, i) =>
      window(i + 1, i + 101, time, time + 300000, time + 60000)) });
    assert.equal(store.get().serviceView.active.size, 20);
  }
  applyService(null);
  assert.equal(store.get().serviceView.active.size, 0);
  assert.equal(store.get().serviceView.next, Infinity);
});

test('device wall-clock jumps do not affect synchronized service expiry or bounded corrections', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: t0 });
  let monotonic = 1000, wall = t0;
  t.mock.method(performance, 'now', () => monotonic);
  t.mock.method(Date, 'now', () => wall);
  store.set({ clockOffsetMs: 0, clockSynchronized: false });
  resetTracking();
  t.after(() => { applyService(null); resetTracking(); store.set({ clockOffsetMs: 0, clockSynchronized: false }); });
  const service = { completeUntil: iso(t0 + 6000), windows: [window(1, 8101, t0, t0 + 60000, t0 + 6000)] };
  const snapshot = { epoch: 'wall-jumps', revision: 1, catalogVersion: '1', generatedAt: iso(t0),
    serverTime: iso(t0), vehicles: [], lineRoutes: {}, quality: { state: 'fresh', reasons: [] }, service };
  acceptBusesSnapshot(snapshot);
  monotonic += 1000;
  wall += 1000;
  t.mock.timers.tick(1000);
  assert.equal(now(), t0 + 1000);
  assert.equal(routeServiceStatus(store.get().serviceView, 1, 8101), 'active');

  wall += 3600000;
  assert.equal(now(), t0 + 1000);
  const correction = { ...snapshot, serverTime: iso(t0 + 1000) };
  Object.defineProperty(correction, CLOCK_SAMPLE_MAX_AGE, { value: 0 });
  acceptBusesSnapshot(correction);
  assert.equal(now(), t0 + 1000);
  wall -= 7200000;
  assert.equal(now(), t0 + 1000);

  monotonic += 5001;
  wall += 5001;
  t.mock.timers.tick(5001);
  assert.equal(now(), t0 + 6001);
  assert.equal(routeServiceStatus(store.get().serviceView, 1, 8101), 'unknown');
  acceptBusesSnapshot(snapshot);
  assert.equal(now(), t0 + 6001);
  assert.equal(routeServiceStatus(store.get().serviceView, 1, 8101), 'unknown');
  wall = t0 + 7200000;
  monotonic += 60000;
  t.mock.timers.tick(60000);
  assert.equal(now(), t0 + 66001);
  assert.equal(routeServiceStatus(store.get().serviceView, 1, 8101), 'unknown');
});
