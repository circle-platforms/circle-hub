---
nav_order: 2
---

# 十分钟上手

本指南按当前版本的真实命令，在本地或临时实验目录从零启动一个 Circle Hub：安装并建好管理员 → 用一份部署定义 `apply` → 连接 Circle → 跑通第一次运行。

> 本文全部命令均针对当前 `circle-hub` 实现在临时合成数据根上实敲验证（含附节的 `pack assign` 形式）；文中的最小定义文件与 `docs/examples/quickstart-deployment.json` **同一份字节**（由测试核对）。英文精简版见 [Quickstart](quickstart.en.md)；有出入以本页为准。
>
> - 支持平台：**macOS 与 Linux（arm64 / x64）**，Node 24；不支持 Windows。
> - 只使用合成测试数据、回环地址 `127.0.0.1` 与文档示例网段 `192.0.2.0/24`；绝不在文档、测试或命令行参数中写入真实账号、密钥值或真实业务地址。
> - 进程环境里不得残留已退役的前身环境变量，否则 `circle-hub` 会拒绝启动。

---

## 第一步：初始化数据根、主密钥与管理员

生产单机发行版可使用仓库根目录的 [install.sh](https://github.com/circle-platforms/circle-hub/blob/main/install.sh) 一键下载并初始化；如果在仓库工作树中快速体验或搭建临时实验实例，按下面命令初始化（所有路径建议使用较短的数据根，因为嵌入式 PostgreSQL 套接字 `<数据根>/run/.s.PGSQL.5432` 受操作系统路径长度上限限制，约 103 字节）：

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

## 第二步：写一份部署定义并 `apply`

首位管理员已建好、数据库可用之后（不必先 `serve`），用**一份部署定义**代替逐条 `pack grant-publish` / `pack publish` / `pack assign` / `doc put`：

1. 检入的最小定义文件（合成名字，可直接用）：仓库内 [`docs/examples/quickstart-deployment.json`](examples/quickstart-deployment.json)。相对该文件的 `directory` 指向仓库里的 `packs/workflow/test-bed`；`schema` 必须是 `deployment@2`（见 `contracts/src/deployment.ts`）。
2. 在仓库根目录执行：

```bash
./bin/circle-hub apply docs/examples/quickstart-deployment.json
```

相同项会跳过；有差异只列字段路径、不覆盖，并返回非零退出码。若管理员还没有发布权，发布前会自动授予（不必先 `pack grant-publish`）。`knowledgeSync: []` 表示明确无知识同步目标，避免「尚未声明」提示。

该文件的完整内容如下（须与 `docs/examples/quickstart-deployment.json` 字节一致）：

```json
{
  "schema": "deployment@2",
  "packs": [
    {
      "ref": "test-bed@1.4.2",
      "directory": "../../packs/workflow/test-bed"
    }
  ],
  "workflowAssignments": [
    {
      "pack": "test-bed",
      "user": "admin"
    }
  ],
  "documents": [
    {
      "name": "bed-topology",
      "sha256": "65b61e85e8f94afd36035cead54ef6cd29c579089aee3056ad387192af8cc45a",
      "size": 1228,
      "bytesBase64": "ewogICJzY2hlbWEiOiAidGVzdC1iZWQtbWFuaWZlc3RAMSIsCiAgImJlZHMiOiBbCiAgICB7CiAgICAgICJuYW1lIjogImJlZC1hIiwKICAgICAgImRldmljZXMiOiBbCiAgICAgICAgeyAibmFtZSI6ICJhZmFteDAiLCAidHlwZSI6ICJsb2FkLWJhbGFuY2VyIiwgInByb2R1Y3QiOiAiZmFteCIsICJpcHY0IjogWyIxOTIuMC4yLjEwLzI2IiwgIjE5Mi4wLjIuNzQvMjYiXSwgImlwdjYiOiBbIjIwMDE6ZGI4OjE6OjEwLzY0Il0sICJpbnN0YWxsZWQiOiB7ICJidWlsZCI6ICJSZWxfRkFNWF8xMF82XzFfOCIgfSB9LAogICAgICAgIHsgIm5hbWUiOiAicm91dGVyMCIsICJ0eXBlIjogInJvdXRlciIsICJpcHY0IjogWyIxOTIuMC4yLjEvMjYiXSwgImlwdjYiOiBbXSB9LAogICAgICAgIHsgIm5hbWUiOiAiY2xpZW50MCIsICJ0eXBlIjogImNsaWVudCIsICJpcHY0IjogWyIxOTIuMC4yLjgwLzI2Il0sICJpcHY2IjogW10gfSwKICAgICAgICB7ICJuYW1lIjogInNlcnZlcjAiLCAidHlwZSI6ICJzZXJ2ZXIiLCAiaXB2NCI6IFsiMTkyLjAuMi45MC8yNiJdLCAiaXB2NiI6IFtdIH0sCiAgICAgICAgeyAibmFtZSI6ICJjb25zb2xlMCIsICJ0eXBlIjogImNvbnNvbGUiLCAiaXB2NCI6IFsiMTkyLjAuMi4xNDAvMjYiXSwgImlwdjYiOiBbXSB9CiAgICAgIF0sCiAgICAgICJzZXJ2aWNlcyI6IFt7ICJob3N0IjogInNlcnZlcjAiLCAiaXAiOiAiMTkyLjAuMi45MCIsICJwcm90byI6ICJ0Y3AiLCAicG9ydCI6IDgwIH1dLAogICAgICAicmVzZXJ2ZWQiOiBbIjE5Mi4wLjIuMS0xOTIuMC4yLjkiLCAiMTkyLjAuMi42NS0xOTIuMC4yLjY5Il0KICAgIH0sCiAgICB7CiAgICAgICJuYW1lIjogImJlZC1iIiwKICAgICAgImRldmljZXMiOiBbCiAgICAgICAgeyAibmFtZSI6ICJhZmFteDEiLCAidHlwZSI6ICJsb2FkLWJhbGFuY2VyIiwgInByb2R1Y3QiOiAiZmFteSIsICJpcHY0IjogWyIxOTIuMC4yLjEzMC8yNiIsICIxOTIuMC4yLjE5NC8yNiJdLCAiaXB2NiI6IFtdLCAiaW5zdGFsbGVkIjogeyAiYnVpbGQiOiAiUmVsX0ZBTVlfMTBfNl8xXzgiLCAiYmFzZSI6ICJSZWxfRkFNWF8xMF82XzFfOCIgfSB9LAogICAgICAgIHsgIm5hbWUiOiAiY2xpZW50MSIsICJ0eXBlIjogImNsaWVudCIsICJpcHY0IjogWyIxOTIuMC4yLjE1MC8yNiJdLCAiaXB2NiI6IFtdIH0KICAgICAgXSwKICAgICAgInNlcnZpY2VzIjogW10sCiAgICAgICJyZXNlcnZlZCI6IFtdCiAgICB9CiAgXQp9Cg==",
      "mediaType": "application/json",
      "fileName": "bed-topology.json"
    }
  ],
  "knowledgeSync": []
}
```

字段要点（与代码一致）：

| 字段 | 作用 |
|---|---|
| `packs[].ref` + `directory` | 首次发布：`directory` 相对**定义文件所在目录**；已发布且摘要一致则跳过 |
| `workflowAssignments` | `pack` 写包 ID（不带 `@版本`）；`user` 或 `team` 写精确名字 |
| `documents` | 命名文档：`bytesBase64` / `size` / `sha256` 必须一致；引用为 `doc:doc:<name>` |
| `knowledgeSync` | 可选；无目标时写 `[]` |

从已有实例迁到新机：在源实例 `circle-hub export` 得到定义（**不含**密钥与令牌、packs 通常**无** `directory`）；在新机 `init-admin` 后为每个要发布的包装上 `directory`，再 `apply`；成员密码仍须另办。

清零或重建后的正式三步：`reset --scope all` → `init-admin` → `apply`（清空账户且未 `--keep-config` 时不得在 `reset` 上同时带 `--definition`）。详见[重置和重建](reset.md)。

---

## 第三步：启动服务并连接 Circle

```bash
unset CIRCLE_HUB_TOKEN
./bin/circle-hub serve
```

确认端口：

```bash
curl -sS http://127.0.0.1:7420/healthz
# 期望返回：{"status":"ok","release":null}
```

控制台：`http://127.0.0.1:7420/console/`（`init-admin` 的初始密码，首次登录改密）。

在 Circle 中添加普通的 HTTP MCP 服务器。网页登录使用 MCP 标准授权。

1. 在桌面版的 MCP 服务器页面新增连接，或在 Circle 数据目录的 `settings.json` 中合并以下配置。

   ```json
   {"mcpServers":{"Hub":{"type":"http","url":"http://127.0.0.1:7420/mcp","placeholders":{"url":"HUB_URL","token":"HUB_TOKEN"}}}}
   ```

2. 在终端执行 `/mcp reload` 后按 MCP 登录提示打开浏览器。在桌面版从 MCP 服务器页面登录。登录完成后可调用 `mcp__Hub__list_task_packs`。
3. **邀请成员（可选）**：`./bin/circle-hub user invite <账户名>` 生成 24 小时邀请码，成员在授权页输入。
4. **脚本排查或手动令牌（可选）**：`./bin/circle-hub token issue <账户名> --label "circle-local" --raw`，请求头 `Authorization: Bearer <令牌>`；在 Circle `settings.json` 中推荐用 `Bearer ${secret:CIRCLE_HUB_TOKEN}` 从 `secrets.json` 读取（`headers` 中直接 `${NAME}` 亦可从环境变量或 `secrets.json` 读取，但仍建议将静态令牌存进 `secrets.json`）。

---

## 第四步：第一次运行

Hub 提供 6 个标准 MCP 工具：`list_task_packs`、`upload_file`、`start_run`、`get_nodes`、`resolve_reference`、`submit_result`。对已分配到 `test-bed` 的账户（本最小定义里是 `admin`）：

1. **`list_task_packs`**（`{}`）：看到 `test-bed@…`（`pack: "test-bed"`）。
2. **`start_run`** 对命名清单做事实计算：

```json
{
  "pack": "test-bed",
  "inputs": { "inventory": { "external": "doc:doc:bed-topology" } },
  "parameters": { "action": "facts" }
}
```

`test-bed` 仅含事实要求项，开始运行时由 Hub 直接核算，返回 `run.run`（`run_…`）与结果引用 `result.reference`（`rec:<sha256>`）及分区计数。

3. **`get_nodes`** / **`resolve_reference`** 读完整结论或原文。

管理员也可在终端：`./bin/circle-hub run list`、`run show <run_…>`、`status`。

临时实验结束：

```bash
./bin/circle-hub db stop
chmod -R u+w /tmp/ch-quickstart/d && rm -rf /tmp/ch-quickstart
```

---

## 附节：逐条做（不经 apply）

若你想逐步敲命令理解每一步，或定义文件暂时用不上，下面保留原先的分条路径（事实不删）。**主路径请仍用上面的 `apply`。**

### A. 建团队与成员

```bash
./bin/circle-hub team create 研发一组
./bin/circle-hub team list
# 后面的命令用团队的名字指代它

./bin/circle-hub user create alice
./bin/circle-hub team add <团队名> alice
./bin/circle-hub team show <团队名>
```

- **团队（`tm_…`）**：管理员在网页控制台 `/console/team` 管理；权限取并集。
- **公共空间**：全员共享的团队知识与存储空间（内部默认空间 ID 仍为 `team`）。

### B. 授发布权、发布、分配、登记命名文档

即便是 `init-admin` 的首位 `admin`，**不经 apply** 时首次发布前仍要授发布权（`canPublish` 无管理员豁免；apply 发布前会自动授）：

```bash
./bin/circle-hub pack grant-publish admin
./bin/circle-hub pack publish packs/workflow/test-bed --stage --dry-run
./bin/circle-hub pack publish packs/workflow/test-bed --stage
./bin/circle-hub pack assign admin test-bed
# 或：./bin/circle-hub pack assign test-bed --team=<团队名>
./bin/circle-hub doc put bed-topology packs/workflow/test-bed/examples/bed-topology.json
./bin/circle-hub doc list
```

### C. 按需接入其它包（技能 / 产品 / 业务系统）

| 包类型 | 发布命令 | 发布后必须做的生效动作 |
|---|---|---|
| 通用技能（`skill`） | `./bin/circle-hub pack publish packs/skill/mindmap-format --stage` | `./bin/circle-hub pack install mindmap-format@…` |
| 产品知识来源（`product`） | `./bin/circle-hub pack publish packs/product/famx --stage` | `./bin/circle-hub pack activate famx` |
| 业务系统接入（`system`） | `./bin/circle-hub pack publish packs/system/plm --stage` | 实例化资源、写入密钥并 `resource assign` |

业务系统约束：密钥名 `^[A-Z][A-Z0-9_]{0,63}$`；新建默认不向成员开放；合成地址用 `192.0.2.0/24`。示例：

```bash
./bin/circle-hub resource add plm --name synth-plm --environment test \
  --origin plm-oauth=http://192.0.2.10:8080 \
  --origin plm-api=http://192.0.2.11:8080 \
  --allow-plaintext plm-oauth --allow-plaintext plm-api \
  --credential username=SYNTH_PLM_USER \
  --credential password=SYNTH_PLM_PASS
printf '%s\n' '<合成账号>' | ./bin/circle-hub secret set --name SYNTH_PLM_USER --reason "quickstart synthetic verification"
printf '%s\n' '<合成口令>' | ./bin/circle-hub secret set --name SYNTH_PLM_PASS --digest SYNTH_PLM_PASS=sha512_base64 --reason "quickstart synthetic verification"
./bin/circle-hub resource assign <资源ID> --team=<团队名>
```

部署定义里对应字段为 `resources` / `resourceAssignments` / `executors`（`deployment@2`；资源凭据用 `${secret:NAME}` 引用，见 `contracts/src/deployment.ts`）。`apply` 行为：同名且内容相同则跳过；有差异只列路径、不覆盖。`export` 不含密钥值与令牌。

---

## 下一步阅读

- 需要重置数据、保留配置重建或处理「需要重建」：[重置和重建](reset.md)
- 需要修改工作流或通用技能并重新上线：[改一个工作流或技能怎么做](edit-pack.md)
- 七项用例能力参数与报告：[Hub r4 使用指南：七项用例能力](hub-r4-guide.md)
- 跨机部署到 Linux 系统级服务：[Linux 单机迁移与运行](hub-linux-deploy.md)
