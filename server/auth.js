// 会话方案参照 Lucia 的 "Sessions" 指南 + OWASP 建议：
// 随机 token 放 HttpOnly cookie，库里只存 sha256(token)；密码用 scrypt（OWASP 认可）。
import crypto from "node:crypto";
import { promisify } from "node:util";
import { db } from "./db.js";

const scrypt = promisify(crypto.scrypt);
const SESSION_MS = 30 * 24 * 3600 * 1000;
export const COOKIE = "gs_session";

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

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?,?,?)")
    .run(sha(token), userId, Date.now() + SESSION_MS);
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
  const row = db.prepare(`SELECT u.id, u.username, u.email, u.role, u.email_verified, u.created_at, s.expires_at
    FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=?`).get(sha(token));
  if (!row) return null;
  if (row.expires_at < Date.now()) { destroySession(token); return null; }
  return row;
}
export function setCookie(res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_MS, path: "/",
  });
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
  db.prepare("DELETE FROM email_tokens WHERE expires_at < ?").run(Date.now());
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
}
