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
