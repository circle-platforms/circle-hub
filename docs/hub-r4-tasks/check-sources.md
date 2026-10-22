# 任务：检查能按声明读运行上绑定的来源

真实运行发现的核心缺口：追溯包按缺陷编号绑定了 `plm:bugs:…`（期望来源），Hub 也读回并存了原件，可检查还是把 20 个缺陷的状态记成“缺陷系统没有读到（来源不可用）”。原因在引擎：`hub/runs/engine/evaluate.ts` 传给检查的 `sources` 只有提交里引用过的那些来源原文（`evidenceOf(...).texts`）；主体构建函数拿到的也只有 `{applies, items, context}`。只出事实的生产运行没有提交，所以检查永远看不到绑定的来源。包里的单元测试是直接把来源塞给检查函数，测不出这一点。

模型的要求是检查在 Hub 的边界上用绑定到运行的来源重算（T03、W08）；这一步缺的就是把绑定来源的内容交给检查的通路。按声明给，不默认全给：有的来源很大（手册约 2.7 MB，用例索引视图十几 MB）。

- 分支和工作树：`hub-check-sources`，目录 `circle-hub-check-sources`（依赖已装好）
- 可以改的路径：`contracts/src/pack.ts`（检查声明）及生成物（只经生成器）、`hub/rules/check.ts`（检查输入）、`hub/runs/**`（`engine/evaluate.ts` 和发布时跑样例的 `packs/samples.ts`）、`packs/workflow/traceability/**`（声明和端到端测试）、`tests/acceptance/**`（一个场景）。别的路径不动。
- 先读：`AGENTS.md`；`node tools/show-element.ts T03 W08 A03`；`hub/runs/engine/evaluate.ts`（`callCheck`、`buildSubject`、`allTexts`）、`hub/rules/check.ts`（`PackCheckInput`）、`hub/runs/engine/start.ts`（`bindExpected`，运行记录里的 `sources`）；`packs/workflow/traceability/functions/plm-status.ts`、`check.ts`、`counts.ts`。
- 规则：同前（不推送、不建 PR、不发布、不部署，不碰 7420、钥匙串、环境配置文件和任何真实系统；测试只用合成数据；`git commit -s`，合并用 `git merge --signoff`）。测试一律用 `node --test`，不要用 `npx tsx`：tsx 不是仓库的依赖，`npx` 会临时下载，运行方式也和 Node 自带的类型剥离不同。

## 要做的

1. 检查声明加可选的 `reads`：`{ roles: [...], max_bytes }`。`roles` 的取值只来自生成的词表（来源角色 `source_role`），不手写；`max_bytes` 有核心上限（例如 1 MiB），发布时超过就拒，给修正说明。
2. 引擎：检查声明了 `reads` 时，把运行记录里这些角色的绑定来源按引用读出（和 `get_nodes` 同一条读路径，按运行用户的可见性），以 UTF-8 文本按引用 URI 并进传给检查的 `sources`，和提交里引用过的原文放在一起。超过 `max_bytes` 或读失败的来源不传，另外在检查输入里给出 `unread_sources: [{ reference, reason }]`，检查据此记未知并写原因，绝不当成空。
3. 发布时跑样例：样例已有 `sources`，声明了 `reads` 的检查照样从样例取，保证样例和生产走同一种输入形状。
4. 追溯包：两个检查（逐条追溯和计数）声明 `reads: { roles: ["expected"], … }`；`plm-status.ts` 按 `unread_sources` 区分“来源不可用”和“编号没返回”。包升一个小版本重签。
5. 端到端测试先写，用真实的引擎和一个合成的 PLM 读取器：
   - 绑定 `plm:bugs` 以后，检查看得到状态，已关闭计数正确；
   - PLM 读不到时，记未知，原因是来源不可用；
   - 没声明 `reads` 的检查照旧拿不到绑定来源；
   - 超过上限的来源出现在 `unread_sources` 里。

   验收场景加一例。
6. 验证：`npx tsc --noEmit`；`npm run verify:contracts`；`node --test --test-concurrency=3` 对 `hub/runs/**`、`hub/rules/**`、`packs/workflow/traceability/**`，以及新加的验收场景（数据库测试别和别的终端同时跑）。

完成后在终端里回报：提交号、测试数量、没做完或拿不准的地方。
