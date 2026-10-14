import test from 'node:test';
import assert from 'node:assert/strict';
import { showNotice } from '../src/js/notices.js';

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
