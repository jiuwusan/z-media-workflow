# 项目架构

Node.js 22.13+、ESM、Koa 3 + Vue/Vite 管理界面，SQLite 单实例持久化；保留现有 API、工作流状态机、回调、Docker 与 PM2 协议。

## 职责与依赖

- src/server.js、app.js、service/index.js 为启动/组合入口：配置、实例装配、生命周期和路由挂载。
- router：URL、方法与权限中间件编排；middleware：提取 Cookie/Bearer/HTTP 方法、写入请求会话状态；controller：请求参数和响应、首次配置/恢复及历史查询的 HTTP 适配。
- service：识别、命名、扫描、清理、配置、认证及恢复等用例；通过 gateway 发请求，通过 storage 持久化，不直接 fs/fetch。
- gateway/http.js：上游 HTTP，负责路径限制、超时、GET 重试、响应解析、图片类型及脱敏错误；service 中的协议类保留 qBittorrent/Jellyfin/DeepSeek 操作和用例排序，构造参数 http 可替换。
- storage：SQLite、任务/配置/游标/审计仓储、遗留文件兼容和原子恢复密钥写入；无业务 HTTP 请求。
- domain：媒体匹配、种子命名、分类规则及共享默认分类，无磁盘、网络或配置层依赖。
- config：运行参数、校验、启动时数据库装载和运行地址持久化；这是配置适配层，可引用 storage/domain/util。
- util：错误、校验、凭据、日志、等待等通用能力。旧 media、http、文件工具路径保留兼容导出，运行代码禁止引用旧路径。
- web/src：独立 Vue 浏览器应用，自己的页面、组件与接口适配；不导入后端模块。

静态矩阵由 scripts/check-architecture.mjs 通过 Acorn AST 执行：router → controller/middleware/util；middleware → middleware/service/util；controller → service/domain/config/util；service → service/domain/storage/gateway/config/util；gateway/storage → 自身/domain/util；domain → domain/util；util → util；config → config/storage/domain/util。app/server 可组装全部层；service/index 保持现有工厂契约。检查未分类模块、本地未解析导入、越层、循环、动态模块加载和 service/domain 的直接 fs/网络导入及 fetch。认证、恢复与首次配置服务仅接收普通值/命令并返回普通值，禁止持有 ctx/request/response/cookies；HTTP Cookie 属性、Header/Method 解析与会话 state 由 controller/middleware 负责，Cookie/CSRF 拒绝顺序及 HTTP 响应保持兼容。

## 状态和部署边界

工作流写前意图、崩溃恢复、游标和清理审计继续由原仓储维护，文件/SQLite 格式不迁移。上游任务通过注入客户端和轮询编排，持久化失败不得推进游标或标记成功。单进程拥有一个数据目录，PM2 使用原单实例配置；不通过多实例共享 SQLite/文件实现扩容。

Docker 必须同时包含 src、web 产物和运行依赖；测试、lint、解析器为开发依赖。停机需要等待任务/清理停止后关闭数据库。恢复 passkey 继续原子替换并以 0600 创建临时文件；日志和恢复机制兼容原实现，生产日志访问权限需要与数据目录同等保护。
