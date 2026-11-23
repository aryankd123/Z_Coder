'use strict';

const express = require('express');
const { authRouter } = require('./auth');
const { usersRouter } = require('./users');

/**
 * Everything under /api. New feature routers (rooms, executions, problems)
 * get mounted here as each phase lands.
 * @param {{ limiters: ReturnType<typeof import('../lib/rateLimit').createAuthLimiters> }} deps
 */
function apiRouter({ limiters }) {
  const router = express.Router();
  router.use('/auth', authRouter({ limiters }));
  router.use('/users', usersRouter());
  return router;
}

module.exports = { apiRouter };
