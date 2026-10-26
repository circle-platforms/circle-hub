# 任务：知识库认识构建站上一条版本线的所有构建（不只是有命令树的）

用例定位给出构建候选，来源是知识库认识的构建。真实数据上（一条真实版本线）知识库只认识 4 个构建，而独立的脚本直接读构建站的两个名称族的列表页，得到这条线上的 81 个构建（FAMX 31 个、FAMY 50 个，其中只有两个有发布日期）；所有者要评审的文档对应的构建（一个 FAMY 构建）就在列表页上，知识库却不认识它。原因是同步计划（`packs/product/famx/functions/sync-plan.ts` 的 `syncBuilds`）只列出“还需要知识根的、有自己命令树的基础构建”和 FAMY 别名，没有命令树的构建（未发布的、Beta 的）都被略掉了。

- 分支和工作树：`hub-allbuilds`，目录 `circle-hub-allbuilds`
- 可以改的路径：`packs/product/famx/**`（同步计划、构建模型、测试、README、版本）、`hub/knowledge/**` 里处理“没有可读来源的构建”的部分（及其测试和 README）。别的路径不动。
- 先读：`AGENTS.md`、`docs/hub-r4-handoff.md`、`packs/product/famx/functions/sync-plan.ts`、`builds.ts`、`select-build.ts`、`listing.ts`、`packs/product/famx/README.md` 里构建与别名的说明、`contracts/src/product.ts` 的 `BuildInfo`（`sources` 对没有自己树的别名可以为空）和 `KnownBuild`（`root` 可以为空）、`hub/knowledge/sync.ts`、`hub/knowledge/README.md`。
- 规则：不推送、不建 PR；不发布、不部署，不碰 7420 上的持久部署、钥匙串、环境配置文件和任何真实系统；测试只用合成数据；提交只暂存明确的路径，`git commit -s`，一句首字母大写的英文祈使句，不加前缀和句号，空一行后写你自己的署名行；famx 升到 1.1.2 并重新签（`node packs/workflow/case-review/packaging.ts sign famx`）。**不要调用任何判断服务，不要读环境配置文件。**

## 要做的

1. `syncBuilds`：除了现在列出的构建，再把主线列表页（两个名称族）上的其余每个构建都列出来，作为只有名字的已知构建：`name`、`family`、`line`、`built_at` 和 `released_at`（列表页或发布说明页上有就填，没有填空）、`base` 等于自己、`sources` 为空（没有命令树就没有可读的来源）。有命令树的构建、别名的现有处理不变。构建名重复时沿用现在的取舍（`builds.ts` 里的总序）。平台、客户和补丁页仍按选择加入的模式，默认不列。
2. 知识同步：没有可读来源的已知构建只登记，不产出根，不算失败，也不出现在“跳过”的告警里刷屏；同步报告里分开写“产出根 N 个、只登记名字 M 个”。`builds()` 和 `resolveBuild` 能返回它们（`root` 为空）；默认选构建（`select_build`）只考虑有根的构建，不受影响；先读现有测试再改，凡是断言“知识库里只有有根的构建”的测试要说明地改。
3. 规模：每条版本线几十个，全部版本线约几百个；同步一次仍要几秒内完成计划，`knowledge roots` 的输出不要因此变得难读（按有根的先、只有名字的收成一行计数）。
4. 先写测试（含改前失败的）：合成的两个名称族列表页（有树的、没有树的、未发布的、Beta 的、一个别名）；计划列出全部；同步只对有树的产出根；`builds()` 返回全部；`resolveBuild` 对只有名字的构建返回它自己、`root` 为空；用例定位的构建候选检查（`packs/workflow/case-location`，只读，不改）在这样的上下文里仍然正确（写一个端到端测试）。
5. 验证：`npx tsc --noEmit`；`node tools/gen-contracts.ts --check`；`node --test --test-concurrency=2 "packs/product/famx/**/*.test.ts" "hub/knowledge/**/*.test.ts" "packs/workflow/case-location/**/*.test.ts" "hub/runs/**/*.test.ts"`。

完成后在终端里回报：提交号、测试通过/跳过/todo 的数量、没做完或拿不准的地方（尤其是 Beta 构建要不要列进候选，我先默认全列，所有者可以再定）。
