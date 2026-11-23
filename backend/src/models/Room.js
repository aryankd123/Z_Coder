'use strict';

const { Schema, model, Types } = require('mongoose');

/** Roles in increasing order of power; requireRoomMember(minRole) compares indexes. */
const ROLES = Object.freeze(['viewer', 'editor', 'owner']);
const MAX_MEMBERS = 20;

/**
 * members[] is EMBEDDED in the room (not a separate collection) because:
 *   - it is bounded (max 20), so the document can't grow without limit;
 *   - it is read on every join, socket event and session load, so one read
 *     returns the room plus everyone in it.
 *
 * `name` is a denormalised copy of users.name, so the session endpoint
 * doesn't need a third query to show member names. Trade-off: it can go
 * stale on rename, so PATCH /api/users/me updates it with one updateMany.
 */
const memberSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true },
    role: { type: String, enum: ROLES, required: true },
    joinedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

/**
 * rooms: hot metadata only. The heavy Yjs document lives in roomDocs.
 *
 * Indexes:
 *   { inviteCode: 1 } UNIQUE
 *     - "join by code" is one index lookup; uniqueness also makes code
 *       collisions detectable (we retry on duplicate-key error).
 *   { 'members.userId': 1, lastActiveAt: -1 }
 *     - "my rooms, most recently active first":
 *       find({ 'members.userId': me }).sort({ lastActiveAt: -1 })
 *       is a single index range scan with no in-memory sort. It's a
 *       multikey index (one entry per member per room).
 */
const roomSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 1, maxlength: 60 },
    inviteCode: { type: String, required: true, unique: true },
    // Optional room password, bcrypt-hashed. Never selected by default, never returned.
    passwordHash: { type: String, default: null, select: false },
    ownerId: { type: Types.ObjectId, ref: 'User', required: true },
    members: {
      type: [memberSchema],
      default: [],
      // Runs on create/save only. Updates like $push skip validators, so the
      // join service enforces the cap inside its update filter.
      validate: [(m) => m.length <= MAX_MEMBERS, `a room can have at most ${MAX_MEMBERS} members`],
    },
    language: { type: String, default: 'javascript', maxlength: 30 },
    lastActiveAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

roomSchema.index({ 'members.userId': 1, lastActiveAt: -1 });

roomSchema.set('toJSON', {
  versionKey: false,
  transform(_doc, ret) {
    delete ret.passwordHash;
    return ret;
  },
});

const Room = model('Room', roomSchema, 'rooms');

module.exports = { Room, ROLES, MAX_MEMBERS };
