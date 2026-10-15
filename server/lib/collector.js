import { randomUUID } from 'node:crypto';

// One shared, activity-gated scheduler for both halves of upstream work:
//   - a "dynamic" cycle (tracker.collect(): calls + vehicle positions),
//     every `dynamicIntervalMs` while active;
//   - a "static" cycle (catalog.refresh(): genuine source checks against
//     lines/stops/routes/config), every `staticIntervalMs` while active,
//     consuming the tracker's already-collected call/route associations
//     instead of re-scanning every stop's GetCalls a second time.
//
// "Active" means at least one SSE client is connected, or a live
// buses/departures HTTP read happened within `activityIdleMs`. Probes and
// static (catalog/stop) reads never count as activity. The first activity
// after being idle immediately kicks one dynamic cycle and, if the static
// cycle is overdue, one static cycle too -- there is no unconditional
// startup warmup. Once activity disappears, no further cycles are
// scheduled; any already in-flight cycle is left to finish (each has its
// own bounded timeout via the tracker's/catalog's own AbortSignal).
//
// Both cycle kinds are single-flight (no overlap) and "skip missed ticks":
// the next tick is scheduled `intervalMs` after the *start* of the previous
// attempt, so a slow cycle never queues a catch-up burst. A failed attempt
// is retried after a bounded backoff instead of the normal interval.
export function createCollector({
  tracker, catalog, config, telemetry, now = Date.now, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout,
}) {
  const epoch = randomUUID();
  const dynamicIntervalMs = config.dynamicIntervalMs;
  const staticIntervalMs = config.staticIntervalMs;
  const activityIdleMs = config.activityIdleMs;
  // Bounded failure backoff: never faster than the normal interval would
  // allow, never so slow it stalls recovery for long once Boreal is back.
  const dynamicFailureBackoffMs = Math.min(Math.max(dynamicIntervalMs * 2, 10000), 120000);
  const staticFailureBackoffMs = Math.min(Math.max(staticIntervalMs / 4, 60000), staticIntervalMs);

  let sseCount = 0;
  let lastHttpActivityAt = -Infinity;
  let closed = false;

  let dynamicTimer = null;
  let staticTimer = null;
  let dynamicCycle = null;
  let staticCycle = null;
  let lastDynamicAttemptAt = -Infinity;
  let lastStaticAttemptAt = -Infinity;
  let dynamicBackoffUntil = 0;
  let staticBackoffUntil = 0;

  const listeners = new Set();
  function notify() {
    for (const fn of listeners) {
      try { fn(); } catch (error) { telemetry?.log('collector_listener_failed', { code: error.code ?? error.name }); }
    }
  }

  function isActive() {
    return !closed && (sseCount > 0 || (now() - lastHttpActivityAt) < activityIdleMs);
  }

  function nextDelay(lastAttemptAt, intervalMs, backoffUntil) {
    if (now() < backoffUntil) return backoffUntil - now();
    return Math.max(0, intervalMs - (now() - lastAttemptAt));
  }

  function clearDynamicTimer() { if (dynamicTimer) { clearTimeoutFn(dynamicTimer); dynamicTimer = null; } }
  function clearStaticTimer() { if (staticTimer) { clearTimeoutFn(staticTimer); staticTimer = null; } }

  function scheduleDynamic(delay) {
    clearDynamicTimer();
    dynamicTimer = setTimeoutFn(dynamicTick, delay);
    dynamicTimer.unref?.();
  }
  function scheduleStatic(delay) {
    clearStaticTimer();
    staticTimer = setTimeoutFn(staticTick, delay);
    staticTimer.unref?.();
  }

  // Re-evaluates what (if anything) should be scheduled next. Called after
  // every activity signal and after every completed cycle; it is the single
  // place that decides whether scheduling continues.
  function ensureScheduled() {
    if (closed || !isActive()) return;
    if (!dynamicTimer && !dynamicCycle) scheduleDynamic(nextDelay(lastDynamicAttemptAt, dynamicIntervalMs, dynamicBackoffUntil));
    if (!staticTimer && !staticCycle) scheduleStatic(nextDelay(lastStaticAttemptAt, staticIntervalMs, staticBackoffUntil));
  }

  function dynamicTick() {
    dynamicTimer = null;
    if (closed || !isActive()) return;
    void runDynamic();
  }
  function staticTick() {
    staticTimer = null;
    if (closed || !isActive()) return;
    void runStatic();
  }

  // Resolves to true/false (success/failure); never rejects. Shared by
  // scheduled ticks and forceDynamicCycle so both paths cannot overlap.
  async function runDynamic(opts = {}) {
    if (dynamicCycle) return dynamicCycle;
    lastDynamicAttemptAt = now();
    dynamicCycle = (async () => {
      await tracker.collect({ fresh: true, ...opts });
      let ok = true;
      try {
        const snapshot = tracker.getSnapshot();
        ok = !(snapshot.quality?.scan.failed || snapshot.quality?.positions.failed);
      } catch (error) {
        telemetry?.log('dynamic_snapshot_unavailable', { code: error.code ?? error.name });
        ok = false;
      }
      dynamicBackoffUntil = ok ? 0 : now() + dynamicFailureBackoffMs;
      return ok;
    })().catch((error) => {
      dynamicBackoffUntil = now() + dynamicFailureBackoffMs;
      telemetry?.log('dynamic_cycle_failed', { code: error.code ?? error.name });
      return false;
    }).finally(() => {
      dynamicCycle = null;
      notify();
      ensureScheduled();
    });
    return dynamicCycle;
  }

  // Resolves to true/false; never rejects. Feeds the live tracker's already
  // -collected call/route associations into the catalog capture so the
  // static cycle does not perform its own duplicate per-stop call scan.
  async function runStatic(opts = {}) {
    if (staticCycle) return staticCycle;
    lastStaticAttemptAt = now();
    staticCycle = Promise.resolve(dynamicCycle).then(() =>
      catalog.refresh({ fresh: true, lineRoutes: tracker.getLineRoutes(), ...opts }))
      .then(() => { staticBackoffUntil = 0; return true; })
      .catch((error) => {
        staticBackoffUntil = now() + staticFailureBackoffMs;
        telemetry?.log('static_cycle_failed', { code: error.code ?? error.name });
        return false;
      }).finally(() => {
        staticCycle = null;
        notify();
        ensureScheduled();
      });
    return staticCycle;
  }

  return {
    epoch,

    isActive,

    refreshIfDue() {
      if (closed || !isActive()) return Promise.resolve();
      if (dynamicCycle) return dynamicCycle;
      if (nextDelay(lastDynamicAttemptAt, dynamicIntervalMs, dynamicBackoffUntil) > 0) return Promise.resolve();
      clearDynamicTimer();
      return runDynamic();
    },

    // Registers a live buses/departures HTTP read. Starts/extends the
    // shared scheduler's active window; never fetches or waits for this
    // request's own sake.
    noteHttpActivity() {
      lastHttpActivityAt = now();
      ensureScheduled();
    },

    // SSE connection lifecycle, tracked by stream.js.
    noteStreamOpen() {
      sseCount += 1;
      ensureScheduled();
    },
    noteStreamClose() {
      sseCount = Math.max(0, sseCount - 1);
    },

    // Fires after every completed cycle (dynamic or static, success or
    // failure) so transports (SSE) can push a fresh snapshot/status.
    onUpdate(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    // Test/fixture-only: forces one dynamic cycle now, sharing in-flight
    // work with any already-running cycle, bypassing activity gating.
    // Rejects (does not hang) if no usable snapshot results.
    async forceDynamicCycle(opts = {}) {
      const ok = await runDynamic({ fresh: true, ...opts });
      if (!ok) throw new Error('Live bus data unavailable after forced collection cycle.');
      return tracker.getSnapshot();
    },

    // Test/fixture-only: forces one static cycle now. Rejects on failure.
    async forceStaticCycle(opts = {}) {
      const ok = await runStatic({ fresh: true, ...opts });
      if (!ok) throw new Error('Catalog refresh failed.');
      return catalog.get();
    },

    status() {
      return {
        epoch,
        active: isActive(),
        sseConnections: sseCount,
        lastHttpActivityAt: Number.isFinite(lastHttpActivityAt) ? new Date(lastHttpActivityAt).toISOString() : null,
        dynamic: {
          inFlight: Boolean(dynamicCycle),
          lastAttemptAt: Number.isFinite(lastDynamicAttemptAt) ? new Date(lastDynamicAttemptAt).toISOString() : null,
          backoffUntil: dynamicBackoffUntil > now() ? new Date(dynamicBackoffUntil).toISOString() : null,
        },
        static: {
          inFlight: Boolean(staticCycle),
          lastAttemptAt: Number.isFinite(lastStaticAttemptAt) ? new Date(lastStaticAttemptAt).toISOString() : null,
          backoffUntil: staticBackoffUntil > now() ? new Date(staticBackoffUntil).toISOString() : null,
        },
      };
    },

    // Idempotent: stops scheduling new work. Already in-flight cycles are
    // left to finish on their own (the tracker's/catalog's own close()
    // bounds those via their internal AbortSignal/shutdown).
    close() {
      if (closed) return;
      closed = true;
      clearDynamicTimer();
      clearStaticTimer();
      listeners.clear();
    },
  };
}
