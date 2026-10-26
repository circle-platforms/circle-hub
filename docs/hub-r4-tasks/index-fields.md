# 任务：索引视图只带需要的字段；追溯矩阵和质量看板不绑定产品线

在真实数据上跑出来的两处问题（一个真实构建，用例索引共 84,656 个用例）：

1. **追溯矩阵的用例视图被截断**。`knowledge:index:…?kind=case&key=defects` 的原件有 15.6 MB，视图自己的上限（10 万个条目、约 15 MiB）把取值列到某个缺陷编号之前就截断了，比这大的（也就是较新的）缺陷编号对应的用例全没进视图，矩阵只好报“未知”。原因是每个条目都带了完整的 `data` 和陈述。追溯矩阵只需要每个用例的文档、节点和标题。
2. **两个包的运行被绑到一个无关的构建**。`traceability` 和 `quality-board` 的 workflow.json 写了 `"product": {"id": "famx"}`，运行就按规则选了最新线上最新发布的构建（另一条线的）并锁了它的根，运行摘要里写的是那条线和那个构建，而真正的输入是另一条线的视图。这两个包没有目录要核对，输入里的外部标识已经写明产品和构建，应该和 `regression-scope` 一样不绑定产品线（`"product": {"catalogs": []}`）。

- 分支和工作树：`hub-slim`，目录 `circle-hub-slim`
- 可以改的路径：`contracts/src/views.ts`（及其测试）、`hub/knowledge/views.ts` 与 `hub/knowledge/` 里视图读取的部分（及其测试和 README）、`packs/workflow/traceability/**`、`packs/workflow/quality-board/**`、合约生成物（只通过生成器）。别的路径不动。
- 先读：`AGENTS.md`、`docs/hub-r4-handoff.md`、`contracts/src/views.ts` 开头的说明、`hub/knowledge/views.ts` 的 index 视图部分、两个包的 README 与 SKILL.md。
- 规则：不推送、不建 PR；不发布、不部署，不碰 7420 上的持久部署、钥匙串、环境配置文件和任何真实系统；提交只暂存明确的路径，`git commit -s`，一句首字母大写的英文祈使句，不加前缀和句号，空一行后写你自己的署名行；两个包升到 1.0.1 并重新签。

## 要做的

1. index 视图加参数 `fields=<字段名,字段名,…>`（字段名沿用 `DataFieldName` 的写法）：条目的 `data` 只带这些字段，`statement` 为空串，`entry`、`kind`、`reference` 照旧；不写 `fields` 时行为不变。视图的说明里写明用了 `fields`。截断的判断按瘦身以后的大小算。`facets` 和 `impact` 视图不变。先写测试（含瘦身前后大小的对比、带 `fields` 时 15 万个条目的视图不截断、字段名不合法的拒绝）。
2. `traceability`：用例输入改成 `…?kind=case&key=defects&fields=document,node,title`（SKILL.md、README、示例、workflow.json 的说明、样例、测试同步改），矩阵里列出用例的编号、标题、文档不变；`workflow.json` 去掉产品线绑定。
3. `quality-board`：去掉产品线绑定；SKILL.md、README、合计说明里“索引只收指到可解析命令的用例”的说法过时了（现在每个用例都有条目，没有解析出命令的是未归位条目，计入合计），改成现状。
4. 核对一个数：真实构建的 index 视图说明里写“未归位 58162 个”，而这个构建的条目总数只有 44,199（同步报告）、用例合计 84,656；请在视图的测试里确认“未归位”数的含义（按条目还是按行），不一致就改正说明或计数。
5. 验证：`npx tsc --noEmit`；`node tools/gen-contracts.ts --check`；`node --test --test-concurrency=2 "contracts/**/*.test.ts" "hub/knowledge/**/*.test.ts" "packs/workflow/traceability/**/*.test.ts" "packs/workflow/quality-board/**/*.test.ts"`。

完成后在终端里回报：提交号、测试通过/跳过/todo 的数量、没做完或拿不准的地方。

## 补充（同一个分支）：影响视图也要能瘦身，真实的跨版本线对比现在算不出来

真实数据上，回归范围对同一版本线里相邻的两个构建能算出来：18 个用例在范围内、7 条没有用例的变更路径记为未知。但对跨版本线的一对（较早一条线的一个构建到较新一条线的一个构建）失败：投影函数在沙箱里用了约 790 MB，超过 256 MB 的内存上限（管理员备注：`SANDBOX_VIOLATION … limit memory`），因为影响视图里每个范围内的用例条目都带着完整的 `data` 和陈述。要做的：影响视图加参数 `attached_fields=<字段名,…>`：挂在变更路径上的用例条目只带这些字段、陈述为空串（定义条目和行为条目不变，维护巡检要靠它们的完整数据做差异）；回归范围的输入改用 `attached_fields=document,node,title,priority,negative`（SKILL.md、README、示例、测试同步）；维护巡检不用这个参数（它只要定义条目，已有的 `attached=case` 保持默认行为，请核对它的内存，必要时同样处理）。补测试：同一份大合成视图瘦身前后的字节数对比、带参数时回归范围的投影在 256 MB 内跑完（用 10 万个范围内的用例的合成视图）、字段名不合法的拒绝。做完请在回报里写出这一对构建的视图瘦身后的大小（监督者用真实数据验证）。
