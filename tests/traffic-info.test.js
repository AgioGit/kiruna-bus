import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrafficPoller, trafficSummary, formatTrafficDate } from '../src/js/traffic-info.js';

const dto = (overrides = {}) => ({ state: 'fresh', trips: [], messages: [], source: 'Lokaltrafiken Kiruna',
  updated: '23:59', ageSec: 20, error: null, ...overrides });
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test('empty failure is unavailable, notices retained then expire while tab is hidden', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  let value, count = 0;
  const poller = createTrafficPoller({ now: Date.now, monotonic: Date.now, random: () => 0,
    publish: (v) => { value = v; }, get: async () => {
      if (++count === 1) return dto({ messages: [{ text: 'Varning', level: 'warning' }], ageSec: 500 });
      throw new Error('offline');
    } });
  poller.resume(); await flush();
  assert.equal(value.state, 'fresh');
  t.mock.timers.tick(60000); await flush();
  assert.equal(value.state, 'retained');
  poller.pause();
  t.mock.timers.tick(50000);
  poller.resume(); await flush();
  assert.equal(value.state, 'unavailable');
  assert.deepEqual(value.messages, []);
  poller.pause();

  count = 0;
  const emptyPoller = createTrafficPoller({ now: Date.now, monotonic: Date.now, random: () => 0,
    publish: (v) => { value = v; }, get: async () => { if (++count === 1) return dto(); throw new Error('offline'); } });
  emptyPoller.resume(); await flush();
  assert.equal(trafficSummary(value), 'No known disruptions');
  t.mock.timers.tick(60000); await flush();
  assert.equal(value.state, 'unavailable');
  emptyPoller.pause();
});

test('expiry timer and invalid response do not reset source age; retry hint honored on resume', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  let value, calls = 0;
  const poller = createTrafficPoller({ now: Date.now, monotonic: Date.now, random: () => 0,
    publish: (v) => { value = v; }, get: async () => {
      calls++;
      if (calls === 1) return dto({ ageSec: 599, messages: [{ text: 'x', level: 'info' }] });
      throw Object.assign(new Error('offline'), { retryAfter: 600000 });
    } });
  poller.resume(); await flush();
  t.mock.timers.tick(1001); await flush();
  assert.equal(value.state, 'unavailable');
  t.mock.timers.tick(59000); await flush();
  assert.equal(calls, 2);
  poller.pause();
  t.mock.timers.tick(300000);
  poller.resume(); await flush();
  assert.equal(calls, 2);
  poller.pause();
});

test('date formatting is Stockholm-safe at midnight and DST', () => {
  assert.equal(formatTrafficDate('2026-10-25'), '25 Oct 2026');
  assert.equal(formatTrafficDate('2026-03-29'), '29 Mar 2026');
  assert.equal(formatTrafficDate('2026-02-31'), '2026-02-31');
});

test('late hidden-tab response is ignored and visible resume fetches again', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  let resolveFirst, value, calls = 0;
  const poller = createTrafficPoller({ now: Date.now, monotonic: Date.now, publish: (v) => { value = v; },
    get: async () => {
      if (++calls === 1) return new Promise((resolve) => { resolveFirst = resolve; });
      return dto({ messages: [{ text: 'new', level: 'info' }] });
    } });
  poller.resume();
  poller.pause();
  poller.resume(); await flush();
  resolveFirst(dto({ messages: [{ text: 'old', level: 'info' }] }));
  await flush();
  assert.equal(calls, 2);
  assert.equal(value.messages[0].text, 'new');
  poller.pause();
});

test('unknown response cannot produce an all-clear', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  let value;
  const poller = createTrafficPoller({ now: Date.now, monotonic: Date.now, publish: (v) => { value = v; },
    get: async () => dto({ trips: [{ type: 'future' }] }) });
  poller.resume(); await flush();
  assert.equal(value.state, 'unavailable');
  poller.pause();
});
