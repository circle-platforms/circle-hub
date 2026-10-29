---
nav_order: 10
---

# 把 Circle 接到 Hub：使用者上手

写给要在 Circle 里使用 Hub 的同事，也写给替他们开通的管理员。Hub 是一个标准的 MCP 服务器：Circle 里没有 Hub 专用的界面，它只是 Circle 的一个 MCP 服务器条目。能用 Hub 做什么见 [Hub r4 使用指南](hub-r4-guide.md)。

## 你需要什么

- **Circle 1.13.0 或更高**（推荐当前最新发布）。1.13.0 起 Circle 才在每个请求里带会话编号和追踪号，Hub 靠它们把同一次会话的操作归在一起，并判定"独立复核"（不同会话加不同模型家族）；更早的版本不满足这一点。
- **Hub 的地址**：形如 `http://<hub-host>:<port>/mcp`，由管理员告诉你。内网明文 HTTP，令牌在网络上没有加密，不要在不可信的网络里使用。
- **你自己的令牌**：一人一个，管理员单独发给你，可以随时吊销。不要贴进对话、截图或文件里。
- **任务包已分配给你**：没分配给你的任务包，和不存在的任务包看起来一样，都是"对你不可用"。

## 接入步骤

1. **安装或升级 Circle**。macOS 和 Linux：`curl -fsSL https://raw.githubusercontent.com/circle-platforms/circle/main/install.sh | bash`；Windows：`irm https://raw.githubusercontent.com/circle-platforms/circle/main/install.ps1 | iex`；已安装的用 `circle update`。装完重开终端，`circle --version` 应不低于 1.13.0。
2. **把令牌存进 Circle 的密钥库**：在 Circle 里输入 `/secrets HUB_TOKEN` 并粘贴令牌（桌面版：设置 → variables & secrets → secrets）。令牌因此不必写进 `settings.json`，模型和日志里只会看到 `%HUB_TOKEN%` 这样的引用。
3. **加一条 MCP 服务器**，写进 Circle 的 `settings.json`（或桌面版设置里的 MCP 页）：

```json
{
  "mcp_servers": [
    {
      "name": "hub",
      "url": "http://<hub-host>:<port>/mcp",
      "transport": "streamable_http",
      "headers": { "Authorization": "Bearer ${secret:HUB_TOKEN}" }
    }
  ]
}
```

   `transport` 必须写 `streamable_http`；不写的话 Circle 会按旧的 `sse` 去连，连不上。
4. **重载并自检**：输入 `/mcp reload`，再输入 `/mcp`。应看到 `hub` 已连接，列出六个工具：`hub_list_task_packs`、`hub_upload_file`、`hub_start_run`、`hub_get_nodes`、`hub_resolve_reference`、`hub_submit_result`；请求头只显示名字（`Authorization`），不显示令牌。
5. **试一句**：「调用 list_task_packs，告诉我我能用哪些任务包，每个只写名字和版本。」

## 日常使用要知道的

- **审批**：Hub 把 `list_task_packs`、`get_nodes`、`resolve_reference` 标为只读，Circle 不会逐次询问；`upload_file`、`start_run`、`submit_result` 不是只读，按你的审批模式询问。想让这台服务器的所有工具都询问，在条目里加 `"trust_annotations": false`。
- **长时间的调用不要盲目重发**：有些计算（例如质量看板、大树的读取）要几分钟甚至更久，客户端可能先断线（`fetch failed`），这不代表服务端停了，重发会再算一遍。先用 `get_nodes` 的调用查询（`call_query`：原来的参数加追踪号）看那次调用还在算还是已经结束；成功读取的回答在 10 分钟内可以按同样的参数找回。
- **同内容文件重复上传**：Circle 可能直接回答 `cached (same content)`，不再发到 Hub；这是 Circle 对"重复调用没有新效果"的工具的做法，Hub 里已经有那份原件。
- **无头模式**（`circle -p "…"`，建议加 `</dev/null` 以免等标准输入 3 秒）：必须加 `--extensions` 才会连接 MCP 服务器，不加时模型的工具列表里就没有 Hub 的工具，也没有任何提示；无头模式不能询问审批，审批模式是 `auto` 时非只读工具（`upload_file`、`start_run`、`submit_result`）直接运行，其它模式下需要 `--yolo`；带 `destructiveHint` 的工具无头模式即使加了 `--yolo` 也不运行（Hub 的六个工具没有这种标注）；项目里的 hooks 需要 `--approve-hooks`。连接失败时用全屏界面里的 `/mcp` 才能看到原因。
- **看结果**：每次运行和提交都有运行编号；用管理员给你的账号登录 Hub 的只读控制台（`/console`，运行页 `/console/runs`，任务包页 `/console/packs`）可以查看。

## 常见问题

| 现象 | 可能原因 | 怎么办 |
| --- | --- | --- |
| `/mcp` 里没有 `hub`，或工具不出现 | `transport` 没写 `streamable_http`；`HUB_TOKEN` 没存；无头模式没加 `--extensions` | 对照上面的步骤；`/mcp` 会写出缺哪个请求头或哪个密钥 |
| 回答是"对你不可用" | 任务包没分配给你，或来源你没有权限；两种情况的回答完全一样 | 请管理员确认分配 |
| 所有调用都失败，提示未授权 | 令牌被吊销、账号被停用，或复制时多了空格 | 请管理员重发令牌，重新 `/secrets HUB_TOKEN` 后 `/mcp reload` |
| 长调用后 `fetch failed` | 连接断了，服务端可能还在算 | 用调用查询对账，不要重发 |
| 主机名不被接受 | Hub 只认配置里列出的主机名 | 用管理员给的那个地址，不要换成别名或 IP |

## 给管理员：开通一位同事

在装 Hub 的机器上，以服务账号运行（`circle-hub` 是 Hub 的命令行）：

```sh
circle-hub user create <名字> --role user
circle-hub token issue <名字> --label <标签> --raw      # 令牌只显示这一次，单独交给本人
circle-hub pack assign <名字> <任务包>                 # 工作流包要分配给用户才能用
circle-hub user disable <名字>                          # 停用立即生效
circle-hub token revoke <令牌编号>                      # 吊销立即生效
```

没有任务包分配的用户看到的是"对你不可用"。管理员账号能看到所有任务包和运行；普通用户只看到分配给自己的包和自己的运行。令牌不要通过聊天工具明文转发。
