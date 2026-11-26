// 会话方案参照 Lucia 的 "Sessions" 指南 + OWASP 建议：
// 随机 token 放 HttpOnly cookie，库里只存 sha256(token)；密码用 scrypt（OWASP 认可）。
import crypto from "node:crypto";
import { promisify } from "node:util";
import { db } from "./db.js";

const scrypt = promisify(crypto.scrypt);
const SESSION_MS = 30 * 24 * 3600 * 1000;
export const COOKIE = "gs_session";
export const EXAM_COOKIE = "gs_exam_session";
export const EXAM_DETACHED_COOKIE = "gs_exam_detached";

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64, { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}
export async function verifyPassword(pw, stored) {
  const [, s, k] = stored.split("$");
  const key = await scrypt(pw, Buffer.from(s, "base64"), 64, { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  return crypto.timingSafeEqual(key, Buffer.from(k, "base64"));
}
const sha = (t) => crypto.createHash("sha256").update(t).digest("hex");

export function createSession(userId, req) {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  db.prepare("INSERT INTO sessions (id, user_id, expires_at, created_at, last_seen, ua, ip) VALUES (?,?,?,?,?,?,?)")
    .run(sha(token), userId, now + SESSION_MS, now, now, String(req?.get("user-agent") || "").slice(0, 300), String(req?.ip || "").slice(0, 64));
  return token;
}
export function destroySession(token) {
  if (token) db.prepare("DELETE FROM sessions WHERE id=?").run(sha(token));
}
export function destroyUserSessions(userId, exceptToken) {
  db.prepare("DELETE FROM sessions WHERE user_id=? AND id<>?").run(userId, exceptToken ? sha(exceptToken) : "");
}
export function sessionUser(token) {
  if (!token) return null;
  const row = db.prepare(`SELECT u.id, u.username, u.email, u.role, u.email_verified, u.display_name, u.bio, u.created_at, u.banned, u.totp_secret, s.expires_at, s.last_seen, s.sudo_until, s.id AS sid
    FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=?`).get(sha(token));
  if (!row) return null;
  if (row.expires_at < Date.now() || row.banned) { destroySession(token); return null; }
  if (Date.now() - row.last_seen > 5 * 60 * 1000) db.prepare("UPDATE sessions SET last_seen=? WHERE id=?").run(Date.now(), row.sid);
  return row;
}
export function listSessions(userId, currentSid) {
  return db.prepare("SELECT id, created_at, last_seen, ua, ip FROM sessions WHERE user_id=? AND expires_at>? ORDER BY last_seen DESC")
    .all(userId, Date.now()).map((r) => ({ handle: r.id.slice(0, 16), current: r.id === currentSid, createdAt: r.created_at,
      lastSeen: r.last_seen, ip: r.ip, device: describeUA(r.ua) }));
}
export function revokeHandle(userId, handle) {
  return db.prepare("DELETE FROM sessions WHERE user_id=? AND substr(id,1,16)=?").run(userId, handle).changes;
}
function describeUA(ua) {
  const b = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "未知浏览器";
  const o = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "未知系统";
  return `${b} · ${o}`;
}
export function setCookie(res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_MS, path: "/",
  });
}
const examCookieBase = () => ({
  httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/",
});
export function setExamCookie(res, token) {
  res.cookie(EXAM_COOKIE, token, { ...examCookieBase(), maxAge: SESSION_MS });
}
export function clearExamCookie(res) {
  res.clearCookie(EXAM_COOKIE, examCookieBase());
}
export function setExamDetachedCookie(res, on) {
  if (on) res.cookie(EXAM_DETACHED_COOKIE, "1", { ...examCookieBase(), maxAge: SESSION_MS });
  else res.clearCookie(EXAM_DETACHED_COOKIE, examCookieBase());
}
export function createEmailToken(userId, kind, ttlMs) {
  const token = crypto.randomBytes(32).toString("base64url");
  db.prepare("DELETE FROM email_tokens WHERE user_id=? AND kind=?").run(userId, kind);
  db.prepare("INSERT INTO email_tokens (id,user_id,kind,expires_at) VALUES (?,?,?,?)")
    .run(sha(token), userId, kind, Date.now() + ttlMs);
  return token;
}
// 一次性：取出即删除
export function consumeEmailToken(token, kind) {
  const row = db.prepare("SELECT * FROM email_tokens WHERE id=? AND kind=?").get(sha(String(token || "")), kind);
  if (!row) return null;
  db.prepare("DELETE FROM email_tokens WHERE id=?").run(row.id);
  return row.expires_at < Date.now() ? null : row.user_id;
}
export function cleanupExpired() {
  db.prepare("DELETE FROM mfa_pending WHERE expires_at < ?").run(Date.now());
  db.prepare("DELETE FROM email_tokens WHERE expires_at < ?").run(Date.now());
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
}

// ---- sudo 模式（参照 GitHub "Confirm access"）：敏感操作前 10 分钟内确认过密码 ----
export const SUDO_MS = 10 * 60 * 1000;
export function grantSudo(sid) { db.prepare("UPDATE sessions SET sudo_until=? WHERE id=?").run(Date.now() + SUDO_MS, sid); }

// ---- 两步验证登录的中间态：密码正确但还差第二因素 ----
export const MFA_COOKIE = "gs_mfa";
export function createMfaPending(userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  db.prepare("DELETE FROM mfa_pending WHERE user_id=?").run(userId);
  db.prepare("INSERT INTO mfa_pending (id,user_id,expires_at) VALUES (?,?,?)").run(sha(token), userId, Date.now() + 5 * 60 * 1000);
  return token;
}
export function getMfaPending(token) {
  if (!token) return null;
  const r = db.prepare("SELECT * FROM mfa_pending WHERE id=?").get(sha(token));
  if (!r || r.expires_at < Date.now() || r.attempts >= 5) return null;
  return r;
}
export function bumpMfaAttempt(id) { db.prepare("UPDATE mfa_pending SET attempts=attempts+1 WHERE id=?").run(id); }
export function clearMfaPending(id) { db.prepare("DELETE FROM mfa_pending WHERE id=?").run(id); }

// ---- 恢复码：10 个一次性码，库里只存哈希 ----
export function newRecoveryCodes(userId) {
  db.prepare("DELETE FROM recovery_codes WHERE user_id=?").run(userId);
  const alpha = "abcdefghjkmnpqrstuvwxyz23456789";
  const codes = Array.from({ length: 10 }, () => {
    const b = crypto.randomBytes(10); let c = "";
    for (let i = 0; i < 10; i++) c += alpha[b[i] % alpha.length];
    return c.slice(0, 5) + "-" + c.slice(5);
  });
  const ins = db.prepare("INSERT INTO recovery_codes (id,user_id) VALUES (?,?)");
  codes.forEach((c) => ins.run(sha(c), userId));
  return codes;
}
export function useRecoveryCode(userId, code) {
  const norm = String(code || "").trim().toLowerCase().replace(/\s/g, "");
  const r = db.prepare("DELETE FROM recovery_codes WHERE id=? AND user_id=?").run(sha(norm), userId);
  return r.changes > 0;
}
export const recoveryLeft = (userId) => db.prepare("SELECT COUNT(*) c FROM recovery_codes WHERE user_id=?").get(userId).c;

