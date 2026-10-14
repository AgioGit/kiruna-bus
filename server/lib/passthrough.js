import { borealRequest, cacheKey } from './boreal.js';
import { TtlCache } from './cache.js';

// Endpoints the browser may call through /api/<name>. Anything else is 404.
export const PASSTHROUGH_ENDPOINTS = new Set([
  '/GetConfigOptions',
  '/GetLines',
  '/GetDirections',
  '/GetStopAreas',
  '/GetCalls',
  '/GetMapRoute',
  '/GetVehiclePosition',
  '/GetVehiclePositions',
  '/GetSystemTimestamp',
  '/Autocomplete',
  '/FindStopArea',
  '/FindStopsNearLocation',
]);

// How long successful responses are cached. Anything not listed
// (GetSystemTimestamp, FindStopsNearLocation) is never cached.
const TTL_MS = {
  '/GetCalls': 30_000,
  '/GetVehiclePosition': 15_000,
  '/GetVehiclePositions': 15_000,
  '/GetConfigOptions': 3_600_000,
  '/GetLines': 3_600_000,
  '/GetDirections': 3_600_000,
  '/GetStopAreas': 3_600_000,
  '/FindStopArea': 3_600_000,
  '/Autocomplete': 3_600_000,
  '/GetMapRoute': 3_600_000,
};

// Relays a browser request to Boreal with caching. Identical concurrent
// requests share one upstream call. Returns { status, contentType, body, cache }.
export function createPassthrough({ cache = new TtlCache(), request = borealRequest } = {}) {
  const inflight = new Map();

  return async function passthrough(path, { method, search = '', body }) {
    const load = () => request(path, { method, search, body, profile: path !== '/GetConfigOptions' });

    const ttl = TTL_MS[path];
    if (!ttl) return { ...(await load()), cache: 'BYPASS' };

    const key = cacheKey(path, { method, search, body });
    const hit = cache.get(key);
    if (hit) return { ...hit, cache: 'HIT' };

    let pending = inflight.get(key);
    if (!pending) {
      pending = load().then((res) => {
        if (res.status === 200) cache.set(key, res, ttl);
        return res;
      });
      inflight.set(key, pending);
      const clear = () => inflight.delete(key);
      pending.then(clear, clear);
    }
    return { ...(await pending), cache: 'MISS' };
  };
}
