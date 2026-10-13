# circle-hub 文档

## 设计

[docs/design](design/README.md)：对象标准与数据流、术语与状态、层级与元素、审批与执行链、角色与范围、与 Circle 的集成、产品线包典范。这是后续开发和适配的依据。英文译文在 [design/en](design/en/README.md)。三个仓库之间谁依赖谁、以什么为准，见[兼容矩阵](compatibility.md)。

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
