---
nav_order: 4
---

# 成员手册：登录、看能力、占用测试环境、编译

> **适用范围与基线声明**：本手册写给使用 Circle 连接 Circle Hub 的团队成员，基于 `hub-final`（`4a1fbdee57`）实装能力编写。文中凡仍在合入中的统一首页或预订前环境细项提示（如 N1 成员统一首页、N3 预订前自动门禁与 SKILL 文字更新），均明确标注当前实际可用入口。

成员使用 Hub 只需要两样东西：**管理员给你的账户（用户名 + 一次性初始密码）**，以及**连接地址 + 24 小时一次性邀请码（或兼容访问令牌）**。全流程只使用标准 MCP 连接，无需上服务器操作。

---

## 一、登录：控制台与全新 Circle 客户端

### 1. 首次登录网页控制台并修改初始密码

1. 在浏览器打开管理员提供的 Hub 控制台地址（本机示例为 `http://127.0.0.1:7420/console/login`；若部署启用了内置 HTTPS，则打开 `https://<Hub主机>/console/login`，并先按管理员给的根证书步骤在系统里信任证书）。
2. 使用管理员给你的 **用户名** 与 **一次性初始密码** 登录。
3. 首次登录会强制跳转到修改密码页（`/console/password`），设置你自己的登录密码（12 至 256 个字符）。改完即进入控制台。

### 2. 在全新的 Circle 客户端接入 Hub（标准 MCP 方式）

Circle 本身没有任何 Hub 专属界面，仅按普通 MCP 服务器接入：

1. **复制配置条目**：打开 Hub 控制台右上角或设置页 **`/console/settings#mine`**，找到「连接新的客户端（MCP 标准连接确认）」里的 `mcp_servers` JSON 片段（仅含标准 `/mcp` 地址）。也可以直接使用管理员随账号发给你的同名片段。
2. **加入 Circle 并完成首次授权**：
   - 把这条 `mcp_servers` 条目加入你的 Circle MCP 配置（确保已按需信任内置 HTTPS 根证书）；
   - 首次连接该 MCP 服务器时，浏览器会自动弹出 Hub 的授权确认页（`/console/authorize`）；
   - 登录你的控制台账号并按页面要求输入管理员发给你的 **24 小时一次性邀请码**（仅使用一次），点击确认授权，Circle 即获得你自己的长期 MCP 连接凭据，无需手动把密码或令牌抄进配置或代码里。
3. **客户端不支持标准授权时的兼容做法**：仅当使用的客户端不支持浏览器 MCP 授权确认时，请管理员签发个人访问令牌并保存为该客户端密钥 `CIRCLE_HUB_TOKEN`（按 `Bearer ${secret:CIRCLE_HUB_TOKEN}` 配置请求头）；切勿把真实令牌写入普通文件或 Git。

---

## 二、看自己能做的事

### 1. 在网页控制台上看

> *现状说明（`4a1fbdee57`）*：把「所属团队 + 可用工作流与技能 + 可用连接 + 测试环境及当前占用」汇总到同一张「成员首页」的视图（N1）正在开发合入中。当前已上线页面按栏目分别展示当前账户可见范围：

- **所属团队**：打开 `/console/team`，普通成员只能看到**自己所属团队的名字**，看不到其他团队、也不开放全站成员管理与客户端全局页签。
- **我能用的工作流与技能**：打开 `/console/workflows` 和 `/console/skills`（默认筛选当前可用，可切换个人空间/分享/公共列表）。未分配给你的团队工作流不会混在可执行权限中，别人个人空间的内容也不会向你展示。
- **我的运行与知识库**：打开 `/console/runs` 查看与你共享及本人发起的运行；打开 `/console/knowledge` 查看公共知识与你个人空间的知识树。

### 2. 在 Circle 里通过标准 MCP 工具看

连上 Hub 后，直接用 MCP 工具核对你当前拥有的能力（或在对话里让模型调用这两个只读工具）：

1. **列出有权使用的任务包**：调用 **`list_task_packs`**（参数 `{}`）。
   - 返回你被分配到的全部工作流包（包含 `pack: "<id>@<version>"`、`digest`、`inputs`、参数声明与带 `tools/` 的 `local_tools.install` 命令）。
   - 如果想核对某一个包为什么不能用（传 `{"pack_id": "<包ID>"}`）：未分配给你的团队包会返回「存在，你没有读取权限」并提示请管理员分配；别人个人空间里的工作流与通用技能同样不会泄露内容或细节。
2. **读取工作流与技能规程**：调用 **`get_nodes`**（参数 `{"pack": "<包ID>"}`）读出 `SKILL.md`、输入槽位和检查规范。

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
- **预订时的版本观察与拒单处理**：预订成功后 Hub 会立刻在预订到的设备上做一次只读版本探测并报告看到的构建；如果环境已被别人占用或基线/前置不满足，`acquire` 会拒绝（N3 统一门禁核对与完整缺项指引合入后，预订被拒会直接列明逐项原因与由谁补齐）。

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

确认管理员已为你的团队分配 `case-compile` 及目标产品敏捷平台/手册/构建站资源、并且你已拿好上一步的 `<booking>` 后，按以下六步跑通：

### 第 1 步：安装工作流自带的本地工具

1. 从 `list_task_packs` 返回里找到 `case-compile`，核对其中的 `local_tools.install` 命令，在你的客户端终端执行（按提示通过标准输入提供你的访问凭据或客户端令牌，绝不把令牌写死到脚本或参数里）：
   ```bash
   circle-hub local-tools install case-compile@<版本> --digest <包摘要> --into <本地技能目录>
   ```
   （若 Hub 监听在非本机回环或定制地址，加上 `--hub <Hub地址>`；平时可用 `circle-hub local-tools verify <本地技能目录> --digest <包摘要>` 核对本地文件摘要有没有变动。）
2. 同样检查并安装需要用到的附属能力包工具（如已配 `recompose` 等）。

### 第 2 步：读取工作流说明并做用例重组（`recompose`）

调用 `get_nodes({"pack": "case-compile"})` 读最新规程。常规流程先对目标原始脑图做用例重组（`recompose`，带着 `predecessor: "<booking>"` 保持同谱系租约），整理要点、步骤改写和缺项问题并取得重组记录号（`recomposition_run` 与 `recomposition_result`）；如确实跳过重组，按 `case-compile` 规定写明参数 `"pipeline": "legacy"`。

### 第 3 步：发起脚本编写运行（第一次 `start_run`）并下载资料

调用 `start_run`（顶层写明 `pack: "case-compile"`、`predecessor: "<booking>"`、`product`、`version`、`build`；`inputs` 传入脑图 `subject`、执行器契约 `contract`、环境清单 `inventory: {"external": "doc:doc:bed-topology"}`、契约配置 `profile` 以及可选 `recomposition_run`/`recomposition_result`；如有需先排除项写进 `parameters.exclude`）。

记下返回的 `<脚本编写 run_…>`，运行本地下载工具把规则与原始用例整份落到本地新目录（`%HUB_URL%` 由你的终端环境或命令展开，令牌经标准输入传入）：

```bash
node <本地技能目录>/tools/download-run.ts --hub %HUB_URL% --run <脚本编写编号> --out <工作目录>
```

在本地目录读清各原始用例对应条目、执行器规则、同构建手册和命令树。

### 第 4 步：编写计划、提交核对并生成工作簿（`case.xlsx`）

1. 按 `slots.schema.json`、`tables/blocks-format.json` 和执行器规则为每条纳入范围的原始用例写出自动化用例 JSON 计划（遇到地址从环境清单替换、期望必须逐字取自原始期望/实机可观察行、清理步骤按逆序放在每条末尾）。
2. 提交每条计划交给 Hub 校验（不覆盖文件，若有不符按工具返回精确行和原因改错后重交）：
   ```bash
   node <本地技能目录>/tools/submit-plans.ts --hub %HUB_URL% --run <脚本编写编号> --model <模型名> --plans <计划目录>
   ```
3. 核对确认除仅缺 `workbook_verified` 外的全部必需检查项通过后，取回已通过数据并生成本地工作簿：
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
2. **发起脚本合并**：仍以同一个 **`predecessor: "<booking>"`**、同一组顶层 `product`/`version`/`build` 和同一组 `subject`/`contract`/`inventory`/`profile` 与 `parameters.exclude` 再次调用 `start_run`，并补充：
   - `inputs.workbook`: `{"reference": "src:<sha256>"}`（对应上一步 `upload_file` 返回的 `src:` 引用）；
   - `inputs.plan_result`: `{"run": "<脚本编写编号>"}`；
   - `parameters.plan_run`: `"<脚本编写编号>"`。
3. **自动上机与拒单处理**：当脚本合并核对通过、仍持有同一 `<booking>` 的有效租约，且环境基线、认证证据与清单摘要核对全部就绪时，**Hub 自动发起上机验证**，无需再调用其他派发工具；若此时未派发（如缺基线、认证证据不可读、环境被冻结或租约不匹配），答复会给出缺什么和由成员或管理员采取的下一步（如遇到需管理员补基线/处置的拒因，按回执内容转请管理员处理）。

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
4. **释放测试环境**：最后务必调用本章第三节的 **`test-bed` `release`**（带同一 `booking`），释放你的测试环境供下一位成员使用。

---

## 相关页面

- [十分钟上手](quickstart.md)：零起步概念、MCP 工具参数概览
- [Hub r4 使用指南：七项用例能力](hub-r4-guide.md)：除编译外其它六项用例工作流的用法与范围说明
- [管理员手册](admin-guide.md)：请管理员帮忙建团队、开权限、加测试环境或处理异常冻结时可对照
