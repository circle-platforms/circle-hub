# 任务：case-compile 3.9.16（#144 原始用例层级、#130 示例自洽、#143 技能说明）

- 分支和工作树：`case-compile-3916`，从 hub-redesign 开出。
- 可以改的路径：`packs/workflow/case-compile/**`（不含 `functions/generated`）、`tests/acceptance/38-r5-t4-1-block-cases.test.ts`（夹具改标题时同时给路径）和本页。不加数据库迁移，不改 `contracts/model.json` 的版本。
- 规则：不推送、不建 PR、不发布、不部署；测试只用合成夹具；`git commit -s`。

## 1. 每个用例的第一行写原始用例的层级（#144）

要求：Excel 里自动化 ID 所在的那一行显示原始用例，格式 `AAA>BBB>CCC`（原始用例在脑图里的层级）。

先查运行器怎么用这一列。InfoTest 运行器（只读镜像，`lib/test_xlsx.py`；`smoke_test/test_xlsx.py` 写法相同）：

- D 列（`row[3]`）只用来写日志：`log_and_check_line`（第 25–27 行，在第 1078、1093 行调用）把它打成 `step<C>: <D>`；
- C=0 那一行的 D 是整份工作簿的用例说明（`get_description`，第 862–871 行），本包写的是计划运行号和构建，不动；
- 一行执不执行看 E–I（`_row_is_non_executable`，第 634–640 行），选哪个用例看 A 和 E（`ifrun`，第 840–856 行），执行只读 A、C、E–I。

所以 D 列对运行器是随意文字，层级就写在 D 列本身，不另占一列。CES 的编译也把 D 当步骤说明（`Step.description`），脑图分组路径 `group_path` 同样逐字取自脑图。

改法：

- `functions/project.ts`：开始运行时给每个用例算 `fields.path`，即从脑图根到这个用例的各节点原文，沿抽取用例时走的同一套 children 关系，不改写文字；计划运行冻结的计划集合也带上它。
- `functions/generate.ts`：每个用例第一行（带 autoid 的那行）的 D 写 `path` 用 `>` 连起来的文字，后面几行仍写用例标题；`path` 进入配方摘要。缺 `path`，或它的最后一段不是本用例标题时，拒绝生成，并写明要重新开始运行。路径里有生成子集不收的文字（`=` 开头、控制字符、`_xHHHH_`），和其他单元格一样拒绝。
- `functions/workbook.ts`：独立回读时，第一行 D 要等于路径，其余行等于标题；`tools/generate-workbook.ts` 把条目里的 `path` 带进生成。
- 测试：`functions/whole-mindmap.test.ts` 新增一条，对一个带分组的脑图，投影出的路径应为 `合成文档>合成分组>合成标题二`，只有 autoid 行显示路径；把路径换成别的，回读会同时报 `step` 和 `recipe`。closure 07、生成拒绝的几条测试改成同时给出路径，并加两条拒绝（缺路径、末段不是标题）。

## 2. 自带示例互相对得上（#130）

- `testing/examples.ts`：用包自己的投影（`projectItems`，kityminder@1 解析）从 `examples/case-mindmap.json` 推出上传引用 `src:f568a541…`、条目号和每条引文的 `src:<sha>/kityminder@1/<选择器>`；`--write` 改写 `start-run.json` 和 `submit-result.json`。`tools/normalize-mindmap.ts` 对这份脑图不做任何改动，前后摘要相同。
- `start-run.json`：subject 改成上传的 `src:` 引用，产品和构建写占位，说明里写清要先发布哪几份文件、需自备产品包。
- `examples.test.ts`：示例与推导结果不一致就失败（对旧的 submit-result 已确认会失败）。
- 3.9.16 没改的一点：上传的脑图没有文档号时，`documentIdOf` 拿第一个用例的节点号当文档号。所有者已决定改，见下面 3.9.17。

## 3. 技能说明用日常话（#143）

`SKILL.md` 第 3 行和 `pack-files.ts`（以及 `pack.json`）里的说明改成：把一整份测试脑图编译成自动化用例 Excel 工作簿，再交给自动化测试环境执行；需要这份脑图在敏捷平台上的文档号。没有加按关键词找文档。

## 版本

3.9.16：`pack-files.ts`、`pack.json`、`tables/workbook-format.json`、`pack.test.ts`、`publish.test.ts`；`node testing/samples.ts` 和 `node pack-files.ts --write` 已重跑。本包没有签名。

## 3.9.17：上传的脑图用根节点命名（所有者决定）

- 没有敏捷文档号（上传的文件）、解析器也没给文档号时，文档号（条目号 `<文档>:<节点>` 的前半段）改用根节点的节点号，和 `documentIdOf` 的注释一致；3.9.16 及以前用的是第一个用例的节点号。
- 根节点没有节点号的树（不带节点号的大纲）用 `tree-<sha256>` 命名：把整棵树只留每个节点的原文和子节点顺序，按规范 JSON 算 SHA-256（`functions/cases.ts` 的 `rootDocumentId`）。这是算出来的，不是猜的：原文和结构不变，每次都一样；改了任何一处文字或结构，就不一样。
- 已经开始的运行保留它们记录里的条目号：记录只追加，不改写。只有用 3.9.17 及以后开始的新运行才按新规则，所以同一份上传文件，在这个版本前后的记录里可能有两种条目号。
- 示例用 `node testing/examples.ts --write` 重新生成，条目号现在是 `fixture-document:fixture-case`。
- 测试（`functions/whole-mindmap.test.ts`）：kityminder 根节点号命名，敏捷文档号仍然优先；无节点号的树两次开始得到同一个摘要，改一个期望或分组文字就变。
- 版本 3.9.17：改动的文件同 3.9.16；`node testing/samples.ts`、`node pack-files.ts --write` 已重跑。
