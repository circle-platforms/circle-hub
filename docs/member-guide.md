---
nav_order: 4
---

# 成员手册：登录、看能力、占用测试环境、编译

> **适用范围与基线声明**：本手册写给使用 Circle 连接 Circle Hub 的团队成员，基于 `wp/codex/integration` 收口基线（核对至冻结提交 `777fee3752`，含第一、二批实装控制台、权限披露与平滑退场；工作流本地操作说明同步到 `case-compile 3.19.2+` / `3.20.x`）。注：对照实测记录中，前半套操作（步 1–14）运行在较早基线 `9d842b79e7ee` 上，后续升级/重启与控制台重做在 `7c5f72c600` 上完成，文中涉及新旧差异处均已标出。**另外请注意：测试环境按团队/账户分配的权限守卫在本版未启用（服务端 `enforceEnvironmentAssignments` 为 `false`），控制台与 `list_task_packs` 投影里显示的「分配」字段目前仅供预览，不参与预订或执行校验；只要已获分配 `test-bed` 工作流的成员均可按既有规则预订测试环境**。

成员使用 Hub 只需要两样东西：**管理员给你的账户（用户名 + 一次性初始密码）**，以及**连接地址 + 24 小时一次性邀请码（或兼容访问令牌）**。全流程只使用标准 MCP 连接，无需上服务器操作。

---

## 一、登录：控制台与全新 Circle 客户端

### 1. 首次登录网页控制台并修改初始密码

1. 在浏览器打开管理员提供的 Hub 控制台地址（本机示例为 `http://127.0.0.1:7420/console/login`；若部署启用了内置 HTTPS，则打开 `https://<Hub主机>/console/login`，并先按管理员给的根证书步骤在系统里信任证书）。
2. 使用管理员给你的 **用户名** 与 **一次性初始密码** 登录。
3. 首次登录会强制跳转到修改密码页（`/console/password`），设置你自己的登录密码（12 至 256 个字符）。**改密完成后当前登录会话会立刻作废并让初始密码失效**，用你新设的密码再登录一次即可进入控制台。

### 2. 在全新的 Circle 客户端接入 Hub（桌面版 vs 终端版）

Circle 本身没有任何 Hub 专属界面，仅按普通 MCP 服务器接入；实测两种客户端做法不同：

#### 方式 A — Circle 桌面版（推荐，无需手改配置文件）

1. 若首次启动弹出「新版本说明」，先关闭弹窗；随后打开 Circle 桌面版 **设置 → 能力 → 扩展 → 界面组件**，打开 **启用 Hub 界面**（注意「运行时扩展」页签里另有一个 `启用 hub` 开关，实测只需打开「启用 Hub 界面」并进入扩展详情即可）。
2. 点开该卡片的 **插件详情**，在「Hub 的 IP 地址」栏填入管理员给的地址（如 `<Hub主机>:<端口>`），点击 **连接**。
3. Circle 会自动向你的配置写入带 `placeholders` 的 Hub 条目，并在右侧打开 Hub 网页授权流程（见下面「网页授权确认」；此处 3 步为逻辑环节，按页面逐级菜单点击与网页 4 个动作细计共约 12 次界面操作）。

#### 方式 B — Circle 终端版（使用 `/hub` 或编辑 `settings.json` 的 `mcpServers`）

1. 在终端进入你的工作目录启动 Circle，首屏按提示选择信任该工作目录。
2. 新版 Circle 终端内置支持 `/hub` 连接命令，无需再执行 `/extensions enable hub`：
   - 直接执行 `/hub <Hub地址>`（例如 `/hub http://<Hub主机>:<端口>` 或 `/hub http://<Hub主机>:<端口>/mcp`），或运行 `/hub` 查看连接说明。
3. **或在 `settings.json` 的 `mcpServers` 对象中写入 `"Hub"` 条目**：
   - 现在 Hub 控制台的 **`/console/settings#mine`** 与 **`/console/me`**（「连接新的客户端」卡片）以及管理员建号结果页均已直接提供**完整以 `"Hub"` 为键、`type: "http"` 与 `placeholders` 的 `mcpServers` 片段**，可直接复制写入 `settings.json`（确保运行技能本地工具时 `%HUB_URL%`、`%HUB_TOKEN%` 正确展开；注意按实际协议填写 `http://` 或 `https://`，使用标准 OAuth 授权流程时**切勿手加 `headers`**，带 `headers` 会绕过 OAuth）：
     ```json
     {
       "mcpServers": {
         "Hub": {
           "type": "http",
           "url": "http://<Hub主机>:<端口>/mcp",
           "placeholders": { "url": "HUB_URL", "token": "HUB_TOKEN" }
         }
       }
     }
     ```
4. 执行 `/reload`（或 `/mcp reload`，若配置仍未生效则退出重开一次 Circle 会话）让 Circle 读取配置，再执行 `/mcp` 触发登录与浏览器授权页。

#### 网页授权确认（三个确认环节、页面上共 4 次动作，勿被提示误导）

- Circle 客户端里的提示文案可能会写「在网页上用 Hub 的用户名和密码登录」，但首次连接实际上是**设备码 + 一次性邀请码**流程（页面上 4 次点击/输入动作）：
  1. 核对页面上的**设备码**与客户端一致后，点 **继续**；
  2. 在「邀请码」框输入管理员发给你的 **24 小时一次性邀请码**；
  3. 点 **验证邀请码**（如邀请码已用过或过期，也可点 **登录控制台** 改用你的账号与已修改好的控制台密码授权）；
  4. 核对请求客户端名字和访问范围后，点 **允许连接**，客户端即自动取得长期 MCP 连接凭据（每条邀请码只用一次，再连第二台设备请登录控制台授权或请管理员重签）。
- **不支持标准授权的客户端兼容做法**：请管理员签发个人访问令牌并保存为密钥 `CIRCLE_HUB_TOKEN`（按 `Bearer ${secret:CIRCLE_HUB_TOKEN}` 配置请求头）；切勿把真实令牌写入普通文件或 Git。

---

## 二、看自己能做的事（及默认审批提示）

### 1. 在网页控制台上看

- **成员能力总览 `/console/me`（「我能做的事」，推荐入口）**：汇总展示你当前账号的完整权限视图（也可从 `/console/team` 顶部点击 **我能做的事** 进入）：
  - **账户与团队**：显示用户名、启用状态与你所属的团队；
  - **工作流与通用技能**：列出已分给你的工作流（团队工作流现已准确显示**归属团队名称**，不再错标「公共空间」）与全站已安装的通用技能；
  - **连接与测试环境预览**：列出你有权使用的业务系统连接，以及已配置/关联到的测试环境及当前占用（空闲显示「本地无租约（不代表物理空闲）」，暂不可读显示「未知（空租约不代表物理空闲）」）；若你本人仍持有未归属预订，也会在「本人仍持有的预订」卡片单独列出；
  - **连接新的客户端**：直接给出带完整 `placeholders` 的配置示例与接入步骤；
  - **当前限制与配置预览**：页面明确提示 **「新测试环境分配尚未启用，当前仍按原工作流和预订规则。分配字段仅供预览，不代表当前执行许可。」**
- **所属团队**：打开 `/console/team`，普通成员默认看到「团队」页签（仅有「团队」这一个页签，顶部带 `我能做的事` 按钮），看不到其他团队与成员管理表单。
- **工作流与技能**：打开 `/console/workflows` 和 `/console/skills`，仅列出你有权使用的工作流（团队工作流「使用范围」已准确显示对应团队名）与全站已安装通用技能。
- **我的运行与知识库**：打开 `/console/runs` 查看与你共享及本人发起的运行；打开 `/console/knowledge` 查看公共知识与个人空间知识树。
- **连接与运行环境边界**：打开 `/console/connections` 时，普通成员可看「客户端」（`?tab=clients`）和 **`运行环境`（`?tab=environments`）** 两个页签——在「运行环境」页签可查看目标环境的**只读就绪报告与限制说明**（报告标注「仅本地只读观察，未连接网关或设备，未读取秘密值，不是预订或上机许可」，分配字段同样标明**仅供参考预览、不作执行许可**）；业务系统的完整配置与环境登记表单仅管理员可见。另外注意：`/console/environments` 并不是控制台路由（任何角色访问都返回 404）；`/console/api/*` 下仅保留实时流接口 `GET /console/api/stream`，其余历史读写接口已退役。

### 2. 在 Circle 里通过标准 MCP 工具看

连上 Hub 后，直接让模型调用只读 MCP 工具核对当前可用工作流（在 Circle 中，当 `mcpServers` 的键为 `Hub` 时，Hub 的 6 个标准工具显示为 `mcp__Hub__list_task_packs`、`mcp__Hub__get_nodes`、`mcp__Hub__resolve_reference`、`mcp__Hub__upload_file`、`mcp__Hub__start_run`、`mcp__Hub__submit_result`；下文的 `list_task_packs` / `start_run` 等名称均指对应工具），**不要让模型用 `curl $HUB_URL` 探测（环境变量未对 shell 展开），也不要在仅仅问权限时去启动 `test-bed` 的写记录运行**：

1. **列出有权使用的任务包与能力投影**：调用 **`list_task_packs`**（在 Circle 中工具名为 `mcp__Hub__list_task_packs`，参数 `{}`）。
   - 返回结构除了你有权使用的工作流与通用技能列表（含 `pack: "<id>@<version>"`、`digest`、`inputs`、参数声明与 `local_tools` 安装命令）外，现已随附与 `/console/me` 同源的 **`member_capabilities`** 成员能力投影（含所属团队、工作流、技能、连接、测试环境预览列表与 `environmentAccess.enforced` 标志）；
   - 当 Hub 上还有其他尚未分配给你的工作流时，文本首句会明确告知 **`你能用的 X 个；Hub 上另有 Y 个没有分配给你（名字不列出），需要哪个请管理员分配。`**（哪怕当前可用为 `0` 个，也会明确说明 Hub 上另有未分配包，而不再沉默只回 `0 个`）；
   - 用 **`start_run`**（`mcp__Hub__start_run`）直接点名未分配的工作流会明确返回 `SOURCE_NOT_PERMITTED`（首行直接说明「任务包 X 存在，没有分配给你」，不再误把「资料尚未取得」作为首句）。
2. **读取工作流与技能规程**：调用 **`get_nodes`**（`mcp__Hub__get_nodes`，参数 `{"pack": "<包ID>"}`）读出 `SKILL.md`、输入槽位和检查规范。
3. **审批模式、`/mode` 与工具权限**：Circle 默认（`manual`）审批模式下，**服务端注解（`readOnlyHint` 等）不会自动跳过审批**——不仅是 `skill_install`、`mcp__Hub__start_run`、`mcp__Hub__upload_file`、执行技能本地工具（`download-run.ts`）和普通 `ls`/`grep` shell 命令，连只读 MCP 工具（如 `mcp__Hub__list_task_packs`、`mcp__Hub__get_nodes`）默认也会按权限规则触发审批卡。前几次运行建议在人工确认 `digest` 与参数行为后，使用 `/approve` / 权限规则放行常用只读或明确工具，或按需切换审批模式（如 `/mode auto`，涉及 `acquire` 预订或 `release` 释放前仍须自己确认目标）。

---

## 三、占用测试环境（`test-bed`）

用例编译与上机前，必须先通过 `test-bed` 看环境事实并独占预订整套测试环境；不同用例之间**各自保持一条独立预订谱系**。

### 1. 查看可选测试环境与设备实时观察（`search` / `facts`）

在 Circle 里运行 `start_run` 查清当前各环境状态与设备最新观察到的构建（注意：**不要**给 `test-bed` 的 `start_run` 顶层或 `parameters` 传 `product`/`version`/`build`，需要按构建筛选时写在 `parameters.need.build`）：

```json
{
  "pack": "test-bed",
  "inputs": { "inventory": { "external": "doc:doc:bed-topology" } },
  "parameters": { "action": "facts" }
}
```

也可以传 `"action": "search"` 并加 `need` 筛选（例如 `need: { "devices": [{ "type": "load-balancer", "count": 1 }], "build": "<构建名>" }`）。查看结果时注意三条规矩：

- **实际构建以设备探针观察为准**：每台设备展示最近一次探测观察到的构建名与观察时间；从未观察过的写「没有观察记录」（不再以清单里的静态旧字段作准）。
- **占用与持有人可见性**：空闲行一律写作 `Hub 记录里空闲（未排除本地操作）`；正在占用的行显示占用运行号、取得时刻和未终态作业，**只有环境登记主人或管理员能看到持有人名字**。

### 2. 预订测试环境（`acquire`）

选定目标环境后，调用 `start_run` 预订（按清单写全需要的设备数量与类型，需要空闲地址池时加上 `addresses`）：

```json
{
  "pack": "test-bed",
  "inputs": { "inventory": { "external": "doc:doc:bed-topology" } },
  "parameters": {
    "action": "acquire",
    "bed": "<环境名>",
    "need": {
      "devices": [
        { "type": "load-balancer", "count": 1 },
        { "type": "server", "count": 1 }
      ]
    }
  }
}
```

记下以下行为要点：

- **预订不限时长**：租约从 `acquire` 开始由这条运行的谱系一直持有到显式 `release`。**切勿**传入旧参数 `hours`、`need.hours` 或 `extend`（已移除，传了会被明确拒绝并提醒用完释放）。
- **记住预订运行号（`<booking>`）**：记录返回里的 `run.run`（形如 `run_…`）。后面的用例重组、脚本编写、脚本合并都要带着 `predecessor: "<booking>"` 沿用同一份租约；**只在同一份编译任务自己的这条谱系内使用你自己的预订，绝不猜用或混用其他成员/其他会话的预订**。
- **预订时的版本观察、权限边界与缺执行器提醒**：
  - 预订成功后 Hub 会立刻在预订到的设备上做一次只读版本探测并报告看到的构建；如果环境已被别人占用或基线/前置不满足，`acquire` 会拒绝。
  - **测试环境权限守卫在本版未启用（分配字段仅供预览）**：截至本版，`enforceEnvironmentAssignments` 固定为 `false`，无论是 `/console/me`、`/console/connections?tab=environments` 还是 `list_task_packs` 返回里显示的执行器/环境分配字段都**仅供预览，不作当前预订或执行门禁**；**只要已获分配 `test-bed` 工作流的成员均可按既有租约与基线规则发起预订**（建议先在「运行环境」页签或与管理员核对用途后再预订，避免误占他人常用环境）。
  - **防坑提醒**：如果你订到了一份只有清单、尚未在 Hub 登记执行器的环境，回复第一段仍可能写「状态已确认；判断正确」，后半段才逐台报错「没有绑定同一份清单、指向这台设备的执行器版本探针」且无法上机。看到这类回执应立即调用 `test-bed` `release` 释放，并请管理员在 `/console/connections?tab=environments` 补登执行器与主机基线。

### 3. 查设备命令行提示（`help`）与用完释放（`release`）

- **查命令行参数提示**：仅能向**你当前持有的 `<booking>` 预订里的设备**发送只读 `help`（传 `action: "help"`、`booking: "<booking>"`、`predecessor: "<booking>"`、`device: "<设备名>"`、`line: "<命令行不带问号>"`）。设备回复带有「目标自报」「未排除本地操作」限定，只作当前观察参考，命令是否合法仍以对应构建命令树与手册为准。
- **正常释放**：全部上机与取回结果完成并确认有终态后，务必释放：
  ```json
  {
    "pack": "test-bed",
    "predecessor": "<booking>",
    "inputs": { "inventory": { "external": "doc:doc:bed-topology" } },
    "parameters": { "action": "release", "booking": "<booking>" }
  }
  ```
- **需要强制释放时**：只有环境的登记主人可带原话理由执行 `force_release`。如果存在未终态作业，Hub 会先要求等作业结束或请管理员用 `circle-hub job status` / `job dispose` 处置——本地强释租约不会停掉已经在远端网关跑的作业。

---

## 四、完成用例编译与上机验证（`case-compile`）

确认管理员已为你的团队分配 `case-compile` 及目标产品敏捷平台/手册/构建站资源、并且你已拿好上一步的 `<booking>` 后，按以下**六个工作流逻辑阶段**跑通（注：这里「六步」按工作流步骤划分，不含默认 `manual` 审批模式下的 `skill_install`/工具审批确认与返工重交操作——旧版 `3.19.0` 含报错重试与审批曾实测计 `14` 次成员操作，配合 `/mode auto` 与现行技能规程后成员介入可降至 `2–3` 次）：

### 第 1 步：安装工作流自带的本地工具

在 Circle 里直接告诉模型需要安装目标工作流（如 `case-compile`、`recompose`）及本地工具即可：Circle 会对照 `list_task_packs` 公布的摘要触发 `skill_install`，经你确认审批卡后自动安装到你主目录的 `.agents/skills/<包ID>` 下。

如果需要手动安装或切换版本检查（或使用独立 CLI），再按 `list_task_packs` 里的 `local_tools.install` 命令在终端运行（经标准输入提供访问凭据，绝不把令牌写进参数）：

```bash
circle-hub local-tools install case-compile@<版本> --digest <包摘要> --into <本地技能目录>
# 平时核对本地工具摘要是否改动：
circle-hub local-tools verify <本地技能目录> --digest <包摘要>
```

（若 Hub 监听在非本机回环或定制地址，加上 `--hub <Hub地址>`。）

### 第 2 步：读取工作流说明并做用例重组（`recompose`）

调用 `get_nodes({"pack": "case-compile"})` 读最新规程。常规流程先对目标原始脑图做用例重组（`recompose`；仅当后续需要同租约上机时才带 `predecessor: "<booking>"`），整理要点、步骤改写和缺项问题并取得重组记录（`recomposition_run` 与 `recomposition_result`）；如确实跳过重组，按 `case-compile` 规定写明参数 `"pipeline": "legacy"`。

> **整批规则、范围外用例与 `rec:` 引用当场保存提示（实测必知）**：
> - `recompose`（如 `1.2.3+`）会按**整张冻结脑图的全部条目**逐条核对并封批（`functions/seal.ts`）：哪怕你这一次只想编其中 2 条用例，脑图里共有 17 条时也必须整批重组齐备才能封批；若整批中不属于你本次目标的其他用例触发了与手册冲突的弹窗确认（不要替原作者改动其业务规则），一般选保留原写法并等作者答复即可。
> - **当场保存 `rec:` 重组引用（不能从控制台跨会话反查）**：Hub 网页控制台不会代为记下 `recomposition_run`（`{"reference": "<run_reference>"}`）与 `recomposition_result`（`{"run": "<重组运行编号>"}`）。`recompose` 完成后务必立刻在当前工作目录记下这两份引用（运行 `download-run.ts` / `recompose/tools/download-run.ts` 时会自动落盘到 `<目录>/references.json`）；若换用新会话或换人想在同一脑图同一构建下复用已核对正确的重组，必须由原保存者把这两份引用交给你，否则找不到只能整批重跑一次 `recompose`。

### 第 3 步：发起脚本编写运行（第一次 `start_run`）并下载资料

- **什么时候要带 `predecessor: "<booking>"`**：只有在你准备**接着上机验证**时，才先订测试环境并把 `predecessor: "<booking>"` 从 `recompose` 一路传到 `case-compile`；如果你**只做脚本编写和脚本合并、不上机验证**，当前版本可以**不先预订、不传 `predecessor`** 直接启动 `case-compile`。
- **子代理继承限制提醒**：在当前 Circle 版本里，父会话里你对模型下的指令（例如「不预订测试环境、不要把已有预订当作前驱」）**不会自动传递到模型派出的子代理的任务文本里**。只要这次不想占环境，给模型指令时除了开头说明外，还要明确叮嘱「在每个编写子代理的任务要求里都写明：不预订测试环境、不复用预订」。
- 启动脚本编写时，在 `start_run` 顶层写明 `pack: "case-compile"`、`product`、`version`、`build`（若上机验证加 `predecessor: "<booking>"`）；`inputs` 传入脑图 `subject`、执行器契约 `contract`（`doc:doc:runner-contract`）、环境清单 `inventory`（`doc:doc:bed-topology`）、契约配置 `profile`（`doc:doc:runtime-profile`），以及对应的 `recomposition_run`（传 `{"reference": "<run_reference>"}`，取自 `recompose` 运行通过 `download-run` 落盘的 `references.json` 或导出顶层 `run_reference` 里的 `rec:` 完整运行记录，不要写成提交记录）和 `recomposition_result`（传 `{"run": "<重组运行编号>"}`；如需排除项写进 `parameters.exclude`）。

记下返回的 `<脚本编写 run_…>`，运行本地下载工具把规则与原始用例整份落到本地新目录（注意依赖前面终端 `settings.json` 中已配置 `placeholders`，令牌经标准输入传入）：

```bash
node <本地技能目录>/tools/download-run.ts --hub %HUB_URL% --run <脚本编写编号> --out <工作目录>
```

> **遇 Hub 升级或重启窗口怎么办**：现在 Hub 在停止阶段会先等待已受理请求与正在传输的运行资料在预算内发完，并对尚未进入入场流程的新请求返回 `HTTP 503`（`这次调用没有执行`）与 `Retry-After`。从 `case-compile 3.19.2`（`recompose 1.2.4`）起，本地读取工具（`download-run.ts`、`download-returns.ts`、`fetch-run.ts`、`assemble-delivery.ts`）遇到 `503` 或 `ECONNREFUSED` 会按 `Retry-After` 或 `2/4/8` 秒退避最多自动等待 `60` 秒，`submit-plans.ts` / `submit-records.ts` 仅在 Hub 明确回答 `503` 含「这次调用没有执行」时才自动重发；若使用更早版本的本地工具或跨过最长等待窗口仍报不可达，等几秒重跑该命令或重新发起这一步即可，**你的 Circle 客户端无需重新登录、也不用重新配置连接**（仅网页控制台需要重新登录）。

在本地目录读清各原始用例对应条目、执行器规则、同构建手册和命令树。

### 第 4 步：编写计划、本地预检与保真核对、提交核对并生成工作簿（`case.xlsx`）

1. 按 `slots.schema.json`、`tables/blocks-format.json` 和执行器规则为每条纳入范围的原始用例写出自动化用例 JSON 计划（遇到地址从环境清单替换、期望必须逐字取自原始期望/实机可观察行、清理步骤按逆序放在每条末尾；提交前可先跑只读工具 `node <本地技能目录>/tools/check-plan.ts` 离线核对格式与占位符）。
2. **场景保真核对三步（提交前必做，缺则被本地拦截）**：`3.19.1` 起 `submit-plans.ts` 在连接 Hub 前会先在本地校验每份计划的 `data.fidelity`；缺少该字段或简报摘要过期时会被本地直接退回（退出码 `1`，不消耗 Hub 修复次数，详见包内 `SKILL.md`）：
   - ① 运行 `node <本地技能目录>/tools/fidelity-brief.ts ...` 生成 `.brief.json`；
   - ② 派发独立只读子代理（按 `task-brief.ts --role 保真核对 ...` 模板，保持盲审不读上一轮返工历史）逐份核对 `.brief.json` 并写出 `.verdict.json`；
   - ③ 运行 `node <本地技能目录>/tools/fidelity-apply.ts ...` 写回 `data.fidelity` 并确认 `ready: true`。
3. 提交每条已过保真核对的计划交给 Hub 校验（不覆盖文件，若有不符按工具返回精确行和原因改错后重交；若此前已进入脚本合并阶段又需要修改计划，必须先回到第 3 步用 `start_run` 新开一次脚本编写运行，禁止重交到已被核对锁定的旧运行）：
   ```bash
   node <本地技能目录>/tools/submit-plans.ts --hub %HUB_URL% --run <脚本编写编号> --model <模型名> --plans <计划目录>
   ```
4. 核对确认除仅缺 `workbook_verified` 外的全部必需检查项通过后，取回已通过数据并生成本地工作簿：
   ```bash
   node <本地技能目录>/tools/fetch-run.ts --hub %HUB_URL% --run <脚本编写编号> --out <工作目录>
   node <本地技能目录>/tools/generate-workbook.ts \
     --run <工作目录>/run.json \
     --result <工作目录>/result.json \
     --submission <工作目录>/submission.json \
     --contract <工作目录>/contract.json \
     --profile <工作目录>/profile.json \
     --inventory <工作目录>/inventory.json \
     --out <工作目录>/case.xlsx
   ```

### 第 5 步：上传工作簿、脚本合并并在同谱系下自动上机（第二次 `start_run`）

1. **上传生成的 Excel**：调用 MCP 工具 **`upload_file`**（`file_path` 传入 `case.xlsx` 文件字节的 RFC 4648 base64 字符串、`name: "case.xlsx"`），核对返回的文件引用 `src:<sha256>` 与上一步工具输出的摘要一致。
2. **发起脚本合并**：若接着上机验证，仍以同一个 **`predecessor: "<booking>"`**、同一组顶层 `product`/`version`/`build` 和同一组 `subject`/`contract`/`inventory`/`profile` 与 `parameters.exclude` 再次调用 `start_run`（仅做脚本合并、不上机验证时，可不传预订运行而改传脚本编写运行或不传 `predecessor`），并补充：
   - `inputs.workbook`: `{"reference": "src:<sha256>"}`（对应上一步 `upload_file` 返回的 `src:` 引用）；
   - `inputs.plan_result`: `{"run": "<脚本编写编号>"}`；
   - `parameters.plan_run`: `"<脚本编写编号>"`。
3. **自动上机与拒单处理**：当脚本合并核对通过、仍持有同一 `<booking>` 的有效租约，且环境基线、认证证据与清单摘要核对全部就绪时，**Hub 自动发起上机验证**，无需再调用其他派发工具；若此时未派发（如缺基线、认证证据不可读、环境被冻结、租约不匹配，或工作流刚升级而管理员尚未在执行器定义里同步新版的「核验函数身份」），答复会给出缺什么和由成员或管理员采取的下一步（如遇到需管理员更新执行器、补基线或处置的拒因，按回执内容转请管理员处理）。

### 第 6 步：等待设备输出、失败分析（最多 3 轮）、组交付目录并释放环境

1. **后台等待设备结果**：作为后台命令运行下载返回工具并加 `--wait 3600`（期间不轮询 `sleep`，也不重交计划去查看进度）：
   ```bash
   node <本地技能目录>/tools/download-returns.ts --hub %HUB_URL% --run <脚本合并编号> --out <结果目录> --wait 3600
   ```
2. **失败分析与最多 3 轮重新编写**：收到设备输出后逐字读原文，先查构建一致性与配置生效及公共前置；仅修改失败或未知用例的计划（**已确认正确的用例保持逐字不变**），沿用同一个 `<booking>` 重复「脚本编写 → `submit-plans` → `generate-workbook` → 上传合并上机」，每条原始用例最多重新编写 3 轮。如确认所有要交付的用例还没有放进同一份最终 `case.xlsx` 上机通过，先排除其余未成功项合编运行最后一次上机。
3. **组装交付目录**：按 `tools/delivery.md` 准备好说明 JSON 后，运行组装工具校验全部上机记录与原件一致性并产出交付包（含 `case.xlsx`、`unsuccessful_cases.xlsx`、`delivery_report.md`、`unsuccessful_cases.md`、`delivery.json`）：
   ```bash
   node <本地技能目录>/tools/assemble-delivery.ts \
     --hub %HUB_URL% \
     --runs <脚本合并编号> \
     --recompose <用例重组编号> \
     --notes <说明.json> \
     --out <交付目录>
   ```
4. **释放测试环境**（若前面预订了环境）：最后务必调用本章第三节的 **`test-bed` `release`**（带同一 `booking`），释放你的测试环境供下一位成员使用。

---

## 相关页面

- [十分钟上手](quickstart.md)：零起步概念、MCP 工具参数概览
- [Hub r4 使用指南：七项用例能力](hub-r4-guide.md)：除编译外其它六项用例工作流的用法与范围说明
- [管理员手册](admin-guide.md)：请管理员帮忙建团队、开权限、加测试环境或处理异常冻结时可对照
