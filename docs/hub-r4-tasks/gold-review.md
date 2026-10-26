# 任务：用例评审的注入缺陷度量补两类缺陷、能重复跑，并给 Hub 的字面检查在未注入用例上计分

依据：

- 架构 6b 的评审一条（`docs/hub-r4-architecture.md` 133 行）：Hub 自己的机械检查要标出它看得见的全部注入缺陷，没改过的部分不多标；模型的发现在注入缺陷上算召回，在其余部分算精确率。
- 已做的两轮（`docs/hub-r4-progress.md` 39、86 行）都只跑了一次，而且都在引擎改动受理提交的检查（182 行，f5b0ddb）之前。终审（196 行）记下的缺口有三处：没有手册、规格冲突的金标准；含糊期望不是 Hub 的检查（`packs/workflow/case-review/tables/structure.json` 4 行只要求期望结果不为空）；未注入用例上只数模型的发现（`scripts/real/lib/score.ts` 117 行），Hub 的字面检查没有计分。

这一件只写 `scripts/real/` 下集成者跑的脚本和合成测试，不改任何包。真实文档的副本、标准答案、手册片段和运行结果都放在仓库外。

- 分支和工作树：`gold-review`，目录 `circle-hub-gold-review`（依赖已装好）
- 可以改的路径：`scripts/real/lib/inject.ts`、`scripts/real/lib/score.ts`、`scripts/real/inject-defects.ts`、`scripts/real/score-injection.ts` 和它们的测试；新文件 `scripts/real/gold/literal.ts`、`scripts/real/measure-review.ts` 和它们的测试。`scripts/real/gold/cases.ts`、`scripts/real/review-circle.ts` 只导入，不改。别的路径不动，包和核心缺什么先回报。
- 规则：同前（不推送、不建 PR、不发布、不部署；不碰 7420、钥匙串、环境配置文件和任何真实系统；测试只用合成数据；`git commit -s`）。真实客户端、`bin/circle-hub` 和真实模型都不跑，驱动只在测试里用假的会话跑通。
- 验证：`npx tsc --noEmit`；`node --test --test-concurrency=1 "scripts/real/lib/*.test.ts" "scripts/real/gold/*.test.ts" "scripts/real/*.test.ts"`。

## 要做的

1. **两类新注入**（`scripts/real/lib/inject.ts` 16–22 行的 `Operation`）。期望结果照 `gold/cases.ts` 的读法取：用例下面的叶子，优先级 3 的前置条件不算。目标必须是 `gold/cases.ts` 的 `caseNodesOf` 按运行的用例规则认出的用例（`inject-defects.ts` 加 `--case-rule`，默认 `marked`）。这两类 Hub 都没有检查，所以 `seen_by` 不是 `judgment` 就拒绝。
   - `contradict_manual { node, from, to, quote }`：在用例第一条含 `from` 的期望结果里，把 `from` 换成 `to`，让这条期望和手册（或规格）片段写的取值范围或缺省值矛盾。`inject-defects.ts` 加 `--manual <片段文件>`。下面几种情况都拒绝：计划里有这一类却没给片段；`quote` 不是逐字（只忽略空白）出自片段；`to` 出现在 `quote` 里；没有一条期望结果含 `from`。标准答案记 `from`、`to`、`quote` 和片段的 sha256。
   - `vague_expected { node, text }`：用例的每条期望结果都换成同一句 `text`。拒绝的情况：`text` 按 `foldKey` 比不在 `gold/cases.ts` 的 `VAGUE_EXPECTED` 里；用例没有期望结果，或者已经全是含糊的。注入后用 `caseGold` 重算，只能有这一个用例从不含糊变成含糊。
   - 每条标准答案加 `kind`（就是 `op.kind`），按类计数靠它。计分遇到没有 `kind` 的旧标准答案就拒绝，并提示要重新注入。注入种类只是脚本自己的参数名，不进 Hub 的记录；如果觉得它该进词表，回报给集成者，由集成者在模型里加轴。

2. **字面检查的独立答案**：新文件 `scripts/real/gold/literal.ts`。它读评审用的那份副本原件，照 `structure.json` 4 行的说法自己算出每个用例该被标的码：
   - 标题为空，优先级缺失，没有标签或有空标签，没有期望结果或有空的期望结果：`core.structure.required_empty`；
   - 优先级不是 1 到 3 的整数：`core.structure.type_mismatch`；
   - 同一路径下标题、步骤、期望结果和前置条件全都相同（按 NFKC 比，不分大小写，空白合并）：每一份都标 `core.structure.duplicate_key`。只是标题相同不算。

   按标记认出的用例没有标签，也要算缺标签（`packs/workflow/case-review/README.md` 113–114 行）。码名取自 `contracts/codes.json` 4–7 行，测试读这个文件核对码名。读脑图、认用例用 `gold/cases.ts` 的 `parseMindMap` 和 `caseNodesOf`。它本身就是独立答案，不导入 `hub/`、`packs/` 的任何东西，所以用它不会让核对变成循环。`literal.ts` 自己也不导入这两处，测试读它的源码核对 import。`parseMindMap` 会滤掉空标签、把不是整数的优先级记成 null（`gold/cases.ts` 47–48 行），所以空标签和优先级的写法回到原始 JSON 的 `data.resource`、`data.priority` 判，照 `parseMindMap` 的次序走一遍对上节点。没有唯一 `data.id` 的用例单独计数，不计分：`literal` 里另有 `node_ids` 检查（`tables/structure-node-ids.json`），编号缺失或重复时也出 `core.structure.required_empty`、`duplicate_key`。

3. **计分**（`lib/score.ts`）：
   - 模型的发现只数 `qualifier.nature` 是 `judgment` 的主张。现在 59–61 行把 `findings` 要求项里所有带码的主张都算进去，Hub 自己检查出的反驳也会被当成模型的发现。
   - Hub 的标记改为读 `literal`、`catalog` 两个要求项里判定为 `refute` 的事实主张，每一处反驳都在里面（`hub/runs/engine/evaluate.ts` 663–679 行）。不要只看静态层那一个码，`hub/runs/engine/terminals.ts` 130–131 行只留了首要的那个。只数静态层带归责的要求项：反向用例上预期的反驳不带归责（同一文件 289–296 行），不算标记。也只数 `qualifier.source_role` 是 `subject` 的反驳：`command_claims` 核的是模型说命令有没有（`packs/workflow/case-review/checks.json` 45–52 行，judges 是 `artifact_under_verification`），它的反驳不是 Hub 在文档上的标记。
   - 未注入的用例上，Hub 的标记和模型的发现分开列：
     - `core.structure.*` 按（用例，码）和第 2 条的独立答案比，分成三种：支持；误报，即 Hub 标了、独立答案没有；漏标。
     - 别的码（`case-review.tag_variant`、`core.catalog.*`）没有独立答案，只数总数，和其中未改动评审里没有的个数。
     - `literal` 静态层既不是 `pass` 也不是 `violation` 的条目（例如声明跳过的）单独计数，不计分。
   - 复核：`score` 再收一个可选的复核结果。用例上有 `new_finding`，算复核的发现；有 `verified` 或 `partial`，算初评的发现被证实（`packs/workflow/case-review-verify/README.md` 17 行）。“合起来”指被证实的初评发现加上复核的发现，只被推翻的不算。删掉的反向组照现在的办法判，复核里 `data.probe` 是 `negative_gap` 或 `coverage_gap` 的 `new_finding` 也算查出。
   - 新加 `aggregate`，按 `kind` 合计几次运行。每类给出“注入几处 × 有效几次”，以及 Hub 字面检查、初评、复核、合起来各查出几处；另外给出 `core.structure.*` 的标记各次是否相同。
   - 屏幕上只打计数，节点编号、标签和码的逐条明细写进文件。`score-injection.ts` 跟着改，多收 `--verify`、`--copy`（用来算第 2 条）和 `--details <文件>`。

4. **能重复跑的驱动**：新文件 `scripts/real/measure-review.ts`，参数如下：
   `--source <脑图 json> --plan <计划 json> [--keep <n>] [--manual <片段>] [--case-rule marked|tagged] --draft <会话 json> [--verify <会话 json>] [--repeat 3] [--baseline <基线的 --out>] --out <目录>`
   会话 JSON 是 `{ "args": [review-circle.ts 的端点和连接参数], "prompt": "<模板>" }`。模板里的 `{copy}` 换成副本路径；复核模板里的 `{draft_run}` 换成这一次的初评运行，`{draft_record}` 换成这一次已受理提交的**验证结果记录**根引用 `rec:<64 位十六进制摘要>`，不带 `#` 指针，也不是提交原件的记录引用。它取自判定“初评有效”时同一份 `run show --json` 快照的 `latest.record`，只接受 `latest.result.acceptance` 为 `accepted` 的结果，不另取一次最新状态、也不猜摘要。复核模板使用 `{draft_record}` 却取不到合法记录引用时，本次初评按固定原因“取不到运行”记无效，不开复核；初评未受理仍记“没有受理”。模板没用这个占位符时沿用原来的判定和开会话行为。记录引用只进入私有复核输入与 `--out` 证据，不增加屏幕输出行或打印该记录摘要。
   - 先照 `inject-defects.ts` 写出副本和标准答案，再算第 2 条。`--out` 在仓库里面，或者副本超过 100 个用例（一次运行的上限，`packs/workflow/case-review/SKILL.md` 9 行），都拒绝。
   - 每一次：
     1. 用子进程跑 `review-circle.ts`，开一个新的初评会话。端点和密钥还是只由它读。
     2. 用它导出的 `parseCallLog` 读它写的 `calls.jsonl`，找出有受理提交的运行，正好一个才算数。
     3. 用 `node bin/circle-hub run show <运行> --json` 取出结果，存进这一次的目录。
     4. 给了 `--verify`，就再开一个复核会话，照同样的步骤处理。
   - 一次运行有效，初评要同时满足：`run.pack` 是 `case-review@…`；最新结果已受理；`subject` 绑定的 `src:` 摘要等于副本字节的 sha256（`contracts/src/reference.ts` 36 行）；条目数等于独立答案的用例数。给了复核时，复核也要满足：包是 `case-review-verify@…`；已受理；`predecessor` 是这一次的初评。无效的照实计数，不计分。
   - 每次的计分写进 `<out>/r<n>/score.json`，最后打汇总。`--baseline` 是先前一次空计划运行的 `--out`，用它各次的初评结果标出“未改动评审里也有”。
   - 退出码为 0 要同时满足三条：每次都有效；Hub 看得见的注入缺陷每次都查出；未注入用例上 `core.structure.*` 既没有误报也没有漏标。模型的召回只报告，不影响退出码。`--repeat` 小于 3 时，汇总里写明“不构成统计”。

5. **合成测试**：脑图、手册片段和运行结果都是编出来的；用得到版本线就用 10.6 以后的，地址用 192.0.2.0/24。
   - 注入：两类注入只改该改的节点，源文件不变；上面列的每种拒绝各有一个反例；每条标准答案都有 `kind`。
   - 独立答案：
     - 五种字面问题各有正例和反例，含空标签和写成小数、字符串的优先级；
     - 重复的判法：大小写、全半角、空白不同仍算重复，路径或步骤不同不算；
     - 标记用例缺标签；`tagged` 规则下标记用例不是用例；
     - 没有唯一编号的用例单列；
     - 源码不导入 `hub/`、`packs/`。
   - 计分：
     - `findings` 要求项里 Hub 的反驳不算模型的发现；
     - `command_claims` 对模型陈述的反驳不算 Hub 的标记；
     - 一个用例有两处反驳，两个码都在；预期的反驳不算；
     - 支持、误报、漏标各一例；
     - 复核的新增、证实、只被推翻各一例；
     - 三次合计里有一次无效；各次 `core.structure.*` 标记不同时要标出来；
     - 屏幕输出里没有合成文档的节点编号、标题和文字。
   - 驱动：用假的会话和假的 `run show` 跑三次。要覆盖：都有效；一次没有受理；摘要不是副本的；复核的前驱不对；`--out` 在仓库里被拒；退出码 0 和 1 各一例。

6. **集成者之后跑的**（终端不跑）：先跑一次空计划（`[]`）的基线，再跑三次度量。
   ```
   HUB_REAL_TOKEN=… node scripts/real/measure-review.ts --source <原件> --plan <空计划> --keep <n> --draft <会话> --repeat 1 --out <基线目录>
   HUB_REAL_TOKEN=… node scripts/real/measure-review.ts --source <原件> --plan <计划> --keep <n> --manual <片段> --draft <会话> --verify <会话> --repeat 3 --baseline <基线目录> --out <目录>
   ```
   屏幕上只能出现下面这几种行。节点编号、标题、命令、运行编号、构建名和用例文字一律不上屏幕，只写进 `--out` 的文件：
   ```
   副本 sha256 <…>；标准答案 sha256 <…>；片段 sha256 <…>；用例 <数> 个，注入 <数> 处；重复 <数> 次，有效 <数> 次
   第 <n> 次：初评 case-review@<版本> 有效|无效（<原因>）；复核 case-review-verify@<版本> 有效|无效（<原因>）
   <类别>：注入 <数>×<次>；Hub 字面检查 <数>；初评 <数>；复核 <数>；合起来 <数>
   未注入的用例 <数> 个：Hub 标记支持 <数>、误报 <数>、漏标 <数>；未独立核对 <数>（未改动评审里没有的 <数>）；各次相同 是|否；不计分 <数>
   未注入的用例上模型的发现：初评 <数> 个用例（未改动评审里没有的 <数>），复核新增 <数> 个用例
   通过：Hub 看得见的注入缺陷全部查出 是|否；未注入用例上没有误报和漏标 是|否；每次都有效 是|否
   ```
   原因只用固定的几句：没有受理、不止一个运行、评审对象不是副本、条目数不对、任务包不对、前驱不对。类别用 `kind`，配上固定的中文说明。

完成后在终端里回报：提交号、测试数量、第 2 条照表的说法实现时对不上或拿不准的地方（尤其是重复用例的内容怎么比）、别的没做完的地方。

## 集成者对待定问题的答复（2026-10-23）

1. 架构 6b 的“没改过的部分不多标”按页面的读法：未注入用例上 Hub 的标记要和独立答案一致，多标的算误报，少标的算漏标。
2. 含糊期望先不做成评审包的 Hub 检查：含糊词表现在在产品包里，而且是作者自拟、待所有者定。这一件里 `vague_expected` 只算模型看得见的。以后由产品包把词表作为目录提供给工作流包，记为待办。
3. 期望和手册、规格冲突的 Hub 检查，要先在知识树里有结构化的取值域（模型的事），这一件只做模型看得见的那一半。
4. （2026-10-23 更正）未注入用例上目录类标记（`core.catalog.*`）的独立答案，`gold-case-commands` 给不了：它只给用例的命令路径，不给命令行和参数。这一件里这类标记照实按条数报，记为“还没有独立答案”；另开一件，照 `scripts/real/gold/command-diff.ts` 的办法自己解析命令树，核对模型引用的那些命令行，由集成者排期。
5. 模型在未注入用例上的发现准不准，由所有者抽看；驱动把逐条明细写到仓库外，集成者把抽看的结论记进进度页。
6. 三次度量都在决定 7 的授权里：初评用千问，复核用 GLM，GLM 的密钥照现在的读法（待定第 11 项）。
7. 文档由集成者挑：要有一条用例的命令在手册里写了取值范围或缺省值，并且避开嵌套结构，免得两边数法不同。
