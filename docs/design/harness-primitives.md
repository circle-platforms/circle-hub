# harness 原语规范

hub 是 harness 的 hub，而且是公开的通用平台：它治理的是**任何 harness** 都有的原语，不只是 Circle 的。Circle 是第一个也是集成最深的 harness；Claude Code、Codex、OpenCode、Pi 这类 harness 写出来的技能、钩子、代理、命令，同样要能登记进 hub、被独立审批、再装进任何一个 harness。做不到这一点，hub 就只是 Circle 的私有后端。

因此规范分三层：**中立清单**（hub 存什么）、**适配器**（每个 harness 怎么导入导出）、**通用传输**（MCP，任何 harness 不装适配器也能用 hub）。

## 一、治理哪些原语

harness 里实际存在的东西，分成 hub 治理的和不治理的。治理 = 共享 + 版本 + 独立审批 + 证据。

| 原语 | 是什么 | 是否治理 | 落在哪个对象 |
|---|---|---|---|
| **Skill** | 一个目录：markdown 入口（frontmatter name / description）+ 脚本 + 参考 + 测试；模型按描述自动选用或按名调用 | 治理 | E |
| **Tool** | 模型可调用的能力：name · description · inputSchema · annotations（MCP tool 形状） | 治理（随 provider） | B（只读）/ D（动手） |
| **MCP server** | 提供 tools / resources / prompts 的服务端 | 治理（provider 资产） | B / D |
| **Hook** | 围绕工具调用或会话事件的确定性检查：事件名 + JSON 入 + JSON 出（放行 / 阻止 + 理由） | 治理 | E（处理器）· 作用于 D 的执行链 |
| **Instruction** | 项目级指令文件：AGENTS.md / CLAUDE.md / rules 一类，给模型的长期规则 | 治理 | E（版本化的规则文本；按范围下发） |
| **Agent** | 子代理定义：markdown + frontmatter（名称、描述、工具白名单、模型） | 治理 | E（和 Skill 同一套登记、试跑、审批） |
| **Command** | 可复用的提示词 / 斜杠命令：markdown + 参数 | 治理 | E（轻量 Skill；试跑可省） |
| **Bundle / Plugin** | 上述原语的打包（Claude Code 的 plugin、Circle 的 extension 的内容部分） | 治理 = 变更集 | 跨对象；即产品线包 |
| **Permission policy** | 哪些工具允许 / 需确认 / 拒绝 | 治理（数据） | C（角色预设 + tool minimumRole 的投影） |
| Session / transcript | 会话原始历史 | 不治理 | A；沉淀的知识候选进 B |
| Memory | harness 的个人记忆 | 不治理 | A；团队知识经审阅进 B |
| Model / provider 配置 | 用哪个模型、密钥 | 不治理 | A；hub 的无界面执行有自己的固定模型配置 |
| Workspace / sandbox 环境 | 本机目录、容器、devcontainer | 不治理 | A；hub 自己的执行资源在 D |

不治理的三样有共同点：它们是某个人某台机器上的运行状态，不是团队共享的事实或方法。

## 二、中立清单：hub 存的是什么

每种治理原语在 hub 里是一个资产，字节冻结、SHA 钉住，外加一份**中立清单**（hub 自己的 schema，不属于任何 harness）：

| 原语 | 资产 kind | 中立清单 | 字节 |
|---|---|---|---|
| Skill | skill-package | `hub-skill/1`：name、description、version、entry（入口文件）、tools（允许调用的工具名，可空）、inputs、outputs、triggers、model、sourceHarness（作者用的 harness）、knownCompatible（已验证能装进哪些 harness） | 原目录原样 |
| Tool | 不独立；在 provider 的 declaration.provides 里 | MCP tool + hub 标注：effect（read / write）、minimumRole、approval | — |
| MCP server | connector-instance（只读）或 connector-instance（执行资源）+ runtime-profile | `hub-provider/1`：transport（stdio / streamable-http）、provides（tools / resources / prompts）、reads、writes、credentials、credentialMode | 无（端点与密钥在库外） |
| Hook | product-line 模块 | `hub-hook/1`：event（挂点）、order、handler（入口）、language（ts / shell）、deterministic: true | 处理器脚本 |
| Instruction | instruction | `hub-instruction/1`：scope、applies（路径或产品线）、fileName 投影名 | markdown |
| Agent | agent | `hub-agent/1`：name、description、tools、model、sourceHarness | markdown |
| Command | command | `hub-command/1`：name、description、arguments | markdown |
| Bundle | 变更集 | `hub-bundle/1`：items（上面各项的 id + version） | — |
| Permission policy | 范围策略 + tool 标注 | 不单独建清单：由角色预设和 minimumRole 导出 | — |

中立清单只放 harness 共同需要的字段。某个 harness 特有的字段（例如某家 frontmatter 里的专有键）原样留在字节里，不进中立清单，也不丢。

## 三、适配器：导入和导出

每个 harness 一个适配器，两件事：**导入**（把该 harness 的本地原语变成 hub 资产 + 中立清单）、**导出**（把 hub 资产装进该 harness 的目录约定）。

| 原语 | Circle | Claude Code | Codex | OpenCode / 其它 |
|---|---|---|---|---|
| Skill | `.circle/skills/<name>/SKILL.md`，导入导出都已实现（推送 / 安装） | `.claude/skills/<name>/SKILL.md`；frontmatter 同形，专有键原样保留 | 以其技能目录约定为准 | 按各自约定；没有技能机制的 harness 用 MCP prompt 投影 |
| Tool | `registerTool` 成 `srv_*` | 经 hub 的 MCP 端点 | 经 hub 的 MCP 端点 | 经 hub 的 MCP 端点 |
| MCP server | hub 代连，Circle 不直连 | 同左 | 同左 | 同左 |
| Hook | 扩展内置的等价物（返回落盘、脱敏）；Circle 加 hooks 机制后下发 | settings 里的 hooks：事件名与 JSON 入出按其协议映射到 hub 的钩子事件 | 以其机制为准 | 没有 hooks 的 harness 只在 hub 侧执行 |
| Instruction | AGENTS.md 一类文件按范围下发 | CLAUDE.md / rules 文件 | AGENTS.md | 各自的规则文件名 |
| Agent | 待 Circle 支持 | `.claude/agents/<name>.md` | 以其机制为准 | 按各自约定 |
| Command | `/` 命令目录 | `.claude/commands/<name>.md` | 以其机制为准 | 按各自约定 |
| Permission policy | 本机许可 + hub 角色 | settings 的 permissions allow / deny | 以其机制为准 | 按各自约定 |

表里写「以其机制为准」的格子，是这版还没写适配器的；适配器写好之前，hub 对那个 harness 的支持只有 MCP 传输那一层。每个适配器交付时附一张合成验收：一个用该 harness 写的 Skill 导入 hub、经审批、再导出到 Circle 和原 harness，两边都能加载。

导入导出经两个端点。`POST /v1/harness/import` 接收来源 harness、版本与精确文件集的原字节/SHA：整批一个事务，创建对应原语的草稿并共用一个变更集；SHA、文件集、范围逐项重核，同字节的重复导入复用同一资产与审批请求，批准前的导出是 `SOURCE_NOT_APPROVED`。`GET /v1/assets/{id}/harness-export?target=…` 把已批准的原语投影成目标 harness 的文件表（相对路径、base64、SHA）加 warnings 与 provenance：原文字节不改，装不进目标 harness 的部分给 warning，不猜近似映射。Hook 与 provider 需要产品模块与运行配置的治理路径，没有投影时是 `NO_HARNESS_PROJECTION`，不自动装入或执行。各 harness 的 permission hint 由适配器原样保留，不等同于工具闭集。

knownCompatible 只记真实运行里匹配本包 manifest.id 的成功装载（用工具返回的 id 关联模型发起的调用，不依据返回文本）；它可以在读取投影里展示，不改变冻结的提交原件与 digest。

## 四、通用传输：hub 自己是一个 MCP server

不装任何适配器的 harness，只要会连 MCP，就能用 hub：

- `/mcp`（streamable HTTP）按当前身份暴露：**tools**（目录里的工具，形状不变）、**resources**（资料与证据：`hub://evidence/<id>`、`hub://source/<id>`、`hub://artifact/<id>`，只读）、**prompts**（Skill 和 Command 的 MCP prompt 投影，给没有技能机制的 harness 用）。
- 鉴权用 hub 的会话令牌；每次调用照常留证据、过权限；写操作（交活、推送、审批）也是 tools，`approval` 标注的那些在没有卡片界面的 harness 里会要求显式确认参数。
- 显式确认走 MCP 的 `_meta`，不改工具的 inputSchema：`tools/call` 的 `params._meta["hub/idempotencyKey"]` 必填；`approval` 标注的工具第一次调用若没有确认，返回 `CONFIRMATION_REQUIRED`，details 带 `argsDigest`（参数的规范摘要）和一行人读摘要；客户端再次调用时在 `_meta["hub/confirmation"]` 回传同一 `argsDigest`，与当前参数摘要一致才执行，不一致是 `CONFIRMATION_STALE`。确认绑定参数，不能盲确认；响应的 `_meta` 回显 idempotencyKey 与 evidenceId。
- Circle 扩展是这条传输之上的富客户端：卡片、队列、登记簿。其它 harness 先得到基础能力，再按需要写适配器。
- 传输形状：Streamable HTTP 的 JSON 端点，按协议版本协商；每个请求带 hub 会话 Bearer，Origin 若存在必须与 hub 原生地址同源；无会话 id 的 stateless 模式，GET/DELETE 为 405；Accept 同时支持 JSON 与 SSE。
- 幂等：body 的 idempotencyKey 与 `_meta["hub/idempotencyKey"]` 都有时必须一致。平台控制 Tool 的读写共用持久幂等回执：同租户/主体/范围/工具/键的重放返回同一证据，不再执行；改参数是 `IDEMPOTENCY_MISMATCH`；回执没有到期窗口，要读最新状态用新键，重放仍检查当前权限与任务可见性。专业 Tool 沿用受理的二十四小时去重窗口——两类窗口不同，客户端不得把专业工具的旧键当永久防重证明。
- 平台控制 Tool 保留 `hub.` 命名空间（交活、上传原件、推送技能、审批决定、运行技能、任务状态与结果）；写回执与原动作在同一事务落库，重放不再写。控制调用的返回以 SHA 存 B，`mcr_` 是传输回执证据，不声称业务事实或模型质量。
- resources 的 URI：`hub://evidence/<knr_|evd_|mcr_>`、`hub://source/<knr_|src_>`、`hub://artifact/<art_>`，逐次按当前身份的资料权限核对，`mcr_` 仅原操作者可读；列表在授权集合上分页，游标绑定身份、原样续读。prompts 是已批准 Skill/Command 的投影：返回资产 SHA 与版本出处，不替换未声明参数，不执行原语。
- 显式确认不替代治理：它只证明同一操作者确认了同一组参数，不能成为变更集审批人，不替代角色、绑定、Hook 或租约。

## 五、原语在四对象 × 五要素里的位置

原语不是第五个对象，也不是第六个要素；每种原语都落在某个对象的某几个要素里：

| 原语 | 对象 | 记录 | 资产 | 审批策略 | 证据 | 扩展点 |
|---|---|---|---|---|---|---|
| Skill · Agent · Command | E 方法 | `skp_` + 试跑记录 | skill-package / agent / command | 版本登记走变更集 | 试跑产物 sha、运行时每次工具调用 | packs 仓库 modules.json |
| Instruction | E 方法 | 版本 | instruction | 登记走变更集 | 下发记录 | 按范围下发 |
| Tool | provider 所在对象：B 或 D | 每次调用 `evd_` | provider declaration 的 provides | 无（minimumRole） | 返回原样保存 | 由 MCP server 带入 |
| MCP server · 只读 | B 资料 | 来源修订 `src_` | connector-instance + runtime-profile | 启用走变更集 | 读取的原件 | 连接器包（按系统类型） |
| MCP server · 执行资源 | D 执行 | 操作 `op_`、租约、现场 | connector-instance + runtime-profile | 启用走变更集；executionIsChange 时执行提交也走 | 派发前核验、现场回报 | 资源适配器（MCP 协议为通用适配器）、凭据模式、profile |
| Hook | E 方法（处理器）· 作用于 D | 每次判定的规则 id / 版本 | product-line 模块 | 装入走变更集 | 判定结果与事实 | 五个固定钩子点 |
| Permission policy | C 工作 | 策略版本 | 范围策略 | 变更集 | 决定记录 | 策略是数据 |

## 六、归并掉的词

| 以前的说法 | 现在 |
|---|---|
| 方法模块（解析器、契约、结果解释） | Tool 的实现代码或 Hook 处理器，随产品线包装入 |
| 规则包、规则模块、核验规则 | Hook 处理器 |
| 连接器包、连接器实例、执行资源、网关 | MCP server（provider 资产），只读的在 B，动手的在 D |
| 工具目录、srv_* 工具、网关工具 | Tool |
| 技能包、能力包 | Skill |

## 七、每种原语的契约

### Skill / Agent / Command
- 内容格式 = 作者所用 harness 的格式；hub 只冻结字节，不解析语义；中立清单从 frontmatter 和目录推导，推导不出的字段留空。
- `tools` 一旦声明，试跑记录里出现声明外的工具就拒绝；没声明则试跑记录只作披露。
- 执行：无界面 Circle 以固定版本运行，每次工具调用回到 hub 目录重新核权限和凭据。导出到其它 harness 的副本带 hub 的资产 id 与 sha，便于回溯。运行的 harness 钉在已核对的提交与版本上，升级运行器不放松这个核对；每次运行用独立的 HOME 与工作区。产物只在进程正常结束、声明文件完整、字节 SHA 核对之后交付；文件完整性与摘要记 script-conclusion，模型的最后回答另记 model-judgment，不用回答替代产物或专业事实。取消先中断输入流、超时再终止进程；观察到本地退出后任务保持 unknown，并如实标注远端停止未核实。

### Tool
- 形状 = MCP tool：`name`（`<provider>.<tool>`）、`description`、`inputSchema`、`annotations`（readOnlyHint 等）。
- hub 标注：`effect`、`minimumRole`、`approval`。权限跟着工具走，不另立权限登记簿。
- 目录按身份计算：provider running、调用者角色 ≥ minimumRole、来源的 readers 允许。返回原样保存并给 evidenceId；回给调用者的内容经脱敏。

### MCP server
- 资产 declaration：`reads`、`writes`、`credentials`、`provides`。端点、CA、超时在 runtime-profile 引用的库外文件里。
- 凭据模式：静态密钥（只有一个调用方时）、平台签发短期令牌、外部 OAuth；只写不读，执行时注入 worker。
- 只读 provider 由 hub 内置连接器包实现；动手的 provider 是外部 MCP server，worker 用 MCP 协议调用；在目录里同形。

### Hook
- 钩子点固定：`verify.deviceCommand`、`verify.hostCommand`、`verify.workbook`、`beforeDispatch`、`afterResult`；客户端侧的事件（PreToolUse / PostToolUse 一类）由适配器映射。
- 入参 `{event, binding: {method, resource, source, inputRevision}, subject}`；出参 `{decision: "pass"}` 或 `{decision: "block", code, facts}`。
- 处理器是 100% 可证真的脚本：不调模型、不连网、不读环境；按清单顺序执行；一个 block 即停。hub 核心自带零条处理器，没有缺省放行或缺省拒绝的分支；审计记录规则 id 与版本。
- 三个 verify 挂点的 subject 分别是 `{command, tree:{heads:[{command, present}]}}`、`{command, host, method, kwargs}`、`{client, contract:{testEnvEnabled:[…]}}`；beforeDispatch 是 `{input, operationId}`，afterResult 是 `{result, operationId}`，不接受多余字段。block 的 code/facts 原样回传，并补授权行号、输入修订与原件 SHA；每次判定的事件与审计都保留规则 id/版本/挂点/结果。
- 主机策略只取资源声明里已批准的原声明：allowedTestHosts 是显式集合，hostCommandPolicies 是可选的逐主机收窄；运行文件里的同名字段不作治理授权。

### Instruction
- 按范围或产品线下发的 markdown；版本化、变更集审批；适配器按各 harness 的文件名投影。不含凭据、地址。

## 八、对现有实现的要求

- `professional_permissions` 取消，改为 tool 标注 `minimumRole`。
- `product-line/1` 的 `methods` 改为 `tools`（provider 实现）与 `hooks`（处理器及挂点）。
- 网关的 `TOOL_SPECS` 与 hub 的 `ToolView` 统一为 MCP tool + hub 标注。
- 技能登记增加中立清单 `hub-skill/1`（从现有 skillpack.json 推导），记录 sourceHarness 与 knownCompatible。
- 新增 hub 的 MCP 端点 `/mcp`（tools / resources / prompts），作为所有 harness 的基础接入；Circle 扩展改为建立在它之上。
- 新增 Instruction、Agent、Command 三种资产 kind，与 Skill 共用登记、试跑（可省）、审批。
- 文档与界面按原语分组命名；「方法模块」「规则包」「连接器包」不再作为对象名出现。

---

本文是 circle-hub 的设计规范之一，按 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.zh-hans) 授权：引用、借鉴须署名 Circle Hub 与 qingshanfeihu 并注明原始出处链接。见[设计规范索引](README.md#许可)。
