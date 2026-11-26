'use strict';

/**
 * verdict.js: turn what an executor observed into ONE verdict.
 *
 * It's a pure function: no I/O, no clock, no executor-specific knowledge.
 * Every executor (local processes, Judge0, Docker later) translates its own
 * results into the same "raw result" shape, and this decides. That keeps the
 * rules in one place and makes them table-testable (test/verdict.test.js).
 *
 * The ORDER of the checks is the whole design:
 *
 *   1. INTERNAL_ERROR  The executor itself failed (toolchain missing, Judge0
 *                      down). Not the user's fault, so this comes first and
 *                      no other flag is trusted.
 *   2. COMPILE_ERROR   Compilation failed (or timed out). Nothing ran, so
 *                      run flags are meaningless.
 *   3. MEMORY_LIMIT    The sandbox reports it killed the program for memory
 *                      (Docker's State.OOMKilled). Checked before the time
 *                      limit: a program thrashing near its memory cap is
 *                      often slow too, and memory is the real cause.
 *   4. TIME_LIMIT      OUR timer fired and we killed the program. This must
 *                      come from our own flag, NOT from the exit status:
 *                      we kill with SIGKILL, which looks exactly like an
 *                      out-of-memory kill (exit 137 = 128 + signal 9).
 *   5. MEMORY_LIMIT    Killed by SIGKILL / exit 137 and it wasn't us
 *                      (rule 4 already handled our kills): in a container
 *                      with a memory cap, that's the kernel's OOM killer.
 *   6. RUNTIME_ERROR   Any other signal (SIGSEGV, SIGFPE, SIGABRT...) or a
 *                      non-zero exit code (uncaught exception, exit(1)).
 *   7. OK              Exit code 0, no signal.
 *   (If nothing says how the program ended, we can't claim OK:
 *    INTERNAL_ERROR.)
 */

/**
 * @typedef {object} RawRunResult
 * @property {boolean} [internalError]   the executor failed, not the program
 * @property {{ ok: boolean, timedOut?: boolean, output?: string } | null} [compile]  null for interpreted languages
 * @property {boolean} [oomKilled]       the sandbox says the memory limit killed it
 * @property {boolean} [timedOut]        our run timer fired and we killed it
 * @property {number | null} [exitCode]  process exit code (null if killed by a signal)
 * @property {string | null} [signal]    e.g. 'SIGSEGV', 'SIGKILL'
 */

/** Exit code a shell reports for a process killed by SIGKILL (128 + 9). */
const EXIT_SIGKILL = 137;

/**
 * @param {RawRunResult | null | undefined} raw
 * @returns {'OK' | 'COMPILE_ERROR' | 'RUNTIME_ERROR' | 'TIME_LIMIT' | 'MEMORY_LIMIT' | 'INTERNAL_ERROR'}
 */
function toVerdict(raw) {
  if (!raw || raw.internalError) return 'INTERNAL_ERROR';
  if (raw.compile && raw.compile.ok === false) return 'COMPILE_ERROR';
  if (raw.oomKilled) return 'MEMORY_LIMIT';
  if (raw.timedOut) return 'TIME_LIMIT';
  if (raw.signal === 'SIGKILL' || raw.exitCode === EXIT_SIGKILL) return 'MEMORY_LIMIT';
  if (raw.signal) return 'RUNTIME_ERROR';
  if (typeof raw.exitCode !== 'number') return 'INTERNAL_ERROR';
  return raw.exitCode === 0 ? 'OK' : 'RUNTIME_ERROR';
}

module.exports = { toVerdict, EXIT_SIGKILL };
