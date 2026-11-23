'use strict';

const { Schema, model, Types } = require('mongoose');

/**
 * roomDocs: the persisted Yjs document for each room (filled in Phase 3).
 *
 * Kept OUT of `rooms` on purpose (hot metadata vs cold blob). "List my rooms"
 * and "load session" never need the code, so they shouldn't drag a binary
 * blob of up to several hundred KB through every query. The blob is read once
 * when a room's in-memory session starts, and written (debounced) while
 * people type.
 *
 * Index: { roomId: 1 } UNIQUE, so there's exactly one doc per room and the
 * load is one index hit.
 */
const roomDocSchema = new Schema(
  {
    roomId: { type: Types.ObjectId, ref: 'Room', required: true, unique: true },
    state: { type: Buffer, required: true }, // Y.encodeStateAsUpdate(doc)
  },
  { timestamps: true },
);

const RoomDoc = model('RoomDoc', roomDocSchema, 'roomDocs');

module.exports = { RoomDoc };
