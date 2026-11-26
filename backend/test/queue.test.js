'use strict';

const { MemoryQueue } = require('../src/execution/queue/memoryQueue');

const tick = () => new Promise((r) => setImmediate(r));

describe('MemoryQueue', () => {
  test('never runs more than `concurrency` jobs at once, and runs them in order', async () => {
    const q = new MemoryQueue({ concurrency: 2, maxWaiting: 10 });
    let running = 0;
    let peak = 0;
    const order = [];
    q.process(async (job) => {
      running += 1;
      peak = Math.max(peak, running);
      order.push(job.id);
      await new Promise((r) => setTimeout(r, 20));
      running -= 1;
    });
    const drained = new Promise((r) => q.once('drained', r));
    for (let i = 0; i < 6; i += 1) q.add(`j${i}`, {});
    await drained;
    expect(peak).toBe(2);
    expect(order).toEqual(['j0', 'j1', 'j2', 'j3', 'j4', 'j5']);
  });

  test('refuses new jobs beyond maxWaiting (backpressure)', async () => {
    const q = new MemoryQueue({ concurrency: 1, maxWaiting: 2 });
    let release;
    q.process(() => new Promise((r) => (release = r)));
    expect(q.add('a', {})).toBe(true); // starts running
    await tick();
    expect(q.add('b', {})).toBe(true); // waiting 1
    expect(q.add('c', {})).toBe(true); // waiting 2
    expect(q.isFull).toBe(true);
    expect(q.add('d', {})).toBe(false);
    expect(q.stats()).toEqual({ waiting: 2, active: 1, concurrency: 1 });
    release();
  });

  test('a failing job emits failed and does not stop the queue', async () => {
    const q = new MemoryQueue({ concurrency: 1, maxWaiting: 5 });
    const failed = [];
    const done = [];
    q.on('failed', (job) => failed.push(job.id));
    q.on('completed', (job) => done.push(job.id));
    q.process(async (job) => {
      if (job.id === 'bad') throw new Error('nope');
      return 'ok';
    });
    const drained = new Promise((r) => q.once('drained', r));
    q.add('bad', {});
    q.add('good', {});
    await drained;
    expect(failed).toEqual(['bad']);
    expect(done).toEqual(['good']);
  });

  test('close() waits for running jobs and refuses new ones', async () => {
    const q = new MemoryQueue({ concurrency: 1, maxWaiting: 5 });
    let finished = false;
    q.process(async () => {
      await new Promise((r) => setTimeout(r, 50));
      finished = true;
    });
    q.add('a', {});
    await tick();
    await q.close();
    expect(finished).toBe(true);
    expect(q.add('b', {})).toBe(false);
  });
});
