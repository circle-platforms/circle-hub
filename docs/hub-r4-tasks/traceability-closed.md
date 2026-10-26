# 任务：追溯矩阵读缺陷系统里的状态，单独数出已关闭的缺陷

目标要的是“已关闭缺陷有没有回归用例”。架构 6a 第 6 项写的是“defect or requirement ↔ case documents (ids in titles, PLM status)”，6b 写“the matrix equals an independent join of closed defects and the case documents' ids”。现在的追溯包只用构建站发布说明里的缺陷条目（发布说明写的“已修复”“已知”），没读缺陷系统里的状态，所以说不出哪些缺陷已关闭。

- 分支和工作树：`hub-trace-closed`，目录 `circle-hub-trace-closed`（依赖已装好）
- 可以改的路径：`packs/system/plm/**`、`packs/workflow/traceability/**`、`scripts/real/accept/traceability*.ts`、`scripts/real/gold/**`（含测试、README、SKILL；改过的包升一个小版本并重新签）。别的路径不动；核心缺什么先回报。
- 先读：`AGENTS.md`；`packs/system/plm/system.json` 和 `functions/plm.ts`（`detailPlan`、`detailProject`）；`contracts/src/pack.ts` 的 `expected_sources`（包函数按已绑定的输入列出要再绑定的外部对象）以及 `packs/workflow/case-review` 怎么用它按编号绑定缺陷记录；`packs/workflow/traceability/`（`functions/matrix.ts`、`check.ts`、`counts.ts`、SKILL、README）。
- 规则：同前（不推送、不建 PR、不发布、不部署，不碰 7420、钥匙串、环境配置文件和任何真实系统；测试只用合成数据；`git commit -s`，合并用 `git merge --signoff`）。

## 要做的

1. PLM 系统包加批量详情：外部标识 `plm:bugs:<编号>+<编号>+…`（每个标识最多 50 个编号，按数值排序去重），一次请求 `{"bug_ids":[…]}`，走已在白名单里的缺陷详情路由；内容是每个编号的 `{id, status, title}`。应答里没有的编号单独列为“没读到”（未知，不是不存在）；状态原样保留，不翻译、不归并。合成夹具的状态值用缺陷系统常见的 `active`、`resolved`、`closed`；真实应答里出现的值由集成者从已部署 Hub 的原件里核对后告诉你。
2. 追溯包：
   - 用 `expected_sources` 按缺陷视图里的编号批量绑定状态（编号多于 50 个时分成几个标识）。状态读不到（登录过期、超时、编号没读到）时，那一行的状态记未知并写原因，绝不当成“未关闭”。
   - 每一行加缺陷系统里的状态。结论文字写成“缺陷 X（发布说明：已修复；缺陷系统：<原样状态>）：…”，其余照现在。
   - 运行级计数加三项：缺陷系统里已关闭的缺陷数、其中有已索引用例的数、没有的数（没有的照旧记未知）。“已关闭”取哪些状态值写在包的表里（`tables/closed-statuses.json`，初值 `["closed"]`），不写在代码里。
   - SKILL.md 和 README 同步：怎么读状态、未知怎么转述。
3. 独立核对：`scripts/real/gold/` 里的追溯核对脚本加状态。它读集成者用 `circle-hub original export` 导出的 PLM 详情原件，自己解析 `data[].status`，不导入包里的任何函数；按同一张已关闭状态表算出三项计数和每个缺陷的状态。场景 `scripts/real/accept/traceability.ts` 加对应核对：每个缺陷的状态与独立依据一致，三项计数一致。
4. 测试先写：批量标识的分组与上限、没读到的编号、状态读不到时记未知、已关闭计数、表里改状态值后计数跟着变、场景的正反例。验证：`npx tsc --noEmit`；`node --test --test-concurrency=2 "packs/system/plm/**/*.test.ts" "packs/workflow/traceability/**/*.test.ts" "scripts/real/**/*.test.ts"`（数据库测试别和别的终端同时跑）。

完成后在终端里回报：提交号、测试数量、没做完或拿不准的地方。
