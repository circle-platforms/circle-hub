# harness-adapters

把各 harness 自己格式的 Skill / Command / Agent / Instruction / Hook / MCP server 读成 hub 的中立清单（`hub-skill/1`、`hub-command/1`、`hub-agent/1`、`hub-instruction/1`、`hub-hook/1`、`hub-provider/1`），再从中立清单导出回该 harness 的文件。规范见 `docs/design/harness-primitives.md`，各 harness 的磁盘格式依据见 `docs/design/harness-formats.md`。

纯 TypeScript，无运行时依赖（zod 仅用于导出边界校验）：不接 server、不读数据库、不连网、不读环境。

## API

```ts
import { importFrom, exportTo, type VirtualFiles, type HubManifest } from './packages/harness-adapters/index.ts';

const { manifests, warnings } = importFrom(harness, files);
const { files: outFiles, warnings: exportWarnings } = exportTo(harness, manifests, files);
```

- `harness`: `'claude-code' | 'codex' | 'opencode' | 'gemini' | 'cursor'`
- `files` / `outFiles`: 虚拟文件表 `{ [path: string]: string | Uint8Array }`，路径为项目相对的 POSIX 形式。hub 装载时给字节、导出时拿字节。
- `importFrom` 返回 `{ manifests, warnings[] }`；`exportTo` 返回 `{ files, warnings[] }`。warnings 是结构化的 `{ code, path, detail }`——detail 只写路径、行号、键名，从不写值或整行内容。

### 清单与字节

- 清单只含字段，不含文件全文。每份清单记 `files: [{ path, sha256 }]` 指向来源文件；`harnessSpecific` 只放位置与结构信息（原路径、frontmatter 键序、事件/组/条目的位置、配置条目的键名骨架）和未映射的 frontmatter 键（键和值都保留——frontmatter 是模型可见的配置，本来就在 Git 里）。
- 导出必须把**同一份原文件表**传回 `exportTo`：markdown 类原语的正文和 skill 的附属文件取自原文件；配置类文件由清单结构加原文件重生成。
- 逐字节规则：markdown 清单未改时导出逐字节等于原文件（frontmatter 字段改了则重写 frontmatter、正文不动）；JSON 配置文件在原文是规范形式（2 空格缩进、末尾换行）且无脱敏时逐字节一致；TOML 与 JSONC 的注释不随清单往返（报 `TOML_COMMENT_DROPPED` / `CANONICAL_NORMALIZATION`）。
- 跨 harness 导出不支持：`sourceHarness` 不匹配目标时报 `CROSS_HARNESS_EXPORT` 并跳过。

### 脱敏（按结构，不靠猜）

- 配置条目进清单的 shape 一律只留键名：对象值记嵌套键名，其余键只记存在。`headersHelper` 这类未知键因此也不带值。
- 导出时从原文件取值并重套规则：对象值与 url / httpUrl 写成 `[redacted]` 占位并报 `SECRET_PLACEHOLDER`；`cwd` 不写；args 里含 `://`、以 `/` 或 `~` 开头、形如 `--x=y` 的词替换为 `[redacted]`；绝对路径 command 降 basename。
- 钩子命令先按 shell 词法切词（尊重引号），程序名取 basename，其余每个词套同一套规则，另加 Bearer 关键词规则。
- `credentials` 只列 env / headers / http_headers / env_http_headers / environment 的键名。

## Warning codes

| code | 含义 |
|---|---|
| `FRONTMATTER_UNCLOSED` | 开头的 `---` 没有收尾；整份文件当正文，frontmatter 字段为空 |
| `FRONTMATTER_LINE_SKIPPED` | frontmatter 某行超出支持的 YAML 子集，跳过（只报行号） |
| `NAME_DERIVED_FROM_PATH` | skill / agent 的 frontmatter 缺 `name`，从位置推导 |
| `HOOK_EVENT_UNMAPPED` | harness 事件名原样保留；规范没定义到 hub 五个钩子点的映射（每种事件一条） |
| `HOOK_ENTRY_SKIPPED` | 钩子条目跳过（非 command 类型或形状残缺；只报位置和类型名） |
| `HOOK_COMMAND_PATH` | 钩子命令的程序名是绝对路径，降为 basename |
| `HOOK_ARG_REDACTED` | 钩子命令某词命中脱敏规则（Bearer、端点、绝对路径、`--x=y`） |
| `HOOK_ENTRY_DROPPED_ON_EXPORT` | Cursor 专用：原 hooks 文件不在导出文件表里，导入时被跳过的条目无法原样保留 |
| `SKILL_SHADOWED` | 同名技能被同层别名位置遮蔽（Gemini 的 `.agents/skills/` 优先于 `.gemini/skills/`），只导入会被加载的那份 |
| `CONFIG_EXTRA_KEYS` | 配置文件里被治理节之外的顶层键；导出时丢弃 |
| `CONFIG_JSON_INVALID` | 不是合法 JSON / 顶层不是对象 / 节形状错误 |
| `EMPTY_CONFIG` | 配置文件为空、或被治理的节不存在 / 为空（共享设置文件只对「存在但为空」的节报） |
| `TOML_COMMENT_DROPPED` | TOML 注释无法随清单往返（只报行号） |
| `TOML_LINE_SKIPPED` | TOML 行超出支持的子集，跳过（只报行号） |
| `PROVIDER_VALUES_STRIPPED` | 值不进清单（键名保留）；列出被脱敏的键名 |
| `PROVIDER_CWD_DROPPED` | `cwd` 是本机目录，不进清单、不导出 |
| `PROVIDER_ENTRY_INVALID` | 条目自相矛盾（command 与 url 并存、Claude 的无 type url、local/remote 缺必填键），整条跳过 |
| `PROVIDER_COMMAND_ABSOLUTE` | command 是绝对路径；导出降为 basename |
| `PROVIDER_ARG_REDACTED` | args / command 数组中某词命中脱敏规则 |
| `PROVIDER_TRANSPORT_UNKNOWN` | transport 无法对应 hub 的两个取值（sse / ws / Cursor 的 url 等），留空 |
| `PROVIDER_SHAPE_UNKNOWN` | 条目没有 command 也没有 url（OpenCode 缺 type），transport 留空 |
| `SECRET_PLACEHOLDER` | 导出把脱敏值写成 `[redacted]` 占位；列出要用前要回填的键名 |
| `SOURCE_FILE_MISSING` | 清单指向的文件 / 配置条目不在导出的文件表里 |
| `CANONICAL_NORMALIZATION` | JSON 合法但不是规范形式；导出写规范形式，不会逐字节相同 |
| `UNRECOGNIZED_FILE` | 不匹配该 harness 任何原语位置，未导入 |
| `CROSS_HARNESS_EXPORT` | 清单的 sourceHarness 与导出目标不同，跳过 |
| `NO_HARNESS_PROJECTION` | 该原语在此 harness 没有文件投影（如 OpenCode 的 hook、Cursor 的 command） |
| `MANIFEST_INVALID` | 清单没过中立 schema（导出边界校验） |

## 覆盖矩阵

项目级位置（用户级 `~/...` 文件不进虚拟文件表，一律不导入）。「✓」= 导入导出都支持，「—」= 不做（原因在备注）。

| 原语 | Claude Code | Codex | OpenCode | Gemini CLI | Cursor |
|---|---|---|---|---|---|
| Skill | `.claude/skills/**/SKILL.md` | `.agents/skills/**/SKILL.md` | `.opencode/skills/`：`SKILL.md` 任意深度、根上 `<id>.md`；兼容 `.claude/skills/`、`.agents/skills/` | `.gemini/skills/<name>/SKILL.md`、`.agents/skills/<name>/SKILL.md`（别名优先，被遮蔽报 `SKILL_SHADOWED`） | `.cursor/skills/**/SKILL.md`、`.agents/skills/**/SKILL.md`、`.claude/skills/**/SKILL.md`、`.codex/skills/**/SKILL.md` |
| Command | `.claude/commands/**.md`（名 `dir:name`） | —（`~/.codex/prompts` 未做） | `.opencode/commands/**.md`（含旧 `command/`；名带 `/`）、配置文件 `commands.<name>`（template 留在文件字节里） | `.gemini/commands/**.toml`（名 `dir:name`） | —（未查到用户/工作区级命令目录） |
| Agent | `.claude/agents/**.md` | —（`.codex/agents/*.toml` 未做） | `.opencode/agents/**.md`（嵌套计入 id） | `.gemini/agents/*.md` | `.cursor/agents/*.md` |
| Instruction | `CLAUDE.md`、`CLAUDE.local.md`、`AGENTS.md`、`.claude/rules/**.md`（`paths`→applies） | `AGENTS.md`、`AGENTS.override.md` | `AGENTS.md` | `GEMINI.md` | `AGENTS.md`、`.cursor/rules/*.mdc`（`globs`→applies） |
| Hook | `.claude/settings.json`、`.claude/settings.local.json` | `.codex/hooks.json` | —（无独立文件；插件代码注册，不导入） | `.gemini/settings.json` | `.cursor/hooks.json`（被跳过的条目导出时原样保留） |
| MCP server | `.mcp.json` 的 `mcpServers` | `.codex/config.toml` 的 `mcp_servers` | `opencode.json(c)` 的 `mcp.servers`（只认项目根与 `.opencode/`） | `.gemini/settings.json` 的 `mcpServers` | `.cursor/mcp.json` 的 `mcpServers` |

transport 映射：`command`（OpenCode 为 `type: local`）→ `stdio`；Claude `type: http`/`streamable-http`、Codex 只有 url、OpenCode `type: remote`、Gemini `httpUrl` → `streamable-http`；Claude 的 sse/ws、Gemini 的 `url`（SSE）、Cursor 的 `url`（文档写 HTTP 或 SSE，未钉死）→ transport 留空并告警。

### 各家明确不做的

- Codex：`.codex/agents/*.toml`、`~/.codex/prompts`（deprecated 的 custom prompts）。
- OpenCode：hooks（无独立文件，插件代码注册；hub-hook/1 导出报 `NO_HARNESS_PROJECTION`）。兼容目录 `.claude/skills`、`.agents/skills` 会导入（同一目录被多家各自导入是正常的，`sourceHarness` 不同，不去重）。
- Gemini：`settings.json` 的 `context.fileName` 指向的别名 instruction 文件不解析，只认 `GEMINI.md`；一个文件里多个远程代理的 YAML 列表超出 frontmatter 子集。
- Cursor：commands（未查到目录）；agents 的兼容目录 `.claude/agents`、`.codex/agents` 不导入（归各自 harness 的适配器管；skills 的兼容目录会导入，见矩阵）。

## 测试

`npm run test:methods` 覆盖全部五家：往返（清单未改逐字节 / 清单改了体现改动）、缺字段、多个 hook、stdio 与 http 两种 MCP server、frontmatter / JSON / TOML 坏掉、空目录、脱敏（含嵌在长字符串中间的端点与路径、警告 detail 不带值）。合成 fixture 在 `tests/fixtures/harness/`。
