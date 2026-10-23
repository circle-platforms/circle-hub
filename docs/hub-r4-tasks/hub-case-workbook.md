# 任务：客户端生成工作簿，Hub 回读核验并记摘要

依据：`docs/hub-r4-device-run.md`（上真实台架的设计，第 1–5 节和第 8 节的分工），决定 26、27（`docs/hub-r4-progress.md`），理论文档第 6、7 节；模型用 `node tools/show-element.ts D02 D03 D04 D07 B05 B06 B07 V03 W05 P05` 读。

- 分支和工作树：`hub-case-workbook`，目录 `circle-hub-hub-case-workbook`（依赖已装好）
- 可以改的路径：packs/workflow/case-compile/**（新的 functions/generate.ts、functions/g-syntax.ts、functions/workbook.ts、scripts/**，以及 workflow.json、requirements.json、checks.json、SKILL.md、README.md、samples/）。核心文件不碰：xlsx@1 解析器和 upload.ts 的 xlsx 一行在 `xlsx-parser.md` 那件里做。
- 规则：同前（不推送、不建 PR、不发布、不部署；不碰 7420、钥匙串、环境配置文件和任何真实系统；测试只用合成数据，地址只用 192.0.2.0/24 和 2001:db8::/32；`git commit -s`）。所有者的规矩：未知只能是过渡状态，写明缺的事实和下一步动作，流程自动走这一步；Hub 只核验，不生成内容、不调用模型；枚举只来自 contracts/generated（运行时用按包生成的快照）。
- 依赖：hub-case-runtime 和 xlsx-parser 合并之后

## 要做的

1. 核心 xlsx@1 解析器已拆成 `xlsx-parser.md` 先做，这里只用它的模型。“只认生成器写的子集”（设计第 3 节第 1 条的后半）在第 6 条的核验检查里判：成员恰为生成器写的那几个、一张可见的表、没有隐藏的表和行、只用内联字符串、没有公式、没有以 `=` 开头的值。
2. G 写法（functions/g-syntax.ts）：按 README 里的格式说明实现运行器解析规则的 encode 和 decode（逗号、引号、反斜杠、关键字、数字、换行）。encode 之后 decode 必须原样回来，回不来的值生成器拒绝；读取器用同一套规则解析。
3. 生成器（functions/generate.ts，零依赖，只用 Node 内置；包的检查和 Circle 脚本导入同一个模块）：输入为槽位、条目字段（autoid、标题、步骤原文）、合约身份和配置；输出 xlsx 字节。zip 只用 STORE、固定时间戳、固定成员次序、自算 CRC32；只用内联字符串，C 列是数字，A 列是文本；行序为身份行、表头、说明行（C=0，E–I 空，D 写运行号和构建，不写人名）、用例各步（autoid 只在第一行且该行 E 不空，每条期望一行字面断言紧跟它的 after 步骤）、空行、收尾行；范围名是工作簿级、指向表头行。OOXML 的写法参照 circle-packs 里 10-13 在台架上跑通过的 xlsx.mjs（只读参照），差异逐条写进 README。
4. Circle 脚本（scripts/）：normalize-mindmap.ts 把本地导出文件规整成 kityminder 形状，打印两边的摘要；generate-workbook.ts 读本地保存的已满足提交、条目字段、合约身份和配置，写出 xlsx，打印 sha256 和生成器版本。只用 Node 内置，不联网。SKILL.md 写明这些输入从哪次工具调用的回答里取。
5. 输入槽 workbook（角色待判定产物，接受 xlsx 媒体类型，选填）和要求项 workbook_verified（事实、阻断）；没绑定时记未知（缺输入）。
6. 核验检查（functions/workbook.ts，独立读取器，不调用生成器去解析）：设计第 3 节第 1 到 8 条；再用生成器从本次提交的槽位重算，字节相等才支持。支持结论的 data 写 {sha256, autoids, bed, build, generator}（任务 3 的接口），其中 bed 是 {id, manifest_sha256}：id 是台架清单里的台架名，manifest_sha256 是本次运行绑定的台架清单的字节摘要；不带工作簿内容；生成器版本与本运行的包版本不符时写明。
7. Hub 侧生成计划的要求项（deterministic_plan）已在 hub-case-runtime 里随 2.0 移除（决定 26：Hub 不生成内容）；这里在 README 和 SKILL.md 里写两次运行的步骤。

## 必须有的测试

- 子集检查：多一个成员、两张表、隐藏的表、用了共享字符串，各一份反例。
- G 写法：每条规则一对正反例；固定种子的随机值往返。
- 生成器：同一输入两次字节相同；改一个槽位字节就不同；zip 自检（CRC、偏移、成员次序）；脚本和检查函数导入的是同一个模块。
- 读取器对生成器：生成，经核心解析，再经包读取，逐行等于槽位。
- 核验反例各一份：缺身份行、摘要不符、两个表头、范围名是表级或指错行、说明行带了 E、收尾行不是最后一行、autoid 行 E 空、autoid 位数不对、断言跟在等待之后、上传字节与重算差一个字节、出现公式或以 = 开头的值、有隐藏行、认证请求格非空、两个用例。
- 生产测试（真引擎、假外部）：计划运行满足后工作簿一项是未知（缺输入）；带工作簿的第二次运行全部满足，结论带 S。
- npx tsc --noEmit；全仓词表扫描零命中，不加例外（`packs/workflow/case-review/packs.test.ts` 里的 handWrittenAxes，core-fixes 合并后覆盖 hub/ 和全部包）。

完成后在终端里回报：提交号、测试数量、没做完或拿不准的地方。真实台架上的任何动作都由集成者做，并且要等所有者答复设计第 6 节的问题。
