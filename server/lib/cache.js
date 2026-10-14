// Small in-memory TTL cache. When full, the oldest-inserted entry is evicted.
export class TtlCache {
  constructor({ maxEntries = 1000, maxBytes = 16 * 1024 * 1024, now = Date.now } = {}) {
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = new Map();
    this.maxBytes = maxBytes;
    this.bytes = 0;
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, ttlMs) {
    const bytes = Buffer.byteLength(key) + (value?.body?.length ?? Buffer.byteLength(JSON.stringify(value)));
    if (bytes > this.maxBytes) return;
    this.delete(key);
    while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) {
      this.delete(this.entries.keys().next().value);
    }
    this.entries.set(key, { value, bytes, expiresAt: this.now() + ttlMs });
    this.bytes += bytes;
  }

  delete(key) {
    const entry = this.entries.get(key);
    if (entry) this.bytes -= entry.bytes;
    this.entries.delete(key);
  }

  get size() {
    return this.entries.size;
  }
}
