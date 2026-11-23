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

module.exports = { createAuthLimiters };
