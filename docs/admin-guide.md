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
     - 成员控制台**初始密码**（仅显示一次；无过期倒计时，但首次登录 `/console/login` 必须到 `/console/password` 改密，改密后当前会话失效须用新密码重登）；
     - 24 小时有效的**一次性邀请码**（仅显示一次，用过一次即作废）；
     - 一段 `mcp_servers` 示例片段。
     - **发给终端版 Circle 成员时的注意**：在 `4a1fbdee57` 上，添加成员结果页与成员 `/console/settings#mine` 给出的片段名是 `"circle-hub"` 且**不带 `placeholders`**，结果页文字还会带有内部编号与 CLI 提示。如果成员用的是**终端版 Circle**（需运行技能本地工具），按该片段写入配置会导致 `%HUB_URL%`、`%HUB_TOKEN%` 无法展开；请指引成员改用 **Circle 桌面版 Hub 连接卡片**（自动带全配置），或在终端配置里改写为 `"name": "Hub"` 并加上 `"placeholders": {"url": "HUB_URL", "token": "HUB_TOKEN"}`（详见[成员手册](member-guide.md)）。
   - **访问令牌**：仅在客户端不支持标准 MCP 连接确认时选用（填「令牌标签」方便区分多台设备），提交后同样仅显示一次完整令牌。
4. 把初始密码、MCP 地址、一次性邀请码及上述连接提示发给成员本人（切勿写进仓库、群公共日志或命令行参数历史）。

### 2. 邀请码过期、补发令牌、停用或改密

- 在 `/console/team` 查看成员列表（所属团队、连接与启用状态）。
- **在 `4a1fbdee57` 上的实际操作边界**：
  - `/console/operations` 页面标题虽然自称只执行四种操作，实际团队创建、加人、分工作流/连接、改密、设密钥、导知识等都已有控制台表单；
  - 反过来，给**已有成员**重新签发 24 小时邀请码、补发访问令牌，以及安装技能、启用产品知识源、登记测试环境，`4a1fbdee57` 的 `/console/team/<成员>` 等详情页按钮目前只会弹出命令指引（向全表单切换的 N2 正在对齐），仍须管理员到运行 Hub 的主机执行：
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

> **实测核对提示（`4a1fbdee57`）**：控制台的加人与分工作流结果页目前还会直接写出内部 `usr_…` / `tm_…` 编号；且在团队详情页分配工作流和业务系统连接**一次只能提交一项**（10 个工作流要提交 10 次并每次返回，支持按组多选的 N2 表单在后续跟进中）。若要快速检查团队汇总，CLI `team list` 只显示编号与名字，需 `team show <团队ID>` 查看绑定项；另外使用管理员令牌执行 `resource list --as <成员>` 会被拒绝（有令牌时只读命令只以令牌所属账号读取），且控制台 `/console/team/<成员>` 在此基线上尚不展示有效连接、知识与测试环境。

随后按团队需求分别分配能力（成员具体怎么使用见[成员手册](member-guide.md)）：

| 能力类别 | 分配/启用做法（控制台 + CLI） | 实测限制与说明 |
|---|---|---|
| **工作流（`workflow`）** | 控制台 `/console/teams`（当前一次一条）或 CLI：<br>`./bin/circle-hub pack assign <工作流ID> --team=<团队ID>`<br>（也可直接分给个人：`pack assign <用户名> <工作流ID>`） | 例如 `test-bed`、`case-compile`、`case-compile-criterion-review` 等；不传 `@版本号`，成员自动看到在架版本；`pack list` 当前把团队分配展开成成员名而非团队名 |
| **通用技能（`skill`）** | **当前不支持按团队分配，且控制台无安装表单**；管理员须在 Hub 主机执行：<br>`./bin/circle-hub pack install <技能ID>@<版本>` | 通用技能仅发布不生效，必须 `install` 精确版本；**一经安装对全站所有成员可见**（如 `mindmap-format` 等 8 个格式技能无团队隔离） |
| **业务系统连接（`system`）** | 控制台 `/console/operations/system` 接入时选「使用对象：某个团队 / 全体 / 先不分配」；或 CLI：<br>`./bin/circle-hub resource add … --team=<团队ID>`<br>`./bin/circle-hub resource assign <资源ID> (--team=<团队ID> \| --all)` | 新建连接默认先不分配；**防坑提醒**：若连接已分给**全体**（`--all`），再追加分配给某团队**不会产生隔离效果**（未加入该团队的成员照样可见可用），且 `4a1fbdee57` 控制台尚无「撤回全体」表单，须在主机执行 `./bin/circle-hub resource unassign <资源ID> --all` |
| **产品知识库（`product`）** | **当前不支持按团队分配，且控制台仅显示命令指引**；须在 Hub 主机启用整站产品源后，再到控制台 `/console/operations/knowledge` 或 CLI 导入：<br>`./bin/circle-hub pack activate <产品ID>`<br>`./bin/circle-hub knowledge sync --product <产品ID>` | 产品包 `activate` 对**整个 Hub 生效**；必须先在主机 `activate` 后才会出现在知识导入页面下拉里 |
| **自动化测试环境（`executor` / `bed`）** | 见下节「登记测试环境」：先在主机做好 `doc put bed-topology`、`executor add`、`secret set`、`lease register` 与 `bed baseline record` | **当前权限边界（`4a1fbdee57`）**：Hub 此时尚无「按团队隔离测试环境」守卫，`lease register --owner` 只决定谁能注销和强释；**只要被分配了 `test-bed` 工作流，就能预订清单里的测试环境**（按团队隔离执行器授权与控制态表单正在合入中） |

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

准备好执行器定义 JSON（当前基线无控制台上传表单或下载模板，可参照仓库 `hub/dispatch/testing/` 夹具写法自行整理约 40 个字段：声明目标网关地址、写操作开关、只读版本探针、基线探针、前提认证证据等；若网关采用 `https://` 端点，必须同时配置固定 CA 证书，且若格式被拒时当前 CLI 报错可能不带字段路径，须逐项核对 `endpoint` 与 CA 字段），执行：

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
2. 停止服务（`systemctl stop <服务单元>`；实测进程停止会等待在途请求和已打开的长连接流收尾，最多可耗时约 30 秒，属 `closeTimeoutMs` + `closeGraceMs` 窗口）；
3. 确认环境变量不含 `CIRCLE_HUB_TOKEN`，将单元内 `WorkingDirectory` 与 `ExecStart` 指向新版本发布目录（若该版带包内迁移可先核对状态/`--migrate-only`）；
4. 执行 `systemctl daemon-reload && systemctl start <服务单元>`。

#### 升级后核验清单与成员侧预期

```bash
curl -sS http://127.0.0.1:7420/healthz
./bin/circle-hub status
./bin/circle-hub pack list
./bin/circle-hub executor list
```

- 确认 `/healthz` 返回的 `release` 与目标提交/版本一致；若改动了工作流或通用技能版本，按需补做 `pack publish --stage` + `pack install` / `pack retire`。
- **实测重启影响预期**：在数十秒的停机切换窗口内，新 MCP 请求及技能本地下载工具（`download-run.ts` 等）会立即报 `ECONNREFUSED`（本地工具当前不会自动重试）；服务拉起后首轮维护期间首次读取会短暂变慢，随后恢复正常；**成员已持有的访问令牌全部有效、已连接的 Circle 会话无需重新登录或重新连接（仅内存中的控制台网页登录会话会被清空，网页端需重新登录）**。

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
