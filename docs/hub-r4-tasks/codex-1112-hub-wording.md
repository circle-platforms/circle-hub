# Hub 答复措辞（11 月 12 日）

来源：所有者 11 月 12 日任务书 B1 与同目录措辞规则。

允许改动 `hub/server/claims.ts`、`hub/server/text.ts`、`hub/server/tools.ts`、对应已有测试、`contracts/src/tools.ts` 及其生成文件，以及本页。

MCP 正文按原始用例给出结论、状态和判断，错误或未知才给原因和下一步。第一段是给使用者的白话，第二个文字块以“供模型引用”开头，完整保留已校验答复与原始用例 ID、标题对应；机器可读答复也继续保留，不改模型或控制台接口。

本项只执行 `node --test hub/server/text.test.ts`。不运行全量检查、不安装依赖、不访问测试环境。

已接入设备命令说明。设备输出逐行保留，仅把控制字符转成可见转义。`node --test hub/server/text.test.ts`：63 通过、0 失败、0 跳过。相邻的 `feeding-text.test.ts` 仅更新既有断言，本项未运行它。

后续更正：Circle 只读取文字内容，因此内部引用同时放进第二个文字块，供模型继续取号、绑定和重交；使用者白话不混入这些字段。原始资料和逐字引文不作自由文本替换。控制台保留原有显示接口。

集成复核补齐：两个答复各带可选的机器可读 `record`，直接使用原有查询结果；生成命令只更新 `contracts/generated/tools.json`。保留原文扣留说明、管理员核看步骤、资料覆盖不全、资料保存理由、整体评审说明、证据原句、撤回和矛盾提示。覆盖不全和来源尚未取得都显示未知，不判错误。设备读取时间使用已有采集时刻，显示本地时间到分钟。

补齐后仍只运行 `node --test hub/server/text.test.ts`：63 通过、0 失败、0 跳过；`npm run gen:contracts`：1 文件生成、198 文件不变。未运行其它测试和类型检查。

## 模型引用（后续更正）

每个工具答复保留两段文字。第一段是给使用者的白话；第二段以 `供模型引用` 和换行开头，后面是完整的已校验答复 JSON，并附 `original_cases` 对应。原始用例 ID 直接取已有 `autoid` 或 `case_id`；标题字段缺失写 `null`，不从文字猜。用例重组的白话同时明确标题未知。

对照脚本编写、用例重组与交付说明核对取号链：

| 需要的内容 | 第二段保留的位置 |
| --- | --- |
| 工作流、输入、参数与本地工具安装命令 | `packs`、`index`、`packs[].inputs`、`packs[].parameters`、`local_tools` |
| 开始后的编号和完整保存位置 | `run.run`、`record` |
| 前后对应、同一构建及手册和命令树 | `run.predecessor`、`run.input_defaults`、`run.build`、`run.root`、`run.unversioned_root`、`run.sources` |
| 原始用例 ID、标题、位置及原句 | `run.items`、`original_cases`；后续读取的 `content.text` |
| 自动化用例填写规则和重组对应 | `run.slots.schema`、`run.instructions`、`run.items[].fields.recomposition`；完整原句与对应编号均不裁剪 |
| 脚本合并后的完整保存位置及自动化用例 | `record`、`result`、`result.partitions`、各项 `claims[].statement.data` |
| 上传 Excel 的引用及摘要 | `reference`、`sha256`、`size` |
| 上机验证及设备输出的读取位置 | `dispatch`、`dispatch[].job`、`dispatch[].executor`、`dispatch[].result`；后续读取的 `content` |
| 错误所指原始用例及提交位置 | `errors[].item`、`errors[].path`、`errors[].requirement` 与 `original_cases` |
| 手册原话、完整引用及候选位置 | `content`、`nodes`、`references`，保留完整已校验数据 |

更正后的两次检查仍仅为 `node --test hub/server/text.test.ts`，每次均为 63 通过、0 失败、0 跳过。既有 MCP 场景现在同时核对第一段白话、第二段完整 JSON、开始和脚本合并后的保存位置，以及错误的原始用例 ID 与提交位置。未运行其它测试。

模型引用补齐开始时已知的 `source_context.unavailable` 与 `source_context.gaps`，直接采用原有资料，不新增查询或校验。规程完整留在第二段 `run.instructions`，不再拼进第一段白话。同一测试文件收口结果为 63 通过、0 失败、0 跳过。
