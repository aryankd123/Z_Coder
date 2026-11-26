'use strict';

/**
 * How big does a room's Yjs document get, on disk (roomDocs.state) and in
 * memory? Simulates people typing a source file one keystroke at a time
 * (one Yjs transaction per character, like the editor), with some
 * backspacing, then reports:
 *   - final text length
 *   - Y.encodeStateAsUpdate size (what we save to MongoDB)
 *   - heap used per live Y.Doc (needs --expose-gc for a stable number)
 *
 * Usage: node --expose-gc scripts/bench-yjs-doc.js   (npm run bench:yjs)
 * Env: TARGET_CHARS (default 20000), DOCS (default 20), EDITORS (default 2)
 */
const os = require('node:os');
const Y = require('yjs');

const TARGET_CHARS = Number(process.env.TARGET_CHARS ?? 20000);
const DOCS = Number(process.env.DOCS ?? 20);
const EDITORS = Number(process.env.EDITORS ?? 2);

/** Deterministic PRNG so runs are comparable. */
function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LINE = 'for (int i = 0; i < n; ++i) { sum += a[i] * b[i]; }\n';

/** One room: EDITORS clients typing into synced docs; returns the server-side doc. */
function simulateRoom(seed) {
  const rand = mulberry32(seed);
  const server = new Y.Doc();
  const clients = Array.from({ length: EDITORS }, () => new Y.Doc());
  for (const c of clients) {
    c.on('update', (u, origin) => {
      if (origin === 'net') return;
      Y.applyUpdate(server, u, 'net');
      for (const other of clients) if (other !== c) Y.applyUpdate(other, u, 'net');
    });
  }
  let keystrokes = 0;
  let typed = 0;
  while (clients[0].getText('code').length < TARGET_CHARS) {
    const c = clients[Math.floor(rand() * clients.length)];
    const text = c.getText('code');
    if (rand() < 0.1 && text.length > 0) {
      text.delete(Math.max(0, text.length - 1), 1); // backspace
    } else {
      // Type at the end most of the time, sometimes in the middle.
      const at = rand() < 0.8 ? text.length : Math.floor(rand() * (text.length + 1));
      text.insert(at, LINE[typed % LINE.length]);
      typed += 1;
    }
    keystrokes += 1;
  }
  for (const c of clients) c.destroy();
  return { server, keystrokes };
}

function heapUsed() {
  global.gc?.();
  return process.memoryUsage().heapUsed;
}

const sample = simulateRoom(1);
const state = Y.encodeStateAsUpdate(sample.server);
const textLen = sample.server.getText('code').length;

// Heap per doc: load DOCS copies of the saved state into live docs.
const before = heapUsed();
const live = [];
for (let i = 0; i < DOCS; i += 1) {
  const d = new Y.Doc();
  Y.applyUpdate(d, state);
  live.push(d);
}
const after = heapUsed();

console.log(`date:    ${new Date().toISOString()}`);
console.log(`machine: ${os.cpus()[0].model}, ${os.cpus().length} logical CPUs, ${(os.totalmem() / 2 ** 30).toFixed(1)} GiB RAM, ${os.platform()} ${os.release()}`);
console.log(`runtime: node ${process.version}, yjs ${require('yjs/package.json').version}, gc exposed: ${Boolean(global.gc)}`);
console.log(`setup:   ${EDITORS} editors, ${sample.keystrokes} keystrokes (1 transaction each, ~10% backspaces), target ${TARGET_CHARS} chars`);
console.log('');
console.log(`final text length:          ${textLen} chars`);
console.log(`saved state (roomDocs):     ${state.length} bytes (${(state.length / textLen).toFixed(2)} bytes per char)`);
console.log(`heap per live doc (n=${DOCS}):   ${((after - before) / DOCS / 1024).toFixed(1)} KiB`);
console.log(`share of the 16 MB limit:   ${((state.length / (16 * 1024 * 1024)) * 100).toFixed(2)}% of MongoDB's 16 MB document cap`);
for (const d of live) d.destroy();
