# 自动化用例的持久状态与执行顺序

依据：所有者 2026-11-12 任务书 A1，接续 it-channels 的已有改动。

允许修改：`contracts/src/product.ts`、`contracts/src/product.test.ts`、生成的产品及输入 schema；`hub/knowledge/command-policy.test.ts`；`packs/product/famx/README.md`；`packs/skill/command-tools/**`；`packs/workflow/case-compile/functions/{channels,checks,delivery,generate,workbook}.ts`、相关单文件测试及 `testing/channels.ts`；`tools/{assemble-delivery,generate-workbook,volume-order.test}.ts`；包声明、requirements、codes、生成的 command-tools 副本、本页及包 README。

产品规则按命令树路径声明留下的状态与不能同时使用的命令。留下状态的用例排到自动化用例 Excel 最后，其余顺序保持；同一用例或同一份 Excel 含互斥命令时拒绝，保留两侧用例、命令和原文依据。产品的真实声明由所有者另行提供，本项不采集真实设备数据。

子 agent 只执行 `node --test packs/workflow/case-compile/functions/channels.test.ts`；最终集成验证由集成者执行。模型与代码注册表不改，不接触部署、凭据、设备或测试床。
