'use strict';

/**
 * One real MongoDB (mongodb-memory-server) is started for the whole run in
 * globalSetup. Each test FILE then gets its own uniquely named database
 * (test/setup/env.js), so files can run in parallel without seeing each
 * other's data.
 */
module.exports = {
  testEnvironment: 'node',
  globalSetup: '<rootDir>/test/setup/globalSetup.js',
  globalTeardown: '<rootDir>/test/setup/globalTeardown.js',
  setupFiles: ['<rootDir>/test/setup/env.js'],
  testMatch: ['<rootDir>/test/**/*.test.js'],
  // The first run downloads the mongod binary, so be generous.
  testTimeout: 30000,
};
