const COORDINATE_SCALE = 100_000;

function pointKey({ lat, lon }) {
  return `${Math.round(lat * COORDINATE_SCALE)},${Math.round(lon * COORDINATE_SCALE)}`;
}

function edgeKey(from, to) {
  const a = pointKey(from);
  const b = pointKey(to);
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function routePartsForVisibleRoutes(routes) {
  const colorsByEdge = new Map();
  for (const route of routes) {
    const locations = route.geometry.locations;
    for (let i = 1; i < locations.length; i++) {
      const key = edgeKey(locations[i - 1], locations[i]);
      if (!colorsByEdge.has(key)) colorsByEdge.set(key, new Set());
      colorsByEdge.get(key).add(route.color);
    }
  }
  const sharedEdges = new Map(
    [...colorsByEdge].filter(([, colors]) => colors.size > 1)
      .map(([key, colors]) => [key, [...colors].sort()])
  );

  return routes.map((route) => {
    const { locations } = route.geometry;
    const parts = new Map();
    const pathOrder = [];
    const labels = [];
    let current = null;
    let path = [];

    const finishPath = () => {
      if (!path.length) return;
      // Reverse shared runs consistently even when two journeys travel opposite ways.
      const reversed = current.shared && pointKey(path.at(-1)) < pointKey(path[0]);
      if (reversed) path.reverse();
      pathOrder.push({
        partIndex: [...parts.keys()].indexOf(current.key),
        pathIndex: current.paths.length,
        reversed,
      });
      parts.get(current.key).paths.push(path.map(({ lat, lon }) => [lat, lon]));
    };

    for (let i = 1; i < locations.length; i++) {
      const colors = sharedEdges.get(edgeKey(locations[i - 1], locations[i]));
      const phase = colors?.indexOf(route.color) ?? -1;
      const key = colors ? `${colors.join(',')}:${phase}` : 'solid';
      labels.push(key);
      if (current?.key !== key) {
        finishPath();
        if (!parts.has(key)) {
          parts.set(key, {
            key,
            shared: !!colors,
            paths: [],
            laneIndex: colors ? phase - (colors.length - 1) / 2 : 0,
          });
        }
        current = parts.get(key);
        path = [locations[i - 1], locations[i]];
      } else {
        path.push(locations[i]);
      }
    }
    finishPath();

    return { ...route, layoutKey: labels.join('|'), parts: [...parts.values()], pathOrder };
  });
}
