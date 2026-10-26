# Hub R5 测试覆盖表：T1–T3（知识、平台事实、构建差异）

依据：`docs/hub-r5-brief.md`、`docs/hub-r5-tests.md`。

## 场景覆盖矩阵

| 场景编号 | 现有覆盖（文件:测试名） | 缺口（预期或反例里哪几条还没有被机械断言） | 依赖 |
| --- | --- | --- | --- |
| **T1-1 知识问答** | `hub/server/mcp.test.ts`: `resolve_reference delegates to the runs service; a bad argument is refused with the empty shape`<br>`hub/runs/engine/queries.test.ts`: `resolve_reference previews quotations, commands and references against the run; it writes nothing`<br>`tests/acceptance/28-jev-skill.test.ts`: `the manual fixture command is declared by the locked build catalog` | 1. `tests/acceptance` 缺少端到端交互串接：`get_nodes` 读出真实命令/手册条目 -> 回答附引文 -> `resolve_reference` 逐条解析；<br>2. 引文改动一个字解析失败（`unresolved`）的反例；<br>3. 跨版本线引用根被拒的反例；<br>4. 声明级教训的出处等级检索与矛盾标记条目限定。 | 无（基础解析、改字失败、跨根拒绝）；<br>B3（声明级教训与操作记录沉淀检索） |
| **T1-2 测试脑图评审全链** | `tests/acceptance/01-normal-review.test.ts`: `scenario 1: a normal review`<br>`tests/acceptance/16-agile-mindmap-review.test.ts`: `scenario 16: whole review of ~150-node agile mind map with linked expected sources`<br>`packs/workflow/case-review-verify/end-to-end.test.ts`: `the draft review (case-review) and its independent verification (case-review-verify)`（含同账号同模型非独立、命令存在说不存在报反驳修复、PASS 携被推翻发现拒绝、PASS 遗漏条目拒绝、PARTIAL 判定一致性）<br>`tests/acceptance/26-review-report.test.ts`: `scenario 26: the review report over blocks (steps 6 and 7 of the method)` | 1. 发现严重度与 P 等级区间映射（A4 第 13 项）；<br>2. 复核强制前驱（A4 第 15 项）；<br>3. PASS+partial 封闭判定（A4 第 16 项）；<br>4. 整份覆盖对账（A4 第 18 项）；<br>5. 终稿唯一结论与 gap 等级（A4 第 20 项）。 | A4 |
| **T1-3 按模板 v3 查缺** | `packs/workflow/template-gap/engine.test.ts`: `one item per document; start_run computes and stores the result; every gap is exactly the removed category, of any group`<br>`packs/workflow/template-gap/engine.test.ts`: `keeps the refutation as violation and leaves attribution unattributed under * -> unknown`<br>`packs/workflow/template-gap/functions/tags-exact.test.ts`: `tag definitions match closed set` | 1. `tests/acceptance` 中无端到端集成用例（目前仅在包测试中运行）；<br>2. 缺输入时写补齐动作、对象与期限在端到端接口层面的断言。 | 无 |
| **T2-1 用例定位** | `packs/workflow/case-location/production.test.ts`: `computes and stores the location of every document at start_run, each answer a fact claim or an unknown`<br>`packs/workflow/case-location/production.test.ts`: `refutes a declaration that contradicts the tree and fills only what the tree does not give`<br>`packs/workflow/case-location/production.test.ts`: `a written build name of another line is an advisory violation naming that line, beside the candidates of the located one` | 1. `tests/acceptance` 缺少端到端 MCP 接口调用用例；<br>2. 目录语法认不出报 `unknown` 并给出具名出口在端到端层面的机械断言。 | 无 |
| **T2-2 按编号读原件 (source-read)** | `packs/workflow/source-read/read.test.ts`: `reads a defect (plm:bug) and returns the original reference and version binding`<br>`packs/workflow/source-read/read.test.ts`: `reads a story (plm:story) and returns the original reference`<br>`packs/workflow/source-read/read.test.ts`: `reads product builds (plm:builds) and returns the original reference`<br>`packs/workflow/source-read/read.test.ts`: `reads a mindmap (agile:mindmap) and returns the original reference`<br>`packs/workflow/source-read/read.test.ts`: `reads a build site page (buildsite:listing) and returns the original reference`<br>`packs/workflow/source-read/read.test.ts`: `reads a manual file (manual:file) and returns the original reference`<br>`packs/workflow/source-read/read.test.ts`: `reads an SVN repository file (svn:file) and returns the original reference`<br>`packs/workflow/source-read/read.test.ts`: `supports reading multiple sources in a single run`<br>`packs/workflow/source-read/read.test.ts`: `refuses start_run when external ID is absent (SOURCE_ABSENT)`<br>`packs/workflow/source-read/read.test.ts`: `refuses start_run when route/external type is not accepted by slot (SUBMISSION_SCHEMA_VIOLATION)`<br>`packs/workflow/source-read/read.test.ts`: `refuses start_run when source origin is unreachable (SOURCE_UNAVAILABLE)`<br>`packs/workflow/source-read/read.test.ts`: `refuses start_run when inputs is empty with source-read.no_source` | 1. `tests/acceptance` 缺少 MCP 客户端视角的端到端集成用例（读回 `src:<sha256>` 原件并通过 `get_nodes` 检索内容与反例测试）。 | 无 |
| **T2-3 缺陷转用例** | `packs/workflow/defect-to-case/end-to-end.test.ts`: `runs full repair round: first rejected with fixes, second accepted, skipped defect honest`<br>`packs/workflow/defect-to-case/end-to-end.test.ts`: `blocks a paraphrased expectation and consumes a repair round when it is resubmitted`<br>`packs/workflow/defect-to-case/end-to-end.test.ts`: `rejects a valid quote from the wrong defect field and accepts the explicitly bound manual`<br>`packs/workflow/defect-to-case/samples/negative/duplicate_found.json`: `duplicate found sample`<br>`packs/workflow/defect-to-case/checks.test.ts`: `missing fix statement reports missing_input` | 1. `tests/acceptance` 缺少端到端集成用例（基于修复说明起草用例、改字被反驳、修复说明缺失记未知的机械断言）。 | 无 |
| **T2-4 追溯矩阵** | `packs/workflow/traceability/production.test.ts`: `computes and stores the traceability matrix of a build` | 1. `tests/acceptance` 缺少端到端集成用例（缺陷修复清单与索引用例对账、未索引缺陷记未知并写明缺口）。 | 无 |
| **T2-5 需求追溯矩阵** | `packs/workflow/story-traceability/production.test.ts`: `computes and stores the traceability matrix of stories` | 1. `tests/acceptance` 缺少端到端集成用例（需求编号命中用例、单条无效需求独立拒绝）。 | 无 |
| **T2-6 质量看板** | `packs/workflow/quality-board/production.test.ts`: `computes and stores the quality board at start_run` | 1. `tests/acceptance` 缺少端到端集成用例（按版本线/模块分组、阈值越界记提示不阻断状态仍为 delivered）。 | 无 |
| **T3-1 回归范围** | `packs/workflow/regression-scope/production.test.ts`: `computes and stores the regression scope of two builds` | 1. `tests/acceptance` 缺少端到端集成用例（双构建差集、命中用例非关键词结构解析）。 | 无 |
| **T3-2 维护巡检** | `packs/workflow/maintenance-sweep/production.test.ts`: `computes and stores the sweep of a build against the catalog` | 1. `tests/acceptance` 缺少端到端集成用例（已删除命令记阻断、定义差异记提示并逐字段对比两边值、部分目录标 `partial_catalog`）。 | 无 |

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
