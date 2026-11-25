// DeepSeek 多模态拍照识卷 (/api/exam/admin/parse-photos) 与 AI 自动阅卷批改 (/api/exam/admin/ai-grade) 集成测试
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmpDir = mkdtempSync(path.join(tmpdir(), "gs-ai-test-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "test";
process.env.SITE_URL = "http://127.0.0.1";
process.env.ADMIN_EMAIL = "admin@goutoustdio.top";
delete process.env.DEEPSEEK_API_KEY;
delete process.env.DEEPSEEK_BASE_URL;
delete process.env.DEEPSEEK_MODEL;

const { app } = await import("../server/index.js");
const { db } = await import("../server/db.js");
const { syncAdmin } = await import("../server/util.js");

let server, base, mockDsServer, mockDsBase;
let adminCookie, stuCookie, stuId, lastDsRequest;

const VALID_JPEG_DATA_URL = "data:image/jpeg;base64," + Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x01, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00, 0xff, 0xd9,
]).toString("base64");

let mockDsMode = "parse"; // "parse" | "grade" | "unauthorized"

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
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: r.status, headers: r.headers, json, text };
}

before(async () => {
  mockDsServer = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      try { lastDsRequest = JSON.parse(raw); } catch { lastDsRequest = null; }
      res.setHeader("content-type", "application/json");
      if (mockDsMode === "unauthorized") {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: { message: "Authentication Fails" } }));
        return;
      }
      if (mockDsMode === "grade") {
        res.end(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                totalScore: 22,
                teacherComment: "AI 初评：听力题全对，主观题第(2)问缺关键说明扣 8 分。",
                items: [
                  {
                    no: "1",
                    pageNo: 1,
                    studentAnswer: "B",
                    full: 10,
                    got: 10,
                    isCorrect: true,
                    reason: "填涂 B，正确",
                    markPos: { x: 0.25, y: 0.25 },
                  },
                  {
                    no: "2",
                    pageNo: 1,
                    studentAnswer: "按模块拆分，未写回滚",
                    full: 20,
                    got: 12,
                    isCorrect: false,
                    reason: "第(2)问缺少回滚方案描述，扣 8 分",
                    markPos: { x: 0.65, y: 0.55 },
                  },
                ],
              }),
            },
          }],
        }));
        return;
      }
      res.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              title: "2026 英语与内核拍照测评",
              term: "2026-Q4",
              subjectName: "综合能力",
              fullScore: 30,
              duration: 45,
              mode: "闭卷",
              skippedAnswerSheet: false,
              questions: [
                {
                  no: "1",
                  section: "听力理解",
                  qtype: "listening",
                  title: "Where is the server located?",
                  tag: "听力理解",
                  full: 10,
                  answer: "B",
                },
                {
                  no: "2",
                  section: "主观题",
                  qtype: "essay",
                  title: "阐述系统架构拆分与回滚设计",
                  tag: "架构设计",
                  full: 20,
                  answer: "(1) 模块解耦（10分）；(2) 蓝绿回滚（10分）",
                  subQuestions: [
                    { no: "2(1)", subNo: "1", title: "模块拆分原则", tag: "架构设计", full: 10, answer: "模块解耦" },
                    { no: "2(2)", subNo: "2", title: "回滚机制", tag: "架构设计", full: 10, answer: "蓝绿回滚" },
                  ],
                },
              ],
            }),
          },
        }],
      }));
    });
  });
  await new Promise((r) => mockDsServer.listen(0, "127.0.0.1", r));
  mockDsBase = `http://127.0.0.1:${mockDsServer.address().port}`;

  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  const rAdmin = await api("POST", "/api/register", {
    username: "aiboss",
    email: "admin@goutoustdio.top",
    password: "pass-word-1",
  });
  assert.equal(rAdmin.status, 201);
  adminCookie = cookiesFrom({ headers: rAdmin.headers });
  const row = db.prepare("SELECT id FROM users WHERE email=?").get("admin@goutoustdio.top");
  db.prepare("UPDATE users SET email_verified=1 WHERE id=?").run(row.id);
  syncAdmin(row.id);

  const uRes = await api("POST", "/api/exam/admin/users", {
    username: "aistu",
    displayName: "张同学",
    email: "aistu@goutoustdio.top",
    password: "0413",
    examNo: "0413",
  }, adminCookie);
  assert.equal(uRes.status, 201);
  stuId = uRes.json.user.id;

  const loginRes = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { origin: base, "content-type": "application/json" },
    body: JSON.stringify({ identifier: "0413", password: "0413" }),
  });
  assert.equal(loginRes.status, 200);
  stuCookie = cookiesFrom(loginRes);
});

after(() => {
  server.close();
  mockDsServer.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

test("AI 配置与权限保护：密钥脱敏、未配置报错、普通员工禁止配置", async () => {
  const c0 = await api("GET", "/api/exam/admin/ai-config", undefined, adminCookie);
  assert.equal(c0.status, 200);
  assert.equal(c0.json.config.configured, false);
  assert.equal(c0.json.config.model, "deepseek-flash");

  // 普通员工拒绝访问
  const f1 = await api("GET", "/api/exam/admin/ai-config", undefined, stuCookie);
  assert.equal(f1.status, 403);
  const f2 = await api("PUT", "/api/exam/admin/ai-config", { apiKey: "sk-evil" }, stuCookie);
  assert.equal(f2.status, 403);
  const f3 = await api("POST", "/api/exam/admin/parse-photos", { images: [VALID_JPEG_DATA_URL] }, stuCookie);
  assert.equal(f3.status, 403);

  // 未配置 key 时直接拍照识卷返回友好 400
  const noKey = await api("POST", "/api/exam/admin/parse-photos", { images: [VALID_JPEG_DATA_URL] }, adminCookie);
  assert.equal(noKey.status, 400);
  assert.match(noKey.json.error, /API Key/);

  // 写入测试 mock 地址与脱敏 Key
  const badUrl = await api("PUT", "/api/exam/admin/ai-config", { baseUrl: "ftp://invalid" }, adminCookie);
  assert.equal(badUrl.status, 400);

  const saved = await api("PUT", "/api/exam/admin/ai-config", {
    apiKey: "sk-mock-secret-987654",
    baseUrl: mockDsBase,
    model: "deepseek-flash",
  }, adminCookie);
  assert.equal(saved.status, 200);
  assert.equal(saved.json.config.configured, true);
  assert.equal(saved.json.config.source, "db");
  assert.ok(!saved.text.includes("sk-mock-secret-987654"), "返回中不能包含明文 API Key");
  assert.match(saved.json.config.maskedKey, /^sk-mo\*+7654$/);
});

test("拍照多图 AI 识卷 -> 保存考试 -> 考生端查看扫描答题卡 + AI 自动批改全链路", async () => {
  mockDsMode = "parse";
  const parseRes = await api("POST", "/api/exam/admin/parse-photos", {
    images: [{ pageNo: 1, imageData: VALID_JPEG_DATA_URL }],
  }, adminCookie);
  assert.equal(parseRes.status, 200);
  const p = parseRes.json.parsed;
  assert.equal(p.format, "deepseek-vision");
  assert.equal(p.questions.length, 2);
  assert.equal(p.questions[0].qtype, "listening");
  assert.equal(p.questions[1].qtype, "essay");
  assert.equal(p.questions[1].subQuestions.length, 2);

  // 校验发往 DeepSeek 的请求体包含 model=deepseek-flash、image_url、json_object
  assert.equal(lastDsRequest.model, "deepseek-flash");
  assert.equal(lastDsRequest.response_format.type, "json_object");
  assert.equal(lastDsRequest.messages[1].content[1].type, "image_url");

  // 2. 用识别结果创建已发布考试
  const examRes = await api("POST", "/api/exam/admin/exams", {
    title: p.title,
    term: p.term,
    status: "published",
    subjects: [{ name: p.subjectName, fullScore: 30, questions: p.questions }],
  }, adminCookie);
  assert.equal(examRes.status, 201);
  const examId = examRes.json.exam.id;
  const subId = examRes.json.exam.subjects[0].id;

  // 3. 上传考生答题卡扫描照片
  const upRes = await api("POST", "/api/exam/admin/papers", {
    examId,
    subjectId: subId,
    examNo: "0413",
    pageNo: 1,
    imageData: VALID_JPEG_DATA_URL,
    width: 1200,
    height: 1600,
    filterMode: "magic",
    annotations: [],
  }, adminCookie);
  assert.equal(upRes.status, 201);

  // 4. 调用 AI 自动批改答题卡（判分 + 红笔标注 + 自动保存成绩与错题本）
  mockDsMode = "grade";
  const gradeRes = await api("POST", "/api/exam/admin/ai-grade", {
    examId,
    subjectId: subId,
    userId: stuId,
    applyAnnotations: true,
    autoSave: true,
  }, adminCookie);
  assert.equal(gradeRes.status, 200);
  assert.equal(gradeRes.json.grading.score, 22);
  assert.equal(gradeRes.json.grading.wrongCount, 1);
  assert.equal(gradeRes.json.grading.pagesUpdated, 1);

  // 5. 考生端读取完整诊断报告与扫描答题卡：能看到红笔标注、小题得分、识别作答、AI批改评语及错题本
  const repRes = await api("GET", `/api/exam/exams/${examId}/report`, undefined, stuCookie);
  assert.equal(repRes.status, 200);
  const sub = repRes.json.subjects[0];
  assert.equal(sub.mine.score, 22);
  assert.equal(sub.mine.items[0].studentAnswer, "B");
  assert.equal(sub.mine.items[1].got, 12);
  assert.match(sub.mine.items[1].aiComment, /扣 8 分/);
  assert.equal(sub.papers.length, 1);
  assert.ok(sub.papers[0].annotations.length >= 3, "应自动生成总分、对勾、叉号与扣分红笔标注");

  // 错题本自动收录失分题 #2
  const misRes = await api("GET", `/api/exam/mistakes?examId=${examId}`, undefined, stuCookie);
  assert.equal(misRes.status, 200);
  assert.equal(misRes.json.mistakes.length, 1);
  assert.equal(misRes.json.mistakes[0].questionNo, "2");
});

test("AI 异常与伪造图片校验：坏图 400、上游 401 返回 400 明确提示", async () => {
  const badImg = await api("POST", "/api/exam/admin/parse-photos", {
    images: [`data:image/jpeg;base64,${Buffer.from("FAKE").toString("base64")}`],
  }, adminCookie);
  assert.equal(badImg.status, 400);

  mockDsMode = "unauthorized";
  const unauth = await api("POST", "/api/exam/admin/parse-photos", {
    images: [VALID_JPEG_DATA_URL],
  }, adminCookie);
  assert.equal(unauth.status, 400);
  assert.match(unauth.json.error, /鉴权失败/);
});
