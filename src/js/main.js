import { loadConfig } from './config.js';
import { initMap } from './map.js';
import { initPoller } from './poller.js';
import { initUi } from './ui.js';
import { store } from './appState.js';
import { initCommuter } from './commuter.js';
import { initCountdown } from './countdown.js';
import { initTheme } from './theme.js';
import { initMapControls } from './mapControls.js';
import { initTrafficInfo } from './traffic-info.js';
import { initUpstreamDebug } from './upstream-debug.js';
import { initSavedStopBoard } from './saved-stop-board.js';
import { initLocale, message, subscribeLocale, t } from './i18n.js';
import { errorMessage } from './api.js';

initLocale();
initTheme();
initTrafficInfo();
initUpstreamDebug();

async function main() {
  const leafletReady = loadLeaflet();
  try {
    await loadConfig();
  } catch (err) {
    store.set({ errors: { ...store.get().errors, config: message('catalogLoadFailed', errorMessage(err)) } });
  }

  initUi();
  initMapControls();
  initCommuter();
  initSavedStopBoard();
  initPoller();
  initCountdown();
  if (await leafletReady) initMap('map');
  else showFatalError();
}

function loadAsset(element, integrity, add) {
  return new Promise((resolve) => {
    element.integrity = integrity;
    element.crossOrigin = 'anonymous';
    element.addEventListener('load', () => resolve(true), { once: true });
    element.addEventListener('error', () => resolve(false), { once: true });
    add(element);
  });
}

async function loadLeaflet() {
  const base = 'https://unpkg.com/leaflet@1.9.4/dist';
  const script = document.createElement('script');
  script.src = `${base}/leaflet.js`;
  const style = document.createElement('link');
  style.rel = 'stylesheet';
  style.href = `${base}/leaflet.css`;
  const [scriptLoaded, styleLoaded] = await Promise.all([
    loadAsset(script, 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=',
      (element) => document.head.append(element)),
    loadAsset(style, 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=',
      (element) => document.querySelector('link[rel="stylesheet"]').before(element)),
  ]);
  return scriptLoaded && styleLoaded && Boolean(globalThis.L);
}

function showFatalError() {
  const el = document.getElementById('app-error');
  if (!el) return;
  const render = () => { el.textContent = t('mapMissing'); };
  render();
  subscribeLocale(render);
  el.hidden = false;
}

main();
