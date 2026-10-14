// Runs worker(item) over items with bounded concurrency. Rejects on cancellation;
// each result is { status: 'fulfilled', value } or { status: 'rejected', reason },
// in the same order as items.
export async function runPooled(items, concurrency, worker, { signal } = {}) {
  const results = new Array(items.length);
  let next = 0;

  async function run() {
    while (next < items.length) {
      signal?.throwIfAborted();
      const index = next++;
      try {
        results[index] = { status: 'fulfilled', value: await withSignal(Promise.resolve().then(() => worker(items[index], index)), signal) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
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
