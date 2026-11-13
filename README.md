# GoutouStdio 官网

GoutouStdio 小组官方网站，部署在 FadeHost，域名 [goutoustdio.top](https://goutoustdio.top)。

站点页面在 `public/`（HTML + CSS + JS，动画用本地 GSAP / Lenis），`server/` 是 Node.js 后端（Express 5），提供账户系统。

## 账户系统

界面参照 GitHub Primer（Box / Subhead / NavList / Label / Timeline 等），样式在 `public/css/auth.css`。

- **账号**：注册、登录、邮箱验证、找回密码、改邮箱、注销；资料（昵称、简介）与公开主页 `/u/用户名`。
- **安全**：scrypt 密码哈希；HttpOnly 会话 cookie（库里只存 sha256）；写请求校验 Origin；接口限流；CSP。
  敏感操作需 10 分钟内确认过密码（sudo 模式）；密码 / 两步验证 / 通行密钥变动会发安全提醒邮件。
- **两步验证**：TOTP（otplib）+ 10 个一次性恢复码，带重放保护。
- **通行密钥**：WebAuthn / Passkey（SimpleWebAuthn），可发现凭据，免用户名一键登录。
- **登录设备**：查看并下线其他设备。
- **评论**：项目页底部讨论区，支持一层回复、点赞，回复会邮件提醒（可退订）。
- **问题反馈**：`/support` 工单，用户提交与跟进，管理员回复和改状态，双方邮件提醒。
- **邮件订阅**：PySpOS / SpaceOS 版本更新、站点公告、评论回复；每封邮件带签名的一键退订链接。
- **管理后台**：`/admin`，概览统计、用户搜索与封禁、评论审核、工单、群发版本更新通知。
- 管理员 = 邮箱等于 `ADMIN_EMAIL` 且已验证的账号。

后端在 `server/`：`routes/` 下按领域拆分（auth、mfa、account、comments、tickets、admin）。
数据存 SQLite（Node 内置 `node:sqlite`，需要 Node ≥ 22.13），文件在 `DATA_DIR`；FadeHost 上应设为 `/data/storage`，代码目录每次部署都会被重置。

### 环境变量

| 变量 | 说明 |
| --- | --- |
| `PORT` | 监听端口，默认 8080 |
| `NODE_ENV=production` | 打开 cookie 的 `Secure` |
| `SITE_URL` | 站点地址，用于邮件链接；通行密钥的 RP ID 也取它的域名，所以只在这个域名下可用 |
| `DATA_DIR` | SQLite 文件目录 |
| `ADMIN_EMAIL` | 用这个邮箱注册的账号自动成为管理员 |
| `MAIL_SMTP_HOST` `MAIL_SMTP_PORT` `MAIL_SMTP_SECURE` `MAIL_SMTP_USER` `MAIL_SMTP_PASS` `MAIL_FROM` | SMTP；不配置则只在日志里打印链接 |

本地运行：`npm install && npm start`。

## 大文件说明

下载用的大文件（两个 Uinxed ISO、OTA 更新包 zip）和两张截图因为是二进制文件，没有放进这个仓库，相关链接指向原 PySpOS 仓库的 raw 地址：

- `Uinxed-x64-slim.iso`、`spaceos8/Uinxed-x64-slim.iso`
- `ota/PySpOS-*.zip`（`ota/version.json` 里的 `download_url` 也是）
- `spaceos8-minecraft.png`、`spaceos9/fastfetch.png`（页面里的两张截图）

`logo.png` 和 `spaceos9.png` 在原 docs 里没有被任何页面引用，也没有放进这个仓库。

如果以后想让本站完全自包含，把这些文件传进本仓库，再把链接改回相对路径即可。
