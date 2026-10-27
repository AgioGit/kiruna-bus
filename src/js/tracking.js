// Shared epoch/revision bookkeeping for pushed (SSE) and polled (HTTP)
// buses snapshots, plus the runtime shape checks every incoming payload must
// pass before it is allowed to touch application state.
//
// The server's process epoch is a UUID (not sortable), so ordering within a
// process lifetime is purely by `revision`, a per-epoch monotonic counter:
//   - a different, never-before-seen epoch wins (new server process;
//     revision restarts)
//   - a lower revision for the same epoch is a late/stale delivery: ignored
//   - an equal revision is a duplicate: valid proof the connection is alive
//     (resets delivery watchdogs) but must not be re-applied, since that
//     could resurrect vehicles that have since expired locally
//   - a higher revision is new data: applied, and becomes the new baseline
//
// A late response (e.g. an HTTP fallback read started before a reconnect,
// slow to resolve) can report an epoch the client has already moved away
// from. Since UUIDs carry no order, that can't be told apart from a
// genuinely new one by value alone - so every epoch we transition away from
// is remembered and permanently treated as stale, rather than allowed to
// resurrect expired state just because its UUID differs from the current
// one.
let knownEpoch = null;
let knownRevision = -1;
const supersededEpochs = new Set();

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function hasRevisionFields(data) {
  return isNonEmptyString(data?.epoch)
    && Number.isSafeInteger(data.revision) && data.revision >= 0
    && isNonEmptyString(data.catalogVersion)
    && isNonEmptyString(data.serverTime) && Number.isFinite(Date.parse(data.serverTime));
}

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const optionalTime = (value) => value == null || timestamp(value);
const stop = (value) => object(value) && (value.stopText === null || typeof value.stopText === 'string')
  && optionalTime(value.plannedTime) && optionalTime(value.forecastTime);
const quality = (value) => object(value) && ['fresh', 'partial', 'stale', 'unavailable'].includes(value.state)
  && Array.isArray(value.reasons) && value.reasons.every((reason) => typeof reason === 'string');
const positiveId = (id) => Number.isSafeInteger(id) && id > 0;
const serviceTime = (value) => timestamp(value) && /T.*(?:Z|[+-]\d\d:\d\d)$/i.test(value);
const service = (value) => object(value) && Object.hasOwn(value, 'completeUntil')
  && (value.completeUntil === null || serviceTime(value.completeUntil))
  && Array.isArray(value.windows) && value.windows.every((window) =>
    object(window) && positiveId(window.lineId) && positiveId(window.routeId)
    && serviceTime(window.from) && serviceTime(window.until) && serviceTime(window.expiresAt)
    && Date.parse(window.from) <= Date.parse(window.until));
function vehicle(value) {
  const location = value?.position?.location;
  return object(value) && Number.isSafeInteger(value.journeyId) && Number.isSafeInteger(value.lineId)
    && value.lineId > 0 && typeof value.key === 'string' && typeof value.line === 'string'
    && typeof value.destination === 'string' && typeof value.stale === 'boolean'
    && Number.isFinite(value.ageMs) && timestamp(value.position?.timestamp)
    && Number.isFinite(location?.lat) && Math.abs(location.lat) <= 90
    && Number.isFinite(location.lon) && Math.abs(location.lon) <= 180
    && stop(value.nextStop) && (value.followingStop === null || stop(value.followingStop))
    && Array.isArray(value.upcomingStops) && value.upcomingStops.every(stop);
}

// Minimal structural check for a `buses` DTO (HTTP response or SSE event
// payload) - just enough to safely read the fields state application needs.
// No schema library: the server already validates its own responses, this
// is defense against a malformed/truncated push or an unexpected shape.
export function isValidBusesSnapshot(data) {
  return !!data && typeof data === 'object' && hasRevisionFields(data)
    && timestamp(data.generatedAt) && quality(data.quality)
    && (data.error == null || typeof data.error === 'string')
    && Array.isArray(data.vehicles) && data.vehicles.every(vehicle)
    && (data.service === undefined || service(data.service))
    && (data.observedLines === undefined || Array.isArray(data.observedLines) &&
      data.observedLines.every((line) => object(line) && positiveId(line.id) && isNonEmptyString(line.text)))
    && object(data.lineRoutes) && Object.values(data.lineRoutes).every((routes) =>
      Array.isArray(routes) && routes.every((id) => Number.isSafeInteger(id) && id > 0));
}

// Minimal structural check for a `tracking-status` SSE event payload.
export function isValidTrackingStatus(data) {
  return !!data && typeof data === 'object' && hasRevisionFields(data)
    && quality(data.quality) && isNonEmptyString(data.error?.code) && isNonEmptyString(data.error?.message)
    && Number.isSafeInteger(data.retryAfter) && data.retryAfter >= 0;
}

// Classifies a validated payload against the last-known epoch/revision
// without mutating any tracked state. One of: 'new-epoch' | 'newer' |
// 'duplicate' | 'stale'.
export function classifyRevision(data) {
  if (data.epoch !== knownEpoch) return supersededEpochs.has(data.epoch) ? 'stale' : 'new-epoch';
  if (data.revision > knownRevision) return 'newer';
  if (data.revision === knownRevision) return 'duplicate';
  return 'stale';
}

// Records a payload's epoch/revision as the new baseline. Call only after
// deciding (via classifyRevision) that the payload should be accepted.
export function acceptRevision(data) {
  if (knownEpoch !== null && knownEpoch !== data.epoch) supersededEpochs.add(knownEpoch);
  knownEpoch = data.epoch;
  knownRevision = data.revision;
}

// Exposed for tests; also useful if a caller ever needs to force a resync
// (e.g. after a long pause) without restarting the module.
export function resetTracking() {
  knownEpoch = null;
  knownRevision = -1;
  supersededEpochs.clear();
}

export function getTrackingState() {
  return { epoch: knownEpoch, revision: knownRevision };
}
