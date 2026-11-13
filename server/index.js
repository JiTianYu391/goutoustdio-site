import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "./db.js";
import * as A from "./auth.js";
import { sendMail } from "./mail.js";

const app = express();
const PORT = Number(process.env.PORT) || 8080;
const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

app.set("trust proxy", 1); // FadeHost 反代
app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      // Cloudflare 会自动注入 Web Analytics 脚本（含一段内联初始化），这里放行它和截图所在的 raw.githubusercontent.com
      "script-src": ["'self'", "https://static.cloudflareinsights.com", "'sha256-f3hdOU1QscqxHyyMkQCCyaLeNK4GEvqsgMC25eSfQ+k='"],
      "connect-src": ["'self'", "https://cloudflareinsights.com"],
      "img-src": ["'self'", "data:", "https://raw.githubusercontent.com"],
      "upgrade-insecure-requests": null,
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use("/api", (_req, res, next) => { res.set("Cache-Control", "no-store"); res.set("Vary", "Cookie"); next(); });
app.use(cookieParser());
app.use("/api", express.json({ limit: "10kb" }));

// CSRF：SameSite=Lax + 对写请求校验 Origin 与 Host 一致
app.use("/api", (req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const o = req.get("origin");
  if (!o || new URL(o).host !== req.get("host")) return res.status(403).json({ error: "forbidden origin" });
  next();
});

app.use((req, _res, next) => { req.user = A.sessionUser(req.cookies[A.COOKIE]); next(); });
const need = (req, res, next) => req.user ? next() : res.status(401).json({ error: "未登录" });

const authLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: "尝试次数过多，请稍后再试" } });

const base = (req) => process.env.SITE_URL?.replace(/\/$/, "") || `${req.protocol}://${req.get("host")}`;
const HOUR = 3600 * 1000;
function sendVerify(req, uid, email) {
  const t = A.createEmailToken(uid, "verify", 24 * HOUR);
  sendMail(email, "验证你的 GoutouStdio 账号邮箱", "点击下面的链接验证邮箱（24 小时内有效）：", `${base(req)}/verify?token=${t}`)
    .catch((err) => console.error("[mail]", err.message));
}
const pub_ = (u) => ({ id: u.id, username: u.username, email: u.email, role: u.role, displayName: u.display_name || "", bio: u.bio || "", emailVerified: !!u.email_verified, createdAt: u.created_at });
const USER_RE = /^[A-Za-z0-9_一-龥-]{2,24}$/;
const MAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const str = (v) => (typeof v === "string" ? v : "");

app.post("/api/register", authLimit, async (req, res) => {
  const username = str(req.body.username).trim(), email = str(req.body.email).trim(), password = str(req.body.password);
  if (!USER_RE.test(username)) return res.status(400).json({ error: "用户名为 2–24 位字母、数字、中文、_ 或 -" });
  if (!MAIL_RE.test(email)) return res.status(400).json({ error: "邮箱格式不正确" });
  if (password.length < 8 || password.length > 128) return res.status(400).json({ error: "密码长度需为 8–128 位" });
  const dup = db.prepare("SELECT 1 FROM users WHERE username=? OR email=?").get(username, email);
  if (dup) return res.status(409).json({ error: "用户名或邮箱已被注册" });
  const admin = !!process.env.ADMIN_EMAIL && process.env.ADMIN_EMAIL.toLowerCase() === email.toLowerCase();
  const hash = await A.hashPassword(password);
  const r = db.prepare("INSERT INTO users (username,email,password_hash,role,created_at) VALUES (?,?,?,?,?)")
    .run(username, email, hash, admin ? "admin" : "user", Date.now());
  const uid = Number(r.lastInsertRowid);
  sendVerify(req, uid, email);
  A.setCookie(res, A.createSession(uid, req));
  res.status(201).json({ user: pub_(db.prepare("SELECT * FROM users WHERE id=?").get(r.lastInsertRowid)) });
});

app.post("/api/login", authLimit, async (req, res) => {
  const id = str(req.body.identifier).trim(), password = str(req.body.password);
  const u = db.prepare("SELECT * FROM users WHERE username=? OR email=?").get(id, id);
  // 用户不存在时也做一次哈希，避免时序差异泄露账号是否存在
  const ok = u ? await A.verifyPassword(password, u.password_hash) : (await A.hashPassword(password), false);
  if (!ok) return res.status(401).json({ error: "账号或密码错误" });
  A.setCookie(res, A.createSession(u.id, req));
  res.json({ user: pub_(u) });
});

app.post("/api/logout", (req, res) => {
  A.destroySession(req.cookies[A.COOKIE]);
  res.clearCookie(A.COOKIE, { path: "/" });
  res.json({ ok: true });
});

app.post("/api/verify", authLimit, (req, res) => {
  const uid = A.consumeEmailToken(req.body.token, "verify");
  if (!uid) return res.status(400).json({ error: "链接无效或已过期" });
  db.prepare("UPDATE users SET email_verified=1 WHERE id=?").run(uid);
  res.json({ ok: true });
});

app.post("/api/verify/resend", need, authLimit, (req, res) => {
  if (!req.user.email_verified) sendVerify(req, req.user.id, req.user.email);
  res.json({ ok: true });
});

// 不论邮箱是否存在都返回同样结果，避免枚举账号
app.post("/api/forgot", authLimit, (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE email=?").get(str(req.body.email).trim());
  if (u) {
    const t = A.createEmailToken(u.id, "reset", HOUR);
    sendMail(u.email, "重置 GoutouStdio 账号密码", "点击下面的链接重置密码（1 小时内有效）：", `${base(req)}/reset?token=${t}`)
      .catch((err) => console.error("[mail]", err.message));
  }
  res.json({ ok: true });
});

app.post("/api/reset", authLimit, async (req, res) => {
  const pw = str(req.body.password);
  if (pw.length < 8 || pw.length > 128) return res.status(400).json({ error: "密码长度需为 8–128 位" });
  const uid = A.consumeEmailToken(req.body.token, "reset");
  if (!uid) return res.status(400).json({ error: "链接无效或已过期" });
  db.prepare("UPDATE users SET password_hash=?, email_verified=1 WHERE id=?").run(await A.hashPassword(pw), uid);
  A.destroyUserSessions(uid);
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => res.json({ user: req.user ? pub_(req.user) : null }));

app.post("/api/password", need, authLimit, async (req, res) => {
  const cur = str(req.body.current), next = str(req.body.next);
  if (next.length < 8 || next.length > 128) return res.status(400).json({ error: "新密码长度需为 8–128 位" });
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
  if (!(await A.verifyPassword(cur, u.password_hash))) return res.status(401).json({ error: "当前密码错误" });
  db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(await A.hashPassword(next), u.id);
  A.destroyUserSessions(u.id, req.cookies[A.COOKIE]); // 踢掉其他设备
  res.json({ ok: true });
});

app.delete("/api/account", need, authLimit, async (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
  if (str(req.body.confirm).trim().toLowerCase() !== u.username.toLowerCase()) return res.status(400).json({ error: "请输入你的用户名以确认注销" });
  if (!(await A.verifyPassword(str(req.body.password), u.password_hash))) return res.status(401).json({ error: "密码错误" });
  db.prepare("DELETE FROM users WHERE id=?").run(u.id);
  res.clearCookie(A.COOKIE, { path: "/" });
  res.json({ ok: true });
});

app.patch("/api/profile", need, (req, res) => {
  const displayName = str(req.body.displayName).trim(), bio = str(req.body.bio).trim();
  if (displayName.length > 32) return res.status(400).json({ error: "昵称最多 32 字" });
  if (bio.length > 200) return res.status(400).json({ error: "简介最多 200 字" });
  db.prepare("UPDATE users SET display_name=?, bio=? WHERE id=?").run(displayName, bio, req.user.id);
  res.json({ user: pub_(db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id)) });
});

// 改邮箱：需当前密码；新邮箱重新验证
app.post("/api/email", need, authLimit, async (req, res) => {
  const email = str(req.body.email).trim();
  if (!MAIL_RE.test(email)) return res.status(400).json({ error: "邮箱格式不正确" });
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
  if (!(await A.verifyPassword(str(req.body.password), u.password_hash))) return res.status(401).json({ error: "密码错误" });
  if (db.prepare("SELECT 1 FROM users WHERE email=? AND id<>?").get(email, u.id)) return res.status(409).json({ error: "该邮箱已被使用" });
  db.prepare("UPDATE users SET email=?, email_verified=0 WHERE id=?").run(email, u.id);
  sendVerify(req, u.id, email);
  res.json({ user: pub_(db.prepare("SELECT * FROM users WHERE id=?").get(u.id)) });
});

app.get("/api/sessions", need, (req, res) => res.json({ sessions: A.listSessions(req.user.id, req.user.sid) }));
app.post("/api/sessions/revoke-others", need, (req, res) => { A.destroyUserSessions(req.user.id, req.cookies[A.COOKIE]); res.json({ ok: true }); });
app.delete("/api/sessions/:handle", need, (req, res) => {
  A.revokeHandle(req.user.id, String(req.params.handle).slice(0, 16));
  res.json({ ok: true });
});

// ---- 评论：每个页面一个讨论区；登录且验证邮箱后可发言 ----
const PAGE_RE = /^[a-z0-9-]{1,40}$/;
const postLimit = rateLimit({ windowMs: 60 * 1000, limit: 6, standardHeaders: true, legacyHeaders: false,
  message: { error: "发言太快了，请稍后再试" } });
app.get("/api/comments", (req, res) => {
  const page = str(req.query.page);
  if (!PAGE_RE.test(page)) return res.status(400).json({ error: "页面参数无效" });
  const rows = db.prepare(`SELECT c.id, c.body, c.created_at, u.id AS uid, u.username, u.display_name, u.role
    FROM comments c JOIN users u ON u.id=c.user_id WHERE c.page=? ORDER BY c.id DESC LIMIT 100`).all(page);
  res.json({ comments: rows.map((r) => ({ id: r.id, body: r.body, createdAt: r.created_at, author: r.display_name || r.username,
    admin: r.role === "admin", mine: req.user?.id === r.uid })), canPost: !!req.user?.email_verified, loggedIn: !!req.user, isAdmin: req.user?.role === "admin" });
});
app.post("/api/comments", need, postLimit, (req, res) => {
  const page = str(req.body.page), body = str(req.body.body).trim();
  if (!PAGE_RE.test(page)) return res.status(400).json({ error: "页面参数无效" });
  if (!req.user.email_verified) return res.status(403).json({ error: "请先验证邮箱后再发言" });
  if (body.length < 1 || body.length > 1000) return res.status(400).json({ error: "内容需为 1–1000 字" });
  db.prepare("INSERT INTO comments (page,user_id,body,created_at) VALUES (?,?,?,?)").run(page, req.user.id, body, Date.now());
  res.status(201).json({ ok: true });
});
app.delete("/api/comments/:id", need, (req, res) => {
  const c = db.prepare("SELECT * FROM comments WHERE id=?").get(Number(req.params.id));
  if (!c) return res.status(404).json({ error: "不存在" });
  if (c.user_id !== req.user.id && req.user.role !== "admin") return res.status(403).json({ error: "无权限" });
  db.prepare("DELETE FROM comments WHERE id=?").run(c.id);
  res.json({ ok: true });
});

app.get("/api/admin/users", need, (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "无权限" });
  res.json({ users: db.prepare("SELECT id,username,email,role,created_at FROM users ORDER BY id").all().map(pub_) });
});

app.use("/api", (_req, res) => res.status(404).json({ error: "not found" }));

app.get(["/login", "/register", "/account", "/verify", "/forgot", "/reset"], (req, res) => res.sendFile(path.join(pub, req.path.slice(1) + ".html")));
app.use(express.static(pub, { extensions: ["html"] }));
app.use((_req, res) => res.status(404).sendFile(path.join(pub, "index.html")));
app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: "服务器错误" }); });

setInterval(A.cleanupExpired, 3600 * 1000).unref();
app.listen(PORT, "0.0.0.0", () => console.log(`listening on :${PORT}`));
