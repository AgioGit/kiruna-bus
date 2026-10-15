# Kiruna Live Bus Tracker

A browser-based live transit map for Kiruna, Sweden, built with plain
HTML/CSS/JavaScript and Leaflet, plus a small native Node HTTP server.
The Boreal AnyRide API sends no CORS headers, so browsers cannot call it
directly. The server fetches and caches the data once and serves both the
versioned application API the page uses and the page itself. Ajv validates data
at the server boundary. There is no application build step or database.

## Features

- All discovered bus routes, colored by their Swedish line names. Route
  geometry and map polylines are reused while browsing instead of rebuilding
  every route on updates. Differently colored routes sharing a road run in
  parallel lanes with a 1 px gap, returning to the road center where they
  split; nearby bus markers follow their line's lane. Unshared stretches
  and buses far from their route retain their original positions.
- The API's LKAB-bound red route currently misses Skrädaregatan; only its
  Adolf Hedinsvägen–LKAB map segment uses the reverse of the API's return
  route. Stop times and the rest of the route are unchanged.
- Upright bus symbols inside route-colored circles, with a small arrow on
  the circle's edge showing direction. Bus symbols are white in light mode
  and black in dark mode; circles keep their route colors. Arrows use each
  reported heading, falling back to the nearest route segment oriented toward
  the next stop.
  When neither is available, the bus remains visible without an arrow.
- Live bus cards are grouped by line color in a stable order rather than
  reshuffling by ETA. They show line, destination, next stop, expected time,
  planned time when it differs, last update, and position freshness. Buses
  with older positions fade to match their map markers. Buses
  whose next stop is more than 10 minutes away are hidden. Late expected
  times show a red `(+N min)` immediately after the time, including trip
  stops and stop departures. Stop departures are ordered by planned time,
  earliest first, regardless of live ETA changes; missing planned times
  appear last.
- Select a bus card to pan to and highlight that bus; its tooltip closes after
  three seconds while the highlight remains. Click a bus marker to select it
  too, or select it again to clear it. The selected card previews its next
  three stops and offers the rest on demand, with expected times and delays.
  Hovering or selecting a bus draws an animated dotted path along its rendered
  route lane, including shared-road offsets and junction tapers, to its
  next three upcoming stops when available (direct connections until route
  geometry loads).
  The dots render above route lines but below stop markers.
  The dots stop moving when reduced motion is requested.
- All bus stops shown as clickable circles; selecting one displays its
  departures and centers the map on that stop. Stops can also be selected
  through autocomplete or a map click.
- Save favorite stops locally for one-tap arrivals, or ask for nearby stops
  using browser location permission.
- In this map-first layout experiment, Lines and Find a stop are expandable
  buttons on the map. Only one panel opens at a time; close it with its
  button, the close control, Escape, or a click outside. The Lines button
  shows the active line count; filters apply to routes, vehicle markers,
  and departure and bus cards. Find a stop contains text search, saved stops
  and a Near me button. Location is requested only by pressing Near me;
  results persist when closed and the same button can retry. Selecting a
  stop closes the finder and displays its departures, with Clear and
  Save this stop controls in that departures panel.
- Live snapshots arrive over server-sent events after shared collection
  cycles (30 seconds by default). If no valid snapshot arrives for 60 seconds,
  the browser requests the cached snapshot over HTTP while reconnecting.
  Hidden tabs close the stream and pause requests; visible tabs reconnect
  immediately. Existing bus markers move in place rather
  than being recreated. Notices appear inline after the countdown without
  shifting the layout; long messages can be scrolled horizontally by touch
  or keyboard. Transient notices fade after 10 seconds; ongoing failures
  remain visible. Routine counts of expired GPS reports are not shown.
- Missing buses retain their last known position and original Updated time,
  including when their calls disappear from a scan. Positions older than
  three minutes are hidden from both the map and list, even when selected;
  they also expire between delivered snapshots.
- On phones and tablet portrait, a larger map comes first, followed by
  departures and live buses; tablet landscape and
  desktop use a full-height map with a compact sidebar. Bus
  and departure cards fit narrow screens without horizontal scrolling.
  The desktop sidebar stays within the viewport and the live-bus panel
  scrolls when expanding trip details.
- Touch-sized controls plus keyboard navigation for stop suggestions and live
  bus selection.
- Light and dark themes: follows the system setting by default, with a header
  button to override it (saved in the browser). The map tiles are inverted in
  dark mode.

## Run locally

Requires Node 22.11 or newer (Node 22 LTS in CI and Docker). From the repository root:

```powershell
cd server
npm ci
node index.js
```

Then open <http://localhost:8080/>. The server serves the frontend from
`src/` and the API under `/api`. An internet connection is required for
Leaflet/OpenStreetMap assets and the Boreal API. Nearby stops require browser
location permission and a secure context (HTTPS or localhost); favorites are
saved in that browser's local storage. See [server/README.md](server/README.md)
for configuration, endpoints, tests and deployment (including Docker).

After installing the server dependencies, run `node --test` from the repository
root. Browser checks run from `server/` with `npx playwright install chromium`
and `npm run test:browser`; they use a local fake upstream and local Leaflet
assets, not Boreal or external tile services.

## How live tracking works

The server (`server/lib/tracker.js`) does the scanning. One shared collector
runs while an SSE client is connected or a live-data HTTP request has arrived
within the last two minutes. Probes do not keep collection active. When activity
ends, collection stops so the host can scale to zero. Outbound requests share a
bounded queue:

1. Every 30 seconds by default it fetches calls for all known stops and groups them by
   `journeyId`, storing each journey's ordered stop list with
   planned/forecast times. Complete stop responses also supply cached departures,
   cancellations, and disruption messages.
2. In the same cycle it calls `GetVehiclePosition` for each journey's
   stored call id (any call id of a journey returns the same bus position).
3. It deduplicates identical `(latitude, longitude, timestamp)` fixes into
   physical buses. Because the API also maps later journeys to the same bus,
   the journey with the nearest future forecast supplies the displayed
   destination and the next two stops ("Next stop" and "Then") with their
   expected times.

The page connects to `/api/v1/stream` and receives every bus ready to display
after each cycle, including each bus's upcoming stops for the trip view.
`/api/v1/buses` provides the same snapshot for startup and the 60-second
delivery watchdog. Neither HTTP fallback nor additional viewers create
independent upstream scans. The town-wide `GetVehiclePositions` endpoint is not used: it returns no
buses even while the per-call position endpoint works. Stop coordinates are
resolved by the server because `GetStopAreas` returns Kiruna stops without
locations. The page initially uses a validated bundled basic catalog, or a newer
compatible IndexedDB copy, without waiting for a live scan. The catalog includes
lines, located stops, and corrected route shapes, never live positions or
departures. It is labeled with its capture time. Static source information is
checked every 15 minutes while clients are active; only validated complete
catalogs replace the accepted one.

Live responses report freshness and partial coverage separately from response
creation time. Cold live requests return `503` with `Retry-After` rather than
holding the page open for a scan. Expired positions disappear after three
minutes even during an outage. Connection heartbeats do not count as data
updates or refresh GPS timestamps. HTTP failures back off independently of
stream reconnection. The original unversioned API remains temporarily for
already-open pages.

## Hosting the page separately

If the page is hosted elsewhere (for example GitHub Pages), set `apiBase` in
`src/runtime-config.js` to the server's API URL
(`https://your-server.example.com/api`) and set `ALLOWED_ORIGINS` on the
server to the page's origin.

## Project structure

```text
src/                  Static web application
  index.html
  css/app.css
  js/*.js             ES modules; no bundler
server/               Node server: cached Boreal API client, /api, static hosting
  data/bootstrap.json Validated basic-data snapshot included in the container
docs/API.md           Endpoint and schema reference plus observed quirks
docs/DATA_FLOW.md     Current runtime architecture and data flow
docs/initial_plan.md  Historical design plan and implementation revisions
application.openapi.json Website API contract; schemas shared with validation
openapi.yaml          Upstream Boreal API reference
```

See [API documentation](docs/API.md) and
[current data flow](docs/DATA_FLOW.md) for implementation details.

## API background

The API is used by the real-time information page at
<https://lokaltrafikenkiruna.se/realtidsinformation/>, which embeds the Boreal
AnyRide client at <https://boreal.tmix.se/anyride/>. The client calls:

```text
https://boreal.tmix.se/Tmix.Cap.Ti.Process.AnyRide/api/
```

The machine-readable contract is available in [openapi.yaml](openapi.yaml).

## Support and stability

This is an internal API used by the public AnyRide web client. It does not
publish Swagger or other official API documentation. No authentication was
required when the API was inspected on 2026-09-07, but endpoints, headers, and
response formats may change without notice.

The upstream API does not send CORS headers, so browsers cannot read its
responses from another origin. This project's server fetches it server-side
(see [server/README.md](server/README.md)).

## Kiruna profile

Call `GetConfigOptions` first. Its response identifies the data and display
profiles used by subsequent requests:

```json
{
  "profileData": "boreal_kiruna",
  "profileDisplay": "boreal"
}
```

Send those values as headers on all data requests:

```http
anyride-profile-data: boreal_kiruna
anyride-profile-display: boreal
```

Without `anyride-profile-data`, endpoints such as `GetLines` may return data
for all Boreal areas instead of only Kiruna.

## Available calls

| Method | Endpoint | Input | Response |
|---|---|---|---|
| `GET` | `/GetConfigOptions` | Query: `profile`, `language` | `ConfigOptions` |
| `GET` | `/Autocomplete` | Query: `query` | `string[]` |
| `POST` | `/FindStopArea` | `FindStopAreaRequest` | `StopArea` or `null` |
| `POST` | `/FindStopsNearLocation` | `FindStopsNearLocationRequest` | `StopArea[]` |
| `GET` | `/GetLines` | None | `Line[]` |
| `GET` | `/GetDirections` | Query: `lineId` | `Direction[]` |
| `POST` | `/GetStopAreas` | `GetStopAreasRequest` | `StopArea[]` |
| `POST` | `/GetCalls` | `GetCallsRequest` | `GetCallsResponse` |
| `GET` | `/GetMapRoute` | Query: `routeId` | `MapRoute` |
| `GET` | `/GetVehiclePosition` | Query: `callId` | `VehiclePosition` or `null` |
| `GET` | `/GetVehiclePositions` | None | `VehiclePosition[]` |
| `GET` | `/GetSystemTimestamp` | Query: `clientTimestamp` | `SystemTimestamp` |

All request and response schemas are defined in
[`openapi.yaml`](openapi.yaml).

## Identifier flow

The APIs use several different identifiers:

| Identifier | Obtained from | Used by |
|---|---|---|
| `lineId` | `GetLines`, `GetCalls` | `GetDirections`, `GetStopAreas`, `GetCalls` |
| `routeId` | A call returned by `GetCalls` | `GetMapRoute` |
| `callId` | The `id` of a call returned by `GetCalls` | `GetVehiclePosition` |
| Stop query | `Autocomplete` or a `StopArea.text` value | `FindStopArea`, `GetCalls` |

`StopArea.id` and `StopArea.externalId` are numeric identifiers. The stop
query expected by `GetCalls` is normally the display string, for example
`Stadshustorget (84064)`, rather than only the numeric ID.

## Examples

### Configuration

```http
GET https://boreal.tmix.se/Tmix.Cap.Ti.Process.AnyRide/api/GetConfigOptions?profile=&language=sv
```

The configuration response also contains map settings, localized UI text,
formatting settings, and asset URLs.

### Lines

```powershell
$headers = @{
    "anyride-profile-data" = "boreal_kiruna"
    "anyride-profile-display" = "boreal"
}

Invoke-RestMethod `
    -Uri "https://boreal.tmix.se/Tmix.Cap.Ti.Process.AnyRide/api/GetLines" `
    -Headers $headers
```

The Kiruna line catalog observed on 2026-09-07 was:

```json
[
  {
    "id": 110000550,
    "text": "Grön - Grön. Tuolluvaara - Nya C - Lombolo - Gamla C - Porfyren"
  },
  {
    "id": 110000547,
    "text": "Gul. - Gul. Lombolo - Gamla Centrum - Porfyren"
  },
  {
    "id": 110000551,
    "text": "Lila. - Lila. Lombolo - Centrum - Hagelstigen - Porfyren"
  },
  {
    "id": 110000548,
    "text": "Röd. - Röd. Tuolluvaara - Nya Centrum - LKAB"
  }
]
```

### Stop autocomplete

```http
GET /Autocomplete?query=Stadshus
anyride-profile-data: boreal_kiruna
anyride-profile-display: boreal
```

Example response:

```json
[
  "Stadshustorget (84064)"
]
```

The query can contain either a stop name or a stop number.

### Stops for a line

```http
POST /GetStopAreas
Content-Type: application/json
anyride-profile-data: boreal_kiruna
anyride-profile-display: boreal

{
  "lineId": 110000550,
  "directionId": null
}
```

`directionId` may be `null` when the configuration property `useDirection` is
false.

### Nearby stops

```http
POST /FindStopsNearLocation
Content-Type: application/json
anyride-profile-data: boreal_kiruna
anyride-profile-display: boreal

{
  "coordinate": {
    "lat": 67.8558,
    "lon": 20.2253
  },
  "maxCount": null,
  "maxDistance": null
}
```

### Departures

```http
POST /GetCalls
Content-Type: application/json
anyride-profile-data: boreal_kiruna
anyride-profile-display: boreal

{
  "query": {
    "fromStopAreaQuery": "Stadshustorget (84064)",
    "toStopAreaName": "",
    "lineId": 0,
    "directionId": 0
  },
  "configuration": {
    "grouping": [
      "Line",
      "Destination1"
    ]
  }
}
```

The response groups departures by line and destination:

```json
{
  "isStopCancelled": false,
  "calls": [
    {
      "id": "l:110000548/dest1:110001090",
      "calls": [
        {
          "id": "84120839",
          "key": "1",
          "lineId": 110000548,
          "routeId": 540298,
          "journeyId": 15207312,
          "stopPointId": 118406401,
          "sequenceNumber": 4,
          "line": "Röd.",
          "lineAppearance": {
            "background": "#000000",
            "foreground": "#FFFFFF",
            "fontStyle": "regular"
          },
          "journey": "35",
          "destination": "LKAB Kiruna",
          "subdestination": "",
          "departure": {
            "journeyType": "Ordinary",
            "forecastTime": "2026-09-07T15:44:00+02:00",
            "plannedTime": "2026-09-07T15:44:00+02:00",
            "quality": "realtime",
            "attributes": [],
            "designation": "A"
          },
          "createdTime": "2026-09-07T15:35:30.3130578+02:00"
        }
      ]
    }
  ],
  "messages": []
}
```

A call can contain `arrival`, `departure`, or both. Forecast objects may also
contain `vehicleType` and `occupancyPercent`.

### Route geometry

Pass a `routeId` returned by `GetCalls`:

```http
GET /GetMapRoute?routeId=540298
anyride-profile-data: boreal_kiruna
anyride-profile-display: boreal
```

The response contains a line appearance and an ordered coordinate array.

### Vehicle position

Pass a call `id` returned by `GetCalls`:

```http
GET /GetVehiclePosition?callId=84120839
anyride-profile-data: boreal_kiruna
anyride-profile-display: boreal
```

The endpoint returns `null` when no live position is available.

## Sources

- Public page: <https://lokaltrafikenkiruna.se/realtidsinformation/>
- Embedded client: <https://boreal.tmix.se/anyride/>
- Client bootstrap configuration:
  <https://boreal.tmix.se/anyride/app.config.json>
- Client source map:
  <https://boreal.tmix.se/anyride/app.bundle.js.map>
