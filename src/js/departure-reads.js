import { api } from './api.js';

const COALESCE_MS = 5000; // A calls publication can be followed immediately by a GPS publication.
const MAX_AGE_MS = 120000;
const MAX_CACHE_SIZE = 256;
const entries = new Map();
const listeners = new Set();
let rateLimitedUntil = 0;

export function getDepartureRead(id) { return entries.get(id); }

export function departureReadState(read, elapsed = performance.now()) {
  if (!read?.response) return read?.error ? 'unavailable' : 'loading';
  if (read.expiresAt <= elapsed) return 'unavailable';
  return read.error || read.freshUntil <= elapsed ? 'stale' : 'fresh';
}

export function departureReadReadyAt(id) {
  const entry = entries.get(id);
  return entry?.flight && !entry.flight.controller.signal.aborted
    ? 0 : Math.max(rateLimitedUntil, entry?.nextReadAt ?? 0);
}

export function subscribeDepartureReads(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(id) { for (const listener of listeners) listener(id); }

function getEntry(id) {
  const entry = entries.get(id) ?? { failures: 0, nextReadAt: 0 };
  entries.delete(id);
  entries.set(id, entry);
  if (entries.size > MAX_CACHE_SIZE) {
    for (const [key, item] of entries) {
      if (key !== id && !item.flight && item.nextReadAt <= performance.now()) {
        entries.delete(key);
        break;
      }
    }
  }
  return entry;
}

function saveResponse(entry, response, startedAt) {
  if (!Array.isArray(response?.calls)) throw new TypeError('The server returned invalid departures.');
  const receivedAt = performance.now();
  const age = Math.max(0, Date.now() - Date.parse(response.updatedAt));
  const deadline = (relative, legacyRemaining) => Number.isFinite(relative) && relative >= 0
    ? startedAt + Math.min(relative, MAX_AGE_MS)
    : receivedAt + Math.max(0, legacyRemaining || 0);
  entry.response = response;
  entry.expiresAt = response.state === 'unavailable' ? receivedAt : deadline(response.expiresInMs, MAX_AGE_MS - age);
  entry.freshUntil = response.state === 'stale' ? receivedAt : deadline(response.freshForMs, 30000 - age);
  entry.error = null;
  entry.failures = 0;
  entry.nextReadAt = receivedAt + Math.max(COALESCE_MS, response.retryAfterMs ?? 0);
  return entry;
}

function startRead(id, entry, passive) {
  const controller = new AbortController();
  const startedAt = performance.now();
  const flight = { controller, consumers: 0 };
  entry.flight = flight;
  flight.promise = (async () => {
    try {
      const response = await api.getCalls({ stopId: id, passive }, { signal: controller.signal });
      controller.signal.throwIfAborted();
      return saveResponse(entry, response, startedAt);
    } catch (error) {
      if (!controller.signal.aborted) {
        entry.error = error;
        const timestamp = performance.now();
        const backoff = Math.min(300000, COALESCE_MS * 2 ** Math.min(entry.failures++, 6));
        entry.nextReadAt = timestamp + Math.max(backoff, error.retryAfter ?? 0);
        if (error.status === 429) rateLimitedUntil = Math.max(rateLimitedUntil, entry.nextReadAt);
      }
      throw error;
    } finally {
      if (entry.flight === flight) {
        entry.flight = null;
        notify(id);
      }
    }
  })();
  return flight;
}

// The request belongs to both consumers. Withdrawing one view must not
// cancel work the other view still needs.
export async function readDepartures(id, { passive = false, signal } = {}) {
  signal?.throwIfAborted();
  const entry = getEntry(id);
  let flight = entry.flight;
  if (!flight || flight.controller.signal.aborted) {
    const readyAt = departureReadReadyAt(id);
    if (readyAt > performance.now()) {
      if (entry.error) throw entry.error;
      if (entry.response) return entry;
      throw new Error('Departure reads are temporarily limited.');
    }
    flight = startRead(id, entry, passive);
  }
  flight.consumers++;
  return new Promise((resolve, reject) => {
    function release() {
      signal?.removeEventListener('abort', abort);
      if (--flight.consumers === 0 && entry.flight === flight) flight.controller.abort();
    }
    function abort() { release(); reject(signal.reason); }
    signal?.addEventListener('abort', abort, { once: true });
    flight.promise.then((value) => {
      if (!signal?.aborted) { release(); resolve(value); }
    }, (error) => {
      if (!signal?.aborted) { release(); reject(error); }
    });
  });
}
