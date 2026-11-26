'use strict';

// Must be set BEFORE src/ is loaded: config is read once per test file.
process.env.CHAT_MESSAGES_PER_10S = '3';

const request = require('supertest');
const { setupTestDb, teardownTestDb } = require('./helpers/db');
const { signup } = require('./helpers/auth');
const { startServer, emitAck } = require('./helpers/realtime');
const { createWindowLimiter } = require('../src/lib/rateLimit');

let srv;
beforeAll(async () => {
  await setupTestDb();
  srv = await startServer();
});
afterAll(async () => {
  await srv.close();
  await teardownTestDb();
});

test('the 4th chat message within 10 s is rejected with RATE_LIMITED, across all of a user\'s tabs', async () => {
  const alice = await signup(srv.app);
  const { body } = await request(srv.app).post('/api/rooms').set('Authorization', `Bearer ${alice.accessToken}`).send({ name: 'r' });
  const roomId = body.room.id;
  const tab1 = await srv.connect(alice.accessToken);
  const tab2 = await srv.connect(alice.accessToken);
  await emitAck(tab1, 'room:join', { roomId });
  await emitAck(tab2, 'room:join', { roomId });

  const results = [];
  for (let i = 0; i < 4; i += 1) {
    const tab = i % 2 === 0 ? tab1 : tab2;
    results.push(await emitAck(tab, 'chat:send', { roomId, body: `m${i}`, clientMsgId: `id${i}` }));
  }
  expect(results.map((r) => r.ok)).toEqual([true, true, true, false]);
  expect(results[3].error.code).toBe('RATE_LIMITED');
});

test('createWindowLimiter resets after the window', () => {
  let t = 0;
  const limiter = createWindowLimiter({ limit: 2, windowMs: 1000, now: () => t });
  expect([limiter.consume('a'), limiter.consume('a'), limiter.consume('a'), limiter.consume('b')]).toEqual([true, true, false, true]);
  t = 1000;
  expect(limiter.consume('a')).toBe(true);
});
