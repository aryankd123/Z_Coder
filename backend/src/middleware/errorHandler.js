'use strict';

const { AppError, notFound } = require('../lib/errors');

/**
 * Catch-all for requests that matched no route: 404 with the standard shape.
 * @type {import('express').RequestHandler}
 */
function notFoundHandler(req, _res, next) {
  next(notFound('ROUTE_NOT_FOUND', `No route for ${req.method} ${req.path}`));
}

/**
 * Map known library errors onto AppError. Anything unrecognised becomes a 500
 * with a generic message: internal details (stack traces, Mongo messages)
 * never reach the client.
 * @param {any} err
 * @returns {AppError}
 */
function toAppError(err) {
  if (err instanceof AppError) return err;
  // Thrown by express.json() (body-parser).
  if (err?.type === 'entity.too.large') {
    return new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
  }
  if (err?.type === 'entity.parse.failed') {
    return new AppError(400, 'INVALID_JSON', 'Request body is not valid JSON');
  }
  // MongoDB duplicate key. Services that expect a specific one (EMAIL_TAKEN)
  // catch it themselves; this is the fallback.
  if (err?.code === 11000) {
    return new AppError(409, 'DUPLICATE', 'That resource already exists');
  }
  // Mongoose: a malformed ObjectId, or a schema validator failed.
  if (err?.name === 'CastError') {
    return new AppError(400, 'INVALID_ID', 'Malformed identifier');
  }
  if (err?.name === 'ValidationError') {
    return new AppError(400, 'VALIDATION_FAILED', 'Data failed validation');
  }
  return new AppError(500, 'INTERNAL', 'Something went wrong');
}

/**
 * Central error handler. Express 5 forwards rejected promises from async
 * handlers here automatically, so controllers just `throw`.
 * @type {import('express').ErrorRequestHandler}
 */
function errorHandler(err, req, res, next) {
  const appErr = toAppError(err);
  if (appErr.status >= 500) {
    // Log the ORIGINAL error (with stack) server-side only.
    req.log?.error({ err }, 'unhandled error');
  }
  if (res.headersSent) return next(err);
  const body = { code: appErr.code, message: appErr.message };
  if (appErr.details !== undefined) body.details = appErr.details;
  return res.status(appErr.status).json({ error: body });
}

module.exports = { notFoundHandler, errorHandler, toAppError };
