# harness 原语的磁盘格式

适配器把一个 harness 磁盘上的 Skill、Command、Agent、Instruction、Hook、MCP server 收成 hub 资产和中立清单，再按同一份清单写回该 harness 的目录。这份调查只记录 2026-10-13 当天官方文档里写明的文件、字段和导出命令，给导入导出和 `knownCompatible` 当依据。

Permission policy 已在 [权限策略导出](permission-export.md)。这里不重复。

中立字段以 [harness 原语规范](harness-primitives.md) 为准：

| 清单 | 字段 |
|---|---|
| `hub-skill/1` | name、description、version、entry、tools、inputs、outputs、triggers、model、sourceHarness、knownCompatible |
| `hub-command/1` | name、description、arguments |
| `hub-agent/1` | name、description、tools、model、sourceHarness |
| `hub-instruction/1` | scope、applies、fileName |
| `hub-hook/1` | event、order、handler、language、deterministic |
| `hub-provider/1` | transport、provides、reads、writes、credentials、credentialMode |

字节原样冻结。中立清单只填两边都有、含义对得上的项。对不上的写「表达不了」，页面没写的写「未查到」。不补近似字段。

`sourceHarness` 由适配器写成来源 harness 的名字，五个产品的磁盘格式里都没有这个键。`knownCompatible` 同样没有。本调查不给它赋值。能填上若干字段，只说明导入时清单可以写出那些项；往返装载没有在这些页面里被验证，适配器把 `knownCompatible` 留空。

`hub-hook/1` 的 event 只有 `verify.deviceCommand`、`verify.hostCommand`、`verify.workbook`、`beforeDispatch`、`afterResult`。下面各家的事件名都对不上这五个字符串，event 一律表达不了。出参要是 `{decision:"pass"}` 或 `{decision:"block", code, facts}`，各家页面写的是另一套判定，也表达不了。`deterministic: true` 要求处理器不调模型、不连网、不读环境；下面没有一家在 Hook 文件里声明这件事，deterministic 未查到。

`hub-provider/1` 的 transport 只有 `stdio` 和 `streamable-http`。端点、请求头、环境变量和令牌留在 Git 外，不抄进清单，也不写进本文的示例。provides、reads、writes 在下面五家的服务器配置里都没有同名静态字段：能力是连上之后才列出来的。provides 表达不了。reads、writes 未查到。credentials 只记「密钥在库外」。credentialMode 的三个取值（静态密钥、平台签发短期令牌、外部 OAuth）没有同名键，表达不了。

Gemini CLI 各页页首写明：2026-06-18 起，未付费和 Google One 的 Gemini CLI 由 Antigravity CLI 替代。下文只记这些 Gemini CLI 页面仍写着的格式。Antigravity 的格式未查。

路径写成官方文档里的项目相对路径和家目录相对路径。总表在最后。

## Claude Code

### Skill

来源：[Skills](https://code.claude.com/docs/en/skills)。查阅 2026-10-13。

位置，按该页的范围表：企业托管设置目录里的 `.claude/skills/<skill-name>/SKILL.md`；个人 `~/.claude/skills/<skill-name>/SKILL.md`；项目 `.claude/skills/<skill-name>/SKILL.md`；子目录 `<subdir>/.claude/skills/<skill-name>/SKILL.md`；`--add-dir` 所指目录里的 `.claude/skills/`；插件 `<plugin>/skills/<skill-name>/SKILL.md`。个人、项目、企业位置上的技能目录可以是符号链接。文件夹名 `synced` 被保留给从 claude.ai 同步下来的技能。

格式：目录加 `SKILL.md`。文件以 `---` 起头的 YAML frontmatter，后面是 Markdown 正文。开头不是 `---` 时，整份文件当成正文。YAML 解析失败时技能仍加载，字段为空。未识别的字段被忽略。字段名是小写连字符，例外是 `when_to_use`。布尔值接受 `true` / `false`，以及任意大小写的 `yes`、`no`、`on`、`off`、`1`、`0`。

| 字段 | 该页写的含义 |
|---|---|
| `name` | 可选。`/` 菜单里的命令名，默认是目录名 |
| `description` | 建议有。省略时用正文第一行非空文字。和 `when_to_use` 合在一起，技能列表里截到 1536 字符 |
| `when_to_use` | 可选。何时调用的补充说明，接在 description 后面 |
| `argument-hint` | 可选。自动补全时给参数的提示 |
| `arguments` | 可选。供正文 `$name` 替换的具名位置参数，空格分隔的字符串或 YAML 列表 |
| `disable-model-invocation` | 可选，默认 false。为真时不自动加载 |
| `user-invocable` | 可选，默认 true。为 false 时用户不能用 `/name` 调用 |
| `allowed-tools` | 可选。调用该技能的这一轮里，这些工具不再逐次询问。空格或逗号分隔，或 YAML 列表。该页写明这不限制仍可调用哪些工具 |
| `disallowed-tools` | 可选。技能处于活动时从可用池里拿掉的工具 |
| `model` | 可选。技能活动时使用的模型，或 `inherit` |
| `effort` | 可选。`low`、`medium`、`high`、`xhigh`、`max` |
| `context` | 可选。`fork` 表示在分出的子代理里跑 |
| `agent` | 可选。`context: fork` 时用哪种子代理 |
| `background` | 可选。只和 `context: fork` 同用，默认 true |
| `hooks` | 可选。调用技能时注册、会话剩余时间继续有效的钩子 |
| `paths` | 可选。限制自动激活的 glob，逗号分隔字符串或 YAML 列表 |
| `shell` | 可选。`bash`（默认）或 `powershell` |
| `metadata` | 可选。自由 YAML 映射。Claude Code 不解释其内容 |
| `license` | 可选。接受，不据此行动 |
| `compatibility` | 可选。最长 500 字符的字符串。接受，不据此行动 |

同页写明，claude.ai 上传、Skills API，以及 `anthropics/skills` 里的 `package_skill.py`，只接受 `name`、`description`、`license`、`compatibility`、`metadata`、`allowed-tools`。多出来的键会使打包或上传失败。

| 中立字段 | 结果 |
|---|---|
| name | `name`，省略时用目录名 |
| description | `description`，省略时用正文第一行非空文字 |
| model | `model` |
| entry | 未查到同名键。该页要求入口文件是 `SKILL.md`，适配器可以把 entry 写成这个相对路径 |
| version、tools、inputs、outputs、triggers | 未查到。`allowed-tools` 是一轮免询问，`disallowed-tools` 是拿掉工具，都不是「允许调用的工具名」，tools 表达不了 |
| sourceHarness、knownCompatible | 见文首 |

其余 frontmatter 留在冻结字节里。

导出：未查到把已安装技能导出成独立包的 Claude Code 命令。`/run-skill-generator` 会把一次跑通的步骤写成项目技能，那是生成。`package_skill.py` 属于 `anthropics/skills`，不是 Claude Code 的导出命令。

### Command

来源：同一篇 [Skills](https://code.claude.com/docs/en/skills)。查阅 2026-10-13。

该页写明自定义命令已经并入技能。`.claude/commands/deploy.md` 和 `.claude/skills/deploy/SKILL.md` 都得到 `/deploy`。旧的 Markdown 文件继续有效。子目录里的文件把 `/` 换成 `:`，`.claude/commands/frontend/component.md` 得到 `/frontend:component`。frontmatter 与技能相同，没有 `name` 和 `paths`。命令名来自路径，不来自 frontmatter。

| 中立字段 | 结果 |
|---|---|
| name | 文件名，或子目录路径加文件名；`/` 写成 `:` |
| description | frontmatter 的 `description` |
| arguments | `arguments` 是 `$name` 替换用的名字。`argument-hint` 只是补全提示，表达不了成 arguments |

同一文件在 Claude Code 里也是技能。把它登记成 `hub-command/1` 还是 `hub-skill/1`，本调查不规定。导出：未查到。

### Agent

来源：[Subagents](https://code.claude.com/docs/en/sub-agents)。查阅 2026-10-13。

位置：项目 `.claude/agents/`，从当前目录向上扫到仓库根，同名时离工作目录近的赢；个人 `~/.claude/agents/`；托管设置目录里的 `.claude/agents/`；插件自带的代理；`--add-dir` 目录里的 `.claude/agents/`。也可用 `--agents` 传入 JSON，那不是磁盘文件。递归子目录不影响身份，身份只看 frontmatter 的 `name`。文件名不必与 `name` 相同。`/agents` 只提示去编辑这两个目录，或让 Claude 写文件。

格式：Markdown 加 YAML frontmatter，正文是系统提示。只有 `name` 和 `description` 必填。未识别字段被忽略。`name` 最长 256 字符，不能含 `:`。

| 字段 | 该页写的含义 |
|---|---|
| `name` | 必填 |
| `description` | 必填。何时委派 |
| `tools` | 可选。逗号分隔字符串或 YAML 列表。省略则继承子代理可用的全部工具 |
| `disallowedTools` | 可选。从继承或列出的工具里去掉 |
| `model` | 可选。`sonnet`、`opus`、`haiku`、`fable`、完整模型 id，或 `inherit` |
| `permissionMode` | 可选。`default`、`acceptEdits`、`auto`、`dontAsk`、`bypassPermissions`、`plan`，`manual` 是 `default` 的别名。插件子代理忽略 |
| `maxTurns` | 可选 |
| `skills` | 可选。启动时预载进上下文的技能 |
| `mcpServers` | 可选。服务器名，或内联的服务器配置。插件子代理忽略 |
| `hooks` | 可选。只在该子代理运行期间有效。插件子代理忽略 |
| `memory` | 可选。`user`、`project` 或 `local` |
| `background` | 可选 |
| `omitClaudeMd` | 可选 |
| `effort` | 可选。`low`、`medium`、`high`、`xhigh`、`max` |
| `isolation` | 可选。`worktree` |
| `color` | 可选。`red`、`blue`、`green`、`yellow`、`purple`、`orange`、`pink`、`cyan` |
| `initialPrompt` | 可选。作为主会话代理时自动提交的第一轮 |
| `experimental` | 可选。映射。`cacheTtl` 为 `5m` 或 `1h` |

| 中立字段 | 结果 |
|---|---|
| name | `name` |
| description | `description` |
| tools | `tools`。`disallowedTools` 表达不了 |
| model | `model` |
| sourceHarness | 见文首 |

其余字段表达不了。`skills` 是预载的技能名，不是 `hub-agent/1` 的字段。导出：未查到。

### Instruction

来源：[Memory](https://code.claude.com/docs/en/memory)。查阅 2026-10-13。

`CLAUDE.md` 是纯 Markdown，该页没有把它的 frontmatter 当成模式。加载顺序从宽到窄：托管策略（macOS `/Library/Application Support/ClaudeCode/CLAUDE.md`，Linux 与 WSL `/etc/claude-code/CLAUDE.md`，Windows `C:\Program Files\ClaudeCode\CLAUDE.md`），用户 `~/.claude/CLAUDE.md`，项目 `./CLAUDE.md` 或 `./.claude/CLAUDE.md`。`CLAUDE.local.md` 与同目录的 `CLAUDE.md` 一起加载，并应进入 `.gitignore`。工作目录及其上级在启动时拼接，下级目录在 Claude 读、写或编辑那里的文件时再加载。`@path` 可以导入别的文件，相对路径相对于写着 `@` 的那个文件，导入最多四跳。

`.claude/rules/` 下的 `.md` 递归发现，个人规则在 `~/.claude/rules/`。规则 frontmatter 只读 `paths`（YAML 列表或逗号分隔字符串）；其他字段忽略，送进上下文前去掉 frontmatter。没有 `paths` 的规则与 `.claude/CLAUDE.md` 同样在启动时加载。

`AGENTS.md` 在工作目录及其上级没有 `CLAUDE.md`、`.claude/CLAUDE.md`、`CLAUDE.local.md` 时默认读取；用户级和托管的 `CLAUDE.md` 以及 `.claude/rules/` 不阻止它。直接读取需要 Claude Code v2.1.277 或更高。Project instructions 还可设为 `claude-md-or-agents-md`（默认）、`claude-md-and-agents-md`、`claude-md`、`managed-only`。同目录还有 `.claude/AGENTS.md`。

| 中立字段 | 结果 |
|---|---|
| fileName | 该文件的名字：`CLAUDE.md`、`CLAUDE.local.md`、`AGENTS.md`，或规则文件名 |
| applies | 规则的 `paths` 是路径。产品线未查到。`CLAUDE.md` 本身没有路径字段 |
| scope | 该页按托管、用户、项目、子目录区分位置。`hub-instruction/1` 没有列出 scope 的取值，本调查不规定填哪个字符串 |

正文是冻结的 Markdown 字节。`/init` 可以生成一份起始 `CLAUDE.md`；已有文件时只建议修改，不覆盖。`CLAUDE_CODE_NEW_INIT=1` 时，`/init` 在写入前提议 `CLAUDE.md`、技能和钩子。这是生成。导出已有说明文件的命令未查到。`/import` 把别的编程代理的配置带进 Claude Code（v2.1.213 或更高），方向相反。

### Hook

来源：[Hooks](https://code.claude.com/docs/en/hooks)。查阅 2026-10-13。

位置：`~/.claude/settings.json`，项目 `.claude/settings.json`，`.claude/settings.local.json`，托管策略设置，插件 `hooks/hooks.json`，以及技能和子代理 frontmatter 里的 `hooks`。各层合并，不互相替换。

格式：JSON。`hooks` 下先是事件名，再是 matcher 组，组里有 `hooks` 数组。matcher 组上的 `matcher`：`*`、空或省略为全匹配。处理器五种 `type`：`command`、`http`、`mcp_tool`、`prompt`、`agent`。公共字段还有 `if`、`timeout`（秒）、`statusMessage`、`once`。`command` 另有 `command`、`args`、`async`、`asyncRewake`、`shell`（`bash` 或 `powershell`）、`onFailure`。`http` 另有 `url`、`headers`、`allowedEnvVars`、`onFailure`。匹配的钩子并行运行。

该页 matcher 表里出现的事件名：`PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`PermissionRequest`、`PermissionDenied`、`SessionStart`、`Setup`、`SessionEnd`、`Notification`、`SubagentStart`、`PreCompact`、`PostCompact`、`PreModelSwitch`、`PostModelSwitch`、`SubagentStop`、`ConfigChange`、`CwdChanged`、`DirectoryAdded`、`FileChanged`、`StopFailure`、`InstructionsLoaded`、`UserPromptExpansion`、`Elicitation`、`ElicitationResult`、`UserPromptSubmit`、`PostToolBatch`、`Stop`、`TeammateIdle`、`TaskCreated`、`TaskCompleted`、`WorktreeCreate`、`WorktreeRemove`、`MessageDisplay`。

命令钩子的示例用 stdout JSON 的 `permissionDecision: "deny"`，或用退出码表达结果。

| 中立字段 | 结果 |
|---|---|
| event | 表达不了。见文首 |
| order | 表达不了。匹配项并行，没有 order 整数 |
| handler | `type: command` 时，`command` 加可选的 `args` 是入口。`http`、`mcp_tool`、`prompt`、`agent` 表达不了成一个脚本入口 |
| language | `shell` 为 `bash` 或默认 shell 形式时可以标 `shell`。`powershell`、以及另外四种 type，表达不了。没有 `ts` 这个取值 |
| deterministic | 未查到。`prompt` 和 `agent` 会叫模型 |

导出：未查到。

### MCP server

来源：[MCP](https://code.claude.com/docs/en/mcp)。查阅 2026-10-13。

项目范围写在项目根 `.mcp.json` 的 `mcpServers`。用户和本地范围写在 `~/.claude.json`。`claude mcp add`、`claude mcp add-json` 按 `--scope`（`project`、`user`、`local`）写入。没有 `type` 的条目被当成 stdio；带 `url` 又没有 `type` 会报错并跳过。`type` 为 `http` 时，`streamable-http` 是它的别名。另有 `sse`、`ws`。`type: sdk` 被 Claude Code 跳过。stdio 用 `command`、`args`、`env`。`http`、`sse`、`ws` 用 `url`，并接受 `headers`、`headersHelper`、`timeout`、`alwaysLoad`。项目 `.mcp.json` 要在交互会话里批准；写进项目设置并提交的 `enableAllProjectMcpServers` 在工作区未受信任时被忽略。`url` 为空则视为未配置。

| 中立字段 | 结果 |
|---|---|
| transport | 无 `type` 且以 `command` 启动，或按 stdio 添加：`stdio`。`type` 为 `http` 或 `streamable-http`：`streamable-http`。`sse` 和 `ws` 表达不了 |
| provides、reads、writes、credentials、credentialMode | 见文首 |

`claude mcp list` 和 `claude mcp get` 打印连接状态。`claude mcp remove` 删除。未查到把现有服务器导出成可携带包的命令。

## Codex CLI

文档入口是 [llms.txt](https://learn.chatgpt.com/llms.txt)。查阅 2026-10-13。

### Skill

来源：[Build skills](https://learn.chatgpt.com/docs/build-skills)。查阅 2026-10-13。

一个目录：必有 `SKILL.md`，可选 `scripts/`、`references/`、`assets/`、`agents/openai.yaml`。`SKILL.md` 必须有 `name` 和 `description`。该页给出的 frontmatter 只有这两项。可选的 `agents/openai.yaml` 含 `interface`（`display_name`、`short_description`、`icon_small`、`icon_large`、`brand_color`、`default_prompt`）、`policy.allow_implicit_invocation`（默认 true）、`dependencies.tools`（每项有 `type`、`value`、`description`、`transport`、`url`；示例的 type 是 `mcp`）。

发现位置：从当前目录到仓库根的每一层 `.agents/skills`，`$HOME/.agents/skills`，`/etc/codex/skills`，以及随 Codex 附带的系统技能。跟随符号链接。同名不合并。`~/.codex/config.toml` 里 `[[skills.config]]` 的 `path` 加 `enabled = false` 可以停用一份技能而不删除它。

| 中立字段 | 结果 |
|---|---|
| name、description | `SKILL.md` 的同名字段 |
| entry | 未查到同名键。入口文件是 `SKILL.md` |
| version、tools、inputs、outputs、triggers、model | 未查到。`dependencies.tools` 声明的是 MCP 依赖，不是工具名列表，tools 表达不了 |
| sourceHarness、knownCompatible | 见文首 |

`$skill-creator` 创建技能，`$skill-installer` 从仓库安装。插件用于分发。都不是把已安装技能导出的命令。导出未查到。

### Command

来源：[Custom prompts](https://learn.chatgpt.com/docs/custom-prompts)。索引行写着 Deprecated，改用技能。查阅 2026-10-13。

该页仍写明磁盘格式：`~/.codex/prompts/` 下的顶层 Markdown，不扫子目录。frontmatter 有 `description` 和 `argument-hint`。正文里 `$1` 到 `$9`、`$ARGUMENTS`，以及 `KEY=value` 对应的大写占位符。调用形如 `/prompts:<name>`。非 Markdown 被忽略。

| 中立字段 | 结果 |
|---|---|
| name | 文件名 |
| description | `description` |
| arguments | 未查到参数模式字段。`argument-hint` 和 `$1` 占位符表达不了成 arguments |

当前推荐的可复用提示是上一节的技能，不是这个目录。导出未查到。

### Agent

来源：[Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)。查阅 2026-10-13。

个人 `~/.codex/agents/`，项目 `.codex/agents/`。每个 TOML 文件一个代理。必填 `name`、`description`、`developer_instructions`。`name` 是身份，文件名不必相同。文件还可以带其他 `config.toml` 键；该页点名的有 `model`、`model_reasoning_effort`、`sandbox_mode`、`mcp_servers`、`skills.config`。省略的会话设置从父会话继承。内置 `default`、`worker`、`explorer`。全局 `[agents]` 在 `config.toml`：`enabled`（默认 true）、`max_concurrent_threads_per_session`（旧名 `max_threads`）、`default_subagent_model`、`default_subagent_reasoning_effort`、`interrupt_message`（默认 true）。`/agent` 切换线程，不是导出。

| 中立字段 | 结果 |
|---|---|
| name、description | 同名字段 |
| model | `model` |
| tools | 未查到工具白名单。`sandbox_mode` 和 `mcp_servers` 表达不了成 tools |
| sourceHarness | 见文首 |

`developer_instructions` 是行为正文，`hub-agent/1` 没有对应字段，留在冻结字节里。导出未查到。

### Instruction

来源：[AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)。查阅 2026-10-13。

纯 Markdown，未查到 frontmatter 模式。全局：Codex 家目录（默认 `~/.codex`，可用 `CODEX_HOME` 改）里先读 `AGENTS.override.md`，否则读 `AGENTS.md`，只用第一个非空文件。项目：从项目根走到当前目录，每层先 `AGENTS.override.md`，再 `AGENTS.md`，再 `project_doc_fallback_filenames` 里的名字，每层至多一个文件。自根向下拼接，近的在后。空文件跳过。合计大小到 `project_doc_max_bytes` 停止，默认 32 KiB。该页示例把 fallback 设为 `TEAM_GUIDE.md` 和 `.agents.md`，并把上限设为 65536。

| 中立字段 | 结果 |
|---|---|
| fileName | 实际读到的文件名 |
| applies | 未查到路径或产品线字段。目录位置本身不是 applies |
| scope | 该页区分全局和项目。取值表未查到，本调查不规定字符串 |

导出未查到。

### Hook

来源：[Hooks](https://learn.chatgpt.com/docs/hooks)。查阅 2026-10-13。

`hooks.json`，或 `config.toml` 里的 `[hooks]`。常见位置：`~/.codex/hooks.json`、`~/.codex/config.toml`、仓库 `.codex/hooks.json`、仓库 `.codex/config.toml`。多个来源的匹配钩子都运行；高优先级层不替换低优先级层。同一层两份都有时，Codex 合并并在启动时警告。插件可以带 `hooks/hooks.json`。项目钩子只在 `.codex/` 层受信任时加载。`/hooks` 用来查看、信任或停用，不是导出。

一轮之中：`PreToolUse`、`PermissionRequest`、`PostToolUse`、`PreCompact`、`PostCompact`、`UserPromptSubmit`、`SubagentStop`、`Stop`。打断时 `Interrupt`。会话或子代理开始：`SessionStart`、`SubagentStart`。主线程结束：`SessionEnd`。

形状是事件、matcher 组、处理器。`command` 和 `mcp_tool` 会执行；`prompt` 和 `agent` 被解析后跳过。文件级可选 `description`。处理器字段见该页配置段：`type`、`command`、`timeout`（秒）、`statusMessage`、`additionalContextLimit`、`async`，以及 Windows 的 `commandWindows`（TOML 里也可写 `command_windows`）。同一事件的多个 command 钩子并发启动。可以返回 `permissionDecision`（`deny` 或带 `updatedInput` 的 `allow`）；旧形状是 `decision: "block"`。退出码 2 并把理由写到 stderr 也会阻止。

| 中立字段 | 结果 |
|---|---|
| event、order、deterministic | event 与 deterministic 见文首。order 表达不了：command 钩子并发，没有 order 整数 |
| handler | `type: command` 的 `command`。`mcp_tool` 表达不了成脚本入口 |
| language | 未查到 `ts` / `shell` 字段。命令字符串可以叫起 Python，不能据此填写 language |

导出未查到。[Import](https://learn.chatgpt.com/docs/import) 把别的代理的设置、技能、钩子和子代理带进 ChatGPT 或 Codex，方向相反。

### MCP server

来源：[MCP](https://learn.chatgpt.com/docs/extend/mcp)。查阅 2026-10-13。

`~/.codex/config.toml` 或项目 `.codex/config.toml` 的 `[mcp_servers.<server-name>]`。`codex mcp add` 写入。stdio：`command` 必填，可选 `args`、`env`、`env_vars`、`cwd`、`experimental_environment`。该页把另一类标成 Streamable HTTP：`url` 必填，可选 `auth`（`oauth` 或 `chatgpt`）、`bearer_token_env_var`、`http_headers`、`env_http_headers`、`http_headers_helper`。两类都可有 `startup_timeout_sec`、`tool_timeout_sec`、`enabled`、`required`、`enabled_tools`、`disabled_tools`、`default_tools_approval_mode`、`tools.<tool>.approval_mode`、`tools.<tool>.output_token_limit`。`writes` 的含义见权限策略导出，这里不重复。

| 中立字段 | 结果 |
|---|---|
| transport | 有 `command` 的 stdio 条目：`stdio`。该页称为 Streamable HTTP、且以 `url` 配置的条目：`streamable-http` |
| provides | 表达不了。`enabled_tools` 和 `disabled_tools` 是连接之后的允许与拒绝，不是 provides 的 tools / resources / prompts |
| reads、writes、credentials、credentialMode | 见文首 |

导出未查到。`codex mcp login` 是登录。

## OpenCode

v2 文档索引是 [llms.txt](https://opencode.ai/v2/llms.txt)。配置文件位置来自 [Config](https://opencode.ai/v2/docs/config/)。查阅 2026-10-13。系统目录：macOS `/Library/Application Support/opencode`，Linux `/etc/opencode`，Windows `%ProgramData%\opencode`。全局 `~/.config/opencode/opencode.json(c)`。项目根 `opencode.json(c)` 或 `.opencode/opencode.json(c)`。`opencode.json(c)` 表示 `opencode.json` 或 `opencode.jsonc`。

### Skill

来源：[Skills](https://opencode.ai/v2/docs/skills/)。查阅 2026-10-13。

项目 `.opencode/skills`，从当前目录向上到项目根。全局 `~/.config/opencode/skills`。兼容位置：全局 `~/.claude/skills`、`~/.agents/skills`，项目 `.claude/skills`、`.agents/skills`。系统目录也会装入 `skills/`。`skills` 数组可以再加相对路径、`~/` 路径、绝对路径，或 http(s) 目录。

两种文件：来源根上的 `review.md`，或任意深度的 `SKILL.md`。id 由路径决定：`git-release/SKILL.md` 的 id 是 `git-release`；`teams/release/SKILL.md` 的 id 是最后一段 `release`。frontmatter 的 `name` 只是显示名。HTTP 目录的 `index.json` 每项有 `name`、`version`、`files`。

frontmatter 在运行时都可选：

| 字段 | 该页写的含义 |
|---|---|
| `name` | 显示名，默认是路径 id |
| `description` | 给模型看的摘要。没有它就不会被广告 |
| `metadata.opencode/autoinvoke` | false 时不放进模型的可用列表，仍可按 id 显式加载 |
| `disable-model-invocation` | true 时与上一行相同。两者都写时 `opencode/autoinvoke` 赢 |
| `license`、`compatibility` | 接受，不解释 |

| 中立字段 | 结果 |
|---|---|
| name | 路径 id。显示名 `name` 与 id 可以不同，中立 name 取 id |
| description | `description` |
| entry | 该文件的相对路径：`SKILL.md` 或根上的 `<id>.md` |
| version | `SKILL.md` 上未查到。HTTP 目录条目的 `version` 是缓存版本，表达不了成技能版本 |
| tools、inputs、outputs、triggers、model | 未查到 |
| sourceHarness、knownCompatible | 见文首 |

导出未查到。

### Command

来源：[Commands](https://opencode.ai/v2/docs/commands/)。查阅 2026-10-13。

`~/.config/opencode/commands/` 与 `.opencode/commands/`，只发现 `.md`。嵌套路径用 `/` 连接，`team/review.md` 成为 `/team/review`。旧的单数目录 `command/` 仍会被发现。系统目录也装入 `commands/`。JSON 写在任一配置文件的 `commands.<name>`，必须有 `template`。Markdown 的正文就是模板，frontmatter 里不要写 `template`。

| 字段 | 该页写的含义 |
|---|---|
| `template` | 仅 JSON。提示模板 |
| `description` | 可选 |
| `agent` | 可选。运行时选用的代理 |
| `model` | 可选。`provider/model` 或 `provider/model#variant` |
| `subagent` | 可选。true 时在后台子会话运行 |
| `subtask` | `subagent` 的弃用别名。两者都在时 `subagent` 赢 |

`$ARGUMENTS` 是整段参数。`$1`、`$2` 起是位置参数。没有这些占位符时，非空参数接在模板后面。

| 中立字段 | 结果 |
|---|---|
| name | 路径，嵌套用 `/` |
| description | `description` |
| arguments | 未查到参数模式。`$ARGUMENTS` 和 `$1` 表达不了成 arguments |

`agent`、`model`、`subagent` 表达不了。导出未查到。

### Agent

来源：[Agents](https://opencode.ai/v2/docs/agents/)。查阅 2026-10-13。

`~/.config/opencode/agents/<name>.md`，`.opencode/agents/<name>.md`。嵌套路径算进 id，`team/reviewer.md` 的 id 是 `team/reviewer`。系统目录也装入 `agents/`。Markdown 正文是系统提示，不要在 frontmatter 里写 `system`。JSON 写在 `agents`。

| 字段 | 该页写的含义 |
|---|---|
| `description` | 用途说明 |
| `mode` | `primary`、`subagent` 或 `all`。新代理省略时默认 `primary` |
| `model` | 字符串 `provider/model`，可加 `#variant`。JSON 也可写成 `providerID`、`model`、`variant` |
| `system` | 仅 JSON |
| `permissions` | 有序规则：`action`、`resource`、`effect`（`allow`、`ask`、`deny`）。后匹配的赢 |
| `steps` | 正整数，模型步数上限 |
| `hidden` | 不出现在普通列表 |
| `color` | 界面颜色 |
| `disabled` | 在该层配置里去掉这个代理 |
| `request` | 请求头和 JSON 体。该页写明会话运行器尚未把它们发出去 |
| `default_agent` | 配置顶层，不是单个代理的字段 |

该页点名的 action 有 `shell`、`edit`、`subagent`、`read`、`glob`、`grep`、`webfetch`、`websearch`、`skill`。并写明新配置不要再用顶层的 `temperature`、`top_p`、`prompt`、`permission`、`tools`、`disable`、`maxSteps`。可见内置代理是 `build`、`plan`、`general`、`explore`。

| 中立字段 | 结果 |
|---|---|
| name | 文件路径得出的 id |
| description | `description` |
| model | `model` |
| tools | 表达不了。当前字段是 `permissions`，不是工具白名单。遗留的 `tools` 被该页明确排除 |
| sourceHarness | 见文首 |

导出未查到。

### Instruction

来源：[Instructions](https://opencode.ai/v2/docs/instructions/)。查阅 2026-10-13。

只认 `AGENTS.md`。v2 不把 `CLAUDE.md` 当后备。全局 `~/.config/opencode/AGENTS.md`，再加上从当前工作区向家目录走时遇到的每一份 `AGENTS.md`；工作区不在家目录下时停在项目根。文件合并，不解决冲突。工作区以下的 `AGENTS.md` 在读到那一带时再加载，近的先加载。纯 Markdown。`instructions` 数组仍被模式接受，v2 目前不解析其中的文件、glob 或 URL。`OPENCODE_DISABLE_PROJECT_CONFIG=1` 跳过项目 `AGENTS.md`，不停全局文件。

| 中立字段 | 结果 |
|---|---|
| fileName | `AGENTS.md` |
| applies | 未查到路径模式或产品线 |
| scope | 该页区分全局与项目目录。取值表未查到 |

导出未查到。

### Hook

[Hooks](https://opencode.ai/v2/docs/hooks/) 在 2026-10-13 返回 404。v2 索引没有 Hooks 页。

[Plugins](https://opencode.ai/v2/docs/plugins/) 把钩子放进插件。磁盘上是插件代码，不是一份钩子清单。发现位置：每个 `.opencode/plugins/` 里直接的 `.ts`、`.js` 和紧邻的插件包目录；`~/.config/opencode/plugins/`；配置里的 `plugins` 数组。`opencode plugin add`、`list`、`check`、`update`、`remove` 管理全局包插件。

钩子的注册方式来自 [Build plugins](https://opencode.ai/v2/docs/build/plugins/)。查阅 2026-10-13。插件在 `setup` 里调用 `ctx.<域>.hook(名字, 回调)`。同一钩子按插件注册顺序执行，后注册的看得到先注册的改动。该页写出的名字：

| 域 | 名字 |
|---|---|
| session | `prompt`、`context`、`compaction`、`generate`、`title`、`model.request`、`http.request`、`http.response`、`experimental.ws.handshake`、`experimental.ws.send`、`experimental.ws.receive`、`retry` |
| permission | `evaluate` |
| shell | `create.before` |
| tool | `execute.before`、`execute.after` |

`prompt` 钩子没有类型化的拒绝接口。`permission` 的 `evaluate` 可以改 `effect`。该页的一个 `evaluate` 示例会再调模型。

| 中立字段 | 结果 |
|---|---|
| event、order、handler、language、deterministic | 全部表达不了或未查到。没有与 `hub-hook/1` 同名的键；注册顺序不是 order 整数；回调写在插件源码里，不是 handler 路径；language 未查到；示例可以调模型，deterministic 不能写成 true |

导出未查到。

### MCP server

来源：[MCP servers](https://opencode.ai/v2/docs/mcp-servers/)。查阅 2026-10-13。

键是 `mcp.servers.<name>`。服务器名不直接放在 `mcp` 下。`opencode mcp add <name> --url …` 写入项目配置；`--global` 则所有项目可用。同名时，更高优先级的项目配置整段替换该服务器对象。

本地：`type` 必填且为 `local`，`command` 必填，是可执行文件及其参数组成的字符串数组。可选 `cwd`、`environment`、`disabled`（默认 false）、`codemode`（默认 true）、`timeout`、`protocol`（`legacy`、`auto` 或 `2026-07-28`）。环境值用 `{env:NAME}`，不用 `$NAME`。

远程：`type` 必填且为 `remote`，`url` 必填，该页称为绝对的 Streamable HTTP 端点。可选 `headers`、`oauth`（或 false）、以及与本地相同的 `disabled`、`codemode`、`timeout`、`protocol`。未写 `oauth: false` 时 OAuth 打开，凭据留在项目配置之外。`/mcps` 或 `opencode mcp auth` 登录。`opencode mcp list` 看状态。删除是从配置里去掉该条。

| 中立字段 | 结果 |
|---|---|
| transport | `type: local` 为 `stdio`。`type: remote` 为 `streamable-http` |
| provides | 表达不了。`codemode: false` 只决定工具直接暴露还是经 Code Mode，不是 provides 清单 |
| reads、writes、credentials、credentialMode | 见文首 |

导出未查到。`opencode mcp add` 是写入。

## Gemini CLI

各页页首有 Antigravity 替代说明，见文首。查阅 2026-10-13。

### Skill

来源：[Agent Skills](https://geminicli.com/docs/cli/skills)、[Creating Agent Skills](https://geminicli.com/docs/cli/creating-skills)。查阅 2026-10-13。

发现层从低到高：内置、扩展、用户 `~/.gemini/skills/` 或别名 `~/.agents/skills/`、工作区 `.gemini/skills/` 或别名 `.agents/skills/`。同名时高层赢。同一层里别名优先于 `.gemini` 目录。目录加 `SKILL.md`，可选 `scripts/`、`references/`、`assets/`。该页写明的 frontmatter 是 `name`（应与目录名一致）和 `description`（Gemini 据此决定是否使用）。两页都没有给出更大的字段表。

`gemini skills list`、`install`、`uninstall`、`link`，`--scope` 为 `user`（默认）或 `workspace`。会话内有 `/skills list`、`link`、`disable`、`enable`、`reload`。创建页还写了核心包里的 `node scripts/init_skill.cjs`、`validate_skill.cjs`，以及 `package_skill.cjs` 会打出 `.skill` 压缩包。

| 中立字段 | 结果 |
|---|---|
| name、description | 同名字段 |
| entry | 入口文件是 `SKILL.md` |
| version、tools、inputs、outputs、triggers、model | 未查到 |
| sourceHarness、knownCompatible | 见文首 |

`gemini skills install` 是装进 Gemini。`package_skill.cjs` 是核心包里的打包脚本，不是已安装配置的导出命令。导出命令未查到。

### Command

来源：[Custom commands](https://geminicli.com/docs/cli/custom-commands)。查阅 2026-10-13。

用户 `~/.gemini/commands/`，项目 `<项目根>/.gemini/commands/`。同名时项目覆盖用户。TOML，扩展名 `.toml`。名字来自相对路径，子目录分隔符换成 `:`：`test.toml` 为 `/test`，`git/commit.toml` 为 `/git:commit`。

必填 `prompt`。可选 `description`；省略时从文件名生成一句说明。参数用正文里的 `{{args}}`。没有这个占位符时，用户输入的整段命令接在 prompt 后面，中间空一行。`!{...}` 插入命令输出，`@{path}` 插入文件内容。该页的字段表只列了 `prompt` 和 `description`。

| 中立字段 | 结果 |
|---|---|
| name | 路径，`:` 分隔 |
| description | `description` |
| arguments | 未查到参数模式。`{{args}}` 表达不了成 arguments |

`/commands reload` 与 `/commands list` 重新扫描和列出。导出未查到。

### Agent

来源：[Subagents](https://geminicli.com/docs/core/subagents/)、[Remote subagents](https://geminicli.com/docs/core/remote-agents/)。`/docs/cli/subagents` 与 `/docs/cli/agents` 在当天返回 404。查阅 2026-10-13。

本地和远程都是 `.gemini/agents/*.md` 或 `~/.gemini/agents/*.md`，YAML frontmatter。本地文件必须以 `---` 开始，正文是系统提示。

本地字段：

| 字段 | 必填 | 该页写的含义 |
|---|---|---|
| `name` | 是 | 小写字母、数字、连字符、下划线 |
| `description` | 是 | 主代理据此决定是否调用 |
| `kind` | 否 | `local`（默认）或 `remote` |
| `tools` | 否 | 工具名列表。可用 `*`、`mcp_*`、`mcp_server_*`。省略则继承父会话的全部工具 |
| `mcpServers` | 否 | 只给这个代理用的内联 MCP 配置 |
| `model` | 否 | 省略则 `inherit` |
| `temperature` | 否 | 默认 1 |
| `max_turns` | 否 | 默认 30 |
| `timeout_mins` | 否 | 默认 10 |

远程文件的 `kind` 必须是 `remote`。必填 `name`，以及 `agent_card_url` 或 `agent_card_json` 之一。可选 `auth`。`auth.type` 该页列出 `apiKey`、`http`、`google-credentials`、`oauth`。一个文件里的 YAML 列表可以有多个远程代理；本地与远程混在同一文件，或一个文件里多个本地代理，该页写明不支持。`settings.json` 里 `experimental.enableAgents: false` 关掉子代理。`agents.overrides` 可按代理覆盖 `modelConfig`。

| 中立字段 | 结果 |
|---|---|
| name | `name` |
| description | 本地的 `description`。远程模式表里未查到 description |
| tools | 本地的 `tools`。通配符原样留下，不展开。远程未查到 tools |
| model | 本地的 `model`。远程未查到 |
| sourceHarness | 见文首 |

`kind`、`temperature`、`max_turns`、`timeout_mins`、`mcpServers`、`auth`、代理卡片表达不了。导出未查到。

### Instruction

来源：[GEMINI.md](https://geminicli.com/docs/cli/gemini-md)。查阅 2026-10-13。

默认文件名 `GEMINI.md`，纯 Markdown，未查到 frontmatter 模式。全局 `~/.gemini/GEMINI.md`。项目：在配置的工作区目录及其父目录里找。工具访问某个目录时，再从该目录向受信任根扫描。多份文件拼接。`@file.md` 导入，相对或绝对路径。`settings.json` 的 `context.fileName` 可以是另一个名字或名字列表，该页示例是 `AGENTS.md`、`CONTEXT.md`、`GEMINI.md`。`/memory show` 显示拼好的正文，`/memory reload` 重新扫描。

| 中立字段 | 结果 |
|---|---|
| fileName | 默认 `GEMINI.md`，或 `context.fileName` 里的名字 |
| applies | 未查到 |
| scope | 该页区分全局、工作区、即时目录。取值表未查到 |

导出未查到。`/memory show` 是显示，不是写出一份可携带文件。

### Hook

来源：[Hooks](https://geminicli.com/docs/hooks)、[Hooks reference](https://geminicli.com/docs/hooks/reference)。查阅 2026-10-13。

`settings.json` 的 `hooks`。合并顺序从高到低：项目 `.gemini/settings.json`，用户 `~/.gemini/settings.json`，系统 `/etc/gemini-cli/settings.json`，然后是扩展。

事件：`SessionStart`、`SessionEnd`、`BeforeAgent`、`AfterAgent`、`BeforeModel`、`AfterModel`、`BeforeToolSelection`、`BeforeTool`、`AfterTool`、`PreCompress`、`Notification`。

每个事件是定义数组。定义上有可选 `matcher`、可选 `sequential`、必填 `hooks`。`sequential` 为 true 时组内按数组先后执行，为 false 时并行。处理器目前只有 `type: command`，必填 `command`，可选 `name`、`timeout`（毫秒，默认 60000）、`description`。stdout 只能是 JSON。退出码 0 解析 JSON；2 为系统阻止；其他码警告后继续。参考页的公共出参有 `systemMessage`、`suppressOutput`、`continue`、`stopReason`、`decision`（`allow` 或 `deny`，别名 `block`）、`reason`。

| 中立字段 | 结果 |
|---|---|
| event、deterministic | 见文首 |
| order | 表达不了。`sequential` 是布尔，不是 order 整数 |
| handler | `command` |
| language | 该页把 `command` 写成要执行的 shell 命令，可以标 `shell`。没有 `ts` |

`/hooks` 可以查看、整批开关或按 `name` 开关。导出未查到。

### MCP server

来源：[MCP server](https://geminicli.com/docs/tools/mcp-server)。查阅 2026-10-13。

`settings.json` 的 `mcpServers`。`gemini mcp add` 按 `--scope` 写入 `~/.gemini/settings.json`（`user`）或 `.gemini/settings.json`（`project`，默认）。另有顶层 `mcp.serverCommand`。每台服务器必填三者之一：`command`（stdio）、`url`（SSE）、`httpUrl`（该页称为 HTTP streaming endpoint）。可选 `args`、`headers`、`env`、`cwd`、`timeout`（默认 600000 毫秒）、`trust`、`includeTools`、`excludeTools`（排除优先）、`targetAudience`、`targetServiceAccount`、`authProviderType`（`dynamic_discovery`、`google_credentials`、`service_account_impersonation`）。`gemini mcp list` 与 `gemini mcp remove` 列出和删除。`--transport` 接受 `stdio`、`sse`、`http`。

| 中立字段 | 结果 |
|---|---|
| transport | `command` 为 `stdio`。`httpUrl` 对应该页的 HTTP streaming，记为 `streamable-http`。只有 `url` 的 SSE 表达不了 |
| provides | 表达不了。`includeTools` 与 `excludeTools` 是工具名过滤，不是 provides |
| reads、writes、credentials、credentialMode | 见文首 |

导出未查到。

## Cursor

### Skill

来源：[Agent Skills](https://cursor.com/docs/skills)。查阅 2026-10-13。

项目 `.agents/skills/`、`.cursor/skills/`。用户 `~/.agents/skills/`、`~/.cursor/skills/`。兼容 `.claude/skills/`、`.codex/skills/`、`~/.claude/skills/`、`~/.codex/skills/`。递归找 `SKILL.md`。含 `SKILL.md` 的那一层目录是身份，再上一层分类目录不算。嵌套项目里的技能自动限于该目录。可选 `scripts/`、`references/`、`assets/`。

| 字段 | 必填 | 该页写的含义 |
|---|---|---|
| `name` | 是 | 小写字母、数字、连字符，必须与父目录名一致 |
| `description` | 是 | 做什么、何时用 |
| `paths` | 否 | glob，逗号分隔字符串或列表。遗留的 `globs` 仍接受 |
| `disable-model-invocation` | 否 | true 时只能用 `/skill-name` 显式调用 |
| `icon` | 否 | 作为 Custom Mode 时徽章上的图标 |
| `color` | 否 | 徽章颜色：`default`、`green`、`cyan`、`blue`、`purple`、`magenta`、`orange`、`yellow`、`red`、`brand` |
| `metadata` | 否 | 任意键值 |

| 中立字段 | 结果 |
|---|---|
| name、description | 同名字段 |
| entry | `SKILL.md` |
| version、tools、inputs、outputs、triggers、model | 未查到。`paths` 是文件范围，triggers 的形状在中立清单里没有展开，表达不了 |
| sourceHarness、knownCompatible | 见文首 |

`/create-skill` 创建。`/migrate-to-skills`（2.4）把动态规则和用户级、工作区级斜杠命令收成 `.cursor/skills/` 下的技能；命令转成的技能带 `disable-model-invocation: true`。Settings → Agents 里的 Sync Skills for Cloud Agents 只复制 `~/.cursor/skills/`。团队分享是发布到团队市场。都不是把技能导出成 hub 能读的包。导出未查到。

### Command

当天未查到用户级或工作区级斜杠命令自己的目录。技能页写明这两级命令存在，并会被 `/migrate-to-skills` 转成技能，但没有写出源目录。

[Plugins](https://cursor.com/docs/reference/plugins) 里，插件的 `commands/` 发现 `.md`、`.mdc`、`.markdown`、`.txt`。frontmatter 有 `name` 和 `description`。这是插件包里的路径，不是一份独立的用户命令目录。

| 中立字段 | 结果 |
|---|---|
| name、description | 只在插件命令的 frontmatter 里查到同名字段 |
| arguments | 未查到 |

导出未查到。

### Agent

来源：[Subagents](https://cursor.com/docs/subagents)。查阅 2026-10-13。

项目 `.cursor/agents/`、`.claude/agents/`、`.codex/agents/`。用户 `~/.cursor/agents/`、`~/.claude/agents/`、`~/.codex/agents/`。项目优先于用户。同名时 `.cursor/` 优先于 `.claude/` 或 `.codex/`。Markdown 加 YAML，正文是提示。

| 字段 | 必填 | 默认 | 该页写的含义 |
|---|---|---|---|
| `name` | 否 | 来自文件名 | 小写字母和连字符 |
| `description` | 否 | 无 | 委派时给主代理看 |
| `model` | 否 | `inherit` | `inherit` 或模型 id。id 后可加 `[effort=high]` 这类选项 |
| `readonly` | 否 | false | true 时不能改文件，也不能跑改变状态的 shell |
| `is_background` | 否 | false | true 时后台运行 |

| 中立字段 | 结果 |
|---|---|
| name | `name`，省略时用文件名 |
| description | `description` |
| model | `model` |
| tools | 未查到。`readonly` 表达不了成工具白名单 |
| sourceHarness | 见文首 |

`/create-subagent` 创建。导出未查到。

### Instruction

来源：[Rules](https://cursor.com/docs/rules)。查阅 2026-10-13。

项目规则：`.cursor/rules` 下的 `.mdc`。同目录的普通 `.md` 被忽略。frontmatter 为 `description`、`globs`、`alwaysApply`。`alwaysApply: true` 时忽略 globs 和 description。`alwaysApply: false` 且有 globs 时按文件匹配。有 description、没有 globs 时由代理决定。两者都没有时，只在聊天里 `@` 提到才纳入。多个 glob 用逗号分隔。`/create-rule` 写到 `.cursor/rules`。

`AGENTS.md` 放在项目根或子目录，纯 Markdown，没有元数据。子目录的文件与上级合并，更近的优先。

用户规则在 Customize → Rules，技能页写明它们不在文件系统上。团队规则在控制台，正文是自由文本，可以有 glob；该页未给出文件路径。优先级是团队、项目、用户，冲突时先出现的优先。

| 中立字段 | 结果 |
|---|---|
| fileName | `.mdc` 的文件名，或 `AGENTS.md` |
| applies | `.mdc` 的 `globs`，以及团队规则上的 glob，是路径。产品线未查到。`AGENTS.md` 没有路径字段 |
| scope | 该页区分项目、用户、团队。取值表未查到。用户规则没有文件 |

导出未查到。从 GitHub 仓库引进规则要先打成带 `.cursor-plugin/marketplace.json` 的插件，方向相反。

### Hook

来源：[Hooks](https://cursor.com/docs/hooks)。查阅 2026-10-13。

项目 `<项目根>/.cursor/hooks.json`，用户 `~/.cursor/hooks.json`。企业：macOS `/Library/Application Support/Cursor/hooks.json`，Linux 与 WSL `/etc/cursor/hooks.json`，Windows `C:\ProgramData\Cursor\hooks.json`。另有团队下发的钩子。优先级从高到低：企业、团队、项目、用户。各来源的匹配钩子都跑；合并时 deny 胜过 ask，ask 胜过 allow。

JSON。`version` 必填，正整数，该页让使用 `1`。`hooks` 把事件名映射到定义数组。定义字段：`command` 必填；`type` 为 `command`（默认）或 `prompt`；`timeout` 秒；`loop_limit`；`failClosed`；`matcher`。`prompt` 类型另有 `prompt` 文本。

代理事件：`sessionStart`、`sessionEnd`、`preToolUse`、`postToolUse`、`postToolUseFailure`、`subagentStart`、`subagentStop`、`beforeShellExecution`、`afterShellExecution`、`beforeMCPExecution`、`afterMCPExecution`、`beforeReadFile`、`afterFileEdit`、`beforeSubmitPrompt`、`preCompact`、`stop`、`afterAgentResponse`、`afterAgentThought`。Tab：`beforeTabFileRead`、`afterTabFileEdit`。应用：`workspaceOpen`。

命令钩子经 stdio 收发 JSON。示例出参使用 `permission`：`allow`、`deny` 或 `ask`。云端代理只跑仓库里的 command 钩子。

| 中立字段 | 结果 |
|---|---|
| event、deterministic | 见文首 |
| order | 未查到 order 字段 |
| handler | `type` 省略或为 `command` 时的 `command`。`prompt` 表达不了 |
| language | 未查到。`command` 可以是 shell 字符串，也可以是 `bun run` 一个 `.ts`，不能据此写成 `ts` 或 `shell` |

`/create-hook` 写 `hooks.json`。导出未查到。第三方钩子在 [Third-party hooks](https://cursor.com/docs/reference/third-party-hooks)，那是分发来的钩子，不是导出命令。

### MCP server

来源：[MCP](https://cursor.com/docs/mcp)。查阅 2026-10-13。

项目 `.cursor/mcp.json`，全局 `~/.cursor/mcp.json`。根键 `mcpServers`。stdio 字段表：`type` 必填且为 `stdio`，`command` 必填，可选 `args`、`env`、`envFile`。同页示例在本地条目里只写 `command`、`args`、`env`，没有 `type`。远程示例写 `url` 和 `headers`，旁注是 HTTP or SSE；另有 `auth`（`CLIENT_ID`、`CLIENT_SECRET`、`scopes`）。`command`、`args`、`env`、`url`、`headers` 里可做变量替换。插件市场里的 mcp 清单还可带 `type: stdio`。

| 中立字段 | 结果 |
|---|---|
| transport | `type: stdio`，或示例中只有 `command` 的本地条目：`stdio`。只有 `url` 的条目该页同时写成 HTTP 与 SSE，transport 留空 |
| provides、reads、writes、credentials、credentialMode | 见文首 |

Customize 里安装，或写 `mcp.json`。未查到导出命令。

## 路径总表

格子里是该原语的主要文件。兼容目录、系统目录和插件包见上面各节。未查到文件的写「未查到」。

| 原语 | Claude Code | Codex CLI | OpenCode | Gemini CLI | Cursor |
|---|---|---|---|---|---|
| Skill | `.claude/skills/<name>/SKILL.md`；`~/.claude/skills/<name>/SKILL.md` | `.agents/skills/<name>/SKILL.md`；`~/.agents/skills/<name>/SKILL.md` | `.opencode/skills/<id>/SKILL.md`；`~/.config/opencode/skills/` | `.gemini/skills/<name>/SKILL.md`；`~/.gemini/skills/` | `.cursor/skills/<name>/SKILL.md`；`.agents/skills/<name>/SKILL.md`；`~/.cursor/skills/` |
| Command | `.claude/commands/<name>.md` | `~/.codex/prompts/<name>.md` | `.opencode/commands/<name>.md`；`~/.config/opencode/commands/` | `.gemini/commands/<name>.toml`；`~/.gemini/commands/` | 未查到 |
| Agent | `.claude/agents/<name>.md`；`~/.claude/agents/` | `.codex/agents/<file>.toml`；`~/.codex/agents/` | `.opencode/agents/<name>.md`；`~/.config/opencode/agents/` | `.gemini/agents/<name>.md`；`~/.gemini/agents/` | `.cursor/agents/<name>.md`；`~/.cursor/agents/` |
| Instruction | `CLAUDE.md`；`.claude/CLAUDE.md`；`.claude/rules/*.md`；`AGENTS.md` | `AGENTS.md`；`AGENTS.override.md`；`~/.codex/AGENTS.md` | `AGENTS.md`；`~/.config/opencode/AGENTS.md` | `GEMINI.md`；`~/.gemini/GEMINI.md` | `.cursor/rules/*.mdc`；`AGENTS.md` |
| Hook | `.claude/settings.json`；`~/.claude/settings.json` | `~/.codex/hooks.json`；`.codex/hooks.json`；同层 `config.toml` 的 `[hooks]` | 未查到独立文件。插件代码在 `.opencode/plugins/`、`~/.config/opencode/plugins/` | `.gemini/settings.json`；`~/.gemini/settings.json` | `.cursor/hooks.json`；`~/.cursor/hooks.json` |
| MCP server | `.mcp.json`；`~/.claude.json` | `~/.codex/config.toml`；`.codex/config.toml` | `opencode.json(c)` 的 `mcp.servers` | `.gemini/settings.json`；`~/.gemini/settings.json` | `.cursor/mcp.json`；`~/.cursor/mcp.json` |

---

本文是 circle-hub 的设计规范之一，按 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.zh-hans) 授权：引用、借鉴须署名 Circle Hub 与 qingshanfeihu 并注明原始出处链接。见[设计规范索引](README.md#许可)。
