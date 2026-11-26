'use strict';

/**
 * A scriptable executor for tests. By default it "runs" any program by
 * upper-casing stdin and exiting 0. `hold()` makes runs wait until
 * `release()`, so tests can observe the queued and running states.
 */
class FakeExecutor {
  /** @param {(req: any) => any} [script] returns a RawRunResult */
  constructor(script) {
    this.name = 'fake';
    this.calls = [];
    this.script =
      script ??
      ((req) => ({ compile: null, stdout: req.stdin.toUpperCase(), stderr: '', exitCode: 0, signal: null, timedOut: false, timeMs: 7 }));
    this.gate = null;
  }

  hold() {
    let release;
    this.gate = new Promise((r) => {
      release = r;
    });
    this.release = () => {
      this.gate = null;
      release();
    };
  }

  async run(req) {
    this.calls.push(req);
    if (this.gate) await this.gate;
    return this.script(req);
  }
}

module.exports = { FakeExecutor };
