# z-media-workflow

Koa + Vue 3 媒体工作流与中文管理面板，无数据库。qBittorrent RSS 下载完成后发送回调，服务等待 Jellyfin 媒体库刷新完成，使用 DeepSeek 从电视剧文件夹或电影文件名中提取名称及可选年份，调用 Jellyfin 搜索并应用唯一可靠候选，最后回读确认提供方 ID、名称和年份。歧义候选由管理面板人工选择。

## 本地启动

需要 Node.js 22+。在项目根目录执行：

```powershell
npm install
npm install --prefix web
# 首次部署且没有 .env 时：复制 .env.example 为 .env 并填写凭据
npm run build
npm start
```

打开 http://localhost:3000，使用 `.env` 的 `ADMIN_API_TOKEN` 登录。当前调试环境已写入被 Git 忽略的 `.env`，管理和回调令牌分别随机生成；不在文档或构建产物中记录真实令牌。

开发时分别运行 `npm run dev` 与 `npm run dev:web`，打开 http://localhost:5173。默认 DEV_ORIGIN 允许该来源；改端口时同步调整 `.env`。生产配置 `NODE_ENV=production`、实际 `PUBLIC_URL`，HTTPS 时设置 `COOKIE_SECURE=true`；代理部署时按环境设置 `TRUST_PROXY`。面板与 API 使用同源部署。

## 面板

- 概览：任务统计、服务连接检查、目标库和近期任务。
- RSS：添加/删除/刷新订阅、读取文章，管理原生下载规则及保存目录。
- 工作流任务：扫描状态、每项识别结果、失败重试。
- 媒体识别：分页查看未识别条目，预览或自动识别选中条目/目标库。
- 任务详情：查看名称提取和 Jellyfin 候选，人工确认，或修改名称/年份后重新搜索。
- 连接与通知：只读检查、脱敏地址、目录映射及回调命令。

“预览候选”会刷新库并调用 DeepSeek，但不应用元数据；“识别并应用”仅对名称及可选年份匹配后唯一的候选自动写入。无候选、多候选、年份冲突进入待确认。任务信息只在当前服务进程内保留，重启后需要重新扫描。

## 配置媒体目录

当前已验证的 Jellyfin 库：

| 库 | 类型 | Jellyfin 目录 |
| --- | --- | --- |
| series | 电视剧 | `/MediasVol3/series` |
| movie | 电影 | `/MediasVol3/movies` |

qBittorrent 默认目录是 `/MediasVol3/downloads`，它不属于上述媒体库。**请在 RSS 规则中将 savePath 设置为电影或电视剧媒体库对应的 qBittorrent 路径**，或先自行整理文件到库目录。服务不移动、重命名、删除媒体文件。电视剧每个剧集使用独立文件夹，Season 子文件夹和单集会按所属 Series 根目录识别；电影按每个视频文件名识别。

两端挂载路径一致时，`QBT_PATH_PREFIX` 和 `JELLYFIN_PATH_PREFIX` 留空。如果 qBittorrent 是 `/downloads/series`，而 Jellyfin 是 `/MediasVol3/series`，设置：

```dotenv
QBT_PATH_PREFIX=/downloads
JELLYFIN_PATH_PREFIX=/MediasVol3
```

库 ID 可在面板“连接与通知”中查看，分别配置 `JELLYFIN_SERIES_LIBRARY_ID`、`JELLYFIN_MOVIE_LIBRARY_ID`。配置 ID 时仅处理指定库；留空则处理相应类型的库，始终排除 musicvideos 等其他类型。

## qBittorrent 下载完成通知

在 **qBittorrent 所在机器/容器** 部署 `scripts/notify-completed.mjs`（只依赖 Node.js 22+，无需安装 npm 包）。复制 `scripts/.env.notify.example` 为脚本同目录的 `.env.notify`，填入：

```dotenv
WORKFLOW_CALLBACK_URL=http://workflow-host:3000/api/webhooks/qbittorrent/completed
WORKFLOW_API_TOKEN=服务端.env中的独立回调令牌
```

地址必须可从 qBittorrent 所在机器访问。服务默认监听 127.0.0.1；跨机器调用时将 `HOST` 改为可访问地址，如 `0.0.0.0`，设置实际 `PUBLIC_URL` 并按部署环境开放端口。

qBittorrent 设置 → 下载 → 下载完成后运行外部程序：

Windows：

```text
node "E:\personal\z-media-workflow\scripts\notify-completed.mjs" "%I"
```

Linux / Docker（按实际路径调整）：

```text
node /opt/z-media-workflow/scripts/notify-completed.mjs "%I"
```

可选增加 `Movie` 或 `Series` 参数，仅当这套通知明确只用于一种媒体类型。混合下载通常无需参数，按入库条目识别类型。Docker 需确保容器内存在 Node.js、脚本及配置，并能访问服务；宿主机 localhost 与容器 localhost 不等同。本项目不会自动修改远程 qBittorrent 完成命令或 RSS 规则。

脚本对网络/429/5xx 限量重试；API 对 hash 去重。hash 支持 v1 40 位或 v2 64 位十六进制。回调使用 WORKFLOW_API_TOKEN，不能操作管理 API；管理令牌不能调用下载回调。

## API 与分层

```text
src/router/       URL 与认证绑定
src/controller/   参数校验、HTTP 状态和响应
src/service/      qBittorrent / Jellyfin / DeepSeek、队列与会话
src/util/         HTTP、路径、候选匹配、校验及日志
web/src/          Vue 管理面板
scripts/          通知与只读联通检查
```

成功响应 `{ "data": ... }`，错误响应 `{ "error": { "code", "message" } }`。接口：

| 方法 | 路径 | 功能 |
| --- | --- | --- |
| GET | `/health` | 存活检查 |
| POST | `/api/auth/login`、`/api/auth/logout` | 管理会话登录/退出 |
| GET | `/api/auth/session` | 会话和 CSRF token |
| GET | `/api/dashboard` | 统计、目标库与脱敏配置 |
| POST | `/api/connections/check` | 三方只读连接检查 |
| GET | `/api/qbittorrent/rss` | 订阅树与文章 |
| POST / DELETE | `/api/qbittorrent/rss/feeds` | 添加/删除订阅 |
| POST | `/api/qbittorrent/rss/refresh` | 刷新订阅 |
| GET | `/api/qbittorrent/rss/rules` | 规则列表 |
| PUT / DELETE | `/api/qbittorrent/rss/rules/:name` | 设置/删除规则 |
| POST | `/api/webhooks/qbittorrent/completed` | `{ hash, type? }` 下载完成通知 |
| GET | `/api/media/unidentified` | 目标库未识别条目 |
| GET | `/api/workflows` | 分页任务列表 |
| POST | `/api/workflows/scan` | `{ dryRun, libraryId?, itemIds?, type? }` |
| GET | `/api/workflows/:jobId` | 任务与每项结果 |
| POST | `/api/workflows/:jobId/retry` | 创建重试任务 |
| POST | `/api/workflows/:jobId/search` | `{ itemId, name, year? }` 修正搜索 |
| POST | `/api/workflows/:jobId/confirm` | `{ itemId, candidateId }` 确认任务已有候选 |

管理 API 支持管理 Bearer token；浏览器使用 HttpOnly 会话 cookie，同源写入需 CSRF token。分页参数 `page`/`pageSize`，每页最多 200。

## 运行限制与验证

串行队列上限由 MAX_QUEUE 设置，保留任务数由 MAX_JOBS 设置。终态任务按 JOB_TTL_MS 淘汰，待确认任务保留至处理完成或重启。队列/记录满返回 429；服务关闭时停止接收新任务并限时等待处理结束。无数据库，不提供跨重启任务恢复或可靠投递保证。

扫描等待同时检查 Idle 和新 LastExecutionResult，避免把尚未开始的扫描当作完成。扫描与元数据确认均有超时。电影/剧集 RemoteSearch 由 Jellyfin 已配置的提供方执行，需要对应提供方可联网；缺少 provider ID 的候选不能应用。

部分剧集提供方只返回 PremiereDate，不返回 ProductionYear；服务会从有效首播日期提取候选年份，区分同名不同年份的剧集。应用请求若超时，仍会先回读检查实际结果，名称、年份和提供方 ID 验证通过后才标记完成。

```powershell
npm test
npm run build
npm run test:ui
npm run check:connections
```

单元/API 测试和浏览器测试使用本地 mock，不更改实际 RSS 或 Jellyfin 元数据。`check:connections` 只读查询版本、可用模型、库及媒体回读，不调用模型生成，不触发扫描。浏览器测试默认使用本机 Edge，可通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定 Chromium；没有浏览器时执行 `npx playwright install chromium`。

官方接口参考：[qBittorrent API key](https://github.com/qbittorrent/wiki/blob/master/API-Key-Authentication-%28%E2%89%A5v5.2.0%29.md)、[qBittorrent WebAPI](https://github.com/qbittorrent/qBittorrent/wiki/WebUI-API-%28qBittorrent-5.0%29)、[Jellyfin API](https://api.jellyfin.org/)、[DeepSeek chat completions](https://api-docs.deepseek.com/api/create-chat-completion/)。
