'use strict';

/**
 * zod schemas for the auth endpoints.
 *
 * Normalisation (trim, lowercase) happens here, at the edge, so everything
 * downstream can assume clean values.
 */
const { z } = require('zod');

const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email({ error: 'must be a valid email address' }));

const name = z.string().trim().min(1, 'is required').max(60);

/**
 * bcrypt only looks at the first 72 BYTES of a password. Anything after that
 * is silently ignored, so "a"*72 + "X" and "a"*72 + "Y" would hash the same.
 * We reject longer passwords instead of truncating them silently. The limit
 * is in bytes, not characters: an emoji is 4 bytes in UTF-8.
 */
const newPassword = z
  .string()
  .min(8, 'must be at least 8 characters')
  .refine((p) => Buffer.byteLength(p, 'utf8') <= 72, 'must be at most 72 bytes');

const signupBody = z.object({ name, email, password: newPassword });

// Login doesn't re-apply the password policy (it may have changed since the
// account was created); it only bounds the size.
const loginBody = z.object({ email, password: z.string().min(1, 'is required').max(200) });

module.exports = { signupBody, loginBody, email, name };
