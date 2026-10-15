import { api, ApiError } from './api.js';
import { store } from './appState.js';
import { mergeLineRoutes } from './routes.js';
import { synchronizeClock } from './clock.js';
import { acceptRevision, classifyRevision, getTrackingState, isValidBusesSnapshot } from './tracking.js';

// Buses whose next stop is further away than this are left out: they are
// parked or between trips and not worth showing yet.
export const MAX_NEXT_STOP_MS = 10 * 60 * 1000;
export const MAX_POSITION_AGE_MS = 3 * 60 * 1000;

let expiryTimer = null;

export function isPositionFresh(bus, nowMs) {
  const timestamp = Date.parse(bus.position?.timestamp ?? '');
  return Number.isFinite(timestamp) && nowMs - timestamp <= MAX_POSITION_AGE_MS;
}

function expirePositions(vehicles, serverNowMs, receivedAt) {
  if (expiryTimer != null) clearTimeout(expiryTimer);
  expiryTimer = null;
  const nowMs = serverNowMs + performance.now() - receivedAt;
  const fresh = vehicles.filter((bus) => isPositionFresh(bus, nowMs));
  store.set({ liveVehicles: fresh, journeyStops: buildJourneyStops(fresh) });
  if (!fresh.length) return;
  const nextExpiry = Math.min(...fresh.map((bus) => Date.parse(bus.position.timestamp) + MAX_POSITION_AGE_MS));
  expiryTimer = setTimeout(() => expirePositions(fresh, serverNowMs, receivedAt), nextExpiry - nowMs + 1);
  expiryTimer?.unref?.();
}

export function isNextStopSoon(bus, nowMs) {
  const forecastMs = Date.parse(bus.nextStop?.forecastTime ?? '');
  if (Number.isNaN(forecastMs)) return true;
  return forecastMs - nowMs <= MAX_NEXT_STOP_MS;
}

// Maps journeyId -> ordered upcoming stops for the trip detail cards.
export function buildJourneyStops(vehicles) {
  const journeyStops = new Map();
  for (const bus of vehicles) {
    if (bus.journeyId != null) journeyStops.set(bus.journeyId, bus.upcomingStops ?? []);
  }
  return journeyStops;
}

function applySnapshotMetadata(data) {
  synchronizeClock(data.serverTime);
  store.set({
    liveQuality: data.quality,
    errors: { ...store.get().errors, vehicles: data.error ?? null },
  });
}

// Applies one validated, in-order buses DTO (from either the HTTP poll path
// or an SSE 'buses' event) to application state: expiry/next-stop filtering,
// the clock offset, quality/error surfacing and the line-route cache. Pure
// state application only - callers decide (via tracking.js) whether a given
// payload is new enough to reach this function at all. Returns the filtered
// vehicle list actually stored.
export function applySnapshot(data) {
  const serverNowMs = Date.parse(data.serverTime ?? '');
  const nowMs = Number.isNaN(serverNowMs) ? Date.now() : serverNowMs;
  const vehicles = (data.vehicles ?? []).filter((bus) => isNextStopSoon(bus, nowMs) && isPositionFresh(bus, nowMs));
  applySnapshotMetadata(data);
  expirePositions(vehicles, nowMs, performance.now());
  mergeLineRoutes(data.lineRoutes);
  return vehicles;
}

// Validates and orders-checks a buses DTO before applying it. Shared by the
// HTTP poll path and the SSE stream so both honor the same epoch/revision
// guarantees (see tracking.js): a malformed payload or a stale/duplicate
// revision never reaches applySnapshot. Returns the classification plus the
// vehicles actually applied (null when nothing was applied).
export function acceptBusesSnapshot(data) {
  if (!isValidBusesSnapshot(data)) return { outcome: 'invalid', vehicles: null };
  const outcome = classifyRevision(data);
  if (outcome === 'stale') return { outcome, vehicles: null };
  if (outcome === 'duplicate') {
    applySnapshotMetadata(data);
    return { outcome, vehicles: null };
  }
  const vehicles = applySnapshot(data);
  acceptRevision(data);
  return { outcome, vehicles };
}

// All journey tracking (town-wide stop scan, position fetches, next-stop
// forecasts, stale flagging) lives on the server; see server/lib/tracker.js.
// One request returns every running bus ready to display; used for the
// visible-tab initial read and the SSE delivery-watchdog HTTP fallback.
export async function refreshLiveVehicles({ signal, isCurrent = () => true } = {}) {
  const before = getTrackingState();
  const data = await api.getBuses({ signal });
  if (signal?.aborted || !isCurrent()) return { outcome: 'aborted', vehicles: null };
  const current = getTrackingState();
  if (current.epoch !== before.epoch && data?.epoch !== current.epoch) {
    return { outcome: 'stale', vehicles: null };
  }
  const result = acceptBusesSnapshot(data);
  if (result.outcome === 'invalid') {
    throw new ApiError('The server returned invalid live data.', { code: 'INVALID_RESPONSE', endpoint: '/buses' });
  }
  return { ...result, data };
}
