// Observations are not evidence that a vehicle actually departed. Keep one
// passed call and a bounded set of future candidates that may be pruned by
// the provider before their deadline.
export const MAX_PENDING_DEPARTURES = 64;
export const PENDING_HORIZON_MS = 24 * 60 * 60 * 1000;

export function effectiveDepartureTime(call) {
  const forecast = call?.departure ?? call?.arrival;
  const expected = Date.parse(forecast?.forecastTime);
  return Number.isFinite(expected) ? expected : Date.parse(forecast?.plannedTime);
}

export function advanceDepartureHistory(history, observations, nowMs) {
  const candidates = new Map();
  if (history?.previous) candidates.set(history.previous.call.id, history.previous);
  for (const item of history?.pending ?? []) candidates.set(item.call.id, item);
  for (const item of observations) {
    const old = candidates.get(item.call.id);
    if (!old || Date.parse(item.observedAt) >= Date.parse(old.observedAt)) candidates.set(item.call.id, item);
  }
  let previous = null;
  const pending = [];
  for (const item of candidates.values()) {
    const time = effectiveDepartureTime(item.call);
    if (!Number.isFinite(time)) continue;
    if (time <= nowMs) {
      if (!previous || time > effectiveDepartureTime(previous.call)) previous = item;
    } else if (time - nowMs <= PENDING_HORIZON_MS) pending.push(item);
  }
  pending.sort((a, b) => effectiveDepartureTime(a.call) - effectiveDepartureTime(b.call));
  return { previous, pending: pending.slice(0, MAX_PENDING_DEPARTURES) };
}

export function isPreviousDeparture(value) {
  const call = value?.call;
  return Boolean(call && typeof call.id === 'string' && Number.isInteger(call.lineId) &&
    typeof call.line === 'string' && typeof call.destination === 'string' &&
    Number.isFinite(effectiveDepartureTime(call)) && Number.isFinite(Date.parse(value.observedAt)) &&
    typeof value.isStopCancelled === 'boolean' && Array.isArray(value.messages) &&
    value.messages.every(isMessage));
}

function isMessage(message) {
  return Boolean(message && typeof message.text === 'string' &&
    (message.affectedCalls === undefined || (Array.isArray(message.affectedCalls) &&
      message.affectedCalls.every((id) => typeof id === 'string'))) &&
    (message.lines === undefined || (Array.isArray(message.lines) &&
      message.lines.every((line) => line && Number.isInteger(line.lineId)))));
}

export function observeCalls(calls, messages, isStopCancelled, observedAt) {
  const notices = messages === undefined ? [] : messages;
  if (!Array.isArray(notices) || !notices.every(isMessage)) throw new TypeError('Invalid departure messages');
  return calls.map((call) => ({
    call, observedAt, isStopCancelled: Boolean(isStopCancelled),
    messages: notices.filter((message) =>
      (!message.affectedCalls?.length || message.affectedCalls.includes(call.id)) &&
      (!message.lines?.length || message.lines.some((line) => line.lineId === call.lineId))),
  }));
}
