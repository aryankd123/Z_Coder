'use strict';

/**
 * The Executor "port". Every executor has the same shape:
 *
 *   executor.name                -> 'local' | 'judge0' | (later) 'docker'
 *   executor.run({ language, source, stdin, limits }) -> Promise<RawRunResult>
 *
 * and never throws for anything the user's code does; failures of the
 * executor itself come back as { internalError: true }. verdict.js turns
 * the RawRunResult into a verdict, whichever executor produced it.
 *
 * Which adapter runs is chosen by EXECUTOR in the environment.
 */
const { LocalProcessExecutor } = require('./localProcessExecutor');
const { Judge0Executor } = require('./judge0Executor');

/** @param {ReturnType<typeof import('../../config').getConfig>} config */
function createExecutor(config) {
  const { executor, judge0, local } = config.execution;
  if (executor === 'judge0') return new Judge0Executor(judge0);
  return new LocalProcessExecutor({ ...local, isProduction: config.isProduction });
}

module.exports = { createExecutor };
