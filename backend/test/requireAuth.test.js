'use strict';

/**
 * Tests for the auth middleware (src/middleware/requireAuth.js).
 * These are UNIT tests: the middleware is called directly with fake req/next,
 * and no database is connected. Run just these with:  npx jest requireAuth
 */
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { requireAuth, verifyAccessToken } = require('../src/middleware/requireAuth');
const { signAccessToken } = require('../src/services/tokenService');
const { AppError } = require('../src/lib/errors');

const SECRET = process.env.JWT_ACCESS_SECRET;
const userId = new mongoose.Types.ObjectId().toString();
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

// No DB in this file: any query must fail fast instead of buffering.
beforeAll(() => mongoose.set('bufferCommands', false));
afterAll(() => mongoose.set('bufferCommands', true));

/** A minimal fake Express request supporting req.headers, req.get() and req.header(). */
function fakeReq(authorization) {
  const headers = authorization === undefined ? {} : { authorization };
  const get = (name) => headers[String(name).toLowerCase()];
  return { headers, get, header: get };
}

/** Run the middleware and report what it passed to next(). */
async function run(authorization) {
  const req = fakeReq(authorization);
  const next = jest.fn();
  await requireAuth(req, {}, next);
  expect(next).toHaveBeenCalledTimes(1);
  return { req, err: next.mock.calls[0][0] };
}

function expect401(err, code) {
  expect(err).toBeInstanceOf(AppError);
  expect(err.status).toBe(401);
  expect(err.code).toBe(code);
}

describe('requireAuth middleware', () => {
  test('valid token: sets req.auth = { userId } and calls next() with no error', async () => {
    const { req, err } = await run(`Bearer ${signAccessToken(userId)}`);
    expect(err).toBeUndefined();
    expect(req.auth).toEqual({ userId });
  });

  test('stateless: never queries MongoDB (works for a user that is not in any DB)', async () => {
    const exec = jest.spyOn(mongoose.Query.prototype, 'exec');
    const { req, err } = await run(`Bearer ${signAccessToken(new mongoose.Types.ObjectId())}`);
    expect(err).toBeUndefined();
    expect(req.auth.userId).toMatch(/^[0-9a-f]{24}$/);
    expect(exec).not.toHaveBeenCalled();
    exec.mockRestore();
  });

  test.each([
    ['no Authorization header', undefined],
    ['empty header', ''],
    ['wrong scheme', 'Basic dXNlcjpwYXNz'],
    ['"Bearer" with no token', 'Bearer'],
    ['"Bearer " with only a space', 'Bearer '],
  ])('401 AUTH_MISSING: %s', async (_label, header) => {
    const { err } = await run(header);
    expect401(err, 'AUTH_MISSING');
  });

  test('401 AUTH_EXPIRED: token past its exp', async () => {
    const expired = jwt.sign({ sub: userId, exp: Math.floor(Date.now() / 1000) - 60 }, SECRET);
    const { err } = await run(`Bearer ${expired}`);
    expect401(err, 'AUTH_EXPIRED');
  });

  test('401 AUTH_INVALID: garbage instead of a JWT', async () => {
    const { err } = await run('Bearer not.a.jwt');
    expect401(err, 'AUTH_INVALID');
  });

  test('401 AUTH_INVALID: signed with a different secret (forged)', async () => {
    const forged = jwt.sign({}, 'some-other-secret-that-is-32-chars-long!', { subject: userId, expiresIn: 900 });
    const { err } = await run(`Bearer ${forged}`);
    expect401(err, 'AUTH_INVALID');
  });

  test('401 AUTH_INVALID: "alg: none" (unsigned) token', async () => {
    const unsigned = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: userId, exp: 9999999999 })}.`;
    const { err } = await run(`Bearer ${unsigned}`);
    expect401(err, 'AUTH_INVALID');
  });

  test('401 AUTH_INVALID: right secret but wrong algorithm (HS512) - only HS256 is accepted', async () => {
    const hs512 = jwt.sign({}, SECRET, { algorithm: 'HS512', subject: userId, expiresIn: 900 });
    const { err } = await run(`Bearer ${hs512}`);
    expect401(err, 'AUTH_INVALID');
  });

  test('401 AUTH_INVALID: valid signature but no `sub` claim', async () => {
    const noSub = jwt.sign({ foo: 'bar' }, SECRET, { expiresIn: 900 });
    const { err } = await run(`Bearer ${noSub}`);
    expect401(err, 'AUTH_INVALID');
  });

  test('errors never contain the token', async () => {
    const forged = jwt.sign({}, 'some-other-secret-that-is-32-chars-long!', { subject: userId });
    const { err } = await run(`Bearer ${forged}`);
    expect(err.message).not.toContain(forged);
    expect(JSON.stringify(err.details ?? null)).not.toContain(forged);
  });
});

describe('verifyAccessToken (reused by the Socket.IO handshake in Phase 2)', () => {
  test('returns { userId } for a valid token', () => {
    expect(verifyAccessToken(signAccessToken(userId))).toEqual({ userId });
  });

  test('throws 401 AUTH_EXPIRED / AUTH_INVALID AppErrors', () => {
    const expired = jwt.sign({ sub: userId, exp: Math.floor(Date.now() / 1000) - 60 }, SECRET);
    expect(() => verifyAccessToken(expired)).toThrow(expect.objectContaining({ status: 401, code: 'AUTH_EXPIRED' }));
    expect(() => verifyAccessToken('garbage')).toThrow(expect.objectContaining({ status: 401, code: 'AUTH_INVALID' }));
  });
});
