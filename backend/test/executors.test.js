'use strict';

/**
 * Executor contract tests. Every executor must turn "what happened" into the
 * same RawRunResult shape; verdict.js then decides. We check that through the
 * verdict, which is what users see.
 *
 *  - LocalProcessExecutor against the REAL toolchains on this machine (and
 *    CI). Each language is skipped automatically if its tool isn't installed.
 *  - Judge0Executor against a fake fetch (no network, no key): status
 *    mapping, polling, outage handling, and that the key is sent as a header.
 *  - runProcess: timeout, output cap, and that our secrets don't leak into
 *    the child's environment.
 */
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const { LocalProcessExecutor } = require('../src/execution/executors/localProcessExecutor');
const { Judge0Executor } = require('../src/execution/executors/judge0Executor');
const { runProcess } = require('../src/execution/executors/runProcess');
const { toVerdict } = require('../src/execution/verdict');
const { getConfig } = require('../src/config');

const limits = { runTimeoutMs: 2000, compileTimeoutMs: 30000, memoryMb: 256, outputBytes: 64 * 1024 };
const { local } = getConfig().execution;
const has = (cmd) => !spawnSync(cmd, ['--version'], { windowsHide: true }).error;
const local$ = new LocalProcessExecutor({ ...local, isProduction: false });

const testIf = (cond) => (cond ? test : test.skip);

describe('LocalProcessExecutor (real toolchains)', () => {
  jest.setTimeout(60000);

  test('refuses to exist in production', () => {
    expect(() => new LocalProcessExecutor({ ...local, isProduction: true })).toThrow(/production/);
  });

  describe('javascript (node)', () => {
    const run = (source, stdin = '') => local$.run({ language: 'javascript', source, stdin, limits });

    test('hello world + stdin -> OK', async () => {
      const r = await run("const s=require('fs').readFileSync(0,'utf8').trim(); console.log('hi ' + s)", 'there');
      expect(toVerdict(r)).toBe('OK');
      expect(r.stdout.trim()).toBe('hi there');
      expect(r.timeMs).toBeGreaterThan(0);
    });

    test('uncaught exception -> RUNTIME_ERROR with stderr', async () => {
      const r = await run("throw new Error('boom')");
      expect(toVerdict(r)).toBe('RUNTIME_ERROR');
      expect(r.stderr).toMatch(/boom/);
    });

    test('infinite loop -> TIME_LIMIT (killed from outside)', async () => {
      const r = await local$.run({ language: 'javascript', source: 'while (true) {}', stdin: '', limits: { ...limits, runTimeoutMs: 500 } });
      expect(toVerdict(r)).toBe('TIME_LIMIT');
    });

    test("the program cannot see the server's secrets", async () => {
      const r = await run("console.log(JSON.stringify([process.env.JWT_ACCESS_SECRET, process.env.MONGODB_URI]))");
      expect(r.stdout.trim()).toBe('[null,null]');
    });
  });

  describe('python', () => {
    const ok = has(local.python);
    const run = (source, stdin = '') => local$.run({ language: 'python', source, stdin, limits });

    testIf(ok)('stdin -> OK', async () => {
      const r = await run('import sys\nprint(sys.stdin.read().strip()[::-1])', 'abc');
      expect(toVerdict(r)).toBe('OK');
      expect(r.stdout.trim()).toBe('cba');
    });

    testIf(ok)('exception -> RUNTIME_ERROR', async () => {
      const r = await run('1/0');
      expect(toVerdict(r)).toBe('RUNTIME_ERROR');
      expect(r.stderr).toMatch(/ZeroDivisionError/);
    });

    testIf(ok)('sleep past the limit -> TIME_LIMIT', async () => {
      const r = await local$.run({ language: 'python', source: 'import time\ntime.sleep(10)', stdin: '', limits: { ...limits, runTimeoutMs: 500 } });
      expect(toVerdict(r)).toBe('TIME_LIMIT');
    });
  });

  describe('cpp (g++)', () => {
    const ok = has(local.cxx);
    const run = (source, stdin = '') => local$.run({ language: 'cpp', source, stdin, limits });

    testIf(ok)('compiles and reads stdin -> OK', async () => {
      const r = await run('#include <iostream>\nint main(){int a,b; std::cin>>a>>b; std::cout<<a+b<<"\\n";}', '2 40');
      expect(toVerdict(r)).toBe('OK');
      expect(r.stdout.trim()).toBe('42');
      expect(r.compile.ok).toBe(true);
    });

    testIf(ok)('syntax error -> COMPILE_ERROR with the compiler output', async () => {
      const r = await run('int main() { return 0 }');
      expect(toVerdict(r)).toBe('COMPILE_ERROR');
      expect(r.compile.output).toMatch(/error/i);
    });

    testIf(ok)('non-zero return -> RUNTIME_ERROR', async () => {
      const r = await run('int main(){ return 3; }');
      expect(toVerdict(r)).toBe('RUNTIME_ERROR');
      expect(r.exitCode).toBe(3);
    });
  });

  test('a missing toolchain is an INTERNAL_ERROR, not the user\'s fault', async () => {
    const broken = new LocalProcessExecutor({ cxx: 'definitely-not-a-compiler', python: 'nope', isProduction: false });
    const r = await broken.run({ language: 'python', source: 'print(1)', stdin: '', limits });
    expect(toVerdict(r)).toBe('INTERNAL_ERROR');
    expect(r.stderr).toMatch(/not found/);
  });
});

describe('runProcess', () => {
  test('caps output per stream and still ends the program on time', async () => {
    const r = await runProcess(process.execPath, ['-e', 'for(;;) process.stdout.write("x".repeat(1024))'], {
      cwd: os.tmpdir(),
      timeoutMs: 700,
      outputBytes: 4096,
    });
    expect(r.timedOut).toBe(true);
    expect(r.stdout.length).toBe(4096);
    expect(r.outputTruncated).toBe(true);
  });
});

describe('Judge0Executor (fake fetch)', () => {
  /** A fake Judge0: POST returns a token; GETs return `statuses` one by one. */
  function fakeJudge0(results, { failPost = false } = {}) {
    const calls = [];
    let get = 0;
    const fetch = async (url, init) => {
      calls.push({ url, init });
      if (init.method === 'POST') {
        return failPost ? new Response('nope', { status: 500 }) : Response.json({ token: 'tok-1' }, { status: 201 });
      }
      const r = results[Math.min(get, results.length - 1)];
      get += 1;
      return Response.json(r);
    };
    return { fetch, calls };
  }
  const b64 = (s) => Buffer.from(s).toString('base64');
  const make = (fetch) => new Judge0Executor({ url: 'https://judge0-ce.p.rapidapi.com', rapidApiKey: 'test-key', fetch, pollIntervalMs: 1 });
  const req = (language = 'cpp') => ({ language, source: 'x', stdin: 'in', limits });

  test.each([
    ['Accepted', { status: { id: 3 }, stdout: b64('42\n'), time: '0.012', exit_code: 0 }, 'OK'],
    ['Time Limit Exceeded', { status: { id: 5 }, time: '2.0' }, 'TIME_LIMIT'],
    ['Compilation Error', { status: { id: 6 }, compile_output: b64('main.cpp:1: error') }, 'COMPILE_ERROR'],
    ['Runtime Error (SIGSEGV)', { status: { id: 7 }, exit_signal: 11 }, 'RUNTIME_ERROR'],
    ['Runtime Error (NZEC)', { status: { id: 11 }, exit_code: 1 }, 'RUNTIME_ERROR'],
    ['Runtime Error killed by SIGKILL', { status: { id: 12 }, exit_signal: 9 }, 'MEMORY_LIMIT'],
    ['Internal Error', { status: { id: 13 } }, 'INTERNAL_ERROR'],
  ])('Judge0 "%s" -> %s', async (_name, result, verdict) => {
    const { fetch } = fakeJudge0([{ status: { id: 1 } }, { status: { id: 2 } }, result]);
    const r = await make(fetch).run(req());
    expect(toVerdict(r)).toBe(verdict);
  });

  test('decodes base64 output, sends limits and the key header, never the key in the body', async () => {
    const { fetch, calls } = fakeJudge0([{ status: { id: 3 }, stdout: b64('hello\n'), time: '0.5', exit_code: 0 }]);
    const r = await make(fetch).run(req('python'));
    expect(r.stdout).toBe('hello\n');
    expect(r.timeMs).toBe(500);
    const post = calls[0];
    const body = JSON.parse(post.init.body);
    expect(body).toMatchObject({ language_id: 71, cpu_time_limit: 2, memory_limit: 256 * 1024, stdin: b64('in') });
    expect(post.init.headers['X-RapidAPI-Key']).toBe('test-key');
    expect(post.init.headers['X-RapidAPI-Host']).toBe('judge0-ce.p.rapidapi.com');
    expect(post.init.body).not.toContain('test-key');
  });

  test('an outage is INTERNAL_ERROR with a generic message', async () => {
    const { fetch } = fakeJudge0([], { failPost: true });
    const r = await make(fetch).run(req());
    expect(toVerdict(r)).toBe('INTERNAL_ERROR');
    expect(r.stderr).toBe('The code execution service is unavailable');
  });

  test('gives up if Judge0 never finishes', async () => {
    const { fetch } = fakeJudge0([{ status: { id: 2 } }]);
    const slow = new Judge0Executor({ url: 'http://judge0.local', fetch, pollIntervalMs: 5, maxWaitMs: 50 });
    expect(toVerdict(await slow.run(req()))).toBe('INTERNAL_ERROR');
  });
});
