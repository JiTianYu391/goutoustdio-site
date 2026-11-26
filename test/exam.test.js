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

  // 3 位密码应被拒绝，4 位初始密码允许创建与重置并可直接登录
  const shortPw = await api("POST", "/api/exam/admin/users", {
    username: "shortpw", email: "shortpw@goutoustdio.top", password: "123", examNo: "0998",
  }, adminCookie);
  assert.equal(shortPw.status, 400);

  const uTmp = await api("POST", "/api/exam/admin/users", {
    username: "tempuser", email: "temp@goutoustdio.top", password: "1234", examNo: "0999",
  }, adminCookie);
  assert.equal(uTmp.status, 201);
  tempUserId = uTmp.json.user.id;

  const login4Create = await api("POST", "/api/login", { identifier: "0999", password: "1234" });
  assert.equal(login4Create.status, 200);
  assert.equal(login4Create.json.user.examNo, "0999");

  // 修改用户资料与重置 4 位密码
  const patch = await api("PATCH", `/api/exam/admin/users/${tempUserId}`, {
    displayName: "临时员工",
    department: "测试组",
    examNo: "0888",
    password: "0413",
  }, adminCookie);
  assert.equal(patch.status, 200);
  assert.equal(patch.json.user.examNo, "0888");
  assert.equal(patch.json.user.department, "测试组");

  const login4Reset = await api("POST", "/api/login", { identifier: "0888", password: "0413" });
  assert.equal(login4Reset.status, 200);
  assert.equal(login4Reset.json.user.examNo, "0888");

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

test("删除错题、批量清空原卷与删除成员成绩接口", async () => {
  // 员工删除自己的一条错题，其他员工无权删除
  const restMistakes = (await api("GET", "/api/exam/mistakes", undefined, emp1Cookie)).json.mistakes;
  assert.equal(restMistakes.length, 2);
  const forbiddenDelM = await api("DELETE", `/api/exam/mistakes/${restMistakes[1].id}`, undefined, emp2Cookie);
  assert.equal(forbiddenDelM.status, 403);

  const delM = await api("DELETE", `/api/exam/mistakes/${mistakeId}`, undefined, emp1Cookie);
  assert.equal(delM.status, 200);
  const afterDelM = await api("GET", "/api/exam/mistakes", undefined, emp1Cookie);
  assert.equal(afterDelM.json.mistakes.length, 1);

  // 上传到第2科的原卷可通过 DELETE /api/exam/admin/papers 整科清空并移除磁盘文件
  const up2 = await api("POST", "/api/exam/admin/papers", {
    examId, subjectId: sub2Id, examNo: "0413", pageNo: 1, imageData: VALID_JPEG_DATA_URL,
  }, adminCookie);
  assert.equal(up2.status, 201);
  const row2 = db.prepare("SELECT file_name FROM exam_paper_pages WHERE id=?").get(up2.json.page.id);
  const fullPath2 = path.join(tmpDir, "exam_uploads", row2.file_name);
  assert.equal(existsSync(fullPath2), true);

  const clr = await api("DELETE", `/api/exam/admin/papers?examId=${examId}&subjectId=${sub2Id}&userId=${emp1Id}`, undefined, adminCookie);
  assert.equal(clr.status, 200);
  assert.equal(clr.json.deleted, 1);
  assert.equal(existsSync(fullPath2), false);

  // 删除 0007 在本场考试中的成绩
  const delScore = await api("DELETE", `/api/exam/admin/exams/${examId}/scores/${emp2Id}`, undefined, adminCookie);
  assert.equal(delScore.status, 200);
  const ov = await api("GET", `/api/exam/admin/exams/${examId}/overview`, undefined, adminCookie);
  assert.equal(ov.json.ranking.some((r) => r.userId === emp2Id), false);
});

test("自动考号分配注册系统：5 个部门、用户名=ID=密码=4位考号及访客开关控制", async () => {
  const pubCfg = await api("GET", "/api/exam/public/config");
  assert.equal(pubCfg.status, 200);
  assert.deepEqual(pubCfg.json.departments, ["管理部", "内核开发部", "自行车动作部", "软件部", "游戏部"]);
  assert.equal(pubCfg.json.selfRegisterEnabled, true);

  // 非法部门应返回 400
  const badDept = await api("POST", "/api/exam/admin/users/auto-register", {
    fullName: "无效部门成员", department: "不存在的部门",
  }, adminCookie);
  assert.equal(badDept.status, 400);

  // 管理员单人自动分配考号
  const singleRes = await api("POST", "/api/exam/admin/users/auto-register", {
    fullName: "林浩", department: "内核开发部",
  }, adminCookie);
  assert.equal(singleRes.status, 201);
  assert.equal(singleRes.json.created.length, 1);
  const cred1 = singleRes.json.created[0];
  assert.match(cred1.examNo, /^\d{4}$/);
  assert.equal(cred1.id, Number(cred1.examNo));
  assert.equal(cred1.username, cred1.examNo);
  assert.equal(cred1.password, cred1.examNo);
  assert.equal(cred1.department, "内核开发部");

  // 用生成的 4 位考号同时作为用户名与密码直接登录
  const loginAuto = await api("POST", "/api/login", { identifier: cred1.examNo, password: cred1.examNo });
  assert.equal(loginAuto.status, 200);
  assert.equal(loginAuto.json.user.id, Number(cred1.examNo));
  assert.equal(loginAuto.json.user.examNo, cred1.examNo);

  // 管理员批量自动分配考号
  const batchRes = await api("POST", "/api/exam/admin/users/auto-register", {
    entries: [
      { fullName: "陈晨", department: "自行车动作部" },
      { fullName: "周杰", department: "游戏部" },
      { fullName: "孙敏", department: "软件部" },
    ],
  }, adminCookie);
  assert.equal(batchRes.status, 201);
  assert.equal(batchRes.json.created.length, 3);
  for (const c of batchRes.json.created) {
    assert.match(c.examNo, /^\d{4}$/);
    assert.equal(c.id, Number(c.examNo));
    assert.equal(c.username, c.examNo);
    assert.equal(c.password, c.examNo);
  }

  // 按部门筛选成员列表
  const filtered = await api("GET", `/api/exam/admin/users?department=${encodeURIComponent("内核开发部")}`, undefined, adminCookie);
  assert.equal(filtered.status, 200);
  assert.ok(filtered.json.users.some((u) => u.examNo === cred1.examNo && u.displayName === "林浩"));

  // 未登录访客自助注册自动分配 4 位考号并写入登录态 Cookie
  const pubReg = await api("POST", "/api/exam/public/auto-register", {
    fullName: "马俊宇", department: "管理部",
  });
  assert.equal(pubReg.status, 201);
  const pubCred = pubReg.json.credentials;
  assert.match(pubCred.examNo, /^\d{4}$/);
  assert.equal(pubCred.id, Number(pubCred.examNo));
  assert.equal(pubCred.username, pubCred.examNo);
  assert.equal(pubCred.password, pubCred.examNo);
  const pubCookie = cookiesFrom({ headers: pubReg.headers });
  const pubExamMe = await api("GET", "/api/exam/me", undefined, pubCookie);
  assert.equal(pubExamMe.status, 200);
  assert.equal(pubExamMe.json.user.examNo, pubCred.examNo);
  assert.equal(pubExamMe.json.user.department, "管理部");

  // 管理员关闭访客自助注册后拒绝 403，恢复开启后允许
  const offRes = await api("PUT", "/api/exam/admin/settings", { selfRegisterEnabled: false }, adminCookie);
  assert.equal(offRes.status, 200);
  assert.equal(offRes.json.selfRegisterEnabled, false);

  const blockedReg = await api("POST", "/api/exam/public/auto-register", {
    fullName: "被拦截访客", department: "软件部",
  });
  assert.equal(blockedReg.status, 403);

  const onRes = await api("PUT", "/api/exam/admin/settings", { selfRegisterEnabled: true }, adminCookie);
  assert.equal(onRes.status, 200);
  assert.equal(onRes.json.selfRegisterEnabled, true);
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

test("智考中心独立账密登录、并发会话隔离、无邮箱纯智考账号与退出解绑全流程", async () => {
  const applyCookies = (jar, res) => {
    const map = new Map();
    for (const part of String(jar || "").split(/;\s*/).filter(Boolean)) {
      const idx = part.indexOf("=");
      if (idx > 0) map.set(part.slice(0, idx), part.slice(idx + 1));
    }
    for (const sc of res.headers.getSetCookie()) {
      const segs = sc.split(";").map((s) => s.trim());
      const [nv] = segs;
      const eq = nv.indexOf("=");
      if (eq <= 0) continue;
      const k = nv.slice(0, eq);
      const v = nv.slice(eq + 1);
      const cleared = !v || segs.some((s) => /^max-age=0$/i.test(s) || /1970/.test(s));
      if (cleared) map.delete(k);
      else map.set(k, v);
    }
    return [...map.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  };

  // 1. 管理员创建无邮箱（纯智考中心）账号，自动生成占位邮箱
  const pureRes = await api("POST", "/api/exam/admin/users", {
    username: "exam_only_stu",
    displayName: "纯智考学员",
    password: "init_pass_88",
    examNo: "0921",
    department: "软件部",
  }, adminCookie);
  assert.equal(pureRes.status, 201);
  assert.equal(pureRes.json.user.username, "exam_only_stu");
  assert.match(pureRes.json.user.email, /@exam\.goutoustdio\.top$/);
  const pureId = pureRes.json.user.id;

  // 2. 不带主站账号：直接用独立接口用户名 + 初始密码登录 /exam
  const pubLogin = await api("POST", "/api/exam/public/login", {
    username: "exam_only_stu",
    password: "init_pass_88",
  });
  assert.equal(pubLogin.status, 200);
  assert.equal(pubLogin.json.authMode, "exam");
  assert.equal(pubLogin.json.user.id, pureId);
  const soloJar = applyCookies("", pubLogin);
  assert.match(soloJar, /gs_exam_session=/);
  assert.doesNotMatch(soloJar, /gs_session=/);

  // 主站 /api/me 仍为未登录 (null)，而 /api/exam/me 已正常识别考生
  const mainMe = await api("GET", "/api/me", undefined, soloJar);
  assert.equal(mainMe.json.user, null);
  const soloExamMe = await api("GET", "/api/exam/me", undefined, soloJar);
  assert.equal(soloExamMe.status, 200);
  assert.equal(soloExamMe.json.user.id, pureId);
  const soloList = await api("GET", "/api/exam/list", undefined, soloJar);
  assert.equal(soloList.status, 200);

  // 3. 并发隔离：浏览器同时登录主站管理员 (gs_session) + 智考独立普通考生 (gs_exam_session)
  let mixedJar = applyCookies(adminCookie, pubLogin);
  const mixedSiteMe = await api("GET", "/api/me", undefined, mixedJar);
  assert.equal(mixedSiteMe.json.user.role, "admin", "主站仍保持管理员身份");
  const mixedSession = await api("GET", "/api/exam/public/session", undefined, mixedJar);
  assert.equal(mixedSession.json.user.id, pureId);
  assert.equal(mixedSession.json.siteUser.role, "admin");
  assert.equal(mixedSession.json.authMode, "exam");

  // 即使主站是管理员，智考内当前身份为普通学生 -> 严禁调用任何管理员扫卷/批改/改分接口
  for (const [method, url, body] of [
    ["GET", "/api/exam/admin/users"],
    ["POST", "/api/exam/admin/smart-scan-grade", { examId: 1, subjectId: 1, images: [{ imageData: VALID_JPEG_DATA_URL }] }],
    ["POST", "/api/exam/admin/ai-grade", { examId: 1, subjectId: 1, userId: pureId }],
    ["PUT", "/api/exam/admin/exams/1/scores", { userId: pureId, subjectId: 1, score: 100 }],
    ["POST", "/api/exam/admin/papers", { examId: 1, subjectId: 1, userId: pureId, imageData: VALID_JPEG_DATA_URL }],
  ]) {
    const r = await api(method, url, body, mixedJar);
    assert.equal(r.status, 403, `普通独立考生不应访问 ${method} ${url}`);
  }

  // 非管理员尝试发送 >64KB JSON 载荷至上传路由应在 body 解析阶段即被拒 (413)
  const hugeImg = "data:image/jpeg;base64," + "A".repeat(80 * 1024);
  const hugeRes = await api("POST", "/api/exam/admin/smart-scan-grade", {
    examId: 1, subjectId: 1, images: [{ imageData: hugeImg }],
  }, mixedJar);
  assert.equal(hugeRes.status, 413);

  // 4. 在保留主站登录前提下点击退出智考中心 -> 置 gs_exam_detached=1，/exam/me 返回 401，主站 /api/me 仍保持管理员
  const examLogout = await api("POST", "/api/exam/public/logout", {}, mixedJar);
  assert.equal(examLogout.status, 200);
  assert.equal(examLogout.json.siteStillLoggedIn, true);
  mixedJar = applyCookies(mixedJar, examLogout);
  assert.match(mixedJar, /gs_exam_detached=1/);

  const afterLogoutExamMe = await api("GET", "/api/exam/me", undefined, mixedJar);
  assert.equal(afterLogoutExamMe.status, 401);
  const afterLogoutSiteMe = await api("GET", "/api/me", undefined, mixedJar);
  assert.equal(afterLogoutSiteMe.json.user.role, "admin");

  // 5. 一键切回主站管理员账号 -> 恢复使用 gs_session
  const useSite = await api("POST", "/api/exam/public/use-site-account", {}, mixedJar);
  assert.equal(useSite.status, 200);
  assert.equal(useSite.json.authMode, "site");
  assert.equal(useSite.json.user.role, "admin");
  mixedJar = applyCookies(mixedJar, useSite);
  assert.doesNotMatch(mixedJar, /gs_exam_detached=/);
  const backAdminExam = await api("GET", "/api/exam/admin/users", undefined, mixedJar);
  assert.equal(backAdminExam.status, 200);

  // 6. alsoSite: true 同步退出智考与主站（用临时主站会话验证以免清掉全局 adminCookie 会话）
  const siteLogin2 = await api("POST", "/api/login", { identifier: "admin@goutoustdio.top", password: "admin-password-123" });
  assert.equal(siteLogin2.status, 200);
  let bothJar = applyCookies("", siteLogin2);
  const bothOut = await api("POST", "/api/exam/public/logout", { alsoSite: true }, bothJar);
  assert.equal(bothOut.status, 200);
  assert.equal(bothOut.json.siteStillLoggedIn, false);
  bothJar = applyCookies(bothJar, bothOut);
  const meGone = await api("GET", "/api/me", undefined, bothJar);
  assert.equal(meGone.json.user, null);
});
