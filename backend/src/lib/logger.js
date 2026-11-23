'use strict';

/**
 * Structured JSON logging with pino.
 *
 * Redaction is defense in depth. Request logs only include method, URL and
 * request ID (see app.js), but if anything ever logs a whole object, these paths
 * are replaced with "[REDACTED]" before the line is written.
 */
const pino = require('pino');
const { getConfig } = require('../config');

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.accessToken',
  '*.refreshToken',
  '*.token',
];

function createLogger() {
  const config = getConfig();
  return pino({
    level: config.logLevel,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    // Human-readable output in development; raw JSON everywhere else
    // (log platforms parse JSON).
    transport: config.env === 'development' ? { target: 'pino-pretty' } : undefined,
  });
}

const logger = createLogger();

module.exports = { logger, REDACT_PATHS };
