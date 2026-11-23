'use strict';

const { User, toPublicUser } = require('../models/User');
const { Room } = require('../models/Room');
const { notFound } = require('../lib/errors');

/**
 * @param {string} userId
 * @returns {Promise<ReturnType<typeof toPublicUser>>}
 * @throws {import('../lib/errors').AppError} 404 USER_NOT_FOUND
 */
async function getUser(userId) {
  const user = await User.findById(userId).lean();
  if (!user) throw notFound('USER_NOT_FOUND', 'Account not found');
  return toPublicUser(user);
}

/**
 * Update profile fields. A name change is also copied into every room the
 * user belongs to, because rooms.members[].name is a denormalised copy.
 *
 * `$[m]` with arrayFilters updates only the array elements whose userId
 * matches, in every matching room, in one updateMany.
 *
 * @param {string} userId
 * @param {{ name?: string, favLang?: string | null, techStack?: string[] }} patch validated input
 */
async function updateUser(userId, patch) {
  const user = await User.findByIdAndUpdate(userId, { $set: patch }, { new: true, runValidators: true }).lean();
  if (!user) throw notFound('USER_NOT_FOUND', 'Account not found');

  if (patch.name !== undefined) {
    await Room.updateMany(
      { 'members.userId': user._id },
      { $set: { 'members.$[m].name': patch.name } },
      { arrayFilters: [{ 'm.userId': user._id }] },
    );
  }
  return toPublicUser(user);
}

module.exports = { getUser, updateUser };
