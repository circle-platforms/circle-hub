# Circle 会话回放

`replay-circle.ts` 只读捕获一个会话图，在临时 Home 中用已安装 Circle 1.17.0 Harness 回放固定模型决策。模型和工具都是记录驱动的替身；不会执行历史命令、访问业务系统、打开人工提问或控制原终端。审批策略为明确的模拟允许策略，只作用于无实际副作用的替身；历史审批规则和真实文件效果不因此获得证明。

```sh
node scripts/real/replay-circle.ts capture --home "$SOURCE_HOME" --session "$SESSION" --circle-app "$CIRCLE_APP" --out "$BUNDLE_DIR"
node scripts/real/replay-circle.ts inspect --bundle "$BUNDLE_DIR" --source-sha "$SOURCE_SHA"
node scripts/real/replay-circle.ts run --bundle "$BUNDLE_DIR" --circle-app "$CIRCLE_APP" --out "$RESULT_DIR"
node scripts/real/replay-circle.ts compare --bundle "$BUNDLE_DIR" --circle-app "$CIRCLE_APP" --out "$COMPARE_DIR" --survey
node scripts/real/replay-circle.ts compare --bundle "$BUNDLE_DIR" --circle-app "$CIRCLE_APP" --candidate-guard "$GUARD" --out "$COMPARE_DIR" --survey
```

所有位置显式传入；输出必须是不存在的 Git 外目录，不能位于源 Home、源工作目录或应用目录。捕获后的 `source.json` 摘要可通过 `--source-sha` 锁定；包内摘要检测内容损坏，外部保存的根摘要用于绑定所选版本，摘要本身不是来源认证。

捕获保存消息与上下文的 SQLite 原始 BLOB 字节、会话祖先链、其余分支、来源版本、索引摘要及已观察的虚拟文件。回放只消费所选 head 祖先链。模型请求使用该版本的上下文投影和消息 ID 映射；其他内部通知保持宿主身份，拒绝通知由真实 Harness 在工具结果后产生。

结果目录包含 `report.json`、`trace.jsonl` 和中文 `summary.txt`。报告绑定来源包与运行适配器摘要；trace 保留逐消息及逐请求投影的来源身份、通道和期望/实际摘要，原始材料仍在来源包。终端仅打印状态、数量、摘要和缺失事实。`complete` 表示固定轨迹的已记录消息与边界结果相符，不代表原网络报文、原生 CircleRuntime 调度、业务正确性或真实模型的新决策相同。

`--pace recorded --speed 10` 按来源模型响应间隔控制呈现等待，不恢复原 token 分块或真实进程时序。`--timeout-ms` 限制整个回放，达到限额返回未知，不能当作完成。应用或工具能力不支持、必需证据不足退出 2；明确差异或包损坏退出 1；命令要求的核验完成退出 0。非阻塞证据缺口仍会随成功报告保留。

## 守卫比较

`compare` 先回放整条轨迹，再按 Harness 实际交给 before_tool Hook 的调用顺序逐个运行守卫，与历史决定逐项核对。没有 `--candidate-guard` 时运行上下文自带的守卫文件，这是基线核验，确认上下文能复现已记录的决定；给出候选文件后，候选只替换每条记录的 `replace` 文件（默认入口），其余文件不变。一次调用的结果是相符、不符或未知：

- 相符：决定和模型可见的完整 `reason` 都与历史记录一致。
- 不符：守卫给出了决定，且与记录不同。
- 未知：没有可比较的决定。原因记在 `cause`：`no-context`（该调用没有上下文记录）、`timeout`、`output-limit`、`forbidden-operation`（尝试写文件、起子进程或联网）、`outside-read`（见下）。

默认在第一个不符或第一个未知处停止，不给新结果播放旧模型的后续回答；`--survey` 判断每一次调用（并行运行），退出码 1 表示有不符，其次 2 表示有未知，否则 0。只有被 Harness 交给 Hook 的调用才会比较：Circle 1.17.0 在 Hook 之前就拒绝的调用（参数不符合工具声明，结果以 `<工具名> was called with invalid arguments: ` 开头）没有历史决定，不在其内，运行报告的 `coverage.hookOrder` 与 `invocationOrder` 的差即这些调用。

真实历史缺少某一步的声明、技能版本或路径状态时，比较停止并报告未知，不能用当前 Home 补齐。操作员在捕获时显式提供 `--guard-context <文件>`。该文件是 `circle-replay-guard-context@1`，顶层字段：

- `sets`：命名的文件集合（相对路径到文件内容）。文件内容是 UTF-8 文本，或 `{ "base64": "…" }` 表示非文本字节（例如会话表）。路径不允许越界。
- `variables`：Circle 在 Hook 看到参数之前展开的普通变量（`%名字%` 换成值）。机密不在其内。
- `mirror`：历史路径中的一个绝对目录前缀（只含字母、数字、点、下划线和连字符）。守卫运行在一个等长的私有前缀下，见下。
- `cases`：每条记录包含：
  - `session`、`call`：来源会话及工具调用身份。
  - `input`：该调用给守卫的完整 JSON。`tool_name` 必须等于来源调用，`tool_input` 只能是来源参数，或 `variables` 展开后的参数；`session_id` 若有必须是来源会话。
  - `entry`：守卫入口，是文件集合里的相对路径；`replace` 可选，指定候选替换哪个文件，默认入口。
  - `set`：文件集合的名字；也可以用 `files` 内联，二者必须且只能给一个。
  - `candidate`：`false` 表示这条记录由另一套守卫决定，给了候选也运行它自己的文件（报告里算 `reference`，不算 `candidate`）。
  - `baseline`：`decision`（allow/deny/ask/none）及模型可见的完整 `reason`；已记录的拒绝必须与原 Hook 通知一致。`evidence` 可选，说明依据（报告按它分别计数）。
  - `provenance`：合成夹具用 `scripted`，操作员审查的历史输入用 `operator`。此字段只是来源声明，不替代完整性证据。

守卫在 Node 权限模式下运行：只读它自己的沙盒目录，不继承模型密钥或父进程凭据，禁止写文件、子进程及网络（网络预加载器拒绝 net/tls/http/https/dgram/fetch 入口）。守卫的输出按 Circle 1.17.0 对 before_tool Hook 的读法解释：退出码 2 加标准错误为拒绝；退出码 0 时标准输出是 JSON 对象，`decision` 为 allow/deny/ask 之一，否则无意见；崩溃或输出不是 JSON 按 Hook 失败处理，Circle 此时拒绝该调用。此路径不运行守卫审查的历史命令；只有上下文里的文件和明确提供的候选代码会执行。

**等长前缀。** 守卫的判断和消息取决于绝对路径的文字，包括空格切词和按长度截断。`mirror` 指定的历史前缀在守卫看来换成了一个长度相同、只含普通字符的私有目录（默认建在 `/tmp` 的真实路径下，`--mirror-base` 可改），输入里整段出现的该前缀同样替换，守卫的原因文字再换回历史前缀后才与记录比较，因此截断位置和切词都与历史相同。前缀太短而放不下随机字符时返回未知。上下文的文件路径相对该前缀。

**沙盒之外的读取。** 沙盒只含上下文给出的文件。守卫尝试读取其他路径时，权限模型拒绝，预加载器把这些路径从文件描述符 3 报告出来，报告记 `outsideReads` 数量及摘要。读取了沙盒之外之后出现的差异不说明守卫有变化，记为未知（`outside-read`）；读取了沙盒之外但决定一致的算相符，另计 `matchedWithOutsideReads`。

比较目录含 `report.json`（计数、按角色和依据分的计数、第一个不符、第一个未知，不含原文）、`calls.jsonl`（逐调用的结果与摘要）、`candidate-source.bin`，以及每次尝试的 `guard-<序号>/`（实际 stdin、stdout、stderr 和回执，私有）。报告分别列出 attempted（已启动）和 compared（给出了可比较决定）；超时等没有决定的尝试不算已比较。同一包、同一候选重复运行，两份 `report.json` 逐字节相同。不同权限或旧文件状态无法在沙盒还原时，应补齐上下文，不放宽限制来追求通过。

## 开发验证

```sh
node --test 'scripts/real/replay/*.test.ts'
CIRCLE_HUB_REPLAY_CIRCLE_APP="$CIRCLE_APP" node --test 'scripts/real/replay/*.test.ts'
npx tsc --noEmit
```

不指定应用时，已安装 Harness 集成测试明确跳过；它们不是 CI 中已通过的证明。指定应用的测试只运行合成数据库和无副作用替身，覆盖主/子会话、投影裁剪、Hook、后台通知、守卫比较（基线核验、逐调用判断、等长前缀、沙盒之外的读取、Hook 之前被拒绝的调用）与隔离。这些测试文件不在默认的 `npm run test:unit` 里，用上面的命令直接运行。业务材料与本机绝对路径不得进入 Git。
