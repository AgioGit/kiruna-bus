import test from 'node:test';
import assert from 'node:assert/strict';
import { request, api } from '../src/js/api.js';
import { refreshLiveVehicles } from '../src/js/live-vehicles.js';
import { store } from '../src/js/appState.js';
import { failureDelay } from '../src/js/poller.js';
import { isCatalog } from '../src/js/catalog-cache.js';
import { readFileSync } from 'node:fs';
import { CLOCK_SAMPLE_MAX_AGE } from '../src/js/clock.js';

test('client timeout includes stalled response body and remains distinct from cancellation', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_, { signal }) => ({
    ok: true, status: 200, headers: new Headers(),
    text: () => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
  }));
  await assert.rejects(request('/buses', { timeoutMs: 10 }), { code: 'TIMEOUT' });
  const controller = new AbortController();
  const pending = request('/buses', { signal: controller.signal });
  await Promise.resolve();
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('client preserves structured errors and retry timing', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(
    { error: { code: 'WARMING_UP', message: 'Starting live tracking' } }, { status: 503, headers: { 'retry-after': '5' } }));
  await assert.rejects(request('/buses'), { code: 'WARMING_UP', status: 503, retryAfter: 5000 });
  assert.equal(failureDelay(1, 5000, () => 0), 5000);
  assert.equal(failureDelay(20, undefined, () => 0.5), 300000);
});

test('HTTP server-time header carries a non-serialized round-trip age bound', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ serverTime: 'old' },
    { headers: { 'x-server-time': '2026-01-01T10:00:00Z' } }));
  const response = await request('/buses');
  assert.equal(response.serverTime, '2026-01-01T10:00:00Z');
  assert.ok(Number.isFinite(response[CLOCK_SAMPLE_MAX_AGE]));
  assert.ok(response[CLOCK_SAMPLE_MAX_AGE] >= 0);
  assert.equal(Object.keys(response).length, 1);
});

test('late live response cannot mutate state when request generation changed', async (t) => {
  let resolve;
  t.mock.method(api, 'getBuses', () => new Promise((done) => { resolve = done; }));
  const previous = [{ journeyId: 99 }];
  store.set({ liveVehicles: previous });
  let current = true;
  const pending = refreshLiveVehicles({ isCurrent: () => current });
  current = false;
  resolve({ serverTime: new Date().toISOString(), vehicles: [] });
  await pending;
  assert.equal(store.get().liveVehicles, previous);
});

test('browser catalog guard accepts bundled data and rejects broken versions, coordinates and missing shapes', () => {
  const catalog = JSON.parse(readFileSync(new URL('../server/data/bootstrap.json', import.meta.url), 'utf8'));
  assert.equal(isCatalog(catalog), true);
  assert.equal(isCatalog({ ...catalog, schemaVersion: 2 }), false);
  assert.equal(isCatalog({ ...catalog, routes: {} }), false);
  assert.equal(isCatalog({ ...catalog, stops: [{ ...catalog.stops[0], location: { lat: 100, lon: 20 } }] }), false);
});
