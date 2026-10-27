import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getEventListeners } from 'node:events';
import { loadCatalog, captureCatalog, validateCatalog, createCatalog } from '../lib/catalog.js';
import { generateSnapshot } from '../scripts/snapshot.js';

const snapshot = loadCatalog(new URL('../data/bootstrap.json', import.meta.url));
function fakeApi() {
  return {
    getConfig: async () => snapshot.config,
    getLines: async () => snapshot.lines,
    getStopAreas: async () => snapshot.stops,
    findStopArea: async (text) => snapshot.stops.find((stop) => stop.text === text),
    getCalls: async () => ({ calls: [] }),
    getMapRoute: async (id) => snapshot.routes[id],
  };
}

test('catalog regeneration retains known routes even outside service hours and strips live fields', async () => {
  const catalog = await captureCatalog({ api: fakeApi(), previous: snapshot });
  validateCatalog(catalog);
  assert.deepEqual(catalog.lineRoutes, snapshot.lineRoutes);
  assert.equal(catalog.schemaVersion, 1);
  assert.ok(Number.isFinite(Date.parse(catalog.capturedAt)));
  assert.deepEqual(Object.keys(catalog.routes[Object.keys(catalog.routes)[0]]), ['locations']);
  assert.equal('vehicles' in catalog, false);
});

test('snapshot generation fails atomically on partial upstream or decreased coverage', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'boreal-catalog-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'bootstrap.json');
  const original = JSON.stringify(snapshot);
  await writeFile(target, original);
  const api = fakeApi();
  api.getCalls = async () => { throw new Error('partial scan'); };
  await assert.rejects(generateSnapshot({ target, api }), /partial scan/);
  assert.equal(await readFile(target, 'utf8'), original);
  const fewer = fakeApi();
  fewer.getStopAreas = async () => snapshot.stops.slice(1);
  await assert.rejects(generateSnapshot({ target, api: fewer }), /coverage decreased/);
  assert.equal(await readFile(target, 'utf8'), original);
});

test('route correction is performed on the server and a failed correction is not cached', async () => {
  let available = false;
  const adolf = { lat: 67.86001, lon: 20.22105 }, lkab = { lat: 67.84944, lon: 20.19584 }, street = { lat: 67.86239, lon: 20.21577 };
  const api = fakeApi();
  api.getMapRoute = async (id) => {
    if (id === 540298) return { locations: [adolf, { lat: 67.855, lon: 20.208 }, lkab] };
    if (!available) throw new Error('Return shape unavailable');
    return { locations: [lkab, street, adolf] };
  };
  const isolated = {
    ...snapshot, lines: [snapshot.lines[0]],
    lineRoutes: { [snapshot.lines[0].id]: [1] },
    routes: { 1: { locations: [adolf, lkab] } },
  };
  const catalog = createCatalog({ snapshot: isolated, api });
  await assert.rejects(catalog.route(540298), /Return shape unavailable/);
  available = true;
  assert.deepEqual((await catalog.route(540298)).locations, [adolf, street, lkab]);
  catalog.close();
});

test('catalog line discovery stays within eight workers and releases cancellation listeners', async () => {
  const lines = Array.from({ length: 24 }, (_, index) => ({ id: 1000 + index, text: `Line ${index}` }));
  const route = Number(Object.keys(snapshot.routes)[0]);
  const previous = { ...snapshot, lines, lineRoutes: Object.fromEntries(lines.map((line) => [line.id, [route]])) };
  const controller = new AbortController();
  const api = fakeApi();
  let active = 0;
  let peak = 0;
  api.getLines = async () => lines;
  api.getStopAreas = async () => {
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    return snapshot.stops;
  };
  const catalog = await captureCatalog({ api, previous, signal: controller.signal });
  assert.equal(catalog.lines.length, 24);
  assert.equal(peak, 8);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('runtime static checks bypass source caches, reuse dynamic routes, and keep unchanged content versions', async () => {
  const api = fakeApi();
  const checked = [];
  for (const method of ['getConfig', 'getLines', 'getStopAreas', 'findStopArea', 'getMapRoute']) {
    const original = api[method];
    api[method] = async (...args) => {
      assert.equal(args.at(-1).fresh, true, method);
      checked.push(method);
      return original(...args);
    };
  }
  api.getCalls = async () => { assert.fail('runtime static check must reuse dynamic calls'); };
  let time = Date.parse('2026-10-15T06:00:00Z');
  const catalog = createCatalog({ snapshot, api, now: () => time });
  try {
    await catalog.refresh({ fresh: true, lineRoutes: snapshot.lineRoutes });
    const first = catalog.get();
    time += 900000;
    await catalog.refresh({ fresh: true, lineRoutes: snapshot.lineRoutes });
    assert.equal(catalog.get().version, first.version);
    assert.notEqual(catalog.get().capturedAt, first.capturedAt);
    assert.equal(checked.filter((method) => method === 'getConfig').length, 2);
  } finally { catalog.close(); }
});

test('a newly discovered line can resolve routes from new stops without rescanning known stops', async () => {
  const api = fakeApi();
  const line = { id: 999, text: 'New line' };
  const stop = { id: 999, text: 'New stop', location: { lat: 67.85, lon: 20.22 } };
  api.getLines = async () => [...snapshot.lines, line];
  api.getStopAreas = async (id) => id === line.id ? [stop] : snapshot.stops;
  const findStop = api.findStopArea;
  api.findStopArea = (text) => text === stop.text ? stop : findStop(text);
  const queried = [];
  api.getCalls = async (text) => {
    queried.push(text);
    return { calls: [{ calls: [{ lineId: line.id, routeId: 999 }] }] };
  };
  const getRoute = api.getMapRoute;
  api.getMapRoute = (id) => id === 999 ? { locations: [stop.location, snapshot.stops[0].location] } : getRoute(id);
  const catalog = createCatalog({ snapshot, api });
  try {
    await catalog.refresh({ fresh: true, lineRoutes: snapshot.lineRoutes });
    assert.deepEqual(queried, [stop.text]);
    assert.deepEqual(catalog.get().lineRoutes[line.id], [999]);
  } finally { catalog.close(); }
});

test('day-dependent line subset retains validated line and stop coverage, but incomplete stop data is rejected', async () => {
  const api = fakeApi();
  const absent = snapshot.lines.at(-1);
  api.getLines = async () => snapshot.lines.filter((line) => line.id !== absent.id);
  const requested = [];
  api.getStopAreas = async (id) => { requested.push(id); return snapshot.stops; };
  const retained = await captureCatalog({ api, previous: snapshot, lineRoutes: snapshot.lineRoutes });
  assert.ok(retained.lines.some((line) => line.id === absent.id));
  assert.ok(requested.includes(absent.id));
  assert.deepEqual(retained.lineRoutes[absent.id], snapshot.lineRoutes[absent.id]);
  api.getStopAreas = async () => snapshot.stops.slice(1);
  await assert.rejects(captureCatalog({ api, previous: snapshot, lineRoutes: snapshot.lineRoutes }), /coverage decreased/);
});
