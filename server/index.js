import { config } from './lib/config.js';
import { createApplication } from './app.js';
import { createTelemetry } from './lib/telemetry.js';

const telemetry = createTelemetry();
const app = createApplication({ telemetry });
app.server.on('error', (error) => {
  telemetry.log('listen_failed', { code: error.code, message: error.message });
  app.shutdown();
  process.exitCode = 1;
});
app.server.listen(config.port, config.host, () => {
  telemetry.log('listening', { host: config.host, port: app.server.address().port });
  app.warmup();
});
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  telemetry.log('shutdown_started');
  app.shutdown();
  app.server.close(() => { process.exitCode = 0; });
  setTimeout(() => {
    telemetry.log('shutdown_deadline');
    app.server.closeAllConnections();
    process.exitCode = 1;
  }, 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
