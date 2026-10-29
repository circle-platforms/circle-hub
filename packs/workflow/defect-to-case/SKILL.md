# 缺陷转用例（回归测试用例起草）

从缺陷（现象、修复说明）起草回归测试用例，Hub 在边界与运行期核对用例结构、命令与参数合法性、期望结果引文依据、以及与已索引用例的重复判定。

## 1. 任务目标与输入

- **开始运行**：要对照某个构建时，build 和 version 写在 start_run 顶层，与 pack、product、inputs 并列，不写进 parameters。
- **输入 defects**：一个或多个缺陷外部标识（例如 `plm:bug:<编号>`）。为每个缺陷起草回归测试用例；若缺陷无法起草用例（如底层代码重构、无外部可测命令行或行为变化），必须在条目中声明跳过（`handling: "skipped"`）并写明诚实理由。
- **输入 indexed_cases**：当前锁定构建的已索引用例清单。绑定 `knowledge:index:<product>:<build>?kind=case&key=commands&fields=commands,document,node,title,negative,case_structure`，不要写 `only`，也不要在槽位里声明 `read_keys`。Hub 从起草命令在目录中的 CommandIdentity 完整路径算出读取键，并在同一修订上把索引重绑为 `only=<命令路径>&fields=commands,document,node,title,negative,case_structure`。索引里没有同命令用例时，结论是范围内没有重复。
- **参数**：
  - `max_cases`：每个缺陷最多起草用例数（整数，1 到 20，默认 6）。
  - `priority`：默认用例优先级（整数，1 到 3，默认 2）。

## 2. 证据读取与期望来源

在 `start_run` 成功后，Hub 绑定输入缺陷及相关证据来源：
0. **开始运行前核实可选手册**：先用锁定构建确定版本线，读取确认手册可用后，inputs.manual 绑定 `{"external":"manual:cli:<运行版本线>"}`，必须与运行版本线一致。没有可用手册就不绑定，只能引用修复说明字段或 fix_notes 里的 comment；不要绑定一个不可读对象导致无说明地结束。收到 manual_missing 后自动核实，能补取时补绑重开运行。自动期望来源不再替你绑定手册。
## 知识视图标识

写法是 `knowledge:<视图>:<产品>:<构建>[?参数]`，四段用冒号，参数在问号后。产品按登记的大小写照抄。下面用合成产品 ORBIT、构建 Rel_ORBIT_7_1_0_30，不要写成 orbit，也不要换成别的分隔符。

- facets：`knowledge:facets:ORBIT:Rel_ORBIT_7_1_0_30?kind=case&by=commands`。必填 kind、by。
- index：`knowledge:index:ORBIT:Rel_ORBIT_7_1_0_30?kind=case&key=commands`。必填 kind、key。
- impact：`knowledge:impact:ORBIT:Rel_ORBIT_7_1_0_29..Rel_ORBIT_7_1_0_30?changed=definition&attached=case`。构建段写成 `<起始>..<目标>`；changed、attached、catalog 可以不写。
- links：`knowledge:links:ORBIT:Rel_ORBIT_7_1_0_30`。没有必填参数，prefix 默认 /。

三种写错：
（1）分隔符用了 @。错 `knowledge:facets@ORBIT@Rel_ORBIT_7_1_0_30?kind=case&by=commands`。对 `knowledge:facets:ORBIT:Rel_ORBIT_7_1_0_30?kind=case&by=commands`。
（2）缺构建。错 `knowledge:facets:ORBIT?kind=case&by=commands`。对 `knowledge:facets:ORBIT:Rel_ORBIT_7_1_0_30?kind=case&by=commands`。
（3）参数不全。错 `knowledge:index:ORBIT:Rel_ORBIT_7_1_0_30?key=commands`。对 `knowledge:index:ORBIT:Rel_ORBIT_7_1_0_30?kind=case&key=commands`。

本包的索引用这条：`knowledge:index:ORBIT:Rel_ORBIT_7_1_0_30?kind=case&key=commands&fields=commands,document,node,title,negative,case_structure`。

1. **缺陷记录**（被判对象与期望来源）：读取现象描述与修复说明。修复说明有两处，都来自缺陷 content，不要向用户索取原文，也不要猜字段名或动作码：content.fix_field 非空时引用 `json@1/p/fields/<fix_field>` 的字段原文（字段名由 PLM 资源 settings.bug_fix_field 配置）；或者引用 content.fix_notes 里某条 comment 的原文，路径是 `json@1/p/fix_notes/<该条在数组中的序号>/comment`（动作码由 settings.bug_fix_actions 声明，包已按动作码收好）。两处都没有时运行会拒绝并点名缺的设置，把该说明交给集成者，不要改问用户要修复文字。分析缺陷根因、修复逻辑、涉及的 CLI 命令与期望行为。
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
- `expected`：期望结果列表。每个期望结果必须自己带 `quote`，槽位路径为 `/cases/<用例序号>/expected/<期望结果序号>/quote`。不要把引文放在用例一级。不要写 `identity`、`after`、`digest`、`sha256`、`original`、`span` 或 `byte_span`：Hub 从 `reference` 解析出源摘要、parser@主版本、片段路径，再在原件字节里定位引文的 offset 和 length，得到 ExpectedQuoteIdentity 后核对。
  - `text`：期望结果文字，必须是自身引文的非空逐字片段，不得改写。
  - `quote`：`{ "text": "<修复说明或手册里的逐字原文>", "reference": "src:<64位摘要>/<解析器@主版本>/<片段路径>" }`。`reference` 用 `resolve_reference` 能解析的那种。修复说明写 `src:<缺陷摘要>/json@1/p/fields/<fix_field>` 或 `src:<缺陷摘要>/json@1/p/fix_notes/<序号>/comment`；手册写 `src:<手册摘要>/<解析器@主版本>/<片段路径>`。
- `id`：本条草稿稳定、唯一的结构标识。
- `resource`：作者声明的标签数组，原文必须与本包 `tables/resource-tags.json` 的 `text` 完全相等，且至少有一项声明为测试类型。例如功能用例可写 `["functional"]`，反向用例可写 `["negative"]`；大小写、全半角和同义写法不自动转换。`negative` 必须与所选声明的反向属性一致。旧字段 `tags` 只保留原文，不作为测试类型声明。

## 4. 边界校验与修复规则

Hub 对提交进行两层核对：
1. **边界解析**：
   - 引文必须一字不差地存在于引用片段中（`QUOTE_MISMATCH`）。
   - 引用必须在所绑定来源中成功解析（`REFERENCE_UNRESOLVED`）。
2. **要求项事实检查**：
   - `shape`（结构）：空标题、缺失步骤或期望结果、优先级越界、未声明的 resource 标签、同次提交重复用例；标签结构问题按提示档处理。
   - `commands`（命令与参数）：参数类型不符、参数越界或命令不存在；反向用例反驳与预期不一致（退回修复，最多 2 轮）。
   - `grounded`（依据）：只允许本条缺陷 src 原件的 json@1/p/fields/<fix_field>、json@1/p/fix_notes/<序号>/comment，或 manual 槽绑定手册的 src 片段。quote 只写 text 和 reference。Hub 自己推出完整期望引用身份并核对原始字节；引文在片段中不唯一或原件读不到时仍是未知。期望文字不是引文的逐字片段则退回修复，最多 2 轮。
   - `not_duplicate`（去重）：读取键由 Hub 从命令目录解析出的 CommandIdentity 完整路径计算，并自动重绑索引。不要在 data 里写 read_keys。索引在这些命令上没有用例时，结论是范围内没有重复。有同命令用例时，仍按 case-structure@2 比较；缺作者结构则未知，不把未知说成没有重复。

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
              "id": "draft-1",
              "resource": [
                "functional"
              ]
            }
          }
        ]
      }
    }
  ]
}
```

查重的读取键和期望引用身份都由 Hub 计算，不要在修复轮里补写。截断、跳过或每键上限仍是未知：按 missing_fact 和 next_action 在同一修订重读。可见重复照样驳回。不要用标题或文字前缀查重。索引里同命令用例缺作者 case_structure 时，请作者补结构后重产新根。发布状态只取原始 JSON status。

喂入层：这个包读到的用例、缺陷、构建、规格凡经 Hub 读的都由程序自动进喂入层（带锁定树苗和冻结序号），视图按"锁定树苗 + 冻结序号之前的喂入层"读；版本未声明和矛盾的对象单列计数，不进版本差。Circle 只经 knowledge-contribution 回注补程序填不了的语义（带逐字引文），运行中不问人；结构契约见该包 tables/knowledge-structure.json 或 get_nodes 根路径。
