'use strict';

const { z } = require('zod');
const { objectId, limit } = require('./common');
const { LANGUAGE_IDS } = require('../execution/languages');
const { MAX_SOURCE_BYTES } = require('../models/Submission');

/** A string of at most `max` BYTES (UTF-8), the unit the limits are defined in. */
const boundedBytes = (max, what) =>
  z.string().refine((s) => Buffer.byteLength(s, 'utf8') <= max, `${what} must be at most ${max / 1024} KB`);

const createExecutionBody = z.object({
  // Omitted = a private run; present = the room's shared console (members only).
  roomId: objectId.optional(),
  language: z.enum(LANGUAGE_IDS),
  source: boundedBytes(MAX_SOURCE_BYTES, 'source').refine((s) => s.trim().length > 0, 'source is empty'),
  stdin: boundedBytes(MAX_SOURCE_BYTES, 'stdin').default(''),
});

const executionParams = z.object({ id: objectId });

const roomExecutionsQuery = z.object({
  before: objectId.optional(),
  limit: limit(50, 10),
});

module.exports = { createExecutionBody, executionParams, roomExecutionsQuery };
