# `test:quick` 必过快速回归测试集说明

目标：将日常改动的最小必要回归验证控制在 **5 分钟（300 秒）以内**，覆盖「合约、类型、六个工具、团队和权限、密钥按名字取值、脑图编译路径上的验收」六大维度；**不删除、不弱化或跳过任何现有测试**，完整全量回归仍由 `npm run test:unit` 与 `npm run test:acceptance` 保留。

运行入口：

- `npm run test:quick`（对应 `node tools/run-quick-tests.ts`）
- `node tools/run-quick-tests.ts --list`（只列出全部检验维度与测试清单，不启动数据库）
- `node tools/run-quick-tests.ts --dry-run`（查看执行阶段与并发调度计划）

---

## 执行架构（为什么能压在 5 分钟内）

1. **前置零开销门禁（约 17–20 秒）**：先跑 `tools/gen-contracts.ts --check` 与两次 `tsc --noEmit`（主仓库 + `.github/checks`），任一失败直接退出，不启动 PostgreSQL。
2. **单次共享 PostgreSQL 模板复用**：借鉴 `tools/run-unit-tests.ts` 的 `prepareTemplate` + `sharedEnv` 方案，整个 `test:quick` 只启动 **1 个**共享 PostgreSQL 集群并预迁移 `hub_migrated` 模板库，随后单元测试泳道与验收测试泳道共同复用。
3. **长文件优先 + 受限并发**：单元测试泳道共 69 个文件，全部属于纯共享泳道（不含 `ISOLATED_MARK` 独占库和耗时毫秒敏感 sentinel），将耗时约 55 秒的 `hub/server/mcp.test.ts` 排在首位，其余 68 个快文件在并发槽位（`min(6, availableParallelism() - 1)`）上重叠消化；验收泳道 8 个文件以并发 1 顺序执行，避免争抢数据库与连接资源。
4. **Node 编译缓存**：临时设置 `NODE_COMPILE_CACHE`，结束或中断时自动清理。

---

## 六大维度的选入清单与理由

### 1. 合约（1 条检查命令 + 9 个测试文件）

- **选入项**：
  - 命令：`node tools/gen-contracts.ts --check`
  - 单测：`contracts/src/codes.test.ts`、`contracts/src/vocabulary.test.ts`、`contracts/src/tools.test.ts`、`contracts/src/tool-shapes.test.ts`、`contracts/src/mcp-client.test.ts`、`contracts/src/variables.test.ts`、`tools/gen-contracts.shared-interfaces.test.ts`、`tools/gen-contracts.pack-vocabulary.test.ts`、`tools/slot-schema.test.ts`
- **选择理由**：确保 `contracts/model.json`、`contracts/codes.json` 与 `contracts/generated/*` 零漂移，覆盖错误码唯一性与 namespaces、词表轴与 `labelOf`、六个工具声明顺序/注释/JSON Schema 2020-12 及客户端检查、C12 普通变量/密钥引用语法、共享接口和任务包词表/槽位投影生成逻辑。
- **留给全量的耗时兄弟**：`contracts/src/generator.test.ts`（约 10 秒且内部再次派生 `tsc`）留给完整单测。

### 2. 类型（2 条检查命令）

- **选入项**：
  - `node node_modules/typescript/bin/tsc --noEmit`（主仓库 `tsconfig.json`）
  - `node node_modules/typescript/bin/tsc --noEmit -p .github/checks`（仓库检查脚本）
- **选择理由**：全量静态类型检查与 `erasableSyntaxOnly` / `.ts` 导入规范门禁，耗时约 17 秒即可覆盖整个代码库，不可删减。

### 3. 六个工具（12 个测试文件）

- **选入项**：
  - `hub/server/mcp.test.ts`（HTTP MCP SDK 全量端到端契约：6 个工具、`tools/list`、`isError` 矩阵、trace/session、调用日志与令牌校验）
  - `hub/server/list-tools.test.ts`（精确 6 个工具列表与调用者包可见性）
  - `hub/runs/packs/ports.test.ts`（`WorkflowStore`、`PacksPort`、`PackCatalogPort`、`WHOLE_HUB` 产品绑定、`local_tools` 与 `list_task_packs` trace 记录）
  - `hub/server/declared-clients.test.ts`（MCP 客户端兼容性）
  - `hub/server/model-declaration-mcp.test.ts`（模型声明与读边界）
  - `hub/server/read-recovery-mcp.test.ts`（`resolve_reference` / 读取中断恢复）
  - `hub/server/local-tools.test.ts`（本地工具边界）
  - `hub/server/call-status.test.ts` 与 `hub/server/long-call-status.test.ts`（调用状态与长任务进度）
  - `hub/server/command-parameters.test.ts` 与 `hub/server/console/command-form.test.ts`（U2 命令参数结构与控制台渲染边界）
  - `hub/records/calllog.test.ts`（底层追加式调用记录与幂等基础）
- **选择理由**：直接守护 MCP 协议边界、六个工具的请求/响应格式与注解、任务包端口可见性、状态机和调用日志，且除了 `mcp.test.ts`（约 55 秒）其余均在 0.1–3 秒内完成。
- **留给全量的耗时/独立兄弟**：`hub/server/submit-load.test.ts`（压测 sentinel，逾百秒）、`hub/server/assemble/testing-real.test.ts`（约 58 秒）等留给全量单测。

### 4. 团队和权限（16 个单测 + 1 个验收）

- **选入项**：
  - 单测：`hub/records/teams.test.ts`、`hub/records/authorizations.test.ts`、`hub/records/standard-authorization.test.ts`、`hub/records/request-permissions.test.ts`、`hub/records/read-scope.test.ts`、`hub/server/cli-team.test.ts`、`hub/server/standard-authorization.test.ts`、`hub/server/request-permissions.test.ts`、`hub/server/console-clients.test.ts`、`hub/server/console-teams.test.ts`、`hub/server/console-team-capacity.test.ts`、`hub/server/console/audience.test.ts`、`hub/server/console/grant-dialog.test.ts`、`hub/server/console/member-reads.test.ts`、`hub/server/member-deletion-effect.test.ts`、`hub/connectors/resource-access.test.ts`
  - 验收：`tests/acceptance/06-user-without-pack.test.ts`（无包用户访问隔离与权限边界；当前第 72 行仍请求 K3 已下线的 `/console/admin/calls`，需待 Codex 迁移至 `/console/records`）
- **选择理由**：完整覆盖团队记录摘要绑定与级联失效、OAuth / RFC 8628 设备授权流程、单次请求权限快照隔离、团队与全体可见范围、CLI/控制台团队管理与配额视图、业务系统资源授权、无包用户端到端隔离以及成员删退与并发授权安全。

### 5. 密钥按名字取值（18 个测试文件）

- **选入项**：
  - Records 层：`hub/records/vault.test.ts`、`hub/records/vault-secrets.test.ts`、`hub/records/vault-sidecars.test.ts`、`hub/records/variables.test.ts`、`hub/records/variable-token-keys.test.ts`
  - Server 层：`hub/server/vault-secrets.test.ts`、`hub/server/vault-legacy-read.test.ts`、`hub/server/vault-legacy-execute.test.ts`、`hub/server/secret-use-labels.test.ts`、`hub/server/short-secret-reason.test.ts`、`hub/server/variables.test.ts`
  - Connectors / Dispatch / Knowledge 层：`hub/connectors/vault-rebind.test.ts`、`hub/connectors/variables.test.ts`、`hub/dispatch/vault-rebind.test.ts`、`hub/dispatch/variables.test.ts`、`hub/knowledge/ordinary-variable-use.test.ts`、`hub/knowledge/variables.test.ts`、`hub/knowledge/unversioned-variables.test.ts`
- **选择理由**：完整覆盖 C12「按名字引用密钥」落库、sidecar 元数据、脱敏用途标签、短口令拒绝不回显、连接器与调度层的引用重绑定、旧读写路径拒绝，以及普通变量的引用解析、单次替换与知识库无版本变量行为。18 个文件总工作线程时间也仅约 25 秒。

### 6. 脑图编译路径上的验收（14 个包内编译单测 + 7 个验收测试）

- **包内编译路径单测（14 个）**：
  - `packs/workflow/case-compile/pack.test.ts`、`packs/workflow/case-compile/publish.test.ts`、`packs/workflow/case-compile/review/end-to-end.test.ts`
  - `packs/workflow/case-compile/functions/whole-mindmap.test.ts`、`generate.test.ts`、`cases.test.ts`、`runtime-contract.test.ts`、`fidelity.test.ts`、`recomposition.test.ts`、`recompose-check.test.ts`、`block-workbook.test.ts`、`binding.test.ts`
  - `packs/workflow/case-compile/recompose/tools/submit-records.test.ts`、`packs/workflow/case-compile/tools/seal-recompose.test.ts`
- **快速验收路径（7 个；另有 `tests/acceptance/06-user-without-pack.test.ts` 归于「团队和权限」验收）**：
  - `tests/acceptance/38-r5-t4-1-block-cases.test.ts`（块用例生成与校验）
  - `tests/acceptance/56-fed-case-reprojection.test.ts`（投喂用例重投影不变性）
  - `tests/acceptance/39-r5-t9-2-skill-packs.test.ts`（技能包发布、格式与调用前就绪性）
  - `tests/acceptance/32-r5-dispatch-rules.test.ts`（运行调度规则与包资格）
  - `tests/acceptance/40-r5-t9-3-process-restart.test.ts`（进程重启与持久状态恢复）
  - `tests/acceptance/53-capacity.test.ts`（容量上限与拒绝边界）
  - `tests/acceptance/coverage-paths.test.ts`（验收覆盖路径完整性检查）
- **选择理由**：既验证 `case-compile` 从全脑图、块工作簿、绑定/生成/保真检查、重组封板、评审端到端到 `publish` 沙箱加载的编译核心路径，又在 `tests/acceptance/` 中以约 13 秒跑完块用例、重投影、技能包、调度规则、重启恢复、容量和覆盖路径验收。
- **留给全量的长耗时/条件测试**：`packs/workflow/case-compile/production.test.ts`（约 94 秒）、`packs/workflow/case-review-verify/end-to-end.test.ts`（逾 120–200 秒）、`tests/acceptance/26-review-report.test.ts` / `28-device-run.test.ts` / `41-r5-t1t3-acceptance.test.ts` 等均保留在完整回归中。

---

## 在基线 `cbb19119a1` 上的恢复与保留排除说明

上游在 `6de55e070e`（修复 `authorizations.ts` 的 `packsFor('*')`）与 `770e07ccbf`（修复 `console-teams.test.ts` 中的非 ULID 团队编号 `TEAM_A.id`）合入 `hub-final cbb19119a1` 后，本分支已恢复以下 4 项此前受阻断的测试：

1. `hub/server/console-teams.test.ts`（已恢复至「团队和权限」单测）
2. `hub/runs/packs/ports.test.ts`（已恢复至「六个工具」单测）
3. `tests/acceptance/06-user-without-pack.test.ts`（已恢复至「团队和权限」验收；另查见其第 72 行仍请求 K3 已下线的 `/console/admin/calls`，需待 Codex 同步迁移至 `/console/records`）
4. `packs/workflow/case-compile/review/end-to-end.test.ts`（已恢复至「脑图编译路径上的验收」包内单测）

以下 2 项验收测试在本分支（`wp/agy/team-delete`）**继续保持排除**，待并行 Item 2（`/console/api` 页面与表单迁移）合入后再由协调者恢复并记录整合后的全量快速回归实测耗时：

- `tests/acceptance/46-knowledge-spaces.test.ts`
- `tests/acceptance/54-member-deletion.test.ts`

---

## 实测耗时与结果（macOS，历史基线 `6667281163`；恢复前快照）

以下数据为恢复上述 4 项之前在 `6667281163` 上执行 `npm run test:quick` 的实测快照，合入上述恢复项及 Item 2 后由协调者顺序复测 PostgreSQL 与 `tsc` 并更新最终总耗时：

- **总计墙钟耗时：`89.98s`**（约 1.5 分钟，远低于 300s / 5 分钟上限；共 3 项校验命令 + 66 个单测文件 `643` 项测试 + 7 个验收文件 `10` 项测试，全部 `0` 失败、`0` 跳过）
- **各阶段实测分项**：
  - `[1/4] 合约生成物一致性校验`：`0.21s`（`exit=0`，`contracts/generated matches the model (206 files)`）
  - `[2/4] TypeScript 类型检查（主仓库 + .github/checks）`：`14.38s`（`exit=0`）
  - `共享 PostgreSQL 模板准备`：`0.66s`
  - `[3/4] 快速单元测试（66 文件，concurrency=6）`：`62.39s`（`exit=0`，`643 passed / 0 failed / 0 skipped / 22 suites`）
  - `[4/4] 快速验收测试（7 文件，concurrency=1）`：`12.34s`（`exit=0`，`10 passed / 0 failed / 0 skipped / 1 suite`）
