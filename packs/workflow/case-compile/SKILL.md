---
name: case-compile
description: 按运行器原始函数合约与 runtime-profile 核验单用例计划并生成执行工作簿；把测试脑图编译成可执行工作簿时使用。
---

# 用例编译与工作簿核验

客户端按受限结构填计划并生成工作簿，Hub 只核验及重算，不调用模型。两次运行不能合成一次：输入开始后冻结，不能在旧运行里补绑文件。

本地工具由客户端装进技能目录（通用根 `~/.agents/skills/<包>/`；装好的目录即下文 `<技能目录>`，Base directory 由客户端在加载时给出）。客户端有安装技能的工具时用它安装，并按同一参数跑第 5、6 步；没有时用 list_task_packs 回答里的安装命令，再按下面 here-doc 跑 node。`%HUB_URL%` 是 Hub 的 MCP 端点基址，`%HUB_TOKEN%` 是 Bearer 令牌：模型只写占位符名字，值由客户端执行时展开，不进参数、结果、日志或 Git。

1. 先用 test-bed 预订整个自动化测试环境（acquire 的 need.devices 写清单全部设备；已持有整台预订（如刚装过构建）就沿用）。第一次 start_run 用 case-compile，predecessor 写预订运行。对照某个构建时 product、build 和 version 写在 start_run 顶层，不写进 parameters。绑定 subject、contract、inventory、profile。整份脑图不填 parameters.autoid（Hub 选全部带文字 autoid、未声明不自动化的用例）；只编一条时从原文复制 autoid 字符串。后三项是发布的 doc:doc，profile 含 device_count 只读预检事实及可选 fold_newlines 名单。优先用敏捷文档号；只有本地导出时运行 `node <技能目录>/tools/normalize-mindmap.ts --in <导出文件> --out <规整文件>`，上传中性文件名，在说明中原样给出两边摘要和“客户端规整”。不改写用例内容或编号。
2. 用 get_nodes 读本次绑定的源，按分页读完。启用只说明对象/方法身份存在，不是派发授权。设备命令按锁定命令树放行，只拒合约声明的破坏性命令；不在本环境的地址：作者原文里的照留并披露，计划改出的拒。其余只读原合约结构，不从 help 散文推断。仍缺合约事实时按补证请求交具名维护者，告诉用户在等哪个请求，不让用户替维护者选；不得改冻结 profile、加本地角色或 reviewed 标志绕过。不复制默认值、内部项、认证候选或脱敏凭据。plan 槽见 slots.schema.json：bucket 为自动化测试环境，replacements 为 {case,bed} 一一对应地址。平面计划 blocks: []，steps 为 {object,method,args,keywords}；块计划 blocks 非空，steps/expects 均为 []，不可混写。args 为文字，keywords 为文字或安全非负整数。
3. 平面 steps 禁止 literal_assertion；expects 写 {text,quote:{reference,text},after}，至少一条；after 从 1 开始，指向产生这段输出的设备命令或主机 shell（流量期望指向触发命令），不指向等待。块断言写 blocks 并指向观察输出，见下文。quote 保留逐字原文及来源身份。replacements 只用于经合约类型确认的地址位置；其他位置的同样文字保持原样，不扫描全文找 IP，不凭外形判用途。平面计划未写 basis 时，text 是替换后引文的精确片段，不能正规化字形或吞掉空白；描述性期望用下述 model_judgment。平面步骤和 text 写最终文字。普通参数单行、无首尾空白、无 {}、{0} 或等号前缀；RESTORE_FROM 的守卫占位 {} 除外。设备命令须被锁定构建的命令树完整解析，参数按树的结构类型完整消费并核值；Hub 由计划命令生成 CommandIdentity，用例无须预先声明命令。用例有 data.command_identities 时，计划解析身份须与其一致（只应用显式类型化替换）。不接受缩写、前缀、字形或大小写折叠、从散文捞命令。主机命令只能在合约声明的具体方法、参数类型和效果授权范围内，安全性不按动作名或参数里的词判断。设备地址允许本自动化测试环境其他设备接口及本血缘分配；其余原地址仅通过 replacements 换入。本次运行冻结了已受理的判据声明时（答复列出声明 rec:、新判据与复核人），期望可逐字取自新判据：quote.reference 写该声明的 rec:，quote.text 逐字抄冻结的新判据，text 是其精确片段；包按冻结字节核对，客户端副本不算数，改写或拼接按 expect_not_in_criterion 退回。声明自己的引文在本次运行边界另行逐字核对，来源未绑定时记未知并补读，不当已通过。
4. submit_result 后按修正说明修计划并自动重交，最多两轮。类型或效果缺失是缺原合约事实，不是计划内容为假，按第 2 步补齐前不生成或派发。首次只有 workbook_verified 的“缺少文件”可继续；每个用例的其他必需要求项都须 satisfied 才生成工作簿；全部用例的计划同一次 submit_result 提交。读完整结果，不能把 accepted 当成所有要求满足。
5. 生成前自动执行（<目录> 为工作目录下的新目录）：

```sh
node <技能目录>/tools/fetch-run.ts --hub %HUB_URL% --run <计划运行号> --out <目录> <<'EOF'
%HUB_TOKEN%
EOF
```

脚本凭本人令牌取 run/result/submission 与绑定的 contract、profile、inventory 原字节，全部核对摘要后才写入，不覆盖。

6. 再执行 `node <技能目录>/tools/generate-workbook.ts --run <目录>/run.json --result <目录>/result.json --submission <目录>/submission.json --contract <目录>/contract.json --profile <目录>/profile.json --inventory <目录>/inventory.json --out <目录>/case.xlsx`。脚本不联网，只打印 sha256 与生成器版本，不覆盖旧文件。G 无法往返时按回执的步骤和规则修回计划、重取满足结果，不猜另一种解析；零参数不能写成空 G，数字文字关键字、混合引号等同样按回执处理。
7. 用 upload_file 上传原始 case.xlsx，核对返回的 SHA 与脚本输出一致。第二次 start_run 仍绑定同一用例文档、合约、清单、配置与构建，另绑定 workbook 为上传返回的 src: 引用；predecessor、parameters.plan_run、inputs.plan_result 都写已满足的计划运行号（多用例时 plan_result 必填）。原样重交全部用例的步骤、期望和替换表。改了计划就重取满足结果、重新生成上传，再开新的核验运行。
8. 读全部核验结果。支持回执 data 为 {sha256,autoids,bed:{id,manifest_sha256},build,generator,plan_run}（autoids 为全部用例），不含工作簿内容；派发前再核 plan_run 与 predecessor 相同并重查设备数与租约。原样转述“按合成合约核对”或“按发布的运行器合约核对”、身份前 12 位和“不证明在真实设备上跑得通”。未知须写明缺的事实并继续取证、补件或重开运行，不以未知结束。所有必需要求项 satisfied 且持有第 1 步的预订时 Hub 自行派发（答复“派发”行给作业号）。读进展和结果引用时逐字节原样重交派发所依据的提交（含全部计划）；作业未结束时交别的内容只存档、不核验，Hub 答 IDEMPOTENCY_MISMATCH 并附进展，派发照常；要改内容等作业结束后开新的核验运行。get_nodes 读结果引用看逐条结论。
9. 有没通过的条目时，读该行 evidence 的日志与各设备会话逐条归因（计划、期望、产品或环境）；设备回显只用来理解失败，不抄进期望：回显点名的命令或配置先在锁定命令树和手册读到再改计划；说明不了的推断（时序、等待）是判断，写明预测，下次在被测命令前加只读观察区分，不符就换假设。只改失败用例，已通过用例的计划逐字不变；沿用第 1 步的预订整份重跑计划、生成、核验与派发，直到全部通过，或把剩余失败连同证据交用户决定。之后作业都有终态时用 test-bed release 释放该预订。

等待写 max_wait_seconds 内的正整数秒；断言 text 同普通参数的取值规则。

allowed 只提供已声明范围内的收紧配置，不能替代原合约的参数类型、用途、效果表、预算与放行条件。零参数方法同样须有原合约效果授权；reviewed、方法名称、派发标签、角色齐全或未命中文字都不是替代证明。主机 shell 不冒充设备命令。

旧运行、旧根和旧工作簿字节不变；新包或新模型重产用新原件、新运行身份并保留 predecessor 血缘，旧规则的支持不当新 release 证明。

只使用 runtime-contract@2 的类型、角色闭集、效果与来源。旧合约未核对，不生成或派发。case_index 仅在有用例原始身份声明时绑定，用于额外核一致性。plan 通常省略 command_identities（不要求构造 raw、parsed 或 type）；主动提交时只作可选声明核对，结构错误、缺项、多项或与 Hub 身份不一致记违规，可删掉后重交。不要交命令短语猜测。

喂入层：经 Hub 读到的用例、缺陷、构建、规格由程序自动喂入（带冻结序号），视图只读冻结序号之前的喂入；客户端只经 knowledge-contribution 回注程序填不了的语义（带逐字引文）。

## 自动化测试环境适配、前置与清理（写计划前先读完）

环境事实来自 start_run 答复里的 inventory（test-bed-manifest@1）：每台设备的类型、每个接口的地址与所在网段、每个网段上有哪些设备、服务清单里哪台设备在哪个网段提供触发通路。模型据此自己适配，不需人再指定：

- 选口与选地址：从清单为本步骤选未被占用的接口与地址；不得选用承载监听或触发通路的接口与地址（服务清单列出的 host 及其地址）。需要新地址时选空闲地址并写进计划；被改动地址的接口必须在清理段恢复原地址（原文地址照抄清单）。
- 前置补齐：断言结果必须真实可产生。平面查询类断言先在 steps 前部安排创建步骤，块计划先建被查记录；配置类先写入再查询。前置操作在触发前。
- 可机械核对的期望：平面计划的期望 text 优先写成设备实际输出里可机械核对的文字——应答状态码、应答条数、表项计数、存在/不存在的关键行。作者原文的描述性期望（如"设置成功"）仍以 quote 逐字保留作依据；text 与原文不一致时按 model_judgment 形状提供，rationale 写明为什么选择这个可观察文字（对应原文哪句话、设备会输出什么）。确实无法机械化的期望才用纯描述判断，并在 rationale 写明原因；不得把"查询一个不存在的名字"当成"访问成功"。
- 清理段：改配置的操作在末尾写逆操作，同一设备内按改动逆序排列（后改的先删），设备之间不限；运行器清理前缀（合约 cleanup）覆盖的可不写；查询类步骤不需要逆操作。

工作簿行序随平面步骤或块序列：前置（创建被查记录）→ 被测动作 → 查询断言 → 清理（逆序删除记录、恢复地址），都在本用例结束之前。

描述性期望使用显式模型主张：`{text, quote, after, basis:"model_judgment", rationale}`。quote 须逐字取自本次被判对象中该用例的期望节点，reference 写该节点的原件引用，不引用标题、步骤、其他用例，也不改 W10 的期望来源规则。text 选设备执行后实际输出、可观察的单行文字，符合发布 profile 的取值规则；根据设备资料或已有观察选择文字，不能仅凭描述性原文的措辞臆造设备输出。Hub 只核引文、节点身份、after 和取值规则，不替模型判断 text 是否正确；核验及派发后的判定均标“以判断为前提”，保留 basis、rationale 和本次提交的模型身份。

命令授权与来源保留：运行器效果可声明 `command_scope` 路径前缀闭集；若同时有逐条 `commands`，按交集授权，身份声明不能代替锁定树解析。用例原文中可完整解析的作者命令按定义身份（来源根、路径、签名）计次数：可以改参数，不可以删命令；缺失次数是未完成义务。参数仍须满足树类型、角色与自动化测试环境约束。

平面计划的清理在 `steps` 末尾连续排列，写 `cleanup: true`；主体省略。块计划末尾连续排清理块：CONFIG 写 `cleanup: true`，RESTORE_FROM 自动视为清理。每条非产品只读范围的设备命令都须在同一设备对象上有产品声明的逆操作。前导参数取产品规则；未给固定数量时须能由锁定逆签名唯一确定。按净效果核：主体内互为声明逆操作的先建后删相抵，只清理最后仍生效的配置。产品声明需确认的命令（confirmations）：该步 keywords.prompt 写声明的提示符，下一步同对象同方法只写声明的应答，应答不计命令与清理。不要把观察命令或正文里的词猜作修改/逆操作。对象序号只读冻结 profile 的显式 ordinal，按清单中同类型设备数量核对；越界时框架取不到那台设备，整卷不跑。

## 块计划（B1）

旧 flat 计划保持受限字面语义；需要一次观察配多断言、跨步捕获或捕获还原时用 blocks（第 2 步）。先读本包 README 的块模型和 tables/blocks-format.json。每块唯一 id；每条断言明确 output、作者 expectation 引用和 quote。观察、捕获、等待与配置按结构声明，不用正文词猜种类。

完整列出 block_context.preconditions / causal_links / responders（确实无此项写空表），主机观察明确谁应答。负向用例需要“前置不存在”时保留 absent，不通过补配置改变原场景。寄存器只在本用例内有效，先捕获后引用，不覆盖；同值比较需双向字面包含，差异比较需发布的全值字面方法，不能用正则型 not_found 处理整段捕获。

作者期望全部进 obligations：实际断言 id，或 unmet 加 missing/next_action。没有作者闭集字面声明的描述性期望，提出 criteria（明确类型、算子、取值、原引文、scope_root 与理由），由本目录 review 阶段的非作者账号复核，之后绑定真实 criteria_review 和 criteria_review_run 记录。不能拿上传 JSON、同作者判断或无关前驱替代。literal 同样选设备真实可观察的文字；Hub 只核机械条件，语义判断会保留限定。

RESTORE_FROM 在改动前捕获原文，末尾同设备、逆序恢复，for 精确指配置块。只能用已声明的 guarded restore 方法；root/target 由锁根、产品逆规则和冻结清单机械派生。缺执行器守卫能力保持未知，请维护者补实现及发布声明；不把 {} 塞进普通设备命令。OBSERVE_DIST/MEMBER/EXIT 本版暂缓，按声明给出口，不自造正则或成功标记。

## 重组后编写（B2）

新用例先执行 recompose 阶段，case-compile 的 pipeline 显式写 recomposed；旧已锁定运行与旧 flat 路径保持兼容。管理员先发布/分配本目录 authority、recompose、adjudicate 三个独立工作单元；产品包作者在生产器 params.recompose 中声明实际规范来源、适用范围、参数用途与裁决角色。不要把自述的 product-declared 或上传裁定 JSON 当凭证。

模型理解意图、知识位置、语义等价与缺前置；代码只读结构。读逐节点资格报告，未判定单列，按作者声明深度核对。两种布局保留原文及跨度：自身动作/叶期望，或标题/步骤/期望；编号及方括号定位按声明语法匹配，不能按“成功”“配置”等词判断角色。未绑定期望请作者或核对方明确定位，不静默删掉。

先绑定完整作者脑图及来源权威运行/结果，提交 record 三元契约、逐字原文账、适配账、具体化账和空重绑定账。所有引用要在本轮可读；声明位置也放进 quotes/grounds，由核心解析和逐字核验。状态 settled 也写后续编写出口；欠定、冲突、缺前置各走自己的角色与时点。冲突不是删除作者输入的许可；作者同意删除时应更新原件并按新来源身份重开。

对初稿提交取得实际 Hub submission 记录，交非作者账号的 recompose-adjudication 作只读前驱复核，绑定 source_run 完整快照及作者/规范来源。裁定由模型写，Hub 核形状、逐字引文、账号独立性与锁定产品/根。之后以原重组运行为 predecessor 新开重组修订，绑定 previous_run/result 和实际独立裁定快照/结果，record.predecessor 须等于真实前驱；不覆盖旧记录。

逐案分片要保留冻结全集。客户端 <技能目录>/tools/seal-recompose.ts 从实际运行导出和原提交记录数组汇总：未完成项仍携 record:[]，不以 not_covered 冒充完整；每次只替换明确的新候选，其他原记录不改。该工具只产草稿和缺案数，不签发受理；草稿交 submit_result，只有 Hub 的全部条目要求项及 full_set 都满足才算整批完成，分片 worker 不独立封整批。

编写在 recomposition_run/result 绑定真正已受理的记录，并填写 plan.data.recomposition（receipt、case_id、每个期望位的独立 assertion id、rebindings）。平面 expects 的 id 按从 1 开始的文字序号，块断言用显式 id。断言 quote 须等于所履约原子的逐字文本；按 B1 提出并独立复核判据，不能把方法说明当设备输出。物理替换只在此阶段出现，重绑定账保留 from/to、source_of_value、冻结 inventory 的 authority，且与 replacements 一一对应。缺来源或权限就是 unknown，点名等产品包作者、来源维护者或编写方在何时补，不能猜。
