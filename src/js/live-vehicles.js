import { api } from './api.js';
import { store } from './appState.js';
import { mergeLineRoutes } from './routes.js';
import { synchronizeClock } from './clock.js';

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

// All journey tracking (town-wide stop scan, position fetches, next-stop
// forecasts, stale flagging) lives on the server; see server/lib/tracker.js.
// One request per tick returns every running bus ready to display.
export async function refreshLiveVehicles({ signal, isCurrent = () => true } = {}) {
  const data = await api.getBuses({ signal });
  if (signal?.aborted || !isCurrent()) return [];
  const serverNowMs = Date.parse(data.serverTime ?? '');
  const nowMs = Number.isNaN(serverNowMs) ? Date.now() : serverNowMs;
  const vehicles = (data.vehicles ?? []).filter((bus) => isNextStopSoon(bus, nowMs) && isPositionFresh(bus, nowMs));
  synchronizeClock(data.serverTime);
  expirePositions(vehicles, nowMs, performance.now());
  store.set({
    liveQuality: data.quality ?? null,
    errors: { ...store.get().errors, vehicles: data.error ?? null },
  });
  mergeLineRoutes(data.lineRoutes);
  return vehicles;
}
