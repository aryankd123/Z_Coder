'use strict';

/**
 * The realtime gateway: Socket.IO attached to the same HTTP server as the
 * REST API (one port, one process).
 *
 * Connection lifecycle:
 *   1. Handshake: the client sends its access JWT in `auth: { token }`.
 *      io.use() verifies it with the SAME stateless check as requireAuth (no
 *      DB call). A bad token never gets a connection; the client sees
 *      connect_error with err.data.code = AUTH_MISSING | AUTH_EXPIRED | AUTH_INVALID.
 *   2. Expiry: sockets stay open for hours but access tokens last 15 minutes.
 *      The server sets a timer for the token's `exp`. The client should send
 *      `auth:renew { token }` with a fresh token before then; otherwise the
 *      server emits `error { code: AUTH_EXPIRED }` and disconnects the socket.
 *      Without this, a revoked user's open socket would work forever.
 *   3. Events: room:join, room:leave, chat:send, auth:renew, and the shared
 *      editor's yjs:sync, yjs:update, awareness:update. Every handler
 *      validates its payload and checks room membership (see handler.js).
 *   4. Disconnect: leave every room (presence updates for the others).
 */
const { Server } = require('socket.io');
const { getConfig } = require('../config');
const { verifyAccessTokenClaims } = require('../middleware/requireAuth');
const { unauthorized } = require('../lib/errors');
const { createWindowLimiter } = require('../lib/rateLimit');
const { on, toAckError } = require('./handler');
const { registerChat } = require('./chat');
const { registerYjs } = require('./yjsProvider');
const { socketRoomRef, authRenewPayload } = require('../validators/room');

/**
 * Handshake middleware. Runs once per connection attempt, before `connection`.
 * @param {import('socket.io').Socket} socket
 * @param {(err?: Error) => void} next
 */
function handshakeAuth(socket, next) {
  const token = socket.handshake.auth?.token;
  try {
    if (typeof token !== 'string' || token === '') {
      throw unauthorized('AUTH_MISSING', 'Send the access token in auth: { token }');
    }
    const { userId, expiresAt } = verifyAccessTokenClaims(token);
    socket.data.userId = userId;
    socket.data.tokenExpiresAt = expiresAt;
    next();
  } catch (err) {
    // Socket.IO passes err.message and err.data to the client's connect_error.
    const { error } = toAckError(err);
    const rejection = new Error(error.message);
    rejection.data = { code: error.code };
    next(rejection);
  }
}

/** (Re)arm the timer that disconnects the socket when its token expires. */
function scheduleExpiry(socket) {
  clearTimeout(socket.data.expiryTimer);
  const ms = Math.max(0, socket.data.tokenExpiresAt - Date.now());
  socket.data.expiryTimer = setTimeout(() => {
    socket.emit('error', { code: 'AUTH_EXPIRED', message: 'Access token expired; reconnect with a fresh token' });
    socket.disconnect(true);
  }, ms);
}

/**
 * Attach Socket.IO to an HTTP server.
 *
 * @param {import('node:http').Server} httpServer
 * @param {{ roomManager: import('./roomManager').RoomManager, extraHandlers?: ((socket: import('socket.io').Socket) => void)[] }} deps
 * @returns {import('socket.io').Server}
 */
function attachGateway(httpServer, { roomManager, extraHandlers = [] }) {
  const config = getConfig();
  const io = new Server(httpServer, {
    // The socket connects straight to the API origin (Vercel can't proxy
    // WebSockets), so it needs CORS, unlike REST, which goes through the Next.js rewrite.
    cors: { origin: [...config.corsOrigins], credentials: true },
    serveClient: false,
    maxHttpBufferSize: 1e6, // 1 MB per message: plenty for chat and Yjs updates
  });
  roomManager.attach(io);

  const chatLimiter = createWindowLimiter({ limit: config.rateLimits.chatMessagesPer10s, windowMs: 10_000 });

  io.use(handshakeAuth);

  io.on('connection', (socket) => {
    socket.data.rooms = new Set();
    scheduleExpiry(socket);

    on(socket, 'auth:renew', authRenewPayload, ({ token }) => {
      const claims = verifyAccessTokenClaims(token);
      if (claims.userId !== socket.data.userId) {
        throw unauthorized('AUTH_INVALID', 'That token belongs to another user');
      }
      socket.data.tokenExpiresAt = claims.expiresAt;
      scheduleExpiry(socket);
      return { expiresAt: claims.expiresAt };
    });

    on(socket, 'room:join', socketRoomRef, ({ roomId }) => roomManager.join(socket, roomId));
    on(socket, 'room:leave', socketRoomRef, ({ roomId }) => {
      roomManager.leave(socket, roomId);
    });

    registerChat(socket, { roomManager, limiter: chatLimiter });
    registerYjs(socket, { roomManager });
    for (const register of extraHandlers) register(socket);

    socket.on('disconnect', () => {
      clearTimeout(socket.data.expiryTimer);
      roomManager.leaveAll(socket);
    });
  });

  return io;
}

module.exports = { attachGateway, handshakeAuth };
