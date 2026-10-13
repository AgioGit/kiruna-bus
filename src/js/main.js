import { loadConfig } from './config.js';
import { loadLines } from './lines.js';
import { initMap } from './map.js';
import { initPoller } from './poller.js';
import { initUi } from './ui.js';
import { initClockOffset } from './clock.js';
import { initCommuter } from './commuter.js';
import { initCountdown } from './countdown.js';
import { initTheme } from './theme.js';
import { initMapControls } from './mapControls.js';

initTheme();

async function main() {
  try {
    await loadConfig();
  } catch (err) {
    showFatalError(`Failed to load configuration: ${err.message}. Reload the page to try again.`);
    return;
  }

  // Lines and clock offset can load independently of each other.
  await Promise.allSettled([loadLines(), initClockOffset()]);

  initMap('map');
  initUi();
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
