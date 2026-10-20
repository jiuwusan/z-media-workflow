# 工作流 SQLite 持久层 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 重启后保留工作流历史、人工候选及已接受队列，通过写入意图和外部回读恢复中断操作。

**Architecture:** SQLite Repository 负责持久状态，单消费者读取可序列化动作。外部修改前保存意图，恢复时先核对目标再补齐本地结果；配置、游标和会话的存储边界保持设计约定。

**Tech Stack:** Node >=22.13.0、ES modules、node:sqlite DatabaseSync、Koa、Vue 3、node:test、Playwright、PM2。

**Spec:** [工作流持久层设计](../specs/2026-10-20-workflow-persistence-design.md)

## Global Constraints

- 数据库固定为配置文件所在目录下的 workflow.sqlite；Docker 默认路径为 /app/data/workflow.sqlite。
- 使用 Node 内置 node:sqlite 的 DatabaseSync，不引入 ORM 或第三方原生驱动。
- 启用 foreign_keys、WAL、synchronous=FULL 和 busy_timeout=5000。
- 单进程、单消费者；事务不跨网络请求或等待；历史列表在 SQL 内分页。
- 配置仍使用 config.json，媒体识别游标仍使用 media-cursors.json，登录会话仍在内存中，重启后重新登录。
- 媒体库纠错仍只允许手动选择候选；保留现有自动识别策略、刷新范围、等待配置及页面重启繁忙检查。
- 中断使用现有 failed 状态并附加 recoveryState=interrupted；未知写入结果不能盲目重发。
- 不自动删除损坏数据库，不降级到内存接收任务，不向数据库写入凭据，不对真实媒体执行测试写入。
- 保留 PM2 max_memory_restart=256M；本次不保证所有任务峰值内存低于该阈值。

## Review Focus

1. HTTP 已接收修改但响应丢失：重启/重试先核对，确认成功后不重复写入（任务 4、5）。
2. 配置中的服务地址变化：历史可读，旧动作禁止操作新服务；相同 hash 在不同 qBittorrent 来源独立去重（任务 2、4）。
3. 任务同时包含已完成、待人工确认和中断条目：重试只处理未完成部分，原候选和成功结果保留（任务 3、4）。
4. 数据库锁定、磁盘写入失败或不支持的结构版本：不返回虚假接收成功，不继续外部修改（任务 1、3、6）。
5. 自动识别已写入游标但数据库尚未收尾：重启可重复收尾；纠错始终不写游标（任务 4、7）。

## 文件与接口约定

新增 src/storage/database.js（连接和迁移）、src/storage/workflow-repository.js（SQL）、src/service/workflow-recovery.js（意图核对），不将 workflow.js 拆成无关模块。新增 test/helpers/persistence.js 提供隔离文件数据库和假上游；新增 *.test.js 进入现有 npm test，进程崩溃子程序放在 test/fixtures/，不被自动发现为测试。

下文类型为文档中的 JS 对象约定，不新增 TypeScript：

- Job：现有 API 任务对象，加可选 recoveryState、sourceScope、parentJobId；items 仍为现有条目数组。
- Entry：现有条目，加稳定 entryKey、phase、intent、recoveryState；文件条目键为 hash:index，媒体条目键为 itemId。
- Action：{ id, jobId, kind, status, payload, sequence }；kind 为 run/search/confirm/retry，status 为 queued/running/completed/failed。
- SourceScope：{ jellyfinUrl, qbtUrl }，规范化 URL；所有持久载荷先脱敏。
- Intent：{ kind: 'jellyfin.apply' | 'qbt.rename', sourceScope, target, expected }，target 含身份快照；expected 含预期元数据或 oldPath/newPath。

## Task 1: 可迁移的 SQLite 连接

**Files:** Create src/storage/database.js、test/database.test.js；Modify package.json、package-lock.json、.gitignore、.dockerignore。

**Interfaces:** `openWorkflowDatabase(filename: string): WorkflowDatabase`；返回 `{ connection: DatabaseSync, transaction(fn): any, close(): void }`。transaction 不接受异步回调，异常回滚。schema v1 创建设计中的三张表和索引；database.js 是唯一执行结构迁移的位置。

核心断言（db 为临时文件连接）：
```js
assert.equal(db.connection.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
assert.equal(db.connection.prepare('PRAGMA synchronous').get().synchronous, 2);
assert.equal(db.connection.prepare('PRAGMA busy_timeout').get().timeout, 5000);
```

- [x] **Step 1: 写失败测试。** 在临时目录创建数据库，断言 foreign_keys=1、journal_mode=wal、synchronous=2、busy_timeout=5000、user_version=1；事务插入后抛错应无记录；关闭重开记录保留。另测 user_version=999、损坏文件、锁定写入，均抛错且不清空文件。所有临时目录通过 t.after 清理。
- [x] **Step 2: 验证失败。** `node --test test/database.test.js`，预期缺少模块而失败。
- [x] **Step 3: 实现连接和迁移。** 使用预编译参数绑定；表外键级联。最低 Node 改为 >=22.13.0，更新 lockfile 的 engines 元数据。Git/镜像排除 *.sqlite、*.sqlite-wal、*.sqlite-shm，防止自定义配置目录中的运行数据进入构建。
- [x] **Step 4: 验证。** 同一测试命令全部通过，`git diff --check` 无错误；检查错误日志未打印 SQL 参数或凭据。
- [x] **Step 5: 提交。** `git add src/storage/database.js test/database.test.js package.json package-lock.json .gitignore .dockerignore`；`git commit -m "feat: 增加工作流SQLite存储及版本迁移"`。

## Task 2: Repository 与持久动作协议

**Files:** Create src/storage/workflow-repository.js、test/workflow-repository.test.js、test/helpers/persistence.js。

**Consumes:** Task 1 的 WorkflowDatabase。

**Produces:** `new WorkflowRepository(database, { maxJobs, maxQueue, jobTtlMs })`，同步接口如下：

- `accept({ input, sourceScope, recovery = [], options = {}, parentJobId }): Job`：同事务清理、去重、容量校验，新增 job 和 run/retry 动作，返回新任务或去重命中任务。
- `enqueueAction(jobId, { kind, payload }): Job`：校验任务/条目当前版本，原子更新任务并新增 search/confirm；固化候选快照。
- `get(id): Job`、`list({ page, pageSize }): { items, total, page, pageSize }`、`summary(): { counts, queued, running }`。
- `claimNext(): Action | null`：事务领取最早 queued；`save(job, { actionId, actionStatus } = {}): void`：原子保存摘要、条目和可选动作状态。
- `runningActions(): Action[]`：仅查询需恢复的 running；`prune(now = Date.now()): void`。

测试工具 `persistenceFixture(t): { filename, database, repository }` 创建隔离临时数据库；`fakeUpstreams()` 返回可变媒体/文件集合、外部调用计数和无凭据假配置。fixture 不读取工作区 data 目录。

核心断言（repo 为 fixture.repository，scope 为假服务地址）：
```js
const input = { hash: 'a'.repeat(40), event: 'completed' };
const first = repo.accept({ input, sourceScope: scope });
assert.equal(repo.accept({ input, sourceScope: scope }).id, first.id);
assert.equal(repo.claimNext().jobId, first.id);
assert.equal(repo.claimNext(), null);
```

- [x] **Step 1: 写失败测试。** 新建/重开后的候选 ID 和 JSON 结果相同；相同来源/hash/事件命中原任务，不同来源不命中；显式 recheck 语义沿用当前行为；任务与动作写入任一步失败均整体回滚。
- [x] **Step 2: 补齐查询与清理断言。** FIFO 顺序稳定；列表倒序分页且仅返回摘要/itemCount；MAX_QUEUE/MAX_JOBS 返回 429；TTL 清理普通终态及级联动作，保护 queued/running/needs_review/未解决意图；过期后允许新回调。
- [x] **Step 3: 运行失败测试。** `node --test test/workflow-repository.test.js` 预期缺少 Repository 而失败。
- [x] **Step 4: 实现上述接口。** SQL 条件过滤来源、状态、时间，LIMIT/OFFSET 分页；保存时不复制所有历史任务。任务顺序使用数据库整数，避免时间相同导致不稳定排序。confirm/search 的入队校验必须在事务中执行，防止并发确认同一条目。
- [x] **Step 5: 验证并提交。** `node --test test/database.test.js test/workflow-repository.test.js` 全通过；提交新增三个文件，信息为 `feat: 持久化任务结果与可恢复队列动作`。

## Task 3: WorkflowService 消费持久队列

**Files:** Modify src/service/workflow.js、test/workflow.test.js、test/ai-candidate.test.js、test/download-refresh.test.js、test/media-library.test.js；Create test/workflow-persistence.test.js。

**Consumes:** Task 2 Repository。`WorkflowService(config, services, { repository, autoStart = true } = {})`；未注入时只为直接构造的单元测试创建独立 :memory: SQLite Repository，生产装配必须显式传文件 Repository。

**Produces:** `start(): Promise<void>`、`ready: boolean`、`storageError: Error | null`；公开 get/list/summary/enqueue/retry/search/confirm 保持同步；`dispatch(action): Promise<void>` 消费描述符；`checkpoint(job): void` 保存当前上下文；`close(timeoutMs): Promise<boolean>` 停止领取新动作并等当前动作结束。autoStart=false 支持测试预置队列后启动；start 幂等。

恢复候选的断言（before/after 分别为同一文件数据库关闭前/重开后读取的任务）：
```js
assert.equal(after.status, 'needs_review');
assert.deepEqual(after.items[0].candidates, before.items[0].candidates);
assert.equal(after.items[0].candidates[0].candidateId, before.items[0].candidates[0].candidateId);
```

- [x] **Step 1: 写失败测试。** autoStart=false 接受 run/search/confirm 后销毁实例，另一个实例恢复时执行描述符；candidateId 保持一致；入队持久化失败时同步抛错且没有虚假任务/远程调用。测试直接注入失败 Repository，不模拟真实磁盘损坏。
- [x] **Step 2: 运行。** `node --test test/workflow-persistence.test.js`，预期新参数/恢复行为尚不支持。
- [x] **Step 3: 替换 Map/闭包队列。** 通过 Repository 查询和领取动作，显式 dispatch 分支；保留候选策略，不改变纠错 dryRun 规则。搜索结果、人工选择、警告、错误和最终状态全部 checkpoint；重试快照在接受时落盘，含已完成条目键与原候选，不依赖 recoveries Map。
- [x] **Step 4: 定义中断/重试边界。** 重试建立关联 parentJobId 的新任务，复制待恢复条目，仅处理失败/中断部分；原 needs_review 条目仍留原任务。重试核对或完成后才清除原条目的未解决意图标记；失败则两边保留恢复关联。扫描未完整读取时可补读范围，但跳过已完成条目。已有种子批量检查也按已处理文件键跳过完成结果。
- [x] **Step 5: 测混合任务及保存故障。** 同任务 completed/needs_review/failed 三种条目重启后保持内容；重试不再写 completed，不自动确认 needs_review。checkpoint 出错应关闭写入入口并停止后续派发，正在等待的动作留数据库；get/list 仍可读取已提交结果。
- [x] **Step 6: 验证并提交。** `npm test` 全通过；必要时将依赖 workflow.jobs/recoveries 内部实现的旧测试改为 Repository/公开接口断言，不删业务断言。提交工作流和相关测试，信息为 `refactor: 使用持久动作驱动工作流执行`。

## Task 4: Jellyfin 写入意图与中断核对

**Files:** Create src/service/workflow-recovery.js、test/workflow-recovery.test.js；Modify src/service/workflow.js、src/service/jellyfin.js、src/util/media.js、test/jellyfin-identification.test.js。

**Consumes:** Repository save/get/runningActions、媒体 ensureItem/markIdentified、Jellyfin item/apply。

**Produces:** `recoverRunningActions({ repository, services, sourceScope }): Promise<void>`；`reconcileIntent(intent, services): Promise<{ state: 'matched' | 'unchanged' | 'conflict' | 'unknown', item?, reason? }>`；`matchesExpectedMedia(item, intent): boolean`。仅逐条读取目标，不复用 verify 的轮询等待，也不调用 apply。

匹配意图的断言（intent 为已持久化的媒体意图，fake item 与 expected 相符）：
```js
const result = await reconcileIntent(intent, services);
assert.equal(result.state, 'matched');
assert.equal(services.jellyfin.apply.mock.callCount(), 0);
```

- [x] **Step 1: 写失败测试。** prepared 意图回读到相符类型/路径/媒体库/Name/年份/ProviderIds 后补记完成，apply 调用数保持 0；仅有相同 ProviderIds 但名称或路径不符不能判成功。模拟 apply 已生效但抛出连接错误，再重启，断言不重复 apply。
- [x] **Step 2: 验证失败。** `node --test test/workflow-recovery.test.js` 预期缺少核对实现。
- [x] **Step 3: 保存写意图。** applyCandidate 在请求前提交 prepared、完整候选和目标快照；目标快照包含写入前 Name/年份/ProviderIds，用于判断 unchanged。正常提交后单次回读，符合则 verified → 自动识别游标确认 → completed。回读暂不符合/网络失败显示结果待核对，保留意图，重试先核对再决定。后台 FullRefresh 失败只记录 warning，不把已确认写入重新执行。
- [x] **Step 4: 实现恢复分类。** start 时先调用 recoverRunningActions；无意图 running 转 failed/interrupted，保留成功和待确认条目；有意图按匹配状态收尾或中断。来源变化只保留历史并阻止执行；通过读取旧目标快照区分 unchanged 与 conflict，无法证明 unchanged 时不重发。媒体被删除、换库/换路径都视为不可自动重试。
- [x] **Step 5: 补测试。** 分别在游标写入前/后异常，重开后只补齐本地状态且 cursor.confirm 可重复；correction 所有路径 cursor.confirm 调用数为 0；新 Jellyfin 地址与旧地址相同 itemId 也不得执行旧确认；服务离线可完成启动分类，但保留待核对意图。
- [x] **Step 6: 验证并提交。** `node --test test/workflow-recovery.test.js test/jellyfin-identification.test.js test/media-cursor.test.js test/workflow-persistence.test.js` 及 `npm test` 通过，提交信息 `feat: 通过持久意图核对并恢复媒体识别`。

## Task 5: qBittorrent 命名检查点

**Files:** Modify src/service/torrent-naming.js、src/service/workflow.js、src/service/workflow-recovery.js、test/torrent-naming.test.js、test/workflow-recovery.test.js。

**Consumes:** Task 4 reconcileIntent；Task 3 checkpoint。

**Produces:** `TorrentNamingService.run(job, update, checkpoint = () => {}): Promise<void>`。写入前保存 hash/index/分类快照/oldPath/newPath/AI 决策；文件列表读取、目标冲突检查和原有回读规则仍保留。

重命名响应丢失后的断言（beforeCalls 为终止子进程前调用数，after 为恢复任务）：
```js
assert.equal(beforeCalls, 1);
assert.equal(services.qbittorrent.renameFile.mock.callCount(), beforeCalls);
assert.equal(after.items[0].status, 'completed');
```

- [x] **Step 1: 写失败测试。** renameFile 修改假文件列表后抛错，重开任务后文件名等于 newPath，断言 renameFile 总调用数为 1；等于 oldPath 时转可重试中断，启动不自动发送；第三种名称、索引缺失、分类不匹配、目标名占用均停止。
- [x] **Step 2: 验证失败。** `node --test test/torrent-naming.test.js test/workflow-recovery.test.js`，新增检查点断言失败。
- [x] **Step 3: 接入意图与恢复。** 在调用 renameFile 前 checkpoint prepared，确认回读后 checkpoint completed；每个文件稳定条目键防止批量重试重复添加。恢复与重试使用保存的目标名，不能重新调用 AI 改写原意图；未生成决定的条目允许正常 AI 判断。
- [x] **Step 4: 验证并提交。** 上述命令和 `npm test` 通过；检查文件名碰撞仍忽略大小写，分类校验仍在写入前执行。提交信息 `feat: 持久化种子重命名检查点并核对恢复`。

## Task 6: 服务装配、关闭与页面状态

**Files:** Modify src/service/index.js、src/app.js、src/server.js、src/controller/lifecycle.js、web/src/components/ConfigurationEditor.vue、web/src/views/JobDetail.vue、README.md、test/setup.test.js、test/restart.test.js、test/api.test.js、test/ui.smoke.mjs；Create test/persistence-lifecycle.test.js。

**Consumes:** 生产 createServices 显式打开 path.join(path.dirname(config.configFile), 'workflow.sqlite')；注入 Repository；调用 workflow.start()，记录启动失败而不产生未处理 Promise。容器仍只有一个消费者。

**Produces:** createServices 的 services 对象增加 `close(timeoutMs): Promise<boolean>`，负责 workflow.close 后关闭数据库；超时不在仍执行动作时提前关库，由退出进程中断连接。Workflow.ready 为 false 或 storageError 存在时，API 工作流写入返回 503，health 返回 503 和 starting/unavailable，不影响登录与历史只读查询；未初始化的 setup 健康规则保留。

不可写状态的断言（response 为已认证的工作流提交请求，workflow 注入 storageError）：
```js
assert.equal(response.status, 503);
assert.equal(services.jellyfin.apply.mock.callCount(), 0);
```

- [x] **Step 1: 写失败测试。** 两次从同一配置目录装配服务可读取历史；未初始化不创建数据库；迁移失败不能报告 ready 或返回 202；关闭期间 queued 留库且不继续领取，重建后顺序恢复。注入 servicesFactory 的现有 API 测试保持兼容。
- [x] **Step 2: 运行。** `node --test test/persistence-lifecycle.test.js test/setup.test.js test/restart.test.js` 预期生命周期断言失败。
- [x] **Step 3: 接入生命周期。** shutdown 使用 services.close；激活替换前先关闭旧消费者，启动错误返回明确脱敏信息。页面重启继续拒绝 queued/running/needs_review 及清理执行中状态，不借此扩大权限。持久层错误阻止工作流写入，但不以健康错误伪装重启成功。
- [x] **Step 4: 更新页面与文档。** 重启确认改为“任务记录和候选结果会保留，登录会话失效，服务恢复后需要重新登录”；详情给中断/待核对明确提示，保留混合任务重试入口。README 更新 Node 版本、SQLite 实验性接口说明、数据卷内容、首次升级无法迁移内存历史、停服务备份整个 data 目录和回滚限制、256M 重启恢复边界；删除重启清空任务的旧说明。
- [x] **Step 5: 验证并提交。** `npm test`、`npm run build`、`npm run test:ui` 均通过；UI 假数据覆盖混合任务和新重启说明。提交信息 `feat: 集成持久工作流生命周期与恢复提示`。

## Task 7: 进程崩溃与 PM2 端到端验证

**Files:** Create test/workflow-crash.test.js、test/fixtures/workflow-crash-worker.mjs；Modify test/pm2.smoke.mjs、README.md（仅记录实际运行限制）。

**Consumes:** 前六项生产接口；崩溃子进程注入假服务和 checkpoint 包装器，不能在生产代码新增公开测试接口。

PM2 重启断言（before/after 为 health 数据，restored 为重新登录后的任务详情）：
```js
assert.notEqual(after.instanceId, before.instanceId);
assert.equal(oldSessionResponse.status, 401);
assert.deepEqual(restored.items[0].candidates, saved.items[0].candidates);
```

- [x] **Step 1: 写崩溃集成测试。** 父进程启动临时假 HTTP 上游并维护远程状态/调用计数；子进程在 prepared 提交后、外部请求成功后、回读后、游标确认后通过 IPC 通知父进程，父进程终止子进程，再用同数据库启动恢复。逐场景断言历史/候选可读、确认过的写入次数不增长、未解决意图保留、自动游标可收尾、纠错不写游标。queued 尚未领取时重启应执行一次。
- [x] **Step 2: 验证测试能发现缺陷。** 先运行 `node --test test/workflow-crash.test.js`；如果实现已使其通过，临时撤掉一个测试专用 checkpoint 包装调用验证相应场景会失败，再恢复，不改生产代码制造失败。
- [x] **Step 3: 扩展隔离 PM2 测试。** 在临时 data 中预置终态历史、待确认候选和 queued 动作。queued 完成后通过 PM2 管理重启验证候选保留；因 needs_review 存在页面重启应 409，单独在无待确认的阶段测试页面重启 202、新 instanceId、旧会话 401、历史保留。使用已有独立 PM2_HOME 并完整清理所有子进程。
- [x] **Step 4: 完整验证。** `npm test`、`npm run build`、`npm run test:ui`、`npm run test:pm2`、`git diff --check`。上述崩溃测试计入 npm test，不重复运行无新变化的检查。确认正常退出后数据库可重开，运行数据未出现在 git status。
- [x] **Step 5: 环境验证与提交。** 若 Docker 可用，构建镜像并用临时卷验证 node 用户写权限、容器重建保留数据；没有 Docker 则在交付记录明确未验证，禁止声称容器测试通过。提交信息 `test: 验证崩溃及PM2重启后的任务恢复`。

## 自审与交付

实施按 1 → 2 → 3 → 4 → 5 → 6 → 7 顺序，步骤间共享状态和接口，不并行修改核心工作流。每项完成后记录测试命令与结果；最后审查整个分支的意图保存顺序、恢复来源校验和旧行为回归。提交仅包含本次改动，不自动推送；交付时列出测试证据及实际环境限制。

计划自审已核对：设计各部分均有对应任务；Review Focus 五项都有具体验证；公开 API 的同步返回语义、start/close、Repository 和恢复函数的命名保持一致。实施开始前由用户审阅本计划并选择执行方式。

## 执行结果（2026-10-20）

七项任务已实施。最终后端测试 222/222，含五种强制退出场景；隔离真实 PM2 重启测试 1/1。前端构建通过，浏览器混合任务验证补充到现有 UI 测试。Docker 命令不可用，容器构建及卷权限未做实测。

独立整分支审查发现八项恢复边界问题，均以失败测试复现并修复：完整批次计划、重试载荷恢复、纠错原选择保留、无意图中断可重试、混合状态去重、结构键不参与脱敏、完成文件跳过、预检失败消解。另补齐队列满时重复回调命中及父历史被清理后的重试验证。

实施裁决：保留原有正常 HTTP 成功提交即完成的语义，verified 表示收到成功响应，不新增正常路径的元数据回读/轮询；不确定响应或崩溃才回读。代价是成功响应后仍可能存在远端后台加载延迟。Windows 缺少 Bash，使用 PowerShell 保存同等执行记录，无产品行为差异。Docker 实测交由具备 Docker 的环境完成，部署兼容性仍有未实测范围。
