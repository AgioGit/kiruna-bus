import { getLiveVehiclesSchedule } from './poller.js';
import { subscribeLocale, t } from './i18n.js';

// Shows the live-stream connection/recovery state in the header, in place
// of the old poll-tick countdown: a healthy SSE connection needs no
// countdown at all, and when it's down the figure shown is the real time
// until the next HTTP fallback attempt (see poller.js's delivery watchdog).
export function initCountdown(elementId = 'refresh-countdown') {
  const el = document.getElementById(elementId);
  if (!el) return;

  function update() {
    const { connected, nextFallbackAt } = getLiveVehiclesSchedule();
    if (connected) {
      el.textContent = t('liveUpdates');
    } else if (nextFallbackAt != null) {
      el.textContent = t('reconnecting', Math.max(0, Math.ceil((nextFallbackAt - Date.now()) / 1000)));
    } else {
      el.textContent = t('connecting');
    }
  }

  update();
  subscribeLocale(update);
  setInterval(update, 1000);
}
