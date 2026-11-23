'use strict';

/**
 * Stateless JWT authentication (not implemented yet; the contract is pinned
 * by test/requireAuth.test.js).
 *
 * 1) verifyAccessToken(token) -> { userId }
 *    - HS256 only; signature and expiry checked with getConfig().jwtAccessSecret.
 *    - Expired -> 401 AUTH_EXPIRED; anything else wrong -> 401 AUTH_INVALID.
 *    - Never put the token or the secret in an error message or a log line.
 *    Separate from the middleware so the Socket.IO handshake can reuse it.
 *
 * 2) requireAuth(req, res, next)
 *    - Needs `Authorization: Bearer <token>`, otherwise 401 AUTH_MISSING.
 *    - Sets req.auth = { userId } and calls next(); errors go to next(error).
 *    - No MongoDB access.
 *
 * Until this is written, every protected route answers 501 NOT_IMPLEMENTED.
 */
const { AppError } = require('../lib/errors');

const notImplemented = () =>
  new AppError(501, 'NOT_IMPLEMENTED', 'requireAuth is not implemented yet');

/**
 * Verify an access JWT without any database access.
 * @param {string} _token the raw JWT (no "Bearer " prefix)
 * @returns {{ userId: string }}
 * @throws {import('../lib/errors').AppError} 401 AUTH_EXPIRED or AUTH_INVALID
 */
function verifyAccessToken(_token) {
  throw notImplemented();
}

/**
 * Express middleware: authenticate the request from its Bearer token.
 * Sets req.auth = { userId } on success.
 * @type {import('express').RequestHandler}
 */
function requireAuth(_req, _res, next) {
  next(notImplemented());
}

module.exports = { requireAuth, verifyAccessToken };
