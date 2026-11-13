# GoutouStdio 官网

GoutouStdio 小组官方网站，部署在 FadeHost，域名 [goutoustdio.top](https://goutoustdio.top)。

站点页面在 `public/`（HTML + CSS + JS，动画用本地 GSAP / Lenis），`server/` 是 Node.js 后端（Express 5），提供账户系统。

## 账户系统

- 注册 / 登录 / 退出 / 修改密码 / 注销账号，邮箱验证与找回密码（SMTP）。
- 密码用 scrypt 哈希；会话是随机 token 放 HttpOnly + SameSite=Lax cookie，库里只存 sha256；
  写请求校验 Origin（CSRF）；登录/注册等接口限流；helmet 提供 CSP 等响应头。
- 数据存 SQLite（Node 内置 `node:sqlite`，需要 Node ≥ 22.13），文件在 `DATA_DIR`（默认 `./data`）。

### 环境变量

| 变量 | 说明 |
| --- | --- |
| `PORT` | 监听端口，默认 8080 |
| `NODE_ENV=production` | 打开 cookie 的 `Secure` |
| `SITE_URL` | 邮件里链接的站点地址 |
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
