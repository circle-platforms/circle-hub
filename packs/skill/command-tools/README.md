# 命令工具通用技能包

`functions/modules/command-check/` 是可复用模块。`grammar.ts` 由 `tools/gen-contracts.ts` 从 `contracts/src/command-grammar.ts` 生成，类型在那里检查；`command-policy.ts` 在这里改。

只在这里改模块，不改工作流里生成的副本；改了要升本包版本，再改工作流的 `embeds` 并重签。发布时 Hub 核对内嵌文件等于这里已发布的版本，所以要先发布本包（决定 153、154）。
