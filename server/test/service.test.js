import test from 'node:test';
import assert from 'node:assert/strict';
import { buildServiceWindows, coalesceServiceWindows, CALL_RETENTION_MS, createTracker } from '../lib/tracker.js';
import { loadConfig } from '../lib/config.js';
import { validate } from '../lib/validation.js';

const start = Date.parse('2026-10-25T00:20:00Z');
const iso = (ms) => new Date(ms).toISOString();
const call = (id, journeyId, lineId, routeId, time) => ({
  id, journeyId, lineId, routeId, sequenceNumber: Number(id), line: lineId === 2 ? 'Grön' : 'Röd.',
  destination: 'Town', departure: { plannedTime: time, forecastTime: time },
});

test('service windows use instants across the autumn DST change and planned-time fallback', () => {
  const first = call('1', 1, 1, 99, '2026-10-25T02:50:00+02:00');
  const last = call('2', 1, 1, 99, '2026-10-25T02:20:00+01:00');
  last.departure.forecastTime = null;
  const [window] = buildServiceWindows([{ calls: [first, last], at: start }]);
  assert.equal(window.from, '2026-10-25T00:20:00.000Z');
  assert.equal(window.until, '2026-10-25T01:20:00.000Z');
  assert.equal(window.expiresAt, iso(start + CALL_RETENTION_MS));
});

test('weekday and weekend calls use their actual dates and exact thirty-minute lead', () => {
  for (const date of ['2026-10-23T09:00:00Z', '2026-10-24T09:00:00Z']) {
    const departure = Date.parse(date);
    const [window] = buildServiceWindows([{ calls: [call('1', 1, 2, 200, date)], at: departure - 60000 }]);
    assert.equal(Date.parse(window.from), departure - 1800000);
    assert.equal(Date.parse(window.until), departure);
  }
});

test('the lead is measured from departure when a stop also has an earlier arrival', () => {
  const trip = call('1', 1, 1, 99, iso(start + 1800000));
  trip.arrival = { plannedTime: iso(start + 1500000), forecastTime: iso(start + 1500000) };
  const [window] = buildServiceWindows([{ calls: [trip], at: start }]);
  assert.equal(window.from, iso(start));
});

test('complete, partial and recovered scans preserve evidence ages independently of GPS', async () => {
  let time = start;
  let phase = 'full';
  const stops = [{ id: 1, text: 'A' }, { id: 2, text: 'B' }];
  const api = {
    getSystemTimestamp: async (clientTimestamp) => ({ clientTimestamp, systemTimestamp: clientTimestamp }),
    getCalls: async (text) => {
      if (phase === 'partial' && text === 'B' || phase === 'failed') throw new Error('offline');
      if (phase === 'empty') return { calls: [] };
      return { calls: [{ calls: text === 'A'
        ? [call('1', 1, 2, 200, iso(start + 1800000))]
        : [call('2', 2, 1, 999, iso(start + 600000))] }] };
    },
    getVehiclePosition: async () => null,
  };
  const tracker = createTracker({ api, now: () => time, initialStops: stops, options: { retryDelayMs: 0 } });
  try {
    await tracker.collect();
    const full = tracker.getSnapshot();
    assert.deepEqual(full.vehicles, []);
    assert.equal(full.service.completeUntil, iso(start + CALL_RETENTION_MS));
    assert.deepEqual(full.observedLines.map((line) => line.text).sort(), ['Grön', 'Röd.']);
    assert.deepEqual(full.service.windows.map((w) => w.routeId).sort((a, b) => a - b), [200, 999]);

    phase = 'partial';
    time += 60000;
    await tracker.collect();
    const partial = tracker.getSnapshot();
    assert.equal(partial.service.completeUntil, full.service.completeUntil);
    assert.equal(partial.service.windows.find((w) => w.routeId === 999).expiresAt, iso(start + CALL_RETENTION_MS));
    assert.equal(partial.quality.scan.failed, 1);
    phase = 'failed';
    time = start + CALL_RETENTION_MS + 1;
    await tracker.collect();
    const expired = tracker.getSnapshot();
    assert.ok(Date.parse(expired.service.completeUntil) < time);
    assert.equal(expired.service.windows.some((w) => w.routeId === 999), false);
    assert.equal(expired.service.windows.some((w) => w.routeId === 200), true);

    phase = 'empty';
    time += 60000;
    await tracker.collect();
    const recovered = tracker.getSnapshot();
    assert.equal(recovered.service.completeUntil, iso(time + CALL_RETENTION_MS));
    assert.deepEqual(recovered.service.windows, []);
    assert.equal(recovered.error, null);
  } finally { tracker.close(); }
});

test('retained upstream fetchedAt does not become fresh at a later full scan', async () => {
  let time = start;
  const api = {
    getSystemTimestamp: async (clientTimestamp) => ({ clientTimestamp, systemTimestamp: clientTimestamp }),
    getCalls: async () => ({ calls: [], fetchedAt: start }),
  };
  const tracker = createTracker({ api, now: () => time, initialStops: [{ id: 1, text: 'A' }] });
  try {
    await tracker.collect();
    time += CALL_RETENTION_MS + 1;
    await tracker.collect();
    assert.equal(tracker.getSnapshot().service.completeUntil, iso(start + CALL_RETENTION_MS));
  } finally { tracker.close(); }
});

test('undated or unassociated calls cannot make an empty scan authoritative', async () => {
  const undated = call('1', 1, 1, 99, iso(start));
  undated.departure = { plannedTime: null, forecastTime: null };
  const api = {
    getSystemTimestamp: async (clientTimestamp) => ({ clientTimestamp, systemTimestamp: clientTimestamp }),
    getCalls: async () => ({ calls: [{ calls: [undated] }] }),
    getVehiclePosition: async () => null,
  };
  const tracker = createTracker({ api, now: () => start, initialStops: [{ id: 1, text: 'A' }] });
  try {
    await tracker.collect();
    assert.equal(tracker.getSnapshot().service.completeUntil, null);
    assert.deepEqual(tracker.getSnapshot().service.windows, []);
  } finally { tracker.close(); }
});

test('a newly expanded stop catalog invalidates old complete coverage on a partial scan', async () => {
  let stops = [{ id: 1, text: 'A' }];
  const api = {
    getSystemTimestamp: async (clientTimestamp) => ({ clientTimestamp, systemTimestamp: clientTimestamp }),
    getCalls: async (text) => {
      if (text === 'B') throw new Error('offline');
      return { calls: [{ calls: [call('1', 1, 1, 99, iso(start + 600000))] }] };
    },
    getVehiclePosition: async () => null,
  };
  const tracker = createTracker({ api, now: () => start, stopSource: () => stops, options: { retryDelayMs: 0 } });
  try {
    await tracker.collect();
    assert.ok(tracker.getSnapshot().service.completeUntil);
    stops = [...stops, { id: 2, text: 'B' }];
    await tracker.collect();
    assert.equal(tracker.getSnapshot().service.completeUntil, null);
    assert.equal(tracker.getSnapshot().service.windows[0].routeId, 99);
  } finally { tracker.close(); }
});

test('a fresh stop keeps its own evidence after an older stop on the same journey expires', async () => {
  let time = start, partial = false, emptyA = false;
  const api = {
    getSystemTimestamp: async (clientTimestamp) => ({ clientTimestamp, systemTimestamp: clientTimestamp }),
    getCalls: async (text) => {
      if (partial && text === 'B') throw new Error('offline');
      if (emptyA && text === 'A') return { calls: [] };
      return { calls: [{ calls: [text === 'A'
        ? call('1', 1, 2, 200, iso(start + 12 * 60000))
        : call('2', 1, 2, 200, iso(start + 40 * 60000))] }] };
    },
    getVehiclePosition: async () => null,
  };
  const tracker = createTracker({ api, now: () => time, initialStops: [{ id: 1, text: 'A' }, { id: 2, text: 'B' }],
    options: { retryDelayMs: 0 } });
  try {
    await tracker.collect();
    partial = true;
    time = start + CALL_RETENTION_MS - 1000;
    await tracker.collect();
    time = start + CALL_RETENTION_MS + 1;
    const windows = tracker.getSnapshot().service.windows;
    assert.equal(windows.length, 1);
    assert.equal(windows[0].until, iso(start + 12 * 60000));
    assert.equal(windows[0].expiresAt, iso(start + 2 * CALL_RETENTION_MS - 1000));
    assert.ok(Date.parse(windows[0].from) <= time && time <= Date.parse(windows[0].until));
    assert.ok(Date.parse(windows[0].until) < start + 40 * 60000);
    emptyA = true;
    time += 1000;
    await tracker.collect();
    assert.deepEqual(tracker.getSnapshot().service.windows, windows);
  } finally { tracker.close(); }
});

test('route evidence envelope preserves freshness at every interval boundary and overlap', () => {
  const w = (routeId, from, until, expires) => ({ lineId: 1, routeId,
    from: iso(start + from), until: iso(start + until), expiresAt: iso(start + expires) });
  const original = [
    w(1, 0, 100, 500), w(1, 50, 150, 300), w(1, 75, 125, 700),
    w(1, 100, 100, 900), w(1, 150, 200, 200), w(1, 220, 240, 800),
    w(2, 0, 240, 400),
  ];
  const compact = coalesceServiceWindows(original);
  const present = (windows, route, time, freshness) => windows.some((window) => window.routeId === route &&
    Date.parse(window.from) <= time && time <= Date.parse(window.until) && freshness < Date.parse(window.expiresAt));
  const times = [-1, 0, 0.5, 49.5, 50, 74.5, 75, 99.5, 100, 100.5, 125, 125.5,
    149.5, 150, 150.5, 200, 200.5, 219.5, 220, 240, 240.5];
  const ages = [0, 199, 200, 299, 300, 399, 400, 499, 500, 699, 700, 799, 800, 899, 900];
  for (const route of [1, 2]) for (const time of times) for (const age of ages) {
    assert.equal(present(compact, route, start + time, start + age),
      present(original, route, start + time, start + age), `route ${route}, time ${time}, freshness ${age}`);
  }

  let seed = 12345;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed; };
  for (let trial = 0; trial < 100; trial++) {
    const inputs = Array.from({ length: 12 }, () => {
      const from = random() % 16;
      return w(1, from, from + random() % 8, random() % 24);
    });
    const envelope = coalesceServiceWindows(inputs);
    for (let time = 0; time <= 24; time += 0.5) for (let age = 0; age <= 24; age++) {
      assert.equal(present(envelope, 1, start + time, start + age),
        present(inputs, 1, start + time, start + age), `trial ${trial}, time ${time}, freshness ${age}`);
    }
  }
});

test('shifting forecasts over twelve partial 60-second scans stay within the default SSE frame limit', async (t) => {
  let time = start, cycle = 0;
  const stops = Array.from({ length: 44 }, (_, i) => ({ id: i + 1, text: `S${i}` }));
  const api = {
    getSystemTimestamp: async (clientTimestamp) => ({ clientTimestamp, systemTimestamp: clientTimestamp }),
    getCalls: async (text) => {
      const stop = Number(text.slice(1));
      if (stop === 43) throw new Error('offline');
      return { fetchedAt: time - (43 - stop) * 1000, calls: [{ calls: Array.from({ length: 5 }, (_, j) => {
        const i = stop * 5 + j;
        return call(String(i + 1), i + 1, 1 + i % 8, 1001 + i % 8,
          iso(start + 20 * 60000 + i * 30000 + cycle * 1000));
      }) }] };
    },
    getVehiclePosition: async (id) => ({
      location: { lat: 67 + Number(id) / 1000, lon: 20 }, timestamp: iso(time),
    }),
  };
  const tracker = createTracker({ api, now: () => time, initialStops: stops, options: { retryDelayMs: 0 } });
  try {
    const limit = loadConfig({}).streamMaxPendingBytes;
    let peakBytes = 0, peakWindows = 0;
    assert.equal(limit, 262144);
    for (cycle = 0; cycle <= 12; cycle++) {
      time = start + cycle * 60000;
      await tracker.collect();
      const snapshot = tracker.getSnapshot();
      assert.equal(snapshot.quality.scan.succeeded, 43);
      assert.equal(snapshot.quality.scan.failed, 1);
      assert.equal(snapshot.vehicles.length, 215);
      assert.ok(snapshot.service.windows.length <= 215 + 8 * 12 * 2,
        `cycle ${cycle}: ${snapshot.service.windows.length} windows`);
      const dto = { ...snapshot, epoch: '00000000-0000-0000-0000-000000000000',
        revision: cycle, catalogVersion: 'a'.repeat(64) };
      const frame = `event: buses\nid: ${dto.epoch}:${cycle}\ndata: ${JSON.stringify(validate('buses', dto))}\n\n`;
      const bytes = Buffer.byteLength(frame);
      peakBytes = Math.max(peakBytes, bytes);
      peakWindows = Math.max(peakWindows, snapshot.service.windows.length);
      assert.ok(bytes < limit, `cycle ${cycle}: ${bytes} bytes`);
    }
    t.diagnostic(`Peak SSE frame: ${peakBytes} bytes; peak service windows: ${peakWindows}`);
  } finally { tracker.close(); }
});

test('unexpired retained service evidence keeps its line label and route without calls or GPS', async () => {
  let time = start, empty = false;
  const api = {
    getSystemTimestamp: async (clientTimestamp) => ({ clientTimestamp, systemTimestamp: clientTimestamp }),
    getCalls: async (text) => {
      if (text === 'B') throw new Error('offline');
      return { calls: empty ? [] : [{ calls: [call('1', 1, 2, 200, iso(start + 600000))] }] };
    },
    getVehiclePosition: async () => null,
  };
  const tracker = createTracker({ api, now: () => time, initialStops: [{ id: 1, text: 'A' }, { id: 2, text: 'B' }],
    options: { retryDelayMs: 0 } });
  try {
    await tracker.collect();
    empty = true;
    time += 60000;
    await tracker.collect();
    const snapshot = tracker.getSnapshot();
    assert.deepEqual(snapshot.vehicles, []);
    assert.deepEqual(snapshot.observedLines, [{ id: 2, text: 'Grön' }]);
    assert.deepEqual(snapshot.lineRoutes, { 2: [200] });
    assert.equal(snapshot.service.windows[0].expiresAt, iso(start + CALL_RETENTION_MS));
    time = start + CALL_RETENTION_MS;
    assert.deepEqual(tracker.getSnapshot().service.windows, []);
    assert.deepEqual(tracker.getSnapshot().observedLines, []);
    assert.deepEqual(tracker.getSnapshot().lineRoutes, {});
  } finally { tracker.close(); }
});

test('whole-cycle timeout cannot advertise expired cached call identities', async () => {
  let time = start, stalled = false;
  const api = {
    getSystemTimestamp: async (clientTimestamp) => ({ clientTimestamp, systemTimestamp: clientTimestamp }),
    getCalls: async () => stalled ? new Promise(() => {}) :
      { calls: [{ calls: [call('1', 1, 2, 200, iso(start + 600000))] }] },
    getVehiclePosition: async () => null,
  };
  const tracker = createTracker({ api, now: () => time, initialStops: [{ id: 1, text: 'A' }],
    options: { refreshTimeoutMs: 20, retryDelayMs: 0 } });
  try {
    await tracker.collect();
    assert.deepEqual(tracker.getSnapshot().observedLines, [{ id: 2, text: 'Grön' }]);
    stalled = true;
    time += CALL_RETENTION_MS + 1;
    const keepAlive = setTimeout(() => {}, 500);
    try { await tracker.collect(); } finally { clearTimeout(keepAlive); }
    const snapshot = tracker.getSnapshot();
    assert.deepEqual(snapshot.vehicles, []);
    assert.deepEqual(snapshot.service.windows, []);
    assert.deepEqual(snapshot.observedLines, []);
    assert.deepEqual(snapshot.lineRoutes, {});
    assert.match(snapshot.error, /Unable to refresh/);
    assert.ok(tracker.getStopCalls(1));
  } finally { tracker.close(); }
});

test('repeated partial scans coalesce equivalent evidence within the real SSE frame limit', async () => {
  let time = start, partial = false;
  const trips = Array.from({ length: 200 }, (_, i) =>
    call(String(i + 1), i + 1, i + 1, i + 1001, iso(start + (i + 1) * 10000)));
  const api = {
    getSystemTimestamp: async (clientTimestamp) => ({ clientTimestamp, systemTimestamp: clientTimestamp }),
    getCalls: async (text) => {
      if (partial && text === 'B') throw new Error('offline');
      return { calls: [{ calls: text === 'A' ? trips : [] }] };
    },
    getVehiclePosition: async (id) => ({
      location: { lat: 67 + Number(id) / 10000, lon: 20 }, timestamp: iso(time),
    }),
  };
  const tracker = createTracker({ api, now: () => time, initialStops: [{ id: 1, text: 'A' }, { id: 2, text: 'B' }],
    options: { retryDelayMs: 0 } });
  try {
    await tracker.collect();
    partial = true;
    for (let i = 1; i <= 12; i++) {
      time = start + i * 20000;
      await tracker.collect();
      const snapshot = tracker.getSnapshot();
      assert.equal(snapshot.service.windows.length, 200);
      assert.equal(snapshot.vehicles.length, 200);
      const dto = { ...snapshot, epoch: '00000000-0000-0000-0000-000000000000', revision: i,
        catalogVersion: 'a'.repeat(64) };
      const frame = `event: buses\nid: ${dto.epoch}:${i}\ndata: ${JSON.stringify(validate('buses', dto))}\n\n`;
      assert.equal(loadConfig({}).streamMaxPendingBytes, 256 * 1024);
      assert.ok(Buffer.byteLength(frame) < loadConfig({}).streamMaxPendingBytes,
        `cycle ${i}: ${Buffer.byteLength(frame)} bytes`);
    }
  } finally { tracker.close(); }
});

test('retained GPS vehicles still advertise their line and route after an empty scan', async () => {
  let time = start, empty = false;
  const api = {
    getSystemTimestamp: async (clientTimestamp) => ({ clientTimestamp, systemTimestamp: clientTimestamp }),
    getCalls: async () => ({ calls: empty ? [] : [{ calls: [call('1', 1, 2, 200, iso(start + 600000))] }] }),
    getVehiclePosition: async () => ({ location: { lat: 67.85, lon: 20.2 }, timestamp: iso(time) }),
  };
  const tracker = createTracker({ api, now: () => time, initialStops: [{ id: 1, text: 'A' }] });
  try {
    await tracker.collect();
    empty = true;
    time += 1000;
    await tracker.collect();
    const snapshot = tracker.getSnapshot();
    assert.equal(snapshot.vehicles.length, 1);
    assert.deepEqual(snapshot.observedLines, [{ id: 2, text: 'Grön' }]);
    assert.deepEqual(snapshot.lineRoutes, { 2: [200] });
    assert.deepEqual(snapshot.service.windows, []);
    assert.deepEqual(tracker.getLineRoutes(), {});
  } finally { tracker.close(); }
});

test('legacy empty/error read is unavailable while versioned service remains unknown', async () => {
  let time = start, failed = false;
  const api = {
    getSystemTimestamp: async (clientTimestamp) => ({ clientTimestamp, systemTimestamp: clientTimestamp }),
    getCalls: async () => {
      if (failed) throw new Error('offline');
      return { calls: [] };
    },
  };
  const tracker = createTracker({ api, now: () => time, initialStops: [{ id: 1, text: 'A' }],
    options: { retryDelayMs: 0 } });
  try {
    await tracker.collect();
    assert.deepEqual(tracker.getBuses().vehicles, []);
    failed = true;
    time += CALL_RETENTION_MS + 1;
    await tracker.collect();
    assert.throws(() => tracker.getBuses(), { code: 'LIVE_UNAVAILABLE', status: 503 });
    const versioned = tracker.getSnapshot();
    assert.deepEqual(versioned.vehicles, []);
    assert.ok(Date.parse(versioned.service.completeUntil) < time);
    assert.match(versioned.error, /Unable to refresh/);
  } finally { tracker.close(); }
});
