import test from 'node:test';
import assert from 'node:assert/strict';
import { initMap } from '../src/js/map.js';
import { store } from '../src/js/appState.js';

test('moves existing bus markers without rebuilding unchanged routes and stops', () => {
  const markers = [];
  const groups = [];
  const routes = [];
  const projections = [];
  const circles = [];
  const map = {
    zoom: 14,
    panes: {},
    handlers: {},
    setView() { return this; },
    createPane(name) { return this.panes[name] = { style: {} }; },
    on(event, callback) { this.handlers[event] = callback; },
    getZoom() { return this.zoom; },
    project([lat, lon], zoom) {
      const scale = 10_000 * 2 ** (zoom - 14);
      return { x: lon * scale, y: lat * scale };
    },
    unproject([x, y], zoom) {
      const scale = 10_000 * 2 ** (zoom - 14);
      return { lat: y / scale, lng: x / scale };
    },
    distance([lat1, lon1], [lat2, lon2]) {
      return Math.hypot((lat2 - lat1) * 111_320, (lon2 - lon1) * 42_000);
    },
    panTo(position) { this.lastPan = position; },
  };
  globalThis.window = { addEventListener() {} };
  globalThis.document = {
    getElementById() { return {}; },
    querySelector() { return null; },
    createElement() { return { textContent: '' }; },
  };
  globalThis.L = {
    map() { return map; },
    tileLayer() { return { addTo() {} }; },
    layerGroup() {
      const group = {
        clearCount: 0,
        removed: [],
        addTo() { return this; },
        clearLayers() { this.clearCount++; },
        removeLayer(layer) { this.removed.push(layer); },
      };
      groups.push(group);
      return group;
    },
    divIcon(options) { return options; },
    circleMarker(position, options) {
      circles.push(options);
      return { bindTooltip() { return this; }, on() { return this; }, addTo() { return this; } };
    },
    polyline(position, options) {
      const polyline = {
        position,
        options,
        addCount: 0,
        addTo() { this.addCount++; return this; },
        setStyle(style) { this.options = { ...this.options, ...style }; },
        setLatLngs(next) { this.position = next; this.latLngUpdates = (this.latLngUpdates ?? 0) + 1; },
      };
      (options.className === 'vehicle-next-stop-path' ? projections : routes).push(polyline);
      return polyline;
    },
    marker(position, options) {
      const marker = {
        position,
        icon: options.icon,
        bindTooltip() { return this; },
        on() { return this; },
        addTo() { return this; },
        setLatLng(next) { this.position = next; },
        setZIndexOffset() {},
        setIcon(next) { this.icon = next; },
        setTooltipContent() {},
        openTooltip() {},
        closeTooltip() {},
      };
      markers.push(marker);
      return marker;
    },
  };

  initMap('map');
  assert.ok(map.panes.routes.style.zIndex < map.panes.nextStops.style.zIndex);
  assert.ok(map.panes.nextStops.style.zIndex < map.panes.stops.style.zIndex);
  const bus = {
    journeyId: 7,
    lineId: 123,
    routeId: 456,
    line: 'Röd.',
    destination: 'Centre',
    callIds: ['c1'],
    ageMs: 0,
    stale: false,
    nextStop: { stopText: 'Square (22)' },
    position: { location: { lat: 67.85, lon: 20.22 }, heading: 90, timestamp: '2026-09-25T10:00:00+02:00' },
  };
  store.set({
    activeLineIds: new Set([123]),
    lineRoutes: new Map([[123, new Set([456])]]),
    routeGeometry: new Map([[456, { locations: [{ lat: 67.85, lon: 20.22 }, { lat: 67.86, lon: 20.23 }] }]]),
    stopLocations: new Map([[22, { text: 'Square (22)', location: { lat: 67.86, lon: 20.23 } }]]),
    liveVehicles: [bus],
  });

  const [routeLayer, stopLayer] = groups;
  const routeRenders = routeLayer.clearCount;
  const stopRenders = stopLayer.clearCount;
  const originalRoute = routes[0];
  const marker = markers[0];
  assert.deepEqual(marker.icon.iconSize, [30, 30]);
  assert.deepEqual(marker.icon.iconAnchor, [15, 15]);
  assert.match(marker.icon.html, /class="vehicle-bus"/);
  assert.match(marker.icon.html, /<g fill="var\(--color-surface\)">/);
  assert.match(marker.icon.html, /--vehicle-color: #555555/);
  for (const heading of [0, 90, 180, 270]) {
    store.set({ liveVehicles: [{ ...bus, position: { ...bus.position, heading } }] });
    assert.equal(markers.length, 1);
    assert.match(marker.icon.html, new RegExp(`class="vehicle-heading" style="transform: rotate\\(${heading}deg\\);"`));
  }
  store.set({ liveVehicles: [{ ...bus, position: { ...bus.position, heading: null } }] });
  assert.match(marker.icon.html, /class="vehicle-heading" style="transform: rotate\([\d.]+deg\);"/);
  store.set({ liveVehicles: [{ ...bus, routeId: null, position: { ...bus.position, heading: null } }] });
  assert.match(marker.icon.html, /class="vehicle-bus"/);
  assert.doesNotMatch(marker.icon.html, /vehicle-heading|vehicle-direction/);
  store.set({ liveVehicles: [{ ...bus, position: { ...bus.position, location: { lat: 67.851, lon: 20.221 } } }] });

  assert.equal(markers.length, 1);
  assert.deepEqual(marker.position, [67.851, 20.221]);
  assert.equal(routeLayer.clearCount, routeRenders);
  assert.equal(stopLayer.clearCount, stopRenders);
  assert.equal(routes.length, 1);

  store.set({ hoveredVehicleJourneyId: 7 });
  assert.equal(projections.length, 1);
  const projection = projections[0];
  assert.equal(projection.options.color, '#ffffff');
  assert.equal(projection.options.dashArray, '1 11');
  assert.equal(projection.options.interactive, false);
  assert.deepEqual(projection.position[0], marker.position);
  assert.deepEqual(projection.position.at(-1), [67.86, 20.23]);
  assert.equal(map.lastPan, undefined);

  store.set({
    selectedVehicleJourneyId: 7,
    journeyStops: new Map([[7, [{ stopText: 'Square (22)', sequenceNumber: 1 }]]]),
  });
  assert.equal(routes.length, 1);
  assert.equal(originalRoute.options.weight, 7);
  assert.equal(circles.at(-1).radius, 6);
  assert.deepEqual(map.lastPan, [67.851, 20.221]);
  store.set({ hoveredVehicleJourneyId: null });
  assert.equal(projections.length, 1); // selection keeps the same animated line

  store.set({ activeLineIds: new Set() });
  assert.equal(routes.length, 1);
  assert.deepEqual(routeLayer.removed, [originalRoute]);
  store.set({ activeLineIds: new Set([123]) });
  assert.equal(routes.length, 1);
  assert.equal(originalRoute.addCount, 2);
  assert.equal(originalRoute.options.weight, 7);
  assert.deepEqual(groups[3].removed, [projection]);
  assert.equal(projections.length, 2);

  store.set({
    routeGeometry: new Map([
      [456, store.get().routeGeometry.get(456)],
      [789, { locations: [{ lat: 67.85, lon: 20.22 }, { lat: 67.87, lon: 20.24 }] }],
    ]),
    lineRoutes: new Map([[123, new Set([456, 789])]]),
  });
  assert.equal(routes.length, 2);
  assert.equal(routes[0], originalRoute);
  assert.equal(routeLayer.clearCount, routeRenders);

  store.set({
    routeGeometry: new Map([
      [456, { locations: [{ lat: 67.85, lon: 20.22 }, { lat: 67.88, lon: 20.25 }] }],
      [789, store.get().routeGeometry.get(789)],
    ]),
  });
  assert.equal(routes.length, 3);
  assert.deepEqual(routeLayer.removed, [originalRoute, originalRoute]);

  store.set({
    selectedStop: { id: 22, text: 'Square (22)', location: { lat: 67.86, lon: 20.23 } },
    stopSelectionSeq: 1,
  });
  assert.deepEqual(map.lastPan, [67.86, 20.23]);

  const sharedLocations = store.get().routeGeometry.get(456).locations;
  const beforeOverlap = routes.length;
  store.set({
    lines: [{ id: 123, text: 'Gul' }, { id: 124, text: 'Lila' }],
    activeLineIds: new Set([123, 124]),
    lineRoutes: new Map([[123, new Set([456])], [124, new Set([999])]]),
    routeGeometry: new Map([
      [456, store.get().routeGeometry.get(456)],
      [999, { locations: [...sharedLocations].reverse() }],
    ]),
  });
  const sharedPaths = routes.slice(beforeOverlap);
  assert.equal(sharedPaths.length, 2);
  assert.deepEqual(sharedPaths.map((route) => route.options.dashArray), [undefined, undefined]);
  assert.notDeepEqual(sharedPaths[0].position, sharedPaths[1].position);
  assert.deepEqual(sharedPaths[0].position[0][0], sharedPaths[1].position[0][0]);
  assert.deepEqual(sharedPaths[0].position[0].at(-1), sharedPaths[1].position[0].at(-1));

  const visibleMarker = markers.at(-1);
  assert.match(visibleMarker.icon.html, /--vehicle-color: #f9a825;/);
  const overlapGps = { lat: 67.865, lon: 20.235 };
  store.set({
    liveVehicles: [{ ...bus, position: { ...bus.position, location: overlapGps } }],
  });
  assert.notDeepEqual(visibleMarker.position, [overlapGps.lat, overlapGps.lon]);
  const assertProjectionOnLane = (polyline = sharedPaths[0]) => {
    const lane = polyline.position[0].map((point) => map.project(point, map.zoom));
    for (const latLng of projections.at(-1).position.slice(0, -1)) {
      const point = map.project(latLng, map.zoom);
      const distance = Math.min(...lane.slice(1).map((to, i) => {
        const from = lane[i];
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const fraction = Math.max(0, Math.min(1,
          ((point.x - from.x) * dx + (point.y - from.y) * dy) / (dx * dx + dy * dy)));
        return Math.hypot(point.x - from.x - fraction * dx, point.y - from.y - fraction * dy);
      }));
      assert.ok(distance < 0.000001, `Dotted path is ${distance} pixels away from its rendered lane`);
    }
  };
  assertProjectionOnLane();
  const beforeZoomMarker = visibleMarker.position;
  const beforeZoom = structuredClone(sharedPaths[0].position);
  map.zoom = 15;
  map.handlers.zoomend();
  assert.equal(routes.length, beforeOverlap + 2);
  assert.notDeepEqual(sharedPaths[0].position, beforeZoom);
  assert.notDeepEqual(visibleMarker.position, beforeZoomMarker);
  assertProjectionOnLane();
  assert.deepEqual(sharedPaths.map((route) => route.latLngUpdates), [1, 1]);
  assert.deepEqual(sharedPaths[0].position[0][0], beforeZoom[0][0]);

  store.set({ liveVehicles: [{ ...bus, ageMs: 1000, position: { ...bus.position, location: overlapGps } }] });
  assert.equal(routes.length, beforeOverlap + 2);
  store.set({ activeLineIds: new Set([123]) });
  assert.deepEqual(visibleMarker.position, [overlapGps.lat, overlapGps.lon]);
  assert.equal(routes.at(-1).options.dashArray, undefined);
  assert.equal(routes.at(-1).options.color, '#f9a825');
  map.zoom = 16;
  map.handlers.zoomend();
  assert.equal(sharedPaths[1].latLngUpdates, 2);
  store.set({ activeLineIds: new Set([123, 124]) });
  assert.equal(sharedPaths[1].addCount, 2);
  assert.notDeepEqual(visibleMarker.position, [overlapGps.lat, overlapGps.lon]);
  assert.equal(routes.at(-1).options.dashArray, undefined);
  const following = [
    { id: 23, text: 'Second (23)', location: { lat: 67.87, lon: 20.24 } },
    { id: 24, text: 'Third (24)', location: { lat: 67.875, lon: 20.245 } },
    { id: 25, text: 'Fourth (25)', location: { lat: 67.879, lon: 20.249 } },
  ];
  store.set({
    stopLocations: new Map([...store.get().stopLocations, ...following.map((stop) => [stop.id, stop])]),
    journeyStops: new Map([[7, [bus.nextStop, ...following.map((stop) => ({ stopText: stop.text }))]]]),
  });
  assert.deepEqual(projections.at(-1).position.at(-1), [following[1].location.lat, following[1].location.lon]);
  assertProjectionOnLane(routes.at(-1));
  store.set({ journeyStops: new Map([[7, [bus.nextStop, { stopText: following[0].text }]]]) });
  assert.deepEqual(projections.at(-1).position.at(-1), [following[0].location.lat, following[0].location.lon]);
  const lastProjection = projections.at(-1);
  store.set({ selectedVehicleJourneyId: null, hoveredVehicleJourneyId: 7 });
  assert.equal(projections.at(-1), lastProjection); // hover survives deselection
  store.set({ hoveredVehicleJourneyId: null });
  assert.ok(groups[3].removed.includes(lastProjection));
  store.set({ hoveredVehicleJourneyId: 7, liveVehicles: [] });
  assert.ok(groups[2].removed.includes(visibleMarker));
});
