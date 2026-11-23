'use strict';

const express = require('express');
const { isDbConnected, pingDb } = require('../db');

/**
 * Two different questions a platform asks about a process:
 *
 *   /healthz (liveness): "is the process alive?" Always 200 if we can answer
 *     at all. A failure here means "restart me".
 *   /readyz (readiness): "can I serve traffic right now?" Pings dependencies.
 *     503 means "don't route users to me yet", e.g. Mongo is unreachable.
 *     Restarting wouldn't fix that.
 *
 * Redis joins the readiness checks when the BullMQ adapter lands.
 */
function healthRouter() {
  const router = express.Router();

  router.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/readyz', async (_req, res) => {
    const checks = { mongo: 'down' };
    try {
      if (isDbConnected()) {
        await pingDb();
        checks.mongo = 'up';
      }
    } catch {
      // stays 'down'
    }
    const ready = Object.values(checks).every((state) => state === 'up');
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', checks });
  });

  return router;
}

module.exports = { healthRouter };
