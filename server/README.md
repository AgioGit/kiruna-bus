# Boreal bus server

Native Node HTTP server with Ajv schema validation. Node 22.11+ is required;
Docker and CI use Node 22 LTS. No database, application build, or external cache
service is needed.

```powershell
cd server
npm ci
node index.js
```

Open <http://localhost:8080/>. The same process serves `src/` and `/api`.
Internet access is needed for live Boreal data and the production map assets,
but the basic catalog is included in the image.

## Startup and freshness

The container must start before the page can load; scale-to-zero still has a
hosting cold start. Once running, bootstrap and known routes are served without
waiting for Boreal. A newer compatible IndexedDB catalog can be used by returning
visitors. Storage denial is nonfatal and visible in status.

Only basic map settings, lines, stops, route associations, and corrected geometry
are persisted. The UI labels cached information with its capture time. This is
not a cached timetable or a guarantee that live tracking is available.

Live-client activity starts one shared collector. It runs while an SSE
connection is open or a live-data HTTP read has arrived within 120 seconds.
Probes and basic-catalog requests do not renew this window; no unconditional
startup warmup contacts Boreal. Once idle, the collector stops scheduling work
so the host can scale to zero. Existing snapshots return immediately while
collection runs. With no usable live snapshot, the HTTP API returns `503`
(`WARMING_UP` or `LIVE_UNAVAILABLE`) and `Retry-After: 5`.

The collector scans stop calls and then positions every 30 seconds by default
(configurable to 60 seconds). Cycles do not overlap or queue catch-up work.
Failed stops retain their original results for at most six minutes,
independent of the configured interval, and are reported as partial coverage.
The shared raw-call cache is bounded to 1,000 stops and 16 MiB. Over-budget
results count as failed coverage; a failed combined-cache commit preserves the
previous snapshot rather than publishing an apparently complete truncated scan.
Position fixes retain their
GPS timestamp and disappear immediately after three minutes. Successful empty
service, failed scans, missing fixes, and partial failures are distinct.

Collection intervals are scheduling targets, not snapshot expiry thresholds.
The previous successful snapshot remains usable between cycles. Position
collections become stale after three minutes without a refresh, scans after
six minutes, and expired GPS fixes
are reported at read time even while background work is pending. Expired fixes
are counted in quality metadata rather than reported as a position-fetch error.
The browser suppresses routine expired-report counts and notices for GPS expiry
alone; other freshness and refresh failures remain visible inline after the
update countdown.

The browser receives full snapshots over SSE after dynamic cycles. A valid
snapshot, including unchanged or empty service data, resets a 60-second delivery
watchdog. Without one, the browser reads the cached HTTP snapshot while
reconnecting the stream. Heartbeats, status-only messages, and invalid/obsolete
snapshots do not reset the watchdog. HTTP failures retry with jittered
exponential backoff, capped at five minutes; server retry hints are honored
within that cap. Hidden tabs close streams and pause network work; visible tabs
reconnect and read immediately. GPS expiry continues independently of network
activity.

Selected-stop departures are read immediately and after new dynamic
publications, using the collector's complete per-stop response cache rather
than starting another upstream call. Cancellation and disruption messages are
preserved. Failed refreshes label retained departures stale, and departure
responses and browser display expire after three minutes.

## Application API

The machine-readable contract is [application.openapi.json](../application.openapi.json).
It references the same [schemas.json](schemas.json) used by the server.
`../openapi.yaml` describes Boreal, not this application.

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/bootstrap` | Basic catalog with schema/content version, capture time, provenance, source, and server time. |
| `GET /api/v1/buses` | Cached vehicles, route associations, quality, epoch/revision, and catalog version. Registers activity but never waits for collection. |
| `GET /api/v1/stream` | Full `buses` SSE events and explicit `tracking-status` events; registers activity until disconnected. |
| `GET /api/v1/stops` | Located stop catalog. |
| `GET /api/v1/stops/:id/departures` | Flat departures, disruptions, cancellation state, `updatedAt`, and `fresh`/`stale` state. |
| `GET /api/v1/routes/:id` | Corrected display-ready geometry. |
| `GET /api/v1/search?q=...` | Up to 20 catalog stop strings matching a name or number. |
| `GET /api/v1/resolve?q=...` | Exact stop string lookup, or `null`. |
| `POST /api/v1/nearby` | Local catalog lookup; body `{coordinate:{lat,lon},maxCount,maxDistance}`. Defaults: 5 results within 1000 m; limits: 20 results and 50 km. Location is not sent to Boreal. |
| `GET /api/live` | Process liveness, independent of upstream. |
| `GET /api/ready` | Valid basic catalog and not draining; does not require running buses. |
| `GET /api/status` | Sanitized freshness/coverage, queue status, and bounded aggregate metrics. No upstream calls. |

Basic resources support ETags. Responses use `Cache-Control: no-cache`, allowing
revalidation rather than silently keeping stale deployments. `X-Server-Time`
provides current server time, including on `304`; catalog `capturedAt` and GPS
timestamps are independent. The frontend never initializes Boreal profile headers.

Errors use `{error:{code,message,requestId}}`. Validation errors use `400`, wrong
methods `405` with `Allow`, bodies over 64 KiB `413`, unsupported media `415`,
request limits `429`, upstream failures `502`/`504`, and warming/overload `503`.
Retryable overload and rate-limit responses include `Retry-After` in seconds.

SSE uses `text/event-stream`, disables caching/transformation and proxy buffering,
and sends heartbeat comments every 15 seconds. A connection immediately receives
the latest full snapshot or warming/unavailable status. Event IDs and snapshot
metadata identify a process epoch and monotonic publication revision; there is
no replay history, and reconnection always resynchronizes with a full snapshot.
`tracking-status` reports failure after headers have been sent, when an HTTP
status can no longer change. A connected stream is not proof of fresh GPS.

Snapshots advertise the static catalog content version. Clients re-fetch
bootstrap when it changes; they do not receive route geometry in every push.
Capture/check timestamps do not change the content version by themselves.

Legacy `/api/buses`, `/api/stops`, `/api/health`, and allow-listed Boreal passthrough
routes remain temporarily with their old response shapes. Legacy use is counted.
Do not build new clients against them; removal is a separate change after usage
is assessed. The legacy bus route can still wait for the shared due/in-flight refresh, without
starting an extra collection cycle.

## Upstream protection and operations

All upstream work shares coalescing, successful-response caches, byte bounds, a
bounded scheduler, and deadlines covering response bodies. One concurrency slot
is reserved for interactive work. Caller cancellation does not cancel shared
refreshes. Only transient failures are retried once; invalid payloads and
permanent errors do not enter successful caches.

Structured JSON logs include request/refresh IDs, sanitized endpoint names,
durations, cache/refresh outcomes, coverage, and stable failure codes. They do
not include arbitrary query text, raw payloads, or nearby-search coordinates.
`/api/status` exposes aggregate counters/timings and current data ages through
timestamps, not per-user or arbitrary-ID metric labels.

Use liveness for restarts and readiness for ingress. Do not restart the process
because Boreal is down or because there are no active buses. A valid bundled
catalog makes the basic application ready during live-data outages. Shutdown
stops new API work and aborts owned upstream jobs, with a five-second drain
deadline.

Concurrent streams have global and per-client limits in addition to HTTP
request-rate limits. Requests rejected by either request-rate limit do not
consume request quota, so a blocked client cannot exhaust other clients'
remaining global allowance. Slow readers may retain only the latest pending
snapshot; bounded pending bytes and a drain deadline prevent unbounded buffering.
Disconnect and shutdown remove listeners and timers. `/api/status` reports
collector activity, cycle timing, and stream health without user-specific
metric labels. Use the same explicitly trusted ingress/IP policy for both
connection and request limits.

## Configuration

Invalid configuration fails startup instead of silently using defaults.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Listen port; `0` permits an ephemeral local test port. |
| `HOST` | `0.0.0.0` | Listen address. |
| `STATIC_DIR` | `../src` relative to the server | Static directory; `off` disables static hosting. An explicit relative path is resolved from the working directory. |
| `SNAPSHOT_PATH` | `server/data/bootstrap.json` | Validated bundled catalog. Explicit paths resolve from the working directory. Missing or invalid data fails startup. |
| `BOREAL_BASE` | Boreal AnyRide URL | HTTP(S) upstream base, without credentials, query, or fragment. |
| `BOREAL_PROFILE_DATA` | `boreal_kiruna` | Server-owned data profile. |
| `BOREAL_PROFILE_DISPLAY` | `boreal` | Server-owned display profile. |
| `UPSTREAM_TIMEOUT_MS` | `10000` | Per-attempt timeout, including body. Whole upstream operations are also bounded. |
| `REFRESH_TIMEOUT_MS` | `60000` | Whole tracker/catalog refresh budget. |
| `DYNAMIC_INTERVAL_MS` | `30000` | Active collection interval for calls and positions; production range 30-60 seconds. |
| `STATIC_INTERVAL_MS` | `900000` | Active static source-check interval. |
| `ACTIVITY_IDLE_MS` | `120000` | How long live HTTP activity keeps collection active without an SSE connection. |
| `STREAM_MAX_CONNECTIONS` | `256` | Maximum simultaneous SSE connections for this process. |
| `STREAM_MAX_CONNECTIONS_PER_CLIENT` | `16` | Maximum simultaneous SSE connections per resolved client address. Account for shared/NAT addresses. |
| `STREAM_HEARTBEAT_MS` | `15000` | Heartbeat-comment interval; 1-15 seconds, below the server's 30-second inactivity timeout. |
| `STREAM_SLOW_READER_MS` | `5000` | Deadline to drain a blocked stream before destroying its transport. |
| `STREAM_MAX_PENDING_BYTES` | `262144` | Maximum stream-frame size; slow readers retain only the latest pending frame. |
| `UPSTREAM_CONCURRENCY` | `16` | Total outbound concurrency; minimum 2, maximum 128. |
| `UPSTREAM_QUEUE_SIZE` | `256` | Maximum waiting upstream jobs. |
| `UPSTREAM_QUEUE_MS` | `15000` | Maximum queue wait. |
| `UPSTREAM_MAX_BYTES` | `4194304` | Maximum response body size. |
| `CLIENT_REQUESTS_PER_MINUTE` | `240` | Per-client API request limit. |
| `GLOBAL_REQUESTS_PER_MINUTE` | `6000` | Total API request limit. Probes are exempt. |
| `TRUST_PROXY` | `false` | Trust one proxy-appended, rightmost `X-Forwarded-For` address. Enable only when direct access is blocked and a trusted ingress appends/overwrites this header. |
| `ALLOWED_ORIGINS` | `https://mhedqvist.github.io` | Comma-separated cross-origin browser origins, or `*`. Same-origin hosting needs none. CORS is not access control. |

Keep one replica. Limits and caches are process-local; additional replicas would
multiply collectors without shared ownership.

## Regenerate the bundled basic catalog

This is an explicit maintenance action, not an image-build or test dependency:

```powershell
cd server
npm run snapshot
# Only after reviewing an intentional removal of lines or stops:
npm run snapshot -- --accept-removals
```

Generation uses bounded live requests, retains accepted route associations when
there are no current journeys, and validates all required line/stop/shape
coverage and correction anchors before atomic replacement. Failure leaves the
accepted file intact. First generation needs active calls to discover routes;
later generations can reuse the previous route catalog. Review the snapshot
diff, provenance, and capture time before releasing it. Do not hand-edit data to
pretend a partial capture is complete.

In-memory catalog refreshes also use validated captures and keep the previous
catalog on failure. The collector checks static source data every 15 minutes
while active, reusing dynamic call results for route discovery. The check
waits for an in-flight dynamic cycle before consuming its associations.
Newly discovered stops alone may need bounded calls to discover their routes;
known stops are not rescanned by the static cycle. The check
revalidates the source rather than silently reading a longer-lived adapter
cache. Runtime refreshes are not written back to the deployed image.

## Local verification

```powershell
# From repository root, after npm ci in server:
node --test
cd server
npx playwright install chromium
npm run test:browser
```

Browser tests start their own local fake-provider application and serve local
Leaflet test assets. They cover cold first visits, returning cache, denied
storage, search, recovery, departures, filters, selection/expiry, and tab
visibility without depending on Boreal or a tile service.

Container verification, from the repository root:

```powershell
docker build -f server/Dockerfile -t boreal-bus:verify .
$id = docker run --rm -d -p 127.0.0.1::8080 -e BOREAL_BASE=http://127.0.0.1:9 boreal-bus:verify
try {
  $port = (docker port $id 8080/tcp).Split(':')[-1]
  node server/scripts/smoke.js "http://127.0.0.1:$port"
} finally {
  docker stop $id
}
```

## Manual releases and rollback

CI checks pull requests and relevant pushes. Publication on main/manual runs
requires unit/HTTP and browser checks plus a smoke test of the exact built
image with Boreal unavailable. The runtime image installs locked production
dependencies only and runs as the non-root `node` user.

For the current Azure Container Apps rollout, preserve minimum replicas `1`
and maximum `1`, as explicitly requested for this deployment. The collector
still idles without live clients, but hosting will not scale to zero with this
setting. Enabling scale-to-zero later requires minimum replicas `0`.
Keep target port `8080` and HTTP ingress/probes configured for
`/api/ready` and `/api/live` on port `8080`. Allow startup time for the container,
not an entire Boreal scan. Use HTTPS ingress.

Before release, verify that the actual ingress forwards incremental SSE events
without buffering, that heartbeats arrive within its idle timeout, and that
reconnections work during revision changes. Exercise a deliberately silent
stream to confirm HTTP fallback, slow readers to confirm bounded buffering,
and last-client disconnect to confirm idle collection and hosting scale-down.
Long-lived active connections may keep the instance running; stopping the
collector is not a guarantee about the host's billing or scale-down timing.

Budget upstream traffic before choosing 30 versus 60 seconds. With the
previously observed 44 stops and 15 position lookups, full cycles use roughly
118 or 59 source requests/minute respectively, before retries, static checks,
and legacy traffic. Confirm acceptable provider usage; never run synthetic
load tests against Boreal.

Record the current immutable image and revision before updating. Deploy a
published SHA tag or preferably the registry digest, never `latest` as the
release identity:

```powershell
$image = 'ghcr.io/mhedqvist/boreal-bus@sha256:<verified-digest>'
az containerapp update -n boreal-bus -g rg-boreal-bus --image $image `
  --revision-suffix r$(Get-Date -Format yyyyMMddHHmm)
```

Check readiness, bundled startup, and live status separately. For rollback,
repeat the update with the recorded previous digest and a new revision suffix,
then repeat those checks. In-memory state is intentionally disposable; the
bundled baseline must work immediately after either deployment. No cloud
resources or automatic deployment credentials are provisioned by this project.
