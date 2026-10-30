---
permalink: /design/
nav_order: 4
---

# circle-hub 设计

设计的权威是通用模型 [contracts/model.json](https://github.com/circle-platforms/circle-hub/blob/main/contracts/model.json)，[通用模型](generic-model.md)是它的摘要；两者不一致时以模型为准。下面“现行”一表是摘要、检查单和研究提案；“已被取代”一表是旧服务器时期的设计篇，每篇开头注明被什么取代，只作记录保留。英文译文在 [en/](en/README.md)，两者有出入以中文为准。实现进度在 [Hub r4 进度](../hub-r4-progress.md)。

## 现行

| 篇 | 回答什么 |
|---|---|
| **[通用模型](generic-model.md)** | **11 组 73 个元素、三条不变量、词表、七个内核名字，以及第一个里程碑用到哪些** |
| [对象标准：五要素检查单](object-standard.md) | 四个对象就是四个家；五要素作设计检查单和记录页布局，不作存储分区 |
| [置真对接架构：理论基础、条件命题与产品研究框架](truth-docked-architecture.md) | 研究提案与数学审计：理论基础、条件命题与反例、未证义务；不是实现说明 |

## 已被取代

| 篇 | 原来回答什么 | 现在看哪里 |
|---|---|---|
| [审批与执行链](approvals-and-enforcement.md) | 变更集审批、执行链、错误码目录 | 许可 B04、发布校验 T02、边界校验 T03、两道强制边界 P11 |
| [角色与范围](roles.md) | 管理员 / 成员 / 访客按范围授予、两人规则 | 权限角色 R01（用户、管理员）、可见性 R02 |
| [术语与状态](vocabulary.md) | 旧术语表、状态枚举与颜色 | 模型的词表（生成在 `contracts/generated/vocabulary.ts`） |
| [层级与元素](levels-and-elements.md) | Circle 里的五层界面 | Circle 里不出现 Hub 专用界面；只读控制台（运行记录、知识库、任务包、系统管理四页） |
| [与 Circle 的集成](circle-integration.md) | hub 扩展 Circle 的菜单 | Circle 作为普通 MCP 客户端连接（D06） |
| [产品线包典范](product-line-pack.md) | `product-line/1` 产品线包 | 任务包 T01、发布记录与发布校验 T02 |
| [执行流迁入产品线包](execution-flow-packs.md) | 执行流与 `module-execute` | 效果写入、租约与执行器（B06、D04，D03 的写声明，D07 的执行器部分）由 `hub/dispatch` 实现；D03 的读部分与 D07 的资源部分由 connectors 包实现，MCP 注解按 D03 推出 |
| [harness 原语规范](harness-primitives.md) | `hub-*/1` 中立清单与适配器 | 六个 MCP 工具（D06）与任务包（T01） |
| [权限策略导出](permission-export.md) | `hub-permission/1` | R01；工具类别按 MCP 注解（D03、D06） |
| [harness 原语格式调查](harness-formats.md) | 五家 harness 的磁盘格式（2026-10-13 的调查） | 不再需要：Hub 不导入导出 harness 原语 |
| [handoff 到设计文档的对照表](handoff-map.md) | 两份交接文档并入设计篇的对照 | 两份交接都已成为历史记录 |

两条更早的原则仍然成立：确定内容交给脚本、其余交给模型判断并完整披露（ADR 0024）；本地取消、远端停止、任务交付分别记录（ADR 0025）。

## 许可

本页各表所列设计规范（含 [en/](en/README.md) 的英文译文）中的架构标准、设计图和术语按 [Creative Commons Attribution 4.0 International（CC BY 4.0）](https://creativecommons.org/licenses/by/4.0/deed.zh-hans)授权。

Copyright (c) 2026 qingshanfeihu。任何人在文档、产品或其他项目里引用、复用、改编或在其基础上创作这些规范，须按许可证要求保留对 Circle Hub 与 qingshanfeihu 的清楚署名、指向原文 <https://github.com/circle-platforms/circle-hub/tree/main/docs/design> 的链接、指向 CC BY 4.0 许可证的链接，并注明所作修改。可用的署名写法：

> 基于 qingshanfeihu 的 Circle Hub 设计规范，<https://github.com/circle-platforms/circle-hub/tree/main/docs/design>，按 CC BY 4.0 授权。

该许可覆盖作为文本和图的规范本身，不授予 Circle、Circle Hub 名称、Circle Logo 或应用图标的任何权利，见 [NOTICE](https://github.com/circle-platforms/circle-hub/blob/main/NOTICE)。`docs/` 的其余页面和代码按 [Apache License 2.0](https://github.com/circle-platforms/circle-hub/blob/main/LICENSE) 授权。
