# Hub 答复措辞（11 月 12 日）

来源：所有者 11 月 12 日任务书 B1 与同目录措辞规则。

允许改动 `hub/server/claims.ts`、`hub/server/text.ts`、`hub/server/tools.ts`、对应已有测试、`contracts/src/tools.ts` 及其生成文件，以及本页。

MCP 正文按原始用例给出结论、状态和判断，错误或未知才给原因和下一步。内部引用和完整结构继续留在机器可读答复，不改模型、协议或控制台接口。

本项只执行 `node --test hub/server/text.test.ts`。不运行全量检查、不安装依赖、不访问测试环境。

已接入设备命令说明。设备输出逐行保留，仅把控制字符转成可见转义。`node --test hub/server/text.test.ts`：63 通过、0 失败、0 跳过。相邻的 `feeding-text.test.ts` 仅更新既有断言，本项未运行它。

限制：Circle 当前只把 MCP 正文转给模型，机器可读答复的内部引用能否进入模型取决于客户端；本项不扩大 Circle 修改范围。原始资料和逐字引文不作自由文本替换。控制台保留原有显示接口。

集成复核补齐：两个答复各带可选的机器可读 `record`，直接使用原有查询结果；生成命令只更新 `contracts/generated/tools.json`。保留原文扣留说明、管理员核看步骤、资料覆盖不全、资料保存理由、整体评审说明、证据原句、撤回和矛盾提示。覆盖不全和来源尚未取得都显示未知，不判错误。设备读取时间使用已有采集时刻，显示本地时间到分钟。

补齐后仍只运行 `node --test hub/server/text.test.ts`：63 通过、0 失败、0 跳过；`npm run gen:contracts`：1 文件生成、198 文件不变。未运行其它测试和类型检查。
