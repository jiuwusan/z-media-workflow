# Execution ledger — plan: plans/2026-10-02-media-workflow.md

Ruling: 用户已确认“按更新后的设计开始实施”，继续在当前会话实施，不再次要求相同范围的授权。

Ruling: 用户指定现有项目目录，使用 feat/media-workflow-panel 分支原地实现；不额外搬移到 worktree。

Pre-flight: Task 1 的 HTTP/媒体工具由 Task 2/3 使用，客户端由 Task 3 使用，Task 4 将服务暴露给 Task 5；接口一致。

Task 1: complete — HTTP prefix/redirect, path mapping, candidate and JSON validation tests passed.
Task 2: complete — scan race/failure/timeout, pagination, API-key-only item readback, RSS native merge tests passed.
Task 3: complete — serial queue, hash dedup, dryRun, ambiguity, partial ingest and verification recovery tests passed.
Task 4: complete — real HTTP API tests for cookie, Origin/CSRF, token permission separation, input validation and config protection passed.
Task 5: complete — production build and headless Edge smoke test covering login, RSS edit, candidate preview/search/confirm, mobile navigation and logout passed.
Task 6: complete — 29 unit/API/script tests and the headless browser smoke test passed; production build passed. Real read-only checks passed (qBittorrent 5.2.3, Jellyfin 10.11.11, DeepSeek models; 26 scoped items, zero unidentified). One actual DeepSeek extraction returned Dune/2021; Jellyfin RemoteSearch returned 31 candidates including 沙丘 (2021) / Tmdb 438631. No real metadata apply, RSS mutation or library refresh was executed.

Local runtime: npm start is running at http://localhost:3000; real browser login and three connection checks passed. Real panel screenshot: .test-artifacts/panel-real-desktop.png. Management and callback tokens remain only in ignored .env.

Review: fresh reviewer identified RSS replacement history loss, nullable pause mode, native torrentParams precedence, verification retry loss, multi-file partial ingest and selective-download mismatch. Each fixed with regression tests.

Ruling: use global Items?Ids= for single-item readback; this Jellyfin server returns 400 for user-context /Items/{id} with an API key alone.

Ruling: explicitly disable DeepSeek thinking for compact JSON extraction; preserve strict JSON validation and reject truncated completion.

Ruling: keep source changes uncommitted in the specified directory and feature branch; no push, merge, remote deployment, remote RSS edits or metadata apply during verification.

## User-authorized live Series test (2026-10-02)

User added unrecognized Series and authorized testing. Scoped the test to three exact item IDs; no RSS configuration or media file changes.

- Initial task: scan completion and all three DeepSeek identities succeeded, but Series RemoteSearch returned PremiereDate without ProductionYear. Strict year matching correctly prevented automatic application.
- Fix: derive missing candidate ProductionYear from a valid PremiereDate; preserve explicit ProductionYear and reject invalid/default dates. Added a failing regression test, implemented the fix, then passed all 30 unit/API/script tests and the browser smoke test.
- Final task: `56e22c73-0c3a-426b-9ebf-c1d65d40ea1c` (http://localhost:3000/jobs/56e22c73-0c3a-426b-9ebf-c1d65d40ea1c), completed.
- 天下长河 (2022): applied and readback confirmed Tmdb 214308, Imdb tt23473346, Tvdb 432893.
- 我们的河山 (2025): applied and readback confirmed Tmdb 297668; Jellyfin additionally populated Imdb tt34749087.
- 与晋长安 (2025): selected Tmdb 253093, rejected same-name 2026 candidate Tmdb 336490; readback confirmed Imdb tt32365655 and Tvdb 449572 as well.
- Apply requests exceeded the 15-second HTTP timeout but actually completed server-side. The existing readback verification confirmed IDs, names and years before marking each entry completed; no blind repeated application was performed.
- Detailed local report: `.test-artifacts/live-series-test.json` (ignored). Local service remains running, final task is visible in the panel.
