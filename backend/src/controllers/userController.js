'use strict';

const userService = require('../services/userService');

/** GET /api/users/me -> 200 { user } */
async function getMe(req, res) {
  res.json({ user: await userService.getUser(req.auth.userId) });
}

/** PATCH /api/users/me -> 200 { user } */
async function patchMe(req, res) {
  res.json({ user: await userService.updateUser(req.auth.userId, req.valid.body) });
}

module.exports = { getMe, patchMe };
