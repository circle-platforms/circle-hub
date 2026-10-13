# 任务书：harness 适配器库（packages/harness-adapters）

## 范围

circle-hub 治理任何 harness 的原语（规范见 `docs/design/harness-primitives.md`，术语见 `docs/design/vocabulary.md`）。本任务做一个**纯 TypeScript 库**：把各 harness 自己格式的 Skill / Tool / MCP server / Hook / Instruction / Agent / Command 读成 hub 的中立清单（`hub-skill/1`、`hub-tool/1`、`hub-provider/1`、`hub-hook/1`、`hub-instruction/1`、`hub-agent/1`、`hub-command/1`），再从中立清单导出回该 harness 的文件。先做 Claude Code；Codex CLI 作为第二个，时间允许再做。Circle 自己的推导由 server 侧另做，不在本任务里。

不接 server、不接数据库、不连网、不读环境。输入输出都是「虚拟文件表」`{ [path: string]: string | Uint8Array }`，这样 hub 装载时给字节、导出时拿字节即可。

## 位置与规则

- 工作树 `~/Public/circle-hub-adapters`，分支 `harness-adapters`（基于 main）。只新建：`packages/harness-adapters/**`、`tests/methods/harness-adapters-*.test.ts`、`tests/fixtures/harness/**`、本任务书。不改其它任何文件（根 package.json 也不改：测试放在 `tests/methods/` 下即可被现有 `npm run test:methods` 跑到）。
- Node 24，`node --test`，依赖只用仓库已有的（zod 4.6.5 可用；不新增依赖）。`npx tsc --noEmit` 必须通过。
- 仓库 AGENTS.md 的提交规矩：显式 stage 路径；提交信息一句首字母大写的英文祈使句，无前缀无句号；不推送。每个交付物一次提交。
- fixture 全部合成：不出现真实地址、本机绝对路径、凭据；示例地址用 example.com / 192.0.2.0/24。

## 交付物

1. `neutral.ts`：中立清单的 TS 类型 + zod schema。字段以 `docs/design/harness-primitives.md` 为准；文档没写到的字段，不要悄悄发明——写进本任务书末尾的「待定」一节，先用最小字段。每种清单都带 `sourceHarness`、`knownCompatible[]` 和 `harnessSpecific`（原样保留 harness 专有字段，保证往返不丢）。
2. `claude-code.ts`：Claude Code 的导入/导出。覆盖：`.claude/skills/<name>/SKILL.md`（YAML frontmatter + 正文）→ hub-skill；`.claude/commands/*.md` → hub-command；`.claude/agents/*.md`（frontmatter name / description / tools / model）→ hub-agent；`CLAUDE.md` → hub-instruction；`.claude/settings.json` 的 `hooks`（事件、matcher、command）→ hub-hook（`language: shell`，`deterministic` 未知时置 false 并说明）；`.mcp.json` 的 `mcpServers`（stdio 与 http 两种）→ hub-provider（端点、密钥、环境变量**不进清单**，只留名字和形状，放 harnessSpecific 的也要脱掉秘密值）。推导不出的留空，不猜。
3. `codex.ts`（可选）：`AGENTS.md` → hub-instruction；`.codex/config.toml` 的 `mcp_servers` → hub-provider。TOML 解析不新增依赖：只支持本任务需要的子集，并在测试里写明边界。
4. `index.ts`：`importFrom(harness, files)`、`exportTo(harness, manifests)` 两个入口，返回 `{ manifests, warnings[] }` / `{ files, warnings[] }`；warnings 是结构化的 `{ code, path, detail }`，不是自由文本。
5. 测试：往返（导入→导出得到逐字节相同文件，做不到的地方 warnings 说明）、缺字段、多个 hook、stdio/http 两种 MCP server、frontmatter 坏掉、空目录。fixture 放 `tests/fixtures/harness/claude-code/`。

## 验收

- `npx tsc --noEmit` 与 `npm run test:methods` 通过，且不影响其它测试。
- 一个用 Claude Code 格式写的合成 Skill 能导入成 `hub-skill/1`，再导出回去逐字节一致。
- 任何清单里都不含端点、密钥、环境变量值、绝对路径。

## 待定（做的时候填）

规范没定义、本任务临时取最小字段或最小行为的地方（第二轮复核后）：

- `hub-skill/1` 的 inputs / outputs / triggers 规范只给了名字没给形状：取最小的 string[]（名字列表）。Claude Code / Codex 的 SKILL.md 没有这些字段，导入时留空。
- `hub-command/1` 的 arguments 形状未定义：取 optional string，只映射真正的 frontmatter `arguments` 键；Claude Code 的 `argument-hint` 不是 arguments，放 harnessSpecific.argumentHint。正文里的 `$ARGUMENTS` 占位符不进清单。
- `hub-hook/1` 的 event：规范固定了 hub 侧五个钩子点（`verify.*`、`beforeDispatch`、`afterResult`），但没写 harness 客户端事件（PreToolUse / PostToolUse / SessionStart…）到它们的对应关系；适配器原样保留 harness 事件名，每种事件一条 HOOK_EVENT_UNMAPPED（复核写的是「每个 hook 一条」，括号里又否定按命令计；按「每种事件一条」实现）。order 留空（harness 钩子并行，顺序是编的）；deterministic 留空（任意 shell 命令的可证真性推导不出，也不写 false）。matcher、timeout 等专有键放 harnessSpecific.entry / .matcher。
- `hub-instruction/1` 的 scope 推导不出就留空；applies 只有 `.claude/rules/*.md` 能从 frontmatter `paths` 取到，其余为空数组。
- `hub-provider/1` 规范表格没有 name 字段：清单加了 `name`（`mcpServers` / `mcp_servers` 的键），登记与导出都需要它。credentialMode 推导不出，留空（不写 static）。provides / reads / writes 从静态配置文件推导不出（要运行时发现）：provides 整个留空（undefined），reads / writes 为空数组。credentials 只列 env / headers / http_headers 的键名（oauth 键名不进 credentials）。
- transport：规范只有 stdio / streamable-http 两个值。Claude `.mcp.json`：`type: "streamable-http"` 是 `http` 的别名；sse、ws 等没有对应值：transport 留空并报 PROVIDER_TRANSPORT_UNKNOWN；有 url 无 type、command 与 url 并存、command 配非 stdio 的 type：整条跳过并报 PROVIDER_ENTRY_INVALID（detail 只写条目名）。Codex 的 mcp_servers 没有 type 键：只有 url 的条目是合法的 Streamable HTTP（伴随键 auth / bearer_token_env_var / http_headers / env_http_headers 原样留在骨架键名里），command 与 url 并存仍整条跳过。
- 字节与导出：清单只含字段，不含文件全文；每份清单记 `files: [{path, sha256}]` 指向来源文件。导出签名是 `exportTo(harness, manifests, files)`：markdown 类 = 清单重写 frontmatter + 原文件正文（实现为「与原文件推导值比对，一致就原样返回原文字节」，所以未改时逐字节相同，且不要求原 frontmatter 是任何规范形式）；配置类（settings.json / settings.local.json / hooks.json / .mcp.json / config.toml）由清单结构 + 原文件字节重生成：manifest 里的 shape 只留键名（对象值记嵌套键名），导出时从原文件取值并重新套用脱敏规则——对象值与 url 写成 `[redacted]` 占位并报 SECRET_PLACEHOLDER，cwd 不导出，args 重标红，绝对路径 command 降 basename。harnessSpecific 只放位置与结构信息（path、frontmatterKeys、hadFrontmatter、eventIndex / groupIndex / entryIndex、entryKeys、shape 骨架、server 原名）和未映射的 frontmatter 键。
- 脱敏按结构且结构覆盖全：配置表进 harnessSpecific.shape 一律只留键名、值一律去掉，不分四类（headersHelper 这类未知键因此也不带值）；cwd 去掉并报 PROVIDER_CWD_DROPPED；args 元素含 `://`、以 `/` 或 `~` 开头、或形如 `--x=y` / `-x=y` 的替换为 `[redacted]`；钩子命令先按 shell 词法切词（尊重引号），程序名取 basename（HOOK_COMMAND_PATH），其余每个词套 args 同样的规则，另加 Bearer 关键词规则（`Bearer` 后一个词、或词内含 `Bearer <x>` 的整词替换为 `[redacted]`，报 HOOK_ARG_REDACTED）；handler 只保留处理后的命令。Markdown frontmatter 是例外：未映射键保留键和值——frontmatter 是模型可见的配置、本来就在 Git 里；边界写死在此：frontmatter 里的值不做秘密清洗，若某 harness 把秘密写进 frontmatter，会随清单走（目前的 Claude Code / Codex 格式都不这么用）。所有 warning 的 detail 只写路径、行号、键名，不写值、不写整行。
- 位置覆盖：Claude Code 侧 `**/.claude/skills/<name>/SKILL.md`（任意层级）、`.claude/commands/<dir>/<name>.md`（名字 `dir:name`）、`.claude/rules/**/*.md`（递归；applies ← frontmatter `paths`）、`.claude/agents/**/*.md`（递归；身份不随子目录改变）、CLAUDE.md / CLAUDE.local.md / AGENTS.md（任意层级）、`.claude/settings.json` 与 `.claude/settings.local.json`、`.mcp.json`。Codex 侧 `**/.agents/skills/<name>/SKILL.md`、AGENTS.md / AGENTS.override.md、`.codex/hooks.json`、`.codex/config.toml`。用户级（`~/...`）文件不在虚拟文件表里，不导入。Codex 的 `.codex/agents/*.toml` 与 `~/.codex/prompts` 本轮不做。
- `.codex/hooks.json` 的形状假定与 Claude 设置文件同构（`{hooks: {event: [{matcher?, hooks: [{type, command}]}]}}`），待真实 Codex 格式核实。
- 配置文件里 hooks、mcpServers / mcp_servers 以外的顶层键不属于被治理原语：导入报 CONFIG_EXTRA_KEYS，导出丢弃。空配置（空文件、无对应节、节为空）报 EMPTY_CONFIG。TOML 注释无法随清单往返：导入报 TOML_COMMENT_DROPPED（只给行号）。JSON 配置文件的逐字节往返只在文件恰好是规范形式（2 空格缩进、末尾换行）时成立；否则导入报 CANONICAL_NORMALIZATION。emitToml 的表头规则：只有子表时不写空头（如 `[mcp_servers]`），空表整体不写。
- Claude Code command 的名字由文件路径决定（其 frontmatter 没有 name 字段），直接取、不告警；skill / agent 的 frontmatter 缺 name 时才从路径推导并报 NAME_DERIVED_FROM_PATH。
- 非 command 类型的钩子条目（http / prompt / agent / mcp_tool）跳过并报 HOOK_ENTRY_SKIPPED，detail 只带位置与类型名。

## 待定（第三轮，OpenCode / Gemini CLI / Cursor）

- 共享：codex hook 的 language 不填（调查写明「不能据此填写」）；hook 清单的 harnessSpecific 记 entryKeys / groupKeys（键名），导出从原文件合回额外键（含 Gemini 的 sequential、Cursor 的 version）；Cursor hooks.json 是扁平条目（无 matcher 组），自写导入导出，位置记 eventIndex / entryIndex。
- OpenCode：技能 id 由路径决定（frontmatter `name` 只是显示名，留在未映射键）；根上 `<id>.md` 是单文件技能（entry 就是文件名）；命令名嵌套用 `/`（不是 `:`），旧单数目录 `.opencode/command/` 也导入；代理嵌套路径计入 id。兼容目录 `.claude/skills`、`.agents/skills` 不导入（归各自适配器）。`opencode.json(c)` 支持 JSONC（注释与尾逗号，stripJsonc），导出写规范 JSON。本地条目 command 是数组：首元素是程序（绝对路径降 basename），其余套 args 规则。`type` 缺失 → PROVIDER_SHAPE_UNKNOWN；其他 type 值 → PROVIDER_TRANSPORT_UNKNOWN。hooks 无独立文件不导入（插件代码里注册）；hub-hook/1 导出到 OpenCode 报 NO_HARNESS_PROJECTION。
- Gemini CLI：commands 是 TOML——prompt 是正文不进清单，description 是唯一映射字段；description 改了时按原键序重写该键、其余键从原文件带回；多行 `"""` 基本字符串已支持，重写时规范为单行基本字符串。agents 的 tools 通配符（`*`、`mcp_*`）原样保留不展开。settings.json 同文件装 hooks 与 mcpServers：两个 importer 共享该文件，extra keys 与 canonical 检查只报一次；文件为空报一次 EMPTY_CONFIG；只有其它键（两节都不在）只报 CONFIG_EXTRA_KEYS。SSE（`url`）transport 留空并报 PROVIDER_TRANSPORT_UNKNOWN。`context.fileName` 指向的别名 instruction 不解析，只认 GEMINI.md。一个文件里多个远程代理的 YAML 列表超出 frontmatter 子集：会报 FRONTMATTER_LINE_SKIPPED 并按文件名推导 name。
- Cursor：commands 未查到用户/工作区级目录，不做（导出 hub-command/1 报 NO_HARNESS_PROJECTION）。rules `*.mdc` 的 `globs` → applies；description、alwaysApply 留在未映射键。hooks.json 的 `prompt` 类型跳过；version 从原文件带回。agent 的 `readonly` 不是工具白名单，tools 留空。技能 frontmatter 的 `paths` 是文件范围不是 triggers，留在未映射键。mcp.json：command（type 省略或 `stdio`）→ stdio；只有 url → transport 留空（文档写 HTTP 或 SSE，未钉死）。兼容目录 `.claude/agents`、`.codex/agents` 不导入（归各自适配器）。

## 复核第一轮（Claude 与独立复核人，2026-10-13，对 b544336）

tsc 与 50 个测试通过；fixture 卫生合格；hooks / `.mcp.json` / `[mcp_servers]` 的基本形状对。下面是必须改的，按决定写，不是建议。改完升到第二轮提交，测试覆盖每一条。

### A. 字节不进清单（设计改动）

- 清单只含字段，不含文件全文：去掉 `harnessSpecific.source` 和附属文件内容。资产的字节由 hub 冻结在资产侧，本库的导出接「清单 + 原文件表」：`exportTo(harness, manifests, files)`。
- 导出规则：配置类文件（`settings.json` 的 hooks、`.mcp.json`、`config.toml`）由清单重生成，被脱敏的值写成占位并报 `SECRET_PLACEHOLDER`；Markdown 类原语（skill / command / agent / instruction）frontmatter 由清单重写、正文取自原文件字节。清单未改时导出逐字节等于原文件；清单改了 frontmatter 字段时导出体现改动（补一条测试）。
- 每份清单记 `files: [{path, sha256}]` 指向它的文件；`harnessSpecific` 只放未映射的 frontmatter / 配置键。

### B. 脱敏按结构，不靠猜（高 4、5、6、7、8）

- `env`、`headers`、`http_headers`、`oauth.*` 的所有值一律去掉，只留键名；`cwd` 去掉并报 `PROVIDER_CWD_DROPPED`。
- `args`：含 `://`、以 `/` 或 `~` 开头、或形如 `--x=y` / `-x=y` 的元素替换为 `[redacted]` 并报 `PROVIDER_ARG_REDACTED`；其余原样。
- 钩子命令：绝对路径段替换为 basename 并报 `HOOK_COMMAND_PATH`；原文仍在 files 里。
- 任何 warning 的 `detail` 只写路径、行号、键名，**不写值、不写整行**（TOML 跳过行尤其）。

### C. 映射更正（高 1、2、3、9；中 11、12、13、14、17）

- `allowed-tools` 不映射到 `tools`（它是免询问一轮，不是工具限制）：按空格或逗号切分后放 `harnessSpecific.allowedTools`。
- 技能 frontmatter 的 `model` 映射到 `hub-skill/1.model`。
- `argument-hint` 不是 `arguments`：放 `harnessSpecific.argumentHint`；frontmatter 真正的 `arguments` 才映射。
- MCP 条目：`type: ws` → `transport` 留空并报 `PROVIDER_TRANSPORT_UNKNOWN`；有 `url` 无 `type`、或 `command` 与 `url` 并存 → 整条跳过并报 `PROVIDER_ENTRY_INVALID`（detail 只写名字）。
- 钩子：不发明 `order`（harness 钩子并行，`order` 留空）；`event` 原样保留 harness 事件名，每个 hook 一条 `HOOK_EVENT_UNMAPPED`（不是每条命令一条）；`deterministic` 留空（不可推导），不写 false。
- `scope`、`applies`、`credentialMode` 推导不出就留空；`credentials` 只列 env / header 的键名。
- `provides` 留空（undefined），不写三个空数组。
- 删除 `hub-tool/1` 这个独立 kind：规范里 Tool 在 provider 的 `provides` 里。

### D. 位置补全（中 10、16）

- Claude Code：`**/.claude/skills/<name>/SKILL.md`（任意层级）、`.claude/commands/<dir>/<name>.md`（名字 `dir:name`）、`.claude/rules/*.md`（instruction，`applies` 取 frontmatter 的 `paths`，没有就留空）、`CLAUDE.local.md`、`AGENTS.md`、`.claude/settings.local.json`。用户目录（`~/…`）不在文件表里，文档里写明「用户级不导入」。
- Codex：`.agents/skills/<name>/SKILL.md` → hub-skill，`.codex/hooks.json` → hub-hook，`AGENTS.override.md` → instruction；`.codex/agents/*.toml` 与 `~/.codex/prompts` 本轮可不做，但要在待定里写明。

### E. 其它（中 15；低 20）

- 空的 `settings.json` / `.mcp.json` / `config.toml`：报 `EMPTY_CONFIG`，不静默。
- TOML 注释：往返保留；做不到就报 `TOML_COMMENT_DROPPED`。
- `emitToml` 不写出空的 `[mcp_servers]` 头。
- `type` 不是 command 的钩子（http / prompt / agent / mcp_tool）继续跳过并报 `HOOK_ENTRY_SKIPPED`，detail 不含正文。

### F. 测试

每条 A–E 一个失败路径测试；脱敏断言要能抓到嵌在长字符串中间的端点和路径；往返测试分「清单未改」和「清单改了 frontmatter」两种。

## 复核第二轮（Claude 与独立复核人，2026-10-13，对 dd8c3e2）

A–F 基本到位；下面是第三轮要收口的，都是决定：

1. Codex `mcp_servers` 只有 `url` 的条目是合法的 Streamable HTTP（Codex 没有 `type` 键；可选 `auth`、`bearer_token_env_var`、`http_headers`、`env_http_headers`）：导入为 `transport: streamable-http`，url 值照脱敏规则清掉；不再报 `PROVIDER_ENTRY_INVALID`。Claude 的 `.mcp.json` 规则不变（无 `type` 的 url 仍是配置错误）。
2. Claude `.mcp.json` 的 `type: "streamable-http"` 是 `http` 的别名：同样映射为 `streamable-http`。
3. 密钥只按结构、但结构要覆盖全：a) 钩子命令按 shell 词法切词（尊重引号）后对每个词套用和 MCP `args` 相同的规则（含 `://`、以 `/` 或 `~` 开头、`--x=y` / `-x=y` → `[redacted]`），程序名取 basename；`handler` 只保留处理后的命令；b) 配置文件（`settings.json` 的 hook 条目、`.mcp.json`、`config.toml` 表）进 `harnessSpecific.shape` 时**只留键名，值一律去掉**，不分四类，`headersHelper` 这类自然就不带值；c) Markdown frontmatter 的未映射键保留键和值（frontmatter 是模型可见的配置，本来就在 Git 里），但在任务书「待定」里写明这条边界。
4. `emitToml` 只有子表时不写空的 `[mcp_servers]` 头。
5. `.claude/rules/` 递归发现（子目录里的 `*.md` 也是规则）；`.claude/agents/` 的子目录文件也导入（身份不随子目录改变）。
6. 测试补：以上每条各一个失败路径；Codex 只有 url 的条目往返；`streamable-http` 别名；钩子命令里的 `Bearer x` 和 URL 不进清单；`headersHelper` 值不进清单；子目录 rules / agents。
