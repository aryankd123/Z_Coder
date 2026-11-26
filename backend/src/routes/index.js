'use strict';

const express = require('express');
const { authRouter } = require('./auth');
const { usersRouter } = require('./users');
const { roomsRouter } = require('./rooms');

/**
 * Everything under /api. New feature routers (executions, problems) get
 * mounted here as each phase lands.
 * @param {{ limiters: Record<string, import('express').RequestHandler> }} deps
 */
function apiRouter({ limiters }) {
  const router = express.Router();
  router.use('/auth', authRouter({ limiters }));
  router.use('/users', usersRouter());
  router.use('/rooms', roomsRouter({ limiters }));
  return router;
}

module.exports = { apiRouter };
