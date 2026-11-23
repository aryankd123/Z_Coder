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
};
