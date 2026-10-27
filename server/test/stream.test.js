import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { createApplication } from '../app.js';
import { loadConfig } from '../lib/config.js';
import { createTelemetry } from '../lib/telemetry.js';
import { validate } from '../lib/validation.js';
import { AppError } from '../lib/errors.js';

const settings = loadConfig({});
const silent = () => createTelemetry({ write() {} });

function bus(key) {
  return {
    key, journeyId: 1, lineId: 1, line: 'Line', destination: 'Town', ageMs: 0, stale: false,
    position: { location: { lat: 67.85, lon: 20.22 }, timestamp: new Date().toISOString() },
    nextStop: { stopText: null, plannedTime: null, forecastTime: null }, followingStop: null, upcomingStops: [],
  };
}

function makeTrackerDouble(initialState = {}) {
  const state = {
    revision: 0,
    snapshotThrows: true,
    snapshotValue: { vehicles: [], service: { completeUntil: null, windows: [] }, observedLines: [] },
    quality: {
      state: 'unavailable', reasons: [], scan: { attempted: 0, succeeded: 0, failed: 0 },
      positions: { attempted: 0, succeeded: 0, failed: 0 }, lastScanAt: null, positionsAt: null, clockSynchronized: true,
    },
    ...initialState,
  };
  const tracker = {
    async collect() {},
    getSnapshot() {
      if (state.snapshotThrows) {
        throw new AppError('WARMING_UP', 'Live tracking is warming up. Basic map information is available.', { status: 503 });
      }
      return {
        generatedAt: new Date().toISOString(), serverTime: new Date().toISOString(),
        lineRoutes: {}, quality: state.quality, ...state.snapshotValue,
      };
    },
    getBuses() { return tracker.getSnapshot(); },
    getStopCalls: () => null,
    getRevision: () => state.revision,
    getLineRoutes: () => ({}),
    serverTime: () => new Date().toISOString(),
    status: () => ({ journeys: 0, quality: state.quality }),
    close() {},
  };
  return { tracker, state };
}

function makeCatalogDouble(initialState = {}) {
  const state = { version: 'v1', ...initialState };
  const catalog = {
    async refresh() { return { changed: false }; },
    get: () => ({ version: state.version, stops: [] }),
    bootstrap: () => ({ source: 'bundled', catalog: { stops: [], lines: [], routes: {}, lineRoutes: {} }, capturedAt: new Date().toISOString() }),
    route: async () => ({ locations: [] }),
    stop: () => { throw new AppError('NOT_FOUND', 'Unknown stop', { status: 404 }); },
    close() {},
  };
  return { catalog, state };
}

async function serve(t, overrides = {}) {
  const telemetry = silent();
  const { tracker, state: trackerState } = makeTrackerDouble(overrides.trackerState);
  const { catalog, state: catalogState } = makeCatalogDouble(overrides.catalogState);
  const api = { status: () => ({}), close() {}, ...overrides.api };
  const mergedSettings = { ...settings, ...overrides.settings };
  const app = createApplication({ settings: mergedSettings, telemetry, catalog, tracker, api });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(async () => {
    app.shutdown();
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  });
  return { ...app, base: `http://127.0.0.1:${app.server.address().port}`, trackerState, catalogState };
}

// -- A small real (unmocked) SSE client: opens a connection via node:http so
// we can read the raw text/event-stream body incrementally and control
// exactly when (or whether) it is consumed, which plain fetch() cannot do
// reliably for the backpressure tests below.
function parseFrame(raw) {
  const frame = { comment: null, event: null, id: null, data: null };
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) frame.comment = line.slice(1).trim();
    else if (line.startsWith('event:')) frame.event = line.slice(6).trim();
    else if (line.startsWith('id:')) frame.id = line.slice(3).trim();
    else if (line.startsWith('data:')) frame.data = line.slice(5).trim();
  }
  return frame;
}

function sseReader(res) {
  let buffer = '';
  const pending = [];
  const waiters = [];
  function drain() {
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const frame = parseFrame(raw);
      const waiter = waiters.shift();
      if (waiter) waiter(frame); else pending.push(frame);
    }
  }
  res.on('data', (chunk) => { buffer += chunk.toString('utf8'); drain(); });
  return {
    next(timeoutMs = 2000) {
      if (pending.length) return Promise.resolve(pending.shift());
      return new Promise((resolve, reject) => {
        const waiter = (frame) => { clearTimeout(timer); resolve(frame); };
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(waiter);
          if (idx !== -1) waiters.splice(idx, 1);
          reject(new Error('Timed out waiting for an SSE frame'));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
}

function openStream(base, { origin = 'https://mhedqvist.github.io', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}/api/v1/stream`, { method: 'GET', headers: { origin, ...headers } });
    req.on('response', (res) => resolve({ req, res }));
    req.on('error', reject);
    req.end();
  });
}

// The very first activity against a fresh collector (here: the first SSE
// connection in a test) immediately kicks one overdue dynamic AND one
// overdue static cycle (see collector.js). Those complete asynchronously
// moments after connect and broadcast an extra frame that, as long as
// nothing has actually changed yet, repeats the same id/content as the
// direct initial send. Drain until the stream goes quiet so later
// assertions observe only the update under test, not this startup noise.
async function drainSettled(reader, quietMs = 200) {
  const seen = [];
  for (;;) {
    try { seen.push(await reader.next(quietMs)); }
    catch { return seen; }
  }
}

test('SSE response carries the expected transport headers and CORS', async (t) => {
  const { base } = await serve(t);
  const { req, res } = await openStream(base);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /^text\/event-stream/);
  assert.equal(res.headers['cache-control'], 'no-cache, no-transform');
  assert.equal(res.headers['x-accel-buffering'], 'no');
  assert.equal(res.headers['access-control-allow-origin'], 'https://mhedqvist.github.io');
  req.destroy();
});

test('stream endpoint enforces method and query validation like other endpoints', async (t) => {
  const { base } = await serve(t);
  const origin = 'https://mhedqvist.github.io';

  const posted = await fetch(`${base}/api/v1/stream`, { method: 'POST', headers: { origin } });
  assert.equal(posted.status, 405);
  assert.equal(posted.headers.get('allow'), 'GET');
  assert.equal(posted.headers.get('access-control-allow-origin'), origin);
  validate('error', await posted.json());

  const badQuery = await fetch(`${base}/api/v1/stream?unknown=1`, { headers: { origin } });
  assert.equal(badQuery.status, 400);
  assert.equal(badQuery.headers.get('access-control-allow-origin'), origin);
  validate('error', await badQuery.json());
});

test('initial frame reflects whatever snapshot is (or is not) currently available', async (t) => {
  const { base, trackerState, collector } = await serve(t);

  const { req, res } = await openStream(base);
  const frames = await drainSettled(sseReader(res));
  assert.ok(frames.length >= 1);
  // Startup noise (the first-activity dynamic/static cycles) does not
  // change anything yet, so every frame observed here is identical.
  for (const frame of frames) assert.equal(frame.id, `${collector.epoch}:0`);
  const frame = frames[0];
  assert.equal(frame.event, 'tracking-status');
  const data = JSON.parse(frame.data);
  assert.equal(data.epoch, collector.epoch);
  assert.equal(data.revision, 0);
  assert.equal(data.catalogVersion, 'v1');
  assert.equal(typeof data.serverTime, 'string');
  assert.deepEqual(data.quality, trackerState.quality);
  assert.equal(data.error.code, 'WARMING_UP');
  assert.equal(typeof data.error.message, 'string');
  assert.equal(data.retryAfter, 5);
  req.destroy();

  trackerState.snapshotThrows = false;
  trackerState.snapshotValue = { vehicles: [bus('bus-1')] };
  const second = await openStream(base);
  const frames2 = await drainSettled(sseReader(second.res));
  const frame2 = frames2[0];
  assert.equal(frame2.event, 'buses');
  assert.equal(frame2.id, `${collector.epoch}:0`);
  const data2 = JSON.parse(frame2.data);
  assert.deepEqual(data2.vehicles, trackerState.snapshotValue.vehicles);
  assert.equal(data2.epoch, collector.epoch);
  assert.equal(data2.revision, 0);
  assert.equal(data2.catalogVersion, 'v1');
  second.req.destroy();
});

test('a completed collector cycle pushes a fresh frame to an already-open connection', async (t) => {
  const { base, trackerState, collector } = await serve(t);
  trackerState.snapshotThrows = false;
  trackerState.snapshotValue = { vehicles: [] };

  const { req, res } = await openStream(base);
  const reader = sseReader(res);
  await drainSettled(reader); // flush the first-activity startup noise from connecting

  trackerState.revision = 1;
  trackerState.snapshotValue = { vehicles: [bus('bus-2')] };
  await collector.forceDynamicCycle();

  const updated = await reader.next();
  assert.equal(updated.event, 'buses');
  assert.equal(updated.id, `${collector.epoch}:1`);
  assert.deepEqual(JSON.parse(updated.data).vehicles, trackerState.snapshotValue.vehicles);
  req.destroy();
});

test('HTTP and SSE carry the same timestamped service evidence', async (t) => {
  const { base, trackerState } = await serve(t);
  const service = { completeUntil: '2026-10-25T01:06:00.000Z', windows: [{
    lineId: 1, routeId: 42, from: '2026-10-25T00:20:00.000Z',
    until: '2026-10-25T01:20:00.000Z', expiresAt: '2026-10-25T01:06:00.000Z',
  }] };
  trackerState.snapshotThrows = false;
  trackerState.snapshotValue = { vehicles: [], service, observedLines: [{ id: 1, text: 'Röd.' }] };
  const { req, res } = await openStream(base);
  const frame = await sseReader(res).next();
  const httpData = await (await fetch(`${base}/api/v1/buses`)).json();
  assert.deepEqual(JSON.parse(frame.data).service, service);
  assert.deepEqual(httpData.service, service);
  assert.deepEqual(httpData.observedLines, [{ id: 1, text: 'Röd.' }]);
  req.destroy();
});

test('reconnecting after a missed update gets the current snapshot, not a replay', async (t) => {
  const { base, trackerState, collector } = await serve(t);
  trackerState.snapshotThrows = false;
  trackerState.snapshotValue = { vehicles: [] };

  const first = await openStream(base);
  const reader1 = sseReader(first.res);
  await drainSettled(reader1); // flush the first-activity startup noise from connecting

  trackerState.revision = 5;
  trackerState.snapshotValue = { vehicles: [bus('bus-9')] };
  await collector.forceDynamicCycle();
  await reader1.next();
  first.req.destroy();

  // An update happens while nobody is connected to observe it.
  trackerState.revision = 6;
  trackerState.snapshotValue = { vehicles: [bus('bus-10')] };
  await collector.forceDynamicCycle();

  const second = await openStream(base);
  const frame = await sseReader(second.res).next();
  assert.equal(frame.id, `${collector.epoch}:6`);
  assert.deepEqual(JSON.parse(frame.data).vehicles, trackerState.snapshotValue.vehicles);
  second.req.destroy();
});

test('heartbeats arrive periodically and never change the last event id', async (t) => {
  const { base, collector } = await serve(t, { settings: { streamHeartbeatMs: 20 } });
  const { req, res } = await openStream(base);
  const reader = sseReader(res);

  // Heartbeats fire every 20ms here, so the stream never truly goes quiet;
  // instead of draining to silence, scan incoming frames until a heartbeat
  // comment shows up, checking that every real (non-comment) frame seen
  // along the way keeps reporting the same id (nothing actually changed).
  let realId = null;
  let heartbeat = null;
  for (let i = 0; i < 50 && !heartbeat; i += 1) {
    const frame = await reader.next(1000);
    if (frame.comment) { heartbeat = frame; break; }
    if (realId) assert.equal(frame.id, realId);
    realId = frame.id;
  }
  assert.ok(heartbeat, 'expected a heartbeat comment frame to arrive');
  assert.equal(heartbeat.comment, 'heartbeat');
  assert.equal(heartbeat.event, null);
  assert.equal(heartbeat.id, null);
  req.destroy();
});

test('the global connection cap rejects extra connections with 503 without hanging', async (t) => {
  const { base } = await serve(t, { settings: { streamMaxConnections: 1 } });
  const first = await openStream(base);
  const rejected = await fetch(`${base}/api/v1/stream`, { headers: { origin: 'https://mhedqvist.github.io' } });
  assert.equal(rejected.status, 503);
  validate('error', await rejected.json());
  first.req.destroy();
});

test('the per-client connection cap rejects extra connections from the same client with 429', async (t) => {
  const { base } = await serve(t, { settings: { streamMaxConnectionsPerClient: 1, streamMaxConnections: 10 } });
  const first = await openStream(base);
  const rejected = await fetch(`${base}/api/v1/stream`, { headers: { origin: 'https://mhedqvist.github.io' } });
  assert.equal(rejected.status, 429);
  validate('error', await rejected.json());
  first.req.destroy();
});

test('a slow reader is dropped by its deadline without delaying an active reader', async (t) => {
  const { base, trackerState, collector, server } = await serve(t, {
    settings: { streamSlowReaderMs: 50, streamMaxPendingBytes: 5_000_000, streamHeartbeatMs: 60000 },
  });
  trackerState.snapshotThrows = false;
  trackerState.snapshotValue = { vehicles: [], padding: 'x'.repeat(300_000) };

  const sockets = [];
  server.on('connection', (socket) => sockets.push(socket));
  const slow = await openStream(base); // intentionally never read
  t.after(() => slow.req.destroy());

  const active = await openStream(base);
  const activeReader = sseReader(active.res);
  await drainSettled(activeReader, 20);

  // Socket buffer sizes differ by OS. Fill the unread transport while
  // consuming every active-reader frame, rather than assuming 300 KiB blocks.
  for (let revision = 1; revision <= 100 && !sockets[0].destroyed; revision++) {
    trackerState.revision = revision;
    await collector.forceDynamicCycle();
    const updated = await activeReader.next(1000);
    assert.equal(updated.event, 'buses');
    assert.equal(updated.id, `${collector.epoch}:${revision}`);
  }

  const deadline = Date.now() + 2000;
  let connections = null;
  while (Date.now() < deadline) {
    const status = await fetch(`${base}/api/status`).then((r) => r.json());
    connections = status.stream.connections;
    if (connections === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(connections, 1, 'the slow reader was dropped from the hub within the bounded deadline');
  assert.equal(sockets[0].destroyed, true, 'the actual blocked transport is reclaimed, not just its connection slot');
  active.req.destroy();
});

test('shutdown ends open streams promptly and rejects new connection attempts', async (t) => {
  const { base, shutdown } = await serve(t);
  const { req, res } = await openStream(base);
  await sseReader(res).next();

  const ended = new Promise((resolve) => res.once('end', () => resolve(true)));
  shutdown();

  const finished = await Promise.race([
    ended,
    new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
  ]);
  assert.equal(finished, true, 'the open stream ended within the bounded timeout after shutdown');
  req.destroy();

  const after = await fetch(`${base}/api/v1/stream`, { headers: { origin: 'https://mhedqvist.github.io' } });
  assert.equal(after.status, 503);
});
