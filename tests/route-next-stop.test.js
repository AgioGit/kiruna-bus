import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToNextStop, pathToUpcomingStops } from '../src/js/routeHeading.js';

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

test('preview follows three upcoming stops in either route direction without reaching the fourth', () => {
  const position = { lat: 67.85, lon: 20.205 };
  const stops = [locations[1], { lat: 67.855, lon: 20.21 }, locations[2], locations[3]];
  const path = pathToUpcomingStops(position, geometry, stops);
  assert.deepEqual(path[0], [position.lat, position.lon]);
  assert.deepEqual(path.at(-1), [locations[2].lat, locations[2].lon]);
  assert.ok(path.some(([lat, lon]) => lat === 67.855 && lon === 20.21));
  assert.ok(path.every(([, lon]) => lon <= locations[2].lon));
  assert.deepEqual(pathToUpcomingStops(position, { locations: [...locations].reverse() }, stops), path);
  const backward = pathToUpcomingStops(locations[3], geometry, [locations[2], stops[1], locations[1]]);
  assert.deepEqual(backward.at(-1), [locations[1].lat, locations[1].lon]);
});

test('preview handles fewer or unlocated stops and missing route geometry', () => {
  const position = locations[0];
  assert.deepEqual(pathToUpcomingStops(position, null, [locations[1], locations[2]]),
    [[position.lat, position.lon], [locations[1].lat, locations[1].lon], [locations[2].lat, locations[2].lon]]);
  assert.deepEqual(pathToUpcomingStops(position, geometry, [null, locations[1]]),
    pathToNextStop(position, geometry, locations[1]));
  assert.equal(pathToUpcomingStops(position, geometry, [null, null, null, locations[3]]), null);
  assert.equal(pathToUpcomingStops(position, geometry, []), null);
});
