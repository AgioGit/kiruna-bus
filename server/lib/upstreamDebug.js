const MAX_ENTRIES = 100;
const MAX_BYTES = 2 * 1024 * 1024;
const BODY_BYTES = 64 * 1024;
const sensitive = /authorization|cookie|password|secret|token|credential|api[-_]?key/i;

function headersDto(headers) {
  return Object.fromEntries([...new Headers(headers)].map(([key, value]) => [key, sensitive.test(key) ? '[redacted]' : value]));
}

function bodyDto(buffer) {
  const text = buffer.toString('utf8');
  if (!text) return null;
  let value;
  try { value = JSON.parse(text); }
  catch { return text; }
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== 'object') continue;
    for (const key of Object.keys(item)) {
      if (sensitive.test(key)) item[key] = '[redacted]';
      else if (item[key] && typeof item[key] === 'object') pending.push(item[key]);
    }
  }
  return value;
}

function safeUrl(value) {
  const url = new URL(value);
  url.username = '';
  url.password = '';
  for (const key of [...url.searchParams.keys()]) if (sensitive.test(key)) url.searchParams.set(key, '[redacted]');
  return url.href;
}

export function createUpstreamDebug({ now = Date.now, monotonic = () => performance.now() } = {}) {
  let entries = [], bytes = 2, dropped = 0, sequence = 0, closed = false;
  return {
    snapshot() {
      return { entries: entries.map((entry) => entry.value), dropped };
    },
    clear() { entries = []; bytes = 2; dropped = 0; },
    close() { closed = true; entries = []; bytes = 2; dropped = 0; },
    start({ provider, url, method = 'GET', headers, body }) {
      const id = ++sequence;
      const startedAt = new Date(now()).toISOString();
      const started = monotonic();
      const requestBody = Buffer.from(body ?? '');
      const request = {
        method, url: safeUrl(url), headers: headersDto(headers),
        body: bodyDto(requestBody.subarray(0, BODY_BYTES)), bodyTruncated: requestBody.length > BODY_BYTES,
      };
      let response = null, error = null, size = 0, truncated = false, complete = false, finished = false;
      const chunks = [];
      const trace = {
        response(value) {
          response = { status: value.status, headers: headersDto(value.headers), body: null, bodyTruncated: false };
        },
        chunk(value) {
          const buffer = Buffer.from(value);
          const remaining = BODY_BYTES - size;
          if (buffer.length > remaining) truncated = true;
          if (remaining > 0) {
            const part = buffer.subarray(0, remaining);
            chunks.push(Buffer.from(part));
            size += part.length;
          }
        },
        truncate() { truncated = true; },
        complete() { complete = true; },
        async errorBody(value) {
          for await (const chunk of value.body ?? []) {
            trace.chunk(chunk);
            if (truncated) return;
          }
          complete = true;
        },
        fail(value) {
          error = { code: typeof value?.code === 'string' ? value.code : value?.name ?? 'UPSTREAM_ERROR' };
        },
        finish() {
          if (finished || closed) return;
          finished = true;
          if (response) {
            response.body = bodyDto(Buffer.concat(chunks));
            response.bodyTruncated = truncated || !complete;
          }
          const value = {
            id, provider, call: new URL(request.url).pathname.split('/').at(-1),
            startedAt, durationMs: Math.max(0, Math.round(monotonic() - started)),
            request, response, error,
          };
          const entryBytes = Buffer.byteLength(JSON.stringify(value)) + 1;
          if (entryBytes > MAX_BYTES) { dropped++; return; }
          entries.push({ value, bytes: entryBytes });
          bytes += entryBytes;
          while (entries.length > MAX_ENTRIES || bytes > MAX_BYTES) {
            bytes -= entries.shift().bytes;
            dropped++;
          }
        },
      };
      return trace;
    },
  };
}
