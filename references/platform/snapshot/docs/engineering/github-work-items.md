# 产品待办和实施阶段

当前新增[两端代码同步、兼容发布与共同项目规划 #23](https://github.com/qingshanfeihu/infosec-platform/issues/23)，产品分工见 [ADR 0028](../decisions/0028-circle-server-split.md)，具体安排见[两端工程计划](../circle-server-plan.md)。普通用户通过 Circle 默认库的连接插件配置 server 地址，管理运维归 circle-server；插件不另建项目，继续使用现有私有总看板。同步与发布细则仍待规划，不表示 server 已创建或已部署。

现有[前端迁移 PR #22](https://github.com/qingshanfeihu/infosec-platform/pull/22)保留为未合并提案，本次没有合并、关闭或改写它。新的两端职责作为后续设计记录，不覆盖其中已登记的 ADR 0027。

工作统一在[私有产品看板](https://github.com/users/qingshanfeihu/projects/1)跟进。阶段路线见[实施规划](../implementation-roadmap.md)，工作方式和完成条件见[敏捷流程](agile-product-process.md)。

[完整任务总目标](https://github.com/qingshanfeihu/infosec-platform/issues/9)关联四个阶段，所有条目保留规划、实现和验收状态。

| 阶段 | GitHub 工作 |
|---|---|
| M1 | [M1 首个完整任务](https://github.com/qingshanfeihu/infosec-platform/issues/10) |
| M2 | [M2 诊断修复与回归](https://github.com/qingshanfeihu/infosec-platform/issues/11) |
| M3 | [M3 第二产品与能力组合](https://github.com/qingshanfeihu/infosec-platform/issues/12) |
| M4 | [M4 团队试用与发布维护](https://github.com/qingshanfeihu/infosec-platform/issues/13) |

桌面框架的源码复用和 A–E 接入边界单列为[工作项 #21](https://github.com/qingshanfeihu/infosec-platform/issues/21)，关联 M1，当前待规划。入口方向见[ZCode 研究](../research/zcode-desktop-framework.md)。

## 首个 Sprint 候选

先让用户通过桌面会话在合成环境复现一个产品问题并查看完整记录。身份和授权进入第一条链。以下候选尚未排期，不表示 Sprint 已经开始。

- [让不同人员在授权项目和环境中使用平台](https://github.com/qingshanfeihu/infosec-platform/issues/14)
- [通过桌面会话复现一个产品问题并交付证据](https://github.com/qingshanfeihu/infosec-platform/issues/15)

[Harness 界面评审](https://github.com/qingshanfeihu/infosec-platform/issues/17)仍在进行，demo 的浏览器检查不代替后端、模型或真实产品验收。恢复、网络环境、真实诊断和方法晋级等条目已分别关联到相应阶段。

<details>
<summary>原设计准备任务</summary>

# 下一步要做的工作

[平台总任务](https://github.com/qingshanfeihu/infosec-platform/issues/1)把相关工作连在一起。下面七项分别完善产品、使用过程和开发组织，它们已经作为 GitHub 子任务关联到总任务。当前是设计和准备工作，功能是否完成仍需要看实际结果。

## 接入不同产品并说明支持范围

整理不同产品的资料、操作方法和检查标准。让用户知道测过什么型号和版本，哪些地方还没有验证。

[查看这项工作](https://github.com/qingshanfeihu/infosec-platform/issues/2)。

## 把多种能力组合成一个完整任务

说明查资料、采集设备状态、修改代码和测试等工作怎样连接。遇到等待、异常或目标改变后，任务怎样继续。

[查看这项工作](https://github.com/qingshanfeihu/infosec-platform/issues/3)。

## 用户怎样提任务、看操作和接管

说明聊天、具体问题回应、实时设备操作和证据查看怎样配合。用户能够知道当前正在做什么，需要自己回应什么。

[查看这项工作](https://github.com/qingshanfeihu/infosec-platform/issues/4)。

## 逐项说明现有模块和函数做什么

先用自然语言解释每个模块和关键函数的用途，再把具体签名和代码位置作为核对资料。逐项补齐公开或会产生实际作用的函数说明。

[查看这项工作](https://github.com/qingshanfeihu/infosec-platform/issues/5)。

## 整理代码分工和各部分的依赖

说明资料、任务、实际操作、专业方法和用户入口分别由哪部分代码负责。把模拟设备、测试站和正式执行分开。

[查看这项工作](https://github.com/qingshanfeihu/infosec-platform/issues/6)。

## 检查不同产品和任务，并说明交付范围

说明每次检查使用了什么输入和环境，应该得到什么，实际观察到什么。明确不同产品、版本和任务组合的支持范围。

[查看这项工作](https://github.com/qingshanfeihu/infosec-platform/issues/7)。

## 整理文档、需求和开发流程

让用户问题、方案说明、代码修改和检查结果能够互相找到。首页介绍产品，主要说明用自然语言，详细代码资料按需要展开。

[查看这项工作](https://github.com/qingshanfeihu/infosec-platform/issues/8)。

完整说明见[平台怎样工作](../product-framework.md)和[项目里各部分做什么](../project-explanation.md)。任务状态以 GitHub 为准，具体代码和执行记录保留各自的依据。

</details>
