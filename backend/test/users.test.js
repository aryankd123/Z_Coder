'use strict';

const request = require('supertest');
const { createApp } = require('../src/app');
const { Room, User } = require('../src/models');
const { setupTestDb, resetTestDb, teardownTestDb } = require('./helpers/db');
const { signup } = require('./helpers/auth');

let app;
beforeAll(async () => {
  await setupTestDb();
  app = createApp();
});
beforeEach(resetTestDb);
afterAll(teardownTestDb);

describe('/api/users/me', () => {
  test('requires authentication', async () => {
    const res = await request(app).get('/api/users/me').expect(401);
    expect(res.body.error.code).toBe('AUTH_MISSING');
  });

  test('GET returns the public profile', async () => {
    const { accessToken } = await signup(app);
    const res = await request(app).get('/api/users/me').set('Authorization', `Bearer ${accessToken}`).expect(200);
    expect(res.body.user).toMatchObject({ name: 'Alice', email: 'alice@example.com', techStack: [] });
  });

  test('PATCH updates allowed fields and ignores email/passwordHash', async () => {
    const { accessToken } = await signup(app);
    const res = await request(app)
      .patch('/api/users/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ favLang: 'cpp', techStack: ['node', 'mongo'], email: 'evil@x.com', passwordHash: 'x' })
      .expect(200);
    expect(res.body.user).toMatchObject({ email: 'alice@example.com', favLang: 'cpp', techStack: ['node', 'mongo'] });

    const doc = await User.findOne({ email: 'alice@example.com' }).select('+passwordHash').lean();
    expect(doc.passwordHash).not.toBe('x');
  });

  test('PATCH with nothing to update -> 400', async () => {
    const { accessToken } = await signup(app);
    await request(app).patch('/api/users/me').set('Authorization', `Bearer ${accessToken}`).send({}).expect(400);
  });

  test('renaming updates the denormalised name in every room membership', async () => {
    const { accessToken, user } = await signup(app);
    const bob = await User.create({ name: 'Bob', email: 'bob@example.com', passwordHash: 'x' });
    const member = (u, name, role) => ({ userId: u, name, role });
    await Room.create([
      { name: 'r1', inviteCode: 'AAAA1111', ownerId: user.id, members: [member(user.id, 'Alice', 'owner'), member(bob._id, 'Bob', 'editor')] },
      { name: 'r2', inviteCode: 'BBBB2222', ownerId: bob._id, members: [member(bob._id, 'Bob', 'owner'), member(user.id, 'Alice', 'viewer')] },
    ]);

    await request(app)
      .patch('/api/users/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name: 'Alice Cooper' })
      .expect(200);

    const rooms = await Room.find().sort({ name: 1 }).lean();
    const names = rooms.map((r) => r.members.map((m) => m.name));
    expect(names).toEqual([
      ['Alice Cooper', 'Bob'],
      ['Bob', 'Alice Cooper'],
    ]);
  });
});
