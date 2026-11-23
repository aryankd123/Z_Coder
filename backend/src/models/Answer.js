'use strict';

const { Schema, model, Types } = require('mongoose');

/**
 * answers: one document per answer to a problem.
 *
 * Index: { problemId: 1, _id: -1 }, so "answers to problem P, newest first"
 * is a bounded range scan, and pagination by _id cursor works the same way as
 * chat messages.
 */
const answerSchema = new Schema(
  {
    problemId: { type: Types.ObjectId, ref: 'Problem', required: true },
    authorId: { type: Types.ObjectId, ref: 'User', required: true },
    authorName: { type: String, required: true },
    body: { type: String, required: true, minlength: 1, maxlength: 10000 },
  },
  { timestamps: true },
);

answerSchema.index({ problemId: 1, _id: -1 });

const Answer = model('Answer', answerSchema, 'answers');

module.exports = { Answer };
