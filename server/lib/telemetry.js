export function createTelemetry({ write = (line) => console.log(line) } = {}) {
  const counters = {};
  const timings = {};
  return {
    count(name, amount = 1) { counters[name] = (counters[name] ?? 0) + amount; },
    duration(name, ms) {
      const entry = timings[name] ?? { count: 0, totalMs: 0, maxMs: 0 };
      entry.count++;
      entry.totalMs += Math.round(ms);
      entry.maxMs = Math.max(entry.maxMs, Math.round(ms));
      timings[name] = entry;
    },
    log(event, fields = {}) { write(JSON.stringify({ time: new Date().toISOString(), event, ...fields })); },
    snapshot() { return structuredClone({ counters, timings }); },
  };
}
