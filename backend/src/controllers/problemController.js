'use strict';

const problems = require('../services/problemService');

/** POST /api/problems -> 201 { problem } */
async function create(req, res) {
  res.status(201).json({ problem: await problems.createProblem(req.auth.userId, req.valid.body) });
}

/** GET /api/problems?scope=public|mine&before=&limit= -> 200 { problems, nextCursor } */
async function list(req, res) {
  res.json(await problems.listProblems(req.auth.userId, req.valid.query));
}

/** GET /api/problems/:id -> 200 { problem, answers, nextCursor } */
async function get(req, res) {
  res.json(await problems.getProblem(req.auth.userId, req.valid.params.id));
}

/** GET /api/problems/:id/answers?before=&limit= -> 200 { answers, nextCursor } */
async function listAnswers(req, res) {
  res.json(await problems.listAnswers(req.auth.userId, req.valid.params.id, req.valid.query));
}

/** POST /api/problems/:id/answers -> 201 { answer } */
async function addAnswer(req, res) {
  res.status(201).json({ answer: await problems.addAnswer(req.auth.userId, req.valid.params.id, req.valid.body) });
}

module.exports = { create, list, get, listAnswers, addAnswer };
