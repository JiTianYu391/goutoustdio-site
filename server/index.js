import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "./db.js";
import * as A from "./auth.js";
import { syncAdmin } from "./util.js";
import authRoutes from "./routes/auth.js";
import mfaRoutes from "./routes/mfa.js";
import accountRoutes from "./routes/account.js";
import commentRoutes from "./routes/comments.js";
import ticketRoutes from "./routes/tickets.js";
import adminRoutes from "./routes/admin.js";

const app = express();
const PORT = Number(process.env.PORT) || 8080;
const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const webauthnBundle = path.join(pub, "..", "node_modules", "@simplewebauthn", "browser", "dist", "bundle", "index.umd.min.js");

app.set("trust proxy", 1); // FadeHost 反代
app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      // Cloudflare 会自动注入 Web Analytics 脚本（含一段内联初始化），这里放行它和截图所在的 raw.githubusercontent.com
      "script-src": ["'self'", "https://static.cloudflareinsights.com", "'sha256-f3hdOU1QscqxHyyMkQCCyaLeNK4GEvqsgMC25eSfQ+k='"],
      "connect-src": ["'self'", "https://cloudflareinsights.com"],
      "img-src": ["'self'", "data:", "https://raw.githubusercontent.com"],
      "upgrade-insecure-requests": null,
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use("/api", (_req, res, next) => { res.set("Cache-Control", "no-store"); res.set("Vary", "Cookie"); next(); });
app.use(cookieParser());
app.use("/api", express.json({ limit: "64kb" }));

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
app.use("/api", (_req, res) => res.status(404).json({ error: "not found" }));

// 浏览器端 WebAuthn 库直接取自 node_modules，版本与服务端一致
app.get("/vendor/webauthn.js", (_req, res) =>
  res.type("js").sendFile(webauthnBundle));

const page = (file) => (_req, res) => res.sendFile(path.join(pub, file));
for (const p of ["login", "register", "account", "verify", "forgot", "reset", "admin"]) app.get(`/${p}`, page(`${p}.html`));
app.get(["/support", "/support/:id"], page("support.html"));
app.get("/u/:username", page("user.html"));
app.use(express.static(pub, { extensions: ["html"] }));
app.use((_req, res) => res.status(404).sendFile(path.join(pub, "index.html")));
app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: "服务器错误" }); });

setInterval(A.cleanupExpired, 3600 * 1000).unref();
app.listen(PORT, "0.0.0.0", () => console.log(`listening on :${PORT}`));
