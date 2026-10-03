# z-media-workflow

Koa + Vue 3 媒体工作流与中文管理面板，无数据库。qBittorrent RSS 下载完成后发送回调，服务等待 Jellyfin 媒体库刷新完成，使用 DeepSeek 从电视剧文件夹或电影文件名中提取名称及可选年份，调用 Jellyfin 搜索并应用唯一可靠候选，最后回读确认提供方 ID、名称和年份。歧义候选由管理面板人工选择。

## 本地启动

需要 Node.js 22+。在项目根目录执行：

```powershell
npm ci
npm ci --prefix web
# 首次部署且没有 .env 时：复制 .env.example 为 .env 并填写凭据
npm run build
npm start
```

打开 http://localhost:30001，使用 `.env` 的 `ADMIN_API_TOKEN` 登录。当前调试环境已写入被 Git 忽略的 `.env`，管理和回调令牌分别随机生成；不在文档或构建产物中记录真实令牌。

开发时分别运行 `npm run dev` 与 `npm run dev:web`，打开 http://localhost:5173。默认 DEV_ORIGIN 允许该来源；改端口时同步调整 `.env`。生产配置 `NODE_ENV=production`、实际 `PUBLIC_URL`，HTTPS 时设置 `COOKIE_SECURE=true`；代理部署时按环境设置 `TRUST_PROXY`。面板与 API 使用同源部署。

## Docker Compose 部署

参考 `senior-buyer`，使用 `jiuwusan/z-media-workflow:latest` 镜像、外部 `wk` 网络和 `restart: always`。镜像基于 Node.js 22，分阶段构建 Vue 面板及后端生产依赖，由非 root 用户运行 Koa，内置 `/health` 健康检查。管理面板和 API 共用一个容器，宿主机默认端口为 **30001**。

在部署机器安装 Docker Engine / Docker Desktop 和 Compose v2，复制项目代码。首次部署将 `.env.example` 复制为 `.env` 并填写各服务密钥、管理令牌及回调令牌；已有 `.env` 时保留配置。在 `.env` 中追加或调整：

```dotenv
DOCKER_IMAGE=jiuwusan/z-media-workflow:latest
DOCKER_HOST_PORT=30001
DOCKER_PUBLIC_URL=http://你的服务器地址:30001/
DOCKER_STOP_GRACE_PERIOD=35s
```

使用 HTTPS 反向代理时，`DOCKER_PUBLIC_URL` 填外部 HTTPS 地址，设置 `COOKIE_SECURE=true`；受信任代理转发时设置 `TRUST_PROXY=true`。Compose 会将容器内 `HOST`、`PORT`、`NODE_ENV` 固定为 `0.0.0.0`、`3000`、`production`，并用 `DOCKER_PUBLIC_URL` 覆盖本地开发的 `PUBLIC_URL`。修改宿主机端口时同步修改 `DOCKER_PUBLIC_URL`。

在项目根目录执行：

```sh
# 与 senior-buyer 共用 wk；网络已存在时跳过创建
docker network ls --filter name=wk
docker network create wk
docker compose config --quiet
docker compose up -d --build
docker compose ps
docker compose logs -f --tail=100
```

打开 `http://你的服务器地址:30001/`，使用 `.env` 的 `ADMIN_API_TOKEN` 登录。qBittorrent 完成通知脚本的 `WORKFLOW_CALLBACK_URL` 填 `http://你的服务器地址:30001/api/webhooks/qbittorrent/completed`；如果 qBittorrent 容器也在 `wk` 网络，可用 `http://z-media-workflow:3000/api/webhooks/qbittorrent/completed`。通知脚本仍应在 qBittorrent 所在机器/容器运行。

更新代码后执行 `docker compose up -d --build`。查看三方连接可执行 `docker compose exec z-media-workflow npm run check:connections`。使用已发布镜像时执行 `docker compose pull` 和 `docker compose up -d --no-build`；本项目只配置镜像名，不会自动发布镜像。

`.env` 通过 Compose 在运行时注入，已从构建上下文排除。服务通过远程 API 操作媒体，无需挂载媒体目录或数据库。日志输出到 Docker，单个日志文件最多 10 MB，保留 3 个。任务记录和登录会话保存在内存，重建/重启容器后重新登录、重新扫描；默认关闭等待为 30 秒，调整 `SHUTDOWN_TIMEOUT_MS` 时应将 `DOCKER_STOP_GRACE_PERIOD` 设置得更长。

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

在管理面板“连接与通知”中，可以读取 qBittorrent 当前的完成通知开关和命令、生成 Windows / Linux 命令模板、编辑后保存。保存只更新 `autorun_enabled` 与 `autorun_program`，并回读确认；生成模板不会自动保存。

当前 qBittorrent 容器的回调地址为 `http://172.29.0.1:30001/api/webhooks/qbittorrent/completed`。服务须监听 `0.0.0.0`，Docker 发布端口为 `30001:3000`，其内部端口仍为 `3000`。容器已有 curl 时使用下面的 curl 配置，不需要 Node.js 或通知脚本。纯 v2 torrent 将命令中的 `%I` 改为 `%J`；不要使用 `%K`（Torrent ID）。

### curl 通知（当前容器使用）

当前内网部署设置 `WEBHOOK_AUTH_ENABLED=false`，仅取消下载完成回调的 token 校验，管理面板及管理 API 仍需认证。无需 `.env.notify.curl`，在“torrent 完成时运行”填写下面的单行命令，或在管理面板直接生成并保存：

```text
curl -q --fail --silent --show-error --connect-timeout 5 --max-time 15 --retry 2 --retry-connrefused --data-urlencode "hash=%I" "http://172.29.0.1:30001/api/webhooks/qbittorrent/completed"
```

`.env` 与 Compose 中均已设置内网模式。关闭回调认证时无需设置 `WORKFLOW_API_TOKEN`。需要恢复回调认证时设置 `WEBHOOK_AUTH_ENABLED=true`、填写独立回调令牌并重启服务，再使用下面的配置文件方式。直接运行 `npm start` 且没有指定该选项时，仍默认校验 token。

#### 启用 token 校验时的 curl 配置（可选）

复制 `scripts/notify-completed.curl.example` 为 **qBittorrent 容器内** `/config/z-media-workflow/.env.notify.curl`，将 `header` 中的占位值改为服务端 `.env` 的独立 `WORKFLOW_API_TOKEN`。已填写令牌的本地 `scripts/.env.notify.curl` 被 Git 忽略，部署时复制该文件即可。按实际持久化挂载修改路径，让 qBittorrent 运行用户可读，并设置 `chmod 600`。

启用回调认证时，在管理面板选择“curl（无需 Node.js）”，填写上述配置文件路径，生成通知命令并保存启用。也可在截图对应的“torrent 完成时运行”中填写：

```text
curl -q --config "/config/z-media-workflow/.env.notify.curl" --data-urlencode "hash=%I"
```

令牌保存在配置文件中，不出现在完成命令或 curl 参数中。回调接口支持 URL 编码表单与原有 JSON；启用 curl 的失败状态检测、连接/请求超时和限量重试，HTTP 4xx/5xx 不会被误报为成功。不要给配置添加 `location`，避免向重定向目标转发请求。

在容器内只读检查服务可达性：

```sh
curl -q --fail --show-error --connect-timeout 5 --max-time 15 http://172.29.0.1:30001/health
```

### Node.js 通知（可选）

在 **qBittorrent 所在机器/容器** 部署 `scripts/notify-completed.mjs`（只依赖 Node.js 22+，无需安装 npm 包）。复制 `scripts/.env.notify.example` 为脚本同目录的 `.env.notify`，填入：

```dotenv
WORKFLOW_CALLBACK_URL=http://172.29.0.1:30001/api/webhooks/qbittorrent/completed
WORKFLOW_API_TOKEN=服务端.env中的独立回调令牌
```

地址必须可从 qBittorrent 所在机器访问。服务默认监听 127.0.0.1；跨机器调用时将 `HOST` 改为可访问地址，如 `0.0.0.0`，设置实际 `PUBLIC_URL` 并按部署环境开放端口。

qBittorrent 设置 → 下载 → 下载完成后运行外部程序：

Windows：

```text
node "E:\personal\z-media-workflow\scripts\notify-completed.mjs" "%I"
```

Linux / Docker（容器有 Node.js 时，按实际路径调整）：

```text
node /opt/z-media-workflow/scripts/notify-completed.mjs "%I"
```

可选增加 `Movie` 或 `Series` 参数，仅当这套通知明确只用于一种媒体类型。混合下载通常无需参数，按入库条目识别类型。Docker 需确保容器内存在 Node.js、脚本及配置，并能访问服务；宿主机 localhost 与容器 localhost 不等同。通知命令和 RSS 规则只在面板明确保存时更新。

将 `scripts/notify-completed.mjs` 和配置好的 `.env.notify` 部署在 qBittorrent 容器同一目录，例如 `/opt/z-media-workflow/scripts/`，完成命令填写 `node "/opt/z-media-workflow/scripts/notify-completed.mjs" "%I"`。该路径是模板，需按实际挂载修改。只在工作流容器中放置脚本，无法让另一容器的 qBittorrent 执行它。启用后仅对后续下载完成事件生效；已完成媒体可在面板手动扫描。

脚本对网络/429/5xx 限量重试；API 对 hash 去重。hash 支持 v1 40 位或 v2 64 位十六进制。启用回调认证时使用 WORKFLOW_API_TOKEN，不能操作管理 API；内网模式的下载回调不需要令牌，仍校验 hash 和媒体类型。

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
| GET / PUT | `/api/qbittorrent/completion-notification` | 读取/保存下载完成通知 `{ enabled, program }` |
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

部分剧集提供方只返回 PremiereDate，不返回 ProductionYear；服务会从有效首播日期提取候选年份，区分同名不同年份的剧集。剧集回读缺少 ProductionYear 时，同样使用有效首播年份核对；明确的年份冲突或年份依据缺失不会通过校验。应用请求若超时，仍会先回读检查实际结果，名称、年份和提供方 ID 验证通过后才标记完成。

```powershell
npm test
npm run build
npm run test:ui
npm run check:connections
```

单元/API 测试和浏览器测试使用本地 mock，不更改实际 RSS 或 Jellyfin 元数据。`check:connections` 只读查询版本、可用模型、库及媒体回读，不调用模型生成，不触发扫描。浏览器测试默认使用本机 Edge，可通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定 Chromium；没有浏览器时执行 `npx playwright install chromium`。

官方接口参考：[qBittorrent API key](https://github.com/qbittorrent/wiki/blob/master/API-Key-Authentication-%28%E2%89%A5v5.2.0%29.md)、[qBittorrent WebAPI](https://github.com/qbittorrent/qBittorrent/wiki/WebUI-API-%28qBittorrent-5.0%29)、[Jellyfin API](https://api.jellyfin.org/)、[DeepSeek chat completions](https://api-docs.deepseek.com/api/create-chat-completion/)。
