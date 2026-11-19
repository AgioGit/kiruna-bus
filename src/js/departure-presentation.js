import { effectiveDepartureTime } from './departure-history.js';

export function departureEstimateLabel(call, retained) {
  const forecast = call?.departure ?? call?.arrival;
  if (!Number.isFinite(Date.parse(forecast?.forecastTime))) {
    return Number.isFinite(Date.parse(forecast?.plannedTime)) ? 'plannedDeparture' : null;
  }
  return !retained && forecast.quality === 'realtime' ? 'liveEstimate' : 'departureEstimate';
}

export function lateMinutes(plannedTime, forecastTime) {
  const difference = Date.parse(forecastTime) - Date.parse(plannedTime);
  return Number.isFinite(difference) && difference > 0 ? Math.max(1, Math.round(difference / 60000)) : 0;
}

export function departureCountdown(call, timestamp) {
  const remaining = effectiveDepartureTime(call) - timestamp;
  if (!Number.isFinite(remaining) || remaining <= 0) return null;
  const minutes = Math.round(remaining / 60000);
  return {
    minutes,
    // At exactly half a minute the rounded value has not changed yet.
    nextIn: Math.min(remaining, minutes > 0 ? remaining - (minutes - 0.5) * 60000 + 1 : Infinity),
  };
}
