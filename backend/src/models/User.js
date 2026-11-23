'use strict';

const { Schema, model } = require('mongoose');

/**
 * users: one document per account.
 *
 * Index: { email: 1 } UNIQUE.
 *   - Serves login: findOne({ email }) is a single index lookup.
 *   - Makes signup race-safe. Two concurrent signups with the same email can
 *     both pass any "does it exist?" check in code, but only one insert can
 *     win the unique index; the other gets duplicate-key error 11000, which
 *     we turn into 409 EMAIL_TAKEN.
 */
const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 1, maxlength: 60 },
    // `lowercase` + `trim` normalise before saving, so A@x.com and a@x.com
    // can't become two accounts.
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254, unique: true },
    // `select: false`: never loaded unless a query explicitly asks for
    // '+passwordHash' (only login does). v1 leaked hashes through populate().
    passwordHash: { type: String, required: true, select: false },
    favLang: { type: String, trim: true, maxlength: 30 },
    techStack: {
      type: [{ type: String, trim: true, maxlength: 30 }],
      default: [],
      validate: [(arr) => arr.length <= 20, 'techStack can have at most 20 entries'],
    },
  },
  { timestamps: true },
);

// Safety net: even a full document never serialises its hash.
userSchema.set('toJSON', {
  versionKey: false,
  transform(_doc, ret) {
    delete ret.passwordHash;
    return ret;
  },
});

/**
 * The public shape of a user: an allowlist, so new private fields don't leak
 * by default. Works with both hydrated documents and .lean() objects.
 * @param {{ _id: unknown, name: string, email: string, favLang?: string, techStack?: string[], createdAt?: Date }} u
 */
function toPublicUser(u) {
  return {
    id: String(u._id),
    name: u.name,
    email: u.email,
    favLang: u.favLang ?? null,
    techStack: u.techStack ?? [],
    createdAt: u.createdAt,
  };
}

const User = model('User', userSchema, 'users');

module.exports = { User, toPublicUser };
