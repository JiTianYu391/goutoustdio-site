// 开放平台：OAuth 2.0 授权码 + PKCE（RFC 6749 / 7636 / 8414），给第三方游戏接入 GoutouStdio 账号用。
// 设计参照 GitHub OAuth Apps 与 OAuth 2.1 草案：公共客户端必须 PKCE，授权码一次性、10 分钟过期，
// access token 2 小时、refresh token 30 天且每次刷新都轮换。
import crypto from "node:crypto";
import express, { Router } from "express";
import rateLimit from "express-rate-limit";
import { db } from "./db.js";
import * as A from "./auth.js";
import { getUser, publicUser, str } from "./util.js";

const sha = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");
const rid = (n) => crypto.randomBytes(n).toString("base64url");
const now = () => Date.now();

export const ACCESS_TTL = 2 * 3600 * 1000;
export const REFRESH_TTL = 30 * 24 * 3600 * 1000;
const CODE_TTL = 10 * 60 * 1000;
export const SCOPES = {
  profile: "读取你的公开资料（用户名、昵称、简介、注册时间）",
  email: "读取你的邮箱与验证状态",
};

const tokenLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false,
  message: { error: "slow_down", error_description: "请求过于频繁，请稍后再试" } });

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- 客户端 ----------
export function getClient(id) {
  const c = db.prepare("SELECT * FROM oauth_clients WHERE id=?").get(String(id || ""));
  if (!c) return null;
  let redirectUris = [];
  try { redirectUris = JSON.parse(c.redirect_uris); } catch { /* 坏数据按无回调处理 */ }
  return { ...c, redirectUris: Array.isArray(redirectUris) ? redirectUris : [] };
}
export function createClient({ name, redirectUris, scopes, homepage, confidential = false, ownerUserId = null }) {
  const id = "gs_app_" + crypto.randomBytes(8).toString("hex");
  const secret = confidential ? "gs_sk_" + rid(32) : null;
  db.prepare("INSERT INTO oauth_clients (id, secret_hash, name, homepage, redirect_uris, scopes, created_at, owner_user_id) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, secret ? sha(secret) : null, name, homepage || "", JSON.stringify(redirectUris),
      normalizeScope(scopes.join(" ")), now(), ownerUserId);
  return { id, secret, name, redirectUris };
}

export function normalizeScope(input) {
  const asked = String(input || "").split(/\s+/).filter(Boolean);
  const out = asked.filter((s) => Object.hasOwn(SCOPES, s));
  return (out.length ? out : ["profile"]).join(" ");
}
const scopeCovers = (granted, wanted) => {
  const g = new Set(String(granted).split(/\s+/).filter(Boolean));
  return String(wanted).split(/\s+/).filter(Boolean).every((s) => g.has(s));
};

function verifySecret(client, secret) {
  if (!client.secret_hash || !secret) return false;
  const a = Buffer.from(sha(secret)), b = Buffer.from(client.secret_hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- 令牌 ----------
function issueTokens(client, userId, scope) {
  const access = "gs_at_" + rid(32);
  const refresh = "gs_rt_" + rid(32);
  db.prepare(`INSERT INTO oauth_tokens (id, client_id, user_id, scope, refresh_hash, expires_at, refresh_expires_at, created_at)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(sha(access), client.id, userId, scope, sha(refresh), now() + ACCESS_TTL, now() + REFRESH_TTL, now());
  return {
    access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL / 1000,
    refresh_token: refresh, scope,
  };
}
const tokenRow = (token) => db.prepare("SELECT * FROM oauth_tokens WHERE id=?").get(sha(token));

function bearer(req) {
  const h = req.get("authorization") || "";
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1] : "";
}

function issueCode(req, client, userId, scope, challenge) {
  const code = rid(32);
  db.prepare("INSERT INTO oauth_codes (id, client_id, user_id, redirect_uri, scope, code_challenge, expires_at) VALUES (?,?,?,?,?,?,?)")
    .run(sha(code), client.id, userId, req.redirectUri, scope, challenge, now() + CODE_TTL);
  return code;
}

function redirectWith(res, uri, params) {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, v);
  res.redirect(302, u.toString());
}

// ---------- 授权页 ----------
function pageShell(title, body, { user } = {}) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;
  font:15px/1.7 Inter,system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
  background:radial-gradient(900px 500px at 15% 0%,#1d1a45 0%,#0a0c13 55%,#05060a 100%);color:#e8eaf2}
.card{width:100%;max-width:420px;background:rgba(16,18,28,.86);border:1px solid rgba(255,255,255,.09);
  border-radius:18px;padding:28px 24px;box-shadow:0 24px 60px rgba(0,0,0,.45)}
h1{margin:0 0 6px;font-size:19px;letter-spacing:-.01em}
p{margin:10px 0;color:#a9b0c3}
b{color:#e8eaf2}
.scopes{margin:16px 0 4px;padding:0;list-style:none}
.scopes li{display:flex;gap:10px;padding:9px 0;border-top:1px solid rgba(255,255,255,.07);font-size:14px;color:#c9cede}
.scopes li:first-child{border-top:0}
.check{color:#34d399;flex:none}
.who{display:flex;align-items:center;gap:10px;margin:16px 0;padding:10px 12px;border-radius:12px;background:rgba(124,108,255,.1);
  border:1px solid rgba(124,108,255,.25);font-size:14px}
.avatar{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;font-size:12px;font-weight:600;
  background:linear-gradient(135deg,#7c6cff,#22d3ee);color:#05060a;flex:none}
.actions{display:flex;gap:10px;margin-top:20px}
button{flex:1;padding:11px 14px;border-radius:11px;border:1px solid transparent;font:inherit;font-weight:600;cursor:pointer}
.ok{background:linear-gradient(135deg,#7c6cff,#5b7bff);color:#fff}
.no{background:transparent;border-color:rgba(255,255,255,.16);color:#c9cede}
.foot{margin-top:16px;font-size:12px;color:#7f879b;text-align:center}
a{color:#8f83ff}
.err{color:#ffb4b4}
</style></head><body><div class="card">${body}</div></body></html>`;
}

function errorPage(res, status, title, detail) {
  res.status(status).type("html").send(pageShell(title, `<h1>${esc(title)}</h1><p class="err">${esc(detail)}</p>`));
}

// ? 组装本次授权请求
function readAuthorize(req) {
  const src = req.method === "POST" ? req.body : req.query;
  return {
    clientId: str(src.client_id),
    redirectUri: str(src.redirect_uri),
    responseType: str(src.response_type),
    scope: normalizeScope(str(src.scope) || "profile"),
    state: str(src.state),
    challenge: str(src.code_challenge),
    method: str(src.code_challenge_method) || "S256",
    prompt: str(src.prompt),
  };
}

function validChallenge(c) {
  return /^[A-Za-z0-9_-]{43,128}$/.test(c);
}

const r = Router();

r.get("/authorize", (req, res) => {
  const a = readAuthorize(req);
  const client = getClient(a.clientId);
  if (!client || client.disabled) return errorPage(res, 400, "无效的应用", "client_id 不存在或应用已被停用。");
  if (!client.redirectUris.includes(a.redirectUri))
    return errorPage(res, 400, "回调地址不匹配", "redirect_uri 必须与应用登记的回调地址完全一致。");
  if (!scopeCovers(client.scopes, a.scope))
    return redirectWith(res, a.redirectUri, { error: "invalid_scope", error_description: "请求的 scope 超出了应用登记的范围", state: a.state });
  if (a.responseType !== "code") return redirectWith(res, a.redirectUri, { error: "unsupported_response_type", state: a.state });
  if (!a.challenge || !validChallenge(a.challenge) || a.method !== "S256")
    return redirectWith(res, a.redirectUri, { error: "invalid_request", error_description: "必须使用 PKCE（code_challenge_method=S256）", state: a.state });

  if (!req.user) {
    // 登录后回到这里继续授权；比在授权页里塞登录表单更安全，也不用把密码交给第三方页面
    return res.redirect(302, "/login?next=" + encodeURIComponent(req.originalUrl));
  }

  const consent = db.prepare("SELECT * FROM oauth_consents WHERE user_id=? AND client_id=?").get(req.user.id, client.id);
  const force = a.prompt === "consent" || a.prompt === "login";
  if (consent && scopeCovers(consent.scope, a.scope) && !force) {
    const code = issueCode({ ...a }, client, req.user.id, a.scope, a.challenge);
    return redirectWith(res, a.redirectUri, { code, state: a.state });
  }

  const u = getUser(req.user.id);
  const scopeItems = a.scope.split(" ").map((s) => `<li><span class="check">✓</span><span>${esc(SCOPES[s])}</span></li>`).join("");
  const fields = { client_id: a.clientId, redirect_uri: a.redirectUri, scope: a.scope, state: a.state,
    code_challenge: a.challenge, code_challenge_method: a.method };
  const hidden = Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`).join("");
  const body = `
    <h1>使用 GoutouStdio 账号继续</h1>
    <p><b>${esc(client.name)}</b> 请求访问你的账号。</p>
    <div class="who"><span class="avatar">${esc((u.username || "?")[0].toUpperCase())}</span><span>当前登录：<b>@${esc(u.username)}</b></span></div>
    <p style="margin-bottom:4px">它将获得：</p>
    <ul class="scopes">${scopeItems}</ul>
    <form method="post" action="/oauth/authorize">${hidden}
      <div class="actions">
        <button class="no" name="decision" value="deny" formnovalidate>取消</button>
        <button class="ok" name="decision" value="allow">允许</button>
      </div>
    </form>
    <p class="foot">不是你认识的应用？<a href="/account#security">管理授权</a> · <a href="/account">账号设置</a></p>`;
  res.status(200).type("html").send(pageShell("授权 " + client.name, body));
});

r.post("/authorize", express.urlencoded({ extended: false, limit: "16kb" }), (req, res) => {
  const a = readAuthorize(req);
  const client = getClient(a.clientId);
  if (!client || client.disabled) return errorPage(res, 400, "无效的应用", "client_id 不存在或应用已被停用。");
  if (!client.redirectUris.includes(a.redirectUri))
    return errorPage(res, 400, "回调地址不匹配", "redirect_uri 必须与应用登记的回调地址完全一致。");
  if (!scopeCovers(client.scopes, a.scope))
    return redirectWith(res, a.redirectUri, { error: "invalid_scope", error_description: "请求的 scope 超出了应用登记的范围", state: a.state });
  if (!req.user) return res.redirect(302, "/login?next=" + encodeURIComponent("/oauth/authorize"));
  if (!a.challenge || !validChallenge(a.challenge) || a.method !== "S256")
    return redirectWith(res, a.redirectUri, { error: "invalid_request", state: a.state });

  if (str(req.body.decision) !== "allow") return redirectWith(res, a.redirectUri, { error: "access_denied", state: a.state });

  db.prepare(`INSERT INTO oauth_consents (user_id, client_id, scope, updated_at) VALUES (?,?,?,?)
    ON CONFLICT(user_id, client_id) DO UPDATE SET scope=excluded.scope, updated_at=excluded.updated_at`)
    .run(req.user.id, client.id, a.scope, now());
  const code = issueCode(a, client, req.user.id, a.scope, a.challenge);
  redirectWith(res, a.redirectUri, { code, state: a.state });
});

// ---------- 令牌端点 ----------
r.post("/token", tokenLimit, express.urlencoded({ extended: false, limit: "16kb" }), express.json({ limit: "16kb" }), (req, res) => {
  const body = req.body || {};
  let clientId = str(body.client_id), secret = str(body.client_secret);
  const basic = /^Basic\s+(.+)$/i.exec(req.get("authorization") || "");
  if (basic) {
    const [id, s] = Buffer.from(basic[1], "base64").toString("utf8").split(":");
    clientId = id; secret = s || "";
  }
  const client = getClient(clientId);
  const fail = (status, error, desc) => {
    if (status === 401) res.set("WWW-Authenticate", 'Basic realm="oauth"');
    res.status(status).json({ error, error_description: desc });
  };
  if (!client || client.disabled) return fail(401, "invalid_client", "应用不存在或已被停用");
  if (client.secret_hash && !verifySecret(client, secret)) return fail(401, "invalid_client", "client_secret 不正确");

  const grant = str(body.grant_type);
  if (grant === "authorization_code") {
    const code = str(body.code);
    const row = db.prepare("SELECT * FROM oauth_codes WHERE id=?").get(sha(code));
    if (!row || row.used || row.expires_at < now()) return fail(400, "invalid_grant", "授权码无效或已过期");
    if (row.client_id !== client.id) return fail(400, "invalid_grant", "授权码不属于该应用");
    if (str(body.redirect_uri) !== row.redirect_uri) return fail(400, "invalid_grant", "redirect_uri 与授权时不一致");
    const verifier = str(body.code_verifier);
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || sha256b64url(verifier) !== row.code_challenge)
      return fail(400, "invalid_grant", "code_verifier 校验失败");
    const used = db.prepare("UPDATE oauth_codes SET used=1 WHERE id=? AND used=0").run(sha(code));
    if (!used.changes) return fail(400, "invalid_grant", "授权码已被使用");
    const tok = issueTokens(client, row.user_id, row.scope);
    return res.json(tok);
  }
  if (grant === "refresh_token") {
    const token = str(body.refresh_token);
    const row = db.prepare("SELECT * FROM oauth_tokens WHERE refresh_hash=?").get(sha(token));
    if (!row || row.refresh_expires_at < now()) return fail(400, "invalid_grant", "refresh_token 无效或已过期");
    // 轮换：旧的一对令牌立即作废
    db.prepare("DELETE FROM oauth_tokens WHERE id=?").run(row.id);
    const tok = issueTokens(client, row.user_id, row.scope);
    return res.json(tok);
  }
  return fail(400, "unsupported_grant_type", "仅支持 authorization_code 与 refresh_token");
});

const sha256b64url = (s) => crypto.createHash("sha256").update(s).digest("base64url");

// ---------- 用户信息 / 撤销 ----------
function cors(res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}
r.options(["/token", "/userinfo", "/revoke"], (_req, res) => { cors(res); res.status(204).end(); });

r.get("/userinfo", (req, res) => {
  cors(res);
  res.set("Cache-Control", "no-store");
  const t = bearer(req);
  const row = t && tokenRow(t);
  if (!row || row.expires_at < now()) {
    res.set("WWW-Authenticate", 'Bearer error="invalid_token"');
    return res.status(401).json({ error: "invalid_token", error_description: "access_token 无效或已过期" });
  }
  const u = getUser(row.user_id);
  if (!u || u.banned) {
    res.set("WWW-Authenticate", 'Bearer error="invalid_token"');
    return res.status(401).json({ error: "invalid_token", error_description: "账号不可用" });
  }
  const pub = publicUser(u);
  const claims = {
    sub: String(u.id), username: pub.username, display_name: pub.displayName, bio: pub.bio,
    profile_url: `/u/${encodeURIComponent(u.username)}`, admin: pub.admin, created_at: u.created_at,
  };
  if (row.scope.split(" ").includes("email")) { claims.email = u.email; claims.email_verified = !!u.email_verified; }
  res.json(claims);
});

r.post("/revoke", tokenLimit, express.urlencoded({ extended: false }), express.json(), (req, res) => {
  cors(res);
  const body = req.body || {};
  let clientId = str(body.client_id), secret = str(body.client_secret);
  const basic = /^Basic\s+(.+)$/i.exec(req.get("authorization") || "");
  if (basic) { const [id, s] = Buffer.from(basic[1], "base64").toString("utf8").split(":"); clientId = id; secret = s || ""; }
  const client = getClient(clientId);
  // RFC 7009：无论令牌是否存在都返回 200，避免探测
  if (client && (!client.secret_hash || verifySecret(client, secret))) {
    const t = str(body.token);
    db.prepare("DELETE FROM oauth_tokens WHERE id=? AND client_id=?").run(sha(t), client.id);
    db.prepare("DELETE FROM oauth_tokens WHERE refresh_hash=? AND client_id=?").run(sha(t), client.id);
  }
  res.status(200).json({ ok: true });
});

export function oauthCleanup() {
  db.prepare("DELETE FROM oauth_codes WHERE expires_at < ?").run(now() - 24 * 3600 * 1000);
  db.prepare("DELETE FROM oauth_tokens WHERE expires_at < ? AND refresh_expires_at < ?").run(now(), now());
}

export default r;
