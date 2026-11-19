import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, api } from '../src/js/api.js';
import { departureReadReadyAt, departureReadState, getDepartureRead, readDepartures } from '../src/js/departure-reads.js';
import { resolveSavedStops, upcomingSavedDepartures } from '../src/js/saved-stop-board.js';
import { departureCountdown, departureEstimateLabel } from '../src/js/departure-presentation.js';

test('board verifies catalog names and suffixes, skips resolved duplicates and preserves missing favorites', () => {
  const catalog = new Map([
    [1, { text: 'Torget (143)' }], [2, { text: 'Göken' }], [3, { text: 'Göken (343)' }],
  ]);
  const texts = ['Torget', 'TORGET (143)', 'Göken', 'Go\u0308ken (343)', 'Göken (3)', 'Torget (3)', 'Missing'];
  assert.deepEqual(resolveSavedStops(texts, catalog).map(({ stop, text }) => [text, stop?.id]),
    [['Torget', 1], ['Göken', undefined], ['Go\u0308ken (343)', 3], ['Torget (3)', undefined], ['Missing', undefined]]);
});

test('board filters by effective time and active lines before choosing at most two rows', () => {
  const now = Date.parse('2026-01-01T10:00:00Z');
  const time = (minutes) => new Date(now + minutes * 60000).toISOString();
  const live = { lineId: 1, departure: { plannedTime: time(6), forecastTime: time(2), quality: 'realtime' } };
  const estimate = { lineId: 1, arrival: { plannedTime: time(1), forecastTime: time(3) } };
  const planned = { lineId: 1, departure: { plannedTime: time(4), quality: 'realtime' } };
  const calls = [
    { lineId: 1, departure: { plannedTime: time(2), forecastTime: time(-1) } },
    planned, { lineId: 2, departure: { plannedTime: time(1) } }, estimate, live,
  ];
  assert.deepEqual(upcomingSavedDepartures(calls, new Set([1]), now).rows.map(({ call }) => call), [live, estimate]);
  assert.deepEqual(upcomingSavedDepartures(calls, new Set([1]), now + 120000).rows.map(({ call }) => call), [estimate, planned]);
  assert.deepEqual(upcomingSavedDepartures(calls, new Set(), now), { hasFuture: true, rows: [] });
  assert.deepEqual(upcomingSavedDepartures(calls, new Set([1]), now + 240000), { hasFuture: false, rows: [] });
});

test('departure presentation does not label retained or planned times as live', () => {
  const timestamp = Date.parse('2026-01-01T10:00:00Z');
  const forecast = new Date(timestamp + 90000).toISOString();
  const live = { departure: { forecastTime: forecast, quality: 'realtime' } };
  const planned = { departure: { forecastTime: 'invalid', plannedTime: forecast, quality: 'realtime' } };
  assert.equal(departureEstimateLabel(live, false), 'liveEstimate');
  assert.equal(departureEstimateLabel(live, true), 'departureEstimate');
  assert.equal(departureEstimateLabel(planned, false), 'plannedDeparture');
  assert.deepEqual(departureCountdown(planned, timestamp), { minutes: 2, nextIn: 1 });
  assert.equal(departureCountdown(live, timestamp + 1).minutes, 1);
  assert.equal(departureCountdown(live, timestamp + 90000), null);
});

test('passive and active consumers share an in-flight response and its monotonic deadlines', async (t) => {
  let monotonic = 100;
  t.mock.method(performance, 'now', () => monotonic);
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const fetchCalls = t.mock.method(api, 'getCalls', () => pending);
  const board = new AbortController();
  const boardRead = readDepartures(1001, { passive: true, signal: board.signal });
  const detail = readDepartures(1001);
  board.abort();
  await assert.rejects(boardRead, { name: 'AbortError' });
  assert.equal(fetchCalls.mock.calls[0].arguments[0].passive, true);
  assert.equal(fetchCalls.mock.calls[0].arguments[1].signal.aborted, false);
  monotonic = 200;
  const response = { calls: [], freshForMs: 2000, expiresInMs: 4000, updatedAt: '2020-01-01T00:00:00Z',
    serverTime: '2035-01-01T00:00:00Z', state: 'fresh' };
  finish(response);
  const result = await detail;
  assert.equal(result.response, response);
  assert.equal(result.freshUntil, 2100);
  assert.equal(result.expiresAt, 4100);
  assert.equal(await readDepartures(1001, { passive: true }), result);
  assert.equal(fetchCalls.mock.callCount(), 1);
});

test('selected-first request stays active; a failed refresh retains the original response and honors Retry-After', async (t) => {
  let timestamp = 100;
  t.mock.method(performance, 'now', () => timestamp);
  const response = { calls: [], state: 'fresh', freshForMs: 30000, expiresInMs: 180000 };
  const fetchCalls = t.mock.method(api, 'getCalls', async () => response);
  const detail = new AbortController();
  const detailRead = readDepartures(1002, { signal: detail.signal });
  const board = readDepartures(1002, { passive: true });
  detail.abort();
  await assert.rejects(detailRead, { name: 'AbortError' });
  assert.equal(fetchCalls.mock.calls[0].arguments[0].passive, false);
  assert.equal((await board).response, response);
  timestamp = 6000;
  const failure = new ApiError('Unavailable', { status: 503, retryAfter: 900000 });
  fetchCalls.mock.mockImplementation(async () => { throw failure; });
  await assert.rejects(readDepartures(1002, { passive: true }), failure);
  assert.equal(getDepartureRead(1002).response, response);
  assert.equal(departureReadState(getDepartureRead(1002), 120099), 'stale');
  assert.equal(departureReadState(getDepartureRead(1002), 120100), 'unavailable');
  assert.equal(departureReadReadyAt(1002), 906000);
  await assert.rejects(readDepartures(1002), failure);
  assert.equal(fetchCalls.mock.callCount(), 2);
});
