'use strict';

/**
 * A real HTTP + Socket.IO server on a random port, and real socket.io-client
 * connections to it. Nothing is mocked: the handshake, rooms, broadcasts and
 * acks all go over actual WebSocket connections on 127.0.0.1.
 */
const http = require('node:http');
const { io: connectIo } = require('socket.io-client');
const { createApp } = require('../../src/app');
const { RoomManager } = require('../../src/realtime/roomManager');
const { attachGateway } = require('../../src/realtime/gateway');

/**
 * @param {{ roomManager?: RoomManager, execution?: object, extraHandlers?: Function[] }} [options]
 */
async function startServer({ roomManager = new RoomManager(), execution = null, extraHandlers } = {}) {
  const app = createApp({ realtime: roomManager, execution });
  const server = http.createServer(app);
  const io = attachGateway(server, { roomManager, extraHandlers });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const clients = new Set();

  return {
    app,
    io,
    roomManager,
    url,
    /** Connect a client; resolves once connected, rejects with the connect_error. */
    connect(token) {
      return new Promise((resolve, reject) => {
        const socket = connectIo(url, {
          auth: token === undefined ? {} : { token },
          transports: ['websocket'],
          reconnection: false,
          forceNew: true,
        });
        clients.add(socket);
        socket.once('connect', () => resolve(socket));
        socket.once('connect_error', (err) => {
          socket.close();
          reject(err);
        });
      });
    },
    async close() {
      for (const c of clients) c.close();
      await new Promise((resolve) => io.close(() => resolve()));
      await roomManager.close();
    },
  };
}

/** Emit with an ack and resolve with the ack payload. */
function emitAck(socket, event, payload) {
  return socket.timeout(5000).emitWithAck(event, payload);
}

/**
 * Resolve with the next `event` on `socket` that passes `filter`.
 * @param {import('socket.io-client').Socket} socket
 * @param {string} event
 * @param {{ timeout?: number, filter?: (payload: any) => boolean }} [options]
 */
function nextEvent(socket, event, { timeout = 3000, filter = () => true } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, listener);
      reject(new Error(`timed out waiting for ${event}`));
    }, timeout);
    function listener(payload) {
      if (!filter(payload)) return;
      clearTimeout(timer);
      socket.off(event, listener);
      resolve(payload);
    }
    socket.on(event, listener);
  });
}

/** Resolve true if `event` does NOT arrive within `ms`. */
function noEvent(socket, event, ms = 300) {
  return new Promise((resolve) => {
    const listener = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      socket.off(event, listener);
      resolve(true);
    }, ms);
    socket.once(event, listener);
  });
}

module.exports = { startServer, emitAck, nextEvent, noEvent };
