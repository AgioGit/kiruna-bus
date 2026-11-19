import { CLOCK_SAMPLE_MAX_AGE } from './clock.js';
import { message } from './i18n.js';

const BASE_URL = (globalThis.BOREAL_CONFIG?.apiBase || '/api').replace(/\/+$/, '') + '/v1';

// Exposed so the SSE stream (opened directly via native EventSource, not the
// request() helper below) can target the same cross-origin-aware base URL
// as every other endpoint.
export const apiBase = BASE_URL;

export class ApiError extends Error {
  constructor(message, { endpoint, status, cause, code, retryAfter } = {}) {
    super(message, { cause });
    this.name = 'ApiError';
    Object.assign(this, { endpoint, status, code, retryAfter });
  }
}

// API/stream diagnostics keep their original message for callers and debug.
// Only known app-owned errors are localized; unknown/provider text passes through.
const errorTextKeys = new Map([
  ['The server returned invalid live data.', 'invalidLive'],
  ['The server returned invalid tracking status.', 'invalidTracking'],
  ['Unable to refresh live bus data.', 'liveRefreshFailed'],
  ['Some stops could not be refreshed.', 'someStopsFailed'],
  ['Boreal returned no bus positions.', 'positionsMissing'],
  ['Some bus positions could not be refreshed.', 'somePositionsFailed'],
]);
const errorCodeKeys = new Map([
  ['INVALID_RESPONSE', 'invalidResponse'], ['TIMEOUT', 'requestTimeout'], ['NETWORK_ERROR', 'requestOffline'],
  ['INVALID_CATALOG', 'invalidCatalog'], ['INVALID_REQUEST', 'invalidRequest'], ['INVALID_DATA', 'invalidResponse'],
  ['INTERNAL_ERROR', 'internalError'], ['HTTP_ERROR', 'requestFailed'], ['NOT_FOUND', 'notFound'],
  ['ROUTE_NOT_FOUND', 'routeMissing'], ['ROUTE_GEOMETRY_UNAVAILABLE', 'routeUnavailable'], ['STOP_NOT_FOUND', 'catalogStopMissing'],
  ['DEPARTURES_UNAVAILABLE', 'departureInfoUnavailable'], ['SHUTTING_DOWN', 'shuttingDown'],
  ['RATE_LIMITED', 'rateLimited'], ['STREAM_LIMIT', 'rateLimited'], ['WARMING_UP', 'trackingWarming'],
  ['LIVE_UNAVAILABLE', 'liveUnavailable'], ['STREAM_DATA_INVALID', 'liveDeliveryFailed'],
  ['UPSTREAM_SCHEMA', 'providerInvalid'], ['UPSTREAM_REDIRECT', 'providerRedirect'], ['UPSTREAM_SIZE', 'providerTooLarge'],
  ['UPSTREAM_REJECTED', 'providerRejected'], ['UPSTREAM_UNAVAILABLE', 'providerUnavailable'], ['UPSTREAM_NETWORK', 'providerUnreachable'],
  ['UPSTREAM_TIMEOUT', 'providerTimeout'], ['UPSTREAM_BUSY', 'providerBusy'], ['UPSTREAM_QUEUE_TIMEOUT', 'providerBusy'],
]);

export function errorMessage(error) {
  const detail = typeof error === 'string' ? error : error?.message;
  const key = errorTextKeys.get(detail) ?? errorCodeKeys.get(error?.code);
  return key ? message('translatedError', detail, message(key, error?.status)) : detail;
}

function retryAfter(value) {
  if (!value) return undefined;
  const seconds = /^\d+$/.test(value) ? Number(value) : Math.ceil((Date.parse(value) - Date.now()) / 1000);
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : undefined;
}

export async function request(path, { method = 'GET', query, body, signal, timeoutMs = 10000 } = {}) {
  const startedAt = performance.now();
  const url = new URL(BASE_URL + path, globalThis.location?.href ?? 'http://localhost/');
  for (const [key, value] of Object.entries(query ?? {})) if (value != null) url.searchParams.set(key, value);
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  const timeout = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), timeoutMs);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(url, {
      method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal,
    });
    const text = await response.text();
    controller.signal.throwIfAborted();
    let data;
    try { data = text ? JSON.parse(text) : null; }
    catch (cause) { throw new ApiError('The server returned invalid data.', { endpoint: path, status: response.status, code: 'INVALID_RESPONSE', cause }); }
    if (!response.ok) {
      throw new ApiError(data?.error?.message ?? `Request failed (${response.status}).`, {
        endpoint: path, status: response.status, code: data?.error?.code ?? 'HTTP_ERROR',
        retryAfter: retryAfter(response.headers.get('retry-after')),
      });
    }
    if (data && !Array.isArray(data) && response.headers.get('x-server-time')) {
      data.serverTime = response.headers.get('x-server-time');
      Object.defineProperty(data, CLOCK_SAMPLE_MAX_AGE, { value: Math.max(0, performance.now() - startedAt) });
    }
    if (data && !Array.isArray(data)) {
      Object.defineProperty(data, 'retryAfterMs', { value: retryAfter(response.headers.get('retry-after')) });
    }
    return data;
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Cancelled', 'AbortError');
    if (controller.signal.reason?.name === 'TimeoutError') {
      throw new ApiError('The request timed out. Please try again shortly.', { endpoint: path, code: 'TIMEOUT', cause: error });
    }
    if (error instanceof ApiError) throw error;
    throw new ApiError('Cannot reach the server. Check your connection.', { endpoint: path, code: 'NETWORK_ERROR', cause: error });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export const api = {
  getBootstrap: (opts) => request('/bootstrap', opts),
  getBuses: (opts) => request('/buses', opts),
  getTrafficInfo: (opts) => request('/traffic-info', opts),
  getUpstreamDebug: (opts) => request('/debug/upstream', opts),
  getStops: (opts) => request('/stops', opts),
  getMapRoute: (id, opts) => request(`/routes/${encodeURIComponent(id)}`, opts),
  getCalls: ({ stopId, passive }, opts) => request(`/stops/${encodeURIComponent(stopId)}/departures`,
    passive ? { ...opts, query: { mode: 'passive' } } : opts),
  autocomplete: (query, opts) => request('/search', { query: { q: query }, ...opts }),
  findStopArea: (text, opts) => request('/resolve', { query: { q: text }, ...opts }),
  findStopsNearLocation: (coordinate, { maxCount = 5, maxDistance = 1000 } = {}, opts) =>
    request('/nearby', { method: 'POST', body: { coordinate, maxCount, maxDistance }, ...opts }),
};
