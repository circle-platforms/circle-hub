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
| 从零搭建 Hub、用部署定义 `apply` 并跑通首个工作流（十分钟上手） | [十分钟上手](quickstart.md) · [English](quickstart.en.md) |
| 日常建成员、分团队权限、发布技能/工作流、登记测试环境与升降级 | [管理员手册](admin-guide.md) |
| 成员登录控制台、连接 Circle、占测试环境与完成用例编译 | [成员手册](member-guide.md) |
| 修改工作流或技能的文案、规则并升级发布 | [改一个工作流或技能怎么做](edit-pack.md) |
| 不兼容更新后重建、清理指定范围数据或保留配置重装 | [重置和重建](reset.md) |
| 了解这个里程碑的工作与阶段 | [Hub r4 进度](hub-r4-progress.md) |
| 参与构建：硬规则、包归属、约定、完成定义 | [Hub r4 架构](hub-r4-architecture.md)（英文） |
| 理解设计：11 组元素、三条不变量、词表、内核 | [通用模型](design/generic-model.md)（[English](design/en/generic-model.md)） |
| 设计新组件或接入新系统时逐条自查 | [对象标准：五要素检查单](design/object-standard.md) |
| 看进度和已定的决定 | [Hub r4 进度](hub-r4-progress.md) |
| 三个仓库彼此的要求 | [兼容矩阵](compatibility.md) |
| 实现知识与记忆同步的客户端或服务器 | [同步协议 v1](protocols/knowledge-sync-v1.md)（英文规范；[中文概述](protocols/knowledge-sync-v1.zh-CN.md)） |
| 设计索引，以及现行设计篇 | [设计](design/README.md)（[English](design/en/README.md)） |

## 历史记录

已退役的任务与审批服务器（截至 0.2.0）的历史简报、进度与交接文档保存在 Git 历史中，不留在当前工作树里。

## 相关仓库

[circle](https://circle-platforms.github.io/circle/) 是 agent，circle-hub 是它当作普通 MCP 服务器连接的 Hub。任务包放在本仓库的 `packs/` 下。
