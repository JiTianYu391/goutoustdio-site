// DeepSeek Vision 多模态拍照识卷解析引擎：
// 支持手机拍图 / 多页试卷照片（JPEG / PNG / WebP），调用 DeepSeek API（默认 deepseek-flash）提取结构化题型、分值、小问、参考答案与知识点。
import { db } from "./db.js";
import { classifySectionType } from "./exam-parser.js";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-flash";
const MAX_PHOTO_BYTES = 8 * 1024 * 1024; // 单张图片上限 8MB
export const MAX_PHOTOS_PER_REQ = 16;

const SETTINGS_KEY = "exam_deepseek_api_key";
const SETTINGS_BASE_URL = "exam_deepseek_base_url";
const SETTINGS_MODEL = "exam_deepseek_model";

const ALLOWED_QTYPES = new Set(["choice", "multi_choice", "judge", "blank", "listening", "essay", "other"]);

function round1(n) {
  return Math.round(n * 10) / 10;
}

function makeErr(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function getSetting(key) {
  const row = db.prepare("SELECT value FROM settings WHERE key=?").get(key);
  return row ? String(row.value || "") : "";
}

function setSetting(key, val) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).run(key, String(val ?? ""));
}

export function normalizeBaseUrl(rawUrl) {
  const raw = String(rawUrl || "").trim() || DEFAULT_BASE_URL;
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw makeErr("DeepSeek Base URL 格式不正确（应为 https://api.deepseek.com 等合法地址）", 400);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw makeErr("Base URL 仅支持 http 或 https 协议", 400);
  }
  return u.toString().replace(/\/+$/, "");
}

export function maskApiKey(key) {
  const s = String(key || "").trim();
  if (!s) return "";
  if (s.length <= 8) return `${s.slice(0, 2)}****`;
  return `${s.slice(0, 5)}****${s.slice(-4)}`;
}

export function getDeepSeekConfig() {
  const dbKey = getSetting(SETTINGS_KEY).trim();
  const dbBase = getSetting(SETTINGS_BASE_URL).trim();
  const dbModel = getSetting(SETTINGS_MODEL).trim();

  const envKey = String(process.env.DEEPSEEK_API_KEY || "").trim();
  const envBase = String(process.env.DEEPSEEK_BASE_URL || "").trim();
  const envModel = String(process.env.DEEPSEEK_MODEL || "").trim();

  const apiKey = dbKey || envKey;
  const source = dbKey ? "db" : envKey ? "env" : "none";
  const baseUrl = normalizeBaseUrl(dbBase || envBase || DEFAULT_BASE_URL);
  const model = (dbModel || envModel || DEFAULT_MODEL).slice(0, 80);

  return {
    configured: !!apiKey,
    source,
    maskedKey: maskApiKey(apiKey),
    baseUrl,
    model,
  };
}

export function resolveDeepSeekCredentials({ apiKeyOverride = "", baseUrlOverride = "", modelOverride = "" } = {}) {
  const cfg = getDeepSeekConfig();
  const dbKey = getSetting(SETTINGS_KEY).trim();
  const envKey = String(process.env.DEEPSEEK_API_KEY || "").trim();

  const apiKey = String(apiKeyOverride || "").trim() || dbKey || envKey;
  const baseUrl = baseUrlOverride ? normalizeBaseUrl(baseUrlOverride) : cfg.baseUrl;
  const model = String(modelOverride || "").trim().slice(0, 80) || cfg.model;

  return { apiKey, baseUrl, model };
}

export function saveDeepSeekConfig({ apiKey, baseUrl, model } = {}) {
  if (apiKey !== undefined) {
    const cleanKey = String(apiKey || "").trim().slice(0, 256);
    setSetting(SETTINGS_KEY, cleanKey);
  }
  if (baseUrl !== undefined) {
    const rawBase = String(baseUrl || "").trim();
    setSetting(SETTINGS_BASE_URL, rawBase ? normalizeBaseUrl(rawBase) : "");
  }
  if (model !== undefined) {
    const cleanModel = String(model || "").trim().slice(0, 80);
    setSetting(SETTINGS_MODEL, cleanModel);
  }
  return getDeepSeekConfig();
}

export function validatePhotoDataUrl(dataUrl) {
  const s = String(dataUrl || "").trim();
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(s);
  if (!m) {
    throw makeErr("图片格式不支持，请上传 JPEG / PNG / WebP 试卷照片", 400);
  }
  const mime = m[1];
  const rawB64 = m[2].replace(/\s+/g, "");
  const buf = Buffer.from(rawB64, "base64");
  if (!buf.length || buf.length > MAX_PHOTO_BYTES) {
    throw makeErr("单张试卷照片大小须在 1B – 8MB 之间", 400);
  }
  const isJpeg = mime === "image/jpeg" && buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const isPng = mime === "image/png" && buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isWebp = mime === "image/webp" && buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP";
  if (!isJpeg && !isPng && !isWebp) {
    throw makeErr("图片文件内容校验失败，请重新拍照或选图", 400);
  }
  return { mime, dataUrl: `data:${mime};base64,${rawB64}`, bytes: buf.length };
}

function buildSystemPrompt() {
  return [
    "你是专业的中文试卷版面分析与结构化提取助手。用户会按页码顺序上传一张或多张手机拍摄/扫描的试卷照片（可能含试题卷、听力部分、填空题、主观题/大题、答题卡、参考答案或双向细目表）。",
    "请仔细辨识所有图片里的印刷体与公式/题号/分值，并严格输出合法的 json 对象（不要输出任何 markdown 代码块说明文字之外的额外文本）。",
    "",
    "规则要求：",
    "1. qtype 枚举只能取这 7 个值之一：",
    "   - \"choice\": 选择题/单选题",
    "   - \"multi_choice\": 多选题/不定项选择题",
    "   - \"judge\": 判断题/是非题",
    "   - \"blank\": 填空题/补全题（题干中空白请用 ____ 表示）",
    "   - \"listening\": 听力题（包括听力理解、听力选择、听力填空等所有听力板块）",
    "   - \"essay\": 主观题/大题（包括大题、简答题、计算题、解答题、实验题、编程题、论述题、阅读理解、写作/作文等）",
    "   - \"other\": 其他未归类题型",
    "2. 如果图片中包含「答题卡 / 填涂卡」，请跳过答题卡上重复的涂卡编号，skippedAnswerSheet 设为 true。",
    "3. 忽略注意事项中的条款编号（如 1. 本试卷共…），只提取真正的试题。",
    "4. 选择题 title 只保留清晰简洁的题干，不必把 A/B/C/D 选项全部塞进 title。",
    "5. 主观题（大题）如果包含 (1)、(2) 等小问，请在 subQuestions 中拆出每个小问的 no（如 \"15(1)\"）、title、full（分值）、answer（如有）。",
    "6. 如果图片里包含参考答案/评分标准，请把对应答案填入对应题目的 answer；如果包含双向细目表，请把对应章节/知识点填入 tag，否则 tag 可填题型或简要考点名。",
    "",
    "必须返回如下 JSON 结构示例：",
    JSON.stringify({
      title: "2026–2027学年度上学期期末检测",
      term: "2026–2027学年度上学期",
      subjectName: "科目名（如 英语/数学/物理/综合）",
      fullScore: 100,
      duration: 90,
      mode: "闭卷",
      skippedAnswerSheet: false,
      description: "满分 100 分 · 考试时间 90 分钟",
      questions: [
        {
          no: "1",
          section: "听力理解",
          qtype: "listening",
          title: "Where does the conversation take place?",
          tag: "听力理解",
          full: 2,
          answer: "",
          subQuestions: [],
        },
        {
          no: "16",
          section: "主观题",
          qtype: "essay",
          title: "结合材料分析系统调用切换过程",
          tag: "系统调用",
          full: 15,
          answer: "",
          subQuestions: [
            { no: "16(1)", subNo: "1", title: "指出切换点", tag: "系统调用", full: 5, answer: "" },
          ],
        },
      ],
    }, null, 2),
  ].join("\n");
}

function extractJsonObjectFromText(rawText) {
  const s = String(rawText || "").trim();
  if (!s) throw makeErr("DeepSeek 未返回有效识别内容", 502);
  // 去掉可能包裹的 ```json ... ```
  const fenceM = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(s);
  const candidate = fenceM ? fenceM[1].trim() : s;
  try {
    return JSON.parse(candidate);
  } catch {
    const first = candidate.indexOf("{");
    const last = candidate.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(candidate.slice(first, last + 1));
      } catch { /* fall through */ }
    }
    throw makeErr("DeepSeek 返回的 JSON 格式无法解析，请重试", 502);
  }
}

export function normalizeAiParsedExam(raw, { pageCount = 1, model = DEFAULT_MODEL } = {}) {
  const obj = raw && typeof raw === "object" ? raw : {};
  const rawQuestions = Array.isArray(obj.questions) ? obj.questions : [];
  if (!rawQuestions.length) {
    throw makeErr("未能从照片中识别出有效题目，请确保照片清晰完整、光线充足", 422);
  }

  const usedNos = new Set();
  const questions = [];

  rawQuestions.slice(0, 150).forEach((q, idx) => {
    const rawNo = String(q?.no ?? (idx + 1)).trim().slice(0, 16) || String(idx + 1);
    let no = rawNo;
    if (usedNos.has(no)) no = `${rawNo}_${idx + 1}`;
    usedNos.add(no);

    const rawSec = String(q?.section || "").trim();
    const rawQtype = String(q?.qtype || "").trim();
    const cls = classifySectionType(rawSec);
    const qtype = ALLOWED_QTYPES.has(rawQtype) ? rawQtype : cls.qtype;
    const section = (rawSec || cls.label || "综合题").slice(0, 24);
    const defaultTag = String(q?.tag || section || "综合能力").trim().slice(0, 32) || "综合能力";

    const subQuestions = [];
    if (Array.isArray(q?.subQuestions)) {
      q.subQuestions.forEach((sq, sIdx) => {
        const subNo = String(sq?.subNo || (sIdx + 1)).trim().slice(0, 8) || String(sIdx + 1);
        const sqNo = String(sq?.no || `${no}(${subNo})`).trim().slice(0, 16);
        const sqFull = Number(sq?.full);
        subQuestions.push({
          no: sqNo,
          subNo,
          title: String(sq?.title || "").trim().slice(0, 240) || `第 ${sqNo} 问`,
          tag: String(sq?.tag || defaultTag).trim().slice(0, 32) || defaultTag,
          full: Number.isFinite(sqFull) && sqFull > 0 ? round1(sqFull) : 0,
          answer: String(sq?.answer || "").trim().slice(0, 1200),
        });
      });
    }

    const explicitFull = Number(q?.full);
    const subSum = round1(subQuestions.reduce((acc, x) => acc + (x.full > 0 ? x.full : 0), 0));
    let full = Number.isFinite(explicitFull) && explicitFull > 0
      ? round1(explicitFull)
      : subSum > 0
        ? subSum
        : qtype === "essay"
          ? 10
          : 2;

    if (subQuestions.length) {
      const missing = subQuestions.filter((sq) => sq.full <= 0);
      if (missing.length) {
        const rem = Math.max(missing.length, full - subSum);
        const each = round1(rem / missing.length);
        missing.forEach((sq) => { sq.full = each; });
      }
    }

    questions.push({
      no,
      section,
      qtype,
      title: String(q?.title || "").trim().slice(0, 240) || `第 ${no} 题`,
      tag: defaultTag,
      full: Math.max(0.5, Math.min(1000, full)),
      answer: String(q?.answer || "").trim().slice(0, 1500),
      subQuestions,
    });
  });

  // 汇总 sections 保持文档出现顺序
  const secOrder = [];
  const bySec = new Map();
  for (const q of questions) {
    let entry = bySec.get(q.section);
    if (!entry) {
      entry = {
        index: secOrder.length + 1,
        name: q.section,
        qtype: q.qtype,
        declaredCount: 0,
        questionCount: 0,
        scoreEach: 0,
        totalScore: 0,
      };
      bySec.set(q.section, entry);
      secOrder.push(entry);
    }
    entry.questionCount++;
    entry.declaredCount++;
    entry.totalScore = round1(entry.totalScore + q.full);
  }
  for (const sec of secOrder) {
    sec.scoreEach = sec.questionCount ? round1(sec.totalScore / sec.questionCount) : 0;
  }

  const calculatedFullScore = round1(questions.reduce((s, q) => s + q.full, 0));
  const rawFull = Number(obj.fullScore);
  const fullScore = Number.isFinite(rawFull) && rawFull > 0 ? round1(rawFull) : (calculatedFullScore || 100);
  const rawDur = Number(obj.duration);
  const duration = Number.isFinite(rawDur) && rawDur > 0 ? Math.round(rawDur) : null;
  const mode = String(obj.mode || "").trim().slice(0, 16);

  const title = String(obj.title || "").trim().slice(0, 100) || `拍照识卷（${questions.length} 题）`;
  const term = String(obj.term || "").trim().slice(0, 40);
  const subjectName = String(obj.subjectName || "").trim().slice(0, 40) || "综合试卷";
  const descParts = [];
  if (obj.description) descParts.push(String(obj.description).trim());
  else {
    descParts.push(`满分 ${fullScore} 分`);
    if (duration) descParts.push(`考试时间 ${duration} 分钟`);
    if (mode) descParts.push(mode);
  }
  descParts.push(`DeepSeek (${model}) 拍照识卷生成`);

  const totalSubQuestions = questions.reduce(
    (s, q) => s + (q.subQuestions.length ? q.subQuestions.length : 1),
    0,
  );
  const answeredCount = questions.filter((q) => q.answer && q.answer.trim()).length;
  const uniqueTags = new Set(questions.filter((q) => q.tag && q.tag !== q.section).map((q) => q.tag));

  return {
    filename: `拍照识卷（${pageCount} 张照片）`,
    format: `deepseek-vision`,
    pageCount,
    title,
    term,
    subjectName,
    fullScore,
    duration,
    mode,
    description: descParts.join(" · ").slice(0, 480),
    sections: secOrder,
    questions,
    specChapters: [...uniqueTags].map((chapter) => ({
      chapter,
      questionCount: questions.filter((q) => q.tag === chapter).length,
    })),
    stats: {
      totalQuestions: questions.length,
      totalSubQuestions,
      calculatedFullScore,
      answeredCount,
      taggedCount: uniqueTags.size ? questions.filter((q) => uniqueTags.has(q.tag)).length : 0,
      skippedAnswerSheet: !!obj.skippedAnswerSheet,
      hasSpecTable: uniqueTags.size > 0,
    },
  };
}

async function callDeepSeekVision({
  messages,
  creds,
  maxTokens = 8192,
  timeoutMs = 90_000,
  fetchImpl = fetch,
}) {
  if (!creds.apiKey) {
    throw makeErr("尚未配置 DeepSeek API Key，请先在「DeepSeek AI 配置」填写或设置环境变量 DEEPSEEK_API_KEY", 400);
  }
  const endpoint = creds.baseUrl.endsWith("/chat/completions")
    ? creds.baseUrl
    : `${creds.baseUrl}/chat/completions`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let resp;
  let respText = "";
  try {
    resp = await fetchImpl(endpoint, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${creds.apiKey}`,
      },
      body: JSON.stringify({
        model: creds.model,
        messages,
        response_format: { type: "json_object" },
        temperature: 0.1,
        max_tokens: maxTokens,
      }),
    });
    respText = await resp.text();
  } catch (e) {
    if (e?.name === "AbortError") {
      throw makeErr("DeepSeek API 请求超时（90s），建议减少单次页数或降低图片分辨率后重试", 504);
    }
    throw makeErr(`无法连接 DeepSeek API：${e?.message || "网络错误"}`, 502);
  } finally {
    clearTimeout(timer);
  }

  let respJson = null;
  try {
    respJson = JSON.parse(respText);
  } catch { /* keep null */ }

  if (!resp.ok) {
    const remoteMsg = respJson?.error?.message || respJson?.message || respText.slice(0, 200);
    if (resp.status === 401 || resp.status === 403) {
      throw makeErr(`DeepSeek API Key 鉴权失败（HTTP ${resp.status}）：${remoteMsg}`, 400);
    }
    if (resp.status === 400 && /image|vision|multimodal|not support|content/i.test(String(remoteMsg))) {
      throw makeErr(`当前模型「${creds.model}」可能不支持图片输入，建议使用支持多模态识图的 deepseek-flash（原始错误：${remoteMsg}）`, 400);
    }
    throw makeErr(`DeepSeek API 返回错误（HTTP ${resp.status}）：${remoteMsg}`, 502);
  }

  const content = respJson?.choices?.[0]?.message?.content;
  return extractJsonObjectFromText(content);
}

export async function parseExamPhotosWithAI({
  images,
  apiKey: apiKeyOverride = "",
  baseUrl: baseUrlOverride = "",
  model: modelOverride = "",
  fetchImpl = fetch,
}) {
  if (!Array.isArray(images) || !images.length || images.length > MAX_PHOTOS_PER_REQ) {
    throw makeErr(`每次最多上传 1–${MAX_PHOTOS_PER_REQ} 张试卷照片`, 400);
  }

  const validImages = images.map((item) => {
    const rawUrl = typeof item === "string" ? item : item?.imageData || item?.dataUrl || "";
    return validatePhotoDataUrl(rawUrl);
  });

  const creds = resolveDeepSeekCredentials({ apiKeyOverride, baseUrlOverride, modelOverride });
  const parsedRaw = await callDeepSeekVision({
    creds,
    fetchImpl,
    messages: [
      { role: "system", content: buildSystemPrompt() },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `请识别以下按顺序排列的 ${validImages.length} 页试卷照片，完整提取试卷信息、所有题型（选择题、多选题、判断题、填空题、听力题、主观题/大题等）、小题分值、小问及参考答案，严格按 json 格式输出。`,
          },
          ...validImages.map((img) => ({
            type: "image_url",
            image_url: { url: img.dataUrl },
          })),
        ],
      },
    ],
  });

  return normalizeAiParsedExam(parsedRaw, {
    pageCount: validImages.length,
    model: creds.model,
  });
}

function buildGradingSystemPrompt({ subjectName, fullScore, template }) {
  const hasTpl = Array.isArray(template) && template.length > 0;
  return [
    "你是严谨专业的智能阅卷老师（智学网式 AI 阅卷引擎）。你会看到考生上传的答题卡/手写答卷扫描照片（按第 1 页…第 N 页排序），以及本题库的标准题目与参考答案。",
    "请逐题识别考生在答题卡/试卷上的作答（包括选择题填涂、填空手写、听力作答、主观大题书面作答），对照参考答案与评分标准客观给分，并给出可直接在答题卡上绘制红笔批改标记的位置坐标。",
    "必须严格输出合法 json 对象！",
    "",
    `科目：${subjectName || "综合"}，科目满分：${fullScore} 分。`,
    hasTpl
      ? "请严格按照给定题目清单的题号 `no` 逐题批改输出（共 " + template.length + " 题，不要遗漏）："
      : "当前科目未预设小题清单，请从答卷中识别出全部作答题号与分值并批改：",
    "",
    "每道题输出字段要求：",
    "- no: 字符串题号（若已提供清单，必须与清单中的 no 完全一致）",
    "- pageNo: 该题作答所在的页码（从 1 开始的整数）",
    "- studentAnswer: 识别到的考生手写或填涂作答摘要（空题填 \"未作答\"）",
    "- full: 满分（数字）",
    "- got: 判得分值（0 到 full 之间的数字，支持 0.5 分步长）",
    "- isCorrect: 是否满分全对（true/false）",
    "- reason: 简短精准的批改评语/扣分原因（如 \"填涂 B，正确\" 或 \"选 C（应为 B）\" 或 \"未说明 sysret 返回环 3，扣 2 分\"）",
    "- markPos: { x, y } 归一化坐标（0.08~0.92 之间），指向该题号或考生答案旁适合加盖红色对勾 ✓ / 叉号 ✗ / 扣分批注的位置",
    "",
    "必须返回的 json 格式示例：",
    JSON.stringify({
      totalScore: 86,
      teacherComment: "总体完成度较高，客观题全对，主观题第 36 题特权级切换细节略缺。",
      items: [
        {
          no: "1",
          pageNo: 1,
          studentAnswer: "B",
          full: 2,
          got: 2,
          isCorrect: true,
          reason: "选择 B，回答正确",
          markPos: { x: 0.28, y: 0.24 },
        },
        {
          no: "36",
          pageNo: 2,
          studentAnswer: "仅写出系统调用进入内核",
          full: 15,
          got: 11,
          isCorrect: false,
          reason: "第(3)问缺少 sysret 返回环 3 说明，扣 4 分",
          markPos: { x: 0.72, y: 0.45 },
        },
      ],
    }, null, 2),
  ].join("\n");
}

function clamp01Margin(v, def = 0.5) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.round(Math.max(0.06, Math.min(0.94, n)) * 1000) / 1000;
}

export function normalizeAiGradingResult(raw, { subject, pagesMeta = [], model = DEFAULT_MODEL } = {}) {
  const obj = raw && typeof raw === "object" ? raw : {};
  const template = Array.isArray(subject?.questions) ? subject.questions : [];
  const fullScoreLimit = Math.max(1, Number(subject?.fullScore) || 100);
  const rawItems = Array.isArray(obj.items) ? obj.items : [];
  const pageCount = Math.max(1, pagesMeta.length || 1);

  const byNo = new Map();
  for (const x of rawItems) {
    if (x && x.no !== undefined && x.no !== null) {
      byNo.set(String(x.no).trim(), x);
    }
  }

  let items = [];
  if (template.length) {
    items = template.map((q) => {
      const hit = byNo.get(String(q.no).trim());
      const full = Math.max(0.5, Number(q.full) || 1);
      const gotRaw = hit ? Number(hit.got) : 0;
      const got = Number.isFinite(gotRaw) ? round1(Math.max(0, Math.min(full, gotRaw))) : 0;
      const pageNoRaw = hit ? Number(hit.pageNo) : 1;
      const pageNo = Number.isFinite(pageNoRaw) ? Math.max(1, Math.min(pageCount, Math.round(pageNoRaw))) : 1;
      const out = {
        no: q.no,
        title: q.title || "",
        tag: q.tag || "综合能力",
        full,
        got,
        wrong: got < full - 1e-6,
        answer: q.answer || "",
        studentAnswer: hit ? String(hit.studentAnswer || "").trim().slice(0, 500) : "未识别",
        aiComment: hit ? String(hit.reason || "").trim().slice(0, 500) : "",
        pageNo,
        markPos: hit?.markPos && typeof hit.markPos === "object" ? hit.markPos : null,
      };
      if (q.section) out.section = q.section;
      if (q.qtype) out.qtype = q.qtype;
      return out;
    });
  } else {
    if (!rawItems.length) {
      throw makeErr("AI 未能从答卷中识别出具体得分条目，请确认照片包含考生作答区域", 422);
    }
    items = rawItems.slice(0, 150).map((x, idx) => {
      const no = String(x?.no || (idx + 1)).trim().slice(0, 16) || String(idx + 1);
      const full = Math.max(0.5, Math.min(1000, Number(x?.full) || 10));
      const got = round1(Math.max(0, Math.min(full, Number(x?.got) || 0)));
      const pageNo = Math.max(1, Math.min(pageCount, Math.round(Number(x?.pageNo) || 1)));
      return {
        no,
        title: String(x?.title || `第 ${no} 题`).trim().slice(0, 240),
        tag: String(x?.tag || "综合能力").trim().slice(0, 32) || "综合能力",
        full,
        got,
        wrong: got < full - 1e-6,
        answer: String(x?.answer || "").trim().slice(0, 1500),
        studentAnswer: String(x?.studentAnswer || "").trim().slice(0, 500),
        aiComment: String(x?.reason || "").trim().slice(0, 500),
        pageNo,
        markPos: x?.markPos && typeof x.markPos === "object" ? x.markPos : null,
      };
    });
  }

  const itemsSum = round1(items.reduce((s, it) => s + it.got, 0));
  const rawTotal = Number(obj.totalScore);
  const score = items.length
    ? Math.min(fullScoreLimit, itemsSum)
    : Number.isFinite(rawTotal)
      ? round1(Math.max(0, Math.min(fullScoreLimit, rawTotal)))
      : 0;

  const teacherComment = (String(obj.teacherComment || "").trim()
    || `DeepSeek (${model}) 自动阅卷：共识别 ${items.length} 题，实得 ${score} / ${fullScoreLimit} 分。`)
    .slice(0, 500);

  const annotationsByPageNo = new Map();
  const pageFallbacks = new Map();
  for (let i = 0; i < pageCount; i++) pageFallbacks.set(i + 1, 0);

  for (const it of items) {
    const pNo = it.pageNo || 1;
    if (!annotationsByPageNo.has(pNo)) annotationsByPageNo.set(pNo, []);
    const arr = annotationsByPageNo.get(pNo);
    if (arr.length >= 60) continue;

    let x, y;
    if (it.markPos && (it.markPos.x !== undefined || it.markPos.y !== undefined)) {
      x = clamp01Margin(it.markPos.x, 0.8);
      y = clamp01Margin(it.markPos.y, 0.2);
    } else {
      const idxOnPage = pageFallbacks.get(pNo) || 0;
      pageFallbacks.set(pNo, idxOnPage + 1);
      const col = idxOnPage % 2;
      const row = Math.floor(idxOnPage / 2);
      x = col === 0 ? 0.14 : 0.56;
      y = clamp01Margin(0.14 + (row % 10) * 0.08, 0.2);
    }

    const markText = it.wrong
      ? `✗ #${it.no} (${it.got}/${it.full})`
      : `✓ #${it.no} +${it.got}`;
    arr.push({
      type: it.wrong ? "cross" : "check",
      x,
      y,
      color: "#ef4444",
    });
    if (items.length <= 30 || it.wrong) {
      arr.push({
        type: "text",
        x: clamp01Margin(x + 0.04, x),
        y: clamp01Margin(y + 0.01, y),
        text: markText.slice(0, 32),
        color: "#ef4444",
      });
    }
  }

  const firstPageNo = pagesMeta[0]?.pageNo || 1;
  if (!annotationsByPageNo.has(firstPageNo)) annotationsByPageNo.set(firstPageNo, []);
  annotationsByPageNo.get(firstPageNo).unshift({
    type: "text",
    x: 0.78,
    y: 0.07,
    text: `AI 得分: ${score}/${fullScoreLimit}`,
    color: "#ef4444",
  });

  const cleanItems = items.map(({ pageNo: _p, markPos: _m, ...rest }) => rest);

  return {
    score,
    fullScore: fullScoreLimit,
    teacherComment,
    items: cleanItems,
    annotationsByPageNo,
    model,
    wrongCount: cleanItems.filter((it) => it.wrong).length,
  };
}

export async function gradeExamPapersWithAI({
  pages,
  subject,
  apiKey: apiKeyOverride = "",
  baseUrl: baseUrlOverride = "",
  model: modelOverride = "",
  fetchImpl = fetch,
}) {
  if (!Array.isArray(pages) || !pages.length || pages.length > MAX_PHOTOS_PER_REQ) {
    throw makeErr(`待批改答题卡页数须在 1–${MAX_PHOTOS_PER_REQ} 页之间`, 400);
  }
  const creds = resolveDeepSeekCredentials({ apiKeyOverride, baseUrlOverride, modelOverride });
  const tpl = Array.isArray(subject?.questions) ? subject.questions : [];
  const tplText = tpl.length
    ? tpl.map((q) => `- 题号 ${q.no} [${q.section || q.qtype || "题"}] (满分 ${q.full} 分)：${q.title || ""} | 参考答案：${q.answer || "（未提供，请结合题目自行判断）"}`).join("\n")
    : "（未预设具体小题模板，请根据答题卡作答自行识别题号、分值与得分。）";

  const parsedRaw = await callDeepSeekVision({
    creds,
    fetchImpl,
    messages: [
      {
        role: "system",
        content: buildGradingSystemPrompt({
          subjectName: subject?.name,
          fullScore: subject?.fullScore,
          template: tpl,
        }),
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `请批改这 ${pages.length} 页考生答题卡/答卷。\n\n【题目清单与参考答案】\n${tplText}\n\n请按 json 格式返回总分、评语及每道小题的识别作答、得分、扣分原因和红笔坐标。`,
          },
          ...pages.map((p) => ({
            type: "image_url",
            image_url: { url: p.dataUrl },
          })),
        ],
      },
    ],
  });

  return normalizeAiGradingResult(parsedRaw, {
    subject,
    pagesMeta: pages.map((p) => ({ pageNo: p.pageNo })),
    model: creds.model,
  });
}
