// 注册 / 登录（含两步验证）/ 退出 / 邮箱验证 / 找回密码
import { Router } from "express";
import { verify as totpVerify } from "otplib";
import { db } from "../db.js";
import * as A from "../auth.js";
import { sendNotice } from "../mail.js";
import { str, USER_RE, MAIL_RE, EXAM_NO_RE, HOUR, authLimit, need, base, getUser, pubUser, syncAdmin, sendVerify, mailLater } from "../util.js";

const r = Router();
const mfaCookie = { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/api/login", maxAge: 5 * 60 * 1000 };

r.post("/register", authLimit, async (req, res) => {
  const username = str(req.body.username).trim(), email = str(req.body.email).trim(), password = str(req.body.password);
  if (!USER_RE.test(username)) return res.status(400).json({ error: "用户名为 2–24 位字母、数字、中文、_ 或 -" });
  if (!MAIL_RE.test(email)) return res.status(400).json({ error: "邮箱格式不正确" });
  if (password.length < 8 || password.length > 128) return res.status(400).json({ error: "密码长度需为 8–128 位" });
  if (db.prepare("SELECT 1 FROM users WHERE username=? OR email=?").get(username, email)) return res.status(409).json({ error: "用户名或邮箱已被注册" });
  const hash = await A.hashPassword(password);
  const uid = Number(db.prepare("INSERT INTO users (username,email,password_hash,role,created_at) VALUES (?,?,?,?,?)")
    .run(username, email, hash, "user", Date.now()).lastInsertRowid);
  db.prepare("INSERT OR IGNORE INTO subscriptions (user_id, topic) VALUES (?, 'replies')").run(uid); // 回复提醒默认开启
  sendVerify(req, uid, email);
  A.setCookie(res, A.createSession(uid, req));
  res.status(201).json({ user: pubUser(getUser(uid)) });
});

function finishLogin(req, res, uid) {
  syncAdmin(uid);
  A.setCookie(res, A.createSession(uid, req));
  res.clearCookie(A.MFA_COOKIE, { path: "/api/login" });
  res.json({ user: pubUser(getUser(uid)) });
}

r.post("/login", authLimit, async (req, res) => {
  const id = str(req.body.identifier).trim(), password = str(req.body.password);
  let u = db.prepare("SELECT * FROM users WHERE username=? OR email=?").get(id, id);
  if (!u && EXAM_NO_RE.test(id)) u = db.prepare("SELECT * FROM users WHERE exam_no=?").get(id);
  // 用户不存在时也做一次哈希，避免时序差异泄露账号是否存在
  const ok = u ? await A.verifyPassword(password, u.password_hash) : (await A.hashPassword(password), false);
  if (!ok) return res.status(401).json({ error: "账号或密码错误" });
  if (u.banned) return res.status(403).json({ error: `账号已被封禁${u.ban_reason ? "：" + u.ban_reason : ""}` });
  if (u.totp_secret) {
    res.cookie(A.MFA_COOKIE, A.createMfaPending(u.id), mfaCookie);
    return res.json({ mfa: "totp" });
  }
  finishLogin(req, res, u.id);
});

// 第二步：6 位验证码或恢复码
r.post("/login/2fa", authLimit, async (req, res) => {
  const p = A.getMfaPending(req.cookies[A.MFA_COOKIE]);
  if (!p) return res.status(400).json({ error: "验证已过期，请重新输入密码", restart: true });
  const u = getUser(p.user_id);
  const code = str(req.body.code).trim().replace(/\s/g, "");
  let ok = false;
  if (/^\d{6}$/.test(code) && u.totp_secret) {
    const v = await totpVerify({ secret: u.totp_secret, token: code, epochTolerance: 30, afterTimeStep: u.totp_last_step || undefined });
    if (v.valid) { ok = true; db.prepare("UPDATE users SET totp_last_step=? WHERE id=?").run(v.timeStep, u.id); }
  } else if (code.length >= 10) {
    ok = A.useRecoveryCode(u.id, code);
    if (ok) mailLater(sendNotice(u.email, "安全提醒：使用了恢复码登录", [`你的账号 ${u.username} 刚刚使用一个恢复码登录，剩余 ${A.recoveryLeft(u.id)} 个。`, "如果这不是你本人的操作，请立即修改密码。"]));
  }
  if (!ok) { A.bumpMfaAttempt(p.id); return res.status(401).json({ error: "验证码错误" }); }
  A.clearMfaPending(p.id);
  finishLogin(req, res, u.id);
});

r.post("/logout", (req, res) => {
  A.destroySession(req.cookies[A.COOKIE]);
  res.clearCookie(A.COOKIE, { path: "/" });
  res.json({ ok: true });
});

r.get("/me", (req, res) => res.json({ user: req.user ? pubUser(getUser(req.user.id)) : null }));

// 确认密码，进入 10 分钟 sudo 模式
r.post("/sudo", need, authLimit, async (req, res) => {
  const u = getUser(req.user.id);
  if (!(await A.verifyPassword(str(req.body.password), u.password_hash))) return res.status(401).json({ error: "密码错误" });
  A.grantSudo(req.user.sid);
  res.json({ ok: true });
});

r.post("/verify", authLimit, (req, res) => {
  const uid = A.consumeEmailToken(req.body.token, "verify");
  if (!uid) return res.status(400).json({ error: "链接无效或已过期" });
  db.prepare("UPDATE users SET email_verified=1 WHERE id=?").run(uid);
  syncAdmin(uid);
  res.json({ ok: true });
});

r.post("/verify/resend", need, authLimit, (req, res) => {
  if (!req.user.email_verified) sendVerify(req, req.user.id, req.user.email);
  res.json({ ok: true });
});

// 不论邮箱是否存在都返回同样结果，避免枚举账号
r.post("/forgot", authLimit, (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE email=?").get(str(req.body.email).trim());
  if (u && !u.banned) {
    const t = A.createEmailToken(u.id, "reset", HOUR);
    mailLater(sendNotice(u.email, "重置 GoutouStdio 账号密码", ["点击下面的按钮重置密码，链接 1 小时内有效。", "如果你没有申请重置，忽略这封邮件即可。"],
      { link: `${base(req)}/reset?token=${t}`, linkText: "重置密码" }));
  }
  res.json({ ok: true });
});

// 重置密码不绕过两步验证：开启了 2FA 的账号重置后登录仍需验证码
r.post("/reset", authLimit, async (req, res) => {
  const pw = str(req.body.password);
  if (pw.length < 8 || pw.length > 128) return res.status(400).json({ error: "密码长度需为 8–128 位" });
  const uid = A.consumeEmailToken(req.body.token, "reset");
  if (!uid) return res.status(400).json({ error: "链接无效或已过期" });
  db.prepare("UPDATE users SET password_hash=?, email_verified=1 WHERE id=?").run(await A.hashPassword(pw), uid);
  syncAdmin(uid);
  A.destroyUserSessions(uid);
  res.json({ ok: true });
});

export default r;
