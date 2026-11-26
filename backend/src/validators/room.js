'use strict';

/**
 * zod schemas for rooms, membership and chat, over REST and over the socket.
 * Socket payloads get validated exactly like HTTP bodies: a socket event is
 * just another edge where untrusted input enters the server.
 */
const { z } = require('zod');
const { objectId, limit } = require('./common');
const { LANGUAGE_IDS } = require('../execution/languages');

const roomName = z.string().trim().min(1, 'is required').max(60);

/**
 * Optional room password. An empty string (a blank form field) means "no
 * password". Like account passwords, at most 72 BYTES, because bcrypt ignores
 * everything after that.
 */
const roomPassword = z.preprocess(
  (v) => (v === '' || v === null ? undefined : v),
  z
    .string()
    .min(4, 'must be at least 4 characters')
    .refine((p) => Buffer.byteLength(p, 'utf8') <= 72, 'must be at most 72 bytes')
    .optional(),
);

/** Codes are upper-case; accept what people type ("k7qh 2mxa" style slips aside). */
const inviteCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{6,12}$/, 'must be a room code like K7QH2MXA');

const createRoomBody = z.object({
  name: roomName,
  password: roomPassword,
  language: z.enum(LANGUAGE_IDS).default('javascript'),
});

const joinRoomBody = z.object({
  inviteCode,
  // Not the creation policy, just a size bound: a wrong password fails bcrypt anyway.
  password: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.string().max(200).optional()),
});

const listRoomsQuery = z.object({
  limit: limit(50, 20),
  // Cursor: the lastActiveAt of the last room on the previous page.
  before: z.iso.datetime({ offset: true }).optional(),
});

const roomParams = z.object({ roomId: objectId });
const memberParams = z.object({ roomId: objectId, userId: objectId });

const messagesQuery = z.object({
  // Cursor: the id of the oldest message the client already has.
  before: objectId.optional(),
  limit: limit(100, 50),
});

const patchMemberBody = z.object({
  // 'owner' is not assignable: ownership transfer isn't supported.
  role: z.enum(['viewer', 'editor']),
});

// ---- Socket.IO payloads -------------------------------------------------

const socketRoomRef = z.object({ roomId: objectId });

const chatSendPayload = z.object({
  roomId: objectId,
  body: z.string().trim().min(1, 'is required').max(2000, 'must be at most 2000 characters'),
  // Generated once per message by the client and reused on retries (idempotency key).
  clientMsgId: z.string().regex(/^[\w-]{1,64}$/, 'must be 1-64 letters, digits, _ or -'),
});

const authRenewPayload = z.object({ token: z.string().min(1).max(4096) });

module.exports = {
  createRoomBody,
  joinRoomBody,
  listRoomsQuery,
  roomParams,
  memberParams,
  messagesQuery,
  patchMemberBody,
  socketRoomRef,
  chatSendPayload,
  authRenewPayload,
};
