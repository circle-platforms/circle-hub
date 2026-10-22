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
| `pack.json` | 任务包清单（`defect-to-case@1.0.2`，由 packaging.ts / pack-files.ts 签名，包含所有包内文件的相对路径、SHA-256 与文件大小） |

非任务包发布文件：`api.ts`（外部包与工具接口）、`pack-files.ts`（打包与签名工具）、`README.md`、测试文件（`*.test.ts`）与测试辅助目录（`testing/`）。

## 版本说明

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
   - 推荐在输入 URI 中指定 `fields=document,node,title`（`knowledge:index:<产品>:<构建>?kind=case&key=commands&fields=document,node,title`），仅提取去重判定必需的精简字段。裁剪后 10 万级用例条目的视图体积控制在 2 至 3 MiB 左右，距 8 MiB 输入上限保有 60% 以上的安全余量。

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
node --test --test-concurrency=2 "packs/workflow/defect-to-case/**/*.test.ts"

# 执行 TypeScript 静态类型检查
npx tsc --noEmit
```
