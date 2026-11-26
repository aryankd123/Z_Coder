'use strict';

const express = require('express');
const executions = require('../controllers/executionController');
const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/requireAuth');
const { createExecutionBody, executionParams } = require('../validators/execution');

/**
 * /api/executions/*: authenticated; creating a run is rate-limited per user.
 * Order on POST: auth -> rate limit -> validate (size limits) -> controller.
 * @param {{ limiters: { executionsPerUser: import('express').RequestHandler } }} deps
 */
function executionsRouter({ limiters }) {
  const router = express.Router();
  router.use(requireAuth);
  router.post('/', limiters.executionsPerUser, validate({ body: createExecutionBody }), executions.create);
  router.get('/:id', validate({ params: executionParams }), executions.get);
  return router;
}

module.exports = { executionsRouter };
