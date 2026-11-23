'use strict';

/**
 * Measures how long one bcrypt hash takes at several cost factors.
 *
 * Why it matters: the cost factor is a dial between security and latency.
 * Each +1 doubles the work, for us on every login AND for an attacker on
 * every guess.
 *
 * Usage:  npm run bench:bcrypt          (RUNS=20 npm run bench:bcrypt for more samples)
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bcrypt = require('bcryptjs');

const COSTS = [10, 11, 12, 13];
const RUNS = Number(process.env.RUNS ?? 10);

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

async function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'bcryptjs', 'package.json'), 'utf8'));
  console.log(`date:    ${new Date().toISOString()}`);
  console.log(`machine: ${os.cpus()[0].model}, ${os.cpus().length} logical CPUs, ${(os.totalmem() / 2 ** 30).toFixed(1)} GiB RAM, ${os.platform()} ${os.release()}`);
  console.log(`runtime: node ${process.version}, bcryptjs ${pkg.version}, ${RUNS} hashes per cost (after 1 warm-up)`);
  console.log('');
  console.log('cost | median ms | p90 ms | min ms | max ms');
  for (const cost of COSTS) {
    await bcrypt.hash('warm-up', cost);
    const times = [];
    for (let i = 0; i < RUNS; i += 1) {
      const start = process.hrtime.bigint();
      await bcrypt.hash('correct horse battery staple', cost);
      times.push(Number(process.hrtime.bigint() - start) / 1e6);
    }
    times.sort((a, b) => a - b);
    const fmt = (n) => n.toFixed(1).padStart(8);
    console.log(`${String(cost).padStart(4)} | ${fmt(percentile(times, 50))}  | ${fmt(percentile(times, 90))} | ${fmt(times[0])} | ${fmt(times.at(-1))}`);
  }
}

main();
