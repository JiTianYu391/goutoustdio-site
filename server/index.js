import express from "express";
import serveIndex from "serve-index";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { db } from "./db.js";
import * as A from "./auth.js";
import { syncAdmin, base } from "./util.js";
import authRoutes from "./routes/auth.js";
import mfaRoutes from "./routes/mfa.js";
import accountRoutes from "./routes/account.js";
import commentRoutes from "./routes/comments.js";
import ticketRoutes from "./routes/tickets.js";
import adminRoutes from "./routes/admin.js";
import examRoutes from "./routes/exam.js";
import oauthRoutes, { oauthCleanup, SCOPES } from "./oauth.js";

const app = express();
const PORT = Number(process.env.PORT) || 8080;
const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const webauthnBundle = path.join(pub, "..", "node_modules", "@simplewebauthn", "browser", "dist", "bundle", "index.umd.min.js");
const repoDir = process.env.SPK_REPO_DIR || "/data/spaceos/repo";

app.set("trust proxy", 1); // FadeHost 反代
app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      // Cloudflare 会自动注入 Web Analytics 脚本（含一段内联初始化），这里放行它和截图所在的 raw.githubusercontent.com
      "script-src": ["'self'", "https://static.cloudflareinsights.com", "'sha256-f3hdOU1QscqxHyyMkQCCyaLeNK4GEvqsgMC25eSfQ+k='"],
      "connect-src": ["'self'", "https://cloudflareinsights.com"],
      "img-src": ["'self'", "data:", "blob:", "https://raw.githubusercontent.com"],
      "upgrade-insecure-requests": null,
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use("/api", (_req, res, next) => { res.set("Cache-Control", "no-store"); res.set("Vary", "Cookie"); next(); });
app.use(cookieParser());
const jsonSmall = express.json({ limit: "64kb" });
const jsonMedium = express.json({ limit: "512kb" });
const jsonUpload = express.json({ limit: "35mb" });
app.use("/api", (req, res, next) => {
  if ((req.path === "/exam/admin/papers" || req.path === "/exam/admin/parse-doc" || req.path === "/exam/admin/parse-photos") && req.method === "POST") {
    return jsonUpload(req, res, next);
  }
  if (/^\/exam\/admin\//.test(req.path) && ["POST", "PATCH", "PUT"].includes(req.method)) {
    return jsonMedium(req, res, next);
  }
  return jsonSmall(req, res, next);
});

// CSRF：SameSite=Lax + 写请求校验 Origin 与 Host 一致。退订链接自带签名，邮件客户端的一键退订没有 Origin，放行
app.use("/api", (req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method) || req.path === "/unsubscribe") return next();
  const o = req.get("origin");
  try { if (o && new URL(o).host === req.get("host")) return next(); } catch { /* 非法 Origin */ }
  res.status(403).json({ error: "forbidden origin" });
});

app.use((req, _res, next) => { req.user = A.sessionUser(req.cookies[A.COOKIE]); next(); });

db.prepare("SELECT id FROM users").all().forEach((r) => syncAdmin(r.id)); // 启动时按 ADMIN_EMAIL 全量同步

app.use("/api", authRoutes, mfaRoutes, accountRoutes, commentRoutes, ticketRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/exam", examRoutes);
app.use("/api", (_req, res) => res.status(404).json({ error: "not found" }));

// ---------- 开放平台：OAuth 2.0 端点 ----------
app.use("/oauth", (_req, res, next) => { res.set("Cache-Control", "no-store"); res.set("X-Frame-Options", "DENY"); next(); });
app.use("/oauth", oauthRoutes);
app.get("/.well-known/oauth-authorization-server", (req, res) => {
  const origin = base(req);
  res.json({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    userinfo_endpoint: `${origin}/oauth/userinfo`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    scopes_supported: Object.keys(SCOPES),
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
  });
});

// 浏览器端 WebAuthn 库直接取自 node_modules，版本与服务端一致
app.get("/vendor/webauthn.js", (_req, res) =>
  res.type("js").sendFile(webauthnBundle));

// 开放平台文档 /docs（无构建步骤，页面在 public/docs/）
const DOC_PAGES = new Set(["index", "oauth", "tokens", "recharge", "webhooks", "errors", "example"]);
app.get("/docs", (_req, res) => res.sendFile(path.join(pub, "docs", "index.html")));
app.get("/docs/:page", (req, res, next) => {
  const page = req.params.page.replace(/\.html$/, "");
  if (!DOC_PAGES.has(page)) return next();
  res.sendFile(path.join(pub, "docs", `${page}.html`));
});

const page = (file) => (_req, res) => res.sendFile(path.join(pub, file));
for (const p of ["login", "register", "account", "verify", "forgot", "reset", "admin"]) app.get(`/${p}`, page(`${p}.html`));
app.get(["/exam", "/exam/:tab"], page("exam.html"));
app.get(["/support", "/support/:id"], page("support.html"));
app.get("/u/:username", page("user.html"));
// ---------- SpaceOS 包仓库：持久盘上的静态文件 ----------
// /data 是 FadeHost 的持久盘，redeploy 不会清空；包文件不提交进 Git。
app.use("/spaceos/repo", express.static(repoDir, {
  index: false,
  dotfiles: "deny",
  redirect: false,
  etag: true,
  lastModified: true,
  setHeaders(res, filePath) {
    const name = path.basename(filePath);
    const relative = path.relative(repoDir, filePath).split(path.sep).join("/");
    // <arch>/pkg/... and <arch>/previews/... live below the repository root.
    const segments = relative.split("/");
    // Only .spk files are truly immutable: the version is part of the file
    // name and a published package is never rewritten. Everything else in the
    // repository is regenerated in place on every publish, so caching it --
    // especially as `immutable` -- leaves clients on a manifest that no longer
    // matches the index they just fetched.
    const rewritten =
      name === "index.json" ||
      name === "repo.json" ||
      name === "store.json" ||
      name === "store.in.json" ||
      name.endsWith(".sig") ||
      segments.includes("pkg") ||
      segments.includes("previews");
    if (rewritten) {
      res.set("Cache-Control", "no-cache");
    } else {
      res.set("Cache-Control", "public, max-age=31536000, immutable");
    }
  },
}));
app.use("/spaceos/repo", serveIndex(repoDir, {
  icons: false,
  view: "details",
  hidden: false,
}));
app.use("/spaceos/repo", (_req, res) => res.status(404).type("text/plain").send("not found"));

app.use(express.static(pub, { extensions: ["html"] }));
app.use((_req, res) => res.status(404).sendFile(path.join(pub, "index.html")));
app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: "服务器错误" }); });

setInterval(A.cleanupExpired, 3600 * 1000).unref();
setInterval(oauthCleanup, 3600 * 1000).unref();

export { app };

// 只有直接 `node server/index.js` 时才监听；测试里 import 本文件拿到 app 自己起端口
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  app.listen(PORT, "0.0.0.0", () => console.log(`listening on :${PORT}`));
}
