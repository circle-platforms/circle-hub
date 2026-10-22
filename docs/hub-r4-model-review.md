# Hub r4 对照模型独立复核记录（阶段 4）

> 依据通用模型设计权威 `contracts/model.json`（73 个元素、53 个词表轴，版本 5）、架构基准 `docs/hub-r4-architecture.md` 以及进度页决定 17（`docs/hub-r4-tasks/engine-readings.md`），对 circle-hub 整体实现进行逐项独立复核。

## 1. 复核概述与统计结论

本里程碑（Milestone 1）重点交付：基于 MCP 协议对外提供只读敏捷用例评审与用例管理核心能力，包含知识树锁定、精确值引用解析、纯函数与8种表解释器沙箱执行、层终态与分区清单计算、只增记录库与调用审计日志。效果写入（Effects）、动态层执行（Dynamic Verification）、外部请求（Requests）、常设义务触发（Triggers）等明确排定在后续里程碑。

### 1.1 统计概览

| 分类指标 | 数量 | 占比 | 简述 |
| :--- | :---: | :---: | :--- |
| **模型元素总数** | **73** | 100% | 涵盖 B01-B08、A01-A06、V01-V08、W01-W10、P01-P11、I01-I03、C01-C08、T01-T04、K01-K05、D01-D07、R01-R03 |
| **里程碑 1 范围外元素** | **10** | 13.7% | 架构第 1 节明确暂不实现：B06、B07、V08、W09、P07、P09、P10、D04、D07、R03 |
| **里程碑 1 范围内元素** | **63** | 86.3% | 本里程碑应实现与落地的模型规范 |
| ├─ **落实（Fully Implemented）** | **53** | 72.6% (占范围 84.1%) | 规则完整落地于核心代码，并由自动化测试严密覆盖 |
| ├─ **部分落实（Partially Implemented）** | **7** | 9.6% (占范围 11.1%) | 核心机制已实现，非关键辅助特性（如写候选层、人工接管区间、效果前边界）受里程碑边界约束暂未开放（A05、K03、K04、C06、D03、P11、I01） |
| └─ **没落实（Not Implemented）** | **3** | 4.1% (占范围 4.8%) | 模型已定义但在当前代码中缺失（W04 判定台账、W10 判据变更声明、V07 多轮重复策略） |

## 2. 横向硬规则核对

### 2.1 核心代码无产品名、命令名、客户名
- **核对标准**：架构第 2 节要求“Product knowledge lives in packs, never in the core. The core code must not contain a product name, a command name or a customer name.”
- **复核结论**：**完全合规（0 处违规）**。
- **证据**：在 `hub/**` 生产代码中全局检索 `APV`、`NSAE`、`slb`、`proxyip`、`vlan`、客户专名等，匹配结果均为 0；早先在 `slots.ts` 中手写的具体命令提示已重构成基于 JSON Schema 指针的通用推导机制（`hub/runs/engine/slots.ts`），核心代码完全不存在业务/产品专用词素。

### 2.2 枚举只来自生成的词表
- **核对标准**：所有枚举由 `contracts/generated/vocabulary.ts` 导出，绝不手写字面量枚举数组或 `z.enum`。
- **复核结论**：**完全合规**。
- **证据**：
  1. `hub/` 生产代码中 `z.enum(` 调用次数为 **0**，全部 Schema 均直接导入自 `contracts/generated/vocabulary.ts`。
  2. 全局检查非测试文件中的 `[...] as const`，与 53 个词表轴重合的数组为 **0**。
  3. `contracts/src/` 中仅对协议基础设施（HTTP 方法 `HTTP_METHODS`、数据响应类型 `RESPONSE_KINDS`、JSON Schema 基础数据类型 `ValueType` 等非模型业务轴）定义底层 Schema，模型 53 轴无一手写枚举。

### 2.3 未知从不映射成错误
- **核对标准**：架构第 3/5 节规定“isError is true only for protocol errors and for a submission, upload or effect write that is not accepted. Unknown is never an error. A caller who may not read something, or asks for something that does not exist, gets the same neutral SOURCE_UNAVAILABLE.”
- **复核结论**：**完全合规**。
- **证据**：
  1. `hub/server/tools.ts` 中严格保持 `isError: value.call_result === "error"`，只在协议或未受理信封时置 true。
  2. 未解析的引用返回 `{ status: "unresolved" }` 答案，`isError` 为 false（`hub/server/mcp.test.ts:407`）。
  3. 含有未核对（`unchecked`）、未完成（`incomplete`）或未知条目的已受理提交，回执 `acceptance: "accepted"`，`isError` 保持 false（`hub/server/mcp.test.ts:431`）。
  4. 权限不足或对象缺失统一返回中性码 `SOURCE_UNAVAILABLE` 及同形空结构，不泄露状态差异（`hub/server/tools.ts:visibleTo`）。

### 2.4 记录只追加（Append-Only）
- **核对标准**：`records` 表记录一旦写入绝不可修改或删除；派生状态全部由纯函数实时重算；数据库迁移只增不改。
- **复核结论**：**完全合规**。
- **证据**：生产代码中对 `records` 表仅有 `INSERT` 逻辑，不存在任何 `UPDATE records` 或 `DELETE FROM records` 操作。测试代码中出现的两处 `UPDATE` 专用于测试防篡改和触发器捕获（`hub/records/store.test.ts:201`、`hub/records/roles.test.ts:86`）。

### 2.5 每个精确值都能解析到引用
- **核对标准**：提交内容中的每个精确值与期望引用必须能够反向解析到已绑定的源文件或知识树节点，引文必须逐字一致，否则拒绝受理。
- **复核结论**：**完全合规**。
- **证据**：`hub/refs/resolve.ts`、`hub/refs/exact.ts`、`hub/refs/quote.ts` 实现了完整的引用解析与逐字校验；未解析或歧义引用在提交边界直接拒绝（`hub/runs/engine/submissions.ts`）。

## 3. 已定引擎读法（进度页决定 17 与 engine-readings.md）一致性核对

经逐行比对 `hub/runs/engine/terminals.ts`、`hub/rules/check.ts`、`hub/runs/packs/validate.ts`，所有者关于引擎读法的三项决定已在代码中完整且一致地落实：

| 事项编号 | 决定原则与核心读法 | 核心代码实现位置 | 自动化测试钉住位置 | 一致性状态 |
| :--- | :--- | :--- | :--- | :---: |
| **第 5 条**<br>(主体上的修复行) | **维持引擎读法**：修复（`repair`）只用于待判定产物（`artifact_under_verification`）上的检查；评审主体（`subject`）上的反驳停在不通过，归责为 `author_input`，不进入修复，也不消耗修复轮数。 | `hub/runs/engine/terminals.ts` 中的 `rowApplies`（第 180 行）与 `staticLayer` | `hub/runs/engine/terminals.test.ts`<br>断言验证主体上的反驳不消耗轮数，归责为 `author_input` | **完全一致** |
| **第 6 条**<br>(记未知不改终态) | **动作 `unknown`（记未知）不改终态**：一条已经返回的反驳仍是“不通过”（`violation`），错误码和档位照记，归责留空为 `unattributed`（待归因，不走数据缺口），要求项状态为未满足。 | `hub/runs/engine/terminals.ts` 中的 `applyRouting` 与 `staticLayer`（第 291-294 行） | `hub/runs/engine/terminals.test.ts`<br>断言验证 `action === "unknown"` 时归责为 `unattributed`，终态保持违规 | **完全一致** |
| **第 4 条**<br>(检查必须声明档) | **检查必须声明档位**：每个检查必须显式声明 `tier`（`blocking` 或 `advisory`），发布包时强制拦截（`checks.tier_missing`）；运行时对历史旧包保留兼容缺省（有 `basis` 阻断，否则提示）。 | `hub/runs/packs/validate.ts`（第 288 行）<br>`hub/rules/check.ts` 中的 `withTier` | `hub/runs/packs/validate.test.ts:392`（钉住缺档拒绝）<br>`hub/rules/check.test.ts:262` | **完全一致** |

## 4. 全量 73 个模型元素详表

| 元素ID | 元素名称 | 英文标识 | 所属家/域 | 里程碑范围 | 落实状态 | 核心代码路径 | 测试验证文件与测试名 | 规则落实说明与缺口分析 |
| :---: | :--- | :--- | :---: | :---: | :---: | :--- | :--- | :--- |
| **B01** | 主张 | claim |  | 在范围 | **落实** | `hub/records/claims.ts, contracts/src/claim.ts` | `hub/records/claims.test.ts (claims are records)` | 5个固定字段与Toulmin结构完全落实；支持事实、判断、未知三类主张 |
| **B02** | 源文件 | source artifact |  | 在范围 | **落实** | `hub/records/artifacts.ts, contracts/src/records.ts` | `hub/records/artifacts.test.ts (source artifacts are records with content-addressed storage)` | 内容寻址存储、出处追踪、采集时刻、来源类型与读取三档完全落实；明文凭据扫描拒绝上传 |
| **B03** | 引用 | reference (URI) |  | 在范围 | **落实** | `hub/refs/reference.ts, hub/refs/resolve.ts` | `hub/refs/reference.test.ts, hub/refs/resolve.test.ts (resolving references)` | 支持 src:、tree:、rec: 引用格式，解析时严格重验摘要与权限，无外部对象特殊前缀 |
| **B04** | 许可 | authorization record |  | 在范围 | **落实** | `hub/records/authorizations.ts, contracts/src/records.ts` | `hub/records/authorizations.test.ts (authorizations record grant, assign, publish, share)` | 支持发布、分配、授权、资源配置与分享五种许可；撤回状态与版本绑定生效时校验 |
| **B05** | 动作记录 | Hub action record (operation) |  | 在范围 | **落实** | `hub/records/actions.ts, contracts/src/records.ts` | `hub/records/actions.test.ts (action records capture read, parse, generate, boundary_check)` | 记录读取、解析、生成、回读、边界校验动作；未受理提交完整记录首因并留存原样 |
| **B06** | 效果记录 | effect record |  | 不在范围 | **不在范围** | `contracts/src/records.ts (仅模式定义)` | `无 (不在范围)` | 架构第 1 节明确：效果记录（effects and leases）不在里程碑 1 范围 |
| **B07** | 请求 | request (human-in-the-loop) |  | 不在范围 | **不在范围** | `contracts/src/records.ts (仅模式定义)` | `无 (不在范围)` | 架构第 1 节明确：人工处置与请求（dispositions and requests）不在里程碑 1 范围 |
| **B08** | 调用日志 | call log (JSON Lines, W3C Trace Context) |  | 在范围 | **落实** | `hub/records/calls.ts, hub/server/logging.ts` | `hub/records/calls.test.ts (call logs record W3C trace, session, tool, args digest)` | W3C Trace Context 追踪、会话 ID、参数摘要脱敏、耗时与统一结果映射完全落实 |
| **A01** | 来源类型 | provenance type: observed / projected / declared / candidate |  | 在范围 | **落实** | `contracts/generated/vocabulary.ts, hub/records/artifacts.ts` | `hub/records/artifacts.test.ts (provenance type observed/projected/declared)` | observed、projected、declared、candidate 四类来源类型完全由引用出处推导落实 |
| **A02** | 依据等级 | basis rank (information-flow label) |  | 在范围 | **落实** | `contracts/generated/vocabulary.ts, hub/runs/engine/claims.ts` | `hub/runs/engine/submit.test.ts (basis_rank assigned by judgment/rule)` | rule_over_observation、rule_over_claims、judgment、relay 依据等级落实，支持 conditional_on_judgment 限定标记 |
| **A03** | 来源角色 | source role |  | 在范围 | **落实** | `contracts/generated/vocabulary.ts, hub/runs/engine/terminals.ts` | `hub/runs/engine/terminals.test.ts (attribution of violation by role of what check judges)` | 7类来源角色落实；BY_ROLE 严格将 subject 反驳归为 author_input，hint 不作为产品行为依据 |
| **A04** | 独立性 | independence |  | 在范围 | **落实** | `contracts/generated/vocabulary.ts, hub/runs/engine/terminals.ts` | `tests/acceptance/acceptance.test.ts (scenario 14: independent verification by different session)` | 独立性判定（human_not_author、declared_distinct_model_family、not_independent）完全落实并测试 |
| **A05** | 覆盖、边界与控制区间 | coverage, bounds and control interval |  | 在范围 | **部分落实** | `contracts/src/runs.ts, hub/knowledge/views.ts, hub/knowledge/paging.ts` | `hub/knowledge/paging.test.ts (paging cursor, complete coverage)` | 游标分页、完备性声明（complete）与采集时刻落实；人工接管控制区间因无设备执行器未实现 |
| **A06** | 未知 | unknown (in-doubt) |  | 在范围 | **落实** | `contracts/generated/vocabulary.ts, hub/runs/engine/terminals.ts, hub/server/tools.ts` | `hub/server/mcp.test.ts (unresolved is an answer, not an error; neutral SOURCE_UNAVAILABLE)` | 未知从不映射为错误，未解析引用返回 unresolved 答案，无权访问返回中性 SOURCE_UNAVAILABLE |
| **V01** | 判定 | verdict |  | 在范围 | **落实** | `contracts/generated/vocabulary.ts, hub/rules/check.ts, hub/runs/engine/terminals.ts` | `hub/rules/check.test.ts (runCheck maps check outcomes with tier and verdict)` | support、refute、unknown、none 判定值与层终态映射完全落实；检查出错记未知 |
| **V02** | 判断 | judgment |  | 在范围 | **落实** | `contracts/src/runs.ts, hub/runs/engine/terminals.ts` | `hub/runs/engine/submit.test.ts (model judgments produce terminal judgment and do not escalate to facts)` | 模型判断产生 judgment 终态，带语义未断言标记，不升级为事实，不直接参与门禁交付 |
| **V03** | 层终态 | layered terminal state |  | 在范围 | **落实** | `contracts/generated/vocabulary.ts, hub/runs/engine/terminals.ts` | `hub/runs/engine/terminals.test.ts (staticLayer computes terminal, tier, code, reason, attribution)` | 静态层终态（pass/violation/judgment/unchecked/incomplete）与满足状态推导完全落实；动态层缺省 not_run |
| **V04** | 归责 | attribution |  | 在范围 | **落实** | `contracts/generated/vocabulary.ts, hub/runs/engine/terminals.ts` | `hub/runs/engine/terminals.test.ts (attributionByReason and attributionByRole map non-pass terminals)` | 6种归责（data_gap、author_input、producer_error、transient、target_side、unattributed）规则映射完全落实 |
| **V05** | 分区清单 | partitioned manifest |  | 在范围 | **落实** | `contracts/generated/vocabulary.ts, hub/runs/engine/partitions.ts` | `hub/runs/engine/partitions.test.ts (partitionManifest groups items into delivered/rejected/quarantined/incomplete)` | 四分区（delivered/rejected/quarantined/incomplete）与跨条目主张独立收拢完全落实 |
| **V06** | 交付规则 | definition of done |  | 在范围 | **落实** | `contracts/generated/vocabulary.ts, hub/runs/engine/partitions.ts` | `hub/runs/engine/partitions.test.ts (done_rule gate requires all necessary requirements satisfied)` | 门禁型（gate）与记账型（ledger）交付规则完全落实；交付前边界取最弱判定 |
| **V07** | 重复策略 | repetition policy |  | 在范围 | **没落实** | `contracts/generated/vocabulary.ts (词表定义存在，hub/runs/engine/ 未实现)` | `无 (引擎未实现多轮重复策略)` | 多轮重复策略（k_of_n、all、first_pass）及间歇性故障聚合在运行引擎中未实现，当前仅支持单次运行 |
| **V08** | 假设集 | hypothesis set |  | 不在范围 | **不在范围** | `contracts/model.json (架构第 1 节明确暂不实现)` | `无 (不在范围)` | 架构第 1 节明确：假设集（hypothesis sets）不在里程碑 1 范围 |
| **W01** | 条目与条目投影 | item / item projection |  | 在范围 | **落实** | `contracts/src/pack.ts, hub/runs/engine/projections.ts` | `hub/runs/engine/projections.test.ts (projection turns mind map into items with stable IDs)` | 确定性投影函数将脑图投影为用例条目，条目标识稳定且模型不决定条目身份 |
| **W02** | 要求项 | requirement item (acceptance criterion) |  | 在范围 | **落实** | `contracts/src/pack.ts, hub/runs/engine/terminals.ts` | `hub/runs/packs/validate.test.ts (requirements validation checks tier, error_handling table)` | 要求项模板、检查合同绑定、错误处理表（repair/reject/request/unknown）及修复轮数完全落实 |
| **W03** | 工作流（要求项模板 + 产品绑定） | workflow = requirement template + product binding |  | 在范围 | **落实** | `contracts/src/pack.ts, hub/runs/packs/validate.ts` | `hub/runs/packs/validate.test.ts (workflow validation binds product line, version lines, checks)` | 工作流包绑定要求项模板与产品线别名定义，start_run 冻结要求项 |
| **W04** | 判定形状与判定台账 | decision shape / rulings ledger |  | 在范围 | **没落实** | `contracts/model.json (未建台账存储与运行期未裁定形状流转机制)` | `无 (核心未实现台账)` | 未建立判定台账存储与运行期未裁定形状流转机制；未在 checks 中声明的解释器在发布时直接拒绝 |
| **W05** | 中间表示与槽位 | intermediate representation / slots |  | 在范围 | **落实** | `hub/rules/sandbox/slots.ts, hub/runs/engine/slots.ts` | `hub/runs/engine/slots.test.ts (validateSlots validates against slots JSON Schema and reports errors)` | 槽位模式采用 JSON Schema 校验，通过沙箱执行并支持 Schema 自动推导结构化修复提示 |
| **W06** | 运行 | run (= 任务修订) |  | 在范围 | **落实** | `hub/runs/engine/runs.ts, hub/server/tools.ts` | `hub/server/mcp.test.ts (start_run creates run record, binds sources, freezes requirements)` | start_run 实例化 run 记录，按输入槽绑定源文件，冻结根与版本候选，幂等性校验 |
| **W07** | 提交 | submission |  | 在范围 | **落实** | `hub/runs/engine/submissions.ts, hub/server/tools.ts` | `hub/server/mcp.test.ts (submit_result accepts submission, runs boundary check, records submission)` | submit_result 受理槽位记录、处理声明（handled/skipped），未覆盖条目准确点名记未完成 |
| **W08** | 校验结果 | validation result (validation@1) |  | 在范围 | **落实** | `hub/runs/engine/partitions.ts, hub/server/tools.ts` | `hub/server/mcp.test.ts (validation result conforms to validation@1 schema)` | 生成 validation@1 校验结果记录，包含分区、终态、主张与首因回执 |
| **W09** | 触发 | trigger |  | 不在范围 | **不在范围** | `contracts/generated/vocabulary.ts (架构第 1 节明确触发与常设义务不在范围)` | `无 (不在范围)` | 架构第 1 节明确：自动化触发与常设义务（triggers and standing obligations）不在里程碑 1 范围 |
| **W10** | 判据变更声明 | criterion change declaration |  | 在范围 | **没落实** | `contracts/model.json (核心代码未实现判据变更声明模式与独立确认通道)` | `无 (核心未实现)` | 判据变更声明（W10）及其由独立第二人核对身份的通道在核心代码中未实现，目前判据调整需随包版本发布 |
| **P01** | 第 1 步 定目标 | goal setting |  | 在范围 | **落实** | `hub/server/tools.ts` | `hub/server/mcp.test.ts (start_run pins target document or defect id)` | 目标针定（target gate）：由显式输入锁定文档 ID 或缺陷 ID，缺目标拒绝受理 |
| **P02** | 第 2 步 绑定源文件 | source binding |  | 在范围 | **落实** | `hub/runs/engine/runs.ts, hub/connectors/read.ts` | `hub/server/mcp.test.ts (start_run binds command catalog and expected sources)` | 源文件按六类角色绑定，命令目录与手册通过知识树锁定并校验存在性 |
| **P03** | 第 3 步 定判定形状 | decision-shape selection |  | 在范围 | **落实** | `hub/runs/packs/validate.ts, hub/runs/engine/runs.ts` | `hub/runs/packs/validate.test.ts (checks are selected and bound from workflow template)` | 判定形状选定：由工作流模板确定检查清单与档位，并在 start_run 冻结 |
| **P04** | 第 4 步 填槽位 | slot filling |  | 在范围 | **落实** | `hub/rules/sandbox/slots.ts, hub/runs/engine/slots.ts` | `hub/runs/engine/slots.test.ts (slot filling validation and repair round decrement)` | 槽位填入校验、封闭发现码、修复轮数逐轮递减完全落实 |
| **P05** | 第 5 步 生成 | deterministic generation |  | 在范围 | **落实** | `hub/knowledge/produce.ts, hub/rules/sandbox/` | `hub/knowledge/produce.test.ts (deterministic generator produces entries from source bytes)` | 确定性生成：内容寻址生成，失败记 output_failed 并归责为 producer_error |
| **P06** | 第 6 步 静态判定 | static verification |  | 在范围 | **落实** | `hub/rules/check.ts, hub/runs/engine/terminals.ts` | `hub/rules/check.test.ts (runCheck executes pack check in sandbox or interpreter)` | 静态层判定：沙箱隔离执行纯函数检查及8类核心表解释器，输出结果结构化 |
| **P07** | 第 7 步 动态判定 | dynamic verification |  | 不在范围 | **不在范围** | `hub/runs/engine/terminals.ts (动态层显示 not_run, no_check)` | `hub/runs/engine/terminals.test.ts (dynamicLayer defaults to not_run)` | 架构第 1 节明确：动态层判定（dynamic verification）不在里程碑 1 范围，统一显示 not_run |
| **P08** | 第 8 步 分区交付 | partitioned delivery |  | 在范围 | **落实** | `hub/runs/engine/partitions.ts` | `hub/runs/engine/partitions.test.ts (partitionManifest computes partitions for receipt delivery)` | 四分区清单计算与回执输出完全落实 |
| **P09** | 第 9 步 反例回流 | counterexample feedback |  | 不在范围 | **不在范围** | `contracts/model.json` | `无 (不在范围)` | 架构第 1 节明确：运行时自动化反例回流闭环不在里程碑 1 范围 |
| **P10** | 第 10 步 沉淀 | consolidation |  | 不在范围 | **不在范围** | `contracts/model.json` | `无 (不在范围)` | 架构第 1 节明确：运行结论自动化沉淀入知识库不在里程碑 1 范围 |
| **P11** | 统一管道与两道强制边界 | unified pipeline, pre-effect and pre-delivery boundaries |  | 在范围 | **部分落实** | `hub/runs/engine/terminals.ts, hub/runs/engine/partitions.ts` | `hub/runs/engine/partitions.test.ts (交付前边界落实；效果前边界因效果不在范围未落实)` | 交付前边界完全落实；效果前边界（租约、围栏、允许效果表）因写效果不在范围未落实 |
| **I01** | 不变量一：精确值与产物 | exact values and artifacts |  | 在范围 | **部分落实** | `hub/refs/exact.ts, hub/refs/quote.ts` | `hub/refs/quote.test.ts (引文逐字与数字回溯落实；补丁与判据变更未落实)` | 精确值与引文逐字回溯解析落实；直接编写补丁执行校验与判据变更（W10）未实现 |
| **I02** | 不变量二：事实的来源 | source of facts |  | 在范围 | **落实** | `hub/rules/interpreters/catalog.ts, hub/runs/engine/terminals.ts` | `tests/acceptance/acceptance.test.ts (scenario 16: facts come only from product docs, not hint)` | 事实只能来自规格、手册与目录，hint 来源不能支撑产品事实主张 |
| **I03** | 不变量三：终态不升级 | no escalation of terminal state |  | 在范围 | **落实** | `hub/runs/engine/terminals.ts` | `hub/runs/engine/terminals.test.ts (terminal states do not escalate without independent evidence)` | 终态不升级原则完全落实，非通过终态无新独立根据绝不提升 |
| **C01** | 四个家 | four homes = objects B/C/E/D |  | 在范围 | **落实** | `contracts/src/pack.ts, hub/rules/, hub/records/` | `hub/runs/packs/validate.test.ts (four homes B/C/D/E reflected in architecture)` | 四个家（证据 B、政策 C、执行 D、专业规程 E）正交分工在架构与包规范中完全落实 |
| **C02** | 四类归属 | ownership classes |  | 在范围 | **落实** | `contracts/src/pack.ts, hub/runs/packs/validate.ts` | `hub/runs/packs/validate.test.ts (pack kinds: product, workflow, system, core)` | 产品包、工作流包、系统包、Hub 核心四类归属划分明确 |
| **C03** | 两种形态与两种可执行插件 | table-driven interpreter / framework + plugin; deterministic function / sans-IO adapter |  | 在范围 | **落实** | `hub/rules/sandbox/, hub/connectors/transport.ts` | `hub/rules/sandbox.test.ts (sandbox executes deterministic functions with denied network)` | Node 权限模型 + macOS sandbox-exec (deny network) 禁网沙箱及无 I/O 适配器完全落实 |
| **C04** | 表 | table (fact table / decision table) |  | 在范围 | **落实** | `contracts/src/tables.ts, hub/rules/table.ts` | `hub/rules/table.test.ts (eight table semantics implemented and tested)` | 八种表语义（成员、映射、模式、范围、目录、结构、覆盖、逐字）与封闭 Schema 模式完全落实 |
| **C05** | 规则 | rule |  | 在范围 | **落实** | `hub/rules/check.ts, hub/runs/packs/samples.ts` | `hub/runs/packs/samples.test.ts (checks require positive/negative samples and tier)` | 检查必须带正反例，blocking 与 advisory 分档，发布时严格准入 |
| **C06** | 政策表 | policy table |  | 在范围 | **部分落实** | `hub/runs/packs/validate.ts, hub/rules/table.ts` | `hub/runs/packs/validate.test.ts (包内政策表与发布校验落实；全局效果边界政策表因效果不在范围未落实)` | 包内政策表（policies/）与发布时样例校验完全落实；全局效果边界政策表因写效果不在范围未落实 |
| **C07** | 目录 | catalog (closed world) |  | 在范围 | **落实** | `hub/rules/interpreters/catalog.ts` | `hub/rules/interpreters/catalog.test.ts (closed-world catalog matching against command tree)` | 目录封闭集核对（catalog@1）、最长前缀匹配与未识别命令隔离完全落实 |
| **C08** | 能力声明（组件登记表） | capability declaration / component registry |  | 在范围 | **落实** | `contracts/src/pack.ts, hub/runs/packs/validate.ts` | `hub/runs/packs/validate.test.ts (component capability declarations in manifest and checks)` | 能力声明（输入输出种类、代码范围、生产者类型、错误处理表）在包清单与检查中落实 |
| **T01** | 任务包 | task pack |  | 在范围 | **落实** | `contracts/src/pack.ts, hub/runs/packs/load.ts` | `hub/runs/packs/validate.test.ts (task pack loading and file structure validation)` | 任务包文件结构、清单摘要计算、规程纯文本下发完全落实 |
| **T02** | 发布记录与发布校验 | publish record / publish check |  | 在范围 | **落实** | `hub/runs/packs/publish.ts, hub/runs/packs/validate.ts` | `hub/runs/packs/validate.test.ts (pack publish runs samples and enforces tier)` | 包发布时自动运行全部正反例，仅作者样例提示警告，下架状态撤回校验完全落实 |
| **T03** | 边界校验 | boundary validation |  | 在范围 | **落实** | `hub/runs/engine/submissions.ts, hub/server/tools.ts` | `hub/server/mcp.test.ts (boundary validation on submission receipt)` | 边界校验重验原始字节，引文不符或精确值未解析直接拒绝受理，反驳归责按角色分流 |
| **T04** | 引用解析（解析而非限制） | resolve, don't restrict |  | 在范围 | **落实** | `hub/refs/reference.ts, hub/refs/resolve.ts` | `hub/refs/resolve.test.ts (resolve_reference resolves quotations and exact values)` | 引用解析先行，解析状态（resolved/ambiguous/unresolved）如实报告，解析不出即整份不受理 |
| **K01** | 知识树 | knowledge tree (content-addressed) |  | 在范围 | **落实** | `hub/knowledge/tree.ts, hub/knowledge/roots.ts` | `hub/knowledge/tree.test.ts (content-addressed tree nodes and root pointers)` | 内容寻址 Merkle 知识树、未变子树复用、版本差计算、构建别名映射（NSAE/APV）及当前根指针移动完全落实 |
| **K02** | 知识条目 | knowledge entry |  | 在范围 | **落实** | `hub/knowledge/entries.ts, hub/knowledge/produce.ts` | `hub/knowledge/produce.test.ts (knowledge entry extraction from source artifacts)` | 知识条目提取、源片段引用、适用条件抽取及入树前校验完全落实 |
| **K03** | 三层写入 | three writer layers |  | 在范围 | **部分落实** | `hub/knowledge/tree.ts, hub/knowledge/views.ts` | `hub/knowledge/views.test.ts (树本身与观察层落实；写个人候选层架构第 1 节明确不在范围)` | 树本身与产品观察层完全落实；个人候选层写入因架构第 1 节排除在里程碑 1 之外未实现 |
| **K04** | 知识归类 | placement proposed by the bot (Jev), verified by the Hub |  | 在范围 | **部分落实** | `hub/knowledge/placement.ts` | `tests/acceptance/acceptance.test.ts (scenario 11: 确定性归位与未归位存根落实；模型归位通道按 10-22 决定未开通)` | 确定性规则归位与未归位留在根下存根完全落实；bot/模型智能归位提议按 10-22 所有者决定未开通 |
| **K05** | 本地缓存与获取 | pinned fetch and content-hash cache |  | 在范围 | **落实** | `hub/knowledge/paging.ts, hub/knowledge/views.ts` | `hub/knowledge/paging.test.ts (cursor-based pagination and content-hash caching)` | 按路径路由精准检索、内容哈希缓存、游标增量分页完全落实 |
| **D01** | 对接规范 | integration specification |  | 在范围 | **落实** | `hub/connectors/transport.ts, hub/connectors/read.ts` | `hub/connectors/transport.test.ts (route allow-list enforces method and path template)` | 路由白名单强制（方法与路径模板逐条放行）、只读连接、凭据登录过期仅尝试一次完全落实 |
| **D02** | 前提表 | target premises |  | 在范围 | **落实** | `contracts/src/resources.ts, hub/connectors/transport.ts` | `hub/connectors/transport.test.ts (premise declarations default to false)` | 前提表（PremiseDeclaration）声明，所有系统前提默认置假，无证据按最弱处理 |
| **D03** | 效果类与写声明 | effect class / write declaration |  | 在范围 | **部分落实** | `contracts/src/tools.ts, hub/connectors/read.ts` | `hub/server/mcp.test.ts (读声明与 MCP 注解推算落实；写声明与写结局因写效果不在范围未落实)` | 读声明与 MCP 注解（readOnlyHint/openWorldHint）自动推算完全落实；写声明与写重试安全类未落实 |
| **D04** | 效果安全机制 | lease, fencing, at-most-once, freeze, disposition, reconciliation |  | 不在范围 | **不在范围** | `contracts/generated/vocabulary.ts (架构第 1 节明确效果与租约不在范围)` | `无 (不在范围)` | 架构第 1 节明确：效果安全机制（lease, fencing, at-most-once）不在里程碑 1 范围 |
| **D05** | 调用合约与统一响应 | call contract / uniform response |  | 在范围 | **落实** | `hub/server/tools.ts, hub/server/mcp.ts` | `hub/server/mcp.test.ts (MCP uniform response, isError, idempotency, neutral error)` | MCP 标准协议、content + structuredContent、isError 矩阵、封闭错误码表、SOURCE_UNAVAILABLE 及幂等性完全落实 |
| **D06** | MCP 工具面 | MCP server tool surface |  | 在范围 | **落实** | `hub/server/tools.ts` | `hub/server/mcp.test.ts (exactly six MCP tools published with schema and annotations)` | 对外精确发布 6 个 MCP 工具（list_task_packs, upload_file, start_run, get_nodes, resolve_reference, submit_result） |
| **D07** | 执行器资源 | executor resource |  | 不在范围 | **不在范围** | `contracts/model.json (架构第 1 节明确浏览器/设备执行器不在范围)` | `无 (不在范围)` | 架构第 1 节明确：浏览器与设备执行器资源（executor resource）不在里程碑 1 范围 |
| **R01** | 权限角色 | permission role: user / admin |  | 在范围 | **落实** | `hub/records/auth.ts, hub/records/authorizations.ts` | `hub/records/auth.test.ts, hub/server/mcp.test.ts (user/admin roles and token auth)` | user 与 admin 双角色划分，包使用权与发布权隔离，令牌哈希存储完全落实 |
| **R02** | 可见性 | visibility |  | 在范围 | **落实** | `hub/records/authorizations.ts, hub/server/tools.ts` | `hub/server/mcp.test.ts (visibility filtering and neutral SOURCE_UNAVAILABLE)` | 基于作者、包分配及分享许可的可见性过滤，无权与不存在同形返回 SOURCE_UNAVAILABLE 完全落实 |
| **R03** | bot（服务端 Circle） | server-side agent runtime |  | 不在范围 | **不在范围** | `contracts/model.json (架构第 1 节明确 bot 不在范围)` | `无 (不在范围)` | 架构第 1 节明确：服务端 bot 运行时（server-side agent runtime）不在里程碑 1 范围 |

## 5. 最重要的五条偏离（需所有者知晓）

在 63 个本里程碑应覆盖的模型元素中，发现了以下 5 条最关键的架构偏离，均属于设计模型中有明确规定但在当前代码库中未完全实现或机制闲置的情况：

1. **W10 判据变更声明在核心中未实现（未落实）**
   - **模型定义**：当用例期望或验收标准需要修改时，必须走 `W10` 判据变更声明，显式引用支持新期望的期望来源片段，且必须经由独立的第二人（另一 Hub 账号的人）核对确认，在声明被接受前原判据判为不通过。
   - **实现现状**：当前核心代码库中没有任何处理判据变更声明的数据模式、校验逻辑或提交分支（全局搜 `W10` / `判据变更` 仅出现在 `contracts/model.json` 文档中）。当前若判据变更，只能通过任务包所有者重新发布任务包新版本来全局覆盖，缺少运行级判据变更与受管确认通道。

2. **V07 重复策略（k-of-n / all / first_pass）未进入运行引擎（未落实）**
   - **模型定义**：对于存在波动或间歇性故障的观察，V07 规划了 `all`（全部）、`k_of_n`（阈值通过）、`first_pass`（首次通过）三种聚合策略，要求多次运行并展示观测分布（如 `3/3 未见失败`），混合结果记未知（间歇）。
   - **实现现状**：词表生成了 `Aggregation` 轴，但运行引擎 `hub/runs/engine/terminals.ts` 仅按单次提交和修复轮数计算终态，未实现多轮重复执行结果的统计聚合器。

3. **W04 判定台账与运行期未裁定形状流转机制缺失（未落实）**
   - **模型定义**：运行中遇到台账外的判定形状不挂起，相关要求项记为“判断（判定形状未裁定）”，并在下一版由任务包作者裁定进台账。
   - **实现现状**：Hub 核心并未建立“判定台账”的实体存储；若任务包使用了未安装的解释器，在包发布校验阶段即直接阻断拦截（`checks.interpreter_missing`），无法在运行中作为“未裁定形状”捕获与流转。

4. **K03/K04 个人候选层写入与模型智能归位通道未开通（部分落实）**
   - **模型定义**：K03 规定“树本身、观察层、个人候选层”三层写入；K04 规定没有显式路径的片段可由 bot 提议归位并经 Hub 确定性核验。
   - **实现现状**：由于所有者 2026-10-22 明确决定“Hub 不调用判断模型”，当前代码严格落实了确定性规则归类和未归位存根，但个人候选层写入（写入候选在架构第 1 节明确排除）和 bot 归位提议通道未开通，无法由模型自主丰富候选知识。

5. **D03/P11 效果前强制边界（租约、围栏、参数范围）未激活（部分落实）**
   - **模型定义**：P11 规定统一管道包含两道强制边界：效果前边界（校验动作在允许表内、参数范围、租约围栏有效、全局政策表放行）与交付前边界（终态与分区清单计算）。
   - **实现现状**：因为里程碑 1 明确排除外部系统写效果（B06、B07、D04 等不在范围），目前运行中仅交付前边界完全激活，效果前边界及全局边界政策表在当前代码中处于闲置/未装配状态。

## 6. 不确定的地方（疑问清单，不作猜测）

复核过程中识别出以下 5 点需要所有者或架构师进一步确认的设计疑问：

1. **无发布记录规格类文档的基线确定（模型 pendingDecisions 项 6 / A03 R[1]）**：当跨运行充当规格类来源的文档本身没有产品发布记录或设备回显时，当前实现默认回退到运行锁定的构建根。未来是否需要要求管理员对这些规格文档下发显式的基线授权记录（B04）？
2. **条目合取投影次序（模型 pendingDecisions 项 19 / V03 R[3]）**：当前代码实现的条目级合取投影次序为 `不通过 > 未完成 > 未核对 > 判断 > 通过`。在动态层缺省为“不适用”或“未运行”时，该次序是否确认为最终标准？
3. **判据变更声明（W10）的落地计划**：下一个里程碑（如自动化测试执行或用例维护）是否需要引入 W10 判据变更声明机制，还是继续保持“判据修改必须通过任务包发布新版本”的刚性约束？
4. **个人候选层对管理员的展示精度（模型 pendingDecisions 项 12 / R02）**：未来开放个人候选层写入后，管理员运行记录中是否严格限制为仅显示“候选写入条数与摘要”，而对正文保持完全不可见？
5. **全局边界政策表的部署形态（模型 pendingDecisions 项 10 / C06）**：后续里程碑引入写效果与安全机制时，全局边界政策表是随 Hub 核心发布（硬编码/内置代码包），还是作为管理员在数据库中配置的资源数据？
