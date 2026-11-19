import test from 'node:test';
import assert from 'node:assert/strict';
import { createPassthrough } from '../lib/passthrough.js';
import { TtlCache } from '../lib/cache.js';

function fakeRequest(status = 200) {
  const timestamp = '2026-10-25T10:00:00Z';
  const data = {
    '/GetLines': [{ id: 1, text: 'Town' }],
    '/GetCalls': { calls: [] },
    '/GetMapRoute': { locations: [{ lat: 67.8, lon: 20.1 }, { lat: 67.9, lon: 20.2 }] },
    '/GetSystemTimestamp': { clientTimestamp: timestamp, systemTimestamp: timestamp },
    '/GetConfigOptions': { minZoom: 10, tiles: { urlTemplate: 'https://example.test/{z}/{x}/{y}.png' } },
  };
  const calls = [];
  const request = async (path, options) => {
    calls.push({ path, ...options });
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { status, body: Buffer.from(JSON.stringify(data[path])) };
  };
  return { request, calls };
}

test('caches cacheable endpoints and reports HIT/MISS', async () => {
  const { request, calls } = fakeRequest();
  const passthrough = createPassthrough({ request });

  const first = await passthrough('/GetLines', { method: 'GET' });
  const second = await passthrough('/GetLines', { method: 'GET' });
  assert.equal(first.cache, 'MISS');
  assert.equal(second.cache, 'HIT');
  assert.equal(calls.length, 1);
});

test('keys include the query string and POST body', async () => {
  const { request, calls } = fakeRequest();
  const passthrough = createPassthrough({ request });
  await passthrough('/GetCalls', { method: 'POST', body: '{"a":1}' });
  await passthrough('/GetCalls', { method: 'POST', body: '{"a":2}' });
  await passthrough('/GetMapRoute', { method: 'GET', search: '?routeId=1' });
  await passthrough('/GetMapRoute', { method: 'GET', search: '?routeId=2' });
  assert.equal(calls.length, 4);
});

test('never caches GetSystemTimestamp and does not cache non-200 responses', async () => {
  const ok = fakeRequest();
  const a = createPassthrough({ request: ok.request });
  await a('/GetSystemTimestamp', { method: 'GET', search: '?clientTimestamp=x' });
  const again = await a('/GetSystemTimestamp', { method: 'GET', search: '?clientTimestamp=x' });
  assert.equal(again.cache, 'BYPASS');
  assert.equal(ok.calls.length, 2);

  const bad = fakeRequest(500);
  const b = createPassthrough({ request: bad.request });
  await assert.rejects(b('/GetLines', { method: 'GET' }), { code: 'UPSTREAM_REJECTED' });
  await assert.rejects(b('/GetLines', { method: 'GET' }), { code: 'UPSTREAM_REJECTED' });
  assert.equal(bad.calls.length, 2);
});

test('identical concurrent requests share one upstream call', async () => {
  const { request, calls } = fakeRequest();
  const passthrough = createPassthrough({ request });
  await Promise.all([1, 2, 3].map(() => passthrough('/GetLines', { method: 'GET' })));
  assert.equal(calls.length, 1);
});

test('GetConfigOptions is requested without profile headers', async () => {
  const { request, calls } = fakeRequest();
  const passthrough = createPassthrough({ request });
  await passthrough('/GetConfigOptions', { method: 'GET', search: '?profile=&language=sv' });
  await passthrough('/GetLines', { method: 'GET' });
  assert.equal(calls[0].profile, false);
  assert.equal(calls[1].profile, true);
});

test('TtlCache expires entries and evicts the oldest when full', () => {
  let t = 0;
  const cache = new TtlCache({ maxEntries: 2, now: () => t });
  cache.set('a', 1, 100);
  cache.set('b', 2, 100);
  cache.set('c', 3, 100);
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('c'), 3);
  t = 101;
  assert.equal(cache.get('c'), undefined);
});
