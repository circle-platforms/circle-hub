# Data contract, version 0.1

All files are UTF-8 JSON in the batch folder. The scripts refuse anything else.

## manifest.json (written by prep.mjs)

`schema` `apv.mindmap-compile.manifest`, `source`, `source_sha256`, `source_size`, `case_count`, `groups`, `families`, and `cases[]`:

| Field | Meaning |
|---|---|
| `autoid` | 18 digits, the primary key |
| `title` | the case node's text |
| `group_path` | the texts of the nodes above it, root first |
| `source_layout` | `title_steps_expectations` (each child a step, its children the expectation) or `case_body_with_leaf_expectation` (numbered actions in the case text, one leaf with `[label]` expectations) |
| `step_intents[]` | `{desc, expected}` per step, as written |
| `unbound_expectations[]` | labelled expectations no action refers to |
| `priority`, `resource`, `family` | copied or derived; the workbook writes `P1` whatever the priority |

## machine_mindmap.json (you)

```json
{
  "schema": "apv.mindmap-compile.machine",
  "source_sha256": "<manifest.source_sha256>",
  "build": "<the bound build>",
  "cases": [
    {
      "autoid": "<18 digits>",
      "bucket": "exp_recipe | step_recipe | true_gap",
      "contract": { "intent": "...", "verification_method": "...", "expectation": "..." },
      "origin": { "intent": "title", "verification_method": "step:1", "expectation": "expectation:check1" },
      "expectations": [ { "n": 1, "text": "...", "origin": "step:1 | expectation:<label or n> | spec:<file>:<line> | defect:zentao:BUG-<n>:title" } ],
      "proposal": ["what is missing, in plain sentences"]
    }
  ]
}
```

`true_gap` cases carry only `autoid`, `bucket` and `proposal`.

## cases/<autoid>.json (you)

Exactly these keys:

```json
{
  "schema": "apv.mechanical-case",
  "autoid": "<18 digits>",
  "description": { "intent_verbatim": "<contract.intent>", "group_path": ["<manifest group_path>"] },
  "build": "<the bound build>",
  "init_commands": [],
  "blocks": [
    { "kind": "CONFIG", "host": "APV_0", "cmds": ["<command>"], "desc": "配置……" },
    { "kind": "OBSERVE_ASSERT", "host": "APV_0", "cmd": "<show command>", "desc": "查看……",
      "asserts": [ { "op": "found", "pattern": "<regex>", "expectation_id": "u1:<autoid>:1:0", "desc": "应显示……" } ] },
    { "kind": "SLEEP", "seconds": 5 },
    { "kind": "STEP", "desc": "……", "E": "APV_0", "F": "cmd_config", "G": "<data>" }
  ],
  "expectation_binding": [
    { "expectation_id": "u1:<autoid>:1:0", "claim_kind": "Author", "block_index": 1, "assert_index": 0 }
  ],
  "escape_hatches": [ { "block_index": 3, "reason": "why the blocks cannot express this row" } ],
  "command_receipts": [
    { "command": "<command>", "build": "<the bound build>", "status": "hit", "head": "<matched head>", "violations": [], "evidenceId": "evd_…" }
  ]
}
```

- `host` is `APV_0` or `APV_1`. `op` is `found` (regex), `not_found` (regex) or `abs_found` (literal).
- Expectation ids: `u1:<autoid>:<n>:<index>`, `index` counting the case's expectations of step `n` from 0, in the order of `machine_mindmap.json`.
- `SLEEP` is 1 to 300 seconds; `CONFIG.timeout_s`, when given, 1 to 600.

## Statuses (compile_report.json)

| Status | Meaning |
|---|---|
| `emitted_unverified` | written to the workbook and passed every mechanical check; not run on a device |
| `rejected` | a check failed; the violations say which |
| `unsupported_feature` | the bound build's command tree has no such command |
| `needs_decision` | the source lacks steps or expectations (`true_gap`) |
| `not_recomposed`, `not_written` | the batch stopped before this case was done |

## The workbook

One sheet, `执行`. Row 1 is a hidden contract marker, then notes, then the header `自动化ID 优先级 语句类型 描述 测试对象 方法 数据 临时保存期望结果 输入变量`. The first data row has `语句类型` 0 and the author. Each case follows with one row per step, `语句类型` counting up from 2, the autoid and `P1` on its first row, and one blank row after it. The last case is the sentinel `999999999999999` (`P9`, one `time sleep 1` row), which the runner never executes.
