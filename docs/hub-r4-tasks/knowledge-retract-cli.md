# 任务：管理员撤回喂入条目没有命令入口

依据：决定 73（操作记录进喂入层，管理员可撤回）、`docs/hub-r5-tests.md` T6-3、所有者的规矩"未知必须写明缺的事实和下一步动作"。本任务关掉真实层 T6-3 会撞到的缺口。

## 现象

`FeedingLayer.retract`（`hub/knowledge/feeding.ts`）只有管理员能调，接受 `retraction@1`（`objects`、`entries`、`runs` 三选一，`by`、`at`、一行 `reason`），追加一条撤回记录；读侧据此给出 `grounds_withdrawn` / 喂入 `invalid`，原记录不改不删。合成验收（`tests/acceptance/42-r5-t4-2-operations.test.ts` 的 T6-3）直接调这个方法。但线上没有任何管理员入口能调到它：`circle-hub` 的命令里没有撤回，MCP 的六个工具也不应该有（撤回是管理动作，不是模型动作）。部署后的 Hub 上，管理员撤回一条操作教训或回注条目，只能写脚本进进程——这不是产品能力。`hub/knowledge/README.md` 里"`grounds_withdrawn` 无撤回记录通道"那一行也已过时。

## 要做的

1. **命令** `circle-hub knowledge retract (--entry <记录摘要> | --run <运行> | --object <对象摘要>)… --reason <一行原因>`（`hub/server/cli-admin.ts` 的 `knowledgeCommand`，用法串 `KNOWLEDGE_USAGE` 同步）：
   - 只有管理员（用现有的操作令牌身份，同 `knowledge sync`）；`--reason` 必填、单行，缺失或含换行被拒；三种目标至少一个，可重复，也可混用——混用时每种目标各追加一条 `retraction@1`（`retraction@1` 本身只允许三选一），输出列出每条。
   - `--entry` 接受喂入条目的记录摘要，也接受 `knowledge-contribution@1` 回注记录的摘要（`FeedingLayer.retract` 的 `retractionTargets` 已接受这两种），不另做转换。
   - 目标不存在或不是可撤回的对象时，用 `retractionTargets` 现有的说明（含修正提示）原样报出，不写记录。
   - **已撤回的目标不重复追加**：写之前用读侧同一套判断（`withdrawals` 的逻辑，需要的话在 `hub/knowledge` 里加一个只读方法，经 `api.ts` 暴露）查出已有撤回记录，全部目标都已撤回时输出"这些目标已撤回（撤回记录 <前 12 位>），没有追加"，退出码 0；部分已撤回的，只追加其余的并说明哪些跳过。
   - 成功输出（中文）：每条撤回记录的摘要前 12 位、目标种类和个数、原因；最后一行写"原记录未改动；读侧将显示根据已撤回"。
2. **接线**：`FeedingLayer` 现在从命令入口够不到的话，在 `hub/knowledge/api.ts` 加窄的包装（管理员身份、不绕过 `retract` 的任何检查），不在 `hub/server` 里重复实现撤回逻辑。撤回记录里的 `at` 用命令执行时的时间（注入时钟，测试里可固定），`by` 是操作令牌的账号。
3. **文档**：`hub/knowledge/README.md` 里 `grounds_withdrawn` 那一行改成现状（撤回记录通道 = 管理员命令 `knowledge retract`，数据来源已有），并加一小节说明用法与"撤回不删除、可由读侧看到"；`hub/server` 的 README（或命令用法所在的文档）补这条命令；`docs/hub-r5-runbook-dispatch.md` 不动。
4. **测试（合成）**：
   - 命令层：非管理员被拒；缺 `--reason`、多行 `--reason`、没有目标各自被拒且不写记录；撤回一个 pitfall 回注记录 → 写一条记录，随后 `get_nodes` 读该条目显示 `grounds_withdrawn`，另一端（observation）仍 `valid`，原回注记录与原树字节不变；`--run` 与 `--object` 各一例；混用三种目标写三条记录；对同一目标再撤回一次 → 不追加、说明已撤回；不存在的目标 → 报出现有说明、不写记录。
   - 把 `tests/acceptance/42-r5-t4-2-operations.test.ts` 的 T6-3 撤回步骤改为走这条命令的入口函数（保留原来对读侧的全部断言，只许加法或把调用换成命令入口，不许放松断言）。
   - 现有的 `cli-commands.test.ts` 用法串断言同步更新。

## 分支、路径和规矩

- 分支和工作树：`knowledge-retract-cli`，目录 `cursor-trees/knowledge-retract-cli`（集成者已从 hub-redesign 开出，依赖已链接）。
- 可以改的路径：`hub/server/cli-admin.ts`、`hub/server/cli-commands.test.ts` 及命令测试，`hub/knowledge/api.ts`、`hub/knowledge/feeding.ts`（只许加只读方法或窄包装，不改 `retract` 的检查）及它们的测试，`hub/knowledge/README.md`、`hub/server/README.md`，`tests/acceptance/42-r5-t4-2-operations.test.ts`。别的路径要改先说明理由。
- 规则：同前（不推送、不建 PR、不发布、不部署；不碰线上 Hub、钥匙串、环境配置文件和真实系统；测试只用合成数据；`git commit -s`，只暂存明确的路径）。枚举和文字不自造词；不用关键词匹配做判断。
- 验证：`npx tsc --noEmit`；`node tools/gen-contracts.ts --check`；`node --test --test-concurrency=2` 对 `hub/server/**`、`hub/knowledge/**`、`tests/acceptance/42-r5-t4-2-operations.test.ts` 和 `.github/checks/*.test.ts`；合入前合并最新 hub-redesign 再跑相关部分并报计数。

完成后在终端里回报：提交号、各项测试数量、改了哪些路径、没做完或拿不准的地方。
