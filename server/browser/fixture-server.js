import http from 'node:http';
import { createApplication } from '../app.js';
import { createTracker } from '../lib/tracker.js';
import { createCatalog, loadCatalog } from '../lib/catalog.js';
import { createTelemetry } from '../lib/telemetry.js';
import { AppError } from '../lib/errors.js';
import { loadConfig } from '../lib/config.js';

const snapshot = loadCatalog(new URL('../data/bootstrap.json', import.meta.url));
// Kept so /__test/reset can undo a /__test/catalog-bump - snapshot is a
// module-level singleton reused by every rebuilt runtime, not reloaded per
// test.
const originalSnapshotConfig = snapshot.config;
const telemetry = createTelemetry({ write() {} });
let mode = 'down';
const line = snapshot.lines[0];
const routeId = snapshot.lineRoutes[line.id][0];

function requireLive() {
  if (mode === 'down') throw new AppError('UPSTREAM_UNAVAILABLE', 'The transit provider is unavailable.', { status: 502 });
}
const api = {
  async getConfig() { requireLive(); return snapshot.config; },
  async getLines() { requireLive(); return snapshot.lines; },
  async getStopAreas() { requireLive(); return snapshot.stops; },
  async findStopArea(text) { requireLive(); return snapshot.stops.find((stop) => stop.text === text); },
  async getMapRoute(id) { requireLive(); return snapshot.routes[id]; },
  async getSystemTimestamp(clientTimestamp) { requireLive(); return { clientTimestamp, systemTimestamp: clientTimestamp }; },
  async getCalls(text) {
    requireLive();
    const index = snapshot.stops.findIndex((stop) => stop.text === text);
    if (index < 0 || index > 2) return { calls: [], messages: [] };
    const time = new Date(Date.now() + (index + 1) * 60000).toISOString();
    return { calls: [{ calls: [{
      id: `fixture-${index}`, journeyId: 101, lineId: line.id, routeId, sequenceNumber: index,
      line: line.text, destination: 'Fixture destination',
      departure: { plannedTime: time, forecastTime: time, quality: 'realtime' },
    }] }], messages: [], isStopCancelled: false };
  },
  async getVehiclePosition() {
    requireLive();
    return { location: snapshot.stops[0].location, timestamp: new Date().toISOString(), heading: 90 };
  },
  status: () => ({ active: 0, queued: 0 }),
  close() {},
};

// Fixture-only cycle/connection settings: tests force dynamic/static cycles
// explicitly (see /__test/mode/ and /__test/catalog-bump below) rather than
// waiting on the production defaults (30s dynamic / 15min static), and a
// short refresh timeout keeps a 'down'-mode forced cycle from taking long to
// settle into its failure state.
const settings = loadConfig({ REFRESH_TIMEOUT_MS: '2000' });

function build() {
  const catalog = createCatalog({ snapshot, api, telemetry, refreshTimeoutMs: settings.refreshTimeoutMs });
  const tracker = createTracker({ api, initialStops: snapshot.stops, telemetry, options: { refreshTimeoutMs: settings.refreshTimeoutMs } });
  return createApplication({ settings, api, tracker, catalog, telemetry });
}
let runtime = build();
const server = http.createServer(async (req, res) => {
  if (req.url === '/__test/reset' && req.method === 'POST') {
    runtime.shutdown();
    mode = 'down';
    snapshot.config = originalSnapshotConfig;
    runtime = build();
    res.end('reset');
  } else if (req.url.startsWith('/__test/mode/') && req.method === 'POST') {
    mode = req.url.split('/').at(-1);
    // Forces one dynamic cycle through the real collector so the new mode
    // is reflected (in the tracker snapshot and pushed to any connected SSE
    // clients) before this responds - deterministic for tests, no arbitrary
    // delay. 'down' mode intentionally yields no usable snapshot; that
    // rejection is expected here, not a fixture bug.
    try {
      await runtime.collector.forceDynamicCycle({ fresh: true });
      res.end(mode);
    } catch (error) {
      res.writeHead(mode === 'down' ? 200 : 500);
      res.end(mode === 'down' ? mode : error.message);
    }
  } else if (req.url === '/__test/catalog-bump' && req.method === 'POST') {
    // Mutates the underlying snapshot's map config (a harmless, catalog
    // -scoped field already used by the "catalog refresh" test) so a forced
    // static cycle produces a genuinely new content-hash catalogVersion,
    // visible to the next buses/tracking-status frame (HTTP or SSE).
    snapshot.config = { ...snapshot.config, minZoom: (snapshot.config.minZoom ?? 11) + 1 };
    try {
      await runtime.collector.forceStaticCycle({ fresh: true });
      res.end('bumped');
    } catch (error) {
      res.writeHead(500);
      res.end(error.message);
    }
  } else {
    runtime.server.emit('request', req, res);
  }
});
server.listen(4179, '127.0.0.1');
function stop() { runtime.shutdown(); server.closeAllConnections(); server.close(); }
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
