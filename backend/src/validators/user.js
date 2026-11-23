'use strict';

const { z } = require('zod');
const { name } = require('./auth');

/**
 * PATCH /api/users/me: every field optional, at least one required.
 * email and password are deliberately NOT here; they'd need re-verification.
 * Because z.object strips unknown keys, sending { passwordHash: ... } does nothing.
 */
const patchMeBody = z
  .object({
    name: name.optional(),
    favLang: z.string().trim().max(30).nullable().optional(),
    techStack: z.array(z.string().trim().min(1).max(30)).max(20).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'provide at least one field to update');

module.exports = { patchMeBody };
