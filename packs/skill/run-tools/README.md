# 运行工具通用技能包

`functions/modules/hub-client/` 是可复用模块（决定 153、154），只用 Node 内置模块，工作流的本地工具经 `embeds` 内嵌使用。只在这里改，不改生成的副本；改了要升本包版本，再改工作流的 `embeds` 并重签。

用 `node packs/skill/run-tools/api.ts sign` 重签，`check` 检查，`stage <目录>` 导出发布目录。发布时 Hub 核对内嵌文件等于这里已发布的版本，所以要先发布本包。

1.0.2：`downloadRun` 除运行记录、条目和绑定原件外，还一次取回运行锁定的产品知识根（Hub 的 `/run-export/<运行>/knowledge`，模型 K05、D06 R[2]），核对摘要后写到 `knowledge/`：`nodes.jsonl` 是 Hub 答复的原字节，根的每个顶层节点一个文本文件（`# <路径>` 一块，条目原文后面跟它的引用），`index.json` 列出根、条数和文件。运行没有锁定根、读者读不到或 Hub 没有这个出口时不写这个目录，报告里 `knowledge` 为 null。
