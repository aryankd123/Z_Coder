'use strict';

/**
 * Room controllers: the HTTP layer for rooms and chat history.
 *
 * Identity is always req.auth.userId (from the token), never the body.
 * Routes with :roomId run requireRoomMember first, which leaves the loaded
 * room on req.room and the caller's membership on req.membership.
 *
 * req.app.locals.realtime is the realtime layer (the room manager), or a
 * no-op stand-in when there's no socket server (e.g. REST-only tests). REST
 * uses it to read who's online and to push membership changes to sockets.
 */
const roomService = require('../services/roomService');
const chatService = require('../services/chatService');

/** POST /api/rooms -> 201 { room } */
async function create(req, res) {
  res.status(201).json({ room: await roomService.createRoom(req.auth.userId, req.valid.body) });
}

/** POST /api/rooms/join -> 200 { room } */
async function join(req, res) {
  res.json({ room: await roomService.joinRoom(req.auth.userId, req.valid.body) });
}

/** GET /api/rooms?limit=&before= -> 200 { rooms, nextCursor } */
async function listMine(req, res) {
  res.json(await roomService.listMyRooms(req.auth.userId, req.valid.query));
}

/** GET /api/rooms/:roomId/session -> 200 { room, messages, hasMoreMessages, nextCursor } */
async function session(req, res) {
  const online = req.app.locals.realtime.onlineUserIds(String(req.room._id));
  res.json(await roomService.getSession(req.room, req.auth.userId, online));
}

/** GET /api/rooms/:roomId/messages?before=&limit= -> 200 { messages, hasMore, nextCursor } */
async function messages(req, res) {
  res.json(await chatService.listMessages(req.room._id, req.valid.query));
}

/** PATCH /api/rooms/:roomId/members/:userId { role } -> 200 { member } (owner only) */
async function patchMember(req, res) {
  const { roomId, userId } = req.valid.params;
  const member = await roomService.updateMemberRole(req.room, userId, req.valid.body.role);
  req.app.locals.realtime.memberRoleChanged(roomId, userId, member.role);
  res.json({ member });
}

/** DELETE /api/rooms/:roomId/members/:userId -> 204 (owner removes anyone; members remove themselves) */
async function removeMember(req, res) {
  const { roomId, userId } = req.valid.params;
  await roomService.removeMember(req.room, req.membership, userId);
  req.app.locals.realtime.memberRemoved(roomId, userId);
  res.status(204).end();
}

module.exports = { create, join, listMine, session, messages, patchMember, removeMember };
