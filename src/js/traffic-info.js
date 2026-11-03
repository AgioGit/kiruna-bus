import { api } from './api.js';
import { store } from './appState.js';
import { failureDelay } from './poller.js';

const MAX_AGE_MS = 600000;
const INTERVAL_MS = 60000;
const labels = {
  cancelled: 'Cancelled', no_realtime: 'No real-time information', delayed: 'Delayed',
  route_changed: 'Route changed', back_in_service: 'Back in service',
};

export function formatTrafficDate(value) {
  if (!/^\d{4}-\d\d-\d\d$/.test(value ?? '')) return value ?? '';
  const date = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return value;
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Stockholm', day: 'numeric', month: 'short', year: 'numeric' }).format(date);
}

export function trafficSummary(data) {
  if (!data || data.state === 'unavailable') return 'Traffic information unavailable';
  const count = data.trips.length + data.messages.length;
  if (data.state === 'retained') return `${count} traffic ${count === 1 ? 'notice' : 'notices'} (refresh failed)`;
  return count ? `${count} traffic ${count === 1 ? 'notice' : 'notices'}` : 'No known disruptions';
}

function validResponse(data) {
  return data && ['fresh', 'retained', 'unavailable'].includes(data.state) &&
    Array.isArray(data.trips) && Array.isArray(data.messages) &&
    (data.ageSec === null || (Number.isFinite(data.ageSec) && data.ageSec >= 0)) &&
    (data.state === 'unavailable' || data.ageSec !== null) &&
    data.trips.every((trip) => trip && Object.hasOwn(labels, trip.type)) &&
    data.messages.every((item) => item && typeof item.text === 'string' && ['info', 'warning'].includes(item.level));
}

export function renderTrafficInfo(data, doc = document) {
  const content = doc.getElementById('traffic-info-content');
  const panel = doc.getElementById('traffic-info');
  if (!content || !panel) return;
  const add = (parent, tag, text, className) => {
    const node = doc.createElement(tag);
    node.textContent = text;
    if (className) node.className = className;
    parent.append(node);
    return node;
  };
  content.replaceChildren();
  panel.classList.toggle('has-traffic-notices', Boolean(data && (data.trips.length || data.messages.length)));
  add(content, 'p', trafficSummary(data), data?.state === 'unavailable' || data?.state === 'retained' ? 'traffic-info-warning' : '');
  if (data?.state === 'retained') add(content, 'p', 'Refresh failed; showing the last available notices until they expire.', 'traffic-info-warning');
  if (data?.state === 'unavailable') add(content, 'p', 'Information is unavailable or too old. This does not mean there are no disruptions.', 'traffic-info-warning');
  if (data && (data.trips.length || data.messages.length)) {
    const list = add(content, 'ul', '');
    for (const trip of data.trips) {
      const delayedReturn = trip.type === 'back_in_service' && trip.delayMinutes > 0 && trip.delayMinutes < 1000;
      const title = delayedReturn ? 'Delayed (back in service)' : labels[trip.type];
      const details = [trip.line && `Line ${trip.line}`, trip.destination && `towards ${trip.destination}`,
        formatTrafficDate(trip.date), trip.time, trip.delayMinutes > 0 && trip.delayMinutes < 1000 && `${trip.delayMinutes} min delay${delayedReturn ? ' at departure' : ''}`,
        trip.trip && `Trip ${trip.trip}`, trip.updated && `Updated ${trip.updated}`].filter(Boolean);
      add(list, 'li', [title, details.join(' · ')].filter(Boolean).join(': '));
    }
    for (const item of data.messages) add(list, 'li', `${item.level === 'warning' ? 'Warning' : 'Information'}: ${item.text}`);
  }
  if (data?.updated) add(content, 'p', `Provider update: ${data.updated}`, 'traffic-info-meta');
}

// This lifecycle is intentionally independent of catalog, SSE and the bus poller.
export function createTrafficPoller({ get = api.getTrafficInfo, publish = (data) => store.set({ trafficInfo: data }),
  now = Date.now, monotonic = () => performance.now(), random = Math.random } = {}) {
  let data = null, baseWall = 0, baseMono = 0, maxElapsed = 0, timer = null, expiry = null, controller = null;
  let generation = 0, paused = true, failures = 0, retryAt = 0;
  const elapsed = () => (maxElapsed = Math.max(maxElapsed, now() - baseWall, monotonic() - baseMono));
  function current() {
    if (!data) return null;
    const ageSec = data.ageSec === null ? null : data.ageSec + elapsed() / 1000;
    if (ageSec === null || ageSec > 600) return { ...data, state: 'unavailable', ageSec, trips: [], messages: [] };
    return { ...data, ageSec };
  }
  function show() {
    clearTimeout(expiry);
    const value = current();
    publish(value);
    if (!paused && value && value.state !== 'unavailable' && value.ageSec !== null) {
      expiry = setTimeout(show, Math.max(1, MAX_AGE_MS - value.ageSec * 1000 + 1));
    }
  }
  function schedule(ms) {
    clearTimeout(timer);
    if (!paused) timer = setTimeout(tick, Math.min(2147483647, Math.max(0, ms)));
  }
  async function tick() {
    if (paused || controller) return;
    if (now() < retryAt) { schedule(retryAt - now()); return; }
    const seq = generation;
    const startedWall = now(), startedMono = monotonic();
    controller = new AbortController();
    try {
      const result = await get({ signal: controller.signal });
      if (seq !== generation) return;
      if (!validResponse(result)) throw new Error('Invalid traffic information response');
      data = result;
      baseWall = startedWall; baseMono = startedMono; maxElapsed = 0;
      failures = result.error ? failures + 1 : 0;
      const wait = result.error ? Math.max(INTERVAL_MS, result.retryAfterMs ?? 0, failureDelay(failures, result.retryAfterMs, random)) : INTERVAL_MS;
      retryAt = now() + wait;
      show();
      schedule(wait);
    } catch (error) {
      if (seq !== generation) return;
      const existing = current();
      if (existing) {
        data = { ...existing, state: existing.state !== 'unavailable' && (existing.trips.length || existing.messages.length) ? 'retained' : 'unavailable' };
        baseWall = now(); baseMono = monotonic(); maxElapsed = 0;
      } else {
        data = { state: 'unavailable', trips: [], messages: [], source: 'Lokaltrafiken Kiruna', updated: null, ageSec: null };
      }
      const wait = Math.max(INTERVAL_MS, error.retryAfter ?? 0, failureDelay(++failures, error.retryAfter, random));
      retryAt = now() + wait;
      show();
      schedule(wait);
    } finally {
      if (seq === generation) controller = null;
    }
  }
  return {
    pause() { paused = true; generation++; controller?.abort(); controller = null; clearTimeout(timer); clearTimeout(expiry); },
    resume() { if (!paused) return; paused = false; show(); retryAt = failures ? retryAt : 0; void tick(); },
  };
}

export function initTrafficInfo() {
  renderTrafficInfo(store.get().trafficInfo);
  store.subscribe((state, previous) => { if (state.trafficInfo !== previous.trafficInfo) renderTrafficInfo(state.trafficInfo); });
  const poller = createTrafficPoller();
  if (!document.hidden) poller.resume();
  document.addEventListener('visibilitychange', () => document.hidden ? poller.pause() : poller.resume());
}
