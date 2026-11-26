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
    "请仔细辨识所有图片里的印刷体与手写体内容、涂改液修改后的最终字迹、手绘流程图/代码框、题号与分值，并严格输出合法的 json 对象（不要输出任何 markdown 代码块说明文字之外的额外文本）。",
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
    "2. 支持「手写试题卷 + 手写标准答案页」多张照片同时上传：若某张照片是手写/打印的「标准答案」「参考答案」「评分标准」（可能是多栏排版如左栏 1–3、中栏 4–6、右栏 7–10，且可能有涂改液重写），务必把对应题号的最终答案完整合并到对应题目的 answer 字段，并原样保留「意思对即可」「符合题意即可」「言之有理即可」等弹性评分说明。若同时附上试题题干，不要把「参考答案页」单独重复当成一套新题目。",
    "3. 如果图片中包含「答题卡 / 填涂卡」等重复填涂区，请跳过答题卡涂卡编号（但可从卷头获取考试标题/学科），skippedAnswerSheet 设为 true。",
    "4. 忽略页边警告（如「请勿在密封线外答题」）及「注意事项」「考生须知」条款编号（如 1. 本试卷共…），只提取真正的试题。",
    "5. 选择题 title 保留简洁完整题干（不必把 A/B/C/D 选项全部塞进 title）；若题干引用右侧/下方流程图或代码框（如「如图2」「如图3 Python程序」），可把关键条件简明概括进 title。",
    "6. 大题/主观题若每题分值已写在所属大题说明上（如「一、选择题（共60分，每题6分）」「二、主观题（共40分，每小题20分）」），务必正确推算每道小题的 full 分值（如 6 或 20）。",
    "7. 主观题（大题）如果包含 (1)、(2) 等小问，请在 subQuestions 中拆出每个小问的 no（如 \"15(1)\"）、title、full（分值）、answer（如有）。",
    "8. 如果包含双向细目表，请把对应章节/知识点填入 tag，否则 tag 可填题型或简要考点名。",
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
  timeoutMs = 120_000,
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
      throw makeErr("DeepSeek API 请求超时（120s），建议减少单次页数或降低图片分辨率后重试", 504);
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
    "你是严谨专业的智能阅卷老师（智学网式 AI 阅卷引擎）。你会看到考生上传的印刷或手写答题卡/答卷扫描照片（按第 1 页…第 N 页排序），以及本题库的标准题目与参考答案。",
    "请逐题精准识别考生在答题卡/试卷上的作答（支持印刷填涂卡与手绘方框涂黑卡片、手写中文/英文/代码答案），对照参考答案与评分标准独立、客观地给分，并按整张上传图片的 0–1000 相对坐标系输出精准的红笔批改位置。",
    "必须严格输出合法 json 对象！",
    "",
    `科目：${subjectName || "综合"}，科目满分：${fullScore} 分。`,
    hasTpl
      ? "请严格按照给定题目清单的题号 `no` 逐题批改输出（共 " + template.length + " 题，不要遗漏）："
      : "当前科目未预设小题清单，请从答卷中识别出全部作答题号与分值并批改：",
    "",
    "重要识别与定位规范：",
    "1. 卷头考生信息：尽量从答题卡顶部读取考号（如 4 位数字 `0413`，可结合「考号」手写框及右上角准考证号填涂区交叉验证）、姓名（name）与部门（department），写入 detectedStudent。",
    "2. 手绘/手涂选择题方框识别：多栏排列的选择题方框（如 1.[A][B][■C] 4.[A][■B][C]）中，请严格以「整框涂黑/阴影最深」的选项字母为考生所选；注意对照卡面上可能印刷或手写的「填涂示例」（例如斜线/浅划/误涂通常表示无效或划销），逐题核对题号数字与紧邻的一排选项框，避免跨栏看错题号或把涂改前划掉的方框误认为当前选择。",
    "3. 主观题与弹性标准：若参考答案注明「意思对即可」「符合题意即可」「言之有理即可」等弹性标准，只要考生手写答案的核心概念正确且自圆其说即应给满分或酌情给高分，不要机械逐字扣分。",
    "4. 独立阅卷原则：必须完全根据考生实际作答与标准答案判分，不要直接抄写卷面上可能已经存在的手写红字分数！",
    "5. 精准坐标规范（按整张图片的 0–1000 相对比例定位）：",
    "   - 坐标系以**整张上传图片**的左上角为 `(0, 0)`、右下角为 `(1000, 1000)`；若照片/截图外围带有平板边框、桌面留白或黑边，也必须把外围留白占用的整图比例算入 `(x, y)`，保证红笔标注严丝合缝落在纸面对应位置上。",
    "   - totalScorePos: `{ \"x\": 0..1000, \"y\": 0..1000 }`，指向第 1 页顶部空白处（如标题与准考证号框之间的空白区域，避开条形码、二维码与文字），用于书写红色总分数字。",
    "   - 每题 markPos: `{ \"x\": 0..1000, \"y\": 0..1000 }`：",
    "     * 选择题/客观题的 `markPos` 必须精准落在**「一、选择题」标题下方该题自身的选项方框中右侧**！绝对不要偏移到上方的「考生须知」「考生禁填」或「填涂示例」区域！",
    "     * 主观题/大题的 `markPos` 应指向考生该题手写作答文字**紧下方或右侧空白处**，避免遮挡正文。",
    "",
    "每道题输出字段要求：",
    "- no: 字符串题号（若已提供清单，必须与清单中的 no 完全一致）",
    "- pageNo: 该题作答所在的页码（从 1 开始的整数）",
    "- studentAnswer: 识别到的考生手写或填涂作答摘要（空题填 \"未作答\"）",
    "- full: 满分（数字）",
    "- got: 判得分值（0 到 full 之间的数字，支持 0.5 分步长）",
    "- isCorrect: 是否满分全对（true/false）",
    "- reason: 简短精准的批改评语/扣分原因（如 \"涂选 C，正确\" 或 \"涂选 B（应为 C）\"）",
    "- markPos: `{ x, y }` 坐标（0–1000 整数）",
    "",
    "必须返回的 json 格式示例：",
    JSON.stringify({
      detectedStudent: { examNo: "0413", name: "雅俊宇", department: "管理部" },
      totalScore: 94,
      totalScorePos: { x: 505, y: 98 },
      teacherComment: "总体完成度高，主观题阐述清晰，选择题第 5 题有误。",
      items: [
        {
          no: "1",
          pageNo: 1,
          studentAnswer: "C",
          full: 6,
          got: 6,
          isCorrect: true,
          reason: "涂选 C，正确",
          markPos: { x: 145, y: 318 },
        },
        {
          no: "5",
          pageNo: 1,
          studentAnswer: "B",
          full: 6,
          got: 0,
          isCorrect: false,
          reason: "涂选 B（应为 C）",
          markPos: { x: 270, y: 344 },
        },
        {
          no: "11",
          pageNo: 1,
          studentAnswer: "VFS 是虚拟文件系统，是一套类似抽象层的子系统",
          full: 20,
          got: 20,
          isCorrect: true,
          reason: "准确说明 VFS 为抽象层，符合「意思对即可」标准",
          markPos: { x: 225, y: 530 },
        },
      ],
    }, null, 2),
  ].join("\n");
}

function clamp01Margin(v, def = 0.5, min = 0.04, max = 0.96) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.round(Math.max(min, Math.min(max, n)) * 1000) / 1000;
}

function normCoord01(v, def = 0.5, min = 0.04, max = 0.96) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  const scaled = n > 1.5 ? n / 1000 : n;
  return clamp01Margin(scaled, def, min, max);
}

function isObjectiveItem(it) {
  const qt = String(it?.qtype || "").trim();
  if (qt === "choice" || qt === "multi_choice" || qt === "judge" || qt === "listening") return true;
  if (qt === "essay" || qt === "blank") return false;
  const sec = String(it?.section || "");
  if (/(选择|单选|多选|判断|听力)/.test(sec)) return true;
  if (/(主观|简答|论述|计算|填空|代码|编程|大题)/.test(sec)) return false;
  const ans = String(it?.answer || "").trim();
  return Number(it?.full || 0) <= 10 && ans.length > 0 && ans.length <= 6 && /^[A-Za-z对错TF✓✗\s,;、]+$/i.test(ans);
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

  // 真实卷面红笔批改样式：
  // 1) 全对题（含选择题与主观题）仅画一枚简洁红色 ✓（不附加长串文字）；
  // 2) 错题/扣分题画红色 ✗ 并仅附简短扣分数（如 -6）；
  // 3) 首页顶部空白处标注简洁红色总分（size: "lg"）。
  const annotationsByPageNo = new Map();
  const pageFallbacks = new Map();
  const placedPoints = new Map();
  for (let i = 0; i < pageCount; i++) {
    pageFallbacks.set(i + 1, 0);
    placedPoints.set(i + 1, []);
  }

  for (const it of items) {
    const pNo = it.pageNo || 1;
    if (!annotationsByPageNo.has(pNo)) annotationsByPageNo.set(pNo, []);
    if (!placedPoints.has(pNo)) placedPoints.set(pNo, []);
    const arr = annotationsByPageNo.get(pNo);
    const pts = placedPoints.get(pNo);
    if (arr.length >= 90) continue;

    const isObj = isObjectiveItem(it);
    const markSize = isObj ? "sm" : "md";

    let x, y;
    if (it.markPos && (it.markPos.x !== undefined || it.markPos.y !== undefined)) {
      x = normCoord01(it.markPos.x, 0.5, 0.05, 0.92);
      y = normCoord01(it.markPos.y, 0.4, 0.06, 0.94);
    } else {
      const idxOnPage = pageFallbacks.get(pNo) || 0;
      pageFallbacks.set(pNo, idxOnPage + 1);
      if (isObj) {
        const col = idxOnPage % 4;
        const row = Math.floor(idxOnPage / 4);
        x = clamp01Margin(0.14 + col * 0.14, 0.14);
        y = clamp01Margin(0.32 + (row % 6) * 0.036, 0.32);
      } else {
        x = 0.24;
        y = clamp01Margin(0.52 + (idxOnPage % 6) * 0.16, 0.52);
      }
    }

    // 轻微避让完全重叠的相邻坐标，保持标注可读性
    for (let step = 0; step < 4; step++) {
      const clash = pts.some((pt) => Math.hypot(pt.x - x, pt.y - y) < 0.024);
      if (!clash) break;
      x = clamp01Margin(x + 0.026, x, 0.05, 0.92);
    }
    pts.push({ x, y });

    arr.push({
      type: it.wrong ? "cross" : "check",
      x,
      y,
      color: "#e11d48",
      size: markSize,
    });

    if (it.wrong) {
      const deduct = round1(Math.max(0.5, it.full - it.got));
      arr.push({
        type: "text",
        x: clamp01Margin(x + 0.032, x, 0.05, 0.94),
        y: clamp01Margin(y - 0.016, y, 0.05, 0.95),
        text: `-${deduct}`,
        color: "#e11d48",
        size: "sm",
      });
    }
  }

  const firstPageNo = pagesMeta[0]?.pageNo || 1;
  if (!annotationsByPageNo.has(firstPageNo)) annotationsByPageNo.set(firstPageNo, []);
  const totPos = obj.totalScorePos && typeof obj.totalScorePos === "object" ? obj.totalScorePos : null;
  const totX = totPos ? normCoord01(totPos.x, 0.50, 0.08, 0.92) : 0.50;
  const totY = totPos ? normCoord01(totPos.y, 0.10, 0.04, 0.25) : 0.10;
  annotationsByPageNo.get(firstPageNo).unshift({
    type: "text",
    x: totX,
    y: totY,
    text: String(score),
    color: "#e11d48",
    size: "lg",
  });

  const cleanItems = items.map(({ pageNo: _p, markPos: _m, ...rest }) => rest);
  const rawDet = obj.detectedStudent && typeof obj.detectedStudent === "object" ? obj.detectedStudent : {};
  const mappedNo = String(rawDet.examNo || "").trim()
    .replace(/[Oo]/g, "0")
    .replace(/[Il|]/g, "1")
    .replace(/[Zz]/g, "2")
    .replace(/[Ss]/g, "5")
    .replace(/[B]/g, "8");
  const detNoM = /\d{4}/.exec(mappedNo);
  const detectedStudent = {
    examNo: detNoM ? detNoM[0] : "",
    name: String(rawDet.name || "").trim().slice(0, 32),
    department: String(rawDet.department || "").trim().slice(0, 40),
  };

  return {
    score,
    fullScore: fullScoreLimit,
    teacherComment,
    items: cleanItems,
    annotationsByPageNo,
    model,
    wrongCount: cleanItems.filter((it) => it.wrong).length,
    detectedStudent,
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
            text: `请批改这 ${pages.length} 页考生答题卡/答卷。\n\n【题目清单与参考答案】\n${tplText}\n\n请按 json 格式返回总分、totalScorePos、评语及每道小题的识别作答、得分、扣分原因与整图 0–1000 相对坐标。`,
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
