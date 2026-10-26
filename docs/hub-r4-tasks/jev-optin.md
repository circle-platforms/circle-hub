# 任务：类型化判断只处理声明过的生产器的片段（数据外发的保险）

背景：知识生产把所有没有路径的条目（`path` 为空）交给类型化判断服务归位。目前这包括发布说明里的缺陷条目，用例索引做完以后还会包括没有解析出命令的用例。所有者批准发给判断服务的只有手册片段（计划里写的是“手册片段会发给 TypeSafe”）；缺陷标题和用例标题、目录名是内部业务数据，没有批准。2026-10-22 的一次知识同步已经把每个构建约 290 个这样的片段发给了判断服务（54 个构建的生产记录里 `placement.spans` 可查），随后的一次同步在读完用例文档、开始归位时被中止；判断服务的密钥已经移出密钥库（Hub 现在不做模型归位）。这个任务让这件事在代码里变成选择加入，不能靠“没有配密钥”来防。

- 分支和工作树：`hub-optin`，目录 `circle-hub-optin`
- 可以改的路径：`contracts/src/product.ts`（及其测试）、`hub/knowledge/**`（只是归位相关的部分及其测试和 README）、`packs/product/famx/product.json`、`packs/product/famx/README.md`、`packs/product/famx/pack.json`（重新签）以及合约生成物（只通过生成器）。别的路径不动。
- 先读：`AGENTS.md`、`docs/hub-r4-handoff.md`、`hub/knowledge/README.md` 里归位的部分、`hub/knowledge/produce.ts`（`toPlace` 和 `context.placer.place` 那一段）、`hub/knowledge/placement.ts`、`contracts/src/product.ts`（生产器声明）、`packs/product/famx/product.json`。
- 规则：不推送、不建 PR；不发布、不部署，不碰 7420 上的持久部署、钥匙串、环境配置文件和任何真实系统；测试里的判断服务只用脚本化的假件；提交只暂存明确的路径，`git commit -s`，一句首字母大写的英文祈使句，不加前缀和句号，空一行后写你自己的署名行。

## 要做的

1. 产品包的生产器声明加一个字段，标明它没有路径的条目能不能交给判断服务：取值只有“只用代码归位”和“可以交给判断服务”两种，**默认是只用代码归位**（名字用行业通用的说法，不自造词，写进 `contracts/src/product.ts` 的描述里，说明为什么默认关闭：片段会离开 Hub）。
2. `hub/knowledge/produce.ts`：没有路径的条目只有在产出它的生产器声明了“可以交给判断服务”时才进入 `toPlace`；其余的留在根下标为未归位，不产生任何判断调用。生产记录的 `placement` 里的 `spans` 只数真正发出去的片段；另记每个生产器被跳过（没有发出）的条目数，生产报告和 `knowledge sync` 的输出里能看到“某某生产器的 N 个条目未发给判断服务”。
3. `packs/product/famx/product.json`：只有手册生产器声明“可以交给判断服务”；命令树、发布说明（缺陷）、用例生产器保持默认。famx 升到 1.1.1，重新签（`node packs/workflow/case-review/packaging.ts sign famx`），README 记下这一条。
4. 测试（先写，含改前失败的）：假判断服务记录每次收到的片段；没声明的生产器的条目一个都不会到它那里；声明了的会到；两种生产器混合时只有声明的发出；`placement.spans` 和被跳过的计数正确；没有判断服务时行为不变。
5. 验证：`npx tsc --noEmit`；`node tools/gen-contracts.ts --check`；`node --test --test-concurrency=2 "contracts/**/*.test.ts" "hub/knowledge/**/*.test.ts" "packs/product/famx/**/*.test.ts"`。

完成后在终端里回报：提交号、测试通过/跳过/todo 的数量、没做完或拿不准的地方。
