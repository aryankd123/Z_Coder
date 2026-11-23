'use strict';

const request = require('supertest');
const { createApp } = require('../src/app');
const { setupTestDb, teardownTestDb } = require('./helpers/db');

let app;
beforeAll(async () => {
  await setupTestDb();
  app = createApp();
});
afterAll(teardownTestDb);

describe('health checks', () => {
  test('GET /healthz -> 200 ok (liveness)', async () => {
    const res = await request(app).get('/healthz').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  test('GET /readyz -> 200 when MongoDB answers a ping (readiness)', async () => {
    const res = await request(app).get('/readyz').expect(200);
    expect(res.body).toEqual({ status: 'ready', checks: { mongo: 'up' } });
  });
});

describe('cross-cutting behaviour', () => {
  test('unknown route -> 404 in the standard error shape', async () => {
    const res = await request(app).get('/api/nope').expect(404);
    expect(res.body).toEqual({ error: { code: 'ROUTE_NOT_FOUND', message: 'No route for GET /api/nope' } });
  });

  test('every response carries a request ID; a safe incoming one is reused', async () => {
    const generated = await request(app).get('/healthz');
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);

    const reused = await request(app).get('/healthz').set('x-request-id', 'trace-123');
    expect(reused.headers['x-request-id']).toBe('trace-123');

    const unsafe = await request(app).get('/healthz').set('x-request-id', 'bad id <script>');
    expect(unsafe.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/); // replaced, not echoed
  });

  test('helmet security headers are set', async () => {
    const res = await request(app).get('/healthz');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  test('CORS: allowlisted origin gets the header, others do not', async () => {
    const allowed = await request(app).get('/healthz').set('Origin', 'http://localhost:3000');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3000');

    const blocked = await request(app).get('/healthz').set('Origin', 'https://evil.example');
    expect(blocked.headers['access-control-allow-origin']).toBeUndefined();
  });
});
