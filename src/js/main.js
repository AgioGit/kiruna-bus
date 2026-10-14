import { loadConfig } from './config.js';
import { initMap } from './map.js';
import { initPoller } from './poller.js';
import { initUi } from './ui.js';
import { store } from './appState.js';
import { initCommuter } from './commuter.js';
import { initCountdown } from './countdown.js';
import { initTheme } from './theme.js';
import { initMapControls } from './mapControls.js';

initTheme();

async function main() {
  try {
    await loadConfig();
  } catch (err) {
    store.set({ errors: { ...store.get().errors, config: `Basic information could not be loaded: ${err.message}` } });
  }

  initUi();
  if (globalThis.L) initMap('map');
  else showFatalError('The map library could not be loaded. Stop search and departures are still available.');
  initMapControls();
  initCommuter();
  // initPoller polls the server's /api/buses (live-vehicles.js), which
  // populates routes/markers/the live buses list without any user
  // interaction (see docs/initial_plan.md).
  initPoller();
  initCountdown();
}

function showFatalError(message) {
  const el = document.getElementById('app-error');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
}

main();
