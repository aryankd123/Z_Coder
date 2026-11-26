'use strict';

/**
 * Live chat over the socket.
 *
 *   client -> chat:send { roomId, body, clientMsgId }   (with an ack callback)
 *   server:  validate -> membership -> rate limit -> persist (idempotent)
 *            -> ack { ok, data: { message, duplicate } } to the sender
 *            -> chat:new message to everyone else in the room
 *
 * Persist BEFORE broadcasting: a message others have seen is always in the
 * history, so a page reload never "loses" something that was on screen.
 *
 * A retry with the same clientMsgId is acknowledged with the stored message
 * and NOT broadcast again, so nobody sees it twice.
 */
const { on } = require('./handler');
const { chatSendPayload } = require('../validators/room');
const { tooManyRequests } = require('../lib/errors');
const chatService = require('../services/chatService');
const { channel } = require('./roomManager');

/**
 * @param {import('socket.io').Socket} socket
 * @param {{ roomManager: import('./roomManager').RoomManager, limiter: { consume(key: string): boolean } }} deps
 */
function registerChat(socket, { roomManager, limiter }) {
  on(socket, 'chat:send', chatSendPayload, async ({ roomId, body, clientMsgId }) => {
    const member = roomManager.requireMember(socket, roomId, 'viewer'); // viewers may chat, not edit
    const userId = socket.data.userId;
    // Keyed by user, not socket, so opening ten tabs doesn't buy ten times the limit.
    if (!limiter.consume(userId)) throw tooManyRequests('RATE_LIMITED', 'You are sending messages too fast');

    const { message, duplicate } = await chatService.sendMessage({
      roomId,
      senderId: userId,
      senderName: member.name,
      body,
      clientMsgId,
    });
    if (!duplicate) {
      socket.to(channel(roomId)).emit('chat:new', message); // everyone but this socket (other tabs included)
      roomManager.touch(roomId);
    }
    return { message, duplicate };
  });
}

module.exports = { registerChat };
