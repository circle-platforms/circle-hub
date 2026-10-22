# 任务：合约里写成手写枚举的模型概念进词表

对照模型的复核（`docs/hub-r4-model-review.md` 第 2 节偏离 7 和第 3.2 节）在 `contracts/src` 里找到 5 处模型概念写成了手写的枚举，违反架构第 2 节“枚举从不手写”。做法照 10-23 的 `lease_op`（26d7245）：模型补轴，取值和标签照元素原文，由生成器产出，合约改用生成的类型。

- 分支和工作树：`hub-vocab-axes`，目录 `circle-hub-vocab-axes`（依赖已装好）
- 可以改的路径：`contracts/**`、`tools/gen-contracts.ts`（确有需要时）、`hub/**` 里用到这些字面量的地方，以及对应的测试。别的路径不动。
- 规则：同前（不推送、不建 PR、不发布、不部署，不碰 7420、钥匙串、环境配置文件和任何真实系统；测试只用合成数据；`git commit -s`，合并用 `git merge --signoff`）。
- 验证：`npx tsc --noEmit`；`node tools/gen-contracts.ts --check`；`node --test --test-concurrency=3` 对 `contracts`、`hub`、`packs`（数据库测试别和别的终端同时跑）。

## 要做的

1. 要进词表的 5 处：
   - `contracts/src/pack.ts` 检查的 `target`（item、run）；
   - 同一文件里判定对象的 `applies`（run、item），和上一处是不是同一个概念、该不该共用一个轴，照模型原文判断；
   - `contracts/src/tables.ts` 度量的 `measure`（count、sum、min、max）；
   - `contracts/src/product.ts` 生产器的 `placement`（code_only、judgment_allowed）；
   - `contracts/src/pack.ts` 样例的来源（author、returned_counterexample、retained_delivery）。
2. 每个轴在 `contracts/model.json` 的词表里加一项：`owner` 写取值出处的元素，标签用元素原文的说法，不自造词。元素原文里没有现成说法的，先回报，不要自己起名。
3. 用 `node tools/gen-contracts.ts` 重新生成；合约和用到这些值的代码改用生成的类型和标签。数据库检查约束要改的话，只加新迁移，已应用的迁移一个字节都不动。
4. 格式层的那些（Unicode 规范化、正则标志、JSON 值类型、请求方法等）不动，理由已写在复核记录里。
5. 测试：生成物与模型一致；每个新轴的取值与原来的字面量完全相同，已发布的包不用改就能照样读；模型里每个新轴都写明出处和修订说明（照 `lease_op` 的写法）。

完成后在终端里回报：提交号、测试数量、新轴的名字和标签、没做完或拿不准的地方。
