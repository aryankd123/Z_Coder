'use strict';

const { z } = require('zod');

/**
 * A MongoDB ObjectId as 24 hex characters. Validating ids at the edge means a
 * malformed id is a clean 400 instead of a Mongoose CastError deep inside a
 * query, and it can never be an operator object like { "$gt": "" }.
 */
const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'must be a valid id');

/** "Page size" query parameter: an integer in [1, max], with a default. */
const limit = (max, fallback) => z.coerce.number().int().min(1).max(max).default(fallback);

module.exports = { objectId, limit };
