import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createApplication } from '../app.js';
import { createTracker } from '../lib/tracker.js';
import { createCatalog, loadCatalog } from '../lib/catalog.js';
import { createTelemetry } from '../lib/telemetry.js';
import { AppError } from '../lib/errors.js';
import { loadConfig } from '../lib/config.js';

const snapshot = loadCatalog(new URL('../data/bootstrap.json', import.meta.url));
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

function build() {
  const catalog = createCatalog({ snapshot, api, telemetry });
  const tracker = createTracker({ api, initialStops: snapshot.stops, telemetry, options: {
    scanIntervalMs: 50, minRescanIntervalMs: 10, positionsTtlMs: 10, retryAfterFailureMs: 50, refreshTimeoutMs: 1000,
  } });
  return createApplication({ settings: loadConfig({}), api, tracker, catalog, telemetry });
}
let runtime = build();
const server = http.createServer(async (req, res) => {
  if (req.url === '/__test/reset' && req.method === 'POST') {
    runtime.shutdown();
    mode = 'down';
    runtime = build();
    res.end('reset');
  } else if (req.url.startsWith('/__test/mode/') && req.method === 'POST') {
    mode = req.url.split('/').at(-1);
    await delay(60);
    await runtime.tracker.refresh();
    res.end(mode);
  } else {
    runtime.server.emit('request', req, res);
  }
});
server.listen(4179, '127.0.0.1');
function stop() { runtime.shutdown(); server.closeAllConnections(); server.close(); }
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
