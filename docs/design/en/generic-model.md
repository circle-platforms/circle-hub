---
nav_order: 7
---

# Generic model

The design authority is [contracts/model.json](https://github.com/circle-platforms/circle-hub/blob/main/contracts/model.json): version 10, 73 elements in 11 groups, the vocabulary axes counted live from the generated files, plus classification rules, display rules, format proposals and the decided pending items. This page is a summary. The definitions, fields and rules of the elements are the model's; read them with `tools/show-element.ts`:

```sh
node tools/show-element.ts B01 W06          # definition, fields and rules of elements
node tools/show-element.ts --list           # every element
node tools/show-element.ts --vocab partition
node tools/show-element.ts --pending        # pending items and their decisions
```

Where this page and the model differ, the model wins. How milestone 1 implements it is in the [Hub r4 architecture](../../hub-r4-architecture.md). This page translates the [Chinese original](../generic-model.md); where they differ, the Chinese text is authoritative.

## What the Hub does

The Hub is a standard MCP server (D06): a local Circle, a bot and other clients share the same tools. The model's loop, planning, slot filling and attribution proposals run in the client; the Hub runs only deterministic functions, calls no model, and generates no content. Knowledge work that needs judgment runs on the client (on the Circle kernel): candidates stay on the client, and once they become facts they enter through a separate contribution run, where the Hub verifies them with deterministic rules (the path exists, quotes are verbatim from the original, nothing beyond what was declared; implemented). It hands out task packs, locks the versions a run uses, validates what comes back at its boundary, resolves exact values to references and keeps everything as append-only records. Effects on shared targets are issued only by the Hub through the dispatch boundary.

## Three invariants

- **I01 Exact values and artifacts**: every exact value a model writes is resolved to a reference at the boundary; an unjudged output becomes a deliverable only after a verdict; an artifact that can be generated deterministically is never written by the model.
- **I02 Source of facts**: facts come only from versioned rules and integrity-checked observations of the target, re-run by the Hub at its boundary; a verdict is reached only where there is a source plus deterministic logic.
- **I03 No escalation of terminal state**: every item has an explicit terminal state on every layer, which never escalates as it is passed on; unknown is never rewritten as partial or shown as failure.

## Eleven groups

| Group | Elements | Content |
|---|---|---|
| Basic records | B01–B08 | claim, source artifact, reference, authorization record, action record, effect record, request, call log |
| Claim attributes | A01–A06 | provenance type, basis rank, source role, independence, coverage, bounds and control interval, unknown |
| Verdicts and terminal states | V01–V08 | verdict, judgment, layered terminal state, attribution, partitioned manifest, definition of done, repetition policy, hypothesis set |
| Work structure | W01–W10 | item and item projection, requirement item, workflow, decision shape and rulings ledger, intermediate representation and slots, run, submission, validation result, trigger, criterion change declaration |
| Pipeline nodes | P01–P11 | ten step nodes (goal setting, source binding, decision-shape selection, slot filling, deterministic generation, static verification, dynamic verification, partitioned delivery, counterexample feedback, consolidation) and the unified pipeline with its pre-effect and pre-delivery boundaries |
| Three invariants | I01–I03 | see above |
| Component model | C01–C08 | four homes, ownership classes, two forms and two kinds of executable plugin, table, rule, policy table, catalog, capability declaration |
| Teaching and verification | T01–T04 | task pack, publish record and publish check, boundary validation, reference resolution ("resolve, don't restrict") |
| Knowledge | K01–K05 | knowledge tree, knowledge entry, three writer layers, placement proposed by the bot (Jev) and verified by the Hub, pinned fetch and content-hash cache |
| Integration and protocol | D01–D07 | integration specification, target premises, effect class and write declaration, effect safety mechanisms, call contract and uniform response, MCP tool surface, executor resource |
| People and permissions | R01–R03 | permission role (user, administrator), visibility, bot |

The ten steps are node types, not a fixed order (P11).

## Kernel: seven names

The model folds its elements into seven kernel names. They are groupings, not new objects:

| Kernel name | Chinese | Elements folded in |
|---|---|---|
| reference | 引用 | B03 |
| asset | 资产 | B02, T01, W03, W04, W05, C04, C05, C06, C07, D01, D07, K01, K02 |
| task | 任务 | W06, W01, W02, W09 |
| operation | 操作 | B05, B06, B04 |
| request | 请求 | B07 |
| change set | 变更集 | T02 |
| result | 结果 | B01, W07, W08, V05, V08, W10 |

A run is one revision of a task, and lineage strings the runs that pursue the same goal into a task. "Change set" keeps a single meaning, the publish record, and withdrawal is its revoked state; the assignments, publish-right grants, resource configurations and shares an administrator makes are operations. B08, the call log, is a diagnostic record and stays out of the kernel; group A and V01–V04, V06 and V07 are fields and vocabularies of claims and results; groups P and I, C01–C03, C08, T03, T04, K03–K05, D02–D06 and group R are rules, components and boundaries. The four objects are the four homes of C01; for how the five elements are used see the [object standard](object-standard.md).

## Vocabulary

Every vocabulary axis is a closed set (list them all with `node tools/show-element.ts --vocab`), generated by `npm run gen:contracts` into `contracts/generated/vocabulary.ts` with a type, a zod enum and Chinese labels per axis. Code takes labels only through `labelOf(axis, code)`, writes no enumeration by hand and coins no term. The axes used most when reading a validation result (the generated file is authoritative, and the docs checks in `.github/checks` compare this table with it):

| Axis | Codes |
|---|---|
| `nature` | `fact`, `judgment`, `unknown` |
| `basis_rank` | `rule_over_observation` > `rule_over_claims` > `judgment` > `relay` |
| `provenance_type` | `observed`, `projected`, `declared`, `candidate`, `client_captured` |
| `static_terminal` | `pass`, `violation`, `judgment`, `unchecked`, `incomplete` |
| `dynamic_terminal` | `pass`, `fail`, `no_verdict`, `not_run`, `incomplete` |
| `requirement_status` | `satisfied`, `unsatisfied`, `pending` |
| `partition` | `delivered`, `rejected`, `quarantined`, `incomplete` |
| `acceptance` | `accepted`, `not_accepted` |

Every item lands in exactly one partition: the partitions are pairwise disjoint and their union is the item set; claims across items are listed separately and not counted in the partitions (V05). A requirement has a terminal state only on the layers it declares; other layers read "not applicable" (V03).

Error codes are registered and generated too, into `contracts/generated/protocol.ts`: the protocol codes `PROTOCOL_CODES` come from the model (for example `QUOTE_MISMATCH` and `SOURCE_UNAVAILABLE`), and the core interpreters' violation codes `CORE_VIOLATION_CODES` (`core.<interpreter>.<code>`) come from `contracts/codes.json`; a pack's own codes sit under the pack name, for example `case-review.<code>`. Something absent and something forbidden both return `SOURCE_UNAVAILABLE`, shown as “对你不可用” (not available to you). References take four forms: `src:` (a source artifact or fragment), `tree:` (a knowledge-tree node), `entry:` (a knowledge entry) and `rec:` (a Hub record).

## What milestone 1 uses

Which package implements which elements is in section 4 of the architecture brief. Milestone 1 uses six tools only: `list_task_packs`, `upload_file`, `start_run`, `get_nodes`, `resolve_reference`, `submit_result`. Kept in the contracts and still not implemented: hypothesis sets (V08) and browser executors (the browser part of D07). Effect writes and leases (B06, D04, the write declarations of D03), dispositions and requests (B07), dynamic layer checks (P07), device executors (the executor part of D07) and xlsx and zip parsing were implemented with the real-bed round (see the progress page); the standing obligations of W09 have their first instance in the knowledge sync the Hub runs (see section 6 of the architecture brief). The read part of D03 and the resource part of D07 are implemented by the connectors package. Under decision 25 candidates remain on the client and facts enter through separate contribution runs; there is no own-candidate-layer write entry.

## Decisions

The model currently has 20 pending items: 18 are decided and 2 are deferred until the first workflow that needs them (new tools and their names; the channel for taking over a managed session and the block-language editor). Local-tool delivery is appended as a separate decided item under decision 35, without shifting existing indexes. Read them with `node tools/show-element.ts --pending`. The four that affect milestone 1 and the other decisions are recorded in the [Hub r4 progress](../../hub-r4-progress.md#决定).

---

This document is one of circle-hub's design specifications, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/): quote or build on it with attribution to Circle Hub and qingshanfeihu and a link to the original. See the [design specifications index](README.md#license).
