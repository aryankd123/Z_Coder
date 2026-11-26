'use strict';

/**
 * The server half of the Yjs "provider" protocol, over the same
 * authenticated Socket.IO connection as chat. The browser half is
 * frontend-next/lib/yjs-socket-provider.js.
 *
 *   yjs:sync  { roomId, stateVector }  -> ack { update, stateVector, awareness }
 *     The state-vector exchange. A state vector says "how much of each
 *     client's edits I've seen". The server answers with exactly what the
 *     client is missing (encodeStateAsUpdate(doc, clientVector)), plus its
 *     own vector so the client can send back what the SERVER is missing
 *     (edits made offline). Two small messages, never the whole history
 *     twice. This is the same exchange as y-protocols/sync's step 1 and
 *     step 2; Socket.IO already frames our events, so we use the two Yjs
 *     calls directly instead of y-protocols' message envelope.
 *
 *   yjs:update { roomId, update }      (editor or owner only)
 *     One incremental change. Applied to the server's doc, which relays it
 *     to everyone else in the room and schedules a save. A VIEWER's update
 *     is rejected (ROOM_FORBIDDEN) and never touches the doc.
 *
 *   awareness:update { roomId, update } (any member)
 *     Cursor, selection, name and colour. Relayed, never saved.
 */
const Y = require('yjs');
const awarenessProtocol = require('y-protocols/awareness');
const { on } = require('./handler');
const { badRequest } = require('../lib/errors');
const { yjsSyncPayload, yjsUpdatePayload, awarenessPayload } = require('../validators/room');

/**
 * @param {import('socket.io').Socket} socket
 * @param {{ roomManager: import('./roomManager').RoomManager }} deps
 */
function registerYjs(socket, { roomManager }) {
  on(socket, 'yjs:sync', yjsSyncPayload, ({ roomId, stateVector }) => {
    const { session } = roomManager.requireSession(socket, roomId, 'viewer');
    let update;
    try {
      update = Y.encodeStateAsUpdate(session.doc, stateVector);
    } catch {
      throw badRequest('INVALID_STATE_VECTOR', 'State vector could not be decoded');
    }
    const clients = [...session.awareness.getStates().keys()];
    return {
      update,
      stateVector: Y.encodeStateVector(session.doc),
      awareness: clients.length ? awarenessProtocol.encodeAwarenessUpdate(session.awareness, clients) : null,
    };
  });

  on(socket, 'yjs:update', yjsUpdatePayload, ({ roomId, update }) => {
    // Role check BEFORE touching the doc: a viewer's edit is dropped here.
    const { session } = roomManager.requireSession(socket, roomId, 'editor');
    try {
      roomManager.applyClientUpdate(session, update, socket);
    } catch {
      throw badRequest('INVALID_UPDATE', 'Update could not be applied');
    }
  });

  on(socket, 'awareness:update', awarenessPayload, ({ roomId, update }) => {
    const { session } = roomManager.requireSession(socket, roomId, 'viewer');
    try {
      awarenessProtocol.applyAwarenessUpdate(session.awareness, update, socket);
    } catch {
      throw badRequest('INVALID_UPDATE', 'Awareness update could not be applied');
    }
  });
}

module.exports = { registerYjs };
