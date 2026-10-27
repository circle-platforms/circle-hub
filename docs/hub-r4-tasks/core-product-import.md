# 任务：核心代码直接导入产品包——调研并出设计说明（只写文档，不改代码）

依据：`AGENTS.md`（"核心代码不点名产品、命令或客户；产品内容进产品包"）；`docs/hub-r5-test-map.md` T7/T8 复核记下的缺口："核心 `hub/knowledge/directory-sources.ts` 直接导入产品包的 adoc 目录解析，T8 的身份字面检查为零命中但依赖仍在"。

## 现状

`hub/knowledge/directory-sources.ts` 第 4 行从 `packs/product/apv/functions/adoc/tree.ts` 导入 `ADOC_LIMITS, ManualSourceError, booksOf, directoryOf, listedSources, mainsOf, rootId`。这是核心里唯一一处导入产品包代码的地方（`grep -rn "packs/product" hub` 的非测试结果）。

## 要做的

只写一份设计说明 `docs/hub-r4-research/core-product-import.md`（中文），回答：

1. **清点**：这个导入涉及的每个符号做什么、被谁用（调用点列表，文件:行）、输入输出形状；`hub/knowledge/directory-sources.ts` 在核心里承担什么职责；有没有别的地方（测试、其他产品包、`packs/**` 对核心的反向依赖）也依赖这条耦合。
2. **分类**：按模型的四个内容归属（知识、规则、方法、资源）和四个所有权类别（核心、通用技能包、产品包、系统/工作流包）逐符号判断它该属于哪一类，给理由；哪些是 adoc 这种格式的通用结构（主文件、include 次序、书与目录的层次），哪些是 APV 手册目录布局特有的约定。判断依据写成模型元素编号（用 `node tools/show-element.ts <ids>` 查），不凭印象。
3. **方案**：至少两个迁移方案（例如：整体迁成通用技能包由核心经沙箱调用；拆成通用格式部分进技能包、布局约定留产品包并经产品声明传入；核心里只留接口），每个方案写：新的包与文件布局、核心与包之间的接口形状、对现有产出（树的字节、摘要、旧运行锁定）的影响、需要升版本重签的包、需要改的测试、风险和工作量（按提交数估）。给出你的推荐和理由。
4. **兼容**：已发布的 `apv` 产品包版本和已产出的树根（组成记录、条目摘要）在迁移后必须字节不变或有明确的迁移说明；写出怎么证明（用哪个现有测试或新增的等价测试）。
5. 不确定、需要所有者定的事，单列。

不要改任何代码、测试、包文件或 `contracts/`；不要运行会写 Hub 的命令；不碰钥匙串、环境配置文件、线上 Hub 和真实系统。

## 分支、路径和规矩

- 分支和工作树：`core-product-import`，目录 `codex-trees/core-product-import`（集成者已从 hub-redesign 开出，依赖已链接）。
- 可以改的路径：只有 `docs/hub-r4-research/core-product-import.md`。
- 规则：同前（不推送、不建 PR；`git commit -s`，只暂存明确路径；提交说明一句英文祈使句，无前缀无句号）。docs 检查要过（`node --test .github/checks/*.test.ts`）：不写本机绝对路径、内部地址或真实业务内容。

完成后在终端里回报：提交号、结论两三句、推荐方案、需要所有者定的事。
