import * as Y from 'yjs'

/**
 * Lightweight Yjs provider that transports CRDT updates over an existing
 * Socket.IO connection.  No separate WebSocket, no extra auth — just two
 * events: `yjs-update` (client → server → peers) and the initial sync
 * baked into the `init-room` payload.
 *
 * Usage:
 *   const provider = new SocketIOProvider({ doc, socket, roomId })
 *   // ... use doc.getText('code-javascript') with MonacoBinding ...
 *   provider.destroy()
 */
export class SocketIOProvider {
  constructor({ doc, socket, roomId, onBeforeApply, onAfterApply }) {
    this.doc = doc
    this.socket = socket
    this.roomId = roomId
    this.onBeforeApply = onBeforeApply || null
    this.onAfterApply = onAfterApply || null

    this._onUpdate = (update, origin) => {
      // `origin !== this` filters out updates we applied from remote,
      // preventing echo loops.
      if (origin !== this) {
        this.socket.emit('yjs-update', {
          roomId: this.roomId,
          update: Array.from(update),
        })
      }
    }

    this._onRemoteUpdate = ({ update }) => {
      if (this.onBeforeApply) this.onBeforeApply()
      Y.applyUpdate(this.doc, new Uint8Array(update), this)
      // Run afterApply on a microtask so any synchronous Monaco
      // cursor event from the model update can fire first.
      if (this.onAfterApply) queueMicrotask(this.onAfterApply)
    }

    this.doc.on('update', this._onUpdate)
    this.socket.on('yjs-update', this._onRemoteUpdate)
  }

  destroy() {
    this.doc.off('update', this._onUpdate)
    this.socket.off('yjs-update', this._onRemoteUpdate)
  }
}
