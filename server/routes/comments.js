// 评论：每页一个讨论区，支持一层回复与点赞；回复会邮件提醒被回复者（可退订）
import { Router } from "express";
import { db } from "../db.js";
import { sendNotice } from "../mail.js";
import { str, PAGE_RE, postLimit, need, needVerified, base, isSubscribed, unsubLink, mailLater } from "../util.js";

const r = Router();

r.get("/comments", (req, res) => {
  const page = str(req.query.page);
  if (!PAGE_RE.test(page)) return res.status(400).json({ error: "页面参数无效" });
  const me = req.user?.id ?? -1;
  const rows = db.prepare(`
    SELECT c.id, c.parent_id, c.body, c.created_at, u.id AS uid, u.username, u.display_name, u.role,
      (SELECT COUNT(*) FROM comment_likes l WHERE l.comment_id=c.id) AS likes,
      EXISTS(SELECT 1 FROM comment_likes l WHERE l.comment_id=c.id AND l.user_id=?) AS liked
    FROM comments c JOIN users u ON u.id=c.user_id
    WHERE c.page=? AND u.banned=0 ORDER BY c.id`).all(me, page);
  const map = new Map(), roots = [];
  for (const x of rows) {
    const c = { id: x.id, body: x.body, createdAt: x.created_at, likes: x.likes, liked: !!x.liked, mine: x.uid === me,
      author: { username: x.username, name: x.display_name || x.username, admin: x.role === "admin" }, replies: [] };
    map.set(c.id, c);
    if (x.parent_id && map.has(x.parent_id)) map.get(x.parent_id).replies.push(c); else roots.push(c);
  }
  roots.reverse(); // 顶层最新在前，回复按时间顺序
  res.json({
    comments: roots, total: rows.length,
    viewer: req.user ? { loggedIn: true, canPost: !!req.user.email_verified, admin: req.user.role === "admin" } : { loggedIn: false },
  });
});

r.post("/comments", need, needVerified, postLimit, (req, res) => {
  const page = str(req.body.page), body = str(req.body.body).trim();
  if (!PAGE_RE.test(page)) return res.status(400).json({ error: "页面参数无效" });
  if (body.length < 1 || body.length > 2000) return res.status(400).json({ error: "内容需为 1–2000 字" });
  let parent = null;
  if (req.body.parentId) {
    parent = db.prepare("SELECT * FROM comments WHERE id=? AND page=?").get(Number(req.body.parentId), page);
    if (!parent) return res.status(400).json({ error: "要回复的评论不存在" });
    if (parent.parent_id) parent = db.prepare("SELECT * FROM comments WHERE id=?").get(parent.parent_id); // 只保留一层
  }
  const id = Number(db.prepare("INSERT INTO comments (page,user_id,body,created_at,parent_id) VALUES (?,?,?,?,?)")
    .run(page, req.user.id, body, Date.now(), parent?.id ?? null).lastInsertRowid);
  if (parent && parent.user_id !== req.user.id && isSubscribed(parent.user_id, "replies")) {
    const to = db.prepare("SELECT email, email_verified FROM users WHERE id=?").get(parent.user_id);
    if (to?.email_verified) mailLater(sendNotice(to.email, `${req.user.display_name || req.user.username} 回复了你的评论`,
      [body.slice(0, 500)], { link: `${base(req)}/${page}.html#c${id}`, linkText: "查看回复", unsubscribe: unsubLink(req, parent.user_id, "replies") }));
  }
  res.status(201).json({ id });
});

r.post("/comments/:id/like", need, needVerified, (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare("SELECT 1 FROM comments WHERE id=?").get(id)) return res.status(404).json({ error: "不存在" });
  const del = db.prepare("DELETE FROM comment_likes WHERE comment_id=? AND user_id=?").run(id, req.user.id);
  if (!del.changes) db.prepare("INSERT INTO comment_likes (comment_id,user_id) VALUES (?,?)").run(id, req.user.id);
  res.json({ liked: !del.changes, likes: db.prepare("SELECT COUNT(*) c FROM comment_likes WHERE comment_id=?").get(id).c });
});

r.delete("/comments/:id", need, (req, res) => {
  const c = db.prepare("SELECT * FROM comments WHERE id=?").get(Number(req.params.id));
  if (!c) return res.status(404).json({ error: "不存在" });
  if (c.user_id !== req.user.id && req.user.role !== "admin") return res.status(403).json({ error: "无权限" });
  db.prepare("DELETE FROM comments WHERE id=?").run(c.id);
  res.json({ ok: true });
});

export default r;
