import { createStore } from './state.js';

// Single shared application state. See docs/initial_plan.md for the rationale
// behind each field (esp. lineRoutes/routeGeometry and liveVehicles).
export const store = createStore({
  lines: [], // Line[] from GetLines
  activeLineIds: new Set(), // line filter: ids currently shown

  selectedStop: null, // StopArea | null
  stopSelectionSeq: 0, // bumped by stops.js on every select/clear action,
  // including re-selecting the stop that is already selected. ui.js syncs
  // the search box off this counter rather than off selectedStop.id, so
  // clicking a stop on the map always restates it in the box (even after
  // the user typed something else over it) while unrelated poll-tick
  // re-renders still leave in-progress typing alone.
  calls: [], // flattened TransitCall[] for the selected stop
  previousDeparture: null, // last observed passed call; never proof of service
  isCallsLoading: false,
  isStopCancelled: false,
  messages: [], // TrafficMessage[] for the selected stop

  liveVehicles: [], // [{ key, position, lineId, line, destination, journeyId,
  // routeId, callIds, ageMs, stale, nextStop: { stopText, plannedTime,
  // forecastTime }, followingStop: { stopText, plannedTime, forecastTime }
  // | null }], one entry per distinct physical bus, as returned by the
  // server's /api/buses (see server/lib/tracker.js, which scans the stops,
  // fetches positions and dedupes buses sharing the same GPS fix).
  // nextStop/followingStop are computed server-side against the current time
  // on every request. `line` is the short display name (TransitCall.line,
  // e.g. "Röd."), used for compact card/tooltip display instead of the
  // long Line.text.

  selectedVehicleJourneyId: null, // journeyId of the bus highlighted via a
  // live bus card or map marker click (see vehicleSelection.js). Tracked by
  // journeyId, not liveVehicles[].key, because key is derived from
  // (lat, lon, timestamp) and changes every poll tick as a bus moves -
  // journeyId is the only identity that's stable across polls.

  hoveredVehicleJourneyId: null, // journeyId of the live bus card under the
  // pointer/keyboard focus; map.js emphasizes that bus's marker.

  lineRoutes: new Map(), // lineId -> Set<routeId>, discovered lazily
  routeGeometry: new Map(), // routeId -> MapRoute
  stopLocations: new Map(), // stopAreaId -> { text, location: {lat, lon} }.
  // GetStopAreas omits `location` for every stop, so the server resolves
  // coordinates once per stop (/api/stops, see stop-locations.js) for map.js
  // to draw the stop circles. Stops don't move, so this is populated once and
  // never invalidated.
  journeyStops: new Map(), // journeyId -> upcoming stops [{ stopText,
  // sequenceNumber, plannedTime, forecastTime }] in route order, taken from
  // each bus's `upcomingStops` in /api/buses (see live-vehicles.js).

  clockOffsetMs: 0, // serverTime - clientTime, from GetSystemTimestamp
  clockSynchronized: false,
  catalogInfo: null,
  liveQuality: null,
  serviceView: { active: new Set(), complete: false },
  departuresUpdatedAt: null,

  errors: {
    config: null,
    lines: null,
    vehicles: null,
    routes: null,
    calls: null,
    stopNotFound: null,
    cache: null,
    stops: null,
  },
});
