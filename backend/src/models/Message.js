'use strict';

const { Schema, model, Types } = require('mongoose');

/**
 * messages: chat history. This is its own collection (v1 pushed IDs into an
 * ever-growing array on the room) because chat grows without limit, and an
 * embedded array would eventually hit MongoDB's 16 MB document cap.
 *
 * Indexes:
 *   { roomId: 1, _id: -1 }
 *     - "last 50 messages in room R":
 *         find({ roomId: R }).sort({ _id: -1 }).limit(50)
 *     - "50 older than cursor C":
 *         find({ roomId: R, _id: { $lt: C } }).sort({ _id: -1 }).limit(50)
 *       Both are a bounded range scan: MongoDB reads exactly 50 index entries,
 *       however many messages the room has. _id works as the cursor because
 *       ObjectIds start with a timestamp (time-ordered) and are unique (no ties).
 *   { roomId: 1, senderId: 1, clientMsgId: 1 } UNIQUE
 *     - Idempotent sends. The client generates clientMsgId once per message
 *       and reuses it on retry, so a retried send hits the unique index and
 *       is stored once.
 *
 * senderName is denormalised (copied at send time), so history renders
 * without a users lookup. It is deliberately NOT updated on rename: a message
 * shows the name the sender had when they sent it.
 */
const messageSchema = new Schema(
  {
    roomId: { type: Types.ObjectId, ref: 'Room', required: true },
    senderId: { type: Types.ObjectId, ref: 'User', required: true },
    senderName: { type: String, required: true },
    body: { type: String, required: true, minlength: 1, maxlength: 2000 },
    clientMsgId: { type: String, required: true, maxlength: 64 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

messageSchema.index({ roomId: 1, _id: -1 });
messageSchema.index({ roomId: 1, senderId: 1, clientMsgId: 1 }, { unique: true });

const Message = model('Message', messageSchema, 'messages');

module.exports = { Message };
