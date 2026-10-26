# 任务：给 Circle 做 Jev 技能——密钥只在 Circle 一侧，判断在客户端，归位提议交 Hub 核验

依据：

- 决定 35 运维第 8 条（所有者 10-23 晚）：Hub 不用 Jev（决定 15）；给 Circle 客户端做一个 Jev 技能，密钥只在 Circle 一侧，由技能脚本在运行时读。
- 决定 26：生成在客户端，任务包随技能带 TypeScript 脚本，Hub 只核验（理论文档第 3 节 R7：生产和独立检查分开）。决定 25：回注走单独的回注运行，Hub 只做确定性核验。
- 模型 K04、K03（`node tools/show-element.ts K04 K03`，K03 以 kb-candidates 改过的为准）；回注包 `packs/workflow/knowledge-contribution`（kb-candidates 分支：`workflow.json`、`slots.schema.json`、`SKILL.md`、`README.md`、`pack-files.ts`）。
- 拿掉的 Hub 客户端，用 `git show 7c1ecaa5^:<路径>` 读：`hub/jev/http.ts`、`hub/jev/test-support.ts`、`hub/jev/README.md`、`scripts/real/jev-smoke.ts`。仓库里还留着的形状：`hub/jev/`（validate、record、decide、batch、tokens），`hub/knowledge/placement.ts`、`calibration.ts`，`hub/knowledge/service.ts` 的 buildCalibrationSet。任务页 `no-judgment-in-hub.md`、`jev-optin.md`。
- `docs/hub-r4-device-run.md` 第 1 节第 0 步、决定 35 上台架第 12 问：包里的脚本由集成者放进所有者 Circle 的技能目录，按 pack.json 的摘要核对。
- Circle 现状（Circle 仓库，只读，不改）：`docs/skills.md`、`docs/security.md`、`docs/hooks.md`、`src/mcp_loader.ts`、`src/sandbox.ts`；Hub 这边的 `scripts/real/circle-home.ts`（专用评审目录）。

- 分支和工作树：`jev-skill`，目录 `circle-hub-jev-skill`，从 kb-candidates 开出（要它的回注包、回注层和新加的三个词表轴；kb-candidates 再有提交时合进来，合并时排在它后面）。原先排在它前面的“回注署名”一件已按所有者的更正作废（决定 35 第 6 项：只有会话说法的不入库）。
- 可以改的路径：
  - `packs/workflow/knowledge-contribution/tools/jev/**`（新）；
  - `packs/workflow/knowledge-contribution/testing/**`（新：假 Jev、假 Hub，不发布）；
  - 这个包的 `pack-files.ts`、`pack.json`（重签）、`SKILL.md`、`README.md`；
  - `tests/acceptance/` 新增一个场景文件。

  别的路径不动；Hub 核心、合约、`hub/jev`、`hub/knowledge` 缺什么先回报。
- 规则：同前（不推送、不建 PR、不发布、不部署；不碰 7420、钥匙串、环境配置文件和任何真实系统；测试只用合成数据，版本线 10.6 以后，地址只用 192.0.2.0/24 和 2001:db8::/32；git commit -s）。另外：
  - 不调用真实的 Jev，不碰持久部署里放在一边的旧密钥；测试只用本机回环的脚本化假 Jev 和假 Hub。
  - 所有者的规矩：Hub 只核验，不生成内容、不调用模型，也不经手 Jev 的密钥；生成在 Circle 一侧，经包里的技能脚本（决定 26）；未知只能是过渡状态，写明缺的事实和下一步动作；枚举只来自生成的词表（技能用 `pack-files.ts` 生成的快照）；技能和核心一样不写产品词。
- 验证：`npx tsc --noEmit`；`node packs/workflow/knowledge-contribution/pack-files.ts --check`；`node --test --test-concurrency=1 "packs/workflow/knowledge-contribution/**/*.test.ts"`；`node --test hub/jev/no-judgment-egress.test.ts packs/workflow/case-review/packs.test.ts`；`node --test --test-concurrency=1 tests/acceptance/<新文件>`。

## 先知道的

Jev 是 TypeSafe 的类型化判断模型：只回答是否、单选、打分三种题，给概率，不生成文字。拿掉以前的 Hub 客户端这样叫它：

- 一个接口：`POST <基地址>/v1/systemone`，头 `Authorization: Bearer <密钥>`，JSON 进出；对方的请求号在应答头里（旧代码的 `REQUEST_ID_HEADER`）。基地址的默认值就是旧代码的 `DEFAULT_BASE_URL`，这里不重写。
- 请求 `{model, state, questions}`。state 是字符串、对象或数组，题目用反引号写 state 里的键来指片段。题型：是否 `noul`（可给 true、false 的说明）、单选 `choice`（1–255 个选项，没有弃权，要自己加 `none`；选项名不能是纯数字）、打分 `score`（2–10 个等级说明）。
- 应答 `{model, answers, usage}`：是否题给“是”的概率；单选题给所选项、置信度和每个选项的概率；打分题给期望等级、置信度、legend 和每级概率。概率和与 1 相差不超过 1e-3；同一对象里不许有重复的键。
- 模型钉确切版本（`名字-主.次.修订`），`jev-latest`、`jev-preview` 这类别名不收，返回的版本必须和钉的一样，阈值按确切版本校准。当时钉的版本是冒烟脚本的默认值。
- 限额和重试（旧 README 第 3–6、9、10 条）：请求体最多 32 MiB（默认 16 MiB）；每次请求 64k、每题 32k 令牌，按偏高的估算每次最多 10 题、48,000 和 24,000；并发 2；429、529、408、5xx、断网、超时重试 2 次，退避 0.5 秒翻倍到 5 秒，Retry-After 超过 60 秒就直接失败；401、403 停；413 或 `max_tokens_exceeded` 拆半一次；不跟重定向。
- 密钥（旧 README 第 2 条）：每次尝试才取，只进 Authorization 头；对方回来的任何东西里有密钥或它连续 12 个字符，整份丢弃；错误信息不带请求体和应答体。
- 判断记录（`hub/jev/record.ts`）：请求和返回的模型、确切版本、请求号、题目、按发出次序的选项、片段摘要和整个 state 的摘要、每个选项的概率、应答、用量、判断时间、复用键（`jev-reuse@2`，有金标测试）。
- 校准（`hub/knowledge/calibration.ts`，样例怎么出见 buildCalibrationSet）：链 `placement.choice`，按确切版本；样例取代码挂好的条目，遮掉路径和命令字面，在已知路径的每一层提问；阈值取这样的最低概率：它及以上往下走的回答里，选对比例的 Wilson 下界不低于 0.95，且至少 30 个。没校准就不往下走，回答只作候选。
- 归位（`hub/knowledge/placement.ts`）：从起点往下每层一道单选，选项是子节点名（不能用的名字换成 child-k），说明是子节点第一条条目的第一行，截到 160；`none` 放最后；超过 254 个子节点先按字面缩小；已校准、选的是子节点、不并列、p 不低于阈值才往下走。显示 `归类判断：Jev@<确切版本>，p=…，只影响位置`。
- 外发的保险（`jev-optin.md`，`contracts/src/product.ts` 的 `placement`）：生产器声明 `code_only`（默认）或 `judgment_allowed`，FAMX 只有手册生产器是后者。决定 15 以后 Hub 没有这项能力，声明留着，表示哪些条目以后可以交出去归位。客户端读不到这个声明（`get_nodes` 的条目只有种类，没有生产器），所以技能按条目种类管外发。

Circle 现在怎么接技能和密钥（不改 Circle）：

- 技能是带 `SKILL.md` 的目录（文件头 `name`、`description`），放在 Circle 数据目录的 `skills/` 下；脚本放在旁边，模型按技能目录去跑，Circle 自己不跑脚本（`docs/skills.md`）。
- 技能目录里的 `hooks.json` 在本会话载入这个技能以后生效；`before_tool` 钩子回 `ask` 时，auto 模式下也出确认卡片（`docs/hooks.md`）。钩子在工作目录里跑，Circle 不给技能目录的路径。
- 按名字的密钥（`docs/security.md`）：所有者用 `/secrets 名字` 或桌面设置存；模型只写 `%名字%`，执行时 Circle 代入，输出里出现的值换回 `%名字%`；带密钥的命令在手动模式下每次都问。命令的环境里，名字带 KEY、TOKEN、SECRET、PASS 这类词的变量都被去掉（`src/sandbox.ts` 的 shellEnvironment），脚本拿不到环境里的密钥。
- MCP 结果只把文本给模型（`src/mcp_loader.ts`，hub-mcp-client 分支也一样）：Hub 的结构化应答模型看不到，也就没法把精确的 JSON 交给脚本。
- 专用评审目录（`scripts/real/circle-home.ts`）：Hub 令牌存成密钥 `HUB_TOKEN`，默认 auto 模式，钩子只放行 Hub 的六个工具和待办清单，`execute` 被拒。这个技能不装在这里。
- 技能装在另一个主目录，上机和技能都用它，由集成者另备，评审目录不动。它的数据目录钩子放行这几样：Hub 的六个工具、待办清单、技能工具，`execute` 跑 `node <技能目录>/jev.ts …`，以及用例编译包的 `node <技能目录>/tools/*.ts`。第 4 条的 `--send` ask 钩子也装进它自己的 `hooks.json`：数据目录的钩子总是生效，技能目录里那份要等技能载入以后才生效。

## 要做的

1–6 是第一步（技能本身和 `ask`），7–10 是第二步（归位提议交回注运行），11 是两步都要的文档。

1. **技能目录。**新目录 `packs/workflow/knowledge-contribution/tools/jev/`。`tools/` 是包合约里本地工具的位置（`contracts/generated/protocol.ts` 的 PACK_FILE_PATHS），`packs/workflow/case-review/packaging.ts` 签名时会把它算进 pack.json，`*.test.ts` 不算。
   - 内容：`SKILL.md`（第 11 条）、入口 `jev.ts`、`lib/*.ts`、`hooks.json`、`egress.json`、`generated.json`、`examples/`（合成的 ask 输入和提议样例）。
   - 自成一体：只用 Node 内置模块和全局 fetch，只导入本目录的文件；可擦除的 TypeScript，Node 24 直接跑。包的 `functions/` 不导入 `tools/`。这样 `script-distribution.md` 给 `tools/` 加的发布检查也能过。
   - `generated.json` 由 `pack-files.ts` 写，`--check` 比对，脚本里不手写枚举。内容：
     - 包的 id 和版本，不写包号。generated.json 自己列在 pack.json 的清单里，写不进它所在那个包的摘要。
     - entry_kind、document_output_kind、relation_kind、read_tier 的码和标签，取自 `contracts/generated/vocabulary.ts`。
   - `pack-files.ts --verify-install <目录>`：逐个比对目录里的文件和 pack.json 里 `tools/jev/` 各项的 sha256 和大小，多一个、少一个、改过一个都报。集成者照决定 35 上台架第 12 问的做法，把 pack.json 里列着的 `tools/jev/` 文件（测试不在里面）装到上面那个上机和技能用主目录的 `skills/jev/`，再跑这条核对。
   - Circle 只认 `skills/` 下一层（或下两层、中间那层没有 SKILL.md）的技能目录。`script-distribution.md` 的 `local-tools install` 把整个包装成 `<目录>/<包>@<版本>/`，顶上是回注包自己的 SKILL.md，`tools/jev/` 在那里不会被认出来；所以下发做好以后，也是把装好的 `tools/jev/` 放到 `skills/jev/`，照样跑上面这条核对。
   - 包升一个次版本（接在前面已有的版本后面），用 `node packs/workflow/knowledge-contribution/pack-files.ts` 重签。

2. **密钥和配置只在 Circle 一侧。**
   - 所有者在上机和技能用的主目录里存密钥 `JEV_API_KEY` 和 Hub 令牌 `HUB_TOKEN`（和评审目录同名），再存普通变量 `JEV_MODEL`（确切版本）和 `HUB_URL`（Hub 的 MCP 地址）。SKILL.md 写明是哪个主目录。脚本不读 Circle 的任何文件。
   - 命令只有一种写法，密钥从标准输入进：

     ```
     node <技能目录>/jev.ts <子命令> --hub %HUB_URL% --model %JEV_MODEL% <参数> <<'EOF'
     %JEV_API_KEY%
     %HUB_TOKEN%
     EOF
     ```

     第一行是 Jev 的密钥，第二行是 Hub 令牌；`lock`、`submit` 不叫 Jev，不要 `--model`，标准输入只有 Hub 令牌一行。不从参数、不从环境读密钥，给了 `--key` 这类参数就拒绝。
   - 每个子命令都要 `--out <目录>`（工作目录里的一个文件夹）：记录和结果都写在那里，记录只追加，已有的回执不覆盖。
   - 读到原样的 `%JEV_API_KEY%`（Circle 里没存）、空行，或不是 RFC 6750 的 b64token（1–4096 个字符）：什么都不发，写明缺的是哪个密钥，下一步是所有者用 `/secrets JEV_API_KEY` 存。Hub 令牌同样处理。
   - Jev 的密钥只进发给 Jev 的 Authorization 头，Hub 令牌只进发给 Hub 的；都不打印、不写文件；回显照旧客户端第 2 条整份丢弃。
   - 模型只收确切版本，返回的版本必须相同。名字里带 `scripted` 的版本只许对本机回环地址用，真实地址只收不带 `scripted` 的版本，脚本化的判断冒充不了真实的。
   - 地址：Jev 用旧客户端的默认值，`--base-url` 可改；对 Jev 和 Hub 都只用 https，明文 http 只许本机回环；不跟重定向。

3. **读 Hub。**模型看不到结构化应答，所以要精确内容时，脚本自己做普通的 MCP 客户端，用用户自己的令牌，只用 Hub 的标准工具：
   - 向 `HUB_URL` 发 JSON-RPC：先 initialize，再 tools/call；Accept 带 `application/json, text/event-stream`；只认 JSON 应答（Hub 是无状态、JSON 应答，`hub/server/mcp.ts`）；读 `structuredContent`。
   - 第一步只用 get_nodes：`{root, paths, depth}` 按 `next` 翻完页；`{reference}` 读 src: 片段。只发 `read_tier` 为 `model_readable` 的文字，别的读层不发，照 Hub 的说明报出来。

4. **外发：技能声明发什么。**`egress.json` 写清默认，脚本照它执行：
   - 默认只发：种类是“定义”“行为”的条目原文（命令定义和手册片段）；问题本身；选项（子节点名，加子节点第一条“定义”或“行为”条目的第一行）。
   - 其余的（“用例”“缺陷”“观察”条目，src: 片段）只在这一次调用带 `--send <种类码或 src>` 时发，只对点名的那一类选择加入，不留到下一次。不管选择加入了什么，选项说明都不取用例、缺陷、观察条目的文字。
   - 片段的文字和种类一律取自 Hub 的应答，不信请求文件里写的。
   - 问题文字是模型写的，脚本证明不了里面没有用例或缺陷文字：限长（instructions 2,000 字，每个选项说明 160 字），原样记进判断记录；SKILL.md 写明不许这样写。
   - `hooks.json`：一条 `before_tool` 钩子，只管 `execute`。命令里跑 `jev.ts` 又带 `--send` 时回 `{"decision":"ask"}`，由所有者在卡片上点头；读不懂输入也回 ask；其余回 `{}`。命令用 `node --input-type=module -e` 内联写，不依赖安装路径，摘要核对照样成立。
   - 技能目录里这份钩子只在会话载入技能以后生效；模型不载入技能、直接跑 `jev.ts --send` 时，拦它的是主目录自己 `hooks.json` 里的同一条钩子，由集成者装（见“先知道的”）。SKILL.md 和 README 都写明这一点。
   - 发出记录 `requests.jsonl`，每次请求一行：时间、请求摘要、发出的片段（引用、种类或 src、sha256、字节数）、这次选择加入的类别、题目标识、尝试次数、HTTP 状态、对方的请求号、结果。不记文字，不记密钥。

5. **`ask`：一次类型化判断。**
   - 输入 `jev-ask@1`：`pieces: [{id, reference}]`（只收 tree: 条目引用和 src: 片段引用）和 `questions`。三种题型照服务商的接口；题型名是服务商的判别字段，不是词表轴，和 `hub/jev/api.ts` 一样。
   - 脚本从 Hub 取片段，过第 4 条，拼 state（键是片段 id），校验请求，问 Jev，校验应答。校验、分批、令牌估算照 `hub/jev/validate.ts`、`batch.ts`、`tokens.ts` 复制改写；重试、退避、错误归类照拿掉的 `http.ts`。
   - 判断记录 `judgments.jsonl`，只追加，字段和复用键照 `hub/jev/record.ts`。一次请求的每道题都有同一复用键的记录，就不再发（K04 R[2]）。
   - 屏幕上每道题一行：答案和概率（单选给最高项和 p，是否给“是”的 p，打分给期望等级和各级概率），`Jev@<确切版本>`；最后一行写这次发了什么、选择加入了什么。
   - 失败都写明缺什么和下一步：密钥被拒→所有者换密钥；限流→等几秒后重跑；服务不可用→稍后重跑，已有回答复用、不重复计费；太大→少放片段；超时→“本地超时不证明对方没处理，可能已计费”，重跑。服务商的应答正文不打出来。退出码：0 做完；1 输入或配置被拒，什么都没发；3 有题没得到回答，重跑接着做。

6. **第一步的测试。**全部本机回环。脚本化的假 Jev 照拿掉的 `test-support.ts` 改写，放 `testing/`；假 Hub 的每个应答在测试里用 `contracts/src/tools.ts` 的形状校验。
   - 密钥：从第一行读；原样的 `%JEV_API_KEY%`、空、格式不对、`--key` 参数都在发出前拒绝；环境里设了 `JEV_API_KEY` 也不读；stdout、stderr 和输出目录里的所有文件都找不到密钥和它连续 12 个字符；假 Jev 回显密钥时整份丢弃；假 Jev 收到的请求里没有 Hub 令牌，假 Hub 收到的请求里没有 Jev 的密钥。
   - 传输：http 只许回环；不跟重定向；429、529、5xx、超时的重试次数和等待；Retry-After 超过 60 秒立即失败；401 停；413 和 `max_tokens_exceeded` 拆半一次。
   - 校验：一组共用样例，脚本的收拒和 `hub/jev/api.ts` 的 checkRequest、checkResponse 完全相同；复用键等于 `reuseKey`；别名、返回别的版本、scripted 版本对非回环地址都拒绝。
   - 外发：默认种类发出去；用例、缺陷、观察条目和 src: 片段不带 `--send` 一个字也到不了假 Jev（假 Jev 记下每个请求体，逐个查）；`--send case` 只放用例；不是 model_readable 的源从不发出；发出记录和真实的请求体对得上。
   - 钩子：按 `docs/hooks.md` 的输入形状喂给它，带 `--send` 回 ask，不带回 `{}`，坏输入回 ask。
   - 复用：同样的输入跑第二次，假 Jev 一个请求也收不到；改一个片段只重问它那一批。
   - 自成一体：把 `tools/jev/` 拷到仓库外的临时目录，在那里跑 `ask` 照样通过；`tools/jev/**/*.ts` 只导入 `node:` 和本目录；`hub/jev/no-judgment-egress.test.ts` 照旧通过（它查 hub/、scripts/、bin/，技能不在那里，也不要动它）。
   - 词表扫描零命中，不加例外：`packs/workflow/case-review/packs.test.ts` 的 handWrittenAxes 在 hub-redesign 上只扫评审几个包，core-fixes 合并后才扫全部包；开工时还没合并，就在本包的测试里用同样的规则扫 `tools/jev/`。
   - SKILL.md：文件头 `name` 是 jev，description 不超过 1,024 字；正文提到的子命令和参数都真的存在。

7. **第二步：`calibrate`。**照 `hub/knowledge/calibration.ts` 和 buildCalibrationSet 复制改写。
   - 参数：`--root <根> --under <路径> [--limit 200] [--dry-run]`。
   - 样例：`--under` 下代码挂好的“定义”“行为”条目，按条目摘要排序取前 limit 个；遮掉路径上的词和条目 `data.words`（照 `maskLiterals`）；在已知路径的每一层提问，条目自己的节点有子节点时那一层期望 none；选项说明不用被抽中的条目，也遮掉。
   - 阈值照 `thresholdOf`（0.95、至少 30 个、z=1.959963984540054）。每次校准存一份样例集 `calibration/placement.choice@<确切版本>/<摘要>.json`（根、起点、种类、样例、所用判断记录的摘要）；阈值按这个链和版本的全部样例集算，同一输入以后来的为准，照 CalibrationStore 的 state。
   - `--dry-run` 只数要问多少题、多少次请求，一题也不问；真实调用花钱，先给所有者看数。

8. **第二步：`place`。**照 `hub/knowledge/placement.ts` 复制改写。
   - 参数：`--root <根> --under <路径> (--pieces <文件> | --from <路径>) [--send …] [--limit N] [--dry-run]`。`--pieces` 是 tree: 条目引用的清单；`--from` 取那棵子树里默认种类（加上这次选择加入的种类）的条目，`--under` 下面的不算。
   - 每层读子节点：选项名照 `optionNames`；说明是子节点第一条“定义”或“行为”条目的第一行（截到 160，不截断字符），跳过用例、缺陷、观察条目——这一点和 Hub 里的旧流程不同，是为了外发；none 放最后；超过 254 个先按字面缩小（`narrowCandidates`）。
   - 本链按这个确切版本校准过、选的是子节点、不并列、p 不低于阈值才往下走；否则停，理由照 placement.ts 的中文；没校准只留候选，不出提议。
   - 输出 `placement.json`（每个片段：引用、提议的路径或没有、停在哪、为什么、p、阈值、版本、判断记录、候选、是否没得到回答）和 `proposals.json`（只放至少往下走了一层的）。
   - 提议的形状照回注包的 `slots.schema.json`：code 是 `placement_proposal`（取自 generated.json）；text 是 `归位提议：放到 <路径>。归类判断：Jev@<确切版本>，p=<两位小数>，只影响位置（阈值 <t>，校准样例 <n> 个）`；data 是 `{root, path, source: {reference, quote}}`，quote 取片段原文的第一行，最多 200 字，逐字（Hub 拿条目陈述还是原件片段来比，以第 10 条验收跑出来的为准，对不上先回报）。概率和版本只写在 text 里：回注包不收模型报的置信分数（data 不许多余字段，README 写明这类字段拒收）。

9. **第二步：`lock` 和 `submit`。**脚本照第 3 条再用 upload_file、start_run、submit_result。
   - `lock --product <产品> --build <构建>`：上传空清单 `{"items":[]}`，开一次 knowledge-contribution 运行，只为锁定根，打印运行号和根（空条目集是合法结果，`hub/runs/engine/start.ts` 的 EMPTY_ITEMS_NOTE）。手上已经有这个构建的根就不用。
   - `submit --proposals <文件> --product <产品> --build <构建> [--skip <条目>=<理由>]`：
     - 上传清单，每条提议一个条目（id 是 `p_<条目摘要前 16 位>`，title 写序号和路径）；提议只引 tree: 条目，`originals` 不用绑；start_run 带 client_key（清单、产品、构建的摘要），重跑拿回同一个运行。
     - 新运行锁定的根和提议里的根不同就停，写明：place 读的是 X，这次锁定的是 Y；下一步用 Y 重跑 place 和 submit。
     - 再上传这批提议用到的判断记录（JSON），把它的 src: 写进 notes。
       - notes 是不核对的字符串，上传也只有上传者和管理员能读，所以 K04 R[5] 的“归类判断记录可查”只对提交者和管理员成立。
       - README 把这一点写成限制。
     - submit_result 的 model 写 `<确切版本>（Circle 技能 jev，knowledge-contribution@<包号>）`，包号取 start_run 回答里运行摘要的 `pack_digest`。
     - 回执的文字原样打出来，结构化回执存 `receipt.json`。整份不受理时，打出回执点名的条目和修正说明，不自己改；下一步写清：重跑 place，或用 `--skip` 把它们标成跳过、写明理由后再交。

10. **第二步的测试。**
    - 归位：每种停法各一例（none、并列、低于阈值、没校准、超过 254 个缩小后仍太多）；往下走两层的一例；子节点名不能当选项名的一例；子节点的第一条是用例条目时，说明取后面的“定义”或“行为”条目，那条用例的文字到不了假 Jev。
    - 校准：同一组样例，脚本的阈值等于 `hub/knowledge/api.ts` 的 thresholdOf；遮字等于 maskLiterals；不到 30 个就是没校准；`--dry-run` 不发请求。
    - 提议用回注包的 `slots.schema.json` 校验；text 里的版本和 p 与判断记录一致。
    - 验收（`tests/acceptance/` 新增一个文件，编号接在现有的后面）：真 Hub（`hub/server/testing-real.ts` 的 createTestHub、`mcpUrl`，验收床 `tests/acceptance/support/hub.ts` 的合成产品），假 Jev 本机回环；脚本作子进程跑 lock、calibrate、place、submit，标准输入照第 2 条。断言：提议进了回注层，code 是 placement_proposal，text 带 `Jev@<scripted 版本>` 和 p；改坏一条提议的路径，回执点名它并给修正说明；假 Jev 只收到脚本的请求，里面没有 Hub 令牌，也没有用例或缺陷文字；Hub 的调用记录里找不到 Jev 的密钥。

11. **文档。**
    - `tools/jev/SKILL.md`（中文，短）：Jev 是什么（只判断，不写字）；什么时候用；什么时候别用（写内容、抽字段、计数、挑设备命令、定期望值、把概率当事实）；所有者先存什么；命令怎么写；默认发什么、怎么选择加入；归位提议四步（lock 或已有的根、calibrate、place、submit）；校准和归位可能跑几分钟，用后台任务，重跑会复用已有回答；结果怎么读；失败时的下一步。分类、“两段是不是说同一件事”用 ask，交回注时照回注包的 SKILL.md，陈述里写 Jev@版本和 p；排序用每项一道打分题，按期望等级排，只作这次任务的产出，不回注。
    - 回注包的 `SKILL.md` 加一句：归位提议可以用 Circle 的 jev 技能做，Hub 只核路径和引文，不看概率。`README.md` 加一节：技能在哪、怎么装和核对、外发规则、和 Hub 里旧形状的关系（`hub/jev`、`placement.ts`、`calibration.ts` 只剩测试用，两份逻辑靠第 6、10 条的对照测试保持一致）。
    - `contracts/model.json` 不改：K04 里的“bot”和 R[6]“尚未实现”由集成者改。

真实 Jev 的第一次调用（合成内容）、装进所有者的 Circle、对持久部署的归位提议，都由集成者在所有者存好密钥以后做。

完成后在终端里回报：提交号、测试数量、没做完或拿不准的地方。
