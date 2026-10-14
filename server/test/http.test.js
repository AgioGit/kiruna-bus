import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApplication } from '../app.js';
import { loadConfig } from '../lib/config.js';
import { loadCatalog, createCatalog } from '../lib/catalog.js';
import { createTelemetry } from '../lib/telemetry.js';
import { validate } from '../lib/validation.js';

const snapshot = loadCatalog(new URL('../data/bootstrap.json', import.meta.url));
const settings = loadConfig({});
const silent = () => createTelemetry({ write() {} });

async function serve(t, overrides = {}) {
  const telemetry = silent();
  const api = {
    request: async () => ({ status: 200, contentType: 'application/json', body: Buffer.from('[]') }),
    getConfig: async () => { throw new Error('blocked'); },
    getLines: async () => snapshot.lines,
    getCalls: async () => ({ calls: [], messages: [], isStopCancelled: false }),
    getMapRoute: async () => { throw new Error('blocked'); },
    status: () => ({ active: 0, queued: 0 }), close() {}, ...overrides.api,
  };
  const catalog = createCatalog({ snapshot, api, telemetry });
  const tracker = {
    getSnapshot: async () => { throw new Error('not used'); },
    status: () => ({ journeys: 0 }), close() {}, ...overrides.tracker,
  };
  const app = createApplication({ settings: { ...settings, ...overrides.settings }, telemetry, catalog, tracker, api });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(async () => { app.shutdown(); app.server.closeAllConnections(); await new Promise((resolve) => app.server.close(resolve)); });
  return { ...app, base: `http://127.0.0.1:${app.server.address().port}` };
}

test('cold container serves shell, complete bundled catalog and route without upstream', async (t) => {
  const { base } = await serve(t);
  assert.equal((await fetch(base)).status, 200);
  const bootstrap = await fetch(`${base}/api/v1/bootstrap`);
  assert.equal(bootstrap.status, 200);
  const data = validate('bootstrap', await bootstrap.json());
  assert.equal(data.source, 'bundled');
  assert.ok(data.catalog.stops.length > 0);
  const conditional = await fetch(`${base}/api/v1/bootstrap`, { headers: { 'if-none-match': bootstrap.headers.get('etag') } });
  assert.equal(conditional.status, 304);
  const id = Object.keys(snapshot.routes)[0];
  validate('route', await (await fetch(`${base}/api/v1/routes/${id}`)).json());
  assert.equal((await fetch(`${base}/api/live`)).status, 200);
  assert.equal((await fetch(`${base}/api/ready`)).status, 200);
});

test('HTTP validation rejects invalid methods, query, media, coordinates and oversized bodies with CORS', async (t) => {
  const { base } = await serve(t);
  const cases = [
    ['/api/v1/buses', { method: 'POST' }, 405],
    ['/api/v1/stops?unknown=1', {}, 400],
    ['/api/v1/search?q=a&q=b', {}, 400],
    ['/api/ready?unknown=1', {}, 400],
    ['/api/v1/routes/not-an-id', {}, 400],
    ['/api/v1/nearby', { method: 'POST', body: '{}' }, 415],
    ['/api/v1/nearby', { method: 'POST', body: 'invalid', headers: { 'content-type': 'application/json' } }, 400],
    ['/api/v1/nearby', { method: 'POST', body: '{"coordinate":{"lat":100,"lon":20}}', headers: { 'content-type': 'application/json' } }, 400],
    ['/api/v1/nearby', { method: 'POST', body: '{"coordinate":{"lat":67,"lon":20},"maxCount":21}', headers: { 'content-type': 'application/json' } }, 400],
    ['/api/v1/nearby', { method: 'POST', body: '{"coordinate":{"lat":67,"lon":20},"maxDistance":-1}', headers: { 'content-type': 'application/json' } }, 400],
    ['/api/v1/nearby', { method: 'POST', body: '{"coordinate":{"lat":67,"lon":20},"unknown":true}', headers: { 'content-type': 'application/json' } }, 400],
    ['/api/v1/nearby', { method: 'POST', body: JSON.stringify({ padding: 'x'.repeat(66000) }), headers: { 'content-type': 'application/json' } }, 413],
    ['/api/v1/missing', {}, 404],
  ];
  for (const [path, options, status] of cases) {
    const response = await fetch(base + path, { ...options, headers: { ...options.headers, origin: 'https://mhedqvist.github.io' } });
    assert.equal(response.status, status, path);
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://mhedqvist.github.io');
    validate('error', await response.json());
    if (status === 405) assert.equal(response.headers.get('allow'), 'GET');
  }
});

test('local search, resolve, nearby and normalized departure disruptions preserve semantics', async (t) => {
  const stop = snapshot.stops[0];
  const iso = new Date().toISOString();
  const { base } = await serve(t, { api: { getCalls: async () => ({
    calls: [{ calls: [{ id: 'a', lineId: snapshot.lines[0].id, journeyId: 1, sequenceNumber: 1,
      line: 'Line', destination: 'Town', departure: { plannedTime: iso, forecastTime: iso } }] }],
    messages: [{ text: 'Disruption', isDisturbance: true, affectedCalls: ['a'] }], isStopCancelled: true,
  }) } });
  const results = await (await fetch(`${base}/api/v1/search?q=${encodeURIComponent(stop.text)}`)).json();
  assert.deepEqual(results, [stop.text]);
  assert.equal((await (await fetch(`${base}/api/v1/resolve?q=${encodeURIComponent(stop.text)}`)).json()).id, stop.id);
  const nearby = await (await fetch(`${base}/api/v1/nearby`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ coordinate: stop.location, maxCount: 1, maxDistance: 100 }),
  })).json();
  assert.equal(nearby[0].id, stop.id);
  const departures = validate('departures', await (await fetch(`${base}/api/v1/stops/${stop.id}/departures`)).json());
  assert.equal(departures.calls[0].id, 'a');
  assert.equal(departures.isStopCancelled, true);
  assert.deepEqual(departures.messages[0].affectedCalls, ['a']);
});

test('rate limits are explicit and probes remain accessible', async (t) => {
  const { base } = await serve(t, { settings: { clientRequestsPerMinute: 1 } });
  assert.equal((await fetch(`${base}/api/v1/stops`)).status, 200);
  const limited = await fetch(`${base}/api/v1/stops`);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  assert.equal((await fetch(`${base}/api/live`)).status, 200);
});

test('configuration rejects invalid input instead of silently using defaults', () => {
  for (const env of [
    { PORT: 'oops' }, { PORT: '-1' }, { UPSTREAM_TIMEOUT_MS: '0' }, { BOREAL_BASE: 'file:///tmp' },
    { ALLOWED_ORIGINS: 'https://example.com/path' }, { TRUST_PROXY: 'maybe' }, { SNAPSHOT_PATH: '' },
  ]) assert.throws(() => loadConfig(env));
});

test('draining rejects readiness without marking the process dead', async (t) => {
  const app = await serve(t);
  app.shutdown();
  assert.equal((await fetch(`${app.base}/api/ready`)).status, 503);
  assert.equal((await fetch(`${app.base}/api/live`)).status, 200);
});
