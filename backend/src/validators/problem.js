'use strict';

const { z } = require('zod');
const { objectId, limit } = require('./common');

/** "dp, Graphs ,dp" -> ['dp', 'graphs']: trimmed, lower-cased, unique, at most 5. */
const tags = z
  .array(z.string().trim().toLowerCase().min(1).max(30))
  .max(5, 'at most 5 tags')
  .default([])
  .transform((t) => [...new Set(t)]);

const createProblemBody = z.object({
  title: z.string().trim().min(3, 'must be at least 3 characters').max(150),
  body: z.string().trim().min(10, 'must be at least 10 characters').max(10000),
  tags,
  // Where the problem is from, e.g. "LeetCode" or "Codeforces 1520D".
  platform: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.string().trim().max(40).optional()),
  isPublic: z.boolean().default(true),
});

const listProblemsQuery = z.object({
  // public (default) = the public feed; mine = my problems, public or private
  scope: z.enum(['public', 'mine']).default('public'),
  before: objectId.optional(),
  limit: limit(50, 20),
});

const problemParams = z.object({ id: objectId });

const createAnswerBody = z.object({ body: z.string().trim().min(1, 'is required').max(10000) });

const listAnswersQuery = z.object({ before: objectId.optional(), limit: limit(50, 20) });

module.exports = { createProblemBody, listProblemsQuery, problemParams, createAnswerBody, listAnswersQuery };
