'use strict';

const express = require('express');
const { authRouter } = require('./auth');
const { usersRouter } = require('./users');
const { roomsRouter } = require('./rooms');
const { executionsRouter } = require('./executions');

/**
 * Everything under /api. New feature routers get mounted here as each phase lands.
 * @param {{ limiters: Record<string, import('express').RequestHandler> }} deps
 */
function apiRouter({ limiters }) {
  const router = express.Router();
  router.use('/auth', authRouter({ limiters }));
  router.use('/users', usersRouter());
  router.use('/rooms', roomsRouter({ limiters }));
  router.use('/executions', executionsRouter({ limiters }));
  return router;
}

module.exports = { apiRouter };
