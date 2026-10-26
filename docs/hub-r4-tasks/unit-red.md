# 任务：清理单元测试失败（unit-red）

分支：`unit-red`。基线是 `hub-redesign` 的 `db16a6a8`；创建时它已从所有者点名的 `aef40885` 前进，且 `aef40885` 是其父提交。工作树和测试日志不进入 Git。

只使用合成资源、临时 PostgreSQL 和脚本化模型。不接触 7420、钥匙串、环境配置文件、真实系统、其他工作树或 main 检出；不推送、不建 PR、不部署。每类一个提交，`git commit -s`，只暂存显式路径。包内容如有改动，同一提交升版本并重签。

## 基线与归因

完整命令为 `node --test --test-concurrency=2`，路径与 `npm run test:unit` 完全相同。第一次运行被工具的 10 分钟上限中止，不作为计数；完整运行结果为：7545 项，7403 通过、141 失败、1 跳过、0 取消、0 todo，耗时 889413 ms。

按失败详情中的文件路径统计：43 个文件，141 项。排除 `packs/product/famx/**` 的 29 个文件、121 项（pi / `famx-trunk-red`）；知识根两次生产摘要问题由 circle / `seed-determinism` 处理，本基线已包含该分支合并，不修改其生产实现。剩余 14 个文件、20 项由本任务处理：

- `hub/knowledge`: derived-scale、pure、view-perf、view-scope 各 1；
- `hub/runs/engine`: exact-retry、fragment-retry 各 1；
- `hub/server`: console-pagination、read-diagnostics、submit-load 各 1；
- `packs/product/lumen-api`: functions 1；
- `packs/workflow/case-review`: packs 1（扫描列出 11 处手写闭集）；
- `packs/workflow/defect-to-case`: publish 1；
- `packs/workflow/maintenance-sweep`: pack、production、publish 各 1；
- `packs/workflow/regression-scope`: functions/check、pack、production、publish 各 1；
- `packs/workflow/story-traceability`: publish 1。

## 允许修改的路径

只改下列已归因文件及同类修复直接需要的已列实现/签名文件；不扩大到 FAMX 或 seed-determinism 的实现：

- `docs/hub-r4-tasks/unit-red.md`
- `hub/knowledge/{pure.test.ts,derived-scale.test.ts,view-perf.test.ts,view-scope.test.ts,scope.ts,views.ts,builds.ts,applicability-fields.ts,contributions.ts,feeding.ts,README.md}`
- `hub/runs/engine/{exact-retry.test.ts,fragment-retry.test.ts,exact.ts,evaluate.ts,dispatch-results.ts,README.md}`
- `hub/dispatch/service.ts`
- `hub/server/{console-pagination.test.ts,read-diagnostics.test.ts,submit-load.test.ts}`
- `packs/product/lumen-api/functions.test.ts`
- `packs/workflow/case-review/packs.test.ts`
- `packs/workflow/case-compile/{functions/plan-commands.ts,functions/plan-commands.test.ts,tables/workbook-format.json,samples/**,pack.json,pack-files.ts,README.md,pack.test.ts,publish.test.ts,production.test.ts}`
- `packs/workflow/defect-to-case/publish.test.ts`
- `packs/workflow/maintenance-sweep/{pack.test.ts,publish.test.ts,production.test.ts,functions/check.ts,functions/check.test.ts,README.md}`
- `packs/workflow/regression-scope/{pack.test.ts,publish.test.ts,production.test.ts,functions/check.ts,functions/check.test.ts,README.md}`
- `packs/workflow/story-traceability/publish.test.ts`

## 判定与验证规则

真回归修实现；陈旧期望或合成 fixture 改测试，不能用实际输出倒写没有依据的答案。断言只依据解析结构、生成/声明的闭集字段或带逐字引文的模型主张；不引入关键词、词典、同义词或自由文本正则匹配，不删、不跳过测试。

每类提交说明写明“实现回归”或“陈旧期望/fixture”，并引用 `docs/design`、模型条文或 `docs/hub-r4-progress.md` 的决定号。最终运行 `npm run typecheck`，再运行全部改动过的测试文件；包内容改动还须核对其新清单。完成后用指定的 `merge-locked.sh unit-red` 合入，报告提交号和前后失败计数。
