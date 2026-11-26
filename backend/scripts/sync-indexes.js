'use strict';

/**
 * Build (and drop stale) indexes on the database in MONGODB_URI, to match
 * the schemas. Run it once per deploy against production, from your own
 * machine:
 *
 *   cd backend
 *   MONGODB_URI="mongodb+srv://<your-user>:<password>@<your-cluster>/zcoder" npm run db:indexes
 *
 * Why it's a separate step: in production the server does NOT build indexes
 * at boot (autoIndex is off). Building an index on a large collection is
 * expensive and shouldn't happen by accident on every restart. But the
 * unique indexes are what make signup and room codes race-safe, so they
 * must exist; the server logs a loud warning at boot if any are missing.
 *
 * It prints index names only, never the URI.
 */
const mongoose = require('mongoose');

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri || !/^mongodb(\+srv)?:\/\//.test(uri)) {
    console.error('Set MONGODB_URI to the database you want to index (mongodb:// or mongodb+srv://).');
    process.exit(1);
  }
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000, autoIndex: false });
  const { ALL_MODELS } = require('../src/models');
  for (const model of ALL_MODELS) {
    const dropped = await model.syncIndexes();
    const indexes = await model.collection.indexes();
    console.log(`${model.collection.collectionName}: ${indexes.map((i) => i.name).join(', ')}${dropped.length ? ` (dropped: ${dropped.join(', ')})` : ''}`);
  }
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(`Index sync failed: ${err.message}`);
  process.exit(1);
});
