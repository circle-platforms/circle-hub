---
nav_order: 1
permalink: /
---

# circle-hub 文档

circle-hub 是 [Circle](https://circle-platforms.github.io/circle/) 的团队 hub：一个团队跑一个常驻进程，让大家的 Circle 共用同一套知识、任务、执行资源和方法，并让碰真实系统的 agent 留在人批准过的规则之内。源码、README 和更新日志在 [GitHub](https://github.com/circle-platforms/circle-hub)。

## 想做什么

| 想做什么 | 读 |
|---|---|
| 平台要解决什么、现在做到哪、接下来按什么顺序做 | [方向与路线图](roadmap.md)（[English](roadmap.en.md)） |
| 理解设计：对象标准、术语与状态、层级与元素、审批与执行链、角色 | [设计](design/README.md)（[English](design/en/README.md)） |
| 写 Circle 的 hub 扩展 | [客户端接口交接](client-api-handoff.md) |
| 通过 MCP 网关执行工作簿 | [用例执行交接](case-execution-handoff.md) |
| 服务客户端、令牌与规则分发 | [资源身份交接](resource-identity-handoff.md) |
| 从 packs 仓库装模块 | [模块安装交接](module-installation.md) · [产品线包典范](design/product-line-pack.md) |
| 对象存储接口与管理命令 | [对象存储接口](object-storage-api.md) · [管理命令](admin-cli.md) |
| 三个仓库彼此的要求与发布顺序 | [兼容矩阵](compatibility.md) |
| 阶段简报、进度与真实来源观察 | [第二阶段进度](server-s2-progress.md) · [简报 r2](server-s2-brief-r2.md) · [第一阶段进度](server-s1-progress.md) · [初始化记录](bootstrap.md) |

## 三个仓库

[circle](https://circle-platforms.github.io/circle/) 是 agent，circle-hub 是它登录的 hub，[circle-packs](https://circle-platforms.github.io/circle-packs/) 是装在 hub 上的技能包和产品线包。
