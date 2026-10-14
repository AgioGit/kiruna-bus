import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners, setMaxListeners } from 'node:events';
import { withSignal, runPooled } from '../lib/pool.js';

test('completed and cancelled waits remove all abort listeners', async () => {
  const controller = new AbortController();
  setMaxListeners(32, controller.signal);
  await runPooled(Array.from({ length: 20 }, (_, index) => index), 8, async (value) => value, { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  const pending = withSignal(new Promise(() => {}), controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await assert.rejects(withSignal(Promise.reject(new Error('late failure')), controller.signal), { name: 'AbortError' });
});
