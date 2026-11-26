'use strict';

/**
 * Persistence for a room's shared document (the Yjs state).
 *
 * The RoomManager is the only caller. It passes this module in as its
 * `store`, so tests can swap in a slow or failing store.
 */
const { RoomDoc } = require('../models/RoomDoc');
const { Room } = require('../models/Room');

/**
 * @param {string} roomId
 * @returns {Promise<Uint8Array | null>} the saved Y.encodeStateAsUpdate() bytes, or null for a new room
 */
async function loadState(roomId) {
  const doc = await RoomDoc.findOne({ roomId }, { state: 1 }).lean();
  // .lean() returns a BSON Binary for Buffer fields; .buffer is the bytes.
  if (!doc) return null;
  const { state } = doc;
  return new Uint8Array(state.buffer ?? state);
}

/**
 * Upsert the whole document state. Saving the full state (not a log of
 * updates) keeps exactly one small document per room: encodeStateAsUpdate
 * merges all history into a compact form, and with gc on, deleted text
 * leaves only tiny tombstones.
 * @param {string} roomId
 * @param {Uint8Array} state
 */
async function saveState(roomId, state) {
  await RoomDoc.updateOne({ roomId }, { $set: { state: Buffer.from(state) } }, { upsert: true });
}

/**
 * Keep rooms.language in step with the editor's language (Y.Map meta).
 * @param {string} roomId
 * @param {string} language already validated
 */
async function saveLanguage(roomId, language) {
  await Room.updateOne({ _id: roomId }, { $set: { language } });
}

module.exports = { loadState, saveState, saveLanguage };
