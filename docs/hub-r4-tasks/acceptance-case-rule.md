# 任务：验收测试跟上用例节点的新默认规则

用例节点的默认规则已经改为“带标签或带标记”（`union-case-rule.md`，已合并），但 `tests/acceptance` 里的合成脑图验收还按只认标签的规则写：夹具里有 3 个只带标记、没有标签的用例，Hub 现在默认也投影它们，所以条目数是 67 而不是 64（这条是监督者合并前漏跑验收造成的）。全量验收在合并后的 `hub-redesign` 上 69 项里 7 项失败，都是同一个原因：

- `01-normal-review.test.ts`：两项（条目数 67 对 64；条目与独立依据的下标错位，连带“没有优先级的用例”那条断言失败）
- `16-agile-mindmap-review.test.ts`：一项（“约 150 个节点的脑图给出 64 个用例条目”）
- `20-injected-defects.test.ts`：三项（67 对 64、68 对 65、58 对 55）
- `22-fact-model-independence.test.ts`：一项（67 对 64）

- 分支和工作树：`hub-accept3`，目录 `circle-hub-accept3`
- 可以改的路径：`tests/acceptance/**`（含 `support/`）、`tests/fixtures/**`。别的路径不动（不要为了让测试过去改 `packs/` 或 `hub/`）。
- 先读：`AGENTS.md`、`docs/hub-r4-handoff.md`、`docs/hub-r4-tasks/union-case-rule.md`、`packs/workflow/case-review/README.md` 里“Case rule”一段、`tests/acceptance/support` 里提取“独立依据用例”的代码（`OracleCase`、`cases`）。
- 规则：不推送、不建 PR；不发布、不部署，不碰 7420 上的持久部署、钥匙串、环境配置文件和任何真实系统；提交只暂存明确的路径，`git commit -s`，一句首字母大写的英文祈使句，不加前缀和句号，空一行后写你自己的署名行。不要削弱断言：每一处改动的断言都在提交说明或回报里写明理由。

## 要做的

1. 验收里的独立依据（oracle）对用例节点的提取实现两条规则，由参数选择：`tagged`（带资源标签的节点）和 `marked`（另外把没有标签、带用例优先级 2、有子节点、下面没有别的用例的节点当用例），默认 `marked`。它仍然是独立实现：只按 README 的字句写，不导入 `hub/` 和 `packs/` 的代码。
2. 默认规则的场景（01、16、20、22 里现有的）按新默认写：条目数是 67 等，等于独立依据按 `marked` 数出来的数；不要写死 67，写成从独立依据算出，并另外钉住“只靠标记识别的用例数 = 3”。没有标签的用例：`tags` 为空、`negative` 为未知，字面检查报它缺标签（`core.structure.required_empty` 之类，照 README 的字句，别猜）。
3. 加一个场景：同一份脑图，运行参数 `case_rule: "tagged"`，条目数回到 64，回执文字里有“用例规则：只认标签”，`marked_only` 为 0，并且有“像用例但没标签”的警告，给出个数 3；默认规则那一条的回执文字有“用例规则：标签或标记；其中 3 个只靠标记识别（没有标签）”。
4. 20 号（注入缺陷）的预期按新默认重算：注入的是同样的缺陷，基线的条目数和违规数是多少由独立依据数出，不要凭 Hub 的输出倒推。
5. 验证：`npx tsc --noEmit`；`node --test --test-concurrency=1 "tests/acceptance/*.test.ts"`（大约 4 分钟；机器忙的时候个别测试可能因为计时超限，单独重跑确认，并把重跑的结果写进回报）。

完成后在终端里回报：提交号、验收通过/失败/跳过的数量、改动了哪些旧断言及理由、没做完或拿不准的地方。
