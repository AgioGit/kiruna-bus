# Current data flow

The application is served by one scale-to-zero Node container. The browser uses
the versioned application API, not Boreal's protocol. See
[the application contract](../application.openapi.json) and
[server operations](../server/README.md). `openapi.yaml` and `API.md` describe
the separate upstream API; `initial_plan.md` is historical.

## Startup

```text
Container starts
  -> load configuration and validate bundled catalog (fail explicitly if invalid)
  -> listen for static assets, bootstrap, probes, and API calls
  -> start one bounded live warmup, without holding bootstrap requests

Browser loads
  -> read compatible IndexedDB basic catalog, if available
  -> fetch /api/v1/bootstrap and keep the newer compatible capture
  -> populate lines, stop locations, route catalog, and corrected geometry
  -> initialize UI/map and show catalog provenance/capture time
  -> poll live buses and selected-stop departures
```

One container still means the first navigation waits for the host's cold start.
After that, basic information does not wait for a Boreal scan. IndexedDB failures
are nonfatal and visible. If basic API startup fails, the map shell and error
remain usable rather than stopping the entire application initialization.

The bundled file and IndexedDB contain only public basic information. They do
not contain positions, departures, personal location, or upstream profile
headers. A newer compatible browser catalog is not overwritten by an older
bundled fallback. Browser writes also compare captures inside one transaction.

## Backend boundaries

`server/app.js` constructs a testable HTTP application; `server/index.js` handles
listening, startup warmup, and bounded shutdown. Importing the application does
not start a listener or contact Boreal.

All upstream calls use `server/lib/boreal.js`: one scheduler, successful-result
cache, canonical request keys, in-flight coalescing, byte limits, and deadlines
through body consumption. Interactive requests have reserved capacity.
Transient retries are bounded; schema/permanent errors are not retried as if
they were network outages. Cancelling one waiter does not cancel shared work.

`server/schemas.json` is referenced by the application contract and compiled by
Ajv. Upstream validation accepts harmless additional fields but requires valid
essential coordinates, identifiers, timestamps, and shapes. Application DTOs
are normalized before they reach the browser.

## Basic catalog and routes

`catalog.js` serves the bundled catalog immediately. Bootstrap requests may
trigger an hourly shared background capture; failures preserve the previous
catalog and back off. Jobs have a whole-operation deadline and are disposable
if the host terminates the container.

The explicit `npm run snapshot` command uses the same validated capture logic.
It requires complete capture/coverage and writes atomically only on success.
It does not run in tests, image builds, or ordinary startup.

Route associations are discovered from calls and retained in the accepted basic
catalog for use outside service hours. The server applies the guarded LKAB
geometry correction. Unknown routes can be fetched lazily with a bounded
in-memory cache. The browser does not perform provider-specific discovery or
corrections; it still computes visual route overlap, lane offsets, heading
fallback, and dotted previews through up to three upcoming stops for selected
or hovered buses. Previews use the displayed route lane and fall back to fewer
stops when fewer are available.

Bootstrap, stops, and route resources support ETag revalidation. Current
`X-Server-Time` is separate from the catalog capture and original GPS times.

## Live snapshots and partial failures

`tracker.js` scans calls per stop about every three minutes and positions at most
every 15 seconds. Demand triggers one shared refresh, not permanent polling.
Startup is the sole unconditional warmup.

Successful stop results replace that stop's previous calls, including empty
results. Failed stops can retain their original results for two scan intervals.
Coverage explicitly reports attempted, successful, and failed stop counts.
Incomplete data is not reported as an entirely healthy scan.

Positions retain original GPS timestamps and newer known fixes win over
out-of-order responses. Journey/call-ID changes can reuse unexpired previous
fixes. Failed, absent, and expired fixes are distinguished in status. Positions
older than three minutes are omitted, including a selected bus.

`GET /api/v1/buses` never waits for a refresh. It returns a usable snapshot with
fresh/partial/stale quality, source-refresh timestamps, coverage, and reasons.
With no usable live picture it returns structured `503` plus `Retry-After`.
A fully successful empty service period remains a valid empty response.
Response assembly time is never used to rejuvenate a GPS fix.

The 15-second position refresh TTL and three-minute scan interval schedule
background work; reaching either is not itself a stale-data condition. Cached
responses remain usable during normal 60-second browser polling. Position
collection age becomes stale after three minutes, and scan age after the
two-interval retention window. GPS expiry is evaluated at response time, even
while a refresh is still running, so genuinely expired fixes are still hidden
and reported immediately. Expiry remains in quality metadata, not the
position-fetch error. The browser does not show a notice for GPS expiry alone
or counts of hidden expired reports. Other freshness and refresh failures still
show their warnings.

## Browser state and polling

The existing one-way flow remains:

```text
API/cache -> fetch/derive modules -> appState store -> map/UI subscribers
```

`config.js` applies basic catalogs while preserving filters, map position, and
the selected stop when still present. Removed selections are reconciled.
Favorites remain in their existing browser-local storage.

`api.js` covers response-body consumption with its deadline, removes abort
listeners, parses structured errors, and distinguishes cancellation, timeout,
network, and HTTP errors. It reads `Retry-After` and current server time.

`poller.js` uses non-overlapping completion-scheduled timers. Healthy polls stay
at 60 seconds; failures use capped jittered backoff. Countdown reflects the next
actual attempt. Hidden tabs abort/pause work and visible tabs refresh immediately.
Live and selected-stop requests use independent generation guards checked before
state writes, so selection changes and late responses cannot overwrite current
state. Basic-information fetches do not depend on successful live tracking.

`live-vehicles.js` expires positions between polls using server time plus
monotonic elapsed browser time. `calls.js` consumes flat departures and expires
their retained display after three minutes. UI status distinguishes cached basic
information, warming/unavailable tracking, partial coverage, stale departures,
and valid empty results.

Transient search, nearby-location, and optional browser-storage notices begin
fading after ten seconds. New notices replace old timers; unrelated refreshes
do not extend them. Active live-data, departure, route, and startup failures
remain visible until recovery or until their context is cleared.
Header notices sit inline after the refresh countdown in a fixed-height row,
with touch/keyboard horizontal scrolling for overflow, so showing and hiding
messages does not shift the map or other header controls.

Search/resolve/nearby endpoints use the server's local stop catalog. Nearby
coordinates are not forwarded to Boreal or included in request logs. Browser
geolocation remains an explicit user action.

## Operational and compatibility surfaces

Liveness is independent of Boreal. Readiness requires a usable basic catalog and
not draining, not active journeys. `/api/status` provides sanitized coverage,
timestamps, scheduler state, and bounded aggregate metrics.

API requests have per-client/global limits and explicit overload responses.
Forwarded IP addresses are trusted only with explicit configuration for one
trusted ingress. Logs contain request/refresh IDs and sanitized route names,
not raw queries or location payloads.

Unversioned bus/stop/health and allow-listed passthrough routes remain temporarily
for old pages. Their response shapes are preserved and use is counted.
Legacy removal is a later deliberate change, not part of this migration.

CI runs network-independent unit/HTTP and browser flows, then smoke-tests the
built image with upstream deliberately unavailable before publication. Production
deployment and rollback use immutable image references and remain manual.
