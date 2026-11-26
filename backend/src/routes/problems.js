'use strict';

const express = require('express');
const problems = require('../controllers/problemController');
const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/requireAuth');
const v = require('../validators/problem');

/** /api/problems/*: the Q&A board. Logged-in users only (v1 left answers open to anyone). */
function problemsRouter() {
  const router = express.Router();
  router.use(requireAuth);
  router.get('/', validate({ query: v.listProblemsQuery }), problems.list);
  router.post('/', validate({ body: v.createProblemBody }), problems.create);
  router.get('/:id', validate({ params: v.problemParams }), problems.get);
  router.get('/:id/answers', validate({ params: v.problemParams, query: v.listAnswersQuery }), problems.listAnswers);
  router.post('/:id/answers', validate({ params: v.problemParams, body: v.createAnswerBody }), problems.addAnswer);
  return router;
}

module.exports = { problemsRouter };
