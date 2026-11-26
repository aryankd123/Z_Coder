'use strict';

/**
 * MemoryQueue: the in-process queue adapter.
 *
 * Why a queue at all, even in one process?
 *   - Backpressure: at most `concurrency` programs run at once, and at most
 *     `maxWaiting` wait. Beyond that, add() refuses (the API answers 503),
 *     instead of starting 500 compilers and taking the server down.
 *   - Isolation of the request path: POST /executions returns 202 at once;
 *     a slow or hostile program never holds an HTTP request open.
 *   - One seam: BullMQ (Redis) has the same shape (add a job; a worker
 *     processes jobs with a concurrency; events say when one becomes
 *     active, completes or fails), so swapping adapters doesn't touch the
 *     execution service. That swap is deferred until Docker/Redis are allowed.
 *
 * Delivery: AT MOST ONCE. A job is never retried, because user code may have
 * side effects and a retry would double them; a crash mid-run marks the
 * submission INTERNAL_ERROR at the next boot (see executionService.recoverStale).
 * The trade-off of memory: a process crash loses waiting jobs. Redis wouldn't.
 */
const { EventEmitter } = require('node:events');

class MemoryQueue extends EventEmitter {
  /**
   * @param {{ concurrency: number, maxWaiting: number }} options
   */
  constructor({ concurrency, maxWaiting }) {
    super();
    this.concurrency = concurrency;
    this.maxWaiting = maxWaiting;
    /** @type {{ id: string, data: any, addedAt: number }[]} */
    this.waiting = [];
    this.active = 0;
    this.handler = null;
    this.closed = false;
    this.idleWaiters = [];
  }

  /** Room for one more job? */
  get isFull() {
    return this.waiting.length >= this.maxWaiting;
  }

  /**
   * Enqueue a job. Returns false (and does nothing) when the queue is full or closed.
   * @param {string} id
   * @param {any} data
   */
  add(id, data) {
    if (this.closed || this.isFull) return false;
    this.waiting.push({ id, data, addedAt: Date.now() });
    this.emit('waiting', { id });
    this._pump();
    return true;
  }

  /**
   * Register the worker function (one per queue).
   * @param {(job: { id: string, data: any }) => Promise<unknown>} handler
   */
  process(handler) {
    this.handler = handler;
    this._pump();
  }

  stats() {
    return { waiting: this.waiting.length, active: this.active, concurrency: this.concurrency };
  }

  /** Stop taking jobs and wait for the running ones to finish. */
  async close() {
    this.closed = true;
    if (this.active === 0) return;
    await new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  _pump() {
    while (this.handler && this.active < this.concurrency && this.waiting.length > 0) {
      const job = this.waiting.shift();
      this.active += 1;
      this.emit('active', job);
      Promise.resolve()
        .then(() => this.handler(job))
        .then(
          (result) => this.emit('completed', job, result),
          (err) => this.emit('failed', job, err),
        )
        .finally(() => {
          this.active -= 1;
          if (this.active === 0 && this.waiting.length === 0) {
            for (const resolve of this.idleWaiters.splice(0)) resolve();
            this.emit('drained');
          }
          if (!this.closed) this._pump();
          else if (this.active === 0) for (const resolve of this.idleWaiters.splice(0)) resolve();
        });
    }
  }
}

module.exports = { MemoryQueue };
