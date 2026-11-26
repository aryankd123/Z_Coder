'use strict';

/**
 * RoomManager: the in-memory "room controller".
 *
 * It keeps one in-memory RoomSession per ACTIVE room (a room with at least
 * one connected socket):
 *
 *   sessions: Map<roomId, RoomSession>
 *   RoomSession
 *     users:      Map<userId, { name, role, sockets: Set<Socket> }>   who's here
 *     doc:        Y.Doc   the shared code: Y.Text('code') + Y.Map('meta') {language}
 *     awareness:  cursors, selections, names and colours (not persisted)
 *     dirty, persistTimer, persistChain                               saving
 *
 * Lifecycle:
 *   - created on the first room:join (after a DB membership check): the Yjs
 *     state is loaded from roomDocs, or a new room gets its starter code;
 *   - every later event checks membership against this in-memory map (no DB
 *     round trip per chat message or keystroke);
 *   - each edit is applied to the server's copy of the doc (so late joiners
 *     get everything), relayed to the rest of the room, and saved about 2 s
 *     after the last change (debounced);
 *   - torn down when the last socket leaves: saved first, then destroyed.
 *     A join that arrives during that final save waits for it, then loads
 *     the fresh state, so nothing is lost or loaded stale.
 *
 * Presence is multi-tab aware: a user is "online" while ANY of their sockets
 * is in the room.
 *
 * REST talks to this class through the realtime "port" (see nullRealtime.js):
 * onlineUserIds, memberRoleChanged, memberRemoved, emitToRoom.
 *
 * Scaling note: everything here lives in ONE process, and each room's Y.Doc
 * must have exactly one owner. With several API nodes, route each room to
 * one node (room affinity) or fan updates out over Redis.
 */
const Y = require('yjs');
const awarenessProtocol = require('y-protocols/awareness');
const roomService = require('../services/roomService');
const roomDocService = require('../services/roomDocService');
const { LANGUAGES, LANGUAGE_IDS } = require('../execution/languages');
const { notFound, forbidden } = require('../lib/errors');
const { logger } = require('../lib/logger');

/** Socket.IO room name for a ZCoder room (prefixed so it can't clash with socket ids). */
const channel = (roomId) => `room:${roomId}`;

/** Hard cap on the shared document (characters). Far above the 64 KB run limit. */
const MAX_DOC_CHARS = 128 * 1024;

/** Transaction origin for changes the server makes itself (seeding, fixes). */
const SERVER_ORIGIN = 'server';

class RoomSession {
  /**
   * @param {string} roomId
   * @param {string} language the room's language from MongoDB
   */
  constructor(roomId, language) {
    this.roomId = roomId;
    /** @type {Map<string, { name: string, role: string, sockets: Set<import('socket.io').Socket> }>} */
    this.users = new Map();
    this.lastTouchedAt = 0;

    this.doc = new Y.Doc(); // gc on: deleted text shrinks to small tombstones
    this.text = this.doc.getText('code');
    this.meta = this.doc.getMap('meta');
    this.language = language;
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.awareness.setLocalState(null); // the server is a relay, not a participant
    /** socket.id -> awareness clientIDs that socket announced (removed when it leaves) */
    this.awarenessClients = new Map();

    this.dirty = false;
    this.languageDirty = false;
    this.persistTimer = null;
    this.persistChain = Promise.resolve();
    /** Set once teardown starts; a torn-down session is never reused. */
    this.closed = null;
  }

  get isEmpty() {
    return this.users.size === 0;
  }

  /** Who is online right now (one entry per user, however many tabs). */
  presence() {
    return [...this.users].map(([userId, u]) => ({ userId, name: u.name, role: u.role, tabs: u.sockets.size }));
  }

  destroy() {
    clearTimeout(this.persistTimer);
    this.awareness.destroy(); // stops its 'outdated state' interval timer
    this.doc.destroy();
  }
}

/** Is this transaction origin a Socket.IO socket? */
const isSocket = (origin) => Boolean(origin && typeof origin === 'object' && typeof origin.id === 'string' && origin.emit);

class RoomManager {
  /**
   * @param {{
   *   findRoomForMember?: typeof roomService.findRoomForMember,
   *   touchRoom?: typeof roomService.touchRoom,
   *   store?: typeof roomDocService,
   *   touchIntervalMs?: number,
   *   persistDebounceMs?: number,
   * }} [deps] injectable for tests
   */
  constructor({
    findRoomForMember = roomService.findRoomForMember,
    touchRoom = roomService.touchRoom,
    store = roomDocService,
    touchIntervalMs = 60_000,
    persistDebounceMs = 2000,
  } = {}) {
    /** @type {import('socket.io').Server | null} */
    this.io = null;
    /** @type {Map<string, RoomSession>} */
    this.sessions = new Map();
    /** roomId -> in-flight creation (two joins at once must share one session) */
    this.creating = new Map();
    /** roomId -> in-flight final save of a torn-down session */
    this.closing = new Map();
    this.findRoomForMember = findRoomForMember;
    this.touchRoom = touchRoom;
    this.store = store;
    this.touchIntervalMs = touchIntervalMs;
    this.persistDebounceMs = persistDebounceMs;
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
    const member = roomService.findMember(room, userId);

    const session = await this._getOrCreate(roomId, room);
    if (session.closed) return this.join(socket, roomId); // torn down while we waited: start over
    // The socket may have disconnected while we waited on MongoDB. Its
    // disconnect cleanup has already run, so registering it now would leak it.
    if (socket.disconnected) {
      if (session.isEmpty) this._teardown(session);
      throw forbidden('SOCKET_CLOSED', 'Socket disconnected');
    }

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

    // Remove this socket's cursors; the awareness 'update' handler tells the others.
    const clientIds = session.awarenessClients.get(socket.id);
    session.awarenessClients.delete(socket.id);
    if (clientIds?.size) awarenessProtocol.removeAwarenessStates(session.awareness, [...clientIds], SERVER_ORIGIN);

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
   * nothing per message or keystroke, and REST role changes and removals
   * update it live.
   *
   * @param {import('socket.io').Socket} socket
   * @param {string} roomId
   * @param {'viewer' | 'editor' | 'owner'} [minRole]
   * @returns {{ session: RoomSession, user: { name: string, role: string } }}
   * @throws {import('../lib/errors').AppError} 403 NOT_IN_ROOM | ROOM_FORBIDDEN
   */
  requireSession(socket, roomId, minRole = 'viewer') {
    const session = socket.data.rooms.has(roomId) ? this.sessions.get(roomId) : null;
    const user = session?.users.get(socket.data.userId);
    if (!user) throw forbidden('NOT_IN_ROOM', 'Join the room first');
    if (!roomService.roleAtLeast(user.role, minRole)) {
      throw forbidden('ROOM_FORBIDDEN', `This needs the ${minRole} role in the room`);
    }
    return { session, user };
  }

  /** Same check, returning just the member. */
  requireMember(socket, roomId, minRole = 'viewer') {
    return this.requireSession(socket, roomId, minRole).user;
  }

  // ---- the shared document --------------------------------------------------

  /**
   * Apply a Yjs update that came from a socket. The doc's 'update' listener
   * (see _wire) relays it to the rest of the room and schedules a save.
   * @param {RoomSession} session
   * @param {Uint8Array} update
   * @param {import('socket.io').Socket} socket the origin, so the relay skips it
   */
  applyClientUpdate(session, update, socket) {
    Y.applyUpdate(session.doc, update, socket);
    // Size cap, enforced by the server itself: if a paste pushed the document
    // past the limit, delete the overflow. That's a normal Yjs edit, so every
    // client converges on the trimmed document.
    const overflow = session.text.length - MAX_DOC_CHARS;
    if (overflow > 0) {
      session.doc.transact(() => session.text.delete(MAX_DOC_CHARS, overflow), SERVER_ORIGIN);
    }
  }

  /** The current code in a room, if the room is active (Phase 4 runs it). */
  currentCode(roomId) {
    return this.sessions.get(roomId)?.text.toString() ?? null;
  }

  // ---- the realtime port used by REST ---------------------------------------

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

  /** Broadcast to everyone in a room (code execution uses this). */
  emitToRoom(roomId, event, payload) {
    this.io?.to(channel(roomId)).emit(event, payload);
  }

  // ---- activity --------------------------------------------------------------

  /**
   * Mark the room active so it rises in "my rooms". Throttled to one write per
   * room per touchIntervalMs, so a busy room doesn't turn every message into
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

  /** Graceful shutdown: save and destroy every active session. */
  async close() {
    for (const session of [...this.sessions.values()]) this._teardown(session);
    await Promise.all([...this.creating.values()].map((p) => p.catch(() => {})));
    for (const session of [...this.sessions.values()]) this._teardown(session); // created meanwhile
    await Promise.all([...this.closing.values()]);
  }

  // ---- internals ---------------------------------------------------------------

  /**
   * One session per room, even when several sockets join at the same moment:
   * the first caller starts the load and the others await the same promise.
   * @param {string} roomId
   * @param {{ language: string }} room
   */
  async _getOrCreate(roomId, room) {
    const existing = this.sessions.get(roomId);
    if (existing) return existing;

    let pending = this.creating.get(roomId);
    if (!pending) {
      pending = (async () => {
        await this.closing.get(roomId); // a previous session's final save must land first
        const state = await this.store.loadState(roomId);
        const session = new RoomSession(roomId, room.language);
        if (state) Y.applyUpdate(session.doc, state, 'load');
        this._wire(session);
        if (!state) {
          // A brand-new room: seed it here, once, on the server. If clients
          // seeded it, two people opening an empty room would both insert the
          // starter code. Seeding goes through _wire, so it gets saved.
          const lang = LANGUAGES[room.language] ? room.language : 'javascript';
          session.doc.transact(() => {
            session.text.insert(0, LANGUAGES[lang].starter);
            session.meta.set('language', lang);
          }, SERVER_ORIGIN);
        } else if (!LANGUAGE_IDS.includes(session.meta.get('language'))) {
          session.doc.transact(() => session.meta.set('language', session.language), SERVER_ORIGIN);
        }
        session.language = session.meta.get('language');
        this.sessions.set(roomId, session);
        return session;
      })().finally(() => this.creating.delete(roomId));
      this.creating.set(roomId, pending);
    }
    return pending;
  }

  /** Attach the document and awareness listeners to a new session. */
  _wire(session) {
    const { roomId } = session;

    // Every change, from any origin: relay to the room (minus the sender) and schedule a save.
    session.doc.on('update', (update, origin) => {
      this._relay(roomId, 'yjs:update', { roomId, update }, origin);
      session.dirty = true;
      this._schedulePersist(session);
    });

    // Language lives in Y.Map('meta'), so a change reaches every editor
    // through Yjs. Mirror valid values into rooms.language; revert invalid ones.
    session.meta.observe((event) => {
      if (!event.keysChanged.has('language')) return;
      const language = session.meta.get('language');
      if (!LANGUAGE_IDS.includes(language)) {
        session.doc.transact(() => session.meta.set('language', session.language), SERVER_ORIGIN);
        return;
      }
      if (language !== session.language) {
        session.language = language;
        session.languageDirty = true;
        this._schedulePersist(session);
      }
    });

    // Cursors and selections: relay everything (including the clients'
    // periodic "still here" renewals) and remember which socket owns which
    // awareness client ids, so we can clear them when that socket leaves.
    session.awareness.on('update', ({ added, updated, removed }, origin) => {
      if (isSocket(origin)) {
        let ids = session.awarenessClients.get(origin.id);
        if (!ids) session.awarenessClients.set(origin.id, (ids = new Set()));
        for (const id of added) ids.add(id);
        for (const id of removed) ids.delete(id);
      }
      const changed = added.concat(updated, removed);
      if (changed.length === 0) return;
      const update = awarenessProtocol.encodeAwarenessUpdate(session.awareness, changed);
      this._relay(roomId, 'awareness:update', { roomId, update }, origin);
    });
  }

  /** Emit to everyone in the room except the socket the change came from. */
  _relay(roomId, event, payload, origin) {
    if (!this.io) return;
    const target = this.io.to(channel(roomId));
    (isSocket(origin) ? target.except(origin.id) : target).emit(event, payload);
  }

  _schedulePersist(session) {
    clearTimeout(session.persistTimer);
    session.persistTimer = setTimeout(() => this._persist(session), this.persistDebounceMs);
  }

  /**
   * Save the document (and the language, if it changed).
   *
   * Saves are CHAINED per session: if save #1 is slow and save #2 starts,
   * #2 waits. Otherwise #1 (older state) could land after #2 and overwrite
   * newer code. The state is encoded when the save actually runs, so it's
   * always the latest.
   * @param {RoomSession} session
   * @returns {Promise<void>} never rejects
   */
  _persist(session) {
    clearTimeout(session.persistTimer);
    session.persistTimer = null;
    session.persistChain = session.persistChain.then(async () => {
      if (!session.dirty && !session.languageDirty) return;
      const state = Y.encodeStateAsUpdate(session.doc);
      const language = session.languageDirty ? session.language : null;
      session.dirty = false;
      session.languageDirty = false;
      try {
        await this.store.saveState(session.roomId, state);
        if (language) await this.store.saveLanguage(session.roomId, language);
      } catch (err) {
        // Keep the flags so the next attempt (debounce or teardown) retries.
        session.dirty = true;
        if (language) session.languageDirty = true;
        logger.error({ err, roomId: session.roomId }, 'saving room document failed');
        if (this.sessions.get(session.roomId) === session) this._schedulePersist(session);
      }
    });
    return session.persistChain;
  }

  /** The last socket left: save, then free the memory. Joins arriving meanwhile wait (see _getOrCreate). */
  _teardown(session) {
    if (session.closed) return session.closed; // idempotent
    if (this.sessions.get(session.roomId) === session) this.sessions.delete(session.roomId);
    const done = this._persist(session).finally(() => {
      session.destroy();
      if (this.closing.get(session.roomId) === done) this.closing.delete(session.roomId);
    });
    session.closed = done;
    this.closing.set(session.roomId, done);
    return done;
  }

  _broadcastPresence(session) {
    this.io?.to(channel(session.roomId)).emit('presence:state', { roomId: session.roomId, online: session.presence() });
  }
}

module.exports = { RoomManager, RoomSession, channel, MAX_DOC_CHARS };
