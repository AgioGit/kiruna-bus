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
console.log(`Container smoke passed: ${bootstrap.catalog.lines.length} lines, ${bootstrap.catalog.stops.length} stops, bundled startup and explicit live unavailability.`);
