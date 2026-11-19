import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createBoreal } from '../lib/boreal.js';
import { createScheduler } from '../lib/scheduler.js';
import { createTelemetry } from '../lib/telemetry.js';
import { loadConfig } from '../lib/config.js';
import { TtlCache } from '../lib/cache.js';

const quiet = () => createTelemetry({ write() {} });
const settings = loadConfig({});

test('scheduler reserves capacity for interactive work and bounds the queue', async () => {
  const scheduler = createScheduler({ concurrency: 2, maxQueue: 1 });
  let release;
  const started = [];
  const first = scheduler.run(() => new Promise((resolve) => { release = resolve; started.push('first'); }), { priority: 'background' });
  await Promise.resolve();
  const queued = scheduler.run(() => { started.push('queued'); }, { priority: 'background' });
  await assert.rejects(scheduler.run(async () => {}, { priority: 'background' }), { code: 'UPSTREAM_BUSY' });
  release();
  await Promise.all([first, queued]);
  const second = scheduler.run(() => new Promise((resolve) => { release = resolve; }), { priority: 'background' });
  await Promise.resolve();
  await scheduler.run(() => { started.push('interactive'); });
  assert.equal(scheduler.status().active, 1);
  release();
  await second;
  scheduler.close();
  assert.deepEqual(started, ['first', 'queued', 'interactive']);
});

test('queue deadlines and cancellation remove pending work', async () => {
  const scheduler = createScheduler({ concurrency: 2, maxQueue: 10, queueMs: 10 });
  let release;
  const first = scheduler.run(() => new Promise((resolve) => { release = resolve; }), { priority: 'background' });
  await Promise.resolve();
  await assert.rejects(scheduler.run(async () => {}, { priority: 'background' }), { code: 'UPSTREAM_QUEUE_TIMEOUT' });
  const controller = new AbortController();
  const queued = scheduler.run(async () => {}, { priority: 'background', signal: controller.signal });
  controller.abort();
  await assert.rejects(queued, { name: 'AbortError' });
  release();
  await first;
  scheduler.close();
  assert.equal(scheduler.status().queued, 0);
});

test('lower priority callers share an existing collector flight; invalid data never enters the cache', async () => {
  let calls = 0;
  let valid = false;
  const api = createBoreal({ settings, telemetry: quiet(), fetchImpl: async () => {
    calls++;
    return Response.json(valid ? { calls: [] } : { wrong: true });
  } });
  await assert.rejects(api.getCalls('Town'), { code: 'UPSTREAM_SCHEMA' });
  valid = true;
  const results = await Promise.all([api.getCalls('Town'), api.getCalls('Town', { priority: 'public' })]);
  assert.equal(calls, 2);
  assert.deepEqual(results[0], { calls: [] });
  await api.getCalls('Town');
  assert.equal(calls, 2);
  api.close();
});

test('queued public work cannot block a collector request for the same key', async () => {
  let release;
  const api = createBoreal({
    settings: { ...settings, upstreamConcurrency: 2, upstreamQueueSize: 2 }, telemetry: quiet(),
    fetchImpl: async (url) => {
      if (url.endsWith('/GetLines')) await new Promise((resolve) => { release = resolve; });
      return Response.json(url.endsWith('/GetLines') ? [{ id: 1, text: 'Town' }] : { calls: [] });
    },
  });
  const hold = api.getLines({ priority: 'public' });
  try {
    const queued = api.getCalls('Town', { priority: 'public' });
    await assert.rejects(api.getCalls('Other', { priority: 'public' }), { code: 'UPSTREAM_BUSY' });
    assert.deepEqual(await api.getCalls('Town', { fresh: true }), { calls: [] });
    release();
    await Promise.all([hold, queued]);
  } finally { api.close(); }
});

test('unexpected provider redirects do not get followed or retried', async () => {
  let requests = 0;
  const api = createBoreal({ settings, telemetry: quiet(), fetchImpl: async (_, options) => {
    requests++;
    assert.equal(options.redirect, 'manual');
    return new Response(null, { status: 302, headers: { location: 'https://example.test/other' } });
  } });
  try {
    await assert.rejects(api.getLines(), { code: 'UPSTREAM_REDIRECT' });
    assert.equal(requests, 1);
  } finally { api.close(); }
});

test('one cancelled waiter does not cancel shared upstream work', async () => {
  let release;
  const api = createBoreal({ settings, telemetry: quiet(), fetchImpl: () => new Promise((resolve) => { release = resolve; }) });
  const controller = new AbortController();
  const first = api.getCalls('Town', { signal: controller.signal });
  const second = api.getCalls('Town');
  await Promise.resolve();
  controller.abort();
  await assert.rejects(first, { name: 'AbortError' });
  release(Response.json({ calls: [] }));
  assert.deepEqual(await second, { calls: [] });
  api.close();
});

test('upstream body stalls time out, permanent errors are not retried, and size is bounded', async (t) => {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('[');
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  const api = createBoreal({ settings: { ...settings, borealBase: `http://127.0.0.1:${server.address().port}`, upstreamTimeoutMs: 20 }, telemetry: quiet() });
  await assert.rejects(api.getLines(), { code: 'UPSTREAM_TIMEOUT' });
  api.close();
  let calls = 0;
  const permanent = createBoreal({ settings, telemetry: quiet(), fetchImpl: async () => { calls++; return new Response('{}', { status: 400 }); } });
  await assert.rejects(permanent.getLines(), { code: 'UPSTREAM_REJECTED' });
  assert.equal(calls, 1);
  permanent.close();
  const large = createBoreal({ settings: { ...settings, upstreamMaxBytes: 8 }, telemetry: quiet(), fetchImpl: async () => Response.json([{ id: 1, text: 'Town' }]) });
  await assert.rejects(large.getLines(), { code: 'UPSTREAM_SIZE' });
  large.close();
});

test('cache respects byte bounds as well as entry count', () => {
  const cache = new TtlCache({ maxBytes: 10 });
  cache.set('a', '12345', 1000);
  cache.set('b', '67890', 1000);
  assert.equal(cache.get('a'), undefined);
  assert.ok(cache.bytes <= 10);
});

test('whole-operation timeout during Retry-After remains a structured upstream failure', async () => {
  const telemetry = quiet();
  let requests = 0;
  const api = createBoreal({
    settings: { ...settings, upstreamTimeoutMs: 10 }, telemetry,
    fetchImpl: async () => {
      requests++;
      return new Response('', { status: 429, headers: { 'retry-after': '5' } });
    },
  });
  try {
    await assert.rejects(api.getLines(), { code: 'UPSTREAM_TIMEOUT', status: 504 });
    assert.equal(requests, 1);
    assert.equal(telemetry.snapshot().counters.upstreamTimeouts, 1);
    assert.equal(api.status().active, 0);
  } finally { api.close(); }
});

test('invalid provider configuration is rejected before caching while extra fields are permitted', async () => {
  let calls = 0;
  const config = { minZoom: 10, tiles: { urlTemplate: 'https://example.test/{z}/{x}/{y}.png', extra: true }, extra: true };
  const api = createBoreal({
    settings, telemetry: quiet(),
    fetchImpl: async () => Response.json(++calls === 1 ? { ...config, minZoom: 'wrong' } : config),
  });
  try {
    await assert.rejects(api.getConfig(), { code: 'UPSTREAM_SCHEMA' });
    assert.deepEqual(await api.getConfig(), config);
    await api.getConfig();
    assert.equal(calls, 2);
  } finally { api.close(); }
});

test('scheduled fresh checks bypass a valid static cache while ordinary readers reuse it', async () => {
  let calls = 0;
  const api = createBoreal({ settings, telemetry: quiet(), fetchImpl: async () =>
    Response.json([{ id: 1, text: `Line ${++calls}` }]) });
  try {
    assert.equal((await api.getLines())[0].text, 'Line 1');
    assert.equal((await api.getLines())[0].text, 'Line 1');
    assert.equal((await api.getLines({ fresh: true }))[0].text, 'Line 2');
    assert.equal((await api.getLines())[0].text, 'Line 2');
    assert.equal(calls, 2);
  } finally { api.close(); }
});
