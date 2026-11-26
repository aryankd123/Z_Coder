'use strict';

// Must be set BEFORE src/ is loaded: config is read once per test file.
process.env.EXECUTIONS_PER_MINUTE = '2';

const request = require('supertest');
const { createApp } = require('../src/app');
const { MemoryQueue } = require('../src/execution/queue/memoryQueue');
const { createExecutionService } = require('../src/execution/executionService');
const { nullRealtime } = require('../src/realtime/nullRealtime');
const { setupTestDb, teardownTestDb } = require('./helpers/db');
const { signup } = require('./helpers/auth');
const { FakeExecutor } = require('./helpers/fakeExecutor');

let app;
beforeAll(async () => {
  await setupTestDb();
  const execution = createExecutionService({
    queue: new MemoryQueue({ concurrency: 1, maxWaiting: 10 }),
    executor: new FakeExecutor(),
    realtime: nullRealtime,
    limits: { runTimeoutMs: 1000, compileTimeoutMs: 1000, memoryMb: 64, outputBytes: 1024 },
  });
  app = createApp({ execution });
});
afterAll(teardownTestDb);

test('the 3rd run within a minute is RATE_LIMITED, per user', async () => {
  const alice = await signup(app, { email: 'alice@example.com' });
  const bob = await signup(app, { email: 'bob@example.com' });
  const run = (token) =>
    request(app).post('/api/executions').set('Authorization', `Bearer ${token}`).send({ language: 'javascript', source: 'console.log(1)' });

  const statuses = [];
  for (let i = 0; i < 3; i += 1) statuses.push((await run(alice.accessToken)).status);
  expect(statuses).toEqual([202, 202, 429]);
  expect((await run(bob.accessToken)).status).toBe(202); // Bob has his own budget
});
