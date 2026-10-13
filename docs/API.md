# Boreal AnyRide API — Reference

Unofficial reference for the undocumented API used by the Boreal AnyRide
real-time information client embedded by Lokaltrafiken Kiruna. Derived from
[`openapi.yaml`](../openapi.yaml) (the formal contract) plus behavior
observed while building the app in `/src` (see `initial_plan.md` for the
app-level design decisions that resulted from these observations). This
document describes **observed
behavior**, not an official stability guarantee from the API provider.

- Base URL: `https://boreal.tmix.se/Tmix.Cap.Ti.Process.AnyRide/api`
- Format: JSON over HTTPS, `GET` and `POST` (request bodies are JSON for
  `POST` endpoints)
- No authentication. The API sends **no CORS headers** (verified for GET and
  preflight, any origin), so browsers cannot read its responses directly.
  This project's [`/server`](../server/README.md) calls it server-side and
  re-exposes the same endpoints under `/api`.

## Required headers

Every endpoint except `GetConfigOptions` requires two headers, whose values
come from `GetConfigOptions`'s response:

| Header | Source field | Example |
|---|---|---|
| `anyride-profile-data` | `ConfigOptions.profileData` | `boreal_kiruna` |
| `anyride-profile-display` | `ConfigOptions.profileDisplay` | `boreal` |

**Call `GetConfigOptions` once at startup before anything else** — every
other call needs these two header values.

## Typical call sequence

```
GetConfigOptions
  → GetLines                      (line list for filters)
  → GetSystemTimestamp             (client/server clock offset)
  → Autocomplete / FindStopArea /
    FindStopsNearLocation          (resolve a stop to search)
      → GetCalls                   (departures for that stop)
        → GetVehiclePosition       (per call id, for a live position)
  → GetStopAreas / GetDirections   (route discovery: which stops/directions
                                    exist for a line)
      → GetCalls (lineId set)      (find a routeId for that line)
        → GetMapRoute               (polyline geometry for that routeId)
```

---

## Endpoints

### `GET /GetConfigOptions`

Get client configuration and profile values. Call this first; nothing else
works without the profile headers it returns.

**Query params** (both optional):
| Name | Type | Description |
|---|---|---|
| `profile` | string | Display profile. Empty selects the site default. |
| `language` | string | Requested language, e.g. `sv`. |

**Response `200`**: [`ConfigOptions`](#configoptions)

**Observed quirk:** `centerLat`/`centerLon` returned a generic Boreal
default (~60.89, 8.43 — Kongsberg, Norway), not a Kiruna-specific center.
Don't trust these fields for an initial map view tied to a specific town;
the app hardcodes Kiruna's coordinates instead (see `map.js`).

---

### `GET /Autocomplete`

Search for stops by name or stop number.

**Headers:** profile headers required.

**Query params:**
| Name | Type | Required | Description |
|---|---|---|---|
| `query` | string | yes | Search text, e.g. `Stadshus` |

**Response `200`**: `string[]` — display strings, e.g. `["Stadshustorget (84064)"]`.
Each string is meant to be passed back into `FindStopArea`'s
`StopAreaQuery` or `GetCallsRequest.query.fromStopAreaQuery`.

---

### `POST /FindStopArea`

Resolve a stop display string (e.g. one returned by `Autocomplete`) to a
full `StopArea` object with coordinates.

**Headers:** profile headers required.

**Request body**: [`FindStopAreaRequest`](#findstopArearequest)

**Response `200`**: [`StopArea`](#stoparea), **nullable** — `null` means
"not found"; this is a normal outcome, not an error.

---

### `POST /FindStopsNearLocation`

Find stops near a geographic coordinate (e.g. from a map click or
geolocation).

**Headers:** profile headers required.

**Request body**: [`FindStopsNearLocationRequest`](#findstopsnearlocationrequest)

**Response `200`**: [`StopArea[]`](#stoparea) — possibly empty.

---

### `GET /GetLines`

List all lines for the selected data profile.

**Headers:** profile headers required.

**Response `200`**: [`Line[]`](#line)

**Observed:** Kiruna's profile currently exposes 4 lines, distinguished by
a Swedish color word embedded in `Line.text` (e.g. `Grön`, `Gul`, `Lila`,
`Röd`) rather than a dedicated color field. `TransitCall.lineAppearance` /
`MapRoute.lineAppearance.background` exist but were observed unreliable
(e.g. returning black `#000000` for the red line) — the app parses the
color word out of `Line.text` instead (see `lineColors.js`).

---

### `GET /GetDirections`

List directions for a line (e.g. inbound/outbound).

**Headers:** profile headers required.

**Query params:**
| Name | Type | Required |
|---|---|---|
| `lineId` | integer (int64) | yes |

**Response `200`**: [`Direction[]`](#direction)

---

### `POST /GetStopAreas`

List stops served by a line, optionally filtered to one direction.

**Headers:** profile headers required.

**Request body**: [`GetStopAreasRequest`](#getstopareasrequest)

**Response `200`**: [`StopArea[]`](#stoparea)

**Observed:** `directionId: null` is accepted and returns stops for the
line across all directions — useful for a single broad discovery call
instead of iterating every direction.

---

### `POST /GetCalls`

Get scheduled and real-time departures ("calls") for a stop, optionally
filtered by line/direction, grouped per the requested `grouping`.

**Headers:** profile headers required.

**Request body**: [`GetCallsRequest`](#getcallsrequest)

**Response `200`**: [`GetCallsResponse`](#getcallsresponse)

**Observed:**
- Passing `lineId: 0` returns calls for **all** lines serving that stop in
  a single request — used for town-wide discovery (one call per stop
  instead of one call per stop-per-line).
- `isStopCancelled: true` means the whole stop is out of service; show a
  banner rather than an empty-looking arrivals list.
- `calls` can legitimately be `[]` (no departures right now) — a valid
  state, not an error.
- `messages[].affectedCalls` holds call ids to cross-reference against the
  flattened `CallGroup.calls` for per-departure disruption banners.

---

### `GET /GetMapRoute`

Get the ordered coordinate geometry for a route.

**Headers:** profile headers required.

**Query params:**
| Name | Type | Required |
|---|---|---|
| `routeId` | integer (int64) | yes — from `TransitCall.routeId` |

**Response `200`**: [`MapRoute`](#maproute)

**Observed:** a line can have multiple distinct `routeId`s (short-turns,
branches, direction-specific shapes) — cache and draw every discovered
variant for a line, not just one "representative" route.

---

### `GET /GetVehiclePosition`

Get the current vehicle position tied to one specific call (departure).

**Headers:** profile headers required.

**Query params:**
| Name | Type | Required |
|---|---|---|
| `callId` | string | yes — from `TransitCall.id` |

**Response `200`**: [`VehiclePosition`](#vehicleposition), **nullable** —
`null` means no live position is currently available for that call; skip
the marker silently.

**Observed quirks (important):**
- `VehiclePosition.id` in the response **merely echoes back the requested
  `callId`** — it is **not** a stable per-vehicle identifier. The same
  physical bus commonly appears under several different `callId`s (one per
  upcoming stop on its journey), all returning the identical `location` +
  `timestamp`. To deduplicate to one row per physical bus, group results by
  a derived key such as `${lat}|${lon}|${timestamp}`, not by `id`.
- ⚠ That dedupe key merges **different journeys**, not just different calls
  of the same journey: a physical bus returns the same fix for its *later
  trips of the day* too (observed: 4 running Yellow journeys collapsed onto
  2 distinct positions). So after grouping, choose which journey's metadata
  to display — the one whose next stop's `forecastTime` is soonest in the
  future. Keeping whichever response happens to arrive first will label a
  bus with a future journey's next stop, and can make two distinct buses
  appear to be heading to the same place.
- Neither `VehiclePosition` nor `TransitCall` has any "in service" / active
  flag. A call whose vehicle hasn't reported recently (trip finished,
  vehicle offline, or a scheduled-only journey with no vehicle assigned
  yet) still returns its last known fix. "In service" must be inferred
  from how old `timestamp` is (the server hides fixes older than 3 minutes — see
  `server/lib/tracker.js`).
- At Kiruna's current scale there are ~45 unique stops and ~200+ unique
  active call ids town-wide at any time — fetching all of them requires
  bounded concurrency (pooling), not one request at a time or an unbounded
  burst.

---

### `GET /GetVehiclePositions` (plural)

Get all vehicle positions exposed by the profile in one call — intended as
a town-wide bulk endpoint.

**Headers:** profile headers required.

**Response `200`**: [`VehiclePosition[]`](#vehicleposition)

**Observed quirk (important):** this endpoint **reliably returned `[]`**
in live testing even while buses were actively running and individual
`GetVehiclePosition(callId)` calls for the same buses returned real data.
Because of this, the app does not rely on this endpoint for live vehicle
data — it is kept only as an unused passthrough endpoint. The
primary feed groups calls by `journeyId`, selects one representative call
(the stop with the earliest future forecast), and calls
`GetVehiclePosition` for that small per-journey set. Identical position
fixes are then deduplicated to physical buses; see `server/lib/tracker.js` and
rounds 4 and 7 in `initial_plan.md`.

---

### `GET /GetSystemTimestamp`

Compare client and API server clocks.

**Headers:** profile headers required.

**Query params:**
| Name | Type | Required |
|---|---|---|
| `clientTimestamp` | string (date-time) | yes |

**Response `200`**: [`SystemTimestamp`](#systemtimestamp)

**Usage:** called once at startup; `systemTimestamp - clientTimestamp` is
stored as a clock offset applied to all subsequent "now" calculations
(delay/staleness math), so a visitor's incorrect system clock doesn't
skew countdowns.

---

## Schemas (contracts)

### ConfigOptions
| Field | Type | Notes |
|---|---|---|
| `profileData` | string | pass back as `anyride-profile-data` header |
| `profileDisplay` | string | pass back as `anyride-profile-display` header |
| `title` | string | |
| `textLanguage` | string | e.g. `sv` |
| `defaultLanguage` | string? | |
| `allowedLanguages` | string[] | |
| `locale` | string? | |
| `centerLat` / `centerLon` | number | ⚠ observed generic default, not town-specific |
| `mapMaxCount` / `mapMaxDistance` | number? | |
| `zoom` / `minZoom` | integer | |
| `useDirection` | boolean | |
| `showVehicleLocations` | boolean | |
| `hideRouteStopSelection` | boolean | |
| `displayRowMapExpanded` | boolean | |
| `showAllStopsCancelledText` | boolean | |
| `useNewTable` | boolean | |
| `newTableMessagesAtTop` | boolean | |
| `rowGrouping` / `rowOrder` | string[] | |
| `rowData` | array | |
| `rowLabel` | string | |
| `formatClock` / `formatAbsoluteTime` / `formatRelativeTime` | string | |
| `formatForecastTime` | [`ForecastTimeFormat[]`](#forecasttimeformat) | |
| `tiles` | [`TileConfiguration`](#tileconfiguration) | |
| `occupancy` | [`OccupancyConfiguration`](#occupancyconfiguration) | |
| `frames` | object | free-form, additional properties |

Schema also allows arbitrary `additionalProperties: true` (unlisted fields
may appear).

### ForecastTimeFormat
| Field | Type | Notes |
|---|---|---|
| `type` | string | e.g. `RelativeTime` |
| `time` | string? | e.g. `"00:30:00"` |

### TileConfiguration
| Field | Type | Notes |
|---|---|---|
| `renderer` | string? | |
| `urlTemplate` | string (uri) | map tile URL template |
| `options` | object[]? | free-form |

### OccupancyConfiguration
| Field | Type |
|---|---|
| `levels` | [`OccupancyLevel[]`](#occupancylevel) |

### OccupancyLevel
| Field | Type |
|---|---|
| `from` / `to` | number |
| `image` | string |
| `label` | string |
| `description` | string |

### Line
| Field | Type | Notes |
|---|---|---|
| `id` | integer (int64) | |
| `text` | string | e.g. `"Grön - Grön. Tuolluvaara - Nya C - Lombolo - Gamla C - Porfyren"` — Swedish color name embedded here, no separate color field |

### Direction
| Field | Type |
|---|---|
| `id` | integer (int64) |
| `text` | string, e.g. `"1"` |

### Location
| Field | Type | Notes |
|---|---|---|
| `alt` | number? | default 0 |
| `lat` | number | required |
| `lon` | number | required |

### StopArea
| Field | Type | Notes |
|---|---|---|
| `id` | integer (int64) | required |
| `externalId` | string? | e.g. `"84064"` |
| `text` | string | required, e.g. `"Stadshustorget (84064)"` |
| `location` | [`Location`](#location)? | nullable — ⚠ **unset by `GetStopAreas`** (0 of 45 Kiruna stops had it); `FindStopArea` does return it for the same stop text |

### FindStopAreaRequest
| Field | Type | Required |
|---|---|---|
| `StopAreaQuery` | string | yes |

### FindStopsNearLocationRequest
| Field | Type | Required | Notes |
|---|---|---|---|
| `coordinate` | [`Location`](#location) | yes | |
| `maxCount` | integer? | no | |
| `maxDistance` | number? | no | per service configuration |

### GetStopAreasRequest
| Field | Type | Required | Notes |
|---|---|---|---|
| `lineId` | integer (int64) | yes | |
| `directionId` | integer (int64)? | no | `null` accepted → all directions |

### GetCallsRequest
| Field | Type | Required |
|---|---|---|
| `query` | [`CallsQuery`](#callsquery) | yes |
| `configuration` | [`CallsConfiguration`](#callsconfiguration) | yes |

### CallsQuery
| Field | Type | Required | Notes |
|---|---|---|---|
| `fromStopAreaQuery` | string | yes | e.g. `"Stadshustorget (84064)"` |
| `toStopAreaName` | string | yes | `""` for no filter |
| `lineId` | integer (int64) | yes | `0` = all lines |
| `directionId` | integer (int64) | yes | `0` = no direction filter |

### CallsConfiguration
| Field | Type | Required | Notes |
|---|---|---|---|
| `grouping` | string[] | yes | e.g. `["Line", "Destination1"]` |

### GetCallsResponse
| Field | Type | Required |
|---|---|---|
| `isStopCancelled` | boolean | yes |
| `calls` | [`CallGroup[]`](#callgroup) | yes |
| `messages` | [`TrafficMessage[]`](#trafficmessage) | yes |

### CallGroup
| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | e.g. `"l:110000548/dest1:110001090"` |
| `calls` | [`TransitCall[]`](#transitcall) | yes | flatten across groups for a single departures list |

### TransitCall
| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | call id — pass to `GetVehiclePosition`. ⚠ Observed to be per-(journey, remaining stop): the same journey gets a **new, distinct `id` at every upcoming stop along its route** (one journey observed with 37 distinct call ids). To track one physical bus without redundant polling, group calls by `journeyId` and use only the call for the stop with the earliest future `forecastTime` (see `journeyId` row below and `server/lib/tracker.js`). |
| `key` | string | yes | e.g. `"1"` |
| `lineId` | integer (int64) | yes | |
| `routeId` | integer (int64) | yes | pass to `GetMapRoute` |
| `journeyId` | integer (int64) | yes | Identifies one real trip/vehicle-run. Stable across the many per-stop `id`s of the same journey — the right key for deduplicating "which calls belong to the same bus" instead of `id`. A journey can have 2 physical vehicles (main + reinforcement/"extra" bus) sharing one `journeyId`, distinguishable by having 2 different `id`s at the same `sequenceNumber`. |
| `stopPointId` | integer (int64) | yes | |
| `sequenceNumber` | integer (int32) | yes | Position of this call's stop along the journey's **whole route** — ⚠ **not** a countdown to the next stop (values of 17 and 20 observed for a bus's immediate next stop). Useful as a tie-breaker for ordering, but to find "where is this bus headed next", pick the call whose `arrival ?? departure` `forecastTime` is the earliest one still in the future. |
| `line` | string | yes | e.g. `"Röd."` |
| `lineAppearance` | [`LineAppearance`](#lineappearance) | yes | ⚠ observed unreliable for color |
| `journey` | string | yes | |
| `destination` | string | yes | |
| `subdestination` | string | yes | |
| `arrival` | [`Forecast`](#forecast)? | no | nullable |
| `departure` | [`Forecast`](#forecast)? | no | nullable |
| `createdTime` | string (date-time) | yes | |

### Forecast
| Field | Type | Required | Notes |
|---|---|---|---|
| `journeyType` | string? | no | e.g. `"Ordinary"` |
| `forecastTime` | string (date-time) | yes | use for delay math (not display strings) |
| `plannedTime` | string (date-time) | yes | |
| `quality` | string | yes | e.g. `"realtime"` |
| `attributes` | string[] | yes | |
| `designation` | string? | no | e.g. `"A"` |
| `vehicleType` | string? | no | |
| `occupancyPercent` | number? | no | |

### LineAppearance
| Field | Type | Notes |
|---|---|---|
| `background` | string? | hex color, e.g. `"#000000"` — ⚠ unreliable |
| `foreground` | string? | hex color |
| `fontStyle` | string? | e.g. `"regular"` |

### TrafficMessage
| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | integer (int64) | yes | |
| `text` | string | yes | |
| `priority` | integer? | no | |
| `affectedCalls` | string[] | yes | call ids affected by this message |
| `isDisturbance` | boolean | yes | |
| `isInfo` | boolean | yes | |
| `lines` | [`MessageLine[]`](#messageline)? | no | |

### MessageLine
| Field | Type |
|---|---|
| `lineId` | integer (int64) |
| `lineName` | string |
| `lineAppearance` | [`LineAppearance`](#lineappearance) |

### MapRoute
| Field | Type | Required |
|---|---|---|
| `lineAppearance` | [`LineAppearance`](#lineappearance) | no |
| `locations` | [`Location[]`](#location) | yes — ordered polyline points |

### VehiclePosition
| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | ⚠ echoes the requested `callId`, NOT a stable vehicle id |
| `displayName` | string? | no | |
| `classes` | string[] | yes | |
| `timestamp` | string (date-time) | yes | use to compute position age/staleness |
| `heading` | number | yes | degrees |
| `location` | [`Location`](#location) | yes | |

### SystemTimestamp
| Field | Type | Required |
|---|---|---|
| `systemTimestamp` | string (date-time) | yes |
| `clientTimestamp` | string (date-time) | yes |

---

## Summary of observed API quirks

These are the behaviors the raw [`openapi.yaml`](../openapi.yaml) contract doesn't capture,
discovered by exercising the live API while building the app (full context
in `initial_plan.md`'s "Post-implementation revisions" sections):

1. `ConfigOptions.centerLat/centerLon` return a generic non-town-specific
   default — don't use them for an initial map center tied to a specific
   town.
2. `lineAppearance` (on `TransitCall`, `MapRoute`, `MessageLine`) is
   unreliable for line coloring — derive color from the line's display
   text instead.
3. `GetVehiclePositions` (plural, bulk) reliably returns `[]` even with
   active buses — use `GetVehiclePosition` (singular) for one
   representative call per journey instead.
4. `VehiclePosition.id` is just the echoed `callId`, not a stable vehicle
   identity — dedupe physical vehicles by `(lat, lon, timestamp)`. ⚠ But
   see quirk #9: that dedupe merges *different journeys*, so which
   journey's metadata you keep matters.
5. Neither schema exposes an explicit "in service" flag — infer it from
   `VehiclePosition.timestamp` age.
6. `GetStopAreas` accepts `directionId: null` for an all-directions query.
7. `GetCalls` accepts `lineId: 0` for an all-lines-at-this-stop query.
8. `TransitCall.id` changes at every remaining stop along a journey's
   route (one journey observed with 37 distinct call ids for 37 upcoming
   stops) — polling `GetVehiclePosition` for every call id town-wide sends
   far more requests than there are real buses (176 call ids observed for
   only 12 running journeys at that moment). Group by `journeyId` and use
   one representative call per journey instead (see quirk #10 for which).
9. `GetVehiclePosition` returns the **same GPS fix for several different
   `journeyId`s** — a physical bus reports the same position for its
   *later trips of the day*, not just its current one (observed live: 4
   running Yellow journeys collapsed onto only 2 distinct positions). When
   deduping positions onto physical vehicles, pick the journey whose next
   forecast is soonest in the future; keeping whichever result arrives
   first will mislabel buses with a future journey's next stop.
10. `GetStopAreas` returns every `StopArea` with `location` **unset**
    (0 of 45 Kiruna stops had coordinates), while `FindStopArea` *does*
    return `location` for the same stop text. Resolve stop coordinates via
    `FindStopArea` — once per stop, since stops don't move.
11. `GetCalls` appears to prune calls the vehicle has already passed, so
    the lowest `sequenceNumber` and the earliest future `forecastTime`
    normally identify the same "next stop" (verified identical for all 15
    running journeys at one sample). Prefer selecting by earliest future
    `forecastTime` anyway: it structurally cannot surface an already-passed
    stop if a response is stale or cached. Note `sequenceNumber` is a
    position along the whole route (values of 17, 20 seen for a next stop),
    **not** a countdown where 0 means "next".
