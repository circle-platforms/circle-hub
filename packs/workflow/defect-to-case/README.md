# defect-to-case: 缺陷转用例任务包

工作流任务包 `defect-to-case`（能力 5：缺陷转用例）：模型从缺陷记录（现象与修复说明）起草回归测试用例，Hub 负责机械核对用例结构、命令与参数合法性、期望结果引文依据、以及与锁定构建已索引用例的重复判定。

## 任务包结构与文件

| 文件 | 内容与职责 |
| --- | --- |
| `workflow.json` | 声明输入插槽：`defects`（主体角色，必填，多项，绑定 `plm:bug`）与 `indexed_cases`（期望角色，必填，绑定 `knowledge:index:<product>:<build>?kind=case&key=commands&fields=document,node,title`）；参数 `max_cases`（默认 6）与 `priority`（默认 2）；绑定命令目录 `commands@1`；映射投影函数与期望来源函数 |
| `requirements.json` | 声明五项要求项：`cases`（用例起草，判定，条目级）、`shape`（用例结构，事实，条目级）、`commands`（命令与参数，事实，条目级）、`grounded`（期望结果依据，事实，条目级）、`not_duplicate`（用例去重，事实，条目级），以及各代码的修复重试规则（最多 2 轮） |
| `checks.json` | 声明六项检查：`draft_shape`（结构合规）、`commands_catalog`（目录解析与参数校验）、`commands_refutation`（反向用例预期反驳校验）、`grounded_quotes`（逐字引文核对）、`grounded_reading`（精简阅读未载实体核对）、`duplicate_check`（已索引用例去重检查） |
| `slots.schema.json` | 声明条目插槽 `cases`：包含起草用例的结构模式（标题、优先级、正反向、预期反驳、前置条件、步骤与命令行、期望结果与逐字引文、标签） |
| `SKILL.md` | 中文起草指引（< 8000 字符）：任务目标、证据读取顺序、用例起草结构、边界校验与修复规则、提交格式 |
| `functions/` | 投影函数 `projection.ts`、期望来源函数 `expected.ts`、被判对象构建器 `subjects.ts`、纯检查函数 `checks.ts` 及类型定义 `types.ts` |
| `tables/` | 检查表定义：`commands.json`（`catalog@1` 解释器表）与 `quotes.json`（`quote@1` 解释器表） |
| `samples/` | 12 个样例（`pack-sample@1`，positive 与 negative 各 6 个），覆盖所有 6 项检查 |
| `examples/` | 合成示例：`start-run.json`、`submission.json` 与 `submit-result.json` |
| `pack.json` | 任务包清单（`defect-to-case@1.5.3`，由 packaging.ts / pack-files.ts 签名，包含所有包内文件的相对路径、SHA-256 与文件大小） |

非任务包发布文件：`api.ts`（外部包与工具接口）、`pack-files.ts`（打包与签名工具）、`README.md`、测试文件（`*.test.ts`）与测试辅助目录（`testing/`）。

## 版本说明

- **1.5.3**：逐份草稿报告；已见重复照样驳回。仅将依赖不全覆盖的“没有重复”记为带补取出口的未知，保留跳过文档的数量。
- **1.5.2**：视图未截断、未跳过时，没返回的请求键确定没有用例。
- **1.5.1**（原实现有误，已由 1.5.2/1.5.3 修正）：曾将省略空键和可见重复一起记未知。
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
   - 判得出来的范围：草稿的命令集合 S 里至少有一个命令在 `only` 里才判得出来；S 与 `only` 不相交的草稿记为未知（说明索引没有收窄到它用的命令）。完整视图（`truncated: false`、`skipped: 0`）省略的请求键确定没有用例，不要求核心返回空数组。截断或跳过导致覆盖不全时，对每份草稿分别保留可见重复的驳回；未见重复的草稿记未知，列出缺失键或缺少的文档数量，并要求补取后重读。不传 `only` 时也不因不完整而抹掉可见重复。

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
| `grounded_reading` | 函数 `checkGroundedReading` | 被审产物（条目） | advisory | `grounded` |
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

本次选择包内保守判断，不新增核心视图字段或改 contracts。完整且未跳过的视图省略某请求键，表示该键确定没有用例；只有覆盖不全时才保留该键为待补证。紧凑索引保留 `sourceTruncated`、`sourceSkipped` 与 `missingKeys`。查重逐份草稿报告，已见重复总是驳回；未见重复但覆盖不全时，说明缺哪些键或几份文档，要求补取并重新读取索引。

1.5.2：完整且未跳过的索引不返回某请求键，表示该键确定没有用例；只有不全覆盖时才把键的缺席当作待补证。

1.5.3（修正 1.5.0/1.5.1 的覆盖说明）：查重逐份起草用例报告。截断、跳过或键覆盖缺失不能抹掉已见重复；只将依赖不全覆盖的“没有重复”记为未知，并要求补取对应命令的完整索引。
