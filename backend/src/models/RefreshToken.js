'use strict';

const { Schema, model, Types } = require('mongoose');

/**
 * refreshTokens: one document per refresh token ever issued.
 *
 * We store sha256(token), never the token itself. If the database leaks, the
 * hashes can't be replayed as cookies. sha256 (not bcrypt) is fine here
 * because the token is 256 random bits, so there is nothing to brute-force.
 *
 * familyId: every token descended from one login shares a familyId. If a
 * token that was already rotated (revokedAt set) is presented again, someone
 * kept an old copy, so we revoke the WHOLE family and that login session dies
 * everywhere. That's reuse detection.
 *
 * Indexes:
 *   { tokenHash: 1 } UNIQUE   - refresh/logout look up by hash (one index hit)
 *   { familyId: 1 }           - "revoke this family" is an updateMany on familyId
 *   { userId: 1 }             - future "log out all my devices"
 *   { expiresAt: 1 } TTL 0    - MongoDB deletes each doc once expiresAt passes.
 *     The TTL monitor runs about every 60 s, so code must STILL check
 *     expiresAt itself; the TTL index is cleanup, not enforcement.
 */
const refreshTokenSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    familyId: { type: String, required: true, index: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    replacedBy: { type: Types.ObjectId, ref: 'RefreshToken', default: null },
  },
  { timestamps: true },
);

refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const RefreshToken = model('RefreshToken', refreshTokenSchema, 'refreshTokens');

module.exports = { RefreshToken };
