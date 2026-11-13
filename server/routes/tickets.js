// 问题反馈 / 工单：用户提交与跟进，管理员回复和改状态，双方邮件提醒
import { Router } from "express";
import { db } from "../db.js";
import { sendNotice } from "../mail.js";
import { str, postLimit, need, needVerified, base, mailLater } from "../util.js";

const r = Router();
export const CATEGORIES = { bug: "Bug", feature: "功能建议", question: "使用问题", other: "其他" };
export const STATUSES = { open: "待处理", in_progress: "处理中", resolved: "已解决", closed: "已关闭" };

const row = (t) => ({ id: t.id, title: t.title, category: t.category, status: t.status, createdAt: t.created_at, updatedAt: t.updated_at,
  author: t.username ? { username: t.username, name: t.display_name || t.username } : undefined, replies: t.replies });
const canSee = (req, t) => t && (t.user_id === req.user.id || req.user.role === "admin");

r.get("/tickets", need, (req, res) => {
  const all = req.query.all === "1" && req.user.role === "admin";
  const status = STATUSES[str(req.query.status)] ? str(req.query.status) : null;
  const where = [all ? "1=1" : "t.user_id=?", status ? "t.status=?" : "1=1"].join(" AND ");
  const args = [...(all ? [] : [req.user.id]), ...(status ? [status] : [])];
  const list = db.prepare(`SELECT t.*, u.username, u.display_name,
      (SELECT COUNT(*) FROM ticket_messages m WHERE m.ticket_id=t.id) - 1 AS replies
    FROM tickets t JOIN users u ON u.id=t.user_id WHERE ${where} ORDER BY t.updated_at DESC LIMIT 200`).all(...args);
  const counts = db.prepare(`SELECT status, COUNT(*) c FROM tickets t WHERE ${all ? "1=1" : "t.user_id=?"} GROUP BY status`).all(...(all ? [] : [req.user.id]));
  res.json({ tickets: list.map(row), counts: Object.fromEntries(counts.map((c) => [c.status, c.c])), categories: CATEGORIES, statuses: STATUSES });
});

r.post("/tickets", need, needVerified, postLimit, (req, res) => {
  const title = str(req.body.title).trim(), body = str(req.body.body).trim(), category = str(req.body.category);
  if (title.length < 4 || title.length > 120) return res.status(400).json({ error: "标题需为 4–120 字" });
  if (body.length < 10 || body.length > 8000) return res.status(400).json({ error: "描述需为 10–8000 字" });
  if (!CATEGORIES[category]) return res.status(400).json({ error: "请选择分类" });
  const now = Date.now();
  const id = Number(db.prepare("INSERT INTO tickets (user_id,title,category,status,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(req.user.id, title, category, "open", now, now).lastInsertRowid);
  db.prepare("INSERT INTO ticket_messages (ticket_id,user_id,body,staff,created_at) VALUES (?,?,?,?,?)").run(id, req.user.id, body, 0, now);
  if (process.env.ADMIN_EMAIL) mailLater(sendNotice(process.env.ADMIN_EMAIL, `[工单 #${id}] ${title}`,
    [`${req.user.username} 提交了新工单（${CATEGORIES[category]}）：`, body.slice(0, 1000)], { link: `${base(req)}/support/${id}`, linkText: "查看工单" }));
  res.status(201).json({ id });
});

r.get("/tickets/:id", need, (req, res) => {
  const t = db.prepare("SELECT t.*, u.username, u.display_name FROM tickets t JOIN users u ON u.id=t.user_id WHERE t.id=?").get(Number(req.params.id));
  if (!canSee(req, t)) return res.status(404).json({ error: "工单不存在" });
  const msgs = db.prepare(`SELECT m.id, m.body, m.staff, m.created_at, u.username, u.display_name FROM ticket_messages m
    JOIN users u ON u.id=m.user_id WHERE m.ticket_id=? ORDER BY m.id`).all(t.id);
  res.json({ ticket: row(t), messages: msgs.map((m) => ({ id: m.id, body: m.body, staff: !!m.staff, createdAt: m.created_at,
    author: { username: m.username, name: m.display_name || m.username } })), categories: CATEGORIES, statuses: STATUSES,
    viewer: { admin: req.user.role === "admin", owner: t.user_id === req.user.id } });
});

r.post("/tickets/:id/messages", need, postLimit, (req, res) => {
  const t = db.prepare("SELECT * FROM tickets WHERE id=?").get(Number(req.params.id));
  if (!canSee(req, t)) return res.status(404).json({ error: "工单不存在" });
  const body = str(req.body.body).trim();
  if (body.length < 1 || body.length > 8000) return res.status(400).json({ error: "内容需为 1–8000 字" });
  const staff = req.user.role === "admin" && t.user_id !== req.user.id;
  if (t.status === "closed" && !staff) return res.status(400).json({ error: "工单已关闭，请新建工单" });
  const now = Date.now();
  db.prepare("INSERT INTO ticket_messages (ticket_id,user_id,body,staff,created_at) VALUES (?,?,?,?,?)").run(t.id, req.user.id, body, staff ? 1 : 0, now);
  // 用户追加内容时，已解决的工单自动重新打开；管理员回复时待处理自动转为处理中
  const status = staff ? (t.status === "open" ? "in_progress" : t.status) : (t.status === "resolved" ? "open" : t.status);
  db.prepare("UPDATE tickets SET updated_at=?, status=? WHERE id=?").run(now, status, t.id);
  const link = `${base(req)}/support/${t.id}`;
  if (staff) {
    const owner = db.prepare("SELECT email FROM users WHERE id=?").get(t.user_id);
    mailLater(sendNotice(owner.email, `[工单 #${t.id}] 有新回复：${t.title}`, ["GoutouStdio 回复了你的工单：", body.slice(0, 1500)], { link, linkText: "查看并回复" }));
  } else if (process.env.ADMIN_EMAIL) {
    mailLater(sendNotice(process.env.ADMIN_EMAIL, `[工单 #${t.id}] 用户追加回复：${t.title}`, [body.slice(0, 1500)], { link, linkText: "查看工单" }));
  }
  res.status(201).json({ ok: true });
});

// 管理员可改任意状态；用户只能关闭自己的工单
r.patch("/tickets/:id", need, (req, res) => {
  const t = db.prepare("SELECT * FROM tickets WHERE id=?").get(Number(req.params.id));
  if (!canSee(req, t)) return res.status(404).json({ error: "工单不存在" });
  const status = str(req.body.status);
  if (!STATUSES[status]) return res.status(400).json({ error: "状态无效" });
  if (req.user.role !== "admin" && status !== "closed") return res.status(403).json({ error: "无权限" });
  db.prepare("UPDATE tickets SET status=?, updated_at=? WHERE id=?").run(status, Date.now(), t.id);
  if (req.user.role === "admin" && t.user_id !== req.user.id && (status === "resolved" || status === "closed")) {
    const owner = db.prepare("SELECT email FROM users WHERE id=?").get(t.user_id);
    mailLater(sendNotice(owner.email, `[工单 #${t.id}] 状态更新为「${STATUSES[status]}」`, [`你的工单「${t.title}」已${STATUSES[status]}。`, "如果问题仍然存在，可以在工单里继续回复。"],
      { link: `${base(req)}/support/${t.id}`, linkText: "查看工单" }));
  }
  res.json({ ok: true });
});

export default r;
