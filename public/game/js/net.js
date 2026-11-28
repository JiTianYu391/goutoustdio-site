// 浏览器端的 WebSocket 客户端：握手、心跳测延迟、会话恢复。

export class Net {
  constructor() {
    this.ws = null;
    this.session = null;
    this.name = "";
    this.handlers = new Map();
    this.rtt = 0.08;
    this.pingTimer = 0;
    this.lastPingAt = 0;
    this.connected = false;
    this.welcome = null;
    this.manualClose = false;
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
    return this;
  }

  emit(type, data) {
    const list = this.handlers.get(type);
    if (!list) return;
    for (const fn of list.slice()) {
      try { fn(data); } catch (err) { console.error("[net]", err); }
    }
  }

  isOpen() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  connect({ name, session } = {}) {
    if (this.ws) {
      const old = this.ws;
      old._gsIgnore = true;
      try { old.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.manualClose = false;
    this.connected = false;
    if (name) this.name = name;
    if (session !== undefined && session !== null) this.session = session;

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/ws/game`;

    return new Promise((resolve, reject) => {
      let settled = false;
      let ws;
      try {
        ws = new WebSocket(url);
      } catch (err) {
        reject(err);
        return;
      }
      this.ws = ws;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch { /* ignore */ }
        reject(new Error("连接超时"));
      }, 12000);

      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(err);
      };

      ws.onopen = () => {
        const hello = { t: "hello", v: 1, name: this.name };
        if (this.session) hello.session = this.session;
        ws.send(JSON.stringify(hello));
      };

      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.t === "welcome") {
          this.session = msg.id;
          this.welcome = msg;
          this.connected = true;
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            this.startPing();
            resolve(msg);
          }
        }
        if (msg.t === "pong") {
          const ts = Number(msg.ts);
          if (Number.isFinite(ts) && ts > 0) {
            const rtt = Math.max(0.005, Math.min(0.6, performance.now() / 1000 - ts));
            this.rtt = this.rtt * 0.7 + rtt * 0.3;
          }
        }
        if (msg.t === "error" && msg.fatal) this.emit("fatal", msg);
        this.emit("message", msg);
        this.emit(msg.t, msg);
      };

      ws.onerror = () => {
        if (!this.connected) fail(new Error("无法连接游戏服务器"));
      };

      ws.onclose = (ev) => {
        if (ws._gsIgnore) return;
        const wasConnected = this.connected;
        this.connected = false;
        this.stopPing();
        if (this.ws === ws) this.ws = null;
        if (!settled) {
          fail(new Error("连接已关闭"));
          return;
        }
        if (wasConnected) this.emit("close", { code: ev.code, reason: ev.reason });
      };
    });
  }

  startPing() {
    this.stopPing();
    const ping = () => {
      if (!this.isOpen()) return;
      this.lastPingAt = performance.now() / 1000;
      this.send({ t: "ping", ts: this.lastPingAt, rtt: +this.rtt.toFixed(3) });
    };
    ping();
    this.pingTimer = setInterval(ping, 2000);
    this.emit("rtt", this.rtt);
  }

  stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = 0;
  }

  send(obj) {
    if (!this.isOpen()) return false;
    try {
      this.ws.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  close() {
    this.manualClose = true;
    this.stopPing();
    if (this.ws) {
      const ws = this.ws;
      ws._gsIgnore = true;
      try { ws.close(1000, "client leave"); } catch { /* ignore */ }
      this.ws = null;
    }
    this.connected = false;
  }
}
