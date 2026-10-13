import test from 'node:test';
import assert from 'node:assert/strict';
import { markerPositionOnRoute, offsetRoutePath, renderedRouteLocations } from '../src/js/routeOffset.js';
import { routePartsForVisibleRoutes } from '../src/js/routeOverlap.js';
import { pathToNextStop } from '../src/js/routeHeading.js';

function testMap(zoom = 1) {
  return {
    getZoom() { return zoom; },
    project([lat, lon], level) { return { x: lon * level * 100, y: lat * level * 100 }; },
    unproject([x, y], level) { return { lat: y / (level * 100), lng: x / (level * 100) }; },
    distance([lat1, lon1], [lat2, lon2]) { return Math.hypot(lat2 - lat1, lon2 - lon1) * 1000; },
  };
}

test('shared lanes have a fixed pixel gap and join the original path at both ends', () => {
  const path = [[0, 0], [0, 1]];
  const left = offsetRoutePath(path, -2.5, testMap());
  const right = offsetRoutePath(path, 2.5, testMap());
  assert.deepEqual(left[0], path[0]);
  assert.deepEqual(left.at(-1), path.at(-1));
  assert.deepEqual(right[0], path[0]);
  assert.deepEqual(right.at(-1), path.at(-1));
  assert.equal(left[1][0], -0.025);
  assert.equal(right[1][0], 0.025);
  assert.equal((right[1][0] - left[1][0]) * 100, 5);
  assert.equal(offsetRoutePath(path, 0, testMap()), path);
  const zoomed = offsetRoutePath(path, 2.5, testMap(2));
  assert.equal(zoomed[1][0], 0.0125);
  assert.equal(zoomed[1][0] * 200, 2.5);
});

test('offsets taper even on a short stretch and avoid corner spikes', () => {
  const short = [[0, 0], [0, 0.1]];
  const shifted = offsetRoutePath(short, 5, testMap());
  assert.deepEqual(shifted[0], short[0]);
  assert.deepEqual(shifted.at(-1), short.at(-1));
  assert.equal(shifted[1][0], 0.05);

  const corner = offsetRoutePath([[0, 0], [0, 1], [1, 1]], 5, testMap());
  const turn = corner.find((point) => point[1] > 0.9 && point[0] < 1);
  assert.ok(turn.every(Number.isFinite));
  assert.ok(Math.hypot(turn[0], turn[1] - 1) < 0.1);
});

test('nearby buses follow their own lane, but unshared and off-route buses keep GPS positions', () => {
  const map = testMap();
  const shared = [[0, 0], [0, 1]];
  const parts = [{ shared: true, paths: [shared] }];
  const rendered = [[offsetRoutePath(shared, 2.5, map)]];
  assert.deepEqual(markerPositionOnRoute({ lat: 0, lon: 0.5 }, parts, rendered, map), [0.025, 0.5]);
  assert.deepEqual(markerPositionOnRoute({ lat: 0, lon: 0 }, parts, rendered, map), [0, 0]);
  assert.equal(markerPositionOnRoute({ lat: 0.1, lon: 0.5 }, parts, rendered, map), null);

  parts.push({ shared: false, paths: [[[0.01, 0], [0.01, 1]]] });
  rendered.push(parts[1].paths);
  assert.equal(markerPositionOnRoute({ lat: 0.01, lon: 0.5 }, parts, rendered, map), null);

  const zoomedMap = testMap(2);
  assert.deepEqual(
    markerPositionOnRoute({ lat: 0, lon: 0.5 }, [parts[0]], [[offsetRoutePath(shared, 2.5, zoomedMap)]], zoomedMap),
    [0.0125, 0.5]
  );
});

test('next-stop dots use the rendered lane and follow its taper through shared and unshared runs', () => {
  const points = Array.from({ length: 6 }, (_, lon) => ({ lat: 0, lon }));
  const routes = [
    { key: 'bus', color: '#f9a825', geometry: { locations: [...points].reverse() } },
    { key: 'other', color: '#7b1fa2', geometry: { locations: [
      points[1], points[2], { lat: 1, lon: 2.5 }, points[3], points[4],
    ] } },
  ];
  const route = routePartsForVisibleRoutes(routes)[0];
  const map = testMap();
  const render = (map) => route.parts.map((part) =>
    part.paths.map((path) => offsetRoutePath(path, part.laneIndex * 5, map)));
  const rendered = render(map);
  const locations = renderedRouteLocations(route.pathOrder, rendered);
  assert.deepEqual(locations[0], points[5]);
  assert.deepEqual(locations.at(-1), points[0]);
  assert.ok(locations.every((point, i) => i === 0 || point.lon <= locations[i - 1].lon));
  assert.equal(route.parts.find((part) => part.shared).paths.length, 2);
  assert.deepEqual(locations.filter((point) => Number.isInteger(point.lon)),
    [...points].reverse());

  const start = markerPositionOnRoute({ lat: 0, lon: 3.5 }, route.parts, rendered, map);
  const path = pathToNextStop({ lat: start[0], lon: start[1] }, { locations }, { lat: 0, lon: 1.5 });
  assert.deepEqual(path[0], start);
  assert.ok(path.some(([lat, lon]) => lat === 0.025 && lon > 3));
  assert.ok(path.some(([lat, lon]) => lat === 0.025 && lon < 2));
  assert.ok(path.some(([lat, lon]) => lat === 0 && lon === 3));
  assert.ok(path.some(([lat, lon]) => lat === 0 && lon === 2));

  const zoomed = renderedRouteLocations(route.pathOrder, render(testMap(2)));
  assert.ok(zoomed.some((point) => point.lat === 0.0125));
  assert.ok(zoomed.every((point) => point.lat <= 0.0125));
});
