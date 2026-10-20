# z-media-workflow

Koa + Vue 3 媒体工作流与中文管理面板，使用 SQLite 持久化任务。qBittorrent RSS 下载完成后发送回调，服务只向种子视频文件所属的 Jellyfin 媒体库提交增量刷新，按配置等待（默认 10 秒）后检查所有电影、电视剧库中的待识别媒体，使用 DeepSeek 从电视剧文件夹或电影文件名中提取名称及可选年份，调用 Jellyfin 搜索并优先应用规则唯一匹配的候选；无法确定时由 AI 判断候选，仍无法确定时临时应用第一个有效且年份匹配的候选。通过元数据更新接口保存所选名称、年份和外部 ID 后即完成，再将元数据刷新加入 Jellyfin 队列，不等待刮削和图片加载结束。

## 本地启动

需要 Node.js 22.13.0+。在项目根目录执行：

```powershell
npm ci
npm ci --prefix web
npm run build
npm start
```

打开 http://localhost:3000。没有 `data/config.json` 时，服务监听 `0.0.0.0:3000` 并显示首次运行引导：创建管理员账号（密码至少 8 位）、填写 qBittorrent / Jellyfin / DeepSeek 的地址和 API 密钥、确认面板及回调地址。保存后自动生成回调令牌，并立即进入登录页，无需重启。已有配置时直接进入正常登录；现有本地配置会继续使用。

开发时分别运行 `npm run dev` 与 `npm run dev:web`，打开 http://localhost:5173。在 JSON 中填写实际 `PUBLIC_URL`，HTTPS 时设置 `COOKIE_SECURE: true`；代理部署时按环境设置 `TRUST_PROXY`。面板与 API 使用同源部署。

服务地址、API 密钥、管理员账号、认证开关、目录映射、超时、队列限制、游标文件路径和清理开关统一保存到固定的 `data/config.json`，完整字段见 `config.example.json`。布尔值与数字使用 JSON 原生类型；其他配置修改后重启生效，页面保存的清理开关即时生效。应用与通知脚本不读取环境变量或旧 `.env`，不再执行环境配置迁移；仍只有旧 `.env` 的部署需通过引导重新填写。配置文件包含凭据，被 Git 和镜像构建排除。

首次配置完成后，引导接口关闭，不能覆盖已有文件；提交需有效的初始化 cookie 和 CSRF token。配置文件损坏或字段无效会阻止启动，避免误进入初始化流程。首次运行阶段 `/health` 仍正常响应，业务 API 返回 503，直到配置完成。

```json
{
  "ADMIN_USERNAME": "admin",
  "ADMIN_PASSWORD": "填写管理员密码"
}
```

旧的 `ADMIN_API_TOKEN` 已停用。登录接口接受 `{ "username", "password" }`，成功后创建 HttpOnly 会话，密码使用 scrypt 比对；错误的用户名或密码返回相同提示，保留登录尝试限制。修改账号或密码后重启服务，旧会话失效。下载回调是否校验 token 仍由 `WEBHOOK_AUTH_ENABLED` 独立控制。

登录及管理 API 不限制请求的 Origin，允许通过内网 IP、域名或 localhost 访问；登录仍需用户名/密码，管理操作仍需会话及 CSRF 校验。旧的 `DEV_ORIGIN` 不再使用。JSON 中的 `PUBLIC_URL` 用于推导默认回调地址，不再用于限制登录来源；`WORKFLOW_CALLBACK_URL` 可单独设置为 qBittorrent 容器可达的回调地址，当前为 `http://172.29.0.1:3000/api/webhooks/qbittorrent/completed`。未指定回调地址时从 `PUBLIC_URL` 推导。

## Docker Compose 部署

参考 `senior-buyer`，使用 `jiuwusan/z-media-workflow:latest` 镜像、外部 `wk` 网络和 `restart: always`。镜像基于 Node.js 22，分阶段构建 Vue 面板及后端生产依赖，由非 root 用户通过 `pm2-runtime` 以单进程 fork 模式运行 Koa，内置 `/health` 健康检查。管理面板和 API 共用一个容器，宿主机默认端口为 **3000**。

部署机器只需 Docker Engine / Docker Desktop、Compose v2 和 `docker-compose.yml`，无需 `.env` 或预先复制配置文件。启动容器后打开面板，按首次运行引导填写并保存。已有持久卷中的 `/app/data/config.json` 时直接使用。Compose 固定镜像、端口和停止等待时间；需要调整时直接编辑 YAML 对应字段。

Docker 配置中的 `HOST` 使用 `0.0.0.0`、`PORT` 使用 `3000`；引导中的面板访问地址填外部可访问地址。HTTPS 代理时可在 JSON 中设置 `COOKIE_SECURE: true`，受信任代理转发时设置 `TRUST_PROXY: true`。修改宿主机端口时同步修改 JSON 中的 `PUBLIC_URL`。

在项目根目录执行：

```sh
# 与 senior-buyer 共用 wk；网络已存在时跳过创建
docker network ls --filter name=wk
docker network create wk
docker compose config --quiet
docker compose pull
docker compose up -d
docker compose ps
docker compose logs -f --tail=100
```

打开 `http://你的服务器地址:3000/`，使用 JSON 中的 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 登录。qBittorrent 完成通知脚本的 `WORKFLOW_CALLBACK_URL` 填 `http://你的服务器地址:3000/api/webhooks/qbittorrent/completed`；如果 qBittorrent 容器也在 `wk` 网络，可用 `http://z-media-workflow:3000/api/webhooks/qbittorrent/completed`。通知脚本仍应在 qBittorrent 所在机器/容器运行。

GitHub Actions 发布新镜像后，执行 `docker compose pull` 和 `docker compose up -d` 更新服务。查看三方连接可执行 `docker compose exec z-media-workflow npm run check:connections`。

服务通过远程 API 操作媒体，无需挂载媒体目录。Compose 将 `workflow-data` 命名卷挂载到 `/app/data`，更新镜像或重建容器后保留配置、游标及 SQLite 工作流数据；`docker compose down -v` 会删除该卷。修改容器配置时可先 `docker cp z-media-workflow:/app/data/config.json ./config.json`，停服务后编辑并复制回同一路径，再重启；复制回后确保 `node` 用户可读。日志输出到 Docker，单个日志文件最多 10 MB，保留 3 个。任务记录、候选和队列保存在配置目录的 `workflow.sqlite`，登录会话仍在内存，重启后重新登录；默认关闭等待为 30 秒，调整 JSON 中的 `SHUTDOWN_TIMEOUT_MS` 时应将 Compose 的 `stop_grace_period` 设置得更长。

## GitHub Actions 发布镜像

工作流位于 `.github/workflows/docker-publish.yml`，沿用 `senior-buyer` 的 Docker Hub 账号和发布方式，使用 [Docker 官方 GitHub Actions](https://docs.docker.com/guides/gha/)。

1. 在 Docker Hub 创建 `jiuwusan/z-media-workflow` 仓库，并生成有该仓库写入权限的访问令牌。
2. 在 GitHub 仓库 **Settings → Secrets and variables → Actions** 配置 Secret `OCKERHUB_USERNAME`（当前约定名称，值为 Docker Hub 用户名）和 `DOCKERHUB_TOKEN`（Docker Hub 访问令牌）。用户名也兼容 `DOCKERHUB_USERNAME`；两者同时存在时优先使用 `OCKERHUB_USERNAME`。账号需有 `jiuwusan/z-media-workflow` 的推送权限。媒体服务的 API 密钥和管理员密码无需配置到 Actions。
3. 推送代码至 `master`，或在 **Actions → Build and Push Docker Image → Run workflow** 手动触发。

流程先运行 `npm test`，通过后从 Dockerfile 构建 `linux/amd64` 和 `linux/arm64` 镜像并推送到 Docker Hub。`master` 发布 `latest`、`master` 和 `sha-<提交短哈希>` 标签；手动构建其他分支发布分支和提交标签，不覆盖 `latest`。PR 运行测试和镜像构建，不登录 Docker Hub、不推送镜像。

部署默认拉取 `jiuwusan/z-media-workflow:latest`；需要固定版本时，修改 Compose 的 `image` 为对应提交标签后执行 `docker compose pull` 和 `docker compose up -d`。

## 面板

- 概览：任务统计、服务连接检查、目标库和近期任务。
- 媒体库：查看全部电影、电视剧（含已识别条目），按媒体库、类型、名称筛选，手动纠正识别结果。
- 订阅管理：添加、删除、刷新 RSS 订阅源并浏览文章。
- 下载规则：独立管理原生自动下载规则，支持新增、编辑、删除、启停、正则匹配、包含/排除条件、分类下拉选择及适用订阅源勾选。其余选项新建时使用 qBittorrent 默认值，编辑时保留原值与匹配历史。
- 任务管理：扫描状态、每项识别结果、失败重试。
- 媒体识别：分页查看未识别条目，预览或自动识别选中条目/目标库。
- 任务详情：查看名称提取和 Jellyfin 候选，人工确认，或修改名称/年份后重新搜索。
- 种子清理：预览和清理文件丢失种子，保存是否同时删除下载文件的设置。
- 基础配置：编辑服务连接、管理员账号、访问地址和运行参数，查看待重启状态。
- 命名检查：按添加时间倒序列出种子，选择具体种子检查并补齐缺少的季号，查看任务进度和结果。
- 种子通知：设置新增种子和下载完成通知，生成回调命令。

初始化完成后，可进入左侧“基础配置”后直接编辑表单中的服务连接、管理员账号、面板/监听地址、认证开关、目录映射和运行参数。已保存的密码和 API 密钥不会回传到页面，输入框留空表示保留原值；修改管理员密码需要再次确认，至少 8 位。配置保存到同一 `data/config.json`，基础配置需重启服务生效，页面会持续提示尚未生效的改动；重启后使用新账号登录。连接检查使用当前运行配置，保存后尚未重启时仍检查原连接。清理文件删除开关继续即时生效。

在容器内由 PM2 管理时，“基础配置”页面可点击“重启服务”。请先保存所有修改，再确认重启；有排队、执行中、待确认的工作流或正在执行的种子清理时会拒绝重启。接口校验当前已保存的配置版本并停止接收新任务，先返回响应，再让应用优雅退出，由 PM2 自动拉起新的应用进程，容器本身继续运行。页面只有检测到新的进程实例就绪后才跳转登录页，旧进程的健康响应不会被误判为成功。任务历史、候选、排队操作、媒体游标及保存的 JSON 配置保留，登录会话失效。页面未保存的修改不会随重启生效。

Docker 入口使用 `ecosystem.config.cjs`（`instances: 1`、`exec_mode: fork`、`watch: false`、`autorestart: true`），不使用多进程/集群模式，以确保工作流只有一个队列消费者。PM2 设置 `max_memory_restart: 256M`，应用进程 RSS 内存超过 256 MiB 时自动重启；PM2 默认约每 30 秒检查一次，因此不是达到阈值瞬间触发的硬内存限制。内存触发的重启由 PM2 直接执行，不经过页面的任务检查；应用仍尝试优雅关闭，超时未完成的工作流在下次启动时核对外部状态，执行结果不明确的写入保留为中断任务等待处理；排队操作、待确认结果和历史持久保留，登录会话失效。PM2 停止等待时间为 35 秒，Compose 停止等待时间为 45 秒；修改 `SHUTDOWN_TIMEOUT_MS` 时应同步调整这两个等待时间。镜像升级到 PM2 版本需要重建容器一次，之后普通配置变更可直接在页面重启应用。直接 `npm start` 或 `npm run dev` 不受 PM2 管理，页面会禁用重启按钮；Linux 下也可用 `npm run start:pm2` 启动。PM2 进程元数据仅用于识别运行方式，业务配置仍只读取 `data/config.json`。修改 `HOST`、`PORT` 或代理地址时，仍需同步更新 Docker 端口映射/反向代理并使用正确的新地址；页面等待恢复最多 60 秒，超时会提示检查服务。

配置编辑不依赖三方连接检查成功，连接错误时仍可打开并修正配置。读取与保存仅允许已登录管理员，保存需要 CSRF 校验。配置在编辑期间被其他页面或清理设置修改时，拒绝覆盖并提示重新读取。

Docker 健康检查使用启动时写入 `data/runtime.json` 的实际监听地址。保存新端口后，健康检查继续访问当前运行端口，重启后随监听地址更新。该文件仅包含运行地址，属于运行数据。

“媒体库”位于左侧“概览”下方，使用竖版海报墙展示电影和电视剧，手机端每行两张。海报由服务端代理 Jellyfin 主图，浏览器不会获得 Jellyfin API 密钥；图片缺失或加载失败时显示占位卡片。每张卡片显示名称、年份、媒体库及文件名，可通过“识别”打开手动纠错弹窗。媒体库名称优先读取对应媒体库条目的显示名称，与 Jellyfin 首页一致；名称为空或读取失败时回退到媒体库配置名称。列表默认将各库媒体合并后按 Jellyfin 添加时间 `DateCreated` 倒序排序，再分页；添加时间相同以媒体 ID 稳定排序，缺失或无效时间排在最后。还可切换添加时间正序、名称正序、年份倒序，缺失年份同样排在最后。每项“识别”在当前页打开纠错弹窗，可修改名称和可选年份后搜索 Jellyfin 候选，仅在手动选择并确认后保存名称、年份和外部 ID；即使只有一个候选也不会自动应用。取消或关闭搜索不会修改元数据。保存后刷新列表，保留筛选条件、排序及页码；若结果减少导致当前页不存在，则显示最后一页。纠错直接处理所选媒体，不受识别游标限制、不修改游标、不触发媒体库扫描，也不依赖 DeepSeek。确认后仅将所选条目的元数据刷新提交到 Jellyfin 后台。纠错任务可在任务管理中查看；失败任务重试只重新搜索候选，仍需手动确认。

“预览候选”和“识别并应用”直接读取 Jellyfin 现有媒体条目，不触发全库扫描；失败的媒体识别任务重试也不触发全库扫描（包括下载完成任务的重试）。首次下载完成通知只刷新种子视频文件所属的媒体库，按 `LIBRARY_REFRESH_WAIT_MS` 等待（默认 10 秒）后开始识别，不轮询扫描状态。应用候选后仍提交对应条目的后台元数据刷新。“预览候选”会调用 DeepSeek，但不应用元数据；“识别并应用”先自动写入名称及可选年份匹配的唯一候选；规则无法确定时，由 DeepSeek 根据原始名称、类型、年份和候选信息进行二次判断，优先应用高置信度且属于 Jellyfin 返回列表的候选。AI 无法确定、输出无效或调用失败时，按 Jellyfin 返回顺序临时应用第一个有有效外部 ID 且年份匹配的候选，任务详情会标明临时选择。名称提取没有年份时不限制候选年份；没有有效且年份匹配的候选时仍进入待确认。保存临时选择结果成功后同样推进识别游标，后续不会自动纠正该选择。预览可展示 AI 推荐及理由，但不应用元数据。任务信息只在当前服务进程内保留，重启后需要重新扫描。

电影名称提取会清理标题末尾明确的版本标签（如 Extended Cut、Director's Cut），并将 PartI / PartII 分隔为 Part I / Part II，保留分部号。带明确英文分部号的电影优先用英文数字词搜索（如 Part One），避免 Part I 在提供方搜索中混入其他同年分部；没有有效且年份匹配的候选时，才补查原写法、罗马数字和阿拉伯数字等价写法。查询沿用原年份，提取结果和原始分部号不变，不删除分部号、不翻译或补造标题。原始文件名保留供 AI 判断；补查失败会在任务详情显示提示。

剧集无有效同年候选时，会补查不带年份的节目候选。AI 可结合资源季号/季度副标题、资源年份、候选名称及简介和作品知识，核实是否属于首播更早的同一节目的后续季；仅高置信度确认第2季及以后且年份关系成立时，允许选择节目首播年份不同的候选，并在任务详情显示季数、资源年份、节目首播年份及依据。名称和资源年份提取仍仅来自文件夹原文，不改写；电影、第一季或无法核实后续季关系时仍保留年份约束。年份不同的候选不走“临时选择第一个”的兜底，未确认则等待人工处理。预览模式不应用结果，也不推进游标。

AI 仅从原始文件名或文件夹名清洗提取名称和年份，不借助影视知识补全、翻译或替换作品名称。原文含中文作品标题时仅提取中文标题，否则保留原文名称；中文发布组或字幕标签不算作品标题。年份只使用原文明示的年份，缺失或无法明确判断时返回 null，不推断首映或首播年份。候选判断支持中文译名与外文原名匹配，任务详情展示 AI 推荐和判断理由。

规则命中外文候选后，仍会检查同年份的中文候选。共同提供方 ID 一致且没有其他 ID 冲突时，优先应用中文候选；无法由 ID 确认时交给 AI 判断，仅高置信度确认才改选中文候选。年份不同或共同提供方 ID 冲突的候选不参与该优选。AI 不确定、返回无效选择或调用失败时，保留原规则匹配结果。仅有外文候选或已命中中文候选时，不增加 AI 请求。


## 已识别媒体游标

本地默认文件为 `data/media-cursors.json`，可通过 `MEDIA_CURSOR_FILE` 修改；Compose 固定使用 `/app/data/media-cursors.json`。启动时读取一次到内存，更新后同步写入临时文件并替换原文件。文件损坏会阻止启动，避免静默重置游标。

每个 Jellyfin 服务、媒体库和类型分别保存游标。剧集按“节目添加日期”、电影按“加入日期”倒序查询，均使用 `DateCreated`，不会用最近加入单集的日期替代节目的添加日期。首次无游标时处理现有全部电影和剧集，包括 Jellyfin 已有 Tmdb / Tvdb / Imdb ID 的条目；列表中的“未识别”指尚未被工作流确认。候选成功提交到 Jellyfin 后即确认识别结果并推进游标，不轮询等待媒体名称、年份、提供方 ID 等元数据加载完成。应用请求失败时保留待处理状态。

后续处理添加日期晚于游标的媒体、游标日期相同但尚未确认的媒体，以及保留的失败／待确认条目。整批待处理 ID 会先保存，避免较新媒体成功后漏掉较早的失败项；预览候选不推进游标。新增媒体库自动从首次全量开始，删除的媒体库不会再查询。当前仍分页读取库列表，但仅对上述条目调用 AI 识别。

日期游标依赖 Jellyfin 的添加日期设置。如果选择“使用文件创建日期”，新导入的旧文件可能早于游标；建议选择“使用加入媒体库时的扫描日期”。需要重新处理全部存量时，停止服务、备份并移除游标文件后再启动。

## 配置媒体目录

当前已验证的 Jellyfin 库：

| 库 | 类型 | Jellyfin 目录 |
| --- | --- | --- |
| series | 电视剧 | `/MediasVol3/series` |
| movie | 电影 | `/MediasVol3/movies` |

qBittorrent 默认目录是 `/MediasVol3/downloads`，它不属于上述媒体库。**请在 qBittorrent 中配置下载分类的保存目录，再在 RSS 规则中选择该分类，确保实际下载路径位于电影或电视剧媒体库内**，或先自行整理文件到库目录。服务不直接移动或删除媒体文件；启用新增种子通知后，可通过 qBittorrent 规范缺少季号的视频文件名。电视剧每个剧集使用独立文件夹，Season 子文件夹和单集会按所属 Series 根目录识别；电影按每个视频文件名识别。

下载完成通知使用种子中已选择的视频文件路径定位所属媒体库，只向匹配到的库提交普通增量刷新。qBittorrent 与 Jellyfin 可见路径不同时，需通过 `QBT_PATH_PREFIX` → `JELLYFIN_PATH_PREFIX` 配置路径映射；相同时无需配置。种子涉及多个库时分别刷新，每个库只提交一次。视频路径无法归属电影或电视剧库时，任务失败并提示检查保存目录和路径映射，不回退全库扫描。后续识别仍直接读取所有目标媒体库的 Jellyfin 媒体列表，不按种子文件路径筛选。

服务在每次查询和识别时动态读取 Jellyfin 当前全部电影、剧集库：新增库自动纳入，删除库自动排除，始终排除音乐、混合库等其他类型。无需填写媒体库 ID；旧的 `JELLYFIN_SERIES_LIBRARY_ID`、`JELLYFIN_MOVIE_LIBRARY_ID` 即使仍在环境变量中也不再限制范围。面板“刷新列表”会同步更新库选项；已选择的库被删除时回到全部目标库。

动态发现库不会单独触发识别任务。存量未识别媒体可在“媒体识别”中启动识别；qBittorrent 下载完成回调会先检查下载完成状态，然后只向种子视频文件所属的 Jellyfin 媒体库提交增量刷新，按配置等待（默认 10 秒，不轮询刷新状态），再分页获取当前全部电影、剧集库中的未识别媒体进行识别，不按种子文件路径筛选。回调显式提供 `type` 时仅处理该类型；手动识别仍按面板选择的库、类型及媒体范围执行。没有未识别媒体时正常完成并提示；规则无法唯一确定时先由 AI 判断，仍不能确定则临时应用第一个有效且年份匹配的候选；没有可用候选时等待人工确认。所选候选的名称、年份和外部 ID 保存成功后即标记完成；电影和剧集均触发后台完整元数据刷新，但不等待加载完成，刷新入队请求失败作为提示展示。

## qBittorrent 下载完成通知

在左侧“种子通知”中，可以分别设置“新增种子通知”和“下载完成通知”。两种通知独立保存，并回读确认；生成模板不会自动保存。通知页单独读取当前运行中的回调地址和认证开关，不依赖 Jellyfin 媒体库查询成功。

### 新增种子后规范文件名

在“命名检查”页面的“剧集分类”中，从查询到的 qBittorrent 分类中多选，不支持手动创建分类。初始不预选任何分类，未选择时不检查任何分类。点击“保存分类”后立即生效，选项保存到 `data/config.json` 的 `SERIES_CATEGORIES` 数组；不属于基础配置表单。完整名称匹配、忽略大小写，不按子串匹配。命名检查列表、手动检查和新增种子回调共用此设置。

在“新增种子通知”中生成 curl 命令、启用并保存，对应 qBittorrent 的“新增 Torrent 时运行”。内网部署无需 Node.js、token 或配置文件，也可直接填写：

```sh
curl -q --fail --silent --show-error --connect-timeout 5 --max-time 15 --retry 2 --retry-connrefused --data-urlencode "hash=%I" "http://172.29.0.1:3000/api/webhooks/qbittorrent/added"
```

纯 v2 种子用 `%J` 替换 `%I`。回调认证启用时，面板提供独立 curl 配置文件模板，需部署到 qBittorrent 容器内。

回调创建文件检查任务：先读取 qBittorrent 分类，仅处理 `SERIES_CATEGORIES` 列表中的剧集分类（完整名称匹配、忽略大小写）；未分类或其他分类直接跳过，不读取文件列表或调用 AI。等待种子文件列表可用（磁力链接等待元数据，默认最多 120 秒，可用 `TORRENT_FILES_TIMEOUT_MS` 调整），仅检查视频文件 basename 中有 `E01` / `EP01` 等集号、没有 `S01E01` / `S01EP01` 等季集号的文件。季号由 DeepSeek 结合种子名、文件路径及作品信息判断，也结合英文序数词及季度副标题核对作品关系和年份（如 Initial D Fifth Stage / 2012 对应 TheTVDB 第5季），不因标题是副标题就放弃判断；用于判断的作品副标题仍保留，不机械地将电影续作或特别篇当作季号；高置信度时使用 AI 判断的季号；低置信度或未能确定季号时默认使用 `S01`，保留原始标题，不移除 AI 提议的标题尾部标记，并在任务详情中注明默认季号。AI 请求失败或返回无效数据时仍报告失败，便于重试。同目录、同标题且年份及发布标签相同的文件在一轮内复用季号判断。重命名前再次检查分类，若已不属于配置的剧集分类则停止改名。

左侧“命名检查”按添加时间从新到旧分页展示种子，可在具体种子旁点击“检查此种子”，只创建该种子的检查任务；页面没有全量检查按钮。仅属于已配置剧集分类的种子可检查，包括下载中、已暂停和已完成种子，不依赖通知开关。详情标明文件改名结果与错误。相同种子的任务排队或执行期间重复点击返回同一任务，完成后可再次检查；已经规范的文件不会重复改名。检查接口要求有效 hash、管理员登录及 CSRF 校验，空请求不会执行全量检查。

例如：`Journey.to.the.West.II.E01.1998.TVB.WEB-DL.1080p.H264.AAC.2Audio-HDCTV.mkv` → `Journey.to.the.West.S02E01.1998.TVB.WEB-DL.1080p.H264.AAC.2Audio-HDCTV.mkv`。AI 只能请求移除标题尾部明确的季号标记，不能改写其他标题、年份、质量标签或目录。

服务通过 qBittorrent `torrents/renameFile` 修改种子内文件路径并回读确认，保持文件与下载任务关联，不直接操作宿主机文件。目标名称已存在时拒绝覆盖；规范过的文件不重复改名。新增事件不会触发 Jellyfin 扫描，也不更新媒体识别游标；下载完成通知仍独立触发原识别流程。面板任务详情显示原名、目标名、AI 判断、跳过原因和失败信息，失败任务可重试；任务记录不跨服务重启保留。

下载完成通知保存只更新 `autorun_enabled` 与 `autorun_program`；新增通知保存只更新 `autorun_on_torrent_added_enabled` 与 `autorun_on_torrent_added_program`。

当前 qBittorrent 容器的回调地址为 `http://172.29.0.1:3000/api/webhooks/qbittorrent/completed`。服务须监听 `0.0.0.0`，Docker 发布端口为 `3000:3000`，其内部端口仍为 `3000`。容器已有 curl 时使用下面的 curl 配置，不需要 Node.js 或通知脚本。纯 v2 torrent 将命令中的 `%I` 改为 `%J`；不要使用 `%K`（Torrent ID）。

### curl 通知（当前容器使用）

当前内网部署设置 `WEBHOOK_AUTH_ENABLED=false`，取消新增种子及下载完成回调的 token 校验，管理面板及管理 API 仍需认证。无需 `.env.notify.curl`，在“torrent 完成时运行”填写下面的单行命令，或在管理面板直接生成并保存：

```text
curl -q --fail --silent --show-error --connect-timeout 5 --max-time 15 --retry 2 --retry-connrefused --data-urlencode "hash=%I" "http://172.29.0.1:3000/api/webhooks/qbittorrent/completed"
```

JSON 配置示例默认使用内网模式。关闭回调认证时无需设置 `WORKFLOW_API_TOKEN`。需要恢复回调认证时在 JSON 中设置 `WEBHOOK_AUTH_ENABLED: true`、填写独立回调令牌并重启服务，再使用下面的配置文件方式。没有指定该选项时仍默认校验 token。

#### 启用 token 校验时的 curl 配置（可选）

复制 `scripts/notify-completed.curl.example` 为 **qBittorrent 容器内** `/config/z-media-workflow/.env.notify.curl`，将 `header` 中的占位值改为服务端 `config.json` 的独立 `WORKFLOW_API_TOKEN`。curl 配置属于外部客户端调用模板，curl 无法直接读取 JSON。按实际持久化挂载修改路径，让 qBittorrent 运行用户可读，并设置 `chmod 600`。

启用回调认证时，在管理面板选择“curl（无需 Node.js）”，填写上述配置文件路径，生成通知命令并保存启用。也可在截图对应的“torrent 完成时运行”中填写：

```text
curl -q --config "/config/z-media-workflow/.env.notify.curl" --data-urlencode "hash=%I"
```

令牌保存在配置文件中，不出现在完成命令或 curl 参数中。回调接口支持 URL 编码表单与原有 JSON；启用 curl 的失败状态检测、连接/请求超时和限量重试，HTTP 4xx/5xx 不会被误报为成功。不要给配置添加 `location`，避免向重定向目标转发请求。

在容器内只读检查服务可达性：

```sh
curl -q --fail --show-error --connect-timeout 5 --max-time 15 http://172.29.0.1:3000/health
```

### Node.js 通知（可选）

在 **qBittorrent 所在机器/容器** 部署 `scripts/notify-completed.mjs`（只依赖 Node.js 22.13.0+，无需安装 npm 包）。复制 `scripts/config.notify.example.json` 为脚本同目录的 `config.json`，或在通知命令末尾追加 `--config /实际路径/config.json`。脚本只读取 JSON，填写：

```json
{
  "WORKFLOW_CALLBACK_URL": "http://172.29.0.1:3000/api/webhooks/qbittorrent/completed",
  "WORKFLOW_API_TOKEN": "服务端config.json中的独立回调令牌"
}
```

地址必须可从 qBittorrent 所在机器访问。跨机器调用时在 JSON 中将 `HOST` 设置为可访问地址，如 `0.0.0.0`，并填写实际 `PUBLIC_URL`。

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

将 `scripts/notify-completed.mjs` 和配置好的 `config.json` 部署在 qBittorrent 容器同一目录，例如 `/opt/z-media-workflow/scripts/`，完成命令填写 `node "/opt/z-media-workflow/scripts/notify-completed.mjs" "%I"`。该路径是模板，需按实际挂载修改。只在工作流容器中放置脚本，无法让另一容器的 qBittorrent 执行它。启用后仅对后续下载完成事件生效；已完成媒体可在面板手动扫描。

脚本对网络/429/5xx 限量重试；API 对 hash 去重。hash 支持 v1 40 位或 v2 64 位十六进制。启用回调认证时使用 WORKFLOW_API_TOKEN，不能操作管理 API；内网模式的下载回调不需要令牌，仍校验 hash 和媒体类型。

## 外部 crontab 清理文件丢失的种子

`POST /api/qbittorrent/cleanup-missing-files` 只处理状态为 `missingFiles` 的种子，不处理 `error`、下载中、做种或暂停的其他状态，不限制分类。在左侧“种子清理”页面的“文件丢失种子清理”面板中，切换“同时删除下载文件”开关即自动保存并生效，无需另点保存。保存期间禁用清理操作，失败时恢复原开关并显示错误。开关默认关闭，只删除种子任务；打开后同时删除其下载文件。设置统一用于页面清理和外部 crontab 调用，集中保存在 `data/config.json`，重启后保留；Compose 使用持久卷中的 `/app/data/config.json`。清理由 qBittorrent 原生 `torrents/delete` 执行，不直接操作文件系统。

清理配置是同一 `config.json` 中的 `torrentCleanup` 字段，下面只展示这部分。页面保存时只更新 `torrentCleanup.deleteFiles`，保留服务地址、令牌和其他配置项。手工编辑后重启服务生效。媒体游标属于运行数据，仍保存到 `media-cursors.json`。

```json
{
  "torrentCleanup": {
    "deleteFiles": false
  }
}
```

已有 `config.json` 中的 `torrentCleanup` 配置继续保留；没有该字段时默认保留下载文件。旧独立清理文件不再作为应用配置来源。

外部调用权限与下载通知一致：`WEBHOOK_AUTH_ENABLED=false` 时无需令牌；开启认证时要求 `Authorization: Bearer <WORKFLOW_API_TOKEN>`，令牌与通知共用。外部调用无需登录管理面板或提供 CSRF token；页面调用使用管理员会话和 CSRF 校验。请求体接受布尔值 `dryRun`：`{}` 或 `{"dryRun":true}` 仅预览，`{"dryRun":false}` 按已保存的文件删除设置执行清理，调用方不能通过参数覆盖该设置。页面预览或执行清理时会附带 `expectedDeleteFiles` 校验所确认的开关状态；设置变化时返回 409，要求重新读取并确认。

“种子清理 → 定时调用”支持复制调用链接或 curl 命令。链接根据当前页面地址生成，接口要求 POST，认证沿用通知设置；复制命令包含 `dryRun:false`，执行时使用已保存的文件删除开关。页面不回传令牌；仅在开启通知认证时，需自行替换命令中的 `<WORKFLOW_API_TOKEN>`；复制操作不会执行清理。

在运行 crontab 的 Linux 主机上，将 `scripts/cleanup-missing-files.curl.example` 复制为 `/etc/z-media-workflow/.env.cleanup.curl`，修改服务地址和令牌，并执行 `chmod 600 /etc/z-media-workflow/.env.cleanup.curl`。令牌保存在配置文件，不写进 crontab 命令。

先预览：

```sh
curl -q --config /etc/z-media-workflow/.env.cleanup.curl --data '{"dryRun":true}'
```

确认预览范围后，在 `crontab -e` 中添加以下示例，每小时执行一次。按实际路径调整锁文件和日志位置，并确保 cron 用户具有写入权限：

```cron
0 * * * * /usr/bin/flock -n /var/lock/z-media-workflow-cleanup.lock /usr/bin/curl -q --config /etc/z-media-workflow/.env.cleanup.curl --data '{"dryRun":false}' >> /var/log/z-media-workflow-cleanup.log 2>&1
```

配置使用 `--fail-with-body`（需要 curl 7.76+），HTTP 失败时保留响应体并以非零状态退出。成功返回 `data`，包含 `dryRun`、`deleteFiles`、`matchedCount`、`deletedCount`、`skippedCount`、`failedCount` 和逐项 `items`。预览项状态为 `would_delete`；执行项为 `deleted`、`skipped` 或 `failed`，跳过和失败项附原因。存在失败项时返回 HTTP 502，仍包含其他项的处理结果；同一服务进程内已有清理执行时返回 409。

清理开始时固定本批候选，逐个删除前重新检查状态，删除后回读确认种子已移除；种子消失或状态变化则跳过。qBittorrent 不提供原子的“按状态删除”，重新检查与实际删除之间仍存在短暂间隔。`deleted` 表示种子任务已确认移除，磁盘文件删除由 qBittorrent 处理。清理不触发 Jellyfin 扫描或媒体识别。服务日志记录本批计数，详细结果由调用方保存。

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
| GET | `/api/setup/status` | 首次运行状态；未初始化时提供 CSRF token |
| POST | `/api/setup` | 首次配置并保存，只允许配置文件不存在时调用 |
| POST | `/api/auth/login`、`/api/auth/logout` | 管理会话登录/退出 |
| GET | `/api/auth/session` | 会话和 CSRF token |
| GET | `/api/dashboard` | 统计、目标库与脱敏配置 |
| GET / PUT | `/api/qbittorrent/completion-notification` | 读取/保存下载完成通知 `{ enabled, program }` |
| GET / PUT | `/api/qbittorrent/added-notification` | 读取/保存新增种子通知 `{ enabled, program }` |
| POST | `/api/webhooks/qbittorrent/added` | 新增种子文件检查 `{ hash }`，返回任务；使用回调认证设置 |
| POST | `/api/workflows/check-torrents` | 管理员检查单个种子 `{ hash }`；仅检查已配置剧集分类的种子 |
| POST | `/api/connections/check` | 三方只读连接检查 |
| GET | `/api/notifications/context` | 管理员读取当前运行中的新增/完成回调地址与认证开关 |
| GET | `/api/service/status` | 管理员读取当前进程实例、PM2 重启支持情况及重启状态 |
| POST | `/api/service/restart` | 管理员及 CSRF 校验，提交 `{ revision }` 重启已保存的配置，返回 202 |
| GET / PUT | `/api/config` | 脱敏读取/保存基础配置，写入 `{ values, revision }`，返回是否需要重启 |
| GET / PUT | `/api/qbittorrent/naming-settings` | 读取/保存命名检查剧集分类 `{ seriesCategories }`，即时生效 |
| GET | `/api/qbittorrent/torrents` | 按添加时间倒序分页读取种子列表 |
| GET | `/api/qbittorrent/rss` | 订阅树与文章 |
| POST / DELETE | `/api/qbittorrent/rss/feeds` | 添加/删除订阅 |
| POST | `/api/qbittorrent/rss/refresh` | 刷新订阅 |
| GET / PUT | `/api/qbittorrent/cleanup-settings` | 管理员读取/保存 `{ deleteFiles }` 文件删除开关 |
| POST | `/api/qbittorrent/cleanup-missing-files` | `{ dryRun?, expectedDeleteFiles? }` 按已保存开关清理；支持外部 Bearer 令牌或管理员会话 |
| GET | `/api/qbittorrent/rss/rules` | 规则列表 |
| PUT / DELETE | `/api/qbittorrent/rss/rules/:name` | 设置/删除规则 |
| POST | `/api/webhooks/qbittorrent/completed` | `{ hash, type? }` 下载完成通知 |
| GET | `/api/media/unidentified` | 目标库未识别条目 |
| GET | `/api/media/:itemId/poster` | 登录后读取 Jellyfin 主海报缩略图，图片缺失返回 404 |
| GET | `/api/media/libraries` | 当前全部电影、电视剧库 |
| GET | `/api/media/items` | 全部媒体分页列表；可传 `libraryId`、`type`、`search`、`sort`（`date_desc` / `date_asc` / `name_asc` / `year_desc`） |
| POST | `/api/media/:itemId/identify` | `{ name, year? }` 创建仅手动确认的纠错候选任务，返回 202；通过已有任务搜索、确认接口继续操作 |
| GET | `/api/workflows` | 分页任务列表 |
| POST | `/api/workflows/scan` | `{ dryRun, libraryId?, itemIds?, type? }` |
| GET | `/api/workflows/:jobId` | 任务与每项结果 |
| POST | `/api/workflows/:jobId/retry` | 创建重试任务 |
| POST | `/api/workflows/:jobId/search` | `{ itemId, name, year? }` 修正搜索 |
| POST | `/api/workflows/:jobId/confirm` | `{ itemId, candidateId }` 确认任务已有候选 |

首次配置接口使用初始化 cookie 和 CSRF token；配置后关闭写入。其他管理 API 仅接受用户名/密码登录后的 HttpOnly 会话 cookie；清理接口和下载通知共用通知认证开关及 Bearer 令牌。同源管理写入需 CSRF token。分页参数 `page`/`pageSize`，每页最多 200。

## 运行限制与验证

串行队列上限由 MAX_QUEUE 设置，保留任务数由 MAX_JOBS 设置。终态任务按 JOB_TTL_MS 淘汰，待确认任务保留至处理完成或重启。队列/记录满返回 429；服务关闭时停止接收新任务并限时等待处理结束。无数据库，不提供跨重启任务恢复或可靠投递保证。

下载完成通知不触发全库扫描，也不轮询刷新完成状态；向种子所属媒体库提交刷新后按 `LIBRARY_REFRESH_WAIT_MS` 等待，默认 `10000` 毫秒（10 秒），设为 `0` 表示不等待。可在“基础配置 → 运行参数”修改，保存后重启服务生效。此等待不保证新媒体已入库，尚未出现在 Jellyfin 中的条目需在后续下载通知或手动识别时处理。识别结果保存成功后不等待元数据加载完成。电影/剧集 RemoteSearch 由 Jellyfin 已配置的提供方执行，需要对应提供方可联网；缺少 provider ID 的候选不能应用。

部分剧集提供方只返回 PremiereDate，不返回 ProductionYear；服务会从有效首播日期提取候选年份，区分同名不同年份的剧集。确认候选后，先读取当前完整可编辑元数据，保留锁定设置、标签、简介等原值，仅更新所选名称、有效年份和外部 ID，再通过 Items/{id}/Refresh 将完整刷新入队。此流程不使用会等待提供方加载完成的 RemoteSearch/Apply 接口。任务详情展示所选候选的信息，不将后台元数据加载完成作为识别完成条件。保存请求失败或超时会标记失败并保留待处理状态，可通过任务重试重新提交所选候选。

Jellyfin 保存节目元数据时会将节目评级同步给季和集。服务在保存前检查子条目的独立评级；如果此次保存会覆盖这些评级，则停止更新并提示处理评级设置，避免覆盖原有设置。

```powershell
npm test
npm run build
npm run test:ui
npm run check:connections
```

单元/API 测试和浏览器测试使用本地 mock，不更改实际 RSS 或 Jellyfin 元数据。`check:connections` 只读查询版本、可用模型、库及媒体回读，不调用模型生成，不触发扫描。浏览器测试默认使用本机 Edge，可通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定 Chromium；没有浏览器时执行 `npx playwright install chromium`。

官方接口参考：[qBittorrent API key](https://github.com/qbittorrent/wiki/blob/master/API-Key-Authentication-%28%E2%89%A5v5.2.0%29.md)、[qBittorrent WebAPI](https://github.com/qbittorrent/qBittorrent/wiki/WebUI-API-%28qBittorrent-5.0%29)、[Jellyfin API](https://api.jellyfin.org/)、[DeepSeek chat completions](https://api-docs.deepseek.com/api/create-chat-completion/)。

## 工作流持久化

使用 Node >=22.13.0 内置的 node:sqlite（Node 22 中仍属实验性接口），无需额外数据库服务。数据库固定在配置文件目录的 workflow.sqlite，Docker 下为 /app/data/workflow.sqlite，使用现有数据卷；配置和媒体游标仍使用原 JSON 文件。WAL 模式、FULL 同步，列表由 SQL 分页读取，不将全部历史常驻内存。单任务扫描及 HTTP 缓冲仍会占用内存，256M 的 PM2 保护继续生效。

排队操作保存成功后才返回接受响应；重启后顺序恢复。人工候选 ID 和选择保留，纠错依旧需要手动确认。执行中的修改先核对 Jellyfin 元数据或 qBittorrent 文件索引/路径，已生效则补齐本地收尾，结果不明确时标记中断，重试也先核对。正常识别仍以成功提交为完成，不等待 Jellyfin 后台元数据加载。切换服务地址后旧历史可读，但旧动作不能向新服务执行。

沿用 MAX_JOBS、MAX_QUEUE、JOB_TTL_MS；待确认、执行中和未解决写入意图不会被自动清理。达到容量时需处理这些任务，重启不再清空记录。首次升级只能创建空数据库，此前保存在内存中的历史无法迁移；现有配置和游标不变。数据库损坏、无法写入或结构版本过高时明确失败，不降级到内存模式。

备份时停止服务并备份整个 data 目录，包括数据库、可能存在的 -wal/-shm 文件、配置和游标；不要在服务运行中仅复制 workflow.sqlite。恢复时一起还原这些文件，并确认 node 用户可读写。回滚前使用升级前备份，旧版本不能读取持久队列。
