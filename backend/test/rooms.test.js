'use strict';

/**
 * REST rooms: create, join (the atomic, idempotent, capped join), list,
 * session (at most 2 queries), chat history pagination, member management.
 */
const mongoose = require('mongoose');
const request = require('supertest');
const { createApp } = require('../src/app');
const { Room, Message } = require('../src/models');
const inviteCodes = require('../src/lib/inviteCode');
const { setupTestDb, resetTestDb, teardownTestDb } = require('./helpers/db');
const { signup } = require('./helpers/auth');

let app;
beforeAll(async () => {
  await setupTestDb();
  app = createApp();
});
beforeEach(resetTestDb);
afterEach(() => jest.restoreAllMocks());
afterAll(teardownTestDb);

const bearer = (token) => ({ Authorization: `Bearer ${token}` });

/** Sign up n users: alice, bob, carol... */
async function users(n) {
  const names = ['alice', 'bob', 'carol', 'dave', 'erin'];
  const out = [];
  for (const name of names.slice(0, n)) {
    out.push(await signup(app, { name: name[0].toUpperCase() + name.slice(1), email: `${name}@example.com` }));
  }
  return out;
}

async function createRoom(token, body = { name: 'DSA prep' }) {
  const res = await request(app).post('/api/rooms').set(bearer(token)).send(body).expect(201);
  return res.body.room;
}

describe('POST /api/rooms', () => {
  test('requires auth', async () => {
    const res = await request(app).post('/api/rooms').send({ name: 'x' }).expect(401);
    expect(res.body.error.code).toBe('AUTH_MISSING');
  });

  test('201: creator is the owner; 8-char code from the unambiguous alphabet; no secrets in the response', async () => {
    const [alice] = await users(1);
    const room = await createRoom(alice.accessToken, { name: 'DSA prep', password: 'hunter22', language: 'cpp' });

    expect(room).toMatchObject({ name: 'DSA prep', language: 'cpp', myRole: 'owner', ownerId: alice.user.id });
    expect(room.inviteCode).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    expect(room.members).toEqual([expect.objectContaining({ userId: alice.user.id, name: 'Alice', role: 'owner' })]);
    expect(JSON.stringify(room)).not.toMatch(/password|\$2[aby]\$/i);

    const stored = await Room.findById(room.id).select('+passwordHash').lean();
    expect(stored.passwordHash).toMatch(/^\$2[aby]\$/); // bcrypt, never the plain password
  });

  test('retries with a new code when the invite code collides', async () => {
    const [alice] = await users(1);
    const spy = jest.spyOn(inviteCodes, 'generateInviteCode');
    spy.mockReturnValueOnce('SAMECODE');
    const first = await createRoom(alice.accessToken);
    spy.mockReturnValueOnce('SAMECODE').mockReturnValueOnce('OTHERCD2');
    const second = await createRoom(alice.accessToken);
    expect([first.inviteCode, second.inviteCode]).toEqual(['SAMECODE', 'OTHERCD2']);
  });

  test('400 on bad input (unknown language, empty name)', async () => {
    const [alice] = await users(1);
    const res = await request(app).post('/api/rooms').set(bearer(alice.accessToken)).send({ name: ' ', language: 'cobol' });
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d) => d.path).sort()).toEqual(['language', 'name']);
  });
});

describe('POST /api/rooms/join (the joinRoom service)', () => {
  test('joins by code as an editor; the code is case-insensitive', async () => {
    const [alice, bob] = await users(2);
    const room = await createRoom(alice.accessToken);
    const res = await request(app)
      .post('/api/rooms/join')
      .set(bearer(bob.accessToken))
      .send({ inviteCode: room.inviteCode.toLowerCase() })
      .expect(200);
    expect(res.body.room.myRole).toBe('editor');
    expect(res.body.room.members.map((m) => m.name)).toEqual(['Alice', 'Bob']);
  });

  test('idempotent: joining twice (or twice at once) adds the member once', async () => {
    const [alice, bob] = await users(2);
    const room = await createRoom(alice.accessToken);
    const join = () => request(app).post('/api/rooms/join').set(bearer(bob.accessToken)).send({ inviteCode: room.inviteCode });
    const results = await Promise.all([join(), join(), join()]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    await join().expect(200);
    const stored = await Room.findById(room.id).lean();
    expect(stored.members.filter((m) => String(m.userId) === bob.user.id)).toHaveLength(1);
  });

  test('404 ROOM_NOT_FOUND for an unknown code', async () => {
    const [alice] = await users(1);
    const res = await request(app).post('/api/rooms/join').set(bearer(alice.accessToken)).send({ inviteCode: 'NOPE2345' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ROOM_NOT_FOUND');
  });

  test('password-protected room: 403 when missing or wrong, 200 when right', async () => {
    const [alice, bob] = await users(2);
    const room = await createRoom(alice.accessToken, { name: 'secret', password: 'open sesame' });
    const join = (body) => request(app).post('/api/rooms/join').set(bearer(bob.accessToken)).send({ inviteCode: room.inviteCode, ...body });

    expect((await join({})).body.error.code).toBe('ROOM_PASSWORD_REQUIRED');
    expect((await join({ password: '' })).body.error.code).toBe('ROOM_PASSWORD_REQUIRED');
    const wrong = await join({ password: 'open says me' });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.code).toBe('ROOM_PASSWORD_INVALID');
    expect(await Room.countDocuments({ 'members.userId': bob.user.id })).toBe(0); // NOT added before the check (v1's bug)
    await join({ password: 'open sesame' }).expect(200);
  });

  test('409 ROOM_FULL at 20 members', async () => {
    const [alice, bob] = await users(2);
    const room = await createRoom(alice.accessToken);
    const filler = Array.from({ length: 19 }, (_, i) => ({ userId: new mongoose.Types.ObjectId(), name: `u${i}`, role: 'editor' }));
    await Room.updateOne({ _id: room.id }, { $push: { members: { $each: filler } } });

    const res = await request(app).post('/api/rooms/join').set(bearer(bob.accessToken)).send({ inviteCode: room.inviteCode });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ROOM_FULL');
  });

  test('race for the last seat: exactly one of three wins, and the cap holds', async () => {
    const [alice, bob, carol, dave] = await users(4);
    const room = await createRoom(alice.accessToken);
    const filler = Array.from({ length: 18 }, (_, i) => ({ userId: new mongoose.Types.ObjectId(), name: `u${i}`, role: 'editor' }));
    await Room.updateOne({ _id: room.id }, { $push: { members: { $each: filler } } }); // 19 members now

    const results = await Promise.all(
      [bob, carol, dave].map((u) => request(app).post('/api/rooms/join').set(bearer(u.accessToken)).send({ inviteCode: room.inviteCode })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect((await Room.findById(room.id).lean()).members).toHaveLength(20);
  });
});

describe('GET /api/rooms', () => {
  test('lists only my rooms, most recently active first, with cursor pagination', async () => {
    const [alice, bob] = await users(2);
    const a1 = await createRoom(alice.accessToken, { name: 'a1' });
    const a2 = await createRoom(alice.accessToken, { name: 'a2' });
    const a3 = await createRoom(alice.accessToken, { name: 'a3' });
    await createRoom(bob.accessToken, { name: 'bobs' });
    // Make the order unambiguous: a1 most recent, then a3, then a2.
    const t = Date.now();
    await Room.updateOne({ _id: a2.id }, { lastActiveAt: new Date(t - 3000) });
    await Room.updateOne({ _id: a3.id }, { lastActiveAt: new Date(t - 2000) });
    await Room.updateOne({ _id: a1.id }, { lastActiveAt: new Date(t - 1000) });

    const page1 = await request(app).get('/api/rooms?limit=2').set(bearer(alice.accessToken)).expect(200);
    expect(page1.body.rooms.map((r) => r.name)).toEqual(['a1', 'a3']);
    expect(page1.body.rooms[0]).toMatchObject({ memberCount: 1, myRole: 'owner' });
    expect(page1.body.nextCursor).toEqual(expect.any(String));

    const page2 = await request(app)
      .get(`/api/rooms?limit=2&before=${encodeURIComponent(page1.body.nextCursor)}`)
      .set(bearer(alice.accessToken))
      .expect(200);
    expect(page2.body.rooms.map((r) => r.name)).toEqual(['a2']);
    expect(page2.body.nextCursor).toBeNull();
  });
});

describe('GET /api/rooms/:roomId/session', () => {
  test('404 for non-members (does not reveal that the room exists) and for unknown ids; 400 for malformed ids', async () => {
    const [alice, bob] = await users(2);
    const room = await createRoom(alice.accessToken);
    const asBob = (id) => request(app).get(`/api/rooms/${id}/session`).set(bearer(bob.accessToken));
    expect((await asBob(room.id)).body.error.code).toBe('ROOM_NOT_FOUND');
    expect((await asBob(new mongoose.Types.ObjectId())).body.error.code).toBe('ROOM_NOT_FOUND');
    expect((await asBob('not-an-id')).status).toBe(400);
  });

  test('returns room, members, myRole and the last 50 messages (oldest first) in at most 2 queries', async () => {
    const [alice, bob] = await users(2);
    const room = await createRoom(alice.accessToken);
    await request(app).post('/api/rooms/join').set(bearer(bob.accessToken)).send({ inviteCode: room.inviteCode }).expect(200);
    await Message.insertMany(
      Array.from({ length: 60 }, (_, i) => ({ roomId: room.id, senderId: alice.user.id, senderName: 'Alice', body: `m${i}`, clientMsgId: `c${i}` })),
    );

    const queries = [];
    mongoose.set('debug', (collection, method) => queries.push(`${collection}.${method}`));
    let res;
    try {
      res = await request(app).get(`/api/rooms/${room.id}/session`).set(bearer(bob.accessToken)).expect(200);
    } finally {
      mongoose.set('debug', false);
    }

    expect(queries).toEqual(['rooms.findOne', 'messages.find']);
    expect(res.body.room).toMatchObject({ id: room.id, myRole: 'editor', inviteCode: room.inviteCode });
    expect(res.body.room.members).toEqual([
      expect.objectContaining({ name: 'Alice', role: 'owner', online: false }),
      expect.objectContaining({ name: 'Bob', role: 'editor', online: false }),
    ]);
    expect(res.body.messages).toHaveLength(50);
    expect(res.body.messages[0].body).toBe('m10');
    expect(res.body.messages.at(-1).body).toBe('m59');
    expect(res.body.hasMoreMessages).toBe(true);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash/);
  });
});

describe('GET /api/rooms/:roomId/messages (cursor pagination)', () => {
  test('walks 120 messages in pages of 50/50/20 with no gaps or overlaps', async () => {
    const [alice] = await users(1);
    const room = await createRoom(alice.accessToken);
    await Message.insertMany(
      Array.from({ length: 120 }, (_, i) => ({ roomId: room.id, senderId: alice.user.id, senderName: 'Alice', body: `m${i}`, clientMsgId: `c${i}` })),
    );
    // Noise in another room must never show up.
    await Message.create({ roomId: new mongoose.Types.ObjectId(), senderId: alice.user.id, senderName: 'A', body: 'other', clientMsgId: 'x' });

    const seen = [];
    let cursor = null;
    const sizes = [];
    for (;;) {
      const qs = cursor ? `?before=${cursor}` : '';
      const res = await request(app).get(`/api/rooms/${room.id}/messages${qs}`).set(bearer(alice.accessToken)).expect(200);
      sizes.push(res.body.messages.length);
      seen.unshift(...res.body.messages.map((m) => m.body));
      if (!res.body.hasMore) break;
      cursor = res.body.nextCursor;
    }
    expect(sizes).toEqual([50, 50, 20]);
    expect(seen).toEqual(Array.from({ length: 120 }, (_, i) => `m${i}`));
  });

  test('400 on a malformed cursor or limit', async () => {
    const [alice] = await users(1);
    const room = await createRoom(alice.accessToken);
    await request(app).get(`/api/rooms/${room.id}/messages?before=abc`).set(bearer(alice.accessToken)).expect(400);
    await request(app).get(`/api/rooms/${room.id}/messages?limit=1000`).set(bearer(alice.accessToken)).expect(400);
  });
});

describe('member management', () => {
  async function roomWithBob() {
    const [alice, bob, carol] = await users(3);
    const room = await createRoom(alice.accessToken);
    await request(app).post('/api/rooms/join').set(bearer(bob.accessToken)).send({ inviteCode: room.inviteCode }).expect(200);
    return { alice, bob, carol, room };
  }

  test('owner can demote an editor to viewer', async () => {
    const { alice, bob, room } = await roomWithBob();
    const res = await request(app)
      .patch(`/api/rooms/${room.id}/members/${bob.user.id}`)
      .set(bearer(alice.accessToken))
      .send({ role: 'viewer' })
      .expect(200);
    expect(res.body.member).toMatchObject({ userId: bob.user.id, role: 'viewer' });
    const stored = await Room.findById(room.id).lean();
    expect(stored.members.find((m) => String(m.userId) === bob.user.id).role).toBe('viewer');
  });

  test('a non-owner gets 403; the owner role cannot be changed or assigned', async () => {
    const { alice, bob, room } = await roomWithBob();
    const r1 = await request(app).patch(`/api/rooms/${room.id}/members/${alice.user.id}`).set(bearer(bob.accessToken)).send({ role: 'viewer' });
    expect(r1.status).toBe(403);
    const r2 = await request(app).patch(`/api/rooms/${room.id}/members/${alice.user.id}`).set(bearer(alice.accessToken)).send({ role: 'viewer' });
    expect(r2.body.error.code).toBe('CANNOT_CHANGE_OWNER');
    await request(app).patch(`/api/rooms/${room.id}/members/${bob.user.id}`).set(bearer(alice.accessToken)).send({ role: 'owner' }).expect(400);
  });

  test('owner removes a member; members can leave; the owner cannot leave; others cannot remove people', async () => {
    const { alice, bob, carol, room } = await roomWithBob();
    await request(app).post('/api/rooms/join').set(bearer(carol.accessToken)).send({ inviteCode: room.inviteCode }).expect(200);

    const bobKicksCarol = await request(app).delete(`/api/rooms/${room.id}/members/${carol.user.id}`).set(bearer(bob.accessToken));
    expect(bobKicksCarol.status).toBe(403);
    const ownerLeaves = await request(app).delete(`/api/rooms/${room.id}/members/${alice.user.id}`).set(bearer(alice.accessToken));
    expect(ownerLeaves.body.error.code).toBe('OWNER_CANNOT_LEAVE');

    await request(app).delete(`/api/rooms/${room.id}/members/${carol.user.id}`).set(bearer(alice.accessToken)).expect(204);
    await request(app).delete(`/api/rooms/${room.id}/members/${bob.user.id}`).set(bearer(bob.accessToken)).expect(204);
    const stored = await Room.findById(room.id).lean();
    expect(stored.members.map((m) => m.name)).toEqual(['Alice']);
    // Bob is no longer a member, so the room is invisible to him.
    await request(app).get(`/api/rooms/${room.id}/session`).set(bearer(bob.accessToken)).expect(404);
  });
});
