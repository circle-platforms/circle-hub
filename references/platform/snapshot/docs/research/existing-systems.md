# 已有工程：经验与行为参考

观察日期：2026-10-10。

状态：只读源码调查。以下实现属于旧项目，不是 infosec-platform 已实现的功能。本轮没有运行原项目测试或设备任务。

## 基线

| 项目 | 本次检查的主线提交 | 定位 |
|---|---|---|
| Circle | f7ac6b03f326d717863dd55a74061923d9ec9910 | TypeScript 1.0.4，自有 agent loop；保留的 harness |
| InfoTest_Engine | 88c5bdba7f5e9515f711129cf05a201069ad0d33 | 专业知识、问答、评审、编译、上机验证与事实链参考 |
| compile-excel-skills | 52d6b73f10fc4f4c06be440e1b0d8b94121a1922 | 专业能力跨 harness 暴露与工具/skill 分工参考 |
| compile-excel-server | d49da8481616d6ec3e0e4eee296ebe438ff5bffa | 资料分发、身份、设备网关与远程执行参考 |

记录提交时，上述四个主工作树的 git status --short 均为空。另有未合并的 review、generic-fixes、evidence-fixes 工作树；其未提交实现不计入主线能力。

## 值得继承的设计经验

| 经验 | 原项目定位 | 可研究的通用契约 |
|---|---|---|
| 工具参数与实现单一来源 | compile skill：cex_client/tool_specs.json、tools.py；tools/gen_adapters.py | 共享工具语义、薄适配；Pi schema 生成，Circle/MCP 运行时读取定义 |
| 脚本保证结构，模型负责内容 | skills/compile-excel/SKILL.md、scripts/compile_excel.py | 模型判断与机械保证分工；防止产物结构导致漏跑 |
| 版本化资料供应 | server：registry.py；client：bundle.py、engine_env.py | 构建、清单、内容哈希、发布通道和消费基线 |
| 资源归属与防陈旧操作 | gateway/state.py、tools.py | 租约、续期、防陈旧令牌、执行端检查、共享资源互斥 |
| 远程执行独立于请求 | gateway/framework.py | 任务身份、runner、实际存活、完成状态、lost 结果 |
| 运行结果限定范围 | gateway/tools.py 的 case_results 路径 | 只消费本次运行及其报告目录的证据，识别过期或旁路结果 |
| 事实与运行状态分层 | InfoTest：compile_engine/facts.py、state.py | 入口信息、派生状态、产物引用、本轮凭据分别管理 |
| 无进展检查 | InfoTest：compile_engine/graph_progress.py | 以可观察状态判断循环；停止记录不自动签发责任归属 |
| 返工保持已验证基线 | compile skill：scripts/rework_gate.py、cex_client/fingerprints.py | 输入、初始化、变更范围与验证结果关联 |
| 独立评审与明确目标 | InfoTest：skills/test-list-review、config-answer、knowledge-researcher | 固定任务目标、来源约束、独立复核与未核事项 |

这些设计需要按新任务域重新检验。比如开发中共享依赖改变会使旧 PASS 失效，不能照搬“只返工失败案”；Web 等待外部事件也不能直接套用编译图的不动点条件。

## 已有迁移工作的经验

compile skill 的 tools/extract_engine.py、cex_core/engine/MANIFEST.json 和 tools/engine_parity.py 记录了来源、依赖边界与行为对照。docs/engine-parity.md 还列出没有移植的 worker 会话、重复拒收计数和部分裁决行为。

需要继承的是：明确抽取范围、完整记录依赖、对拍行为并披露差异。该工程使用的 Python 抽取副本不是新 TS 系统的实现方案。重新实现时要区分正确行为、历史缺陷和环境缺失造成的差异。

## 尚在候选工作树中的经验

读取了 compile-excel-skills-generic-fixes/docs/generic-repair-validation.md、cex_client/case_evidence.py、history.py，以及 server evidence-fixes 中的日志读取改动。它们涉及：

- 计数判据的执行载体与来源绑定。
- 退出码与业务语义覆盖范围的差别。
- CRLF 与原始观察窗口对正则判断的影响。
- 输入、初始化、执行语境和跨轮结果翻转。
- 证据改变、身份错配、旧复核失效及拒绝结果的持续约束。
- 同一规则需要被提交、出件、返工和报告等所有消费者采用。

候选记录包含既往本地验证及其跳过项和限制。本轮没有复跑；未据此宣称已合并、已部署或真机验收完成。

## Circle 接口观察

- src/types.ts 的 Tool 主要返回字符串；ToolContext 提供会话身份和取消信号等。
- src/extensions.ts 提供 tool_boundary middleware；普通事件回调失败记录警告，不阻断执行。
- src/mcp_loader.ts 主要枚举与调用 tools；不能据此假定已经完整支持 resources 或 MCP Tasks。
- 消息恢复不等于远程业务任务恢复。当前基础接口与新任务/操作契约的结合需要单独设计。

上述是固定基线下的静态观察，不能代替行为实验或全量能力对齐验收。
