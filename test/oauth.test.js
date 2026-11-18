// OAuth 2.0 授权码 + PKCE 的端到端测试：注册用户 → 授权 → 换令牌 → userinfo → 刷新轮换。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "gs-test-"));
process.env.NODE_ENV = "test";
process.env.SITE_URL = "http://127.0.0.1";

const { app } = await import("../server/index.js");
const { createClient } = await import("../server/oauth.js");

let server, base, client, cookie;

const verifier = crypto.randomBytes(48).toString("base64url");
const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
const REDIRECT = "http://localhost:9999/cb";

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  client = createClient({ name: "测试游戏", redirectUris: [REDIRECT], scopes: ["profile", "email"] });
});

after(() => server.close());

test("注册测试用户", async () => {
  const r = await fetch(`${base}/api/register`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ username: "tester", email: "tester@example.com", password: "password123" }),
  });
  assert.equal(r.status, 201);
  cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  assert.match(cookie, /gs_session=/);
});

function authQuery(extra = {}) {
  return new URLSearchParams({
    response_type: "code", client_id: client.id, redirect_uri: REDIRECT, scope: "profile email",
    state: "state-123", code_challenge: challenge, code_challenge_method: "S256", ...extra,
  });
}

test("授权页需要登录，并显示应用与 scope", async () => {
  const anon = await fetch(`${base}/oauth/authorize?${authQuery()}`, { redirect: "manual" });
  assert.equal(anon.status, 302);
  assert.match(anon.headers.get("location"), /^\/login\?next=/);

  const r = await fetch(`${base}/oauth/authorize?${authQuery()}`, { headers: { cookie } });
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /测试游戏/);
  assert.match(html, /邮箱/);
});

test("拒绝回调地址不一致的请求", async () => {
  const q = authQuery({ redirect_uri: "http://evil.example/cb" });
  const r = await fetch(`${base}/oauth/authorize?${q}`, { headers: { cookie } });
  assert.equal(r.status, 400);
});

test("同意授权 → 换令牌 → 读取用户信息", async () => {
  const form = authQuery();
  form.set("decision", "allow");
  const r = await fetch(`${base}/oauth/authorize`, {
    method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: form, redirect: "manual",
  });
  assert.equal(r.status, 302);
  const loc = new URL(r.headers.get("location"));
  assert.equal(loc.searchParams.get("state"), "state-123");
  const code = loc.searchParams.get("code");
  assert.ok(code);

  const tr = await fetch(`${base}/oauth/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: client.id, code_verifier: verifier }),
  });
  assert.equal(tr.status, 200);
  const tok = await tr.json();
  assert.equal(tok.token_type, "Bearer");
  assert.equal(tok.expires_in, 7200);
  assert.ok(tok.refresh_token);

  const ur = await fetch(`${base}/oauth/userinfo`, { headers: { authorization: `Bearer ${tok.access_token}` } });
  assert.equal(ur.status, 200);
  const user = await ur.json();
  assert.equal(user.username, "tester");
  assert.equal(user.email, "tester@example.com");
  assert.equal(typeof user.sub, "string");

  // 授权码一次性
  const again = await fetch(`${base}/oauth/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: client.id, code_verifier: verifier }),
  });
  assert.equal(again.status, 400);
  assert.equal((await again.json()).error, "invalid_grant");
});

test("错误的 code_verifier 被拒绝", async () => {
  const form = authQuery({ state: "s2", prompt: "consent" });
  form.set("decision", "allow");
  const r = await fetch(`${base}/oauth/authorize`, {
    method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: form, redirect: "manual",
  });
  const code = new URL(r.headers.get("location"), base).searchParams.get("code");
  const tr = await fetch(`${base}/oauth/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: client.id, code_verifier: "x".repeat(43) }),
  });
  assert.equal(tr.status, 400);
  assert.equal((await tr.json()).error, "invalid_grant");
});

test("refresh token 轮换：旧的立即失效", async () => {
  const form = authQuery({ state: "s3" });
  form.set("decision", "allow");
  const r = await fetch(`${base}/oauth/authorize`, {
    method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: form, redirect: "manual",
  });
  const code = new URL(r.headers.get("location"), base).searchParams.get("code");
  const tok = await (await fetch(`${base}/oauth/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: client.id, code_verifier: verifier }),
  })).json();

  const r1 = await fetch(`${base}/oauth/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: client.id }),
  });
  assert.equal(r1.status, 200);
  const tok2 = await r1.json();
  assert.notEqual(tok2.refresh_token, tok.refresh_token);

  const r2 = await fetch(`${base}/oauth/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: client.id }),
  });
  assert.equal(r2.status, 400);
});

test("文档页与发现端点可访问", async () => {
  for (const p of ["", "oauth", "tokens", "recharge", "webhooks", "errors", "example"]) {
    const r = await fetch(`${base}/docs${p ? "/" + p : ""}`);
    assert.equal(r.status, 200, `/docs/${p}`);
  }
  const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.equal(meta.issuer, "http://127.0.0.1");
  assert.deepEqual(meta.code_challenge_methods_supported, ["S256"]);
});
