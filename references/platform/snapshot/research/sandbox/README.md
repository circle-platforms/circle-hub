# 本地研究沙盒

这里是研究脚本，不是生产模块。结论与范围见[研究记录](../../docs/research/local-sandbox-findings.md)，来源与回执见[证据目录](../../docs/research/sandbox-evidence/)。

独立目录用 `INFOSEC_LAB_ROOT` 指定，应包含 `runtime`、`sources`、`private`、`cache`、`evidence`。`private` 仅限当前用户访问，里面的密码、SSH 私钥、浏览器配置和运行地址不得提交。不要把目录指向真实设备数据或已有浏览器配置。脚本仅启动本轮自己的本地进程，不修改系统网络设置。

本轮环境是 macOS arm64、Node 24.17.0、Go 1.27.2、Python 3.12.13。研究依赖单独安装到 `runtime`：ssh2 1.17.0、Playwright 1.64.0、Stagehand 4.2.0。Playwright 的 Chromium 保存在独立 `cache/browsers`。完整版本以[来源回执](../../docs/research/sandbox-evidence/sources.json)为准。未证明其他系统的可重复性。

## 运行三个本地实验

先在独立 runtime 下建立私有 npm 项目并安装固定依赖；不在平台 packages 下安装。以下命令中的目录由操作者明确设置。

```sh
npm install --prefix "$INFOSEC_LAB_ROOT/runtime" ssh2@1.17.0 playwright@1.64.0 @browserbasehq/stagehand@4.2.0
PLAYWRIGHT_BROWSERS_PATH="$INFOSEC_LAB_ROOT/cache/browsers" "$INFOSEC_LAB_ROOT/runtime/node_modules/.bin/playwright" install chromium
```

网络实验需要可用的 `ssh-keygen`，会生成研究专用随机密码和密钥。它启动合成设备、业务后端及两级 SSH 跳转，并使用真实浏览器操作本地管理页面：

```sh
PLAYWRIGHT_BROWSERS_PATH="$INFOSEC_LAB_ROOT/cache/browsers" node research/sandbox/run-network-lab.ts --headed
```

Stagehand 实验使用上面安装的 SDK 和浏览器，仅执行指定动作。模型回调一旦被调用就抛错，禁止真实模型调用：

```sh
PLAYWRIGHT_BROWSERS_PATH="$INFOSEC_LAB_ROOT/cache/browsers" node research/sandbox/run-stagehand-lab.ts
```

Receptor 实验要求按来源回执取得上游源码，在源码目录用独立 Go 环境构建 `./cmd/receptor-cl` 为 `runtime/receptor`，并在独立 Python 环境安装其 `receptorctl`。脚本启动三个回环节点，停止并恢复中继，检查远端结果与恢复后的输出：

```sh
node research/sandbox/run-receptor-lab.ts
```

`receptor-work.ts` 是该实验唯一允许提交的合成工作。此实验未配置 TLS、签名或生产认证；不能用于连接其他网络。

## 证据与失败记录

运行会重建本实验拥有的合成状态并覆盖当前回执，复跑前需要把 `evidence` 备份到单独运行目录。不要并发运行同一目录的脚本。原始终端字节、截图、浏览器 trace、日志和结果留在本地，发布回执记录哈希；发布的 Receptor 回执将研究工作树绝对路径替换为占位符，并保留变换前后的哈希。

第一次 Receptor 调用把默认四次 ping 放在过短的超时内，随后又误把底层控制协议的 `work status` 当作 CLI 命令；已按本版本 CLI 改为单次 ping 与 `work list --unit_id`。这些是研究脚本错误，不能归因于上游协议失败。后续清理旧状态、按本次任务检查成功状态，并将输出 PID 与独立结果文件核对。

Stagehand 第一次使用 CommonJS require 加载 ESM 包，已改用该包导出的 ESM 文件；随后一次固定短等待未及时见到独立 HTTP 结果，改为有上限地等待该结果。指定动作成功不代表自然语言理解或完整 UI 自动化已通过。网络实验的身份漂移只是检测，尚未实现写入强制拦截。

OpenHands 的所选上游测试在独立 Python 环境中执行，使用原有模拟模型与临时目录。测试清单和日志哈希见[回执](../../docs/research/sandbox-evidence/openhands-tests.json)。其他项目本轮只读源码或官方文档，不应由这些脚本推断它们已经完整部署。
