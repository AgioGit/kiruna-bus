import test from 'node:test';
import assert from 'node:assert/strict';
import { buildJourneys, buildVehicles, createTracker, upcomingStops } from '../lib/tracker.js';

const T0 = Date.parse('2026-01-01T12:00:00.000Z');
const iso = (offsetSec) => new Date(T0 + offsetSec * 1000).toISOString();

function call({ id, journeyId = 1, seq, at, lineId = 10, routeId = 100 }) {
  const time = { plannedTime: iso(at), forecastTime: iso(at) };
  return { id, journeyId, sequenceNumber: seq, lineId, routeId, line: 'Röd.', destination: 'LKAB', journey: 'j', arrival: time };
}

test('buildJourneys orders stops and uses the last stop for position call ids', () => {
  const journeys = buildJourneys([
    { call: call({ id: 'c3', seq: 3, at: 300 }), stopText: 'C' },
    { call: call({ id: 'c1', seq: 1, at: 100 }), stopText: 'A' },
    { call: call({ id: 'c2', seq: 2, at: 200 }), stopText: 'B' },
    { call: call({ id: 'c3b', seq: 3, at: 310 }), stopText: 'C' }, // reinforcement bus
  ]);
  const info = journeys.get(1);
  assert.deepEqual(info.stops.map((s) => s.stopText), ['A', 'B', 'C']);
  assert.deepEqual(info.positionCallIds, ['c3', 'c3b']);
  assert.equal(info.stops[2].forecastTime, iso(300)); // earliest forecast wins
});

test('upcomingStops returns the next two future stops, or the first when none are future', () => {
  const info = buildJourneys([
    { call: call({ id: 'a', seq: 1, at: -60 }), stopText: 'A' },
    { call: call({ id: 'b', seq: 2, at: 60 }), stopText: 'B' },
    { call: call({ id: 'c', seq: 3, at: 120 }), stopText: 'C' },
    { call: call({ id: 'd', seq: 4, at: 180 }), stopText: 'D' },
  ]).get(1);

  assert.deepEqual(upcomingStops(info, T0).map((s) => s.stopText), ['B', 'C']);
  assert.deepEqual(upcomingStops(info, T0 + 1_000_000).map((s) => s.stopText), ['A']);
});

test('buildVehicles dedupes shared fixes onto the soonest journey and hides expired positions', () => {
  const journeys = buildJourneys([
    { call: call({ id: 'now', journeyId: 1, seq: 1, at: 60 }), stopText: 'A' },
    { call: call({ id: 'later', journeyId: 2, seq: 1, at: 3600 }), stopText: 'A' },
    { call: call({ id: 'old', journeyId: 3, seq: 1, at: 90, routeId: 300 }), stopText: 'B' },
  ]);
  const shared = { location: { lat: 67.85, lon: 20.22 }, timestamp: iso(-10) };
  const positions = new Map([
    ['later', shared],
    ['now', shared],
    ['old', { location: { lat: 67.9, lon: 20.3 }, timestamp: iso(-600) }],
  ]);

  const vehicles = buildVehicles({ journeys, positions, nowMs: T0 });
  assert.equal(vehicles.length, 1);
  const merged = vehicles.find((v) => v.callIds.includes('now'));
  assert.equal(merged.journeyId, 1);
  assert.deepEqual([...merged.callIds].sort(), ['later', 'now']);
  assert.equal(merged.stale, false);
  assert.equal(vehicles.find((v) => v.journeyId === 3), undefined);
  assert.equal('forecastRank' in merged, false);
});

test('buildVehicles merges the same bus on consecutive trips but not buses passing in opposite directions', () => {
  const journeys = buildJourneys([
    { call: call({ id: 'trip1', journeyId: 1, seq: 1, at: 60 }), stopText: 'A' },
    { call: call({ id: 'trip2', journeyId: 2, seq: 1, at: 900 }), stopText: 'B' },
    { call: call({ id: 'other', journeyId: 3, seq: 1, at: 120 }), stopText: 'C' },
    { call: call({ id: 'otherLine', journeyId: 4, seq: 1, at: 120, lineId: 20 }), stopText: 'D' },
  ]);
  const base = { lat: 67.85, lon: 20.22 };
  const positions = new Map([
    ['trip1', { location: base, timestamp: iso(-10), heading: 90 }],
    ['trip2', { location: { lat: 67.8506, lon: 20.22 }, timestamp: iso(-6), heading: 100 }], // ~67 m, 4 s later
    ['other', { location: base, timestamp: iso(-8), heading: 270 }], // opposite direction
    ['otherLine', { location: base, timestamp: iso(-9), heading: 90 }], // different line
  ]);

  const vehicles = buildVehicles({ journeys, positions, nowMs: T0 });
  assert.equal(vehicles.length, 3);
  const merged = vehicles.find((v) => v.callIds.includes('trip1'));
  assert.deepEqual([...merged.callIds].sort(), ['trip1', 'trip2']);
  assert.equal(merged.journeyId, 1); // soonest forecast
  assert.equal(merged.position.timestamp, iso(-6)); // newest fix
});

function fakeApi() {
  const counts = { calls: 0, positions: 0, stopAreas: 0, findStop: 0, timestamp: 0 };
  const state = { failPositions: false, failCalls: false, now: T0 };
  const api = {
    getLines: async () => [{ id: 10 }],
    getStopAreas: async () => {
      counts.stopAreas += 1;
      return [{ id: 1, text: 'A' }, { id: 2, text: 'B' }];
    },
    findStopArea: async (text) => {
      counts.findStop += 1;
      return { location: { lat: 67.8, lon: 20.2 }, text };
    },
    getCalls: async (stopText) => {
      counts.calls += 1;
      if (state.failCalls) throw new Error('down');
      const seq = stopText === 'A' ? 1 : 2;
      const c = call({ id: `call-${seq}`, seq, at: 60 * seq });
      return { calls: [{ calls: [c] }] };
    },
    getVehiclePosition: async () => {
      counts.positions += 1;
      if (state.failPositions) throw new Error('gone');
      return { location: { lat: 67.85, lon: 20.22 }, timestamp: new Date(state.now - 5000).toISOString() };
    },
    getSystemTimestamp: async (clientTimestamp) => {
      counts.timestamp += 1;
      return { systemTimestamp: clientTimestamp, clientTimestamp };
    },
  };
  return { api, counts, state };
}

function trackerWith(fake) {
  return createTracker({ api: fake.api, now: () => fake.state.now, options: { retryDelayMs: 0 } });
}

test('a stop whose GetCalls fails once is retried and still counted', async () => {
  const fake = fakeApi();
  const original = fake.api.getCalls;
  const failedOnce = new Set();
  fake.api.getCalls = async (stopText) => {
    if (!failedOnce.has(stopText)) {
      failedOnce.add(stopText);
      throw new Error('timeout');
    }
    return original(stopText);
  };
  const resp = await trackerWith(fake).getBuses();
  assert.equal(resp.vehicles.length, 1);
  assert.equal(resp.vehicles[0].followingStop.stopText, 'B');
  assert.equal(resp.error, null);
});

test('tracker scans once, then only refreshes positions until the scan interval passes', async () => {
  const fake = fakeApi();
  const tracker = trackerWith(fake);

  const first = await tracker.getBuses();
  assert.equal(first.vehicles.length, 1);
  assert.deepEqual(first.vehicles[0].nextStop.stopText, 'A');
  assert.equal(first.vehicles[0].followingStop.stopText, 'B');
  assert.deepEqual(
    first.vehicles[0].upcomingStops.map((s) => s.stopText),
    ['A', 'B']
  );
  assert.equal(typeof first.vehicles[0].upcomingStops[0].sequenceNumber, 'number');
  assert.deepEqual(first.lineRoutes, { 10: [100] });
  assert.equal(fake.counts.calls, 2);
  assert.equal(fake.counts.positions, 1);

  await tracker.getBuses(); // within the position TTL: no upstream traffic
  assert.equal(fake.counts.positions, 1);

  fake.state.now += 20_000;
  await tracker.getBuses();
  assert.equal(fake.counts.calls, 2);
  assert.equal(fake.counts.positions, 2);

  fake.state.now += 3 * 60_000;
  await tracker.getBuses();
  assert.equal(fake.counts.calls, 4);
});

test('concurrent requests share a single refresh', async () => {
  const fake = fakeApi();
  const tracker = trackerWith(fake);
  await Promise.all([tracker.getBuses(), tracker.getBuses(), tracker.getBuses()]);
  assert.equal(fake.counts.calls, 2);
  assert.equal(fake.counts.positions, 1);
});

test('a failed position fetch keeps the old fix and triggers a rescan after the minimum interval', async () => {
  const fake = fakeApi();
  const tracker = trackerWith(fake);
  const first = await tracker.getBuses();

  fake.state.failPositions = true;
  fake.state.now += 20_000;
  const degraded = await tracker.getBuses();
  assert.equal(degraded.vehicles.length, 1); // previous fix retained
  assert.ok(degraded.vehicles[0].ageMs >= 20_000);
  assert.equal(degraded.vehicles[0].position.timestamp, first.vehicles[0].position.timestamp);
  assert.equal(degraded.vehicles[0].stale, true);
  assert.ok(degraded.error);
  assert.equal(fake.counts.calls, 2); // rescan not yet allowed (< 30 s)

  fake.state.failPositions = false;
  fake.state.now += 20_000;
  const recovered = await tracker.getBuses();
  assert.equal(fake.counts.calls, 4); // early rescan happened
  assert.equal(recovered.error, null);
});

test('missing positions are retained only through the exact three-minute boundary', async () => {
  const fake = fakeApi();
  const tracker = trackerWith(fake);
  const first = await tracker.getBuses();
  const timestamp = first.vehicles[0].position.timestamp;
  fake.api.getVehiclePosition = async () => null;
  fake.state.now = Date.parse(timestamp) + 180_000;
  const boundary = await tracker.getBuses();
  assert.equal(boundary.vehicles.length, 1);
  assert.equal(boundary.vehicles[0].position.timestamp, timestamp);
  fake.state.now += 1;
  const expired = await tracker.getBuses();
  assert.deepEqual(expired.vehicles, []);
  assert.match(expired.error, /no bus positions/);
});

test('an out-of-order position response does not replace a newer known fix', async () => {
  const fake = fakeApi();
  const tracker = trackerWith(fake);
  const first = await tracker.getBuses();
  fake.api.getVehiclePosition = async () => ({
    location: { lat: 67.8, lon: 20.2 }, timestamp: iso(-60),
  });
  fake.state.now += 20_000;
  const older = await tracker.getBuses();
  assert.deepEqual(older.vehicles[0].position, first.vehicles[0].position);
});

test('a bus missing from a successful departure scan keeps its last known fix until it expires', async () => {
  const fake = fakeApi();
  const tracker = trackerWith(fake);
  const first = await tracker.getBuses();
  fake.api.getVehiclePosition = async () => null;
  fake.state.now += 20_000;
  await tracker.getBuses(); // request an early rescan
  fake.api.getCalls = async () => ({ calls: [] });
  fake.state.now += 20_000;
  const missing = await tracker.getBuses();
  assert.equal(missing.vehicles.length, 1);
  assert.equal(missing.vehicles[0].journeyId, first.vehicles[0].journeyId);
  assert.equal(missing.vehicles[0].position.timestamp, first.vehicles[0].position.timestamp);
  assert.equal(missing.vehicles[0].stale, true);
  fake.state.now += 180_000;
  assert.deepEqual((await tracker.getBuses()).vehicles, []);
});

test('a journey whose call ids change falls back to its previous fix and recovers without duplicates', async () => {
  const fake = fakeApi();
  const tracker = trackerWith(fake);
  const first = await tracker.getBuses();
  const calls = fake.api.getCalls;
  fake.api.getVehiclePosition = async () => null;
  fake.state.now += 20_000;
  await tracker.getBuses();
  fake.api.getCalls = async (stop) => {
    const response = await calls(stop);
    response.calls[0].calls[0].id += '-new';
    return response;
  };
  fake.state.now += 20_000;
  const retained = await tracker.getBuses();
  assert.equal(retained.vehicles.length, 1);
  assert.equal(retained.vehicles[0].position.timestamp, first.vehicles[0].position.timestamp);
  fake.api.getVehiclePosition = async () => ({
    location: { lat: 67.851, lon: 20.221 }, timestamp: new Date(fake.state.now).toISOString(),
  });
  fake.state.now += 20_000;
  const recovered = await tracker.getBuses();
  assert.equal(recovered.vehicles.length, 1);
  assert.equal(recovered.vehicles[0].stale, false);
  assert.deepEqual(recovered.vehicles[0].callIds, ['call-2-new']);
});

test('scan failure with no data throws, with old data it is reported and retried only after backoff', async () => {
  const fake = fakeApi();
  fake.state.failCalls = true;
  const tracker = trackerWith(fake);
  await assert.rejects(tracker.getBuses(), /Unable to refresh live bus data/);
  const callsAfterFailure = fake.counts.calls;

  fake.state.now += 20_000; // inside the retry backoff: no new scan
  await assert.rejects(tracker.getBuses());
  assert.equal(fake.counts.calls, callsAfterFailure);

  fake.state.failCalls = false;
  fake.state.now += 60_000;
  const ok = await tracker.getBuses();
  assert.equal(ok.vehicles.length, 1);

  fake.state.failCalls = true;
  fake.state.now += 3 * 60_000;
  const stale = await tracker.getBuses();
  assert.equal(stale.vehicles.length, 1);
  assert.match(stale.error, /Unable to refresh live bus data/);
});

test('a slow refresh does not stall a request that already has data to serve', async () => {
  const fake = fakeApi();
  const tracker = createTracker({ api: fake.api, now: () => fake.state.now, options: { maxWaitMs: 20 } });
  await tracker.getBuses();

  const fast = fake.api.getVehiclePosition;
  fake.api.getVehiclePosition = () => new Promise((resolve) => setTimeout(() => resolve(fast()), 200));
  fake.state.now += 20_000;
  const started = Date.now();
  const resp = await tracker.getBuses();
  assert.ok(Date.now() - started < 150);
  assert.equal(resp.vehicles.length, 1);
});

test('positions that all come back empty are reported as an error', async () => {
  const fake = fakeApi();
  const tracker = trackerWith(fake);
  await tracker.getBuses();

  fake.api.getVehiclePosition = async () => null;
  fake.state.now += 20_000;
  const resp = await tracker.getBuses();
  assert.match(resp.error, /no bus positions/);
  assert.equal(resp.vehicles.length, 1); // previous fix retained
});

test('getStops returns each stop with its coordinates, resolved once', async () => {
  const fake = fakeApi();
  const tracker = trackerWith(fake);
  const stops = await tracker.getStops();
  assert.deepEqual(stops.map((s) => s.text).sort(), ['A', 'B']);
  assert.equal(stops[0].location.lat, 67.8);
  await tracker.getStops();
  assert.equal(fake.counts.findStop, 2);
});

test('partial scan preserves failed stops without reporting a fully healthy scan', async () => {
  const fake = fakeApi();
  const tracker = trackerWith(fake);
  const initial = await tracker.getBuses();
  const getCalls = fake.api.getCalls;
  fake.api.getCalls = (stop) => stop === 'A' ? Promise.reject(new Error('down')) : getCalls(stop);
  fake.state.now += 190000;
  const partial = await tracker.getBuses();
  assert.deepEqual(partial.quality.scan, { attempted: 2, succeeded: 1, failed: 1 });
  assert.equal(partial.quality.state, 'partial');
  assert.equal(partial.quality.lastScanAt, initial.quality.lastScanAt);
  assert.match(partial.error, /Some stops/);
  assert.equal(partial.vehicles[0].nextStop.stopText, 'A');
  tracker.close();
});

test('versioned snapshot reads never await an in-progress refresh', async () => {
  const fake = fakeApi();
  const tracker = trackerWith(fake);
  await tracker.refresh();
  let release;
  fake.api.getVehiclePosition = () => new Promise((resolve) => { release = resolve; });
  fake.state.now += 20000;
  const pending = tracker.refresh();
  const cached = await tracker.getSnapshot();
  assert.equal(cached.vehicles.length, 1);
  assert.equal(tracker.status().refreshing, true);
  await new Promise((resolve) => setImmediate(resolve));
  release({ location: { lat: 67.85, lon: 20.22 }, timestamp: new Date(fake.state.now).toISOString() });
  await pending;
  tracker.close();
});

test('cold versioned API reports warming up; successful empty service is healthy', async () => {
  const fake = fakeApi();
  fake.api.getCalls = async () => ({ calls: [] });
  const tracker = trackerWith(fake);
  await assert.rejects(tracker.getSnapshot(), { code: 'WARMING_UP', status: 503 });
  await tracker.refresh();
  const empty = await tracker.getSnapshot();
  assert.deepEqual(empty.vehicles, []);
  assert.equal(empty.quality.state, 'fresh');
  tracker.close();
});

test('whole refresh deadline releases stuck work even when an adapter ignores abort', async () => {
  const fake = fakeApi();
  fake.api.getCalls = () => new Promise(() => {});
  const tracker = createTracker({ api: fake.api, options: { refreshTimeoutMs: 20 } });
  const keepAlive = setTimeout(() => {}, 500);
  await tracker.refresh();
  clearTimeout(keepAlive);
  assert.equal(tracker.status().refreshing, false);
  await assert.rejects(tracker.getSnapshot(), { status: 503 });
  tracker.close();
});

test('healthy 60-second polling does not mark cached snapshots stale while refreshing', async () => {
  const fake = fakeApi();
  const tracker = trackerWith(fake);
  try {
    await tracker.refresh();
    for (let poll = 1; poll <= 8; poll++) {
      fake.state.now = T0 + poll * 60000;
      const cached = await tracker.getSnapshot();
      assert.equal(cached.quality.state, 'fresh', JSON.stringify(cached.quality));
      assert.deepEqual(cached.quality.reasons, []);
      assert.equal(cached.quality.positions.expired, 0);
      assert.equal(cached.vehicles.length, 1);
      await tracker.refresh();
    }
  } finally { tracker.close(); }
});

test('GPS expiry is reflected in cached quality even before a blocked refresh finishes', async () => {
  const fake = fakeApi();
  const tracker = trackerWith(fake);
  try {
    await tracker.refresh();
    const first = await tracker.getSnapshot();
    let release;
    fake.api.getVehiclePosition = () => new Promise((resolve) => { release = resolve; });
    fake.state.now = Date.parse(first.vehicles[0].position.timestamp) + 180000;
    const pending = tracker.refresh();
    await new Promise((resolve) => setImmediate(resolve));
    const boundary = await tracker.getSnapshot();
    assert.equal(boundary.quality.state, 'fresh');
    assert.equal(boundary.quality.positions.expired, 0);
    assert.equal(boundary.vehicles.length, 1);
    fake.state.now++;
    const expired = await tracker.getSnapshot();
    assert.equal(expired.quality.state, 'stale');
    assert.ok(expired.quality.reasons.includes('GPS_OLD'));
    assert.equal(expired.quality.positions.expired, 1);
    assert.equal(expired.vehicles.length, 0);
    release({ location: { lat: 67.85, lon: 20.22 }, timestamp: new Date(fake.state.now).toISOString() });
    await pending;
    assert.equal((await tracker.getSnapshot()).quality.state, 'fresh');
  } finally { tracker.close(); }
});

test('collection age warnings use snapshot lifetimes rather than refresh TTLs', async () => {
  const fake = fakeApi();
  fake.api.getCalls = async () => ({ calls: [] });
  const tracker = trackerWith(fake);
  try {
    await tracker.refresh();
    fake.state.now = T0 + 180000;
    assert.equal(tracker.quality().state, 'fresh');
    fake.state.now++;
    assert.ok(tracker.quality().reasons.includes('POSITIONS_OLD'));
    fake.state.now = T0 + 360000;
    assert.equal(tracker.quality().reasons.includes('SCAN_OLD'), false);
    fake.state.now++;
    assert.ok(tracker.quality().reasons.includes('SCAN_OLD'));
  } finally { tracker.close(); }
});
