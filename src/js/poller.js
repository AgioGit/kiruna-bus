import { store } from './appState.js';
import { fetchCallsForSelectedStop } from './calls.js';
import { refreshLiveVehicles } from './live-vehicles.js';
import { refreshStopLocations } from './stop-locations.js';
import { refreshBootstrap } from './config.js';

const INTERVAL_MS = 60000;
let liveTimer, callsTimer, liveAbort, callsAbort;
let liveGeneration = 0, callsGeneration = 0;
let liveFailures = 0, callsFailures = 0;
let paused = false, initialized = false;
let nextAt = null, running = false;

export function getLiveVehiclesSchedule() { return { nextAt, running }; }

export function failureDelay(failures, retryAfter, random = Math.random) {
  return Math.min(300000, Math.max(retryAfter ?? 0, Math.min(300000, 5000 * 2 ** Math.min(failures - 1, 6)) * (1 + random() * 0.2)));
}

async function pollLiveVehicles(token) {
  if (paused || token !== liveGeneration) return;
  const controller = new AbortController();
  liveAbort = controller;
  const signal = controller.signal;
  const isCurrent = () => !signal.aborted && !paused && token === liveGeneration;
  running = true;
  nextAt = null;
  let wait = INTERVAL_MS;
  void refreshStopLocations({ signal, isCurrent }).catch((error) => {
    if (isCurrent()) store.set({ errors: { ...store.get().errors, stops: error.message } });
  });
  void refreshBootstrap({ signal, isCurrent }).catch((error) => {
    if (isCurrent()) store.set({ errors: { ...store.get().errors, config: error.message } });
  });
  try {
    await refreshLiveVehicles({ signal, isCurrent });
    if (isCurrent()) liveFailures = 0;
  } catch (error) {
    if (isCurrent()) {
      wait = failureDelay(++liveFailures, error.retryAfter);
      store.set({
        liveQuality: { ...(store.get().liveQuality ?? {}), state: 'unavailable' },
        errors: { ...store.get().errors, vehicles: error.message },
      });
    }
  } finally {
    if (liveAbort === controller) running = false;
    if (isCurrent()) {
      nextAt = Date.now() + wait;
      liveTimer = setTimeout(() => pollLiveVehicles(token), wait);
      liveTimer?.unref?.();
    }
  }
}

async function pollCalls(token) {
  if (paused || token !== callsGeneration || !store.get().selectedStop) return;
  const controller = new AbortController();
  callsAbort = controller;
  const signal = controller.signal;
  const isCurrent = () => !signal.aborted && !paused && token === callsGeneration;
  let wait = INTERVAL_MS;
  try {
    await fetchCallsForSelectedStop({ signal, isCurrent });
    if (isCurrent()) callsFailures = 0;
  } catch (error) {
    if (isCurrent()) {
      wait = failureDelay(++callsFailures, error.retryAfter);
      store.set({ isCallsLoading: false, errors: { ...store.get().errors, calls: error.message } });
    }
  } finally {
    if (isCurrent() && store.get().selectedStop) {
      callsTimer = setTimeout(() => pollCalls(token), wait);
      callsTimer?.unref?.();
    }
  }
}

export function onStopSelected() {
  callsGeneration++;
  clearTimeout(callsTimer);
  callsAbort?.abort();
  callsFailures = 0;
  if (!paused) void pollCalls(callsGeneration);
}

export function onStopDeselected() {
  callsGeneration++;
  clearTimeout(callsTimer);
  callsAbort?.abort();
  store.set({ calls: [], isStopCancelled: false, messages: [], isCallsLoading: false, departuresUpdatedAt: null });
}

export function pausePolling() {
  paused = true;
  liveGeneration++;
  callsGeneration++;
  clearTimeout(liveTimer);
  clearTimeout(callsTimer);
  liveAbort?.abort();
  callsAbort?.abort();
  nextAt = null;
  running = false;
}

export function resumePolling() {
  paused = false;
  clearTimeout(liveTimer);
  liveAbort?.abort();
  void pollLiveVehicles(++liveGeneration);
  if (store.get().selectedStop) onStopSelected();
}

export function initPoller() {
  if (initialized) return;
  initialized = true;
  if (document.hidden) pausePolling();
  else resumePolling();
  document.addEventListener('visibilitychange', () => document.hidden ? pausePolling() : resumePolling());
}
