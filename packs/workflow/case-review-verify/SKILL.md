# 测试脑图评审（独立复核）

你是复核方（review-verifier）：独立核对另一位评审者的初评，给出结论 PASS、PARTIAL 或 FAIL 和最终等级。立场是“打破初评”：先假定每条初评发现都可能错，只有你自己对照被复核脑图和产品资料核实过的才算证实。初评方不能签结论，你也不能沿用初评方的会话：使用不同会话，并显式声明不同的 model_id 和 model_family_id。fork 或新上下文本身不证明独立；同会话、同模型或同族不独立，缺声明保持未知，不从显示名推族。

## 1. 开始运行

`start_run` 用任务包 case-review-verify：

- `inputs.target`：可以不写。给了 `predecessor` 时，Hub 按初评运行冻结的评审对象绑定，回答和运行记录会写明绑定来历。不要问人要脑图编号。显式给出时必须与前驱冻结的是同一对象（同一个 `agile:mindmap:<文档编号>`，或初评绑定的同一份上传 `src:<摘要>`）；不一致会拒绝并说明该用哪一个。使用别人分享的初评时，这份脑图原件也必须已分享给你。源文件变了的话开始运行会被拒。
- `inputs.draft`：可以不写，给了 `predecessor` 时由 Hub 按前驱的已受理结果绑定；回答和运行记录会写明绑定来历。显式给值时仍用初评 `submit_result` 回执里验证结果的引用 `rec:<摘要>`（不带 # 指针），Hub 按显式值核对，不替换它。该结果所属初评运行必须是你当前可读的。
- `predecessor`：必填，写初评运行的编号；缺失时 Hub 直接拒绝开始，不允许先开出一个无法满足独立性的复核运行。你也可以使用别人按当前授权分享给你的初评运行，未分享或撤回分享仍按同形不可用拒绝。构建和参数（stories、bugs、id_ranges、用例规则 case_rule 等）默认继承初评运行的设定，识别参数以初评冻结的快照为准，不能另改；要单独对照某个构建时，build 和 version 写在 start_run 顶层，与 pack、product、inputs 并列，不写进 parameters。Hub 会重新绑定同样的期望来源（需求、缺陷、规格书；测试策略和相似功能的历史测试清单只是线索），你在自己的边界上引用它们。初评的整份预期条目和识别参数由 Hub 函数事实承接，旧初评没有快照时用当前版本重做初评。

条目就是初评的条目。每行摘要列出这个用例的初评发现（码/严重程度）；完整的初评发现在运行记录的条目字段 `draft_findings` 里，每条带 `reference`（`rec:` 引用）、码、严重程度、说明、位置和引文：用 `get_nodes` 读运行记录的 `#/items/<序号>/fields`（运行记录的引用见 start_run 回答里“完整的槽位模式”那一行），或用 `resolve_reference` 读每条发现的引用。初评等级在每个条目的 `draft_level` 里。

## 2. 复核步骤

1. **整份读完被复核脑图**（`get_nodes` 读 target），不要只看摘要和初评的引文。
2. **逐条核对初评发现**：位置是否存在？描述是否与内容相符？严重程度是否合理？产品语义有没有弄反？每条写一个处置（槽位 `verification`）：
   - `verified`：证实；`refuted`：推翻（位置不存在、描述不符、语义颠倒）；`partial`：部分正确（方向对，描述、位置或严重程度要修正）。
   - `data.finding` 写那条发现的 `reference`，一字不差；每条初评发现恰好一条处置。
   - `text` 写核实后的问题本身：哪个用例哪里有问题、为什么，不只写“初评属实”；终稿表按原文列出。处置也可写 `data.probe` 表明问题类别。
   - `rank` 写你认定的严重程度；`location` 写落在被复核脑图的节点；`quotes` 至少一段逐字引文（被复核脑图或期望来源的原文）。
   - 有初评发现的条目不要跳过：跳过的条目里的初评发现算没有核对，结论就不能是 PASS。
3. **只用这七个探针找初评遗漏的问题**，每个写成 `new_finding`，`data.probe` 写探针名，带严重程度、位置和引文：
   - `literal_issue` 字面问题：重复的行、空字段、错别字、字段格式不一致；
   - `coverage_gap` 覆盖缺口：缺陷或需求引入的功能或参数没有用例测到；
   - `differentiation_gap` 区分缺口：两个功能都只测正向，从没有相互对照着测；
   - `edge_case_gap` 边界用例缺口：空值、超长字符串、Unicode、大小写；
   - `negative_gap` 反向用例缺口：缺陷修复的错误路径没有反向用例；
   - `block_structure_mismatch` 分块结构不符：分组标题与其中用例描述的行为不一致；
   - `self_contradiction` 业务自相矛盾。
4. **不熟悉的命令一律对照产品资料**：需求和缺陷、规格书、CLI 手册、锁定构建的命令目录（`get_nodes` 读知识根）。历史测试清单和测试策略只是线索，不能作为产品行为的根据。说某个命令存在写 `commands: [{"command": "<命令>", "present": true}]`，说不存在写 `"present": false`：Hub 按锁定构建的目录核实，说反了会退回修复。
5. **质疑初评等级**：按等级定义逐条对照，判断初评等级偏松、偏紧还是合适。
6. **改进建议**（可选，跨条目主张，码 suggestion）：statement 按“补：<用例>；因为：<原因>；期望：<结果>”三段写全，每段有内容；rank 表示轻重。grounds 至少一条指向被复核脑图节点：针对已有用例写该用例，补新用例写应放入的测试子项。期望来源的引用不能代替目标落点；缺落点或缺三段会退回修复（两轮）。

没有问题、也没有初评发现的条目写空列表 `[]`。

## 3. 结论与等级（跨条目主张，只写一条）

`{"nature": "judgment", "statement": "结论理由：……；对初评等级的质疑：……", "grounds": ["<你核对过的引用>"], "code": "PASS", "rank": "P3"}`

- **PASS**：初评基本正确，没有补充重要问题。不能有被推翻的发现、需要修正的 partial、新发现，等级不能改；每条初评发现都有处置；并且至少要有一段你自己从被复核脑图里逐字引用的原文（位置和根据只是引用，照抄初评的引文也不算：引一段初评没有引过的原文，例如用例的期望结果）。
- **PARTIAL**：基本正确，但遗漏了问题、有初评发现被推翻或要修正（只是次要的），或等级偏松、偏紧：要有新发现、`refuted` 或 `partial` 的处置，或等级调整。需要修正即 PARTIAL，不能写 PASS。
- **FAIL**：有重大事实错误（误判、位置错误、产品语义颠倒）：要推翻至少一条初评定为严重或主要的发现（看初评给的严重程度，你给推翻定的严重程度不算）。

Hub 按这些规则核对结论和处置是否一致，不一致会退回修复（两轮）。等级定义：

- P0：覆盖全部功能细节，兼容性、反向、压力、边角用例和极端场景非常丰富
- P1：覆盖全部功能细节，兼容性、反向、压力用例丰富
- P2：覆盖全部功能细节，兼容性、反向、压力用例比较丰富
- P3：覆盖全部功能细节，有一些兼容性、反向、压力用例
- P4：覆盖全部功能细节，有一些反向和压力用例，兼容性不足
- P5：覆盖全部功能，有一些反向和压力用例，功能细节的深度不够
- P6：覆盖基本功能，有反向和压力类型，功能细节覆盖不完整
- P7：没有覆盖基本功能，没有反向和压力类型

严重程度与等级的对应：按最终仍成立（verified）、需要修正（partial）和新增（new_finding）的发现取最重严重程度，严重对应 P6-P7，主要对应 P3-P5，次要对应 P0-P2；被推翻（refuted）的发现不再决定等级。Hub 只核允许区间，不按数量自动定级。

## 4. 分块与报告

每次评审最后都开 case-review-report 终稿运行，不分块也开（verifications 只写一条）；分块时每块独立初评、复核，终稿绑定同一份 target。Hub 按各块取最差算结论和等级，并按原始用例排表。初评方原样贴表，再写简短总体意见，不再逐条转录发现或另写建议主张；见终稿包的 SKILL。回执若仍有未完成或缺输入，按其中的缺失事实和下一步先补齐、重交，不当作已完成的终稿。

## 5. 提交样例

照这个结构写，字段名一个都不要改，只换内容（完整样例见 examples/submit-result.json）：

```json
{
  "run": "run_01m5h9zm2nhzbz2hrfjfb6azta",
  "model": "omega-checker 2.0 (scripted, temperature 0)",
  "items": [
    {
      "item": "900103:imyvp5mr10r6",
      "handling": "handled",
      "slots": {
        "verification": [
          {
            "text": "反向用例只覆盖上界外的 61，未覆盖下界外的 0，边界覆盖不完整",
            "code": "verified",
            "rank": "minor",
            "location": "src:48728fe18b2e89689f4aa1b00063fc3a3ef0c41744a32de6b12a449e01374d5f/kityminder@1/n/imyvp5mr10r6",
            "quotes": [
              {
                "reference": "src:48728fe18b2e89689f4aa1b00063fc3a3ef0c41744a32de6b12a449e01374d5f/kityminder@1/n/imyvp5mr10r6",
                "text": "widget health interval pool1 61"
              }
            ],
            "data": {
              "finding": "rec:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef#/partitions/delivered/0/requirements/0/claims/0"
            }
          },
          {
            "text": "缺少探测间隔为 0 的反向用例",
            "code": "new_finding",
            "rank": "minor",
            "location": "src:48728fe18b2e89689f4aa1b00063fc3a3ef0c41744a32de6b12a449e01374d5f/kityminder@1/n/imyvp5mr10r6",
            "quotes": [
              {
                "reference": "src:48728fe18b2e89689f4aa1b00063fc3a3ef0c41744a32de6b12a449e01374d5f/kityminder@1/n/imyvp5mr10r6",
                "text": "widget health interval pool1 61"
              }
            ],
            "data": {
              "probe": "negative_gap"
            }
          }
        ]
      }
    }
  ],
  "cross_item": [
    {
      "nature": "judgment",
      "statement": "结论理由：初评基本正确，但遗漏了反向用例，补充了一条新发现；对初评等级的质疑：初评 P2 合适",
      "grounds": [
        "src:48728fe18b2e89689f4aa1b00063fc3a3ef0c41744a32de6b12a449e01374d5f/kityminder@1/n/imyvp5mr10r6"
      ],
      "code": "PARTIAL",
      "rank": "P2"
    },
    {
      "nature": "judgment",
      "statement": "补：探测间隔为 0 的反向用例；因为：只覆盖了上界外的 61；期望：提示参数超出范围 1-60",
      "grounds": ["src:48728fe18b2e89689f4aa1b00063fc3a3ef0c41744a32de6b12a449e01374d5f/kityminder@1/n/imyvp5mr10r6"],
      "code": "suggestion",
      "rank": "minor"
    }
  ]
}
```

喂入层：这个包读到的用例、缺陷、构建、规格凡经 Hub 读的都由程序自动进喂入层（带锁定树苗和冻结序号），视图按"锁定树苗 + 冻结序号之前的喂入层"读；版本未声明和矛盾的对象单列计数，不进版本差。Circle 只经 knowledge-contribution 回注补程序填不了的语义（带逐字引文），运行中不问人；结构契约见该包 tables/knowledge-structure.json 或 get_nodes 根路径。
