'use strict';

/**
 * One error type for everything the API reports on purpose.
 *
 * Throw an AppError anywhere (service, middleware, controller) and the central
 * error handler turns it into the response
 *   { error: { code, message, details? } }
 * with the right HTTP status. `code` is a stable, machine-readable string
 * (e.g. EMAIL_TAKEN) that the frontend can branch on. `message` is for humans.
 */
class AppError extends Error {
  /**
   * @param {number} status HTTP status code (400, 401, 403, 404, 409, 413, 429, 500...)
   * @param {string} code stable UPPER_SNAKE error code
   * @param {string} message human-readable explanation, safe to show to users
   * @param {unknown} [details] optional extra data, e.g. validation issues
   */
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// Small helpers so call sites read like prose: throw unauthorized('AUTH_MISSING', '...').
const badRequest = (code, message, details) => new AppError(400, code, message, details);
const unauthorized = (code, message) => new AppError(401, code, message);
const forbidden = (code, message) => new AppError(403, code, message);
const notFound = (code = 'NOT_FOUND', message = 'Not found') => new AppError(404, code, message);
const conflict = (code, message) => new AppError(409, code, message);
const tooManyRequests = (code = 'RATE_LIMITED', message = 'Too many requests, try again later') =>
  new AppError(429, code, message);

module.exports = { AppError, badRequest, unauthorized, forbidden, notFound, conflict, tooManyRequests };
