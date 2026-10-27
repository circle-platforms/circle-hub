# 任务：新增测试在 Linux CI 上失败——需要沙箱隔离的测试没有按惯例跳过

依据：公开快照 R6 的 PR 在 Ubuntu CI 上的结果。CI 没有 `sandbox-exec`（`osIsolationAvailable()` 为假），包内函数在那里不能运行；仓库的惯例（`AGENTS.md` 的"验证"一节）是：需要 macOS 的测试在 Linux 上跳过，并在作业摘要里列出。下面这些测试是 R6 新增或改动的，没有加这个保护，在 Linux 上失败。**不是产品缺陷，也不是要放松断言**：在有隔离的机器上它们必须照常运行并通过。

## 已知失败（Linux CI 的完整常规分区，10 项）

`hub/knowledge/operation-records.test.ts` 的 7 项（失败信息都是"任务包的投影函数没有给出条目（函数出错…）"，根因是沙箱不可用）：

1. an operation record enters at declaration grade from a client capture and keeps the locked build
2. a changed character, a model-reported version and any other provenance are refused
3. procedure and pitfall keep the same binding, a contradiction is marked, and withdrawal leaves the bytes
4. retracting a pitfall contribution marks only that entry and leaves the tree bytes
5. a declaration-grade operation record is refused as the ground of another submission
6. a product reader who can read the original sees the operation record on the command node
7. a repeated byte output keeps the exact capture record bound by its run

`case-compile` 的 2 项（发布时跑样例，样例里的检查函数需要沙箱，信息是"沙箱现在不能运行包内函数"）：

8. a product publication, genuine independent adjudication and append-only recomposition admit one complete artifact
9. a real independent review binds the original declaration and grounds a block workbook

`scripts/real/accept/export-build-inputs.test.ts` 的 1 项（信息"未能读取指定知识视图"，在 `hub/server/cli-admin.ts` 读视图时失败；R6 之前这条在 Linux 上是通过的，R6 把 xml/html/脑图解析器迁成了技能包，读它们的原件需要沙箱——先确认这个因果，再决定怎么保护）：

10. administrator knowledge view and original export operate against the synthetic acceptance Hub

## 验收分区（还没有清单）

CI 的验收作业（临时 PostgreSQL）结果还没出；出来后集成者会在终端里补发失败清单。你也可以先用下面的预加载在本机跑验收分区（`npm run test:acceptance`，并发 1，约 50 分钟）自己找出同类失败，两边对一下。

## 在本机复现 Linux 的做法

在你自己的临时目录（不在仓库里）写一个预加载模块，在任何导入之前把 `process.platform` 改成 `'linux'`（`Object.defineProperty(process, 'platform', { value: 'linux' })`），用 `node --import <该模块> --test …` 跑分区。`hub/rules/sandbox/isolation.ts` 的探测在非 darwin 时返回"没有隔离"，这就和 CI 一致。先用它把上面的失败复现出来，再改，再用它验证；这样不用等 CI。

## 要做的

1. 对每个失败的测试按**邻近测试的写法**加跳过保护（`osIsolationAvailable()`，从该包允许引用的入口导入；describe 级还是 test 级随邻近文件）。只跳过确实需要沙箱的测试，不要扩大范围；不改断言，不删测试。
2. 有隔离的机器（本机）上，这些测试必须照常运行、全部通过；回报里给出改动前后本机的计数（应完全相同）和预加载模拟 Linux 下的计数（失败为 0，新增跳过逐条列出）。
3. 若发现某个失败其实不是沙箱的原因（比如第 10 项），不要用跳过掩盖：停下来在终端里写清楚原因再问我。

## 分支、路径和规矩

- 分支和工作树：`linux-ci-skips`，目录 `kimi-trees/linux-ci-skips`（集成者开出，依赖已链接）。
- 可以改的路径：只限上面列出的测试文件，以及（如确有必要）`tests/acceptance/**`、`hub/testing/**`、`packs/**/testing/**` 里的测试辅助。不动生产代码。
- 规则：同前（不推送、不建 PR、不发布、不部署；不碰线上 Hub、钥匙串、环境配置文件和真实系统；测试只用合成数据；`git commit -s`，只暂存明确的路径）。
- 验证（跑完整套，不要只跑相关目录）：`npx tsc --noEmit`；`node tools/gen-contracts.ts --check`；`node --test --test-concurrency=2` 对 `hub/**`、`packs/**`、`scripts/**`、`contracts/**`，以及上面预加载模拟 Linux 的同一套；`npm run test:docs`。报计数。
