# 知识库 V1：Mods 与既有发布过程依据

阅读与核对日期：2026-10-10。旧项目只读，未运行生成器、发布、模型或设备任务。

## Claude Code mods

本轮核实用户提到的是 2026-10-01 发布的 Claude Code mods。官方说明 mods 是插件中的 JS/TS 事件处理函数，可观察或接管提示、工具调用和界面事件，代码也可直接处理命令。

可借鉴的是在明确节点组合代码与模型能力。例如精确知识查询由程序完成，需要语义判读时调用模型，再由程序核验引用和组织展示。没有将 Claude mods API 定为本项目接口，也没有在本轮安装或执行 mod。

来源：[官方发布文章](https://claude.com/resources/articles/claude-code-mods)、[Mods overview](https://code.claude.com/docs/en/plugins/mods/overview)、[事件接口](https://code.claude.com/docs/en/plugins/mods/events)。

## InfoTest 的程序与语义分工

基线提交：88c5bdba7f5e9515f711129cf05a201069ad0d33。

- docs/footprint.md：语义分类、命令关联和同义判断交模型；层级、路由、落盘与结构去重交代码。
- main/ist_core/memory/footprint/merger.py：核对原文或设备证据等来源。实现中存在规范化和近似覆盖分支，不能把所有旧检查泛称为严格逐字证明。
- main/kms/manual_catalog_store.py 与 footprint/catalog_join.py：catalog 和手册身份、版本及命令引用的关联。
- scripts/regen_knowledge_base.py：读取原输入、再生成派生资料并报告差异。语义一致性提示需要进一步分析，程序不直接替领域解释作决定。

经验是把结构和语义边界具体到每个决策点。新 TS 平台要推广到架构、代码、测试、商务和友商知识，不能沿用“只收 CLI 事实”的旧领域限制。

## InfoTest 软件发布

静态核对 .github/workflows/release.yml：tag 与 pyproject 版本一致检查、安装与 packaging smoke、构建、源码归档、SHA256SUMS、创建 GitHub Release 都由程序执行。

这证明仓库配置了确定性发布步骤，不证明本轮已执行发布，也不证明该 workflow 自动进行了完整测试或设备验收。模型可帮助解释差异和准备工作，但完成记录需要实际执行回执。

## 资料生成与发布

compile-excel-server 基线：d49da8481616d6ec3e0e4eee296ebe438ff5bffa。

静态核对 registry.py、generators/chain.py 和 docs/publishing.md：

- 生成链记录输入、依赖、参数和输出，各步骤失败与缺席应如实披露。
- 内容寻址、清单校验、candidate/stable 通道和客户端哈希核对。
- 发布在事务中核对预期旧指针，拒绝覆盖并发发布或回滚；相同内容可空操作。
- 原项目保留 legacy-import 的部分兼容例外。新平台不自动继承其例外。

V1 继承这类发布与可复现经验，用 TS 重写实现。发布完整性与语义正确性分别表达。

## 进一步来源

- [TypeSafe：构建模式](https://docs.typesafe.ai/concepts/how-to-build-with-system-one)
- [TypeSafe：实体对齐](https://docs.typesafe.ai/cookbooks/entity_alignment)
- [TypeSafe：引用核对](https://docs.typesafe.ai/cookbooks/citation_check)
- [PostgreSQL JSON 与 JSONB](https://www.postgresql.org/docs/18/datatype-json.html)

这些是设计依据，不是本产品上的质量测量或生产能力证明。
