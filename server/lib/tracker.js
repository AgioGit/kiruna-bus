import { runPooled, withSignal } from './pool.js';
import { AppError, unavailable as liveUnavailable } from './errors.js';
import { randomUUID } from 'node:crypto';
import { setMaxListeners } from 'node:events';

export const UPCOMING_STOP_COUNT = 2;

// The API has no "in service" flag; the only freshness signal is how old
// VehiclePosition.timestamp is. Missing fixes retain their original timestamp
// and are shown for at most three minutes.
export const STALE_THRESHOLD_MS = 3 * 60 * 1000;

// How long a stop's last-known GetCalls response stays usable for building
// journeys/positions when that stop can't be refreshed (e.g. upstream flakes
// on one stop during a cycle). Fixed independently of the collector's dynamic
// cycle cadence so a faster collector cadence can't shrink this window.
export const CALL_RETENTION_MS = 6 * 60 * 1000;

const DEFAULT_OPTIONS = {
  stopsTtlMs: 6 * 60 * 60 * 1000,
  clockTtlMs: 10 * 60 * 1000,
  retryAfterFailureMs: 60 * 1000,
  retryDelayMs: 500, // pause before the single retry of a failed per-stop GetCalls
  scanConcurrency: 8,
  positionConcurrency: 15,
  callCacheMaxBytes: 16 * 1024 * 1024,
  callCacheMaxEntries: 1000,
};

// A journey's TransitCall.id differs at every upcoming stop, but every one
// of them returns the same vehicle position (verified live). So per journey
// this keeps:
//   - `stops`: upcoming stops in route order with planned/forecast times,
//     from which the next stops are derived at any later time;
//   - `positionCallIds`: the call id(s) of its LAST known stop, which stays
//     valid longest and so can be polled between scans.
// A journey can have two vehicles (main + reinforcement) which appear as two
// call ids at the same stop, so every call id sharing the last
// sequenceNumber is kept.
export function buildJourneys(callsWithStop) {
  // Arrival is "when the bus reaches this stop"; mid-route calls often only
  // carry departure, which stands in when arrival is absent.
  const forecastOf = (call) => call.arrival ?? call.departure ?? null;
  const timeOf = (call) => {
    const ms = Date.parse(forecastOf(call)?.forecastTime ?? '');
    return Number.isNaN(ms) ? null : ms;
  };

  const byJourney = new Map();
  for (const entry of callsWithStop) {
    if (entry.call.journeyId == null) continue;
    const group = byJourney.get(entry.call.journeyId);
    if (group) group.push(entry);
    else byJourney.set(entry.call.journeyId, [entry]);
  }

  const result = new Map();
  for (const [journeyId, entries] of byJourney) {
    const bySequence = new Map();
    for (const entry of entries) {
      const group = bySequence.get(entry.call.sequenceNumber);
      if (group) group.push(entry);
      else bySequence.set(entry.call.sequenceNumber, [entry]);
    }
    const sequences = [...bySequence.keys()].sort((a, b) => a - b);

    // One stop entry per sequenceNumber (the earliest forecast), since both
    // vehicles of a reinforced journey call at the same stop.
    const stops = sequences.map((sequenceNumber) => {
      const best = bySequence.get(sequenceNumber).reduce((a, b) => {
        const ta = timeOf(a.call);
        const tb = timeOf(b.call);
        return tb != null && (ta == null || tb < ta) ? b : a;
      });
      const forecast = forecastOf(best.call);
      return {
        sequenceNumber,
        stopText: best.stopText,
        plannedTime: forecast?.plannedTime ?? null,
        forecastTime: forecast?.forecastTime ?? null,
      };
    });

    const first = bySequence.get(sequences[0])[0].call;
    const lastGroup = bySequence.get(sequences[sequences.length - 1]);
    result.set(journeyId, {
      lineId: first.lineId,
      routeId: first.routeId,
      line: first.line, // short display name, e.g. "Röd." (TransitCall.line)
      destination: first.destination,
      journey: first.journey,
      stops,
      positionCallIds: [...new Set(lastGroup.map((entry) => entry.call.id))],
    });
  }
  return result;
}

// The stops a journey is heading to next, soonest first. Time-based rather
// than "lowest sequenceNumber" so it stays correct between scans. When
// nothing is future-dated (bus sitting at its terminus) the first remaining
// stop stands in.
export function upcomingStops(info, nowMs, count = UPCOMING_STOP_COUNT) {
  const future = info.stops.filter((stop) => {
    const ms = Date.parse(stop.forecastTime ?? '');
    return !Number.isNaN(ms) && ms > nowMs;
  });
  const pool = future.length ? future : info.stops.slice(0, 1);
  return pool.slice(0, count).map(({ sequenceNumber, stopText, plannedTime, forecastTime }) => ({
    stopText,
    sequenceNumber,
    plannedTime,
    forecastTime,
  }));
}

// VehiclePosition.id merely echoes the requested callId, so one physical bus
// shows up under several call ids (and later trips of the same bus report
// the same fix). Positions are deduped by (lat, lon, timestamp).
function positionKey(position) {
  return `${position.location.lat.toFixed(5)}|${position.location.lon.toFixed(5)}|${position.timestamp}`;
}

// The same bus on consecutive trips (journeys) answers with slightly
// different fixes a few seconds apart, so the exact-fix dedupe above misses
// it. Two entries are one bus when they are on the same line but different
// journeys, within SAME_BUS_MAX_DISTANCE_M and SAME_BUS_MAX_GAP_MS of each
// other, and not heading in opposite directions (two real buses passing at a
// stop).
const SAME_BUS_MAX_DISTANCE_M = 150;
const SAME_BUS_MAX_GAP_MS = 60 * 1000;
const SAME_BUS_MAX_HEADING_DIFF_DEG = 60;

function distanceMeters(a, b) {
  const dLat = (a.lat - b.lat) * 111_320;
  const dLon = (a.lon - b.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

function headingDiff(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number') return 0;
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

function isSameBus(a, b) {
  if (a.lineId !== b.lineId || a.journeyId === b.journeyId) return false;
  const gap = Math.abs(Date.parse(a.position.timestamp) - Date.parse(b.position.timestamp));
  if (!(gap <= SAME_BUS_MAX_GAP_MS)) return false;
  if (distanceMeters(a.position.location, b.position.location) > SAME_BUS_MAX_DISTANCE_M) return false;
  return headingDiff(a.position.heading, b.position.heading) <= SAME_BUS_MAX_HEADING_DIFF_DEG;
}

// Keeps the journey with the soonest forecast for the metadata and the
// newest of the two fixes for the position.
function mergeVehicles(a, b) {
  const [winner, other] = a.forecastRank <= b.forecastRank ? [a, b] : [b, a];
  const newer = Date.parse(other.position.timestamp) > Date.parse(winner.position.timestamp) ? other : winner;
  return {
    ...winner,
    position: newer.position,
    ageMs: newer.ageMs,
    stale: newer.stale,
    callIds: [...new Set([...winner.callIds, ...other.callIds])],
  };
}

// Combines journeys with their latest positions into one entry per distinct
// physical bus. When several journeys share a fix, the one whose next
// forecast is soonest in the future supplies the line/destination/next-stop
// metadata (so scan-completion order can't mislabel a bus).
export function buildVehicles({ journeys, positions, nowMs, unavailableCallIds = new Set() }) {
  const byKey = new Map();

  for (const [journeyId, info] of journeys) {
    for (const callId of info.positionCallIds) {
      const position = positions.get(callId);
      if (!position?.location) continue;

      const ageMs = nowMs - Date.parse(position.timestamp);
      if (!Number.isFinite(ageMs) || ageMs > STALE_THRESHOLD_MS) continue;
      const key = positionKey(position);
      const upcoming = upcomingStops(info, nowMs, Number.POSITIVE_INFINITY);
      const [nextStop, followingStop] = upcoming;
      const forecastMs = Date.parse(nextStop?.forecastTime ?? '');
      const forecastRank = Number.isNaN(forecastMs)
        ? Number.POSITIVE_INFINITY
        : forecastMs >= nowMs
          ? forecastMs - nowMs
          : Number.MAX_SAFE_INTEGER + (nowMs - forecastMs);

      const candidate = {
        key,
        position,
        lineId: info.lineId,
        line: info.line,
        destination: info.destination,
        journeyId,
        routeId: info.routeId,
        callIds: [callId],
        ageMs,
        stale: unavailableCallIds.has(callId),
        forecastRank,
        nextStop: nextStop ?? { stopText: null, plannedTime: null, forecastTime: null },
        followingStop: followingStop ?? null,
        upcomingStops: upcoming,
      };

      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, candidate);
        continue;
      }
      const callIds = [...new Set([...existing.callIds, callId])];
      if (candidate.forecastRank < existing.forecastRank) {
        candidate.callIds = callIds;
        byKey.set(key, candidate);
      } else {
        existing.callIds = callIds;
      }
    }
  }

  const distinct = [];
  for (const vehicle of byKey.values()) {
    const twinIndex = distinct.findIndex((other) => isSameBus(other, vehicle));
    if (twinIndex === -1) distinct.push(vehicle);
    else distinct[twinIndex] = mergeVehicles(distinct[twinIndex], vehicle);
  }

  return distinct.map(({ forecastRank, ...vehicle }) => vehicle);
}

// Keeps the live bus picture in memory. Nothing in this module decides *when*
// to talk to Boreal: a caller (normally the shared collector) invokes
// `collect()`/`refresh()` once per cycle, and every call performs one genuine
// attempt (no internal TTL/"due" gating, no cache-bypass decisions) — cadence,
// no-overlap and backoff are the collector's responsibility. Reads
// (`getSnapshot()`/`getBuses()`) never trigger network activity and never
// wait on an in-flight collect; they always return the latest *committed*
// state, computed via a stage/commit pattern so a reader never observes a
// cycle's new calls paired with its old positions (or vice versa).
//
// `api` needs getLines, getStopAreas(lineId), findStopArea(text),
// getCalls(stopText), getVehiclePosition(callId) and getSystemTimestamp(iso).
async function withRetry(fn, delayMs) {
  try {
    return await fn();
  } catch (error) {
    if (error.code || error.name === 'AbortError' || error.name === 'TimeoutError') throw error;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return fn();
  }
}

export function createTracker({ api, now = Date.now, options = {}, initialStops = [], stopSource, telemetry }) {
  const opt = { ...DEFAULT_OPTIONS, ...options };

  let clockOffsetMs = 0;
  let clockAt = Number.NEGATIVE_INFINITY;

  let stops = initialStops.length ? initialStops : null;
  let stopsAt = initialStops.length ? now() : Number.NEGATIVE_INFINITY;
  let stopsInFlight = null;
  const stopLocations = new Map(); // stopAreaId -> { text, location }
  for (const stop of initialStops) stopLocations.set(stop.id, { text: stop.text, location: stop.location });

  let journeys = new Map();
  let lineRoutes = new Map(); // lineId -> Set<routeId>, staged/committed together with journeys
  let lastScanAt = Number.NEGATIVE_INFINITY;
  let scanError = null;

  let positions = new Map(); // callId -> VehiclePosition
  let positionsAt = Number.NEGATIVE_INFINITY;
  let positionsError = null;
  let unavailableCallIds = new Set();
  let lastKnownJourneys = new Map();

  let refreshing = null;
  let completed = false;
  let clockSynchronized = false;
  let coverage = { attempted: 0, succeeded: 0, failed: 0 };
  let positionCoverage = { attempted: 0, succeeded: 0, failed: 0, missing: 0 };
  let lastSuccessfulScan = null;
  let lastSuccessfulPositions = null;
  let revision = 0;
  let callsByStop = new Map(); // stopAreaId -> { calls, messages, isStopCancelled, at, text } (raw, shared with departures)
  const shutdown = new AbortController();
  let operationSignal;
  const apiOptions = (extra = {}) => ({ signal: operationSignal, priority: 'interactive', ...extra });

  const serverNow = () => now() + clockOffsetMs;

  async function ensureClock() {
    if (now() - clockAt < opt.clockTtlMs) return;
    try {
      const resp = await withSignal(api.getSystemTimestamp(new Date(now()).toISOString(), apiOptions()), operationSignal);
      const offset = Date.parse(resp.systemTimestamp) - Date.parse(resp.clientTimestamp);
      if (Number.isFinite(offset)) clockOffsetMs = offset;
      clockSynchronized = Number.isFinite(offset);
      clockAt = now();
    } catch (error) {
      clockSynchronized = false;
      telemetry?.log('clock_sync_failed', { code: error.code ?? error.name });
      clockAt = now() - opt.clockTtlMs + opt.retryAfterFailureMs;
    }
  }

  // Every stop served by any line, deduped by id, plus each stop's
  // coordinates (GetStopAreas omits them; FindStopArea has them).
  async function loadStops() {
    const lines = (await withSignal(api.getLines(apiOptions()), operationSignal)) ?? [];
    const results = await runPooled(lines, opt.scanConcurrency, (line) => api.getStopAreas(line.id, apiOptions()), { signal: operationSignal });
    const byId = new Map((stops ?? []).map((stop) => [stop.id, stop]));
    let incomplete = false;
    for (const res of results) {
      if (res.status !== 'fulfilled') {
        incomplete = true;
        continue;
      }
      for (const stop of res.value ?? []) if (!byId.has(stop.id)) byId.set(stop.id, stop);
    }
    if (!byId.size) throw new Error('Boreal returned no stops');

    const found = [...byId.values()];
    const missing = found.filter((stop) => !stopLocations.has(stop.id));
    const located = await runPooled(missing, opt.scanConcurrency, (stop) => api.findStopArea(stop.text, apiOptions()), { signal: operationSignal });
    operationSignal?.throwIfAborted();
    located.forEach((res, i) => {
      const location = res.status === 'fulfilled' ? res.value?.location : null;
      if (location?.lat == null || location?.lon == null) {
        incomplete = true;
        return;
      }
      stopLocations.set(missing[i].id, { text: missing[i].text, location });
    });

    stops = found;
    stopsAt = incomplete ? now() - opt.stopsTtlMs + opt.retryAfterFailureMs : now();
    return stops;
  }

  function ensureStops() {
    const provided = stopSource?.();
    if (provided) {
      stops = provided;
      stopLocations.clear();
      for (const stop of stops) stopLocations.set(stop.id, { text: stop.text, location: stop.location });
      return Promise.resolve(stops);
    }
    if (stops && now() - stopsAt < opt.stopsTtlMs) return Promise.resolve(stops);
    if (!stopsInFlight) {
      stopsInFlight = loadStops()
        .catch((err) => {
          if (!stops) throw err;
          stopsAt = now() - opt.stopsTtlMs + opt.retryAfterFailureMs;
          return stops;
        })
        .finally(() => {
          stopsInFlight = null;
        });
    }
    return stopsInFlight;
  }

  // One stage of calls: fetch every stop's GetCalls (one retry each), but do
  // not touch any committed state yet.
  async function stageCalls(stopList, { fresh }) {
    let bytes = 0;
    const results = await runPooled(stopList, opt.scanConcurrency, async (stop) => {
      const resp = await withRetry(() => api.getCalls(stop.text, apiOptions({ fresh })), opt.retryDelayMs);
      operationSignal?.throwIfAborted();
      const entry = {
        calls: (resp?.calls ?? []).flatMap((group) => group.calls ?? []),
        messages: resp?.messages ?? [],
        isStopCancelled: Boolean(resp?.isStopCancelled),
        at: resp.fetchedAt ?? now(),
      };
      const size = Buffer.byteLength(JSON.stringify(entry));
      if (bytes + size > opt.callCacheMaxBytes) {
        telemetry?.count('callCacheLimit');
        throw new AppError('LIVE_CACHE_LIMIT', 'Collected stop data exceeds the live cache limit.', { status: 503 });
      }
      bytes += size;
      return entry;
    }, { signal: operationSignal });
    operationSignal?.throwIfAborted();
    return results;
  }

  // One cycle: fetch calls for every stop, then positions for every call id
  // implied by those calls, entirely into local "staged" values, and only
  // then commit everything in one synchronous block. A reader can therefore
  // never see this cycle's calls paired with the previous cycle's positions.
  async function collectOnce({ fresh = true } = {}) {
    await ensureClock();
    const stopList = await ensureStops();
    if (stopList.length > opt.callCacheMaxEntries) {
      throw new AppError('LIVE_CACHE_LIMIT', 'The stop catalog exceeds the live cache limit.', { status: 503 });
    }

    const callResults = await stageCalls(stopList, { fresh });
    const succeeded = callResults.filter((res) => res.status === 'fulfilled').length;
    const newCoverage = { attempted: stopList.length, succeeded, failed: stopList.length - succeeded };
    const scanOk = succeeded > 0;

    // Base the staged per-stop cache on the currently committed one so a stop
    // that fails this cycle keeps its previous entry for CALL_RETENTION_MS.
    const stagedCallsByStop = new Map(callsByStop);
    callResults.forEach((res, i) => {
      const id = stopList[i].id;
      if (res.status === 'fulfilled') stagedCallsByStop.set(id, { ...res.value, text: stopList[i].text, failed: false });
      else if (stagedCallsByStop.has(id)) stagedCallsByStop.set(id, { ...stagedCallsByStop.get(id), failed: true });
    });
    const knownStops = new Set(stopList.map((stop) => stop.id));
    for (const [id, entry] of stagedCallsByStop) {
      if (!knownStops.has(id) || now() - entry.at > CALL_RETENTION_MS) stagedCallsByStop.delete(id);
    }
    const cacheBytes = [...stagedCallsByStop.values()].reduce((bytes, entry) =>
      bytes + Buffer.byteLength(JSON.stringify(entry)), 0);
    if (cacheBytes > opt.callCacheMaxBytes) {
      throw new AppError('LIVE_CACHE_LIMIT', 'Retained stop data exceeds the live cache limit.', { status: 503 });
    }

    const callsWithStop = [];
    for (const [, entry] of stagedCallsByStop) {
      for (const call of entry.calls) callsWithStop.push({ call, stopText: entry.text });
    }
    const stagedLineRoutes = new Map();
    for (const { call } of callsWithStop) {
      if (!call.routeId) continue;
      const set = stagedLineRoutes.get(call.lineId) ?? new Set();
      set.add(call.routeId);
      stagedLineRoutes.set(call.lineId, set);
    }
    const stagedJourneys = buildJourneys(callsWithStop);
    const newScanError = !scanOk ? 'Unable to refresh live bus data.'
      : newCoverage.failed ? 'Some stops could not be refreshed.' : null;
    const newLastSuccessfulScan = !newCoverage.failed && scanOk
      ? new Date(Math.min(...callResults.map((res) => res.value.at))).toISOString()
      : lastSuccessfulScan;

    const callIds = [...new Set([...stagedJourneys.values()].flatMap((info) => info.positionCallIds))];
    const posResults = await runPooled(callIds, opt.positionConcurrency,
      (callId) => api.getVehiclePosition(callId, apiOptions({ fresh })), { signal: operationSignal });
    operationSignal?.throwIfAborted();
    const newPositionCoverage = {
      attempted: callIds.length,
      succeeded: posResults.filter((res) => res.status === 'fulfilled' && res.value?.location).length,
      failed: posResults.filter((res) => res.status === 'rejected').length,
      missing: posResults.filter((res) => res.status === 'fulfilled' && !res.value?.location).length,
      expired: posResults.filter((res) => res.status === 'fulfilled' && res.value?.location
        && serverNow() - Date.parse(res.value.timestamp) > STALE_THRESHOLD_MS).length,
    };

    // Keep the actual GPS timestamp, not the time of this fetch (newer GPS
    // wins over whatever is currently committed, regardless of fetch order).
    const stagedPositions = new Map();
    const stagedUnavailable = new Set();
    posResults.forEach((res, i) => {
      const callId = callIds[i];
      const previous = positions.get(callId);
      const incoming = res.status === 'fulfilled' ? res.value : null;
      if (incoming?.location && Number.isFinite(Date.parse(incoming.timestamp))) {
        stagedPositions.set(callId, previous && Date.parse(previous.timestamp) > Date.parse(incoming.timestamp)
          ? previous : incoming);
        return;
      }
      stagedUnavailable.add(callId);
      if (previous) stagedPositions.set(callId, previous);
    });

    const stagedLastKnownJourneys = new Map(lastKnownJourneys);
    for (const [journeyId, info] of stagedJourneys) {
      const known = new Map(info.positionCallIds
        .filter((id) => stagedPositions.has(id))
        .map((id) => [id, stagedPositions.get(id)]));
      if (known.size) stagedLastKnownJourneys.set(journeyId, { info, positions: known });
    }
    const gotFix = posResults.some((res) => res.status === 'fulfilled' && res.value?.location &&
      Number.isFinite(Date.parse(res.value.timestamp)));
    const newPositionsError = callIds.length && !gotFix ? 'Boreal returned no bus positions.'
      : newPositionCoverage.failed ? 'Some bus positions could not be refreshed.' : null;

    // --- Commit: one synchronous block, nothing awaited in between. ---
    callsByStop = stagedCallsByStop;
    journeys = stagedJourneys;
    lineRoutes = stagedLineRoutes;
    positions = stagedPositions;
    unavailableCallIds = stagedUnavailable;
    lastKnownJourneys = stagedLastKnownJourneys;
    coverage = newCoverage;
    positionCoverage = newPositionCoverage;
    scanError = newScanError;
    positionsError = newPositionsError;
    if (scanOk) lastScanAt = now();
    positionsAt = now();
    if (scanOk) lastSuccessfulScan = newLastSuccessfulScan;
    if (!newPositionCoverage.failed) lastSuccessfulPositions = new Date(now()).toISOString();
    completed = true;
    revision += 1;
  }

  // Runs one collection cycle now (no due-checking: the caller, normally the
  // shared collector, owns cadence/backoff). Concurrent calls share one
  // in-flight cycle. `fresh` bypasses Boreal's opportunistic cache so a
  // scheduled cycle is a genuine upstream check even when a per-path cache
  // TTL would otherwise still be valid.
  function collect({ fresh = true } = {}) {
    if (!refreshing) {
      const refreshId = randomUUID();
      operationSignal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(options.refreshTimeoutMs ?? 60000)]);
      setMaxListeners(Math.max(opt.scanConcurrency, opt.positionConcurrency) * 3 + 4, operationSignal);
      const started = performance.now();
      refreshing = collectOnce({ fresh }).catch((error) => {
        scanError = 'Unable to refresh live bus data.';
        const attempted = stops?.length ?? 0;
        coverage = { attempted, succeeded: 0, failed: attempted };
        completed = true;
        revision += 1;
        telemetry?.log('collect_failed', { refreshId, code: error.code ?? error.name });
      }).finally(() => {
        telemetry?.duration('collect', performance.now() - started);
        telemetry?.log('collect_completed', { refreshId, durationMs: Math.round(performance.now() - started), scan: coverage, positions: positionCoverage, error: scanError ?? positionsError });
        refreshing = null;
      });
    }
    return refreshing;
  }

  return {
    // Pure read of the latest committed snapshot. Never triggers network
    // activity and never waits on an in-flight collect(). Throws only when
    // there is no usable data at all (cold start, or every stale fix expired).
    getSnapshot({ legacy = false } = {}) {
      if (!completed) throw liveUnavailable(scanError ? 'LIVE_UNAVAILABLE' : 'WARMING_UP');
      const error = scanError ?? positionsError;
      const nowMs = serverNow();
      const displayJourneys = new Map(journeys);
      const displayPositions = new Map(positions);
      const unavailable = new Set(unavailableCallIds);
      for (const [journeyId, cached] of lastKnownJourneys) {
        // Exact GPS expiry (STALE_THRESHOLD_MS) is enforced here at read
        // time against the current clock, regardless of whether a refresh
        // is in flight or blocked.
        const fresh = new Map([...cached.positions].filter(([, position]) => {
          const age = nowMs - Date.parse(position.timestamp);
          return Number.isFinite(age) && age <= STALE_THRESHOLD_MS;
        }));
        if (!fresh.size) {
          lastKnownJourneys.delete(journeyId);
          continue;
        }
        const current = journeys.get(journeyId);
        if (current?.positionCallIds.some((id) => {
          const position = positions.get(id);
          return position && nowMs - Date.parse(position.timestamp) <= STALE_THRESHOLD_MS;
        })) continue;
        displayJourneys.set(journeyId, { ...(current ?? cached.info), positionCallIds: [...fresh.keys()] });
        for (const [id, position] of fresh) {
          displayPositions.set(id, position);
          unavailable.add(id);
        }
      }
      const vehicles = buildVehicles({
        journeys: displayJourneys, positions: displayPositions, nowMs, unavailableCallIds: unavailable,
      });
      if (!legacy && !vehicles.length && error) throw liveUnavailable('LIVE_UNAVAILABLE');
      if (!displayJourneys.size && error) throw liveUnavailable('LIVE_UNAVAILABLE');

      return {
        generatedAt: new Date(now()).toISOString(),
        serverTime: new Date(nowMs).toISOString(),
        error,
        quality: this.quality(),
        vehicles,
        lineRoutes: Object.fromEntries([...lineRoutes].map(([lineId, routeIds]) => [lineId, [...routeIds]])),
      };
    },

    // Legacy reads preserve the previous empty/error response shape.
    getBuses() { return this.getSnapshot({ legacy: true }); },

    // Unrelated to the collector: resolves every stop's coordinates on
    // demand, cached for stopsTtlMs. Used by the temporary /api/stops endpoint.
    async getStops() {
      await ensureStops();
      return [...stopLocations].map(([id, { text, location }]) => ({ id, text, location }));
    },

    // Full raw per-stop GetCalls response as last collected, shared with the
    // departures endpoint so it never performs its own upstream lookup.
    getStopCalls(stopId) {
      const entry = callsByStop.get(stopId);
      if (!entry) return null;
      return { calls: entry.calls, messages: entry.messages, isStopCancelled: entry.isStopCancelled,
        at: entry.at, text: entry.text, failed: entry.failed };
    },

    getRevision: () => revision,

    // Committed call/route associations, in the same shape captureCatalog
    // expects, so the static cycle can consume them instead of re-scanning
    // every stop's GetCalls itself.
    getLineRoutes() {
      return Object.fromEntries([...lineRoutes].map(([lineId, routeIds]) => [lineId, [...routeIds]]));
    },
    serverTime: () => new Date(serverNow()).toISOString(),
    collect,
    refresh: (opts) => collect(opts), // alias kept for existing callers/fixtures
    close: () => shutdown.abort(new DOMException('Server shutting down', 'AbortError')),
    quality() {
      const reasons = [];
      const expired = [...positions.values()].filter((position) =>
        serverNow() - Date.parse(position.timestamp) > STALE_THRESHOLD_MS).length;
      if (scanError) reasons.push(coverage.succeeded ? 'PARTIAL_SCAN' : 'SCAN_FAILED');
      if (positionsError) reasons.push(positionCoverage.failed ? 'POSITION_FAILURE' : 'NO_POSITION_FIX');
      if (expired) reasons.push('GPS_OLD');
      if (!clockSynchronized) reasons.push('CLOCK_UNSYNCHRONIZED');
      // Snapshot ages, not collector cadence, drive these two: how long
      // since the last *successful* commit, independent of cycle interval.
      if (Number.isFinite(lastScanAt) && now() - lastScanAt > CALL_RETENTION_MS) reasons.push('SCAN_OLD');
      if (Number.isFinite(positionsAt) && now() - positionsAt > STALE_THRESHOLD_MS) reasons.push('POSITIONS_OLD');
      return {
        state: !completed || !Number.isFinite(lastScanAt) ? 'unavailable' : reasons.includes('SCAN_FAILED') || reasons.includes('SCAN_OLD') || reasons.includes('POSITIONS_OLD') || reasons.includes('GPS_OLD')
          ? 'stale' : reasons.length ? 'partial' : 'fresh',
        reasons, scan: { ...coverage }, positions: { ...positionCoverage, expired },
        lastScanAt: lastSuccessfulScan, positionsAt: lastSuccessfulPositions, clockSynchronized,
      };
    },
    status() {
      return {
        journeys: journeys.size,
        stops: stops?.length ?? 0,
        lastScanAt: Number.isFinite(lastScanAt) ? new Date(lastScanAt).toISOString() : null,
        positionsAt: Number.isFinite(positionsAt) ? new Date(positionsAt).toISOString() : null,
        error: scanError ?? positionsError,
        quality: this.quality(),
        refreshing: Boolean(refreshing),
        revision,
      };
    },
  };
}
