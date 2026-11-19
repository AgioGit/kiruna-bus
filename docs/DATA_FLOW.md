# Current data flow

The application is served by one scale-to-zero-capable Node container. The browser uses
the versioned application API, not Boreal's protocol. See
[the application contract](../application.openapi.json) and
[server operations](../server/README.md). `openapi.yaml` and `API.md` describe
the separate upstream API; `initial_plan.md` is historical. The current Azure
deployment is configured for one replica, including when idle.

## Startup

```text
Container starts
  -> load configuration and validate bundled catalog (fail explicitly if invalid)
  -> listen for static assets, bootstrap, probes, and API calls
  -> wait for live-client activity before collecting upstream data

Browser loads
  -> independently start traffic information polling without waiting for bootstrap
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

AnyRide upstream calls use `server/lib/boreal.js`: one scheduler, successful-result
cache, canonical request keys, in-flight coalescing, byte limits, and deadlines
through body consumption. Interactive requests have reserved capacity.
Transient retries are bounded; schema/permanent errors are not retried as if
they were network outages. Cancelling one waiter does not cancel shared work.

`server/schemas.json` is referenced by the application contract and compiled by
Ajv. Upstream validation accepts harmless additional fields but requires valid
essential coordinates, identifiers, timestamps, and shapes. Application DTOs
are normalized before they reach the browser.

## Optional local upstream capture

`LOCAL_DEBUG=true` on a loopback-bound non-production server creates one shared
`upstreamDebug.js` recorder, injected into both upstream adapters. Each actual
outbound attempt contributes one completed request/response pair, including
HTTP failures, partial bodies, retries, or network errors. Cache hits do not.
Capture does not duplicate requests or change collection activity.

The recorder redacts recognized credential fields and bounds body previews,
entry count, and serialized bytes. It stores nothing on disk and is cleared at
shutdown. Its read-only `/api/v1/debug/upstream` endpoint is disabled otherwise,
requires local/same-origin access, and disables response caching. Debugging
cannot be enabled on a public binding, with a trusted proxy, or in production.

Only a browser opened with `?debug=1` initializes the debug viewer. It polls
the bounded capture every two seconds while visible and expanded, supports
client-side call filtering and paused updates, and uses a read-only textarea
for pretty-printed JSON. It never requests more data from transit providers.
Failed reads remain explicit; retry hints survive pauses and visibility changes.

## Traffic information

The browser independently polls `/api/v1/traffic-info` every 60 seconds while
visible. It aborts on hide, refreshes on resume subject to failure backoff,
and ages and expires the result even without bus publications. The server's
separate `trafficInfo.js` client calls the fixed public traffic-feed path with
no AnyRide headers, shares one in-flight request and successful result per
process, bounds response size and time, and backs off failures. The source's
`ageSec` plus backend and browser elapsed time controls the 600-second limit;
the provider's HH:mm `updated` is display-only. Fresh empty, failed retained
notices, and unavailable/expired information remain distinct in state. The panel
is shown only when fresh or retained notices are present, on all screen sizes;
empty and unavailable states are hidden. On mobile it appears below the map.
All alerts are global and do not imply identities,
map filtering, or service changes. The source link is in the About section.

## Basic catalog and routes

`catalog.js` serves the bundled catalog immediately. The activity-gated
collector checks static source information every 15 minutes. Bootstrap reads
do not start independent captures. Failed captures back off. A degraded
capture can retain previous entries and publish validated additions.
Jobs have a whole-operation deadline and are canceled at shutdown.
Runtime route discovery reuses the dynamic calls cache rather than performing a
second town-wide call scan.
An initial capture waits for the in-flight dynamic cycle; only newly discovered
stops need extra bounded calls to discover routes not yet known to the tracker.
The tracker scans only the accepted catalog's stops. An absent stop, an
unresolved location, or a failed geometry fetch does not delete last-good data.
A line with no usable geometry can be accepted with an empty route list.

The explicit `npm run snapshot` command uses the same validated capture logic.
It requires complete capture/coverage and writes atomically only on success.
It does not run in tests, image builds, or ordinary startup.

Catalog content versions are independent of capture/check timestamps, so an
unchanged source check does not force a map rebuild.

Route associations are discovered from calls and retained in the accepted basic
catalog for use outside service hours. The server applies the guarded LKAB
geometry correction. A route cache miss requires recent live evidence; catalog
and cached routes remain readable without it. The browser does not perform provider-specific discovery or
corrections; it still computes visual route overlap, lane offsets, heading
fallback, and dotted previews. Selection draws to the last reported upcoming
stop with a known location, while hover previews up to three upcoming stops.
Stops with no forecast use their planned time.
The previews follow the displayed route lane; neither Tåg nor Flyg uses this
preview because their shapes are approximate.

Bootstrap, stops, and route resources support ETag revalidation. Current
`X-Server-Time` is separate from the catalog capture and original GPS times.

## Live snapshots and partial failures

One shared collector scans calls per stop and then vehicle positions every
30 seconds by default (configurable to 60 seconds). It is active while any SSE
connection is open or a live-data HTTP request has arrived within 120 seconds.
Probes and basic-catalog reads do not renew that activity window. The first live
client starts a cycle immediately; idle periods stop future scheduling. There
is no unconditional startup scan.

Dynamic cycles do not overlap with other dynamic cycles or accumulate catch-up
ticks. Each cycle commits departures and service evidence before GPS. When
there is GPS work, SSE can publish the calls first and publish positions in a
later revision. The GPS phase has its own ten-second deadline; settled fixes
are kept and GPS-only degradation does not trigger departure backoff. All
clients share the same collection, with no per-connection upstream loops.

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
The selected stop and the expanded, visible saved-stop board react to accepted
new dynamic revisions. `departure-reads.js` shares in-flight reads and recent
responses by stop, coalesces close calls/GPS publications, and applies
Retry-After and backoff. The board resolves favorites against the local catalog
and limits parallel reads. Board-initiated reads are passive: they do not
keep the collector active. Selected-stop reads are active by default unless
they reuse a board read already in flight or its recent result.

`live-vehicles.js` expires positions between snapshots using server time plus
monotonic elapsed browser time. Departures expire from a relative retention
budget computed using server wall-clock data age, not provider-adjusted time;
the browser measures remaining time monotonically. Only selected-stop detail
uses the historical observations. UI status distinguishes cached basic
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
