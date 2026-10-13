import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToNextStop } from '../src/js/routeHeading.js';

const locations = [
  { lat: 67.85, lon: 20.20 },
  { lat: 67.85, lon: 20.21 },
  { lat: 67.86, lon: 20.21 },
  { lat: 67.86, lon: 20.22 },
];
const geometry = { locations };

test('next-stop projection follows only the curved route between bus and stop', () => {
  const position = { lat: 67.85, lon: 20.205 };
  const stop = { lat: 67.855, lon: 20.21 };
  const path = pathToNextStop(position, geometry, stop);
  assert.deepEqual(path[0], [position.lat, position.lon]);
  assert.deepEqual(path.at(-1), [stop.lat, stop.lon]);
  assert.ok(path.some(([lat, lon]) => lat === 67.85 && lon === 20.21));
  assert.ok(path.every(([lat, lon]) => lat <= stop.lat && lon >= position.lon));
  assert.deepEqual(pathToNextStop(stop, geometry, position), [...path].reverse());
});

test('projection handles points on the same segment without extending beyond the stop', () => {
  const path = pathToNextStop(locations[0], geometry, { lat: 67.85, lon: 20.205 });
  assert.ok(path.every(([lat, lon]) => lat === 67.85 && lon <= 20.205));
});

test('projection uses a direct connection before route geometry loads and omits unknown stops', () => {
  const position = locations[0];
  const stop = locations[1];
  assert.deepEqual(pathToNextStop(position, null, stop), [[67.85, 20.20], [67.85, 20.21]]);
  assert.equal(pathToNextStop(position, geometry, null), null);
});
