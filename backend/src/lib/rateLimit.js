'use strict';

/**
 * Rate limiters for the auth endpoints.
 *
 * Two independent limits on login:
 *   1. per IP (login + signup + refresh): stops one machine hammering us.
 *   2. per email, FAILED attempts only: stops password guessing against one
 *      account even when the attacker rotates IPs.
 *      `skipSuccessfulRequests` un-counts any request that ends < 400.
 *
 * Storage: express-rate-limit's default MemoryStore, i.e. counters live in
 * this process. That's correct for one API instance. With several instances
 * behind a load balancer, each would count separately, so you'd pass
 * `store: new RedisStore(...)`. The `store` option is the port; memory vs
 * Redis are the adapters.
 */
const { rateLimit } = require('express-rate-limit');
const { tooManyRequests } = require('./errors');

const FIFTEEN_MINUTES = 15 * 60 * 1000;

/** Route rejections through our error handler so 429s use the standard error shape. */
function rejectWithAppError(_req, _res, next) {
  next(tooManyRequests('RATE_LIMITED', 'Too many attempts, try again later'));
}

/**
 * Build fresh limiters. Called once per app instance, so each test gets clean counters.
 * @param {{ authPerIp: number, loginFailuresPerEmail: number }} limits
 */
function createAuthLimiters(limits) {
  const perIp = rateLimit({
    windowMs: FIFTEEN_MINUTES,
    limit: limits.authPerIp,
    standardHeaders: 'draft-8', // RateLimit / RateLimit-Policy response headers
    legacyHeaders: false,
    handler: rejectWithAppError,
  });

  const loginFailuresPerEmail = rateLimit({
    windowMs: FIFTEEN_MINUTES,
    limit: limits.loginFailuresPerEmail,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    // Runs before validation, so normalise the same way the validator does.
    keyGenerator: (req) => `login:${String(req.body?.email ?? '').trim().toLowerCase()}`,
    handler: rejectWithAppError,
  });

  return { perIp, loginFailuresPerEmail };
}

/**
 * Failed room joins per USER (wrong password, unknown code). It runs after
 * requireAuth, so it keys on the account, not the IP: a campus NAT doesn't
 * lock out a whole hostel, and an attacker can't rotate IPs to keep guessing
 * one room's password.
 * @param {number} limit failures per 15 minutes
 */
function createRoomJoinLimiter(limit) {
  return rateLimit({
    windowMs: FIFTEEN_MINUTES,
    limit,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) => `room-join:${req.auth.userId}`,
    handler: (_req, _res, next) => next(tooManyRequests('RATE_LIMITED', 'Too many failed joins, try again later')),
  });
}

/**
 * Code runs per USER per minute (all runs count, not just failures): each
 * one costs a compiler and CPU time. Runs after requireAuth.
 * @param {number} limit runs per minute
 */
function createExecutionLimiter(limit) {
  return rateLimit({
    windowMs: 60 * 1000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) => `exec:${req.auth.userId}`,
    handler: (_req, _res, next) => next(tooManyRequests('RATE_LIMITED', 'Too many runs; wait a minute and try again')),
  });
}

/**
 * A tiny in-memory fixed-window counter for things that aren't HTTP requests
 * (chat messages over the socket). `consume(key)` returns false once `key`
 * has used up `limit` events in the current window.
 *
 * Fixed window = one counter per key that resets every `windowMs`. It lets
 * a burst of up to 2x the limit straddle a window boundary; that's fine for
 * chat flood control. Like the stores above, it's per process.
 *
 * @param {{ limit: number, windowMs: number, now?: () => number }} options
 */
function createWindowLimiter({ limit, windowMs, now = Date.now }) {
  /** @type {Map<string, { start: number, count: number }>} */
  const windows = new Map();

  function prune(t) {
    for (const [key, w] of windows) if (t - w.start >= windowMs) windows.delete(key);
  }

  return {
    /** @param {string} key @returns {boolean} true if allowed */
    consume(key) {
      const t = now();
      if (windows.size > 10_000) prune(t); // bound memory: drop finished windows
      let w = windows.get(key);
      if (!w || t - w.start >= windowMs) {
        w = { start: t, count: 0 };
        windows.set(key, w);
      }
      w.count += 1;
      return w.count <= limit;
    },
  };
}

module.exports = { createAuthLimiters, createRoomJoinLimiter, createExecutionLimiter, createWindowLimiter };
