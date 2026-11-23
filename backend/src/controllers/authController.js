'use strict';

/**
 * Auth controllers: the HTTP layer only. They read validated input from
 * req.valid, call the service, and decide status codes and cookies.
 *
 * Express 5 passes errors from async handlers to the error handler, so
 * there's no try/catch boilerplate here (except where we need cleanup).
 */
const authService = require('../services/authService');
const userService = require('../services/userService');
const { getConfig } = require('../config');

/** Cookie holding the refresh token. */
const REFRESH_COOKIE = 'zc_rt';

/**
 * httpOnly  - page JavaScript can't read it, so an XSS bug can't steal it.
 * secure    - only sent over HTTPS (production).
 * sameSite  - 'lax': not sent on cross-site POSTs, which blocks CSRF against
 *             /refresh and /logout.
 * path      - only sent to /api/auth/*, not with every API call.
 */
function refreshCookieOptions() {
  const { cookieSecure, refreshTokenTtlMs } = getConfig();
  return { httpOnly: true, secure: cookieSecure, sameSite: 'lax', path: '/api/auth', maxAge: refreshTokenTtlMs };
}

function setRefreshCookie(res, rawToken) {
  res.cookie(REFRESH_COOKIE, rawToken, refreshCookieOptions());
}

function clearRefreshCookie(res) {
  const { maxAge: _maxAge, ...options } = refreshCookieOptions();
  res.clearCookie(REFRESH_COOKIE, options); // must match path/flags, or the browser keeps it
}

/** POST /api/auth/signup -> 201 { user, accessToken } + refresh cookie */
async function signup(req, res) {
  const { user, accessToken, refreshToken } = await authService.signup(req.valid.body);
  setRefreshCookie(res, refreshToken);
  res.status(201).json({ user, accessToken });
}

/** POST /api/auth/login -> 200 { user, accessToken } + refresh cookie */
async function login(req, res) {
  const { user, accessToken, refreshToken } = await authService.login(req.valid.body);
  setRefreshCookie(res, refreshToken);
  res.json({ user, accessToken });
}

/** POST /api/auth/refresh (cookie) -> 200 { user, accessToken } + rotated cookie */
async function refresh(req, res) {
  try {
    const { user, accessToken, refreshToken } = await authService.refresh(req.cookies?.[REFRESH_COOKIE]);
    setRefreshCookie(res, refreshToken);
    res.json({ user, accessToken });
  } catch (err) {
    // A rejected refresh token is dead; tell the browser to drop it. Only on
    // 401: a transient 500 (DB hiccup) must not log the user out.
    if (err?.status === 401) clearRefreshCookie(res);
    throw err;
  }
}

/** POST /api/auth/logout -> 204, revokes the session's token family */
async function logout(req, res) {
  await authService.logout(req.cookies?.[REFRESH_COOKIE]);
  clearRefreshCookie(res);
  res.status(204).end();
}

/** GET /api/auth/me (requireAuth) -> 200 { user } */
async function me(req, res) {
  res.json({ user: await userService.getUser(req.auth.userId) });
}

module.exports = { signup, login, refresh, logout, me, REFRESH_COOKIE };
