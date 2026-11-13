---
nav_order: 3
---

# 管理员手册：成员授权、新增能力、升级和降级

> **适用范围与基线声明**：本手册面向部署并日常管理 Circle Hub 的管理员，基于已合入的 `hub-final`（`4a1fbdee57`）实装界面与命令编写；正在推进中的网页控制台一键表单、测试环境按团队隔离与在途请求原地升降级能力（参见[兼容矩阵](compatibility.md)），本文均逐项标明「当前可用入口」与「后续能力说明」，绝不把未合入设计写成现状。

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
     - 成员控制台**初始密码**（仅显示一次，首次登录 `/console/login` 必须修改）；
     - 24 小时有效的**一次性邀请码**（仅显示一次）；
     - 可直接写入客户端配置的 `mcp_servers` 条目（只含 `/mcp` 地址）。
   - **访问令牌**：仅在客户端不支持标准 MCP 连接确认时选用（填「令牌标签」方便区分多台设备），提交后同样仅显示一次完整令牌。
4. 把初始密码、MCP 地址与一次性邀请码发给成员本人（切勿写进仓库、群公共日志或命令行参数历史）。

### 2. 邀请码过期、补发令牌、停用或改密

- 在 `/console/team` 查看成员列表（所属团队、连接与启用状态）。
- 若成员的 24 小时邀请码过期或换了新客户端需要补发令牌：
  - *当前基线说明*：在 `4a1fbdee57` 上，`/console/team/<成员>` 详情页的「签发邀请码」「签发令牌」「调整工作流分配」按钮会弹出需要在服务器上运行的命令指引（向一键表单切换的工作已在开发对齐中）。管理员直接在运行 Hub 的主机执行对应命令即可：
    ```bash
    # 重新签发一次 24 小时一次性邀请码（仅标准输出显示一次）
    ./bin/circle-hub user invite <用户名>

    # 或签发独立访问令牌
    ./bin/circle-hub token issue <用户名> --label "workstation" --raw

    # 若需重置控制台密码
    ./bin/circle-hub user password-reset <用户名>
    ```
  - 停用与删人：`user disable <用户名>` 会让其现有令牌与会话立即失效；永久删除须先带确认预览再按 `usr_…` 执行（见 CLI `user delete` 指引）。

### 3. 建团队、拉成员并按团队分配能力

从控制台 `/console/teams` 建好团队、加入成员，或通过 CLI 一次完成：

```bash
# 1) 建团队并记下输出的团队编号 tm_…
./bin/circle-hub team create 研发一组
./bin/circle-hub team list

# 2) 把成员加进团队（同一成员可加入多个团队）
./bin/circle-hub team add <团队ID> <用户名>
./bin/circle-hub team show <团队ID>
```

随后按团队需求分别分配四类能力（成员具体怎么使用见[成员手册](member-guide.md)）：

| 能力类别 | 分配/启用做法（控制台 + CLI） | 说明 |
|---|---|---|
| **工作流（`workflow`）** | 控制台 `/console/teams` 或 CLI：<br>`./bin/circle-hub pack assign <工作流ID> --team=<团队ID>`<br>（也可直接分给个人：`pack assign <用户名> <工作流ID>`） | 例如 `test-bed`、`case-compile`、`case-review` 等；不传 `@版本号`，成员自动看到该工作流当前在架版本 |
| **通用技能（`skill`）** | 安装精确版本全站可见：<br>`./bin/circle-hub pack install <技能ID>@<版本>` | 通用技能（如 `mindmap-format`）仅发布还不生效，**必须 `install` 精确版本**；若采用包内 `tools/` 且未来转为团队范围核对时需按实际版本规矩维护 |
| **业务系统连接（`system`）** | 控制台 `/console/operations/system` 接入时选「使用对象：某个团队 / 全体 / 先不分配」；或 CLI：<br>`./bin/circle-hub resource add … --team=<团队ID>`<br>`./bin/circle-hub resource assign <资源ID> (--team=<团队ID> \| --all)` | 新建业务系统**默认先不分配**，不对任何成员（含管理员个人跑任务）开放；必须显式分配团队或 `--all`；命名密钥通过 `/console/operations/system` 密码框或 `secret set` 写入 |
| **产品知识库（`product`）** | 启用产品知识源 + 导入公共知识：<br>`./bin/circle-hub pack activate <产品ID>`<br>控制台 `/console/operations/knowledge` 或 CLI `knowledge sync --product <产品ID>` | 产品包须 `activate` 后才会出现在导入清单下拉里；工作流绑定的产品知识随工作流分配与产品启用对成员可用 |
| **自动化测试环境（`executor` / `bed`）** | 见下节「登记测试环境」：先做好 `doc put bed-topology`、`executor add`、`secret set`、`lease register` 与 `bed baseline record` | **当前权限边界提醒**：在 `4a1fbdee57` 基线上，Hub 只按租约键互斥与 `lease register --owner` 登记归属，**尚无「把某台执行器/测试环境只分给某个团队使用」的硬隔离命令**；目前谁被分配了 `test-bed` / 编译工作流，谁就能按空闲互斥预订环境（按团队隔离执行器授权的统一入口已提审并将在后续合入） |

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

> *当前基线提示*：`4a1fbdee57` 的控制台发布结果页尚不会自动弹出安装/分配表单（正在通过 N2 补齐），发布成功后请补做对应一步：

- **通用技能（`skill`）→ 必须安装精确版本**：
  ```bash
  ./bin/circle-hub pack install <技能ID>@<版本>
  ```
- **工作流（`workflow`）→ 首次须分配给团队，升版可按需退役旧版**：
  ```bash
  # 首次上线分给团队（之后升新小版不用重复 assign，已获权团队自动可见新版）
  ./bin/circle-hub pack assign <工作流ID> --team=<团队ID>

  # 升版后不再让新运行使用旧版时退役旧版（已有运行照常可看/可结束）
  ./bin/circle-hub pack retire <工作流ID>@<旧版本>
  ```
- 完成后可用 `./bin/circle-hub pack list` 核对状态（已发布 / 已安装 / 已退役）与分配范围。

### 2. 新增一个自动化测试环境

自动化测试环境由「命名清单文档 `bed-topology` + 命名密钥 + 执行器 `executor` + 租约前缀 + 干净基线」共同组成。在 `4a1fbdee57` 基线上，这部分在网页控制台 `/console/connections?tab=environments` 仅只读展示，登记与更新在运行 Hub 的服务器上按下面 5 步执行：

#### 第一步：更新并发布测试环境清单（`doc:doc:bed-topology`）

在 `<清单.json>` 中按 `test-bed-manifest@1` 格式写好该环境（参考仓库 `packs/workflow/test-bed/examples/bed-topology.json`，使用 `192.0.2.0/24` 文档网段或实机可核对网段）：包含环境 `name`、`devices[]`（每台设备的 `name`、`type`、网口地址 `ipv4`/`ipv6`）、`services[]` 与保留段 `reserved[]`（不要靠清单声明的 `installed` 当现行构建，实机构建由探针观察得出）。发布（或替换）命名文档：

```bash
./bin/circle-hub doc put bed-topology <清单.json>
./bin/circle-hub doc list
```

#### 第二步：写入执行器引用的命名密钥与普通变量

如果执行器定义 JSON 里使用了 `${secret:<大写密钥名>}` 或 `${var:<变量名>}`，先写入：

```bash
# 密文通过标准输入喂入，不写进命令行参数
printf '%s\n' '<合成口令>' | ./bin/circle-hub secret set --name <大写密钥名> --reason "register test environment"

# 若有普通变量（如绑定了清单 SHA-256 等非密文变量，值通过标准输入或 --file 传入）
printf '%s\n' '<值>' | ./bin/circle-hub var set <变量名> --text --not-secret --reason "bind manifest"
```

#### 第三步：登记执行器

准备好执行器定义 JSON（声明目标网关地址、写操作开关、只读版本探针、基线探针、前提认证证据等），执行：

```bash
./bin/circle-hub executor add <执行器定义.json>
./bin/circle-hub executor list
```

确认输出里 `启用 1`、`具备派发登记 1` 且无缺失变量/密钥（若后期要改定义，执行 `./bin/circle-hub executor update <exe_…> <新定义.json>`，停用用 `executor disable <exe_…>`）。

#### 第四步：登记租约前缀主人（按需指定归属）

若该环境归指定责任人管理归属与强制释放权，登记其租约前缀：

```bash
./bin/circle-hub lease register bed/<环境名>/ --owner <责任人用户名> --reason "initial bed registration"
./bin/circle-hub lease list --prefix bed/
```

#### 第五步：确认现场干净并录制环境基线

确认物理测试环境与网关就绪且**设备上没有残余测试配置**后，为声明了基线探针的执行器录制干净基线：

```bash
./bin/circle-hub bed baseline record <exe_…> --probe <探针id> --reason "clean baseline verified"
```

> 漏录基线或密钥/清单变量对不上时，成员在预订或脚本合并触发自动上机阶段会被拦下；若之前残留占用导致状态在 `/console/connections?tab=environments` 显示「已冻结」，现场核清并恢复设备后可执行 `./bin/circle-hub bed hold clear <exe_…> --reason "<理由>"`。

---

## 三、升级和降级

Hub 当前明确区分「**同一数据库结构基线内的部署切换 / 回退**」与「**跨不兼容基线（`needsRebuild`）的重建**」两条路线。操作前务必先确认新旧版本的[兼容矩阵](compatibility.md)与变更日志是否涉及结构变更。

> **重要现状诚实说明（`4a1fbdee57`）**：
> 在当前基线上，支持「成员在途会话不断线、免重新授权、在途请求自动重试、旧版本读新记录兼容提示」的**原地零中断升级与降级（N5）仍在方案审定与开发中**。截至本版，标准部署变更仍遵循「停写核查 → 备份/升级 → 失败按备份回滚」或「不兼容重建」规程；请不要在仍有活跃写入作业期间直接重启替换进程并期待在途状态自动衔接。

### 1. 同结构基线升级前核查与切换流程

1. **停写前核查在途运行与作业**（避免切到一半留下无法自动续跑或未知的设备作业）：
   ```bash
   ./bin/circle-hub run list
   ./bin/circle-hub lease list
   ./bin/circle-hub job list --executor <exe_…>
   ```
   如果有未终态或处于 `unknown` 的上机作业，先等其结束或通过 `job status <摘要>` / `job dispose <摘要> …` 处置闭环（或按需核对远端网关作业）；通知成员暂缓新开需要长时派发的上机编译。
2. **执行同机发行版升级（支持平台：macOS / Linux）**：
   - 使用发行版 `install.sh` 的单机部署，重复运行同一安装脚本即进入升级流程：部署过程会先对当前数据备份、切换新二进制并重启服务，若迁移或健康检查失败会自动回滚。
   - 如手工更新二进制并重启服务：停写 → 确保环境变量不含 `CIRCLE_HUB_TOKEN` → 更新文件并重新 `./bin/circle-hub serve --migrate-only`（或检查状态）→ 拉起服务。
3. **升级后核验清单**：
   ```bash
   curl -sS http://127.0.0.1:7420/healthz
   ./bin/circle-hub status
   ./bin/circle-hub pack list
   ./bin/circle-hub executor list
   ```
   若本次升级改动了仓库内工作流（如 `test-bed` 或 `case-compile`）或通用技能版本，按需额外运行 `pack publish --stage` + `pack install` / `pack retire` 让客户端重新拉取新版摘要。

### 2. 同结构降级 / 回退边界

- **升级当场失败**：由发行版升级机制按升级前备份与上一版发布包目录恢复并重启服务后，再检查 `/healthz` 与 `./bin/circle-hub records verify`（核对记录摘要）及 `--vault`（核对密库加解密）。
- **升级放写后想回退到上一个兼容版本**：
  1. **不能在数据库结构已发生变化的情况下直接拿旧版程序读写新库**；若两次版本仅调整应用层而不涉及不兼容模型/迁移变更，先冻结所有写入与在途作业，切换回旧兼容版本二进制并启动；
  2. 如果回退目标是升级前快照且升级后已有新增记录：请先用 `run list`、`job list` 与 `original list` 对账切分，确认是要丢弃增量恢复旧备份还是保留现有库继续往前修，切忌把两套时间线混成双写；
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
