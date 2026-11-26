'use strict';

/**
 * Room invite codes: 8 random characters that people read aloud and type.
 *
 * Alphabet: 32 characters with the look-alikes removed (no 0/O, no 1/I), so
 * "is that a zero or an O?" never happens. Codes are upper-case only, and the
 * validator upper-cases what users type. 32 is a power of two, and
 * crypto.randomInt picks each character uniformly from a CSPRNG, so every code
 * is equally likely and unpredictable: 32^8 = 2^40 (about 1.1 trillion) codes.
 *
 * Collisions: with n rooms, a new code collides with probability n / 2^40
 * (about one in a million at a million rooms). The unique index on
 * rooms.inviteCode detects it and the service retries with a fresh code.
 *
 * Guessing: a code is a capability (knowing it lets you join), so it must not
 * be guessable. 2^40 codes plus the room-join rate limit makes enumeration
 * impractical; a room password adds a second factor.
 */
const crypto = require('node:crypto');

// 24 letters (A-Z without I and O) + 8 digits (2-9) = 32 characters.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const INVITE_CODE_LENGTH = 8;

/** @returns {string} e.g. "K7QH2MXA" */
function generateInviteCode() {
  let code = '';
  for (let i = 0; i < INVITE_CODE_LENGTH; i += 1) code += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return code;
}

module.exports = { generateInviteCode, ALPHABET, INVITE_CODE_LENGTH };
