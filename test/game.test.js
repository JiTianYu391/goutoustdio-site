// GS 仓库枪战：HTTP 入口、WebSocket 匹配、移动、开镜/狙击与掉线机器人接管
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

const tmpDir = mkdtempSync(path.join(tmpdir(), "gs-game-test-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "test";
process.env.SITE_URL = "http://127.0.0.1";
process.env.ADMIN_EMAIL = "admin@goutoustdio.top";

const { app } = await import("../server/index.js");
const { attachGameServer, closeGameServer } = await import("../server/game/index.js");

let server;
let base;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  server = app.listen(0);
  attachGameServer(server);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  closeGameServer();
  server.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function open(name) {
  const ws = new WebSocket(`${base.replace("http", "ws")}/ws/game`);
  const c = { ws, name, msgs: [], closed: false };
  ws.on("message", (d) => {
    try { c.msgs.push(JSON.parse(d.toString())); } catch { /* ignore */ }
  });
  ws.on("close", () => { c.closed = true; });
  return new Promise((resolve, reject) => {
    ws.on("open", () => {
      ws.send(JSON.stringify({ t: "hello", v: 1, name }));
      resolve(c);
    });
    ws.on("error", reject);
  });
}

function send(c, obj) {
  c.ws.send(JSON.stringify(obj));
}

async function waitFor(c, pred, timeout = 9000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const found = c.msgs.find(pred);
    if (found) return found;
    if (c.closed) throw new Error(`socket ${c.name} closed`);
    await sleep(25);
  }
  throw new Error(`timeout waiting in ${c.name}`);
}

function latest(c, pred) {
  for (let i = c.msgs.length - 1; i >= 0; i--) {
    if (pred(c.msgs[i])) return c.msgs[i];
  }
  return null;
}

test("GET /game 返回游戏页并允许 WebSocket CSP", async () => {
  const r = await fetch(`${base}/game`);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /GS 仓库枪战/);
  assert.match(html, /辅助瞄准/);
  assert.match(html, /minimap/);
  const csp = r.headers.get("content-security-policy") || "";
  assert.match(csp, /ws:/);
  assert.match(csp, /wss:/);
});

test("双人房间、移动、开镜狙击与机器人接管", async () => {
  const a = await open("测试甲");
  await waitFor(a, (m) => m.t === "welcome");
  send(a, { t: "create" });
  const roomA = await waitFor(a, (m) => m.t === "room");
  assert.equal(roomA.state, "waiting");
  assert.ok(/^[A-Z0-9]{5}$/.test(roomA.code));

  const b = await open("测试乙");
  await waitFor(b, (m) => m.t === "welcome");
  send(b, { t: "join", code: roomA.code });
  await waitFor(b, (m) => m.t === "room" && (m.seats || []).filter(Boolean).length === 2);
  const start = await waitFor(a, (m) => m.t === "start");
  assert.ok(start.countdown >= 3);

  await waitFor(a, (m) => m.t === "snapshot" && m.state === "live", 10000);
  await waitFor(b, (m) => m.t === "snapshot" && m.state === "live", 10000);

  const s0 = latest(a, (m) => m.t === "snapshot" && m.state === "live");
  assert.ok(s0?.you);

  let seq = 0;
  const sendInput = (c, extra = {}) => send(c, {
    t: "input",
    seq: ++seq,
    keys: extra.keys || 0,
    yaw: extra.yaw ?? s0.you.yaw,
    pitch: extra.pitch ?? 0,
    fire: !!extra.fire,
    reload: !!extra.reload,
    aim: !!extra.aim,
    slot: extra.slot || 0,
  });

  for (let i = 0; i < 30; i++) {
    sendInput(a, { keys: 1 });
    await sleep(33);
  }
  await sleep(250);
  const s1 = latest(a, (m) => m.t === "snapshot" && m.state === "live");
  assert.ok(s1.you.ack >= 20, `ack ${s1.you.ack}`);
  const moved = Math.hypot(s1.you.x - s0.you.x, s1.you.z - s0.you.z);
  assert.ok(moved > 0.4, `moved ${moved}`);

  sendInput(a, { keys: 0, aim: true, slot: 3 });
  await sleep(300);
  const s2 = latest(a, (m) => m.t === "snapshot" && m.state === "live");
  assert.equal(s2.you.weapon, "sniper");
  assert.equal(s2.you.aiming, true);

  await sleep(400);
  const before = s2.you.ammo.sniper.mag;
  sendInput(a, { keys: 0, aim: true, fire: true });
  const s3 = await waitFor(
    a,
    (m) => m.t === "snapshot" && m.state === "live" && m.you.ammo.sniper.mag < before,
    3000
  );
  assert.equal(s3.you.ammo.sniper.mag, before - 1);
  assert.ok(
    a.msgs.some((m) => m.t === "snapshot" && (m.events || []).some((e) => e.type === "shot")),
    "shot event"
  );

  send(b, { t: "leave" });
  const toast = await waitFor(a, (m) => m.t === "toast" && /机器人/.test(m.message), 5000);
  assert.match(toast.message, /机器人/);
  await waitFor(a, (m) => m.t === "snapshot" && (m.players || []).some((p) => p.bot), 5000);

  a.ws.close();
  b.ws.close();
});
