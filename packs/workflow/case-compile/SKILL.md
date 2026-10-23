# 用例编译与工作簿核验 2.1

客户端按受限结构填计划并生成工作簿，Hub 只核验及重算，不调用模型。下面两次运行不能合成一次：输入开始后冻结，不能在旧运行里补绑文件。不证明在真实设备上跑得通。

1. 先取得 test-bed 预订。第一次 start_run 用 case-compile，predecessor 写预订运行；锁定 product/build，绑定 subject、contract、inventory、profile，parameters.autoid 从原文复制为字符串。后三项是发布的 doc:doc，profile 含 device_count 只读预检事实及可选 fold_newlines 名单。优先用敏捷文档号；只有本地导出时运行 `node tools/normalize-mindmap.ts --in source.json --out normalized.json`，上传中性文件名，在说明中原样给出两边摘要和“客户端规整”。不改写用例内容或编号。
2. 用 get_nodes 读本次绑定的源，按分页读完。合约启用组合全部开放；profile 的组合表用于给每个参数定角色，没有角色先补配置；不复制默认值、内部项、认证候选或脱敏凭据。plan 槽的 data 完整形状见 slots.schema.json：bucket 为选定台架，blocks 只能 []；steps 为 {object,method,args,keywords}，args 是文字，keywords 是文字或安全非负整数；replacements 为 {case,bed} 的一一对应地址表。
3. steps 禁止 literal_assertion；断言只写在 expects：{text,quote:{reference,text},after}，至少一条。after 从 1 开始，指向设备命令行或主机 shell，不指向等待。quote 保留逐字原文，text 是按替换表处理后引文的片段；步骤和 text 都写最终文字。所有普通参数单行、无首尾空白、无 {}、{0} 或等号前缀。设备命令通过构建目录与拒绝表，主机 shell 通过主机拒绝表；设备地址允许本台架其他设备接口及本血缘分配；台架外原地址仅通过 replacements 换入。
4. submit_result 后按修正说明修计划并自动重交，最多两轮。第一次只有 workbook_verified 的“缺少文件”可以继续；其他所有必需计划要求项必须 satisfied。读完整结果，不能把 accepted 当成所有要求满足。保存原样提交 JSON；保存 start_run 的运行摘要和 submit_result 的完整结构化结果（可从结果引用导出）。只有中文摘要、没有可核验 JSON 时，请集成者导出原样结构化记录，不能拼造满足证明；取得后继续。
5. 生成前准备本地文件：run.json 来自上述运行摘要，result.json 来自已受理校验结果，submission.json 是该次原提交；contract.json、profile.json、inventory.json 必须是该运行 sources 中对应引用的原始字节。逐页读取原件后保留原文，不格式化改写；脚本会核对来源摘要。集成者按 pack.json 摘要安装整个 tools/、functions/、tables/、requirements.json 目录树，保留相对路径。源码目录叫 scripts/，发布目录依现有包合约映射为 tools/；不要只复制入口文件。
6. 自动执行 `node tools/generate-workbook.ts --run run.json --result result.json --submission submission.json --contract contract.json --profile profile.json --inventory inventory.json --out case.xlsx`。脚本不联网，只打印文件 sha256 和生成器版本等计数；不覆盖旧文件。G 无法往返会给具体步骤和规则，按规则修回计划后重取满足结果，不猜另一种解析。零参数无法写成空 G，数字文字关键字、混合引号等按回执处理。
7. 用 upload_file 上传该原始 case.xlsx，核对返回的 SHA 与脚本输出一致。第二次 start_run 仍绑定同一用例、合约、清单、配置与构建，另绑定 workbook 为上传返回的 src: 引用；predecessor 和 parameters.plan_run 都写第一次已满足的计划运行号。原样重交步骤、期望和替换表；不要改槽位后沿用旧文件。若修了计划，先取得满足结果、重新生成上传，再开新的后继核验运行。
8. 读取全部核验结果；只有所有必需要求项 satisfied 才可交给集成者。支持回执 data 为 {sha256,autoids,bed:{id,manifest_sha256},build,generator,plan_run}，无工作簿内容。包内只核说明行和 plan_run 参数一致，派发再核其与 predecessor 相同，并重查设备数/租约。原样转述“按合成合约核对”或“按发布的运行器合约核对”、身份前 12 位和“不证明在真实设备上跑得通”。未知必须明确缺的事实并继续取证、补件或重开运行，不以未知结束。真实派发由集成者在所有者答复设计第 6 节后处理。

等待必须是 max_wait_seconds 内的正整数秒数；断言 text 也必须符合单行、无边缘空白、无公式前缀和无占位符的取值规则。
