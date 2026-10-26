# Hub r4 对照模型独立复核记录（阶段 4 重做）

> 依据通用模型设计权威 `contracts/model.json`（73 个元素、54 个词表轴，版本 5）、架构基准 `docs/hub-r4-architecture.md` 以及进度页决定（`docs/hub-r4-progress.md` 决定 9、14、15、16、17、18，任务页 `docs/hub-r4-tasks/engine-readings.md`），对 circle-hub 整体实现进行逐项独立复核。
> 本次复核严格核对每一个文件存在性与每一个测试用例原名及行号，不作猜测，对未落实及偏离如实记录。

## 1. 复核概述与统计结论

本里程碑（Milestone 1）重点交付：基于 MCP 协议对外提供只读敏捷用例评审与用例管理核心能力，包含知识树锁定、精确值引用解析、纯函数与 8 种表解释器沙箱执行、层终态与分区清单计算、只增记录库与调用审计日志。效果写入（Effects）、动态层执行（Dynamic Verification）、外部请求（Requests）、反例回流与假设集明确排定在后续里程碑。进度页决定 9（知识同步）与决定 16（设备管理包的租约）将常设义务与租约机制带入实现范围。

### 1.1 统计概览

| 分类指标 | 数量 | 占比 | 简述 |
| :--- | :---: | :---: | :--- |
| **模型元素总数** | **73** | 100% | 涵盖 B01-B08、A01-A06、V01-V08、W01-W10、P01-P11、I01-I03、C01-C08、T01-T04、K01-K05、D01-D07、R01-R03 |
| **里程碑 1 范围外元素** | **8** | 11.0% | 架构第 1 节明确暂不实现：B06、B07、V08、P07、P09、P10、D07、R03 |
| **里程碑 1 范围内元素** | **65** | 89.0% | 本里程碑应实现与落地的模型规范（含决定 9/16 带入的 W09 与 D04） |
| ├─ **落实（Fully Implemented）** | **55** | 75.3% (占范围 84.6%) | 规则完整落地于核心代码，并由自动化测试严密覆盖 |
| ├─ **部分落实（Partially Implemented）** | **7** | 9.6% (占范围 10.8%) | 核心机制已实现，辅助特性（如写候选层、人工接管区间、效果前边界）受里程碑边界约束暂未开放（A05、K03、K04、C06、D03、P11）；P05 见下面的更正 |
| └─ **没落实（Not Implemented）** | **3** | 4.1% (占范围 4.6%) | 模型已定义但在当前代码中缺失（W04 判定台账、W10 判据变更声明、V07 多轮重复策略） |

---

## 2. 需要所有者知道的偏离（单列重要偏离）

在复核过程中，识别出以下 7 条关键架构与模型偏离，特此单列供所有者知晓：

1. **架构第 1 节范围描述未同步更新（偏离）**
   - **偏离事实**：架构第 1 节将租约（leases）与常设义务（standing obligations）列为“不在这个里程碑（Out of scope for milestone 1）”；然而进度页决定 9（知识同步常设义务，每已发布构建产出一个根）与决定 16（设备管理包的租约机制，由所有者确认设计）已正式将常设义务与租约带入实现。代码中已完整落地常设义务知识同步（`hub/knowledge/sync.ts`）与租约服务（`hub/leases/service.ts`、`hub/runs/engine/leases-wiring.test.ts`、`contracts/src/leases.test.ts`），架构第 1 节的排除描述未同步修订。
2. **W10 判据变更声明在核心中未实现（未落实）**
   - **模型要求**：用例期望/标准变更必须走 `W10` 判据变更声明，显式引用支持新期望的片段并经独立第二人确认；被接受前原判据判为不通过。
   - **实现现状**：核心无判据变更声明通道或第二人确认机制，判据修改目前只能通过包作者发布新版本全局覆盖。
3. **V07 重复策略（k-of-n / all / first_pass 多轮聚合）未进入运行引擎（未落实）**
   - **模型要求**：间歇性波动观察须按配置策略（`all`、`k_of_n`、`first_pass`）执行多次运行并呈现观测分布（如 `3/3 未见失败`），混合结果记未知。
   - **实现现状**：词表生成了聚合轴，但运行引擎 `hub/runs/engine/terminals.ts` 仅按单次提交与修复轮数计算终态，未实现多轮聚合器。
4. **W04 判定台账与运行期未裁定形状流转机制缺失（未落实）**
   - **模型要求**：运行中遇到台账外的判定形状不挂起，相关项记为“判断（判定形状未裁定）”，下版由包作者裁定进台账。
   - **实现现状**：未建判定台账实体；遇到未声明解释器的检查在发布包校验阶段即直接拦截拒绝（`checks.interpreter_missing`），无法在运行中作为未裁定形状流转。
5. **K03/K04 个人候选层写入与模型智能归位通道未开通（部分落实）**
   - **模型要求**：知识树支持树本身、观察层、个人候选层三层写入；无显式路径的片段可由 bot 提议归位并由 Hub 确定性核验。
   - **实现现状**：受 2026-10-22 所有者决定（决定 15：“Hub 不调用判断模型”）约束，严格落实了确定性规则归类与未归位存根，但个人候选层写入（架构第 1 节明确排除）和智能归位提议通道未开放。
6. **D03/P11 效果前强制边界（租约、围栏、参数范围）未激活（部分落实）**
   - **模型要求**：统一管道包含效果前边界（校验动作允许表、参数范围、租约与围栏、全局政策表）与交付前边界。
   - **实现现状**：因里程碑 1 排除外部写效果，交付前边界（终态与分区计算）完全激活，效果前边界及全局政策表在当前代码中处于闲置未装配状态。
7. **模型概念未完全纳入词表轴而存在手写枚举（偏离）**
   - **偏离事实**：架构第 2 节明确规定“No coined terms. Labels come from labelOf(axis, code) in contracts/generated/vocabulary.ts; enumerations are never written by hand anywhere; use the generated types and zod enums.”然而在 `contracts/src/` 核心契约中，仍有核心模型明确规定的概念未纳入 54 个词表轴，而以手写字面量枚举存在：
     - `contracts/src/pack.ts:139` 与 `contracts/src/pack.ts:278`：手写 `z.enum(['item', 'run'])`（`target` 与 `applies`）。条目级与运行级划分是模型 W02 R[1]、T03 R[4]、W07 F[4] 的核心概念，词表缺失对应轴。
     - `contracts/src/tables.ts:334`：手写 `z.enum(['count', 'sum', 'min', 'max'])`（`measure`）。度量聚合计算是模型 C04 R[3] / C04 F[0] 明确规定的方式，词表中未建度量聚合轴。
     - `contracts/src/pack.ts:530`：手写 `['author', 'returned_counterexample', 'retained_delivery'] as const`（`CounterexampleSource`）。模型 P09 规划的反例来源，契约中未建轴而手写。
     - `contracts/src/product.ts:188`：手写 `z.enum(['code_only', 'judgment_allowed'])`（`placement`）。决定 15 与 `jev-optin.md` 引入的生产器归位授权策略，未建立词表轴。

---

## 3. 横向硬规则核对

### 3.1 核心代码无产品名、命令名、客户名
- **核对标准**：架构第 2 节要求“Product knowledge lives in packs, never in the core. The core code must not contain a product name, a command name or a customer name.”
- **复核结论**：**完全合规（0 处违规）**。
- **证据**：在 `hub/**` 生产代码中全局检索产品名（`FAMX`、`FAMY`）、产品命令名（`slb`、`proxyip`、`vlan` 等）、客户专名，匹配结果均为 0；早先在 `slots.ts` 中手写的特定字段名已重构成基于 JSON Schema 指针的通用推导机制（`hub/runs/engine/slots.ts`），核心代码无业务专用词素。

### 3.2 枚举只来自生成的词表（全代码库字面量枚举核对）
- **核对标准**：所有模型业务概念枚举必须来自生成的 54 个词表轴（10-23 在提交 `26d7245` 中新增 `lease_op` 轴）。全库检索所有 `z.enum([...` 与 `[...] as const` 字面量数组，逐个核实是否为词表轴、是否与 54 个轴重合、是否为模型概念或格式层。
- **复核结论**：
  1. **`hub/` 生产核心代码完全合规**：0 处 `z.enum`，所有业务类型均导入词表；所有 `as const` 数组仅用于测试遍历、内部 AST 键遍历或底层系统目录名。
  2. **`contracts/src/` 发现 4 处模型概念手写枚举**（已列入第 2 节偏离 7），其余手写枚举均严格属于数据格式层与网络协议层。
  3. **`packs/` 与 `scripts/` 均严格隔离**：包内部枚举仅为该产品专有的业务标签（如 FAMX 6 大测试用例分类）或脚本参数，无泄漏至核心。

#### 全库字面量数组逐项核对明细表

##### 1. `contracts/src/` 契约定义层（10 处 `z.enum` + 14 处 `as const`）
| 文件:行号 | 类型 | 取值 | 是否与 54 轴重合 | 是否模型概念 | 属性分类与理由 |
| :--- | :---: | :--- | :---: | :---: | :--- |
| `contracts/src/tables.ts:42` | `z.enum` | none, nfc, nfkc | 否 | 否 | **格式层**：Unicode 字符规范化标准形式（RFC/Unicode 规范） |
| `contracts/src/tables.ts:43` | `z.enum` | sensitive, insensitive | 否 | 否 | **格式层**：通用字符串比对大小写敏感性配置 |
| `contracts/src/tables.ts:44` | `z.enum` | exact, trim, collapse | 否 | 否 | **格式层**：空白字符归一化模式（前后裁剪或折叠空格） |
| `contracts/src/tables.ts:67` | `z.enum` | string, integer, number, boolean, array, object, null | 否 | 否 | **格式层**：JSON Schema 基础数据类型规范（RFC 8259） |
| `contracts/src/tables.ts:101` | `z.enum` | all, siblings, group | 否 | 否 | **格式层**：集合表唯一性校验作用域 |
| `contracts/src/tables.ts:153` | `z.enum` | resolved, first_word, all | 否 | 否 | **格式层**：目录命令分词查找范围模式 |
| `contracts/src/tables.ts:192` | `z.enum` | string, int, enum, ipv4, ipv6, mask, port, keyword | 否 | 否 | **格式层**：命令参数类型定义（CLI 签名解析器专用语法类型） |
| `contracts/src/tables.ts:268` | `z.enum` | '', i | 否 | 否 | **格式层**：正则表达式修饰符（ECMAScript RegExp flags） |
| `contracts/src/tables.ts:269` | `z.enum` | full, search | 否 | 否 | **格式层**：正则匹配模式（全字匹配 vs 局部搜索） |
| `contracts/src/tables.ts:334` | `z.enum` | count, sum, min, max | 否 | **是** | **模型概念手写（偏离）**：C04 R[3] 度量聚合方式，词表中未建轴 |
| `contracts/src/pack.ts:139` | `z.enum` | item, run | 否 | **是** | **模型概念手写（偏离）**：W02 R[1] 目标级别，词表中未建轴 |
| `contracts/src/pack.ts:278` | `z.enum` | run, item | 否 | **是** | **模型概念手写（偏离）**：T03 R[4] 检查作用域，词表中未建轴 |
| `contracts/src/product.ts:188` | `z.enum` | code_only, judgment_allowed | 否 | **是** | **模型概念手写（偏离）**：决定 15/jev-optin 生产器归位授权策略，未建词表轴 |
| `contracts/src/pack.ts:193` | `as const` | builds, leases | 否 | 否 | **协议层**：工作流可声明请求的上下文键名 |
| `contracts/src/pack.ts:530` | `as const` | author, returned_counterexample, retained_delivery | 否 | **是** | **模型概念手写（偏离）**：P09 R[0] 反例来源（P09 暂不在范围） |
| `contracts/src/product.ts:31` | `as const` | product, line, build, base, family, platform | 否 | 否 | **格式层**：URL 模板变量名白名单 |
| `contracts/src/resources.ts:21` | `as const` | GET, POST, PROPFIND | 否 | 否 | **协议层**：网络请求方法白名单（RFC 7231/4918） |
| `contracts/src/resources.ts:23` | `as const` | json, text, xml, html, bytes | 否 | 否 | **协议层**：外部响应 MIME 数据类型归一化 |
| `contracts/src/resources.ts:25` | `as const` | none, static_header, login_token | 否 | 否 | **协议层**：外部连接器认证机制分类 |
| `contracts/src/resources.ts:28` | `as const` | plain, sha512_base64 | 否 | 否 | **协议层**：连接器密码散列算法 |
| `contracts/src/resources.ts:31` | `as const` | raw, bearer | 否 | 否 | **协议层**：HTTP 凭据传输方案 |
| `contracts/src/resources.ts:33` | `as const` | epoch_seconds, epoch_millis, iso8601 | 否 | 否 | **格式层**：时间编码格式分类 |
| `contracts/src/knowledge.ts:33` | `as const` | release_record, device_echo, declared | 否 | 否 | **协议层**：已知构建来源元数据类别 |
| `contracts/src/validation.ts:56` | `as const` | code, reason | 否 | 否 | **协议层**：反驳判定内部字段种类 |
| `contracts/src/annotations.test.ts:21` | `as const` | 6 个 MCP 工具名 | 否 | 否 | **测试遍历**：对 6 个工具元数据进行循环断言 |
| `contracts/src/annotations.test.ts:44` | `as const` | sync_write, job, notification | **重合** (子集) | 是 | **测试遍历**：词表轴 `EFFECT_CLASS` 的子集遍历 |
| `contracts/src/leases.test.ts:189` | `as const` | extend, release, force_release, take_over | **重合** (子集) | 是 | **测试遍历**：词表轴 `LEASE_OP` 的子集遍历 |
| `contracts/src/tool-shapes.test.ts:212` | `as const` | input, output | 否 | 否 | **测试遍历**：工具模式方向遍历 |

##### 2. `hub/` 核心实现层（0 处 `z.enum` + 35 处 `as const`）
- **`z.enum` 统计**：**0 处**。核心生产代码中所有类型均直接引用词表导出的 Zod 模式。
- **`as const` 数组分类**：
  1. **测试用例遍历词表轴**（6 处）：
     - `hub/records/artifacts.test.ts:145`：`['model', 'function', 'human'] as const`（与词表轴 `PRODUCER_KIND` 完全一致）。
     - `hub/runs/engine/terminals.test.ts:217`：`['expected', 'hint', 'reported_actual'] as const`（词表轴 `SOURCE_ROLE` 测试子集）。
     - `hub/server/text.test.ts:795, 835`：`['delivered', 'rejected', 'quarantined', 'incomplete'] as const`（词表轴 `PARTITION` 遍历）。
     - `hub/records/authorizations.test.ts:146, 153`：动作序列测试。
  2. **内部 AST / JSON Schema 遍历关键字**（4 处）：
     - `hub/runs/engine/slots.ts:198, 222` 与 `hub/server/text.ts:472`：`['allOf', 'anyOf', 'oneOf'] as const`（JSON Schema 规范组合关键字）。
     - `hub/rules/interpreters/range.ts:49`：`['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'] as const`（JSON Schema 数值限制关键字）。
  3. **底层平台、文件系统与工具配置**（14 处）：
     - `hub/platform/layout.ts:36`：`['db', 'run', 'objects', 'vault', 'logs', 'backups', 'releases', 'config'] as const`（服务主目录子目录结构）。
     - `hub/platform/postgres.ts:93`：`['initdb', 'pg_ctl', 'postgres'] as const`（PostgreSQL 命令行工具名）。
     - `hub/platform/backup.ts:36`、`hub/platform/rehearse.ts`、`hub/platform/restore.ts`：备份区域与目录清单。
     - `hub/records/scan.ts:12`：`CREDENTIAL_DETECTORS`（合规敏感词检测器类型名）。
     - `hub/rules/check.ts:112`：`PUBLIC_DETAIL`（错误公开字段过滤白名单）。
     - `hub/testing/postgres.ts:65`：`['SIGTERM', 'SIGINT', 'SIGHUP'] as const`（OS 信号）。
  4. **代码同步手写**（1 处）：
     - `hub/runs/packs/validate.ts:421`：`['item', 'run'] as const`（与 pack.ts 对应的作用域遍历，归入偏离 7）。

##### 3. `packs/` 任务包层（0 处 `z.enum` + 33 处 `as const`）
- **`z.enum` 统计**：**0 处**。
- **`as const` 分析**：全部属于**产品知识与工作流包内部私有业务逻辑**（架构第 2 节“产品知识活在包内，绝不进核心”）：
  - `packs/product/famx/functions/cases-rules.ts:32`：`['Functional', 'Configuration', 'Integration', 'Compatibility', 'Negative', 'Stress'] as const`（FAMX 产品特定的 6 大测试用例分类标签，属于 FAMX 产品领域知识）。
  - `packs/workflow/case-review/functions/project.ts:47`：`['tagged', 'marked'] as const`（决定 18 用例提取规则包内部参数）。
  - `packs/workflow/case-review-report/functions/checks.ts:13`：`['PASS', 'PARTIAL', 'FAIL'] as const`（报告层状态分类）。
  - `packs/workflow/test-bed/functions/manifest.ts:7, 24`：设备管理包内部设备拓扑类型与 TCP/UDP 协议。

##### 4. `scripts/` 外部脚本层（0 处 `z.enum` + 5 处 `as const`）
- **`z.enum` 统计**：**0 处**。
- **`as const` 分析**：
  - `scripts/real/gold/command-diff.test.ts:128`：`['added', 'removed', 'modified'] as const`（**与词表轴 `CHANGE_KIND` 取值完全重合**）。
  - `scripts/real/circle-home.ts:25`：`['list_task_packs', 'upload_file', 'start_run', 'get_nodes', 'resolve_reference', 'submit_result'] as const`（6 个 MCP 工具名）。
  - `scripts/real/benchmark/inject.ts:12`：缺陷注入工具专用测试缺陷类型列表。

### 3.3 未知从不映射成错误
- **核对标准**：未知（unknown）是诚实的不确定状态，绝不能被包装为错误（`isError: true`）。
- **复核结论**：**完全合规**。
- **证据**：
  1. MCP 响应（`hub/server/mcp.ts`）中，`isError` 严格限制为协议级错误或未被接受的收据；条目终态为 unknown 或 incomplete 时，提交回执的 `call_result` 为 ok，`isError: false`。
  2. 引用解析（`hub/refs/resolve.ts`）遇无法解析时返回 `{ status: 'unresolved' }`，`isError: false`。
  3. 面对无权访问或不存在的对象，均返回中性统一空结构及错误码 `SOURCE_UNAVAILABLE`，不泄露存在性信息。

### 3.4 记录只追加
- **核对标准**：记录库（`records` 表）只追加，绝不执行 UPDATE 或 DELETE。
- **复核结论**：**完全合规**。
- **证据**：
  在 `hub/records/` 生产代码中，所有记录写入均通过 `INSERT INTO records` 追加落库；对 `records` 表无任何生产 `UPDATE` 或 `DELETE` 语句（仅在防篡改测试中模拟数据被篡改的断言）。

### 3.5 每个精确值都能解析到引用
- **核对标准**：所有出现在声明、判定或提交中的精确值（命令名、引文片段、快照哈希），必须在边界解析成 `src://`、`tree://`、`rec://` 引用。
- **复核结论**：**完全合规**。
- **证据**：
  在 `hub/refs/resolve.ts` 与 `hub/runs/engine/exact.ts` 中，所有精确值均经由引用解析器（`resolveReference`）定位到具体的源文件字节区间或知识树节点，无法定位的值被标记为 `unresolved`，不接受无依据的字面量。

---

## 4. 已定的引擎读法核对（进度页决定 17 与 engine-readings.md）

进度页决定 17 针对模型的三处歧义读法给出了终局定夺，复核结果如下：

1. **读法 1（项 5：主体上的修复行）**
   - **定夺内容**：修复只用于待判定产物（模型自身回答）上的检查；评审主体（被评审的测试脑图/材料）上的反驳停在“不通过”，归作者输入（author_input），不进入修复，也不消耗修复轮数（round 预算）。
   - **代码落地**：`hub/runs/engine/terminals.ts:rowApplies` 严格限制修复规则仅对 `judges === 'reported_actual'` 生效；若被评审主体反驳，归责判定为 `author_input`，且 `rounds.used` 不增加。
   - **核对结论**：**完全一致**。
2. **读法 2（项 6：动作“记未知”）**
   - **定夺内容**：动作 `unknown`（记未知）不改终态：一条已经返回的反驳仍是“不通过”，码和档照记，归责留空（unattributed），要求项状态是未满足（unsatisfied）；记未知既不修复也不拒收。
   - **代码落地**：`hub/runs/engine/terminals.ts:staticLayer` 与 `applyRouting` 严格保持已有反驳结果，归责置空，状态记为 `unsatisfied`。
   - **核对结论**：**完全一致**。
3. **读法 3（项 4：检查必须声明档位 tier）**
   - **定夺内容**：每个检查必须显式声明档位。发布时强制（`checks.tier_missing`）；而在运行期，最初设计的兼容回退（无 tier 时按依据猜测 blocking / advisory）已在提交 `26d7245`（`b1b5ab15`）中彻底去掉，未声明 tier 的包函数在运行期直接返回 `check_error`（`unknown(inert, 'check_error', detail)`），包函数不被调用。
   - **代码落地**：
     - 发布期：`hub/runs/packs/validate.ts` 第 390 行测试验证缺失 tier 直接拒绝发布。
     - 运行期：`hub/rules/check.ts` 明确去除 basis 兜底猜档，未声明 tier 的包函数直接返回 `check_error`，并记录管理员日志，由 `hub/rules/check.test.ts:132` 严格钉住。
   - **核对结论**：**完全一致**（旧读法回退已完全废除，当前代码与最新提交保持严格一致）。

---

## 5. 73 个模型元素逐项复核明细表

> 注：下表中每个文件路径均已通过 `ls` 真实存在性核对；每个测试均原样提取自对应文件的 `it` 或 `test` 声明，并标注 `文件:行号`，全部通过 `grep -n -F` 原样校验。

| ID | 元素名称 | 英文名 | 分类 | 范围判定 | 落实状态 | 对应代码文件 | 对应测试（文件:行号 原样测试名） | 落实情况与核对说明 |
| :--- | :--- | :--- | :--- | :---: | :---: | :--- | :--- | :--- |
| **B01** | 主张 | claim | 记录与证据 | 在范围 | **落实** | `contracts/src/claim.ts`<br>`hub/runs/engine/claims.ts`<br>`hub/records/store.ts` | `contracts/src/shapes.test.ts:167`<br>a knowledge entry is never a ground on its own, but stays a reference (B01 R[5])<br><br>`contracts/src/shapes.test.ts:259`<br>a knowledge entry is cited by its tree address, never as a bare entry (B01 R[5]) | 声明事实断言与判断，必须附带依据引用（Ground: src, tree, rec）。通过 Claim 契约与引擎校验完整落实。 |
| **B02** | 源文件 | source artifact | 记录与证据 | 在范围 | **落实** | `hub/records/artifacts.ts`<br>`hub/records/objects.ts`<br>`contracts/src/resources.ts` | `hub/records/artifacts.test.ts:62`<br>a clean upload stores the bytes and a source_artifact record; repeating it returns the same record<br><br>`hub/records/findings.test.ts:423`<br>the acceptance and the accepted artifact keep positions and detector ids only, never the matched text | 只读外部文档、手册、代码、发布记录等原件，SHA-256 寻址与内容寻址存储，脱敏与安全扫描完整落实。 |
| **B03** | 引用 | reference | 记录与证据 | 在范围 | **落实** | `contracts/src/reference.ts`<br>`hub/refs/reference.ts`<br>`hub/refs/resolve.ts` | `hub/refs/reference.test.ts:88`<br>builds references with the helpers<br><br>`hub/refs/reference.test.ts:300`<br>format and parse are inverse on 3000 generated references<br><br>`hub/refs/resolve.test.ts:446`<br>parses a source once for repeated references | 规范化精确引用语法（src://, tree://, rec://），解析器解构、规范化与可逆变换完整落实。 |
| **B04** | 许可 | authorization | 记录与证据 | 在范围 | **落实** | `hub/records/authorizations.ts`<br>`hub/records/principals.ts` | `hub/records/authorizations.test.ts:29`<br>pack assignment: the latest record per user and pack wins, and nothing is ever deleted<br><br>`hub/records/authorizations.test.ts:80`<br>only admins decide assignments, publish rights, resource configuration and shares | 记录任务包分配、发布权授予与只增授权决策链，仅管理员可授权，只增记录回溯完整落实。 |
| **B05** | 动作记录 | action record | 记录与证据 | 在范围 | **落实** | `hub/records/store.ts`<br>`hub/records/pointers.ts`<br>`hub/leases/service.ts` | `hub/leases/service.test.ts:290`<br>every change appends a lease action record; replaying the records rebuilds the table<br><br>`hub/records/authorizations.test.ts:127`<br>with a frozen clock every decision is still its own record: the last one wins (assign, share, publish) | 记录每次状态变更动作（发布、分配、移动根、租约操作等），事务内只增落库完整落实。 |
| **B06** | 效果记录 | effect record | 记录与证据 | 不在范围 | **不在范围** | `contracts/src/records.ts` | `hub/runs/engine/partitions.test.ts:59`<br>hooks for effects, dispositions and abandonment come first (unused in milestone 1) | 架构第 1 节明确排除外部系统写效果记录（effects out of scope）。 |
| **B07** | 请求 | request | 记录与证据 | 不在范围 | **不在范围** | `contracts/src/records.ts` | `hub/runs/engine/partitions.test.ts:59`<br>hooks for effects, dispositions and abandonment come first (unused in milestone 1) | 架构第 1 节明确排除外部请求（dispositions and requests out of scope）。 |
| **B08** | 调用日志 | call log | 记录与证据 | 在范围 | **落实** | `hub/records/calllog.ts`<br>`hub/server/mcp.ts` | `hub/records/calllog.test.ts:54`<br>one line per call: a call_log record, a typed row and a JSONL line, with only the digest and size of the arguments<br><br>`hub/records/calllog.test.ts:240`<br>a client preview is kept only when it is at most 1 KB and holds no credential (B08 F[7], R[1])<br><br>`tests/acceptance/07-call-log.test.ts:32`<br>one line per call with trace id and session id; argument digest and size only | 审计所有外部 MCP/HTTP 工具调用，每调用一行只增记录与 JSONL，入参摘要脱敏与耗时统计完整落实。 |
| **A01** | 来源类型 | source type | 来源与依据 | 在范围 | **落实** | `contracts/src/resources.ts`<br>`hub/server/mcp.ts`<br>`hub/runs/engine/inputs.ts` | `hub/server/mcp.test.ts:163`<br>start_run stays closed-world for a pack whose inputs take only the Hub\'s own knowledge views: reading them is Hub-internal | 区分外部业务对象与 Hub 内部对象，按闭世界/开世界提示隔离，输入槽位来源类型校验完整落实。 |
| **A02** | 依据等级 | grounding hierarchy | 来源与依据 | 在范围 | **落实** | `contracts/generated/vocabulary.ts`<br>`hub/rules/check.ts`<br>`hub/rules/outcome.ts` | `hub/rules/check.test.ts:29`<br>runs the interpreter with the table and keeps the table tier<br><br>`hub/rules/check.test.ts:132`<br>a pack function without a declared tier is not run: check error, the admin log gets the missing tier, no guess | 依据等级（primary, secondary, auxiliary）及检查档位（blocking, advisory）在解释器和运行期判定中完整落实。 |
| **A03** | 来源角色 | source role | 来源与依据 | 在范围 | **落实** | `contracts/src/pack.ts`<br>`contracts/src/run.ts`<br>`hub/runs/engine/inputs.ts`<br>`hub/runs/engine/readers.ts` | `tests/acceptance/27-check-reads-bound-sources.test.ts:190`<br>check declaring reads receives bound expected sources, while check without reads does not | 划分被评材料（subject）、判定依据（basis）及辅助来源（auxiliary），按声明严格隔离读取权限。 |
| **A04** | 独立性 | independence | 来源与依据 | 在范围 | **落实** | `hub/runs/engine/independence.ts`<br>`contracts/src/validation.ts` | `hub/runs/engine/independence.test.ts:28`<br>independence from the author of the work under verification: sessions, model families, completeness<br><br>`tests/acceptance/22-fact-model-independence.test.ts:112`<br>fact requirements (literal and catalog) produce 100% identical terminals between Model A and Model B | 复核者与被检作者独立性校验（模型族、会话隔离），事实判定独立于模型提交结果完全落实。 |
| **A05** | 覆盖、边界与控制区间 | coverage, boundary, control interval | 来源与依据 | 在范围 | **部分落实** | `contracts/src/validation.ts`<br>`hub/rules/interpreters/catalog.ts`<br>`hub/runs/engine/partitions.ts` | `tests/acceptance/04-negative-case-param-out-of-range.test.ts:42`<br>the catalog check refutes an out-of-range parameter as expected, satisfied at advisory tier | 参数合法边界校验与分区覆盖率分析已落实；受管会话人工接管控制区间按模型 pendingDecisions 项 13 明确暂缓未实现。 |
| **A06** | 未知 | unknown | 来源与依据 | 在范围 | **落实** | `hub/server/mcp.ts`<br>`hub/runs/engine/terminals.ts`<br>`hub/server/errors.ts` | `hub/server/mcp.test.ts:416`<br>submit_result: accepted with partitions and counts (unknown is not an error), not accepted, malformed run, repeat<br><br>`hub/server/mcp.test.ts:1020`<br>isError is true exactly for protocol errors and receipts that are not accepted; every answer conforms to its schema<br><br>`hub/server/mcp.test.ts:1083`<br>a thrown error: a registered code becomes its answer, SOURCE_UNAVAILABLE stays neutral, anything else is internal | 未知从不映射为错误（isError: false），来源缺失或无权均返回中性 SOURCE_UNAVAILABLE，诚信保留未知状态。 |
| **V01** | 判定 | verdict | 判定与终态 | 在范围 | **落实** | `contracts/src/tables.ts`<br>`hub/rules/check.ts`<br>`hub/rules/outcome.ts` | `hub/rules/check.test.ts:29`<br>runs the interpreter with the table and keeps the table tier<br><br>`hub/rules/check.test.ts:132`<br>a pack function without a declared tier is not run: check error, the admin log gets the missing tier, no guess | 纯函数与8种表解释器沙箱执行，输出支持（support）、反驳（refute）或检查出错（check_error），带依据与档位。 |
| **V02** | 判断 | judgment | 判定与终态 | 在范围 | **落实** | `contracts/src/claim.ts`<br>`hub/runs/engine/claims.ts`<br>`hub/server/assemble/no-judgment.test.ts` | `hub/server/assemble/no-judgment.test.ts:33`<br>a legacy key in the vault buys no client and no outbound call; declared path-less entries stay unplaced at the root<br><br>`tests/acceptance/11-no-judgment.test.ts:27`<br>the assembly has no placer and the produced roots mark every path-less entry unplaced at the root | 判断作为客户端主张提交，Hub 核心不内置判断模型（决定 15），判断主张必须由 Hub 独立规则核查。 |
| **V03** | 层终态 | layer terminal | 判定与终态 | 在范围 | **落实** | `hub/runs/engine/terminals.ts` | `hub/runs/engine/terminals.test.ts:48`<br>fact terminals: all support pass, any refute violation, unknown by its reason (V01 R[6]), no check no_check<br><br>`hub/runs/engine/terminals.test.ts:126`<br>status: pending while unsettled, outcome_mismatch when a settled terminal misses, satisfied otherwise, no_producer<br><br>`hub/runs/engine/terminals.test.ts:256`<br>item cell: strongest terminal per layer with the counts of the other non-pass terminals; undeclared layers have none | 条目各要求项按层（静态层、事实层）计算终态，合取投影次序（不通过 > 未完成 > 未核对 > 判断 > 通过）严格落实。 |
| **V04** | 归责 | attribution | 判定与终态 | 在范围 | **落实** | `hub/runs/engine/terminals.ts` | `hub/runs/engine/terminals.test.ts:156`<br>attribution only on non-pass terminals that miss the expectation, by rule tables | 终态未满足时，按规则表精确归责（producer_error、author_input、harness_defect、unattributed）。 |
| **V05** | 分区清单 | partition manifest | 判定与终态 | 在范围 | **落实** | `hub/runs/engine/partitions.ts` | `hub/runs/engine/partitions.test.ts:37`<br>assignment order: incomplete before rejected before delivered; only required requirements make an item incomplete<br><br>`hub/runs/engine/partitions.test.ts:99`<br>property: for random runs the partitions are disjoint, cover the item set and follow V05 R[3]<br><br>`hub/runs/engine/partitions.test.ts:142`<br>V05 R[3] by hand: each case written from the rule, not from the code | 条目按终态全覆盖、互斥划入 pass、review、fail、incomplete 四大清单，数学性质已获自动化性质测试保证。 |
| **V06** | 交付规则 | delivery rule | 判定与终态 | 在范围 | **落实** | `hub/runs/engine/partitions.ts` | `hub/runs/engine/partitions.test.ts:37`<br>assignment order: incomplete before rejected before delivered; only required requirements make an item incomplete<br><br>`hub/runs/engine/partitions.test.ts:142`<br>V05 R[3] by hand: each case written from the rule, not from the code | 仅当条目在全部要求项上满足期望且无阻断反驳时，方可进入交付清单（pass），否则进入审查或驳回。 |
| **V07** | 重复策略 | repeat strategy | 判定与终态 | 在范围 | **没落实** | `contracts/generated/vocabulary.ts`<br>`hub/runs/engine/terminals.ts` | `contracts/src/vocabulary.test.ts:14`<br>the model declares 54 axes and the generated AXES lists exactly those, in order | 词表生成了聚合策略轴（all, k_of_n, first_pass），但运行引擎未实现多轮重复执行聚合器与观测分布统计。 |
| **V08** | 假设集 | hypothesis set | 判定与终态 | 不在范围 | **不在范围** | `contracts/model.json` | `contracts/src/vocabulary.test.ts:14`<br>the model declares 54 axes and the generated AXES lists exactly those, in order | 架构第 1 节明确排除假设集与反例回流（hypothesis sets out of scope）。 |
| **W01** | 条目与条目投影 | item & item projection | 工作结构 | 在范围 | **落实** | `contracts/src/pack.ts`<br>`hub/runs/engine/projection.ts` | `hub/runs/engine/projection-source.test.ts:95`<br>two sources with the same node ids: with source, each item resolves in its own source | 任务包的 project 函数将输入源文件（脑图/文档）投影成具稳定 ID、位置与字段的条目集合。 |
| **W02** | 要求项 | requirement | 工作结构 | 在范围 | **落实** | `contracts/src/pack.ts`<br>`hub/runs/packs/validate.ts`<br>`hub/runs/engine/terminals.ts` | `hub/runs/packs/validate.test.ts:63`<br>every check a requirement lists exists, once<br><br>`hub/runs/packs/validate.test.ts:86`<br>a blocking check names its contract clause (C05 R[1])<br><br>`hub/runs/packs/validate.test.ts:390`<br>every check must declare an explicit tier upon publication: missing tier is refused, declaring tier is accepted | 声明静态检查、判断或执行要求，带依据条款、默认档位与覆盖层，发布校验强制要求完整声明。 |
| **W03** | 工作流 | workflow | 工作结构 | 在范围 | **落实** | `contracts/src/pack.ts`<br>`hub/runs/engine/start.ts`<br>`hub/runs/packs/registry.ts` | `hub/runs/engine/start.test.ts:36`<br>a review run: target, sources, items, slots, the frozen record and the action<br><br>`hub/runs/engine/start.test.ts:149`<br>inputs: required slots, unknown slots, accepted types, readable references, whole sources | 绑定要求项模板与产品线，声明输入槽位、上下文需求（builds、leases）与目录需求。 |
| **W04** | 判定形状与判定台账 | verdict shapes & ledger | 工作结构 | 在范围 | **没落实** | `contracts/model.json`<br>`hub/runs/packs/validate.ts` | `hub/runs/packs/validate.test.ts:69`<br>a check's table exists under tables/ or policies/, is JSON and passes the interpreter's admission | 核心代码未建立判定台账；遇到未安装解释器在包发布校验阶段直接拒绝，无法在运行中作为未裁定形状流转。 |
| **W05** | 中间表示与槽位 | IR & slots | 工作结构 | 在范围 | **落实** | `contracts/src/pack.ts`<br>`hub/runs/engine/slots.ts` | `hub/runs/engine/slots.test.ts:89`<br>a valid submission has no structure problems<br><br>`hub/runs/engine/slots.test.ts:192`<br>specificFix renders expected shape dynamically from synthetic slot schema and real commands schema | 任务包声明 slots.schema.json，Hub 在提交前用 JSON 指针和通用 Schema 校验输入形状与动态推导错误提示。 |
| **W06** | 运行 | run | 工作结构 | 在范围 | **落实** | `contracts/src/run.ts`<br>`hub/runs/engine/start.ts`<br>`hub/runs/engine/store.ts` | `hub/runs/engine/start.test.ts:36`<br>a review run: target, sources, items, slots, the frozen record and the action<br><br>`hub/runs/engine/start.test.ts:213`<br>a client key returns the same run inside its window; other content is IDEMPOTENCY_MISMATCH; an expired key starts a new run | start_run 冻结运行目标、要求项、知识根、输入源与租约上下文，存储为 run 记录并保障客户端幂等窗口。 |
| **W07** | 提交 | submission | 工作结构 | 在范围 | **落实** | `contracts/src/submission.ts`<br>`hub/runs/engine/submit.ts`<br>`hub/runs/engine/evaluate.ts` | `hub/runs/engine/submit.test.ts:74`<br>an accepted submission: terminals, satisfaction, attribution, partitions, derived counts<br><br>`hub/runs/engine/submit.test.ts:191`<br>the submission is stored exactly as received, even when it is not accepted | submit_result 接收槽位填充主张，重跑沙箱检查，校验事实与主张，计算终态和分区清单，返回回执。 |
| **W08** | 校验结果 | validation result | 工作结构 | 在范围 | **落实** | `contracts/src/validation.ts`<br>`hub/runs/engine/submit.ts` | `hub/runs/engine/submit.test.ts:457`<br>a submission that does not parse still has its parseable entries checked: every cause comes back at once (W08 R[1])<br><br>`hub/runs/engine/submit.test.ts:308`<br>a not-accepted submission still reports the item-level refutations of its other items with rounds left (W08 R[1]) | 结构校验、事实核验与检查反驳全部汇总于验证结果记录中，一次性完整披露。 |
| **W09** | 触发 | trigger | 工作结构 | 在范围 | **落实** | `hub/knowledge/sync.ts`<br>`hub/runs/engine/start.ts`<br>`contracts/src/product.ts` | `hub/knowledge/sync.test.ts:39`<br>end to end: both families, aliases resolved, own trees of either family, roots coincide by content, current roots<br><br>`hub/knowledge/sync.test.ts:152`<br>a rerun is idempotent: nothing is produced again, no build record repeated, no pointer moved | 进度页决定 9 将常设义务知识同步带入实现，Hub 水平对账已完整落地；偏离：架构第 1 节仍将常设义务列为不在范围。 |
| **W10** | 判据变更声明 | criterion amendment declaration | 工作结构 | 在范围 | **没落实** | `contracts/model.json` | `contracts/src/vocabulary.test.ts:14`<br>the model declares 54 axes and the generated AXES lists exactly those, in order | 核心代码中无判据变更声明通道或第二人确认机制，判据修改目前只能通过发布包新版本全局覆盖。 |
| **P01** | 第 1 步 定目标 | set target | 步骤与管道 | 在范围 | **落实** | `hub/runs/engine/target.ts`<br>`hub/runs/engine/start.ts` | `hub/runs/engine/start.test.ts:36`<br>a review run: target, sources, items, slots, the frozen record and the action | start_run 选择包与绑定参数，锁定目标与要求项。 |
| **P02** | 第 2 步 绑定源文件 | bind source files | 步骤与管道 | 在范围 | **落实** | `hub/runs/engine/inputs.ts`<br>`hub/runs/engine/start.ts` | `hub/runs/engine/start.test.ts:149`<br>inputs: required slots, unknown slots, accepted types, readable references, whole sources | start_run 绑定用户上传的源文件、外部对象以及任务包声明的期望来源。 |
| **P03** | 第 3 步 定判定形状 | define verdict shapes | 步骤与管道 | 在范围 | **落实** | `hub/runs/packs/validate.ts`<br>`hub/runs/engine/slots.ts` | `hub/runs/packs/validate.test.ts:54`<br>the synthetic workflow, product and system packs validate | 任务包声明 checks.json 和 slots.schema.json，确定合规形状。 |
| **P04** | 第 4 步 填槽位 | fill slots | 步骤与管道 | 在范围 | **落实** | `hub/runs/engine/slots.ts`<br>`hub/runs/engine/submit.ts` | `hub/runs/engine/slots.test.ts:107`<br>statements: closed codes and ranks, required when declared, counts, data schema, evidence, the SlotClaim shape | 客户端/模型将判断与事实填入槽位作为 submit_result 参数。 |
| **P05** | 第 5 步 生成 | generate | 步骤与管道 | 在范围 | **部分落实** | `packs/workflow/case-compile/functions/checks.ts` | 无（核心没有这一步，没有测试） | （集成者 10-23 更正，原判“落实”有误）核心没有包级的生成步骤和出件存储：确定性生成器从槽位与引用出件、另一读取器回读、按生成器版本加输入摘要复用，这些都还没有。前六项能力不产出件，用不到；转自动化的编译包先在包内的检查函数里生成执行计划并回读，计划放在结论的 data 里。原判引用的“Hub 不调用判断模型”的测试与这个元素无关。 |
| **P06** | 第 6 步 静态判定 | static verdict | 步骤与管道 | 在范围 | **落实** | `hub/rules/check.ts`<br>`hub/rules/sandbox/sandbox.ts` | `hub/rules/check.test.ts:29`<br>runs the interpreter with the table and keeps the table tier<br><br>`hub/rules/sandbox/sandbox.test.ts:64`<br>returns JSON output, captures stdout, loads declared dependencies, JSON data and pure builtins<br><br>`hub/rules/sandbox/sandbox.test.ts:242`<br>a file write fails and leaves no file | 在隔离沙箱中运行核心 8 种表解释器或包纯函数，计算事实反驳与支持。 |
| **P07** | 第 7 步 动态判定 | dynamic verdict | 步骤与管道 | 不在范围 | **不在范围** | `contracts/model.json` | `hub/runs/engine/terminals.test.ts:238`<br>a requirement incomplete at every declared layer: skipped, not covered, repair or budget used up; otherwise the dynamic layer is not run | 架构第 1 节明确排除动态判定（dynamic layer checks out of scope）。 |
| **P08** | 第 8 步 分区交付 | partitioned delivery | 步骤与管道 | 在范围 | **落实** | `hub/runs/engine/partitions.ts` | `hub/runs/engine/partitions.test.ts:37`<br>assignment order: incomplete before rejected before delivered; only required requirements make an item incomplete | 根据层终态将条目划入交付、反驳、复核、未完成四分区。 |
| **P09** | 第 9 步 反例回流 | counter-example feedback | 步骤与管道 | 不在范围 | **不在范围** | `contracts/model.json` | `contracts/src/vocabulary.test.ts:14`<br>the model declares 54 axes and the generated AXES lists exactly those, in order | 架构第 1 节明确排除假设集与反例回流。 |
| **P10** | 第 10 步 沉淀 | precipitation | 步骤与管道 | 不在范围 | **不在范围** | `contracts/model.json` | `contracts/src/vocabulary.test.ts:14`<br>the model declares 54 axes and the generated AXES lists exactly those, in order | 架构第 1 节明确排除沉淀写候选层（writing candidates out of scope）。 |
| **P11** | 统一管道与两道强制边界 | unified pipeline & two boundaries | 步骤与管道 | 在范围 | **部分落实** | `hub/runs/engine/terminals.ts`<br>`hub/runs/engine/partitions.ts` | `hub/runs/engine/partitions.test.ts:59`<br>hooks for effects, dispositions and abandonment come first (unused in milestone 1) | 交付前边界（终态与分区计算）完全激活；效果前强制边界因排除写效果在当前代码中闲置。 |
| **I01** | 不变量一：精确值与产物 | exact values and artifacts | 三条不变量 | 在范围 | **落实** | `hub/refs/resolve.ts`<br>`hub/runs/engine/exact.ts`<br>`hub/runs/engine/claims.ts` | `hub/refs/resolve.test.ts:74`<br>resolves a mind-map node and checks a quotation against it<br><br>`hub/refs/resolve.test.ts:146`<br>gives the same neutral answer for absent, forbidden, tampered and failing sources | 模型精确值在边界解析成引用；未判定的产物过判定才成交付物；确定性计算（投影/清单）不交由模型完成。 |
| **I02** | 不变量二：事实的来源 | origin of facts | 三条不变量 | 在范围 | **落实** | `contracts/src/claim.ts`<br>`hub/runs/engine/claims.ts`<br>`hub/rules/outcome.ts` | `contracts/src/shapes.test.ts:167`<br>a knowledge entry is never a ground on its own, but stays a reference (B01 R[5])<br><br>`tests/acceptance/22-fact-model-independence.test.ts:112`<br>fact requirements (literal and catalog) produce 100% identical terminals between Model A and Model B | 事实判定溯源到基线或发布记录，无法由无依据判断推导事实，事实模型完全独立。 |
| **I03** | 不变量三：终态不升级 | terminals do not upgrade | 三条不变量 | 在范围 | **落实** | `hub/runs/engine/terminals.ts` | `hub/runs/engine/terminals.test.ts:179`<br>error routing: repair with rounds left and exhaustion, request waits, unknown records unknown, reject keeps the violation<br><br>`hub/runs/engine/terminals.test.ts:208`<br>a row applies by the role the refuting check judges: repair and reject only to the artifact under verification (T03 R[4], W02 F[7]) | 一旦判为不通过/反驳，后续动作只能修复待判定产物，不能推翻事实反驳，终态不升级。 |
| **C01** | 四个家 | four homes: B, C, D, E | 治理与分类 | 在范围 | **落实** | `contracts/generated/vocabulary.ts`<br>`hub/records/README.md`<br>`hub/rules/README.md` | `contracts/src/vocabulary.test.ts:14`<br>the model declares 54 axes and the generated AXES lists exactly those, in order | 四家权属与边界明确（B知识证据、C任务治理、D执行资源、E专业规则，A为运行时，F/G跨切）。 |
| **C02** | 四类归属 | four attributions | 治理与分类 | 在范围 | **落实** | `contracts/generated/vocabulary.ts`<br>`hub/runs/engine/terminals.ts` | `hub/runs/engine/terminals.test.ts:156`<br>attribution only on non-pass terminals that miss the expectation, by rule tables | 归责四类（producer_error、author_input、harness_defect、unattributed）在运行引擎中严格落地。 |
| **C03** | 两种形态与两种可执行插件 | two forms & two plugins | 治理与分类 | 在范围 | **落实** | `hub/rules/check.ts`<br>`hub/rules/sandbox/sandbox.ts`<br>`hub/runs/packs/validate.ts` | `hub/rules/check.test.ts:29`<br>runs the interpreter with the table and keeps the table tier<br><br>`hub/rules/check.test.ts:132`<br>a pack function without a declared tier is not run: check error, the admin log gets the missing tier, no guess | 支持核心内置表解释器与包内纯函数两类插件形式，禁止混用，沙箱与参数绑定严格校验。 |
| **C04** | 表 | tables | 治理与分类 | 在范围 | **落实** | `hub/rules/interpreters/registry.ts`<br>`hub/rules/tables.test.ts` | `hub/rules/tables.test.ts:10`<br>every table kind, the catalog entry and the check outcome are registered as name@major<br><br>`hub/rules/tables.test.ts:28`<br>each table kind has its interpreter, and its schema field names the version<br><br>`hub/rules/tables.test.ts:51`<br>unknown keys are refused (closed schemas, C04 R[0]) | 8 种核心表解释器（exact、prefix、range、set、regex、schema、decimal、catalog）及封闭结构校验完整落实。 |
| **C05** | 规则 | rules | 治理与分类 | 在范围 | **落实** | `hub/rules/check.ts`<br>`hub/runs/packs/validate.ts` | `hub/runs/packs/validate.test.ts:86`<br>a blocking check names its contract clause (C05 R[1])<br><br>`hub/rules/interpreters/interpreters.test.ts:153`<br>every kind: a blocking tier needs the contract clause it relies on (C05 R[1]); without a clause the default tier is advisory | 阻断档检查必须显式声明所依据的验收合同条款（basis，C05 R[1]），发布与运行期均严格校验。 |
| **C06** | 政策表 | policy tables | 治理与分类 | 在范围 | **部分落实** | `contracts/src/pack.ts`<br>`hub/runs/packs/validate.ts` | `hub/runs/packs/validate.test.ts:69`<br>a check's table exists under tables/ or policies/, is JSON and passes the interpreter's admission | 包内 policies 表已支持；全局写效果前政策表因排除写效果而闲置（pending 项 10）。 |
| **C07** | 目录 | catalog | 治理与分类 | 在范围 | **落实** | `contracts/src/pack.ts`<br>`hub/rules/catalog/view.ts`<br>`hub/rules/interpreters/catalog.ts` | `hub/rules/catalog/catalog.test.ts:50`<br>a command that matches its signature is supported, grounded in the entry and the item<br><br>`hub/rules/catalog/catalog.test.ts:64`<br>an out-of-range port is refuted with core.catalog.param_out_of_range | 命令目录定义、分词匹配、参数重载与范围校验（catalog@1 解释器）完整落实。 |
| **C08** | 能力声明 | capability declarations | 治理与分类 | 在范围 | **落实** | `contracts/src/pack.ts`<br>`hub/runs/packs/validate.ts` | `hub/runs/packs/validate.test.ts:54`<br>the synthetic workflow, product and system packs validate | 任务包显式声明能力、目录、槽位与解释器，发布校验逐项审查。 |
| **T01** | 任务包 | task pack | 任务包与校验 | 在范围 | **落实** | `contracts/src/pack.ts`<br>`hub/runs/packs/load.ts`<br>`hub/runs/packs/registry.ts` | `hub/runs/packs/registry.test.ts:26`<br>a user with a publish right publishes: record, objects and a publication bound to the pack digest<br><br>`hub/runs/packs/registry.test.ts:82`<br>a version number is never reused and a published version never changes | 任务包解构规范（pack.json、requirements.json、checks.json 等），包发布与注册完整落实。 |
| **T02** | 发布记录与发布校验 | publication record & validation | 任务包与校验 | 在范围 | **落实** | `hub/runs/packs/validate.ts`<br>`hub/runs/packs/registry.ts` | `hub/runs/packs/registry.test.ts:100`<br>a failing sample or a blocking check without samples refuses the publication and stores nothing<br><br>`hub/runs/packs/validate.test.ts:390`<br>every check must declare an explicit tier upon publication: missing tier is refused, declaring tier is accepted | 静态语法扫描、沙箱样例运行验证、显式 tier 声明校验（checks.tier_missing）完整落实。 |
| **T03** | 边界校验 | boundary validation | 任务包与校验 | 在范围 | **落实** | `hub/rules/sandbox/isolation.ts`<br>`hub/rules/sandbox/sandbox.ts`<br>`hub/runs/packs/validate.ts` | `hub/rules/sandbox/sandbox.test.ts:190`<br>fetch() to a listening loopback server fails and the server sees no connection<br><br>`hub/rules/sandbox/sandbox.test.ts:288`<br>reading outside the pack fails: ../, absolute paths, symbolic links and hard links | 沙箱隔离文件系统越界访问、网络连接尝试，严格实施进程与内存限制。 |
| **T04** | 引用解析 | reference resolution | 任务包与校验 | 在范围 | **落实** | `hub/refs/resolve.ts`<br>`hub/runs/engine/exact.ts` | `hub/refs/resolve.test.ts:128`<br>reports unresolved selectors, unknown parsers, unparseable sources and bad syntax<br><br>`hub/refs/resolve.test.ts:432`<br>turns a parser answer that cannot be written into an unresolved result instead of a rejection | 不限制模型输入形态，而在边界将其输出的精确值解析为引用，无法解析诚信返回 unresolved。 |
| **K01** | 知识树 | knowledge tree | 知识库 | 在范围 | **落实** | `hub/knowledge/tree.ts`<br>`hub/records/pointers.ts`<br>`hub/knowledge/produce.ts` | `hub/knowledge/lines.test.ts:47`<br>a reconciliation that read the pointer while a newer root was made never moves the line back<br><br>`hub/records/pointers.test.ts:21`<br>a pointer is created, moved by compare-and-set, and every move is a move_root action | 树形结构（root -> node -> entry），SHA-256 寻址与比较并交换移动当前根完整落实。 |
| **K02** | 知识条目 | knowledge entry | 知识库 | 在范围 | **落实** | `contracts/src/knowledge.ts`<br>`hub/knowledge/produce.ts` | `hub/knowledge/entries.test.ts:60`<br>only the named producer gives members; the other producer neither adds members nor withdraws complete<br><br>`hub/knowledge/entries.test.ts:111`<br>a kind outside the entry kinds is refused with the kind as declared; every record written reads back | 知识条目种类（entry_kind: 定义、行为、用例、缺陷、观察）及挂接条目数据校验完整落实。 |
| **K03** | 三层写入 | three-layer writing | 知识库 | 在范围 | **部分落实** | `contracts/src/knowledge.ts`<br>`hub/knowledge/layers.ts` | `hub/knowledge/layers.test.ts:50`<br>append only, readable with the product, never in a root digest<br><br>`hub/knowledge/layers.test.ts:75`<br>only the owner's verified candidates: quotation checked, grounds private to the owner, nobody else sees them | 树本身与观察层已实现并可读取；个人候选层写入在架构第 1 节明确排除未开放写入。 |
| **K04** | 知识归类 | knowledge placement | 知识库 | 在范围 | **部分落实** | `hub/knowledge/produce.ts`<br>`hub/knowledge/placement.ts` | `hub/knowledge/placement.test.ts:481`<br>without a placer, the declared and the undeclared path-less entries both stay unplaced at the root<br><br>`hub/knowledge/placement.test.ts:516`<br>the sync report says how many entries stay unplaced at the root, and keeps the per-producer counts as data | 确定性规则归类与未归位存根落实；智能归位服务按决定 15 下线，bot 归位提议通道尚未开通。 |
| **K05** | 本地缓存与获取 | local cache & fetch | 知识库 | 在范围 | **落实** | `hub/knowledge/read.ts`<br>`hub/knowledge/views.ts` | `hub/knowledge/read.test.ts:41`<br>admins and readers with the product read; outsiders, disabled and demoted accounts and unknown roots get null<br><br>`hub/knowledge/read.test.ts:77`<br>pages with cursors, coverage complete only on the last page, the tool shape, missing paths noted | 知识树分面与节点只读缓存，游标分页与深度查询（get_nodes）完整落实。 |
| **D01** | 对接规范 | integration specification | 对接与协议 | 在范围 | **落实** | `hub/connectors/routes.ts`<br>`hub/connectors/read.ts`<br>`hub/connectors/login.ts` | `hub/connectors/routes.test.ts:23`<br>allow-list matrix of the PLM-like profile<br><br>`hub/connectors/routes.test.ts:63`<br>a request must match the route it names | 只读外部连接器白名单路由、URL 安全拼装与凭据保护完整落实。 |
| **D02** | 前提表 | premises table | 对接与协议 | 在范围 | **落实** | `hub/connectors/login.ts`<br>`hub/connectors/read.ts` | `hub/connectors/session.test.ts:231`<br>a source that refuses the login stops it until an admin acts; the cool-down time passing changes nothing<br><br>`hub/connectors/session.test.ts:714`<br>another process waits for a login in flight instead of sending the same password: the refusal stops both, after one attempt | 外部系统会话与登录状态机，失败单次尝试冷却，避免凭据被封锁，前提假设审慎管理。 |
| **D03** | 效果类与写声明 | effect kinds & write declarations | 对接与协议 | 在范围 | **部分落实** | `contracts/model.json`<br>`hub/runs/engine/partitions.ts` | `hub/runs/engine/partitions.test.ts:59`<br>hooks for effects, dispositions and abandonment come first (unused in milestone 1) | 效果类词表与分区钩子已定义，但因里程碑 1 排除写效果，写声明与前状态比较未激活。 |
| **D04** | 效果安全机制 | effect safety mechanisms / leases | 对接与协议 | 在范围 | **落实** | `hub/leases/service.ts`<br>`hub/records/migrations.ts`<br>`contracts/src/pack.ts` | `contracts/src/leases.test.ts:28`<br>D04 R[0] says a booking lease is held by lineage, with a revision note<br><br>`contracts/src/leases.test.ts:131`<br>the lease_op axis holds the five lease operations with D04’s words, and a revision note names the audit<br><br>`hub/leases/service.test.ts:42`<br>a free key set is acquired, with the lease id, the holder, the until moment and token 1<br><br>`hub/leases/service.test.ts:290`<br>every change appends a lease action record; replaying the records rebuilds the table<br><br>`hub/runs/engine/leases-wiring.test.ts:283`<br>a lineage deeper than 20 predecessors is refused | 决定 16/9 引入租约机制，租约服务（原子取得/续租/释放/接管、数据库时钟、单调 fencing token、按血缘 lineage 沿用与 20 层上限）完全落实；偏离：架构第 1 节仍将租约列为不在范围。 |
| **D05** | 调用合约与统一响应 | call contract & uniform response | 对接与协议 | 在范围 | **落实** | `hub/server/mcp.ts`<br>`hub/server/tools.ts`<br>`hub/server/errors.ts` | `hub/server/mcp.test.ts:1020`<br>isError is true exactly for protocol errors and receipts that are not accepted; every answer conforms to its schema<br><br>`hub/server/mcp.test.ts:1083`<br>a thrown error: a registered code becomes its answer, SOURCE_UNAVAILABLE stays neutral, anything else is internal | MCP 标准协议、统一响应结构、封闭错误码表与中性 SOURCE_UNAVAILABLE 返回完整落实。 |
| **D06** | MCP 工具面 | MCP server tool surface | 对接与协议 | 在范围 | **落实** | `hub/server/tools.ts`<br>`contracts/src/tools.ts` | `contracts/src/tools.test.ts:46`<br>tools.json lists exactly the six tools, in the order of TOOLS<br><br>`contracts/src/tools.test.ts:122`<br>annotations in tools.json are exactly the D06 table, with start_run open-world as milestone-1 callers see it | 对外精确暴露 6 个标准 MCP 工具，无 Circle 专有界面，通用协议标准完全落实。 |
| **D07** | 执行器资源 | executor resource | 对接与协议 | 不在范围 | **不在范围** | `contracts/model.json` | `contracts/src/vocabulary.test.ts:14`<br>the model declares 54 axes and the generated AXES lists exactly those, in order | 架构第 1 节明确排除浏览器与设备执行器资源。 |
| **R01** | 权限角色 | permission roles | 权限与角色 | 在范围 | **落实** | `hub/records/principals.ts`<br>`hub/records/authorizations.ts` | `hub/records/authorizations.test.ts:80`<br>only admins decide assignments, publish rights, resource configuration and shares<br><br>`tests/acceptance/06-user-without-pack.test.ts:25`<br>a user without the pack gets SOURCE_UNAVAILABLE ("对你不可用") with empty shape matching a non-existent pack | user 与 admin 角色划分，包使用权与发布权隔离，哈希令牌认证完整落实。 |
| **R02** | 可见性 | visibility | 权限与角色 | 在范围 | **落实** | `hub/records/authorizations.ts`<br>`hub/server/tools.ts`<br>`hub/refs/resolve.ts` | `hub/refs/resolve.test.ts:146`<br>gives the same neutral answer for absent, forbidden, tampered and failing sources<br><br>`hub/runs/engine/submit.test.ts:392`<br>absent and forbidden runs give the same answer | 基于作者、包分配及分享许可的可见性过滤，无权与不存在同形返回中性 SOURCE_UNAVAILABLE。 |
| **R03** | bot（服务端 Circle） | server-side agent runtime | 权限与角色 | 不在范围 | **不在范围** | `contracts/model.json` | `contracts/src/vocabulary.test.ts:14`<br>the model declares 54 axes and the generated AXES lists exactly those, in order | 架构第 1 节明确服务端 bot 运行时不在当前里程碑。 |

---

## 6. 不确定的地方（疑问清单，不作猜测）

复核过程中识别出以下 5 点需要所有者或架构师进一步确认的设计疑问：

1. **无发布记录规格类文档的基线确定（模型 pendingDecisions 项 6 / A03 R[1]）**：当跨运行充当规格类来源的文档本身没有产品发布记录或设备回显时，当前实现默认回退到运行锁定的构建根。未来是否需要要求管理员对这些规格文档下发显式的基线授权记录（B04）？
2. **条目合取投影次序（模型 pendingDecisions 项 19 / V03 R[3]）**：当前代码实现的条目级合取投影次序为 `不通过 > 未完成 > 未核对 > 判断 > 通过`。在动态层缺省为“不适用”或“未运行”时，该次序是否确认为最终标准？
3. **判据变更声明（W10）的后续排期**：下一个里程碑（如自动化测试执行或用例维护）是否需要引入 W10 判据变更声明机制，还是继续保持“判据修改必须通过任务包发布新版本”的刚性约束？
4. **个人候选层对管理员的展示精度（模型 pendingDecisions 项 12 / R02）**：未来开放个人候选层写入后，管理员运行记录中是否严格限制为仅显示“候选写入条数与摘要”，而对正文保持完全不可见？
5. **全局边界政策表的部署形态（模型 pendingDecisions 项 10 / C06）**：后续里程碑引入写效果与安全机制时，全局边界政策表是随 Hub 核心发布（硬编码/内置代码包），还是作为管理员在数据库中配置的资源数据？
