import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { createApplication } from '../app.js';
import { createUpstreamDebug } from '../lib/upstreamDebug.js';
import { createBoreal } from '../lib/boreal.js';
import { createTrafficInfo } from '../lib/trafficInfo.js';
import { loadConfig } from '../lib/config.js';
import { createTelemetry } from '../lib/telemetry.js';
import { validate } from '../lib/validation.js';

const quiet = () => createTelemetry({ write() {} });
const settings = loadConfig({});

function pair(debug, body = '{"calls":[]}') {
  const trace = debug.start({ provider: 'boreal', url: 'https://example.test/GetCalls', method: 'POST', body: '{"query":"Town"}' });
  trace.response(new Response(body, { headers: { 'content-type': 'application/json' } }));
  trace.chunk(Buffer.from(body));
  trace.complete();
  trace.finish();
  return trace;
}

test('capture redacts recognized credentials and preserves paired JSON, headers and timing', () => {
  let time = 10;
  const debug = createUpstreamDebug({ now: () => 0, monotonic: () => time });
  const trace = debug.start({
    provider: 'boreal', url: 'https://example.test/GetCalls?token=private&callId=abc',
    method: 'POST', headers: { Authorization: 'secret', 'content-type': 'application/json' },
    body: '{"query":"Town","nested":{"accessToken":"private"}}',
  });
  trace.response(new Response('', { status: 201, headers: { 'set-cookie': 'private', 'content-type': 'application/json' } }));
  trace.chunk(Buffer.from('{"calls":[],"password":"private"}'));
  trace.complete();
  time = 35;
  trace.finish();
  trace.finish();
  const snapshot = validate('upstreamDebug', debug.snapshot());
  assert.equal(snapshot.entries.length, 1);
  const entry = snapshot.entries[0];
  assert.equal(entry.durationMs, 25);
  assert.equal(entry.request.method, 'POST');
  assert.equal(entry.request.headers.authorization, '[redacted]');
  assert.deepEqual(entry.request.body, { query: 'Town', nested: { accessToken: '[redacted]' } });
  assert.equal(new URL(entry.request.url).searchParams.get('token'), '[redacted]');
  assert.equal(new URL(entry.request.url).searchParams.get('callId'), 'abc');
  assert.deepEqual(entry.response.body, { calls: [], password: '[redacted]' });
  assert.equal(entry.response.headers['set-cookie'], '[redacted]');
  assert.equal(entry.response.bodyTruncated, false);
  assert.equal(entry.error, null);
});

test('entry count, serialized bytes and bodies are bounded with explicit truncation and dropped counts', () => {
  const debug = createUpstreamDebug();
  for (let i = 0; i < 101; i++) pair(debug);
  assert.equal(debug.snapshot().entries.length, 100);
  assert.equal(debug.snapshot().dropped, 1);
  debug.clear();
  for (let i = 0; i < 80; i++) pair(debug, JSON.stringify({ text: 'x'.repeat(50000) }));
  const snapshot = debug.snapshot();
  assert.ok(snapshot.dropped > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot.entries)) <= 2 * 1024 * 1024);
  debug.clear();
  pair(debug, 'x'.repeat(100000));
  const entry = debug.snapshot().entries[0];
  assert.equal(Buffer.byteLength(entry.response.body), 64 * 1024);
  assert.equal(entry.response.bodyTruncated, true);
  debug.close();
  pair(debug);
  assert.equal(debug.snapshot().entries.length, 0);
});

test('both adapters capture actual network attempts, not cache hits or coalesced readers', async () => {
  const debug = createUpstreamDebug();
  let calls = 0;
  const api = createBoreal({ settings, telemetry: quiet(), upstreamDebug: debug,
    fetchImpl: async () => { calls++; return Response.json({ calls: [], messages: [] }); } });
  const traffic = createTrafficInfo({ upstreamDebug: debug, fetcher: async () => {
    calls++;
    return Response.json({ turer: [], meddelanden: [], uppdaterad: '08:16', ageSec: 1 });
  } });
  try {
    await Promise.all([api.getCalls('Town'), api.getCalls('Town')]);
    await api.getCalls('Town');
    await Promise.all([traffic.get(), traffic.get()]);
    await traffic.get();
    assert.equal(calls, 2);
    const snapshot = validate('upstreamDebug', debug.snapshot());
    assert.equal(snapshot.entries.length, 2);
    const [boreal, lokal] = snapshot.entries;
    assert.equal(boreal.call, 'GetCalls');
    assert.equal(boreal.request.body.query.fromStopAreaQuery, 'Town');
    assert.equal(boreal.request.headers['anyride-profile-data'], 'boreal_kiruna');
    assert.deepEqual(boreal.response.body.calls, []);
    assert.equal(lokal.call, 'trafikinfo');
    assert.equal(lokal.provider, 'lokaltrafiken');
    assert.equal(lokal.request.headers['anyride-profile-data'], undefined);
    assert.equal(lokal.response.body.ageSec, 1);
  } finally { api.close(); traffic.close(); }
});

test('HTTP retry bodies, invalid JSON and network failures remain visible without changing adapter results', async () => {
  const debug = createUpstreamDebug();
  let calls = 0;
  const api = createBoreal({ settings, telemetry: quiet(), upstreamDebug: debug, fetchImpl: async () => {
    calls++;
    return calls === 1 ? Response.json({ reason: 'busy' }, { status: 503 }) : Response.json({ calls: [] });
  } });
  try {
    assert.deepEqual(await api.getCalls('Town'), { calls: [] });
    assert.equal(debug.snapshot().entries.length, 2);
    assert.equal(debug.snapshot().entries[0].response.status, 503);
    assert.deepEqual(debug.snapshot().entries[0].response.body, { reason: 'busy' });
    assert.equal(debug.snapshot().entries[0].response.bodyTruncated, false);
    assert.equal(debug.snapshot().entries[0].error.code, 'UPSTREAM_UNAVAILABLE');
  } finally { api.close(); }
  const invalid = createBoreal({ settings, telemetry: quiet(), upstreamDebug: debug, fetchImpl: async () => new Response('not json') });
  try {
    await assert.rejects(invalid.getCalls('Town'), { code: 'UPSTREAM_SCHEMA' });
    const entry = debug.snapshot().entries.at(-1);
    assert.equal(entry.response.body, 'not json');
    assert.equal(entry.response.bodyTruncated, false);
    assert.equal(entry.error.code, 'UPSTREAM_SCHEMA');
  } finally { invalid.close(); }
  const traffic = createTrafficInfo({ upstreamDebug: debug, fetcher: async () => { throw new TypeError('offline'); } });
  try {
    assert.equal((await traffic.get()).data.state, 'unavailable');
    assert.equal(debug.snapshot().entries.at(-1).response, null);
    assert.equal(debug.snapshot().entries.at(-1).error.code, 'TypeError');
  } finally { traffic.close(); }
});

test('partial response bodies and timeout failures are captured', async () => {
  const debug = createUpstreamDebug();
  const traffic = createTrafficInfo({ upstreamDebug: debug, fetcher: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(Buffer.from('{"ageSec":')); },
    pull(controller) { controller.error(new Error('interrupted body')); },
  })) });
  try {
    assert.equal((await traffic.get()).data.state, 'unavailable');
    assert.equal(debug.snapshot().entries[0].response.body, '{"ageSec":');
    assert.equal(debug.snapshot().entries[0].response.bodyTruncated, true);
  } finally { traffic.close(); }
  const timeout = createTrafficInfo({ upstreamDebug: debug, timeoutMs: 5, fetcher: async (_, { signal }) =>
    new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) });
  try {
    assert.equal((await timeout.get()).data.state, 'unavailable');
    assert.equal(debug.snapshot().entries.at(-1).response, null);
    assert.equal(debug.snapshot().entries.at(-1).error.code, 'AbortError');
  } finally { timeout.close(); }
});

test('local debug is opt-in and rejected for public bindings, production or trusted proxies', () => {
  assert.equal(loadConfig({}).localDebug, false);
  assert.equal(loadConfig({ HOST: '127.0.0.1', LOCAL_DEBUG: 'true' }).localDebug, true);
  for (const env of [
    { LOCAL_DEBUG: 'true' }, { LOCAL_DEBUG: 'yes' },
    { LOCAL_DEBUG: 'true', HOST: '127.0.0.1', NODE_ENV: 'production' },
    { LOCAL_DEBUG: 'true', HOST: '127.0.0.1', TRUST_PROXY: 'true' },
  ]) assert.throws(() => loadConfig(env), /LOCAL_DEBUG/);
});

test('debug API is local-only, disabled by default, non-cacheable and never activates collection', async (t) => {
  async function serve(localDebug) {
    const app = createApplication({ settings: loadConfig({ HOST: '127.0.0.1', LOCAL_DEBUG: String(localDebug) }), telemetry: quiet() });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    t.after(async () => { app.shutdown(); app.server.closeAllConnections(); await new Promise((resolve) => app.server.close(resolve)); });
    return { app, url: `http://127.0.0.1:${app.server.address().port}/api/v1/debug/upstream` };
  }
  const disabled = await serve(false);
  assert.equal((await fetch(disabled.url)).status, 404);
  const { app, url } = await serve(true);
  pair(app.upstreamDebug);
  const result = await fetch(url);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(validate('upstreamDebug', await result.json()).entries.length, 1);
  assert.equal((await fetch(url, { headers: { origin: 'https://mhedqvist.github.io' } })).status, 403);
  const foreignHostStatus = await new Promise((resolve, reject) => {
    http.get(url, { headers: { host: 'attacker.example' } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal((await fetch(url, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await fetch(`${url}?call=GetCalls`)).status, 400);
  assert.equal((await fetch(url, { method: 'POST' })).status, 405);
  assert.equal(app.collector.isActive(), false);
  assert.equal(app.api.status().active, 0);
  app.shutdown();
  assert.equal(app.upstreamDebug.snapshot().entries.length, 0);
});
