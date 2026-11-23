'use strict';

const { badRequest } = require('../lib/errors');

const PARTS = ['params', 'query', 'body'];

/**
 * Validate request input with zod schemas before the controller runs.
 *
 * On success, the PARSED values go on `req.valid = { params, query, body }`.
 * Controllers read only from req.valid, never from req.body directly, so:
 *   - types are guaranteed (an email is a string, not { "$ne": null }), which
 *     blocks MongoDB operator injection;
 *   - unknown keys are stripped (z.object's default), so a client can't
 *     smuggle in fields like `role` or `passwordHash` (mass assignment);
 *   - normalisation such as trim() and toLowerCase() has already happened.
 *
 * On failure: 400 VALIDATION_FAILED, with one entry per problem.
 *
 * (Why not overwrite req.query? In Express 5, req.query is a read-only getter.)
 *
 * @param {{ params?: import('zod').ZodType, query?: import('zod').ZodType, body?: import('zod').ZodType }} schemas
 * @returns {import('express').RequestHandler}
 */
function validate(schemas) {
  return (req, _res, next) => {
    const valid = {};
    const issues = [];
    for (const part of PARTS) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part] ?? {});
      if (result.success) {
        valid[part] = result.data;
      } else {
        for (const issue of result.error.issues) {
          issues.push({ in: part, path: issue.path.join('.'), message: issue.message });
        }
      }
    }
    if (issues.length > 0) {
      return next(badRequest('VALIDATION_FAILED', 'Request validation failed', issues));
    }
    req.valid = valid;
    return next();
  };
}

module.exports = { validate };
