'use strict';

/**
 * Token service: creates access tokens and manages refresh tokens.
 *
 * Two kinds of token, two different jobs:
 *
 *   ACCESS token: a JWT that lasts 15 min. Sent on every request in
 *     `Authorization: Bearer`. Verified with the secret alone (stateless),
 *     so it CANNOT be revoked early; the short lifetime limits the damage
 *     if one leaks.
 *
 *   REFRESH token: 256 random bits that last 14 days. Lives only in an
 *     httpOnly cookie and is used for one thing: getting a new access token.
 *     It's checked against the database (stateful), so it CAN be revoked
 *     (logout, reuse detection).
 *
 * Rotation: each refresh token is single-use. Using it revokes it and issues
 * a successor in the same family. If a revoked token ever comes back, two
 * parties hold copies (the user and a thief), and we can't tell which is
 * which, so we revoke the whole family and both must log in again.
 */
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { getConfig } = require('../config');
const { RefreshToken } = require('../models');
const { unauthorized } = require('../lib/errors');

/** sha256 hex digest. Fast hashing is fine for high-entropy random tokens. */
function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Sign a short-lived access JWT whose `sub` (subject) is the user id.
 * @param {string | import('mongoose').Types.ObjectId} userId
 * @returns {string}
 */
function signAccessToken(userId) {
  const { jwtAccessSecret, accessTokenTtlSeconds } = getConfig();
  return jwt.sign({}, jwtAccessSecret, {
    algorithm: 'HS256',
    expiresIn: accessTokenTtlSeconds,
    subject: String(userId),
  });
}

/**
 * Create and store a new refresh token. Returns the RAW token (for the
 * cookie); only its hash is stored.
 * @param {import('mongoose').Types.ObjectId | string} userId
 * @param {string} [familyId] pass the parent's family when rotating; omit for a fresh login
 * @returns {Promise<{ raw: string, doc: import('mongoose').Document }>}
 */
async function issueRefreshToken(userId, familyId = crypto.randomUUID()) {
  const raw = crypto.randomBytes(32).toString('base64url'); // 32 bytes = 256 bits
  const doc = await RefreshToken.create({
    userId,
    tokenHash: sha256(raw),
    familyId,
    expiresAt: new Date(Date.now() + getConfig().refreshTokenTtlMs),
  });
  return { raw, doc };
}

/** Revoke every still-active token in a family (one login session's whole lineage). */
async function revokeFamily(familyId) {
  await RefreshToken.updateMany({ familyId, revokedAt: null }, { $set: { revokedAt: new Date() } });
}

/**
 * Exchange a refresh token for a new one (rotation + reuse detection).
 * @param {string | undefined} raw the token from the cookie
 * @returns {Promise<{ raw: string, userId: import('mongoose').Types.ObjectId }>}
 * @throws {import('../lib/errors').AppError} 401 REFRESH_MISSING | REFRESH_INVALID | REFRESH_REUSED | REFRESH_EXPIRED
 */
async function rotateRefreshToken(raw) {
  if (!raw) throw unauthorized('REFRESH_MISSING', 'No refresh token');

  const current = await RefreshToken.findOne({ tokenHash: sha256(raw) });
  if (!current) throw unauthorized('REFRESH_INVALID', 'Refresh token is invalid');

  if (current.revokedAt) {
    // Reuse of an already-rotated token: assume theft, kill the family.
    await revokeFamily(current.familyId);
    throw unauthorized('REFRESH_REUSED', 'Session was revoked; please log in again');
  }
  if (current.expiresAt <= new Date()) {
    throw unauthorized('REFRESH_EXPIRED', 'Session expired; please log in again');
  }

  // Claim the token atomically. If two requests race with the same token,
  // only one update can match `revokedAt: null`; the loser sees null and is
  // treated as reuse. (Our frontend serialises refreshes across tabs with
  // the Web Locks API, so a legitimate client never races itself.)
  const claimed = await RefreshToken.findOneAndUpdate(
    { _id: current._id, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
  if (!claimed) {
    await revokeFamily(current.familyId);
    throw unauthorized('REFRESH_REUSED', 'Session was revoked; please log in again');
  }

  const next = await issueRefreshToken(current.userId, current.familyId);
  await RefreshToken.updateOne({ _id: current._id }, { $set: { replacedBy: next.doc._id } });
  return { raw: next.raw, userId: current.userId };
}

/**
 * Logout: revoke the family of the presented token. Unknown tokens are
 * ignored, so logout always "succeeds".
 * @param {string | undefined} raw
 */
async function revokeRefreshToken(raw) {
  if (!raw) return;
  const current = await RefreshToken.findOne({ tokenHash: sha256(raw) }).lean();
  if (current) await revokeFamily(current.familyId);
}

module.exports = { signAccessToken, issueRefreshToken, rotateRefreshToken, revokeRefreshToken, sha256 };
