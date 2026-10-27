import test from 'node:test';
import assert from 'node:assert/strict';
import { store } from '../src/js/appState.js';
import { api } from '../src/js/api.js';
import { fetchCallsForSelectedStop, resetSelectedStopCalls } from '../src/js/calls.js';

test('old payloads work and delayed stop responses cannot leak observations', async (t) => {
  const timestamp = new Date().toISOString();
  let resolve;
  t.mock.method(api, 'getCalls', () => new Promise((done) => { resolve = done; }));
  store.set({ selectedStop: { id: 1 }, stopSelectionSeq: 1, calls: [], previousDeparture: null });
  const request = fetchCallsForSelectedStop();
  resetSelectedStopCalls();
  store.set({ selectedStop: { id: 2 }, stopSelectionSeq: 2, calls: [], previousDeparture: null });
  resolve({ calls: [], messages: [], isStopCancelled: false, updatedAt: timestamp, state: 'fresh',
    previousDeparture: { call: { id: 'old' } } });
  await request;
  assert.equal(store.get().previousDeparture, null);
  assert.deepEqual(store.get().calls, []);

  api.getCalls.mock.mockImplementation(async () => ({
    calls: [], messages: [], isStopCancelled: false, updatedAt: timestamp, state: 'fresh',
  }));
  await fetchCallsForSelectedStop();
  assert.equal(store.get().previousDeparture, null);
  assert.equal(store.get().errors.calls, null);
  resetSelectedStopCalls();
  store.set({ selectedStop: null });
});

test('history discovers only safe line labels without selecting known lines or creating service', async (t) => {
  const timestamp = new Date().toISOString();
  const past = new Date(Date.now() - 1000).toISOString();
  const future = new Date(Date.now() + 60000).toISOString();
  const observation = (lineId, line, time = past) => ({
    call: { id: String(lineId), lineId, line, routeId: 999, destination: 'Town',
      departure: { plannedTime: time, forecastTime: time } },
    observedAt: timestamp, isStopCancelled: false, messages: [],
  });
  const previous = observation(99, 'Line 99');
  t.mock.method(api, 'getCalls', async () => ({
    calls: [], messages: [], isStopCancelled: false, updatedAt: timestamp, state: 'fresh',
    previousDeparture: previous,
    pendingDepartures: [observation(0, 'Invalid', future), observation(100, '  ', future),
      observation(Number.MAX_SAFE_INTEGER + 1, 'Unsafe', future)],
  }));
  t.mock.method(api, 'getMapRoute', async () => { throw new Error('History must not request routes'); });
  resetSelectedStopCalls();
  store.set({ selectedStop: { id: 1 }, stopSelectionSeq: 3, calls: [], previousDeparture: null,
    lines: [{ id: 1, text: 'Line 1' }], activeLineIds: new Set(), lineRoutes: new Map(),
    routeGeometry: new Map(), liveVehicles: [], serviceView: { active: new Set(), complete: false } });
  t.after(() => { resetSelectedStopCalls(); store.set({ selectedStop: null }); });
  await fetchCallsForSelectedStop();
  assert.deepEqual(store.get().lines, [{ id: 1, text: 'Line 1' }, { id: 99, text: 'Line 99' }]);
  assert.deepEqual([...store.get().activeLineIds], [99]);
  assert.equal(store.get().previousDeparture.call.id, '99');
  assert.equal(store.get().lineRoutes.size, 0);
  assert.equal(store.get().routeGeometry.size, 0);
  assert.equal(store.get().serviceView.active.size, 0);
  assert.deepEqual(store.get().liveVehicles, []);
  assert.equal(api.getMapRoute.mock.callCount(), 0);
  store.set({ activeLineIds: new Set() });
  await fetchCallsForSelectedStop();
  assert.deepEqual([...store.get().activeLineIds], []);
});
