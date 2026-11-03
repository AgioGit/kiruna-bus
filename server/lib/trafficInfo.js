import { validate } from './validation.js';

const TYPES = { installd: 'cancelled', ingen_realtid: 'no_realtime', forsenad: 'delayed', andrad_rutt: 'route_changed', aater: 'back_in_service' };
const INTERVAL = 60000;
const MAX_AGE = 600;
const MAX_BYTES = 256 * 1024;
const message = 'Traffic information could not be refreshed.';

export function normalizeTraffic(data) {
  validate('trafficUpstream', data, { upstream: true });
  if (!Number.isFinite(data.ageSec)) throw new Error('Invalid source age');
  const optional = (value) => value == null || value === '' ? null : String(value);
  return {
    trips: data.turer.map((item) => {
      const delay = item.min == null ? NaN : Number.parseInt(String(item.min), 10);
      return {
        type: TYPES[item.typ], trip: optional(item.tur), line: optional(item.linje),
        destination: optional(item.mot), date: optional(item.datum), time: optional(item.tid),
        delayMinutes: Number.isSafeInteger(delay) ? delay : null, updated: optional(item.uppdaterad),
      };
    }),
    messages: data.meddelanden.map((item) => ({ text: item.text, level: item.niva === 'varning' ? 'warning' : 'info' })),
    updated: optional(data.uppdaterad), ageSec: data.ageSec,
  };
}

export function createTrafficInfo({ origin = 'https://lokaltrafikenkiruna.se', fetcher = fetch, now = Date.now,
  monotonic = now === Date.now ? () => performance.now() : now, telemetry, timeoutMs = 10000 } = {}) {
  let lastGood = null, nextAttempt = 0, failures = 0, failed = false, inFlight = null, controller = null, closed = false;

  async function refresh() {
    const started = now(), startedMono = monotonic();
    nextAttempt = startedMono + INTERVAL;
    controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(`${origin}/wp-json/boreal/v1/trafikinfo`, { signal: controller.signal, cache: 'no-store', redirect: 'error' });
      if (!response.ok) {
        const value = response.headers.get('retry-after');
        const seconds = /^\d+$/.test(value ?? '') ? Number(value) : (Date.parse(value) - now()) / 1000;
        if (Number.isFinite(seconds)) nextAttempt = Math.max(nextAttempt, Math.min(Number.MAX_SAFE_INTEGER, monotonic() + Math.max(0, seconds) * 1000));
        await response.body?.cancel();
        throw new Error('Upstream HTTP failure');
      }
      const length = Number(response.headers.get('content-length'));
      if (length > MAX_BYTES) { controller.abort(); throw new Error('Response too large'); }
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > MAX_BYTES) { controller.abort(); throw new Error('Response too large'); }
        chunks.push(chunk);
      }
      const data = normalizeTraffic(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (closed) return;
      // Include the complete request duration rather than making data younger in transit.
      lastGood = { ...data, at: started, atMono: startedMono, elapsed: 0 };
      failed = false;
      failures = 0;
    } catch {
      if (closed) return;
      failed = true;
      failures++;
      nextAttempt = Math.max(nextAttempt, monotonic() + Math.min(300000, INTERVAL * 2 ** Math.min(failures - 1, 3)));
      telemetry?.count('trafficInfoFailures');
      telemetry?.log('traffic_info_refresh_failed', { code: 'TRAFFIC_INFO_UNAVAILABLE' });
    } finally {
      clearTimeout(timer);
      controller = null;
    }
  }

  function snapshot() {
    const time = now();
    if (lastGood) lastGood.elapsed = Math.max(lastGood.elapsed, time - lastGood.at, monotonic() - lastGood.atMono);
    const ageSec = lastGood ? lastGood.ageSec + lastGood.elapsed / 1000 : null;
    const valid = ageSec !== null && ageSec <= MAX_AGE;
    const populated = lastGood && (lastGood.trips.length || lastGood.messages.length);
    const state = valid && !failed ? 'fresh' : valid && failed && populated ? 'retained' : 'unavailable';
    const error = state === 'fresh' ? null : { code: failed ? 'REFRESH_FAILED' : 'SOURCE_UNAVAILABLE', message };
    return {
      state, trips: state === 'unavailable' ? [] : lastGood.trips,
      messages: state === 'unavailable' ? [] : lastGood.messages,
      source: 'Lokaltrafiken Kiruna', updated: lastGood?.updated ?? null, ageSec,
      error, serverTime: new Date(time).toISOString(),
    };
  }

  return {
    async get() {
      if (!closed && monotonic() >= nextAttempt && !inFlight) {
        inFlight = refresh().finally(() => { inFlight = null; });
      }
      if (inFlight) await inFlight;
      return { data: snapshot(), retryAfter: failed ? Math.max(1, Math.ceil((nextAttempt - monotonic()) / 1000)) : undefined };
    },
    close() { closed = true; controller?.abort(); },
  };
}
