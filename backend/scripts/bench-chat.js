'use strict';

/**
 * B4: chat broadcast latency with K sockets in one room.
 *
 * The API runs in a separate process (scripts/bench/benchServer.js). Here,
 * K socket.io-client connections join the same room (20 room members, so
 * for K > 20 some users have several "tabs"). Socket 0 sends M messages one
 * at a time; for each, we record:
 *   - ack latency:      send -> the sender's ack (validate, rate limit, INSERT into MongoDB)
 *   - delivery latency: send -> chat:new arrives on each of the other K-1 sockets
 * Sender and receivers are in THIS process, so both timestamps come from the
 * same clock. It measures the server plus Socket.IO over loopback, not
 * internet round trips.
 *
 * Usage: npm run bench:chat   Env: SOCKETS ("5,20,50"), MESSAGES (200), GAP_MS (5)
 */
const { io } = require('socket.io-client');
const { startBenchServer } = require('./bench/startBenchServer');
const { summarize, ms, header } = require('./bench/stats');

const LEVELS = (process.env.SOCKETS ?? '5,20,50').split(',').map(Number);
const MESSAGES = Number(process.env.MESSAGES ?? 200);
const GAP_MS = Number(process.env.GAP_MS ?? 5);
const now = () => Number(process.hrtime.bigint()) / 1e6;

function connect(url, token) {
  return new Promise((resolve, reject) => {
    const s = io(url, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
    s.once('connect', () => resolve(s));
    s.once('connect_error', reject);
  });
}

async function run(info, k) {
  const sockets = await Promise.all(Array.from({ length: k }, (_, i) => connect(info.url, info.tokens[i % info.tokens.length])));
  for (const s of sockets) {
    const ack = await s.timeout(5000).emitWithAck('room:join', { roomId: info.roomId });
    if (!ack.ok) throw new Error(`join failed: ${ack.error.code}`);
  }
  const sentAt = new Map();
  const delivery = [];
  let pending = null;
  let expected = 0;
  for (const s of sockets.slice(1)) {
    s.on('chat:new', (m) => {
      const t = sentAt.get(m.clientMsgId);
      if (t === undefined) return;
      delivery.push(now() - t);
      expected -= 1;
      if (expected === 0) pending?.();
    });
  }
  const acks = [];
  const sender = sockets[0];
  for (let i = 0; i < MESSAGES; i += 1) {
    const clientMsgId = `k${k}-m${i}`;
    expected = k - 1;
    const allDelivered = new Promise((r) => (pending = r));
    const t0 = now();
    sentAt.set(clientMsgId, t0);
    const ack = await sender.timeout(5000).emitWithAck('chat:send', { roomId: info.roomId, body: `bench ${i}`, clientMsgId });
    acks.push(now() - t0);
    if (!ack.ok) throw new Error(`send failed: ${ack.error.code}`);
    if (k > 1) await Promise.race([allDelivered, new Promise((r) => setTimeout(r, 5000))]);
    await new Promise((r) => setTimeout(r, GAP_MS));
  }
  for (const s of sockets) s.close();
  return { k, ack: summarize(acks), delivery: summarize(delivery), deliveries: delivery.length, expectedDeliveries: (k - 1) * MESSAGES };
}

async function main() {
  const { info, stop } = await startBenchServer();
  try {
    const rows = [];
    for (const k of LEVELS) rows.push(await run(info, k));
    console.log(header(`, socket.io-client ${require('socket.io-client/package.json').version}`));
    console.log(`server:  separate process on 127.0.0.1, MongoDB via mongodb-memory-server, ${info.messages} messages seeded`);
    console.log(`load:    1 sender, ${MESSAGES} messages each awaited (ack + all deliveries) then ${GAP_MS} ms gap; WebSocket transport`);
    console.log('');
    console.log('sockets in room | deliveries (got/expected) | ack p50 ms | ack p95 ms | delivery p50 ms | delivery p95 ms | delivery p99 ms | delivery max ms');
    console.log('---|---|---|---|---|---|---|---');
    for (const r of rows) {
      console.log(
        `${r.k} | ${r.deliveries}/${r.expectedDeliveries} | ${ms(r.ack.p50)} | ${ms(r.ack.p95)} | ${ms(r.delivery.p50)} | ${ms(r.delivery.p95)} | ${ms(r.delivery.p99)} | ${ms(r.delivery.max)}`,
      );
    }
  } finally {
    await stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
