# 第一阶段参考采用清单

来源均固定在 infosec-platform `4ab6c5ea593eb1b1d71bed92374b3a013ba61ad9`，只读。以下是行为参考，新的生产目录没有 import 或执行原件。来源字节继续由 reference archive 检查独立验证。

| 源文件（references/platform/snapshot 下） | 采用行为与修改 | 新模块与全部调用方 | 新验收 |
|---|---|---|---|
| packages/contracts/src/ids.ts、vocab.ts、effects.ts、pending.ts | 保留分离身份、效果、结构化拒绝和修订绑定；ID 统一 task/inrev，操作词表加入有证据才能离开的 reconciled；增加标准操作和合成连接器清单 | packages/contracts；server、tasks、execution、knowledge、methods、connectors、worker、admin | tests/contracts/contracts.test.ts，八幕 HTTP 验收 |
| packages/platform-pg/src/service.ts、schema.ts | 同事务受理与交付门禁；重写为版本化迁移、可信认证上下文、tenant/scope/principal/action 幂等和持久 wakeups | packages/tasks、packages/storage；server API 和 runner | 第 1–4、6–7 幕，事务故障注入 |
| packages/runtime-eval/src/pgflow.ts | 行锁推进与持久唤醒；新流程固定版本、阶段效果与 outbox 同事务，不采用实验模块 | packages/tasks；apps/server 的 runner | 第 4 幕进程重启与事件补读 |
| packages/execution/src/control-plane.ts | 60/20 秒租约、单调 fence、未知冻结和执行前复核；全部状态进 PostgreSQL，统一契约词表 | packages/execution；server、worker | 第 5 幕 kill -9、独立回读、迟到报告；第 6 幕授权及主机身份复核 |
| packages/assessor/src/index.ts | 采用明确可比值才计算的行为参考；新 LBX 方法校验产品、版本、数值和引用修订，缺值/冲突返回 unknown，“有引用就支持”没有进入正式逻辑；脚本模型意见单独登记 | packages/methods/assessments.ts；server ProfessionalRunner 与 conclusions API | 第 7 幕原字节、缺值、当前修订清单及模型不能满足事实项 |
| docs/excel-mindmap-contract-v1.md；samples/v05/smp-v05-01-content.json、smp-v05-01-topic-tree.json、smp-v05-02.json | 采用冻结 IR、两表七列、DFS 成行和 partial 披露；新写 XMind zip/JSON 解析、规范化、ExcelJS 写出与 read-excel-file 独立回读；不取用历史 chain-v05 编译代码 | packages/methods/mindmap.ts、mindmap-verify.ts；独立 worker、server 验证 runner；tests/methods 和 tests/acceptance | 冻结 8 行逐格核对、合成 .xmind、错工作簿拒绝、未知元素 partial、无产物失败、重复制品和 API 权限 |

连接器框架、合成系统 SDK、HTTP 认证和 admin 命令采用本次 brief 的新契约。未采用 server-stub 的无认证 HTTP，不采用 llm-assessor 的 Python bridge，不取用 Circle 内核或旧 demo 的可选脑图工具。

脑图故事的当前生产调用方已核对：server main → Tasks/Knowledge/Execution；server 的 MindmapRunner → 源解析与独立读取核验；worker main → 新编译方法和独立读取核验；dev-stack → PostgreSQL 进程、server、worker。三者没有 import 归档模块。独立读取器不使用写入器的工作表对象、行数组或解析 API。

第 5–8 幕的新模块已完成合成验收。当前 D 的实际调用方为 HTTP API、ProfessionalRunner、规则轮询和独立 worker；C 的审批/交付/规则/管理入口统一由认证 HTTP 接入；B 的记录/快照/制品由这些受控模块使用；E 通过标准操作与角色绑定推进 LBX/缺陷方法。ConnectorSDK 在 worker 调用，C 的 ConnectorRegistry 管理可见范围及启停，没有从归档采用连接器运行链。

最终采用范围只证明本机、开发身份和合成产品/系统。Circle/Otty 观察单列，原件校验和业务行为各有独立记录。本清单不将归档模块分类、旧测试结果或本次合成结果转成真实设备/企业系统可用性。
