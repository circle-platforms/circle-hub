# harness-adapters

> 中文版：[README.md](README.md)

Read each harness's own Skill / Command / Agent / Instruction / Hook / MCP server formats into the hub's neutral manifests (`hub-skill/1`, `hub-command/1`, `hub-agent/1`, `hub-instruction/1`, `hub-hook/1`, `hub-provider/1`), then export from the neutral manifests back into that harness's files. The specification is `docs/design/harness-primitives.md`; the per-harness on-disk format evidence is `docs/design/harness-formats.md`.

Pure TypeScript, no runtime dependencies (zod is used only for export-boundary validation): no server, no database, no network, no environment reads.

## API

```ts
import { importFrom, exportTo, type VirtualFiles, type HubManifest } from './packages/harness-adapters/index.ts';

const { manifests, warnings } = importFrom(harness, files);
const { files: outFiles, warnings: exportWarnings } = exportTo(harness, manifests, files);
```

- `harness`: `'claude-code' | 'codex' | 'opencode' | 'gemini' | 'cursor'`
- `files` / `outFiles`: a virtual file table `{ [path: string]: string | Uint8Array }` with project-relative POSIX paths. The hub hands bytes in at import and receives bytes back at export.
- `importFrom` returns `{ manifests, warnings[] }`; `exportTo` returns `{ files, warnings[] }`. Warnings are structured `{ code, path, detail }` — details carry only paths, line numbers and key names, never values or whole lines.

### Manifests and bytes

- Manifests contain fields only, never full file text. Every manifest records `files: [{ path, sha256 }]` pointing at its source files; `harnessSpecific` holds only location and structure information (original path, frontmatter key order, event/group/entry positions, key-name skeletons of config entries) plus unmapped frontmatter keys (keys and values kept — frontmatter is model-visible configuration that lives in Git anyway).
- Export requires the **same original file table** passed back to `exportTo`: markdown bodies and skill sibling files come from the original files; config files are regenerated from manifest structure plus the original bytes.
- Byte-identity rules: an unchanged markdown manifest exports byte-identically (editing a frontmatter field rewrites the frontmatter and leaves the body alone); JSON config files round-trip byte-identically when the original is in canonical form (2-space indent, trailing newline) and nothing was sanitized; TOML and JSONC comments do not survive (reported as `TOML_COMMENT_DROPPED` / `CANONICAL_NORMALIZATION`).
- Cross-harness export is unsupported: a manifest whose `sourceHarness` differs from the target is reported as `CROSS_HARNESS_EXPORT` and skipped.

### Sanitization (structural, never guessed)

- Config entries enter the manifest's shape with key names only: object values record nested key names, other keys record presence only. Unknown keys like `headersHelper` therefore carry no values either.
- At export, values are read back from the original file and the rules are re-applied: object values and url / httpUrl become `[redacted]` placeholders reported as `SECRET_PLACEHOLDER`; `cwd` is never written; args words containing `://`, starting with `/` or `~`, or shaped `--x=y` are replaced with `[redacted]`; absolute-path commands reduce to basenames.
- Hook commands are tokenized with shell quoting rules first; the program word is reduced to its basename, every other word gets the same rules, plus a Bearer keyword rule.
- `credentials` lists only the key names of env / headers / http_headers / env_http_headers / environment.

## Warning codes

| code | meaning |
|---|---|
| `FRONTMATTER_UNCLOSED` | the opening `---` has no closing one; the whole file is treated as body with no frontmatter fields |
| `FRONTMATTER_LINE_SKIPPED` | a frontmatter line is outside the supported YAML subset and was skipped (line number only) |
| `NAME_DERIVED_FROM_PATH` | a skill / agent frontmatter lacks `name`; the name was derived from the location |
| `HOOK_EVENT_UNMAPPED` | the harness event name is kept as-is; the spec defines no mapping onto the five hub hook points (one per event) |
| `HOOK_ENTRY_SKIPPED` | a hook entry was skipped (non-command type or malformed; position and type name only) |
| `HOOK_COMMAND_PATH` | the hook command's program is an absolute path, reduced to its basename |
| `HOOK_ARG_REDACTED` | a hook command word matched a redaction rule (Bearer, endpoint, absolute path, `--x=y`) |
| `HOOK_ENTRY_DROPPED_ON_EXPORT` | Cursor only: the original hooks file is not in the export table, so entries skipped at import cannot be preserved verbatim |
| `SKILL_SHADOWED` | a skill is shadowed by the same-layer alias location (Gemini's `.agents/skills/` beats `.gemini/skills/`); only the loaded one is imported |
| `CONFIG_EXTRA_KEYS` | top-level keys outside the governed sections of a config file; dropped on export |
| `CONFIG_JSON_INVALID` | not valid JSON / top level is not an object / a section has the wrong shape |
| `EMPTY_CONFIG` | the config file is empty, or the governed section is absent / empty (a shared settings file is flagged only for sections present but empty) |
| `TOML_COMMENT_DROPPED` | TOML comments cannot survive the manifest round trip (line numbers only) |
| `TOML_LINE_SKIPPED` | a TOML line is outside the supported subset and was skipped (line number only) |
| `PROVIDER_VALUES_STRIPPED` | values stay out of the manifest (key names preserved); lists the stripped key names |
| `PROVIDER_CWD_DROPPED` | `cwd` is a machine-local directory, kept out of manifests and never exported |
| `PROVIDER_ENTRY_INVALID` | a contradictory entry (command and url together, Claude url without type, local/remote missing a required key); skipped entirely |
| `PROVIDER_COMMAND_ABSOLUTE` | the command is an absolute path; reduced to its basename at export |
| `PROVIDER_ARG_REDACTED` | an args / command-array word matched a redaction rule |
| `PROVIDER_TRANSPORT_UNKNOWN` | the transport matches neither hub value (sse / ws / Cursor's url etc.); left empty |
| `PROVIDER_SHAPE_UNKNOWN` | the entry has neither command nor url (or no type for OpenCode); transport left empty |
| `SECRET_PLACEHOLDER` | export wrote stripped values as `[redacted]` placeholders; lists the key names to refill before use |
| `SOURCE_FILE_MISSING` | the file / config entry a manifest points at is not in the export file table |
| `CANONICAL_NORMALIZATION` | valid JSON but not in canonical form; export rewrites it in canonical form, not byte-identical |
| `UNRECOGNIZED_FILE` | matches no primitive location of the harness; not imported |
| `CROSS_HARNESS_EXPORT` | the manifest's sourceHarness differs from the export target; skipped |
| `NO_HARNESS_PROJECTION` | the primitive has no file projection in this harness (e.g. hooks in OpenCode, commands in Cursor) |
| `PERMISSION_NOT_EXPRESSIBLE` | a permission-export cell that cannot be expressed: the detail names harness, role, tool, cell and reason (file content unchanged, the cell stays unwritten) |
| `MANIFEST_INVALID` | the manifest fails the neutral schema (export-boundary validation) |

## Coverage matrix

Project-level locations (user-level `~/...` files never enter the virtual file table and are never imported). "✓" = import and export both supported, "—" = not done (reason in the notes).

| Primitive | Claude Code | Codex | OpenCode | Gemini CLI | Cursor |
|---|---|---|---|---|---|
| Skill | `.claude/skills/**/SKILL.md` | `.agents/skills/**/SKILL.md` | `.opencode/skills/`: `SKILL.md` at any depth, or `<id>.md` at the root; compat `.claude/skills/`, `.agents/skills/` | `.gemini/skills/<name>/SKILL.md`, `.agents/skills/<name>/SKILL.md` (alias wins, the shadowed one gets `SKILL_SHADOWED`) | `.cursor/skills/**/SKILL.md`, `.agents/skills/**/SKILL.md`, `.claude/skills/**/SKILL.md`, `.codex/skills/**/SKILL.md` |
| Command | `.claude/commands/**.md` (`dir:name` names) | — (`~/.codex/prompts` not done) | `.opencode/commands/**.md` (incl. legacy `command/`; names keep `/`), plus `commands.<name>` in the config file (template stays in the file bytes) | `.gemini/commands/**.toml` (`dir:name` names) | — (no documented user/workspace command directory) |
| Agent | `.claude/agents/**.md` | — (`.codex/agents/*.toml` not done) | `.opencode/agents/**.md` (nesting counts into the id) | `.gemini/agents/*.md` | `.cursor/agents/*.md` |
| Instruction | `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `.claude/rules/**.md` (`paths`→applies) | `AGENTS.md`, `AGENTS.override.md` | `AGENTS.md` | `GEMINI.md` | `AGENTS.md`, `.cursor/rules/*.mdc` (`globs`→applies) |
| Hook | `.claude/settings.json`, `.claude/settings.local.json` | `.codex/hooks.json` | — (no standalone file; plugins register hooks in code, not imported) | `.gemini/settings.json` | `.cursor/hooks.json` (skipped entries are preserved verbatim at export) |
| MCP server | `mcpServers` in `.mcp.json` | `mcp_servers` in `.codex/config.toml` | `mcp.servers` in `opencode.json(c)` (project root and `.opencode/` only) | `mcpServers` in `.gemini/settings.json` | `mcpServers` in `.cursor/mcp.json` |
| Permission policy | `.claude/settings.<role>.json` | `.codex/permissions.<role>.toml` | `opencode.permissions.<role>.json` | `.gemini/policies/hub.<role>.toml` | `.cursor/permissions.<role>.json` (allowlist only, ask by omission) |

Transport mapping: `command` (`type: local` for OpenCode) → `stdio`; Claude `type: http`/`streamable-http`, Codex url-only, OpenCode `type: remote`, Gemini `httpUrl` → `streamable-http`; Claude's sse/ws, Gemini's `url` (SSE), Cursor's `url` (documented as HTTP or SSE, not pinned down) → transport left empty with a warning.

### Explicitly not done, per harness

- Codex: `.codex/agents/*.toml`, `~/.codex/prompts` (deprecated custom prompts).
- OpenCode: hooks (no standalone file, registered in plugin code; exporting hub-hook/1 reports `NO_HARNESS_PROJECTION`). Compat directories `.claude/skills` and `.agents/skills` are imported (the same directory being imported by several adapters is normal — `sourceHarness` differs, no deduplication).
- Gemini: alias instruction files pointed at by `settings.json`'s `context.fileName` are not resolved — only `GEMINI.md`; a YAML list of multiple remote agents in one file is beyond the frontmatter subset.
- Cursor: commands (no documented directory); agent compat directories `.claude/agents`, `.codex/agents` are not imported (they belong to their own harnesses' adapters; skill compat directories are imported, see the matrix).

## CLI

A minimal command line (local inspection only; no hub, no network):

```sh
node packages/harness-adapters/cli.ts import <dir> --from <harness>
node packages/harness-adapters/cli.ts export <manifests.json> --to <harness> [--dir <dir>]
```

`import` reads a real directory into the virtual file table (UTF-8-clean files become strings, anything else stays bytes) and prints `{ manifests, warnings }` as JSON on stdout. `export` reads a manifests JSON file, takes the original file table from `--dir` (markdown bodies, skill siblings and config regeneration all need it), and prints `{ files, warnings }` — file values are strings, binary ones `{ "base64": ... }`. Usage errors exit 1 with a single stderr line.

## Permission export

Specification: `docs/design/permission-export.md`. `hub-permission/1` is a neutral JSON computed from the scope's role presets and the Tool annotations — **it stores inputs, never dispositions**; adapters only read it, and exporting approves nothing.

```ts
import { disposition, exportPermission, hubPermissionSchema } from './packages/harness-adapters/index.ts';

const d = disposition(policy, 'member', 'case-gateway.dispatch'); // 'allow' | 'ask' | 'deny'
const { files, warnings } = exportPermission('claude-code', policy, 'member'); // one file per role; each inexpressible cell gets a PERMISSION_NOT_EXPRESSIBLE warning
```

The three disposition rules: a role below `minimumRole` → deny (the tool is not in the catalog); otherwise `approval` true → ask (the same person confirms the arguments, not an independent reviewer); otherwise → allow (including `effect: write` with `approval` false). A tool absent from the policy is not in the catalog: deny. `twoPersonRule` / `singleAdminMode` are recorded verbatim and never translated into tool rules.

Where each harness lands them (ask is never written as allow; inexpressible cells stay unwritten):

| harness | file | allow | ask | deny |
|---|---|---|---|---|
| Claude Code | `.claude/settings.<role>.json` | `mcp__hub__<tool>` in `permissions.allow` | `permissions.ask` | `permissions.deny` |
| Codex | `.codex/permissions.<role>.toml` | `enabled_tools` + `approval_mode = "auto"` for read tools; write tools are inexpressible (listed, no approval_mode line) | `approval_mode = "prompt"` | `disabled_tools` |
| OpenCode | `opencode.permissions.<role>.json` | `effect: "allow"` in `permissions[]`, action name `hub_<tool>` (`.`/`-` → `_`) | `effect: "ask"` | `effect: "deny"` |
| Gemini CLI | `.gemini/policies/hub.<role>.toml` | `[[rule]]` `decision = "allow"`, `priority = 100` | `decision = "ask_user"` (effectively deny non-interactively — flagged per tool) | `decision = "deny"` |
| Cursor | `.cursor/permissions.<role>.json` | `hub:<tool>` in `mcpAllowlist` | omitted from the list (re-asked only in Allowlist run mode) | inexpressible (no deny list) |

These paths are not auto-loaded locations for the products: one file per role, picked up by the operator (Gemini's must be copied to `~/.gemini/policies/`). Session baselines (`defaultMode`, `sandbox_mode`, `defaultApprovalMode`, Run Mode, etc.) are never exported.

## Tests

`npm run test:methods` covers all five harnesses: round trips (byte-identical when the manifest is unchanged / edits reflected when it changed), missing fields, multiple hooks, both stdio and http MCP servers, broken frontmatter / JSON / TOML, empty directories, and sanitization (including endpoints and paths embedded in the middle of long strings, and warning details carrying no values). Synthetic fixtures live in `tests/fixtures/harness/`.
