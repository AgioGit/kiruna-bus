import { store } from './appState.js';
import { now, subscribeClock } from './clock.js';

let timer = null;
let service = null;

export function serviceView(data, nowMs) {
  const active = new Set();
  let next = Infinity;
  const completeUntil = Date.parse(data?.completeUntil ?? '');
  const complete = Number.isFinite(completeUntil) && nowMs < completeUntil;
  if (complete) next = completeUntil;
  for (const window of data?.windows ?? []) {
    const from = Date.parse(window.from), until = Date.parse(window.until), expires = Date.parse(window.expiresAt);
    if (nowMs >= expires || nowMs > until) continue;
    if (nowMs >= from) active.add(`${window.lineId}:${window.routeId}`);
    else if (from < expires && from <= until) next = Math.min(next, from);
    next = Math.min(next, expires, until + 1);
  }
  return { active, complete, next };
}

export function routeServiceStatus(view, lineId, routeId) {
  if (view?.active.has(`${lineId}:${routeId}`)) return 'active';
  return view?.complete ? 'inactive' : 'unknown';
}

export function visibleLineCount(state) {
  return state.lines.filter((line) => state.activeLineIds.has(line.id) &&
    [...(state.lineRoutes.get(line.id) ?? [])].some((routeId) =>
      state.routeGeometry.has(routeId) && routeServiceStatus(state.serviceView, line.id, routeId) !== 'inactive')).length;
}

export function refreshServiceView() {
  if (timer != null) clearTimeout(timer);
  timer = null;
  const nowMs = now();
  const view = serviceView(service, nowMs);
  store.set({ serviceView: view });
  if (Number.isFinite(view.next)) {
    timer = setTimeout(refreshServiceView, Math.max(1, Math.min(2147483647, view.next - nowMs)));
    timer?.unref?.();
  }
}

export function applyService(data) {
  service = data ?? null;
  refreshServiceView();
}

subscribeClock(refreshServiceView);

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshServiceView();
  });
}
