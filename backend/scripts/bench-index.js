'use strict';

/**
 * B2: "last 50 messages in a room", with and without the { roomId: 1, _id: -1 } index.
 *
 * Seeds ROOMS x PER_ROOM messages into a throwaway MongoDB
 * (mongodb-memory-server). Messages from all rooms are INTERLEAVED, as they
 * would arrive in real life, so one room's messages are scattered across
 * the collection. Then, for one room, it runs the two hot queries:
 *   newest page: find({ roomId }).sort({ _id: -1 }).limit(50)
 *   older page:  find({ roomId, _id: { $lt: cursor } }).sort({ _id: -1 }).limit(50)
 * under three index setups:
 *   A. with { roomId: 1, _id: -1 }                       (what we ship)
 *   B. without it, only { roomId, senderId, clientMsgId } (an index that has roomId but can't sort by _id)
 *   C. no index starting with roomId at all  (MongoDB walks the _id index
 *      newest-first and filters by roomId, reading other rooms' messages)
 * and reports explain('executionStats') numbers plus wall-clock timings.
 *
 * Usage: npm run bench:index    Env: ROOMS (500), PER_ROOM (400), RUNS (50)
 */
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const { summarize, ms, header } = require('./bench/stats');

const ROOMS = Number(process.env.ROOMS ?? 500);
const PER_ROOM = Number(process.env.PER_ROOM ?? 400);
const RUNS = Number(process.env.RUNS ?? 50);

function stagesOf(plan, out = []) {
  if (!plan || typeof plan !== 'object') return out;
  if (plan.stage) out.push(plan.stage + (plan.indexName ? `(${plan.indexName})` : ''));
  for (const child of [plan.inputStage, plan.queryPlan, ...(plan.inputStages ?? [])]) stagesOf(child, out);
  return out;
}

async function main() {
  const mongod = await MongoMemoryServer.create();
  // autoIndex off: this script decides exactly which indexes exist in each setup.
  await mongoose.connect(mongod.getUri('zcoder_bench_index'), { autoIndex: false });
  mongoose.set('strictQuery', 'throw');
  const { Message } = require('../src/models/Message');
  const coll = Message.collection;

  // Seed, interleaved: round r writes message r of every room.
  const rooms = Array.from({ length: ROOMS }, () => new mongoose.Types.ObjectId());
  const senderId = new mongoose.Types.ObjectId();
  const t0 = Date.now();
  let batch = [];
  for (let r = 0; r < PER_ROOM; r += 1) {
    for (let i = 0; i < ROOMS; i += 1) {
      batch.push({ roomId: rooms[i], senderId, senderName: 'Seed', body: `message ${r} in room ${i}`, clientMsgId: `r${r}`, createdAt: new Date() });
      if (batch.length === 10_000) {
        await coll.insertMany(batch, { ordered: false });
        batch = [];
      }
    }
  }
  if (batch.length) await coll.insertMany(batch, { ordered: false });
  const total = await coll.countDocuments();
  const seedMs = Date.now() - t0;

  const target = rooms[Math.floor(ROOMS / 2)];
  // A cursor in the middle of the room's history, for the "older page" query.
  const mid = await coll.find({ roomId: target }).sort({ _id: -1 }).skip(Math.floor(PER_ROOM / 2)).limit(1).next();

  const queries = {
    newest: () => Message.find({ roomId: target }).sort({ _id: -1 }).limit(50),
    older: () => Message.find({ roomId: target, _id: { $lt: mid._id } }).sort({ _id: -1 }).limit(50),
  };

  async function measure(label) {
    const rows = [];
    for (const [name, q] of Object.entries(queries)) {
      const explained = await q().explain('executionStats');
      const ex = Array.isArray(explained) ? explained[0] : explained;
      const s = ex.executionStats;
      for (let i = 0; i < 5; i += 1) await q().lean(); // warm-up
      const times = [];
      for (let i = 0; i < RUNS; i += 1) {
        const start = process.hrtime.bigint();
        await q().lean();
        times.push(Number(process.hrtime.bigint() - start) / 1e6);
      }
      const t = summarize(times);
      rows.push({
        setup: label,
        query: name,
        plan: stagesOf(ex.queryPlanner.winningPlan).join(' <- '),
        nReturned: s.nReturned,
        keysExamined: s.totalKeysExamined,
        docsExamined: s.totalDocsExamined,
        explainMs: s.executionTimeMillis,
        p50: t.p50,
        p95: t.p95,
      });
    }
    return rows;
  }

  const results = [];
  // A. What we ship: both schema indexes.
  await coll.createIndex({ roomId: 1, _id: -1 }, { name: 'roomId_1__id_-1' });
  await coll.createIndex({ roomId: 1, senderId: 1, clientMsgId: 1 }, { name: 'roomId_1_senderId_1_clientMsgId_1', unique: true });
  results.push(...(await measure('A: with {roomId,_id}')));
  // B. Drop the history index; the idempotency index still starts with roomId.
  await coll.dropIndex('roomId_1__id_-1');
  results.push(...(await measure('B: without it (other roomId index only)')));
  // C. No roomId index at all.
  await coll.dropIndex('roomId_1_senderId_1_clientMsgId_1');
  results.push(...(await measure('C: no roomId index (walk _id, filter)')));

  console.log(header(`, mongodb ${(await mongoose.connection.db.admin().serverInfo()).version} (mongodb-memory-server)`));
  console.log(`data:    ${total} messages = ${ROOMS} rooms x ${PER_ROOM}, interleaved (seeded in ${seedMs} ms); ${RUNS} timed runs per query after 5 warm-ups`);
  console.log('');
  console.log('setup | query | winning plan | returned | keys examined | docs examined | explain ms | wall p50 ms | wall p95 ms');
  console.log('---|---|---|---|---|---|---|---|---');
  for (const r of results) {
    console.log(`${r.setup} | ${r.query} | ${r.plan} | ${r.nReturned} | ${r.keysExamined} | ${r.docsExamined} | ${r.explainMs} | ${ms(r.p50)} | ${ms(r.p95)}`);
  }

  await mongoose.disconnect();
  await mongod.stop();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
