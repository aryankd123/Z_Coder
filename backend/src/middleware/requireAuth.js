'use strict';

/**
 * Stateless JWT authentication.
 *
 * "Stateless" means we decide who the caller is from the token ALONE: no
 * MongoDB query, no session store, no cache. Any API instance holding the
 * signing secret can authenticate any request, which is what lets the API
 * scale horizontally without shared session state.
 *
 * How access tokens are made (src/services/tokenService.js):
 *     jwt.sign({}, secret, { algorithm: 'HS256', expiresIn, subject: userId })
 * so a valid payload looks like { sub: '<userId>', iat, exp }.
 *
 * Error codes (all 401):
 *   AUTH_MISSING - no "Authorization: Bearer <token>" header
 *   AUTH_EXPIRED - signature fine, but `exp` has passed. The client should
 *                  refresh and retry (lib/api.js does this automatically).
 *   AUTH_INVALID - anything else: bad signature, garbage, wrong algorithm,
 *                  missing `sub`. Never retried blindly.
 *
 * Contract tests: test/requireAuth.test.js
 */
const jwt = require('jsonwebtoken');
const { getConfig } = require('../config');
const { unauthorized } = require('../lib/errors');

// RFC 7235: the auth scheme is case-insensitive. Exactly one token after it.
const BEARER = /^Bearer\s+(\S+)$/i;

/**
 * Verify an access JWT without any database access.
 * Reused by the Socket.IO handshake (Phase 2), which is why it's separate
 * from the middleware.
 *
 * @param {string} token the raw JWT (no "Bearer " prefix)
 * @returns {{ userId: string }}
 * @throws {import('../lib/errors').AppError} 401 AUTH_EXPIRED or AUTH_INVALID
 */
function verifyAccessToken(token) {
  let payload;
  try {
    // `algorithms` is the important option. A JWT's header names its own
    // algorithm; without this allowlist a forged token could say
    // "alg: none" (no signature) or switch algorithms (algorithm confusion).
    // The SERVER decides the algorithm, never the token.
    payload = jwt.verify(token, getConfig().jwtAccessSecret, { algorithms: ['HS256'] });
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw unauthorized('AUTH_EXPIRED', 'Access token has expired');
    }
    // Deliberately generic: never echo the token, the secret or the library's message.
    throw unauthorized('AUTH_INVALID', 'Access token is invalid');
  }

  // A correctly signed token that doesn't say WHO it's for is useless.
  if (typeof payload !== 'object' || typeof payload.sub !== 'string' || payload.sub === '') {
    throw unauthorized('AUTH_INVALID', 'Access token is invalid');
  }
  return { userId: payload.sub };
}

/**
 * Express middleware: authenticate the request from its Bearer token and set
 * req.auth = { userId }. Errors go to the central error handler via next(err).
 * @type {import('express').RequestHandler}
 */
function requireAuth(req, _res, next) {
  const match = BEARER.exec(req.get('authorization') ?? '');
  if (!match) {
    return next(unauthorized('AUTH_MISSING', 'Authorization: Bearer <token> header is required'));
  }
  try {
    req.auth = verifyAccessToken(match[1]);
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { requireAuth, verifyAccessToken };
