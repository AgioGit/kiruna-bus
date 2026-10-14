import test from 'node:test';
import assert from 'node:assert/strict';
import { correctLkabBoundRoute } from '../server/lib/routeCorrections.js';

const start = { lat: 67.84712, lon: 20.35045 };
const adolf = { lat: 67.86001, lon: 20.22105 };
const skradare = { lat: 67.86239, lon: 20.21577 };
const office = { lat: 67.85042, lon: 20.19738 };
const lkab = { lat: 67.84944, lon: 20.19584 };

test('replaces only the outdated LKAB approach with the reverse Skrädaregatan path', () => {
  const outbound = { locations: [start, adolf, { lat: 67.855, lon: 20.208 }, office, lkab] };
  const returning = { locations: [lkab, office, skradare, adolf, start] };
  const corrected = correctLkabBoundRoute(outbound, returning);

  assert.deepEqual(corrected.locations, [start, adolf, skradare, office, lkab]);
  assert.deepEqual(outbound.locations, [start, adolf, { lat: 67.855, lon: 20.208 }, office, lkab]);
  assert.equal(correctLkabBoundRoute(corrected, null), corrected);
});

test('rejects changed return or outbound anchors instead of drawing a misleading route', () => {
  const outbound = { locations: [start, adolf, { lat: 67.855, lon: 20.208 }, office, lkab] };
  assert.throws(
    () => correctLkabBoundRoute(outbound, { locations: [lkab, office, adolf] }),
    /no longer passes Skrädaregatan/
  );
  assert.throws(
    () => correctLkabBoundRoute({ locations: [start, { lat: 67.855, lon: 20.208 }, office, lkab] }, null),
    /Adolf Hedinsvägen is not on the supplied shape/
  );
});
