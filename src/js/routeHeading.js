// Returns the bearing of the route segment nearest to a vehicle position,
// oriented toward the journey's next stop. MapRoute geometry is not reliably
// ordered in travel direction, so the next stop determines whether the nearest
// segment should be followed forwards or backwards. Without all three inputs,
// a direction cannot be inferred safely and the caller should render a dot.
export function headingAlongRoute(position, geometry, nextStopLocation) {
  const locations = geometry?.locations;
  if (
    position?.lat == null || position?.lon == null ||
    nextStopLocation?.lat == null || nextStopLocation?.lon == null ||
    !Array.isArray(locations) || locations.length < 2
  ) {
    return null;
  }

  const latitudeScale = Math.cos((position.lat * Math.PI) / 180);
  const vehicleMatch = nearestSegment(position, locations, latitudeScale);
  const stopMatch = nearestSegment(nextStopLocation, locations, latitudeScale);
  if (!vehicleMatch || !stopMatch) return null;

  const followsGeometryOrder = stopMatch.progress >= vehicleMatch.progress;
  return followsGeometryOrder
    ? bearing(vehicleMatch.from, vehicleMatch.to)
    : bearing(vehicleMatch.to, vehicleMatch.from);
}

export function pathToNextStop(position, geometry, nextStopLocation) {
  if (position?.lat == null || position?.lon == null ||
      nextStopLocation?.lat == null || nextStopLocation?.lon == null) return null;

  const start = [position.lat, position.lon];
  const end = [nextStopLocation.lat, nextStopLocation.lon];
  const locations = geometry?.locations;
  if (!Array.isArray(locations) || locations.length < 2) return [start, end];

  const latitudeScale = Math.cos((position.lat * Math.PI) / 180);
  const vehicleMatch = nearestSegment(position, locations, latitudeScale);
  const stopMatch = nearestSegment(nextStopLocation, locations, latitudeScale);
  if (!vehicleMatch || !stopMatch) return [start, end];

  const forward = stopMatch.progress >= vehicleMatch.progress;
  const between = locations.slice(
    Math.floor(Math.min(vehicleMatch.progress, stopMatch.progress)) + 1,
    Math.ceil(Math.max(vehicleMatch.progress, stopMatch.progress))
  );
  if (!forward) between.reverse();
  return [
    start,
    vehicleMatch.point,
    ...between.map(({ lat, lon }) => [lat, lon]),
    stopMatch.point,
    end,
  ];
}

export function pathToUpcomingStops(position, geometry, stopLocations) {
  const stops = stopLocations.slice(0, 3).filter((stop) => stop?.lat != null && stop?.lon != null);
  if (!stops.length || position?.lat == null || position?.lon == null) return null;
  const path = [];
  let from = position;
  stops.forEach((stop, index) => {
    const segment = pathToNextStop(from, geometry, stop);
    // Keep intermediate stops on the rendered lane; only the last stop
    // needs a connection from the route to its actual coordinates.
    const points = index < stops.length - 1 && segment.length > 2 ? segment.slice(0, -1) : segment;
    for (const point of points.slice(path.length ? 1 : 0)) path.push(point);
    const end = points.at(-1);
    from = { lat: end[0], lon: end[1] };
  });
  return path;
}
function nearestSegment(location, locations, latitudeScale) {
  const point = { x: location.lon * latitudeScale, y: location.lat };
  let nearest = null;

  for (let i = 0; i < locations.length - 1; i += 1) {
    const from = locations[i];
    const to = locations[i + 1];
    if (from?.lat == null || from?.lon == null || to?.lat == null || to?.lon == null) continue;

    const a = { x: from.lon * latitudeScale, y: from.lat };
    const b = { x: to.lon * latitudeScale, y: to.lat };
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared === 0) continue;

    const projection = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared;
    const t = Math.max(0, Math.min(1, projection));
    const closestX = a.x + t * dx;
    const closestY = a.y + t * dy;
    const distanceSquared = (point.x - closestX) ** 2 + (point.y - closestY) ** 2;

    if (!nearest || distanceSquared < nearest.distanceSquared) {
      nearest = {
        distanceSquared, from, to, progress: i + t,
        point: [from.lat + t * (to.lat - from.lat), from.lon + t * (to.lon - from.lon)],
      };
    }
  }

  return nearest;
}

function bearing(from, to) {
  const fromLat = (from.lat * Math.PI) / 180;
  const toLat = (to.lat * Math.PI) / 180;
  const deltaLon = ((to.lon - from.lon) * Math.PI) / 180;
  const y = Math.sin(deltaLon) * Math.cos(toLat);
  const x = Math.cos(fromLat) * Math.sin(toLat) - Math.sin(fromLat) * Math.cos(toLat) * Math.cos(deltaLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
