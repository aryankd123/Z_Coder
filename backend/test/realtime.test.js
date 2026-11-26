'use strict';

/**
 * Socket.IO integration: real server, real clients, real MongoDB.
 * Covers the handshake, membership on every event, chat delivery and
 * persistence, idempotency, presence across tabs, live role changes and
 * kicks, rate limiting and token expiry.
 */
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { Message } = require('../src/models');
const { setupTestDb, resetTestDb, teardownTestDb } = require('./helpers/db');
const { signup } = require('./helpers/auth');
const { startServer, emitAck, nextEvent, noEvent } = require('./helpers/realtime');

let srv;
beforeAll(async () => {
  await setupTestDb();
  srv = await startServer();
});
beforeEach(resetTestDb);
afterAll(async () => {
  await srv.close();
  await teardownTestDb();
});

const bearer = (token) => ({ Authorization: `Bearer ${token}` });

/** Alice owns a room; Bob has joined it over REST; Carol is not a member. */
async function scenario() {
  const alice = await signup(srv.app, { name: 'Alice', email: 'alice@example.com' });
  const bob = await signup(srv.app, { name: 'Bob', email: 'bob@example.com' });
  const carol = await signup(srv.app, { name: 'Carol', email: 'carol@example.com' });
  const { body } = await request(srv.app).post('/api/rooms').set(bearer(alice.accessToken)).send({ name: 'pair' }).expect(201);
  await request(srv.app).post('/api/rooms/join').set(bearer(bob.accessToken)).send({ inviteCode: body.room.inviteCode }).expect(200);
  return { alice, bob, carol, roomId: body.room.id };
}

describe('handshake authentication', () => {
  test('no token -> connect_error AUTH_MISSING', async () => {
    await expect(srv.connect()).rejects.toMatchObject({ data: { code: 'AUTH_MISSING' } });
  });

  test('garbage or forged token -> AUTH_INVALID', async () => {
    await expect(srv.connect('not.a.jwt')).rejects.toMatchObject({ data: { code: 'AUTH_INVALID' } });
    const forged = jwt.sign({}, 'another-secret-that-is-at-least-32-chars!!', { subject: 'x', expiresIn: 60 });
    await expect(srv.connect(forged)).rejects.toMatchObject({ data: { code: 'AUTH_INVALID' } });
  });

  test('expired token -> AUTH_EXPIRED', async () => {
    const expired = jwt.sign({ sub: '507f1f77bcf86cd799439011', exp: Math.floor(Date.now() / 1000) - 10 }, process.env.JWT_ACCESS_SECRET);
    await expect(srv.connect(expired)).rejects.toMatchObject({ data: { code: 'AUTH_EXPIRED' } });
  });

  test('valid token connects', async () => {
    const { alice } = await scenario();
    const socket = await srv.connect(alice.accessToken);
    expect(socket.connected).toBe(true);
    socket.close();
  });
});

describe('room:join', () => {
  test('a member joins and gets a snapshot with their role and who is online', async () => {
    const { alice, roomId } = await scenario();
    const socket = await srv.connect(alice.accessToken);
    const ack = await emitAck(socket, 'room:join', { roomId });
    expect(ack).toEqual({
      ok: true,
      data: { roomId, role: 'owner', presence: [{ userId: alice.user.id, name: 'Alice', role: 'owner', tabs: 1 }] },
    });
    socket.close();
  });

  test('a non-member is rejected (ROOM_NOT_FOUND) and receives nothing from the room', async () => {
    const { alice, carol, roomId } = await scenario();
    const a = await srv.connect(alice.accessToken);
    const c = await srv.connect(carol.accessToken);
    await emitAck(a, 'room:join', { roomId });

    const ack = await emitAck(c, 'room:join', { roomId });
    expect(ack).toEqual({ ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } });

    const silent = noEvent(c, 'chat:new');
    await emitAck(a, 'chat:send', { roomId, body: 'secret plans', clientMsgId: 'm1' });
    expect(await silent).toBe(true);
    // And Carol can't send into it either.
    const send = await emitAck(c, 'chat:send', { roomId, body: 'hi', clientMsgId: 'm2' });
    expect(send.error.code).toBe('NOT_IN_ROOM');
    a.close();
    c.close();
  });

  test('payloads are validated like HTTP bodies', async () => {
    const { alice } = await scenario();
    const socket = await srv.connect(alice.accessToken);
    expect((await emitAck(socket, 'room:join', { roomId: { $ne: null } })).error.code).toBe('VALIDATION_FAILED');
    expect((await emitAck(socket, 'room:join', 'nonsense')).error.code).toBe('VALIDATION_FAILED');
    socket.close();
  });
});

describe('chat', () => {
  test('a message is delivered to the other member AND persisted', async () => {
    const { alice, bob, roomId } = await scenario();
    const a = await srv.connect(alice.accessToken);
    const b = await srv.connect(bob.accessToken);
    await emitAck(a, 'room:join', { roomId });
    await emitAck(b, 'room:join', { roomId });

    const delivered = nextEvent(b, 'chat:new');
    const ack = await emitAck(a, 'chat:send', { roomId, body: '  two pointers?  ', clientMsgId: 'msg-1' });
    expect(ack.ok).toBe(true);
    expect(ack.data).toMatchObject({ duplicate: false, message: { body: 'two pointers?', senderName: 'Alice', senderId: alice.user.id } });

    const msg = await delivered;
    expect(msg).toEqual(ack.data.message);
    const stored = await Message.find({ roomId }).lean();
    expect(stored).toHaveLength(1);
    expect(String(stored[0].senderId)).toBe(alice.user.id); // identity from the token, not the payload
    a.close();
    b.close();
  });

  test('the sender id cannot be spoofed through the payload', async () => {
    const { alice, bob, roomId } = await scenario();
    const a = await srv.connect(alice.accessToken);
    await emitAck(a, 'room:join', { roomId });
    const ack = await emitAck(a, 'chat:send', { roomId, body: 'hi', clientMsgId: 'x1', senderId: bob.user.id, senderName: 'Bob' });
    expect(ack.data.message).toMatchObject({ senderId: alice.user.id, senderName: 'Alice' });
    a.close();
  });

  test('a retried clientMsgId is stored once and broadcast once', async () => {
    const { alice, bob, roomId } = await scenario();
    const a = await srv.connect(alice.accessToken);
    const b = await srv.connect(bob.accessToken);
    await emitAck(a, 'room:join', { roomId });
    await emitAck(b, 'room:join', { roomId });

    const received = [];
    b.on('chat:new', (m) => received.push(m));
    const first = await emitAck(a, 'chat:send', { roomId, body: 'hello', clientMsgId: 'retry-me' });
    const again = await emitAck(a, 'chat:send', { roomId, body: 'hello', clientMsgId: 'retry-me' });
    // Concurrent retries too.
    const racing = await Promise.all([1, 2, 3].map(() => emitAck(a, 'chat:send', { roomId, body: 'hello', clientMsgId: 'race' })));

    expect(first.data.duplicate).toBe(false);
    expect(again.data).toEqual({ duplicate: true, message: first.data.message });
    expect(racing.filter((r) => r.data.duplicate === false)).toHaveLength(1);
    expect(new Set(racing.map((r) => r.data.message.id)).size).toBe(1);
    expect(await Message.countDocuments({ roomId })).toBe(2);
    await new Promise((r) => setTimeout(r, 200));
    expect(received.map((m) => m.clientMsgId)).toEqual(['retry-me', 'race']);
    a.close();
    b.close();
  });

  test('bodies are trimmed and bounded (1-2000 chars)', async () => {
    const { alice, roomId } = await scenario();
    const a = await srv.connect(alice.accessToken);
    await emitAck(a, 'room:join', { roomId });
    expect((await emitAck(a, 'chat:send', { roomId, body: '   ', clientMsgId: 'e1' })).error.code).toBe('VALIDATION_FAILED');
    expect((await emitAck(a, 'chat:send', { roomId, body: 'x'.repeat(2001), clientMsgId: 'e2' })).error.code).toBe('VALIDATION_FAILED');
    expect((await emitAck(a, 'chat:send', { roomId, body: 'x'.repeat(2000), clientMsgId: 'e3' })).ok).toBe(true);
    a.close();
  });
});

describe('presence (multi-tab aware)', () => {
  test('a second tab does not re-announce; closing one of two tabs keeps you online; closing both marks you offline', async () => {
    const { alice, bob, roomId } = await scenario();
    const a = await srv.connect(alice.accessToken);
    await emitAck(a, 'room:join', { roomId });

    const bobOnline = nextEvent(a, 'presence:state', { filter: (p) => p.online.some((u) => u.name === 'Bob') });
    const b1 = await srv.connect(bob.accessToken);
    await emitAck(b1, 'room:join', { roomId });
    expect((await bobOnline).online.map((u) => u.name).sort()).toEqual(['Alice', 'Bob']);

    const quietOnSecondTab = noEvent(a, 'presence:state');
    const b2 = await srv.connect(bob.accessToken);
    const ack = await emitAck(b2, 'room:join', { roomId });
    expect(ack.data.presence.find((u) => u.name === 'Bob').tabs).toBe(2);
    expect(await quietOnSecondTab).toBe(true);

    const quietOnFirstClose = noEvent(a, 'presence:state');
    b1.close();
    expect(await quietOnFirstClose).toBe(true);
    expect(srv.roomManager.onlineUserIds(roomId)).toEqual(new Set([alice.user.id, bob.user.id]));

    const bobOffline = nextEvent(a, 'presence:state', { filter: (p) => !p.online.some((u) => u.name === 'Bob') });
    b2.close();
    expect((await bobOffline).online.map((u) => u.name)).toEqual(['Alice']);
    a.close();
  });

  test('the REST session reports online flags from the live room manager', async () => {
    const { alice, bob, roomId } = await scenario();
    const b = await srv.connect(bob.accessToken);
    await emitAck(b, 'room:join', { roomId });
    const res = await request(srv.app).get(`/api/rooms/${roomId}/session`).set(bearer(alice.accessToken)).expect(200);
    expect(res.body.room.members.map((m) => [m.name, m.online])).toEqual([['Alice', false], ['Bob', true]]);
    b.close();
  });

  test('the in-memory session is torn down when the last socket leaves', async () => {
    const { alice, roomId } = await scenario();
    const a = await srv.connect(alice.accessToken);
    await emitAck(a, 'room:join', { roomId });
    expect(srv.roomManager.sessions.has(roomId)).toBe(true);
    await emitAck(a, 'room:leave', { roomId });
    expect(srv.roomManager.sessions.has(roomId)).toBe(false);
    a.close();
  });
});

describe('membership changes over REST reach live sockets', () => {
  test('a kicked member is removed from the room immediately and can no longer chat', async () => {
    const { alice, bob, roomId } = await scenario();
    const b = await srv.connect(bob.accessToken);
    await emitAck(b, 'room:join', { roomId });

    const kicked = nextEvent(b, 'room:kicked');
    await request(srv.app).delete(`/api/rooms/${roomId}/members/${bob.user.id}`).set(bearer(alice.accessToken)).expect(204);
    expect(await kicked).toEqual({ roomId });
    expect((await emitAck(b, 'chat:send', { roomId, body: 'still here?', clientMsgId: 'k1' })).error.code).toBe('NOT_IN_ROOM');
    expect((await emitAck(b, 'room:join', { roomId })).error.code).toBe('ROOM_NOT_FOUND');
    b.close();
  });

  test('a role change is pushed to the member', async () => {
    const { alice, bob, roomId } = await scenario();
    const b = await srv.connect(bob.accessToken);
    await emitAck(b, 'room:join', { roomId });
    const roleEvent = nextEvent(b, 'room:role');
    await request(srv.app).patch(`/api/rooms/${roomId}/members/${bob.user.id}`).set(bearer(alice.accessToken)).send({ role: 'viewer' }).expect(200);
    expect(await roleEvent).toEqual({ roomId, role: 'viewer' });
    expect(() => srv.roomManager.requireMember({ data: { rooms: new Set([roomId]), userId: bob.user.id } }, roomId, 'editor')).toThrow(
      expect.objectContaining({ code: 'ROOM_FORBIDDEN' }),
    );
    b.close();
  });
});

describe('token lifetime on a long-lived socket', () => {
  test('the server disconnects the socket when its token expires', async () => {
    const { alice } = await scenario();
    const shortLived = jwt.sign({}, process.env.JWT_ACCESS_SECRET, { subject: alice.user.id, expiresIn: 1 });
    const socket = await srv.connect(shortLived);
    const err = nextEvent(socket, 'error', { timeout: 4000 });
    const gone = nextEvent(socket, 'disconnect', { timeout: 4000 });
    expect(await err).toMatchObject({ code: 'AUTH_EXPIRED' });
    expect(await gone).toBe('io server disconnect');
  });

  test('auth:renew with a fresh token for the same user extends the socket; another user\'s token is refused', async () => {
    const { alice, bob } = await scenario();
    const shortLived = jwt.sign({}, process.env.JWT_ACCESS_SECRET, { subject: alice.user.id, expiresIn: 1 });
    const socket = await srv.connect(shortLived);

    expect((await emitAck(socket, 'auth:renew', { token: bob.accessToken })).error.code).toBe('AUTH_INVALID');
    const renewed = await emitAck(socket, 'auth:renew', { token: alice.accessToken });
    expect(renewed.ok).toBe(true);
    expect(await noEvent(socket, 'disconnect', 1500)).toBe(true);
    socket.close();
  });
});
