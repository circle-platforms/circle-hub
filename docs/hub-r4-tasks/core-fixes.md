# 任务：终审查出的四处核心问题

依据：集成者 10-23 的终审（结论记在 `docs/hub-r4-progress.md`）。四处都是核心或包按模型该有、实际没做到的地方，各自独立。每条一个提交，每条先写一个改前失败、改后通过的测试。

- 分支和工作树：`core-fixes`，目录 `circle-hub-core-fixes`（依赖已装好）
- 可以改的路径：下面每条点名的文件和它们的测试、README。`contracts/` 只按第 4 条经生成器改。别的路径不动。
- 规则：同前（不推送、不建 PR、不发布、不部署；不碰 7420、钥匙串、环境配置文件和任何真实系统；测试只用合成数据；`git commit -s`）。
- 验证：`npx tsc --noEmit`；`node tools/gen-contracts.ts --check`；`node --test --test-concurrency=1` 对 `hub/runs/**`、`hub/rules/**`、`hub/records/**`、`packs/workflow/defect-to-case/**`。

## 要做的

1. **检查时的片段分级也要守边界的范围规则**（`hub/runs/engine/evaluate.ts` 401 行一带）。
   - 现在 `src:` 和 `tree:` 查了是否绑定在本运行上，`rec:` 和 `entry:` 直接去解析。结果是一条没绑定在运行上的记录、或者一个单独的知识条目，也能给引文作根据；`quote-fragments.test.ts` 221–249 行还断言了这种情形是支持。
   - 边界在 `hub/runs/engine/exact.ts` 里对这两种引用有范围规则（`scopeProblem`，还有可作根据的判断）。照边界的规则分级：
     - B01 R[4]：记录引用只能指向结果和 Hub 自己的动作；
     - B01 R[5]：知识条目不能单独作根据。
   - 不在范围里的，记为没绑定，按未知处理，不当作反驳。
   - 改正那几个测试和 `hub/rules/README.md` 275 行一带的说法。
2. **常设义务读字节要按有效档读**（`evaluate.ts` 257–273 行）。
   - Hub 自己跑的运行，现在按 `records[0]` 的档判断，再用 `trustedBytes` 取字节。`hub/records/README.md` 128–130 行写明 `trustedBytes` 只给备份核对和重新扫描用，不给包函数用。
   - 后果：受理被撤回，或者新的扫描命中了，字节照样给出去。
   - 改成和普通运行一样，走 `artifacts.source`、消费方是 `function` 的有效档读取。测试：撤回受理以后，常设义务读不到字节，记为未知。
3. **缺陷转用例：收窄的视图里缺了请求的键，要记未知**（`packs/workflow/defect-to-case/functions/compact-index.ts` 235 行一带、`checks.ts` 559 行一带）。
   - 视图因凭据排除、或者字节和条目预算截断，会少掉一些键，只用 `truncated: true` 标出来。收窄时，包不看 `truncated`，请求的键不在 `keys` 里也算覆盖了。
   - 改成：请求的键没出现在 `keys` 里，或者收窄的视图 `truncated` 为真，对应的查重结论记未知，并在修正说明里写明缺哪些键。
   - 也可以让视图在回答里列出它略掉的请求值（`contracts/src/views.ts` 132 行一带），包据此判断。两种做法先选一种回报再动手。
   - 改正 `narrowed-dedup.test.ts` 177–178 行。
4. **手写的取值换成生成的类型**：
   - `hub/rules/types.ts` 17–22 行和 `evaluate.ts` 377–426 行里新加的 why 值（`not_bound`、`no_fragment`、`retain_only`、`too_large`、`unavailable`），经 `hub/rules/interpreters/quote.ts` 34–35 行存进了主张。先查已有的轴能不能表达（`resolution`、`reason`、`read_tier`）；表达不了，回报给集成者，由集成者在模型里加轴，不要自己加。
   - `hub/leases/service.ts` 304 行重复了 `LEASE_OP`，`hub/runs/engine/submit.ts` 179 行重复了受理的取值，都改用生成的类型。
   - `handWrittenAxes` 的检查（`packs/workflow/case-review/packs.test.ts` 98 行）扩到 `hub/` 和全部包。
   - 加一个测试，钉住已应用迁移的字节：每个已应用的迁移文件的摘要写进测试，改了就失败（计划第 3 步）。

完成后在终端里回报：提交号、测试数量、第 3 条选了哪种做法、第 4 条哪些值需要模型加轴。
