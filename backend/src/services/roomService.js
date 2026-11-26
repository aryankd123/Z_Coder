'use strict';

/**
 * Room service: create, join, list, load a session, and manage members.
 * Plain async functions (no req/res), shared by the REST controllers and the
 * Socket.IO gateway.
 */
const bcrypt = require('bcryptjs');
const { getConfig } = require('../config');
const { Room, ROLES, MAX_MEMBERS } = require('../models/Room');
const { User } = require('../models/User');
const inviteCodes = require('../lib/inviteCode');
const { notFound, forbidden, conflict } = require('../lib/errors');
const chatService = require('./chatService');

const INVITE_CODE_ATTEMPTS = 5;

/**
 * Every field a member may see. passwordHash is not here (and has
 * select: false in the schema), so it never leaves the database.
 */
const ROOM_PROJECTION = Object.freeze({
  name: 1,
  inviteCode: 1,
  ownerId: 1,
  members: 1,
  language: 1,
  lastActiveAt: 1,
  createdAt: 1,
});

/**
 * Is `role` at least as powerful as `minRole`? ROLES is ordered
 * viewer < editor < owner, so this is an index comparison.
 * @param {string} role
 * @param {string} minRole
 */
function roleAtLeast(role, minRole) {
  return ROLES.indexOf(role) >= ROLES.indexOf(minRole);
}

/** @param {{ members: { userId: unknown }[] }} room */
function findMember(room, userId) {
  return room.members.find((m) => String(m.userId) === String(userId)) ?? null;
}

/**
 * The public shape of a room: an allowlist, so a new private field stays private.
 * @param {any} room a lean room
 * @param {string} viewerId the caller, to fill in myRole
 * @param {Set<string>} [onlineIds] when given, each member gets an `online` flag
 */
function toPublicRoom(room, viewerId, onlineIds) {
  return {
    id: String(room._id),
    name: room.name,
    inviteCode: room.inviteCode,
    ownerId: String(room.ownerId),
    language: room.language,
    myRole: findMember(room, viewerId)?.role ?? null,
    members: room.members.map((m) => ({
      userId: String(m.userId),
      name: m.name,
      role: m.role,
      joinedAt: m.joinedAt,
      ...(onlineIds && { online: onlineIds.has(String(m.userId)) }),
    })),
    lastActiveAt: room.lastActiveAt,
    createdAt: room.createdAt,
  };
}

async function loadUserName(userId) {
  const user = await User.findById(userId, { name: 1 }).lean();
  if (!user) throw notFound('USER_NOT_FOUND', 'Account not found');
  return user.name;
}

/**
 * Create a room with the caller as its owner.
 *
 * Invite codes are random, so two rooms can (rarely) draw the same one. We
 * don't check first; we insert, and if the unique index on inviteCode rejects
 * it, draw a new code and try again.
 *
 * @param {string} userId
 * @param {{ name: string, password?: string, language: string }} input validated
 */
async function createRoom(userId, { name, password, language }) {
  const ownerName = await loadUserName(userId);
  const passwordHash = password ? await bcrypt.hash(password, getConfig().bcryptCost) : null;
  const now = new Date();

  for (let attempt = 1; ; attempt += 1) {
    try {
      const room = await Room.create({
        name,
        language,
        passwordHash,
        ownerId: userId,
        inviteCode: inviteCodes.generateInviteCode(),
        members: [{ userId, name: ownerName, role: 'owner', joinedAt: now }],
        lastActiveAt: now,
      });
      return toPublicRoom(room.toObject(), userId);
    } catch (err) {
      const inviteCodeTaken = err?.code === 11000 && err.keyPattern?.inviteCode;
      if (!inviteCodeTaken || attempt >= INVITE_CODE_ATTEMPTS) throw err;
    }
  }
}

/**
 * Join a room by its invite code.
 *
 * Steps:
 *   1. Find the room by code. Unknown code -> 404.
 *   2. Already a member? Return the room. Joining twice is a no-op
 *      (idempotent), and a member doesn't need the password again.
 *   3. If the room has a password, bcrypt-compare it. Missing or wrong -> 403.
 *   4. Add the member with ONE conditional update. The filter only matches
 *      when the caller is still not a member AND the room has fewer than
 *      20 members:
 *        { _id, 'members.userId': { $ne: me }, 'members.19': { $exists: false } }
 *      'members.19' is the 20th array element; if it doesn't exist, there are
 *      at most 19 members. MongoDB applies the filter and the $push atomically
 *      to the single document, so two people racing for the last seat can't
 *      both win, and a double-click can't add me twice.
 *   5. If nothing matched, re-read to report why: I'm already in (a
 *      concurrent join of mine won), or the room is full (409).
 *
 * Why not "read members, check length, then save()"? Between the read and
 * the write another request can join, and both writes would succeed: a
 * classic check-then-act race. The schema's 20-member validator doesn't help
 * either, because Mongoose validators don't run on update operators like $push.
 *
 * @param {string} userId
 * @param {{ inviteCode: string, password?: string }} input validated (code is upper-cased)
 * @returns {Promise<ReturnType<typeof toPublicRoom>>} never contains the password hash
 * @throws {import('../lib/errors').AppError} 404 ROOM_NOT_FOUND, 403 ROOM_PASSWORD_REQUIRED |
 *   ROOM_PASSWORD_INVALID, 409 ROOM_FULL
 */
async function joinRoom(userId, { inviteCode, password }) {
  const room = await Room.findOne({ inviteCode }).select('+passwordHash').lean();
  if (!room) throw notFound('ROOM_NOT_FOUND', 'No room has that code');

  if (findMember(room, userId)) return toPublicRoom(room, userId);

  if (room.passwordHash) {
    if (password === undefined) throw forbidden('ROOM_PASSWORD_REQUIRED', 'This room needs a password');
    const ok = await bcrypt.compare(password, room.passwordHash);
    if (!ok) throw forbidden('ROOM_PASSWORD_INVALID', 'Wrong room password');
  }

  const name = await loadUserName(userId);
  const now = new Date();
  const updated = await Room.findOneAndUpdate(
    {
      _id: room._id,
      'members.userId': { $ne: userId },
      [`members.${MAX_MEMBERS - 1}`]: { $exists: false },
    },
    {
      $push: { members: { userId, name, role: 'editor', joinedAt: now } },
      $set: { lastActiveAt: now },
    },
    { new: true, projection: ROOM_PROJECTION },
  ).lean();
  if (updated) return toPublicRoom(updated, userId);

  const current = await Room.findById(room._id, ROOM_PROJECTION).lean();
  if (!current) throw notFound('ROOM_NOT_FOUND', 'No room has that code');
  if (findMember(current, userId)) return toPublicRoom(current, userId);
  throw conflict('ROOM_FULL', `This room already has ${MAX_MEMBERS} members`);
}

/**
 * The rooms I'm a member of, most recently active first.
 *
 * Served by the multikey index { 'members.userId': 1, lastActiveAt: -1 }:
 * equality on my id, then the index is already in lastActiveAt order, so
 * there's no in-memory sort. Cursor = lastActiveAt of the last room shown.
 *
 * @param {string} userId
 * @param {{ limit: number, before?: string }} query validated
 */
async function listMyRooms(userId, { limit, before }) {
  const filter = { 'members.userId': userId };
  if (before) filter.lastActiveAt = { $lt: new Date(before) };
  const docs = await Room.find(filter, ROOM_PROJECTION).sort({ lastActiveAt: -1 }).limit(limit + 1).lean();
  const hasMore = docs.length > limit;
  const rooms = docs.slice(0, limit).map((r) => ({
    id: String(r._id),
    name: r.name,
    inviteCode: r.inviteCode,
    language: r.language,
    memberCount: r.members.length,
    myRole: findMember(r, userId)?.role ?? null,
    lastActiveAt: r.lastActiveAt,
  }));
  return { rooms, nextCursor: hasMore ? rooms.at(-1).lastActiveAt.toISOString() : null };
}

/**
 * Load a room only if `userId` is a member. One query on _id (a point
 * lookup); the membership test rides along in the same filter.
 * Returns null both for "no such room" and "not a member", so callers can
 * answer 404 without revealing whether the room exists.
 *
 * @param {string} roomId
 * @param {string} userId
 */
async function findRoomForMember(roomId, userId) {
  return Room.findOne({ _id: roomId, 'members.userId': userId }, ROOM_PROJECTION).lean();
}

/**
 * GET /api/rooms/:roomId/session: everything a client needs to open a room.
 *
 * "Active session data retrieval" in at most 2 queries:
 *   query 1: findRoomForMember (done by requireRoomMember, passed in as `room`):
 *            metadata + members with their denormalised names, no users lookup;
 *   query 2: the last 50 messages (one bounded index range scan).
 * Online flags come from the in-memory room manager, not the database. The
 * code itself (the Yjs document) arrives over the socket, not here.
 *
 * @param {any} room lean room from findRoomForMember
 * @param {string} viewerId
 * @param {Set<string>} onlineIds user ids currently connected to this room
 */
async function getSession(room, viewerId, onlineIds) {
  const { messages, hasMore, nextCursor } = await chatService.listMessages(room._id, { limit: 50 });
  return { room: toPublicRoom(room, viewerId, onlineIds), messages, hasMoreMessages: hasMore, nextCursor };
}

/**
 * Owner changes a member's role (viewer <-> editor).
 *
 * $elemMatch picks the member element whose userId matches AND who isn't
 * the owner; `members.$` then updates exactly that element.
 *
 * @param {any} room lean room (the caller is its owner; checked by requireRoomMember('owner'))
 * @param {string} targetUserId
 * @param {'viewer' | 'editor'} role
 */
async function updateMemberRole(room, targetUserId, role) {
  if (String(room.ownerId) === targetUserId) {
    throw conflict('CANNOT_CHANGE_OWNER', "The owner's role can't be changed");
  }
  const res = await Room.updateOne(
    { _id: room._id, members: { $elemMatch: { userId: targetUserId, role: { $ne: 'owner' } } } },
    { $set: { 'members.$.role': role } },
  );
  if (res.matchedCount === 0) throw notFound('MEMBER_NOT_FOUND', 'That user is not a member of this room');
  const member = findMember(room, targetUserId);
  return { userId: targetUserId, name: member?.name, role };
}

/**
 * Remove a member. The owner may remove anyone but themself; any other
 * member may remove only themself ("leave the room").
 *
 * @param {any} room lean room
 * @param {{ userId: unknown, role: string }} actor the caller's membership
 * @param {string} targetUserId
 */
async function removeMember(room, actor, targetUserId) {
  const self = String(actor.userId) === targetUserId;
  if (!self && actor.role !== 'owner') {
    throw forbidden('ROOM_FORBIDDEN', 'Only the owner can remove other members');
  }
  if (String(room.ownerId) === targetUserId) {
    throw conflict('OWNER_CANNOT_LEAVE', "The owner can't leave or be removed from their room");
  }
  const res = await Room.updateOne(
    { _id: room._id, members: { $elemMatch: { userId: targetUserId, role: { $ne: 'owner' } } } },
    { $pull: { members: { userId: targetUserId } } },
  );
  if (res.matchedCount === 0) throw notFound('MEMBER_NOT_FOUND', 'That user is not a member of this room');
}

/**
 * Bump lastActiveAt so the room rises to the top of "my rooms".
 * @param {string} roomId
 */
async function touchRoom(roomId) {
  await Room.updateOne({ _id: roomId }, { $set: { lastActiveAt: new Date() } });
}

module.exports = {
  createRoom,
  joinRoom,
  listMyRooms,
  findRoomForMember,
  getSession,
  updateMemberRole,
  removeMember,
  touchRoom,
  toPublicRoom,
  findMember,
  roleAtLeast,
  ROOM_PROJECTION,
};
