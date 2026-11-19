// Stop-finding shortcuts: browser-geolocation "Nearby stops" (only on an
// explicit button press - the app never asks for location on its own) and
// locally saved favorite stops, selectable in one tap. No dependency on a
// backend or build step: favorites persist through localStorage only.
//
import { store } from './appState.js';
import { selectStopArea, selectStopByText } from './stops.js';
import { api, errorMessage } from './api.js';
import { refreshNotice, showNotice } from './notices.js';
import { message, subscribeLocale, t } from './i18n.js';

const FAVORITES_STORAGE_KEY = 'kiruna-bus-tracker.favoriteStops.v1';
const NEARBY_MAX_COUNT = 5;
const EARTH_RADIUS_M = 6371000;

// In-memory mirror of localStorage, kept as an ordered list of StopArea.text
// values (favorites are persisted "by stop text" per spec, not by numeric
// id, since that's the only value both FindStopArea and FindStopsNearLocation
// results share).
let favorites = [];
const favoriteListeners = new Set();

export function getFavoriteStops() { return [...favorites]; }

export function subscribeFavoriteStops(listener) {
  favoriteListeners.add(listener);
  return () => favoriteListeners.delete(listener);
}
// Guards against acting on a getCurrentPosition callback from a
// since-superseded "Find nearby stops" press (e.g. a fast double click).
let nearbyRequestId = 0;
// Mirrors ui.js's stopSelectionSeq-gated sync: re-render only when the
// selection actually changed (search, map circle, map click, or a pick made
// from this panel), not on every unrelated 15s poll tick.
let lastSyncedSelectionSeq = -1;

export function initCommuter() {
  favorites = loadFavorites();
  wireFavoriteToggle();
  wireNearbyButton();

  renderFavorites();
  renderFavoriteToggle(store.get());

  lastSyncedSelectionSeq = store.get().stopSelectionSeq ?? 0;
  store.subscribe(handleStoreUpdate);
  subscribeLocale(() => {
    renderFavoriteToggle(store.get());
    refreshNotice(document.getElementById('favorites-status'));
    refreshNotice(document.getElementById('nearby-stops-status'));
  });
}

function handleStoreUpdate(state) {
  const seq = state.stopSelectionSeq ?? 0;
  if (seq === lastSyncedSelectionSeq) return;
  lastSyncedSelectionSeq = seq;
  // A stop selected any way - search, map circle/click, a favorite, or a
  // nearby-stop pick - should immediately update which favorite (if any) is
  // marked current and flip the add/remove wording.
  renderFavorites(state);
  renderFavoriteToggle(state);
  // The Clear button deselects the stop; it should also dismiss any
  // "Find stops near me" results (and ignore a lookup still in flight).
  if (!state.selectedStop) {
    nearbyRequestId += 1;
    clearNearbyList();
    showNearbyStatus('');
    const button = document.getElementById('nearby-stops-button');
    if (button) button.disabled = false;
  }
}

// ---- Favorites: storage -----------------------------------------------

function loadFavorites() {
  try {
    const raw = window.localStorage.getItem(FAVORITES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new TypeError('Saved favorites are not a list');
    return sanitizeFavoritesList(parsed);
  } catch {
    showFavoritesStatus(message('favoritesLoadFailed'));
    return [];
  }
}

function saveFavorites(list) {
  try {
    window.localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(list));
    return true;
  } catch {
    // Quota exceeded, storage disabled, etc. - keep working in-memory for
    // this session and let the caller surface a non-fatal warning.
    return false;
  }
}

// Pure and independently testable: keeps only non-empty strings and drops
// duplicates while preserving first-seen order.
export function sanitizeFavoritesList(parsed) {
  if (!Array.isArray(parsed)) return [];
  const seen = new Set();
  const clean = [];
  for (const entry of parsed) {
    if (typeof entry !== 'string') continue;
    const text = entry.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    clean.push(text);
  }
  return clean;
}

// ---- Favorites: actions -------------------------------------------------

function wireFavoriteToggle() {
  const button = document.getElementById('favorite-toggle');
  if (!button) return;
  button.addEventListener('click', () => {
    const stop = store.get().selectedStop;
    if (!stop?.text) return;
    if (favorites.includes(stop.text)) removeFavorite(stop.text);
    else addFavorite(stop.text);
  });
}

function addFavorite(text) {
  if (favorites.includes(text)) return;
  favorites = [...favorites, text];
  persistFavorites();
}

function removeFavorite(text) {
  favorites = favorites.filter((t) => t !== text);
  persistFavorites();
}

function persistFavorites() {
  const ok = saveFavorites(favorites);
  showFavoritesStatus(
    ok ? '' : message('favoritesSaveFailed')
  );
  renderFavorites(store.get());
  renderFavoriteToggle(store.get());
  for (const listener of favoriteListeners) listener();
}

// ---- Favorites: rendering (safe DOM textContent, no innerHTML) ---------

function renderFavorites(state = store.get()) {
  const list = document.getElementById('favorite-stops-list');
  const empty = document.getElementById('favorite-stops-empty');
  if (empty) empty.hidden = favorites.length > 0;
  if (!list) return;

  list.textContent = '';
  const currentText = state.selectedStop?.text ?? null;

  for (const text of favorites) {
    const item = document.createElement('li');
    item.className = 'favorite-stop-item';

    const selectButton = document.createElement('button');
    selectButton.type = 'button';
    selectButton.className = 'favorite-stop-select';
    selectButton.textContent = displayStopText(text);
    selectButton.title = text;
    const isCurrent = text === currentText;
    selectButton.setAttribute('aria-current', String(isCurrent));
    if (isCurrent) item.classList.add('favorite-stop-item--current');
    selectButton.addEventListener('click', () => {
      selectStopByText(text);
    });
    item.appendChild(selectButton);

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'favorite-stop-remove';
    removeButton.textContent = '\u2715';
    removeButton.setAttribute('aria-label', t('removeFavorite', displayStopText(text)));
    removeButton.setAttribute('data-i18n-aria-label', 'removeFavorite');
    removeButton.dataset.i18nArgs = JSON.stringify([displayStopText(text)]);
    removeButton.addEventListener('click', () => removeFavorite(text));
    item.appendChild(removeButton);

    list.appendChild(item);
  }
}

function renderFavoriteToggle(state) {
  const button = document.getElementById('favorite-toggle');
  if (!button) return;
  const stop = state.selectedStop;

  if (!stop?.text) {
    button.disabled = true;
    button.hidden = true;
    button.textContent = t('saveStop');
    button.setAttribute('aria-pressed', 'false');
    button.removeAttribute('aria-label');
    return;
  }

  const isFavorite = favorites.includes(stop.text);
  button.hidden = false;
  button.disabled = false;
  button.setAttribute('aria-pressed', String(isFavorite));
  button.textContent = t(isFavorite ? 'removeSavedStop' : 'saveStop');
  button.setAttribute('aria-label', t(isFavorite ? 'removeStopLabel' : 'saveStopLabel', displayStopText(stop.text)));
}

function showFavoritesStatus(message) {
  showNotice(document.getElementById('favorites-status'), message, { transient: true });
}

// ---- Nearby stops (explicit button press only) --------------------------

function wireNearbyButton() {
  const button = document.getElementById('nearby-stops-button');
  if (!button) return;
  button.addEventListener('click', findNearbyStops);
}

// Only ever invoked by the click handler above - the panel never requests
// location on load or on any other implicit trigger.
function findNearbyStops() {
  const button = document.getElementById('nearby-stops-button');
  const myRequestId = ++nearbyRequestId;

  clearNearbyList();

  if (!('geolocation' in navigator)) {
    showNearbyStatus(message('noGeolocation'));
    return;
  }

  if (button) button.disabled = true;
  showNearbyStatus(message('locating'), false);

  try {
    navigator.geolocation.getCurrentPosition(
      (position) => onGeolocationSuccess(position, myRequestId, button),
      (error) => onGeolocationError(error, myRequestId, button),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  } catch (error) {
    showNearbyStatus(message('locationRequestFailed', errorMessage(error)));
    if (button) button.disabled = false;
  }
}

async function onGeolocationSuccess(position, myRequestId, button) {
  if (myRequestId !== nearbyRequestId) return; // superseded by a later press
  const origin = { lat: position.coords.latitude, lon: position.coords.longitude };
  try {
    const stops = await api.findStopsNearLocation(origin, { maxCount: NEARBY_MAX_COUNT });
    if (myRequestId !== nearbyRequestId) return;
    renderNearbyStops(stops ?? [], origin);
  } catch (err) {
    if (myRequestId !== nearbyRequestId) return;
    showNearbyStatus(message('nearbyLookupFailed', errorMessage(err)));
  } finally {
    if (myRequestId === nearbyRequestId && button) button.disabled = false;
  }
}

function onGeolocationError(error, myRequestId, button) {
  if (myRequestId !== nearbyRequestId) return;
  showNearbyStatus(message(geolocationErrorKey(error)));
  if (button) button.disabled = false;
}

// Distinguishes the standard GeolocationPositionError codes so denial,
// unavailability, and timeout each get an explicit, actionable message
// instead of one generic failure string.
export function geolocationErrorMessage(error) {
  return t(geolocationErrorKey(error));
}

function geolocationErrorKey(error) {
  switch (error?.code) {
    case 1: // PERMISSION_DENIED
      return 'locationDenied';
    case 2: // POSITION_UNAVAILABLE
      return 'locationUnavailable';
    case 3: // TIMEOUT
      return 'locationTimeout';
    default:
      return 'locationFailed';
  }
}

function clearNearbyList() {
  const list = document.getElementById('nearby-stops-list');
  if (list) list.textContent = '';
}

function renderNearbyStops(stops, origin) {
  const list = document.getElementById('nearby-stops-list');
  if (!list) return;
  list.textContent = '';

  if (!stops.length) {
    showNearbyStatus(message('noNearby'));
    return;
  }
  showNearbyStatus('');

  for (const stop of stops) {
    const item = document.createElement('li');
    item.className = 'nearby-stop-item';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'nearby-stop-select';
    const distance = distanceLabel(origin, stop.location);
    button.textContent = distance ? `${displayStopText(stop.text)} (${distance})` : displayStopText(stop.text);
    button.title = stop.text;
    button.addEventListener('click', () => {
      selectStopArea(stop);
    });
    item.appendChild(button);
    list.appendChild(item);
  }
}

function showNearbyStatus(message, transient = true) {
  showNotice(document.getElementById('nearby-stops-status'), message, { transient });
}

// ---- Shared pure helpers (exported for tests) ---------------------------

// StopArea.text is formatted like "Stadshustorget (84064)" (see
// docs/API.md / openapi.yaml) - the trailing "(id)" round-trips into
// FindStopArea but is noise for display.
export function displayStopText(text) {
  if (!text) return text ?? '';
  return text.replace(/\s*\(\d+\)\s*$/, '');
}

export function distanceLabel(origin, location) {
  if (!origin || !location || typeof location.lat !== 'number' || typeof location.lon !== 'number') return null;
  const meters = haversineMeters(origin, location);
  if (!Number.isFinite(meters)) return null;
  return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1)} km`;
}

export function haversineMeters(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}
