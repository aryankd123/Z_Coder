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
 *   4. Build the room manager, the Express app and the Socket.IO gateway,
 *      all on ONE HTTP server (one port), then listen.
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
  const { RoomManager } = require('./realtime/roomManager');
  const { attachGateway } = require('./realtime/gateway');
  const { MemoryQueue } = require('./execution/queue/memoryQueue');
  const { createExecutor } = require('./execution/executors');
  const { createExecutionService } = require('./execution/executionService');

  await connectDb(config.mongodbUri, { autoIndex: !config.isProduction });
  if (!config.isProduction) await syncAllIndexes();

  // REST and sockets share the room manager: REST reads presence from it and
  // pushes membership changes into it; execution results go to rooms through it.
  const roomManager = new RoomManager({ persistDebounceMs: config.yjsPersistDebounceMs });

  // Code execution: queue (in-memory adapter) + executor (local or Judge0).
  // The worker runs in this process; with BullMQ it would be src/worker.js.
  const { execution: ex } = config;
  const queue = new MemoryQueue({ concurrency: ex.concurrency, maxWaiting: ex.queueMax });
  const execution = createExecutionService({ queue, executor: createExecutor(config), realtime: roomManager, limits: ex.limits });
  const recovered = await execution.recoverStale();
  if (recovered > 0) logger.warn({ recovered }, 'marked runs interrupted by the last shutdown as INTERNAL_ERROR');
  if (ex.executor === 'local') logger.warn('EXECUTOR=local: user code runs WITHOUT a sandbox (development only)');

  const server = http.createServer(createApp({ realtime: roomManager, execution }));
  const io = attachGateway(server, { roomManager });
  await new Promise((resolve) => server.listen(config.port, resolve));
  logger.info({ port: config.port, env: config.env, executor: ex.executor }, 'ZCoder API listening');

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    // Close sockets first (their disconnect handlers leave rooms), then let
    // the room manager flush anything it holds, then the database.
    await new Promise((resolve) => io.close(() => resolve())); // also closes the HTTP server
    await execution.close(); // finish running jobs; waiting ones are recovered at next boot
    await roomManager.close();
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
