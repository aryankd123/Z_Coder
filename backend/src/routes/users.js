'use strict';

const express = require('express');
const users = require('../controllers/userController');
const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/requireAuth');
const { patchMeBody } = require('../validators/user');

/** /api/users/*: every route here requires authentication. */
function usersRouter() {
  const router = express.Router();
  router.use(requireAuth);

  router.get('/me', users.getMe);
  router.patch('/me', validate({ body: patchMeBody }), users.patchMe);

  return router;
}

module.exports = { usersRouter };
