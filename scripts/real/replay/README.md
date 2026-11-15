# Circle 会话回放

`replay-circle.ts` 只读捕获一个会话图，在临时 Home 中用已安装 Circle 1.17.0 Harness 回放固定模型决策。模型和工具都是记录驱动的替身；不会执行历史命令、访问业务系统、打开人工提问或控制原终端。审批策略为明确的模拟允许策略，只作用于无实际副作用的替身；历史审批规则和真实文件效果不因此获得证明。

```sh
node scripts/real/replay-circle.ts capture --home "$SOURCE_HOME" --session "$SESSION" --circle-app "$CIRCLE_APP" --out "$BUNDLE_DIR"
node scripts/real/replay-circle.ts inspect --bundle "$BUNDLE_DIR" --source-sha "$SOURCE_SHA"
node scripts/real/replay-circle.ts run --bundle "$BUNDLE_DIR" --circle-app "$CIRCLE_APP" --out "$RESULT_DIR"
node scripts/real/replay-circle.ts compare --bundle "$BUNDLE_DIR" --circle-app "$CIRCLE_APP" --candidate-guard "$GUARD" --out "$COMPARE_DIR"
```

所有位置显式传入；输出必须是不存在的 Git 外目录，不能位于源 Home、源工作目录或应用目录。捕获后的 `source.json` 摘要可通过 `--source-sha` 锁定；包内摘要检测内容损坏，外部保存的根摘要用于绑定所选版本，摘要本身不是来源认证。

捕获保存消息与上下文的 SQLite 原始 BLOB 字节、会话祖先链、其余分支、来源版本、索引摘要及已观察的虚拟文件。回放只消费所选 head 祖先链。模型请求使用该版本的上下文投影和消息 ID 映射；其他内部通知保持宿主身份，拒绝通知由真实 Harness 在工具结果后产生。

结果目录包含 `report.json`、`trace.jsonl` 和中文 `summary.txt`。报告绑定来源包与运行适配器摘要；trace 保留逐消息及逐请求投影的来源身份、通道和期望/实际摘要，原始材料仍在来源包。终端仅打印状态、数量、摘要和缺失事实。`complete` 表示固定轨迹的已记录消息与边界结果相符，不代表原网络报文、原生 CircleRuntime 调度、业务正确性或真实模型的新决策相同。

`--pace recorded --speed 10` 按来源模型响应间隔控制呈现等待，不恢复原 token 分块或真实进程时序。`--timeout-ms` 限制整个回放，达到限额返回未知，不能当作完成。应用或工具能力不支持、必需证据不足退出 2；明确差异或包损坏退出 1；命令要求的核验完成退出 0。非阻塞证据缺口仍会随成功报告保留。

## 候选守卫上下文

真实历史缺少某一步的声明、技能版本或路径状态时，比较停止并报告未知，不能用当前 Home 补齐。操作员可在捕获时显式提供 `--guard-context <文件>`。该文件是 `circle-replay-guard-context@1`，`cases` 中每条记录包含：

- `session`、`call`：来源会话及工具调用身份；`input.tool_name/tool_input` 必须等于来源调用，不能改写模型参数。
- `input`：该调用给守卫的完整 JSON；执行时仅把 `cwd` 映射到隔离工作目录，并记录实际输入摘要。
- `entry`：上下文中可执行守卫入口的相对路径；`replace` 可选，指定候选文件替换哪个相对文件，默认替换入口。
- `files`：相对路径到 UTF-8 文件内容的映射；必须包含入口及替换目标，不允许路径越界。依赖文件必须显式列出。
- `baseline`：`decision`（allow/deny/ask/none）及模型可见的完整 `reason`；已记录的拒绝必须与原 Hook 通知一致。
- `provenance`：合成夹具用 `scripted`，操作员审查的历史输入用 `operator`。此字段只是来源声明，不替代完整性证据。

守卫在 Node 权限模式下只读隔离上下文；不继承模型密钥或父进程凭据，禁止写文件、子进程及网络。网络预加载器拒绝 net/tls/http/https/dgram/fetch 入口。依赖被禁止的能力、超时或格式无效均标记未知。候选源码以及每次实际 stdin/stdout/stderr 和退出回执保存在比较目录，报告分别列出 attempted 和 compared 数量；超时等没有决定的尝试不算已比较。此路径不运行守卫审查的历史命令；只有明确提供的候选代码会执行。

比较先验证完整基线，再按实际 Harness 工具调用顺序执行候选守卫。决定或完整反馈第一次不同就停止，不给新结果播放旧模型的后续回答。支持旧 before_tool 决定和 PreToolUse 输出；拒绝退出码 2 的标准错误作为理由保留。不同权限或旧文件状态无法在隔离目录还原时，应补齐适配器，不放宽限制来追求通过。

## 开发验证

```sh
node --test 'scripts/real/replay/*.test.ts'
CIRCLE_HUB_REPLAY_CIRCLE_APP="$CIRCLE_APP" node --test 'scripts/real/replay/*.test.ts'
npx tsc --noEmit
```

不指定应用时，已安装 Harness 集成测试明确跳过；它们不是 CI 中已通过的证明。指定应用的测试只运行合成数据库和无副作用替身，覆盖主/子会话、投影裁剪、Hook、后台通知、守卫比较与隔离。业务材料与本机绝对路径不得进入 Git。
