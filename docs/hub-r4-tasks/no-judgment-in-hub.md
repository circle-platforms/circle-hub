# 任务：Hub 不调用任何判断模型（类型化判断服务从 Hub 里拿掉）

所有者 2026-10-22 定：Hub 本身没有 LLM 能力，所以也没有类型化判断服务（Jev/TypeSafe）的能力；它在部署形态上是插件里的技能。知识库里需要判断的处理（把手册片段归到命令树的节点）是 bot 的能力：由 bot 提出归位的提议，Hub 只用确定性规则核验。这个任务把“Hub 向外调用判断服务”的能力拿掉，让内部数据不可能因为配置或误操作离开 Hub（2026-10-22 的外发事件见 `docs/hub-r4-progress.md`）。bot 一侧的流程以后另做，这里只在文档里记下去向。

- 分支和工作树：`hub-nojudge`，目录 `circle-hub-nojudge`
- 可以改的路径：`hub/jev/**`、`hub/knowledge/**`（只是判断与归位相关的部分）、`hub/config/**`、`hub/platform/environment.ts`、`hub/server/assemble/**`、`hub/server/cli-admin.ts`、`hub/server/testing*.ts`、`tests/acceptance/**`（只是判断相关的支持和用例）、`scripts/real/jev-smoke.ts`、`contracts/src/product.ts` 里生产器 `placement` 字段的说明文字（及生成物，只通过生成器）、`docs/hub-r4-architecture.md`、`docs/hub-r4-coverage.md`、`docs/hub-r4-handoff.md`、`docs/design/generic-model.md` 和 `contracts/model.json` 里写着“Hub 调用判断服务”的句子（改后用 `node tools/gen-contracts.ts` 重新生成并 `--check`）。别的路径不动；`docs/hub-r4-progress.md` 由监督者自己改。
- 先读：`AGENTS.md`、`docs/hub-r4-handoff.md`、`hub/jev/README.md`、`hub/knowledge/README.md` 里归位的部分、`hub/server/assemble/vault.ts`（`jevFromVault`、`JEV_*`、`NO_JEV_NOTICE`）、`hub/server/assemble/hub.ts`（`jev` 选项和字段）、`hub/server/cli-admin.ts`（`secret set jev api-key` 和 `secret list`）、`hub/config/index.ts` 与 `names.ts`（`CIRCLE_HUB_JEV_MODEL`、`config.jev`）、`hub/knowledge/service.ts`（`placer`）。
- 规则：不推送、不建 PR；不发布、不部署，不碰 7420 上的持久部署、钥匙串、环境配置文件和任何真实系统，不调用任何判断服务（测试里的判断器只用脚本化的假件）；提交只暂存明确的路径，`git commit -s`，一句首字母大写的英文祈使句，不加前缀和句号，空一行后写你自己的署名行。

## 要做的

1. **拿掉对外调用的能力。** 删除真正发起 HTTP 调用的客户端 `hub/jev/http.ts` 及其测试，以及 `scripts/real/jev-smoke.ts`；删除 `jevFromVault`、`JevOptions`、密钥库条目 `jev.api-key` 和 `circle-hub secret set jev api-key`（`secret list` 里不再出现），`NO_JEV_NOTICE` 和它在启动与命令行里的提示，配置项 `CIRCLE_HUB_JEV_MODEL` 与 `config.jev`（相应的名字登记、README、漂移测试一并改；设了这个环境变量的进程怎么办，按配置层现有的“未知名字”规则处理，并把结果写进回报）。装配出来的 Hub 不再有 `jev` 字段，知识服务在生产装配里没有归位器。
2. **保留测试用的形状。** `hub/jev` 里的判断记录、校准、核验和脚本化判断器（`scripted.ts`、`record.ts`、`validate.ts`、`decide.ts`、`batch.ts`、`api.ts` 里的接口）继续留着：它们是以后核验 bot 提议要用的形状，也是归位逻辑的测试件。不要自己删除它们；删除第 1 条之后没有任何使用者的模块，只列在回报里，由监督者决定。`KnowledgeServiceOptions` 里的 `jev` 保留为测试注入点（默认没有），生产装配不传。
3. **结构性的保险。** 加一条测试：`hub/`、`scripts/`、`bin/` 下所有非测试的源文件里没有 `HttpJev`、没有判断服务的域名和 `typesafe`（不区分大小写）、没有对 `jev.api-key` 的读取；再加一条装配测试：密钥库里放一个假的 `jev.api-key` 条目，装配出的 Hub 照样没有归位器，一次知识同步记录的网络调用（用假的网络层记下全部出站调用）里没有一次指向判断服务，没有路径的条目全部留在根下、标为未归位，生产记录的 `placement.spans` 为 0。
4. **知识生产与同步的输出。** 没有路径的条目留在根下标为未归位（没有判断客户端时现状就是这样）。`knowledge sync` 和生产报告里不再出现“判断服务”“模型归类”这类字样，改成“N 个条目未归位，留在根下”。生产器声明的 `placement` 字段（只用代码归位 / 可以交给判断服务）保留，说明文字改为“这个生产器没有路径的条目可以交给 bot 归位”：Hub 以后只对声明了的生产器提供待归位的条目，不自己归位。
5. **文档。** 把“Hub 不做开放式生成，但可以调用类型化判断模型给知识归位”这类原则句改为：“Hub 不调用任何模型；需要判断的知识处理属于 bot（用 Circle 内核），bot 提交归位提议，Hub 用确定性规则核验（路径存在、引文逐字出自原件、不越过声明）；这条流程尚未实现。”改动限于：架构文档（含第 3 节图里的 “Jev adapter”）、覆盖表、交接文档、通用模型文档和 `contracts/model.json` 里相应的句子。模型里至少有两处：K03 的“树本身（生产器：确定性解析器 + Jev 归类，计入根摘要）”改成“树本身（生产器：确定性解析器；bot 提议并经核验的归位以后计入，尚未实现）”；K04 的定义改成“代码按源结构切段，字面规则能定的直接挂；其余由 bot（R03）调用类型化判断模型（Jev）自根向叶逐层单选，提出归位提议，Hub 只核验、不调用任何判断模型；只决定放在哪，不决定真假。”，规则里“开发期用脚本化判断器”改成“测试用脚本化判断器”，再加一条规则：“提议的提交通道和核验尚未实现（所有者 2026-10-22 定：Hub 不调用判断模型）；在此之前，没有路径的片段留在根下，标为未归位。”不要借机改写别的句子，不改模型的结构，只改文字；生成物要和 `contracts/model.json` 一致。
6. **验证。** `npx tsc --noEmit`；`node tools/gen-contracts.ts --check`；`node --test --test-concurrency=2 "hub/**/*.test.ts" "contracts/**/*.test.ts" "scripts/real/**/*.test.ts" "packs/product/famx/**/*.test.ts"`；`node --test --test-concurrency=1 tests/acceptance/*.test.ts`（先看 `package.json` 的验收脚本怎么跑，照它的参数；负载高时单个文件的用时会变长，单独重跑确认）。

完成后在终端里回报：提交号、测试通过/跳过/todo 的数量、删除第 1 条之后没有使用者的模块清单、设了 `CIRCLE_HUB_JEV_MODEL` 的进程现在会怎样、没做完或拿不准的地方。
