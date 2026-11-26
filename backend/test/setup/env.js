'use strict';

/**
 * Runs before every test file (Jest `setupFiles`). Each file gets its own
 * database name on the shared test server, plus a valid test config.
 * A test file may override these BEFORE requiring src/ (see rateLimit.test.js).
 */
const crypto = require('node:crypto');

const base = process.env.TEST_MONGO_BASE_URI;
const dbName = `zcoder_test_${process.env.JEST_WORKER_ID}_${crypto.randomBytes(4).toString('hex')}`;

process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = `${base.replace(/\/?$/, '/')}${dbName}`;
process.env.JWT_ACCESS_SECRET = 'test-only-secret-that-is-at-least-32-characters';
process.env.BCRYPT_COST = '4'; // the minimum: keeps the suite fast; production uses 12
process.env.LOG_LEVEL = 'silent';
process.env.AUTH_RATE_LIMIT_PER_IP = '10000';
process.env.LOGIN_FAILURES_PER_EMAIL = '1000';
process.env.ROOM_JOIN_FAILURES_PER_USER = '1000';
process.env.CHAT_MESSAGES_PER_10S = '1000';
