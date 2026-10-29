# defect-to-case: 缺陷转用例任务包

工作流任务包 `defect-to-case`（能力 5：缺陷转用例）：模型从缺陷记录（现象与修复说明）起草回归测试用例，Hub 负责机械核对用例结构、命令与参数合法性、期望结果引文依据、以及与锁定构建已索引用例的重复判定。

## 任务包结构与文件

| 文件 | 内容与职责 |
| --- | --- |
| `workflow.json` | 声明输入插槽：`defects`（主体角色，必填，多项，绑定 `plm:bug`）、`indexed_cases`（期望角色，必填，绑定不带 `only` 的完整命令索引）及 `manual`（期望角色，可选，绑定 `manual:cli:<版本线>`）；Hub 从解析出的命令身份计算读取键并在同一修订重绑索引；参数 `max_cases`（默认 6）与 `priority`（默认 2）；绑定命令目录 `commands@1` |
| `requirements.json` | 声明六项条目级要求：`cases`（用例起草）、`shape`（用例结构）、`commands`（命令与参数）、`grounded`（期望结果依据）、`not_duplicate`（用例去重）和 `fixed_status`（原始结构的已修复状态） |
| `checks.json` | 声明九项检查：结构、命令目录、预期反驳、逐字引文、来源范围、期望文字、结构去重、完整签名成员关系和原始已修复状态 |
| `slots.schema.json` | 声明条目插槽 `cases`：包含起草用例的结构模式（标题、优先级、正反向、预期反驳、前置条件、步骤与命令行、期望结果与逐字引文、标签） |
| `SKILL.md` | 中文起草指引（< 8000 字符）：任务目标、证据读取顺序、用例起草结构、边界校验与修复规则、提交格式 |
| `functions/` | 投影函数 `projection.ts`、不再自动绑定手册的期望来源函数 `expected.ts`、被判对象构建器 `subjects.ts`、纯检查函数 `checks.ts` 及类型定义 `types.ts` |
| `tables/` | 检查表定义：`commands.json`（`catalog@1` 解释器表）与 `quotes.json`（`quote@1` 解释器表） |
| `samples/` | 18 个样例（`pack-sample@1`，positive 与 negative 各 9 个），覆盖九项检查 |
| `examples/` | 合成示例：`start-run.json`、`submission.json` 与 `submit-result.json` |
| `pack.json` | 任务包清单（`defect-to-case@1.6.20`，由 pack-files.ts 签名，包含所有包内文件的相对路径、SHA-256 与文件大小） |

非任务包发布文件：`api.ts`（外部包与工具接口）、`pack-files.ts`（打包与签名工具）、`README.md`、测试文件（`*.test.ts`）与测试辅助目录（`testing/`）。

## 版本说明

- **1.6.6**：重复主张的计数身份是条目 `item`、要求项 `not_duplicate`、代码 `defect-to-case.duplicate_case` 和 `data.duplicate_of.reference`，规则版本 `defect-to-case.duplicate_claim_identity@1`。主张 statement 的措辞不参与计数。是否判重仍是既有的命令头集合、正反向和规范化标题；命令路径、参数和期望引文身份的结构键尚未接入。
- **1.6.0**：期望文字必须是其引文的非空逐字片段，只折叠空白；改写为阻断违规 `defect-to-case.expect_not_in_quote`，计入最多两轮修复。引文来源受配置修复字段和可选同版本线手册限制；样例采用 PLM 真实字段结构；公开标题规范化规则，查重要求项只承诺实际执行的标题比较。
- **1.5.3**：逐份草稿报告；已见重复照样驳回。仅将依赖不全覆盖的“没有重复”记为带补取出口的未知，保留跳过文档的数量。
- **1.5.2**：视图未截断、未跳过时，没返回的请求键确定没有用例。
- **1.5.1**（原实现有误，已由 1.5.2/1.5.3 修正）：曾将省略空键和可见重复一起记未知。收窄索引缺少请求键或源视图截断时，查重记未知并列出重读要求；缺失键和明确的空键列表是两种情况。
- **1.5.0**：
  - 紧凑索引逐字段优先读取视图的 `only` 和 `cut_keys`，与绑定 URI 或条目数量冲突时以字段为准，空数组同样有效。仅缺失字段沿用旧视图的 URI / 每键 2000 条上限推断，并在 `notes` 写明“按 URI 和上限推断”；存在但形状无效的字段不回退，也不证明完整。
  - `cut_keys: []` 不再把恰好 2000 条误判为截断；明确截断的键即使少于 2000 条，未见重复仍记未知，已见重复仍驳回。
- **1.4.0**：
  - 查重的命令比较改为按命令头：草稿每条命令行先按锁定构建的命令目录解析出命令头（词序列里最长的、在目录里存在的前缀），收窄范围判定和按命令集合分桶都按命令头集合算。此前拿整条命令行（带参数）去和索引的命令路径键比，两边永远对不上，收窄判定把每条草稿都记未知、分桶也永远落空。
  - `checks.json` 的 `duplicate_check` 声明 `catalog: "commands@1"`，检查函数照 `hub/rules/check.ts` 的 `catalogEntries` 写法拿到目录条目。解析不出命令头的行，命令检查本来就会驳回；查重把这条草稿记未知并写明原因。
  - 不收窄时，草稿用的命令头在索引里没有任何条目就能断定不重复；收窄时命令头不在 `only` 里照旧记未知。
  - `SKILL.md` 写准：每个期望结果的 quote 必须照抄进本条用例主张顶层的 `quotes`；只写在期望结果数据里的引文会被记成「没有绑定到本次运行」的未知（核心缺口，另有任务修）。
- **1.3.0**：
  - 查重绑定收窄到草稿要用的命令：`indexed_cases` 的 URI 带 `only=<命令路径>` 与 `fields=commands,document,node,title,negative,case_structure`；草稿的命令集合与 `only` 相交才判得出来，不相交记未知。去掉 `expected.ts` 自动绑定的不带 `fields` 的同一索引。紧凑索引按条目的 `commands` 字段算命令集合。
  - 修正 README 中“裁剪后 2 至 3 MiB”的估计，写入真实规模的测量（视图 14.7 MB，预算内只放得下约 45,000 个条目中的 27,102 个）。
- **1.2.0**：
  - `slots.schema.json` 明确 `expected` 每一项的对象模式（必填 `text` 字符串及必填 `quote` 对象，包含必填 `text` 和 `reference`）。
  - `functions/checks.ts` 的引文缺失提示（`QUOTE_MISSING`）明确指出位置、槽位路径（`/cases/${i}/expected/${j}/quote`）及要求形状。
  - `SKILL.md` 强调每个期望结果必须自带 quote 对象，严禁放在用例一级。
- **1.0.2**：
  - `SKILL.md` 新增“提交样例”章节，并提供可直接受理的 `examples/submit-result.json` 样例。
- **1.0.1**：
  - 投影函数 `projectDefects` 将输入的全量索引视图转为结构精炼的紧凑索引 `compact-case-index@1`，保证输出体积严格限制在 4 MiB 预算内，彻底解决 10 万级用例真实场景下沙箱输出超限（`SANDBOX_OUTPUT_TOO_LARGE`）问题。
  - 去重检查 `checkDuplicate` 适配紧凑索引数据结构；对因超限截断的不完整索引，未见重复时判定为未知（`unknown`，完整性未证明并如实说明丢弃数量），命中保留项时仍如实报告提示违规；无命令的未归位用例不参与去重并单独计数。
  - 推荐输入槽 `indexed_cases` 的外部 URI 指定 `fields=document,node,title` 进行字段裁剪，使沙箱输入严格受控在 2 至 3 MiB 范围（距 8 MiB 上限保有充足余量）。
- **1.0.0**：
  - 初始发布版本（已被已部署 Hub 收录）。

## 索引输入与沙箱资源余量

1. **沙箱输入上限与字段裁剪**：
   - Hub 沙箱调用的输入上限为 8 MiB（`SANDBOX_INPUT_MAX`）。真实构建的全量用例索引视图（如 FAMX 构建）包含大量 AST、长 statement 和复杂元数据，整体体积达 12 至 15 MiB，直接作为输入会导致超限。
   - 只裁字段不够：一个真实构建的用例索引视图即使只带 `document,node,title` 三个字段也有 14.7 MB，视图的字节预算只放得下约 45,000 个条目中的 27,102 个（被截断，查重只能记未知）。
   - 收窄写法：`knowledge:index:<产品>:<构建>?kind=case&key=commands&only=<命令路径，逗号分隔>&fields=commands,document,node,title,negative,case_structure`。`only` 列草稿要用的命令（和索引的键同一写法；多个命令用逗号分隔，命令里的空格写成 `%20`、字面逗号写成 `%2C`），由模型在读完缺陷后、开始运行时写上；`fields` 必须带 `commands`（收窄后靠键拼不回条目的命令集合），查重要比的其他字段也要列上。
   - 判得出来的范围：草稿的命令集合 S 里至少有一个命令在 `only` 里才判得出来；S 与 `only` 不相交的草稿记为未知（说明索引没有收窄到它用的命令）。完整视图（`truncated: false`、`skipped: 0`）省略的请求键确定没有用例，不要求核心返回空数组。截断或跳过导致覆盖不全时，对每份草稿分别保留可见重复的驳回；未见重复的草稿记未知，列出缺失键或缺少的文档数量，并按实际缺口补证：跳过来源须修复并同步新根，收窄缺口须调整 only/fields，元数据形状错误交集成者修复。不传 `only` 时也不因不完整而抹掉可见重复。

2. **紧凑索引与沙箱输出上限**：
   - 投影函数 `projectDefects` 将输入索引重组为按规范化命令集合键归并的紧凑索引（`compact-case-index@1`），单条记录仅保留 `{document, node, title（最多 80 字符）, reference}`。
   - 投影函数的整体输出严格限制在 4 MiB 以内。当用例量极大导致序列化体积超过 4 MiB 预算时，自动按命令键顺序进行截断并标记 `complete: false`，记录 `dropped` 数量并在 `notes` 中明确说明。4 MiB 紧凑索引相比沙箱 8 MiB 输出上限具有至少 4 MiB 的充足余量。
   - 去重检查 `checkDuplicate` 针对不完整的索引，在未见重复时判定为未知（`unknown`，完整性未证明，标明丢弃数量）；若与保留项命中重复则仍如实记录提示档违规。无命令的未归位用例不参与去重并在说明中单独计数。

## 运行参数

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `max_cases` | 整数（1-20，默认 6） | 每个缺陷最多起草的回归测试用例数量 |
| `priority` | 整数（1-3，默认 2） | 起草用例的默认优先级 |

## 检查项定义

| 检查 ID | 解释器 / 函数 | 判定对象 | 层级 | 依据要求项 |
| --- | --- | --- | --- | --- |
| `draft_shape` | 函数 `checkDraftShape` | 被审产物（条目） | blocking | `shape` |
| `commands_catalog` | 解释器 `catalog@1` | 被审产物（命令列表） | blocking | `commands` |
| `commands_refutation` | 函数 `checkCommandsRefutation` | 被审产物（条目） | blocking | `commands` |
| `grounded_quotes` | 解释器 `quote@1` | 被审产物（引文列表） | blocking | `grounded` |
| `grounded_sources` | 函数 `checkQuoteSources` | 被审产物（引文列表） | blocking | `grounded` |
| `grounded_reading` | 函数 `checkGroundedReading` | 被审产物（条目） | blocking | `grounded` |
| `duplicate_check` | 函数 `checkDuplicate` | 被审产物（起草用例与索引） | advisory | `not_duplicate` |

## 校验与测试

```bash
# 运行 defect-to-case 单元测试与端到端集成测试
node --test --test-concurrency=1 "packs/workflow/defect-to-case/**/*.test.ts"

# 执行 TypeScript 静态类型检查
npx tsc --noEmit
```


## 需要别的包做的事

- **contracts 与 hub/runs/engine**：需要可选的 `PackError.path`，仅允许 `/inputs/<declared slot>`，由引擎校验槽已声明后采用，取代当前一律定位 subject 槽的行为。当前 manual_mismatch 的协议 path 仍被核心写成 /inputs/defects；本包先以“输入槽 manual：”开头，避免用户改错输入。合约与引擎合入后，本包须返回 `/inputs/manual` 并增加端到端路径断言，不能把文本提示当作协议位置已修复。

- **packs/system/plm**：缺陷 content.fix_field 必须回传资源 settings.bug_fix_field 的字段名或 null；plm-fields 1.2.0 已完成本地合成验证，仍须集成者合入、发布、更新资源并核实真实字段后才生效，本包不把分支代码视为部署可用。
- **packs/product/famx**：若要增加按期望结果去重，需要 cases 生产器在用例索引提供期望原文及其来源；产品包字段和本包检查一起排期，须提供完整 case_structure，包括期望原文身份。
- **hub/runs/engine**：显式绑定不可读外部对象时，SOURCE_UNAVAILABLE 回执尚不能指出可补取的槽与对象；客户端当前须先核实可读再绑，可选 manual 不可读时不绑定，避免无说明地终止。
- **已做（1.5.0）**：核心视图已提供 `only` 和 `cut_keys`，本包已按字段消费；仅对缺少相应字段的老视图按 URI 和上限推断，并在说明里披露。

## 终审核对：收窄索引的缺失与空集

本次选择包内保守判断，不新增核心视图字段或改 contracts。完整且未跳过的视图省略某请求键，表示该键确定没有用例；只有覆盖不全时才保留该键为待补证。紧凑索引保留 `sourceTruncated`、`sourceSkipped` 与 `missingKeys`。查重逐份草稿报告，已见重复总是驳回；未见重复但覆盖不全时，说明缺哪些键或几份文档，并按缺口处理：跳过来源须修复或确认接纳后同步新根；收窄或预算问题按草稿命令收窄 only/fields 后补读一次；无效 only/cut_keys 字段交集成者修复。 缺少请求键与明确返回空键列表仍是两种情况：前者只在覆盖不全时记 `integrity_unproven`，后者在其余完整性条件成立时才允许得出未重复。

1.5.2：完整且未跳过的索引不返回某请求键，表示该键确定没有用例；只有不全覆盖时才把键的缺席当作待补证。

1.5.3（修正 1.5.0/1.5.1 的覆盖说明）：查重逐份起草用例报告。截断、跳过或键覆盖缺失不能抹掉已见重复；只将依赖不全覆盖的“没有重复”记为未知，并要求补取对应命令的完整索引。

### 查重补证边界

锁定根的 skipped 来源只能通过修复或确认接纳来源、重新同步生成新根补齐，重读旧根不能解决。
视图或紧凑预算截断时按草稿命令收窄 only/fields 后补读一次；每键固定上限不能提高，须报集成者能力缺口。
需要知识视图提供结构化排除原因，区分凭据排除与预算截断；当前包不猜测 notes 的文字。

1.5.5：同一草稿同时缺少来源和命令收窄时逐项说明，完整性未证明与仅缺收窄输入的原因分开；无效 only/cut_keys 明确报核心元数据缺陷。

## 引文来源边界（集成者确认，2026-10-23）

PLM 部署设置有两项。`settings.bug_fix_field` 由系统包在缺陷 `content.fix_field` 回传字段名，未配置时为 null。`settings.bug_fix_actions` 是动作码的 JSON 字符串数组，系统包据此填写 `content.fix_notes`；没配置时 fix_notes 为 null 并说明缺的是这个设置。本包不直接读取资源设置、不猜字段名或动作码。期望结果必须引用 fix_field 指向的字段原文，或 fix_notes 里某条 comment 原文；两处都没有才拒绝启动，修正说明点名缺的设置。

`manual` 为可选输入（expected 角色，接受 `manual:cli`），绑定时必须恰好一份且 external 等于运行版本线的 `manual:cli:<版本线>`。手册不再由 expected_sources 在投影之后自动绑定。投影将本条缺陷摘要、fix_field 和手册摘要冻结为条目字段 allowed_quote_sources，提交中的同名字段不起作用。grounded_sources 是阻断检查，违规给出修正说明并计入最多两轮修复。

只接受本条缺陷 `src:<摘要>/json@1/p/fields/<fix_field>`（可带该字段内的字节范围）、`src:<摘要>/json@1/p/fix_notes/<序号>/comment`（序号是冻结的数组位置，comment 为原文），或绑定手册的 src 片段。字段名按选择器的独立段解码后精确比较，序号与冻结位置逐字相等。不收父对象、其他字段、未冻结的序号、其他缺陷、其他来源。当前接口不能把 tree:/rec: 证明为这些原件；按集成者决定拒绝这些引用形式，要求改引已绑定原件的 src 片段。

跨包依赖：PLM 系统包在缺陷 content 回传 content.fix_field，并按 settings.bug_fix_actions 回传 fix_notes。真实资源仍须集成者配置这两项设置后才有可引用的修复说明。本包只用合成内容验证。没有读取或修改真实资源设置。

样例的 PLM 内容按 `{id, kind, title, fields, html_fields, fix_field}` 构造：HTML 已由系统包转成 fields 里的纯文本，html_fields 是字段名列表。`json@1/p/html_fields/fix` 不存在；引用配置为 fix 的示例用 `json@1/p/fields/fix`。字段名含 / 等路径字符时编码为一个选择器段。`reference-shape.test.ts` 通过核心 json@1 解析器定位样例引用，并重算示例内容摘要，避免只在假的字段结构上通过。

## 结构查重范围

按 case-structure@2 声明的命令路径、类型参数、期望原件引文身份及 after 比较完整结构。标题保留原文，仅用于展示，不做大小写、全半角或空白折叠。最多 80 UTF-16 单元的展示标题不截断代理对，也不参与结构键。

相同标题不表示重复。参数值或引文身份不同的草稿结构不同；缺身份不能视作空参数或空期望，必须披露未知、缺失事实和下一步。索引作者须声明完整 case_structure，不能用期望文字猜测引文身份。

复核确认：没有手册的版本线可不绑定 manual，投影冻结 manual:null 并明确警告仅修复字段可引。先按锁定构建确定版本线并核实手册可读；有手册再补绑重开。集成者需同步 gold-d2c 批跑提示（模板目前只有 defect/product/build），让客户端执行这个动作；Hub 不替客户端生成内容或选择默认版本线。

复核修正：投影在 fix_field 有非空文字，或 fix_notes 有非空 comment 时才放行。配置了字段但文字为空、且没有可引用的动作说明时，以 fix_text_missing 拒绝并点名缺陷及字段，要求核对 settings.bug_fix_field 或 settings.bug_fix_actions。两处都没有时以 missing_fix_field 拒绝并点名这两个设置。PLM 系统包只按声明回传，不承担这个消费方检查。

收尾复核：manual_missing 由 expected_sources 从冻结条目发出，随 start_run 的 evidence gaps 返回，投影日志中的同名警告不再冒充客户端已见。条目摘要也明确未绑定手册；回执列出版本线、manual:cli 地址、配置修复字段和重开动作。

收尾复核第二轮：manual_mismatch 的原因直接按绑定数量、实际外部身份和运行版本线确定。有版本线时允许改绑同线手册或保持未绑定；没有版本线时明确要求不绑定 manual，仅引用修复字段，不再给无法执行的占位手册地址。

## 检查时按草稿命令收窄读取

`duplicate_check.reads.narrow` 已接入核心通用接口：`slot: indexed_cases` 固定已绑定输入，`key_path: /read_keys` 从主体取键，`into: /indexed_cases` 接收新视图，`max_keys: 100`、`max_entries: 5000`、`max_bytes: 1048576` 限定读取，`rebind: true` 用这些键替换已绑定的 only。主体构造器从目录里最长命令头的 CommandIdentity 完整路径取键，模型声明的 read_keys 不参与。引擎按已绑定视图的同一修订重读，字段范围不变，并把请求键、上限、返回来源、提供方清单和缺失事实写入运行的读取清单；每项检查结果指向该清单。

推荐开始运行时绑定带 `fields=commands,document,node,title,negative,case_structure` 的索引。预先写上的 only（包括 only=user 这种空视图）不再挡住这些命令路径。收窄结果在同一修订上完整、且这些命令没有用例时，结论是范围内没有重复。跳过、截断或超限仍是未知；可见的重复仍驳回。完全不可读时不调用检查函数。索引修订已不可取或永久跳过文档时，应补建并绑定新修订重开运行。

超限后的客户端补取动作在 SKILL 中：读取草稿完整命令身份的 path，读取同一锁定构建的 only/fields 索引，以新输入重开后再交草稿；旧运行不会因重交而刷新冻结输入。数据内引文的预热和分级已经实现，删除旧的必须抄到顶层才能核验的绕行说法。

标签按 resource-tags@1 的精确原文闭集读取，保留 resource 原值。闭集外是提示档结构违规“未声明的标签”；大小写、全半角与同义词不相等。非法声明不进入正反向比例分母。此版本替代旧关键词规则，历史结果不改写；应以新包重产新根与新运行。本次续接按所有者指令未运行验证。

R7 新规则：发布状态只取 release-notes@2 JSON 的显式 product/build/defects[].bug/status/text，status 来自生成词表 release_status；complete 必须为 true，构建与冻结构建精确相等。HTML/Markdown 标题、文件角色及数字外形不再补 fixed/known，缺字段给来源维护人补原始 JSON 后重产。可选 version、released、module、system 只读声明，不从正文猜测。

1.6.20 修正技能和两个提交样例：测试类型写在 `resource`，取包内标签表的精确原文，并声明稳定草稿 `id`。原来的 `tags` 只是保留的旧字段，大小写变体不等同于声明值；检查规则不变。

查重规则 defect-to-case.case-structure@2：原用例作者在 KityMinder case 节点 data.case_structure 声明 {schema:"case-structure@2",commands:CommandIdentity[],expected:[{after,quote:ExpectedQuoteIdentity}]}，FAMX 原样保留并标作者声明。草稿给稳定 id，每步 identity，每个 expected 给 identity/after 和原文 quote。命令与期望的顺序及重复次数均保留，after 为从 1 起的命令位置；参数按显式位置排序及类型化 parsed 值比较，不补默认值，raw/role/标题/标签/正反向/优先级不作键。引用按原始摘要、parser、路径、byte span 完全相等。Hub 核验草稿引文 byte span 与完整原件字节；没有原件、类型来源、结构声明或完整索引范围时保持未知，并请求补声明/原件后以新根或新运行续做。非法负向命令没有合法完整身份时，不伪造身份：交包作者补非法输入身份合约或具名人工复核。

主张直接带 draft_id、requirement、rule_version、structure_key、duplicate_of 的 document/node/reference；计数只看这些字段，不读 statement。相同标题不表示结构重复。旧记录字节保留，新包重产后另留血缘；本版按所有者要求运行包测试及 acceptance 27。

结构查重按 case-structure@2 的命令路径、类型参数与期望引文身份（原件、parser、路径、byte span、after）完全相等比较；标题仅展示。duplicate_found 故意使用不同标题并声明相同结构，防止退回标题启发式。缺身份返回未知，不能以同标题推断重复。

| `refutation_catalog` | 冻结目录完整签名核对反向命令声明 |

| `fixed_status` | 仅核对原始结构已修复状态；缺失为未知并补原件，不影响命令树和手册成根 |

## 发布状态的局部缺口（1.6.15）

缺 release-notes@2 原始 status 不再作为整个构建的 producer incomplete。结构身份可核对的缺陷保留原文引用，status:null、declaration_status:undeclared，并带 missing/next_action；缺身份另记 identity_declaration_status:undeclared，不能从正文数字、标题、标记或文件名猜编号和 fixed/known。HTML 仅从解析后的明确 tracker URL 结构取身份，不从锚文本猜状态。

命令树、手册等独立来源仍照常成根；未声明条目不被追溯状态过滤静默删掉，依赖“已修复”的判断保持未知并请求来源维护者补结构状态后重产。缺陷转用例单列 fixed_status 要求项，其他检查继续独立核对。历史根不改写，本版验证只使用合成 JSON/HTML、临时 PostgreSQL 和脚本化模型，不重跑真实同步。

## 联合类型参数的结构身份（1.6.21）

命令树里的联合类型参数（例如 IPADDR 是 IPv4 或 IPv6）由产品包生成器发布成同一签名引用下的几个目录签名（编号 k.1、k.2），草稿和索引用例的 CommandIdentity 记的仍是这一个签名引用。结构身份按这个引用下的全部展开核对：各展开除了每个参数的类型备选，其余必须一致（参数个数、名称、原生类型、可省略标记）；一致时，身份只要在其中一个展开下完整就成立，即每个参数都有类型且约束已核、必填参数都给了、每个实参都落在所声明的类型内。不会拿一个展开的地址和另一个展开的端口拼出身份。展开之间不一致时身份不成立，查重记未知，不再默认取第一个展开。

1.6.20 及以前只拿第一个展开核对，排在后面的备选永远对不上（IPv6 地址；IPMASK 先列点分掩码时的前缀长度）：带这种参数的草稿查重停在未知；索引里这样的用例被算作“缺完整作者结构声明”，同一视图下的其他草稿，只要没查出与别的用例重复，也跟着停在未知。`functions/union-identity.test.ts` 用合成的双族地址命令复现并覆盖这几种情况。
