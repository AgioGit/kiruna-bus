import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrafficInfo, normalizeTraffic } from '../lib/trafficInfo.js';
import { validate } from '../lib/validation.js';
import { loadConfig } from '../lib/config.js';

const empty = () => ({ turer: [], meddelanden: [], uppdaterad: '23:59', ageSec: 20 });
const response = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

test('synthetic renderer contract normalizes all trip types and messages', () => {
  const input = {
    ...empty(), turer: ['installd', 'ingen_realtid', 'forsenad', 'andrad_rutt', 'aater'].map((typ) => ({
      typ, tur: 123, linje: 'Röd', mot: 'Centrum', datum: '2026-10-25', tid: '00:01', min: '7', extra: 'ignored',
    })), meddelanden: [{ text: '<img src=x>', niva: 'info' }, { text: 'Varning', niva: 'varning' }],
  };
  const result = normalizeTraffic(input);
  assert.deepEqual(result.trips.map((item) => item.type), ['cancelled', 'no_realtime', 'delayed', 'route_changed', 'back_in_service']);
  assert.equal(result.trips[4].delayMinutes, 7);
  assert.deepEqual(result.messages.map((item) => item.level), ['info', 'warning']);
  assert.equal(result.messages[0].text, '<img src=x>');
  assert.equal(normalizeTraffic({ ...empty(), turer: [{ typ: 'installd' }] }).trips[0].line, null);
});

test('invalid age, unknown or malformed entries never produce a successful empty result', () => {
  for (const bad of [
    { ...empty(), ageSec: -1 }, { ...empty(), ageSec: undefined }, { ...empty(), ageSec: '1' },
    { ...empty(), ageSec: Infinity }, { ...empty(), turer: [{ typ: 'unknown' }] },
    { ...empty(), turer: [null] }, { ...empty(), meddelanden: [{ text: 'x', niva: 'new' }] },
    { ...empty(), meddelanden: [{}] },
  ]) assert.throws(() => normalizeTraffic(bad));
});

test('single flight, shared cache, age, failure backoff and expiration', async () => {
  let time = 100000, count = 0, release;
  const input = { ...empty(), turer: [{ typ: 'installd', linje: '1' }] };
  const traffic = createTrafficInfo({ now: () => time, fetcher: async (url, opts) => {
    count++;
    assert.equal(url, 'https://lokaltrafikenkiruna.se/wp-json/boreal/v1/trafikinfo');
    assert.deepEqual(Object.keys(opts).sort(), ['cache', 'redirect', 'signal']);
    if (count === 1) { await new Promise((resolve) => { release = resolve; }); return response(input); }
    return new Response('fail', { status: 503, headers: { 'retry-after': '180' } });
  } });
  const a = traffic.get(), b = traffic.get();
  assert.equal(count, 1);
  time += 1000;
  release();
  const [first, second] = await Promise.all([a, b]);
  assert.equal(first.data.ageSec, 21);
  assert.deepEqual(first, second);
  validate('trafficInfo', first.data);
  time += 30000;
  assert.equal((await traffic.get()).data.ageSec, 51);
  assert.equal(count, 1);
  time += 30000;
  const failed = await traffic.get();
  assert.equal(failed.data.state, 'retained');
  assert.equal(failed.retryAfter, 180);
  assert.equal(failed.data.trips.length, 1);
  time += 120000;
  assert.equal((await traffic.get()).data.state, 'retained');
  assert.equal(count, 2);
  time += 400000;
  const expired = await traffic.get();
  assert.equal(expired.data.state, 'unavailable');
  assert.deepEqual(expired.data.trips, []);
  assert.ok(expired.data.ageSec > 600);
  traffic.close();
});

test('empty last good stops reassuring on failed or invalid refresh; cold failure unavailable', async () => {
  let time = 0, count = 0;
  const client = createTrafficInfo({ now: () => time, fetcher: async () => {
    if (++count === 1) return response(empty());
    return response({ ...empty(), turer: [{ typ: 'future_type' }] });
  } });
  assert.equal((await client.get()).data.state, 'fresh');
  time += 60000;
  const failed = await client.get();
  assert.equal(failed.data.state, 'unavailable');
  assert.equal(failed.data.error.code, 'REFRESH_FAILED');
  client.close();
  const cold = createTrafficInfo({ fetcher: async () => { throw new Error('offline'); } });
  assert.equal((await cold.get()).data.state, 'unavailable');
  cold.close();
});

test('age never decreases on clock rollback and stale upstream data cannot be an all-clear', async () => {
  let wall = 100000, tick = 0;
  const client = createTrafficInfo({ now: () => wall, monotonic: () => tick, fetcher: async () => response(empty()) });
  assert.equal((await client.get()).data.ageSec, 20);
  wall += 10000; tick += 10000;
  assert.equal((await client.get()).data.ageSec, 30);
  wall -= 5000; tick += 1000;
  assert.equal((await client.get()).data.ageSec, 31);
  client.close();
  const stale = createTrafficInfo({ fetcher: async () => response({ ...empty(), ageSec: 601 }) });
  assert.equal((await stale.get()).data.state, 'unavailable');
  stale.close();
});

test('oversized response is rejected; shutdown aborts an in-flight fetch', async () => {
  const huge = createTrafficInfo({ fetcher: async () => new Response('x'.repeat(262145)) });
  assert.equal((await huge.get()).data.state, 'unavailable');
  huge.close();
  let signal;
  const client = createTrafficInfo({ fetcher: async (_url, opts) => {
    signal = opts.signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } });
  const pending = client.get();
  client.close();
  await pending;
  assert.equal(signal.aborted, true);
});

test('deadline aborts a blocked source fetch', async () => {
  let aborted = false;
  const client = createTrafficInfo({ timeoutMs: 20, fetcher: async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
  }) });
  assert.equal((await client.get()).data.state, 'unavailable');
  assert.equal(aborted, true);
  client.close();
});

test('fixture origin is limited to loopback and official origin', () => {
  assert.equal(loadConfig({ TRAFFIC_INFO_ORIGIN: 'http://127.0.0.1:1234' }).trafficInfoOrigin, 'http://127.0.0.1:1234');
  for (const origin of ['https://example.com', 'http://localhost:3/path', 'http://user:pass@localhost']) {
    assert.throws(() => loadConfig({ TRAFFIC_INFO_ORIGIN: origin }));
  }
});
