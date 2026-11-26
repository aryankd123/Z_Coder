'use strict';

/** Table-driven tests for the pure verdict function. One row = one rule. */
const { toVerdict } = require('../src/execution/verdict');

const ok = { compile: null, exitCode: 0, signal: null, timedOut: false, oomKilled: false };

describe('toVerdict', () => {
  test.each([
    ['clean exit', ok, 'OK'],
    ['clean exit after a successful compile', { ...ok, compile: { ok: true } }, 'OK'],
    ['compile failed', { ...ok, compile: { ok: false }, exitCode: null }, 'COMPILE_ERROR'],
    ['compile timed out', { ...ok, compile: { ok: false, timedOut: true }, exitCode: null }, 'COMPILE_ERROR'],
    ['non-zero exit (exception, exit(1))', { ...ok, exitCode: 1 }, 'RUNTIME_ERROR'],
    ['segfault', { ...ok, exitCode: null, signal: 'SIGSEGV' }, 'RUNTIME_ERROR'],
    ['division by zero', { ...ok, exitCode: null, signal: 'SIGFPE' }, 'RUNTIME_ERROR'],
    ['abort()', { ...ok, exitCode: 134, signal: null }, 'RUNTIME_ERROR'],
    ['our timer killed it (SIGKILL)', { ...ok, exitCode: null, signal: 'SIGKILL', timedOut: true }, 'TIME_LIMIT'],
    ['our timer killed it (exit 137)', { ...ok, exitCode: 137, timedOut: true }, 'TIME_LIMIT'],
    ['sandbox OOM flag', { ...ok, exitCode: 137, oomKilled: true }, 'MEMORY_LIMIT'],
    ['OOM flag wins over a timeout', { ...ok, exitCode: 137, oomKilled: true, timedOut: true }, 'MEMORY_LIMIT'],
    ['SIGKILL that was not us = OOM killer', { ...ok, exitCode: null, signal: 'SIGKILL' }, 'MEMORY_LIMIT'],
    ['exit 137 that was not us = OOM killer', { ...ok, exitCode: 137 }, 'MEMORY_LIMIT'],
    ['executor failure beats everything', { ...ok, internalError: true, timedOut: true }, 'INTERNAL_ERROR'],
    ['compile error beats run flags', { ...ok, compile: { ok: false }, timedOut: true }, 'COMPILE_ERROR'],
    ['no exit status at all', { compile: null }, 'INTERNAL_ERROR'],
    ['null result', null, 'INTERNAL_ERROR'],
  ])('%s -> %s', (_name, raw, expected) => {
    expect(toVerdict(raw)).toBe(expected);
  });
});
