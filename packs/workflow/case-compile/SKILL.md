# 用例编译与工作簿核验

客户端按受限结构填计划并生成工作簿，Hub 只核验及重算，不调用模型。下面两次运行不能合成一次：输入开始后冻结，不能在旧运行里补绑文件。不证明在真实设备上跑得通。

1. 先取得 test-bed 预订。第一次 start_run 用 case-compile，predecessor 写预订运行。要对照某个构建时，product、build 和 version 写在 start_run 顶层，与 pack、predecessor、inputs 并列，不写进 parameters。绑定 subject、contract、inventory、profile，parameters.autoid 从原文复制为字符串。后三项是发布的 doc:doc，profile 含 device_count 只读预检事实及可选 fold_newlines 名单。优先用敏捷文档号；只有本地导出时运行 `node tools/normalize-mindmap.ts --in source.json --out normalized.json`，上传中性文件名，在说明中原样给出两边摘要和“客户端规整”。不改写用例内容或编号。
2. 用 get_nodes 读本次绑定的源，按分页读完。启用只说明对象/方法身份存在，不是派发授权。参数类型、地址用途和效果授权只读原合约的结构声明；CLI 内部参数按锁定命令树的完整语法和结构类型核验，不从 help 散文推断。缺少任何类型或效果事实时，读取 Hub 补证请求的具名受众和期限，自动请求合约发布管理员补原合约并发布，然后用新原件重开运行；不得改冻结 profile、添加本地角色或 reviewed 标志绕过。不复制默认值、内部项、认证候选或脱敏凭据。plan 槽的 data 完整形状见 slots.schema.json：bucket 为选定台架，blocks 只能 []；steps 为 {object,method,args,keywords}，args 是文字，keywords 是文字或安全非负整数；replacements 为 {case,bed} 的一一对应地址表。
3. steps 禁止 literal_assertion；断言只写在 expects：{text,quote:{reference,text},after}，至少一条。after 从 1 开始，指向设备命令行或主机 shell，不指向等待。quote 保留逐字原文及来源身份。只有经合约类型确认的地址位置才能应用 replacements；同样的文字出现在普通 string、数值或其他期望位置时保持原样，不扫描全文找 IP，不凭相邻空白或网络/广播外形判用途。text 是按已核验结构位置替换后原文中的精确片段，不能正规化字形或吞掉空白。步骤和 text 都写最终文字。所有普通参数单行、无首尾空白、无 {}、{0} 或等号前缀。设备命令必须被锁定构建的命令树完整解析，参数按树的结构类型完整消费并核值；Hub 从计划命令生成 CommandIdentity，不要求自然语言用例预先声明命令。用例有 data.command_identities 时，计划解析身份还必须与其一致（只应用显式类型化替换）。不接受缩写、前缀、字形或大小写折叠、从散文捞命令。主机命令只能在合约声明的具体方法、参数类型和效果授权范围内；动作名或参数里是否出现某个词都不决定安全性。设备地址允许本台架其他设备接口及本血缘分配；台架外原地址仅通过 replacements 换入。本次运行冻结了已受理的判据声明时（开始运行的答复列出声明 rec:、新判据与复核人），期望可以逐字取自新判据：quote.reference 写该声明的 rec:，quote.text 逐字抄冻结的新判据，text 是它的精确片段；包按冻结字节核对，客户端的副本不算数，改写或拼接按 expect_not_in_criterion 退回。该声明自己的引文在本次运行边界上另行逐字核对，来源没有绑定到本次运行时记未知并补读，不当已通过。
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
