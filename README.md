# z-media-workflow

Koa + Vue 3 媒体工作流与中文管理面板，无数据库。qBittorrent RSS 下载完成后发送回调，服务等待 Jellyfin 媒体库刷新完成，使用 DeepSeek 从电视剧文件夹或电影文件名中提取名称及可选年份，调用 Jellyfin 搜索并优先应用规则唯一匹配的候选；无法确定时由 AI 判断候选，仍无法确定时临时应用第一个有效且年份匹配的候选。通过元数据更新接口保存所选名称、年份和外部 ID 后即完成，再将元数据刷新加入 Jellyfin 队列，不等待刮削和图片加载结束。

## 本地启动

需要 Node.js 22+。在项目根目录执行：

```powershell
npm ci
npm ci --prefix web
# 首次部署且没有 .env 时：复制 .env.example 为 .env 并填写凭据
npm run build
npm start
```

打开 http://localhost:3000，使用 `.env` 的 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 登录。当前调试环境已写入被 Git 忽略的 `.env`，管理员密码和回调令牌分别配置；不在文档或构建产物中记录真实令牌。

开发时分别运行 `npm run dev` 与 `npm run dev:web`，打开 http://localhost:5173。生产配置 `NODE_ENV=production`、实际 `PUBLIC_URL`，HTTPS 时设置 `COOKIE_SECURE=true`；代理部署时按环境设置 `TRUST_PROXY`。面板与 API 使用同源部署。

管理账号使用环境配置，无需数据库：

```dotenv
ADMIN_USERNAME=admin
ADMIN_PASSWORD=填写管理员密码
```

旧的 `ADMIN_API_TOKEN` 已停用。登录接口接受 `{ "username", "password" }`，成功后创建 HttpOnly 会话，密码使用 scrypt 比对；错误的用户名或密码返回相同提示，保留登录尝试限制。修改账号或密码后重启服务，旧会话失效。下载回调是否校验 token 仍由 `WEBHOOK_AUTH_ENABLED` 独立控制。

登录及管理 API 不限制请求的 Origin，允许通过内网 IP、域名或 localhost 访问；登录仍需用户名/密码，管理操作仍需会话及 CSRF 校验。旧的 `DEV_ORIGIN` 环境变量不再使用。`PUBLIC_URL`（Docker 中为 `DOCKER_PUBLIC_URL`）用于推导默认回调地址，不再用于限制登录来源；`WORKFLOW_CALLBACK_URL` 可单独设置为 qBittorrent 容器可达的回调地址，当前为 `http://172.29.0.1:3000/api/webhooks/qbittorrent/completed`。未指定回调地址时从 `PUBLIC_URL` 推导。

## Docker Compose 部署

参考 `senior-buyer`，使用 `jiuwusan/z-media-workflow:latest` 镜像、外部 `wk` 网络和 `restart: always`。镜像基于 Node.js 22，分阶段构建 Vue 面板及后端生产依赖，由非 root 用户运行 Koa，内置 `/health` 健康检查。管理面板和 API 共用一个容器，宿主机默认端口为 **3000**。

部署机器只需 Docker Engine / Docker Desktop、Compose v2、`docker-compose.yml` 和 `.env`，无需本地构建镜像。首次部署将 `.env.example` 复制为 `.env` 并填写各服务密钥、管理员用户名/密码及可选回调令牌；已有 `.env` 时保留配置。在 `.env` 中追加或调整：

```dotenv
DOCKER_IMAGE=jiuwusan/z-media-workflow:latest
DOCKER_HOST_PORT=3000
DOCKER_PUBLIC_URL=http://你的服务器地址:3000/
DOCKER_STOP_GRACE_PERIOD=35s
```

使用 HTTPS 反向代理时，`DOCKER_PUBLIC_URL` 填外部 HTTPS 地址，设置 `COOKIE_SECURE=true`；受信任代理转发时设置 `TRUST_PROXY=true`。Compose 会将容器内 `HOST`、`PORT`、`NODE_ENV` 固定为 `0.0.0.0`、`3000`、`production`，并用 `DOCKER_PUBLIC_URL` 覆盖本地开发的 `PUBLIC_URL`。修改宿主机端口时同步修改 `DOCKER_PUBLIC_URL`。

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

打开 `http://你的服务器地址:3000/`，使用 `.env` 的 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 登录。qBittorrent 完成通知脚本的 `WORKFLOW_CALLBACK_URL` 填 `http://你的服务器地址:3000/api/webhooks/qbittorrent/completed`；如果 qBittorrent 容器也在 `wk` 网络，可用 `http://z-media-workflow:3000/api/webhooks/qbittorrent/completed`。通知脚本仍应在 qBittorrent 所在机器/容器运行。

GitHub Actions 发布新镜像后，执行 `docker compose pull` 和 `docker compose up -d` 更新服务。查看三方连接可执行 `docker compose exec z-media-workflow npm run check:connections`。

`.env` 通过 Compose 在运行时注入，已从构建上下文排除。服务通过远程 API 操作媒体，无需挂载媒体目录。识别游标使用 JSON 文件，Compose 将 `workflow-data` 命名卷挂载到 `/app/data`，更新镜像或重建容器后保留游标；`docker compose down -v` 会删除该卷。日志输出到 Docker，单个日志文件最多 10 MB，保留 3 个。任务记录和登录会话保存在内存，重启后重新登录；默认关闭等待为 30 秒，调整 `SHUTDOWN_TIMEOUT_MS` 时应将 `DOCKER_STOP_GRACE_PERIOD` 设置得更长。

## GitHub Actions 发布镜像

工作流位于 `.github/workflows/docker-publish.yml`，沿用 `senior-buyer` 的 Docker Hub 账号和发布方式，使用 [Docker 官方 GitHub Actions](https://docs.docker.com/guides/gha/)。

1. 在 Docker Hub 创建 `jiuwusan/z-media-workflow` 仓库，并生成有该仓库写入权限的访问令牌。
2. 在 GitHub 仓库 **Settings → Secrets and variables → Actions** 配置 Secret `OCKERHUB_USERNAME`（当前约定名称，值为 Docker Hub 用户名）和 `DOCKERHUB_TOKEN`（Docker Hub 访问令牌）。用户名也兼容 `DOCKERHUB_USERNAME`；两者同时存在时优先使用 `OCKERHUB_USERNAME`。账号需有 `jiuwusan/z-media-workflow` 的推送权限。媒体服务的 API 密钥和管理员密码无需配置到 Actions。
3. 推送代码至 `master`，或在 **Actions → Build and Push Docker Image → Run workflow** 手动触发。

流程先运行 `npm test`，通过后从 Dockerfile 构建 `linux/amd64` 和 `linux/arm64` 镜像并推送到 Docker Hub。`master` 发布 `latest`、`master` 和 `sha-<提交短哈希>` 标签；手动构建其他分支发布分支和提交标签，不覆盖 `latest`。PR 运行测试和镜像构建，不登录 Docker Hub、不推送镜像。

部署默认拉取 `jiuwusan/z-media-workflow:latest`；需要固定版本时，将 `.env` 的 `DOCKER_IMAGE` 改为对应提交标签后执行 `docker compose pull` 和 `docker compose up -d`。

## 面板

- 概览：任务统计、服务连接检查、目标库和近期任务。
- RSS：添加/删除/刷新订阅、读取文章，增删查改原生下载规则，支持启停、正则匹配、包含/排除条件、分类下拉选择及适用订阅源勾选。其余选项新建时使用 qBittorrent 默认值，编辑时保留原值与匹配历史。
- 工作流任务：扫描状态、每项识别结果、失败重试。
- 媒体识别：分页查看未识别条目，预览或自动识别选中条目/目标库。
- 任务详情：查看名称提取和 Jellyfin 候选，人工确认，或修改名称/年份后重新搜索。
- 连接与通知：只读检查、脱敏地址、目录映射及回调命令。

“预览候选”和“识别并应用”直接读取 Jellyfin 现有媒体条目，不触发全库扫描；失败的媒体识别任务重试也不触发全库扫描（包括下载完成任务的重试）。首次下载完成通知仍先执行全库扫描并等待完成。应用候选后仍提交对应条目的后台元数据刷新。“预览候选”会调用 DeepSeek，但不应用元数据；“识别并应用”先自动写入名称及可选年份匹配的唯一候选；规则无法确定时，由 DeepSeek 根据原始名称、类型、年份和候选信息进行二次判断，优先应用高置信度且属于 Jellyfin 返回列表的候选。AI 无法确定、输出无效或调用失败时，按 Jellyfin 返回顺序临时应用第一个有有效外部 ID 且年份匹配的候选，任务详情会标明临时选择。名称提取没有年份时不限制候选年份；没有有效且年份匹配的候选时仍进入待确认。保存临时选择结果成功后同样推进识别游标，后续不会自动纠正该选择。预览可展示 AI 推荐及理由，但不应用元数据。任务信息只在当前服务进程内保留，重启后需要重新扫描。

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

下载完成通知后的识别直接使用 Jellyfin 媒体列表，不依赖 qBittorrent 与 Jellyfin 之间的路径映射。`QBT_PATH_PREFIX` 和 `JELLYFIN_PATH_PREFIX` 不再影响该流程。

服务在每次查询和识别时动态读取 Jellyfin 当前全部电影、剧集库：新增库自动纳入，删除库自动排除，始终排除音乐、混合库等其他类型。无需填写媒体库 ID；旧的 `JELLYFIN_SERIES_LIBRARY_ID`、`JELLYFIN_MOVIE_LIBRARY_ID` 即使仍在环境变量中也不再限制范围。面板“刷新列表”会同步更新库选项；已选择的库被删除时回到全部目标库。

动态发现库不会单独触发识别任务。存量未识别媒体可在“媒体识别”中启动识别；qBittorrent 下载完成回调会先检查下载完成状态，然后刷新 Jellyfin 并等待刷新结束，再分页获取当前全部电影、剧集库中的未识别媒体进行识别，不按种子文件路径筛选。回调显式提供 `type` 时仅处理该类型；手动识别仍按面板选择的库、类型及媒体范围执行。没有未识别媒体时正常完成并提示；规则无法唯一确定时先由 AI 判断，仍不能确定则临时应用第一个有效且年份匹配的候选；没有可用候选时等待人工确认。所选候选的名称、年份和外部 ID 保存成功后即标记完成；电影和剧集均触发后台完整元数据刷新，但不等待加载完成，刷新入队请求失败作为提示展示。

## qBittorrent 下载完成通知

在管理面板“连接与通知”中，可以分别设置“新增种子通知”和“下载完成通知”。两种通知独立保存，并回读确认；生成模板不会自动保存。

### 新增种子后规范文件名

在“新增种子通知”中生成 curl 命令、启用并保存，对应 qBittorrent 的“新增 Torrent 时运行”。内网部署无需 Node.js、token 或配置文件，也可直接填写：

```sh
curl -q --fail --silent --show-error --connect-timeout 5 --max-time 15 --retry 2 --retry-connrefused --data-urlencode "hash=%I" "http://172.29.0.1:3000/api/webhooks/qbittorrent/added"
```

纯 v2 种子用 `%J` 替换 `%I`。回调认证启用时，面板提供独立 curl 配置文件模板，需部署到 qBittorrent 容器内。

回调创建文件检查任务：先读取 qBittorrent 分类，仅处理分类名称包含 `series` 的种子（不区分大小写，例如 `series`、`pure-series`、`SUPER-SERIES`）；未分类或其他分类直接跳过，不读取文件列表或调用 AI。等待种子文件列表可用（磁力链接等待元数据，默认最多 120 秒，可用 `TORRENT_FILES_TIMEOUT_MS` 调整），仅检查视频文件 basename 中有 `E01` / `EP01` 等集号、没有 `S01E01` / `S01EP01` 等季集号的文件。季号由 DeepSeek 结合种子名、文件路径及作品信息判断，也结合英文序数词及季度副标题核对作品关系和年份（如 Initial D Fifth Stage / 2012 对应 TheTVDB 第5季），不因标题是副标题就放弃判断；用于判断的作品副标题仍保留，不机械地将电影续作或特别篇当作季号；高置信度时使用 AI 判断的季号；低置信度或未能确定季号时默认使用 `S01`，保留原始标题，不移除 AI 提议的标题尾部标记，并在任务详情中注明默认季号。AI 请求失败或返回无效数据时仍报告失败，便于重试。同目录、同标题且年份及发布标签相同的文件在一轮内复用季号判断。重命名前再次检查分类，若已不包含 `series` 则停止改名。

在“连接与通知 → 新增种子通知”点击“检查已有种子”，会创建一个批量任务，依次检查全部符合分类条件的已有种子，包括下载中、已暂停和已完成种子；不依赖通知开关。单个种子失败不阻断后续种子，详情标明所属种子与错误。任务排队或执行期间重复点击返回同一任务，完成后可再次检查；已经规范的文件不会重复改名。此按钮使用管理员登录及 CSRF 校验，不通过免认证回调执行全量检查。

例如：`Journey.to.the.West.II.E01.1998.TVB.WEB-DL.1080p.H264.AAC.2Audio-HDCTV.mkv` → `Journey.to.the.West.S02E01.1998.TVB.WEB-DL.1080p.H264.AAC.2Audio-HDCTV.mkv`。AI 只能请求移除标题尾部明确的季号标记，不能改写其他标题、年份、质量标签或目录。

服务通过 qBittorrent `torrents/renameFile` 修改种子内文件路径并回读确认，保持文件与下载任务关联，不直接操作宿主机文件。目标名称已存在时拒绝覆盖；规范过的文件不重复改名。新增事件不会触发 Jellyfin 扫描，也不更新媒体识别游标；下载完成通知仍独立触发原识别流程。面板任务详情显示原名、目标名、AI 判断、跳过原因和失败信息，失败任务可重试；任务记录不跨服务重启保留。

下载完成通知保存只更新 `autorun_enabled` 与 `autorun_program`；新增通知保存只更新 `autorun_on_torrent_added_enabled` 与 `autorun_on_torrent_added_program`。

当前 qBittorrent 容器的回调地址为 `http://172.29.0.1:3000/api/webhooks/qbittorrent/completed`。服务须监听 `0.0.0.0`，Docker 发布端口为 `3000:3000`，其内部端口仍为 `3000`。容器已有 curl 时使用下面的 curl 配置，不需要 Node.js 或通知脚本。纯 v2 torrent 将命令中的 `%I` 改为 `%J`；不要使用 `%K`（Torrent ID）。

### curl 通知（当前容器使用）

当前内网部署设置 `WEBHOOK_AUTH_ENABLED=false`，取消新增种子及下载完成回调的 token 校验，管理面板及管理 API 仍需认证。无需 `.env.notify.curl`，在“torrent 完成时运行”填写下面的单行命令，或在管理面板直接生成并保存：

```text
curl -q --fail --silent --show-error --connect-timeout 5 --max-time 15 --retry 2 --retry-connrefused --data-urlencode "hash=%I" "http://172.29.0.1:3000/api/webhooks/qbittorrent/completed"
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
curl -q --fail --show-error --connect-timeout 5 --max-time 15 http://172.29.0.1:3000/health
```

### Node.js 通知（可选）

在 **qBittorrent 所在机器/容器** 部署 `scripts/notify-completed.mjs`（只依赖 Node.js 22+，无需安装 npm 包）。复制 `scripts/.env.notify.example` 为脚本同目录的 `.env.notify`，填入：

```dotenv
WORKFLOW_CALLBACK_URL=http://172.29.0.1:3000/api/webhooks/qbittorrent/completed
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
| GET / PUT | `/api/qbittorrent/added-notification` | 读取/保存新增种子通知 `{ enabled, program }` |
| POST | `/api/webhooks/qbittorrent/added` | 新增种子文件检查 `{ hash }`，返回任务；使用回调认证设置 |
| POST | `/api/workflows/check-torrents` | 管理员检查已有种子，无参数；仅检查分类包含 `series` 的种子 |
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

管理 API 仅接受用户名/密码登录后的 HttpOnly 会话 cookie，不再支持管理 Bearer token；同源写入需 CSRF token。分页参数 `page`/`pageSize`，每页最多 200。

## 运行限制与验证

串行队列上限由 MAX_QUEUE 设置，保留任务数由 MAX_JOBS 设置。终态任务按 JOB_TTL_MS 淘汰，待确认任务保留至处理完成或重启。队列/记录满返回 429；服务关闭时停止接收新任务并限时等待处理结束。无数据库，不提供跨重启任务恢复或可靠投递保证。

扫描等待同时检查 Idle 和新 LastExecutionResult，避免把尚未开始的扫描当作完成。扫描等待有超时限制；识别结果保存成功后不等待元数据加载完成。电影/剧集 RemoteSearch 由 Jellyfin 已配置的提供方执行，需要对应提供方可联网；缺少 provider ID 的候选不能应用。

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
