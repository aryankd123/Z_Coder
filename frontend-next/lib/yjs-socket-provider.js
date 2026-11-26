/**
 * A thin Yjs provider over the room's existing Socket.IO connection.
 *
 * (A "provider" in Yjs terms is the transport that keeps a local Y.Doc in
 * step with other copies. y-websocket is the usual one; we reuse the socket
 * that's already authenticated and in the room instead of opening a second
 * connection with its own auth.)
 *
 * Protocol (server half: backend/src/realtime/yjsProvider.js):
 *   sync():  send our state vector -> receive what we're missing + the
 *            server's state vector -> send back what the SERVER is missing
 *            (edits we made while offline). Call it after every room:join.
 *   live:    local doc updates -> 'yjs:update'; remote 'yjs:update' -> apply.
 *   cursors: awareness changes <-> 'awareness:update'.
 *
 * Echo prevention: remote updates are applied with `this` as the
 * transaction origin, and the doc listener ignores updates whose origin is
 * `this`, so nothing bounces back to the server.
 *
 * Plain ESM with no Next.js imports, so Node can load it too (the smoke test does).
 */
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';

export class SocketIOProvider {
  /**
   * @param {import('socket.io-client').Socket} socket already connected and joined (or about to be)
   * @param {string} roomId
   * @param {Y.Doc} doc
   * @param {{ canEdit?: boolean }} [options] viewers never send document updates
   */
  constructor(socket, roomId, doc, { canEdit = true } = {}) {
    this.socket = socket;
    this.roomId = roomId;
    this.doc = doc;
    this.awareness = new awarenessProtocol.Awareness(doc);
    this.canEdit = canEdit;
    this.synced = false;
    /** @type {Set<(synced: boolean) => void>} */
    this._syncedListeners = new Set();

    this._onDocUpdate = (update, origin) => {
      // Before the first sync, local edits wait: sync() sends them as one diff.
      if (origin === this || !this.synced || !this.canEdit || !socket.connected) return;
      socket.emit('yjs:update', { roomId, update });
    };
    this._onAwarenessUpdate = ({ added, updated, removed }, origin) => {
      if (origin === this || !socket.connected) return;
      const changed = added.concat(updated, removed);
      socket.emit('awareness:update', { roomId, update: awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed) });
    };
    this._onRemoteUpdate = (payload) => {
      if (payload?.roomId === roomId) Y.applyUpdate(doc, new Uint8Array(payload.update), this);
    };
    this._onRemoteAwareness = (payload) => {
      if (payload?.roomId === roomId) {
        awarenessProtocol.applyAwarenessUpdate(this.awareness, new Uint8Array(payload.update), this);
      }
    };
    this._onDisconnect = () => this._setSynced(false);

    doc.on('update', this._onDocUpdate);
    this.awareness.on('update', this._onAwarenessUpdate);
    socket.on('yjs:update', this._onRemoteUpdate);
    socket.on('awareness:update', this._onRemoteAwareness);
    socket.on('disconnect', this._onDisconnect);
  }

  /**
   * The state-vector exchange. Safe to call again after every reconnect:
   * Yjs updates are idempotent, so receiving something twice changes nothing.
   */
  async sync() {
    const res = await this.socket
      .timeout(10_000)
      .emitWithAck('yjs:sync', { roomId: this.roomId, stateVector: Y.encodeStateVector(this.doc) });
    if (!res.ok) throw new Error(res.error?.code ?? 'SYNC_FAILED');

    Y.applyUpdate(this.doc, new Uint8Array(res.data.update), this);
    if (res.data.awareness) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, new Uint8Array(res.data.awareness), this);
    }
    this._setSynced(true);

    if (this.canEdit) {
      // What do WE have that the server doesn't? (offline edits) An empty diff is 2 bytes.
      const missingOnServer = Y.encodeStateAsUpdate(this.doc, new Uint8Array(res.data.stateVector));
      if (missingOnServer.length > 2) this.socket.emit('yjs:update', { roomId: this.roomId, update: missingOnServer });
    }
    // Announce our cursor to whoever is already here.
    if (this.awareness.getLocalState()) {
      this.socket.emit('awareness:update', {
        roomId: this.roomId,
        update: awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]),
      });
    }
  }

  /** Role changed (room:role). */
  setCanEdit(canEdit) {
    this.canEdit = canEdit;
  }

  /** @param {(synced: boolean) => void} fn @returns {() => void} unsubscribe */
  onSynced(fn) {
    this._syncedListeners.add(fn);
    return () => this._syncedListeners.delete(fn);
  }

  _setSynced(value) {
    if (this.synced === value) return;
    this.synced = value;
    for (const fn of this._syncedListeners) fn(value);
  }

  destroy() {
    // Awareness.destroy() sets our state to null, which the listener sends,
    // so our cursor disappears for everyone else. Then unhook everything.
    this.awareness.destroy();
    this.doc.off('update', this._onDocUpdate);
    this.awareness.off('update', this._onAwarenessUpdate);
    this.socket.off('yjs:update', this._onRemoteUpdate);
    this.socket.off('awareness:update', this._onRemoteAwareness);
    this.socket.off('disconnect', this._onDisconnect);
    this._syncedListeners.clear();
  }
}
