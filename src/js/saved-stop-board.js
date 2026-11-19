import { store } from './appState.js';
import { formatTime, now, subscribeClock } from './clock.js';
import { displayStopText, getFavoriteStops, subscribeFavoriteStops } from './commuter.js';
import { effectiveDepartureTime } from './departure-history.js';
import { departureEstimateLabel, lateMinutes } from './departure-presentation.js';
import { departureReadReadyAt, departureReadState, getDepartureRead, readDepartures, subscribeDepartureReads } from './departure-reads.js';
import { subscribeDepartureRevisions } from './poller.js';
import { selectStopArea } from './stops.js';
import { subscribeLocale, t } from './i18n.js';
import { colorForLineId, textColorForLineId } from './lineColors.js';

const COLLAPSE_KEY = 'kiruna-bus-tracker.savedStopBoardCollapsed.v1';
const MAX_CONCURRENT = 3;
const MAX_RETRIES = 2;

const normalize = (text) => text.trim().normalize('NFC').toLocaleLowerCase('sv-SE');

export function resolveSavedStops(favorites, catalog) {
  const byName = new Map();
  const byText = new Map();
  const index = (map, key, stop) => map.set(key, map.has(key) ? null : stop);
  for (const [id, stop] of catalog) {
    const area = { ...stop, id };
    index(byText, normalize(stop.text), area);
    index(byName, normalize(displayStopText(stop.text)), area);
  }
  const seen = new Set();
  const result = [];
  for (const text of favorites) {
    const suffix = /\((\d+)\)\s*$/.exec(text);
    const name = normalize(displayStopText(text));
    const id = Number(suffix?.[1]);
    const catalogStop = suffix && catalog.get(id);
    // Boreal's display suffix isn't necessarily the numeric API ID.
    const exact = normalize(text);
    let stop = byName.get(name);
    if (suffix) {
      stop = byText.has(exact) ? byText.get(exact)
        : catalogStop && normalize(displayStopText(catalogStop.text)) === name ? { ...catalogStop, id } : null;
    }
    if (stop && seen.has(stop.id)) continue;
    if (stop) seen.add(stop.id);
    result.push({ text, stop: stop ?? null });
  }
  return result;
}

export function upcomingSavedDepartures(calls, activeLineIds, timestamp) {
  const future = [];
  for (const call of calls) {
    const time = effectiveDepartureTime(call);
    if (!Number.isFinite(time) || time <= timestamp) continue;
    future.push({ call, time });
  }
  return {
    hasFuture: future.length > 0,
    rows: future.filter(({ call }) => activeLineIds.has(call.lineId)).sort((a, b) => a.time - b.time).slice(0, 2),
  };
}

function makeElement(tag, className) {
  const element = document.createElement(tag);
  element.className = className;
  return element;
}

function setText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

export function initSavedStopBoard() {
  const traffic = document.getElementById('traffic-info');
  if (!traffic || document.getElementById('saved-stop-board')) return;
  const section = makeElement('section', 'saved-stop-board');
  section.id = 'saved-stop-board';
  section.setAttribute('aria-labelledby', 'saved-stop-board-heading');
  const heading = document.createElement('h2');
  heading.id = 'saved-stop-board-heading';
  const toggle = makeElement('button', 'saved-stop-board-toggle');
  toggle.type = 'button';
  const list = makeElement('ul', 'saved-stop-board-stops');
  list.id = 'saved-stop-board-stops';
  toggle.setAttribute('aria-controls', list.id);
  heading.append(toggle);
  section.append(heading, list);
  traffic.after(section);

  let collapsed = false;
  try { collapsed = localStorage.getItem(COLLAPSE_KEY) === 'true'; } catch { /* preference is optional */ }
  let cards = new Map();
  let catalog;
  let renderTimer;
  let readTimer;
  let pumpScheduled = false;
  const queue = new Set();
  const requests = new Map();
  let ids = new Set();
  const enabled = () => !collapsed && !document.hidden && cards.size > 0;

  function render() {
    clearTimeout(renderTimer);
    setText(toggle, t('savedStopDepartures'));
    section.hidden = cards.size === 0;
    list.hidden = collapsed;
    toggle.setAttribute('aria-expanded', String(!collapsed));
    if (!enabled()) return;

    const departureNow = now();
    const elapsed = performance.now();
    const { activeLineIds, selectedStop } = store.get();
    let updateIn = Infinity;
    for (const { stop, name, status, rows } of cards.values()) {
      const read = getDepartureRead(stop?.id);
      const response = read?.response;
      const readState = departureReadState(read, elapsed);
      const retained = readState === 'stale';
      let note;
      let departures = [];
      if (!stop) note = t('savedStopUnresolved');
      else if (readState === 'loading') note = t('checkingDepartures');
      else if (readState === 'unavailable') note = t('departuresUnavailable');
      else {
        const age = retained ? t('departuresNotLive', formatTime(response.updatedAt)) : '';
        updateIn = Math.min(updateIn, read.expiresAt - elapsed, retained ? Infinity : read.freshUntil - elapsed);
        const { hasFuture, rows: next } = upcomingSavedDepartures(response.calls, activeLineIds, departureNow);
        const state = response.isStopCancelled ? 'stopCancelled'
          : next.length ? null : hasFuture ? 'savedDeparturesFiltered' : 'noUpcomingDepartures';
        note = [age, state && t(state)].filter(Boolean).join(' ');
        if (!response.isStopCancelled) departures = next;
      }

      if (stop) name.setAttribute('aria-current', String(selectedStop?.id === stop.id));
      status.classList.toggle('status-stale', retained);
      setText(status, note);
      rows.hidden = !departures.length;
      while (rows.children.length > departures.length) rows.lastElementChild.remove();
      for (const [index, { call, time }] of departures.entries()) {
        if (!rows.children[index]) {
          const row = makeElement('li', 'saved-stop-board-departure');
          const main = makeElement('div', 'departure-main');
          const timing = makeElement('span', 'departure-time');
          timing.append(makeElement('span', 'visually-hidden'), document.createElement('time'), makeElement('span', 'eta-delay'));
          main.append(makeElement('span', 'line-badge'), makeElement('strong', 'departure-destination'), timing);
          row.append(main);
          rows.append(row);
        }
        const [line, destination, timing] = rows.children[index].firstElementChild.children;
        const [source, absolute, delay] = timing.children;
        const times = call.departure ?? call.arrival;
        const minutesLate = lateMinutes(times?.plannedTime, times?.forecastTime);
        const estimate = t(departureEstimateLabel(call, retained));
        line.style.backgroundColor = colorForLineId(call.lineId);
        line.style.color = textColorForLineId(call.lineId);
        setText(line, call.line);
        setText(destination, call.destination);
        timing.title = estimate;
        setText(source, `${estimate}: `);
        absolute.dateTime = new Date(time).toISOString();
        setText(absolute, formatTime(absolute.dateTime));
        delay.hidden = !minutesLate;
        setText(delay, minutesLate ? `(+${minutesLate} min)` : '');
        updateIn = Math.min(updateIn, time - departureNow);
      }
    }
    if (Number.isFinite(updateIn)) renderTimer = setTimeout(render, Math.max(1, Math.ceil(updateIn)));
  }

  function schedulePump() {
    if (pumpScheduled) return;
    pumpScheduled = true;
    queueMicrotask(() => { pumpScheduled = false; pump(); });
  }

  function pump() {
    clearTimeout(readTimer);
    if (!enabled()) return;
    let earliest = Infinity;
    for (const id of queue) {
      if (requests.size >= MAX_CONCURRENT) break;
      if (requests.has(id)) continue;
      const readyAt = departureReadReadyAt(id);
      if (readyAt > performance.now()) {
        earliest = Math.min(earliest, readyAt);
        continue;
      }
      queue.delete(id);
      const controller = new AbortController();
      requests.set(id, controller);
      void readDepartures(id, { passive: true, signal: controller.signal }).catch((error) => {
        if (!controller.signal.aborted && getDepartureRead(id)?.failures <= MAX_RETRIES &&
          (error.status == null || error.status === 429 || error.status >= 500)) queue.add(id);
      }).finally(() => {
        requests.delete(id);
        if (controller.signal.aborted && enabled() && ids.has(id)) refresh();
        schedulePump();
      });
    }
    if (Number.isFinite(earliest)) readTimer = setTimeout(schedulePump,
      Math.min(2147483647, Math.max(1, Math.ceil(earliest - performance.now()))));
  }

  function refresh() {
    if (!enabled()) return;
    for (const id of ids) {
      if (requests.has(id)) continue;
      const read = getDepartureRead(id);
      if (departureReadReadyAt(id) <= performance.now() || !read?.response) queue.add(id);
    }
    schedulePump();
  }

  function syncCards() {
    catalog = store.get().stopLocations;
    const next = new Map();
    for (const { text, stop } of resolveSavedStops(getFavoriteStops(), catalog)) {
      const old = cards.get(text);
      if (old && old.stop?.id === stop?.id) {
        old.stop = stop;
        next.set(text, old);
        continue;
      }
      const card = makeElement('li', 'saved-stop-board-card');
      const title = document.createElement('h3');
      const name = stop ? makeElement('button', 'saved-stop-board-stop') : document.createElement('span');
      if (stop) {
        name.type = 'button';
        name.addEventListener('click', () => {
          selectStopArea(cards.get(text).stop);
          document.getElementById('arrivals-stop-name')?.focus({ preventScroll: true });
          document.getElementById('arrivals')?.scrollIntoView({ block: 'start' });
        });
      }
      title.append(name);
      setText(name, displayStopText(text));
      const status = makeElement('p', 'hint saved-stop-board-status');
      status.setAttribute('role', 'status');
      const rows = makeElement('ol', 'saved-stop-board-departures');
      card.append(title, status, rows);
      next.set(text, { card, name, stop, status, rows });
    }
    const order = [...next.values()].map(({ card }) => card);
    if (order.length !== list.children.length || order.some((card, i) => card !== list.children[i])) {
      list.replaceChildren(...order);
    }
    cards = next;
    ids = new Set([...cards.values()].filter(({ stop }) => stop).map(({ stop }) => stop.id));
    for (const id of queue) if (!ids.has(id)) queue.delete(id);
    for (const [id, controller] of requests) if (!ids.has(id)) controller.abort();
    render();
    refresh();
  }

  function visibilityChanged() {
    if (!enabled()) {
      clearTimeout(readTimer);
      queue.clear();
      for (const controller of requests.values()) controller.abort();
    }
    render();
    refresh();
  }

  toggle.addEventListener('click', () => {
    collapsed = !collapsed;
    try { localStorage.setItem(COLLAPSE_KEY, String(collapsed)); } catch { /* keep the in-memory preference */ }
    visibilityChanged();
  });
  document.addEventListener('visibilitychange', visibilityChanged);
  subscribeFavoriteStops(syncCards);
  subscribeDepartureReads((id) => { if (ids.has(id)) render(); });
  subscribeDepartureRevisions(refresh);
  subscribeClock(() => { if (enabled()) render(); });
  subscribeLocale(render);
  store.subscribe((state, previous) => {
    if (state.stopLocations !== catalog) syncCards();
    else if (state.activeLineIds !== previous.activeLineIds || state.selectedStop !== previous.selectedStop ||
      state.lines !== previous.lines) render();
  });
  syncCards();
}
