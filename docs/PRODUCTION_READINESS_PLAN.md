# Backend and client communication implementation plan

Status: all seven phases implemented and locally verified; not deployed.

Working branch: `mhedqvist-backend-production-readiness`.

Further improvements after this release are tracked separately in the
[follow-up roadmap](PRODUCTION_READINESS_FOLLOW_UP.md). That roadmap does not
expand the agreed implementation scope below.

## Implementation and verification record

The agreed baseline is implemented: the versioned website API and shared
schemas, bounded upstream adapter, nonblocking tracker snapshots with quality
metadata, bundled catalog and IndexedDB cache, migrated polling/startup,
operational controls, gated image publication, and manual release guidance.
Temporary legacy endpoints remain available for already-open pages.

Local verification completed:

- `node --test`: 93 passing unit, contract, HTTP, tracker, and upstream tests.
- `npm run test:browser` from `server`: eight passing Chromium flows covering
  cold/outage startup, newer browser cache, denied storage, recovery and
  departures, filters/selection/expiry, hidden tabs, and catalog replacement
  without resetting selection, filters, or the viewport.
- Manual-testing follow-ups: transient notices fade after 10 seconds without
  hiding ongoing failures, dotted previews follow up to three upcoming stops,
  and normal 60-second polling no longer mislabels usable cached snapshots as
  stale. Exact GPS expiry is reported even during a blocked refresh.
- Production Docker image: shell, bundled lines/stops/routes, probes, and
  explicit live unavailability work with Boreal deliberately unreachable.
  Confirmed production-only installed dependencies and a non-root runtime;
  restart and graceful shutdown passed.
- Local rollback rehearsal: started the previous verified image by its exact
  local image ID and repeated the outage-startup checks successfully. This
  was not a cloud deployment or a production rollback.
- Real Boreal integration through an ephemeral localhost listener: bootstrap,
  normalized departures, and live tracking passed. The last observed run
  returned six visible vehicles, full coverage of 44 stops and 15 position
  requests, synchronized time, and no abort-listener warnings. These are
  point-in-time observations, not a guarantee of upstream availability.

The bundled catalog contains three lines, 44 located stops, and six route
shapes. Snapshot generation remains an explicit maintenance command; normal
tests and image builds do not contact Boreal.

No cloud resources were provisioned and no automatic deployment was added.
Production rollout and the separately scoped follow-up roadmap remain future
work. The sections below retain the agreed design and acceptance criteria.

## Agreed design decisions

| Decision | Selected approach | Consequence |
|---|---|---|
| Hosting | One scale-to-zero container | Lower idle cost; a visitor still waits for the container itself to start. |
| Frontend hosting | Serve the page and API from the same container | One deployment and same-origin requests; no separate static host or CDN. |
| Startup data | Bundled basic-data snapshot plus browser cache | First-time visitors get basic information without waiting for Boreal; returning visitors can reuse newer compatible cached information. No external storage service. |
| Old bus positions | Hide after three minutes | Preserve the existing expiry boundary. Keep basic map information visible and explain live-data outages. |
| Live refresh | Keep 60-second polling | No SSE or WebSocket infrastructure. Hidden tabs pause requests; failures use backoff. |
| Backend technology | Native Node HTTP plus schema validation | Incremental changes rather than a framework or TypeScript migration. |
| API consumers | This website only | Keep old endpoints temporarily for already-open pages, rather than support a permanent public passthrough API. |
| Delivery | Application changes, CI, and manual deployment/rollback guide | No cloud provisioning or automatic production deployment in this implementation. |

Important limitation: neither the bundled data nor the browser data cache makes
the first HTTP request bypass a sleeping container. Once the container starts,
the shell and basic information must not wait for a live-data scan. Map tiles
and Leaflet still require their existing external services.

## Goals and non-goals

Deliver predictable API latency, honest freshness reporting, resilient startup,
bounded upstream traffic, a stable application contract, and reproducible
container releases.

Preserve the existing map interactions, line filters, favorite stops, nearby
search permission flow, route corrections, departures, and three-minute bus
expiry. Keep the original GPS timestamps when retaining positions.

Do not introduce a database, Redis, external object storage, a service worker,
multiple replicas, a separate collector service, a frontend build system, or
user authentication. Do not persist live bus positions, departures, or precise
nearby-search coordinates in the basic-information cache.

## Intended architecture

```text
Browser
  -> page and assets from the container
  -> compatible browser-cached basic information, when available
  -> /api/v1/bootstrap: current basic catalog or bundled fallback
  -> /api/v1/buses and stop departures: live data with explicit quality
       |
Native Node HTTP application
  -> validated application endpoints and consistent errors
  -> in-memory catalogs and live snapshots
  -> demand-triggered, shared refresh jobs
  -> one bounded upstream request scheduler
  -> Boreal adapter: validation, normalization, and provider-specific fixes
```

No permanent refresh timer keeps scanning after visitors leave. Requests can
trigger work without waiting for its completion when a usable response is
already available. Jobs have their own deadlines and must tolerate process
termination; correctness must not depend on background work surviving
scale-to-zero.

## Phase 1: Define the application contract and HTTP test boundary

Prerequisite: none.

- Extract HTTP application construction from `server/index.js` so tests can
  inject the tracker and upstream adapter without listening on the production
  port, contacting Boreal, or running startup warmup.
- Keep `openapi.yaml` as the upstream reference. Add a separately named
  application OpenAPI contract and reusable JSON Schemas for application DTOs,
  requests, and upstream data consumed by the adapter.
- Use one small JSON Schema validator, such as Ajv. Add the dependency and lock
  file explicitly; share schema definitions with the application contract
  rather than maintaining independent duplicate definitions.
- Use JSDoc DTO types where helpful. Do not require a TypeScript migration or
  introduce a compiler solely for this phase.
- Validate environment configuration on startup. Reject invalid ports,
  timeouts, concurrency settings, base URLs, and snapshot configuration with an
  actionable startup error instead of silently substituting defaults.
- Standardize failures as `{ error: { code, message, requestId } }`. Log
  diagnostic details server-side without returning internal upstream errors.
  Include CORS headers on error paths when cross-origin hosting is configured.
- Validate each endpoint's method, query, content type, and body. Use appropriate
  `400`, `404`, `405` with `Allow`, `413`, and `415` responses.

Proposed endpoint surface:

| Endpoint | Response/responsibility |
|---|---|
| `GET /api/v1/bootstrap` | Public map settings, lines, located stops, line-to-route catalog, and catalog version/freshness. No upstream profile headers or live vehicle data. |
| `GET /api/v1/buses` | Normalized vehicle data, authoritative server time, and scan/position quality metadata. |
| `GET /api/v1/stops` | Normalized stop catalog; retained as a small independent resource. |
| `GET /api/v1/stops/:id/departures` | Flat, normalized departures, disruptions, cancellation state, and freshness. |
| `GET /api/v1/routes/:id` | Display-ready route geometry and its version. |
| `GET /api/live` | Process liveness; independent of Boreal availability. |
| `GET /api/ready` | Ability to serve the application's usable baseline, not the presence of active buses. |
| `GET /api/status` | Sanitized data-quality and refresh status. |

Stop search and nearby lookup should use the local located-stop catalog where
it can preserve the current behavior. If an upstream lookup is still needed,
expose a narrow normalized application endpoint rather than leaking Boreal's
request structure to the browser.

Acceptance:

- HTTP integration tests exercise method enforcement, validation, errors, and
  response schemas through a real ephemeral local listener.
- All new application routes are documented; existing routes remain available.
- Invalid upstream payloads cannot be mistaken for valid empty application data.
- Existing module tests still run without network access.

## Phase 2: Bound and normalize upstream access

Prerequisite: phase 1.

Primary files: `server/lib/boreal.js`, `passthrough.js`, `pool.js`, and `cache.js`.

- Introduce a shared outbound scheduler used by scans, position requests, and
  interactive requests. Keep per-workload concurrency limits as well as a
  configurable total limit, bounded queue, and queue deadline.
- Give interactive requests an explicit share of capacity so a full scan does
  not starve a selected stop. Reject overload explicitly instead of allowing an
  unbounded queue.
- Keep upstream deadlines active through response-body consumption. Bound
  response bytes and validate parsed data before updating known-good caches.
- Retry only transient connection failures, timeouts, rate limits, and selected
  upstream server errors. Use bounded exponential backoff with jitter, honor
  `Retry-After`, and respect the whole-operation deadline.
- Do not retry invalid input, permanent upstream client errors, or schema
  failures indiscriminately.
- Canonicalize validated cache keys so JSON property order and irrelevant query
  parameters do not create duplicate upstream work. Coalesce identical
  concurrent requests, including departure requests shared with tracker scans.
- Keep request cancellation separate from shared work: one disconnected visitor
  must not cancel a refresh needed by other visitors. Cancel unshared work when
  appropriate, and stop jobs during shutdown within a bounded drain period.
- Validate coordinates, timestamps, and essential identifiers at the adapter
  boundary. Permit harmless additional upstream fields to avoid unnecessary
  breakage when Boreal adds data.

Acceptance:

- Concurrent tracker and interactive requests never exceed the configured total
  upstream concurrency or queue capacity.
- A stalled response body times out; retry attempts and operation duration are
  bounded under a fake clock.
- Malformed responses leave previous validated cache entries intact.
- Identical selected-stop and scan fetches share work when their semantics match.

## Phase 3: Make tracker snapshots honest and non-blocking

Prerequisites: phases 1 and 2.

Primary file: `server/lib/tracker.js`.

- Track scan coverage and the last successful scan and position-refresh times
  separately from response generation time. Expose the age of retained data.
- Report `fresh`, `partial`, `stale`, or `unavailable` with structured reasons.
  Freshness and coverage are independent facts: include both timestamps and
  attempted/succeeded/failed counts, rather than relying on one status label.
- Stop treating one successful stop as an entirely successful scan. Retain
  bounded last-known results for failed stops, but remove departed calls when a
  successful fetch confirms their absence. Never extend old data's timestamps
  simply because it was returned again.
- Preserve partial position failures in metadata even when some buses succeed.
  Separate legitimate null/no-position responses from transport/schema failures.
- Preserve the exact three-minute GPS expiry on server and client. Expired or
  invalid positions must not be displayed, including a selected vehicle.
- Distinguish a successful empty service snapshot from an unknown live picture.
  Returning zero vehicles during a failed scan must not imply no buses operate.
- Return an existing usable snapshot immediately and share one demand-triggered
  refresh. Remove the current eight-second cache-hit wait.
- When there is no usable live snapshot, return a structured `503` warming-up or
  unavailable response with `Retry-After`; keep bootstrap and static assets
  independent of that response.
- Bound whole refresh jobs and failure backoff. Keep successful caches usable
  through transient failures and expire historical journey/route bookkeeping
  rather than letting catalogs grow forever.
- Use one server-time model for expiry and countdowns. Report clock-sync
  degradation rather than silently presenting an unsynchronized clock as known.

Acceptance:

- Failing one stop produces partial coverage, not a fully healthy scan.
- All-stop failure, partial failure, no service, and no vehicle fix have
  distinguishable responses and UI states.
- Cached responses complete without waiting for a deliberately blocked upstream
  refresh; use a deterministic synchronization test rather than a flaky wall
  clock threshold.
- Test freshness at exactly three minutes and immediately after it, recovery,
  changing call IDs, missing journeys, and out-of-order position timestamps.

## Phase 4: Provide a bundled catalog and safe browser cache

Prerequisites: phases 1 and 2.

- Add an explicit snapshot-generation command. Its network access is a deliberate
  maintenance action, not part of normal tests, container startup, or image build.
- Generate a validated basic catalog and route shapes under `server/data/` so
  Docker's existing server copy includes them. Record schema version, content
  version, capture time, and provenance.
- Capture public map configuration, line information, located stops, known route
  associations, and corrected route geometry. Exclude vehicle positions,
  departures, upstream profile configuration, and personal information.
- Do not publish a partial replacement snapshot. Validate required data and
  coverage against the previous accepted catalog, account for times with no
  active journeys, and keep the previous snapshot if generation fails.
- Seed basic-information responses from the bundled snapshot immediately. Use
  validated current in-memory data when available; do not wait for Boreal to
  serve bootstrap or bundled routes.
- Cache basic information in native browser storage, preferably IndexedDB for
  route geometry. Version records and reject incompatible or corrupt entries.
  Compare capture times/content versions; a newly deployed old fallback must
  not silently overwrite a newer compatible browser catalog.
- Treat storage as optional: denied access, quota errors, or corrupt records
  must not prevent startup. Surface diagnostic failures without interrupting
  the usable bundled-data path.
- Label bundled or retained catalog data as cached with its capture time. It is
  not a current timetable and does not establish live-data freshness.
- Serve conditional requests/ETags for bootstrap and route geometry. Keep live
  responses separate from long-lived basic-data caching.

Acceptance:

- With Boreal blocked and browser storage empty, a started container renders
  lines, stops, and bundled routes without waiting for a scan.
- With a newer compatible browser catalog, a returning visitor keeps it while
  revalidation happens.
- Capture/version metadata survives container rebuilds and browser round trips.
- Snapshot generation failure cannot replace a known-good file with partial
  data. Normal image builds need no Boreal access.
- No persistent basic-data cache contains live positions, departures, or precise
  user location.

## Phase 5: Migrate frontend communication and startup

Prerequisites: phases 3 and 4.

Primary files: `src/js/api.js`, `main.js`, `config.js`, `clock.js`, `lines.js`,
`poller.js`, `calls.js`, `routes.js`, `live-vehicles.js`, `stop-locations.js`,
`appState.js`, and `ui.js`.

- Initialize the UI from compatible cached/bundled bootstrap data, not a fatal
  dependency on `GetConfigOptions`. Remove browser-managed profile headers and
  use of Boreal's grouped-call/request structures.
- Move upstream-specific route discovery and geometry corrections behind the
  application API. Preserve the tested LKAB correction and error behavior.
  Keep screen-space route offsets and visual presentation in the browser.
- Keep request deadlines active through body parsing; remove abort listeners and
  timers in `finally`. Preserve distinct cancellation, timeout, network,
  overload, validation, and HTTP failure categories.
- Parse structured backend errors and `Retry-After`. Keep good displayed data
  beneath errors and make search failure different from no matching stops.
- Check request generation, selected-stop identity, and cancellation immediately
  before any state write, not after fetch helpers have already written.
- Preserve normal 60-second live and selected-stop polling, hidden-tab pause,
  and immediate refresh on resume. Add bounded failure backoff with jitter.
  A warming-up response may schedule a bounded startup retry using
  `Retry-After`; this is not a permanent increase in healthy polling frequency.
- Make countdowns reflect the actual next attempt, including backoff. Use
  server time plus monotonic elapsed browser time for position expiry.
- Allow a later bootstrap refresh to replace cached catalogs without resetting
  the user's selected stop, line filters, favorites, or map position. Removed
  catalog entries need explicit reconciliation.
- Ensure one unavailable data category does not unnecessarily block another:
  for example, stop locations must not wait for successful live bus polling.

Acceptance:

- Cover first visit, returning visit, container warmup, Boreal outage, recovery,
  hidden/resumed tabs, slow response bodies, and denied browser storage.
- Rapid stop changes, clearing selection, and pause/resume cannot apply a late
  response to the wrong state, even if a test fetch ignores cancellation.
- Existing bus expiry, filters, trip details, map interactions, and keyboard
  behavior remain intact.
- Automated browser coverage proves the cached startup and degradation states,
  alongside the existing dependency-free unit tests.

## Phase 6: Add operational controls and visibility

Prerequisites: phases 2 and 3; finalize UI-facing status after phase 5.

- Implement liveness, readiness, and sanitized data status separately. A valid
  basic catalog can make the app ready even while live data is warming up.
  Neither zero active buses nor Boreal downtime alone should trigger restarts.
- Emit structured JSON request and refresh logs with request/refresh IDs,
  duration, status, cache outcome, coverage, and stable failure codes.
- Record request latency, upstream concurrency/queue depth, retry and timeout
  counts, cache outcomes, scan duration, and successful-data ages. Keep labels
  bounded; do not label metrics by arbitrary stop searches or user coordinates.
- Add configurable per-client and global request limits with explicit `429`
  responses and `Retry-After`. Document trusted-proxy configuration before using
  forwarded client addresses. CORS is not a rate limit or access-control system.
- Set deliberate HTTP request/header/idle timeouts, retain request-body bounds,
  and bound cache entries and bytes.
- Log shutdown and drain/abort owned work within the host's termination budget.
  Do not add broad catches that hide failed refreshes or invalid data.

Acceptance:

- Probe tests distinguish an alive process, an unusable baseline, degraded live
  tracking, and a legitimate empty service period.
- A simulated outage produces actionable structured events and data-age
  information without sensitive coordinates or raw payloads.
- Overload and shutdown tests demonstrate bounded queueing and termination.

## Phase 7: Gate releases and document manual operations

Prerequisite: all preceding phases for the completed release. Add the initial CI
test gate early so intermediate changes receive protection.

Primary files: `.github/workflows/image.yml`, `server/Dockerfile`,
`server/package.json`, `README.md`, `server/README.md`, and `docs/DATA_FLOW.md`.

- Standardize one supported Node LTS version across the manifest, Docker, and CI.
- Run the existing root/server tests and new contract/HTTP tests on pull requests
  and relevant pushes. Include schema, snapshot, dependency-lock, and test files
  in workflow triggers, not only application source.
- Add only the tooling needed for the new integration/browser checks. Keep
  normal unit tests independent of external network and production services.
- Install locked production dependencies with `npm ci --omit=dev` in the image.
  Keep the non-root runtime user and include the validated bundled catalog.
- Make image publication depend on successful checks. Smoke-test the built
  container with upstream unavailable before publishing.
- Document deploying an immutable image SHA/digest, configuring probes, keeping
  minimum replicas at zero and maximum at one, and rolling back to a previous
  known-good image. Do not use `latest` as the production release identity.
- Document snapshot regeneration and review, expected cold-start behavior,
  configuration, failure semantics, log fields, and manual outage diagnosis.
- Keep the current documented hosting approach as guidance; do not provision
  resources, configure cloud credentials, or enable automatic deployment.

Acceptance:

- A failing required check prevents image publication.
- The built image can serve the shell, basic catalog, and probes without Boreal.
- Deploy and rollback instructions identify exact immutable images and expected
  readiness/degradation behavior.

## Compatibility and implementation order

Implement in small, reviewable changes in the phase order above. Phase 4 can
proceed after phase 2 while tracker quality work is completed; phase 5 requires
both. Operational instrumentation can be added alongside the corresponding
phases rather than deferred until the end.

Add the new `/api/v1` API before migrating its consumers. Keep the existing
unversioned endpoints and legacy response shapes during the migration; do not
silently replace the shape of an endpoint an already-open page is using.
The versioned path isolates this migration; it is not a commitment to maintain
an independently supported public API.

Record legacy route usage without logging request payloads. Remove compatibility
routes only in a later deliberate change after their use has been assessed.
Update the application contract and architecture documentation with each
behavioral change.

Before declaring the work complete, exercise the whole sequence: empty browser
cache, cold process, unavailable upstream, basic map visible, explicit live-data
status, successful recovery, three-minute expiry, and deployment rollback.
