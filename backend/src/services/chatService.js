'use strict';

/**
 * Chat service: persist a message idempotently, and read history a page at a time.
 * Used by the socket handler (chat:send) and the REST history endpoints.
 */
const { Message } = require('../models/Message');

/** What a client may see of a message. */
const MESSAGE_PROJECTION = { roomId: 1, senderId: 1, senderName: 1, body: 1, clientMsgId: 1, createdAt: 1 };

/** @param {any} m a message document or lean object */
function toPublicMessage(m) {
  return {
    id: String(m._id),
    roomId: String(m.roomId),
    senderId: String(m.senderId),
    senderName: m.senderName,
    body: m.body,
    clientMsgId: m.clientMsgId,
    createdAt: m.createdAt,
  };
}

/**
 * Store a chat message exactly once.
 *
 * The client invents clientMsgId once per message and reuses it on every
 * retry (say the ack was lost on a flaky connection). The unique index on
 * { roomId, senderId, clientMsgId } turns a retried insert into duplicate-key
 * error 11000; we catch it and return the message that is already stored.
 * There's no "check, then insert" step to race on: the index decides.
 *
 * @param {{ roomId: string, senderId: string, senderName: string, body: string, clientMsgId: string }} input
 * @returns {Promise<{ message: ReturnType<typeof toPublicMessage>, duplicate: boolean }>}
 */
async function sendMessage({ roomId, senderId, senderName, body, clientMsgId }) {
  try {
    const doc = await Message.create({ roomId, senderId, senderName, body, clientMsgId });
    return { message: toPublicMessage(doc), duplicate: false };
  } catch (err) {
    if (err?.code !== 11000) throw err;
    const existing = await Message.findOne({ roomId, senderId, clientMsgId }, MESSAGE_PROJECTION).lean();
    if (!existing) throw err;
    return { message: toPublicMessage(existing), duplicate: true };
  }
}

/**
 * One page of history, newest page first, returned oldest-to-newest for display.
 *
 * Cursor pagination on _id: "give me `limit` messages older than `before`".
 * With the { roomId: 1, _id: -1 } index, MongoDB seeks straight to the cursor
 * and reads `limit + 1` index entries, however long the chat is. (skip/limit
 * would walk every skipped entry, and new messages would shift the pages.)
 * We fetch one extra row only to learn whether an older page exists.
 *
 * @param {string | import('mongoose').Types.ObjectId} roomId
 * @param {{ before?: string, limit?: number }} [options]
 * @returns {Promise<{ messages: ReturnType<typeof toPublicMessage>[], hasMore: boolean, nextCursor: string | null }>}
 */
async function listMessages(roomId, { before, limit = 50 } = {}) {
  const filter = { roomId };
  if (before) filter._id = { $lt: before };
  const docs = await Message.find(filter, MESSAGE_PROJECTION).sort({ _id: -1 }).limit(limit + 1).lean();
  const hasMore = docs.length > limit;
  const page = docs.slice(0, limit).reverse().map(toPublicMessage);
  return { messages: page, hasMore, nextCursor: hasMore ? page[0].id : null };
}

module.exports = { sendMessage, listMessages, toPublicMessage };
