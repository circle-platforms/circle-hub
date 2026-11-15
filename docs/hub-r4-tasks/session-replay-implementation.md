# Circle 回放脚本实施

使用者在全流程设计完成后要求“开始编写代码然后测试”。本任务从已签署设计分支新建 `implement/session-replay`，只修改本页、`scripts/real/replay-circle.ts`、`scripts/real/replay/` 和中英文兼容性历史。原始终端不接收输入；不修改源 Home、Circle 应用或业务系统，不合并、推送或部署。

验收以 [设计](session-replay.md) 为准：先合成测试，再使用明确指定的已安装 Circle Harness。真实来源包仅保存在 Git 外本机私有目录，源会话只读，工具和模型均为替身。业务正确性与 Harness 轨迹相符分别报告。


实现记录：

- 通过只读捕获保存消息及上下文原始字节，核验调用、子会话、拒绝、后台和图依赖。
- 使用实际已安装 Harness，显式替身工具与每会话模型；宿主通知不作为人工输入；支持上下文裁剪和 thinking 移除。
- 回放报告给出逐项计数、逐事件和投影摘要、首个差异及未证明的层次。
- 候选守卫需要明确提供的历史上下文，不能读取当前 Home 代替历史状态；上下文不足返回未知。
- 修正设计阶段的路径统计：宽泛提取所得四个字符串中，两个把句末句号算进了文件名。按固定版本文件语法解析后实际是两个文件引用，均能定位；不再报告两个不存在的“丢失文件”。

本机真实来源包与报告不纳入 Git。具体命令、最终计数及摘要在验证结束后追加；未修改源会话或现用终端。

## 最终验证

- `CIRCLE_HUB_REPLAY_CIRCLE_APP="$CIRCLE_APP" node --test scripts/real/replay/*.test.ts`：17 通过，0 失败，0 跳过。实际指定本机已安装 Circle 1.17.0；该变量缺失时集成测试明确跳过。
- `npx tsc --noEmit`：退出 0。
- `npm run test:docs`：389 通过，0 失败，0 跳过。
- `git diff --cached --check`：退出 0。
- 三项变异检查均被拒绝或标为未知，未得到完成结论：交换子调用结果、提前解除后台完成依赖、将 deny 改成 none。补充覆盖重复 Hook 拒绝无法唯一绑定的未知状态。

真实历史的本机隔离验收使用捕获包执行两次以下命令，未访问真实模型或业务服务，也未执行历史命令：

```sh
node scripts/real/replay-circle.ts run --bundle "$BUNDLE_DIR" --source-sha "$SOURCE_SHA" --circle-app "$CIRCLE_APP" --out "$RESULT_DIR"
```

两次均完成 19 个会话、2,610 条消息、1,055 条模型响应、1,360 次调用、49 条 Hook 拒绝和 2 个后台完成事件，保留 97 条历史工具错误。逐消息及请求投影轨迹共 3,665 条，两份报告逐字段相同。来源与派生结果分开绑定：

| 证据 | SHA-256 |
| --- | --- |
| 来源包清单 | `bd1efde7f91eed881a4e4b8e68a45c3b20f357dd3ab41b0527d925ec9dc81462` |
| 两次回放报告 | `0e5bf7176210ba545fa1cb92a9b0c10a16b1c6a051b2e826a431e641da004334` |
| 回放语义 | `2735af151aaade49eeb9f74bc1a817a600e8e51c5910ab336c90950dead76945` |
| 逐事件与投影轨迹 | `85ab5701e78bc90b78f691ebf02cb3f7af3f0e364a05c3cb9356c7452b84856f` |
| 执行适配器 | `ff3369f1375de2366191cd6aff3f9fea713e075e6e3b731e10d995e860218389` |

报告继续保留三项非阻塞缺口：完整模型请求报文与历史工具声明快照、非拒绝 Hook 决定的逐调用身份、一次编辑前文件版本。对应层次没有被标为已证明。当前只核验固定历史轨迹；未运行全量 Hub 业务验收、真实模型、设备或部署验证，未对缺少历史状态的真实候选守卫宣称比较通过。

## 2026-11-16 移植到 hub-next-6 与第 30 轮基线

本节记录把上面的实现带到 `hub-next-6` 之后的变化，以及在本机真实会话上的结果。真实来源包、报告和证据都在 Git 外的操作员目录，这里只写数量和摘要。

分支 `wp/claude/session-replay` 从 hub-next-6 开出，摘取设计与实现两个提交。冲突只在两处：中英文兼容性页的历史（保留 hub-next-6 的条目，回放条目置顶，日期改为 2026-11-16），以及 `.github/checks`：两页任务页登记为文档集的临时例外（`exceptions.json`），回放测试登记在 `test-suites.ts` 的 `NOT_RUN`（`scripts/**/*.test.ts` 不在默认单元测试里）。移植后 `npm run test:docs` 仍只有 hub-next-6 已有的那一处失败（`docs.test.ts:348`，`hub/platform/quickstart-first-apply.test.ts:15`），其余 255 项成功。

### 真实会话暴露的问题与修正

1. 6 个调用在 Hook 之前就被 Circle 以“参数不符合工具声明”拒绝，结果以 `<工具名> was called with invalid arguments: ` 开头，历史上没有 before_tool 决定。`compare` 原先对所有已启动的调用要求守卫上下文。现在只比较 Harness 实际交给 Hook 的调用（运行报告新增 `coverage.hookOrder`）。Circle 内置工具以外的工具（例如经 MCP 接入的），替身接受任何参数，Harness 会多问一次 Hook；这种调用按上述固定结果文字识别，不计入。第 30 轮 1,360 个调用中 1,354 个交给 Hook，与 `hooks.log` 的 1,354 条 before_tool 记录相同。
2. 真实守卫的判断取决于技能目录、会话表、声明文件和绝对路径的文字（空格切词、按长度截断），每个调用各带一份完整文件放不下。守卫上下文增加：共享文件集（`sets`）、变量（`variables`）、非文本文件（`{ "base64": … }`）、等长路径前缀（`mirror`）、不适用候选的记录（`candidate: false`）和依据说明（`baseline.evidence`）。
3. 没有 `--candidate-guard` 时运行上下文自带的守卫，这是基线核验。`--survey` 判断每个调用，给出相符、不符、未知的计数；`calls.jsonl` 保留逐调用的摘要。默认仍在第一个差异或第一个无法判断的调用处停止。
4. 守卫的输出按 Circle 1.17.0 对 before_tool Hook 的读法解释（退出码 2、非 JSON 输出、崩溃都是拒绝）；原代码另支持的 PreToolUse 输出形状不属于 1.17.0，已去掉。
5. 守卫读取沙盒之外的路径时，权限模型拒绝，预加载器经文件描述符 3 报告；读取之后出现的差异记为未知，不当作守卫的不符。

### 第 30 轮结果

| 项 | 结果 |
| --- | --- |
| 来源 | 根会话 1 个、子会话 18 个；2,610 条消息、1,055 条模型响应、1,360 对调用与结果、97 条错误、49 条 Hook 拒绝、80 个上下文版本、2 个后台完成通知、0 个其他分支 |
| 捕获 | 来源库及其 WAL 的摘要在捕获前后相同；`source.json` 摘要：不含守卫上下文的包 `be8e55cd81e2f837348935ab8162b65edb57a24d71565792a7c27ea27f1cf05b`，含守卫上下文的包 `e1960da4c862d2d107b603e7e1290e191b746cf18cf1fcb8b49cf81770e5fe45`（两个包的来源行摘要相同） |
| 回放 | 完成；两次逐字节相同；报告摘要 `37a3d7c2f9d1593d797f5522c3d9d682904323f51796241e28964c20d05b977b`，逐事件与投影轨迹摘要 `85ab5701e78bc90b78f691ebf02cb3f7af3f0e364a05c3cb9356c7452b84856f`（与上面最终验证所记相同），语义摘要 `2735af151aaade49eeb9f74bc1a817a600e8e51c5910ab336c90950dead76945`；执行适配器摘要 `52446e790b3a7a1b145897ba1beaa55feae73e5828bf1ad166083a7040871155`（`player.ts` 新增了 Hook 调用顺序，所以与上表不同） |
| 基线核验 | 1,354 个 Hook 决定：1,353 相符（1,305 个无意见，48 个拒绝且原因原文相同），0 不符，1 未知；两次运行的 `report.json` 逐字节相同 |

1,354 个决定中，41 个（32 无意见、9 拒绝）由 11-15 14:40:08 之前的守卫文件作出，1,313 个（1,273 无意见、40 拒绝）由当时重新生成的守卫文件作出；两套文件分别按操作员 14:40 记下的摘要核对。无意见的依据是 `hooks.log` 按会话内顺序与调用绑定（工具名逐个相同，拒绝的原因相同），不是调用 ID，所以只算日志顺序依据；49 条拒绝的依据是会话记录本身。

唯一的未知：决定相同（都是拒绝），原因文字不同。该调用的路径参数写成了一个不存在的用户目录（模型把用户名拼错），这个目录在沙盒之外，守卫读取它时被权限模型拒绝，走了另一条拒绝分支。同一调用在真实文件系统里就地运行时与记录一致（探索性核对，不是工具功能）。

### 运行

```sh
node scripts/real/replay-circle.ts compare --bundle "$BUNDLE_DIR" --source-sha "$SOURCE_SHA" --circle-app "$CIRCLE_APP" --out "$BASELINE_DIR" --survey
node scripts/real/replay-circle.ts compare --bundle "$BUNDLE_DIR" --source-sha "$SOURCE_SHA" --circle-app "$CIRCLE_APP" --candidate-guard "$GUARD_LIB" --out "$CANDIDATE_DIR" --survey
```

候选文件默认替换新守卫文件集里的守卫库（家目录下的 `hooks/guard-lib.ts`）；候选是入口脚本时，用 `--replace` 指定入口的相对路径。11-15 14:40:08 之前的 41 个决定由旧守卫文件作出，候选不适用，仍运行它们自己的文件，报告里算 `reference`。

### 边界

- 守卫上下文由操作员的私有脚本生成，不在 Git：来源是会话包（调用、已记录的拒绝、会话表）、运行报告的 Hook 调用顺序、`hooks.log`、两套守卫文件、已安装的技能目录和设置里与 Hub 地址有关的取值。技能目录没有历史摘要，只核对了最新修改时间早于第一条消息；工作目录的内容不在沙盒里。
- 只核验 before_tool。`before_stop` 的 3 条记录和后台、审批、问答等不经这条路径。
- 一个候选只能是一个文件；候选若改了入口或增加文件，需要重新生成上下文。
- 沙盒之外的路径、真实文件系统的状态和命令的实际效果不在沙盒里；这类差异记为未知，不是不符。

### 候选是 Circle 1.18 的钩子

候选 Circle 为 1.18.0-local.2 时，守卫用 PreToolUse 钩子协议（`hookSpecificOutput`、`mcp__<键>__<工具>`、按 `agent_id` 认子代理、设置里的 `mcpServers`），与记录里的 1.17.0 不同。`compare` 的候选这一路按那个 Circle 的 `src/hooks.ts` 和 `docs/hooks.md` 收发；基线（没有候选，或记录标了 `candidate: false`）仍按 1.17.0 的读法，报告逐字节不变。

- 候选可以是多个文件：`--candidate-guard` 可重复或给一个目录，这些文件替换记录守卫入口所在的文件夹（基线的其他文件不留）；`--candidate-settings` 替换文件夹旁边的 `settings.json`；`--candidate-entry` 指定入口。
- `--candidate-protocol 1.18`：输入是 `session_id`（根会话）、`cwd`、`permission_mode`、`hook_event_name`、子代理里的 `agent_id` 和 `agent_type`、`tool_name`、`tool_input`、`tool_use_id`、`paths`，环境里有 `CIRCLE_PROJECT_DIR`、`CIRCLE_SESSION_ID`、`CIRCLE_AGENT_ID`；历史里的 `hub_<工具>` 改为 `mcp__hub__<工具>`（`--mcp-server`）。输出按 `interpretHookRun` 和 `combineOutcomes` 读：退出码 2、`permissionDecision`、`onFailure`（取自候选设置里运行该入口的钩子，或 `--on-failure`）。这个读法与候选 Circle 的构建产物逐项对过：`protocol.test.ts` 在 `CIRCLE_HUB_REPLAY_CIRCLE_CANDIDATE` 指向候选 Circle 目录时，把 2,025 个组合（3 种 `onFailure`、5 个退出码、45 种输出、3 种错误文字）交给它自己的两个函数，决定、原因、失败与改写都相同，没有指定时明确跳过。
- `--decision-only`：候选按决定的种类与记录比较，原因文字可以不同（`reasonChanged` 单独计数）；`--candidate-all-cases`：记录标了 `candidate: false` 的也运行候选。报告另记改写了调用的答复、仍用旧格式作答的答复和失败的钩子。
- 候选的守卫文件由候选源码自己的生成器写出：把候选提交的 `scripts/real` 取成快照，在系统临时目录里建一个合成的验收主目录（合成的模型地址和令牌、记录里的 Hub 地址、上下文里的技能目录），调用快照里的 `writeHome` 和 `writeGuardFiles`，只留下守卫文件夹和 `settings.json`。不读写真实主目录。
