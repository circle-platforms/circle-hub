---
nav_order: 11
---

# 把 DeepSeek Harness 接到 Hub：使用者上手

写给要在 DeepSeek Harness（DSH）里使用 Hub 的同事，也写给替他们开通的管理员。Hub 是标准的 MCP 服务器：DSH 里没有 Hub 专用的协议或界面，插件只是把 Hub 的六个工具接进 DSH，与 [把 Circle 接到 Hub](hub-client-setup.md) 的做法平级。能用 Hub 做什么见 [Hub r4 使用指南](hub-r4-guide.md)。

## 你需要什么

- **DSH 0.2.1-rc.5**（当前桌面版）与 **`circle-hub-dsh` 插件 0.1.0**。插件在 DSH 的插件体系里是一个普通组合包，不改变 Hub 的语义。
- **Hub 的地址**：形如 `http://<hub-host>:<port>/mcp`，由管理员告诉你。Hub 只监听回环或内网地址，令牌在网络上没有加密，不要在不可信的网络里使用。
- **你自己的令牌**：一人一个，管理员单独发给你，可以随时吊销。不要贴进对话、截图或文件里。
- **任务包已分配给你**：没分配给你的任务包，和不存在的任务包看起来一样，都是"对你不可用"。

## 接入步骤

1. **安装插件**。在插件检出目录构建后装进一个 profile：

```sh
cd circle-hub-dsh && npm install && npm run build
dsh plugin --profile circle-hub-dev add ./circle-hub-dsh
```

   市场发布后也可以从「自定义插件市场」的索引安装（见插件 README）。
2. **填地址与令牌**：打开 `dsh --profile circle-hub-dev`，在 **设置 → 插件** 里填 `url`（Hub 的 `/mcp` 端点）与 `token`（secret 字段，表单脱敏）；不想把令牌写进 profile 文件时，改填 `tokenEnv` 为保存令牌的环境变量名。令牌不必写进任何会被模型或日志看到的地方。
3. **重连与自检**：插件按重连预算自动连接；连上后工具列表出现六个 `mcp__circle-hub__*` 工具：`list_task_packs`、`upload_file`、`start_run`、`get_nodes`、`resolve_reference`、`submit_result`。设置页里能看到 `circle-hub-client` 的连接日志；`/hub` 命令给出连接状态（需要命令面插件）。
4. **试一句**：「用 Hub 列出我能用的工作流，每个只写名字和版本。」

## 日常使用要知道的

- **审批**：Hub 把 `list_task_packs`、`get_nodes`、`resolve_reference` 标为只读，DSH 的权限预设据此决定是否询问；`upload_file`、`start_run`、`submit_result` 不是只读，按会话的审批模式询问。
- **上传可以给本地路径**：`upload_file` 的 `file_path` 可以填本地文件路径，插件读字节后按 Hub 要求发送 base64；其余参数原样透传。文件超过 16 MiB 会被提前拒绝。
- **长时间的调用**：`start_run`、`submit_result` 默认 300 秒超时（其余 60 秒）；Hub 对超过 20 秒的调用会先回响应头、每 30 秒补一个空格，客户端不会因静默断开。超时报错不代表服务端停了，先用 `get_nodes` 的调用查询对账，不要盲目重发。
- **结果怎么读**：回执给出分区计数（已交付 / 已拒收 / 已隔离 / 未完成）和 `rec:` 引用；用 `get_nodes` 按该引用读取完整校验结果，条目多时按末尾 cursor 续读。未知永远带原因，不显示成通过或不通过。
- **看控制台**：运行页 `/console/runs`、工作流页 `/console/packs` 用管理员给的账号登录查看；DSH 里用 `/hub console` 打开对应页（只读，不内嵌，需登录）。
- **无模型验证**：插件仓库的验收脚本用合成 fixture 直连临时 Hub，证明上传、`start_run`、提交与拒收路径；真实会话里的模型密钥始终由所有者自己配置。

## 常见问题

| 现象 | 可能原因 | 怎么办 |
| --- | --- | --- |
| 设置页里插件报"未配置 url" | `url` 为空 | 填 Hub 的 `/mcp` 端点后重载配置 |
| 所有调用都失败，提示未授权 | 令牌被吊销、账号被停用，或复制时多了空格 | 请管理员重发令牌，更新 `token` 或对应环境变量 |
| 工具列表没有 `mcp__circle-hub__*` | Hub 未启动或地址不可达 | 看插件日志里的连接错误；Hub 启动后按重连预算恢复 |
| 长调用后超时 | 计算确实较慢，或连接中断 | 用调用查询对账；超时后重发会再算一遍，不要连发 |
| 回答是"对你不可用" | 任务包没分配给你，或来源你没有权限；两种情况的回答完全一样 | 请管理员确认分配 |
| 协议版本比预期旧 | 两家 SDK 协商的结果（当前 `2025-11-25`） | 升级 Hub 或插件后重跑插件的 spike；不要手工改协议头 |

## 给管理员：开通一位同事

在装 Hub 的机器上，以服务账号运行（`circle-hub` 是 Hub 的命令行）：

```sh
circle-hub user create <名字> --role user
circle-hub token issue <名字> --label <标签> --raw      # 令牌只显示这一次，单独交给本人
circle-hub pack assign <名字> <工作流>                 # 工作流包要分配给用户才能用
circle-hub user disable <名字>                          # 停用立即生效
circle-hub token revoke <令牌编号>                      # 吊销立即生效
```

没有任务包分配的用户看到的是"对你不可用"。管理员账号能看到所有任务包和运行；普通用户只看到分配给自己的包和自己的运行。令牌不要通过聊天工具明文转发。
