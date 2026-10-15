import { AppError } from './errors.js';
import { validate } from './validation.js';

// SSE connection registry for GET /api/v1/stream. Owns:
//  - per-connection headers (no-cache/no-transform + X-Accel-Buffering)
//  - global + per-client (trusted-IP) connection caps
//  - a single shared "current frame" computed from the tracker/catalog,
//    pushed to every connected client whenever the collector reports a
//    completed cycle (collector.onUpdate), plus once immediately on connect
//  - backpressure: at most one latest-pending frame per client, with a byte
//    cap on that frame and a slow-reader deadline measured from the moment
//    a write first blocks
//  - periodic heartbeat comments (never representing new data), which also
//    keep each socket under the server's inactivity timeout
export function createStreamHub({
  collector, tracker, catalog, telemetry, now = Date.now,
  maxConnections, maxConnectionsPerClient, heartbeatMs, slowReaderMs, maxPendingBytes,
}) {
  const clients = new Set();
  const byAddress = new Map();
  let closed = false;
  let unsubscribe = null;

  function format(event, id, data) {
    return `event: ${event}\nid: ${id}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  // The one shared snapshot every connected client sees: a 'buses' event
  // when there is a usable snapshot (however stale/partial, with honest
  // quality/error fields), otherwise a 'tracking-status' event -- including
  // when only the catalog changed but buses remain unavailable.
  function currentFrame() {
    const epoch = collector.epoch;
    const revision = tracker.getRevision();
    const catalogVersion = catalog.get().version;
    const id = `${epoch}:${revision}`;
    try {
      const buses = tracker.getSnapshot();
      return format('buses', id, validate('buses', { ...buses, epoch, revision, catalogVersion }));
    } catch (error) {
      const known = error instanceof AppError && ['WARMING_UP', 'LIVE_UNAVAILABLE'].includes(error.code);
      if (!known) telemetry?.log('stream_snapshot_failed', { code: error.code ?? error.name });
      return format('tracking-status', id, validate('trackingStatus', {
        epoch, revision, catalogVersion,
        serverTime: tracker.serverTime?.() ?? new Date(now()).toISOString(),
        quality: { ...tracker.status().quality, state: 'unavailable' },
        error: known ? { code: error.code, message: error.message }
          : { code: 'STREAM_DATA_INVALID', message: 'Live tracking data could not be delivered.' },
        retryAfter: 5,
      }));
    }
  }

  function broadcast() {
    if (!clients.size) return;
    const frame = currentFrame();
    for (const client of clients) send(client, frame);
  }

  function ensureSubscribed() {
    if (!unsubscribe && clients.size) unsubscribe = collector.onUpdate(broadcast);
  }
  function maybeUnsubscribe() {
    if (!clients.size && unsubscribe) { unsubscribe(); unsubscribe = null; }
  }

  function writeNow(client, frame) {
    client.writing = true;
    let ok;
    try { ok = client.res.write(frame); }
    catch { dropClient(client, 'write_error'); return; }
    if (ok) {
      client.writing = false;
      if (client.pending) {
        const next = client.pending;
        client.pending = null;
        writeNow(client, next);
      }
      return;
    }
    client.slowTimer = setTimeout(() => dropClient(client, 'slow_reader'), slowReaderMs);
    client.onDrain = () => {
      clearTimeout(client.slowTimer);
      client.writing = false;
      if (client.closed) return;
      if (client.pending) {
        const next = client.pending;
        client.pending = null;
        writeNow(client, next);
      }
    };
    client.res.once('drain', client.onDrain);
  }

  function send(client, frame) {
    if (client.closed) return;
    if (Buffer.byteLength(frame) > maxPendingBytes) {
      telemetry?.count('streamOversizedFrames');
      dropClient(client, 'frame_too_large');
      return;
    }
    if (client.writing) { client.pending = frame; return; } // latest-pending-only backpressure
    writeNow(client, frame);
  }

  function dropClient(client, reason) {
    if (client.closed) return;
    client.closed = true;
    clearTimeout(client.slowTimer);
    clearInterval(client.heartbeatTimer);
    if (client.onDrain) client.res.removeListener('drain', client.onDrain);
    client.res.removeListener('close', client.onClose);
    client.res.removeListener('error', client.onError);
    client.pending = null;
    clients.delete(client);
    const count = (byAddress.get(client.address) ?? 1) - 1;
    if (count <= 0) byAddress.delete(client.address); else byAddress.set(client.address, count);
    collector.noteStreamClose();
    telemetry?.count('streamClosed');
    telemetry?.log('stream_client_closed', { reason, connections: clients.size });
    maybeUnsubscribe();
    if (client.writing || ['slow_reader', 'write_error', 'error', 'frame_too_large'].includes(reason)) {
      client.res.destroy();
    } else if (!client.res.writableEnded) client.res.end();
  }

  return {
    // Validates limits, writes SSE headers, registers the client and sends
    // the initial frame. Throws (before any header is written) if limits
    // are exceeded or the hub is shutting down -- the caller's normal error
    // path then reports it like any other request.
    handle(req, res, { address }) {
      if (closed) throw new AppError('SHUTTING_DOWN', 'Server is shutting down', { status: 503, retryAfter: 5 });
      if (clients.size >= maxConnections) {
        throw new AppError('STREAM_LIMIT', 'Too many stream connections. Try again shortly.', { status: 503, retryAfter: 5 });
      }
      const addressCount = byAddress.get(address) ?? 0;
      if (addressCount >= maxConnectionsPerClient) {
        throw new AppError('STREAM_LIMIT', 'Too many stream connections from this client.', { status: 429, retryAfter: 5 });
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders?.();

      const client = { req, res, address, pending: null, writing: false, slowTimer: null, heartbeatTimer: null, closed: false };
      clients.add(client);
      byAddress.set(address, addressCount + 1);
      collector.noteStreamOpen();
      ensureSubscribed();
      telemetry?.count('streamOpened');
      telemetry?.log('stream_client_opened', { connections: clients.size });

      client.heartbeatTimer = setInterval(() => {
        if (!client.writing) send(client, ': heartbeat\n\n');
      }, heartbeatMs);
      client.heartbeatTimer.unref?.();

      client.onClose = () => dropClient(client, 'closed');
      client.onError = () => dropClient(client, 'error');
      res.once('close', client.onClose);
      res.once('error', client.onError);

      send(client, currentFrame());
    },

    // Ends every connection immediately (used during graceful shutdown, so
    // streams end within the server's existing shutdown deadline) and stops
    // accepting new ones.
    closeAll() {
      closed = true;
      for (const client of [...clients]) dropClient(client, 'shutdown');
    },

    status() {
      return { connections: clients.size, uniqueClients: byAddress.size };
    },
  };
}
