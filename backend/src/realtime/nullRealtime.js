'use strict';

/**
 * The realtime "port": the small interface the REST layer uses to talk to
 * the socket layer. RoomManager implements it for real. This no-op version
 * is what createApp() uses when no socket server is attached (REST-only
 * tests, scripts), so controllers never need `if (realtime)` checks.
 */
const nullRealtime = Object.freeze({
  /** @param {string} _roomId @returns {Set<string>} */
  onlineUserIds: (_roomId) => new Set(),
  memberRoleChanged() {},
  memberRemoved() {},
  emitToRoom() {},
});

module.exports = { nullRealtime };
