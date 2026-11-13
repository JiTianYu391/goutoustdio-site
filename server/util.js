import crypto from "node:crypto";
import rateLimit from "express-rate-limit";
import { db, siteSecret } from "./db.js";
import * as A from "./auth.js";
import { sendNotice } from "./mail.js";

export const HOUR = 3600 * 1000;
export const str = (v) => (typeof v === "string" ? v : "");
export const USER_RE = /^[A-Za-z0-9_一-龥-]{2,24}$/;
export const MAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
export const PAGE_RE = /^[a-z0-9-]{1,40}$/;
export const TOPICS = { pyspos: "PySpOS 版本更新", spaceos: "SpaceOS 版本更新", announce: "站点公告", replies: "有人回复我的评论" };

/** 站点地址：邮件链接、Passkey 的 origin / rpID 都以它为准 */
export const base = (req) => process.env.SITE_URL?.replace(/\/$/, "") || `${req.protocol}://${req.get("host")}`;

const lim = (windowMs, limit, error) => rateLimit({ windowMs, limit, standardHeaders: true, legacyHeaders: false, message: { error } });
export const authLimit = lim(15 * 60 * 1000, 30, "尝试次数过多，请稍后再试");
export const postLimit = lim(60 * 1000, 8, "操作太快了，请稍后再试");

export const need = (req, res, next) => (req.user ? next() : res.status(401).json({ error: "未登录" }));
export const needAdmin = (req, res, next) =>
  !req.user ? res.status(401).json({ error: "未登录" }) : req.user.role !== "admin" ? res.status(403).json({ error: "无权限" }) : next();
export const needVerified = (req, res, next) => (req.user.email_verified ? next() : res.status(403).json({ error: "请先验证邮箱" }));
/** 敏感操作：10 分钟内需确认过密码。前端收到 sudo:true 会弹出确认框后重试 */
export const needSudo = (req, res, next) =>
  req.user.sudo_until > Date.now() ? next() : res.status(403).json({ error: "请先确认密码", sudo: true });

export const getUser = (id) => db.prepare("SELECT * FROM users WHERE id=?").get(id);
export const pubUser = (u) => ({
  id: u.id, username: u.username, email: u.email, role: u.role, displayName: u.display_name || "", bio: u.bio || "",
  emailVerified: !!u.email_verified, twoFactor: !!u.totp_secret, createdAt: u.created_at,
});
/** 公开信息：不含邮箱 */
export const publicUser = (u) => ({ username: u.username, displayName: u.display_name || "", bio: u.bio || "", admin: u.role === "admin", createdAt: u.created_at });

/** 管理员 = 邮箱等于 ADMIN_EMAIL 且已验证；条件不满足时自动降级 */
export function syncAdmin(userId) {
  const want = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const u = db.prepare("SELECT email, email_verified, role FROM users WHERE id=?").get(userId);
  if (!u) return;
  const role = want && u.email.toLowerCase() === want && u.email_verified ? "admin" : "user";
  if (role !== u.role) db.prepare("UPDATE users SET role=? WHERE id=?").run(role, userId);
}

export const mailLater = (p) => p.catch((err) => console.error("[mail]", err.message));

export function sendVerify(req, uid, email) {
  const t = A.createEmailToken(uid, "verify", 24 * HOUR);
  mailLater(sendNotice(email, "验证你的 GoutouStdio 账号邮箱", ["点击下面的按钮验证邮箱，链接 24 小时内有效。"],
    { link: `${base(req)}/verify?token=${t}`, linkText: "验证邮箱" }));
}

/** 安全提醒：密码、两步验证、Passkey 变动时通知本人 */
export function securityNotice(req, user, what) {
  mailLater(sendNotice(user.email, `安全提醒：${what}`, [
    `你的 GoutouStdio 账号 ${user.username} 刚刚${what}。`,
    `时间：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}（北京时间）\nIP：${req.ip || "未知"}`,
    "如果这不是你本人的操作，请立即重置密码并检查登录设备。",
  ], { link: `${base(req)}/account#security`, linkText: "检查账号安全" }));
}

/** 退订链接：HMAC 签名，免登录一键退订 */
export function unsubSig(userId, topic) {
  return crypto.createHmac("sha256", siteSecret()).update(`${userId}:${topic}`).digest("base64url").slice(0, 32);
}
export const unsubLink = (req, userId, topic) => `${base(req)}/api/unsubscribe?u=${userId}&t=${topic}&s=${unsubSig(userId, topic)}`;
export const isSubscribed = (userId, topic) => !!db.prepare("SELECT 1 FROM subscriptions WHERE user_id=? AND topic=?").get(userId, topic);
