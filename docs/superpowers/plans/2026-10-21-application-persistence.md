# 应用数据持久化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 将全量配置、认证状态、游标与清理历史迁移至 SQLite，提供一次性可跳过游标引导及 passkey 账号恢复。

**Architecture:** 启动入口持有应用级 SQLite 连接，各 Repository 共享事务。初始化前不消费旧队列；配置、凭据、游标初始化原子提交。删除与媒体写入保留意图及核对机制。

**Tech Stack:** Node >=22.13、node:sqlite、scrypt、Koa、Vue 3、node:test、Playwright、PM2。

**Spec:** [最终设计](../specs/2026-10-21-application-persistence-design.md)

## Global Constraints

- 不读取/导入 config.json 或 media-cursors.json；默认端口 3000。
- 唯一数据源 data/workflow.sqlite；保留旧工作流表；data/passkey 首次独占创建并落盘。
- ADMIN_PASSWORD 只保存 scrypt 哈希；恢复密钥只在文件明文保存，数据库只保存摘要。
- 引导仅一次，游标同步可跳过；初始化后没有游标管理和重导入接口。
- 登录/恢复 10 次尝试/15 分钟，恢复凭证 5 分钟且一次性；会话仍在内存。
- 审计 90 天/10000 条；清理历史 30 天/1000 个已结束批次，中断待核对不自动淘汰。
- 不对真实媒体做测试修改；不自动重发历史删除文件请求。

## Review Focus

1. 半初始化及孤立 passkey：失败可重试，不能丢失旧工作流或开放已初始化引导。
2. 密码恢复并发/旧会话：凭据版本检查、一次消费和持久限流不能绕过。
3. 基础配置待重启时修改即时设置：保存不同字段不得互相覆盖，审计须同事务。
4. 游标导入不匹配服务器或缺少旧 pending：范围不重映射，只对已核实意图补登记收尾。
5. 清理响应丢失、来源改变或数据库失败：保留记录，核对读取但不重放删除。

## Task 1: 数据库与配置/认证 Repository

**Files:** src/storage/database.js；新增 application-repository.js、audit-repository.js、credentials.js；test/application-storage.test.js。
**Interfaces:** ApplicationRepository(database) 提供 initialized/readConfig/initialize/updateConfig/credential/replacePassword/attempt/clearAttempts/createRecovery/consumeRecovery；AuditRepository 提供 append/list/prune；事务允许同步嵌套共享外层。

- [x] 写失败测试：schema v1 升级保留任务；初始化拒绝重复，密码不存原文；revision 冲突及审计失败全部回滚；持久限流、恢复凭证过期/重复/版本失效。
- [x] `node --test test/application-storage.test.js` 确认失败，再实现 schema v2、同步短事务、密码 scrypt 参数及随机摘要工具。
- [x] 上述测试通过并提交；原数据库断言按新版 schema 更新，不删保留/损坏/锁定断言。

## Task 2: 数据库游标与事务收尾

**Files:** 新增 src/storage/cursor-repository.js、test/database-cursor.test.js；修改 media-library/workflow/workflow-recovery。
**Interfaces:** CursorRepository(database, server) 提供 track/confirm/needsIdentification/importSnapshot/summary；parseCursorSnapshot(value) 严格验证 v1 与 10MiB 上限；运行中不读 JSON 文件。

- [x] 写失败测试：JSON 完整校验、重复 ID 去重、日期语义、跨实例读取、工作流保存失败回滚游标；不存在 pending 只有已核实恢复才能补登记。
- [x] 跑失败测试后实现 SQL 范围与成员表；工作流 checkpoint/恢复保存与 cursor.confirm 在共用事务中收尾；人工纠错不写游标。
- [x] `node --test test/database-cursor.test.js test/workflow-recovery.test.js` 通过并提交。

## Task 3: 启动、设置与账号恢复

**Files:** src/config/index.js、service/setup/configuration/auth/index、controller/auth/configuration/qbittorrent、app/router/server；新增 recovery service、test/application-lifecycle.test.js；更新受影响配置/引导测试。
**Interfaces:** SetupService(directory) 先打开数据库；config=null 表示未初始化；complete(ctx) 校验游标模式 import/skip，创建 passkey 后事务初始化。createServices(config,{database,repository}) 复用连接。ConfigurationService 读取 DB 版本并提供带审计 patch；AuthService 使用持久凭据与版本。恢复 routes 为 GET /api/auth/recovery/context、POST /api/auth/recovery/verify、POST /api/auth/recovery/reset。

- [x] 写失败测试：损坏旧文件仍进入引导；无 passkey 写权限不初始化；初始化后再次导入 409；找回 nonce/CSRF、用户名保密、密码更新即时生效、旧会话失效。
- [x] 跑失败测试，再替换生产文件访问；普通配置保存后重启生效、分类/清理即时生效；修改历史分页需要管理员。初始化单独允许大 JSON，请求须明确同步/跳过。
- [x] 调整旧测试为数据库 fixture，保留原校验、CSRF、端口映射及非本机 Origin 访问断言；删除仅针对旧文件机制的假设。
- [x] `npm test` 通过并提交。

## Task 4: 清理历史与恢复

**Files:** 新增 cleanup-repository.js、test/cleanup-history.test.js；修改 qbittorrent service/controller/index/router。
**Interfaces:** CleanupRepository 提供 begin/save/list/get/recover；合法请求先落库，逐条 prepared 后才删除；recover 只回读状态。

- [x] 写失败测试：预览与实际批次可重开读取；数据库拒写时删除调用为零；来源改变不核对；重启后中断种子不存在只能记 absent，不能推断文件删除。
- [x] 运行失败测试，再接入配置来源/业务审计，增加管理员历史列表/详情；关闭同时等清理结束，故障保留中断记录。
- [x] `node --test test/cleanup-history.test.js test/torrent-cleanup.test.js` 及全套通过并提交。

## Task 5: 引导、找回及历史界面

**Files:** web/src/views/Setup/Login/Configuration、ConfigurationEditor/TorrentCleanup、router；新增 Recovery.vue；UI 冒烟与 README/config.example.json。

- [x] 先写 UI 用例：四步引导，JSON 预览和跳过均可完成；初始化后无游标管理；passkey 恢复可登录且旧密码失败；审计与清理历史分页可读。
- [x] 构建后运行对应 UI 测试确认失败，再实现界面；清除提交后的密码/密钥/游标输入，恢复令牌仅在内存。
- [x] 更新数据库配置/备份、passkey 保存位置和不兼容旧文件的说明；`npm run build`、`npm run test:ui` 通过并提交。

## Task 6: 整体验证与独立审查

**Files:** test/pm2.smoke.mjs、workflow-crash fixtures、相关集成测试及本计划。

- [x] PM2 从未初始化数据库走引导，保存配置后重启读 DB；会话失效，游标及持久限制保留，旧队列在初始化后恢复。
- [x] `npm test`、`npm run build`、`npm run test:ui`、`npm run test:pm2`、`git diff --check`；真实 Docker 可用则验证，否则记录未实测。
- [x] 一次独立整分支审查；重要问题用失败测试复现后修复，记录结果与裁决，提交实现；未经请求不推送或合并。

## 执行说明

用户已明确要求开始代码落地，沿用当前会话直接实施的选择。本计划记录具体步骤后连续执行，不再重复请求实现授权。
