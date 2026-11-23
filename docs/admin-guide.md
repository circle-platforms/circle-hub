---
nav_order: 3
---

# 管理员手册：成员授权、新增能力、升级和降级

> **适用范围与基线声明**：本手册面向部署并日常管理 Circle Hub 的管理员，基于 `wp/codex/integration` 收口基线编写（核对至冻结提交 `777fee3752`，含第一、二批实装控制台界面、平滑退场与基线 1 服务模型；参见[兼容矩阵](compatibility.md)）。注：对照实测中前半（步 1–14）运行在较早基线 `9d842b79e7ee` 上，后续管理员重做、平滑退场与重启核对运行在 `7c5f72c600` 上，文中对新旧行为差异与尚未实测重走的部分均已注明。控制台现已补齐工作流批量分配、通用技能安装/卸载、产品知识来源启用/停用、成员账户内联表单与视角预览，以及测试环境清单与执行器上传登记；但须特别留意：**测试环境按团队/账户的分配只决定成员的「我能做的事」与 `list_task_packs` 列出哪些测试环境，不作为预订或上机许可——谁能预订和上机按工作流的分配和预订规则判断，已获分配 `test-bed` 工作流的成员均可按既有规则预订测试环境**；在途请求平滑退场已支持（未入场请求返回 `503` 与 `Retry-After`，已受理请求及运行资料响应在预算内等待发完），且本版维持基线 1（未合入 `upgrade-production` / M2 自动升级路径），跨不兼容库结构仍走 `/console/rebuild` 与 `reset` 重建规程。

如果你还没有搭起实例、初始化首个管理员并建立基本配置，先走[十分钟上手](quickstart.md)完成初始化（或使用发行版 `install.sh` 一键安装 + `/console/setup` 完成首次初始化）。本手册接在「服务已启动、管理员已登录」之后，讲清楚日常最常做的三件事：

1. [加成员和分权限](#一加成员和分权限)
2. [加一个技能、工作流、测试环境](#二加一个技能工作流测试环境)
3. [升级和降级](#三升级和降级)

---

## 前置核对：第一次发布包与获取管理员控制台会话

1. **登录管理员控制台**：访问 `http://<Hub地址>/console/login`（启用内置 HTTPS 时访问 `https://<地址>/console/login`，并先让客户端系统信任 Hub 根证书）。首次使用初始密码登录时，页面会自动要求到 `/console/password` 改密。
2. **确认维护人有发布权**：即便是 `init-admin` 或 `/console/setup` 建出来的首位管理员，发布任何团队任务包前也必须先有发布权；若尚未授予，在运行 Hub 的机器上执行：
   ```bash
   ./bin/circle-hub pack grant-publish <管理员用户名>
   ```
3. **环境变量与操作令牌习惯**：当直接在本机 CLI 执行变更命令时，命令会自动读取 `<数据根>/keys` 下的私有操作令牌文件；而在终端准备启动 `./bin/circle-hub serve` 前，确认环境里没有残留 `CIRCLE_HUB_TOKEN`（`unset CIRCLE_HUB_TOKEN`），否则服务端会按安全边界拒绝启动。

---

## 一、加成员和分权限

### 先分清两个概念：团队 vs 公共空间

- **团队（`tm_…`）**：用来做**成员分组与授权范围**。一个成员可以同时加入多个团队，能用的工作流与业务系统取**所属团队与直接授权的并集**；删除团队会一并撤回该团队名下的工作流分配与资源分配，按原记录不可随同名新建团队复活。
- **公共空间（内部标识 `team`）**：全员共享的公共知识空间，与某个具体团队不同。普通成员在 `/console/team` 只能看到自己所属团队的名字，不会看到其他团队和管理员专属页面。

### 1. 在控制台添加成员并签发首次连接凭据

打开管理页 `/console/operations/member`（从顶部或团队管理入口进入）：

1. 填写 **用户名**（在控制台、记录和客户端中显示）。
2. 选择 **角色**：日常使用者选普通成员；仅运维管理者选管理员。
3. 选择 **连接方式**：
   - **邀请码（MCP 标准连接确认，推荐）**：适合支持标准 MCP 授权的客户端（例如 Circle）。提交后在结果页得到：
     - 成员控制台**初始密码**（仅显示一次；无过期倒计时，但首次登录 `/console/login` 必须到 `/console/password` 改密，改密后当前会话失效须用新密码重登）；
     - 24 小时有效的**一次性邀请码**（仅显示一次，用过一次即作废）；
     - 一段 `mcpServers` 示例片段。
     - 给 Circle 成员发送 `mcpServers` 配置片段。保留 `placeholders`，让技能工具能使用 `%HUB_URL%` 和 `%HUB_TOKEN%`。成员在 MCP 连接授权页输入邀请码。
   - **访问令牌**：仅在客户端不支持标准 MCP 连接确认时选用（填「令牌标签」方便区分多台设备），提交后同样仅显示一次完整令牌。
4. 把初始密码、MCP 地址、一次性邀请码及上述连接提示发给成员本人（实测建议先写入权限设为 `0600` 的临时交接文件，成员登录改密后再删除，切勿写进仓库、群公共日志或命令行参数历史）；同时按客户端类型附带实测避坑提示：
   - **Circle 桌面版**：在 MCP 服务器页面添加连接，按提示打开授权页。
   - **Circle 终端版**：按[成员手册](member-guide.md)配置 `mcpServers`，运行 `/mcp reload` 后按提示登录。

### 2. 邀请码过期、补发令牌、停用或改密

- 在 `/console/team`（默认展示「团队」页签，管理员可切到 `?tab=members`「成员」或 `?tab=clients`「已连接的客户端」页签）查看成员列表、所属团队与启用状态。
- **在网页控制台直接操作**：点开某个成员进入详情页 `/console/team/<成员>`，新版控制台已在页面内提供以下内联表单卡片（注：较早基线 `9d842b79` 实测时控制台尚无重发邀请码/重置密码表单，当时需上主机执行 CLI；新版 `7c5f72c6+` 代码已合入下列表单，但在近期管理员重做测试中尚未单独复测一遍）：
  - **启用 / 停用账户**（停用后该成员现有令牌与登录会话立即失效）；
  - **签发邀请码**（为已有成员重新签发 24 小时一次性邀请码，仅在结果页显示一次）；
  - **签发客户端访问令牌**（可填写设备标签，仅在结果页显示一次）；
  - **重置密码**（为成员重设控制台登录密码）；
  - **加入 / 移出使用范围**（直接向该成员个人分配或取消工作流）；
  - **按这个成员的视角看**（跳转到 `/console/me?user=<id>`，以管理员身份预览该成员实际可见的团队、工作流、通用技能、连接与分配给该成员的测试环境）。
- 仅「调整发布权」（`pack grant-publish` / `revoke-publish`）与「删除成员」（须先确认预览再按 `usr_…` 永久删除）在详情页仍以命令行弹窗给出指引；若需脚本化或在运行 Hub 的主机执行，也可使用对应 CLI 命令：
  ```bash
  # 重新签发一次 24 小时一次性邀请码（仅标准输出显示一次）
  ./bin/circle-hub user invite <用户名>

  # 签发独立访问令牌
  ./bin/circle-hub token issue <用户名> --label "workstation" --raw

  # 重置控制台密码 / 停用成员
  ./bin/circle-hub user password-reset <用户名>
  ./bin/circle-hub user disable <用户名>
  ```

### 3. 建团队、拉成员并按团队分配能力

从控制台 `/console/teams` 建好团队、加入成员，或通过 CLI 一次完成：

```bash
# 1) 建团队；后面的命令用团队的名字指代它（也接受团队编号）
./bin/circle-hub team create 研发一组
./bin/circle-hub team list

# 2) 把成员加进团队（同一成员可加入多个团队）
./bin/circle-hub team add <团队名> <用户名>
./bin/circle-hub team show <团队名>
```

> **控制台与 CLI 实测说明**：
> - 管理操作结果页现已把 `usr_…`、`tm_…`、`exe_…`、`res_…` 等内部编号脱敏替换为可读名称；
> - 进入 `/console/teams/<团队ID>`（或 `/console/team/<团队ID>`）后，页面下方提供 **`批量分配工作流`** 多选卡片，可一次勾选多个工作流分配给该团队，列表中也可单行直接「分配 / 撤回」工作流或撤回团队业务系统连接；
> - 欲从控制台核对某成员最终实际拿到的工作流、连接与环境预览，点击 `/console/team/<成员>` 的 **按这个成员的视角看**（`/console/me?user=<id>`）；
> - 在运行 Hub 的主机上使用管理员操作令牌时，只读 CLI 命令（如 `resource list --as <成员>`）会被拒绝（有令牌时只按令牌所属账户读取）；`team list` 只显示名字，查看绑定明细用 `team show <团队名>`；命令里要写团队的地方都可以写名字，有重名的团队时到控制台操作。

> **给新成员一次配齐一项工作**：一项工作往往要用到几个工作流（脑图编译至少要 `test-bed`、`recompose`、`case-compile`，再加上部署里与它们配套的复核和裁定工作流），少分一个，成员要做到那一步才被告知缺它。把这些工作流都分配给同一个团队，新成员加入这个团队就全有了，不必逐个分给个人；撤回某个人的个人分配不影响他经团队得到的工作流。工作流依赖的通用技能（例如 `case-compile` 默认判断方式要用的 `plumb`）发布后还要 `pack install` 精确版本，否则成员在客户端装不上。成员一侧还需要的 Plumb 地址、模型名和密钥，或者 Jev 密钥，由管理员发放，见[成员手册](member-guide.md)的「开始之前」。`case-compile` 3.26.9 内嵌 `jev-judge@1.0.0` 的客户端模块，所以发布 `case-compile` 之前要先在这个 Hub 上发布 `jev-judge@1.0.0`，否则发布被拒（`embeds.skill_missing`）；成员不用安装 `jev-judge`，选 Jev 时只要有客户端密钥 `JEV_API_KEY`，`jev-judge` 技能的命令行工具即使装了，客户端的守卫也不放行。选 Jev 的编译会把原始用例的步骤、写出的命令和手册片段发到 TypeSafe（所有者 2026-11-23 定，只限编译的命令核验和场景保真审计）；Jev 密钥是成员自己的客户端密钥，Hub 不保存也不使用它。

随后按团队需求分别分配能力（成员具体怎么使用见[成员手册](member-guide.md)）：

| 能力类别 | 分配/启用做法（控制台 + CLI） | 当前限制与说明 |
|---|---|---|
| **工作流（`workflow`）** | 控制台 `/console/teams/<团队ID>` 支持 **`批量分配工作流`**，工作流详情页 `/console/workflows/<工作流ID>` 与发布结果页支持「分配给团队」；或 CLI：<br>`./bin/circle-hub pack assign <工作流ID> --team=<团队名>`<br>（也可直接分给个人：`pack assign <用户名> <工作流ID>`） | 例如 `test-bed`、`case-compile`、`case-compile-criterion-review` 等；不传 `@版本号`，成员自动看到在架版本；控制台工作流详情页「使用范围」现已直接显示 `团队 <名>` |
| **通用技能（`skill`）** | 发布结果页可点 **立即安装**，或进入 `/console/skills/<技能ID>` 在「安装这个版本」卡片点 **安装** /「卸载通用技能」卡片点 **卸载**（或 **退役这个版本**）；也可主机 CLI：<br>`./bin/circle-hub pack install <技能ID>@<版本>` | 通用技能仅发布不生效，必须 `install` 精确版本；**当前仍不支持按团队分配，一经安装对全站所有成员可见**（如格式化等通用技能无团队隔离） |
| **业务系统连接（`system`）** | 控制台 `/console/operations/system` 接入时选「使用对象：某个团队 / 全体 / 先不分配」，或在 `/console/teams/<团队ID>` 分配/撤回团队连接；或 CLI：<br>`./bin/circle-hub resource add … --team=<团队名>`<br>`./bin/circle-hub resource assign <资源ID> (--team=<团队名> \| --all)` | 新建连接默认先不分配；**防坑提醒**：若连接已分给**全体**（`--all`），再追加分配给某团队**不会产生隔离效果**（未加入该团队的成员照样可见可用），且控制台当前**尚无「撤回全体（`--all`）」表单**，团队页仅能撤回单个团队授权，撤回 `--all` 仍须在主机执行 `./bin/circle-hub resource unassign <资源ID> --all` |
| **产品知识库（`product`）** | 发布结果页可点 **启用** 并跳转 `/console/operations/knowledge` 导入，或从 `/console/knowledge/products` 点开对应产品（`/console/workflows/<产品ID>`）点 **启用产品知识来源 / 停用产品知识来源**；也可主机 CLI：<br>`./bin/circle-hub pack activate <产品ID>`<br>`./bin/circle-hub knowledge sync --product <产品ID>` | 产品包 `activate` 对**整个 Hub 生效**（不支持按团队隔离）；必须先启用后才会出现在知识导入页面的产品下拉里 |
| **自动化测试环境（`executor` / `bed`）** | 控制台 `/console/connections?tab=environments` 已提供上传 `bed-topology`（`doc-put`）、上传新增执行器（`executor-add`）及按目标分组分配（`executor-assign`）表单；普通变量 `var set`、修改/停用执行器、租约前缀 `lease register` 与干净基线 `bed baseline record` 见下节主机 CLI 步骤 | **测试环境的分配只决定成员的「我能做的事」和能力投影列出哪些测试环境，不按环境分配限制或授予预订权**：谁能预订和上机按工作流的分配和预订规则判断——**已获分配 `test-bed` 工作流的成员均可按既有租约归属与基线/就绪核对规则预订任何可用测试环境**（不能靠环境分配控制权限） |

---

## 二、加一个技能、工作流、测试环境

本节面向「我要新增一套任务包或新接入一台测试环境上线给团队用」的场景；如果你是要修改仓库里已有工作流或技能的文字/规则并升级版本，请同步对照[改一个工作流或技能怎么做](edit-pack.md)。

### 1. 新增一个通用技能（`skill`）或工作流（`workflow`）

#### 第一步：准备包目录与校验清单

1. **目录与必须文件**：
   - **通用技能（`skill`）**：至少含合法的 `pack.json`（`schema: "pack@1"`、`kind: "skill"`、`id`、`version`、`title`、`description`、`files`）与 `SKILL.md` 及对应声明文件；
   - **工作流（`workflow`）**：含 `pack.json`（`kind: "workflow"`）、`workflow.json`、`requirements.json`、`checks.json`、`slots.schema.json`、`SKILL.md`、`functions/`、`samples/{positive,negative}/` 等（且 `files` 列齐所有运行期文件及其精确 SHA-256 与字节数）。
2. **若在仓库内新增或修改包**，用仓库工具刷写并自检清单：
   ```bash
   node tools/prepare-packs.ts packs/<类型>/<包ID>
   node --test "packs/<类型>/<包ID>/**/*.test.ts"
   ```

#### 第二步：通过网页控制台上传发布（或本机 CLI 发布）

- **方式 A — 网页控制台上传 `.zip`**：
  1. 打压缩包：两种打包方式均可——把 `pack.json` 与文件直接放在 `.zip` 根目录，**或者**把整个包文件夹直接压成只含一个顶层目录的 `.zip`（macOS Finder「压缩」与 `zip -r` 默认格式，`unpackZip` 会自动剥离顶层目录并忽略 `__MACOSX`）；**禁止**加密 zip、ZIP64 与符号链接。
  2. 打开 `/console/operations/pack?kind=skill`（或 `?kind=workflow`），选择 `.zip` 上传，点击 **上传并校验**（试校验，暂存 30 分钟且仅提交人可见）。
  3. 试校验显示样例与结构全部通过后，点击页面下方 **发布** 按钮完成入库。
- **方式 B — 运行 Hub 的主机直接 `--stage` 发布**：
  ```bash
  ./bin/circle-hub pack publish <包目录> --stage --dry-run
  ./bin/circle-hub pack publish <包目录> --stage
  ```
  > 务必带 `--stage`（若包目录里留有 `README.md`、`*.test.ts` 或打包脚本，不带 `--stage` 会因目录有清单未列出的文件而被拒绝）。

#### 第三步：切记完成「发布后生效动作」（仅 `publish` 不会自动可用）

在网页控制台 `/console/operations/pack` 点击发布后，**结果页现已直接提供对应的后续动作表单/入口**（也可以稍后到包详情页或主机 CLI 执行）：

- **通用技能（`skill`）→ 必须安装精确版本**：发布结果页直接提供 **立即安装** 按钮，或在 `/console/skills/<技能ID>` 的「安装这个版本」卡片点击 **安装**（需要下线时同页在「卸载通用技能」卡片点击 **卸载**，或点 **退役这个版本**）；主机 CLI 等价命令：
  ```bash
  ./bin/circle-hub pack install <技能ID>@<版本>
  ```
- **工作流（`workflow`）→ 首次须分配给团队；升版按需退役旧版并核对执行器 `proof.warrant_id`**：发布结果页直接提供 **分配给团队** 下拉表单，也可到 `/console/workflows/<工作流ID>` 分配或点 **退役这个版本**，或在 `/console/teams/<团队ID>` 批量勾选多个工作流；主机 CLI 等价命令：
  ```bash
  # 首次上线分给团队（之后升新小版不用重复 assign，已获权团队自动可见新版）
  ./bin/circle-hub pack assign <工作流ID> --team=<团队名>

  # 升版后不再让新运行使用旧版时退役旧版（已有运行照常可看/可结束）
  ./bin/circle-hub pack retire <工作流ID>@<旧版本>
  ```
  > **升版必查（核验函数身份与执行器同步）**：若新版工作流更改了版本号（如 `case-compile` 从 `3.19.1` 升到 `3.20.1`），Hub 产出的核验事实主张携带 `warrant.id = "<包ID>.<检查ID>@<版本号>"`（例如 `case-compile.workbook_verified@3.20.1`），自动上机放行阶段会严格比对「核验函数身份等于执行器指定身份」（`hub/dispatch/proof.ts`）。若执行器定义里的 `proof.warrant_id` 仍钉在旧版本上，成员脚本合并后会被放行门禁直接拦下；请同步到主机用 `./bin/circle-hub executor update <exe_…> <新定义.json>` 更新对应执行器（如约束了生成器也一并更新 `effects` 条件）。`pack publish` 发布工作流后会逐个列出仍指定别的版本的启用执行器（写明是哪个测试环境）和该改成的身份，`executor list` 也会列出；因此被拒的上机验证，管理员读到的答复写明执行器指定的版本、这次核验所用的版本和要执行的命令，成员读到的写哪一侧落后、该找谁。
- **产品知识库（`product`）→ 先启用再导入知识**：发布结果页提供 **启用** 按钮与 **去导入公共知识** 链接（`/console/operations/knowledge`），从 `/console/knowledge/products` 进入产品详情页（`/console/workflows/<产品ID>`）也提供 **启用产品知识来源 / 停用产品知识来源** 按钮。
- **业务系统适配器（`system`）→ 接入实例**：发布结果页提供 **立即接入** 按钮，直接带 `system_pack` 参数跳转到 `/console/operations/system`。
- 完成后可用控制台对应列表页或 `./bin/circle-hub pack list` 核对状态（已发布 / 已安装 / 已退役）与使用范围。

### 2. 新增一个自动化测试环境

自动化测试环境由「命名清单文档 `bed-topology` + 命名密钥/普通变量 + 执行器 `executor` + 租约前缀 + 干净基线」共同组成。在当前基线上：**上传环境清单、上传新增执行器、设置命名密钥以及分配执行器，都已可直接通过网页控制台完成，无需登录 Hub 主机**；而普通变量（`var set`）、**修改或停用既有执行器**、登记租约前缀主人、录制干净基线与解除冻结仍须通过主机 CLI 执行（或按详情页命令指引复制执行）。注：全套准备流程（不含仅预览的环境分配、重复试错及 `grant-publish`）共约十余项逻辑动作，完成后只要成员已被分配 `test-bed` 工作流即可发起预订（无需也不能以环境分配放权）。

#### 第一步：上传并登记测试环境清单（`doc:doc:bed-topology`）

在 `<清单.json>` 中按 `test-bed-manifest@1` 格式写好该环境（参考仓库 `packs/workflow/test-bed/examples/bed-topology.json`，使用 `192.0.2.0/24` 文档网段或实机可核对网段）：包含环境 `name`、`devices[]`（每台设备的 `name`、`type`、网口地址 `ipv4`/`ipv6`）、`services[]` 与保留段 `reserved[]`（不要靠清单声明的 `installed` 当现行构建，实机构建由探针观察得出）。

- **方式 A — 网页控制台上传（无需上主机）**：打开 `/console/connections?tab=environments`，在 **登记或更新环境清单** 卡片保持文档名为 `bed-topology`，选择本地 `<清单.json>` 点击 **登记清单**（表单会先经已有上传入口转为原件引用后交给命令桥，不在服务器落地临时文件，也不要求填写主机路径）。
- **方式 B — 主机 CLI**：
  ```bash
  ./bin/circle-hub doc put bed-topology <清单.json>
  ./bin/circle-hub doc list
  ```

#### 第二步：写入执行器引用的命名密钥与普通变量

如果执行器定义 JSON 里使用了 `${secret:<大写密钥名>}` 或 `${var:<变量名>}`，先写入：

- **命名密钥（控制台或主机 CLI）**：可在 `/console/settings`「凭据」页签下方的 **设置凭据** 卡片填写（内容仅进密钥库，不进命令参数与页面），或在主机上经标准输入喂入：
  ```bash
  # 密文通过标准输入喂入，不写进命令行参数
  printf '%s\n' '<合成口令>' | ./bin/circle-hub secret set --name <大写密钥名> --reason "register test environment"
  ```
- **普通变量（主机 CLI）**：如果执行器引用了普通变量（如绑定清单 SHA-256），控制台暂不直接配置变量值，请在主机 CLI 执行：
  ```bash
  printf '%s\n' '<值>' | ./bin/circle-hub var set <变量名> --text --not-secret --reason "bind manifest"
  ```

#### 第三步：上传登记执行器（及按目标分配）

准备好执行器定义 JSON（参照仓库 `hub/dispatch/testing/` 夹具写法：声明目标网关地址、写操作开关、只读版本探针、基线探针、前提认证证据、以及对齐当前工作流版本的 `proof.warrant_id` 等；若网关采用 `https://` 端点必须同时配置固定 CA 证书——新版 `7c5f72c6+` 校验失败时已会指出 `/endpoint`、`/ca` 等具体字段路径并附 CLI 用法，如在更早基线上未带路径则逐项核对）：

- **方式 A — 网页控制台首次上传新增（无需上主机）**：在 `/console/connections?tab=environments` 的 **登记测试环境执行器** 卡片上传 `<执行器定义.json>` 并点击 **登记执行器**。页面下方会按环境 `target` 分组展示已登记执行器（**注意**：每组下方的「分配所选」表单可把同组多个执行器分给同一团队或账户；**分配只决定成员的「我能做的事」列出哪些测试环境，成员能否预订和上机按工作流的分配和预订规则判断**）。
  > **防坑警告（控制台重填会新增第二个同名执行器！）**：控制台的「登记测试环境执行器」卡片是**新增（`add`）**而不是覆盖更新。如果对已有环境在控制台再上传一次，会在该环境下面**多出第二个同名执行器记录**，而原执行器保持不变！登记错了或需要改定义（例如换 `endpoint`/`ca`、修变量引用或升版后同步 `proof.warrant_id`），请直接上主机用下面的 `executor update`（并按需用 `executor disable` 停掉多余记录）。
- **方式 B — 主机 CLI 登记与后续更新/停用（改定义只能走这里）**：
  ```bash
  ./bin/circle-hub executor add <执行器定义.json> --name=<管理员明确指定的执行器名字>
  ./bin/circle-hub executor list
  ```
  确认输出里 `启用 1`、`具备派发登记 1` 且无缺失变量/密钥（同时留意同一 `target` 下没有误建重复记录）。需要修改已有执行器定义或停用执行器时，在主机执行 `./bin/circle-hub executor update <exe_…> <新定义.json>` 或 `./bin/circle-hub executor disable <exe_…>`（详情页「停用…」仅弹出命令指引）。

#### 第四步：在主机登记租约前缀主人（按需指定强释与归属）

若该环境归指定责任人管理归属与强制释放权，控制台环境页目前未单独挂出该表，请在运行 Hub 的主机执行：

```bash
./bin/circle-hub lease register bed/<环境名>/ --owner <责任人用户名> --reason "initial bed registration"
./bin/circle-hub lease list --prefix bed/
```

#### 第五步：确认现场干净并在主机录制环境基线

确认物理测试环境与网关就绪且**设备上没有残余测试配置**后，在主机上为声明了基线探针的执行器录制干净基线（控制台当前同样未挂出单独基线表单）：

```bash
./bin/circle-hub bed baseline record <exe_…> --probe <探针id> --reason "clean baseline verified"
```

> 漏录基线或密钥/清单变量对不上时，成员在预订或脚本合并触发自动上机阶段会被拦下；若之前残留占用导致状态在 `/console/connections?tab=environments` 显示「已冻结」，可在环境详情里点开 **确认已恢复…** / **处置派发结果…** 命令指引对话框，并在现场核清恢复设备后到主机执行 `./bin/circle-hub bed hold clear <exe_…> --reason "<理由>"` 或 `job dispose`。

---

## 三、升级和降级

Hub 当前明确区分「**同一数据库结构基线内的部署切换 / 回退**」与「**跨不兼容基线（`needsRebuild`）的重建**」两条路线。操作前务必先确认新旧版本的[兼容矩阵](compatibility.md)与变更日志是否涉及结构变更。

> **重要现状诚实说明（`wp/codex/integration` 收口基线）**：
> - **已合入的平滑退场能力**：服务端关停时会在关闭预算（`closeTimeoutMs` 默认 `10` 秒 + `closeGraceMs` 默认 `15` 秒）内等待已受理的 MCP 请求和运行资料响应完整发送，会主动关闭装配持有的租约连接池（实测等待进行中的 `start_run` 答完共用 `5.2` 秒即退出），并在关停期间对尚未进入入场流程的新请求返回 **`HTTP 503` 与 `Retry-After`**；
> - **仍未改变的边界**：不宣称进程被任意强杀后或真实测试设备状态能跨重启自动恢复；在进程真正退出的短暂 `ECONNREFUSED` 切换窗口内，仅 `case-compile 3.19.2+`（`recompose 1.2.4+`）本地工具对读类调用与明确未执行的 `503` 会自动退避最多 `60` 秒，更早版本或跨超最大等待窗口的调用仍需重跑；**本版维持数据库基线 1（未启用 `upgrade-production` / M2 自动升级），涉及数据库结构变化的版本不支持跨版原地升级或降级**，仍走 `/console/rebuild`（`needsRebuild`）与 `reset` 重建规程。请尽量在无活跃长时上机写入前安排切换。

### 1. 先核清当前实例的部署方式，再选升级命令

**重要前置事实（来自实机切换核查）**：`./bin/circle-hub deploy` 与 `./bin/circle-hub rollback` **只适用于由平台命令本身部署管理、且使用平台用户级服务单元的单机实例**：
- 若用 `./bin/circle-hub status` 查得「`当前发布：没有`」且数据根下 `releases/` 为空（例如实例是通过手写系统级 systemd 单元指定外部发布目录部署的），**不要直接运行 `circle-hub deploy`**：`deploy` 会将其当成全新首次部署，尝试在同一系统账户下另建固定名字的用户级单元（`io.github.circle-platforms.circle-hub`）去争抢同一端口并执行全库备份；同时同一操作系统账户只能托管一个平台管理单元（且平台生成单元的 Node 堆内存上限为 8 GB，手写大内存单元不可直接盲替）。
- 平台的 `rollback` 也是按 `deploy` 留下的**升级前备份**还原数据并切回旧版，**不是**「保持升级后数据不动直接装回上一版程序」，无 `deploy` 历史记录时会直接拒绝。

#### 停写前核查在途运行与作业（所有部署方式必做）

```bash
./bin/circle-hub run list
./bin/circle-hub lease list
./bin/circle-hub job list --executor <exe_…>
```

如果有未终态或处于 `unknown` 的上机作业，先等其结束或通过 `job status <摘要>` / `job dispose <摘要> …` 处置闭环（或按需核对远端网关作业）；通知成员暂缓新开需要长时派发的上机编译。

#### 路线 A：平台命令托管的单机实例（支持平台：macOS / Linux）

使用发行版 `install.sh` / `circle-hub deploy` 建立的单机部署，按平台流程重复执行新版安装/部署即进入标准升级：流程会停服务 → 在停机窗口做 pre-deploy 备份 → 切换 `current` → 迁移并拉起服务，若迁移或 `/healthz` 失败自动回滚。

#### 路线 B：系统级 systemd 单元 + 独立发布目录的同结构切换（无数据库迁移时）

1. 先核对新旧版本[兼容矩阵](compatibility.md)确认**无结构迁移 / 不涉及 `needsRebuild`**，保留原有服务单元文件文本副本、数据目录、数据库与密钥库均不动；
2. 停止服务（`systemctl stop <服务单元>`；新版本会在 `closeTimeoutMs` 默认 `10` 秒 + `closeGraceMs` 默认 `15` 秒窗口内等在途请求答完并主动释放数据库连接池——实测等进行中的 `start_run` 仅耗时 `5.2` 秒即退出；**注**：旧版 `9d842b79` 曾出现的约 30 秒停机并非等待在途请求，而是 `pg.Pool` 空闲超时 `idleTimeoutMillis: 30_000` 未关闭所致）；
3. 确认环境变量不含 `CIRCLE_HUB_TOKEN`，将单元内 `WorkingDirectory` 与 `ExecStart` 指向新版本发布目录（若该版带包内迁移可先核对状态/`--migrate-only`）；
4. 执行 `systemctl daemon-reload && systemctl start <服务单元>`。

#### 升级后核验清单与成员侧预期

```bash
curl -sS http://127.0.0.1:7420/healthz
./bin/circle-hub status
./bin/circle-hub pack list
./bin/circle-hub executor list
```

- 确认 `/healthz` 返回的 `release` 与目标提交/版本一致；若改动了工作流或通用技能版本，按需补做 `pack publish --stage` + `pack install` / `pack retire`；**若工作流（如 `case-compile`）升了版本号，别忘了同步对照执行器定义中的 `proof.warrant_id`（例如 `case-compile.workbook_verified@<新版本>`），必要时执行 `./bin/circle-hub executor update <exe_…> <新定义.json>`，否则成员上机放行会报核验函数身份不符**；发布时和 `executor list` 里列出的“指定的核验函数是…”就是要改的执行器，一个工作流有几个测试环境的执行器时要逐个改。
- **服务停机与重启期间影响预期**：在服务进入关闭阶段到重新拉起期间，Hub 会在关闭预算内等待已受理请求与正在传输的运行资料响应发完，未入场的新请求会收到 `HTTP 503` 与 `Retry-After`；进程真正切换的 `ECONNREFUSED` 短暂窗口内，`case-compile 3.19.2+` / `recompose 1.2.4+` 本地工具对读类调用与明确未执行的 `503` 会自动退避最多 `60` 秒，更早版本仍会报错须等服务恢复后重跑。服务拉起后首轮读取会短暂变慢，随后恢复正常；**成员已持有的访问令牌全部有效、已连接的 Circle 会话无需重新登录或重新连接（仅内存中的控制台网页登录会话会被清空，网页端需重新登录）**。

### 2. 同结构降级 / 回退边界

- **由平台 `deploy` 管理的实例**：按升级前 `pre-deploy` 备份恢复到上一版后，再检查 `/healthz`、`./bin/circle-hub records verify`（核对记录摘要）及 `--vault`（核对密库加解密）。
- **手写系统单元在不改数据结构的前提下原地回退**：
  1. **不能在数据库结构已发生变化的情况下直接拿旧版程序读写新库**；若两版数据库结构完全兼容（例如回退两版仅界面或文字差异），停写并停服务后将单元的 `WorkingDirectory` 与 `ExecStart` 改回上一版发布目录、`daemon-reload` 并重启即可（不动库与密钥库，也不用 `rollback` 覆盖新产生的数据）；
  2. 若回退目标是旧数据库快照且期间已有新增写入：先用 `run list`、`job list` 与 `original list` 对账切分，确认要丢弃增量恢复旧备份还是保留现有库继续往前修，切忌把两套时间线混成双写；
  3. 仅依赖恢复旧数据库备份时，同时核对 `keys/` 与 `vault/` 是否改动、在旧备份时刻之后新发布的任务包是否仍存在于对象存储。

### 3. 若遇不兼容变更进入「需要重建（`needsRebuild`）」

如果新版本改变了数据库结构或基线版本，启动时会进入只读的「需要重建」提示页（`/console/rebuild`）。此时不要强行降级或手改数据库表，按[重置和重建](reset.md)执行标准路线：

- **同一基线保留配置重装**：`./bin/circle-hub reset --scope <history|knowledge|packs|all> --keep-config`（导出受保护快照并在新库恢复；注意 `--scope` 必填，见[reset.md 说明](reset.md#每个范围清掉什么、留下什么)）；
- **跨不兼容基线正式三步恢复**：
  1. `./bin/circle-hub reset --scope all`（保留 `keys/` 与 `vault/` 不删）
  2. `./bin/circle-hub init-admin <管理员> --password-stdin`（原子替换失效操作令牌文件）
  3. `./bin/circle-hub apply <部署定义.json>`，然后按 [reset.md — 重建之后要补登记的东西（F1–F13）](reset.md#重建之后要补登记的东西) 逐项补写 `doc put`、历史证据原件、`bed baseline record` 并重发成员客户端邀请。

---

## 相关页面

- [十分钟上手](quickstart.md)：零起步初始化实验目录、系统接入与最小跑通
- [改一个工作流或技能怎么做](edit-pack.md)：包内版本号、摘要重算与内嵌技能联动
- [重置和重建](reset.md)：四作用域重置、三步恢复路径与重建后 F1–F13 补登清单
- [成员手册](member-guide.md)：普通成员如何登录、看权限、占测试环境与完成用例编译
