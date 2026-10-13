import test from 'node:test';
import assert from 'node:assert/strict';
import { store } from '../src/js/appState.js';
import { initUi } from '../src/js/ui.js';

test('selected bus without more stops renders and refreshes without a disclosure', () => {
  const originalDocument = globalThis.document;
  let focusCount = 0;
  const container = {
    innerHTML: '',
    addEventListener() {},
    contains: () => true,
    querySelector: () => null,
    querySelectorAll: () => [],
    focus: () => { focusCount++; },
  };
  globalThis.document = {
    activeElement: {
      closest: (selector) => selector === 'button[data-journey-id]'
        ? { dataset: { journeyId: '42' } }
        : null,
    },
    getElementById: (id) => id === 'live-buses' ? container : null,
  };

  try {
    const time = '2026-09-25T12:00:00Z';
    const bus = {
      journeyId: 42,
      lineId: 1,
      line: '1',
      destination: 'Kiruna',
      ageMs: 0,
      nextStop: { stopText: 'Center (1)', plannedTime: time, forecastTime: time },
      position: { timestamp: time },
    };
    store.set({
      activeLineIds: new Set([1]),
      liveVehicles: [bus],
      selectedVehicleJourneyId: 42,
      journeyStops: new Map([[42, [bus.nextStop]]]),
    });
    initUi();
    assert.match(container.innerHTML, /vehicle-card--expanded/);
    assert.match(container.innerHTML, /class="vehicle-trip"/);
    assert.doesNotMatch(container.innerHTML, /class="trip-more"/);

    store.set({ liveVehicles: [{ ...bus, ageMs: 1 }] });
    assert.match(container.innerHTML, /class="vehicle-trip"/);
    assert.ok(focusCount > 0);

    store.set({ selectedVehicleJourneyId: null });
    assert.doesNotMatch(container.innerHTML, /class="vehicle-trip"/);
  } finally {
    globalThis.document = originalDocument;
  }
});

test('late ETAs have an inline minute difference on bus, trip and departure cards', () => {
  const originalDocument = globalThis.document;
  const container = {
    innerHTML: '', hidden: false,
    addEventListener() {},
    contains: () => false,
    querySelector: () => null,
  };
  const arrivals = { innerHTML: '', hidden: false };
  globalThis.document = {
    activeElement: null,
    getElementById: (id) => id === 'live-buses' ? container : id === 'arrivals' ? arrivals : null,
  };
  try {
    const plannedTime = '2026-09-25T23:58:00+02:00';
    const forecastTime = '2026-09-26T00:01:00+02:00';
    const nextStop = { stopText: 'Center (1)', plannedTime, forecastTime };
    const bus = {
      journeyId: 42, lineId: 1, line: '1', destination: 'Kiruna', ageMs: 0,
      nextStop, position: { timestamp: plannedTime },
    };
    store.set({
      activeLineIds: new Set([1]), liveVehicles: [bus], selectedVehicleJourneyId: 42,
      journeyStops: new Map([[42, [nextStop]]]),
      selectedStop: { id: 1, text: 'Center (1)' },
      calls: [{ id: '1', lineId: 1, line: '1', destination: 'Kiruna', departure: nextStop }],
    });
    initUi();
    assert.equal([...container.innerHTML.matchAll(/00:01<span class="eta-delay">\(\+3 min\)<\/span>/g)].length, 2);
    assert.match(arrivals.innerHTML, /00:01<span class="eta-delay">\(\+3 min\)<\/span>/);

    for (const forecast of [plannedTime, '2026-09-25T23:57:00+02:00', 'invalid', null]) {
      store.set({ liveVehicles: [{ ...bus, nextStop: { ...nextStop, forecastTime: forecast } }],
        journeyStops: new Map(), selectedVehicleJourneyId: null });
      assert.doesNotMatch(container.innerHTML, /class="eta-delay"/);
    }
    store.set({ liveVehicles: [{ ...bus, nextStop: {
      ...nextStop, forecastTime: '2026-09-25T23:58:20+02:00',
    } }] });
    assert.match(container.innerHTML, /class="eta-delay">\(\+1 min\)/);

    store.set({ liveVehicles: [{ ...bus, ageMs: 180_001 }], selectedVehicleJourneyId: 42 });
    assert.doesNotMatch(container.innerHTML, /class="vehicle-card/);
  } finally {
    globalThis.document = originalDocument;
  }
});
