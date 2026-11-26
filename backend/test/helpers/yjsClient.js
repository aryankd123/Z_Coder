'use strict';

/**
 * A headless Yjs client for tests: a real Y.Doc + Awareness speaking the same
 * protocol as the browser provider (frontend-next/lib/yjs-socket-provider.js)
 * over a real socket.io-client connection.
 */
const Y = require('yjs');
const awarenessProtocol = require('y-protocols/awareness');
const { emitAck } = require('./realtime');

class YClient {
  /**
   * @param {import('socket.io-client').Socket} socket
   * @param {string} roomId
   */
  constructor(socket, roomId) {
    this.socket = socket;
    this.roomId = roomId;
    this.doc = new Y.Doc();
    this.text = this.doc.getText('code');
    this.meta = this.doc.getMap('meta');
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.synced = false;
    this.acks = [];

    // Local edits go to the server once synced and connected. Remote ones
    // (origin === this) don't echo back.
    this.doc.on('update', (update, origin) => {
      if (origin === this || !this.synced || !socket.connected) return;
      socket.emit('yjs:update', { roomId, update }, (ack) => this.acks.push(ack));
    });
    this.awareness.on('update', ({ added, updated, removed }, origin) => {
      if (origin === this || !socket.connected) return;
      const update = awarenessProtocol.encodeAwarenessUpdate(this.awareness, added.concat(updated, removed));
      socket.emit('awareness:update', { roomId, update });
    });
    socket.on('yjs:update', (p) => p.roomId === roomId && Y.applyUpdate(this.doc, new Uint8Array(p.update), this));
    socket.on('awareness:update', (p) => {
      if (p.roomId === roomId) awarenessProtocol.applyAwarenessUpdate(this.awareness, new Uint8Array(p.update), this);
    });
    socket.on('disconnect', () => {
      this.synced = false;
    });
  }

  async join() {
    const ack = await emitAck(this.socket, 'room:join', { roomId: this.roomId });
    if (!ack.ok) throw new Error(`join failed: ${ack.error.code}`);
    return ack.data;
  }

  /** The two-way state-vector exchange (see backend/src/realtime/yjsProvider.js). */
  async sync() {
    const ack = await emitAck(this.socket, 'yjs:sync', { roomId: this.roomId, stateVector: Y.encodeStateVector(this.doc) });
    if (!ack.ok) throw new Error(`sync failed: ${ack.error.code}`);
    Y.applyUpdate(this.doc, new Uint8Array(ack.data.update), this);
    if (ack.data.awareness) awarenessProtocol.applyAwarenessUpdate(this.awareness, new Uint8Array(ack.data.awareness), this);
    this.synced = true;
    const missingOnServer = Y.encodeStateAsUpdate(this.doc, new Uint8Array(ack.data.stateVector));
    if (missingOnServer.length > 2) {
      return emitAck(this.socket, 'yjs:update', { roomId: this.roomId, update: missingOnServer });
    }
    return null;
  }

  async joinAndSync() {
    await this.join();
    await this.sync();
    return this;
  }

  destroy() {
    this.awareness.destroy();
    this.doc.destroy();
  }
}

/** Poll until fn() is truthy (or throw after `timeout` ms). */
async function waitFor(fn, { timeout = 3000, interval = 20, message = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${message}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

module.exports = { YClient, waitFor };
