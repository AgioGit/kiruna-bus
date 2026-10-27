import { CLOCK_SAMPLE_MAX_AGE } from './clock.js';

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
  getStops: (opts) => request('/stops', opts),
  getMapRoute: (id, opts) => request(`/routes/${encodeURIComponent(id)}`, opts),
  getCalls: ({ stopId }, opts) => request(`/stops/${encodeURIComponent(stopId)}/departures`, opts),
  autocomplete: (query, opts) => request('/search', { query: { q: query }, ...opts }),
  findStopArea: (text, opts) => request('/resolve', { query: { q: text }, ...opts }),
  findStopsNearLocation: (coordinate, { maxCount = 5, maxDistance = 1000 } = {}, opts) =>
    request('/nearby', { method: 'POST', body: { coordinate, maxCount, maxDistance }, ...opts }),
};
