// 两步验证（TOTP + 恢复码）与通行密钥（WebAuthn / Passkey）
import { Router } from "express";
import crypto from "node:crypto";
import { generateSecret, generateURI, verify as totpVerify } from "otplib";
import QRCode from "qrcode";
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { db } from "../db.js";
import * as A from "../auth.js";
import { str, authLimit, need, needSudo, base, getUser, pubUser, syncAdmin, securityNotice } from "../util.js";

const r = Router();
const RP_NAME = "GoutouStdio";
const rp = (req) => { const u = new URL(base(req)); return { origin: u.origin, rpID: u.hostname }; };

// WebAuthn 挑战：单进程内存保存，5 分钟过期，用 HttpOnly cookie 关联
const challenges = new Map();
const WA_COOKIE = "gs_wa";
function putChallenge(res, data) {
  const key = crypto.randomBytes(24).toString("base64url");
  challenges.set(key, { ...data, exp: Date.now() + 5 * 60 * 1000 });
  res.cookie(WA_COOKIE, key, { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", path: "/api", maxAge: 5 * 60 * 1000 });
}
function takeChallenge(req, res) {
  const key = req.cookies[WA_COOKIE];
  const c = key && challenges.get(key);
  challenges.delete(key);
  res.clearCookie(WA_COOKIE, { path: "/api" });
  return c && c.exp > Date.now() ? c : null;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of challenges) if (v.exp < now) challenges.delete(k); }, 60 * 1000).unref();

const passkeysOf = (uid) => db.prepare("SELECT id, name, created_at, last_used, transports FROM passkeys WHERE user_id=? ORDER BY created_at").all(uid)
  .map((p) => ({ id: p.id, name: p.name || "通行密钥", createdAt: p.created_at, lastUsed: p.last_used }));

r.get("/2fa", need, (req, res) => {
  const u = getUser(req.user.id);
  res.json({ totp: !!u.totp_secret, recoveryLeft: A.recoveryLeft(u.id), passkeys: passkeysOf(u.id) });
});

// ---- TOTP ----
r.post("/2fa/totp/setup", need, needSudo, async (req, res) => {
  const u = getUser(req.user.id);
  if (u.totp_secret) return res.status(400).json({ error: "已开启两步验证" });
  const secret = generateSecret();
  db.prepare("UPDATE users SET totp_pending=? WHERE id=?").run(secret, u.id);
  const uri = generateURI({ issuer: RP_NAME, label: u.username, secret });
  res.json({ secret, uri, qr: await QRCode.toDataURL(uri, { margin: 1, width: 200 }) });
});

r.post("/2fa/totp/enable", need, needSudo, authLimit, async (req, res) => {
  const u = getUser(req.user.id);
  if (!u.totp_pending) return res.status(400).json({ error: "请先开始设置" });
  const v = await totpVerify({ secret: u.totp_pending, token: str(req.body.code).replace(/\s/g, ""), epochTolerance: 30 });
  if (!v.valid) return res.status(400).json({ error: "验证码不正确，请检查手机时间是否准确" });
  db.prepare("UPDATE users SET totp_secret=totp_pending, totp_pending=NULL, totp_last_step=? WHERE id=?").run(v.timeStep, u.id);
  const codes = A.newRecoveryCodes(u.id);
  securityNotice(req, u, "开启了两步验证");
  res.json({ recoveryCodes: codes });
});

r.post("/2fa/totp/disable", need, needSudo, (req, res) => {
  const u = getUser(req.user.id);
  db.prepare("UPDATE users SET totp_secret=NULL, totp_pending=NULL, totp_last_step=0 WHERE id=?").run(u.id);
  db.prepare("DELETE FROM recovery_codes WHERE user_id=?").run(u.id);
  securityNotice(req, u, "关闭了两步验证");
  res.json({ ok: true });
});

r.post("/2fa/recovery", need, needSudo, (req, res) => {
  const u = getUser(req.user.id);
  if (!u.totp_secret) return res.status(400).json({ error: "未开启两步验证" });
  securityNotice(req, u, "重新生成了恢复码");
  res.json({ recoveryCodes: A.newRecoveryCodes(u.id) });
});

// ---- 通行密钥：注册 ----
r.post("/passkeys/options", need, needSudo, async (req, res) => {
  const u = getUser(req.user.id);
  const { rpID } = rp(req);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME, rpID, userName: u.username, userDisplayName: u.display_name || u.username,
    userID: new TextEncoder().encode(String(u.id)),
    attestationType: "none",
    excludeCredentials: db.prepare("SELECT id, transports FROM passkeys WHERE user_id=?").all(u.id)
      .map((p) => ({ id: p.id, transports: p.transports ? p.transports.split(",") : undefined })),
    authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
  });
  putChallenge(res, { kind: "reg", uid: u.id, challenge: options.challenge });
  res.json(options);
});

r.post("/passkeys", need, needSudo, async (req, res) => {
  const c = takeChallenge(req, res);
  if (!c || c.kind !== "reg" || c.uid !== req.user.id) return res.status(400).json({ error: "请求已过期，请重试" });
  const { origin, rpID } = rp(req);
  let v;
  try {
    v = await verifyRegistrationResponse({ response: req.body.response, expectedChallenge: c.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: false });
  } catch (err) { return res.status(400).json({ error: "验证失败：" + err.message }); }
  if (!v.verified) return res.status(400).json({ error: "验证失败" });
  const cred = v.registrationInfo.credential;
  const name = str(req.body.name).trim().slice(0, 40) || (v.registrationInfo.credentialBackedUp ? "同步的通行密钥" : "设备上的通行密钥");
  db.prepare("INSERT INTO passkeys (id,user_id,public_key,counter,transports,name,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(cred.id, req.user.id, Buffer.from(cred.publicKey), cred.counter, (cred.transports || []).join(","), name, Date.now());
  securityNotice(req, getUser(req.user.id), `添加了通行密钥「${name}」`);
  res.status(201).json({ passkeys: passkeysOf(req.user.id) });
});

r.patch("/passkeys/:id", need, (req, res) => {
  const name = str(req.body.name).trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: "名称不能为空" });
  db.prepare("UPDATE passkeys SET name=? WHERE id=? AND user_id=?").run(name, req.params.id, req.user.id);
  res.json({ passkeys: passkeysOf(req.user.id) });
});

r.delete("/passkeys/:id", need, needSudo, (req, res) => {
  const p = db.prepare("SELECT name FROM passkeys WHERE id=? AND user_id=?").get(req.params.id, req.user.id);
  if (!p) return res.status(404).json({ error: "不存在" });
  db.prepare("DELETE FROM passkeys WHERE id=? AND user_id=?").run(req.params.id, req.user.id);
  securityNotice(req, getUser(req.user.id), `删除了通行密钥「${p.name}」`);
  res.json({ passkeys: passkeysOf(req.user.id) });
});

// ---- 通行密钥：登录（可发现凭据，不需要先输入用户名）。通行密钥本身已是强认证，不再要求 TOTP ----
r.post("/passkey/login/options", authLimit, async (req, res) => {
  const { rpID } = rp(req);
  const options = await generateAuthenticationOptions({ rpID, userVerification: "preferred" });
  putChallenge(res, { kind: "auth", challenge: options.challenge });
  res.json(options);
});

r.post("/passkey/login", authLimit, async (req, res) => {
  const c = takeChallenge(req, res);
  if (!c || c.kind !== "auth") return res.status(400).json({ error: "请求已过期，请重试" });
  const response = req.body.response;
  const pk = db.prepare("SELECT * FROM passkeys WHERE id=?").get(str(response?.id));
  if (!pk) return res.status(401).json({ error: "这个通行密钥未绑定任何账号" });
  const { origin, rpID } = rp(req);
  let v;
  try {
    v = await verifyAuthenticationResponse({
      response, expectedChallenge: c.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: false,
      credential: { id: pk.id, publicKey: new Uint8Array(pk.public_key), counter: pk.counter, transports: pk.transports ? pk.transports.split(",") : undefined },
    });
  } catch (err) { return res.status(401).json({ error: "验证失败：" + err.message }); }
  if (!v.verified) return res.status(401).json({ error: "验证失败" });
  const u = getUser(pk.user_id);
  if (u.banned) return res.status(403).json({ error: "账号已被封禁" });
  db.prepare("UPDATE passkeys SET counter=?, last_used=? WHERE id=?").run(v.authenticationInfo.newCounter, Date.now(), pk.id);
  syncAdmin(u.id);
  A.setCookie(res, A.createSession(u.id, req));
  res.json({ user: pubUser(getUser(u.id)) });
});

export default r;
