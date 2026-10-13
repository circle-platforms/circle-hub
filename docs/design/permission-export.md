# 权限策略导出

这是 harness 中立的第 4 条。Permission policy 不另建一份可编辑的资产：`hub-permission/1` 是从范围上的角色预设和 Tool 标注算出来的中立 JSON，适配器只读它，再写成某个 harness 的配置。改角色或改标注会得到新的导出；导出本身不批准任何东西。

运行时的权限仍是执行链的第一步（这个身份在这个范围能不能执行），不是这里的文件。harness 里的 allow / ask / deny 是同一个人在本机会话里的放行、再问或拒绝。它不是独立审批人，不是变更集，也不是绑定三项。记录里不写 hub approved。

## 输入

| 输入 | 从哪来 | 用什么 |
|---|---|---|
| 角色 | 范围上的预设：管理员、成员、访客 | 谁看得到这件 Tool |
| `twoPersonRule` · `singleAdminMode` | 范围策略 | 只记录，不翻译成工具规则 |
| Tool 标注 | provider 的 provides：`effect`（read / write）、`minimumRole`、`approval` | 算出 allow / ask / deny |

角色序：访客 < 成员 < 管理员。`minimumRole` 是能看见该 Tool 的最低角色。

对一个调用者角色 R、一件 Tool T：

1. R 低于 `minimumRole` → deny。目录里不给这件 Tool。
2. 否则 `approval` 为真 → ask。没有卡片界面的 harness 必须让操作者确认这次参数；这仍是同一个人，不是独立审批人。
3. 否则 → allow。`effect: write` 且 `approval` 为假也是 allow：人在变更集里已经决定过谁能用它，运行不再审批。

服务客户端只有 scope 串，没有角色，不进入这份导出。

## hub-permission/1

| 字段 | 取值 | 含义 |
|---|---|---|
| `schema` | `hub-permission/1` | 固定 |
| `scopeId` | `scp_` 前缀 | 哪个范围 |
| `twoPersonRule` | 布尔 | 原样抄范围策略。适配器不得把它写成工具规则 |
| `singleAdminMode` | 布尔 | 同上 |
| `roleOrder` | `guest` · `member` · `administrator` | 上面的序 |
| `tools[].name` | `<provider>.<tool>` | 与 MCP tool 名相同 |
| `tools[].effect` | `read` · `write` | hub 标注 |
| `tools[].minimumRole` | `guest` · `member` · `administrator` | hub 标注 |
| `tools[].approval` | 布尔 | 为真时要确认参数 |

不存 disposition。各角色的 allow / ask / deny 由上面三条规则算出，避免和角色预设分叉。

示例范围 `scp_example`，`twoPersonRule` 开，不是单管理员。三件合成 Tool：

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

算出的处置：

| Tool | 访客 | 成员 | 管理员 |
|---|---|---|---|
| `documents.search` | allow | allow | allow |
| `buildsite.command_check` | deny | allow | allow |
| `case-gateway.dispatch` | deny | ask | ask |

下面每个 harness 用这一份。一个配置文件只装一个角色：这些产品的项目配置是全员一份，没有「按范围的角色」这一格。

## 一律表达不了

| hub 的规则 | 原因 |
|---|---|
| 两人规则、单管理员自决、谁需要审批 | 那是变更集的审批资格，不是一次工具调用的放行 |
| 绑定三项、独立审批人 | harness 的再问是同一个人 |
| targets / readers | 可见范围在 hub 目录里算，不在本地许可文件 |
| 执行链、错误码、`executionIsChange` | 核验是 Hook 与平台约束；权限导出不重写执行链 |
| 服务客户端的 scope 串 | 配置文件描述的是操作者，不是机器身份 |

执行链该拒绝的调用，在 harness 里放行也不等于平台放行。hub 仍在调用时做权限、绑定、核验、租约、审计。

## Circle

Circle 不另写许可文件。目录按当前身份计算（provider 在 running、角色 ≥ `minimumRole`、readers 允许）。`approval` 为真的 Tool 走卡片。本地许可提示如果还在，只是同一身份的重复确认，不增加决定。

## Claude Code

查阅 2026-10-13：

- [Configure permissions](https://code.claude.com/docs/en/permissions)：`permissions.allow` / `ask` / `deny`。规则形如 `Tool` 或 `Tool(specifier)`。评估序是 deny，然后 ask，然后 allow；宽的 deny 不能被窄的 allow 挖开。
- [Hooks reference](https://code.claude.com/docs/en/hooks)：MCP 工具名是 `mcp__<server>__<tool>`。`PreToolUse` 可以返回 `permissionDecision: "deny"`。同页的权限评估说明：hook 返回 allow 不会跳过 deny 和 ask。
- [Settings reference](https://code.claude.com/docs/en/settings-reference) 与权限页：载入 settings 时，带括号的 `mcp__` 规则会被跳过。

| hub | 落到 | 怎么写 |
|---|---|---|
| allow | `permissions.allow` | 无括号的 `mcp__hub__<tool>` |
| ask | `permissions.ask` | 同上 |
| deny | `permissions.deny` | 同上。光着的工具名会从上下文去掉 |
| `effect` | 表达不了 | allow / ask / deny 不区分 read 与 write。不把 write 改写成 Bash 或文件规则 |
| 角色、范围 | 表达不了 | 一份 `settings.json` 全员共用。按角色分文件，由操作者选用，不把三份塞进一个文件 |
| 参数级确认 | 表达不了 | `ask` 确认的是这次工具调用，不是绑定三项。不写 PreToolUse 冒充执行链 |

`defaultMode`、`bypassPermissions`、`auto` 不导出。它们是会话基线，不是角色。

成员：

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

访客把后两件放进 `deny`，`allow` 只留 `mcp__hub__documents.search`。管理员与成员相同：`approval` 为真的那件仍是 ask。

工具名里的 `.` 按原样留在 `mcp__` 规则中。权限页没有说点号是否合法；交付适配器时用该页的 doctor 核对。对不上就保持表达不了，不改名假装等价。

## Codex CLI

查阅 2026-10-13：

- [Agent approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security)：`sandbox_mode` 为 `read-only`、`workspace-write` 或 `danger-full-access`。`approval_policy` 用 `on-request` 或 `never`。`untrusted` 已不能用。`workspace-write` 默认没有网络，除非 `[sandbox_workspace_write] network_access`。
- [Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)：`approval_policy` 还可写成 `granular` 表。`mcp_servers.<id>.enabled_tools` 是允许名单，`disabled_tools` 在其后做拒绝名单。`default_tools_approval_mode` 与 `tools.<tool>.approval_mode` 的取值是 `auto`、`prompt`、`writes`、`approve`。
- [MCP](https://learn.chatgpt.com/docs/extend/mcp)：只定义了 `writes`：未标成只读的工具要提示。`auto`、`prompt`、`approve` 在该页没有行为定义。

| hub | 落到 | 怎么写 |
|---|---|---|
| deny | `disabled_tools` | 工具名。同时不要放进 `enabled_tools` |
| ask | `tools.<tool>.approval_mode = "prompt"` | 取值在参考页列出。该页没有定义 prompt 的行为，只定义了 writes。交付前再对一次当时的页 |
| allow 且 `effect: read` | `approval_mode = "auto"` | 同上：auto 未定义。不把 read 写成 `sandbox_mode = "read-only"` |
| allow 且 `effect: write` | 表达不了 | `writes` 会提示未标只读的工具，那是多出来的再问，不是执行链。没有「允许写、且不再向操作者确认」的已定义档 |
| `sandbox_mode` · `approval_policy` | 表达不了 | 两者管本机命令的沙箱和何时为命令停下来，不是 hub Tool 的 effect 或角色 |
| 端点、凭据 | 不写 | 属于 hub-provider/1，不进权限导出 |

示例只写工具策略，不写 url、命令或令牌。

成员与管理员（`case-gateway.dispatch` 的 `auto` 不使用，见上表）：

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

访客：

```toml
[mcp_servers.hub]
enabled_tools = ["documents.search"]
disabled_tools = ["buildsite.command_check", "case-gateway.dispatch"]

[mcp_servers.hub.tools."documents.search"]
approval_mode = "auto"
```

`case-gateway.dispatch` 在成员和访客两份里都不标成已证实的 allow。成员用 prompt，因为 `approval` 为真；它的 `effect: write` 那一半仍然表达不了。

## OpenCode

查阅 2026-10-13。[Permissions（v2）](https://opencode.ai/v2/docs/permissions) 是当前页。规则在 `permissions` 数组里，每条 `action`、`resource`、`effect`（`allow` / `deny` / `ask`）。后匹配的赢；没有规则则 ask。MCP 的 action 是 `<server>_<tool>`，两边名字里不支持的字符变成 `_`。该页没有列出哪些字符不支持。

[v1 页](https://opencode.ai/docs/permissions) 仍描述 `permission` 对象，键是内置工具名（read、edit、bash 等），没有 MCP 工具键。v1 表达不了 hub Tool。导出只写 v2。

| hub | 落到 | 怎么写 |
|---|---|---|
| allow / ask / deny | `effect` | 一条规则，`resource` 为 `*` |
| 工具名 | `action` | `hub_documents_search`、`hub_buildsite_command_check`、`hub_case_gateway_dispatch`。`.` 和 `-` 按「不支持的字符变成 `_`」替换；交付时和 OpenCode 实际注册的 action 核对，对不上则这件 Tool 表达不了 |
| 角色 | 表达不了 | 全局数组加 agent 数组，没有范围角色。一个文件一个角色 |
| `effect: read/write` | 表达不了 | v2 的 effect 是 allow / deny / ask，不是读写 |

默认策略里有 `{ "action": "*", "resource": "*", "effect": "allow" }`。后写的规则盖过它，所以 deny 和 ask 必须写出来，不能靠省略。

成员与管理员：

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

访客把后两条的 `effect` 写成 `deny`。

## Gemini CLI

查阅 2026-10-13：

- [Policy engine](https://geminicli.com/docs/reference/policy-engine)（页脚写 Apr 30, 2026）：`[[rule]]` 有 `toolName`、`decision`（`allow` / `deny` / `ask_user`）、`priority`、可选 `mcpName`。优先级高的赢。非交互时 `ask_user` 当成 deny。工作区策略层标成停用，用户策略在 `~/.gemini/policies/*.toml`。
- 同页页首：2026-06-18 起，未付费与 Google One 用户的 Gemini CLI 已换为 Antigravity CLI。下面只描述该政策引擎页还写着的 Gemini CLI，不描述 Antigravity。
- [Configuration](https://geminicli.com/docs/reference/configuration)：`general.defaultApprovalMode` 为 `default`、`auto_edit`、`plan`。`yolo` 只能由命令行打开。这是会话基线，不导出。

| hub | 落到 | 怎么写 |
|---|---|---|
| allow | `decision = "allow"` | `mcpName = "hub"`，`toolName` 用 hub 原名 |
| ask | `decision = "ask_user"` | 交互会话才是再问；非交互变成 deny，必须在导出说明里写明 |
| deny | `decision = "deny"` | 用户层 priority 100，压过内置默认 |
| 角色、随仓库分发 | 表达不了 | 工作区层停用。一个用户文件一个角色 |
| `effect` | 表达不了 | decision 没有 read / write |

成员与管理员：

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

访客把后两件的 `decision` 写成 `deny`。

## Cursor

查阅 2026-10-13：

- [permissions.json](https://cursor.com/docs/reference/permissions)：`mcpAllowlist` 是 `server:tool` 字符串，允许名单。没有 deny 名单。不在名单里的 MCP 工具不会因此被拒绝。`autoRun` 只在 Auto-review 里给分类器提示，文档写明不是强制。
- [Run Modes](https://cursor.com/docs/agent/security/run-modes)：Allowlist 模式下列出的调用直接跑，其余再问。Run Mode 在设置里，不在 `permissions.json`。同页写明的是 Auto-review 不是安全边界，对 Allowlist 模式没有这样的说明。

| hub | 落到 | 怎么写 |
|---|---|---|
| allow | `mcpAllowlist` | `hub:<tool>`，例如 `hub:documents.search` |
| ask | 不写入名单 | 仅当 Run Mode 是 Allowlist：不在名单里会再问。Auto-review 会把其余调用交给分类器，不是 ask |
| deny | 表达不了 | 没有拒绝名单。省略是再问或交给分类器，不是目录里不给 |
| 角色 | 表达不了 | 用户文件与仓库文件把数组合并，不是按角色替换 |
| `effect` · 沙箱 | 表达不了 | `sandbox.json` 管本机读写和网络，不是 hub Tool |

成员与管理员（Allowlist 模式；ask 靠省略）：

```json
{
  "mcpAllowlist": [
    "hub:documents.search",
    "hub:buildsite.command_check"
  ]
}
```

访客只能写出：

```json
{
  "mcpAllowlist": ["hub:documents.search"]
}
```

`buildsite.command_check` 与 `case-gateway.dispatch` 因此不会被自动放行，但也不会被拒绝。这两件对访客是表达不了。

## 适配器交付时核对

1. 导出的处置与上表三行一致，不把 ask 写成 allow 来少弹窗。
2. 表达不了的格子保持不写，不另造近似开关。
3. 合成验收只检查文件形状和规则条数，不连接真实 harness，不调用付费模型。

---

本文是 circle-hub 的设计规范之一，按 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.zh-hans) 授权：引用、借鉴须署名 Circle Hub 与 qingshanfeihu 并注明原始出处链接。见[设计规范索引](README.md#许可)。
