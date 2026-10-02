# Media Workflow Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 实现无数据库的 Koa 媒体自动识别服务与中文管理面板。

**Architecture:** Koa router/controller/service/util 四层；第三方客户端可注入，单进程内存队列串行处理 Jellyfin 扫描和识别。Vue 3 面板由 Koa 同源托管，管理 cookie 会话与通知 Bearer 权限分离。

**Tech Stack:** Node.js 22+、JavaScript ESM、Koa、原生 fetch、Vue 3、Vite、Element Plus、Node test runner。

**Spec:** ../specs/2026-10-02-media-workflow-design.md

## Global Constraints

- 不使用数据库；凭据只在 .env 中，日志和响应脱敏。
- 保留 Jellyfin /jellyfin/ 前缀，Movie/Series 限定配置库，忽略 musicvideos。
- 电视剧以 Series 文件夹名称识别；电影以实际文件名称识别。
- 无年份允许搜索；歧义候选人工确认；应用后回读 ProviderIds。
- 用户已确认按设计开始实施；在指定项目目录的新功能分支执行，不移动项目或推送提交。

## Review Focus

- 快速扫描开始前后均 Idle，必须通过新执行记录证明完成（任务 2）。
- 跨容器路径与相似目录前缀，必须按路径段映射（任务 1、3）。
- 批量任务部分失败或 dryRun，结果不可丢失且不得提前标记成功（任务 3）。
- cookie 写入请求缺少 Origin/CSRF 与回调 token 越权，均拒绝（任务 4）。
- 正则 RSS 规则以及嵌套订阅树，必须保留规则结构和完整路径（任务 2、5）。

## Task 1: 配置、HTTP 和媒体工具

Files: package.json, .env.example, src/config/index.js, src/util/{error,http,media,logger}.js, test/util.test.js。

Interfaces: loadConfig(env) -> config; createHttpClient({baseUrl,headers,timeoutMs}) -> request(path,options); mapPath(path,mapping), containsPath(root,path), selectCandidate(identity,candidates) -> candidate|null。

- [x] 编写测试：保留 URL 前缀和认证头、拒绝跳转、路径段边界、影片候选同名不同年份、无年份歧义。
- [x] 运行 node --test test/util.test.js，确认缺少实现时失败。
- [x] 实现环境变量校验、HTTP 超时/读取重试、错误脱敏和媒体工具。
- [x] 运行同一测试，全部通过。

## Task 2: 三方客户端

Files: src/service/{qbittorrent,jellyfin,deepseek}.js, test/clients.test.js。

Interfaces: QbittorrentService.torrent(hash), files(hash), rss()/rules()/setRule(name,rule); JellyfinService.refreshAndWait(), libraries(), items(options), item(id), search(item,identity), apply(id,candidate), verify(id,candidate); DeepseekService.identify(source,type), models()。

- [x] 编写 mock HTTP 测试：扫描已有运行、新扫描快速结束、失败/超时、分页、API 表单参数和 JSON 校验。
- [x] 运行测试确认缺少客户端时失败。
- [x] 实现对应官方 API 的客户端，轮询执行时间/状态，DeepSeek 输出 name/year 严格校验。
- [x] 运行客户端和工具测试，全部通过。

## Task 3: 队列、识别编排

Files: src/service/{workflow,media-library}.js, test/workflow.test.js。

Interfaces: WorkflowService.enqueue(input) -> job; list({page,pageSize}), get(id), retry(id), confirm(jobId,itemId,candidateId), search(jobId,itemId,identity), close(timeoutMs); MediaLibraryService.unidentified(filters), forTorrent(torrent,files,type)。

- [x] 编写测试：hash 去重、重试、队列上限、按目标库过滤、单集定位 Series、部分失败、候选歧义、dryRun 不写入、确认后 provider 回读不匹配失败。
- [x] 运行测试确认失败，再实现内存限量存储、串行执行和条目状态。
- [x] 支持未入库有限重试，名称编辑仅修改该任务保存候选。
- [x] 运行全套测试，全部通过。

## Task 4: Koa API、会话、静态部署

Files: src/{app,server}.js, src/router/index.js, src/controller/{auth,workflow,qbittorrent,system}.js, src/service/auth.js, test/api.test.js。

Interfaces: createApp({config,services}) -> Koa；createServices(config) -> 三方客户端、库服务、队列、认证；所有控制器读 ctx 并调用 service。

- [x] 编写真实本地 HTTP 测试：登录、会话过期、CSRF、Bearer 权限隔离、RSS 参数验证、分页、API 404、静态文件不泄露配置。
- [x] 运行测试确认失败，再实现 router/controller/service 绑定与统一错误响应。
- [x] 实现环境加载、同源静态产物托管、关闭信号和队列排空。
- [x] 运行全套测试，全部通过。

## Task 5: 中文管理面板

Files: web/{package.json,index.html,vite.config.js}, web/src/{main.js,App.vue,style.css}, web/src/{api,router,components,views}/，test/ui（浏览器 smoke）。

Interfaces: api(path,options) -> response data；页面使用 session cookie 和 CSRF；任务详情支持可见性轮询。

- [x] 使用 mock API 定义登录、RSS 规则、候选确认和错误状态的浏览器行为验证。
- [x] 实现侧栏、登录、概览、RSS、任务列表/详情、未识别媒体和连接设置。
- [x] 运行 npm run build；通过浏览器验证登录、路由、任务轮询、RSS 表单和候选确认，检查桌面和小屏。

## Task 6: 通知脚本、说明和最终验证

Files: scripts/{notify-completed,check-connections}.mjs, README.md, .env（ignored）, docs/superpowers/implementation-ledger.md。

- [x] 使用本地接收器验证通知脚本正确提交 hash、认证头和退出码。
- [x] 写入实际本地配置，生成独立管理/通知令牌；读取检查不输出凭据。
- [x] 文档覆盖 Windows/Linux/Docker 下载完成命令、安装启动、映射、dryRun 和内存限制。
- [x] npm test、npm run build、只读连接检查；执行 fresh-context 代码审查并修复关键问题。
- [x] 汇报启动方式、验证结果及真实写入联调范围，不推送或部署远程服务。
