# 部署并连接 Circle

英文译文在 [quickstart.en.md](quickstart.en.md)。接口字段的完整形状仍以 [client-api-handoff.md](client-api-handoff.md) 为准。本文只讲一台 Linux（或 macOS）机器上从零启动、用 Circle 登录、停止和再启动。

这里的 `npm run dev:stack` 使用临时 PostgreSQL、开发登录和合成来源。它适合第一次把 Circle 连上 hub。它不是生产部署。生产边界见 [SECURITY.md](../SECURITY.md)。

## 1. 安装 Node.js 24

`package.json` 的 `engines` 要求 Node.js 24 或更新。`.npmrc` 打开了 `engine-strict`，所以 `npm ci` 在更旧的 Node 上会直接失败。server、supervisor、worker、`circle-hub` 和 `dev:stack` 在读配置之前也会检查；版本不够时进程以 `HubEnvironmentError` 退出，错误写明当前版本，并指向 <https://nodejs.org/en/download>。

```sh
node -v          # 需要 v24 或更高
npm ci
```

## 2. 依赖安装脚本

`npm ci` 会安装开发依赖 `embedded-postgres`。真正带安装脚本的是它的八个平台包（`@embedded-postgres/linux-x64` 等，版本钉在 `18.4.0-beta.17`）。脚本只根据包内已有的 `native/pg-symlinks.json` 补相对符号链接，不下载 PostgreSQL，也不启动数据库。`package.json` 的 `allowScripts` 按 `包名@版本` 明确允许这八个包。漏掉这一步时，开发栈的 PostgreSQL 可能因缺少共享库链接而起不来。升级这些包的版本时要重新核对脚本内容，再改 `allowScripts`。父包 `embedded-postgres` 本身没有安装脚本。

## 3. 启动开发栈

```sh
npm run dev:stack
```

默认行为：

- HTTP 端口由操作系统分配（等价于 `CIRCLE_HUB_PORT=0`）。supervisor 在未设置该变量时监听 `127.0.0.1:8080`；开发栈故意不沿用 8080，避免和已经在跑的 hub 撞车。
- 开发者、审批人、服务账号和 worker 的密码每次随机生成，只打印在这个终端里，不写入 Git。
- 标准输出先有一行 JSON，`type` 为 `dev-stack-ready`，里面有 `url`、`login`、`approverLogin`、`scopeId`、`samplePath`。后面的文字说明下一步。
- 前台终端（stdin 和 stdout 都是 TTY）提示按 Ctrl+C。后台或被管道接走时，提示向打印出的 pid 发送 SIGTERM。两种方式都会按顺序停掉 worker、server 和 PostgreSQL，并删除这次的临时数据库和制品。

需要固定地址和密码时，在启动前设置（密码 12 到 200 个字符；太短或太长会拒绝启动，并且不会把你填的值打出来）：

```sh
export CIRCLE_HUB_PORT=8080
export CIRCLE_HUB_DEV_PASSWORD='synthetic-dev-password'
export CIRCLE_HUB_DEV_APPROVER_PASSWORD='synthetic-approver-password'
export CIRCLE_HUB_DEV_SERVICE_PASSWORD='synthetic-service-password'
export CIRCLE_HUB_DEV_WORKER_PASSWORD='synthetic-worker-password'
npm run dev:stack
```

终端里的下一步是英文命令加一行中文说明，例如：

```text
Next, in Circle: /extensions enable hub
Then: /hub login http://127.0.0.1:8080 developer
```

开发者用户名是 `developer`，审批人用户名是 `approver`，范围是 `scp_lab`。JSON 里的 `login.password` 与文字行中的开发者密码相同。

## 4. 在 Circle 里连接

Circle 1.7.4 的 hub 扩展要先启用，再登录。扩展自己的版本号是 0.1.0，hub 包版本是 0.2.0，HTTP API 版本是 1.0.0，三者不是同一个数。兼容关系见 [compatibility.md](compatibility.md)。

在 Circle 里：

```text
/extensions enable hub
/hub login http://127.0.0.1:8080 developer
```

把 URL 换成终端打印的地址。提示输入密码时，用开发者密码。需要独立审批时再 `/hub login` 同一 URL，用户名 `approver`。

`/hub refresh` 读的是 `GET /v1/tasks?kind=work&limit=20`：当前身份在范围内能读到的工作任务，最多 20 条。它不是「我在这个窗口里交接过的任务」的个数。`/hub tasks` 列出的是本窗口 `followed()` 里记下的任务。`seen to N` 是本窗口已经消费到的事件序号，不是任务条数。任务的 `phase` 仍是协议值；`admitted` 表示已接受、尚未开始，列表里的 `phaseLabel` 写成 `accepted, not started`。

技能在获批之后，协议字段 `status` 仍是 `registered`（这是登记状态，不是「还在等待」）。同时返回 `lifecycle`（资产生命周期，获批后为 `approved`，启用后为 `running`）、`registration`（与 `status` 相同）和 `statusLabel`（例如 `approved` 或 `waiting for approval`）。Circle 1.7.4 目前只打印 `status`，所以界面上仍会看到 registered，直到客户端改为打印 `lifecycle` 或 `statusLabel`。

## 5. 停止和再启动

- 前台：Ctrl+C。
- 后台：`kill <dev-stack-ready 里的 pid>`（SIGTERM）。

开发栈的数据库在临时目录里。再执行一次 `npm run dev:stack` 会得到新的数据库、新的端口（除非你固定了 `CIRCLE_HUB_PORT`）和新的随机密码（除非你固定了上面的密码变量）。已经在 Circle 里登录的令牌不会带到新进程。

如果要用同一份数据重启 HTTP 进程，而不是整个开发栈，使用 supervisor，并自己提供已经在运行的 PostgreSQL 与 `CIRCLE_HUB_DATABASE_CONFIG`。开发登录 `CIRCLE_HUB_DEV_AUTH=1` 仍然只适合本机合成环境。

## 6. 运行时配置是什么

技能执行需要一份 Circle 运行时配置：环境变量 `CIRCLE_RUNTIME_CONFIG` 指向仓库外的 JSON 文件，内容是：

| 字段 | 含义 |
|---|---|
| `circleBin` | Circle 可执行文件或 CLI 入口 |
| `circleCommit` | 40 位十六进制 Git 提交 |
| `circleVersion` | Circle 版本字符串 |
| `model.kind` | `scripted` 或 `remote` |
| `model.base_url` | 模型端点；非回环必须是 HTTPS |
| `model.model` | 模型名 |
| `model.protocol` | 固定 `openai` |
| `model.api_key` | 运行时密钥，不进 Git |

也可以用 `npm run runtime:profile` 在仓库外生成这份文件，步骤见 [runtime-profile.md](runtime-profile.md)。设置变量并重启 hub 之后，用有 `admin.manage` 的身份调用 `GET /v1/runtime-profiles`，把看到的 profile 登记为 `runtime-profile` 资产，再由另一个人批准。没有这份配置时，技能运行返回 `RUNTIME_NOT_CONFIGURED`（409），错误里写明变量名、`npm run runtime:profile` 和上述步骤。登记和审批技能本身不需要它。

Linux 上技能运行和产品包 Tool/Hook 子进程使用 bubblewrap。系统树只读，可写范围是运行工作区和沙箱内的私有临时目录，不挂载 home。默认关闭网络；运行配置列出回环端点时，必须能用 landlock 把 TCP 限制到那些端口（需要 landlock ABI 4 或更新，以及 `gcc` 或 `cc`）。安装：Debian/Ubuntu 用 `sudo apt-get install bubblewrap`，Fedora/RHEL 用 `sudo dnf install bubblewrap`，Arch Linux 用 `sudo pacman -S bubblewrap`。没有 `bwrap`、用户命名空间被拒绝，或无法限制已批准的回环端口时，错误码是 `SANDBOX_UNAVAILABLE`，消息给出安装或 `sysctl` 提示并指向本文。hub 不会去掉隔离直接运行。macOS 仍使用 seatbelt。内建的合成派发不经过这些子进程。

## 7. 能力包要先对上名字

`GET /v1/packs` 列出已安装的能力包。上传原件时可以带请求头 `x-capability-pack-id`。hub 在读取和保存正文之前检查这个名字。

- 已退役的 `lbx-healthcheck` 和 `apv-case-execute` 仍返回 `UNSUPPORTED_VERSION`。
- 其他未安装的名字返回 `TARGET_NOT_FOUND`，消息里有这个 id，并提示先看 `GET /v1/packs`。没有这个头时，上传行为与以前相同。
- 提交任务时，未知能力包同样在创建任务前返回 `TARGET_NOT_FOUND`。

Circle 1.7.4 会先上传再提交，并且不送这个头。要在上传前失败，客户端需要先查包列表，或在 `POST /v1/sources` 上带 `x-capability-pack-id`。

用包名（`skillpack.json` 的 `id`）调用 `POST /v1/skillpacks/<名字>/runs` 时：唯一已批准的包会解析到它的 `skp_` id；多个已批准同名包会列出这些 id，不会猜；只有候选时返回 `APPROVAL_REQUIRED` 并列出提交。写成 `skp_` 但格式不对时，错误说明应有的形状，而不是原始 schema 正则。

试跑记录可以是 0 次工具调用，提交仍会接受（201）。回应里的 `warnings` 会说明这次没有调用记录。同一 manifest id 的新提交如果比上一次调用更少，也会警告：更早的调用不会保留在这次提交上。内容完全相同的重复提交（同一摘要）不再重复警告。

## 环境变量

| 变量 | 作用 |
|---|---|
| `CIRCLE_HUB_PORT` | 0–65535 的整数。`0` 表示由系统分配。开发栈未设置时用 `0`；supervisor 未设置时用 `8080` |
| `CIRCLE_HUB_DEV_PASSWORD` | 开发栈用户 `developer` 的稳定密码；留空则每次随机 |
| `CIRCLE_HUB_DEV_APPROVER_PASSWORD` | 用户 `approver` |
| `CIRCLE_HUB_DEV_SERVICE_PASSWORD` | 服务账号 `defect-bot` |
| `CIRCLE_HUB_DEV_WORKER_PASSWORD` | 两个合成 worker |
| `CIRCLE_HUB_DEV_AUTH` | 设为 `1` 才启用开发登录 |
| `CIRCLE_HUB_DEV_IDENTITIES` | 开发身份 JSON 文件 |
| `CIRCLE_HUB_DATABASE_CONFIG` | PostgreSQL 连接 JSON |
| `CIRCLE_HUB_DATA_DIR` | 对象存储目录 |
| `CIRCLE_HUB_PG_DIR` | 嵌入式 PostgreSQL 数据目录 |
| `CIRCLE_HUB_TLS_CONFIG` | 可选的本机 TLS |
| `CIRCLE_HUB_URL` | worker 访问 hub 的地址 |
| `CIRCLE_HUB_TOKEN` / `CIRCLE_HUB_TOKEN_FILE` | 调用方令牌；不要写进 Git |
| `CIRCLE_HUB_SCOPE` | 调用方范围 |
| `CIRCLE_HUB_CONNECTOR_PROFILES` | 合成或只读连接器配置 |
| `CIRCLE_HUB_EXECUTION_GATEWAYS` | 执行网关配置 |
| `CIRCLE_HUB_OAUTH_PROFILES` | OAuth 配置 |
| `CIRCLE_HUB_PRODUCT_LINES` | 产品线目录 |
| `CIRCLE_RUNTIME_CONFIG` | 上一节的 Circle 运行时 JSON。这个名字不属于 `CIRCLE_HUB_*` |

进程环境里如果还有改名前的 `CIRCLE_SERVER_*` 变量，hub 拒绝启动。把前缀改成 `CIRCLE_HUB_` 后再启动。
