# P1 契约与样本冻结计划 V1

日期：2026-10-10。

状态：**已完成（P1 门禁于 2026-10-10 经用户裁定通过，P1 收口，见 ADR 0010）。** 第一阶段三份收口文档与 [ADR 0006](decisions/0006-phase1-design-closure.md) 已于 2026-10-10 经用户接受为基线；本计划第 4、5 节的选项已于同日定案：OPEN-01 选 A（[ADR 0007](decisions/0007-wire-and-tasks-baseline.md)），OPEN-05 以 XMind 候选推进（[ADR 0008](decisions/0008-mindmap-and-excel-scope.md)）。P1-2 已于同日完成：`packages/contracts` 落地并通过本地类型检查与 26 项契约测试，证据见 [P1-2 冻结记录](p1-2-freeze-record.md)。P1-3 已于同日完成：三路对拍与注入向量 11 个场景全部通过（桩级），证据见 [P1-3 记录](p1-3-pairing-record.md)；该步新发现的 OPEN-09 已于同日定案（[ADR 0009](decisions/0009-cancelled-status.md)：增补 `cancelled`，契约升 v1.1，回归全过）。P1-4 已完成：14 份样本已制备并于 2026-10-10 经用户核验通过、全部冻结（见 [P1-4 记录](p1-4-samples-record.md)）。P1-5 已于同日完成：Excel 输出契约与脑图格式范围 V1 结构层冻结（版本范围延后已明示）。P1-6 已完成：用户于 2026-10-10 裁定门禁通过，P1 收口（ADR 0010）。下一步为 P2 启动（需用户单独发令；P2 启动议题含 OPEN-02/03/04 定案）。业务实现与真实样本仍未产生。

依据：[共同契约 V1](common-contracts-v1.md)、[五条链验收方案 V1](five-chain-acceptance-v1.md)、[验证矩阵与实施顺序 V1](validation-matrix-v1.md)。

## 1. P1 的范围与非范围

P1 只做两类事：**冻结契约层**（F 的词表、信封与 schema 骨架，仅契约、无业务逻辑）与**冻结样本**（五条链的样本清单与合成样本、标注预期）。做完 P1，系统仍不能回答问题、不能操作设备、不能登录 Web——那些是 P2 的纵向链。

| 做 | 不做 |
|---|---|
| 状态/错误词表冻结版、信封与 BindingSet 的 TS schema（类型 + 运行时校验） | B/C/D/E 的业务实现、数据库与队列选型落地 |
| MCP/CLI/HTTP 三路对同一 schema 的协议对拍用例（L1 的协议部分） | 连接 APV 设备、登录真实产品 Web、使用真实凭据 |
| 五条链合成样本的制备与人工核验记录、脱敏真实样本的授权与固定流程 | 把真实业务资料、原始脑图、真实用例集提交进本仓库 |
| Excel 输出契约与脑图格式范围的定案（需获准样本支撑） | 语义模型选型与阈值（OPEN-04，P3）、APV/Web 专用环境（OPEN-06/07，P4） |

## 2. 冻结对象清单（FZ）

以下词表直接源自已接受的共同契约，P1 的任务是把它们落成版本化 schema 与对拍用例，而不是重新设计。冻结后变更走纠正记录 + 版本号递增，不原地改义。

| 编号 | 冻结对象 | 来源条款 | P1 产出 |
|---|---|---|---|
| FZ-01 | `ResponseStatus` 八值：accepted / running / succeeded / failed / unknown / partial / not-run / cancel-requested，及三路传输（含 CLI 退出码）的映射表 | COM-02/06 | 枚举 schema + 映射表 + 对拍用例 |
| FZ-02 | 任务阶段词表与操作状态词表（含取消四段子状态），及两者的允许迁移与禁止迁移 | STATE、RC-04 | 状态机 schema + 迁移测试向量 |
| FZ-03 | 结构化错误：category 八类（validation / permission / conflict-stale / lease / target / transient / semantic-insufficient / internal）与首批 code 表（每类 2–5 个起步 code，含 retryable 默认值与 userAction 要求） | STATE-01、RC-02 | 错误 schema + code 表 + 注入用例 |
| FZ-04 | Request/Response 信封字段与必填规则（含 requestId、idempotencyKey 作用域） | COM、RC-01 | 信封 schema + 非法 payload 注入用例 |
| FZ-05 | `BindingSet` 字段与闭包规则（原件 hash、sourceRevision、snapshot、产品/固件、pack 版本、目标修订、样本身份、harness 审计信息） | BIND-01–04 | BindingSet schema + 失效/错配用例 |
| FZ-06 | `EffectDescriptor` 六维字段与分级准入映射（只读采集 / 普通变更 / 不可逆单独准入） | EFF-01–03、AUTH-05 | 效果 schema + 声明与实际不符的对拍用例 |
| FZ-07 | 身份字段格式：principal/tenant/scope/task/run/inputRevision/operation/attempt/resource/lease+fencing/evidence/artifact/snapshot/pack 的 ID 格式与引用规则 | 契约第 2 节 | ID schema + 跨空间混用拒绝用例 |
| FZ-08 | `VerificationRecord` 与 `AssessmentRecord` 的最小字段集与完成清单（VER-03）的通用骨架 | VER-01–03 | 双轨记录 schema + R08 伪造注入用例骨架 |
| FZ-09 | `PendingInput` 结构（requestId、绑定修订、决定类型、过期与冲突规则）与敏感输入通道的隔离标记 | HUM-01–04 | PendingInput schema + 迟到/冲突用例 |

## 3. 契约包结构（提案）

单仓内的候选组织（目录名为提案，P1 启动时以一个短 ADR 定死，不在本文件冻结）：

```text
packages/contracts/     # F：schema 单一事实源、生成的 TS 类型与运行时校验、词表与版本
packages/client/        # F：三路传输共用的 TS 客户端（MCP/CLI/HTTP 只是传输实现）
fixtures/               # G：协议对拍向量、状态迁移向量、注入向量（与样本分开）
samples/                # G：五条链合成样本的清单与核验记录；样本原件按第 6 节规则存放
```

原则：schema 是单一事实源，类型、校验器、文档与对拍向量都从它生成或对它校验，禁止三路传输各写一份字段定义（契约 COM-06、HAND-01）。包版本与契约版本一一对应；具体 TS 工具链（校验库、生成方式、包管理器）为 P1 启动议题，只要求满足“运行时校验真实存在、不能只靠静态类型”这一已接受约束，在此不预选。

## 4. 定案一：OPEN-01（wire 与 Tasks 扩展）——已选 A，见 ADR 0007

需要在 P1 启动前定案，否则 FZ-01/04 无法落到具体传输。

| 选项 | 内容 | 代价与风险 |
|---|---|---|
| A（建议）最低基线 + 增强可选 | 基线只依赖普通 MCP tools 与 CLI 长任务五调用（submit/status/result/input/cancel）；支持 Tasks 扩展、resources/媒体的 harness 走增强路径并标注。HTTP 与 MCP/CLI 共用同一信封语义 | 与已接受的三档兼容（HAND-01）一致，三 harness 都能过最低线；需维护映射与降级标注 |
| B 要求 Tasks 扩展 | 把 MCP Tasks 作为长任务的必需机制，不支持的 harness 不接入 | 与最低兼容基线冲突，可能直接排除某个目标 harness；把平台语义绑到单一扩展的成熟度上 |
| C 仅 HTTP | 放弃 MCP 作为业务面，只保留 HTTP + CLI | harness 集成成本转嫁到每个适配器，且与既有 MCP 生态脱节 |

建议选 A。无论选哪项，都需同时冻结：MCP 官方版本基线、错误码与 FZ-03 的映射、CLI 的 JSON/退出码规则。此定案记入新 ADR 后，FZ 组才能开工。

## 5. 定案二：OPEN-05（Excel 输出契约与脑图格式）——以 XMind 候选推进，见 ADR 0008

需要在样本冻结前定案，定案依据是获准样本，而不是旧项目的默认格式。

1. 脑图格式：候选为 XMind 原文件的一个明确版本范围（建议）。FreeMind/MM 与 OPML 只作为转换输入候选，不承诺为原生支持；图片脑图明确不在 V05 范围。定案前需取得至少一份获准的真实格式样本做解析探针（只读探针属 P1 样本工作，不算业务实现）。
2. Excel 输出契约：以获准样本 + 人工确认的目标工作簿结构为准，冻结表头集合、工作表划分规则、单元格类型与空值/长文本规则。旧 Excel 约定只作为候选清单供确认，不自动成为契约。
3. 若获准样本一时不可得，降级方案：先以合成 XMind 样本冻结结构层契约（节点/IR/映射），输出契约的业务字段部分标为延后，不阻塞其余四链样本。

## 6. 五条链样本清单（SMP，制备要求）

样本分级与回执规则沿用验收方案 ACC-G04。合成样本可入验证资产；脱敏真实样本只登记身份、hash 与存放位置，不入本仓库。每份样本在制备后都要有一条人工核验记录（核验人、日期、核对了什么），没有核验记录的样本不算冻结。

| 样本 ID | 链 | 内容（合成起步） | 覆盖的验收条目 |
|---|---|---|---|
| SMP-V01-01 | V01 | 多版本合成产品资料：同一功能两版本结论不同，含 CLI 与 Web 方法 | V01-A01/A02 |
| SMP-V01-02 | V01 | 冲突集 + 撤回来源集 | V01-A03 |
| SMP-V01-03 | V01 | 无答案集 + 误导集（正文不支持常见结论、同名不同产品） | V01-A04/A06 |
| SMP-V01-04 | V01 | 越权集（答案只存在于另一 scope） | V01-A05 |
| SMP-V02-01 | V02 | 本地协议 fixture 规格：可注入断连、长输出、CRLF/分页/prompt 变体、回执丢失的 SSH/HTTP 模拟端规格（仅规格，实现属 P2） | V02-A02/A05/A06 |
| SMP-V02-02 | V02 | 场景脚本集：身份不符、只读采集、受控变更、抢占与过期 fencing、取消残留 | V02-A01/A03/A04/A07/A08 |
| SMP-V03-01 | V03 | 本地测试站点规格：登录、受保护页、动态按钮、iframe/弹窗、下载、会话过期、权限分级、视觉有意义页面（仅规格，实现属 P2） | V03-A01/A02/A06/A08 |
| SMP-V03-02 | V03 | 隔离与凭据场景集：双账号 Cookie 串用注入、错误密码、MFA 等待 | V03-A02/A03/A04/A07 |
| SMP-V04-01 | V04 | 正确用例集（多协议/算法/形态各至少一例，人工确认） | V04-A01/A06 |
| SMP-V04-02 | V04 | 注入缺陷集（八类缺陷各至少一例，含人工标注的预期 finding）及其修订集 | V04-A02/A03/A04/A08 |
| SMP-V05-01 | V05 | 脑图内容样本：多 sheet 预期、深嵌套、中文、笔记、关联、附件引用、重复 ID、含混语义 | V05-A01/A02/A05/A06 |
| SMP-V05-02 | V05 | 与 SMP-V05-01 对应的预期工作簿结构说明（人工确认版） | V05-A04 |
| SMP-X-01 | 横切 | R01–R08 的场景卡片集（每项一卡：前置、注入、预期状态、证据要求） | R01–R08 |

## 7. P1 工作顺序与门禁

| 步骤 | 工作 | 完成判据 |
|---|---|---|
| P1-1（已完成，2026-10-10） | 定案 OPEN-01 与 OPEN-05（第 4、5 节），各记一个 ADR；OPEN-02/03/08 在 P1 只登记延后与理由，不强行定案 | 已满足：ADR 0007/0008 已提交；共同契约第 16 节已同步；其余 OPEN 处置见第 8 节 |
| P1-2（已完成，2026-10-10） | 落 FZ-01–09 的 schema 与词表冻结版（契约层代码，无业务逻辑） | 已满足于 schema 层：类型检查与 26 项契约测试通过，版本与生成规则见 [P1-2 冻结记录](p1-2-freeze-record.md)；“三路对拍用例可加载”属 P1-3，未执行 |
| P1-3（已完成，2026-10-10） | 协议对拍与注入向量可运行（L1 的协议部分） | 已满足于桩级：11 个场景 × 三路信封深相等全部通过，失败与缺口（含新登记的 OPEN-09）处置见 [P1-3 记录](p1-3-pairing-record.md) |
| P1-4（已完成，2026-10-10） | 按 SMP 清单制备合成样本并完成人工核验记录；脱敏真实样本完成授权与固定流程登记 | 已满足：14 份样本均有身份与 SHA-256 并登记于 `samples/registry.json`，且已于 2026-10-10 经用户整批核验通过、状态 frozen（证据见 [P1-4 记录](p1-4-samples-record.md)）；脱敏真实样本未引入（无获准样本，登记流程待真实样本出现时启用，如实记为缺项） |
| P1-5（已完成，2026-10-10） | 冻结 Excel 输出契约与脑图格式范围文档（依赖 P1-1 与样本探针） | 已满足于结构层：[Excel 输出契约与脑图格式范围 V1](excel-mindmap-contract-v1.md) 已对照冻结样本 SMP-V05-01/02 冻结；样本探针未做（无获准真实样本），XMind 版本范围与二进制验证按该契约第 5 节明确延后，不冒充已确认 |
| P1-6（已完成，2026-10-10） | P1 收口：更新验证矩阵状态（L1 协议部分与样本就绪如实标注）、形成 ADR 并同步议程 | 已满足：[P1 收口评审](p1-closing-review.md) 与 ADR 0010 终稿在库，用户于 2026-10-10 裁定门禁通过，P1 收口；L1 记为通过（限契约与协议层） |

## 8. 其余 OPEN 在 P1 的处置

| 编号 | P1 处置 |
|---|---|
| OPEN-02 幂等窗口/租约参数 | 延后至 P2 以故障实验数据定案；P1 只冻结“必须有窗口与租约语义”的结构字段 |
| OPEN-03 tenant/scope 划分 | 延后，需用户按实际组织方式决定；P1 schema 中 scope 只留不透明 ID，不预设划分 |
| OPEN-04 语义模型与阈值 | 延后至 P3；P1 只冻结 AssessmentRecord 结构 |
| OPEN-06 APV 专用环境 | 延后至 P4 单独授权；P1 只备 fixture 规格 |
| OPEN-07 Web 目标与 MFA 通道 | 延后至 P3/P4；P1 只备站点规格与场景集 |
| OPEN-08 各链完成清单构成 | 随 P1-2/P1-4 逐链起草，P2 启动前冻结 |

## 9. 未验证声明

本计划本身未执行任何 P1 工作：没有 schema 工程、没有对拍运行、没有样本文件。文中建议（选项 A、格式候选、目录组织）均为待评审提案，不因写入本文件而生效；生效以评审与对应 ADR 为准。

---

相关文档：[共同契约](common-contracts-v1.md) · [五条链验收方案](five-chain-acceptance-v1.md) · [验证矩阵与实施顺序](validation-matrix-v1.md) · [ADR 0006](decisions/0006-phase1-design-closure.md)
