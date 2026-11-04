# AsciiDoc 格式通用技能包

当前版本 1.0.0。所有者决定 136 第 9 项（方案二）：Hub 核心不再导入产品包代码。固定修订号的 SVN AsciiDoc 书籍目录遍历原在产品包 `packs/product/famx/functions/adoc/tree.ts`，现为本包的 `functions/directory.ts`。它不识别产品、不读产品命名语法、不解析 adoc 正文，也不承担编译、评审或计划执行规则；产品特有的目录写法由产品包声明。

## 内容与使用方

| 文件 | 内容 |
| --- | --- |
| `functions/directory.ts` | `directoryOf`（根模板展开）、`layoutOf`（目录布局声明的校验）、`mainsOf`、`booksOf`、`treeOf`、`listedSources`、`rootId`、`DIRECTORY_LIMITS`、`DirectorySourceError` |
| `api.ts` | 供核心与工具使用的公开入口；作为命令运行时提供 `check`、`sign`、`stage <目录>` |
| `skill.json` | `skill@1`，不注册解析器（`parsers: []`） |

使用方有三处，运行环境不同：

- Hub 核心 `hub/knowledge/directory-sources.ts`（`knowledge seed` 绑定目录来源，核心进程内执行）只经 `api.ts` 导入本包。
- 产品包的同步计划和手册生产器在沙箱里运行，沙箱只许读包内文件，所以产品包带一份生成副本：`tools/gen-contracts.ts` 把 `functions/directory.ts` 原样写到 `packs/product/famx/functions/generated/adoc-directory.ts`（加一行生成说明），`npm run verify:contracts` 检查两者一致。改本模块后运行 `npm run gen:contracts`，并给产品包升版本、重签。
- 本模块不导入任何文件，生成副本在任何包里都能运行。

## 目录布局声明

`{line}` 原样替换为版本线。`{line_dir}` 的写法来自产品包声明的 `layout`：

```json
{ "line_dir": { "components": 3, "separator": "_" } }
```

版本线语法固定为一到三段点分十进制、每段至多九位数字。`{line_dir}` 去掉每段前导零，用 `0` 段补足到 `components` 段（1 到 3），再用 `separator`（1 到 4 个字母、数字、点、下划线或连字符）连接：声明如上时 `10.7` 为 `10_7_0`，`0010.008.000` 为 `10_8_0`。模板用了 `{line_dir}` 而没有声明、声明格式不对、或版本线段数超过声明，都拒绝（`adoc-format.invalid_layout` 或 `adoc-format.invalid_line`），不猜目录名。只用 `{line}` 的模板不需要声明。

产品包把同一个 `layout` 写在两处：同步选项里每个名称族的 `adoc.<族>` 旁边，以及手册生产器的 `params` 里（核心的 `knowledge seed` 从生产器参数读取）。合成产品包的测试检查这几处一致。

## 拒绝码

本模块自己的拒绝码在本包名下：`adoc-format.invalid_root`、`invalid_line`、`invalid_layout`、`directory_identity`、`directory_member`、`group_budget`、`missing_main`。消息与下一步文字与迁移前相同。按 `contracts/README.md`，包码以包名为前缀，不登记在 `contracts/codes.json`（那里只放核心解释器与准入检查的 `core.*` 码），所以本次没有新增合约码。产品包自己的检查仍用产品包名下的码。

## 旧运行兼容

目录遍历只在生产前决定绑定哪些来源，不改文档引用的解析器。合成产品包手册文件槽位的解析器仍是 `text@1`，既有运行的 `src:<摘要>/text@1/...` 引用不变，无需补绑定声明。本包不注册解析器，因此没有 `bind-legacy` 迁移。

## 迁移等价与验证

`testing/baseline` 只作测试数据，不进发布清单：

- `manifest.json` 与三个 `.txt`：迁移前提交 63e15782 的 `tree.ts`、`naming.ts`、`util.ts` 原始字节和 SHA-256。测试在临时目录重建原模块，不用搬迁后的实现充当基线。
- `walks.jsonl`：迁移前在原模块上运行 `packs/product/famx/**/*.test.ts`、`hub/knowledge/seed.test.ts`、`scripts/diagnostics/seed-lists-repro.test.ts` 时记录的全部目录调用（去重后 43 条：14 次 `directoryOf`、6 次 `mainsOf`、23 次 `booksOf`），含输入、每次读取的原件、结果或拒绝。沙箱内的调用不能记录，由下面的生产测试覆盖。
- `trees.json`：`testing/production.ts` 在迁移前产出的两棵树（平铺目录 `synthetic/{line}`；三段 `{line_dir}` 下的两个书目录 `manual/10_7_0`，含一个不读的同级目录）的根摘要、组成条目摘要和绑定来源。

`functions/migration.test.ts` 比较：冻结的全部调用（分组顺序、相对路径、列出的外部号、未读与待读、拒绝消息与下一步，拒绝码只换前缀）；重建的原模块复现冻结输出；8000 多组版本线与根模板；每个上限恰好与超一的边界；600 个随机目录树与主文件组合。`functions/production.test.ts` 在临时 PostgreSQL 上用真实知识事务和沙箱生产器重产两棵树，要求根摘要、条目摘要和来源与 `trees.json` 相同；生产器以 `requireOsIsolation: false` 运行（合成数据），与产品包自己的生产测试相同。

测试用仓库里的合成产品包 `packs/product/famx` 作为使用方，这只是测试数据；本包运行时不引用任何产品。

运行：`node --test "packs/skill/adoc-format/**/*.test.ts"`。

## 未完成与需要

- 本包不注册 `adoc@1` 单文档解析器；adoc 正文的解析仍在产品包里（基于其内置的 Asciidoctor）。是否把它也移入本包，需要所有者另行决定。
- 生成副本的目标路径（目前只有合成产品包）写在 `tools/gen-contracts.ts` 里；另一个产品包需要时在那里加一行。
