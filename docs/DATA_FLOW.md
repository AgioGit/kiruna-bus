# Current data flow

The application is served by one scale-to-zero-capable Node container. The browser uses
the versioned application API, not Boreal's protocol. See
[the application contract](../application.openapi.json) and
[server operations](../server/README.md). `openapi.yaml` and `API.md` describe
the separate upstream API; `initial_plan.md` is historical.

## Startup

```text
Container starts
  -> load configuration and validate bundled catalog (fail explicitly if invalid)
  -> listen for static assets, bootstrap, probes, and API calls
  -> wait for live-client activity before collecting upstream data

Browser loads
  -> read compatible IndexedDB basic catalog, if available
  -> fetch /api/v1/bootstrap and keep the newer compatible capture
  -> populate lines, stop locations, route catalog, and corrected geometry
  -> initialize UI/map and show catalog provenance/capture time
  -> open SSE and read the cached live snapshot once over HTTP
  -> apply pushed snapshots; read HTTP fallback after 60 seconds without data
  -> read selected-stop departures from the shared calls cache
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
listening and bounded shutdown. Importing the application does
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

`catalog.js` serves the bundled catalog immediately. The activity-gated
collector checks static source information every 15 minutes. Bootstrap reads
do not start independent captures. Failures preserve the previous catalog and
back off. Jobs have a whole-operation deadline and are disposable if the host
terminates the container. Runtime route discovery reuses the dynamic calls
cache rather than performing a second town-wide call scan.
An initial capture waits for the in-flight dynamic cycle; only newly discovered
stops need extra bounded calls to discover routes not yet known to the tracker.

The explicit `npm run snapshot` command uses the same validated capture logic.
It requires complete capture/coverage and writes atomically only on success.
It does not run in tests, image builds, or ordinary startup.

Catalog content versions are independent of capture/check timestamps, so an
unchanged source check does not force a map rebuild.

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

One shared collector scans calls per stop and then vehicle positions every
30 seconds by default (configurable to 60 seconds). It is active while any SSE
connection is open or a live-data HTTP request has arrived within 120 seconds.
Probes and basic-catalog reads do not renew that activity window. The first live
client starts a cycle immediately; idle periods stop future scheduling. There
is no unconditional startup scan.

Cycles do not overlap or accumulate catch-up ticks. A bounded cycle commits its
results before publication; snapshot readers do not see half-completed
call/position updates. All clients share the same collection, with no
per-connection upstream loops.

Successful stop results replace that stop's previous calls, including empty
results. Failed stops can retain their original results for six minutes,
independent of the collection interval. Complete per-stop responses retain
disruptions and cancellation flags for the departures endpoint.
Coverage explicitly reports attempted, successful, and failed stop counts.
Incomplete data is not reported as an entirely healthy scan.
The raw-call cache has a 1,000-stop/16-MiB bound. Limits surface as collection
failures instead of silently treating discarded source data as a healthy scan.

Positions retain original GPS timestamps and newer known fixes win over
out-of-order responses. Journey/call-ID changes can reuse unexpired previous
fixes. Failed, absent, and expired fixes are distinguished in status. Positions
older than three minutes are omitted, including a selected bus.

`GET /api/v1/buses` never waits for a refresh. Registering live activity may
restart the shared collector, but the response is a cache read. It returns a usable snapshot with
fresh/partial/stale quality, source-refresh timestamps, coverage, and reasons.
With no usable live picture it returns structured `503` plus `Retry-After`.
A fully successful empty service period remains a valid empty response.
Response assembly time is never used to rejuvenate a GPS fix.

Collection intervals are scheduling targets, not expiry thresholds. Cached
responses remain usable between cycles. Position collection age becomes stale
after three minutes, and scan age after the six-minute retention window.
GPS expiry is evaluated at response time, even
while a refresh is still running, so genuinely expired fixes are still hidden
and reported immediately. Expiry remains in quality metadata, not the
position-fetch error. The browser does not show a notice for GPS expiry alone
or counts of hidden expired reports. Other freshness and refresh failures still
show their warnings.

## Push delivery and browser recovery

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

`GET /api/v1/stream` delivers named `buses` events containing full snapshots and
`tracking-status` events when no usable snapshot exists. Reconnection always
starts from a full snapshot; there is no replay log. Snapshots include a process
epoch, monotonic publication revision, and catalog content version. HTTP and
SSE use the same ordering information. Connection/request generation guards
prevent late responses from an old connection or process from replacing newer
state; equal revisions do not recreate expired positions.

SSE comments keep connections alive but do not establish data freshness.
Connection counts are limited, slow readers have bounded pending data, and
shutdown explicitly closes streams within the existing drain budget.

The browser uses native EventSource separately from the finite-response HTTP
helper. A valid snapshot, including unchanged or empty service data, resets a
60-second delivery watchdog. Heartbeats, connection events, status-only events,
malformed data, and obsolete snapshots do not reset it. The watchdog requests
the cached HTTP snapshot and reconnects a silent stream; failed HTTP attempts
use capped jittered backoff. Reconnection continues independently of successful
HTTP fallback.

Hidden tabs close the stream and abort/pause network work; visible tabs
reconnect and read immediately. Live and selected-stop requests use independent
generation guards checked before state writes. Basic-information recovery does
not depend on successful live tracking. A catalog version change triggers
bootstrap revalidation instead of transferring static geometry in each push.
Selecting a stop reads departures immediately; newly published dynamic
revisions refresh the selected stop from the shared server cache.

`live-vehicles.js` expires positions between snapshots using server time plus
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

API requests and concurrent streams have per-client/global limits and explicit overload responses.
Forwarded IP addresses are trusted only with explicit configuration for one
trusted ingress. Logs contain request/refresh IDs and sanitized route names,
not raw queries or location payloads.

Unversioned bus/stop/health and allow-listed passthrough routes remain temporarily
for old pages. Their response shapes are preserved and use is counted.
Legacy removal is a later deliberate change, not part of this migration.

CI runs network-independent unit/HTTP and browser flows, then smoke-tests the
built image with upstream deliberately unavailable before publication. Production
deployment and rollback use immutable image references and remain manual.
