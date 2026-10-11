# 联网调研参考

检索与阅读日期：2026-10-10。此页记录设计启发，不代表已选定依赖或采购服务。实际接入时重新核对版本、接口和部署条件。

新增平台级比较与适用边界见[同类项目调研](comparable-platforms.md)，其中核对了 OpenHands/Automation、Backstage、Nautobot/负载均衡、NetBox、Temporal，以及 Circle/Pi/OpenCode 的实际公开接入面。Pi 1.1.0 扩展文档已列出 `registerMcpServer()`；Stagehand 的版本索引已包含 V4，表中 V3 缓存资料仅作指定版本的设计参考。

| 来源 | 本次关注点 | 对项目的意义 |
|---|---|---|
| [Pi 1.1.0](https://github.com/earendil-works/pi/releases/tag/v1.1.0)、[版本化 README](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/README.md) | 可扩展 harness，交互、自动化、RPC、SDK | 固定基础能力对比对象；不能由功能列表推断 Circle 已对齐 |
| [Anthropic：长期任务 harness](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) | 增量推进、跨上下文交接、明确完成条件 | 长任务需要进展与验证机制 |
| [Anthropic：长期应用开发](https://www.anthropic.com/engineering/harness-design-long-running-apps) | 规划、生成、评估的分工，以及简化 harness 的实验 | 协作角色应以任务收益和成本决定 |
| [Anthropic：Managed Agents 架构](https://www.anthropic.com/engineering/managed-agents) | 会话、harness 和执行环境分离 | 可恢复的任务与可替换执行环境 |
| [Stripe Minions](https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents-part-2) | 确定性步骤与 agent 节点组合 | 研究哪些步骤程序化、哪些保留探索空间 |
| [LangGraph 持久化](https://docs.langchain.com/oss/javascript/langgraph/persistence)、[容错](https://docs.langchain.com/oss/javascript/langgraph/fault-tolerance) | 状态持久化、恢复、重试等公共原语 | 候选复用能力，尚未决定采用该框架 |
| [Temporal Activities](https://docs.temporal.io/activities) | 外部工作、幂等与重试边界 | 持久化不能自动保证外部副作用只发生一次 |
| [Playwright CLI](https://github.com/microsoft/playwright-cli)、[Playwright MCP](https://github.com/microsoft/playwright-mcp) | CLI/skill 与 MCP 的不同交互方式，结构化及坐标操作 | 根据任务与上下文成本选择接入方式 |
| [Playwright Test Agents](https://playwright.dev/docs/test-agents) | planner、generator、healer | 可参考分工；healer 文档允许输出 skipped，不能直接当成测试成功 |
| [Playwright Pytest 参考](https://playwright.dev/python/docs/test-runners) | 重复运行、隔离、截图与 trace | 是讨论中的验证模式参考；新自研实现遵守 TS 决定 |
| [Browser Use](https://docs.browser-use.com/open-source/customize/agent/all-parameters) | 视觉与结构化输出配置 | 多模态浏览器研究参考，不默认引入 Python 实现 |
| [Stagehand 缓存](https://docs.stagehand.dev/v3/best-practices/caching) | 操作缓存与重复执行 | 研究程序化复用及其失效条件 |
| [WebMCP](https://github.com/webmachinelearning/webmcp)、[实现状态](https://github.com/webmachinelearning/webmcp/blob/main/implementation-status.md) | 网站暴露结构化功能；浏览器支持存在差异 | 探索语义工具与 DOM/视觉的组合，不能假设普遍可用 |
| [BrowserGym](https://github.com/ServiceNow/BrowserGym)、[WorkArena++](https://arxiv.org/abs/2407.05291) | 多模态和组合式企业 Web 任务研究环境 | 补充通用研究评测，不能替代产品验收 |
| [Agent 评测指南](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) | 区分轨迹与最终环境结果 | 检查实际效果，不仅检查模型说了什么 |
| [Agent Skills](https://agentskills.io/home) | 专业方法、资源与脚本，按需加载 | 产品技能与平台通用机制分工 |
| [MCP Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)、[Resources](https://modelcontextprotocol.io/specification/2026-07-28/server/resources) | 工具和资料的协议语义 | MCP 是接入协议，tool 是可调用能力 |
| [MCP Tool Annotations](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/) | 提示与执行保证的边界 | 只读等提示不能代替授权与实际执行检查 |
| [MCP Tasks](https://modelcontextprotocol.io/extensions/tasks/overview) | 长任务与协作式取消，需要双方支持 | 取消请求与实际停止分别记录；现有客户端支持需核验 |
| [Claude Code Mods](https://code.claude.com/docs/en/plugins/mods/overview)、[事件接口](https://code.claude.com/docs/en/plugins/mods/events) | JS/TS 事件处理可以组织工具、模型与展示 | 程序化能力组合的参考，不将其 API 定为本项目标准 |
| [TypeSafe 构建指南](https://docs.typesafe.ai/concepts/how-to-build-with-system-one) | 程序组织流程，模型承担限定语义判断 | 知识核验与语义判定分工 |
| [PostgreSQL JSON](https://www.postgresql.org/docs/18/datatype-json.html)、[全文检索](https://www.postgresql.org/docs/18/textsearch-intro.html) | 关系/JSONB 和检索结构 | 知识事务存储基线；原始字节独立保存，中文分析需专门验收 |

## 使用这些资料的方式

先明确本项目任务与实际故障，再判断公共设计解决哪一部分问题。避免仅因为工具提供某个名词就增加平台层级，也避免在没有行为实验时宣称采用某框架后已解决恢复、幂等或安全边界。

上述链接可能演进。后续正式选型应在对应议题中记录所使用的版本、接口、替代方案和验收依据。
