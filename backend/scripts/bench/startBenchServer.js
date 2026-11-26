'use strict';

/** Spawn benchServer.js as a child process and wait for its READY line. */
const { spawn } = require('node:child_process');
const path = require('node:path');

/**
 * @param {Record<string, string>} [env]
 * @returns {Promise<{ info: { url: string, roomId: string, tokens: string[], messages: number }, stop: () => Promise<void> }>}
 */
function startBenchServer(env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'benchServer.js')], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const line = buffer.split('\n').find((l) => l.startsWith('READY '));
      if (!line) return;
      const info = JSON.parse(line.slice(6));
      resolve({
        info,
        stop: () =>
          new Promise((done) => {
            child.once('exit', () => done());
            child.stdin.end();
            setTimeout(() => child.kill(), 5000).unref();
          }),
      });
    });
    child.once('exit', (code) => reject(new Error(`bench server exited early (code ${code})`)));
  });
}

module.exports = { startBenchServer };
