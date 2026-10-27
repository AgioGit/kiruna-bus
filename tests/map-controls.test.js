import test from 'node:test';
import assert from 'node:assert/strict';
import { initMapControls } from '../src/js/mapControls.js';
import { initCommuter } from '../src/js/commuter.js';
import { api } from '../src/js/api.js';
import { store } from '../src/js/appState.js';
import { clearSelectedStop } from '../src/js/stops.js';
import { initUi } from '../src/js/ui.js';

function fixture() {
  const elements = new Map();
  const doc = {
    activeElement: null,
    getElementById: (id) => elements.get(id) ?? null,
    createElement: () => new Element(),
    listeners: {},
    addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); },
  };
  class Element {
    constructor(id, parent) {
      this.listeners = {};
      this.children = [];
      this.hidden = false;
      this.disabled = false;
      this.attributes = {};
      const classes = new Set();
      this.classList = {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
      };
      if (id) elements.set(id, this);
      parent?.appendChild(this);
    }
    set textContent(value) { this.text = value; this.children = []; }
    get textContent() { return this.text ?? ''; }
    get childElementCount() { return this.children.length; }
    appendChild(child) { child.parent = this; this.children.push(child); }
    addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
    setAttribute(name, value) { this.attributes[name] = value; }
    getAttribute(name) { return this.attributes[name]; }
    removeAttribute(name) { delete this.attributes[name]; }
    contains(target) { return target === this || this.children.some((child) => child.contains(target)); }
    querySelector() { return this.close; }
    querySelectorAll() { return []; }
    closest(selector) {
      return selector === '.nearby-stop-select' && this.className === 'nearby-stop-select'
        ? this : this.parent?.closest(selector) ?? null;
    }
    focus() { doc.activeElement = this; }
    emit(type, event = {}) {
      event.target ??= this;
      for (const listener of this.listeners[type] ?? []) listener(event);
      this.parent?.emit(type, event);
    }
    click() { if (!this.disabled) this.emit('click'); }
  }
  const controls = new Element('map-controls');
  for (const name of ['lines', 'stops']) {
    const button = new Element(`map-${name}-toggle`, controls);
    button.setAttribute('aria-expanded', 'false');
    const panel = new Element(`map-${name}-panel`, controls);
    panel.hidden = true;
    panel.close = new Element(null, panel);
  }
  const stopsPanel = elements.get('map-stops-panel');
  new Element('stop-search', stopsPanel);
  new Element('stop-search-results', stopsPanel);
  new Element('nearby-stops-button', stopsPanel);
  new Element('nearby-stops-status', stopsPanel).hidden = true;
  new Element('nearby-stops-list', stopsPanel);
  return { doc, elements, Element };
}

test('map tools toggle exclusively, dismiss outside/on Escape, and restore focus', () => {
  const originalDocument = globalThis.document;
  const { doc, elements, Element } = fixture();
  globalThis.document = doc;
  try {
    initMapControls();
    const lines = elements.get('map-lines-toggle');
    const stops = elements.get('map-stops-toggle');
    const linesPanel = elements.get('map-lines-panel');
    const stopsPanel = elements.get('map-stops-panel');
    lines.click();
    assert.equal(linesPanel.hidden, false);
    assert.equal(lines.getAttribute('aria-expanded'), 'true');
    stops.click();
    assert.equal(linesPanel.hidden, true);
    assert.equal(lines.getAttribute('aria-expanded'), 'false');
    assert.equal(stopsPanel.hidden, false);
    stops.click();
    assert.equal(stopsPanel.hidden, true);

    lines.click();
    let prevented = false;
    linesPanel.emit('keydown', { key: 'Escape', preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(linesPanel.hidden, true);
    assert.equal(doc.activeElement, lines);

    stops.click();
    stopsPanel.close.click();
    assert.equal(stopsPanel.hidden, true);
    assert.equal(doc.activeElement, stops);

    lines.click();
    linesPanel.close.focus();
    doc.listeners.pointerdown[0]({ target: new Element() });
    assert.equal(linesPanel.hidden, true);
    assert.equal(doc.activeElement, lines);

    stops.click();
    store.set({ selectedStop: { id: 1, text: 'Center (1)' }, stopSelectionSeq: store.get().stopSelectionSeq + 1 });
    assert.equal(stopsPanel.hidden, true, 'selecting a stop by any method closes the finder');
    assert.equal(doc.activeElement, stops);
  } finally {
    store.set({ selectedStop: null, stopSelectionSeq: store.get().stopSelectionSeq + 1 });
    globalThis.document = originalDocument;
  }
});

test('Near me inside the stop finder requests location explicitly and handles results/errors/clear', async () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalNearby = api.findStopsNearLocation;
  const originalCalls = api.getCalls;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const { doc, elements } = fixture();
  let locationRequests = 0;
  let success;
  let failure;
  globalThis.document = doc;
  globalThis.window = { localStorage: { getItem: () => null } };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { geolocation: { getCurrentPosition(onSuccess, onError) {
      locationRequests++;
      success = onSuccess;
      failure = onError;
    } } },
  });
  globalThis.setInterval = () => 1;
  globalThis.clearInterval = () => {};
  api.getCalls = async () => ({ calls: [] });
  const stops = [{ id: 1, text: 'Center (1)', location: { lat: 67.85, lon: 20.22 } }];
  api.findStopsNearLocation = async () => stops;

  try {
    initMapControls();
    initCommuter();
    const toggle = elements.get('map-stops-toggle');
    const panel = elements.get('map-stops-panel');
    const retry = elements.get('nearby-stops-button');
    const status = elements.get('nearby-stops-status');
    const list = elements.get('nearby-stops-list');
    assert.equal(locationRequests, 0);
    toggle.click();
    assert.equal(locationRequests, 0, 'opening the finder must not request location');
    retry.click();
    assert.equal(locationRequests, 1);
    assert.equal(retry.disabled, true);
    assert.match(status.textContent, /Locating/);
    toggle.click();
    toggle.click();
    assert.equal(locationRequests, 1, 'reopening a pending request must not start another');
    await success({ coords: { latitude: 67.85, longitude: 20.22 } });
    assert.equal(retry.disabled, false);
    assert.equal(status.hidden, true);
    assert.equal(list.childElementCount, 1);
    const pick = list.children[0].children[0];
    assert.equal(pick.textContent, 'Center (0 m)');
    pick.click();
    assert.equal(store.get().selectedStop.id, 1);
    assert.equal(panel.hidden, true);
    toggle.click();
    assert.equal(list.childElementCount, 1);
    assert.equal(locationRequests, 1, 'reopening results must not request location again');

    for (const [code, message] of [[1, /denied/], [2, /could not be determined/], [3, /timed out/]]) {
      retry.click();
      assert.equal(list.childElementCount, 0);
      failure({ code });
      assert.match(status.textContent, message);
      assert.equal(status.hidden, false);
      assert.equal(retry.disabled, false);
    }
    api.findStopsNearLocation = async () => { throw new Error('offline'); };
    retry.click();
    await success({ coords: { latitude: 67.85, longitude: 20.22 } });
    assert.match(status.textContent, /offline/);
    assert.equal(retry.disabled, false);

    api.findStopsNearLocation = async () => [];
    retry.click();
    await success({ coords: { latitude: 67.85, longitude: 20.22 } });
    assert.match(status.textContent, /No stops found/);

    retry.click();
    clearSelectedStop();
    api.findStopsNearLocation = async () => stops;
    await success({ coords: { latitude: 67.85, longitude: 20.22 } });
    assert.equal(list.childElementCount, 0, 'Clear must ignore an in-flight lookup');
    assert.equal(status.hidden, true);
    assert.equal(retry.disabled, false);
    toggle.click();
    toggle.click();
    assert.equal(retry.disabled, false, 'opening after Clear must not request location');
    retry.click();
    assert.equal(retry.disabled, true);
    failure({ code: 1 });

    delete navigator.geolocation;
    retry.click();
    assert.match(status.textContent, /not supported/);
    assert.equal(retry.disabled, false);
    navigator.geolocation = { getCurrentPosition() { throw new Error('blocked by browser'); } };
    retry.click();
    assert.match(status.textContent, /Could not request your location: blocked by browser/);
    assert.equal(retry.disabled, false);
  } finally {
    clearSelectedStop();
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else delete globalThis.navigator;
    api.findStopsNearLocation = originalNearby;
    api.getCalls = originalCalls;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test('Clear stays in departures across refreshes and returns focus to the closed map finder', () => {
  const originalDocument = globalThis.document;
  const { doc, elements, Element } = fixture();
  const arrivals = new Element('arrivals');
  const content = new Element('arrivals-content', arrivals);
  const stopName = new Element('arrivals-stop-name', arrivals);
  const clear = new Element('stop-clear', arrivals);
  globalThis.document = doc;
  try {
    initUi();
    initMapControls();
    const select = () => store.set({
      selectedStop: { id: 1, text: 'Center (1)' },
      stopSelectionSeq: store.get().stopSelectionSeq + 1,
    });
    select();
    assert.equal(arrivals.hidden, false);
    assert.equal(stopName.textContent, 'Center');
    store.set({
      calls: [],
      errors: { ...store.get().errors, calls: 'Previous departure failure', stopNotFound: 'Previous lookup failure' },
    });
    assert.equal(clear.parent, arrivals);
    clear.click();
    assert.equal(store.get().selectedStop, null);
    assert.equal(store.get().errors.calls, null);
    assert.equal(store.get().errors.stopNotFound, null);
    assert.equal(arrivals.hidden, true);
    assert.equal(content.innerHTML, '');
    assert.equal(elements.get('stop-search').value, '');
    assert.equal(doc.activeElement, elements.get('map-stops-toggle'));
    select();
    clear.click();
    assert.equal(arrivals.hidden, true, 'Clear remains wired after selecting another stop');
  } finally {
    globalThis.document = originalDocument;
  }
});

test('line count and filtered styling update without losing keyboard checkbox focus', () => {
  const originalDocument = globalThis.document;
  let inputs = [];
  let filtered = false;
  const summary = {};
  const buttonSummary = { parentElement: { classList: {
    toggle: (name, value) => { if (name === 'map-tool-button--filtered') filtered = value; },
  } } };
  const container = {
    dataset: {},
    contains: (target) => inputs.includes(target),
    querySelectorAll: () => inputs,
    set innerHTML(html) {
      inputs = [...html.matchAll(/data-line-id="(\d+)" (checked)?/g)].map((match) => ({
        dataset: { lineId: match[1] },
        checked: !!match[2],
        addEventListener(type, listener) { this[type] = listener; },
        focus() { document.activeElement = this; },
      }));
    },
  };
  globalThis.document = {
    activeElement: null,
    getElementById: (id) => ({
      'line-filters': container, 'lines-summary': summary, 'lines-button-summary': buttonSummary,
    })[id] ?? null,
  };
  try {
    store.set({ lines: [{ id: 1, text: 'First' }, { id: 2, text: 'Second' }], activeLineIds: new Set([1, 2]),
      lineRoutes: new Map([[1, new Set([11])], [2, new Set([22])]]),
      routeGeometry: new Map([[11, {}], [22, {}]]), serviceView: { active: new Set(), complete: false } });
    initUi();
    assert.equal(buttonSummary.textContent, '2/2');
    assert.equal(filtered, false);
    inputs[0].focus();
    inputs[0].change();
    assert.equal(buttonSummary.textContent, '1/2');
    assert.equal(summary.textContent, '1 of 2 shown');
    assert.equal(filtered, true);
    assert.equal(document.activeElement, inputs[0]);
    assert.equal(inputs[0].checked, false);
    inputs[0].change();
    assert.equal(buttonSummary.textContent, '2/2');
    assert.equal(filtered, false);
    assert.equal(document.activeElement, inputs[0]);
    const previousInputs = inputs;
    store.set({ activeLineIds: new Set([1, 2]) });
    assert.equal(inputs, previousInputs, 'unchanged filters must retain their DOM nodes');
  } finally {
    globalThis.document = originalDocument;
  }
});
