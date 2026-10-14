import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function loadConfig(env = process.env) {
  function integer(name, fallback, min = 1, max = 2_147_483_647) {
    const raw = env[name] ?? String(fallback);
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`${name} must be an integer between ${min} and ${max}`);
    }
    return value;
  }
  const borealBase = env.BOREAL_BASE ?? 'https://boreal.tmix.se/Tmix.Cap.Ti.Process.AnyRide/api';
  const url = new URL(borealBase);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('BOREAL_BASE must be an HTTP(S) URL without credentials, query or fragment');
  }
  const allowedOrigins = (env.ALLOWED_ORIGINS ?? 'https://mhedqvist.github.io')
    .split(',').map((value) => value.trim()).filter(Boolean);
  for (const origin of allowedOrigins) {
    if (origin !== '*' && new URL(origin).origin !== origin) throw new Error('ALLOWED_ORIGINS must contain origins');
  }
  if (env.TRUST_PROXY && !['true', 'false'].includes(env.TRUST_PROXY)) throw new Error('TRUST_PROXY must be true or false');
  for (const name of ['HOST', 'BOREAL_PROFILE_DATA', 'BOREAL_PROFILE_DISPLAY', 'SNAPSHOT_PATH', 'STATIC_DIR']) {
    if (env[name] !== undefined && !env[name].trim()) throw new Error(`${name} cannot be empty`);
  }
  const upstreamConcurrency = integer('UPSTREAM_CONCURRENCY', 16, 2, 128);
  return {
    port: integer('PORT', 8080, 0, 65535),
    host: env.HOST ?? '0.0.0.0',
    borealBase: borealBase.replace(/\/+$/, ''),
    profileData: env.BOREAL_PROFILE_DATA ?? 'boreal_kiruna',
    profileDisplay: env.BOREAL_PROFILE_DISPLAY ?? 'boreal',
    upstreamTimeoutMs: integer('UPSTREAM_TIMEOUT_MS', 10000),
    refreshTimeoutMs: integer('REFRESH_TIMEOUT_MS', 60000),
    upstreamConcurrency,
    upstreamQueueSize: integer('UPSTREAM_QUEUE_SIZE', 256),
    upstreamQueueMs: integer('UPSTREAM_QUEUE_MS', 15000),
    upstreamMaxBytes: integer('UPSTREAM_MAX_BYTES', 4 * 1024 * 1024),
    clientRequestsPerMinute: integer('CLIENT_REQUESTS_PER_MINUTE', 240),
    globalRequestsPerMinute: integer('GLOBAL_REQUESTS_PER_MINUTE', 6000),
    trustProxy: env.TRUST_PROXY === 'true',
    allowedOrigins,
    snapshotPath: env.SNAPSHOT_PATH ? path.resolve(env.SNAPSHOT_PATH)
      : fileURLToPath(new URL('../data/bootstrap.json', import.meta.url)),
    staticDir: env.STATIC_DIR === 'off' ? null : env.STATIC_DIR ? path.resolve(env.STATIC_DIR)
      : fileURLToPath(new URL('../../src', import.meta.url)),
  };
}

export const config = loadConfig();
