# case-compile：用例编译

工作流包 `case-compile` 把一整份测试脑图（敏捷平台的 KityMinder 文档）里的原始用例编译成自动化用例 Excel 工作簿，在自动化测试环境上机验证，失败的返工，最后交付一份全部通过的工作簿和逐条报告。模型编写，客户端的工具生成文件，Hub 只核对并重算，不生成内容、不调用模型；核对通过不证明在真实设备上跑得通。产品的命令、手册和设备输出都来自运行绑定的产品包、命令树和测试环境，包里不写。

## 流程

每条原始用例独立推进，关口都由 `tools/pipeline.ts` 跑，子代理由编写循环 `workflows/compile-loop.js` 派发：

1. 开运行：`tools/open-compile.ts` 先由代码判定技能版本、Plumb、命名文档、test-bed 预订和脑图是否就绪，再开用例重组运行（子包 `recompose`）和脚本编写运行，写 `open-compile.json`。
2. 用例重组：每条原始用例由 `compile-recomposer` 写成重组后的用例，离线自检（`recompose/tools/check-record.ts`）后单条提交，受理后即可编写。
3. 脚本编写：`compile-writer` 按任务文件、同构建手册和命令树写计划；计划自检（`tools/check-plan.ts`）、命令核验（`tools/cmd-verify-plumb.ts`）和场景保真审计（`tools/fidelity-plumb.ts`，判不了的交 `compile-fidelity` 盲审）都过了才算就绪。
4. 脚本合并：`pipeline.ts collect` 收拢就绪的计划，`tools/open-merge.ts` 交计划、生成并上传工作簿、开脚本合并运行并提交。
5. 上机验证：Hub 核对工作簿后派发到测试环境；`tools/download-returns.ts` 等待并下载设备输出。
6. 失败分析与返工：`compile-attributor` 只读分析失败原因，`pipeline.ts rework` 新开运行、结转通过的计划（`tools/carry-plans.ts`）、重派没过的；每条最多 3 轮。交给重派的编写的上一轮计划（`rework-<n>/prior-plans/`）把展开了的长名字写回定长占位，让同一个名字是同一个占位、长度不同的名字是另一个占位（名字夹在更长的串里时，也按文本里别处找到的固定部分写，如 `x1.` 加占位）；`source-plans`、结转和就绪的副本仍逐字节不变。
7. 交付：`tools/assemble-delivery.ts` 组交付目录（工作簿、`delivery_report.md`、`delivery.json`）并写最后的回复。

开运行的就绪判定把没满足的条件一次说全，写在同一行 `无法编译：…` 里，用“；另：”隔开，什么都不开；只有一个问题时就是它自己的那一句。顺序是：工作流没分配、没装或版本不是 Hub 发布的（先 `recompose`，后 `case-compile`），然后（判断方式是 Plumb 时）没装 `plumb` 技能、第二行标准输入没有 Plumb 密钥、Plumb 没就绪。某一项要靠前一项才查得了（工作流没分配就没有版本可比，没有 `plumb` 技能或密钥就问不了 Plumb），就不单独算一个问题。Hub 不可达或读不到工作流列表，以及参数不对，仍单独说。技能没装时的下一步写明用客户端的技能安装从 Hub 装上；Hub 上没有 `plumb` 技能时由管理员先在 Hub 上安装。

每个工具答复的 `message` 写着下一步（由 `functions/next-step.ts` 统一给出）。给模型的说明在 `SKILL.md`，上机验证、失败分析和交付在 `tools/delivery.md`，保真审计在 `tools/fidelity.md`，计划字段一览在 `tools/plan-fields.md`。

### 判断方式（所有者 2026-11-22）

命令核验和场景保真审计默认由 Plumb 判断。使用者明确说这次不经 Plumb 时，`open-compile.ts --judge model` 把这个选择写进 `open-compile.json`，流水线照它办：

- 开运行不查 Plumb 状态，不要 Plumb 地址和密钥，也不要求本机装有 `plumb` 技能。
- model 方式下客户端可以不设 Plumb 地址和密钥：编写循环开头先问一次 `pipeline.ts judge --state …`（读状态文件，不要服务，也不读标准输入），答 `model` 时之后的命令不带 `--plumb %PLUMB_URL%`，只写 `--hub`；答 `plumb` 时命令与以前相同。标准输入仍是两行：`pipeline.cli.json` 给 `resume`、`next`、`rework`、`reopen` 各声明了两行，守卫按声明核对行数，所以第二行 `%PLUMB_API_KEY%` 省不掉；客户端不认识这个名字时它原样留在命令里，工具在 model 方式下不读它。
- 命令核验只做命令树的程序核对（`cmd-verify-plumb.ts --tree-only`）：不通过的挡住，通过的放行，没有结论的步骤状态未知，写进这条用例的复核说明，不冒充判断过。
- 场景保真审计直接出简报（`fidelity-brief.ts`），由 `compile-fidelity` 盲审，判断并入计划的做法不变；Hub 只核对格式和简报摘要，这一点两种方式相同。
- 每条用例的复核说明第一行写明这次的判断方式，`pipeline.ts collect` 的 `reviewed` 带出来，最后报告照录。

限制：model 方式没有 Plumb 的命令语义判断，命令树核对不了的步骤没有任何判断；盲审和编写用的是同一类通用模型，独立性比 Plumb 弱。两种方式的模型判断都是未确认，由上机验证的设备输出裁定。Plumb 没就绪不是改用 model 的理由，由使用者决定。

## 输入、参数与核对

`workflow.json` 的输入：

| 槽位 | 内容 |
| --- | --- |
| `subject` | 评审过的脑图（`agile:mindmap` 或上传的 KityMinder JSON）；取用例的规则与 case-review 相同 |
| `contract` | 运行器原格式的函数合约命名文档，按原文重算身份，不转换格式 |
| `inventory` | 测试环境清单命名文档（`test-bed-manifest@1`，与 test-bed 包同一份） |
| `profile` | 发布的 `runtime-profile@1` 命名文档：工作簿格式、座位和主机映射、本轮允许的组合及参数角色、设备和主机拒绝表 |
| `workbook`、`plan_result` | 合并时绑定的工作簿和已满足的计划运行 |
| `recomposition_run`、`recomposition_result` | 重组运行的记录；按运行号绑定、每次核对时取它最近一次受理的结果（`functions/refresh.ts` 逐条刷新） |
| `case_index`、`criteria_review`、`criteria_review_run` | 可选：用例身份声明；类型化判据的独立复核 |

参数：`case_rule`、`autoid`（只编译一条）、`exclude`、`scope`（按范围编译，开运行时冻结）、`plan_run`、`pipeline`。一次运行至多 `policies/dispatch.json` 的 `max_items` 条用例，工作簿的行数和大小上限在 `tables/workbook-format.json`；超出时整份拒绝并说明怎么拆。

`requirements.json` 的要求项与 `checks.json` 的检查：

| 要求项 | 检查 |
| --- | --- |
| `plan` 执行计划 | 槽位形状（`slots.schema.json`） |
| `contract_methods` 步骤调用符合合约 | `contract_shape` |
| `bed_addresses` 字面地址对得上测试环境 | `bed_addresses` |
| `commands_known` 命令在目标构建的命令目录里 | `commands_catalog` |
| `expected_grounded` 期望结果有逐字来源 | `expected_sources`、`expected_quotes`（核心解释器 `quote@1`） |
| `scenario_kept` 作者场景保住 | `author_step_coverage`、`scenario_fidelity` |
| `workbook_verified` 工作簿原字节核验 | `workbook_verified`、`commands_catalog`、`expected_quotes`、`dispatch_policy` |

检查函数在 `functions/`（入口 `checks.ts`、`subject.ts`、`project.ts`），计划有两种写法：顺序步骤（`steps`/`expects`）和分块计划（`blocks`，块种类在 `tables/blocks-format.json`，`tables/block-plan.schema.json` 与 `slots.schema.json` 由 `testing/gen-block-schema.ts` 从它生成），同一份工作簿里两种可以并存。作者没写字面的期望由模型写检查点，记为模型的判断、未经确认，由上机验证裁定。

## 工具

都在 `tools/`，每个可执行工具旁有同名 `.cli.json` 声明它的选项和标准输入；需要令牌的从标准输入读，不落盘。

| 工具 | 做什么 |
| --- | --- |
| `open-compile.ts` | 就绪判定，开重组运行和脚本编写运行 |
| `download-run.ts` | 整份下载一次运行：条目、编写简报、来源、锁定知识树的文本文件、后绑定的 `late.json` |
| `pipeline.ts` | 逐条流水线的状态（`pipeline.json`）：`init`、`resume`、`next`、`status`、`collect`、`retry`、`rework`、`judge`（编写循环开头问这次由谁判断，不要服务和标准输入） |
| `task-brief.ts` | 为四个子代理角色写任务文件，输出短派发提示 |
| `check-brief.ts` | 核对结构化编写简报 |
| `cmd-lookup.ts` | 查命令写法（`--param`、`--heads`）、对象和方法（`--method`、`--methods`）、块种类（`--block`） |
| `check-plan.ts` | 用冻结的运行离线跑 Hub 对计划的边界和检查；固定部分相同、长度不同的定长名字作为 `advice` 说出来，不影响 `ok` |
| `cmd-select-plumb.ts`、`cmd-verify-plumb.ts` | 命令候选和命令核验；以命令树为准，Plumb 只作提示。`cmd-verify-plumb.ts --tree-only` 不问 Plumb，只做命令树核对 |
| `command-domain-precheck.ts` | 只披露计划里的配置命令落在运行器哪条清理规则下、可用哪条只读命令查看，不判断设备状态 |
| `fidelity-brief.ts`、`fidelity-plumb.ts`、`fidelity-apply.ts` | 场景保真审计：算简报、交 Plumb 判断、把判断并入计划 |
| `submit-plans.ts` | 展开定长占位后把计划交给 Hub |
| `carry-plans.ts` | 返工时把通过的计划连同保真判断结转到新运行 |
| `fetch-run.ts`、`generate-workbook.ts` | 取一次运行的已受理结果和绑定原件，离线生成工作簿 |
| `open-merge.ts` | 交计划、生成上传工作簿、开合并运行并提交 |
| `download-returns.ts` | 等待并下载设备输出，写 `index.json`；`syntax_rejected`、`execution_refused` 每条里达 64 字符的长名字另列 `names`（长度取自设备输出）。`execution_refused` 只用这个脚本编写运行自己的执行器规则里声明的失败标记和设备会话，与生成工作簿的工具版本无关：这个运行是别的版本写的、重读不了它的通过结论时，照样列被设备拒绝的命令，`pass_review.unread` 写明没重读什么、为什么 |
| `device-read.ts` | 经 test-bed 在预订的设备上读一条只读命令 |
| `refresh-late.ts` | 刷新开运行后才受理的重组记录 |
| `assemble-delivery.ts` | 组交付目录和最后的回复 |
| `normalize-mindmap.ts` | 本地导出的脑图去掉导出头和外层数组，不改内容 |
| `seal-recompose.ts` | 把重组提交无损拼成一份待交的整批（不代表 Hub 受理） |

`authoring-brief.ts`、`rework-inputs.ts`、`workspace-path.ts` 是这些工具共用的模块。`tools/case-writers/` 是一个 Circle 扩展，由操作者装进 Circle 主目录的 `extensions/`。

## 子代理角色

`agents/compile-recomposer.md`、`compile-writer.md`、`compile-fidelity.md`、`compile-attributor.md` 由 `functions/subagent-roles.ts` 的 `renderAgentDefinition` 生成，改角色只改这个源文件再重新生成；`pack.test.ts` 核对两者一致。结论、原因和决定者的说法取自生成词表（`functions/generated/vocabulary.ts`，`labelOf`）。

## 子包

每个子目录是一个单独发布的包，共享规则来自本包的 `tables/` 和 `functions/`，由 `testing/gen-recompose.ts` 生成副本，`testing/stage-recompose.ts` 单独 stage：

| 目录 | 包 | 做什么 |
| --- | --- | --- |
| `recompose/` | `recompose` | 用例重组，见 `recompose/README.md` |
| `authority/` | `recompose-authority` | 产品声明的重组来源凭证 |
| `adjudicate/` | `recompose-adjudication` | 对每条用例原句的独立裁定 |
| `review/` | `case-compile-criterion-review` | 由非作者账号复核类型化判据 |

## 内嵌技能

`pack.json` 的 `embeds` 声明本包内嵌的技能模块，副本在 `functions/generated/skills/<技能>/<模块>/`，由 `npm run gen:contracts` 从 `packs/skill/` 生成，不手改；Hub 拒收与发布的技能不一致的副本。

| 技能 | 模块 | 用途 |
| --- | --- | --- |
| `mindmap-format` | `case-structure` | 脑图的结构读取 |
| `run-tools` | `hub-client` | 工具调用 Hub |
| `runner-workbook` | `workbook-writer` | 工作簿模板、G 列写法、XLSX 读写 |
| `command-tools` | `command-check` | 命令树语法、命令策略、取值范围 |
| `plumb` | `plumb-client` | Plumb 网关客户端 |

## 包外的需要（Needs）

- 包函数不能跨包导入，所以清单解析（`functions/manifest.ts`）是 test-bed 包同一格式的精简副本；有共享模块后可去掉副本。
- `expected_sources` 要比较地址替换后的临时文字，它不是绑定来源，不能交给核心的 `quote@1`，所以 `functions/quote.ts` 在沙箱里独立执行同一条引文规则；`functions/quote-width.ts` 的 Unicode East_Asian_Width W/F 数据取自 Unicode 17.0.0 的 `EastAsianWidth.txt`（地址、摘要和许可写在文件头）。`functions/quote.test.ts` 和 `functions/quote-sources.test.ts` 直接读 `hub/rules/quote-vectors.json` 并与核心的 `quoteMatches` 逐对比较，核心改规则时先红。
- `tables/runtime-contract-format.json` 里的合约和认证格式名是运行器一侧发布的标识，照原样核对；改名要和运行器一侧一起改。

## 发布

`pack.json` 是 `pack-files.ts` 列出的已发布文件的清单；README、测试和 `testing/` 不发布。

```sh
node packs/workflow/case-compile/pack-files.ts --check            # pack.json 是否过期
node packs/workflow/case-compile/pack-files.ts --write            # 改动后重写 pack.json
node packs/workflow/case-compile/pack-files.ts --stage <空目录>    # 复制出待发布的包
```

## 测试

```sh
node --test "packs/workflow/case-compile/**/*.test.ts"
node --test packs/workflow/case-review/packs.test.ts
npx tsc --noEmit -p .
```

测试只用合成数据：合成的合约、环境配置、测试环境清单（192.0.2.0/24）和命令树（`widget …`、`demo …`），脚本化的模型和临时 PostgreSQL。`hub-parity.test.ts`、`publish.test.ts` 和 `production.test.ts` 用真实的运行引擎、注册表和沙箱；没有系统网络隔离的机器上沙箱测试会跳过，跳过不算通过。
