'use strict';

/**
 * B3: latency of GET /api/rooms/:roomId/session, the "active session data
 * retrieval" endpoint (room + members + last 50 messages, 2 indexed queries).
 *
 * The API runs in a separate process (scripts/bench/benchServer.js) over a
 * seeded MongoDB. This process is a closed-loop load generator: C workers,
 * each sending one request, waiting for the full response, then sending the
 * next, for DURATION seconds after a WARMUP. Every request's latency is
 * recorded, so p50/p95/p99 are exact (no histogram buckets).
 *
 * Why not autocannon: it reports p90 and p97.5 but not p95, and a 40-line
 * loop avoids one more dependency.
 *
 * Usage: npm run bench:session   Env: CONCURRENCY ("1,10"), DURATION (10), WARMUP (2)
 */
const http = require('node:http');
const { startBenchServer } = require('./bench/startBenchServer');
const { summarize, ms, header } = require('./bench/stats');

const LEVELS = (process.env.CONCURRENCY ?? '1,10').split(',').map(Number);
const DURATION = Number(process.env.DURATION ?? 10) * 1000;
const WARMUP = Number(process.env.WARMUP ?? 2) * 1000;

function get(agent, url, token) {
  return new Promise((resolve, reject) => {
    const start = process.hrtime.bigint();
    const req = http.get(url, { agent, headers: { authorization: `Bearer ${token}` } }, (res) => {
      let bytes = 0;
      res.on('data', (c) => (bytes += c.length));
      res.on('end', () => resolve({ status: res.statusCode, bytes, ms: Number(process.hrtime.bigint() - start) / 1e6 }));
    });
    req.on('error', reject);
  });
}

async function load(info, concurrency) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency });
  const url = `${info.url}/api/rooms/${info.roomId}/session`;
  const latencies = [];
  let errors = 0;
  let bytes = 0;
  const warmEnd = Date.now() + WARMUP;
  const end = warmEnd + DURATION;
  await Promise.all(
    Array.from({ length: concurrency }, async (_, w) => {
      const token = info.tokens[w % info.tokens.length];
      while (Date.now() < end) {
        const r = await get(agent, url, token);
        if (Date.now() <= warmEnd) continue;
        if (r.status !== 200) errors += 1;
        latencies.push(r.ms);
        bytes = r.bytes;
      }
    }),
  );
  agent.destroy();
  return { concurrency, ...summarize(latencies), rps: latencies.length / (DURATION / 1000), errors, bytes };
}

async function main() {
  const { info, stop } = await startBenchServer();
  try {
    const rows = [];
    for (const c of LEVELS) rows.push(await load(info, c));
    console.log(header());
    console.log(`server:  separate process on 127.0.0.1, MongoDB via mongodb-memory-server, ${info.messages} messages seeded, room with 20 members`);
    console.log(`load:    closed loop, keep-alive, ${WARMUP / 1000} s warm-up then ${DURATION / 1000} s measured per level`);
    console.log('');
    console.log('concurrency | requests | req/s | p50 ms | p95 ms | p99 ms | max ms | non-200 | response bytes');
    console.log('---|---|---|---|---|---|---|---|---');
    for (const r of rows) {
      console.log(`${r.concurrency} | ${r.n} | ${r.rps.toFixed(0)} | ${ms(r.p50)} | ${ms(r.p95)} | ${ms(r.p99)} | ${ms(r.max)} | ${r.errors} | ${r.bytes}`);
    }
  } finally {
    await stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
