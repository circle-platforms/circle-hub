# circle-hub 文档

## 设计

[docs/design](design/README.md)：对象标准与数据流、术语与状态、层级与元素、审批与执行链、角色与范围、与 Circle 的集成、产品线包典范，以及[置真对接架构的理论基础与数学审计](design/truth-docked-architecture.md)。后者是研究提案，包含条件命题、反例和未证义务，不替代现行契约或宣称已有整体正确性证明。英文译文在 [design/en](design/en/README.md)（[Truth-Docked Architecture](design/en/truth-docked-architecture.md)）。三个仓库之间谁依赖谁、以什么为准，见[兼容矩阵](compatibility.md)。

## 迁移方案

[既有能力迁入 Hub 的完整方案](hub-migration-plan.md)（[English](hub-migration-plan.en.md)）：工作流、脑图编译、PLM 查询、用例评审及相关能力的目标架构、前端与协议、部署、分阶段迁移和验收；[75 项需求覆盖附录](hub-migration-coverage.md)。这是待实施提案，不替代现行契约或表示已部署。

## 接口交接

- [客户端接口交接](client-api-handoff.md)：Circle 扩展调用的每个路由、请求与回应形状。
- [用例执行交接](case-execution-handoff.md)：通过 MCP 网关执行工作簿的绑定、重核、回执与未知结果。
- [资源身份交接](resource-identity-handoff.md)：服务客户端、`/token`、`/v1/introspect`、规则分发。
- [模块安装交接](module-installation.md)：从 packs 仓库清单冻结字节并提交资产。
- [对象存储接口](object-storage-api.md) · [管理命令](admin-cli.md)

## 阶段记录

- 第二阶段：[简报 r3（当前）](server-s2-brief-r3.md) · [简报 r2](server-s2-brief-r2.md) · [简报](server-s2-brief.md) · [进度与实际验收](server-s2-progress.md)
- 第一阶段：[优先级](server-s1-priority.md) · [进度](server-s1-progress.md) · [参考采用清单](server-s1-adoption.md) · [构建简报](server-build-brief.md)
- 起点：[初始化记录](bootstrap.md) · [B/C/D/E 融合提案](bcde-integration-plan.md) · [开源基础检查](open-source-readiness.md) · [验证记录](validation/)

进度记录里的通过数字只覆盖合成来源、临时 PostgreSQL 和开发身份；真实来源的只读观察单独注明，不代表生产验收。
