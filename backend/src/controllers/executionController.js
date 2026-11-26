'use strict';

/**
 * Execution controllers. The service lives on req.app.locals.execution
 * (built in server.js with the configured queue and executor). When an app
 * is built without one (REST-only tests), every route answers 503.
 */
const { AppError } = require('../lib/errors');

function service(req) {
  const execution = req.app.locals.execution;
  if (!execution) throw new AppError(503, 'EXECUTION_UNAVAILABLE', 'Code execution is not available');
  return execution;
}

/** POST /api/executions -> 202 { execution } (queued; results arrive via execution:update or polling) */
async function create(req, res) {
  const execution = await service(req).submit(req.auth.userId, req.valid.body);
  res.status(202).location(`/api/executions/${execution.id}`).json({ execution });
}

/** GET /api/executions/:id -> 200 { execution } (with source and stdin) */
async function get(req, res) {
  res.json({ execution: await service(req).get(req.auth.userId, req.valid.params.id) });
}

/** GET /api/rooms/:roomId/executions -> 200 { executions, nextCursor } (requireRoomMember first) */
async function listForRoom(req, res) {
  res.json(await service(req).listForRoom(req.room._id, req.valid.query));
}

module.exports = { create, get, listForRoom };
