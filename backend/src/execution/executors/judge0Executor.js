'use strict';

/**
 * Judge0Executor: runs code on a Judge0 instance (RapidAPI's hosted Judge0 CE
 * or a self-hosted one), called FROM THE SERVER.
 *
 * v1 called RapidAPI from the browser, which shipped the API key to every
 * visitor. Here the key lives in backend/.env and never leaves the server.
 *
 * Flow: POST /submissions (wait=false) -> token -> poll GET /submissions/:token
 * until the status is final. Polling works with every Judge0 deployment
 * (some disable wait=true). Judge0 runs each submission in an `isolate`
 * sandbox with our CPU-time and memory limits.
 *
 * The result is translated into the shared RawRunResult shape, and
 * verdict.js decides. Judge0's own status ids:
 *   1 In Queue, 2 Processing, 3 Accepted, 4 Wrong Answer (only with an
 *   expected output, which we don't send), 5 Time Limit Exceeded,
 *   6 Compilation Error, 7-12 Runtime Error (SIGSEGV, SIGXFSZ, SIGFPE,
 *   SIGABRT, NZEC, Other), 13 Internal Error, 14 Exec Format Error.
 */
const os = require('node:os');
const { LANGUAGES } = require('../languages');

const RUNTIME_SIGNALS = { 7: 'SIGSEGV', 8: 'SIGXFSZ', 9: 'SIGFPE', 10: 'SIGABRT' };
const FIELDS = 'status,stdout,stderr,compile_output,time,memory,exit_code,exit_signal,message';

const b64 = (s) => Buffer.from(s ?? '', 'utf8').toString('base64');
const unb64 = (s, limit) => {
  const text = s ? Buffer.from(s, 'base64').toString('utf8') : '';
  return text.length > limit ? text.slice(0, limit) : text;
};

/** Judge0 reports exit_signal as a number; verdict.js wants a name like 'SIGKILL'. */
function signalName(n) {
  if (typeof n !== 'number' || n <= 0) return null;
  return Object.entries(os.constants.signals).find(([, v]) => v === n)?.[0] ?? `SIG${n}`;
}

class Judge0Executor {
  /**
   * @param {{ url: string, rapidApiKey?: string, authToken?: string, fetch?: typeof fetch,
   *   pollIntervalMs?: number, maxWaitMs?: number, requestTimeoutMs?: number }} options
   */
  constructor({ url, rapidApiKey, authToken, fetch = globalThis.fetch, pollIntervalMs = 500, maxWaitMs = 30_000, requestTimeoutMs = 10_000 }) {
    this.name = 'judge0';
    this.url = url.replace(/\/$/, '');
    this.headers = { 'Content-Type': 'application/json' };
    if (rapidApiKey) {
      this.headers['X-RapidAPI-Key'] = rapidApiKey;
      this.headers['X-RapidAPI-Host'] = new URL(url).host;
    }
    if (authToken) this.headers['X-Auth-Token'] = authToken;
    this.fetch = fetch;
    this.pollIntervalMs = pollIntervalMs;
    this.maxWaitMs = maxWaitMs;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async _request(method, path, body) {
    const res = await this.fetch(`${this.url}${path}`, {
      method,
      headers: this.headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!res.ok) throw new Error(`Judge0 ${method} ${path.split('?')[0]} -> HTTP ${res.status}`);
    return res.json();
  }

  /**
   * @param {{ language: string, source: string, stdin: string,
   *   limits: { runTimeoutMs: number, memoryMb: number, outputBytes: number } }} request
   */
  async run({ language, source, stdin, limits }) {
    const lang = LANGUAGES[language];
    if (!lang) return { internalError: true, stdout: '', stderr: `Unsupported language: ${language}`, timeMs: null };
    try {
      const { token } = await this._request('POST', '/submissions?base64_encoded=true&wait=false', {
        language_id: lang.judge0Id,
        source_code: b64(source),
        stdin: b64(stdin),
        cpu_time_limit: limits.runTimeoutMs / 1000,
        wall_time_limit: (limits.runTimeoutMs * 2) / 1000,
        memory_limit: limits.memoryMb * 1024, // KB
      });
      if (!token) throw new Error('Judge0 returned no token');

      const deadline = Date.now() + this.maxWaitMs;
      while (Date.now() < deadline) {
        const result = await this._request('GET', `/submissions/${encodeURIComponent(token)}?base64_encoded=true&fields=${FIELDS}`);
        if (result?.status?.id > 2) return toRaw(result, lang, limits.outputBytes);
        await new Promise((r) => setTimeout(r, this.pollIntervalMs));
      }
      return { internalError: true, stdout: '', stderr: 'The code runner took too long to answer', timeMs: null };
    } catch {
      // Never surface Judge0's error text (it can echo request details).
      return { internalError: true, stdout: '', stderr: 'The code execution service is unavailable', timeMs: null };
    }
  }
}

/** Judge0 submission -> RawRunResult. */
function toRaw(r, lang, outputBytes) {
  const id = r.status.id;
  const compileOutput = unb64(r.compile_output, outputBytes);
  const base = {
    stdout: unb64(r.stdout, outputBytes),
    stderr: unb64(r.stderr, outputBytes),
    // Judge0 reports seconds as a string like "0.012" (or null if it never ran).
    timeMs: typeof r.time === 'string' || typeof r.time === 'number' ? Math.round(Number.parseFloat(r.time) * 1000) : null,
    exitCode: typeof r.exit_code === 'number' ? r.exit_code : null,
    signal: signalName(r.exit_signal),
    compile: lang.compiled ? { ok: true, output: compileOutput } : null,
    timedOut: false,
    oomKilled: false,
  };
  switch (true) {
    case id === 3 || id === 4:
      return { ...base, exitCode: 0, signal: null };
    case id === 5:
      return { ...base, timedOut: true };
    case id === 6:
      return { ...base, compile: { ok: false, output: compileOutput }, exitCode: null };
    case id >= 7 && id <= 10:
      return { ...base, signal: base.signal ?? RUNTIME_SIGNALS[id] };
    case id === 11 || id === 12:
      return { ...base, exitCode: base.exitCode || 1 };
    default: // 13 Internal Error, 14 Exec Format Error, anything unknown
      return { ...base, internalError: true };
  }
}

module.exports = { Judge0Executor, toRaw };
