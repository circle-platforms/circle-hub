# 名下项目能力盘点与归属裁决

日期：2026-10-10。

状态：本轮完成的静态调研与职责基线。来源是固定提交的代码、注册表、接口声明和文档；没有运行旧项目、模型、设备、云文档写入或部署。

本轮“五类对象”指原架构中的五类建设对象，不是知识库 V1 的六类核心记录。完整职责见[运行对象 V1](../object-boundaries-v1.md)与 [ADR 0004](../decisions/0004-runtime-object-boundaries.md)。

## 1. 结论

五类可以继续作为运行职责，但需要重新划分：

- A：入口与 Agent 运行。Circle 是已有候选实现，可由 Pi/OpenCode 等替换，Web/企微等也是入口；局部会话不是长期业务任务。
- B：产品知识、证据与制品。接知识库 V1、资料与版本、产物/链接、经验和检索。
- C：任务与协作治理。目标、阶段、身份、权限政策、人工决定、交接、完成准入与审计。
- D：操作执行与资源。设备、浏览器、工作区、外部系统、实际进程、连接、租约和执行回执。
- E：能力包与业务规则。Skills、专业算法、编译、测试判据、业务流程模板、报告内容和产品适配规则。

F（共享契约/基础库）与 G（验证/评测/实验）单列为横切工程。原“平台服务”分清 B/C；原“共享契约与评测工程”拆开而且退出运行对象层。

这是职责与状态划分，不要求立即部署五个或七个独立服务。现有宏工具可作为 facade，内部职责必须有明确所有者。

## 2. 仓库范围与固定基线

GitHub 查询 owner 为 qingshanfeihu，返回 13 个非 fork 仓库；全部默认分支文件树完整返回，未截断。四个主要业务项目和设计仓库的本地 HEAD 与对应远端提交一致，调查开始时主工作树干净。

| 仓库 | 基线短 SHA | 观察与范围决定 |
|---|---|---|
| circle | f7ac6b0 | 主线 TS harness；保留，主要归 A，契约 F 与回归 G |
| circle-next | 5661f07 | 已归档；抽查 runtime/tools/extensions/jobs，仅作 A 的行为参考 |
| InfoTest_Engine | 88c5bdba | 综合系统跨 A–E，不能整体归为 skill 或设备 server |
| compile-excel-skills | 52d6b73 | 能力/客户端/适配/引擎副本跨 A–F，逐项 TS 重写 |
| compile-excel-server | d49da84 | 资料 B、身份 C、网关 D、规则 E、契约 F 和测试 G 混在同仓 |
| infosec-platform | 3c830ff | 本轮开始时的设计基线，尚无业务实现 |
| ist-research | 3fa9fd7 | 数学复算、实验臂、论文程序归 G；运行臂依赖历史工具，不能默认当前可运行 |
| SLBTestAgent | d19f35b | 只有两行 README，没有发现工具或 MCP 实现；保留为占位来源 |
| iota-monitor | b5fa706 | Swift 训练/收益监控，本平台业务范围外；仅参考观测降级、历史和自测方法 |
| game1 | 54a934a | Pygame 游戏/模拟程序，本平台范围外 |
| hello-world | f84bfd1 | 只有 README，无平台功能 |
| qingshanfeihu | c4f36dd | GitHub profile README，无平台功能 |
| -qingshanfeihu-.github.io | e8d7055 | 只有 README，无平台功能 |

完整 SHA、归档/私有状态和链接见结构化清单。没有访问原始业务语料内容、凭据配置或动态部署配置。调查中的私有代码缓存不入 Git。

## 3. 盘点产物与检查

- [CSV：逐项归属](inventory/capability-catalog.csv)
- [JSON：来源与分类](inventory/capability-catalog.json)
- [校验回执](inventory/validation-receipt.json)

共 403 条记录：249 个工具/接口声明、45 个 skill 定义位置、109 个 hooks/模块/脚本/参考单元。

249 个声明包含：InfoTest 的 83 处 agent tool 定义、18 个设备 MCP 工具（两套）、65 个 HTTP 与 1 个 WebSocket 端点；compile skill 的 30 个工具；compile server 的 19 个 HTTP 与 11 个 gateway MCP 工具；Circle 的 22 个原生工具声明。

注意：条件分支可以重复定义同名工具，skill 有 .claude/.agents 镜像，注册表存在按角色/环境过滤，Circle 的部分工具按 hooks 条件构造。因此这些数是声明位置数，不是唯一功能数，更不是某个运行中的 agent 已加载的工具数。

211 个被引用来源文件的实际字节计算 Git blob SHA，与固定提交树逐项相符；403 个记录 ID 无重复，来源路径/行号和主归属检查无失败。回执记录了清单 SHA-256、来源 SHA 和未运行的验证层。

### 主归属统计

| 归属 | 记录数 |
|---|---:|
| A 入口/Agent 运行 | 87 |
| B 知识/证据/制品 | 43 |
| C 任务/协作治理 | 83 |
| D 操作/资源 | 63 |
| E 能力包/规则 | 78 |
| F 共享契约 | 7 |
| G 评测/实验 | 38 |
| X 范围外参考 | 4 |

104 条标记为需要拆职责或明确跨对象契约，表示设计处理建议，不表示已复现 104 个 bug，也不代表需要 104 个服务。

## 4. 各类主要能力的去向

### InfoTest

| 能力 | 归属与处理 |
|---|---|
| fs_*、run_shell/run_python、ask_user、技能加载与动态角色 | A；远端长期操作接口另走 C/D |
| actor、mailbox、编译图、svc_*、人工响应与交付收口 | C 的流程/状态，专业步骤 E，实际执行 D，资料/证据 B |
| KMS、catalog、footprint、SPEC、先例、缺陷检索 | B；来源连接 D，专业解析/约束 E |
| dev_ssh/dev_rest/dev_run_*/probe/help/init | D；授权政策 C，规则 E，证据 B |
| 编译 IR/块展开/工作簿/判据/数学核验/领域回放 | E；不是通用 harness 内核，也不属于纯离线评测 |
| 会话 checkpoint、项目/个人工作记忆 | A 的上下文；产品知识沉淀 B、身份范围 C 分开 |
| Web Terminal、企微输入输出 | A；账号/政策 C，附件/制品 B，外部文档执行 D |
| 审计 viewer 与 sinks | A 视图、C 审计、A/D 事件生产、B 引用证据 |
| TypeSafe 客户端和通用 judgment tool | F/A；SPEC/缺陷语义问题归 B，专业判断模板 E |

### compile skill

| 工具组 | 去向 |
|---|---|
| cex_init/status | A 的本地绑定视图，消费 C 的组织配置和 B 的快照 |
| cex_login_*/logout/client_config | C，A 做薄接入；门户扫码连接器 D，不复制平台账号体系 |
| cex_sync/docs_query/lang_query | B 提供资料与身份；本地缓存作用 A；语言规范 E |
| cex_cmd_check/scan_destructive | E 的结构/领域判据，依据 B，执行时 C/D 强制消费 |
| cex_bed_*/env_prepare/case_*/probe/init | D 的资源/操作/结果，C 的任务与授权，B 的证据 |
| cex_bug_get | D 获取、E 解析、B 来源修订、C 授权 |
| recompose/author/criterion 工具与 compile-excel skill | E 的专业逻辑，阶段状态 C、产物 B、worker D |
| MCP proxy、tool_specs、适配器生成 | F 契约与薄协议；Circle 接入 A；各工具仍按业务去向拆分 |

### compile server/gateway

- registry、文档查询、按构建发布、清单与 blobs：B。
- OAuth、账号、scope、组织配置：C；授权界面 A。
- 租约、runner、现场拓扑、串口初始化、结果库、GC：D。
- 上机前检查在 D 强制执行；产品规则由 E 提供。
- 知识生成链的输入与产物归 B，生成规则 E，调度/执行 C/D。
- 部署工具、状态清理、实际执行审计不应塞进 skill 说明。部署动作 D，政策 C，回归 G。

### Circle 与归档 Circle-next

Circle 原有会话、上下文、模型恢复、文件/执行/LSP、MCP/扩展、TUI/RPC、局部 jobs 保留为 A。平台任务 C 和远端操作 D 通过共用 F 契约接入，不修改其数据含义来冒充永久任务。

扩展中的普通事件回调与可阻断 middleware 不同；特定 tool 的 MCP 暴露和 local read effect 都不能替代 B/D 的实际业务检查。归档 Circle-next 不再成为另一个活跃 harness。

## 5. 不明确或易混淆边界的具体裁决

| 例子与源码 | 观察 | 本轮决定 |
|---|---|---|
| tools/device/authoring_services.py 的 svc_* | 名在 device 下，实际有阶段状态、锁、收口与专业步骤 | C 的任务 facade + E/D/B；按目录整体搬迁会延续混合职责 |
| dev_batch_analysis（batch_analysis_tool.py:95） | 只读已落盘事实、结果和已提交归因，不重跑也不重判 | C 的任务结果视图，消费 B/E，不归 D 的现场执行 |
| cex_bed_topology（bed.py） | 声明只读，却写工作区拓扑/服务缓存 | 效果按目标/缓存/资源分维；D 采集、B 存证据、A 客户端缓存 |
| gateway case_results 与 client cex_case_results | 网关读取结果，客户端又写收据 | 两个端的效果不同，不能把同名功能压成单一只读 bool |
| actor 与 loader/fork、编译图 | 会话派发与长期流程存在不同治理路径 | C 管协调与目标，A 管实际模型回合，D 管外部动作；用不同 ID/state |
| report_to_doc | 专业报告、云文档写入、去重注册、任务关联并存 | E/D/B/C 内部分责，一个用户 facade 可以保留 |
| qa_file_server | 一个工具包含列出/上传/保存/删除/下载等不同动作 | 操作级作用描述，D 传输/操作，B 制品与来源，C 权限 |
| remember/L1/L3 与 footprint | 个人上下文、工作教训、产品声明和运行观察混合风险 | A 私有上下文、B 产品知识、C 共享范围分别决定 |
| ide_validate、机械提交检查、rework_gate | 是生产工作流上的验证 | E/C/D 按规则职责持有；G 测试这些机制，不替代运行检查 |
| typesafe_judge、Jev SPEC/缺陷建议 | 通用推理接口与具体语义用途不同 | A/F 共用调用，B/E 定义问题，模型建议不签发事实或权限 |
| 三套设备 MCP | raw SSH/REST/session、旧 stdio 框架服务、gateway 服务不同 | 收敛 D 的操作契约，保留专业策略 E 和治理 C；不按旧服务器复制三个权威 |
| ist-research/run_onmachine_rq23.py | 实验脚本用关键词粗分类失败 | G 的实验标签不能直接成为生产因果归属；需证据/状态/规则与判断分开 |
| /api/conv-v2/.../test-push-events | 测试/诊断事件注入端点 | G 的诊断面，与 A 的正常生产交互分开 |
| release workflow | 发布的是工具项目本身 | 作为 G/工程发布参考，不能当作网络产品完整发布维护能力 |

这些是静态源码足以确认的职责或定义差异。没有通过本轮实验复现运行缺陷，不能据此推断所有部署都存在相同问题。

## 6. 尚缺的能力应放在哪里

| 未看到完整实现的能力 | 建议位置 |
|---|---|
| 全产品知识关系，包括架构/代码/型号/商务/报价/友商 | B 的模型与索引、E 的专业方法、D 的来源连接 |
| 跨会话/入口的长期目标、任务交接、统一完成准入 | C，与 A/D 显式区分生命周期 |
| 真正的多模态浏览器操作、持久浏览器资源、稳定动作程序化 | D 的 browser worker、E 的操作程序、B 的证据、A 的接管 |
| 产品需求到代码/测试/构建的工程关联 | B 关联、C 工作流、E 方法、D Git/CI 连接器 |
| 网络产品发布、升级、回退及版本维护 | E 策略、C 准入、D 真实发布操作、B 制品/结果 |
| 通用上下文/操作/证据/错误/版本协议 | F，共用 schema；权威数据仍由 A–E 持有 |

“未看到”限定为这次固定源代码和接口扫描。第三方服务、运行时 extraTools、用户配置 MCP、未提交候选和主机外的部署不能由本清单证明不存在。

## 7. 候选工作树与部署雏形

先前讨论已读取 compile skill review/generic-fixes、server evidence-fixes 的未提交实现，它们涉及证据复核、原始换行、执行历史、结果充分性和报告。本轮以 GitHub 默认分支固定提交为正式计数，不把候选当成已发布能力。

前次 SSH 只读发现的文件管理服务与知识分发雏形不在这 13 个仓库的当前树内，参考[主机盘点](knowledge-inventory.md)。原件/索引 B，界面 A，身份 C，外部传输 D；本轮没有再次登录或重新验证其运行状态。

## 8. 重写与实现次序

保留 Circle。相关非 Circle 自研代码按职责全 TS 新建，旧 Python 仅作经验/数据/行为参考。独立的、与本平台无关的项目不纳入本次重写目标。

建议下一项先定 F 的 context/identity、operation/effects、receipt/error 和 evidence references；用户随后指定至少知识问答、APV 操作、Web 登录、用例评审、人工脑图→Excel 五条链，并强调可替换 harness。具体见[适配计划](../harness-adaptation-plan.md)和[验证计划](../foundation-validation-plan.md)。知识库 V1 不重开选型；本轮仅发布计划，不开始实现。

## 9. 完整性与限制

本轮覆盖全部 owner 仓库清单、所有固定文件树、扫描规则可识别的相关工具/HTTP/WS声明、skill 定义位置及主要业务模块。没有逐个审阅全部 4,945 个 InfoTest 文件中的每个 helper、测试、历史报告或业务语料。

依赖框架注入的 write_todos/task、兼容别名和动态工具要通过 A/F 的 registry 契约表达；不能把显示词典视作真实加载表。本轮没有启动运行态 registry 或探测已配置第三方 MCP。

文件哈希/记录校验只证明本次来源与分类清单完整、自洽，不证明程序运行正确或所有建议已经实施。后续每项迁移需要真实效果与边界验收。
