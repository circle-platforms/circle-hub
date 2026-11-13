---
permalink: /design/
nav_order: 4
---

# circle-hub 设计

设计的权威是通用模型 [contracts/model.json](https://github.com/circle-platforms/circle-hub/blob/main/contracts/model.json)，[通用模型](generic-model.md)是它的摘要；两者不一致时以模型为准。下面“现行”一表是摘要、检查单和交互规范；已被取代的旧设计篇保存在 Git 历史中。英文译文在 [en/](en/README.md)，两者有出入以中文为准。实现进度在 [Hub r4 进度](../hub-r4-progress.md)。

## 现行

| 篇 | 回答什么 |
|---|---|
| [Circle 设计规范](circle-design-system/README.md) | 决定 141、142：Circle 工作台与控制台共用的视觉规范——石墨主题的深浅两套设定、三栏结构、组件与交互、图表与界面用语（[效果图](https://github.com/circle-platforms/circle/blob/main/docs/design/circle-design-system-screens.md)，在 Circle 仓库） |
| [控制台导航](console-navigation.md) | 决定 130 的八项导航、团队与设置的职责 |
| [知识库与工作流：个人与团队](knowledge-workflows.md) | 决定 131 的完整方案：个人与团队空间、同步、授权、提交共享、索引与版本，工作流（原任务包）与通用技能，以及分阶段实施 |
| **[通用模型](generic-model.md)** | **11 组 73 个元素、三条不变量、词表、七个内核名字，以及第一个里程碑用到哪些** |
| [对象标准：五要素检查单](object-standard.md) | 四个对象就是四个家；五要素作设计检查单和记录页布局，不作存储分区 |

## 已被取代

| 篇 | 原来回答什么 | 现在看哪里 |
|---|---|---|
| [个人与团队知识库整合调研](personal-team-knowledge.md) | 第一轮的需求与同类项目调研；个人只放 Circle 本地的旧建议已失效 | [知识库与工作流：个人与团队](knowledge-workflows.md)（决定 131） |

两条更早的原则仍然成立：确定内容交给脚本、其余交给模型判断并完整披露（ADR 0024）；本地取消、远端停止、任务交付分别记录（ADR 0025）。

## 许可

本页各表所列设计规范（含 [en/](en/README.md) 的英文译文）中的架构标准、设计图和术语按 [Creative Commons Attribution 4.0 International（CC BY 4.0）](https://creativecommons.org/licenses/by/4.0/deed.zh-hans)授权。

Copyright (c) 2026 qingshanfeihu。任何人在文档、产品或其他项目里引用、复用、改编或在其基础上创作这些规范，须按许可证要求保留对 Circle Hub 与 qingshanfeihu 的清楚署名、指向原文 <https://github.com/circle-platforms/circle-hub/tree/main/docs/design> 的链接、指向 CC BY 4.0 许可证的链接，并注明所作修改。可用的署名写法：

> 基于 qingshanfeihu 的 Circle Hub 设计规范，<https://github.com/circle-platforms/circle-hub/tree/main/docs/design>，按 CC BY 4.0 授权。

该许可覆盖作为文本和图的规范本身，不授予 Circle、Circle Hub 名称、Circle Logo 或应用图标的任何权利，见 [NOTICE](https://github.com/circle-platforms/circle-hub/blob/main/NOTICE)。`docs/` 的其余页面和代码按 [Apache License 2.0](https://github.com/circle-platforms/circle-hub/blob/main/LICENSE) 授权。
