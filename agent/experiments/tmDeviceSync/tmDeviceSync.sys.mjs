/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
const { ExtensionCommon: DeviceSyncExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
const { setTimeout: syncSetTimeout, clearTimeout: syncClearTimeout, setInterval: syncSetInterval, clearInterval: syncClearInterval } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

var tmDeviceSync = class extends DeviceSyncExtensionCommon.ExtensionAPIPersistent {
  constructor(extension) {
    super(extension);
    this.socket = null;
    this.host = null;
    this.ping = null;
    this.probe = null;
    this.retry = null;
    this.attempts = 0;
    this.listeners = new Set();
    this.PERSISTENT_EVENTS = {
      onEvent: ({ fire }) => {
        const listener = { fire };
        this.listeners.add(listener);
        return {
          unregister: () => this.listeners.delete(listener),
          convert: fire => { listener.fire = fire; },
        };
      },
    };
  }

  emit(event) {
    for (const listener of this.listeners) {
      listener.fire.async(event).catch(() => {});
    }
  }

  clearTimers() {
    if (this.ping) syncClearInterval(this.ping);
    if (this.probe) syncClearInterval(this.probe);
    if (this.retry) syncClearTimeout(this.retry);
    this.ping = this.probe = this.retry = null;
  }

  state() {
    if (this.retry !== null) return "retrying";
    return this.socket?.readyState === 1 ? "open" : this.socket?.readyState === 0 ? "connecting" : "closed";
  }

  connect(url) {
    const uri = Services.io.newURI(url);
    if (uri.scheme !== "wss" || !["sync.tabmail.ai", "sync-dev.tabmail.ai"].includes(uri.host) || uri.filePath !== "/ws" || uri.userPass) {
      throw new DeviceSyncExtensionCommon.ExtensionError("Invalid Device Sync endpoint");
    }
    if (this.state() !== "closed") return this.state();
    this.clearTimers();
    if (!this.host) this.host = Services.appShell.createWindowlessBrowser(true);
    const Socket = this.host.document.documentGlobal.WebSocket;
    const socket = new Socket(url);
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.attempts = 0;
      this.ping = syncSetInterval(() => {
        if (socket.readyState === Socket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
      }, 30000);
      this.probe = syncSetInterval(() => this.emit({ type: "probe" }), 300000);
      this.emit({ type: "open" });
    };
    socket.onmessage = event => {
      if (this.socket !== socket) return;
      try { if (JSON.parse(event.data).type === "pong") return; } catch {}
      this.emit({ type: "message", data: event.data });
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearTimers();
      // Failed handshakes already report disconnected. Do not wake startup
      // again after exhausting retries, which would start an unbounded loop.
      if (this.attempts >= 10) return;
      const delay = Math.min(5000 * 2 ** this.attempts++, 300000);
      this.retry = syncSetTimeout(() => {
        this.retry = null;
        // The background obtains fresh credentials for each reconnect.
        this.emit({ type: "reconnect" });
      }, delay);
      this.emit({ type: "close" });
    };
    return this.state();
  }

  disconnect() {
    const socket = this.socket;
    this.socket = null;
    this.clearTimers();
    this.attempts = 0;
    if (socket) socket.close();
    if (this.host) this.host.close();
    this.host = null;
  }

  onShutdown() {
    this.disconnect();
    this.listeners.clear();
  }

  getAPI(context) {
    return { tmDeviceSync: {
      onEvent: new DeviceSyncExtensionCommon.EventManager({ context, module: "tmDeviceSync", event: "onEvent", extensionApi: this }).api(),
      connect: url => this.connect(url),
      getState: () => this.state(),
      send: data => {
        if (this.state() !== "open") throw new DeviceSyncExtensionCommon.ExtensionError("Device Sync is disconnected");
        this.socket.send(data);
      },
      disconnect: () => this.disconnect(),
    } };
  }
};
