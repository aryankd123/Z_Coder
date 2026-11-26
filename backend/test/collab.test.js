'use strict';

/**
 * Synchronous editing with Yjs, headless: real server, real sockets, real
 * MongoDB, and Y.Doc clients instead of browsers.
 */
const request = require('supertest');
const Y = require('yjs');
const { Room, RoomDoc } = require('../src/models');
const { RoomManager, MAX_DOC_CHARS } = require('../src/realtime/roomManager');
const { LANGUAGES } = require('../src/execution/languages');
const { setupTestDb, resetTestDb, teardownTestDb } = require('./helpers/db');
const { signup } = require('./helpers/auth');
const { startServer, emitAck } = require('./helpers/realtime');
const { YClient, waitFor } = require('./helpers/yjsClient');

const PERSIST_MS = 60; // short debounce so tests don't wait 2 s

let srv;
const clients = [];
beforeAll(async () => {
  await setupTestDb();
  srv = await startServer({ roomManager: new RoomManager({ persistDebounceMs: PERSIST_MS }) });
});
beforeEach(resetTestDb);
afterEach(async () => {
  for (const c of clients.splice(0)) {
    c.socket.close();
    c.destroy();
  }
  // Let teardown saves from this test finish before the next test's reset.
  await new Promise((r) => setTimeout(r, PERSIST_MS * 2));
});
afterAll(async () => {
  await srv.close();
  await teardownTestDb();
});

const bearer = (token) => ({ Authorization: `Bearer ${token}` });

async function scenario({ language = 'javascript' } = {}) {
  const alice = await signup(srv.app, { name: 'Alice', email: 'alice@example.com' });
  const bob = await signup(srv.app, { name: 'Bob', email: 'bob@example.com' });
  const { body } = await request(srv.app).post('/api/rooms').set(bearer(alice.accessToken)).send({ name: 'pair', language }).expect(201);
  await request(srv.app).post('/api/rooms/join').set(bearer(bob.accessToken)).send({ inviteCode: body.room.inviteCode }).expect(200);
  return { alice, bob, roomId: body.room.id };
}

/** A connected YClient on `server` (default: the shared one). */
async function client(token, roomId, server = srv) {
  const c = new YClient(await server.connect(token), roomId);
  clients.push(c);
  return c;
}

/** Decode what's saved in roomDocs for a room. */
async function savedText(roomId) {
  const saved = await RoomDoc.findOne({ roomId }).lean();
  if (!saved) return null;
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(saved.state.buffer));
  const text = doc.getText('code').toString();
  doc.destroy();
  return text;
}

describe('a new room', () => {
  test('is seeded with starter code exactly once, even when two people open it at the same moment', async () => {
    const { alice, bob, roomId } = await scenario({ language: 'python' });
    const a = await client(alice.accessToken, roomId);
    const b = await client(bob.accessToken, roomId);
    await Promise.all([a.joinAndSync(), b.joinAndSync()]);

    expect(a.text.toString()).toBe(LANGUAGES.python.starter);
    expect(b.text.toString()).toBe(LANGUAGES.python.starter);
    expect(a.meta.get('language')).toBe('python');
  });
});

describe('concurrent editing', () => {
  test('two clients insert at the SAME position at the same time and converge to the same text', async () => {
    const { alice, bob, roomId } = await scenario();
    const a = await client(alice.accessToken, roomId);
    const b = await client(bob.accessToken, roomId);
    await a.joinAndSync();
    await b.joinAndSync();
    const base = a.text.toString();

    // Both edits happen locally before either has seen the other's: truly concurrent.
    a.text.insert(0, 'AAA');
    b.text.insert(0, 'BBB');

    await waitFor(() => a.text.toString() === b.text.toString() && a.text.length === base.length + 6, { message: 'convergence' });
    const merged = a.text.toString();
    expect(merged.endsWith(base)).toBe(true);
    expect(['AAABBB', 'BBBAAA']).toContain(merged.slice(0, 6)); // order is decided deterministically, never interleaved
    expect(srv.roomManager.currentCode(roomId)).toBe(merged); // the server's copy agrees
  });

  test('a delete and an insert inside the deleted range converge (the insert survives)', async () => {
    const { alice, bob, roomId } = await scenario();
    const a = await client(alice.accessToken, roomId);
    const b = await client(bob.accessToken, roomId);
    await a.joinAndSync();
    await b.joinAndSync();
    a.text.delete(0, a.text.length);
    a.text.insert(0, 'hello world');
    await waitFor(() => b.text.toString() === 'hello world', { message: 'b sees hello world' });

    a.text.delete(0, 11); // Alice deletes everything...
    b.text.insert(5, ' brave'); // ...while Bob inserts in the middle of it.

    await waitFor(() => a.text.toString() === b.text.toString() && a.text.toString() === ' brave', { message: 'convergence' });
  });
});

describe('late joiners and reconnects', () => {
  test('a late joiner receives the full current state', async () => {
    const { alice, bob, roomId } = await scenario();
    const a = await client(alice.accessToken, roomId);
    await a.joinAndSync();
    a.text.insert(0, '// edited before Bob arrived\n');

    const b = await client(bob.accessToken, roomId);
    await waitFor(() => srv.roomManager.currentCode(roomId)?.startsWith('// edited'), { message: 'server has the edit' });
    await b.joinAndSync();
    expect(b.text.toString()).toBe(a.text.toString());
  });

  test('edits made while offline merge in on reconnect (the second half of the exchange)', async () => {
    const { alice, bob, roomId } = await scenario();
    const a = await client(alice.accessToken, roomId);
    const b = await client(bob.accessToken, roomId);
    await a.joinAndSync();
    await b.joinAndSync();

    a.socket.disconnect();
    await waitFor(() => !a.socket.connected);
    a.text.insert(0, '/* offline */');
    b.text.insert(b.text.length, '// online');
    await waitFor(() => srv.roomManager.currentCode(roomId)?.endsWith('// online'), { message: 'server has bob edit' });

    a.socket.connect();
    await waitFor(() => a.socket.connected);
    await a.joinAndSync();

    await waitFor(() => a.text.toString() === b.text.toString(), { message: 'convergence after reconnect' });
    expect(a.text.toString().startsWith('/* offline */')).toBe(true);
    expect(a.text.toString().endsWith('// online')).toBe(true);
  });
});

describe('persistence', () => {
  test('edits are saved to roomDocs after the debounce', async () => {
    const { alice, roomId } = await scenario();
    const a = await client(alice.accessToken, roomId);
    await a.joinAndSync();
    a.text.insert(0, 'saved?');
    await waitFor(async () => (await savedText(roomId))?.startsWith('saved?'), { message: 'debounced save' });
  });

  test('after a server restart the document is restored from roomDocs', async () => {
    const { alice, bob, roomId } = await scenario();
    const first = await startServer({ roomManager: new RoomManager({ persistDebounceMs: 10_000 }) }); // debounce won't fire
    const a = await client(alice.accessToken, roomId, first);
    await a.joinAndSync();
    a.text.delete(0, a.text.length);
    a.text.insert(0, 'survives a restart');
    await waitFor(() => first.roomManager.currentCode(roomId) === 'survives a restart', { message: 'server has the edit' });

    await first.close(); // graceful shutdown saves every active room
    expect(await savedText(roomId)).toBe('survives a restart');

    const second = await startServer({ roomManager: new RoomManager({ persistDebounceMs: PERSIST_MS }) });
    try {
      const b = await client(bob.accessToken, roomId, second);
      await b.joinAndSync();
      expect(b.text.toString()).toBe('survives a restart');
    } finally {
      for (const c of clients.splice(0)) {
        c.socket.close();
        c.destroy();
      }
      await second.close();
    }
  });

  test('the last person leaving saves the document; the next join loads it', async () => {
    const { alice, bob, roomId } = await scenario();
    const slow = new RoomManager({ persistDebounceMs: 10_000 });
    const server = await startServer({ roomManager: slow });
    try {
      const a = await client(alice.accessToken, roomId, server);
      await a.joinAndSync();
      a.text.insert(0, 'X');
      await waitFor(() => slow.currentCode(roomId)?.startsWith('X'));
      a.socket.close(); // last one out: teardown saves
      await waitFor(() => !slow.sessions.has(roomId));

      const b = await client(bob.accessToken, roomId, server); // joins while the save may still be running
      await b.joinAndSync();
      expect(b.text.toString().startsWith('X')).toBe(true);
    } finally {
      await server.close();
    }
  });
});

describe('roles', () => {
  test("a viewer's update is rejected and never reaches the doc or other clients", async () => {
    const { alice, bob, roomId } = await scenario();
    await request(srv.app).patch(`/api/rooms/${roomId}/members/${bob.user.id}`).set(bearer(alice.accessToken)).send({ role: 'viewer' }).expect(200);
    const a = await client(alice.accessToken, roomId);
    const b = await client(bob.accessToken, roomId);
    await a.joinAndSync();
    await b.joinAndSync(); // viewers may read
    const before = a.text.toString();

    b.text.insert(0, 'VIEWER WAS HERE');
    await waitFor(() => b.acks.length === 1, { message: 'ack for the viewer update' });
    expect(b.acks[0]).toMatchObject({ ok: false, error: { code: 'ROOM_FORBIDDEN' } });
    await new Promise((r) => setTimeout(r, 150));
    expect(srv.roomManager.currentCode(roomId)).toBe(before);
    expect(a.text.toString()).toBe(before);
  });

  test('a non-member cannot sync or send updates', async () => {
    const { roomId } = await scenario();
    const carol = await signup(srv.app, { name: 'Carol', email: 'carol@example.com' });
    const c = await client(carol.accessToken, roomId);
    const ack = await emitAck(c.socket, 'yjs:sync', { roomId, stateVector: Y.encodeStateVector(c.doc) });
    expect(ack.error.code).toBe('NOT_IN_ROOM');
  });

  test('malformed binary is rejected without breaking the room', async () => {
    const { alice, roomId } = await scenario();
    const a = await client(alice.accessToken, roomId);
    await a.joinAndSync();
    const bad = await emitAck(a.socket, 'yjs:update', { roomId, update: Buffer.from([255, 255, 255, 1, 2, 3]) });
    expect(bad.ok).toBe(false);
    const notBinary = await emitAck(a.socket, 'yjs:update', { roomId, update: 'text' });
    expect(notBinary.error.code).toBe('VALIDATION_FAILED');
    a.text.insert(0, 'still works');
    await waitFor(() => srv.roomManager.currentCode(roomId)?.startsWith('still works'));
  });
});

describe('awareness (cursors)', () => {
  test('cursor state is relayed to others and cleared when its socket leaves', async () => {
    const { alice, bob, roomId } = await scenario();
    const a = await client(alice.accessToken, roomId);
    const b = await client(bob.accessToken, roomId);
    await a.joinAndSync();
    await b.joinAndSync();

    a.awareness.setLocalStateField('user', { name: 'Alice', color: '#10b981' });
    await waitFor(() => b.awareness.getStates().get(a.doc.clientID)?.user?.name === 'Alice', { message: 'b sees alice cursor' });

    a.socket.close();
    await waitFor(() => !b.awareness.getStates().has(a.doc.clientID), { message: 'alice cursor removed' });
  });
});

describe('language (Y.Map meta)', () => {
  test('a valid language change is mirrored into rooms.language; an invalid one is reverted', async () => {
    const { alice, bob, roomId } = await scenario();
    const a = await client(alice.accessToken, roomId);
    const b = await client(bob.accessToken, roomId);
    await a.joinAndSync();
    await b.joinAndSync();

    a.meta.set('language', 'cpp');
    await waitFor(() => b.meta.get('language') === 'cpp', { message: 'b sees cpp' });
    await waitFor(async () => (await Room.findById(roomId).lean()).language === 'cpp', { message: 'rooms.language saved' });

    a.meta.set('language', 'cobol');
    await waitFor(() => a.meta.get('language') === 'cpp' && b.meta.get('language') === 'cpp', { message: 'revert to cpp' });
  });
});

describe('size cap', () => {
  test('the server trims a document that grows past the cap, and every client converges on the trimmed text', async () => {
    const { alice, bob, roomId } = await scenario();
    const a = await client(alice.accessToken, roomId);
    const b = await client(bob.accessToken, roomId);
    await a.joinAndSync();
    await b.joinAndSync();
    a.text.insert(a.text.length, 'x'.repeat(MAX_DOC_CHARS));
    await waitFor(() => a.text.length === MAX_DOC_CHARS && b.text.length === MAX_DOC_CHARS, { message: 'trimmed', timeout: 5000 });
    expect(srv.roomManager.currentCode(roomId)).toHaveLength(MAX_DOC_CHARS);
  });
});
