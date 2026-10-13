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

规范没定义、本任务临时取最小字段或最小行为的地方：

- `hub-skill/1` 的 inputs / outputs / triggers 规范只给了名字没给形状：取最小的 string[]（名字列表）。Claude Code 的 SKILL.md 没有这些字段，导入时留空。
- `hub-command/1` 的 arguments 形状未定义：取 optional string，从 Claude Code 的 `argument-hint` 映射；正文里的 `$ARGUMENTS` 占位符不进清单。
- `hub-hook/1` 的 event：规范固定了 hub 侧五个钩子点（`verify.*`、`beforeDispatch`、`afterResult`），但没写 Claude Code 客户端事件（PreToolUse / PostToolUse / SessionStart…）到它们的对应关系；适配器原样保留 harness 事件名，映射表待规范补充。matcher、timeout 等 Claude Code 专有键放 harnessSpecific。
- hook 的 deterministic：Claude Code hook 是任意 shell 命令，可证真性推导不出；按任务书置 false，并逐条发 HOOK_DETERMINISM_UNKNOWN 警告作为「说明」。
- `hub-instruction/1` 的 scope 取值规范未枚举：项目级指令文件取 `"project"`；applies 取所在目录列表，仓库根目录为空数组。
- `hub-provider/1` 规范表格没有 name 字段：清单加了 `name`（`mcpServers` / `mcp_servers` 的键），登记与导出都需要它。credentialMode 枚举按规范第七章的三种凭据模式取 `static` / `platform-issued` / `external-oauth`；配置文件里嵌入的密钥属 `static`，无凭据时留空。legacy sse 传输在规范的两个 transport 值之外：transport 留空并报 PROVIDER_TRANSPORT_UNKNOWN。
- provider 的 provides / reads / writes 从静态配置文件推导不出（要运行时发现），一律留空，不猜。
- harnessSpecific 里存了原文件完整文本（source；非 UTF-8 字节为 base64）以及 skill 目录的附属文件：规范把字节冻结在资产侧，但本库导出的输入只有清单，要保证同 harness 逐字节往返只能让清单自带字节。跨 harness 导出（从别的 harness 的清单生成 Claude Code 文件）规范未定义投影方式，不做：报 CROSS_HARNESS_EXPORT 并跳过。
- MCP server 条目里适配器不认识的专有键原样保留在 harnessSpecific.shape；args 元素若是绝对路径或 URL，以 `"[redacted]"` 顶替并报 PROVIDER_ARG_REDACTED——藏在 args 值里的密钥无法可靠识别，不做猜测性清洗。command 是绝对路径时降为 basename 并报 PROVIDER_COMMAND_ABSOLUTE。
- settings.json / .mcp.json / config.toml 中 hooks、mcpServers / mcp_servers 以外的顶层键不属于被治理原语：导入报 CONFIG_EXTRA_KEYS，导出丢弃。
- JSON 配置文件的逐字节往返只在文件恰好是规范形式（2 空格缩进、末尾换行）时成立；否则导入报 CANONICAL_NORMALIZATION，导出写规范形式。fixture 里的 settings.json 就是规范形式，所以 hook 往返可以做到逐字节一致。
- Codex 的 TOML 解析只支持本任务需要的子集：注释、`[a.b]` 节（bare 或引号键）、字符串 / 整数 / 浮点 / 布尔 / 单行标量数组。内联表、多行字符串、表数组、日期一律跳过并报 TOML_LINE_SKIPPED；边界固定在 tests/methods/harness-adapters-codex.test.ts 里。
- Claude Code command 的名字由文件名决定（其 frontmatter 没有 name 字段），直接取文件名、不告警；skill / agent 的 frontmatter 缺 name 时才从路径推导并报 NAME_DERIVED_FROM_PATH。
