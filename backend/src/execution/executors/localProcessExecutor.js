'use strict';

/**
 * LocalProcessExecutor: DEVELOPMENT ONLY. Runs code as child processes on
 * this machine, with a timeout and output caps but NO SANDBOX.
 *
 * Why it exists: Docker isn't allowed on the dev laptop during OA season,
 * and Judge0 needs a key. This lets the whole app (rooms, shared console,
 * verdicts) run end to end locally.
 *
 * Why it must never reach production, i.e. what a sandbox (DockerExecutor)
 * adds that this lacks:
 *   - filesystem: user code can read and write anything this user can;
 *   - network: user code can open connections (exfiltration, attacks);
 *   - processes: a fork bomb or a grandchild process outlives our kill;
 *   - memory: only Node's heap is capped (--max-old-space-size);
 *     C++ and Python can allocate until the machine swaps.
 * What it does do: a wall-clock kill, capped output, a throwaway temp dir
 * per run, and a minimal environment (our secrets aren't visible to the code).
 *
 * Guarded twice: config.js refuses EXECUTOR=local when NODE_ENV=production,
 * and this constructor throws in production too.
 */
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runProcess } = require('./runProcess');

const IS_WINDOWS = process.platform === 'win32';

class LocalProcessExecutor {
  /**
   * @param {{ cxx: string, python: string, isProduction: boolean }} options
   */
  constructor({ cxx, python, isProduction }) {
    if (isProduction) throw new Error('LocalProcessExecutor is unsandboxed and must not run in production');
    this.name = 'local';
    this.cxx = cxx;
    this.python = python;
  }

  /** How to build and run each language inside `dir`. */
  _spec(language, dir) {
    const exe = path.join(dir, IS_WINDOWS ? 'main.exe' : 'main');
    switch (language) {
      case 'cpp':
        return {
          file: 'main.cpp',
          // -static on Windows: the .exe then doesn't depend on finding MinGW's runtime DLLs when it runs.
          compile: { cmd: this.cxx, args: ['-std=c++17', '-O2', '-pipe', ...(IS_WINDOWS ? ['-static'] : []), '-o', exe, 'main.cpp'] },
          run: { cmd: exe, args: [] },
        };
      case 'python':
        // -I: isolated mode (ignores PYTHON* env vars and the user site dir); -B: no .pyc files.
        return { file: 'main.py', run: { cmd: this.python, args: ['-I', '-B', 'main.py'] } };
      case 'javascript':
        // The same Node binary that runs the API; heap capped at 256 MB.
        return { file: 'main.js', run: { cmd: process.execPath, args: ['--max-old-space-size=256', 'main.js'] } };
      default:
        return null;
    }
  }

  /**
   * @param {{ language: string, source: string, stdin: string,
   *   limits: { compileTimeoutMs: number, runTimeoutMs: number, outputBytes: number } }} request
   * @returns {Promise<import('../verdict').RawRunResult & { stdout: string, stderr: string, timeMs: number | null }>}
   */
  async run({ language, source, stdin, limits }) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcoder-run-'));
    try {
      const spec = this._spec(language, dir);
      if (!spec) return { internalError: true, stdout: '', stderr: `Unsupported language: ${language}`, timeMs: null };
      await fs.writeFile(path.join(dir, spec.file), source, 'utf8');

      let compile = null;
      if (spec.compile) {
        const c = await runProcess(spec.compile.cmd, spec.compile.args, {
          cwd: dir,
          timeoutMs: limits.compileTimeoutMs,
          outputBytes: limits.outputBytes,
        });
        if (c.spawnError) return toolchainMissing(spec.compile.cmd, c.spawnError);
        compile = {
          ok: c.exitCode === 0 && !c.timedOut,
          timedOut: c.timedOut,
          output: c.timedOut ? 'Compilation timed out' : `${c.stdout}${c.stderr}`,
        };
        if (!compile.ok) return { compile, stdout: '', stderr: '', exitCode: null, signal: null, timedOut: false, timeMs: null };
      }

      const r = await runProcess(spec.run.cmd, spec.run.args, {
        cwd: dir,
        stdin,
        timeoutMs: limits.runTimeoutMs,
        outputBytes: limits.outputBytes,
      });
      if (r.spawnError) return toolchainMissing(spec.run.cmd, r.spawnError);
      return {
        compile,
        stdout: r.stdout,
        stderr: r.stderr,
        exitCode: r.exitCode,
        signal: r.signal,
        timedOut: r.timedOut,
        oomKilled: false, // no way to tell without a sandbox
        timeMs: Math.round(r.timeMs),
        outputTruncated: r.outputTruncated,
      };
    } finally {
      // Windows can hold the .exe for a moment after exit: retry the delete.
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
    }
  }
}

function toolchainMissing(cmd, err) {
  const reason = err.code === 'ENOENT' ? `${path.basename(cmd)} was not found on this machine` : 'could not start the program';
  return { internalError: true, stdout: '', stderr: `Local executor: ${reason}`, timeMs: null };
}

module.exports = { LocalProcessExecutor };
