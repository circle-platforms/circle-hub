# 任务：编译地址用途和派发安全来自结构合约

依据：

- 所有者 2026-10-24 的规矩：所有者 2026-10-24 的规矩：编译、评审等过程中，不用关键词表、词典、同义词表、前缀表、自由文本正则或模糊文字启发式做检查、判断、分类、抽取。优先按权威来源真实结构解析并精确核身份；其次校验作者显式闭集字段；语义交客户端模型主张并逐字引用，由 Hub 核引用存在和路径，独立复核补召回。标识符按声明语法解析时必须给语法出处。
- 集成者（模型负责人）2026-10-24 口径 R5、R4、R9、R10；来源与摘要身份见 [整改总纲](kw-overview.md)。这是新规对历史任务页的限定，不能沿用旧关键词验收。
- 模型：`node tools/show-element.ts D03 D04 D07 C07 W02 W05 B05 B06 A06`；要求项从本页列出的包 `requirements.json` 核对。
- 普查证据（行号冻结在总纲的基线；实施前对分派 tip 重定位，保留条目号）：

- A73：`packs/workflow/case-compile/functions/addresses.ts:20`；检查：剥引号/转义并正规化后按拒绝词的文字边界禁止命令。
- A74：`packs/workflow/case-compile/functions/addresses.ts:34`；分类：相邻地址和空白推断掩码；同网段 network/broadcast 也被排除出主机计数。
- A75：`packs/workflow/case-compile/functions/addresses.ts:50`；检查/分类：裸数字大小和 0.x 特例决定是否为歧义 IPv4。
- A78：`scripts/real/gold/compile-check.ts:587`；检查：按原因句前缀把台架外失败改 unknown。
- C06：`packs/workflow/case-compile/functions/profile.ts:45`；解析标识符：autoid：冻结 runtime-profile@1 的 workbook.autoid_pattern，必须 ^/$ 锚定、限 200 字符；出处同函数校验及 runtime-profile-format。
- D01：`packs/workflow/case-compile/functions/runtime-contract.ts:37`；结构解析/精确核验：runtime-contract-format.json 闭集、digest、object/method/signature 原名解析。
- D02：`packs/workflow/case-compile/functions/profile.ts:78`；结构解析/精确核验：dispatch-roles/runtime-profile-format 的 dispatch/parameter_roles 精确匹配；seats/hosts/allowed 依合约身份绑定。
- D03：`packs/workflow/case-compile/functions/binding.ts:20`；结构解析/精确核验：按真实签名参数原名和 kind 绑定 args/keywords，不是语义关键词。
- D04：`packs/workflow/case-compile/functions/binding.ts:57`；结构解析/精确核验：显式引号/转义状态机解析声明的 POSIX 子集，语法外不支持；与 deniedCommand 文字表分开。
- D05：`packs/workflow/case-compile/functions/g-syntax.ts:3`；结构解析/精确核验：G 单元格声明 grammar 的引号、等号、位置/关键字参数和 ASCII wait；出处 workbook-format/runtime-profile 和同文件规则。
- D07：`packs/workflow/case-compile/functions/workbook.ts:89`；结构解析/精确核验：xlsx 原字节独立回读，逐格原名和参数比对槽位；不是同义/文字分类。

- 分支和工作树：待集成者从合入模型前置项后的 `hub-redesign` 开 `kw-typed-addresses`，目录 `circle-hub-kw-typed-addresses`；本次只编写任务页的分支是 `keyword-remediation-pages`，目录 `circle-hub-keyword-pages`。
- 可以改的路径（实施分支）：`packs/workflow/case-compile/**`；不改 hub/、contracts/、执行网关、真实合约和部署配置。gold/compile-check 交 R9；跨核心合约能力由集成者补齐后接 api.ts。
- 规则：本页是待分派的实施任务，不是本次文档分支已经实现的能力。实施者只在下列范围改动，模型和共享契约先由集成者另行提交。只用合成资源、脚本化模型；不碰 7420、钥匙串、环境配置文件、真实数据、设备和任何真实系统。不推送、不建 PR、不发布、不部署；不改 Circle、foundation/circle、references。显式路径暂存、`git commit -s`。未知必须给 missing 和出口（动作、具名受众、期限），不能停在未知，也不能转成支持或反驳。

## 集成者先做：模型与词表

基线词表已核对：`nature` 有 `fact/judgment/unknown`；`static_terminal` 有 `unchecked`；`reason` 有 `missing_input/not_covered/check_error`；`qualifier_mark` 有 `semantics_unasserted/conditional_on_judgment/partial/independence_declared`；`exit_action` 已有补证出口。不存在“未分类”“未判断”“类型未声明”“旧规则（关键词）”“可能含凭据”这些精确词表值；不能用相近值暗中充当同一状态，也不增加新终态。

集成者先做 M5（依赖 M4）：D07/W05 的原合约 schema 要有参数类型/用途、声明出处和效果身份；现有签名 kind/required 不等于类型，CatalogParam.address_role 当前也只是非空 string，不能冒充全局闭集。角色/类型闭集由模型定并生成；“类型未声明”当前无词表值，统一与 M4 的未核对/阻派发语义。派发 release 不接受 unchecked。原合约扩展不可在本页用本地配置猜补。

## 要做的

1. 删除 addresses.ts:20 拒绝文字规则、:34 掩码/网络用途猜测、:50 大小数字和 0.x 特例；不对所有 args/keywords/期望全文扫描外形像 IP 的片段来认地址。

2. 按原合约声明的参数 type/address role 从结构参数取值；CLI 内部参数来自 R4 锁定树语法和结构化类型。分别明确 IP、mask、prefix、普通数值/string，角色只能等于声明值。型未声明时未核对并阻止派发，下一步补合约，不让模型编辑冻结配置来绕过。

3. 台架数值身份、子网和 replacements 一一对应的机械核验保留；地址替换只作用于被合约声明为地址的位置并保留原引文身份，不依赖附近空白、前一个 token 或网络/广播外形猜主机。期望是字面断言，不凭其中像 IP 的文字推类型；所需结构位置由合约明确。

4. 派发允许集合只由合约方法、参数角色闭集、效果表及相应预算/放行条件推出；移除 denied.device/host 的词表行为并更新 profile schema、SKILL、样例。不能把“删词表”实现成放开一切；合约无类型或无效果授权组合均不得派发。显式语法限制可以保留但注明 grammar。

5. 同步改 checks→generate→workbook 回读→dispatch-policy，同一 typed 约束四处生效。更新 contract_methods/bed_addresses/commands_known/expected_grounded/workbook_verified 及效果 release 引用；Hub 不生成执行计划，客户端生成后回读也不能弥补缺合约。

## 必须有的测试

先写能复现旧问题的合成回归用例，记录改前失败的测试名与断言；再实现，原测试改后通过。不能删断言、降低召回门槛或把实际输出倒写为标准答案。下列是实施验收，本文档起草没有执行这些业务测试。

- 长整数、版本串、0.x、期望中外形像地址的文本不能被猜为地址；typed IPv4/IPv6/掩码/前缀分别按各自语法核值。
- 同一文字在 string 和 address 两种声明下只随类型变化；删类型声明后四层均未核对、dispatch 未发生；补类型后重新绑定新运行才可核验。
- 动作名含拒绝词但结构允许的合成方法按效果表判；动作名不含词但未授权方法拒绝；预算、租约、合约摘要变化均阻止旧工作簿派发。
- 用合成 gateway/executor 记录调用次数，缺型/缺效果时确为 0；不以本地取消证明远端停止；不连真实网关。

## 验证与交付

`npm run typecheck`；`node --test "packs/workflow/case-compile/**/*.test.ts"`；合成执行器派发前后链条测试、包清单及 `npm run test:docs`。 业务检查只能用临时回环 PostgreSQL、合成文档和脚本化模型。无条件或依赖缺失的检查记未做/跳过及原因，不当通过。包改动后更新包 README、版本/清单和样例；不改 root README。按 R10 保留旧记录，追加受影响字段和新版本血缘；真实重跑由集成者在另行授权下做。

回报：提交号、改前失败/改后通过的测试名与数量、未做项、模型提交身份、受影响要求项、新包摘要和碰头文件。实际未实现的主张不得写成已证明。

## 先后与碰头文件

先 M4/M5 与 R4 完整参数语法；只在合成合约实施。R7 的期望引文身份影响生成槽位，先碰头冻结版本。R9 独占 gold/compile-check.ts（A78）和新版独立合约 reader。本页整包独占，其他页不改 case-compile/pack.json。真实运行合约、网关、发布重跑由集成者另安排。
