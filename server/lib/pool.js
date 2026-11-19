// Runs worker(item) over items with bounded concurrency. With keepPartial,
// cancellation preserves settled results and marks unfinished items rejected;
// otherwise cancellation rejects the pool.
// each result is { status: 'fulfilled', value } or { status: 'rejected', reason },
// in the same order as items.
export async function runPooled(items, concurrency, worker, { signal, keepPartial = false } = {}) {
  const results = new Array(items.length);
  let next = 0;

  async function run() {
    while (next < items.length) {
      if (signal?.aborted) {
        if (keepPartial) return;
        throw signal.reason;
      }
      const index = next++;
      try {
        results[index] = { status: 'fulfilled', value: await withSignal(Promise.resolve().then(() => worker(items[index], index)), signal) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return keepPartial
    ? Array.from(results, (result) => result ?? { status: 'rejected', reason: signal.reason })
    : results;
}
export function withSignal(pending, signal) {
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
