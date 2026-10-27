/** Process-wide admission: cancellation settles callers immediately but retains a running slot until cleanup ends. */
export class ExtensionAdmission {
  constructor({ concurrency = 2, queueLimit = 16, waitMs = 15000 } = {}) {
    if (
      !Number.isInteger(concurrency) ||
      concurrency < 1 ||
      concurrency > 4 ||
      !Number.isInteger(queueLimit) ||
      queueLimit < 0 ||
      queueLimit > 64 ||
      !Number.isInteger(waitMs) ||
      waitMs < 1 ||
      waitMs > 30000
    )
      throw new Error('invalid_admission_limits');
    this.concurrency = concurrency;
    this.queueLimit = queueLimit;
    this.waitMs = waitMs;
    this.active = 0;
    this.queue = [];
  }

  run(task, signal) {
    if (signal?.aborted) return Promise.reject(new Error('cancelled'));
    if (this.active >= this.concurrency && this.queue.length >= this.queueLimit)
      return Promise.reject(new Error('execution_busy'));
    return new Promise((resolve, reject) => {
      const entry = { task, signal, resolve, reject, started: false, settled: false };
      const finish = (error, value) => {
        if (entry.settled) return;
        entry.settled = true;
        clearTimeout(entry.timer);
        signal?.removeEventListener('abort', entry.cancel);
        if (error) reject(error);
        else resolve(value);
      };
      entry.finish = finish;
      entry.cancel = () => {
        const index = this.queue.indexOf(entry);
        if (index >= 0) this.queue.splice(index, 1);
        finish(new Error('cancelled'));
      };
      signal?.addEventListener('abort', entry.cancel, { once: true });
      if (signal?.aborted) return entry.cancel();
      if (this.active < this.concurrency) this.start(entry);
      else {
        entry.timer = setTimeout(() => {
          const index = this.queue.indexOf(entry);
          if (index >= 0) this.queue.splice(index, 1);
          finish(new Error('execution_busy'));
        }, this.waitMs);
        this.queue.push(entry);
      }
    });
  }

  start(entry) {
    clearTimeout(entry.timer);
    entry.started = true;
    this.active++;
    Promise.resolve()
      .then(() => {
        if (entry.signal?.aborted) throw new Error('cancelled');
        return entry.task();
      })
      .then(
        (result) => entry.finish(undefined, result),
        (error) => entry.finish(error),
      )
      .finally(() => {
        this.active--;
        while (this.active < this.concurrency && this.queue.length) {
          const next = this.queue.shift();
          if (!next.settled) this.start(next);
        }
      });
  }
}
