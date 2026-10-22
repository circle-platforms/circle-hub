# 任务：只有作者样例的检查，它支撑的主张标“仅作者样例”

模型 T02 R[1]：每条样例标来源（作者、回流反例、外部留存交付），发布校验按规则报告各来源的样例数，只有作者样例的规则“在支撑上标‘仅作者样例’并展示”。发布一侧已经做了：`hub/runs/packs/samples.ts` 在发布报告里给出警告，`hub/runs/packs/marks.ts` 的 `publishCheckMarks` 按版本的样例文件算出每个检查的标记。运行一侧没接上：引擎建主张时没有把这些标记放进限定，所以回答和控制台都不显示。`packs/workflow/template-gap/engine.test.ts` 里有一个标着 todo 的测试等着它（全套测试里 3 个 todo 之一）。

- 分支和工作树：`hub-check-marks`，目录 `circle-hub-check-marks`（依赖已装好）
- 可以改的路径：`hub/runs/**`（引擎建主张的地方和它的测试）、`hub/server/**` 里显示限定的文字（如果需要）、`packs/workflow/template-gap/engine.test.ts`（把 todo 改成真测试）。别的路径不动。
- 先读：`AGENTS.md`；`node tools/show-element.ts T02 B01`；`hub/runs/packs/marks.ts`、`samples.ts`；引擎里由检查结果建主张的代码（`hub/runs/engine/claims.ts` 一带）；`contracts/src/claim.ts` 的 `Qualifier.marks`。
- 规则：同前（不推送、不建 PR、不发布、不部署，不碰 7420、钥匙串、环境配置文件和任何真实系统；测试只用合成数据；`git commit -s`，合并用 `git merge --signoff`）。

## 要做的

1. 开始运行时按锁定的包版本算一次检查标记（`publishCheckMarks`），随运行保存；建主张时，依据是某个检查的结果的，把这个检查的标记并进主张限定的 `marks`（去重、按词表顺序）。同一个主张由几个检查支撑时取并集。
2. 显示：回答里和控制台运行页上，主张的限定行写出标记的中文标签（`labelOf('qualifier_mark', …)`），和现有的其他标记写法一致。
3. 判断性的主张（模型给的）不加这个标记：它说的是规则的样例来源。
4. 同在引擎里的一处修正说明（`hub/runs/engine/slots.ts` 的“条目 X 不是本运行的条目”）：真实评审里模型四次提交都用错了条目编号（写成序号、只写节点号、加前缀），而这句说明既没说编号写法，也没说去哪儿读全部条目。改成：说明本运行有几个条目、编号照 `start_run` 回答里条目清单第一列原样写，并举本运行第一个条目的编号作例子；交上来的编号恰好是某一个条目编号的结尾（例如只写了冒号后面的部分）时，再加一句“是不是指 <那个编号>”。只用运行里已有的条目，不猜别的。
5. 测试先写：只有作者样例的检查支撑的事实主张带标记；有外部样例的不带；两个检查一个只有作者样例时并集带标记；判断不带；template-gap 的 todo 测试转为普通测试并通过；条目编号错时的修正说明（举例、恰好是结尾时的提示、不是任何结尾时不提示）。验证：`npx tsc --noEmit`；`node --test --test-concurrency=3 "hub/runs/**/*.test.ts" "packs/workflow/template-gap/**/*.test.ts"`（数据库测试别和别的终端同时跑）。

完成后在终端里回报：提交号、测试数量、没做完或拿不准的地方。
