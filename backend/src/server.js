'use strict';

/**
 * Process entry point: validate config -> connect DB -> listen -> handle shutdown.
 *
 * Boot order is deliberate:
 *   1. getConfig() first. A bad config fails here with a readable list of
 *      variable names, before anything else is loaded.
 *   2. Connect to MongoDB and await it. If that fails, exit(1). (v1 logged
 *      the error and served requests with no database.)
 *   3. In dev, sync indexes so the schema's indexes exist.
 *   4. Listen.
 * From Phase 2, the Socket.IO gateway attaches to the same HTTP server here.
 */
const http = require('node:http');
const { getConfig } = require('./config');

async function main() {
  const config = getConfig();

  // Loaded after config validation (they read config at load time).
  const { logger } = require('./lib/logger');
  const { connectDb, disconnectDb } = require('./db');
  const { syncAllIndexes } = require('./models');
  const { createApp } = require('./app');

  await connectDb(config.mongodbUri, { autoIndex: !config.isProduction });
  if (!config.isProduction) await syncAllIndexes();

  const server = http.createServer(createApp());
  await new Promise((resolve) => server.listen(config.port, resolve));
  logger.info({ port: config.port, env: config.env }, 'ZCoder API listening');

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    server.close(); // stop accepting new connections; in-flight ones finish
    await disconnectDb();
    process.exit(0);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  // Config errors name variables, never values; safe to print.
  console.error(err.message);
  process.exit(1);
});
