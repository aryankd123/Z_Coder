'use strict';

const request = require('supertest');

const REFRESH_COOKIE = 'zc_rt';

/**
 * Pull the refresh cookie out of a response's Set-Cookie headers.
 * @returns {{ header: string | undefined, pair: string | undefined, value: string | undefined }}
 *   header = the full Set-Cookie line (with flags), pair = "zc_rt=VALUE" (for sending back)
 */
function refreshCookieFrom(res) {
  const header = (res.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${REFRESH_COOKIE}=`));
  const pair = header?.split(';')[0];
  const value = pair?.slice(REFRESH_COOKIE.length + 1);
  return { header, pair, value };
}

/** Sign up a user through the real API. Returns the body plus the refresh cookie pair. */
async function signup(app, overrides = {}) {
  const body = { name: 'Alice', email: 'alice@example.com', password: 'correct horse battery', ...overrides };
  const res = await request(app).post('/api/auth/signup').send(body).expect(201);
  return { ...res.body, cookie: refreshCookieFrom(res).pair, credentials: body };
}

module.exports = { refreshCookieFrom, signup, REFRESH_COOKIE };
