'use strict';

/**
 * The Q&A board, ported from v1 and fixed:
 *   - answers are their own collection (v1 embedded them in the problem,
 *     so a popular problem grew without limit and every feed read dragged
 *     all its answers along);
 *   - identity (author) comes from the token, never from the body (v1 took
 *     answer.user_id from the request);
 *   - every list is cursor-paginated on _id over an index built for it.
 *
 * Visibility: a public problem is visible to every logged-in user; a
 * private one only to its author (anyone else gets 404, as for rooms).
 */
const { Problem } = require('../models/Problem');
const { Answer } = require('../models/Answer');
const { User } = require('../models/User');
const { notFound } = require('../lib/errors');

const EXCERPT_CHARS = 280;

/** @param {any} p @param {{ full?: boolean }} [options] full = whole body, otherwise an excerpt */
function toPublicProblem(p, { full = false } = {}) {
  const body = full || p.body.length <= EXCERPT_CHARS ? p.body : `${p.body.slice(0, EXCERPT_CHARS).trimEnd()}…`;
  return {
    id: String(p._id),
    authorId: String(p.authorId),
    authorName: p.authorName,
    title: p.title,
    body,
    tags: p.tags ?? [],
    platform: p.platform ?? null,
    isPublic: p.isPublic,
    answerCount: p.answerCount ?? 0,
    createdAt: p.createdAt,
  };
}

/** @param {any} a */
function toPublicAnswer(a) {
  return { id: String(a._id), problemId: String(a.problemId), authorId: String(a.authorId), authorName: a.authorName, body: a.body, createdAt: a.createdAt };
}

async function authorName(userId) {
  const user = await User.findById(userId, { name: 1 }).lean();
  if (!user) throw notFound('USER_NOT_FOUND', 'Account not found');
  return user.name;
}

/** Cursor page helper: fetch limit+1 newest-first rows, report the next cursor. */
async function page(model, filter, { before, limit }, map) {
  const query = before ? { ...filter, _id: { $lt: before } } : filter;
  const docs = await model.find(query).sort({ _id: -1 }).limit(limit + 1).lean();
  const items = docs.slice(0, limit).map(map);
  return { items, nextCursor: docs.length > limit ? items.at(-1).id : null };
}

/**
 * @param {string} userId
 * @param {{ title: string, body: string, tags: string[], platform?: string, isPublic: boolean }} input validated
 */
async function createProblem(userId, input) {
  const problem = await Problem.create({ ...input, authorId: userId, authorName: await authorName(userId) });
  return toPublicProblem(problem.toObject(), { full: true });
}

/**
 * The public feed ({ isPublic: 1, _id: -1 } index) or my problems
 * ({ authorId: 1, _id: -1 } index), newest first.
 * @param {string} userId
 * @param {{ scope: 'public' | 'mine', before?: string, limit: number }} query
 */
async function listProblems(userId, { scope, before, limit }) {
  const filter = scope === 'mine' ? { authorId: userId } : { isPublic: true };
  const { items, nextCursor } = await page(Problem, filter, { before, limit }, (p) => toPublicProblem(p));
  return { problems: items, nextCursor };
}

/** Load a problem the caller may see, or 404. */
async function findVisibleProblem(userId, id) {
  const problem = await Problem.findById(id).lean();
  if (!problem || (!problem.isPublic && String(problem.authorId) !== userId)) {
    throw notFound('PROBLEM_NOT_FOUND', 'Problem not found');
  }
  return problem;
}

/**
 * A problem with the newest page of answers: 2 indexed queries
 * (problem by _id, answers by { problemId, _id }).
 */
async function getProblem(userId, id) {
  const problem = await findVisibleProblem(userId, id);
  const answers = await page(Answer, { problemId: problem._id }, { limit: 20 }, toPublicAnswer);
  return { problem: toPublicProblem(problem, { full: true }), answers: answers.items, nextCursor: answers.nextCursor };
}

/** @param {string} userId @param {string} id @param {{ before?: string, limit: number }} query */
async function listAnswers(userId, id, query) {
  const problem = await findVisibleProblem(userId, id);
  const { items, nextCursor } = await page(Answer, { problemId: problem._id }, query, toPublicAnswer);
  return { answers: items, nextCursor };
}

/**
 * Post an answer and bump the problem's answerCount.
 *
 * Two writes to two collections, without a transaction (MongoDB transactions
 * need a replica set; the dev database is standalone). If the process died
 * between them, answerCount would be one short; it's a display counter, and
 * countDocuments({ problemId }) can always rebuild it. The answer itself is
 * never lost.
 */
async function addAnswer(userId, id, { body }) {
  const problem = await findVisibleProblem(userId, id);
  const answer = await Answer.create({ problemId: problem._id, authorId: userId, authorName: await authorName(userId), body });
  await Problem.updateOne({ _id: problem._id }, { $inc: { answerCount: 1 } });
  return toPublicAnswer(answer);
}

module.exports = { createProblem, listProblems, getProblem, listAnswers, addAnswer, toPublicProblem, EXCERPT_CHARS };
