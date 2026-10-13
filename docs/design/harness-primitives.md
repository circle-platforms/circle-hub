# harness 原语规范

hub 是 harness 的 hub。它治理的东西就是 harness 已经有的原语，用 harness 自己的格式，不另造第二套。Circle 里真实存在的原语是 skill、tool、MCP server、extension、command；hook 是执行链的本质，Circle 加上 hooks 机制后直接对接。hub 只认四种：**Skill、Tool、MCP server、Hook**。

## 一、四种原语在 hub 里的形状

| 原语 | 在 Circle 里 | 在 hub 里的资产 | hub 加什么 | 投影回 Circle |
|---|---|---|---|---|
| **Skill** | `SKILL.md`（frontmatter name / description）+ scripts + references + tests | `skill-package`：同一份目录，外加登记清单 `skillpack.json`（id、version、tools、inputs、outputs、triggers、model） | 冻结摘要；试跑记录（实际调了哪些工具，与声明核对）；独立审批；无界面 Circle 执行；版本不可变 | skills 列表里一条「来源 hub」的技能，格式与本机技能相同 |
| **Tool** | MCP tool 形状：name · description · inputSchema（JSON Schema）· annotations；扩展用 `registerTool(name, description, parameters, execute, {readOnly, approval})` | 不是独立资产；是 provider 资产 declaration 里的 `provides: [tool]` | 按身份算出的目录 `/v1/tools`（带 ETag）；每次调用返回原样存为证据；标注：`effect: read / write`、`minimumRole`、`approval`；绑定 `sourceArtifactId` 等平台参数 | 扩展把目录逐条 `registerTool` 成 `srv_<name>`，与本机工具同一张表、同一套许可 |
| **MCP server** | `mcp.md`：配置一个 server，得到它的 tools | 两类 provider 资产：**连接器实例**（B，只读；hub 自带的连接器包就是只读 MCP 形状的 provider）和**执行资源**（D，会动手；例如跳板机网关本来就是 streamable HTTP 的 MCP server） | declaration（reads / writes / credentials）；`runtime-profile` 资产绑定库外的端点 / CA / 超时；凭据模式（静态密钥 / 平台签发 / 外部 OAuth）；hub 的 worker 是 MCP client；任何 MCP server 都可登记为执行资源 | Circle 不直连这些 server，凭据不出 hub；只经目录看到它们的工具 |
| **Hook** | Claude Code 一类 harness 的 PreToolUse / PostToolUse：JSON 入、JSON 出、放行或阻止 | 规则处理器：挂在执行链固定钩子点上的确定性脚本，作为产品线包的模块资产装入 | 钩子点：`verify.deviceCommand`、`verify.hostCommand`、`verify.workbook`、`beforeDispatch`、`afterResult`；入参 = 本次运行的绑定 + 待核对象；出参 = `pass` 或 `{code, facts}`；审计记录规则 id 与版本 | Circle 侧已有的等价物：扩展把 `srv_*` 返回原样落盘到 `.circle/server-returns/`、脱敏密钥——就是 post-tool hook；Circle 加 hooks 机制后由 hub 下发同形的客户端 hook |

## 二、归并掉的词

| 以前的说法 | 现在 |
|---|---|
| 方法模块（解析器、契约、结果解释） | 不是原语；是 tool 的实现代码，或 hook 处理器的实现代码，随产品线包装入 |
| 规则包、规则模块、核验规则 | hook 处理器 |
| 连接器包、连接器实例、执行资源、网关 | MCP server（provider 资产），只读的在 B，动手的在 D |
| 工具目录、srv_* 工具、网关工具 | tool |
| 技能包、能力包 | skill |

产品线包交付的就是：若干 skill、若干 MCP server 的实例声明（各自 provides 哪些 tool）、若干 hook 处理器，加一份清单。

## 三、每种原语的契约

### Skill
- 内容格式 = Circle 的 skill；hub 不解析 SKILL.md 的语义，只冻结字节。
- `skillpack.json`：`id`、`version`（不可变）、`tools`（只能调这些）、`inputs`、`outputs`、`triggers`（manual / schedule / event）、`model`。
- 试跑记录：每次工具调用的 name 与参数摘要、是否成功、产物 sha；声明外的工具一个都不能出现。
- 执行：无界面 Circle 以固定版本运行，它的每次工具调用回到 hub 目录重新核权限和凭据。

### Tool
- 形状 = MCP tool：`name`（`<provider>.<tool>`）、`description`、`inputSchema`、`annotations`。
- hub 标注：`effect`（read / write）、`minimumRole`（viewer / member / admin）、`approval`（无 / 变更集）。权限跟着工具走，不另立权限登记簿。
- 目录按身份计算：provider 资产 running、调用者角色 ≥ minimumRole、来源的 readers 允许。
- 每次调用的返回由 hub 原样保存并给 evidenceId；回给调用者的内容经脱敏。

### MCP server
- 资产 declaration：`reads`（读哪些系统类型）、`writes`（会改什么）、`credentials`（凭据引用名）、`provides`（tool 列表）。
- 端点、CA、超时在 `runtime-profile` 资产引用的库外文件里，不在数据库，不在 Git。
- 凭据模式：静态密钥（只有一个调用方时）、平台签发短期令牌、外部 OAuth；都只写不读，执行时注入 worker。
- 只读 provider 由 hub 内置连接器包实现；动手的 provider 是外部 MCP server，hub 的 worker 用 MCP 协议调用；两者在目录里同形。

### Hook
- 钩子点固定：`verify.deviceCommand`、`verify.hostCommand`、`verify.workbook`、`beforeDispatch`、`afterResult`。
- 入参：`{binding: {method, resource, source, inputRevision}, subject: 命令 / 工作簿 / 结果}`；出参：`{decision: "pass"}` 或 `{decision: "block", code, facts}`。
- 处理器是 100% 可证真的脚本：不调模型、不连网、不读环境；按清单声明的顺序执行；一个 block 即停，错误码与事实原样回 Circle。
- hub 核心自带零条处理器，也没有缺省放行或缺省拒绝的分支；装了什么规则就核什么。审计记录每次判定的规则 id 与版本。

## 四、对现有实现的要求

- `professional_permissions`（包注册权限并指定最低角色）取消，改为 tool 标注 `minimumRole`。
- 产品线清单 `product-line/1` 的 `methods` 改为 `tools`（provider 实现）与 `hooks`（处理器及挂点）两项。
- 网关的 `TOOL_SPECS` 与 hub 目录的 `ToolView` 统一为 MCP tool + hub 标注，不再各有一套字段。
- 文档与界面不再出现「方法模块」「规则包」「连接器包」作为对象名；登记簿里按 skill / tool / MCP server / hook 分组。
