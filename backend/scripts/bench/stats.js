'use strict';

/** Shared helpers for the benchmark scripts: percentiles and a machine header. */
const os = require('node:os');

/** Nearest-rank percentile of an ascending-sorted array. */
function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

/** { n, min, p50, p95, p99, max, mean } in ms, from an unsorted array. */
function summarize(values) {
  const s = [...values].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / (s.length || 1);
  return { n: s.length, min: s[0], p50: percentile(s, 50), p95: percentile(s, 95), p99: percentile(s, 99), max: s.at(-1), mean };
}

const ms = (n) => (Number.isFinite(n) ? n.toFixed(2) : String(n));

function header(extra = '') {
  const cpu = os.cpus()[0].model;
  return [
    `date:    ${new Date().toISOString()}`,
    `machine: ${cpu}, ${os.cpus().length} logical CPUs, ${(os.totalmem() / 2 ** 30).toFixed(1)} GiB RAM, ${os.platform()} ${os.release()}`,
    `runtime: node ${process.version}${extra}`,
  ].join('\n');
}

module.exports = { percentile, summarize, ms, header };
