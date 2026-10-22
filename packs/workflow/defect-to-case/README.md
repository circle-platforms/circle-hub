# defect-to-case: 缺陷转用例任务包

工作流任务包 `defect-to-case`（能力 5：缺陷转用例）：模型从缺陷记录（现象与修复说明）起草回归测试用例，Hub 负责机械核对用例结构、命令与参数合法性、期望结果引文依据、以及与锁定构建已索引用例的重复判定。

## 任务包结构与文件

| 文件 | 内容与职责 |
| --- | --- |
| `workflow.json` | 声明输入插槽：`defects`（主体角色，必填，多项，绑定 `plm:bug`）与 `indexed_cases`（期望角色，必填，绑定 `knowledge:index:<product>:<build>?kind=case&key=commands`）；参数 `max_cases`（默认 6）与 `priority`（默认 2）；绑定命令目录 `commands@1`；映射投影函数与期望来源函数 |
| `requirements.json` | 声明五项要求项：`cases`（用例起草，判定，条目级）、`shape`（用例结构，事实，条目级）、`commands`（命令与参数，事实，条目级）、`grounded`（期望结果依据，事实，条目级）、`not_duplicate`（用例去重，事实，条目级），以及各代码的修复重试规则（最多 2 轮） |
| `checks.json` | 声明六项检查：`draft_shape`（结构合规）、`commands_catalog`（目录解析与参数校验）、`commands_refutation`（反向用例预期反驳校验）、`grounded_quotes`（逐字引文核对）、`grounded_reading`（精简阅读未载实体核对）、`duplicate_check`（已索引用例去重检查） |
| `slots.schema.json` | 声明条目插槽 `cases`：包含起草用例的结构模式（标题、优先级、正反向、预期反驳、前置条件、步骤与命令行、期望结果与逐字引文、标签） |
| `SKILL.md` | 中文起草指引（< 8000 字符）：任务目标、证据读取顺序、用例起草结构、边界校验与修复规则、提交格式 |
| `functions/` | 投影函数 `projection.ts`、期望来源函数 `expected.ts`、被判对象构建器 `subjects.ts`、纯检查函数 `checks.ts` 及类型定义 `types.ts` |
| `tables/` | 检查表定义：`commands.json`（`catalog@1` 解释器表）与 `quotes.json`（`quote@1` 解释器表） |
| `samples/` | 12 个样例（`pack-sample@1`，positive 与 negative 各 6 个），覆盖所有 6 项检查 |
| `examples/` | 合成示例：`start-run.json` 与 `submission.json` |
| `pack.json` | 任务包清单（由 `pack-files.ts` 签名，包含所有包内文件的相对路径、SHA-256 与文件大小） |

非任务包发布文件：`api.ts`（外部包与工具接口）、`pack-files.ts`（打包与签名工具）、`README.md`、测试文件（`*.test.ts`）与测试辅助目录（`testing/`）。

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
