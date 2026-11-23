'use strict';

/**
 * MongoDB connection via Mongoose.
 *
 * Unlike v1, a failed connection is NOT swallowed: connectDb() rejects, and
 * server.js exits. An API that is "up" without a database just turns every
 * request into a 10-second timeout.
 */
const mongoose = require('mongoose');

/**
 * @param {string} uri MongoDB connection string
 * @param {{ autoIndex?: boolean }} [options]
 */
async function connectDb(uri, { autoIndex = true } = {}) {
  // Throw on query filters that name a field the schema doesn't have. The
  // default (`true`) silently STRIPS such keys, so a typo like
  // { inviteCod: x } would become {} and match every document.
  mongoose.set('strictQuery', 'throw');
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 5000, // fail fast at boot instead of hanging
    autoIndex, // production builds indexes deliberately, not on every boot
  });
}

async function disconnectDb() {
  await mongoose.disconnect();
}

/** True when the driver reports an open connection (readyState 1). */
function isDbConnected() {
  return mongoose.connection.readyState === 1;
}

/** Round-trip to the server; throws if MongoDB doesn't answer. */
async function pingDb() {
  await mongoose.connection.db.admin().ping();
}

module.exports = { connectDb, disconnectDb, isDbConnected, pingDb };
