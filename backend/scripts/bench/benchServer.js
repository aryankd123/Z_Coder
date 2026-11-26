'use strict';

/**
 * A complete ZCoder API (REST + Socket.IO) for latency benchmarks, run as
 * its OWN process so the load generator doesn't share its event loop.
 *
 * It starts a throwaway MongoDB (mongodb-memory-server), seeds:
 *   - 20 users (the room member cap), all members of one target room;
 *   - BG_ROOMS other rooms x PER_ROOM messages, interleaved, plus PER_ROOM
 *     messages in the target room (so the session query works on a realistic,
 *     non-trivial collection);
 * then listens on a random port and prints ONE line to stdout:
 *   READY {"url": ..., "roomId": ..., "tokens": [...]}
 * The tokens are throwaway JWTs signed with a random per-run secret for a
 * throwaway database. The parent reads them and never prints them.
 *
 * Env: BG_ROOMS (100), PER_ROOM (400)
 */
const crypto = require('node:crypto');
const http = require('node:http');
const { MongoMemoryServer } = require('mongodb-memory-server');

async function main() {
  const mongod = await MongoMemoryServer.create();
  Object.assign(process.env, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    MONGODB_URI: mongod.getUri('zcoder_bench'),
    JWT_ACCESS_SECRET: crypto.randomBytes(48).toString('base64url'), // per-run, never reused
    ACCESS_TOKEN_TTL_SECONDS: '3600',
    CHAT_MESSAGES_PER_10S: '1000000', // the benchmark measures latency, not the limiter
    CORS_ORIGINS: 'http://localhost:3000',
  });

  const mongoose = require('mongoose');
  const { connectDb } = require('../../src/db');
  const { syncAllIndexes, User, Room, Message } = require('../../src/models');
  const { createApp } = require('../../src/app');
  const { RoomManager } = require('../../src/realtime/roomManager');
  const { attachGateway } = require('../../src/realtime/gateway');
  const { signAccessToken } = require('../../src/services/tokenService');

  await connectDb(process.env.MONGODB_URI);
  await syncAllIndexes();

  const BG_ROOMS = Number(process.env.BG_ROOMS ?? 100);
  const PER_ROOM = Number(process.env.PER_ROOM ?? 400);

  const users = await User.insertMany(
    Array.from({ length: 20 }, (_, i) => ({ name: `User ${i}`, email: `user${i}@bench.test`, passwordHash: 'not-a-real-hash' })),
  );
  const room = await Room.create({
    name: 'bench room',
    inviteCode: 'BENCH234',
    ownerId: users[0]._id,
    members: users.map((u, i) => ({ userId: u._id, name: u.name, role: i === 0 ? 'owner' : 'editor' })),
  });

  const roomIds = [room._id, ...Array.from({ length: BG_ROOMS }, () => new mongoose.Types.ObjectId())];
  let batch = [];
  for (let r = 0; r < PER_ROOM; r += 1) {
    for (const roomId of roomIds) {
      batch.push({ roomId, senderId: users[r % 20]._id, senderName: `User ${r % 20}`, body: `seed message ${r}`, clientMsgId: `seed-${r}`, createdAt: new Date() });
      if (batch.length === 10_000) {
        await Message.collection.insertMany(batch, { ordered: false });
        batch = [];
      }
    }
  }
  if (batch.length) await Message.collection.insertMany(batch, { ordered: false });

  const roomManager = new RoomManager();
  const server = http.createServer(createApp({ realtime: roomManager }));
  attachGateway(server, { roomManager });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const info = {
    url: `http://127.0.0.1:${server.address().port}`,
    roomId: String(room._id),
    tokens: users.map((u) => signAccessToken(u._id)),
    messages: await Message.estimatedDocumentCount(),
  };
  process.stdout.write(`READY ${JSON.stringify(info)}\n`);

  const stop = async () => {
    server.close();
    await mongoose.disconnect();
    await mongod.stop();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.stdin.on('end', stop); // parent went away
  process.stdin.resume();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
