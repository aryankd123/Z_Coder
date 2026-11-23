'use strict';

/**
 * Local MongoDB WITHOUT Docker or an installer.
 *
 * mongodb-memory-server downloads a real `mongod` binary (once, ~100 MB,
 * cached) and runs it. We pin it to port 27017 and give it a data directory
 * (backend/.data/db, gitignored), so data survives restarts like a normal
 * install would.
 *
 * Usage:  npm run db      (leave it running; Ctrl+C to stop)
 * Then:   MONGODB_URI=mongodb://127.0.0.1:27017/zcoder  in backend/.env
 */
const fs = require('node:fs');
const path = require('node:path');
const { MongoMemoryServer } = require('mongodb-memory-server');

async function main() {
  const dbPath = path.join(__dirname, '..', '.data', 'db');
  fs.mkdirSync(dbPath, { recursive: true });

  const mongod = await MongoMemoryServer.create({
    instance: { port: 27017, dbPath, storageEngine: 'wiredTiger' },
  });
  console.log(`MongoDB ready at ${mongod.getUri()}  (data: backend/.data/db)  Ctrl+C to stop`);

  const stop = async () => {
    await mongod.stop({ doCleanup: false, force: false }); // keep the data files
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  console.error('Could not start local MongoDB:', err.message);
  process.exit(1);
});
