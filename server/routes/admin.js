// 管理后台：概览、用户（搜索 / 封禁）、评论审核、版本更新群发
import { Router } from "express";
import { db } from "../db.js";
import * as A from "../auth.js";
import { sendNotice } from "../mail.js";
import { str, TOPICS, needAdmin, base, unsubLink } from "../util.js";

const r = Router();
r.use(needAdmin);
const DAY = 24 * 3600 * 1000;
const count = (sql, ...a) => db.prepare(sql).get(...a).c;

r.get("/stats", (_req, res) => {
  const since = Date.now() - 14 * DAY;
  const reg = db.prepare("SELECT created_at FROM users WHERE created_at>?").all(since);
  const days = Array.from({ length: 14 }, (_, i) => {
    const start = new Date(Date.now() - (13 - i) * DAY); start.setHours(0, 0, 0, 0);
    const s = start.getTime(), e = s + DAY;
    return { date: start.toISOString().slice(5, 10), users: reg.filter((u) => u.created_at >= s && u.created_at < e).length };
  });
  res.json({
    users: count("SELECT COUNT(*) c FROM users"), verified: count("SELECT COUNT(*) c FROM users WHERE email_verified=1"),
    banned: count("SELECT COUNT(*) c FROM users WHERE banned=1"), twoFactor: count("SELECT COUNT(*) c FROM users WHERE totp_secret IS NOT NULL"),
    passkeys: count("SELECT COUNT(*) c FROM passkeys"), comments: count("SELECT COUNT(*) c FROM comments"),
    commentsWeek: count("SELECT COUNT(*) c FROM comments WHERE created_at>?", Date.now() - 7 * DAY),
    ticketsOpen: count("SELECT COUNT(*) c FROM tickets WHERE status IN ('open','in_progress')"),
    subscribers: Object.fromEntries(Object.keys(TOPICS).map((t) => [t, count("SELECT COUNT(*) c FROM subscriptions s JOIN users u ON u.id=s.user_id WHERE s.topic=? AND u.email_verified=1 AND u.banned=0", t)])),
    registrations: days, topics: TOPICS,
  });
});

r.get("/users", (req, res) => {
  const q = `%${str(req.query.q).trim()}%`;
  const users = db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM comments c WHERE c.user_id=u.id) AS comments,
      (SELECT MAX(last_seen) FROM sessions s WHERE s.user_id=u.id) AS last_seen
    FROM users u WHERE u.username LIKE ? OR u.email LIKE ? OR u.display_name LIKE ? ORDER BY u.id DESC LIMIT 200`).all(q, q, q);
  res.json({ users: users.map((u) => ({ id: u.id, username: u.username, displayName: u.display_name, email: u.email, role: u.role,
    emailVerified: !!u.email_verified, banned: !!u.banned, banReason: u.ban_reason, twoFactor: !!u.totp_secret,
    comments: u.comments, lastSeen: u.last_seen, createdAt: u.created_at })) });
});

r.post("/users/:id/ban", (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(Number(req.params.id));
  if (!u) return res.status(404).json({ error: "用户不存在" });
  if (u.role === "admin") return res.status(400).json({ error: "不能封禁管理员" });
  const banned = !!req.body.banned;
  db.prepare("UPDATE users SET banned=?, ban_reason=? WHERE id=?").run(banned ? 1 : 0, banned ? str(req.body.reason).slice(0, 200) : "", u.id);
  if (banned) A.destroyUserSessions(u.id);
  res.json({ ok: true });
});

r.get("/comments", (req, res) => {
  const q = `%${str(req.query.q).trim()}%`;
  const rows = db.prepare(`SELECT c.id, c.page, c.body, c.created_at, c.parent_id, u.username, u.display_name, u.banned,
      (SELECT COUNT(*) FROM comment_likes l WHERE l.comment_id=c.id) AS likes
    FROM comments c JOIN users u ON u.id=c.user_id WHERE c.body LIKE ? OR u.username LIKE ? OR c.page LIKE ? ORDER BY c.id DESC LIMIT 200`).all(q, q, q);
  res.json({ comments: rows.map((c) => ({ id: c.id, page: c.page, body: c.body, createdAt: c.created_at, reply: !!c.parent_id, likes: c.likes,
    author: { username: c.username, name: c.display_name || c.username, banned: !!c.banned } })) });
});

// ---- 群发：版本更新 / 公告。逐封发送并控制速率，避免触发邮箱服务商限流 ----
r.get("/broadcasts", (_req, res) => {
  res.json({ broadcasts: db.prepare("SELECT * FROM broadcasts ORDER BY id DESC LIMIT 50").all()
    .map((b) => ({ id: b.id, topic: b.topic, subject: b.subject, recipients: b.recipients, sent: b.sent, createdAt: b.created_at })), topics: TOPICS });
});

r.post("/broadcasts", (req, res) => {
  const topic = str(req.body.topic), subject = str(req.body.subject).trim(), body = str(req.body.body).trim(), link = str(req.body.link).trim();
  if (!["pyspos", "spaceos", "announce"].includes(topic)) return res.status(400).json({ error: "请选择订阅主题" });
  if (subject.length < 2 || subject.length > 120) return res.status(400).json({ error: "标题需为 2–120 字" });
  if (body.length < 2 || body.length > 5000) return res.status(400).json({ error: "正文需为 2–5000 字" });
  if (link && !/^https?:\/\//.test(link)) return res.status(400).json({ error: "链接需以 http(s):// 开头" });
  const to = db.prepare(`SELECT u.id, u.email FROM subscriptions s JOIN users u ON u.id=s.user_id
    WHERE s.topic=? AND u.email_verified=1 AND u.banned=0`).all(topic);
  if (req.body.dryRun) return res.json({ recipients: to.length });
  const id = Number(db.prepare("INSERT INTO broadcasts (topic,subject,body,link,recipients,created_by,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(topic, subject, body, link, to.length, req.user.id, Date.now()).lastInsertRowid);
  (async () => {
    let sent = 0;
    for (const u of to) {
      try {
        await sendNotice(u.email, subject, body.split(/\n{2,}/), { link: link || base(req), linkText: link ? "查看详情" : "访问 GoutouStdio", unsubscribe: unsubLink(req, u.id, topic) });
        db.prepare("UPDATE broadcasts SET sent=? WHERE id=?").run(++sent, id);
      } catch (err) { console.error("[broadcast]", u.email, err.message); }
      await new Promise((ok) => setTimeout(ok, 1500));
    }
  })();
  res.status(202).json({ id, recipients: to.length });
});

export default r;
