# 用例编译与工作簿核验

客户端按受限结构填计划并生成工作簿，Hub 只核验及重算，不调用模型。下面两次运行不能合成一次：输入开始后冻结，不能在旧运行里补绑文件。不证明在真实设备上跑得通。

1. 先取得 test-bed 预订。第一次 start_run 用 case-compile，predecessor 写预订运行。要对照某个构建时，product、build 和 version 写在 start_run 顶层，与 pack、predecessor、inputs 并列，不写进 parameters。绑定 subject、contract、inventory、profile，parameters.autoid 从原文复制为字符串。后三项是发布的 doc:doc，profile 含 device_count 只读预检事实及可选 fold_newlines 名单。优先用敏捷文档号；只有本地导出时运行 `node tools/normalize-mindmap.ts --in source.json --out normalized.json`，上传中性文件名，在说明中原样给出两边摘要和“客户端规整”。不改写用例内容或编号。
2. 用 get_nodes 读本次绑定的源，按分页读完。启用只说明对象/方法身份存在，不是派发授权。参数类型、地址用途和效果授权只读原合约的结构声明；CLI 内部参数按锁定命令树的完整语法和结构类型核验，不从 help 散文推断。缺少任何类型或效果事实时，读取 Hub 补证请求的具名受众和期限，自动请求合约发布管理员补原合约并发布，然后用新原件重开运行；不得改冻结 profile、添加本地角色或 reviewed 标志绕过。不复制默认值、内部项、认证候选或脱敏凭据。plan 槽见 slots.schema.json：bucket 为台架，replacements 为 {case,bed} 一一对应地址。平面计划 blocks: []，steps 为 {object,method,args,keywords}；块计划 blocks 非空，steps/expects 均为 []，不可混写。args 为文字，keywords 为文字或安全非负整数。
3. 平面 steps 禁止 literal_assertion；expects 写 {text,quote:{reference,text},after}，至少一条；after 从 1 开始指向设备命令或主机 shell，不指向等待。块断言写 blocks 并指向观察输出，见下文。quote 保留逐字原文及来源身份。只有经合约类型确认的地址位置才能应用 replacements；同样的文字出现在普通 string、数值或其他期望位置时保持原样，不扫描全文找 IP，不凭相邻空白或网络/广播外形判用途。平面计划未写 basis 时，text 是替换后引文的精确片段，不能正规化字形或吞掉空白；描述性期望用下述 model_judgment。平面步骤和 text 写最终文字；块断言按下方声明填写。普通参数单行、无首尾空白、无 {}、{0} 或等号前缀；RESTORE_FROM 的守卫占位 {} 除外。设备命令必须被锁定构建的命令树完整解析，参数按树的结构类型完整消费并核值；Hub 从计划命令生成 CommandIdentity，不要求自然语言用例预先声明命令。用例有 data.command_identities 时，计划解析身份还必须与其一致（只应用显式类型化替换）。不接受缩写、前缀、字形或大小写折叠、从散文捞命令。主机命令只能在合约声明的具体方法、参数类型和效果授权范围内；动作名或参数里是否出现某个词都不决定安全性。设备地址允许本台架其他设备接口及本血缘分配；台架外原地址仅通过 replacements 换入。本次运行冻结了已受理的判据声明时（开始运行的答复列出声明 rec:、新判据与复核人），期望可以逐字取自新判据：quote.reference 写该声明的 rec:，quote.text 逐字抄冻结的新判据，text 是它的精确片段；包按冻结字节核对，客户端的副本不算数，改写或拼接按 expect_not_in_criterion 退回。该声明自己的引文在本次运行边界上另行逐字核对，来源没有绑定到本次运行时记未知并补读，不当已通过。
4. submit_result 后按修正说明修计划并自动重交，最多两轮。类型或效果缺失是缺原合约事实，不是计划内容为假；沿 Hub 的补证请求处理并重新绑定新运行，在补齐以前不进入生成或派发。第一次只有 workbook_verified 的“缺少文件”可以继续；其他所有必需计划要求项必须 satisfied。读完整结果，不能把 accepted 当成所有要求满足。保存原样提交 JSON；保存 start_run 的运行摘要和 submit_result 的完整结构化结果（可从结果引用导出）。只有中文摘要、没有可核验 JSON 时，请集成者导出原样结构化记录，不能拼造满足证明；取得后继续。
5. 生成前准备本地文件：run.json 来自上述运行摘要，result.json 来自已受理校验结果，submission.json 是该次原提交；contract.json、profile.json、inventory.json 必须是该运行 sources 中对应引用的原始字节。逐页读取原件后保留原文，不格式化改写；脚本会核对来源摘要。集成者按 pack.json 摘要安装整个 tools/、functions/、tables/、requirements.json 目录树，保留相对路径。源码与发布目录均为 tools/，路径与清单一致；不要只复制入口文件。
6. 自动执行 `node tools/generate-workbook.ts --run run.json --result result.json --submission submission.json --contract contract.json --profile profile.json --inventory inventory.json --out case.xlsx`。脚本不联网，只打印文件 sha256 和生成器版本等计数；不覆盖旧文件。G 无法往返会给具体步骤和规则，按规则修回计划后重取满足结果，不猜另一种解析。零参数无法写成空 G，数字文字关键字、混合引号等按回执处理。
7. 用 upload_file 上传该原始 case.xlsx，核对返回的 SHA 与脚本输出一致。第二次 start_run 仍绑定同一用例、合约、清单、配置与构建，另绑定 workbook 为上传返回的 src: 引用；predecessor 和 parameters.plan_run 都写第一次已满足的计划运行号。原样重交步骤、期望和替换表；不要改槽位后沿用旧文件。若修了计划，先取得满足结果、重新生成上传，再开新的后继核验运行。
8. 读取全部核验结果；只有所有必需要求项 satisfied 才可交给集成者。支持回执 data 为 {sha256,autoids,bed:{id,manifest_sha256},build,generator,plan_run}，无工作簿内容。包内只核说明行和 plan_run 参数一致，派发再核其与 predecessor 相同，并重查设备数/租约。原样转述“按合成合约核对”或“按发布的运行器合约核对”、身份前 12 位和“不证明在真实设备上跑得通”。未知必须明确缺的事实并继续取证、补件或重开运行，不以未知结束。真实派发由集成者在所有者答复设计第 6 节后处理。

等待必须是 max_wait_seconds 内的正整数秒数；断言 text 也必须符合单行、无边缘空白、无公式前缀和无占位符的取值规则。

allowed 只提供已声明范围内的收紧配置，不能替代原合约的参数类型、用途、效果表、预算与放行条件。零参数方法同样必须有原合约效果授权；reviewed、方法名称、派发标签、角色齐全或未命中文字都不是替代证明。模型不得修改冻结配置。主机 shell 不冒充设备命令，也不靠拒绝词表放行。

旧运行、旧根和旧工作簿字节保持不变。新包和新模型重产时使用新原件与新运行身份，保留 predecessor 血缘；列出旧引用及受影响字段交集成者追加历史说明，不能将旧规则支持当成新 release 证明。

只使用 runtime-contract@2 的类型、角色闭集、效果与来源。旧合约未核对，不生成或派发。case_index 仅在有用例原始身份声明时绑定，用于额外核一致性。plan 通常省略 command_identities：Hub 从 steps 的完整设备命令行解析身份，不要求模型构造 raw、parsed 或 type。若主动提交，此字段只作为可选声明核对，结构错误、缺项、多项或与 Hub 身份不一致记违规；可删除该声明后重交。不要交命令短语猜测。普通期望保持逐字原文，不从其中识别地址。拒绝词表已退役，缺授权时补合约或调整计划后重开运行；不得修改冻结配置绕过。

喂入层：这个包读到的用例、缺陷、构建、规格凡经 Hub 读的都由程序自动进喂入层（带锁定树苗和冻结序号），视图按"锁定树苗 + 冻结序号之前的喂入层"读；版本未声明和矛盾的对象单列计数，不进版本差。Circle 只经 knowledge-contribution 回注补程序填不了的语义（带逐字引文），运行中不问人；结构契约见该包 tables/knowledge-structure.json 或 get_nodes 根路径。

## 台架适配、前置与清理（写计划前先读完）

台架事实来自 start_run 答复里的 inventory（test-bed-manifest@1）：每台设备的类型、每个接口的地址与所在网段、每个网段上有哪些设备、服务清单里哪台设备在哪个网段提供触发通路。模型据此自己适配，不需要人再指定：

- 选口与选地址：从清单为本步骤选未被占用的接口与地址（例如合成台架里 dut0 在 192.0.2.0/26 的 192.0.2.10 和 192.0.2.64/26 的 192.0.2.74）；不得选用承载监听或触发通路的接口与地址（服务清单列出的 host 及其地址，如 server0/192.0.2.90、client0/192.0.2.80）。需要新地址时选空闲地址并写进计划；被改动地址的接口必须在清理段恢复原地址（原文地址照抄清单）。
- 前置补齐：断言结果必须真实可产生。平面查询类断言先在 steps 前部安排创建步骤，块计划先建被查记录；配置类先写入再查询。前置操作在触发前。
- 可机械核对的期望：平面计划的期望 text 优先写成设备实际输出里可机械核对的文字——应答状态码、应答条数、表项计数、存在/不存在的关键行。作者原文的描述性期望（如"设置成功"）仍以 quote 逐字保留作依据；text 与原文不一致时按 model_judgment 形状提供，rationale 写明为什么选择这个可观察文字（对应原文哪句话、设备会输出什么）。确实无法机械化的期望才用纯描述判断，并在 rationale 写明原因；不得把"查询一个不存在的名字"当成"访问成功"。
- 清理段：每条改配置的操作（创建记录、修改地址、下发配置）在计划末尾有对应的逆操作，按改动逆序排列（后改的先删）；查询类步骤不需要逆操作。平面计划的清理步骤与其他步骤同一形状，args 写逆操作命令；块计划按下方块模型写清理块。

计划顺序示意（合成命令）：前置（创建被查记录）→ 被测动作 → 查询断言 → 清理（逆序删除记录、恢复地址）。工作簿行序由平面步骤或块序列决定，清理步骤或清理块排在断言之后、结束行之前。

描述性期望使用显式模型主张：`{text, quote, after, basis:"model_judgment", rationale}`。quote 必须逐字取自本次被判对象中该用例的期望节点，reference 写该节点的原件引用，不引用标题、步骤、其他用例，也不改 W10 的期望来源规则。text 选择设备实际会输出、执行后能观察到的单行文字，符合发布 profile 的取值规则；根据设备资料或已有观察选择文字，不能仅凭描述性原文的措辞臆造设备输出。rationale 说明选择此观察文字的理由。Hub 只核引文、节点身份、after 和取值规则，不替模型判断 text 是否正确；核验及派发后的判定均标“以判断为前提”，保留 basis、rationale 和本次提交的模型身份。不写 basis 时仍要求 text 是原引文的精确片段。


命令授权与来源保留：运行器效果可声明 `command_scope` 路径前缀闭集；若同时有逐条 `commands`，按交集授权。每条设备 CLI 仍先按锁定树完整解析，不能用身份声明代替解析。用例原文中可完整解析的作者命令按定义身份（来源根、路径、签名）计次数：可以改参数，不可以删命令；缺失次数是未完成义务。参数仍须满足树类型、角色与台架约束。

平面计划的清理在 `steps` 末尾连续排列，写 `cleanup: true`；主体省略。块计划末尾连续排清理块：CONFIG 写 `cleanup: true`，RESTORE_FROM 自动视为清理。每条非产品只读范围的设备命令，都须在同一设备对象上有产品声明的逆操作，并按改动逆序排列。前导参数取产品规则；未给固定数量时必须能由锁定逆签名唯一确定。不要把观察命令或正文里的词猜作修改/逆操作。对象序号只读冻结 profile 的显式 ordinal，按清单中同类型设备数量核对；越界时框架取不到那台设备，整卷不跑。

## 块计划（B1）

旧 flat 计划保持受限字面语义；需要一次观察配多断言、跨步捕获或捕获还原时用 blocks，steps/expects 写 []，不可混写。先读本包 README 的块模型和 tables/blocks-format.json。每块唯一 id；每条断言明确 output、作者 expectation 引用和 quote。观察、捕获、等待与配置按结构声明，不用正文词猜种类。

完整列出 block_context.preconditions / causal_links / responders（确实无此项写空表），主机观察明确谁应答。负向用例需要“前置不存在”时保留 absent，不通过补配置改变原场景。寄存器先捕获后引用，不覆盖；同值比较需双向字面包含，差异比较需发布的全值字面方法，不能用正则型 not_found 处理整段捕获。

作者期望全部进 obligations：实际断言 id，或 unmet 加 missing/next_action。没有作者闭集字面声明的描述性期望，提出 criteria（明确类型、算子、取值、原引文、scope_root 与理由），由本目录 review 阶段的非作者账号复核，之后绑定真实 criteria_review 和 criteria_review_run 记录。不能拿上传 JSON、同作者判断或无关前驱替代。text/literal 要选择设备真实可观察的文字；Hub 只核机械条件，语义判断会保留限定。

RESTORE_FROM 在改动前捕获原文，末尾同设备、逆序恢复，for 精确指配置块。只能用已声明的 guarded restore 方法；root/target 由锁根、产品逆规则和冻结清单机械派生。缺执行器守卫能力保持未知，请维护者补实现及发布声明；不把 {} 塞进普通设备命令。OBSERVE_DIST/MEMBER/EXIT 本版暂缓，按声明给出口，不自造正则或成功标记。

## 重组后编写（B2）

新用例先执行 recompose 阶段，case-compile 的 pipeline 显式写 recomposed；旧已锁定运行与旧 flat 路径保持兼容。管理员先发布/分配本目录 authority、recompose、adjudicate 三个独立工作单元；产品包作者在生产器 params.recompose 中声明实际规范来源、适用范围、参数用途与裁决角色。不要把自述的 product-declared 或上传裁定 JSON 当凭证。

模型理解意图、知识位置、语义等价与缺前置；代码只读结构。读逐节点资格报告，未判定单列，按作者声明深度核对。两种布局保留原文及跨度：自身动作/叶期望，或标题/步骤/期望；编号及方括号定位按声明语法匹配，不能按“成功”“配置”等词判断角色。未绑定期望请作者或核对方明确定位，不静默删掉。

先绑定完整作者脑图及来源权威运行/结果，提交 record 三元契约、逐字原文账、适配账、具体化账和空重绑定账。所有引用要在本轮可读；声明位置也放进 quotes/grounds，由核心解析和逐字核验。状态 settled 也写后续编写出口；欠定、冲突、缺前置各走自己的角色与时点。冲突不是删除作者输入的许可；作者同意删除时应更新原件并按新来源身份重开。

对初稿提交取得实际 Hub submission 记录，交非作者账号的 recompose-adjudication 作只读前驱复核，绑定 source_run 完整快照及作者/规范来源。裁定由模型写，Hub 核形状、逐字引文、账号独立性与锁定产品/根。之后以原重组运行为 predecessor 新开重组修订，绑定 previous_run/result 和实际独立裁定快照/结果，record.predecessor 必须等于真实前驱；不覆盖旧记录。

逐案分片要保留冻结全集。客户端 tools/seal-recompose.ts 从实际运行导出和原提交记录数组汇总：未完成项仍携 record:[]，不以 not_covered 冒充完整；每次只替换明确的新候选，其他原记录不改。该工具只产草稿和缺案数，不签发受理。把汇总草稿交 submit_result；只有 Hub 的全部条目要求项及 full_set 都满足才能称整批完成，分片 worker 不独立封整批。

编写在 recomposition_run/result 绑定真正已受理的记录，并填写 plan.data.recomposition（receipt、case_id、每个期望位的独立 assertion id、rebindings）。平面 expects 的 id 按从 1 开始的文字序号，块断言用显式 id。断言 quote 必须等于所履约原子的逐字文本；按 B1 提出并独立复核判据，不能把方法说明当设备输出。物理替换只在此阶段出现，重绑定账保留 from/to、source_of_value、冻结 inventory 的 authority，且与 replacements 一一对应。缺来源或权限就是 unknown，点名等产品包作者、来源维护者或编写方在何时补，不能猜。
