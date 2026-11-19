import { store } from './appState.js';
import { toggleLine } from './filters.js';
import { isApproximateLine } from './lineProperties.js';
import { searchStops, selectStopByText, clearSelectedStop, cancelStopSearch } from './stops.js';
import { formatTime, now } from './clock.js';
import { effectiveDepartureTime } from './departure-history.js';
import { departureCountdown, departureEstimateLabel, lateMinutes } from './departure-presentation.js';
import { colorForLineId, lineColorOrderForId, textColorForLineId } from './lineColors.js';
import { selectVehicle } from './vehicleSelection.js';
import { MAX_POSITION_AGE_MS } from './live-vehicles.js';
import { refreshNotice, showNotice } from './notices.js';
import { visibleLineCount } from './service.js';
import { escapeHtml, localizedAttr, localizedText as label, message, subscribeLocale, t } from './i18n.js';
import { errorMessage } from './api.js';

const TRIP_PREVIEW_STOPS = 3;
const TRANSIENT_ERRORS = new Set(['stopNotFound', 'cache']);
const statusElements = new WeakMap();
let arrivalsTimer;
const errorLabels = {
  config: 'statusConfig', stops: 'statusStops', lines: 'statusLines', routes: 'statusRoutes',
  vehicles: 'statusVehicles', calls: 'statusCalls', stopNotFound: 'statusStopNotFound', cache: 'statusCache',
};
const qualityLabels = {
  stale: 'qualityStale', partial: 'qualityPartial', unavailable: 'qualityUnavailable',
};

export function initUi() {
  wireInformationToggle();
  wireSearch();
  wireVehicleCardClicks();
  store.subscribe((state, prev) => {
    if (state.lines !== prev.lines || state.activeLineIds !== prev.activeLineIds ||
        state.serviceView !== prev.serviceView || state.lineRoutes !== prev.lineRoutes ||
        state.routeGeometry !== prev.routeGeometry) renderLineFilters(state);
    renderStopSearchInput(state);
    if (state.liveVehicles !== prev.liveVehicles || state.activeLineIds !== prev.activeLineIds ||
        state.selectedVehicleJourneyId !== prev.selectedVehicleJourneyId ||
        state.journeyStops !== prev.journeyStops || state.lines !== prev.lines ||
        state.liveQuality !== prev.liveQuality || state.errors.vehicles !== prev.errors.vehicles) {
      renderVehicleCards(state);
    }
    if (state.calls !== prev.calls || state.previousDeparture !== prev.previousDeparture || state.selectedStop !== prev.selectedStop ||
        state.isStopCancelled !== prev.isStopCancelled || state.isCallsLoading !== prev.isCallsLoading ||
        state.messages !== prev.messages || state.errors.calls !== prev.errors.calls ||
        state.departuresRetained !== prev.departuresRetained || state.departuresUpdatedAt !== prev.departuresUpdatedAt ||
        state.activeLineIds !== prev.activeLineIds || state.clockOffsetMs !== prev.clockOffsetMs) {
      renderArrivals(state);
    }
    if (state.errors !== prev.errors || state.catalogInfo !== prev.catalogInfo || state.liveQuality !== prev.liveQuality ||
        state.serviceView !== prev.serviceView) renderStatus(state);
  });
  renderLineFilters(store.get());
  renderStopSearchInput(store.get());
  renderVehicleCards(store.get());
  renderArrivals(store.get());
  renderStatus(store.get());
  subscribeLocale(() => {
    renderLineSummary(store.get());
    const elements = statusElements.get(document.getElementById('status-banner'));
    for (const element of elements?.values() ?? []) refreshNotice(element);
  });
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
    const key = unknown ? 'trackingUnavailable' : state.liveQuality.state !== 'fresh' ? 'trackingDegraded' : 'noBuses';
    container.innerHTML = `<h2>${label('liveBuses')}</h2><p class="hint">${label(key)}</p>`;
    if (focusedJourney) {
      container.tabIndex = -1;
      container.focus({ preventScroll: true });
    }
    return;
  }

  const staleCount = visibleVehicles.filter((b) => b.stale).length;
  const subtitle = staleCount
    ? `<p class="hint">${label('staleBuses', staleCount)}</p>`
    : '';

  const parts = [
    `<h2>${label('liveBusCount', visibleVehicles.length)}</h2>`,
    subtitle,
    state.selectedVehicleJourneyId != null &&
    !state.liveVehicles.some((bus) => bus.journeyId === state.selectedVehicleJourneyId)
      ? `<p class="hint">${label('selectedBusMissing')}</p>` : '',
    '<ul class="vehicle-list">',
  ];
  const expandedJourneys = new Set();
  for (const bus of visibleVehicles) {
    const lineText = bus.line ? bus.line.replace(/\.$/, '') : state.lines.find((line) => line.id === bus.lineId)?.text;
    const color = bus.lineId !== undefined ? colorForLineId(bus.lineId) : '#888888';
    const foreground = bus.lineId !== undefined ? textColorForLineId(bus.lineId) : '#ffffff';
    const destination = bus.destination ?? '—';
    const status = bus.stale
      ? `<span class="status-stale">${label('stalePosition', formatAge(bus.ageMs))}</span>`
      : `<span class="status-live">${label('livePosition')}</span>`;
    const nextStopText = stripStopId(bus.nextStop?.stopText) ?? '—';
    const planned = formatTime(bus.nextStop?.plannedTime);
    const expected = formatTime(bus.nextStop?.forecastTime ?? bus.nextStop?.plannedTime);
    const selected = bus.journeyId === state.selectedVehicleJourneyId;
    const expanded = selected && !expandedJourneys.has(bus.journeyId);
    if (expanded) expandedJourneys.add(bus.journeyId);
    const tag = bus.journeyId == null ? 'div' : 'button';
    const attributes = bus.journeyId == null
      ? ''
      : ` type="button" data-journey-id="${bus.journeyId}" aria-expanded="${expanded}"${expanded ? ` aria-controls="trip-${bus.journeyId}"` : ''}`;
    parts.push(`<li><${tag} class="vehicle-card${selected ? ' vehicle-card--selected' : ''}${expanded ? ' vehicle-card--expanded' : ''}${bus.stale ? ' vehicle-card--stale' : ''}"${attributes}>
      <span class="vehicle-card-main"><span class="line-badge" style="background:${color};color:${foreground}">${lineText != null ? escapeHtml(lineText) : bus.lineId !== undefined ? label('line', bus.lineId) : '—'}</span>
        <strong class="vehicle-destination">${escapeHtml(destination)}</strong>
        <span class="vehicle-time"><span class="vehicle-time-label">${label('eta')}</span>${expected}${lateEta(bus.nextStop?.plannedTime, bus.nextStop?.forecastTime)}</span></span>
      <span class="vehicle-card-next">${label('nextStop', nextStopText)}${planned !== '—' && planned !== expected ? ` <span class="hint">(${label('plannedLowercase', planned)})</span>` : ''}</span>
      <span class="vehicle-card-meta">${label('updated', formatTime(bus.position.timestamp))}${status}</span>
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
  const delays = stops.map((stop) => delayMinutes(stop.plannedTime, stop.forecastTime));
  const commonDelay = delays[0] < 0 && delays.every((delay) => delay === delays[0]) ? delays[0] : 0;
  const parts = [
    `<div id="trip-${bus.journeyId}" class="vehicle-trip" ${localizedAttr('aria-label', 'upcomingStops')}>`,
    `<div class="trip-heading"><h3>${label('upcomingStops')}</h3>${commonDelay ? `<span class="trip-delay">${label('early', -commonDelay)}</span>` : ''}</div>`,
  ];
  if (!stops.length) {
    parts.push(`<p class="hint">${label('noUpcomingStops')}</p>`);
  } else {
    const renderStop = (stop, delay) => {
      const planned = formatTime(stop.plannedTime);
      const expected = formatTime(stop.forecastTime ?? stop.plannedTime);
      const showPlanned = planned !== '—' && planned !== expected;
      const late = lateEta(stop.plannedTime, stop.forecastTime);
      const change = late || (!commonDelay && delay < 0 ? `<span class="trip-stop-change">${label('early', -delay)}</span>` : '');
      return `<li class="trip-stop"${showPlanned ? ` ${localizedAttr('title', 'planned', planned)}` : ''}>
        <span class="trip-stop-name">${escapeHtml(stripStopId(stop.stopText))}</span>
        <span class="trip-stop-time">${expected}${change}</span>
        ${showPlanned ? `<span class="visually-hidden">${label('planned', planned)}</span>` : ''}</li>`;
    };
    parts.push('<ol class="trip-stops">');
    for (let i = 0; i < Math.min(stops.length, TRIP_PREVIEW_STOPS); i++) {
      parts.push(renderStop(stops[i], delays[i]));
    }
    parts.push('</ol>');
    if (stops.length > TRIP_PREVIEW_STOPS) {
      const remaining = stops.length - TRIP_PREVIEW_STOPS;
      parts.push(`<details class="trip-more" data-journey-id="${bus.journeyId}"><summary>
        <span class="trip-more-closed">${label('showMoreStops', remaining)}</span>
        <span class="trip-more-open">${label('hideMoreStops')}</span>
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

function renderLineSummary(state) {
  const visible = visibleLineCount(state);
  const summary = document.getElementById('lines-summary');
  if (summary) {
    summary.textContent = state.lines.length ? t('linesShown', visible, state.lines.length) : t('loadingLines');
  }
  const buttonSummary = document.getElementById('lines-button-summary');
  if (buttonSummary) {
    buttonSummary.textContent = state.lines.length ? `${visible}/${state.lines.length}` : '';
    buttonSummary.parentElement.classList.toggle('map-tool-button--filtered', visible < state.lines.length);
  }
}

function renderLineFilters(state) {
  const container = document.getElementById('line-filters');
  if (!container) return;
  renderLineSummary(state);

  const renderKey = JSON.stringify(state.lines.map(({ id, text }) => [id, text, state.activeLineIds.has(id)]));
  // Avoid rebuilding interactive filters if the actual line list is unchanged.
  if (container.dataset.rendered === renderKey) return;
  container.dataset.rendered = renderKey;
  const html = state.lines
    .map((line) => {
      const checked = state.activeLineIds.has(line.id) ? 'checked' : '';
      const geometryHint = isApproximateLine(line.id) ? ` ${label('approximateRoute')}` : '';
      return `<label class="line-filter"><input type="checkbox" data-line-id="${line.id}" ${checked}> ${escapeHtml(line.text)}${geometryHint}</label>`;
    })
    .join('');

  const focusedLineId = container.contains(document.activeElement)
    ? document.activeElement.dataset.lineId : null;
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
  clearTimeout(arrivalsTimer);
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
  const timestamp = now();
  const retained = state.departuresRetained || Boolean(state.departuresUpdatedAt && state.errors.calls);
  let updateIn = Infinity;
  if (retained) {
    parts.push(`<p class="hint" role="status">${label('departuresNotLive', formatTime(state.departuresUpdatedAt))}</p>`);
  }
  if (state.isStopCancelled) {
    parts.push(`<p class="banner banner-cancelled">${label('stopCancelled')}</p>`);
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

  const isUpcoming = (call) => {
    const time = effectiveDepartureTime(call);
    return !Number.isFinite(time) || time > timestamp;
  };
  const visibleCalls = state.calls
    .filter((call) => state.activeLineIds.has(call.lineId) && isUpcoming(call))
    .sort((a, b) => {
      const aTime = plannedCallTime(a);
      const bTime = plannedCallTime(b);
      return aTime === bTime ? 0 : aTime - bTime;
    });

  if (state.errors.calls && !retained) {
    parts.push(`<p class="hint" role="status">${label('departuresRefreshFailed')}</p>`);
  }
  if (state.isCallsLoading && !visibleCalls.length) {
    parts.push(`<p class="hint" role="status">${label('checkingDepartures')}</p>`);
  } else if (!visibleCalls.length) {
    if ((!state.errors.calls || retained) && !state.isStopCancelled) {
      const hasUpcoming = state.calls.some(isUpcoming);
      parts.push(`<p class="hint">${label(hasUpcoming ? 'departuresFiltered' : 'noUpcomingDepartures')}</p>`);
    }
  } else {
    parts.push('<ul class="departure-list">');
    for (const call of visibleCalls) {
      const forecast = call.departure ?? call.arrival;
      const affected = affectedByCallId.get(call.id) ?? [];
      const timing = departureCountdown(call, timestamp);
      const countdown = !timing ? '' : timing.minutes > 0 ? label('inMinutes', timing.minutes) : label('dueNow');
      if (timing) updateIn = Math.min(updateIn, timing.nextIn);
      const time = effectiveDepartureTime(call);
      const expected = Number.isFinite(time) ? formatTime(time) : '—';
      const planned = forecast ? formatTime(forecast.plannedTime) : '—';
      const delay = delayMinutes(forecast?.plannedTime, forecast?.forecastTime);
      const bg = colorForLineId(call.lineId);
      const fg = textColorForLineId(call.lineId);
      const estimate = departureEstimateLabel(call, retained);
      parts.push(`<li class="departure-card">
        <div class="departure-main"><span class="line-badge" style="background:${bg};color:${fg}">${escapeHtml(call.line)}</span>
          <strong class="departure-destination">${escapeHtml(call.destination)}</strong>
          <span class="departure-time"><span class="visually-hidden">${label('expectedDeparture')}</span>${expected}${lateEta(forecast?.plannedTime, forecast?.forecastTime)}</span></div>
        <div class="departure-meta">${planned !== '—' ? label('planned', planned) : ''}
          ${countdown}
          ${delay < 0 ? `<span class="trip-delay">${label('early', -delay)}</span>` : ''}
          ${estimate && estimate !== 'plannedDeparture' ? label(estimate) : ''}</div>`);
      if (affected.length) {
        parts.push(`<p class="departure-message">${affected.map((m) => escapeHtml(m.text)).join('; ')}</p>`);
      }
      parts.push('</li>');
    }
    parts.push('</ul>');
  }

  const previous = state.previousDeparture;
  if (previous && state.activeLineIds.has(previous.call.lineId) && effectiveDepartureTime(previous.call) <= now()) {
    const call = previous.call;
    const generalMessages = previous.messages.filter((message) => !message.affectedCalls?.length && !message.lines?.length);
    const lineMessages = previous.messages.filter((message) => !message.affectedCalls?.length && message.lines?.length);
    const callMessages = previous.messages.filter((message) => message.affectedCalls?.length && message.affectedCalls.includes(call.id));
    const forecast = call.departure ?? call.arrival;
    const effective = Number.isFinite(Date.parse(forecast?.forecastTime)) ? forecast.forecastTime : forecast?.plannedTime;
    const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' });
    const date = day.format(new Date(effective));
    const dateLabel = date === day.format(new Date(now())) ? '' : ` · ${date}`;
    parts.push(`<ul class="departure-list"><li class="departure-card departure-card--previous">
      <div class="departure-main"><span class="line-badge">${escapeHtml(call.line)}</span>
        <strong class="departure-destination">${escapeHtml(call.destination)}</strong>
        <span class="departure-time"><span class="visually-hidden">${label('expectedDeparture')}</span>${formatTime(effective)}</span></div>
      <div class="departure-meta"><span>${label('previousDeparture')}${dateLabel}</span>
        ${label('planned', formatTime(forecast?.plannedTime))}
        ${forecast?.forecastTime ? label('expected', formatTime(forecast.forecastTime)) : ''}</div>
      ${previous.isStopCancelled ? `<p class="departure-message">${label('previousCancelled')}</p>` : ''}
      ${generalMessages.length ? `<p class="departure-message">${label('previousGeneral')} ${generalMessages.map((m) => escapeHtml(m.text)).join('; ')}</p>` : ''}
      ${lineMessages.length ? `<p class="departure-message">${label('previousLine')} ${lineMessages.map((m) => escapeHtml(m.text)).join('; ')}</p>` : ''}
      ${callMessages.length ? `<p class="departure-message">${label('previousCall')} ${callMessages.map((m) => escapeHtml(m.text)).join('; ')}</p>` : ''}
    </li></ul>`);
  }

  content.innerHTML = parts.join('');
  if (Number.isFinite(updateIn)) {
    arrivalsTimer = setTimeout(() => renderArrivals(store.get()), Math.max(1, Math.ceil(updateIn)));
    arrivalsTimer?.unref?.();
  }
}

function plannedCallTime(call) {
  const time = Date.parse((call.departure ?? call.arrival)?.plannedTime);
  return Number.isFinite(time) ? time : Infinity;
}

function delayMinutes(plannedTime, forecastTime) {
  const difference = Date.parse(forecastTime) - Date.parse(plannedTime);
  return Number.isFinite(difference) ? Math.round(difference / 60000) : 0;
}

function lateEta(plannedTime, forecastTime) {
  const minutes = lateMinutes(plannedTime, forecastTime);
  return minutes ? `<span class="eta-delay">(+${minutes} min)</span>` : '';
}

function renderStatus(state) {
  const container = document.getElementById('status-banner');
  if (!container) return;
  const messages = [];
  if (!state.serviceView?.complete) {
    messages.push(['service', message(state.serviceView?.classified ? 'servicePartial' : 'serviceUnknown')]);
  }
  if (state.catalogInfo?.source === 'retained') {
    messages.push(['catalog', message('catalogRetained')]);
  } else if (state.catalogInfo && state.catalogInfo.source !== 'upstream') {
    messages.push(['catalog', message('catalogCached', state.catalogInfo.capturedAt)]);
  }
  for (const [key, value] of Object.entries(state.errors)) {
    if (value) messages.push([key, message('statusLabel', errorLabels[key] ? message(errorLabels[key]) : key,
      typeof value === 'string' ? errorMessage(value) : value)]);
  }
  if (state.liveQuality && state.liveQuality.state !== 'fresh') {
    const quality = state.liveQuality;
    const onlyExpired = quality.state === 'stale' && quality.reasons?.length > 0 &&
      quality.reasons.every((reason) => reason === 'GPS_OLD');
    if (!onlyExpired) {
      const stateLabel = qualityLabels[quality.state] ? message(qualityLabels[quality.state]) : quality.state;
      messages.push(['quality', message(quality.scan?.failed ? 'liveQualityFailed' : 'liveQuality', stateLabel, quality.scan?.failed)]);
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
