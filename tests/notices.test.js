import test from 'node:test';
import assert from 'node:assert/strict';
import { showNotice } from '../src/js/notices.js';
import { store } from '../src/js/appState.js';
import { initUi } from '../src/js/ui.js';

function element() {
  const classes = new Set();
  return {
    textContent: '', hidden: true,
    classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name) },
  };
}

test('transient notices start fading at ten seconds without extending on unrelated renders', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const notice = element();
  let dismissed = 0;
  showNotice(notice, 'Search failed', { transient: true, onDismiss: () => dismissed++ });
  t.mock.timers.tick(9000);
  showNotice(notice, 'Search failed', { transient: true });
  t.mock.timers.tick(999);
  assert.equal(notice.classList.contains('notice-fading'), false);
  t.mock.timers.tick(1);
  assert.equal(notice.classList.contains('notice-fading'), true);
  assert.equal(notice.hidden, false);
  t.mock.timers.tick(300);
  assert.equal(notice.hidden, true);
  assert.equal(dismissed, 1);
});

test('replacement notices are not dismissed by an old fade timer', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const notice = element();
  let dismissed = 0;
  showNotice(notice, 'First error', { transient: true, onDismiss: () => dismissed++ });
  t.mock.timers.tick(10000);
  showNotice(notice, 'New error', { transient: true });
  t.mock.timers.tick(300);
  assert.equal(notice.textContent, 'New error');
  assert.equal(notice.classList.contains('notice-fading'), false);
  assert.equal(notice.hidden, false);
  assert.equal(dismissed, 0);
  showNotice(notice, '');
  t.mock.timers.tick(10000);
  assert.equal(notice.hidden, true);
});

test('ongoing failures remain visible past the transient timeout', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const notice = element();
  showNotice(notice, 'Live tracking is unavailable');
  t.mock.timers.tick(60000);
  assert.equal(notice.hidden, false);
  assert.equal(notice.classList.contains('notice-fading'), false);
  assert.equal(notice.textContent, 'Live tracking is unavailable');
});

test('routine GPS expiry stays quiet without suppressing refresh failures', () => {
  const originalDocument = globalThis.document;
  const originalState = store.get();
  const children = new Set();
  const banner = {
    hidden: true,
    appendChild(child) { children.delete(child); children.add(child); },
  };
  globalThis.document = {
    getElementById: (id) => id === 'status-banner' ? banner : null,
    createElement: () => {
      const child = element();
      child.remove = () => children.delete(child);
      return child;
    },
  };
  const messages = () => [...children].filter((child) => !child.hidden).map((child) => child.textContent);
  const quality = { state: 'stale', reasons: ['GPS_OLD'], positions: { expired: 1 }, scan: { failed: 0 } };
  try {
    store.set({ catalogInfo: null, liveQuality: quality, serviceView: { active: new Set(), complete: false } });
    initUi();
    assert.deepEqual(messages(), ['Route service is unknown; unverified routes are shown faded.']);
    assert.equal(banner.hidden, false);

    store.set({ serviceView: { active: new Set(), complete: true } });
    assert.deepEqual(messages(), []);
    assert.equal(banner.hidden, true);

    store.set({ liveQuality: { ...quality, positions: { expired: 2 } } });
    assert.deepEqual(messages(), []);
    assert.equal(banner.hidden, true);

    store.set({
      errors: { ...originalState.errors, vehicles: 'Some bus positions could not be refreshed.' },
      liveQuality: { ...quality, reasons: ['POSITION_FAILURE', 'GPS_OLD'] },
    });
    assert.deepEqual(messages(), [
      'vehicles: Some bus positions could not be refreshed.',
      'Live data: stale.',
    ]);

    store.set({
      errors: originalState.errors,
      liveQuality: { ...quality, reasons: ['PARTIAL_SCAN', 'GPS_OLD'], scan: { failed: 2 } },
    });
    assert.deepEqual(messages(), [
      'Live data: stale (2 stops failed to refresh).',
    ]);

    store.set({ liveQuality: { ...quality, state: 'unavailable' } });
    assert.deepEqual(messages(), ['Live data: unavailable.']);

    store.set({ liveQuality: { ...quality, reasons: [] } });
    assert.deepEqual(messages(), ['Live data: stale.']);

    store.set({ liveQuality: { ...quality, reasons: ['POSITIONS_OLD'], positions: { expired: 0 } } });
    assert.deepEqual(messages(), ['Live data: stale.']);

    store.set({ liveQuality: { ...quality, state: 'fresh', reasons: [], positions: { expired: 0 } } });
    assert.deepEqual(messages(), []);
    assert.equal(banner.hidden, true);
  } finally {
    store.set(originalState);
    globalThis.document = originalDocument;
  }
});
