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
| `pack.json` | 任务包清单（`defect-to-case@1.6.0`，由 packaging.ts / pack-files.ts 签名，包含所有包内文件的相对路径、SHA-256 与文件大小） |

非任务包发布文件：`api.ts`（外部包与工具接口）、`pack-files.ts`（打包与签名工具）、`README.md`、测试文件（`*.test.ts`）与测试辅助目录（`testing/`）。

## 版本说明

- **1.6.0**：期望文字必须是其引文的非空逐字片段，只折叠空白；改写为阻断违规 `defect-to-case.expect_not_in_quote`，计入最多两轮修复。引文来源受配置修复字段和可选同版本线手册限制；样例采用 PLM 真实字段结构；公开标题规范化规则，查重要求项只承诺实际执行的标题比较。

- **1.5.1**：收窄索引缺少请求键或源视图截断时，查重记未知并列出重读要求；区分缺失键和明确的空键列表。
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
   - 判得出来的范围：草稿的命令集合 S 里至少有一个命令在 `only` 里才判得出来；S 与 `only` 不相交的草稿记为未知（说明索引没有收窄到它用的命令）。收窄视图还必须实际返回请求键（`keys` 中明确的空数组可以证明该键无条目），且 `truncated` 不能为真。缺少任何请求键或收窄视图截断时，该批查重记未知，说明列出缺少的键及重新读取要求；不因 `only` 声明或仍可见的候选断定覆盖完整。不传 `only` 时照旧：视图完整才判得出来，被截断就记未知。

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

- **已做（1.5.0）**：核心视图已提供 `only` 和 `cut_keys`，本包已按字段消费；仅对缺少相应字段的老视图按 URI 和上限推断，并在说明里披露。

## 终审核对：收窄索引的缺失与空集

本次选择包内保守判断，不新增核心视图字段或改 contracts。紧凑索引保留源视图的 `sourceTruncated` 与 `missingKeys`；缺少请求键与明确返回空键列表是两种情况。前者及源截断均为 `integrity_unproven`，修正说明要求重读缺失键或未截断视图；后者在其余完整性条件成立时才允许得出未重复。测试分别钉住缺键、明确空集、截断后仍可见疑似重复项，及原有 URI/字段优先级。

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
