# 任务：用例定位的构建候选在真实数据上的独立标准答案

用例定位（能力 3）现在会给出所在版本线下两个名称族的构建，别名解析到它所依据的构建（`packs/workflow/case-location` 1.1.0 的 `candidates` 检查，数据来自运行上下文里的知识库构建）。它要在真实数据上证明对：标准答案由另一份独立的脚本直接读构建站的索引页算出，再和 Hub 经真实 Circle 客户端给模型看到的候选逐个比对。

- 分支和工作树：`hub-bcand`，目录 `circle-hub-bcand`
- 可以改的路径：`scripts/real/gold/**`（新增 `builds.ts` 及其测试）、`scripts/real/accept/case-location.ts` 及其测试。别的路径不动。
- 先读：`AGENTS.md`、`docs/hub-r4-handoff.md`、`scripts/real/accept/case-location.ts` 和 `checks.ts`、`scripts/real/gold/command-diff.ts`（独立标准答案脚本的写法：不导入 `hub/` 和 `packs/`）、`packs/product/famx/README.md` 里构建站索引页、构建命名（两个名称族、基础构建、别名）和版本线的说明、`packs/workflow/case-location/README.md` 里 `candidates` 检查的说明。
- 规则：环境配置文件、真实地址、真实编号都不进仓库，脚本读文件，文件由监督者用 `circle-hub original export` 导出放在仓库外；写标准答案的代码**不得导入** `hub/` 和 `packs/` 下的任何模块；不推送、不建 PR；不碰 7420 上的持久部署、钥匙串和任何真实系统，测试只用合成数据；提交只暂存明确的路径，`git commit -s`，一句首字母大写的英文祈使句，不加前缀和句号，空一行后写你自己的署名行。

## 要做的

1. `scripts/real/gold/builds.ts`：输入构建站索引页（HTML 文件，监督者导出）和版本线，输出该版本线下的构建列表 `{ name, family, base, released }`：两个名称族的构建都要列，名称族由构建名里的产品名决定，别名（没有自己的命令树、依据另一个构建的）用索引页上的“基于”关系解析到基础构建；按脚本自己读索引页的规则，不照搬产品包代码，规则的文字依据是产品包 README。先写测试（合成的索引页：两个名称族、一个别名、一个未发布、一个别的版本线），再写实现。
2. `scripts/real/accept/case-location.ts`：场景的 gold 文件新增 `buildCandidates`（该文档所在版本线下构建名的集合，以及每个构建的名称族和基础构建），检查：Hub 答案里列出的候选构建名集合与 gold 相等（顺序不论），别名带出它依据的构建，写出的构建名分类（已知、别的版本线、未知）与 gold 一致；没有 `buildCandidates` 时场景行为不变（原有检查照旧）。补测试（用合成的答案文字，含相等、少一个、多一个、别名没带基础构建）。
3. 验证：`npx tsc --noEmit`；`node --test --test-concurrency=2 "scripts/real/**/*.test.ts"`。
完成后在终端里回报：提交号、测试通过/跳过/todo 的数量、没做完或拿不准的地方。
