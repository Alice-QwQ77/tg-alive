# TG Alive

自部署的 Telegram 网页客户端原型。前端部署到 Cloudflare Pages，浏览器只访问 Pages 同源 `/api`；Pages Functions 再通过 Service Binding 调用后端 Worker，由 Worker 代理 Telegram Web MTProto WebSocket。

## 架构

- `src/`：React + Vite 前端，使用 GramJS 直连 MTProto。
- `functions/api/[[path]].ts`：Pages Function 同源 API 入口，不把 `workers.dev` 暴露给浏览器。
- `workers/tg-gateway/`：独立 Cloudflare Worker，代理 Telegram Web WSS，并用 KV 保存加密后的登录 session。

## 环境变量

Pages 构建环境变量：

```bash
VITE_TG_API_ID=你的 Telegram API ID
VITE_TG_API_HASH=你的 Telegram API Hash
VITE_API_PREFIX=/api
VITE_DEFAULT_SESSION_PASSWORD=
```

`VITE_DEFAULT_SESSION_PASSWORD` 会进入前端包，只适合单人自用。多人使用时建议留空，让每个用户自己填写云端同步密码。

Worker 环境变量：

```bash
TG_API_ID=你的 Telegram API ID
TG_API_HASH=你的 Telegram API Hash
```

Worker 侧读取 `777000` 接口需要这两个变量；如果只使用浏览器内登录和恢复，也仍然建议保持两边一致。

## 本地开发

```bash
npm install
npm run worker:dev
npm run dev
```

开发时前端仍然请求 `/api`，Vite 会把 `/api` 代理到本地 `http://127.0.0.1:8787`。

## 部署

1. 在 Telegram 创建自己的 API ID 和 API Hash：https://my.telegram.org/apps
2. 创建 KV 命名空间，并把 `workers/tg-gateway/wrangler.toml` 里的 `SESSIONS` ID 换成真实值：

```bash
wrangler kv namespace create SESSIONS
wrangler kv namespace create SESSIONS --preview
```

3. 部署后端 Worker：

```bash
npm run worker:deploy
```

4. 在 Cloudflare Pages 创建项目，构建命令填 `npm run build`，构建输出目录填 `dist`。
5. 给 Pages 项目添加 Service Binding：
   - Binding name：`TG_GATEWAY`
   - Service：`tg-alive-gateway`
6. 给 Pages 项目添加 `VITE_TG_API_ID` 和 `VITE_TG_API_HASH` 环境变量；给 Worker 添加 `TG_API_ID` 和 `TG_API_HASH` 环境变量。
7. 部署 Pages：

```bash
npm run pages:deploy
```

8. 给 Pages 绑定自己的域名。浏览器访问的 API 仍然是 `https://你的域名/api/...`。

## 备注

- 登录会话会在浏览器端用用户的云端同步密码加密，然后以密文保存到 KV。
- KV key 使用手机号哈希；KV value 保存加密 session 和密码派生 verifier，避免知道手机号就覆盖已有记录。
- 云端 session 不设置 KV 过期时间；如果 Telegram session 失效，重新验证码登录会覆盖刷新。
- 云端恢复成功后，只有当 GramJS 导出的 session 发生变化时才会重新写入 KV。
- 登录后的钥匙按钮会读取 Telegram `777000` 服务号最新消息，可用于查看发送到已有登录设备的 Telegram 验证码；这次读取也会让 session 活跃一次。
- 当前不做 Worker Cron 自动保活，因为 session 是客户端加密的，Worker 没有同步密码，不能在后台解密使用。
- `GET /api/session/refresh?phone=手机号&key=同步密码` 可校验并 touch KV 记录，返回 `telegram:false`；它不等同于真正连接 Telegram 刷新 auth session。
- `GET /api/telegram-code?phone=手机号&key=同步密码` 会在 Worker 侧解密 session、读取 `777000` 最新通知、返回验证码，并在 session 变化时写回 KV。推荐把同步密码放在 `x-session-refresh-key` header，避免出现在 URL 日志里。
- `localStorage` 只保存手机号和是否启用云端同步，不保存 Telegram session 明文。
- KV 免费额度足够个人/小团队会话同步：免费计划包含 1 GB 存储、每天 100,000 次读、1,000 次写、1,000 次删；每个账号通常只占一个 key。
- 当前功能覆盖登录、云端会话恢复、会话列表、消息读取、文本发送、`777000` 验证码读取和周期刷新；媒体、贴纸、文件、通话、反应、消息编辑/删除等完整 Telegram Web 能力尚未实现。
- 使用前请确认你的使用方式符合所在地法律以及 Telegram、Cloudflare 的服务条款。
