import http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { config } from './lib/config.js';
import { createBoreal } from './lib/boreal.js';
import { createTracker } from './lib/tracker.js';
import { createCatalog, loadCatalog } from './lib/catalog.js';
import { createCollector } from './lib/collector.js';
import { createStreamHub } from './lib/stream.js';
import { createPassthrough, PASSTHROUGH_ENDPOINTS } from './lib/passthrough.js';
import { serveStatic } from './lib/static.js';
import { AppError } from './lib/errors.js';
import { createTelemetry } from './lib/telemetry.js';
import { validate } from './lib/validation.js';

const POST_ENDPOINTS = new Set(['/GetStopAreas', '/GetCalls', '/FindStopArea', '/FindStopsNearLocation']);
// Departures are served from the shared collector's per-stop call cache
// (never a request-driven upstream lookup). A stop's cached calls remain
// servable for up to three minutes; past that, departures report 503
// rather than silently going stale forever.
const DEPARTURES_MAX_AGE_MS = 3 * 60 * 1000;
const legacyQuery = {
  '/GetConfigOptions': ['profile', 'language'], '/Autocomplete': ['query'],
  '/GetDirections': ['lineId'], '/GetMapRoute': ['routeId'], '/GetVehiclePosition': ['callId'],
  '/GetSystemTimestamp': ['clientTimestamp'],
};
const badRequest = (message) => new AppError('INVALID_REQUEST', message, { status: 400 });

function checkQuery(url, allowed = []) {
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) throw badRequest('Unexpected or repeated query parameter');
  }
}
function positiveId(raw) {
  if (!/^[1-9]\d{0,14}$/.test(raw ?? '') || !Number.isSafeInteger(Number(raw))) throw badRequest('A positive numeric identifier is required');
  return Number(raw);
}
function textParameter(url, key) {
  const value = url.searchParams.get(key)?.trim();
  if (!value || value.length > 160) throw badRequest(`${key} must contain 1 to 160 characters`);
  return value;
}
async function readJson(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Use application/json', { status: 415 });
  }
  const bytes = await new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const cleanup = () => {
      req.removeListener('data', data);
      req.removeListener('end', end);
      req.removeListener('error', fail);
      req.removeListener('aborted', aborted);
    };
    const fail = (error) => { cleanup(); reject(error); };
    const aborted = () => fail(badRequest('Request body was interrupted'));
    const end = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    const data = (chunk) => {
      size += chunk.length;
      if (size > 65536) {
        fail(new AppError('BODY_TOO_LARGE', 'Request body is too large', { status: 413 }));
        req.resume();
      } else chunks.push(chunk);
    };
    req.on('data', data);
    req.once('end', end);
    req.once('error', fail);
    req.once('aborted', aborted);
  });
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw badRequest('Request body must be valid JSON'); }
}
function forecastDto(value) {
  if (!value) return null;
  return { plannedTime: value.plannedTime ?? null, forecastTime: value.forecastTime ?? null, quality: value.quality ?? null };
}
// Normalizes the tracker's shared raw per-stop GetCalls entry (calls already
// flattened, messages/cancellation preserved) into the public departures DTO.
// `entry` is whatever `tracker.getStopCalls(id)` returned; the caller already
// checked its age is within DEPARTURES_MAX_AGE_MS.
function callDto(call) {
  return {
    id: call.id, lineId: call.lineId, routeId: call.routeId ?? null, journeyId: call.journeyId,
    sequenceNumber: call.sequenceNumber, line: call.line, destination: call.destination,
    arrival: forecastDto(call.arrival), departure: forecastDto(call.departure),
  };
}
function messageDto({ text, isDisturbance, affectedCalls, lines }) {
  return {
    text, isDisturbance: Boolean(isDisturbance), affectedCalls: affectedCalls === undefined ? [] : affectedCalls,
    lines: lines === undefined ? [] : lines.map(({ lineId }) => ({ lineId })),
  };
}
function observationDto(observation) {
  return {
    ...observation, call: callDto(observation.call),
    messages: observation.messages.map(messageDto),
  };
}
export function departuresDto(entry, { nowMs, freshWithinMs, previousDeparture = null, pendingDepartures = [], unavailable = false }) {
  return {
    calls: unavailable ? [] : entry.calls.map(callDto),
    messages: (entry.messages ?? []).map(messageDto),
    isStopCancelled: Boolean(entry.isStopCancelled),
    updatedAt: new Date(entry.at).toISOString(),
    state: unavailable ? 'unavailable' : !entry.failed && nowMs - entry.at <= freshWithinMs ? 'fresh' : 'stale',
    previousDeparture: previousDeparture ? observationDto(previousDeparture) : null,
    pendingDepartures: pendingDepartures.map(observationDto),
  };
}

export function createApplication({
  settings = config, telemetry = createTelemetry(), now = Date.now,
  api = createBoreal({ settings, telemetry, now }),
  catalog = createCatalog({ snapshot: loadCatalog(settings.snapshotPath), api, telemetry, now, refreshTimeoutMs: settings.refreshTimeoutMs }),
  tracker = createTracker({ api, initialStops: catalog.get().stops, stopSource: () => catalog.get().stops,
    telemetry, now, options: { refreshTimeoutMs: settings.refreshTimeoutMs } }),
  collector = createCollector({ tracker, catalog, telemetry, now, config: settings }),
} = {}) {
  const passthrough = createPassthrough({ request: api.request });
  const streamHub = createStreamHub({
    collector, tracker, catalog, telemetry, now,
    maxConnections: settings.streamMaxConnections,
    maxConnectionsPerClient: settings.streamMaxConnectionsPerClient,
    heartbeatMs: settings.streamHeartbeatMs,
    slowReaderMs: settings.streamSlowReaderMs,
    maxPendingBytes: settings.streamMaxPendingBytes,
  });
  const clients = new Map();
  let globalBucket = { at: now(), count: 0 };
  let draining = false;

  // Shared by the per-minute rate limiter and the stream hub's per-client
  // connection cap, so both honor the same trusted-proxy policy.
  function clientAddress(req) {
    let address = req.socket.remoteAddress;
    if (settings.trustProxy && req.headers['x-forwarded-for']) {
      address = req.headers['x-forwarded-for'].split(',').at(-1).trim();
      if (!isIP(address)) throw badRequest('Invalid forwarded client address');
    }
    return address;
  }

  function rateLimit(req) {
    const address = clientAddress(req);
    const time = now();
    if (time - globalBucket.at >= 60000) globalBucket = { at: time, count: 0 };
    let bucket = clients.get(address);
    if (!bucket || time - bucket.at >= 60000) {
      if (clients.size >= 10000) {
        for (const [key, entry] of clients) if (time - entry.at >= 60000) clients.delete(key);
        if (clients.size >= 10000) throw new AppError('RATE_LIMITED', 'Server is busy. Try again shortly.', { status: 429, retryAfter: 60 });
      }
      bucket = { at: time, count: 0 };
      clients.set(address, bucket);
    }
    if (bucket.count >= settings.clientRequestsPerMinute || globalBucket.count >= settings.globalRequestsPerMinute) {
      telemetry.count('rateLimited');
      throw new AppError('RATE_LIMITED', 'Too many requests. Try again shortly.', { status: 429, retryAfter: 60 });
    }
    bucket.count++;
    globalBucket.count++;
  }
  const server = http.createServer({ requestTimeout: 15000, headersTimeout: 10000, keepAliveTimeout: 5000 }, async (req, res) => {
    const started = performance.now();
    const requestId = randomUUID();
    let route = 'static';
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const origin = req.headers.origin;
    res.setHeader('Vary', 'Origin');
    if (origin && (settings.allowedOrigins.includes('*') || settings.allowedOrigins.includes(origin))) {
      res.setHeader('Access-Control-Allow-Origin', settings.allowedOrigins.includes('*') ? '*' : origin);
      res.setHeader('Access-Control-Expose-Headers', 'Retry-After, X-Request-Id, X-Server-Time, X-Cache');
    }
    res.on('finish', () => {
      telemetry.count(`http${Math.floor(res.statusCode / 100)}xx`);
      telemetry.duration('http', performance.now() - started);
      telemetry.log('request', { requestId, route, method: req.method, status: res.statusCode, durationMs: Math.round(performance.now() - started), cache: res.getHeader('X-Cache') });
    });
    function json(status, payload, { schema, etag = false, headers = {} } = {}) {
      if (schema) validate(schema, payload);
      const body = JSON.stringify(payload);
      const cache = etag ? `"${createHash('sha256').update(JSON.stringify(payload.catalog ?? payload)).digest('hex')}"` : undefined;
      const common = { 'Cache-Control': 'no-cache', 'X-Server-Time': payload?.serverTime ?? tracker.serverTime?.() ?? new Date(now()).toISOString(), ...headers };
      if (cache) common.ETag = cache;
      if (cache && req.headers['if-none-match'] === cache) {
        res.writeHead(304, common);
        res.end();
        return;
      }
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...common });
      res.end(req.method === 'HEAD' ? undefined : body);
    }
    function method(allowed) {
      if (!allowed.includes(req.method)) {
        res.setHeader('Allow', allowed.join(', '));
        throw new AppError('METHOD_NOT_ALLOWED', 'Method not allowed', { status: 405 });
      }
    }
    try {
      const url = new URL(req.url, 'http://localhost');
      const pathname = url.pathname.replace(/\/+$/, '') || '/';
      if (!pathname.startsWith('/api/') && pathname !== '/api') {
        if (settings.staticDir && await serveStatic(req, res, settings.staticDir, pathname)) return;
        throw new AppError('NOT_FOUND', 'Not found', { status: 404 });
      }
      route = pathname.startsWith('/api/v1/stops/') ? '/api/v1/stops/:id/departures'
        : pathname.startsWith('/api/v1/routes/') ? '/api/v1/routes/:id'
          : ['/api/v1/bootstrap', '/api/v1/buses', '/api/v1/stops', '/api/v1/stream', '/api/v1/search', '/api/v1/resolve', '/api/v1/nearby',
            '/api/live', '/api/ready', '/api/status', '/api/health', '/api/buses', '/api/stops'].includes(pathname)
            || PASSTHROUGH_ENDPOINTS.has(pathname.slice(4)) ? pathname : 'unknown_api';
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'content-type, anyride-profile-data, anyride-profile-display',
          'Access-Control-Max-Age': '86400',
        });
        res.end();
        return;
      }
      if (['/api/live', '/api/ready', '/api/status', '/api/health'].includes(pathname)) {
        method(['GET']);
        checkQuery(url);
        const ready = !draining && Boolean(catalog.get());
        if (pathname === '/api/live') return json(200, { ok: true });
        if (pathname === '/api/ready') return json(ready ? 200 : 503, { ready });
        if (pathname === '/api/health') return json(200, { ok: true, uptimeSeconds: Math.round(process.uptime()), ...tracker.status() });
        return json(200, {
          ready, ...tracker.status(), upstream: api.status(), metrics: telemetry.snapshot(),
          collector: collector.status(), stream: streamHub.status(),
        });
      }
      if (draining) throw new AppError('SHUTTING_DOWN', 'Server is shutting down', { status: 503, retryAfter: 5 });
      rateLimit(req);
      if (pathname === '/api/v1/bootstrap') {
        method(['GET']); checkQuery(url);
        // Static content: never activates the collector and never triggers
        // its own catalog refresh -- that is the static cycle's job.
        return json(200, { ...catalog.bootstrap(), serverTime: tracker.serverTime?.() ?? new Date(now()).toISOString() }, { schema: 'bootstrap', etag: true });
      }
      if (pathname === '/api/v1/buses') {
        method(['GET']); checkQuery(url);
        collector.noteHttpActivity();
        const snapshot = tracker.getSnapshot();
        return json(200, { ...snapshot, epoch: collector.epoch, revision: tracker.getRevision(), catalogVersion: catalog.get().version }, { schema: 'buses' });
      }
      if (pathname === '/api/v1/stream') {
        method(['GET']); checkQuery(url);
        streamHub.handle(req, res, { address: clientAddress(req) });
        return;
      }
      if (pathname === '/api/v1/stops') {
        method(['GET']); checkQuery(url);
        return json(200, catalog.get().stops, { schema: 'stops', etag: true });
      }
      if (/^\/api\/v1\/routes\/[^/]+$/.test(pathname)) {
        method(['GET']); checkQuery(url);
        return json(200, await catalog.route(positiveId(pathname.split('/').at(-1))), { schema: 'route', etag: true });
      }
      const match = /^\/api\/v1\/stops\/([^/]+)\/departures$/.exec(pathname);
      if (match) {
        method(['GET']); checkQuery(url);
        const id = positiveId(match[1]);
        const stop = catalog.stop(id);
        collector.noteHttpActivity();
        const entry = tracker.getStopCalls(stop.id);
        const history = tracker.getDepartureHistory?.(stop.id) ??
          { previous: tracker.getPreviousDeparture?.(stop.id) ?? null, pending: [] };
        const previousDeparture = history.previous;
        const pendingDepartures = history.pending;
        const nowMs = now();
        if (!entry || nowMs - entry.at > DEPARTURES_MAX_AGE_MS) {
          if (previousDeparture || pendingDepartures.length) {
            return json(200, departuresDto({
              calls: [], messages: [], isStopCancelled: false, at: Date.parse((previousDeparture ?? pendingDepartures[0]).observedAt),
            }, { nowMs, freshWithinMs: settings.dynamicIntervalMs, previousDeparture, pendingDepartures, unavailable: true }), { schema: 'departures' });
          }
          throw new AppError('DEPARTURES_UNAVAILABLE', 'Departure information is currently unavailable.', { status: 503, retryAfter: 5 });
        }
        return json(200, departuresDto(entry, { nowMs, freshWithinMs: settings.dynamicIntervalMs, previousDeparture, pendingDepartures }), { schema: 'departures' });
      }
      if (pathname === '/api/v1/search' || pathname === '/api/v1/resolve') {
        method(['GET']); checkQuery(url, ['q']);
        const query = textParameter(url, 'q').toLocaleLowerCase('sv');
        const stops = catalog.get().stops;
        const result = pathname.endsWith('/resolve') ? stops.find((stop) => stop.text.toLocaleLowerCase('sv') === query) ?? null
          : stops.filter((stop) => stop.text.toLocaleLowerCase('sv').includes(query)).slice(0, 20).map((stop) => stop.text);
        return json(200, result);
      }
      if (pathname === '/api/v1/nearby') {
        method(['POST']); checkQuery(url);
        const input = await readJson(req);
        try { validate('nearbyRequest', input); } catch { throw badRequest('Invalid nearby search coordinates or limits'); }
        const count = input.maxCount ?? 5;
        const maxDistance = input.maxDistance ?? 1000;
        const distance = (location) => Math.hypot(
          (location.lat - input.coordinate.lat) * 111320,
          (location.lon - input.coordinate.lon) * 111320 * Math.cos(input.coordinate.lat * Math.PI / 180));
        return json(200, catalog.get().stops.map((stop) => ({ stop, distance: distance(stop.location) }))
          .filter((entry) => entry.distance <= maxDistance).sort((a, b) => a.distance - b.distance).slice(0, count).map((entry) => entry.stop));
      }
      if (pathname === '/api/buses' || pathname === '/api/stops') {
        method(['GET']); checkQuery(url);
        telemetry.count('legacyRequests');
        if (pathname.endsWith('/buses')) {
          collector.noteHttpActivity();
          let cached = false;
          try { tracker.getBuses(); cached = true; }
          catch (error) { if (!(error instanceof AppError && error.status === 503)) throw error; }
          const refresh = collector.refreshIfDue();
          if (cached) {
            let timer;
            try { await Promise.race([refresh, new Promise((resolve) => { timer = setTimeout(resolve, 8000); })]); }
            finally { clearTimeout(timer); }
          } else await refresh;
          return json(200, tracker.getBuses());
        }
        return json(200, await tracker.getStops());
      }
      const endpoint = pathname.slice(4);
      if (PASSTHROUGH_ENDPOINTS.has(endpoint)) {
        method([POST_ENDPOINTS.has(endpoint) ? 'POST' : 'GET']);
        checkQuery(url, legacyQuery[endpoint] ?? []);
        for (const value of url.searchParams.values()) if (value.length > 160) throw badRequest('Query value is too long');
        let body;
        if (req.method === 'POST') {
          body = await readJson(req);
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('An object body is required');
          if (endpoint === '/GetCalls' && (typeof body.query?.fromStopAreaQuery !== 'string' || body.query.fromStopAreaQuery.length > 160)) throw badRequest('Invalid stop query');
          if (endpoint === '/FindStopArea' && (typeof body.StopAreaQuery !== 'string' || body.StopAreaQuery.length > 160)) throw badRequest('Invalid stop query');
          if (endpoint === '/GetStopAreas') {
            positiveId(String(body.lineId));
            if (body.directionId !== null && body.directionId !== undefined) positiveId(String(body.directionId));
          }
          if (endpoint === '/FindStopsNearLocation') {
            try { validate('coordinate', body.coordinate); } catch { throw badRequest('Invalid coordinates'); }
          }
        } else {
          for (const key of legacyQuery[endpoint] ?? []) {
            if (['lineId', 'routeId'].includes(key)) positiveId(url.searchParams.get(key));
            if (['callId', 'query'].includes(key)) textParameter(url, key);
            if (key === 'clientTimestamp' && !Number.isFinite(Date.parse(url.searchParams.get(key)))) throw badRequest('Invalid client timestamp');
          }
        }
        telemetry.count('legacyRequests');
        const upstream = await passthrough(endpoint, { method: req.method, search: url.search, body: body ? JSON.stringify(body) : undefined });
        res.writeHead(upstream.status, { 'Content-Type': upstream.contentType ?? 'application/json', 'Cache-Control': 'no-cache', 'X-Cache': upstream.cache });
        return res.end(upstream.body);
      }
      throw new AppError('NOT_FOUND', 'Unknown endpoint', { status: 404 });
    } catch (error) {
      telemetry.log('request_failed', { requestId, route, code: error.code ?? error.name });
      if (res.headersSent) { res.destroy(); return; }
      const known = error instanceof AppError;
      if (known && error.retryAfter !== undefined) res.setHeader('Retry-After', String(error.retryAfter));
      const message = known ? error.message : 'Internal server error';
      const legacy = !req.url.startsWith('/api/v1') && !['/api/live', '/api/ready', '/api/status'].includes(route);
      json(known ? error.status : 500, legacy ? { error: message }
        : { error: { code: known ? error.code : 'INTERNAL_ERROR', message, requestId } });
    }
  });
  server.timeout = 30000;
  return {
    server, tracker, catalog, api, collector,
    shutdown() {
      draining = true;
      collector.close();
      streamHub.closeAll();
      tracker.close();
      catalog.close();
      api.close();
    },
  };
}
