import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../src/js/api.js';
import { store } from '../src/js/appState.js';
import { selectStopArea, clearSelectedStop } from '../src/js/stops.js';

test('switching stops clears previous departures and ignores the old response', async () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const originalGetCalls = api.getCalls;
  const pending = new Map();
  globalThis.setInterval = () => 1;
  globalThis.clearInterval = () => {};
  api.getCalls = ({ stopId }) =>
    new Promise((resolve) => pending.set(stopId, resolve));

  try {
    store.set({ calls: [{ id: 'previous', lineId: 1 }] });
    selectStopArea({ id: 1, text: 'First (1)' });
    assert.deepEqual(store.get().calls, []);
    assert.equal(store.get().isCallsLoading, true);

    selectStopArea({ id: 2, text: 'Second (2)' });
    pending.get(1)({ calls: [{ id: 'old', lineId: 1 }] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(store.get().calls, []);
    assert.equal(store.get().isCallsLoading, true);

    pending.get(2)({ calls: [{ id: 'new', lineId: 1 }] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(store.get().calls.map((call) => call.id), ['new']);
    assert.equal(store.get().isCallsLoading, false);
  } finally {
    clearSelectedStop();
    api.getCalls = originalGetCalls;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});
