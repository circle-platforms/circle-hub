# 运行工具通用技能包

`functions/modules/hub-client/` 是可复用模块（决定 153、154），只用 Node 内置模块，工作流的本地工具经 `embeds` 内嵌使用。只在这里改，不改生成的副本；改了要升本包版本，再改工作流的 `embeds` 并重签。

用 `node packs/skill/run-tools/api.ts sign` 重签，`check` 检查，`stage <目录>` 导出发布目录。发布时 Hub 核对内嵌文件等于这里已发布的版本，所以要先发布本包。
