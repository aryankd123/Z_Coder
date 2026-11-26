'use strict';

/**
 * Run one process with stdin, a wall-clock timeout and capped output.
 * Used by the local executor (and would be by a Docker executor: `docker run`
 * is just another process).
 *
 * - The timeout is enforced from OUTSIDE (our timer + SIGKILL); we never rely
 *   on the program to stop itself.
 * - Output is capped per stream (bytes beyond the cap are dropped), so
 *   `while(1) print("x")` can't eat the server's memory; the timeout ends it.
 * - The child gets a minimal environment: never our process.env, which holds
 *   the JWT secret and the database URI.
 */
const { spawn } = require('node:child_process');

/**
 * An ALLOWLIST of variables a compiler or interpreter needs to start.
 * Anything not listed (JWT_ACCESS_SECRET, MONGODB_URI, JUDGE0 keys...) is
 * simply not passed to user code.
 *
 * The Windows entries are system and profile paths, not secrets. Python's
 * Windows launcher needs LOCALAPPDATA and the profile variables to find the
 * installed interpreter; without them it tries to download a new one.
 */
const WINDOWS_VARS = [
  'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT',
  'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PROGRAMDATA', 'HOMEDRIVE', 'HOMEPATH',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
];
const POSIX_VARS = ['HOME', 'TMPDIR'];

function minimalEnv() {
  const env = { PATH: process.env.PATH ?? '', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1', LANG: 'C.UTF-8' };
  for (const key of process.platform === 'win32' ? WINDOWS_VARS : POSIX_VARS) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

/** Collects chunks up to `limit` bytes; remembers whether anything was dropped. */
function cappedBuffer(limit) {
  const chunks = [];
  let size = 0;
  let truncated = false;
  return {
    push(chunk) {
      if (size >= limit) {
        truncated = true;
        return;
      }
      const room = limit - size;
      if (chunk.length > room) truncated = true;
      const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
      chunks.push(piece);
      size += piece.length;
    },
    text: () => Buffer.concat(chunks).toString('utf8'),
    get truncated() {
      return truncated;
    },
  };
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd: string, stdin?: string, timeoutMs: number, outputBytes: number }} options
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number | null, signal: string | null,
 *   timedOut: boolean, timeMs: number, outputTruncated: boolean, spawnError?: NodeJS.ErrnoException }>}
 */
function runProcess(cmd, args, { cwd, stdin = '', timeoutMs, outputBytes }) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const out = cappedBuffer(outputBytes);
    const err = cappedBuffer(outputBytes);
    let timedOut = false;
    let settled = false;
    let graceTimer = null;

    const child = spawn(cmd, args, { cwd, env: minimalEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      resolve({
        stdout: out.text(),
        stderr: err.text(),
        timedOut,
        timeMs: Number(process.hrtime.bigint() - started) / 1e6,
        outputTruncated: out.truncated || err.truncated,
        ...result,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      // If a grandchild keeps the pipes open, 'close' may never come: stop waiting.
      graceTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish({ exitCode: null, signal: 'SIGKILL' });
      }, 1000);
    }, timeoutMs);

    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    child.on('error', (spawnError) => finish({ exitCode: null, signal: null, spawnError }));
    child.on('close', (exitCode, signal) => finish({ exitCode, signal }));

    child.stdin.on('error', () => {}); // EPIPE when the program exits without reading stdin
    child.stdin.end(stdin);
  });
}

module.exports = { runProcess, minimalEnv };
