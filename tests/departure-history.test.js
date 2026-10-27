import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceDepartureHistory, effectiveDepartureTime, isPreviousDeparture, MAX_PENDING_DEPARTURES, observeCalls } from '../src/js/departure-history.js';

const T = Date.parse('2026-01-01T12:00:00Z');
const iso = (ms) => new Date(T + ms).toISOString();
const call = (id, planned, forecast = planned) => ({
  id, lineId: 1, line: 'Red', destination: 'Town', journeyId: 1, sequenceNumber: 1,
  departure: { plannedTime: iso(planned), forecastTime: forecast == null ? null : iso(forecast) },
});
const observe = (calls, at = 0) => observeCalls(calls, [], false, iso(at));

test('one latest effective passed time is retained through pruning and replaced at the exact boundary', () => {
  const a = call('a', 1000), b = call('b', 5000), delayed = call('delayed', -1000, 10000);
  let history = advanceDepartureHistory(null, observe([b, a, delayed]), T);
  assert.equal(history.previous, null);
  history = advanceDepartureHistory(history, [], T + 1000);
  assert.equal(history.previous.call.id, 'a');
  history = advanceDepartureHistory(history, [], T + 5000);
  assert.equal(history.previous.call.id, 'b');
  history = advanceDepartureHistory(history, [], T + 10000);
  assert.equal(history.previous.call.id, 'delayed');
});

test('newer forecast correction retracts history, older observations cannot undo it', () => {
  let history = advanceDepartureHistory(null, observe([call('a', -1000)]), T);
  history = advanceDepartureHistory(history, observe([call('a', -1000, 5000)], 1000), T + 1000);
  assert.equal(history.previous, null);
  assert.equal(history.pending[0].call.departure.forecastTime, iso(5000));
  history = advanceDepartureHistory(history, observe([call('a', -1000)], 0), T + 2000);
  assert.equal(history.previous, null);
  assert.equal(advanceDepartureHistory(history, [], T + 5000).previous.call.id, 'a');
});

test('planned time fallback, bounded pending data and validation', () => {
  const invalidForecast = call('x', 500, null);
  invalidForecast.departure.forecastTime = 'invalid';
  assert.equal(effectiveDepartureTime(invalidForecast), T + 500);
  const values = Array.from({ length: 100 }, (_, i) => call(String(i), (i + 1) * 1000));
  const history = advanceDepartureHistory(null, observe(values), T);
  assert.equal(history.pending.length, MAX_PENDING_DEPARTURES);
  assert.equal(history.pending[0].call.id, '0');
  assert.equal(isPreviousDeparture(history.pending[0]), true);
  assert.equal(isPreviousDeparture({ call: {} }), false);
  assert.equal(isPreviousDeparture(undefined), false);
});

test('observations retain only notices matching both call and line scopes', () => {
  const messages = [
    { text: 'Service cancelled', isDisturbance: true, affectedCalls: [] },
    { text: 'General information', lines: [] },
    { text: 'This line', affectedCalls: [], lines: [{ lineId: 1, lineName: 'Red' }] },
    { text: 'Other line', affectedCalls: [], lines: [{ lineId: 2, lineName: 'Blue' }] },
    { text: 'Multiple lines', lines: [{ lineId: 2 }, { lineId: 1 }] },
    { text: 'This call', affectedCalls: ['a'] },
    { text: 'Other call', affectedCalls: ['b'] },
    { text: 'Both match', affectedCalls: ['a'], lines: [{ lineId: 1 }] },
    { text: 'Call matches but line does not', affectedCalls: ['a'], lines: [{ lineId: 2 }] },
    { text: 'Line matches but call does not', affectedCalls: ['b'], lines: [{ lineId: 1 }] },
  ];
  const observation = observeCalls([call('a', -1000)], messages, false, iso(0))[0];
  const history = advanceDepartureHistory(null, [observation], T);
  assert.deepEqual(history.previous.messages.map((message) => message.text),
    ['Service cancelled', 'General information', 'This line', 'Multiple lines', 'This call', 'Both match']);
  assert.equal(history.previous.isStopCancelled, false);
});

test('malformed message scopes are rejected rather than treated as general', () => {
  const observation = observe([call('a', -1000)])[0];
  for (const message of [
    { text: 'Invalid', lines: null }, { text: 'Invalid', lines: [{}] },
    { text: 'Invalid', lines: [{ lineId: '1' }] }, { text: 'Invalid', affectedCalls: 'a' },
  ]) {
    assert.throws(() => observeCalls([observation.call], [message], false, iso(0)), TypeError);
    assert.equal(isPreviousDeparture({ ...observation, messages: [message] }), false);
  }
});
