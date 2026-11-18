#!/usr/bin/env node
// 注册 / 查看开放平台应用（游戏）。用法：
//   npm run app:create -- --name "我的游戏" --redirect http://localhost:5173/oauth/callback
//   npm run app:create -- --name "服务端游戏" --redirect https://game.example/oauth/callback --secret
//   node scripts/create-app.mjs list
import { parseArgs } from "node:util";
import { db } from "../server/db.js";
import { createClient, getClient } from "../server/oauth.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: "string", short: "n" },
    redirect: { type: "string", short: "r", multiple: true },
    scope: { type: "string", short: "s", default: "profile" },
    homepage: { type: "string" },
    secret: { type: "boolean", default: false },
    list: { type: "boolean", default: false },
  },
});

if (positionals[0] === "list" || values.list) {
  const rows = db.prepare("SELECT * FROM oauth_clients ORDER BY created_at DESC").all();
  if (!rows.length) { console.log("还没有注册任何应用。"); process.exit(0); }
  for (const c of rows) {
    console.log(`${c.id}  ${c.name}${c.secret_hash ? "  [机密客户端]" : "  [公共客户端 · PKCE]"}${c.disabled ? "  [已停用]" : ""}`);
    console.log(`  回调: ${JSON.parse(c.redirect_uris).join(", ")}`);
    console.log(`  scope: ${c.scopes}  homepage: ${c.homepage || "-"}  创建: ${new Date(c.created_at).toISOString()}`);
  }
  process.exit(0);
}

const name = (values.name || "").trim();
const redirects = (values.redirect || []).map((s) => s.trim()).filter(Boolean);
const scopes = String(values.scope || "profile").split(/[\s,]+/).filter(Boolean);
const bad = scopes.filter((s) => !["profile", "email"].includes(s));

if (!name || name.length > 60) { console.error("缺少 --name（1–60 字符）"); process.exit(1); }
if (!redirects.length) { console.error("缺少 --redirect，例如 --redirect http://localhost:5173/oauth/callback"); process.exit(1); }
for (const u of redirects) {
  let ok = false;
  try {
    const url = new URL(u);
    ok = !url.hash && (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)));
  } catch { /* 非法 URL */ }
  if (!ok) { console.error(`回调地址不合法：${u}（必须是 https，或本机 http://localhost）`); process.exit(1); }
}
if (bad.length) { console.error(`不支持的 scope：${bad.join(" ")}（可选 profile、email）`); process.exit(1); }

const out = createClient({ name, redirectUris: redirects, scopes, homepage: values.homepage || "", confidential: values.secret });

const app = getClient(out.id);
console.log(`\n应用已创建：${name}`);
console.log(`  client_id      ${app.id}`);
if (out.secret) console.log(`  client_secret  ${out.secret}   ← 只显示这一次，请立即保存到服务端环境变量`);
else console.log("  类型           公共客户端（无 client_secret，必须用 PKCE）");
console.log(`  redirect_uris  ${redirects.join(", ")}`);
console.log(`  scope          ${app.scopes}`);
console.log(`\n授权入口示例：`);
const params = new URLSearchParams({
  response_type: "code", client_id: app.id, redirect_uri: redirects[0],
  scope: app.scopes, state: "STATE", code_challenge: "CHALLENGE", code_challenge_method: "S256",
});
console.log(`  https://goutoustdio.top/oauth/authorize?${params.toString()}`);
console.log("");
