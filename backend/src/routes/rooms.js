'use strict';

const express = require('express');
const rooms = require('../controllers/roomController');
const executions = require('../controllers/executionController');
const { roomExecutionsQuery } = require('../validators/execution');
const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/requireAuth');
const { requireRoomMember } = require('../middleware/requireRoomMember');
const v = require('../validators/room');

/**
 * /api/rooms/*: every route needs a valid access token, and every route
 * with :roomId also needs room membership (requireRoomMember). Order on each
 * route: validate input -> check membership/role -> controller.
 *
 * @param {{ limiters: { roomJoinFailuresPerUser: import('express').RequestHandler } }} deps
 */
function roomsRouter({ limiters }) {
  const router = express.Router();
  router.use(requireAuth);

  router.post('/', validate({ body: v.createRoomBody }), rooms.create);
  router.post('/join', limiters.roomJoinFailuresPerUser, validate({ body: v.joinRoomBody }), rooms.join);
  router.get('/', validate({ query: v.listRoomsQuery }), rooms.listMine);

  router.get('/:roomId/session', validate({ params: v.roomParams }), requireRoomMember('viewer'), rooms.session);
  router.get(
    '/:roomId/messages',
    validate({ params: v.roomParams, query: v.messagesQuery }),
    requireRoomMember('viewer'),
    rooms.messages,
  );
  router.get(
    '/:roomId/executions',
    validate({ params: v.roomParams, query: roomExecutionsQuery }),
    requireRoomMember('viewer'),
    executions.listForRoom,
  );
  router.patch(
    '/:roomId/members/:userId',
    validate({ params: v.memberParams, body: v.patchMemberBody }),
    requireRoomMember('owner'),
    rooms.patchMember,
  );
  // Any member may call this; the service allows owner -> anyone, member -> self.
  router.delete(
    '/:roomId/members/:userId',
    validate({ params: v.memberParams }),
    requireRoomMember('viewer'),
    rooms.removeMember,
  );

  return router;
}

module.exports = { roomsRouter };
