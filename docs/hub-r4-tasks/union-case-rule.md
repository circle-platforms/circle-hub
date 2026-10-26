# 任务：用例节点的默认规则改为“带标签或带标记”，各包一致，可限制为只认标签

所有者 2026-10-22 定：用例节点的默认规则统一为“带资源标签的节点，或按团队模板带用例标记的节点”，所有包一致；保留一个开关，可以限制为只认标签；评审要写明用了哪条规则，以及靠标记多找出多少个用例。原因（真实样本，`docs/hub-r4-progress.md` 第 13 项）：只认标签的规则在 51 份文档里只有 37 份能评审（2,706 例），带标记的规则 48 份（6,045 例）；只认标签会漏掉约一半真实用例。回归范围、定位、追溯、质量看板用的用例索引本来就是“带标签或带标记”，只有评审、复核和查缺还停在只认标签。

- 分支和工作树：`hub-union`，目录 `circle-hub-union`
- 可以改的路径：`packs/workflow/case-review/**`、`packs/workflow/case-review-verify/**`、`packs/workflow/template-gap/**`（含测试、README、SKILL、`workflow.json`、`tables`、`examples`、`samples`）、`scripts/real/gold/cases.ts` 及其测试。别的路径不动：`packs/workflow/case-location` 和 `packs/product/famx` 有别人在改，用例索引也不用动；`docs/hub-r4-progress.md` 由监督者自己改。
- 先读：`AGENTS.md`、`docs/hub-r4-handoff.md`、`packs/workflow/case-review/README.md` 里“Case rule”一段、`project.ts`（`DEFAULTS`、`caseRule`）、`tables/codes.json`、`workflow.json` 里的 `case_rule`、`case-review-verify/functions/{common,types,projection}.ts`、`template-gap/functions/cases.ts` 和 `parity.test.ts`（`case-review` 与 `template-gap` 各存一份规则，两边不一致时这条测试会失败）、`scripts/real/gold/cases.ts`。
- 规则：不推送、不建 PR；不发布、不部署，不碰 7420 上的持久部署、钥匙串、环境配置文件和任何真实系统；测试只用合成数据；提交只暂存明确的路径，`git commit -s`，一句首字母大写的英文祈使句，不加前缀和句号，空一行后写你自己的署名行。

## 要做的

1. **默认值改了。** 运行参数 `case_rule` 的取值不变（`tagged` 只认标签；`marked` 认标签和标记），默认从 `tagged` 改为 `marked`：`project.ts` 的 `DEFAULTS`、`workflow.json` 的参数说明与默认值、`SKILL.md` 和 README 的相应句子、`tables/codes.json` 里的 `when` 和 `fix` 文字（现在的修复提示是“把 caseRule 设为 marked”，按新默认重写：默认已经认标记，要限制时设为 `tagged`；`no_case` 拒绝和 `untagged_cases` 警告的措辞跟着改）。
2. **复核用同一条规则。** `case-review-verify` 读到的投影必须和初评用的规则一致：初评运行的参数要传到复核，复核自己没有指定时用同一个默认；加测试：同一份脑图，两种规则下初评和复核的条目编号逐个相同；初评用 `tagged`、复核没指定时，复核按初评的规则而不是默认。
3. **查缺用同一条规则。** `template-gap` 默认也认标记：靠标记识别的用例算用例（现在只披露、不计数），它们没有标签，所以按模板“用例有无标签”的事实照实报缺；`functions/cases.ts` 文件头注释、README 的“Open questions 6”（改成已定，写明日期和决定）和偏差说明同步。`parity.test.ts` 在两种规则下让 `case-review` 与 `template-gap` 的用例集逐项相等。
4. **评审写明规则。** `case-review`、`case-review-verify`、`template-gap` 的结论摘要里各有一行：“用例规则：标签或标记 / 只认标签；其中 N 个只靠标记识别（没有标签）”，`data` 里同样带 `case_rule` 和 `marked_only`（只认标签时 N 写 0，原有的“像用例但没标签”的警告照旧，给出个数和前 20 个定位）。计数是这次运行实际投影出来的、没有标签的用例数，不是估计。
5. **独立标准答案。** `scripts/real/gold/cases.ts` 按更新后的 README 字句实现新默认（仍不导入 `hub/` 和 `packs/` 下的任何模块），加 `--case-rule tagged` 开关；它的测试用合成脑图手算：带标签的用例、只带标记的用例、既无标签也无标记的节点、嵌套用例、带前置条件的用例、组节点。用脚本头注释写明规则的文字依据。
6. **每个检查写明 `tier`。** 这三个包的 `checks.json` 里没有 `tier` 的检查（case-review 8 个里有 6 个，case-review-verify 3 个里有 1 个，template-gap 的 1 个）各写上明确的 `tier`，取值等于引擎今天实际给它的档：`hub/rules/check.ts` 的 `runCheck` 里 `declaration.tier ?? (basis ? 'blocking' : 'advisory')`，行为因此不变；发布时强制声明（另一个任务做）以后这些包仍能发布。再读这些检查的函数：函数返回的档和上面写进去的档不一样的，逐个列在回报里（检查编号、函数返回的档、写进去的档），不要自己改成别的档，由监督者定。加一条包测试：每个检查都有 `tier`。
7. **版本。** 三个包各升一个小版本，重新签（`node packs/workflow/case-review/packaging.ts sign <id>`），`pack.test.ts` 里的版本断言同步。
8. **验证。** `npx tsc --noEmit`；`node tools/gen-contracts.ts --check`；`node --test --test-concurrency=2 "packs/workflow/**/*.test.ts" "scripts/real/**/*.test.ts"`。

完成后在终端里回报：提交号、测试通过/跳过/todo 的数量、没做完或拿不准的地方。
