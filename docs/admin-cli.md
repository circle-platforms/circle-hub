# 本机第一阶段管理命令

在隔离工作树运行 `npm run dev:stack`。它启动临时 PostgreSQL、受监管 server、`lab-east-01` / `lab-east-02` 和合成连接器资源。打印 developer 与独立 approver 的随机开发登录方式；账号 `defect-bot` / principal `prn_defectbot` 仅用于获准规则的服务身份。developer 的管理与合成操作权限在开发配置中显式授予；approver 只具备任务读取和批准权限，不具备设备操作权限。

登录仍是 `POST /v1/auth/dev-login`。将 token 放在 Git 外的权限受限文件，设置 `CIRCLE_HUB_TOKEN_FILE`；或通过 `CIRCLE_HUB_TOKEN` 注入。CLI 不打印 token，不接受 principal/role 参数。`CIRCLE_HUB_URL` 为启动时打印的本机地址，`CIRCLE_HUB_SCOPE` 默认 `scp_lab`。CLI 和 worker 当前只支持该本机开发配置。

本地可执行入口为 `./bin/circle-hub admin ...`，也可运行 `npm run admin -- ...`。发布包 bin 指向同一个 TypeScript CLI，本阶段没有软件发行或全局安装。

| 命令 | 行为与权限 |
|---|---|
| `circle-hub admin tasks` | 当前 tenant 和获准 scope 的持久任务；需要 admin.manage 与相应任务读取权限 |
| `circle-hub admin workers drain lab-east-01` | 不再接新操作，等待已有操作完成后返回 inFlight=0；不把排空当作取消或远端停止 |
| `circle-hub admin approvals` | 作用范围内的审批绑定和状态；列表访问不授予批准或设备操作权限 |
| `circle-hub admin events --tail` | 从 seq=0 按游标持续补读当前范围的事件；`--once` 输出一页，Ctrl+C 退出尾读 |
| `circle-hub`、`circle-hub help`、`circle-hub admin help` | 打印用法并退出 0；不要求令牌 |
| `circle-hub admin audit` | 当前范围的管理/受理审计记录，最多 500 条；没有密码或 token |
| `circle-hub admin audit --format json\|csv` | 导出审计。可选 `--timezone`（IANA）、`--action`、`--principal`、`--since`、`--until`。CSV 为原始文本，JSON 为带时区时间的对象；默认不带参数的 `audit` 仍是 JSON 数组 |
| `circle-hub admin connectors disable bugzilla-synthetic` | 在当前 scope 禁用连接器，后续准入与执行出口拒绝调用 |
| `circle-hub admin connectors enable bugzilla-synthetic` | 在当前 scope 恢复连接器；仍按调用人的数据和动作权限检查 |
| `circle-hub admin restart --graceful` | 需要独立 admin.restart 权限；停止接新请求、提交已有事务，由 supervisor 以相同端口启动新 server，CLI 确认新 bootId 后返回 |

例如使用 npm 的项目入口：

```sh
export CIRCLE_HUB_URL=http://127.0.0.1:7410
export CIRCLE_HUB_TOKEN_FILE=/tmp/circle-hub-dev-token
npm run admin -- tasks
npm run admin -- workers drain lab-east-01
npm run admin -- approvals
npm run admin -- events --tail --once
npm run admin -- audit
npm run admin -- connectors disable bugzilla-synthetic
npm run admin -- connectors enable bugzilla-synthetic
npm run admin -- restart --graceful
```

这里的端口示例须替换为本次启动地址；token 文件须由本次开发登录产生。token 默认 5 分钟，到期需重新登录。所有命令使用同一认证 API；错误以结构化 code/message 写 stderr 并返回非零退出码。

server 的受监管启动入口是 `npm run server`（需要显式临时数据库/身份/对象目录配置）；`npm run dev:stack` 自动准备这些参数。直接运行 main.ts 没有 supervisor 时，restart 会明确拒绝。优雅重启保存 PostgreSQL 中的任务、输入、批准、操作、游标与事件；不将缺少回报的操作改成成功。Ctrl+C 停止整个 dev stack 并删除临时数据，下一次 dev:stack 是新环境。

关停开始后，JSON 与制品响应带 `Connection: close`，task/admin 的 events 长轮询立即结束，返回已经读取的事件和原游标。server 每 50ms 清理空闲连接，5 秒 HTTP 宽限期后关闭仍未完成的连接，随后等已进入处理程序的请求和当前 runner 收尾，再关闭 PostgreSQL 连接池。CLI 取得新 bootId 后报告重启完成并返回进程 PID，验收另外核对 PID 已更换；客户端可按保存的游标向新进程补读事件。supervisor 的退出保护为 10 秒，dev:stack 的子进程退出保护为 15 秒，给 HTTP 排空和数据库清理留出时间。

重复验证重启可运行 `node --test --test-name-pattern='admin graceful restart' tests/acceptance/admin.test.ts`。三条验收分别覆盖持久状态恢复、持续 keep-alive 轮询与两种挂起的 events 长轮询、未完成请求体的 5 秒关停上限；验证记录见[第一阶段进度](server-s1-progress.md)。

合成缺陷能力使用 `defect-review`，绑定 `defects` / `documents` / `product` 角色。规则由 `POST /v1/rules` 创建；调用范围是服务身份与规则所有者的交集，不能通过服务身份读取所有者不可见的缺陷。Bugzilla 与 Jira 的清单提供相同标准操作，可在 bindings.defects 中替换。当前 OpenKM 桩的转换是显式的合成 JSON→文本，不声称通用 Office/PDF 转换或真实企业系统兼容。
