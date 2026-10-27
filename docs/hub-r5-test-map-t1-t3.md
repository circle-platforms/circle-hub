# Hub R5 测试覆盖表：T1–T3（知识、平台事实、构建差异）

依据：`docs/hub-r5-brief.md`、`docs/hub-r5-tests.md`。

## 场景覆盖矩阵

| 场景编号 | 现有覆盖（文件:测试名） | 缺口（预期或反例里哪几条还没有被机械断言） | 依赖 |
| --- | --- | --- | --- |
| **T1-1 知识问答** | `tests/acceptance/33-r5-t1t3-knowledge-qa.test.ts`: `reads command nodes via get_nodes and resolves verbatim citations in standalone root mode without a run`<br>`tests/acceptance/41-r5-t1t3-acceptance.test.ts`: `resolves citations against root alone and refuses tampered and alien root citations`<br>`hub/server/mcp.test.ts`: `resolve_reference delegates to the runs service; a bad argument is refused with the empty shape`<br>`hub/runs/engine/queries.test.ts`: `resolve_reference previews quotations, commands and references against the run; it writes nothing` | 声明级教训的出处等级检索与矛盾标记条目限定（依赖 B3）。单根模式（A6）、改字解析失败（unresolved）、跨版本线根拒绝、参数校验等断言已由 33 与 41 号验收用例覆盖。 | B3（声明级教训与操作记录沉淀检索） |
| **T1-2 测试脑图评审全链** | `tests/acceptance/41-r5-t1t3-acceptance.test.ts`: `T1-2 测试脑图评审全链合成版`（含 step 1 定位、step 2 初评、step 3 同族复核记 independence_unknown 且终稿拒绝 block_unsettled、step 4 换家族后独立复核满足且终稿放行、反例 1 命令不存在反驳、反例 2 PASS 携被推翻发现拒绝、反例 3 终稿多重结论拒绝）<br>`tests/acceptance/26-review-report.test.ts`: `scenario 26: the review report over blocks (steps 6 and 7 of the method)`<br>`tests/acceptance/01-normal-review.test.ts`: `scenario 1: a normal review`<br>`tests/acceptance/03-command-membership-contradicted.test.ts`: `claiming a command is absent when the catalog has it is a violation routed into repair, not a whole rejection`<br>`packs/workflow/case-review-verify/end-to-end.test.ts`: `the draft review (case-review) and its independent verification (case-review-verify)` | 发现严重度与 P 等级细粒度区间映射（A4 内部细节）；合成层端到端正向全链与核心阻断反例已全部由 41 号验收用例覆盖。 | 无（合成链已通）；A4（细粒度区间） |
| **T1-3 按模板 v3 查缺** | `packs/workflow/template-gap/engine.test.ts`: `one item per document; start_run computes and stores the result; every gap is exactly the removed category, of any group`<br>`packs/workflow/template-gap/engine.test.ts`: `keeps the refutation as violation and leaves attribution unattributed under * -> unknown`<br>`packs/workflow/template-gap/functions/tags-exact.test.ts`: `tag definitions match closed set` | 缺输入时写补齐动作、对象与期限在端到端接口层面的断言。 | 无 |
| **T2-1 用例定位** | `tests/acceptance/34-r5-t1t3-platform-facts.test.ts`: `locates mind map document into product line, version, train, module, and build candidates`<br>`tests/acceptance/41-r5-t1t3-acceptance.test.ts`: `step 1: case-location locates mind map into product line, train, module and build candidates`<br>`packs/workflow/case-location/production.test.ts`: `computes and stores the location of every document at start_run, each answer a fact claim or an unknown` | 目录语法认不出报 `unknown` 并给出具名出口在端到端层面的机械断言。 | 无 |
| **T2-2 按编号读原件 (source-read)** | `tests/acceptance/41-r5-t1t3-acceptance.test.ts`: `T2-2 按编号读原件 (source-read) 全部反例`（编号不存在 SOURCE_ABSENT/SOURCE_UNAVAILABLE、未声明路由 SUBMISSION_SCHEMA_VIOLATION、空输入 source-read.no_source、语法错误 SUBMISSION_SCHEMA_VIOLATION、来源不可达 SOURCE_RETRYABLE 带下一步修正出口且无主机泄露）<br>`tests/acceptance/34-r5-t1t3-platform-facts.test.ts`: 读各类系统路由原件、检验原件引用<br>`tests/acceptance/36-source-unreachable-exit.test.ts`: 来源不可达带下一步出口且无主机泄露<br>`packs/workflow/source-read/read.test.ts`: 7 类系统路由原件读取与反例 | 基础读取与全部反例已由 34、36、41 号用例机械断言覆盖。 | 无 |
| **T2-3 缺陷转用例** | `tests/acceptance/41-r5-t1t3-acceptance.test.ts` & `tests/acceptance/34-r5-t1t3-platform-facts.test.ts`: 缺陷修复说明缺失报 `defect-to-case.missing_fix_field` 并给出澄清请求<br>`packs/workflow/defect-to-case/end-to-end.test.ts`: 修复说明改写被反驳、重复用例判出 | 修复说明缺失是投影错误/澄清请求，非未知（已在发现问题 5 记录）。 | 无 |
| **T2-4 追溯矩阵** | `tests/acceptance/41-r5-t1t3-acceptance.test.ts` & `tests/acceptance/34-r5-t1t3-platform-facts.test.ts`: 缺陷索引无编号报 `SUBMISSION_SCHEMA_VIOLATION`<br>`packs/workflow/traceability/production.test.ts`: `computes and stores the traceability matrix of a build` | 现有索引视图覆盖率已验证。 | 无 |
| **T2-5 需求追溯矩阵** | `tests/acceptance/41-r5-t1t3-acceptance.test.ts` & `tests/acceptance/34-r5-t1t3-platform-facts.test.ts`: 无法确定的需求编号单条独立拒绝 `story-traceability.invalid_input` 并给出具名移除修正说明<br>`packs/workflow/story-traceability/production.test.ts`: `computes and stores the traceability matrix of stories` | 无 | 无 |
| **T2-6 质量看板** | `tests/acceptance/41-r5-t1t3-acceptance.test.ts` & `tests/acceptance/34-r5-t1t3-platform-facts.test.ts`: 无用例条目时退出码 1 报 `quality-board.no_cases`<br>`packs/workflow/quality-board/production.test.ts`: `computes and stores the board at start_run: metrics as fact claims, threshold violations advisory, never blocking` | 阈值越界记提示档不阻断状态仍为 delivered 已由包生产测试与 41 号端到端用例覆盖。 | 无 |
| **T3-1 回归范围** | `tests/acceptance/41-r5-t1t3-acceptance.test.ts`: 残缺目录在启动期被拒（缺少 `catalog=commands@1` 报 `regression-scope.catalog`，外来/未识别目录被拒）<br>`tests/acceptance/35-r5-t1t3-build-diff.test.ts`: 双构建命令定义变更用例计算、参数错误拒绝<br>`packs/workflow/regression-scope/production.test.ts`: 双构建语法级别命令差集与用例计算 | 无 | 无 |
| **T3-2 维护巡检** | `tests/acceptance/41-r5-t1t3-acceptance.test.ts`: 残缺目录在启动期被拒（缺少 `catalog=commands@1` 报 `maintenance-sweep.catalog`，外来/未识别目录被拒）<br>`tests/acceptance/35-r5-t1t3-build-diff.test.ts`: 双构建命令巡检、已删除命令阻断、定义差异提示<br>`packs/workflow/maintenance-sweep/production.test.ts`: 命令已删除记阻断、定义差异记提示并给出两侧字段值 | 无 | 无 |

### 场景依赖统计

- **无依赖（可直接补 acceptance 用例）**：9 个场景（T1-3, T2-1, T2-2, T2-3, T2-4, T2-5, T2-6, T3-1, T3-2）以及 T1-1 的只读解析部分；
- **依赖 A4**：1 个场景（T1-2 测试脑图评审全链的阻断项与封闭规程）；
- **依赖 B3**：1 个场景（T1-1 的声明级教训与操作记录沉淀检索）。

---

## 发现的问题

本节记录在梳理 T1–T3 场景断言与架构实现过程中发现的缺陷与设计缺口：

### 1. `resolve_reference` 工具参数强制要求 `run`，不支持纯知识根解析（T1-1）
- **状态**：已由 A6 解决（合入 c8d7a731，`run` 与 `root` 二选一）；下面保留发现时的记录。
- **缺的事实**：`contracts/src/tools.ts` 的 `ResolveReferenceInput`（原约 194–198 行）定义 `ResolveReferenceInput` 为 `strictObject({ run: RunId, text: string, ... })`，没有类似于 `get_nodes` 的可选 `root: Sha256` 字段。
- **影响**：`docs/hub-r5-tests.md` T1-1 规定知识问答场景“不需要任务包”，Circle 用户在纯对话会话中读取知识树节点后欲核对某条逐字引文时，因无活跃 `run` 无法直接调用 `resolve_reference`，必须额外启动一个运行（如 `source-read`）绑定根才能调用。
- **建议归属**：**A1**（核心工具契约扩展，允许 `ResolveReferenceInput` 接受可选 `root`）或 **B3**。

### 2. `get_nodes` 节点条目尚未承载出处等级与操作记录（T1-1）
- **缺的事实**：当前 `NodeEntry` 数据结构未包含 `client_captured` 等级的操作记录条目与教训（pitfall），仅有静态知识树目录。
- **影响**：T1-1 预期中“引用了声明级教训时标出出处等级”目前在 Hub 核心知识树接口中无法返回对应出处字段。
- **建议归属**：**B3**（喂入层接受操作记录对象并返回等级与出处）。

### 3. `case-review-verify` 复核严重度与 P 等级映射未完全封闭（T1-2）
- **缺的事实**：工作包 `case-review-verify` 尚未完全实现 A4 规程所要求的全部阻断项（如 PASS+partial 严格封闭、整份覆盖对账、终稿唯一结论与 gap 等级）。
- **影响**：可能存在初评与复核结论在极端边界下判定宽泛的问题。
- **建议归属**：**A4**。
