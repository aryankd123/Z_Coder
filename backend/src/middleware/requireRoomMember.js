'use strict';

/**
 * Room authorisation: "is the caller a member of this room, with at least
 * this role?" Runs on every room route, after requireAuth and after
 * validate({ params }) has checked that :roomId is a real ObjectId.
 *
 *   router.get('/:roomId/session', validate({ params }), requireRoomMember('viewer'), ...)
 *
 * One query loads the room AND checks membership (the filter includes
 * 'members.userId'). The loaded room goes on req.room, so the controller
 * doesn't fetch it again; that's how the session endpoint stays at 2 queries.
 *
 * Not a member -> 404, not 403. A 403 would confirm that the room exists,
 * which leaks information to someone probing room ids.
 * Member, but the role is too low -> 403 ROOM_FORBIDDEN.
 */
const { ROLES } = require('../models/Room');
const { notFound, forbidden } = require('../lib/errors');
const { findRoomForMember, findMember, roleAtLeast } = require('../services/roomService');

/**
 * @param {'viewer' | 'editor' | 'owner'} [minRole]
 * @returns {import('express').RequestHandler}
 */
function requireRoomMember(minRole = 'viewer') {
  if (!ROLES.includes(minRole)) throw new Error(`Unknown role: ${minRole}`);

  return async (req, _res, next) => {
    const roomId = req.valid?.params?.roomId;
    if (!roomId) throw new Error('requireRoomMember needs validate({ params }) with roomId before it');

    const room = await findRoomForMember(roomId, req.auth.userId);
    if (!room) throw notFound('ROOM_NOT_FOUND', 'Room not found');

    const membership = findMember(room, req.auth.userId);
    if (!roleAtLeast(membership.role, minRole)) {
      throw forbidden('ROOM_FORBIDDEN', `This needs the ${minRole} role in the room`);
    }
    req.room = room;
    req.membership = membership;
    next();
  };
}

module.exports = { requireRoomMember };
