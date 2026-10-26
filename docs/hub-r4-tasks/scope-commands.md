# 任务：回归范围和维护巡检只按命令定义的变化算

真实验收发现两处口径问题，根因相同：影响视图默认把手册里的“行为”条目的变化也算成变更。

- 跨版本线的一对构建：Hub 报出影响路径 105 条，独立脚本直接比两个构建的命令树只差 30 条；多出来的是两条版本线手册不同带来的行为条目变化。架构 6b 的验收是“the Hub's diff of two builds equals a command-level diff computed by a separate script on the raw command trees”。
- 同一版本线内：一条新命令如果手册里早已写了说明，就被归成“修改”而不是“新增”。

决定 11 已经规定命令目录只取命令树生产器的“定义”条目，范围也应如此。影响视图本来就支持 `changed=definition`，不用改核心。

- 分支和工作树：`hub-scope-commands`，目录 `circle-hub-scope-commands`（依赖已装好）
- 可以改的路径：`packs/workflow/regression-scope/**`、`packs/workflow/maintenance-sweep/**`、`scripts/real/accept/regression-scope*.ts`、`scripts/real/accept/maintenance-sweep*.ts`（含测试、README、SKILL；两个包各升一个小版本并重新签）。别的路径不动；核心缺什么先回报。
- 先读：`AGENTS.md`；`contracts/src/views.ts` 开头的视图标识说明；两个包的 `workflow.json`、投影和检查函数、SKILL、README；进度页决定 11、12。
- 规则：同前（不推送、不建 PR、不发布、不部署，不碰 7420、钥匙串、环境配置文件和任何真实系统；测试只用合成数据；`git commit -s`，合并用 `git merge --signoff`）。

## 要做的

1. 范围只按定义条目的变化算：两个包要求影响视图带 `changed=definition`，绑定的视图标识没带时整次开始运行被拒，修正说明给出正确写法；SKILL 里的例子同步。变更种类（新增、删除、修改）因此只看命令定义。
2. 手册行为的变化单列成线索：可选输入 `behaviour`（同一对构建的 `changed=behaviour` 视图），只在结论里另起一段写“手册说明有变化的命令 N 条（只作线索，不算进范围）”，最多列 5 条，其余写“另有 M 条”；不进范围，不影响任何计数。
3. 用例数上限（现在超过 4000 例整次被拒）不变，修正说明里加一句：先看定义变化是否已经把范围缩小。
4. 场景同步：`scripts/real/accept/regression-scope.ts` 和 `maintenance-sweep.ts` 的变更路径核对，按命令定义的差（独立脚本 `scripts/real/gold/` 里现有的命令树比较）逐条相等，并核对每条路径的变更种类。
5. 两个包 `production.test.ts` 里各有一个 `it.todo`（“against the real knowledge reader once the product pack cases index is committed”）：用例索引早已合并，把它们做成真测试：合成的产品包、两个构建的根和用例条目，经真实的知识读取器跑一次开始运行。
6. 测试先写：没带 `changed=definition` 被拒；手册早有说明的新命令归为“新增”；行为变化只出现在线索段、不进计数；线索超过 5 条时写“另有”。验证：`npx tsc --noEmit`；`node --test --test-concurrency=2` 对两个包和 `scripts/real/**`（数据库测试别和别的终端同时跑）。

完成后在终端里回报：提交号、测试数量、没做完或拿不准的地方。
