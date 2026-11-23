'use strict';

const express = require('express');
const cookieParser = require('cookie-parser');
const auth = require('../controllers/authController');
const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/requireAuth');
const { signupBody, loginBody } = require('../validators/auth');

/**
 * /api/auth/*: the only routes reachable without an access token (besides
 * health checks). Each route reads like a pipeline: limit -> validate -> handle.
 *
 * /refresh isn't rate-limited per IP: it needs a valid 256-bit cookie, which
 * can't be guessed, and campus networks put hundreds of users behind one NAT IP.
 *
 * @param {{ limiters: ReturnType<typeof import('../lib/rateLimit').createAuthLimiters> }} deps
 */
function authRouter({ limiters }) {
  const router = express.Router();
  router.use(cookieParser()); // only this router needs cookies (the refresh token)

  router.post('/signup', limiters.perIp, validate({ body: signupBody }), auth.signup);
  router.post(
    '/login',
    limiters.perIp,
    limiters.loginFailuresPerEmail,
    validate({ body: loginBody }),
    auth.login,
  );
  router.post('/refresh', auth.refresh);
  router.post('/logout', auth.logout);
  router.get('/me', requireAuth, auth.me);

  return router;
}

module.exports = { authRouter };
