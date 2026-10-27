import test from 'node:test';
import assert from 'node:assert/strict';
import { createTracker } from '../lib/tracker.js';
import { departuresDto } from '../app.js';
import { validate } from '../lib/validation.js';
import { observeCalls } from '../../src/js/departure-history.js';

const T = Date.parse('2026-01-01T12:00:00Z');
const iso = (ms) => new Date(T + ms).toISOString();
const call = (id, planned, forecast = planned) => ({
  id, lineId: 1, routeId: 1, line: 'Red', destination: 'Town', journeyId: 1, sequenceNumber: 1,
  departure: { plannedTime: iso(planned), forecastTime: iso(forecast) },
});

test('shared collector retains pruned observations per stop, with correction and no live-route evidence', async () => {
  let time = T;
  let responses = new Map([
    ['A', { calls: [{ calls: [call('later', 25000), call('first', 5000)] }], isStopCancelled: true,
      messages: [
        { text: 'Service cancelled', isDisturbance: true, affectedCalls: [] },
        { text: 'General information', lines: [] },
        { text: 'First line notice', affectedCalls: [], lines: [{ lineId: 1, lineName: 'Red', lineAppearance: { background: '#ff0000' } }] },
        { text: 'Other line notice', affectedCalls: [], lines: [{ lineId: 2, lineName: 'Blue' }] },
        { text: 'First call notice', isDisturbance: true, affectedCalls: ['first'] },
        { text: 'Later call notice', affectedCalls: ['later'] },
        { text: 'Wrong line for call', affectedCalls: ['first'], lines: [{ lineId: 2 }] },
      ] }],
    ['B', { calls: [] }],
  ]);
  const api = {
    getSystemTimestamp: async (clientTimestamp) => ({ systemTimestamp: clientTimestamp, clientTimestamp }),
    getCalls: async (stop) => responses.get(stop),
    getVehiclePosition: async () => null,
  };
  const tracker = createTracker({ api, now: () => time, initialStops: [{ id: 1, text: 'A' }, { id: 2, text: 'B' }],
    options: { retryDelayMs: 0 } });
  try {
    await tracker.collect();
    assert.equal(tracker.getPreviousDeparture(1), null);
    assert.equal(tracker.getDepartureHistory(1).pending.length, 2);
    responses.set('A', { calls: [{ calls: [call('later', 25000)] }] });
    time += 3000;
    await tracker.collect();
    assert.equal(tracker.getDepartureHistory(1).pending.length, 2);
    time = T + 5000;
    const previous = tracker.getPreviousDeparture(1);
    assert.equal(previous.call.id, 'first');
    assert.equal(previous.isStopCancelled, true);
    assert.deepEqual(previous.messages.map((message) => message.text),
      ['Service cancelled', 'General information', 'First line notice', 'First call notice']);
    assert.equal(tracker.getPreviousDeparture(2), null);
    const dto = validate('departures', departuresDto(tracker.getStopCalls(1), { nowMs: time, freshWithinMs: 30000, previousDeparture: previous }));
    assert.equal(dto.previousDeparture.call.id, 'first');
    assert.deepEqual(dto.previousDeparture.messages, [
      { text: 'Service cancelled', isDisturbance: true, affectedCalls: [], lines: [] },
      { text: 'General information', isDisturbance: false, affectedCalls: [], lines: [] },
      { text: 'First line notice', isDisturbance: false, affectedCalls: [], lines: [{ lineId: 1 }] },
      { text: 'First call notice', isDisturbance: true, affectedCalls: ['first'], lines: [] },
    ]);
    assert.deepEqual(dto.calls.map((item) => item.id), ['later']);
    responses.set('A', { calls: [{ calls: [call('first', 5000, 10000), call('later', 25000)] }] });
    time = T + 6000;
    await tracker.collect();
    assert.equal(tracker.getPreviousDeparture(1), null);
    time = T + 10000;
    assert.equal(tracker.getPreviousDeparture(1).call.id, 'first');
    time = T + 25000;
    assert.equal(tracker.getPreviousDeparture(1).call.id, 'later');
    assert.equal(tracker.getSnapshot().vehicles.length, 0);
  } finally { tracker.close(); }
});

test('live DTO preserves line scope for client-side observations', () => {
  const entry = {
    calls: [call('first', 5000)], at: T, isStopCancelled: false,
    messages: [
      { text: 'Other line', affectedCalls: [], lines: [{ lineId: 2, lineName: 'Blue' }] },
      { text: 'This line', affectedCalls: [], lines: [{ lineId: 1, lineName: 'Red' }] },
      { text: 'General', affectedCalls: [], lines: [] },
      { text: 'This call', affectedCalls: ['first'] },
      { text: 'Other call', affectedCalls: ['later'] },
    ],
  };
  const dto = validate('departures', departuresDto(entry, { nowMs: T, freshWithinMs: 30000 }));
  assert.deepEqual(dto.messages.map((message) => message.lines), [[{ lineId: 2 }], [{ lineId: 1 }], [], [], []]);
  const [observation] = observeCalls(dto.calls, dto.messages, dto.isStopCancelled, dto.updatedAt);
  assert.deepEqual(observation.messages.map((message) => message.text), ['This line', 'General', 'This call']);
});
