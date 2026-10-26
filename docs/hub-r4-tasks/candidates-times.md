# 任务：构建候选要带上每个构建的制作时间和“基于”的构建

所有者指出：构建站的列表页上每个构建都有制作时间和基于哪个构建，例如“Beta_FAMY_10_7_1_103 (build on 2026-07-22 06:26:12 ): based on Beta_FAMX_10_7_1_103”（形状照真实页面，数字是合成的）。而用例定位的构建候选现在只写“已发布日期”或“未发布”，80 个构建里绝大多数显示成“未发布”，没有时间，也不写基于哪个构建；这是错的，信息就在页上，我们没用。发布状态（正式发布的标记）和制作时间是两回事，要分开写。

- 分支和工作树：`hub-times`，目录 `circle-hub-times`
- 可以改的路径：`packs/workflow/case-location/**`、`packs/product/famx/functions/{sync-plan,listing,builds}.ts` 及其测试和 README、`scripts/real/gold/builds.ts` 与 `scripts/real/accept/case-location.ts`（及其测试）。别的路径不动。
- 先读：`AGENTS.md`、`docs/hub-r4-handoff.md`、`packs/workflow/case-location/functions/candidates.ts`、`packs/product/famx/functions/listing.ts`（列表页的构建头：`built`、`released`、`basedOn` 已经被解析）、`sync-plan.ts` 里登记只有名字的构建的地方、`scripts/real/gold/builds.ts`。
- 规则：不推送、不建 PR；不发布、不部署，不碰 7420 上的持久部署、钥匙串、环境配置文件和任何真实系统，不调用任何判断服务；测试只用合成数据；提交只暂存明确的路径，`git commit -s`，一句首字母大写的英文祈使句，不加前缀和句号，空一行后写你自己的署名行；`case-location` 和 `famx` 各升一个小版本并重新签。

## 要做的

1. 同步计划登记只有名字的构建时，`built_at` 填列表页上的制作时间（“build on …”），`released_at` 只在有正式发布标记时填；`base` 按列表页的“基于”写成它基于的构建名（FAMY 构建基于 FAMX 构建），没有“基于”的才等于自己。
2. 构建候选的结论文字：每个候选写“构建名（名称族）制作于 <年-月-日 时:分>”，别名再写“基于 <基础构建>”，发布状态另写“已发布 <日期>”或“未发布”；按制作时间从新到旧排序（时间相同按名字）；最多写前 12 个，其余写“另有 N 个”；`data` 里同样带 `built_at` 和 `base`。
3. 独立标准答案 `scripts/real/gold/builds.ts` 输出 `{ name, family, base, built, released }`（`base` 取列表页的“基于”），`case-location` 场景在 gold 有这些字段时逐个比对制作时间和基础构建。
4. 先写测试（含改前失败的）：合成的列表页（有制作时间、有“基于”、有正式发布标记的、没有的）；候选的排序和文字；别名带基础构建；没有制作时间的构建（页上缺）排在最后并写“制作时间未知”。
5. 验证：`npx tsc --noEmit`；`node --test --test-concurrency=2 "packs/workflow/case-location/**/*.test.ts" "packs/product/famx/**/*.test.ts" "scripts/real/**/*.test.ts"`。
完成后在终端里回报：提交号、测试通过/跳过/todo 的数量、没做完或拿不准的地方。
