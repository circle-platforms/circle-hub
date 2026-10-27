# 任务：运行锁的是树苗根，分面/索引/关联视图读的是同步根，两边对不上

依据：真实层 T2-6（质量看板）部署后重跑（2026-10-27 晚）；`hub/runs/engine/target.ts:201`；`hub/knowledge/views.ts`；决定"每个版本线一棵树苗，其余经喂入"（`docs/hub-r4-kb-direction.md`、`hub/knowledge/seedling.ts`）。

## 现象（合成描述，真实运行号只留本机）

同一条产品线、同一个构建既有 `knowledge seed` 育出的树苗，又有 `knowledge sync` 产出的构建根（两个不同的根摘要）。此时：

- `start_run`（`target.ts:201`）：`const root = await knowledge.seedlingRoot?.(pid, build.line) ?? await knowledge.rootOfBuild(pid, buildName)`——**树苗优先**，运行锁树苗根，用例定位等包读到的文档被喂入这个根下的用例条目；
- 分面/索引/关联视图（`views.ts` 的 `#composition`、`#scope`、以及 `service.ts` 的 `lockRoot` 和约 1171 行的命名构建分支）：只用 `builds.rootOfBuild(product, build)`——**同步根**。

结果：运行里喂入的用例，视图数不到。质量看板（输入槽 `facets` 绑 `knowledge:facets:<产品>:<构建>?kind=case&by=…`）得到 `quality-board.no_cases`（视图 total 0），用例定位明明刚在这个构建上跑过；模板查缺对用例索引也一样。更糟的是：只有树苗、没有同步根的版本线（例如只育了苗的 10.5 线），视图一律 `这个命名构建没有已生产的组成`，所有依赖视图的包（质量看板、模板查缺、回归范围、维护巡检）在这类线上都读不到任何用例。

## 要做的

1. **一个解析器，运行和视图共用**：把"构建名/版本线 → 读哪个根"的规则放在一处（建议 `hub/knowledge/api.ts` 暴露、`builds.ts` 或 `service.ts` 实现的 `rootForRead(product, {build?, line?})`：先看树苗指针（与 `target.ts` 现用的 `seedlingRoot` 同一来源），没有再退回 `rootOfBuild` / `currentRoot`），`target.ts` 改调它（行为不变），`views.ts` 的所有"构建名 → 根/组成"分支（`#composition`、命名构建分支、`#scope` 里按构建取根的地方）、`service.ts` 的 `lockRoot` 以及你查到的其他读路径都改调它。`sync.ts` 自己的 `rootOfBuild`（同步簿记）不要动。
2. **树苗根上的视图**：视图读树苗根时，用例条目来自该根下的喂入层（`fed-case@1`，已按根绑定的），和同步根上读到的同一种条目走同一个计数路径；没有同步根的线也要能读。若树苗根与同步根同时存在，按第 1 点只读树苗，并在视图的 `notes` 里写一句"读的是树苗根（<摘要前 12 位>）；同一构建另有同步根（<摘要前 12 位>）"，不要悄悄二选一。
3. **测试（合成数据，名字用合成的）**：
   - 同一构建既有树苗又有同步根：喂入一个用例到树苗根（走喂入层现有的写路径），断言 facets / index 视图的 total 计到它，且 `notes` 有上面那句；
   - 只有树苗、没有同步根的线：facets / index / links 视图都能读，不报"没有已生产的组成"；
   - 只有同步根的线：行为与现在完全相同（现有测试保持通过，断言不放松）；
   - 运行锁的根与视图读的根相同：对同一个构建，`start_run` 记录的 `root` 与视图 `scope.roots[].root` 相等；
   - quality-board 或 template-gap 的一条端到端（合成世界）：先在树苗线上用例定位，再开质量看板，得到非空的分组计数。
4. 全量：`npx tsc --noEmit`；`node tools/gen-contracts.ts --check`；`node --test --test-concurrency=2 "hub/**/*.test.ts" "packs/**/*.test.ts" "contracts/**/*.test.ts" ".github/checks/*.test.ts"`（必须是全部）；`tests/acceptance/` 里涉及视图、质量看板、模板查缺、回归范围、维护巡检的场景。报每一组的数量。

## 分支、路径和规矩

- 分支和工作树：`views-seedling-root`，目录 `cursor-trees/views-seedling-root`（集成者已从 hub-redesign 开出，依赖已链接）。
- 可以改的路径：`hub/knowledge/**`（views、links、service、builds、api 及它们的测试和 README）、`hub/runs/engine/target.ts`（只改成调用共用解析器）及其测试、`tests/acceptance/` 里相关场景（只做加法）。别的路径要改先说明理由。
- 规则：同前（不推送、不建 PR、不发布、不部署；不碰线上 Hub、钥匙串、环境配置文件和真实系统；测试只用合成数据；`git commit -s`，只暂存明确路径；提交说明一句英文祈使句，无前缀无句号）。旧断言不许放松；若某个旧测试的期望和新规则冲突，在提交说明里逐条解释。

完成后在终端里回报：提交号、改了哪些读路径、各组测试数量、没做完或拿不准的地方。
