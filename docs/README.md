# circle-hub 文档

这是 GitHub 上 `docs/` 的目录页；文档站从 [index.md](index.md) 开始。

## 现行

- [Hub r4 简报](hub-r4-brief.md)：第一个里程碑的目标、范围、阶段、授权与边界、怎么验证，以及最终报告必须写明的证明不了的事。
- [Hub r4 架构](hub-r4-architecture.md)：给构建者的共享简报（英文）：硬规则、包归属、约定、用例评审场景、真实系统的结构、完成定义。
- [Hub r4 进度](hub-r4-progress.md)：阶段清单、记录和已定的决定。
- [设计](design/README.md)：[通用模型](design/generic-model.md)摘要、[对象标准：五要素检查单](design/object-standard.md)、研究提案和已被取代的旧设计篇；英文在 [design/en](design/en/README.md)。设计的权威是 [contracts/model.json](../contracts/model.json)。
- [兼容矩阵](compatibility.md)：circle、circle-hub、circle-packs 三个仓库彼此的要求。

## 历史记录

下列文档属于已退役的任务与审批服务器（截至 0.2.0），每篇开头有标注，只作记录保留，不描述现行代码。

### 阶段记录

- 第二阶段：[简报 r3](server-s2-brief-r3.md) · [简报 r2](server-s2-brief-r2.md) · [简报](server-s2-brief.md) · [进度与实际验收](server-s2-progress.md)
- 第一阶段：[优先级](server-s1-priority.md) · [进度](server-s1-progress.md) · [参考采用清单](server-s1-adoption.md) · [构建简报](server-build-brief.md)
- 其他：[harness 适配器任务书](harness-adapters-brief.md) · [B/C/D/E 融合提案](bcde-integration-plan.md)

进度记录里的通过数字只对当时的代码、合成来源、临时 PostgreSQL 和开发身份成立；真实来源的只读观察单独注明，不代表生产验收。

### 接口交接与命令

- [客户端接口交接](client-api-handoff.md)：Circle hub 扩展调用的 `/v1` 路由、请求与回应形状。
- [用例执行交接](case-execution-handoff.md)：经 MCP 网关执行工作簿的绑定、重核、回执与未知结果。
- [资源身份交接](resource-identity-handoff.md)：服务客户端、`/token`、`/v1/introspect`、规则分发。
- [模块安装](module-installation.md)：从 packs 仓库清单冻结字节并提交资产。
- [对象存储接口](object-storage-api.md) · [管理命令](admin-cli.md)

### 起点

[初始化记录](bootstrap.md) · [开源基础检查](open-source-readiness.md) · [验证记录](validation/)
