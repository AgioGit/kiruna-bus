# Further backend and communication improvements

Status: future roadmap, not approved implementation scope.

Exception: on 2026-10-15 the user approved the activity-gated collector and SSE
work described in section 6. Its approved scope is recorded in the
[readiness-plan amendment](PRODUCTION_READINESS_PLAN.md#approved-live-delivery-amendment-2026-10-15).
The other roadmap items remain future work.

Prerequisite: complete and release the
[production-readiness plan](PRODUCTION_READINESS_PLAN.md).

This document covers improvements to consider after the first production-ready
release. It does not move required work out of that plan or change the agreed
architecture: one scale-to-zero-capable container, bundled basic information plus browser
cache, native Node HTTP, and three-minute position expiry. The approved SSE
amendment replaces the original 60-second polling design only.

## Priorities

| Priority | Improvement | Start when |
|---|---|---|
| Next | Measure real reliability and tune limits | The baseline release has representative production traffic. |
| Next | Retire temporary legacy endpoints | The migrated frontend is established and legacy usage is understood. |
| Next | Detect upstream drift and keep bundled data current | The validated snapshot generator and application schemas are in place. |
| Next | Strengthen release assurance | Baseline CI and immutable manual releases are working. |
| Conditional | Reduce cold-start impact further | Measured waiting time is unacceptable to users. |
| Approved | Activity-gated collection and server push | User approved implementation on 2026-10-15; validate locally and verify hosting ingress before release. |
| Conditional | Add shared state and multiple replicas | One instance cannot meet agreed capacity or availability needs. |
| Conditional | Expand types, provider support, or retained data | A concrete maintenance or product requirement justifies it. |

"Next" items can be planned within the existing architecture. Conditional items
require a new decision about cost, complexity, or behavior before implementation.

## 1. Establish reliability targets using production evidence

Use the baseline logs and metrics to distinguish container startup, application
latency, and upstream data quality. Measure at least:

- Time from navigation to a usable basic map, for cold and warm containers and
  first-time and returning visitors.
- Time from navigation to the first usable live snapshot.
- Warm API latency, error rate, upstream queue saturation, and retry frequency.
- GPS sample age and scan coverage, separate from HTTP response success.
- Hosted resource cost, requests per active visitor, and upstream calls per
  refresh cycle.

Collect only the operational data needed for these measurements. Do not include
precise visitor location, arbitrary search text, or persistent user identifiers.
Browser timing collection should have an explicit privacy and retention policy.

Agree numerical targets after observing representative service periods and
traffic, including an overnight no-service period and a cold start. Define basic
map availability separately from live tracking availability. Exclude legitimate
empty service periods from "missing bus" alarms, but not actual refresh failures.

Use controlled load and soak tests to tune queue sizes, concurrency, memory
bounds, and failure backoff. Include repeated refresh cycles, slow upstream
bodies, intermittent rate limits, and catalog changes. Keep large synthetic
loads pointed at a fake upstream, not Boreal.

Done when: targets, measurement windows, actionable alerts, and an operating
cost baseline are documented; tuning is justified by measurements rather than
larger limits alone.

## 2. Remove temporary compatibility code deliberately

The initial plan retains unversioned endpoints for already-open pages. They
should not become a permanent second API by accident.

- Measure usage by endpoint and frontend release without recording payloads.
- Check for long-lived tabs and older cached assets before choosing a removal
  window. Low traffic alone does not prove nobody depends on a route.
- Make an explicit removal decision and document the date. If an unknown
  external consumer appears, decide whether to support it rather than silently
  promising public API compatibility.
- Remove legacy passthrough routes, unused client helpers, redundant profile
  initialization, and tests that exist only for the retired contract.
- Provide a clear upgrade/reload response for obsolete clients where practical;
  do not restore unrestricted upstream passthrough as a fallback.

Done when: the website uses only the application API, legacy removal is
intentional, and rollback remains possible using the previous immutable image.

## 3. Maintain upstream compatibility and snapshot quality

The upstream API is unofficial and can change independently of this application.
Extend baseline schema validation with a small fixture-based compatibility suite.

Keep representative, non-personal examples for no service, reinforced journeys,
cancelled stops, partial departures, missing positions, changed route shapes,
and forecast/planned-time differences. Record the capture date and provider
assumptions. Avoid storing a continuous history of live vehicle movements.

Consider a manually triggered or low-frequency CI job that:

1. Uses bounded upstream traffic to generate a candidate basic-data snapshot.
2. Compares line/stop coverage, coordinates, route associations, and correction
   anchors with the accepted snapshot.
3. Opens a reviewable change or publishes a review artifact instead of silently
   replacing production data.

Scheduling, repository write permissions, and any new automation are separate
approvals. Do not put upstream access into ordinary tests or every image build,
and do not keep the serving container awake solely to refresh static catalogs.

Keep provider-specific corrections explicit, versioned, and removable. Alert on
failed assumptions rather than drawing a plausible but incorrect route. Confirm
provider usage terms and acceptable refresh rates before increasing traffic.

Done when: meaningful upstream changes are visible before a release, failed
generation preserves the accepted catalog, and reviewers can explain each
snapshot change.

## 4. Strengthen releases beyond the baseline CI gate

After manual immutable releases and rollback are reliable, consider:

- Dependency update automation, container/dependency scanning, an SBOM, and
  build provenance, with clear ownership of reported issues.
- A repeatable staging smoke test that includes cached startup, live recovery,
  expiry, and behavior when map-tile or script providers fail.
- Rehearsed rollback and restart drills, including loss of all in-memory state.
- A small incident runbook identifying how to distinguish application failure,
  upstream outage, stale bundled information, and a hosting cold start.

Infrastructure as code and approval-gated automatic deployment can follow if
manual operations become frequent or error-prone. Choose the hosting platform,
identity/permissions model, infrastructure tool, budget, and rollback mechanism
first. Prefer short-lived workload identity to stored deployment credentials
where the selected platform supports it.

Done when: release artifacts are traceable, dependency findings have an owner,
and staging/rollback procedures are repeatable. Automatic cloud deployment is
not required to finish this item.

## 5. Revisit cold starts only if measured waiting is a problem

First optimize within the agreed design: snapshot size, image size, startup
imports, initial response work, and browser catalog reads. Do not hide a cold
start by displaying stale live positions as current.

If those changes are insufficient, present these choices again:

| Option | Benefit | Cost or limitation |
|---|---|---|
| One always-on instance | Avoids routine idle cold starts and keeps one deployment. | Ongoing idle hosting cost; still not highly available. |
| Separate static hosting/CDN | The page and basic information can load while the API sleeps. | Two delivery surfaces, cache/version coordination, and possible cross-origin configuration. |
| External basic-data snapshot | Automatically retains a newer server-side catalog across restarts. | Another service, permissions, storage cost, and failure paths; does not by itself wake the container faster. |
| Service-worker app shell | Can help returning visitors during network failures or startup. | Cache invalidation and upgrade complexity; does not solve a first visit with no cached shell. |

These are alternatives, not a recommendation to introduce all of them. The
initial decision to keep one container remains in force until changed.

Done when: an approved option meets an agreed startup target at an accepted
cost, including first-time visitors rather than only returning ones.

## 6. Activity-gated collection and push (approved amendment)

Implemented and locally verified; production release checks remain open. See
the [amendment verification record](PRODUCTION_READINESS_PLAN.md#approved-live-delivery-amendment-2026-10-15).

The approved implementation uses one shared collector while clients are
active: calls and vehicle positions every 30 seconds by default (configurable
to 60), and static information every 15 minutes. An open SSE connection or
live HTTP activity within 120 seconds keeps collection active. Probes do not.
Once idle, collection stops so the host can scale to zero.

Each dynamic cycle publishes a full bus snapshot with source freshness,
coverage, an ordering revision, and catalog version. A browser that receives no
valid snapshot for 60 seconds reads the HTTP cache while reconnecting.
Heartbeats and status-only events do not reset this delivery watchdog. Hidden
tabs close streams and pause requests; GPS expiry still runs independently.

Keep collection independent of viewer count, prevent overlapping cycles, reuse
the call cache for departures and catalog route discovery, and preserve the
existing three-minute position expiry. Genuine 15-minute static source checks
must not be hidden behind the previous one-hour upstream TTL.

SSE requires bounded connections/backpressure, proxy idle-timeout and buffering
checks, reconnect resynchronization, and graceful deployment draining. Active
connections can keep hosting resources active; stopping the collector when
idle permits scale-to-zero but does not guarantee a hosting cost reduction.
Use a full snapshot on initial connection or recovery.

Only introduce deltas or compression after payload measurements justify them.
WebSockets add little value unless a real bidirectional requirement appears.

Done when: local unit, HTTP, browser, and container checks demonstrate the
collector/push/fallback lifecycle, and release checks confirm acceptable source
traffic, ingress behavior, and idle scale-down. With the previously observed
44 stops and 15 position lookups, a full dynamic cycle is approximately 59
upstream requests before retries: about 118/minute at 30 seconds or 59/minute
at 60 seconds, excluding static checks and legacy traffic. Confirm acceptable
provider usage before deployment; faster collection cannot make provider GPS
samples newer.

## 7. Add shared state before increasing replica count

Independent replicas would each maintain their own caches and scans. Do not
raise the maximum replica count and assume upstream request coalescing still
works across processes.

If capacity or availability requires multiple instances:

1. Agree availability targets and budget; distinguish deployment availability
   from resilience to a full hosting-region outage.
2. Choose refresh ownership: a dedicated collector or a leased refresh leader
   with expiry, fencing, and safe takeover.
3. Select shared snapshot storage based on required latency, consistency, and
   recovery behavior. Redis, object storage, and a database solve different
   problems; none is automatically required.
4. Publish validated snapshots atomically with versions, original source times,
   and coverage metadata. Define behavior for storage failure and old writers.
5. Test leader loss, slow readers, stale writes, rolling deployments, and
   restoration without multiplying Boreal traffic.

A persistent collector may be always on even if serving instances scale down.
Document that cost explicitly. Shared storage is not, by itself, high
availability or a backup strategy.

Done when: multiple instances meet the agreed availability/capacity target,
refresh ownership is safe, and upstream traffic stays within its budget.

## 8. Let concrete needs drive larger structural changes

Keep these separate from reliability improvements unless a real requirement
appears:

| Possible change | Evidence needed | Additional consequences |
|---|---|---|
| Wider TypeScript adoption or an HTTP framework | Repeated type/HTTP-plumbing defects or significant team growth. | Build/tooling maintenance and migration work; runtime validation is still needed. |
| Official transit feed or additional provider | An available feed with suitable coverage, terms, and freshness. | Identity mapping, provenance, and differing semantics; no silent fallback to timetable-only data as live tracking. |
| Historical tracking or service analytics | A defined user need that cannot be met by operational metrics. | Durable storage, provider permission, retention/deletion policy, cost, and potentially sensitive movement history. |
| Supported external API consumers | An explicit consumer and ownership/support agreement. | Authentication or quotas where appropriate, compatibility guarantees, documentation, and a deprecation policy. |

For each proposed change, record the problem, smallest adequate solution,
alternatives, operating cost, failure behavior, success criteria, and rollback
before implementing it.
