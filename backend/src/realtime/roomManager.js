'use strict';

/**
 * RoomManager: the in-memory "room controller".
 *
 * It keeps one in-memory RoomSession per ACTIVE room (a room with at least
 * one connected socket):
 *
 *   sessions: Map<roomId, RoomSession>
 *   RoomSession.users: Map<userId, { name, role, sockets: Set<Socket> }>
 *
 * Lifecycle:
 *   - created on the first room:join (after a DB membership check);
 *   - every later event checks membership against this in-memory map (no
 *     DB round trip per chat message or keystroke);
 *   - torn down when the last socket leaves or disconnects.
 *
 * Presence is multi-tab aware: a user is "online" while ANY of their sockets
 * is in the room. Opening a second tab doesn't announce them twice, and
 * closing one of two tabs doesn't mark them offline.
 *
 * REST talks to this class through the realtime "port" (see nullRealtime.js):
 * onlineUserIds, memberRoleChanged, memberRemoved, emitToRoom. When the owner
 * demotes or removes someone over REST, the change reaches the live sockets
 * immediately, so the in-memory check never trusts a stale role.
 *
 * Scaling note: everything here lives in ONE process. With several API nodes
 * each room needs a single owner node (room affinity at the load balancer) or
 * shared state (Redis adapter + pub/sub).
 */
const roomService = require('../services/roomService');
const { notFound, forbidden } = require('../lib/errors');
const { logger } = require('../lib/logger');

/** Socket.IO room name for a ZCoder room (prefixed so it can't clash with socket ids). */
const channel = (roomId) => `room:${roomId}`;

class RoomSession {
  /** @param {string} roomId */
  constructor(roomId) {
    this.roomId = roomId;
    /** @type {Map<string, { name: string, role: string, sockets: Set<import('socket.io').Socket> }>} */
    this.users = new Map();
    this.lastTouchedAt = 0;
  }

  get isEmpty() {
    return this.users.size === 0;
  }

  /** Who is online right now (one entry per user, however many tabs). */
  presence() {
    return [...this.users].map(([userId, u]) => ({ userId, name: u.name, role: u.role, tabs: u.sockets.size }));
  }
}

class RoomManager {
  /**
   * @param {{
   *   findRoomForMember?: typeof roomService.findRoomForMember,
   *   touchRoom?: typeof roomService.touchRoom,
   *   touchIntervalMs?: number,
   * }} [deps] injectable for tests
   */
  constructor({
    findRoomForMember = roomService.findRoomForMember,
    touchRoom = roomService.touchRoom,
    touchIntervalMs = 60_000,
  } = {}) {
    /** @type {import('socket.io').Server | null} */
    this.io = null;
    /** @type {Map<string, RoomSession>} */
    this.sessions = new Map();
    this.findRoomForMember = findRoomForMember;
    this.touchRoom = touchRoom;
    this.touchIntervalMs = touchIntervalMs;
  }

  /** Called once by the gateway after the Socket.IO server exists. */
  attach(io) {
    this.io = io;
  }

  /**
   * room:join. Checks membership in the DATABASE (the source of truth),
   * then registers the socket in the room's in-memory session.
   *
   * @param {import('socket.io').Socket} socket
   * @param {string} roomId
   * @returns {Promise<{ roomId: string, role: string, presence: ReturnType<RoomSession['presence']> }>}
   */
  async join(socket, roomId) {
    const userId = socket.data.userId;
    const room = await this.findRoomForMember(roomId, userId);
    if (!room) throw notFound('ROOM_NOT_FOUND', 'Room not found');
    // The socket may have disconnected while we waited on MongoDB. Its
    // disconnect cleanup has already run, so registering it now would leak it.
    if (socket.disconnected) throw forbidden('SOCKET_CLOSED', 'Socket disconnected');

    const member = roomService.findMember(room, userId);
    const session = this._getOrCreate(roomId);
    let user = session.users.get(userId);
    const firstTab = !user;
    if (!user) {
      user = { name: member.name, role: member.role, sockets: new Set() };
      session.users.set(userId, user);
    } else {
      // Refresh from the DB in case the role or name changed.
      user.role = member.role;
      user.name = member.name;
    }
    user.sockets.add(socket);
    socket.data.rooms.add(roomId);
    socket.join(channel(roomId));

    if (firstTab) this._broadcastPresence(session);
    return { roomId, role: user.role, presence: session.presence() };
  }

  /**
   * room:leave, or cleanup on disconnect.
   * @param {import('socket.io').Socket} socket
   * @param {string} roomId
   * @returns {boolean} whether the socket was in the room
   */
  leave(socket, roomId) {
    if (!socket.data.rooms.delete(roomId)) return false;
    socket.leave(channel(roomId));
    const session = this.sessions.get(roomId);
    if (!session) return true;

    const userId = socket.data.userId;
    const user = session.users.get(userId);
    if (user) {
      user.sockets.delete(socket);
      if (user.sockets.size === 0) {
        session.users.delete(userId);
        this._broadcastPresence(session); // last tab closed: now offline
      }
    }
    if (session.isEmpty) this._teardown(session);
    return true;
  }

  /** On disconnect: leave every room this socket had joined. */
  leaveAll(socket) {
    for (const roomId of [...socket.data.rooms]) this.leave(socket, roomId);
  }

  /**
   * The per-event membership check (after room:join). In-memory, so it costs
   * nothing per message, and REST role changes and removals update it live.
   *
   * @param {import('socket.io').Socket} socket
   * @param {string} roomId
   * @param {'viewer' | 'editor' | 'owner'} [minRole]
   * @returns {{ name: string, role: string }}
   * @throws {import('../lib/errors').AppError} 403 NOT_IN_ROOM | ROOM_FORBIDDEN
   */
  requireMember(socket, roomId, minRole = 'viewer') {
    const user = socket.data.rooms.has(roomId) ? this.sessions.get(roomId)?.users.get(socket.data.userId) : null;
    if (!user) throw forbidden('NOT_IN_ROOM', 'Join the room first');
    if (!roomService.roleAtLeast(user.role, minRole)) {
      throw forbidden('ROOM_FORBIDDEN', `This needs the ${minRole} role in the room`);
    }
    return user;
  }

  // ---- the realtime port used by REST ------------------------------------

  /** @param {string} roomId @returns {Set<string>} */
  onlineUserIds(roomId) {
    return new Set(this.sessions.get(roomId)?.users.keys() ?? []);
  }

  /** The owner changed someone's role over REST: update live sockets now. */
  memberRoleChanged(roomId, userId, role) {
    const session = this.sessions.get(roomId);
    const user = session?.users.get(userId);
    if (!user) return;
    user.role = role;
    for (const s of user.sockets) s.emit('room:role', { roomId, role });
    this._broadcastPresence(session);
  }

  /** The owner removed someone (or they left) over REST: drop their sockets from the room. */
  memberRemoved(roomId, userId) {
    const user = this.sessions.get(roomId)?.users.get(userId);
    if (!user) return;
    for (const s of [...user.sockets]) {
      s.emit('room:kicked', { roomId });
      this.leave(s, roomId);
    }
  }

  /** Broadcast to everyone in a room (used by code execution in Phase 4). */
  emitToRoom(roomId, event, payload) {
    this.io?.to(channel(roomId)).emit(event, payload);
  }

  // ---- activity ------------------------------------------------------------

  /**
   * Mark the room active so it rises in "my rooms". Throttled to one write per
   * room per touchIntervalMs, so a busy chat doesn't turn every message into
   * an extra write on the rooms collection.
   * @param {string} roomId
   */
  touch(roomId) {
    const session = this.sessions.get(roomId);
    const now = Date.now();
    if (!session || now - session.lastTouchedAt < this.touchIntervalMs) return;
    session.lastTouchedAt = now;
    this.touchRoom(roomId).catch((err) => logger.warn({ err, roomId }, 'touchRoom failed'));
  }

  /** Graceful shutdown. */
  async close() {
    this.sessions.clear();
  }

  // ---- internals -------------------------------------------------------------

  _getOrCreate(roomId) {
    let session = this.sessions.get(roomId);
    if (!session) {
      session = new RoomSession(roomId);
      this.sessions.set(roomId, session);
    }
    return session;
  }

  _teardown(session) {
    this.sessions.delete(session.roomId);
  }

  _broadcastPresence(session) {
    this.io?.to(channel(session.roomId)).emit('presence:state', { roomId: session.roomId, online: session.presence() });
  }
}

module.exports = { RoomManager, RoomSession, channel };
