'use strict';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { createApp } = require('../src/app');
const { User, RefreshToken } = require('../src/models');
const { sha256 } = require('../src/services/tokenService');
const { setupTestDb, resetTestDb, teardownTestDb } = require('./helpers/db');
const { refreshCookieFrom, signup } = require('./helpers/auth');

let app;
beforeAll(async () => {
  await setupTestDb();
  app = createApp();
});
beforeEach(resetTestDb);
afterAll(teardownTestDb);

const alice = { name: 'Alice', email: 'Alice@Example.com', password: 'correct horse battery' };

describe('POST /api/auth/signup', () => {
  test('201: returns the public user + access token and sets a locked-down refresh cookie', async () => {
    const res = await request(app).post('/api/auth/signup').send(alice).expect(201);

    expect(res.body.user).toMatchObject({ name: 'Alice', email: 'alice@example.com' });
    expect(Object.keys(res.body.user).sort()).toEqual(['createdAt', 'email', 'favLang', 'id', 'name', 'techStack']);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|\$2[aby]\$/);

    const payload = jwt.decode(res.body.accessToken);
    expect(payload.sub).toBe(res.body.user.id);
    expect(payload.exp - payload.iat).toBe(900); // 15 minutes

    const { header } = refreshCookieFrom(res);
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=Lax/i);
    expect(header).toMatch(/Path=\/api\/auth/);
  });

  test('stores a bcrypt hash, never the password', async () => {
    await request(app).post('/api/auth/signup').send(alice).expect(201);
    const doc = await User.findOne({ email: 'alice@example.com' }).select('+passwordHash').lean();
    expect(doc.passwordHash).toMatch(/^\$2[aby]\$04\$/); // bcrypt, cost 4 in tests
    expect(doc.passwordHash).not.toContain(alice.password);
  });

  test('409 EMAIL_TAKEN for a duplicate email in any letter case', async () => {
    await request(app).post('/api/auth/signup').send(alice).expect(201);
    const res = await request(app)
      .post('/api/auth/signup')
      .send({ ...alice, email: '  ALICE@example.COM ' })
      .expect(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  test('concurrent duplicate signups: the unique index lets exactly one win', async () => {
    const results = await Promise.all([1, 2, 3].map(() => request(app).post('/api/auth/signup').send(alice)));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(await User.countDocuments()).toBe(1);
  });

  test('400 VALIDATION_FAILED with per-field details', async () => {
    const res = await request(app)
      .post('/api/auth/signup')
      .send({ name: '', email: 'not-an-email', password: 'short' })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details.map((d) => d.path).sort()).toEqual(['email', 'name', 'password']);
  });

  test('rejects passwords over 72 bytes (bcrypt would silently ignore the rest)', async () => {
    const res = await request(app)
      .post('/api/auth/signup')
      .send({ ...alice, password: '🔒'.repeat(19) }) // 19 chars but 76 bytes
      .expect(400);
    expect(res.body.error.details[0]).toMatchObject({ path: 'password', message: 'must be at most 72 bytes' });
  });

  test('unknown fields are stripped (no mass assignment)', async () => {
    await request(app)
      .post('/api/auth/signup')
      .send({ ...alice, passwordHash: 'attacker-chosen', favLang: 'rust', role: 'admin' })
      .expect(201);
    const doc = await User.findOne({ email: 'alice@example.com' }).select('+passwordHash').lean();
    expect(doc.passwordHash).not.toBe('attacker-chosen');
    expect(doc).not.toHaveProperty('role');
    expect(doc.favLang).toBeUndefined();
  });

  test('MongoDB operator injection is rejected by validation', async () => {
    const res = await request(app)
      .post('/api/auth/signup')
      .send({ ...alice, email: { $ne: null } })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('POST /api/auth/login', () => {
  beforeEach(() => signup(app));

  test('200 with access token and refresh cookie; email is case-insensitive', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ALICE@example.com', password: 'correct horse battery' })
      .expect(200);
    expect(res.body.user.email).toBe('alice@example.com');
    expect(typeof res.body.accessToken).toBe('string');
    expect(refreshCookieFrom(res).value).toBeTruthy();
  });

  test('wrong password and unknown email are indistinguishable (no account enumeration)', async () => {
    const wrongPassword = await request(app)
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: 'wrong password' })
      .expect(401);
    const unknownEmail = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: 'wrong password' })
      .expect(401);
    expect(wrongPassword.body).toEqual(unknownEmail.body);
    expect(wrongPassword.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  test('operator injection in login is rejected', async () => {
    await request(app).post('/api/auth/login').send({ email: { $gt: '' }, password: 'x' }).expect(400);
  });
});

describe('POST /api/auth/refresh (rotation + reuse detection)', () => {
  test('returns a new access token and ROTATES the refresh cookie', async () => {
    const { cookie } = await signup(app);
    const res = await request(app).post('/api/auth/refresh').set('Cookie', cookie).expect(200);

    expect(typeof res.body.accessToken).toBe('string');
    expect(res.body.user.email).toBe('alice@example.com');
    const rotated = refreshCookieFrom(res).pair;
    expect(rotated).toBeTruthy();
    expect(rotated).not.toBe(cookie);

    // The old token is now revoked and points at its successor.
    const oldRaw = cookie.split('=')[1];
    const oldDoc = await RefreshToken.findOne({ tokenHash: sha256(oldRaw) }).lean();
    expect(oldDoc.revokedAt).not.toBeNull();
    expect(oldDoc.replacedBy).not.toBeNull();
  });

  test('reusing a rotated token -> 401 REFRESH_REUSED and the WHOLE family is revoked', async () => {
    const { cookie: first } = await signup(app);
    const second = refreshCookieFrom(await request(app).post('/api/auth/refresh').set('Cookie', first).expect(200)).pair;

    // An attacker replays the stolen first token...
    const reuse = await request(app).post('/api/auth/refresh').set('Cookie', first).expect(401);
    expect(reuse.body.error.code).toBe('REFRESH_REUSED');
    expect(refreshCookieFrom(reuse).value).toBe(''); // cookie cleared

    // ...so the legitimate user's newer token is dead too.
    const after = await request(app).post('/api/auth/refresh').set('Cookie', second).expect(401);
    expect(after.body.error.code).toBe('REFRESH_REUSED');
    expect(await RefreshToken.countDocuments({ revokedAt: null })).toBe(0);
  });

  test('other login sessions (other families) survive a reuse incident', async () => {
    const { cookie: deviceA } = await signup(app);
    const deviceB = refreshCookieFrom(
      await request(app).post('/api/auth/login').send({ email: 'alice@example.com', password: 'correct horse battery' }),
    ).pair;

    await request(app).post('/api/auth/refresh').set('Cookie', deviceA).expect(200);
    await request(app).post('/api/auth/refresh').set('Cookie', deviceA).expect(401); // reuse on A

    await request(app).post('/api/auth/refresh').set('Cookie', deviceB).expect(200); // B unaffected
  });

  test('401 REFRESH_MISSING without a cookie', async () => {
    const res = await request(app).post('/api/auth/refresh').expect(401);
    expect(res.body.error.code).toBe('REFRESH_MISSING');
  });

  test('401 REFRESH_INVALID for an unknown token', async () => {
    const res = await request(app).post('/api/auth/refresh').set('Cookie', 'zc_rt=made-up').expect(401);
    expect(res.body.error.code).toBe('REFRESH_INVALID');
  });

  test('401 REFRESH_EXPIRED once expiresAt has passed (code checks, not just the TTL index)', async () => {
    const { cookie } = await signup(app);
    await RefreshToken.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await request(app).post('/api/auth/refresh').set('Cookie', cookie).expect(401);
    expect(res.body.error.code).toBe('REFRESH_EXPIRED');
  });

  test('only the sha256 hash of the refresh token is stored', async () => {
    const { cookie } = await signup(app);
    const raw = cookie.split('=')[1];
    expect(await RefreshToken.findOne({ tokenHash: raw })).toBeNull();
    expect(await RefreshToken.findOne({ tokenHash: sha256(raw) })).not.toBeNull();
    expect(Buffer.from(raw, 'base64url')).toHaveLength(32); // 256 bits of randomness
  });
});

describe('POST /api/auth/logout', () => {
  test('204, clears the cookie, and the session can no longer refresh', async () => {
    const { cookie } = await signup(app);
    const res = await request(app).post('/api/auth/logout').set('Cookie', cookie).expect(204);
    expect(refreshCookieFrom(res).value).toBe('');
    await request(app).post('/api/auth/refresh').set('Cookie', cookie).expect(401);
  });

  test('is idempotent: logging out without a cookie still returns 204', async () => {
    await request(app).post('/api/auth/logout').expect(204);
  });
});

describe('GET /api/auth/me (protected route)', () => {
  test('200 with a valid access token', async () => {
    const { accessToken } = await signup(app);
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${accessToken}`).expect(200);
    expect(res.body.user.email).toBe('alice@example.com');
  });

  test('401 AUTH_MISSING without a token', async () => {
    const res = await request(app).get('/api/auth/me').expect(401);
    expect(res.body.error.code).toBe('AUTH_MISSING');
  });

  test('401 AUTH_INVALID with a tampered token', async () => {
    const { accessToken } = await signup(app);
    const [header, , signature] = accessToken.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ sub: '000000000000000000000000', exp: 9999999999 })).toString('base64url');
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${header}.${forgedPayload}.${signature}`)
      .expect(401);
    expect(res.body.error.code).toBe('AUTH_INVALID');
  });
});

describe('request body errors', () => {
  test('malformed JSON -> 400 INVALID_JSON', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": ')
      .expect(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });

  test('body over 256 KB -> 413 PAYLOAD_TOO_LARGE', async () => {
    const res = await request(app)
      .post('/api/auth/signup')
      .send({ ...alice, name: 'x'.repeat(300 * 1024) })
      .expect(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});
