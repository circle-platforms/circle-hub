# recompose

case-compile 的用例重组阶段，作为独立的包发布（`pack.json`，id `recompose`）。共享规则来自父目录的 `tables/` 和 `functions/`，由父目录的 `testing/gen-recompose.ts` 生成副本；发布时由 `testing/stage-recompose.ts` 单独 stage，不带父目录的 README、`api.ts` 或测试文件。

## 工具

- `tools/download-run.ts`：用标准输入里的令牌下载一次重组运行：条目、来源、锁定知识树的文本文件，运行导出带 `run_reference` 时另写 `references.json`。
- `tools/check-record.ts`：离线自检重组记录，见下节。
- `tools/submit-records.ts`：把精简形状的记录封装成 `recompose-record@1` 交给 Hub。

## 本地自检与 Hub 检查（check-record）

带 `--run` 的 `check-record.ts` 用 `functions/local-checks.ts` 在冻结的下载上按 Hub 的方式核对，本地没有第二份规则：

- `checks.json` 里的函数检查（`record`、`full_set`）调用的就是 Hub 调用的函数（`functions/recompose-check.ts`、`functions/subject.ts`、`functions/seal.ts`）；每条记录的输入由冻结的 `run.json`（条目、运行上下文、分组）、`knowledge/nodes.jsonl`（锁定命令树，按条目选出命令目录，规则、上限和措辞与 `hub/knowledge/catalog-selection.ts` 相同）和 `submit-records.ts` 的 `itemSubmission`（与提交给 Hub 的字节相同）拼成。`checks.json` 声明了而本地没有接线的函数，和核心解释器 `quote@1`，在结果的 `hub_checks.not_run` 里写明原因，不当作通过。
- Hub 在任何检查之前先按 `slots.schema.json` 核对槽位记录的 `data` 形状，不合则整条记录拒收（`SUBMISSION_SCHEMA_VIOLATION`）；`functions/record-shape.ts` 读同一份模式，指出不合处的位置、找到的值和允许的取值。
- 不带 `--run` 只核对形状，`hub_checks.ran` 为 `false`，退出码仍是 0。

本地运行的 Hub 侧检查：`record`（`recompose-check.ts` 的全部规则：原文逐字、覆盖、方法与来源、改写命令的命令树核对、可读引用等）、`full_set`（`seal.ts`，整批与冻结条目一一对应）、槽位 `data` 形状。只在 Hub 里运行的：`quote@1`（引文是否逐字出现在所引片段里；本工具交给 Hub 的引文只取自下载里冻结的原句，`record` 检查另核对记录里的原句逐字等于它们）、引用解析与权限、重试轮次和终态计算。

核对「本地结果等于 Hub 结果」的测试：`tools/check-record-hub.test.ts`（真实运行引擎、注册表、沙箱和临时 PostgreSQL，逐条比较本地问题与 Hub 的错误）；`functions/local-checks.test.ts`（本地照 Hub 代码重做的几处，每处与 Hub 自己的函数在同一数据上对照：命令目录选择及上限、检查输出的处理、运行上下文）。

已知限制：

- 下载里没有产品声明的命令目录是否「完整」（`catalog_complete`），本地按完整核对（`hub_checks.assumed` 写明）；锁定根没有声明完整时，Hub 会另外指出缺口，本地不会。
- 命令目录条目只取 `kind=definition` 且 `data.words`/`data.signatures` 是数组的；Hub 另用 `catalog-entry@1` 校验每个条目并按声明的产出者过滤，下载里没有产出者。
- 证据行 `evidence` 的文字由条目自己的原句拼回节点原文（只在存在性和授权取值的字面比较里用到）；Hub 读的是脑图节点原文。运行上下文不含租约和观察。
- `recompose-check.ts` 里有几处 `bad('', …)` 给出没有码的反驳，Hub 会把整份输出换成一条 `check_error` 未知。对 `submit-records.ts` 生成的记录，其中多数被 Hub 先做的槽位形状检查挡在前面，其余只在绑定了产品授权的冲突里到达；本地 `hubOutcomes` 与 Hub 一致。

## 测试

```sh
node --test "packs/workflow/case-compile/recompose/**/*.test.ts"
```
