import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

const dir = process.env.DATA_DIR || path.resolve("data");
mkdirSync(dir, { recursive: true });
export const DATA_DIR = dir;
export const EXAM_UPLOAD_DIR = path.join(dir, "exam_uploads");
mkdirSync(EXAM_UPLOAD_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(dir, "site.db"));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    email_verified INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,            -- sha256(token)
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS email_tokens (
    id TEXT PRIMARY KEY,            -- sha256(token)
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,             -- verify | reset
    expires_at INTEGER NOT NULL
  );
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY,
    page TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_comments_page ON comments(page, id);
`);
// 旧库升级：缺哪列补哪列
const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
const add = (t, c, def) => { if (!cols(t).includes(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); };
add("users", "display_name", "TEXT NOT NULL DEFAULT ''");
add("users", "bio", "TEXT NOT NULL DEFAULT ''");
add("sessions", "created_at", "INTEGER NOT NULL DEFAULT 0");
add("sessions", "last_seen", "INTEGER NOT NULL DEFAULT 0");
add("sessions", "ua", "TEXT NOT NULL DEFAULT ''");
add("sessions", "ip", "TEXT NOT NULL DEFAULT ''");

// ---- v3：两步验证 / Passkey / 订阅 / 评论回复与点赞 / 工单 / 封禁 ----
add("users", "banned", "INTEGER NOT NULL DEFAULT 0");
add("users", "ban_reason", "TEXT NOT NULL DEFAULT ''");
add("users", "totp_secret", "TEXT");
add("users", "totp_pending", "TEXT");
add("users", "totp_last_step", "INTEGER NOT NULL DEFAULT 0");
add("sessions", "sudo_until", "INTEGER NOT NULL DEFAULT 0");
add("comments", "parent_id", "INTEGER REFERENCES comments(id) ON DELETE CASCADE");
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS recovery_codes (
    id TEXT PRIMARY KEY,                -- sha256(code)
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS passkeys (
    id TEXT PRIMARY KEY,                -- credential id (base64url)
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    public_key BLOB NOT NULL,
    counter INTEGER NOT NULL DEFAULT 0,
    transports TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    last_used INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS mfa_pending (
    id TEXT PRIMARY KEY,                -- sha256(token)
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    attempts INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS subscriptions (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    topic TEXT NOT NULL,
    PRIMARY KEY (user_id, topic)
  );
  CREATE TABLE IF NOT EXISTS comment_likes (
    comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (comment_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    category TEXT NOT NULL,             -- bug | feature | question | other
    status TEXT NOT NULL DEFAULT 'open',-- open | in_progress | resolved | closed
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ticket_messages (
    id INTEGER PRIMARY KEY,
    ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    staff INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ticket_msgs ON ticket_messages(ticket_id, id);
  CREATE TABLE IF NOT EXISTS broadcasts (
    id INTEGER PRIMARY KEY,
    topic TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    link TEXT NOT NULL DEFAULT '',
    recipients INTEGER NOT NULL DEFAULT 0,
    sent INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER,
    created_at INTEGER NOT NULL
  );
`);

// ---- 开放平台：第三方应用（游戏）用 OAuth 2.0 接入账号 ----
db.exec(`
  CREATE TABLE IF NOT EXISTS oauth_clients (
    id TEXT PRIMARY KEY,              -- client_id，如 gs_app_xxxxxxxx
    secret_hash TEXT,                 -- null = 公共客户端（只能 PKCE，无密钥）
    name TEXT NOT NULL,
    homepage TEXT NOT NULL DEFAULT '',
    redirect_uris TEXT NOT NULL,      -- JSON 数组，精确匹配
    scopes TEXT NOT NULL DEFAULT 'profile',
    created_at INTEGER NOT NULL,
    owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    disabled INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS oauth_codes (
    id TEXT PRIMARY KEY,              -- sha256(code)
    client_id TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    redirect_uri TEXT NOT NULL,
    scope TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS oauth_tokens (
    id TEXT PRIMARY KEY,              -- sha256(access_token)
    client_id TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scope TEXT NOT NULL,
    refresh_hash TEXT,                -- sha256(refresh_token)，未签发为 null
    refresh_used INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL,
    refresh_expires_at INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS oauth_consents (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, client_id)
  );
  CREATE INDEX IF NOT EXISTS idx_oauth_tokens_refresh ON oauth_tokens(refresh_hash);
  CREATE INDEX IF NOT EXISTS idx_oauth_codes_client ON oauth_codes(client_id, user_id);
`);

// ---- 员工内部考试系统（智考中心 /exam）：4 位考号、考试、成绩、扫描试卷、错题本 ----
add("users", "exam_no", "TEXT");
add("users", "department", "TEXT NOT NULL DEFAULT ''");
add("users", "admin_manual", "INTEGER NOT NULL DEFAULT 0");
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_exam_no ON users(exam_no) WHERE exam_no IS NOT NULL AND exam_no <> '';
  CREATE TABLE IF NOT EXISTS exams (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    term TEXT NOT NULL DEFAULT '',
    exam_date TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft',    -- draft | published
    show_rank INTEGER NOT NULL DEFAULT 1,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS exam_subjects (
    id INTEGER PRIMARY KEY,
    exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    full_score REAL NOT NULL DEFAULT 100,
    pass_score REAL NOT NULL DEFAULT 60,
    excellent_score REAL NOT NULL DEFAULT 85,
    questions_json TEXT NOT NULL DEFAULT '[]',
    sort_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_exam_subjects_exam ON exam_subjects(exam_id, sort_order, id);
  CREATE TABLE IF NOT EXISTS exam_scores (
    id INTEGER PRIMARY KEY,
    exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    subject_id INTEGER NOT NULL REFERENCES exam_subjects(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    score REAL NOT NULL DEFAULT 0,
    absent INTEGER NOT NULL DEFAULT 0,
    item_scores_json TEXT NOT NULL DEFAULT '[]',
    teacher_comment TEXT NOT NULL DEFAULT '',
    graded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (exam_id, subject_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_exam_scores_exam ON exam_scores(exam_id, subject_id);
  CREATE INDEX IF NOT EXISTS idx_exam_scores_user ON exam_scores(user_id, exam_id);
  CREATE TABLE IF NOT EXISTS exam_paper_pages (
    id INTEGER PRIMARY KEY,
    exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    subject_id INTEGER NOT NULL REFERENCES exam_subjects(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    page_no INTEGER NOT NULL DEFAULT 1,
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL DEFAULT 'image/jpeg',
    width INTEGER NOT NULL DEFAULT 0,
    height INTEGER NOT NULL DEFAULT 0,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    filter_mode TEXT NOT NULL DEFAULT 'magic',
    annotations_json TEXT NOT NULL DEFAULT '[]',
    uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_exam_papers_lookup ON exam_paper_pages(exam_id, subject_id, user_id, page_no);
  CREATE TABLE IF NOT EXISTS exam_mistakes (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    subject_id INTEGER NOT NULL REFERENCES exam_subjects(id) ON DELETE CASCADE,
    question_no TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    tag TEXT NOT NULL DEFAULT '',
    full_score REAL NOT NULL DEFAULT 0,
    got_score REAL NOT NULL DEFAULT 0,
    answer TEXT NOT NULL DEFAULT '',
    reflection TEXT NOT NULL DEFAULT '',
    mastered INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    UNIQUE (user_id, exam_id, subject_id, question_no)
  );
  CREATE INDEX IF NOT EXISTS idx_exam_mistakes_user ON exam_mistakes(user_id, mastered, updated_at);
`);

// 站点级随机密钥（退订链接签名用），首次启动生成并持久化
export function siteSecret() {
  let row = db.prepare("SELECT value FROM settings WHERE key='secret'").get();
  if (!row) {
    const v = (globalThis.crypto.getRandomValues(new Uint8Array(32))).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");
    db.prepare("INSERT INTO settings (key,value) VALUES ('secret',?)").run(v);
    row = { value: v };
  }
  return row.value;
}
