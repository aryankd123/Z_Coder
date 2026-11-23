'use strict';

const { MongoMemoryServer } = require('mongodb-memory-server');

/** Start one throwaway MongoDB for the whole test run. Its URI reaches every worker via process.env. */
module.exports = async function globalSetup() {
  const mongod = await MongoMemoryServer.create();
  globalThis.__MONGOD__ = mongod;
  process.env.TEST_MONGO_BASE_URI = mongod.getUri();
};
