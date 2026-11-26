'use strict';

/**
 * Code execution end to end, with a fake executor (deterministic, instant)
 * and the real queue, service, REST routes and Socket.IO broadcast.
 */
const request = require('supertest');
const mongoose = require('mongoose');
const { Submission } = require('../src/models');
const { RoomManager } = require('../src/realtime/roomManager');
const { MemoryQueue } = require('../src/execution/queue/memoryQueue');
const { createExecutionService } = require('../src/execution/executionService');
const { createApp } = require('../src/app');
const { setupTestDb, resetTestDb, teardownTestDb } = require('./helpers/db');
const { signup } = require('./helpers/auth');
const { startServer, emitAck } = require('./helpers/realtime');
const { FakeExecutor } = require('./helpers/fakeExecutor');
const { waitFor } = require('./helpers/yjsClient');

const limits = { runTimeoutMs: 2000, compileTimeoutMs: 10000, memoryMb: 256, outputBytes: 64 * 1024 };
const bearer = (token) => ({ Authorization: `Bearer ${token}` });

let srv;
let executor;
let execution;
let app;

beforeAll(async () => {
  await setupTestDb();
  executor = new FakeExecutor();
  const roomManager = new RoomManager({ persistDebounceMs: 50 });
  // One worker and room for 3 waiting runs, so backpressure is easy to hit.
  const queue = new MemoryQueue({ concurrency: 1, maxWaiting: 3 });
  execution = createExecutionService({ queue, executor, realtime: roomManager, limits });
  srv = await startServer({ roomManager, execution });
  app = srv.app;
});
beforeEach(async () => {
  await resetTestDb();
  executor.calls.length = 0;
  executor.gate = null;
  executor.script = (req) => ({ compile: null, stdout: req.stdin.toUpperCase(), stderr: '', exitCode: 0, signal: null, timedOut: false, timeMs: 7 });
});
afterAll(async () => {
  await srv.close();
  await teardownTestDb();
});

async function roomScenario() {
  const alice = await signup(app, { name: 'Alice', email: 'alice@example.com' });
  const bob = await signup(app, { name: 'Bob', email: 'bob@example.com' });
  const carol = await signup(app, { name: 'Carol', email: 'carol@example.com' });
  const { body } = await request(app).post('/api/rooms').set(bearer(alice.accessToken)).send({ name: 'r' }).expect(201);
  await request(app).post('/api/rooms/join').set(bearer(bob.accessToken)).send({ inviteCode: body.room.inviteCode }).expect(200);
  return { alice, bob, carol, roomId: body.room.id };
}

const run = (token, body) =>
  request(app)
    .post('/api/executions')
    .set(bearer(token))
    .send({ language: 'python', source: 'print(input().upper())', stdin: 'hi', ...body });

describe('POST /api/executions + GET /api/executions/:id', () => {
  test('202 queued, then the poll shows the finished result with a verdict', async () => {
    const { alice } = await roomScenario();
    const res = await run(alice.accessToken).expect(202);
    expect(res.body.execution).toMatchObject({ status: 'queued', language: 'python', userName: 'Alice', roomId: null });
    expect(res.headers.location).toBe(`/api/executions/${res.body.execution.id}`);

    const done = await waitFor(async () => {
      const r = await request(app).get(`/api/executions/${res.body.execution.id}`).set(bearer(alice.accessToken));
      return r.body.execution.status === 'finished' && r.body.execution;
    });
    expect(done).toMatchObject({ verdict: 'OK', stdout: 'HI', timeMs: 7, source: 'print(input().upper())', stdin: 'hi' });
    expect(new Date(done.finishedAt) >= new Date(done.startedAt)).toBe(true);
    expect(executor.calls[0]).toMatchObject({ language: 'python', stdin: 'hi', limits });
  });

  test('requires auth; validates language and size limits (64 KB, in bytes)', async () => {
    const { alice } = await roomScenario();
    await request(app).post('/api/executions').send({ language: 'python', source: 'x' }).expect(401);
    expect((await run(alice.accessToken, { language: 'cobol' })).status).toBe(400);
    expect((await run(alice.accessToken, { source: '   ' })).status).toBe(400);
    const big = 'é'.repeat(33 * 1024); // 33k characters, but 66 KB in UTF-8
    const res = await run(alice.accessToken, { source: big });
    expect(res.status).toBe(400);
    expect(res.body.error.details[0]).toMatchObject({ path: 'source' });
  });

  test('a private run is visible only to its author', async () => {
    const { alice, bob } = await roomScenario();
    const { body } = await run(alice.accessToken).expect(202);
    await request(app).get(`/api/executions/${body.execution.id}`).set(bearer(bob.accessToken)).expect(404);
    await request(app).get(`/api/executions/${new mongoose.Types.ObjectId()}`).set(bearer(alice.accessToken)).expect(404);
  });

  test('an executor that throws becomes INTERNAL_ERROR, never a hung "running" run', async () => {
    const { alice } = await roomScenario();
    executor.script = () => {
      throw new Error('kaboom');
    };
    const { body } = await run(alice.accessToken).expect(202);
    const done = await waitFor(async () => (await Submission.findById(body.execution.id).lean()).status === 'finished');
    expect(done).toBe(true);
    expect((await Submission.findById(body.execution.id).lean()).verdict).toBe('INTERNAL_ERROR');
  });
});

describe('room runs: the shared console', () => {
  test('every member sees queued -> running -> finished live, and members can open the run', async () => {
    const { alice, bob, roomId } = await roomScenario();
    const a = await srv.connect(alice.accessToken);
    const b = await srv.connect(bob.accessToken);
    await emitAck(a, 'room:join', { roomId });
    await emitAck(b, 'room:join', { roomId });
    const seenByBob = [];
    b.on('execution:update', (e) => seenByBob.push(e));

    const { body } = await run(alice.accessToken, { roomId }).expect(202);
    await waitFor(() => seenByBob.some((e) => e.status === 'finished'), { message: 'finished update' });

    expect(seenByBob.map((e) => e.status)).toEqual(['queued', 'running', 'finished']);
    expect(seenByBob.every((e) => e.id === body.execution.id && e.roomId === roomId)).toBe(true);
    expect(seenByBob.at(-1)).toMatchObject({ verdict: 'OK', stdout: 'HI', userName: 'Alice' });
    expect(seenByBob[0].source).toBeUndefined(); // broadcasts carry results, not the code

    const detail = await request(app).get(`/api/executions/${body.execution.id}`).set(bearer(bob.accessToken)).expect(200);
    expect(detail.body.execution.source).toBe('print(input().upper())');
    a.close();
    b.close();
  });

  test('viewers cannot run code in the room; non-members get 404 for the room and its runs', async () => {
    const { alice, bob, carol, roomId } = await roomScenario();
    await request(app).patch(`/api/rooms/${roomId}/members/${bob.user.id}`).set(bearer(alice.accessToken)).send({ role: 'viewer' }).expect(200);
    const viewer = await run(bob.accessToken, { roomId });
    expect(viewer.status).toBe(403);
    expect(viewer.body.error.code).toBe('ROOM_FORBIDDEN');

    expect((await run(carol.accessToken, { roomId })).body.error.code).toBe('ROOM_NOT_FOUND');
    const { body } = await run(alice.accessToken, { roomId }).expect(202);
    await request(app).get(`/api/executions/${body.execution.id}`).set(bearer(carol.accessToken)).expect(404);
    await request(app).get(`/api/rooms/${roomId}/executions`).set(bearer(carol.accessToken)).expect(404);
    expect(await Submission.countDocuments()).toBe(1); // the refused runs were never stored
  });

  test('GET /api/rooms/:roomId/executions lists runs newest first, without the code, with a cursor', async () => {
    const { alice, roomId } = await roomScenario();
    for (const stdin of ['a', 'b', 'c']) await run(alice.accessToken, { roomId, stdin }).expect(202);
    await waitFor(async () => (await Submission.countDocuments({ status: 'finished' })) === 3);

    const page1 = await request(app).get(`/api/rooms/${roomId}/executions?limit=2`).set(bearer(alice.accessToken)).expect(200);
    expect(page1.body.executions.map((e) => e.stdout)).toEqual(['C', 'B']);
    expect(page1.body.executions[0].source).toBeUndefined();
    const page2 = await request(app)
      .get(`/api/rooms/${roomId}/executions?limit=2&before=${page1.body.nextCursor}`)
      .set(bearer(alice.accessToken))
      .expect(200);
    expect(page2.body.executions.map((e) => e.stdout)).toEqual(['A']);
    expect(page2.body.nextCursor).toBeNull();
  });
});

describe('backpressure and recovery', () => {
  test('503 QUEUE_FULL once maxWaiting runs are waiting; nothing is stored for the refused run', async () => {
    const { alice } = await roomScenario();
    executor.hold(); // the first run blocks the single worker
    const statuses = [];
    for (let i = 0; i < 5; i += 1) statuses.push((await run(alice.accessToken, { stdin: `${i}` })).status);
    // 1 running + 3 waiting (maxWaiting) accepted, the 5th refused.
    expect(statuses).toEqual([202, 202, 202, 202, 503]);
    expect(await Submission.countDocuments()).toBe(4);
    executor.release();
    await waitFor(async () => (await Submission.countDocuments({ status: 'finished' })) === 4, { timeout: 5000 });
  });

  test('recoverStale marks runs a crash left queued or running as INTERNAL_ERROR (at-most-once: not re-run)', async () => {
    const { alice } = await roomScenario();
    const base = { userId: alice.user.id, language: 'python', source: 'x' };
    await Submission.create([{ ...base, status: 'queued' }, { ...base, status: 'running' }, { ...base, status: 'finished', verdict: 'OK' }]);
    expect(await execution.recoverStale()).toBe(2);
    const verdicts = (await Submission.find().sort({ _id: 1 }).lean()).map((s) => s.verdict);
    expect(verdicts).toEqual(['INTERNAL_ERROR', 'INTERNAL_ERROR', 'OK']);
    expect(executor.calls).toHaveLength(0);
  });

  test('an app without an execution service answers 503 EXECUTION_UNAVAILABLE', async () => {
    const bare = createApp();
    const { accessToken } = await signup(bare, { email: 'z@example.com' });
    const res = await request(bare).post('/api/executions').set(bearer(accessToken)).send({ language: 'python', source: 'x' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('EXECUTION_UNAVAILABLE');
  });
});
