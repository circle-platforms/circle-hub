# Harness primitive specification

hub is the hub of harnesses, and it is a public general platform: what it governs are the primitives that **any harness** has, not only Circle's. Circle is the first harness, and the one integrated most deeply; skills, hooks, agents, and commands written by harnesses such as Claude Code, Codex, OpenCode, and Pi must likewise be registrable in hub, independently approved, and then installed into any harness. If that cannot be done, hub is only Circle's private backend.

The specification therefore has three layers: the **neutral list** (what hub stores), the **adapter** (how each harness imports and exports), and the **generic transport** (MCP, so any harness can use hub without installing an adapter).

## 1. Which primitives are governed

Things that actually exist in a harness split into what hub governs and what it does not. Governed = shared + versioned + independently approved + Evidence.

| Primitive | What it is | Governed or not | Which object it lands in |
|---|---|---|---|
| **Skill** | a directory: a markdown entry (frontmatter name / description) + scripts + references + tests; the model selects it automatically from the description, or calls it by name | governed | E |
| **Tool** | a capability the model can call: name · description · inputSchema · annotations (the MCP tool shape) | governed (with the provider) | B (read-only) / D (acts) |
| **MCP server** | a server that provides tools / resources / prompts | governed (provider Asset) | B / D |
| **Hook** | a deterministic check around a tool call or a session event: event name + JSON in + JSON out (allow / block + a reason) | governed | E (the handler) · acts on D's Enforcement chain |
| **Instruction** | a project-level instruction file: AGENTS.md / CLAUDE.md / rules and the like, long-term rules for the model | governed | E (versioned rule text; distributed by scope) |
| **Agent** | a sub-agent definition: markdown + frontmatter (name, description, tool allowlist, model) | governed | E (the same registration, trial run, and approval as Skill) |
| **Command** | a reusable prompt / slash command: markdown + parameters | governed | E (a lightweight Skill; the trial run may be omitted) |
| **Bundle / Plugin** | a package of the primitives above (a Claude Code plugin, the content part of a Circle extension) | governed = Change set | across objects; that is, the product-line pack |
| **Permission policy** | which tools are allowed / need confirmation / are refused | governed (data) | C (a projection of role presets + tool minimumRole) |
| Session / transcript | the raw history of a session | not governed | A; knowledge candidates that settle go into B |
| Memory | a harness's personal memory | not governed | A; team knowledge enters B after review |
| Model / provider configuration | which model, and the key | not governed | A; hub's execution with no interface has its own fixed model configuration |
| Workspace / sandbox environment | a local directory, a container, a devcontainer | not governed | A; hub's own execution resources are in D |

The three that are not governed have this in common: they are runtime state on one person's one machine, not facts or methods shared by the team.

## 2. The neutral list: what hub stores

Each governed primitive is an Asset in hub, the bytes frozen and the SHA pinned, plus one **neutral list** (hub's own schema, belonging to no harness):

| Primitive | Asset kind | Neutral list | Bytes |
|---|---|---|---|
| Skill | skill-package | `hub-skill/1`: name, description, version, entry (the entry file), tools (names of tools it may call; may be empty), inputs, outputs, triggers, model, sourceHarness (the harness the author used), knownCompatible (which harnesses it has been verified to install into) | the original directory, as-is |
| Tool | not independent; inside the provider's declaration.provides | MCP tool + hub annotations: effect (read / write), minimumRole, approval | — |
| MCP server | connector-instance (read-only) or connector-instance (execution resource) + runtime-profile | `hub-provider/1`: transport (stdio / streamable-http), provides (tools / resources / prompts), reads, writes, credentials, credentialMode | none (the endpoint and the secret are outside the database) |
| Hook | product-line module | `hub-hook/1`: event (the hook point), order, handler (the entry), language (ts / shell), deterministic: true | the handler script |
| Instruction | instruction | `hub-instruction/1`: scope, applies (a path or a product line), fileName projection name | markdown |
| Agent | agent | `hub-agent/1`: name, description, tools, model, sourceHarness | markdown |
| Command | command | `hub-command/1`: name, description, arguments | markdown |
| Bundle | Change set | `hub-bundle/1`: items (the id + version of each item above) | — |
| Permission policy | scope policy + tool annotations | no separate list is built: it is exported from the role presets and minimumRole | — |

The neutral list holds only the fields harnesses need in common. A field particular to one harness (for example a proprietary key in that one's frontmatter) stays in the bytes as-is, does not enter the neutral list, and is not dropped.

## 3. Adapters: import and export

One adapter per harness, and it does two things: **import** (turn that harness's local primitives into hub Assets + a neutral list) and **export** (install hub Assets into that harness's directory convention).

| Primitive | Circle | Claude Code | Codex | OpenCode / others |
|---|---|---|---|---|
| Skill | `.circle/skills/<name>/SKILL.md`, import and export are both already implemented (push / install) | `.claude/skills/<name>/SKILL.md`; the frontmatter has the same shape, and proprietary keys are kept as-is | per its skill-directory convention | per each one's convention; a harness with no skill mechanism uses an MCP prompt projection |
| Tool | `registerTool` becomes `srv_*` | through hub's MCP endpoint | through hub's MCP endpoint | through hub's MCP endpoint |
| MCP server | hub connects on its behalf, and Circle does not connect directly | same as the left | same as the left | same as the left |
| Hook | the extension's built-in equivalent (the return written to disk, redaction); distributed after Circle adds a hooks mechanism | hooks in settings: event names and JSON in and out are mapped to hub's hook events by its protocol | per its mechanism | a harness without hooks executes only on the hub side |
| Instruction | files such as AGENTS.md, distributed by scope | CLAUDE.md / rules files | AGENTS.md | each one's rules file name |
| Agent | awaiting Circle support | `.claude/agents/<name>.md` | per its mechanism | per each one's convention |
| Command | the `/` command directory | `.claude/commands/<name>.md` | per its mechanism | per each one's convention |
| Permission policy | local permissions + hub roles | permissions allow / deny in settings | per its mechanism | per each one's convention |

A cell in the table that says "per its mechanism" is one whose adapter is not written in this version; until the adapter is written, hub's support for that harness is only the MCP transport layer. When each adapter is delivered it comes with one synthetic acceptance: a Skill written in that harness is imported into hub, approved, then exported to Circle and to the original harness, and both can load it.

## 4. Generic transport: hub itself is an MCP server

A harness that installs no adapter can use hub, as long as it can connect to MCP:

- `/mcp` (streamable HTTP) exposes, for the current identity: **tools** (the tools in the catalog, shape unchanged), **resources** (materials and Evidence: `hub://evidence/<id>`, `hub://source/<id>`, `hub://artifact/<id>`, read-only), **prompts** (MCP prompt projections of Skill and Command, for a harness with no skill mechanism).
- Authentication uses hub's session token; every call leaves Evidence as usual and passes permission; write operations (hand over, push, approval) are tools too, and those marked `approval`, in a harness with no card interface, require the parameters to be confirmed explicitly.
- The Circle extension is the rich client on top of this transport: cards, the queue, the Registry. Other harnesses get the basic capability first, then write an adapter as needed.

## 5. Where the primitives sit in the four objects × five elements

A primitive is not a fifth object, and it is not a sixth element; each primitive lands in some elements of some object:

| Primitive | Object | Record | Asset | Approval policy | Evidence | Extension point |
|---|---|---|---|---|---|---|
| Skill · Agent · Command | E method | `skp_` + trial-run record | skill-package / agent / command | version registration goes through a Change set | trial-run output sha, and each tool call at run time | modules.json in the packs repository |
| Instruction | E method | version | instruction | registration goes through a Change set | the distribution record | distributed by scope |
| Tool | the object the provider is in: B or D | each call `evd_` | the provider declaration's provides | none (minimumRole) | the return is saved as-is | brought in by the MCP server |
| MCP server · read-only | B materials | source revision `src_` | connector-instance + runtime-profile | enabling goes through a Change set | the originals that were read | connector package (by system type) |
| MCP server · execution resource | D execution | operation `op_`, lease, scene | connector-instance + runtime-profile | enabling goes through a Change set; when executionIsChange, the execution submission goes through one too | Verification before dispatch, the scene report | resource adapter (the MCP protocol is the generic adapter), credential mode, profile |
| Hook | E method (the handler) · acts on D | the rule id / version of each judgment | product-line module | loading goes through a Change set | the judgment result and the facts | five fixed hook points |
| Permission policy | C work | policy version | scope policy | Change set | the Decision record | the policy is data |

## 6. Words that have been merged away

| Former wording | Now |
|---|---|
| method module (parser, contract, result interpretation) | a Tool's implementation code or a Hook handler, loaded with the product-line pack |
| rule package, rule module, verification rule | a Hook handler |
| connector package, connector instance, execution resource, gateway | an MCP server (provider Asset); read-only ones are in B, and ones that act are in D |
| tool catalog, srv_* tool, gateway tool | Tool |
| skill package, capability package | Skill |

## 7. The contract of each primitive

### Skill / Agent / Command

- The content format = the format of the harness the author used; hub only freezes the bytes, and does not parse the meaning; the neutral list is derived from the frontmatter and the directory, and a field that cannot be derived is left empty.
- Once `tools` is declared, a tool outside the declaration that appears in the trial-run record is rejected; if `tools` is not declared, the trial-run record is disclosure only.
- Execution: Circle with no interface runs a fixed version, and each tool call goes back to the hub catalog to re-check permission and credentials. A copy exported to another harness carries hub's asset id and sha, so it can be traced.

### Tool

- The shape = an MCP tool: `name` (`<provider>.<tool>`), `description`, `inputSchema`, `annotations` (readOnlyHint and the like).
- hub annotations: `effect`, `minimumRole`, `approval`. Permission follows the tool, and no separate permission Registry is created.
- The catalog is computed by identity: the provider is running, the caller's role ≥ minimumRole, and the source's readers allow it. The return is saved as-is and given an evidenceId; what is sent back to the caller passes through redaction.

### MCP server

- The Asset declaration: `reads`, `writes`, `credentials`, `provides`. The endpoint, the CA, and the timeout are in the out-of-database file referenced by runtime-profile.
- Credential modes: a static key (when there is only one caller), a short-lived token issued by the platform, and external OAuth; written and not read, and injected into the worker at execution.
- A read-only provider is implemented by hub's built-in connector package; a provider that acts is an external MCP server, called by the worker with the MCP protocol; they have the same shape in the catalog.

### Hook

- The hook points are fixed: `verify.deviceCommand`, `verify.hostCommand`, `verify.workbook`, `beforeDispatch`, `afterResult`; events on the client side (PreToolUse / PostToolUse and the like) are mapped by the adapter.
- Input `{event, binding: {method, resource, source, inputRevision}, subject}`; output `{decision: "pass"}` or `{decision: "block", code, facts}`.
- A handler is a script that is 100% provably true: it does not call a model, does not connect to the network, and does not read the environment; it runs in list order; one block stops it. The hub core ships with zero handlers, and it has no default-allow branch and no default-deny branch; the audit records the rule id and the version.

### Instruction

- markdown distributed by scope or by product line; versioned, and approved by a Change set; the adapter projects it onto each harness's file name. It contains no credentials and no addresses.

## 8. Requirements on the current implementation

- `professional_permissions` is removed, and replaced by the tool annotation `minimumRole`.
- `methods` of `product-line/1` becomes `tools` (provider implementations) and `hooks` (handlers and their hook points).
- The gateway's `TOOL_SPECS` and hub's `ToolView` are unified as an MCP tool + hub annotations.
- Skill registration adds the neutral list `hub-skill/1` (derived from the existing skillpack.json), and records sourceHarness and knownCompatible.
- Add hub's MCP endpoint `/mcp` (tools / resources / prompts), as the basic access for every harness; the Circle extension is changed to be built on top of it.
- Add three Asset kinds, Instruction, Agent, and Command, sharing with Skill the registration, the trial run (which may be omitted), and approval.
- Documents and the interface are named by primitive group; "method module", "rule package", and "connector package" no longer appear as object names.
