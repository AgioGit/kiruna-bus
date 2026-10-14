export const LKAB_BOUND_ROUTE_ID = 540298;
export const LKAB_RETURN_ROUTE_ID = 535423;

const ADOLF_HEDINSVAGEN = { lat: 67.86001, lon: 20.22105 };
const SKRADAREGATAN = { lat: 67.86239, lon: 20.21577 };
const LKAB = { lat: 67.84944, lon: 20.19584 };
const ANCHOR_TOLERANCE_METRES = 15;
const STREET_TOLERANCE_METRES = 40;

function projected(point) {
  return {
    x: point.lon * 111_320 * Math.cos(67.85 * Math.PI / 180),
    y: point.lat * 111_320,
  };
}

function distanceToSegment(point, from, to) {
  const p = projected(point);
  const a = projected(from);
  const b = projected(to);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const position = Math.max(0, Math.min(1,
    ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)
  ));
  return Math.hypot(p.x - a.x - position * dx, p.y - a.y - position * dy);
}

function distanceToRoute(point, locations) {
  let distance = Infinity;
  for (let i = 1; i < locations.length; i++) {
    distance = Math.min(distance, distanceToSegment(point, locations[i - 1], locations[i]));
  }
  return distance;
}

function anchorIndex(locations, point, name) {
  let index = -1;
  let distance = Infinity;
  locations.forEach((location, i) => {
    const next = Math.hypot(
      (location.lat - point.lat) * 111_320,
      (location.lon - point.lon) * 111_320 * Math.cos(point.lat * Math.PI / 180)
    );
    if (next < distance) {
      distance = next;
      index = i;
    }
  });
  if (distance > ANCHOR_TOLERANCE_METRES) {
    throw new Error(`Cannot correct LKAB-bound route: ${name} is not on the supplied shape.`);
  }
  return index;
}

export function correctLkabBoundRoute(outbound, returning) {
  if (!Array.isArray(outbound?.locations) || outbound.locations.length < 2) {
    throw new Error('Cannot correct LKAB-bound route: outbound geometry is unavailable.');
  }
  const from = anchorIndex(outbound.locations, ADOLF_HEDINSVAGEN, 'Adolf Hedinsvägen');
  const end = anchorIndex(outbound.locations, LKAB, 'LKAB');
  if (from >= end || end !== outbound.locations.length - 1) {
    throw new Error('Cannot correct LKAB-bound route: outbound stop order has changed.');
  }
  // Do not override the operator's data once its LKAB-bound route uses Skrädaregatan.
  if (distanceToRoute(SKRADAREGATAN, outbound.locations.slice(from)) <= STREET_TOLERANCE_METRES) {
    return outbound;
  }
  if (!Array.isArray(returning?.locations) || returning.locations.length < 2) {
    throw new Error('Cannot correct LKAB-bound route: return-route geometry is unavailable.');
  }
  const returnStart = anchorIndex(returning.locations, LKAB, 'return route LKAB');
  const returnEnd = anchorIndex(returning.locations, ADOLF_HEDINSVAGEN, 'return route Adolf Hedinsvägen');
  if (returnStart !== 0 || returnEnd <= returnStart ||
      distanceToRoute(SKRADAREGATAN, returning.locations.slice(returnStart, returnEnd + 1)) > STREET_TOLERANCE_METRES) {
    throw new Error('Cannot correct LKAB-bound route: the return route no longer passes Skrädaregatan.');
  }

  return {
    ...outbound,
    locations: [
      ...outbound.locations.slice(0, from),
      ...returning.locations.slice(returnStart, returnEnd + 1).reverse(),
    ],
  };
}
