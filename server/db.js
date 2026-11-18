import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

const dir = process.env.DATA_DIR || path.resolve("data");
mkdirSync(dir, { recursive: true });

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
