import { runPooled } from './pool.js';

export const UPCOMING_STOP_COUNT = 2;

// The API has no "in service" flag; the only freshness signal is how old
// VehiclePosition.timestamp is. Missing fixes retain their original timestamp
// and are shown for at most three minutes.
export const STALE_THRESHOLD_MS = 3 * 60 * 1000;

const DEFAULT_OPTIONS = {
  scanIntervalMs: 3 * 60 * 1000, // full GetCalls scan of every stop
  minRescanIntervalMs: 30 * 1000, // earliest a position failure can force a rescan
  positionsTtlMs: 15 * 1000,
  stopsTtlMs: 6 * 60 * 60 * 1000,
  clockTtlMs: 10 * 60 * 1000,
  retryAfterFailureMs: 60 * 1000,
  retryDelayMs: 500, // pause before the single retry of a failed per-stop GetCalls
  maxWaitMs: 8 * 1000, // longest a request waits for a refresh when it already has data to serve
  scanConcurrency: 8,
  positionConcurrency: 15,
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

// Keeps the live bus picture in memory and refreshes it lazily: nothing
// talks to Boreal until a request arrives and the data is older than its
// TTL, and concurrent requests share one refresh. So upstream load depends
// on the TTLs, not on how many people are using the app.
//
// `api` needs getLines, getStopAreas(lineId), findStopArea(text),
// getCalls(stopText), getVehiclePosition(callId) and getSystemTimestamp(iso).
async function withRetry(fn, delayMs) {
  try {
    return await fn();
  } catch {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return fn();
  }
}

export function createTracker({ api, now = Date.now, options = {} }) {
  const opt = { ...DEFAULT_OPTIONS, ...options };

  let clockOffsetMs = 0;
  let clockAt = Number.NEGATIVE_INFINITY;

  let stops = null;
  let stopsAt = Number.NEGATIVE_INFINITY;
  let stopsInFlight = null;
  const stopLocations = new Map(); // stopAreaId -> { text, location }

  let journeys = new Map();
  const lineRoutes = new Map(); // lineId -> Set<routeId>, only ever grows
  let lastScanAt = Number.NEGATIVE_INFINITY;
  let scanBackoffUntil = 0;
  let rescanRequested = false;
  let scanError = null;

  let positions = new Map(); // callId -> VehiclePosition
  let positionsAt = Number.NEGATIVE_INFINITY;
  let positionsDirty = false;
  let positionsError = null;
  let unavailableCallIds = new Set();
  const lastKnownJourneys = new Map();

  let refreshing = null;

  const serverNow = () => now() + clockOffsetMs;

  async function ensureClock() {
    if (now() - clockAt < opt.clockTtlMs) return;
    try {
      const resp = await api.getSystemTimestamp(new Date(now()).toISOString());
      const offset = Date.parse(resp.systemTimestamp) - Date.parse(resp.clientTimestamp);
      if (Number.isFinite(offset)) clockOffsetMs = offset;
      clockAt = now();
    } catch {
      clockAt = now() - opt.clockTtlMs + opt.retryAfterFailureMs;
    }
  }

  // Every stop served by any line, deduped by id, plus each stop's
  // coordinates (GetStopAreas omits them; FindStopArea has them).
  async function loadStops() {
    const lines = (await api.getLines()) ?? [];
    const results = await runPooled(lines, opt.scanConcurrency, (line) => api.getStopAreas(line.id));
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
    const located = await runPooled(missing, opt.scanConcurrency, (stop) => api.findStopArea(stop.text));
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

  const scanDue = () => {
    if (now() < scanBackoffUntil) return false;
    const age = now() - lastScanAt;
    return age >= opt.scanIntervalMs || (rescanRequested && age >= opt.minRescanIntervalMs);
  };

  const positionsDue = () => positionsDirty || now() - positionsAt >= opt.positionsTtlMs;

  async function scan() {
    const stopList = await ensureStops();
    const callsWithStop = [];
    let succeeded = 0;
    await runPooled(stopList, opt.scanConcurrency, async (stop) => {
      const resp = await withRetry(() => api.getCalls(stop.text), opt.retryDelayMs);
      for (const group of resp?.calls ?? []) {
        for (const call of group.calls ?? []) callsWithStop.push({ call, stopText: stop.text });
      }
      succeeded += 1;
    });
    if (succeeded === 0) throw new Error('Unable to refresh live bus data.');

    for (const { call } of callsWithStop) {
      if (!call.routeId) continue;
      const routes = lineRoutes.get(call.lineId) ?? new Set();
      routes.add(call.routeId);
      lineRoutes.set(call.lineId, routes);
    }
    journeys = buildJourneys(callsWithStop);
    lastScanAt = now();
    rescanRequested = false;
    positionsDirty = true;
  }

  async function fetchPositions() {
    const callIds = [...new Set([...journeys.values()].flatMap((info) => info.positionCallIds))];
    const results = await runPooled(callIds, opt.positionConcurrency, (callId) => api.getVehiclePosition(callId));

    // Keep the actual GPS timestamp, not the time of this fetch. The journey
    // cache also covers calls disappearing or changing ids during a scan.
    const next = new Map();
    const unavailable = new Set();
    results.forEach((res, i) => {
      const callId = callIds[i];
      const previous = positions.get(callId);
      const incoming = res.status === 'fulfilled' ? res.value : null;
      if (incoming?.location && Number.isFinite(Date.parse(incoming.timestamp))) {
        next.set(callId, previous && Date.parse(previous.timestamp) > Date.parse(incoming.timestamp)
          ? previous : incoming);
        return;
      }
      unavailable.add(callId);
      if (previous) next.set(callId, previous);
    });

    positions = next;
    unavailableCallIds = unavailable;
    for (const [journeyId, info] of journeys) {
      const known = new Map(info.positionCallIds
        .filter((id) => positions.has(id))
        .map((id) => [id, positions.get(id)]));
      if (known.size) lastKnownJourneys.set(journeyId, { info, positions: known });
    }
    positionsAt = now();
    positionsDirty = false;
    const gotFix = results.some((res) => res.status === 'fulfilled' && res.value?.location &&
      Number.isFinite(Date.parse(res.value.timestamp)));
    if (unavailable.size) rescanRequested = true;
    positionsError = callIds.length && !gotFix ? 'Boreal returned no bus positions.' : null;
  }

  async function doRefresh() {
    await ensureClock();
    if (scanDue()) {
      try {
        await scan();
        scanError = null;
      } catch (err) {
        scanError = err.message;
        scanBackoffUntil = now() + opt.retryAfterFailureMs;
      }
    }
    if (positionsDue()) await fetchPositions();
  }

  function refreshIfNeeded() {
    if (!refreshing && (scanDue() || positionsDue())) {
      refreshing = doRefresh().finally(() => {
        refreshing = null;
      });
    }
    return refreshing ?? Promise.resolve();
  }

  return {
    // Latest snapshot of every live bus, refreshing first if data is stale.
    // Throws only when there is no data at all and Boreal can't be reached.
    async getBuses() {
      // With data in hand, a slow Boreal must not stall the response: wait a
      // bit, then serve what we have while the refresh finishes in the background.
      const refresh = refreshIfNeeded();
      if (journeys.size || lastKnownJourneys.size) {
        let timer;
        await Promise.race([refresh, new Promise((resolve) => (timer = setTimeout(resolve, opt.maxWaitMs)))]);
        clearTimeout(timer);
      } else {
        await refresh;
      }
      const error = scanError ?? positionsError;
      const nowMs = serverNow();
      const displayJourneys = new Map(journeys);
      const displayPositions = new Map(positions);
      const unavailable = new Set(unavailableCallIds);
      for (const [journeyId, cached] of lastKnownJourneys) {
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
      if (!displayJourneys.size && error) throw new Error(error);

      return {
        generatedAt: new Date(now()).toISOString(),
        serverTime: new Date(nowMs).toISOString(),
        error,
        vehicles: buildVehicles({
          journeys: displayJourneys, positions: displayPositions, nowMs, unavailableCallIds: unavailable,
        }),
        lineRoutes: Object.fromEntries([...lineRoutes].map(([lineId, routeIds]) => [lineId, [...routeIds]])),
      };
    },

    async getStops() {
      await ensureStops();
      return [...stopLocations].map(([id, { text, location }]) => ({ id, text, location }));
    },

    status() {
      return {
        journeys: journeys.size,
        stops: stops?.length ?? 0,
        lastScanAt: Number.isFinite(lastScanAt) ? new Date(lastScanAt).toISOString() : null,
        positionsAt: Number.isFinite(positionsAt) ? new Date(positionsAt).toISOString() : null,
        error: scanError ?? positionsError,
      };
    },
  };
}
