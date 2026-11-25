// 试卷文档解析引擎：支持 PDF (unpdf)、Word (.docx via mammoth)、TXT / Markdown
// 基于中文试卷有限状态机：自动提取元数据、各大题题型与分值、小题及小问、跳过答题卡、匹配参考答案与双向细目表知识点
import { getDocumentProxy } from "unpdf";
import mammoth from "mammoth";

export const MAX_DOC_BYTES = 12 * 1024 * 1024; // 12 MB
const MAX_PDF_PAGES = 80;
const MAX_TEXT_CHARS = 300_000;

const DASH_RE = /[\u2010-\u2015\u2212\-~～]/;

// CJK 部首补充区常见字符 -> 标准简体汉字（防止部分 PDF 字体子集用部首码位编码）
const RADICAL_SUPPLEMENT_MAP = new Map([
  ["\u2e81", "厂"], ["\u2e9f", "母"], ["\u2ea0", "民"], ["\u2ea7", "牛"],
  ["\u2eab", "目"], ["\u2eac", "示"], ["\u2eae", "竹"], ["\u2eb3", "网"],
  ["\u2eb4", "网"], ["\u2eb6", "羊"], ["\u2eb9", "老"], ["\u2ebc", "肉"],
  ["\u2ec1", "虎"], ["\u2ec3", "西"], ["\u2ec4", "西"], ["\u2ec6", "角"],
  ["\u2ec9", "贝"], ["\u2eca", "足"], ["\u2ed7", "雨"], ["\u2ed8", "青"],
  ["\u2eda", "页"], ["\u2edb", "风"], ["\u2edc", "飞"], ["\u2edd", "食"],
  ["\u2ee1", "首"], ["\u2ee2", "马"], ["\u2ee3", "骨"], ["\u2ee4", "鬼"],
  ["\u2ee5", "鱼"], ["\u2ee6", "鸟"], ["\u2ee7", "卤"], ["\u2ee8", "麦"],
  ["\u2ee9", "黄"], ["\u2eeb", "齐"], ["\u2eec", "齐"], ["\u2eed", "齿"],
  ["\u2eee", "齿"], ["\u2eef", "龙"], ["\u2ef0", "龙"], ["\u2ef2", "龟"],
  ["\u2ef3", "龟"], ["\u2f3e", "户"], ["\u6236", "户"],
]);

function normalizeCjkRadicals(text) {
  if (!text) return "";
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const cp = ch.charCodeAt(0);
    if (RADICAL_SUPPLEMENT_MAP.has(ch)) {
      out += RADICAL_SUPPLEMENT_MAP.get(ch);
    } else if (cp >= 0x2f00 && cp <= 0x2fd5) {
      // 仅对康熙部首码位做 NFKC，避免破坏正常中文全角标点
      const mapped = ch.normalize("NFKC");
      out += RADICAL_SUPPLEMENT_MAP.get(mapped) || mapped;
    } else {
      out += ch;
    }
  }
  return out;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function makeErr(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function inferFormat(filename, mimeType, buf) {
  const ext = (String(filename || "").toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || "";
  const mime = String(mimeType || "").toLowerCase();

  // 先检查旧版 OLE2 .doc 魔数
  const isOle2 = buf.length >= 8 && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0;
  if (ext === "doc" || mime === "application/msword" || isOle2) {
    throw makeErr("暂不支持旧版 .doc 二进制格式，请在 Word / WPS 中另存为 .docx 或导出为 PDF 后再上传", 400);
  }

  const isPdfMagic = buf.length >= 5 && buf.subarray(0, 5).toString("ascii") === "%PDF-";
  const isZipMagic = buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;

  if (ext === "pdf" || mime === "application/pdf") {
    if (!isPdfMagic) throw makeErr("PDF 文件头校验失败，请确认上传的是有效 PDF 文档", 400);
    return "pdf";
  }
  if (ext === "docx" || mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    if (!isZipMagic) throw makeErr("Word (.docx) 文件格式校验失败，请确认文件未损坏", 400);
    return "docx";
  }
  if (ext === "txt" || ext === "md" || ext === "markdown" || mime === "text/plain" || mime === "text/markdown") {
    if (buf.includes(0)) throw makeErr("文本文档包含二进制内容，请上传 UTF-8 编码的 TXT / Markdown 文件", 400);
    return ext === "md" || ext === "markdown" || mime === "text/markdown" ? "md" : "txt";
  }

  if (isPdfMagic) return "pdf";
  if (isZipMagic) return "docx";
  throw makeErr("不支持的文档格式，请上传 PDF、Word (.docx)、TXT 或 Markdown (.md) 试卷文档", 400);
}

export function decodeDocUpload({ filename = "", mimeType = "", fileDataUrl = "" }) {
  const raw = String(fileDataUrl || "").trim();
  const m = /^data:([^;,]*);base64,([A-Za-z0-9+/=\s]+)$/.exec(raw);
  if (!m) throw makeErr("文档数据格式不正确，请重新选择文件上传", 400);
  const detectedMime = mimeType || m[1] || "";
  const buf = Buffer.from(m[2].replace(/\s+/g, ""), "base64");
  if (!buf.length || buf.length > MAX_DOC_BYTES) {
    throw makeErr("文档大小须在 1B – 12MB 之间", 400);
  }
  const format = inferFormat(filename, detectedMime, buf);
  return { filename: String(filename || "").slice(0, 180), mimeType: detectedMime, format, buffer: buf };
}

// 按 PDF.js 文本项坐标聚类还原阅读行，避免浮动图注与正文字段乱序
function reconstructPageLines(items) {
  const runs = [];
  for (const it of items) {
    if (!it || typeof it.str !== "string") continue;
    const text = normalizeCjkRadicals(it.str);
    if (!text) continue;
    const t = Array.isArray(it.transform) ? it.transform : [1, 0, 0, 10, 0, 0];
    const x = Number(t[4]) || 0;
    const y = Number(t[5]) || 0;
    const h = Math.abs(Number(t[3]) || Number(it.height) || 10) || 10;
    const w = Math.max(0, Number(it.width) || 0);
    if (!text.trim() && w <= 0) continue;
    runs.push({ x, y, h, w, str: text });
  }

  // 按 Y 降序（PDF 坐标原点在左下角）、再按 X 升序
  runs.sort((a, b) => (b.y - a.y) || (a.x - b.x));

  const lines = [];
  for (const r of runs) {
    let target = null;
    for (let i = lines.length - 1; i >= 0 && i >= lines.length - 8; i--) {
      const ln = lines[i];
      const tol = Math.max(2, Math.min(r.h, ln.h) * 0.25);
      if (Math.abs(r.y - ln.y) <= tol) {
        target = ln;
        break;
      }
      if (ln.y - r.y > 16) break;
    }
    if (!target) {
      lines.push({ y: r.y, h: r.h, items: [r] });
    } else {
      target.items.push(r);
      target.h = Math.max(target.h, r.h);
    }
  }

  lines.sort((a, b) => b.y - a.y);

  const outLines = [];
  for (const ln of lines) {
    ln.items.sort((a, b) => a.x - b.x);
    let str = "";
    let prev = null;
    for (const cur of ln.items) {
      const piece = cur.str;
      if (!prev) {
        str += piece;
      } else {
        const fontSize = Math.max(6, Math.min(prev.h, cur.h));
        const gap = cur.x - (prev.x + prev.w);
        if (piece.trim() === "") {
          if ((gap > fontSize * 1.8 || cur.w > fontSize * 1.5) && !str.endsWith("   ")) str += "   ";
          else if (!str.endsWith(" ")) str += " ";
        } else if (gap > fontSize * 1.8) {
          if (!str.endsWith("   ")) str = str.replace(/ +$/, "") + "   ";
          str += piece;
        } else if (gap > fontSize * 0.25) {
          if (!str.endsWith(" ") && !piece.startsWith(" ")) str += " ";
          str += piece;
        } else {
          str += piece;
        }
      }
      prev = cur;
    }
    const cleaned = str.replace(/\s+$/, "");
    if (cleaned.trim()) outLines.push(cleaned);
  }
  return outLines.join("\n");
}

export async function extractDocumentText({ filename = "", mimeType = "", format = "", buffer }) {
  const fmt = format || inferFormat(filename, mimeType, buffer);

  if (fmt === "pdf") {
    let pdf;
    try {
      pdf = await getDocumentProxy(new Uint8Array(buffer));
      const totalPages = Number(pdf.numPages) || 0;
      const limit = Math.min(totalPages, MAX_PDF_PAGES);
      const pages = [];
      let totalNonWs = 0;
      for (let i = 1; i <= limit; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        const pageText = reconstructPageLines(content?.items || []);
        pages.push(pageText);
        totalNonWs += pageText.replace(/\s+/g, "").length;
      }
      if (totalNonWs < 20) {
        throw makeErr(
          "该 PDF 未检测到可选文字层（可能是纯图片扫描件），请导出带文字层的 PDF / Word(.docx)，或在「成绩录入与拍图扫卷」中直接拍图扫描",
          422,
        );
      }
      return { format: "pdf", pageCount: totalPages, pages };
    } catch (e) {
      if (e?.status) throw e;
      throw makeErr(`PDF 解析失败：${e?.message || "文件可能已加密或损坏"}`, 400);
    } finally {
      try { await pdf?.destroy?.(); } catch { /* ignore */ }
      try { await pdf?.cleanup?.(); } catch { /* ignore */ }
    }
  }

  if (fmt === "docx") {
    try {
      const res = await mammoth.extractRawText({ buffer });
      const text = normalizeCjkRadicals(String(res?.value || ""));
      if (text.replace(/\s+/g, "").length < 10) {
        throw makeErr("Word (.docx) 文档未提取到有效文字内容", 422);
      }
      return { format: "docx", pageCount: 1, pages: [text] };
    } catch (e) {
      if (e?.status) throw e;
      throw makeErr(`Word (.docx) 解析失败：${e?.message || "文件可能已损坏"}`, 400);
    }
  }

  const text = normalizeCjkRadicals(buffer.toString("utf8").replace(/^\uFEFF/, ""));
  if (text.replace(/\s+/g, "").length < 10) {
    throw makeErr("文本文档内容为空或过短", 422);
  }
  return { format: fmt, pageCount: 1, pages: [text] };
}

// ---------- 中文试卷有限状态机解析器 ----------

const FOOTER_RES = [
  /^.*第\s*\d+\s*页\s*[（(]\s*共\s*\d+\s*页\s*[）)]\s*$/,
  /^\s*[—\-–‒·]*\s*第?\s*\d+\s*页?\s*[—\-–‒·]*\s*$/,
  /^\s*[（(]\s*(?:试\s*题\s*卷?|试\s*卷|本\s*卷)\s*完\s*[）)]\s*$/,
  /^\s*请在各题目的答题区域内作答.*$/,
  /^\s*密\s*封\s*线\s*内.*$/,
];

const ANSWER_SHEET_RE = /^答\s*题\s*[卡纸卷](?:\s*[（(][^）)]{0,12}[）)])?$/;
const ANSWERS_ZONE_RE = /^(?:参考答案及评分标准|参考答案|标准答案|答案及评分标准|答案与解析|答案解析|评分标准|试题答案)(?:\s*[（(][^）)]{0,18}[）)])?$/;
const SPEC_TABLE_RE = /^(?:双向细目表|命题细目表|考点分布表|知识点?分布表|试卷结构表)$/;
const NOTES_ZONE_RE = /^(?:命题说明|命题意图|审题说明|试卷说明)$/;
const MAJOR_SEC_RE = /^(?:([一二三四五六七八九十]+)\s*[、.．]|第([一二三四五六七八九十]+)[部大]分[：:、.\s]*)\s*(.+)$/;
const CONTINUATION_RE = /[（(]\s*续\s*[）)]/;
const FIG_CAPTION_RE = /^图\s*\d+\s+.+/;

function isFooterLine(t) {
  return FOOTER_RES.some((re) => re.test(t));
}

function cleanPageLines(rawPage) {
  const normalized = normalizeCjkRadicals(String(rawPage || ""))
    .replace(/\r\n?/g, "\n")
    .replace(/[\u00a0\u3000]/g, " ");
  const out = [];
  for (const rawLine of normalized.split("\n")) {
    const t = rawLine.trim();
    if (!t) continue;
    if (isFooterLine(t)) continue;
    out.push(rawLine.replace(/\s+$/, ""));
  }
  return out;
}

function collapseJustifiedCjkSpaces(text) {
  return String(text || "")
    .replace(/([\u4e00-\u9fff])\s+([\u4e00-\u9fff])/g, "$1$2")
    .replace(/([\u4e00-\u9fff])\s+([\u4e00-\u9fff])/g, "$1$2")
    .replace(/([\u4e00-\u9fff])\s+([，。；：！？、）】》])/g, "$1$2")
    .replace(/([（【《])\s+([\u4e00-\u9fff])/g, "$1$2")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function classifySectionType(rawName) {
  const name = String(rawName || "").trim();
  if (/多[项选]|不定项/.test(name)) return { qtype: "multi_choice", label: name || "多选题" };
  if (/单[项选]|选择/.test(name)) return { qtype: "choice", label: name || "选择题" };
  if (/判断|是非|辨析/.test(name)) return { qtype: "judge", label: name || "判断题" };
  if (/填空|补全/.test(name)) return { qtype: "blank", label: name || "填空题" };
  if (/大题|简答|问答|计算|解答|应用|实验|编程|代码|设计|综合|论述|材料|案例|分析|阅读|写作|作文|证明|探究/.test(name)) {
    return { qtype: "essay", label: name || "大题" };
  }
  return { qtype: "other", label: name || "综合题" };
}

function parseSectionHeader(fullHeaderText) {
  const m = MAJOR_SEC_RE.exec(fullHeaderText.trim());
  if (!m) return null;
  const cnNum = m[1] || m[2] || "";
  const rest = (m[3] || "").trim();
  const isContinuation = CONTINUATION_RE.test(rest);

  const parenIdx = rest.search(/[（(]/);
  const rawName = (parenIdx >= 0 ? rest.slice(0, parenIdx) : rest)
    .replace(/[：:。，,\s]+$/, "")
    .trim();
  const metaText = parenIdx >= 0 ? rest.slice(parenIdx) : "";

  const countM = /共\s*(\d+)\s*(?:小?题|空|道)/.exec(metaText);
  const eachM = /每(?:小?题|空|道)\s*(\d+(?:\.\d+)?)\s*分/.exec(metaText);
  const totalM = /共\s*(\d+(?:\.\d+)?)\s*分/.exec(metaText);

  const count = countM ? Number(countM[1]) : null;
  let scoreEach = eachM ? Number(eachM[1]) : null;
  let totalScore = totalM ? Number(totalM[1]) : null;
  if (!scoreEach && count && totalScore) scoreEach = round1(totalScore / count);
  if (!totalScore && count && scoreEach) totalScore = round1(count * scoreEach);

  const cls = classifySectionType(rawName);
  return {
    cnNum,
    name: cls.label.slice(0, 24),
    qtype: cls.qtype,
    isContinuation,
    count,
    scoreEach,
    totalScore,
  };
}

function hasUnclosedParen(text) {
  const opens = (text.match(/[（(]/g) || []).length;
  const closes = (text.match(/[）)]/g) || []).length;
  return opens > closes;
}

function stripFigureLines(lines) {
  const out = [];
  let skipNextUnclosed = false;
  for (const ln of lines) {
    const t = ln.trim();
    if (skipNextUnclosed) {
      skipNextUnclosed = hasUnclosedParen(t) && !/[）)]/.test(t);
      continue;
    }
    if (FIG_CAPTION_RE.test(t)) {
      skipNextUnclosed = hasUnclosedParen(t);
      continue;
    }
    out.push(ln);
  }
  return out;
}

function extractHeaderMetadata(headerLines, notesLines, filename) {
  const joinedHeader = headerLines.map((l) => l.trim()).join("\n");

  const titleParts = [];
  for (const raw of headerLines) {
    const t = raw.trim();
    if (!t) continue;
    if (/^[（(]?\s*满分/.test(t)) break;
    if (/^(?:注意事项|考生须知|温馨提示|答题须知)/.test(t)) break;
    if (/^(?:学校|班级|姓名|考号|准考证号|部门|工号)\s*[：:]/.test(t)) break;
    if (/^[一二三四五六七八九十\s]+总分$/.test(t) || /^(?:一|二|三|总分)$/.test(t)) break;
    if (/^第\s*[ⅠⅡI12]+\s*卷/.test(t)) break;
    if (FIG_CAPTION_RE.test(t)) continue;
    if (titleParts.length < 2) titleParts.push(t);
  }

  let title = titleParts.join("").replace(/\s+/g, " ").trim();
  title = title.replace(/\u2012/g, "–");
  if (!title && filename) {
    title = String(filename).replace(/\.[^.]+$/, "").trim();
  }
  title = title.slice(0, 100);

  let term = "";
  const termM1 = /(\d{4}\s*[–—‒\-~]\s*\d{4}\s*学年度?(?:第[一二]学期|[七八九高初]?[一二三四五六七八九]?年级?[上下]学期|[上下]学期)?)/.exec(joinedHeader);
  const termM2 = /(\d{4}\s*年?(?:春|夏|秋|冬)季[^\s，,。（(]{0,6}|\d{4}\s*Q[1-4][^\s，,。（(]{0,6}|\d{4}\s*年第[一二三四]季度)/.exec(joinedHeader);
  if (termM1) term = termM1[1].replace(/\s+/g, "").replace(/\u2012/g, "–").slice(0, 40);
  else if (termM2) term = termM2[1].replace(/\s+/g, "").slice(0, 40);

  const fullM = /满分\s*[:：]?\s*(\d+(?:\.\d+)?)\s*分/.exec(joinedHeader);
  const durM = /(?:考试时间|答卷时间|时量|用时)\s*[:：]?\s*(\d+)\s*分钟/.exec(joinedHeader);
  const modeM = /(开卷|闭卷|上机|笔试)/.exec(joinedHeader);
  const fullScore = fullM ? Number(fullM[1]) : null;
  const duration = durM ? Number(durM[1]) : null;
  const mode = modeM ? modeM[1] : "";

  let subjectName = "";
  const lastTitleLine = (titleParts[titleParts.length - 1] || title || "").trim();
  const cleanSub = lastTitleLine
    .replace(/^.*?(?:学年度?(?:[七八九高初]?[一二三四五六七八九]?年级?)?[上下]学期|第[一二]学期)/, "")
    .replace(/(?:期末|期中|月考|单元|模拟|综合|专项|随堂|内部|阶段性?)?(?:检测|测试|考试|试卷|试题|考核|测评|评估|调研|联考|竞赛|卷)+$/, "")
    .trim();
  if (cleanSub && cleanSub.length >= 2 && cleanSub.length <= 24) {
    subjectName = cleanSub;
  } else {
    subjectName = "综合试卷";
  }

  const descParts = [];
  if (fullScore) descParts.push(`满分 ${fullScore} 分`);
  if (duration) descParts.push(`考试时间 ${duration} 分钟`);
  if (mode) descParts.push(mode);
  if (notesLines.length) {
    const noteText = collapseJustifiedCjkSpaces(notesLines.join(""));
    if (noteText) descParts.push(noteText);
  }
  const description = descParts.join(" · ").slice(0, 480);

  return { title, term, subjectName, fullScore, duration, mode, description };
}

function cleanChoiceQuestion(rawLines) {
  const filtered = stripFigureLines(rawLines);
  const joined = filtered.join("\n");
  const optStart = joined.search(/(?:^|\n|\s{2,})A\s*[.．、]\s*/);
  const stemRaw = optStart >= 0 ? joined.slice(0, optStart) : joined;
  const stemNoFig = stemRaw.replace(/\s{2,}图\s*\d+\s+.*$/gm, "");
  const title = collapseJustifiedCjkSpaces(stemNoFig.replace(/\n+/g, " ")).slice(0, 240);
  return { title, subQuestions: [] };
}

function cleanBlankQuestion(rawLines) {
  const filtered = stripFigureLines(rawLines);
  const parts = [];
  for (let i = 0; i < filtered.length; i++) {
    let ln = filtered[i].trim();
    if (!ln) continue;
    ln = ln.replace(/[ \t]{3,}/g, " ____ ");
    if (!parts.length) {
      parts.push(ln);
    } else {
      const prev = parts[parts.length - 1];
      const endsWithPunct = /[。？！；：，、）)】》]$/.test(prev);
      const alreadyHasBlank = /_{2,}/.test(prev) || /_{2,}/.test(ln);
      if (!endsWithPunct && !alreadyHasBlank && prev.length <= 24) {
        parts[parts.length - 1] = `${prev} ____ ${ln}`;
      } else {
        parts[parts.length - 1] = `${prev}${ln}`;
      }
    }
  }
  const title = collapseJustifiedCjkSpaces(parts.join(" ")).replace(/\s*_{2,}\s*/g, " ____ ").trim().slice(0, 240);
  return { title, subQuestions: [] };
}

function parseSubQuestions(qNo, rawLines, defaultTag) {
  const filtered = stripFigureLines(rawLines);
  const fullText = filtered.join("\n");

  const subRe = /(?:^|\n)\s*[（(](\d{1,2})[）)]\s*/g;
  const matches = [];
  let m;
  while ((m = subRe.exec(fullText)) !== null) {
    matches.push({ idx: m.index, end: m.index + m[0].length, subNo: m[1] });
  }

  const validMatches = [];
  let expect = 1;
  for (const hit of matches) {
    const n = Number(hit.subNo);
    if (n === expect) {
      validMatches.push(hit);
      expect++;
    }
  }

  let leadText = fullText;
  const subQuestions = [];
  if (validMatches.length >= 1) {
    leadText = fullText.slice(0, validMatches[0].idx).trim();
    for (let i = 0; i < validMatches.length; i++) {
      const start = validMatches[i].end;
      const end = i + 1 < validMatches.length ? validMatches[i + 1].idx : fullText.length;
      const bodyRaw = fullText.slice(start, end).trim();
      const scoreAll = [...bodyRaw.matchAll(/[（(]\s*(\d+(?:\.\d+)?)\s*分\s*[）)]/g)];
      const subFull = scoreAll.length ? Number(scoreAll[scoreAll.length - 1][1]) : null;
      const subTitle = collapseJustifiedCjkSpaces(bodyRaw.replace(/\n+/g, "")).slice(0, 240);
      subQuestions.push({
        no: `${qNo}(${validMatches[i].subNo})`,
        subNo: validMatches[i].subNo,
        title: subTitle,
        tag: defaultTag,
        full: subFull,
        answer: "",
      });
    }
  }

  const leadNonCode = leadText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^(?:#include|int\s+|void\s+|while\s*\(|for\s*\(|if\s*\(|return\b|[{}]|\w+\s*=\s*[^;]+;|\w+\([^)]*\);)/.test(l));
  let title = collapseJustifiedCjkSpaces(leadNonCode.join(" "));
  if (!title && subQuestions.length) {
    title = subQuestions[0].title;
  } else if (title.length < 24 && subQuestions.length) {
    title = `${title} ${subQuestions[0].title}`;
  }
  title = title.slice(0, 240);

  return { title, subQuestions };
}

function parseInlineChoiceAnswers(text, answerMap, knownNos) {
  let matched = 0;
  const rangeRe = new RegExp(`(\\d{1,3})\\s*${DASH_RE.source}\\s*(\\d{1,3})\\s*[.．、:：\\s]+([A-F√×TF对错]{2,20})(?=\\s|$|[,，;；])`, "gi");
  let m;
  while ((m = rangeRe.exec(text)) !== null) {
    const start = Number(m[1]);
    const end = Number(m[2]);
    const letters = m[3].toUpperCase();
    if (end >= start && end - start + 1 === letters.length) {
      for (let i = 0; i < letters.length; i++) {
        const key = String(start + i);
        if (!knownNos.size || knownNos.has(key)) {
          answerMap.set(key, letters[i]);
          matched++;
        }
      }
    }
  }
  const pairRe = /(?:^|[\s,，;；])(\d{1,3})\s*[.．、:：]\s*([A-F]{1,6}|[√×✓✗对错TF])(?=\s|$|[,，;；]|(?=\d{1,3}\s*[.．、:：]))/gi;
  while ((m = pairRe.exec(text)) !== null) {
    const key = String(Number(m[1]));
    if (!knownNos.size || knownNos.has(key)) {
      answerMap.set(key, m[2].toUpperCase());
      matched++;
    }
  }
  return matched;
}

function parseNumberedAnswersByKnown(text, answerMap, knownNos, allowedSet) {
  const markerRe = /(?:^|\s)(\d{1,3})\s*[.．、:：]\s*/g;
  const markers = [];
  let m;
  let lastNo = -1;
  while ((m = markerRe.exec(text)) !== null) {
    const n = Number(m[1]);
    const key = String(n);
    if (allowedSet && allowedSet.size && !allowedSet.has(key)) continue;
    if (knownNos.size && !knownNos.has(key)) continue;
    if (n <= lastNo) continue;
    markers.push({ key, start: m.index, valStart: m.index + m[0].length });
    lastNo = n;
  }
  for (let i = 0; i < markers.length; i++) {
    const end = i + 1 < markers.length ? markers[i + 1].start : text.length;
    let val = text.slice(markers[i].valStart, end).trim();
    val = val.replace(/^[（(]\s*\d+(?:\.\d+)?\s*分\s*[）)]\s*/, "");
    val = collapseJustifiedCjkSpaces(val.replace(/\n+/g, "")).slice(0, 1500);
    if (val) answerMap.set(markers[i].key, val);
  }
  return markers.length;
}

function splitSubAnswers(essayAns) {
  const map = new Map();
  const re = /[（(](\d{1,2})[）)]\s*/g;
  const hits = [];
  let m;
  let expect = 1;
  while ((m = re.exec(essayAns)) !== null) {
    const n = Number(m[1]);
    if (n === expect) {
      hits.push({ subNo: m[1], idx: m.index, end: m.index + m[0].length });
      expect++;
    }
  }
  for (let i = 0; i < hits.length; i++) {
    const end = i + 1 < hits.length ? hits[i + 1].idx : essayAns.length;
    const val = essayAns.slice(hits[i].end, end).trim();
    if (val) map.set(hits[i].subNo, val);
  }
  return map;
}

function parseAnswersZone(answerLines, questions) {
  const answerMap = new Map();
  const subAnswerMap = new Map();
  if (!answerLines.length) return { answerMap, subAnswerMap };

  const knownNos = new Set(questions.map((q) => q.no));
  const byType = new Map();
  for (const q of questions) {
    if (!byType.has(q.qtype)) byType.set(q.qtype, new Set());
    byType.get(q.qtype).add(q.no);
  }

  const blocks = [];
  let curBlock = { qtype: "mixed", lines: [] };
  for (const rawLine of answerLines) {
    const t = rawLine.trim();
    if (!t) continue;
    const sec = parseSectionHeader(t);
    if (sec) {
      if (sec.isContinuation) continue;
      if (curBlock.lines.length) blocks.push(curBlock);
      curBlock = { qtype: sec.qtype, lines: [] };
      continue;
    }
    curBlock.lines.push(t);
  }
  if (curBlock.lines.length) blocks.push(curBlock);

  for (const blk of blocks) {
    const text = blk.lines.join("\n");
    if (blk.qtype === "choice" || blk.qtype === "multi_choice" || blk.qtype === "judge") {
      const hit = parseInlineChoiceAnswers(text, answerMap, knownNos);
      if (hit === 0) {
        parseNumberedAnswersByKnown(text, answerMap, knownNos, byType.get(blk.qtype));
      }
    } else if (blk.qtype === "essay") {
      const essayNos = byType.get("essay") || knownNos;
      const essayMarkers = [];
      let curNo = null;
      let buf = [];
      for (const ln of blk.lines) {
        const m = /^(\d{1,3})\s*[.．、:：]\s*(.*)$/.exec(ln);
        if (m && essayNos.has(String(Number(m[1])))) {
          if (curNo !== null) essayMarkers.push({ key: curNo, text: buf.join("\n") });
          curNo = String(Number(m[1]));
          buf = [m[2]];
        } else if (curNo !== null) {
          buf.push(ln);
        }
      }
      if (curNo !== null) essayMarkers.push({ key: curNo, text: buf.join("\n") });

      if (essayMarkers.length) {
        for (const em of essayMarkers) {
          const cleanVal = collapseJustifiedCjkSpaces(
            em.text.replace(/^[（(]\s*\d+(?:\.\d+)?\s*分\s*[）)]\s*/, "").replace(/\n+/g, ""),
          ).slice(0, 1500);
          if (cleanVal) {
            answerMap.set(em.key, cleanVal);
            const subs = splitSubAnswers(cleanVal);
            for (const [subNo, subVal] of subs.entries()) {
              subAnswerMap.set(`${em.key}(${subNo})`, subVal.slice(0, 1200));
            }
          }
        }
      } else {
        parseNumberedAnswersByKnown(text, answerMap, knownNos, essayNos);
      }
    } else if (blk.qtype === "blank") {
      parseNumberedAnswersByKnown(text.replace(/\n+/g, " "), answerMap, knownNos, byType.get("blank"));
    } else {
      parseInlineChoiceAnswers(text, answerMap, knownNos);
      const remaining = new Set([...knownNos].filter((k) => !answerMap.has(k)));
      if (remaining.size) {
        parseNumberedAnswersByKnown(text, answerMap, knownNos, remaining);
      }
    }
  }

  return { answerMap, subAnswerMap };
}

function parseSpecTable(specLines) {
  const questionTags = new Map();
  const subQuestionTags = new Map();
  const chapterOrder = [];
  const chapterCounts = new Map();

  if (!specLines.length) return { questionTags, subQuestionTags, chapters: [] };

  const REF_HINT_RE = /(?:选择题|单选题|多选题|判断题|填空题|大题|简答题|计算题|解答题|综合题|编程题|论述题|实验题|材料题|应用题)/;
  const HEADER_NOISE_RE = /^(?:章节|模块|知识点|单元|题号|题型|分值|占比|难度|合计|总计|\d+(?:\.\d+)?%?)$/;

  const addTag = (qNo, chapter) => {
    if (!questionTags.has(qNo)) questionTags.set(qNo, new Set());
    if (!questionTags.get(qNo).has(chapter)) {
      questionTags.get(qNo).add(chapter);
      chapterCounts.set(chapter, (chapterCounts.get(chapter) || 0) + 1);
    }
  };

  const applyRefs = (chapter, refText) => {
    const cleanChap = collapseJustifiedCjkSpaces(chapter).slice(0, 32);
    if (!cleanChap) return;
    if (!chapterOrder.includes(cleanChap)) chapterOrder.push(cleanChap);

    const trimmedRef = refText.replace(/\s+\d+(?:\.\d+)?\s*$/, "").trim();
    const segs = trimmedRef.split(/[；;]+/);
    for (const seg of segs) {
      let work = seg.trim();
      if (!work) continue;

      work = work.replace(/(\d{1,3})\s*((?:[（(]\s*\d{1,2}\s*[）)])+)/g, (_all, qNoStr, subGroup) => {
        const qNo = String(Number(qNoStr));
        addTag(qNo, cleanChap);
        for (const sm of subGroup.matchAll(/[（(]\s*(\d{1,2})\s*[）)]/g)) {
          subQuestionTags.set(`${qNo}(${Number(sm[1])})`, cleanChap);
        }
        return " ";
      });

      const rangeRe = new RegExp(`(\\d{1,3})\\s*${DASH_RE.source}\\s*(\\d{1,3})`, "g");
      work = work.replace(rangeRe, (_all, aStr, bStr) => {
        const a = Number(aStr);
        const b = Number(bStr);
        if (b >= a && b - a <= 200) {
          for (let n = a; n <= b; n++) addTag(String(n), cleanChap);
        }
        return " ";
      });

      for (const nm of work.matchAll(/\d{1,3}/g)) {
        addTag(String(Number(nm[0])), cleanChap);
      }
    }
  };

  let pendingChapter = "";
  for (const rawLine of specLines) {
    const t = rawLine.trim();
    if (!t || HEADER_NOISE_RE.test(t)) continue;
    if (/^(?:章节\s+题号|模块\s+题号|合计\b|总计\b)/.test(t)) continue;

    const hintMatch = REF_HINT_RE.exec(t);
    if (hintMatch) {
      const before = t.slice(0, hintMatch.index).trim();
      const refPart = t.slice(hintMatch.index).trim();
      if (before.length >= 2) {
        pendingChapter = before;
        applyRefs(before, refPart);
      } else if (pendingChapter) {
        applyRefs(pendingChapter, refPart);
      }
    } else if (/\d+\s*[\u2010-\u2015\u2212\-~～]\s*\d+/.test(t) && pendingChapter) {
      applyRefs(pendingChapter, t);
    } else if (!/^\d+(?:\.\d+)?$/.test(t)) {
      pendingChapter = t;
    }
  }

  const chapters = chapterOrder.map((ch) => ({
    chapter: ch,
    questionCount: chapterCounts.get(ch) || 0,
  }));

  return { questionTags, subQuestionTags, chapters };
}

export function parseExamText(pagesOrText, filename = "") {
  const rawPages = Array.isArray(pagesOrText) ? pagesOrText : [String(pagesOrText || "")];
  let totalChars = 0;
  const pageLinesList = [];
  for (const p of rawPages) {
    if (totalChars >= MAX_TEXT_CHARS) break;
    const slice = String(p || "").slice(0, MAX_TEXT_CHARS - totalChars);
    totalChars += slice.length;
    pageLinesList.push(cleanPageLines(slice));
  }

  let zone = "HEADER";
  const headerLines = [];
  const questionStream = [];
  const answerLines = [];
  const specLines = [];
  const notesLines = [];
  let skippedAnswerSheet = false;

  for (const lines of pageLinesList) {
    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i];
      const t = rawLine.trim();
      if (!t) continue;

      if (SPEC_TABLE_RE.test(t)) {
        zone = "SPEC_TABLE";
        continue;
      }
      if (NOTES_ZONE_RE.test(t)) {
        zone = "NOTES";
        continue;
      }
      if (ANSWERS_ZONE_RE.test(t)) {
        zone = "ANSWERS";
        continue;
      }
      if (ANSWER_SHEET_RE.test(t) && t.length <= 16 && !/[。，,]/.test(t)) {
        zone = "ANSWER_SHEET";
        skippedAnswerSheet = true;
        continue;
      }

      if (zone === "ANSWER_SHEET") continue;
      if (zone === "SPEC_TABLE") { specLines.push(rawLine); continue; }
      if (zone === "NOTES") { notesLines.push(rawLine); continue; }
      if (zone === "ANSWERS") { answerLines.push(rawLine); continue; }

      if (MAJOR_SEC_RE.test(t)) {
        let merged = t;
        let extra = 0;
        while (hasUnclosedParen(merged) && extra < 2 && i + 1 < lines.length) {
          const nxt = lines[i + 1].trim();
          if (!nxt || /^\d+\s*[.．、]/.test(nxt) || MAJOR_SEC_RE.test(nxt)) break;
          merged += nxt;
          i++;
          extra++;
        }
        const parsedSec = parseSectionHeader(merged);
        if (parsedSec) {
          zone = "QUESTIONS";
          questionStream.push({ kind: "section", data: parsedSec });
          continue;
        }
      }

      if (zone === "HEADER") {
        headerLines.push(rawLine);
      } else if (zone === "QUESTIONS") {
        questionStream.push({ kind: "line", text: rawLine });
      }
    }
  }

  const hasAnySection = questionStream.some((x) => x.kind === "section");
  if (!hasAnySection && headerLines.length) {
    const keptHeader = [];
    let inNotice = false;
    let startedQ = false;
    for (const rawLine of headerLines) {
      const t = rawLine.trim();
      if (/^(?:注意事项|考生须知)/.test(t)) { inNotice = true; keptHeader.push(rawLine); continue; }
      if (!startedQ && /^\s*1\s*[.．、]\s*/.test(t) && !inNotice) {
        startedQ = true;
        questionStream.push({
          kind: "section",
          data: { cnNum: "一", name: "综合题", qtype: "other", isContinuation: false, count: null, scoreEach: null, totalScore: null },
        });
      }
      if (startedQ) questionStream.push({ kind: "line", text: rawLine });
      else keptHeader.push(rawLine);
    }
    if (startedQ) {
      headerLines.length = 0;
      headerLines.push(...keptHeader);
    }
  }

  const sections = [];
  let curSec = null;
  let curQ = null;
  let lastGlobalNo = 0;

  const flushQuestion = () => {
    if (!curQ || !curSec) return;
    curSec.rawQuestions.push(curQ);
    curQ = null;
  };

  for (const item of questionStream) {
    if (item.kind === "section") {
      if (item.data.isContinuation && curSec) continue;
      flushQuestion();
      curSec = {
        index: sections.length + 1,
        name: item.data.name,
        qtype: item.data.qtype,
        count: item.data.count,
        scoreEach: item.data.scoreEach,
        totalScore: item.data.totalScore,
        rawQuestions: [],
      };
      sections.push(curSec);
      continue;
    }

    if (!curSec) continue;
    const rawLine = item.text;
    const t = rawLine.trim();
    const qm = /^(\d{1,3})\s*[.．、]\s*(.*)$/.exec(t);
    if (qm) {
      const n = Number(qm[1]);
      const secEmpty = curSec.rawQuestions.length === 0 && !curQ;
      const isSeqNext = n === lastGlobalNo + 1;
      const isRestartAt1 = secEmpty && n === 1;
      const isNearAdvance = n > lastGlobalNo && n <= lastGlobalNo + 3;

      if (isSeqNext || isRestartAt1 || isNearAdvance) {
        flushQuestion();
        lastGlobalNo = n;
        curQ = {
          no: String(n),
          section: curSec.name,
          qtype: curSec.qtype,
          lines: qm[2] ? [qm[2]] : [],
        };
        continue;
      }
    }

    if (curQ) {
      curQ.lines.push(rawLine);
    }
  }
  flushQuestion();

  const questions = [];
  const usedNos = new Set();

  for (const sec of sections) {
    const qCount = sec.rawQuestions.length;
    const fallbackEach = sec.scoreEach
      || (sec.totalScore && qCount ? round1(sec.totalScore / qCount) : 2);

    for (const rq of sec.rawQuestions) {
      let finalNo = rq.no;
      if (usedNos.has(finalNo)) {
        finalNo = `${sec.index}-${rq.no}`;
      }
      usedNos.add(finalNo);

      let parsedBody;
      if (sec.qtype === "choice" || sec.qtype === "multi_choice") {
        parsedBody = cleanChoiceQuestion(rq.lines);
      } else if (sec.qtype === "blank") {
        parsedBody = cleanBlankQuestion(rq.lines);
      } else if (sec.qtype === "essay" || sec.qtype === "other") {
        parsedBody = parseSubQuestions(finalNo, rq.lines, sec.name);
      } else {
        const filtered = stripFigureLines(rq.lines);
        parsedBody = {
          title: collapseJustifiedCjkSpaces(filtered.join(" ")).slice(0, 240),
          subQuestions: [],
        };
      }

      const firstLine = (rq.lines[0] || "").trim();
      const headScoreM = /^[（(]\s*(\d+(?:\.\d+)?)\s*分\s*[）)]/.exec(firstLine);
      let qFull = headScoreM ? Number(headScoreM[1]) : null;
      const subHasAllScores = parsedBody.subQuestions.length > 0
        && parsedBody.subQuestions.every((sq) => Number.isFinite(sq.full) && sq.full > 0);
      if (!qFull && subHasAllScores) {
        qFull = round1(parsedBody.subQuestions.reduce((s, x) => s + x.full, 0));
      }
      if (!qFull) qFull = fallbackEach;

      if (parsedBody.subQuestions.length) {
        const missing = parsedBody.subQuestions.filter((sq) => !sq.full);
        if (missing.length) {
          const usedSum = parsedBody.subQuestions.reduce((s, x) => s + (x.full || 0), 0);
          const rem = Math.max(missing.length, qFull - usedSum);
          const eachSub = round1(rem / missing.length);
          for (const sq of missing) sq.full = eachSub;
        }
      }

      questions.push({
        no: finalNo,
        rawNo: rq.no,
        section: sec.name,
        qtype: sec.qtype,
        title: parsedBody.title || `第 ${finalNo} 题`,
        tag: sec.name || "综合能力",
        full: round1(qFull),
        answer: "",
        subQuestions: parsedBody.subQuestions,
      });
    }
  }

  const { answerMap, subAnswerMap } = parseAnswersZone(answerLines, questions);
  for (const q of questions) {
    const hit = answerMap.get(q.no) || answerMap.get(q.rawNo);
    if (hit) q.answer = hit;
    for (const sq of q.subQuestions) {
      const subHit = subAnswerMap.get(sq.no) || subAnswerMap.get(`${q.rawNo}(${sq.subNo})`);
      if (subHit) sq.answer = subHit;
    }
  }

  const spec = parseSpecTable(specLines);
  let taggedFromSpec = 0;
  for (const q of questions) {
    const chapSet = spec.questionTags.get(q.no) || spec.questionTags.get(q.rawNo);
    if (chapSet && chapSet.size) {
      q.tag = [...chapSet].join("/").slice(0, 32);
      taggedFromSpec++;
    }
    for (const sq of q.subQuestions) {
      const sqTag = spec.subQuestionTags.get(sq.no)
        || spec.subQuestionTags.get(`${q.rawNo}(${sq.subNo})`)
        || (chapSet && chapSet.size ? [...chapSet][0] : q.tag);
      sq.tag = String(sqTag || q.section || "综合能力").slice(0, 32);
    }
  }

  const meta = extractHeaderMetadata(headerLines, notesLines, filename);
  const calculatedFullScore = round1(questions.reduce((s, q) => s + q.full, 0));
  const finalFullScore = meta.fullScore || calculatedFullScore || 100;

  const sectionsOut = sections.map((sec) => {
    const qs = questions.filter((q) => q.section === sec.name);
    const total = round1(qs.reduce((s, q) => s + q.full, 0)) || sec.totalScore || 0;
    const each = sec.scoreEach || (qs.length ? round1(total / qs.length) : 0);
    return {
      index: sec.index,
      name: sec.name,
      qtype: sec.qtype,
      declaredCount: sec.count,
      questionCount: qs.length,
      scoreEach: each,
      totalScore: total,
    };
  });

  const cleanQuestions = questions.map(({ rawNo: _rawNo, ...rest }) => rest);
  const totalSubQuestions = cleanQuestions.reduce(
    (s, q) => s + (q.subQuestions.length ? q.subQuestions.length : 1),
    0,
  );
  const answeredCount = cleanQuestions.filter((q) => q.answer && q.answer.trim()).length;

  return {
    filename: String(filename || ""),
    pageCount: rawPages.length,
    title: meta.title,
    term: meta.term,
    subjectName: meta.subjectName,
    fullScore: finalFullScore,
    duration: meta.duration,
    mode: meta.mode,
    description: meta.description,
    sections: sectionsOut,
    questions: cleanQuestions,
    specChapters: spec.chapters,
    stats: {
      totalQuestions: cleanQuestions.length,
      totalSubQuestions,
      calculatedFullScore,
      answeredCount,
      taggedCount: taggedFromSpec,
      skippedAnswerSheet,
      hasSpecTable: spec.chapters.length > 0,
    },
  };
}

export async function parseExamDocument({ filename = "", mimeType = "", fileDataUrl = "", text = "" }) {
  if (text && !fileDataUrl) {
    const clean = normalizeCjkRadicals(String(text));
    if (clean.replace(/\s+/g, "").length < 10) {
      throw makeErr("试卷文本内容过短，无法解析", 400);
    }
    const parsed = parseExamText([clean], filename || "试卷文本.txt");
    parsed.format = "txt";
    return parsed;
  }

  const decoded = decodeDocUpload({ filename, mimeType, fileDataUrl });
  const extracted = await extractDocumentText(decoded);
  const parsed = parseExamText(extracted.pages, decoded.filename);
  parsed.format = extracted.format;
  parsed.pageCount = extracted.pageCount;
  return parsed;
}
