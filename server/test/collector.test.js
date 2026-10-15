import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollector } from '../lib/collector.js';
import { createTelemetry } from '../lib/telemetry.js';
import { AppError } from '../lib/errors.js';

const silent = () => createTelemetry({ write() {} });

// Drains the microtask queue so chained promises inside collector.js
// (await tracker.collect() -> sync getSnapshot check -> .catch -> .finally)
// have fully settled before assertions run. This is independent of the
// mocked timer clock, which only governs setTimeout/Date.
async function flush(times = 20) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

// Minimal fake tracker/catalog test doubles exposing exactly what
// collector.js calls, with mutable knobs so each test can simulate
// success/failure per cycle.
function makeDoubles({ dynamicIntervalMs = 30000, staticIntervalMs = 900000, activityIdleMs = 120000 } = {}) {
  const config = { dynamicIntervalMs, staticIntervalMs, activityIdleMs };
  const state = {
    collectCalls: [],
    refreshCalls: [],
    snapshotThrows: true,
    snapshotValue: { vehicles: [] },
    lineRoutesValue: { 1: [10, 20] },
    collectRejects: false,
    refreshRejects: false,
  };
  const tracker = {
    async collect(opts) {
      state.collectCalls.push(opts);
      if (state.collectRejects) throw new Error('upstream collect failed');
    },
    getSnapshot() {
      if (state.snapshotThrows) throw new AppError('WARMING_UP', 'warming up', { status: 503 });
      return state.snapshotValue;
    },
    getLineRoutes() { return state.lineRoutesValue; },
  };
  const catalog = {
    async refresh(opts) {
      state.refreshCalls.push(opts);
      if (state.refreshRejects) throw new Error('upstream refresh failed');
      return { changed: true };
    },
    get() { return { version: 'v1' }; },
  };
  return { config, tracker, catalog, state };
}

test('is inactive by default and schedules nothing until activity', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { config, tracker, catalog, state } = makeDoubles();
  const collector = createCollector({ tracker, catalog, config, telemetry: silent() });
  t.after(() => collector.close());

  assert.equal(collector.isActive(), false);
  assert.equal(collector.status().active, false);

  t.mock.timers.tick(10 * 60 * 1000);
  await flush();
  assert.equal(state.collectCalls.length, 0);
  assert.equal(state.refreshCalls.length, 0);
});

test('first activity immediately kicks one dynamic cycle and one overdue static cycle', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { config, tracker, catalog, state } = makeDoubles();
  const collector = createCollector({ tracker, catalog, config, telemetry: silent() });
  t.after(() => collector.close());

  // No unconditional startup warmup before activity.
  await flush();
  assert.equal(state.collectCalls.length, 0);
  assert.equal(state.refreshCalls.length, 0);

  collector.noteHttpActivity();
  t.mock.timers.tick(0);
  await flush();

  assert.equal(state.collectCalls.length, 1);
  assert.equal(state.refreshCalls.length, 1);
});

test('single-flight: a concurrent trigger does not start a second collect while one is in flight', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { config, tracker, catalog, state } = makeDoubles();
  let resolveCollect;
  tracker.collect = async (opts) => {
    state.collectCalls.push(opts);
    await new Promise((resolve) => { resolveCollect = resolve; });
  };
  const collector = createCollector({ tracker, catalog, config, telemetry: silent() });
  t.after(() => collector.close());

  const p1 = collector.forceDynamicCycle().catch((error) => error);
  await flush();
  assert.equal(state.collectCalls.length, 1);

  // Trigger again while the first collect() is still pending.
  const p2 = collector.forceDynamicCycle().catch((error) => error);
  await flush();
  assert.equal(state.collectCalls.length, 1, 'no second concurrent collect() was started');

  resolveCollect();
  await flush();
  await Promise.all([p1, p2]);
});

test('skip missed ticks: a single large time jump does not burst-fire catch-up cycles', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const dynamicIntervalMs = 1000;
  const { config, tracker, catalog, state } = makeDoubles({ dynamicIntervalMs, staticIntervalMs: 10_000_000, activityIdleMs: 10_000_000 });
  state.snapshotThrows = false; // successful cycles so normal-interval (not backoff) scheduling applies
  const collector = createCollector({ tracker, catalog, config, telemetry: silent() });
  t.after(() => collector.close());

  collector.noteHttpActivity();
  t.mock.timers.tick(0);
  await flush();
  assert.equal(state.collectCalls.length, 1);

  // Advance by several multiples of the interval in one shot: only the
  // single already-scheduled next tick fires (not one per elapsed interval).
  t.mock.timers.tick(dynamicIntervalMs * 5);
  await flush();
  assert.equal(state.collectCalls.length, 2, 'only one additional cycle ran, not a burst of five');

  // Stepping forward interval-by-interval resumes normal one-per-interval
  // cadence (re-anchored off each completion, no pileup/drift).
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(dynamicIntervalMs);
    await flush();
  }
  assert.equal(state.collectCalls.length, 5);
});

test('inactivity stops scheduling; new activity resumes it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const dynamicIntervalMs = 1000;
  const activityIdleMs = 2000;
  const { config, tracker, catalog, state } = makeDoubles({ dynamicIntervalMs, staticIntervalMs: 10_000_000, activityIdleMs });
  state.snapshotThrows = false; // successful cycles so normal-interval (not backoff) scheduling applies
  const collector = createCollector({ tracker, catalog, config, telemetry: silent() });
  t.after(() => collector.close());

  collector.noteHttpActivity();
  t.mock.timers.tick(0);
  await flush();
  assert.equal(state.collectCalls.length, 1);

  // One more cycle fires inside the active window, then the idle window
  // elapses with no new activity: no further cycles are scheduled.
  t.mock.timers.tick(activityIdleMs);
  await flush();
  const settledCalls = state.collectCalls.length;
  assert.ok(settledCalls >= 1 && settledCalls <= 2, `unexpected call count while idling out: ${settledCalls}`);
  assert.equal(collector.isActive(), false);

  t.mock.timers.tick(5 * dynamicIntervalMs);
  await flush();
  assert.equal(state.collectCalls.length, settledCalls, 'no further cycles run once inactive');

  collector.noteHttpActivity();
  assert.equal(collector.isActive(), true);
  t.mock.timers.tick(0);
  await flush();
  assert.equal(state.collectCalls.length, settledCalls + 1, 'activity resumes scheduling');
});

test('SSE connections keep the collector active across balanced open/close', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const activityIdleMs = 2000;
  const { config, tracker, catalog } = makeDoubles({ activityIdleMs });
  const collector = createCollector({ tracker, catalog, config, telemetry: silent() });
  t.after(() => collector.close());

  collector.noteHttpActivity();
  collector.noteStreamOpen();
  collector.noteStreamOpen();
  assert.equal(collector.isActive(), true);
  assert.equal(collector.status().sseConnections, 2);

  collector.noteStreamClose();
  assert.equal(collector.isActive(), true, 'still one connection open');
  assert.equal(collector.status().sseConnections, 1);

  collector.noteStreamClose();
  assert.equal(collector.status().sseConnections, 0);
  // Still active immediately: recent HTTP activity has not expired yet.
  assert.equal(collector.isActive(), true);

  t.mock.timers.tick(activityIdleMs);
  assert.equal(collector.isActive(), false, 'inactive once both signals have lapsed');
});

test('failure backoff is bounded, then normal-interval scheduling resumes on recovery', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const dynamicIntervalMs = 1000;
  const { config, tracker, catalog, state } = makeDoubles({ dynamicIntervalMs, staticIntervalMs: 10_000_000, activityIdleMs: 10_000_000 });
  const expectedBackoffMs = Math.min(Math.max(dynamicIntervalMs * 2, 10000), 120000);
  assert.equal(expectedBackoffMs, 10000);

  const collector = createCollector({ tracker, catalog, config, telemetry: silent() });
  t.after(() => collector.close());

  state.snapshotThrows = true;
  collector.noteHttpActivity();
  t.mock.timers.tick(0);
  await flush();
  assert.equal(state.collectCalls.length, 1, 'first (failing) cycle ran');
  assert.ok(collector.status().dynamic.backoffUntil, 'backoff window recorded after failure');

  // Normal interval elapses, but backoff should hold off the next attempt.
  t.mock.timers.tick(dynamicIntervalMs);
  await flush();
  assert.equal(state.collectCalls.length, 1, 'backoff prevents a normal-interval retry');

  state.snapshotThrows = false; // recovery before the backoff window elapses
  t.mock.timers.tick(expectedBackoffMs - dynamicIntervalMs);
  await flush();
  assert.equal(state.collectCalls.length, 2, 'retry happened once the bounded backoff elapsed');
  assert.equal(collector.status().dynamic.backoffUntil, null, 'backoff cleared after success');

  // Normal interval scheduling resumes (not another backoff-length wait).
  t.mock.timers.tick(dynamicIntervalMs);
  await flush();
  assert.equal(state.collectCalls.length, 3, 'resumed at the normal interval after recovery');
});

test('the static cycle feeds tracker.getLineRoutes() through to catalog.refresh, no duplicate scan', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { config, tracker, catalog, state } = makeDoubles();
  state.lineRoutesValue = { 42: [100, 200], 7: [300] };
  const collector = createCollector({ tracker, catalog, config, telemetry: silent() });
  t.after(() => collector.close());

  await collector.forceStaticCycle();
  assert.equal(state.refreshCalls.length, 1);
  assert.deepEqual(state.refreshCalls[0].lineRoutes, state.lineRoutesValue);
  assert.equal(state.refreshCalls[0].fresh, true);
});

test('the first static cycle waits for dynamic route discovery instead of capturing an empty map', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { config, tracker, catalog, state } = makeDoubles();
  state.snapshotThrows = false;
  state.lineRoutesValue = {};
  let release;
  tracker.collect = () => new Promise((resolve) => { release = resolve; });
  const collector = createCollector({ tracker, catalog, config, telemetry: silent() });
  t.after(() => collector.close());
  collector.noteHttpActivity();
  t.mock.timers.tick(0);
  await flush();
  assert.equal(state.refreshCalls.length, 0);
  state.lineRoutesValue = { 42: [100] };
  release();
  await flush();
  assert.deepEqual(state.refreshCalls[0].lineRoutes, { 42: [100] });
});

test('failed source coverage backs off even when retained positions still make a snapshot usable', async (t) => {
  const { config, tracker, catalog, state } = makeDoubles();
  state.snapshotThrows = false;
  state.snapshotValue = { vehicles: [], quality: { scan: { failed: 1 }, positions: { failed: 0 } } };
  const collector = createCollector({ tracker, catalog, config, telemetry: silent() });
  t.after(() => collector.close());
  await assert.rejects(collector.forceDynamicCycle());
  assert.ok(collector.status().dynamic.backoffUntil);
});

test('forceDynamicCycle/forceStaticCycle reject on failure and resolve with real data on success', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { config, tracker, catalog, state } = makeDoubles();
  const collector = createCollector({ tracker, catalog, config, telemetry: silent() });
  t.after(() => collector.close());

  state.snapshotThrows = true;
  await assert.rejects(collector.forceDynamicCycle());

  state.snapshotThrows = false;
  state.snapshotValue = { vehicles: [{ id: 'bus-1' }] };
  const snapshot = await collector.forceDynamicCycle();
  assert.deepEqual(snapshot, state.snapshotValue);

  state.refreshRejects = true;
  await assert.rejects(collector.forceStaticCycle());

  state.refreshRejects = false;
  const catalogValue = await collector.forceStaticCycle();
  assert.deepEqual(catalogValue, catalog.get());
});

test('onUpdate fires after every completed cycle (success or failure); unsubscribe stops it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { config, tracker, catalog, state } = makeDoubles();
  const collector = createCollector({ tracker, catalog, config, telemetry: silent() });
  t.after(() => collector.close());

  let notifications = 0;
  const unsubscribe = collector.onUpdate(() => { notifications += 1; });

  state.snapshotThrows = false;
  await collector.forceDynamicCycle(); // success
  assert.equal(notifications, 1);

  await collector.forceStaticCycle(); // success
  assert.equal(notifications, 2);

  state.snapshotThrows = true;
  await assert.rejects(collector.forceDynamicCycle()); // failure still notifies
  assert.equal(notifications, 3);

  unsubscribe();
  state.snapshotThrows = false;
  await collector.forceDynamicCycle();
  assert.equal(notifications, 3, 'no notification after unsubscribe');
});

test('close() is idempotent and stops further scheduling; already-registered timers are cleared', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const dynamicIntervalMs = 1000;
  const { config, tracker, catalog, state } = makeDoubles({ dynamicIntervalMs, staticIntervalMs: 10_000_000, activityIdleMs: 10_000_000 });
  const collector = createCollector({ tracker, catalog, config, telemetry: silent() });

  collector.noteHttpActivity();
  t.mock.timers.tick(0);
  await flush();
  assert.equal(state.collectCalls.length, 1);

  collector.close();
  assert.doesNotThrow(() => collector.close());

  // The already-scheduled next dynamic tick must have been cancelled.
  t.mock.timers.tick(dynamicIntervalMs * 10);
  await flush();
  assert.equal(state.collectCalls.length, 1, 'no cycle ran after close()');

  collector.noteHttpActivity();
  t.mock.timers.tick(dynamicIntervalMs * 10);
  await flush();
  assert.equal(state.collectCalls.length, 1, 'activity after close() does not resume scheduling');
});

test('status() returns the documented shape without throwing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { config, tracker, catalog } = makeDoubles();
  const collector = createCollector({ tracker, catalog, config, telemetry: silent() });
  t.after(() => collector.close());

  const status = collector.status();
  assert.equal(typeof status.epoch, 'string');
  assert.equal(typeof status.active, 'boolean');
  assert.equal(typeof status.sseConnections, 'number');
  assert.ok('dynamic' in status && 'static' in status);
  for (const key of ['inFlight', 'lastAttemptAt', 'backoffUntil']) {
    assert.ok(key in status.dynamic, `dynamic.${key} present`);
    assert.ok(key in status.static, `static.${key} present`);
  }
  assert.equal(typeof status.dynamic.inFlight, 'boolean');
  assert.equal(typeof status.static.inFlight, 'boolean');
});
