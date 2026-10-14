import { AppError } from './errors.js';

export function createScheduler({ concurrency = 16, maxQueue = 256, queueMs = 15000 } = {}) {
  const queues = { interactive: [], background: [] };
  let active = 0;
  let background = 0;
  let closed = false;

  function drain() {
    while (!closed && active < concurrency) {
      const job = queues.interactive.shift() ??
        (background < concurrency - 1 ? queues.background.shift() : null);
      if (!job) break;
      clearTimeout(job.timer);
      job.signal?.removeEventListener('abort', job.abort);
      active++;
      if (job.priority === 'background') background++;
      const finish = () => {
        active--;
        if (job.priority === 'background') background--;
        drain();
      };
      Promise.resolve().then(job.work).then(
        (value) => { finish(); job.resolve(value); },
        (error) => { finish(); job.reject(error); },
      );
    }
  }
  function rejectQueued(job, error) {
    const queue = queues[job.priority];
    const index = queue.indexOf(job);
    if (index < 0) return;
    queue.splice(index, 1);
    clearTimeout(job.timer);
    job.signal?.removeEventListener('abort', job.abort);
    job.reject(error);
  }
  return {
    run(work, { priority = 'interactive', signal } = {}) {
      if (closed) return Promise.reject(new AppError('SHUTTING_DOWN', 'Server is shutting down', { status: 503 }));
      if (signal?.aborted) return Promise.reject(signal.reason);
      if (queues.interactive.length + queues.background.length >= maxQueue
        && !(priority === 'interactive' && active < concurrency)) {
        return Promise.reject(new AppError('UPSTREAM_BUSY', 'Live data is busy. Try again shortly.', { status: 503, retryAfter: 5 }));
      }
      return new Promise((resolve, reject) => {
        const job = { work, priority, signal, resolve, reject };
        job.abort = () => rejectQueued(job, signal.reason);
        job.timer = setTimeout(() => rejectQueued(job,
          new AppError('UPSTREAM_QUEUE_TIMEOUT', 'Live data is busy. Try again shortly.', { status: 503, retryAfter: 5 })), queueMs);
        signal?.addEventListener('abort', job.abort, { once: true });
        queues[priority].push(job);
        drain();
      });
    },
    status: () => ({ active, queued: queues.interactive.length + queues.background.length, concurrency }),
    close() {
      closed = true;
      for (const queue of Object.values(queues)) {
        for (const job of [...queue]) rejectQueued(job, new AppError('SHUTTING_DOWN', 'Server is shutting down', { status: 503 }));
      }
    },
  };
}
