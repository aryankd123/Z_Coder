'use strict';

/**
 * Wraps a socket event handler with the same safety rails as an HTTP route:
 *
 *   1. Validate the payload with zod (sockets are an input edge too).
 *   2. Run the handler.
 *   3. Answer through the ack callback, always in one of two shapes:
 *        { ok: true, data? }
 *        { ok: false, error: { code, message, details? } }   (same codes as REST)
 *   4. Never let an exception escape: an unhandled rejection in a socket
 *      listener would otherwise crash the process or go silent.
 *
 *   on(socket, 'chat:send', chatSendPayload, async (payload) => { ...; return data; });
 */
const { badRequest } = require('../lib/errors');
const { toAppError } = require('../middleware/errorHandler');
const { logger } = require('../lib/logger');

/**
 * Turn any thrown error into the ack's error shape (500s stay generic).
 * @param {unknown} err
 */
function toAckError(err) {
  const appErr = toAppError(err);
  const error = { code: appErr.code, message: appErr.message };
  if (appErr.details !== undefined) error.details = appErr.details;
  return { status: appErr.status, error };
}

/**
 * @param {import('socket.io').Socket} socket
 * @param {string} event
 * @param {import('zod').ZodType} schema
 * @param {(payload: any) => Promise<unknown> | unknown} handler
 */
function on(socket, event, schema, handler) {
  socket.on(event, async (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    try {
      const parsed = schema.safeParse(payload ?? {});
      if (!parsed.success) {
        const details = parsed.error.issues.map((i) => ({ in: 'payload', path: i.path.join('.'), message: i.message }));
        throw badRequest('VALIDATION_FAILED', 'Event payload failed validation', details);
      }
      const data = await handler(parsed.data);
      reply(data === undefined ? { ok: true } : { ok: true, data });
    } catch (err) {
      const { status, error } = toAckError(err);
      if (status >= 500) logger.error({ err, event, userId: socket.data.userId }, 'socket handler failed');
      reply({ ok: false, error });
    }
  });
}

module.exports = { on, toAckError };
