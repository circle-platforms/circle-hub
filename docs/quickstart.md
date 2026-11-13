---
nav_order: 2
---

# 十分钟上手

本指南带你按当前版本的真实命令，在本地或临时实验目录从零启动一个 Circle Hub，建好团队与成员，发布并分配首个工作流，连接 Circle 并跑通第一次运行。

> 本文全部命令均针对当前 `circle-hub` 实现在临时合成数据根上实敲验证。
>
> - 支持平台：**macOS 与 Linux（arm64 / x64）**，Node 24；不支持 Windows。
> - 只使用合成测试数据、回环地址 `127.0.0.1` 与文档示例网段 `192.0.2.0/24`；绝不在文档、测试或命令行参数中写入真实账号、密钥值或真实业务地址。
> - 进程环境里不得残留已退役的前身环境变量，否则 `circle-hub` 会拒绝启动。

---

## 第一步：初始化数据根、主密钥与管理员

生产单机发行版可使用仓库根目录的 [install.sh](https://github.com/circle-platforms/circle-hub/blob/main/install.sh) 一键下载并初始化；如果在仓库工作树中快速体验或搭建临时实验实例，按下面 5 条命令初始化（所有路径建议使用较短的数据根，因为嵌入式 PostgreSQL 套接字 `<数据根>/run/.s.PGSQL.5432` 受操作系统路径长度上限限制，约 103 字节）：

```bash
export CIRCLE_HUB_DATA_DIR=/tmp/ch-quickstart/d
mkdir -p "$CIRCLE_HUB_DATA_DIR"

./bin/circle-hub init --environment test --port 7420
./bin/circle-hub key init
./bin/circle-hub serve --migrate-only
./bin/circle-hub init-admin
```

各步完成后的关键事实：

- `init` 会写入 `<数据根>/config/platform.json` 并启动本地嵌入式 PostgreSQL（测试环境示例 `--environment test`，正式部署按实际环境填写）。以后同一终端只要带着 `CIRCLE_HUB_DATA_DIR`，操作命令行就会自动读取该端口与配置。
- `key init` 会在 `<数据根>/keys` 建立私有密钥文件保存库主密钥（macOS 与 Linux 均不使用系统钥匙串）。
- `serve --migrate-only` 以拥有表的数据库角色应用迁移并按最小权限授权给运行角色 `circle_hub`。
- `init-admin` 建出首位管理员 `admin`（`usr_…`），把操作令牌直接写入 `<数据根>/keys`，并在终端仅显示一次控制台初始密码（首次登录需修改）。此后带 `--stage`、分配、用户与密钥类的管理命令会自动读取该操作令牌文件。

> 注意：准备在终端启动服务进程（`./bin/circle-hub serve`）前，确保当前 Shell 环境里**没有**设置 `CIRCLE_HUB_TOKEN`（如曾手工导出过，先 `unset CIRCLE_HUB_TOKEN`），否则服务端会按安全边界拒绝启动。

---

## 第二步：建团队与成员

先建一个团队，再建成员并加入团队：

```bash
./bin/circle-hub team create 研发一组
./bin/circle-hub team list
# 记下输出的团队编号（形如 tm_…，例如 tm_01m79xa8mng4nj1534xgvc7cv2）

./bin/circle-hub user create alice
./bin/circle-hub team add <团队ID> alice
./bin/circle-hub team show <团队ID>
```

需要注意界面与概念分工：

- **团队（`tm_…`）**：由管理员新建并在网页控制台 `/console/team` 的「团队」页签下管理成员、工作流与业务系统分配。一个成员可同时属于多个团队，权限取并集；删除团队会一并撤回该团队名下的所有分配。普通成员在控制台只能看到自己所属团队的名字。
- **公共空间**：全员共享的团队知识与存储空间（内部默认空间 ID 仍为 `team`，控制台容量行标注为「公共空间」，与团队列表相互独立）。

---

## 第三步：发布、启用并分配任务包

### 1. 给发布人授发布权

即便是 `init-admin` 建出的首位 `admin`，首次发布任务包前也要先授予发布权：

```bash
./bin/circle-hub pack grant-publish admin
```

源码包目录通常包含 `README.md`、`*.test.ts` 或打包脚本等非运行文件，发布时加上 `--stage` 由 CLI 导出干净临时副本再校验入库；不放心时先加 `--dry-run` 预检。

### 2. 零外部依赖的最小可跑路径（推荐首试 `test-bed`）

工作流 `test-bed`（自动化测试环境）只读取管理员发布的命名文档清单，不需要先接入外部服务器，最适合十分钟内跑通首轮运行：

```bash
./bin/circle-hub pack publish packs/workflow/test-bed --stage --dry-run
./bin/circle-hub pack publish packs/workflow/test-bed --stage
./bin/circle-hub pack assign test-bed --team=<团队ID>
./bin/circle-hub doc put bed-topology packs/workflow/test-bed/examples/bed-topology.json
./bin/circle-hub doc list
```

- `pack assign` 也支持按单个账户分配（`./bin/circle-hub pack assign alice test-bed`），日常建议直接按团队 `--team=<团队ID>` 分配。
- `doc put` 发布 `bed-topology` 后，引用为 `doc:doc:bed-topology`。

### 3. 按需接入其它三种包（通用技能 / 产品包 / 业务系统）

当后续工作流依赖技能、产品知识或外部系统时，按各自发布后的生效动作补齐：

| 包类型 | 发布命令 | 发布后必须做的生效动作 |
|---|---|---|
| 通用技能（`skill`） | `./bin/circle-hub pack publish packs/skill/mindmap-format --stage` | 安装精确版本：`./bin/circle-hub pack install mindmap-format@1.0.24` |
| 产品知识来源（`product`） | `./bin/circle-hub pack publish packs/product/famx --stage` | 全 Hub 启用：`./bin/circle-hub pack activate famx`（如需构建知识树另见 `knowledge sync --product famx`） |
| 业务系统接入（`system`） | `./bin/circle-hub pack publish packs/system/plm --stage` | 实例化资源、写入密钥并开放给团队或全体成员（见下文） |

以 `plm` 系统包为例，配置合成测试资源与命名密钥时必须遵守三条约束：
1. **命名密钥独立存放在 `vault/`，且必须给全凭据与角色**：`secret set` 与 `resource add` 没有先后顺序要求（密钥库不再核对已登记的使用者；先建资源时若密钥尚未写入，命令只会提示用 `secret set` 补齐），按密钥名称绑定即可；同时必须给全系统包 `system.json` 声明的所有角色与凭据项（`plm` 声明了 `plm-oauth` 与 `plm-api` 两个角色，且 `password` 要求摘要规则 `sha512_base64`，写入 `SYNTH_PLM_PASS` 时需显式传入 `--digest SYNTH_PLM_PASS=sha512_base64`，未传 `--digest` 时默认规则为 `plain`）。
2. **密钥名必须以大写字母开头**，只含大写字母、数字和下划线（`^[A-Z][A-Z0-9_]{0,63}$`）。
3. **新建业务系统默认不向成员开放**，必须显式分配 `--team=<团队ID>` 或 `--all`。

```bash
# 使用文档示例网段 192.0.2.0/24 与大写命名密钥
./bin/circle-hub resource add plm --name synth-plm --environment test \
  --origin plm-oauth=http://192.0.2.10:8080 \
  --origin plm-api=http://192.0.2.11:8080 \
  --allow-plaintext plm-oauth --allow-plaintext plm-api \
  --credential username=SYNTH_PLM_USER \
  --credential password=SYNTH_PLM_PASS

# 记下上一步输出的 res_… 编号供下方 assign/show 使用，再从标准输入喂入密钥值（也可先写密钥再建资源）
printf '%s\n' '<合成账号>' | ./bin/circle-hub secret set --name SYNTH_PLM_USER --reason "quickstart synthetic verification"
printf '%s\n' '<合成口令>' | ./bin/circle-hub secret set --name SYNTH_PLM_PASS --digest SYNTH_PLM_PASS=sha512_base64 --reason "quickstart synthetic verification"

./bin/circle-hub resource assign <资源ID> --team=<团队ID>
./bin/circle-hub resource list
./bin/circle-hub resource show <资源ID>
```

全部装配完后，用 `./bin/circle-hub pack list` 核对包状态、所有者与分配情况。

---

## 第四步：启动服务并连接 Circle

在终端启动 Hub（如需后台常驻，生产单机见系统服务命令 `circle-hub service`）：

```bash
unset CIRCLE_HUB_TOKEN
./bin/circle-hub serve
```

在另一个终端确认端口就绪：

```bash
curl -sS http://127.0.0.1:7420/healthz
# 期望返回：{"status":"ok","release":null}

curl -sS http://127.0.0.1:7420/.well-known/oauth-protected-resource/mcp
```

此时网页控制台可访问 `http://127.0.0.1:7420/console/`（使用 `init-admin` 输出的管理员初始密码登录，首次登录按提示改密）。

给成员 `alice` 接入客户端有两种方式：

1. **普通 MCP 连接（Circle 标准方式，推荐）**：
   管理员生成一次有效 24 小时的邀请码：
   ```bash
   ./bin/circle-hub user invite alice
   ```
   在 Circle 中按普通 MCP 服务器接入 `http://127.0.0.1:7420/mcp`（若 Hub 开启了内置 HTTPS，则填对应 `https://…/mcp` 并让客户端信任根证书），浏览器弹出授权页时输入该邀请码即可；Circle 不带任何 Hub 专属界面。
2. **个人访问令牌（脚本或排查时直接带 Bearer 头调用）**：
   ```bash
   ./bin/circle-hub token issue alice --label "circle-local" --raw
   ```
   标准输出仅打印一次令牌，调用 `POST http://127.0.0.1:7420/mcp` 时放到请求头 `Authorization: Bearer <令牌>`。

---

## 第五步：跑通第一次运行并核对结果

Hub 提供 6 个标准 MCP 工具：`list_task_packs`、`upload_file`、`start_run`、`get_nodes`、`resolve_reference`、`submit_result`。对成员 `alice` 来说：

1. 调用 **`list_task_packs`**（参数 `{}`）：看到已分配的 `test-bed@1.3.2`（`pack: "test-bed"`）。
2. 调用 **`get_nodes`** 读取工作流说明：
   ```json
   { "pack": "test-bed" }
   ```
3. 如果某工作流需要上传本地文件，调用 **`upload_file`**：注意 `file_path` 传的是**文件字节的 RFC 4648 base64 字符串**（带填充、不换行），`name` 填展示文件名（如 `note.json`），可选 `media_type`；返回只读引用 `src:<sha256>`。
4. 调用 **`start_run`** 对命名清单执行 `test-bed` 的事实计算 `facts`：
   ```json
   {
     "pack": "test-bed",
     "inputs": { "inventory": { "external": "doc:doc:bed-topology" } },
     "parameters": { "action": "facts" }
   }
   ```
   `test-bed` 仅包含事实检查项，会在开始运行时由 Hub 直接完成核算，返回 `run.run`（形如 `run_…`）以及校验结果记录引用 `result.reference`（形如 `rec:<sha256>`）和分区计数（`delivered: 2, rejected: 0, unknown: 0`）。
5. 调用 **`get_nodes`** 读取完整结论，或用 **`resolve_reference`** 核对原文/值：
   ```json
   { "reference": "rec:<上一步返回的摘要>" }
   ```
   ```json
   { "run": "<上一步返回的 run_…>", "text": "afamx0" }
   ```

管理员也可在终端随时检查运行与健康状态：

```bash
./bin/circle-hub run list
./bin/circle-hub run show <run_…>
./bin/circle-hub status
```

如果是临时实验，结束时停止服务并清理实验数据根（已发布包在 `<数据根>/packs/` 下为只读权限，删除前需先补回写权限）：

```bash
./bin/circle-hub db stop
chmod -R u+w /tmp/ch-quickstart/d && rm -rf /tmp/ch-quickstart
```

---

## 用部署定义文件一次配好

如果你不想逐条执行建账号、建团队、发布包、登记资源与做分配的命令，可以用一份声明式的部署定义文件（`schema: "deployment@1"`，定义在 `contracts/src/deployment.ts`）统一描述整套部署结构。

### 定义文件包含哪些顶层字段

除了必填的 `"schema": "deployment@1"`，其余八个顶层数组字段均可选（默认视为空数组 `[]`）：

- `accounts`：账号列表（`{ name, role: "admin" | "user", disabled?: false }`，新建条目省略 `id`；若指定 `id` 则必须与已有记录精确匹配）。
- `teams`：团队列表（`{ name, members?: [...] }`，`members` 可填账号名或账号 `id`）。
- `packs`：包列表（`{ ref: "<id>@<x.y.z>", directory?: "<包目录>", install?: false, dependsOn?: [...] }`；按依赖顺序写入，首次发布可提供 `directory`，复用已发布包时可省略 `directory`，此时要求该版本已存在，且若清单或文件摘要不一致会拒绝覆盖）。
- `resources`：业务系统资源列表（`{ definition: { system_pack: "<id>@<x.y.z>", name, environment, origins, allow_plaintext?, credentials?, settings?, limits? }, enabled?: true }`；注意在 `deployment@1` 中，`credentials` 直接写大写密钥名如 `"SYNTH_PLM_USER"`，不带 `${secret:...}` 外壳）。
- `executors`：执行器列表（按 `target` 唯一标识，凭据字段使用 `${secret:<NAME>}` 引用格式）。
- `workflowAssignments`：工作流分配（`{ pack: "<包ID>", team: "<团队名>" }` 或 `{ pack: "<包ID>", user: "<用户名>" }`；`pack` 写包 ID，不带 `@版本号`）。
- `resourceAssignments`：资源分配（`{ resource: "<资源名>", team: "<团队名>" }` 或 `{ resource: "<资源名>", all: true }`）。
- `knowledgeSources`：启用为知识源的包 ID 列表（`PackId[]`）。

### 最小合成示例（`deployment@1`）

```json
{
  "schema": "deployment@1",
  "accounts": [
    { "name": "synth-member", "role": "user" }
  ],
  "teams": [
    { "name": "synth-team", "members": ["synth-member"] }
  ],
  "packs": [
    { "ref": "plm@1.3.11", "directory": "./packs/system/plm" },
    { "ref": "test-bed@1.3.2", "directory": "./packs/workflow/test-bed", "install": true }
  ],
  "resources": [
    {
      "definition": {
        "system_pack": "plm@1.3.11",
        "name": "synth-plm",
        "environment": "test",
        "origins": {
          "plm-oauth": "http://192.0.2.10:8080",
          "plm-api": "http://192.0.2.11:8080"
        },
        "allow_plaintext": ["plm-oauth", "plm-api"],
        "credentials": {
          "username": "SYNTH_PLM_USER",
          "password": "SYNTH_PLM_PASS"
        }
      },
      "enabled": true
    }
  ],
  "workflowAssignments": [
    { "pack": "test-bed", "team": "synth-team" }
  ],
  "resourceAssignments": [
    { "resource": "synth-plm", "team": "synth-team" }
  ]
}
```

### `apply` 与 `export` 的行为差异

- **应用（`apply`）不盲目覆盖差异**：匹配到同 `id` 或同名的已有条目且内容完全一致时，直接计为「相同跳过」；若存在不同，只会逐条输出存在差异的字段路径（例如 `<section>[<index>] 与现状不同：<fields>；未覆盖`）并返回非零退出码，**不会自动覆盖**现有配置（同时汇总输出 `已配置 X 项；相同跳过 Y 项；差异 Z 项`）。如果应用过程在中途失败，前面已生效的创建操作不会自动回滚。
- **导出（`export`）不含任何真实密钥**：`export` 只导出结构定义、分配关系与引用到的密钥名（资源凭据只含大写密钥名，执行器只含 `${secret:<NAME>}`），从不读取 `vault/` 密文、密码散列或明文令牌。因此在跨环境重装并 `apply` 后，仍需按密钥名补写（或沿用原有保留下来的）`vault/` 密钥值。
- **CLI 接线现状提示**：当前 `hub/server/cli-apply.ts` 中的 `apply` / `export` 核心逻辑已经实现并通过单元测试，但 `hub/server/command-registry.ts` 尚未把这两个子命令正式挂入 `circle-hub` 主命令分发表。待接入合并到 `hub-final` 后，本节将补充并实测完整的命令行调用写法。

---

## 下一步阅读

- 需要重置数据、保留配置重建或处理版本更新后的「需要重建」状态：[重置和重建](reset.md)
- 需要修改工作流文案、规则或通用技能并重新上线：[改一个工作流或技能怎么做](edit-pack.md)
- 了解 7 项用例工作流的详细参数与报告规范：[Hub r4 使用指南：七项用例能力](hub-r4-guide.md)
- 跨机部署到 Linux 系统级服务：[Linux 单机迁移与运行](hub-linux-deploy.md)
