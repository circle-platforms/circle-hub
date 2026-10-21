# On-disk formats of harness primitives

> **Historical survey** (marked 2026-10-21): this is the 2026-10-13 format survey for the removed harness adapter library, and the harnesses' formats may have changed since; the Hub is now a standard MCP server and no longer imports or exports harness primitives. Kept as a record only.

An adapter turns the Skill, Command, Agent, Instruction, Hook, and MCP server files of one harness into a hub Asset plus a neutral manifest, then writes that manifest back into that harness's directories. This survey records only the files, fields, and export commands stated in the official docs on 2026-10-13. It is the basis for import, export, and `knownCompatible`.

Permission policy is already specified in [Permission policy export](permission-export.md). It is not repeated here.

Neutral fields follow [Harness primitives](harness-primitives.md):

| Manifest | Fields |
|---|---|
| `hub-skill/1` | name, description, version, entry, tools, inputs, outputs, triggers, model, sourceHarness, knownCompatible |
| `hub-command/1` | name, description, arguments |
| `hub-agent/1` | name, description, tools, model, sourceHarness |
| `hub-instruction/1` | scope, applies, fileName |
| `hub-hook/1` | event, order, handler, language, deterministic |
| `hub-provider/1` | transport, provides, reads, writes, credentials, credentialMode |

Bytes stay frozen as they are. The neutral manifest receives an item only when both sides have it and the meanings match. A mismatch is "Cannot be expressed". A gap in the page is "Not found". No nearby field is added as a substitute.

`sourceHarness` is written by the adapter as the name of the source harness. None of the five on-disk formats has this key. `knownCompatible` is absent in the same way. This survey does not assign it. Filling several fields only means an import can write those items. A round trip is not verified on these pages, so the adapter leaves `knownCompatible` empty.

`hub-hook/1` event is only `verify.deviceCommand`, `verify.hostCommand`, `verify.workbook`, `beforeDispatch`, or `afterResult`. Every event name below fails to match those five strings, so event cannot be expressed. Output must be `{decision:"pass"}` or `{decision:"block", code, facts}`. Each vendor page uses a different decision, which cannot be expressed either. `deterministic: true` requires a handler that does not call a model, open a network connection, or read the environment. No Hook file below declares that, so deterministic is not found.

`hub-provider/1` transport is only `stdio` or `streamable-http`. Endpoints, headers, environment variables, and tokens stay outside Git. They are not copied into the manifest or into examples in this document. provides, reads, and writes have no static field of the same name in any of the five server configs: capabilities are listed after the connection. provides cannot be expressed. reads and writes are not found. credentials records only that the secret stays outside Git. The three credentialMode values (a static secret, a platform-issued short-lived token, external OAuth) have no key of the same name and cannot be expressed.

Each Gemini CLI page opens by stating that, from 2026-06-18, Gemini CLI for unpaid and Google One users was replaced by Antigravity CLI. The Gemini section records only the format those Gemini CLI pages still describe. The Antigravity format was not surveyed.

Paths are the project-relative and home-relative paths from the official docs. The matrix is at the end.

## Claude Code

### Skill

Source: [Skills](https://code.claude.com/docs/en/skills). Consulted 2026-10-13.

Locations, from that page's scope table: `.claude/skills/<skill-name>/SKILL.md` inside the managed settings directory; personal `~/.claude/skills/<skill-name>/SKILL.md`; project `.claude/skills/<skill-name>/SKILL.md`; nested `<subdir>/.claude/skills/<skill-name>/SKILL.md`; `.claude/skills/` in a directory passed with `--add-dir`; plugin `<plugin>/skills/<skill-name>/SKILL.md`. A skill directory in the personal, project, or enterprise location may be a symlink. The folder name `synced` is reserved for skills synced from claude.ai.

Format: a directory plus `SKILL.md`. YAML frontmatter between `---` at the start of the file, then Markdown. If the file does not open with `---`, the whole file is body. If the YAML does not parse, the skill still loads with no fields set. An unrecognized field is ignored. Field names are lowercase and hyphenated, except `when_to_use`. Booleans accept `true` / `false` and, in any letter case, `yes`, `no`, `on`, `off`, `1`, and `0`.

| Field | Meaning on that page |
|---|---|
| `name` | Optional. Command name in the `/` menu. Defaults to the directory name |
| `description` | Recommended. If omitted, the first non-empty line of the body. Together with `when_to_use`, truncated at 1,536 characters in the skill listing |
| `when_to_use` | Optional. Extra text for when to invoke the skill, appended to description |
| `argument-hint` | Optional. Autocomplete hint for arguments |
| `arguments` | Optional. Named positional arguments for `$name` substitution. A space-separated string or a YAML list |
| `disable-model-invocation` | Optional, default false. When true, the skill is not loaded automatically |
| `user-invocable` | Optional, default true. When false, the user cannot invoke it with `/name` |
| `allowed-tools` | Optional. During the turn that invokes the skill, these tools are not asked one by one. Space- or comma-separated, or a YAML list. The page states that this does not restrict which tools remain callable |
| `disallowed-tools` | Optional. Tools removed from the available pool while the skill is active |
| `model` | Optional. Model while the skill is active, or `inherit` |
| `effort` | Optional. `low`, `medium`, `high`, `xhigh`, `max` |
| `context` | Optional. `fork` runs the skill in a forked subagent |
| `agent` | Optional. Which subagent type to use when `context: fork` |
| `background` | Optional. Only with `context: fork`. Default true |
| `hooks` | Optional. Hooks registered when the skill is invoked and kept for the rest of the session |
| `paths` | Optional. Globs that limit automatic activation. A comma-separated string or a YAML list |
| `shell` | Optional. `bash` (default) or `powershell` |
| `metadata` | Optional. Free-form YAML map. Claude Code does not act on it |
| `license` | Optional. Accepted, and not acted on |
| `compatibility` | Optional. A string of at most 500 characters. Accepted, and not acted on |

The same page states that claude.ai uploads, the Skills API, and `package_skill.py` from `anthropics/skills` accept only `name`, `description`, `license`, `compatibility`, `metadata`, and `allowed-tools`. Any other key fails packaging or upload.

| Neutral field | Result |
|---|---|
| name | `name`, or the directory name when omitted |
| description | `description`, or the first non-empty body line when omitted |
| model | `model` |
| entry | No key of that name was found. The page requires the entry file to be `SKILL.md`, so the adapter may set entry to that relative path |
| version, tools, inputs, outputs, triggers | Not found. `allowed-tools` is a one-turn grant that skips a prompt, and `disallowed-tools` removes tools. Neither is the list of tool names the skill may call, so tools cannot be expressed |
| sourceHarness, knownCompatible | See the opening |

The other frontmatter stays in the frozen bytes.

Export: no Claude Code command was found that exports an installed skill as a standalone package. `/run-skill-generator` writes a project skill from a run that succeeded. That is generation. `package_skill.py` belongs to `anthropics/skills` and is not a Claude Code export command.

### Command

Source: the same [Skills](https://code.claude.com/docs/en/skills) page. Consulted 2026-10-13.

That page states that custom commands have been merged into skills. `.claude/commands/deploy.md` and `.claude/skills/deploy/SKILL.md` both create `/deploy`. Existing Markdown files keep working. A file in a subdirectory replaces each `/` with `:`, so `.claude/commands/frontend/component.md` becomes `/frontend:component`. Frontmatter matches a skill except that `name` and `paths` are absent. The command name comes from the path, not from frontmatter.

| Neutral field | Result |
|---|---|
| name | The file name, or the subdirectory path plus the file name, with `/` written as `:` |
| description | Frontmatter `description` |
| arguments | `arguments` is the set of names used for `$name` substitution. `argument-hint` is only an autocomplete hint and cannot be expressed as arguments |

The same file is also a skill inside Claude Code. This survey does not decide whether it is registered as `hub-command/1` or `hub-skill/1`. Export: not found.

### Agent

Source: [Subagents](https://code.claude.com/docs/en/sub-agents). Consulted 2026-10-13.

Locations: project `.claude/agents/`, scanned upward from the working directory to the repository root, and the definition closer to the working directory wins on a shared name; personal `~/.claude/agents/`; `.claude/agents/` inside the managed settings directory; agents shipped by a plugin; `.claude/agents/` in a directory added with `--add-dir`. `--agents` can also pass JSON, which is not a file on disk. A nested subdirectory does not change identity. Identity comes only from frontmatter `name`. The filename does not have to match `name`. `/agents` only reminds you to edit those directories or to ask Claude to write the file.

Format: Markdown plus YAML frontmatter. The body is the system prompt. Only `name` and `description` are required. An unrecognized field is ignored. `name` is at most 256 characters and cannot contain `:`.

| Field | Meaning on that page |
|---|---|
| `name` | Required |
| `description` | Required. When to delegate |
| `tools` | Optional. A comma-separated string or a YAML list. If omitted, every tool available to subagents is inherited |
| `disallowedTools` | Optional. Removed from the inherited or listed tools |
| `model` | Optional. `sonnet`, `opus`, `haiku`, `fable`, a full model id, or `inherit` |
| `permissionMode` | Optional. `default`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`, `plan`. `manual` is an alias of `default`. Ignored for plugin subagents |
| `maxTurns` | Optional |
| `skills` | Optional. Skills preloaded into context at startup |
| `mcpServers` | Optional. A server name, or an inline server config. Ignored for plugin subagents |
| `hooks` | Optional. In force only while that subagent runs. Ignored for plugin subagents |
| `memory` | Optional. `user`, `project`, or `local` |
| `background` | Optional |
| `omitClaudeMd` | Optional |
| `effort` | Optional. `low`, `medium`, `high`, `xhigh`, `max` |
| `isolation` | Optional. `worktree` |
| `color` | Optional. `red`, `blue`, `green`, `yellow`, `purple`, `orange`, `pink`, `cyan` |
| `initialPrompt` | Optional. First turn submitted automatically when this agent is the main session agent |
| `experimental` | Optional map. `cacheTtl` is `5m` or `1h` |

| Neutral field | Result |
|---|---|
| name | `name` |
| description | `description` |
| tools | `tools`. `disallowedTools` cannot be expressed |
| model | `model` |
| sourceHarness | See the opening |

The other fields cannot be expressed. `skills` is a list of skill names to preload, and `hub-agent/1` has no such field. Export: not found.

### Instruction

Source: [Memory](https://code.claude.com/docs/en/memory). Consulted 2026-10-13.

`CLAUDE.md` is plain Markdown. That page does not treat its frontmatter as a schema. Load order, broadest first: managed policy (macOS `/Library/Application Support/ClaudeCode/CLAUDE.md`, Linux and WSL `/etc/claude-code/CLAUDE.md`, Windows `C:\Program Files\ClaudeCode\CLAUDE.md`), user `~/.claude/CLAUDE.md`, project `./CLAUDE.md` or `./.claude/CLAUDE.md`. `CLAUDE.local.md` loads beside `CLAUDE.md` in the same directory and should be gitignored. The working directory and its parents are concatenated at launch. A file in a subdirectory loads when Claude reads, writes, or edits a file there. `@path` imports another file. A relative path resolves from the file that contains the `@`, up to four hops.

`.md` files under `.claude/rules/` are discovered recursively. Personal rules live in `~/.claude/rules/`. Rule frontmatter is read only for `paths` (a YAML list or a comma-separated string). Any other field is ignored, and the frontmatter is removed before the rule enters context. A rule without `paths` loads at launch with the same priority as `.claude/CLAUDE.md`.

`AGENTS.md` is read by default when the working directory and its parents have no `CLAUDE.md`, `.claude/CLAUDE.md`, or `CLAUDE.local.md`. The user and managed `CLAUDE.md` files, and `.claude/rules/`, do not block it. Reading it directly requires Claude Code v2.1.277 or later. Project instructions can also be `claude-md-or-agents-md` (the default), `claude-md-and-agents-md`, `claude-md`, or `managed-only`. `.claude/AGENTS.md` is read in the same directory.

| Neutral field | Result |
|---|---|
| fileName | The file's name: `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, or the rule filename |
| applies | A rule's `paths` is a path. A product line was not found. `CLAUDE.md` itself has no path field |
| scope | The page distinguishes managed, user, project, and subdirectory locations. `hub-instruction/1` does not list the allowed scope strings, and this survey does not assign one |

The body is the frozen Markdown bytes. `/init` can generate a starting `CLAUDE.md`. When a file already exists, it suggests improvements and does not overwrite. With `CLAUDE_CODE_NEW_INIT=1`, `/init` proposes `CLAUDE.md`, skills, and hooks before writing. That is generation. No command was found that exports an existing instruction file. `/import` brings another coding agent's configuration into Claude Code (v2.1.213 or later). That is the opposite direction.

### Hook

Source: [Hooks](https://code.claude.com/docs/en/hooks). Consulted 2026-10-13.

Locations: `~/.claude/settings.json`, project `.claude/settings.json`, `.claude/settings.local.json`, managed policy settings, plugin `hooks/hooks.json`, and `hooks` in skill and subagent frontmatter. Layers merge. They do not replace one another.

Format: JSON. Under `hooks`, an event name, then matcher groups, each with a `hooks` array. `matcher` on a group: `*`, empty, or omitted matches everything. Five handler `type` values: `command`, `http`, `mcp_tool`, `prompt`, `agent`. Common fields also include `if`, `timeout` (seconds), `statusMessage`, and `once`. `command` also has `command`, `args`, `async`, `asyncRewake`, `shell` (`bash` or `powershell`), and `onFailure`. `http` also has `url`, `headers`, `allowedEnvVars`, and `onFailure`. Matching hooks run in parallel.

Event names that appear in that page's matcher table: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionDenied`, `SessionStart`, `Setup`, `SessionEnd`, `Notification`, `SubagentStart`, `PreCompact`, `PostCompact`, `PreModelSwitch`, `PostModelSwitch`, `SubagentStop`, `ConfigChange`, `CwdChanged`, `DirectoryAdded`, `FileChanged`, `StopFailure`, `InstructionsLoaded`, `UserPromptExpansion`, `Elicitation`, `ElicitationResult`, `UserPromptSubmit`, `PostToolBatch`, `Stop`, `TeammateIdle`, `TaskCreated`, `TaskCompleted`, `WorktreeCreate`, `WorktreeRemove`, `MessageDisplay`.

The command-hook example returns `permissionDecision: "deny"` as JSON on stdout, or uses the exit code.

| Neutral field | Result |
|---|---|
| event | Cannot be expressed. See the opening |
| order | Cannot be expressed. Matches run in parallel. There is no order integer |
| handler | For `type: command`, `command` plus optional `args` is the entry. `http`, `mcp_tool`, `prompt`, and `agent` cannot be expressed as one script entry |
| language | When `shell` is `bash`, or the default shell form is used, language may be `shell`. `powershell` and the other four types cannot be expressed. There is no `ts` value |
| deterministic | Not found. `prompt` and `agent` call a model |

Export: not found.

### MCP server

Source: [MCP](https://code.claude.com/docs/en/mcp). Consulted 2026-10-13.

Project scope is `mcpServers` in `.mcp.json` at the project root. User and local scope are in `~/.claude.json`. `claude mcp add` and `claude mcp add-json` write according to `--scope` (`project`, `user`, `local`). An entry with no `type` is read as stdio. An entry with `url` and no `type` is reported and skipped. For `type: http`, `streamable-http` is an alias. `sse` and `ws` also exist. `type: sdk` is skipped by Claude Code. stdio uses `command`, `args`, and `env`. `http`, `sse`, and `ws` use `url` and accept `headers`, `headersHelper`, `timeout`, and `alwaysLoad`. A project `.mcp.json` needs approval in an interactive session. `enableAllProjectMcpServers` committed in project settings is ignored until the workspace is trusted. An empty `url` counts as not configured.

| Neutral field | Result |
|---|---|
| transport | No `type`, started with `command`, or added as stdio: `stdio`. `type` `http` or `streamable-http`: `streamable-http`. `sse` and `ws` cannot be expressed |
| provides, reads, writes, credentials, credentialMode | See the opening |

`claude mcp list` and `claude mcp get` print connection status. `claude mcp remove` deletes an entry. No command was found that exports existing servers as a portable package.

## Codex CLI

The docs index is [llms.txt](https://learn.chatgpt.com/llms.txt). Consulted 2026-10-13.

### Skill

Source: [Build skills](https://learn.chatgpt.com/docs/build-skills). Consulted 2026-10-13.

A directory: required `SKILL.md`, optional `scripts/`, `references/`, `assets/`, and `agents/openai.yaml`. `SKILL.md` must include `name` and `description`. The frontmatter shown on that page has only those two. Optional `agents/openai.yaml` has `interface` (`display_name`, `short_description`, `icon_small`, `icon_large`, `brand_color`, `default_prompt`), `policy.allow_implicit_invocation` (default true), and `dependencies.tools` (each item has `type`, `value`, `description`, `transport`, and `url`; the example type is `mcp`).

Discovery: `.agents/skills` on every directory from the working directory up to the repository root, `$HOME/.agents/skills`, `/etc/codex/skills`, and system skills bundled with Codex. Symlinks are followed. Skills that share a name are not merged. `[[skills.config]]` in `~/.codex/config.toml` can disable one skill without deleting it, using `path` and `enabled = false`.

| Neutral field | Result |
|---|---|
| name, description | The same fields in `SKILL.md` |
| entry | No key of that name was found. The entry file is `SKILL.md` |
| version, tools, inputs, outputs, triggers, model | Not found. `dependencies.tools` declares an MCP dependency, not a list of tool names, so tools cannot be expressed |
| sourceHarness, knownCompatible | See the opening |

`$skill-creator` creates a skill. `$skill-installer` installs one from a repository. Plugins distribute skills. None of these exports an installed skill. Export: not found.

### Command

Source: [Custom prompts](https://learn.chatgpt.com/docs/custom-prompts). The index line says Deprecated and points to skills. Consulted 2026-10-13.

The page still states the on-disk format: top-level Markdown under `~/.codex/prompts/`. Subdirectories are not scanned. Frontmatter has `description` and `argument-hint`. The body uses `$1` through `$9`, `$ARGUMENTS`, and uppercase placeholders supplied as `KEY=value`. Invocation looks like `/prompts:<name>`. Non-Markdown files are ignored.

| Neutral field | Result |
|---|---|
| name | The file name |
| description | `description` |
| arguments | No argument-schema field was found. `argument-hint` and the `$1` placeholders cannot be expressed as arguments |

The reusable prompt recommended now is the skill in the previous section, not this directory. Export: not found.

### Agent

Source: [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents). Consulted 2026-10-13.

Personal `~/.codex/agents/`, project `.codex/agents/`. One agent per TOML file. Required: `name`, `description`, `developer_instructions`. `name` is the identity. The filename does not have to match. The file may also include other `config.toml` keys. The page names `model`, `model_reasoning_effort`, `sandbox_mode`, `mcp_servers`, and `skills.config`. Omitted session settings are inherited from the parent. Built-ins are `default`, `worker`, and `explorer`. Global `[agents]` in `config.toml`: `enabled` (default true), `max_concurrent_threads_per_session` (legacy alias `max_threads`), `default_subagent_model`, `default_subagent_reasoning_effort`, `interrupt_message` (default true). `/agent` switches threads. It is not an export.

| Neutral field | Result |
|---|---|
| name, description | The same fields |
| model | `model` |
| tools | No tool allowlist was found. `sandbox_mode` and `mcp_servers` cannot be expressed as tools |
| sourceHarness | See the opening |

`developer_instructions` is the behavior body. `hub-agent/1` has no matching field, so it stays in the frozen bytes. Export: not found.

### Instruction

Source: [AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md). Consulted 2026-10-13.

Plain Markdown. No frontmatter schema was found. Global: in the Codex home directory (default `~/.codex`, overridable with `CODEX_HOME`), `AGENTS.override.md` is read if it exists, otherwise `AGENTS.md`. Only the first non-empty file at that level is used. Project: from the project root down to the working directory, each directory checks `AGENTS.override.md`, then `AGENTS.md`, then names in `project_doc_fallback_filenames`, at most one file per directory. Files are concatenated from the root downward, so a closer file appears later. Empty files are skipped. Concatenation stops at `project_doc_max_bytes`, default 32 KiB. The page's example sets the fallback list to `TEAM_GUIDE.md` and `.agents.md` and sets the limit to 65536.

| Neutral field | Result |
|---|---|
| fileName | The name of the file actually read |
| applies | No path or product-line field was found. The directory location itself is not applies |
| scope | The page distinguishes global and project. No value list was found, and this survey does not assign a string |

Export: not found.

### Hook

Source: [Hooks](https://learn.chatgpt.com/docs/hooks). Consulted 2026-10-13.

`hooks.json`, or `[hooks]` in `config.toml`. Common locations: `~/.codex/hooks.json`, `~/.codex/config.toml`, repository `.codex/hooks.json`, repository `.codex/config.toml`. Matching hooks from more than one source all run. A higher-precedence layer does not replace a lower-precedence layer. When one layer contains both files, Codex merges them and warns at startup. A plugin may bundle `hooks/hooks.json`. Project hooks load only when the `.codex/` layer is trusted. `/hooks` reviews, trusts, or disables hooks. It is not an export.

During a turn: `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `UserPromptSubmit`, `SubagentStop`, `Stop`. On interrupt: `Interrupt`. When a session or subagent starts: `SessionStart`, `SubagentStart`. When the main thread ends: `SessionEnd`.

The shape is event, matcher group, handler. `command` and `mcp_tool` run. `prompt` and `agent` are parsed and then skipped. Optional file-level `description`. Handler fields in that page's configuration section: `type`, `command`, `timeout` (seconds), `statusMessage`, `additionalContextLimit`, `async`, and Windows `commandWindows` (also `command_windows` in TOML). Multiple command hooks for the same event start concurrently. A hook may return `permissionDecision` (`deny`, or `allow` with `updatedInput`). The older shape is `decision: "block"`. Exit code 2 with the reason on stderr also blocks.

| Neutral field | Result |
|---|---|
| event, order, deterministic | event and deterministic: see the opening. order cannot be expressed: command hooks are concurrent, and there is no order integer |
| handler | `command` when `type` is `command`. `mcp_tool` cannot be expressed as a script entry |
| language | No `ts` / `shell` field was found. The command string may launch Python, which is not enough to fill language |

Export: not found. [Import](https://learn.chatgpt.com/docs/import) brings another agent's settings, skills, hooks, and subagents into ChatGPT or Codex. That is the opposite direction.

### MCP server

Source: [MCP](https://learn.chatgpt.com/docs/extend/mcp). Consulted 2026-10-13.

`[mcp_servers.<server-name>]` in `~/.codex/config.toml` or project `.codex/config.toml`. `codex mcp add` writes it. stdio: `command` is required; `args`, `env`, `env_vars`, `cwd`, and `experimental_environment` are optional. The page labels the other class Streamable HTTP: `url` is required; `auth` (`oauth` or `chatgpt`), `bearer_token_env_var`, `http_headers`, `env_http_headers`, and `http_headers_helper` are optional. Both classes may set `startup_timeout_sec`, `tool_timeout_sec`, `enabled`, `required`, `enabled_tools`, `disabled_tools`, `default_tools_approval_mode`, `tools.<tool>.approval_mode`, and `tools.<tool>.output_token_limit`. The meaning of `writes` is in the permission-policy export and is not repeated here.

| Neutral field | Result |
|---|---|
| transport | A stdio entry with `command`: `stdio`. An entry the page calls Streamable HTTP, configured with `url`: `streamable-http` |
| provides | Cannot be expressed. `enabled_tools` and `disabled_tools` allow and deny tools after connection. They are not provides as tools / resources / prompts |
| reads, writes, credentials, credentialMode | See the opening |

Export: not found. `codex mcp login` signs in.

## OpenCode

The v2 docs index is [llms.txt](https://opencode.ai/v2/llms.txt). Config file locations come from [Config](https://opencode.ai/v2/docs/config/). Consulted 2026-10-13. System directory: macOS `/Library/Application Support/opencode`, Linux `/etc/opencode`, Windows `%ProgramData%\opencode`. Global `~/.config/opencode/opencode.json(c)`. Project root `opencode.json(c)` or `.opencode/opencode.json(c)`. `opencode.json(c)` means `opencode.json` or `opencode.jsonc`.

### Skill

Source: [Skills](https://opencode.ai/v2/docs/skills/). Consulted 2026-10-13.

Project `.opencode/skills`, from the working directory up to the project root. Global `~/.config/opencode/skills`. Compatibility locations: global `~/.claude/skills` and `~/.agents/skills`, project `.claude/skills` and `.agents/skills`. The system directory also loads `skills/`. A `skills` array may add a relative path, a `~/` path, an absolute path, or an http(s) catalog.

Two file forms: `review.md` at the root of a source, or `SKILL.md` at any depth. The id comes from the path. `git-release/SKILL.md` has id `git-release`. `teams/release/SKILL.md` has id `release`, the last segment. Frontmatter `name` is only a display name. An HTTP catalog's `index.json` has `name`, `version`, and `files` on each entry.

All frontmatter is optional at runtime:

| Field | Meaning on that page |
|---|---|
| `name` | Display name. Defaults to the path id |
| `description` | Summary shown to the model. Without it, the skill is not advertised |
| `metadata.opencode/autoinvoke` | When false, the skill is omitted from the model's available list and can still be loaded by id |
| `disable-model-invocation` | When true, the same effect as the row above. If both are set, `opencode/autoinvoke` wins |
| `license`, `compatibility` | Accepted and not interpreted |

| Neutral field | Result |
|---|---|
| name | The path id. Display `name` may differ from the id, and the neutral name is the id |
| description | `description` |
| entry | The file's relative path: `SKILL.md` or `<id>.md` at the source root |
| version | Not found on `SKILL.md`. `version` on an HTTP catalog entry is a cache version and cannot be expressed as the skill version |
| tools, inputs, outputs, triggers, model | Not found |
| sourceHarness, knownCompatible | See the opening |

Export: not found.

### Command

Source: [Commands](https://opencode.ai/v2/docs/commands/). Consulted 2026-10-13.

`~/.config/opencode/commands/` and `.opencode/commands/`. Only `.md` is discovered. A nested path joins with `/`, so `team/review.md` becomes `/team/review`. The legacy singular directory `command/` is still discovered. The system directory also loads `commands/`. JSON lives at `commands.<name>` in any config file and requires `template`. The Markdown body is the template. Do not put `template` in frontmatter.

| Field | Meaning on that page |
|---|---|
| `template` | JSON only. The prompt template |
| `description` | Optional |
| `agent` | Optional. Agent selected when the command runs |
| `model` | Optional. `provider/model` or `provider/model#variant` |
| `subagent` | Optional. When true, the command runs in a background child session |
| `subtask` | Deprecated alias of `subagent`. If both are present, `subagent` wins |

`$ARGUMENTS` is the whole argument string. `$1`, `$2`, and higher are positional. When none of these placeholders is present, non-empty arguments are appended to the template.

| Neutral field | Result |
|---|---|
| name | The path, nested with `/` |
| description | `description` |
| arguments | No argument schema was found. `$ARGUMENTS` and `$1` cannot be expressed as arguments |

`agent`, `model`, and `subagent` cannot be expressed. Export: not found.

### Agent

Source: [Agents](https://opencode.ai/v2/docs/agents/). Consulted 2026-10-13.

`~/.config/opencode/agents/<name>.md` and `.opencode/agents/<name>.md`. A nested path is part of the id, so `team/reviewer.md` has id `team/reviewer`. The system directory also loads `agents/`. The Markdown body is the system prompt. Do not put `system` in frontmatter. JSON lives under `agents`.

| Field | Meaning on that page |
|---|---|
| `description` | What the agent is for |
| `mode` | `primary`, `subagent`, or `all`. A new agent defaults to `primary` when omitted |
| `model` | String `provider/model`, optional `#variant`. JSON may also use `providerID`, `model`, and `variant` |
| `system` | JSON only |
| `permissions` | Ordered rules: `action`, `resource`, `effect` (`allow`, `ask`, `deny`). The last match wins |
| `steps` | Positive integer. Maximum model steps |
| `hidden` | Hidden from ordinary listings |
| `color` | UI color |
| `disabled` | Removes the agent at that configuration layer |
| `request` | Header and JSON body overlays. The page states that the session runner does not send them yet |
| `default_agent` | Top-level config, not a field of one agent |

Actions named on that page: `shell`, `edit`, `subagent`, `read`, `glob`, `grep`, `webfetch`, `websearch`, `skill`. The page also says new configuration should not use the legacy top-level fields `temperature`, `top_p`, `prompt`, `permission`, `tools`, `disable`, or `maxSteps`. Visible built-in agents are `build`, `plan`, `general`, and `explore`.

| Neutral field | Result |
|---|---|
| name | The id derived from the file path |
| description | `description` |
| model | `model` |
| tools | Cannot be expressed. The current field is `permissions`, not a tool allowlist. The page explicitly drops legacy `tools` |
| sourceHarness | See the opening |

Export: not found.

### Instruction

Source: [Instructions](https://opencode.ai/v2/docs/instructions/). Consulted 2026-10-13.

`AGENTS.md` only. v2 does not use `CLAUDE.md` as a fallback. Global `~/.config/opencode/AGENTS.md`, plus every `AGENTS.md` from the current workspace toward the home directory. Outside the home directory, the walk stops at the project root. Files are combined. Conflicts are not resolved. An `AGENTS.md` below the workspace loads when that area is read, nearest first. Plain Markdown. The schema still accepts an `instructions` array. v2 does not currently resolve its files, globs, or URLs. `OPENCODE_DISABLE_PROJECT_CONFIG=1` skips project `AGENTS.md` and does not disable the global file.

| Neutral field | Result |
|---|---|
| fileName | `AGENTS.md` |
| applies | No path pattern or product line was found |
| scope | The page distinguishes the global file from a project directory. No value list was found |

Export: not found.

### Hook

[Hooks](https://opencode.ai/v2/docs/hooks/) returned 404 on 2026-10-13. The v2 index has no Hooks page.

[Plugins](https://opencode.ai/v2/docs/plugins/) puts hooks inside a plugin. On disk that is plugin code, not a hook manifest. Discovery: direct `.ts` and `.js` files and immediate plugin-package directories in every `.opencode/plugins/`; `~/.config/opencode/plugins/`; the `plugins` array in config. `opencode plugin add`, `list`, `check`, `update`, and `remove` manage global package plugins.

Registration comes from [Build plugins](https://opencode.ai/v2/docs/build/plugins/). Consulted 2026-10-13. A plugin calls `ctx.<domain>.hook(name, callback)` from `setup`. Hooks of the same name run in plugin registration order, and a later registration sees changes made by an earlier one. Names written on that page:

| Domain | Names |
|---|---|
| session | `prompt`, `context`, `compaction`, `generate`, `title`, `model.request`, `http.request`, `http.response`, `experimental.ws.handshake`, `experimental.ws.send`, `experimental.ws.receive`, `retry` |
| permission | `evaluate` |
| shell | `create.before` |
| tool | `execute.before`, `execute.after` |

The `prompt` hook has no typed rejection API. `permission` `evaluate` may change `effect`. One `evaluate` example on that page calls a model again.

| Neutral field | Result |
|---|---|
| event, order, handler, language, deterministic | Cannot be expressed, or not found. There is no key matching `hub-hook/1`. Registration order is not an order integer. The callback lives in plugin source, not in a handler path. language was not found. The example may call a model, so deterministic cannot be set to true |

Export: not found.

### MCP server

Source: [MCP servers](https://opencode.ai/v2/docs/mcp-servers/). Consulted 2026-10-13.

The key is `mcp.servers.<name>`. Server names are not placed directly under `mcp`. `opencode mcp add <name> --url …` writes the project configuration. `--global` makes the server available in every project. A higher-precedence project config replaces the whole server object of the same name.

Local: `type` is required and must be `local`. `command` is required and is a string array of the executable followed by its arguments. Optional: `cwd`, `environment`, `disabled` (default false), `codemode` (default true), `timeout`, `protocol` (`legacy`, `auto`, or `2026-07-28`). Environment values use `{env:NAME}`, not `$NAME`.

Remote: `type` is required and must be `remote`. `url` is required. The page calls it an absolute Streamable HTTP endpoint. Optional: `headers`, `oauth` (or false), and the same `disabled`, `codemode`, `timeout`, and `protocol` as local. OAuth is on unless `oauth` is false. Credentials stay outside the project configuration. Sign-in uses `/mcps` or `opencode mcp auth`. `opencode mcp list` shows status. Removal deletes the entry from the configuration.

| Neutral field | Result |
|---|---|
| transport | `type: local` is `stdio`. `type: remote` is `streamable-http` |
| provides | Cannot be expressed. `codemode: false` chooses whether tools are exposed directly or through Code Mode. It is not a provides list |
| reads, writes, credentials, credentialMode | See the opening |

Export: not found. `opencode mcp add` writes configuration.

## Gemini CLI

Each page opens with the Antigravity replacement note. See the opening. Consulted 2026-10-13.

### Skill

Source: [Agent Skills](https://geminicli.com/docs/cli/skills), [Creating Agent Skills](https://geminicli.com/docs/cli/creating-skills). Consulted 2026-10-13.

Discovery tiers, lowest to highest: built-in, extension, user `~/.gemini/skills/` or the alias `~/.agents/skills/`, workspace `.gemini/skills/` or the alias `.agents/skills/`. On a shared name, the higher tier wins. Within one tier, the alias wins over the `.gemini` directory. A directory plus `SKILL.md`, with optional `scripts/`, `references/`, and `assets/`. The frontmatter those pages state is `name` (it should match the directory name) and `description` (Gemini uses it to decide). Neither page gives a larger field table.

`gemini skills list`, `install`, `uninstall`, and `link`. `--scope` is `user` (default) or `workspace`. Inside a session: `/skills list`, `link`, `disable`, `enable`, `reload`. The creating page also names `node scripts/init_skill.cjs` and `validate_skill.cjs` in the core package, and `package_skill.cjs`, which produces a `.skill` zip.

| Neutral field | Result |
|---|---|
| name, description | The same fields |
| entry | The entry file is `SKILL.md` |
| version, tools, inputs, outputs, triggers, model | Not found |
| sourceHarness, knownCompatible | See the opening |

`gemini skills install` installs into Gemini. `package_skill.cjs` is a packaging script in the core package, not a command that exports an installed configuration. No export command was found.

### Command

Source: [Custom commands](https://geminicli.com/docs/cli/custom-commands). Consulted 2026-10-13.

User `~/.gemini/commands/`, project `<project-root>/.gemini/commands/`. On a shared name, the project command overrides the user command. TOML, extension `.toml`. The name comes from the relative path, and a subdirectory separator becomes `:`: `test.toml` is `/test`, `git/commit.toml` is `/git:commit`.

`prompt` is required. `description` is optional. If omitted, a generic description is generated from the filename. Arguments use `{{args}}` in the body. Without that placeholder, the full command the user typed is appended after the prompt, separated by a blank line. `!{...}` injects command output. `@{path}` injects file content. The field table on that page lists only `prompt` and `description`.

| Neutral field | Result |
|---|---|
| name | The path, separated by `:` |
| description | `description` |
| arguments | No argument schema was found. `{{args}}` cannot be expressed as arguments |

`/commands reload` and `/commands list` rescan and list. Export: not found.

### Agent

Source: [Subagents](https://geminicli.com/docs/core/subagents/), [Remote subagents](https://geminicli.com/docs/core/remote-agents/). `/docs/cli/subagents` and `/docs/cli/agents` returned 404 that day. Consulted 2026-10-13.

Local and remote agents are both `.gemini/agents/*.md` or `~/.gemini/agents/*.md`, with YAML frontmatter. A local file must start with `---`. The body is the system prompt.

Local fields:

| Field | Required | Meaning on that page |
|---|---|---|
| `name` | yes | Lowercase letters, numbers, hyphens, and underscores |
| `description` | yes | The main agent uses this to decide whether to call the subagent |
| `kind` | no | `local` (default) or `remote` |
| `tools` | no | A list of tool names. `*`, `mcp_*`, and `mcp_server_*` are accepted. If omitted, every tool of the parent session is inherited |
| `mcpServers` | no | Inline MCP configuration isolated to this agent |
| `model` | no | Omitted means `inherit` |
| `temperature` | no | Default 1 |
| `max_turns` | no | Default 30 |
| `timeout_mins` | no | Default 10 |

A remote file must set `kind` to `remote`. `name` is required, plus one of `agent_card_url` or `agent_card_json`. `auth` is optional. `auth.type` on that page lists `apiKey`, `http`, `google-credentials`, and `oauth`. A YAML list in one file may hold several remote agents. The page states that mixed local and remote agents, or several local agents, in one file are not supported. `experimental.enableAgents: false` in `settings.json` disables subagents. `agents.overrides` can override `modelConfig` per agent.

| Neutral field | Result |
|---|---|
| name | `name` |
| description | Local `description`. description was not found in the remote schema table |
| tools | Local `tools`. Wildcards stay as written and are not expanded. tools was not found for remote |
| model | Local `model`. Not found for remote |
| sourceHarness | See the opening |

`kind`, `temperature`, `max_turns`, `timeout_mins`, `mcpServers`, `auth`, and the agent card cannot be expressed. Export: not found.

### Instruction

Source: [GEMINI.md](https://geminicli.com/docs/cli/gemini-md). Consulted 2026-10-13.

The default filename is `GEMINI.md`. Plain Markdown. No frontmatter schema was found. Global `~/.gemini/GEMINI.md`. Project: the CLI searches configured workspace directories and their parents. When a tool accesses a directory, it scans from that directory up to a trusted root. Files found are concatenated. `@file.md` imports a file, by a relative or absolute path. `context.fileName` in `settings.json` may be another name or a list of names. The page's example is `AGENTS.md`, `CONTEXT.md`, and `GEMINI.md`. `/memory show` displays the concatenated body. `/memory reload` scans again.

| Neutral field | Result |
|---|---|
| fileName | `GEMINI.md` by default, or a name in `context.fileName` |
| applies | Not found |
| scope | The page distinguishes global, workspace, and just-in-time directories. No value list was found |

Export: not found. `/memory show` displays the text. It does not write a portable file.

### Hook

Source: [Hooks](https://geminicli.com/docs/hooks), [Hooks reference](https://geminicli.com/docs/hooks/reference). Consulted 2026-10-13.

`hooks` in `settings.json`. Merge order, highest to lowest: project `.gemini/settings.json`, user `~/.gemini/settings.json`, system `/etc/gemini-cli/settings.json`, then extensions.

Events: `SessionStart`, `SessionEnd`, `BeforeAgent`, `AfterAgent`, `BeforeModel`, `AfterModel`, `BeforeToolSelection`, `BeforeTool`, `AfterTool`, `PreCompress`, `Notification`.

Each event is an array of definitions. A definition has optional `matcher`, optional `sequential`, and required `hooks`. When `sequential` is true, hooks in the group run one after another. When false, they run in parallel. A handler currently has only `type: command`, required `command`, and optional `name`, `timeout` (milliseconds, default 60000), and `description`. stdout must be JSON only. Exit code 0 parses JSON. Exit code 2 is a system block. Any other code warns and continues. Common output fields on the reference page: `systemMessage`, `suppressOutput`, `continue`, `stopReason`, `decision` (`allow` or `deny`, alias `block`), and `reason`.

| Neutral field | Result |
|---|---|
| event, deterministic | See the opening |
| order | Cannot be expressed. `sequential` is a boolean, not an order integer |
| handler | `command` |
| language | The page calls `command` the shell command to execute, so language may be `shell`. There is no `ts` |

`/hooks` can show hooks and enable or disable them all, or one hook by `name`. Export: not found.

### MCP server

Source: [MCP server](https://geminicli.com/docs/tools/mcp-server). Consulted 2026-10-13.

`mcpServers` in `settings.json`. `gemini mcp add` writes `~/.gemini/settings.json` for `--scope user`, or `.gemini/settings.json` for `project`, which is the default. There is also a top-level `mcp.serverCommand`. Each server requires one of `command` (stdio), `url` (SSE), or `httpUrl` (the page calls this an HTTP streaming endpoint). Optional: `args`, `headers`, `env`, `cwd`, `timeout` (default 600000 milliseconds), `trust`, `includeTools`, `excludeTools` (exclude wins), `targetAudience`, `targetServiceAccount`, and `authProviderType` (`dynamic_discovery`, `google_credentials`, `service_account_impersonation`). `gemini mcp list` and `gemini mcp remove` list and delete. `--transport` accepts `stdio`, `sse`, and `http`.

| Neutral field | Result |
|---|---|
| transport | `command` is `stdio`. `httpUrl` matches the page's HTTP streaming and is recorded as `streamable-http`. SSE that has only `url` cannot be expressed |
| provides | Cannot be expressed. `includeTools` and `excludeTools` filter tool names. They are not provides |
| reads, writes, credentials, credentialMode | See the opening |

Export: not found.

## Cursor

### Skill

Source: [Agent Skills](https://cursor.com/docs/skills). Consulted 2026-10-13.

Project `.agents/skills/` and `.cursor/skills/`. User `~/.agents/skills/` and `~/.cursor/skills/`. Compatibility: `.claude/skills/`, `.codex/skills/`, `~/.claude/skills/`, and `~/.codex/skills/`. Discovery walks recursively for `SKILL.md`. The directory that contains `SKILL.md` is the identity. A category directory above it is not. A skill in a nested project directory is automatically scoped to that directory. Optional `scripts/`, `references/`, and `assets/`.

| Field | Required | Meaning on that page |
|---|---|---|
| `name` | yes | Lowercase letters, numbers, and hyphens. Must match the parent folder name |
| `description` | yes | What the skill does and when to use it |
| `paths` | no | Globs. A comma-separated string or a list. Legacy `globs` is still accepted |
| `disable-model-invocation` | no | When true, the skill is included only through an explicit `/skill-name` |
| `icon` | no | Badge icon when the skill is used as a Custom Mode |
| `color` | no | Badge color: `default`, `green`, `cyan`, `blue`, `purple`, `magenta`, `orange`, `yellow`, `red`, `brand` |
| `metadata` | no | Arbitrary key-value map |

| Neutral field | Result |
|---|---|
| name, description | The same fields |
| entry | `SKILL.md` |
| version, tools, inputs, outputs, triggers, model | Not found. `paths` is a file scope. The shape of triggers is not spelled out in the neutral manifest, so it cannot be expressed |
| sourceHarness, knownCompatible | See the opening |

`/create-skill` creates a skill. `/migrate-to-skills` (2.4) turns dynamic rules and user-level and workspace-level slash commands into skills under `.cursor/skills/`. A skill converted from a command has `disable-model-invocation: true`. Sync Skills for Cloud Agents, under Settings → Agents, copies only `~/.cursor/skills/`. Sharing with a team publishes to the team marketplace. None of these exports a package the hub can read. Export: not found.

### Command

No directory of the user's own user-level or workspace-level slash commands was found that day. The skills page states that both levels exist and that `/migrate-to-skills` converts them into skills, and it does not name the source directory.

In [Plugins](https://cursor.com/docs/reference/plugins), a plugin's `commands/` discovers `.md`, `.mdc`, `.markdown`, and `.txt`. Frontmatter has `name` and `description`. That path is inside a plugin package, not a standalone user command directory.

| Neutral field | Result |
|---|---|
| name, description | The same fields were found only in plugin-command frontmatter |
| arguments | Not found |

Export: not found.

### Agent

Source: [Subagents](https://cursor.com/docs/subagents). Consulted 2026-10-13.

Project `.cursor/agents/`, `.claude/agents/`, and `.codex/agents/`. User `~/.cursor/agents/`, `~/.claude/agents/`, and `~/.codex/agents/`. Project beats user. On a shared name, `.cursor/` beats `.claude/` or `.codex/`. Markdown plus YAML. The body is the prompt.

| Field | Required | Default | Meaning on that page |
|---|---|---|---|
| `name` | no | Derived from the filename | Lowercase letters and hyphens |
| `description` | no | None | Shown to the parent agent when it decides delegation |
| `model` | no | `inherit` | `inherit` or a model id. Options such as `[effort=high]` may follow the id |
| `readonly` | no | false | When true, no file edits and no state-changing shell commands |
| `is_background` | no | false | When true, the subagent runs in the background |

| Neutral field | Result |
|---|---|
| name | `name`, or the filename when omitted |
| description | `description` |
| model | `model` |
| tools | Not found. `readonly` cannot be expressed as a tool allowlist |
| sourceHarness | See the opening |

`/create-subagent` creates one. Export: not found.

### Instruction

Source: [Rules](https://cursor.com/docs/rules). Consulted 2026-10-13.

Project rules: `.mdc` files under `.cursor/rules`. A plain `.md` file in that directory is ignored. Frontmatter is `description`, `globs`, and `alwaysApply`. When `alwaysApply` is true, globs and description are ignored. When `alwaysApply` is false and globs are set, the rule follows the file match. With a description and no globs, the agent decides. With neither, the rule is included only when `@`-mentioned in chat. Separate multiple globs with commas. `/create-rule` writes into `.cursor/rules`.

`AGENTS.md` sits at the project root or in a subdirectory. Plain Markdown, with no metadata. A subdirectory file is combined with its parents, and the more specific instructions take precedence.

User rules live in Customize → Rules. The skills page states that they are not stored on the file system. Team rules live in the dashboard. The body is free-form text and may have a glob. That page gives no file path. Precedence is team, then project, then user. When guidance conflicts, the earlier source takes precedence.

| Neutral field | Result |
|---|---|
| fileName | The `.mdc` filename, or `AGENTS.md` |
| applies | `globs` on an `.mdc` file, and a glob on a team rule, are paths. A product line was not found. `AGENTS.md` has no path field |
| scope | The page distinguishes project, user, and team. No value list was found. User rules have no file |

Export: not found. Bringing rules in from a GitHub repository means packaging them as a plugin with `.cursor-plugin/marketplace.json`. That is the opposite direction.

### Hook

Source: [Hooks](https://cursor.com/docs/hooks). Consulted 2026-10-13.

Project `<project-root>/.cursor/hooks.json`, user `~/.cursor/hooks.json`. Enterprise: macOS `/Library/Application Support/Cursor/hooks.json`, Linux and WSL `/etc/cursor/hooks.json`, Windows `C:\ProgramData\Cursor\hooks.json`. Team-distributed hooks also exist. Priority, highest to lowest: enterprise, team, project, user. Matching hooks from every source run. On merge, deny wins over ask, and ask wins over allow.

JSON. `version` is required, a positive integer. The page says to use `1`. `hooks` maps an event name to an array of definitions. Definition fields: `command` is required; `type` is `command` (the default) or `prompt`; `timeout` is in seconds; `loop_limit`; `failClosed`; `matcher`. A `prompt` type also has `prompt` text.

Agent events: `sessionStart`, `sessionEnd`, `preToolUse`, `postToolUse`, `postToolUseFailure`, `subagentStart`, `subagentStop`, `beforeShellExecution`, `afterShellExecution`, `beforeMCPExecution`, `afterMCPExecution`, `beforeReadFile`, `afterFileEdit`, `beforeSubmitPrompt`, `preCompact`, `stop`, `afterAgentResponse`, `afterAgentThought`. Tab: `beforeTabFileRead`, `afterTabFileEdit`. App: `workspaceOpen`.

Command hooks communicate over stdio with JSON in both directions. Example output uses `permission`: `allow`, `deny`, or `ask`. Cloud agents run command hooks from the repository only.

| Neutral field | Result |
|---|---|
| event, deterministic | See the opening |
| order | No order field was found |
| handler | `command`, when `type` is omitted or is `command`. `prompt` cannot be expressed |
| language | Not found. `command` may be a shell string or `bun run` of a `.ts` file, which is not enough to write `ts` or `shell` |

`/create-hook` writes `hooks.json`. Export: not found. Third-party hooks are at [Third-party hooks](https://cursor.com/docs/reference/third-party-hooks). Those are distributed hooks, not an export command.

### MCP server

Source: [MCP](https://cursor.com/docs/mcp). Consulted 2026-10-13.

Project `.cursor/mcp.json`, global `~/.cursor/mcp.json`. Root key `mcpServers`. The stdio field table: `type` is required and is `stdio`, `command` is required, and `args`, `env`, and `envFile` are optional. An example on the same page writes only `command`, `args`, and `env` for a local entry, with no `type`. A remote example writes `url` and `headers`, annotated as HTTP or SSE, plus `auth` (`CLIENT_ID`, `CLIENT_SECRET`, `scopes`). Variable substitution applies in `command`, `args`, `env`, `url`, and `headers`. An MCP manifest inside a plugin marketplace may also carry `type: stdio`.

| Neutral field | Result |
|---|---|
| transport | `type: stdio`, or a local example that has only `command`: `stdio`. An entry that has only `url` is written on that page as both HTTP and SSE, so transport stays empty |
| provides, reads, writes, credentials, credentialMode | See the opening |

Install from Customize, or write `mcp.json`. No export command was found.

## Path matrix

Each cell is the main file for that primitive. Compatibility directories, system directories, and plugin packages are in the sections above. A primitive with no file found is "Not found".

| Primitive | Claude Code | Codex CLI | OpenCode | Gemini CLI | Cursor |
|---|---|---|---|---|---|
| Skill | `.claude/skills/<name>/SKILL.md`; `~/.claude/skills/<name>/SKILL.md` | `.agents/skills/<name>/SKILL.md`; `~/.agents/skills/<name>/SKILL.md` | `.opencode/skills/<id>/SKILL.md`; `~/.config/opencode/skills/` | `.gemini/skills/<name>/SKILL.md`; `~/.gemini/skills/` | `.cursor/skills/<name>/SKILL.md`; `.agents/skills/<name>/SKILL.md`; `~/.cursor/skills/` |
| Command | `.claude/commands/<name>.md` | `~/.codex/prompts/<name>.md` | `.opencode/commands/<name>.md`; `~/.config/opencode/commands/` | `.gemini/commands/<name>.toml`; `~/.gemini/commands/` | Not found |
| Agent | `.claude/agents/<name>.md`; `~/.claude/agents/` | `.codex/agents/<file>.toml`; `~/.codex/agents/` | `.opencode/agents/<name>.md`; `~/.config/opencode/agents/` | `.gemini/agents/<name>.md`; `~/.gemini/agents/` | `.cursor/agents/<name>.md`; `~/.cursor/agents/` |
| Instruction | `CLAUDE.md`; `.claude/CLAUDE.md`; `.claude/rules/*.md`; `AGENTS.md` | `AGENTS.md`; `AGENTS.override.md`; `~/.codex/AGENTS.md` | `AGENTS.md`; `~/.config/opencode/AGENTS.md` | `GEMINI.md`; `~/.gemini/GEMINI.md` | `.cursor/rules/*.mdc`; `AGENTS.md` |
| Hook | `.claude/settings.json`; `~/.claude/settings.json` | `~/.codex/hooks.json`; `.codex/hooks.json`; `[hooks]` in `config.toml` in the same layer | No separate file found. Plugin code in `.opencode/plugins/`, `~/.config/opencode/plugins/` | `.gemini/settings.json`; `~/.gemini/settings.json` | `.cursor/hooks.json`; `~/.cursor/hooks.json` |
| MCP server | `.mcp.json`; `~/.claude.json` | `~/.codex/config.toml`; `.codex/config.toml` | `mcp.servers` in `opencode.json(c)` | `.gemini/settings.json`; `~/.gemini/settings.json` | `.cursor/mcp.json`; `~/.cursor/mcp.json` |

---

This document is one of circle-hub's design specifications, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/): quote or build on it with attribution to Circle Hub and qingshanfeihu and a link to the original. See the [design specifications index](README.md#license).
