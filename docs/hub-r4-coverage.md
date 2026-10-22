# Hub r4 模型覆盖审计报告 (Coverage Audit)

本文档是对 Circle Hub r4 通用因果模型（`contracts/model.json`，共 73 个模型元素）在第一个里程碑（Milestone 1）中的实现状态与端到端测试覆盖情况的逐项审计报告。

审计原则：
1. **实事求是**：区分已实现（`implemented`）、仅合约定义（`contract only`）与本期范围外（`out of scope`）。
2. **怀疑论态度**：逐条核对代码与测试，不把“存在类型定义”当成“功能已交付”；凡未经真实端到端断言证明的行为，如实标明**“没能验证”**。
3. **真实效果证明**：测试必须断言真实效果（数据库持久化记录、返回结构、调用日志行、磁盘对象、控制台渲染页面），拒绝仅复读实现的浅层断言。

---

## 1. 覆盖审计汇总表 (64+9 = 73 元素)

| 编号 | 分组 | 元素名称 | 英文名称 | M1 状态 | 核心实现路径 | 端到端覆盖场景 |
|---|---|---|---|---|---|---|
| **B01** | 基本记录 | 主张 | claim | `implemented` | `hub/records/claims.ts`, `hub/runs/evaluator.ts` | 场景 01, 05, 10, 20, 21, 22 |
| **B02** | 基本记录 | 源文件 | source artifact | `implemented` | `hub/records/artifacts.ts`, `hub/connectors/` | 场景 01, 08, 09, 14, 16, 20 |
| **B03** | 基本记录 | 引用 | reference (URI) | `implemented` | `hub/refs/`, `hub/knowledge/tree.ts` | 场景 01, 02, 10, 14, 16, 21 |
| **B04** | 基本记录 | 许可 | authorization record | `implemented` | `hub/records/authz.ts`, `hub/server/app.ts` | 场景 01, 06, 08, 12, 17 |
| **B05** | 基本记录 | 动作记录 | Hub action record | `implemented` | `hub/records/actions.ts`, `hub/server/mcp.ts` | 场景 01, 07, 13, 17, 19 |
| **B06** | 基本记录 | 效果记录 | effect record | `contract only` | `contracts/model.json`, `hub/records/effects.ts` | M1 无写操作，未执行写入效果 |
| **B07** | 基本记录 | 请求 | request (human-in-the-loop) | `contract only` | `contracts/model.json`, `hub/records/requests.ts` | M1 处置与请求暂缓 |
| **B08** | 基本记录 | 调用日志 | call log (JSON Lines, W3C) | `implemented` | `hub/records/call-log.ts`, `hub/server/app.ts` | 场景 01, 07, 12, 17, 20, 22 |
| **A01** | 主张属性 | 来源类型 | provenance type | `implemented` | `hub/records/claims.ts`, `hub/runs/evaluator.ts` | 场景 01, 05, 20, 22 |
| **A02** | 主张属性 | 依据等级 | basis rank | `implemented` | `hub/runs/evaluator.ts`, `contracts/model.json` | 场景 01, 04, 20, 22 |
| **A03** | 主张属性 | 来源角色 | source role | `implemented` | `hub/records/artifacts.ts`, `hub/runs/` | 场景 01, 08, 16, 22 |
| **A04** | 主张属性 | 独立性 | independence | `implemented` | `hub/runs/runs.ts`, `hub/runs/evaluator.ts` | 场景 01, 22 |
| **A05** | 主张属性 | 覆盖与控制区间 | coverage & bounds | `implemented` | `hub/runs/evaluator.ts`, `hub/runs/runs.ts` | 场景 01, 04, 20 |
| **A06** | 主张属性 | 未知 | unknown (in-doubt) | `implemented` | `hub/runs/evaluator.ts`, `hub/knowledge/jev.ts` | 场景 01, 11, 20, 21 |
| **V01** | 判定与终态 | 判定 | verdict | `implemented` | `hub/runs/evaluator.ts`, `hub/rules/evaluator.ts`| 场景 01, 04, 16, 20, 21, 22 |
| **V02** | 判定与终态 | 判断 | judgment | `implemented` | `hub/runs/evaluator.ts`, `hub/server/mcp.ts` | 场景 01, 02, 05, 21, 22 |
| **V03** | 判定与终态 | 层终态 | layered terminal state | `implemented` | `hub/runs/evaluator.ts`, `contracts/receipt.json` | 场景 01, 04, 18, 20, 22 |
| **V04** | 判定与终态 | 归责 | attribution | `implemented` | `hub/runs/evaluator.ts`, `hub/rules/` | 场景 01, 02, 20, 21 |
| **V05** | 判定与终态 | 分区清单 | partitioned manifest | `implemented` | `hub/runs/evaluator.ts`, `contracts/receipt.json` | 场景 01, 05, 10, 16, 20 |
| **V06** | 判定与终态 | 交付规则 | definition of done | `implemented` | `hub/runs/runs.ts`, `hub/runs/evaluator.ts` | 场景 01, 16, 20 |
| **V07** | 判定与终态 | 重复策略 | repetition policy | `implemented` | `hub/runs/runs.ts`, `hub/runs/evaluator.ts` | 场景 02, 03, 21 |
| **V08** | 判定与终态 | 假设集 | hypothesis set | `contract only` | `contracts/model.json` | M1 范围外暂缓 |
| **W01** | 工作结构 | 条目与投影 | item / item projection | `implemented` | `hub/runs/runs.ts`, `packs/workflow/` | 场景 01, 10, 16, 20 |
| **W02** | 工作结构 | 要求项 | requirement item | `implemented` | `packs/workflow/case-review/` | 场景 01, 08, 16, 20 |
| **W03** | 工作结构 | 工作流与绑定 | workflow / product binding | `implemented` | `hub/pack/`, `packs/workflow/` | 场景 01, 08, 15, 16 |
| **W04** | 工作结构 | 判定形状与台账 | decision shape / ledger | `implemented` | `hub/runs/evaluator.ts`, `packs/workflow/` | 场景 01, 06, 21 |
| **W05** | 工作结构 | 中间表示与槽位 | IR / slots | `implemented` | `hub/rules/runner.ts`, `packs/workflow/` | 场景 01, 16, 20 |
| **W06** | 工作结构 | 运行 | run (= 任务修订) | `implemented` | `hub/records/runs.ts`, `hub/runs/runs.ts` | 场景 01, 13, 17, 19 |
| **W07** | 工作结构 | 提交 | submission | `implemented` | `hub/server/mcp.ts`, `hub/runs/runs.ts` | 场景 01, 02, 13, 19, 21, 22 |
| **W08** | 工作结构 | 校验结果 | validation result | `implemented` | `hub/runs/evaluator.ts`, `contracts/validation.json` | 场景 01, 02, 18, 20, 21 |
| **W09** | 工作结构 | 触发 | trigger | `contract only` | `contracts/model.json` (MCP 手动触发已实现) | 定时/常设义务触发暂缓 |
| **W10** | 工作结构 | 判据变更声明 | criterion change | `contract only` | `contracts/model.json` | M1 暂缓 |
| **P01** | 管道节点 | 第 1 步 定目标 | goal setting | `implemented` | `hub/server/mcp.ts` (`start_run`) | 场景 01, 08, 15, 16 |
| **P02** | 管道节点 | 第 2 步 绑定源文件 | source binding | `implemented` | `hub/runs/runs.ts`, `hub/connectors/` | 场景 01, 15, 16 |
| **P03** | 管道节点 | 第 3 步 定判定形状 | decision shape selection | `implemented` | `hub/runs/evaluator.ts`, `packs/workflow/` | 场景 01, 06 |
| **P04** | 管道节点 | 第 4 步 填槽位 | slot filling | `implemented` | `hub/rules/`, `packs/workflow/` | 场景 01, 20 |
| **P05** | 管道节点 | 第 5 步 生成 | deterministic generation | `contract only` | Hub 核心不生成内容；`defect-to-case` 包实现 | 场景 01 (用例评审包不生成内容) |
| **P06** | 管道节点 | 第 6 步 静态判定 | static verification | `implemented` | `hub/rules/runner.ts`, `hub/runs/evaluator.ts` | 场景 01, 04, 16, 20, 21, 22 |
| **P07** | 管道节点 | 第 7 步 动态判定 | dynamic verification | `contract only` | `contracts/receipt.json` | M1 不执行设备动态判定 |
| **P08** | 管道节点 | 第 8 步 分区交付 | partitioned delivery | `implemented` | `hub/runs/evaluator.ts`, `contracts/receipt.json` | 场景 01, 05, 10, 16, 20 |
| **P09** | 管道节点 | 第 9 步 反例回流 | counterexample feedback | `implemented` | `hub/runs/evaluator.ts`, `hub/runs/runs.ts` | 场景 02, 03, 21 |
| **P10** | 管道节点 | 第 10 步 沉淀 | consolidation | `contract only` | `contracts/model.json` | M1 暂缓 |
| **P11** | 管道节点 | 两道强制边界 | pipeline boundaries | `implemented` | `hub/server/mcp.ts`, `hub/runs/evaluator.ts` | 场景 01, 02, 21 |
| **I01** | 三条不变量 | 精确值与产物 | exact values & artifacts | `implemented` | `hub/records/artifacts.ts`, `hub/refs/` | 场景 01, 02, 09, 13, 21 |
| **I02** | 三条不变量 | 事实的来源 | source of facts | `implemented` | `hub/runs/evaluator.ts`, `hub/knowledge/catalog.ts` | 场景 01, 03, 04, 21, 22 |
| **I03** | 三条不变量 | 终态不升级 | no escalation | `implemented` | `hub/runs/evaluator.ts` | 场景 01, 20, 22 |
| **C01** | 组件模型 | 四个家 | four homes (B/C/E/D) | `implemented` | 仓库物理架构划分 (`hub/records`, `hub/runs` 等) | 全场景体系结构支撑 |
| **C02** | 组件模型 | 四类归属 | ownership classes | `implemented` | 核心/包/适配器/运行时代码分层 | 全场景 |
| **C03** | 组件模型 | 两种形态与插件 | interpreter / sans-IO | `implemented` | `hub/rules/sandbox/`, `hub/rules/runner.ts` | 场景 01, 18, 20 |
| **C04** | 组件模型 | 表 | table (fact / decision) | `implemented` | `packs/workflow/case-review/tables/` | 场景 01, 04, 20 |
| **C05** | 组件模型 | 规则 | rule | `implemented` | `packs/workflow/case-review/rules/` | 场景 01, 03, 04, 20, 21 |
| **C06** | 组件模型 | 政策表 | policy table | `implemented` | `hub/server/app.ts`, `hub/connectors/routes.ts` | 场景 09, 12, 18 |
| **C07** | 组件模型 | 目录 (封闭世界) | catalog (closed world) | `implemented` | `hub/knowledge/catalog.ts` | 场景 03, 04, 15, 21, 22 |
| **C08** | 组件模型 | 能力声明登记 | capability registry | `implemented` | `hub/pack/manifest.ts`, `hub/pack/publish.ts` | 场景 01, 08 |
| **T01** | 教与验 | 任务包 | task pack | `implemented` | `hub/pack/`, `packs/` | 场景 01, 08, 15, 16 |
| **T02** | 教与验 | 发布记录与校验 | publish record & check | `implemented` | `hub/pack/publish.ts` | 场景 01, 08 |
| **T03** | 教与验 | 边界校验 | boundary validation | `implemented` | `hub/pack/boundary.ts` | 场景 01, 06 |
| **T04** | 教与验 | 引用解析 | resolve, don't restrict | `implemented` | `hub/refs/`, `hub/server/mcp.ts` | 场景 01, 10, 21 |
| **K01** | 知识 | 知识树 | knowledge tree | `implemented` | `hub/knowledge/tree.ts` | 场景 11, 14, 15 |
| **K02** | 知识 | 知识条目 | knowledge entry | `implemented` | `hub/knowledge/tree.ts` | 场景 11, 14, 15 |
| **K03** | 知识 | 三层写入 | three writer layers | `implemented` | `hub/knowledge/tree.ts`, `hub/knowledge/sync.ts` | 场景 11, 14 |
| **K04** | 知识 | 知识归类 (Jev) | classification by Jev | `implemented` | `hub/knowledge/jev.ts` | 场景 11 |
| **K05** | 知识 | 本地缓存与获取 | pinned fetch & cache | `implemented` | `hub/knowledge/tree.ts`, `hub/records/artifacts.ts`| 场景 09, 14 |
| **D01** | 对接与协议 | 对接规范 | integration specification | `implemented` | `hub/connectors/` | 场景 01, 09, 16 |
| **D02** | 对接与协议 | 前提表 | target premises | `implemented` | `hub/records/resources.ts`, `hub/connectors/` | 场景 09, 16 |
| **D03** | 对接与协议 | 效果类与写声明 | effect class / write decl | `contract only` | `contracts/model.json` | M1 只读，无写路由 |
| **D04** | 对接与协议 | 效果安全机制 | lease / fencing / freeze | `contract only` | `contracts/model.json` | M1 只读，不涉及外部写入租约 |
| **D05** | 对接与协议 | 调用合约统一响应 | uniform call response | `implemented` | `hub/server/mcp.ts`, `contracts/receipt.json` | 场景 01-22 全场景 |
| **D06** | 对接与协议 | MCP 工具面 | MCP tool surface | `implemented` | `hub/server/mcp.ts` (6 确认工具) | 场景 01-22 全场景 |
| **D07** | 对接与协议 | 执行器资源 | executor resource | `out of scope` | `contracts/model.json` | 浏览器/设备执行器 M1 范围外 |
| **R01** | 人与权限 | 权限角色 | user / admin roles | `implemented` | `hub/records/authz.ts`, `hub/server/mcp.ts` | 场景 01, 06, 08, 12 |
| **R02** | 人与权限 | 可见性 | visibility | `implemented` | `hub/records/authz.ts`, `hub/server/app.ts` | 场景 06, 12 |
| **R03** | 人与权限 | bot (服务端 Circle) | server-side agent bot | `contract only` | `contracts/model.json` | M1 仅测试客户端驱动，服务端 bot 暂缓 |

---

## 2. 逐元素规则核对与怀疑论审计 (Rule-by-Rule Audit)

对所有标记为 `implemented` 的元素，以下逐项对照通用模型中的规则（Rules）进行核验，明确列出未实现项与**“没能验证”**之处。

### B01 主张 (claim)
- **R0 (五个字段固定)**：`hub/records/claims.ts` 中固定包含 statement、grounds、warrant、qualifier、validity 5 个顶层属性。已验证。
- **R1 (支撑 backing 归规则自身)**：规则校准与样例数据位于规则包目录（`packs/workflow/case-review/rules/`），主张记录本身不重复保存支撑。已验证。
- **R2 (反驳条件记可机器检查项)**：当摘要不匹配、规则撤回或断言矛盾时触发反驳。场景 02、03、21 已验证。
- **R3 (使用端重读有效条件)**：在计算终态与重用前检查有效条件摘要。场景 10 已验证。
- **R4 (根据只能指向结果或 Hub 自身动作/效果)**：场景 05、10 验证跨条目根据指向前序条目结果。
- **R5 (知识条目通过树地址与版本组成记录担保)**：场景 01、03、15 验证目录与知识引用指向知识树路径与锁定构建。
- **审计结论与未能验证**：规则逻辑已完整实现。*没能验证*：真实业务中“规则撤回”导致的已存历史主张动态级联失效（M1 暂无规则热撤回接口）。

### B02 源文件 (source artifact)
- **R0 (记录级保真、内容寻址)**：经 SHA-256 寻址并原样落盘存储。场景 01、09 验证。
- **R1 (只证明在某处出现过，不证明对)**：源文件作为根据原样引用。场景 01、16 验证。
- **R2 (出处身份与权威性)**：携带 connector、uri、fetched_at 等出处元数据。场景 01、09 验证。
- **R3 (可见性范围)**：个人凭据仅本人可见，包声明的公共镜像对分配者可见。场景 06、12 验证。
- **R4 (凭据扫描命中)**：上传时扫出明文口令拒绝受理，仅存摘要与扫描结论。*代码存在于 `hub/records/artifacts.ts`，但验收测试夹具均为合规数据，没能验证明文扫描拦截的现场效果*。
- **R5 (目标侧执行或密钥登记)**：目标侧密钥只登记位置与摘要。场景 09 验证。

### B03 引用 (reference (URI))
- **R0 (解析时重验摘要与权限)**：`hub/refs/` 在 resolve 时检查存在性、摘要与调用者权限。场景 06、21 验证。
- **R1 (只对 Hub 保存记录解析)**：篡改后报 `REFERENCE_UNRESOLVED`。场景 21 验证。
- **R2 (本地缓存构造交付核验)**：客户端引文在交付时由 Hub 沙箱重新核对。场景 01、02 验证。
- **R3 (交接不继承判定，重新核查)**：条目复用时仅继承条目与产物引用，判定必须重算。场景 10 验证。
- **R4 (规范化序列化视同源文件)**：场景 05 验证。
- **R5 (外部对象身份格式)**：采用 `agile:mindmap:<id>` 格式作为出处和目标键。场景 16 验证。

### B04 许可 (authorization record)
- **R0 (许可不当证据，检查不当许可)**：包分配与通过的静态校验分属不同表。场景 01、06 验证。
- **R1 (只覆盖绑定的确切内容)**：场景 06、08 验证。
- **R2 (仅分配已发布且未下架版本)**：`hub/records/authz.ts` 检查发布状态。场景 01、08 验证。
- **R3 (管理员分享)**：*没能验证*（跨租户/跨用户共享授权在 M1 验收中仅测试单人/两用户独立隔离，未测试跨用户分享流）。
- **R4 (冻结解除配置)**：M1 无外部写冻结，*没能验证*。
- **R5 (本人同意不是许可)**：M1 暂缓。
- **R6 (不经独立审批人、无两人规则)**：符合 10-21 决定。

### B05 动作记录 (Hub action record)
- **R0-R4 (每个操作记录动作、不可变追加、操作员审计)**：`hub/records/actions.ts` 记录每次 `start_run`、`submit_result`、`publish_pack`。场景 01、07、13、17 验证。

### B08 调用日志 (call log)
- **R0-R4 (W3C Trace Context, trace_id, session_id, 每调用一行, 仅摘要与大小, 控制台可查)**：每行 JSON Lines 格式记录，不存大体积请求体。场景 01、07、12、17、20、22 完整验证。

### A01-A06 主张属性
- **A01 (来源类型)**：observed (源文件观测), declared (模型提交), candidate (未复核草稿)。场景 01、20、22 验证。
- **A02 (依据等级)**：静态检查 (`static`) 为强依据，动态检查本期不适用。场景 01、04 验证。
- **A03 (来源角色)**：`source` (脑图/需求), `target` (被测系统), `rule` (任务包规则), `model` (提交模型)。场景 01、08、16 验证。
- **A04 (独立性)**：初评与独立复核运行元数据记录声明。场景 01、22 验证。
- **A05 (覆盖、边界与控制区间)**：条目判定范围与数值区间校验。场景 01、04、20 验证。
- **A06 (未知保持未知)**：动态层未执行保持 `not_applicable`，未校准片段留在父节点标 `uncalibrated`。场景 01、11 验证。

### V01-V07 判定、终态与分区
- **V01 (判定 verdict: pass / violation / inconclusive / not_applicable)**：场景 01、04、20 验证。
- **V02 (判断 judgment: finding / disposition)**：场景 01、02、21 验证。
- **V03 (层终态 static / dynamic / candidate)**：三层结构在回执中独立输出。场景 01、18、20 验证。
- **V04 (归责 attribution)**：缺陷归责到具体条目、要求项与源文件位置。场景 01、02、20、21 验证。
- **V05 (分区清单 delivered / repaired / retained / deferred)**：四集合互斥且完全覆盖。场景 01、05、10、16、20 验证。
- **V06 (交付规则 definition of done)**：全部条目落入有效分区且无致命未处理错误。场景 01、16 验证。
- **V07 (重复策略 repair rounds)**：修复轮数计数（从 2 递减），支持逐字留存与修复建议。场景 02、03、21 验证。

### W01-W08 工作结构
- **W01 (条目与投影)**：脑图节点展开为条目并合取投影。场景 01、10、16、20 验证。
- **W02 (要求项)**：包内 requirements 声明。场景 01、08、16 验证。
- **W03 (工作流包与产品绑定)**：同一个用例评审工作流包绑定两个不同产品包（双名字产品与独立产品）。场景 01、08 验证。
- **W04 (判定形状与台账)**：台账校验，未分配报 SOURCE_UNAVAILABLE。场景 01、06 验证。
- **W05 (中间表示与槽位)**：沙箱内规则提取槽位。场景 01、20 验证。
- **W06 (运行 run)**：冻结输入、版本、条目集合。场景 01、13、17 验证。
- **W07 (提交 submission)**：支持批量条目交付与多次修订。场景 01、02、13、19 验证。
- **W08 (校验结果 validation@1)**：符合 JSON Schema 规范，携带 structuredContent。场景 01、18、20 验证。

### P01-P11 管道节点与三条不变量
- **P01-P04, P06, P08, P09, P11**：端到端管道完整运转。
- **I01 (精确值与产物)**：引文逐字核对，任何非原样字符拒绝。场景 02、21 验证。
- **I02 (事实来源)**：事实只从受控源文件和目录得出，模型谎称命令存在被目录校验击穿。场景 03、21、22 验证。
- **I03 (终态不升级)**：静态层 violation 不会被模型主观判定覆盖升级为 pass。场景 01、20、22 验证。

### C01-C08 组件模型
- **C01-C03 (四家/归属/插件沙箱)**：沙箱运行隔离代码，Node `--permission` 或进程隔离。进程异常被安全捕获。场景 18 验证。
- **C04-C05 (表与规则)**：纯数据 JSON 驱动的规则与检查表。场景 01、04、20 验证。
- **C06 (政策表)**：Origin / Host / 路由白名单。场景 09、12 验证。
- **C07 (目录封闭世界)**：目录未收录即视为无此命令。场景 03、04、15、21、22 验证。
- **C08 (能力声明)**：通过 `pack.json` 导出。场景 01、08 验证。

### T01-T04 教与验
- **T01-T04**：发布包校验、边界隔离、引用正向解析。场景 01、06、08、10、21 验证。

### K01-K05 知识
- **K01-K03 (知识树、条目、三层写入)**：默克尔树寻址、多版本构建根生成、增量同步与树差异比对。场景 14、15 验证。
- **K04 (Jev 知识归类)**：未校准片段停留在父节点并标注 `uncalibrated`。场景 11 验证。*真实 LLM 的连续概率校准没能验证（采用合成脚本模型）*。
- **K05 (本地缓存)**：SHA-256 锁定与幂等跳过。场景 09、14 验证。

### D01-D07 对接与协议
- **D01-D02 (对接与前提表)**：通过合成敏捷系统包完成 150 节点获取与需求缺陷原文绑定。场景 01、09、16 验证。
- **D05-D06 (MCP 工具面)**：官方 SDK 客户端经回环 HTTP 访问 6 个标准 MCP 工具，参数校验与报错语义完备。场景 01-22 验证。

### R01-R02 人与权限
- **R01-R02 (角色与可见性)**：用户只能列出已分配包，无权读者得到中性码 `SOURCE_UNAVAILABLE`，控制台和 API 具备 Host/Origin 保护。场景 06、12 验证。

---

## 3. 关键未实现与“没能验证”清单 (Audit Findings & Gaps)

1. **动态层执行（P07 / V03）**：
   - 现状：回执中动态层统一如实返回 `not_applicable`（不适用）。
   - 原因：Milestone 1 简报与架构明确排除设备与测试床动态执行。
   - 审计结论：符合 M1 范围，但不能证明真实系统上的动态执行能力。

2. **外部写入与效果租约（B06 / D03 / D04）**：
   - 现状：连接器全部采用只读 GET 路由。效果记录（B06）、写声明（D03）、租约与隔离围栏（D04）仅在合约（`contracts/`）与数据层预留类型。
   - 审计结论：在未授权向外部业务系统写入的原则下保持只读，外部写入效果安全机制**没能验证**。

3. **人类接管与处置请求（B07 / W10）**：
   - 现状：未实现会话接管与人工处置审批流（根据 10-21 所有者决定简化架构）。
   - 审计结论：合约级保留，运行时未实现。

4. **真实大模型连续校准（K04）**：
   - 现状：验收测试使用 TypeScript 函数模拟的 `scriptedJudge`。
   - 审计结论：验证了当判断概率不足时片段停留在父节点的机制，但**没能验证**生产环境商业大模型在线校准的准确率。

5. **执行器资源代理（D07）与服务端 Bot（R03）**：
   - 现状：M1 采用客户端通过 MCP 直连 Hub，未运行沙箱内的无头浏览器或服务端代理 Worker。
   - 审计结论：M1 范围外，留待后续里程碑。

6. **业务包层面的特异行为（发现的包实现细节）**：
   - `packs/workflow/case-review/tables/structure.json` 中预期结果规则仅声明了 `"minItems": 1`，未声明 `"maxItems"`，并附注“条数不限”。因此在基准注入测试（场景 20）中，`two_expected`（注入多条预期结果）不会被用例评审包标记为缺陷。此为规则表设计的已知语义。
   - `scripts/real/benchmark/inject.ts` 的 `isNegative` 正则未匹配带方括号的 `[Negative]` 标签，导致在 150 节点夹具中移除负向用例时移除了 9 条标准 `Negative` 标签用例，保留了 1 条方括号标签用例。

---

## 4. 突变抽查验证报告 (Mutation Spot-Checks)

在独立临时工作区中，对 Hub 的 10 项关键核心行为进行了源码人为破坏（突变），并分别执行验收测试，确认相应场景能够灵敏捕捉破坏并失败（全部突变均在确认后立即还原，绝不留在仓库中）：

| 序号 | 核心行为 | 突变位置与方式 | 预期捕获的场景 | 实际断言失败输出 | 恢复验证 |
|---|---|---|---|---|---|
| 1 | **回执 `isError` 正确性** | 修改 `hub/runs/evaluator.ts`，将 `isError: acceptance !== 'accepted'` 强制改为 `isError: false` | 场景 02 (`02-quote-mismatch.test.ts`) | `AssertionError: false == true`（未接受的提交未被标为错误） | PASS |
| 2 | **分区清单互斥性 (Disjointness)** | 修改 `hub/runs/evaluator.ts`，将已交付条目同时加入 `deferred` 延迟分区 | 场景 01 (`01-normal-review.test.ts`) | `AssertionError: delivered items partition check`（分区存在交集） | PASS |
| 3 | **`QUOTE_MISMATCH` 校验** | 修改 `hub/runs/evaluator.ts`，跳过源文件逐字引文对比，默认通过 | 场景 02 (`02-quote-mismatch.test.ts`) | `AssertionError: 'accepted' == 'not_accepted'`（篡改引文被错误接受） | PASS |
| 4 | **修复轮数递减 (Repair Rounds)** | 修改 `hub/runs/runs.ts`，将初次违规时的 `rounds_left: 2` 强制改为 `0` | 场景 02 (`02-quote-mismatch.test.ts`) | `AssertionError: 0 == 2`（修复轮次初始化异常） | PASS |
| 5 | **缺失等同于无权 (`SOURCE_UNAVAILABLE`)** | 修改 `hub/server/mcp.ts`，未授权包直接抛出 `Error("Pack not found")` 返回 RPC 错误码 | 场景 06 (`06-user-without-pack.test.ts`) | `AssertionError: missing SOURCE_UNAVAILABLE neutral message` | PASS |
| 6 | **连接器路由白名单拦截** | 修改 `hub/connectors/routes.ts`，放行所有未在白名单中的路径 | 场景 09 (`09-connectors.test.ts`) | `AssertionError: route outside allow-list was not refused` | PASS |
| 7 | **凭据失效重试仅限一次** | 修改 `hub/connectors/agile.ts`，在 401 失败后无限制重试登录 | 场景 09 (`09-connectors.test.ts`) | `AssertionError: expected at most 2 requests, got 5` | PASS |
| 8 | **记录与调用日志摘要哈希** | 修改 `hub/records/call-log.ts`，使用固定常量字符串代替 SHA-256 计算 | 场景 07 (`07-call-log.test.ts`) | `AssertionError: args_digest does not match /^[0-9a-f]{64}$/` | PASS |
| 9 | **身份认证与 Token 鉴权** | 修改 `hub/server/app.ts`，无 Token 请求不再返回 401 / 重定向，默认放行 | 场景 12 (`12-console-security.test.ts`) | `AssertionError: expected 401, got 200` | PASS |
| 10 | **主张与条目复用有效条件绑定** | 修改 `hub/runs/runs.ts`，在检查源上下文变更时忽略上下文摘要差异 | 场景 10 (`10-item-reuse.test.ts`) | `AssertionError: changed item was offered reuse without re-judging` | PASS |

突变测试表明，验收套件所断言的真实效果对系统核心因果不变量具备高灵敏度与高置信度。
