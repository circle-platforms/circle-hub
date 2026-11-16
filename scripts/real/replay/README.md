# Circle 会话回放

`replay-circle.ts` 只读捕获一个会话图，在临时 Home 中用已安装 Circle 1.17.0 Harness 回放固定模型决策。模型和工具都是记录驱动的替身；不会执行历史命令、访问业务系统、打开人工提问或控制原终端。审批策略为明确的模拟允许策略，只作用于无实际副作用的替身；历史审批规则和真实文件效果不因此获得证明。

```sh
node scripts/real/replay-circle.ts capture --home "$SOURCE_HOME" --session "$SESSION" --circle-app "$CIRCLE_APP" --out "$BUNDLE_DIR"
node scripts/real/replay-circle.ts inspect --bundle "$BUNDLE_DIR" --source-sha "$SOURCE_SHA"
node scripts/real/replay-circle.ts run --bundle "$BUNDLE_DIR" --circle-app "$CIRCLE_APP" --out "$RESULT_DIR"
node scripts/real/replay-circle.ts compare --bundle "$BUNDLE_DIR" --circle-app "$CIRCLE_APP" --out "$COMPARE_DIR" --survey
node scripts/real/replay-circle.ts compare --bundle "$BUNDLE_DIR" --circle-app "$CIRCLE_APP" --candidate-guard "$GUARD" --out "$COMPARE_DIR" --survey
node scripts/real/replay-circle.ts compare --bundle "$BUNDLE_DIR" --circle-app "$CIRCLE_APP" --candidate-guard "$GUARD_FOLDER" --candidate-settings "$SETTINGS" --candidate-protocol 1.18 --decision-only --candidate-all-cases --out "$COMPARE_DIR" --survey
node scripts/real/replay-circle.ts compare --bundle "$BUNDLE_DIR" --circle-app "$CIRCLE_APP" --candidate-guard "$GUARD_FOLDER" --candidate-settings "$SETTINGS" --candidate-skills "$SKILLS_FOLDER" --decision-only --candidate-all-cases --out "$COMPARE_DIR" --survey
```

所有位置显式传入；输出必须是不存在的 Git 外目录，不能位于源 Home、源工作目录或应用目录。捕获后的 `source.json` 摘要可通过 `--source-sha` 锁定；包内摘要检测内容损坏，外部保存的根摘要用于绑定所选版本，摘要本身不是来源认证。

捕获保存消息与上下文的 SQLite 原始 BLOB 字节、会话祖先链、其余分支、来源版本、索引摘要及已观察的虚拟文件。回放只消费所选 head 祖先链。模型请求使用该版本的上下文投影和消息 ID 映射；其他内部通知保持宿主身份，拒绝通知由真实 Harness 在工具结果后产生。

结果目录包含 `report.json`、`trace.jsonl` 和中文 `summary.txt`。报告绑定来源包与运行适配器摘要；trace 保留逐消息及逐请求投影的来源身份、通道和期望/实际摘要，原始材料仍在来源包。终端仅打印状态、数量、摘要和缺失事实。`complete` 表示固定轨迹的已记录消息与边界结果相符，不代表原网络报文、原生 CircleRuntime 调度、业务正确性或真实模型的新决策相同。

`--pace recorded --speed 10` 按来源模型响应间隔控制呈现等待，不恢复原 token 分块或真实进程时序。`--timeout-ms` 限制整个回放，达到限额返回未知，不能当作完成。应用或工具能力不支持、必需证据不足退出 2；明确差异或包损坏退出 1；命令要求的核验完成退出 0。非阻塞证据缺口仍会随成功报告保留。

## 守卫比较

`compare` 先回放整条轨迹，再按 Harness 实际交给 before_tool Hook 的调用顺序逐个运行守卫，与历史决定逐项核对。没有 `--candidate-guard` 时运行上下文自带的守卫文件，这是基线核验，确认上下文能复现已记录的决定；给出候选文件后，候选只替换一个文件，其余文件不变：每条记录的 `replace` 文件（默认入口），或用 `--replace <相对路径>` 对所有适用候选的记录统一指定（路径必须是这些记录文件集里的文件）。一次调用的结果是相符、不符或未知：

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

**候选带着它写给的技能。** 守卫会读已装技能随附的文件（例如每个可执行脚本旁的 `<工具>.cli.json` 声明）时，只换守卫文件，守卫在记录里那套旧技能上找不到这些文件，会把本来放行的调用拒绝，这是方法造成的差异，不是守卫的变化。`--candidate-skills` 给一个目录，它的全部文件（不能有符号链接）替换每条记录守卫入口所在主目录（守卫文件夹的上一级）下的整个 `skills`，记录里的其他文件不变；目录由使用者准备，例如把候选提交自己的技能包按其清单装好、逐个文件核对大小和 SHA-256；回放工具只按字节使用它，不核对清单。它与候选协议无关，1.17.0 和 1.18 的候选都能用，要有候选守卫文件才能用；报告的 `candidate.skills` 记文件数和按文件名排序的摘要。不给时仍用记录里的技能。

**候选是 Circle 1.18 的钩子。** 候选的守卫文件可以是多个：`--candidate-guard` 可重复，也可给一个目录；给了不止一个文件或一个目录，这些文件就是候选自己的守卫文件夹，替换每条记录守卫入口所在的文件夹（基线的其他文件不留），入口用 `--candidate-entry` 指定，默认与记录的入口同名。`--candidate-settings` 的文件替换守卫文件夹旁边的 `settings.json`（其中的历史前缀同样换成私有前缀）。`--candidate-protocol 1.18` 让候选按 Circle 1.18.0-local.2 的 PreToolUse 钩子协议收发，依据是该 Circle 的 `src/hooks.ts` 和 `docs/hooks.md`：

- 输入：`session_id`（对话的根会话，子代理里也是它）、`cwd`、`permission_mode`（默认 `bypassPermissions`，即自动模式，`--permission-mode` 可改）、`hook_event_name: "PreToolUse"`、子代理里的 `agent_id`（该调用所在会话）和 `agent_type`（派出它的 task 调用的 `subagent_type`）、`tool_name`、`tool_input`、`tool_use_id`、`paths`。1.17.0 叫 `hub_<工具>` 的 MCP 工具，按 `--mcp-server`（默认 `hub`）改叫 `mcp__hub__<工具>`。环境里另有 `CIRCLE_PROJECT_DIR`、`CIRCLE_SESSION_ID` 和子代理里的 `CIRCLE_AGENT_ID`。
- 输出：退出码 2 加标准错误为拒绝；退出码 0 时标准输出的 JSON 里 `hookSpecificOutput.permissionDecision`（`allow`、`deny`、`ask`，`defer` 被忽略）和 `permissionDecisionReason` 决定；`hookEventName` 不符、字段类型不对、`{` 开头却不是 JSON 对象都算钩子失败。失败时按钩子登记的 `onFailure` 处理：`block` 拒绝该调用，不写则放行。登记取自 `--candidate-settings` 里运行该入口的 PreToolUse 钩子，`--on-failure` 可覆盖，都没有时按 `block`。此读法与候选 Circle 自己的 `interpretHookRun` 和 `combineOutcomes` 逐项对过（`protocol.test.ts`，用 `CIRCLE_HUB_REPLAY_CIRCLE_CANDIDATE` 指向候选 Circle 目录时运行）。
- `--decision-only`：候选按决定的种类（拒绝、询问、放行或无意见）与记录比较，不比原因文字；种类相同而文字不同的拒绝记入 `reasonChanged`。基线（没有候选、或记录标了 `candidate: false` 的）仍按 1.17.0 的读法逐字比较。
- `--candidate-all-cases`：记录标了 `candidate: false` 的（由另一套守卫决定的）也运行候选；一般与 `--decision-only` 合用。

比较目录含 `report.json`（计数、按角色和依据分的计数、第一个不符、第一个未知，不含原文）、`calls.jsonl`（逐调用的结果与摘要）、候选文件（单个文件是 `candidate-source.bin`，文件夹在 `candidate/`）以及每次尝试的 `guard-<序号>/`（实际 stdin、stdout、stderr 和回执，私有）。报告分别列出 attempted（已启动）和 compared（给出了可比较决定）；超时等没有决定的尝试不算已比较。同一包、同一候选重复运行，两份 `report.json` 逐字节相同。不同权限或旧文件状态无法在沙盒还原时，应补齐上下文，不放宽限制来追求通过。

## 开发验证

```sh
node --test 'scripts/real/replay/*.test.ts'
CIRCLE_HUB_REPLAY_CIRCLE_APP="$CIRCLE_APP" node --test 'scripts/real/replay/*.test.ts'
npx tsc --noEmit
```

不指定应用时，已安装 Harness 集成测试明确跳过；它们不是 CI 中已通过的证明。指定应用的测试只运行合成数据库和无副作用替身，覆盖主/子会话、投影裁剪、Hook、后台通知、守卫比较（基线核验、逐调用判断、等长前缀、沙盒之外的读取、Hook 之前被拒绝的调用）与隔离。这些测试文件不在默认的 `npm run test:unit` 里，用上面的命令直接运行。业务材料与本机绝对路径不得进入 Git。

## 提交回放（Hub 对已记录提交的核对）

这一组脚本不回放 Circle 会话，而是把 Hub 已经记录的每一次提交，用 Hub 自己的代码重新核对一遍，与当时存下的核对结果逐字段比较。验证逻辑一行也没有重写：回放建出 `assembleHub` 的真实装配，调用运行服务的 `submitResult`（`submit_result` 工具调用的就是它）；这里写的只是「Hub 当时处于什么状态」和「用什么调用」。

两种模式：

- `faithful`：每条核对用当时存下它的发布版本的代码树和运行启动时锁定的任务包回放，要求逐条相同。它证明回放本身可信。
- `candidate <提交>`：每条核对用这个提交的 Hub 代码和任务包回放：运行改绑到该提交里同名的任务包，每条分「相同」「不同」，不同的逐字段列出。

```sh
node scripts/real/replay/replay-submissions.ts run --mode faithful|candidate --export <导出目录> --bundle <数据包> --out <新目录> [--repo <代码树>] [--commit <提交>] [--windows <发布窗口文件>] [--run <运行号>]... [--seq <位置>]... [--limit <条数>]
node scripts/real/replay/replay-submissions.ts report --mode <模式> --export <导出目录> [--bundle <数据包>] --out <新目录> <part.json>...
node scripts/real/replay/replay-submissions.ts packs --export <导出目录> [--repo <代码树>]
node scripts/real/replay/replay-submissions.ts verify-bundle --bundle <数据包>
node scripts/real/replay/replay-submissions.ts preflight --export <导出目录> --bundle <数据包>
node scripts/real/replay/export-bundle.ts --pg-host <套接字目录或回环地址> --pg-port <端口> --pg-user <账户> --pg-database <库名> --objects <数据根>/objects --out <新目录> (--index <导出目录>/index.tsv | --run <运行号>...) [--cutoff <位置>] [--dry-run]
```

所有位置显式传入，输出目录必须是新目录，导出目录和数据包只读。`run` 要用 `node --import scripts/real/replay/submissions-net-guard.mjs` 启动：进程只准连回环地址，任何要连别处的代码路径（派发、读业务系统）在这里失败，不会真的出去。退出码：0 全部相同；1 有不同；4 一条也没能回放（缺 Hub 数据，既不是通过也不是失败）。

**输入一：记录导出**（`index.tsv` 加每个运行一个目录，`<位置>-run.json`、`-submission.json`、`-validation_result.json`、`-result_summary.json`）。每个文件读之前按 index 核对大小和 SHA-256；核对结果按提交的参数摘要配对到提交。

**输入二：Hub 数据包**（`replay-bundle@1`）。验证读的知识树、来源原件、记录和任务包都在 Hub 的数据库里，不在导出里。`export-bundle.ts` 在 Hub 所在主机上只读地写出它：`records`（按追加位置）及其 `record_index`、`record_keys`，`objects` 及字节，以及 `users`（不含口令摘要）、`pointers` 等几张小表；`tokens`、被扣留的原件字节、个人空间字节、调用日志等不导出，清单和理由写在 `manifest.json` 的 `withheld`。个人空间的记录只以标记形式在包里（内容留在 Hub），载入时数出来。`--dry-run` 只数不写。它只依赖 node 和 `pg`，不引用本仓库的 Hub 代码。`preflight` 在回放之前把记录里点名的东西（核对结果的 `validate` 动作、运行者账户、任务包和技能的 `pack_version`、知识根的组成、来源原件的字节和记录、绑定的 `rec:` 记录）逐个对数据包点名，缺什么列什么，用来决定还要不要补一次导出。

**回放的方法**。数据包按位置载入一个草稿库：载到被回放那条核对结果之前的每一条记录，之后的一条不载，所以回放读不到当时的答案；每条记录的摘要重算核对，每个对象按 SHA-256 核对。每条核对在草稿库的复制（`CREATE DATABASE ... TEMPLATE`）里回放，用当时 `validate` 动作记下的会话和模型，以运行者的身份调用。回放读不到的记录和对象（`store.get`、`objects.get` 返回空）记在每条结果的 `misses` 里，用来看数据包缺什么。

**归一**只有两项，输出里逐项列出并给出个数：`trace`（调用追踪号，每次随机）和 `exit.due`（未知的下一步期限，调用时刻加 24 小时）。候选模式再加 `locks.pack`、`locks.pack_digest`（运行改绑到候选任务包，这两项就是绑定本身）。其余字段，错误里的每个字（code、path、item、requirement、message、fix）、分区、覆盖、跨条目、轮次、锁定，逐字比较。

**不能回放**的每一条都有名字：`no_bundle`、`no_submission`（运行自己产生的结果，不经 `submit_result`）、`not_in_bundle`、`no_call_facts`（数据包里没有存下这条结果的 `validate` 动作）、`bundle_damaged`、`no_principal`、`served_from_record`（回放时 Hub 把当时已存的结果答了回来，没有重新核对）、`pack_not_in_commit`、`candidate_pack_refused`、`replay_error`。

开发验证：

```sh
node --test 'scripts/real/replay/submissions-*.test.ts'
```

这些测试用合成的 Hub（`createTestHub`）、合成的任务包和一个临时 PostgreSQL，端到端走一遍：导出数据包、写记录导出、回放、改一条记录看到「不同」、损坏数据包被拒、候选任务包改绑。它们不在默认的 `npm run test:unit` 里。
