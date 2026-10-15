import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptRevision, classifyRevision, getTrackingState, isValidBusesSnapshot,
  isValidTrackingStatus, resetTracking,
} from '../src/js/tracking.js';

function buses(overrides = {}) {
  return {
    epoch: 'p1', revision: 0, catalogVersion: 'cv-1', serverTime: new Date().toISOString(),
    generatedAt: new Date().toISOString(), quality: { state: 'fresh', reasons: [] },
    vehicles: [], lineRoutes: {}, ...overrides,
  };
}

function status(overrides = {}) {
  return {
    epoch: 'p1', revision: 0, catalogVersion: 'cv-1', serverTime: new Date().toISOString(),
    quality: { state: 'unavailable', reasons: [] },
    error: { code: 'WARMING_UP', message: 'Starting tracking' }, retryAfter: 5, ...overrides,
  };
}

test.beforeEach(() => resetTracking());

test('isValidBusesSnapshot requires every revision field plus vehicles/lineRoutes', () => {
  assert.equal(isValidBusesSnapshot(buses()), true);
  assert.equal(isValidBusesSnapshot(null), false);
  assert.equal(isValidBusesSnapshot({ ...buses(), epoch: '' }), false);
  assert.equal(isValidBusesSnapshot({ ...buses(), revision: -1 }), false);
  assert.equal(isValidBusesSnapshot({ ...buses(), revision: 1.5 }), false);
  assert.equal(isValidBusesSnapshot({ ...buses(), catalogVersion: '' }), false);
  assert.equal(isValidBusesSnapshot({ ...buses(), serverTime: 'not-a-date' }), false);
  assert.equal(isValidBusesSnapshot({ ...buses(), vehicles: undefined }), false);
  assert.equal(isValidBusesSnapshot({ ...buses(), lineRoutes: null }), false);
  assert.equal(isValidBusesSnapshot(buses({ vehicles: [null] })), false);
  assert.equal(isValidBusesSnapshot(buses({ lineRoutes: { 1: 'not routes' } })), false);
  assert.equal(isValidBusesSnapshot(buses({ quality: { state: 'fresh', reasons: 'invalid' } })), false);
  assert.equal(isValidBusesSnapshot(buses({ revision: Number.MAX_SAFE_INTEGER + 1 })), false);
});

test('isValidTrackingStatus requires revision fields plus a quality object', () => {
  assert.equal(isValidTrackingStatus(status()), true);
  assert.equal(isValidTrackingStatus({ ...status(), quality: null }), false);
  assert.equal(isValidTrackingStatus({ ...status(), epoch: 42 }), false);
});

test('a different epoch always wins and resets the revision baseline', () => {
  acceptRevision(buses({ epoch: 'p1', revision: 50 }));
  assert.equal(classifyRevision(buses({ epoch: 'p2', revision: 0 })), 'new-epoch');
  assert.equal(classifyRevision(buses({ epoch: 'p2', revision: 0 })), 'new-epoch'); // repeatable until accepted
  acceptRevision(buses({ epoch: 'p2', revision: 0 }));
  assert.deepEqual(getTrackingState(), { epoch: 'p2', revision: 0 });
});

test('within the same epoch, ordering is by revision alone', () => {
  acceptRevision(buses({ epoch: 'p1', revision: 10 }));
  assert.equal(classifyRevision(buses({ epoch: 'p1', revision: 9 })), 'stale');
  assert.equal(classifyRevision(buses({ epoch: 'p1', revision: 10 })), 'duplicate');
  assert.equal(classifyRevision(buses({ epoch: 'p1', revision: 11 })), 'newer');
});

test('stale/duplicate classifications never implicitly advance the baseline', () => {
  acceptRevision(buses({ epoch: 'p1', revision: 10 }));
  classifyRevision(buses({ epoch: 'p1', revision: 10 })); // caller chooses not to accept a duplicate
  classifyRevision(buses({ epoch: 'p1', revision: 3 })); // or a stale one
  assert.deepEqual(getTrackingState(), { epoch: 'p1', revision: 10 });
});

test('a late response from an epoch already moved away from is stale, never resurrecting it', () => {
  acceptRevision(buses({ epoch: 'p1', revision: 50 }));
  acceptRevision(buses({ epoch: 'p2', revision: 0 })); // moved on to a genuinely new process
  // A slow-to-resolve request/connection from the old process (p1) finally
  // lands after p2 is already current - UUIDs carry no order, but p1 must
  // not be treated as "new" just because it differs from the current epoch.
  assert.equal(classifyRevision(buses({ epoch: 'p1', revision: 99 })), 'stale');
  assert.deepEqual(getTrackingState(), { epoch: 'p2', revision: 0 });
});

test('resetTracking clears the baseline back to "unseen"', () => {
  acceptRevision(buses({ epoch: 'p1', revision: 10 }));
  resetTracking();
  assert.deepEqual(getTrackingState(), { epoch: null, revision: -1 });
  assert.equal(classifyRevision(buses({ epoch: 'p1', revision: 0 })), 'new-epoch');
});
