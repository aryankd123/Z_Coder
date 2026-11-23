'use strict';

// Must be set BEFORE src/ is required: config is read once per test file.
process.env.LOGIN_FAILURES_PER_EMAIL = '3';

const express = require('express');
const request = require('supertest');
const { createApp } = require('../src/app');
const { createAuthLimiters } = require('../src/lib/rateLimit');
const { errorHandler } = require('../src/middleware/errorHandler');
const { setupTestDb, teardownTestDb } = require('./helpers/db');
const { signup } = require('./helpers/auth');

let app;
beforeAll(async () => {
  await setupTestDb();
  app = createApp();
  await signup(app); // alice@example.com
});
afterAll(teardownTestDb);

const login = (email, password) => request(app).post('/api/auth/login').send({ email, password });

describe('login: failed attempts per email', () => {
  test('3 failures allowed, the 4th is 429 even with the right password; other emails unaffected', async () => {
    for (let i = 0; i < 3; i += 1) {
      await login('alice@example.com', 'wrong').expect(401);
    }
    const blocked = await login('ALICE@example.com', 'correct horse battery').expect(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(blocked.headers.ratelimit).toBeDefined(); // standard RateLimit header

    await login('bob@example.com', 'wrong').expect(401); // separate counter
  });
});

describe('per-IP limiter (unit)', () => {
  test('rejects with 429 in the standard error shape after the limit', async () => {
    const limiters = createAuthLimiters({ authPerIp: 2, loginFailuresPerEmail: 100 });
    const tiny = express();
    tiny.get('/x', limiters.perIp, (_req, res) => res.json({ ok: true }));
    tiny.use(errorHandler);

    await request(tiny).get('/x').expect(200);
    await request(tiny).get('/x').expect(200);
    const res = await request(tiny).get('/x').expect(429);
    expect(res.body).toEqual({ error: { code: 'RATE_LIMITED', message: 'Too many attempts, try again later' } });
  });
});
