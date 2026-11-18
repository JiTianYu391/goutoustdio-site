# 示例小游戏：账号登录 + 充值

一个不依赖任何 npm 包的 Node 小游戏页面，演示两件事：

1. 用 GoutouStdio 账号登录（OAuth 2.0 授权码 + PKCE）
2. 用 SpacePay 商户 API 充值，Webhook 验签后给玩家加钻石

## 跑起来

```bash
# 1) 在站点仓库根目录注册应用（回调地址要和你启动的端口一致）
npm run app:create -- --name "示例小游戏" --redirect http://localhost:5173/oauth/callback

# 2) 填环境变量
export GS_CLIENT_ID=gs_app_…            # 上一步输出
export SPACEPAY_KEY=sp_live_…            # SpacePay 商户后台 → API 密钥
export SPACEPAY_WEBHOOK_SECRET=whsec_…   # 商户后台 → Webhook

# 3) 启动
node examples/game/server.mjs
# 打开 http://localhost:5173
```

本地调站点（不是正式域名）时再加：

```bash
export GS_BASE=http://localhost:8080
```

Webhook 需要公网 HTTPS 才能收到。本地联调可以先用内网穿透，或在 SpacePay 后台用「重投」对着你的临时地址测试。

## 文件

| 文件 | 作用 |
| --- | --- |
| `server.mjs` | 登录跳转、回调换令牌、创建支付、Webhook 验签 |
| `products.mjs` | 服务端兜底与可选白名单；商品默认由客户端传（兜底 100 钻石） |
| `public/index.html` | 登录按钮、余额、充值按钮 |

## 这个示例故意省掉的东西

演示代码为了短，用内存保存会话、玩家和订单。正式项目至少还要：

- 会话与订单落库（SQLite / Postgres），重启不丢
- `state` 与 `code_verifier` 和玩家会话绑定并一次性使用（示例已经是这样）
- 刷新令牌的轮换与保存
- Webhook 事件表的唯一索引做幂等（示例用的是内存 Set）
- 玩家余额变动用事务 + 流水，不要直接 `credits += x`
- 商品配置由客户端传，服务端只校验格式；有排行榜/交易时改成 `WHITELIST_ONLY = true`
