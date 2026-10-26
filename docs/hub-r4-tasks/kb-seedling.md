# 任务：知识库树苗（kb-seedling）

所有者 10-24 原话：**每个版本一个树苗，剩下的都是由 Circle 来喂给树的。** 设计定稿（修订 2）全文见评审目录 `kb-design-1024.md`；本页与定稿一致，是方向 1（初始树苗）的设计页。

**修订：所有者 10-24**（修订 `docs/hub-r4-kb-direction.md` 第一节，那一节已同步改）：只有 adoc 手册（APP、CLI）和命令树 XML 由 Hub 的生产器生成，合成初始树苗；其余资料——构建头、测试清单（用例）、缺陷导出、规格、工单纪要等自由文本——一律"Circle 用到了才放进 Hub"，不进树苗，进挂在树苗旁的喂入层（方向 2，见 `docs/hub-r4-tasks/kb-feeding.md`）。

## 粒度

- 一条产品线 × 一条版本线一棵树苗；不再每个构建一个根。
- 命令树：这条版本线当前已发布构建的命令树 XML（取版本线最新已发布构建；哪个构建当前发布由产品包的构建清单机械决定，不猜）。
- 手册：这个版本的 CLI、APP 两份 adoc，按 SVN 固定修订号整批读（kb-svn 只读包），修订号进树苗记录。
- 同输入同字节：身份只含内容摘要（自下而上），时间戳不进身份。

## 合并规则（只认结构）

不许关键词、词典、同义词、前缀表或自由文本正则。

1. 命令树 XML 是命令部分的骨架：路径（词序列）、参数、命令树里声明的类型。
2. CLI 手册里记载命令的章节，只当章节的命令签名锚与命令树路径**完全相等**时挂到该命令节点上；对不上的按章节路径留在 CLI 手册子树里，不猜。
3. APP 手册按章节路径成一棵子树。

## 树苗节点布局（逐项写死）

| 路径 | 内容 | 键 |
| --- | --- | --- |
| `/commands/<词…>` | 命令树骨架：签名、参数、树里声明的类型；CLI 手册匹配上的章节也挂这里 | 命令树 menu/item 词序列 |
| `/manual/cli/<章节路径>` | CLI 手册没匹配上的章节，按章节路径 | 章节路径（adoc `=` 层级） |
| `/manual/app/<章节路径>` | APP 手册整棵 | 同上 |

用例、缺陷、需求/规格、构建、自由文本**都不进树苗**：进挂在树苗旁的喂入层（不进根摘要），带"版本绑定"——出处只有来源结构和人的声明两种，状态为 已绑定 / 未声明 / 冲突；定不出版本的进产品线不分版本范围、标"版本未声明"，照常参与，单列计数。运行中不问人，待办只登记在控制台；冲突和伪造的处理见 `kb-feeding.md`（照定稿摘要）。

## 存在 Hub 上的形状

- 树本体走现有生产管线（produceTree，只跑三个固定生产器）：`tree_node@1`、`knowledge-entry@1`、`tree_root@1` 照旧。
- 新增 `seedling@1` 记录（kind claim）：产品线、版本线、根摘要、tree_root 组成、所用构建、三样来源（command-tree / cli-manual / app-manual，各带原件 SHA 和 adoc 修订号）、父树苗（血缘，只追加）、basis。
- 每条产品线 × 版本线一个"当前树苗"指针 `seedling/<产品线>/<版本线>`，比较并交换地移动；移动写 `root_pointer@1` 记录，cause 指生产动作。
- 读法：`get_nodes` 按路径取子树（现有工具，不加新机制）。
- 不引入归位/未归位、组成分片、分面这类机制，越简单越好。

## 和现有知识库的关系

树苗是新的生产路径；现有的每构建知识根先不删，这次只是不再往上加东西：famx 产品包声明里的用例（cases）、修复缺陷（release-notes）、规格（specifications）和不分版本用例（unversioned-cases）生产器已从声明里去掉（函数保留，供喂入层逐次投影），旧的每构建根不动。

## 方向 2（等集成者通知再做）

客户端数据流喂树：模型在 Circle 里读手册和用例，提出对树苗的更新（新增节点、手册章节和命令的关联、适用条件、更正），带逐字引文；Hub 核验后按血缘只追加地产出树苗的新版本，走现有的回注运行（knowledge-contribution 包）。任务清单另写一页：`docs/hub-r4-tasks/kb-feeding.md`，先不实现。

## 方向 1 的实现（已按本页完成）

- 分支 `kb-seedling`，工作树 `circle-hub-kb-seedling`。
- 改动：`contracts/src/knowledge.ts`（新增 `seedling@1`，重跑 gen:contracts）、`hub/knowledge/seedling.ts`（produceSeedling / 当前树苗指针 / seedling 记录；produceTree 增加按生产器子集运行）、`packs/product/famx/product.json`（去掉四类生产器并重签 pack.json）、本页。
- 测试：`hub/knowledge/seedling.test.ts` 全部用合成 adoc 和 XML，版本线 10.6 起，地址只用 192.0.2.0/24；断言同输入两次产出字节相同（根摘要一致）、命令骨架、签名完全相等才挂、对不上的留手册子树、指针比较并交换。
- 验证：`npx tsc --noEmit`；`node tools/gen-contracts.ts --check`；`node --test --test-concurrency=1` 于 `hub/knowledge`、`packs/product/famx`、`contracts/src`。
- 真实的 SVN 读取和部署由集成者做。
