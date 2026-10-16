import { store } from './appState.js';
import { toggleLine } from './filters.js';
import { searchStops, selectStopByText, clearSelectedStop, cancelStopSearch } from './stops.js';
import { formatTime, minutesUntil } from './clock.js';
import { colorForLineId, lineColorOrderForId, textColorForLineId } from './lineColors.js';
import { selectVehicle } from './vehicleSelection.js';
import { MAX_POSITION_AGE_MS } from './live-vehicles.js';
import { showNotice } from './notices.js';

const TRIP_PREVIEW_STOPS = 3;
const TRANSIENT_ERRORS = new Set(['stopNotFound', 'cache']);
const statusElements = new WeakMap();

export function initUi() {
  wireInformationToggle();
  wireSearch();
  wireVehicleCardClicks();
  store.subscribe((state, prev) => {
    if (state.lines !== prev.lines || state.activeLineIds !== prev.activeLineIds) renderLineFilters(state);
    renderStopSearchInput(state);
    if (state.liveVehicles !== prev.liveVehicles || state.activeLineIds !== prev.activeLineIds ||
        state.selectedVehicleJourneyId !== prev.selectedVehicleJourneyId ||
        state.journeyStops !== prev.journeyStops || state.lines !== prev.lines ||
        state.liveQuality !== prev.liveQuality || state.errors.vehicles !== prev.errors.vehicles) {
      renderVehicleCards(state);
    }
    if (state.calls !== prev.calls || state.selectedStop !== prev.selectedStop ||
        state.isStopCancelled !== prev.isStopCancelled || state.isCallsLoading !== prev.isCallsLoading ||
        state.messages !== prev.messages || state.errors.calls !== prev.errors.calls ||
        state.activeLineIds !== prev.activeLineIds || state.clockOffsetMs !== prev.clockOffsetMs) {
      renderArrivals(state);
    }
    if (state.errors !== prev.errors || state.catalogInfo !== prev.catalogInfo || state.liveQuality !== prev.liveQuality) renderStatus(state);
  });
  renderLineFilters(store.get());
  renderStopSearchInput(store.get());
  renderVehicleCards(store.get());
  renderArrivals(store.get());
  renderStatus(store.get());
}

function wireInformationToggle() {
  const button = document.getElementById('information-toggle');
  const panel = document.getElementById('app-information');
  if (!button || !panel) return;

  const setOpen = (open) => {
    panel.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
  };
  button.addEventListener('click', () => setOpen(panel.hidden));
  button.closest('.app-header').addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || panel.hidden) return;
    event.preventDefault();
    setOpen(false);
    button.focus({ preventScroll: true });
  });
}

// Keeps the search box showing whichever stop is currently selected, so a
// stop picked on the map (circle click or nearest-stop map click) names
// itself in the same place a typed search would.
//
// Keyed on state.stopSelectionSeq (bumped by every selectStopArea /
// clearSelectedStop call) rather than on selectedStop.id: re-selecting the
// stop that is already selected must still restate it in the box, since
// the user may have typed over the value in the meantime. Unrelated
// re-renders (15s poll ticks, filter toggles) leave the seq untouched, so
// in-progress typing is never clobbered.
let lastSyncedSelectionSeq = 0;

function renderStopSearchInput(state) {
  const seq = state.stopSelectionSeq ?? 0;
  if (seq === lastSyncedSelectionSeq) return;
  lastSyncedSelectionSeq = seq;

  const input = document.getElementById('stop-search');
  const results = document.getElementById('stop-search-results');
  if (!input) return;

  input.value = state.selectedStop?.text ?? '';
  // A debounced search started just before the map click would otherwise
  // land afterwards and repopulate the suggestion list under the new value.
  cancelStopSearch();
  if (results) {
    results.innerHTML = '';
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }
}

function wireVehicleCardClicks() {
  const container = document.getElementById('live-buses');
  if (!container) return;

  container.addEventListener('click', (e) => {
    const button = e.target.closest('button[data-journey-id]');
    if (button && container.contains(button)) selectVehicle(Number(button.dataset.journeyId));
  });

  const setHovered = (journeyId) => {
    if (store.get().hoveredVehicleJourneyId !== journeyId) store.set({ hoveredVehicleJourneyId: journeyId });
  };
  const journeyIdOf = (target) => {
    const button = target.closest?.('button[data-journey-id]');
    return button && container.contains(button) ? Number(button.dataset.journeyId) : null;
  };
  // Touch taps fire pointerover but never a matching leave, which would leave
  // the highlight stuck, so only mouse/pen hover counts.
  container.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'touch') setHovered(journeyIdOf(e.target));
  });
  container.addEventListener('pointerleave', () => setHovered(null));
  container.addEventListener('focusin', (e) => setHovered(journeyIdOf(e.target)));
  container.addEventListener('focusout', () => setHovered(null));
}

function renderVehicleCards(state) {
  const container = document.getElementById('live-buses');
  if (!container) return;
  const focusedJourney = container.contains(document.activeElement)
    ? document.activeElement.closest('button[data-journey-id]')?.dataset.journeyId
    : null;
  const focusedTripJourney = container.contains(document.activeElement)
    ? document.activeElement.closest('.trip-more')?.dataset.journeyId
    : null;
  const expandedTripJourney = container.querySelector('.trip-more[open]')?.dataset.journeyId;

  const visibleVehicles = state.liveVehicles.filter(
    (bus) =>
      (bus.lineId === undefined || state.activeLineIds.has(bus.lineId)) &&
      (bus.ageMs == null || Number.isNaN(bus.ageMs) || bus.ageMs <= MAX_POSITION_AGE_MS)
  ).sort((a, b) => {
    const byColor = lineColorOrderForId(a.lineId) - lineColorOrderForId(b.lineId);
    if (byColor) return byColor;
    if (a.lineId !== b.lineId) return (a.lineId ?? Infinity) - (b.lineId ?? Infinity);
    if (a.journeyId !== b.journeyId) return (a.journeyId ?? Infinity) - (b.journeyId ?? Infinity);
    return (a.callIds?.[0] ?? a.destination ?? '').localeCompare(b.callIds?.[0] ?? b.destination ?? '');
  });

  if (!visibleVehicles.length) {
    const unknown = state.errors.vehicles || state.liveQuality?.state === 'unavailable' || !state.liveQuality;
    const message = unknown ? 'Live tracking is warming up or unavailable. This does not mean no buses are running. You can still explore stops and routes.'
      : state.liveQuality.state !== 'fresh' ? 'No fresh positions are available. Live tracking is degraded; buses may still be running.'
      : 'No buses are reporting right now. You can still check departures at a stop.';
    container.innerHTML = `<h2>Live buses</h2><p class="hint">${message}</p>`;
    if (focusedJourney) {
      container.tabIndex = -1;
      container.focus({ preventScroll: true });
    }
    return;
  }

  const staleCount = visibleVehicles.filter((b) => b.stale).length;
  const subtitle = staleCount
    ? `<p class="hint">${staleCount} ${staleCount === 1 ? 'bus has' : 'buses have'} an older position; check the updated time.</p>`
    : '';

  const parts = [
    `<h2>Live buses (${visibleVehicles.length})</h2>`,
    subtitle,
    state.selectedVehicleJourneyId != null &&
    !state.liveVehicles.some((bus) => bus.journeyId === state.selectedVehicleJourneyId)
      ? '<p class="hint">The selected bus is no longer reporting a position.</p>' : '',
    '<ul class="vehicle-list">',
  ];
  const expandedJourneys = new Set();
  for (const bus of visibleVehicles) {
    const lineText = bus.line ? bus.line.replace(/\.$/, '') : bus.lineId !== undefined ? lineTextFor(state, bus.lineId) : '—';
    const color = bus.lineId !== undefined ? colorForLineId(bus.lineId) : '#888888';
    const foreground = bus.lineId !== undefined ? textColorForLineId(bus.lineId) : '#ffffff';
    const destination = bus.destination ?? '—';
    const status = bus.stale
      ? `<span class="status-stale">Position ${formatAge(bus.ageMs)} old</span>`
      : '<span class="status-live">Live position</span>';
    const nextStopText = stripStopId(bus.nextStop?.stopText) ?? '—';
    const planned = formatTime(bus.nextStop?.plannedTime);
    const expected = formatTime(bus.nextStop?.forecastTime);
    const selected = bus.journeyId === state.selectedVehicleJourneyId;
    const expanded = selected && !expandedJourneys.has(bus.journeyId);
    if (expanded) expandedJourneys.add(bus.journeyId);
    const tag = bus.journeyId == null ? 'div' : 'button';
    const attributes = bus.journeyId == null
      ? ''
      : ` type="button" data-journey-id="${bus.journeyId}" aria-expanded="${expanded}"${expanded ? ` aria-controls="trip-${bus.journeyId}"` : ''}`;
    parts.push(`<li><${tag} class="vehicle-card${selected ? ' vehicle-card--selected' : ''}${expanded ? ' vehicle-card--expanded' : ''}${bus.stale ? ' vehicle-card--stale' : ''}"${attributes}>
      <span class="vehicle-card-main"><span class="line-badge" style="background:${color};color:${foreground}">${escapeHtml(lineText)}</span>
        <strong class="vehicle-destination">${escapeHtml(destination)}</strong>
        <span class="vehicle-time"><span class="vehicle-time-label">ETA</span>${expected}${lateEta(bus.nextStop?.plannedTime, bus.nextStop?.forecastTime)}</span></span>
      <span class="vehicle-card-next">Next: ${escapeHtml(nextStopText)}${planned !== '—' && planned !== expected ? ` <span class="hint">(planned ${planned})</span>` : ''}</span>
      <span class="vehicle-card-meta"><span>Updated ${formatTime(bus.position.timestamp)}</span>${status}</span>
    </${tag}>${expanded ? renderTripDetails(state, bus) : ''}</li>`);
  }
  parts.push('</ul>');
  container.innerHTML = parts.join('');
  const expandedTrip = container.querySelector('.trip-more');
  if (expandedTrip && expandedTrip.dataset.journeyId === expandedTripJourney) expandedTrip.open = true;
  if (expandedTrip && expandedTrip.dataset.journeyId === focusedTripJourney) {
    expandedTrip.querySelector('summary').focus({ preventScroll: true });
  }
  if (focusedJourney) {
    const button = [...container.querySelectorAll('button[data-journey-id]')]
      .find((item) => item.dataset.journeyId === focusedJourney);
    (button ?? container).focus({ preventScroll: true });
  }
}

function renderTripDetails(state, bus) {
  const stops = state.journeyStops.get(bus.journeyId) ?? [];
  const delays = stops.map((stop) => delayLabel(stop.plannedTime, stop.forecastTime));
  const commonDelay = delays.length && delays[0].endsWith('early') &&
    delays.every((delay) => delay === delays[0]) ? delays[0] : '';
  const parts = [
    `<div id="trip-${bus.journeyId}" class="vehicle-trip" aria-label="Upcoming stops">`,
    `<div class="trip-heading"><h3>Upcoming stops</h3>${commonDelay ? `<span class="trip-delay">${commonDelay}</span>` : ''}</div>`,
  ];
  if (!stops.length) {
    parts.push('<p class="hint">No upcoming stops are available for this trip.</p>');
  } else {
    const renderStop = (stop, delay) => {
      const planned = formatTime(stop.plannedTime);
      const expected = formatTime(stop.forecastTime ?? stop.plannedTime);
      const plannedLabel = planned !== '—' && planned !== expected ? `Planned ${planned}` : '';
      const late = lateEta(stop.plannedTime, stop.forecastTime);
      const change = late || (!commonDelay && delay ? `<span class="trip-stop-change">${delay}</span>` : '');
      return `<li class="trip-stop"${plannedLabel ? ` title="${escapeHtml(plannedLabel)}"` : ''}>
        <span class="trip-stop-name">${escapeHtml(stripStopId(stop.stopText))}</span>
        <span class="trip-stop-time">${expected}${change}</span>
        ${plannedLabel ? `<span class="visually-hidden">${plannedLabel}</span>` : ''}</li>`;
    };
    parts.push('<ol class="trip-stops">');
    for (let i = 0; i < Math.min(stops.length, TRIP_PREVIEW_STOPS); i++) {
      parts.push(renderStop(stops[i], delays[i]));
    }
    parts.push('</ol>');
    if (stops.length > TRIP_PREVIEW_STOPS) {
      const remaining = stops.length - TRIP_PREVIEW_STOPS;
      parts.push(`<details class="trip-more" data-journey-id="${bus.journeyId}"><summary>
        <span class="trip-more-closed">Show ${remaining} more ${remaining === 1 ? 'stop' : 'stops'}</span>
        <span class="trip-more-open">Hide remaining stops</span>
      </summary><ol class="trip-stops" start="${TRIP_PREVIEW_STOPS + 1}">`);
      for (let i = TRIP_PREVIEW_STOPS; i < stops.length; i++) {
        parts.push(renderStop(stops[i], delays[i]));
      }
      parts.push('</ol></details>');
    }
  }
  parts.push('</div>');
  return parts.join('');
}

// Stop.text from the transit API is formatted like "Stadshustorget (84064)"
// (see docs/API.md, FindStopArea/Autocomplete) - the trailing "(id)" is
// meant for round-tripping the id back into a query, not for display.
function stripStopId(stopText) {
  if (!stopText) return stopText;
  return stopText.replace(/\s*\(\d+\)\s*$/, '');
}

function formatAge(ageMs) {
  if (ageMs == null || Number.isNaN(ageMs)) return '?';
  const minutes = Math.round(ageMs / 60000);
  return minutes < 1 ? '<1 min' : `${minutes} min`;
}

function lineTextFor(state, lineId) {
  return state.lines.find((l) => l.id === lineId)?.text ?? `Line ${lineId}`;
}

function renderLineFilters(state) {
  const container = document.getElementById('line-filters');
  if (!container) return;
  const visible = state.lines.filter((line) => state.activeLineIds.has(line.id)).length;
  const summary = document.getElementById('lines-summary');
  if (summary) {
    summary.textContent = state.lines.length ? `${visible} of ${state.lines.length} shown` : 'Loading lines';
  }
  const buttonSummary = document.getElementById('lines-button-summary');
  if (buttonSummary) {
    buttonSummary.textContent = state.lines.length ? `${visible}/${state.lines.length}` : '';
    buttonSummary.parentElement.classList.toggle('map-tool-button--filtered', visible < state.lines.length);
  }

  const html = state.lines
    .map((line) => {
      const checked = state.activeLineIds.has(line.id) ? 'checked' : '';
      return `<label class="line-filter"><input type="checkbox" data-line-id="${line.id}" ${checked}> ${escapeHtml(line.text)}</label>`;
    })
    .join('');

  const focusedLineId = container.contains(document.activeElement)
    ? document.activeElement.dataset.lineId : null;
  // Avoid tearing down/rebuilding (and re-attaching listeners) on every poll
  // tick when the line list itself hasn't changed.
  if (container.dataset.rendered === html) return;
  container.dataset.rendered = html;
  container.innerHTML = html;
  container.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    input.addEventListener('change', () => toggleLine(Number(input.dataset.lineId)));
    if (input.dataset.lineId === focusedLineId) input.focus({ preventScroll: true });
  });
}

function wireSearch() {
  const input = document.getElementById('stop-search');
  const results = document.getElementById('stop-search-results');
  const clearBtn = document.getElementById('stop-clear');
  if (!input || !results) return;

  let activeIndex = -1;
  let searchRequestSeq = 0;

  const updateActiveOption = () => {
    const options = [...results.querySelectorAll('[role="option"]')];
    options.forEach((option, index) => option.setAttribute('aria-selected', String(index === activeIndex)));
    const active = options[activeIndex];
    if (active) {
      input.setAttribute('aria-activedescendant', active.id);
      active.scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  };

  const closeResults = () => {
    searchRequestSeq += 1;
    activeIndex = -1;
    results.innerHTML = '';
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  };

  const chooseResult = async (text) => {
    input.value = text;
    closeResults();
    await selectStopByText(text);
  };

  input.addEventListener('input', () => {
    activeIndex = -1;
    const mySearchSeq = ++searchRequestSeq;
    searchStops(input.value, (matches) => {
      if (mySearchSeq !== searchRequestSeq) return;
      results.innerHTML = matches
        .map((text, index) => `<li id="stop-option-${index}" role="option" aria-selected="false" data-text="${escapeHtml(text)}">${escapeHtml(text)}</li>`)
        .join('');
      input.setAttribute('aria-expanded', String(matches.length > 0));
      updateActiveOption();
    });
  });

  input.addEventListener('keydown', (e) => {
    const options = [...results.querySelectorAll('[role="option"]')];
    if (e.key === 'Escape') {
      closeResults();
      return;
    }
    if (!options.length || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter')) return;
    if (e.key === 'Enter') {
      if (activeIndex >= 0) {
        e.preventDefault();
        chooseResult(options[activeIndex].dataset.text);
      }
      return;
    }
    e.preventDefault();
    const step = e.key === 'ArrowDown' ? 1 : -1;
    activeIndex = activeIndex < 0 ? (step > 0 ? 0 : options.length - 1) : (activeIndex + step + options.length) % options.length;
    updateActiveOption();
  });

  results.addEventListener('click', (e) => {
    const option = e.target.closest('[role="option"][data-text]');
    if (option) chooseResult(option.dataset.text);
  });

  clearBtn?.addEventListener('click', () => {
    input.value = '';
    closeResults();
    clearSelectedStop();
    const stopFinder = document.getElementById('map-stops-panel');
    if (stopFinder?.hidden) document.getElementById('map-stops-toggle').focus({ preventScroll: true });
    else input.focus();
  });
}

function renderArrivals(state) {
  const container = document.getElementById('arrivals');
  const content = document.getElementById('arrivals-content');
  const stopName = document.getElementById('arrivals-stop-name');
  if (!container || !content || !stopName) return;

  container.hidden = !state.selectedStop;
  stopName.textContent = stripStopId(state.selectedStop?.text) ?? '';
  if (!state.selectedStop) {
    content.innerHTML = '';
    return;
  }

  const parts = [];

  if (state.isStopCancelled) {
    parts.push('<p class="banner banner-cancelled">All departures at this stop are cancelled.</p>');
  }

  // Split messages into ones targeting specific calls vs. line-level notices.
  const affectedByCallId = new Map();
  const lineLevelMessages = [];
  for (const message of state.messages) {
    if (message.affectedCalls?.length) {
      for (const callId of message.affectedCalls) {
        const list = affectedByCallId.get(callId) ?? [];
        list.push(message);
        affectedByCallId.set(callId, list);
      }
    } else {
      lineLevelMessages.push(message);
    }
  }
  for (const message of lineLevelMessages) {
    const kind = message.isDisturbance ? 'banner-disturbance' : 'banner-info';
    parts.push(`<p class="banner ${kind}">${escapeHtml(message.text)}</p>`);
  }

  const visibleCalls = state.calls
    .filter((call) => state.activeLineIds.has(call.lineId))
    .sort((a, b) => {
      const aTime = plannedCallTime(a);
      const bTime = plannedCallTime(b);
      return aTime === bTime ? 0 : aTime - bTime;
    });

  if (state.isCallsLoading && !visibleCalls.length) {
    parts.push('<p class="hint" role="status">Checking departures…</p>');
  } else if (!visibleCalls.length) {
    const message = state.errors.calls ? 'Departures could not be refreshed. Please try again soon.'
      : state.calls.length ? 'No departures match your line filters.' : 'No departures right now.';
    parts.push(`<p class="hint">${message}</p>`);
  } else {
    parts.push('<ul class="departure-list">');
    for (const call of visibleCalls) {
      const forecast = call.departure ?? call.arrival;
      const affected = affectedByCallId.get(call.id) ?? [];
      const minutes = forecast ? minutesUntil(forecast.forecastTime) : null;
      const countdown = minutes == null ? '' : minutes > 0 ? `In ${minutes} min`
        : minutes >= -1 ? 'Due now' : `${-minutes} min ago`;
      const expected = forecast ? formatTime(forecast.forecastTime) : '—';
      const planned = forecast ? formatTime(forecast.plannedTime) : '—';
      const delay = delayLabel(forecast?.plannedTime, forecast?.forecastTime);
      const bg = colorForLineId(call.lineId);
      const fg = textColorForLineId(call.lineId);
      const quality = forecast?.quality === 'realtime' ? 'Live estimate' : forecast?.quality;
      parts.push(`<li class="departure-card">
        <div class="departure-main"><span class="line-badge" style="background:${bg};color:${fg}">${escapeHtml(call.line)}</span>
          <strong class="departure-destination">${escapeHtml(call.destination)}</strong>
          <span class="departure-time"><span class="visually-hidden">Expected departure </span>${expected}${lateEta(forecast?.plannedTime, forecast?.forecastTime)}</span></div>
        <div class="departure-meta">${planned !== '—' ? `<span>Planned ${planned}</span>` : ''}
          ${countdown ? `<span>${countdown}</span>` : ''}
          ${delay.endsWith('early') ? `<span class="trip-delay">${delay}</span>` : ''}
          ${quality ? `<span>${escapeHtml(quality)}</span>` : ''}</div>`);
      if (affected.length) {
        parts.push(`<p class="departure-message">${affected.map((m) => escapeHtml(m.text)).join('; ')}</p>`);
      }
      parts.push('</li>');
    }
    parts.push('</ul>');
  }

  content.innerHTML = parts.join('');
}

function plannedCallTime(call) {
  const time = Date.parse((call.departure ?? call.arrival)?.plannedTime);
  return Number.isFinite(time) ? time : Infinity;
}

function delayLabel(plannedTime, forecastTime) {
  if (!plannedTime || !forecastTime) return '';
  const difference = Date.parse(forecastTime) - Date.parse(plannedTime);
  if (!Number.isFinite(difference)) return '';
  const minutes = Math.round(difference / 60000);
  return minutes > 0 ? `${minutes} min late` : minutes < 0 ? `${-minutes} min early` : '';
}

function lateEta(plannedTime, forecastTime) {
  if (!plannedTime || !forecastTime) return '';
  const difference = Date.parse(forecastTime) - Date.parse(plannedTime);
  if (!Number.isFinite(difference) || difference <= 0) return '';
  return `<span class="eta-delay">(+${Math.max(1, Math.round(difference / 60000))} min)</span>`;
}

function renderStatus(state) {
  const container = document.getElementById('status-banner');
  if (!container) return;
  const messages = [];
  if (state.catalogInfo && state.catalogInfo.source !== 'upstream') {
    messages.push(['catalog', `Cached basic map information from ${new Date(state.catalogInfo.capturedAt).toLocaleString('sv-SE')}. Live data loads separately.`]);
  }
  for (const [key, value] of Object.entries(state.errors)) {
    if (value) messages.push([key, `${key}: ${value}`]);
  }
  if (state.liveQuality && state.liveQuality.state !== 'fresh') {
    const quality = state.liveQuality;
    const onlyExpired = quality.state === 'stale' && quality.reasons?.length > 0 &&
      quality.reasons.every((reason) => reason === 'GPS_OLD');
    if (!onlyExpired) {
      messages.push(['quality', `Live data: ${quality.state}${quality.scan?.failed ? ` (${quality.scan.failed} stops failed to refresh)` : ''}.`]);
    }
  }
  let elements = statusElements.get(container);
  if (!elements) {
    elements = new Map();
    statusElements.set(container, elements);
  }
  const keys = new Set(messages.map(([key]) => key));
  for (const [key, element] of elements) {
    if (keys.has(key)) continue;
    showNotice(element, '');
    element.remove();
    elements.delete(key);
  }
  for (const [key, message] of messages) {
    let element = elements.get(key);
    if (!element) {
      element = document.createElement('span');
      element.className = 'status-message';
      elements.set(key, element);
    }
    container.appendChild(element);
    const error = state.errors[key];
    showNotice(element, message, {
      transient: TRANSIENT_ERRORS.has(key),
      onDismiss: () => {
        if (store.get().errors[key] === error) store.set({ errors: { ...store.get().errors, [key]: null } });
      },
    });
  }
  container.hidden = messages.length === 0;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}
