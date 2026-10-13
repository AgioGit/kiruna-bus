# Data Flow — Current Implementation

Describes how data actually moves through the app, end to end: the server in
`/server` (which talks to Boreal), and the browser code in `/src` (which only
talks to the server). See `API.md` for the underlying endpoint contracts, and
`initial_plan.md` for the design rationale/history (written when scanning ran
in the browser; that logic now lives in `server/lib/tracker.js`).

## 0. The server (`/server`)

```
Browser ──► /api/buses, /api/stops, /api/<BorealEndpoint> ──► server ──► Boreal
```

- `/api/buses` — every running bus (position, line, destination, next two
  stops with planned/forecast times, age/stale flag) plus `lineRoutes`
  (`{ lineId: routeId[] }`). Built by `tracker.js`:
  - **Stop scan** every ~3 min (or earlier after a failed position fetch,
    at most every 30 s): `GetCalls` for every stop, grouped by `journeyId`
    into ordered stop lists. A journey's `positionCallIds` are the call ids
    of its last stop.
  - **Positions** at most every 15 s: `GetVehiclePosition` per journey,
    deduped by `(lat, lon, timestamp)` onto the journey with the soonest
    future forecast. `nextStop`/`followingStop`/`ageMs` are computed per
    request using the Boreal-corrected clock.
  - Refresh is lazy (only when a request finds data expired), concurrent
    requests share one refresh, and failures keep serving the last data with
    `error` set. Missing fixes retain their GPS timestamp and are marked
    stale; cached journey fixes also survive disappearing/changing call ids.
    Positions older than three minutes are omitted.
- `/api/stops` — `[{ id, text, location }]`, coordinates resolved once.
- `/api/<BorealEndpoint>` — allow-listed passthrough with short TTL caches
  (`passthrough.js`) that injects the Kiruna profile headers, so the
  browser code can call the unchanged endpoints (`GetLines`, `GetCalls`,
  `GetMapRoute`, `FindStopArea`, ...).
- Everything else is static files from `src/`.

## 1. Startup sequence (`main.js`)

```
main()
 ├─ 1. loadConfig()                     [config.js]   ── must succeed first
 │     GetConfigOptions → store profile headers, tile URL, minZoom
 │     (fails → visible fatal error, nothing else runs)
 │
 ├─ 2. loadLines() + initClockOffset()  [lines.js, clock.js]  ── parallel
 │     GetLines            → store.lines
 │     GetSystemTimestamp  → store.clockOffsetMs (server - client time)
 │
 ├─ 3. initMap('map')                   [map.js]
 │     creates Leaflet map centered on hardcoded Kiruna coords,
 │     subscribes to the store, does an initial render() from empty state
 │
 ├─ 4. initUi()                         [ui.js]
 │     wires the stop-search box, subscribes to the store, does an
 │     initial render of (empty) filters/cards/status
 │
 ├─ 5. initCommuter()                   [commuter.js]
 │     restores favorite stops and wires on-demand nearby-stop lookup
 │
 ├─ 6. initPoller()                     [poller.js]
 │     starts the live-bus polling schedule (see §3)
 │
 └─ 7. initCountdown()                  [countdown.js]
       shows "(update in: N s)" in the header, read from poller.js
```

All of `map.js`/`ui.js` render purely as a **function of the shared
store** (`appState.js`) — nothing renders by being called directly by the
things that fetch data. Every fetch just calls `store.set(...)`, which
notifies subscribers, which re-render. This is the one data-flow rule that
holds throughout the app.

## 2. The shared store (`appState.js` + `state.js`)

A minimal pub/sub object (`state.js`'s `createStore`) holds the single
source of truth. Every other module either **writes** to it (fetch/derive
modules) or **reads + subscribes** to it (`map.js`, `ui.js`). No module
talks to another rendering module directly.

Key fields and who writes them:

| Field | Written by | Read by |
|---|---|---|
| `lines`, `activeLineIds` | `lines.js`, `filters.js` | `map.js`, `ui.js` |
| `selectedStop`, `calls`, `isCallsLoading`, `isStopCancelled`, `messages` | `stops.js`, `calls.js`, `poller.js` | `ui.js` |
| `liveVehicles` | `live-vehicles.js` (from `/api/buses`) | `map.js`, `ui.js` (primary live-bus source) |
| `journeyStops` | `live-vehicles.js` (from each bus's `upcomingStops`) | `ui.js` (selected bus trip), `map.js` (upcoming-stop emphasis) |
| `lineRoutes`, `routeGeometry` | `routes.js` (`mergeLineRoutes`, `recordRouteIdsFromCalls`, `fetchGeometries`) | `map.js` (route polylines) |
| `stopLocations` | `stop-locations.js` (from `/api/stops`) | `map.js` (stop circles) |
| `selectedVehicleJourneyId` | `vehicleSelection.js` (bus card/marker click) | `map.js` (marker highlight/pan), `ui.js` (card expansion) |
| `clockOffsetMs` | `clock.js` | `ui.js` (countdowns) |
| `errors.*` | every fetch module, on failure | `ui.js` (`renderStatus`) |

## 3. Continuous polling loops (`poller.js`)

Two schedules run from `poller.js`, both using `AbortController`; a shared
`generation` counter is bumped on stop select/deselect and pause/resume so
responses tied to stale UI state are discarded.

1. **`pollLiveVehicles`** (60s) — one request per tick:
   ```
   refreshLiveVehicles()                     [live-vehicles.js]
     GET /api/buses
     → drop buses whose next stop is > 10 min away or position is > 3 min old
     → store.set({ liveVehicles, journeyStops, errors.vehicles = data.error })
     → mergeLineRoutes(data.lineRoutes)      [routes.js]
          add to lineRoutes; GetMapRoute for each new routeId
          → store.routeGeometry
   refreshStopLocations()                    [stop-locations.js]
     GET /api/stops (only until loaded)  → store.stopLocations
   ```
   Self-guards against overlapping ticks (`liveVehiclesRunning`) since the
   very first request can take several seconds while the server warms up.
   The browser never talks to Boreal's scan endpoints; the server's caches
   decide when Boreal is actually contacted (§0).
   A local expiry timer removes old positions between polls using the
   response's server clock plus elapsed client time, without changing GPS
   timestamps or making another request.

2. **`pollCalls`** (60s, only while a stop is selected) —
   `fetchCallsForSelectedStop` [`calls.js`] calls `GetCalls` (via the
   server's cached passthrough) for `store.selectedStop`, flattens
   `CallGroup.calls`, updates `store.calls`/`isStopCancelled`/`messages`,
   and feeds the same calls into `recordRouteIdsFromCalls`.

   Route geometry is cached in `store.routeGeometry` for the page session.
   `routes.js` shares an in-flight request when concurrent scans discover
   the same route. For the red LKAB-bound shape `540298`, the API currently
   bypasses Skrädaregatan; `routes.js` fetches return shape `535423` and
   replaces only the Adolf Hedinsvägen–LKAB approach with its reverse.
   This correction checks both endpoints and Skrädaregatan, leaves an
   already-corrected upstream shape alone, and reports `errors.routes`
   rather than displaying an uncorrected path if it cannot be applied.
   `map.js` keeps each Leaflet polyline and its route
   coordinates until that route's geometry changes; filtering only hides
   or shows it, and selecting a bus changes its style in place. Shared
   segments of differently colored active routes use parallel screen-pixel
   offsets with a 1 px gap, tapering back at each end. Unshared segments
   follow the original geometry. Zooming recomputes only the offset paths;
   bus markers near a shared segment are placed on their own line's lane
   (distant GPS positions stay untouched). Panning and normal live updates
   do not rebuild the route layers.

Both loops pause on `document.visibilitychange` (tab hidden) and, on
resume, bump `generation` (discarding stale in-flight responses) before
restarting.

## 4. Map rendering (`map.js`)

Subscribed to the store; updates only layers whose inputs change:

- **Routes**: for each active line id in `activeLineIds`, for each
  `routeId` in `lineRoutes.get(lineId)`, draws a polyline from
  `routeGeometry.get(routeId).locations`, colored via
  `colorForLineId(lineId)` (parses the Swedish color word out of the
  line's `text`, see `lineColors.js` — not `lineAppearance`, which was
  observed unreliable). The selected bus's route is emphasized.
- **Vehicles**: iterates `state.liveVehicles`, skips any whose `lineId`
  isn't in `activeLineIds`, and draws an `L.marker` with an `L.divIcon` at
  `position.location`. The arrow uses `position.heading` when reported;
  otherwise its direction is derived from the nearest segment of
  `routeGeometry[bus.routeId]`, oriented toward `bus.nextStop` (or a dot is
  used until both route and stop geometry are available). Markers are
  colored by `colorForLineId(bus.lineId)` (gray if
  uncorrelated), faded if `bus.stale`, with a tooltip showing line →
  destination → next stop (and staleness age if stale). When
  `bus.journeyId === state.selectedVehicleJourneyId` the marker gets a
  scaled/glowing wrapper class; on the render immediately following a
  selection change (tracked via a module-level `lastSelectedJourneyId`)
  the map pans to it once and opens its tooltip for 3 seconds. Markers are
  reused and moved as new fixes arrive; clicking one selects its journey.
  Hovered and selected buses also have an animated dotted connection to the
  current next stop. It follows the rendered route lane between the two
  projected positions, including pixel offsets and junction tapers, and
  updates with zoom and line filtering. Route-part order and orientation
  are restored before clipping the connection, since lane styles group
  disjoint stretches and shared runs may be reversed. Dots are above routes
  and below stop markers, with a direct connection until route
  geometry is available; missing stop coordinates omit the connection.
  The animation respects reduced-motion preferences.
- **Stops**: a small `circleMarker` for every entry in
  `state.stopLocations`, on its own layer between the routes and the
  vehicles, with the stop name as a tooltip. The currently selected stop
  is drawn larger and in blue; the selected journey's upcoming stops are
  highlighted. Clicking a circle calls `selectStopArea`
  directly (with `bubblingMouseEvents: false`) — the circle would
  otherwise swallow the map-level click that resolves a stop via
  `FindStopsNearLocation`.
- **Stop selection**: a map click calls `FindStopsNearLocation`
  [`stops.js`], and on a hit, marks the clicked stop and calls
  `selectStopArea`, which updates `store.selectedStop` (triggering
  `poller.js`'s `onStopSelected`, starting the calls-polling loop). Selecting
  through search or shortcuts also pans the map to the chosen stop once.

## 5. UI rendering (`ui.js`)

Also subscribed to the store; re-renders only the pieces whose inputs change:

- **Line filters**: checkbox list inside the collapsed Lines disclosure;
  checked state from
  `activeLineIds`. Toggling calls `filters.js`'s `toggleLine`, which
  **only** flips `activeLineIds` (no network call) — except turning a
  line *on* also calls `ensureLineRouteDiscovered(lineId)` as a
  just-in-case fallback probe if that line's route geometry is still
  completely unknown (normally already populated via `/api/buses`).
- **Live bus cards**: same `state.liveVehicles` data as the map
  markers, filtered by `activeLineIds` and to buses whose last position
  fix is at most three minutes old (including the selected bus), one card per physical
  bus. Each selectable button carries a `data-journey-id`; a delegated click
  listener (bound once, since the list's `innerHTML` is rebuilt every
  tick) calls `selectVehicle(journeyId)` [`vehicleSelection.js`], which
  toggles `state.selectedVehicleJourneyId` — pure client-side state, no
  refetch — previewing the next three stops from `state.journeyStops`
  (with a disclosure for the rest) and highlighting the map marker.
  Late ETAs show a red `(+N min)` immediately after each timestamp. A
  shared early difference is summarized once above the trip stops.
  Keyboard focus is preserved across position updates.
  On desktop the page is bounded to the viewport; the live-bus panel and
  sidebar scroll rather than letting expanded content escape vertically.
- **Departure cards**: from `state.calls` (the selected stop's flattened
  departures), filtered by `activeLineIds`, joined against
  `state.messages` for disruption banners, with a cancelled-stop banner
  when `isStopCancelled`. No card is shown before a stop is selected;
  `isCallsLoading` distinguishes an initial fetch from a true empty result.
- **Status banner**: surfaces `state.errors.*` (config/lines/vehicles/
  calls/stopNotFound) without clearing previously-good data underneath.

## 6. Stop search flow (`stops.js`)

```
user types → debounced Autocomplete(query)        [stops.js]
           → user picks a result
           → FindStopArea(StopAreaQuery) or
             FindStopsNearLocation (map click)
           → selectStopArea(stop)
                store.set({ selectedStop: stop, calls: [], isCallsLoading: true })
                poller.onStopSelected() → generation += 1, starts pollCalls
```

Deselecting a stop (`clearSelectedStop`) does the reverse: bumps
`generation`, stops the calls-polling loop, and clears
`calls`/`isCallsLoading`/`isStopCancelled`/`messages` from the store.

## 7. End-to-end picture

```
Boreal AnyRide API
        │ HTTP (server-side only; cached, rate-limited by TTLs)
        ▼
server (tracker.js, passthrough.js)  ── also serves src/
        │ /api/buses, /api/stops, /api/<endpoint>
        ▼
api.js (timeout, cancellation, typed errors)
        │
        ▼
poller.js + fetch/derive modules
  ├─ pollLiveVehicles (60s) → /api/buses (+ /api/stops until loaded)
  └─ pollCalls (60s while a stop is selected)
        │ store.set(...)
        ▼
appState.js shared store
        │ subscriber notification
        ▼
map.js + ui.js (render state; no direct API fetches)
```

Everything downstream of `api.js` ends up as a `store.set(...)` call;
everything upstream of the store (`map.js`, `ui.js`) only ever reads state
and never fetches — this one-directional flow (fetch → store → render) is
what keeps polling, filtering, and stop-selection from stepping on each
other.
