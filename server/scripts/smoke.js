import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const base = process.argv[2];
if (!base) throw new Error('Usage: node scripts/smoke.js http://127.0.0.1:PORT');
let ready = false;
for (let attempt = 0; attempt < 30; attempt++) {
  try { ready = (await fetch(`${base}/api/ready`, { signal: AbortSignal.timeout(1000) })).ok; }
  catch (error) {
    if (attempt === 29) throw error;
  }
  if (ready) break;
  await delay(1000);
}
assert.equal(ready, true, 'container must become ready without Boreal');
assert.match(await (await fetch(base)).text(), /Kiruna Live Bus Tracker/);
const bootstrap = await (await fetch(`${base}/api/v1/bootstrap`)).json();
assert.equal(bootstrap.catalog.schemaVersion, 1);
assert.ok(bootstrap.catalog.lines.length && bootstrap.catalog.stops.length && Object.keys(bootstrap.catalog.routes).length);
assert.equal((await fetch(`${base}/api/live`)).status, 200);
const buses = await fetch(`${base}/api/v1/buses`);
assert.equal(buses.status, 503, 'run this smoke check with Boreal deliberately unavailable');
assert.ok(['WARMING_UP', 'LIVE_UNAVAILABLE'].includes((await buses.json()).error.code));

const controller = new AbortController();
try {
  const stream = await fetch(`${base}/api/v1/stream`, {
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
  });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type'), /^text\/event-stream/);
  assert.match(stream.headers.get('cache-control'), /no-transform/);
  assert.equal(stream.headers.get('x-accel-buffering'), 'no');
  const decoder = new TextDecoder();
  let buffer = '';
  let received = false;
  for await (const chunk of stream.body) {
    buffer += decoder.decode(chunk, { stream: true });
    assert.ok(buffer.length < 65536, 'initial stream status must be bounded');
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop();
    for (const block of blocks) {
      if (!/^event: tracking-status$/m.test(block)) continue;
      const data = JSON.parse(block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n'));
      assert.ok(['WARMING_UP', 'LIVE_UNAVAILABLE'].includes(data.error.code));
      assert.equal(typeof data.epoch, 'string');
      assert.ok(Number.isSafeInteger(data.revision) && data.revision >= 0);
      assert.equal(typeof data.catalogVersion, 'string');
      assert.equal(data.quality.state, 'unavailable');
      received = true;
      break;
    }
    if (received) break;
  }
  assert.equal(received, true, 'cold stream must report unavailable tracking without waiting for Boreal');
} finally {
  controller.abort();
}
console.log(`Container smoke passed: ${bootstrap.catalog.lines.length} lines, ${bootstrap.catalog.stops.length} stops, bundled startup, explicit live unavailability, and immediate SSE status.`);
