// 员工内部考试系统 (/exam) 与开放平台文档 (/docs) 端到端集成测试
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmpDir = mkdtempSync(path.join(tmpdir(), "gs-exam-test-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "test";
process.env.SITE_URL = "http://127.0.0.1";
process.env.ADMIN_EMAIL = "admin@goutoustdio.top";

const { app } = await import("../server/index.js");
const { db } = await import("../server/db.js");
const { syncAdmin } = await import("../server/util.js");

let server, base;
let adminCookie, emp1Cookie, emp2Cookie;
let emp1Id, emp2Id, tempUserId;
let examId, sub1Id, sub2Id, paperPageId, mistakeId;

// 最小合法 JPEG 文件字节头（含 FFD8FFE0...FFD9）
const VALID_JPEG_DATA_URL = "data:image/jpeg;base64," + Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x01, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00, 0xff, 0xd9,
]).toString("base64");

const cookiesFrom = (r) => r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

async function api(method, p, body, cookie) {
  const headers = { origin: base };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(`${base}${p}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-json */ }
  return { status: r.status, headers: r.headers, json, text };
}

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

test("注册并激活管理员账号（ADMIN_EMAIL）", async () => {
  const r = await api("POST", "/api/register", {
    username: "boss",
    email: "admin@goutoustdio.top",
    password: "admin-password-123",
  });
  assert.equal(r.status, 201);
  adminCookie = cookiesFrom(r.headers ? { headers: r.headers } : r);
  // 通过库内标记邮箱验证并同步管理员角色
  const row = db.prepare("SELECT id FROM users WHERE email=?").get("admin@goutoustdio.top");
  db.prepare("UPDATE users SET email_verified=1 WHERE id=?").run(row.id);
  syncAdmin(row.id);

  const me = await api("GET", "/api/me", undefined, adminCookie);
  assert.equal(me.status, 200);
  assert.equal(me.json.user.role, "admin");
});

test("管理员用户增删改与 4 位数字考号（保留前导零如 0413）", async () => {
  // 非法考号校验
  const bad1 = await api("POST", "/api/exam/admin/users", {
    username: "bad1", email: "bad1@goutoustdio.top", password: "password123", examNo: "413",
  }, adminCookie);
  assert.equal(bad1.status, 400);

  const bad2 = await api("POST", "/api/exam/admin/users", {
    username: "bad2", email: "bad2@goutoustdio.top", password: "password123", examNo: "abcd",
  }, adminCookie);
  assert.equal(bad2.status, 400);

  // 正常新增员工 0413
  const u1 = await api("POST", "/api/exam/admin/users", {
    username: "alice",
    displayName: "爱丽丝",
    email: "alice@goutoustdio.top",
    password: "alice-password-123",
    examNo: "0413",
    department: "内核研发组",
  }, adminCookie);
  assert.equal(u1.status, 201);
  assert.equal(u1.json.user.examNo, "0413");
  emp1Id = u1.json.user.id;

  // 考号冲突 409
  const dup = await api("POST", "/api/exam/admin/users", {
    username: "alice2", email: "alice2@goutoustdio.top", password: "password123", examNo: "0413",
  }, adminCookie);
  assert.equal(dup.status, 409);

  // 新增第二名员工 0007 与临时用户 0999
  const u2 = await api("POST", "/api/exam/admin/users", {
    username: "bob",
    displayName: "鲍勃",
    email: "bob@goutoustdio.top",
    password: "bob-password-123",
    examNo: "0007",
    department: "内核研发组",
  }, adminCookie);
  assert.equal(u2.status, 201);
  emp2Id = u2.json.user.id;

  const uTmp = await api("POST", "/api/exam/admin/users", {
    username: "tempuser", email: "temp@goutoustdio.top", password: "temp-password-123", examNo: "0999",
  }, adminCookie);
  assert.equal(uTmp.status, 201);
  tempUserId = uTmp.json.user.id;

  // 修改用户资料与重置密码
  const patch = await api("PATCH", `/api/exam/admin/users/${tempUserId}`, {
    displayName: "临时员工",
    department: "测试组",
    examNo: "0888",
  }, adminCookie);
  assert.equal(patch.status, 200);
  assert.equal(patch.json.user.examNo, "0888");
  assert.equal(patch.json.user.department, "测试组");

  // 删除用户，且禁止删除当前登录管理员
  const del = await api("DELETE", `/api/exam/admin/users/${tempUserId}`, undefined, adminCookie);
  assert.equal(del.status, 200);

  const me = await api("GET", "/api/me", undefined, adminCookie);
  const delSelf = await api("DELETE", `/api/exam/admin/users/${me.json.user.id}`, undefined, adminCookie);
  assert.equal(delSelf.status, 400);

  // 随机下一个可用考号接口
  const nextNo = await api("GET", "/api/exam/admin/users/next-exam-no", undefined, adminCookie);
  assert.equal(nextNo.status, 200);
  assert.match(nextNo.json.examNo, /^\d{4}$/);
});

test("支持使用 4 位数字考号登录，且普通员工无法调用管理员与扫卷接口", async () => {
  const login1 = await api("POST", "/api/login", { identifier: "0413", password: "alice-password-123" });
  assert.equal(login1.status, 200);
  assert.equal(login1.json.user.examNo, "0413");
  assert.equal(login1.json.user.username, "alice");
  emp1Cookie = cookiesFrom({ headers: login1.headers });

  const login2 = await api("POST", "/api/login", { identifier: "0007", password: "bob-password-123" });
  assert.equal(login2.status, 200);
  emp2Cookie = cookiesFrom({ headers: login2.headers });

  // 普通成员严禁调用扫描上传及任何考务管理接口（扫描只能给管理员用）
  const forbiddenAdminUsers = await api("GET", "/api/exam/admin/users", undefined, emp1Cookie);
  assert.equal(forbiddenAdminUsers.status, 403);

  const forbiddenCreate = await api("POST", "/api/exam/admin/exams", {
    title: "越权考试", subjects: [{ name: "测试", fullScore: 100 }],
  }, emp1Cookie);
  assert.equal(forbiddenCreate.status, 403);

  const forbiddenScanUpload = await api("POST", "/api/exam/admin/papers", {
    examId: 1, subjectId: 1, userId: emp1Id, imageData: VALID_JPEG_DATA_URL,
  }, emp1Cookie);
  assert.equal(forbiddenScanUpload.status, 403);
});

test("管理员创建考试、录入成绩（含小题）、扫描传卷与红笔批改", async () => {
  const created = await api("POST", "/api/exam/admin/exams", {
    title: "2026 Q4 内核研发内部考核",
    term: "2026 秋季",
    examDate: "2026-11-25",
    description: "考察操作系统内核基础与 Rust 内存安全",
    status: "draft",
    showRank: true,
    subjects: [
      {
        name: "操作系统基础",
        fullScore: 100,
        passScore: 60,
        excellentScore: 85,
        questions: [
          { no: "1", title: "页表与虚拟内存映射", tag: "内存管理", full: 40, answer: "多级页表 + TLB" },
          { no: "2", title: "CFS 调度器时间片计算", tag: "进程调度", full: 30, answer: "vruntime 权重" },
          { no: "3", title: "系统调用上下文切换", tag: "中断与ABI", full: 30, answer: "保存寄存器切换栈" },
        ],
      },
      {
        name: "Rust 工程实践",
        fullScore: 100,
        passScore: 60,
        excellentScore: 85,
        questions: [
          { no: "1", title: "所有权与生命周期标注", tag: "Rust 内存安全", full: 50, answer: "'a 约束" },
          { no: "2", title: "无锁并发数据结构", tag: "并发编程", full: 50, answer: "Atomic Ordering" },
        ],
      },
    ],
  }, adminCookie);

  assert.equal(created.status, 201);
  examId = created.json.exam.id;
  sub1Id = created.json.exam.subjects[0].id;
  sub2Id = created.json.exam.subjects[1].id;

  // 草稿状态下员工不可见、不可查报告
  const draftList = await api("GET", "/api/exam/list", undefined, emp1Cookie);
  assert.equal(draftList.status, 200);
  assert.equal(draftList.json.exams.length, 0);

  const draftRep = await api("GET", `/api/exam/exams/${examId}/report`, undefined, emp1Cookie);
  assert.equal(draftRep.status, 403);

  // 为 0413 提交第 1 科（含小题分，第 2 题失分）和第 2 科成绩
  const s1 = await api("PUT", `/api/exam/admin/exams/${examId}/scores`, {
    examNo: "0413",
    subjects: [
      {
        subjectId: sub1Id,
        useItemsSum: true,
        teacherComment: "整体扎实，调度细节需加强",
        items: [
          { no: "1", got: 40 },
          { no: "2", got: 18 },
          { no: "3", got: 30 },
        ],
      },
      {
        subjectId: sub2Id,
        useItemsSum: true,
        items: [
          { no: "1", got: 50 },
          { no: "2", got: 44 },
        ],
      },
    ],
  }, adminCookie);
  assert.equal(s1.status, 200);
  assert.equal(s1.json.saved[0].score, 88);
  assert.equal(s1.json.saved[1].score, 94);

  // 批量提交 0007 的成绩
  const batch = await api("POST", `/api/exam/admin/exams/${examId}/scores/batch`, {
    records: [
      { examNo: "0007", subjectId: sub1Id, score: 72 },
      { examNo: "0007", subjectId: sub2Id, score: 80 },
    ],
  }, adminCookie);
  assert.equal(batch.status, 200);
  assert.equal(batch.json.saved, 2);

  // 上传非法伪造图片数据应被魔数校验拒绝
  const badPaper = await api("POST", "/api/exam/admin/papers", {
    examId, subjectId: sub1Id, examNo: "0413",
    imageData: "data:image/jpeg;base64," + Buffer.from("NOT_A_REAL_JPEG").toString("base64"),
  }, adminCookie);
  assert.equal(badPaper.status, 400);

  // 上传合法扫描试卷给 0413
  const okPaper = await api("POST", "/api/exam/admin/papers", {
    examId,
    subjectId: sub1Id,
    examNo: "0413",
    pageNo: 1,
    imageData: VALID_JPEG_DATA_URL,
    width: 1200,
    height: 1680,
    filterMode: "magic",
    annotations: [{ type: "check", x: 0.3, y: 0.25, color: "#ef4444" }],
  }, adminCookie);
  assert.equal(okPaper.status, 201);
  paperPageId = okPaper.json.page.id;

  // 追加红笔批改标记
  const ann = await api("PATCH", `/api/exam/admin/papers/${paperPageId}`, {
    annotations: [
      { type: "check", x: 0.3, y: 0.25, color: "#ef4444" },
      { type: "text", x: 0.5, y: 0.4, text: "-12", color: "#ef4444" },
    ],
  }, adminCookie);
  assert.equal(ann.status, 200);
  assert.equal(ann.json.page.annotations.length, 2);

  // 草稿阶段 0413 尚不可读取原卷图（403），管理员可读取（200）
  const imgDraftEmp = await fetch(`${base}/api/exam/papers/${paperPageId}/image`, { headers: { cookie: emp1Cookie } });
  assert.equal(imgDraftEmp.status, 403);
  const imgDraftAdmin = await fetch(`${base}/api/exam/papers/${paperPageId}/image`, { headers: { cookie: adminCookie } });
  assert.equal(imgDraftAdmin.status, 200);
});

test("发布考试后：员工查看智学网式诊断报告、原卷与错题本（且隔离他人隐私）", async () => {
  const pub = await api("PATCH", `/api/exam/admin/exams/${examId}`, { status: "published" }, adminCookie);
  assert.equal(pub.status, 200);
  assert.equal(pub.json.exam.status, "published");

  // 0413 查询列表与个人趋势
  const meExam = await api("GET", "/api/exam/me", undefined, emp1Cookie);
  assert.equal(meExam.status, 200);
  assert.equal(meExam.json.user.examNo, "0413");
  assert.equal(meExam.json.stats.examCount, 1);
  assert.equal(meExam.json.stats.mistakePending, 2);
  assert.equal(meExam.json.trends[0].score, 182);

  // 0413 查看完整报告
  const rep = await api("GET", `/api/exam/exams/${examId}/report`, undefined, emp1Cookie);
  assert.equal(rep.status, 200);
  assert.equal(rep.json.mine.totalScore, 182);
  assert.equal(rep.json.mine.rank, 1);
  assert.equal(rep.json.mine.beatPct, 100);
  assert.equal(rep.json.mine.grade, "A");
  assert.equal(rep.json.overview.totalParticipants, 2);
  assert.equal(rep.json.overview.avgTotal, 167); // (182 + 152) / 2
  assert.ok(rep.json.radar.length >= 2);
  // 确认绝不泄露其他成员考号或用户名
  assert.equal(JSON.stringify(rep.json).includes("0007"), false);
  assert.equal(JSON.stringify(rep.json).includes("鲍勃"), false);

  // 原卷图片权限：0413 本人可读 (200)，0007 他人禁止访问 (403)
  const imgSelf = await fetch(`${base}/api/exam/papers/${paperPageId}/image`, { headers: { cookie: emp1Cookie } });
  assert.equal(imgSelf.status, 200);
  assert.match(imgSelf.headers.get("content-type"), /^image\/jpeg/);

  const imgOther = await fetch(`${base}/api/exam/papers/${paperPageId}/image`, { headers: { cookie: emp2Cookie } });
  assert.equal(imgOther.status, 403);

  // 隐藏排名开关验证
  await api("PATCH", `/api/exam/admin/exams/${examId}`, { showRank: false }, adminCookie);
  const repHiddenRank = await api("GET", `/api/exam/exams/${examId}/report`, undefined, emp1Cookie);
  assert.equal(repHiddenRank.status, 200);
  assert.equal(repHiddenRank.json.mine.rank, null);
  assert.equal(repHiddenRank.json.mine.beatPct, 100);

  // 错题本查询与复盘更新
  const mistakes = await api("GET", "/api/exam/mistakes", undefined, emp1Cookie);
  assert.equal(mistakes.status, 200);
  assert.equal(mistakes.json.mistakes.length, 2);
  mistakeId = mistakes.json.mistakes[0].id;

  const updM = await api("PATCH", `/api/exam/mistakes/${mistakeId}`, {
    reflection: "重算了 CFS 虚拟运行时间公式",
    mastered: true,
  }, emp1Cookie);
  assert.equal(updM.status, 200);
  assert.equal(updM.json.mastered, true);

  // 0007 不能修改 0413 的错题
  const stealM = await api("PATCH", `/api/exam/mistakes/${mistakeId}`, { mastered: false }, emp2Cookie);
  assert.equal(stealM.status, 403);
});

test("删除考试后清理磁盘扫描图片文件", async () => {
  const paperRow = db.prepare("SELECT file_name FROM exam_paper_pages WHERE id=?").get(paperPageId);
  const fullPath = path.join(tmpDir, "exam_uploads", paperRow.file_name);
  assert.equal(existsSync(fullPath), true);

  const delEx = await api("DELETE", `/api/exam/admin/exams/${examId}`, undefined, adminCookie);
  assert.equal(delEx.status, 200);
  assert.equal(existsSync(fullPath), false);
});

test("智考中心与开放平台文档路由返回 200 且无内联 script", async () => {
  for (const route of ["/exam", "/exam/report", "/docs", "/docs/oauth", "/docs/tokens", "/docs/recharge", "/docs/webhooks", "/docs/errors", "/docs/example"]) {
    const r = await fetch(`${base}${route}`);
    assert.equal(r.status, 200, route);
    const html = await r.text();
    // 严格 CSP 禁止无 src 的内联 script
    const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/gi)];
    assert.equal(inlineScripts.length, 0, `${route} 不应包含内联 script`);
  }
});
