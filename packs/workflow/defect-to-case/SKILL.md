# 缺陷转用例（回归测试用例起草）

从缺陷（现象、修复说明）起草回归测试用例，Hub 在边界与运行期核对用例结构、命令与参数合法性、期望结果引文依据、以及与已索引用例的重复判定。

## 1. 任务目标与输入

- **输入 defects**：一个或多个缺陷外部标识（例如 `plm:bug:<编号>`）。为每个缺陷起草回归测试用例；若缺陷无法起草用例（如底层代码重构、无外部可测命令行或行为变化），必须在条目中声明跳过（`handling: "skipped"`）并写明诚实理由。
- **输入 indexed_cases**：当前锁定构建的已索引用例清单，收窄到草稿要用的命令（`knowledge:index:<product>:<build>?kind=case&key=commands&only=<命令路径，逗号分隔>&fields=commands,document,node,title,negative`）。`only` 在读完缺陷、动笔起草后、开始运行时写上（和索引的键同一写法；多个命令用逗号分隔，命令里的空格写成 `%20`、字面逗号写成 `%2C`）；`fields` 必须带 `commands`（收窄后靠键拼不回条目的命令集合），查重要比的其余字段也要列上。草稿的命令集合与 `only` 不相交时查重记未知。
- **参数**：
  - `max_cases`：每个缺陷最多起草用例数（整数，1 到 20，默认 6）。
  - `priority`：默认用例优先级（整数，1 到 3，默认 2）。

## 2. 证据读取与期望来源

在 `start_run` 成功后，Hub 绑定输入缺陷及相关证据来源：
0. **开始运行前核实可选手册**：先用锁定构建确定版本线，读取确认手册可用后，inputs.manual 绑定 `{"external":"manual:cli:<运行版本线>"}`，必须与运行版本线一致。没有可用手册就不绑定，只能引用修复说明字段；不要绑定一个不可读对象导致无说明地结束。收到 manual_missing 后自动核实，能补取时补绑重开运行。自动期望来源不再替你绑定手册。
1. **缺陷记录**（被判对象与期望来源）：读取现象描述与修复说明（字段名来自缺陷 content.fix_field，由 PLM 资源 settings.bug_fix_field 配置；没有就请集成者配置并自动重读，不猜字段名）。分析缺陷根因、修复逻辑、涉及的 CLI 命令与期望行为。
2. **手册与命令目录**（期望来源）：在锁定构建的知识根中查验命令签名、参数类型与取值范围。不熟悉的命令先在命令目录或手册中核实。
3. **已索引用例**：查验锁定构建已覆盖的用例，避免重复设计。

## 3. 用例起草规范（槽位 cases）

每个处理的缺陷条目在 `slots.cases` 中起草 1 到 `max_cases` 个回归测试用例。每个起草用例需满足团队用例结构规范：
- `title`：简明用例标题，非空且不超过 200 字符。
- `priority`：用例优先级，取值 1 到 3 的整数（1 为最高优先级，默认为 2）。
- `negative`：布尔值，是否为反向用例。反向用例必须标记为 `true`。
- `expects_refutation`：布尔值，是否预期被命令目录反驳。
  - 对于正向用例，`negative: false`，`expects_refutation: false`，其命令行必须在锁定构建命令目录中合法解析。
  - 对于反向用例（如测试参数超出范围时报错），`negative: true` 且 `expects_refutation: true`，其命令行预期被目录反驳（参数越界为用例设计点）。若命令行被目录接受，Hub 将判定为违规并要求修复。
- `preconditions`：字符串数组，前置条件列表。
- `steps`：测试步骤列表，包含 `text`（步骤说明）与 `command`（执行的命令行）。每个用例至少包含一个带有命令行的步骤。
- `expected`：期望结果列表。**特别注意**：每个期望结果必须自己带 `quote` 对象（形状为 `{"text": "<修复说明或手册里的逐字原文>", "reference": "<引用>"}`），槽位路径为 `/cases/<用例序号>/expected/<期望结果序号>/quote`。**严禁**将引文放在用例一级或在期望结果中遗漏 quote。并且：每个期望结果的 quote 还必须**照抄进本条用例主张顶层的 `quotes` 数组**（与 `cases[].expected[].quote` 同一份内容）。引文只有在边界被解析过才能被 quote@1 核对；只写在期望结果的数据里、不抄进顶层 quotes 的引文，会被记成「没有绑定到本次运行」的未知（这是核心的缺口，另有任务修它；在修好之前，照抄进顶层是唯一正确的写法）。
  - `text`：期望结果文字（必填字符串，必须是自身引文的非空逐字片段，只忽略空白差异，不得改写）。
  - `quote`：逐字引文（必填对象，`{ "text": "...", "reference": "..." }`），包含必填的 `text`（修复说明或手册里的逐字原文）和 `reference`（引用地址）。每个期望结果必须各自携带自己的 quote。
- `tags`：标签列表，至少包含一个属于团队模板类别的标签（`Functional`、`Negative`、`Boundary`、`Performance`、`Security`、`Compatibility`）。反向用例若含 `Negative` 标签，必须保证 `negative: true`。

## 4. 边界校验与修复规则

Hub 对提交进行两层核对：
1. **边界解析**：
   - 引文必须一字不差地存在于引用片段中（`QUOTE_MISMATCH`）。
   - 引用必须在所绑定来源中成功解析（`REFERENCE_UNRESOLVED`）。
2. **要求项事实检查**：
   - `shape`（结构）：空标题、缺失步骤或期望结果、优先级越界、非标准标签、同次提交重复用例（退回修复，最多 2 轮）。
   - `commands`（命令与参数）：参数类型不符、参数越界或命令不存在；反向用例反驳与预期不一致（退回修复，最多 2 轮）。
   - `grounded`（依据）：只允许本条缺陷 src 原件的 json@1/p/fields/<fix_field> 或 manual 槽绑定手册的 src 片段；其他字段、其他来源及 tree:/rec: 均退回修正，改引对应原件；每个期望结果必须自带 quote；缺失 quote、把 quote 放在用例一级而非期望结果内部、或 quote 缺失 reference/text 均会被拒；期望文字不是自身引文的逐字片段（退回修复，最多 2 轮）。
   - `not_duplicate`（去重）：若与已索引用例存在相同规范化命令、相同正反向且规范化标题相同，判定为重复用例违规（提示档）；当前不比较期望结果原文。若索引存在跳过文档且未见重复，诚实判定为未知（完整性未证明）。

## 5. 提交样例

使用 `submit_result` 一次性提交所有条目。照这个结构写，字段名一个都不要改，只换内容（完整样例见 examples/submit-result.json）：

```json
{
  "run": "run_01m5h9zm2nhzbz2hrfjfb6azta",
  "model": "synthetic-model",
  "items": [
    {
      "item": "74001",
      "handling": "handled",
      "slots": {
        "cases": [
          {
            "text": "SLB健康检查间隔配置测试",
            "quotes": [
              {
                "reference": "src:345222e457e0a9333587bf2613c8aa690b0d508cab1ae4eb7e3f14ef30e26982/json@1/p/fields/fix",
                "text": "健康检查间隔设置成功"
              }
            ],
            "data": {
              "title": "SLB健康检查间隔配置测试",
              "priority": 2,
              "negative": false,
              "expects_refutation": false,
              "preconditions": [
                "SLB正常运行"
              ],
              "steps": [
                {
                  "text": "执行配置健康检查间隔命令",
                  "command": "widget health interval 60"
                }
              ],
              "expected": [
                {
                  "text": "健康检查间隔设置成功",
                  "quote": {
                    "reference": "src:345222e457e0a9333587bf2613c8aa690b0d508cab1ae4eb7e3f14ef30e26982/json@1/p/fields/fix",
                    "text": "健康检查间隔设置成功"
                  }
                }
              ],
              "tags": [
                "Functional"
              ]
            }
          }
        ]
      }
    }
  ]
}
```
