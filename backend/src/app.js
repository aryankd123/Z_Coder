'use strict';

/**
 * Builds the Express app WITHOUT calling listen(). server.js listens; tests
 * hand the app straight to supertest. Keeping construction and listening
 * separate is what makes the API testable without opening ports.
 *
 * Middleware order matters. A request flows top to bottom:
 *   1. pino-http  - request ID + one log line per request
 *   2. helmet     - security headers
 *   3. cors       - allowlisted origins only
 *   4. json body  - parsed, max 256 KB (413 above that)
 *   5. routes     - /healthz, /readyz, /api/*
 *   6. 404        - nothing matched
 *   7. errors     - every thrown/forwarded error becomes { error: {...} }
 */
const crypto = require('node:crypto');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const pinoHttp = require('pino-http');
const { getConfig } = require('./config');
const { logger } = require('./lib/logger');
const { createAuthLimiters } = require('./lib/rateLimit');
const { healthRouter } = require('./routes/health');
const { apiRouter } = require('./routes');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

// Only accept a caller-supplied request ID if it's short and harmless
// (prevents log injection).
const SAFE_REQUEST_ID = /^[\w-]{1,64}$/;

/** @returns {import('express').Express} */
function createApp() {
  const config = getConfig();
  const app = express();

  // How many proxies to trust for X-Forwarded-For. Wrong values either
  // let clients spoof their IP (too high) or rate-limit the proxy (too low).
  app.set('trust proxy', config.trustProxy);

  app.use(
    pinoHttp({
      logger,
      genReqId(req, res) {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : crypto.randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      // Log only what we need. Headers (Authorization, Cookie) are never
      // serialised at all; logger.js also redacts them as a second layer.
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      autoLogging: { ignore: (req) => req.url === '/healthz' },
    }),
  );
  app.use(helmet());
  app.use(cors({ origin: [...config.corsOrigins], credentials: true }));
  app.use(express.json({ limit: '256kb' }));

  app.use(healthRouter());
  app.use('/api', apiRouter({ limiters: createAuthLimiters(config.rateLimits) }));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
