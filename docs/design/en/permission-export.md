# Permission policy export

This is item 4 of harness neutrality. Permission policy is not a second editable Asset. `hub-permission/1` is the neutral JSON computed from the role presets on a scope and from Tool annotations. An adapter only reads it and writes one harness's configuration. Changing a role or an annotation produces a new export. The export approves nothing.

Runtime permission stays the first step of the Enforcement chain: whether this identity may execute in this scope. allow / ask / deny in a harness is the same person allowing, asking again, or refusing inside a local session. It is not an Independent reviewer, not a Change set, and not a Binding. A Record does not say hub approved.

## Inputs

| Input | Source | Use |
|---|---|---|
| Role | Presets on a scope: administrator, member, guest | Who can see this Tool |
| `twoPersonRule` · `singleAdminMode` | Scope policy | Recorded only. Not translated into a tool rule |
| Tool annotations | `effect` (read / write), `minimumRole`, `approval` on the provider's provides | Compute allow / ask / deny |

Role order: guest < member < administrator. `minimumRole` is the lowest role that can see the Tool.

For a caller role R and a Tool T:

1. R is below `minimumRole` → deny. The catalog does not offer the Tool.
2. Otherwise `approval` is true → ask. A harness with no card must make the operator confirm these parameters. That is still the same person, not an Independent reviewer.
3. Otherwise → allow. `effect: write` with `approval` false is also allow: a person already decided who may use it, in the Change set. A run does not approve again.

A service client has only a scope string and no role. It is not in this export.

## hub-permission/1

| Field | Values | Meaning |
|---|---|---|
| `schema` | `hub-permission/1` | Fixed |
| `scopeId` | `scp_` prefix | Which scope |
| `twoPersonRule` | boolean | Copied from the scope policy. An adapter must not turn it into a tool rule |
| `singleAdminMode` | boolean | Same |
| `roleOrder` | `guest` · `member` · `administrator` | The order above |
| `tools[].name` | `<provider>.<tool>` | Same name as the MCP tool |
| `tools[].effect` | `read` · `write` | Hub annotation |
| `tools[].minimumRole` | `guest` · `member` · `administrator` | Hub annotation |
| `tools[].approval` | boolean | When true, parameters must be confirmed |

Disposition is not stored. allow / ask / deny for each role is computed by the three rules above, so it cannot drift from the presets.

Example scope `scp_example`, `twoPersonRule` on, not single-administrator. Three synthetic Tools:

```json
{
  "schema": "hub-permission/1",
  "scopeId": "scp_example",
  "twoPersonRule": true,
  "singleAdminMode": false,
  "roleOrder": ["guest", "member", "administrator"],
  "tools": [
    {
      "name": "documents.search",
      "effect": "read",
      "minimumRole": "guest",
      "approval": false
    },
    {
      "name": "buildsite.command_check",
      "effect": "read",
      "minimumRole": "member",
      "approval": false
    },
    {
      "name": "case-gateway.dispatch",
      "effect": "write",
      "minimumRole": "member",
      "approval": true
    }
  ]
}
```

Computed disposition:

| Tool | Guest | Member | Administrator |
|---|---|---|---|
| `documents.search` | allow | allow | allow |
| `buildsite.command_check` | deny | allow | allow |
| `case-gateway.dispatch` | deny | ask | ask |

Every harness below uses this one policy. One configuration file carries one role. These products' project files are one policy for everyone in the folder. They have no per-scope role field.

## Cannot be expressed, in every harness

| Hub rule | Why |
|---|---|
| Two-person rule, a sole administrator's own decision, who needs approval | Eligibility on a Change set, not a pass/fail on one tool call |
| Binding, Independent reviewer | A harness prompt asks the same person |
| targets / readers | Visibility is computed in the hub catalog, not in a local permission file |
| Enforcement chain, Error codes, `executionIsChange` | Verification is a Hook and a Platform invariant. This export does not restate the chain |
| A service client's scope string | The file describes the operator, not a machine identity |

A call the Enforcement chain must reject is not allowed because a harness file allowed it. hub still runs permission, Binding, Verification, lease, and audit on the call.

## Circle

Circle does not write a second permission file. The catalog is computed for the current identity (provider running, role ≥ `minimumRole`, readers allow). A Tool with `approval` true uses a card. A local permission prompt, if one still appears, only repeats the confirmation for the same identity. It does not add a Decision.

## Claude Code

Read on 2026-10-13:

- [Configure permissions](https://code.claude.com/docs/en/permissions): `permissions.allow` / `ask` / `deny`. A rule is `Tool` or `Tool(specifier)`. Evaluation order is deny, then ask, then allow. A broad deny is not opened by a narrower allow.
- [Hooks reference](https://code.claude.com/docs/en/hooks): an MCP tool name is `mcp__<server>__<tool>`. `PreToolUse` may return `permissionDecision: "deny"`. The permission evaluation described with that hook: a hook allow does not skip deny and ask.
- [Settings reference](https://code.claude.com/docs/en/settings-reference) and the permissions page: when settings load, an `mcp__` rule that contains parentheses is skipped.

| Hub | Lands on | How to write it |
|---|---|---|
| allow | `permissions.allow` | `mcp__hub__<tool>` with no parentheses |
| ask | `permissions.ask` | Same |
| deny | `permissions.deny` | Same. A bare tool name is removed from context |
| `effect` | Cannot be expressed | allow / ask / deny do not distinguish read from write. Do not rewrite write as a Bash or file rule |
| Role, scope | Cannot be expressed | One `settings.json` applies to everyone. One file per role, chosen by the operator. Do not pack three roles into one file |
| Parameter confirmation | Cannot be expressed | `ask` confirms this tool call, not a Binding. Do not write a PreToolUse hook as a stand-in for the Enforcement chain |

`defaultMode`, `bypassPermissions`, and `auto` are not exported. They are a session baseline, not a role.

Member:

```json
{
  "permissions": {
    "allow": [
      "mcp__hub__documents.search",
      "mcp__hub__buildsite.command_check"
    ],
    "ask": ["mcp__hub__case-gateway.dispatch"],
    "deny": []
  }
}
```

A guest puts the last two names in `deny` and leaves only `mcp__hub__documents.search` in `allow`. An administrator matches the member: the Tool with `approval` true stays ask.

The `.` in a tool name stays in the `mcp__` rule. The permissions page does not say whether a dot is legal. When the adapter is delivered, check with that page's doctor. If it does not match, leave the Tool as cannot be expressed. Do not rename it and pretend it is the same Tool.

## Codex CLI

Read on 2026-10-13:

- [Agent approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security): `sandbox_mode` is `read-only`, `workspace-write`, or `danger-full-access`. `approval_policy` uses `on-request` or `never`. `untrusted` is no longer accepted. `workspace-write` has no network unless `[sandbox_workspace_write] network_access` is set.
- [Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference): `approval_policy` may also be a `granular` table. `mcp_servers.<id>.enabled_tools` is an allow list. `disabled_tools` is a deny list applied after it. `default_tools_approval_mode` and `tools.<tool>.approval_mode` take `auto`, `prompt`, `writes`, or `approve`.
- [MCP](https://learn.chatgpt.com/docs/extend/mcp): only `writes` is defined. It prompts for tools that are not marked read-only. `auto`, `prompt`, and `approve` have no behavior defined on that page.

| Hub | Lands on | How to write it |
|---|---|---|
| deny | `disabled_tools` | The tool name. Do not also put it in `enabled_tools` |
| ask | `tools.<tool>.approval_mode = "prompt"` | The value is listed. That page does not define how prompt behaves; it only defines writes. Check the page again when the adapter is delivered |
| allow and `effect: read` | `approval_mode = "auto"` | Same: auto is undefined. Do not write read as `sandbox_mode = "read-only"` |
| allow and `effect: write` | Cannot be expressed | `writes` prompts for a tool that is not marked read-only. That is an extra prompt, not the Enforcement chain. No defined value means "allow a write and do not ask the operator again" |
| `sandbox_mode` · `approval_policy` | Cannot be expressed | They govern the local command sandbox and when a command pauses. They are not a Tool's effect or a role |
| Endpoint, credential | Not written | Those belong to hub-provider/1, not to this export |

The examples contain only tool policy. No url, command, or token.

Member and administrator (`auto` is not used for `case-gateway.dispatch`; see the table):

```toml
[mcp_servers.hub]
enabled_tools = [
  "documents.search",
  "buildsite.command_check",
  "case-gateway.dispatch",
]
disabled_tools = []

[mcp_servers.hub.tools."documents.search"]
approval_mode = "auto"

[mcp_servers.hub.tools."buildsite.command_check"]
approval_mode = "auto"

[mcp_servers.hub.tools."case-gateway.dispatch"]
approval_mode = "prompt"
```

Guest:

```toml
[mcp_servers.hub]
enabled_tools = ["documents.search"]
disabled_tools = ["buildsite.command_check", "case-gateway.dispatch"]

[mcp_servers.hub.tools."documents.search"]
approval_mode = "auto"
```

`case-gateway.dispatch` is not marked as a proven allow for member or guest. A member uses prompt because `approval` is true. The `effect: write` half of that Tool still cannot be expressed.

## OpenCode

Read on 2026-10-13. [Permissions (v2)](https://opencode.ai/v2/docs/permissions) is the current page. Rules sit in the `permissions` array. Each rule has `action`, `resource`, and `effect` (`allow` / `deny` / `ask`). The last match wins. No match means ask. An MCP action is `<server>_<tool>`. Unsupported characters in either name become `_`. The page does not list which characters are unsupported.

The [v1 page](https://opencode.ai/docs/permissions) still describes a `permission` object whose keys are built-in tool names (read, edit, bash, and so on). It has no MCP tool key. v1 cannot express a hub Tool. The export writes v2 only.

| Hub | Lands on | How to write it |
|---|---|---|
| allow / ask / deny | `effect` | One rule, `resource` `*` |
| Tool name | `action` | `hub_documents_search`, `hub_buildsite_command_check`, `hub_case_gateway_dispatch`. `.` and `-` are replaced under "unsupported characters become `_`". On delivery, compare with the action OpenCode actually registers. If they differ, that Tool cannot be expressed |
| Role | Cannot be expressed | A global array plus an agent array. No scope role. One file, one role |
| `effect: read/write` | Cannot be expressed | v2's effect is allow / deny / ask, not read or write |

The default policy includes `{ "action": "*", "resource": "*", "effect": "allow" }`. A later rule overrides it, so deny and ask must be written. Omitting them does not deny.

Member and administrator:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permissions": [
    { "action": "hub_documents_search", "resource": "*", "effect": "allow" },
    { "action": "hub_buildsite_command_check", "resource": "*", "effect": "allow" },
    { "action": "hub_case_gateway_dispatch", "resource": "*", "effect": "ask" }
  ]
}
```

A guest sets `effect` on the last two rules to `deny`.

## Gemini CLI

Read on 2026-10-13:

- [Policy engine](https://geminicli.com/docs/reference/policy-engine) (footer says Apr 30, 2026): a `[[rule]]` has `toolName`, `decision` (`allow` / `deny` / `ask_user`), `priority`, and optional `mcpName`. The highest priority wins. In a non-interactive run, `ask_user` is treated as deny. The workspace tier is marked disabled. User policy is `~/.gemini/policies/*.toml`.
- The top of that page: since 2026-06-18, Gemini CLI for unpaid and Google One users has been replaced by Antigravity CLI. The text below describes only the Gemini CLI policy engine that page still documents. It does not describe Antigravity.
- [Configuration](https://geminicli.com/docs/reference/configuration): `general.defaultApprovalMode` is `default`, `auto_edit`, or `plan`. `yolo` can be turned on only from the command line. That is a session baseline and is not exported.

| Hub | Lands on | How to write it |
|---|---|---|
| allow | `decision = "allow"` | `mcpName = "hub"`, `toolName` is the hub name |
| ask | `decision = "ask_user"` | Only an interactive session asks again. Non-interactive becomes deny, and the export note must say so |
| deny | `decision = "deny"` | User-tier priority 100, above the built-in defaults |
| Role, shipping with a repository | Cannot be expressed | The workspace tier is disabled. One user file, one role |
| `effect` | Cannot be expressed | decision has no read / write |

Member and administrator:

```toml
[[rule]]
mcpName = "hub"
toolName = "documents.search"
decision = "allow"
priority = 100

[[rule]]
mcpName = "hub"
toolName = "buildsite.command_check"
decision = "allow"
priority = 100

[[rule]]
mcpName = "hub"
toolName = "case-gateway.dispatch"
decision = "ask_user"
priority = 100
```

A guest sets `decision` on the last two rules to `deny`.

## Cursor

Read on 2026-10-13:

- [permissions.json](https://cursor.com/docs/reference/permissions): `mcpAllowlist` is a list of `server:tool` strings. There is no deny list. An MCP tool left off the list is not refused because of that. `autoRun` only steers the classifier in Auto-review. The page says it is not enforcement.
- [Run Modes](https://cursor.com/docs/agent/security/run-modes): in Allowlist mode, listed calls run and the rest ask. Run Mode is a setting, not a field of `permissions.json`. The same page says that Auto-review is not a security boundary; it makes no such statement about Allowlist mode.

| Hub | Lands on | How to write it |
|---|---|---|
| allow | `mcpAllowlist` | `hub:<tool>`, for example `hub:documents.search` |
| ask | Leave it off the list | Only when Run Mode is Allowlist: a missing entry asks. Auto-review sends the rest to a classifier, which is not ask |
| deny | Cannot be expressed | There is no deny list. Omitting a tool asks, or hands it to the classifier. It does not remove the tool from the catalog |
| Role | Cannot be expressed | The user file and the repository file concatenate arrays. They do not switch by role |
| `effect` · sandbox | Cannot be expressed | `sandbox.json` governs local read, write, and network. It is not a hub Tool |

Member and administrator (Allowlist mode; ask is the omission):

```json
{
  "mcpAllowlist": [
    "hub:documents.search",
    "hub:buildsite.command_check"
  ]
}
```

A guest can only write:

```json
{
  "mcpAllowlist": ["hub:documents.search"]
}
```

`buildsite.command_check` and `case-gateway.dispatch` are then not auto-run, and they are not denied. For a guest those two Tools cannot be expressed.

## Check when an adapter is delivered

1. The exported disposition matches the three rows above. Do not turn ask into allow to avoid a prompt.
2. A cell that cannot be expressed stays unwritten. Do not add a nearby switch as a substitute.
3. The synthetic acceptance checks file shape and rule count. It does not connect to a real harness and does not call a paid model.
