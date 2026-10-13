const TAPER_PIXELS = 12;
const MAX_ROUTE_SNAP_METRES = 35;

function direction(from, to) {
  if (!from || !to) return null;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  return length ? { x: dx / length, y: dy / length } : null;
}

function normalAt(samples, index) {
  const point = samples[index].point;
  let incoming = null;
  let outgoing = null;
  for (let i = index - 1; i >= 0 && !incoming; i--) incoming = direction(samples[i].point, point);
  for (let i = index + 1; i < samples.length && !outgoing; i++) outgoing = direction(point, samples[i].point);
  if (!incoming && !outgoing) return { x: 0, y: 0 };
  if (!incoming || !outgoing) {
    const tangent = incoming ?? outgoing;
    return { x: -tangent.y, y: tangent.x };
  }
  const before = { x: -incoming.y, y: incoming.x };
  const after = { x: -outgoing.y, y: outgoing.x };
  const x = before.x + after.x;
  const y = before.y + after.y;
  const length = Math.hypot(x, y);
  if (length < 0.001) return after;
  const unit = { x: x / length, y: y / length };
  const scale = Math.min(2, 1 / Math.max(0.5, unit.x * after.x + unit.y * after.y));
  return { x: unit.x * scale, y: unit.y * scale };
}

// Project at the current zoom so lanes stay a fixed number of screen pixels
// apart; taper the two ends back to the unmodified route at each junction.
export function offsetRoutePath(path, pixels, map) {
  if (!pixels || path.length < 2) return path;
  const zoom = map.getZoom();
  const points = path.map((latLng) => map.project(latLng, zoom));
  const lengths = [0];
  for (let i = 1; i < points.length; i++) {
    lengths.push(lengths[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  }
  const total = lengths.at(-1);
  if (!total) return path;
  const taper = Math.min(TAPER_PIXELS, total / 3);
  const samples = [{ point: points[0], distance: 0 }];
  for (let i = 1; i < points.length; i++) {
    const start = lengths[i - 1];
    const end = lengths[i];
    for (const distance of [taper, total - taper]) {
      if (distance <= start || distance >= end) continue;
      const fraction = (distance - start) / (end - start);
      samples.push({
        point: {
          x: points[i - 1].x + (points[i].x - points[i - 1].x) * fraction,
          y: points[i - 1].y + (points[i].y - points[i - 1].y) * fraction,
        },
        distance,
      });
    }

    samples.push({ point: points[i], distance: end });
  }
  return samples.map(({ point, distance }, i) => {
    if (i === 0) return path[0];
    if (i === samples.length - 1) return path.at(-1);
    const fade = Math.min(1, distance / taper, (total - distance) / taper);
    const normal = normalAt(samples, i);
    const shifted = map.unproject([point.x + normal.x * pixels * fade, point.y + normal.y * pixels * fade], zoom);
    return [shifted.lat, shifted.lng];
  });
}

// Parts group matching lane styles, not travel order; shared paths may also
// have been reversed so opposite-direction routes use the same lane layout.
export function renderedRouteLocations(pathOrder, renderedPaths) {
  return pathOrder.flatMap(({ partIndex, pathIndex, reversed }, i) => {
    const path = renderedPaths[partIndex][pathIndex];
    const ordered = reversed ? [...path].reverse() : path;
    return ordered.slice(i ? 1 : 0).map(([lat, lon]) => ({ lat, lon }));
  });
}

function nearestPoint(point, path, map, zoom) {
  let closest = { distanceSquared: Infinity, point: null };
  let previous = map.project(path[0], zoom);
  for (let i = 1; i < path.length; i++) {
    const next = map.project(path[i], zoom);
    const dx = next.x - previous.x;
    const dy = next.y - previous.y;
    const fraction = Math.max(0, Math.min(1,
      ((point.x - previous.x) * dx + (point.y - previous.y) * dy) / (dx * dx + dy * dy || 1)
    ));
    const projected = { x: previous.x + fraction * dx, y: previous.y + fraction * dy };
    const distanceSquared = (point.x - projected.x) ** 2 + (point.y - projected.y) ** 2;
    if (distanceSquared < closest.distanceSquared) closest = { distanceSquared, point: projected };
    previous = next;
  }
  return closest;
}

export function markerPositionOnRoute(location, parts, renderedPaths, map) {
  const zoom = map.getZoom();
  const gps = [location.lat, location.lon];
  const point = map.project(gps, zoom);
  let best = { distanceSquared: Infinity };
  parts.forEach((part, partIndex) => {
    part.paths.forEach((path, pathIndex) => {
      const candidate = nearestPoint(point, path, map, zoom);
      if (candidate.distanceSquared < best.distanceSquared) {
        best = { ...candidate, part, partIndex, pathIndex };
      }
    });
  });
  if (!best.part?.shared) return null;
  const snapped = map.unproject([best.point.x, best.point.y], zoom);
  // A vehicle far from its reported route must retain its actual GPS position.
  if (map.distance(gps, [snapped.lat, snapped.lng]) > MAX_ROUTE_SNAP_METRES) return null;

  const lane = renderedPaths[best.partIndex][best.pathIndex];
  const shifted = nearestPoint(best.point, lane, map, zoom).point;
  const displayed = map.unproject([shifted.x, shifted.y], zoom);
  return [displayed.lat, displayed.lng];
}
