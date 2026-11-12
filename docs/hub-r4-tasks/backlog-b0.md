# 全量积压 B0：可靠验证与基准校准

## 来源和范围

来源：所有者 2026-11-09 批准本会话的全量开启 Issue 修复计划；同意以最新 `origin/main` 为基线、独立工作树/任务分支、签署提交、推送和 PR，部署另行确认。原有 `hub-redesign` 基线规则由本次明确决定取代，本任务不修改运行部署。

任务分支 `fix/backlog-b0-baseline`，基线 `aded2ffd`。关联 #165、#196、#246、#247；不改其他维护者的现有分支。

## 允许路径

- `hub/records/personal-caches.ts`、`personal-caches.test.ts`、`README.md`
- `hub/server/console/testing-member-deletion-browser.ts`
- `docs/design/console-navigation.md`
- `docs/design/circle-design-system/components/Sidebar/README.md`
- `CHANGELOG.md`
- `docs/hub-r4-tasks/backlog-b0.md`
- `docs/hub-r4-progress.md`（追加本次授权、基准核对和实际检查）

## 核对结果

- #196 的邀请写入时钟修复已由 #248 合入当前基线，不重复改写。列明的连接器、平台文件/TLS、控制台实时会话和追踪测试将按时钟消费者逐项核查并实际运行；固定日期与真实等待计时同文件出现不等于故障。
- #165 初始定向运行通过不能排除竞态。清理函数在 `lstat` 与 `chmod` 之间有真实 TOCTOU 窗口；测试以真实文件消失的确定同步信号复现，不添加重试。
- #247 按进度决定 137 的所有者明确答复：私人工作流/技能转给执行删除的管理员。原决定 140 中“不转归管理员”的阶段说明不能覆盖所有者决定；测试分别断言清除范围与转移说明。
- #246 当前公开 main 是九项导航，通用技能在工作流内；审查部署呈现独立技能入口，版本不同。本任务不擅自增加第十个入口；同步旧 Sidebar 的八项说明，并明确部署差异不作此基线的功能要求。

## 验收

- 清理时目录在观察后消失正常完成；非缺失错误仍传播；不跟随符号链接改变外部目录。
- 清除范围与私人包转移的独立浏览器断言符合当前决定，不删除检查逃避失败。
- 定向时钟、抽取/暂存、成员删除、导航与文档检查实际通过；跳过和失败如实记录。

## 实际验证

- 修改前：`node --test hub/runs/packs/personal-staging.test.ts hub/records/token-issuance.test.ts`（从任务工作树运行的等价路径），6 通过、0 失败、0 跳过。此结果不证明竞态不存在。
- 新增缓存清理回归在修复前确定失败：3 项中 1 通过、2 失败，分别在 `chmod` 和同步前 `open` 收到 ENOENT。错误来自 `hub/records/personal-caches.ts`，不是抽取树的 best-effort 删除函数；因此只修实际成员清理路径。
- 修复后 `node --test hub/records/personal-caches.test.ts hub/runs/packs/personal-staging.test.ts`：4 通过、0 失败、0 跳过。再运行 `hub/records/member-deletion.test.ts`、缓存回归、暂存和 `hub/runs/packs/extract.test.ts`：22 通过、0 失败、0 跳过。
- #196 列明的 `hub/connectors/session.test.ts`、`hub/platform/files.test.ts`、`hub/platform/tls.test.ts`、`hub/server/console-live.test.ts`、`hub/telemetry/store.test.ts`，加 `hub/records/token-issuance.test.ts`：105 通过、0 失败、0 跳过。
- 时钟核对：连接器的模拟来源、HTTP 与 LoginManager 共享注入时钟；真实 `Date.now()` 只用于有期限的等待，不比较模拟凭据过期。TLS固定日期用于证书结构/相对有效期，实际TLS握手使用当次真实签发。平台文件的时间戳命名与锁等待独立。控制台会话通过 createTestServer 同时给记录与会话注入时钟。追踪固定行只参与显式窗口；实时追踪的保留测试按当次真实时间算未来截止。未发现第二处邀请签发/读取时钟混用，不因同文件出现两种日期一概修改。
- `npm run typecheck`：初次失败 3 项，均是新增浏览器夹具使用了不存在的 `hub.registry`；改为 `hub.hub.registry` 后退出 0。
- 独立成员删除浏览器脚本：首轮夹具入口错误、第二轮提示气泡混入textContent的断言失败如实保留；改用具体标题文本节点后最终退出 0，6 个页面 × 深浅主题 × 3 屏宽共 36 图，含私人包实际转移、删除旧身份拒读、固定资源/nonce、键盘焦点与框内横滚检查。
- `npm run test:docs`：333 通过、0 失败、0 跳过。
- 本批未运行全量 unit/acceptance、Linux隔离或部署验证；不改合约、迁移、配置、来源基线或生产服务。

## 时钟检查约定

同一次到期/冷却/租约/保留测试的签发、持久化写入、读取和裁决对象必须使用同一个注入时钟，故障注入构造的替代对象也不能漏传。测试用真实时间只等待实际异步事件时，单独说明其用途；不把等待期限用于业务到期判断。固定证书/历史追踪样例可保留，但与操作系统当前时间比较的路径应使用当次签发或显式验证时刻。
