/**
 * Virtual network switch that routes ethernet frames between v86 VMs.
 * Implements hub behavior: packets from one VM are broadcast to all others.
 */
class VirtualSwitch {
  constructor() {
    this.ports = new Map(); // vmId -> FakeWebSocket
  }

  createSocket(vmId) {
    const socket = new FakeWebSocket(this, vmId);
    this.ports.set(vmId, socket);
    return socket;
  }

  broadcast(fromId, data) {
    for (const [id, socket] of this.ports) {
      if (id !== fromId && socket.readyState === 1) {
        socket._deliver(data);
      }
    }
  }

  disconnect(vmId) {
    this.ports.delete(vmId);
  }
}

/**
 * Fake WebSocket that v86's NetworkAdapter connects to.
 * Instead of going over the wire, packets route through the VirtualSwitch.
 */
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(vswitch, vmId) {
    this.readyState = FakeWebSocket.CONNECTING;
    this.binaryType = "arraybuffer";
    this.extensions = "";
    this.protocol = "";
    this.bufferedAmount = 0;

    this._switch = vswitch;
    this._vmId = vmId;

    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;

    this._listeners = new Map();

    // Simulate async connection (v86 expects this)
    setTimeout(() => {
      this.readyState = FakeWebSocket.OPEN;
      if (this.onopen) this.onopen(new Event("open"));
    }, 0);
  }

  send(data) {
    if (this.readyState !== FakeWebSocket.OPEN) return;
    let buf;
    if (data instanceof ArrayBuffer) {
      buf = data;
    } else if (ArrayBuffer.isView(data)) {
      buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    } else {
      console.warn("FakeWebSocket.send: unsupported data type", typeof data);
      return;
    }
    if (buf) this._switch.broadcast(this._vmId, buf);
  }

  _deliver(arrayBuffer) {
    if (this.readyState !== FakeWebSocket.OPEN) return;
    const event = new MessageEvent("message", { data: arrayBuffer });
    if (this.onmessage) this.onmessage(event);
    const listeners = this._listeners.get("message");
    if (listeners) listeners.forEach(fn => fn(event));
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED || this.readyState === FakeWebSocket.CLOSING) return;
    this.readyState = FakeWebSocket.CLOSING;
    this._switch.disconnect(this._vmId);
    this.readyState = FakeWebSocket.CLOSED;
    if (this.onclose) {
      setTimeout(() => this.onclose(new CloseEvent("close")), 0);
    }
  }

  addEventListener(type, listener) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(listener);
  }

  removeEventListener(type, listener) {
    const list = this._listeners.get(type);
    if (!list) return;
    const idx = list.indexOf(listener);
    if (idx !== -1) list.splice(idx, 1);
  }

  dispatchEvent() { return true; }
}
