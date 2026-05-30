# TG Alive

自部署的 Telegram 网页客户端。前端部署到 Cloudflare Pages，浏览器只访问 Pages 同源 `/api`；Pages Functions 通过 Service Binding 调用后端 Worker，避免浏览器直接请求 `workers.dev`。

## 功能状态

- 登录：手机号、验证码、两步验证密码。
- 云端会话：按手机号匹配，用户同步密码加密后保存到 KV。
- 会话：会话列表、打开新聊天、历史消息分页、当前聊天内搜索。
- 消息：文本发送、文件发送、回复、转发、纯文本消息编辑、删除消息、打开会话后标记已读。
- 实时同步：使用 GramJS 更新事件监听新消息、编辑和删除；不做固定周期轮询。断线后会显示状态并自动退避重连。
- `777000`：浏览器内读取服务号最新通知；Worker 也提供接口读取并顺便刷新 session。
- 媒体：图片和音频可下载后预览；视频使用 Worker Range 流式预览，不需要完整下载。
- 移动端：手机宽度下采用“会话列表页 / 聊天页”切换，聊天页有返回按钮，输入栏和视频区域做了 safe-area 与窄屏适配。

暂未覆盖完整 Telegram Web 能力，例如反应、贴纸面板、语音录制、相册聚合、联系人管理、群管理、通话、设置页等。

## 架构

- `src/`：React + Vite 前端，使用 GramJS 作为浏览器 Telegram 客户端。
- `functions/api/[[path]].ts`：Cloudflare Pages Function，同源转发 `/api/*` 到 Worker Service Binding。
- `workers/tg-gateway/`：Cloudflare Worker，负责 Telegram WebSocket 代理、KV 会话接口、`777000` 读取和视频 Range 流。
- `SESSIONS` KV：保存加密后的用户 session，也保存短期视频流 token。

浏览器请求链路：

```text
Browser -> https://你的域名/api/* -> Pages Function -> Service Binding -> tg-alive-gateway Worker
```

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
ALLOWED_ORIGINS=
```

Worker 侧的 `777000` 接口、视频流 token 创建和视频 Range 下载都需要 `TG_API_ID` 与 `TG_API_HASH`。

## 本地开发

```bash
npm install
npm run worker:dev
npm run dev
```

开发时前端仍然请求 `/api`，Vite 会把 `/api` 代理到本地 `http://127.0.0.1:8787`。如需改本地 Worker 地址，可设置：

```bash
VITE_DEV_GATEWAY=http://127.0.0.1:8787
```

## 部署

1. 在 Telegram 创建自己的 API ID 和 API Hash：https://my.telegram.org/apps
2. 创建 KV 命名空间，并把 `workers/tg-gateway/wrangler.toml` 里的 `SESSIONS` ID 换成真实值：

```bash
wrangler kv namespace create SESSIONS
wrangler kv namespace create SESSIONS --preview
```

3. 给 Worker 设置环境变量：

```bash
wrangler secret put TG_API_ID --config workers/tg-gateway/wrangler.toml
wrangler secret put TG_API_HASH --config workers/tg-gateway/wrangler.toml
```

也可以直接在 Cloudflare Dashboard 里配置变量。

4. 部署后端 Worker：

```bash
npm run worker:deploy
```

5. 在 Cloudflare Pages 创建项目：

- 构建命令：`npm run build`
- 构建输出目录：`dist`

6. 给 Pages 项目添加 Service Binding：

- Binding name：`TG_GATEWAY`
- Service：`tg-alive-gateway`

7. 给 Pages 项目添加环境变量：

```bash
VITE_TG_API_ID=你的 Telegram API ID
VITE_TG_API_HASH=你的 Telegram API Hash
VITE_API_PREFIX=/api
```

8. 部署 Pages：

```bash
npm run pages:deploy
```

9. 给 Pages 绑定自己的域名。用户浏览器只访问 `https://你的域名/api/...`，不会直接请求 Worker 域名。

## API 接口

### 会话保存

```http
GET /api/session?key=...
PUT /api/session
```

前端会用手机号和同步密码派生 key，把 Telegram `StringSession` 在浏览器端加密后保存到 KV。

### KV touch

```http
GET /api/session/refresh?phone=手机号&key=同步密码
```

校验同步密码并 touch KV 记录，返回 `telegram:false`。它不连接 Telegram，不等同于刷新 Telegram auth session。

### 读取 777000

```http
GET /api/telegram-code?phone=手机号&key=同步密码
```

Worker 会解密 session、读取 `777000` 最新通知、返回验证码，并在 session 变化时写回 KV。推荐把同步密码放在 `x-session-refresh-key` header，避免出现在 URL 日志里。

### Telegram WebSocket

```http
GET /api/telegram-ws?host=...&port=443
```

供 GramJS 连接 Telegram Web MTProto WSS。浏览器通过同源 `/api/telegram-ws` 连接，Worker 只允许 Telegram Web 的已知 host。

### 视频流

```http
POST /api/media-token
GET /api/media-stream?token=...
HEAD /api/media-stream?token=...
```

前端播放视频时先创建短期 token，再由 DPlayer 请求 `media-stream`。Worker 支持 HTTP Range，并按片段从 Telegram 拉取文件，避免完整下载后再播放。

默认视频 token 有效期为 1800 秒。token 是 bearer URL，拿到 URL 的人可以在有效期内读取对应媒体片段，请不要公开分享。

## 数据存储

- 云端 session 存在 `SESSIONS` KV。
- KV key 使用手机号派生的哈希，不直接保存手机号明文。
- KV value 保存浏览器端加密后的 Telegram session 和同步密码 verifier。
- 云端 session 不设置 KV 过期时间；如果 Telegram session 失效，需要重新验证码登录并覆盖保存。
- 云端恢复成功后，只有当 GramJS 导出的 session 发生变化时才会重新写入 KV。
- 视频流 token 也存在 KV，但只保存短期加密记录，默认 1800 秒后过期。
- `localStorage` 只保存手机号和是否启用云端同步，不保存 Telegram session 明文。

KV 免费额度通常足够个人或小团队会话同步。视频预览会增加 Worker 请求数和 Telegram 下载请求数，播放长视频或频繁拖动进度条时消耗会明显高于纯聊天。

## 实时连接说明

实时消息依赖 GramJS 的 update 机制，底层通过 Worker 代理的 WebSocket 连接 Telegram。前端会显示连接状态：

- `实时同步`
- `同步中`
- `正在重连`
- `连接中断`
- `同步失败`

断线后会自动退避重连。Cloudflare Worker WebSocket 没有“固定几分钟必断”的规则，但部署、网络抖动、空闲连接、Worker isolate 生命周期等都可能导致连接中断，所以前端仍需要重连逻辑。

## 视频预览说明

- DPlayer 按需懒加载，不进入首屏主 bundle。
- 视频请求走同源 `/api/media-stream`，支持 Range，不会完整下载后再预览。
- Worker 创建 token 时会解析并缓存 Telegram 文件位置，后续 Range 请求不再每次重新查消息。
- 单次 Range 响应最多返回 4 MiB，浏览器会按需继续请求后续片段。
- 如果 token 过期，视频卡住时可点媒体行里的刷新按钮重新生成播放地址。

## 安全提示

- 请自己申请 Telegram API ID 和 API Hash，不要共用陌生来源的 API 配置。
- 不建议在多人公开站点设置 `VITE_DEFAULT_SESSION_PASSWORD`，因为它会进入前端构建产物。
- 同步密码用于加密云端 session；忘记后无法从 KV 解密恢复，只能重新登录覆盖。
- `GET /api/telegram-code` 如果把同步密码放 URL 参数里，可能出现在访问日志中；更推荐使用 `x-session-refresh-key` header。
- 使用前请确认你的使用方式符合所在地法律以及 Telegram、Cloudflare 的服务条款。
