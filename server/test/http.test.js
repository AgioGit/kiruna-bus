import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApplication } from '../app.js';
import { loadConfig } from '../lib/config.js';
import { loadCatalog, createCatalog } from '../lib/catalog.js';
import { createTelemetry } from '../lib/telemetry.js';
import { validate } from '../lib/validation.js';
import { AppError } from '../lib/errors.js';

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
    getSnapshot: () => { throw new Error('not used'); },
    getBuses: () => { throw new Error('not used'); },
    getStopCalls: () => null,
    getRevision: () => 0,
    getLineRoutes: () => ({}),
    collect: async () => {},
    serverTime: () => new Date().toISOString(),
    status: () => ({ journeys: 0 }), close() {}, ...overrides.tracker,
  };
  const app = createApplication({ settings: { ...settings, ...overrides.settings }, telemetry, catalog, tracker, api,
    now: overrides.now });
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
  const call = { id: 'a', lineId: snapshot.lines[0].id, journeyId: 1, sequenceNumber: 1,
    line: 'Line', destination: 'Town', departure: { plannedTime: iso, forecastTime: iso } };
  const message = { text: 'Disruption', isDisturbance: true, affectedCalls: ['a'],
    lines: [{ lineId: call.lineId, lineName: 'Line', lineAppearance: { background: '#000000' } }] };
  const observation = { call, observedAt: iso, isStopCancelled: true, messages: [message] };
  const { base } = await serve(t, { tracker: { getStopCalls: (id) => (id !== stop.id ? null : {
    calls: [call], messages: [message], isStopCancelled: true,
    at: Date.now(),
  }), getDepartureHistory: () => ({ previous: observation, pending: [observation] }) } });
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
  const normalizedMessage = { text: 'Disruption', isDisturbance: true, affectedCalls: ['a'], lines: [{ lineId: call.lineId }] };
  assert.deepEqual(departures.messages[0], normalizedMessage);
  assert.deepEqual(departures.previousDeparture.messages[0], normalizedMessage);
  assert.deepEqual(departures.pendingDepartures[0].messages[0], normalizedMessage);
});

test('rate limits are explicit and probes remain accessible', async (t) => {
  const { base } = await serve(t, { settings: { clientRequestsPerMinute: 1 } });
  assert.equal((await fetch(`${base}/api/v1/stops`)).status, 200);
  const limited = await fetch(`${base}/api/v1/stops`);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  assert.equal((await fetch(`${base}/api/live`)).status, 200);
});

test('client-rejected requests preserve the global quota and limits reset at one minute', async (t) => {
  let time = Date.parse('2026-01-01T12:00:00Z');
  const { base } = await serve(t, {
    settings: { trustProxy: true, clientRequestsPerMinute: 1, globalRequestsPerMinute: 3 },
    now: () => time,
  });
  const request = async (address, status) => {
    const response = await fetch(`${base}/api/v1/search?q=station`, {
      headers: { 'x-forwarded-for': address },
    });
    assert.equal(response.status, status);
    if (status === 429) {
      assert.equal(response.headers.get('retry-after'), '60');
      assert.equal(validate('error', await response.json()).error.code, 'RATE_LIMITED');
    } else await response.json();
  };

  await request('192.0.2.1', 200);
  for (let i = 0; i < 5; i++) await request('192.0.2.1', 429);
  await request('192.0.2.2', 200);
  await request('192.0.2.3', 200);
  await request('192.0.2.4', 429);

  time += 59999;
  await request('192.0.2.4', 429);
  time++;
  await request('192.0.2.1', 200);
  await request('192.0.2.2', 200);
  await request('192.0.2.3', 200);
  await request('192.0.2.4', 429);
});

test('configuration rejects invalid input instead of silently using defaults', () => {
  for (const env of [
    { PORT: 'oops' }, { PORT: '-1' }, { UPSTREAM_TIMEOUT_MS: '0' }, { BOREAL_BASE: 'file:///tmp' },
    { ALLOWED_ORIGINS: 'https://example.com/path' }, { TRUST_PROXY: 'maybe' }, { SNAPSHOT_PATH: '' },
    { DYNAMIC_INTERVAL_MS: '29999' }, { DYNAMIC_INTERVAL_MS: '60001' },
    { STREAM_HEARTBEAT_MS: '999' }, { STREAM_HEARTBEAT_MS: '15001' },
    { STREAM_MAX_CONNECTIONS: '0' }, { STREAM_MAX_PENDING_BYTES: '0' },
  ]) assert.throws(() => loadConfig(env));
  assert.equal(loadConfig({ DYNAMIC_INTERVAL_MS: '60000' }).dynamicIntervalMs, 60000);
  assert.equal(loadConfig({ DYNAMIC_INTERVAL_MS: '30000' }).dynamicIntervalMs, 30000);
});

test('basic resources and probes do not activate the source collector', async (t) => {
  let collections = 0;
  const app = await serve(t, { tracker: { collect: async () => { collections++; } } });
  for (const path of ['/api/live', '/api/ready', '/api/status', '/api/v1/bootstrap', '/api/v1/stops']) {
    assert.equal((await fetch(app.base + path)).status, 200);
  }
  await new Promise(setImmediate);
  assert.equal(collections, 0);
  assert.equal(app.collector.isActive(), false);
});

test('legacy cold reads wait on one shared collection and preserve the unversioned response shape', async (t) => {
  let ready = false, collections = 0;
  const data = {
    generatedAt: new Date().toISOString(), serverTime: new Date().toISOString(), vehicles: [], lineRoutes: {},
    quality: { state: 'fresh', reasons: [], scan: { attempted: 1, succeeded: 1, failed: 0 },
      positions: { attempted: 0, succeeded: 0, failed: 0 }, lastScanAt: null, positionsAt: null, clockSynchronized: true },
  };
  const read = () => {
    if (!ready) throw new AppError('WARMING_UP', 'Warming up', { status: 503 });
    return data;
  };
  const app = await serve(t, { tracker: {
    getBuses: read, getSnapshot: read, collect: async () => { collections++; ready = true; },
  } });
  const responses = await Promise.all(Array.from({ length: 6 }, () => fetch(`${app.base}/api/buses`)));
  for (const response of responses) {
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.epoch, undefined);
    assert.deepEqual(body.vehicles, []);
  }
  assert.equal(collections, 1);
  const versioned = validate('buses', await (await fetch(`${app.base}/api/v1/buses`)).json());
  assert.equal(versioned.epoch, app.collector.epoch);
  assert.equal(collections, 1);
});

test('failed-stop departures preserve source time and expire only after the exact three-minute boundary', async (t) => {
  let time = Date.parse('2026-01-01T12:00:00Z');
  const at = time;
  const app = await serve(t, { now: () => time, tracker: {
    getStopCalls: () => ({ calls: [], messages: [], isStopCancelled: true, at, failed: true }),
  } });
  const url = `${app.base}/api/v1/stops/${snapshot.stops[0].id}/departures`;
  const retained = validate('departures', await (await fetch(url)).json());
  assert.equal(retained.state, 'stale');
  assert.equal(retained.updatedAt, new Date(at).toISOString());
  assert.equal(retained.isStopCancelled, true);
  time += 180000;
  assert.equal((await fetch(url)).status, 200);
  time++;
  const expired = await fetch(url);
  assert.equal(expired.status, 503);
  assert.equal(expired.headers.get('retry-after'), '5');
  assert.equal((await expired.json()).error.code, 'DEPARTURES_UNAVAILABLE');
});

test('expired live calls can expose historical observation without claiming a fresh response', async (t) => {
  const time = Date.parse('2026-01-01T12:05:00Z');
  const observedAt = new Date(time - 300000).toISOString();
  const previous = { observedAt, isStopCancelled: false, messages: [],
    call: { id: 'old', lineId: 1, journeyId: 1, sequenceNumber: 1, line: 'Red', destination: 'Town',
      departure: { plannedTime: observedAt, forecastTime: observedAt } } };
  const app = await serve(t, { now: () => time, tracker: {
    getStopCalls: () => ({ calls: [previous.call], messages: [], isStopCancelled: false, at: time - 300000 }),
    getPreviousDeparture: () => previous,
  } });
  const data = validate('departures', await (await fetch(`${app.base}/api/v1/stops/${snapshot.stops[0].id}/departures`)).json());
  assert.equal(data.state, 'unavailable');
  assert.deepEqual(data.calls, []);
  assert.equal(data.updatedAt, observedAt);
  assert.equal(data.previousDeparture.call.id, 'old');
});

test('pruned future observations survive unavailable live data without appearing as live calls', async (t) => {
  const time = Date.parse('2026-01-01T12:05:00Z');
  const observedAt = new Date(time - 300000).toISOString();
  const pending = { observedAt, isStopCancelled: false, messages: [],
    call: { id: 'pending', lineId: 1, journeyId: 1, sequenceNumber: 1, line: 'Red', destination: 'Town',
      departure: { plannedTime: new Date(time + 60000).toISOString(), forecastTime: null } } };
  const app = await serve(t, { now: () => time, tracker: {
    getStopCalls: () => null,
    getDepartureHistory: () => ({ previous: null, pending: [pending] }),
  } });
  const data = validate('departures', await (await fetch(`${app.base}/api/v1/stops/${snapshot.stops[0].id}/departures`)).json());
  assert.equal(data.state, 'unavailable');
  assert.deepEqual(data.calls, []);
  assert.equal(data.previousDeparture, null);
  assert.equal(data.pendingDepartures[0].call.id, 'pending');
});

test('draining rejects readiness without marking the process dead', async (t) => {
  const app = await serve(t);
  app.shutdown();
  assert.equal((await fetch(`${app.base}/api/ready`)).status, 503);
  assert.equal((await fetch(`${app.base}/api/live`)).status, 200);
});
