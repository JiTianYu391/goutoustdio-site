// 试卷文档自动解析 (/api/exam/admin/parse-doc) 与全站单文件主导航回归测试
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmpDir = mkdtempSync(path.join(tmpdir(), "gs-parser-test-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "test";
process.env.SITE_URL = "http://127.0.0.1";
process.env.ADMIN_EMAIL = "admin@goutoustdio.top";

const { app } = await import("../server/index.js");
const { db } = await import("../server/db.js");
const { syncAdmin } = await import("../server/util.js");
const { parseExamText, parseExamDocument } = await import("../server/exam-parser.js");

let server, base, adminCookie, userCookie;

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

// 动态生成最小合法文字层 PDF（ASCII 字符串，支持不限内容行）
function buildSimplePdf(lines) {
  const esc = (s) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  let stream = "BT\n/F1 11 Tf\n48 760 Td\n15 TL\n";
  for (const ln of lines) {
    stream += `(${esc(ln)}) Tj T*\n`;
  }
  stream += "ET\n";

  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    `5 0 obj\n<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}endstream\nendobj\n`,
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += obj;
  }
  const xrefPos = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

// 纯 Node 生成无压缩 ZIP (STORE=0) 用于构造最小合法 .docx
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const ent of entries) {
    const nameBuf = Buffer.from(ent.name, "utf8");
    const dataBuf = Buffer.from(ent.content, "utf8");
    const crc = crc32(dataBuf);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(dataBuf.length, 18);
    local.writeUInt32LE(dataBuf.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(dataBuf.length, 20);
    central.writeUInt32LE(dataBuf.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);

    locals.push(local, dataBuf);
    centrals.push(central);
    offset += local.length + dataBuf.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

function buildSimpleDocx(paragraphs) {
  const escXml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = paragraphs.map((p) => `<w:p><w:r><w:t>${escXml(p)}</w:t></w:r></w:p>`).join("");
  return buildZip([
    {
      name: "[Content_Types].xml",
      content: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/contenttypes"><Default Extension="rels" ContentType="application/vnd.openxmlformats-officedocument.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    },
    {
      name: "_rels/.rels",
      content: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    },
    {
      name: "word/document.xml",
      content: `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    },
  ]);
}

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  const rAdmin = await api("POST", "/api/register", {
    username: "parserboss",
    email: "admin@goutoustdio.top",
    password: "pass-word-1",
  });
  assert.equal(rAdmin.status, 201);
  adminCookie = cookiesFrom({ headers: rAdmin.headers });
  const row = db.prepare("SELECT id FROM users WHERE email=?").get("admin@goutoustdio.top");
  db.prepare("UPDATE users SET email_verified=1 WHERE id=?").run(row.id);
  syncAdmin(row.id);

  const uRes = await api("POST", "/api/exam/admin/users", {
    username: "staff1",
    displayName: "测试员工",
    email: "staff1@goutoustdio.top",
    password: "1234",
    examNo: "0413",
  }, adminCookie);
  assert.equal(uRes.status, 201);

  const loginRes = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { origin: base, "content-type": "application/json" },
    body: JSON.stringify({ identifier: "0413", password: "1234" }),
  });
  assert.equal(loginRes.status, 200);
  userCookie = cookiesFrom(loginRes);
});

after(() => {
  server.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

test("中文试卷状态机解析器：康熙部首归一化、注意事项跳过、续页合并、答题卡跳过、答案与双向细目表全匹配", () => {
  const pages = [
    [
      "天津市南开区2026‒2027学年度七年级上学期",
      "内核技术期末检测",
      "（满分 100 分，考试时间 90 分钟，开卷）",
      "⼀   ⼆   三   总分",
      "注意事项：",
      "1. 本试卷分试题卷和答题卡两部分。",
      "2. 考⽣务必填写考号。",
      "⼀、选择题（本大题共 4 ⼩题，每⼩题 5 分，共 20 分。）",
      "1. 下列关于内核的说法，正确的是（ ）",
      "图 1 CPU 特权环⽰意图（环 0 权限",
      "最⾼，环 3 为⽤⼾态）",
      "A. 运行在用户态 B. 运行在环 0",
      "2. 计算机启动时，正确的顺序是（ ）",
      "A. 内核 -> BIOS B. BIOS -> 内核",
      "内核技术试题 第 1 ⻚（共 4 ⻚）",
    ].join("\n"),
    [
      "⼀、选择题（续）",
      "3. 根据图 2，属于混合内核的是（ ）",
      "A. Linux B. Windows NT",
      "宏内核",
      "微内核",
      "图 2 三种内核架构对比",
      "4. 下列属于持久文件系统的是（ ）",
      "A. tmpfs B. ext4",
      "⼆、填空题（本大题共 2 空，每空 15 分，共 30 分。）",
      "5. 内核运行在 CPU 的   特权级。",
      "6. 在 x86-64 上，进入内核使用   指令。",
      "三、大题（本大题共 1 小题，共 50 分。）",
      "7. 结合下列模拟代码回答问题：",
      "#include <stdio.h>",
      "int is_in_ring0 = 0;",
      "is_in_ring0 = 1;",
      "(1) 说明 is_in_ring0 = 1 的含义。（20 分）",
      "(2) 说明加载内核模块是否需要重启。（30 分）",
      "（ 试 题 卷 完 ）",
      "内核技术试题 第 2 ⻚（共 4 ⻚）",
    ].join("\n"),
    [
      "答 题 卡",
      "一、选择题（1–4 题）",
      "1. A B C D  2. A B C D",
      "二、填空题",
      "5. ________  6. ________",
      "答题卡 第 1 ⻚（共 1 ⻚）",
    ].join("\n"),
    [
      "参考答案及评分标准（教师用）",
      "一、选择题（每小题 5 分，共 20 分）",
      "1.B 2.B 3.B 4.B",
      "二、填空题（每空 15 分，共 30 分）",
      "5. 环 0 6. syscall",
      "三、大题（共 50 分）",
      "7.（50 分）（1）模拟用户态进入内核态的过程（20 分）。（2）支持动态加载，无需重启系统（30 分）。",
      "双向细目表",
      "第一章 内核初步认识   选择题 1‒2；填空题 5   25",
      "第二章 系统调用   选择题 3‒4；填空题 6；大题 7(1)   45",
      "第三章 内核模块   大题 7(2)   30",
      "合计   100",
    ].join("\n"),
  ];

  const parsed = parseExamText(pages, "内核技术期末检测.pdf");
  assert.equal(parsed.title, "天津市南开区2026–2027学年度七年级上学期内核技术期末检测");
  assert.equal(parsed.term, "2026–2027学年度七年级上学期");
  assert.equal(parsed.subjectName, "内核技术");
  assert.equal(parsed.fullScore, 100);
  assert.equal(parsed.duration, 90);
  assert.equal(parsed.mode, "开卷");
  assert.equal(parsed.stats.skippedAnswerSheet, true);
  assert.equal(parsed.sections.length, 3);
  assert.deepEqual(
    parsed.sections.map((s) => [s.name, s.questionCount, s.totalScore]),
    [["选择题", 4, 20], ["填空题", 2, 30], ["大题", 1, 50]],
  );
  assert.equal(parsed.questions.length, 7);
  assert.equal(parsed.stats.answeredCount, 7);
  assert.equal(parsed.stats.taggedCount, 7);
  assert.equal(parsed.questions[0].title, "下列关于内核的说法，正确的是（ ）");
  assert.equal(parsed.questions[0].answer, "B");
  assert.equal(parsed.questions[4].title, "内核运行在 CPU 的 ____ 特权级。");
  assert.equal(parsed.questions[4].answer, "环 0");
  assert.equal(parsed.questions[5].answer, "syscall");
  assert.equal(parsed.questions[6].subQuestions.length, 2);
  assert.equal(parsed.questions[6].subQuestions[0].tag, "第二章系统调用");
  assert.equal(parsed.questions[6].subQuestions[1].tag, "第三章内核模块");
  assert.equal(JSON.stringify(parsed).match(/[\u2e80-\u2fdf]/g), null);
});

test("接口联调：PDF 二进制上传解析 -> 保存考试并保留题型/完整评分标准", async () => {
  const pdfBuf = buildSimplePdf([
    "2026 Spring Kernel Assessment",
    "(Full Score 100, Duration 60 min)",
    "1. Which privilege ring runs kernel code?",
    "A. Ring 3  B. Ring 0",
    "2. Which register holds syscall entry on x86-64?",
    "Answer Reference",
    "1. B  2. LSTAR",
  ]);
  const res = await api("POST", "/api/exam/admin/parse-doc", {
    filename: "kernel-spring.pdf",
    mimeType: "application/pdf",
    fileDataUrl: `data:application/pdf;base64,${pdfBuf.toString("base64")}`,
  }, adminCookie);
  assert.equal(res.status, 200);
  assert.equal(res.json.parsed.format, "pdf");
  assert.equal(res.json.parsed.pageCount, 1);
  assert.ok(res.json.parsed.questions.length >= 2);

  // 同时测试超过 100 题且含较长解析的试卷能够顺利写入数据库（验证 512kb 与 150 题上限）
  const manyQuestions = Array.from({ length: 105 }, (_, i) => ({
    no: String(i + 1),
    title: `第 ${i + 1} 题题干：内核机制分析`,
    section: i < 80 ? "选择题" : "大题",
    qtype: i < 80 ? "choice" : "essay",
    tag: `第 ${(i % 4) + 1} 章`,
    full: 1,
    answer: i === 104 ? "完整评分标准：".repeat(100) : "A",
  }));
  const createRes = await api("POST", "/api/exam/admin/exams", {
    title: "2026 百题压力测试考",
    term: "2026-Q4",
    status: "published",
    subjects: [{ name: "内核综合", fullScore: 105, passScore: 63, excellentScore: 90, questions: manyQuestions }],
  }, adminCookie);
  assert.equal(createRes.status, 201);
  assert.equal(createRes.json.exam.subjects[0].questions.length, 105);
  assert.equal(createRes.json.exam.subjects[0].questions[104].qtype, "essay");
  assert.ok(createRes.json.exam.subjects[0].questions[104].answer.length > 500);
});

test("接口联调：Word (.docx) 二进制上传解析并识别题型、答案与细目表", async () => {
  const docxBuf = buildSimpleDocx([
    "2026–2027学年度秋季内部考核",
    "操作系统核心能力测试",
    "（满分 100 分，考试时间 60 分钟，闭卷）",
    "一、选择题（本大题共 2 小题，每小题 25 分，共 50 分。）",
    "1. 系统调用从用户态进入内核态依靠什么机制？",
    "A. 普通函数调用 B. 陷入指令",
    "2. 虚拟文件系统抽象层简称是什么？",
    "A. VFS B. FAT",
    "二、填空题（本大题共 1 空，每空 50 分，共 50 分。）",
    "3. 设备节点目录挂载点通常是 ____ 文件系统。",
    "参考答案",
    "一、选择题",
    "1.B 2.A",
    "二、填空题",
    "3. devtmpfs",
    "双向细目表",
    "第一章 系统调用 选择题 1 25",
    "第二章 文件系统 选择题 2；填空题 3 75",
  ]);

  const res = await api("POST", "/api/exam/admin/parse-doc", {
    filename: "os-test.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    fileDataUrl: `data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${docxBuf.toString("base64")}`,
  }, adminCookie);
  assert.equal(res.status, 200);
  const p = res.json.parsed;
  assert.equal(p.format, "docx");
  assert.equal(p.fullScore, 100);
  assert.equal(p.mode, "闭卷");
  assert.equal(p.questions.length, 3);
  assert.equal(p.questions[0].answer, "B");
  assert.equal(p.questions[1].answer, "A");
  assert.equal(p.questions[2].answer, "devtmpfs");
  assert.equal(p.questions[0].tag, "第一章系统调用");
  assert.equal(p.questions[2].tag, "第二章文件系统");
});

test("安全性与异常文件校验：越权 403、伪造魔数 400、旧版 .doc 400、无文字层纯图 PDF 422", async () => {
  const validTextRes = await api("POST", "/api/exam/admin/parse-doc", {
    filename: "sample.txt",
    text: "一、选择题（共 1 题，每题 10 分，共 10 分）\n1. 测试题干\nA. 对 B. 错\n参考答案\n1.A",
  }, adminCookie);
  assert.equal(validTextRes.status, 200);

  // 普通员工无权调用
  const forbidden = await api("POST", "/api/exam/admin/parse-doc", {
    filename: "sample.txt",
    text: "一、选择题（共 1 题）\n1. 测试",
  }, userCookie);
  assert.equal(forbidden.status, 403);

  // 未登录拒绝
  const unauth = await api("POST", "/api/exam/admin/parse-doc", {
    filename: "sample.txt",
    text: "测试",
  });
  assert.equal(unauth.status, 401);

  // 伪造 PDF 魔数
  const fakePdf = await api("POST", "/api/exam/admin/parse-doc", {
    filename: "fake.pdf",
    mimeType: "application/pdf",
    fileDataUrl: `data:application/pdf;base64,${Buffer.from("NOT_A_PDF_FILE").toString("base64")}`,
  }, adminCookie);
  assert.equal(fakePdf.status, 400);

  // 旧版 OLE2 .doc 提示
  const oldDoc = await api("POST", "/api/exam/admin/parse-doc", {
    filename: "legacy.doc",
    mimeType: "application/msword",
    fileDataUrl: `data:application/msword;base64,${Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).toString("base64")}`,
  }, adminCookie);
  assert.equal(oldDoc.status, 400);
  assert.match(oldDoc.json.error, /\.docx/);

  // 合法 PDF 但无任何文字（模拟纯图扫描 PDF）
  const emptyPdf = buildSimplePdf([]);
  const noTextRes = await api("POST", "/api/exam/admin/parse-doc", {
    filename: "scan-only.pdf",
    mimeType: "application/pdf",
    fileDataUrl: `data:application/pdf;base64,${emptyPdf.toString("base64")}`,
  }, adminCookie);
  assert.equal(noTextRes.status, 422);
  assert.match(noTextRes.json.error, /文字层/);
});

test("题型扩展：支持听力题与主观题（大题）识别、答案回填、细目表映射与落库保存", async () => {
  const sampleText = [
    "2026年内部英语与架构综合检测",
    "（满分 100 分，考试时间 60 分钟）",
    "一、听力理解（本大题共 2 小题，每小题 10 分，共 20 分。）",
    "1. Where is the deployment meeting held?",
    "A. Room 101 B. Room 202 C. Online",
    "2. The release starts at ____.",
    "二、主观题（本大题共 1 小题，共 80 分。）",
    "3. 请阐述系统架构设计思路：",
    "(1) 说明模块拆分依据。（40 分）",
    "(2) 说明容灾与回滚方案。（40 分）",
    "参考答案",
    "一、听力理解",
    "1.B 2. 14:30",
    "二、主观题",
    "3.（80 分）（1）按领域边界拆分（40 分）。（2）保留双版本镜像与健康检查（40 分）。",
    "双向细目表",
    "语音理解 听力理解 1–2 20",
    "系统设计 主观题 3(1)(2) 80",
  ].join("\n");

  const parsedRes = await api("POST", "/api/exam/admin/parse-doc", {
    filename: "listening-subjective.txt",
    text: sampleText,
  }, adminCookie);
  assert.equal(parsedRes.status, 200);
  const p = parsedRes.json.parsed;
  assert.equal(p.sections.length, 2);
  assert.equal(p.sections[0].qtype, "listening");
  assert.equal(p.sections[1].qtype, "essay");
  assert.equal(p.questions[0].qtype, "listening");
  assert.equal(p.questions[0].answer, "B");
  assert.equal(p.questions[1].qtype, "listening");
  assert.equal(p.questions[1].answer, "14:30");
  assert.equal(p.questions[2].qtype, "essay");
  assert.equal(p.questions[2].section, "主观题");
  assert.equal(p.questions[0].tag, "语音理解");
  assert.equal(p.questions[2].subQuestions.length, 2);
  assert.equal(p.questions[2].subQuestions[0].tag, "系统设计");

  const saveRes = await api("POST", "/api/exam/admin/exams", {
    title: "听力与主观题存储测试",
    subjects: [{ name: "综合", fullScore: 100, questions: p.questions }],
  }, adminCookie);
  assert.equal(saveRes.status, 201);
  assert.equal(saveRes.json.exam.subjects[0].questions[0].qtype, "listening");
  assert.equal(saveRes.json.exam.subjects[0].questions[2].qtype, "essay");
});

test("全站主导航收敛为单一配置文件 nav-config.js", () => {
  const pubDir = path.resolve(process.cwd(), "public");
  const mainPages = [
    ...readdirSync(pubDir).filter((f) => f.endsWith(".html")).map((f) => path.join(pubDir, f)),
    ...readdirSync(path.join(pubDir, "ota")).filter((f) => f.endsWith(".html")).map((f) => path.join(pubDir, "ota", f)),
  ];
  assert.equal(mainPages.length, 21);

  for (const file of mainPages) {
    const html = readFileSync(file, "utf8");
    assert.match(
      html,
      /<nav class="site-nav" id="site-nav" aria-label="主导航"><\/nav>/,
      `${path.basename(file)} 应使用空的 #site-nav 占位`,
    );
    assert.ok(html.includes('<script src="/js/nav-config.js"></script>'), `${path.basename(file)} 应引入 /js/nav-config.js`);
  }

  const docsDir = path.join(pubDir, "docs");
  const docPages = readdirSync(docsDir).filter((f) => f.endsWith(".html"));
  assert.equal(docPages.length, 7);
  for (const f of docPages) {
    const html = readFileSync(path.join(docsDir, f), "utf8");
    assert.ok(html.includes('<script src="/js/nav-config.js"></script>'), `docs/${f} 应引入 /js/nav-config.js`);
  }

  const navConfigSrc = readFileSync(path.join(pubDir, "js/nav-config.js"), "utf8");
  assert.ok(navConfigSrc.includes('id: "products"') && navConfigSrc.includes('id: "downloads"') && navConfigSrc.includes('id: "more"'));
  assert.ok(!parseExamDocument.toString().includes("PLACEHOLDER"));
});
