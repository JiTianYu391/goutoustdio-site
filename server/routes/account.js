// 账号资料、邮箱、密码、会话、订阅、注销；公开用户主页
import { Router } from "express";
import { db } from "../db.js";
import * as A from "../auth.js";
import {
  str, MAIL_RE, PAGE_RE, TOPICS, authLimit, need, needSudo, getUser, pubUser, publicUser,
  syncAdmin, sendVerify, securityNotice, unsubSig,
} from "../util.js";

const r = Router();

r.patch("/profile", need, (req, res) => {
  const displayName = str(req.body.displayName).trim(), bio = str(req.body.bio).trim();
  if (displayName.length > 32) return res.status(400).json({ error: "昵称最多 32 字" });
  if (bio.length > 200) return res.status(400).json({ error: "简介最多 200 字" });
  db.prepare("UPDATE users SET display_name=?, bio=? WHERE id=?").run(displayName, bio, req.user.id);
  res.json({ user: pubUser(getUser(req.user.id)) });
});

r.post("/email", need, needSudo, authLimit, (req, res) => {
  const email = str(req.body.email).trim();
  if (!MAIL_RE.test(email)) return res.status(400).json({ error: "邮箱格式不正确" });
  const u = getUser(req.user.id);
  if (db.prepare("SELECT 1 FROM users WHERE email=? AND id<>?").get(email, u.id)) return res.status(409).json({ error: "该邮箱已被使用" });
  securityNotice(req, u, `把邮箱改成了 ${email}`); // 发到旧邮箱
  db.prepare("UPDATE users SET email=?, email_verified=0 WHERE id=?").run(email, u.id);
  syncAdmin(u.id);
  sendVerify(req, u.id, email);
  res.json({ user: pubUser(getUser(u.id)) });
});

r.post("/password", need, authLimit, async (req, res) => {
  const cur = str(req.body.current), next = str(req.body.next);
  if (next.length < 8 || next.length > 128) return res.status(400).json({ error: "新密码长度需为 8–128 位" });
  const u = getUser(req.user.id);
  if (!(await A.verifyPassword(cur, u.password_hash))) return res.status(401).json({ error: "当前密码错误" });
  db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(await A.hashPassword(next), u.id);
  A.destroyUserSessions(u.id, req.cookies[A.COOKIE]);
  securityNotice(req, u, "修改了密码");
  res.json({ ok: true });
});

r.delete("/account", need, needSudo, (req, res) => {
  const u = getUser(req.user.id);
  if (str(req.body.confirm).trim().toLowerCase() !== u.username.toLowerCase()) return res.status(400).json({ error: "请输入你的用户名以确认注销" });
  db.prepare("DELETE FROM users WHERE id=?").run(u.id);
  res.clearCookie(A.COOKIE, { path: "/" });
  res.json({ ok: true });
});

r.get("/sessions", need, (req, res) => res.json({ sessions: A.listSessions(req.user.id, req.user.sid) }));
r.post("/sessions/revoke-others", need, (req, res) => { A.destroyUserSessions(req.user.id, req.cookies[A.COOKIE]); res.json({ ok: true }); });
r.delete("/sessions/:handle", need, (req, res) => { A.revokeHandle(req.user.id, String(req.params.handle).slice(0, 16)); res.json({ ok: true }); });

// ---- 邮件订阅 ----
const subsOf = (uid) => {
  const on = new Set(db.prepare("SELECT topic FROM subscriptions WHERE user_id=?").all(uid).map((r) => r.topic));
  return Object.entries(TOPICS).map(([topic, label]) => ({ topic, label, on: on.has(topic) }));
};
r.get("/subscriptions", need, (req, res) => res.json({ topics: subsOf(req.user.id) }));
r.put("/subscriptions/:topic", need, (req, res) => {
  const t = req.params.topic;
  if (!TOPICS[t]) return res.status(400).json({ error: "未知主题" });
  if (req.body.on) db.prepare("INSERT OR IGNORE INTO subscriptions (user_id,topic) VALUES (?,?)").run(req.user.id, t);
  else db.prepare("DELETE FROM subscriptions WHERE user_id=? AND topic=?").run(req.user.id, t);
  res.json({ topics: subsOf(req.user.id) });
});
// 邮件里的一键退订（GET 也可，便于邮件客户端处理 List-Unsubscribe）
r.all("/unsubscribe", (req, res) => {
  const u = Number(req.query.u), t = str(req.query.t), s = str(req.query.s);
  if (!TOPICS[t] || s !== unsubSig(u, t)) return res.status(400).type("text").send("退订链接无效。");
  db.prepare("DELETE FROM subscriptions WHERE user_id=? AND topic=?").run(u, t);
  res.redirect(303, `/account?unsubscribed=${t}#notifications`);
});

// ---- 公开用户主页 ----
r.get("/users/:username", (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE username=?").get(str(req.params.username));
  if (!u || u.banned) return res.status(404).json({ error: "用户不存在" });
  const recent = db.prepare("SELECT id, page, body, created_at FROM comments WHERE user_id=? ORDER BY id DESC LIMIT 20").all(u.id)
    .filter((c) => PAGE_RE.test(c.page))
    .map((c) => ({ id: c.id, page: c.page, excerpt: c.body.slice(0, 160), createdAt: c.created_at }));
  const count = db.prepare("SELECT COUNT(*) c FROM comments WHERE user_id=?").get(u.id).c;
  const likes = db.prepare("SELECT COUNT(*) c FROM comment_likes l JOIN comments c ON c.id=l.comment_id WHERE c.user_id=?").get(u.id).c;
  res.json({ user: publicUser(u), stats: { comments: count, likes }, recent, me: req.user?.id === u.id });
});

export default r;
