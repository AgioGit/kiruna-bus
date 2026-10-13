import test from 'node:test';
import assert from 'node:assert/strict';
import { store } from '../src/js/appState.js';
import { initUi } from '../src/js/ui.js';

test('live buses stay grouped by line color and journey as ETAs change', () => {
  const originalDocument = globalThis.document;
  const container = {
    innerHTML: '',
    addEventListener() {},
    contains: () => false,
    querySelector: () => null,
  };
  globalThis.document = {
    activeElement: null,
    getElementById: (id) => id === 'live-buses' ? container : null,
  };

  try {
    const lines = [
      { id: 1, text: 'Röd' },
      { id: 2, text: 'Gul' },
      { id: 3, text: 'Grön' },
      { id: 4, text: 'Lila' },
    ];
    const bus = (journeyId, lineId, time) => ({
      journeyId,
      lineId,
      destination: `Bus ${journeyId}`,
      ageMs: 0,
      position: { timestamp: time },
      nextStop: { stopText: 'Center (1)', forecastTime: time },
    });
    const vehicles = [
      bus(40, 1, '2026-09-25T08:00:00Z'),
      bus(31, 3, '2026-09-25T08:10:00Z'),
      bus(20, 2, '2026-09-25T08:20:00Z'),
      bus(30, 3, '2026-09-25T08:30:00Z'),
      bus(50, 4, '2026-09-25T08:40:00Z'),
    ];
    const displayedJourneys = () => [...container.innerHTML.matchAll(/<button\b[^>]*data-journey-id="(\d+)"/g)]
      .map((match) => Number(match[1]));

    store.set({ lines, activeLineIds: new Set(lines.map((line) => line.id)), liveVehicles: vehicles });
    initUi();
    assert.deepEqual(displayedJourneys(), [30, 31, 20, 50, 40]);

    store.set({
      liveVehicles: [...vehicles].reverse().map((vehicle, index) => ({
        ...vehicle,
        nextStop: { ...vehicle.nextStop, forecastTime: `2026-09-25T09:0${index}:00Z` },
      })),
    });
    assert.deepEqual(displayedJourneys(), [30, 31, 20, 50, 40]);
  } finally {
    globalThis.document = originalDocument;
  }
});

test('stop departures sort by planned instants, not live ETAs, without mutating calls', () => {
  const originalDocument = globalThis.document;
  const arrivals = { innerHTML: '', hidden: false };
  const arrivalsPanel = { hidden: false };
  const stopName = { textContent: '' };
  globalThis.document = {
    activeElement: null,
    getElementById: (id) => ({
      arrivals: arrivalsPanel, 'arrivals-content': arrivals, 'arrivals-stop-name': stopName,
    })[id] ?? null,
  };
  const call = (destination, plannedTime, forecastTime, lineId = 1) => ({
    id: destination, destination, lineId, line: '1',
    departure: { plannedTime, forecastTime },
  });
  const calls = [
    call('Missing', null, '2026-10-13T21:00:00Z'),
    call('Equal', '2026-10-13T22:05:00Z', '2026-10-14T00:20:00+02:00'),
    call('Later', '2026-10-14T00:05:00+02:00', '2026-10-14T00:01:00+02:00'),
    call('Earlier', '2026-10-13T23:55:00+02:00', '2026-10-14T00:15:00+02:00'),
    call('Invalid', 'invalid', '2026-10-13T21:00:00Z'),
    {
      id: 'arrival-only', destination: 'Arrival only', lineId: 1, line: '1',
      arrival: { plannedTime: '2026-10-13T21:50:00Z', forecastTime: '2026-10-13T21:51:00Z' },
    },
    call('Filtered out', '2026-10-13T20:00:00Z', '2026-10-13T20:00:00Z', 2),
  ];
  const sourceOrder = calls.map((item) => item.id);
  const displayedDestinations = () =>
    [...arrivals.innerHTML.matchAll(/class="departure-destination">([^<]+)</g)].map((match) => match[1]);
  try {
    store.set({ selectedStop: { id: 1, text: 'Center (1)' }, calls, activeLineIds: new Set([1]) });
    initUi();
    const expected = ['Arrival only', 'Earlier', 'Equal', 'Later', 'Missing', 'Invalid'];
    assert.deepEqual(displayedDestinations(), expected);
    assert.deepEqual(calls.map((item) => item.id), sourceOrder);

    store.set({ calls: calls.map((item) => item.departure
      ? { ...item, departure: { ...item.departure, forecastTime: '2026-10-14T01:00:00Z' } }
      : item) });
    assert.deepEqual(displayedDestinations(), expected);
    assert.deepEqual(calls.map((item) => item.id), sourceOrder);
  } finally {
    globalThis.document = originalDocument;
  }
});
