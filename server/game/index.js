// WebSocket 入口：会话、快速匹配、邀请码房间与房间清理。

import { WebSocketServer } from "ws";
import { randomInt, randomBytes } from "node:crypto";
import { Room } from "./room.js";
import { PROTOCOL_VERSION, TICK_RATE } from "../../public/game/js/shared.js";

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 8 * 1024,
  perMessageDeflate: false,
});
const rooms = new Map();
const sessions = new Map();
const ipCounts = new Map();
const attachedServers = new WeakSet();
const ROOM_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const MAX_ROOMS = 300;

let tickTimer = null;
let cleanTimer = null;
let heartbeatTimer = null;

function randomCode() {
  let out = "";
  for (let i = 0; i < 5; i++) out += ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)];
  return out;
}

function uniqueCode() {
  for (let i = 0; i < 30; i++) {
    const code = randomCode();
    if (!rooms.has(code)) return code;
  }
  return randomBytes(4).toString("hex").toUpperCase();
}

function send(ws, obj) {
  if (!ws || ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(obj));
  } catch {
    /* socket closing */
  }
}

function connection(ws, req) {
  const ip = req.socket.remoteAddress || "unknown";
  const c = {
    ws,
    ip,
    name: "玩家",
    session: null,
    room: null,
    player: null,
    greeted: false,
    closed: false,
    windowStart: Date.now(),
    msgCount: 0,
    bytes: 0,
  };
  ws._game = c;
  c.send = (obj) => send(c.ws, obj);
  c.sendRaw = (text) => {
    if (c.ws.readyState === 1) {
      try { c.ws.send(text); } catch { /* socket closing */ }
    }
  };
  ws.on("message", (data) => onMessage(c, data));
  ws.on("close", () => onClose(c));
  ws.on("error", () => {});
  ws.on("pong", () => { c.alive = true; });
  c.alive = true;
}

function cleanName(raw) {
  const s = String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f<>]/g, "")
    .trim()
    .slice(0, 12);
  if (s) return s;
  return `玩家${randomInt(10, 99)}`;
}

function ensureSession(c, name) {
  const s = {
    id: randomBytes(16).toString("hex"),
    name,
    roomCode: null,
    slot: null,
    conn: c,
    lastSeen: Date.now(),
  };
  sessions.set(s.id, s);
  return s;
}

function attachToRoom(c, session, room, seat) {
  if (!room || !seat || seat.bot) return false;
  if (seat.sessionId && seat.sessionId !== session.id) return false;
  if (seat.conn && seat.conn !== c) {
    const oldConn = seat.conn;
    oldConn.room = null;
    oldConn.player = null;
    try { oldConn.ws.close(4001, "session resumed elsewhere"); } catch { /* ignore */ }
  }
  const oldRoom = c.room;
  if (oldRoom && oldRoom !== room) oldRoom.removeSeat(c.player?.slot);
  seat.conn = c;
  seat.connected = true;
  seat.disconnectAt = 0;
  seat.sessionId = session.id;
  seat.inputQueue = [];
  c.room = room;
  c.player = seat;
  session.roomCode = room.code;
  session.slot = seat.slot;
  session.conn = c;
  session.lastSeen = Date.now();
  return true;
}

function onHello(c, msg) {
  if (c.greeted) {
    send(c.ws, { t: "error", message: "重复的握手消息" });
    return;
  }
  if ((msg.v | 0) !== PROTOCOL_VERSION) {
    send(c.ws, { t: "error", message: "客户端版本过旧，请刷新页面后重试", fatal: true });
    c.ws.close(4002, "version mismatch");
    return;
  }
  c.greeted = true;
  c.name = cleanName(msg.name);

  let session = null;
  if (typeof msg.session === "string" && /^[a-f0-9]{32}$/.test(msg.session)) {
    session = sessions.get(msg.session) || null;
  }
  let resumed = false;
  if (session) {
    if (session.conn && session.conn !== c) {
      const old = session.conn;
      old.room = null;
      old.player = null;
      try { old.ws.close(4001, "session resumed elsewhere"); } catch { /* ignore */ }
    }
    session.conn = c;
    session.lastSeen = Date.now();
    session.name = c.name;
    c.session = session;
    if (session.roomCode) {
      const room = rooms.get(session.roomCode);
      const seat = room?.seats[session.slot];
      if (room && seat && !seat.bot && seat.sessionId === session.id) {
        resumed = attachToRoom(c, session, room, seat);
      }
      if (!resumed) {
        session.roomCode = null;
        session.slot = null;
      }
    }
  } else {
    c.session = ensureSession(c, c.name);
  }
  c.sessionId = c.session.id;

  send(c.ws, {
    t: "welcome",
    id: c.session.id,
    name: c.name,
    version: PROTOCOL_VERSION,
    serverTime: Date.now() / 1000,
    resumed,
  });
  if (resumed && c.room) {
    const other = c.room.other(c.player.slot);
    if (other?.conn) other.conn.send({ t: "toast", message: "对手已重新连接" });
    c.room.broadcastRoomInfo();
    c.room.pushSnapshot(true);
  }
}

function leaveRoom(c, silent = false) {
  if (!c.room || !c.player) {
    c.room = null;
    c.player = null;
    if (c.session) {
      c.session.roomCode = null;
      c.session.slot = null;
    }
    return false;
  }
  const room = c.room;
  const player = c.player;
  room.handleLeave(player);
  if (c.session) {
    c.session.roomCode = null;
    c.session.slot = null;
  }
  c.room = null;
  c.player = null;
  if (!silent) send(c.ws, { t: "left" });
  return true;
}

function createRoomFor(c, practice) {
  if (rooms.size >= MAX_ROOMS) {
    send(c.ws, { t: "error", message: "服务器房间已满，请稍后再试" });
    return null;
  }
  const code = uniqueCode();
  const room = new Room(code, { practice });
  rooms.set(code, room);
  return room;
}

function onMessage(c, data) {
  const now = Date.now();
  if (now - c.windowStart > 1000) {
    c.windowStart = now;
    c.msgCount = 0;
  }
  c.msgCount++;
  c.bytes += data.length;
  if (c.msgCount > 220 || c.bytes > 400 * 1024) {
    c.ws.close(4003, "rate limit");
    return;
  }

  let msg;
  try {
    msg = JSON.parse(data.toString("utf8"));
  } catch {
    return;
  }
  if (!msg || typeof msg !== "object") return;

  if (msg.t === "hello") {
    onHello(c, msg);
    return;
  }
  if (!c.greeted || !c.session) {
    send(c.ws, { t: "error", message: "请先完成握手" });
    return;
  }

  switch (msg.t) {
    case "ping": {
      const ts = Number(msg.ts) || 0;
      const rtt = Number(msg.rtt);
      if (c.player && Number.isFinite(rtt)) {
        c.player.rtt = Math.min(0.5, Math.max(0.01, rtt));
      }
      send(c.ws, { t: "pong", ts, now: Date.now() / 1000, serverTime: Date.now() / 1000 });
      break;
    }

    case "create": {
      if (c.room) leaveRoom(c, true);
      const practice = !!msg.practice;
      const room = createRoomFor(c, practice);
      if (!room) return;
      const ok = practice ? room.startPractice(c, c.name) : (room.addHuman(c, c.name) ? true : false);
      if (!ok) {
        rooms.delete(room.code);
        send(c.ws, { t: "error", message: "创建房间失败" });
        return;
      }
      c.session.roomCode = room.code;
      c.session.slot = c.player.slot;
      send(c.ws, room.roomInfoFor(c.player));
      break;
    }

    case "quick": {
      if (c.room) leaveRoom(c, true);
      let chosen = null;
      for (const room of rooms.values()) {
        if (room.state !== "waiting" || room.practice) continue;
        const humans = room.humans();
        if (humans.length !== 1) continue;
        if (!room.seats[0] || !room.seats[1]) {
          chosen = room;
          break;
        }
      }
      if (!chosen) {
        chosen = createRoomFor(c, false);
        if (!chosen) return;
      }
      const added = chosen.addHuman(c, c.name);
      if (!added) {
        if (!chosen.humans().length) rooms.delete(chosen.code);
        send(c.ws, { t: "error", message: "匹配失败，请重试" });
        return;
      }
      c.session.roomCode = chosen.code;
      c.session.slot = c.player.slot;
      send(c.ws, chosen.roomInfoFor(c.player));
      break;
    }

    case "join": {
      if (c.room) leaveRoom(c, true);
      const code = String(msg.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
      const room = rooms.get(code);
      if (!room) {
        send(c.ws, { t: "error", message: "房间不存在或已结束" });
        return;
      }
      if (room.practice) {
        send(c.ws, { t: "error", message: "该房间是单人练习，无法加入" });
        return;
      }
      if (room.state !== "waiting") {
        send(c.ws, { t: "error", message: "对局已经开始，无法加入" });
        return;
      }
      const seat = room.addHuman(c, c.name);
      if (!seat) {
        send(c.ws, { t: "error", message: "房间已满" });
        return;
      }
      c.session.roomCode = room.code;
      c.session.slot = seat.slot;
      send(c.ws, room.roomInfoFor(seat));
      break;
    }

    case "leave":
      leaveRoom(c);
      break;

    case "name": {
      const name = cleanName(msg.name);
      c.name = name;
      c.session.name = name;
      if (c.player && !c.player.bot && (!c.room || c.room.state === "waiting")) {
        c.player.name = name;
        c.room?.broadcastRoomInfo();
      }
      send(c.ws, { t: "name-ok", name });
      break;
    }

    case "rematch":
      if (!c.room) {
        send(c.ws, { t: "error", message: "你不在对局中" });
        return;
      }
      c.room.rematch();
      break;

    case "input": {
      const p = c.player;
      if (!p || c.room?.state !== "live" || p.bot) return;
      const seq = msg.seq | 0;
      if (seq <= 0 || seq > 2_000_000_000) return;
      if (seq <= (p.lastQueuedSeq || 0)) return;
      const nowMs = Date.now();
      if (!p.inputTokensAt) {
        p.inputTokens = 6;
        p.inputTokensAt = nowMs;
      } else {
        const dt = Math.min(0.5, (nowMs - p.inputTokensAt) / 1000);
        p.inputTokens = Math.min(6, p.inputTokens + dt * 36);
        p.inputTokensAt = nowMs;
      }
      if (p.inputTokens < 1) return;
      p.inputTokens -= 1;
      p.lastQueuedSeq = seq;

      const yaw = Number(msg.yaw);
      const pitch = Number(msg.pitch);
      if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return;
      c.room.queueInput(p, {
        seq,
        keys: (msg.keys | 0) & 0x7f,
        yaw,
        pitch,
        fire: !!msg.fire,
        reload: !!msg.reload,
        aim: !!msg.aim,
        slot: msg.slot === 1 || msg.slot === 2 || msg.slot === 3 ? msg.slot : 0,
        // 开火时客户端画面上敌人所处的服务器模拟时间，用于精确延迟补偿（由 room 夹到合法范围）
        rt: Number.isFinite(Number(msg.rt)) ? Number(msg.rt) : null,
      });
      break;
    }

    default:
      break;
  }
}

function onClose(c) {
  c.closed = true;
  const session = c.session;
  if (session) {
    session.lastSeen = Date.now();
    if (session.conn === c) session.conn = null;
  }
  if (c.room && c.player) {
    try { c.room.handleDisconnect(c.player); } catch { /* ignore */ }
  }
  c.room = null;
  c.player = null;
  const left = (ipCounts.get(c.ip) || 1) - 1;
  if (left <= 0) ipCounts.delete(c.ip);
  else ipCounts.set(c.ip, left);
}

function tickRooms() {
  for (const room of rooms.values()) {
    try {
      room.update();
    } catch (err) {
      console.error("[game] room tick failed", room.code, err);
    }
  }
}

function cleanup() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.closed) {
      rooms.delete(code);
      continue;
    }
    if (!room.humans().length) {
      if (!room.emptySince) room.emptySince = now;
      if (now - room.emptySince > 20000) {
        room.closed = true;
        rooms.delete(code);
        if (room.seats) {
          for (const s of room.seats) {
            if (s?.conn) {
              s.conn.room = null;
              s.conn.player = null;
              s.conn.send({ t: "toast", message: "房间已关闭" });
            }
          }
        }
      }
    } else {
      room.emptySince = 0;
    }
  }
  for (const [id, s] of sessions) {
    if (now - s.lastSeen > 10 * 60 * 1000) sessions.delete(id);
  }
}

export function attachGameServer(server) {
  if (!server || attachedServers.has(server)) return false;
  attachedServers.add(server);
  server.on("upgrade", (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url || "/", "http://localhost");
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== "/ws/game") {
      socket.destroy();
      return;
    }
    const origin = req.headers.origin;
    if (origin) {
      const allowed = new Set();
      const host = (req.headers.host || "").toLowerCase();
      if (host) allowed.add(host);
      const fwd = (req.headers["x-forwarded-host"] || "").toString().toLowerCase();
      if (fwd) allowed.add(fwd);
      try {
        const site = new URL(process.env.SITE_URL || "");
        if (site.host) allowed.add(site.host.toLowerCase());
      } catch { /* SITE_URL unset */ }
      let originHost = "";
      try { originHost = new URL(origin).host.toLowerCase(); } catch { /* invalid */ }
      if (!originHost || !allowed.has(originHost)) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
    }
    const ip = req.socket.remoteAddress || "unknown";
    if ((ipCounts.get(ip) || 0) >= 8) {
      socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ipCounts.set(ip, (ipCounts.get(ip) || 0) + 1);
      wss.emit("connection", ws, req);
    });
  });
  startTimers();
  return true;
}

function startTimers() {
  if (!tickTimer) {
    tickTimer = setInterval(tickRooms, 1000 / TICK_RATE);
    tickTimer.unref?.();
  }
  if (!cleanTimer) {
    cleanTimer = setInterval(cleanup, 2000);
    cleanTimer.unref?.();
  }
  if (!heartbeatTimer) {
    heartbeatTimer = setInterval(() => {
      for (const ws of wss.clients) {
        if (!ws._game?.alive) {
          try { ws.terminate(); } catch { /* ignore */ }
          continue;
        }
        ws._game.alive = false;
        try { ws.ping(); } catch { /* ignore */ }
      }
      for (const [id, s] of sessions) {
        if (Date.now() - s.lastSeen > 10 * 60 * 1000) sessions.delete(id);
      }
    }, 30000);
    heartbeatTimer.unref?.();
  }
}

export function closeGameServer() {
  if (tickTimer) clearInterval(tickTimer);
  if (cleanTimer) clearInterval(cleanTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  tickTimer = cleanTimer = heartbeatTimer = null;
  for (const ws of wss.clients) {
    try { ws.terminate(); } catch { /* ignore */ }
  }
  rooms.clear();
  sessions.clear();
  ipCounts.clear();
  wss.close();
}

wss.on("connection", connection);

export const gameStats = () => ({ rooms: rooms.size, sessions: sessions.size });
