'use strict';

const { Schema, model, Types } = require('mongoose');

/**
 * problems: the Q&A board ("ask a problem").
 *
 * Answers live in their own collection (see Answer.js). v1 embedded them, so
 * one popular problem grew without limit and every feed read dragged all its
 * answers along. `answerCount` is a counter kept in sync with $inc, so the
 * feed can show "3 answers" without touching the answers collection.
 *
 * Indexes:
 *   { isPublic: 1, _id: -1 } - the public feed, newest first, cursor-paginated
 *   { authorId: 1, _id: -1 } - "my problems", newest first
 */
const problemSchema = new Schema(
  {
    authorId: { type: Types.ObjectId, ref: 'User', required: true },
    authorName: { type: String, required: true },
    title: { type: String, required: true, trim: true, minlength: 3, maxlength: 150 },
    body: { type: String, required: true, minlength: 10, maxlength: 10000 },
    tags: {
      type: [{ type: String, trim: true, lowercase: true, maxlength: 30 }],
      default: [],
      validate: [(t) => t.length <= 5, 'at most 5 tags'],
    },
    platform: { type: String, trim: true, maxlength: 40, default: null },
    isPublic: { type: Boolean, default: true },
    answerCount: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

problemSchema.index({ isPublic: 1, _id: -1 });
problemSchema.index({ authorId: 1, _id: -1 });

const Problem = model('Problem', problemSchema, 'problems');

module.exports = { Problem };
