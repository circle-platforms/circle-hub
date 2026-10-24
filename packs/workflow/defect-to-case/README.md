# defect-to-case: 缺陷转用例任务包

工作流任务包 `defect-to-case`（能力 5：缺陷转用例）：模型从缺陷记录（现象与修复说明）起草回归测试用例，Hub 负责机械核对用例结构、命令与参数合法性、期望结果引文依据、以及与锁定构建已索引用例的重复判定。

## 任务包结构与文件

| 文件 | 内容与职责 |
| --- | --- |
| `workflow.json` | 声明输入插槽：`defects`（主体角色，必填，多项，绑定 `plm:bug`）、`indexed_cases`（期望角色，必填，绑定收窄的 `knowledge:index:<product>:<build>?kind=case&key=commands&only=<命令>&fields=commands,document,node,title,negative`）及 `manual`（期望角色，可选，绑定 `manual:cli:<版本线>`）；参数 `max_cases`（默认 6）与 `priority`（默认 2）；绑定命令目录 `commands@1`；映射投影函数与期望来源函数 |
| `requirements.json` | 声明五项要求项：`cases`（用例起草，判定，条目级）、`shape`（用例结构，事实，条目级）、`commands`（命令与参数，事实，条目级）、`grounded`（期望结果依据，事实，条目级）、`not_duplicate`（用例去重，事实，条目级），以及各代码的修复重试规则（最多 2 轮） |
| `checks.json` | 声明七项检查：`draft_shape`（结构合规）、`commands_catalog`（目录解析与参数校验）、`commands_refutation`（反向用例预期反驳校验）、`grounded_quotes`（逐字引文核对）、`grounded_sources`（来源范围核验）、`grounded_reading`（期望文字逐字核对）、`duplicate_check`（已索引用例去重检查） |
| `slots.schema.json` | 声明条目插槽 `cases`：包含起草用例的结构模式（标题、优先级、正反向、预期反驳、前置条件、步骤与命令行、期望结果与逐字引文、标签） |
| `SKILL.md` | 中文起草指引（< 8000 字符）：任务目标、证据读取顺序、用例起草结构、边界校验与修复规则、提交格式 |
| `functions/` | 投影函数 `projection.ts`、不再自动绑定手册的期望来源函数 `expected.ts`、被判对象构建器 `subjects.ts`、纯检查函数 `checks.ts` 及类型定义 `types.ts` |
| `tables/` | 检查表定义：`commands.json`（`catalog@1` 解释器表）与 `quotes.json`（`quote@1` 解释器表） |
| `samples/` | 14 个样例（`pack-sample@1`，positive 与 negative 各 7 个），覆盖所有 7 项检查 |
| `examples/` | 合成示例：`start-run.json`、`submission.json` 与 `submit-result.json` |
| `pack.json` | 任务包清单（`defect-to-case@1.6.6`，由 packaging.ts / pack-files.ts 签名，包含所有包内文件的相对路径、SHA-256 与文件大小） |

| `pack.json` | 任务包清单（`defect-to-case@1.6.7`，由 packaging.ts / pack-files.ts 签名，包含所有包内文件的相对路径、SHA-256 与文件大小） |

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
  - 查重绑定收窄到草稿要用的命令：`indexed_cases` 的 URI 带 `only=<命令路径>` 与 `fields=commands,document,node,title,negative`；草稿的命令集合与 `only` 相交才判得出来，不相交记未知。去掉 `expected.ts` 自动绑定的不带 `fields` 的同一索引。紧凑索引按条目的 `commands` 字段算命令集合。
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
   - Hub 沙箱调用的输入上限为 8 MiB（`SANDBOX_INPUT_MAX`）。真实构建的全量用例索引视图（如 APV 构建）包含大量 AST、长 statement 和复杂元数据，整体体积达 12 至 15 MiB，直接作为输入会导致超限。
   - 只裁字段不够：一个真实构建的用例索引视图即使只带 `document,node,title` 三个字段也有 14.7 MB，视图的字节预算只放得下约 45,000 个条目中的 27,102 个（被截断，查重只能记未知）。
   - 收窄写法：`knowledge:index:<产品>:<构建>?kind=case&key=commands&only=<命令路径，逗号分隔>&fields=commands,document,node,title,negative`。`only` 列草稿要用的命令（和索引的键同一写法；多个命令用逗号分隔，命令里的空格写成 `%20`、字面逗号写成 `%2C`），由模型在读完缺陷后、开始运行时写上；`fields` 必须带 `commands`（收窄后靠键拼不回条目的命令集合），查重要比的其他字段也要列上。
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
- **packs/product/apv**：若要增加按期望结果去重，需要 cases 生产器在用例索引提供期望原文及其来源；产品包字段和本包检查一起排期，当前只比较完整规范化标题。
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

PLM 部署设置为 `settings.bug_fix_field`，系统包须在缺陷 `content.fix_field` 回传字段名；未配置时回传 null 并说明缺失设置。本包不直接读取资源设置、不猜 fix 等默认字段，缺少 content.fix_field 就拒绝启动并要求集成者配置后重新读缺陷。

`manual` 为可选输入（expected 角色，接受 `manual:cli`），绑定时必须恰好一份且 external 等于运行版本线的 `manual:cli:<版本线>`。手册不再由 expected_sources 在投影之后自动绑定。投影将本条缺陷摘要、fix_field 和手册摘要冻结为条目字段 allowed_quote_sources，提交中的同名字段不起作用。grounded_sources 是阻断检查，违规给出修正说明并计入最多两轮修复。

只接受本条缺陷 `src:<摘要>/json@1/p/fields/<fix_field>`（可带该字段内的字节范围），或绑定手册的 src 片段。字段名按选择器的独立段解码后精确比较，不收父对象、其他字段、其他缺陷、其他来源。当前接口不能把 tree:/rec: 证明为这两份原件；按集成者决定拒绝这些引用形式，要求改引已绑定原件的 src 片段。

跨包依赖：PLM 系统包尚未提供 content.fix_field；集成者在需求追溯变更合并后安排补齐。本包只用带 fix_field 的合成内容验证；在系统包补齐之前，真实启动将明确拒绝。没有读取或修改真实资源设置。

样例的 PLM 内容按 `{id, kind, title, fields, html_fields, fix_field}` 构造：HTML 已由系统包转成 fields 里的纯文本，html_fields 是字段名列表。`json@1/p/html_fields/fix` 不存在；引用配置为 fix 的示例用 `json@1/p/fields/fix`。字段名含 / 等路径字符时编码为一个选择器段。`reference-shape.test.ts` 通过核心 json@1 解析器定位样例引用，并重算示例内容摘要，避免只在假的字段结构上通过。

## 查重标题规范化

查重标题规范化依次执行：NFKC、小写、把空白折成一个空格、去两端空白。空白按 JavaScript 的 `\s` 定义；连续的空白不删除，而是替换成一个普通空格，不去掉标题中的标点。例：`  ＷＩＤＧＥＴ\tＡ  ` 变为 `widget a`。独立金标准按这段规则自行实现，不读取本包计算的结果。

## 查重要求项的范围

not_duplicate 的已实现判据是：相同的规范化命令头集合、相同的正反向标记、规范化标题相同，三项同时成立才报告重复。不会因为期望结果相同就报告重复，也不会因为期望结果不同就忽略同标题的重复；不承诺比较索引未给出的期望文字。重复为提示档，未见重复但索引不完整时按现有规则披露完整性缺口。

待集成者排期：若要支持“期望结果相同”的独立分支，产品包须先在用例索引提供期望原文及其来源，再扩展本包并做独立核对。这是产品包和工作流的后续变更，本次未实现。

复核修正：紧凑索引增加完整规范化标题的 SHA-256 比较键 title_key；最多 80 UTF-16 单元的 title 只供展示，且不截断代理对。比较不对完整标题截短，80 单元前缀不会冒充相同标题。

复核确认：没有手册的版本线可不绑定 manual，投影冻结 manual:null 并明确警告仅修复字段可引。先按锁定构建确定版本线并核实手册可读；有手册再补绑重开。集成者需同步 gold-d2c 批跑提示（模板目前只有 defect/product/build），让客户端执行这个动作；Hub 不替客户端生成内容或选择默认版本线。

复核修正：本包在投影时检查 fields[fix_field] 必须为非空文字，缺失或为空以 fix_text_missing 拒绝并点名缺陷及字段，要求核对 settings.bug_fix_field 或更换缺陷。PLM 系统包仅回传设置，不承担这个消费方检查。

收尾复核：manual_missing 由 expected_sources 从冻结条目发出，随 start_run 的 evidence gaps 返回，投影日志中的同名警告不再冒充客户端已见。条目摘要也明确未绑定手册；回执列出版本线、manual:cli 地址、配置修复字段和重开动作。

收尾复核第二轮：manual_mismatch 的原因直接按绑定数量、实际外部身份和运行版本线确定。有版本线时允许改绑同线手册或保持未绑定；没有版本线时明确要求不绑定 manual，仅引用修复字段，不再给无法执行的占位手册地址。

## 检查时按草稿命令收窄读取

`duplicate_check.reads.narrow` 已接入核心通用接口：`slot: indexed_cases` 固定已绑定输入，`key_path: /read_keys` 从主体取键，`into: /indexed_cases` 接收新视图，`max_keys: 100`、`max_entries: 5000`、`max_bytes: 1048576` 限定读取。主体构造器按锁定命令目录解析最长命令头，去重后取键；核心不解释命令或草稿字段。引擎按已绑定视图的同一修订实际重读 `only`，字段范围不变，并把请求键、上限、返回来源、提供方清单和缺失事实写入运行的读取清单；每项检查结果指向该清单。

推荐开始运行时绑定带 `fields=commands,document,node,title,negative` 的索引，不预先加 `only`，检查时按实际草稿收窄。若输入已带 `only`，它仍是本运行的范围上界，不能扩大到范围外的命令。缺键、跳过、截断或超限时没有重复只记未知，并说明缺的事实和重读或调高上限的动作；可见的重复仍驳回。完全不可读时不调用检查函数。索引修订已不可取或永久跳过文档时，应补建并绑定新修订重开运行，不把读取新根冒充旧根的完整结果。

超限后的客户端补取动作在 SKILL 中：解析草稿命令头，读取同一锁定构建的 only/fields 索引，以新输入重开后再交草稿；旧运行不会因重交而刷新冻结输入。数据内引文的预热和分级已经实现，删除旧的必须抄到顶层才能核验的绕行说法。

标签按 resource-tags@1 的精确原文闭集读取，保留 resource 原值。闭集外是提示档结构违规“未声明的标签”；大小写、全半角与同义词不相等。非法声明不进入正反向比例分母。此版本替代旧关键词规则，历史结果不改写；应以新包重产新根与新运行。本次续接按所有者指令未运行验证。
