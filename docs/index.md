---
nav_order: 1
permalink: /
---

# circle-hub 文档

circle-hub 正在重建为一个标准 MCP 服务器。模型在客户端（例如 [Circle](https://circle-platforms.github.io/circle/)）里工作；Hub 分发任务包，在边界校验交回的结果并留下记录，为每条产品线的每个版本维护一棵知识树。Hub 不生成内容。源码、README 和更新日志在 [GitHub](https://github.com/circle-platforms/circle-hub)。

第一个里程碑还在建设中。通用模型、由它生成的合约和架构简报已经就位，第一阶段的各个包正在建设；MCP 服务器、控制台、任务包和持久部署在后面几个阶段。哪些部分已经落地、复核过，见 [Hub r4 进度](hub-r4-progress.md)。

## 想做什么

| 想做什么 | 读 |
|---|---|
| 了解这个里程碑做什么、不做什么，授权与边界 | [Hub r4 简报](hub-r4-brief.md) |
| 参与构建：硬规则、包归属、约定、完成定义 | [Hub r4 架构](hub-r4-architecture.md)（英文） |
| 理解设计：11 组元素、三条不变量、词表、内核 | [通用模型](design/generic-model.md)（[English](design/en/generic-model.md)） |
| 设计新组件或接入新系统时逐条自查 | [对象标准：五要素检查单](design/object-standard.md) |
| 看进度和已定的决定 | [Hub r4 进度](hub-r4-progress.md) |
| 研究背景 | [置真对接架构](design/truth-docked-architecture.md)（研究提案，不是实现说明） |
| 三个仓库彼此的要求 | [兼容矩阵](compatibility.md) |
| 设计索引，以及已被取代的旧设计篇 | [设计](design/README.md)（[English](design/en/README.md)） |

## 历史记录

下列文档属于已退役的任务与审批服务器（截至 0.2.0），每篇开头有标注，只作记录保留，不描述现行代码：

- 简报与提案：[第二阶段简报 r3](server-s2-brief-r3.md) · [r2](server-s2-brief-r2.md) · [初版](server-s2-brief.md) · [第一阶段构建简报](server-build-brief.md) · [第一阶段优先级](server-s1-priority.md) · [参考采用清单](server-s1-adoption.md) · [harness 适配器任务书](harness-adapters-brief.md) · [B/C/D/E 融合提案](bcde-integration-plan.md)
- 进度：[第二阶段进度](server-s2-progress.md) · [第一阶段进度](server-s1-progress.md)
- 接口交接与命令：[客户端接口交接](client-api-handoff.md) · [用例执行交接](case-execution-handoff.md) · [资源身份交接](resource-identity-handoff.md) · [模块安装](module-installation.md) · [对象存储接口](object-storage-api.md) · [管理命令](admin-cli.md)
- 起点：[初始化记录](bootstrap.md)

## 三个仓库

[circle](https://circle-platforms.github.io/circle/) 是 agent，circle-hub 是它当作普通 MCP 服务器连接的 Hub，[circle-packs](https://circle-platforms.github.io/circle-packs/) 存放已退役服务器用的技能包和产品线包。
