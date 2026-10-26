# 任务：缺陷转用例在真实用例索引上跑不起来：投影把整个索引视图放进了输出

真实数据上第一次用真实模型跑 `defect-to-case`（一个真实缺陷，索引视图 `knowledge:index:famx:<构建>?kind=case&key=commands`）：`start_run` 失败，管理员备注是 `SANDBOX_OUTPUT_TOO_LARGE`（投影函数的输出超过沙箱的 8 MiB 上限）。原因在 `packs/workflow/defect-to-case/functions/projection.ts`：`groups.push({ indexed_cases: indexInput.model })` 把整个索引视图（真实的有 12 到 15 MB）当作“分组”原样放进输出，随运行冻结，再交给去重检查。合成测试里的视图只有几条，所以没暴露。

- 分支和工作树：`hub-d2c2`，目录 `circle-hub-d2c2`
- 可以改的路径：`packs/workflow/defect-to-case/**`。别的路径不动；需要引擎或合约配合的写进回报。
- 先读：`AGENTS.md`、`docs/hub-r4-handoff.md`、`docs/hub-r4-tasks/defect-to-case.md`（原规格）、`projection.ts`、`subjects.ts`、`checks.ts` 里 `duplicate_check` 的部分、`contracts/src/views.ts` 里 `index-view@1`（`fields` 参数在 `hub-slim` 分支上，合并以后索引视图可以只带文档、节点、标题）。
- 规则：不推送、不建 PR；不发布、不部署，不碰 7420 上的持久部署、钥匙串、环境配置文件和任何真实系统；测试只用合成数据；提交只暂存明确的路径，`git commit -s`，一句首字母大写的英文祈使句，不加前缀和句号，空一行后写你自己的署名行；包升到 1.0.1 并重新签（`node packs/workflow/case-review/packaging.ts sign defect-to-case`）。

## 要做的

1. 投影的输出里不再放整个视图。只放去重检查要用的紧凑索引：对索引里每个有命令的用例，按它的命令集合（规范化后排序拼成的键）归并，每个键下只留 `{document, node, title（最多 80 个字符）, reference}`，加总数、被丢弃的数和“是否完整”。整个输出（序列化后）不超过 4 MiB：超过时按键的顺序截断并把“不完整”标为真，去重检查对不完整的索引，在没发现重复时记未知（原因写明丢了多少），发现重复照样记提示。没有命令的用例（索引里未归位的）不参与去重，在说明里数出来。
2. 去重检查改读这份紧凑索引：草稿用例的命令集合键相同、负面标志相同、并且标题规范化后相等或期望结果相等，才算重复（规则不变，只是数据结构变了）；先写测试（含改前失败的）：真实规模的合成视图（10 万个用例条目）下 `start_run` 的投影输出不超过 4 MiB、投影在 256 MB 内存内跑完；截断时的行为；没有命令的用例；去重的各种情形不变。
3. 建议索引输入写成 `knowledge:index:<产品>:<构建>?kind=case&key=commands&fields=document,node,title`（`hub-slim` 合并以后可用），在 SKILL.md、README、示例里改这样写；输入视图本身也不能超过沙箱的输入上限，README 里写明现在的上限和余量。
4. 验证：`npx tsc --noEmit`；`node --test --test-concurrency=2 "packs/workflow/defect-to-case/**/*.test.ts"`。
完成后在终端里回报：提交号、测试通过/跳过/todo 的数量、没做完或拿不准的地方。
