import { setTimeout as delay } from 'node:timers/promises';
import { config } from './config.js';
import { AppError } from './errors.js';
import { TtlCache } from './cache.js';
import { createScheduler } from './scheduler.js';
import { createTelemetry } from './telemetry.js';
import { validate } from './validation.js';
import { withSignal } from './pool.js';

export class UpstreamError extends AppError {
  constructor(message, { status = 502, cause, code = 'UPSTREAM_ERROR', retryAfter } = {}) {
    super(code, message, { status, cause, retryAfter });
    this.name = 'UpstreamError';
  }
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function cacheKey(path, { method = 'GET', search = '', body } = {}) {
  const query = new URLSearchParams(search);
  query.sort();
  return `${method} ${path}?${query} ${body ? canonicalJson(JSON.parse(body)) : ''}`;
}

const schemaByPath = {
  '/GetConfigOptions': 'upstreamConfig',
  '/GetLines': 'lines', '/GetStopAreas': 'stops', '/GetCalls': 'calls',
  '/GetVehiclePosition': 'position', '/GetMapRoute': 'route', '/GetSystemTimestamp': 'timestamp',
};
const ttlByPath = {
  '/GetCalls': 30000, '/GetVehiclePosition': 15000, '/GetVehiclePositions': 15000,
  '/GetLines': 3600000, '/GetStopAreas': 3600000, '/GetMapRoute': 3600000,
  '/GetConfigOptions': 3600000, '/GetDirections': 3600000,
  '/Autocomplete': 3600000, '/FindStopArea': 3600000,
};

export function retryAfterSeconds(value, now = Date.now()) {
  if (!value) return undefined;
  const seconds = /^\d+$/.test(value) ? Number(value) : Math.ceil((Date.parse(value) - now) / 1000);
  return Number.isFinite(seconds) ? Math.max(0, seconds) : undefined;
}

export function createBoreal({ settings = config, fetchImpl = fetch, telemetry = createTelemetry(), now = Date.now } = {}) {
  const scheduler = createScheduler({
    concurrency: settings.upstreamConcurrency, maxQueue: settings.upstreamQueueSize, queueMs: settings.upstreamQueueMs,
  });
  const cache = new TtlCache({ now });
  const inflight = new Map();
  const shutdown = new AbortController();

  function recordFailure(path, error) {
    telemetry.count('upstreamFailures');
    if (error.code === 'UPSTREAM_TIMEOUT') telemetry.count('upstreamTimeouts');
    telemetry.log('upstream_failure', { endpoint: path, code: error.code ?? error.name });
  }

  async function load(path, { method = 'GET', search = '', body, profile = true, priority = 'interactive' }) {
    const started = performance.now();
    const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(settings.upstreamTimeoutMs * 2 + 1000)]);
    for (let attempt = 0; ; attempt++) {
      const attemptStarted = performance.now();
      try {
        return await scheduler.run(async () => {
          telemetry.count('upstreamRequests');
          const headers = profile ? {
            'anyride-profile-data': settings.profileData, 'anyride-profile-display': settings.profileDisplay,
          } : {};
          if (body !== undefined) headers['content-type'] = 'application/json';
          const response = await fetchImpl(settings.borealBase + path + search, {
            method, headers, body,
            signal: AbortSignal.any([signal, AbortSignal.timeout(settings.upstreamTimeoutMs)]),
          });
          if (response.status === 429 || response.status >= 500) {
            await response.body?.cancel();
            throw new UpstreamError('The transit provider is temporarily unavailable.', {
              code: 'UPSTREAM_UNAVAILABLE', status: response.status === 429 ? 503 : 502,
              retryAfter: retryAfterSeconds(response.headers.get('retry-after')),
            });
          }
          const chunks = [];
          let size = 0;
          for await (const chunk of response.body ?? []) {
            size += chunk.length;
            if (size > settings.upstreamMaxBytes) {
              throw new UpstreamError('The transit provider response was too large.', { code: 'UPSTREAM_SIZE' });
            }
            chunks.push(Buffer.from(chunk));
          }
          const buffer = Buffer.concat(chunks);
          if (response.ok) {
            let value;
            try { value = JSON.parse(buffer.toString('utf8')); }
            catch (cause) { throw new UpstreamError('The transit provider returned invalid JSON.', { code: 'UPSTREAM_SCHEMA', cause }); }
            const schema = schemaByPath[path];
            if (schema) validate(schema, value, { upstream: true });
            if (path === '/FindStopArea' && value !== null) validate('stop', value, { upstream: true });
          }
          return { status: response.status, contentType: response.headers.get('content-type'), body: buffer, fetchedAt: now() };
        }, { priority, signal });
      } catch (cause) {
        const transient = cause.code === 'UPSTREAM_UNAVAILABLE' || cause.name === 'TimeoutError'
          || cause.name === 'TypeError' || cause.name === 'AbortError';
        if (attempt === 0 && transient && !signal.aborted && (cause.retryAfter ?? 0) <= 5) {
          telemetry.count('upstreamRetries');
          try {
            await delay(cause.retryAfter ? cause.retryAfter * 1000 : 250 + Math.random() * 250, undefined, { signal });
          } catch (error) {
            const interrupted = new UpstreamError('The transit provider request was interrupted.', {
              code: signal.reason?.name === 'TimeoutError' ? 'UPSTREAM_TIMEOUT' : 'SHUTTING_DOWN',
              status: signal.reason?.name === 'TimeoutError' ? 504 : 503, cause: error,
            });
            recordFailure(path, interrupted);
            throw interrupted;
          }
          continue;
        }
        const error = cause instanceof AppError ? cause : new UpstreamError('The transit provider could not be reached.', {
          status: cause.name === 'TimeoutError' || signal.reason?.name === 'TimeoutError' ? 504 : 502,
          code: cause.name === 'TimeoutError' || signal.reason?.name === 'TimeoutError' ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_NETWORK', cause,
        });
        recordFailure(path, error);
        throw error;
      } finally {
        telemetry.duration('upstreamAttempt', performance.now() - attemptStarted);
        if (attempt > 0) telemetry.duration('upstreamRetryOperation', performance.now() - started);
      }
    }
  }

  async function request(path, options = {}) {
    const key = cacheKey(path, options);
    const ttl = ttlByPath[path];
    // `fresh` bypasses the cache *read* so scheduled collector cycles always perform a genuine
    // upstream check (per-path TTLs would otherwise outlive the 30s/15min cycle cadence and mask
    // staleness). The result is still written to cache afterward for other, non-fresh callers.
    const useCache = ttl && !options.fresh;
    const hit = useCache ? cache.get(key) : undefined;
    if (hit) {
      telemetry.count('cacheHits');
      telemetry.log('upstream_cache', { endpoint: path, outcome: 'HIT' });
      return { ...hit, cache: 'HIT' };
    }
    telemetry.count('cacheMisses');
    let pending = inflight.get(key);
    telemetry.log('upstream_cache', { endpoint: path, outcome: pending ? 'COALESCED' : useCache ? 'MISS' : 'BYPASS' });
    if (!pending) {
      pending = load(path, options).then((res) => {
        if (res.status === 200 && ttl) cache.set(key, res, ttl);
        return res;
      });
      inflight.set(key, pending);
      const clear = () => inflight.delete(key);
      pending.then(clear, clear);
    }
    return { ...(await withSignal(pending, options.signal)), cache: useCache ? 'MISS' : 'BYPASS' };
  }

  async function json(path, options = {}) {
    const response = await request(path, options);
    if (response.status < 200 || response.status >= 300) {
      throw new UpstreamError('The transit provider rejected the request.', { code: 'UPSTREAM_REJECTED' });
    }
    const value = JSON.parse(response.body.toString('utf8'));
    if (value && typeof value === 'object') Object.defineProperty(value, 'fetchedAt', { value: response.fetchedAt });
    return value;
  }
  return {
    request,
    getConfig: (options) => json('/GetConfigOptions', { search: '?profile=&language=sv', profile: false, ...options }),
    getLines: (options) => json('/GetLines', options),
    getStopAreas: (lineId, options) => json('/GetStopAreas', { method: 'POST', body: JSON.stringify({ lineId, directionId: null }), ...options }),
    findStopArea: (text, options) => json('/FindStopArea', { method: 'POST', body: JSON.stringify({ StopAreaQuery: text }), ...options }),
    getCalls: (text, options) => json('/GetCalls', { method: 'POST', body: JSON.stringify({
      query: { fromStopAreaQuery: text, toStopAreaName: '', lineId: 0, directionId: 0 },
      configuration: { grouping: ['Line', 'Destination1'] },
    }), ...options }),
    getMapRoute: (id, options) => json('/GetMapRoute', { search: `?routeId=${encodeURIComponent(id)}`, ...options }),
    async getVehiclePosition(id, options) {
      const position = await json('/GetVehiclePosition', { search: `?callId=${encodeURIComponent(id)}`, ...options });
      return position ? { location: { lat: position.location.lat, lon: position.location.lon },
        timestamp: position.timestamp, heading: position.heading ?? null } : null;
    },
    getSystemTimestamp: (timestamp, options) => json('/GetSystemTimestamp', { search: `?clientTimestamp=${encodeURIComponent(timestamp)}`, ...options }),
    status: () => ({ ...scheduler.status(), cacheEntries: cache.size, cacheBytes: cache.bytes }),
    close() { shutdown.abort(new DOMException('Server shutting down', 'AbortError')); scheduler.close(); },
  };
}

let defaultClient;
export const borealRequest = (path, options) => (defaultClient ??= createBoreal()).request(path, options);
