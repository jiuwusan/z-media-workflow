# qBittorrent → Jellyfin 媒体工作流设计

## 目标与边界

在当前空项目中使用 Koa 初始化 Node.js 服务，按 router/controller/service/util 分层，无数据库，同时配备中文 Web 管理面板。qBittorrent 自己负责 RSS 订阅和下载；下载完成后通知本服务，本服务刷新 Jellyfin，等待扫描完成，识别未匹配的电视剧/电影并确认结果。第一版包含 RSS 订阅和规则管理、工作流监控、媒体识别及人工确认；不另建 RSS 抓取器或下载引擎。

调试地址由环境变量配置，密钥仅写入被 Git 忽略的 `.env`，示例文件只包含占位符。日志、任务结果和错误响应不得暴露密钥。使用 Node.js 22+、JavaScript ESM、Koa、@koa/router、@koa/bodyparser、dotenv，HTTP 客户端使用原生 fetch。

管理面板采用 Vue 3 + Vite + Element Plus，前后端均使用 JavaScript。生产环境由 Koa 托管前端构建产物，API 与页面同源；开发环境由 Vite 代理 `/api` 和 `/health` 到 Koa。采用独立前端目录，后端保留既定四层结构。

## 已验证的环境（2026-10-02，只读探测）

- qBittorrent 地址：`https://cloud.jiuwusan.cn:36080/`，实际版本 `v5.2.3`，Bearer API key 认证成功。
- Jellyfin 地址：`https://cloud.jiuwusan.cn:36443/jellyfin/`，实际版本 `10.11.11`，X-Emby-Token 认证成功。HTTP URL 拼接必须保留 `/jellyfin/` 前缀。
- Jellyfin 扫描任务 Key 为 `RefreshLibrary`，探测时状态 `Idle`。
- 已配置 `series`（tvshows，目录 `/MediasVol3/series`，ID `8f243a977b16ae6b73de82cfadee0bc5`）、`movie`（movies，目录 `/MediasVol3/movies`，ID `18c2c541c96e0d36ab416d9eb0618fc3`）和 `skills`（musicvideos，目录 `/MediasVol3/skills`）。用户新建电影库后已再次只读验证。仅处理 Movie/Series，跳过 skills。
- 设计阶段没有执行刷新、识别写入、RSS 配置修改或 DeepSeek 付费调用；实施后的验证记录见 `../implementation-ledger.md`。

## 方案选择

推荐完成回调加单进程内存队列：通知及时，部署简单，符合不使用数据库的约束。独立串行队列避免多个下载通知同时触发全库扫描。

替代方案是定时轮询 qBittorrent 下载状态，适用于无法设置完成命令的环境，但产生额外请求及通知延迟；第一版不默认启用。第三种方案是持久化消息队列，能增强恢复能力，但需要外部依赖，暂不引入。

无数据库意味着队列、去重记录和待确认结果在进程重启后丢失；提供手动重新触发接口，明确不承诺跨重启可靠投递。队列长度、任务数量及去重保留时间均设上限。失败任务可以重试，不能被成功去重规则永久阻断。

## 分层与目录

```text
src/
  app.js                 Koa 实例和中间件装配，供测试导入
  server.js              监听、关闭信号处理
  config/index.js        环境配置解析和校验
  router/                health、qBittorrent、workflow 路由
  controller/            参数校验、状态码及响应转换
  service/
    qbittorrent.js       版本、torrent 信息/文件、RSS 订阅/规则
    jellyfin.js          刷新、任务状态、条目查询、搜索、应用、回读
    deepseek.js          名称/年份提取与结构校验
    workflow.js          编排、状态转换、串行队列、去重
  util/                  HTTP 超时、重试、路径映射、媒体名、错误、日志
scripts/                 下载完成通知脚本（无需安装到 qBittorrent 进程内）
test/                    Node test runner 测试与 mock 服务
web/
  src/
    api/                 API 客户端、认证和错误处理
    components/          任务状态、候选卡片等复用组件
    views/               概览、RSS、任务、媒体识别、连接设置
    router/              Vue Router 页面路由
  vite.config.js         开发代理和构建配置
```

router 只绑定 HTTP 方法；controller 不调用 fetch；service 不依赖 Koa ctx；util 不依赖具体业务。通过依赖注入替换第三方客户端，便于完整流程测试。

## 管理面板

### 页面和操作

1. **概览**：展示 qBittorrent/Jellyfin 连通状态和版本、DeepSeek 模型配置、电视剧/电影库、队列长度、运行中任务及待确认数量。连通检查按需调用，不在每次页面轮询时产生模型调用。
2. **RSS 管理**：订阅树、添加/删除订阅、手动刷新订阅、文章列表；下载规则列表与新建/编辑/删除，支持包含词、排除词、正则、剧集筛选、订阅来源、保存目录、下载分类及启用状态。参数对应 qBittorrent 原生规则，不自建规则引擎。删除订阅/规则在面板中确认后执行，不自动删除 torrent 或媒体文件。
3. **任务管理**：列出任务类型、hash、阶段、状态和时间；详情展示扫描、名称提取、候选搜索、应用、验证的进度及每个媒体的结果。支持手动触发扫描、dryRun 预览和失败重试；刷新页面能恢复当前进程保留的任务。明确显示历史仅保存在当前服务进程内。
4. **媒体识别与确认**：分页展示目标库的未识别 Series/Movie，包括原名称、文件夹/文件名和可用年份。支持选择条目发起 dryRun 或识别任务。待确认项展示 DeepSeek 提取结果、Jellyfin 候选名称、年份、提供方和 ID；用户选择候选后执行应用并回读确认，显示确认失败的具体阶段。无候选时允许编辑搜索名称/年份后重新搜索，不允许从浏览器提交任意 provider 数据。
5. **连接与通知设置**：展示脱敏的三方地址、密钥是否配置、模型、库目录和路径映射，支持只读连通检查。提供下载完成回调地址、通知脚本用法和命令模板复制；模板不包含三方密钥。本版在 `.env` 中维护连接凭据和路径配置，页面说明修改后重启生效，不提供浏览器写入 `.env` 的功能。

采用侧边导航和任务状态标签，桌面以表格为主，小屏可折叠导航；长路径和候选名称可完整展开。每页具备加载、空数据、权限失效、请求失败和重试状态。用户触发识别时明确区分“预览候选”和“识别并应用”。

### 管理认证和轮询

登录页输入独立的管理令牌 `ADMIN_API_TOKEN`。服务端验证后签发短期 HttpOnly、SameSite=Strict 会话 cookie，生产 HTTPS 下使用 Secure；服务端会话仅保存在内存中，退出、过期或服务重启后重新登录。所有 cookie 认证的写入请求校验同源 Origin 并使用 CSRF token，限制登录尝试频率。管理令牌和三方密钥均不写入前端代码、localStorage 或页面 URL。

回调和脚本使用独立的 `WORKFLOW_API_TOKEN`，仅允许下载完成通知，不能管理 RSS 或确认媒体。运维 API 可用管理 Bearer token 认证；面板使用会话认证。生产默认同源，不开放通配 CORS。

任务列表/详情在页面可见时每 3 秒轮询，离开页面或隐藏标签页时暂停，终态停止详情轮询。服务端提供分页任务列表和聚合概览，避免前端重复全库查询。

## 下载通知和定位

`POST /api/webhooks/qbittorrent/completed`，使用单独的 `WORKFLOW_API_TOKEN` 认证。主要输入为 torrent hash，支持可选 category/type。返回 202 与 jobId；相同 hash 正在排队或处理时返回已有 jobId。客户端通过任务查询接口获得结果。

通知脚本由 qBittorrent 的“下载完成后运行外部程序”执行，使用 hash 占位符传参。脚本读取自身环境配置和回调地址，不把用户提供的三方密钥拼入外部命令；提供 Windows 与 Linux/Docker 配置说明。不自动修改远程 qBittorrent 的外部命令配置。

接收回调后从 qBittorrent 读取 torrent 和文件清单，验证下载完成。跨容器路径通过显式 `QBT_PATH_PREFIX` → `JELLYFIN_PATH_PREFIX` 映射处理，规范化 POSIX/Windows 分隔符并按路径段比较，避免误匹配相似前缀。类别或目标媒体库用于确定 Movie/Series；无法确定时任务进入 needs_review，不猜测。

电视剧使用 Jellyfin Series 目录名称；回调指向单集或 Season 子目录时，沿 Jellyfin 的父条目关系定位 Series，不能把季目录当剧名。电影使用每个实际视频文件的文件名（去除扩展名），支持一个 torrent 多部电影。

## 扫描与未识别条目

通过 Jellyfin 刷新接口触发扫描，轮询 RefreshLibrary 任务。发起前读取 LastExecutionResult，发起后必须观察运行状态或新的执行结果，不能把触发后第一次 Idle 当作刷新完成。已有扫描运行时等待其结束，再触发本轮扫描，防止下载内容在先前扫描之后落盘而漏扫。

状态轮询有总超时；任务取消、失败或超时应使 workflow 失败，不能继续识别。使用任务执行状态和结果判断完成，不用固定 sleep 推测完成。

扫描完成后分页查询 Movie 和 Series 的 Path、ProviderIds、ProductionYear 等字段。默认只处理本次下载路径相关条目；提供独立手动任务扫描配置范围内所有未识别条目。未识别定义为缺少配置认可的媒体提供方 ID（例如 Tmdb/Tvdb/Imdb），不能只看名称或海报。文件未入库视为 ingest_pending，可有限重试后返回明确原因。

## DeepSeek 与 Jellyfin 识别确认

调用 DeepSeek chat completions，模型名可配置；部署前查询可用模型，不依赖固定别名长期有效。系统提示词明确将文件名作为数据，要求 JSON 输出 `{name, year}`，年份允许 null，剥离分辨率、编码、发布组、集数等噪声。服务端校验非空名称、年份合理范围和返回结构；失败不能退化为任意名称写入。

使用提取的名称及可选年份调用 Jellyfin Movie/Series RemoteSearch。对候选名称规范化比较（Unicode、大小写、空白和标点），若有年份则校验年份，合并相同 provider ID 的重复候选。仅唯一且符合条件的候选自动应用；无匹配、重名、多候选和年份冲突返回 needs_review，包含候选名称、年份和 ProviderIds。

应用 Jellyfin 搜索结果后，有限轮询回读条目，确认 ProviderIds 与所选候选一致，同时检查名称和候选存在的年份。仅 HTTP 成功不足以标记 completed。电视剧按 Series 应用，并触发子条目刷新；电影按 Movie 应用。手动确认接口只接受任务中记录的 candidateId，并重新验证该任务对应的 itemId，不能接受任意远程搜索对象。

## HTTP 接口

- `GET /health`：本服务存活；另提供受保护的三方只读检查接口。
- `POST /api/auth/login`、`POST /api/auth/logout`、`GET /api/auth/session`：管理面板会话和 CSRF token。
- `GET /api/dashboard`：任务统计、脱敏连接配置及库信息。
- `POST /api/connections/check`：按需执行三方只读检查，DeepSeek 仅查询可用模型。
- `GET /api/qbittorrent/rss`：RSS 配置查询。
- `POST /api/qbittorrent/rss/feeds`：创建指定订阅。
- `DELETE /api/qbittorrent/rss/feeds`：按订阅路径删除。
- `POST /api/qbittorrent/rss/refresh`：手动刷新订阅。
- `GET /api/qbittorrent/rss/rules`：读取下载规则。
- `PUT /api/qbittorrent/rss/rules/:name`：设置用户指定下载规则。
- `DELETE /api/qbittorrent/rss/rules/:name`：删除指定规则。
- `POST /api/webhooks/qbittorrent/completed`：完成通知入队。
- `GET /api/media/unidentified`：分页读取目标库未识别条目。
- `GET /api/workflows`：分页查询内存任务列表。
- `POST /api/workflows/scan`：手动扫描未识别媒体，支持 dryRun、指定库和 itemIds；服务端校验条目属于目标库。
- `GET /api/workflows/:jobId`：查询状态、候选和每项识别结果。
- `POST /api/workflows/:jobId/retry`：重试失败任务。
- `POST /api/workflows/:jobId/search`：对待确认条目用用户修正的名称/年份重新搜索，更新服务端保存的候选。
- `POST /api/workflows/:jobId/confirm`：确认待处理条目的候选并回读验证。

除存活检查和登录外要求认证，管理接口和下载回调按上述权限分离。任务状态包括 queued、running、completed、needs_review、failed，另记录细分阶段与每项结果。一个条目失败不丢失其他条目的成功结果；队列拥塞返回 429/503。

## 错误、运行与验证

第三方请求设超时，网络错误及 429/5xx 有上限退避重试；不自动重试有歧义的元数据写入，先回读判断实际结果。使用结构化日志记录 jobId、itemId、阶段和脱敏错误。支持 graceful shutdown，停止接收新任务并等待当前任务至关闭上限。

提供 `.env.example`、锁文件、README、前后端开发/构建/生产运行命令和通知脚本。README 说明面板登录、媒体库目录映射、RSS 配置、扫描等待机制、歧义确认和内存队列限制。Koa 静态页面回退不得吞掉 `/api` 的 404，也不得提供项目源文件或 `.env`。

使用 Node test runner 和 mock HTTP 服务验证：URL 子路径保留、认证头、回调校验和去重、扫描 Idle 竞态/超时/失败、分页、电视剧季目录定位、电影批量文件、名称年份 JSON 校验、零/单/多候选、应用后 provider ID 验证、失败重试、日志不含密钥。真实环境先执行只读检查；写入联调应使用明确的目标任务，dryRun 可以先展示候选。

管理面板验证包含生产构建、登录/退出/过期、CSRF 和回调权限隔离、RSS 规则保存参数、任务轮询停止、候选确认及搜索名称修改。使用 mock 环境验证会改动 RSS/元数据的 UI 操作；真实环境先验证库列表和候选预览。检查桌面及小屏布局、空列表和请求错误显示。

## 实施前需要确认的默认选择

采用上述 JavaScript ESM、Vue 3 管理面板、Koa 同源部署、回调触发、内存串行队列和唯一匹配自动应用的方案。电视剧库和电影库均已验证，库 ID 与目录写入本地环境配置。qBittorrent 与 Jellyfin 路径映射以环境配置解决；电视剧和电影流程均纳入联调范围。

## 官方接口参考

- qBittorrent API key：https://github.com/qbittorrent/wiki/blob/master/API-Key-Authentication-%28%E2%89%A5v5.2.0%29.md
- qBittorrent WebAPI：https://github.com/qbittorrent/qBittorrent/wiki/WebUI-API-%28qBittorrent-5.0%29
- Jellyfin API：https://api.jellyfin.org/（以服务版本实际接口/schema 为准）
- DeepSeek JSON/chat completions：https://api-docs.deepseek.com/api/create-chat-completion/
