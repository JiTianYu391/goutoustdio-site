// 最小可运行示例：GoutouStdio 账号登录（OAuth 2.0 + PKCE）+ SpacePay 充值 + Webhook 验签。
// 只用 Node.js 内置模块，数据放内存——演示用，真实项目请换成数据库和更严格的会话管理。
//
// 运行前设置（或在同目录 .env 里 export）：
//   GS_CLIENT_ID=gs_app_…                  npm run app:create 生成
//   GS_BASE=https://goutoustdio.top        本地调站点时可换成 http://localhost:8080
//   SPACEPAY_BASE=https://pay.goutoustdio.top
//   SPACEPAY_KEY=sp_live_…                 SpacePay 商户后台创建
//   SPACEPAY_WEBHOOK_SECRET=whsec_…        商户后台「Webhook」页
import http from "node:http";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { catalog, acceptProduct, DEFAULT_PRODUCT } from "./products.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 5173;
const GS_BASE = (process.env.GS_BASE || "https://goutoustdio.top").replace(/\/$/, "");
const SPACEPAY_BASE = (process.env.SPACEPAY_BASE || "https://pay.goutoustdio.top").replace(/\/$/, "");
const CLIENT_ID = process.env.GS_CLIENT_ID || "";
const SPACEPAY_KEY = process.env.SPACEPAY_KEY || "";
const WEBHOOK_SECRET = process.env.SPACEPAY_WEBHOOK_SECRET || "";
const REDIRECT_URI = process.env.REDIRECT_URI || `http://localhost:${PORT}/oauth/callback`;

if (!CLIENT_ID) {
  console.error("缺少 GS_CLIENT_ID。先在站点跑：npm run app:create -- --name \"我的游戏\" --redirect " + REDIRECT_URI);
  process.exit(1);
}

// ---------- 内存数据 ----------
const sessions = new Map(); // sid -> { verifier, state, player }
const players = new Map();  // sub -> { sub, username, displayName, credits }
const orders = new Map();   // reference -> { reference, sub, sku, amountCents, status }
const seenEvents = new Set();

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

function sessionOf(req) {
  const sid = (req.headers.cookie || "").split(";").map((s) => s.trim()).find((s) => s.startsWith("gs_game="))?.slice(8);
  return { sid, sess: sid ? sessions.get(sid) : null };
}

function setSessionCookie(res, sid) {
  res.setHeader("Set-Cookie", `gs_game=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
}

// ---------- OAuth ----------
function pkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function exchangeCode(code, verifier) {
  const body = new URLSearchParams({
    grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID, code_verifier: verifier,
  });
  const r = await fetch(`${GS_BASE}/oauth/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`换取令牌失败：${data.error} ${data.error_description || ""}`);
  return data;
}

async function fetchUser(accessToken) {
  const r = await fetch(`${GS_BASE}/oauth/userinfo`, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!r.ok) throw new Error("读取用户信息失败");
  return r.json();
}

// ---------- 充值 ----------
async function createPayment(order) {
  const r = await fetch(`${SPACEPAY_BASE}/api/v1/payments`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${SPACEPAY_KEY}`,
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID(),
    },
    body: JSON.stringify({
      amount: (order.amountCents / 100).toFixed(2),
      reference: order.reference,
      description: order.name, // 由商品配置决定，没配就是「100 钻石」
      success_url: `${REDIRECT_URI.replace("/oauth/callback", "")}/recharge/done`,
      metadata: { gs_user_id: order.sub, gs_username: order.username, sku: order.sku },
    }),
  });
  const data = await r.json();
  if (!r.ok || !data.ok) throw new Error(`创建支付失败：${data.code || r.status} ${data.error || ""}`);
  const payment = data.payment;
  // 二维码接口返回的是相对路径，补上支付域名；直接当 <img src> 用
  payment.qr_url = payment.qr?.svg_url ? SPACEPAY_BASE + payment.qr.svg_url + "?size=256" : null;
  return payment;
}

// Webhook 可能晚到，页面轮询时顺手对一次账：只要支付单已成功，就补发货。
async function syncOrder(order) {
  if (order.status !== "pending" || !order.paymentId || !SPACEPAY_KEY) return order;
  try {
    const r = await fetch(`${SPACEPAY_BASE}/api/v1/payments/${order.paymentId}`, {
      headers: { authorization: `Bearer ${SPACEPAY_KEY}` },
    });
    const data = await r.json();
    if (data.ok && data.payment?.status === "SUCCEEDED") deliver(order);
  } catch { /* 对账失败就等 Webhook，轮询下次再试 */ }
  return order;
}

function deliver(order) {
  if (order.status === "paid") return;
  const p = players.get(order.sub);
  if (p) p.credits += order.credits;
  order.status = "paid";
  order.paidAt = Date.now();
}

function verifyWebhook(rawBody, header, secret, tolerance = 300) {
  const parts = Object.fromEntries(String(header || "").split(",").map((p) => p.split("=")));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > tolerance) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${parts.t}.`).update(rawBody).digest("hex");
  const a = Buffer.from(expected), b = Buffer.from(parts.v1 || "");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- 静态页 ----------
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };
async function serveStatic(res, pathname) {
  const file = pathname === "/" ? "index.html" : pathname.slice(1);
  if (file.includes("..")) return json(res, 400, { error: "bad path" });
  try {
    const buf = await readFile(path.join(__dirname, "public", file));
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(buf);
  } catch {
    json(res, 404, { error: "not found" });
  }
}

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const { pathname } = url;
  try {
    if (req.method === "GET" && pathname.startsWith("/api/order/")) {
      const { sess } = sessionOf(req);
      const order = orders.get(pathname.slice("/api/order/".length));
      if (!sess?.player || !order || order.sub !== sess.player.sub) return json(res, 404, { error: "订单不存在" });
      await syncOrder(order);
      return json(res, 200, {
        reference: order.reference, name: order.name, sku: order.sku, credits: order.credits,
        amount: (order.amountCents / 100).toFixed(2), status: order.status,
        checkout_url: order.checkoutUrl, qr_url: order.qrUrl,
        created_at: order.createdAt, expires_at: order.expiresAt,
      });
    }

    if (req.method === "GET" && pathname.startsWith("/pay/")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(await readFile(path.join(__dirname, "public", "pay.html")));
    }

    if (req.method === "GET" && pathname === "/api/state") {
      const { sess } = sessionOf(req);
      return json(res, 200, {
        player: sess?.player ? { ...sess.player, credits: players.get(sess.player.sub)?.credits ?? 0 } : null,
        products: catalog(),
        defaultProduct: { ...DEFAULT_PRODUCT },
      });
    }

    if (req.method === "GET" && pathname === "/login") {
      const { verifier, challenge } = pkce();
      const state = crypto.randomBytes(16).toString("hex");
      const sid = crypto.randomBytes(24).toString("base64url");
      sessions.set(sid, { verifier, state, player: null });
      setSessionCookie(res, sid);
      const auth = new URL(`${GS_BASE}/oauth/authorize`);
      auth.search = new URLSearchParams({
        response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
        scope: "profile email", state, code_challenge: challenge, code_challenge_method: "S256",
      }).toString();
      res.writeHead(302, { location: auth.toString() });
      return res.end();
    }

    if (req.method === "GET" && pathname === "/oauth/callback") {
      const { sess } = sessionOf(req);
      if (!sess) return json(res, 400, { error: "会话已过期，请重新登录" });
      if (url.searchParams.get("state") !== sess.state) return json(res, 400, { error: "state 不匹配，登录被拒绝" });
      if (url.searchParams.get("error")) return json(res, 400, { error: url.searchParams.get("error") });
      const tokens = await exchangeCode(url.searchParams.get("code"), sess.verifier);
      const user = await fetchUser(tokens.access_token);
      sess.player = { sub: user.sub, username: user.username, displayName: user.display_name || user.username };
      if (!players.has(user.sub)) players.set(user.sub, { ...sess.player, credits: 0 });
      res.writeHead(302, { location: "/" });
      return res.end();
    }

    if (req.method === "POST" && pathname === "/api/recharge") {
      const { sess } = sessionOf(req);
      if (!sess?.player) return json(res, 401, { error: "请先登录" });
      const body = await readBody(req);
      // 商品配置由客户端传：{ sku, name, price, credits }，服务端只做校验和兜底
      const product = acceptProduct(body.product || body);
      if (!product) return json(res, 400, { error: "商品配置不合法（price 需为两位小数的正数）" });
      const reference = `order-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
      const order = {
        reference, sub: sess.player.sub, username: sess.player.username,
        sku: product.sku, name: product.name, credits: product.credits,
        amountCents: Math.round(Number(product.price) * 100), status: "pending",
      };
      const payment = await createPayment(order);
      order.paymentId = payment.id;
      order.checkoutUrl = payment.checkout_url;
      order.qrUrl = payment.qr_url;
      order.createdAt = Date.now();
      order.expiresAt = payment.expires_at || Date.now() + 30 * 60 * 1000;
      orders.set(reference, order);
      return json(res, 200, { reference, pay_url: `/pay/${reference}`, checkout_url: payment.checkout_url });
    }

    if (req.method === "GET" && pathname === "/logout") {
      const { sid } = sessionOf(req);
      if (sid) sessions.delete(sid);
      res.writeHead(302, { location: "/", "set-cookie": "gs_game=; Path=/; Max-Age=0" });
      return res.end();
    }

    if (req.method === "GET" && pathname === "/recharge/done") {
      res.writeHead(302, { location: "/?paid=1" });
      return res.end();
    }

    if (req.method === "POST" && pathname === "/webhooks/spacepay") {
      const raw = await readRaw(req);
      if (!verifyWebhook(raw, req.headers["x-spacepay-signature"], WEBHOOK_SECRET)) {
        return json(res, 400, { error: "bad signature" });
      }
      const evt = JSON.parse(raw.toString("utf8"));
      if (seenEvents.has(evt.id)) return json(res, 200, { ok: true });
      seenEvents.add(evt.id);

      if (evt.type === "payment.succeeded") {
        const order = orders.get(evt.data.reference);
        if (!order) return json(res, 409, { error: "unknown order" });
        if (order.status === "paid") return json(res, 200, { ok: true });
        if (evt.data.amount_cents !== order.amountCents) return json(res, 400, { error: "amount mismatch" });
        deliver(order);
      }
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET") return serveStatic(res, pathname);
    return json(res, 404, { error: "not found" });
  } catch (err) {
    console.error(err);
    return json(res, 500, { error: String(err.message || err) });
  }
});

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
async function readBody(req) {
  const raw = await readRaw(req);
  try { return JSON.parse(raw.toString("utf8") || "{}"); } catch { return {}; }
}

server.listen(PORT, () => {
  console.log(`小游戏示例：http://localhost:${PORT}`);
  console.log(`回调地址：${REDIRECT_URI}`);
  if (!SPACEPAY_KEY) console.log("提示：未设置 SPACEPAY_KEY，充值按钮会失败");
  if (!WEBHOOK_SECRET) console.log("提示：未设置 SPACEPAY_WEBHOOK_SECRET，Webhook 验签会失败");
});
