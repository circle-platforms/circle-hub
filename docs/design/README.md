---
permalink: /design/
nav_order: 2
---

# circle-hub 设计

2026-10-13 定稿的设计，后续开发和旧能力适配都以它为准。每一篇都只写决定和理由，不写实现进度；实现进度在[阶段记录](../README.md#阶段记录)。英文译文在 [en/](en/README.md)，两者有出入以中文为准。

| 篇 | 回答什么 |
|---|---|
| [对象标准与数据流](object-standard.md) | 四个对象由哪五样组成；一件工作怎么走过 A C E B D；新能力怎么填适配单 |
| [术语与状态](vocabulary.md) | 固定的中英术语；状态枚举与颜色；规模下的处理与显示规则 |
| [层级与元素](levels-and-elements.md) | 入口是会话；五层逐层深入；每层用什么图、表、描述、按钮；十二个动作词 |
| [审批与执行链](approvals-and-enforcement.md) | 审批只在变更集；运行走执行链，结果只有通过 / 报错 / 未知；平台不是审批人 |
| [角色与范围](roles.md) | 管理员 / 成员 / 访客按范围授予；两人规则；单管理员的自决；机器身份 |
| [与 Circle 的集成](circle-integration.md) | hub 扩展 Circle 的菜单而不是另开一节；同步模型；只装 Circle 看不到什么 |
| [产品线包典范](product-line-pack.md) | 一条产品线接进来的交付物：目录布局、适配单、验收清单，以合成产品线为样例 |
| [harness 原语规范](harness-primitives.md) | hub 治理任何 harness 的原语：治理 / 不治理清单、中立清单、每个 harness 的导入导出适配器、hub 自己作为 MCP server 的通用传输、原语在四对象五要素里的位置 |
| [权限策略导出](permission-export.md) | harness 中立的第 4 条：hub-permission/1 从范围上的角色预设和 Tool 标注算出；Claude Code、Codex CLI、OpenCode、Gemini CLI、Cursor 各一张映射表与示例配置；表达不了的部分如实列出 |
| [harness 原语格式调查](harness-formats.md) | Claude Code、Codex CLI、OpenCode、Gemini CLI、Cursor 五家的 Skill / Command / Agent / Instruction / Hook / MCP server 磁盘格式：路径、字段、能映射到中立清单的部分与映射不了的部分，每条带来源；适配器与 knownCompatible 的依据 |

两条贯穿全部的原则来自更早的决定：确定内容交给脚本、其余交给模型判定并完整披露（ADR 0024）；本地取消、远端停止、任务交付分别记录（ADR 0025）。

## 许可

上表所列设计规范（含 [en/](en/README.md) 的英文译文）中的架构标准、设计图和术语按 [Creative Commons Attribution 4.0 International（CC BY 4.0）](https://creativecommons.org/licenses/by/4.0/deed.zh-hans)授权。

Copyright (c) 2026 qingshanfeihu。任何人在文档、产品或其他项目里引用、复用、改编或在其基础上创作这些规范，须按许可证要求保留对 Circle Hub 与 qingshanfeihu 的清楚署名、指向原文 <https://github.com/circle-platforms/circle-hub/tree/main/docs/design> 的链接、指向 CC BY 4.0 许可证的链接，并注明所作修改。可用的署名写法：

> 基于 qingshanfeihu 的 Circle Hub 设计规范，<https://github.com/circle-platforms/circle-hub/tree/main/docs/design>，按 CC BY 4.0 授权。

该许可覆盖作为文本和图的规范本身，不授予 Circle、Circle Hub 名称、Circle Logo 或应用图标的任何权利，见 [NOTICE](../../NOTICE)。`docs/` 的其余页面和代码按 [Apache License 2.0](../../LICENSE) 授权。
