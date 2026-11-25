// 员工内部考试系统（智考中心 /exam）：4 位考号、成绩与诊断报告、扫描试卷存储与批改、自动错题本、管理员考务与用户管理
import { Router } from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db, EXAM_UPLOAD_DIR } from "../db.js";
import * as A from "../auth.js";
import {
  str, USER_RE, MAIL_RE, EXAM_NO_RE, need, needAdmin, getUser, syncAdmin,
} from "../util.js";
import { parseExamDocument } from "../exam-parser.js";
import { getDeepSeekConfig, saveDeepSeekConfig, parseExamPhotosWithAI, gradeExamPapersWithAI } from "../exam-ai-parser.js";

const r = Router();
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ALLOWED_STATUS = new Set(["draft", "published"]);
const ALLOWED_FILTERS = new Set(["magic", "bw", "gray", "enhance", "original"]);
const ALLOWED_ANN_TYPES = new Set(["check", "cross", "circle", "line", "text"]);
const ALLOWED_QTYPES = new Set(["choice", "multi_choice", "judge", "blank", "listening", "essay", "other"]);

const num = (v, def = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};
const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;
const safeJson = (text, fallback) => {
  try { return JSON.parse(text); } catch { return fallback; }
};

function calcGrade(rate) {
  if (rate >= 0.92) return "A+";
  if (rate >= 0.85) return "A";
  if (rate >= 0.78) return "B+";
  if (rate >= 0.70) return "B";
  if (rate >= 0.60) return "C";
  return "D";
}

function calcMedian(sortedAsc) {
  if (!sortedAsc.length) return 0;
  const mid = Math.floor(sortedAsc.length / 2);
  return sortedAsc.length % 2
    ? sortedAsc[mid]
    : round1((sortedAsc[mid - 1] + sortedAsc[mid]) / 2);
}

function calcStdDev(vals, avg) {
  if (!vals.length) return 0;
  const variance = vals.reduce((s, v) => s + (v - avg) ** 2, 0) / vals.length;
  return round1(Math.sqrt(variance));
}

function competitionRank(sortedDesc, myVal) {
  let rank = 1;
  let below = 0;
  for (const v of sortedDesc) {
    if (v > myVal + 1e-6) rank++;
    else if (v < myVal - 1e-6) below++;
  }
  const total = sortedDesc.length;
  const beatPct = total <= 1 ? 100 : Math.round((below / (total - 1)) * 100);
  return { rank, beatPct, total };
}

function parseQuestions(rawQuestions, fullScoreFallback = 100) {
  if (!Array.isArray(rawQuestions)) return [];
  return rawQuestions.slice(0, 150).map((q, idx) => {
    const item = {
      no: str(q?.no || String(idx + 1)).trim().slice(0, 16) || String(idx + 1),
      title: str(q?.title).trim().slice(0, 240),
      tag: str(q?.tag).trim().slice(0, 32) || "综合能力",
      full: Math.max(0.5, Math.min(1000, num(q?.full, round1(fullScoreFallback / Math.max(1, rawQuestions.length))))),
      answer: str(q?.answer).trim().slice(0, 1500),
    };
    const section = str(q?.section).trim().slice(0, 24);
    const qtype = str(q?.qtype).trim();
    if (section) item.section = section;
    if (ALLOWED_QTYPES.has(qtype)) item.qtype = qtype;
    return item;
  });
}

function normalizeAnnotations(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const a of raw.slice(0, 200)) {
    if (!a || typeof a !== "object") continue;
    const type = str(a.type);
    if (!ALLOWED_ANN_TYPES.has(type)) continue;
    const item = {
      type,
      x: Math.max(0, Math.min(1, num(a.x, 0.5))),
      y: Math.max(0, Math.min(1, num(a.y, 0.5))),
      color: /^#[0-9a-fA-F]{3,8}$/.test(str(a.color)) ? str(a.color) : "#ef4444",
    };
    if (type === "line") {
      item.x2 = Math.max(0, Math.min(1, num(a.x2, item.x)));
      item.y2 = Math.max(0, Math.min(1, num(a.y2, item.y)));
    }
    if (type === "text") {
      item.text = str(a.text).trim().slice(0, 48);
      if (!item.text) continue;
    }
    out.push(item);
  }
  return out;
}

function unlinkPaperFiles(rows) {
  const root = path.resolve(EXAM_UPLOAD_DIR);
  for (const row of rows) {
    if (!row?.file_name) continue;
    const resolved = path.resolve(root, row.file_name);
    if (!resolved.startsWith(root + path.sep)) continue;
    try { fs.unlinkSync(resolved); } catch (e) {
      if (e.code !== "ENOENT") console.error("[exam] unlink failed:", e.message);
    }
  }
}

function decodeImageDataUrl(dataUrl) {
  const s = str(dataUrl).trim();
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(s);
  if (!m) throw new Error("图片格式不支持，请上传 JPEG / PNG / WebP");
  const mime = m[1];
  const buf = Buffer.from(m[2].replace(/\s+/g, ""), "base64");
  if (!buf.length || buf.length > MAX_IMAGE_BYTES) {
    throw new Error("图片大小须在 1B – 8MB 之间");
  }
  // 校验文件头魔数，防止伪造 MIME
  const isJpeg = mime === "image/jpeg" && buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const isPng = mime === "image/png" && buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isWebp = mime === "image/webp" && buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP";
  if (!isJpeg && !isPng && !isWebp) {
    throw new Error("图片内容校验失败");
  }
  const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
  return { mime, ext, buf };
}

function examUserDto(u) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name || "",
    email: u.email,
    examNo: u.exam_no || "",
    department: u.department || "",
    role: u.role,
    emailVerified: !!u.email_verified,
    banned: !!u.banned,
    banReason: u.ban_reason || "",
    createdAt: u.created_at,
  };
}

function subjectDto(s) {
  return {
    id: s.id,
    examId: s.exam_id,
    name: s.name,
    fullScore: s.full_score,
    passScore: s.pass_score,
    excellentScore: s.excellent_score,
    questions: safeJson(s.questions_json, []),
    sortOrder: s.sort_order,
  };
}

function paperDto(p) {
  return {
    id: p.id,
    examId: p.exam_id,
    subjectId: p.subject_id,
    userId: p.user_id,
    pageNo: p.page_no,
    mimeType: p.mime_type,
    width: p.width,
    height: p.height,
    sizeBytes: p.size_bytes,
    filterMode: p.filter_mode,
    annotations: safeJson(p.annotations_json, []),
    createdAt: p.created_at,
    url: `/api/exam/papers/${p.id}/image`,
  };
}

function resolveUser(userId, examNo) {
  if (userId !== undefined && userId !== null && userId !== "") {
    return db.prepare("SELECT * FROM users WHERE id=?").get(Number(userId)) || null;
  }
  const no = str(examNo).trim();
  if (EXAM_NO_RE.test(no)) {
    return db.prepare("SELECT * FROM users WHERE exam_no=?").get(no) || null;
  }
  return null;
}

function syncMistakes(userId, examId, subjectId, items, absent) {
  const now = Date.now();
  if (absent || !Array.isArray(items) || !items.length) {
    db.prepare("DELETE FROM exam_mistakes WHERE user_id=? AND exam_id=? AND subject_id=?").run(userId, examId, subjectId);
    return;
  }
  const wrongNos = new Set();
  const upsert = db.prepare(`
    INSERT INTO exam_mistakes (user_id, exam_id, subject_id, question_no, title, tag, full_score, got_score, answer, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id, exam_id, subject_id, question_no) DO UPDATE SET
      title=excluded.title,
      tag=excluded.tag,
      full_score=excluded.full_score,
      got_score=excluded.got_score,
      answer=excluded.answer,
      updated_at=excluded.updated_at
  `);
  for (const it of items) {
    const isWrong = it.wrong || it.got < it.full - 1e-6;
    if (!isWrong) continue;
    wrongNos.add(it.no);
    upsert.run(
      userId, examId, subjectId,
      it.no, it.title || "", it.tag || "综合能力",
      it.full, it.got, it.answer || "", now,
    );
  }
  // 如果某道题复核改回满分，且用户没有手写复盘笔记，自动清理出待巩固错题
  const existing = db.prepare("SELECT id, question_no, reflection FROM exam_mistakes WHERE user_id=? AND exam_id=? AND subject_id=?").all(userId, examId, subjectId);
  for (const row of existing) {
    if (!wrongNos.has(row.question_no) && !row.reflection.trim()) {
      db.prepare("DELETE FROM exam_mistakes WHERE id=?").run(row.id);
    }
  }
}

function normalizeAndSaveScore({ examId, subject, userId, gradedBy, payload }) {
  const absent = payload.absent ? 1 : 0;
  const teacherComment = str(payload.teacherComment).trim().slice(0, 500);
  const template = safeJson(subject.questions_json, []);
  let items = [];
  let score = 0;

  if (!absent) {
    const rawItems = Array.isArray(payload.items) ? payload.items : null;
    if (rawItems && rawItems.length) {
      const byNo = new Map();
      for (const x of rawItems) {
        if (x && x.no !== undefined) byNo.set(str(x.no).trim(), x);
      }
      if (template.length) {
        items = template.map((q) => {
          const hit = byNo.get(q.no);
          const full = q.full;
          const got = hit ? Math.max(0, Math.min(full, num(hit.got, full))) : 0;
          const out = {
            no: q.no,
            title: q.title || "",
            tag: q.tag || "综合能力",
            full,
            got: round1(got),
            wrong: !!(hit?.wrong) || got < full - 1e-6,
            answer: q.answer || "",
          };
          if (q.section) out.section = q.section;
          if (q.qtype) out.qtype = q.qtype;
          if (hit?.studentAnswer) out.studentAnswer = str(hit.studentAnswer).trim().slice(0, 500);
          if (hit?.aiComment) out.aiComment = str(hit.aiComment).trim().slice(0, 500);
          return out;
        });
      } else {
        items = rawItems.slice(0, 150).map((x, idx) => {
          const full = Math.max(0.5, Math.min(1000, num(x.full, 10)));
          const got = Math.max(0, Math.min(full, num(x.got, 0)));
          const out = {
            no: str(x.no || String(idx + 1)).trim().slice(0, 16) || String(idx + 1),
            title: str(x.title).trim().slice(0, 240),
            tag: str(x.tag).trim().slice(0, 32) || "综合能力",
            full,
            got: round1(got),
            wrong: !!(x.wrong) || got < full - 1e-6,
            answer: str(x.answer).trim().slice(0, 1500),
          };
          if (x.section) out.section = str(x.section).trim().slice(0, 24);
          if (ALLOWED_QTYPES.has(str(x.qtype).trim())) out.qtype = str(x.qtype).trim();
          if (x.studentAnswer) out.studentAnswer = str(x.studentAnswer).trim().slice(0, 500);
          if (x.aiComment) out.aiComment = str(x.aiComment).trim().slice(0, 500);
          return out;
        });
      }
      const sumItems = round1(items.reduce((s, it) => s + it.got, 0));
      score = payload.score !== undefined && payload.score !== "" && payload.score !== null && !payload.useItemsSum
        ? round1(Math.max(0, Math.min(subject.full_score, num(payload.score, sumItems))))
        : Math.min(subject.full_score, sumItems);
    } else {
      score = round1(Math.max(0, Math.min(subject.full_score, num(payload.score, 0))));
    }
  }

  const now = Date.now();
  db.prepare(`
    INSERT INTO exam_scores (exam_id, subject_id, user_id, score, absent, item_scores_json, teacher_comment, graded_by, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(exam_id, subject_id, user_id) DO UPDATE SET
      score=excluded.score,
      absent=excluded.absent,
      item_scores_json=excluded.item_scores_json,
      teacher_comment=excluded.teacher_comment,
      graded_by=excluded.graded_by,
      updated_at=excluded.updated_at
  `).run(examId, subject.id, userId, score, absent, JSON.stringify(items), teacherComment, gradedBy, now, now);

  syncMistakes(userId, examId, subject.id, items, !!absent);
  return { subjectId: subject.id, score, absent: !!absent, items, teacherComment };
}

/** 汇总某场考试所有考生数据（纯内存聚合，绝不向普通用户透出他人明文） */
function computeExamAggregates(examId) {
  const subjects = db.prepare("SELECT * FROM exam_subjects WHERE exam_id=? ORDER BY sort_order ASC, id ASC").all(examId);
  const fullTotal = round1(subjects.reduce((s, sub) => s + sub.full_score, 0));
  const scores = db.prepare(`
    SELECT sc.*, u.username, u.display_name, u.exam_no, u.department
    FROM exam_scores sc
    JOIN users u ON u.id = sc.user_id
    WHERE sc.exam_id = ?
  `).all(examId);
  const paperCounts = new Map(
    db.prepare("SELECT user_id, COUNT(*) c FROM exam_paper_pages WHERE exam_id=? GROUP BY user_id")
      .all(examId).map((x) => [x.user_id, x.c]),
  );

  // 按考生聚合成绩
  const byUser = new Map();
  for (const row of scores) {
    let entry = byUser.get(row.user_id);
    if (!entry) {
      entry = {
        userId: row.user_id,
        username: row.username,
        displayName: row.display_name || "",
        examNo: row.exam_no || "",
        department: row.department || "",
        totalScore: 0,
        absentAll: true,
        hasAny: false,
        bySubject: new Map(),
        paperCount: paperCounts.get(row.user_id) || 0,
      };
      byUser.set(row.user_id, entry);
    }
    entry.hasAny = true;
    if (!row.absent) {
      entry.absentAll = false;
      entry.totalScore = round1(entry.totalScore + row.score);
    }
    entry.bySubject.set(row.subject_id, {
      score: row.score,
      absent: !!row.absent,
      items: safeJson(row.item_scores_json, []),
      teacherComment: row.teacher_comment || "",
      updatedAt: row.updated_at,
    });
  }

  const participants = [...byUser.values()].filter((p) => !p.absentAll);
  const totalListDesc = participants.map((p) => p.totalScore).sort((a, b) => b - a);
  const totalListAsc = [...totalListDesc].reverse();
  const avgTotal = totalListDesc.length ? round1(totalListDesc.reduce((a, b) => a + b, 0) / totalListDesc.length) : 0;
  const maxTotal = totalListDesc.length ? totalListDesc[0] : 0;
  const minTotal = totalListDesc.length ? totalListDesc[totalListDesc.length - 1] : 0;
  const medianTotal = calcMedian(totalListAsc);
  const stdTotal = calcStdDev(totalListDesc, avgTotal);
  const passCount = participants.filter((p) => fullTotal > 0 && p.totalScore / fullTotal >= 0.6).length;
  const excCount = participants.filter((p) => fullTotal > 0 && p.totalScore / fullTotal >= 0.85).length;

  // 5 档得分率分布（按百分比区间，兼容任意满分）
  const bands = [
    { label: "90–100%", min: 0.90, max: 1.01, count: 0 },
    { label: "80–89%", min: 0.80, max: 0.90, count: 0 },
    { label: "70–79%", min: 0.70, max: 0.80, count: 0 },
    { label: "60–69%", min: 0.60, max: 0.70, count: 0 },
    { label: "< 60%", min: -1, max: 0.60, count: 0 },
  ];
  for (const p of participants) {
    const rate = fullTotal > 0 ? p.totalScore / fullTotal : 0;
    const b = bands.find((x) => rate >= x.min && rate < x.max) || bands[bands.length - 1];
    b.count++;
  }

  // 分科目聚合 & 小题平均得分率
  const subjectStats = new Map();
  for (const sub of subjects) {
    const subEntries = [...byUser.values()]
      .map((u) => ({ user: u, rec: u.bySubject.get(sub.id) }))
      .filter((x) => x.rec && !x.rec.absent);
    const valsDesc = subEntries.map((x) => x.rec.score).sort((a, b) => b - a);
    const valsAsc = [...valsDesc].reverse();
    const avg = valsDesc.length ? round1(valsDesc.reduce((a, b) => a + b, 0) / valsDesc.length) : 0;

    // 小题均分统计
    const itemAgg = new Map();
    for (const x of subEntries) {
      for (const it of x.rec.items) {
        const cur = itemAgg.get(it.no) || { gotSum: 0, fullSum: 0, count: 0, tag: it.tag || "综合能力" };
        cur.gotSum += num(it.got, 0);
        cur.fullSum += num(it.full, 0);
        cur.count++;
        itemAgg.set(it.no, cur);
      }
    }

    subjectStats.set(sub.id, {
      count: valsDesc.length,
      avg,
      max: valsDesc.length ? valsDesc[0] : 0,
      min: valsDesc.length ? valsDesc[valsDesc.length - 1] : 0,
      median: calcMedian(valsAsc),
      stdDev: calcStdDev(valsDesc, avg),
      passRate: valsDesc.length ? Math.round((valsDesc.filter((v) => v >= sub.pass_score).length / valsDesc.length) * 100) : 0,
      excellentRate: valsDesc.length ? Math.round((valsDesc.filter((v) => v >= sub.excellent_score).length / valsDesc.length) * 100) : 0,
      valsDesc,
      itemAgg,
    });
  }

  return {
    subjects,
    fullTotal,
    byUser,
    participants,
    totalListDesc,
    summary: {
      totalParticipants: participants.length,
      avgTotal,
      maxTotal,
      minTotal,
      medianTotal,
      stdTotal,
      passRate: participants.length ? Math.round((passCount / participants.length) * 100) : 0,
      excellentRate: participants.length ? Math.round((excCount / participants.length) * 100) : 0,
      scoreBands: bands.map(({ label, count }) => ({ label, count })),
    },
    subjectStats,
  };
}

// ====================================================================
// 员工端路由（需登录）
// ====================================================================
r.use(need);

r.get("/me", (req, res) => {
  const u = getUser(req.user.id);
  const exams = db.prepare("SELECT * FROM exams WHERE status='published' ORDER BY exam_date ASC, id ASC").all();
  const trends = [];
  for (const ex of exams) {
    const agg = computeExamAggregates(ex.id);
    const mine = agg.byUser.get(u.id);
    if (!mine || !mine.hasAny || mine.absentAll) continue;
    const rate = agg.fullTotal > 0 ? round1((mine.totalScore / agg.fullTotal) * 100) : 0;
    const { rank, beatPct, total } = competitionRank(agg.totalListDesc, mine.totalScore);
    trends.push({
      examId: ex.id,
      title: ex.title,
      term: ex.term,
      examDate: ex.exam_date,
      score: mine.totalScore,
      fullScore: agg.fullTotal,
      avgScore: agg.summary.avgTotal,
      rate,
      grade: calcGrade(agg.fullTotal > 0 ? mine.totalScore / agg.fullTotal : 0),
      rank: ex.show_rank || u.role === "admin" ? rank : null,
      beatPct,
      totalParticipants: total,
    });
  }
  const mistakeTotal = db.prepare(`
    SELECT COUNT(*) c FROM exam_mistakes m
    JOIN exams e ON e.id = m.exam_id
    WHERE m.user_id=? AND (e.status='published' OR ?=1)
  `).get(u.id, u.role === "admin" ? 1 : 0).c;
  const mistakePending = db.prepare(`
    SELECT COUNT(*) c FROM exam_mistakes m
    JOIN exams e ON e.id = m.exam_id
    WHERE m.user_id=? AND m.mastered=0 AND (e.status='published' OR ?=1)
  `).get(u.id, u.role === "admin" ? 1 : 0).c;
  const avgRate = trends.length ? round1(trends.reduce((s, t) => s + t.rate, 0) / trends.length) : 0;

  res.json({
    user: examUserDto(u),
    stats: {
      examCount: trends.length,
      avgRate,
      mistakeTotal,
      mistakePending,
    },
    trends,
  });
});

r.get("/list", (req, res) => {
  const isAdmin = req.user.role === "admin";
  const rows = db.prepare(
    isAdmin ? "SELECT * FROM exams ORDER BY exam_date DESC, id DESC" : "SELECT * FROM exams WHERE status='published' ORDER BY exam_date DESC, id DESC",
  ).all();

  const exams = rows.map((ex) => {
    const agg = computeExamAggregates(ex.id);
    const mine = agg.byUser.get(req.user.id);
    const myPapers = db.prepare("SELECT COUNT(*) c FROM exam_paper_pages WHERE exam_id=? AND user_id=?").get(ex.id, req.user.id).c;
    const totalPapers = isAdmin ? db.prepare("SELECT COUNT(*) c FROM exam_paper_pages WHERE exam_id=?").get(ex.id).c : myPapers;
    let mySummary = null;
    if (mine && mine.hasAny) {
      const rate = agg.fullTotal > 0 ? mine.totalScore / agg.fullTotal : 0;
      const rk = mine.absentAll ? { rank: null, beatPct: 0 } : competitionRank(agg.totalListDesc, mine.totalScore);
      mySummary = {
        absent: mine.absentAll,
        score: mine.totalScore,
        rate: round1(rate * 100),
        grade: mine.absentAll ? "缺考" : calcGrade(rate),
        rank: ex.show_rank || isAdmin ? rk.rank : null,
        beatPct: rk.beatPct,
      };
    }
    return {
      id: ex.id,
      title: ex.title,
      term: ex.term,
      examDate: ex.exam_date,
      description: ex.description,
      status: ex.status,
      showRank: !!ex.show_rank,
      fullScore: agg.fullTotal,
      subjects: agg.subjects.map(subjectDto),
      totalParticipants: agg.summary.totalParticipants,
      avgTotal: agg.summary.avgTotal,
      paperCount: totalPapers,
      myPaperCount: myPapers,
      mine: mySummary,
      createdAt: ex.created_at,
      updatedAt: ex.updated_at,
    };
  });

  res.json({ exams });
});

r.get("/exams/:examId/report", (req, res) => {
  const examId = Number(req.params.examId);
  const ex = db.prepare("SELECT * FROM exams WHERE id=?").get(examId);
  if (!ex) return res.status(404).json({ error: "考试不存在" });

  const isAdmin = req.user.role === "admin";
  if (ex.status !== "published" && !isAdmin) {
    return res.status(403).json({ error: "该场考试尚未发布成绩" });
  }

  let target = getUser(req.user.id);
  if (isAdmin && (req.query.userId || req.query.examNo)) {
    const found = resolveUser(req.query.userId, req.query.examNo);
    if (!found) return res.status(404).json({ error: "目标考生不存在" });
    target = found;
  }

  const agg = computeExamAggregates(examId);
  const mineEntry = agg.byUser.get(target.id);
  const canSeeRank = !!ex.show_rank || isAdmin;

  const papersAll = db.prepare(
    "SELECT * FROM exam_paper_pages WHERE exam_id=? AND user_id=? ORDER BY subject_id ASC, page_no ASC, id ASC",
  ).all(examId, target.id);

  // 部门内排名（同部门参与考生）
  let deptRank = null;
  let deptTotal = 0;
  if (mineEntry && !mineEntry.absentAll && target.department) {
    const deptScores = agg.participants
      .filter((p) => p.department === target.department)
      .map((p) => p.totalScore)
      .sort((a, b) => b - a);
    deptTotal = deptScores.length;
    if (canSeeRank && deptTotal) {
      deptRank = competitionRank(deptScores, mineEntry.totalScore).rank;
    }
  }

  let mineOverview = {
    hasRecord: !!(mineEntry && mineEntry.hasAny),
    absent: mineEntry ? mineEntry.absentAll : false,
    totalScore: mineEntry ? mineEntry.totalScore : 0,
    fullScore: agg.fullTotal,
    rate: mineEntry && agg.fullTotal > 0 ? round1((mineEntry.totalScore / agg.fullTotal) * 100) : 0,
    grade: !mineEntry || !mineEntry.hasAny ? "—" : mineEntry.absentAll ? "缺考" : calcGrade(agg.fullTotal > 0 ? mineEntry.totalScore / agg.fullTotal : 0),
    rank: null,
    beatPct: 0,
    totalParticipants: agg.summary.totalParticipants,
    deptRank,
    deptTotal,
  };
  if (mineEntry && mineEntry.hasAny && !mineEntry.absentAll) {
    const rk = competitionRank(agg.totalListDesc, mineEntry.totalScore);
    mineOverview.rank = canSeeRank ? rk.rank : null;
    mineOverview.beatPct = rk.beatPct;
  }

  // 分科目详情与小题细目
  const tagTotals = new Map();
  const subjectsOut = agg.subjects.map((sub) => {
    const st = agg.subjectStats.get(sub.id);
    const rec = mineEntry?.bySubject.get(sub.id) || null;
    const subPages = papersAll.filter((p) => p.subject_id === sub.id).map(paperDto);

    let subMine = null;
    if (rec) {
      const rate = sub.full_score > 0 ? rec.score / sub.full_score : 0;
      const rk = rec.absent ? { rank: null, beatPct: 0 } : competitionRank(st.valsDesc, rec.score);
      const itemsOut = rec.items.map((it) => {
        const ia = st.itemAgg.get(it.no);
        const classRate = ia && ia.fullSum > 0 ? Math.round((ia.gotSum / ia.fullSum) * 100) : 0;
        const myItemRate = it.full > 0 ? Math.round((it.got / it.full) * 100) : 0;

        // 统计知识点维度
        const tName = it.tag || "综合能力";
        const tCur = tagTotals.get(tName) || { myGot: 0, myFull: 0, classGot: 0, classFull: 0 };
        tCur.myGot += num(it.got, 0);
        tCur.myFull += num(it.full, 0);
        if (ia) { tCur.classGot += ia.gotSum; tCur.classFull += ia.fullSum; }
        tagTotals.set(tName, tCur);

        return {
          no: it.no,
          title: it.title || "",
          tag: tName,
          ...(it.section ? { section: it.section } : {}),
          ...(it.qtype ? { qtype: it.qtype } : {}),
          ...(it.studentAnswer ? { studentAnswer: it.studentAnswer } : {}),
          ...(it.aiComment ? { aiComment: it.aiComment } : {}),
          full: it.full,
          got: it.got,
          wrong: !!it.wrong || it.got < it.full - 1e-6,
          answer: it.answer || "",
          myRate: myItemRate,
          classRate,
        };
      });

      subMine = {
        score: rec.score,
        absent: rec.absent,
        rate: round1(rate * 100),
        grade: rec.absent ? "缺考" : calcGrade(rate),
        rank: canSeeRank ? rk.rank : null,
        beatPct: rk.beatPct,
        teacherComment: rec.teacherComment,
        items: itemsOut,
      };
    }

    return {
      id: sub.id,
      name: sub.name,
      fullScore: sub.full_score,
      passScore: sub.pass_score,
      excellentScore: sub.excellent_score,
      questions: safeJson(sub.questions_json, []),
      classStats: {
        count: st.count,
        avg: st.avg,
        avgRate: sub.full_score > 0 ? round1((st.avg / sub.full_score) * 100) : 0,
        max: st.max,
        min: st.min,
        passRate: st.passRate,
        excellentRate: st.excellentRate,
      },
      mine: subMine,
      papers: subPages,
    };
  });

  // 雷达图：科目雷达 & 知识点雷达
  const subjectRadar = subjectsOut.map((s) => ({
    label: s.name,
    mine: s.mine && !s.mine.absent ? s.mine.rate : 0,
    avg: s.classStats.avgRate,
  }));
  const tagRadar = [...tagTotals.entries()].map(([label, v]) => ({
    label,
    mine: v.myFull > 0 ? round1((v.myGot / v.myFull) * 100) : 0,
    avg: v.classFull > 0 ? round1((v.classGot / v.classFull) * 100) : 0,
  }));
  const radar = subjectRadar.length >= 3 ? subjectRadar : (tagRadar.length >= 3 ? tagRadar : subjectRadar);

  // 智学网式强弱项诊断
  const diffs = subjectsOut
    .filter((s) => s.mine && !s.mine.absent)
    .map((s) => ({ name: s.name, diff: round1(s.mine.rate - s.classStats.avgRate), rate: s.mine.rate }))
    .sort((a, b) => b.diff - a.diff);
  const strong = diffs.filter((d) => d.diff >= 0).slice(0, 2);
  const weak = diffs.filter((d) => d.diff < 0).reverse().slice(0, 2);
  let summaryText = "暂无成绩记录，请等待管理员录入。";
  if (mineOverview.hasRecord && mineOverview.absent) {
    summaryText = "本场考试标记为缺考。";
  } else if (mineOverview.hasRecord) {
    const gap = round1(mineOverview.totalScore - agg.summary.avgTotal);
    const gapStr = gap >= 0 ? `高于全员均分 ${gap} 分` : `低于全员均分 ${Math.abs(gap)} 分`;
    const weakPart = weak.length ? `，建议重点复盘「${weak.map((w) => w.name).join("、")}」` : "，各维度保持稳健均衡";
    summaryText = `本次总分 ${mineOverview.totalScore}/${agg.fullTotal}（${mineOverview.grade}），${gapStr}，超越 ${mineOverview.beatPct}% 参考成员${weakPart}。`;
  }

  res.json({
    exam: {
      id: ex.id,
      title: ex.title,
      term: ex.term,
      examDate: ex.exam_date,
      description: ex.description,
      status: ex.status,
      showRank: !!ex.show_rank,
      fullScore: agg.fullTotal,
    },
    targetUser: {
      id: target.id,
      username: target.username,
      displayName: target.display_name || "",
      examNo: target.exam_no || "",
      department: target.department || "",
    },
    overview: agg.summary,
    mine: mineOverview,
    subjects: subjectsOut,
    radar,
    tagRadar,
    diagnosis: { strong, weak, summary: summaryText },
  });
});

r.get("/papers/:pageId/image", (req, res) => {
  const pageId = Number(req.params.pageId);
  const row = db.prepare(`
    SELECT p.*, e.status AS exam_status
    FROM exam_paper_pages p
    JOIN exams e ON e.id = p.exam_id
    WHERE p.id = ?
  `).get(pageId);
  if (!row) return res.status(404).json({ error: "试卷页不存在" });

  const isAdmin = req.user.role === "admin";
  if (!isAdmin && (row.user_id !== req.user.id || row.exam_status !== "published")) {
    return res.status(403).json({ error: "无权查看该试卷" });
  }

  const root = path.resolve(EXAM_UPLOAD_DIR);
  const resolved = path.resolve(root, row.file_name);
  if (!resolved.startsWith(root + path.sep) || !fs.existsSync(resolved)) {
    return res.status(404).json({ error: "试卷图片文件不存在" });
  }
  res.set({
    "Content-Type": row.mime_type || "image/jpeg",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, max-age=3600",
  });
  res.sendFile(resolved);
});

r.get("/mistakes", (req, res) => {
  const isAdmin = req.user.role === "admin";
  const examId = Number(req.query.examId) || 0;
  const subject = str(req.query.subject).trim();
  const masteredParam = str(req.query.mastered);

  const conds = ["m.user_id = ?"];
  const params = [req.user.id];
  if (!isAdmin) conds.push("e.status = 'published'");
  if (examId) { conds.push("m.exam_id = ?"); params.push(examId); }
  if (subject) { conds.push("s.name = ?"); params.push(subject); }
  if (masteredParam === "0" || masteredParam === "1") {
    conds.push("m.mastered = ?");
    params.push(Number(masteredParam));
  }

  const rows = db.prepare(`
    SELECT m.*, e.title AS exam_title, e.exam_date, s.name AS subject_name
    FROM exam_mistakes m
    JOIN exams e ON e.id = m.exam_id
    JOIN exam_subjects s ON s.id = m.subject_id
    WHERE ${conds.join(" AND ")}
    ORDER BY m.mastered ASC, e.exam_date DESC, m.exam_id DESC, m.id ASC
    LIMIT 300
  `).all(...params);

  const pagesCache = new Map();
  const getPages = (eid, sid) => {
    const k = `${eid}:${sid}`;
    if (!pagesCache.has(k)) {
      pagesCache.set(k, db.prepare(
        "SELECT * FROM exam_paper_pages WHERE exam_id=? AND subject_id=? AND user_id=? ORDER BY page_no ASC, id ASC",
      ).all(eid, sid, req.user.id).map(paperDto));
    }
    return pagesCache.get(k);
  };

  const mistakes = rows.map((m) => ({
    id: m.id,
    examId: m.exam_id,
    examTitle: m.exam_title,
    examDate: m.exam_date,
    subjectId: m.subject_id,
    subjectName: m.subject_name,
    questionNo: m.question_no,
    title: m.title,
    tag: m.tag,
    fullScore: m.full_score,
    gotScore: m.got_score,
    answer: m.answer,
    reflection: m.reflection,
    mastered: !!m.mastered,
    updatedAt: m.updated_at,
    papers: getPages(m.exam_id, m.subject_id),
  }));

  res.json({ mistakes });
});

r.patch("/mistakes/:id", (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare("SELECT * FROM exam_mistakes WHERE id=?").get(id);
  if (!row) return res.status(404).json({ error: "错题记录不存在" });
  if (row.user_id !== req.user.id) return res.status(403).json({ error: "不能修改他人错题" });

  const reflection = req.body.reflection !== undefined
    ? str(req.body.reflection).trim().slice(0, 1000)
    : row.reflection;
  const mastered = req.body.mastered !== undefined ? (req.body.mastered ? 1 : 0) : row.mastered;
  const now = Date.now();
  db.prepare("UPDATE exam_mistakes SET reflection=?, mastered=?, updated_at=? WHERE id=?")
    .run(reflection, mastered, now, id);
  res.json({ ok: true, reflection, mastered: !!mastered, updatedAt: now });
});

// ====================================================================
// 管理员路由（用户与 4 位考号 / 考试 / 成绩 / 扫描件与红笔批改）
// ====================================================================
r.use("/admin", needAdmin);

r.get("/admin/users", (req, res) => {
  const q = `%${str(req.query.q).trim()}%`;
  const dept = str(req.query.department).trim();
  const rows = db.prepare(`
    SELECT u.*
    FROM users u
    WHERE (u.username LIKE ? OR u.display_name LIKE ? OR u.email LIKE ? OR COALESCE(u.exam_no,'') LIKE ? OR u.department LIKE ?)
      ${dept ? "AND u.department = ?" : ""}
    ORDER BY (CASE WHEN u.exam_no IS NOT NULL AND u.exam_no <> '' THEN 0 ELSE 1 END), u.exam_no ASC, u.id DESC
    LIMIT 300
  `).all(...(dept ? [q, q, q, q, q, dept] : [q, q, q, q, q]));

  // 统计参考次数与最近得分率
  const scoreSummary = new Map();
  const scoreRows = db.prepare(`
    SELECT sc.user_id, sc.exam_id, SUM(CASE WHEN sc.absent=0 THEN sc.score ELSE 0 END) AS got,
           MIN(sc.absent) AS all_absent,
           (SELECT SUM(es.full_score) FROM exam_subjects es WHERE es.exam_id = sc.exam_id) AS full_sum
    FROM exam_scores sc
    GROUP BY sc.user_id, sc.exam_id
    ORDER BY sc.exam_id ASC
  `).all();
  for (const sr of scoreRows) {
    if (sr.all_absent) continue;
    const cur = scoreSummary.get(sr.user_id) || { count: 0, latestRate: null };
    cur.count++;
    cur.latestRate = sr.full_sum > 0 ? round1((sr.got / sr.full_sum) * 100) : 0;
    scoreSummary.set(sr.user_id, cur);
  }

  res.json({
    users: rows.map((u) => {
      const st = scoreSummary.get(u.id) || { count: 0, latestRate: null };
      return { ...examUserDto(u), examCount: st.count, latestRate: st.latestRate };
    }),
  });
});

r.get("/admin/users/next-exam-no", (_req, res) => {
  const used = new Set(
    db.prepare("SELECT exam_no FROM users WHERE exam_no IS NOT NULL AND exam_no <> ''").all().map((x) => x.exam_no),
  );
  if (used.size >= 9999) return res.status(409).json({ error: "4 位考号已分配完" });
  for (let i = 0; i < 60; i++) {
    const n = String(crypto.randomInt(1, 10000)).padStart(4, "0");
    if (!used.has(n)) return res.json({ examNo: n });
  }
  for (let i = 1; i <= 9999; i++) {
    const n = String(i).padStart(4, "0");
    if (!used.has(n)) return res.json({ examNo: n });
  }
  res.status(409).json({ error: "4 位考号已分配完" });
});

r.get("/admin/users/by-exam-no/:examNo", (req, res) => {
  const no = str(req.params.examNo).trim();
  if (!EXAM_NO_RE.test(no)) return res.status(400).json({ error: "考号必须为 4 位数字（如 0413）" });
  const u = db.prepare("SELECT * FROM users WHERE exam_no=?").get(no);
  if (!u) return res.status(404).json({ error: `未找到考号 ${no} 对应的成员` });
  res.json({ user: examUserDto(u) });
});

r.post("/admin/users", async (req, res) => {
  const username = str(req.body.username).trim();
  const displayName = str(req.body.displayName).trim();
  const email = str(req.body.email).trim();
  const password = str(req.body.password);
  const examNo = str(req.body.examNo).trim();
  const department = str(req.body.department).trim().slice(0, 40);
  const role = req.body.role === "admin" ? "admin" : "user";
  const emailVerified = req.body.emailVerified === false ? 0 : 1;

  if (!USER_RE.test(username)) return res.status(400).json({ error: "用户名为 2–24 位字母、数字、中文、_ 或 -" });
  if (displayName.length > 32) return res.status(400).json({ error: "姓名/昵称最多 32 字" });
  if (!MAIL_RE.test(email)) return res.status(400).json({ error: "邮箱格式不正确" });
  if (password.length < 4 || password.length > 128) return res.status(400).json({ error: "初始密码长度需为 4–128 位" });
  if (examNo && !EXAM_NO_RE.test(examNo)) return res.status(400).json({ error: "考号必须为 4 位数字（如 0413）" });

  if (db.prepare("SELECT 1 FROM users WHERE username=? OR email=?").get(username, email)) {
    return res.status(409).json({ error: "用户名或邮箱已被占用" });
  }
  if (examNo && db.prepare("SELECT 1 FROM users WHERE exam_no=?").get(examNo)) {
    return res.status(409).json({ error: `考号 ${examNo} 已被占用` });
  }

  const hash = await A.hashPassword(password);
  const uid = Number(db.prepare(`
    INSERT INTO users (username, email, password_hash, role, email_verified, created_at, display_name, exam_no, department, admin_manual)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(username, email, hash, role, emailVerified, Date.now(), displayName, examNo || null, department, role === "admin" ? 1 : 0).lastInsertRowid);

  syncAdmin(uid);
  res.status(201).json({ user: examUserDto(getUser(uid)) });
});

r.patch("/admin/users/:id", async (req, res) => {
  const id = Number(req.params.id);
  const u = getUser(id);
  if (!u) return res.status(404).json({ error: "用户不存在" });

  const username = req.body.username !== undefined ? str(req.body.username).trim() : u.username;
  const displayName = req.body.displayName !== undefined ? str(req.body.displayName).trim() : u.display_name;
  const email = req.body.email !== undefined ? str(req.body.email).trim() : u.email;
  const examNo = req.body.examNo !== undefined ? str(req.body.examNo).trim() : (u.exam_no || "");
  const department = req.body.department !== undefined ? str(req.body.department).trim().slice(0, 40) : u.department;
  const nextRole = req.body.role !== undefined ? (req.body.role === "admin" ? "admin" : "user") : u.role;
  const emailVerified = req.body.emailVerified !== undefined ? (req.body.emailVerified ? 1 : 0) : u.email_verified;
  const banned = req.body.banned !== undefined ? (req.body.banned ? 1 : 0) : u.banned;
  const banReason = req.body.banReason !== undefined ? str(req.body.banReason).trim().slice(0, 200) : u.ban_reason;
  const newPassword = str(req.body.password);

  if (!USER_RE.test(username)) return res.status(400).json({ error: "用户名为 2–24 位字母、数字、中文、_ 或 -" });
  if (displayName.length > 32) return res.status(400).json({ error: "姓名/昵称最多 32 字" });
  if (!MAIL_RE.test(email)) return res.status(400).json({ error: "邮箱格式不正确" });
  if (examNo && !EXAM_NO_RE.test(examNo)) return res.status(400).json({ error: "考号必须为 4 位数字（如 0413）" });
  if (newPassword && (newPassword.length < 4 || newPassword.length > 128)) {
    return res.status(400).json({ error: "新密码长度需为 4–128 位" });
  }
  if (id === req.user.id && nextRole !== "admin") {
    return res.status(400).json({ error: "不能取消当前登录账号的管理员权限" });
  }
  if (id === req.user.id && banned) {
    return res.status(400).json({ error: "不能封禁自己" });
  }
  if (nextRole === "admin" && banned) {
    return res.status(400).json({ error: "不能封禁管理员" });
  }

  if (db.prepare("SELECT 1 FROM users WHERE (username=? OR email=?) AND id<>?").get(username, email, id)) {
    return res.status(409).json({ error: "用户名或邮箱已被其他用户占用" });
  }
  if (examNo && db.prepare("SELECT 1 FROM users WHERE exam_no=? AND id<>?").get(examNo, id)) {
    return res.status(409).json({ error: `考号 ${examNo} 已被其他用户占用` });
  }

  const adminEmail = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  if (nextRole !== "admin" && adminEmail && email.toLowerCase() === adminEmail && emailVerified) {
    return res.status(400).json({ error: "该邮箱对应系统预设管理员（ADMIN_EMAIL），无法降级" });
  }

  const adminManual = nextRole === "admin" ? 1 : 0;
  db.prepare(`
    UPDATE users
    SET username=?, display_name=?, email=?, exam_no=?, department=?, role=?, admin_manual=?, email_verified=?, banned=?, ban_reason=?
    WHERE id=?
  `).run(username, displayName, email, examNo || null, department, nextRole, adminManual, emailVerified, banned, banned ? banReason : "", id);

  if (newPassword) {
    const hash = await A.hashPassword(newPassword);
    db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(hash, id);
    A.destroyUserSessions(id);
  }
  if (banned) A.destroyUserSessions(id);

  syncAdmin(id);
  res.json({ user: examUserDto(getUser(id)) });
});

r.delete("/admin/users/:id", (req, res) => {
  const id = Number(req.params.id);
  const u = getUser(id);
  if (!u) return res.status(404).json({ error: "用户不存在" });
  if (id === req.user.id) return res.status(400).json({ error: "不能删除当前登录的管理员账号" });

  const paperFiles = db.prepare("SELECT file_name FROM exam_paper_pages WHERE user_id=?").all(id);
  db.prepare("DELETE FROM users WHERE id=?").run(id);
  unlinkPaperFiles(paperFiles);
  res.json({ ok: true });
});

// ---- 试卷文档解析（PDF / DOCX / TXT / MD 自动扫描题型与分值） ----
r.post("/admin/parse-doc", async (req, res) => {
  try {
    const parsed = await parseExamDocument({
      filename: str(req.body?.filename),
      mimeType: str(req.body?.mimeType),
      fileDataUrl: str(req.body?.fileDataUrl),
      text: str(req.body?.text),
    });
    res.json({ parsed });
  } catch (e) {
    const status = Number(e?.status) >= 400 && Number(e?.status) < 500 ? Number(e.status) : 400;
    res.status(status).json({ error: e?.message || "试卷文档解析失败" });
  }
});

// ---- AI 拍照识卷配置与 DeepSeek 多模态识图（管理员） ----
r.get("/admin/ai-config", (_req, res) => {
  res.json({ config: getDeepSeekConfig() });
});

r.put("/admin/ai-config", (req, res) => {
  try {
    const cfg = saveDeepSeekConfig({
      apiKey: req.body?.apiKey !== undefined ? str(req.body.apiKey) : undefined,
      baseUrl: req.body?.baseUrl !== undefined ? str(req.body.baseUrl) : undefined,
      model: req.body?.model !== undefined ? str(req.body.model) : undefined,
    });
    res.json({ config: cfg });
  } catch (e) {
    const status = Number(e?.status) >= 400 && Number(e?.status) < 500 ? Number(e.status) : 400;
    res.status(status).json({ error: e?.message || "保存 AI 配置失败" });
  }
});

r.post("/admin/parse-photos", async (req, res) => {
  try {
    const parsed = await parseExamPhotosWithAI({
      images: req.body?.images,
      apiKey: str(req.body?.apiKey),
      baseUrl: str(req.body?.baseUrl),
      model: str(req.body?.model),
    });
    res.json({ parsed });
  } catch (e) {
    const status = Number(e?.status) >= 400 && Number(e?.status) < 600 ? Number(e.status) : 400;
    res.status(status).json({ error: e?.message || "拍照识卷失败" });
  }
});

// ---- AI 自动批改考生答题卡扫描件（读取已上传原卷 -> 识别作答 -> 判分与生成红笔批注 -> 落库成绩与错题本） ----
r.post("/admin/ai-grade", async (req, res) => {
  const examId = Number(req.body?.examId);
  const subjectId = Number(req.body?.subjectId);
  const ex = db.prepare("SELECT * FROM exams WHERE id=?").get(examId);
  if (!ex) return res.status(404).json({ error: "考试不存在" });
  const sub = db.prepare("SELECT * FROM exam_subjects WHERE id=? AND exam_id=?").get(subjectId, examId);
  if (!sub) return res.status(404).json({ error: "科目不存在" });

  const target = resolveUser(req.body?.userId, req.body?.examNo);
  if (!target) return res.status(404).json({ error: "未找到目标考生，请核对 4 位考号" });

  const paperRows = db.prepare(
    "SELECT * FROM exam_paper_pages WHERE exam_id=? AND subject_id=? AND user_id=? ORDER BY page_no ASC, id ASC",
  ).all(examId, subjectId, target.id);
  if (!paperRows.length) {
    return res.status(400).json({ error: "该考生在本科目下尚未上传答题卡/试卷扫描件，请先拍照或上传原卷" });
  }

  const rootDir = path.resolve(EXAM_UPLOAD_DIR);
  const pages = [];
  for (let i = 0; i < Math.min(paperRows.length, 16); i++) {
    const row = paperRows[i];
    const resolved = path.resolve(rootDir, row.file_name);
    if (!resolved.startsWith(rootDir + path.sep) || !fs.existsSync(resolved)) continue;
    const buf = fs.readFileSync(resolved);
    const mime = /^image\/(?:png|webp)$/.test(row.mime_type) ? row.mime_type : "image/jpeg";
    pages.push({
      id: row.id,
      pageNo: i + 1,
      actualPageNo: row.page_no,
      dataUrl: `data:${mime};base64,${buf.toString("base64")}`,
    });
  }
  if (!pages.length) {
    return res.status(404).json({ error: "扫描原卷图片文件不存在或已丢失" });
  }

  let grading;
  try {
    grading = await gradeExamPapersWithAI({
      pages,
      subject: subjectDto(sub),
      apiKey: str(req.body?.apiKey),
      baseUrl: str(req.body?.baseUrl),
      model: str(req.body?.model),
    });
  } catch (e) {
    const status = Number(e?.status) >= 400 && Number(e?.status) < 600 ? Number(e.status) : 400;
    return res.status(status).json({ error: e?.message || "AI 自动批改失败" });
  }

  const applyAnnotations = req.body?.applyAnnotations !== false;
  const autoSave = req.body?.autoSave !== false;
  let pagesUpdated = 0;
  let savedScore = null;

  db.exec("BEGIN");
  try {
    if (applyAnnotations) {
      const updPage = db.prepare("UPDATE exam_paper_pages SET annotations_json=? WHERE id=?");
      for (const p of pages) {
        const rawAnns = grading.annotationsByPageNo.get(p.pageNo) || [];
        const cleanAnns = normalizeAnnotations(rawAnns);
        updPage.run(JSON.stringify(cleanAnns), p.id);
        pagesUpdated++;
      }
    }
    if (autoSave) {
      savedScore = normalizeAndSaveScore({
        examId,
        subject: sub,
        userId: target.id,
        gradedBy: req.user.id,
        payload: {
          score: grading.score,
          absent: false,
          items: grading.items,
          useItemsSum: grading.items.length > 0,
          teacherComment: grading.teacherComment,
        },
      });
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    return res.status(400).json({ error: e.message || "保存 AI 批改结果失败" });
  }

  res.json({
    ok: true,
    grading: {
      score: grading.score,
      fullScore: grading.fullScore,
      teacherComment: grading.teacherComment,
      items: grading.items,
      wrongCount: grading.wrongCount,
      model: grading.model,
      pagesUpdated,
      autoSaved: autoSave,
      saved: savedScore,
    },
  });
});

// ---- 考试管理 ----
r.post("/admin/exams", (req, res) => {
  const title = str(req.body.title).trim();
  const term = str(req.body.term).trim().slice(0, 40);
  const examDate = str(req.body.examDate).trim().slice(0, 20) || new Date().toISOString().slice(0, 10);
  const description = str(req.body.description).trim().slice(0, 500);
  const status = ALLOWED_STATUS.has(str(req.body.status)) ? str(req.body.status) : "draft";
  const showRank = req.body.showRank === false ? 0 : 1;
  const subjectsIn = Array.isArray(req.body.subjects) ? req.body.subjects : [];

  if (title.length < 2 || title.length > 100) return res.status(400).json({ error: "考试名称需为 2–100 字" });
  if (!subjectsIn.length || subjectsIn.length > 20) return res.status(400).json({ error: "请至少配置 1 个科目（最多 20 个）" });

  const subjectsClean = [];
  for (let i = 0; i < subjectsIn.length; i++) {
    const s = subjectsIn[i];
    const name = str(s?.name).trim().slice(0, 40);
    if (!name) return res.status(400).json({ error: `第 ${i + 1} 个科目名称不能为空` });
    const fullScore = Math.max(1, Math.min(1000, round1(num(s?.fullScore, 100))));
    const passScore = Math.max(0, Math.min(fullScore, round1(num(s?.passScore, round1(fullScore * 0.6)))));
    const excellentScore = Math.max(passScore, Math.min(fullScore, round1(num(s?.excellentScore, round1(fullScore * 0.85)))));
    const questions = parseQuestions(s?.questions, fullScore);
    subjectsClean.push({ name, fullScore, passScore, excellentScore, questions, sortOrder: i });
  }

  const now = Date.now();
  let examId = 0;
  db.exec("BEGIN");
  try {
    examId = Number(db.prepare(`
      INSERT INTO exams (title, term, exam_date, description, status, show_rank, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(title, term, examDate, description, status, showRank, req.user.id, now, now).lastInsertRowid);

    const insSub = db.prepare(`
      INSERT INTO exam_subjects (exam_id, name, full_score, pass_score, excellent_score, questions_json, sort_order)
      VALUES (?,?,?,?,?,?,?)
    `);
    for (const sc of subjectsClean) {
      insSub.run(examId, sc.name, sc.fullScore, sc.passScore, sc.excellentScore, JSON.stringify(sc.questions), sc.sortOrder);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  const ex = db.prepare("SELECT * FROM exams WHERE id=?").get(examId);
  const subs = db.prepare("SELECT * FROM exam_subjects WHERE exam_id=? ORDER BY sort_order ASC, id ASC").all(examId);
  res.status(201).json({
    exam: {
      id: ex.id, title: ex.title, term: ex.term, examDate: ex.exam_date, description: ex.description,
      status: ex.status, showRank: !!ex.show_rank, subjects: subs.map(subjectDto),
      fullScore: round1(subs.reduce((s, x) => s + x.full_score, 0)),
      createdAt: ex.created_at, updatedAt: ex.updated_at,
    },
  });
});

r.patch("/admin/exams/:examId", (req, res) => {
  const examId = Number(req.params.examId);
  const ex = db.prepare("SELECT * FROM exams WHERE id=?").get(examId);
  if (!ex) return res.status(404).json({ error: "考试不存在" });

  const title = req.body.title !== undefined ? str(req.body.title).trim() : ex.title;
  const term = req.body.term !== undefined ? str(req.body.term).trim().slice(0, 40) : ex.term;
  const examDate = req.body.examDate !== undefined ? str(req.body.examDate).trim().slice(0, 20) : ex.exam_date;
  const description = req.body.description !== undefined ? str(req.body.description).trim().slice(0, 500) : ex.description;
  const status = req.body.status !== undefined
    ? (ALLOWED_STATUS.has(str(req.body.status)) ? str(req.body.status) : ex.status)
    : ex.status;
  const showRank = req.body.showRank !== undefined ? (req.body.showRank ? 1 : 0) : ex.show_rank;

  if (title.length < 2 || title.length > 100) return res.status(400).json({ error: "考试名称需为 2–100 字" });

  let removedFiles = [];
  const now = Date.now();
  db.exec("BEGIN");
  try {
    db.prepare(`
      UPDATE exams SET title=?, term=?, exam_date=?, description=?, status=?, show_rank=?, updated_at=? WHERE id=?
    `).run(title, term, examDate, description, status, showRank, now, examId);

    if (Array.isArray(req.body.subjects)) {
      if (!req.body.subjects.length || req.body.subjects.length > 20) {
        throw new Error("科目数量需在 1–20 之间");
      }
      const existingIds = new Set(db.prepare("SELECT id FROM exam_subjects WHERE exam_id=?").all(examId).map((x) => x.id));
      const keptIds = new Set();

      const updSub = db.prepare(`
        UPDATE exam_subjects SET name=?, full_score=?, pass_score=?, excellent_score=?, questions_json=?, sort_order=?
        WHERE id=? AND exam_id=?
      `);
      const insSub = db.prepare(`
        INSERT INTO exam_subjects (exam_id, name, full_score, pass_score, excellent_score, questions_json, sort_order)
        VALUES (?,?,?,?,?,?,?)
      `);

      req.body.subjects.forEach((s, i) => {
        const name = str(s?.name).trim().slice(0, 40);
        if (!name) throw new Error(`第 ${i + 1} 个科目名称不能为空`);
        const fullScore = Math.max(1, Math.min(1000, round1(num(s?.fullScore, 100))));
        const passScore = Math.max(0, Math.min(fullScore, round1(num(s?.passScore, round1(fullScore * 0.6)))));
        const excellentScore = Math.max(passScore, Math.min(fullScore, round1(num(s?.excellentScore, round1(fullScore * 0.85)))));
        const questions = parseQuestions(s?.questions, fullScore);
        const sid = Number(s?.id);
        if (sid && existingIds.has(sid)) {
          keptIds.add(sid);
          updSub.run(name, fullScore, passScore, excellentScore, JSON.stringify(questions), i, sid, examId);
        } else {
          const newId = Number(insSub.run(examId, name, fullScore, passScore, excellentScore, JSON.stringify(questions), i).lastInsertRowid);
          keptIds.add(newId);
        }
      });

      for (const oldId of existingIds) {
        if (!keptIds.has(oldId)) {
          removedFiles.push(...db.prepare("SELECT file_name FROM exam_paper_pages WHERE subject_id=?").all(oldId));
          db.prepare("DELETE FROM exam_subjects WHERE id=? AND exam_id=?").run(oldId, examId);
        }
      }
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    return res.status(400).json({ error: e.message || "更新考试失败" });
  }

  unlinkPaperFiles(removedFiles);
  const updated = db.prepare("SELECT * FROM exams WHERE id=?").get(examId);
  const subs = db.prepare("SELECT * FROM exam_subjects WHERE exam_id=? ORDER BY sort_order ASC, id ASC").all(examId);
  res.json({
    exam: {
      id: updated.id, title: updated.title, term: updated.term, examDate: updated.exam_date,
      description: updated.description, status: updated.status, showRank: !!updated.show_rank,
      subjects: subs.map(subjectDto),
      fullScore: round1(subs.reduce((s, x) => s + x.full_score, 0)),
      createdAt: updated.created_at, updatedAt: updated.updated_at,
    },
  });
});

r.delete("/admin/exams/:examId", (req, res) => {
  const examId = Number(req.params.examId);
  const ex = db.prepare("SELECT * FROM exams WHERE id=?").get(examId);
  if (!ex) return res.status(404).json({ error: "考试不存在" });

  const paperFiles = db.prepare("SELECT file_name FROM exam_paper_pages WHERE exam_id=?").all(examId);
  db.prepare("DELETE FROM exams WHERE id=?").run(examId);
  unlinkPaperFiles(paperFiles);
  res.json({ ok: true });
});

r.get("/admin/exams/:examId/overview", (req, res) => {
  const examId = Number(req.params.examId);
  const ex = db.prepare("SELECT * FROM exams WHERE id=?").get(examId);
  if (!ex) return res.status(404).json({ error: "考试不存在" });

  const agg = computeExamAggregates(examId);
  const ranking = [...agg.byUser.values()]
    .sort((a, b) => {
      if (a.absentAll !== b.absentAll) return a.absentAll ? 1 : -1;
      if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
      return (a.examNo || "9999").localeCompare(b.examNo || "9999");
    })
    .map((p) => {
      const rate = agg.fullTotal > 0 ? p.totalScore / agg.fullTotal : 0;
      const rk = p.absentAll ? { rank: null, beatPct: 0 } : competitionRank(agg.totalListDesc, p.totalScore);
      return {
        userId: p.userId,
        username: p.username,
        displayName: p.displayName,
        examNo: p.examNo,
        department: p.department,
        totalScore: p.totalScore,
        fullScore: agg.fullTotal,
        rate: round1(rate * 100),
        grade: p.absentAll ? "缺考" : calcGrade(rate),
        rank: rk.rank,
        beatPct: rk.beatPct,
        absent: p.absentAll,
        paperCount: p.paperCount,
        subjectScores: Object.fromEntries(agg.subjects.map((sub) => {
          const r = p.bySubject.get(sub.id);
          return [sub.id, r ? { score: r.score, absent: r.absent, items: r.items, teacherComment: r.teacherComment } : null];
        })),
      };
    });

  const allUsers = db.prepare("SELECT id, username, display_name, exam_no, department FROM users WHERE banned=0 ORDER BY exam_no ASC, id ASC").all();
  const unscoredUsers = allUsers
    .filter((u) => !agg.byUser.has(u.id))
    .map((u) => ({ id: u.id, username: u.username, displayName: u.display_name || "", examNo: u.exam_no || "", department: u.department || "" }));

  res.json({
    exam: {
      id: ex.id, title: ex.title, term: ex.term, examDate: ex.exam_date,
      description: ex.description, status: ex.status, showRank: !!ex.show_rank, fullScore: agg.fullTotal,
    },
    summary: agg.summary,
    subjects: agg.subjects.map((s) => {
      const st = agg.subjectStats.get(s.id);
      return {
        ...subjectDto(s),
        stats: {
          count: st.count, avg: st.avg, max: st.max, min: st.min,
          median: st.median, stdDev: st.stdDev, passRate: st.passRate, excellentRate: st.excellentRate,
        },
      };
    }),
    ranking,
    unscoredUsers,
  });
});

// ---- 成绩提交与批量录分 ----
r.put("/admin/exams/:examId/scores", (req, res) => {
  const examId = Number(req.params.examId);
  const ex = db.prepare("SELECT * FROM exams WHERE id=?").get(examId);
  if (!ex) return res.status(404).json({ error: "考试不存在" });

  const target = resolveUser(req.body.userId, req.body.examNo);
  if (!target) return res.status(404).json({ error: "未找到对应成员，请核对 4 位考号" });

  const subjects = db.prepare("SELECT * FROM exam_subjects WHERE exam_id=?").all(examId);
  const subMap = new Map(subjects.map((s) => [s.id, s]));
  const entries = Array.isArray(req.body.subjects)
    ? req.body.subjects
    : [{ subjectId: req.body.subjectId, score: req.body.score, absent: req.body.absent, items: req.body.items, teacherComment: req.body.teacherComment, useItemsSum: req.body.useItemsSum }];

  if (!entries.length) return res.status(400).json({ error: "缺少科目成绩数据" });

  const saved = [];
  db.exec("BEGIN");
  try {
    for (const item of entries) {
      const sub = subMap.get(Number(item.subjectId));
      if (!sub) throw new Error(`科目 ${item.subjectId} 不属于本场考试`);
      saved.push(normalizeAndSaveScore({ examId, subject: sub, userId: target.id, gradedBy: req.user.id, payload: item }));
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    return res.status(400).json({ error: e.message || "保存成绩失败" });
  }

  res.json({ ok: true, userId: target.id, examNo: target.exam_no || "", saved });
});

r.post("/admin/exams/:examId/scores/batch", (req, res) => {
  const examId = Number(req.params.examId);
  const ex = db.prepare("SELECT * FROM exams WHERE id=?").get(examId);
  if (!ex) return res.status(404).json({ error: "考试不存在" });

  const records = Array.isArray(req.body.records) ? req.body.records : [];
  if (!records.length || records.length > 1000) return res.status(400).json({ error: "批量提交记录需在 1–1000 条之间" });

  const subMap = new Map(db.prepare("SELECT * FROM exam_subjects WHERE exam_id=?").all(examId).map((s) => [s.id, s]));
  let saved = 0;
  const errors = [];

  db.exec("BEGIN");
  try {
    records.forEach((rec, idx) => {
      const target = resolveUser(rec?.userId, rec?.examNo);
      if (!target) { errors.push({ index: idx, error: "未找到考生" }); return; }
      const sub = subMap.get(Number(rec?.subjectId));
      if (!sub) { errors.push({ index: idx, error: "科目不存在" }); return; }
      normalizeAndSaveScore({ examId, subject: sub, userId: target.id, gradedBy: req.user.id, payload: rec });
      saved++;
    });
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    return res.status(400).json({ error: e.message || "批量提交失败" });
  }

  res.json({ ok: true, saved, errors });
});

r.delete("/admin/exams/:examId/scores/:userId", (req, res) => {
  const examId = Number(req.params.examId);
  const userId = Number(req.params.userId);
  db.prepare("DELETE FROM exam_scores WHERE exam_id=? AND user_id=?").run(examId, userId);
  db.prepare("DELETE FROM exam_mistakes WHERE exam_id=? AND user_id=?").run(examId, userId);
  if (req.query.includePapers === "1") {
    const files = db.prepare("SELECT file_name FROM exam_paper_pages WHERE exam_id=? AND user_id=?").all(examId, userId);
    db.prepare("DELETE FROM exam_paper_pages WHERE exam_id=? AND user_id=?").run(examId, userId);
    unlinkPaperFiles(files);
  }
  res.json({ ok: true });
});

// ---- 扫描试卷上传与批改 ----
r.post("/admin/papers", (req, res) => {
  const examId = Number(req.body.examId);
  const subjectId = Number(req.body.subjectId);
  const ex = db.prepare("SELECT * FROM exams WHERE id=?").get(examId);
  if (!ex) return res.status(404).json({ error: "考试不存在" });
  const sub = db.prepare("SELECT * FROM exam_subjects WHERE id=? AND exam_id=?").get(subjectId, examId);
  if (!sub) return res.status(404).json({ error: "科目不存在" });

  const target = resolveUser(req.body.userId, req.body.examNo);
  if (!target) return res.status(404).json({ error: "未找到目标考生" });

  let decoded;
  try {
    decoded = decodeImageDataUrl(req.body.imageData);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const maxPage = db.prepare(
    "SELECT COALESCE(MAX(page_no), 0) m FROM exam_paper_pages WHERE exam_id=? AND subject_id=? AND user_id=?",
  ).get(examId, subjectId, target.id).m;
  const pageNo = Math.max(1, Math.min(99, Math.round(num(req.body.pageNo, maxPage + 1))));
  const width = Math.max(0, Math.min(10000, Math.round(num(req.body.width, 0))));
  const height = Math.max(0, Math.min(10000, Math.round(num(req.body.height, 0))));
  const filterMode = ALLOWED_FILTERS.has(str(req.body.filterMode)) ? str(req.body.filterMode) : "magic";
  const annotations = normalizeAnnotations(req.body.annotations);

  const subDir = `exam_${examId}`;
  const fullSubDir = path.join(EXAM_UPLOAD_DIR, subDir);
  fs.mkdirSync(fullSubDir, { recursive: true });
  const relName = `${subDir}/${crypto.randomUUID()}.${decoded.ext}`;
  fs.writeFileSync(path.join(EXAM_UPLOAD_DIR, relName), decoded.buf);

  const id = Number(db.prepare(`
    INSERT INTO exam_paper_pages (exam_id, subject_id, user_id, page_no, file_name, mime_type, width, height, size_bytes, filter_mode, annotations_json, uploaded_by, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    examId, subjectId, target.id, pageNo, relName, decoded.mime,
    width, height, decoded.buf.length, filterMode, JSON.stringify(annotations), req.user.id, Date.now(),
  ).lastInsertRowid);

  const row = db.prepare("SELECT * FROM exam_paper_pages WHERE id=?").get(id);
  res.status(201).json({ page: paperDto(row) });
});

r.patch("/admin/papers/:pageId", (req, res) => {
  const pageId = Number(req.params.pageId);
  const row = db.prepare("SELECT * FROM exam_paper_pages WHERE id=?").get(pageId);
  if (!row) return res.status(404).json({ error: "试卷页不存在" });

  const pageNo = req.body.pageNo !== undefined ? Math.max(1, Math.min(99, Math.round(num(req.body.pageNo, row.page_no)))) : row.page_no;
  const annotations = req.body.annotations !== undefined
    ? JSON.stringify(normalizeAnnotations(req.body.annotations))
    : row.annotations_json;

  db.prepare("UPDATE exam_paper_pages SET page_no=?, annotations_json=? WHERE id=?").run(pageNo, annotations, pageId);
  res.json({ page: paperDto(db.prepare("SELECT * FROM exam_paper_pages WHERE id=?").get(pageId)) });
});

r.delete("/admin/papers/:pageId", (req, res) => {
  const pageId = Number(req.params.pageId);
  const row = db.prepare("SELECT * FROM exam_paper_pages WHERE id=?").get(pageId);
  if (!row) return res.status(404).json({ error: "试卷页不存在" });

  db.prepare("DELETE FROM exam_paper_pages WHERE id=?").run(pageId);
  unlinkPaperFiles([row]);
  res.json({ ok: true });
});

export default r;
