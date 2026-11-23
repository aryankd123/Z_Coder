'use strict';

/**
 * Auth service: signup, login, refresh and logout as plain async functions.
 * No req/res in here, so the logic is reusable and easy to test. Controllers
 * deal with HTTP (status codes, cookies); services deal with the rules.
 */
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { getConfig } = require('../config');
const { User, toPublicUser } = require('../models/User');
const { conflict, unauthorized } = require('../lib/errors');
const tokens = require('./tokenService');

/**
 * A bcrypt hash of a random throwaway password, computed once.
 *
 * Login always runs bcrypt.compare, even when the email doesn't exist, so
 * that "no such user" and "wrong password" take the same ~time. Without this,
 * an attacker could time responses to learn which emails have accounts
 * (account enumeration). The responses are also identical:
 * 401 INVALID_CREDENTIALS.
 */
let dummyHashPromise;
function getDummyHash() {
  dummyHashPromise ??= bcrypt.hash(crypto.randomUUID(), getConfig().bcryptCost);
  return dummyHashPromise;
}

/** Issue an access token plus a fresh refresh-token family for a user. */
async function startSession(user) {
  const accessToken = tokens.signAccessToken(user._id);
  const { raw: refreshToken } = await tokens.issueRefreshToken(user._id);
  return { user: toPublicUser(user), accessToken, refreshToken };
}

/**
 * Create an account and log it in.
 * @param {{ name: string, email: string, password: string }} input already validated and normalised
 * @throws {import('../lib/errors').AppError} 409 EMAIL_TAKEN
 */
async function signup({ name, email, password }) {
  const passwordHash = await bcrypt.hash(password, getConfig().bcryptCost);
  let user;
  try {
    user = await User.create({ name, email, passwordHash });
  } catch (err) {
    // No "check first, then insert": the unique index decides, atomically.
    if (err?.code === 11000) throw conflict('EMAIL_TAKEN', 'An account with this email already exists');
    throw err;
  }
  return startSession(user);
}

/**
 * @param {{ email: string, password: string }} input
 * @throws {import('../lib/errors').AppError} 401 INVALID_CREDENTIALS
 */
async function login({ email, password }) {
  const user = await User.findOne({ email }).select('+passwordHash').lean();
  const hash = user?.passwordHash ?? (await getDummyHash());
  const ok = await bcrypt.compare(password, hash);
  if (!user || !ok) throw unauthorized('INVALID_CREDENTIALS', 'Email or password is incorrect');
  return startSession(user);
}

/**
 * Rotate the refresh token and mint a new access token.
 * @param {string | undefined} rawRefreshToken
 */
async function refresh(rawRefreshToken) {
  const { raw, userId } = await tokens.rotateRefreshToken(rawRefreshToken);
  const user = await User.findById(userId).lean();
  if (!user) throw unauthorized('REFRESH_INVALID', 'Account no longer exists');
  return { user: toPublicUser(user), accessToken: tokens.signAccessToken(userId), refreshToken: raw };
}

/** @param {string | undefined} rawRefreshToken */
async function logout(rawRefreshToken) {
  await tokens.revokeRefreshToken(rawRefreshToken);
}

module.exports = { signup, login, refresh, logout };
