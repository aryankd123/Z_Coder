'use strict';

const request = require('supertest');
const mongoose = require('mongoose');
const { createApp } = require('../src/app');
const { Problem, Answer } = require('../src/models');
const { EXCERPT_CHARS } = require('../src/services/problemService');
const { setupTestDb, resetTestDb, teardownTestDb } = require('./helpers/db');
const { signup } = require('./helpers/auth');

let app;
beforeAll(async () => {
  await setupTestDb();
  app = createApp();
});
beforeEach(resetTestDb);
afterAll(teardownTestDb);

const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const ask = (token, body = {}) =>
  request(app)
    .post('/api/problems')
    .set(bearer(token))
    .send({ title: 'Two sum in O(n)?', body: 'How do I find two numbers that add up to k in linear time?', ...body });

async function twoUsers() {
  const alice = await signup(app, { name: 'Alice', email: 'alice@example.com' });
  const bob = await signup(app, { name: 'Bob', email: 'bob@example.com' });
  return { alice, bob };
}

describe('POST /api/problems', () => {
  test('requires auth', async () => {
    await request(app).post('/api/problems').send({ title: 'x' }).expect(401);
    await request(app).get('/api/problems').expect(401);
  });

  test('201: author comes from the token; tags are normalised and de-duplicated', async () => {
    const { alice, bob } = await twoUsers();
    const res = await ask(alice.accessToken, { tags: [' DP', 'dp', 'Graphs'], platform: 'LeetCode', authorId: bob.user.id, authorName: 'Bob' }).expect(201);
    expect(res.body.problem).toMatchObject({ authorId: alice.user.id, authorName: 'Alice', tags: ['dp', 'graphs'], platform: 'LeetCode', isPublic: true, answerCount: 0 });
  });

  test('400 on bad input', async () => {
    const { alice } = await twoUsers();
    const res = await ask(alice.accessToken, { title: 'x', body: 'short', tags: ['a', 'b', 'c', 'd', 'e', 'f'] });
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d) => d.path).sort()).toEqual(['body', 'tags', 'title']);
  });
});

describe('GET /api/problems', () => {
  test('the public feed is newest first, excludes private problems and pages with a cursor', async () => {
    const { alice, bob } = await twoUsers();
    for (let i = 0; i < 5; i += 1) await ask(alice.accessToken, { title: `Public problem ${i}` }).expect(201);
    await ask(bob.accessToken, { title: 'Bob private notes', isPublic: false }).expect(201);

    const first = await request(app).get('/api/problems?limit=3').set(bearer(bob.accessToken)).expect(200);
    expect(first.body.problems.map((p) => p.title)).toEqual(['Public problem 4', 'Public problem 3', 'Public problem 2']);
    const second = await request(app).get(`/api/problems?limit=3&before=${first.body.nextCursor}`).set(bearer(bob.accessToken)).expect(200);
    expect(second.body.problems.map((p) => p.title)).toEqual(['Public problem 1', 'Public problem 0']);
    expect(second.body.nextCursor).toBeNull();
  });

  test('scope=mine lists my problems, public and private', async () => {
    const { alice, bob } = await twoUsers();
    await ask(alice.accessToken, { title: 'Alice public' }).expect(201);
    await ask(bob.accessToken, { title: 'Bob private', isPublic: false }).expect(201);
    await ask(bob.accessToken, { title: 'Bob public' }).expect(201);
    const res = await request(app).get('/api/problems?scope=mine').set(bearer(bob.accessToken)).expect(200);
    expect(res.body.problems.map((p) => p.title)).toEqual(['Bob public', 'Bob private']);
  });

  test('the feed shows excerpts, the detail view the whole body', async () => {
    const { alice } = await twoUsers();
    const long = 'x'.repeat(EXCERPT_CHARS + 100);
    const { body } = await ask(alice.accessToken, { body: long }).expect(201);
    const feed = await request(app).get('/api/problems').set(bearer(alice.accessToken)).expect(200);
    expect(feed.body.problems[0].body.length).toBeLessThan(long.length);
    const detail = await request(app).get(`/api/problems/${body.problem.id}`).set(bearer(alice.accessToken)).expect(200);
    expect(detail.body.problem.body).toBe(long);
  });
});

describe('a problem and its answers', () => {
  test('answers are their own documents, the counter goes up, and answers page newest first', async () => {
    const { alice, bob } = await twoUsers();
    const { body } = await ask(alice.accessToken).expect(201);
    const id = body.problem.id;
    for (let i = 0; i < 3; i += 1) {
      await request(app).post(`/api/problems/${id}/answers`).set(bearer(bob.accessToken)).send({ body: `Use a hash map (#${i})` }).expect(201);
    }

    const detail = await request(app).get(`/api/problems/${id}`).set(bearer(alice.accessToken)).expect(200);
    expect(detail.body.problem.answerCount).toBe(3);
    expect(detail.body.answers.map((a) => a.body)).toEqual(['Use a hash map (#2)', 'Use a hash map (#1)', 'Use a hash map (#0)']);
    expect(detail.body.answers[0]).toMatchObject({ authorName: 'Bob', authorId: bob.user.id });

    const older = await request(app).get(`/api/problems/${id}/answers?limit=1&before=${detail.body.answers[1].id}`).set(bearer(alice.accessToken)).expect(200);
    expect(older.body.answers.map((a) => a.body)).toEqual(['Use a hash map (#0)']);

    expect(await Answer.countDocuments({ problemId: id })).toBe(3);
    const stored = await Problem.findById(id).lean();
    expect(stored.answers).toBeUndefined(); // not embedded (v1's design)
  });

  test("a private problem is invisible to others (404), and they can't answer it", async () => {
    const { alice, bob } = await twoUsers();
    const { body } = await ask(alice.accessToken, { isPublic: false }).expect(201);
    await request(app).get(`/api/problems/${body.problem.id}`).set(bearer(bob.accessToken)).expect(404);
    await request(app).post(`/api/problems/${body.problem.id}/answers`).set(bearer(bob.accessToken)).send({ body: 'hi' }).expect(404);
    await request(app).get(`/api/problems/${body.problem.id}`).set(bearer(alice.accessToken)).expect(200);
  });

  test('unknown and malformed ids; empty answers', async () => {
    const { alice } = await twoUsers();
    await request(app).get(`/api/problems/${new mongoose.Types.ObjectId()}`).set(bearer(alice.accessToken)).expect(404);
    await request(app).get('/api/problems/nope').set(bearer(alice.accessToken)).expect(400);
    const { body } = await ask(alice.accessToken).expect(201);
    await request(app).post(`/api/problems/${body.problem.id}/answers`).set(bearer(alice.accessToken)).send({ body: '   ' }).expect(400);
  });
});
