import { getLiveVehiclesSchedule } from './poller.js';

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
      el.textContent = '(live updates)';
    } else if (nextFallbackAt != null) {
      el.textContent = `(reconnecting: ${Math.max(0, Math.ceil((nextFallbackAt - Date.now()) / 1000))}s)`;
    } else {
      el.textContent = '(connecting…)';
    }
  }

  update();
  setInterval(update, 1000);
}
