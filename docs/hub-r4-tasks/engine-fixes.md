# 任务：修引擎里差分测试发现的缺陷

判定规则的差分测试（`tests/acceptance/oracle/`）按模型原文写了一份独立的参照实现，在随机场景上和引擎比较，发现 7 处引擎没有照模型做的地方，逐条写在 `tests/acceptance/oracle/FINDINGS.md` 里（种子、模型条款、引擎现状、参照怎么做、后果、严重程度、建议的修法）。前三条严重程度“高”：

1. 同一份提交换会话重放，独立判断仍算满足（`submit.ts` 的 `submitLocked` 按（运行，提交摘要）直接交回旧回执，不再核对这次调用的会话和模型）——起草方可以用自己的会话把复核正文再交一次，回执仍写独立判断满足，“起草方不能签结论”这条保证在这条路上失效。
2. 声明跳过只盖住判断类要求项。
3. 缺失条目只盖住判断类要求项，并报轮数已经用完。

- 分支和工作树：`hub-engine`，目录 `circle-hub-engine`
- 可以改的路径：`hub/runs/engine/**`（及其测试和 README）、`tests/acceptance/oracle/**`（把原来钉住缺陷现状的断言改成与参照一致，并在 `FINDINGS.md` 里把已修的条目标为已修）。别的路径不动；修法若需要改合约，先写进回报，别自己改。
- 先读：`AGENTS.md`、`docs/hub-r4-handoff.md`、`tests/acceptance/oracle/FINDINGS.md` 和 `README.md`、对应的模型元素（`node tools/show-element.ts A04 W07 V03 V05 W02 T03`）、`hub/runs/engine/submit.ts` 与 `lineage.ts`。
- 规则：不推送、不建 PR；不发布、不部署，不碰 7420 上的持久部署、钥匙串、环境配置文件和任何真实系统；提交只暂存明确的路径，`git commit -s`，一条缺陷一个提交，一句首字母大写的英文祈使句，不加前缀和句号，空一行后写你自己的署名行。

## 要做的

按 `FINDINGS.md` 的顺序一条一条做：先把引擎的现状写成改前失败的测试（引擎的测试目录里，不是只靠差分测试），再改引擎，再把差分测试里钉住旧行为的断言改成与参照一致。第 4 到第 7 条（中）同样处理；若某一条按模型原文确实可以有两种读法（FINDINGS 的“模型没有排定的地方”），不要选，写进回报，由所有者定。每改一条跑 `node --test --test-concurrency=2 "hub/runs/**/*.test.ts" "tests/acceptance/oracle/**/*.test.ts"`，全部做完再跑 `npx tsc --noEmit`、`node tools/gen-contracts.ts --check` 和 `node --test --test-concurrency=2 "hub/**/*.test.ts"`（验收套件 `tests/acceptance/*.test.ts` 也要重跑一次，分开单独跑），如实报数。
完成后在终端里回报：提交号、每条缺陷修没修、测试数量、没做完或拿不准的地方。
