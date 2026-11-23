'use strict';

const mongoose = require('mongoose');
const { connectDb } = require('../../src/db');
const { ALL_MODELS, syncAllIndexes } = require('../../src/models');

/** Connect to this file's private test database and build all indexes. */
async function setupTestDb() {
  await connectDb(process.env.MONGODB_URI);
  await syncAllIndexes(); // unique indexes must exist before duplicate tests run
}

/** Empty every collection (keeps the indexes). */
async function resetTestDb() {
  await Promise.all(ALL_MODELS.map((m) => m.deleteMany({})));
}

async function teardownTestDb() {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}

module.exports = { setupTestDb, resetTestDb, teardownTestDb };
