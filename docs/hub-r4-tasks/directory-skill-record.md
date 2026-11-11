# 目录遍历技能记进生产记录，通用技能包写进模型（决定 157，issue #34）

来源：issue #34 的四个待定项；所有者 2026-11-11：“采用，这次改完直接就上线使用，没有过渡期，都需要产出，文字都要改”。分支 `feat/directory-skill-record`，接在 `fix/no-credential-hold`（模型第 44 版）之后，所以模型是第 45 版。

## 开工前核对到的现状

issue 写的是“核心直接导入产品包的目录遍历，设计说明已完成，等待决定”。实际上决定 136 第 9 项（所有者 2026-11-02）已经选了方案二，2026-11-04 的提交 f9c86ea0 已经做完搬迁：

- 遍历在通用技能包 `packs/skill/adoc-format/functions/directory.ts`，核心 `hub/knowledge/directory-sources.ts` 只经这个包的 `api.ts` 使用它。
- 产品包只声明目录布局（`layout`）、主文件等；它的沙箱里用的是 `tools/gen-contracts.ts` 生成的副本，`npm run verify:contracts` 核对两者一致。
- 迁移前的基线冻结在 `packs/skill/adoc-format/testing/baseline/`：迁移前三个源文件的原始字节、43 次目录调用的输入输出、两棵树的根摘要和组成条目摘要。迁移测试和生产测试用它核对新实现产出相同的结果。

所以四个待定项里，“采用方案二”和“旧包都要能重新产出”在代码上已经成立。这次做的是剩下的两项，并把结论写进模型。

## 四个待定项的结论

1. **采用方案二，没有过渡期。** 方案一（产品包提供规划函数入口）从未实现，不保留。
2. **旧产品包都要能重新产出。** 由上面的冻结基线核对，现在作为模型规则写明（C02 R[3]）。
3. **生产期技能摘要怎么冻结。** 这次新做：见下节。
4. **模型文字。** 这次新做：模型第 45 版。

## 生产记录里的 `directory_skill`

问题：`knowledge seed` 由 Hub 自己（进程内）用技能包的遍历决定绑定哪些来源。绑定出的来源本身记在组成里，但“是哪个版本的遍历选出了这些来源”没有记录。

做法：

- `directory-sources.ts` 的 `directorySkill()` 读技能包目录里的 `pack.json`（包名、版本）和遍历模块 `functions/directory.ts` 的字节，算出 SHA-256。绑定成功时把它随绑定结果一起返回。
- 育苗的生产（试运行和正式）把它交给生产流程，写进生产记录的 `detail.directory_skill`：`{ id, version, module, sha256 }`。这个字段是可选的。
- `knowledge seed` 的输出多一行：`目录遍历 adoc-format@<版本>（functions/directory.ts <sha256>）`。
- 这个 SHA-256 和技能包清单 `pack.json` 里该文件的摘要相同（测试核对），所以拿生产记录就能对上已发布的技能包版本。

边界：

- 没有走目录遍历的生产（只读 Markdown 手册的育苗、`knowledge sync`）不带这一项。
- `knowledge sync` 的遍历在产品包的沙箱里运行，用的是产品包里的生成副本，由生产记录里已有的产品包摘要覆盖，不重复记录。
- 此前的生产记录没有这一项。当时用的遍历版本没有记录，这一点照实写在模型里，不补写。

## 模型第 45 版

- C02 定义和 R[2]：通用类里与产品无关、可复用的确定性能力（格式解析、目录遍历）落到通用技能包。
- C02 R[3]（新增）：核心不导入产品包的代码；产品特有的写法由产品包声明、通用技能包执行；核心只经通用技能包的公开入口使用通用能力，并在产生的记录里写明包名、版本和模块摘要；没有过渡形态；旧产品包须能重新产出相同的树。
- T01 定义：分发单位加上通用技能包（词表 `pack_kind` 里早有 `skill`，这次补上原文）。
- 记录种类、协议码、MCP 工具、词表轴都不变。

## 新增的检查

`hub/pack-imports.test.ts`：核心的运行期模块（不含测试和 `testing/` 目录）不得导入 `packs/product/` 下的任何文件。

没有动的：核心另有三处导入工作流包 `test-bed` 的公开入口（`hub/dispatch/service.ts`、`hub/knowledge/feeding.ts`、`hub/knowledge/operation-device.ts`）。它们不是产品包，不在 #34 的范围；模型规则因此只写“不导入产品包的代码”，没有写成“不导入任何包”。

## 验证

- 类型检查通过；`npm run verify:contracts` 通过；合约测试 407 项通过（新增 `model-c02-skill-pack.test.ts`）。
- `node --test hub/knowledge/seed.test.ts`：15 项通过。目录育苗的一项加了断言：报告和每条生产记录都带 `directory_skill`，其摘要等于技能包清单里的摘要；不走目录的育苗一项断言没有这个字段。
- `node --test hub/pack-imports.test.ts` 通过。
- 技能包自己的迁移测试和生产测试没有改动，照旧通过；连同 `hub/knowledge/{seed,produce,seedling}.test.ts` 一起跑共 37 项通过。文档检查 383 项通过。

## 允许路径

`contracts/model.json`、`contracts/generated/**`（生成）、`contracts/src/{model-c02-skill-pack.test.ts,model-w04-w10-v07.test.ts,vocab-axes.test.ts}`、`contracts/README.md`、`hub/knowledge/{directory-sources.ts,store.ts,produce.ts,seed.ts,seedling.ts,seed.test.ts,README.md}`、`hub/pack-imports.test.ts`、`docs/compatibility.md`、`docs/compatibility.en.md`、`docs/hub-r4-progress.md`、`CHANGELOG.md`、本任务页
