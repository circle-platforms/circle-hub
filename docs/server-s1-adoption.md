# 第一阶段参考采用清单

来源均固定在 infosec-platform `4ab6c5ea593eb1b1d71bed92374b3a013ba61ad9`，只读。以下是行为参考，新的生产目录没有 import 或执行原件。来源字节继续由 reference archive 检查独立验证。

| 源文件（references/platform/snapshot 下） | 采用行为与修改 | 新模块与全部调用方 | 新验收 |
|---|---|---|---|
| packages/contracts/src/ids.ts、vocab.ts、effects.ts、pending.ts | 保留分离身份、效果、结构化拒绝和修订绑定；ID 统一 task/inrev，操作词表加入有证据才能离开的 reconciled；增加标准操作和合成连接器清单 | packages/contracts；server、tasks、execution、knowledge、methods、connectors、worker、admin | tests/contracts/contracts.test.ts，八幕 HTTP 验收 |
| packages/platform-pg/src/service.ts、schema.ts | 同事务受理与交付门禁；重写为版本化迁移、可信认证上下文、tenant/scope/principal/action 幂等和持久 wakeups | packages/tasks、packages/storage；server API 和 runner | 第 1–4、6–7 幕，事务故障注入 |
| packages/runtime-eval/src/pgflow.ts | 行锁推进与持久唤醒；新流程固定版本、阶段效果与 outbox 同事务，不采用实验模块 | packages/tasks；apps/server 的 runner | 第 4 幕进程重启与事件补读 |
| packages/execution/src/control-plane.ts | 60/20 秒租约、单调 fence、未知冻结和执行前复核；全部状态进 PostgreSQL，统一契约词表 | packages/execution；server、worker | 第 5 幕 kill -9、独立回读、迟到报告；第 6 幕授权及主机身份复核 |
| packages/assessor/src/index.ts | 仅采用明确值可比的规则判断；移除“有引用就支持”的逻辑，不把脚本模型当事实 | packages/methods；server runner | 第 7 幕原字节、缺值、模型不能满足事实清单 |

连接器框架、合成系统 SDK、HTTP 认证和 admin 命令采用本次 brief 的新契约。未采用 server-stub 的无认证 HTTP，不采用 llm-assessor 的 Python bridge，不取用 Circle 内核或旧 demo 的可选脑图工具。

调用方和验收项在实现收口时按实际代码复核；此清单不是归档模块已经具备生产能力的声明。
