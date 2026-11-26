'use strict';

/**
 * One import point for all models, plus syncAllIndexes().
 *
 * syncIndexes() makes the indexes in MongoDB match the schema: it creates
 * missing ones and drops ones no longer declared. We run it at startup in
 * development and in tests. In production it should run as a deliberate step,
 * because building an index on a big collection is expensive.
 */
const { User } = require('./User');
const { RefreshToken } = require('./RefreshToken');
const { Room } = require('./Room');
const { RoomDoc } = require('./RoomDoc');
const { Message } = require('./Message');
const { Submission } = require('./Submission');
const { Problem } = require('./Problem');
const { Answer } = require('./Answer');

const ALL_MODELS = [User, RefreshToken, Room, RoomDoc, Message, Submission, Problem, Answer];

/** Create or drop indexes so MongoDB matches the schemas. */
async function syncAllIndexes() {
  await Promise.all(ALL_MODELS.map((m) => m.syncIndexes()));
}

/**
 * Which declared indexes are missing from the database? (Read-only; used at
 * production boot, where indexes are built by `npm run db:indexes`, not
 * automatically.)
 * @returns {Promise<string[]>} e.g. ['users: email_1']
 */
async function missingIndexes() {
  const missing = [];
  for (const model of ALL_MODELS) {
    const { toCreate } = await model.diffIndexes();
    for (const spec of toCreate) missing.push(`${model.collection.collectionName}: ${JSON.stringify(spec)}`);
  }
  return missing;
}

module.exports = {
  User,
  RefreshToken,
  Room,
  RoomDoc,
  Message,
  Submission,
  Problem,
  Answer,
  ALL_MODELS,
  syncAllIndexes,
  missingIndexes,
};
