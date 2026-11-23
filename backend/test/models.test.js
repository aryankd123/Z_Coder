'use strict';

/**
 * Guards the schema design: every declared index must actually exist, and
 * the hot chat-history query must use its index with no in-memory sort.
 */
const mongoose = require('mongoose');
const { Message, Room, User } = require('../src/models');
const { setupTestDb, teardownTestDb } = require('./helpers/db');

beforeAll(setupTestDb);
afterAll(teardownTestDb);

const sameKey = (a, b) => JSON.stringify(a) === JSON.stringify(b);

describe('declared indexes exist in MongoDB', () => {
  test.each([
    ['users', { email: 1 }, { unique: true }],
    ['refreshTokens', { tokenHash: 1 }, { unique: true }],
    ['refreshTokens', { familyId: 1 }, {}],
    ['refreshTokens', { expiresAt: 1 }, { expireAfterSeconds: 0 }],
    ['rooms', { inviteCode: 1 }, { unique: true }],
    ['rooms', { 'members.userId': 1, lastActiveAt: -1 }, {}],
    ['roomDocs', { roomId: 1 }, { unique: true }],
    ['messages', { roomId: 1, _id: -1 }, {}],
    ['messages', { roomId: 1, senderId: 1, clientMsgId: 1 }, { unique: true }],
    ['submissions', { roomId: 1, _id: -1 }, {}],
    ['submissions', { userId: 1, _id: -1 }, {}],
    ['problems', { isPublic: 1, _id: -1 }, {}],
    ['problems', { authorId: 1, _id: -1 }, {}],
    ['answers', { problemId: 1, _id: -1 }, {}],
  ])('%s has index %j', async (collection, key, options) => {
    const indexes = await mongoose.connection.db.collection(collection).indexes();
    const found = indexes.find((i) => sameKey(i.key, key));
    expect(found).toBeDefined();
    for (const [name, value] of Object.entries(options)) expect(found[name]).toBe(value);
  });
});

/** Walk an explain() plan tree and collect every stage. Handles classic and SBE plan shapes. */
function stagesOf(plan, out = []) {
  if (!plan || typeof plan !== 'object') return out;
  if (plan.stage) out.push(plan);
  for (const child of [plan.inputStage, plan.queryPlan, ...(plan.inputStages ?? [])]) stagesOf(child, out);
  return out;
}

describe('query plans', () => {
  test('"last 50 messages in a room" is an index scan on { roomId, _id } with no SORT stage', async () => {
    const roomId = new mongoose.Types.ObjectId();
    const senderId = new mongoose.Types.ObjectId();
    await Message.insertMany(
      Array.from({ length: 120 }, (_, i) => ({ roomId, senderId, senderName: 'A', body: `m${i}`, clientMsgId: `c${i}` })),
    );

    const explained = await Message.find({ roomId }).sort({ _id: -1 }).limit(50).explain('executionStats');
    const ex = Array.isArray(explained) ? explained[0] : explained;
    const stages = stagesOf(ex.queryPlanner.winningPlan);

    expect(stages.some((s) => s.stage === 'IXSCAN' && s.indexName === 'roomId_1__id_-1')).toBe(true);
    expect(stages.some((s) => s.stage === 'SORT')).toBe(false);
    expect(ex.executionStats.nReturned).toBe(50);
    expect(ex.executionStats.totalDocsExamined).toBe(50); // reads exactly what it returns
  });

  test('passwordHash is never selected unless explicitly requested', async () => {
    await User.create({ name: 'Z', email: 'z@example.com', passwordHash: 'secret-hash' });
    expect((await User.findOne({ email: 'z@example.com' }).lean()).passwordHash).toBeUndefined();
    expect((await User.findOne({ email: 'z@example.com' })).toJSON().passwordHash).toBeUndefined();
  });

  test('room member cap is enforced on create', async () => {
    const ownerId = new mongoose.Types.ObjectId();
    const members = Array.from({ length: 21 }, (_, i) => ({ userId: new mongoose.Types.ObjectId(), name: `u${i}`, role: 'editor' }));
    await expect(Room.create({ name: 'big', inviteCode: 'CAP00001', ownerId, members })).rejects.toThrow(/at most 20 members/);
  });
});
