# 知识、能力与证据

状态：内容范围已确认，V1 设计已按本轮要求收敛；业务实现尚未开始。

正式设计见[产品知识库 V1](knowledge-v1.md)。本页保留阅读入口和范围说明，避免与设计正文重复维护。

## 方向与范围

知识库覆盖产品、型号、功能、架构、代码、测试、缺陷、商务、许可、报价、操作与友商等产品相关内容。CLI/XML 与 footprint 是来源和结构视图，不承担全库唯一分类。

资料来源统一有助于收集与追踪；不同内容的性质、条件、版本、时间和验证方式仍需分别表达。

## V1 的设计主线

- 程序承担可复现解析、核验、权限与范围、存储、索引、依赖失效和发布。
- Jev/LLM 承担语义理解、关联、排序和复核，判断保留输入、依据、版本、概率与未知。
- 原始来源、证据、对象、声明、判断和快照分别保存，关系是有依据的声明。
- PostgreSQL 保存事务与结构化知识，对象存储保存原始字节；索引是可重建投影。
- 查询返回共用证据包；发布采用不可变快照和 candidate/stable 指针。

准确字段、状态、处理流程、权限边界和验收均以 V1 正文为准。

## 决策与研究材料

- [ADR 0001：全 TS 重写与项目方向](decisions/0001-project-direction.md)
- [ADR 0002：产品级知识范围](decisions/0002-product-knowledge-scope.md)
- [ADR 0003：知识库 V1 基线](decisions/0003-knowledge-v1-baseline.md)
- [知识主机盘点](research/knowledge-inventory.md)
- [Mods、InfoTest 与发布过程依据](research/knowledge-design-basis.md)
- [逐项实现议程](discussion/topics.md)

原始业务资料、证据与连接凭据不进入源码仓库。旧项目作为经验、数据和验证参考；新自研代码用 TS 实现。
