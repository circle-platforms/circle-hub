# @infosec/chain-v05

V05 链纵切（P2-2）：人工脑图编译为 Excel。实现严格按已冻结的 [Excel 输出契约 V1](../../docs/excel-mindmap-contract-v1.md)：

- 输入两路：主题树 JSON（IR 直接形态）与 XMind `content.json`（sheet → rootTopic → children.attached，notes 取 `notes.plain.content`）；多 sheet、detached 子节点、未知主题属性等未覆盖形态一律记入未映射清单（契约第 5 节延后项不冒充支持）。
- 编译只经 IR（主题树 + 标题规范化 + SHA-256）；成行规则、七列定义、空字符串规则、深度数值单元格、两张工作表与 `说明` 元数据均按契约第 3 节。
- 结果三态：不可解析整体失败（无工作簿）；含未映射元素为 `partial`（清单同时写入响应与 `说明` 表）；其余 `succeeded`。
- 一致性锚点：编译冻结样本 SMP-V05-01 必须逐格等于 SMP-V05-02 的 8 行期望，测试从仓库 `samples/v05/` 读取冻结样本（可用环境变量 `V05_SAMPLES_DIR` 覆盖路径）。

本地验证：`npm install && npm run typecheck && npm test`。
